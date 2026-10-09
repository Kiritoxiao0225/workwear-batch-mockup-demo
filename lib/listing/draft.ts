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
import { categoryById, groupOf, evidenceOf, type Category, type PointGroup, type PointType, type Task } from './category';
import { proofById, type Proof } from './proofs';
import { capacity, fitTemplate, needsCast, type Layout, type Ratio, type Template } from './templates';

/** A point as the AI read it from the material: `text` and `note` are the material's own words. */
export type SortedPoint = { text: string; note?: string; type: string; concept?: string | null; proof?: string; part?: string; why?: string; from: string[] };
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
};
/** One card or icon of an image: a point and the way it is drawn. Its words are the point's. */
export type Cell = { point: string; proof: string };
export type Slot = {
  task: Task; lead: string | null; title: string; sub: string; tags: string[]; cells: Cell[];
  /** The way the model demonstrates the lead point, when the image has a person. */
  act: string | null; colors: string[]; manual?: boolean; why?: string;
  /** The shop's kept service image used as it is ("A-dark"): nothing to write, nothing to pay for the square one. */
  shopService?: string;
  /** How much the image says: the sum of its points' weight; fewer images keep the heaviest. */
  score: number;
};
export type PlanColor = { name: string; hex: string; pick: string | null };
export type Part = { part: string; pick: string | null };
export type Counts = { square: number; portrait: number; long: number };
export type Model = { lead: '男' | '女' };
export type Draft = {
  category: string; categoryWhy: string; titles: Partial<Record<Task, string[]>>; points: Point[]; colors: PlanColor[]; main: string; parts: Part[];
  slots: Slot[]; long: { title: string }; layout: string; counts: Counts; extra: { color: string; layout: string }[]; model: Model;
};

export const LIMITS = { title: 20, sub: 30, tag: 12, cell: 12 } as const;
export const DEFAULT_COUNTS: Counts = { square: 5, portrait: 5, long: 1 };
export const FRONT = '正面全身';
const len = (s: string) => [...s.trim()].length;
/** Several points in one ("防水、透气、耐磨"): fine as a tag, breaks into lines as a big title. */
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
    return {
      id: `m${i + 1}`, text: p.text.trim(), note: (p.note ?? '').trim(), type, concept, group: type === '定位' ? '定位' : groupOf(c), source: '素材',
      kind: type === '服务定制' ? '服务' : '衣服', on: true, proof: p.proof && proofById(p.proof) ? p.proof : defaultProof(type, c?.proofs), part: p.part ?? '',
      why: p.why ?? '', evidence: evidenceOf(c, category), from: p.from, score: type === '定位' ? 2 : 0.6 * (1 - i / Math.max(1, m.points.length)) + 0.4 * market(concept),
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
  const proof = proofById(point.proof);
  if (proof && (!proof.person || template.people > 0)) return point.proof;
  return proofsFor(point, category).find(p => !p.person)?.id ?? 'icon-text';
}

/* ---------- the images ---------- */

const BUCKET: Partial<Record<PointType, Task>> = { 功能: '功能', 面料: '功能', 做工: '细节', 实用: '实用', 服务定制: '服务' };
/** The image a point of this type belongs on in this category. */
export const taskFor = (type: PointType, tasks: Task[]): Task | undefined => {
  const t = BUCKET[type];
  return t === '实用' && !tasks.includes('实用') ? '细节' : t && tasks.includes(t) ? t : undefined;
};
/** An image of this kind is made only with at least this many points for it. */
const ENOUGH: Partial<Record<Task, number>> = { 功能: 1, 细节: 2, 服务: 3, 实用: 1 };
/** Equal amounts: features before close-ups before the service image. */
const PREFER: Task[] = ['功能', '细节', '服务', '实用'];
const CLOSER: PointType[] = ['人群场景', '颜色款式'];
const MIDDLE = 3;

/**
 * The images the ticked points fill. The cover leads with the positioning point and the strongest
 * points as tags (at most one of the product's own). Three middle images go, one at a time, to the
 * kind with the most points still to show that has enough for an image (a second feature image
 * when there are many features; no service image for one or two service points); left over room
 * shows the garment worn at work. Each image takes as many cards as it has points (up to the
 * layout's), its heading from the AI's, its sub-line from the lead point. The closer counts the
 * colours. Shown in the category's order.
 */
export function planSlots(points: Point[], category: Category, layout: Layout, colorNames: string[], titles: Draft['titles'] = {}): { slots: Slot[]; long: Draft['long'] } {
  const on = rank(points.filter(p => p.on)), tasks = category.tasks;
  const coverT = layout.templates.首图.square;
  const cover = on.find(p => p.type === '定位') ?? on[0];
  const coverTags: Point[] = [];
  for (const p of on) {
    if (coverTags.length >= capacity(coverT).tags) break;
    if (p === cover || p.type === '定位' || CLOSER.includes(p.type) || isList(p.text) || len(p.text) > LIMITS.tag) continue;
    if (p.group === '独有' && coverTags.some(t => t.group === '独有')) continue;
    coverTags.push(p);
  }
  const left = new Map<Task, Point[]>();
  for (const p of on) { const t = p === cover ? undefined : taskFor(p.type, tasks); if (t) left.set(t, [...(left.get(t) ?? []), p]); }
  const seen = new Map<Task, number>();
  const heading = (task: Task, fallback: string) => { const k = seen.get(task) ?? 0; seen.set(task, k + 1); return titles[task]?.[k] ?? fallback; };
  const middle: Slot[] = [];
  while (middle.length < MIDDLE) {
    // A second image of one kind needs one point more than the first.
    const ok = PREFER.filter(t => (left.get(t)?.length ?? 0) >= (ENOUGH[t] ?? 1) + (middle.some(m => m.task === t) ? 1 : 0) && !(t === '服务' && middle.some(m => m.task === '服务')));
    if (!ok.length) break;
    const task = ok.sort((a, b) => left.get(b)!.length - left.get(a)!.length || PREFER.indexOf(a) - PREFER.indexOf(b))[0];
    const t = layout.templates[task].square, room = capacity(t), list = left.get(task)!;
    const lead = list.find(p => !isList(p.text)) ?? list[0];
    const act = room.person ? proofsFor(lead, category).find(p => p.person)?.id ?? null : null;
    const inCells = act ? list.filter(p => p !== lead) : list;
    const cells = inCells.slice(0, room.cells).map(p => ({ point: p.id, proof: fitProof(p, t, category) }));
    const tags = list.filter(p => p !== lead && !cells.some(c => c.point === p.id)).slice(0, room.tags);
    const used = [lead, ...inCells.slice(0, room.cells), ...tags];
    left.set(task, list.filter(p => !used.includes(p)));
    middle.push({ task, lead: lead.id, title: heading(task, lead.text), sub: lead.note, tags: tags.map(p => p.text), cells, act, colors: [], score: used.reduce((n, p) => n + p.score, 0) });
  }
  const closer = on.filter(p => CLOSER.includes(p.type));
  // Who wears it (物业、工厂、4S 店) goes on the scene image unless the closer takes it.
  const crowd = on.filter(p => p.type === '人群场景' && p !== closer[0]);
  while (middle.length < MIDDLE) middle.push({ task: '场景', lead: null, title: heading('场景', crowd[0]?.text ?? ''), sub: crowd[0]?.text ?? '', tags: [], cells: [], act: null, colors: [], score: 0 });
  middle.sort((a, b) => tasks.indexOf(a.task) - tasks.indexOf(b.task));
  const last: Slot = colorNames.length > 1
    ? { task: '收口', lead: null, title: `${colorNames.length}色可选`, sub: closer[0]?.text ?? '', tags: [], cells: [], act: null, colors: [], score: 0 }
    : { task: '收口', lead: closer[0]?.id ?? null, title: closer[0]?.text ?? '', sub: closer[0]?.note ?? '', tags: closer.slice(1, 2).map(p => p.text), cells: [], act: null, colors: [], score: 0 };
  const first: Slot = { task: '首图', lead: cover?.id ?? null, title: cover?.text ?? '', sub: cover?.note ?? '', tags: coverTags.map(p => p.text), cells: [], act: null, colors: [], score: 99 };
  return { slots: [first, ...middle, last], long: { title: cover?.text ?? '' } };
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
    if (s.task === '首图') add(s.lead, `${n}大标题`);
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
    const s = d.slots[i], base = layout.templates[s.task].square, room = capacity(base), mine = s.task === own, n = `第 ${k + 1} 张`;
    const setSlot = (patch: Partial<Slot>) => (x: Draft) => ({ ...x, slots: x.slots.map((y, m) => m === i ? { ...y, ...patch } : y) });
    const cell = { point: p.id, proof: fitProof(p, base, category) };
    if (room.cells > s.cells.length) places.push({ slot: i, label: `${n} · 加一格`, mine, empty: true, apply: setSlot({ cells: [...s.cells, cell] }) });
    if (room.tags > s.tags.length) places.push({ slot: i, label: `${n} · 加成标签`, mine, empty: true, apply: setSlot({ tags: [...s.tags, p.text] }) });
    s.cells.forEach((c, m) => places.push({ slot: i, label: `${n} · 换掉格 ${m + 1}「${d.points.find(x => x.id === c.point)?.text ?? ''}」`, mine, empty: false, apply: setSlot({ cells: s.cells.map((y, j) => j === m ? cell : y) }) }));
    s.tags.forEach((t, m) => places.push({ slot: i, label: `${n} · 换掉标签「${t}」`, mine, empty: false, apply: setSlot({ tags: s.tags.map((y, j) => j === m ? p.text : y) }) }));
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
export const partOf = (p: Pick<Point, 'part' | 'text'>) => p.part || p.text;
const hasPart = (d: Pick<Draft, 'parts'>, part: string) => d.parts.some(x => x.pick && (x.part === part || part.includes(x.part) || x.part.includes(part)));
/**
 * Close-ups of parts the structure images do not have yet, found in the sorted material: a cell
 * showing 袖口 brings the material's own cuff close-up into the structure images.
 */
export function fillParts(d: Draft, images: { id: string; detail: string; same?: string }[]): Draft {
  let parts = d.parts;
  for (const s of d.slots) for (const c of s.cells) {
    const p = d.points.find(x => x.id === c.point);
    if (!p || !proofById(c.proof)?.part) continue;
    const part = partOf(p);
    if (hasPart({ parts }, part)) continue;
    const found = images.find(i => !i.same && i.detail && (i.detail === part || part.includes(i.detail) || i.detail.includes(part)));
    if (found) parts = [...parts.filter(x => x.part !== part), { part, pick: found.id }];
  }
  return parts === d.parts ? d : { ...d, parts };
}
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
    const mid = byL.filter(c => !picked.includes(c)).sort((a, b) => Number(nearMain(a)) - Number(nearMain(b)) || Math.abs(L(a) - 0.3) - Math.abs(L(b) - 0.3))[0];
    if (mid) picked.push(mid);
    out[last] = { ...out[last], colors: [main, ...picked].slice(0, 4), why: others.length ? '主推色加深、浅、中间色各一个' : '只有一个颜色' };
  }
  out.forEach((s, i) => { if (i > 0 && s.manual) s.why = '你选的'; });
  return out;
}
export const colorize = (d: Draft, layout: Layout, slots = d.slots) => assignColors(slots, d.colors.filter(c => c.pick), d.main, s => showsGarment(layout, s.task));

/** After colours were added or dropped, the closer still says how many there are. */
export const syncCloser = (slot: Slot, colorNames: string[]): Slot =>
  /^\d+色可选$/.test(slot.title) && colorNames.length > 1 ? { ...slot, title: `${colorNames.length}色可选` } : slot;

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
    if (proof.part && !hasPart(d, partOf(p))) notes.push(`「${p.text}」要拍${partOf(p)}的特写，可素材里没有${partOf(p)}的照片：换个画法，或者补传一张`);
    if (proof.person && !t.people) notes.push(`「${p.text}」的画法要有人，这张图没有人：换个画法`);
  }
  return notes;
}

/** Red: generating is refused until fixed. Yellow: the images (by number) worth a second look. */
export function checkDraft(d: Draft, layout: Layout) {
  const live = d.colors.filter(c => c.pick);
  const red = [
    ...d.colors.filter(c => !c.pick).map(c => `「${c.name}」没有衣服图：补传一张，或者不要这个颜色`),
    ...(d.parts.find(p => p.part === FRONT)?.pick ? [] : ['缺正面全身图：补传一张']),
    ...(d.parts.some(p => !p.part.trim()) ? ['有衣服部位没写名字'] : []),
    ...(live.length ? [] : ['没有颜色了：至少留一个']),
  ];
  const used = usedSlots(d, d.counts.square);
  used.forEach((i, k) => { const s = d.slots[i], long = overLimit({ ...s, cells: cellWords(d, s) }); if (long) red.push(`第 ${k + 1} 张${long}`); });
  if (d.counts.long && len(d.long.title) > LIMITS.title) red.push(`长图大标题超过 ${LIMITS.title} 个字`);
  const warn = used.filter(i => notesOf(d, i, layout).length).map(i => used.indexOf(i) + 1);
  return { red, warn };
}

/* ---------- the two rounds and their price ---------- */

export type ImageItem = { slot: string; label: string; ratio?: Ratio; round: 1 | 2; multi: boolean; free: boolean; person: boolean };
/**
 * What is made. Round one, at 「开始出图」: each colour's white-background image (free when the
 * colour's own clean still life is used as it is), the cast when any image has people, each
 * colour's SKU image and the square images. Round two, at 「出竖版」: the 3:4 images (no more than
 * the square ones: each is written from its square image) and the 2:3 long image. Extra sets add a
 * cover in another colour to each round.
 */
export function draftImages(d: Draft, layout: Layout, direct: Set<string>): ImageItem[] {
  const colors = d.colors.filter(c => c.pick), tasks = categoryById(d.category).tasks;
  const items: ImageItem[] = [];
  for (const c of colors) items.push({ slot: `product:${c.pick}`, label: '白底产品图', round: 1, multi: false, free: direct.has(c.pick!), person: false });
  if (needsCast(layout, tasks)) items.push({ slot: 'cast', label: '模特定妆照', round: 1, multi: false, free: false, person: false });
  for (const c of colors) items.push({ slot: `sku:${c.pick}`, label: 'SKU 图', round: 1, multi: false, free: false, person: layout.sku.people > 0 });
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
    const line = lines.find(l => l.label === label && l.unit === price);
    if (line) { line.count++; line.credits += price; } else lines.push({ label, count: 1, unit: price, credits: price, note });
  };
  for (const it of items) {
    if (it.free) add(it.label, 0, it.label === '店铺服务图（已存）' ? '店铺存好的，直接用' : '直接用你的静物图，不收费');
    else if (it.multi) add(`${it.label}（多色同框）`, multiUnit, '');
    else add(it.label, unit, it.slot === 'cast' ? '后面有人的图都照它画，保证是同一个人' : it.slot.startsWith('product') ? '从衣服图提取' : '');
  }
  return lines;
}
export const sumCredits = (lines: PriceLine[]) => lines.reduce((n, l) => n + l.credits, 0);

/** A clean front still life or render of the garment, without a logo, is the product image as it is. */
export const usableAsIs = (image: { kind: string; front: boolean; logo: boolean } | undefined) => !!image && (image.kind === '静物' || image.kind === '3D渲染') && image.front && !image.logo;

/* ---------- the starting plan ---------- */

/** The AI's material as the first plan: points ranked and grouped, images filled, colours assigned. */
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
