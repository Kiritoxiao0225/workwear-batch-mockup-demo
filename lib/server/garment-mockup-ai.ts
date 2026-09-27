import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { readAsset, storeAsset, digest, assertAssetOwned } from './garment-mockup-store';
import { assetId } from '../garment-editor/project-state';
import { currentPrices, holdCredits, settleHold, releaseHold, microToCents, type BillableAction } from './credits';
import type { Tenant } from './tenant-scope';
import { GARMENT_MODELS, callGarmentModel, assertGarmentProviderConfigured } from './garment-mockup-provider';

// Logo generation moved to the artwork studio; new jobs are background removal and back views.
// Older rows may still say understand/generate: they stay readable and settle as before.
const actionSchema=z.enum(['cutout','back']);
type Action=z.infer<typeof actionSchema>;
const billable=(action:string):BillableAction=>action==='understand'?'analyze':action==='cutout'?'cutout':'generate';
const inputSchema=z.object({instruction:z.string().trim().max(500).default(''),images:z.array(z.object({fileName:z.string().max(200),base64Image:z.string().max(200)})).max(2).default([]),base64Image:z.string().max(200).optional()});
type Input=z.infer<typeof inputSchema>;
export async function enqueueGarmentAi(tenant:Tenant,user:string,value:unknown) {
  const b=z.object({id:z.uuid(),projectId:z.uuid().nullable().optional(),action:actionSchema,input:inputSchema}).parse(value);
  if(!b.input.base64Image)throw new CatalogHttpError(400,'缺少原图');
  for(const url of [...b.input.images.map(i=>i.base64Image),b.input.base64Image].filter(Boolean)){
    const id=assetId(url!);if(!id)throw new CatalogHttpError(400,'AI 只能读取当前成衣效果图素材');
    await assertAssetOwned(tenant.id,id);
  }
  const hash=digest(b),prices=await currentPrices();
  const price=prices.prices.find(p=>p.action===billable(b.action));
  if(!price)throw new CatalogHttpError(503,'当前操作缺少计费配置');
  return catalogTransaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['garment-ai:'+b.id]);
    const previous=(await c.query('SELECT id,tenant_id,request_hash,status FROM garment_mockup_ai_jobs WHERE id=$1',[b.id])).rows[0];
    if(previous){if(previous.tenant_id!==tenant.id||previous.request_hash!==hash)throw new CatalogHttpError(409,'任务编号与请求不一致');return {id:b.id,status:previous.status};}
    if(!(await c.query("SELECT 1 FROM garment_mockup_workers WHERE heartbeat_at>now()-interval '45 seconds' LIMIT 1")).rowCount)throw new CatalogHttpError(503,'成衣制作后台未连接，未冻结积分或提交模型，请稍后再试');
    if(b.projectId && !(await c.query('SELECT 1 FROM garment_mockup_projects WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL',[b.projectId,tenant.id])).rowCount)throw new CatalogHttpError(404,'工程不存在');
    await holdCredits(c,{id:'garment:'+b.id,tenantId:tenant.id,kind:'production',jobRef:'garment:'+b.action+':'+b.id,billingMode:tenant.billingMode,amountCents:microToCents(price.userMicroCents),snapshot:prices});
    await c.query('INSERT INTO garment_mockup_ai_jobs(id,tenant_id,user_id,project_id,action,input_json,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[b.id,tenant.id,user,b.projectId??null,b.action,b.input,hash]);
    return {id:b.id,status:'queued'};
  });
}
export async function garmentAiStatus(tenant:string,id?:string){
  if(id)z.uuid().parse(id);
  const rows=(await catalogDatabase().query(`SELECT id,action,status,result_json,error,project_id,created_at FROM garment_mockup_ai_jobs
    WHERE tenant_id=$1 ${id?'AND id=$2':''} ORDER BY created_at DESC LIMIT 30`,id?[tenant,id]:[tenant])).rows;
  if(id&&!rows.length)throw new CatalogHttpError(404,'任务不存在');
  return id?rows[0]:rows;
}
async function imageData(tenant:string,url:string){
  const file=await readAsset(tenant,assetId(url)!);
  const bytes=file.bytes;
  return {bytes,dataUrl:`data:${file.file.mime_type};base64,${bytes.toString('base64')}`};
}
export async function executeGarmentAi(row:{id:string;tenant_id:string;action:string;input_json:Input}, provider=realGarmentProvider){
  if(!(row.action in GARMENT_MODELS)){
    // A queued logo job from before the move: never call the retired models; return the credits.
    await releaseHold('garment:'+row.id,row.tenant_id,'Logo 生成已移到图稿生成，未提交模型').catch(()=>{});
    await catalogDatabase().query("UPDATE garment_mockup_ai_jobs SET status='failed',error=$2,lease_until=NULL,updated_at=now() WHERE id=$1",[row.id,'Logo 生成已移到图稿生成，本任务未提交模型，冻结积分已退回']);
    return;
  }
  const job={...row,action:row.action as Action};
  const attemptId=randomUUID(),action=billable(job.action),started=Date.now();
  const {model,provider:providerName}=GARMENT_MODELS[job.action];
  let submitted=false;
  try{
    const hold=(await catalogDatabase().query("SELECT state FROM credit_holds WHERE id=$1 AND tenant_id=$2",['garment:'+job.id,job.tenant_id])).rows[0];
    if(hold?.state!=='held')throw new Error('缺少有效积分冻结');
    const submit=async()=>{
      await catalogDatabase().query('INSERT INTO garment_mockup_ai_attempts(id,job_id,provider,model,status) VALUES($1,$2,$3,$4,\'submitted\')',[attemptId,job.id,providerName,model]);
      submitted=true;
    };
    const receipt=async(id:string)=>{await catalogDatabase().query('UPDATE garment_mockup_ai_attempts SET provider_request_id=$2 WHERE id=$1',[attemptId,id]);};
    const result=await provider(job,submit,receipt);
    await catalogDatabase().query("UPDATE garment_mockup_ai_attempts SET status='succeeded',receipt=$2,finished_at=now() WHERE id=$1",[attemptId,{model,result,durationMs:Date.now()-started}]);
    await settleHold('garment:'+job.id,job.tenant_id,[{action,billable:true,certain:true,attemptId}]);
    await catalogDatabase().query("UPDATE garment_mockup_ai_jobs SET status='succeeded',result_json=$2,lease_until=NULL,updated_at=now() WHERE id=$1",[job.id,{...result,durationMs:Date.now()-started}]);
  }catch(error){
    const message=error instanceof Error?error.message:'制作失败';
    if(submitted){
      // An interrupted request may already have been charged. Never submit it again.
      await catalogDatabase().query("UPDATE garment_mockup_ai_attempts SET status=CASE WHEN status='succeeded' THEN status ELSE 'unknown' END,finished_at=now() WHERE id=$1",[attemptId]);
      const certain=(await catalogDatabase().query('SELECT status FROM garment_mockup_ai_attempts WHERE id=$1',[attemptId])).rows[0]?.status==='succeeded';
      await settleHold('garment:'+job.id,job.tenant_id,[{action,billable:true,certain,attemptId}]).catch(()=>{});
    }else await releaseHold('garment:'+job.id,job.tenant_id,'未提交供应商').catch(()=>{});
    await catalogDatabase().query('UPDATE garment_mockup_ai_jobs SET status=$2,error=$3,lease_until=NULL,updated_at=now() WHERE id=$1',[job.id,submitted?'unknown':'failed',message.slice(0,500)]);
  }
}
async function realGarmentProvider(job:{id:string;tenant_id:string;action:Action;input_json:Input},submit:()=>Promise<void>,receipt:(id:string)=>Promise<void>):Promise<Record<string,unknown>>{
  assertGarmentProviderConfigured(job.action);
  const b=job.input_json,images=await Promise.all(b.images.map(async i=>({...i,base64Image:(await imageData(job.tenant_id,i.base64Image)).dataUrl})));
  const base64Image=b.base64Image?(await imageData(job.tenant_id,b.base64Image)).dataUrl:undefined;
  const result=await callGarmentModel(job.action,{...b,images,base64Image},{beforeSubmit:submit,receipt});
  const asset=await storeAsset(job.tenant_id,result.bytes,job.action==='back'?'AI背面参考.png':'透明图.png',{jobId:job.id,model:result.model,aiReference:job.action==='back'});
  if('mask' in result)return {transparent:asset.url,mask:(await storeAsset(job.tenant_id,result.mask,'蒙版.png',{jobId:job.id})).url,original:(await storeAsset(job.tenant_id,result.original,'抠图原图.png',{jobId:job.id})).url,model:result.model};
  return {image:asset.url,model:result.model};
}
export async function startGarmentWorker({canAccept = () => true}: {canAccept?: () => boolean} = {}){
  let closed=false,running:Promise<void>|null=null;const owner=randomUUID();
  const heartbeat=()=>catalogDatabase().query('INSERT INTO garment_mockup_workers(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now()',[owner]);
  await heartbeat();
  const beatTimer=setInterval(()=>{void heartbeat().catch(()=>{});},15000);
  const tick=async()=>{
    if(closed||running||!canAccept())return;
    running=(async()=>{
      const expired=(await catalogDatabase().query("UPDATE garment_mockup_ai_jobs SET status='unknown',error='后台中断，未重复调用供应商',lease_until=NULL WHERE status='running' AND lease_until<now() RETURNING id,tenant_id,action")).rows;
      for(const j of expired){
        const attempts=(await catalogDatabase().query('SELECT id,status FROM garment_mockup_ai_attempts WHERE job_id=$1',[j.id])).rows;
        if(attempts.length)await settleHold('garment:'+j.id,j.tenant_id,attempts.map(a=>({action:billable(j.action),billable:true,certain:a.status==='succeeded',attemptId:a.id}))).catch(()=>{});
        else await releaseHold('garment:'+j.id,j.tenant_id,'后台在提交前中断').catch(()=>{});
      }
      const job=await catalogTransaction(async c=>{
        const j=(await c.query("SELECT j.* FROM garment_mockup_ai_jobs j JOIN tenants t ON t.id=j.tenant_id WHERE j.status='queued' AND NOT t.disabled ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1")).rows[0];
        if(j)await c.query("UPDATE garment_mockup_ai_jobs SET status='running',owner=$2,lease_until=now()+interval '2 minutes' WHERE id=$1",[j.id,owner]);return j;
      });
      if(job){const beat=setInterval(()=>{void catalogDatabase().query("UPDATE garment_mockup_ai_jobs SET lease_until=now()+interval '2 minutes' WHERE id=$1 AND owner=$2 AND status='running'",[job.id,owner]).catch(()=>{});},15000);
        try{await executeGarmentAi(job as Parameters<typeof executeGarmentAi>[0]);}finally{clearInterval(beat);}}
    })().catch(e=>console.error('[garment-worker]',e instanceof Error?e.name:'error')).finally(()=>{running=null;});
    await running;
  };
  const timer=setInterval(()=>void tick(),2000);void tick();
  return {close:async()=>{closed=true;clearInterval(timer);clearInterval(beatTimer);await running;await catalogDatabase().query("UPDATE garment_mockup_workers SET heartbeat_at=now()-interval '1 day' WHERE id=$1",[owner]);}};
}
