import { z } from 'zod';
import { POSITION_LABELS, type CatalogItem } from './catalog';

const positionKey = z.enum(Object.keys(POSITION_LABELS) as [keyof typeof POSITION_LABELS, ...Array<keyof typeof POSITION_LABELS>]);
export const calibrationFaceSchema = z.object({
  face: z.enum(['front', 'back']),
  status: z.enum(['unmarked', 'draft', 'confirmed']),
  positions: z.array(positionKey),
  confirmedPositions: z.array(positionKey),
  origin: z.string().nullable(),
  // The confirmed version in use (may differ from a newer draft); lets other colors notice a change.
  confirmedId: z.uuid().nullable().optional(),
  // Where the confirmed version in use comes from: a follower names its source color and whether it is that color's current confirmation.
  confirmedOrigin: z.string().nullable().optional(),
  sourceColor: z.string().nullable().optional(),
  sourceCurrent: z.boolean().nullable().optional(),
});
export type CalibrationFace = z.infer<typeof calibrationFaceSchema>;
export function calibrationStatus(item: Pick<CatalogItem, 'faceCount' | 'confirmedFaces' | 'hasDraft'>) {
  if (item.hasDraft) return { key: 'draft', symbol: '◐', label: '草稿待确认' };
  if (item.faceCount > 0 && item.confirmedFaces === item.faceCount) return { key: 'confirmed', symbol: '✓', label: '已确认' };
  if (item.confirmedFaces > 0) return { key: 'partial', symbol: '◐', label: '部分已确认' };
  return { key: 'unmarked', symbol: '○', label: '未校准' };
}

export type ColorSyncKey = 'reference' | 'following' | 'stale' | 'own' | 'draft' | 'pending';
/**
 * What a mockup of this color uses, in one word: the style's reference color, a follower of its
 * current confirmation, a follower left on an older one, its own points, or nothing stored yet.
 */
export function colorSyncState(referenceVariantId: string | null, item: Pick<CatalogItem, 'id' | 'faceCount' | 'confirmedFaces' | 'hasDraft' | 'calibrationFaces'>) {
  const faces = item.calibrationFaces ?? [];
  const confirmedAll = item.faceCount > 0 && item.confirmedFaces === item.faceCount;
  if (item.id === referenceVariantId) return { key: 'reference' as const, symbol: '★', label: item.hasDraft ? '代表色 · 有草稿待确认' : confirmedAll ? '代表色 · 已确认' : '代表色 · 未确认', effective: confirmedAll };
  const inherited = faces.filter(f => f.confirmedOrigin === 'inherited'), source = inherited[0]?.sourceColor ?? '代表色';
  if (inherited.some(f => !f.sourceCurrent)) return { key: 'stale' as const, symbol: '↻', label: `跟随「${source}」旧版 · 待同步`, effective: false };
  if (inherited.length && inherited.length === faces.length) return { key: 'following' as const, symbol: '●', label: `跟随「${source}」`, effective: true };
  if (faces.some(f => f.confirmedId && f.confirmedOrigin !== 'inherited')) return { key: 'own' as const, symbol: '◆', label: item.hasDraft ? '单独打点 · 有草稿' : confirmedAll ? '单独打点' : '单独打点 · 部分面', effective: confirmedAll };
  if (item.hasDraft) return { key: 'draft' as const, symbol: '◐', label: '草稿待确认', effective: false };
  return { key: 'pending' as const, symbol: '○', label: '未应用', effective: false };
}
