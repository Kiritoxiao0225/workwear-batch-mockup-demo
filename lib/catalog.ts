import { z } from 'zod';
import type { CalibrationFace } from './catalog-calibration-status';

export const STRUCTURE_LABELS = {
  unknown: '待确认结构', polo: 'Polo', crewneck: '圆领衫', hoodie: '套头卫衣',
  jacket: '立领外套', shell: '连帽外套 / 冲锋衣', vest: '马甲', cap: '帽子', apron: '围裙',
} as const;
export type StructureType = keyof typeof STRUCTURE_LABELS;
export const POSITION_LABELS = {
  leftChest: '左胸', rightChest: '右胸', frontCenter: '正前面',
  leftSleeve: '左袖', rightSleeve: '右袖', upperBack: '后背上方', backCenter: '后背居中', capFront: '帽子正面', capLeftSide: '帽子左侧', capRightSide: '帽子右侧', capBack: '帽子后面', apronUpper: '围裙上部', apronPocket: '围裙口袋',
} as const;
export type PositionKey = keyof typeof POSITION_LABELS;
export const pointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
export const boxSchema = pointSchema.extend({ width: z.number().positive().max(1), height: z.number().positive().max(1) })
  .refine(b => b.x + b.width <= 1.000001 && b.y + b.height <= 1.000001, '区域超出 0–1 坐标范围');
export type Point = z.infer<typeof pointSchema>;
export type Box = z.infer<typeof boxSchema>;
export const standardSchema = z.object({
  schemaVersion: z.literal(1),
  structureType: z.enum(['unknown', 'polo', 'crewneck', 'hoodie', 'jacket', 'shell', 'vest', 'cap', 'apron']),
  garmentFrame: boxSchema,
  measuredWidthCm: z.number().positive().max(300).nullable(),
  landmarks: z.array(z.object({ key: z.string().min(1).max(60), label: z.string().min(1).max(60), point: pointSchema }).strict()).max(40),
  positions: z.array(z.object({
    key: z.enum(['leftChest', 'rightChest', 'frontCenter', 'leftSleeve', 'rightSleeve', 'upperBack', 'backCenter', 'capFront', 'capLeftSide', 'capRightSide', 'capBack', 'apronUpper', 'apronPocket']),
    anchor: pointSchema, printableArea: boxSchema,
    defaultSize: z.object({ width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict(),
    // SOP garments only: the person's fine-tuning of the print center, in cm from the SOP position.
    offsetCm: z.object({ x: z.number().min(-40).max(40), y: z.number().min(-40).max(40) }).strict().optional(),
    // The placement rule version that offset was set against; absent means sop-v4, the version offsets were introduced in.
    offsetPolicy: z.string().regex(/^sop-v\d+$/).optional(),
  }).strict()).max(12),
  exclusions: z.array(z.object({ id: z.string().min(1).max(60), label: z.string().min(1).max(80), area: boxSchema }).strict()).max(40),
  note: z.string().max(2000),
}).strict();
export type PlacementStandard = z.infer<typeof standardSchema>;
export type CatalogUser = { id: string; displayName: string; email: string; role: 'admin' | 'editor' | 'viewer' };
export type StandardVersion = { id: string; revision: number; status: 'draft' | 'confirmed'; specification: PlacementStandard; createdAt: string; createdBy: string; origin: string; source?: { id: string; colorName: string; revision: number } };
export type CatalogView = { id: string; face: 'front' | 'back'; crop: Box; revision: number; latest: StandardVersion | null; confirmedId: string | null; history: StandardVersion[] };
export type CatalogItem = {
  id: string; styleId: string; styleCode: string; colorName: string; namespace: string; assetVersionId: string; assetVersion: number;
  filename: string; imageUrl: string; thumbnailUrl: string; signedThumbnailUrl?: string; width: number; height: number; calibrationFaces?: CalibrationFace[];
  layout: 'front_back' | 'front_only'; sha256: string; confirmedFaces: number; faceCount: number; hasDraft: boolean;
};
export type CatalogDetail = CatalogItem & { isCurrent: boolean; views: CatalogView[]; sources: { filename: string; url: string }[]; provenance: Record<string, unknown>; versions: { id: string; version: number; createdAt: string; sha256: string }[] };
export type CatalogStyle = { id: string; styleCode: string; namespace: string; referenceVariantId: string | null; colors: CatalogItem[]; matchedIds: string[] };
export const alignmentSchema = z.object({ scaleX: z.number().positive().max(10), scaleY: z.number().positive().max(10), offsetX: z.number().min(-10).max(10), offsetY: z.number().min(-10).max(10) }).strict();
export type CatalogAlignment = z.infer<typeof alignmentSchema>;
export type ReuseFace = { checkId: string | null; face: 'front' | 'back'; crop: Box; status: 'aligned' | 'review' | 'blocked'; reason: string; score: number | null; specification: PlacementStandard | null };
export type ReusePreview = { source: CatalogDetail; colors: { item: CatalogItem; faces: ReuseFace[] }[] };
/** Result of 确认并应用到全款, per color and face. */
export type StyleSyncFace = { face: 'front' | 'back'; state: 'current' | 'updated' | 'applied' | 'own' | 'review' | 'blocked'; reason: string };
export type StyleSync = { sourceVariantId: string; sourceColor: string; colors: { variantId: string; colorName: string; faces: StyleSyncFace[] }[] };

// Inherited versions pin the manual source and only store an image-space transform.
export function projectStandard(source: PlacementStandard, alignment: CatalogAlignment): PlacementStandard {
  const frame = source.garmentFrame;
  const point = (p: Point): Point => ({ x: (frame.x + p.x * frame.width) * alignment.scaleX + alignment.offsetX, y: (frame.y + p.y * frame.height) * alignment.scaleY + alignment.offsetY });
  const size = (s: { width: number; height: number }) => ({ width: s.width * frame.width * alignment.scaleX, height: s.height * frame.height * alignment.scaleY });
  const box = (b: Box): Box => ({ ...point(b), ...size(b) });
  return standardSchema.parse({ ...source, garmentFrame: { x: 0, y: 0, width: 1, height: 1 }, measuredWidthCm: null,
    landmarks: source.landmarks.map(l => ({ ...l, point: point(l.point) })),
    positions: source.positions.map(p => ({ ...p, anchor: point(p.anchor), printableArea: box(p.printableArea), defaultSize: size(p.defaultSize) })),
    exclusions: source.exclusions.map(e => ({ ...e, area: box(e.area) })),
  });
}
export function emptyStandard(): PlacementStandard {
  return { schemaVersion: 1, structureType: 'unknown', garmentFrame: { x: 0, y: 0, width: 1, height: 1 }, measuredWidthCm: null, landmarks: [], positions: [], exclusions: [], note: '' };
}
/** Structures marked by drawing print areas and exclusions straight on the photo, without structure points. */
export const MANUAL_STRUCTURES: StructureType[] = ['cap', 'apron'];
export function allowedPositions(structure: StructureType, face: 'front' | 'back'): PositionKey[] {
  if (structure === 'unknown') return [];
  // Cap sides are the wearer's left and right, seen at the edges of the front photo.
  if (structure === 'cap') return face === 'front' ? ['capFront', 'capLeftSide', 'capRightSide'] : ['capBack'];
  if (structure === 'apron') return face === 'front' ? ['apronUpper', 'apronPocket', 'frontCenter'] : [];
  if (face === 'back') return ['upperBack', 'backCenter'];
  const keys: PositionKey[] = ['leftChest', 'rightChest', 'frontCenter'];
  return structure === 'vest' ? keys : [...keys, 'leftSleeve', 'rightSleeve'];
}
type ProductionSlot = 'frontCenter' | 'leftChest' | 'rightChest' | 'back' | 'leftSleeve' | 'rightSleeve';
/** On caps and aprons a clothing position (as customers and production slots name it) lands on a drawn position. */
const DRAWN_SLOTS: Record<'cap' | 'apron', Partial<Record<ProductionSlot, PositionKey>>> = {
  cap: { frontCenter: 'capFront', leftChest: 'capFront', rightChest: 'capFront', leftSleeve: 'capLeftSide', rightSleeve: 'capRightSide', back: 'capBack' },
  apron: { frontCenter: 'frontCenter', leftChest: 'apronUpper', rightChest: 'apronUpper' },
};
/**
 * The calibrated position a production slot uses. An explicitly chosen position wins when the structure offers it;
 * without a known structure an explicit cap or apron position is still honoured.
 */
export function slotPositionKey(slot: ProductionSlot, requested?: PositionKey, structure?: StructureType): PositionKey {
  const face = slot === 'back' ? 'back' : 'front';
  if (requested && structure && structure !== 'unknown' && allowedPositions(structure, face).includes(requested)) return requested;
  if (structure === 'cap' || structure === 'apron') return DRAWN_SLOTS[structure][slot] ?? (slot === 'back' ? 'backCenter' : slot);
  if (slot === 'back') return requested === 'upperBack' || requested === 'capBack' ? requested : 'backCenter';
  return requested && DRAWN_POSITION_KEYS.has(requested) ? requested : slot;
}
const DRAWN_POSITION_KEYS = new Set<PositionKey>(['capFront', 'capLeftSide', 'capRightSide', 'capBack', 'apronUpper', 'apronPocket']);
/** Production slots that stand for a distinct drawn position on this structure, in slot order. */
export function drawnSlots(structure: StructureType): Array<{ slot: ProductionSlot; key: PositionKey }> {
  if (structure !== 'cap' && structure !== 'apron') return [];
  const seen = new Set<PositionKey>();
  return (['frontCenter', 'leftChest', 'rightChest', 'back', 'leftSleeve', 'rightSleeve'] as const).flatMap(slot => {
    const key = DRAWN_SLOTS[structure][slot];
    if (!key || seen.has(key)) return [];
    seen.add(key); return [{ slot, key }];
  });
}
export function requiredLandmarks(structure: StructureType) {
  if (structure === 'apron') return [{ key: 'bibTop', label: '围裙上缘中心' }, { key: 'bibLeft', label: '画面左上缘' }, { key: 'bibRight', label: '画面右上缘' }, { key: 'waistLeft', label: '画面左腰点' }, { key: 'waistRight', label: '画面右腰点' }, { key: 'hemCenter', label: '下摆中心' }];
  return structure === 'cap'
    ? [{ key: 'crownTop', label: '帽顶' }, { key: 'leftCrown', label: '画面左帽缘' }, { key: 'rightCrown', label: '画面右帽缘' }, { key: 'brimCenter', label: '帽檐中心' }]
    : [{ key: 'neckCenter', label: '领口中心' }, { key: 'leftShoulder', label: '画面左肩点' }, { key: 'rightShoulder', label: '画面右肩点' }, { key: 'leftArmpit', label: '画面左腋点' }, { key: 'rightArmpit', label: '画面右腋点' }, { key: 'hemCenter', label: '下摆中心' }];
}
export function assertConfirmedStandard(spec: PlacementStandard, face: 'front' | 'back') {
  if (spec.structureType === 'unknown') throw new Error('请先确认服装结构类型');
  const keys = new Set(spec.landmarks.map(p => p.key));
  // Caps and aprons are marked by drawing the print areas directly; their structure points place nothing.
  if (!MANUAL_STRUCTURES.includes(spec.structureType)) for (const required of requiredLandmarks(spec.structureType)) if (!keys.has(required.key)) throw new Error(`缺少结构点：${required.label}`);
  if (keys.size !== spec.landmarks.length) throw new Error('结构点 key 重复');
  if (!spec.positions.length) throw new Error('至少需要一个已校准的印制位置');
  if (new Set(spec.positions.map(p => p.key)).size !== spec.positions.length) throw new Error('印制位置重复');
  const allowed = allowedPositions(spec.structureType, face);
  for (const p of spec.positions) {
    if (!allowed.includes(p.key)) throw new Error(`${STRUCTURE_LABELS[spec.structureType]} ${face} 不支持 ${POSITION_LABELS[p.key]}`);
    const b = p.printableArea;
    if (p.anchor.x < b.x || p.anchor.x > b.x + b.width || p.anchor.y < b.y || p.anchor.y > b.y + b.height) throw new Error(`${POSITION_LABELS[p.key]} 锚点不在可印范围内`);
    const logo = { x: p.anchor.x - p.defaultSize.width / 2, y: p.anchor.y - p.defaultSize.height / 2, ...p.defaultSize };
    if (logo.x < b.x - 0.000001 || logo.y < b.y - 0.000001 || logo.x + logo.width > b.x + b.width + 0.000001 || logo.y + logo.height > b.y + b.height + 0.000001) throw new Error(`${POSITION_LABELS[p.key]} 默认尺寸超出可印范围`);
    for (const exclusion of spec.exclusions) {
      const e = exclusion.area;
      if (b.x < e.x + e.width && b.x + b.width > e.x && b.y < e.y + e.height && b.y + b.height > e.y) throw new Error(`${POSITION_LABELS[p.key]} 可印范围与禁区「${exclusion.label}」重叠`);
    }
  }
}
