/**
 * 电商主图: what the page sends at 「开始出图」, checked by the server before credits are held. The
 * shape is lib/listing/draft.ts's Draft; the limits are the page's.
 */
import { z } from 'zod';
import { POINT_TYPES, TASKS } from './category';
import { LIMITS, type Draft } from './draft';

const words = (max: number) => z.string().trim().max(max).default('');
export const countsSchema = z.object({
  square: z.number().int().min(1).max(5),
  portrait: z.number().int().min(0).max(5),
  long: z.number().int().min(0).max(1),
}).refine(c => c.portrait <= c.square, '3:4 不能比 1:1 多');

const pointSchema = z.object({
  id: z.string().min(1).max(40), text: z.string().trim().min(1).max(LIMITS.title), note: words(LIMITS.sub), type: z.enum(POINT_TYPES),
  concept: z.string().max(40).nullable(), group: z.string().max(8), source: z.enum(['素材', '品类']), kind: z.enum(['衣服', '服务']), on: z.boolean(),
  seen: z.enum(['有', '看不出', '不像']).optional(), seenWhy: z.string().max(120).optional(), folded: z.boolean().optional(),
  proof: z.string().max(40), part: z.string().max(12).default(''), why: z.string().max(200).default(''), evidence: z.string().max(200).default(''),
  from: z.array(z.string().max(12)).max(40).default([]), score: z.number(), must: z.boolean().optional(),
});
const slotSchema = z.object({
  task: z.enum(TASKS as [string, ...string[]]), lead: z.string().max(40).nullable(), title: words(LIMITS.title), sub: words(LIMITS.sub),
  tags: z.array(z.string().trim().min(1).max(LIMITS.tag)).max(4).default([]),
  cells: z.array(z.object({ point: z.string().min(1).max(40), proof: z.string().min(1).max(40) })).max(6).default([]),
  act: z.string().max(40).nullable().default(null), colors: z.array(z.string()).max(4).default([]), manual: z.boolean().optional(), why: z.string().max(80).optional(), shopService: z.string().max(20).optional(), theme: z.string().max(12).optional(), score: z.number().default(0),
});
export const draftSchema = z.object({
  category: z.string().max(40), categoryWhy: z.string().max(300).default(''),
  titles: z.record(z.string(), z.array(z.string().max(LIMITS.title)).max(6)).default({}),
  points: z.array(pointSchema).max(60),
  themes: z.array(z.object({ id: z.string().max(12), title: z.string().max(LIMITS.title), kind: z.enum(['功能', '细节']), points: z.array(z.string().max(40)).max(16), show: z.string().max(200).default('') })).max(8).optional(),
  colors: z.array(z.object({ name: z.string().trim().min(1, '颜色名不能空').max(12, '颜色名最多 12 个字'), hex: z.string().max(16).default(''), pick: z.string({ error: '每个颜色都要有一张衣服图' }).min(1) })).min(1, '至少要有一个颜色').max(12),
  main: z.string().min(1),
  parts: z.array(z.object({ part: z.string().trim().min(1, '部位名不能空').max(12, '部位名最多 12 个字'), pick: z.string().nullable().default(null) })).max(16).default([]),
  slots: z.array(slotSchema).min(2).max(7),
  long: z.object({ title: words(LIMITS.title) }),
  layout: z.string().min(1), counts: countsSchema,
  extra: z.array(z.object({ color: z.string(), layout: z.string().default('') })).max(11).default([]),
  model: z.object({ lead: z.enum(['男', '女']), photos: z.object({ 男: z.string().max(12).optional(), 女: z.string().max(12).optional() }).optional() }),
  scene: z.object({ place: z.string().max(12), sell: z.string().max(12) }).optional(),
  logo: z.object({ mode: z.enum(['不印', 'LOGO', '客户']), label: z.string().max(12).optional() }).optional(),
});
/** A checked plan has the page's shape. */
export type SubmittedDraft = Draft;
