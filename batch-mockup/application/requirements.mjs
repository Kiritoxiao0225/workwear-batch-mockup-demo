import { resolve, extname } from 'node:path';
import { z } from 'zod';
import { hash, jsonFile, saveJSON, atomicFile, assetPath, fail, readBytes } from '../adapters/a-files.mjs';
import { configuredAnalyzer } from '../adapters/a-analysis.mjs';

const line = z.string().max(500);
const artworkSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), name: z.string().min(1).max(200),
  route: z.enum(['generate', 'enhance', 'reuse']),
  transparentBackground: z.boolean().optional(),
  // sizeReference: SOP 2.1 — only a reference photo/mockup shows the size; a ratio, never a customer size in cm.
  applications: z.array(z.object({ style: line, color: line, position: line,
    sizeReference: z.object({ imageId: z.string().min(1).max(100), logoToBody: z.number().min(.03).max(.95), note: z.string().max(300) }).strict().nullish() }).strict()).max(100),
  imageIds: z.array(z.string().min(1).max(100)).max(30), prompt: z.string().min(1).max(20000),
}).strict();
const draftSchema = z.object({ artworks: z.array(artworkSchema).max(40),
  readingIssues: z.array(z.object({ scope: line, issue: z.string().min(1).max(3000) }).strict()).max(40),
}).strict();
const stamp = () => new Date().toISOString();
const pathFor = (root, id) => resolve(root, 'requirements-state', `${id}.json`);
const writeState = (root, id, s) => saveJSON(pathFor(root, id), s);
export const readRequirementState = (root, id) => jsonFile(pathFor(root, id), {
  revision: 0, draft: null, draftSupplementRevision: 0, analyses: [], confirmations: [],
});
const requestId = id => { if (!z.string().uuid().safeParse(id).success) throw fail('操作标识无效'); };
// Single entry point for every manual action, so a withdrawn requirement is refused for
// analysis and production alike rather than only in the automatic flow.
const findCase = (manifest, id) => {
  const c = manifest.cases.find(c => c.caseId === id);
  if (!c) throw fail('未找到需求', 404);
  if (c.active === false) throw fail('该需求已删除或已移出本轮，无法继续操作', 409);
  return c;
};

export async function requirementImages(root, c, supplement) {
  const images = c.images.map(i => ({ id: i.imageId, label: `图${i.index}`, index: i.index, asset: i.asset,
    sha256: i.originalSHA256, bytes: i.originalBytes, width: i.width, height: i.height, target: '', source: 'original' }));
  const originalMax=Math.max(0,...c.images.map(i=>i.index));
  for (const [i, x] of supplement.items.entries()) if (!x.removedAt) images.push({ id: x.id,
    label: `图${originalMax + i + 1}`, index: originalMax + i + 1, asset: x.asset, sha256: x.sha256,
    bytes: x.bytes, width: x.width, height: x.height, target: x.target, source: 'designer_upload' });
  return images;
}
async function context(root, manifest, body) {
  const c = findCase(manifest, body?.caseId), state = await readRequirementState(root, c.caseId);
  const supplement = (await jsonFile(resolve(root, 'supplements.json'), {}))[c.caseId] || { revision: 0, items: [] };
  if (body.revision !== state.revision || body.supplementRevision !== supplement.revision) throw fail('正文或素材已更新，请刷新后再操作；当前输入未覆盖保存内容', 409);
  return { c, state, supplement, images: await requirementImages(root, c, supplement) };
}
export function validateRequirementDraft(value, images) {
  const r = draftSchema.safeParse(value);
  if (!r.success) throw fail('制作要求格式无效：' + r.error.issues.slice(0, 3).map(i => `${i.path.join('.')} ${i.message}`).join('；'));
  const ids = new Set(), valid = new Map(images.map(i => [i.id, i]));
  for (const a of r.data.artworks) {
    if (!a.prompt.trim() || ids.has(a.id)) throw fail('图稿编号重复或制作正文为空');
    const labels = [...a.prompt.matchAll(/^(主体|文字|字体|颜色|排版|尺寸|输出)：/gmu)];
    if (labels.map(x => x[1]).join('/') !== '主体/文字/字体/颜色/排版/尺寸/输出' || !/^【[^\n]+】\r?\n/u.test(a.prompt)) throw fail(`${a.name}必须按顺序包含主体、文字、字体、颜色、排版、尺寸、输出七项`);
    for (const [i, m] of labels.entries()) if (!a.prompt.slice(m.index + m[0].length, labels[i + 1]?.index ?? a.prompt.length).trim()) throw fail(`${a.name}的${m[1]}为空`);

    ids.add(a.id);
    if (new Set(a.imageIds).size !== a.imageIds.length || a.imageIds.some(id => !valid.has(id))) throw fail(`${a.name}关联了不存在或重复的图片`);
    if (a.applications.some(x => x.sizeReference && !valid.has(x.sizeReference.imageId))) throw fail(`${a.name}的参考图比例关联了不存在的图片`);
    // Validate binding only. Never correct, trim or rewrite the actual prompt.
    for (const match of a.prompt.matchAll(/图\s*([0-9０-９]+|[一二三四五六七八九十])/gu)) {
      const token = match[1].replace(/[０-９]/gu, c => String(c.charCodeAt(0) - 65296));
      const n = /^\d+$/u.test(token) ? Number(token) : '一二三四五六七八九十'.indexOf(token) + 1;
      const img = images.find(i => i.index === n);
      if (!img || !a.imageIds.includes(img.id)) throw fail(`${a.name}正文引用图${n}，但关联图片未包含它`);
    }
  }
  if (!r.data.artworks.length && !r.data.readingIssues.length) throw fail('没有图稿时必须说明具体识别问题');
  return r.data;
}
async function freezeImages(root, images) {
  const fixed = [];
  for (const img of images) {
    const bytes = await readBytes(assetPath(root, img.asset));
    if (hash(bytes) !== img.sha256 || bytes.length !== img.bytes) throw fail(`${img.label}原始文件与记录不一致`, 409);
    const asset = `confirmed-assets/${img.sha256}${extname(img.asset).toLowerCase()}`;
    await atomicFile(assetPath(root, asset), bytes); fixed.push({ ...img, asset });
  }
  return fixed;
}
export async function reserveRequirementAnalysis(root, manifest, body, factory = configuredAnalyzer) {
  requestId(body?.requestId); findCase(manifest, body.caseId);
  const previous = (await readRequirementState(root, body.caseId)).analyses.find(a => a.id === body.requestId);
  if (previous) return { analysis: previous };
  const { c, state, supplement, images } = await context(root, manifest, body);
  if (state.analyses.some(a => a.status === 'running')) throw fail('本条正在识别，请等待返回', 409);
  if (state.analyses.some(a => a.status === 'unknown' && a.revision === state.revision && a.supplementRevision === supplement.revision)) throw fail('该输入已有结果未知的请求，请先核实原请求；未重复付费', 409);
  const analyze = await factory(), prompt = (await readBytes(resolve(root, 'prompt.txt'))).toString('utf8');
  if (hash(prompt) !== manifest.run.promptSHA256) throw fail('提示词与本批定稿版本不一致', 409);
  const fixed = await freezeImages(root, images);
  const input = { 原始需求: c.sourceText, 图片: fixed.map(i => ({ id: i.id, 图号: i.label, 用途: i.target || '结合原文与全部图片理解' })) };
  if (state.draftOrigin === 'designer') input.设计师已保存修改 = state.draft;
  const content = [{ type: 'text', text: JSON.stringify(input) }];
  for (const img of fixed) {
    const mime = /\.jpe?g$/iu.test(img.asset) ? 'image/jpeg' : `image/${extname(img.asset).slice(1)}`;
    content.push({ type: 'text', text: `${img.label} · id=${img.id} · ${img.width}×${img.height}` },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${(await readBytes(assetPath(root, img.asset))).toString('base64')}`, detail: 'high' } });
  }
  const request = { model: analyze.model || 'gpt-5.6-sol', reasoning_effort: analyze.effort || 'low', max_completion_tokens: 16000,
    response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: prompt }, { role: 'user', content }] };
  const analysis = { id: body.requestId, status: 'running', startedAt: stamp(), revision: state.revision,
    supplementRevision: supplement.revision, promptSHA256: hash(prompt), requestSHA256: hash(JSON.stringify(request)),
    sourceTextSHA256: hash(c.sourceText), images: fixed, model: request.model, effort: request.reasoning_effort };
  await saveJSON(resolve(root, 'analysis-evidence', c.caseId, `${analysis.id}-request.json`), request);
  state.analyses.push(analysis); await writeState(root, c.caseId, state);
  return { analysis, execute: () => analyze(request) };
}
export async function finishRequirementAnalysis(root, manifest, caseId, id, result, error) {
  findCase(manifest, caseId); const state = await readRequirementState(root, caseId), a = state.analyses.find(a => a.id === id);
  if (!a || a.status !== 'running') return;
  a.finishedAt = stamp(); a.elapsedMs = Date.parse(a.finishedAt) - Date.parse(a.startedAt);
  if (error) { a.status = error.status ? 'failed' : 'unknown'; a.error = error.status ? error.message : '连接或响应异常，结果未知；没有自动重发'; }
  else {
    await saveJSON(resolve(root, 'analysis-evidence', caseId, `${id}-response.json`), result);
    Object.assign(a, result);
    try { a.parsed = validateRequirementDraft(JSON.parse(result.rawContent), a.images); a.status = 'returned'; }
    catch (e) { a.status = 'invalid_output'; a.error = e.status ? e.message : '返回不是完整JSON；原始返回已保留'; }
    const sup = (await jsonFile(resolve(root, 'supplements.json'), {}))[caseId]?.revision || 0;
    if (a.status === 'returned' && !state.draft && state.revision === a.revision && sup === a.supplementRevision) {
      state.draft = a.parsed; state.draftOrigin = 'model'; state.draftAnalysisId = id;
      state.draftSupplementRevision = sup; state.revision += 1;
      const source=manifest.cases.find(c=>c.caseId===caseId);
      if(source.needsReanalysis){source.needsReanalysis=false;await saveJSON(resolve(root,'manifest.json'),manifest);}
    }
  }
  await writeState(root, caseId, state);
}
export async function saveRequirementDraft(root, manifest, body) {
  const { c, state, supplement, images } = await context(root, manifest, body);
  if (body.analysisId && body.analysisId !== state.draftAnalysisId) {
    const a = state.analyses.find(a => a.id === body.analysisId);
    if (a?.status !== 'returned' || a.revision !== state.revision || a.supplementRevision !== supplement.revision) throw fail('新识别结果已过期，请保留修改并重新识别', 409);
    state.draftAnalysisId = a.id; state.draftSupplementRevision = supplement.revision;
  }
  if (!state.draftAnalysisId && c.entry!=='studio') throw fail('请先取得模型结果', 409);
  state.draft = validateRequirementDraft(body.draft, images);
  if(body.analysisId&&c.needsReanalysis){c.needsReanalysis=false;await saveJSON(resolve(root,'manifest.json'),manifest);}
  state.draftOrigin = 'designer'; state.updatedAt = stamp(); state.revision += 1;
  await writeState(root, c.caseId, state); return state;
}
export async function confirmRequirementDraft(root, manifest, body) {
  requestId(body?.requestId); findCase(manifest, body.caseId);
  const previous = (await readRequirementState(root, body.caseId)).confirmations.find(x => x.id === body.requestId);
  if (previous) {
    if (previous.revision !== body.revision || previous.supplementRevision !== body.supplementRevision || previous.confirmedBy !== body.confirmedBy) throw fail('确认标识已用于另一份内容', 409);
    return previous;
  }
  const { c, state, supplement, images } = await context(root, manifest, body);
  if (!state.draft || !state.draft.artworks.length) throw fail('没有可确认的制作正文', 409);
  if (state.draft.readingIssues.length) throw fail('还有识别问题，请核对、修改并标记已处理后再确认', 409);
  if (state.draftSupplementRevision !== supplement.revision) throw fail('补图后请重新识别、采用并核对新结果', 409);
  if (state.analyses.some(a => a.status === 'running')) throw fail('仍在识别，请等待结果后确认', 409);
  if (typeof body.confirmedBy !== 'string' || !body.confirmedBy.trim() || body.confirmedBy.length > 80) throw fail('请填写核对人名称');
  const draft = validateRequirementDraft(state.draft, images), fixed = await freezeImages(root, images);
  const packet = { schema: 'requirements-confirmed-v2', id: body.requestId, caseId: c.caseId,
    revision: state.revision, supplementRevision: supplement.revision, confirmedBy: body.confirmedBy,
    confirmedAt: stamp(), actorSource: 'local_self_reported', draft, images: fixed,
    promptHashes: Object.fromEntries(draft.artworks.map(a => [a.id, hash(a.prompt)])),
    sourceTextSHA256: hash(c.sourceText), promptSHA256: manifest.run.promptSHA256,
    analysisId: state.draftAnalysisId, executionEnabled: false };
  state.confirmations.push(packet); await writeState(root, c.caseId, state); return packet;
}
export async function readArtworkInput(root, manifest, caseId, confirmationId, artworkId) {
  findCase(manifest, caseId);
  const state = await readRequirementState(root, caseId), packet = state.confirmations.find(x => x.id === confirmationId);
  const art = packet?.draft.artworks.find(a => a.id === artworkId);
  if (!art || packet.promptHashes[art.id] !== hash(art.prompt)) throw fail('未找到有效的确认图稿', 404);
  const images = await freezeImages(root, packet.images);
  // One canonical string. No summarizing, trimming, renumbering, prefixes or suffixes.
  return { schema: 'artwork-input-v2', confirmationId, artworkId, prompt: art.prompt,
    promptSHA256: hash(art.prompt), route: art.route, applications: art.applications,
    imageIds: art.imageIds, images, executionEnabled: false };
}
export async function requirementWorkbench(root, manifest) {
  const supplements = await jsonFile(resolve(root, 'supplements.json'), {}), cases = [];
  const notes = await jsonFile(resolve(root, 'qa-notes-v2.json'), {});
  for (const c of manifest.cases) {
    const state = await readRequirementState(root, c.caseId), supplement = supplements[c.caseId] || { revision: 0, items: [] };
    const last = state.analyses.at(-1), confirmed = state.confirmations.findLast(x => x.revision === state.revision && x.supplementRevision === supplement.revision);
    cases.push({ ...c, images: await requirementImages(root, c, supplement), supplement, revision: state.revision,
      draft: state.draft, draftAnalysisId: state.draftAnalysisId || null,
      modelDraft: state.analyses.find(x => x.id === state.draftAnalysisId)?.parsed || null,
      needsReanalysis: !!c.needsReanalysis || (!!state.draft && state.draftSupplementRevision !== supplement.revision),
      analysis: last ? { id: last.id, status: last.status, error: last.error, elapsedMs: last.elapsedMs,
        proposedDraft: last.status === 'returned' && last.id !== state.draftAnalysisId && last.revision === state.revision && last.supplementRevision === supplement.revision ? last.parsed : null } : null,
      confirmation: confirmed ? { id: confirmed.id, by: confirmed.confirmedBy, at: confirmed.confirmedAt } : null,
      notes: notes[c.caseId] || [] });
  }
  return { run: manifest.run, cases, generationEnabled: false, scoringEnabled: false };
}
