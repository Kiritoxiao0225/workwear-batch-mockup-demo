/**
 * 电商主图 shop services: what a shop offers (free design, free samples, invoices…) is written once
 * per account, and the service images are made from it. Each master (母版) has one service image in
 * its own tone; masters of the same tone share one, so a shop has four. They are made together when
 * the shop confirms its services, kept, and every product shows its master's one as the second image
 * at no cost. Each is learned from a top competitor's service image (logos and shop names wiped): the
 * model copies its layout, tone and finish and writes only the shop's own words.
 */

/** One service the shop offers: a short title and a line under it. */
export type ServiceItem = { id: string; title: string; note: string; on: boolean; ai?: boolean };
export const SERVICE_LIMITS = { title: 5, note: 8 } as const;

/** Services buyers of team workwear look for, in the order competitors show them most. */
export const SERVICE_LIBRARY: Omit<ServiceItem, 'on'>[] = [
  { id: 'design', title: '免费设计', note: '一对一设计师' },
  { id: 'print', title: '免费印绣', note: '多种工艺可选' },
  { id: 'sample', title: '免费看样', note: '满意再下单' },
  { id: 'min', title: '一件起订', note: '小单也能做' },
  { id: 'stock', title: '现货速发', note: '48小时发货' },
  { id: 'invoice', title: '可开发票', note: '普票专票都行' },
  { id: 'contract', title: '可签合同', note: '支持对公转账' },
  { id: 'check', title: '三重质检', note: '每件出厂必检' },
  { id: 'service', title: '一对一客服', note: '全程专人跟单' },
  { id: 'rush', title: '急单加急', note: '优先排产' },
  { id: 'after', title: '售后无忧', note: '质量问题包退换' },
  { id: 'bulk', title: '团购优惠', note: '量大价更优' },
];
export const CRAFTS = ['刺绣', '高清烫画', '丝印', '数码转印', '反光印'] as const;
export type Craft = (typeof CRAFTS)[number];
export const CRAFT_NOTE: Record<Craft, string> = { 刺绣: '立体感强 走线均匀', 高清烫画: '色彩丰富 图案精细', 丝印: '色牢度高 性价比高', 数码转印: '渐变细腻 还原度高', 反光印: '夜间反光 醒目安全' };

/** The masters (母版) the service images are made for, by id; their full definitions come with the masters. */
export const MASTER_NAMES = { M1: '车展工牌', M2: '暗黑科技', M3: '上岗实拍', M4: '双人棚拍', M5: '产品静物' } as const;
export type MasterId = keyof typeof MASTER_NAMES;

/**
 * The shop's service images. kind: what fills it — the shop's ticked services (in order) or its
 * crafts. sample: the competitor image it is learned from (service-samples/<sample>.png).
 */
export type ServiceImageId = 'A-light' | 'A-dark' | 'D-warm' | 'B-light';
/** The account's first shop (the one it always had): its images keep the slots service:<id>. */
export const SHOP_MAIN = 'main';
/** One of the account's shops (10-22): its name and whether new products use it. */
export type ShopSet = { id: string; name: string; isDefault: boolean };
/** A service image's slot on the shop row: the first shop's as before, another's with its id. */
export const serviceSlot = (id: ServiceImageId, set?: string | null) => !set || set === SHOP_MAIN ? `service:${id}` : `service:${set}~${id}`;
export type ServiceImageDef = { id: ServiceImageId; name: string; what: string; kind: 'items' | 'crafts'; slots: number; sample: string; masters: MasterId[] };
export const SERVICE_IMAGES: ServiceImageDef[] = [
  { id: 'A-light', name: '先看样再决定 · 浅色', what: '一句大口号，下面一个框放 4 项服务', kind: 'items', slots: 4, sample: '24-5', masters: ['M1', 'M5'] },
  { id: 'A-dark', name: '先看样再决定 · 深色', what: '一句大口号，下面 4 张权益卡', kind: 'items', slots: 4, sample: '27-5', masters: ['M2'] },
  { id: 'D-warm', name: '印绣工艺 · 浅暖色', what: '三种印绣工艺的布面特写，各一句说明', kind: 'crafts', slots: 3, sample: '13-4', masters: ['M3'] },
  { id: 'B-light', name: '服务保障 · 浅色', what: '一张工艺照片，下面 4 项服务', kind: 'items', slots: 4, sample: '28-5', masters: ['M4'] },
];
export const serviceImageOf = (master: MasterId) => SERVICE_IMAGES.find(s => s.masters.includes(master))!;

/**
 * One made service image: the picture (and its asset id on the server), the words drawn on it, and the
 * earlier versions. `oldLogo`: the crafts image was drawn before the sample LOGO now set, so it is drawn again.
 */
export type MadeService = { image: string; asset?: string; words: string[]; madeAt: string; oldLogo?: boolean; history: { image: string; asset?: string; madeAt: string }[] };
/**
 * `logo`: the sample LOGO printed on the crafts image. `brand`: the shop's own LOGO, put in the top-left
 * corner of its main images and on its SKU images while `corner` is on (corner.ts); never on a garment.
 */
export type ShopService = { items: ServiceItem[]; crafts: Craft[]; logo: string | null; brand: string | null; corner: boolean; made: Partial<Record<ServiceImageId, MadeService>> };

/** A new shop: what the AI read in the products already uploaded comes ticked; nothing made yet. */
export function defaultShop(fromMaterials: string[] = []): ShopService {
  return { items: SERVICE_LIBRARY.map(x => ({ ...x, on: fromMaterials.includes(x.title), ai: fromMaterials.includes(x.title) })), crafts: ['刺绣', '高清烫画', '数码转印'], logo: null, brand: null, corner: false, made: {} };
}

/** What an image writes, in its slots' order: the first ticked services, or the chosen crafts. */
export function wordsFor(def: ServiceImageDef, shop: ShopService): string[] {
  if (def.kind === 'crafts') return shop.crafts.slice(0, def.slots).map(c => `${c}｜${CRAFT_NOTE[c]}`);
  return shop.items.filter(x => x.on && x.title.trim()).slice(0, def.slots).map(x => `${x.title}｜${x.note}`);
}
/** Why the images cannot be made yet, or null. */
export function blockedOf(shop: ShopService): string | null {
  const n = shop.items.filter(x => x.on && x.title.trim()).length;
  if (n < 4) return `至少勾 4 条服务（现在 ${n} 条）`;
  if (shop.crafts.length < 3) return `印绣工艺要选 3 种（现在 ${shop.crafts.length} 种）`;
  return null;
}
/** The blocks of a made image whose words no longer match the shop's services. */
export function staleOf(id: ServiceImageId, shop: ShopService): number[] {
  const made = shop.made[id], def = SERVICE_IMAGES.find(s => s.id === id)!;
  if (!made) return [];
  const now = wordsFor(def, shop);
  return now.map((w, i) => w === made.words[i] ? -1 : i).filter(i => i >= 0);
}
/** What confirming does now: make the images never made (or drawn with an old sample LOGO), and redraw the changed words of the rest. */
export function pendingOf(shop: ShopService) {
  const fresh = SERVICE_IMAGES.filter(s => !shop.made[s.id] || shop.made[s.id]!.oldLogo);
  const stale = SERVICE_IMAGES.filter(s => !fresh.includes(s)).map(s => ({ def: s, blocks: staleOf(s.id, shop) })).filter(x => x.blocks.length);
  return { fresh, stale, images: fresh.length + stale.length };
}
