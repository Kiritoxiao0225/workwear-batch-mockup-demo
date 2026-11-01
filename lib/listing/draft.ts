/**
 * 电商主图 plan (定方案), shared by the page and the server. From the sorted material and the
 * category it decides, by fixed rules the user can override:
 * - the points: the material's own, each matched to a kind of point the competitors show; and the
 *   kinds many competitors show that the material does not mention (nor covers: 三防 covers 防水),
 *   ranked by how much they weigh with competitors and whether the garment looks like having them,
 *   used only once the user ticks them;
 * - the images: which kinds of image the points fill (an image is made only when there is enough to
 *   say on it), each with as many cards as it has points, and a short heading the AI wrote;
 * - which colour each image shows, who models, and what the two rounds of images cost.
 */
import type { SkuWords } from './sku-card';
import type { SkuEdits } from './sku-text';
import type { CoverPeople } from './templates';
import { skuItems, type DraftVersion } from './sku-versions';
import { versionName, type WearType } from './wear';
import { BUILDS, categoryById, groupOf, evidenceOf, type Category, type PointGroup, type PointType, type Task } from './category';
import { isComponent, isGroup } from './garment-role';
import { cleanWords, conciseTag, FACT, shortName } from './point-words';
import { proofById, type Proof } from './proofs';
import { MASTER_INFO, SELLS, sellOf } from './scene';
import { capacity, fitTemplate, mostCells, needsCast, type Layout, type Ratio, type Template } from './templates';

/** A point as the AI read it from the material: `text` and `note` are the material's own words. */
export type SortedPoint = { text: string; note?: string; type: string; concept?: string | null; proof?: string; part?: string; why?: string; short?: string; from: string[] };
/** The AI's look at a kind of point the material does not mention: does the garment look like having it. */
export type Seen = '有' | '看不出' | '不像';
export type Check = { concept: string; seen: Seen; why: string };
export type MaterialsForPlan = {
  category: string; categoryWhy?: string; points: SortedPoint[]; checks?: Check[];
  /** Short headings the AI wrote for each kind of image, from the material. */
  titles?: Partial<Record<Task, string[]>>;
  colors: { name: string; hex: string; pick: string | null }[];
  parts: { part: string; pick: string | null }[];
};
export type Point = {
  id: string; text: string; note: string; type: PointType; concept: string | null;
  group: PointGroup | '定位'; source: '素材' | '品类'; kind: '衣服' | '服务'; on: boolean;
  /** Extra points only: how the garment looks to the AI, and why. Folded: offered under "more". */
  seen?: Seen; seenWhy?: string; folded?: boolean;
  proof: string; part: string; why: string; evidence: string; from: string[]; score: number;
  /** 2–6 characters for an icon or a tag, from the analysis (point-words shortName); none on older plans. */
  short?: string;
  /** The user wants it on an image whatever its weight: it takes a card first, squeezing the image up to six cards. */
  must?: boolean;
};
/** One card or icon of an image: a point and the way it is drawn. Its words are the point's. */
export type Cell = { point: string; proof: string };
export type Slot = {
  task: Task; lead: string | null; title: string; sub: string; tags: string[]; cells: Cell[];
  /** The way the model demonstrates the lead point, when the image has a person. */
  act: string | null; colors: string[]; manual?: boolean; why?: string;
  /** The shop's kept service image used as it is ("A-dark"): nothing to write, nothing to pay for the square one. */
  shopService?: string;
  /** Left from the trial of 2026-10-12, when images went by the AI's themes of points; no longer used. */
  theme?: string;
  /** How much the image says: the sum of its points' weight; fewer images keep the heaviest. */
  score: number;
};
export type PlanColor = { name: string; hex: string; pick: string | null };
export type Part = { part: string; pick: string | null };
export type Counts = { square: number; portrait: number; long: number };
/**
 * Who models. `photos`: the material's own model photos the cast is drawn from (labels, one per
 * gender); a gender without one is made up. Without photos the AI makes up both.
 */
export type Model = { lead: '男' | '女'; photos?: { 男?: string; 女?: string } };
export type Gender = '男' | '女';
export const SKU_PEOPLE = ['实拍', '男', '女', '男女'] as const;
export type SkuPeople = (typeof SKU_PEOPLE)[number];
export const GENDERS: Gender[] = ['男', '女'];
export type Draft = {
  category: string; categoryWhy: string; titles: Partial<Record<Task, string[]>>; points: Point[]; colors: PlanColor[]; main: string; parts: Part[];
  slots: Slot[]; long: { title: string }; layout: string; counts: Counts;
  /** Covers in other colours (换色首图); `shop`: the shop that cover is for, when not the product's (10-22). */
  extra: { color: string; layout: string; shop?: string }[]; model: Model;
  /** Which of the account's shops the product's images are for (10-22): its service image, LOGOs and badge. None: the default one. */
  shop?: string;
  /** Left from the trial of 2026-10-12 (images by the AI's themes of points); no longer used. */
  themes?: unknown[];
  /**
   * Masters whose cover is shot on location: where (scene.ts PLACES), the point the picture acts out
   * (SELLS), and which of the place's acts and looks it takes (coverPicks; none before 10-17: the first).
   */
  scene?: { place: string; sell: string; act?: number; look?: number };
  /**
   * Who the SKU images (the template's, layout.sku.specCard) show: the material's own model photos
   * (实拍, colours without one get the cover's people drawn), or the cast drawn in every colour, one of
   * them or both. None (plans before 10-21): 实拍.
   */
  skuPeople?: SkuPeople;
  /**
   * The SKU images' left column (11-01): which of the shop's field combos (sku-card.ts SKU_FIELDS; none: the
   * shop's default) and the words typed on the plan for its fields, 货号 among them (none: from the name).
   */
  skuFields?: string;
  skuWords?: SkuWords;
  /** 「改 SKU 图文字」 (11-01, sku-text.ts): the words written by hand on the SKU images, the whole product's and single images'. */
  skuEdits?: SkuEdits;
  /** Who the cover shows (11-01, templates.ts COVER_PEOPLE); none: the master's own (two: a man and a woman, one: the lead). */
  coverPeople?: CoverPeople;
  /**
   * How it is worn (10-22): 春秋薄款 as before, 有内胆 open over its liner (`liner`: the material's photo
   * the liner is drawn from), 一体 zipped to the top. From the material's reading, changed on the plan.
   * None (plans before): as before.
   */
  /**
   * `main`: the version over a liner the main images wear (sku-versions.ts mainLiner), else each colour's most-shown one.
   * 一体 (10-29, inside.ts): `box` the SKU images' small box of the inside (empty where there is no photo), `open` the
   * cover worn open on it, `insides` each colour's inside photo by colour key ('' none) where the user chose.
   */
  wear?: { type: WearType; liner?: string; main?: string; box?: boolean; open?: boolean; insides?: Record<string, string> };
  /** The SKU versions of a 有内胆 jacket (sku-versions.ts); none: one SKU image per colour, as before. */
  versions?: DraftVersion[];
  /** What the chest shows: nothing, the word 「LOGO」, the shop's sample LOGO (店铺设置, 10-21), or this product's customer LOGO (an uploaded image's label). */
  logo?: { mode: '不印' | 'LOGO' | '样例' | '客户'; label?: string };
  /** A copy's number (「再出一套」): it moves the plan's seed, so each copy leads with another point and scene. */
  seed?: number;
};

/**
 * What a copy of a product (「再出一套」, listing-copy) carries over from it: its colours' white
 * images by colour key (with the colour's name then), its model and the slots it has images of.
 */
export type Reuse = { colors: Record<string, string>; model: Model | null; slots: string[]; wear?: Draft['wear'] };
/**
 * The carried-over images this plan can use as they are: a colour's white image while the colour
 * keeps its name and garment image, the cast while the model is the same. The rest is drawn again.
 */
export function reusedSlots(d: Pick<Draft, 'colors' | 'model' | 'wear'>, reuse?: Reuse): Set<string> {
  const out = new Set<string>();
  if (!reuse) return out;
  colorKeys(d.colors).forEach((k, i) => { if (k && reuse.colors[k] === d.colors[i].name && reuse.slots.includes(`product:${k}`)) out.add(`product:${k}`); });
  // The cast is worn the copy's way too (10-22): another wear draws it again.
  const m = reuse.model, same = !!m && m.lead === d.model.lead && (m.photos?.男 ?? '') === (d.model.photos?.男 ?? '') && (m.photos?.女 ?? '') === (d.model.photos?.女 ?? '')
    && (reuse.wear?.type ?? '薄款') === (d.wear?.type ?? '薄款') && (reuse.wear?.liner ?? '') === (d.wear?.liner ?? '') && (reuse.wear?.main ?? '') === (d.wear?.main ?? '');
  if (same) for (const s of reuse.slots) if (s === 'cast' || s.startsWith('cast:')) out.add(s);
  return out;
}

/** The closer wears at most this many colours, one person each. */
export const CLOSER_MAX = 6;
export const LIMITS = { title: 20, sub: 30, tag: 12, cell: 12 } as const;
export const DEFAULT_COUNTS: Counts = { square: 5, portrait: 5, long: 1 };
export const FRONT = '正面全身';
const len = (s: string) => [...s.trim()].length;
/** Several points in one ("防水、透气、耐磨"): fine as a tag, breaks into lines as a big title. */
/** The kinds of the images that say something on every master, in order (its samples' third and fourth). */
const MASTER_MIDDLE: Task[] = ['功能', '细节'];
/**
 * What the garment is, for a cover shot in the studio: its most telling build found in the ticked
 * points (三合一 from 「可拆卸摇粒内胆」), then the category; else the strongest point, then the category.
 */
function builtAs(on: Point[], category: Category): { title: string; from: Point | null } | null {
  const builds = BUILDS[category.id];
  if (!builds) return null;
  for (const [word, re] of builds) { const from = on.find(p => re.test(`${p.text} ${p.note}`)); if (from) return { title: `${word} ${category.name}`, from }; }
  const strongest = on.find(p => !CLOSER.includes(p.type) && !isList(p.text) && len(p.text) <= 6);
  return strongest ? { title: `${strongest.text} ${category.name}`, from: strongest } : { title: category.name, from: null };
}
/**
 * The words on an image of fabric: the composition as the tag above the title (「100%聚酯纤维」), then
 * facts as 「label｜word」 (「面料科技｜德国SUPER-TEX」, 「面料特点｜高防水透气膜」), all from the
 * material's fabric points and their notes; nothing made up, so fewer facts when it says less.
 */
function fabricWords(fabric: Point[], room: number): string[] {
  const made = /\d+\s*%|纤维|棉|锦纶|涤纶|氨纶|聚酯|尼龙/;
  const ordered = [...fabric].sort((a, b) => Number(made.test(b.text)) - Number(made.test(a.text)));
  const [pill, ...rest] = ordered;
  if (!pill) return [];
  // Each the point's most telling words that fit (10-19: 「面料科技｜高防水透气膜 德国SUPER-TEX」 stopped the plan).
  const word = (p: Point) => conciseTag(p.text, FACT.word) ?? p.short ?? null;
  const facts = [...rest.flatMap(p => { const w = word(p); return w ? [`${made.test(p.text) ? '面料成分' : '面料科技'}｜${w}`] : []; }),
    ...ordered.map(p => p.note.trim()).filter(n => n && len(n) <= 8 && !/[，。,；;]/.test(n)).map(n => `面料特点｜${n}`)];
  const top = conciseTag(pill.text, LIMITS.tag);
  return [...(top ? [top] : []), ...facts].slice(0, room);
}
/** Does a heading speak of this point (two characters in a row in common)? */
/** The garment part a heading names, if any, as the word its card's point says it with (立领 → 领). */
export function partNamed(text: string) {
  const m = /帽|领口|立领|翻领|衣领|袖|口袋|拉链|门襟|下摆|压胶|胶条|肩部|腋下|抽绳|魔术贴|反光条/.exec(text)?.[0];
  const short: Record<string, string> = { 领口: '领', 立领: '领', 翻领: '领', 衣领: '领', 压胶: '胶', 胶条: '胶', 肩部: '肩', 腋下: '腋', 反光条: '反光' };
  return m && (short[m] ?? m);
}
const about = (heading: string, text: string) => [...text].some((_, i) => i < text.length - 1 && heading.includes(text.slice(i, i + 2)));
export const isList = (text: string) => text.split(/[、，,/／]/).filter(t => t.trim()).length >= 3;
const rank = (points: Point[]) => [...points].sort((a, b) => b.score - a.score);
/** At most this many extra points are offered at first; the rest fold under "more". */
const OFFER = 5;

/* ---------- the points ---------- */

/**
 * The material's points matched to the category and ranked: how much the merchant stresses a
 * point (the AI's order) weighs 60%, how much it weighs with competitors (by sales, and on the
 * cover) 40%; a point no competitor shows counts as a fair difference. Then the kinds that a
 * quarter of the competitors show (or half of them by sales) that the material neither mentions
 * nor covers, unticked; a garment feature counts less when the garment does not look like having
 * it, and is folded away when it looks unlikely.
 */
export function reviewPoints(m: Pick<MaterialsForPlan, 'points' | 'checks'>, category: Category): Point[] {
  const byId = new Map(category.concepts.map(c => [c.id, c]));
  // A kind that covers others (三防: 防水, 防污) weighs as much as the heaviest of them.
  const weight = (c: { share: number; includes: string[] }) => Math.max(c.share, ...c.includes.map(i => byId.get(i)?.share ?? 0));
  const market = (id: string | null) => { const c = id ? byId.get(id) : undefined; return c ? Math.min(1, weight(c) + c.cover / 200) : 0.45; };
  const own: Point[] = m.points.map((p, i) => {
    const concept = p.concept && byId.has(p.concept) ? p.concept : null, c = concept ? byId.get(concept) : undefined;
    const type = (p.type as PointType) || c?.type || '功能';
    // The material's words, its typos put right and a field name in front taken off (10-19); the page says what changed.
    const text = cleanWords(p.text), note = cleanWords(p.note ?? '', false), fixed = [...text.fixed, ...note.fixed];
    return {
      id: `m${i + 1}`, text: text.text, note: note.text, type, concept, group: type === '定位' ? '定位' : groupOf(c), source: '素材',
      kind: type === '服务定制' ? '服务' : '衣服', on: true, proof: p.proof && proofById(p.proof) ? p.proof : defaultProof(type, c?.proofs), part: p.part ?? '',
      why: [p.why ?? '', fixed.length ? `已改错字：${[...new Set(fixed)].join('、')}` : ''].filter(Boolean).join('；'),
      evidence: evidenceOf(c, category), from: p.from, score: type === '定位' ? 2 : 0.6 * (1 - i / Math.max(1, m.points.length)) + 0.4 * market(concept),
      ...(shortName(p.short ?? '', text.text) ? { short: shortName(p.short ?? '', text.text) } : {}),
    };
  });
  const covered = new Set(own.flatMap(p => p.concept ? [p.concept, ...(byId.get(p.concept)?.includes ?? [])] : []));
  const checks = new Map((m.checks ?? []).map(c => [c.concept, c]));
  const factor: Record<Seen, number> = { 有: 1, 看不出: 0.6, 不像: 0.15 };
  const extra: Point[] = category.concepts.filter(c => (c.coverage >= 0.25 || c.share >= 0.5) && !covered.has(c.id)).map(c => {
    const kind = c.type === '服务定制' ? '服务' as const : '衣服' as const, check = kind === '衣服' ? checks.get(c.id) : undefined, seen = kind === '衣服' ? check?.seen ?? '看不出' : undefined;
    return {
      id: `c-${c.id}`, text: c.wordings[0] ?? c.name, note: '', type: c.type, concept: c.id, group: '补充', source: '品类', kind, on: false, seen, seenWhy: check?.why,
      proof: defaultProof(c.type, c.proofs), part: '', why: '', evidence: evidenceOf(c, category), from: [], score: 0.4 * market(c.id) * (seen ? factor[seen] : 1),
    } satisfies Point;
  });
  const offered = rank(extra).map((p, k) => ({ ...p, folded: k >= OFFER || p.seen === '不像' }));
  return [...rank(own), ...offered];
}

function defaultProof(type: PointType, proofs: string[] = []) {
  if (proofs[0]) return proofs[0];
  return type === '做工' ? 'part' : type === '服务定制' ? 'icon-text' : type === '颜色款式' ? 'swatches' : type === '人群场景' ? 'team-scene' : 'icon-text';
}
/** The ways a point can sensibly be drawn: its kind's, a close-up for a garment part, an icon for a service. */
export function proofsFor(point: Point, category: Category): Proof[] {
  const own = category.concepts.find(c => c.id === point.concept)?.proofs ?? [];
  const extra = point.type === '做工' || point.type === '实用' ? ['part'] : point.type === '服务定制' || point.type === '颜色款式' ? ['icon-text'] : [];
  const ids = [...new Set([point.proof, ...own, ...extra])];
  const list = ids.map(proofById).filter((p): p is Proof => !!p);
  return list.length ? list : [proofById('icon-text')!];
}
/** The way a point is drawn on a zone: a person's demonstration only where there are people. */
export function fitProof(point: Point, template: Template, category: Category): string {
  // People only where the template has them; an image of fabric only cannot show a part of the garment.
  const fits = (p: Proof) => (!p.person || template.people > 0) && !(template.fabricOnly && (p.kind === '部位特写' || !!p.part));
  const proof = proofById(point.proof);
  if (proof && fits(proof)) return point.proof;
  return proofsFor(point, category).find(fits)?.id ?? 'icon-text';
}

/* ---------- the images ---------- */

/** The shop's services are drawn on the shop's own service image (lib/listing/service.ts), not on this product's. */
const BUCKET: Partial<Record<PointType, Task>> = { 功能: '功能', 面料: '功能', 做工: '细节', 实用: '实用' };
/** The image a point of this type belongs on in this category. */
export const taskFor = (type: PointType, tasks: Task[]): Task | undefined => {
  const t = BUCKET[type];
  return t === '实用' && !tasks.includes('实用') ? '细节' : t && tasks.includes(t) ? t : undefined;
};
/** An image of this kind is made only with at least this many points for it. */
const ENOUGH: Partial<Record<Task, number>> = { 功能: 1, 细节: 2, 实用: 1 };
/** Equal amounts: features before close-ups. */
const PREFER: Task[] = ['功能', '细节', '实用'];
const CLOSER: PointType[] = ['人群场景', '颜色款式'];
const MIDDLE = 3;

/**
 * The images the ticked points fill. The cover leads with the positioning point and the strongest
 * points as tags (at most one of the product's own). Where the category has a service image it is
 * always the second, the shop's kept one (free, nothing to write). The other middle images go, one
 * at a time, to the kind with the most points still to show that has enough for an image (a second
 * feature image when there are many features); left over room shows the garment worn at work. Each image takes as many cards as it has points (up to the
 * layout's), its heading from the AI's, its sub-line from the lead point. The closer counts the
 * colours. Shown in the category's order.
 */
export function planSlots(points: Point[], category: Category, layout: Layout, colorNames: string[], titles: Draft['titles'] = {}): { slots: Slot[]; long: Draft['long'] } {
  const on = rank(points.filter(p => p.on)), tasks = category.tasks;
  const coverT = layout.templates.首图.square;
  // A cover shot in the studio or without people says what the garment is when the material does not.
  const named = MASTER_INFO[layout.id] && MASTER_INFO[layout.id].cover !== '实景' && !on.some(p => p.type === '定位') ? builtAs(on, category) : null;
  const cover = named ? undefined : on.find(p => p.type === '定位') ?? on[0];
  const title = named?.title ?? cover?.text ?? '';
  // Its tags say something else than the title: custom-made first for the category made to order.
  const coverTags: string[] = named && category.id === 'workwear' ? ['团体定制'] : [];
  for (const p of on) {
    if (coverTags.length >= capacity(coverT).tags) break;
    if (p === cover || p === named?.from || p.type === '定位' || CLOSER.includes(p.type) || isList(p.text) || len(p.text) > LIMITS.tag || about(title, p.text)) continue;
    if (p.group === '独有' && on.some(t => t.group === '独有' && coverTags.includes(t.text))) continue;
    coverTags.push(p.text);
  }
  const left = new Map<Task, Point[]>();
  for (const p of on) { const t = p === cover ? undefined : taskFor(p.type, tasks); if (t) left.set(t, [...(left.get(t) ?? []), p]); }
  const seen = new Map<Task, number>();
  // The AI's headings for the kind of image, in turn; never the cover's own words again. A feature
  // image's heading says its lead point (the line under it is that point's note), else it is the point.
  // A close-up image's heading names no part, or its lead's, the first card: one headed 「帽围自由调节」
  // had a pocket as its big picture (10-15).
  const heading = (task: Task, fallback: string) => {
    const k = seen.get(task) ?? 0, fresh = (titles[task] ?? []).filter(t => !cover || (t !== cover.text && !t.includes(cover.text)));
    seen.set(task, k + 1);
    const pool = task === '功能' ? fresh.filter(t => about(t, fallback)) : task === '细节' ? fresh.filter(t => about(t, fallback) || !partNamed(t)) : fresh;
    return pool[task === '功能' ? 0 : k] ?? fallback;
  };
  const middle: Slot[] = tasks.includes('服务') ? [{ task: '服务', lead: null, title: '店铺服务图', sub: '', tags: [], cells: [], act: null, colors: [], shopService: 'shop', score: 0.5 }] : [];
  while (middle.length < MIDDLE) {
    // A second image of one kind needs one point more than the first.
    const ok = PREFER.filter(t => (left.get(t)?.length ?? 0) >= (ENOUGH[t] ?? 1) + (middle.some(m => m.task === t) ? 1 : 0));
    if (!ok.length) break;
    // A master's images that say something are a feature image, then a close-up image, as on its samples;
    // the kind with the most points left takes an image only when the master's own kind has none.
    const want = MASTER_INFO[layout.id] ? MASTER_MIDDLE.filter(t => tasks.includes(t))[middle.filter(m => !m.shopService).length] : undefined;
    const task = want && ok.includes(want) ? want : ok.sort((a, b) => left.get(b)!.length - left.get(a)!.length || PREFER.indexOf(a) - PREFER.indexOf(b))[0];
    const t = layout.templates[task].square, room = capacity(t), list = left.get(task)!;
    const lead = list.find(p => !isList(p.text)) ?? list[0];
    const act = room.person ? proofsFor(lead, category).find(p => p.person)?.id ?? null : null;
    // The fabric is the tag above the title, as on the masters (「90%锦纶 10%氨纶」); the cards take the rest.
    const fabric = room.tags ? list.filter(p => p !== lead && p.type === '面料').slice(0, t.fabricOnly ? 2 : room.tags) : [];
    const inCells = (act ? list.filter(p => p !== lead) : list).filter(p => !fabric.includes(p));
    const cells = inCells.slice(0, room.cells).map(p => ({ point: p.id, proof: fitProof(p, t, category) }));
    const tags = t.fabricOnly ? fabricWords(fabric, room.tags)
      : [...fabric, ...list.filter(p => p !== lead && !fabric.includes(p) && !cells.some(c => c.point === p.id))].slice(0, room.tags).map(p => p.text);
    const used = [lead, ...inCells.slice(0, room.cells), ...fabric, ...(t.fabricOnly ? [] : list.filter(p => tags.includes(p.text)))];
    left.set(task, list.filter(p => !used.includes(p)));
    // The line under the title: the lead point's note, else the next point's on the image.
    const sub = lead.note || inCells.slice(0, room.cells).find(p => p.note)?.note || '';
    middle.push({ task, lead: lead.id, title: heading(task, lead.text), sub, tags, cells, act, colors: [], score: used.reduce((n, p) => n + p.score, 0) });
  }
  const closer = on.filter(p => CLOSER.includes(p.type));
  // Who wears it (物业、工厂、4S 店) goes on the scene image unless the closer takes it.
  const crowd = on.filter(p => p.type === '人群场景' && p !== closer[0]);
  while (middle.length < MIDDLE) middle.push({ task: '场景', lead: null, title: heading('场景', crowd[0]?.text ?? ''), sub: crowd[0]?.text ?? '', tags: [], cells: [], act: null, colors: [], score: 0 });
  middle.sort((a, b) => tasks.indexOf(a.task) - tasks.indexOf(b.task));
  const last: Slot = colorNames.length > 1
    ? { task: '收口', lead: null, title: closerTitle(colorNames.length), sub: closerSub(on) || (closer[0]?.text ?? ''), tags: [], cells: [], act: null, colors: [], score: 0 }
    : { task: '收口', lead: closer[0]?.id ?? null, title: closer[0]?.text ?? '', sub: closer[0]?.note ?? '', tags: closer.slice(1).flatMap(p => conciseTag(p.text, LIMITS.tag) ?? p.short ?? []).slice(0, 1), cells: [], act: null, colors: [], score: 0 };
  const first: Slot = { task: '首图', lead: named ? named.from?.id ?? null : cover?.id ?? null, title, sub: named ? '' : cover?.note ?? '', tags: coverTags, cells: [], act: null, colors: [], score: 99 };
  let slots = [first, ...middle, last];
  for (const p of on.filter(x => x.must)) if (!shownOn(slots, p)) slots = squeezeIn(slots, p, points, category, layout);
  return { slots, long: { title: cover?.text ?? '' } };
}

/** Is the point on one of these images (a title, a demonstration, a card, a tag or a sub-line)? */
const shownOn = (slots: Slot[], p: Point) => slots.some(s => (s.lead === p.id && (s.task === '首图' || !!s.act)) || s.cells.some(c => c.point === p.id) || s.tags.includes(p.text) || s.sub === p.text);
/**
 * A point the user must show, put on the images that say something: an image of its kind first, then
 * any; a new card while the template can take one (squeezed up to six), else in place of the
 * lightest card the user does not insist on.
 */
function squeezeIn(slots: Slot[], p: Point, points: Point[], category: Category, layout: Layout, made?: number[]): Slot[] {
  const own = taskFor(p.type, category.tasks);
  const content = slots.map((s, i) => ({ s, i })).filter(({ s, i }) => !['首图', '服务', '场景', '收口'].includes(s.task) && !s.shopService && (!made || made.includes(i)));
  const order = [...content.filter(({ s }) => s.task === own), ...content];
  const weight = (id: string) => points.find(x => x.id === id);
  for (const { s, i } of order) {
    const t = layout.templates[s.task].square, cell = { point: p.id, proof: fitProof(p, t, category) };
    if (s.cells.length < mostCells(t)) return slots.map((x, k) => k === i ? { ...x, cells: [...x.cells, cell] } : x);
    const light = s.cells.map((c, k) => ({ k, w: weight(c.point) })).filter(x => !x.w?.must).sort((a, b) => (a.w?.score ?? 0) - (b.w?.score ?? 0))[0];
    if (light) return slots.map((x, k) => k === i ? { ...x, cells: x.cells.map((c, m) => m === light.k ? cell : c) } : x);
  }
  return slots;
}

/** Which images n of them use: the cover and the closer always, then the middle ones that say the most. */
export function usedSlots(d: Pick<Draft, 'slots'>, n: number): number[] {
  const last = d.slots.length - 1;
  if (n <= 0) return [];
  if (n === 1) return [0];
  const middle = d.slots.map((s, i) => ({ s, i })).slice(1, last).sort((a, b) => b.s.score - a.s.score).slice(0, n - 2).map(x => x.i).sort((a, b) => a - b);
  return [0, ...middle, last];
}
/** The template an image is drawn on: its kind's, with the cards it actually has. */
export const templateFor = (layout: Layout, slot: Pick<Slot, 'task' | 'cells'>, ratio: 'square' | 'portrait' = 'square') => fitTemplate(layout.templates[slot.task][ratio], slot.cells.length);
/** Does the image show the garment (a person or the garment alone)? Icons-only images take no colour. */
export const showsGarment = (layout: Layout, task: Task) => layout.templates[task].square.zones.some(z => z.kind === 'person' || z.kind === 'garment');

/** Where each ticked point is used ("第 2 张格 1"), on the images that are made. */
export function usageOf(d: Draft): Map<string, string[]> {
  const out = new Map<string, string[]>(), add = (id: string | null | undefined, where: string) => { if (id) out.set(id, [...(out.get(id) ?? []), where]); };
  const byText = (t: string) => d.points.find(p => p.on && p.text === t)?.id;
  usedSlots(d, d.counts.square).forEach((i, k) => {
    const s = d.slots[i], n = `第 ${k + 1} 张`;
    // On location the cover's title is its point's big word, not the positioning.
    if (s.task === '首图') { if (s.title === d.points.find(p => p.id === s.lead)?.text) add(s.lead, `${n}大标题`); }
    else if (s.act) add(s.lead, `${n}模特演示`);
    s.cells.forEach((c, m) => add(c.point, `${n}格 ${m + 1}`));
    s.tags.forEach(t => add(byText(t), `${n}标签`));
    if (s.sub) add(byText(s.sub), `${n}小字`);
  });
  return out;
}

export type Place = { slot: number; label: string; mine: boolean; empty: boolean; apply: (d: Draft) => Draft };
/** Where a point can go: a new card or tag on an image with room first, its own kind of image first. */
export function placesFor(d: Draft, pointId: string, layout: Layout): Place[] {
  const p = d.points.find(x => x.id === pointId), category = categoryById(d.category);
  if (!p) return [];
  const own = taskFor(p.type, category.tasks), places: Place[] = [];
  usedSlots(d, d.counts.square).forEach((i, k) => {
    const s = d.slots[i], base = layout.templates[s.task].square, room = capacity(base), n = `第 ${k + 1} 张`;
    const mine = s.task === own;
    const setSlot = (patch: Partial<Slot>) => (x: Draft) => ({ ...x, slots: x.slots.map((y, m) => m === i ? { ...y, ...patch } : y) });
    const cell = { point: p.id, proof: fitProof(p, base, category) };
    if (room.cells > s.cells.length) places.push({ slot: i, label: `${n} · 加一格`, mine, empty: true, apply: setSlot({ cells: [...s.cells, cell] }) });
    else if (s.cells.length && mostCells(base) > s.cells.length) places.push({ slot: i, label: `${n} · 挤一格（格子变小）`, mine, empty: false, apply: setSlot({ cells: [...s.cells, cell] }) });
    // A point as a tag: its words that fit a tag, or not offered as one.
    const tag = conciseTag(p.text, LIMITS.tag) ?? p.short ?? null;
    if (tag && room.tags > s.tags.length) places.push({ slot: i, label: `${n} · 加成标签`, mine, empty: true, apply: setSlot({ tags: [...s.tags, tag] }) });
    s.cells.forEach((c, m) => places.push({ slot: i, label: `${n} · 换掉格 ${m + 1}「${d.points.find(x => x.id === c.point)?.text ?? ''}」`, mine, empty: false, apply: setSlot({ cells: s.cells.map((y, j) => j === m ? cell : y) }) }));
    if (tag) s.tags.forEach((t, m) => places.push({ slot: i, label: `${n} · 换掉标签「${t}」`, mine, empty: false, apply: setSlot({ tags: s.tags.map((y, j) => j === m ? tag : y) }) }));
  });
  return places.sort((a, b) => Number(b.mine) - Number(a.mine) || Number(b.empty) - Number(a.empty));
}

/**
 * Tick or untick a point without disturbing the images the user worked on: a ticked point takes
 * free room on an image of its own kind if there is any (else it waits as unused); an unticked
 * point leaves every card and tag it was on.
 */
export function tickPoint(d: Draft, id: string, on: boolean, layout: Layout): Draft {
  const p = d.points.find(x => x.id === id);
  if (!p) return d;
  const next: Draft = { ...d, points: d.points.map(x => x.id === id ? { ...x, on } : x) };
  if (on) {
    const free = placesFor(next, id, layout).find(x => x.mine && x.empty);
    return free ? free.apply(next) : next;
  }
  return { ...next, slots: next.slots.map(s => {
    const cells = s.cells.filter(c => c.point !== id);
    return { ...s, cells, tags: s.tags.filter(t => t !== p.text), lead: s.lead === id ? cells[0]?.point ?? null : s.lead, act: s.lead === id ? null : s.act };
  }) };
}
/** 「拿下来」: a point off the images (its cards, tags and demonstration); it stays in the list, and 按新卖点重排 leaves it off. */
export function takeOff(d: Draft, id: string, layout: Layout): Draft {
  const next = tickPoint(d, id, false, layout);
  return { ...next, points: next.points.map(p => p.id === id ? { ...p, must: false } : p) };
}
/** 「放上去」: a point onto an image at one of its places (placesFor); 按新卖点重排 keeps it on the images (squeezed in if need be). */
export function putOn(d: Draft, id: string, place: Place): Draft {
  const next = place.apply(d);
  return { ...next, points: next.points.map(p => p.id === id ? { ...p, on: true, must: true } : p) };
}
/** A point's words changed: the tags and sub-lines that carried them follow (cards follow by themselves). */
export function renamePoint(d: Draft, id: string, patch: Partial<Pick<Point, 'text' | 'note'>>): Draft {
  const p = d.points.find(x => x.id === id);
  if (!p) return d;
  const text = patch.text ?? p.text;
  return { ...d, points: d.points.map(x => x.id === id ? { ...x, ...patch } : x),
    slots: d.slots.map(s => ({ ...s, tags: s.tags.map(t => t === p.text ? text : t), sub: s.lead === id && patch.note !== undefined ? patch.note : s.sub === p.text ? text : s.sub, title: s.task === '首图' && s.lead === id ? text : s.title })) };
}
/** When the ticked points would now fill other kinds of image than the plan has, say how. */
export function structureHint(d: Draft, layout: Layout): string {
  const fresh = planSlots(d.points, categoryById(d.category), layout, d.colors.filter(c => c.pick).map(c => c.name), d.titles).slots.map(s => s.task);
  const now = d.slots.map(s => s.task);
  if (fresh.join() === now.join()) return '';
  const name = (t: Task) => `「${t === '服务' ? '服务说明' : t}」`;
  const more = [...new Set(fresh.filter(t => fresh.filter(x => x === t).length > now.filter(x => x === t).length))];
  const less = [...new Set(now.filter(t => now.filter(x => x === t).length > fresh.filter(x => x === t).length))];
  return [more.length && `多一张${more.map(name).join('')}图`, less.length && `少一张${less.map(name).join('')}图`].filter(Boolean).join('、');
}

/**
 * After a cell's point changed, the words of the same image that still name what it showed:
 * "领口、拉链、袖口逐一放大" after the cuff cell became a water demonstration.
 */
export function staleMentions(slot: Pick<Slot, 'title' | 'sub' | 'tags'>, gone: string[]) {
  // "贴腕袖口" is also "袖口": the last two characters usually name the part.
  const words = gone.flatMap(g => g.split(/[、，,\s/]+/)).map(w => w.replace(/(设计|特写|细节|工艺)$/, '')).flatMap(w => len(w) > 2 ? [w, [...w].slice(-2).join('')] : [w]).filter(w => len(w) >= 2);
  return [['大标题', slot.title], ['小字', slot.sub], ...slot.tags.map(t => ['标签', t])].filter(([, s]) => words.some(w => s.includes(w))).map(([where, s]) => `${where}「${s}」`);
}

/** The garment part a close-up cell needs a picture of ("袖口" for 贴腕袖口). */
/**
 * The part a point's close-up shows. Taped seams are taped on the inside: a photo of the outer
 * stitching is not one of them (10-15: 「接缝全压胶」 drawn from an outer seam), so the claim wants a
 * photo of the tape itself.
 */
export const partOf = (p: { part?: string; text: string }) => {
  // A 压胶拉链 is a zip with sealed teeth, not taped seams (10-18: 「压胶缝工艺拉链」 drawn from the seam-tape photo).
  const taped = /压胶/.test(p.text + (p.part ?? '')) && !/拉链/.test(p.text + (p.part ?? ''));
  return taped && !/压胶|胶条/.test(p.part ?? '') ? '压胶条' : p.part || p.text;
};
/** The structure image of a part (its label), if the plan has one. */
export const partPick = (d: Pick<Draft, 'parts'>, part: string) => d.parts.find(x => x.pick && (x.part === part || part.includes(x.part) || x.part.includes(part)))?.pick ?? null;
export const hasPart = (d: Pick<Draft, 'parts'>, part: string) => !!partPick(d, part);
/** A sorted image, as far as finding a part on it goes. */
export type PartSource = { id: string; detail: string; same?: string; kind?: string; parts?: string[] };
const CLOSE_KINDS = ['细节特写', '卖点图', '详情页'];
/**
 * A photo of a part: one sorted as that part, else one the sorting saw it on among others, else
 * where the point about the part says the material shows it (10-13: a detail page showing the cuff
 * and the pocket was sorted as 门襟拉链 only, while 「魔术贴防风袖口」 named it as its source).
 */
export function partPhoto(points: { text: string; part?: string; from: string[] }[], part: string, images: PartSource[]) {
  const usable = images.filter(i => !i.same), is = (x?: string) => !!x && (x === part || part.includes(x) || x.includes(part));
  const cited = points.filter(p => is(partOf(p))).flatMap(p => p.from).map(id => usable.find(i => i.id === id && CLOSE_KINDS.includes(i.kind ?? '')))
    .filter((i): i is PartSource => !!i).sort((a, b) => CLOSE_KINDS.indexOf(a.kind!) - CLOSE_KINDS.indexOf(b.kind!));
  return usable.find(i => is(i.detail)) ?? usable.find(i => i.parts?.some(is)) ?? cited[0];
}
/**
 * Close-ups of parts the structure images do not have yet, found in the sorted material: a cell
 * showing 袖口 brings the material's own cuff close-up into the structure images.
 */
export function fillParts(d: Draft, images: PartSource[]): Draft {
  let parts = d.parts;
  for (const s of d.slots) for (const c of s.cells) {
    const p = d.points.find(x => x.id === c.point);
    if (!p || !proofById(c.proof)?.part) continue;
    const part = partOf(p);
    if (hasPart({ parts }, part)) continue;
    const found = partPhoto(d.points, part, images);
    if (found) parts = [...parts.filter(x => x.part !== part), { part, pick: found.id }];
  }
  // A close-up of a part the material still has no photo of is drawn another way that needs none: it
  // used to be only a yellow note, and generating went ahead with a part the model had never seen (10-13).
  const next = parts === d.parts ? d : { ...d, parts }, category = categoryById(d.category);
  let changed = false;
  const slots = next.slots.map(s => {
    const miss = missingParts(next, s);
    if (!miss.length) return s;
    changed = true;
    return { ...s, cells: s.cells.map((c, n) => { const m = miss.find(x => x.n === n); return m ? { ...c, proof: noPhotoProof(m.p, category).id } : c; }) };
  });
  return changed ? { ...next, slots } : next;
}
/** How a point is drawn when the material has no photo of its part: its first way that needs neither a photo nor a person. */
export const noPhotoProof = (p: Point, category: Category): Proof => proofsFor(p, category).find(x => !x.part && !x.person) ?? proofById('icon-text')!;
/** The material's model photos one person of this gender can be drawn from, clear faces first. */
export const modelPhotos = (images: { id: string; kind: string; same?: string; person?: string; face?: boolean }[], g: Gender) =>
  images.filter(i => i.kind === '模特实拍' && !i.same && i.person === g).sort((a, b) => Number(!!b.face) - Number(!!a.face));
/** Materials with a clear photo of a man or a woman draw the cast from them. */
export function fillModel(d: Draft, images: Parameters<typeof modelPhotos>[0]): Draft {
  if (d.model.photos) return d;
  const photos: NonNullable<Model['photos']> = {};
  for (const g of GENDERS) { const best = modelPhotos(images, g)[0]; if (best?.face) photos[g] = best.id; }
  return Object.keys(photos).length ? { ...d, model: { ...d.model, photos } } : d;
}
/** The cast is drawn from the material's photos: one person per image, put side by side. */
export const castFromPhotos = (m: Model) => !!(m.photos?.男 || m.photos?.女);
/** The close-up cells of an image whose part has no picture: they need another way of drawing or a picture. */
export const missingParts = (d: Draft, s: Slot) => s.cells.map((c, n) => ({ c, n, p: d.points.find(x => x.id === c.point) }))
  .filter(({ c, p }) => p && proofById(c.proof)?.part && !hasPart(d, partOf(p))) as { c: Cell; n: number; p: Point }[];

/* ---------- colours ---------- */

const rgb = (hex: string) => { const n = /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : 0x8a8a8a; return [n >> 16, (n >> 8) & 255, n & 255]; };
export const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(v => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const near = (a: string, b: string) => { const x = rgb(a), y = rgb(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 90; };

/**
 * Which colour each image shows. Cover: the main colour. Middle images: one colour each, not the
 * cover's where possible; close-ups first (light or mid colours show structure, never black), then
 * the feature images (mid colours), then the rest; an image without the garment on it (icons only)
 * takes none. Closer: the main colour plus a dark, a light and a mid one. An image whose colours
 * the user chose keeps them.
 */
export function assignColors(slots: Slot[], colors: { name: string; hex: string }[], main: string, wears: (s: Slot) => boolean = () => true): Slot[] {
  const names = colors.map(c => c.name), hex = new Map(colors.map(c => [c.name, c.hex]));
  const others = names.filter(c => c !== main), L = (c: string) => luminance(hex.get(c) ?? '');
  const out = slots.map(s => ({ ...s, colors: wears(s) ? s.colors.filter(c => names.includes(c)) : [] }));
  out.forEach(s => { if (s.manual && !s.colors.length) s.manual = false; });
  const uses = new Map(names.map(c => [c, 0]));
  const take = (c: string) => uses.set(c, (uses.get(c) ?? 0) + 1);
  const last = out.length - 1;
  out[0] = { ...out[0], colors: [main], manual: false, why: '首图用主推色' }; take(main);
  out.forEach((s, i) => { if (i > 0 && s.manual) s.colors.forEach(take); });
  const nearMain = (c: string) => near(hex.get(c) ?? '', hex.get(main) ?? '');
  const score = (task: Task, c: string) => {
    const l = L(c);
    const v = task === '细节' ? (l < 0.12 ? -1 : 1 - Math.abs(l - 0.5) - (l > 0.8 ? 0.3 : 0)) : task === '功能' ? 1 - Math.abs(l - 0.3) * 1.5 - (l < 0.02 ? 0.4 : 0) : 0.5;
    return v - (nearMain(c) ? 0.8 : 0);
  };
  const reason = (task: Task, c: string, reused: boolean) => {
    if (!others.length) return '只有一个颜色';
    if (reused) return '颜色不够，循环使用';
    if (task === '细节') return '细节图用浅色、中间色，结构看得清';
    if (task === '功能') return L(c) < 0.12 ? '深色，跟首图拉开对比' : L(c) > 0.7 ? '浅色，跟首图拉开对比' : '中间色，演示效果看得清';
    return '跟前面几张不重复';
  };
  const order = (t: Task) => t === '细节' ? 0 : t === '功能' ? 1 : 2;
  const middle = out.map((_, i) => i).filter(i => i > 0 && i < last && !out[i].manual && wears(out[i])).sort((a, b) => order(out[a].task) - order(out[b].task));
  for (const i of middle) {
    const fresh = others.filter(c => !uses.get(c));
    const pool = fresh.length ? fresh : others.length ? [...others].sort((a, b) => uses.get(a)! - uses.get(b)!) : [main];
    const pick = [...pool].sort((a, b) => score(out[i].task, b) - score(out[i].task, a))[0];
    out[i] = { ...out[i], colors: [pick], why: reason(out[i].task, pick, !fresh.length && others.length > 0) }; take(pick);
  }
  out.forEach((s, i) => { if (i > 0 && i < last && !wears(s)) s.why = '这张图上没有衣服，不用颜色'; });
  if (last > 0 && !out[last].manual) {
    const byL = [...others].sort((a, b) => L(a) - L(b)), picked: string[] = [];
    if (byL.length) picked.push(byL[0]);
    if (byL.length > 1) picked.push(byL[byL.length - 1]);
    // Every colour is worn when they fit (「6色可选」 with four people read as wrong, 10-13): the rest after a dark, a light and a mid one.
    const rest = byL.filter(c => !picked.includes(c)).sort((a, b) => Number(nearMain(a)) - Number(nearMain(b)) || Math.abs(L(a) - 0.3) - Math.abs(L(b) - 0.3));
    picked.push(...rest);
    const worn = [main, ...picked].slice(0, CLOSER_MAX);
    out[last] = { ...out[last], colors: worn, why: !others.length ? '只有一个颜色' : worn.length === names.length ? '每个颜色一人，都穿上' : `颜色多，穿最有代表性的 ${CLOSER_MAX} 个` };
  }
  out.forEach((s, i) => { if (i > 0 && s.manual) s.why = '你选的'; });
  return out;
}
export const colorize = (d: Draft, layout: Layout, slots = d.slots) => assignColors(slots, d.colors.filter(c => c.pick), d.main, s => !s.shopService && showsGarment(layout, s.task));

/** After colours were added or dropped, the closer still says how many there are. */
export const syncCloser = (slot: Slot, colorNames: string[]): Slot =>
  /^(团体定制 · )?\d+色可选$/.test(slot.title) && colorNames.length > 1 ? { ...slot, title: slot.title.replace(/\d+色可选$/, `${colorNames.length}色可选`) } : slot;
/** The closer's title as the masters' samples print it (「团体定制 · 2色可选」), not the bare count. */
export const closerTitle = (colors: number) => `团体定制 · ${colors}色可选`;
/**
 * The closer's line: the product's functions in their short words, 「防水 / 防风 / 耐磨 / 透气」, as on
 * the samples; empty when fewer than two are found (the closer's own point is used then).
 */
export function closerSub(points: Pick<Point, 'text' | 'type'>[]) {
  const words = [...new Set(points.filter(p => p.type === '功能' || p.type === '面料').map(p => sellOf(p.text)).filter((x): x is NonNullable<typeof x> => !!x).map(x => SELLS[x].big))].slice(0, 4);
  return words.length >= 2 ? words.join(' / ') : '';
}

/* ---------- checks ---------- */

export function overLimit(w: { title: string; sub: string; tags?: string[]; cells?: string[] }) {
  const long = [len(w.title) > LIMITS.title && `大标题超过 ${LIMITS.title} 个字`, len(w.sub) > LIMITS.sub && `小字超过 ${LIMITS.sub} 个字`,
    (w.tags ?? []).some(t => len(t) > LIMITS.tag) && `标签超过 ${LIMITS.tag} 个字`, (w.cells ?? []).some(t => len(t) > LIMITS.cell) && `格子里的字超过 ${LIMITS.cell} 个字`].filter(Boolean);
  return long.length ? `${long.join('、')}，请删短一点` : '';
}
const cellWords = (d: Draft, s: Slot) => s.cells.map(c => d.points.find(p => p.id === c.point)?.text ?? '');

/** Yellow notes for one image, in plain words; empty when it is fine. */
export function notesOf(d: Draft, i: number, layout: Layout): string[] {
  const s = d.slots[i], t = templateFor(layout, s), notes: string[] = [];
  if (!s.title.trim()) return [s.task === '场景' ? '没有大标题：写一句，比如「穿上就是团队」' : '没有大标题：写一句，或从「换一句」里选'];
  for (const c of s.cells) {
    const p = d.points.find(x => x.id === c.point), proof = proofById(c.proof);
    if (!p || !proof) continue;
    if (proof.person && !t.people) notes.push(`「${p.text}」的画法要有人，这张图没有人：换个画法`);
  }
  // A heading that names a part needs a card of it (generating puts that card first: leadCard).
  const named = s.task !== '首图' && s.cells.length ? partNamed(s.title) : undefined;
  if (named && leadCard(d, s.title, s.cells) < 0 && !(s.act && pointNames(d, s.lead, named)))
    notes.push(`大标题讲「${named}」，格子里没有讲「${named}」的：改标题，或换个讲「${named}」的卖点`);
  return notes;
}
const pointNames = (d: Pick<Draft, 'points'>, id: string | null | undefined, part: string) => { const p = d.points.find(x => x.id === id); return !!p && (p.text + p.part).includes(part); };
/**
 * The card a heading naming a part speaks of: generating draws it first, the biggest picture (10-15:
 * 「袖口大小随意调」 over a collar). -1: the heading names no part, or no card shows it.
 */
export function leadCard(d: Pick<Draft, 'points'>, title: string, cells: { point: string | null }[]) {
  const named = partNamed(title);
  return named ? cells.findIndex(c => pointNames(d, c.point, named)) : -1;
}

/**
 * Each colour's key for its own images (product:, skumodel:, sku:): the label of its image. A group
 * photo chosen for several colours (10-15: 白色 and 军绿 worn only on a photo of six people) gives the
 * second colour `<label>-2`, the third `-3`: one photo, but each colour its own images.
 */
export function colorKeys(colors: { pick: string | null }[]): (string | null)[] {
  const seen = new Map<string, number>();
  return colors.map(c => {
    if (!c.pick) return null;
    const n = (seen.get(c.pick) ?? 0) + 1;
    seen.set(c.pick, n);
    return n === 1 ? c.pick : `${c.pick}-${n}`;
  });
}
/** What a colour's image is, as far as choosing it goes: its role, people and colours seen. */
export type PickSource = { id: string; role?: string; detail?: string; person?: string; colorsSeen?: string[] };
/**
 * Colour images that cannot be generated from: a liner or an accessory (not the garment sold), and
 * one photo of a single garment chosen for two colours (only a photo of several garments can be).
 */
export function pickProblems(colors: { name: string; pick: string | null }[], images: PickSource[]): string[] {
  const byId = new Map(images.map(i => [i.id, i])), shared = new Map<string, string[]>();
  for (const c of colors) if (c.pick) shared.set(c.pick, [...(shared.get(c.pick) ?? []), c.name]);
  return [
    ...colors.filter(c => c.pick && isComponent(byId.get(c.pick))).map(c => `「${c.name}」选的是单独拍的内胆或配件（${c.pick}）：换一张这个颜色的衣服本身`),
    ...[...shared].filter(([pick, names]) => names.length > 1 && !isGroup(byId.get(pick))).map(([pick, names]) => `「${names.join('」「')}」用了同一张衣服图（${pick}）：每个颜色换一张自己颜色的图`),
  ];
}

/**
 * Red: generating is refused until fixed. Yellow: the images (by number) worth a second look. With
 * the sorted `images` the colour images are checked too (pickProblems); the server always checks them.
 */
export function checkDraft(d: Draft, layout: Layout, images?: PickSource[]) {
  const live = d.colors.filter(c => c.pick);
  const red = [
    ...(images ? pickProblems(d.colors, images) : []),
    ...d.colors.filter(c => !c.pick).map(c => `「${c.name}」没有衣服图：补传一张，或者不要这个颜色`),
    ...(d.parts.find(p => p.part === FRONT)?.pick ? [] : ['缺正面全身图：补传一张']),
    ...(d.parts.some(p => !p.part.trim()) ? ['有衣服部位没写名字'] : []),
    // A SKU version the user added is drawn from the image they pick (10-22).
    // A liner alone cannot be zipped up out of sight: it needs an image to draw from.
    ...(d.versions ?? []).filter(v => v.on && v.added && v.kind === '单内胆' && !v.ref).map(() => '你加的「单穿内胆」还没选参考图：选一张这件内胆的照片'),
    ...(d.versions ?? []).filter(v => v.on && v.kind !== '单外壳' && !v.inner).map(() => '有个带内胆的 SKU 版本还没写内胆叫什么：写上名字（如 软壳、摇粒绒）'),
    ...(d.versions ?? []).filter(v => v.on && !v.colors.length).map(v => `SKU 版本「${versionName(v)}」一个颜色都没勾：勾上颜色，或者不勾这个版本`),
    ...(live.length ? [] : ['没有颜色了：至少留一个']),
  ];
  const used = usedSlots(d, d.counts.square);
  used.forEach((i, k) => { const s = d.slots[i], long = overLimit({ ...s, cells: cellWords(d, s) }); if (long) red.push(`第 ${k + 1} 张${long}`); });
  // Normally settled on the way in (fillParts); a draft that still asks for a part with no photo is not generated.
  used.forEach((i, k) => { for (const m of missingParts(d, d.slots[i])) red.push(`第 ${k + 1} 张「${m.p.text}」要拍${partOf(m.p)}特写，素材里没有${partOf(m.p)}的照片：补一张，或换个画法`); });
  // The long image writes its own line only with no square images; else it copies the cover's words.
  if (d.counts.long && !d.counts.square && len(d.long.title) > LIMITS.title) red.push(`长图大标题超过 ${LIMITS.title} 个字`);
  const warn = used.filter(i => notesOf(d, i, layout).length).map(i => used.indexOf(i) + 1);
  return { red, warn };
}

/* ---------- the two rounds and their price ---------- */

/** Does the set need the cast: an image with people, or a SKU image of a colour the material has no model photo of (`photos`). */
/** The plan's SKU images (sku-versions.ts), each colour by its key. */
export const skuItemsOf = (d: Pick<Draft, 'colors' | 'versions'>) => {
  const keys = colorKeys(d.colors);
  return skuItems(d, d.colors.flatMap((c, k) => keys[k] ? [{ name: c.name, sku: keys[k]! }] : []));
};
export const wantsCast = (d: Pick<Draft, 'category' | 'colors' | 'versions'>, layout: Layout, photos: Set<string>) =>
  needsCast(layout, categoryById(d.category).tasks) || (!!layout.sku.specCard && skuItemsOf(d).some(i => !photos.has(i.key)));

/** The label's mark on a carried-over image. */
const REUSED = '（沿用）';
export type ImageItem = { slot: string; label: string; ratio?: Ratio; round: 1 | 2; multi: boolean; free: boolean; person: boolean };
/**
 * What is made. Round one, at 「开始出图」: each colour's white-background image (free when the
 * colour's own clean still life is used as it is), the cast when any image has people, each
 * colour's SKU image and the square images. Round two, at 「出竖版」: the 3:4 images (no more than
 * the square ones: each is written from its square image) and the 2:3 long image. Extra sets add a
 * cover in another colour to each round. SKU images on the template show each colour on a model:
 * the material's own photo (`photos`, by colour image label), else the cast's model drawn in it (paid).
 * `reused`: white images and the cast a copy carries over (free, not made again).
 */
export function draftImages(d: Draft, layout: Layout, direct: Set<string>, photos: Set<string> = new Set(), reused: Set<string> = new Set()): ImageItem[] {
  const colors = colorKeys(d.colors).filter((k): k is string => !!k);
  // On the template, one SKU image per colour and version (sku-versions.ts); before, one per colour.
  const skus = layout.sku.specCard ? skuItemsOf(d).map(i => i.key) : colors, drawn = layout.sku.specCard ? skus.filter(k => !photos.has(k)) : [];
  const items: ImageItem[] = [];
  const own = (slot: string, label: string, free = false): ImageItem => reused.has(slot) ? { slot, label: `${label}${REUSED}`, round: 1, multi: false, free: true, person: false } : { slot, label, round: 1, multi: false, free, person: false };
  for (const k of colors) items.push(own(`product:${k}`, '白底产品图', direct.has(k)));
  if (wantsCast(d, layout, photos)) {
    if (castFromPhotos(d.model)) for (const g of GENDERS) items.push(own(`cast:${g}`, '模特定妆照'));
    else items.push(own('cast', '模特定妆照'));
  }
  for (const k of drawn) items.push({ slot: `skumodel:${k}`, label: 'SKU 模特图', round: 1, multi: false, free: false, person: true });
  for (const k of skus) items.push({ slot: `sku:${k}`, label: 'SKU 图', round: 1, multi: false, free: !!layout.sku.specCard, person: layout.sku.people > 0 || !!layout.sku.specCard });
  const add = (ratio: 'square' | 'portrait', n: number, round: 1 | 2) => usedSlots(d, n).forEach((i, k) => {
    const s = d.slots[i];
    const kept = ratio === 'square' && !!s.shopService;
    items.push({ slot: `${ratio}:${k + 1}`, label: kept ? '店铺服务图（已存）' : ratio === 'square' ? '1:1 主图' : '3:4 主图', ratio, round, multi: s.colors.length > 1, free: kept, person: layout.templates[s.task][ratio].people > 0 });
  });
  add('square', d.counts.square, 1);
  add('portrait', Math.min(d.counts.portrait, d.counts.square), 2);
  if (d.counts.long) items.push({ slot: 'long:1', label: '2:3 长图', ratio: 'long', round: 2, multi: false, free: false, person: layout.long.people > 0 });
  for (const e of d.extra) {
    if (d.counts.square) items.push({ slot: `square:1+${e.color}`, label: `加一套首图 · ${e.color}`, ratio: 'square', round: 1, multi: false, free: false, person: true });
    if (d.counts.portrait) items.push({ slot: `portrait:1+${e.color}`, label: `加一套首图 · ${e.color}`, ratio: 'portrait', round: 2, multi: false, free: false, person: true });
    if (d.counts.long) items.push({ slot: `long:1+${e.color}`, label: `加一套首图 · ${e.color}`, ratio: 'long', round: 2, multi: false, free: false, person: true });
  }
  return items;
}

export type PriceLine = { label: string; count: number; unit: number; credits: number; note: string };
export function priceLines(items: ImageItem[], unit: number, multiUnit: number): PriceLine[] {
  const lines: PriceLine[] = [];
  const add = (label: string, price: number, note: string) => {
    // Same note too: on a free account every price is 0, and redrawn images must not read as used as they are.
    const line = lines.find(l => l.label === label && l.unit === price && l.note === note);
    if (line) { line.count++; line.credits += price; } else lines.push({ label, count: 1, unit: price, credits: price, note });
  };
  for (const it of items) {
    if (it.free) add(it.label, 0, it.label.endsWith(REUSED) ? '同一份素材上一套出过，直接用，不收费' : it.label === '店铺服务图（已存）' ? '店铺存好的，直接用' : it.label === 'SKU 图' ? '按模板拼：换颜色、字和模特图，不收费' : '直接用你的静物图，不收费');
    else if (it.multi) add(`${it.label}（多色同框）`, multiUnit, '');
    else add(it.label, unit, it.slot.startsWith('cast') ? (it.slot === 'cast' ? '后面有人的图都照它画，保证是同一个人' : '照素材里的模特，男女各画一张更像')
      : it.slot.startsWith('product') ? '从衣服图提取' : it.slot.startsWith('skumodel') ? '素材里没有这个颜色的模特图，照定妆照里的模特穿上这个颜色' : '');
  }
  return lines;
}
export const sumCredits = (lines: PriceLine[]) => lines.reduce((n, l) => n + l.credits, 0);

/**
 * A clean front still life or render of the garment, without a logo, on white, is the product image as
 * it is (`plain` false: in a scene, 10-18; material sorted before 10-19 is not marked).
 */
export const usableAsIs = (image: { kind: string; front: boolean; logo: boolean; plain?: boolean } | undefined) => !!image && (image.kind === '静物' || image.kind === '3D渲染') && image.front && !image.logo && image.plain !== false;
/** The colours (by key, colorKeys) whose own clean still life is their white-background image as it is; never a photo of several garments. */
export function directKeys(colors: { pick: string | null }[], images: (PickSource & { kind: string; front: boolean; logo: boolean; plain?: boolean })[]): string[] {
  const byId = new Map(images.map(i => [i.id, i])), keys = colorKeys(colors);
  const shared = (pick: string) => colors.filter(c => c.pick === pick).length > 1;
  return colors.flatMap((c, k) => c.pick && usableAsIs(byId.get(c.pick)) && !isGroup(byId.get(c.pick)) && !shared(c.pick) ? [keys[k]!] : []);
}

/* ---------- the starting plan ---------- */

/** The AI's material as the first plan: points ranked and grouped, images filled, colours assigned. */
/** Mark a point the user must show (ticking it) and put it on an image now; unmarking leaves the images as they are. */
export function markMust(d: Draft, id: string, must: boolean, layout: Layout): Draft {
  const next: Draft = { ...d, points: d.points.map(p => p.id === id ? { ...p, must, on: must || p.on } : p) };
  const p = next.points.find(x => x.id === id);
  if (!must || !p) return next;
  const used = usedSlots(next, next.counts.square);
  if (shownOn(used.map(i => next.slots[i]), p)) return next;
  return { ...next, slots: squeezeIn(next.slots, p, next.points, categoryById(next.category), layout, used) };
}
export function defaultDraft(m: MaterialsForPlan, layout: Layout, counts: Counts = DEFAULT_COUNTS): Draft {
  const category = categoryById(m.category);
  const colors = m.colors.map(c => ({ name: c.name, hex: c.hex, pick: c.pick }));
  const ok = colors.filter(c => c.pick), main = ok[0]?.name ?? colors[0]?.name ?? '';
  const points = reviewPoints(m, category), titles = m.titles ?? {};
  const { slots, long } = planSlots(points, category, layout, ok.map(c => c.name), titles);
  const d: Draft = { category: category.id, categoryWhy: m.categoryWhy ?? '', titles, points, colors, main, parts: m.parts.map(p => ({ part: p.part, pick: p.pick })), slots, long, layout: layout.id,
    counts: { ...counts, portrait: Math.min(counts.portrait, counts.square) }, extra: [], model: { lead: '男' } };
  return { ...d, slots: colorize(d, layout) };
}
/** Fill every image again from the ticked points (and this layout); colours the user chose stay. */
export function replan(d: Draft, layout: Layout): Draft {
  const { slots, long } = planSlots(d.points, categoryById(d.category), layout, d.colors.filter(c => c.pick).map(c => c.name), d.titles);
  const kept = slots.map((s, i) => d.slots[i]?.manual && d.slots[i].task === s.task ? { ...s, colors: d.slots[i].colors, manual: true } : s);
  const next = { ...d, layout: layout.id, long };
  return { ...next, slots: colorize(next, layout, kept) };
}
