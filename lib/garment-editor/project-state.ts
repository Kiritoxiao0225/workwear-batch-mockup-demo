import { z } from 'zod';
import type { CustomizationState } from './mockup-types';
import { assertValidMockupElementRelations } from './mockup-element-relations';
import { assertValidMockupMeasurements } from './mockup-measurements';

export const assetUrl = (id: string) => `/api/garment-mockup/assets/${id}`;
export function assetId(url: string) {
  const match = /^\/api\/garment-mockup\/assets\/([0-9a-f-]{36})$/u.exec(url);
  return match && z.uuid().safeParse(match[1]).success ? match[1] : null;
}
const transform = z.object({left:z.number().finite(),top:z.number().finite(),scaleX:z.number().positive().max(1000),scaleY:z.number().positive().max(1000),angle:z.number().finite()});
const element = z.object({
  id:z.string().min(1).max(80), type:z.enum(['product','logo','text']),
  image:z.string().max(200).optional(), imageRef:z.string().max(200).optional(),
  originalImage:z.string().max(200).optional(), originalImageRef:z.string().max(200).optional(),
  face:z.enum(['front','back']).optional(), backOfElementId:z.string().max(80).optional(),
  placedOnProductId:z.string().max(80).nullable().optional(),
  placement:z.enum(['custom','left_chest','right_chest','front_center','upper_back','back_center']).optional(),
  relativeTransform:z.object({x:z.number().finite(),y:z.number().finite(),scaleX:z.number().positive().max(1000),scaleY:z.number().positive().max(1000),angle:z.number().finite()}).optional(),
  garmentGeometry:z.object({version:z.literal(2),garmentBounds:z.object({x:z.number(),y:z.number(),width:z.number().positive(),height:z.number().positive()}),bodyCenterX:z.number(),bodyWidth:z.number().positive(),chestY:z.number(),confidence:z.enum(['high','medium'])}).optional(),
  text:z.string().max(5000).optional(), fontFamily:z.string().max(160).optional(),
  fontWeight:z.enum(['normal','bold']).optional(),fontStyle:z.enum(['normal','italic']).optional(),
  textUnderline:z.boolean().optional(),textAlign:z.enum(['left','center','right']).optional(),textColor:z.string().max(100).optional(),
  textGradient:z.object({type:z.literal('linear'),angle:z.number().finite(),stops:z.array(z.object({id:z.string().max(80),color:z.string().max(100),position:z.number().min(0).max(100)})).min(2).max(20)}).optional(),
  arcMode:z.enum(['none','up','down']).optional(),arcRadius:z.number().finite().optional(),arcBend:z.number().finite().optional(),letterSpacing:z.number().finite().optional(),
  transform:transform.optional(),blendMode:z.boolean().optional(),visible:z.boolean().optional(),
});
export function parseProjectState(value: unknown): CustomizationState {
  const parsed = z.object({elements:z.array(element).max(150), measurements:z.unknown().optional()}).parse(value);
  const state = parsed as CustomizationState;
  if (new Set(state.elements.map(e=>e.id)).size !== state.elements.length) throw new z.ZodError([{code:'custom',path:[],message:'画布元素编号重复'}]);
  for(const e of state.elements) {
    if(e.type!=='text' && !e.image) throw new z.ZodError([{code:'custom',path:[],message:'图片元素缺少文件'}]);
    for(const field of ['image','imageRef','originalImage','originalImageRef'] as const) {
      if(e[field] && !assetId(e[field]!)) throw new z.ZodError([{code:'custom',path:[],message:'工程只能引用当前成衣效果图的文件'}]);
    }
  }
  assertValidMockupElementRelations(state.elements);
  assertValidMockupMeasurements(state.measurements,state.elements);
  return state;
}
export function stateAssets(state: CustomizationState) {
  return [...new Set(state.elements.flatMap(e=>[e.image,e.originalImage,e.imageRef,e.originalImageRef].filter(Boolean).map(v=>assetId(v!)!)))];
}
