import { z } from 'zod';
import { assertArtworkDraft, artworkGraphicLayers, artworkTextLayers, type ArtworkBounds, type ArtworkDraft, type ArtworkTextLayer } from './artwork-editor';
import { defaultPrintSize, MOCKUP_SIZE_POLICY, printSizeCm } from './production-sizing';
import { printedTextHeights } from './production-legibility';
import type { ProductionPlacement } from './wps-production';

export const artworkPrintPlacementSchema = z.object({
  key: z.enum(['leftChest', 'rightChest', 'frontCenter', 'back', 'leftSleeve', 'rightSleeve']),
  catalogPosition: z.enum(['frontCenter', 'upperBack', 'backCenter', 'apronUpper', 'apronPocket']).optional(),
  sizeMode: z.enum(['standard', 'widthCm', 'heightCm']).optional(),
  widthCm: z.number().positive().max(55),
  heightCm: z.number().positive().max(100).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.sizeMode === 'heightCm' && !value.heightCm) context.addIssue({ code: 'custom', message: `指定高度模式缺少有效 heightCm：${value.heightCm}`, path: ['heightCm'] });
});
export type ArtworkPrintPlacement = z.infer<typeof artworkPrintPlacementSchema>;

export function artworkPrintPlacement(placement: ProductionPlacement | null): ArtworkPrintPlacement | undefined {
  if (!placement) return undefined;
  return artworkPrintPlacementSchema.parse({ key: placement.key, catalogPosition: placement.catalogPosition, sizeMode: placement.sizeMode, widthCm: placement.widthCm, heightCm: placement.heightCm });
}

// Only unspecified sizes may grow, within these conservative draft limits.
export function automaticArtworkLimits(placement: Pick<ProductionPlacement, 'key' | 'catalogPosition'>) {
  if (placement.key === 'leftChest' || placement.key === 'rightChest') return { width: 9, height: 9 };
  if (placement.key === 'leftSleeve' || placement.key === 'rightSleeve') return { width: 7, height: 7 };
  return defaultPrintSize(placement);
}

export function artworkPrintInstruction(placement?: ArtworkPrintPlacement) {
  if (!placement) return '';
  const box = defaultPrintSize(placement);
  const limit = automaticArtworkLimits(placement);
  const size = placement.sizeMode === 'widthCm' ? `本次已确定整组宽 ${placement.widthCm} cm，不得擅自扩大。`
    : placement.sizeMode === 'heightCm' ? `本次已确定整组高 ${placement.heightCm} cm，不得擅自扩大。`
      : `整组默认装入 ${box.width} × ${box.height} cm；需要容纳文字时可在 ${limit.width} × ${limit.height} cm 内自动安排。`;
  return `【上衣后的可读性｜系统排版约束】\n衣身宽统一按 55 cm；${size}\n设计时先考虑缩放到上述厘米尺寸后的文字，中文实际字高优先 1 cm、最低 0.8 cm，英文数字优先 0.65 cm、最低 0.6 cm。先分配文字空间，再安排图形和间距，避免大图形配一行不可读小字；不得压扁字体、删减文字或改变客户指定颜色。若文字太长或尺寸冲突，明确说明，不把过小文字当作可直接生产。这是项目排版建议，不是生产工艺验收。`;
}

type TextMeasurement = { bounds: ArtworkBounds; letters: { char: string; height: number }[] };
type MeasureText = (text: ArtworkTextLayer) => TextMeasurement;
export type PrintedArtworkLayout = { draft: ArtworkDraft; placement: ProductionPlacement; automaticWidthCm?: number; summary: string; needsReview: boolean };

function unionBounds(rectangles: ArtworkBounds[]): ArtworkBounds {
  const left = Math.min(...rectangles.map(rect => rect.left));
  const top = Math.min(...rectangles.map(rect => rect.top));
  return { left, top, width: Math.max(...rectangles.map(rect => rect.left + rect.width)) - left, height: Math.max(...rectangles.map(rect => rect.top + rect.height)) - top };
}
function graphicBounds(graphic: ArtworkDraft['graphic']): ArtworkBounds {
  const angle = graphic.rotation * Math.PI / 180;
  const width = Math.abs(graphic.width * Math.cos(angle)) + Math.abs(graphic.height * Math.sin(angle));
  const height = Math.abs(graphic.width * Math.sin(angle)) + Math.abs(graphic.height * Math.cos(angle));
  return { left: graphic.x - width / 2, top: graphic.y - height / 2, width, height };
}
function draftBounds(draft: ArtworkDraft, measure: MeasureText) {
  return unionBounds([...artworkGraphicLayers(draft).filter(graphic => graphic.visible !== false).map(graphicBounds), ...artworkTextLayers(draft).filter(text => text.visible !== false).map(text => measure(text).bounds)]);
}

function arrangedDraft(original: ArtworkDraft, factor: number, measure: MeasureText) {
  const draft = structuredClone(original);
  const text = draft.text!;
  text.fontSize = Math.min(300, text.fontSize * factor);
  text.letterSpacing *= factor;
  const graphic = graphicBounds(draft.graphic);
  const bounds = measure(text).bounds;
  const gap = 32;
  // Preserve explicit direction and letter styling. Only allocate size and spacing.
  if (draft.layout.preset === 'vertical') {
    draft.graphic.x = 0; draft.graphic.y = graphic.height / 2;
    text.x -= bounds.left + bounds.width / 2;
    text.y += graphic.height + gap - bounds.top;
  } else {
    const reversed = draft.layout.preset === 'horizontalReverse';
    draft.graphic.x = reversed ? bounds.width + gap + graphic.width / 2 : graphic.width / 2;
    draft.graphic.y = 0;
    text.x += (reversed ? 0 : graphic.width + gap) - bounds.left;
    text.y -= bounds.top + bounds.height / 2;
  }
  draft.layout.gap = gap;
  // Fit the editing canvas without changing glyph proportions or clipping content.
  const combined = draftBounds(draft, measure);
  const scale = Math.min(1, 880 / combined.width, 880 / combined.height);
  draft.graphic.x *= scale; draft.graphic.y *= scale;
  draft.graphic.width *= scale; draft.graphic.height *= scale;
  text.x *= scale; text.y *= scale; text.fontSize *= scale; text.letterSpacing *= scale; text.boxWidth *= scale;
  const resized = draftBounds(draft, measure);
  const dx = 512 - resized.left - resized.width / 2;
  const dy = 512 - resized.top - resized.height / 2;
  draft.graphic.x += dx; draft.graphic.y += dy; text.x += dx; text.y += dy;
  return draft;
}

export function fitArtworkForPrint(original: ArtworkDraft, placement: ProductionPlacement, measure: MeasureText): PrintedArtworkLayout {
  assertArtworkDraft(original);
  const unchanged = (summary: string, needsReview = true): PrintedArtworkLayout => ({ draft: original, placement, summary, needsReview });
  if (!original.text || original.extraGraphics?.length || original.extraTexts?.length || original.layout.preset === 'custom') {
    return unchanged(original.mode === 'legacyFlattened' || original.extraGraphics?.some(graphic => graphic.role === 'styledText')
      ? '制作要求已包含上衣字高约束；合并图或特殊字形需核对实际小字，未冒充自动测量通过。'
      : !original.text ? '保留原图图形；图中若有文字，需核对实际字高，未自动改变品牌结构。' : '保留已有多组件或自定义版式，需核对实际小字。');
  }
  const automatic = !placement.sizeMode || placement.sizeMode === 'standard';
  const limit = automaticArtworkLimits(placement);
  // Aim for recommended height first. The minimum is only a fallback for tight spaces.
  for (const recommended of [true, false]) for (const factor of [1, 1.5, 1.25, 1.75, 2]) {
    const draft = arrangedDraft(original, factor, measure);
    if (draft.text!.fontSize < 8 || draft.text!.boxWidth < 20) continue;
    const bounds = draftBounds(draft, measure);
    const letters = measure(draft.text!).letters;
    if (!letters.length) return unchanged('没有可测量的字形，需核对原图文字。');
    const aspect = bounds.width / bounds.height;
    const starting = printSizeCm(placement, aspect);
    const heights = printedTextHeights(letters, bounds.height, starting.height);
    const enlargement = Math.max(1, ...heights.map(group => (recommended ? group.recommended : group.minimum) / group.heightCm));
    if (!automatic && enlargement > 1.001) continue;
    const width = Math.ceil(starting.width * (automatic ? enlargement : 1) * 10 - .000001) / 10;
    const nextPlacement: ProductionPlacement = automatic ? { ...placement, sizePolicy: MOCKUP_SIZE_POLICY, sizeMode: 'widthCm', widthCm: width } : placement;
    const size = printSizeCm(nextPlacement, aspect);
    if (automatic && (size.width > limit.width || size.height > limit.height)) continue;
    const measured = printedTextHeights(letters, bounds.height, size.height);
    if (measured.some(group => group.heightCm + .001 < (recommended ? group.recommended : group.minimum))) continue;
    assertArtworkDraft(draft);
    return { draft, placement: nextPlacement, ...(automatic ? { automaticWidthCm: width } : {}), needsReview: false,
      summary: `已按上衣尺寸自动排版：整组 ${size.width.toFixed(1)} × ${size.height.toFixed(1)} cm；${measured.map(group => `${group.name}字高约 ${group.heightCm.toFixed(2)} cm`).join('，')}。${automatic ? '' : '已保留指定尺寸。'}` };
  }
  return unchanged('文字长度与当前印花尺寸冲突，自动排版无法达到最低字高；保留客户内容和指定尺寸，请核对版式，不能直接按小字方案生产。');
}
