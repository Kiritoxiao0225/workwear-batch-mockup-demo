/**
 * 电商主图 step two, once the user has fixed every image's words, cards and colours on the plan
 * page: the model describes the garment (so every image draws the same one) and adds each image's
 * scene — background, light, what the people do — around what the plan already decided. Free: it
 * is part of the analysis already paid. The result is what generation reads.
 */
import { z } from 'zod';
import { TASK_LABEL } from '../listing/category';
import { usedSlots } from '../listing/draft';
import type { SubmittedDraft } from '../listing/draft-schema';
import { proofById } from '../listing/proofs';
import { PEOPLE_LABEL, type Layout } from '../listing/templates';
import type { StoredPlan } from './listing-store';

const SYSTEM = `你是淘宝服装类目的资深电商视觉策划。用户已经定好了这款衣服每张主图上的字、每个格子画什么、衣服颜色和有没有人，并挑好了素材：每个颜色一张衣服图、几张结构参考图（领口、拉链、口袋等）。
你的任务：写衣服结构描述，并给每张图补一句场景。只输出 JSON。

规则：
1. garment（衣服结构）逐条写到生图模型能照做的程度：领型、门襟与拉链、分割线、口袋（数量、位置、开口方式）、袖口、下摆、衣长版型、面料质感。以衣服图和结构参考图为准，看不清的不要猜。它会原样写进每一张图的提示词，用来锁死衣服不变。生图时看不到这些素材图，所以不要写图片编号（如“参照 M2”），把形状直接写出来。
2. scene（场景）：一两句话，只写版式和格子没定的东西——光线、人物大致姿态、背景的细节（没人的图写衣服怎么摆、台面什么样）。背景的类型和色调必须守住下面给的「母版背景」：母版是棚拍或纯色底的，就写棚拍或纯色底，不要改成户外或街景。不要写字、颜色名、卡片里的内容和图片编号；不要再写一遍格子里的演示。首图的地点和天气已经由用户定了，首图只写光线和构图。
3. 3:4 和同一序号的 1:1 讲同一件事，场景可以一样，构图按竖版；2:3 长图是手淘推荐流的竖版长图，画面干净、人物完整。
4. SKU 图：tag 写颜色名旁的短标签（如“男女同款”），fabric 写面料小图下方的小字（不超过 6 个字），都只能照抄素材里的说法，没有就留空。
输出：
{ "product": { "name": "", "garment": [""] }, "scenes": [{ "key": "square:1", "scene": "" }], "sku": { "tag": "", "fabric": "" } }`;

type View = { text: string; dataUrl: string };

/** The images to write a scene for, each with what the plan already decided on it. */
export function sceneKeys(draft: SubmittedDraft, layout: Layout) {
  const words = (id: string) => draft.points.find(p => p.id === id)?.text ?? '';
  const say = (i: number, ratio: 'square' | 'portrait') => {
    const s = draft.slots[i], t = layout.templates[s.task as keyof Layout['templates']][ratio];
    const act = s.act ? proofById(s.act)?.recipe : '';
    return `${TASK_LABEL[s.task as keyof typeof TASK_LABEL]}；${PEOPLE_LABEL(t)}；大标题「${s.title}」${s.cells.length ? `；格子：${s.cells.map(c => words(c.point)).join('、')}` : ''}${act ? `；模特演示：${act}` : ''}`;
  };
  // The shop's service image is copied from the shop: nothing to write.
  const keys = usedSlots(draft, draft.counts.square).flatMap((i, k) => draft.slots[i].shopService ? [] : [{ key: `square:${k + 1}`, about: say(i, 'square') }]);
  keys.push(...usedSlots(draft, Math.min(draft.counts.portrait, draft.counts.square)).flatMap((i, k) => draft.slots[i].shopService ? [] : [{ key: `portrait:${k + 1}`, about: say(i, 'portrait') }]));
  if (draft.counts.long) keys.push({ key: 'long:1', about: `长图；${PEOPLE_LABEL(layout.long)}；一行字「${draft.long.title}」` });
  return keys;
}

export function writeRequest(input: { views: View[]; draft: SubmittedDraft; layout: Layout; model: string; product: string }) {
  const { draft, layout } = input;
  const task = `商品：${input.product}。母版「${layout.name}」：${layout.description}。
母版背景：${layout.style.background}；光线：${layout.style.light}。
要写场景的图：
${sceneKeys(draft, layout).map(k => `${k.key}：${k.about}`).join('\n')}

下面是用户挑出的素材图。`;
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [{ type: 'text', text: task }];
  for (const view of input.views) content.push({ type: 'text', text: view.text }, { type: 'image_url', image_url: { url: view.dataUrl } });
  const shown = draft.parts.filter(p => p.pick && p.part !== '正面全身').map(p => p.part);
  const system = SYSTEM + (shown.includes('背面') ? '' : '\n5. 素材里没有背面图，画面不要出现背面角度。');
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 12000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: system }, { role: 'user', content }] };
}

const writeSchema = z.object({
  product: z.object({ name: z.string().default(''), garment: z.array(z.string()).min(1) }),
  scenes: z.array(z.object({ key: z.string(), scene: z.string().default('') })).default([]),
  sku: z.object({ tag: z.string().default(''), fabric: z.string().default('') }).default({ tag: '', fabric: '' }),
});

/** The user's plan with the model's garment and scenes: what generation reads. */
export function buildPlan(content: string, input: { draft: SubmittedDraft; images: StoredPlan['images']; direct: string[]; photos?: Record<string, string>; model: string }): StoredPlan {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw new Error('写出的内容不是完整的 JSON'); }
  const checked = writeSchema.safeParse(raw);
  if (!checked.success) throw new Error(`写出的内容不完整（${[...new Set(checked.error.issues.map(i => String(i.path[0] ?? '结构')))].join('、')}）`);
  const w = checked.data, { draft } = input;
  return {
    draft, garment: w.product.garment, scenes: Object.fromEntries(w.scenes.map(s => [s.key, s.scene.slice(0, 300)])), sku: w.sku,
    colors: [...draft.colors].sort((a, b) => Number(b.name === draft.main) - Number(a.name === draft.main)).map(c => ({ name: c.name, hex: c.hex, sku: c.pick! })),
    direct: input.direct, photos: input.photos ?? {}, images: input.images, model: input.model, round: 1,
  };
}
