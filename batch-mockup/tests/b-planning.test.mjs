import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { hash, saveJSON } from '../adapters/a-files.mjs';
import { receiveConfirmedRequirement } from '../application/b-intake.mjs';
import { prepareBInput, inspectImage } from '../application/b-input.mjs';
import { validateBPlan } from '../application/b-validation.mjs';
import { buildPlanningRequest, planConfirmedRequirement, readCInput } from '../application/b-planning.mjs';

const output = { width: 1024, height: 1024, background: 'white', basis: '合同测试指定像素，不是产品默认值' };
const text = '图1完整Logo用于左胸。\n以抖音美好体在Logo上方制作弧形文字：\n教  练！';
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'b-planning-')); t.after(() => rm(root, { recursive: true, force: true }));
  const image = await sharp({ create: { width: 320, height: 200, channels: 4, background: '#ff0000' } }).png().toBuffer();
  const envelope = { schema: 'a-confirmed-v1', confirmationId: 'test-confirmation', confirmedBy: '合同测试员', confirmedAt: '2026-09-13T00:00:00Z',
    text, textSHA256: hash(text), sourceText: text, sourceTextSHA256: hash(text),
    images: [{ id: 'image1', label: '图1', asset: 'assets/one.png', sha256: hash(image), bytes: image.length, target: '左胸Logo' }] };
  const receipt = await receiveConfirmedRequirement(envelope, () => image);
  const prepared = await prepareBInput(receipt, () => image, output);
  const plan = { schema: 'b-plan-v1', imageAssessments: [{ imageId: 'image1', kind: 'artwork', region: null, observation: '完整Logo' }],
    artworks: [{ id: 'chest', requirementQuote: '图1完整Logo用于左胸。', applications: ['左胸'], outputStepId: 'white' }],
    steps: [{ id: 'logo', artworkId: 'chest', capabilityId: 'reuse', inputs: [{ kind: 'image', id: 'image1', role: 'content' }], params: {}, reason: '保持原图' },
      { id: 'words', artworkId: 'chest', capabilityId: 'render-text', inputs: [], params: { text: '教  练！', fontId: 'douyin-sans', fontAuthorizationQuote: '以抖音美好体在Logo上方制作弧形文字：', color: '#ff0000', layout: { kind: 'arc', align: 'center', degrees: 70, direction: 'up' } }, reason: '准确保留文字和空格' },
      { id: 'white', artworkId: 'chest', capabilityId: 'compose', inputs: [{ kind: 'step', id: 'logo', role: 'content' }, { kind: 'step', id: 'words', role: 'content' }],
        params: { background: 'white', placements: [{ inputId: 'logo', x: 192, y: 400, width: 640, height: 400 }, { inputId: 'words', x: 192, y: 100, width: 640, height: 200 }] }, reason: '弧形文字在Logo上方，白底' }], excludedImages: [], reviewNotes: [] };
  return { root, image, receipt, ...prepared, plan };
}
test('B1/B2原样传正文和所有原图，读取实际像素，API不给tools', async t => {
  const f = await fixture(t), req = await buildPlanningRequest(f.input, f.bytes);
  assert.equal(f.input.images[0].width, 320); assert.equal(f.input.images[0].hasTransparentPixels, false);
  const wire = JSON.parse(JSON.stringify(req)); assert.equal(JSON.parse(wire.messages[1].content[0].text).input.confirmation.text, text);
  assert.deepEqual(Buffer.from(wire.messages[1].content.at(-1).image_url.url.split(',')[1], 'base64'), f.image);
  assert.equal(wire.model, 'gpt-5.6-sol'); assert.equal(wire.reasoning_effort, 'low'); assert.equal(wire.tools, undefined);
});
test('像素：透明通道≠透明，真实透明/空白/损坏/假尺寸分别处理', async t => {
  const f = await fixture(t);
  const alpha = await sharp({ create: { width: 100, height: 50, channels: 4, background: '#00000000' } }).composite([{ input: await sharp(f.image).resize(20, 10).png().toBuffer(), left: 10, top: 5 }]).png().toBuffer();
  assert.deepEqual((await inspectImage(alpha)).alphaContentBounds, { x: 10, y: 5, width: 20, height: 10 });
  await assert.rejects(inspectImage(Buffer.from('broken')));
  await assert.rejects(inspectImage(await sharp({ create: { width: 10, height: 10, channels: 4, background: '#00000000' } }).png().toBuffer()));
  await assert.rejects(prepareBInput(f.receipt, () => f.image, { ...output, width: '3XL' }));
  await assert.rejects(prepareBInput(f.receipt, () => Buffer.from('changed'), output));
});
test('弧形文字+Logo合法计划；明确区分结构通过与C执行未验', async t => {
  const f = await fixture(t), result = await validateBPlan(f.plan, f.input);
  assert.deepEqual(result.errors, []); assert.equal(result.valid, true); assert.equal(result.executable, false); assert.equal(result.visualStatus, 'not_executed');
});
const faults = [
  ['不存在的工具', p => { p.steps[0].capabilityId = 'magic-tool'; }],
  ['漏绑图1', p => { p.steps[0].inputs = []; }],
  ['正文偷偷删空格', p => { p.steps[1].params.text = '教练！'; }],
  ['不存在的字体', p => { p.steps[1].params.fontId = 'unavailable'; }],
  ['字体授权伪造', p => { p.steps[1].params.fontAuthorizationQuote = '客户同意随便用字体'; }],
  ['环形依赖', p => { p.steps[0].inputs = [{ kind: 'step', id: 'white', role: 'content' }]; }],
  ['跨图稿串胸背', p => { p.steps[0].artworkId = 'back'; p.artworks.push({ id: 'back', requirementQuote: '左胸', applications: ['左胸'], outputStepId: 'white' }); }],
  ['多行弧形不支持', p => { p.steps[1].params.text = '教\n练'; }],
  ['裁切越界', p => { p.steps[0].params.crop = { x: 0.8, y: 0, width: 0.5, height: 1 }; }],
  ['字体参考贴到成品', p => { p.steps[2].inputs[0].role = 'font'; }],
  ['图层越界', p => { p.steps[2].params.placements[0].width = 2048; }],
  ['未使用的付费步骤', p => { p.steps.splice(2, 0, { ...structuredClone(p.steps[0]), id: 'unused', capabilityId: 'generate-cliproxy' }); }],
  ['偷偷添加供应商参数', p => { p.steps[0].params.prompt = 'other'; }],
];
for (const [name, mutate] of faults) test('B3拒绝：' + name, async t => { const f = await fixture(t); mutate(f.plan); assert.equal((await validateBPlan(f.plan, f.input)).valid, false); });
test('实际字体缺字被拒绝', async t => {
  const f = await fixture(t); f.input.confirmation.text += '🦄'; f.plan.steps[1].params.text = '🦄';
  assert.ok((await validateBPlan(f.plan, f.input)).errors.some(e => e.message.includes('缺字')));
});
test('纯文字缺少必要条件可明确阻塞，不能返回假空白成品', async t => {
  const f = await fixture(t);
  f.input.confirmation.images = []; f.input.images = []; f.plan.imageAssessments = []; f.plan.steps = [];
  f.plan.artworks[0].outputStepId = null; f.plan.artworks[0].blockedReason = '没有可用且符合指定字形的字体';
  const check = await validateBPlan(f.plan, f.input);
  assert.equal(check.valid, true); assert.equal(check.executable, false);
  delete f.plan.artworks[0].blockedReason; assert.equal((await validateBPlan(f.plan, f.input)).valid, false);
});
test('未指定字体可提出可见建议，但不能冒充已确认要求或直接执行', async t => {
  const f = await fixture(t); f.input.confirmation.text = f.input.confirmation.text.replace('以抖音美好体', '');
  const s = f.plan.steps[1]; delete s.params.fontAuthorizationQuote; s.params.styleProposal = true;
  f.plan.reviewNotes = ['建议使用抖音美好体及红色，仅供核对，不代表客户指定'];
  const v = await validateBPlan(f.plan, f.input); assert.equal(v.valid, true); assert.equal(v.executable, false);
  assert.ok(v.waiting.some(x => x.message.includes('制作建议')));
  f.plan.reviewNotes = []; assert.equal((await validateBPlan(f.plan, f.input)).valid, false);
});
test('无增强直接放大原图不能被当作高清合格；缩小复用不误报', async t => {
  const f = await fixture(t);
  assert.ok((await validateBPlan(f.plan, f.input)).waiting.some(e => e.message.includes('放大2.00倍')));
  f.plan.steps[2].params.placements[0].width = 320; f.plan.steps[2].params.placements[0].height = 200;
  assert.equal((await validateBPlan(f.plan, f.input)).waiting.some(e => e.message.includes('倍但')), false);
});
test('B4保存读回、重复提交只调用一次、旧确认/篡改图不能进入C', async t => {
  const f = await fixture(t); let calls = 0;
  const args = { receipt: f.receipt, readAsset: () => f.image, output, root: f.root,
    analyzerFactory: async () => async () => { calls++; return { rawContent: JSON.stringify(f.plan), httpStatus: 200, reportedModel: 'fixture-not-live' }; } };
  const [first, concurrent] = await Promise.all([planConfirmedRequirement(args), planConfirmedRequirement(args)]);
  const result = first.status === 'planned' ? first : concurrent;
  assert.equal(calls, 1); assert.equal(result.status, 'planned');
  const again = await planConfirmedRequirement(args); assert.equal(again.runId, result.runId); assert.equal(calls, 1);
  const dir = resolve(f.root, result.runId), received = await readCInput(dir, f.receipt);
  assert.equal(received.input.confirmation.text, text); assert.equal(received.canExecute, false);
  assert.deepEqual(received.plan, f.plan);
  await assert.rejects(readCInput(dir, { ...f.receipt, inputSHA256: 'old' }));
  await writeFile(resolve(dir, 'public/assets/one.png'), 'tampered'); await assert.rejects(readCInput(dir, f.receipt));
});
test('超时/坏JSON保存证据，不自动循环或重复付费', async t => {
  for (const mode of ['timeout', 'json']) {
    const f = await fixture(t); let calls = 0;
    const args = { receipt: f.receipt, readAsset: () => f.image, output, root: f.root,
      analyzerFactory: async () => async () => { calls++; if (mode === 'timeout') throw new Error('timeout'); return { rawContent: '{bad' }; } };
    const r = await planConfirmedRequirement(args); assert.equal(r.status, mode === 'timeout' ? 'unknown' : 'invalid_output');
    assert.equal((await planConfirmedRequirement(args)).status, r.status); assert.equal(calls, 1);
    assert.ok(await readFile(resolve(f.root, r.runId, 'request.json')));
  }
});
test('B交接包篡改不接受；未知运行回读不重新提交', async t => {
  const f = await fixture(t); const r = await planConfirmedRequirement({ receipt: f.receipt, readAsset: () => f.image, output, root: f.root,
    analyzerFactory: async () => async () => ({ rawContent: JSON.stringify(f.plan) }) });
  const dir = resolve(f.root, r.runId); await saveJSON(resolve(dir, 'handoff.json'), { sha256: 'bad', payload: {} });
  await assert.rejects(readCInput(dir, f.receipt));
});

test('透明原图直接复用、原尺寸输出，不强制白底或合成', async t => {
  const f = await fixture(t);
  const image = await sharp({ create: { width: 320, height: 200, channels: 4, background: '#00000000' } }).composite([{ input: f.image, left: 0, top: 0, blend: 'over' }]).extend({ left: 10, right: 10, top: 10, bottom: 10, background: '#00000000' }).png().toBuffer();
  const envelope = structuredClone(f.receipt.input); envelope.images[0].sha256 = hash(image); envelope.images[0].bytes = image.length;
  const receipt = await receiveConfirmedRequirement(envelope, () => image);
  const input = (await prepareBInput(receipt, () => image, { ...output, background: 'preserve', sizing: 'native' })).input;
  f.plan.steps = [f.plan.steps[0]]; f.plan.artworks[0].outputStepId = 'logo';
  const check = await validateBPlan(f.plan, input);
  assert.equal(check.valid, true); assert.equal(input.images[0].hasTransparentPixels, true);
  assert.equal(check.waiting.some(e => /画布尺寸|白底/.test(e.message)), false);
  const r = await planConfirmedRequirement({ receipt, readAsset: () => image, output: input.output, root: f.root,
    analyzerFactory: async () => async () => ({ rawContent: JSON.stringify(f.plan) }) });
  const received = await readCInput(resolve(f.root, r.runId), receipt);
  assert.equal(received.plan.steps.length, 1); assert.equal(received.plan.steps[0].capabilityId, 'reuse');
  assert.deepEqual(await readFile(resolve(f.root, r.runId, 'public/assets/one.png')), image);
});
test('默认背景禁止白底；明确白底导出允许且保留来源', async t => {
  const f = await fixture(t); f.input.output.background = 'preserve';
  assert.ok((await validateBPlan(f.plan, f.input)).errors.some(e => e.message.includes('禁止')));
  f.input.output.background = 'white'; assert.equal((await validateBPlan(f.plan, f.input)).valid, true);
  f.input.output.background = 'transparent'; assert.equal((await validateBPlan(f.plan, f.input)).valid, false);
});
test('透明组合和增强/抠图直接输出可规划，不冒充像素验收', async t => {
  const f = await fixture(t); f.input.output.background = 'preserve'; f.input.output.sizing = 'native';
  f.plan.steps[2].params.background = 'transparent';
  const composed = await validateBPlan(f.plan, f.input); assert.equal(composed.valid, true);
  assert.ok(composed.waiting.some(e => e.message.includes('图层背景')));
  for (const capabilityId of ['enhance-mediakit', 'cutout-meitu', 'generate-cliproxy']) {
    const plan = structuredClone(f.plan); plan.steps = [{ ...plan.steps[0], capabilityId }]; plan.artworks[0].outputStepId = 'logo';
    const v = await validateBPlan(plan, f.input); assert.equal(v.valid, true); assert.equal(v.executable, false);
  }
});
test('白底依据必须逐字引用；引用存在也须核对语义', async t => {
  const f = await fixture(t); f.input.output.background = 'preserve';
  f.plan.steps[2].params.backgroundAuthorizationQuote = '凭空要求白底';
  assert.equal((await validateBPlan(f.plan, f.input)).valid, false);
  f.input.confirmation.text += '\n另外导出白底成品'; f.plan.steps[2].params.backgroundAuthorizationQuote = '另外导出白底成品';
  const v = await validateBPlan(f.plan, f.input); assert.equal(v.valid, true); assert.equal(v.executable, false);
  assert.ok(v.waiting.some(e => e.message.includes('白底导出依据')));
});
test('原生尺寸与指定尺寸分开；精确尺寸不满足仍保留核验项', async t => {
  const f = await fixture(t); f.plan.steps = [f.plan.steps[0]]; f.plan.artworks[0].outputStepId = 'logo';
  f.input.output.background = 'preserve'; f.input.output.sizing = 'exact';
  assert.ok((await validateBPlan(f.plan, f.input)).waiting.some(e => e.message.includes('指定画布')));
  f.input.output.sizing = 'native'; assert.equal((await validateBPlan(f.plan, f.input)).waiting.some(e => e.message.includes('指定画布')), false);
  await assert.rejects(prepareBInput(f.receipt, () => f.image, { ...output, background: 'checkerboard' }));
});
test('本地排字允许排版/颜色参考，禁止把照片内容和参考字体当排字输入', async t => {
  const f = await fixture(t); const s = f.plan.steps[1];
  s.inputs = [{ kind: 'image', id: 'image1', role: 'layout' }];
  assert.equal((await validateBPlan(f.plan, f.input)).valid, true);
  s.inputs[0].role = 'color'; assert.equal((await validateBPlan(f.plan, f.input)).valid, true);
  for (const role of ['content', 'font']) { s.inputs[0].role = role; assert.equal((await validateBPlan(f.plan, f.input)).valid, false); }
});
