import { resolve } from 'node:path';
import sharp from 'sharp';
import { assertArtworkDraft } from '../../lib/artwork-editor.ts';
import { hash, jsonFile, saveJSON, atomicFile, assetPath, fail, readBytes } from '../adapters/a-files.mjs';
import { inspectPixels, withoutFaintSpecks } from '../adapters/production-images.mjs';
import { readRepairState } from './production-repair.mjs';
const directory=(root,id)=>{if(!/^[a-f0-9]{64}$/.test(id||''))throw fail('制作编号无效');return resolve(root,'production-jobs',id);};
/** A saved edit that gives an image layer a solid color is the designer's color choice for the artwork. */
export async function editRecolorsArtwork(root,job){
 const revision=job?.repair?.draftRevision;if(!revision)return false;
 const draft=(await jsonFile(resolve(directory(root,job.id),`edit-${revision}.json`),null))?.draft;
 return !!draft&&[draft.graphic,...draft.extraGraphics||[]].some(g=>g?.recolor?.mode==='solid');
}
export async function readProductionEdit(root,id){
 const dir=directory(root,id),job=await jsonFile(resolve(dir,'state.json'),null);
 if(!job?.raw||['running','queued','unknown'].includes(job.status))throw fail('制作尚未完成，暂不能编辑',409);
 const state=await readRepairState(root,id),entry=state.current;
 const stored=entry?.draftRevision?await jsonFile(resolve(dir,`edit-${entry.draftRevision}.json`)):null;
 const input=await jsonFile(resolve(dir,'input.json'),{});
 return {jobId:id,caseId:job.caseId,title:`${job.caseId} · ${job.name}`,requirement:input.prompt||'',revision:state.revision,raw:job.raw,current:entry?.file||job.final||job.raw,draft:stored?.draft||null,history:state.history.map(x=>({requestId:x.requestId,revision:x.revision}))};
}
export async function saveEditChunk(root,body){
 const dir=directory(root,body.jobId);
 if(!/^[a-f0-9-]{36}$/.test(body.requestId||'')||!Number.isInteger(body.index)||body.index<0||body.index>=32||typeof body.chunk!=='string'||body.chunk.length>1_400_000)throw fail('编辑分片无效');
 await readProductionEdit(root,body.jobId);
 const path=resolve(dir,'edit-upload',body.requestId,body.index+'.json'),old=await jsonFile(path,null);
 if(old&&old.chunk!==body.chunk)throw fail('上传内容已变化，请使用新的保存编号',409);
 await saveJSON(path,{chunk:body.chunk});return {saved:true};
}
export async function saveProductionEdit(root,body){
 const dir=directory(root,body.jobId);
 if(!/^[a-f0-9-]{36}$/.test(body.requestId||''))throw fail('保存编号无效');
 if(body.chunkCount){
  if(!Number.isInteger(body.chunkCount)||body.chunkCount<1||body.chunkCount>32)throw fail('编辑分片数量无效');
  const chunks=[];for(let i=0;i<body.chunkCount;i++)chunks.push((await jsonFile(resolve(dir,'edit-upload',body.requestId,i+'.json'))).chunk);
  const decoded=JSON.parse(chunks.join(''));if(decoded.jobId!==body.jobId||decoded.requestId!==body.requestId)throw fail('保存编号与上传内容不符');body=decoded;
 }
 const input=await readProductionEdit(root,body.jobId),state=await readRepairState(root,body.jobId);
 const requestSHA256=hash(JSON.stringify({revision:body.revision,currentSHA256:body.currentSHA256,draft:body.draft,png:body.png}));
 const existing=state.history.find(x=>x.requestId===body.requestId);
 if(existing){if(existing.requestSHA256!==requestSHA256)throw fail('保存编号已用于其他内容',409);return {revision:existing.revision,replayed:true};}
 if(body.revision!==input.revision||body.currentSHA256!==input.current.sha256)throw fail('图稿已在其他页面更新；本页修改仍保留，请重新打开最新图稿',409);
 try{assertArtworkDraft(body.draft);}catch(e){throw fail(e.message);}
 const draft=structuredClone(body.draft),graphics=[draft.graphic,...draft.extraGraphics||[]];
 if(graphics.length+(draft.text?1:0)+(draft.extraTexts?.length||0)>64)throw fail('最多支持64个图层');
 const oldGraphics=input.draft?[input.draft.graphic,...input.draft.extraGraphics||[]]:[];
 const allowed=new Set(['/api/batch/'+input.raw.asset,'/api/batch/'+input.current.asset,...oldGraphics.flatMap(g=>[g.sourceUrl,g.recolorMaskUrl]).filter(Boolean)]);
 async function savePNG(url,label){
  if(typeof url!=='string'||!/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(url)||url.length>24_000_000)throw fail('仅支持有效PNG图片');
  let bytes;try{bytes=await sharp(Buffer.from(url.split(',')[1],'base64'),{limitInputPixels:16_000_000}).toColourspace('srgb').png().toBuffer();}catch{throw fail('PNG图片无法读取或尺寸过大');}
  // Layer sources and recolor masks stay pixel-exact for later edits; only the flattened result is cleaned.
  if(label==='result')bytes=await withoutFaintSpecks(bytes);
  const sha256=hash(bytes),asset=`production-results/${body.jobId}/edit-${label}-${sha256}.png`;
  await atomicFile(assetPath(root,asset),bytes);if(hash(await readBytes(assetPath(root,asset)))!==sha256)throw fail('图片保存校验失败',500);
  return {asset,sha256,bytes:bytes.length,...await inspectPixels(bytes)};
 }
 for(const g of graphics)for(const key of ['sourceUrl','recolorMaskUrl']){if(!g[key])continue;if(g[key].startsWith('data:'))g[key]='/api/batch/'+(await savePNG(g[key],'layer')).asset;else if(!allowed.has(g[key]))throw fail('图层引用了不属于当前图稿的素材');}
 const file=await savePNG(body.png,'result');if(!file.visiblePixels)throw fail('图稿完全透明，请保留需要的内容');
 const revision=state.revision+1,entry={revision,requestId:body.requestId,requestSHA256,savedAt:new Date().toISOString(),source:'manual_edit',baseSHA256:input.current.sha256,rawSHA256:input.raw.sha256,draftRevision:revision,file,qualityStatus:'not_reviewed'};
 await saveJSON(resolve(dir,`edit-${revision}.json`),{...entry,draft});
 await saveJSON(resolve(dir,'repair-state.json'),{revision,current:entry,history:[...state.history,entry]});
 return {revision,replayed:false};
}
