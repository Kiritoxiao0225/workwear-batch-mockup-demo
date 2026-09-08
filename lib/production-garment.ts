import { bodyScaleSchema, MOCKUP_BODY_WIDTH_CM, MOCKUP_SIZE_POLICY, printSizeCm } from './production-sizing';
import { bindPrintSizeRequest } from './print-size-request';
import type { PlacementKey } from '@/lib/types';
import { z } from 'zod';
import { boxSchema, POSITION_LABELS, standardSchema, type CatalogDetail, type CatalogStyle, type PositionKey } from '@/lib/catalog';
import type { GenerationUnit, SourceTaskRecord } from '@/lib/batch-task-review';
import type { ProductionPlacement } from '@/lib/wps-production';

export const garmentBindingSchema = z.object({
  styleId: z.uuid(), variantId: z.uuid(), assetVersionId: z.uuid(), styleCode: z.string().min(1), colorName: z.string().min(1),
  imageUrl: z.string().regex(/^\/api\/catalog\/files\/[\da-f-]+$/), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().positive(), height: z.number().positive(),
  selection: z.enum(['exact', 'family', 'provisional', 'manual']), requestedColor: z.string(), evidence: z.string(),
  views: z.array(z.object({ id: z.uuid(), face: z.enum(['front', 'back']), crop: boxSchema,
    standard: z.object({ id: z.uuid(), specification: standardSchema }).nullable(),
    bodyScale: bodyScaleSchema.optional(),
  }).strict()),
}).strict();
export type GarmentBinding = z.infer<typeof garmentBindingSchema>;
export const garmentRequestSchema = z.object({ styleCode: z.string().max(200), colorText: z.string().max(100), sizeText: z.string().max(100) }).strict();
export type GarmentRequest = z.infer<typeof garmentRequestSchema>;
export type GarmentMatch = { item: CatalogStyle['colors'][number] | null; selection: GarmentBinding['selection']; colorText: string; evidence: string };

const genericFamilies: Record<string, string> = { 黑: '黑', 黑色: '黑', 白: '白', 白色: '白', 红: '红', 红色: '红', 蓝: '蓝', 蓝色: '蓝', 兰色: '蓝', 绿: '绿', 绿色: '绿', 黄: '黄', 黄色: '黄', 灰: '灰', 灰色: '灰', 紫: '紫', 紫色: '紫', 粉: '粉', 粉色: '粉', 橙: '橙', 橙色: '橙', 橘色: '橙', 桔色: '橙', 棕色: '棕' };
function compact(value: string) { return value.normalize('NFKC').trim().toUpperCase(); }
function containsCode(text: string, code: string) {
  const escaped = compact(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Z0-9])${escaped}(?![A-Z0-9])`, 'u').test(compact(text));
}
function colorFamily(color: string) {
  const normalized = color.replace(/兰/g, '蓝').replace(/[橘桔]/g, '橙');
  return [...new Set(normalized.match(/[黑白红蓝绿黄灰紫粉橙棕]/g) ?? [])];
}

// Color inference uses the segment immediately following this style, never Logo instructions.
export function matchProductionGarment(source: SourceTaskRecord, unit: Pick<GenerationUnit, 'garmentLabel' | 'productCode' | 'garmentRequest'>, styles: CatalogStyle[]): GarmentMatch {
  const sourceText = `${source.productStyleText}\n${source.requirementText}`;
  const sourceStyles = styles.filter(style => containsCode(sourceText, style.styleCode));
  const requestedCode = unit.garmentRequest?.styleCode || unit.productCode || '';
  const unitStyles = sourceStyles.filter(style => containsCode(unit.garmentLabel, style.styleCode) || compact(style.styleCode) === compact(requestedCode));
  const candidates = unitStyles.length ? unitStyles : sourceStyles;
  const unresolved = (evidence: string, colorText = ''): GarmentMatch => ({ item: null, selection: 'exact', colorText, evidence });
  if (candidates.length !== 1) return unresolved(candidates.length ? '出现多款衣服或同号不同来源，请选择具体款式' : '原文款号未匹配素材库，请选择款式');
  const style = candidates[0];
  const normalizedSource = compact(sourceText);
  const code = compact(style.styleCode);
  const segments: string[] = [];
  for (let index = normalizedSource.indexOf(code); index >= 0; index = normalizedSource.indexOf(code, index + code.length)) {
    const tail = normalizedSource.slice(index + code.length).replace(/^[ \t—:/-]+/u, '');
    segments.push(tail.split(/\n|[，,；;]|(?:左胸|右胸|后背|正面|后脖|左袖|右袖|字体|工艺|尺寸)\s*[:：]?/u)[0].split(/\s+/u)[0]);
  }
  const requested = unit.garmentRequest?.colorText?.trim() ?? '';
  const explicitColors = [...new Set(segments.flatMap(segment => segment.split(/[-—/]/u).filter(token => token && !/^(?:[XSML]+|\d+XL|\d+)$/iu.test(token))))];
  const labelColors = explicitColors.filter(color => compact(unit.garmentLabel).includes(color));
  const colorText = requested && explicitColors.includes(compact(requested)) ? requested
    : labelColors.length === 1 ? labelColors[0] : explicitColors.length === 1 ? explicitColors[0] : '';
  if (explicitColors.length > 1 && !colorText) return unresolved('同款出现多个颜色，请选择该制作单元对应的颜色');
  if (!colorText || /^(?:[XSML]+|\d+XL|\d+)$/iu.test(colorText)) return unresolved('原文未明确衣服颜色，请选择颜色');
  const family = genericFamilies[colorText];
  const exact = style.colors.filter(color => compact(color.colorName) === compact(colorText));
  const familyColors = family ? style.colors.filter(color => colorFamily(color.colorName).length === 1 && colorFamily(color.colorName)[0] === family) : [];
  // Generic colors must consider all colors in the family, even if one is literally called “红色”.
  const colors = family ? familyColors : exact;
  if (!colors.length) return unresolved(`${style.styleCode} 没有匹配“${colorText}”的颜色，请选择`, colorText);
  const selection = colors.length > 1 ? 'provisional' : exact.length ? 'exact' : 'family';
  const item = [...colors].sort((a, b) => a.id.localeCompare(b.id))[0];
  return { item, selection, colorText, evidence: `${style.styleCode} · 原文颜色“${colorText}”${selection === 'provisional' ? `，同色系 ${colors.length} 色，暂选 ${item.colorName}，可修改` : ` → ${item.colorName}`}` };
}

export function bindingFromCatalog(detail: CatalogDetail, match: Pick<GarmentMatch, 'selection' | 'colorText' | 'evidence'>): GarmentBinding {
  return garmentBindingSchema.parse({
    styleId: detail.styleId, variantId: detail.id, assetVersionId: detail.assetVersionId, styleCode: detail.styleCode, colorName: detail.colorName,
    imageUrl: detail.imageUrl, sha256: detail.sha256, width: detail.width, height: detail.height,
    selection: match.selection, requestedColor: match.colorText, evidence: match.evidence,
    views: detail.views.map(view => {
      const confirmed = view.history.find(version => version.id === view.confirmedId && version.status === 'confirmed');
      return { id: view.id, face: view.face, crop: view.crop, standard: confirmed ? { id: confirmed.id, specification: confirmed.specification } : null };
    }),
  });
}

export function catalogPositionKey(placement: ProductionPlacement): PositionKey {
  if (placement.key === 'back') return placement.catalogPosition === 'upperBack' ? 'upperBack' : 'backCenter';
  if (placement.key === 'frontCenter' && (placement.catalogPosition === 'apronUpper' || placement.catalogPosition === 'apronPocket')) return placement.catalogPosition;
  return placement.key;
}
export function productionPositionLabel(placement: ProductionPlacement) {
  return POSITION_LABELS[catalogPositionKey(placement)];
}
export const taskPlacementSchema = z.object({ centerX: z.number().min(0).max(1), centerY: z.number().min(0).max(1), width: z.number().positive().max(1) }).strict();

export function garmentPlacementIssue(garment: GarmentBinding | null | undefined, placement: ProductionPlacement | null) {
  if (!garment) return '请选择素材库中的款式和颜色';
  if (!placement) return '请选择制作位置';
  if (placement.requestedSizeIssue && !placement.sizeOverride) return placement.requestedSizeIssue;
  if (placement.templateVersion !== 'catalog-v1') return '请保存真实衣服的位置方案';
  const face = placement.key === 'back' ? 'back' : 'front';
  const view = garment.views.find(view => view.face === face);
  if (!view) return `该衣服缺少${face === 'front' ? '正面' : '背面'}底图`;
  if (placement.sizePolicy === MOCKUP_SIZE_POLICY && !view.bodyScale) return '无法确定衣身宽度，请在素材库核对左右腋点后更新位置标准';
  if (placement.manual) {
    const parsed = taskPlacementSchema.safeParse(placement.manual);
    if (!parsed.success) return `本次图案位置无效：${JSON.stringify(placement.manual)}`;
    if (placement.sizePolicy !== MOCKUP_SIZE_POLICY && placement.sizeMode !== 'standard' && !view.standard?.specification.measuredWidthCm) return '客户指定了厘米尺寸，需要填写实测衣宽后才能确认；不能用视觉比例代替厘米';
    return null;
  }
  if (!view.standard) return `该颜色${face === 'front' ? '正面' : '背面'}位置尚未校准，请到商品素材库确认后更新位置标准`;
  if (!view.standard.specification.positions.some(position => position.key === catalogPositionKey(placement))) return '该位置没有已确认标准，请调整位置或在商品素材库校准';
  if (placement.sizePolicy !== MOCKUP_SIZE_POLICY && placement.sizeMode !== 'standard' && !view.standard.specification.measuredWidthCm) return '此衣服尚未填写实测衣宽，不能把厘米尺寸换算为底图位置';
  return null;
}

// Shared by browser overlay and Sharp: full image -> face crop -> garment frame -> position.
export function productionPlacementGeometry(garment: GarmentBinding, placement: ProductionPlacement, aspectRatio = 1) {
  const issue = garmentPlacementIssue(garment, placement);
  if (issue) throw new Error(issue);
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) throw new Error(`图案宽高比无效：${aspectRatio}`);
  const view = garment.views.find(view => view.face === (placement.key === 'back' ? 'back' : 'front'))!;
  if (placement.manual) {
    const faceWidth = garment.width * view.crop.width, faceHeight = garment.height * view.crop.height;
    const spec = view.standard?.specification;
    let width = placement.manual.width * faceWidth;
    if (placement.sizePolicy === MOCKUP_SIZE_POLICY) width = printSizeCm(placement, aspectRatio).width / MOCKUP_BODY_WIDTH_CM * faceWidth * view.bodyScale!.widthRatio;
    else if (placement.sizeMode === 'widthCm') width = placement.widthCm / spec!.measuredWidthCm! * faceWidth * spec!.garmentFrame.width;
    else if (placement.sizeMode === 'heightCm') width = (placement.heightCm ?? 0) / spec!.measuredWidthCm! * faceWidth * spec!.garmentFrame.width * aspectRatio;
    const height = width / aspectRatio;
    const radians = placement.rotation * Math.PI / 180;
    const rotatedWidth = Math.abs(Math.cos(radians)) * width + Math.abs(Math.sin(radians)) * height;
    const rotatedHeight = Math.abs(Math.sin(radians)) * width + Math.abs(Math.cos(radians)) * height;
    const bounds = { x: placement.manual.centerX - rotatedWidth / faceWidth / 2, y: placement.manual.centerY - rotatedHeight / faceHeight / 2, width: rotatedWidth / faceWidth, height: rotatedHeight / faceHeight };
    if (!(width > 0) || bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > 1 || bounds.y + bounds.height > 1) throw new Error('图案超出当前衣服视图，请缩小或移回图片内');
    if (spec) {
      const frame = spec.garmentFrame;
      const position = spec.positions.find(position => position.key === catalogPositionKey(placement));
      if (position) {
        const area = position.printableArea;
        const allowed = { x: frame.x + area.x * frame.width, y: frame.y + area.y * frame.height, width: area.width * frame.width, height: area.height * frame.height };
        if (bounds.x < allowed.x || bounds.y < allowed.y || bounds.x + bounds.width > allowed.x + allowed.width || bounds.y + bounds.height > allowed.y + allowed.height) throw new Error('图案超出已确认的可印范围');
      }
      for (const exclusion of spec.exclusions) {
        const area = { x: frame.x + exclusion.area.x * frame.width, y: frame.y + exclusion.area.y * frame.height, width: exclusion.area.width * frame.width, height: exclusion.area.height * frame.height };
        if (bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y) throw new Error(`图案覆盖禁区：${exclusion.label}`);
      }
    }
    return { width, height, centerX: (view.crop.x + placement.manual.centerX * view.crop.width) * garment.width, centerY: (view.crop.y + placement.manual.centerY * view.crop.height) * garment.height };
  }
  const spec = view.standard!.specification;
  const position = spec.positions.find(position => position.key === catalogPositionKey(placement))!;
  const frame = spec.garmentFrame;
  const frameWidth = garment.width * view.crop.width * frame.width;
  const frameHeight = garment.height * view.crop.height * frame.height;
  const radians = placement.rotation * Math.PI / 180;
  const cos = Math.abs(Math.cos(radians)), sin = Math.abs(Math.sin(radians));
  let width: number;
  if (placement.sizePolicy === MOCKUP_SIZE_POLICY) width = printSizeCm(placement, aspectRatio).width / MOCKUP_BODY_WIDTH_CM * garment.width * view.crop.width * view.bodyScale!.widthRatio;
  else if (placement.sizeMode === 'heightCm') width = (placement.heightCm ?? 0) / spec.measuredWidthCm! * frameWidth * aspectRatio;
  else if (placement.sizeMode === 'widthCm') width = placement.widthCm / spec.measuredWidthCm! * frameWidth;
  else width = Math.min(position.defaultSize.width * frameWidth, position.defaultSize.height * frameHeight * aspectRatio);
  const centerX = position.anchor.x + placement.offsetX / 100, centerY = position.anchor.y + placement.offsetY / 100;
  const area = position.printableArea;
  const allowedWidth = 2 * Math.min(centerX - area.x, area.x + area.width - centerX) * frameWidth;
  const allowedHeight = 2 * Math.min(centerY - area.y, area.y + area.height - centerY) * frameHeight;
  const maxWidth = Math.min(allowedWidth / (cos + sin / aspectRatio), allowedHeight / (sin + cos / aspectRatio));
  if (placement.sizeMode === 'standard' && placement.sizePolicy !== MOCKUP_SIZE_POLICY) width = Math.min(width, maxWidth);
  if (!(width > 0) || width > maxWidth + 0.01) throw new Error('图案尺寸或偏移超出已确认的可印范围');
  const height = width / aspectRatio;
  const bounds = { x: centerX - (width * cos + height * sin) / frameWidth / 2, y: centerY - (height * cos + width * sin) / frameHeight / 2,
    width: (width * cos + height * sin) / frameWidth, height: (height * cos + width * sin) / frameHeight };
  for (const { area: exclusion, label } of spec.exclusions) {
    if (bounds.x < exclusion.x + exclusion.width && bounds.x + bounds.width > exclusion.x && bounds.y < exclusion.y + exclusion.height && bounds.y + bounds.height > exclusion.y) throw new Error(`图案覆盖禁区：${label}`);
  }
  return { width, height, centerX: (view.crop.x + view.crop.width * (frame.x + centerX * frame.width)) * garment.width,
    centerY: (view.crop.y + view.crop.height * (frame.y + centerY * frame.height)) * garment.height };
}

export function requestedCatalogPlacement(source: SourceTaskRecord, unit: Pick<GenerationUnit, 'placement' | 'instruction'>): ProductionPlacement | null {
  if (!unit.placement) return null;
  return bindPrintSizeRequest(source.requirementText, { key: unit.placement, widthCm: 10, sizeMode: 'standard',
    offsetX: 0, offsetY: 0, rotation: 0, templateVersion: 'catalog-v1', sizePolicy: MOCKUP_SIZE_POLICY,
    catalogPosition: /后脖|后领/u.test(unit.instruction) ? 'upperBack' : 'backCenter' });
}

// Crop only the preview; compositor coordinates remain in the original image.
export function productionGarmentPreviewCrop(garment: GarmentBinding, placement: { key: PlacementKey } | null) {
  const face = placement?.key === 'back' ? 'back' : 'front';
  const view = garment.views.find(view => view.face === face);
  if (!view) return null;
  return { face, x: view.crop.x * garment.width, y: view.crop.y * garment.height,
    width: view.crop.width * garment.width, height: view.crop.height * garment.height };
}
