import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { hash, atomicFile, saveJSON, jsonFile } from '../adapters/a-files.mjs';
import { buildPlanV2Request, preparePlanV2Input, readWorkbenchRequirement, planWorkbenchCase, readPlanV2Handoff, decideGeneratedBackground } from '../application/b-v2.mjs';
import { validatePlanV2 } from '../application/b-validation-v2.mjs';
import { inspectEdgeContrast } from '../adapters/b-edge-facts.mjs';

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'b-v2-')); t.after(() => rm(root, { recursive: true, force: true }));
  const image = await sharp({ create: { width: 120, height: 80, channels: 4, background: '#147747' } }).extend({ left: 10, right: 10, top: 10, bottom: 10, background: '#00000000' }).png().toBuffer();
  const text = '左胸：图1完整Logo，加字“教  练！”；原文字及白描边保留。';
  const c = { caseId: 'T01', sourceRecordId: 'fixture:1:1', sourceText: text, images: [{ imageId: 'T01-1', index: 1, asset: 'assets/source.png', originalSHA256: hash(image), originalBytes: image.length }] };
  await atomicFile(resolve(root, 'public/assets/source.png'), image); await saveJSON(resolve(root, 'manifest.json'), { run: { promptSHA256: 'fixture' }, cases: [c] });
  await saveJSON(resolve(root, 'results/T01.json'), { status: 'returned', responseId: 'fixture-model', parsed: { standardizedRequirement: text, readingIssues: [] } });
  const context = await readWorkbenchRequirement(root, 'T01'), prepared = await preparePlanV2Input(context, () => image);
  const plan = { schema: 'b-plan-v2', imageAssessments: [{ imageId: 'T01-1', kind: 'artwork', region: null, observation: 'Logo及原有文字' }],
    artworks: [{ id: 'left-chest', name: '左胸图稿', requirementQuote: text, applications: ['左胸'], route: 'model_generate', reason: '图文整体生成', confidence: 'medium', uncertainties: ['字形待像素核对'],
      references: [{ imageId: 'T01-1', role: 'content', usage: '完整Logo' }], preserve: ['原文字和白描边'],
      steps: [{ id: 'generate', capabilityId: 'generate-cliproxy', inputs: [{ kind: 'image', id: 'T01-1', role: 'content' }], params: {}, reason: '完整参考生成' }],
      background: { timing: 'after_generation', action: 'await_image', capabilityId: null, sourceStepId: 'generate', reason: '等实际输出' },
      output: { stepId: 'generate', sizing: 'pending', width: null, height: null, background: 'preserve', basis: '生成后检查', whiteAuthorizationQuote: null }, blockedReason: null }], excludedImages: [], reviewNotes: [] };
  return { root, image, text, plan, context, ...prepared };
}
test('V2草稿规划不伪造人工确认，A原文图片逐字节进入真实请求形状', async t => {
  const f = await fixture(t), r = await buildPlanV2Request(f.input, f.bytes);
  const input = JSON.parse(r.messages[1].content[0].text).input;
  assert.equal(input.requirement.text, f.text); assert.equal(input.inputAuthority, 'draft_planning_only'); assert.equal(input.requirement.confirmedBy, undefined);
  assert.equal(input.target, null); assert.deepEqual(Buffer.from(r.messages[1].content.at(-1).image_url.url.split(',')[1], 'base64'), f.image);
  assert.equal(r.model, 'gpt-5.6-sol'); assert.equal(r.reasoning_effort, 'low'); assert.equal(r.tools, undefined);
  assert.equal((await validatePlanV2(f.plan, f.input)).valid, true);
});
const badCases = [
  ['先增强再生成', a => a.steps.unshift({ id: 'enhance', capabilityId: 'enhance-mediakit', inputs: a.steps[0].inputs, params: {}, reason: '多余增强' })],
  ['先抠图再生成', a => a.steps.unshift({ id: 'cut', capabilityId: 'cutout-meitu', inputs: a.steps[0].inputs, params: {}, reason: '多余抠图' })],
  ['生成前写死抠图', a => { a.background.capabilityId = 'cutout-meitu'; }],
  ['隐藏另一份prompt', a => { a.steps[0].params.prompt = '改写后的秘密提示词'; }],
  ['跨图稿串图', a => { a.steps[0].inputs = [{ kind: 'step', id: 'another-artwork', role: 'content' }]; }],
  ['引用虚构A文案', a => { a.requirementQuote = '不存在的要求'; }],
  ['默认加白底', a => { a.output.background = 'white'; }],
  ['图号仅写说明', a => { a.steps[0].inputs = []; }],
  ['没有阻塞原因的空计划', a => { a.steps = []; a.output.stepId = null; }],
  ['同一图稿重复生成', a => { a.steps.push({ ...a.steps[0], id: 'second' }); a.output.stepId = 'second'; }],
];
for (const [name, mutate] of badCases) test('V2拒绝'+name, async t => { const f = await fixture(t); mutate(f.plan.artworks[0]); assert.equal((await validatePlanV2(f.plan, f.input)).valid, false); });
test('透明原稿直接复用，无强制白底/2048/生成/重复抠图', async t => {
  const f = await fixture(t), a = f.plan.artworks[0]; a.route = 'preserve_asset'; a.steps[0].id = 'reuse'; a.steps[0].capabilityId = 'reuse';
  a.output.stepId = 'reuse'; a.output.sizing = 'native'; a.background = { timing: 'none', action: 'reuse_alpha', capabilityId: null, sourceStepId: null, reason: '保留原透明图' };
  assert.equal((await validatePlanV2(f.plan, f.input)).valid, true);
  f.input.images[0].hasTransparentPixels = false; assert.equal((await validatePlanV2(f.plan, f.input)).valid, false);
});
test('本地精确文字与组合：空格保留，字体建议可见，参考字体不得当普通排字输入', async t => {
  const f = await fixture(t), a = f.plan.artworks[0]; a.route = 'local_render'; a.references = []; f.plan.excludedImages = [{ imageId: 'T01-1', reason: '仅测试独立文字合同，非此客户完成稿' }];
  a.steps = [{ id: 'words', capabilityId: 'render-text', inputs: [], params: { text: '教  练！', fontId: 'douyin-sans', styleProposal: true, color: '#ffffff', layout: { kind: 'arc', align: 'center', degrees: 60, direction: 'up' } }, reason: '精确文字' }];
  a.output.stepId = 'words'; a.background = { timing: 'none', action: 'not_applicable', capabilityId: null, sourceStepId: null, reason: '排字透明图层' }; f.plan.reviewNotes = ['建议抖音美好体，未获客户指定'];
  assert.equal((await validatePlanV2(f.plan, f.input)).valid, true);
  a.steps[0].params.text = '教练！'; assert.equal((await validatePlanV2(f.plan, f.input)).valid, false);
});
test('同输入并发/回读只调用一次；旧正文/补图不能直接用于新计划', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { analyzerFactory: async () => async () => { calls++; return { rawContent: JSON.stringify(f.plan), responseId: 'fixture-only', httpStatus: 200 }; } };
  const rr = await Promise.all([planWorkbenchCase(f.root, 'T01', options), planWorkbenchCase(f.root, 'T01', options)]);
  const r = rr.find(x => x.status === 'planned'); assert.ok(r); assert.equal(calls, 1); assert.equal((await planWorkbenchCase(f.root, 'T01', options)).runId, r.runId); assert.equal(calls, 1);
  const h = await readPlanV2Handoff(resolve(f.root, 'b-runs', r.runId)); assert.equal(h.generationRequirement, f.text); assert.equal(h.canExecute, false);
  await assert.rejects(readWorkbenchRequirement(f.root, 'T01', { expectedTextSHA256: 'old' }));
  await saveJSON(resolve(f.root, 'supplements.json'), { T01: { revision: 1, items: [] } }); await assert.rejects(readWorkbenchRequirement(f.root, 'T01'), /补图/);
});
test('未知响应不重新付费，非法JSON不冒充有效计划', async t => {
  for (const broken of ['timeout', 'json']) { const f = await fixture(t); let calls = 0; const options = { analyzerFactory: async () => async () => { calls++; if (broken === 'timeout') throw Error('timeout'); return { rawContent: '{bad' }; } };
    assert.equal((await planWorkbenchCase(f.root, 'T01', options)).status, broken === 'timeout' ? 'unknown' : 'invalid_output'); await planWorkbenchCase(f.root, 'T01', options); assert.equal(calls, 1); }
});
test('生成后B仅选择抠图：绑定实际候选，拒绝旧版本，白字保护交给具体配置，无C调用', async t => {
  const f = await fixture(t), r = await planWorkbenchCase(f.root, 'T01', { analyzerFactory: async () => async () => ({ rawContent: JSON.stringify(f.plan) }) });
  const parentDir = resolve(f.root, 'b-runs', r.runId), root = resolve(f.root, 'background'); let calls = 0;
  const candidate = { parentRunId: r.runId, artworkId: 'left-chest', sourceStepId: 'generate', aTextSHA256: hash(f.text), imageSHA256: hash(f.image) };
  const args = { parentDir, root, artworkId: 'left-chest', candidate, imageBytes: f.image, analyzerFactory: async () => async req => { calls++; assert.equal(JSON.parse(req.messages[1].content[0].text).input.requirement.text, f.text); return { rawContent: JSON.stringify({ schema: 'b-background-v1', action: 'cutout', capabilityId: 'cutout-mediakit-general', reason: 'fixture only', preserve: ['白描边'], confidence: 'medium', uncertainties: [] }) }; } };
  const decision = await decideGeneratedBackground(args); assert.equal(decision.status, 'decided'); assert.equal(decision.canExecute, false); assert.equal(decision.execution.params.scene, 'general'); assert.equal(decision.execution.inputSHA256, hash(f.image));
  await decideGeneratedBackground(args); assert.equal(calls, 1);
  await assert.rejects(decideGeneratedBackground({ ...args, candidate: { ...candidate, aTextSHA256: 'old' } }));
  const path = resolve(parentDir, 'handoff.json'), h = await jsonFile(path); h.payload.generationRequirement += '改写'; await saveJSON(path, h); await assert.rejects(readPlanV2Handoff(parentDir));
});
test('完整原图任何字节变化均拒绝', async t => { const f = await fixture(t); await atomicFile(resolve(f.root, 'public/assets/source.png'), Buffer.from('bad')); await assert.rejects(planWorkbenchCase(f.root, 'T01'), /图片/); assert.ok(await readFile(resolve(f.root, 'manifest.json'))); });

test('已知无效输出可明确修正，原始错误不覆盖，回读不回退或再次付费', async t => {
  const f = await fixture(t); let calls = 0;
  const invalid = structuredClone(f.plan); invalid.artworks[0].background.capabilityId = 'cutout-meitu';
  const original = await planWorkbenchCase(f.root, 'T01', { analyzerFactory: async () => async () => { calls++; return { rawContent: JSON.stringify(invalid) }; } });
  assert.equal(original.status, 'invalid_output');
  const options = { repairOf: original.runId, analyzerFactory: async () => async request => {
    calls++; assert.equal(request.messages[2].content, JSON.stringify(invalid));
    assert.ok(JSON.parse(request.messages[3].content).errors.length);
    assert.equal(JSON.parse(request.messages[1].content[0].text).input.requirement.text, f.text);
    return { rawContent: JSON.stringify(f.plan) };
  } };
  const repaired = await planWorkbenchCase(f.root, 'T01', options);
  assert.equal(repaired.status, 'planned'); assert.equal(repaired.repairOf, original.runId);
  assert.equal((await jsonFile(resolve(f.root, 'b-runs', original.runId, 'result.json'))).status, 'invalid_output');
  assert.equal((await planWorkbenchCase(f.root, 'T01', options)).runId, repaired.runId);
  assert.equal((await planWorkbenchCase(f.root, 'T01')).runId, repaired.runId); assert.equal(calls, 2);
  await assert.rejects(planWorkbenchCase(f.root, 'T01', { repairOf: repaired.runId }), /明确修正/);
});

test('有具体证据的语义纠正最多两轮；不能变成无界Agent重试', async t => {
  const f = await fixture(t), options = { analyzerFactory: async () => async () => ({ rawContent: JSON.stringify(f.plan) }) };
  const first = await planWorkbenchCase(f.root, 'T01', options);
  const second = await planWorkbenchCase(f.root, 'T01', { ...options, repairOf: first.runId, reviewEvidence: '独立查看原图发现路线依据不足，请核对' });
  const third = await planWorkbenchCase(f.root, 'T01', { ...options, repairOf: second.runId, reviewEvidence: '仅测试有界纠正合同，非真实语义通过' });
  assert.equal(third.repairDepth, 2);
  await assert.rejects(planWorkbenchCase(f.root, 'T01', { ...options, repairOf: third.runId, reviewEvidence: '不能继续自动付费' }), /最多两轮/);
});

test('边缘像素提示区分触边与有留白，不改图、不据此自动决定路线', async () => {
  const make = async left => sharp({ create: { width: 120, height: 100, channels: 4, background: '#003377' } })
    .composite([{ input: await sharp({ create: { width: 30, height: 30, channels: 4, background: '#ffffff' } }).png().toBuffer(), left, top: 30 }]).png().toBuffer();
  const touching = await make(90), originalSHA = hash(touching), contained = await make(50);
  const hint = await inspectEdgeContrast(touching);
  assert.deepEqual(hint.edges.map(e => e.side), ['right']); assert.equal(hash(touching), originalSHA);
  assert.deepEqual((await inspectEdgeContrast(contained)).edges, []); assert.equal(hint.route, undefined);
  const alpha = await sharp({ create: { width: 100, height: 100, channels: 4, background: '#00000000' } }).png().toBuffer();
  assert.equal((await inspectEdgeContrast(alpha)).applicable, false);
  const tiny = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer();
  assert.equal((await inspectEdgeContrast(tiny)).applicable, false);
});
