import { z } from 'zod';
const id = z.string().min(1).max(180);
const text = z.string().min(1).max(4000);
const region = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict();
export const planSchema = z.object({
  schema: z.literal('b-plan-v1'),
  imageAssessments: z.array(z.object({ imageId: id, kind: z.enum(['artwork', 'photo', 'reference', 'unknown']), region: region.nullable(), observation: text }).strict()).max(32),
  artworks: z.array(z.object({ id, requirementQuote: text, applications: z.array(text).min(1).max(40), outputStepId: id.nullable(), blockedReason: text.optional() }).strict()).min(1).max(20),
  steps: z.array(z.object({ id, artworkId: id, capabilityId: id,
    inputs: z.array(z.object({ kind: z.enum(['image', 'step']), id, role: z.enum(['content', 'font', 'layout', 'color']) }).strict()).max(32),
    params: z.object({
      background: z.enum(['transparent', 'white']).optional(), backgroundAuthorizationQuote: text.optional(), crop: region.optional(), text: z.string().min(1).max(500).optional(), fontId: id.optional(), fontAuthorizationQuote: text.optional(), styleProposal: z.boolean().optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/iu).optional(),
      layout: z.object({ kind: z.enum(['line', 'arc']), align: z.enum(['left', 'center', 'right']), degrees: z.number().positive().max(180).optional(), direction: z.enum(['up', 'down']).optional() }).strict().optional(),
      placements: z.array(z.object({ inputId: id, x: z.number().min(0), y: z.number().min(0), width: z.number().positive(), height: z.number().positive() }).strict()).max(32).optional(),
    }).strict(), reason: text,
  }).strict()).max(80),
  excludedImages: z.array(z.object({ imageId: id, requirementQuote: text }).strict()).max(32),
  reviewNotes: z.array(text).max(30),
}).strict();

// JSON mode is not schema validation. The same schema goes to the model and the local parser.
export const planJSONSchema = z.toJSONSchema(planSchema);
