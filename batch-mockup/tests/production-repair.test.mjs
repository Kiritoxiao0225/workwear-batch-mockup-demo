import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { hash, saveJSON, atomicFile } from '../adapters/a-files.mjs';
import { readRepairInput, saveProductionRepair, readRepairState } from '../application/production-repair.mjs';
import { applyRepairStroke, validateRepairStrokes } from '../application/repair-pixels.mjs';
import { startRequirements } from '../experiments/workbench/requirements-server.mjs';
import { readProductionJobs } from '../application/production.mjs';

const rgba = bytes => sharp(bytes).ensureAlpha().raw().toBuffer();
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'repair-test-')), id = hash('test repair');
  let serverToClose;
  t.after(async () => { if (serverToClose) { serverToClose.closeAllConnections(); await new Promise(done => serverToClose.close(done)); } await rm(root, { recursive: true, force: true }); });
  const width = 24, height = 24, source = Buffer.alloc(width * height * 4), cutout = Buffer.alloc(source.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    source.set([x * 10, y * 10, 180, 255], p);
    cutout.set([10, 20, 30, x > 3 && x < 20 && y > 3 && y < 20 ? 255 : 0], p);
  }
  source.set([255, 255, 255, 255], (12 * width + 12) * 4);
  source.set([255, 255, 255, 128], (12 * width + 13) * 4);
  cutout[(12 * width + 12) * 4 + 3] = 0;
  cutout[(12 * width + 13) * 4 + 3] = 0;
  async function file(data, name) {
    const bytes = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer(), asset = `production-results/${id}/${name}.png`;
    await atomicFile(resolve(root, 'public', asset), bytes);
    return { asset, sha256: hash(bytes), bytes: bytes.length, width, height };
  }
  const raw = await file(source, 'raw'), final = await file(cutout, 'cutout');
  const job = { id, caseId: 'T', artworkId: 'a1', name: '白字测试', status: 'returned', raw, final, steps: [], createdAt: new Date().toISOString() };
  await saveJSON(resolve(root, 'production-jobs', id, 'state.json'), job);
  await saveJSON(resolve(root, 'manifest.json'), { run: {}, cases: [] });
  const body = async (strokes, extra = {}) => { const i = await readRepairInput(root, id); return { jobId: id, requestId: randomUUID(), revision: i.revision, currentSHA256: i.current.sha256, rawSHA256: i.raw.sha256, strokes, ...extra }; };
  const pixels = async f => rgba(await readFile(resolve(root, 'public', f.asset)));
  return { root, id, width, height, source, cutout, raw, final, body, pixels, job, setServer: server => { serverToClose = server; } };
}

test('保留恢复原图RGBA，去除只改所选像素Alpha；圈外及原始文件不变', async t => {
  const f = await fixture(t), untouched = await readFile(resolve(f.root, 'production-jobs', f.id, 'state.json'));
  const body = await f.body([{ mode: 'keep', radius: 1, points: [[13, 12.5]] }, { mode: 'remove', radius: .5, points: [[6.5, 6.5]] }]);
  const r = await saveProductionRepair(f.root, body), actual = await f.pixels(r.current.file);
  const changed = new Set([12 * 24 + 12, 12 * 24 + 13, 6 * 24 + 6]);
  for (let i = 0; i < 24 * 24; i++) {
    const p = i * 4;
    const expected = i === 6 * 24 + 6 ? Buffer.from([10, 20, 30, 0]) : changed.has(i) ? f.source.subarray(p, p + 4) : f.cutout.subarray(p, p + 4);
    assert.deepEqual(actual.subarray(p, p + 4), expected, `pixel ${i}`);
  }
  assert.deepEqual(await readFile(resolve(f.root, 'production-jobs', f.id, 'state.json')), untouched);
  assert.deepEqual(await f.pixels(f.final), f.cutout);
  assert.deepEqual(await f.pixels(f.raw), f.source);
  assert.equal(r.current.file.sha256, hash(await readFile(resolve(f.root, 'public', r.current.file.asset))));
  assert.equal((await readProductionJobs(f.root))[0].repair.file.sha256, r.current.file.sha256);
});

test('同一保存幂等，冲突拒绝覆盖；恢复原抠图另存版本且历史修补仍可读取', async t => {
  const f = await fixture(t), body = await f.body([{ mode: 'keep', radius: 3, points: [[12, 12]] }]);
  const r1 = await saveProductionRepair(f.root, body);
  assert.equal((await saveProductionRepair(f.root, body)).revision, 1);
  await assert.rejects(saveProductionRepair(f.root, { ...body, strokes: [{ mode: 'reset' }] }), /其他修补内容/);
  await assert.rejects(saveProductionRepair(f.root, { ...body, requestId: randomUUID() }), /其他页面修补/);
  const r2 = await saveProductionRepair(f.root, await f.body([{ mode: 'reset' }]));
  assert.equal(r2.revision, 2); assert.deepEqual(await f.pixels(r2.current.file), f.cutout);
  assert.notEqual(r1.current.file.asset, r2.current.file.asset);
  assert.equal((await readRepairState(f.root, f.id)).history.length, 2);
  assert.equal((await saveProductionRepair(f.root, body)).savedRevision, 1);
});

test('缩放坐标使用原像素，连续笔画无间隙；撤销重放不会污染原始缓冲', () => {
  const source = new Uint8Array(40 * 30 * 4).fill(255), original = new Uint8Array(source.length), target = new Uint8Array(original);
  const strokes = [{ mode: 'keep', radius: .6, points: [[2.5, 4.5], [32.5, 4.5]] }, { mode: 'remove', radius: .5, points: [[20.5, 4.5]] }];
  validateRepairStrokes(strokes, 40, 30);
  for (const s of strokes) applyRepairStroke(target, source, original, 40, 30, s);
  for (let x = 2; x <= 32; x++) assert.equal(target[(4 * 40 + x) * 4 + 3], x === 20 ? 0 : 255);
  target.set(original); applyRepairStroke(target, source, original, 40, 30, strokes[0]);
  assert.equal(target[(4 * 40 + 20) * 4 + 3], 255);
  assert.equal(original.every(v => v === 0), true);
});

test('尺寸错位、越界、空白成图、损坏源文件和在途图片都不可保存', async t => {
  const f = await fixture(t);
  await assert.rejects(saveProductionRepair(f.root, await f.body([{ mode: 'keep', radius: 2, points: [[-1, 10]] }])), /超出/);
  await assert.rejects(saveProductionRepair(f.root, await f.body([{ mode: 'remove', radius: 100, points: [[12, 12]] }])), /完全透明/);
  await assert.rejects(readRepairInput(f.root, '../bad'), /编号/);
  await saveJSON(resolve(f.root, 'production-jobs', f.id, 'state.json'), { ...f.job, final: { ...f.final, width: 12 } });
  await assert.rejects(readRepairInput(f.root, f.id), /尺寸不一致/);
  await saveJSON(resolve(f.root, 'production-jobs', f.id, 'state.json'), { ...f.job, status: 'running' });
  await assert.rejects(readRepairInput(f.root, f.id), /尚未结束/);
  await saveJSON(resolve(f.root, 'production-jobs', f.id, 'state.json'), f.job);
  await atomicFile(resolve(f.root, 'public', f.raw.asset), Buffer.from('bad image'));
  await assert.rejects(saveProductionRepair(f.root, await f.body([{ mode: 'reset' }])), /校验失败/);
  assert.equal((await readRepairState(f.root, f.id)).revision, 0);
});

test('HTTP真实PNG保存/下载/重开可回读，跨源写入拒绝，不调用制作供应商', async t => {
  const f = await fixture(t); let calls = 0;
  const server = await startRequirements(f.root, 0, { productionEnabled: false, productionFactory: () => { calls++; throw Error('不应调用'); } });
  f.setServer(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, origin = base) => fetch(base + '/api/production/repair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const body = await f.body([{ mode: 'fill', scope: 'region', point: [12.5, 12.5] }]);
  assert.equal((await post(body, 'https://untrusted.example')).status, 403);
  const response = await post(body); assert.equal(response.status, 200);
  const saved = await response.json(), downloaded = Buffer.from(await (await fetch(base + '/' + saved.current.file.asset)).arrayBuffer());
  assert.equal(hash(downloaded), saved.current.file.sha256);
  const reopened = await (await fetch(base + '/api/production/repair?jobId=' + f.id)).json();
  assert.equal(reopened.current.sha256, saved.current.file.sha256); assert.equal(reopened.revision, 1); assert.equal(calls, 0);
  assert.equal((await fetch(base + '/repair-editor.mjs')).status, 200);
  assert.equal((await fetch(base + '/repair-pixels.mjs')).status, 200);
});

test('一点补回连通空洞与半透明原像素，保存后其余像素逐一保持不变', async t => {
  const f = await fixture(t), stroke = { mode: 'fill', scope: 'region', point: [12.5, 12.5] };
  const saved = await saveProductionRepair(f.root, await f.body([stroke])), actual = await f.pixels(saved.current.file);
  for (let i = 0; i < 24 * 24; i++) {
    const p = i * 4, restored = i === 12 * 24 + 12 || i === 12 * 24 + 13;
    assert.deepEqual(actual.subarray(p, p + 4), (restored ? f.source : f.cutout).subarray(p, p + 4));
  }
  const reset = await saveProductionRepair(f.root, await f.body([{ mode: 'reset' }]));
  assert.deepEqual(await f.pixels(reset.current.file), f.cutout);
});

test('圈内可从已有图案处点击补多个空洞，已有图案和圈外均不改变', () => {
  const width = 15, height = 15, source = new Uint8Array(width * height * 4).fill(255), original = new Uint8Array(source.length);
  for (let i = 0; i < width * height; i++) original.set([10, 20, 30, 255], i * 4);
  const holes = [[5, 7], [6, 7], [8, 7], [9, 7], [10, 7], [11, 7], [12, 7]];
  for (const [x, y] of holes) original[(y * width + x) * 4 + 3] = 0;
  const target = new Uint8Array(original), stroke = { mode: 'fill', scope: 'brush', radius: 3, point: [7.5, 7.5] };
  validateRepairStrokes([stroke], width, height);
  const result = applyRepairStroke(target, source, original, width, height, stroke);
  assert.equal(result.restoredPixels, 5);
  for (let i = 0; i < width * height; i++) {
    const x = i % width, y = Math.floor(i / width), expected = original[i * 4 + 3] === 0 && Math.hypot(x - 7, y - 7) <= 3 ? source : original;
    assert.deepEqual(target.subarray(i * 4, i * 4 + 4), expected.subarray(i * 4, i * 4 + 4));
  }
  applyRepairStroke(target, source, original, width, height, { mode: 'reset' });
  assert.deepEqual(target, original);
  applyRepairStroke(target, source, original, width, height, stroke);
  assert.equal(target[(7 * width + 5) * 4 + 3], 255);
});

test('外部背景、对角漏口和已有内容不填补，也不产生保存版本', async t => {
  const f = await fixture(t);
  for (const stroke of [{ mode: 'fill', scope: 'region', point: [1, 1] }, { mode: 'fill', scope: 'brush', point: [1, 1], radius: 2 }]) {
    await assert.rejects(saveProductionRepair(f.root, await f.body([stroke])), e => e.status === 400 && /外部背景/.test(e.message));
  }
  await assert.rejects(saveProductionRepair(f.root, await f.body([{ mode: 'fill', scope: 'region', point: [6, 6] }])), /请点在被抠空/);
  assert.equal((await readRepairState(f.root, f.id)).revision, 0);
  const source = new Uint8Array(8 * 8 * 4).fill(255), original = new Uint8Array(source);
  for (let n = 0; n < 6; n++) original[(n * 8 + n) * 4 + 3] = 0;
  const target = new Uint8Array(original);
  assert.throws(() => applyRepairStroke(target, source, original, 8, 8, { mode: 'fill', scope: 'region', point: [5, 5] }), /外部背景/);
  assert.deepEqual(target, original);
});

test('原图本身透明的区域不编造像素；非法补空白请求在计算前拒绝', () => {
  const source = new Uint8Array(6 * 6 * 4).fill(255), original = new Uint8Array(source);
  source[(3 * 6 + 3) * 4 + 3] = original[(3 * 6 + 3) * 4 + 3] = 0;
  const target = new Uint8Array(original);
  assert.throws(() => applyRepairStroke(target, source, original, 6, 6, { mode: 'fill', scope: 'brush', point: [3, 3], radius: 2 }), /没有可补回/);
  assert.deepEqual(target, original);
  for (const stroke of [
    { mode: 'fill', scope: 'all', point: [1, 1] },
    { mode: 'fill', scope: 'region', point: [6, 1] },
    { mode: 'fill', scope: 'region', point: [NaN, 1] },
    { mode: 'fill', scope: 'brush', point: [1, 1], radius: 257 },
    { mode: 'fill', scope: 'brush', point: [1, 1] },
  ]) assert.throws(() => validateRepairStrokes([stroke], 6, 6), /范围或坐标/);
  assert.throws(() => validateRepairStrokes(Array(11).fill({ mode: 'fill', scope: 'region', point: [1, 1] }), 4000, 4000), /分次保存/);
});

test('去空白一点去掉相连残留底色并淡化杂边，全图同色才会去掉隔开的残留', () => {
  const width = 12, height = 12, original = new Uint8Array(width * height * 4), at = (x, y) => (y * width + x) * 4;
  for (let y = 1; y <= 10; y++) for (let x = 1; x <= 10; x++) original.set([10, 20, 30, 255], at(x, y));
  for (let y = 4; y <= 6; y++) for (let x = 4; x <= 6; x++) original.set([255, 255, 255, 255], at(x, y));
  original.set([240, 240, 240, 255], at(5, 5));
  original.set([133, 138, 143, 255], at(7, 5));
  original.set([255, 255, 255, 255], at(9, 9));
  const region = { mode: 'clear', scope: 'region', point: [4.5, 4.5], tolerance: 32 }, target = new Uint8Array(original);
  validateRepairStrokes([region], width, height);
  assert.equal(applyRepairStroke(target, original, original, width, height, region).clearedPixels, 9);
  for (let i = 0; i < width * height; i++) {
    const x = i % width, y = Math.floor(i / width), p = i * 4;
    const expected = x >= 4 && x <= 6 && y >= 4 && y <= 6 ? [...original.subarray(p, p + 3), 0] : x === 7 && y === 5 ? [10, 20, 30, 108] : original.subarray(p, p + 4);
    assert.deepEqual(target.subarray(p, p + 4), Uint8Array.from(expected), `pixel ${x},${y}`);
  }
  const everywhere = new Uint8Array(original);
  assert.equal(applyRepairStroke(everywhere, original, original, width, height, { ...region, scope: 'color' }).clearedPixels, 10);
  assert.equal(everywhere[at(9, 9) + 3], 0);
  assert.equal(everywhere[at(2, 2) + 3], 255);
  assert.throws(() => applyRepairStroke(new Uint8Array(original), original, original, width, height, { ...region, point: [0, 0] }), /已经是透明/);
  for (const stroke of [{ ...region, scope: 'all' }, { ...region, tolerance: 200 }, { mode: 'clear', scope: 'region', point: [1, 1] }, { ...region, point: [12, 1] }]) {
    assert.throws(() => validateRepairStrokes([stroke], width, height), /去空白范围或坐标/);
  }
});
