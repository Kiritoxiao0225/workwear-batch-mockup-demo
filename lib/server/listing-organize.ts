/**
 * 电商主图, step one for a raw product folder: the model sorts every image (kind, colour, whether
 * the whole garment is shown from the front, which detail it shows, whether it carries selling
 * text, which other image it copies), lists the colours and the selling points with their
 * sources, each point with its own explanation from the material. The program then picks one
 * image per colour and the structure references (full front view, collar, zip and cuffs, pocket,
 * fabric, back); lib/listing/plan.ts shares the points out over the images.
 */
import { z } from 'zod';
import { CATEGORIES, TASKS, type Category } from '../listing/category';
import { PROOFS } from '../listing/proofs';
import { MASTER_INFO, PLACE_IDS, PLACES, SELLS, type PlaceId, type Sell } from '../listing/scene';
import { BUILT_IN_LAYOUTS } from '../listing/templates';
import type { PlanView } from './listing-plan-views';

export const MATERIAL_KINDS = ['颜色款图', '静物', '3D渲染', '模特实拍', '细节特写', '卖点图', '详情页', '海报', '尺码表', '无关'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];
/** The whole garment seen from the front; the other structure parts are named after what the garment has. */
export const FRONT = '正面全身';
/** At most this many close-up parts are offered, plus the back view; the user may add more. */
const MAX_PARTS = 8;

const ROLE = '你是淘宝服装店的素材整理员。';
/** Every image's rules: kind, colour, front, part, words, LOGO, people, face, copies. */
const IMAGE_RULES = `每张图（images，一张不漏，按编号）：
- kind：颜色款图（用来区分颜色款的图，通常一个颜色一张、带颜色名）/ 静物（平铺、挂拍、人台、白底产品图）/ 3D渲染 / 模特实拍（没有加文字的模特照片）/ 细节特写（局部近拍）/ 卖点图（做好的主图或营销图，上面有卖点文字）/ 详情页（详情页切片，长图或图文排版）/ 海报 / 尺码表 / 无关（二维码、聊天截图、价格说明、空白图、别的商品等）。
- color：画面里这件衣服的颜色名，和 colors 里的名字一致；图上写了颜色名就一字不改地照抄，没写就按你看到的起一个常见颜色名；一张图里有多种颜色或看不出时留空。
- front：衣服是否完整、正面朝前地出现（领口到下摆都在画面里，没被手、包、文字挡住主体）。
- detail：如果是局部特写，拍的是这件衣服的哪个部位，用这件衣服实际有的东西来叫，2–6 个字（如 连帽、帽檐调节、立领、门襟拉链、袖口、下摆抽绳、口袋、腋下透气拉链、内胆、面料、背面）；看清楚再叫，帽子就写帽子相关的名字，不要叫成领口。同一个部位在不同图里用同一个叫法。不是特写留空。整件衣服的背面照片 detail 也写“背面”。
- parts：画面里能看清特写的所有部位（详情页、卖点图常常一张拼了好几个部位的特写，比如门襟拉链和口袋、袖口在同一张里，都写上），叫法和 detail 一样；没有就空数组。
- text：画面上有没有能读出的卖点文字（面料、功能、工艺、服务等）。
- logo：衣服本身上有没有 logo、品牌标、印字或图案（只看衣服，不看背景和图上加的字）。
- person：画面里有没有真人模特：只有一位男生写 男，只有一位女生写 女，一男一女写 男女，三人以上写 多人，没有人留空。
- face：画面里模特的脸是否正对或微侧镜头、五官清楚、没被墨镜、口罩、手或帽檐挡住，脸足够大能看清长相。没有人写 false。
- same：如果这张和另一张是同一张照片（裁剪、缩放、调色、加字前后的版本），写那一张的编号，否则留空。`;
/** The whole product's rules: colours, points, category, checks, titles, master. */
const WHOLE_RULES = `整款：
- colors：这款衣服的全部颜色。名字严格照抄颜色图、色卡、详情页上写的颜色名，一个字都不改（带品牌词的如“爱马仕橙”也照抄，不要换说法、不要自己起更好听的名字）；素材上完全没写颜色名的，才按你看到的颜色起一个常见名；hex 是你看到的颜色；from 写能看到这个颜色衣服的图的编号（最多 5 个）。色卡或文字里提到、但素材里没有这个颜色衣服图的，也要列出来，from 留空。同一个颜色在不同地方写法不一样（字的顺序不同，如“黑拼白”和“黑白拼”；或多一个“色”字），算一个颜色，只列一次，名字用颜色图或色卡上的写法。
- points：卖点，只能来自图上的文字或清楚可见的演示（如水珠滚落），不要编造；text 只做提炼：用素材原文里的字和说法（品牌名、型号、数字都照原样保留），不改写、不换说法、不美化；原文超过 16 个字时只截取其中最关键的连续部分；note 是素材里专门解释这条卖点本身的说明，同样只提炼原文（如卖点“防水三级以上”配“防水指数三级以上 雨天外出更安心”），不超过 16 个字，不带句末标点。讲的是另一个部位、另一个功能或另一种材料的字，哪怕排在旁边也不能用（比如卖点“防风保暖”旁边写着“帽围自由调节”，那是在讲帽子；卖点是衣身成分，旁边写的是包边条成分），这时 note 留空；type 是 定位/功能/面料/做工/实用/颜色款式/人群场景/服务定制 之一；from 写出处编号。最多 16 条，按重要性从高到低排，排第一、第二的会放上首图。重要性看两点：① 商家有多强调——在素材里反复出现、放在显眼位置（大标题、首屏）讲的更重要；② 买家有多在乎——买这类衣服的人做决定时最先看的更重要。why 用一句话（不超过 30 个字）说明排在这里的理由，如“主图和详情页 5 处都在讲，冲锋衣买家最先看防水”。
- 每条卖点还要写：concept（它属于下面"卖点类别"里的哪一类，写类别编号；哪一类都不是就写 null）；proof（这条卖点在图上怎么证明，从下面"画法"里选一个编号；做工、实用类讲的是衣服某个部位的，选 part）；part（选了 part 或讲的是某个部位时，写部位名，用 images 里 detail 的叫法，如“袖口”）。
- notes：你发现的问题，比如“色卡里有藏青，但没有藏青的衣服图”“没有背面图”，没有就空数组。

整款还要写：
- category：这款按哪个品类来排，写品类编号（下面列出的）。按衣服本身判断，不看素材里的文案怎么叫它：workwear（冲锋衣）指连帽或高立领、前门襟是拉链（外露的、或被挡风片盖住的都算）、面料防风防泼水的外套（单层、软壳、三合一都算）；T 恤、衬衫、马甲、羽绒服、棉服、卫衣、POLO 都不是，写 generic。categoryWhy：一句话理由（不超过 40 个字），如“连帽、外露拉链、防泼水面料，是冲锋衣”。
- checks：下面"卖点类别"里属于衣服功能的每一类（不含服务类），看这件衣服的图判断它像不像有：seen 写 有 / 看不出 / 不像；why 一句话依据（不超过 30 个字），如“单层薄款，没看到内胆或加绒”。素材里已经讲到的类别也要判断。
- titles：给每类主图各写 2–3 句候选大标题（4–10 个字，概括这类图要讲的，口语、有力，如“细节经得起看”“三防面料 雨天不怕”），类别：${TASKS.filter(t => t !== '收口').join('、')}。只能根据素材里有的卖点写，不编造参数和承诺。
- look：这款用哪套母版、首图在哪儿拍、首图主打哪个卖点。先看素材里有没有写给谁穿、什么行业（如 4S 店、物业、工地、餐饮、团建），写了就照着选；没写就看衣服本身：颜色深浅、功能卖点多不多、偏商务还是偏户外。master：从下面"母版"里选一个编号；M4 只在素材讲男女同款、情侣或年轻团队时选；M5 是给不想用模特、想省积分的店铺自己换的，不要选；素材里没有模特图不要紧，出图时模特是另画的。place：首图地点编号，只有首图是实景的母版才写，不能选这套母版不能拍的地点，否则留空。sell：首图主打的卖点，从下面"首图卖点"里选一个，要是 points 里讲到的、并且在这个地点演得出来的（看地点后面列的）；都不沾留空。why：一句话理由（不超过 40 个字），如“三防卖点多、深色款，选暗黑科技；素材写了物业保安，在小区门口拍”。`;
const IMAGE_SHAPE = '{ "id": "M1", "kind": "", "color": "", "front": false, "detail": "", "parts": [], "text": false, "logo": false, "person": "", "face": false, "same": "" }';
const WHOLE_SHAPE = `"colors": [{ "name": "", "hex": "", "from": ["M1"] }],
  "points": [{ "type": "", "text": "", "note": "", "from": ["M1"], "why": "", "concept": null, "proof": "", "part": "" }],
  "notes": [""], "category": "", "categoryWhy": "", "checks": [{ "concept": "", "seen": "", "why": "" }], "titles": { "功能": [""] },
  "look": { "master": "", "place": "", "sell": "", "why": "" }`;

/** The one-call analysis (kept for small folders' tests and as the reference wording). */
const SYSTEM = `${ROLE}你会收到同一款衣服的一大批原始素材（实拍、静物、3D 图、做好的主图和详情页、海报、颜色图等，可能很乱），每张都标了编号。
任务：逐张整理，并读出颜色和卖点。颜色和卖点只做提炼，素材里写了什么就用什么，不做任何调整。只输出 JSON。

${IMAGE_RULES}

${WHOLE_RULES}

{CATALOG}

输出：
{ "images": [${IMAGE_SHAPE}],
  ${WHOLE_SHAPE} }`;
/**
 * Step one in parts (10-13): the images sorted a batch at a time, each batch kept when it comes
 * back, so a cut connection only costs the batch it cut (「继续整理」 does the rest).
 */
const SORT_SYSTEM = `${ROLE}你会收到同一款衣服的一部分原始素材（实拍、静物、3D 图、做好的主图和详情页、海报、颜色图等，可能很乱），每张都标了编号。
任务：逐张整理。只输出 JSON。

${IMAGE_RULES}

输出：
{ "images": [${IMAGE_SHAPE}] }`;
/** Then the whole product, from the images that matter and how each was sorted. */
const READ_SYSTEM = `${ROLE}你会收到同一款衣服的原始素材（已经去掉无关和重复的图），每张都标了编号，还有每张图已经整理好的分类（类别、颜色、部位、有没有字）。
任务：读出颜色和卖点。颜色和卖点只做提炼，素材里写了什么就用什么，不做任何调整。只输出 JSON。

${WHOLE_RULES}

{CATALOG}

输出：
{ ${WHOLE_SHAPE} }`;

/** The categories, their kinds of point and the ways of drawing a point, for the model to choose from. */
const catalog = (categories: Category[]) => [
  `品类：${categories.map(c => `${c.id}（${c.name}）`).join('、')}`,
  ...categories.filter(c => c.concepts.length).map(c => `「${c.name}」的卖点类别（编号：名字，类型，常见说法）：\n${c.concepts.map(x => `${x.id}：${x.name}，${x.type}，${x.keywords.slice(0, 4).join('/')}`).join('\n')}`),
  `画法（编号：名字，怎么画）：\n${PROOFS.map(p => `${p.id}：${p.name}，${p.recipe}${p.person ? '（要有人）' : ''}`).join('\n')}`,
  `母版（编号：名字，样子；适合；首图）：\n${BUILT_IN_LAYOUTS.filter(l => MASTER_INFO[l.id]).map(l => { const m = MASTER_INFO[l.id], deny = Object.keys(m.deny);
    return `${l.id}：${l.name}，${l.description}；适合${m.fit}；首图${m.cover}${deny.length ? `，不能在${deny.join('、')}拍` : ''}`; }).join('\n')}`,
  `首图地点（编号：名字，在这儿演得出的卖点）：\n${PLACE_IDS.map(id => `${id}：${PLACES[id].name}，${PLACES[id].fits.join('/')}`).join('\n')}`,
  `首图卖点：${Object.keys(SELLS).join('、')}`,
].join('\n\n');

export function organizeRequest(input: { views: PlanView[]; model: string; product: string }) {
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    { type: 'text', text: `商品：${input.product}。下面是全部素材（拼在一起的，每一格、每一段都是一张独立素材，按说明里的顺序对应编号）。` }];
  for (const view of input.views) content.push({ type: 'text', text: view.text }, { type: 'image_url', image_url: { url: view.dataUrl } });
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 24000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: SYSTEM.replace('{CATALOG}', catalog(CATEGORIES)) }, { role: 'user', content }] };
}

const userContent = (lead: string, views: PlanView[]) => {
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [{ type: 'text', text: lead }];
  for (const view of views) content.push({ type: 'text', text: view.text }, { type: 'image_url', image_url: { url: view.dataUrl } });
  return content;
};
/** One batch of images to sort. */
export function sortRequest(input: { views: PlanView[]; model: string; product: string }) {
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 16000, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: SORT_SYSTEM }, { role: 'user', content: userContent(`商品：${input.product}。下面是这款的一部分素材（拼在一起的，每一格、每一段都是一张独立素材，按说明里的顺序对应编号）。`, input.views) }] };
}
/** The whole product, read from the images worth reading and how each was sorted. */
export function readRequest(input: { views: PlanView[]; model: string; product: string; images: SortedImage[] }) {
  const line = (i: SortedImage) => `${i.id}：${i.kind}${i.color ? `，${i.color}` : ''}${i.detail || i.parts?.length ? `，部位 ${[...new Set([i.detail, ...(i.parts ?? [])].filter(Boolean))].join('、')}` : ''}${i.front ? '，正面全身' : ''}${i.text ? '，有卖点字' : ''}${i.person ? `，${i.person}` : ''}`;
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 12000, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: READ_SYSTEM.replace('{CATALOG}', catalog(CATEGORIES)) }, { role: 'user', content: [
      { type: 'text' as const, text: `每张图已经整理好的分类：\n${input.images.map(line).join('\n')}` },
      ...userContent(`商品：${input.product}。下面是要读的素材（拼在一起的，每一格、每一段都是一张独立素材，按说明里的顺序对应编号）。`, input.views)] }] };
}
/** The images worth reading for the whole product: not unrelated, not a copy of another. */
export const worthReading = (images: SortedImage[]) => images.filter(i => i.kind !== '无关' && !i.same);

const imageSchema = z.object({
  id: z.string(), kind: z.enum(MATERIAL_KINDS).catch('无关'), color: z.string().default(''), front: z.boolean().default(false),
  detail: z.string().trim().max(12).catch(''), parts: z.array(z.string().trim().max(12)).max(8).catch([]).default([]), text: z.boolean().default(false), logo: z.boolean().default(false), same: z.string().default(''),
  person: z.enum(['', '男', '女', '男女', '多人']).catch('').default(''), face: z.boolean().catch(false).default(false),
});
const organizeSchema = z.object({
  images: z.array(imageSchema),
  colors: z.array(z.object({ name: z.string().trim().min(1).max(12), hex: z.string().default(''), from: z.array(z.string()).default([]) })),
  points: z.array(z.object({ type: z.string().default(''), text: z.string().trim().min(1).max(20), note: z.string().trim().max(30).default(''), from: z.array(z.string()).default([]), why: z.string().max(80).default(''),
    concept: z.string().max(40).nullable().catch(null).default(null), proof: z.string().max(40).catch('').default(''), part: z.string().trim().max(12).catch('').default('') })).default([]),
  notes: z.array(z.string()).default([]),
  category: z.string().max(40).catch('generic').default('generic'), categoryWhy: z.string().max(120).catch('').default(''),
  checks: z.array(z.object({ concept: z.string().max(40), seen: z.enum(['有', '看不出', '不像']).catch('看不出'), why: z.string().max(80).catch('').default('') })).catch([]).default([]),
  titles: z.record(z.string(), z.array(z.string().trim().min(1).max(20)).max(4)).catch({}).default({}),
  themes: z.array(z.object({ title: z.string().trim().min(1).max(20), kind: z.string().max(8).catch('功能'), points: z.array(z.number().int()).max(16), show: z.string().max(120).catch('').default('') })).max(8).catch([]).default([]),
  look: z.object({ master: z.string().max(8).catch(''), place: z.string().max(12).catch(''), sell: z.string().max(8).catch(''), why: z.string().max(120).catch('').default('') }).nullable().catch(null).default(null),
});
/** The AI's pick of the master, where the cover is shot and the point it acts out; empty parts fall back to the plan's rules. */
export type Look = { master: string; place?: PlaceId; sell?: Sell; why: string };
export type Organized = Omit<z.infer<typeof organizeSchema>, 'look' | 'images'> & { look: Look | null; images: SortedImage[] };
/** `parts` is missing on material sorted before 10-13. */
export type SortedImage = Omit<z.infer<typeof imageSchema>, 'parts'> & { parts?: string[] };

/** A colour name's characters, in any order, without 色: 「黑白拼」 and 「黑拼白」 are the same colour. */
const colorKey = (name: string) => [...name.replace(/色/g, '')].sort().join('');
/**
 * One colour written two ways (10-13: 「黑拼白」 on the colour images, 「黑白拼」 in a line of text)
 * was listed twice, the second with no garment image and so a red 「没有衣服图」. A colour without an
 * image that reads the same as one with an image is that colour.
 */
export function mergeSameColors<C extends { name: string; from: string[] }>(colors: C[]): C[] {
  return colors.filter(c => c.from.length || !colors.some(o => o !== c && o.from.length && colorKey(o.name) === colorKey(c.name)));
}
export function parseOrganized(content: string, ids: string[]): Organized {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw new Error('整理结果不是完整的 JSON'); }
  const parsed = organizeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`整理结果缺少必要内容（${[...new Set(parsed.error.issues.map(i => String(i.path[0] ?? '结构')))].join('、')}）`);
  const known = new Set(ids), data = parsed.data;
  data.images = data.images.filter(i => known.has(i.id));
  // An image the model skipped is kept as unsorted rather than lost.
  for (const id of ids) if (!data.images.some(i => i.id === id)) data.images.push({ id, kind: '无关', color: '', front: false, detail: '', parts: [], text: false, logo: false, same: '', person: '', face: false });
  for (const c of data.colors) c.from = c.from.filter(id => known.has(id));
  data.colors = mergeSameColors(data.colors);
  for (const p of data.points) p.from = p.from.filter(id => known.has(id));
  // Only kinds, ways of drawing and categories that exist.
  const category = CATEGORIES.find(c => c.id === data.category) ?? CATEGORIES[CATEGORIES.length - 1];
  const kinds = new Set(category.concepts.map(c => c.id)), proofs = new Set(PROOFS.map(p => p.id));
  data.category = category.id;
  for (const p of data.points) { if (p.concept && !kinds.has(p.concept)) p.concept = null; if (!proofs.has(p.proof)) p.proof = ''; }
  data.checks = data.checks.filter(c => kinds.has(c.concept));
  data.titles = Object.fromEntries(Object.entries(data.titles).filter(([k]) => (TASKS as string[]).includes(k)));
  // A theme keeps only the points that exist (numbered from 1).
  data.themes = data.themes.map(t => ({ ...t, points: t.points.filter(n => n >= 1 && n <= data.points.length) })).filter(t => t.points.length);
  return { ...data, look: lookOf(data.look) };
}

const sortedSchema = z.object({ images: z.array(imageSchema) });
const readSchema = organizeSchema.omit({ images: true });
const unsorted = (id: string): SortedImage => ({ id, kind: '无关', color: '', front: false, detail: '', parts: [], text: false, logo: false, same: '', person: '', face: false });
/** One batch's images; one the model skipped is kept as unsorted rather than lost. */
export function parseSorted(content: string, ids: string[]): SortedImage[] {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw new Error('整理结果不是完整的 JSON'); }
  const parsed = sortedSchema.safeParse(raw);
  if (!parsed.success) throw new Error('整理结果缺少每张图的分类');
  const known = new Set(ids), images = parsed.data.images.filter(i => known.has(i.id));
  for (const i of images) if (i.same && !known.has(i.same)) i.same = '';
  return [...images, ...ids.filter(id => !images.some(i => i.id === id)).map(unsorted)];
}
/** The sorted images and the whole product's reading, put together as the one-call analysis gave them. */
export function parseRead(content: string, images: SortedImage[]): Organized {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw new Error('整理结果不是完整的 JSON'); }
  const parsed = readSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`整理结果缺少必要内容（${[...new Set(parsed.error.issues.map(i => String(i.path[0] ?? '结构')))].join('、')}）`);
  return parseOrganized(JSON.stringify({ ...parsed.data, images }), images.map(i => i.id));
}

/** Only a master that exists, a place it can shoot (on location only) and a known point. */
function lookOf(raw: { master: string; place: string; sell: string; why: string } | null): Look | null {
  const info = raw && MASTER_INFO[raw.master];
  if (!raw || !info || !BUILT_IN_LAYOUTS.some(l => l.id === raw.master)) return null;
  const place = info.cover === '实景' && raw.place in PLACES && !info.deny[raw.place as PlaceId] ? raw.place as PlaceId : undefined;
  const sell = place && raw.sell in SELLS ? raw.sell as Sell : undefined;
  return { master: raw.master, ...(place ? { place } : {}), ...(sell ? { sell } : {}), why: raw.why.trim() };
}

/** What one image is worth as the source of a colour's white-background product image. */
const colourRank: Partial<Record<MaterialKind, number>> = { 静物: 5, '3D渲染': 4, 颜色款图: 3, 模特实拍: 2, 卖点图: 1 };
type Size = { id: string; width: number; height: number };

/**
 * The program's pick from the sorted images: per colour the best whole-front image (a clean still
 * life first), a whole front view, and the parts with the most close-ups, under the names the model
 * gave them (the back view last). `sizes` breaks ties by resolution.
 */
export function chooseMaterials(sorted: Pick<Organized, 'images' | 'colors'>, sizes: Size[]) {
  const px = new Map(sizes.map(s => [s.id, s.width * s.height]));
  const usable = sorted.images.filter(i => !i.same && i.kind !== '无关' && i.kind !== '尺码表');
  const best = (list: SortedImage[], rank: (i: SortedImage) => number) => [...list].sort((a, b) => rank(b) - rank(a) || (px.get(b.id) ?? 0) - (px.get(a.id) ?? 0))[0]?.id ?? null;
  const colors = sorted.colors.map(c => {
    const candidates = usable.filter(i => i.color === c.name || c.from.includes(i.id)).filter(i => i.front && colourRank[i.kind]);
    return { name: c.name, hex: c.hex, pick: best(candidates, i => (colourRank[i.kind] ?? 0) * 2 + (i.logo ? 0 : 1)), candidates: candidates.map(i => i.id) };
  });
  // A full front view shows one garment: an image with one colour, ideally a colour's own pick.
  const picked = new Set(colors.map(c => c.pick));
  const fronts = usable.filter(i => i.front && i.color && colourRank[i.kind]);
  const front = { part: FRONT, pick: best(fronts, i => (picked.has(i.id) ? 10 : 0) + (colourRank[i.kind] ?? 0)), candidates: fronts.map(i => i.id) };
  const named = new Map<string, SortedImage[]>();
  // A part counts from an image sorted as it, and from a detail page that shows it among others (`parts`).
  for (const i of usable) for (const x of new Set([i.detail, ...(i.parts ?? [])])) if (x && x !== '其他') named.set(x, [...(named.get(x) ?? []), i]);
  const back = named.get('背面');
  named.delete('背面');
  const parts = [...[...named].sort(([, x], [, y]) => y.length - x.length).slice(0, MAX_PARTS), ...(back ? [['背面', back] as const] : [])]
    .map(([part, list]) => ({ part, pick: best(list, i => (i.detail === part ? 2 : 0) + (i.kind === '细节特写' ? 1 : 0)), candidates: list.map(i => i.id) }));
  return { colors, parts: [front, ...parts] };
}
