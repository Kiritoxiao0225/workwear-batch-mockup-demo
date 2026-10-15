import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { hash, jsonFile, saveJSON, atomicFile, assetPath, fail, readBytes, materialize, listDirectories, checkpoint } from '../adapters/a-files.mjs';
import { requirementWorkbench, validateRequirementDraft } from './requirements.mjs';
import { productionPolicy, inspectPixels, withoutFaintSpecks, hardenInteriorAlpha, flattenOnWhite } from '../adapters/production-images.mjs';
import { readRepairState } from './production-repair.mjs';
import { artworkNetworkFailure } from '../../lib/server/artwork-network-error.ts';
import { drawSize, ratioValue, upscalePasses } from '../../lib/artwork-output-size.ts';

const stamp=()=>new Date().toISOString();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// True only when every underlying error happened while opening the connection: the request never
// reached the service, so there is nothing to pay for and sending it again cannot charge twice.
// Node reports a multi-address connect that timed out as an AggregateError with an empty message.
export function notSent(error){
  const leaves=[],pending=[error],seen=new Set();
  while(pending.length&&seen.size<16){const e=pending.shift();if(!e||typeof e!=='object'||seen.has(e))continue;seen.add(e);
    const inner=[...(Array.isArray(e.errors)?e.errors:[]),...(e.cause?[e.cause]:[])];if(inner.length)pending.push(...inner);else leaves.push(e);}
  return leaves.length>0&&leaves.every(e=>['connect','getaddrinfo'].includes(e.syscall)||e.code==='UND_ERR_CONNECT_TIMEOUT');
}
const STAGES={generate:'生图',enhance:'高清',cutout:'抠图','upscale-1':'放大','upscale-2':'放大'};
const errorText=(e,stage)=>(artworkNetworkFailure(e,stage)?.message||String(e?.message||e?.code||e))+(notSent(e)?'请求没有发出，不扣费，可直接重新制作。':'');
const dirFor=(root,id)=>{if(!/^[a-f0-9]{64}$/u.test(id))throw fail('制作编号无效');return resolve(root,'production-jobs',id);};
export async function readProductionJobs(root) {
  const dirs=await listDirectories(resolve(root,'production-jobs'));
  const jobs=[];for(const id of dirs.filter(x=>/^[a-f0-9]{64}$/u.test(x))){const job=await jsonFile(resolve(dirFor(root,id),'state.json')),repair=await readRepairState(root,id);jobs.push({...job,repair:repair.current});}
  return jobs.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
}
// The job id is a hash of this object, so nested keys are written in the draft schema's order: a
// draft read back from the database (jsonb) lists them differently, and the same artwork then got a
// second id and was generated and paid for twice.
const application=x=>({style:x.style,color:x.color,position:x.position,
  ...('sizeReference' in x?{sizeReference:x.sizeReference&&{imageId:x.sizeReference.imageId,logoToBody:x.sizeReference.logoToBody,note:x.sizeReference.note}}:{})});
// quality is added only when high, so every existing medium job keeps its id.
// Characters recognition could not read: □, or a sentence in 文字 saying so instead ("底部小字无法辨认，待补入").
// The workbench page marks the same wording red (requirements.html, UNREADABLE).
const UNREADABLE=/无法[^，。；\n]{0,8}(辨认|辨别|识别|确认|确定)|看不清|待[^，。；\n]{0,6}补入/u;
export const unreadText=prompt=>prompt.includes('□')||UNREADABLE.test(prompt.match(/^文字：([^]*?)^字体：/mu)?.[1]||'');
export function productionInput(c,a,quality=a.quality) {
  return {schema:'production-input-v1',caseId:c.caseId,artworkId:a.id,name:a.name,revision:c.revision,
    supplementRevision:c.supplement.revision,prompt:a.prompt,promptSHA256:hash(a.prompt),route:a.route,
    applications:a.applications.map(application),imageIds:a.imageIds,images:c.images,readingIssues:c.draft.readingIssues.map(x=>({scope:x.scope,issue:x.issue})),policy:productionPolicy,
    ...(a.transparentBackground===undefined?{}:{transparentBackground:a.transparentBackground}),...(quality==='high'?{quality}:{}),
    ...(a.route==='generate'&&a.output?{output:{ratio:a.output.ratio,resolution:a.output.resolution}}:{})};
}
export function sourceFor(input) {
  const selected=input.images.filter(i=>input.imageIds.includes(i.id));
  if(selected.length===1)return selected[0];
  const subject=input.prompt.match(/^主体：([^]*?)^文字：/mu)?.[1]||'';
  // Only a directly named complete source can be reused. Layout references are not artwork pixels.
  const direct=subject.match(/(?:使用|复用)图([0-9]+)完整/u);
  // "使用图1的完整主体标志" with 图2 linked for the position (Web69a498a416): the only linked image the subject names is the source.
  const named=[...new Set([...subject.matchAll(/图([0-9]+)/gu)].map(m=>Number(m[1])))].map(n=>selected.find(i=>i.index===n)).filter(Boolean);
  const source=(direct&&selected.find(i=>i.index===Number(direct[1])))||(named.length===1?named[0]:null);
  if(!source)throw fail('复用／高清路线未明确唯一内容原图，需要调整素材关联后制作');
  return source;
}
export async function reserveProduction(root,manifest,requests) {
  if(!Array.isArray(requests)||!requests.length||requests.length>100)throw fail('请选择本批要制作的需求');
  const data=await requirementWorkbench(root,manifest), jobs=[];
  for(const request of requests) {
    const c=data.cases.find(c=>c.caseId===request.caseId);
    if(!c||c.active===false||c.revision!==request.revision||c.supplement.revision!==request.supplementRevision)throw fail('要求或图片已变化，请使用最新保存内容生成',409);
    if(!c.draft)continue;
    validateRequirementDraft(c.draft,c.images);
    if(request.quality!==undefined&&request.quality!=='high')throw fail('生成质量无效');
    for(const a of c.draft.artworks.filter(a=>!request.artworkId||request.artworkId===a.id)) {
      const input=productionInput(c,a,request.quality||a.quality),id=hash(JSON.stringify(input)),dir=dirFor(root,id);
      const existing=await jsonFile(resolve(dir,'state.json'),null);if(existing){jobs.push(existing);continue;}
      let blocked=c.sourceChanged?'WPS原稿已变化，请先载入最新原稿再识别':c.sourceReadError?'原始素材读取不完整，未启动制作':null;
      if(c.needsReanalysis||c.analysis?.status==='running')blocked='素材已变化或需求仍在识别，未启动制作';
      if(!c.images.length&&c.draft.readingIssues.some(x=>/(未提供|缺少|缺失).*(Logo|图片|素材)/iu.test(x.issue)))blocked='缺少客户Logo素材，请补图后制作';
      if(a.route!=='generate')try{sourceFor(input);}catch(e){blocked=e.message;}
      if(a.route==='generate'&&c.images.some((i,n)=>i.index!==n+1))blocked='素材编号有空缺，须保持原图号；未擅自重排后提交';
      // The image model would print □ or guess the characters recognition could not read.
      if(a.route==='generate'&&unreadText(a.prompt))blocked='正文有“□”或没认出的字，请对照原图补全并保存后再制作';
      await mkdir(dir,{recursive:true});
      const fixed=[];
      for(const image of input.images){
        const bytes=await readBytes(assetPath(root,image.asset));if(hash(bytes)!==image.sha256||bytes.length!==image.bytes)throw fail('原图文件与记录不一致，未制作',409);
        const asset=`production-assets/${image.sha256}${extname(image.asset)}`;await atomicFile(assetPath(root,asset),bytes);fixed.push({...image,asset});
      }
      input.images=fixed;await saveJSON(resolve(dir,'input.json'),input);
      const job={id,caseId:c.caseId,artworkId:a.id,name:a.name,revision:c.revision,supplementRevision:c.supplement.revision,promptSHA256:input.promptSHA256,route:a.route,
        createdAt:stamp(),status:blocked?'blocked':'queued',error:blocked,steps:[],qualityStatus:'not_reviewed',policy:productionPolicy,
        ...(input.transparentBackground===undefined?{}:{transparentBackground:input.transparentBackground}),...(input.quality?{quality:input.quality}:{}),
        ...(input.output?{output:input.output}:{})};
      await saveJSON(resolve(dir,'state.json'),job);jobs.push(job);
    }
  }return jobs;
}
export async function drawingSize(input,images){
  if(!input.output)return{};
  const first=images.find(i=>i.index===1);
  let reference=null;
  if(first){const m=await import('sharp').then(x=>x.default(first.path).metadata());reference=(m.orientation||1)>=5?{width:m.height,height:m.width}:{width:m.width,height:m.height};}
  const ratio=ratioValue(input.output.ratio,reference);
  if(!ratio)return{};
  const size=drawSize(ratio);return{size:`${size.width}x${size.height}`};
}
export async function executeProduction(root,id,providers,onProgress=()=>{}) {
  const dir=dirFor(root,id),job=await jsonFile(resolve(dir,'state.json'));if(job.status!=='queued')return job;
  const input=await jsonFile(resolve(dir,'input.json'));
  const save=async()=>{await saveJSON(resolve(dir,'state.json'),job);await checkpoint();onProgress(job);};
  // Set once a paid service may have been reached; a failure before that is certain and free.
  let contacted=false;
  async function step(name,action){for(let attempt=1;;attempt++){job.phase=name;const s={name,attemptId:randomUUID(),status:'running',startedAt:stamp()};job.steps.push(s);contacted=true;await save();try{const value=await action(resolve(dir,name));const result=value&&!Buffer.isBuffer(value)&&value.bytes?value:null;if(result?.cost)s.cost=result.cost;if(result?.transparentRequested)s.transparentRequested=true;s.status='returned';s.elapsedMs=Date.now()-Date.parse(s.startedAt);await save();return result?result.bytes:value;}catch(e){const unsent=notSent(e);s.status=e.definiteFailure||unsent?'failed':'unknown';s.error=errorText(e,STAGES[name]);s.elapsedMs=Date.now()-Date.parse(s.startedAt);
    // A connection that never opened sent nothing, so it is tried again a couple of times.
    if(unsent&&attempt<3){await save();await sleep(1000*attempt);continue;}throw e;}}}
  // Reading the job's own pictures back is free and repeatable.
  const read=async path=>{for(let attempt=1;;attempt++)try{return await readBytes(path);}catch(e){if(!notSent(e)||attempt>=3)throw e;await sleep(1000*attempt);}};
  async function publish(bytes,label){const pixels=await inspectPixels(bytes);if(!pixels.visiblePixels)throw new Error('图片完全透明，没有可见图稿');
    const sha256=hash(bytes),m=await import('sharp').then(x=>x.default(bytes).metadata());
    const asset=`production-results/${id}/${label}.${m.format==='jpeg'?'jpg':m.format}`;
    await atomicFile(assetPath(root,asset),bytes);return{asset,sha256,bytes:bytes.length,...pixels};}
  /**
   * 2K/4K: the finished 1K artwork enlarged by the Volcengine upscaler (2× per pass) and scaled to a
   * 2048/4096 px long edge. A transparent artwork is enlarged on white and its alpha scaled on its own.
   * The opaque raw is scaled to the same size so 局部修补 still lines up. If the upscaler fails the
   * picture is scaled directly: the size is still right, the detail softer, and nothing is redrawn.
   */
  async function enlarge(passes){
    const sharp=(await import('sharp')).default,limit={limitInputPixels:50_000_000,failOn:'error'};
    const finalBytes=await read(assetPath(root,job.final.asset)),rawBytes=await read(assetPath(root,job.raw.asset));
    const long=passes===1?2048:4096,scale=long/Math.max(job.final.width,job.final.height);
    const width=Math.round(job.final.width*scale),height=Math.round(job.final.height*scale);
    const transparent=job.final.transparentPixels>0;
    let colour=transparent?await flattenOnWhite(finalBytes):finalBytes,fallback=null;
    for(let n=1;n<=passes&&!fallback;n++){
      const asset=assetPath(root,`production-results/${id}/upscale-input-${n}.png`);await atomicFile(asset,colour);
      try{colour=await step(`upscale-${n}`,async dir=>providers.enhance({path:await materialize(asset)},dir));}
      catch(e){fallback=errorText(e,'放大');}
    }
    const sized=await sharp(colour,limit).removeAlpha().resize(width,height,{fit:'fill',kernel:'lanczos3'}).png().toBuffer();
    const finalOut=transparent
      ?await sharp(sized,limit).joinChannel(await sharp(finalBytes,limit).ensureAlpha().extractChannel(3).resize(width,height,{fit:'fill',kernel:'lanczos3'}).png().toBuffer()).png().toBuffer()
      :sized;
    const rawOut=await sharp(rawBytes,limit).resize(width,height,{fit:'fill',kernel:'lanczos3'}).png().toBuffer();
    job.base={raw:job.raw,final:job.final};
    job.raw=await publish(rawOut,`raw-${long}`);job.final=await publish(finalOut,`final-${long}`);
    job.upscale={resolution:input.output.resolution,width,height,passes,...(fallback?{fallback}:{})};
    if(fallback)job.warning=(job.warning?job.warning+'；':'')+'火山高清放大没成功，已直接按比例放大到目标尺寸，细节会软一些';
    await save();
  }
  job.status='running';job.startedAt=stamp();await save();
  try {
    const images=[];for(const img of input.images){const path=assetPath(root,img.asset),bytes=await read(path);if(hash(bytes)!==img.sha256)throw new Error('固定原图校验失败');images.push({...img,path:await materialize(path)});}
    if(hash(input.prompt)!==input.promptSHA256)throw new Error('固定正文校验失败');
    let raw;
    if(job.resumeCutout){if(!job.raw||job.steps.filter(s=>s.name==='cutout').at(-1)?.status!=='failed')throw new Error('未确认抠图失败，不能重试未知请求');raw=await readBytes(assetPath(root,job.raw.asset));if(hash(raw)!==job.raw.sha256)throw new Error('已生成原图校验失败');}
    else if(input.route==='generate')raw=await step('generate',async dir=>providers.generate({...input,images,...await drawingSize(input,images)},dir));
    else {const image=images.find(i=>i.id===sourceFor(input).id);raw=input.route==='enhance'?await step('enhance',dir=>providers.enhance(image,dir)):await import('node:fs/promises').then(fs=>fs.readFile(image.path));}
    // A generator that already returned transparency: keep its output for audit, make the logo's
    // interior solid, and store an opaque copy on white as the source repair strokes restore from.
    const direct=input.route==='generate'&&!job.resumeCutout&&job.steps.findLast(x=>x.name==='generate')?.transparentRequested?await inspectPixels(raw):null;
    if(direct?.transparentExterior){
      const solid=await hardenInteriorAlpha(raw);
      job.generated=await publish(raw,'generated');job.raw=await publish(await flattenOnWhite(raw),'raw');await save();
      job.final=await publish(solid.bytes,'transparent');
      job.backgroundDecision=solid.hardenedRatio?`模型直接输出透明背景，已把图案内部 ${(solid.hardenedRatio*100).toFixed(1)}% 的半透明像素补成实心`:'模型直接输出透明背景，跳过抠图';
      if(solid.softRatio>0.15)job.warning=`透明图仍有 ${(solid.softRatio*100).toFixed(0)}% 的可见像素是半透明（光效或柔边），请切到深色底核对`;
    }
    else{
    job.raw=await publish(raw,'raw');await save();
    if(input.transparentBackground===false){
      const png=await import('sharp').then(x=>x.default(raw).png().toBuffer());
      job.final=await publish(png,'final');job.backgroundDecision='未勾选透明背景，保留生成或原图背景，不抠图';
    }
    else if(job.raw.transparentExterior){job.final=job.raw;job.backgroundDecision='实际像素已有透明外围，跳过抠图';}
    else{
      job.backgroundDecision='未检测到完整透明外围，使用美图抠图';await save();
      const bytes=await step('cutout',dir=>materialize(assetPath(root,job.raw.asset)).then(path=>providers.cutout(path,dir)));job.final=await publish(await withoutFaintSpecks(bytes),'cutout');
      if(!job.final.transparentExterior){
        job.warning='抠图结果的外围透明检查未通过，请放大核对；未自动重跑';
        if(input.transparentBackground===true)throw new Error('透明背景检查未通过，已保留候选图片；没有自动重复抠图');
      }
    }
    }
    const passes=input.route==='generate'&&input.output?upscalePasses(input.output.resolution):0;
    if(passes&&!job.upscale)await enlarge(passes);
    job.status='returned';job.phase='done';job.error=null;
  }catch(e){job.status=job.raw?'partial':e.definiteFailure||notSent(e)||!contacted?'failed':'unknown';job.error=errorText(e,contacted?STAGES[job.phase]||'制作':'读取素材');}
  job.finishedAt=stamp();job.elapsedMs=Date.parse(job.finishedAt)-Date.parse(job.startedAt);await save();return job;
}
export async function createProductionWorker(root,providerFactory,{concurrency=3,onProgress=()=>{}}={}) {
  const running=new Set();let providers,active=0,closed=false;
  // A restarted HTTP process must never blindly repeat a paid request.
  for(const j of await readProductionJobs(root))if(j.status==='running'){j.status='unknown';j.error='服务中断，原制作结果未知；未自动重发';await saveJSON(resolve(dirFor(root,j.id),'state.json'),j);}
  async function pump(){if(closed)return;for(const j of await readProductionJobs(root)){
    if(active>=concurrency)break;if(j.status!=='queued'||running.has(j.id))continue;
    running.add(j.id);active++;
    void (async()=>{try{providers||=await providerFactory();await executeProduction(root,j.id,providers,onProgress);}catch(e){j.status='failed';j.error=e.message;await saveJSON(resolve(dirFor(root,j.id),'state.json'),j);}finally{active--;running.delete(j.id);void pump();}})();
  }}
  return {pump,close:()=>{closed=true;},active:()=>active};
}
