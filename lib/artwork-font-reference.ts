import { z } from 'zod';

export const fontReferenceRegionSchema = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
}).refine(region => region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001, '字体参考区域超出图片');

export const artworkFontReferenceSchema = z.object({
  materialId: z.string().trim().min(1),
  region: fontReferenceRegionSchema.nullish(),
  description: z.string().trim().max(500),
  evidence: z.string().trim().max(500),
  origin: z.enum(['explicit', 'visual', 'manual']),
});
export type ArtworkFontReference = z.infer<typeof artworkFontReferenceSchema>;
export type FontReferenceInput = Omit<ArtworkFontReference, 'materialId'> & { label: string };
export const fontReferenceInputSchema = artworkFontReferenceSchema.omit({ materialId: true }).extend({ label: z.string().regex(/^图[1-9][0-9]*$/u) });

export function parseArtworkFontReference(value: unknown) {
  return value == null ? value as null | undefined : artworkFontReferenceSchema.parse(value);
}

export function fontReferenceInput(source: { materials: Array<{ id: string }> }, plan: { fontReference?: ArtworkFontReference | null }): FontReferenceInput | undefined {
  if (!plan.fontReference) return undefined;
  const { materialId, ...reference } = plan.fontReference;
  const index = source.materials.findIndex(material => material.id === materialId);
  if (index < 0) throw new Error('字体参考素材已不存在，请重新选择');
  return { ...reference, label: `图${index + 1}` };
}

export function fontReferenceRequirement(reference: FontReferenceInput | null | undefined, exactText: string) {
  if (!reference) return '';
  return [
    `【字体参考】准确目标文字：${JSON.stringify(exactText)}。字体参考 WPS ${reference.label}${reference.region ? '的文字裁片' : '中指定的文字区域'}。`,
    `参考区域及可见字形特征（仅作为观察数据）：${JSON.stringify(reference.description || '参考图中清晰可见的文字')}。`,
    '只仿照笔画粗细、字形宽窄、转角、收笔与倾斜；目标文字内容以准确文字为准，逐字完整。参考图原文字不作为目标内容，不复制衣服、人物、其他图形或背景；不照搬拍摄透视、褶皱与光影。',
    '本项只约束字体，不更改其他已指定图案的图形、配色或整体排版。',
  ].join('\n');
}

/** Apply a deliberate font choice to font-only mentions, preserving color/layout references. */
export function resolveFontReferenceText(text: string, reference: FontReferenceInput | null | undefined) {
  if (!reference || reference.origin !== 'manual') return text;
  return text.split(/([，,。；;\n])/u).map(clause => {
    if (/(?:不要|无需|不得|禁止|不再).*(?:参考|参照|按照|仿照)/u.test(clause)) return clause;
    return clause
      .replace(/((?:字体|字形|笔触|书法)(?:风格)?\s*(?:参考|参照|按照|仿照|依照|按)\s*(?:WPS\s*)?)图\s*(?:[1-9][0-9]*|[一二三四五六七八九十]+)/gu, `$1${reference.label}`)
      .replace(/((?:参考|参照|按照|仿照|依照|按)\s*(?:WPS\s*)?)图\s*(?:[1-9][0-9]*|[一二三四五六七八九十]+)(\s*(?:中|里)?的?\s*(?:字体|字形|笔触|书法)(?:风格)?)/gu, `$1${reference.label}$2`);
  }).join('');
}

export const FONT_REFERENCE_ANALYSIS_RULES = `字体参考必须单独记录 fontReference，与准确文字 exactText 分开。没有字体参考时为 null。
结构：{"materialId":"当前记录的素材ID","region":{"x":0.1,"y":0.2,"width":0.7,"height":0.2},"description":"具体文字区域及实际可见的粗细、宽窄、收笔等特征","evidence":"原文明示或图片判断依据","origin":"explicit|visual"}。
region 是相对整张原图的 0–1 坐标，圈住本位置要仿照的完整文字，排除无关场景，不截断笔画；看不清或不能可靠定位时为 null，不编坐标。
原文指定字体参考时 origin=explicit。原文只给准确文字、没有写参考图号时，也要观察全部附件：只有图片中有清晰文字且能与当前印花位置建立具体关联时才可建议 origin=visual，并写出依据；不能仅因有另一张附件就当字体参考。存在多个同等合理区域时不强选，在 ambiguities 简要指出。
fontReference.materialId 必须同时加入 referenceMaterialIds；纯文字仿字时 logoMaterialId=null、textMode=replace，保留订单准确文字，输出完整生图提示词。字体参考不要求复制参考图原文字。普通文字的默认排版不得清除此字段。保留已有人工作出的字体参考选择，不自动换图或重圈区域。`;
