import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { readRequirementState, validateRequirementDraft } from './requirements.mjs';
import { STUDIO_PLAN_MAX } from './studio-plan.mjs';
import { jsonFile, saveJSON, atomicFile, assetPath, hash, fail, readBytes, listDirectories } from '../adapters/a-files.mjs';

/**
 * Manual requirement intake.
 *
 * Produces exactly the case shape that `runtime/wps.mjs` writes, so requirement analysis,
 * artwork production and garment rendering read it without changes. Two field names matter:
 * images carry `originalSHA256` / `originalBytes`, because the freeze check compares those
 * and silently mis-naming them fails much later, inside a paid job.
 */

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES = 10;
const MAX_TEXT = 20000;

/**
 * A new workspace needs more than `cases[]`: analysis refuses to run when the prompt file and
 * its recorded digest are missing, and supplements check `scope.json` before accepting a file.
 */
export async function ensureWorkspace(root, promptSource) {
  const manifest = await jsonFile(resolve(root, 'manifest.json'), null);
  if (manifest?.run?.promptSHA256) return manifest;

  const prompt = promptSource ?? await readFile(resolve(process.cwd(), 'batch-mockup/application/requirements-prompt.txt'),'utf8');
  await atomicFile(resolve(root, 'prompt.txt'), Buffer.from(prompt, 'utf8'));
  const next = {
    ...(manifest ?? {}),
    cases: manifest?.cases ?? [],
    run: { ...(manifest?.run ?? {}), promptSHA256: hash(prompt), source: '自助录入', createdAt: new Date().toISOString() },
  };
  await saveJSON(resolve(root, 'manifest.json'), next);
  await saveJSON(resolve(root, 'scope.json'), { cases: Object.fromEntries((next.cases ?? []).map(c => [c.caseId, { stage: 'first_generation' }])) });
  return next;
}

async function decodeImage(base64, index) {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) throw fail(`图${index} 编码无效`);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw fail(`图${index} 超过 15MB`, 413);
  if (bytes.toString('base64') !== base64) throw fail(`图${index} 编码不完整`);
  let metadata;
  try {
    const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
    metadata = await decoder.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw new Error();
    await decoder.stats(); // Decode the whole image, not only its header.
  } catch { throw fail(`图${index} 无法读取，请使用完整的 PNG、JPG 或 WebP 静态图片`); }
  return { bytes, metadata };
}

/** Create one requirement. Saving costs nothing; only analysis and production are billable. */
export async function createCase(root, body) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) throw fail('请填写需求原文');
  if (text.length > MAX_TEXT) throw fail(`需求原文超过 ${MAX_TEXT} 字`);
  const inputs = Array.isArray(body.images) ? body.images : [];
  if (inputs.length > MAX_IMAGES) throw fail(`最多 ${MAX_IMAGES} 张素材图`);

  const manifest = await ensureWorkspace(root);
  // A picture this workspace already holds is named by its fingerprint instead of being sent again.
  const held = new Map(manifest.cases.flatMap(c => c.images).map(i => [i.originalSHA256, i]));
  const reused = input => typeof input?.sha256 === 'string' && !input.uploadId && input.result === undefined ? input.sha256 : null;
  // A finished artwork of this workspace (放大到 2K/4K) is copied server-side from its result file.
  const RESULT = /^production-results\/[a-f0-9]{64}\/[a-z0-9-]+\.(png|jpg|webp)$/u;
  const results = new Map();
  for (const input of inputs) {
    if (input?.result === undefined) continue;
    if (typeof input.result !== 'string' || !RESULT.test(input.result) || typeof input.sha256 !== 'string') throw fail('图稿结果无效');
    let bytes;
    try { bytes = await readBytes(assetPath(root, input.result)); } catch { throw fail('图稿结果读取失败，请刷新后重试', 409); }
    if (hash(bytes) !== input.sha256) throw fail('图稿结果已变化，请刷新后重试', 409);
    results.set(input, bytes);
  }
  for (const input of inputs) {
    const sha = reused(input);
    if (sha === null) continue;
    const known = /^[a-f0-9]{64}$/u.test(sha) && held.get(sha);
    // The client uploads in full after this answer, so a missing picture never fails the request.
    if (!known) throw fail('素材图需要重新上传', 409);
    try { if (hash(await readBytes(assetPath(root, known.asset))) !== sha) throw new Error('changed'); }
    catch { throw fail('素材图需要重新上传', 409); }
  }
  const caseId = 'U' + hash(body.requestId || randomUUID()).slice(0, 12);
  if(body.requestId && !/^[a-f0-9-]{36}$/u.test(body.requestId))throw fail('操作编号无效');
  const previous=manifest.cases.find(c=>c.caseId===caseId);
  if(previous){
    const digests=[];
    for(const [i,input] of inputs.entries())digests.push(reused(input)??(results.has(input)?input.sha256:hash((await decodeImage(await imageBase64(root,input),i+1)).bytes)));
    if(previous.sourceText!==text||previous.entry!==(body.entry==='studio'?'studio':'batch')||JSON.stringify(previous.images.map(i=>i.originalSHA256))!==JSON.stringify(digests))throw fail('该保存请求已成功，但内容后来发生变化；请刷新查看已保存行后继续编辑',409);
    return {caseId,imageCount:previous.images.length};
  }
  const images = [];
  for (const [position, input] of inputs.entries()) {
    const index = position + 1;
    const reuse = reused(input);
    if (reuse !== null) {
      const known = held.get(reuse);
      images.push({ ...known, index, imageId: `${caseId}-${index}`,
        sourceFileName: typeof input?.name === 'string' ? input.name.slice(0, 240) : known.sourceFileName, fetchedAt: new Date().toISOString() });
      continue;
    }
    const { bytes, metadata } = results.has(input)
      ? await decodeImage(results.get(input).toString('base64'), index)
      : await decodeImage(await imageBase64(root,input), index);
    const sha = hash(bytes);
    const asset = `wps-assets/${sha}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`;
    await atomicFile(assetPath(root, asset), bytes);
    images.push({
      index, imageId: `${caseId}-${index}`, asset,
      width: metadata.width, height: metadata.height, hasAlpha: !!metadata.hasAlpha,
      sourceFileName: typeof input?.name === 'string' ? input.name.slice(0, 240) : '',
      originalBytes: bytes.length, originalSHA256: sha,
      mime: `image/${metadata.format}`, fetchedAt: new Date().toISOString(),
    });
  }

  const next = {
    caseId, group: '自助录入',
    sourceRecordId: `upload:${caseId}`,
    sourceText: text, sourceTextSHA256: hash(text),
    images, sourceAttachmentCount: images.length, sourceRevision: 0, active: true, entry: body.entry === 'studio' ? 'studio' : 'batch',
  };
  manifest.cases.push(next);
  await saveJSON(resolve(root, 'manifest.json'), manifest);
  await saveJSON(resolve(root, 'scope.json'), { cases: Object.fromEntries(manifest.cases.map(c => [c.caseId, { stage: c.active === false ? 'status_excluded' : 'first_generation' }])) });
  return { caseId, imageCount: images.length };
}

/**
 * Edit the source text or images of an existing requirement.
 *
 * Changing the source invalidates an earlier reading the same way a changed WPS record does:
 * the previous draft is kept as history and the row is marked for re-analysis rather than
 * silently reused against new inputs.
 */
export async function updateCase(root, body) {
  const manifest = await jsonFile(resolve(root, 'manifest.json'));
  const current = manifest.cases.find(c => c.caseId === body?.caseId);
  if (!current) throw fail('需求不存在', 404);
  if(!current.sourceRecordId?.startsWith('upload:'))throw fail('此入口只能修改手动录入的需求',403);
  if (current.active === false) throw fail('该需求已删除', 409);

  if(body.sourceRevision!==undefined && body.sourceRevision!==(current.sourceRevision||0))throw fail('原文已在其他页面修改，请刷新后重试',409);
  const text = typeof body.text === 'string' ? body.text.trim() : current.sourceText;
  if (!text) throw fail('需求原文不能为空');
  if(text.length>MAX_TEXT)throw fail(`需求原文超过 ${MAX_TEXT} 字`);
  const changedText = hash(text) !== current.sourceTextSHA256;

  let images = current.images;
  if (Array.isArray(body.images)) {
    if (body.images.length > MAX_IMAGES) throw fail(`最多 ${MAX_IMAGES} 张素材图`);
    images = [];
    let nextIndex=Math.max(0,...current.images.map(i=>i.index))+1;
    for (const input of body.images) {
      const index = nextIndex;
      // Persisted image numbers are identities; removing a reference must not silently rename another.
      const kept = input?.imageId && current.images.find(image => image.imageId === input.imageId);
      if (kept) { if(images.some(i=>i.imageId===kept.imageId))throw fail('不可重复关联同一素材');images.push({ ...kept }); continue; }
      if(input?.imageId)throw fail('素材不属于当前需求',403);
      nextIndex++;
      const { bytes, metadata } = await decodeImage(await imageBase64(root,input), index);
      const sha = hash(bytes);
      const asset = `wps-assets/${sha}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`;
      await atomicFile(assetPath(root, asset), bytes);
      images.push({
        index, imageId: `${current.caseId}-${index}`, asset,
        width: metadata.width, height: metadata.height, hasAlpha: !!metadata.hasAlpha,
        sourceFileName: typeof input?.name === 'string' ? input.name.slice(0, 240) : '',
        originalBytes: bytes.length, originalSHA256: sha,
        mime: `image/${metadata.format}`, fetchedAt: new Date().toISOString(),
      });
    }
  }
  const identity=i=>[i.imageId,i.index,i.originalSHA256];
  const changedImages = JSON.stringify(current.images.map(identity)) !== JSON.stringify(images.map(identity));

  if (changedText || changedImages) {
    await saveJSON(resolve(root, 'requirements-history', current.caseId, `before-edit-${Date.now()}.json`), { source: { ...current } });
    current.sourceText = text;
    current.sourceTextSHA256 = hash(text);
    current.images = images;
    current.sourceAttachmentCount = images.length;
    // Downstream treats this exactly like a changed WPS record: the saved draft stays, but the
    // row is flagged so a stale reading is never reused for a paid job.
    current.needsReanalysis = true;
    current.sourceRevision=(current.sourceRevision||0)+1;
    const state=await readRequirementState(root,current.caseId);
    state.revision++;
    await saveJSON(resolve(root,'requirements-state',current.caseId+'.json'),state);
    await saveJSON(resolve(root, 'manifest.json'), manifest);
  }
  return { caseId: current.caseId, sourceRevision:current.sourceRevision||0, changed: changedText || changedImages, imageCount: images.length };
}

// A studio picture keeps running and is charged after its row is hidden, so the row waits until
// every picture and AI reading on it has finished.
async function stillMaking(root, caseId) {
  if ((await readRequirementState(root, caseId)).analyses.some(a => a.status === 'running')) return true;
  for (const id of await listDirectories(resolve(root, 'production-jobs'))) {
    const job = await jsonFile(resolve(root, 'production-jobs', id, 'state.json'), null);
    if (job?.caseId === caseId && ['queued', 'running'].includes(job.status)) return true;
  }
  return false;
}

/**
 * Soft delete. History and any produced artwork stay; the row simply stops being eligible,
 * which is the same signal `active: false` carries for a withdrawn WPS record.
 */
export async function removeCase(root, body) {
  const manifest = await jsonFile(resolve(root, 'manifest.json'));
  const current = manifest.cases.find(c => c.caseId === body?.caseId);
  if (!current) throw fail('需求不存在', 404);
  if(!current.sourceRecordId?.startsWith('upload:'))throw fail('此入口只能修改手动录入的需求',403);
  if (current.entry === 'studio' && await stillMaking(root, current.caseId)) throw fail('这条图稿还在制作，出完再删', 409);
  current.active = false;
  await saveJSON(resolve(root, 'manifest.json'), manifest);
  await saveJSON(resolve(root, 'scope.json'), { cases: Object.fromEntries(manifest.cases.map(c => [c.caseId, { stage: c.active === false ? 'status_excluded' : 'first_generation' }])) });
  return { caseId: current.caseId, active: false };
}

// Chunks keep each HTTP request below the deployment body limit while retaining the 15MB limit.
export async function stageCaseImage(root,body){
 if(!/^[a-f0-9-]{36}$/.test(body.id)||!Number.isInteger(body.index)||body.index<0||body.index>=16||typeof body.base64!=='string'||body.base64.length>1400000||!Number.isInteger(body.count)||body.count<1||body.count>16||body.index>=body.count)throw fail('图片分片无效');
 await saveJSON(resolve(root,'intake-chunks',body.id,body.index+'.json'),{base64:body.base64,count:body.count});
 return {saved:true};
}
async function imageBase64(root,input){
 if(!input?.uploadId)return input?.base64;
 if(!/^[a-f0-9-]{36}$/.test(input.uploadId)||!Number.isInteger(input.chunkCount)||input.chunkCount<1||input.chunkCount>16)throw fail('图片上传编号无效');
 const parts=[];
 for(let i=0;i<input.chunkCount;i++){
  const chunk=await jsonFile(resolve(root,'intake-chunks',input.uploadId,i+'.json'));
  if(chunk.count!==input.chunkCount)throw fail('图片分片数量不一致');
  parts.push(chunk.base64);
 }
 return parts.join('');
}
// A studio author supplies the complete seven-field draft directly; no hidden analysis call.
export async function prepareStudio(root,body){
 const manifest=await jsonFile(resolve(root,'manifest.json'));
 const c=manifest.cases.find(c=>c.caseId===body.caseId);
 if(!c||c.entry!=='studio'||c.active===false)throw fail('图稿需求不存在',404);
 const state=await readRequirementState(root,c.caseId);
 if(body.revision!==state.revision)throw fail('制作要求已变化，请刷新后重试',409);
 const images=c.images.map(i=>({id:i.imageId,index:i.index}));
 const draft=validateRequirementDraft(body.draft,images);
 if(!draft.artworks.length||draft.artworks.length>STUDIO_PLAN_MAX||draft.artworks.some(a=>a.applications.length))throw fail(`独立图稿一次最多${STUDIO_PLAN_MAX}张，不绑定衣服`);
 state.draft=draft;state.draftOrigin='designer';state.draftAnalysisId=null;
 state.draftSupplementRevision=0;state.revision++;
 c.needsReanalysis=false;
 await saveJSON(resolve(root,'requirements-state',c.caseId+'.json'),state);
 await saveJSON(resolve(root,'manifest.json'),manifest);
 return {revision:state.revision};
}
