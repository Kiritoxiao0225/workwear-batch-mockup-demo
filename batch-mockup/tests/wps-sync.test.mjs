import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { syncWps } from '../runtime/wps.mjs';
import { jsonFile, saveJSON } from '../adapters/a-files.mjs';

async function fixture(t) {
  const root=await mkdtemp(resolve(tmpdir(),'wps-sync-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await saveJSON(resolve(root,'manifest.json'),{run:{},cases:[]});
  const rows={A:{status:'待领取',text:'胸前测试',attachment:'image-a'},B:{status:'未领取',text:'后背测试',attachment:'image-b'},C:{status:'设计中',text:'排除',attachment:'image-c'}};
  const readIds=[],downloads=[];
  const png=await sharp({create:{width:4,height:4,channels:4,background:'red'}}).png().toBuffer();
  const deps={
    source:async()=>({fileId:'file',sheetId:1,scriptSnapshot:{recordIds:Object.keys(rows),manifestFields:Object.fromEntries(Object.entries(rows).map(([id,r])=>[id,{'任务状态':r.status}])),fingerprints:Object.fromEntries(Object.entries(rows).map(([id,r])=>[id,JSON.stringify(r)]))}}),
    records:async source=>{readIds.push([...source.scriptSnapshot.recordIds]);return source.scriptSnapshot.recordIds.map(id=>({id,...(rows[id].error?{error:'read failed'}:{fields:JSON.stringify({'任务状态':rows[id].status,'任务要求说明':rows[id].text,'任务素材图片':[{id:rows[id].attachment,url:'https://wps.example/'+rows[id].attachment,fileName:'相同文件名.png'}]})})}));},
    download:async url=>{downloads.push(url);return png;},
  };
  return {root,rows,deps,readIds,downloads,read:()=>jsonFile(resolve(root,'manifest.json'))};
}

test('定时同步只读取新增或变化记录，原附件复用；新附件身份即使同名同像素仍提示变化',async t=>{
  const f=await fixture(t);await syncWps(f.root,f.deps);
  assert.deepEqual(f.readIds,[['A','B']]);assert.equal(f.downloads.length,2);
  let manifest=await f.read();const original=structuredClone(manifest.cases[0]);
  const draftFile=resolve(f.root,'requirements-state',original.caseId+'.json');
  await saveJSON(draftFile,{revision:9,draftOrigin:'designer',draft:{text:'人工稿'}});
  await syncWps(f.root,f.deps);assert.equal(f.readIds.length,1);assert.equal(f.downloads.length,2);
  assert.deepEqual((await f.read()).run.syncStats,{readRecords:0,unchangedRecords:2,downloadedImages:0,reusedImages:0});
  f.rows.A.text='原文改为蓝色';await syncWps(f.root,f.deps);
  manifest=await f.read();assert.equal(manifest.cases[0].sourceText,original.sourceText);assert.equal(manifest.cases[0].pendingSource.sourceText,f.rows.A.text);assert.equal(f.downloads.length,2);
  await syncWps(f.root,f.deps);assert.equal(f.readIds.length,2);assert.equal((await f.read()).cases[0].sourceChanged,true);
  f.rows.A.text=original.sourceText;f.rows.A.attachment='new-image-a';await syncWps(f.root,f.deps);
  manifest=await f.read();assert.equal(manifest.cases[0].sourceChanged,true);assert.equal(manifest.cases[0].pendingSource.images[0].attachmentId,'new-image-a');assert.equal(f.downloads.length,3);
  assert.deepEqual(manifest.cases[0].images,original.images);assert.deepEqual(await jsonFile(draftFile),{revision:9,draftOrigin:'designer',draft:{text:'人工稿'}});
  f.rows.A.attachment='image-a';await syncWps(f.root,f.deps);assert.equal((await f.read()).cases[0].sourceChanged,undefined);assert.equal(f.downloads.length,3);
});

test('新单独立拉入，状态移出及重新进入不重下图片，读取失败保留历史且后续能恢复',async t=>{
  const f=await fixture(t);await syncWps(f.root,f.deps);
  f.rows.A.status='已完成';f.rows.D={status:'待领取',text:'新任务',attachment:'image-d'};
  const result=await syncWps(f.root,f.deps);assert.equal(result.newCases.length,1);assert.deepEqual(f.readIds.at(-1),['D']);assert.equal((await f.read()).cases[0].active,false);
  f.rows.A.status='待领取';await syncWps(f.root,f.deps);assert.equal((await f.read()).cases[0].active,true);assert.equal(f.downloads.length,3);
  f.rows.B.error=true;await syncWps(f.root,f.deps);let b=(await f.read()).cases.find(c=>c.sourceRecordId.endsWith(':B'));assert(b.sourceReadError);assert.equal(b.active,true);assert.equal(b.images.length,1);
  delete f.rows.B.error;await syncWps(f.root,f.deps);b=(await f.read()).cases.find(c=>c.sourceRecordId.endsWith(':B'));assert.equal(b.sourceReadError,undefined);assert.equal(f.downloads.length,3);
  const before=await f.read();await assert.rejects(()=>syncWps(f.root,{...f.deps,source:async()=>{throw Error('WPS unavailable');}}),/unavailable/);assert.deepEqual(await f.read(),before);
});
