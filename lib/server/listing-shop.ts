/**
 * 电商主图 shop services (店铺设置): what the shop offers, its crafts and sample LOGO, and its four
 * service images. They live on the tenant's hidden product row of kind 'shop' (035), so the images
 * go through the same jobs, credits and versions as a product's: slot service:<id>. Confirming
 * makes the images never made and redraws only the changed words of the rest; every product then
 * copies its master's image as its second image at no cost (listing-generation, kind 'copy').
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import sharp from 'sharp';
import {
  blockedOf, CRAFTS, defaultShop, pendingOf, SERVICE_IMAGES, SERVICE_LIMITS, wordsFor,
  type MadeService, type ServiceImageId, type ShopService,
} from '../listing/service';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';
import { readCatalogFile } from './catalog-files';
import { currentPrices, type PriceSnapshot } from './credits';
import { holdRun, insertJobs, slotStates, type JobInput } from './listing-generation';
import { addReference, assetUrl, latestOutputs } from './listing-store';
import type { Tenant } from './tenant-scope';

const db = () => catalogDatabase();
/** What is stored on the shop's row; the LOGO is the asset id of an uploaded reference image. */
type Settings = Omit<ShopService, 'made' | 'logo'> & { logo: string | null };
export const serviceSlot = (id: ServiceImageId) => `service:${id}`;

/** The tenant's shop row, made the first time (services the AI read in uploaded products come ticked). */
async function shopRow(c: CatalogQueryClient, tenant: string, user: string) {
  const found = (await c.query(`SELECT id,shop FROM listing_projects WHERE tenant_id=$1 AND kind='shop'`, [tenant])).rows[0];
  if (found) return found as { id: string; shop: Settings };
  const read = (await c.query(`SELECT DISTINCT p->>'text' AS text FROM listing_projects, jsonb_array_elements(materials->'sorted'->'points') p
    WHERE tenant_id=$1 AND kind='product' AND p->>'type'='服务定制' LIMIT 40`, [tenant])).rows.map(r => String(r.text));
  const start = defaultShop(defaultShop().items.filter(x => read.some(text => text.includes(x.title))).map(x => x.title));
  const shop: Settings = { items: start.items, crafts: start.crafts, logo: null };
  const id = randomUUID();
  await c.query(`INSERT INTO listing_projects(id,tenant_id,created_by,name,layout,counts,status,kind,plan,shop)
    VALUES($1,$2,$3,'店铺服务图','M1','{"square":1,"portrait":0,"long":0}','done','shop','{"round":2}',$4) ON CONFLICT DO NOTHING`, [id, tenant, user, shop]);
  return (await c.query(`SELECT id,shop FROM listing_projects WHERE tenant_id=$1 AND kind='shop'`, [tenant])).rows[0] as { id: string; shop: Settings };
}

/** The shop as the page shows it: its settings, the made images with their versions, and what is being made. */
export async function shopState(tenant: string, user: string) {
  const row = await catalogTransaction(c => shopRow(c, tenant, user));
  const states = await slotStates(row.id);
  const made: ShopService['made'] = {}, making: ServiceImageId[] = [], failed: Partial<Record<ServiceImageId, string>> = {};
  const times = new Map(((await db().query(`SELECT id,created_at FROM listing_assets WHERE project_id=$1 AND slot IS NOT NULL`, [row.id])).rows as { id: string; created_at: Date }[]).map(r => [r.id, r.created_at.toISOString()]));
  for (const def of SERVICE_IMAGES) {
    const s = states.find(x => x.slot === serviceSlot(def.id));
    if (!s) continue;
    if (s.status === 'queued' || s.status === 'running') making.push(def.id);
    else if (s.status !== 'succeeded' && s.error) failed[def.id] = s.error;
    if (!s.image) continue;
    const kept = s.history.filter(v => v.id !== s.image && !v.job);
    made[def.id] = {
      image: assetUrl(s.image), asset: s.image, words: s.words?.tags ?? [], madeAt: times.get(s.image) ?? '',
      history: kept.reverse().map(v => ({ image: assetUrl(v.id), asset: v.id, madeAt: times.get(v.id) ?? '' })),
    } satisfies MadeService;
  }
  const shop: ShopService = { ...row.shop, logo: row.shop.logo ? assetUrl(row.shop.logo) : null, made };
  return { project: row.id, shop, making, failed };
}

const settingsSchema = z.object({
  items: z.array(z.object({ id: z.string().min(1).max(40), title: z.string().trim().max(SERVICE_LIMITS.title), note: z.string().trim().max(SERVICE_LIMITS.note), on: z.boolean(), ai: z.boolean().optional() })).max(30),
  crafts: z.array(z.enum(CRAFTS)).max(CRAFTS.length),
});
/** The services and crafts as the user left them; the images are only redrawn on 「确认修改」. */
export async function saveShop(tenant: string, user: string, input: unknown) {
  const b = settingsSchema.parse(input);
  await catalogTransaction(async c => {
    const row = await shopRow(c, tenant, user);
    await c.query('UPDATE listing_projects SET shop=$2,updated_at=now() WHERE id=$1', [row.id, { ...row.shop, items: b.items, crafts: [...new Set(b.crafts)] }]);
  });
  return shopState(tenant, user);
}

/** The sample LOGO shown on the crafts image. */
export async function saveShopLogo(tenant: string, user: string, bytes: Buffer, name: string) {
  const row = await catalogTransaction(c => shopRow(c, tenant, user));
  const { asset } = await addReference(tenant, row.id, bytes, name);
  await db().query('UPDATE listing_projects SET shop=$2,updated_at=now() WHERE id=$1', [row.id, { ...row.shop, logo: asset }]);
  return shopState(tenant, user);
}

/** 「确认」: hold the credits and make the service images never made; redraw only the changed words of the others. */
export async function makeServices(tenant: Tenant, user: string) {
  const prices: PriceSnapshot = await currentPrices();
  const state = await shopState(tenant.id, user);
  const blocked = blockedOf(state.shop);
  if (blocked) throw new CatalogHttpError(400, blocked);
  if (state.making.length) throw new CatalogHttpError(409, '服务图正在出，等出完再确认');
  const pending = pendingOf(state.shop);
  if (!pending.images) return { images: 0 };
  const words = (id: ServiceImageId) => ({ title: '', sub: '', tags: wordsFor(SERVICE_IMAGES.find(s => s.id === id)!, state.shop), cells: [] });
  const jobs = [
    ...pending.fresh.map(def => ({ id: def.id, input: { kind: 'service', image: def.id, words: words(def.id) } as JobInput })),
    ...pending.stale.map(({ def }) => ({ id: def.id, input: { kind: 'service', image: def.id, words: words(def.id), stale: { base: state.shop.made[def.id]!.asset!, from: state.shop.made[def.id]!.words } } as JobInput })),
  ].map(j => ({ slot: serviceSlot(j.id), step: 'image' as const, input: j.input, depends: [], multi: false }));
  return catalogTransaction(async c => {
    if ((await c.query(`SELECT 1 FROM listing_jobs WHERE project_id=$1 AND status IN ('queued','running') LIMIT 1`, [state.project])).rowCount) throw new CatalogHttpError(409, '服务图正在出，等出完再确认');
    const runId = await holdRun(c, tenant, state.project, jobs, prices);
    await insertJobs(c, tenant.id, user, state.project, runId, jobs);
    return { images: jobs.length };
  });
}

/** The tenant's current service image for a master, for a product's second image; null when the shop has not made it. */
export async function shopServiceImage(tenant: string, id: ServiceImageId) {
  const row = (await db().query(`SELECT id FROM listing_projects WHERE tenant_id=$1 AND kind='shop'`, [tenant])).rows[0];
  const out = row && (await latestOutputs(row.id)).get(serviceSlot(id));
  return out ? (await readCatalogFile(out.file_id)).bytes : null;
}

/** The shop's settings and LOGO bytes, for writing its service images and a product's badge. */
export async function shopSettings(tenant: string): Promise<{ settings: Settings | null; logo: Buffer | null }> {
  const row = (await db().query(`SELECT shop FROM listing_projects WHERE tenant_id=$1 AND kind='shop'`, [tenant])).rows[0];
  const settings = (row?.shop ?? null) as Settings | null;
  if (!settings?.logo) return { settings, logo: null };
  const file = (await db().query('SELECT file_id FROM listing_assets WHERE id=$1 AND tenant_id=$2', [settings.logo, tenant])).rows[0];
  const logo = file ? await sharp((await readCatalogFile(file.file_id)).bytes).png().toBuffer() : null;
  return { settings, logo };
}
