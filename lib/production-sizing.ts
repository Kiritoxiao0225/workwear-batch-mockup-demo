import { z } from 'zod';
import type { ProductionPlacement } from './wps-production';

export const MOCKUP_BODY_WIDTH_CM = 55;
export const MOCKUP_SIZE_POLICY = 'body-55-v1' as const;
export const MISSING_BODY_SCALE_MESSAGE = '无法确定衣身宽度，请到素材库核对并确认该面左右腋点，再重新读取预览';
export class GarmentBodyScaleError extends Error {
  constructor() { super(MISSING_BODY_SCALE_MESSAGE); }
}
export const bodyScaleSchema = z.object({
  widthRatio: z.number().positive().max(1),
  basis: z.enum(['confirmed-armpits', 'alpha-torso-v1']),
  // An independently adopted width keeps its immutable catalog confirmation.
  // It does not replace the task's placement standard or its manual positions.
  standardId: z.uuid().optional(),
}).strict();

export function defaultPrintSize(placement: Pick<ProductionPlacement, 'key' | 'catalogPosition'>) {
  if (placement.key === 'back') return placement.catalogPosition === 'upperBack' ? { width: 8, height: 4 } : { width: 26, height: 30 };
  if (placement.key === 'frontCenter') return { width: 24, height: 28 };
  if (placement.key === 'leftSleeve' || placement.key === 'rightSleeve') return { width: 6, height: 6 };
  return { width: 7, height: 7 };
}

// Dimensions refer to the entire visible artwork, including its text, before rotation.
export function printSizeCm(placement: ProductionPlacement, aspectRatio: number) {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) throw new Error(`图案宽高比无效：${aspectRatio}`);
  const requested = !placement.sizeOverride ? placement.requestedSize : undefined;
  if (requested) placement = { ...placement, sizeMode: requested.axis, [requested.axis]: requested.valueCm };
  const box = defaultPrintSize(placement);
  const width = placement.sizeMode === 'widthCm' ? placement.widthCm
    : placement.sizeMode === 'heightCm' ? (placement.heightCm ?? NaN) * aspectRatio
      : Math.min(box.width, box.height * aspectRatio);
  const height = width / aspectRatio;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 55 || height > 100) throw new Error(`图案尺寸无效：宽 ${width} cm，高 ${height} cm`);
  return { width, height };
}
