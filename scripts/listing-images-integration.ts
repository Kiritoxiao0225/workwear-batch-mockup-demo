// 电商主图验收：上传、租户隔离、积分冻结/结算/退回、AI 整理素材、卖点上图、写画面、先出方图再出竖版、画板改图、换模特、加一套首图、店铺服务图、点图修改、学版式（模拟供应商）。不调用任何付费接口。
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
import type { Materials } from '../lib/listing/api-types';
import type { Draft } from '../lib/listing/draft';
import { draftVersions } from '../lib/listing/sku-versions';
import type { Layout, Template } from '../lib/listing/templates';
const root = await mkdtemp(join(tmpdir(), 'listing-')), probe = createServer();
await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
const password = randomBytes(24).toString('hex');
process.env.CATALOG_DATABASE_URL = `postgresql://listing:${password}@127.0.0.1:${port}/postgres`;
process.env.CATALOG_DATABASE_CA_CERT = ''; process.env.CATALOG_LOCAL_OBJECT_ROOT = join(root, 'objects');
process.env.CATALOG_APP_ORIGIN = 'http://localhost:3189'; delete process.env.CATALOG_AUTH_MODE;
process.env.EVOLINK_API_KEY = 'test-key-never-sent'; delete process.env.MEDIAKIT_API_KEY;
// Every model call that is not mocked goes to the relay at an address that does not exist: nothing leaves the machine.
process.env.LISTING_IMAGE_PROVIDER = 'cliproxy'; process.env.LISTING_PLAN_PROVIDER = 'cliproxy';
process.env.CLIPROXY_API_KEY = 'test-key-never-sent'; process.env.CLIPROXY_API_BASE_URL = 'https://relay.invalid/v1';
const database = new EmbeddedPostgres({ databaseDir: join(root, 'pg'), user: 'listing', password, port, persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} });
const { catalogDatabase: db, closeCatalogDatabase, migrateCatalog } = await import('../lib/server/catalog-database');
const { createCatalogUser, loginCatalog } = await import('../lib/server/catalog-auth');
const routes = await import('../app/api/listing/[...path]/route');
const { executePlan, executeWrite, startListingWorker } = await import('../lib/server/listing-jobs');
const { clearOldSources } = await import('../lib/server/listing-store');
const { executeImage } = await import('../lib/server/listing-generation');
const { defaultDraft, draftImages, fillParts, reusedSlots, usedSlots } = await import('../lib/listing/draft');
const { BUILT_IN_LAYOUTS } = await import('../lib/listing/templates');
const { LEGACY_LAYOUTS } = await import('../lib/listing/legacy-layouts');
const { TASK_LABEL, TASKS } = await import('../lib/listing/category');
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
    const response = await routes[method](req, { params: Promise.resolve({ path: path.split('?')[0].split('/') }) });
    assert.equal(response.status, expected, response.status === expected ? '' : await response.text()); return response;
  }
  const image = (w: number, h: number, color: string) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
  const upload = (index: number, project: string, bytes: Buffer, path: string, expected = 200) =>
    call(index, `projects/${project}/images`, bytes, expected, 'POST', { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(path.split('/').at(-1)!), 'x-file-path': encodeURIComponent(path) });
  const balance = async (t: string) => Number((await db().query('SELECT balance_cents FROM credit_accounts WHERE tenant_id=$1', [t])).rows[0].balance_cents);
  const detailOf = async (project: string) => (await call(0, 'projects/' + project)).json();

  const config = await (await call(0, 'config')).json();
  assert.deepEqual([config.planCredits, config.planCostMicro, config.planMultiplierMilli], [180, 90000, 2000]); assert.equal(config.layouts.length, 5);
  assert.ok(config.layouts.every((l: Layout) => TASKS.every(t => l.templates[t]?.square.zones.length) && l.long.zones.length && l.sku.zones.length));
  const unit = config.imageCredits as number, multiUnit = config.multiCredits as number;
  const costOf = (items: { multi: boolean; free: boolean }[]) => items.reduce((n, i) => n + (i.free ? 0 : i.multi ? multiUnit : unit), 0);
  const counts = (square: number, portrait = 0, long = 0) => ({ square, portrait, long });
  const commute = BUILT_IN_LAYOUTS.find(l => l.id === 'M3')!;
  pass('配置：5 套冲锋衣母版，每类图都有 1:1、3:4 排法，另有长图和 SKU 图');

  const id = randomUUID();
  await call(0, 'projects', { id, name: '立领工作外套', layout: 'M3', counts: counts(3, 2, 1) });
  await call(0, 'projects', { id, name: '重复提交', layout: 'M3', counts: counts(3, 2, 1) });
  await call(1, 'projects', { id, name: '别人的编号', layout: 'M3', counts: counts(1) }, 409);
  await call(0, 'projects', { id: randomUUID(), name: '没有图', layout: 'M3', counts: counts(0) }, 400);
  await call(0, 'projects', { id: randomUUID(), name: '竖版比方图多', layout: 'M3', counts: counts(1, 2) }, 400);
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
  const detailBefore = await detailOf(id);
  const labelOf = (path: string) => detailBefore.sources.find((i: { path: string }) => i.path === path).label as string;
  const [MAIN, SKU, DETAIL] = ['1比1主图/主图_1.jpg', 'SKU图/黑色.jpg', '详情图/详情_01.jpg'].map(labelOf);
  assert.deepEqual([MAIN, SKU, DETAIL].sort(), ['M1', 'M2', 'M3']);
  assert.equal(detailBefore.images, 3);
  assert.equal(detailBefore.sources.find((i: { label: string }) => i.label === DETAIL).shape, '其他');
  pass('上传：量出形状、同图不重复存、坏图拒收、跨租户读不到、文件不会被回收');

  await call(0, `projects/${id}/plan`, {}, 503);
  assert.equal(await balance(tenants[0]), 5000);
  await db().query("INSERT INTO listing_workers(id) VALUES($1)", [randomUUID()]);
  await call(1, `projects/${id}/plan`, {}, 404);
  assert.equal((await (await call(0, `projects/${id}/plan`, {})).json()).status, 'planning');
  assert.equal((await (await call(0, `projects/${id}/plan`, {})).json()).status, 'planning');
  // 整理素材 by its 3 images (plan-price.ts): 180 to start, 1.5 an image, rounded up.
  assert.equal(await balance(tenants[0]), 5000 - 185);
  await upload(0, id, await image(700, 700, '#123456'), '晚到的.jpg', 409);
  pass('后台没连上不冻结积分；按张数冻结（3 张 185 积分）只冻一次；开始分析后不能再加图');

  type Job = { id: string; tenant_id: string; project_id: string; step: string };
  type ImgJob = { id: string; tenant_id: string; project_id: string; run_id: string; slot: string; input: never; depends: string[] };
  type Reply = { content: string; model: string; requestId: string; usage: null; durationMs: number };
  const reply = (content: unknown): Reply => ({ content: JSON.stringify(content), model: 'gpt-6.1-sol', requestId: 'chatcmpl-test', usage: null, durationMs: 1 });
  const latest = async (project: string, step: string) => (await db().query("SELECT id,tenant_id,project_id,step FROM listing_jobs WHERE project_id=$1 AND step=$2 ORDER BY created_at DESC LIMIT 1", [project, step])).rows[0] as Job;
  const imageJobs = async (project: string, queued = false) => (await db().query(`SELECT id,tenant_id,project_id,run_id,slot,input,depends FROM listing_jobs WHERE project_id=$1 AND step NOT IN ('plan','write')${queued ? " AND status='queued'" : ''} ORDER BY created_at`, [project])).rows as ImgJob[];
  /** The plan the page starts from: the AI's material, the layout's images; colours without a garment image left out (the page asks for one). */
  const draftFrom = (m: Materials, layout: Layout, c: Draft['counts']): Draft => {
    const d = fillParts(defaultDraft({ category: m.category, categoryWhy: m.categoryWhy, checks: m.checks, titles: m.titles, points: m.sorted.points, colors: m.chosen.colors, parts: m.chosen.parts }, layout, c), m.sorted.images);
    return { ...d, colors: d.colors.filter(x => x.pick), slots: d.slots.map(s => ({ ...s, title: s.title || '利落上岗' })), long: { title: d.long.title || '利落上岗' } };
  };
  const roundOf = (d: Draft, layout: Layout, r: 1 | 2, direct = new Set<string>()) => draftImages(d, layout, direct).filter(i => i.round === r);
  /** Sort (paid), start from the plan (credits held), write the pictures (free): a folder becomes queued images. */
  const toGenerating = async (project: string, organized: unknown, draft: (m: Materials) => Draft, written: unknown) => {
    await executePlan(await latest(project, 'plan'), async (_r, hooks) => { await hooks.beforeSubmit(); return reply(organized); });
    const d = draft((await detailOf(project)).materials);
    await call(0, `projects/${project}/start`, d);
    let request: unknown;
    await executeWrite(await latest(project, 'write'), async (r, hooks) => { request = r; await hooks.beforeSubmit(); return reply(written); });
    return { draft: d, request: JSON.stringify(request) };
  };

  // ---- 整理素材：分类、认颜色、卖点对上品类的卖点种类和画法、判品类、看衣服、写概括标题 ----
  const job = (await db().query("SELECT id,tenant_id,project_id,step FROM listing_jobs WHERE project_id=$1", [id])).rows[0] as Job;
  let sent = 0;
  await executePlan(job, async (_request, hooks) => { await hooks.beforeSubmit(); sent++; await hooks.receipt('chatcmpl-test'); return reply({
    images: [{ id: MAIN, kind: '卖点图', color: '黑色', front: true, text: true }, { id: SKU, kind: '颜色款图', color: '黑色', front: true }, { id: DETAIL, kind: '细节特写', detail: '门襟拉链' }],
    colors: [{ name: '黑色', hex: '#1f1f1f', from: [SKU] }, { name: '藏青', hex: '#1d2a44', from: [] }],
    points: [{ type: '定位', text: '轻盈抗造工作服', from: [MAIN] }, { type: '面料', text: '三防面料', note: '防水防油防污', from: [DETAIL], concept: 'triple' },
      { type: '做工', text: '顺滑拉链', from: [DETAIL], concept: 'zipper', part: '门襟拉链' }, { type: '服务定制', text: '企业团体定制', from: [MAIN], concept: 'logo' },
      { type: '功能', text: '乱写的种类', concept: 'no-such-kind', proof: 'no-such-proof' }],
    notes: ['色卡里有藏青，但没有藏青的衣服图'], category: 'workwear', categoryWhy: '素材写了企业团体定制',
    checks: [{ concept: 'windproof', seen: '看不出', why: '面料厚度看不出' }, { concept: 'no-such-kind', seen: '有' }], titles: { 功能: ['三防面料 雨天不怕'], 不存在: ['x'] } }); });
  const sortedP = await detailOf(id);
  const m1 = sortedP.materials as Materials;
  assert.equal(sortedP.status, 'materials'); assert.equal(sent, 3); // the colour list, one batch sorted, the reading assert.equal(sortedP.plan, null); assert.equal(sortedP.round, 0);
  assert.deepEqual(m1.chosen.colors.map(c => [c.name, c.pick]), [['黑色', SKU], ['藏青', null]]);
  assert.equal(m1.chosen.parts[0].pick, SKU);
  assert.equal(m1.sorted.points[1].note, '防水防油防污');
  assert.deepEqual([m1.category, m1.checks!.map(c => c.concept), Object.keys(m1.titles!)], ['workwear', ['windproof'], ['功能']]);
  const wild = m1.sorted.points.find(p => p.text === '乱写的种类')!;
  assert.deepEqual([wild.concept, wild.proof], [null, '']);
  assert.equal(m1.images.length, 3);
  const hold = (await db().query("SELECT state,settled_cents FROM credit_holds WHERE id=$1", ['listing:' + job.id])).rows[0];
  assert.deepEqual([hold.state, Number(hold.settled_cents)], ['settled', 185]);
  assert.equal((await db().query("SELECT status,provider_request_id FROM listing_attempts WHERE job_id=$1", [job.id])).rows[0].provider_request_id, 'chatcmpl-test');
  assert.equal((await db().query("SELECT count(*)::int n FROM usage_events WHERE tenant_id=$1 AND metric_code='listing_plan'", [tenants[0]])).rows[0].n, 1);
  pass('整理素材：AI 分类、认颜色（缺图的颜色也列出）、判品类、对不上的卖点种类和画法丢掉；程序挑每色的图和正面全身；按冻结的 185 积分结算并记用量');

  // ---- 卖点上图：开始出图只冻结第一轮（方图）的积分；写画面免费，写完自动出图 ----
  const plan = draftFrom(m1, commute, counts(3, 2, 1)), used = usedSlots(plan, 3), cover = plan.slots[used[0]];
  assert.equal(plan.category, 'workwear'); assert.equal(used.length, 3);
  const bad = (patch: Partial<Draft>) => call(0, `projects/${id}/start`, { ...plan, ...patch }, 400);
  await bad({ colors: [...plan.colors, { name: '藏青', hex: '', pick: null }] });
  await bad({ parts: plan.parts.map(p => p.part === '正面全身' ? { ...p, pick: null } : p) });
  await bad({ colors: [{ name: '黑色', hex: '', pick: 'M99' }] });
  assert.equal((await (await bad({ slots: plan.slots.map((s, i) => i === used[0] ? { ...s, title: '' } : s) })).json()).error, '第 1 张还没有大标题');
  await bad({ extra: [{ color: '黑色', layout: '' }] });
  await bad({ counts: counts(3, 4, 1) });
  const tooLong = await (await bad({ slots: plan.slots.map((s, i) => i === 0 ? { ...s, sub: '落霞橙 北欧蓝 空间灰 黑色 希望绿 爱马仕橙 石苔灰 云朵白 浅蓝色 蓝色' } : s) })).json();
  assert.equal(tooLong.error, '第 1 张图的小字太长了，请删短一点');
  await call(1, `projects/${id}/start`, plan, 404);
  const first = roundOf(plan, commute, 1);
  assert.ok(first.some(i => i.slot === 'cast'));
  const beforeRun = await balance(tenants[0]);
  assert.equal((await (await call(0, `projects/${id}/start`, plan)).json()).status, 'writing');
  assert.equal((await (await call(0, `projects/${id}/start`, plan)).json()).status, 'writing');
  assert.equal(beforeRun - await balance(tenants[0]), costOf(first));
  let writeRequest = '';
  await executeWrite(await latest(id, 'write'), async (request, hooks) => {
    writeRequest = JSON.stringify(request); await hooks.beforeSubmit();
    return reply({ product: { name: '立领工作外套', garment: ['立领', '两侧拉链口袋'] }, scenes: [{ key: 'square:1', scene: '写字楼大堂，暖色侧光' }, { key: 'portrait:1', scene: '写字楼大堂，竖构图' }], sku: { tag: '男女同款', fabric: '' } });
  });
  const planned = await detailOf(id);
  assert.deepEqual([planned.status, planned.round, planned.plan.layout, planned.plan.slots[used[0]].title], ['generating', 1, 'M3', cover.title]);
  assert.match(writeRequest, /素材里没有背面图，画面不要出现背面角度/); assert.match(writeRequest, /颜色「黑色」的衣服图/);
  assert.ok(writeRequest.includes(`square:1：${TASK_LABEL[cover.task]}`) && writeRequest.includes(`大标题「${cover.title}」`) && writeRequest.includes('portrait:2：'));
  assert.equal(beforeRun - await balance(tenants[0]), costOf(first));
  pass('卖点上图：缺颜色图、缺正面全身、不存在的图、没写大标题、竖版比方图多、加套颜色不对都拦住；开始出图只冻结第一轮，写画面不另收费，写完自动排队');

  // ---- 第一轮：白底图、定妆照、SKU 图、方图；出完停在「方图已出」 ----
  const jobs = await imageJobs(id);
  assert.deepEqual(jobs.map(j => j.slot), first.map(i => i.slot));
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#222' } }).png().toBuffer();
  const seen: { slot: string; refs: number; prompt: string; mask: boolean }[] = [];
  const fake = (slot: string, fail = false) => async (input: { prompt: string; references: Buffer[]; mask?: Buffer }, hooks: { beforeSubmit: () => Promise<void>; receipt: (id: string) => Promise<void> }) => {
    seen.push({ slot, refs: input.references.length, prompt: input.prompt, mask: !!input.mask });
    await hooks.beforeSubmit(); await hooks.receipt('task-unified-' + slot.replace(':', '-'));
    if (fail) throw Object.assign(new Error('供应商判定失败'), { notCharged: true });
    return { bytes: png, taskId: 'task-unified-x', credits: 2, durationMs: 1 };
  };
  const looked: string[] = [];
  const recognize = async (request: object) => {
    looked.push(JSON.stringify(request));
    return reply({ elements: [{ zone: 'title1', kind: 'title', box: [4, 5, 40, 10], text: '图上读到的标题' }, { zone: null, kind: 'icon', box: [85, 85, 10, 10], label: '小图标' }, { zone: 'title1', kind: 'title', box: [0, 0, 0.5, 3] }] });
  };
  const make = (j: ImgJob, fail = false) => executeImage(j, fake(j.slot, fail), undefined, recognize);
  for (const j of jobs) await make(j, j.slot === 'square:2');
  const prompt = (slot: string) => seen.filter(s => s.slot === slot).at(-1)!;
  assert.match(prompt('cast').prompt, /模特定妆照/); assert.equal(prompt('cast').refs, 1);
  // SKU images are put together on the template: no model call, nothing charged, a 1200 px JPEG.
  assert.equal(seen.some(s => s.slot.startsWith('sku:')), false);
  const skuImage = (await db().query(`SELECT a.width,f.mime_type FROM listing_assets a JOIN files f ON f.id=a.file_id WHERE a.project_id=$1 AND a.slot=$2`, [id, `sku:${SKU}`])).rows[0];
  assert.deepEqual([skuImage.width, skuImage.mime_type], [1200, 'image/jpeg']);
  const coverHasPeople = commute.templates[cover.task].square.people > 0;
  // A master's square images follow its spec (listing-specs.ts): its sample image is the last reference.
  assert.ok(prompt('square:1').prompt.includes(`一套 3 张里的第 1 张：${TASK_LABEL[cover.task]}`) && prompt('square:1').prompt.includes(`「${cover.title}」`) && prompt('square:1').prompt.includes('写字楼大堂，暖色侧光'));
  assert.match(prompt('square:1').prompt, /参考图\d：(这套母版的示例图|一张同类商品卖得很好的主图)/);
  assert.equal(prompt('square:1').refs, (coverHasPeople ? 2 : 1) + 1);
  // Recognition only serves the 画板, which the page no longer shows: new images are not read.
  assert.equal(looked.length, 0);
  assert.equal((await db().query("SELECT count(*)::int n FROM listing_attempts a JOIN listing_jobs j ON j.id=a.job_id WHERE j.project_id=$1 AND j.step NOT IN ('plan','write')", [id])).rows[0].n, jobs.filter(j => !j.slot.startsWith('sku:')).length);
  const paid = first.filter(i => i.slot !== 'square:2');
  const runHold = (await db().query("SELECT state,settled_cents FROM credit_holds WHERE id=$1", ['listing:run:' + jobs[0].run_id])).rows[0];
  assert.deepEqual([runHold.state, Number(runHold.settled_cents)], ['settled', costOf(paid)]);
  assert.equal(beforeRun - await balance(tenants[0]), costOf(paid));
  const listed = (await (await call(0, 'projects')).json()).find((p: { id: string }) => p.id === id);
  assert.deepEqual([listed.status, listed.round, listed.slots, listed.made, listed.broken], ['square', 1, jobs.length, jobs.length - 1, 1]);
  const slotOf = async (project: string, slot: string) => (await detailOf(project)).slots.find((s: { slot: string }) => s.slot === slot);
  assert.match((await slotOf(id, 'square:2')).error, /没扣费/);
  let s1 = await slotOf(id, 'square:1');
  assert.equal(s1.task, cover.task); assert.deepEqual(s1.colors, ['黑色']);
  assert.match(prompt('square:1').prompt, /胸口左侧印一个白色「LOGO」字样，宽约 8–10 厘米/);
  const mainFile = (await db().query("SELECT a.width,a.height,f.mime_type FROM listing_assets a JOIN files f ON f.id=a.file_id WHERE a.project_id=$1 AND a.slot='square:1' ORDER BY a.created_at DESC LIMIT 1", [id])).rows[0];
  assert.deepEqual([mainFile.width, mainFile.height, mainFile.mime_type], [1440, 1440, 'image/jpeg']);
  pass('第一轮：白底图 → 定妆照 → SKU 图（按模板拼，不调模型不收费）→ 方图按依赖出；有人的图带上定妆照；供应商判定失败的那张不收费；出完停在方图，等用户出竖版');
  pass('主图：胸口按方案印「LOGO」；放大成 1440 JPG；不再逐张认图');

  await call(1, `projects/${id}/redo`, { slot: 'square:2', note: '' }, 404);
  await call(0, `projects/${id}/redo`, { slot: 'square:2', note: '背景更亮' });
  await call(0, `projects/${id}/redo`, { slot: 'square:2', note: '' }, 409);
  const [redoJob] = await imageJobs(id, true);
  assert.equal(redoJob.slot, 'square:2');
  await make(redoJob);
  assert.match(prompt('square:2').prompt, /补充要求：背景更亮/);
  assert.equal((await detailOf(id)).status, 'square');
  assert.equal(beforeRun - await balance(tenants[0]), costOf(paid) + unit);
  pass('重做：别人重做不了、出图中不能重复重做；补充要求写进提示词；只扣一张，出完回到方图');

  // ---- 画板：框里重画、贴回原图；方图改过的字是竖版的依据；可以切回旧版 ----
  const edit = { slot: 'square:1', base: s1.image, mode: 'text', zone: 'title1', box: [4, 5, 40, 10], text: '画板改的标题' };
  await call(1, `projects/${id}/edit`, edit, 404);
  await call(0, `projects/${id}/edit`, { ...edit, base: randomUUID() }, 404);
  assert.equal((await (await call(0, `projects/${id}/edit`, { ...edit, mode: 'free' }, 400)).json()).error, '写一下框里要画什么');
  await call(0, `projects/${id}/edit`, { ...edit, mode: 'move' }, 400);
  await call(0, `projects/${id}/edit`, { ...edit, mode: 'cell', zone: 'card1', point: 'no-such-point' }, 400);
  await call(0, `projects/${id}/edit`, { ...edit, slot: `sku:${SKU}` }, 400);
  await call(0, `projects/${id}/edit`, edit);
  await call(0, `projects/${id}/edit`, edit, 409);
  const [editJob] = await imageJobs(id, true);
  await make(editJob);
  const e = prompt('square:1');
  assert.ok(e.mask); assert.equal(e.refs, 1);
  assert.match(e.prompt, /只重画遮罩透明的那一块（区域 左4% 上5% 宽40% 高10%）/); assert.match(e.prompt, /把这里原来的字换成「画板改的标题」/);
  const pasted = (await db().query("SELECT a.width,a.height,t.receipt->>'upscaled' u FROM listing_assets a JOIN listing_attempts t ON t.job_id=a.job_id WHERE a.job_id=$1", [editJob.id])).rows[0];
  assert.deepEqual([pasted.width, pasted.height, pasted.u], [1440, 1440, 'pasted']);
  assert.equal(looked.length, 1); assert.match(looked[0], /设计说明/);
  assert.deepEqual((await slotOf(id, 'square:1')).history[1].elements, [{ id: 'title1', kind: 'title', box: [4, 5, 40, 10], text: '图上读到的标题', zone: 'title1' }, { id: 'x2', kind: 'other', box: [85, 85, 10, 10], label: '小图标' }]);
  s1 = await slotOf(id, 'square:1');
  assert.equal(s1.history.length, 2); assert.equal(s1.image, s1.history[1].id); assert.equal(s1.history[1].change, '改字：画板改的标题'); assert.equal(s1.words.title, '画板改的标题');
  const afterEdit = await detailOf(id);
  assert.deepEqual([afterEdit.status, afterEdit.plan.slots[used[0]].title], ['square', '画板改的标题']);
  assert.equal(beforeRun - await balance(tenants[0]), costOf(paid) + 2 * unit);
  await call(1, `projects/${id}/current`, { slot: 'square:1', asset: s1.history[0].id }, 404);
  await call(0, `projects/${id}/current`, { slot: 'square:1', asset: s1.history[0].id });
  assert.equal((await slotOf(id, 'square:1')).image, s1.history[0].id);
  await call(0, `projects/${id}/current`, { slot: 'square:1', asset: s1.history[1].id });
  pass('画板：别人改不了、没写要画什么或没拖到新位置不提交、旧版不存在报错；只重画框里那块并贴回原图；改过的字记进方案；单张价；可以切回旧版');

  // ---- 第二轮「出竖版」：3:4 照着方图改过的字，加 2:3 长图 ----
  await call(1, `projects/${id}/verticals`, {}, 404);
  const second = roundOf(afterEdit.plan, commute, 2), beforeV = await balance(tenants[0]);
  assert.equal((await (await call(0, `projects/${id}/verticals`, {})).json()).images, second.length);
  await call(0, `projects/${id}/verticals`, {}, 409);
  assert.equal(beforeV - await balance(tenants[0]), costOf(second));
  const vjobs = await imageJobs(id, true);
  assert.deepEqual(vjobs.map(j => j.slot), ['portrait:1', 'portrait:2', 'long:1']);
  for (const j of vjobs) await make(j);
  // A 3:4 image is its square one (as the user left it) laid out again; the cover has people, so the white image comes too.
  assert.ok(prompt('portrait:1').prompt.includes('重新排成竖版 3:4') && prompt('portrait:1').prompt.includes('参考图2是这件衣服的白底产品图'));
  assert.equal(prompt('portrait:1').refs, 2);
  assert.equal((await slotOf(id, 'portrait:1')).words.title, '画板改的标题');
  assert.match(prompt('long:1').prompt, /竖版 2:3 长图，放在手淘推荐流里/);
  const done = await detailOf(id);
  assert.deepEqual([done.status, done.round], ['done', 2]);
  pass('出竖版：方图出完才能出、只能出一次；3:4 拿改好的方图重排（有人的图加白底图）；2:3 长图按推荐流写；冻结第二轮积分，出完项目完成');

  // ---- 换一组模特：新定妆照，有人的图整张重画（不重复画板改动） ----
  const beforeCast = await balance(tenants[0]);
  await call(1, `projects/${id}/cast`, {}, 404);
  const recast = await (await call(0, `projects/${id}/cast`, {})).json();
  await call(0, `projects/${id}/cast`, {}, 409);
  const cjobs = await imageJobs(id, true);
  assert.equal(cjobs[0].slot, 'cast'); assert.equal(recast.images, cjobs.length);
  // The SKU images are put together again (free) from their models drawn from the new cast.
  const cards = cjobs.filter(j => j.slot.startsWith('sku:'));
  // So are the 3:4 images laid out from a square image that is redrawn.
  const relaid = cjobs.filter(j => (j.input as { kind: string }).kind === 'relayout');
  assert.ok(cjobs.every(j => j.slot === 'cast' || j.depends.includes('cast') || cards.includes(j) || relaid.includes(j)));
  assert.ok(relaid.every(j => cjobs.some(q => q.slot === (j.input as { from: string }).from)));
  assert.ok(cards.length > 0 && cards.every(j => cjobs.some(q => q.slot === `skumodel:${j.slot.slice(4)}`)));
  assert.equal(cjobs.some(j => j.slot === 'square:1'), coverHasPeople);
  assert.equal(beforeCast - await balance(tenants[0]), (cjobs.length - cards.length) * unit);
  for (const j of cjobs) await make(j);
  if (coverHasPeople) { assert.ok(!prompt('square:1').mask); assert.match(prompt('square:1').prompt, /「画板改的标题」/); }
  assert.equal((await detailOf(id)).status, 'done');
  pass('换模特：先出新定妆照，再把有人的图按现在的字整张重画，竖版跟着重排；出图中不能再换');

  // ---- SKU 图全部重做：没有模特图的颜色重画模特（收费），再按模板重拼（免费） ----
  const beforeSkus = await balance(tenants[0]);
  await call(1, `projects/${id}/skus`, {}, 404);
  const redoneSkus = await (await call(0, `projects/${id}/skus`, {})).json();
  const skuJobs = await imageJobs(id, true), models = skuJobs.filter(j => j.slot.startsWith('skumodel:'));
  assert.equal(redoneSkus.images, skuJobs.length);
  assert.ok(models.length > 0 && skuJobs.every(j => j.slot.startsWith('sku:') || j.slot.startsWith('skumodel:')));
  assert.ok(skuJobs.filter(j => j.slot.startsWith('sku:')).every(j => j.depends.includes(`skumodel:${j.slot.slice(4)}`)));
  assert.equal(beforeSkus - await balance(tenants[0]), models.length * unit);
  for (const j of skuJobs) await make(j);
  assert.equal((await detailOf(id)).status, 'done');
  // SKU models wear the garment as it is: no chest LOGO, whatever the plan prints on the main images (10-21).
  const skuModelPrompt = prompt(models[0].slot);
  assert.match(skuModelPrompt.prompt, /胸口不另外印字/); assert.doesNotMatch(skuModelPrompt.prompt, /LOGO/);
  pass('SKU 图全部重做：没有模特图的颜色照定妆照重画模特（每色一张的钱），SKU 图跟着免费重拼；SKU 模特胸口不印 LOGO');

  await call(1, `projects/${id}/download`, undefined, 404);
  const zip = await JSZip.loadAsync(Buffer.from(await (await call(0, `projects/${id}/download`)).arrayBuffer()));
  const names = Object.keys(zip.files).filter(n => !n.endsWith('/'));
  for (const n of ['模特定妆照.png', 'SKU-黑色.jpg', '白底产品图/黑色.png', '2比3长图.jpg', `1比1主图-01-${TASK_LABEL[cover.task]}.jpg`]) assert.ok(names.includes(n), n);
  assert.deepEqual([names.filter(n => n.startsWith('1比1主图-')).length, names.filter(n => n.startsWith('3比4主图-')).length], [3, 2]);
  pass('下载：按淘宝顺序命名，带定妆照和长图，别人下载不了');

  // ---- 后台按依赖领任务：产品图结果不明时，依赖它的图都不做、不收费 ----
  const two = randomUUID();
  await call(0, 'projects', { id: two, name: '第二款', layout: 'M3', counts: counts(1) });
  await upload(0, two, sku, 'SKU图/黑色.jpg'); await upload(0, two, main, '1比1主图/主图_1.jpg');
  await call(0, `projects/${two}/plan`, {});
  const d2 = await detailOf(two);
  const [M_MAIN, M_SKU] = ['1比1主图/主图_1.jpg', 'SKU图/黑色.jpg'].map(path => d2.sources.find((i: { path: string }) => i.path === path).label);
  await executePlan(await latest(two, 'plan'), async (_r, hooks) => { await hooks.beforeSubmit(); return reply({ images: [{ id: M_MAIN, kind: '卖点图', color: '黑色', front: true }, { id: M_SKU, kind: '颜色款图', color: '黑色', front: true }], colors: [{ name: '黑色', hex: '#111', from: [M_SKU] }], points: [], category: 'workwear' }); });
  const plan2 = draftFrom((await detailOf(two)).materials, commute, counts(1)), first2 = roundOf(plan2, commute, 1);
  const beforeSecond = await balance(tenants[0]);
  await call(0, `projects/${two}/start`, plan2);
  assert.equal(beforeSecond - await balance(tenants[0]), costOf(first2));
  await executeWrite(await latest(two, 'write'), async (_r, hooks) => { await hooks.beforeSubmit(); throw new Error('连接中断'); });
  const back = await detailOf(two);
  assert.equal(back.status, 'materials'); assert.match(back.error, /写画面没成功.*积分已退回/); assert.equal(await balance(tenants[0]), beforeSecond);
  pass('写画面失败：冻结的积分全部退回，回到卖点上图，可以再点一次开始出图');
  await call(0, `projects/${two}/start`, plan2);
  await executeWrite(await latest(two, 'write'), async (_r, hooks) => { await hooks.beforeSubmit(); return reply({ product: { name: '第二款', garment: ['立领'] } }); });
  const calls: string[] = [];
  const worker = await startListingWorker({ concurrency: 2, recognize, generate: async (input, hooks) => {
    calls.push(input.prompt.slice(0, 12));
    await hooks.beforeSubmit(); throw new Error('连接中断');
  } });
  const drain = async (project: string) => {
    for (let i = 0; i < 80; i++) {
      if (!(await db().query("SELECT 1 FROM listing_jobs WHERE project_id=$1 AND status IN ('queued','running')", [project])).rowCount) return;
      await new Promise(r => setTimeout(r, 250));
    }
  };
  await drain(two); await worker.close();
  const states = Object.fromEntries((await db().query("SELECT slot,status,error FROM listing_jobs WHERE project_id=$1 AND step NOT IN ('plan','write')", [two])).rows.map(r => [r.slot, `${r.status}|${r.error}`]));
  assert.equal(calls.length, 1);
  assert.match(states[`product:${M_SKU}`], /^unknown\|.*管理员核对/);
  for (const i of first2.slice(1)) assert.match(states[i.slot], /^failed\|前一步.*没扣费/, i.slot);
  const secondRun = (await db().query("SELECT h.state,h.confirmed_cents,h.unknown_cents FROM credit_holds h WHERE h.job_ref LIKE $1 ORDER BY h.created_at DESC LIMIT 1", [`listing:run:${two}:%`])).rows[0];
  assert.deepEqual([secondRun.state, Number(secondRun.confirmed_cents), Number(secondRun.unknown_cents)], ['disputed', 0, unit]);
  assert.equal((await detailOf(two)).status, 'square');
  assert.equal(beforeSecond - await balance(tenants[0]), costOf(first2));
  pass('后台：按依赖顺序领任务，只提交了产品图；它结果不明时定妆照、SKU 图、方图都跳过不提交，只有这一张冻结待裁定');
  const redone = await (await call(0, `projects/${two}/redo`, { slot: `product:${M_SKU}`, note: '' })).json();
  assert.equal(redone.images, first2.length);
  assert.deepEqual((await imageJobs(two, true)).map(j => j.slot).sort(), first2.map(i => i.slot).sort());
  pass('重做产品图时，因为它被跳过的定妆照、SKU 图和方图一起重新排队、一起冻结');
  // 重做的产品图做好之前，后面的图不能拿旧图开工；做好后用的必须是新图。
  const made: { order: string[]; productBytes?: Buffer; skuRef?: Buffer } = { order: [] };
  let shade = 0;
  const worker2 = await startListingWorker({ concurrency: 4, recognize, generate: async (input, hooks) => {
    const which = input.prompt.startsWith('从参考图') ? 'product' : input.prompt.startsWith('为一套服装商品主图生成一张“模特定妆照”') ? 'cast' : input.prompt.includes('SKU 规格图') ? 'sku' : input.prompt.startsWith('为服装商品的 SKU 图生成一张单人模特') ? 'skumodel' : 'main';
    made.order.push(which);
    if (which === 'sku') made.skuRef = input.references[0];
    await hooks.beforeSubmit(); await hooks.receipt('task-unified-' + which);
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 10 * ++shade, g: 0, b: 0 } } }).png().toBuffer();
    if (which === 'product') made.productBytes = bytes;
    return { bytes, taskId: 't', credits: 1, durationMs: 1 };
  } });
  await drain(two); await worker2.close();
  assert.deepEqual([made.order.slice(0, 2), made.order.slice(2).sort()], [['product', 'cast'], ['main', 'skumodel']]);
  // The SKU image is put together (no model call) only once the new product image is there.
  const skuAfter = (await db().query(`SELECT (SELECT updated_at FROM listing_jobs WHERE project_id=$1 AND slot=$2 ORDER BY created_at DESC LIMIT 1) >= (SELECT updated_at FROM listing_jobs WHERE project_id=$1 AND slot=$3 ORDER BY created_at DESC LIMIT 1) ok,
    (SELECT status FROM listing_jobs WHERE project_id=$1 AND slot=$2 ORDER BY created_at DESC LIMIT 1) status`, [two, `sku:${M_SKU}`, `product:${M_SKU}`])).rows[0];
  assert.deepEqual([skuAfter.ok, skuAfter.status], [true, 'succeeded']);
  assert.equal((await detailOf(two)).status, 'square');
  pass('连带重做按顺序执行：产品图做好之后才出定妆照，再出 SKU 模特图和方图、拼 SKU 图，用的是新做的产品图');

  // ---- 临时故障（中转超时、限速）不判失败：放回队列等一会儿再试，依赖它的图一起等；只按出成的图扣费 ----
  const productJob = async () => (await db().query(`SELECT id,status,retries,retry_at>now() later,error FROM listing_jobs WHERE project_id=$1 AND slot=$2 ORDER BY created_at DESC LIMIT 1`, [two, `product:${M_SKU}`])).rows[0];
  const until = async (ok: () => Promise<boolean>) => { for (let i = 0; i < 80 && !(await ok()); i++) await new Promise(r => setTimeout(r, 250)); };
  const beforeRetry = await balance(tenants[0]);
  const retried = await (await call(0, `projects/${two}/redo`, { slot: `product:${M_SKU}`, note: '' })).json();
  let flaky = 0;
  const worker3 = await startListingWorker({ concurrency: 2, recognize, generate: async (input, hooks) => {
    await hooks.beforeSubmit();
    if (input.prompt.startsWith('从参考图') && flaky++ === 0) throw Object.assign(new Error('出图连接中断或超时'), { notCharged: true, retry: true });
    return { bytes: png, taskId: '', credits: null, durationMs: 1 };
  } });
  await until(async () => (await productJob()).retries === 1);
  const waiting = await productJob();
  assert.deepEqual([waiting.status, waiting.later, waiting.error], ['queued', true, '出图连接中断或超时']);
  await new Promise(r => setTimeout(r, 2500));
  assert.equal((await db().query(`SELECT count(*)::int n FROM listing_jobs WHERE project_id=$1 AND status NOT IN ('queued','running')
    AND run_id=(SELECT run_id FROM listing_jobs WHERE project_id=$1 AND slot=$2 ORDER BY created_at DESC LIMIT 1)`, [two, `product:${M_SKU}`])).rows[0].n, 0);
  const retrying = await slotOf(two, `product:${M_SKU}`);
  assert.deepEqual([retrying.status, retrying.retries, typeof retrying.retryAt], ['queued', 1, 'string']);
  await db().query(`UPDATE listing_jobs SET retry_at=now() WHERE id=$1`, [waiting.id]);
  await drain(two); await worker3.close();
  assert.deepEqual([(await productJob()).status, (await productJob()).retries], ['succeeded', 1]);
  assert.equal((await db().query(`SELECT count(*)::int n FROM listing_jobs WHERE project_id=$1 AND status<>'succeeded'
    AND run_id=(SELECT run_id FROM listing_jobs WHERE project_id=$1 AND slot=$2 ORDER BY created_at DESC LIMIT 1)`, [two, `product:${M_SKU}`])).rows[0].n, 0);
  assert.ok(retried.images > 1);
  assert.equal(beforeRetry - await balance(tenants[0]), unit);
  pass('临时故障：这张放回队列、到时间再试，页面显示第几次重试；依赖它的图一直等着不判失败；重试成功后整批出完，失败的那次不扣费');

  // ---- 停止出图：没出的图都不出、积分退回；正在重试的不再放回队列 ----
  const beforeStop = await balance(tenants[0]);
  await call(1, `projects/${two}/stop`, {}, 404);
  await call(0, `projects/${two}/stop`, {}, 409);
  const toStop = await (await call(0, `projects/${two}/redo`, { slot: `product:${M_SKU}`, note: '' })).json();
  const worker4 = await startListingWorker({ concurrency: 2, recognize, generate: async (_input, hooks) => {
    await hooks.beforeSubmit(); throw Object.assign(new Error('出图没有成功（HTTP 429，转接限速，稍后重做）'), { notCharged: true, retry: true });
  } });
  await until(async () => (await productJob()).retries === 1);
  await worker4.close();
  assert.equal((await (await call(0, `projects/${two}/stop`, {})).json()).stopped, toStop.images);
  const afterStop = await detailOf(two);
  assert.equal(afterStop.status, 'square');
  assert.equal(afterStop.slots.filter((x: { status: string; error: string }) => x.status === 'failed' && /已停止/.test(x.error)).length, toStop.images);
  assert.equal(await balance(tenants[0]), beforeStop);
  pass('停止出图：别人停不了、没在出图时不能停；还没出和等着重试的图都标「已停止」，冻结的积分全部退回');

  // ---- 后台中断（发布、重启）：中转的图放回队列，不再标「后台中断」 ----
  await call(0, `projects/${two}/redo`, { slot: `product:${M_SKU}`, note: '' });
  const cut = await productJob();
  await db().query(`UPDATE listing_jobs SET status='running',owner=$2,lease_until=now()-interval '1 minute' WHERE id=$1`, [cut.id, randomUUID()]);
  await db().query(`INSERT INTO listing_attempts(id,job_id,provider,model,status) VALUES($1,$2,'cliproxy','gpt-image-2','submitted')`, [randomUUID(), cut.id]);
  const worker5 = await startListingWorker({ concurrency: 2, recognize, generate: async () => { throw new Error('不该在这里出图'); } });
  await until(async () => (await productJob()).status === 'queued');
  await worker5.close();
  const swept = await productJob();
  assert.deepEqual([swept.status, swept.retries, swept.later, swept.error], ['queued', 1, true, '后台重启，已重新排队']);
  assert.equal((await db().query(`SELECT status FROM listing_attempts WHERE job_id=$1`, [cut.id])).rows[0].status, 'failed');
  await call(0, `projects/${two}/stop`, {});
  pass('后台中断：中转出的图放回队列稍后接着出，那次请求记为失败不扣费');

  // ---- 等前一步的图不占领任务的名额：30 张卡片在等，排在后面的别的商品照常出 ----
  const blockedRun = randomUUID(), holder = (await db().query(`SELECT tenant_id,created_by FROM listing_projects WHERE id=$1`, [two])).rows[0];
  await db().query(`INSERT INTO listing_jobs(id,tenant_id,project_id,created_by,step,run_id,slot,input,depends,status,stopped) VALUES($1,$2,$3,$4,'image',$5,'skumodel:wait','{"kind":"skuModel","sku":"x"}','{}','running',true)`,
    [randomUUID(), holder.tenant_id, two, holder.created_by, blockedRun]);
  for (let k = 0; k < 31; k++) await db().query(`INSERT INTO listing_jobs(id,tenant_id,project_id,created_by,step,run_id,slot,input,depends,created_at) VALUES($1,$2,$3,$4,'image',$5,$6,'{"kind":"sku","sku":"x","card":true}',$7,clock_timestamp())`,
    [randomUUID(), holder.tenant_id, two, holder.created_by, blockedRun, `sku:wait${k}`, ['skumodel:wait']]);
  const queuedFirst = (await db().query(`SELECT count(*)::int n FROM listing_jobs WHERE run_id=$1 AND status='queued'`, [blockedRun])).rows[0].n;
  assert.equal(queuedFirst, 31);
  await call(0, `projects/${id}/redo`, { slot: 'square:2', note: '' });
  const behind = (await imageJobs(id, true))[0];
  const worker6 = await startListingWorker({ concurrency: 2, recognize, generate: async (_input, hooks) => { await hooks.beforeSubmit(); return { bytes: png, taskId: '', credits: null, durationMs: 1 }; } });
  await until(async () => (await db().query(`SELECT status FROM listing_jobs WHERE id=$1`, [behind.id])).rows[0].status === 'succeeded');
  await worker6.close();
  assert.equal((await db().query(`SELECT status FROM listing_jobs WHERE id=$1`, [behind.id])).rows[0].status, 'succeeded');
  await db().query(`DELETE FROM listing_jobs WHERE run_id=$1`, [blockedRun]);
  pass('领任务：等前一步的图不占前 30 个名额，排在后面的图照常出');

  // ---- 加一套首图：换颜色、可换版式；出过竖版后也跟着出 3:4 和长图 ----
  const third = randomUUID();
  await call(0, 'projects', { id: third, name: '两色款', layout: 'M3', counts: counts(1, 1, 1) });
  await upload(0, third, await image(600, 600, '#141414'), 'SKU图/黑色.jpg'); await upload(0, third, await image(600, 600, '#1d2a44'), 'SKU图/藏青.jpg');
  await call(0, `projects/${third}/plan`, {});
  const d3 = await detailOf(third);
  const [BLACK, NAVY] = ['SKU图/黑色.jpg', 'SKU图/藏青.jpg'].map(path => d3.sources.find((i: { path: string }) => i.path === path).label);
  await toGenerating(third, { images: [{ id: BLACK, kind: '颜色款图', color: '黑色', front: true }, { id: NAVY, kind: '颜色款图', color: '藏青', front: true }], colors: [{ name: '黑色', hex: '#111', from: [BLACK] }, { name: '藏青', hex: '#1d2a44', from: [NAVY] }], points: [], category: 'workwear' },
    m => draftFrom(m, commute, counts(1, 1, 1)), { product: { name: '两色款', garment: ['立领'] }, scenes: [{ key: 'square:1', scene: '雨中行走' }] });
  for (const j of await imageJobs(third, true)) await make(j);
  assert.equal((await detailOf(third)).status, 'square');
  await call(0, `projects/${third}/sets`, { color: '黑色' }, 409);
  await call(1, `projects/${third}/sets`, { color: '藏青' }, 404);
  await call(0, `projects/${third}/sets`, { color: '不存在' }, 400);
  await call(0, `projects/${third}/sets`, { color: '藏青', layout: 'no-such-layout' }, 400);
  assert.equal((await (await call(0, `projects/${third}/sets`, { color: '藏青', layout: 'M4' })).json()).images, 1);
  await call(0, `projects/${third}/sets`, { color: '藏青' }, 409);
  const [setJob] = await imageJobs(third, true);
  assert.equal(setJob.slot, `square:1+${NAVY}`);
  await make(setJob);
  assert.match(prompt(setJob.slot).prompt, /颜色：藏青/); assert.ok(prompt(setJob.slot).prompt.includes('一束硬朗的阳光')); // 光影棚拍 M4's own cover (11-01)
  await call(0, `projects/${third}/verticals`, {});
  assert.deepEqual((await imageJobs(third, true)).map(j => j.slot), ['portrait:1', `portrait:1+${NAVY}`, 'long:1', `long:1+${NAVY}`]);
  for (const j of await imageJobs(third, true)) await make(j);
  const zip3 = await JSZip.loadAsync(Buffer.from(await (await call(0, `projects/${third}/download`)).arrayBuffer()));
  for (const n of ['换色首图-藏青/1比1主图-01-首图.jpg', '换色首图-藏青/3比4主图-01-首图.jpg', '换色首图-藏青/2比3长图.jpg']) assert.ok(Object.keys(zip3.files).includes(n), n);
  pass('加一套首图：只多出这个颜色的首图，可换版式；之后出竖版时这套也出 3:4 和长图；同一个颜色、主推色不能重复加；下载分文件夹');

  // ---- 用这份素材再出一套：不重新上传、不再收整理费，白底图和定妆照沿用，出图照常 ----
  const bytesUsed = async () => Number((await db().query('SELECT bytes_used FROM tenant_usage WHERE tenant_id=$1', [tenants[0]])).rows[0].bytes_used);
  const [balanceBeforeCopy, bytesBeforeCopy] = [await balance(tenants[0]), await bytesUsed()];
  await call(1, `projects/${third}/copies`, { layouts: ['M1'] }, 404);
  await call(0, `projects/${third}/copies`, { layouts: [] }, 400);
  await call(0, `projects/${third}/copies`, { layouts: ['no-such-layout'] }, 400);
  type Copy = { id: string; name: string; layout: string };
  const copies = (await (await call(0, `projects/${third}/copies`, { layouts: ['M1', 'M4'] })).json()).projects as Copy[];
  const short = (id: string) => (config.layouts as Layout[]).find(l => l.id === id)!.name.split(' · ')[0];
  assert.deepEqual(copies.map(x => [x.name, x.layout]), [[`两色款 · ${short('M1')}`, 'M1'], [`两色款 · ${short('M4')}`, 'M4']]);
  assert.deepEqual([await balance(tenants[0]), await bytesUsed()], [balanceBeforeCopy, bytesBeforeCopy]);
  const c1 = await detailOf(copies[0].id), m3 = (await detailOf(third)).materials as Materials;
  assert.deepEqual([c1.status, c1.images, c1.materials.look.master, c1.materials.variant], ['materials', 2, 'M1', 1]);
  assert.deepEqual(c1.sources.map((x: { label: string; path: string }) => `${x.label}|${x.path}`), d3.sources.map((x: { label: string; path: string }) => `${x.label}|${x.path}`));
  assert.ok(c1.materials.images.every((i: { assetId: string }) => c1.sources.some((x: { id: string }) => x.id === i.assetId) && !m3.images.some(o => o.assetId === i.assetId)));
  const carried = [`product:${BLACK}`, `product:${NAVY}`, 'cast'];
  assert.deepEqual(c1.slots.map((x: { slot: string }) => x.slot).sort(), [...carried].sort());
  assert.ok(c1.slots.every((x: { status: string; image: string | null }) => x.status === 'succeeded' && x.image));
  // A copy of a copy is named from the first product and numbered after the copies before it.
  const again = (await (await call(0, `projects/${copies[0].id}/copies`, { layouts: ['M5'] })).json()).projects as Copy[];
  assert.equal(again[0].name, `两色款 · ${short('M5')}`); assert.equal((await detailOf(again[0].id)).materials.variant, 3);
  // 11-01: the dialog's cover (who, worn open) goes with each new set; nothing asked, nothing kept.
  assert.equal(c1.materials.cover, undefined);
  await call(0, `projects/${third}/copies`, { layouts: ['M4'], cover: { people: '两男' } }, 400);
  const withCover = (await (await call(0, `projects/${third}/copies`, { layouts: ['M4'], cover: { people: '男女', open: true } })).json()).projects as Copy[];
  assert.deepEqual((await detailOf(withCover[0].id)).materials.cover, { people: '男女', open: true });
  // Started on M1: the white images and the cast are not held, not queued and not drawn again; the cover uses the carried cast.
  const M1L = BUILT_IN_LAYOUTS.find(l => l.id === 'M1')!, dc = draftFrom(c1.materials, M1L, counts(1, 0, 0));
  const reusedNow = reusedSlots(dc, c1.materials.reuse);
  assert.deepEqual([...reusedNow].sort(), [...carried].sort());
  const firstCopy = roundOf(dc, M1L, 1).filter(i => !reusedNow.has(i.slot));
  const balanceAtCopyStart = await balance(tenants[0]);
  await call(0, `projects/${copies[0].id}/start`, dc);
  await executeWrite(await latest(copies[0].id, 'write'), async (_r, hooks) => { await hooks.beforeSubmit(); return reply({ product: { name: '两色款', garment: ['立领'] }, scenes: [] }); });
  const copyJobs = await imageJobs(copies[0].id, true);
  assert.deepEqual(copyJobs.map(j => j.slot).sort(), firstCopy.map(i => i.slot).sort());
  const callsBeforeCopy = seen.length;
  for (const j of copyJobs) await make(j);
  assert.ok(seen.length > callsBeforeCopy && seen.slice(callsBeforeCopy).every(x => !x.slot.startsWith('product:') && !x.slot.startsWith('cast')));
  assert.equal((await detailOf(copies[0].id)).status, 'square');
  assert.equal(prompt('square:1').refs, 3); // white image, the carried cast, the sample
  assert.equal(balanceAtCopyStart - await balance(tenants[0]), costOf(firstCopy));
  const zipCopy = await JSZip.loadAsync(Buffer.from(await (await call(0, `projects/${copies[0].id}/download`)).arrayBuffer()));
  assert.ok(Object.keys(zipCopy.files).some(n => n.startsWith('白底产品图/')) && Object.keys(zipCopy.files).some(n => n.startsWith('模特定妆照')));
  pass('再出一套：一次多个版式，不重新上传、不再收整理费、不多占空间；白底图和定妆照沿用（不冻结、不重画、下载里有）；套中套按第一款起名、序号接着排；别人复制不了');

  // ---- 店铺服务图：设置存在账号上；确认一次出 4 张，改了服务只重画变了的字 ----
  const octet = { 'content-type': 'application/octet-stream', 'x-file-name': 'logo.png' };
  const shop0 = await (await call(0, 'shop')).json();
  assert.equal((await (await call(0, 'shop')).json()).project, shop0.project);
  assert.equal((await (await call(0, 'shop/make', {}, 400)).json()).error, '至少勾 4 条服务（现在 0 条）');
  type Item = { title: string; note: string; on: boolean };
  const ticked = (shop0.shop.items as Item[]).map((x, i) => ({ ...x, on: i < 4 }));
  await call(0, 'shop', { items: ticked, crafts: shop0.shop.crafts });
  await call(0, 'shop', { items: [{ ...ticked[0], title: '六个字的服务' }], crafts: [] }, 400);
  await call(1, `projects/${shop0.project}`, undefined, 404);
  assert.match((await (await call(0, 'shop/logo', await image(200, 200, '#cc0000'), 200, 'POST', octet)).json()).shop.logo, /^\/api\/listing\/assets\//);
  const beforeShop = await balance(tenants[0]);
  assert.equal((await (await call(0, 'shop/make', {})).json()).images, 4);
  await call(0, 'shop/make', {}, 409);
  assert.equal(beforeShop - await balance(tenants[0]), 4 * unit);
  const sjobs = await imageJobs(shop0.project, true);
  assert.deepEqual(sjobs.map(j => j.slot).sort(), ['service:A-dark', 'service:A-light', 'service:B-light', 'service:D-warm']);
  for (const j of sjobs) await make(j);
  assert.equal(prompt('service:D-warm').refs, 2); assert.match(prompt('service:D-warm').prompt, /多种印绣工艺/);
  assert.ok(prompt('service:A-dark').prompt.includes(`「${ticked[0].title}」「${ticked[0].note}」`));
  const madeShop = await (await call(0, 'shop')).json();
  assert.deepEqual([Object.keys(madeShop.shop.made).sort(), madeShop.making], [['A-dark', 'A-light', 'B-light', 'D-warm'], []]);
  assert.ok(!(await (await call(0, 'projects')).json()).some((p: { id: string }) => p.id === shop0.project));
  await call(0, 'shop', { items: ticked.map((x, i) => i === 0 ? { ...x, note: '满意再付款' } : x), crafts: shop0.shop.crafts });
  assert.equal((await (await call(0, 'shop/make', {})).json()).images, 3);
  for (const j of await imageJobs(shop0.project, true)) await make(j);
  assert.equal(prompt('service:A-dark').refs, 1);
  assert.ok(prompt('service:A-dark').prompt.includes(`「${ticked[0].title}」「${ticked[0].note}」 换成 「${ticked[0].title}」「满意再付款」`));
  const shop2 = await (await call(0, 'shop')).json();
  assert.deepEqual([shop2.shop.made['A-dark'].words[0], shop2.shop.made['A-dark'].history.length, shop2.shop.made['D-warm'].history.length], [`${ticked[0].title}｜满意再付款`, 1, 0]);
  // A new sample LOGO: the crafts image, drawn with the old one, is drawn again whole (10-21).
  const relogo = await (await call(0, 'shop/logo', await image(200, 200, '#0000cc'), 200, 'POST', octet)).json();
  assert.deepEqual(Object.entries(relogo.shop.made).filter(([, m]) => (m as { oldLogo?: boolean }).oldLogo).map(([id]) => id), ['D-warm']);
  assert.equal((await (await call(0, 'shop/make', {})).json()).images, 1);
  for (const j of await imageJobs(shop0.project, true)) await make(j);
  assert.equal(prompt('service:D-warm').refs, 2); assert.match(prompt('service:D-warm').prompt, /多种印绣工艺/);
  const shop3 = await (await call(0, 'shop')).json();
  assert.equal(shop3.shop.made['D-warm'].oldLogo, undefined);
  assert.equal(shop3.shop.made['D-warm'].history.length, 1);
  pass('店铺服务图：设置存在账号上、不在商品列表里，别的账号看不到；勾满 4 条才能出；确认一次出 4 张（工艺图带样例 LOGO）；改了服务只重画变了字的那几张，只改那几处字；换了样例 LOGO，印绣工艺图整张重画');

  // ---- 第 2 张直接用店铺的服务图（免费），竖版照它重排；点图修改出候选，采用才换上 ----
  const fourth = randomUUID();
  await call(0, 'projects', { id: fourth, name: '五张款', layout: 'M3', counts: counts(5, 5, 0) });
  await upload(0, fourth, await image(600, 600, '#e8621d'), 'SKU图/爱马仕橙.jpg');
  await call(0, `projects/${fourth}/plan`, {});
  const ORANGE = (await detailOf(fourth)).sources[0].label;
  const five = await toGenerating(fourth, { images: [{ id: ORANGE, kind: '颜色款图', color: '爱马仕橙', front: true }], colors: [{ name: '爱马仕橙', hex: '#e8621d', from: [ORANGE] }], points: [], category: 'workwear' },
    m => draftFrom(m, commute, counts(5, 5, 0)), { product: { name: '五张款', garment: ['连帽'] } });
  const fiveJobs = await imageJobs(fourth, true);
  const copyJob = fiveJobs.find(j => j.slot === 'square:2')!;
  assert.deepEqual([(copyJob.input as { kind: string }).kind, copyJob.depends], ['copy', []]);
  assert.ok(roundOf(five.draft, commute, 1).find(i => i.slot === 'square:2')!.free);
  for (const j of fiveJobs) await make(j);
  assert.equal((await db().query('SELECT count(*)::int n FROM listing_attempts WHERE job_id=$1', [copyJob.id])).rows[0].n, 0);
  const bytesOf = async (asset: string) => Buffer.from(await (await call(0, 'assets/' + asset)).arrayBuffer());
  assert.ok((await bytesOf((await slotOf(fourth, 'square:2')).image)).equals(await bytesOf(shop2.shop.made['D-warm'].asset)));
  await call(0, `projects/${fourth}/verticals`, {});
  const relayout = (await imageJobs(fourth, true)).find(j => j.slot === 'portrait:2')!;
  assert.deepEqual(relayout.depends, ['square:2']);
  for (const j of await imageJobs(fourth, true)) await make(j);
  assert.match(prompt('portrait:2').prompt, /重新排成竖版 3:4/); assert.equal(prompt('portrait:2').refs, 1);
  pass('第 2 张：直接复制店铺这套母版的服务图，不调模型、不收费；出竖版时照它重排成 3:4');

  const sq1 = await slotOf(fourth, 'square:1');
  await call(1, `projects/${fourth}/redraw`, { slot: 'square:1', ask: '背景换成工地' }, 404);
  assert.equal((await (await call(0, `projects/${fourth}/redraw`, { slot: 'square:1', ask: ' ' }, 400)).json()).error, '先写一句想怎么改');
  await call(0, `projects/${fourth}/redraw`, { slot: 'square:1', ask: '背景换成工地', reference: randomUUID() }, 400);
  const ref = await (await call(0, `projects/${fourth}/refs`, await image(300, 300, '#33aa66'), 200, 'POST', octet)).json();
  await call(1, `projects/${fourth}/refs`, await image(300, 300, '#33aa66'), 404, 'POST', octet);
  const beforeRedraw = await balance(tenants[0]);
  const { job: redrawJob } = await (await call(0, `projects/${fourth}/redraw`, { slot: 'square:1', ask: '背景换成工地，下雨天', reference: ref.asset })).json();
  await call(0, `projects/${fourth}/redraw`, { slot: 'square:1', ask: '再来一张' }, 409);
  assert.equal(beforeRedraw - await balance(tenants[0]), unit);
  assert.equal((await detailOf(fourth)).status, 'done');
  // 「改图进度」(10-25): what was asked and when, while it waits; the product counts it.
  const editsOf = async (project: string) => (await (await call(0, 'projects')).json()).find((p: { id: string }) => p.id === project).edits;
  const queuedRedraw = (await slotOf(fourth, 'square:1')).redraw;
  assert.deepEqual([queuedRedraw.status, queuedRedraw.open, queuedRedraw.ask, typeof queuedRedraw.at, queuedRedraw.ahead >= 0], ['queued', true, '背景换成工地，下雨天', 'string', true]);
  assert.deepEqual(await editsOf(fourth), { running: 1, ready: 0, failed: 0 });
  const [rj] = await imageJobs(fourth, true);
  await make(rj);
  assert.equal(prompt('square:1').refs, 2); assert.match(prompt('square:1').prompt, /要求：背景换成工地，下雨天/); assert.match(prompt('square:1').prompt, /参考图2是用户给的参考/);
  const afterRedraw = await slotOf(fourth, 'square:1'), candidate = afterRedraw.history.find((v: { job?: string }) => v.job === redrawJob);
  assert.deepEqual([afterRedraw.image, afterRedraw.redraw.status, candidate.change, (await detailOf(fourth)).status], [sq1.image, 'succeeded', '背景换成工地，下雨天', 'done']);
  assert.equal((await (await call(0, 'projects')).json()).find((p: { id: string }) => p.id === fourth).cover, `/api/listing/assets/${sq1.image}`);
  assert.deepEqual([afterRedraw.redraw.open, afterRedraw.redraw.asset, typeof afterRedraw.redraw.done], [true, candidate.id, 'string']);
  assert.deepEqual(await editsOf(fourth), { running: 0, ready: 1, failed: 0 });
  await call(0, `projects/${fourth}/current`, { slot: 'square:1', asset: candidate.id });
  assert.equal((await slotOf(fourth, 'square:1')).image, candidate.id);
  assert.deepEqual([(await slotOf(fourth, 'square:1')).redraw.open, await editsOf(fourth)], [false, { running: 0, ready: 0, failed: 0 }]);
  // 「不用」: the shown image chosen again puts the new one away (it stays in the history).
  // Several references (11-01): up to 4, each of the product's own, in the order given.
  const ref2 = await (await call(0, `projects/${fourth}/refs`, await image(300, 300, '#aa3366'), 200, 'POST', octet)).json();
  await call(0, `projects/${fourth}/redraw`, { slot: 'square:1', ask: '再亮一点', references: [ref.asset, ref2.asset, ref.asset, ref2.asset, ref.asset] }, 400);
  await call(0, `projects/${fourth}/redraw`, { slot: 'square:1', ask: '再亮一点', references: [ref.asset, randomUUID()] }, 400);
  const { job: againJob } = await (await call(0, `projects/${fourth}/redraw`, { slot: 'square:1', ask: '再亮一点', references: [ref.asset, ref2.asset] })).json();
  for (const j of await imageJobs(fourth, true)) await make(j);
  assert.equal(prompt('square:1').refs, 3); assert.match(prompt('square:1').prompt, /参考图2 到参考图3是用户给的 2 张参考/);
  assert.deepEqual(await editsOf(fourth), { running: 0, ready: 1, failed: 0 });
  await call(0, `projects/${fourth}/current`, { slot: 'square:1', asset: candidate.id });
  const keptShown = await slotOf(fourth, 'square:1');
  assert.deepEqual([keptShown.image, keptShown.redraw.open, !!keptShown.history.find((v: { job?: string }) => v.job === againJob), await editsOf(fourth)], [candidate.id, false, true, { running: 0, ready: 0, failed: 0 }]);
  const svc = shop3.shop.made['D-warm'];
  const { job: svcJob } = await (await call(0, `projects/${shop0.project}/redraw`, { slot: 'service:D-warm', ask: '标题改成「多种工艺 任你选」' })).json();
  for (const j of await imageJobs(shop0.project, true)) await make(j);
  const svcVersion = (await slotOf(shop0.project, 'service:D-warm')).history.find((v: { job?: string }) => v.job === svcJob);
  assert.equal((await (await call(0, 'shop')).json()).shop.made['D-warm'].asset, svc.asset);
  await call(0, `projects/${shop0.project}/current`, { slot: 'service:D-warm', asset: svcVersion.id });
  assert.equal((await (await call(0, 'shop')).json()).shop.made['D-warm'].asset, svcVersion.id);
  pass('点图修改：别人改不了、没写要求或参考图不对拦住；按一张收费；底图 + 参考图 + 要求出新图，先当候选不替换、商品状态不变；采用后才换上；店铺服务图同样能改、采用后新商品用新的；改图进度：排队/待采用计数，采用或「不用」后收起');

  // ---- 店铺 LOGO：主图左上角留空、程序贴上（看图和下载都是）；第 2 张服务图不贴；关掉或换 LOGO 马上跟着变；SKU 图角标 ----
  await call(0, 'shop/corner', { on: true }, 400);
  const beforeCorner = await balance(tenants[0]);
  // Three squares with gaps (not a solid block), so it is drawn white on a dark corner.
  const square80 = (color: string) => sharp({ create: { width: 80, height: 80, channels: 4, background: color } }).png().toBuffer();
  const brandPng = async (color: string) => sharp({ create: { width: 400, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(await Promise.all([20, 160, 300].map(async left => ({ input: await square80(color), left, top: 20 })))).png().toBuffer();
  const branded = (await (await call(0, 'shop/brand', await brandPng('#1f2a44'), 200, 'POST', octet)).json()).shop;
  assert.match(branded.brand, /^\/api\/listing\/assets\//); assert.equal(branded.corner, false);
  assert.equal((await (await call(0, 'shop/corner', { on: true })).json()).shop.corner, true);
  const shopNow = (await (await call(0, 'shop')).json()).shop;
  await call(0, 'shop', { items: shopNow.items, crafts: shopNow.crafts });
  const kept = (await (await call(0, 'shop')).json()).shop;
  assert.deepEqual([kept.brand, kept.corner, kept.logo], [branded.brand, true, shopNow.logo]);
  const fifth = randomUUID();
  await call(0, 'projects', { id: fifth, name: '角标款', layout: 'M3', counts: counts(5, 5, 0) });
  await upload(0, fifth, await image(600, 600, '#e8621d'), 'SKU图/爱马仕橙.jpg');
  await call(0, `projects/${fifth}/plan`, {});
  const ORANGE5 = (await detailOf(fifth)).sources[0].label;
  await toGenerating(fifth, { images: [{ id: ORANGE5, kind: '颜色款图', color: '爱马仕橙', front: true }], colors: [{ name: '爱马仕橙', hex: '#e8621d', from: [ORANGE5] }], points: [], category: 'workwear' },
    m => ({ ...draftFrom(m, commute, counts(5, 5, 0)), logo: { mode: '样例' as const } }), { product: { name: '角标款', garment: ['连帽'] } });
  for (const j of await imageJobs(fifth, true)) await make(j);
  assert.match(prompt('square:1').prompt, /左上角空位，之后要贴店铺 LOGO/);
  // The chest set to the shop's sample LOGO: it goes as the last reference image, printed on the chest (10-21).
  assert.match(prompt('square:1').prompt, /胸口左侧印客户的 LOGO（照它的参考图），宽约 8–10 厘米/);
  assert.match(prompt('square:1').prompt, new RegExp(`参考图${prompt('square:1').refs - 1}：客户的 LOGO，只用来印在衣服胸口，画面别处都不放`));
  const receiptOf = async (project: string, slot: string) => (await db().query(`SELECT t.receipt FROM listing_attempts t JOIN listing_jobs j ON j.id=t.job_id WHERE j.project_id=$1 AND j.slot=$2 AND t.status='succeeded' ORDER BY t.finished_at DESC LIMIT 1`, [project, slot])).rows[0]?.receipt;
  assert.equal((await receiptOf(fifth, 'square:1')).corner, true);
  assert.equal(await receiptOf(fifth, 'square:2'), undefined);
  // The fake image is dark grey: the LOGO's first square (58–122, 50–114 on 1440) comes out white, the rest of the corner stays.
  const pixel = async (bytes: Buffer, x: number, y: number) => { const { data } = await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true }); return data[0]; };
  // SKU 图角标 (10-26): kept per shop; in the top-left corner it takes the LOGO's place on the SKU image, and
  // 「按店铺设置重拼 SKU 图」 puts it on the cards already made, free, without drawing anyone again.
  const card5 = (await detailOf(fifth)).slots.find((s: { slot: string; image: string | null }) => s.slot.startsWith('sku:') && s.image).slot;
  // The LOGO's navy at the top left before (blue well above red); the badge's neutral black after.
  const rgb = async (bytes: Buffer, x: number, y: number) => [...(await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];
  const [r0, , b0] = await rgb(await bytesOf((await slotOf(fifth, card5)).image), 66, 103);
  assert.ok(b0 - r0 > 20);
  assert.deepEqual((await (await call(0, 'shop')).json()).shop.skuBadge, { text: '', place: 'title' });
  await call(0, 'shop/sku-badge', { text: '一二三四五六七八九', place: 'corner' }, 400);
  await call(0, 'shop/sku-badge', { text: '', place: 'top' }, 400);
  assert.deepEqual((await (await call(0, 'shop/sku-badge', { text: '新品上市', place: 'corner' })).json()).shop.skuBadge, { text: '新品上市', place: 'corner' });
  assert.deepEqual((await (await call(1, 'shop')).json()).shop.skuBadge, { text: '', place: 'title' });
  // SKU 图字段组合 (11-01): named combos per shop, checked on save; 自动 is built in and the default until another is marked.
  assert.deepEqual((await (await call(0, 'shop')).json()).shop.skuFields, { sets: [], default: 'auto' });
  const combo = { id: 'f0000aa01', name: '货号面料', fields: ['style', 'fabric', 'color'] };
  await call(0, 'shop/sku-fields', { sets: [{ ...combo, fields: ['style', 'fabric', 'fit', 'color'] }], default: 'auto' }, 400);
  await call(0, 'shop/sku-fields', { sets: [{ ...combo, fields: ['style', 'style'] }], default: 'auto' }, 400);
  await call(0, 'shop/sku-fields', { sets: [combo, { ...combo, id: 'f0000aa02' }], default: 'auto' }, 400);
  await call(0, 'shop/sku-fields', { sets: [{ ...combo, name: '不指定' }], default: 'auto' }, 400);
  await call(0, 'shop/sku-fields', { sets: [combo], default: 'f0000aa09' }, 400);
  assert.deepEqual((await (await call(0, 'shop/sku-fields', { sets: [combo], default: combo.id })).json()).shop.skuFields, { sets: [combo], default: combo.id });
  assert.deepEqual((await (await call(1, 'shop')).json()).shop.skuFields, { sets: [], default: 'auto' });
  const beforeRecard = await balance(tenants[0]), drawnBefore = (await imageJobs(fifth)).length;
  assert.ok((await (await call(0, `projects/${fifth}/recard`, {})).json()).images >= 1);
  await call(0, `projects/${fifth}/recard`, {}, 409);
  const recards = await imageJobs(fifth, true);
  assert.ok(recards.length >= 1 && recards.every(j => j.slot.startsWith('sku:')));
  for (const j of recards) await make(j);
  assert.equal(await balance(tenants[0]), beforeRecard);
  assert.equal((await imageJobs(fifth)).length, drawnBefore + recards.length);
  const [r1, g1, b1] = await rgb(await bytesOf((await slotOf(fifth, card5)).image), 66, 103);
  assert.ok(r1 < 60 && Math.abs(b1 - r1) < 12 && Math.abs(g1 - r1) < 12);
  await call(0, 'shop/sku-badge', { text: '', place: 'title' });
  const sq5 = (await slotOf(fifth, 'square:1')).image;
  const shown = await call(0, 'assets/' + sq5), shownBytes = Buffer.from(await shown.arrayBuffer()), tag = shown.headers.get('etag')!;
  assert.equal(shown.headers.get('cache-control'), 'private, no-cache');
  assert.ok(await pixel(shownBytes, 80, 80) > 200 && await pixel(shownBytes, 700, 700) < 80);
  await call(0, 'assets/' + sq5, undefined, 304, 'GET', { 'if-none-match': tag });
  assert.equal((await call(0, 'assets/' + (await slotOf(fifth, 'square:2')).image)).headers.get('cache-control'), 'private, max-age=31536000, immutable');
  await call(1, 'assets/' + sq5, undefined, 404);
  await call(0, `projects/${fifth}/verticals`, {});
  for (const j of await imageJobs(fifth, true)) await make(j);
  assert.match(prompt('portrait:1').prompt, /参考图1左上角留着一块空位/); assert.doesNotMatch(prompt('portrait:2').prompt, /空位/);
  assert.equal((await receiptOf(fifth, 'portrait:1')).corner, true);
  const zip5 = await JSZip.loadAsync(Buffer.from(await (await call(0, `projects/${fifth}/download`)).arrayBuffer()));
  const entry = async (prefix: string) => Buffer.from(await zip5.file(Object.keys(zip5.files).find(n => n.startsWith(prefix))!)!.async('uint8array'));
  assert.ok(await pixel(await entry('1比1主图-01'), 80, 80) > 200 && await pixel(await entry('3比4主图-01'), 80, 80) > 200);
  assert.ok(await pixel(await entry('1比1主图-02'), 80, 80) === await pixel(await bytesOf((await slotOf(fifth, 'square:2')).image), 80, 80));
  // Another LOGO shows at once (its own ETag); switched off, the image is shown as it was drawn, and nothing new keeps the corner.
  await call(0, 'shop/brand', await brandPng('#f2f2f2'), 200, 'POST', octet);
  const changed = await call(0, 'assets/' + sq5, undefined, 200, 'GET', { 'if-none-match': tag });
  assert.notEqual(changed.headers.get('etag'), tag);
  await call(0, 'shop/corner', { on: false });
  const plain = Buffer.from(await (await call(0, 'assets/' + sq5)).arrayBuffer());
  assert.ok(await pixel(plain, 80, 80) < 80);
  await call(0, `projects/${fifth}/redo`, { slot: 'square:3', note: '' });
  for (const j of await imageJobs(fifth, true)) await make(j);
  assert.doesNotMatch(prompt('square:3').prompt, /空位/); assert.equal((await receiptOf(fifth, 'square:3')).corner, undefined);
  // Deleting the LOGOs (10-21): someone else's shop is untouched; the shop's own takes the corner switch off with it;
  // the sample one makes the chest print 「LOGO」 and the crafts image drawn again whole, with no LOGO image.
  await call(1, 'shop/logo', undefined, 200, 'DELETE');
  assert.ok((await (await call(0, 'shop')).json()).shop.logo);
  await call(0, 'shop/corner', { on: true });
  const noBrand = (await (await call(0, 'shop/brand', undefined, 200, 'DELETE')).json()).shop;
  assert.deepEqual([noBrand.brand, noBrand.corner], [null, false]);
  const noLogo = (await (await call(0, 'shop/logo', undefined, 200, 'DELETE')).json()).shop;
  assert.deepEqual([noLogo.logo, noLogo.made['D-warm'].oldLogo], [null, true]);
  await call(0, `projects/${fifth}/redo`, { slot: 'square:1', note: '' });
  for (const j of await imageJobs(fifth, true)) await make(j);
  assert.match(prompt('square:1').prompt, /胸口左侧印一个白色「LOGO」字样/); assert.doesNotMatch(prompt('square:1').prompt, /客户的 LOGO/);
  assert.equal((await (await call(0, 'shop/make', {})).json()).images, 1);
  for (const j of await imageJobs(shop0.project, true)) await make(j);
  assert.equal(prompt('service:D-warm').refs, 1);
  assert.equal((await (await call(0, 'shop')).json()).shop.made['D-warm'].oldLogo, undefined);
  // The credits this set took go back, so the checks after it start where they did.
  await db().query('UPDATE credit_accounts SET balance_cents=$2 WHERE tenant_id=$1', [tenants[0], beforeCorner]);
  pass('删除 LOGO：只删自己店的；删店铺 LOGO 连开关一起关；删样例 LOGO 后胸口改印「LOGO」字样、印绣工艺图整张重画成抽象图案');
  pass('胸口印样例 LOGO：出图带上店铺设置里的样例 LOGO；店铺 LOGO：没传 LOGO 打不开；开了以后新出的方图左上角留空、看图和下载都贴上（深底变白）；第 2 张服务图不贴；竖版照着留空也贴；别人看不到；换 LOGO 马上换、关掉马上恢复原图，之后出的图不再留空');
  pass('SKU 图角标：每套店铺各存各的（太长、位置不对拦住，别的账号不受影响）；放左上角就顶替 SKU 图上的店铺 LOGO；「按店铺设置重拼 SKU 图」只重拼 SKU 图、不扣积分，出来就带新角标');

  // ---- 多套店铺（10-22）：一个账号几套店铺，各有自己的 LOGO、服务和服务图；一款用一套，换色首图可以另选 ----
  const beforeSets = await balance(tenants[0]);
  const firstShop = await (await call(0, 'shop')).json();
  assert.deepEqual(firstShop.sets, [{ id: 'main', name: '我的店铺', isDefault: true }]);
  await call(0, 'shop/sets', { name: ' ' }, 400);
  const shopTwo = await (await call(0, 'shop/sets', { name: '二店' })).json(), S2 = shopTwo.set as string;
  assert.match(S2, /^s[0-9a-f]{8}$/);
  // It starts from the default shop's services and crafts, with no LOGOs and no images.
  assert.deepEqual([shopTwo.sets.map((x: { name: string }) => x.name), shopTwo.shop.items, shopTwo.shop.brand, shopTwo.shop.logo, Object.keys(shopTwo.shop.made)],
    [['我的店铺', '二店'], firstShop.shop.items, null, null, []]);
  await call(0, 'shop/sets', { name: '二店' }, 409);
  assert.equal((await (await call(1, 'shop')).json()).sets.length, 1);
  await call(1, `shop/sets/${S2}`, { name: '偷改' }, 404);
  assert.equal((await (await call(0, 'shop?set=s00000000')).json()).set, 'main');
  // Its own LOGOs and corner switch; the first shop's stay as they were.
  await call(0, 'shop/brand', await brandPng('#1f2a44'), 200, 'POST', { ...octet, 'x-shop-set': S2 });
  await call(0, 'shop/logo', await image(200, 200, '#00aa00'), 200, 'POST', { ...octet, 'x-shop-set': S2 });
  assert.equal((await (await call(0, 'shop/corner', { on: true, set: S2 })).json()).shop.corner, true);
  const firstNow = (await (await call(0, 'shop')).json()).shop;
  assert.deepEqual([firstNow.brand, firstNow.corner, firstNow.logo], [null, false, null]);
  // Its own service images in its own slots, the crafts one with its own sample LOGO; the first shop's are untouched.
  await call(0, 'shop', { set: S2, items: shopTwo.shop.items.map((x: Item, i: number) => i === 0 ? { ...x, note: '二店的说明' } : x), crafts: shopTwo.shop.crafts });
  assert.equal((await (await call(0, 'shop/make', { set: S2 })).json()).images, 4);
  const s2jobs = await imageJobs(shop0.project, true);
  assert.deepEqual(s2jobs.map(j => j.slot).sort(), ['A-dark', 'A-light', 'B-light', 'D-warm'].map(x => `service:${S2}~${x}`));
  for (const j of s2jobs) await make(j);
  assert.equal(prompt(`service:${S2}~D-warm`).refs, 2);
  const s2 = await (await call(0, `shop?set=${S2}`)).json();
  assert.deepEqual([Object.keys(s2.shop.made).sort(), s2.shop.made['A-dark'].words[0], s2.making], [['A-dark', 'A-light', 'B-light', 'D-warm'], `${ticked[0].title}｜二店的说明`, []]);
  assert.equal((await (await call(0, 'shop')).json()).shop.made['A-dark'].asset, firstShop.shop.made['A-dark'].asset);
  // 点图修改 works on its images too.
  await call(0, `projects/${shop0.project}/redraw`, { slot: `service:${S2}~A-dark`, ask: '标题再大一点' });
  for (const j of await imageJobs(shop0.project, true)) await make(j);
  pass('多套店铺：新建一套照默认店铺的服务和工艺起步、没有 LOGO 和图；重名拦住、别的账号看不到改不了；每套的 LOGO、左上角开关、服务、服务图各管各的（槽位分开，工艺图用这套的样例 LOGO）；点图修改照样能用');

  // A product for the second shop, with another colour's cover for the first one.
  const sixth = randomUUID();
  await call(0, 'projects', { id: sixth, name: '二店款', layout: 'M3', counts: counts(5, 0, 0) });
  await upload(0, sixth, await image(600, 600, '#e8621d'), 'SKU图/爱马仕橙.jpg');
  await upload(0, sixth, await image(600, 600, '#1d2a44'), 'SKU图/藏青.jpg');
  await call(0, `projects/${sixth}/plan`, {});
  const [OR6, NV6] = await Promise.all(['SKU图/爱马仕橙.jpg', 'SKU图/藏青.jpg'].map(async path => ((await detailOf(sixth)).sources as { path: string; label: string }[]).find(x => x.path === path)!.label));
  await toGenerating(sixth, { images: [{ id: OR6, kind: '颜色款图', color: '爱马仕橙', front: true }, { id: NV6, kind: '颜色款图', color: '藏青', front: true }],
    colors: [{ name: '爱马仕橙', hex: '#e8621d', from: [OR6] }, { name: '藏青', hex: '#1d2a44', from: [NV6] }], points: [], category: 'workwear' },
  m => { const d = draftFrom(m, commute, counts(5, 0, 0)); return { ...d, logo: { mode: '样例' as const }, shop: S2, extra: [{ color: d.colors.find(c => c.name !== d.main)!.name, layout: '', shop: 'main' }] }; },
  { product: { name: '二店款', garment: ['连帽'] } });
  for (const j of await imageJobs(sixth, true)) await make(j);
  const stored6 = (await db().query('SELECT plan FROM listing_projects WHERE id=$1', [sixth])).rows[0].plan;
  assert.deepEqual([stored6.draft.shop, stored6.draft.extra[0].shop], [S2, 'main']);
  const other = (await detailOf(sixth)).slots.find((x: { slot: string }) => x.slot.startsWith('square:1+')).slot as string;
  // The product's images: its shop's service image, its sample LOGO on the chest, its LOGO in the corner.
  assert.ok((await bytesOf((await slotOf(sixth, 'square:2')).image)).equals(await bytesOf(s2.shop.made['D-warm'].asset)));
  assert.match(prompt('square:1').prompt, /胸口左侧印客户的 LOGO/);
  assert.equal((await receiptOf(sixth, 'square:1')).corner, true);
  assert.ok(await pixel(await bytesOf((await slotOf(sixth, 'square:1')).image), 80, 80) > 200);
  // The other colour's cover goes by the first shop: no sample LOGO (「LOGO」 printed), no corner.
  assert.match(prompt(other).prompt, /胸口左侧印一个白色「LOGO」字样/);
  assert.equal((await receiptOf(sixth, other))?.corner, undefined);
  const zip6 = await JSZip.loadAsync(Buffer.from(await (await call(0, `projects/${sixth}/download`)).arrayBuffer()));
  const entry6 = async (test: (name: string) => boolean) => Buffer.from(await zip6.file(Object.keys(zip6.files).find(test)!)!.async('uint8array'));
  assert.ok(await pixel(await entry6(n => n.startsWith('1比1主图-01')), 80, 80) > 200);
  assert.ok(await pixel(await entry6(n => n.startsWith('换色首图-') && n.includes('/1比1主图-01')), 80, 80) < 80);
  pass('一款用哪套店铺：服务图复制这套的、胸口印这套的样例 LOGO、左上角贴这套的店铺 LOGO（看图和下载都是）；换色首图另选的店铺只管它自己那几张');

  // The default shop: new products use it; it cannot be deleted, nor can the first one. A deleted shop's products fall back to the default.
  assert.equal((await (await call(0, `shop/sets/${S2}`, { isDefault: true })).json()).sets.find((x: { isDefault: boolean }) => x.isDefault).id, S2);
  assert.equal((await (await call(0, 'shop')).json()).set, S2);
  await call(0, `shop/sets/${S2}`, undefined, 409, 'DELETE');
  await call(0, 'shop/sets/main', undefined, 409, 'DELETE');
  await call(0, 'shop/sets/main', { isDefault: true });
  await call(0, `shop/sets/main`, { name: '一店' });
  assert.deepEqual((await (await call(0, `shop/sets/${S2}`, undefined, 200, 'DELETE')).json()).sets, [{ id: 'main', name: '一店', isDefault: true }]);
  assert.ok(await pixel(await bytesOf((await slotOf(sixth, 'square:1')).image), 80, 80) < 80);
  await db().query('UPDATE credit_accounts SET balance_cents=$2 WHERE tenant_id=$1', [tenants[0], beforeSets]);
  pass('默认店铺：设成默认的新款就用它；默认的和第一套删不了；第一套能改名；删了的店铺，用它的款跟着默认店铺走（左上角马上跟着变）');

  // ---- 内胆款（10-22）：整理认出类型和 SKU 版本（复核过的才算）；定妆照穿着内胆；SKU 按颜色 × 版本出，有实拍直接用，你加的版本照参考图画 ----
  const lined = randomUUID();
  await call(0, 'projects', { id: lined, name: '内胆款', layout: 'M3', counts: counts(1, 0, 0) });
  await upload(0, lined, await image(600, 600, '#5b2a4a'), '外套/乌梅紫.jpg');
  await upload(0, lined, await image(600, 800, '#5b2a4b'), '羽绒/乌梅紫羽绒.jpg');
  await upload(0, lined, await image(600, 800, '#e8e0d0'), '内胆/米色内胆.jpg');
  await call(0, `projects/${lined}/plan`, {});
  const [SHELL, OVER, ALONE] = ['外套/乌梅紫.jpg', '羽绒/乌梅紫羽绒.jpg', '内胆/米色内胆.jpg'].map(path => (detailOf(lined) as Promise<{ sources: { path: string; label: string }[] }>).then(d => d.sources.find(i => i.path === path)!.label));
  const ids = await Promise.all([SHELL, OVER, ALONE]);
  const linedSorted = { images: [{ id: ids[0], kind: '颜色款图', color: '乌梅紫', front: true, role: '主体' }, { id: ids[1], kind: '模特实拍', color: '乌梅紫', role: '主体', inner: '羽绒', innerColor: '黑色', person: '女', face: true },
    { id: ids[2], kind: '模特实拍', color: '米色', role: '内胆', inner: '摇粒绒', innerColor: '米色', person: '女', face: true }], colors: [{ name: '乌梅紫', hex: '#5b2a4a', from: [ids[0]] }], points: [], category: 'workwear',
    wear: { type: '内胆', why: '文件夹写羽绒，有米色内胆单穿', versions: [{ kind: '单外壳', from: [ids[0]] }, { kind: '外壳加内胆', inner: '羽绒', from: [ids[1]] }, { kind: '外壳加内胆', inner: '摇粒绒', from: [ids[0], ids[2]] }, { kind: '单内胆', inner: '摇粒绒', from: [ids[2]] }] } };
  // The liner check looks again at the two that may show a liner (sorted as such, or named for one) and agrees.
  let checked = 0;
  await executePlan(await latest(lined, 'plan'), async (r, hooks) => {
    await hooks.beforeSubmit();
    const system = String((r as { messages: { content: unknown }[] }).messages[0].content);
    if (system.includes('逐张看清楚外套里面有没有内胆')) { checked++; return reply({ images: [{ id: ids[1], role: '主体', open: true, inner: '羽绒', innerColor: '黑色', shellColor: '乌梅紫' }, { id: ids[2], role: '内胆', open: true, inner: '摇粒绒', innerColor: '米色' }] }); }
    return reply(linedSorted);
  });
  const lm = (await detailOf(lined)).materials as Materials;
  assert.equal(checked, 1);
  // A shell photo and a liner photo are not 外壳 + 摇粒绒: that version is dropped (不要拼，不要猜).
  assert.deepEqual([lm.wear?.type, lm.wear?.versions.map(v => [v.kind, v.inner, v.colors.join('、')])], ['内胆', [['单外壳', '', '乌梅紫'], ['外壳加内胆', '羽绒', '乌梅紫'], ['单内胆', '摇粒绒', '米色']]]);
  // A liner colour the material lacks, on the plan (10-22): a photo uploaded as that liner, or one drawn by AI from the ticked references and taken in.
  const tagged = { 'content-type': 'application/octet-stream', 'x-file-name': 'black.jpg', 'x-liner-inner': encodeURIComponent('摇粒绒'), 'x-liner-color': encodeURIComponent('灰色') };
  const up = await (await call(0, `projects/${lined}/extra`, await image(500, 600, '#777777'), 200, 'POST', tagged)).json();
  const beforeDraw = await balance(tenants[0]);
  await call(0, `projects/${lined}/draw`, { prompt: '照参考图这件摇粒绒内胆，颜色换成黑色', refs: [] }, 400);
  await call(0, `projects/${lined}/draw`, { prompt: '照参考图这件摇粒绒内胆，颜色换成黑色', refs: ['M999'] }, 400);
  await call(1, `projects/${lined}/draw`, { prompt: '照参考图这件摇粒绒内胆，颜色换成黑色', refs: [ids[2]] }, 404);
  const { job: drawJob } = await (await call(0, `projects/${lined}/draw`, { prompt: '照参考图这件摇粒绒内胆，颜色换成黑色', refs: [ids[2]] })).json();
  await call(0, `projects/${lined}/draw`, { prompt: '再来一张', refs: [ids[2]] }, 409);
  assert.equal((await (await call(0, `projects/${lined}/draws/${drawJob}`)).json()).status, 'queued');
  for (const j of await imageJobs(lined, true)) await make(j);
  assert.match(prompt('draw:1').prompt, /颜色换成黑色/); assert.equal(prompt('draw:1').refs, 1);
  const drawn = await (await call(0, `projects/${lined}/draws/${drawJob}`)).json();
  assert.equal(drawn.status, 'succeeded'); assert.equal(beforeDraw - await balance(tenants[0]), unit);
  await call(1, `projects/${lined}/adopt`, { asset: drawn.asset, inner: '摇粒绒', color: '黑色' }, 404);
  const adopted = await (await call(0, `projects/${lined}/adopt`, { asset: drawn.asset, inner: '摇粒绒', color: '黑色' })).json();
  const lm2 = (await detailOf(lined)).materials as Materials, tagOf = (l: string) => lm2.sorted.images.find(i => i.id === l)!;
  assert.deepEqual([tagOf(up.label).role, tagOf(up.label).inner, tagOf(up.label).innerColor, tagOf(adopted.label).kind, tagOf(adopted.label).innerColor], ['内胆', '摇粒绒', '灰色', '静物', '黑色']);
  assert.ok(!((await detailOf(lined)).slots as { slot: string }[]).some(x => x.slot.startsWith('draw:')));
  const linedDraft: Draft = { ...draftFrom(lm, commute, counts(1, 0, 0)), wear: { type: '内胆', liner: ids[1] },
    versions: [...draftVersions(lm.wear!.versions), { key: 'v9', kind: '外壳加内胆', inner: '摇粒绒', colors: ['乌梅紫'], on: true, added: true, ref: ids[2] }] };
  await call(0, `projects/${lined}/start`, linedDraft);
  await call(0, `projects/${lined}/draw`, { prompt: '照参考图这件摇粒绒内胆，颜色换成黑色', refs: [ids[2]] }, 409);
  await executeWrite(await latest(lined, 'write'), async (_r, hooks) => { await hooks.beforeSubmit(); return reply({ product: { name: '内胆款', garment: ['连帽'] } }); });
  const linedJobs = await imageJobs(lined, true), slotsOf = (prefix: string) => linedJobs.filter(j => j.slot.startsWith(prefix)).map(j => j.slot).sort();
  // The material's own photo where it has one (the shell over its liner, the liner alone); drawn otherwise.
  assert.deepEqual(slotsOf('sku:'), [`sku:${ids[0]}`, `sku:${ids[0]}~v2`, `sku:${ids[0]}~v9`, 'sku:~v3~0'].sort());
  assert.deepEqual(slotsOf('skumodel:'), [`skumodel:${ids[0]}`, `skumodel:${ids[0]}~v9`].sort());
  for (const j of linedJobs) await make(j);
  assert.match(prompt('cast').prompt, /参考图2是这款的内胆照片/); assert.match(prompt('cast').prompt, /外套拉链拉开、敞着穿/);
  assert.match(prompt(`skumodel:${ids[0]}`).prompt, /拉链拉到胸口，里面是白色圆领 T 恤/); assert.doesNotMatch(prompt(`skumodel:${ids[0]}`).prompt, /内胆照片/);
  assert.match(prompt(`skumodel:${ids[0]}~v9`).prompt, /参考图3是这款的内胆照片/);
  const linedSlots = (await detailOf(lined)).slots as { slot: string; image: string | null }[];
  assert.ok([`sku:${ids[0]}`, `sku:${ids[0]}~v2`, `sku:${ids[0]}~v9`, 'sku:~v3~0'].every(slot => linedSlots.find(s => s.slot === slot)?.image));
  const linedZip = await JSZip.loadAsync(Buffer.from(await (await call(0, `projects/${lined}/download`)).arrayBuffer()));
  assert.ok(['SKU-乌梅紫-单外壳', 'SKU-乌梅紫-外壳+羽绒内胆', 'SKU-米色-单穿摇粒绒内胆'].every(n => Object.keys(linedZip.files).some(f => f.startsWith(n))), Object.keys(linedZip.files).join(' '));
  await db().query('UPDATE credit_accounts SET balance_cents=$2 WHERE tenant_id=$1', [tenants[0], beforeCorner]);
  pass('内胆款：方案页补内胆颜色（上传标明是内胆；AI 生成按一张收费、用这张才进素材、不进结果和下载、出图后不能再生成）；整理认出有内胆和三种 SKU 版本，外壳和内胆各一张照片不拼成组合；定妆照穿着内胆；SKU 按颜色 × 版本出，有实拍的直接用，单外壳照旧穿白 T，你加的版本照你选的参考图画；下载按颜色和版本命名');

  const run = async (provider: Parameters<typeof executePlan>[1]) => {
    const pid = randomUUID();
    await call(0, 'projects', { id: pid, name: '失败验收', layout: 'M3', counts: counts(1, 1, 1) });
    await upload(0, pid, main, 'a.jpg');
    await call(0, `projects/${pid}/plan`, {});
    const j = (await db().query("SELECT id,tenant_id,project_id,step FROM listing_jobs WHERE project_id=$1", [pid])).rows[0] as Job;
    await executePlan(j, provider);
    return { pid, job: j, project: await detailOf(pid), hold: (await db().query('SELECT state FROM credit_holds WHERE id=$1', ['listing:' + j.id])).rows[0].state };
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
  assert.equal(garbled.hold, 'released'); assert.equal(garbled.project.status, 'failed'); assert.match(garbled.project.error, /整理结果不完整.*未扣费/);
  pass('模型返回不完整：整理做完才计费，这次不扣费，商品标为失败可重试');
  const refused = await run(async (_r, hooks) => { await hooks.beforeSubmit(); throw Object.assign(new Error('分析接口 HTTP 400'), { definite: true }); });
  assert.equal(refused.hold, 'released'); assert.equal(refused.project.status, 'failed'); assert.match(refused.project.error, /接口拒绝.*未扣费/);
  pass('接口直接拒收（4xx）：没有产生费用，冻结的积分退回，可以重新分析');

  // ---- 大款：拼起来给 AI 看，几乎一样的图只看一次 ----
  const bigId = randomUUID();
  await call(0, 'projects', { id: bigId, name: '大款', layout: 'M4', counts: counts(1) });
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
    return reply({ images: sent.map((m, i) => ({ id: m, kind: i === 0 ? '静物' : '模特实拍', color: i === 0 ? '黑色' : '', front: i === 0 })), colors: [{ name: '黑色', hex: '#111', from: [sent[0]] }], points: [] });
  });
  const bigPlan = await detailOf(bigId);
  assert.equal(bigPlan.status, 'materials');
  assert.match(texts, /【拼图：4 张素材.*形状都是 1:1/); assert.ok((texts.match(/【/g) ?? []).length <= 48);
  assert.equal(bigPlan.materials.sorted.images.length, 60); assert.equal(bigPlan.materials.duplicates.length, 1);
  const [twinId] = bigPlan.materials.duplicates[0];
  assert.equal(bigPlan.sources.find((i: { label: string }) => i.label === twinId).path, '模特图/IMG_1_连拍.png');
  pass('大款：61 张中颜色相近的照片都保留，按需拼成宫格不超过 50 张图，每张都有分类；完全相同的副本只看一次，记为重复');

  // ---- 大款分段读（10-26）：带字的图分组读卖点，再看照片读整款；最后一步断了，「继续整理」不重读卖点 ----
  const splitId = randomUUID();
  await call(0, 'projects', { id: splitId, name: '分段款', layout: 'M3', counts: counts(1) });
  for (let i = 0; i < 30; i++) await upload(0, splitId, await solid(200 - i * 5, 60 + i * 4, 90), `${i % 3 ? '详情' : '模特图'}/P_${i + 1}.png`);
  await call(0, `projects/${splitId}/plan`, {});
  const textOf = (request: unknown) => ((request as { messages: { content: unknown }[] }).messages[1].content as { type: string; text?: string }[]).filter(c => c.type === 'text').map(c => c.text).join('\n');
  let pointCalls = 0, wholeCalls = 0, wholeText = '';
  const splitProvider: Parameters<typeof executePlan>[1] = async (request, hooks) => {
    const system = String((request as { messages: { content: unknown }[] }).messages[0].content), text = textOf(request);
    const sent = [...new Set(text.match(/M\d+/g))];
    await hooks.beforeSubmit();
    if (system.includes('只读出这些图上的卖点')) { pointCalls++; return reply({ points: [{ type: '功能', text: '三层 防水', from: [sent[0]] }, { type: '面料', text: `第${pointCalls}组独有`, from: [sent[1] ?? sent[0]] }], notes: [] }); }
    if (system.includes('卖点已经读好')) {
      wholeCalls++; wholeText = text;
      if (wholeCalls === 1) throw new Error('fetch failed');
      return reply({ colors: [{ name: '黑色', hex: '#111', from: [sent[0]] }], category: 'workwear', titles: { 功能: ['三防面料 雨天不怕'] } });
    }
    if (system.includes('读出颜色和卖点')) throw new Error('大款不该再一次读完');
    // The sort (and the colour list): two of every three a page with words.
    return reply({ images: sent.map(m => ({ id: m, kind: Number(m.slice(1)) % 3 ? '卖点图' : '模特实拍', color: '黑色', front: m === sent[0], text: Number(m.slice(1)) % 3 > 0 })), colors: [{ name: '黑色', hex: '#111', from: [sent[0]] }] });
  };
  await executePlan(await latest(splitId, 'plan'), splitProvider);
  const halfway = await detailOf(splitId);
  assert.equal(halfway.status, 'failed'); assert.match(halfway.error, /整理到一半中断了.*进度已保存/);
  assert.ok(pointCalls >= 2, `卖点分了 ${pointCalls} 组`);
  const pointsBefore = pointCalls;
  await call(0, `projects/${splitId}/plan`, {});
  await executePlan(await latest(splitId, 'plan'), splitProvider);
  const split = await detailOf(splitId);
  assert.equal(split.status, 'materials');
  assert.equal(pointCalls, pointsBefore, '继续整理不重读卖点');
  assert.equal(wholeCalls, 2);
  assert.match(wholeText, /已经读出的卖点：\n1\. 三层 防水/);
  const texts3 = split.materials.sorted.points.map((p: { text: string }) => p.text);
  assert.equal(texts3.filter((t: string) => t === '三层 防水').length, 1);
  assert.equal(texts3.filter((t: string) => /组独有/.test(t)).length, pointsBefore);
  assert.ok(split.materials.sorted.points.find((p: { text: string }) => p.text === '三层 防水').from.length >= 2);
  assert.deepEqual(split.materials.titles, { 功能: ['三防面料 雨天不怕'] });
  pass('大款分段读：带字的图分组读卖点、同一句卖点只留一条（图号合并），再看照片读颜色和整款；最后一步断了，「继续整理」不重读卖点');

  // ---- 学新版式：参考图 3–10 张，冻结 100 积分，学好出样图，保存时可改每类图有没有人，团队共用 ----
  const lay = randomUUID();
  await call(0, 'layouts', { id: lay, name: '细节特写格' });
  await call(1, `layouts/${lay}`, undefined, 404);
  const refImg = (r: number) => sharp({ create: { width: 500, height: 500, channels: 3, background: { r, g: 120, b: 60 } } }).jpeg().toBuffer();
  const addRef = (index: number, id: string, bytes: Buffer, expected = 200) => call(index, `layouts/${id}/refs`, bytes, expected, 'POST', { 'content-type': 'application/octet-stream', 'x-file-name': 'ref.jpg' });
  await addRef(0, lay, await refImg(10)); await addRef(0, lay, await refImg(40));
  await call(0, `layouts/${lay}/learn`, {}, 400);
  await addRef(0, lay, await refImg(80)); await addRef(1, lay, await refImg(90), 404);
  const beforeLearn = await balance(tenants[0]);
  assert.equal((await (await call(0, `layouts/${lay}/learn`, {})).json()).status, 'queued');
  assert.equal(beforeLearn - await balance(tenants[0]), 100);
  const layoutHold = async (id: string) => (await db().query("SELECT state,amount_cents,settled_cents FROM credit_holds WHERE id=$1", ['listing:layout:' + id])).rows[0];
  assert.deepEqual([(await layoutHold(lay)).state, Number((await layoutHold(lay)).amount_cents)], ['held', 100]);
  await addRef(0, lay, await refImg(120), 409);
  const compact = (t: Template) => ({ people: t.people, ...(t.display ? { display: t.display } : {}), zones: t.zones.map(z => [z.kind, ...z.box]) });
  // The model answers with 首图 only in 1:1 cards it cannot fit in 3:4 and leaves 场景 out.
  // Learning reads the zone kinds of the layouts before the masters (no badge, band or fabric).
  const old = LEGACY_LAYOUTS.find(l => l.id === 'warm-impact')!;
  const spec = { description: '大字标题在上、三格细节', style: { ...old.style, title: '顶部超大白色粗体' },
    templates: Object.fromEntries(TASKS.filter(t => t !== '场景').map(t => [t, { square: compact(old.templates[t].square), portrait: compact(old.templates[t].portrait) }])), long: compact(old.long), sku: compact(old.sku) };
  spec.templates.细节 = { square: { people: 0, zones: [['title', 5, 4, 90, 10], ['card', 4, 20, 30, 70], ['card', 35, 20, 30, 70], ['card', 66, 20, 30, 70]] }, portrait: { people: 0, zones: [['title', 5, 4, 90, 8], ['card', 5, 16, 90, 38], ['card', 5, 56, 90, 38]] } };
  const learnPrompts: string[] = [];
  const learnWorker = await startListingWorker({ concurrency: 2, learn: {
    plan: async () => ({ content: JSON.stringify(spec), model: 'm', requestId: 'r', usage: null, durationMs: 1 }),
    image: async input => { learnPrompts.push(input.prompt); return { bytes: await sharp({ create: { width: 64, height: 64, channels: 3, background: '#c88d2e' } }).png().toBuffer(), taskId: 't', credits: 1, durationMs: 1 }; },
  } });
  for (let i = 0; i < 80 && (await (await call(0, `layouts/${lay}`)).json()).status !== 'draft'; i++) await new Promise(r => setTimeout(r, 250));
  await learnWorker.close();
  const learned = await (await call(0, `layouts/${lay}`)).json();
  assert.equal(learned.status, 'draft'); assert.equal(learned.samples.length, 3); assert.equal(learned.refs.length, 3);
  assert.equal(learned.layout.templates.细节.square.zones.filter((z: { kind: string }) => z.kind === 'card').length, 2);
  assert.deepEqual(learned.layout.templates.场景, LEGACY_LAYOUTS[0].templates.场景);
  assert.equal(learnPrompts.length, 3); assert.ok(learnPrompts.every(p => p.includes('标题字顶部超大白色粗体')));
  assert.deepEqual([(await layoutHold(lay)).state, Number((await layoutHold(lay)).settled_cents)], ['settled', 100]);
  assert.ok(!(await (await call(0, 'config')).json()).layouts.some((l: { id: string }) => l.id === lay));
  await call(1, `layouts/${lay}/save`, {}, 409);
  await call(0, `layouts/${lay}/save`, { people: { 首图: { people: 0, display: '挂拍' } } });
  const cfg = await (await call(0, 'config')).json();
  assert.equal(cfg.layoutCredits, 100);
  const mine = cfg.layouts.find((l: { id: string; own: boolean }) => l.id === lay && l.own) as Layout;
  assert.deepEqual([mine.templates.首图.square.people, mine.templates.首图.square.display, mine.templates.首图.square.zones.some(z => z.kind === 'person')], [0, '挂拍', false]);
  assert.ok(!(await (await call(1, 'config')).json()).layouts.some((l: { id: string }) => l.id === lay));
  assert.equal((await call(0, `layouts/${lay}/files/sample/0`)).status, 200);
  await call(1, `layouts/${lay}/files/sample/0`, undefined, 404);
  const usesLayout = randomUUID();
  await call(1, 'projects', { id: randomUUID(), name: '别人的版式', layout: lay, counts: counts(1) }, 400);
  await call(0, 'projects', { id: usesLayout, name: '用学来的版式', layout: lay, counts: counts(1) });
  await call(0, `layouts/${lay}`, undefined, 200, 'DELETE');
  assert.ok(!(await (await call(0, 'config')).json()).layouts.some((l: { id: string }) => l.id === lay));
  await call(0, 'projects', { id: randomUUID(), name: '删了的版式', layout: lay, counts: counts(1) }, 400);
  // A still life on white (10-19: one in a scene is no longer the product image as it is).
  const onWhite = await sharp({ create: { width: 800, height: 800, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 400, height: 520, channels: 3, background: '#1f1f1f' } }, left: 200, top: 140 }]).jpeg().toBuffer();
  await upload(0, usesLayout, onWhite, 'a.jpg');
  await call(0, `projects/${usesLayout}/plan`, {});
  const label = (await detailOf(usesLayout)).sources[0].label;
  const beforeUses = await balance(tenants[0]);
  const written = await toGenerating(usesLayout, { images: [{ id: label, kind: '静物', color: '黑色', front: true }], colors: [{ name: '黑色', hex: '#111', from: [label] }], points: [], category: 'workwear' },
    m => draftFrom(m, mine, counts(1)), { product: { name: '用学来的版式', garment: ['立领'] } });
  assert.match(written.request, /母版「细节特写格」：大字标题在上、三格细节/);
  assert.match(written.request, /square:1：首图；无人·挂拍/);
  const usesPlan = await detailOf(usesLayout);
  assert.equal(usesPlan.status, 'generating');
  assert.deepEqual((await db().query('SELECT plan->\'direct\' d FROM listing_projects WHERE id=$1', [usesLayout])).rows[0].d, [label]);
  assert.equal((await db().query(`SELECT materials->'sorted'->'images'->0->>'plain' p FROM listing_projects WHERE id=$1`, [usesLayout])).rows[0].p, 'true');
  // The clean still life is the product image itself: it costs nothing.
  const usesFirst = roundOf(written.draft, mine, 1, new Set([label]));
  assert.ok(usesFirst[0].free);
  assert.equal(beforeUses - await balance(tenants[0]), costOf(usesFirst));
  pass('学新版式：至少 3 张参考图，冻结并扣 100 积分，出 3 张样图；1:1 和 3:4 格数对齐、没学到的那类图用内置的；保存时可改有没有人；团队可选、别人看不到用不了；删除后用过它的款照样能用；干净静物直接当白底图、不收费');
  const failing = randomUUID();
  await call(0, 'layouts', { id: failing, name: '学不成' });
  for (const r of [150, 170, 190]) await addRef(0, failing, await refImg(r));
  await call(0, `layouts/${failing}/learn`, {});
  const badWorker = await startListingWorker({ concurrency: 1, learn: { plan: async () => ({ content: '{"description":"x"}', model: 'm', requestId: 'r', usage: null, durationMs: 1 }) } });
  for (let i = 0; i < 80 && (await (await call(0, `layouts/${failing}`)).json()).status !== 'failed'; i++) await new Promise(r => setTimeout(r, 250));
  await badWorker.close();
  const failed = await (await call(0, `layouts/${failing}`)).json();
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /没有扣积分/); assert.equal((await layoutHold(failing)).state, 'released');
  pass('学版式失败：AI 总结不完整时标为没学成，冻结的积分全部退回');

  // ---- 存储：出图 30 天后清掉原始素材（只出了方图的款也清）；删除一款退还空间（别的款还在用的文件照样计入） ----
  const usage = async () => Number((await db().query('SELECT bytes_used FROM tenant_usage WHERE tenant_id=$1', [tenants[0]])).rows[0].bytes_used);
  const refs = async (fileId: string) => (await db().query("SELECT 1 FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2", [tenants[0], fileId])).rowCount;
  const fileOf = async (project: string, path: string) => (await db().query('SELECT file_id FROM listing_assets WHERE project_id=$1 AND rel_path=$2', [project, path])).rows[0].file_id as string;
  const skuFile = await fileOf(two, 'SKU图/黑色.jpg'), sourceMain = await fileOf(id, '1比1主图/主图_1.jpg');
  await db().query("UPDATE listing_projects SET updated_at=now()-interval '29 days' WHERE id=$1", [two]);
  assert.equal(await clearOldSources(), 0);
  await db().query("UPDATE listing_projects SET updated_at=now()-interval '31 days' WHERE id=$1", [two]);
  const outputsBefore = (await db().query("SELECT count(*)::int n FROM listing_assets WHERE project_id=$1 AND kind<>'source'", [two])).rows[0].n;
  assert.equal(await clearOldSources(), 1);
  assert.equal((await db().query("SELECT count(*)::int n FROM listing_assets WHERE project_id=$1 AND kind='source'", [two])).rows[0].n, 0);
  assert.equal((await db().query("SELECT count(*)::int n FROM listing_assets WHERE project_id=$1 AND kind<>'source'", [two])).rows[0].n, outputsBefore);
  assert.ok((await (await call(0, 'projects')).json()).find((p: { id: string }) => p.id === two).sources_cleared_at);
  assert.equal(await refs(skuFile), 1);
  assert.equal(await clearOldSources(), 0);
  pass('清理：最后一次出图满 30 天才清原始素材（停在方图的款也算），生成的图都在；同一张图别的款还在用就照样计入空间');
  // 存储空间页（10-28）：每款占多少、删掉能腾出多少——别的款还在用的文件不算能腾出的，和删除真正退回的一致
  const { storageUsage } = await import('../lib/server/storage-usage');
  const space = await storageUsage(tenants[0]), shownRow = space.products.find(p => p.id === id)!;
  assert.equal(space.usage.bytesUsed, await usage());
  assert.ok(space.parts.listing.bytes > 0 && space.parts.listing.files > 0);
  assert.ok(shownRow.freeableBytes > 0 && shownRow.bytes > shownRow.freeableBytes, '和别的款共用的原图算占用，不算能腾出');
  assert.ok(!(await storageUsage(tenants[1])).products.some(p => p.id === id), '别的账号的存储页看不到这款');
  const usedBefore = await usage();
  await call(1, 'projects/' + id, undefined, 404, 'DELETE');
  const deleted = await (await call(0, 'projects/' + id, undefined, 200, 'DELETE')).json();
  assert.ok(deleted.freedBytes > 0); assert.equal(usedBefore - await usage(), deleted.freedBytes);
  assert.equal(deleted.freedBytes, shownRow.freeableBytes, '存储页说能腾出多少，删掉就退回多少');
  assert.ok(!(await storageUsage(tenants[0])).products.some(p => p.id === id));
  assert.equal(await refs(skuFile), 0); assert.equal(await refs(sourceMain), 1);
  await call(0, 'projects/' + id, undefined, 404);
  assert.ok(!(await (await call(0, 'projects')).json()).some((p: { id: string }) => p.id === id));
  pass('删除：别人删不了，删除后列表和详情都看不到；退还空间，别的款还在用的文件照样计入；存储页算的「删掉能腾出」和实际退回一致');

  // ---- 回收站（10-28）：三种删法都先进回收站、空间马上退；恢复原样放回、重新占空间；后删的先恢复；立即彻底删除后不能恢复 ----
  const { listTrash, restoreTrash, purgeTrashNow } = await import('../lib/server/listing-trash');
  const binned = (await listTrash(tenants[0])).find(t => t.targetId === id)!;
  assert.equal(binned.mode, 'all'); assert.equal(binned.bytes, deleted.freedBytes); assert.ok(binned.restorable);
  await assert.rejects(() => restoreTrash(tenants[1], binned.id), /没有这一项/);
  await restoreTrash(tenants[0], binned.id);
  assert.equal(await usage(), usedBefore, '恢复整款后空间重新占回');
  assert.ok((await (await call(0, 'projects')).json()).some((p: { id: string }) => p.id === id));
  await assert.rejects(() => restoreTrash(tenants[0], binned.id), /已经恢复过/);
  assert.ok(!(await listTrash(tenants[0])).some(t => t.id === binned.id));
  await call(0, 'projects/' + id, undefined, 200, 'DELETE');

  const binProject = randomUUID();
  await call(0, 'projects', { id: binProject, name: '回收站验收', layout: 'M3', counts: counts(1) });
  for (const [k, color] of ['#7a3b2e', '#2e5b7a', '#5b7a2e'].entries()) await upload(0, binProject, await image(500 + k * 10, 500, color), `回收站/${k + 1}.jpg`);
  const assetsOf = async (kinds?: string) => (await db().query(`SELECT count(*)::int n FROM listing_assets WHERE project_id=$1${kinds ? ` AND kind IN (${kinds})` : ''}`, [binProject])).rows[0].n as number;
  const flags = async () => (await db().query('SELECT sources_cleared_at, images_cleared_at FROM listing_projects WHERE id=$1', [binProject])).rows[0];
  const binUsage = await usage();
  // 只删原图
  const sourcesGone = await (await call(0, `projects/${binProject}/remove`, { mode: 'sources' })).json();
  assert.ok(sourcesGone.freedBytes > 0); assert.equal(binUsage - await usage(), sourcesGone.freedBytes);
  assert.equal(await assetsOf("'source'"), 0); assert.ok((await flags()).sources_cleared_at);
  await call(0, `projects/${binProject}/remove`, { mode: 'sources' }, 409);
  await call(1, `projects/${binProject}/remove`, { mode: 'all' }, 404);
  await call(0, `projects/${binProject}/remove`, { mode: 'everything' }, 400);
  await restoreTrash(tenants[0], sourcesGone.trashId);
  assert.equal(await assetsOf("'source'"), 3); assert.equal((await flags()).sources_cleared_at, null); assert.equal(await usage(), binUsage);
  // 只删图片：留一张小封面，列表照样有图；恢复后封面收回
  const imagesGone = await (await call(0, `projects/${binProject}/remove`, { mode: 'images' })).json();
  assert.equal(await assetsOf("'source','product','output','ref'"), 0); assert.equal(await assetsOf("'thumb'"), 1);
  assert.ok((await flags()).images_cleared_at && (await flags()).sources_cleared_at);
  const binListed = (await (await call(0, 'projects')).json()).find((p: { id: string }) => p.id === binProject);
  assert.ok(binListed.images_cleared_at && binListed.cover, '图片清理后列表还有封面');
  assert.ok(binUsage - await usage() > 0 && imagesGone.freedBytes > binUsage - await usage(), '封面只占回几 KB');
  // 后删的先恢复：再整款删除，先恢复「只删图片」被拒
  const allGone = await (await call(0, 'projects/' + binProject, undefined, 200, 'DELETE')).json();
  await assert.rejects(() => restoreTrash(tenants[0], imagesGone.trashId), /先恢复后面那次/);
  assert.equal((await listTrash(tenants[0])).find(t => t.id === imagesGone.trashId)!.restorable, false);
  await restoreTrash(tenants[0], allGone.trashId);
  await restoreTrash(tenants[0], imagesGone.trashId);
  assert.equal(await assetsOf("'source'"), 3); assert.equal(await assetsOf("'thumb'"), 0);
  assert.equal((await flags()).images_cleared_at, null); assert.equal((await flags()).sources_cleared_at, null);
  assert.equal(await usage(), binUsage, '删了又全部恢复，空间和删之前一样');
  // 空间不够时不让恢复，什么都不动
  const reBinned = await (await call(0, `projects/${binProject}/remove`, { mode: 'sources' })).json();
  const quotaBefore = (await db().query('SELECT storage_quota_bytes FROM tenants WHERE id=$1', [tenants[0]])).rows[0].storage_quota_bytes;
  await db().query('UPDATE tenants SET storage_quota_bytes=(SELECT bytes_used FROM tenant_usage WHERE tenant_id=$1) WHERE id=$1', [tenants[0]]);
  await assert.rejects(() => restoreTrash(tenants[0], reBinned.trashId), /空间不够恢复/);
  assert.equal(await assetsOf("'source'"), 0);
  await db().query('UPDATE tenants SET storage_quota_bytes=$2 WHERE id=$1', [tenants[0], quotaBefore]);
  // 立即彻底删除：从回收站消失，不能再恢复
  await purgeTrashNow(tenants[0], reBinned.trashId);
  assert.ok(!(await listTrash(tenants[0])).some(t => t.id === reBinned.trashId));
  await assert.rejects(() => restoreTrash(tenants[0], reBinned.trashId), /已经彻底删除/);
  assert.equal((await purgeTrashNow(tenants[1], 'all')).purged, 0, '清空回收站只清自己的');
  pass('回收站：整款 / 只删原图 / 只删图片都先进回收站、空间马上退；恢复原样放回并重新占空间；后删的先恢复；空间不够不让恢复；彻底删除后不能恢复；别的账号碰不到');

  // ---- 存储额度：用满后，新图在写进对象存储之前就被拒绝，不留下孤儿对象；已有的图重传不占空间 ----
  const objects = async () => (await readdir(join(root, 'objects'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).length;
  const full = randomUUID();
  await call(1, 'projects', { id: full, name: '额度验收', layout: 'M3', counts: counts(3, 2, 1) });
  const held = await image(300, 300, '#123456');
  await upload(1, full, held, '额度/已有.jpg');
  await db().query('UPDATE tenants SET storage_quota_bytes=(SELECT bytes_used FROM tenant_usage WHERE tenant_id=$1) WHERE id=$1', [tenants[1]]);
  const objectsBefore = await objects();
  await upload(1, full, await image(320, 320, '#654321'), '额度/新图.jpg', 413);
  await call(1, `projects/${full}/refs`, await image(330, 330, '#abcdef'), 413, 'POST', { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('参考.jpg') });
  assert.equal(await objects(), objectsBefore, '被拒绝的上传没有写进对象存储');
  await upload(1, full, held, '额度/已有-再传.jpg');
  await db().query('UPDATE tenants SET storage_quota_bytes=10000000 WHERE id=$1', [tenants[1]]);
  pass('额度：用满后新图和参考图都在写入存储前被拒（413），存储里不多出文件；已有的同一张图重传照常');

  // ---- 同一张图同时传几次（素材里一张图和它的副本，网页 4 张并行上传）：都成功，只存一份。10-19 跑批时撞上存储路径约束报过 500，
  // 那个瞬间在这里撞不出来；修法（冲突不限约束）见 catalog-files.ts ----
  const twinProject = randomUUID();
  await call(0, 'projects', { id: twinProject, name: '同图并发', layout: 'M3', counts: counts(1) });
  const twin = await image(640, 480, '#3c6e47');
  const twins = await Promise.all(Array.from({ length: 8 }, (_, k) => `双胞胎/${k + 1}.jpg`).map(path => call(0, `projects/${twinProject}/images`, twin, 200, 'POST', { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(path.split('/').at(-1)!), 'x-file-path': encodeURIComponent(path) })));
  assert.equal(new Set((await Promise.all(twins.map(r => r.json()))).map((x: { id: string }) => x.id)).size, 1);
  assert.equal((await db().query(`SELECT count(*)::int n FROM files f JOIN listing_assets a ON a.file_id=f.id WHERE a.project_id=$1`, [twinProject])).rows[0].n, 1);
  pass('同一张图同时传几次：都成功，存储里只有一份');
  console.log(`COMPLETE ${checks} checks; no external provider called`);
} finally {
  await closeCatalogDatabase(); await database.stop().catch(() => {}); await rm(root, { recursive: true, force: true });
}
