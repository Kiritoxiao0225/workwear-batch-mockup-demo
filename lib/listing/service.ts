/**
 * 电商主图 shop services: what a shop offers (free design, free samples, invoices…) is filled in
 * once per account and drawn on the service images. A service image is made from one of a few
 * service layouts, each learned from a top competitor's service image (logos and shop names wiped):
 * the model copies its layout, tone and finish and writes only the shop's own words. A shop keeps
 * one image per layout and tone and every product reuses it; only 服务-E shows the product itself
 * and is made per product.
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

export type Tone = 'dark' | 'light';
export const TONE_LABEL: Record<Tone, string> = { dark: '深色', light: '浅色' };
export type ServiceCode = 'A' | 'B' | 'C' | 'D' | 'E';
/** kind: what fills it — the shop's services, its crafts, or the two steps of ordering. */
export type ServiceLayout = { code: ServiceCode; name: string; what: string; kind: 'items' | 'crafts' | 'steps'; slots: number; perProduct?: boolean; samples: Record<Tone, string> };
export const SERVICE_LAYOUTS: ServiceLayout[] = [
  { code: 'A', name: '先看样再决定', what: '一句大口号，下面 4 张权益卡', kind: 'items', slots: 4, samples: { dark: '27-5', light: '24-5' } },
  { code: 'B', name: '服务保障', what: '工艺实拍做底，上面口号，下面 4 项保障', kind: 'items', slots: 4, samples: { dark: '31-5', light: '28-5' } },
  { code: 'C', name: '品牌定制服务', what: '托举的手或团队实景，下面一排服务卡', kind: 'items', slots: 6, samples: { dark: '163-5', light: '56-5' } },
  { code: 'D', name: '印绣工艺', what: '三种工艺的布面特写，各一句说明', kind: 'crafts', slots: 3, samples: { dark: '26-5', light: '13-4' } },
  { code: 'E', name: '定制两步 + 模特', what: '提供 LOGO、选颜色两步，模特穿这一款', kind: 'steps', slots: 2, perProduct: true, samples: { dark: '30-2', light: '10-2' } },
];
export const serviceLayout = (code: ServiceCode) => SERVICE_LAYOUTS.find(l => l.code === code)!;

/** A service image the shop picked and keeps: the words drawn on it, to tell when it is out of date. */
export type SavedService = { code: ServiceCode; tone: Tone; image: string; words: string[]; savedAt: string };
export type ShopService = { items: ServiceItem[]; crafts: Craft[]; logo: string | null; saved: SavedService[] };

/** A new shop: nothing ticked; what the AI read in the materials comes ticked and marked. */
export function defaultShop(fromMaterials: string[] = []): ShopService {
  return { items: SERVICE_LIBRARY.map(x => ({ ...x, on: fromMaterials.includes(x.title), ai: fromMaterials.includes(x.title) })), crafts: [], logo: null, saved: [] };
}

/** What a layout writes, in its slots' order: the first ticked services, the chosen crafts, or the two steps. */
export function wordsFor(layout: ServiceLayout, shop: ShopService): string[] {
  if (layout.kind === 'crafts') return shop.crafts.slice(0, layout.slots).map(c => `${c}｜${CRAFT_NOTE[c]}`);
  if (layout.kind === 'steps') return ['1.提供品牌LOGO', '2.选择产品颜色'];
  return shop.items.filter(x => x.on && x.title.trim()).slice(0, layout.slots).map(x => `${x.title}｜${x.note}`);
}
/** Why a layout cannot be made yet, or null. */
export function blockedOf(layout: ServiceLayout, shop: ShopService): string | null {
  const n = wordsFor(layout, shop).length;
  if (layout.kind === 'crafts') return n < layout.slots ? `要选 ${layout.slots} 种印绣工艺（现在 ${n} 种）` : null;
  if (layout.kind === 'items') return n < layout.slots ? `要勾 ${layout.slots} 条服务（现在 ${n} 条）` : null;
  return null;
}
/** The words on a kept image that no longer match the shop's services: those blocks are redrawn. */
export function staleOf(saved: SavedService, shop: ShopService): number[] {
  const now = wordsFor(serviceLayout(saved.code), shop);
  return saved.words.map((w, i) => w === now[i] ? -1 : i).filter(i => i >= 0);
}
