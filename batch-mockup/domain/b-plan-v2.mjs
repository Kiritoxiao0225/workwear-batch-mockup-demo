import { z } from 'zod';
const id = z.string().min(1).max(180), text = z.string().min(1).max(4000);
const region = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict();
export const cutoutIds = ['cutout-mediakit-product', 'cutout-mediakit-general', 'cutout-meitu'];
export const toolIds = ['reuse', 'render-text', 'compose', 'generate-cliproxy', 'enhance-mediakit', ...cutoutIds];
const ref = z.object({ kind: z.enum(['image', 'step']), id, role: z.enum(['content', 'font', 'color', 'layout']) }).strict();
const contentRef = ref.extend({ role: z.literal('content') });
const textParams = z.object({ text: z.string().min(1).max(500), fontId: id, fontAuthorizationQuote: text.optional(), styleProposal: z.boolean().optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/iu), layout: z.object({ kind: z.enum(['line', 'arc']), align: z.enum(['left', 'center', 'right']), degrees: z.number().positive().max(180).optional(), direction: z.enum(['up', 'down']).optional() }).strict() }).strict();
const composeParams = z.object({ background: z.enum(['transparent', 'white']), backgroundAuthorizationQuote: text.optional(),
  placements: z.array(z.object({ inputId: id, x: z.number().min(0), y: z.number().min(0), width: z.number().positive(), height: z.number().positive() }).strict()).min(1).max(32) }).strict();
const toolStep = (capabilityId, inputs, params) => z.object({ id, capabilityId: z.literal(capabilityId), inputs, params, reason: text }).strict();
// Expose the actual per-tool constraints to the model as well as to the validator.
const step = z.discriminatedUnion('capabilityId', [
  toolStep('reuse', z.array(contentRef).length(1), z.object({ crop: region.optional() }).strict()),
  toolStep('render-text', z.array(ref.extend({ kind: z.literal('image'), role: z.enum(['layout', 'color']) })).max(32), textParams),
  toolStep('compose', z.array(contentRef).min(1).max(32), composeParams),
  toolStep('generate-cliproxy', z.array(ref).max(32), z.object({}).strict()),
  ...['enhance-mediakit', ...cutoutIds].map(tool => toolStep(tool, z.array(contentRef).length(1), z.object({}).strict())),
]);
export const planV2Schema = z.object({
  schema: z.literal('b-plan-v2'),
  imageAssessments: z.array(z.object({ imageId: id, kind: z.enum(['artwork', 'photo', 'reference', 'unknown']), region: region.nullable(), observation: text }).strict()).max(32),
  artworks: z.array(z.object({
    id, name: text, requirementQuote: text, applications: z.array(text).min(1).max(40),
    route: z.enum(['preserve_asset', 'local_render', 'model_generate']), reason: text,
    confidence: z.enum(['high', 'medium', 'low']), uncertainties: z.array(text).max(20),
    references: z.array(z.object({ imageId: id, role: z.enum(['content', 'font', 'layout', 'color']), usage: text }).strict()).max(48),
    preserve: z.array(text).min(1).max(30), steps: z.array(step).max(16),
    background: z.object({ timing: z.enum(['none', 'now', 'after_generation']), action: z.enum(['reuse_alpha', 'cutout', 'await_image', 'not_applicable']), capabilityId: z.enum(cutoutIds).nullable(), sourceStepId: id.nullable(), reason: text }).strict(),
    output: z.object({ stepId: id.nullable(), sizing: z.enum(['native', 'chosen', 'pending']), width: z.number().int().min(64).max(8192).nullable(), height: z.number().int().min(64).max(8192).nullable(), background: z.enum(['preserve', 'transparent', 'white']), basis: text, whiteAuthorizationQuote: text.nullable() }).strict(),
    blockedReason: text.nullable(),
  }).strict()).min(1).max(20),
  excludedImages: z.array(z.object({ imageId: id, reason: text }).strict()).max(32),
  reviewNotes: z.array(text).max(30),
}).strict();
export const backgroundSchema = z.object({ schema: z.literal('b-background-v1'), action: z.enum(['skip', 'cutout', 'blocked']), capabilityId: z.enum(cutoutIds).nullable(), reason: text, preserve: z.array(text).min(1), confidence: z.enum(['high', 'medium', 'low']), uncertainties: z.array(text).max(20) }).strict();
export const planV2JSONSchema = z.toJSONSchema(planV2Schema);
export const backgroundJSONSchema = z.toJSONSchema(backgroundSchema);
export const capabilitiesV2 = [
  { id: 'reuse', parameters: '可选crop；只复用/裁切，不恢复清晰度，不改色，不删除图内元素' },
  { id: 'render-text', parameters: 'text、fontId、fontAuthorizationQuote或styleProposal、color、layout(line/arc)；只能准确排新文字，不复刻不存在的字体' },
  { id: 'compose', parameters: 'placements、background；默认透明画布，各层等比放置；不能去除图层已有背景' },
  { id: 'generate-cliproxy', parameters: '{}；C将原样发送A正文和全部实际图片，按当前图稿范围执行，不另写生成prompt' },
  { id: 'enhance-mediakit', parameters: '{}；仅保留原像素且有效像素不足以满足明确目标时考虑；本轮新C保真未验' },
  { id: 'cutout-mediakit-product', parameters: '{}；真实测试中某些完整徽章/内部白字保留较好，但有丢独立附属文字、残底的反例' },
  { id: 'cutout-mediakit-general', parameters: '{}；部分图文的独立文字较product完整，但密集小字仍有严重丢失反例' },
  { id: 'cutout-meitu', parameters: '{}；model_type=2；部分细字保留较好，但内部白字可能被抠成透明洞，渐变浅线也可能损失' },
].map(x => ({ ...x, cReady: false }));

export function cutoutParameters(capabilityId) {
  if (capabilityId === 'cutout-meitu') return { model_type: 2 };
  if (capabilityId === 'cutout-mediakit-product' || capabilityId === 'cutout-mediakit-general') return { scene: capabilityId.endsWith('product') ? 'product' : 'general', need_contour: false, need_crop_background: false, output_format: 'png' };
  throw new Error('未登记的抠图配置');
}
