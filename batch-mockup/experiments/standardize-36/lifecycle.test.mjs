import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { startServer } from './serve.mjs';
import { atomicFile, hash, saveJSON } from '../../adapters/a-files.mjs';
import { receiveConfirmedRequirement } from '../../application/b-intake.mjs';

async function fixture(t, analyzer = async () => ({ rawContent: JSON.stringify({ standardizedRequirement: '左胸使用图1；字体参考图2。\n白色版、红色版均在左胸。', readingIssues: [] }), httpStatus: 200 })) {
  const root = await mkdtemp(resolve(tmpdir(), 'a-lifecycle-'));
  const image = await sharp({ create: { width: 12, height: 8, channels: 4, background: '#245cab' } }).png().toBuffer();
  await atomicFile(resolve(root, 'public/assets/one.png'), image);
  const c = { caseId: 'N02', sourceText: '左胸图二，图一提供清晰图形', images: [{ index: 1, imageId: 'N02-1', asset: 'assets/one.png', originalSHA256: hash(image), originalBytes: image.length, width: 12, height: 8, mime: 'image/png' }] };
  await saveJSON(resolve(root, 'manifest.json'), { run: { id: 'test-only', promptSHA256: hash('test prompt') }, cases: [c] });
  await saveJSON(resolve(root, 'results/N02.json'), { status: 'returned', parsed: { standardizedRequirement: '旧模型正文', readingIssues: [] } });
  await atomicFile(resolve(root, 'prompt.txt'), 'test prompt');
  let calls = 0, request;
  const options = { analyzerFactory: async () => async input => { calls++; request = input; return analyzer(input); } };
  let server = await startServer(root, 0, options);
  const f = { root, image, get calls() { return calls; }, get request() { return request; }, get server() { return server; },
    get base() { return `http://127.0.0.1:${server.address().port}`; },
    async post(path, body) { return fetch(f.base + path, { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    async get(path) { const r = await fetch(f.base + path); assert.equal(r.status, 200); return r.json(); },
    async review(text, revision = 0, analysisId = null, supplementRevision = 0) { const r = await f.post('/api/reviews', { caseId: 'N02', text, note: '', state: 'pending', revision, analysisId, supplementRevision }); assert.equal(r.status, 200, await r.clone().text()); return r.json(); },
    async upload(revision = 0) { const r = await f.post('/api/supplements', { caseId: 'N02', revision, action: 'upload', id: randomUUID(), name: '字体参考.png', target: '左胸字体参考', base64: image.toString('base64') }); assert.equal(r.status, 200); return r.json(); },
    async analyze(reviewRevision, supplementRevision) { const body = { caseId: 'N02', requestId: randomUUID(), reviewRevision, supplementRevision }; const r = await f.post('/api/reanalyze', body); assert.equal(r.status, 202, await r.clone().text()); await server.waitForAnalyses(); return body; },
    async restart() { await server.waitForAnalyses(); await new Promise(r => server.close(r)); server = await startServer(root, 0, options); },
  };
  t.after(async () => { await server.waitForAnalyses(); await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); });
  return f;
}
const confirmBody = (text, reviewRevision, supplementRevision = 0) => ({ caseId: 'N02', text, reviewRevision, supplementRevision, requestId: randomUUID(), confirmedBy: '测试核对人' });

test('确认和B实际接收原文空格、换行及完整图片；重复提交只形成一条记录；修改后旧记录保留，重启可回读', async t => {
  const f = await fixture(t), original = '图1完整保留；字体参考图1。\n文字：“逛康美炘，可美可省钱”。\n教  练\n';
  await f.review(original); const payload = confirmBody(original, 1);
  const r = await f.post('/api/confirm', payload); assert.equal(r.status, 200); const first = await r.json();
  assert.equal(first.receipt.input.text, original); assert.equal(first.receipt.input.textSHA256, hash(original));
  assert.deepEqual(Buffer.from(await (await fetch(f.base + '/' + first.images[0].asset)).arrayBuffer()), f.image);
  assert.equal((await f.post('/api/confirm', payload)).status, 200);
  assert.equal((await f.post('/api/confirm', { ...payload, text: '别的' })).status, 409);
  await f.review('改成红色', 1);
  assert.equal((await f.post('/api/confirm', confirmBody(original, 1))).status, 409);
  const second = await (await f.post('/api/confirm', confirmBody('改成红色', 2))).json();
  assert.equal(second.receipt.input.text, '改成红色'); await f.restart();
  const b = await f.get('/api/b-input?caseId=N02&confirmationId=' + first.confirmationId); assert.equal(b.input.text, original);
  assert.equal((await f.get('/api/a-state')).N02.confirmations.length, 2);
  assert.equal((await fetch(f.base + '/api/b-input?caseId=N02&confirmationId=missing')).status, 404);
  assert.deepEqual(JSON.parse(await readFile(resolve(f.root, 'results/N02.json'))).parsed.standardizedRequirement, '旧模型正文');
});

test('补图→真实HTTP入口→注入模型→采用编辑→确认→B；人工原文不自动覆盖，图2用途和像素完整保留', async t => {
  const f = await fixture(t); await f.review('人工：白色和红色都在左胸'); await f.upload();
  assert.equal((await f.post('/api/confirm', confirmBody('人工：白色和红色都在左胸', 1, 1))).status, 409);
  const run = await f.analyze(1, 1); assert.equal(f.calls, 1);
  assert.equal((await f.post('/api/reanalyze', run)).status, 202); assert.equal(f.calls, 1);
  assert.equal(f.request.model, 'gpt-5.6-sol'); assert.equal(f.request.reasoning_effort, 'low');
  const content = f.request.messages[1].content;
  assert.equal(JSON.parse(content[0].text).设计师已保存正文, '人工：白色和红色都在左胸');
  assert.equal(content.filter(x => x.type === 'image_url').length, 2);
  assert.deepEqual(Buffer.from(content.filter(x => x.type === 'image_url')[1].image_url.url.split(',')[1], 'base64'), f.image);
  assert.equal(JSON.parse(content[0].text).图片用途[1].用途, '左胸字体参考');
  assert.equal((await f.get('/api/reviews')).N02.text, '人工：白色和红色都在左胸');
  const adopted = await (await f.post('/api/adopt-analysis', { ...run, analysisId: run.requestId })).json();
  assert.equal((await f.get('/api/reviews')).N02.text, '人工：白色和红色都在左胸');
  assert.equal((await f.post('/api/confirm', confirmBody('人工：白色和红色都在左胸', 1, 1))).status, 409);
  const corrected = adopted.text + '\n保留标点， 不加后背。'; await f.review(corrected, 1, adopted.analysisId, 1);
  const r = await f.post('/api/confirm', confirmBody(corrected, 2, 1)); assert.equal(r.status, 200, await r.clone().text());
  const received = (await r.json()).receipt.input;
  assert.equal(received.text, corrected); assert.deepEqual(received.images.map(i => i.label), ['图1', '图2']); assert.equal(received.images[1].target, '左胸字体参考');
  assert.equal((await fetch(f.base + '/analysis-evidence/N02/' + run.requestId + '-request.json')).status, 404);
});

test('识别等待期间编辑原文：旧候选可查看但不能覆盖新修订', async t => {
  let finish; const f = await fixture(t, () => new Promise(resolve => { finish = resolve; })); await f.review('初稿');
  const body = { caseId: 'N02', requestId: randomUUID(), reviewRevision: 1, supplementRevision: 0 };
  assert.equal((await f.post('/api/reanalyze', body)).status, 202);
  assert.equal((await f.post('/api/reanalyze', { ...body, requestId: randomUUID() })).status, 409);
  await f.review('新人工修订', 1);
  finish({ rawContent: JSON.stringify({ standardizedRequirement: '迟到的结果', readingIssues: [] }) }); await f.server.waitForAnalyses();
  assert.equal((await f.post('/api/adopt-analysis', { ...body, analysisId: body.requestId, reviewRevision: 2 })).status, 409);
  assert.equal((await f.get('/api/reviews')).N02.text, '新人工修订');
});

test('补图变更或移除使旧确认不再能代表当前素材；历史确认仍可读，图号不重排', async t => {
  const f = await fixture(t); await f.review('原图'); const confirmed = await (await f.post('/api/confirm', confirmBody('原图', 1))).json();
  const upload = await f.upload(); await f.upload(1);
  const remove = await f.post('/api/supplements', { caseId: 'N02', action: 'remove', id: upload.items[0].id, revision: 2 }); assert.equal(remove.status, 200);
  const run = await f.analyze(1, 3), a = (await f.get('/api/a-state')).N02.analyses[0];
  assert.deepEqual(a.images.map(i => i.label), ['图1', '图3']);
  assert.equal((await f.post('/api/confirm', confirmBody('原图', 1, 3))).status, 409);
  assert.equal((await f.get('/api/b-input?caseId=N02&confirmationId=' + confirmed.confirmationId)).input.images.length, 1);
  assert.equal(a.id, run.requestId);
});

test('无效格式与超时不会修改正文或自动重新调用；同输入未知请求禁止重复付费', async t => {
  const f = await fixture(t, async () => { throw new Error('timeout'); }); await f.review('保留我的修改');
  const run = await f.analyze(1, 0); assert.equal((await f.get('/api/a-state')).N02.analyses[0].status, 'unknown');
  assert.equal((await f.post('/api/reanalyze', run)).status, 202); assert.equal(f.calls, 1);
  assert.equal((await f.post('/api/reanalyze', { ...run, requestId: randomUUID() })).status, 409);
  await f.restart(); assert.equal((await f.get('/api/reviews')).N02.text, '保留我的修改'); assert.equal(f.calls, 1);
});

test('非法模型JSON保留原始返回，但不能采用或交接', async t => {
  const f = await fixture(t, async () => ({ rawContent: '{bad json' })); await f.review('人工'); await f.upload();
  const run = await f.analyze(1, 1); const a = (await f.get('/api/a-state')).N02.analyses[0];
  assert.equal(a.status, 'invalid_output'); assert.equal(a.rawContent, '{bad json');
  assert.equal((await f.post('/api/adopt-analysis', { ...run, analysisId: run.requestId })).status, 409);
  assert.equal((await f.post('/api/confirm', confirmBody('人工', 1, 1))).status, 409);
});

test('篡改原图、确认文件或外站写入都被拒绝；B不能接收裸草稿', async t => {
  const f = await fixture(t); await f.review('原文');
  await assert.rejects(receiveConfirmedRequirement({ text: 'draft', images: [] }, () => f.image));
  const req = await fetch(f.base + '/api/confirm', { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: JSON.stringify(confirmBody('原文', 1)) }); assert.equal(req.status, 403);
  await writeFile(resolve(f.root, 'public/assets/one.png'), 'tampered');
  assert.equal((await f.post('/api/confirm', confirmBody('原文', 1))).status, 409);
  assert.equal((await f.get('/api/a-state')).N02.confirmations.length, 0);
});

test('同一根目录禁止多服务并写；重启把遗留进行中请求标为未知，不发请求', async t => {
  const f = await fixture(t);
  await assert.rejects(startServer(f.root, 0), { status: 409 });
  await saveJSON(resolve(f.root, 'a-state/N02.json'), { analyses: [{ id: randomUUID(), status: 'running' }], confirmations: [] });
  await f.restart(); assert.equal((await f.get('/api/a-state')).N02.analyses[0].status, 'unknown'); assert.equal(f.calls, 0);
});


test('已经采用结果之后再次补图，仍能保存人工修改，但需要按新素材重新识别后才能确认', async t => {
  const f = await fixture(t); await f.review('人工'); await f.upload(); const run = await f.analyze(1, 1);
  const adopted = await (await f.post('/api/adopt-analysis', { ...run, analysisId: run.requestId })).json();
  await f.review(adopted.text, 1, adopted.analysisId, 1); await f.upload(1);
  await f.review('追加人工修正', 2, adopted.analysisId, 2);
  assert.equal((await f.get('/api/reviews')).N02.text, '追加人工修正');
  assert.equal((await f.post('/api/confirm', confirmBody('追加人工修正', 3, 2))).status, 409);
});

test('正文明确引用不存在的图号时不能确认；正常文字中的空格和换行仍原样保留', async t => {
  const f = await fixture(t); await f.review('使用图２字体');
  assert.equal((await f.post('/api/confirm', confirmBody('使用图２字体', 1))).status, 409);
  await f.review('使用图一\n教  练', 1);
  assert.equal((await f.post('/api/confirm', confirmBody('使用图一\n教  练', 2))).status, 200);
});
