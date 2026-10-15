/**
 * 电商主图 layouts a team learns from reference images. The model writes the layout in the same
 * fields as a built-in one (style, where things go on each kind of image, the SKU image), three
 * sample images are made on a sample garment, and a saved layout is shared by the whole tenant.
 * Learning holds 100 credits; it is charged only when the samples are made.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { readCatalogFile, saveCatalogFile } from './catalog-files';
import { registerFileRef } from './file-authorization';
import { currentPrices, holdCredits, microToCents, priceOf, releaseHold, settleHold } from './credits';
import { LEGACY_LAYOUTS } from '../listing/legacy-layouts';
import { BUILT_IN_LAYOUTS, capacity, fitTemplate, withPeople, type Box, type Display, type Layout, type People, type Template, type ZoneKind } from '../listing/templates';
import { TASKS, type Task } from '../listing/category';
import { mainPrompt, skuPrompt, type Content } from './listing-prompts';
import { callPlanModel, generateListingImage, LISTING_PLAN_MODEL, assertListingProviderConfigured, type ImageCall, type PlanCall } from './listing-provider';
import type { Tenant } from './tenant-scope';

export const MIN_REFS = 3, MAX_REFS = 10;
const db = () => catalogDatabase();
const holdId = (id: string) => 'listing:layout:' + id;

/** What the page needs to show and pick a layout: the whole layout, and who learned it. */
export type LayoutCard = Layout & { own: boolean };
const sampleUrl = (layoutId: string, n: number) => `/api/listing/layouts/${layoutId}/files/sample/${n}`;
/** A learned layout as stored: everything but its id, name and samples. */
type Spec = Omit<Layout, 'id' | 'name' | 'samples' | 'own' | 'by' | 'createdAt'>;
type Row = { id: string; tenant_id: string; name: string; status: string; spec: Spec | null; error: string | null; created_by: string; created_at: Date; by_name?: string };

const toLayout = (row: Row): Layout => ({ ...row.spec!, id: row.id, name: row.name, samples: [0, 1, 2].map(n => sampleUrl(row.id, n)) });
const layoutById = (id: string) => BUILT_IN_LAYOUTS.find(l => l.id === id);
/** The two layouts before the masters (10-11): products made with them still open and redo; new ones cannot pick them. */
const legacyById = (id: string) => LEGACY_LAYOUTS.find(l => l.id === id);

/** Built-in layouts plus the tenant's saved ones, for the page. */
export async function layoutCards(tenantId: string): Promise<LayoutCard[]> {
  const rows = (await db().query(`SELECT l.id,l.name,l.spec,l.created_at,u.display_name by_name FROM listing_layouts l LEFT JOIN users u ON u.id=l.created_by
    WHERE l.tenant_id=$1 AND l.status='ready' AND l.spec IS NOT NULL ORDER BY l.created_at`, [tenantId])).rows as Row[];
  return [...BUILT_IN_LAYOUTS.map(l => ({ ...l, own: false })), ...rows.map(r => ({ ...toLayout(r), own: true, by: r.by_name ?? '', createdAt: r.created_at.toISOString() }))];
}

/**
 * The layout a project uses. A learned one is found in its own tenant only; one deleted after a
 * project chose it still works for that project.
 */
export async function resolveLayout(tenantId: string, id: string, { forNewProject = false } = {}): Promise<Layout | undefined> {
  const builtIn = layoutById(id) ?? (forNewProject ? undefined : legacyById(id));
  if (builtIn) return builtIn;
  if (!z.uuid().safeParse(id).success) return undefined;
  const row = (await db().query(`SELECT * FROM listing_layouts WHERE id=$1 AND tenant_id=$2 AND spec IS NOT NULL`, [id, tenantId])).rows[0] as Row | undefined;
  if (!row || (forNewProject && row.status !== 'ready')) return undefined;
  return toLayout(row);
}

/* ---------- learning, from the page ---------- */

export async function createLayout(tenant: string, user: string, input: unknown) {
  const b = z.object({ id: z.uuid(), name: z.string().trim().min(1, '请给版式起个名字').max(12, '名字最多 12 个字') }).parse(input);
  await db().query(`INSERT INTO listing_layouts(id,tenant_id,created_by,name) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [b.id, tenant, user, b.name]);
  const row = (await db().query('SELECT tenant_id FROM listing_layouts WHERE id=$1', [b.id])).rows[0];
  if (row?.tenant_id !== tenant) throw new CatalogHttpError(409, '版式编号冲突');
  return { id: b.id };
}

/** Store a file the tenant pays storage for, inside the caller's transaction. */
async function keepFile(c: CatalogQueryClient, tenant: string, fileId: string, bytes: number, name: string) {
  const owned = await c.query('SELECT 1 FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2 LIMIT 1', [tenant, fileId]);
  if (!owned.rowCount) {
    const updated = await c.query(`UPDATE tenant_usage u SET bytes_used=bytes_used+$2 FROM tenants t
      WHERE u.tenant_id=$1 AND t.id=u.tenant_id AND u.bytes_used+u.bytes_reserved+$2<=t.storage_quota_bytes RETURNING u.tenant_id`, [tenant, bytes]);
    if (!updated.rowCount) throw new CatalogHttpError(413, '存储空间不足');
  }
  await registerFileRef(fileId, tenant, 'listing-layouts', name.slice(0, 200), c);
}

export async function addLayoutRef(tenant: string, layoutId: string, bytes: Buffer, name: string) {
  z.uuid().parse(layoutId);
  if (bytes.length > 25 * 1024 * 1024) throw new CatalogHttpError(413, '单张图片不能超过 25MB');
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try { meta = await sharp(bytes, { failOn: 'error', limitInputPixels: 60_000_000 }).metadata(); } catch { throw new CatalogHttpError(400, `不是能读取的图片：${name}`); }
  if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '')) throw new CatalogHttpError(400, `只支持 JPG、PNG、WebP：${name}`);
  let n = -1;
  await saveCatalogFile(bytes, name.slice(0, 200), 'production', async (c, fileId) => {
    await c.query('SELECT id FROM tenants WHERE id=$1 AND NOT disabled FOR UPDATE', [tenant]);
    const layout = (await c.query(`SELECT status FROM listing_layouts WHERE id=$1 AND tenant_id=$2`, [layoutId, tenant])).rows[0];
    if (!layout) throw new CatalogHttpError(404, '版式不存在');
    if (layout.status !== 'uploading') throw new CatalogHttpError(409, '已经开始学了，不能再加图');
    const existing = (await c.query(`SELECT n FROM listing_layout_files WHERE layout_id=$1 AND kind='ref' AND file_id=$2`, [layoutId, fileId])).rows[0];
    if (existing) { n = existing.n; return; }
    n = Number((await c.query(`SELECT count(*) n FROM listing_layout_files WHERE layout_id=$1 AND kind='ref'`, [layoutId])).rows[0].n);
    if (n >= MAX_REFS) throw new CatalogHttpError(413, `最多 ${MAX_REFS} 张参考图`);
    await keepFile(c, tenant, fileId, bytes.length, name);
    await c.query(`INSERT INTO listing_layout_files(layout_id,file_id,kind,n,name) VALUES($1,$2,'ref',$3,$4)`, [layoutId, fileId, n, name.slice(0, 200)]);
  });
  return { n };
}

/** Uploads are done: hold the price and queue the learning. */
export async function startLearning(tenant: Tenant, layoutId: string) {
  assertListingProviderConfigured();
  const prices = await currentPrices();
  return catalogTransaction(async c => {
    const layout = (await c.query(`SELECT status FROM listing_layouts WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [layoutId, tenant.id])).rows[0];
    if (!layout) throw new CatalogHttpError(404, '版式不存在');
    if (['queued', 'learning'].includes(layout.status)) return { status: layout.status };
    if (layout.status !== 'uploading') throw new CatalogHttpError(409, '这个版式已经学过了');
    const refs = Number((await c.query(`SELECT count(*) n FROM listing_layout_files WHERE layout_id=$1 AND kind='ref'`, [layoutId])).rows[0].n);
    if (refs < MIN_REFS) throw new CatalogHttpError(400, `至少上传 ${MIN_REFS} 张参考图`);
    if (!(await c.query("SELECT 1 FROM listing_workers WHERE heartbeat_at>now()-interval '45 seconds' LIMIT 1")).rowCount) {
      throw new CatalogHttpError(503, '电商主图后台未连接，未冻结积分，请稍后再试');
    }
    await holdCredits(c, { id: holdId(layoutId), tenantId: tenant.id, kind: 'analysis', jobRef: 'listing:layout:' + layoutId,
      billingMode: tenant.billingMode, amountCents: microToCents(priceOf(prices, 'listing_layout').userMicroCents), snapshot: prices });
    await c.query(`UPDATE listing_layouts SET status='queued',error=NULL,updated_at=now() WHERE id=$1`, [layoutId]);
    return { status: 'queued' };
  });
}

/** One layout as the learning dialog shows it, including the user's own drafts. */
export async function layoutState(tenant: string, layoutId: string) {
  z.uuid().parse(layoutId);
  const row = (await db().query(`SELECT * FROM listing_layouts WHERE id=$1 AND tenant_id=$2 AND status<>'deleted'`, [layoutId, tenant])).rows[0] as Row | undefined;
  if (!row) throw new CatalogHttpError(404, '版式不存在');
  const files = (await db().query(`SELECT kind,n FROM listing_layout_files WHERE layout_id=$1 ORDER BY kind,n`, [layoutId])).rows as { kind: string; n: number }[];
  return { id: row.id, name: row.name, status: row.status, error: row.error, layout: row.spec ? toLayout(row) : null,
    refs: files.filter(f => f.kind === 'ref').map(f => `/api/listing/layouts/${row.id}/files/ref/${f.n}`),
    samples: files.filter(f => f.kind === 'sample').map(f => sampleUrl(row.id, f.n)) };
}

/** Layouts still being learned or waiting to be saved, so the page can pick them up again. */
export async function openLayouts(tenant: string, user: string) {
  return (await db().query(`SELECT id,name,status FROM listing_layouts WHERE tenant_id=$1 AND created_by=$2 AND status IN ('queued','learning','draft','failed') ORDER BY created_at DESC LIMIT 10`, [tenant, user])).rows;
}

export async function layoutFile(tenant: string, layoutId: string, kind: string, n: number) {
  z.uuid().parse(layoutId);
  const row = (await db().query(`SELECT f.file_id FROM listing_layout_files f JOIN listing_layouts l ON l.id=f.layout_id WHERE f.layout_id=$1 AND l.tenant_id=$2 AND f.kind=$3 AND f.n=$4`, [layoutId, tenant, kind, n])).rows[0];
  if (!row) throw new CatalogHttpError(404, '图片不存在');
  return readCatalogFile(row.file_id);
}

/** Keep a learned layout, with the user's corrections of which images have people. */
export async function saveLayout(tenant: string, layoutId: string, input: unknown = {}) {
  z.uuid().parse(layoutId);
  const people = z.object({ people: z.record(z.string(), z.object({ people: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), display: z.enum(['平铺', '挂拍', '隐形人台']).optional() })).default({}) }).parse(input).people;
  return catalogTransaction(async c => {
    const row = (await c.query(`SELECT spec FROM listing_layouts WHERE id=$1 AND tenant_id=$2 AND status='draft' FOR UPDATE`, [layoutId, tenant])).rows[0] as { spec: Spec } | undefined;
    if (!row) throw new CatalogHttpError(409, '只有学好的版式可以保存');
    const templates = { ...row.spec.templates };
    for (const [task, v] of Object.entries(people)) if (task in templates) {
      const t = templates[task as Task];
      templates[task as Task] = { square: withPeople(t.square, v.people as People, v.display as Display | undefined), portrait: withPeople(t.portrait, v.people as People, v.display as Display | undefined) };
    }
    await c.query(`UPDATE listing_layouts SET status='ready',spec=$2,updated_at=now() WHERE id=$1`, [layoutId, { ...row.spec, templates }]);
    return { ok: true };
  });
}

/** Delete a layout (or drop a draft) and give its storage back; projects that used it keep working. */
export async function deleteLayout(tenant: string, layoutId: string) {
  z.uuid().parse(layoutId);
  return catalogTransaction(async c => {
    await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenant]);
    const row = (await c.query(`SELECT status FROM listing_layouts WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [layoutId, tenant])).rows[0];
    if (!row || row.status === 'deleted') throw new CatalogHttpError(404, '版式不存在');
    if (['queued', 'learning'].includes(row.status)) throw new CatalogHttpError(409, '正在学，学完再删');
    if (row.status === 'uploading') await releaseHold(holdId(layoutId), tenant, '没有开始学').catch(() => {});
    await c.query(`UPDATE listing_layouts SET status='deleted',updated_at=now() WHERE id=$1`, [layoutId]);
    // Files of the deleted layout stop counting unless something else of this tenant still uses them.
    const files = (await c.query('SELECT file_id FROM listing_layout_files WHERE layout_id=$1', [layoutId])).rows.map(r => r.file_id as string);
    for (const fileId of new Set(files)) {
      const used = await c.query(`SELECT 1 FROM listing_layout_files f JOIN listing_layouts l ON l.id=f.layout_id WHERE l.tenant_id=$1 AND f.file_id=$2 AND l.status<>'deleted' LIMIT 1`, [tenant, fileId]);
      if (used.rowCount) continue;
      await c.query(`DELETE FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2 AND purpose='listing-layouts'`, [tenant, fileId]);
      if ((await c.query('SELECT 1 FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2 LIMIT 1', [tenant, fileId])).rowCount) continue;
      const size = Number((await c.query('SELECT byte_length FROM files WHERE id=$1', [fileId])).rows[0]?.byte_length ?? 0);
      await c.query('UPDATE tenant_usage SET bytes_used=GREATEST(bytes_used-$2,0) WHERE tenant_id=$1', [tenant, size]);
    }
    return { ok: true };
  });
}

/* ---------- learning, in the worker ---------- */

// Learning writes the zone kinds of the layouts before the masters (no badge, band or fabric).
const example = LEGACY_LAYOUTS[0];
const compact = (t: Template) => ({ people: t.people, ...(t.display ? { display: t.display } : {}), zones: t.zones.map(z => [z.kind, ...z.box]) });
const SYSTEM = `你是淘宝服装类目的视觉设计总监。用户给你几张他喜欢的参考图（可能是别家店铺的主图、海报或 SKU 图），请把它们共同的版式和风格总结出来，以后要套到别的服装商品上出图。

要写的：
- style：标题字、小字、标签、卡片、光线、背景各一句。颜色写成相对衣服主色的规则（如“标签用衣服主色的加深色”），不要写死某个颜色。
- templates：每类图的排法，1:1（square）和 3:4（portrait）各一份；long 是 2:3 竖版长图（手淘推荐流，人物完整、只有一行字），sku 是 SKU 图（买家切颜色时看的，左上角写颜色名）。
  每份写 people（0 没有人、1 单人、2 双人、3 多人）、没有人时写 display（平铺 / 挂拍 / 隐形人台），和 zones：每个位置一行 [种类, 左, 上, 宽, 高]，位置是占画面的百分比。
  种类：title 大标题、sub 小字、tag 标签、card 卡片（一张演示画面配一行字）、icon 图标加一句话、person 人物、garment 衣服（没有人时）、swatch 一排色块。
  同一类图的 1:1 和 3:4，card、icon、tag 的个数必须一样（内容一样，只是排法不同）。参考图里有人的就写有人，没有人的写 0；参考图没覆盖到的那类图，按多数参考图的情况和同一种风格补上。

每一类图的用途：首图（定位做大标题，衣服要大）、服务（定制服务：设计、发货、开票，图标加一句话）、功能（每条卖点配一个演示画面）、细节（做工特写，每格一个部位）、实用（实用设计的演示）、场景（穿着上班、团队一起穿）、收口（几色可选和适合的人）。

禁止写：任何具体文字内容、人物长相、道具、品牌、logo、水印、具体某件衣服的款式。

下面是一个已有版式，只学它的写法和详细程度，不要照搬：
${JSON.stringify({ description: example.description, style: example.style, templates: { 首图: { square: compact(example.templates.首图.square) }, 功能: { square: compact(example.templates.功能.square) } } })}

只输出 JSON：
{ "description": "不超过 24 个字，概括这个风格", "style": { "title": "", "text": "", "tag": "", "card": "", "light": "", "background": "" },
  "templates": { ${TASKS.map(t => `"${t}": { "square": {}, "portrait": {} }`).join(', ')} }, "long": {}, "sku": {} }`;

const KINDS: ZoneKind[] = ['title', 'sub', 'tag', 'card', 'icon', 'person', 'garment', 'swatch'];
const zoneSchema = z.tuple([z.enum(KINDS as [ZoneKind, ...ZoneKind[]]), z.number(), z.number(), z.number(), z.number()]);
const templateSchema = z.object({ people: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).catch(1), display: z.enum(['平铺', '挂拍', '隐形人台']).optional().catch(undefined), zones: z.array(zoneSchema).min(1).max(16) });
const specSchema = z.object({
  description: z.string().trim().min(2).transform(s => s.slice(0, 40)),
  style: z.object({ title: z.string().min(2), text: z.string().default(''), tag: z.string().default(''), card: z.string().default(''), light: z.string().default(''), background: z.string().default('') }),
  templates: z.record(z.string(), z.object({ square: templateSchema, portrait: templateSchema })),
  long: templateSchema, sku: templateSchema,
});
/** Zones as a template: boxes kept inside the image, numbered by kind ("card2"); a garment zone with people becomes the people. */
function templateOf(raw: z.infer<typeof templateSchema>): Template {
  const seen = new Map<string, number>(), clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
  const zones = raw.zones.map(([kind, l, t, w, h]) => {
    const k = raw.people > 0 && kind === 'garment' ? 'person' : raw.people === 0 && kind === 'person' ? 'garment' : kind;
    const n = (seen.get(k) ?? 0) + 1; seen.set(k, n);
    const box: Box = [clamp(l), clamp(t), Math.max(1, Math.min(100 - clamp(l), clamp(w))), Math.max(1, Math.min(100 - clamp(t), clamp(h)))];
    return { id: k + n, kind: k, box };
  });
  return { people: raw.people as People, ...(raw.people === 0 ? { display: (raw.display ?? '平铺') as Display } : {}), zones };
}
/** The learned layout; the 3:4 template holds as many points as the 1:1 one; a kind of image the model left out follows the built-in one. */
export function specOf(raw: z.infer<typeof specSchema>): Spec {
  const templates = {} as Layout['templates'];
  for (const task of TASKS) {
    const got = raw.templates[task];
    if (!got) { templates[task] = example.templates[task]; continue; }
    let square = templateOf(got.square), portrait = templateOf(got.portrait);
    const a = capacity(square), b = capacity(portrait);
    if (a.cells !== b.cells) { const n = Math.min(a.cells, b.cells); square = fitTemplate(square, n); portrait = fitTemplate(portrait, n); }
    if (a.tags !== b.tags) {
      const n = Math.min(a.tags, b.tags), keep = (t: Template) => { let k = 0; return { ...t, zones: t.zones.filter(z => z.kind !== 'tag' || ++k <= n) }; };
      square = keep(square); portrait = keep(portrait);
    }
    templates[task] = { square, portrait };
  }
  return { description: raw.description, style: raw.style, templates, long: templateOf(raw.long), sku: templateOf(raw.sku) };
}

/** The sample garment the three sample images are made on, and what its two sample images say. */
const SAMPLE = {
  colors: [{ name: '落霞橙', hex: '#C88D2E' }],
  garment: ['无帽半高立领，前中单头全开同色拉链', '前胸左右对称折角分割线', '左右前腰各一个同色隐形拉链口袋，开口接近竖向', '长袖，袖口后侧半松紧', '下摆平直折边，衣长至胯部，男女同款直身版型', '细密平滑的哑光面料，衣身纯色无图案'],
  cover: { title: '轻盈抗造工作服', sub: '泼水轻擦 团体定制', tags: ['三防面料', '透气好活动'], cells: [], scene: '明亮的写字楼大堂，暖色侧光' } satisfies Content,
  detail: { title: '细节经得起看', sub: '领口拉链袖口逐一放大', tags: ['利落立领'], scene: '浅色柔和的背景',
    cells: [{ text: '挺括立领', recipe: '立领的近距离特写，缝线清楚' }, { text: '顺滑拉链', recipe: '门襟拉链的近距离特写' }, { text: '贴腕袖口', recipe: '袖口的近距离特写' }] } satisfies Content,
};
const sampleProduct = () => readFile(resolve(process.cwd(), 'lib/listing/sample-product.webp'));

type Providers = {
  plan?: (request: object, hooks: { beforeSubmit: () => Promise<void>; receipt: (id: string) => Promise<void> }) => Promise<PlanCall>;
  image?: (input: Parameters<typeof generateListingImage>[0], hooks: { beforeSubmit: () => Promise<void>; receipt: (id: string) => Promise<void> }) => Promise<ImageCall>;
};

/**
 * Learn one queued layout: read the references, write the layout, make three samples. The price
 * is charged only when it all worked; anything that fails is not charged (the attempt is cheap).
 */
export async function executeLayout(row: { id: string; tenant_id: string; created_by: string }, providers: Providers = {}) {
  const plan = providers.plan ?? ((request, hooks) => callPlanModel(request, hooks));
  const image = providers.image ?? ((input, hooks) => generateListingImage(input, hooks));
  const noHooks = { beforeSubmit: async () => {}, receipt: async () => {} };
  try {
    const refs = (await db().query(`SELECT file_id,name FROM listing_layout_files WHERE layout_id=$1 AND kind='ref' ORDER BY n`, [row.id])).rows as { file_id: string; name: string }[];
    const content: unknown[] = [{ type: 'text', text: `参考图共 ${refs.length} 张：` }];
    for (const [i, ref] of refs.entries()) {
      const jpeg = await sharp((await readCatalogFile(ref.file_id)).bytes, { limitInputPixels: 60_000_000 }).rotate().resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
      content.push({ type: 'text', text: `【参考图 ${i + 1}】` }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });
    }
    const call = await plan({ model: LISTING_PLAN_MODEL(), reasoning_effort: 'low', max_completion_tokens: 8000, response_format: { type: 'json_object' }, stream: false,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }] }, noHooks);
    let spec: Spec;
    try { spec = specOf(specSchema.parse(JSON.parse(call.content))); } catch { throw new CatalogHttpError(422, 'AI 总结的版式不完整，请换几张参考图再学'); }
    const name = (await db().query('SELECT name FROM listing_layouts WHERE id=$1', [row.id])).rows[0].name as string;
    const layout: Layout = { ...spec, id: row.id, name, samples: [] };
    const product = await sampleProduct();
    const sample = (task: Task, content: Content) => {
      const template = fitTemplate(layout.templates[task].square, content.cells.length);
      return mainPrompt({ ratio: 'square', task, template, layout, content, used: SAMPLE.colors, all: SAMPLE.colors, garment: SAMPLE.garment, lead: '男', fromSku: false, cast: null });
    };
    const prompts = [
      { prompt: sample('首图', SAMPLE.cover), ratio: 'square' as const },
      { prompt: sample('细节', SAMPLE.detail), ratio: 'square' as const },
      { prompt: skuPrompt({ layout, color: SAMPLE.colors[0].name, tag: '男女同款', fabric: '三防面料', garment: SAMPLE.garment, lead: '男', cast: null, anchor: null }), ratio: 'square' as const },
    ];
    const made = await Promise.all(prompts.map(p => image({ prompt: p.prompt, references: [product], ratio: p.ratio }, noHooks)));
    for (const [n, result] of made.entries()) {
      const bytes = await sharp(result.bytes).resize(720, 720, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
      await saveCatalogFile(bytes, `版式样图-${n + 1}.jpg`, 'production', async (c, fileId) => {
        // Samples are part of what was paid for: kept even when the storage quota is exceeded.
        await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [row.tenant_id]);
        const owned = await c.query('SELECT 1 FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2 LIMIT 1', [row.tenant_id, fileId]);
        if (!owned.rowCount) await c.query('UPDATE tenant_usage SET bytes_used=bytes_used+$2 WHERE tenant_id=$1', [row.tenant_id, bytes.length]);
        await registerFileRef(fileId, row.tenant_id, 'listing-layouts', `版式样图-${n + 1}.jpg`, c);
        await c.query(`INSERT INTO listing_layout_files(layout_id,file_id,kind,n,name) VALUES($1,$2,'sample',$3,$4) ON CONFLICT DO NOTHING`, [row.id, fileId, n, `样图 ${n + 1}`]);
      });
    }
    await db().query(`UPDATE listing_layouts SET status='draft',spec=$2,receipt=$3,lease_until=NULL,updated_at=now() WHERE id=$1`,
      [row.id, spec, { model: call.model, usage: call.usage, images: made.map(m => ({ taskId: m.taskId, credits: m.credits })) }]);
    await settleHold(holdId(row.id), row.tenant_id, [{ action: 'listing_layout', billable: true, certain: true, attemptId: row.id }]);
  } catch (error) {
    const message = (error instanceof Error ? error.message : '学版式失败').slice(0, 300);
    await db().query(`UPDATE listing_layouts SET status='failed',error=$2,lease_until=NULL,updated_at=now() WHERE id=$1`, [row.id, `${message}。没有扣积分，可以换图重学`]);
    await releaseHold(holdId(row.id), row.tenant_id, '学版式失败').catch(() => {});
  }
}

/** Claim one queued layout for this worker, or give up on one whose worker vanished. */
export async function claimLayout(owner: string) {
  const expired = (await db().query(`UPDATE listing_layouts SET status='failed',error='后台中断，没有扣积分，可以重新学',lease_until=NULL,updated_at=now()
    WHERE status='learning' AND lease_until<now() RETURNING id,tenant_id`)).rows as { id: string; tenant_id: string }[];
  for (const e of expired) await releaseHold(holdId(e.id), e.tenant_id, '后台中断').catch(() => {});
  return (await db().query(`UPDATE listing_layouts SET status='learning',owner=$1,lease_until=now()+interval '5 minutes',updated_at=now()
    WHERE id=(SELECT id FROM listing_layouts WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,tenant_id,created_by`, [owner])).rows[0] as { id: string; tenant_id: string; created_by: string } | undefined;
}
export const renewLayoutLease = (id: string, owner: string) => db().query(`UPDATE listing_layouts SET lease_until=now()+interval '5 minutes' WHERE id=$1 AND owner=$2 AND status='learning'`, [id, owner]);
