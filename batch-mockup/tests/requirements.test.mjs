import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { hash, atomicFile, saveJSON } from '../adapters/a-files.mjs';
import { startRequirements } from '../experiments/workbench/requirements-server.mjs';
import { readRequirementState, validateRequirementDraft } from '../application/requirements.mjs';

const text='【左胸图稿】\n\n主体：使用图1，保留白色。\n\n文字：教  练 A+B！\n第二行\n\n字体：沿用图1。\n\n颜色：白色。\n\n排版：保持原排版。\n\n尺寸：未指定。\n\n输出：独立图稿。  \n';
const draft=()=>({artworks:[{id:'a1',name:'左胸图稿',route:'reuse',applications:[{style:'X-1',color:'黑色',position:'左胸'}],imageIds:['T-1'],prompt:text}],readingIssues:[]});
async function setup(t, handler) {
  const root=await mkdtemp(resolve(tmpdir(),'requirements-v2-')), bytes=await sharp({create:{width:10,height:10,channels:4,background:'#ffffff'}}).png().toBuffer();
  const image={imageId:'T-1',index:1,asset:'assets/T-1.png',originalSHA256:hash(bytes),originalBytes:bytes.length,width:10,height:10};
  const prompt='测试提示词\n', manifest={run:{id:'test',promptSHA256:hash(prompt),imageCount:1},cases:[{caseId:'T',sourceText:'原文：图一',sourceTextSHA256:hash('原文：图一'),images:[image],wpsStatus:'待领取'}]};
  await saveJSON(resolve(root,'manifest.json'),manifest); await atomicFile(resolve(root,'prompt.txt'),prompt);await atomicFile(resolve(root,'public',image.asset),bytes);
  let calls=0;const factory=async()=>async req=>{calls++;return handler?handler(req,calls):{rawContent:JSON.stringify(draft()),reportedModel:'fixture',httpStatus:200}};
  const server=await startRequirements(root,0,{analyzerFactory:factory}),base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await server.waitForRequirementAnalyses();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})});
  const post=(path,body,origin=base)=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const get=async()=> (await(await fetch(base+'/api/requirements')).json()).cases[0];
  const analyze=async(body={})=>{const c=await get(),r=await post('/api/requirements/analyze',{caseId:'T',requestId:randomUUID(),revision:c.revision,supplementRevision:c.supplement.revision,...body});await server.waitForRequirementAnalyses();return r};
  const save=async(d,extra={})=>{const c=await get();return post('/api/requirements/save',{caseId:'T',revision:c.revision,supplementRevision:c.supplement.revision,draft:d,...extra})};
  const confirm=async(extra={})=>{const c=await get();return post('/api/requirements/confirm',{caseId:'T',requestId:randomUUID(),revision:c.revision,supplementRevision:c.supplement.revision,confirmedBy:'测试核对人',...extra})};
  return {root,server,base,bytes,post,get,analyze,save,confirm,calls:()=>calls};
}
test('模型一次返回分图稿正文；原文与原图字节进真实格式请求，前端无生图评分入口',async t=>{
  let request;const f=await setup(t,async req=>{request=req;return {rawContent:JSON.stringify(draft()),httpStatus:200}});
  assert.equal((await f.analyze()).status,202);const c=await f.get();assert.equal(c.draft.artworks[0].prompt,text);assert.equal(c.confirmation,null);
  assert.equal(request.model,'gpt-5.6-sol');assert.equal(request.reasoning_effort,'low');
  const img=request.messages[1].content.find(x=>x.type==='image_url');assert.deepEqual(Buffer.from(img.image_url.url.split(',')[1],'base64'),f.bytes);
  assert.match(request.messages[1].content[0].text,/原文：图一/);
  const page=await(await fetch(f.base)).text();for(const label of ['需求理解','生图','上衣效果图'])assert.ok(page.includes(label));
  for(const path of ['/api/b-plan','/api/c-generate','/api/reviews','/api/reanalyze'])assert.equal((await f.post(path,{})).status,404);
  assert.equal((await fetch(f.base+'/manifest.json')).status,404);
});
test('确认后的图稿逐字交接；修改不覆盖旧确认，拒绝过期覆盖与外站写入',async t=>{
  const f=await setup(t);await f.analyze();const d=draft();d.artworks[0].prompt+='设计师：保留  空格\n';
  assert.equal((await f.save(d)).status,200);const c=await f.get();const confirmation=await(await f.confirm()).json();
  const input=await(await fetch(f.base+`/api/artwork-input?caseId=T&confirmationId=${confirmation.id}&artworkId=a1`)).json();
  assert.equal(input.prompt,d.artworks[0].prompt);assert.equal(input.promptSHA256,hash(d.artworks[0].prompt));assert.equal(input.executionEnabled,false);
  d.artworks[0].prompt+='新草稿';await f.save(d);assert.equal((await f.get()).confirmation,null);
  const old=await(await fetch(f.base+`/api/artwork-input?caseId=T&confirmationId=${confirmation.id}&artworkId=a1`)).json();assert.equal(old.prompt,input.prompt);
  assert.equal((await f.save(d,{revision:c.revision})).status,409);
  assert.equal((await f.post('/api/requirements/save',{},'https://bad.example')).status,403);
  assert.equal((await readRequirementState(f.root,'T')).analyses[0].parsed.artworks[0].prompt,text);
});
test('正文中的图号必须实际关联，不能漏字体参考；不修改文字修复绑定',()=>{
  const d=draft();d.artworks[0].prompt=d.artworks[0].prompt.replace('字体：沿用图1。','字体：参考图2');
  assert.throws(()=>validateRequirementDraft(d,[{id:'T-1',index:1},{id:'T-2',index:2}]),/图2/);
  d.artworks[0].imageIds.push('T-2');assert.equal(validateRequirementDraft(d,[{id:'T-1',index:1},{id:'T-2',index:2}]).artworks[0].prompt,d.artworks[0].prompt);
});
test('补图后不能沿用旧确认；重识别保留设计师修改，候选经显式保存才替换',async t=>{
  const f=await setup(t,async req=>{const d=draft();if(req.messages[1].content.filter(x=>x.type==='image_url').length===2){const input=JSON.parse(req.messages[1].content[0].text);assert.ok(input.设计师已保存修改);d.artworks[0].prompt+='\n补图后的候选';}return{rawContent:JSON.stringify(d)}});
  await f.analyze();const d=draft();d.artworks[0].prompt+='人工修正';await f.save(d);await f.confirm();
  const r=await f.post('/api/supplements',{caseId:'T',revision:0,action:'upload',id:randomUUID(),name:'补图.png',target:'Logo',base64:f.bytes.toString('base64')});assert.equal(r.status,200);
  assert.equal((await f.get()).confirmation,null);assert.equal((await f.confirm()).status,409);
  await f.analyze();const c=await f.get();assert.equal(c.draft.artworks[0].prompt,d.artworks[0].prompt);assert.ok(c.analysis.proposedDraft);
  assert.equal((await f.save(c.analysis.proposedDraft,{analysisId:c.analysis.id})).status,200);assert.equal((await f.confirm()).status,200);
});
test('格式错误保存原始返回，不生成候选或假确认，不自动重试',async t=>{
  const f=await setup(t,async()=>({rawContent:'{"broken":true}',httpStatus:200}));await f.analyze();const c=await f.get();assert.equal(c.analysis.status,'invalid_output');assert.equal(c.draft,null);assert.equal(f.calls(),1);assert.equal((await f.confirm()).status,409);
  const evidence=JSON.parse(await readFile(resolve(f.root,'analysis-evidence/T',c.analysis.id+'-response.json'),'utf8'));assert.equal(evidence.rawContent,'{"broken":true}');
});
test('同一请求幂等；结果未知阻止重复付费',async t=>{
  const f=await setup(t,async()=>{throw new Error('timeout')});const id=randomUUID();await f.analyze({requestId:id});assert.equal((await f.get()).analysis.status,'unknown');await f.analyze({requestId:id});assert.equal(f.calls(),1);assert.equal((await f.analyze()).status,409);
});
test('正在识别时保存的人工稿不被新结果覆盖，也不能确认运行中的草稿',async t=>{
  let release;const f=await setup(t,async(req,n)=>n===1?{rawContent:JSON.stringify(draft())}:new Promise(r=>{release=r}));await f.analyze();const c=await f.get();
  await f.post('/api/requirements/analyze',{caseId:'T',requestId:randomUUID(),revision:c.revision,supplementRevision:0});
  assert.equal((await f.confirm()).status,409);const d=draft();d.artworks[0].prompt+='并发编辑';await f.save(d);
  release({rawContent:JSON.stringify(draft())});await f.server.waitForRequirementAnalyses();const final=await f.get();assert.equal(final.draft.artworks[0].prompt,d.artworks[0].prompt);assert.equal(final.analysis.proposedDraft,null);
});

test('简单图也必须有固定七项，遗漏或重复的栏位不能悄悄补写',()=>{
 const d=draft();d.artworks[0].prompt=d.artworks[0].prompt.replace('颜色：白色。\n\n','');assert.throws(()=>validateRequirementDraft(d,[{id:'T-1',index:1}]),/七项/);
 const empty=draft();empty.artworks[0].prompt=empty.artworks[0].prompt.replace('颜色：白色。','颜色：');assert.throws(()=>validateRequirementDraft(empty,[{id:'T-1',index:1}]),/颜色为空/);
});

test('参考图比例单独记录在应用关系里：可为空，必须指向本单图片，不进入制作正文',()=>{
 const images=[{id:'img-1',index:1},{id:'img-2',index:2}];
 const draft=ref=>({artworks:[{id:'a1',name:'左胸',route:'generate',imageIds:['img-1'],prompt:text,applications:[{style:'S',color:'黑',position:'左胸',...(ref===undefined?{}:{sizeReference:ref})}]}],readingIssues:[]});
 const saved=validateRequirementDraft(draft({imageId:'img-2',logoToBody:.22,note:'图2实拍左胸Logo约占衣身宽22%'}),images);
 assert.deepEqual(saved.artworks[0].applications[0].sizeReference,{imageId:'img-2',logoToBody:.22,note:'图2实拍左胸Logo约占衣身宽22%'});
 assert.equal(saved.artworks[0].prompt,text);
 assert.equal(validateRequirementDraft(draft(null),images).artworks[0].applications[0].sizeReference,null);
 assert.throws(()=>validateRequirementDraft(draft({imageId:'img-9',logoToBody:.22,note:''}),images),/参考图比例关联了不存在的图片/);
 assert.throws(()=>validateRequirementDraft(draft({imageId:'img-2',logoToBody:1.5,note:''}),images),/格式无效/);
});
