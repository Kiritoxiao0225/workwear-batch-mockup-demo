/**
 * 电商主图: what each main image says and which colour it shows, decided from the sorted material
 * by fixed rules. The page shows it as the plan the user edits; the server prices and queues the
 * very same images from it, so the price on the page is the price held.
 */
import { z } from 'zod';
import { countsSchema, MAIN_ROLES, type ListingCounts, type MainRole } from './layouts';

/** A selling point read from the material: `text` and `note` (its explanation) are copied, not rewritten. */
export type Point = { type: string; text: string; note: string; why: string; from: string[] };
/** One of the five main images: cover, three middle ones, closer. `manual`: the user chose its colours. */
export type Slot = { role: MainRole; title: string; sub: string; tags: string[]; colors: string[]; manual?: boolean; why?: string };
export type PlanColor = { name: string; hex: string; pick: string | null };
export type Draft = {
  colors: PlanColor[]; main: string; parts: { part: string; pick: string | null }[];
  slots: Slot[]; poster: { title: string; sub: string }; layout: string; counts: ListingCounts; extra: { color: string; layout: string }[];
};

const BUCKET: Record<string, 'A' | 'B' | 'C'> = { 功能: 'A', 面料: 'A', 做工: 'B', 实用: 'C' };
const CLOSER = ['人群场景', '服务定制', '颜色款式'];
/** A big title and two tags. */
const CAPACITY = 3;

/**
 * The points shared out by type: the cover takes the positioning point and the two strongest,
 * the closer the colours; the middle three images are filled in rank order, a point joining an
 * image of its own type (workmanship and practical points may share a close-up image). When every
 * image is taken, a point still goes onto any image with room, so a stronger point is never left
 * out while a weaker one is used.
 */
export function planSlots(points: Point[], colorNames: string[]): { slots: Slot[]; poster: Draft['poster'] } {
  const cover = points.find(p => p.type === '定位') ?? points[0];
  const body = points.filter(p => p !== cover && BUCKET[p.type]);
  const groups: { bucket: string; items: Point[] }[] = [];
  for (const p of body) {
    const b = BUCKET[p.type];
    let group = groups.find(g => g.bucket.includes(b) && g.items.length < CAPACITY);
    if (!group && groups.length < 3) groups.push(group = { bucket: b, items: [] });
    group ??= (b === 'A' ? undefined : groups.find(g => !g.bucket.includes('A') && g.items.length < CAPACITY)) ?? groups.find(g => g.items.length < CAPACITY);
    if (!group) continue;
    if (b !== 'A' && !group.bucket.includes(b)) group.bucket += b;
    group.items.push(p);
  }
  // An image is about its title point: features first, then close-ups, then practical points.
  const order = (g: { bucket: string }) => g.bucket.startsWith('A') ? 0 : g.bucket.includes('B') ? 1 : 2;
  groups.sort((a, b) => order(a) - order(b));
  const used = new Set<Point>([cover, ...groups.flatMap(g => g.items)].filter(Boolean));
  const closer = points.filter(p => CLOSER.includes(p.type) && !used.has(p));
  // Too few points for three middle images: whatever is left, one per image.
  const rest = points.filter(p => !used.has(p) && !closer.includes(p));
  const middle: Slot[] = [0, 1, 2].map(i => {
    const g = groups[i];
    if (g) return { role: g.bucket.startsWith('A') ? '功能' : g.bucket.includes('B') ? '细节' : '实用', title: g.items[0].text, sub: g.items[0].note, tags: g.items.slice(1).map(p => p.text), colors: [] };
    const p = rest.shift();
    return { role: '功能', title: p?.text ?? '', sub: p?.note ?? '', tags: [], colors: [] };
  });
  const coverTags = (body.length ? body : points.filter(p => p !== cover)).slice(0, 2).map(p => p.text);
  const many = colorNames.length > 1;
  const last: Slot = many
    ? { role: '收口', title: `${colorNames.length}色可选`, sub: '', tags: closer.slice(0, 2).map(p => p.text), colors: [] }
    : { role: '收口', title: closer[0]?.text ?? '', sub: closer[0]?.note ?? '', tags: closer.slice(1, 3).map(p => p.text), colors: [] };
  return {
    slots: [{ role: '首图', title: cover?.text ?? '', sub: cover?.note ?? '', tags: coverTags, colors: [] }, ...middle, last],
    poster: { title: cover?.text ?? '', sub: [...coverTags.join(' · ')].length <= LIMITS.sub ? coverTags.join(' · ') : coverTags[0] ?? '' },
  };
}

/** After colours were added or dropped, the closer still says how many there are (the image shows each colour as a swatch). */
export function syncCloser(slot: Slot, colorNames: string[]): Slot {
  return /^\d+色可选$/.test(slot.title) && colorNames.length > 1 ? { ...slot, title: `${colorNames.length}色可选` } : slot;
}

const rgb = (hex: string) => { const n = /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : 0x8a8a8a; return [n >> 16, (n >> 8) & 255, n & 255]; };
/** Relative luminance, 0 (black) to 1 (white). */
export const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const near = (a: string, b: string) => { const x = rgb(a), y = rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 90; };

/**
 * Which colour each image shows. Cover and poster: the main colour. Images 2–4: one colour each,
 * not repeated and not the cover's where possible; the close-up first (light or mid colours show
 * structure, never black or dark), then the feature images (mid colours, away from the cover's);
 * colours are reused only when there are too few. Closer: the main colour plus a dark, a light and
 * a mid one. A slot whose colours the user chose keeps them.
 */
export function assignColors(slots: Slot[], colors: { name: string; hex: string }[], main: string): Slot[] {
  const names = colors.map(c => c.name), hex = new Map(colors.map(c => [c.name, c.hex]));
  const others = names.filter(c => c !== main), L = (c: string) => luminance(hex.get(c) ?? '');
  const out = slots.map(s => ({ ...s, colors: s.colors.filter(c => names.includes(c)) }));
  out.forEach(s => { if (s.manual && !s.colors.length) s.manual = false; });
  const uses = new Map(names.map(c => [c, 0]));
  const take = (c: string) => uses.set(c, (uses.get(c) ?? 0) + 1);
  out[0] = { ...out[0], colors: [main], manual: false, why: '首图用主推色' }; take(main);
  out.forEach((s, i) => { if (i > 0 && s.manual) s.colors.forEach(take); });
  const nearMain = (c: string) => near(hex.get(c) ?? '', hex.get(main) ?? '');
  const score = (role: MainRole, c: string) => {
    const l = L(c);
    const v = role === '细节' ? (l < 0.12 ? -1 : 1 - Math.abs(l - 0.5) - (l > 0.8 ? 0.3 : 0))
      : role === '功能' ? 1 - Math.abs(l - 0.3) * 1.5 - (l < 0.02 ? 0.4 : 0) : 0.5;
    return v - (nearMain(c) ? 0.8 : 0);
  };
  const reason = (role: MainRole, c: string, reused: boolean) => {
    if (!others.length) return '只有一个颜色';
    if (reused) return '颜色不够，循环使用';
    if (role === '细节') return '细节图用浅色、中间色，结构看得清';
    if (role === '功能') return L(c) < 0.12 ? '深色，跟首图拉开对比' : L(c) > 0.7 ? '浅色，跟首图拉开对比' : '中间色，演示效果看得清';
    return '跟前面几张不重复';
  };
  const rank = (role: MainRole) => role === '细节' ? 0 : role === '功能' ? 1 : 2;
  for (const i of [1, 2, 3].filter(i => out[i] && !out[i].manual).sort((a, b) => rank(out[a].role) - rank(out[b].role))) {
    const fresh = others.filter(c => !uses.get(c));
    const pool = fresh.length ? fresh : others.length ? [...others].sort((a, b) => uses.get(a)! - uses.get(b)!) : [main];
    const pick = [...pool].sort((a, b) => score(out[i].role, b) - score(out[i].role, a))[0];
    out[i] = { ...out[i], colors: [pick], why: reason(out[i].role, pick, !fresh.length && others.length > 0) }; take(pick);
  }
  if (out[4] && !out[4].manual) {
    const byL = [...others].sort((a, b) => L(a) - L(b)), picked: string[] = [];
    if (byL.length) picked.push(byL[0]);
    if (byL.length > 1) picked.push(byL[byL.length - 1]);
    const mid = byL.filter(c => !picked.includes(c)).sort((a, b) => Number(nearMain(a)) - Number(nearMain(b)) || Math.abs(L(a) - 0.3) - Math.abs(L(b) - 0.3))[0];
    if (mid) picked.push(mid);
    out[4] = { ...out[4], colors: [main, ...picked].slice(0, 4), why: others.length ? '主推色加深、浅、中间色各一个' : '只有一个颜色' };
  }
  out.forEach((s, i) => { if (i > 0 && s.manual) s.why = '你选的'; });
  return out;
}

/** Words longer than the image can hold (and than the server accepts), in plain words. */
export function overLimit(words: { title: string; sub: string; tags?: string[] }) {
  const long = [[...words.title.trim()].length > LIMITS.title && `大标题超过 ${LIMITS.title} 个字`, [...words.sub.trim()].length > LIMITS.sub && `小字超过 ${LIMITS.sub} 个字`,
    (words.tags ?? []).some(t => [...t.trim()].length > LIMITS.tag) && `标签超过 ${LIMITS.tag} 个字`].filter(Boolean);
  return long.length ? `${long.join('、')}，请删短一点` : '';
}

/** What is missing from an image's words, in plain words; empty when it has enough. */
export function thinOf(slot: Slot, index: number) {
  const missing: string[] = [];
  const n = [...slot.title.trim()].length;
  if (!n) return '没有大标题：从「讲什么」里选一条卖点';
  const long = overLimit(slot);
  if (long) return long;
  if (n < 4) missing.push(`大标题只有 ${n} 个字`);
  if (index > 0 && !slot.sub.trim() && !/^\d+色可选$/.test(slot.title)) missing.push('没有小字');
  if (!slot.tags.length && !/^\d+色可选$/.test(slot.title)) missing.push('没有标签');
  return missing.length ? `${missing.join('、')}，图会显得空：换一条卖点，或者补上` : '';
}

/** Which of the five slots n images use: the cover and the closer always, the middle ones in order. */
export const slotsFor = (n: number) => n <= 0 ? [] : n === 1 ? [0] : [0, ...[1, 2, 3].slice(0, n - 2), 4];

/** A clean front still life or render of the garment, without a logo, is the product image as it is. */
export const usableAsIs = (image: { kind: string; front: boolean; logo: boolean } | undefined) => !!image && (image.kind === '静物' || image.kind === '3D渲染') && image.front && !image.logo;

export const RATIOS = ['square', 'portrait', 'poster'] as const;
export type Ratio = (typeof RATIOS)[number];
const RATIO_LABEL: Record<Ratio, string> = { square: '1:1 主图', portrait: '3:4 主图', poster: '2:3 海报' };
/** One image to make: a slot key the server stores it under, and how it is priced. */
export type ImageItem = { slot: string; kind: 'product' | 'sku' | 'main'; label: string; sku: string; ratio?: Ratio; index?: number; colors?: string[]; layout?: string; multi: boolean; free: boolean };
type Spec = { colors: { name: string; pick: string }[]; main: string; words: Record<Ratio, { colors: string[] }[]>; extra: { color: string; layout: string }[] };

/** The images of one set, main colour first. Extra sets remake only the cover images, in their colour (`square:1+M23`). */
export function imagesOf(spec: Spec, direct: Set<string>): ImageItem[] {
  const colors = [...spec.colors].sort((a, b) => Number(b.name === spec.main) - Number(a.name === spec.main));
  const skuOf = new Map(colors.map(c => [c.name, c.pick]));
  const items: ImageItem[] = [];
  for (const c of colors) items.push({ slot: `product:${c.pick}`, kind: 'product', label: '白底产品图', sku: c.pick, multi: false, free: direct.has(c.pick) });
  for (const c of colors) items.push({ slot: `sku:${c.pick}`, kind: 'sku', label: 'SKU 图', sku: c.pick, multi: false, free: false });
  for (const ratio of RATIOS) spec.words[ratio].forEach((w, index) => {
    const used = w.colors.filter(n => skuOf.has(n)).slice(0, 4), names = used.length ? used : [spec.main];
    items.push({ slot: `${ratio}:${index + 1}`, kind: 'main', label: RATIO_LABEL[ratio], sku: skuOf.get(names[0])!, ratio, index, colors: names, multi: names.length > 1, free: false });
  });
  for (const e of spec.extra) for (const ratio of RATIOS) if (spec.words[ratio].length && skuOf.has(e.color)) {
    const pick = skuOf.get(e.color)!;
    items.push({ slot: `${ratio}:1+${pick}`, kind: 'main', label: `加一套首图 · ${e.color}`, sku: pick, ratio, index: 0, colors: [e.color], ...(e.layout ? { layout: e.layout } : {}), multi: false, free: false });
  }
  return items;
}

/** The images the user's plan makes, before anything is written. */
export function draftImages(d: Draft, direct: Set<string>) {
  const words: Record<Ratio, { colors: string[] }[]> = { square: slotsFor(d.counts.square).map(i => d.slots[i]), portrait: slotsFor(d.counts.portrait).map(i => d.slots[i]), poster: d.counts.poster ? [{ colors: [d.main] }] : [] };
  return imagesOf({ colors: d.colors.filter((c): c is PlanColor & { pick: string } => !!c.pick), main: d.main, words, extra: d.extra }, direct);
}

export type PriceLine = { label: string; count: number; unit: number; credits: number; note: string };
/** The price detail shown next to every credit amount. */
export function priceLines(items: ImageItem[], unit: number, multiUnit: number): PriceLine[] {
  const lines: PriceLine[] = [];
  const add = (label: string, price: number, note: string) => {
    const line = lines.find(l => l.label === label && l.unit === price);
    if (line) { line.count++; line.credits += price; } else lines.push({ label, count: 1, unit: price, credits: price, note });
  };
  for (const it of items) {
    if (it.free) add(it.label, 0, '直接用你的静物图，不收费');
    else if (it.multi) add(`${it.label}（多色同框）`, multiUnit, '');
    else add(it.label, unit, it.kind === 'product' ? '从衣服图提取' : it.label.startsWith('加一套') ? '其余图和主推套共用' : '');
  }
  return lines;
}

export const LIMITS = { title: 20, sub: 30, tag: 20 } as const;
const words = (max: number) => z.string().trim().max(max).default('');
/** What the page sends when the user starts generating; the server checks it against the material. */
export const draftSchema = z.object({
  colors: z.array(z.object({ name: z.string().trim().min(1, '颜色名不能空').max(12, '颜色名最多 12 个字'), hex: z.string().max(16).default(''), pick: z.string({ error: '每个颜色都要有一张衣服图' }).min(1) })).min(1, '至少要有一个颜色').max(12),
  main: z.string().min(1),
  parts: z.array(z.object({ part: z.string().trim().min(1, '部位名不能空').max(12, '部位名最多 12 个字'), pick: z.string().nullable().default(null) })).max(12).default([]),
  slots: z.array(z.object({ role: z.enum(Object.keys(MAIN_ROLES) as [MainRole, ...MainRole[]]), title: words(LIMITS.title), sub: words(LIMITS.sub), tags: z.array(z.string().trim().min(1).max(LIMITS.tag)).max(3).default([]), colors: z.array(z.string()).max(4).default([]) })).length(5),
  poster: z.object({ title: words(LIMITS.title), sub: words(LIMITS.sub) }),
  layout: z.string().min(1), counts: countsSchema,
  extra: z.array(z.object({ color: z.string(), layout: z.string().default('') })).max(11).default([]),
});
export type SubmittedDraft = z.infer<typeof draftSchema>;
