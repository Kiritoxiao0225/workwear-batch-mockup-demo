import { mkdir, readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { configuredAnalyzer } from '../adapters/a-analysis.mjs';
import { assetPath, atomicFile, fail, hash, jsonFile, saveJSON } from '../adapters/a-files.mjs';
import { inspectImage, fontPath } from './b-input.mjs';
import { inspectEdgeContrast } from '../adapters/b-edge-facts.mjs';
import { canConfirm } from './a-review.mjs';
import { receiveConfirmedRequirement } from './b-intake.mjs';
import { planV2JSONSchema, backgroundJSONSchema, capabilitiesV2, cutoutParameters } from '../domain/b-plan-v2.mjs';
import { validatePlanV2, validateBackgroundDecision } from './b-validation-v2.mjs';

export async function readWorkbenchRequirement(root, caseId, expected = {}) {
  const manifest = await jsonFile(resolve(root, 'manifest.json')), c = manifest.cases.find(c => c.caseId === caseId);
  if (!c) throw fail('未找到需求', 404);
  const first = await jsonFile(resolve(root, 'results', caseId + '.json'), null);
  if (first?.status !== 'returned') throw fail('A尚未完整返回，不能开始B', 409);
  const review = (await jsonFile(resolve(root, 'reviews.json'), {}))[caseId];
  const supplement = (await jsonFile(resolve(root, 'supplements.json'), {}))[caseId] || { revision: 0, items: [] };
  const state = await jsonFile(resolve(root, 'a-state', caseId + '.json'), { analyses: [], confirmations: [] });
  if (state.analyses.some(a => a.status === 'running')) throw fail('A仍在重新识别，请等待返回', 409);
  if (supplement.revision && (!await canConfirm(root, caseId, supplement.revision) || review?.supplementRevision !== supplement.revision)) throw fail('补图尚未纳入当前A正文，先重新识别并采用保存', 409);
  const text = review?.text ?? first.parsed.standardizedRequirement;
  if (!text.trim()) throw fail('A正文为空', 409);
  for (const [key, actual] of [['expectedReviewRevision', review?.revision || 0], ['expectedSupplementRevision', supplement.revision], ['expectedTextSHA256', hash(text)]]) if (expected[key] !== undefined && expected[key] !== actual) throw fail('A正文或素材已变化，请刷新后再规划', 409);
  const confirmed = state.confirmations.findLast(x => x.text === text && x.reviewRevision === (review?.revision || 0) && x.supplementRevision === supplement.revision);
  let requirement;
  if (confirmed) requirement = (await receiveConfirmedRequirement(confirmed.receipt.input, a => readFile(assetPath(root, a)))).input;
  else {
    const images = c.images.map(i => ({ id: i.imageId, label: '图' + i.index, asset: i.asset, sha256: i.originalSHA256, bytes: i.originalBytes, target: '' }));
    supplement.items.forEach((i, n) => { if (!i.removedAt) images.push({ id: i.id, label: '图' + (c.images.length + n + 1), asset: i.asset, sha256: i.sha256, bytes: i.bytes, target: i.target }); });
    requirement = { schema: 'a-planning-draft-v1', caseId, sourceRecordId: c.sourceRecordId, sourceText: c.sourceText, sourceTextSHA256: hash(c.sourceText), text, textSHA256: hash(text), images, reviewRevision: review?.revision || 0, supplementRevision: supplement.revision, analysisId: review?.analysisId || first.responseId, promptSHA256: manifest.run.promptSHA256 };
  }
  if (requirement.textSHA256 !== hash(requirement.text)) throw fail('A正文版本校验失败', 409);
  return { requirement, authority: confirmed ? 'designer_confirmed' : 'draft_planning_only', reviewRevision: review?.revision || 0, supplementRevision: supplement.revision,
    upstreamIssues: (await jsonFile(resolve(root, 'qa-notes.json'), {}))[caseId] || [] };
}

export async function preparePlanV2Input(context, readAsset, target = null) {
  const { requirement } = context, bytes = new Map(), images = [];
  if (requirement.images.length > 32 || new Set(requirement.images.map(i => i.id)).size !== requirement.images.length) throw fail('图片数量或身份无效');
  if (target && (!Number.isInteger(target.width) || !Number.isInteger(target.height) || target.width < 64 || target.height < 64 || target.width > 8192 || target.height > 8192 || target.width * target.height > 40_000_000 || !target.basis)) throw fail('目标像素或依据无效');
  for (const i of requirement.images) {
    const b = await readAsset(i.asset);
    if (hash(b) !== i.sha256 || b.length !== i.bytes) throw fail('B实际图片与A版本不一致', 409);
    bytes.set(i.id, b); images.push({ id: i.id, label: i.label, ...await inspectImage(b), edgeContrast: await inspectEdgeContrast(b) });
  }
  const font = await readFile(fontPath);
  const input = { schema: 'b-input-v2', requirement: structuredClone(requirement), inputAuthority: context.authority,
    target, images, fonts: [{ id: 'douyin-sans', name: '抖音美好体', sha256: hash(font), boundary: '未指定时仅作为样式建议；不得冒充指定/参考字形' }],
    capabilities: capabilitiesV2, upstreamIssues: context.upstreamIssues || [], policyVersion: 'minimal-three-routes-20260914', phase: 'initial', cExecutionEnabled: false };
  return { input, bytes };
}

export async function buildPlanV2Request(input, bytes) {
  const prompt = (await readFile(new URL('./b-prompt-v2.txt', import.meta.url), 'utf8')).trimEnd();
  const content = [{ type: 'text', text: JSON.stringify({ input, outputSchema: planV2JSONSchema }) }];
  for (const i of input.requirement.images) {
    const data = bytes.get(i.id), facts = input.images.find(x => x.id === i.id);
    if (!data || hash(data) !== i.sha256) throw fail('B请求图片身份变化', 409);
    content.push({ type: 'text', text: JSON.stringify({ imageId: i.id, label: i.label, usage: i.target }) },
      { type: 'image_url', image_url: { url: `data:image/${facts.format};base64,${data.toString('base64')}`, detail: 'high' } });
  }
  return { model: 'gpt-5.6-sol', reasoning_effort: 'low', max_completion_tokens: 16000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: prompt }, { role: 'user', content }] };
}

export async function planWorkbenchCase(root, caseId, options = {}) {
  const context = await readWorkbenchRequirement(root, caseId, options);
  const previousIndex = await jsonFile(resolve(root, 'b-index', caseId + '.json'), null);
  const previous = previousIndex && await jsonFile(resolve(root, 'b-runs', previousIndex.runId, 'result.json'), null);
  if (previous && ['running', 'unknown'].includes(previous.status) && previous.aTextSHA256 === context.requirement.textSHA256 && previous.reviewRevision === context.reviewRevision && previous.supplementRevision === context.supplementRevision) return previous;
  const { input, bytes } = await preparePlanV2Input(context, a => readFile(assetPath(root, a)), options.target || null);
  const request = await buildPlanV2Request(input, bytes);
  let repairDepth = 0;
  if (!options.repairOf && previous?.inputSHA256 === hash(JSON.stringify(input)) && previous.promptSHA256 === hash(request.messages[0].content)) return previous;
  if (options.repairOf) {
    if (!/^[a-f0-9]{64}$/u.test(options.repairOf)) throw fail('修正来源无效');
    if (options.reviewEvidence !== undefined && (typeof options.reviewEvidence !== 'string' || options.reviewEvidence.length > 5000 || !options.reviewEvidence.trim())) throw fail('独立审查证据无效');
    const priorDir = resolve(root, 'b-runs', options.repairOf), prior = await jsonFile(resolve(priorDir, 'result.json'));
    repairDepth = (prior.repairDepth ?? (prior.repairOf ? 1 : 0)) + 1;
    const knownDefect = prior.status === 'invalid_output' || prior.status === 'planned' && options.reviewEvidence;
    if (!knownDefect || repairDepth > 2 || prior.caseId !== caseId || prior.aTextSHA256 !== input.requirement.textSHA256 || prior.reviewRevision !== context.reviewRevision || prior.supplementRevision !== context.supplementRevision) throw fail('只能针对同一A版本有具体错误证据的输出做明确修正，最多两轮', 409);
    const priorResponse = await jsonFile(resolve(priorDir, 'response.json'));
    request.messages.push({ role: 'assistant', content: priorResponse.rawContent }, { role: 'user', content: JSON.stringify({ action: '按具体证据修正上一次B规划', errors: prior.validation?.errors || [prior.error], independentReview: options.reviewEvidence || null, constraints: '只修复列出的错误，保留其他已正确路线与内容；A正文和图片完全不变，不另写制作prompt，不执行C。实际工具限制与outputSchema同前。返回最小修改后的完整b-plan-v2 JSON。',
      toolContract: {
        singleImageTools: 'reuse/enhance/cutout只允许一个role=content的输入。完整保留原图的字形/颜色/排版，可以写在同一content的usage中；不要把同一物理图片以四个角色重复传入这些工具。不要遗漏其他实际参考图片。',
        referenceBinding: 'references中的每个imageId+role必须实际进入步骤；本地排字可接layout/color参考，不可接font/content。',
        params: { reuse: ['crop'], 'render-text': ['text', 'fontId', 'fontAuthorizationQuote', 'styleProposal', 'color', 'layout'], compose: ['background', 'backgroundAuthorizationQuote', 'placements'], otherTools: '{}' },
        noBackgroundOperation: '没有抠图步骤时，background.timing=none，capabilityId=null，sourceStepId=null；sourceStepId不是最终输出的别名。',
      } }) });
  }
  const runId = hash(JSON.stringify(request)), dir = resolve(root, 'b-runs', runId);
  await mkdir(resolve(root, 'b-runs'), { recursive: true });
  try { await mkdir(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; return jsonFile(resolve(dir, 'result.json'), { runId, status: 'unknown', error: '相同输入已有请求，未重复调用' }); }
  const started = Date.now(), result = { schema: 'b-run-v2', caseId, runId, status: 'running', startedAt: new Date(started).toISOString(),
    aTextSHA256: input.requirement.textSHA256, inputSHA256: hash(JSON.stringify(input)), requestSHA256: runId, promptSHA256: hash(request.messages[0].content), inputAuthority: context.authority,
    reviewRevision: context.reviewRevision, supplementRevision: context.supplementRevision, model: request.model, effort: request.reasoning_effort, repairOf: options.repairOf || null, repairDepth, reviewEvidence: options.reviewEvidence || null, actualImageProduction: false, canExecuteC: false };
  await saveJSON(resolve(dir, 'input.json'), input); await saveJSON(resolve(dir, 'request.json'), request); await saveJSON(resolve(dir, 'result.json'), result);
  for (const i of input.requirement.images) await atomicFile(resolve(dir, 'images', i.sha256 + extname(i.asset)), bytes.get(i.id));
  await saveJSON(resolve(root, 'b-index', caseId + '.json'), { runId });
  let received = false;
  try {
    const analyze = await (options.analyzerFactory || configuredAnalyzer)(), response = await analyze(request); received = true;
    await saveJSON(resolve(dir, 'response.json'), response);
    Object.assign(result, { responseId: response.responseId, reportedModel: response.reportedModel, httpStatus: response.httpStatus, usage: response.usage });
    const plan = JSON.parse(response.rawContent);
    await saveJSON(resolve(dir, 'plan.json'), plan);
    const validation = await validatePlanV2(plan, input);
    Object.assign(result, { plan, validation, status: validation.valid ? (plan.artworks.some(a => a.blockedReason) ? 'blocked' : 'planned') : 'invalid_output' });
    const payload = { schema: 'b-to-c-v2', runId, input, plan, validation, generationRequirement: input.requirement.text, inputAuthority: context.authority, canExecute: false, pendingPhase: (Array.isArray(plan?.artworks) ? plan.artworks : []).filter(a => a?.background?.timing === 'after_generation').map(a => ({ artworkId: a.id, sourceStepId: a.background.sourceStepId })) };
    await saveJSON(resolve(dir, 'handoff.json'), { sha256: hash(JSON.stringify(payload)), payload });
  } catch (error) { result.status = received ? 'invalid_output' : 'unknown'; result.error = error.status ? error.message : received ? '规划返回格式或校验失败，原始响应已保留' : '请求结果未知，未自动重复调用'; }
  result.durationMs = Date.now() - started; result.finishedAt = new Date().toISOString();
  await saveJSON(resolve(dir, 'result.json'), result); return result;
}

export async function readPlanV2Handoff(dir) {
  const file = await jsonFile(resolve(dir, 'handoff.json')), result = await jsonFile(resolve(dir, 'result.json'));
  if (file.sha256 !== hash(JSON.stringify(file.payload)) || file.payload.runId !== result.runId || file.payload.input.requirement.textSHA256 !== hash(file.payload.generationRequirement) || hash(JSON.stringify(file.payload.input)) !== result.inputSHA256 || JSON.stringify(file.payload.plan) !== JSON.stringify(result.plan) || file.payload.canExecute !== false) throw fail('B交接内容已变化', 409);
  for (const i of file.payload.input.requirement.images) if (hash(await readFile(resolve(dir, 'images', i.sha256 + extname(i.asset)))) !== i.sha256) throw fail('B交接图片已变化', 409);
  return file.payload;
}

// B owns the bounded post-generation decision. This contract never generates or cuts an image.
export async function decideGeneratedBackground({ parentDir, artworkId, candidate, imageBytes, root, analyzerFactory = configuredAnalyzer }) {
  const parent = await readPlanV2Handoff(parentDir), artwork = parent.plan.artworks.find(a => a.id === artworkId);
  if (!parent.validation.valid || !artwork || artwork.background.timing !== 'after_generation' || candidate.parentRunId !== parent.runId || candidate.artworkId !== artworkId || candidate.sourceStepId !== artwork.background.sourceStepId || candidate.aTextSHA256 !== parent.input.requirement.textSHA256 || candidate.imageSHA256 !== hash(imageBytes)) throw fail('生成结果与当前图稿/版本不一致', 409);
  const facts = await inspectImage(imageBytes);
  const input = { schema: 'b-background-input-v1', parentRunId: parent.runId, requirement: parent.input.requirement, artwork, candidate, facts, capabilities: capabilitiesV2.filter(x => x.id.startsWith('cutout-')) };
  const request = { model: 'gpt-5.6-sol', reasoning_effort: 'low', response_format: { type: 'json_object' }, max_completion_tokens: 6000,
    messages: [{ role: 'system', content: '你只负责生成结果的背景处理决策。原样遵守A及当前图稿保护内容，不改需求、不改生成路线。检查实际生成图，结合Alpha事实决定skip/cutout/blocked；有透明通道不代表已抠干净，白字/白描边/内部底形可能是内容。不得靠想象保证质量。只在登记的三种抠图配置中选一种，不调用工具，不自动重试。仅返回符合outputSchema的JSON。' },
      { role: 'user', content: [{ type: 'text', text: JSON.stringify({ input, outputSchema: backgroundJSONSchema }) }, { type: 'image_url', image_url: { url: `data:image/${facts.format};base64,${imageBytes.toString('base64')}`, detail: 'high' } }] }] };
  const runId = hash(JSON.stringify(request)), dir = resolve(root, runId); await mkdir(root, { recursive: true });
  try { await mkdir(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; return jsonFile(resolve(dir, 'result.json'), { runId, status: 'unknown' }); }
  await saveJSON(resolve(dir, 'input.json'), input); await saveJSON(resolve(dir, 'request.json'), request); await atomicFile(resolve(dir, 'candidate.' + facts.format), imageBytes);
  const result = { runId, status: 'running', canExecute: false, parentRunId: parent.runId, candidateSHA256: candidate.imageSHA256 }; await saveJSON(resolve(dir, 'result.json'), result);
  let received = false;
  try { const analyze = await analyzerFactory(), response = await analyze(request); received = true; await saveJSON(resolve(dir, 'response.json'), response); const decision = JSON.parse(response.rawContent), validation = validateBackgroundDecision(decision, facts);
    Object.assign(result, { status: validation.valid ? 'decided' : 'invalid_output', decision, validation, execution: validation.valid && decision.action === 'cutout' ? { capabilityId: decision.capabilityId, params: cutoutParameters(decision.capabilityId), inputSHA256: candidate.imageSHA256 } : null });
  } catch { result.status = received ? 'invalid_output' : 'unknown'; }
  await saveJSON(resolve(dir, 'result.json'), result); return result;
}
