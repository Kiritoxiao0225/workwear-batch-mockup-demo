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
 // A cut-out ring touching all four edges: most of the picture is clear, so it is not cut out again.
 const ring=Buffer.alloc(40*40*4);for(let y=0;y<40;y++)for(let x=0;x<40;x++){const d=Math.hypot(x-19.5,y-19.5);if(d>16&&d<=21)ring.set([255,255,255,255],(y*40+x)*4);}
 const c=await inspectPixels(await sharp(ring,{raw:{width:40,height:40,channels:4}}).png().toBuffer());assert.ok(c.clearEdgeRatio<.95);assert.equal(c.transparentExterior,true);
 const [j]=await reserveProduction(f.root,f.manifest,f.requests);const empty=await sharp({create:{width:16,height:16,channels:4,background:'#0000'}}).png().toBuffer();
 const r=await executeProduction(f.root,j.id,{generate:async()=>empty});assert.equal(r.status,'unknown');assert.match(r.error,/完全透明/);
});
test('复用读取明确内容图，位置参考不混进图稿；不调用生图或高清',async t=>{
 const f=await fixture(t,'reuse'),[j]=await reserveProduction(f.root,f.manifest,f.requests);let cuts=0;
 const r=await executeProduction(f.root,j.id,{generate:()=>{throw Error('不应生成');},enhance:()=>{throw Error('不应高清');},cutout:async()=>{cuts++;return f.transparent;}});
 assert.equal(r.status,'returned');assert.equal(cuts,1);assert.equal(r.raw.sha256,hash(f.opaque));
 assert.equal(sourceFor({images:[{id:'1',index:1},{id:'2',index:2}],imageIds:['1','2'],prompt}).id,'2');
 // Web69a498a416: "使用图1的完整主体标志" with 图2 linked only for the position.
 const named='【左胸图稿】\n\n主体：使用图1的完整主体标志，不包含右下角水印。\n\n文字：沿用图1。\n\n字体：沿用。\n\n颜色：沿用。\n\n排版：图2用于参考左胸位置。\n\n尺寸：未指定。\n\n输出：独立图稿。';
 assert.equal(sourceFor({images:[{id:'1',index:1},{id:'2',index:2}],imageIds:['1','2'],prompt:named}).id,'1');
 assert.throws(()=>sourceFor({images:[{id:'1',index:1},{id:'2',index:2}],imageIds:['1','2'],prompt:named.replace('使用图1的完整主体标志','组合图1与图2的标志')}),/未明确唯一内容原图/);
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
test('确认失败后仅续跑抠图，未知抠图不重复付费',async t=>{
 const f=await fixture(t),[j]=await reserveProduction(f.root,f.manifest,f.requests);let generated=0,cuts=0;
 const providers={generate:async()=>{generated++;return f.opaque;},cutout:async()=>{cuts++;throw Object.assign(Error('before submit'),{definiteFailure:true});}};
 const partial=await executeProduction(f.root,j.id,providers);assert.equal(partial.steps.at(-1).status,'failed');
 partial.status='queued';partial.resumeCutout=true;await saveJSON(resolve(f.root,'production-jobs',j.id,'state.json'),partial);
 const final=await executeProduction(f.root,j.id,{...providers,cutout:async()=>{cuts++;return f.transparent;}});assert.equal(final.status,'returned');assert.equal(generated,1);assert.equal(cuts,2);assert.equal(final.raw.sha256,hash(f.opaque));
 final.status='queued';final.steps.at(-1).status='unknown';await saveJSON(resolve(f.root,'production-jobs',j.id,'state.json'),final);
 const stopped=await executeProduction(f.root,j.id,providers);assert.equal(stopped.status,'partial');assert.equal(cuts,2);assert.equal(generated,1);
});

test('未勾选透明背景时保留场景像素，三个路线都不抠图，结果始终为 PNG',async t=>{
 for(const route of ['generate','enhance','reuse']){
  const f=await fixture(t,route);f.state.draft.artworks[0].transparentBackground=false;
  await saveJSON(resolve(f.root,'requirements-state/T.json'),f.state);
  const [j]=await reserveProduction(f.root,f.manifest,f.requests);
  const result=await executeProduction(f.root,j.id,{
   generate:async input=>{assert.equal(input.transparentBackground,false);return sharp(f.opaque).jpeg().toBuffer();},
   enhance:async()=>sharp(f.opaque).jpeg().toBuffer(),cutout:()=>assert.fail('未勾选不应调用抠图'),
  });
  assert.equal(result.status,'returned');assert.equal(result.transparentBackground,false);
  assert.equal(result.final.transparentPixels,0);assert.match(result.final.asset,/\.png$/);
  const raw=await sharp(await readFile(resolve(f.root,'public',result.raw.asset))).raw().toBuffer();
  const final=await sharp(await readFile(resolve(f.root,'public',result.final.asset))).raw().toBuffer();
  assert.deepEqual(final,raw,'转换 PNG 不改变返回图片的场景像素');
 }
});

test('勾选透明背景会按需抠图；选项固定在任务里并参与幂等身份',async t=>{
 const f=await fixture(t);f.state.draft.artworks[0].transparentBackground=true;
 await saveJSON(resolve(f.root,'requirements-state/T.json'),f.state);
 const [j]=await reserveProduction(f.root,f.manifest,f.requests);
 f.state.draft.artworks[0].transparentBackground=false;await saveJSON(resolve(f.root,'requirements-state/T.json'),f.state);
 const [other]=await reserveProduction(f.root,f.manifest,f.requests);assert.notEqual(j.id,other.id);
 let cuts=0;const result=await executeProduction(f.root,j.id,{
  generate:async input=>{assert.equal(input.transparentBackground,true);return f.opaque;},
  cutout:async()=>{cuts++;return f.transparent;},
 });
 assert.equal(cuts,1);assert.equal(result.status,'returned');assert.equal(result.final.transparentExterior,true);
});

test('明确要求透明背景但供应商返回不透明图片时，不能标记制作成功',async t=>{
 const f=await fixture(t);f.state.draft.artworks[0].transparentBackground=true;
 await saveJSON(resolve(f.root,'requirements-state/T.json'),f.state);
 const [j]=await reserveProduction(f.root,f.manifest,f.requests);let cuts=0;
 const result=await executeProduction(f.root,j.id,{generate:async()=>f.opaque,cutout:async()=>{cuts++;return f.opaque;}});
 assert.equal(result.status,'partial');assert.match(result.error,/透明背景检查未通过/);assert.equal(cuts,1);
});
