import type { Box, PlacementStandard, Point, PositionKey, StructureType } from './catalog';

// Rules from 效果图制作与质量标准 V1.0 (2026-08-17). One copy serves both the catalog
// preview and the composite, so what the catalog shows is what a mockup uses.
// v2: confirmed armpits set the body width, and sleeve-merged torso measurements are rejected.
// v3: a tall back print keeps its top edge 8 cm below the neck.
// v4: chest logos default to at most 6 cm tall, flat ones up to 10 cm wide.
// v5: measured on 134 hand-made confirmation mockups, chest logos sit on the lowest (3rd) button, and without
// marked buttons at a share of the shoulder-line-to-hem distance; back prints are 28 cm wide and lower.
// Offsets set under an older rule are converted so the print stays where the person put it.
export type SopPolicy = 'sop-v4' | 'sop-v5';
export const SOP_PLACEMENT_POLICY: SopPolicy = 'sop-v5';
// Catalog photos are ghost-mannequin renders: the visible torso is the body's projected
// width, not a flat half-chest. The SOP examples (chest 9 cm ≈ 22%, back 28 cm ≈ 70% of
// that width) and the photos' own shoulder/placket proportions both agree on about 40 cm.
export const PROJECTED_BODY_WIDTH_CM = 40;
export const SOP_STRUCTURES: StructureType[] = ['polo', 'crewneck', 'hoodie', 'jacket', 'shell', 'vest'];
// Long sleeves hanging against the body merge with it in the silhouette. On the catalog, a torso
// measured below separated sleeves is 53–62% of the garment width, a merged one 85–99%; the
// 58% midpoint stands in for the body until a person marks the armpits.
const MERGED_TORSO_SHARE = .8;
export const UNMEASURED_TORSO_SHARE = .58;
const SLEEVELESS: StructureType[] = ['vest', 'apron', 'cap'];
/** A torso width (any unit) that is really torso plus sleeves, measured against the garment width in the same unit. */
export function torsoMergedWithSleeves(structure: StructureType, torso: number, garmentWidth: number) {
  return !SLEEVELESS.includes(structure) && torso >= garmentWidth * MERGED_TORSO_SHARE;
}
export const plausibleTorso = (structure: StructureType, torso: number | null | undefined, garmentWidth: number) =>
  torso && !torsoMergedWithSleeves(structure, torso, garmentWidth) ? torso : null;
export type SopKey = 'leftChest' | 'rightChest' | 'frontCenter' | 'leftSleeve' | 'rightSleeve' | 'upperBack' | 'backCenter';
export const SOP_FACE: Record<SopKey, 'front' | 'back'> = { leftChest: 'front', rightChest: 'front', frontCenter: 'front', leftSleeve: 'front', rightSleeve: 'front', upperBack: 'back', backCenter: 'back' };
// Chest logos sit about 9.5 cm below the front neck point, which is where the 2nd–3rd
// button midpoint lands on the measured polos; a logo taller than 6 cm moves down by
// half a button spacing, matching SOP "高度超过 6 厘米以上统一做在第三个扣子居中位置".
const CHEST_DROP_CM = 9.5, TALL_CHEST_CM = 6, TALL_SHIFT_CM = 3.3, CHEST_OFFSET = .27, SLEEVE_SEAM_GAP_CM = .75;
// Centered between shoulders and armholes, a 22 cm tall back print reached the collar (JSH-JSD33);
// like a front print, its top edge stays at least 8 cm below the neck point.
const BACK_TOP_MIN_CM = 8;
// v5, as shares of the distance from the shoulder line (mean of the shoulder points) down to the hem: chest
// centers without marked buttons, and back centers with the highest their top edge may reach. Both ends are
// required structure points, so hangers and the crop around a shared standard do not move them. The hand-made
// mockups put chest logos 29% down the whole garment (polo), 35% (zipped jacket) and 33% (vest), back centers
// at 32% / 37% / 33%; converted on the 60 confirmed catalog standards these are the shares below (the marked
// polo 3rd buttons sit at a median 17%). Hoods and shells are not in the samples and keep the v4 rules.
// T-shirts are often drop-shouldered and their shoulder points are marked anywhere from the neckline to the
// drop, so they measure from the back neck instead, and their chest keeps the v4 rule (9.5 cm below the
// neck), which already lands 29% down the garment on the live mockups.
const CHEST_SHARE: Partial<Record<StructureType, number>> = { polo: .17, vest: .2, jacket: .22 };
const BACK_SHARE: Partial<Record<StructureType, { from: 'shoulders' | 'neck'; center: number; top: number }>> = {
  polo: { from: 'shoulders', center: .21, top: .045 }, vest: { from: 'shoulders', center: .2, top: .05 }, jacket: { from: 'shoulders', center: .25, top: .06 },
  crewneck: { from: 'neck', center: .28, top: .14 },
};
// Vest chest logos sit closer to the zipper than polo ones (0.20 of the vest width in the samples).
const chestOffset = (s: Pick<SopStructure, 'structureType'>, policy: SopPolicy) => policy !== 'sop-v4' && s.structureType === 'vest' ? .21 : CHEST_OFFSET;

/** Structure points in one pixel space. left/right follow the image, like catalog landmarks. */
export type SopStructure = {
  structureType: StructureType;
  neck: Point; leftShoulder: Point; rightShoulder: Point; leftArmpit: Point; rightArmpit: Point;
  button2?: Point; button3?: Point;
  /** Hem center height (px); absent falls back to the bottom of the bounds. */
  hem?: number;
  /** Catalog fine-tuning of a print center, in cm from where the SOP rule puts it (+x image right, +y down). */
  offsets?: Partial<Record<SopKey, Point>>;
  bodyWidth: number; center: number; bounds: Box; exclusions: Box[];
};

/**
 * Width limit of a chest logo: 8 cm up to 3:1, widening evenly to 10 cm at 5:1 and flatter, so a long
 * line of text is not left 1 cm tall and two almost equally flat logos never differ by a jump.
 */
export const chestWidthLimit = (ratio: number) => 8 + Math.min(2, Math.max(0, 1 / ratio - 3));

/**
 * Default printed size (cm) when the customer gives none. SOP 2.1 lets a chest print reach 8×9 cm,
 * but as a default that made square badges 8×8.7 cm; chest logos stay within 6 cm of height.
 */
export function sopPrintSize(key: SopKey, ratio: number, structure?: StructureType, policy: SopPolicy = SOP_PLACEMENT_POLICY) {
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error(`图案宽高比无效：${ratio}`);
  const [width, maxHeight] = key === 'leftChest' || key === 'rightChest' ? [chestWidthLimit(ratio), 6]
    : key === 'backCenter' ? backSize(ratio, structure, policy) : key === 'upperBack' ? [8, 4] : key === 'frontCenter' ? [24, 28] : [6, 6];
  const w = Math.min(width, maxHeight / ratio);
  return { width: w, height: w * ratio };
}

/**
 * Back print limits (cm). v5: 28 cm wide, a single flat line widening evenly to 30 cm, and portrait photos or
 * illustrations allowed to grow from 22 to 28 cm tall; vests are narrower and take about 21 cm.
 */
function backSize(ratio: number, structure: StructureType | undefined, policy: SopPolicy): [number, number] {
  if (policy === 'sop-v4') return [26, 22];
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return [structure === 'vest' ? 21 : 28 + 2 * clamp01((.3 - ratio) / .1), 22 + 6 * clamp01((ratio - 1) / .4)];
}

const intersects = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const lerp = (a: Point, b: Point, y: number) => Math.abs(b.y - a.y) < 1e-6 ? (a.x + b.x) / 2 : a.x + (b.x - a.x) * (y - a.y) / (b.y - a.y);

/** Where a rule version puts the center of a logo, before avoidance zones and catalog fine-tuning. */
function sopAnchor(s: SopStructure, key: SopKey, sizeCm: { width: number; height: number }, pxPerCm: number, policy: SopPolicy) {
  const w = sizeCm.width * pxPerCm, h = sizeCm.height * pxPerCm;
  const shoulders = (s.leftShoulder.y + s.rightShoulder.y) / 2, length = (s.hem ?? s.bounds.y + s.bounds.height) - shoulders;
  const percent = (f: number) => `${+(f * 100).toFixed(1)}%`;
  let x: number, y: number, rule: string;
  if (key === 'leftChest' || key === 'rightChest') {
    // Wearer's left is the image right on the front view.
    x = s.center + (key === 'leftChest' ? 1 : -1) * chestOffset(s, policy) * s.bodyWidth;
    const tall = sizeCm.height > TALL_CHEST_CM, share = CHEST_SHARE[s.structureType];
    if (policy !== 'sop-v4' && s.button3) { y = s.button3.y; rule = '居中于第三粒扣（门襟最下一粒）'; }
    else if (policy !== 'sop-v4' && share && length > 0) { y = shoulders + share * length; rule = `肩线至下摆${percent(share)}处${s.structureType === 'polo' ? '（约为第三粒扣位置）' : ''}`; }
    else if (s.button2 && s.button3) { y = tall ? s.button3.y : (s.button2.y + s.button3.y) / 2; rule = tall ? '高度超过6厘米，居中于第三粒扣' : '居中于第二、三粒扣之间'; }
    else { y = s.neck.y + (CHEST_DROP_CM + (tall ? TALL_SHIFT_CM : 0)) * pxPerCm; rule = tall ? '高度超过6厘米，领口下约12.8厘米' : '领口下约9.5厘米（相当于第二、三粒扣之间）'; }
  } else if (key === 'frontCenter') { x = s.center; y = s.neck.y + 8 * pxPerCm + h / 2; rule = '上沿在领口下约8厘米'; }
  else if (key === 'backCenter') {
    x = s.center;
    const back = policy !== 'sop-v4' ? BACK_SHARE[s.structureType] : undefined;
    const from = back?.from === 'neck' ? s.neck.y : shoulders, span = (s.hem ?? s.bounds.y + s.bounds.height) - from, name = back?.from === 'neck' ? '后领' : '肩线';
    if (back && span > 0) {
      y = from + back.center * span; rule = `${name}至下摆${percent(back.center)}处`;
      const highest = Math.max(from + back.top * span, s.neck.y + BACK_TOP_MIN_CM * pxPerCm) + h / 2;
      if (y < highest) { y = highest; rule = `图稿较高，上沿不高于${name}至下摆${percent(back.top)}处、后领下${BACK_TOP_MIN_CM}厘米`; }
    } else {
      y = ((s.leftShoulder.y + s.rightShoulder.y) / 2 + (s.leftArmpit.y + s.rightArmpit.y) / 2) / 2; rule = '居中于肩点至袖窿底之间';
      const lowest = s.neck.y + BACK_TOP_MIN_CM * pxPerCm + h / 2;
      if (y < lowest) { y = lowest; rule = `图稿较高，上沿保持在后领下约${BACK_TOP_MIN_CM}厘米`; }
    }
  }
  else if (key === 'upperBack') { x = s.center; y = s.neck.y + 3 * pxPerCm + h / 2; rule = '上沿在后领下约3厘米'; }
  else {
    // Wearer's left sleeve is the image right on the front view; SOP 4.2 keeps 0.5–1 cm from the seam.
    const side = key === 'leftSleeve' ? 1 : -1, shoulder = side > 0 ? s.rightShoulder : s.leftShoulder, armpit = side > 0 ? s.rightArmpit : s.leftArmpit;
    y = (shoulder.y + armpit.y) / 2; x = lerp(shoulder, armpit, y) + side * (SLEEVE_SEAM_GAP_CM * pxPerCm + w / 2); rule = '距袖子缝合线约0.75厘米';
  }
  return { x, y, rule };
}

/** Center (px) of a logo of sizeCm, plus the SOP rule that produced it. */
export function sopPlacement(s: SopStructure, key: SopKey, sizeCm: { width: number; height: number }, pxPerCm: number) {
  const w = sizeCm.width * pxPerCm, h = sizeCm.height * pxPerCm;
  let { x, y, rule } = sopAnchor(s, key, sizeCm, pxPerCm, SOP_PLACEMENT_POLICY);
  // Keep the logo out of plackets, zippers, pockets and hoods by the smallest move in
  // the direction a designer would use; a remaining overlap is reported, not hidden.
  const outward = key === 'leftChest' || key === 'leftSleeve' ? 1 : key === 'rightChest' || key === 'rightSleeve' ? -1 : 0;
  const directions: [number, number][] = outward ? [[outward, 0], [0, -1], [0, 1]] : [[0, 1], [0, -1]];
  const box = (cx: number, cy: number): Box => ({ x: cx - w / 2, y: cy - h / 2, width: w, height: h });
  const clear = (cx: number, cy: number) => !s.exclusions.some(e => intersects(box(cx, cy), e));
  let conflict: string | null = null;
  const offset = s.offsets?.[key];
  if (offset) {
    // A person placed this center on purpose: never nudge it away, only report an overlap.
    x += offset.x * pxPerCm; y += offset.y * pxPerCm; rule += `，按素材库微调（${describeSopOffset(offset)}）`;
    if (!clear(x, y)) conflict = '素材库微调后的位置与避让区域重叠，请在素材库核对';
  } else if (!clear(x, y)) {
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
    const size = sopPrintSize(key, REFERENCE_RATIO[key], s.structureType), p = sopPlacement(s, key, size, pxPerCm);
    const w = size.width * pxPerCm / pixel.width, h = size.height * pxPerCm / pixel.height;
    const anchor = { x: clamp(p.x / pixel.width), y: clamp(p.y / pixel.height) };
    const x = clamp(anchor.x - w / 2), y = clamp(anchor.y - h / 2);
    const box = { x, y, width: Math.min(w, 1 - x), height: Math.min(h, 1 - y) };
    const offsetCm = s.offsets?.[key];
    return { key, anchor, printableArea: box, defaultSize: { width: box.width, height: box.height }, ...(offsetCm ? { offsetCm, offsetPolicy: SOP_PLACEMENT_POLICY } : {}) };
  });
}

/** Plain words for a fine-tuning offset, sides as seen in the image. */
export function describeSopOffset(offset: Point) {
  const part = (v: number, plus: string, minus: string) => Math.abs(v) >= .05 ? `${v > 0 ? plus : minus}${+Math.abs(v).toFixed(1)}厘米` : '';
  return [part(offset.x, '画面右移', '画面左移'), part(offset.y, '下移', '上移')].filter(Boolean).join('、') || '未偏移';
}

/** Converts garment-frame landmarks into pixels; missing required points mean no SOP structure. */
export function sopStructureFromStandard(spec: PlacementStandard, pixel: { width: number; height: number }, bodyWidthPx: number | null): SopStructure | null {
  const at = (key: string) => { const p = spec.landmarks.find(l => l.key === key)?.point; return p && { x: p.x * pixel.width, y: p.y * pixel.height }; };
  const [neck, leftShoulder, rightShoulder, leftArmpit, rightArmpit] = ['neckCenter', 'leftShoulder', 'rightShoulder', 'leftArmpit', 'rightArmpit'].map(at);
  if (!neck || !leftShoulder || !rightShoulder || !leftArmpit || !rightArmpit) return null;
  const bodyWidth = bodyWidthPx ?? Math.abs(rightArmpit.x - leftArmpit.x);
  if (!(bodyWidth > 0)) return null;
  const s: SopStructure = { structureType: spec.structureType, neck, leftShoulder, rightShoulder, leftArmpit, rightArmpit, button2: at('button2'), button3: at('button3'),
    hem: at('hemCenter')?.y ?? pixel.height,
    bodyWidth, center: (leftArmpit.x + rightArmpit.x) / 2, bounds: { x: 0, y: 0, width: pixel.width, height: pixel.height },
    exclusions: spec.exclusions.map(e => ({ x: e.area.x * pixel.width, y: e.area.y * pixel.height, width: e.area.width * pixel.width, height: e.area.height * pixel.height })) };
  s.offsets = Object.fromEntries(spec.positions.flatMap(p => {
    const offset = p.offsetCm && p.key in SOP_FACE ? currentOffset(s, p.key as SopKey, p.offsetCm, (p.offsetPolicy ?? 'sop-v4') as SopPolicy) : null;
    return offset ? [[p.key, offset]] : [];
  }));
  return s;
}

/**
 * A catalog offset moved a print from where its rule version put the reference logo; under the current rule
 * it becomes the offset that keeps that same spot. One that ends up within 0.5 cm is dropped, so the print
 * follows the rule again.
 */
function currentOffset(s: SopStructure, key: SopKey, offset: Point, policy: SopPolicy): Point | null {
  if (policy === SOP_PLACEMENT_POLICY) return offset;
  const pxPerCm = s.bodyWidth / PROJECTED_BODY_WIDTH_CM, ratio = REFERENCE_RATIO[key];
  const was = sopAnchor(s, key, sopPrintSize(key, ratio, s.structureType, policy), pxPerCm, policy);
  const now = sopAnchor(s, key, sopPrintSize(key, ratio, s.structureType), pxPerCm, SOP_PLACEMENT_POLICY);
  const round = (v: number) => Math.round(v * 10) / 10;
  const next = { x: round(offset.x + (was.x - now.x) / pxPerCm), y: round(offset.y + (was.y - now.y) / pxPerCm) };
  return Math.abs(next.x) < .5 && Math.abs(next.y) < .5 ? null : next;
}

/** Moves a structure into another pixel space (e.g. the composite frame). */
export function moveSopStructure(s: SopStructure, dx: number, dy: number, bounds: Box): SopStructure {
  const move = (p: Point | undefined) => p && { x: p.x + dx, y: p.y + dy };
  return { ...s, neck: move(s.neck)!, leftShoulder: move(s.leftShoulder)!, rightShoulder: move(s.rightShoulder)!, leftArmpit: move(s.leftArmpit)!, rightArmpit: move(s.rightArmpit)!,
    button2: move(s.button2), button3: move(s.button3), hem: s.hem === undefined ? undefined : s.hem + dy,
    center: s.center + dx, bounds, exclusions: s.exclusions.map(e => ({ ...e, x: e.x + dx, y: e.y + dy })) };
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

// Fallback structure points as fractions of the top→armpit span, measured on the catalog's own
// photos; used only for a point the image recognition did not find, until a person drags it.
const ESTIMATE: Record<string, { neck: number; backNeck: number; shoulder: number }> = {
  polo: { neck: .345, backNeck: .08, shoulder: .28 }, crewneck: { neck: .2, backNeck: .05, shoulder: .32 }, hoodie: { neck: .2, backNeck: .05, shoulder: .32 },
  jacket: { neck: .28, backNeck: .1, shoulder: .35 }, shell: { neck: .28, backNeck: .1, shoulder: .35 }, vest: { neck: .28, backNeck: .1, shoulder: .35 }, unknown: { neck: .25, backNeck: .07, shoulder: .3 },
};
/**
 * Landmarks of one face (all values are fractions of the face crop): points recognized on the image
 * (`found`, by key) as they are, the rest from the silhouette measurement.
 */
export function estimatedLandmarks(structure: StructureType, face: 'front' | 'back', m: { top: number; bottom: number; armpit: number; center: number; bodyWidth: number }, found: Partial<Record<string, Point>> = {}) {
  const r = ESTIMATE[structure] ?? ESTIMATE.unknown, span = m.armpit - m.top, half = m.bodyWidth / 2;
  const point = (x: number, y: number) => ({ x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) });
  const marks = [
    { key: 'neckCenter', label: '领口中心', point: point(m.center, m.top + span * (face === 'front' ? r.neck : r.backNeck)) },
    { key: 'leftShoulder', label: '画面左肩点', point: point(m.center - half * 1.1, m.top + span * r.shoulder) },
    { key: 'rightShoulder', label: '画面右肩点', point: point(m.center + half * 1.1, m.top + span * r.shoulder) },
    { key: 'leftArmpit', label: '画面左腋点', point: point(m.center - half, m.armpit) },
    { key: 'rightArmpit', label: '画面右腋点', point: point(m.center + half, m.armpit) },
    { key: 'hemCenter', label: '下摆中心', point: point(m.center, m.bottom) },
    ...(structure === 'polo' && face === 'front' && found.button2 && found.button3 ? [{ key: 'button2', label: '第二粒扣', point: found.button2 }, { key: 'button3', label: '第三粒扣', point: found.button3 }] : []),
  ];
  return marks.map(mark => { const at = found[mark.key]; return at ? { ...mark, point: point(at.x, at.y) } : mark; });
}
