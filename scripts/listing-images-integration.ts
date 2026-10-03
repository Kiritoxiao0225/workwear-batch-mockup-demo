// 电商主图第 1 期验收：上传、租户隔离、积分冻结/结算/退回、AI 分类与策划（模拟供应商）、确认。不调用任何付费接口。
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
const root = await mkdtemp(join(tmpdir(), 'listing-')), probe = createServer();
await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
const password = randomBytes(24).toString('hex');
process.env.CATALOG_DATABASE_URL = `postgresql://listing:${password}@127.0.0.1:${port}/postgres`;
process.env.CATALOG_DATABASE_CA_CERT = ''; process.env.CATALOG_LOCAL_OBJECT_ROOT = join(root, 'objects');
process.env.CATALOG_APP_ORIGIN = 'http://localhost:3189'; delete process.env.CATALOG_AUTH_MODE;
process.env.EVOLINK_API_KEY = 'test-key-never-sent';
const database = new EmbeddedPostgres({ databaseDir: join(root, 'pg'), user: 'listing', password, port, persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} });
const { catalogDatabase: db, closeCatalogDatabase, migrateCatalog } = await import('../lib/server/catalog-database');
const { createCatalogUser, loginCatalog } = await import('../lib/server/catalog-auth');
const routes = await import('../app/api/listing/[...path]/route');
const { executePlan } = await import('../lib/server/listing-jobs');
let checks = 0; const pass = (s: string) => { checks++; console.log('PASS', s); };
try {
  await database.initialise(); await database.start(); await migrateCatalog();
  const tenants = [randomUUID(), randomUUID()], tokens: string[] = [];
  for (const [i, t] of tenants.entries()) {
    await db().query("INSERT INTO tenants(id,name,style_quota,storage_quota_bytes,workspace) VALUES($1,'电商主图验收',10,10000000,$2)", [t, 'lst-test-' + t]);
    await db().query('INSERT INTO tenant_usage(tenant_id) VALUES($1)', [t]);
    await db().query('INSERT INTO credit_accounts(tenant_id,balance_cents) VALUES($1,1000)', [t]);
    await createCatalogUser(`lst${i}@example.test`, '验收账号', password, 'editor', t);
    tokens.push((await loginCatalog(`lst${i}@example.test`, password)).token);
  }
  async function call(index: number, path: string, body?: unknown, expected = 200, method: 'GET' | 'POST' | 'DELETE' = body === undefined ? 'GET' : 'POST', headers: Record<string, string> = {}) {
    const req = new NextRequest('http://localhost:3189/api/listing/' + path, { method, headers: { origin: 'http://localhost:3189', cookie: 'catalog_session=' + tokens[index], 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) }) });
    const response = await routes[method](req, { params: Promise.resolve({ path: path.split('/') }) });
    assert.equal(response.status, expected, response.status === expected ? '' : await response.text()); return response;
  }
  const image = (w: number, h: number, color: string) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
  const upload = (index: number, project: string, bytes: Buffer, path: string, expected = 200) =>
    call(index, `projects/${project}/images`, bytes, expected, 'POST', { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(path.split('/').at(-1)!), 'x-file-path': encodeURIComponent(path) });
  const balance = async (t: string) => Number((await db().query('SELECT balance_cents FROM credit_accounts WHERE tenant_id=$1', [t])).rows[0].balance_cents);

  const config = await (await call(0, 'config')).json();
  assert.equal(config.planCredits, 180); assert.equal(config.layouts.length, 2);
  const id = randomUUID();
  await call(0, 'projects', { id, name: '立领工作外套', layout: 'warm-impact', counts: { square: 2, portrait: 0, poster: 0 } });
  await call(0, 'projects', { id, name: '重复提交', layout: 'warm-impact', counts: { square: 2, portrait: 0, poster: 0 } });
  await call(1, 'projects', { id, name: '别人的编号', layout: 'warm-impact', counts: { square: 1, portrait: 0, poster: 0 } }, 409);
  await call(0, 'projects', { id: randomUUID(), name: '没有图', layout: 'warm-impact', counts: { square: 0, portrait: 0, poster: 0 } }, 400);
  const main = await image(800, 800, '#d99a2b'), sku = await image(600, 600, '#1f1f1f'), detail = await image(500, 900, '#eeeeee');
  const a1 = await (await upload(0, id, main, '1比1主图/主图_1.jpg')).json();
  assert.equal(a1.shape, '1:1');
  assert.equal((await (await upload(0, id, main, '1比1主图/主图_1.jpg')).json()).id, a1.id);
  await upload(0, id, sku, 'SKU图/黑色.jpg'); await upload(0, id, detail, '详情图/详情_01.jpg');
  await upload(1, id, sku, 'x.jpg', 404);
  await upload(0, id, Buffer.from('not an image'), 'bad.jpg', 400);
  await call(1, 'assets/' + a1.id, undefined, 404); await call(1, 'projects/' + id, undefined, 404);
  const file = (await db().query('SELECT file_id FROM listing_assets WHERE id=$1', [a1.id])).rows[0].file_id;
  await assert.rejects(() => db().query("UPDATE files SET gc_state='deleting' WHERE id=$1", [file]), /禁止回收/);
  const detailBefore = await (await call(0, 'projects/' + id)).json();
  const labelOf = (path: string) => detailBefore.images.find((i: { path: string }) => i.path === path).label as string;
  const [MAIN, SKU, DETAIL] = ['1比1主图/主图_1.jpg', 'SKU图/黑色.jpg', '详情图/详情_01.jpg'].map(labelOf);
  assert.deepEqual([MAIN, SKU, DETAIL].sort(), ['M1', 'M2', 'M3']);
  assert.equal(detailBefore.images.find((i: { label: string }) => i.label === DETAIL).shape, '其他');
  pass('上传：量出形状、同图不重复存、坏图拒收、跨租户读不到、文件不会被回收');

  await call(0, `projects/${id}/plan`, {}, 503);
  assert.equal(await balance(tenants[0]), 1000);
  await db().query("INSERT INTO listing_workers(id) VALUES($1)", [randomUUID()]);
  await call(1, `projects/${id}/plan`, {}, 404);
  assert.equal((await (await call(0, `projects/${id}/plan`, {})).json()).status, 'planning');
  assert.equal((await (await call(0, `projects/${id}/plan`, {})).json()).status, 'planning');
  assert.equal(await balance(tenants[0]), 820);
  await upload(0, id, await image(700, 700, '#123456'), '晚到的.jpg', 409);
  pass('后台没连上不冻结积分；冻结 180 积分只冻一次；开始分析后不能再加图');

  type Job = { id: string; tenant_id: string; project_id: string; step: string };
  const job = (await db().query("SELECT id,tenant_id,project_id,step FROM listing_jobs WHERE project_id=$1", [id])).rows[0] as Job;
  const good = JSON.stringify({
    assets: [{ id: MAIN, role: '主图' }, { id: SKU, role: 'SKU', color: '黑色' }, { id: DETAIL, role: '主图' }],
    product: { name: '立领工作外套', garment: ['立领', '两侧拉链口袋'], colors: [{ name: '黑色', hex: '#1f1f1f', sku: SKU }] },
    sellingPoints: [{ id: 'P1', type: '功能', text: '三防面料', evidence: [DETAIL], priority: 1 }],
    main: { square: [{ n: 1, role: '首图', title: '轻盈抗造工作服', points: ['P1'], colors: ['黑色'] }, { n: 2, role: '收口', title: '团队穿出同一范', colors: ['黑色'] }] },
    sku: { tag: '男女同款', items: [{ color: '黑色', sku: SKU }] },
  });
  let sent = 0;
  await executePlan(job, async (_request, hooks) => { await hooks.beforeSubmit(); sent++; await hooks.receipt('chatcmpl-test'); return { content: good, model: 'gpt-6.1-sol', requestId: 'chatcmpl-test', usage: null, durationMs: 1 }; });
  const planned = await (await call(0, 'projects/' + id)).json();
  assert.equal(planned.status, 'review'); assert.equal(sent, 1);
  assert.equal(planned.plan.plan.assets.find((a: { id: string }) => a.id === DETAIL).role, '详情');
  assert.deepEqual(planned.plan.corrected, [`${DETAIL} 主图→详情（形状不是 1:1 或 3:4）`]);
  assert.deepEqual(planned.plan.problems, []);
  assert.equal(planned.plan.images.length, 3);
  const hold = (await db().query("SELECT state,settled_cents FROM credit_holds WHERE id=$1", ['listing:' + job.id])).rows[0];
  assert.deepEqual([hold.state, Number(hold.settled_cents)], ['settled', 180]);
  assert.equal((await db().query("SELECT status,provider_request_id FROM listing_attempts WHERE job_id=$1", [job.id])).rows[0].provider_request_id, 'chatcmpl-test');
  assert.equal((await db().query("SELECT count(*)::int n FROM usage_events WHERE tenant_id=$1 AND metric_code='listing_plan'", [tenants[0]])).rows[0].n, 1);
  pass('分析成功：形状不对的“主图”改成详情，按 180 积分结算并记用量，回执编号已保存');

  await call(0, `projects/${id}/review`, { roles: { [SKU]: '详情' }, colors: [{ sku: SKU, name: '经典黑' }], points: [{ id: 'P1', text: '三防耐脏' }] });
  await call(1, `projects/${id}/review`, { roles: {} }, 409);
  await call(0, `projects/${id}/confirm`, {}, 409);
  await call(0, `projects/${id}/review`, { roles: {}, colors: [{ sku: SKU, name: '经典黑' }], points: [] });
  await call(0, `projects/${id}/confirm`, {});
  const confirmed = await (await call(0, 'projects/' + id)).json();
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.review.colors[0].name, '经典黑');
  await call(0, `projects/${id}/review`, { roles: {} }, 409);
  pass('确认：颜色图改成非 SKU 时拦住；改过的颜色名保存；确认后不能再改');

  const run = async (provider: Parameters<typeof executePlan>[1]) => {
    const pid = randomUUID();
    await call(0, 'projects', { id: pid, name: '失败验收', layout: 'commute-split', counts: { square: 1, portrait: 1, poster: 1 } });
    await upload(0, pid, main, 'a.jpg');
    await call(0, `projects/${pid}/plan`, {});
    const j = (await db().query("SELECT id,tenant_id,project_id,step FROM listing_jobs WHERE project_id=$1", [pid])).rows[0] as Job;
    await executePlan(j, provider);
    return { pid, job: j, project: await (await call(0, 'projects/' + pid)).json(), hold: (await db().query('SELECT state FROM credit_holds WHERE id=$1', ['listing:' + j.id])).rows[0].state };
  };
  const before = await balance(tenants[0]);
  const notSent = await run(async () => { throw new Error('读取素材失败'); });
  assert.equal(notSent.hold, 'released'); assert.equal(await balance(tenants[0]), before);
  assert.equal(notSent.project.status, 'failed'); assert.match(notSent.project.error, /未扣费/);
  await call(0, `projects/${notSent.pid}/plan`, {});
  pass('提交前失败：全额退回，商品可重新分析');
  const lost = await run(async (_r, hooks) => { await hooks.beforeSubmit(); throw new Error('连接中断'); });
  assert.equal(lost.hold, 'disputed'); assert.match(lost.project.error, /管理员核对/);
  assert.equal((await db().query('SELECT status FROM listing_attempts WHERE job_id=$1', [lost.job.id])).rows[0].status, 'unknown');
  pass('提交后中断：不重复调用，积分冻结待管理员裁定');
  const garbled = await run(async (_r, hooks) => { await hooks.beforeSubmit(); return { content: '{"assets":[]}', model: 'm', requestId: 'r', usage: null, durationMs: 1 }; });
  assert.equal(garbled.hold, 'settled'); assert.equal(garbled.project.status, 'failed'); assert.match(garbled.project.error, /已扣费/);
  pass('模型返回不完整：调用已发生按实扣费，商品标为失败可重试');

  await call(1, 'projects/' + id, undefined, 404, 'DELETE');
  await call(0, 'projects/' + id, undefined, 200, 'DELETE');
  await call(0, 'projects/' + id, undefined, 404);
  assert.ok(!(await (await call(0, 'projects')).json()).some((p: { id: string }) => p.id === id));
  pass('删除：别人删不了，删除后列表和详情都看不到');
  console.log(`COMPLETE ${checks} checks; no external provider called`);
} finally {
  await closeCatalogDatabase(); await database.stop().catch(() => {}); await rm(root, { recursive: true, force: true });
}
