import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { hash, saveJSON, atomicFile } from '../adapters/a-files.mjs';
import { reserveProduction, executeProduction, readProductionJobs, sourceFor } from '../application/production.mjs';
import { inspectPixels } from '../adapters/production-images.mjs';
const prompt='【左胸图稿】\n\n主体：使用图2完整Logo，图1仅作颜色参考。\n\n文字：保留  A\nB\n\n字体：沿用图2。\n\n颜色：参考图1。\n\n排版：原样。\n\n尺寸：未指定。\n\n输出：独立图稿。';
async function fixture(t,route='generate'){
 const root=await mkdtemp(resolve(tmpdir(),'production-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const opaque=await sharp({create:{width:32,height:32,channels:3,background:'#fff'}}).png().toBuffer();
 const transparent=await sharp({create:{width:32,height:32,channels:4,background:'#0000'}}).composite([{input:await sharp({create:{width:16,height:16,channels:4,background:'#fff'}}).png().toBuffer(),left:8,top:8}]).png().toBuffer();
 const images=[1,2].map(index=>({imageId:'T-'+index,index,asset:`assets/T-${index}.png`,originalSHA256:hash(opaque),originalBytes:opaque.length,width:32,height:32}));
 for(const i of images)await atomicFile(resolve(root,'public',i.asset),opaque);
 const draft={artworks:[{id:'a1',name:'左胸图稿',route,applications:[],imageIds:['T-1','T-2'],prompt}],readingIssues:[]};
 const manifest={run:{},cases:[{caseId:'T',sourceText:'客服原文',images}]};
 const state={revision:1,draft,draftSupplementRevision:0,analyses:[],confirmations:[]};await saveJSON(resolve(root,'requirements-state/T.json'),state);
 const requests=[{caseId:'T',revision:1,supplementRevision:0}];return {root,manifest,requests,opaque,transparent,state};
}
test('制作固定完整正文和原图号，不压缩转写；同版本提交不重复，后续编辑不污染在途输入',async t=>{
 const f=await fixture(t),[j]=await reserveProduction(f.root,f.manifest,f.requests);
 assert.equal((await reserveProduction(f.root,f.manifest,f.requests))[0].id,j.id);assert.equal((await readProductionJobs(f.root)).length,1);
 f.state.draft.artworks[0].prompt+='新编辑';f.state.revision++;await saveJSON(resolve(f.root,'requirements-state/T.json'),f.state);
 let calls=0;const result=await executeProduction(f.root,j.id,{generate:async input=>{calls++;assert.equal(input.prompt,prompt);assert.deepEqual(input.images.map(i=>i.index),[1,2]);for(const i of input.images)assert.equal(hash(await readFile(i.path)),hash(f.opaque));return f.transparent;},cutout:()=>{throw Error('透明图不应抠图');}});
 assert.equal(result.status,'returned');assert.equal(result.final.sha256,hash(f.transparent));await executeProduction(f.root,j.id,{generate:()=>calls++});assert.equal(calls,1);
 await assert.rejects(reserveProduction(f.root,f.manifest,f.requests),/已变化/);
});
test('不透明结果调用美图一次；抠图失败保留生成原图且不重新生图',async t=>{
 const f=await fixture(t),[j]=await reserveProduction(f.root,f.manifest,f.requests);let generated=0,cutouts=0;
 const p={generate:async()=>{generated++;return f.opaque;},cutout:async()=>{cutouts++;throw Error('timeout');}};
 const r=await executeProduction(f.root,j.id,p);assert.equal(r.status,'partial');assert.equal(r.raw.sha256,hash(f.opaque));assert.equal(r.final,undefined);
 await executeProduction(f.root,j.id,p);assert.equal(generated,1);assert.equal(cutouts,1);
});
test('PNG有alpha不等于透明；空白透明图不可交付，透明图内部白色保留',async t=>{
 const f=await fixture(t),a=await inspectPixels(await sharp(f.opaque).ensureAlpha().png().toBuffer());assert.equal(a.transparentExterior,false);
 const b=await inspectPixels(f.transparent);assert.equal(b.transparentExterior,true);assert.equal(b.visiblePixels,256);
 const [j]=await reserveProduction(f.root,f.manifest,f.requests);const empty=await sharp({create:{width:16,height:16,channels:4,background:'#0000'}}).png().toBuffer();
 const r=await executeProduction(f.root,j.id,{generate:async()=>empty});assert.equal(r.status,'unknown');assert.match(r.error,/完全透明/);
});
test('复用读取明确内容图，位置参考不混进图稿；不调用生图或高清',async t=>{
 const f=await fixture(t,'reuse'),[j]=await reserveProduction(f.root,f.manifest,f.requests);let cuts=0;
 const r=await executeProduction(f.root,j.id,{generate:()=>{throw Error('不应生成');},enhance:()=>{throw Error('不应高清');},cutout:async()=>{cuts++;return f.transparent;}});
 assert.equal(r.status,'returned');assert.equal(cuts,1);assert.equal(r.raw.sha256,hash(f.opaque));
 assert.equal(sourceFor({images:[{id:'1',index:1},{id:'2',index:2}],imageIds:['1','2'],prompt}).id,'2');
});
test('高清路线只有高清再按需抠图，不插入生图',async t=>{
 const f=await fixture(t,'enhance'),[j]=await reserveProduction(f.root,f.manifest,f.requests);let up=0;
 const r=await executeProduction(f.root,j.id,{enhance:async i=>{assert.equal(i.index,2);up++;return f.transparent;},generate:()=>{throw Error('不应生图');}});
 assert.equal(up,1);assert.equal(r.status,'returned');assert.deepEqual(r.steps.map(s=>s.name),['enhance']);
});
test('缺客户Logo不凭空生成；纯文字无图可以生成',async t=>{
 const f=await fixture(t);f.manifest.cases[0].images=[];f.state.draft.artworks[0].imageIds=[];f.state.draft.artworks[0].prompt=prompt.replaceAll('图1','原稿').replaceAll('图2','原稿');f.state.draft.readingIssues=[{scope:'左胸',issue:'未提供Logo图片，请补充素材'}];await saveJSON(resolve(f.root,'requirements-state/T.json'),f.state);
 const [j]=await reserveProduction(f.root,f.manifest,f.requests);assert.equal(j.status,'blocked');
 f.state.draft.readingIssues=[];f.state.revision++;await saveJSON(resolve(f.root,'requirements-state/T.json'),f.state);
 const [ok]=await reserveProduction(f.root,f.manifest,[{...f.requests[0],revision:2}]);assert.equal(ok.status,'queued');
});
