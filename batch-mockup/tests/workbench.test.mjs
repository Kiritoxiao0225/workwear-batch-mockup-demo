import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startWorkbench } from '../experiments/workbench/serve.mjs';
import { hash, saveJSON } from '../adapters/a-files.mjs';

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'abcde-http-'));
  const text = '左胸：图1原样保留。\n教  练';
  const c = { caseId: 'T01', sourceText: '原文', sourceRecordId: 'test:1:1', wpsStatus: '待领取', images: [] };
  await saveJSON(resolve(root, 'manifest.json'), { run: { id: 'local-test', imageCount: 0 }, cases: [c] });
  await saveJSON(resolve(root, 'results/T01.json'), { status: 'returned', parsed: { standardizedRequirement: text, readingIssues: [] } });
  const server = await startWorkbench(root, 0), base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); });
  const post = (path, value, origin = base) => fetch(base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  return { root, base, text, post };
}
test('新表格提供全部ABCDE表头，完整A正文可读，C不能执行', async t => {
  const f = await fixture(t), page = await (await fetch(f.base)).text();
  for (const word of ['需求理解', '制作规划', '图稿制作', '核对与交付', '任务管理']) assert.ok(page.includes(word));
  const d = await (await fetch(f.base + '/api/workbench')).json();
  assert.equal(d.cases[0].text, f.text); assert.equal(d.productionEnabled, false); assert.equal(d.planningReady, false);
  assert.equal((await f.post('/api/b-plan', { caseId: 'T01' })).status, 409);
  assert.equal((await f.post('/api/c-generate', {})).status, 405);
  assert.equal((await fetch(f.base + '/manifest.json')).status, 404);
});
test('修改从现有A保存接口持久化，旧B显式过期，拒绝并发覆盖和外站写入', async t => {
  const f = await fixture(t);
  await saveJSON(resolve(f.root, 'b-index.json'), { T01: 'test-plan' });
  await saveJSON(resolve(f.root, 'b-runs/test-plan/result.json'), { aTextSHA256: hash(f.text), supplementRevision: 0, reviewRevision: 0, status: 'planned' });
  assert.equal((await (await fetch(f.base + '/api/workbench')).json()).cases[0].b.stale, false);
  const body = { caseId: 'T01', text: f.text + '\n改成白色', note: '', state: 'pending', revision: 0, supplementRevision: 0 };
  assert.equal((await f.post('/api/reviews', body)).status, 200);
  const d = await (await fetch(f.base + '/api/workbench')).json();
  assert.equal(d.cases[0].text, body.text); assert.equal(d.cases[0].result.parsed.standardizedRequirement, f.text); assert.equal(d.cases[0].b.stale, true);
  assert.equal((await f.post('/api/reviews', body)).status, 409);
  assert.equal((await f.post('/api/reviews', { ...body, revision: 1 }, 'https://untrusted.example')).status, 403);
});
test('首次A正在调用时不能从新页面重复识别付费', async t => {
  const f = await fixture(t); await saveJSON(resolve(f.root, 'results/T01.json'), { status: 'running' });
  const r = await f.post('/api/reanalyze', { caseId: 'T01', requestId: '11111111-1111-1111-1111-111111111111', reviewRevision: 0, supplementRevision: 0 });
  assert.equal(r.status, 409); assert.match((await r.json()).error, /首次识别/);
});
