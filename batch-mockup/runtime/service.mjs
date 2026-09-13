import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { jsonFile,readBytes,saveJSON,fail,checkpoint } from '../adapters/a-files.mjs';
import { requirementWorkbench,readRequirementState,saveRequirementDraft,reserveRequirementAnalysis,finishRequirementAnalysis } from '../application/requirements.mjs';
import { readProductionJobs,reserveProduction,executeProduction } from '../application/production.mjs';
import { readRepairInput,saveProductionRepair } from '../application/production-repair.mjs';
import { saveSupplement } from '../application/supplements.mjs';
import { readMockupState,saveMockupSelection,renderMockups } from '../application/mockups.mjs';
import { configuredAnalyzer } from '../adapters/a-analysis.mjs';
import { configuredProduction } from '../adapters/production-images.mjs';

export async function workbenchData(root){
 const manifest=await jsonFile(resolve(root,'manifest.json'),{run:{},cases:[]});
 const data=await requirementWorkbench(root,manifest),jobs=await readProductionJobs(root);
 for(const c of data.cases){c.productions=jobs.filter(j=>j.caseId===c.caseId);c.mockups=await readMockupState(root,c.caseId);}
 return {...data,generationEnabled:true};
}
export async function service(root,path,method,body={},options={}){
 const queue=options.enqueue||(()=>{throw fail('后台任务未连接',503);});
 if(method==='GET'){
  if(path==='/api/requirements')return workbenchData(root);
  if(path==='/api/garments')return {styles:await (await import('../adapters/garments.mjs')).garmentCatalog.styles()};
  if(path==='/api/production/repair')return readRepairInput(root,body.jobId);
  if(path==='/production-review.json')return jsonFile(resolve(root,'production-review.json'),{});
  if(path==='/api/prompt'){const manifest=await jsonFile(resolve(root,'manifest.json'));return {text:(await readBytes(resolve(root,'prompt.txt'))).toString('utf8'),sha256:manifest.run.promptSHA256};}
 }else if(method==='POST'){
  if(path==='/api/wps/sync'){const id=randomUUID();await queue({id,kind:'sync',payload:{}});return {id,status:'queued'};}
  const manifest=await jsonFile(resolve(root,'manifest.json'));
  if(path==='/api/wps/adopt'){const c=manifest.cases.find(c=>c.caseId===body.caseId);if(!c?.pendingSource)throw fail('没有待载入的原稿',409);const state=await readRequirementState(root,c.caseId);if(state.revision!==body.revision)throw fail('要求已更新，请刷新后再操作',409);await saveJSON(resolve(root,'requirements-history',c.caseId,`before-wps-${state.revision}.json`),{source:c,state});Object.assign(c,c.pendingSource);delete c.pendingSource;delete c.sourceChanged;state.draft=null;state.revision++;delete state.draftAnalysisId;state.draftOrigin=null;await saveJSON(resolve(root,'requirements-state',c.caseId+'.json'),state);await saveJSON(resolve(root,'manifest.json'),manifest);return {revision:state.revision};}
  if(path==='/api/requirements/save'){const state=await saveRequirementDraft(root,manifest,body);return {revision:state.revision};}
  if(path==='/api/supplements/chunk'){if(!/^[a-f0-9-]{36}$/.test(body.id)||!Number.isInteger(body.index)||body.index<0||body.index>20||typeof body.base64!=='string'||body.base64.length>1500000)throw fail('上传分片无效');await saveJSON(resolve(root,'upload-chunks',body.id,body.index+'.json'),{base64:body.base64});return {saved:true};}
  if(path==='/api/supplements'&&body.uploadId){if(body.uploadId!==body.id||!Number.isInteger(body.chunkCount)||body.chunkCount<1||body.chunkCount>21)throw fail('上传编号无效');const chunks=[];for(let n=0;n<body.chunkCount;n++)chunks.push((await jsonFile(resolve(root,'upload-chunks',body.id,n+'.json'))).base64);body.base64=chunks.join('');}
  if(path==='/api/supplements')return saveSupplement(root,body,new Set(manifest.cases.map(c=>c.caseId)));
  if(path==='/api/requirements/analyze'){
   const reserved=await reserveRequirementAnalysis(root,manifest,body);if(reserved.execute)await queue({id:reserved.analysis.id,kind:'analysis',payload:{caseId:body.caseId,analysisId:reserved.analysis.id}});
   return {id:reserved.analysis.id,status:reserved.analysis.status};
  }
  if(path==='/api/production'){
   const jobs=await reserveProduction(root,manifest,body.requests);for(const job of jobs)if(job.status==='queued')await queue({id:job.id,kind:'production',payload:{jobId:job.id,caseId:job.caseId}});return {jobs};
  }
  if(path==='/api/production/repair'){
   const saved=await saveProductionRepair(root,body),jobs=await readProductionJobs(root),job=jobs.find(j=>j.id===body.jobId);
   await queue({id:randomUUID(),kind:'mockup',payload:{caseId:job.caseId}});return saved;
  }
  if(['/api/mockups','/api/mockups/prepare'].includes(path)){
   const c=(await requirementWorkbench(root,manifest)).cases.find(c=>c.caseId===body.caseId);if(!c)throw fail('未找到需求',404);
   const saved=path==='/api/mockups'?await saveMockupSelection(root,c,body):await readMockupState(root,c.caseId);
   await queue({id:randomUUID(),kind:'mockup',payload:{caseId:c.caseId}});return saved;
  }
 }
 throw fail('未找到此操作',404);
}
export async function executeTask(root,task,enqueue){
 if(task.kind==='sync'){const {syncWps}=await import('./wps.mjs');return syncWps(root);}
 const manifest=await jsonFile(resolve(root,'manifest.json'));
 if(task.kind==='analysis'){
  const {caseId,analysisId}=task.payload,state=await readRequirementState(root,caseId),a=state.analyses.find(x=>x.id===analysisId);if(a?.status!=='running')return;
  const request=await jsonFile(resolve(root,'analysis-evidence',caseId,analysisId+'-request.json'));
  let result,error;try{result=await (await configuredAnalyzer())(request);}catch(e){error=e;}
  await finishRequirementAnalysis(root,manifest,caseId,analysisId,result,error);return;
 }
 if(task.kind==='production'){await executeProduction(root,task.payload.jobId,await configuredProduction());await checkpoint();await enqueue({id:randomUUID(),kind:'mockup',payload:{caseId:task.payload.caseId}});return;}
 const c=(await requirementWorkbench(root,manifest)).cases.find(c=>c.caseId===task.payload.caseId);
 if(c)await renderMockups(root,c,(await readProductionJobs(root)).filter(j=>j.caseId===c.caseId),(await import('../adapters/garments.mjs')).garmentCatalog);
}
export async function markInterrupted(root,task){
 if(task.kind==='analysis')await finishRequirementAnalysis(root,await jsonFile(resolve(root,'manifest.json')),task.payload.caseId,task.payload.analysisId,null,new Error('后台中断，未自动重试'));
 if(task.kind==='production'){const path=resolve(root,'production-jobs',task.payload.jobId,'state.json'),s=await jsonFile(path,null);if(s?.status==='running'){s.status='unknown';s.error='后台中断，原请求结果未知；没有自动重复付费';await saveJSON(path,s);}}
}
