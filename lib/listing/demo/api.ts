/**
 * The local demo's /api/listing: fixed products at each stage, answered in the shapes the server
 * will answer in, with timers standing in for the model. Images are the house test garment's real
 * results (public/listing-demo, built by output/listing-redesign-20261008/build-demo-assets.mjs);
 * images never made yet are grey tiles that say 演示占位. Nothing is paid, nothing is stored.
 */
import type { CanvasEdit, Config, Detail, Element, LearnState, Materials, SlotState, Source, Summary, Words } from '../api-types';
import { categoryById } from '../category';
import { defaultDraft, usedSlots, type Draft } from '../draft';
import type { Task } from '../category';
import { BUILT_IN_LAYOUTS, FLAT_EXAMPLE, withPeople, type Layout, type People, type Display } from '../templates';
import { defaultShop, pendingOf, SERVICE_IMAGES, wordsFor, type ServiceImageId, type ShopService } from '../service';
import { DEMO_MATERIAL } from './material';

const COLORS = DEMO_MATERIAL.colors.map(c => c.name);
const FLAT: Layout = { ...FLAT_EXAMPLE, id: 'flat-demo', samples: ['/listing-demo/flat1.jpg', '/listing-demo/flat2.jpg', '/listing-demo/flat3.jpg'] };
const layouts: (Layout & { own: boolean })[] = [...BUILT_IN_LAYOUTS.map(l => ({ ...l, own: false })), { ...FLAT, own: true, by: '大俊', createdAt: '2026-10-08T03:00:00Z' }];
const layoutOf = (id: string) => layouts.find(l => l.id === id) ?? layouts[0];

/* ---------- the material ---------- */

const img = (id: string, kind: string, color = '', extra: Partial<Materials['sorted']['images'][number]> = {}) => ({ id, kind, color, front: false, detail: '', text: false, logo: false, same: '', ...extra });
const MATERIALS: Materials = {
  category: 'workwear', categoryWhy: DEMO_MATERIAL.categoryWhy, checks: DEMO_MATERIAL.checks, titles: DEMO_MATERIAL.titles,
  sorted: {
    images: [
      ...[1, 2, 3, 4, 5].map(i => img(`M${i}`, '卖点图', '落霞橙', { text: true, front: i === 1 })),
      ...[6, 7, 8].map(i => img(`M${i}`, '卖点图', '落霞橙', { text: true })),
      ...COLORS.map((c, i) => img(`M2${i}`, '颜色款图', c, { front: true, text: true })),
      ...COLORS.map((c, i) => img(`M3${i}`, '静物', c, { front: true })),
      img('M40', '细节特写', '落霞橙', { detail: '立领' }), img('M41', '细节特写', '落霞橙', { detail: '门襟拉链' }), img('M42', '细节特写', '落霞橙', { detail: '口袋' }),
      img('M43', '细节特写', '落霞橙', { detail: '袖口' }), img('M44', '细节特写', '落霞橙', { detail: '面料' }),
      img('M50', '模特实拍', '', { person: '男', face: true }), img('M51', '模特实拍', '爱马仕橙', { person: '女', face: true }),
      img('M52', '模特实拍', '', { person: '男女', face: true }), img('M53', '模特实拍', '', { person: '女', face: false }),
    ],
    colors: DEMO_MATERIAL.colors.map((c, i) => ({ name: c.name, hex: c.hex, from: [`M2${i}`, `M3${i}`] })),
    points: DEMO_MATERIAL.points,
    notes: ['袖口有一张特写（M43），但 AI 没把它放进结构图：细节图要拍袖口的话，在第 ① 步加上'],
  },
  chosen: {
    colors: DEMO_MATERIAL.colors.map((c, i) => ({ ...c, candidates: [`M3${i}`, `M2${i}`] })),
    parts: DEMO_MATERIAL.parts.map(p => ({ ...p, candidates: p.part === '正面全身' ? ['M30', 'M20', 'M1'] : [p.pick!] })),
  },
  duplicates: [['M8', 'M3']],
  images: [...[1, 2, 3, 4, 5, 6, 7, 8], ...[20, 21, 22, 23, 24, 25], ...[30, 31, 32, 33, 34, 35], ...[40, 41, 42, 43, 44], ...[50, 51, 52, 53]].map(n => ({ label: `M${n}`, assetId: `M${n}.jpg` })),
};
const SOURCES: Source[] = MATERIALS.images.map(i => ({ id: i.assetId, label: i.label, name: i.assetId, path: `素材/${i.label}.jpg`, shape: Number(i.label.slice(1)) >= 6 && Number(i.label.slice(1)) <= 8 ? '3:4' : '1:1' }));

/* ---------- products ---------- */

type Project = Detail;
const now = Date.now(), iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const picks = MATERIALS.chosen.colors.map(c => c.pick!);
/** The plan's image behind a main image's key: "square:2" is the second square image made. */
function slotOf(d: Draft, slot: string) {
  const [kind, key] = slot.split(':'), n = Number(key?.split('+')[0]);
  return d.slots[usedSlots(d, kind === 'portrait' ? Math.min(d.counts.portrait, d.counts.square) : d.counts.square)[n - 1]];
}
const FILES: Record<'square' | 'portrait' | 'flat', Partial<Record<Task, string>>> = {
  square: { 首图: 'sq1.jpg', 服务: 'sq2.jpg', 功能: 'sq3.jpg', 细节: 'sq4.jpg', 实用: 'sq6.jpg', 场景: 'sq6.jpg', 收口: 'sq5.jpg' },
  portrait: { 首图: 'pt1.jpg', 服务: 'pt2.jpg', 功能: 'pt3.jpg', 细节: 'pt4.jpg', 实用: 'pt6.jpg', 场景: 'pt6.jpg', 收口: 'pt5.jpg' },
  flat: { 首图: 'flat1.jpg', 功能: 'flat2.jpg', 细节: 'flat3.jpg', 服务: 'sq2.jpg' },
};
const MASTER_FILE: Partial<Record<Task, number>> = { 首图: 1, 服务: 2, 功能: 3, 细节: 4, 收口: 5 };
/** What 「点图修改」 gives back in the demo: another real image where we have one, else the same one again. */
const REDRAWN: Record<string, string> = { '/listing-demo/service/A-light.jpg': 'service/A-light-1.jpg', '/listing-demo/service/A-dark.jpg': 'service/A-dark-1.jpg', '/listing-images/masters/M3-1.jpg': 'm/M3-1b.jpg', '/listing-images/masters/M3-3.jpg': 'm/M3-3b.jpg', '/listing-images/masters/M3-4.jpg': 'm/M3-4b.jpg', '/listing-images/masters/M3-5.jpg': 'm/M3-5b.jpg' };
/** The file each made image is shown with; versions add "#vN" so each is its own image. */
function fileOf(d: Draft, slot: string, layout: string) {
  const [kind, key] = slot.split(':');
  if (kind === 'product') return `product${picks.indexOf(key) + 1}.jpg`;
  if (kind === 'sku') return `sku${picks.indexOf(key) + 1}.jpg`;
  if (kind === 'cast') return 'cast.jpg';
  if (kind === 'long') return 'long1.jpg';
  const task = slotOf(d, slot)?.task ?? '首图', shape = kind === 'portrait' ? 'portrait' : 'square';
  // The masters' square images are the samples we made with the same orange jacket.
  if (/^M\d$/.test(layout) && shape === 'square' && MASTER_FILE[task]) return `/listing-images/masters/${layout}-${MASTER_FILE[task]}.jpg`;
  return (layout === 'flat-demo' && shape === 'square' ? FILES.flat[task] ?? 'flat2.jpg' : FILES[shape][task]) ?? 'sq6.jpg';
}
const wordsOf = (d: Draft, slot: string): Words | null => {
  const kind = slot.split(':')[0];
  if (kind === 'long') return { title: d.long.title, sub: '', tags: [], cells: [] };
  if (kind !== 'square' && kind !== 'portrait') return null;
  const s = slotOf(d, slot);
  return s ? { title: s.title, sub: s.sub, tags: s.tags, cells: s.cells.map(c => ({ ...c, caption: d.points.find(p => p.id === c.point)?.text ?? '' })) } : null;
};
function slotsOf(d: Draft, round: 1 | 2): string[] {
  const out: string[] = [];
  if (round === 1) {
    out.push(...picks.map(p => `product:${p}`), 'cast', ...picks.map(p => `sku:${p}`), ...usedSlots(d, d.counts.square).map((_, k) => `square:${k + 1}`));
    if (layoutOf(d.layout).id === 'flat-demo') out.splice(out.indexOf('cast'), 1);
  } else out.push(...usedSlots(d, Math.min(d.counts.portrait, d.counts.square)).map((_, k) => `portrait:${k + 1}`), ...(d.counts.long ? ['long:1'] : []));
  return out;
}
/** The words the demo's ready-made images really show (they were made before this plan). */
const SHOWN: Partial<Record<Task, Words>> = {
  功能: { title: '三防面料', sub: '防水防油防污 雨天更安心', tags: [], cells: [{ point: 'm3', proof: 'wipe-clean', caption: '水珠易擦净' }, { point: 'm4', proof: 'steam-cup', caption: '透气好活动' }] },
  细节: { title: '细节经得起看', sub: '领口、拉链、袖口逐一放大', tags: ['利落立领'], cells: [{ point: 'm6', proof: 'part', caption: '挺括有型' }, { point: 'm7', proof: 'part', caption: '顺滑拉链' }, { point: 'm9', proof: 'part', caption: '简洁袖口' }] },
};
/** Where things really are on the demo's ready-made images, as the server's recognition will say. */
const E = (id: string, kind: Element['kind'], box: Element['box'], text = '', zone?: string, label?: string): Element => ({ id, kind, box, ...(text ? { text } : {}), ...(zone ? { zone } : {}), ...(label ? { label } : {}) });
const ELEMENTS: Record<string, Element[]> = {
  'sq1.jpg': [E('p', 'person', [22, 1, 50, 73], '', 'person1'), E('t', 'title', [5, 73, 90, 16], '轻盈抗造工作服', 'title1'), E('g1', 'tag', [5, 89, 28, 6], '三防面料', 'tag1'), E('g2', 'tag', [35, 89, 34, 6], '透气好活动', 'tag2')],
  'sq3.jpg': [E('t', 'title', [4, 5, 38, 11], '三防面料', 'title1'), E('s', 'sub', [4, 17, 37, 5], '防水防油防污 雨天更安心', 'sub1'), E('c1', 'card', [4, 25, 32, 31], '水珠易擦净', 'card1'), E('c2', 'card', [4, 58, 32, 34], '透气好活动', 'card2'), E('p', 'person', [39, 0, 56, 100], '', 'person1')],
  'sq4.jpg': [E('t', 'title', [23, 1, 54, 10], '细节经得起看', 'title1'), E('s', 'sub', [30, 11, 40, 4], '领口、拉链、袖口逐一放大', 'sub1'), E('g', 'tag', [37, 15, 26, 5], '利落立领', 'tag1'),
    E('c1', 'card', [2, 20, 96, 38], '挺括有型', 'card1'), E('c2', 'card', [2, 59, 47, 38], '顺滑拉链', 'card2'), E('c3', 'card', [51, 59, 47, 38], '简洁袖口', 'card3')],
  'sq5.jpg': [E('t', 'title', [8, 1, 84, 11], '团队穿出同一范', 'title1'), E('s', 'sub', [29, 12, 40, 5], '男女同款，六色可选', 'sub1'), E('p', 'person', [3, 17, 94, 62], '', 'person1'), E('w', 'swatch', [5, 79, 90, 9], '落霞橙 · 未来白 · 黑色', 'swatch1'),
    E('o', 'other', [5, 88, 90, 11], '团体定制 · 多色可选 · 舒适透气 · 耐穿耐磨 · 三防面料 · 多场景适用', undefined, '一排图标（方案里没有，模型自己加的）')],
  'sq6.jpg': [E('t', 'title', [12, 1, 76, 15], '随身物件好收', 'title1'), E('p', 'person', [24, 9, 48, 62], '', 'person1'), E('o1', 'other', [3, 71, 47, 27], '', undefined, '口袋放大图'), E('o2', 'other', [52, 72, 46, 26], '双侧拉链口袋 · 随手可放 · 实用大容量', undefined, '三行要点')],
};
ELEMENTS['sq4-edit.jpg'] = ELEMENTS['sq4.jpg'].map(e => e.id === 'c3' ? { ...e, text: '水珠易擦净' } : e);
const elementsOf = (file: string) => ELEMENTS[file.split('#')[0]];
const made = (d: Draft, slot: string, layout: string): SlotState => {
  const id = fileOf(d, slot, layout), task = slot.startsWith('square') || slot.startsWith('portrait') ? slotOf(d, slot)?.task : undefined;
  const words = layout === 'M3' && task && SHOWN[task] ? SHOWN[task]! : wordsOf(d, slot);
  return { slot, status: 'succeeded', error: null, image: id, history: [{ id, words, elements: elementsOf(id) }], words, task };
};
function project(id: string, name: string, status: Project['status'], minAgo: number, round: Project['round'], layout = 'M3', own?: { materials: Materials; sources: Source[]; cover: string }): Project {
  const first = round ? defaultDraft(DEMO_MATERIAL, layoutOf(layout)) : null;
  // The plan says what the ready-made images show, so the 3:4 images follow them.
  const plan = first && layout === 'M3' ? { ...first, slots: first.slots.map(x => { const w = SHOWN[x.task]; return w ? { ...x, title: w.title, sub: w.sub, tags: w.tags, cells: w.cells.map(c => ({ point: c.point!, proof: c.proof })) } : x; }) } : first;
  const slots = plan ? [...slotsOf(plan, 1), ...(round === 2 ? slotsOf(plan, 2) : [])].map(s => made(plan, s, layout)) : [];
  return { id, name, layout, status, error: null, images: own ? own.sources.length : 37, cover: own?.cover ?? '/listing-demo/M30.jpg', slots, made: slots.length, broken: 0, created_at: iso(minAgo), updated_at: iso(minAgo),
    plan, materials: status === 'planning' || status === 'uploading' ? null : own?.materials ?? MATERIALS, sources: own?.sources ?? SOURCES, round };
}
const projects: Project[] = [
  project('demo-plan', 'M21#落霞橙三防工作服', 'materials', 12, 0),
  project('demo-square', 'M18#落霞橙三防工作服（方图已出）', 'square', 95, 1),
  project('demo-done', 'M15#三防立领工作服（全部出完）', 'done', 60 * 26, 2),
  project('demo-flat', 'M16#工作服·平铺版式（方图已出）', 'square', 60 * 3, 1, 'flat-demo'),
  project('demo-planning', 'M22#冲锋衣工装马甲', 'planning', 1, 0),
];
setTimeout(() => { const p = projects.find(x => x.id === 'demo-planning'); if (p?.status === 'planning') Object.assign(p, { status: 'materials', materials: MATERIALS }); }, 25_000);

/* ---------- the shop ---------- */

/** The shop's row, as on the server: its service images are the versions of its service:<id> slots. */
const SHOP_ID = 'demo-shop';
const start = defaultShop(['免费设计', '免费印绣', '一件起订', '现货速发']);
const shopSettings: Omit<ShopService, 'made'> = { items: start.items, crafts: start.crafts, logo: null, brand: null, corner: false };
projects.push({ ...project(SHOP_ID, '店铺服务图', 'done', 0, 0), slots: [] });
const madeAt = new Map<string, string>();
function shopState() {
  const shop = find(SHOP_ID), made: ShopService['made'] = {}, making: ServiceImageId[] = [];
  for (const def of SERVICE_IMAGES) {
    const s = shop.slots.find(x => x.slot === `service:${def.id}`);
    if (!s) continue;
    if (s.status === 'queued' || s.status === 'running') making.push(def.id);
    if (!s.image) continue;
    made[def.id] = { image: s.image, asset: s.image, words: s.words?.tags ?? [], madeAt: madeAt.get(s.image) ?? '',
      history: s.history.filter(v => v.id !== s.image && !v.job).reverse().map(v => ({ image: v.id, asset: v.id, madeAt: madeAt.get(v.id) ?? '' })) };
  }
  return { project: SHOP_ID, shop: { ...shopSettings, made }, making, failed: {} };
}
/** 「确认」: the images never made come out one by one; the others get their changed words redrawn (the same picture in the demo). */
function makeShop() {
  const shop = find(SHOP_ID), state = shopState(), pending = pendingOf(state.shop);
  const ids = [...pending.fresh.map(d => d.id), ...pending.stale.map(x => x.def.id)];
  ids.forEach((id, k) => {
    const slot = `service:${id}`, old = shop.slots.find(x => x.slot === slot);
    if (old) old.status = 'queued'; else shop.slots.push({ slot, status: 'queued', error: null, image: null, history: [], words: null });
    setTimeout(() => {
      const s = shop.slots.find(x => x.slot === slot)!, base = `/listing-demo/service/${id}.jpg`;
      const image = s.history.length ? `${base}#v${s.history.length + 1}` : base, words = { title: '', sub: '', tags: wordsFor(SERVICE_IMAGES.find(d => d.id === id)!, state.shop), cells: [] };
      madeAt.set(image, new Date().toISOString());
      Object.assign(s, { status: 'succeeded', image, words, history: [...s.history, { id: image, words }] });
    }, 1500 + k * 900);
  });
  return { images: ids.length };
}

const summary = (p: Project): Summary => {
  const slots = p.slots.length, ok = p.slots.filter(s => s.image).length, broken = p.slots.filter(s => s.status === 'failed').length;
  return { id: p.id, name: p.name, layout: p.layout, status: p.status, error: p.error, images: p.images, cover: p.cover, slots, made: ok, broken, created_at: p.created_at, updated_at: p.updated_at, round: p.round };
};
const find = (id: string) => { const p = projects.find(x => x.id === id); if (!p) throw new Error('商品不存在'); return p; };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Images queued for a round come out one by one, like the workers. */
function run(p: Project, slots: string[], after: () => void, change?: (s: SlotState) => Partial<SlotState>) {
  p.status = 'generating';
  for (const slot of slots) {
    const old = p.slots.find(s => s.slot === slot);
    if (old) Object.assign(old, { status: 'queued' }); else p.slots.push({ slot, status: 'queued', error: null, image: null, history: [], words: null });
  }
  let i = 0;
  const tick = setInterval(() => {
    const s = p.slots.find(x => x.slot === slots[i]);
    if (s) {
      const fresh = made(p.plan!, slots[i], p.layout), extra = change?.(s) ?? {};
      const id = s.history.length ? `${extra.image ?? fresh.image}#v${s.history.length + 1}` : fresh.image!;
      const version = extra.history?.[0];
      Object.assign(s, fresh, { image: id, history: [...s.history, { id, words: extra.words ?? fresh.words, change: version?.change, elements: version?.elements ?? elementsOf(id) }], words: extra.words ?? fresh.words });
    }
    if (++i >= slots.length) { clearInterval(tick); after(); }
  }, 450);
}

/* ---------- learning a layout ---------- */

const learning = new Map<string, LearnState & { refsCount: number }>();

/* ---------- the routes ---------- */

/** The demo's AI drawings in progress (local only). */
const draws = new Map<string, { status: string; asset: string | null }>();
export async function demoApi(path: string, init?: RequestInit): Promise<unknown> {
  await wait(150);
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
  const [a, id, action] = path.split('/');
  if (path === 'config') return { layouts, learning: [...learning.values()].filter(l => l.status !== 'saved').map(l => ({ id: l.id, name: l.name, status: l.status })), planCredits: 300, planCostMicro: 150000, planMultiplierMilli: 2000, imageCredits: 22, multiCredits: 36, layoutCredits: 100, exempt: false } satisfies Config;
  if (a === 'shop') {
    if (!id && method === 'POST') Object.assign(shopSettings, { items: body.items, crafts: body.crafts });
    if (id === 'logo') shopSettings.logo = URL.createObjectURL(init!.body as Blob);
    if (id === 'brand') shopSettings.brand = URL.createObjectURL(init!.body as Blob);
    if (id === 'corner') shopSettings.corner = !!body.on && !!shopSettings.brand;
    if (id === 'make') { await wait(400); return makeShop(); }
    return shopState();
  }
  if (a === 'projects') {
    if (!id) {
      if (method === 'POST') { projects.unshift({ ...project(body.id, body.name, 'uploading', 0, 0, body.layout), images: 0, materials: null }); return { id: body.id }; }
      return projects.filter(p => p.id !== SHOP_ID).map(summary);
    }
    const p = find(id);
    if (!action && method === 'DELETE') { projects.splice(projects.indexOf(p), 1); return {}; }
    if (!action) return { ...summary(p), plan: p.plan, materials: p.materials, slots: p.slots, sources: p.sources } satisfies Detail;
    if (action === 'images') { p.images++; return {}; }
    if (action === 'plan') { p.status = 'planning'; setTimeout(() => Object.assign(p, { status: 'materials', materials: MATERIALS }), 4000); return {}; }
    // Local demo only: an upload or a drawn liner joins the material, tagged as that liner worn alone (10-22).
    const addImage = (url: string, name: string, tag: Partial<Materials['sorted']['images'][number]>) => {
      const m = p.materials!, label = `X${m.images.filter(i => i.label.startsWith('X')).length + 1}`;
      m.images.push({ label, assetId: url });
      m.sorted.images.push({ id: label, kind: '颜色款图', color: '', front: true, detail: '', text: false, logo: false, same: '', person: '', face: false, ...tag });
      p.sources = [...(p.sources ?? []), { id: url, label, name, path: `补传/${name}`, shape: '1:1' }];
      return { label, url };
    };
    const header = (k: string) => { const h = init?.headers as Record<string, string> | undefined; return h?.[k] ? decodeURIComponent(h[k]) : ''; };
    if (action === 'extra') {
      const inner = header('x-liner-inner'), color = header('x-liner-color');
      return addImage(URL.createObjectURL(init!.body as Blob), header('x-file-name') || '补传.jpg', inner ? { kind: '模特实拍', role: '内胆', inner, innerColor: color, color, front: false } : {});
    }
    if (action === 'draw') {
      const job = `draw-${Date.now()}`, black = /黑/.test(String(body.prompt));
      draws.set(job, { status: 'running', asset: null });
      setTimeout(() => draws.set(job, { status: 'succeeded', asset: black ? '/listing-demo/lined/draw-black.jpg' : '/listing-demo/lined/draw-beige.jpg' }), 3500);
      return { job };
    }
    if (action === 'draws') { const d = draws.get(path.split('/')[3]); return { status: d?.status ?? 'failed', error: d ? null : '找不到', asset: d?.asset ?? null }; }
    if (action === 'adopt') return addImage(body.asset, 'AI 内胆图.jpg', { kind: '静物', role: '内胆', inner: body.inner, innerColor: body.color, color: body.color, front: false });
    if (action === 'start') {
      const d = body as Draft;
      p.plan = d; p.layout = d.layout; p.slots = []; p.round = 1;
      run(p, slotsOf(d, 1), () => { p.status = 'square'; });
      return { status: 'generating' };
    }
    if (action === 'verticals') {
      if (p.status !== 'square') throw new Error('方图出完才能出竖版');
      p.round = 2;
      run(p, slotsOf(p.plan!, 2), () => { p.status = 'done'; });
      return { status: 'generating' };
    }
    if (action === 'cast') {
      const people = p.slots.filter(s => s.slot === 'cast' || s.slot.startsWith('sku') || (s.slot.startsWith('square') && layoutOf(p.layout).templates[s.task!].square.people > 0)).map(s => s.slot);
      const back = p.status; run(p, people, () => { p.status = back; });
      return { images: people.length };
    }
    if (action === 'redo') { const back = p.status; run(p, [body.slot], () => { p.status = back; }); return { images: 1 }; }
    if (action === 'refs') return { asset: init?.body instanceof Blob ? URL.createObjectURL(init.body) : 'ref' };
    if (action === 'redraw') {
      const s = p.slots.find(x => x.slot === body.slot);
      if (!s?.image) throw new Error('这张还没出好');
      const job = crypto.randomUUID(), base = s.image.split('#')[0];
      s.redraw = { job, status: 'running', error: null };
      setTimeout(() => {
        const tried = s.history.filter(v => v.job).length, alt = REDRAWN[base];
        const id = `${alt && tried % 2 === 0 ? alt : base}#v${s.history.length + 1}`;
        s.history.push({ id, words: s.words, change: String(body.ask ?? ''), job, elements: elementsOf(id) });
        s.redraw = { job, status: 'succeeded', error: null };
      }, 3000);
      return { job };
    }
    if (action === 'current') { const s = p.slots.find(x => x.slot === body.slot)!; s.image = body.asset; s.words = s.history.find(v => v.id === body.asset)?.words ?? s.words; return {}; }
    if (action === 'sets') {
      p.plan = { ...p.plan!, extra: [...p.plan!.extra, { color: body.color, layout: body.layout }] };
      const back = p.status; run(p, [`square:1+${body.color}`, ...(back === 'done' ? [`portrait:1+${body.color}`, `long:1+${body.color}`] : [])], () => { p.status = back; });
      return { status: 'generating' };
    }
    if (action === 'edit') {
      const e = body as CanvasEdit, s = p.slots.find(x => x.slot === e.slot)!, back = p.status;
      const words = edited(s.words, e), change = describe(e);
      // Changes on a square image are what the 3:4 images are written from.
      const target = p.plan && e.slot.startsWith('square:') ? slotOf(p.plan, e.slot) : undefined;
      if (words && target && p.plan) p.plan = { ...p.plan, slots: p.plan.slots.map(x => x === target ? { ...x, title: words.title, sub: words.sub, tags: words.tags, cells: words.cells.filter(c => c.point).map(c => ({ point: c.point!, proof: c.proof })) } : x) };
      const file = target?.task === '细节' && e.mode === 'cell' ? 'sq4-edit.jpg' : undefined;
      // The new version keeps where things are; the edited one says its new words (or sits where it was moved).
      const before = s.history.find(v => v.id === e.base)?.elements ?? [];
      const point = e.point ? p.plan?.points.find(x => x.id === e.point)?.text : undefined;
      const elements = before.map(el => el.zone && el.zone === e.zone ? { ...el, ...(e.mode === 'move' && e.to ? { box: e.to } : {}), ...(e.mode === 'text' ? { text: e.text } : e.mode === 'cell' ? { text: e.caption ?? point ?? el.text } : {}) } : el);
      run(p, [e.slot], () => { p.status = back; }, () => ({ words: words ?? s.words, image: file, history: [{ id: '', words, change, elements }] }));
      return { images: 1 };
    }
  }
  if (a === 'layouts') {
    if (!id && method === 'POST') { learning.set(body.id, { id: body.id, name: body.name, status: 'uploading', error: null, layout: null, refs: [], samples: [], refsCount: 0 }); return { id: body.id }; }
    const l = learning.get(id);
    if (method === 'DELETE') { learning.delete(id); const k = layouts.findIndex(x => x.id === id && x.own); if (k >= 0) layouts.splice(k, 1); return {}; }
    if (!l) throw new Error('没有这个版式');
    if (action === 'refs') { l.refsCount++; return {}; }
    if (action === 'learn') {
      l.status = 'learning';
      setTimeout(() => Object.assign(l, { status: 'draft', layout: { ...FLAT, id: l.id, name: l.name }, samples: FLAT.samples }), 4000);
      return {};
    }
    if (action === 'save') {
      const people = (body.people ?? {}) as Record<string, { people: People; display?: Display }>;
      const base = l.layout!, templates = { ...base.templates };
      for (const [task, v] of Object.entries(people)) if (task in templates) {
        const t = templates[task as keyof typeof templates];
        templates[task as keyof typeof templates] = { square: withPeople(t.square, v.people, v.display), portrait: withPeople(t.portrait, v.people, v.display) };
      }
      layouts.push({ ...base, templates, own: true, by: '我', createdAt: new Date().toISOString() });
      l.status = 'saved';
      return {};
    }
    return l satisfies LearnState;
  }
  throw new Error(`演示页还没有这个接口：${path}`);
}

function edited(w: Words | null, e: CanvasEdit): Words | null {
  if (!w) return w;
  if (e.mode === 'cell' && e.zone) {
    const k = Number(e.zone.replace(/\D/g, '')) - 1, cardOrIcon = w.cells.map((c, i) => i === k ? { point: e.point ?? c.point, proof: e.proof ?? c.proof, caption: e.caption ?? c.caption } : c);
    return { ...w, cells: cardOrIcon };
  }
  if (e.mode === 'text' && e.zone) {
    const text = e.text ?? '';
    if (e.zone.startsWith('title')) return { ...w, title: text };
    if (e.zone.startsWith('sub')) return { ...w, sub: text };
    if (e.zone.startsWith('tag')) { const k = Number(e.zone.slice(3)) - 1, tags = [...w.tags]; tags[k] = text; return { ...w, tags: tags.filter(Boolean) }; }
  }
  return w;
}
const describe = (e: CanvasEdit) => e.mode === 'cell' ? '换了一格' : e.mode === 'text' ? `改字：${e.text}` : e.mode === 'move' ? '挪了位置' : `重画了一块：${e.request ?? ''}`;
export const demoCategory = () => categoryById(MATERIALS.category);
