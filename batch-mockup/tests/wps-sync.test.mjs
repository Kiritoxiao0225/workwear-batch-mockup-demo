import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { syncWps, wpsAttachmentURL } from '../runtime/wps.mjs';
import { requirementWorkbench } from '../application/requirements.mjs';
import { workbenchData } from '../runtime/service.mjs';
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

test('WPS 同步只管理当前表的记录，不隐藏手动图稿、批量需求或其他表的记录',async t=>{
 const f=await fixture(t);await syncWps(f.root,f.deps);
 const manifest=await f.read();
 const manual=[
  {caseId:'studio',sourceRecordId:'upload:studio',entry:'studio',active:true,images:[]},
  {caseId:'batch',sourceRecordId:'upload:batch',entry:'batch',active:true,images:[]},
  {caseId:'deleted',sourceRecordId:'upload:deleted',entry:'studio',active:false,images:[]},
  {caseId:'other',sourceRecordId:'other-file:1:A',active:true,images:[]},
 ];
 manifest.cases.push(...manual);await saveJSON(resolve(f.root,'manifest.json'),manifest);
 f.rows.A.status='已完成';await syncWps(f.root,f.deps);await syncWps(f.root,f.deps);
 const after=await f.read();assert.deepEqual(after.cases.slice(-manual.length),manual);
 assert.equal(after.cases.find(c=>c.sourceRecordId==='file:1:A').active,false);
 const scope=await jsonFile(resolve(f.root,'scope.json'));
 assert.equal(scope.cases.studio.stage,'first_generation');assert.equal(scope.cases.deleted.stage,'status_excluded');
});

test('已删除的旧 WPS 单据不会被同步重新导入，未删除单据正常显示',async t=>{
 const f=await fixture(t);await syncWps(f.root,f.deps);
 const manifest=await f.read(),removed=manifest.cases.find(c=>c.sourceRecordId==='file:1:A');
 manifest.cases=manifest.cases.filter(c=>c.caseId!==removed.caseId);
 await saveJSON(resolve(f.root,'manifest.json'),manifest);
 await saveJSON(resolve(f.root,'deleted-wps-records.json'),{sourceRecordIds:[removed.sourceRecordId]});
 f.rows.A.text='归档后原表有变化';
 await syncWps(f.root,f.deps);
 const after=await f.read();
 assert(!after.cases.some(c=>c.caseId===removed.caseId));
 assert.deepEqual(f.readIds,[['A','B']]);
 assert.equal((await jsonFile(resolve(f.root,'scope.json'))).cases[removed.caseId],undefined);
 assert(!((await requirementWorkbench(f.root,after)).cases.some(c=>c.caseId===removed.caseId)));
});

test('WPS 工作台只读取同步维护的单据索引，不读取共享工作区的独立图稿',async t=>{
 const f=await fixture(t);await syncWps(f.root,f.deps);
 const manifest=await f.read();
 manifest.cases.push({caseId:'studio',entry:'studio',sourceRecordId:'upload:studio',active:true,images:[{index:1,imageId:'studio-1',asset:'assets/studio.png'}]});
 manifest.run.imageCount=3;
 await saveJSON(resolve(f.root,'manifest.json'),manifest);
 const wps=await workbenchData(f.root,{wpsOnly:true});
 assert.deepEqual(wps.cases.map(c=>c.caseId),manifest.cases.filter(c=>c.caseId!=='studio').map(c=>c.caseId));
 assert.equal(wps.run.imageCount,2);
 const all=await workbenchData(f.root);
 assert(all.cases.some(c=>c.caseId==='studio'));
 const index=await jsonFile(resolve(f.root,'wps-case-index.json'));
 assert.deepEqual(index.caseIds,wps.cases.map(c=>c.caseId));
});

test('WPS 附件地址：只下载公网 https 域名，内网和 IP 一律拒绝', () => {
  for (const ok of ['https://kdocs.cn/api/v3/office/file/1/download', 'https://img.qwps.cn/a.png?sign=1'])
    assert.equal(wpsAttachmentURL(ok).protocol, 'https:', ok);
  for (const bad of ['http://kdocs.cn/a.png', 'https://user:pw@kdocs.cn/a.png', 'https://127.0.0.1/a', 'https://2130706433/a', 'https://0x7f000001/a',
    'https://10.0.0.5/a', 'https://100.100.100.200/latest/meta-data', 'https://169.254.169.254/a', 'https://[::1]/a', 'https://[::ffff:7f00:1]/a',
    'https://localhost/a', 'https://localhost./a', 'https://foo.localhost/a', 'https://postgresql/a', 'https://postgresql.zeabur.internal/a', 'https://kdocs.cn./a'])
    assert.throws(() => wpsAttachmentURL(bad), /WPS附件地址无效/, bad);
});
