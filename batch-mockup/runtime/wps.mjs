import { resolve } from 'node:path';
import sharp from 'sharp';
import { airscriptSource,airscriptRecords } from '../../lib/server/wps-airscript.ts';
import { classifyWpsScope } from '../experiments/standardize-36/wps-scope.mjs';
import { jsonFile,saveJSON,atomicFile,assetPath,hash,checkpoint } from '../adapters/a-files.mjs';
async function download(url){
 const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.hostname==='localhost'||/^[\d:[\]]+$/.test(u.hostname))throw Error('WPS附件地址无效');
 const r=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(45000)});if(!r.ok)throw Error('WPS附件下载HTTP '+r.status);
 const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>40*1024*1024)throw Error('WPS附件超过40MB');chunks.push(chunk);}return Buffer.concat(chunks);
}
export async function syncWps(root,dependencies={}){
 const source=await (dependencies.source||airscriptSource)(),snapshot=source.scriptSnapshot;
 const eligible=snapshot.recordIds.filter(id=>classifyWpsScope({status:snapshot.manifestFields[id]['任务状态']}).stage==='first_generation');
 const manifest=await jsonFile(resolve(root,'manifest.json')),prior=new Map(manifest.cases.map(c=>[c.sourceRecordId,c]));
 const identityFor=id=>`${source.fileId}:${source.sheetId}:${id}`;
 const changed=eligible.filter(id=>{const old=prior.get(identityFor(id));return !old||old.sourceReadError||!snapshot.fingerprints?.[id]||old.sourceFingerprint!==snapshot.fingerprints[id];});
 const raw=changed.length?await (dependencies.records||airscriptRecords)({...source,scriptSnapshot:{...snapshot,recordIds:changed}},true):[];
 const errors=[],seen=new Set(eligible.map(identityFor)),newCases=[];
 let downloadedImages=0,reusedImages=0;
 for(const id of eligible){const old=prior.get(identityFor(id));if(old){old.active=true;old.wpsStatus=snapshot.manifestFields[id]['任务状态'];}}
 for(const record of raw){
  const identity=identityFor(record.id);
  try{
   if(record.error)throw Error('WPS原文读取失败');const fields=JSON.parse(record.fields);
   if(classifyWpsScope({status:fields['任务状态']}).stage!=='first_generation'){seen.delete(identity);continue;}
   const text=fields['任务要求说明'];if(typeof text!=='string'||!text.trim())throw Error('原始要求为空');
   const materials=fields['任务素材图片']||[];if(!Array.isArray(materials))throw Error('WPS素材字段格式无效');
   const previous=prior.get(identity),caseId=previous?.caseId||'W'+hash(identity).slice(0,12),images=[];
   for(const [n,item] of materials.entries()){
    if(!item.id)throw Error('图'+(n+1)+'缺少附件身份');
    const saved=[...(previous?.pendingSource?.images||[]),...(previous?.images||[])].find(i=>i.attachmentId===String(item.id)&&i.originalSHA256&&i.asset);
    if(saved){images.push({...saved,index:n+1,imageId:caseId+'-'+(n+1),sourceFileName:item.fileName||''});reusedImages++;continue;}
    if(!item.url)throw Error('图'+(n+1)+'缺少附件地址');
    const bytes=await (dependencies.download||download)(item.url),m=await sharp(bytes,{limitInputPixels:80000000,failOn:'error'}).metadata();if(!['png','jpeg','webp'].includes(m.format)||(m.pages||1)!==1)throw Error('不支持的原图格式');
    const sha=hash(bytes),asset=`wps-assets/${sha}.${m.format==='jpeg'?'jpg':m.format}`;await atomicFile(assetPath(root,asset),bytes);
    downloadedImages++;
    images.push({index:n+1,imageId:caseId+'-'+(n+1),asset,width:m.width,height:m.height,hasAlpha:!!m.hasAlpha,attachmentId:String(item.id),sourceFileName:item.fileName||'',originalBytes:bytes.length,originalSHA256:sha,mime:'image/'+m.format,fetchedAt:new Date().toISOString()});
   }
   const next={caseId,group:'WPS正式原稿',sourceRecordId:identity,sourceText:text,sourceTextSHA256:hash(text),wpsStatus:fields['任务状态'],images,sourceAttachmentCount:images.length,active:true,sourceFingerprint:snapshot.fingerprints?.[record.id]};
   if(!previous){manifest.cases.push(next);newCases.push(caseId);}
   else {
    if(previous.sourceTextSHA256!==next.sourceTextSHA256||JSON.stringify(previous.images.map(i=>[i.attachmentId,i.originalSHA256]))!==JSON.stringify(images.map(i=>[i.attachmentId,i.originalSHA256]))){previous.pendingSource=next;previous.sourceChanged=true;}
    else {delete previous.pendingSource;delete previous.sourceChanged;}
    previous.sourceFingerprint=next.sourceFingerprint;previous.active=true;previous.wpsStatus=next.wpsStatus;delete previous.sourceReadError;
   }
  }catch(e){errors.push({sourceRecordId:identity,error:e.message});const old=prior.get(identity);if(old)old.sourceReadError=e.message;}
 }
 for(const c of manifest.cases)if(!seen.has(c.sourceRecordId))c.active=false;
 manifest.run={...manifest.run,sourceReadAt:new Date().toISOString(),totalSourceRecords:snapshot.recordIds.length,eligibleCount:eligible.length,caseCount:manifest.cases.length,imageCount:manifest.cases.reduce((n,c)=>n+c.images.length,0),source:'WPS正式原表实时同步',syncErrors:errors,syncStats:{readRecords:changed.length,unchangedRecords:eligible.length-changed.length,downloadedImages,reusedImages}};
 await saveJSON(resolve(root,'scope.json'),{cases:Object.fromEntries(manifest.cases.map(c=>[c.caseId,{stage:c.active===false?'status_excluded':'first_generation'}]))});await saveJSON(resolve(root,'manifest.json'),manifest);await saveJSON(resolve(root,'source-receipt.json'),{readAt:manifest.run.sourceReadAt,total:snapshot.recordIds.length,eligible:eligible.length,newCases,errors,readOnly:true});await checkpoint();
 return {total:snapshot.recordIds.length,eligible:eligible.length,newCases,errors};
}
