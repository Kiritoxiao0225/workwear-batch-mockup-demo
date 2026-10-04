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
import { LISTING_LAYOUTS, MAIN_ROLES, layoutById, type ListingLayout, type MainRole } from '../listing/layouts';
import { mainPrompt, skuPrompt, type MainSlot } from './listing-prompts';
import { callPlanModel, generateListingImage, LISTING_PLAN_MODEL, assertListingProviderConfigured, type ImageCall, type PlanCall } from './listing-provider';
import type { Tenant } from './tenant-scope';

export const MIN_REFS = 3, MAX_REFS = 10;
const db = () => catalogDatabase();
const holdId = (id: string) => 'listing:layout:' + id;
const ROLE_KEYS = [...Object.keys(MAIN_ROLES), '海报'] as (MainRole | '海报')[];

/** What the page needs to show and pick a layout; learned ones carry their own sample URLs. */
export type LayoutCard = { id: string; name: string; description: string; samples: string[]; own: boolean; by?: string; createdAt?: string };
const sampleUrl = (layoutId: string, n: number) => `/api/listing/layouts/${layoutId}/files/sample/${n}`;
type Row = { id: string; tenant_id: string; name: string; status: string; spec: Spec | null; error: string | null; created_by: string; created_at: Date; by_name?: string };
type Spec = { description: string; style: string; roles: Record<MainRole | '海报', string>; sku: string };

const toLayout = (row: Row): ListingLayout => ({ id: row.id, name: row.name, description: row.spec!.description, samples: [0, 1, 2].map(n => sampleUrl(row.id, n)),
  style: row.spec!.style, roles: row.spec!.roles, sku: row.spec!.sku });

/** Built-in layouts plus the tenant's saved ones, for the page. */
export async function layoutCards(tenantId: string): Promise<LayoutCard[]> {
  const rows = (await db().query(`SELECT l.id,l.name,l.spec,l.created_at,u.display_name by_name FROM listing_layouts l LEFT JOIN users u ON u.id=l.created_by
    WHERE l.tenant_id=$1 AND l.status='ready' ORDER BY l.created_at`, [tenantId])).rows as Row[];
  return [...LISTING_LAYOUTS.map(l => ({ id: l.id, name: l.name, description: l.description, samples: l.samples, own: false })),
    ...rows.map(r => ({ id: r.id, name: r.name, description: r.spec?.description ?? '', samples: [0, 1, 2].map(n => sampleUrl(r.id, n)), own: true, by: r.by_name ?? '', createdAt: r.created_at.toISOString() }))];
}

/**
 * The layout a project uses. A learned one is found in its own tenant only; one deleted after a
 * project chose it still works for that project.
 */
export async function resolveLayout(tenantId: string, id: string, { forNewProject = false } = {}): Promise<ListingLayout | undefined> {
  const builtIn = layoutById(id);
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
  return { id: row.id, name: row.name, status: row.status, error: row.error, spec: row.spec,
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

export async function saveLayout(tenant: string, layoutId: string) {
  z.uuid().parse(layoutId);
  const updated = await db().query(`UPDATE listing_layouts SET status='ready',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND status='draft' RETURNING id`, [layoutId, tenant]);
  if (!updated.rowCount) throw new CatalogHttpError(409, '只有学好的版式可以保存');
  return { ok: true };
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

const SYSTEM = `你是淘宝服装类目的视觉设计总监。用户给你几张他喜欢的参考图（可能是别家店铺的主图、海报或 SKU 图），请把它们共同的版式和风格总结出来，以后要套到别的服装商品上出图。

只描述：画面里各元素放在哪、多大、什么样式；整体配色规则、字体风格、标签样式、光线、背景类型、模特的裁切和姿态类型。
禁止描述：任何具体文字内容、人物长相与发型、道具（工牌、手机、平板、文件等）、具体场景物件、品牌、logo、水印、具体某件衣服的款式。这些即使参考图里有，也不要写。
颜色写成相对衣服主色的规则（如“标签用衣服主色的加深色”），不要写死某个颜色。
参考图没有覆盖到的图（比如只给了首图），按同一种风格合理设计，保持一整套统一。

每一类图的用途：
${Object.entries(MAIN_ROLES).map(([role, use]) => `- ${role}：${use}`).join('\n')}
- 海报：2:3 竖版店铺首页海报，氛围感最强
- SKU 图：买家切换颜色时看到的图，每个颜色一张，左上角写颜色名

下面是一个已有版式，只学它的写法和详细程度（写清位置、比例、元素），不要照搬内容：
${JSON.stringify({ description: LISTING_LAYOUTS[0].description, style: LISTING_LAYOUTS[0].style, roles: { 首图: LISTING_LAYOUTS[0].roles.首图 }, sku: LISTING_LAYOUTS[0].sku })}

只输出 JSON：
{ "description": "不超过 24 个字，概括这个风格", "style": "整体风格一段话", "roles": { "首图": "", "功能": "", "细节": "", "实用": "", "收口": "", "海报": "" }, "sku": "" }`;

const specSchema = z.object({
  description: z.string().trim().min(2).transform(s => s.slice(0, 40)),
  style: z.string().trim().min(10),
  roles: z.object(Object.fromEntries(ROLE_KEYS.map(k => [k, z.string().trim().min(10)])) as Record<MainRole | '海报', z.ZodString>),
  sku: z.string().trim().min(10),
});

/** The sample garment the three sample images are made on. */
const SAMPLE = {
  colors: [{ name: '落霞橙', hex: '#C88D2E' }],
  garment: ['无帽半高立领，前中单头全开同色拉链', '前胸左右对称折角分割线', '左右前腰各一个同色隐形拉链口袋，开口接近竖向', '长袖，袖口后侧半松紧', '下摆平直折边，衣长至胯部，男女同款直身版型', '细密平滑的哑光面料，衣身纯色无图案'],
  slots: [
    { kind: 'square', n: 1, total: 5, role: '首图', title: '轻盈抗造工作服', subtitle: '泼水轻擦 团体定制', bullets: ['三防面料'], scene: '模特正面站立，袖子上有水珠滑落', colors: ['落霞橙'] },
    { kind: 'square', n: 3, total: 5, role: '细节', title: '细节经得起看', subtitle: '领口拉链袖口逐一放大', bullets: ['利落立领', '顺滑拉链', '贴腕袖口'], scene: '领口、拉链、袖口的局部特写', colors: ['落霞橙'] },
  ] as MainSlot[],
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
    try { spec = specSchema.parse(JSON.parse(call.content)); } catch { throw new Error('AI 总结的版式不完整，请换几张参考图再学'); }
    const name = (await db().query('SELECT name FROM listing_layouts WHERE id=$1', [row.id])).rows[0].name as string;
    const layout: ListingLayout = { id: row.id, name, description: spec.description, samples: [], style: spec.style, roles: spec.roles, sku: spec.sku };
    const product = await sampleProduct();
    const prompts = [
      ...SAMPLE.slots.map(slot => ({ prompt: mainPrompt({ layout, slot, used: SAMPLE.colors, all: SAMPLE.colors, fromSku: false, garment: SAMPLE.garment }), ratio: slot.kind })),
      { prompt: skuPrompt({ layout, color: SAMPLE.colors[0].name, tag: '男女同款', fabric: '三防面料', garment: SAMPLE.garment }), ratio: 'square' as const },
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
