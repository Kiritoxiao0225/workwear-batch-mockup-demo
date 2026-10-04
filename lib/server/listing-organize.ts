/**
 * 电商主图, step one for a raw product folder: the model sorts every image (kind, colour, whether
 * the whole garment is shown from the front, which detail it shows, whether it carries selling
 * text, which other image it copies), lists the colours and the selling points with their
 * sources. The program then picks what the generation needs and checks what is missing:
 *   ① one image per colour to extract the white-background product image from (required)
 *   ② structure references: a full front view (required), collar, zip and cuffs, pocket, fabric, back
 *   ③ selling points read from text on the images
 */
import { z } from 'zod';
import type { PlanView } from './listing-plan-views';

export const MATERIAL_KINDS = ['颜色款图', '静物', '3D渲染', '模特实拍', '细节特写', '卖点图', '详情页', '海报', '尺码表', '无关'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];
export const PARTS = ['正面全身', '领口', '拉链和袖口', '口袋', '面料', '背面'] as const;
export type Part = (typeof PARTS)[number];
const DETAILS = ['领口', '拉链', '袖口', '口袋', '面料', '背面', '下摆', '其他', ''] as const;

const SYSTEM = `你是淘宝服装店的素材整理员。你会收到同一款衣服的一大批原始素材（实拍、静物、3D 图、做好的主图和详情页、海报、颜色图等，可能很乱），每张都标了编号。
任务：逐张整理，并读出颜色和卖点。只输出 JSON。

每张图（images，一张不漏，按编号）：
- kind：颜色款图（用来区分颜色款的图，通常一个颜色一张、带颜色名）/ 静物（平铺、挂拍、人台、白底产品图）/ 3D渲染 / 模特实拍（没有加文字的模特照片）/ 细节特写（局部近拍）/ 卖点图（做好的主图或营销图，上面有卖点文字）/ 详情页（详情页切片，长图或图文排版）/ 海报 / 尺码表 / 无关（二维码、聊天截图、价格说明、空白图、别的商品等）。
- color：画面里这件衣服的颜色名；图上写了颜色名就照抄，没写就按你看到的起一个常见颜色名；一张图里有多种颜色或看不出时留空。
- front：衣服是否完整、正面朝前地出现（领口到下摆都在画面里，没被手、包、文字挡住主体）。
- detail：如果是局部特写，拍的是哪里：领口 / 拉链 / 袖口 / 口袋 / 面料 / 背面 / 下摆 / 其他；不是特写留空。整件衣服的背面照片 detail 也写“背面”。
- text：画面上有没有能读出的卖点文字（面料、功能、工艺、服务等）。
- logo：衣服本身上有没有 logo、品牌标、印字或图案（只看衣服，不看背景和图上加的字）。
- same：如果这张和另一张是同一张照片（裁剪、缩放、调色、加字前后的版本），写那一张的编号，否则留空。

整款：
- colors：这款衣服的全部颜色。名字优先用颜色图、色卡、详情页上写的名字；hex 是你看到的颜色；from 写能看到这个颜色衣服的图的编号（最多 5 个）。色卡或文字里提到、但素材里没有这个颜色衣服图的，也要列出来，from 留空。
- points：卖点，只能来自图上的文字或清楚可见的演示（如水珠滚落），不要编造；text 用你自己的话重新说，不超过 12 个字，不要出现任何品牌名（包括拉链、面料等配件品牌，改成“顺滑拉链”这类通用说法）；type 是 定位/功能/面料/做工/实用/颜色款式/人群场景/服务定制 之一；from 写出处编号。按重要性排序，最多 16 条。
- notes：你发现的问题，比如“色卡里有藏青，但没有藏青的衣服图”“没有背面图”，没有就空数组。

输出：
{ "images": [{ "id": "M1", "kind": "", "color": "", "front": false, "detail": "", "text": false, "logo": false, "same": "" }],
  "colors": [{ "name": "", "hex": "", "from": ["M1"] }],
  "points": [{ "type": "", "text": "", "from": ["M1"] }],
  "notes": [""] }`;

export function organizeRequest(input: { views: PlanView[]; model: string; product: string }) {
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    { type: 'text', text: `商品：${input.product}。下面是全部素材（拼在一起的，每一格、每一段都是一张独立素材，按说明里的顺序对应编号）。` }];
  for (const view of input.views) content.push({ type: 'text', text: view.text }, { type: 'image_url', image_url: { url: view.dataUrl } });
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 24000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }] };
}

const imageSchema = z.object({
  id: z.string(), kind: z.enum(MATERIAL_KINDS).catch('无关'), color: z.string().default(''), front: z.boolean().default(false),
  detail: z.enum(DETAILS).catch('其他'), text: z.boolean().default(false), logo: z.boolean().default(false), same: z.string().default(''),
});
const organizeSchema = z.object({
  images: z.array(imageSchema),
  colors: z.array(z.object({ name: z.string().trim().min(1).max(12), hex: z.string().default(''), from: z.array(z.string()).default([]) })),
  points: z.array(z.object({ type: z.string().default(''), text: z.string().trim().min(1).max(20), from: z.array(z.string()).default([]) })).default([]),
  notes: z.array(z.string()).default([]),
});
export type Organized = z.infer<typeof organizeSchema>;
export type SortedImage = z.infer<typeof imageSchema>;

export function parseOrganized(content: string, ids: string[]) {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw new Error('整理结果不是完整的 JSON'); }
  const parsed = organizeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`整理结果缺少必要内容（${[...new Set(parsed.error.issues.map(i => String(i.path[0] ?? '结构')))].join('、')}）`);
  const known = new Set(ids), data = parsed.data;
  data.images = data.images.filter(i => known.has(i.id));
  // An image the model skipped is kept as unsorted rather than lost.
  for (const id of ids) if (!data.images.some(i => i.id === id)) data.images.push({ id, kind: '无关', color: '', front: false, detail: '', text: false, logo: false, same: '' });
  for (const c of data.colors) c.from = c.from.filter(id => known.has(id));
  for (const p of data.points) p.from = p.from.filter(id => known.has(id));
  return data;
}

/**
 * Words that look like a brand (a known one, or Latin capitals like YKK): colour names and selling
 * points are printed on the images, so the page asks the user to reword them.
 */
const BRANDS = /爱马仕|香奈儿|迪奥|古驰|普拉达|路易威登|蒂芙尼|始祖鸟|北面|耐克|阿迪达斯|优衣库|[A-Z]{2,}/;
export const brandHint = (text: string) => BRANDS.test(text) ? '可能含品牌名，建议改成通用说法' : '';

/**
 * A clean still life or 3D render of one garment needs no white-background extraction: the image
 * itself is used (free). Anything else, or a garment carrying a logo, is extracted by the model.
 */
export const usableAsIs = (image: SortedImage | undefined) => !!image && (image.kind === '静物' || image.kind === '3D渲染') && image.front && !image.logo;

/** What one image is worth as the source of a colour's white-background product image. */
const colourRank: Partial<Record<MaterialKind, number>> = { 静物: 5, '3D渲染': 4, 颜色款图: 3, 模特实拍: 2, 卖点图: 1 };
type Size = { id: string; width: number; height: number };

/**
 * The program's pick from the sorted images: per colour the best whole-front image, the
 * structure references, and the checks the page shows. `sizes` breaks ties by resolution.
 */
export function chooseMaterials(sorted: Organized, sizes: Size[]) {
  const px = new Map(sizes.map(s => [s.id, s.width * s.height]));
  const usable = sorted.images.filter(i => !i.same && i.kind !== '无关' && i.kind !== '尺码表');
  const best = (list: SortedImage[], rank: (i: SortedImage) => number) => [...list].sort((a, b) => rank(b) - rank(a) || (px.get(b.id) ?? 0) - (px.get(a.id) ?? 0))[0]?.id ?? null;
  const colors = sorted.colors.map(c => {
    const candidates = usable.filter(i => i.color === c.name || c.from.includes(i.id)).filter(i => i.front && colourRank[i.kind]);
    return { name: c.name, hex: c.hex, pick: best(candidates, i => (colourRank[i.kind] ?? 0) * 2 + (i.logo ? 0 : 1)), candidates: candidates.map(i => i.id) };
  });
  const parts = PARTS.map(part => {
    // A full front view shows one garment: an image with one colour, ideally a colour's own pick.
    const list = part === '正面全身' ? usable.filter(i => i.front && i.color && colourRank[i.kind])
      : part === '拉链和袖口' ? usable.filter(i => i.detail === '拉链' || i.detail === '袖口')
      : usable.filter(i => i.detail === part);
    const picked = new Set(colors.map(c => c.pick));
    const rank = (i: SortedImage) => part === '正面全身' ? (picked.has(i.id) ? 10 : 0) + (colourRank[i.kind] ?? 0) : i.kind === '细节特写' ? 2 : 1;
    return { part, pick: best(list, rank), candidates: list.map(i => i.id) };
  });
  const missingColors = colors.filter(c => !c.pick).map(c => c.name);
  return {
    colors, parts,
    checks: {
      missingColors, front: !!parts[0].pick,
      missingParts: parts.filter(p => p.part !== '正面全身' && !p.pick).map(p => p.part),
      points: sorted.points.length,
    },
  };
}
