/**
 * 电商主图, step two for a sorted product: from the images the user confirmed (one per colour,
 * the structure references, the sources of the chosen selling points) the model writes the
 * garment description and each image's words. Colours and selling points are the user's; the
 * model does not sort or invent them. The result has the shape of a one-step plan, so review,
 * generation and redo work unchanged.
 */
import { z } from 'zod';
import { MAIN_ROLES, rolesFor, type ListingCounts, type ListingLayout } from '../listing/layouts';
import type { ListingPlan } from './listing-plan';
import { PARTS, type Organized } from './listing-organize';

/** What the user confirmed on the materials page. */
export const choiceSchema = z.object({
  colors: z.array(z.object({ name: z.string().trim().min(1, '颜色名不能空').max(12), hex: z.string().max(16).default(''), pick: z.string().min(1, '每个颜色都要有一张衣服图') })).min(1, '至少要有一个颜色'),
  parts: z.array(z.object({ part: z.enum(PARTS), pick: z.string().nullable().default(null), skip: z.boolean().default(false) })).default([]),
  points: z.array(z.object({ type: z.string().max(10).default(''), text: z.string().trim().min(1).max(16), from: z.array(z.string()).default([]), why: z.string().max(80).default(''), on: z.boolean().default(true) })).default([]),
});
export type Choice = z.infer<typeof choiceSchema>;

const SYSTEM = `你是淘宝服装类目的资深电商视觉策划。用户已经整理好了这款衣服的素材：每个颜色一张衣服图、几张结构参考图（领口、拉链、口袋等）、卖点和卖点的出处图。
你的任务：写出衣服结构描述，并按给定的版式和角色为每张主图写文案和画面。只输出 JSON。

规则：
1. 颜色和卖点以用户给的为准，不增不改；卖点只能用列出来的这些，照原文用，不换说法（品牌名、型号、数字都照原样保留），不要编造数据、认证和销量。
2. garment（衣服结构）要逐条写到生图模型能照做的程度：领型、门襟与拉链、分割线、口袋（数量、位置、开口方式）、袖口、下摆、衣长版型、面料质感。以衣服图和结构参考图为准，看不清的不要猜。它会原样写进每一张图的提示词，用来锁死衣服不变。生图时看不到这些素材图，所以 garment 和 scene 里不要写图片编号（如“参照 M2”），把形状直接写出来。
3. 图上的字直接用卖点原文，不改写、不美化：主标题不超过 10 个字，副标题不超过 16 个字，要点每条不超过 10 个字；原文超长时只截取其中连续的关键部分，不换字。画面里不要画 logo 图案和水印。
4. 主图按给定的角色顺序出。卖点编号就是重要性排名（P1 最重要）：首图用排名最前的 1–2 条；其余每张按角色挑对应类型的卖点，同类里排名靠前的优先用。每张 1–2 个卖点，同一组内卖点不重复，前后连贯像一个故事；scene 写这张图用什么画面直观演示卖点。
5. 3:4 主图与 1:1 讲同一套卖点，文案可以微调。2:3 是店铺首页海报，氛围感最强。
6. 多色图（多人或多件同框）最多 4 种颜色，在该图的 colors 里列出用到的颜色名，名字必须和用户给的颜色完全一致；单色图的 colors 只写主色。
7. SKU 图：tag 写颜色名旁的短标签（如“男女同款”），fabric 写面料小图下方的小字（不超过 6 个字），只用卖点里有依据的说法，没有就留空。
{SKIP}
输出：
{
  "product": { "name": "", "category": "", "audience": "", "fabric": "", "garment": [""] },
  "main": {
    "square":   [{ "n": 1, "role": "首图", "points": ["P1"], "title": "", "subtitle": "", "bullets": [""], "scene": "", "colors": [""] }],
    "portrait": [ 同上 ],
    "poster":   [ 同上 ]
  },
  "sku": { "tag": "", "fabric": "" }
}`;

const roleText = (count: number) => rolesFor(count).map((r, i) => `${i + 1}. ${r}：${MAIN_ROLES[r]}`).join('\n');
type View = { text: string; dataUrl: string };

export function writeRequest(input: { views: View[]; choice: Choice; counts: ListingCounts; layout: ListingLayout; model: string; product: string }) {
  const { counts, layout, choice } = input;
  const on = choice.points.filter(p => p.on);
  // Parts marked "not needed" are kept out of every image, e.g. no back view at all.
  const skipped = choice.parts.filter(p => p.skip).map(p => p.part);
  const task = `商品：${input.product}。这一款用「${layout.name}」版式：${layout.style}

颜色（${choice.colors.length} 个，名字照用）：${choice.colors.map(c => `${c.name}（${c.hex || '见图'}，衣服图 ${c.pick}）`).join('、')}
卖点（${on.length} 条，编号照用）：
${on.map((p, i) => `P${i + 1} [${p.type}] ${p.text}${p.from.length ? `（出处 ${p.from.join('、')}）` : ''}`).join('\n')}

本次要出的图（淘宝）：
${counts.square ? `- 1:1 主图 ${counts.square} 张，角色顺序：\n${roleText(counts.square)}` : '- 不出 1:1 主图（main.square 为空数组）'}
${counts.portrait ? `- 3:4 主图 ${counts.portrait} 张，角色顺序：\n${roleText(counts.portrait)}` : '- 不出 3:4 主图（main.portrait 为空数组）'}
${counts.poster ? '- 2:3 首页海报 1 张' : '- 不出 2:3 海报（main.poster 为空数组）'}

下面是用户挑出的素材图。`;
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [{ type: 'text', text: task }];
  for (const view of input.views) content.push({ type: 'text', text: view.text }, { type: 'image_url', image_url: { url: view.dataUrl } });
  const system = SYSTEM.replace('{SKIP}', skipped.length ? `8. 用户说不需要这些：${skipped.join('、')}。画面里不要出现${skipped.includes('背面') ? '背面角度、' : ''}这些部位的特写。\n` : '');
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 12000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: system }, { role: 'user', content }] };
}

const slotSchema = z.object({
  n: z.number().int(), role: z.string(), points: z.array(z.string()).default([]),
  title: z.string(), subtitle: z.string().default(''), bullets: z.array(z.string()).default([]),
  scene: z.string().default(''), colors: z.array(z.string()).default([]),
});
const writeSchema = z.object({
  product: z.object({ name: z.string().default(''), category: z.string().default(''), audience: z.string().default(''), fabric: z.string().default(''), garment: z.array(z.string()).min(1) }),
  main: z.object({ square: z.array(slotSchema).default([]), portrait: z.array(slotSchema).default([]), poster: z.array(slotSchema).default([]) }),
  sku: z.object({ tag: z.string().default(''), fabric: z.string().default('') }).default({ tag: '', fabric: '' }),
});

const ROLE_OF: Record<string, '主图' | 'SKU' | '详情' | '尺码表' | '不用'> = { 卖点图: '详情', 详情页: '详情', 海报: '详情', 尺码表: '尺码表' };

/** The model's words plus the user's colours and points, in the shape the rest of 电商主图 reads. */
export function buildPlan(content: string, input: { choice: Choice; sorted: Organized; product: string }): { plan: ListingPlan; corrected: string[]; problems: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw new Error('写出的内容不是完整的 JSON'); }
  const checked = writeSchema.safeParse(raw);
  if (!checked.success) throw new Error(`写出的内容不完整（${[...new Set(checked.error.issues.map(i => String(i.path[0] ?? '结构')))].join('、')}）`);
  const w = checked.data, { choice } = input;
  const picks = new Set(choice.colors.map(c => c.pick));
  const names = new Set(choice.colors.map(c => c.name));
  const problems: string[] = [];
  for (const slot of [...w.main.square, ...w.main.portrait, ...w.main.poster]) {
    // An unknown colour name falls back to the main colour when the jobs are planned; say so here.
    for (const name of slot.colors) if (!names.has(name)) problems.push(`第 ${slot.n} 张图用了不存在的颜色「${name}」`);
    if (slot.colors.length > 4) slot.colors = slot.colors.slice(0, 4);
  }
  const plan: ListingPlan = {
    assets: input.sorted.images.map(i => ({ id: i.id, role: picks.has(i.id) ? 'SKU' : ROLE_OF[i.kind] ?? '不用', color: i.color, reason: i.kind })),
    product: { name: w.product.name || input.product, category: w.product.category, audience: w.product.audience, fabric: w.product.fabric, garment: w.product.garment,
      colors: choice.colors.map(c => ({ name: c.name, hex: c.hex, sku: c.pick })) },
    sellingPoints: choice.points.filter(p => p.on).map((p, i) => ({ id: `P${i + 1}`, type: p.type, text: p.text, evidence: p.from, priority: i + 1 })),
    main: w.main,
    sku: { tag: w.sku.tag, fabric: w.sku.fabric, items: choice.colors.map(c => ({ color: c.name, sku: c.pick })) },
  };
  return { plan, corrected: [], problems };
}
