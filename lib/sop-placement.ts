import type { Box, PlacementStandard, Point, PositionKey, StructureType } from './catalog';

// Rules from 效果图制作与质量标准 V1.0 (2026-08-17). One copy serves both the catalog
// preview and the composite, so what the catalog shows is what a mockup uses.
export const SOP_PLACEMENT_POLICY = 'sop-v1';
// Catalog photos are ghost-mannequin renders: the visible torso is the body's projected
// width, not a flat half-chest. The SOP examples (chest 9 cm ≈ 22%, back 28 cm ≈ 70% of
// that width) and the photos' own shoulder/placket proportions both agree on about 40 cm.
export const PROJECTED_BODY_WIDTH_CM = 40;
export const SOP_STRUCTURES: StructureType[] = ['polo', 'crewneck', 'hoodie', 'jacket', 'shell', 'vest'];
export type SopKey = 'leftChest' | 'rightChest' | 'frontCenter' | 'leftSleeve' | 'rightSleeve' | 'upperBack' | 'backCenter';
export const SOP_FACE: Record<SopKey, 'front' | 'back'> = { leftChest: 'front', rightChest: 'front', frontCenter: 'front', leftSleeve: 'front', rightSleeve: 'front', upperBack: 'back', backCenter: 'back' };
// Chest logos sit about 9.5 cm below the front neck point, which is where the 2nd–3rd
// button midpoint lands on the measured polos; a logo taller than 6 cm moves down by
// half a button spacing, matching SOP "高度超过 6 厘米以上统一做在第三个扣子居中位置".
const CHEST_DROP_CM = 9.5, TALL_CHEST_CM = 6, TALL_SHIFT_CM = 3.3, CHEST_OFFSET = .27, SLEEVE_SEAM_GAP_CM = .75;

/** Structure points in one pixel space. left/right follow the image, like catalog landmarks. */
export type SopStructure = {
  structureType: StructureType;
  neck: Point; leftShoulder: Point; rightShoulder: Point; leftArmpit: Point; rightArmpit: Point;
  button2?: Point; button3?: Point;
  bodyWidth: number; center: number; bounds: Box; exclusions: Box[];
};

/** Default printed size (cm) when the customer gives none: SOP 2.1 包印最大尺寸范围. */
export function sopPrintSize(key: SopKey, ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error(`图案宽高比无效：${ratio}`);
  const [width, maxHeight] = key === 'leftChest' || key === 'rightChest' ? [8, 9]
    : key === 'backCenter' ? [26, 22] : key === 'upperBack' ? [8, 4] : key === 'frontCenter' ? [24, 28] : [6, 6];
  const w = Math.min(width, maxHeight / ratio);
  return { width: w, height: w * ratio };
}

const intersects = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const lerp = (a: Point, b: Point, y: number) => Math.abs(b.y - a.y) < 1e-6 ? (a.x + b.x) / 2 : a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y);

/** Center (px) of a logo of sizeCm, plus the SOP rule that produced it. */
export function sopPlacement(s: SopStructure, key: SopKey, sizeCm: { width: number; height: number }, pxPerCm: number) {
  const w = sizeCm.width * pxPerCm, h = sizeCm.height * pxPerCm;
  let x: number, y: number, rule: string;
  if (key === 'leftChest' || key === 'rightChest') {
    // Wearer's left is the image right on the front view.
    x = s.center + (key === 'leftChest' ? 1 : -1) * CHEST_OFFSET * s.bodyWidth;
    const tall = sizeCm.height > TALL_CHEST_CM;
    if (s.button2 && s.button3) { y = tall ? s.button3.y : (s.button2.y + s.button3.y) / 2; rule = tall ? '高度超过6厘米，居中于第三粒扣' : '居中于第二、三粒扣之间'; }
    else { y = s.neck.y + (CHEST_DROP_CM + (tall ? TALL_SHIFT_CM : 0)) * pxPerCm; rule = tall ? '高度超过6厘米，领口下约12.8厘米' : '领口下约9.5厘米（相当于第二、三粒扣之间）'; }
  } else if (key === 'frontCenter') { x = s.center; y = s.neck.y + 8 * pxPerCm + h / 2; rule = '上沿在领口下约8厘米'; }
  else if (key === 'backCenter') { x = s.center; y = ((s.leftShoulder.y + s.rightShoulder.y) / 2 + (s.leftArmpit.y + s.rightArmpit.y) / 2) / 2; rule = '居中于肩点至袖窿底之间'; }
  else if (key === 'upperBack') { x = s.center; y = s.neck.y + 3 * pxPerCm + h / 2; rule = '上沿在后领下约3厘米'; }
  else {
    // Wearer's left sleeve is the image right on the front view; SOP 4.2 keeps 0.5–1 cm from the seam.
    const side = key === 'leftSleeve' ? 1 : -1, shoulder = side > 0 ? s.rightShoulder : s.leftShoulder, armpit = side > 0 ? s.rightArmpit : s.leftArmpit;
    y = (shoulder.y + armpit.y) / 2; x = lerp(shoulder, armpit, y) + side * (SLEEVE_SEAM_GAP_CM * pxPerCm + w / 2); rule = '距袖子缝合线约0.75厘米';
  }
  // Keep the logo out of plackets, zippers, pockets and hoods by the smallest move in
  // the direction a designer would use; a remaining overlap is reported, not hidden.
  const outward = key === 'leftChest' || key === 'leftSleeve' ? 1 : key === 'rightChest' || key === 'rightSleeve' ? -1 : 0;
  const directions: [number, number][] = outward ? [[outward, 0], [0, -1], [0, 1]] : [[0, 1], [0, -1]];
  const box = (cx: number, cy: number): Box => ({ x: cx - w / 2, y: cy - h / 2, width: w, height: h });
  const clear = (cx: number, cy: number) => !s.exclusions.some(e => intersects(box(cx, cy), e));
  let conflict: string | null = null;
  if (!clear(x, y)) {
    // A front print may need to clear a whole polo placket; other logos only nudge.
    const step = .25 * pxPerCm, limit = (key === 'frontCenter' ? 12 : 6) * pxPerCm;
    let moved: [number, number] | null = null;
    for (let d = step; d <= limit && !moved; d += step) for (const [dx, dy] of directions) if (clear(x + dx * d, y + dy * d)) { moved = [x + dx * d, y + dy * d]; break; }
    if (moved) { [x, y] = moved; rule += '，已避开门襟/拉链/口袋等避让区'; }
    else conflict = '与避让区域重叠，请在素材库核对门襟、拉链、口袋等位置';
  }
  return { x, y, rule, conflict };
}

// Reference logos for the catalog preview: a typical horizontal logo in its default size.
const REFERENCE_RATIO: Record<SopKey, number> = { leftChest: .32, rightChest: .32, frontCenter: 1, leftSleeve: .5, rightSleeve: .5, upperBack: .5, backCenter: .32 };

/** Catalog positions derived from structure points; the stored boxes mirror what a mockup uses. */
export function sopStandardPositions(spec: PlacementStandard, face: 'front' | 'back', pixel: { width: number; height: number }, bodyWidthPx: number | null, keys: PositionKey[]) {
  const s = sopStructureFromStandard(spec, pixel, bodyWidthPx);
  if (!s) return null;
  const pxPerCm = s.bodyWidth / PROJECTED_BODY_WIDTH_CM, clamp = (v: number) => Math.max(0, Math.min(1, v));
  return keys.filter((k): k is SopKey => k in SOP_FACE && SOP_FACE[k as SopKey] === face).map(key => {
    const size = sopPrintSize(key, REFERENCE_RATIO[key]), p = sopPlacement(s, key, size, pxPerCm);
    const w = size.width * pxPerCm / pixel.width, h = size.height * pxPerCm / pixel.height;
    const anchor = { x: clamp(p.x / pixel.width), y: clamp(p.y / pixel.height) };
    const x = clamp(anchor.x - w / 2), y = clamp(anchor.y - h / 2);
    const box = { x, y, width: Math.min(w, 1 - x), height: Math.min(h, 1 - y) };
    return { key, anchor, printableArea: box, defaultSize: { width: box.width, height: box.height } };
  });
}

/** Converts garment-frame landmarks into pixels; missing required points mean no SOP structure. */
export function sopStructureFromStandard(spec: PlacementStandard, pixel: { width: number; height: number }, bodyWidthPx: number | null): SopStructure | null {
  const at = (key: string) => { const p = spec.landmarks.find(l => l.key === key)?.point; return p && { x: p.x * pixel.width, y: p.y * pixel.height }; };
  const [neck, leftShoulder, rightShoulder, leftArmpit, rightArmpit] = ['neckCenter', 'leftShoulder', 'rightShoulder', 'leftArmpit', 'rightArmpit'].map(at);
  if (!neck || !leftShoulder || !rightShoulder || !leftArmpit || !rightArmpit) return null;
  const bodyWidth = bodyWidthPx ?? Math.abs(rightArmpit.x - leftArmpit.x);
  if (!(bodyWidth > 0)) return null;
  return { structureType: spec.structureType, neck, leftShoulder, rightShoulder, leftArmpit, rightArmpit, button2: at('button2'), button3: at('button3'),
    bodyWidth, center: (leftArmpit.x + rightArmpit.x) / 2, bounds: { x: 0, y: 0, width: pixel.width, height: pixel.height },
    exclusions: spec.exclusions.map(e => ({ x: e.area.x * pixel.width, y: e.area.y * pixel.height, width: e.area.width * pixel.width, height: e.area.height * pixel.height })) };
}

/** Avoidance zones implied by the structure type, in the same pixels as the structure points. */
export function sopEstimatedExclusions(structure: StructureType, face: 'front' | 'back', s: Pick<SopStructure, 'neck' | 'center' | 'bounds' | 'leftArmpit' | 'rightArmpit'>, pxPerCm: number) {
  const out: { id: string; label: string; box: Box }[] = [];
  const bottom = s.bounds.y + s.bounds.height;
  if (face === 'front' && structure === 'polo') out.push({ id: 'placket', label: '门襟避让', box: { x: s.center - 1.8 * pxPerCm, y: s.neck.y, width: 3.6 * pxPerCm, height: 16 * pxPerCm } });
  if (face === 'front' && ['jacket', 'shell', 'vest'].includes(structure)) out.push({ id: 'zipper', label: '拉链 / 开襟避让', box: { x: s.center - 2.5 * pxPerCm, y: s.neck.y, width: 5 * pxPerCm, height: bottom - s.neck.y } });
  if (face === 'back' && ['hoodie', 'shell'].includes(structure)) {
    const armpit = (s.leftArmpit.y + s.rightArmpit.y) / 2;
    out.push({ id: 'hood', label: '帽子覆盖范围', box: { x: s.center - 12 * pxPerCm, y: s.bounds.y, width: 24 * pxPerCm, height: (armpit - s.bounds.y) * .55 } });
  }
  return out;
}

// Estimated structure points as fractions of the top→armpit span, measured on the
// catalog's own photos (front neck, shoulder point). Used only until a person confirms.
const ESTIMATE: Record<string, { neck: number; backNeck: number; shoulder: number }> = {
  polo: { neck: .345, backNeck: .08, shoulder: .28 }, crewneck: { neck: .2, backNeck: .05, shoulder: .32 }, hoodie: { neck: .2, backNeck: .05, shoulder: .32 },
  jacket: { neck: .28, backNeck: .1, shoulder: .35 }, shell: { neck: .28, backNeck: .1, shoulder: .35 }, vest: { neck: .28, backNeck: .1, shoulder: .35 }, unknown: { neck: .25, backNeck: .07, shoulder: .3 },
};
/** Landmarks from a silhouette measurement (all values are fractions of the face crop). */
export function estimatedLandmarks(structure: StructureType, face: 'front' | 'back', m: { top: number; bottom: number; armpit: number; center: number; bodyWidth: number }) {
  const r = ESTIMATE[structure] ?? ESTIMATE.unknown, span = m.armpit - m.top, half = m.bodyWidth / 2;
  const point = (x: number, y: number) => ({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
  return [
    { key: 'neckCenter', label: '领口中心', point: point(m.center, m.top + span * (face === 'front' ? r.neck : r.backNeck)) },
    { key: 'leftShoulder', label: '画面左肩点', point: point(m.center - half * 1.1, m.top + span * r.shoulder) },
    { key: 'rightShoulder', label: '画面右肩点', point: point(m.center + half * 1.1, m.top + span * r.shoulder) },
    { key: 'leftArmpit', label: '画面左腋点', point: point(m.center - half, m.armpit) },
    { key: 'rightArmpit', label: '画面右腋点', point: point(m.center + half, m.armpit) },
    { key: 'hemCenter', label: '下摆中心', point: point(m.center, m.bottom) },
  ];
}
