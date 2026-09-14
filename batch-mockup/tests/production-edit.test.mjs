import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {hash,saveJSON,atomicFile,readBytes} from '../adapters/a-files.mjs';
import {readProductionEdit,saveProductionEdit,saveEditChunk} from '../application/production-edit.mjs';
import {readProductionJobs} from '../application/production.mjs';
import {createLegacyArtworkDraft} from '../../lib/artwork-editor.ts';
import {addArtworkText} from '../../lib/artwork-layers.ts';
async function setup(t){
 const root=await mkdtemp(resolve(tmpdir(),'batch-editor-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const id=hash(randomUUID()),bytes=await sharp({create:{width:30,height:20,channels:4,background:'#17694c'}}).png().toBuffer(),asset=`production-results/${id}/original.png`,file={asset,sha256:hash(bytes),bytes:bytes.length,width:30,height:20};
 await atomicFile(resolve(root,'public',asset),bytes);await saveJSON(resolve(root,'production-jobs',id,'state.json'),{id,caseId:'C1',artworkId:'a2',name:'第二份图稿',status:'returned',raw:file,final:file,createdAt:new Date().toISOString(),steps:[]});
 await saveJSON(resolve(root,'production-jobs',id,'input.json'),{prompt:'制作文字'});
 let draft=createLegacyArtworkDraft('/api/batch/'+asset);draft=addArtworkText(draft,{x:512,y:850}).draft;draft.text.value='修订后的文字';
 const body={jobId:id,requestId:randomUUID(),revision:0,currentSHA256:file.sha256,draft,png:'data:image/png;base64,'+bytes.toString('base64')};
 return {root,id,body,bytes,file};
}
test('编辑保存后重开仍可编辑文字，更新对应制作结果，原文件保留',async t=>{
 const f=await setup(t);await saveProductionEdit(f.root,f.body);
 const read=await readProductionEdit(f.root,f.id);assert.equal(read.revision,1);assert.equal(read.draft.text.value,'修订后的文字');assert.equal(read.caseId,'C1');
 const jobs=await readProductionJobs(f.root);assert.equal(jobs[0].artworkId,'a2');assert.equal(jobs[0].repair.source,'manual_edit');assert.equal(jobs[0].repair.file.asset,read.current.asset);
 assert.deepEqual(await readBytes(resolve(f.root,'public',f.file.asset)),f.bytes);
});
test('重试相同保存不增加版本，旧页面及复用请求编号不能覆盖修改',async t=>{
 const f=await setup(t);await saveProductionEdit(f.root,f.body);assert.equal((await saveProductionEdit(f.root,f.body)).replayed,true);
 await assert.rejects(saveProductionEdit(f.root,{...f.body,requestId:randomUUID()}),/其他页面更新/);
 await assert.rejects(saveProductionEdit(f.root,{...f.body,png:f.body.png+'x'}),/保存编号已用于/);
 assert.equal((await readProductionEdit(f.root,f.id)).revision,1);
});
test('修补后的图层像素落正式资产，分片上传能回读且不能替换他人图稿引用',async t=>{
 const f=await setup(t);f.body.draft.graphic.sourceUrl=f.body.png;
 const body=JSON.stringify(f.body),size=Math.ceil(body.length/2);for(let index=0;index<2;index++)await saveEditChunk(f.root,{jobId:f.id,requestId:f.body.requestId,index,chunk:body.slice(index*size,(index+1)*size)});
 await saveProductionEdit(f.root,{jobId:f.id,requestId:f.body.requestId,chunkCount:2});
 const saved=await readProductionEdit(f.root,f.id);assert.match(saved.draft.graphic.sourceUrl,/^\/api\/batch\/production-results\//);
 const bad={...f.body,revision:1,currentSHA256:saved.current.sha256,requestId:randomUUID(),draft:structuredClone(saved.draft)};bad.draft.graphic.sourceUrl='https://unrelated.invalid/image.png';await assert.rejects(saveProductionEdit(f.root,bad),/不属于当前图稿/);
});
