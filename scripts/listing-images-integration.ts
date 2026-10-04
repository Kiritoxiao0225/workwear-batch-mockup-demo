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
process.env.EVOLINK_API_KEY = 'test-key-never-sent'; delete process.env.MEDIAKIT_API_KEY;
const database = new EmbeddedPostgres({ databaseDir: join(root, 'pg'), user: 'listing', password, port, persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} });
const { catalogDatabase: db, closeCatalogDatabase, migrateCatalog } = await import('../lib/server/catalog-database');
const { createCatalogUser, loginCatalog } = await import('../lib/server/catalog-auth');
const routes = await import('../app/api/listing/[...path]/route');
const { executePlan, startListingWorker } = await import('../lib/server/listing-jobs');
const { clearOldSources } = await import('../lib/server/listing-store');
const { executeImage } = await import('../lib/server/listing-generation');
const JSZip = (await import('jszip')).default;
let checks = 0; const pass = (s: string) => { checks++; console.log('PASS', s); };
try {
  await database.initialise(); await database.start(); await migrateCatalog();
  const tenants = [randomUUID(), randomUUID()], tokens: string[] = [];
  for (const [i, t] of tenants.entries()) {
    await db().query("INSERT INTO tenants(id,name,style_quota,storage_quota_bytes,workspace) VALUES($1,'电商主图验收',10,10000000,$2)", [t, 'lst-test-' + t]);
    await db().query('INSERT INTO tenant_usage(tenant_id) VALUES($1)', [t]);
    await db().query('INSERT INTO credit_accounts(tenant_id,balance_cents) VALUES($1,5000)', [t]);
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
  assert.equal(await balance(tenants[0]), 5000);
  await db().query("INSERT INTO listing_workers(id) VALUES($1)", [randomUUID()]);
  await call(1, `projects/${id}/plan`, {}, 404);
  assert.equal((await (await call(0, `projects/${id}/plan`, {})).json()).status, 'planning');
  assert.equal((await (await call(0, `projects/${id}/plan`, {})).json()).status, 'planning');
  assert.equal(await balance(tenants[0]), 4820);
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
  await call(0, `projects/${id}/review`, { roles: {}, colors: [{ sku: SKU, name: '经典黑' }], slots: { 'square:1': { title: '', subtitle: '', bullets: [] } } }, 400);
  await call(0, `projects/${id}/review`, { roles: {}, colors: [{ sku: SKU, name: '经典黑' }], points: [], slots: { 'square:1': { title: '轻盈抗造工作服', subtitle: '', bullets: ['三防'], scene: '模特站在雪地里' } } });
  await call(0, `projects/${id}/confirm`, {});
  const confirmed = await (await call(0, 'projects/' + id)).json();
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.review.colors[0].name, '经典黑');
  await call(0, `projects/${id}/review`, { roles: {} }, 409);
  pass('确认：颜色图改成非 SKU 时拦住；改过的颜色名保存；确认后不能再改');

  // ---- 第 2 期：出图 ----
  const estimate = (await (await call(0, 'projects/' + id)).json()).estimate;
  assert.deepEqual(estimate, { images: 4, credits: 4 * 44 });
  await call(1, `projects/${id}/generate`, {}, 404);
  const beforeRun = await balance(tenants[0]);
  assert.equal((await (await call(0, `projects/${id}/generate`, {})).json()).status, 'generating');
  assert.equal((await (await call(0, `projects/${id}/generate`, {})).json()).status, 'generating');
  type ImgJob = { id: string; tenant_id: string; project_id: string; run_id: string; slot: string; input: never };
  const jobs = (await db().query("SELECT id,tenant_id,project_id,run_id,slot,input,depends FROM listing_jobs WHERE project_id=$1 AND step<>'plan' ORDER BY created_at", [id])).rows as (ImgJob & { depends: string[] })[];
  assert.deepEqual(jobs.map(j => j.slot), [`product:${SKU}`, `sku:${SKU}`, 'square:1', 'square:2']);
  assert.equal(beforeRun - await balance(tenants[0]), 4 * 44);
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#222' } }).png().toBuffer();
  const seen: { slot: string; refs: number; prompt: string }[] = [];
  const fake = (slot: string, fail = false) => async (input: { prompt: string; references: Buffer[] }, hooks: { beforeSubmit: () => Promise<void>; receipt: (id: string) => Promise<void> }) => {
    seen.push({ slot, refs: input.references.length, prompt: input.prompt });
    await hooks.beforeSubmit(); await hooks.receipt('task-unified-' + slot.replace(':', '-'));
    if (fail) throw Object.assign(new Error('供应商判定失败'), { notCharged: true });
    return { bytes: png, taskId: 'task-unified-x', credits: 2, durationMs: 1 };
  };
  for (const j of jobs) await executeImage(j, fake(j.slot, j.slot === 'square:2'));
  assert.deepEqual(seen.map(s => `${s.slot}:${s.refs}`), [`product:${SKU}:1`, `sku:${SKU}:1`, 'square:1:1', 'square:2:1']);
  assert.match(seen[1].prompt, /颜色名「经典黑」/); assert.match(seen[2].prompt, /主标题「轻盈抗造工作服」/); assert.match(seen[2].prompt, /画面.*模特站在雪地里/);
  const runHold = (await db().query("SELECT state,settled_cents FROM credit_holds WHERE id=$1", ['listing:run:' + jobs[0].run_id])).rows[0];
  assert.deepEqual([runHold.state, Number(runHold.settled_cents)], ['settled', 3 * 44]);
  assert.equal(beforeRun - await balance(tenants[0]), 3 * 44);
  const done = (await (await call(0, 'projects')).json()).find((p: { id: string }) => p.id === id);
  assert.deepEqual([done.status, done.slots, done.made, done.broken], ['done', 4, 3, 1]);
  const failedSlot = (await (await call(0, 'projects/' + id)).json()).slots.find((s: { slot: string }) => s.slot === 'square:2');
  assert.match(failedSlot.error, /没扣费/);
  pass('出图：整套冻结 4 张，按依赖顺序出；供应商判定失败的那张不收费，结算 3 张，项目完成并标出 1 张没成功');

  await call(1, `projects/${id}/redo`, { slot: 'square:2', note: '' }, 404);
  await call(0, `projects/${id}/redo`, { slot: 'square:2', note: '背景更亮' });
  await call(0, `projects/${id}/redo`, { slot: 'square:2', note: '' }, 409);
  const redoJob = (await db().query("SELECT id,tenant_id,project_id,run_id,slot,input FROM listing_jobs WHERE project_id=$1 AND slot='square:2' AND status='queued'", [id])).rows[0] as ImgJob;
  await executeImage(redoJob, fake('square:2'));
  assert.match(seen.at(-1)!.prompt, /补充要求：背景更亮/);
  await call(0, `projects/${id}/redo`, { slot: 'square:1', note: '' });
  const again = (await db().query("SELECT id,tenant_id,project_id,run_id,slot,input FROM listing_jobs WHERE project_id=$1 AND slot='square:1' AND status='queued'", [id])).rows[0] as ImgJob;
  await executeImage(again, fake('square:1'));
  const after = await (await call(0, 'projects/' + id)).json();
  assert.equal(after.slots.find((s: { slot: string }) => s.slot === 'square:1').versions, 2);
  assert.equal(beforeRun - await balance(tenants[0]), 5 * 44);
  const mainFile = (await db().query("SELECT a.width,a.height,f.mime_type FROM listing_assets a JOIN files f ON f.id=a.file_id WHERE a.project_id=$1 AND a.slot='square:1' ORDER BY a.created_at DESC LIMIT 1", [id])).rows[0];
  assert.deepEqual([mainFile.width, mainFile.height, mainFile.mime_type], [1440, 1440, 'image/jpeg']);
  assert.equal((await db().query("SELECT a.receipt->>'upscaled' u FROM listing_attempts a JOIN listing_jobs j ON j.id=a.job_id WHERE j.id=$1", [again.id])).rows[0].u, 'plain');
  pass('放大：火山不可用时主图仍按普通放大存成 1440×1440 JPG，回执记下放大方式');
  pass('重做：别人重做不了、出图中不能重复重做；补充要求写进提示词；旧版本保留，每次重做只扣一张');

  // ---- 出图后改内容：整张重画、只改字、切回旧版本 ----
  const queuedJob = async (slot: string) => (await db().query("SELECT id,tenant_id,project_id,run_id,slot,input FROM listing_jobs WHERE project_id=$1 AND slot=$2 AND status='queued'", [id, slot])).rows[0] as ImgJob;
  const slotOf = async (slot: string) => (await (await call(0, 'projects/' + id)).json()).slots.find((s: { slot: string }) => s.slot === slot);
  let s1 = await slotOf('square:1');
  assert.equal(s1.history.length, 2); assert.equal(s1.image, s1.history[1].id); assert.equal(s1.words.scene, '模特站在雪地里');
  await call(0, `projects/${id}/redo`, { slot: 'square:1', mode: 'redraw', words: { title: '新标题', subtitle: '', bullets: ['耐磨'], scene: '工地上搬货' }, note: '' });
  await executeImage(await queuedJob('square:1'), fake('square:1'));
  assert.match(seen.at(-1)!.prompt, /主标题「新标题」/); assert.match(seen.at(-1)!.prompt, /工地上搬货/); assert.equal(seen.at(-1)!.refs, 1);
  assert.equal((await (await call(0, 'projects/' + id)).json()).review.slots['square:1'].title, '新标题');
  await call(0, `projects/${id}/redo`, { slot: 'square:1', mode: 'text', words: { title: 'x', subtitle: '', bullets: [] }, base: randomUUID() }, 404);
  await call(0, `projects/${id}/redo`, { slot: `sku:${SKU}`, mode: 'redraw', words: { title: 'x', subtitle: '', bullets: [] } }, 400);
  await call(0, `projects/${id}/redo`, { slot: 'square:1', mode: 'text', words: { title: '只改字', subtitle: '', bullets: ['耐磨'] }, base: s1.history[0].id });
  const textJob = await queuedJob('square:1');
  assert.equal((textJob.input as unknown as { edit: { base: string } }).edit.base, s1.history[0].id);
  await executeImage(textJob, fake('square:1'));
  assert.match(seen.at(-1)!.prompt, /只改文字/); assert.match(seen.at(-1)!.prompt, /主标题「轻盈抗造工作服」改成「只改字」/); assert.equal(seen.at(-1)!.refs, 1);
  assert.equal(beforeRun - await balance(tenants[0]), 7 * 44);
  s1 = await slotOf('square:1');
  assert.equal(s1.history.length, 4); assert.equal(s1.image, s1.history[3].id); assert.equal(s1.words.title, '只改字'); assert.equal(s1.words.scene, '模特站在雪地里');
  await call(1, `projects/${id}/current`, { slot: 'square:1', asset: s1.history[0].id }, 404);
  await call(0, `projects/${id}/current`, { slot: 'square:1', asset: s1.history[2].id });
  s1 = await slotOf('square:1');
  assert.equal(s1.image, s1.history[2].id); assert.equal(s1.words.title, '新标题');
  pass('改内容：按新字和新画面整张重画；只改字以选中的旧版为唯一参考图、单张价；可以切回任意旧版本，别人切不了');

  await call(1, `projects/${id}/download`, undefined, 404);
  const zip = await JSZip.loadAsync(Buffer.from(await (await call(0, `projects/${id}/download`)).arrayBuffer()));
  assert.deepEqual(Object.keys(zip.files).filter(n => !n.endsWith('/')).sort(), ['1比1主图-01-首图.jpg', '1比1主图-02-收口.jpg', 'SKU-经典黑.png', '白底产品图/经典黑.png']);
  pass('下载：按淘宝顺序命名，颜色用改过的名字，别人下载不了');

  // ---- 后台按依赖领任务：产品图结果不明时，依赖它的图都不做、不收费 ----
  const second = randomUUID();
  await call(0, 'projects', { id: second, name: '第二款', layout: 'commute-split', counts: { square: 1, portrait: 0, poster: 0 } });
  await upload(0, second, sku, 'SKU图/黑色.jpg'); await upload(0, second, main, '1比1主图/主图_1.jpg');
  await call(0, `projects/${second}/plan`, {});
  const plan2 = (await db().query("SELECT id,tenant_id,project_id,step FROM listing_jobs WHERE project_id=$1", [second])).rows[0] as Job;
  const d2 = await (await call(0, 'projects/' + second)).json();
  const [M_MAIN, M_SKU] = ['1比1主图/主图_1.jpg', 'SKU图/黑色.jpg'].map(path => d2.images.find((i: { path: string }) => i.path === path).label);
  await executePlan(plan2, async (_r, hooks) => { await hooks.beforeSubmit(); return { content: JSON.stringify({
    assets: [{ id: M_MAIN, role: '主图' }, { id: M_SKU, role: 'SKU', color: '黑色' }],
    product: { name: '第二款', garment: ['立领'], colors: [{ name: '黑色', hex: '#111', sku: M_SKU }] },
    sellingPoints: [], main: { square: [{ n: 1, role: '首图', title: '利落上岗', colors: ['黑色'] }] }, sku: { tag: '', items: [] } }), model: 'm', requestId: 'r', usage: null, durationMs: 1 }; });
  await call(0, `projects/${second}/confirm`, {});
  const beforeSecond = await balance(tenants[0]);
  await call(0, `projects/${second}/generate`, {});
  const calls: string[] = [];
  const worker = await startListingWorker({ concurrency: 2, generate: async (input, hooks) => {
    calls.push(input.prompt.slice(0, 12));
    await hooks.beforeSubmit(); throw new Error('连接中断');
  } });
  for (let i = 0; i < 60; i++) {
    if (!(await db().query("SELECT 1 FROM listing_jobs WHERE project_id=$1 AND status IN ('queued','running')", [second])).rowCount) break;
    await new Promise(r => setTimeout(r, 250));
  }
  await worker.close();
  const states = Object.fromEntries((await db().query("SELECT slot,status,error FROM listing_jobs WHERE project_id=$1 AND step<>'plan'", [second])).rows.map(r => [r.slot, `${r.status}|${r.error}`]));
  assert.equal(calls.length, 1);
  assert.match(states[`product:${M_SKU}`], /^unknown\|.*管理员核对/);
  assert.match(states[`sku:${M_SKU}`], /^failed\|前一步.*没扣费/); assert.match(states['square:1'], /^failed\|前一步.*没扣费/);
  const secondRun = (await db().query("SELECT h.state,h.confirmed_cents,h.unknown_cents FROM credit_holds h WHERE h.job_ref LIKE $1", [`listing:run:${second}:%`])).rows[0];
  assert.deepEqual([secondRun.state, Number(secondRun.confirmed_cents), Number(secondRun.unknown_cents)], ['disputed', 0, 44]);
  assert.equal((await (await call(0, 'projects/' + second)).json()).status, 'done');
  assert.equal(beforeSecond - await balance(tenants[0]), 3 * 44);
  pass('后台：按依赖顺序领任务，只提交了产品图；它结果不明时后面两张跳过不提交，只有这一张冻结待裁定');
  const redone = await (await call(0, `projects/${second}/redo`, { slot: `product:${M_SKU}`, note: '' })).json();
  assert.equal(redone.images, 3);
  assert.deepEqual((await db().query("SELECT slot FROM listing_jobs WHERE project_id=$1 AND status='queued' ORDER BY created_at", [second])).rows.map(r => r.slot), [`product:${M_SKU}`, `sku:${M_SKU}`, 'square:1']);
  pass('重做产品图时，因为它被跳过的 SKU 图和主图一起重新排队、一起冻结');
  // 重做的产品图做好之前，SKU 图不能拿旧图开工；做好后用的必须是新图。
  const old = (await db().query("SELECT file_id FROM listing_assets WHERE project_id=$1 AND slot=$2", [second, `product:${M_SKU}`])).rows;
  assert.equal(old.length, 0);
  const made: { order: string[]; productBytes?: Buffer; skuRef?: Buffer } = { order: [] };
  let shade = 0;
  const worker2 = await startListingWorker({ concurrency: 4, generate: async (input, hooks) => {
    const which = input.prompt.includes('白底产品图') && input.prompt.startsWith('从参考图') ? 'product' : input.prompt.includes('SKU 规格图') ? 'sku' : 'main';
    made.order.push(which);
    if (which === 'sku') made.skuRef = input.references[0];
    await hooks.beforeSubmit(); await hooks.receipt('task-unified-' + which);
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 10 * ++shade, g: 0, b: 0 } } }).png().toBuffer();
    if (which === 'product') made.productBytes = bytes;
    return { bytes, taskId: 't', credits: 1, durationMs: 1 };
  } });
  for (let i = 0; i < 80; i++) {
    if (!(await db().query("SELECT 1 FROM listing_jobs WHERE project_id=$1 AND status IN ('queued','running')", [second])).rowCount) break;
    await new Promise(r => setTimeout(r, 250));
  }
  await worker2.close();
  assert.deepEqual(made.order, ['product', 'sku', 'main']);
  assert.ok(made.skuRef && made.productBytes && made.skuRef.equals(made.productBytes));
  pass('连带重做按顺序执行：产品图做好之后 SKU 图才开工，用的是新做的产品图');

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
  const refused = await run(async (_r, hooks) => { await hooks.beforeSubmit(); throw Object.assign(new Error('分析接口 HTTP 400'), { definite: true }); });
  assert.equal(refused.hold, 'released'); assert.equal(refused.project.status, 'failed'); assert.match(refused.project.error, /接口拒绝.*未扣费/);
  pass('接口直接拒收（4xx）：没有产生费用，冻结的积分退回，可以重新分析');

  // ---- 大款：拼起来给 AI 看，几乎一样的图只看一次 ----
  const bigId = randomUUID();
  await call(0, 'projects', { id: bigId, name: '大款', layout: 'warm-impact', counts: { square: 1, portrait: 0, poster: 0 } });
  const solid = (r: number, g: number, b: number) => sharp({ create: { width: 300, height: 300, channels: 3, background: { r, g, b } } }).png().toBuffer();
  for (let i = 0; i < 60; i++) await upload(0, bigId, await solid(i * 4, 100, 240 - i * 3), `模特图/IMG_${i + 1}.png`);
  await upload(0, bigId, await solid(1, 100, 240), '模特图/IMG_1_连拍.png');
  await call(0, `projects/${bigId}/plan`, {});
  const bigJob = (await db().query("SELECT id,tenant_id,project_id,step FROM listing_jobs WHERE project_id=$1", [bigId])).rows[0] as Job;
  let texts = '';
  await executePlan(bigJob, async (request, hooks) => {
    texts = ((request as { messages: { content: unknown }[] }).messages[1].content as { type: string; text?: string }[]).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const sent = [...new Set(texts.match(/M\d+/g))];
    await hooks.beforeSubmit();
    return { content: JSON.stringify({ assets: sent.map((m, i) => ({ id: m, role: i === 0 ? 'SKU' : '主图', color: i === 0 ? '黑色' : '' })),
      product: { name: '大款', garment: ['立领'], colors: [{ name: '黑色', hex: '#111', sku: sent[0] }] }, sellingPoints: [],
      main: { square: [{ n: 1, role: '首图', title: '大款首图', colors: ['黑色'] }] }, sku: { tag: '', items: [] } }), model: 'm', requestId: 'r', usage: null, durationMs: 1 };
  });
  const bigPlan = await (await call(0, 'projects/' + bigId)).json();
  assert.equal(bigPlan.status, 'review');
  assert.match(texts, /【拼图：4 张 1:1 素材/); assert.ok((texts.match(/【/g) ?? []).length <= 48);
  assert.equal(bigPlan.plan.plan.assets.length, 61);
  const twin = bigPlan.plan.plan.assets.find((a: { reason: string }) => a.reason.startsWith('相似图'));
  assert.equal(bigPlan.images.find((i: { label: string }) => i.label === twin.id).path, '模特图/IMG_1_连拍.png'); assert.equal(twin.role, '不用');
  pass('大款：61 张中颜色相近的照片都保留，按需拼成宫格不超过 50 张图，每张都有分类；完全相同的副本只看一次，标为相似图可手动改回');

  // ---- 存储：出图 30 天后清掉原始素材；删除一款退还空间（别的款还在用的文件照样计入） ----
  const usage = async () => Number((await db().query('SELECT bytes_used FROM tenant_usage WHERE tenant_id=$1', [tenants[0]])).rows[0].bytes_used);
  const refs = async (fileId: string) => (await db().query("SELECT 1 FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2", [tenants[0], fileId])).rowCount;
  const fileOf = async (project: string, path: string) => (await db().query('SELECT file_id FROM listing_assets WHERE project_id=$1 AND rel_path=$2', [project, path])).rows[0].file_id as string;
  const skuFile = await fileOf(second, 'SKU图/黑色.jpg'), sourceMain = await fileOf(id, '1比1主图/主图_1.jpg');
  await db().query("UPDATE listing_projects SET updated_at=now()-interval '29 days' WHERE id=$1", [second]);
  assert.equal(await clearOldSources(), 0);
  await db().query("UPDATE listing_projects SET updated_at=now()-interval '31 days' WHERE id=$1", [second]);
  const outputsBefore = (await db().query("SELECT count(*)::int n FROM listing_assets WHERE project_id=$1 AND kind<>'source'", [second])).rows[0].n;
  assert.equal(await clearOldSources(), 1);
  assert.equal((await db().query("SELECT count(*)::int n FROM listing_assets WHERE project_id=$1 AND kind='source'", [second])).rows[0].n, 0);
  assert.equal((await db().query("SELECT count(*)::int n FROM listing_assets WHERE project_id=$1 AND kind<>'source'", [second])).rows[0].n, outputsBefore);
  assert.ok((await (await call(0, 'projects')).json()).find((p: { id: string }) => p.id === second).sources_cleared_at);
  assert.equal(await refs(skuFile), 1);
  assert.equal(await clearOldSources(), 0);
  pass('清理：最后一次出图满 30 天才清原始素材，生成的图都在；同一张图别的款还在用就照样计入空间');
  const usedBefore = await usage();
  await call(1, 'projects/' + id, undefined, 404, 'DELETE');
  const deleted = await (await call(0, 'projects/' + id, undefined, 200, 'DELETE')).json();
  assert.ok(deleted.freedBytes > 0); assert.equal(usedBefore - await usage(), deleted.freedBytes);
  assert.equal(await refs(skuFile), 0); assert.equal(await refs(sourceMain), 1);
  await call(0, 'projects/' + id, undefined, 404);
  assert.ok(!(await (await call(0, 'projects')).json()).some((p: { id: string }) => p.id === id));
  pass('删除：别人删不了，删除后列表和详情都看不到；退还空间，别的款还在用的文件照样计入');
  console.log(`COMPLETE ${checks} checks; no external provider called`);
} finally {
  await closeCatalogDatabase(); await database.stop().catch(() => {}); await rm(root, { recursive: true, force: true });
}
