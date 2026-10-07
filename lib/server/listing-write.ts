/**
 * 电商主图 step two, once the user has fixed every image's words and colours on the plan page: the
 * model describes the garment (so every image draws the same one) and writes each image's picture.
 * Free: it is part of the analysis already paid. The result is what generation reads.
 */
import { z } from 'zod';
import { slotsFor, type SubmittedDraft } from '../listing/plan';
import type { ListingLayout } from '../listing/layouts';
import type { MainWords, StoredPlan } from './listing-store';

const SYSTEM = `你是淘宝服装类目的资深电商视觉策划。用户已经定好了这款衣服每张主图上的字和衣服颜色，并挑好了素材：每个颜色一张衣服图、几张结构参考图（领口、拉链、口袋等）、卖点的出处图。
你的任务：写衣服结构描述，并为每张图写画面。只输出 JSON。

规则：
1. garment（衣服结构）逐条写到生图模型能照做的程度：领型、门襟与拉链、分割线、口袋（数量、位置、开口方式）、袖口、下摆、衣长版型、面料质感。以衣服图和结构参考图为准，看不清的不要猜。它会原样写进每一张图的提示词，用来锁死衣服不变。生图时看不到这些素材图，所以不要写图片编号（如“参照 M2”），把形状直接写出来。
2. scene（画面）：用画面直观演示这张图的字讲的卖点（比如水珠演示防水、拉扯演示抗撕裂、手机放进口袋演示收纳），写人物、动作、场景和构图。图上的字和衣服颜色由用户定好、程序另外给，scene 里不要写文字内容、衣服颜色名和图片编号（同一个画面会换颜色再出一套首图）。
3. 每张图的衣服颜色已经定好，画面里只出现给定的颜色；给了几个颜色的图写成几个人并排或同框，每人一种颜色。
4. 3:4 主图和同一序号的 1:1 讲同一件事，画面按竖版重新构图；2:3 海报是店铺首页海报，氛围感最强。
5. SKU 图：tag 写颜色名旁的短标签（如“男女同款”），fabric 写面料小图下方的小字（不超过 6 个字），都只能照抄素材里的说法，没有就留空。
{SKIP}
输出：
{
  "product": { "name": "", "garment": [""] },
  "square":   [{ "n": 1, "scene": "" }],
  "portrait": [{ "n": 1, "scene": "" }],
  "poster": { "scene": "" },
  "sku": { "tag": "", "fabric": "" }
}`;

type View = { text: string; dataUrl: string };
const say = (s: { title: string; sub: string; tags: string[]; colors: string[] }) =>
  [`大标题「${s.title}」`, s.sub && `小字「${s.sub}」`, s.tags.length && `标签${s.tags.map(t => `「${t}」`).join('')}`, `衣服颜色：${s.colors.join('、')}`].filter(Boolean).join('；');

export function writeRequest(input: { views: View[]; draft: SubmittedDraft; layout: ListingLayout; model: string; product: string }) {
  const { draft, layout } = input;
  const list = (n: number) => slotsFor(n).map((i, k) => `第 ${k + 1} 张（${draft.slots[i].role}）：${say(draft.slots[i])}`).join('\n');
  const { square, portrait, poster } = draft.counts;
  const task = `商品：${input.product}。版式「${layout.name}」：${layout.style}

${square ? `1:1 主图 ${square} 张：\n${list(square)}` : '不出 1:1 主图（square 为空数组）'}
${portrait ? `3:4 主图 ${portrait} 张：\n${list(portrait)}` : '不出 3:4 主图（portrait 为空数组）'}
${poster ? `2:3 海报：${say({ ...draft.poster, tags: [], colors: [draft.main] })}` : '不出海报（poster.scene 留空）'}

下面是用户挑出的素材图。`;
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [{ type: 'text', text: task }];
  for (const view of input.views) content.push({ type: 'text', text: view.text }, { type: 'image_url', image_url: { url: view.dataUrl } });
  // Close-ups show only the parts there is a picture of; without a back view no image shows the back.
  const shown = draft.parts.filter(p => p.pick && p.part !== '正面全身').map(p => p.part);
  const back = shown.includes('背面');
  const system = SYSTEM.replace('{SKIP}', `6. 局部特写只拍结构参考里有图的部位${shown.length ? `（${shown.join('、')}）` : ''}，用参考图里的叫法；${back ? '' : '素材里没有背面图，画面不要出现背面角度。'}\n`);
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 12000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: system }, { role: 'user', content }] };
}

const scenes = z.array(z.object({ n: z.number().int(), scene: z.string().default('') })).default([]);
const writeSchema = z.object({
  product: z.object({ name: z.string().default(''), garment: z.array(z.string()).min(1) }),
  square: scenes, portrait: scenes, poster: z.object({ scene: z.string().default('') }).default({ scene: '' }),
  sku: z.object({ tag: z.string().default(''), fabric: z.string().default('') }).default({ tag: '', fabric: '' }),
});

/** The user's words and colours with the model's garment and pictures: what generation reads. */
export function buildPlan(content: string, input: { draft: SubmittedDraft; images: StoredPlan['images']; direct: string[]; model: string }): StoredPlan {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw new Error('写出的内容不是完整的 JSON'); }
  const checked = writeSchema.safeParse(raw);
  if (!checked.success) throw new Error(`写出的内容不完整（${[...new Set(checked.error.issues.map(i => String(i.path[0] ?? '结构')))].join('、')}）`);
  const w = checked.data, { draft } = input;
  const main = (ratio: 'square' | 'portrait'): MainWords[] => slotsFor(draft.counts[ratio]).map((i, k) => {
    const s = draft.slots[i];
    return { role: s.role, title: s.title, subtitle: s.sub, bullets: s.tags, scene: w[ratio].find(x => x.n === k + 1)?.scene ?? '', colors: s.colors };
  });
  return {
    garment: w.product.garment,
    colors: [...draft.colors].sort((a, b) => Number(b.name === draft.main) - Number(a.name === draft.main)).map(c => ({ name: c.name, hex: c.hex, sku: c.pick })),
    main: {
      square: main('square'), portrait: main('portrait'),
      poster: draft.counts.poster ? [{ role: '海报', title: draft.poster.title, subtitle: draft.poster.sub, bullets: [], scene: w.poster.scene, colors: [draft.main] }] : [],
    },
    sku: w.sku, extra: draft.extra, direct: input.direct, images: input.images, model: input.model,
  };
}
