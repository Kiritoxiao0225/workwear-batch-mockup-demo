import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { hash, saveJSON, atomicFile } from '../adapters/a-files.mjs';
import { reserveProduction, executeProduction } from '../application/production.mjs';
import { stepAttempts } from '../runtime/service.mjs';

// 图稿生成「输出规格」: the 1K drawing size sent to the generator, then the Volcengine upscale.
const prompt = '【图稿】\n\n主体：使用图1的盾牌图形。\n\n文字：安全第一\n\n字体：沿用。\n\n颜色：沿用。\n\n排版：原样。\n\n尺寸：未指定。\n\n输出：独立图稿。';
async function fixture(t, artwork) {
  const root = await mkdtemp(resolve(tmpdir(), 'production-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 图1 is portrait 2:3, so 原比例 draws at 832×1248.
  const reference = await sharp({ create: { width: 60, height: 90, channels: 3, background: '#fff' } }).png().toBuffer();
  const images = [{ imageId: 'T-1', index: 1, asset: 'assets/T-1.png', originalSHA256: hash(reference), originalBytes: reference.length, width: 60, height: 90 }];
  await atomicFile(resolve(root, 'public', images[0].asset), reference);
  const draft = { artworks: [{ id: 'a1', name: '图稿', route: 'generate', applications: [], imageIds: ['T-1'], prompt, ...artwork }], readingIssues: [] };
  const manifest = { run: {}, cases: [{ caseId: 'T', sourceText: '原文', images }] };
  await saveJSON(resolve(root, 'requirements-state/T.json'), { revision: 1, draft, draftSupplementRevision: 0, analyses: [], confirmations: [] });
  const [job] = await reserveProduction(root, manifest, [{ caseId: 'T', revision: 1, supplementRevision: 0 }]);
  return { root, job };
}
const drawn = (width, height, background = '#3a6') => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
// A white square on a clear canvas, as a cut-out logo comes back.
const logo = async (size) => sharp({ create: { width: size, height: size, channels: 4, background: '#0000' } })
  .composite([{ input: await sharp({ create: { width: size / 2, height: size / 2, channels: 4, background: '#fff' } }).png().toBuffer(), left: size / 4, top: size / 4 }]).png().toBuffer();
const doubler = (calls) => async (input) => { calls.push(input.path); const m = await sharp(input.path).metadata(); return sharp(input.path).resize(m.width * 2, m.height * 2).jpeg().toBuffer(); };

test('2:3 · 2K：按 832×1248 生图，火山放大一次，交付 1365×2048，原图同尺寸以便修补', async t => {
  const { root, job } = await fixture(t, { transparentBackground: false, output: { ratio: '2:3', resolution: '2K' } });
  assert.deepEqual(job.output, { ratio: '2:3', resolution: '2K' });
  let size; const passes = [];
  const r = await executeProduction(root, job.id, { generate: async input => { size = input.size; return drawn(832, 1248); }, enhance: doubler(passes) });
  assert.equal(r.status, 'returned');
  assert.equal(size, '832x1248');
  assert.equal(passes.length, 1);
  assert.deepEqual([r.final.width, r.final.height], [1365, 2048]);
  assert.deepEqual([r.raw.width, r.raw.height], [1365, 2048]);
  assert.deepEqual([r.base.final.width, r.base.final.height], [832, 1248]);
  assert.deepEqual(r.upscale, { resolution: '2K', width: 1365, height: 2048, passes: 1 });
  assert.deepEqual(r.steps.map(s => s.name), ['generate', 'upscale-1']);
  assert.equal(r.warning, undefined);
});

test('原比例跟随图1；4K 放大两次，长边 4096', async t => {
  const { root, job } = await fixture(t, { transparentBackground: false, output: { ratio: 'original', resolution: '4K' } });
  let size; const passes = [];
  const r = await executeProduction(root, job.id, { generate: async input => { size = input.size; return drawn(832, 1248); }, enhance: doubler(passes) });
  assert.equal(r.status, 'returned');
  assert.equal(size, '832x1248');
  assert.equal(passes.length, 2);
  assert.deepEqual([r.final.width, r.final.height], [2731, 4096]);
});

test('透明图放大后外围仍然透明', async t => {
  const { root, job } = await fixture(t, { transparentBackground: true, output: { ratio: '1:1', resolution: '2K' } });
  const passes = [];
  const r = await executeProduction(root, job.id, { generate: async () => drawn(1024, 1024, '#fff'), cutout: async () => logo(1024), enhance: doubler(passes) });
  assert.equal(r.status, 'returned');
  assert.deepEqual([r.final.width, r.final.height], [2048, 2048]);
  assert.equal(r.final.transparentExterior, true);
  const { data } = await sharp(await readFile(resolve(root, 'public', r.final.asset))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[3], 0, '角落透明');
  assert.equal(data[(1024 * 2048 + 1024) * 4 + 3], 255, '中心不透明');
});

test('火山放大失败：不重新生图，直接按比例放大到目标尺寸并提示', async t => {
  const { root, job } = await fixture(t, { transparentBackground: false, output: { ratio: '3:2', resolution: '2K' } });
  let generated = 0;
  const r = await executeProduction(root, job.id, {
    generate: async () => { generated++; return drawn(1248, 832); },
    enhance: async () => { throw Object.assign(new Error('火山高清enhance返回HTTP 400'), { definiteFailure: true }); },
  });
  assert.equal(r.status, 'returned');
  assert.equal(generated, 1);
  assert.deepEqual([r.final.width, r.final.height], [2048, 1365]);
  assert.match(r.warning, /火山高清放大没成功/);
  assert.match(r.upscale.fallback, /HTTP 400/);
});

test('没有输出规格的旧需求：模型自定尺寸、不放大', async t => {
  const { root, job } = await fixture(t, { transparentBackground: false });
  assert.equal(job.output, undefined);
  let size = 'unset';
  const r = await executeProduction(root, job.id, { generate: async input => { size = input.size; return drawn(1024, 1536); }, enhance: async () => { throw new Error('不应放大'); } });
  assert.equal(r.status, 'returned');
  assert.equal(size, undefined);
  assert.deepEqual([r.final.width, r.final.height], [1024, 1536]);
  assert.equal(r.upscale, undefined);
});

// 放大到 2K/4K on a finished picture: the 无损放大 route with a size, from the picture's own size.
async function enhanceFixture(t, width, height, resolution) {
  const root = await mkdtemp(resolve(tmpdir(), 'production-enhance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await drawn(width, height);
  const images = [{ imageId: 'E-1', index: 1, asset: 'assets/E-1.png', originalSHA256: hash(source), originalBytes: source.length, width, height }];
  await atomicFile(resolve(root, 'public', images[0].asset), source);
  const draft = { artworks: [{ id: 'artwork', name: '图稿 · ' + resolution, route: 'enhance', transparentBackground: false, applications: [], imageIds: ['E-1'],
    output: { ratio: 'original', resolution }, prompt: '【图稿】\n\n主体：使用图1完整图稿，只提升清晰度。\n\n文字：沿用。\n\n字体：沿用。\n\n颜色：沿用。\n\n排版：原样。\n\n尺寸：未指定。\n\n输出：独立图稿。' }], readingIssues: [] };
  const manifest = { run: {}, cases: [{ caseId: 'E', sourceText: '放大', images }] };
  await saveJSON(resolve(root, 'requirements-state/E.json'), { revision: 1, draft, draftSupplementRevision: 0, analyses: [], confirmations: [] });
  const [job] = await reserveProduction(root, manifest, [{ caseId: 'E', revision: 1, supplementRevision: 0 }]);
  return { root, job };
}

test('放大到 4K：2K 成品放大一次到 3044×4096，不先走旧的单次高清', async t => {
  const { root, job } = await enhanceFixture(t, 1522, 2048, '4K');
  const passes = [];
  const r = await executeProduction(root, job.id, { generate: () => { throw new Error('不应生图'); }, enhance: doubler(passes) });
  assert.equal(r.status, 'returned');
  assert.equal(passes.length, 1);
  assert.deepEqual([r.final.width, r.final.height], [3044, 4096]);
  assert.deepEqual(r.steps.map(s => s.name), ['upscale-1']);
});

test('放大到 2K：已经是 2K 的图原样交付，不调用放大', async t => {
  const { root, job } = await enhanceFixture(t, 1522, 2048, '2K');
  const r = await executeProduction(root, job.id, { enhance: async () => { throw new Error('不应放大'); } });
  assert.equal(r.status, 'returned');
  assert.deepEqual([r.final.width, r.final.height], [1522, 2048]);
  assert.equal(r.upscale.passes, 0);
});

// Settlement: 「放大到 2K/4K」 bills one 无损放大 per click; the generate route's upscale stays at 1K.
const billed = job => stepAttempts(job).map(a => [a.action, a.certain]);

test('计费 · 放大到 2K：火山一次，收一次无损放大', async t => {
  const { root, job } = await enhanceFixture(t, 1100, 1100, '2K');
  const r = await executeProduction(root, job.id, { enhance: doubler([]) });
  assert.equal(r.upscale.passes, 1);
  assert.deepEqual(billed(r), [['enhance', true]]);
});

test('计费 · 放大到 4K：火山两次，仍只收一次无损放大', async t => {
  const { root, job } = await enhanceFixture(t, 1100, 1100, '4K');
  const r = await executeProduction(root, job.id, { enhance: doubler([]) });
  assert.equal(r.upscale.passes, 2);
  assert.deepEqual(billed(r), [['enhance', true]]);
});

test('计费 · 放大第二遍结果未知：第一遍已回，按一次确定收费', async t => {
  const { root, job } = await enhanceFixture(t, 1100, 1100, '4K');
  let calls = 0; const pass = doubler([]);
  const r = await executeProduction(root, job.id, { enhance: async input => { if (++calls === 2) throw new Error('火山高清enhance连接中断'); return pass(input); } });
  assert.deepEqual(r.steps.map(s => s.status), ['returned', 'unknown']);
  assert.deepEqual(billed(r), [['enhance', true]]);
});

test('计费 · 放大结果未知后走了兜底：记一次待裁定，不直接扣', async t => {
  const { root, job } = await enhanceFixture(t, 1100, 1100, '2K');
  const r = await executeProduction(root, job.id, { enhance: async () => { throw new Error('火山高清enhance连接中断'); } });
  assert.equal(r.status, 'returned');
  assert.match(r.upscale.fallback, /连接中断/);
  assert.deepEqual(billed(r), [['enhance', false]]);
});

test('计费 · 放大被火山明确拒绝：不收费', async t => {
  const { root, job } = await enhanceFixture(t, 1100, 1100, '2K');
  const r = await executeProduction(root, job.id, { enhance: async () => { throw Object.assign(new Error('火山高清enhance返回HTTP 400'), { definiteFailure: true }); } });
  assert.deepEqual(billed(r), []);
});

test('计费 · 生图路线的 2K：试用期只收生图，放大不另收', async t => {
  const { root, job } = await fixture(t, { transparentBackground: false, output: { ratio: '2:3', resolution: '2K' } });
  const r = await executeProduction(root, job.id, { generate: async () => drawn(832, 1248), enhance: doubler([]) });
  assert.deepEqual(r.steps.map(s => s.name), ['generate', 'upscale-1']);
  assert.deepEqual(billed(r), [['generate', true]]);
});
