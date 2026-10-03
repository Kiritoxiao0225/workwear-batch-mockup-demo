/**
 * 电商主图 planning: one model call reads every uploaded image, sorts it (主图 / SKU / 详情 / 尺码表 /
 * 不用) and plans the copy for each image of the chosen layout. Ported from the validated
 * output/listing-studio-demo-20260929/plan.mjs (37/37 on the shuffled-folder benchmark).
 */
import { z } from 'zod';
import { ASSET_ROLES, MAIN_ROLES, rolesFor, type ListingCounts, type ListingLayout } from '../listing/layouts';

export type PlanImage = { id: string; name: string; folder: string; shape: '1:1' | '3:4' | '其他'; width: number; height: number; dataUrl: string };

const SYSTEM = `你是淘宝服装类目的资深电商视觉策划。你会收到同一款商品的全部素材图，每张图前面标了编号。
你的任务：先给每张素材分类，再读懂这件商品，为它策划一套主图和 SKU 图的文案。只输出 JSON。

规则：
0. 素材分类（assets）：每张图都要分类，一张不漏。role 只能是：主图（带模特或场景的商品展示图，含方图和竖图）、SKU（单个颜色的商品图，用来区分颜色款）、详情（详情页切图：卖点说明、面料、细节、参数等）、尺码表（尺码数字表格）、不用（二维码、客服/好评/聊天截图、店铺公告、与本款无关的其他商品、看不清的图）。所在文件夹名只是提示，可能放错，一律以图的内容为准。区分主图和详情先看形状（每张图前面写了程序量出来的形状）：淘宝主图只有 1:1 和 3:4 两种，所以形状是 1:1 或 3:4 的图判为主图或 SKU，哪怕画面是细节特写拼排、写满卖点；形状是“其他”的图一律不是主图也不是 SKU（多半是详情切片，即使画面像海报）。只有空白图、二维码、平台价格说明、与本款无关的图判为不用；尺码数字表格判为尺码表。SKU 图写出 color（颜色名）；同一颜色有多张 SKU 图时选最清楚的一张放进 product.colors，其余标详情或不用。reason 用一句话说明判断依据。标为“不用”的图不得出现在 evidence、refs、sku 里。
1. 事实只能来自素材：面料、功能、参数、服务都必须在素材里出现过，并在 evidence 里写出处编号；看不清的不要猜，不要编造数据、认证和销量。原主图上的大字主打卖点（如首图标题和标签）必须进卖点库，并排在最前面优先使用。
2. 文案全部重新写：意思可以沿用，但不能照抄素材原句。主标题不超过 10 个字，副标题不超过 16 个字，要点每条不超过 10 个字。
3. 素材可能来自别家店铺：不要写任何品牌名、店铺名，也不要描述或保留任何 logo、水印。
4. garment（衣服结构）要逐条写到生图模型能照做的程度：领型、门襟与拉链、分割线、口袋（数量、位置、开口方式）、袖口、下摆、衣长版型、面料质感。它会原样写进每一张图的提示词，用来锁死衣服不变。
5. 主图按给定的角色顺序出。每张 1–2 个卖点，同一组内卖点不重复，前后连贯像一个故事；scene 写这张图用什么画面直观演示卖点（比如水珠演示防泼水、拉扯演示抗撕裂、手机放进口袋演示收纳）。
6. 3:4 主图与 1:1 讲同一套卖点，文案可以微调。2:3 是店铺首页海报，氛围感最强。
7. 多色图（多人或多件同框）最多 4 种颜色，在该图的 colors 里列出用到的颜色名，名字必须和 product.colors 里的完全一致；单色图的 colors 只写主色。
8. SKU 图每个颜色一张，tag 写颜色名旁的短标签（如“男女同款”），fabric 写面料小图下方的小字（不超过 6 个字，如“三防面料”），都只能用素材里有依据的说法，没有依据就留空。

输出 JSON 结构：
{
  "assets": [{ "id": "M1", "role": "主图|SKU|详情|尺码表|不用", "color": "", "reason": "" }],
  "product": { "name": "", "category": "", "audience": "", "fabric": "", "garment": [""], "colors": [{ "name": "", "hex": "", "sku": "M3" }] },
  "sellingPoints": [{ "id": "P1", "type": "定位|功能|做工|实用|颜色款式|人群场景|服务定制", "text": "", "evidence": ["M1"], "priority": 1 }],
  "main": {
    "square":   [{ "n": 1, "role": "首图", "points": ["P1"], "title": "", "subtitle": "", "bullets": [""], "scene": "", "colors": [""] }],
    "portrait": [ 同上 ],
    "poster":   [ 同上 ]
  },
  "sku": { "tag": "", "fabric": "", "items": [{ "color": "", "sku": "M3" }] }
}`;

const roleText = (count: number) => rolesFor(count).map((r, i) => `${i + 1}. ${r}：${MAIN_ROLES[r]}`).join('\n');

export function planRequest(input: { images: PlanImage[]; counts: ListingCounts; layout: ListingLayout; model: string }) {
  const { counts, layout } = input;
  const task = `这一款用「${layout.name}」版式：${layout.style}

本次要出的图（淘宝）：
${counts.square ? `- 1:1 主图 ${counts.square} 张，角色顺序：\n${roleText(counts.square)}` : '- 不出 1:1 主图（main.square 为空数组）'}
${counts.portrait ? `- 3:4 主图 ${counts.portrait} 张，角色顺序：\n${roleText(counts.portrait)}` : '- 不出 3:4 主图（main.portrait 为空数组）'}
${counts.poster ? '- 2:3 首页海报 1 张' : '- 不出 2:3 海报（main.poster 为空数组）'}
- SKU 图：每个颜色一张

下面是全部素材图。`;
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [{ type: 'text', text: task }];
  for (const image of input.images) {
    content.push({ type: 'text', text: `【${image.id}】形状：${image.shape}（${image.width}×${image.height}），所在文件夹：${image.folder || '（根目录）'}，文件名：${image.name}` },
      { type: 'image_url', image_url: { url: image.dataUrl } });
  }
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 16000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }] };
}

const slotSchema = z.object({
  n: z.number().int(), role: z.string(), points: z.array(z.string()).default([]),
  title: z.string(), subtitle: z.string().default(''), bullets: z.array(z.string()).default([]),
  scene: z.string().default(''), colors: z.array(z.string()).default([]),
});
const planSchema = z.object({
  assets: z.array(z.object({ id: z.string(), role: z.enum(ASSET_ROLES), color: z.string().default(''), reason: z.string().default('') })),
  product: z.object({
    name: z.string(), category: z.string().default(''), audience: z.string().default(''), fabric: z.string().default(''),
    garment: z.array(z.string()).min(1),
    colors: z.array(z.object({ name: z.string().min(1), hex: z.string().default(''), sku: z.string() })),
  }),
  sellingPoints: z.array(z.object({ id: z.string(), type: z.string().default(''), text: z.string(), evidence: z.array(z.string()).default([]), priority: z.number().default(99) })),
  main: z.object({ square: z.array(slotSchema).default([]), portrait: z.array(slotSchema).default([]), poster: z.array(slotSchema).default([]) }),
  sku: z.object({ tag: z.string().default(''), fabric: z.string().default(''), items: z.array(z.object({ color: z.string(), sku: z.string() })).default([]) }),
});
export type ListingPlan = z.infer<typeof planSchema>;

/**
 * Parse the model output and apply the program's own rules. `problems` non-empty means the plan
 * is not safe to generate from: the user sees them in the confirmation step.
 */
export function parsePlan(content: string, images: Pick<PlanImage, 'id' | 'shape'>[]) {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw new Error('分析结果不是完整的 JSON'); }
  const checked = planSchema.safeParse(raw);
  // The schema's own messages are for developers; the user only needs to know it was incomplete.
  if (!checked.success) throw new Error(`缺少必要内容（${[...new Set(checked.error.issues.map(i => String(i.path[0] ?? '结构')))].join('、')}）`);
  const plan = checked.data;
  // A shape that cannot be a Taobao main image or SKU image is a detail slice, whatever the model said.
  const shape = new Map(images.map(image => [image.id, image.shape]));
  const corrected: string[] = [];
  for (const a of plan.assets) {
    if ((a.role === '主图' || a.role === 'SKU') && shape.get(a.id) === '其他') { corrected.push(`${a.id} ${a.role}→详情（形状不是 1:1 或 3:4）`); a.role = '详情'; }
  }
  const role = new Map(plan.assets.map(a => [a.id, a.role]));
  const problems: string[] = [];
  for (const image of images) if (!role.has(image.id)) problems.push(`${image.id} 没有分类`);
  for (const c of plan.product.colors) if (role.get(c.sku) !== 'SKU') problems.push(`颜色「${c.name}」对应的 ${c.sku} 不是 SKU 图`);
  if (!plan.product.colors.length) problems.push('没有认出任何颜色');
  const cited = [...plan.sellingPoints.flatMap(p => p.evidence), ...plan.sku.items.map(i => i.sku)];
  for (const id of new Set(cited)) if (role.get(id) === '不用') problems.push(`${id} 标为不用却被引用`);
  const colorNames = new Set(plan.product.colors.map(c => c.name));
  for (const slot of [...plan.main.square, ...plan.main.portrait, ...plan.main.poster]) {
    for (const name of slot.colors) if (!colorNames.has(name)) problems.push(`第 ${slot.n} 张图用了不存在的颜色「${name}」`);
    if (slot.colors.length > 4) problems.push(`第 ${slot.n} 张图用了 ${slot.colors.length} 种颜色，最多 4 种`);
  }
  return { plan, corrected, problems };
}
