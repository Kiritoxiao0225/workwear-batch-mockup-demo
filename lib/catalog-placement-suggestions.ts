import { z } from 'zod';
import { allowedPositions, boxSchema, emptyStandard, requiredLandmarks, standardSchema, type Box, type PlacementStandard, type Point, type PositionKey, type StructureType } from '@/lib/catalog';
import { PROJECTED_BODY_WIDTH_CM, SOP_STRUCTURES, UNMEASURED_TORSO_SHARE, estimatedLandmarks, plausibleTorso, sopEstimatedExclusions, sopStandardPositions, sopStructureFromStandard } from '@/lib/sop-placement';

// Reference types were checked against the 21 styles in normalized-garments-v1.
// They supply editable suggestions, never confirmed image understanding.
const referenceTypes: Record<string, { structure: StructureType; longSleeve?: boolean }> = {
  '103JJ': { structure: 'apron' }, '2401HT': { structure: 'crewneck' }, '2402立领JSH': { structure: 'jacket', longSleeve: true },
  '301SRX': { structure: 'polo' }, '3301SRX': { structure: 'polo', longSleeve: true }, '5166ZC': { structure: 'jacket', longSleeve: true },
  '6片纯棉铜扣XDMY': { structure: 'cap' }, '719SF': { structure: 'jacket', longSleeve: true }, '920CYJD': { structure: 'polo' },
  '9600SRX': { structure: 'crewneck' }, '9920CYJD': { structure: 'polo', longSleeve: true }, 'B01SD': { structure: 'polo' },
  'BT6678JSH': { structure: 'polo' }, 'CX8099NS': { structure: 'polo', longSleeve: true }, 'CYJD-889': { structure: 'crewneck' },
  'JCD33WY': { structure: 'jacket', longSleeve: true }, 'JSH-JSD33': { structure: 'jacket', longSleeve: true },
  'NS-2288': { structure: 'polo', longSleeve: true }, 'Q200WY': { structure: 'crewneck', longSleeve: true },
  'ZC-998': { structure: 'polo' }, '韩领8825JSH': { structure: 'polo', longSleeve: true },
};
export function catalogReferenceType(namespace: string, styleCode: string) {
  return namespace === 'normalized-garments-v1' ? referenceTypes[styleCode] ?? { structure: 'unknown' as const } : { structure: 'unknown' as const };
}
export const placementPreviewSchema = z.object({
  assetVersionId: z.uuid(),
  // bodyWidthRatio: projected torso width as a share of the face crop width, the same measure the composite uses.
  faces: z.array(z.object({ viewId: z.uuid(), frame: boxSchema.nullable(), specification: standardSchema, basis: z.string(), bodyWidthRatio: z.number().positive().max(1).nullable().optional(),
    // recognized: landmark keys found on the image; the rest of an unsaved suggestion are estimates.
    recognized: z.array(z.string()).optional() }).strict()),
}).strict();
export type CatalogPlacementPreview = z.infer<typeof placementPreviewSchema>;
export const structureRecognitionSchema = z.object({
  assetVersionId: z.uuid(),
  // points: crop fractions of each face; recognized lists their keys; error explains a failed model call.
  faces: z.array(z.object({ viewId: z.uuid(), points: z.record(z.string(), z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })), error: z.string().nullable() }).strict()),
}).strict();

function position(key: PositionKey, x: number, y: number, width: number, height: number): PlacementStandard['positions'][number] {
  return { key, anchor: { x: x + width / 2, y: y + height / 2 }, printableArea: { x, y, width, height }, defaultSize: { width: width * .6, height: height * .5 } };
}
function exclusion(id: string, label: string, x: number, y: number, width: number, height: number) {
  return { id, label, area: { x, y, width, height } };
}
export function suggestedPlacement(structure: StructureType, face: 'front' | 'back', frame: Box, longSleeve = false): PlacementStandard {
  const spec = { ...emptyStandard(), structureType: structure, garmentFrame: frame };
  if (structure === 'unknown') return spec;
  const landmarkPoints = structure === 'cap' ? [[.5, .08], [.12, .3], [.88, .3], [.5, .8]]
    : structure === 'apron' ? [[.5, .08], [.28, .1], [.72, .1], [.15, .5], [.85, .5], [.5, .95]]
      : [[.5, .1], [.26, .17], [.74, .17], [.24, longSleeve ? .4 : .45], [.76, longSleeve ? .4 : .45], [.5, .97]];
  spec.landmarks = requiredLandmarks(structure).map((mark, i) => ({ ...mark, point: { x: landmarkPoints[i][0], y: landmarkPoints[i][1] } }));
  if (structure === 'cap') {
    if (face === 'front') { spec.positions = [position('capFront', .3, .24, .4, .28)]; spec.exclusions = [exclusion('brim', '帽檐避让', .06, .66, .88, .25)]; }
    // Side positions are drawn by hand when a customer asks for them; the back sits above the strap opening.
    else { spec.positions = [position('capBack', .3, .18, .4, .26)]; spec.exclusions = [exclusion('strap', '后开口 / 调节扣避让', .3, .56, .4, .44)]; }
    return standardSchema.parse(spec);
  }
  if (structure === 'apron') {
    if (face === 'front') spec.positions = [position('apronUpper', .32, .17, .36, .25), position('frontCenter', .25, .46, .5, .36)];
    // Pocket placement requires a manually selected area; a template cannot locate a real pocket.
    return standardSchema.parse(spec);
  }
  const outerwear = ['jacket', 'shell', 'vest'].includes(structure);
  if (face === 'back') {
    const hooded = ['hoodie', 'shell'].includes(structure);
    spec.exclusions = [exclusion('back-neck', '后领 / 领标避让', .38, .02, .24, .12)];
    if (hooded) spec.exclusions.push(exclusion('hood', '帽子覆盖范围', .25, .02, .5, .32));
    spec.positions = [position('upperBack', .28, hooded ? .36 : .22, .44, .13), position('backCenter', .3, hooded ? .54 : .45, .4, .27)];
  } else {
    spec.exclusions = [exclusion('neck', '领口 / 领标避让', .35, .02, .3, .18)];
    if (structure === 'polo') spec.exclusions.push(exclusion('placket', '门襟避让', .465, .18, .07, .25));
    if (outerwear) spec.exclusions.push(exclusion('zipper', '拉链 / 开襟避让', .475, .17, .05, .81), exclusion('pocket-left', '口袋避让', .2, .6, .17, .23), exclusion('pocket-right', '口袋避让', .63, .6, .17, .23));
    if (structure === 'hoodie') spec.exclusions.push(exclusion('hood-neck', '帽领覆盖范围', .3, .03, .4, .22), exclusion('kangaroo', '袋鼠兜避让', .25, .62, .5, .23));
    spec.positions = [position('leftChest', .6, .27, .15, .17), position('rightChest', .25, .27, .15, .17)];
    if (!outerwear) spec.positions.push(position('frontCenter', .33, structure === 'hoodie' ? .39 : .47, .34, structure === 'hoodie' ? .2 : .27));
    if (structure !== 'vest') {
      spec.positions.push(position('leftSleeve', .83, longSleeve || outerwear ? .3 : .26, .12, longSleeve || outerwear ? .19 : .13), position('rightSleeve', .05, longSleeve || outerwear ? .3 : .26, .12, longSleeve || outerwear ? .19 : .13));
    }
  }
  spec.positions = spec.positions.filter(p => allowedPositions(structure, face).includes(p.key));
  return standardSchema.parse(spec);
}

/**
 * A confirmed standard whose structure points are exactly the template was confirmed without
 * being marked; it is no calibration evidence and must not override the silhouette estimate.
 */
export function hasTemplateLandmarks(spec: PlacementStandard, face: 'front' | 'back', longSleeve = false) {
  const template = suggestedPlacement(spec.structureType, face, spec.garmentFrame, longSleeve).landmarks;
  const core = ['neckCenter', 'leftShoulder', 'rightShoulder', 'leftArmpit', 'rightArmpit'];
  return core.every(key => { const a = spec.landmarks.find(l => l.key === key)?.point, b = template.find(l => l.key === key)?.point; return !!a && !!b && Math.abs(a.x - b.x) < .002 && Math.abs(a.y - b.y) < .002; });
}
/** Positions a structure offers under the SOP; a zipped or open front has no full front print. */
export function sopPositionKeys(structure: StructureType, face: 'front' | 'back') {
  return allowedPositions(structure === 'unknown' ? 'crewneck' : structure, face).filter(key => !(key === 'frontCenter' && ['jacket', 'shell', 'vest'].includes(structure)));
}
const clampBox = (b: Box): Box => { const x = Math.max(0, Math.min(.999, b.x)), y = Math.max(0, Math.min(.999, b.y)); return { x, y, width: Math.max(.001, Math.min(1 - x, b.x + b.width - x)), height: Math.max(.001, Math.min(1 - y, b.y + b.height - y)) }; };
/**
 * The unconfirmed standard of one face: structure points recognized on the image (measure.points), the rest estimated from its silhouette,
 * template exclusions plus the placket/zipper/hood located from those points, and positions
 * from the SOP rules. The catalog shows it as the suggestion and the composite uses it as is.
 * frame: silhouette bounds in crop fractions; pixel: that frame in pixels; measure: crop fractions.
 */
export function estimatedSopStandard(structure: StructureType, face: 'front' | 'back', frame: Box, measure: { top: number; bottom: number; armpit: number; center: number; bodyWidth: number; points?: Partial<Record<string, Point>> }, pixel: { width: number; height: number }, bodyWidthPx: number | null, longSleeve = false): PlacementStandard | null {
  if (structure !== 'unknown' && !SOP_STRUCTURES.includes(structure)) return null;
  const base = structure === 'unknown' ? { ...emptyStandard(), garmentFrame: frame } : suggestedPlacement(structure, face, frame, longSleeve);
  const local = (p: { x: number; y: number }) => ({ x: Math.max(0, Math.min(1, (p.x - frame.x) / frame.width)), y: Math.max(0, Math.min(1, (p.y - frame.y) / frame.height)) });
  // Armpits sit at the width the composite uses, so the untouched catalog view matches the mockup.
  const torso = bodyWidthPx ? bodyWidthPx / pixel.width * frame.width : plausibleTorso(structure, measure.bodyWidth, frame.width) ?? frame.width * UNMEASURED_TORSO_SHARE;
  const spec: PlacementStandard = { ...base, structureType: structure, landmarks: estimatedLandmarks(structure, face, { ...measure, bodyWidth: torso }, measure.points).map(l => ({ ...l, point: local(l.point) })), positions: [] };
  const s = sopStructureFromStandard(spec, pixel, bodyWidthPx);
  if (!s) return null;
  const replaced = new Set(['placket', 'zipper', 'hood', 'hood-neck']);
  spec.exclusions = [...base.exclusions.filter(e => !replaced.has(e.id)), ...sopEstimatedExclusions(structure, face, s, s.bodyWidth / PROJECTED_BODY_WIDTH_CM)
    .map(e => ({ id: e.id, label: e.label, area: clampBox({ x: e.box.x / pixel.width, y: e.box.y / pixel.height, width: e.box.width / pixel.width, height: e.box.height / pixel.height }) }))];
  spec.positions = sopStandardPositions(spec, face, pixel, bodyWidthPx, sopPositionKeys(structure, face)) ?? [];
  return standardSchema.parse(spec);
}

export function positionFromImageBox(key: PositionKey, imageBox: Box, garmentFrame: Box): PlacementStandard['positions'][number] {
  boxSchema.parse(imageBox);
  boxSchema.parse(garmentFrame);
  const x = (imageBox.x - garmentFrame.x) / garmentFrame.width;
  const y = (imageBox.y - garmentFrame.y) / garmentFrame.height;
  const width = imageBox.width / garmentFrame.width;
  const height = imageBox.height / garmentFrame.height;
  if (x < 0 || y < 0 || x + width > 1.000001 || y + height > 1.000001) {
    throw new Error(`框选区域超出衣服边界：${JSON.stringify(imageBox)}，请在衣服布面内重新框选`);
  }
  return position(key, x, y, width, height);
}
