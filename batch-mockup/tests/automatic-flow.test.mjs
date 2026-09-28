import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import sharp from 'sharp';
import {saveJSON,atomicFile,hash,jsonFile} from '../adapters/a-files.mjs';
import {executeTask,queueNewRequirements,continueAfterAnalysis,service} from '../runtime/service.mjs';
import {readRequirementState} from '../application/requirements.mjs';
import {readProductionJobs} from '../application/production.mjs';
import {FRAME,readMockupState} from '../application/mockups.mjs';
const prompt='【左胸图稿】\n主体：制作文字。\n文字：测试。\n字体：黑体。\n颜色：红色。\n排版：横排。\n尺寸：未指定。\n输出：独立透明图稿。';
async function fixture(t){
 const root=await mkdtemp(resolve(tmpdir(),'automatic-flow-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const manifest={run:{promptSHA256:hash('prompt')},cases:['A','B'].map(caseId=>({caseId,sourceText:'制作测试文字',images:[],active:true}))};
 await saveJSON(resolve(root,'manifest.json'),manifest);await atomicFile(resolve(root,'prompt.txt'),'prompt');
 const draft={artworks:[{id:'logo',name:'左胸',route:'generate',applications:[{style:'S',color:'黑',position:'左胸'}],imageIds:[],prompt}],readingIssues:[]};
 let calls=0;const analyzerFactory=async()=>async()=>{calls++;return {rawContent:JSON.stringify(draft)};};
 const queue=new Map(),enqueue=t=>queue.set(t.id,t);
 return {root,manifest,draft,analyzerFactory,queue,enqueue,calls:()=>calls};
}
test('同步后逐条识别、自动制作和实际PNG上衣；重复同步和重复回调不重复付费',async t=>{
 const f=await fixture(t),syncWps=async()=>({newCases:['A','B']});
 await executeTask(f.root,{kind:'sync'},f.enqueue,{syncWps,analyzerFactory:f.analyzerFactory});
 assert.equal(f.queue.size,2);await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);assert.equal(f.queue.size,2);
 for(const task of [...f.queue.values()])await executeTask(f.root,task,f.enqueue,{analyzerFactory:f.analyzerFactory});
 assert.equal(f.calls(),2);assert.equal((await readProductionJobs(f.root)).length,2);
 const png=(w,h,c)=>sharp({create:{width:w,height:h,channels:4,background:c}}).png().toBuffer();
 const logo=await sharp(await png(40,40,'#0000')).composite([{input:await png(20,10,'red'),left:10,top:15}]).png().toBuffer();
 const garment=await sharp(Buffer.from('<svg width="200" height="200"><path fill="#ccc" d="M30 15H70L95 60L80 75L72 60V190H28V60L20 75L5 60ZM130 15H170L195 60L180 75L172 60V190H128V60L120 75L105 60Z"/></svg>')).png().toBuffer();
 const detail={id:'11111111-1111-4111-8111-111111111111',assetVersionId:'v1',styleCode:'S',colorName:'黑',sha256:hash(garment),width:200,height:200,views:[{face:'front',crop:{x:0,y:0,width:.5,height:1},history:[]},{face:'back',crop:{x:.5,y:0,width:.5,height:1},history:[]}]};
 const catalog={styles:async()=>[{styleCode:'S',colors:[{id:detail.id,colorName:'黑'}]}],detail:async()=>detail,bytes:async()=>garment,frame:()=>png(FRAME.width,FRAME.height,'white')};
 let generated=0;const deps={productionFactory:async()=>({generate:async input=>{assert.equal(input.prompt,prompt);generated++;return logo;},cutout:()=>assert.fail('透明图无需抠图')}),catalog};
 for(const task of [...f.queue.values()].filter(t=>t.kind==='production')){await executeTask(f.root,task,f.enqueue,deps);await executeTask(f.root,task,f.enqueue,deps);}
 for(const task of [...f.queue.values()].filter(t=>t.kind==='mockup'))await executeTask(f.root,task,f.enqueue,deps);
 assert.equal(generated,2);for(const id of ['A','B']){const state=await readMockupState(f.root,id);assert.equal(state.cards[0].status,'ready');assert.equal(state.cards[0].layers.length,1);assert.equal(state.cards[0].render.width,FRAME.width);}
 await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);assert.equal(f.calls(),2);
});
test('错误输出停止本条不阻塞其他条；同步不自动重试失败或未知识别',async t=>{
 const f=await fixture(t);await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);
 const tasks=[...f.queue.values()];await executeTask(f.root,tasks[0],f.enqueue,{analyzerFactory:async()=>async()=>({rawContent:'bad json'})});
 await executeTask(f.root,tasks[1],f.enqueue,{analyzerFactory:f.analyzerFactory});assert.equal((await readProductionJobs(f.root)).length,1);
 const before=f.queue.size;await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);assert.equal(f.queue.size,before);assert.equal((await readRequirementState(f.root,'A')).analyses.length,1);
});
test('人工修改、补图变更、原稿变更和状态移出均不自动生成',async t=>{
 for(const mutation of ['designer','supplement','source','inactive']){
 const f=await fixture(t);f.manifest.cases=f.manifest.cases.slice(0,1);await saveJSON(resolve(f.root,'manifest.json'),f.manifest);await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);
 const task=[...f.queue.values()][0];await executeTask(f.root,{...task,payload:{...task.payload,autoProduce:false}},f.enqueue,{analyzerFactory:f.analyzerFactory});
 if(mutation==='designer'){const s=await readRequirementState(f.root,'A');s.revision++;s.draftOrigin='designer';await saveJSON(resolve(f.root,'requirements-state/A.json'),s);}
 if(mutation==='supplement')await saveJSON(resolve(f.root,'supplements.json'),{A:{revision:1,items:[]}});
 if(mutation==='source')f.manifest.cases[0].sourceChanged=true;
 if(mutation==='inactive')f.manifest.cases[0].active=false;
 await saveJSON(resolve(f.root,'manifest.json'),f.manifest);await continueAfterAnalysis(f.root,'A',task.payload.analysisId,f.enqueue);assert.equal((await readProductionJobs(f.root)).length,0,mutation);
 }
});
test('缺Logo保留阻塞记录；单条预约失败不阻塞其他需求',async t=>{
 const f=await fixture(t);f.draft.readingIssues=[{scope:'左胸',issue:'未提供Logo素材'}];let n=0;
 const result=await queueNewRequirements(f.root,f.manifest,f.enqueue,async()=>{if(++n===1)throw Error('配置失败');return f.analyzerFactory();});assert.equal(result.errors.length,1);assert.equal(result.queued.length,1);
 await executeTask(f.root,[...f.queue.values()][0],f.enqueue,{analyzerFactory:f.analyzerFactory});assert.equal((await readProductionJobs(f.root))[0].status,'blocked');assert.equal([...f.queue.values()].filter(t=>t.kind==='production').length,0);
 assert.equal((await jsonFile(resolve(f.root,'auto-flow.json'))).errors[0].caseId,'A');
});
test('排队期间人工修改后自动任务停止，未调用付费制作',async t=>{
 const f=await fixture(t);await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);
 await executeTask(f.root,[...f.queue.values()][0],f.enqueue,{analyzerFactory:f.analyzerFactory});
 const state=await readRequirementState(f.root,'A');state.revision++;state.draftOrigin='designer';await saveJSON(resolve(f.root,'requirements-state/A.json'),state);
 const task=[...f.queue.values()].find(t=>t.kind==='production');await executeTask(f.root,task,f.enqueue,{productionFactory:()=>assert.fail('不应调用制作供应商')});
 assert.equal((await readProductionJobs(f.root))[0].status,'blocked');
});
test('旧页面已首次识别但未制作的条目可接续；已有制作结果不因同步再预约',async t=>{
 const f=await fixture(t);await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);
 for(const task of [...f.queue.values()])await executeTask(f.root,{...task,payload:{...task.payload,autoProduce:false}},f.enqueue,{analyzerFactory:f.analyzerFactory});
 assert.equal((await readProductionJobs(f.root)).length,0);await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);assert.equal((await readProductionJobs(f.root)).length,2);
 const ids=[...f.queue.keys()];await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);assert.deepEqual([...f.queue.keys()],ids);assert.equal(f.calls(),2);
});

test('WPS 自动队列不识别或制作手动录入的需求，独立图稿不自动合成衣服',async t=>{
 const f=await fixture(t);
 for(const [i,c] of f.manifest.cases.entries()){c.sourceRecordId='upload:'+c.caseId;c.entry=i?'batch':'studio';}
 await saveJSON(resolve(f.root,'manifest.json'),f.manifest);
 await queueNewRequirements(f.root,f.manifest,f.enqueue,()=>assert.fail('不应自动调用识图'));
 assert.equal(f.queue.size,0);
 const {reserveProduction}=await import('../application/production.mjs');
 await saveJSON(resolve(f.root,'requirements-state/A.json'),{revision:1,draft:{...f.draft,artworks:[{...f.draft.artworks[0],applications:[],transparentBackground:false}]},draftSupplementRevision:0,analyses:[],confirmations:[]});
 await queueNewRequirements(f.root,f.manifest,f.enqueue,()=>assert.fail('不应自动调用识图'));
 assert.equal((await readProductionJobs(f.root)).length,0);
 const [j]=await reserveProduction(f.root,f.manifest,[{caseId:'A',revision:1,supplementRevision:0}]);
 const png=await sharp({create:{width:16,height:16,channels:3,background:'red'}}).png().toBuffer();
 await executeTask(f.root,{kind:'production',payload:{caseId:'A',jobId:j.id}},f.enqueue,{productionFactory:async()=>({generate:async()=>png,cutout:()=>assert.fail('未勾选不抠图')})});
 assert.equal((await readProductionJobs(f.root))[0].status,'returned');assert.equal(f.queue.size,0);
});

test('图稿生成的「AI 整理」只填七项不自动制作；批量识别照常自动制作',async t=>{
 const f=await fixture(t);f.manifest.cases[0].entry='studio';await saveJSON(resolve(f.root,'manifest.json'),f.manifest);
 const env={WPS_ANALYSIS_PROVIDER:'cliproxy',WPS_ANALYSIS_MODEL:'gpt-5.6-sol',WPS_ANALYSIS_REASONING_EFFORT:'low',CLIPROXY_API_KEY:'test',CLIPROXY_API_BASE_URL:'https://proxy.invalid/v1'};
 const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 t.after(()=>{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 for(const caseId of ['A','B'])await service(f.root,'/api/requirements/analyze','POST',{caseId,revision:0,supplementRevision:0,requestId:crypto.randomUUID()},{enqueue:f.enqueue});
 const byCase=Object.fromEntries([...f.queue.values()].map(task=>[task.payload.caseId,task]));
 assert.equal(byCase.A.payload.autoProduce,false);assert.equal(byCase.B.payload.autoProduce,true);
 await executeTask(f.root,byCase.A,f.enqueue,{analyzerFactory:f.analyzerFactory});
 assert.equal((await readRequirementState(f.root,'A')).draft.artworks[0].prompt,prompt);
 assert.equal((await readProductionJobs(f.root)).length,0);assert.equal([...f.queue.values()].filter(task=>task.kind==='production').length,0);
 // Reading B again replaces its text but leaves the artworks to a person.
 await executeTask(f.root,byCase.B,f.enqueue,{analyzerFactory:f.analyzerFactory});const b=await readRequirementState(f.root,'B');assert.ok(b.draft);
 await service(f.root,'/api/requirements/analyze','POST',{caseId:'B',revision:b.revision,supplementRevision:0,requestId:crypto.randomUUID()},{enqueue:f.enqueue});
 assert.equal([...f.queue.values()].filter(task=>task.kind==='analysis'&&task.payload.caseId==='B').at(-1).payload.autoProduce,false);
});

test('刚识别完、会自行接续制作的需求，同时进行的同步不再预约第二份制作',async t=>{
 const f=await fixture(t);await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);
 // The reading returns and saves its draft, but its own production has not been committed yet.
 for(const task of [...f.queue.values()]){await executeTask(f.root,{...task,payload:{...task.payload,autoProduce:false}},f.enqueue,{analyzerFactory:f.analyzerFactory});
  const path=resolve(f.root,'requirements-state',task.payload.caseId+'.json'),state=await jsonFile(path);state.analyses.at(-1).autoProduce=true;await saveJSON(path,state);}
 await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);
 assert.equal((await readProductionJobs(f.root)).length,0);
});

test('备份恢复基线不自动重复识别或续做，恢复后的新需求仍可自动排队',async t=>{
 const f=await fixture(t);
 await saveJSON(resolve(f.root,'recovery-hold.json'),{blockedCaseIds:['A']});
 await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);
 assert.deepEqual([...f.queue.values()].map(x=>x.payload.caseId),['B']);
 assert.equal((await readRequirementState(f.root,'A')).analyses.length,0);
 // A recovered model draft must not silently resume production either.
 await saveJSON(resolve(f.root,'recovery-hold.json'),{blockedCaseIds:['A','B']});
 const task=[...f.queue.values()][0];
 await executeTask(f.root,{...task,payload:{...task.payload,autoProduce:false}},f.enqueue,{analyzerFactory:f.analyzerFactory});
 const state=await readRequirementState(f.root,'B');state.analyses.at(-1).finishedAt='2026-01-01T00:00:00Z';
 await saveJSON(resolve(f.root,'requirements-state/B.json'),state);
 const count=f.queue.size;await queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory);
 assert.equal(f.queue.size,count);assert.equal((await readProductionJobs(f.root)).length,0);
});

test('损坏的恢复隔离清单拒绝自动制作',async t=>{
 const f=await fixture(t);await saveJSON(resolve(f.root,'recovery-hold.json'),{blockedCaseIds:null});
 await assert.rejects(queueNewRequirements(f.root,f.manifest,f.enqueue,f.analyzerFactory),/恢复任务隔离清单无效/);
 assert.equal(f.queue.size,0);
});
