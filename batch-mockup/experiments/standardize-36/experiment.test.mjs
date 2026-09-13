import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseResult, structuralObservations, saveJSON } from './core.mjs';
import { startServer, validateReview } from './serve.mjs';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { classifyWpsScope } from './wps-scope.mjs';
import { completeMetadata, completeRead } from './prepare-live.mjs';

test('全量WPS读取不受旧36样本限制，数量和身份必须完整匹配', () => {
  const entries = Array.from({ length: 53 }, (_, i) => ({ id: 'row' + i, fields: { 任务状态: i < 45 ? '🔴待领取' : '✔已完成' } }));
  const metadata = { protocol: 'mockup-wps-1', sheetId: 1, sheetName: '效果图任务管理', fields_schema: [], recordIds: entries.map(x => x.id), recordManifest: entries };
  assert.equal(completeMetadata(metadata, metadata.sheetName).length, 45);
  assert.throws(() => completeMetadata({ ...metadata, recordManifest: entries.slice(1) }, metadata.sheetName));
  assert.throws(() => completeMetadata({ ...metadata, recordIds: [...metadata.recordIds.slice(1), 'row1'] }, metadata.sheetName));
  const read = { sheetId: 1, sheetName: metadata.sheetName, fields_schema: [], records: [{ id: 'row0' }, { id: 'row1' }] };
  assert.equal(completeRead(read, ['row0', 'row1'], metadata).length, 2);
  assert.throws(() => completeRead(read, ['row1', 'row0'], metadata));
  assert.throws(() => completeRead(read, ['row0'], metadata));
});

test('WPS入口只取待领取和未领取，修改次数缺失或有值都不改变状态筛选', () => {
  for (const status of ['待领取', '🔴待领取', '未领取', ' 未领取 ']) {
    for (const revision of [undefined, null, '', '第 0 次', '第 1 次', '第 2 次', '不详']) {
      assert.equal(classifyWpsScope({ status, revision }).stage, 'first_generation');
    }
  }
  for (const status of ['🟢设计中', '🔵待完善', '✔已完成', '领取', '待领取后修改', '']) {
    assert.equal(classifyWpsScope({ status }).stage, 'status_excluded');
  }
});

test('解析、保存和读回保留原始字符串，不静默改字或换行', async () => {
  const value = { standardizedRequirement: '图1+通华驾校\nSales ELT\nLearn.Lead.Grow\n  教 练  ', readingIssues: [] };
  const parsed = parseResult(JSON.stringify(value));
  assert.deepEqual(parsed, value);
  const dir = await mkdtemp(resolve(tmpdir(), 'a36-roundtrip-'));
  try { await saveJSON(resolve(dir, 'value.json'), parsed); assert.deepEqual(JSON.parse(await readFile(resolve(dir, 'value.json'))), value); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
test('不修复格式错误，也不以空字符串或缺失readingIssues伪装返回完成', () => {
  for (const v of ['```json\n{}\n```', '{}', '[]', '{"standardizedRequirement":"","readingIssues":[]}', '{"standardizedRequirement":"a","readingIssues":[null]}']) assert.throws(() => parseResult(v));
});
test('图号检查只记录问题，不改写模型内容', () => {
  const value = { standardizedRequirement: '【整体目标】【素材用途】图２用于后背【图稿要求】【应用关系】', readingIssues: [] };
  const before = JSON.stringify(value); assert.deepEqual(structuralObservations(value, 1), ['文中出现输入集合外的图号：图2']); assert.equal(JSON.stringify(value), before);
});
test('新版按图稿组织不要求旧四段标题，但仍检查输入之外的图号且不改文案', () => {
  const value = { standardizedRequirement: '应用服装：B01SD 黑色\n左胸：使用图1，字体参考图2。', readingIssues: [] };
  const before = JSON.stringify(value);
  assert.deepEqual(structuralObservations(value, 2, 'artwork-first'), []);
  assert.deepEqual(structuralObservations(value, 1, 'artwork-first'), ['文中出现输入集合外的图号：图2']);
  assert.equal(structuralObservations(value, 2).length, 4);
  assert.equal(JSON.stringify(value), before);
});
test('审阅限定案例、状态和版本，避免其他页面静默覆盖修改', () => {
  const b = { caseId: 'D04', state: 'needs_changes', text: '参考图2字体', note: '', revision: 0 };
  assert.equal(validateReview(b, new Set(['D04'])).revision, 1);
  assert.throws(() => validateReview(b, new Set(['D01'])));
  assert.throws(() => validateReview(b, new Set(['D04']), { revision: 1 }), { status: 409 });
  assert.throws(() => validateReview({ ...b, state: 'production_confirmed' }, new Set(['D04'])));
});
test('本地服务：审阅可读回，并发旧版本拒绝；源模型结果和私有文件受保护', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'a36-http-'));
  await mkdir(resolve(dir, 'public')); await writeFile(resolve(dir, 'public/index.html'), '<h1>test</h1>');
  await saveJSON(resolve(dir, 'manifest.json'), { cases: [{ caseId: 'D04' }] });
  await writeFile(resolve(dir, 'private.txt'), 'not-public');
  const server = await startServer(dir, 0), base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(base + '/private.txt')).status, 404);
    const body = JSON.stringify({ caseId: 'D04', text: '<script>文字</script>\n教 练', note: '只核对字形', state: 'needs_changes', revision: 0 });
    const post = origin => fetch(base + '/api/reviews', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body });
    assert.equal((await post('https://example.test')).status, 403);
    const results = await Promise.all([post(base), post(base)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const saved = await (await fetch(base + '/api/reviews')).json();
    assert.equal(saved.D04.text, '<script>文字</script>\n教 练');
    assert.equal(saved.D04.revision, 1);
    assert.deepEqual(JSON.parse(await readFile(resolve(dir, 'manifest.json'))), { cases: [{ caseId: 'D04' }] });
  } finally { await new Promise(done => server.close(done)); await rm(dir, { recursive: true, force: true }); }
});

test('补图真实HTTP上传、字节读回、幂等与重启持久化；不覆盖原图或误标核对完成', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'a36-upload-'));
  await mkdir(resolve(dir, 'public/assets'), { recursive: true });
  const original = await sharp({ create: { width: 24, height: 18, channels: 4, background: '#f02020' } }).png().toBuffer();
  const supplied = await sharp({ create: { width: 30, height: 22, channels: 4, background: '#2080f0' } }).png().toBuffer();
  await writeFile(resolve(dir, 'public/assets/original.png'), original);
  const manifest = { cases: [{ caseId: 'D24', images: [{ asset: 'assets/original.png' }] }, { caseId: 'D20' }] };
  await saveJSON(resolve(dir, 'manifest.json'), manifest);
  await saveJSON(resolve(dir, 'scope.json'), { cases: { D24: { stage: 'first_generation' }, D20: { stage: 'revision' } } });
  let server = await startServer(dir, 0), base = `http://127.0.0.1:${server.address().port}`;
  const payload = { action: 'upload', caseId: 'D24', id: randomUUID(), name: '补充Logo.png', target: '左胸Logo', base64: supplied.toString('base64'), revision: 0 };
  const post = (body, origin = base) => fetch(base + '/api/supplements', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(payload, 'https://foreign.test')).status, 403);
    assert.equal((await post({ ...payload, caseId: 'D20' })).status, 409);
    assert.equal((await post({ ...payload, base64: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64') })).status, 400);
    const response = await post(payload); assert.equal(response.status, 200);
    const saved = await response.json(); assert.equal(saved.status, 'pending_reanalysis'); assert.equal(saved.revision, 1);
    assert.deepEqual(Buffer.from(await (await fetch(base + '/' + saved.items[0].asset)).arrayBuffer()), supplied);
    assert.equal((await (await post(payload)).json()).items.length, 1);
    assert.equal((await post({ ...payload, target: '后背' })).status, 409);
    assert.equal((await post({ ...payload, id: randomUUID() })).status, 409);
    const review = await fetch(base + '/api/reviews', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: 'D24', text: '旧模型返回', note: '', state: 'checked', revision: 0 }) });
    assert.equal(review.status, 409);
    await new Promise(done => server.close(done));
    server = await startServer(dir, 0); base = `http://127.0.0.1:${server.address().port}`;
    const restored = await (await fetch(base + '/api/supplements')).json();
    assert.deepEqual(restored.D24, saved);
    const removed = await (await post({ action: 'remove', caseId: 'D24', id: payload.id, revision: 1 })).json();
    assert.equal(removed.status, 'no_active_supplements'); assert.ok(removed.items[0].removedAt);
    assert.deepEqual(await readFile(resolve(dir, 'public/assets/original.png')), original);
    assert.deepEqual(JSON.parse(await readFile(resolve(dir, 'manifest.json'))), manifest);
  } finally { await new Promise(done => server.close(done)); await rm(dir, { recursive: true, force: true }); }
});
