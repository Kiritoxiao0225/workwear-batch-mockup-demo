import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { hash, saveJSON, atomicFile, readBytes } from '../adapters/a-files.mjs';
import { reserveProduction, executeProduction } from '../application/production.mjs';
import { inspectPixels, hardenInteriorAlpha } from '../adapters/production-images.mjs';
import { referenceImages, tokenCost, evolinkGenerate, TRANSPARENT_NOTE } from '../adapters/evolink.mjs';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { workbenchData } from '../runtime/service.mjs';

const prompt = '【左胸图稿】\n\n主体：使用图2完整Logo。\n\n文字：沿用图2。\n\n字体：沿用图2。\n\n颜色：沿用图2。\n\n排版：原样。\n\n尺寸：未指定。\n\n输出：独立图稿。';
// A blue ring whose white interior came back 70% opaque, as Sunburst did with a white shield.
async function translucentBadge() {
  const size = 40, data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 19.5, y - 19.5), p = (y * size + x) * 4;
    if (d <= 14) data.set(d > 11 ? [20, 40, 160, 255] : [250, 250, 250, 180], p);
  }
  return sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}
async function fixture(t, imageIds = ['T-2']) {
  const root = await mkdtemp(resolve(tmpdir(), 'evolink-production-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const opaque = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).png().toBuffer();
  const images = [1, 2].map(index => ({ imageId: 'T-' + index, index, asset: `assets/T-${index}.png`, originalSHA256: hash(opaque), originalBytes: opaque.length, width: 40, height: 40 }));
  for (const i of images) await atomicFile(resolve(root, 'public', i.asset), opaque);
  const draft = { artworks: [{ id: 'a1', name: '左胸图稿', route: 'generate', applications: [], imageIds, prompt }], readingIssues: [] };
  const manifest = { run: {}, cases: [{ caseId: 'T', sourceText: '客服原文', images }] };
  await saveJSON(resolve(root, 'manifest.json'), manifest);
  const state = { revision: 1, draft, draftSupplementRevision: 0, analyses: [], confirmations: [] };
  await saveJSON(resolve(root, 'requirements-state/T.json'), state);
  return { root, manifest, state, opaque, requests: [{ caseId: 'T', revision: 1, supplementRevision: 0 }] };
}

test('只发图稿关联的图；图号不从图1连续时写明对应关系', () => {
  const images = [1, 2, 3].map(index => ({ id: 'T-' + index, index }));
  const later = referenceImages({ images, imageIds: ['T-3', 'T-1'] });
  assert.deepEqual(later.used.map(i => i.index), [1, 3]);
  assert.equal(later.note, '参考图顺序：第1张为图1，第2张为图3。\n\n');
  assert.equal(referenceImages({ images, imageIds: ['T-1', 'T-2'] }).note, '');
  assert.deepEqual(referenceImages({ images, imageIds: [] }).used, []);
});

test('理解费用按返回的 token 用量计算，与 9 月 25 日余额核对值一致', () => {
  const cost = tokenCost('gpt-6-sol', { prompt_tokens: 7529, completion_tokens: 605 }, { EVOLINK_CNY_PER_CREDIT: '0.1' });
  assert.ok(Math.abs(cost.credits - 1.2919) < 0.01, `credits ${cost.credits}`);
  assert.equal(cost.cny, Number((cost.credits * 0.1).toFixed(4)));
  assert.equal(tokenCost('unknown-model', { prompt_tokens: 1, completion_tokens: 1 }), null);
});

test('补实图案内部的半透明，外部透明背景与软边不动', async () => {
  const solid = await hardenInteriorAlpha(await translucentBadge());
  const { data } = await sharp(solid.bytes).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[(20 * 40 + 20) * 4 + 3], 255, '内部白色应为实心');
  assert.equal(data[3], 0, '四角保持透明');
  assert.ok(solid.hardenedRatio > 0);
});

test('字腔或边框里困住的淡光晕保持原样，不补成色块', async () => {
  const badge = await sharp(await translucentBadge()).raw().toBuffer();
  for (let y = 17; y < 23; y++) for (let x = 17; x < 23; x++) badge.set([240, 120, 40, 60], (y * 40 + x) * 4);
  const solid = await hardenInteriorAlpha(await sharp(badge, { raw: { width: 40, height: 40, channels: 4 } }).png().toBuffer());
  const { data } = await sharp(solid.bytes).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[(20 * 40 + 20) * 4 + 3], 60, '圈内淡光晕不变');
  assert.equal(data[(20 * 40 + 13) * 4 + 3], 255, '接近实心的白色内部仍补实');
});

test('直接透明的生图：内部补实、白底原图供修补、不调用美图，费用记在生图步骤', async t => {
  const f = await fixture(t), badge = await translucentBadge(), [job] = await reserveProduction(f.root, f.manifest, f.requests);
  const cost = { provider: 'evolink', credits: 1.75, cny: 0.19, method: 'receipt', taskId: 'task-1' };
  const result = await executeProduction(f.root, job.id, {
    generate: async () => ({ bytes: badge, cost, transparentRequested: true }),
    cutout: () => assert.fail('已透明，不应再抠图'),
  });
  assert.equal(result.status, 'returned');
  assert.deepEqual(result.steps.map(s => s.name), ['generate']);
  assert.deepEqual(result.steps[0].cost, cost);
  assert.equal(result.generated.sha256, hash(badge));
  assert.equal(result.raw.transparentPixels, 0, '修补用原图铺在白底上');
  assert.equal(result.final.transparentExterior, true);
  assert.equal([result.raw.width, result.raw.height].join(), [result.final.width, result.final.height].join());
  const final = await sharp(await readBytes(resolve(f.root, 'public', result.final.asset))).raw().toBuffer();
  assert.equal(final[(20 * 40 + 20) * 4 + 3], 255);
  assert.match(result.backgroundDecision, /补成实心/);
});

test('模型没有给出透明背景时退回美图抠图，抠图按单价记账', async t => {
  const f = await fixture(t), [job] = await reserveProduction(f.root, f.manifest, f.requests);
  const transparent = await sharp({ create: { width: 40, height: 40, channels: 4, background: '#0000' } })
    .composite([{ input: await sharp({ create: { width: 20, height: 20, channels: 4, background: '#123' } }).png().toBuffer(), left: 10, top: 10 }]).png().toBuffer();
  const result = await executeProduction(f.root, job.id, {
    generate: async () => ({ bytes: f.opaque, cost: { provider: 'evolink', cny: 0.15, method: 'receipt' }, transparentRequested: true }),
    cutout: async () => ({ bytes: transparent, cost: { provider: 'meitu', cny: 0.142, method: 'unit_price' } }),
  });
  assert.equal(result.status, 'returned');
  assert.deepEqual(result.steps.map(s => [s.name, s.cost.cny]), [['generate', 0.15], ['cutout', 0.142]]);
  assert.equal((await inspectPixels(await readBytes(resolve(f.root, 'public', result.final.asset)))).transparentExterior, true);
});

test('费用只返回给内部工作区：理解、图稿、整条与今日合计', async t => {
  const f = await fixture(t), [job] = await reserveProduction(f.root, f.manifest, f.requests);
  await executeProduction(f.root, job.id, { generate: async () => ({ bytes: await translucentBadge(), cost: { provider: 'evolink', credits: 1.75, cny: 0.19, method: 'receipt' }, transparentRequested: true }) });
  f.state.analyses.push({ id: 'x', status: 'returned', model: 'gpt-6-sol', finishedAt: new Date().toISOString(),
    cost: { provider: 'evolink', credits: 0.68, cny: 0.074, method: 'tokens', model: 'gpt-6-sol', promptTokens: 3800, completionTokens: 600 } });
  await saveJSON(resolve(f.root, 'requirements-state/T.json'), f.state);
  const internal = await workbenchData(f.root, { showCost: true }), c = internal.cases[0];
  assert.equal(c.cost.analysisCNY, 0.074);
  assert.equal(c.cost.artworks.a1.cny, 0.19);
  assert.equal(c.cost.totalCNY, 0.264);
  assert.equal(internal.costSummary.todayCNY, 0.264);
  assert.equal(internal.costSummary.todayCases, 1);
  const tenant = await workbenchData(f.root), other = tenant.cases[0];
  assert.equal(other.cost, undefined);
  assert.equal(tenant.costSummary, undefined);
  assert.ok(other.productions[0].steps.every(s => !('cost' in s)), '步骤里不带成本');
});

test('并发的两份图稿共用素材时只上传一次，只发各自关联的图，费用取任务账单', async t => {
  const calls = { upload: 0, create: [] }, original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const out = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#0000' } }).png().toBuffer();
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.includes('/files/upload/base64')) { calls.upload++; await new Promise(r => setTimeout(r, 20)); return Response.json({ success: true, data: { file_url: `https://files.example/${calls.upload}` } }); }
    if (url.endsWith('/v1/images/generations')) { calls.create.push(JSON.parse(init.body)); return Response.json({ id: 'task-' + calls.create.length }); }
    if (url.includes('/v1/tasks/')) return Response.json({ status: 'completed', results: ['https://cdn.example/out.png'], usage: { credits_used: 1.5, image_input_tokens: 1400, image_output_tokens: 500 } });
    if (url === 'https://cdn.example/out.png') return new Response(out);
    throw new Error('未预期的请求 ' + url);
  };
  const root = await mkdtemp(resolve(tmpdir(), 'evolink-upload-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, 'src.png'); await writeFile(path, out);
  const images = [1, 2].map(index => ({ id: 'U-' + index, index, path, sha256: randomUUID() }));
  const env = { EVOLINK_API_KEY: 'test-key', EVOLINK_CNY_PER_CREDIT: '0.1' };
  const run = async (name, imageIds, extra = {}) => { await mkdir(resolve(root, name), { recursive: true }); return evolinkGenerate({ caseId: 'U', prompt, images, imageIds, ...extra }, resolve(root, name), { env, pollMs: 1 }); };
  const [left, back] = await Promise.all([run('a', ['U-1']), run('b', ['U-1', 'U-2'])]);
  assert.equal(calls.upload, 2, '图1 只传一次');
  assert.deepEqual(calls.create.map(c => c.image_urls.length).sort(), [1, 2]);
  assert.ok(calls.create.every(c => c.model === 'gpt-image-2.5-sunburst' && c.background === 'transparent' && c.prompt.endsWith(TRANSPARENT_NOTE)));
  assert.deepEqual([left.cost.credits, left.cost.cny, left.cost.method, left.transparentRequested], [1.5, 0.15, 'receipt', true]);
  await run('c', ['U-2']);
  assert.equal(calls.upload, 2, '重新生成时复用已上传的素材');
  assert.ok(calls.create.every(c => c.quality === 'medium'), '默认 medium');
  await run('d', ['U-1'], { quality: 'high' });
  assert.equal(calls.create.at(-1).quality, 'high');
  assert.ok(back.bytes.length > 0);
});

test('草稿从数据库读回后字段顺序变了，同一份图稿仍是同一个制作编号，不会重复生成', async t => {
  const f = await fixture(t);
  f.state.draft.artworks[0].applications = [{ style: '719SF', color: '藏青', position: '左胸', sizeReference: { imageId: 'T-1', logoToBody: 0.2, note: '实拍' } }];
  f.state.draft.readingIssues = [{ scope: '图2', issue: '文字模糊' }];
  await saveJSON(resolve(f.root, 'requirements-state/T.json'), f.state);
  const [first] = await reserveProduction(f.root, f.manifest, f.requests);
  // jsonb sorts keys by length, then bytes: the same draft comes back in a different key order.
  f.state.draft.artworks[0].applications = [{ color: '藏青', style: '719SF', position: '左胸', sizeReference: { note: '实拍', imageId: 'T-1', logoToBody: 0.2 } }];
  f.state.draft.readingIssues = [{ issue: '文字模糊', scope: '图2' }];
  await saveJSON(resolve(f.root, 'requirements-state/T.json'), f.state);
  const [again] = await reserveProduction(f.root, f.manifest, f.requests);
  assert.equal(again.id, first.id);
});

test('高质量只在草稿标记或设计师要求时使用；普通图稿的制作编号不变', async t => {
  const f = await fixture(t);
  const [medium] = await reserveProduction(f.root, f.manifest, f.requests);
  assert.equal(medium.quality, undefined);
  const [high] = await reserveProduction(f.root, f.manifest, [{ ...f.requests[0], artworkId: 'a1', quality: 'high' }]);
  assert.notEqual(high.id, medium.id, '高质量重做是新的一次制作');
  assert.equal(high.quality, 'high');
  f.state.draft.artworks[0].quality = 'high';
  await saveJSON(resolve(f.root, 'requirements-state/T.json'), f.state);
  const [marked] = await reserveProduction(f.root, f.manifest, f.requests);
  assert.equal(marked.id, high.id, '识别标记的高质量与手动重做是同一份制作');
  await assert.rejects(reserveProduction(f.root, f.manifest, [{ ...f.requests[0], quality: 'low' }]), /生成质量无效/);
});
