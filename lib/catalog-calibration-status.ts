import { z } from 'zod';
import { POSITION_LABELS, type CatalogItem } from './catalog';

const positionKey = z.enum(Object.keys(POSITION_LABELS) as [keyof typeof POSITION_LABELS, ...Array<keyof typeof POSITION_LABELS>]);
export const calibrationFaceSchema = z.object({
  face: z.enum(['front', 'back']),
  status: z.enum(['unmarked', 'draft', 'confirmed']),
  positions: z.array(positionKey),
  confirmedPositions: z.array(positionKey),
  origin: z.string().nullable(),
});
export type CalibrationFace = z.infer<typeof calibrationFaceSchema>;
export function calibrationStatus(item: Pick<CatalogItem, 'faceCount' | 'confirmedFaces' | 'hasDraft'>) {
  if (item.hasDraft) return { key: 'draft', symbol: '◐', label: '草稿待确认' };
  if (item.faceCount > 0 && item.confirmedFaces === item.faceCount) return { key: 'confirmed', symbol: '✓', label: '已确认' };
  if (item.confirmedFaces > 0) return { key: 'partial', symbol: '◐', label: '部分已确认' };
  return { key: 'unmarked', symbol: '○', label: '未校准' };
}
