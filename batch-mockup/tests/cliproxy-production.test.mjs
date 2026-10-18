import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { hash, saveJSON, atomicFile } from '../adapters/a-files.mjs';
import { reserveProduction, executeProduction } from '../application/production.mjs';
import { aspectLine, fitDrawing, configuredProduction } from '../adapters/production-images.mjs';
import { TRANSPARENT_NOTE } from '../adapters/evolink.mjs';
import { ratioLabel } from '../../lib/artwork-output-size.ts';

// 图稿生成 on the Codex relay: it ignores `size` (every size came back 1254×1254 on 2026-10-18)
// but draws the proportion written in the prompt, at about 1.5 MP.
const png = (width, height, background = '#3a6') => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
const sizeOf = async bytes => { const m = await sharp(bytes).metadata(); return `${m.width}x${m.height}`; };

test('比例写进提示词：预设比例原样，原比例取 1% 内最简分数', () => {
  assert.equal(aspectLine('3:4'), '画面比例：竖版 3:4。\n');
  assert.equal(aspectLine('3:2'), '画面比例：横版 3:2。\n');
  assert.equal(aspectLine('1:1'), '画面比例：方形 1:1。\n');
  assert.equal(aspectLine(undefined), '');
  assert.equal(ratioLabel(1280 / 2272), '9:16');
  assert.equal(ratioLabel(60 / 90), '2:3');
  assert.equal(ratioLabel(10), '3:1', '超过 3:1 与出图尺寸一样夹住');
});

test('转接按比例出的 1086×1448 收成页面显示的 880×1184；尺寸已对就原样交付', async () => {
  const fitted = await fitDrawing(await png(1086, 1448), '880x1184', '3:4');
  assert.equal(await sizeOf(fitted.bytes), '880x1184');
  assert.equal(fitted.warning, undefined);
  const exact = await png(880, 1184);
  assert.equal((await fitDrawing(exact, '880x1184', '3:4')).bytes, exact);
  const free = await png(1254, 1254);
  assert.equal((await fitDrawing(free, undefined)).bytes, free, '没选比例时不改');
});

test('没按比例出图：不裁不拉，按它自己的比例交付并提示重做', async () => {
  const fitted = await fitDrawing(await png(1254, 1254), '880x1184', '3:4');
  assert.equal(await sizeOf(fitted.bytes), '1024x1024');
  assert.match(fitted.warning, /没按 3:4 出图，交付的是 1024×1024/u);
});

test('请求：比例与透明说明写进提示词，只发图稿用到的图，结果按出图尺寸交付', async t => {
  const keys = ['ARTWORK_IMAGE_PROVIDER', 'CLIPROXY_API_KEY', 'CLIPROXY_API_BASE_URL', 'A_ANALYSIS_ENV_FILE'];
  const saved = { fetch: globalThis.fetch, env: Object.fromEntries(keys.map(k => [k, process.env[k]])) };
  t.after(() => { globalThis.fetch = saved.fetch; for (const k of keys) if (saved.env[k] === undefined) delete process.env[k]; else process.env[k] = saved.env[k]; });
  Object.assign(process.env, { ARTWORK_IMAGE_PROVIDER: 'cliproxy', CLIPROXY_API_KEY: 'test-key', CLIPROXY_API_BASE_URL: 'https://proxy.invalid/v1' });
  delete process.env.A_ANALYSIS_ENV_FILE;
  const dir = await mkdtemp(resolve(tmpdir(), 'cliproxy-production-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const images = await Promise.all([1, 2, 3].map(async index => {
    const path = resolve(dir, `T-${index}.png`), bytes = await png(40, 40, '#fff');
    await atomicFile(path, bytes);
    return { id: 'T-' + index, index, path, sha256: hash(bytes), bytes: bytes.length, asset: `assets/T-${index}.png` };
  }));
  let sent;
  const drawn = (await png(1086, 1448, '#0000')).toString('base64');
  globalThis.fetch = async (url, init) => { sent = { url: String(url), body: init.body }; return new Response(JSON.stringify({ data: [{ b64_json: drawn }], size: '1086x1448' }), { status: 200 }); };
  const providers = await configuredProduction();
  const result = await providers.generate({ prompt: '【图稿】主体：使用图3。', images, imageIds: ['T-3'], size: '880x1184', aspect: '3:4' }, dir);
  assert.equal(sent.url, 'https://proxy.invalid/v1/images/edits');
  assert.equal(sent.body.get('background'), 'transparent', '未关透明背景就要透明');
  assert.equal(sent.body.getAll('image[]').length, 1, '只发图3');
  assert.equal(sent.body.get('prompt'), '画面比例：竖版 3:4。\n参考图顺序：第1张为图3。\n\n【图稿】主体：使用图3。' + TRANSPARENT_NOTE);
  assert.equal(await sizeOf(result.bytes), '880x1184');
  assert.equal(result.transparentRequested, true, '透明结果走补实内部、白底原图那条路');
  assert.deepEqual(result.cost, { provider: 'codex', cny: 0, method: 'subscription' });

  await providers.generate({ prompt: '文字图稿', images, imageIds: [], transparentBackground: false }, dir);
  assert.equal(sent.url, 'https://proxy.invalid/v1/images/generations');
  const body = JSON.parse(sent.body);
  assert.equal(body.background, 'opaque', '关了透明背景就不要透明');
  assert.equal(body.prompt, '文字图稿', '没选比例、不透明时提示词不加东西');
});

test('原比例按图1换算成比例交给出图；模型没按比例时提示写到结果上', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'cliproxy-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reference = await sharp({ create: { width: 60, height: 90, channels: 3, background: '#fff' } }).png().toBuffer();
  const images = [{ imageId: 'T-1', index: 1, asset: 'assets/T-1.png', originalSHA256: hash(reference), originalBytes: reference.length, width: 60, height: 90 }];
  await atomicFile(resolve(root, 'public', images[0].asset), reference);
  const prompt = '【图稿】\n\n主体：使用图1的盾牌图形。\n\n文字：安全第一\n\n字体：沿用。\n\n颜色：沿用。\n\n排版：原样。\n\n尺寸：未指定。\n\n输出：独立图稿。';
  const draft = { artworks: [{ id: 'a1', name: '图稿', route: 'generate', applications: [], imageIds: ['T-1'], prompt, transparentBackground: false, output: { ratio: 'original', resolution: '1K' } }], readingIssues: [] };
  await saveJSON(resolve(root, 'requirements-state/T.json'), { revision: 1, draft, draftSupplementRevision: 0, analyses: [], confirmations: [] });
  const [job] = await reserveProduction(root, { run: {}, cases: [{ caseId: 'T', sourceText: '原文', images }] }, [{ caseId: 'T', revision: 1, supplementRevision: 0 }]);
  let asked;
  const r = await executeProduction(root, job.id, { generate: async input => { asked = input; return { bytes: await png(1024, 1024), warning: '模型这次没按 2:3 出图，交付的是 1024×1024，需要该比例请重做' }; } });
  assert.equal(r.status, 'returned');
  assert.equal(asked.size, '832x1248');
  assert.equal(asked.aspect, '2:3');
  assert.match(r.warning, /没按 2:3 出图/u);
});

// 出图通道: the author picks 新通道 (relay) or 原通道 (EvoLink) per picture to compare their speed.
async function studioJob(t, artwork) {
  const root = await mkdtemp(resolve(tmpdir(), 'cliproxy-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = '【图稿】\n\n主体：圆形徽章。\n\n文字：安全第一\n\n字体：黑体。\n\n颜色：蓝色。\n\n排版：居中。\n\n尺寸：未指定。\n\n输出：独立图稿。';
  const draft = { artworks: [{ id: 'a1', name: '图稿', route: 'generate', applications: [], imageIds: [], prompt, ...artwork }], readingIssues: [] };
  await saveJSON(resolve(root, 'requirements-state/T.json'), { revision: 1, draft, draftSupplementRevision: 0, analyses: [], confirmations: [] });
  const [job] = await reserveProduction(root, { run: {}, cases: [{ caseId: 'T', sourceText: '原文', images: [] }] }, [{ caseId: 'T', revision: 1, supplementRevision: 0 }]);
  const input = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(root, 'production-jobs', job.id, 'input.json'), 'utf8'));
  return { job, input };
}

test('通道在下单时定下：选了原通道就记原通道，没选按默认；换通道是另一单', async t => {
  const before = process.env.ARTWORK_IMAGE_PROVIDER;
  t.after(() => { if (before === undefined) delete process.env.ARTWORK_IMAGE_PROVIDER; else process.env.ARTWORK_IMAGE_PROVIDER = before; });
  process.env.ARTWORK_IMAGE_PROVIDER = 'cliproxy';
  const picked = await studioJob(t, { provider: 'evolink' });
  assert.equal(picked.input.provider, 'evolink');
  assert.equal(picked.input.policy.generation.provider, 'evolink');
  assert.equal(picked.job.provider, 'evolink', '结果页靠它显示用的哪个通道');
  const plain = await studioJob(t, {});
  assert.equal(plain.input.provider, 'cliproxy');
  assert.equal(plain.job.provider, 'cliproxy');
  assert.notEqual(picked.job.id, plain.job.id);
  const enlarged = await studioJob(t, { route: 'reuse' });
  assert.equal(enlarged.input.provider, undefined, '不出图的方式没有通道');
});

test('页面只能选这两个通道', async () => {
  const { validateRequirementDraft } = await import('../application/requirements.mjs');
  const prompt = '【图稿】\n\n主体：圆形徽章。\n\n文字：安全第一\n\n字体：黑体。\n\n颜色：蓝色。\n\n排版：居中。\n\n尺寸：未指定。\n\n输出：独立图稿。';
  const draft = provider => ({ artworks: [{ id: 'a1', name: '图稿', route: 'generate', provider, applications: [], imageIds: [], prompt }], readingIssues: [] });
  assert.doesNotThrow(() => validateRequirementDraft(draft('evolink'), []));
  assert.throws(() => validateRequirementDraft(draft('ark'), []), /制作要求格式无效/u);
});

test('选了原通道就交给 EvoLink；没开通的通道直接说明，不发请求', async t => {
  const keys = ['ARTWORK_IMAGE_PROVIDER', 'CLIPROXY_API_KEY', 'CLIPROXY_API_BASE_URL', 'EVOLINK_API_KEY', 'A_ANALYSIS_ENV_FILE'];
  const saved = { fetch: globalThis.fetch, env: Object.fromEntries(keys.map(k => [k, process.env[k]])) };
  t.after(() => { globalThis.fetch = saved.fetch; for (const k of keys) if (saved.env[k] === undefined) delete process.env[k]; else process.env[k] = saved.env[k]; });
  Object.assign(process.env, { ARTWORK_IMAGE_PROVIDER: 'cliproxy', CLIPROXY_API_KEY: 'test-key', CLIPROXY_API_BASE_URL: 'https://proxy.invalid/v1', EVOLINK_API_KEY: 'evo-key' });
  delete process.env.A_ANALYSIS_ENV_FILE;
  const dir = await mkdtemp(resolve(tmpdir(), 'cliproxy-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const urls = [];
  globalThis.fetch = async url => { urls.push(String(url)); return new Response('{}', { status: 400 }); };
  await assert.rejects((await configuredProduction()).generate({ prompt: '徽章', images: [], imageIds: [], provider: 'evolink', caseId: 'T' }, dir), /EvoLink 生图提交失败/u);
  assert.deepEqual(urls, ['https://api.evolink.ai/v1/images/generations']);
  delete process.env.EVOLINK_API_KEY; urls.length = 0;
  await assert.rejects((await configuredProduction()).generate({ prompt: '徽章', images: [], imageIds: [], provider: 'evolink' }, dir),
    e => e.definiteFailure === true && /原通道暂未开通/u.test(e.message));
  assert.deepEqual(urls, [], '没有发出任何请求');
});
