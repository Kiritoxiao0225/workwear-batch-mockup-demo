/**
 * 电商主图 shop services (店铺设置): what the shop offers, its crafts and sample LOGO, its own LOGO for
 * the corner of its main images (lib/listing/corner.ts, 10-18), and its four
 * service images. They live on the tenant's hidden product row of kind 'shop' (035), so the images
 * go through the same jobs, credits and versions as a product's: slot service:<id>. Since 10-22 an
 * account keeps several shops (SHOP_MAIN, the one it always had, and `sets` on the same row, their
 * images in slots service:<set>~<id>); one is the default, and each product says which it uses. Confirming
 * makes the images never made and redraws only the changed words of the rest; every product then
 * copies its master's image as its second image at no cost (listing-generation, kind 'copy').
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import {
  blockedOf, CRAFTS, defaultShop, pendingOf, SERVICE_IMAGES, SERVICE_LIMITS, serviceSlot, SHOP_MAIN, wordsFor,
  type MadeService, type ServiceImageId, type ShopService, type ShopSet,
} from '../listing/service';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { brandImage } from './listing-corner';
import { readCatalogFile } from './catalog-files';
import { currentPrices, type PriceSnapshot } from './credits';
import { holdRun, insertJobs, slotStates, type JobInput } from './listing-generation';
import { addReference, assetUrl, latestOutputs, slotShop, type StoredPlan } from './listing-store';
import type { Tenant } from './tenant-scope';

const db = () => catalogDatabase();
/** What is stored on the shop's row; the LOGOs are asset ids of uploaded reference images (rows before 10-18 have no brand). */
/** `logoGone`: when the sample LOGO was deleted, so a crafts image drawn before still with it is drawn again. */
type Settings = Omit<ShopService, 'made' | 'logo' | 'brand' | 'corner'> & { logo: string | null; brand?: string | null; corner?: boolean; logoGone?: string };
/** The row's jsonb: the first shop's settings at the top (as before 10-22), the others in `sets`, and which is the default. */
type Row = Settings & { name?: string; sets?: { id: string; name: string; settings: Settings }[]; defaultSet?: string };
export { serviceSlot };
/** One shop's settings on the row, by its id (SHOP_MAIN or none: the first one). */
const settingsOf = (row: Row, set?: string | null): Settings | null => !set || set === SHOP_MAIN ? row : row.sets?.find(x => x.id === set)?.settings ?? null;
/** A shop that still exists, else the default one (a product's shop may have been deleted since). */
const shopOf = (row: Row, set?: string | null) => set && settingsOf(row, set) ? set : row.defaultSet && settingsOf(row, row.defaultSet) ? row.defaultSet : SHOP_MAIN;
/** The shops of the account, the default first-marked. */
const setsOf = (row: Row): ShopSet[] => [{ id: SHOP_MAIN, name: row.name || '我的店铺' }, ...(row.sets ?? []).map(x => ({ id: x.id, name: x.name }))]
  .map(x => ({ ...x, isDefault: x.id === shopOf(row, row.defaultSet) }));
/** Writes one shop's settings: the first at the top of the row, another inside `sets`. */
async function patchSet(c: CatalogQueryClient, row: { id: string; shop: Row }, set: string, patch: Partial<Settings>) {
  if (set === SHOP_MAIN) { await c.query('UPDATE listing_projects SET shop=shop||$2::jsonb,updated_at=now() WHERE id=$1', [row.id, patch]); return; }
  const sets = (row.shop.sets ?? []).map(x => x.id === set ? { ...x, settings: { ...x.settings, ...patch } } : x);
  if (!sets.some(x => x.id === set)) throw new CatalogHttpError(404, '这套店铺不存在');
  await c.query(`UPDATE listing_projects SET shop=shop||$2::jsonb,updated_at=now() WHERE id=$1`, [row.id, { sets }]);
}

/** The tenant's shop row, made the first time (services the AI read in uploaded products come ticked). */
async function shopRow(c: CatalogQueryClient, tenant: string, user: string) {
  const found = (await c.query(`SELECT id,shop FROM listing_projects WHERE tenant_id=$1 AND kind='shop'`, [tenant])).rows[0];
  if (found) return found as { id: string; shop: Row };
  const read = (await c.query(`SELECT DISTINCT p->>'text' AS text FROM listing_projects, jsonb_array_elements(materials->'sorted'->'points') p
    WHERE tenant_id=$1 AND kind='product' AND p->>'type'='服务定制' LIMIT 40`, [tenant])).rows.map(r => String(r.text));
  const start = defaultShop(defaultShop().items.filter(x => read.some(text => text.includes(x.title))).map(x => x.title));
  const shop: Settings = { items: start.items, crafts: start.crafts, logo: null, brand: null, corner: false };
  const id = randomUUID();
  await c.query(`INSERT INTO listing_projects(id,tenant_id,created_by,name,layout,counts,status,kind,plan,shop)
    VALUES($1,$2,$3,'店铺服务图','M1','{"square":1,"portrait":0,"long":0}','done','shop','{"round":2}',$4) ON CONFLICT DO NOTHING`, [id, tenant, user, shop]);
  return (await c.query(`SELECT id,shop FROM listing_projects WHERE tenant_id=$1 AND kind='shop'`, [tenant])).rows[0] as { id: string; shop: Row };
}

/** One shop as the page shows it: its settings, the made images with their versions, what is being made, and the account's shops. */
export async function shopState(tenant: string, user: string, wanted?: string | null) {
  const row = await catalogTransaction(c => shopRow(c, tenant, user));
  const set = shopOf(row.shop, wanted), own = settingsOf(row.shop, set)!;
  const states = await slotStates(row.id);
  const made: ShopService['made'] = {}, making: ServiceImageId[] = [], failed: Partial<Record<ServiceImageId, string>> = {};
  const times = new Map(((await db().query(`SELECT id,created_at FROM listing_assets WHERE project_id=$1 AND slot IS NOT NULL`, [row.id])).rows as { id: string; created_at: Date }[]).map(r => [r.id, r.created_at.toISOString()]));
  // When the sample LOGO was set or deleted: a crafts image drawn before shows the old one (10-21).
  const logoAt = own.logo ? ((await db().query('SELECT created_at FROM listing_assets WHERE id=$1', [own.logo])).rows[0]?.created_at as Date | undefined)?.toISOString() : own.logoGone;
  for (const def of SERVICE_IMAGES) {
    const s = states.find(x => x.slot === serviceSlot(def.id, set));
    if (!s) continue;
    if (s.status === 'queued' || s.status === 'running') making.push(def.id);
    else if (s.status !== 'succeeded' && s.error) failed[def.id] = s.error;
    if (!s.image) continue;
    const kept = s.history.filter(v => v.id !== s.image && !v.job);
    made[def.id] = {
      image: assetUrl(s.image), asset: s.image, words: s.words?.tags ?? [], madeAt: times.get(s.image) ?? '',
      ...(def.kind === 'crafts' && logoAt && (times.get(s.image) ?? '') < logoAt ? { oldLogo: true } : {}),
      history: kept.reverse().map(v => ({ image: assetUrl(v.id), asset: v.id, madeAt: times.get(v.id) ?? '' })),
    } satisfies MadeService;
  }
  const shop: ShopService = { items: own.items, crafts: own.crafts, logo: own.logo ? assetUrl(own.logo) : null,
    brand: own.brand ? assetUrl(own.brand) : null, corner: !!own.corner && !!own.brand, made };
  return { project: row.id, set, sets: setsOf(row.shop), shop, making, failed };
}

/** A new shop (10-22): the default one's services and crafts to start from; no LOGOs and no images yet. */
export async function createShopSet(tenant: string, user: string, input: unknown) {
  const { name } = z.object({ name: z.string().trim().min(1, '给这套店铺起个名字').max(16, '店铺名最多 16 个字') }).parse(input);
  const id = await catalogTransaction(async c => {
    const row = await shopRow(c, tenant, user);
    if (setsOf(row.shop).some(x => x.name === name)) throw new CatalogHttpError(409, '已经有同名的店铺');
    if ((row.shop.sets ?? []).length >= 9) throw new CatalogHttpError(409, '最多 10 套店铺');
    const from = settingsOf(row.shop, shopOf(row.shop))!, id = `s${randomUUID().slice(0, 8)}`;
    const sets = [...(row.shop.sets ?? []), { id, name, settings: { items: from.items, crafts: from.crafts, logo: null, brand: null, corner: false } }];
    await c.query(`UPDATE listing_projects SET shop=shop||$2::jsonb,updated_at=now() WHERE id=$1`, [row.id, { sets }]);
    return id;
  });
  return shopState(tenant, user, id);
}
/** Renames a shop, or makes it the default (what new products use). */
export async function updateShopSet(tenant: string, user: string, set: string, input: unknown) {
  const b = z.object({ name: z.string().trim().min(1).max(16).optional(), isDefault: z.literal(true).optional() }).parse(input);
  await catalogTransaction(async c => {
    const row = await shopRow(c, tenant, user);
    if (!settingsOf(row.shop, set)) throw new CatalogHttpError(404, '这套店铺不存在');
    if (b.name && setsOf(row.shop).some(x => x.name === b.name && x.id !== set)) throw new CatalogHttpError(409, '已经有同名的店铺');
    if (b.name) {
      if (set === SHOP_MAIN) await c.query(`UPDATE listing_projects SET shop=shop||jsonb_build_object('name',$2::text),updated_at=now() WHERE id=$1`, [row.id, b.name]);
      else await c.query(`UPDATE listing_projects SET shop=shop||$2::jsonb,updated_at=now() WHERE id=$1`, [row.id, { sets: (row.shop.sets ?? []).map(x => x.id === set ? { ...x, name: b.name! } : x) }]);
    }
    if (b.isDefault) await c.query(`UPDATE listing_projects SET shop=shop||jsonb_build_object('defaultSet',$2::text),updated_at=now() WHERE id=$1`, [row.id, set]);
  });
  return shopState(tenant, user, set);
}
/** Deletes a shop that is not the default; products that used it use the default from then on. Its images stay in history. */
export async function deleteShopSet(tenant: string, user: string, set: string) {
  await catalogTransaction(async c => {
    const row = await shopRow(c, tenant, user);
    if (set === SHOP_MAIN) throw new CatalogHttpError(409, '第一套店铺不能删，可以改名');
    if (shopOf(row.shop) === set) throw new CatalogHttpError(409, '默认店铺不能删：先把别的店铺设为默认');
    if (!row.shop.sets?.some(x => x.id === set)) throw new CatalogHttpError(404, '这套店铺不存在');
    await c.query(`UPDATE listing_projects SET shop=shop||$2::jsonb,updated_at=now() WHERE id=$1`, [row.id, { sets: row.shop.sets.filter(x => x.id !== set) }]);
  });
  return shopState(tenant, user);
}

const settingsSchema = z.object({
  items: z.array(z.object({ id: z.string().min(1).max(40), title: z.string().trim().max(SERVICE_LIMITS.title), note: z.string().trim().max(SERVICE_LIMITS.note), on: z.boolean(), ai: z.boolean().optional() })).max(30),
  crafts: z.array(z.enum(CRAFTS)).max(CRAFTS.length),
});
/** The services and crafts as the user left them; the images are only redrawn on 「确认修改」. */
export async function saveShop(tenant: string, user: string, input: unknown, set?: string | null) {
  const b = settingsSchema.parse(input);
  const s = await catalogTransaction(async c => {
    const row = await shopRow(c, tenant, user), s = shopOf(row.shop, set);
    // Merged, so the LOGOs and the corner switch, saved on their own, are kept.
    await patchSet(c, row, s, { items: b.items, crafts: [...new Set(b.crafts)] });
    return s;
  });
  return shopState(tenant, user, s);
}

/** The sample LOGO shown on the crafts image. */
export async function saveShopLogo(tenant: string, user: string, bytes: Buffer, name: string, set?: string | null) {
  const row = await catalogTransaction(c => shopRow(c, tenant, user)), s = shopOf(row.shop, set);
  const { asset } = await addReference(tenant, row.id, bytes, name);
  await catalogTransaction(async c => patchSet(c, await shopRow(c, tenant, user), s, { logo: asset }));
  return shopState(tenant, user, s);
}

/**
 * Takes a LOGO off the shop: the sample one (the chest then prints 「LOGO」, the crafts image is drawn
 * again with an abstract pattern), or its own (the corner switch goes off with it).
 */
export async function removeShopLogo(tenant: string, user: string, which: 'logo' | 'brand', set?: string | null) {
  const s = await catalogTransaction(async c => {
    const row = await shopRow(c, tenant, user), s = shopOf(row.shop, set), own = settingsOf(row.shop, s)!;
    await patchSet(c, row, s, which === 'logo' ? (own.logo ? { logo: null, logoGone: new Date().toISOString() } : {}) : { brand: null, corner: false });
    return s;
  });
  return shopState(tenant, user, s);
}

/** The shop's own LOGO, for the corner of its main images and its SKU images. */
export async function saveShopBrand(tenant: string, user: string, bytes: Buffer, name: string, set?: string | null) {
  const logo = await brandImage(bytes);
  const row = await catalogTransaction(c => shopRow(c, tenant, user)), s = shopOf(row.shop, set);
  const { asset } = await addReference(tenant, row.id, logo, name);
  await catalogTransaction(async c => patchSet(c, await shopRow(c, tenant, user), s, { brand: asset }));
  return shopState(tenant, user, s);
}

/** 主图左上角放不放店铺 LOGO: from now on for images being made, at once for the ones that kept the corner. */
export async function saveShopCorner(tenant: string, user: string, input: unknown, set?: string | null) {
  const { on } = z.object({ on: z.boolean() }).parse(input);
  const s = await catalogTransaction(async c => {
    const row = await shopRow(c, tenant, user), s = shopOf(row.shop, set);
    if (on && !settingsOf(row.shop, s)!.brand) throw new CatalogHttpError(400, '先上传店铺 LOGO');
    await patchSet(c, row, s, { corner: on });
    return s;
  });
  return shopState(tenant, user, s);
}

/**
 * The shop's own LOGO while the switch is on: its asset id (images are shown with this one) and its
 * bytes when they are needed. Null when the shop shows none.
 */
export async function shopBrand(tenant: string, set?: string | null) {
  const row = (await db().query(`SELECT shop FROM listing_projects WHERE tenant_id=$1 AND kind='shop'`, [tenant])).rows[0]?.shop as Row | undefined;
  const shop = row ? settingsOf(row, shopOf(row, set)) : null;
  const id = shop?.corner && shop.brand ? shop.brand : null;
  if (!id) return null;
  return {
    id,
    bytes: async () => {
      const file = (await db().query('SELECT file_id FROM listing_assets WHERE id=$1 AND tenant_id=$2', [id, tenant])).rows[0];
      if (!file) throw new CatalogHttpError(404, '店铺 LOGO 找不到了，去店铺设置重新上传');
      return (await readCatalogFile(file.file_id)).bytes;
    },
  };
}

/** 「确认」: hold the credits and make the service images never made; redraw only the changed words of the others. */
export async function makeServices(tenant: Tenant, user: string, set?: string | null) {
  const prices: PriceSnapshot = await currentPrices();
  const state = await shopState(tenant.id, user, set);
  const blocked = blockedOf(state.shop);
  if (blocked) throw new CatalogHttpError(400, blocked);
  if (state.making.length) throw new CatalogHttpError(409, '服务图正在出，等出完再确认');
  const pending = pendingOf(state.shop);
  if (!pending.images) return { images: 0 };
  const words = (id: ServiceImageId) => ({ title: '', sub: '', tags: wordsFor(SERVICE_IMAGES.find(s => s.id === id)!, state.shop), cells: [] });
  const jobs = [
    ...pending.fresh.map(def => ({ id: def.id, input: { kind: 'service', image: def.id, words: words(def.id) } as JobInput })),
    ...pending.stale.map(({ def }) => ({ id: def.id, input: { kind: 'service', image: def.id, words: words(def.id), stale: { base: state.shop.made[def.id]!.asset!, from: state.shop.made[def.id]!.words } } as JobInput })),
  ].map(j => ({ slot: serviceSlot(j.id, state.set), step: 'image' as const, input: j.input, depends: [], multi: false }));
  return catalogTransaction(async c => {
    // Only this shop's images: another shop's being made does not hold this one up.
    const slots = SERVICE_IMAGES.map(def => serviceSlot(def.id, state.set));
    if ((await c.query(`SELECT 1 FROM listing_jobs WHERE project_id=$1 AND slot=ANY($2) AND status IN ('queued','running') LIMIT 1`, [state.project, slots])).rowCount) throw new CatalogHttpError(409, '服务图正在出，等出完再确认');
    const runId = await holdRun(c, tenant, state.project, jobs, prices);
    await insertJobs(c, tenant.id, user, state.project, runId, jobs);
    return { images: jobs.length };
  });
}

/** A shop's current service image for a master, for a product's second image; null when the shop has not made it. */
export async function shopServiceImage(tenant: string, id: ServiceImageId, set?: string | null) {
  const row = (await db().query(`SELECT id,shop FROM listing_projects WHERE tenant_id=$1 AND kind='shop'`, [tenant])).rows[0];
  const out = row && (await latestOutputs(row.id)).get(serviceSlot(id, shopOf(row.shop as Row, set)));
  return out ? (await readCatalogFile(out.file_id)).bytes : null;
}

/** A shop's settings and sample LOGO bytes, for writing its service images and a product's chest and badge. */
export async function shopSettings(tenant: string, set?: string | null): Promise<{ settings: Settings | null; logo: Buffer | null }> {
  const row = (await db().query(`SELECT shop FROM listing_projects WHERE tenant_id=$1 AND kind='shop'`, [tenant])).rows[0];
  const settings = row?.shop ? settingsOf(row.shop as Row, shopOf(row.shop as Row, set)) : null;
  if (!settings?.logo) return { settings, logo: null };
  const file = (await db().query('SELECT file_id FROM listing_assets WHERE id=$1 AND tenant_id=$2', [settings.logo, tenant])).rows[0];
  const logo = file ? await sharp((await readCatalogFile(file.file_id)).bytes).png().toBuffer() : null;
  return { settings, logo };
}

/** The shop an image of a product is for (10-22), for its corner LOGO. */
export async function shopOfAsset(tenant: string, asset: string): Promise<string | null> {
  const r = (await db().query(`SELECT a.slot, p.plan FROM listing_assets a JOIN listing_projects p ON p.id=a.project_id WHERE a.id=$1 AND a.tenant_id=$2`, [asset, tenant])).rows[0];
  return r?.plan?.draft ? slotShop(r.plan as StoredPlan, String(r.slot ?? '')) ?? null : null;
}

/** A shop that still exists by its id, else the account's default now (SHOP_MAIN for an account that never had several). */
export async function liveShop(tenant: string, set?: string | null): Promise<string> {
  const row = (await db().query(`SELECT shop FROM listing_projects WHERE tenant_id=$1 AND kind='shop'`, [tenant])).rows[0]?.shop as Row | undefined;
  return row ? shopOf(row, set) : SHOP_MAIN;
}
