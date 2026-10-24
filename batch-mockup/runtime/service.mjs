import {readProductionEdit,saveProductionEdit,saveEditChunk} from '../application/production-edit.mjs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { jsonFile,readBytes,saveJSON,fail,checkpoint,hash } from '../adapters/a-files.mjs';
import { requirementWorkbench,readRequirementState,saveRequirementDraft,reserveRequirementAnalysis,finishRequirementAnalysis,acknowledgeReminder } from '../application/requirements.mjs';
import { readProductionJobs,reserveProduction,executeProduction,scheduleRetry } from '../application/production.mjs';
import { imageProviderFor } from '../adapters/production-images.mjs';
import { readRepairInput,saveProductionRepair } from '../application/production-repair.mjs';
import { saveSupplement } from '../application/supplements.mjs';
import { createCase, updateCase, removeCase, stageCaseImage, prepareStudio } from '../application/intake.mjs';
import { releaseCredits, settleCredits, attempt, assertCreditReservation } from '../../lib/server/billing-bridge.ts';
import { readMockupState,saveMockupSelection,renderMockups,markMockupsPending,keepMockupColors } from '../application/mockups.mjs';
import { currentPrices, ceilingMicroCents, microToCents } from '../../lib/server/credits.ts';
import { configuredAnalyzer, configuredPlanAnalyzer } from '../adapters/a-analysis.mjs';
import { configuredProduction } from '../adapters/production-images.mjs';

// Only untouched inputs enter automatically. Re-sync must not restart failed calls or designer edits.
export async function queueNewRequirements(root,manifest,enqueue,factory=configuredAnalyzer){
 const queued=[],errors=[],existingJobs=await readProductionJobs(root);
 // A restored snapshot cannot prove which later supplier calls already completed.
 // Hold that incident's baseline only; manual requests and genuinely new cases still work.
 const recovery=await jsonFile(resolve(root,'recovery-hold.json'),{blockedCaseIds:[]});
 if(!Array.isArray(recovery.blockedCaseIds))throw Error('恢复任务隔离清单无效，自动制作已停止');
 const held=new Set(recovery.blockedCaseIds);
 for(const c of (await requirementWorkbench(root,manifest)).cases){
  if(held.has(c.caseId))continue;
  if(c.sourceRecordId?.startsWith('upload:')||['studio','batch'].includes(c.entry))continue;
  if(c.active===false||c.sourceChanged||c.sourceReadError)continue;
  try{
   // A reading queued to produce reserves its own production; a sync running alongside it would
   // reserve the same artworks again before that task commits. Leave those to the task for a while.
   if(c.draft){const done=(await readRequirementState(root,c.caseId)).analyses.find(a=>a.id===c.draftAnalysisId);
    const ownsProduction=done?.autoProduce&&done.finishedAt&&Date.now()-Date.parse(done.finishedAt)<10*60e3;
    if(!existingJobs.some(j=>j.caseId===c.caseId)&&!ownsProduction)await continueAfterAnalysis(root,c.caseId,c.draftAnalysisId,enqueue);continue;}
   if(c.analysis)continue;
   const reserved=await reserveRequirementAnalysis(root,manifest,{caseId:c.caseId,revision:c.revision,supplementRevision:c.supplement.revision,requestId:randomUUID()},factory);
   if(reserved.execute){await enqueue({id:reserved.analysis.id,kind:'analysis',payload:{caseId:c.caseId,analysisId:reserved.analysis.id,autoProduce:true}});queued.push(c.caseId);}
  }catch(e){errors.push({caseId:c.caseId,error:e.message});}
 }
 await saveJSON(resolve(root,'auto-flow.json'),{checkedAt:new Date().toISOString(),queued,errors});
 return {queued,errors};
}
export async function continueAfterAnalysis(root,caseId,analysisId,enqueue){
 const manifest=await jsonFile(resolve(root,'manifest.json'));
 const c=(await requirementWorkbench(root,manifest)).cases.find(c=>c.caseId===caseId);
 // A late model response must not manufacture against newly edited text or changed sources.
 const state=await readRequirementState(root,caseId),analysis=state.analyses.find(a=>a.id===analysisId);
 if(!c||c.active===false||c.sourceChanged||c.sourceReadError||c.needsReanalysis||!c.draft||c.draftAnalysisId!==analysisId||state.draftOrigin!=='model'||state.revision!==analysis?.revision+1||analysis?.status!=='returned')return;
 const jobs=await reserveProduction(root,manifest,[{caseId,revision:c.revision,supplementRevision:c.supplement.revision}]);
 for(const job of jobs)if(job.status==='queued')await enqueue({id:job.id,kind:'production',payload:{jobId:job.id,caseId,automatic:true}});
}
// Supplier cost per requirement, from the receipts kept on each analysis and production step.
// Internal workspaces only: a tenant is shown what it is charged, never what the call cost us.
const cny=list=>Number(list.reduce((t,x)=>t+(x?.cny||0),0).toFixed(4));
const shanghaiDay=value=>value?new Date(Date.parse(value)+8*3600e3).toISOString().slice(0,10):'';
function caseCost(state,jobs){
 const analyses=state.analyses.filter(a=>a.cost).map(a=>({cny:a.cost.cny,credits:a.cost.credits,provider:a.cost.provider,model:a.cost.model||a.model,promptTokens:a.cost.promptTokens,completionTokens:a.cost.completionTokens,at:a.finishedAt}));
 const artworks={};let pending=false;
 for(const j of jobs){const steps=(j.steps||[]).filter(x=>x.cost).map(x=>({name:x.name,cny:x.cost.cny||0,credits:x.cost.credits,provider:x.cost.provider,method:x.cost.method,at:x.startedAt}));
  if((j.steps||[]).some(x=>x.cost?.method==='receipt_pending'))pending=true;
  if(!steps.length)continue;
  const art=artworks[j.artworkId]||={name:j.name,cny:0,runs:0,steps:[]};art.steps.push(...steps);art.runs++;art.cny=cny(art.steps);}
 const analysisCNY=cny(analyses),productionCNY=cny(Object.values(artworks));
 return analyses.length||Object.keys(artworks).length?{analysisCNY,analyses,artworks,productionCNY,totalCNY:Number((analysisCNY+productionCNY).toFixed(4)),pending}:null;
}
function costSummary(cases,day=shanghaiDay(new Date().toISOString())){
 let total=0;const touched=new Set();
 for(const c of cases){if(!c.cost)continue;
  for(const a of c.cost.analyses)if(shanghaiDay(a.at)===day){total+=a.cny;touched.add(c.caseId);}
  for(const art of Object.values(c.cost.artworks))for(const x of art.steps)if(shanghaiDay(x.at)===day){total+=x.cny;touched.add(c.caseId);}}
 return {day,todayCNY:Number(total.toFixed(4)),todayCases:touched.size};
}
const withoutCost=job=>({...job,steps:(job.steps||[]).map(step=>{const copy={...step};delete copy.cost;return copy;})});
export async function workbenchData(root,{wpsOnly=false,showCost=false}={}){
 const manifest=await jsonFile(resolve(root,'manifest.json'),{run:{},cases:[]});
 const index=wpsOnly?await jsonFile(resolve(root,'wps-case-index.json'),null):null;
 if(wpsOnly&&(!index?.source||!Array.isArray(index.caseIds)))throw fail('WPS 来源索引尚未同步，请稍后重试',503);
 const wpsCases=wpsOnly?manifest.cases.filter(c=>index.caseIds.includes(c.caseId)&&c.sourceRecordId?.startsWith(index.source+':')):null;
 const selected=wpsOnly?{...manifest,run:{...manifest.run,caseCount:wpsCases.length,imageCount:wpsCases.reduce((n,c)=>n+c.images.length,0)},cases:wpsCases}:manifest;
 const data=await requirementWorkbench(root,selected),jobs=await readProductionJobs(root);
 for(const c of data.cases){c.productions=jobs.filter(j=>j.caseId===c.caseId);c.mockups=await readMockupState(root,c.caseId);
  // Stale means this artwork's own text changed since it was made, not that another artwork was edited.
  for(const j of c.productions){const art=c.draft?.artworks.find(a=>a.id===j.artworkId);j.stale=!!art&&!!j.promptSHA256&&j.promptSHA256!==hash(art.prompt);}
  if(showCost)c.cost=caseCost(await readRequirementState(root,c.caseId),c.productions);else c.productions=c.productions.map(withoutCost);}
 return {...data,generationEnabled:true,automaticFlow:true,autoFlow:await jsonFile(resolve(root,'auto-flow.json'),null),...(showCost?{costSummary:costSummary(data.cases)}:{})};
}
export async function service(root,path,method,body={},options={}){
 const queue=options.enqueue||(()=>{throw fail('后台任务未连接',503);});
 if(method==='GET'){
  if(path==='/api/prices'){const prices=await currentPrices();return {analyze:microToCents(ceilingMicroCents(prices,{analyze:true})),...Object.fromEntries(['generate','enhance','reuse'].map(route=>[route,microToCents(ceilingMicroCents(prices,{route}))])),exempt:options.workspace==='main'};}
  if(path==='/api/mockups')return readMockupState(root,body.caseId);
  if(path==='/api/requirements')return workbenchData(root,{wpsOnly:options.wpsOnly,showCost:(options.workspace||'main')==='main'});
  // The garment editor's "my artworks" strip: the newest studio results only, not the whole workbench.
  if(path==='/api/studio/results'){
   const manifest=await jsonFile(resolve(root,'manifest.json'),{run:{},cases:[]}),jobs=await readProductionJobs(root);
   const studio=manifest.cases.filter(c=>c.entry==='studio'&&c.active!==false).slice(-24).reverse();
   // One 开始制作 can make several pictures: list every one of the latest round.
   return {items:studio.flatMap(c=>{const own=jobs.filter(j=>j.caseId===c.caseId),last=own.at(-1);if(!last)return [];
    return own.filter(j=>j.revision===last.revision).map(job=>{const file=job.repair?.file||job.final||job.raw;
    return {id:job.id,caseId:c.caseId,text:String(c.sourceText||'').slice(0,80),status:job.status,error:job.error||null,createdAt:job.createdAt,transparent:job.transparentBackground??null,
     asset:file?.asset||null,width:file?.width??null,height:file?.height??null};});})};
  }
  if(path==='/api/garments')return {styles:await (await (await import('../adapters/garments.mjs')).garmentCatalogForWorkspace(options.workspace||'main')).styles()};
  if(path==='/api/production/edit')return readProductionEdit(root,body.jobId);
  if(path==='/api/production/repair')return readRepairInput(root,body.jobId);
  if(path==='/production-review.json')return jsonFile(resolve(root,'production-review.json'),{});
  if(path==='/api/prompt'){const manifest=await jsonFile(resolve(root,'manifest.json'));return {text:(await readBytes(resolve(root,'prompt.txt'))).toString('utf8'),sha256:manifest.run.promptSHA256};}
 }else if(method==='POST'){
  if(path==='/api/wps/sync'){if(options.scheduleSync)return options.scheduleSync();const id=randomUUID();await queue({id,kind:'sync',payload:{}});return {id,status:'queued'};}
  if(path==='/api/cases/image')return stageCaseImage(root,body);
  if(path==='/api/cases')return createCase(root,body);
  if(path==='/api/studio/prepare')return prepareStudio(root,body);
  const manifest=await jsonFile(resolve(root,'manifest.json'));
  if(path==='/api/wps/adopt'){const c=manifest.cases.find(c=>c.caseId===body.caseId);if(!c?.pendingSource)throw fail('没有待载入的原稿',409);const state=await readRequirementState(root,c.caseId);if(state.revision!==body.revision)throw fail('要求已更新，请刷新后再操作',409);await saveJSON(resolve(root,'requirements-history',c.caseId,`before-wps-${state.revision}.json`),{source:c,state});Object.assign(c,c.pendingSource);delete c.pendingSource;delete c.sourceChanged;state.draft=null;state.revision++;delete state.draftAnalysisId;state.draftOrigin=null;await saveJSON(resolve(root,'requirements-state',c.caseId+'.json'),state);await saveJSON(resolve(root,'manifest.json'),manifest);return {revision:state.revision};}
  if(path==='/api/cases/update')return updateCase(root,body);
  if(path==='/api/cases/remove')return removeCase(root,body);
  if(path==='/api/reminders/ack')return acknowledgeReminder(root,manifest,body);
  if(path==='/api/requirements/save'){const state=await saveRequirementDraft(root,manifest,body);return {revision:state.revision};}
  if(path==='/api/supplements/chunk'){if(!/^[a-f0-9-]{36}$/.test(body.id)||!Number.isInteger(body.index)||body.index<0||body.index>20||typeof body.base64!=='string'||body.base64.length>1500000)throw fail('上传分片无效');await saveJSON(resolve(root,'upload-chunks',body.id,body.index+'.json'),{base64:body.base64});return {saved:true};}
  if(path==='/api/supplements'&&body.uploadId){if(body.uploadId!==body.id||!Number.isInteger(body.chunkCount)||body.chunkCount<1||body.chunkCount>21)throw fail('上传编号无效');const chunks=[];for(let n=0;n<body.chunkCount;n++)chunks.push((await jsonFile(resolve(root,'upload-chunks',body.id,n+'.json'))).base64);body.base64=chunks.join('');}
  if(path==='/api/supplements')return saveSupplement(root,body,new Set(manifest.cases.map(c=>c.caseId)));
  if(path==='/api/requirements/analyze'){
   const hadDraft=!!(await readRequirementState(root,body.caseId)).draft,reserved=await reserveRequirementAnalysis(root,manifest,body);
   if(reserved.execute){
    // The studio's "AI 整理" only fills in the seven fields; the author reviews them and starts production.
    const studio=manifest.cases.find(c=>c.caseId===body.caseId)?.entry==='studio';
    // A repeated reading replaces the text but leaves the artworks to a person: they may already be right.
    await queue({id:reserved.analysis.id,kind:'analysis',payload:{caseId:body.caseId,analysisId:reserved.analysis.id,autoProduce:!studio&&!hadDraft}});
   }
   return {id:reserved.analysis.id,status:reserved.analysis.status};
  }
  if(path==='/api/production'){
   const jobs=await reserveProduction(root,manifest,body.requests,{route:options.route});
   for(const job of jobs){
    if(job.status!=='queued')continue;
    await queue({id:job.id,kind:'production',payload:{jobId:job.id,caseId:job.caseId}});
   }
   return {jobs};
  }
  // 停止重试: the queue row is flagged and the worker ends the job when it next picks it up, so a
  // picture the relay is drawing right now still arrives.
  if(path==='/api/production/stop'){
   const job=(await readProductionJobs(root)).find(j=>j.id===body.jobId);
   if(!job)throw fail('未找到这张图稿',404);
   if(!['queued','running'].includes(job.status)||!job.retries)throw fail('这张图稿不在自动重试中',409);
   if(!options.stopProduction||!await options.stopProduction(job.id))throw fail('后台任务已结束，请刷新',409);
   return {stopping:true};
  }
  if(path==='/api/production/edit/chunk')return saveEditChunk(root,body);
  if(path==='/api/production/edit'){const saved=await saveProductionEdit(root,body),input=await readProductionEdit(root,body.jobId);await queue({id:randomUUID(),kind:'mockup',payload:{caseId:input.caseId}});return saved;}
  if(path==='/api/production/repair'){
   const saved=await saveProductionRepair(root,body),jobs=await readProductionJobs(root),job=jobs.find(j=>j.id===body.jobId);
   await queue({id:randomUUID(),kind:'mockup',payload:{caseId:job.caseId}});return saved;
  }
  if(path==='/api/mockups/keep-color'){if(!manifest.cases.some(c=>c.caseId===body.caseId))throw fail('未找到需求',404);const saved=await keepMockupColors(root,body.caseId,body.position,body.keep);await queue({id:randomUUID(),kind:'mockup',payload:{caseId:body.caseId}});return saved;}
  if(['/api/mockups','/api/mockups/prepare'].includes(path)){
   const source=manifest.cases.find(c=>c.caseId===body.caseId);if(!source)throw fail('未找到需求',404);const c={...source,...await readRequirementState(root,body.caseId),caseId:body.caseId};
   const saved=path==='/api/mockups'?await saveMockupSelection(root,c,body):await markMockupsPending(root,c.caseId);
   await queue({id:randomUUID(),kind:'mockup',payload:{caseId:c.caseId}});return saved;
  }
 }
 throw fail('未找到此操作',404);
}
/**
 * Settle from the per-call receipts, never from the job's summary status.
 * `partial` only means an image existed before the failure; the step that failed may have been
 * a confirmed 4xx or an unknown outcome, and those settle very differently.
 */
const BILLABLE_STEPS={generate:'generate',enhance:'enhance',cutout:'cutout'};
export function stepAttempts(job){
 const attempts=[];let upscale=null;
 for(const [index,step] of (job?.steps||[]).entries()){
  // 'failed' carries a definite 4xx receipt: the call was rejected and costs nothing.
  if(step.status==='failed')continue;
  const receipt={attemptId:step.attemptId||job.id+':'+index};
  // 「放大到 2K/4K」 is one 无损放大 per click, however many 2× passes the size needs. The generate
  // route's own upscale stays inside its 1K price during the trial.
  if(/^upscale-\d+$/.test(step.name)){
   if(job.route==='enhance'&&(!upscale||!upscale.certain&&step.status==='returned'))upscale=attempt('enhance',step.status==='returned',receipt);
   continue;
  }
  const action=BILLABLE_STEPS[step.name];
  if(!action)continue;
  attempts.push(attempt(action,step.status==='returned',receipt));
 }
 if(upscale)attempts.push(upscale);
 return attempts;
}
export async function executeTask(root,task,enqueue,dependencies={}){
 if(task.kind==='sync'){const sync=dependencies.syncWps||(await import('./wps.mjs')).syncWps;const result=await sync(root);const automatic=await queueNewRequirements(root,await jsonFile(resolve(root,'manifest.json')),enqueue,dependencies.analyzerFactory||configuredAnalyzer);return {...result,automatic};}
 const manifest=await jsonFile(resolve(root,'manifest.json'));
 if(task.kind==='analysis'){
  const {caseId,analysisId}=task.payload,state=await readRequirementState(root,caseId),a=state.analyses.find(x=>x.id===analysisId);if(a?.status!=='running')return;
  await assertCreditReservation(task.workspace||'main',analysisId);
  const request=await jsonFile(resolve(root,'analysis-evidence',caseId,analysisId+'-request.json'));
  a.attemptId ||= analysisId;
  // Recorded so a sync running alongside knows this task will reserve its own production.
  a.autoProduce=!!task.payload.autoProduce;
  await saveJSON(resolve(root,'requirements-state',caseId+'.json'),state);
  await checkpoint();
  // A picture count (图稿生成「AI 拆成多张」) goes to the model it was reserved for.
  const factory=a.mode==='plan'?dependencies.planAnalyzerFactory||configuredPlanAnalyzer:dependencies.analyzerFactory||configuredAnalyzer;
  let result,error;try{result=await (await factory())(request);}catch(e){error=e;}
  await finishRequirementAnalysis(root,manifest,caseId,analysisId,result,error);
  // A returned model call is charged even when its output failed validation: the call happened.
  const analysisState=await readRequirementState(root,caseId),done=analysisState.analyses.find(x=>x.id===analysisId);
  const billed=done?.status==='returned'||done?.status==='invalid_output';
  await checkpoint();
  await settleCredits(task.workspace||'main',analysisId,billed?[attempt('analyze',true,{attemptId:done.attemptId||analysisId})]:done?.status==='unknown'?[attempt('analyze',false,{attemptId:done.attemptId||analysisId})]:[]);
  // Persist the reading before reserving the next stage, so a rejected production hold
  // cannot take the paid-for analysis result down with it.
  await checkpoint();
  if(task.payload.autoProduce)await continueAfterAnalysis(root,caseId,analysisId,enqueue);return;
 }
 if(task.kind==='production'){
  const queuedJob=await jsonFile(resolve(root,'production-jobs',task.payload.jobId,'state.json'));
  if(task.payload.stop&&queuedJob.status==='queued'){
   queuedJob.status='failed';queuedJob.phase='stopped';delete queuedJob.retryAt;
   queuedJob.error=`已停止自动重试（试了 ${queuedJob.retries||0} 次没出图），没有扣费`;
   queuedJob.finishedAt=new Date().toISOString();
   await saveJSON(resolve(root,'production-jobs',task.payload.jobId,'state.json'),queuedJob);await checkpoint();
   await settleCredits(task.workspace||'main',task.payload.jobId,stepAttempts(queuedJob));return;
  }
  if(queuedJob.status==='queued')await assertCreditReservation(task.workspace||'main',task.payload.jobId);
  if(task.payload.automatic){
   const c=(await requirementWorkbench(root,manifest)).cases.find(c=>c.caseId===task.payload.caseId);
   const path=resolve(root,'production-jobs',task.payload.jobId,'state.json'),job=await jsonFile(path);
   if(job.status==='queued'&&(!c||c.active===false||c.sourceChanged||c.sourceReadError||c.needsReanalysis||c.revision!==job.revision||c.supplement.revision!==job.supplementRevision)){
    job.status='blocked';job.error='自动制作前需求、素材或任务状态已变化，请核对后手动生成';await saveJSON(path,job);
    // No provider was contacted, so the whole reservation goes back.
    await releaseCredits(task.workspace||'main',task.payload.jobId,'输入已变化，未调用供应商').catch(()=>{});
    return;
   }
  }
  await executeProduction(root,task.payload.jobId,await (dependencies.productionFactory||configuredProduction)());
  const finished=await jsonFile(resolve(root,'production-jobs',task.payload.jobId,'state.json'),null);
  // A relay miss waiting for its next try keeps its hold; the worker puts the queue row back.
  if(finished?.status==='queued'&&finished.retryAt)return {retryAt:finished.retryAt};
  await settleCredits(task.workspace||'main',task.payload.jobId,stepAttempts(finished));
  await checkpoint();
  if(manifest.cases.find(c=>c.caseId===task.payload.caseId)?.entry!=='studio')await enqueue({id:randomUUID(),kind:'mockup',payload:{caseId:task.payload.caseId}});
  return;
 }
 const c=(await requirementWorkbench(root,manifest)).cases.find(c=>c.caseId===task.payload.caseId);
 if(c)await renderMockups(root,c,(await readProductionJobs(root)).filter(j=>j.caseId===c.caseId),dependencies.catalog||await (await import('../adapters/garments.mjs')).garmentCatalogForWorkspace(task.workspace||'main'));
}
/**
 * Interrupted work has no definite receipt, so the hold moves to the adjudication queue
 * instead of being guessed either way. This mirrors the existing rule that an unknown result
 * is never retried and never silently charged twice.
 */
export async function markInterrupted(root,task){
 if(task.kind==='analysis'){const before=await readRequirementState(root,task.payload.caseId);const a=before.analyses.find(x=>x.id===task.payload.analysisId);if(a?.status==='running')await finishRequirementAnalysis(root,await jsonFile(resolve(root,'manifest.json')),task.payload.caseId,task.payload.analysisId,null,new Error('后台中断，未自动重试'));await checkpoint();await settleCredits(task.workspace||'main',task.payload.analysisId,a?[attempt('analyze',['returned','invalid_output'].includes(a.status),{attemptId:a.attemptId||a.id})]:[]);}
 if(task.kind==='production'){const path=resolve(root,'production-jobs',task.payload.jobId,'state.json'),s=await jsonFile(path,null);
  // Cut off while the relay was drawing (a release, a lease lost): nothing to pay for, so it is tried again.
  const generating=s?.steps?.at(-1);
  if(s?.status==='running'&&s.phase==='generate'&&!s.raw&&generating?.name==='generate'&&generating.status==='running'&&imageProviderFor(s.provider)==='cliproxy'){
   Object.assign(generating,{status:'failed',error:'后台中断，这次没出图'});
   scheduleRetry(s,'后台中断，这次没出图');await saveJSON(path,s);await checkpoint();return {retryAt:s.retryAt};
  }
  if(s?.status==='running'){s.status='unknown';s.error='后台中断，原请求结果未知；没有自动重复付费';await saveJSON(path,s);}await checkpoint();await settleCredits(task.workspace||'main',task.payload.jobId,stepAttempts(s));}
}
