import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { assetPath, atomicFile, fail, hash, jsonFile, saveJSON } from '../adapters/a-files.mjs';
import { configuredAnalyzer } from '../adapters/a-analysis.mjs';
import { receiveConfirmedRequirement } from './b-intake.mjs';

const statePath = (root, caseId) => resolve(root, 'a-state', `${caseId}.json`);
export const readAState = (root, caseId) => jsonFile(statePath(root, caseId), { analyses: [], confirmations: [] });
const save = (root, caseId, state) => saveJSON(statePath(root, caseId), state);
const stamp = () => new Date().toISOString();
const checkId = value => { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/u.test(value)) throw fail('操作标识无效'); };
async function context(root, manifest, body) {
  const c = manifest.cases.find(c => c.caseId === body?.caseId);
  if (!c) throw fail('未找到这条需求', 404);
  const scope = await jsonFile(resolve(root, 'scope.json'), null);
  if (scope && scope.cases[c.caseId]?.stage !== 'first_generation') throw fail('本轮只处理首次制作', 409);
  const review = (await jsonFile(resolve(root, 'reviews.json'), {}))[c.caseId];
  const supplement = (await jsonFile(resolve(root, 'supplements.json'), {}))[c.caseId] || { revision: 0, items: [] };
  if (body.reviewRevision !== (review?.revision || 0) || body.supplementRevision !== supplement.revision) throw fail('正文或素材已更新，请刷新后核对当前内容', 409);
  return { c, review, supplement };
}
async function imagesFor(root, c, supplement) {
  const images = [];
  for (const img of c.images) images.push({ id: img.imageId, label: `图${img.index}`, index: img.index, asset: img.asset,
    sha256: img.originalSHA256, bytes: img.originalBytes, width: img.width, height: img.height, mime: extname(img.asset).toLowerCase() === '.jpg' || extname(img.asset).toLowerCase() === '.jpeg' ? 'image/jpeg' : `image/${extname(img.asset).slice(1).toLowerCase()}`, source: 'original', target: '' });
  // Numbers never shift when an earlier supplemental image is removed.
  for (const [i, img] of supplement.items.entries()) if (!img.removedAt) images.push({
    id: img.id, label: `图${c.images.length + i + 1}`, index: c.images.length + i + 1, asset: img.asset,
    sha256: img.sha256, bytes: img.bytes, width: img.width, height: img.height,
    mime: extname(img.asset) === '.jpg' ? 'image/jpeg' : `image/${extname(img.asset).slice(1)}`, source: 'designer_upload', target: img.target,
  });
  for (const img of images) {
    const bytes = await readFile(assetPath(root, img.asset));
    if (hash(bytes) !== img.sha256 || bytes.length !== img.bytes) throw fail(`${img.label}文件与保存记录不一致`, 409);
    // Stable immutable copy; future uploads/edits never alter past jobs or B inputs.
    const asset = `confirmed-assets/${img.sha256}${extname(img.asset).toLowerCase()}`;
    await atomicFile(assetPath(root, asset), bytes);
    img.asset = asset;
  }
  return images;
}
export async function recoverAnalyses(root, manifest) {
  for (const c of manifest.cases) {
    const state = await readAState(root, c.caseId); let changed = false;
    for (const a of state.analyses) if (a.status === 'running') { a.status = 'unknown'; a.error = '服务曾中断，API结果未知；未自动重发。可保留当前正文，查清后再操作。'; a.finishedAt = stamp(); changed = true; }
    if (changed) await save(root, c.caseId, state);
  }
}
export async function reserveAnalysis(root, manifest, body, analyzerFactory = configuredAnalyzer) {
  checkId(body?.requestId);
  const c = manifest.cases.find(c => c.caseId === body?.caseId);
  if (!c) throw fail('未找到需求', 404);
  const state = await readAState(root, c.caseId);
  const prior = state.analyses.find(a => a.id === body.requestId);
  if (prior) return { analysis: prior }; // An uncertain client response must not trigger another paid call.
  const { review, supplement } = await context(root, manifest, body);
  const initial = await jsonFile(resolve(root, 'results', c.caseId + '.json'), null);
  if (initial?.status === 'running') throw fail('本条首次识别仍在执行，请等待返回后再操作', 409);
  if (state.analyses.some(a => a.status === 'running')) throw fail('本条正在识别，请等待结果', 409);
  if (state.analyses.some(a => a.status === 'unknown' && a.supplementRevision === supplement.revision && a.reviewRevision === (review?.revision || 0))) throw fail('该输入已有结果未知的请求，不能直接重复付费调用', 409);
  const analyzer = await analyzerFactory();
  const prompt = (await readFile(resolve(root, 'prompt.txt'), 'utf8')).trimEnd();
  if (hash(prompt) !== manifest.run.promptSHA256) throw fail('本批提示词与已定稿版本不一致', 409);
  const images = await imagesFor(root, c, supplement);
  const input = { 原始需求: c.sourceText, 图片数量: images.length, 图片用途: images.map(i => ({ 图号: i.label, 用途: i.target || '原始附件，结合原文与全部图像理解' })) };
  if (review) input.设计师已保存正文 = review.text;
  const content = [{ type: 'text', text: JSON.stringify(input) }];
  if (review) content.push({ type: 'text', text: '以上设计师已保存正文是人工修订依据。结合补图更新需求时保留人工明确的文字、颜色、位置和版本修正；冲突放入readingIssues。输出供设计师再次核对，不代表自动替换已保存正文。' });
  for (const img of images) content.push({ type: 'text', text: `${img.label}（${img.width}×${img.height}）：` },
    { type: 'image_url', image_url: { url: `data:${img.mime};base64,${(await readFile(assetPath(root, img.asset))).toString('base64')}`, detail: 'high' } });
  const request = { model: 'gpt-5.6-sol', reasoning_effort: 'low', max_completion_tokens: 16000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: prompt }, { role: 'user', content }] };
  const analysis = { id: body.requestId, status: 'running', startedAt: stamp(), reviewRevision: review?.revision || 0, supplementRevision: supplement.revision,
    promptSHA256: hash(prompt), requestSHA256: hash(JSON.stringify(request)), images, sourceTextSHA256: hash(c.sourceText), model: request.model, effort: request.reasoning_effort };
  await saveJSON(resolve(root, 'analysis-evidence', c.caseId, `${analysis.id}-request.json`), request);
  state.analyses.push(analysis); await save(root, c.caseId, state);
  return { analysis, execute: () => analyzer(request) };
}
export async function finishAnalysis(root, caseId, id, result, error) {
  const state = await readAState(root, caseId), a = state.analyses.find(a => a.id === id);
  if (!a || a.status !== 'running') return;
  a.finishedAt = stamp(); a.elapsedMs = Date.parse(a.finishedAt) - Date.parse(a.startedAt);
  if (error) { a.status = error.status ? 'failed' : 'unknown'; a.error = error.status ? error.message : '连接或响应处理异常，结果未知；未自动重试。'; }
  else {
    await saveJSON(resolve(root, 'analysis-evidence', caseId, `${id}-response.json`), result);
    Object.assign(a, result);
    try {
      const parsed = JSON.parse(result.rawContent);
      if (typeof parsed?.standardizedRequirement !== 'string' || !parsed.standardizedRequirement.trim() || parsed.standardizedRequirement.length > 40000 ||
          !Array.isArray(parsed.readingIssues) || parsed.readingIssues.some(i => typeof i?.scope !== 'string' || typeof i?.issue !== 'string') ||
          Object.keys(parsed).some(k => !['standardizedRequirement', 'readingIssues'].includes(k))) throw new Error();
      a.parsed = parsed; a.status = 'returned';
    } catch { a.status = 'invalid_output'; a.error = '模型返回格式无效；原文保留，当前正文未替换。'; }
  }
  await save(root, caseId, state);
}
export async function acceptAnalysis(root, manifest, body) {
  const { c, review, supplement } = await context(root, manifest, body), state = await readAState(root, c.caseId);
  const a = state.analyses.find(a => a.id === body.analysisId);
  if (!a || a.status !== 'returned' || a.supplementRevision !== supplement.revision || a.reviewRevision !== (review?.revision || 0)) throw fail('新结果基于旧正文或旧素材，请保留当前修改并重新识别', 409);
  // Return a proposed draft only. Accepted input provenance is committed by explicit review save.
  return { text: a.parsed.standardizedRequirement, analysisId: a.id };
}
export async function canConfirm(root, caseId, supplementRevision) {
  if (!supplementRevision) return true;
  const state = await readAState(root, caseId);
  const review = (await jsonFile(resolve(root, 'reviews.json'), {}))[caseId];
  const a = state.analyses.find(a => a.id === review?.analysisId);
  return a?.status === 'returned' && a.supplementRevision === supplementRevision;
}
export async function confirmRequirement(root, manifest, body) {
  checkId(body?.requestId);
  const c0 = manifest.cases.find(c => c.caseId === body?.caseId);
  if (!c0) throw fail('未找到需求', 404);
  const state = await readAState(root, c0.caseId);
  const prior = state.confirmations.find(x => x.confirmationId === body.requestId);
  if (prior) {
    if (prior.text !== body.text || prior.reviewRevision !== body.reviewRevision || prior.supplementRevision !== body.supplementRevision || prior.confirmedBy !== body.confirmedBy) throw fail('确认标识已用于另一份内容', 409);
    return prior;
  }
  const { c, review, supplement } = await context(root, manifest, body);
  if (!review || !review.text.trim() || review.text !== body.text) throw fail('请先保存要确认的完整正文', 409);
  if (typeof body.confirmedBy !== 'string' || !body.confirmedBy.trim() || body.confirmedBy.length > 80) throw fail('请填写本地核对人名称');
  if ((supplement.revision && (review.supplementRevision !== supplement.revision || !review.analysisId)) || !await canConfirm(root, c.caseId, supplement.revision)) throw fail('素材已变化，请重新识别、采用结果并核对后再确认', 409);
  if (state.analyses.some(a => a.status === 'running')) throw fail('本条仍在重新识别，请等待结果', 409);
  const initial = await jsonFile(resolve(root, 'results', `${c.caseId}.json`), null);
  if (!review.analysisId && initial?.status !== 'returned') throw fail('尚未取得有效的需求理解结果', 409);
  const images = await imagesFor(root, c, supplement);
  const scope = await jsonFile(resolve(root, 'scope.json'), null);
  if (!images.length && scope?.cases[c.caseId]?.missingMaterial) throw fail('本条缺少所需素材，请先补图再核对', 409);
  const envelope = { schema: 'a-confirmed-v1', confirmationId: body.requestId, caseId: c.caseId, runId: manifest.run.id,
    sourceRecordId: c.sourceRecordId || null, sourceText: c.sourceText, sourceTextSHA256: hash(c.sourceText),
    text: review.text, textSHA256: hash(review.text), images, reviewRevision: review.revision, supplementRevision: supplement.revision,
    analysisId: review.analysisId || null, promptSHA256: manifest.run.promptSHA256,
    confirmedBy: body.confirmedBy.trim(), confirmedAt: stamp(), actorSource: 'local_self_reported' };
  const receipt = await receiveConfirmedRequirement(envelope, asset => readFile(assetPath(root, asset)));
  const confirmed = { ...envelope, receipt };
  // Confirmation and B receipt are committed together, never a half-saved handoff.
  state.confirmations.push(confirmed); await save(root, c.caseId, state);
  return confirmed;
}
export async function readBInput(root, manifest, caseId, confirmationId) {
  if (!manifest.cases.some(c => c.caseId === caseId)) throw fail('未找到需求', 404);
  const state = await readAState(root, caseId), confirmed = state.confirmations.find(c => c.confirmationId === confirmationId);
  if (!confirmed) throw fail('未找到人工确认记录，不能接收草稿', 404);
  if (hash(JSON.stringify(confirmed.receipt.input)) !== confirmed.receipt.inputSHA256) throw fail('接收记录校验失败', 409);
  await receiveConfirmedRequirement(confirmed.receipt.input, asset => readFile(assetPath(root, asset)));
  return confirmed.receipt;
}
