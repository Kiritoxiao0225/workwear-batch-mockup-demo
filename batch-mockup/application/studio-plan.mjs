import { z } from 'zod';
import { fail } from '../adapters/a-files.mjs';

// 图稿生成「开始制作」: read the request and decide how many pictures it asks for, before any
// picture is made. The author confirms the list; each item is then sent as its own request.
export const STUDIO_PLAN_MAX = 8;
export const STUDIO_PLAN_PROMPT = `你帮用户把一段出图要求拆成要出的图片清单。只决定出几张、每张出什么，不画图。

阅读用户原话和全部参考图（按图1、图2…编号）后判断：
1. 原话写明数量（如“出4张”“来3个方案”“两种配色各一张”）时，按写明的数量出。
2. 原话列出几样并列、需要分别成图的东西时，每样一张。例如“图1的人分别穿上图2和图3的衣服”是2张；“红色和蓝色各做一版”是2张。
3. 并列的东西明显要放在同一张图里时（如“把图2和图3放在一起对比”“图1穿上图2的上衣和图3的裤子”），只出1张。
4. 其他情况出1张。不要为了多出图而自行拆分或添加方案。最多${STUDIO_PLAN_MAX}张。

每张的 text 写成能单独拿去出图的完整要求：
- 保留用户原话里与这一张有关的全部要求和措辞，只把“分别”“和”等拆分处改成这一张对应的那一样。
- 引用参考图继续用“图1”“图2”这样的图号，只引用实际存在的图。
- 多张共用的要求（展示方式、背景、风格等）每张都写全，不写“同上”。
- 不自行添加用户没要求的内容，不改写要印制的文字。
name 是给用户看的短名，10个字以内，说清这一张和其他张的区别，如“穿图2夹克”“蓝色版”。

只输出 JSON：{"images":[{"name":"…","text":"…"}]}`;

const planSchema = z.object({
  images: z.array(z.object({ name: z.string().trim().min(1).max(20), text: z.string().trim().min(1).max(4000) }).strict()).min(1).max(STUDIO_PLAN_MAX),
}).strict();

export function validateStudioPlan(value, images) {
  const r = planSchema.safeParse(value);
  if (!r.success) throw fail('AI 拆出的清单格式不对：' + r.error.issues.slice(0, 3).map(i => `${i.path.join('.')} ${i.message}`).join('；'));
  const count = images.length;
  for (const item of r.data.images)
    for (const m of item.text.matchAll(/图\s*([0-9]+)/gu))
      if (Number(m[1]) < 1 || Number(m[1]) > count) throw fail(`AI 拆出的“${item.name}”引用了不存在的图${m[1]}`);
  return r.data.images;
}
