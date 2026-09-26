'use client';
import { fetchApi, readApiJson } from '@/lib/client/api-response';

import { useEffect, useRef, useState } from 'react';
import { allowedPositions, MANUAL_STRUCTURES, POSITION_LABELS, STRUCTURE_LABELS, type Box, type CatalogStyle, type CatalogDetail, type CatalogUser, type CatalogView, type PlacementStandard, type Point, type PositionKey, type StructureType } from '@/lib/catalog';
import { colorSyncState } from '@/lib/catalog-calibration-status';
import { CatalogImagePreview } from '@/components/catalog-image-preview';
import { catalogApronRecognitionResponseSchema } from '@/lib/catalog-apron-recognition';
import { CatalogReuse } from '@/components/catalog-reuse';
import { catalogReferenceType, hasTemplateLandmarks, positionFromImageBox, sopPositionKeys, structureRecognitionSchema, suggestedPlacement, type CatalogPlacementPreview } from '@/lib/catalog-placement-suggestions';
import { PROJECTED_BODY_WIDTH_CM, SOP_STRUCTURES, describeSopOffset, sopStandardPositions } from '@/lib/sop-placement';

type Layer = 'all' | 'placement' | 'structure';
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type Drag = { kind: 'frame' | 'landmark' | 'anchor' | 'area' | 'exclusion' | 'logo'; index: number; resize?: Handle };
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const manualStructure = (spec: PlacementStandard) => MANUAL_STRUCTURES.includes(spec.structureType);
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const conflictsOf = (spec: PlacementStandard, area: Box) => spec.exclusions.filter(e => overlaps(area, e.area));
type Position = PlacementStandard['positions'][number];
/** Keeps the sample logo inside its print area: shrinks it if the area got smaller, then pulls its center in. */
function fitLogo(p: Position): Position {
  const a = p.printableArea, scale = Math.min(1, a.width / p.defaultSize.width, a.height / p.defaultSize.height);
  const size = { width: p.defaultSize.width * scale, height: p.defaultSize.height * scale };
  const anchor = { x: Math.max(a.x + size.width / 2, Math.min(a.x + a.width - size.width / 2, p.anchor.x)), y: Math.max(a.y + size.height / 2, Math.min(a.y + a.height - size.height / 2, p.anchor.y)) };
  return { ...p, defaultSize: size, anchor };
}
/** Pulls a print area off every exclusion it overlaps, cutting the side that keeps the most area. */
function avoidExclusions(spec: PlacementStandard, index: number): PlacementStandard {
  let area = spec.positions[index].printableArea;
  for (const { area: e } of conflictsOf(spec, area)) {
    const right = area.x + area.width, bottom = area.y + area.height;
    const options: Box[] = [{ ...area, height: e.y - area.y }, { ...area, y: e.y + e.height, height: bottom - e.y - e.height }, { ...area, width: e.x - area.x }, { ...area, x: e.x + e.width, width: right - e.x - e.width }];
    const best = options.filter(b => b.width >= .02 && b.height >= .02).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (best) area = best;
  }
  return { ...spec, positions: spec.positions.map((p, i) => i === index ? fitLogo({ ...p, printableArea: area }) : p) };
}
/** Moves the edges a handle controls; with no handle the whole box moves. The box stays inside the face. */
function dragBox(b: Box, handle: Handle | undefined, dx: number, dy: number, min = .01): Box {
  if (!handle) return { ...b, x: clamp(b.x + dx, 1 - b.width), y: clamp(b.y + dy, 1 - b.height) };
  let x1 = b.x, y1 = b.y, x2 = b.x + b.width, y2 = b.y + b.height;
  if (handle.includes('w')) x1 = Math.max(0, Math.min(x2 - min, x1 + dx));
  if (handle.includes('e')) x2 = Math.min(1, Math.max(x1 + min, x2 + dx));
  if (handle.includes('n')) y1 = Math.max(0, Math.min(y2 - min, y1 + dy));
  if (handle.includes('s')) y2 = Math.min(1, Math.max(y1 + min, y2 + dy));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
/** The mirror image of an edit: the left edge follows the other side's right edge, and so on. */
function mirrorEdit(pair: Box, before: Box, after: Box): Box {
  const dl = after.x - before.x, dr = after.x + after.width - before.x - before.width;
  const x1 = Math.max(0, pair.x - dr), x2 = Math.min(1, pair.x + pair.width - dl);
  const y1 = Math.max(0, pair.y + after.y - before.y), y2 = Math.min(1, pair.y + pair.height + after.y + after.height - before.y - before.height);
  return x2 - x1 < .01 || y2 - y1 < .01 ? pair : { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
function localPoint(p: Point, frame: Box): Point { return { x: frame.x + p.x * frame.width, y: frame.y + p.y * frame.height }; }
function localBox(b: Box, frame: Box): Box { return { ...localPoint(b, frame), width: b.width * frame.width, height: b.height * frame.height }; }
const clamp = (n: number, max = 1) => Math.max(0, Math.min(max, n));
// Garment structures follow the effect-image SOP: positions come from structure points, the same rule the composite uses.
// The body width is the marked armpit distance, which the composite also uses once the face is confirmed.
const sopDerived = (spec: PlacementStandard) => SOP_STRUCTURES.includes(spec.structureType);
function facePixels(spec: PlacementStandard, view: CatalogView, detail: CatalogDetail) {
  return { width: spec.garmentFrame.width * view.crop.width * detail.width, height: spec.garmentFrame.height * view.crop.height * detail.height };
}
function derivePositions(spec: PlacementStandard, view: CatalogView, detail: CatalogDetail): PlacementStandard {
  if (!sopDerived(spec)) return spec;
  const positions = sopStandardPositions(spec, view.face, facePixels(spec, view, detail), null, sopPositionKeys(spec.structureType, view.face));
  return positions ? { ...spec, positions } : spec;
}
// Centimetres per garment-frame fraction, on the same body-width scale the SOP positions use.
function frameCm(spec: PlacementStandard, view: CatalogView, detail: CatalogDetail) {
  const left = spec.landmarks.find(l => l.key === 'leftArmpit'), right = spec.landmarks.find(l => l.key === 'rightArmpit'), pixel = facePixels(spec, view, detail);
  const pxPerCm = left && right ? Math.abs(right.point.x - left.point.x) * pixel.width / PROJECTED_BODY_WIDTH_CM : 0;
  return pxPerCm > 0 ? { x: pixel.width / pxPerCm, y: pixel.height / pxPerCm } : null;
}
const offsetValue = (v: number) => Math.round(Math.max(-40, Math.min(40, v)) * 10) / 10;
function withOffset(spec: PlacementStandard, key: PositionKey, offset: Point | null): PlacementStandard {
  return { ...spec, positions: spec.positions.map(p => {
    if (p.key !== key) return p;
    const next = { ...p }; delete next.offsetCm;
    return offset && (offset.x || offset.y) ? { ...next, offsetCm: { x: offsetValue(offset.x), y: offsetValue(offset.y) } } : next;
  }) };
}
const landmarkLabel = (key: string, label: string, face: 'front' | 'back') => key === 'neckCenter' ? (face === 'front' ? '前领口中心' : '后领中心') : label;
// Left and right items pair by name: leftShoulder/rightShoulder, leftChest/rightChest, pocket-left/pocket-right.
const MIRRORED: Record<string, string> = { left: 'right', right: 'left', Left: 'Right', Right: 'Left' };
const pairName = (name: string) => { const next = name.replace(/left|right|Left|Right/, m => MIRRORED[m]); return next === name ? null : next; };
function pairIndex(spec: PlacementStandard, target: Drag) {
  const name = target.kind === 'landmark' ? spec.landmarks[target.index]?.key : target.kind === 'anchor' || target.kind === 'area' ? spec.positions[target.index]?.key : target.kind === 'exclusion' ? spec.exclusions[target.index]?.id : undefined;
  const pair = name ? pairName(name) : null;
  if (!pair) return -1;
  return target.kind === 'landmark' ? spec.landmarks.findIndex(l => l.key === pair) : target.kind === 'exclusion' ? spec.exclusions.findIndex(e => e.id === pair) : spec.positions.findIndex(p => p.key === pair);
}
// The garment's center line runs through the neck center; before it is marked, through the frame middle.
const centerX = (spec: PlacementStandard) => spec.landmarks.find(l => l.key === 'neckCenter')?.point.x ?? .5;
function targetPoint(spec: PlacementStandard, target: Drag): Point | null {
  if (target.kind === 'landmark') return spec.landmarks[target.index]?.point ?? null;
  if (target.kind === 'anchor' || target.kind === 'area') return spec.positions[target.index]?.anchor ?? null;
  if (target.kind === 'exclusion') { const a = spec.exclusions[target.index]?.area; return a ? { x: a.x + a.width / 2, y: a.y + a.height / 2 } : null; }
  return null;
}
/** Smart guides: level with and mirrored to the paired item, or on the center line for an unpaired one. */
function snapPoint(p: Point, spec: PlacementStandard, target: Drag, linked: boolean, tolerance: Point): Point {
  const pair = pairIndex(spec, target), c = centerX(spec);
  let { x, y } = p;
  if (pair >= 0) {
    if (linked) return p;
    const q = targetPoint(spec, { ...target, index: pair });
    if (!q) return p;
    if (Math.abs(y - q.y) < tolerance.y) y = q.y;
    if (Math.abs(x - (2 * c - q.x)) < tolerance.x) x = 2 * c - q.x;
  } else if (!(target.kind === 'landmark' && spec.landmarks[target.index]?.key === 'neckCenter') && Math.abs(x - c) < tolerance.x) x = c;
  return { x, y };
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

function FaceCanvas({ detail, view, spec, active, editable, layer, linked, selectedKey, selectedExclusion, status, activate, selectPosition, selectExclusion, change, drawingBoundary, finishBoundary, cancelDrawing }: {
  detail: CatalogDetail; view: CatalogView; spec: PlacementStandard; active: boolean; editable: boolean; layer: Layer; linked: boolean;
  selectedKey: PositionKey | null; selectedExclusion: string | null; status: string; activate: () => void; selectPosition: (key: PositionKey | null) => void; selectExclusion: (id: string | null) => void;
  change: (next: PlacementStandard) => void; drawingBoundary: boolean; finishBoundary: (box: Box) => void; cancelDrawing: () => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ target: Drag; from: Point; original: PlacementStandard } | null>(null);
  const boundaryStart = useRef<Point | null>(null);
  const [boundaryBox, setBoundaryBox] = useState<Box | null>(null);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const frame = spec.garmentFrame;
  // Caps and aprons: print areas, sample logos and exclusions are drawn and dragged directly; no frame or structure points.
  const manual = manualStructure(spec);
  function boundaryAt(event: React.PointerEvent): Box | null {
    const start = boundaryStart.current;
    if (!start) return null;
    const end = atPointer(event);
    return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
  }
  function beginBoundary(event: React.PointerEvent) {
    if (!drawingBoundary || !editable) return;
    event.stopPropagation(); activate();
    boundaryStart.current = atPointer(event); setBoundaryBox(null);
    svg.current!.setPointerCapture(event.pointerId);
  }
  function endPointer(event: React.PointerEvent) {
    if (drawingBoundary && boundaryStart.current) {
      const box = boundaryAt(event);
      boundaryStart.current = null; setBoundaryBox(null);
      // A click without a drag places a default-size box there (manual marking only).
      if (box && ((box.width >= .02 && box.height >= .02) || manual)) finishBoundary(box);
    }
    drag.current = null; setDragging(null);
  }
  const faceLabel = view.face === 'front' ? '正面' : '背面';
  const aspect = detail.width * view.crop.width / (detail.height * view.crop.height);
  const canvasHeight = 1000 / aspect;
  function atPointer(event: React.PointerEvent): Point {
    const point = svg.current!.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    const mapped = point.matrixTransform(svg.current!.getScreenCTM()!.inverse());
    return { x: clamp(mapped.x / 1000), y: clamp(mapped.y / canvasHeight) };
  }
  function start(event: React.PointerEvent, target: Drag) {
    event.stopPropagation(); activate();
    if (target.kind === 'anchor' || target.kind === 'area' || target.kind === 'logo') { selectPosition(spec.positions[target.index].key); if (manual) selectExclusion(null); }
    if (target.kind === 'exclusion' && manual) { selectExclusion(spec.exclusions[target.index].id); selectPosition(null); }
    if (!editable || (target.kind === 'frame' && layer !== 'structure') || (sopDerived(spec) && target.kind === 'area' && target.resize)) return;
    drag.current = { target, from: atPointer(event), original: structuredClone(spec) };
    setDragging(target);
    svg.current!.setPointerCapture(event.pointerId);
  }
  function manualMove(original: PlacementStandard, target: Drag, dx: number, dy: number, pointer: Point, tolerance: Point): PlacementStandard {
    const next = structuredClone(original), pair = linked ? pairIndex(original, target) : -1;
    if (target.kind === 'logo') {
      const p = original.positions[target.index], a = p.printableArea;
      if (target.resize) {
        // Scale around the logo center with the pointer; the logo keeps its proportions and stays in the print area.
        const local = { x: (pointer.x - frame.x) / frame.width, y: (pointer.y - frame.y) / frame.height };
        const wanted = Math.max(Math.abs(local.x - p.anchor.x) / (p.defaultSize.width / 2), Math.abs(local.y - p.anchor.y) / (p.defaultSize.height / 2));
        const most = Math.min(2 * (p.anchor.x - a.x) / p.defaultSize.width, 2 * (a.x + a.width - p.anchor.x) / p.defaultSize.width, 2 * (p.anchor.y - a.y) / p.defaultSize.height, 2 * (a.y + a.height - p.anchor.y) / p.defaultSize.height);
        const scale = Math.max(.01 / Math.min(p.defaultSize.width, p.defaultSize.height), Math.min(most, wanted));
        next.positions[target.index] = { ...p, defaultSize: { width: p.defaultSize.width * scale, height: p.defaultSize.height * scale } };
      } else {
        const anchor = snapPoint({ x: p.anchor.x + dx, y: p.anchor.y + dy }, original, { kind: 'anchor', index: target.index }, linked, tolerance);
        next.positions[target.index] = fitLogo({ ...p, anchor });
      }
      return next;
    }
    const before = target.kind === 'area' ? original.positions[target.index].printableArea : original.exclusions[target.index].area;
    let box = dragBox(before, target.resize, dx, dy);
    if (!target.resize) {
      const center = snapPoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, original, target, linked, tolerance);
      box = { ...box, x: clamp(center.x - box.width / 2, 1 - box.width), y: clamp(center.y - box.height / 2, 1 - box.height) };
    }
    const moved = (b: Box, was: Box, p: Position): Position => fitLogo({ ...p, printableArea: b, anchor: { x: p.anchor.x + b.x + b.width / 2 - was.x - was.width / 2, y: p.anchor.y + b.y + b.height / 2 - was.y - was.height / 2 } });
    if (target.kind === 'area') {
      next.positions[target.index] = target.resize ? fitLogo({ ...next.positions[target.index], printableArea: box }) : moved(box, before, original.positions[target.index]);
      if (pair >= 0) { const other = original.positions[pair], b = mirrorEdit(other.printableArea, before, box); next.positions[pair] = target.resize ? fitLogo({ ...other, printableArea: b }) : moved(b, other.printableArea, other); }
    } else {
      next.exclusions[target.index].area = box;
      if (pair >= 0) next.exclusions[pair].area = mirrorEdit(original.exclusions[pair].area, before, box);
    }
    return next;
  }
  function move(event: React.PointerEvent) {
    if (drawingBoundary && boundaryStart.current) { setBoundaryBox(boundaryAt(event)); return; }
    const gesture = drag.current;
    if (!gesture || !editable) return;
    const { target, original, from } = gesture;
    const canvas = atPointer(event);
    const dx = (canvas.x - from.x) / (target.kind === 'frame' ? 1 : original.garmentFrame.width);
    const dy = (canvas.y - from.y) / (target.kind === 'frame' ? 1 : original.garmentFrame.height);
    // With 左右联动 on, the paired item on the other side moves as the mirror image.
    const pair = linked ? pairIndex(original, target) : -1;
    const tolerance = { x: .008 / original.garmentFrame.width, y: .008 * aspect / original.garmentFrame.height };
    if (manual && target.kind !== 'frame' && target.kind !== 'landmark') { change(manualMove(original, target, dx, dy, canvas, tolerance)); return; }
    // On SOP garments the center is fine-tuned: the drag becomes a cm offset and the SOP rule still sets the size.
    if (sopDerived(original) && (target.kind === 'anchor' || target.kind === 'area')) {
      const cm = frameCm(original, view, detail), position = original.positions[target.index];
      if (!cm) return;
      const prior = position.offsetCm ?? { x: 0, y: 0 };
      let next = withOffset(original, position.key, { x: prior.x + dx * cm.x, y: prior.y + dy * cm.y });
      if (pair >= 0) { const other = original.positions[pair], was = other.offsetCm ?? { x: 0, y: 0 }; next = withOffset(next, other.key, { x: was.x - dx * cm.x, y: was.y + dy * cm.y }); }
      change(next);
      return;
    }
    const next = structuredClone(original);
    const boxOf = (spec: PlacementStandard, index: number) => target.kind === 'frame' ? spec.garmentFrame : target.kind === 'area' ? spec.positions[index].printableArea : target.kind === 'exclusion' ? spec.exclusions[index].area : null;
    const box = boxOf(next, target.index);
    if (box) {
      const before = boxOf(original, target.index)!;
      if (target.resize) { box.width = Math.max(.005, Math.min(1 - box.x, box.width + dx)); box.height = Math.max(.005, Math.min(1 - box.y, box.height + dy)); }
      else {
        let x = clamp(box.x + dx, 1 - box.width), y = clamp(box.y + dy, 1 - box.height);
        if (target.kind !== 'frame') {
          const center = snapPoint({ x: x + box.width / 2, y: y + box.height / 2 }, original, target, linked, tolerance);
          x = clamp(center.x - box.width / 2, 1 - box.width); y = clamp(center.y - box.height / 2, 1 - box.height);
        }
        if (target.kind === 'area') { const anchor = next.positions[target.index].anchor; anchor.x += x - box.x; anchor.y += y - box.y; }
        box.x = x; box.y = y;
      }
      const mirror = pair >= 0 ? boxOf(next, pair) : null;
      if (mirror) {
        const from = boxOf(original, pair)!, grow = { x: box.width - before.width, y: box.height - before.height };
        // Growing to the right mirrors to growing to the left, so the pair stays symmetric.
        const width = Math.max(.005, Math.min(from.x + from.width, from.width + grow.x)), height = Math.max(.005, Math.min(1 - from.y, from.height + grow.y));
        const x = target.resize ? from.x + from.width - width : clamp(from.x - (box.x - before.x), 1 - from.width);
        const y = target.resize ? from.y : clamp(from.y + (box.y - before.y), 1 - from.height);
        if (target.kind === 'area' && !target.resize) { const anchor = next.positions[pair].anchor; anchor.x += x - from.x; anchor.y += y - from.y; }
        Object.assign(mirror, { x, y, width, height });
      }
    } else {
      const point = target.kind === 'landmark' ? next.landmarks[target.index].point : next.positions[target.index].anchor;
      const was = { ...point }, snapped = snapPoint({ x: clamp(point.x + dx), y: clamp(point.y + dy) }, original, target, linked, tolerance);
      point.x = snapped.x; point.y = snapped.y;
      if (pair >= 0) {
        const other = target.kind === 'landmark' ? next.landmarks[pair].point : next.positions[pair].anchor;
        other.x = clamp(other.x - (point.x - was.x)); other.y = clamp(other.y + (point.y - was.y));
      }
    }
    change(next);
  }
  // Arrow keys nudge the selected print area or exclusion (Shift for bigger steps); Delete removes it.
  function keyDown(event: React.KeyboardEvent) {
    if (!manual) return;
    if (event.key === 'Escape') { cancelDrawing(); selectPosition(null); selectExclusion(null); return; }
    const positionIndex = spec.positions.findIndex(p => p.key === selectedKey), exclusionIndex = spec.exclusions.findIndex(e => e.id === selectedExclusion);
    const target: Drag | null = positionIndex >= 0 ? { kind: 'area', index: positionIndex } : exclusionIndex >= 0 ? { kind: 'exclusion', index: exclusionIndex } : null;
    if (!target || !editable) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      change(target.kind === 'area' ? { ...spec, positions: spec.positions.filter((_, i) => i !== positionIndex) } : { ...spec, exclusions: spec.exclusions.filter((_, i) => i !== exclusionIndex) });
      selectPosition(null); selectExclusion(null); return;
    }
    const step = (event.shiftKey ? .02 : .003), arrow = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!arrow) return;
    event.preventDefault();
    change(manualMove(spec, target, arrow[0], arrow[1], { x: 0, y: 0 }, { x: 0, y: 0 }));
  }
  // Guides are drawn from the current spec, so they follow snapping and the mirrored partner.
  const guideTarget = dragging?.kind === 'logo' ? { ...dragging, kind: 'anchor' as const } : dragging;
  const c = centerX(spec), dragged = guideTarget && guideTarget.kind !== 'frame' && !guideTarget.resize ? targetPoint(spec, guideTarget) : null;
  const partnerIndex = guideTarget && dragged ? pairIndex(spec, guideTarget) : -1;
  const partner = guideTarget && partnerIndex >= 0 ? targetPoint(spec, { ...guideTarget, index: partnerIndex }) : null;
  const level = !!(dragged && partner && near(dragged.y, partner.y)), mirrored = !!(dragged && partner && near(dragged.x, 2 * c - partner.x));
  const centered = !!(dragged && !partner && near(dragged.x, c));
  const guideNote = !dragged ? '' : linked && partner ? '左右联动' + (level && mirrored ? ' · 对称' : '') : [level && '左右等高', mirrored && '左右对称', centered && '居中'].filter(Boolean).join(' · ');
  const top = frame.y * 1000, bottom = (frame.y + frame.height) * 1000, left = frame.x * 1000, right = (frame.x + frame.width) * 1000;
  const centerLine = localPoint({ x: c, y: 0 }, frame).x * 1000, p = dragged && localPoint(dragged, frame), q = partner && localPoint(partner, frame);
  const mirrorX = partner ? localPoint({ x: 2 * c - partner.x, y: partner.y }, frame).x * 1000 : null;
  // Manual marking shows the center line only while it is being snapped to, to keep the photo clear.
  const guides = <g className="cal-guides" aria-hidden="true">
    {(!manual || centered) && <line x1={centerLine} y1={top} x2={centerLine} y2={bottom} className={`cal-guide-center${centered ? ' on' : ''}`} />}
    {p && !manual && <line x1={left} y1={p.y * 1000} x2={right} y2={p.y * 1000} className={`cal-guide${level ? ' on' : ''}`} />}
    {p && !manual && <line x1={p.x * 1000} y1={top} x2={p.x * 1000} y2={bottom} className={`cal-guide${mirrored || centered ? ' on' : ''}`} />}
    {q && !level && <line x1={left} y1={q.y * 1000} x2={right} y2={q.y * 1000} className="cal-guide cal-guide-pair" />}
    {mirrorX !== null && !mirrored && <line x1={mirrorX} y1={top} x2={mirrorX} y2={bottom} className="cal-guide cal-guide-pair" />}
    {p && guideNote && <text className="cal-guide-label" x={Math.min(p.x * 1000 + 16, 820)} y={Math.max(p.y * 1000 - 18, 30)}>{guideNote}</text>}
  </g>;
  function rectangle(b: Box, target: Drag, className: string, label: string) {
    const draggable = editable && (target.kind !== 'frame' || layer === 'structure') && !(sopDerived(spec) && target.kind === 'area');
    // eslint-disable-next-line react-hooks/refs -- Refs are read only in the deferred pointer event, never during rendering.
    return <g><rect x={b.x * 1000} y={b.y * 1000} width={b.width * 1000} height={b.height * 1000} className={className} aria-label={label} onPointerDown={event => start(event, target)} />{draggable && !manual && <rect x={(b.x + b.width) * 1000 - 9} y={(b.y + b.height) * 1000 - 9} width="18" height="18" className="cal-resize" aria-label={`调整${label}大小`} onPointerDown={event => start(event, { ...target, resize: 'se' })} />}</g>;
  }
  // The eight edge and corner handles of the selected box in manual marking.
  function handles(b: Box, target: Drag, label: string, danger = false) {
    if (!editable) return null;
    return HANDLES.map(h => {
      const x = b.x + (h.includes('w') ? 0 : h.includes('e') ? b.width : b.width / 2), y = b.y + (h.includes('n') ? 0 : h.includes('s') ? b.height : b.height / 2);
      // eslint-disable-next-line react-hooks/refs -- Refs are read only in the deferred pointer event, never during rendering.
      return <rect key={h} x={x * 1000 - 10} y={y * 1000 - 10} width="20" height="20" rx="4" className={`cal-handle${danger ? ' danger' : ''}`} style={{ cursor: HANDLE_CURSOR[h] }} aria-label={`拉动调整${label}`} onPointerDown={event => start(event, { ...target, resize: h })} />;
    });
  }
  function sampleLogo(p: Position, index: number, selected: boolean) {
    const box = localBox({ x: p.anchor.x - p.defaultSize.width / 2, y: p.anchor.y - p.defaultSize.height / 2, ...p.defaultSize }, frame);
    const w = box.width * 1000, h = box.height * 1000, size = Math.max(8, Math.min(h * .42, w / 4));
    return <g>
      <rect x={box.x * 1000} y={box.y * 1000} width={w} height={h} rx={Math.min(w, h) * .12} className="cal-sample-logo" aria-label={`${POSITION_LABELS[p.key]}示例 Logo，拖动改位置`} onPointerDown={event => start(event, { kind: 'logo', index })} />
      <text className="cal-sample-logo-text" x={(box.x + box.width / 2) * 1000} y={(box.y + box.height / 2) * 1000 + size * .36} textAnchor="middle" style={{ fontSize: size }}>LOGO</text>
      {selected && editable && <circle cx={(box.x + box.width) * 1000} cy={box.y * 1000} r="12" className="cal-logo-handle" aria-label={`拖动改${POSITION_LABELS[p.key]}示例 Logo 大小`} onPointerDown={event => start(event, { kind: 'logo', index, resize: 'ne' })} />}
    </g>;
  }
  const selectedExclusionIndex = manual && active ? spec.exclusions.findIndex(e => e.id === selectedExclusion) : -1;
  return <section className={`cal-face ${active ? 'active' : ''}`}>
    <button type="button" className="cal-face-title" onClick={activate}><strong>{faceLabel}</strong><span>{status}</span></button>
    <div className="cal-canvas-fit"><svg ref={svg} tabIndex={manual ? 0 : undefined} onKeyDown={keyDown} className={`cal-canvas ${drawingBoundary ? 'cal-drawing-boundary' : ''}`} viewBox={`0 0 1000 ${canvasHeight}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label={`${faceLabel}印花位置与避让区域`} onPointerDownCapture={beginBoundary} onPointerDown={() => { activate(); if (manual) { selectPosition(null); selectExclusion(null); } }} onPointerMove={move} onPointerUp={endPointer} onPointerCancel={() => { drag.current = null; boundaryStart.current = null; setBoundaryBox(null); }}>
      <g transform={`scale(1 ${1 / aspect})`}><defs><clipPath id={`face-crop-${view.id}`}><rect width="1000" height="1000" /></clipPath><pattern id={`danger-${view.id}`} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="12" height="12" fill="#fff2ee66" /><rect width="4" height="12" fill="#c94e4666" /></pattern></defs>
      <image clipPath={`url(#face-crop-${view.id})`} href={detail.thumbnailUrl} x={-view.crop.x / view.crop.width * 1000} y={-view.crop.y / view.crop.height * 1000} width={1000 / view.crop.width} height={1000 / view.crop.height} preserveAspectRatio="none" />
      <image clipPath={`url(#face-crop-${view.id})`} href={detail.imageUrl} x={-view.crop.x / view.crop.width * 1000} y={-view.crop.y / view.crop.height * 1000} width={1000 / view.crop.width} height={1000 / view.crop.height} preserveAspectRatio="none" />
      {layer !== 'placement' && !manual && rectangle(frame, { kind: 'frame', index: 0 }, 'cal-frame', '衣服边界')}
      {spec.exclusions.map((e, index) => { const box = localBox(e.area, frame); return <g key={e.id} style={{ '--cal-danger-fill': `url(#danger-${view.id})` } as React.CSSProperties}>{rectangle(box, { kind: 'exclusion', index }, `cal-exclusion${index === selectedExclusionIndex ? ' cal-selected-exclusion' : ''}`, e.label)}<text className="cal-exclusion-label" x={(box.x + box.width / 2) * 1000} y={manual ? (box.y + box.height / 2) * 1000 + 10 : box.y * 1000 + 22} textAnchor="middle">{e.label}</text></g>; })}
      {layer !== 'structure' && spec.positions.map((p, index) => {
        const point = localPoint(p.anchor, frame);
        const box = localBox(p.printableArea, frame), selected = active && selectedKey === p.key;
        if (manual) {
          const blocked = conflictsOf(spec, p.printableArea).length > 0;
          return <g key={p.key} className={selected ? 'cal-selected-position' : ''}>
            {rectangle(box, { kind: 'area', index }, `cal-print-area${blocked ? ' cal-blocked' : ''}`, `${POSITION_LABELS[p.key]}可印范围`)}
            {sampleLogo(p, index, selected)}
            <text className={`cal-position-label${blocked ? ' blocked' : ''}`} x={box.x * 1000 + 10} y={box.y * 1000 + 34}>{POSITION_LABELS[p.key]}{blocked ? ' · 压到避让区' : ''}</text>
          </g>;
        }
        const preview = localBox({ x: p.anchor.x - p.defaultSize.width / 2, y: p.anchor.y - p.defaultSize.height / 2, ...p.defaultSize }, frame);
        return <g key={p.key} className={selected ? 'cal-selected-position' : ''}>
          {rectangle(box, { kind: 'area', index }, 'cal-print-area', `${POSITION_LABELS[p.key]}可印范围`)}
          <rect x={preview.x * 1000} y={preview.y * 1000} width={preview.width * 1000} height={preview.height * 1000} className="cal-logo-size" />
          <circle cx={point.x * 1000} cy={point.y * 1000} r="12" className="cal-anchor" aria-label={POSITION_LABELS[p.key]} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); selectPosition(p.key); } }} onPointerDown={event => start(event, { kind: 'anchor', index })} />
          <text className="cal-position-label" x={point.x * 1000} y={(box.y + box.height) * 1000 + 25} textAnchor="middle">{POSITION_LABELS[p.key]}</text>
        </g>;
      })}
      {manual && active && (() => { const index = spec.positions.findIndex(p => p.key === selectedKey); return index >= 0 ? handles(localBox(spec.positions[index].printableArea, frame), { kind: 'area', index }, `${POSITION_LABELS[spec.positions[index].key]}可印范围`) : null; })()}
      {selectedExclusionIndex >= 0 && handles(localBox(spec.exclusions[selectedExclusionIndex].area, frame), { kind: 'exclusion', index: selectedExclusionIndex }, spec.exclusions[selectedExclusionIndex].label, true)}
      {layer !== 'placement' && !manual && spec.landmarks.map((p, index) => { const point = localPoint(p.point, frame); return <g key={p.key}><circle cx={point.x * 1000} cy={point.y * 1000} r="10" className="cal-point" aria-label={landmarkLabel(p.key, p.label, view.face)} onPointerDown={event => start(event, { kind: 'landmark', index })} /><text x={point.x * 1000 + 14} y={point.y * 1000 > 950 ? point.y * 1000 - 14 : point.y * 1000 + 30}>{landmarkLabel(p.key, p.label, view.face)}</text></g>; })}
      {guides}
      {drawingBoundary && boundaryBox && <rect className="cal-boundary-selection" x={boundaryBox.x * 1000} y={boundaryBox.y * 1000} width={boundaryBox.width * 1000} height={boundaryBox.height * 1000} />}
      </g>
    </svg></div>
  </section>;
}
function Percent({ label, value, change }: { label: string; value: number; change: (value: number) => void }) {
  return <label className="cal-number"><span>{label}</span><input type="number" min="0" max="100" step="0.1" value={Number.isFinite(value) ? Math.round(value * 10000) / 100 : ''} onChange={event => change(Number(event.target.value) / 100)} /><small>%</small></label>;
}
function BoxFields({ value, change }: { value: Box; change: (value: Box) => void }) {
  return <div className="cal-four">{(['x', 'y', 'width', 'height'] as const).map((key, i) => <Percent key={key} label={['X', 'Y', '宽', '高'][i]} value={value[key]} change={n => change({ ...value, [key]: n })} />)}</div>;
}
/** Caps and aprons: one row per print position to draw, the selected box's numbers, and the exclusions. */
function ManualMarks({ spec, face, editable, drawingKey, drawingExclusion, selectedKey, selectedExclusion, draw, select, selectExclusion, change }: {
  spec: PlacementStandard; face: 'front' | 'back'; editable: boolean; drawingKey: PositionKey | null; drawingExclusion: boolean; selectedKey: PositionKey | null; selectedExclusion: string | null;
  draw: (key: PositionKey | null) => void; select: (key: PositionKey | null) => void; selectExclusion: (id: string | null) => void; change: (next: PlacementStandard) => void;
}) {
  const index = spec.positions.findIndex(p => p.key === selectedKey), position = spec.positions[index];
  const hits = position ? conflictsOf(spec, position.printableArea) : [];
  const c = centerX(spec), area = position?.printableArea;
  const offCenter = !!position && !!area && area.x < c && area.x + area.width > c && Math.abs(position.anchor.x - c) > .002;
  const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;
  return <>
    <div className="cal-manual-section"><span className="cal-field-title">要印的位置</span>
      {spec.structureType === 'cap' && face === 'front' && <p className="cal-hint">左右以戴帽子的人为准：帽子左侧在照片右边。</p>}
      {allowedPositions(spec.structureType, face).map(key => {
        const p = spec.positions.find(item => item.key === key), bad = !!p && conflictsOf(spec, p.printableArea).length > 0;
        return <div key={key} className={`cal-manual-row${selectedKey === key ? ' on' : ''}`}>
          <i className={`cal-manual-dot${!p ? '' : bad ? ' bad' : ' ok'}`} aria-hidden="true" />
          <button type="button" className="cal-manual-name" disabled={!p && !editable} onClick={() => p ? (select(key), selectExclusion(null)) : draw(key)}>{POSITION_LABELS[key]}<small>{drawingKey === key ? '在照片上拖出能印的范围…' : !p ? '还没画' : bad ? '压到避让区' : '已画好'}</small></button>
          {editable && <button type="button" className="button" onClick={() => draw(key)}>{drawingKey === key ? '取消' : p ? '重画' : '画框'}</button>}
          {editable && p && <button type="button" className="cal-remove" onClick={() => { change({ ...spec, positions: spec.positions.filter(item => item.key !== key) }); if (selectedKey === key) select(null); }}>删除</button>}
        </div>;
      })}
    </div>
    {position && area && <div className="cal-offset">
      <strong>{POSITION_LABELS[position.key]}</strong>
      <dl className="cal-manual-facts"><dt>能印的范围</dt><dd>宽 {percent(area.width)} · 高 {percent(area.height)}</dd><dt>示例 Logo</dt><dd>占范围宽度 {Math.round(position.defaultSize.width / area.width * 100)}%</dd></dl>
      <p className="cal-hint">拖框移动整体，拉 8 个手柄改范围；拖 Logo 换位置，拖它右上角圆点改大小。选中后方向键微调（Shift 加速），Delete 删除。</p>
      {hits.length > 0 && <div className="cal-manual-warning" role="alert">和「{hits.map(e => e.label).join('、')}」重叠，确认不了。{editable && <button type="button" className="button" onClick={() => change(avoidExclusions(spec, index))}>自动让开</button>}</div>}
      {offCenter && editable && <button type="button" className="button" onClick={() => change({ ...spec, positions: spec.positions.map((p, i) => i === index ? fitLogo({ ...p, anchor: { ...p.anchor, x: c } }) : p) })}>Logo 放回中缝</button>}
    </div>}
    <div className="cal-manual-section"><span className="cal-field-title">避让区域 · 不能印的地方</span>
      {spec.exclusions.map(e => <div key={e.id} className={`cal-manual-row${selectedExclusion === e.id ? ' on' : ''}`}>
        <i className="cal-manual-dot danger" aria-hidden="true" />
        <input aria-label="避让区名称" value={e.label} disabled={!editable} maxLength={80} onFocus={() => { selectExclusion(e.id); select(null); }} onChange={event => change({ ...spec, exclusions: spec.exclusions.map(x => x.id === e.id ? { ...x, label: event.target.value } : x) })} />
        {editable && <button type="button" className="cal-remove" onClick={() => { change({ ...spec, exclusions: spec.exclusions.filter(x => x.id !== e.id) }); if (selectedExclusion === e.id) selectExclusion(null); }}>删除</button>}
      </div>)}
      {!spec.exclusions.length && <p className="cal-hint">没有避让区。帽檐、缝线、皮标、金属扣等不能印的地方可以画出来。</p>}
      {editable && <button type="button" className="button" onClick={() => draw(null)}>{drawingExclusion ? '取消画避让区' : '＋ 画避让区'}</button>}
    </div>
  </>;
}
export function CatalogCalibration({ detail, preview, style, user, close, saved, replace, addColor, loadVersion, selectColor }: { detail: CatalogDetail; preview: CatalogPlacementPreview; style: CatalogStyle; user: CatalogUser; close: () => void; saved: (id: string) => Promise<void>; replace: () => void; addColor: () => void; loadVersion: (assetVersionId: string) => void; selectColor: (id: string) => void }) {
  const [reuse, setReuse] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [imagePreview, setImagePreview] = useState(false);
  const [layer, setLayer] = useState<Layer>('all');
  const [linked, setLinked] = useState(false);
  const [drawingBoundaryId, setDrawingBoundaryId] = useState<string | null>(null);
  const [drawingPositionKey, setDrawingPositionKey] = useState<PositionKey | null>(null);
  const [manualBoundaries, setManualBoundaries] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<PositionKey | null>(null);
  const [drawingExclusion, setDrawingExclusion] = useState(false);
  const [selectedExclusion, setSelectedExclusion] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const savingRef = useRef(false);
  const [saveNotice, setSaveNotice] = useState('');
  const dirtyRef = useRef(new Set<string>());
  const derived = (id: string, next: PlacementStandard) => derivePositions(next, detail.views.find(v => v.id === id)!, detail);
  const [specs, setSpecs] = useState<Record<string, PlacementStandard>>(() => Object.fromEntries(detail.views.map(v => [v.id, derived(v.id, v.latest?.specification ?? preview.faces.find(f => f.viewId === v.id)!.specification)])));
  const [activeId, setActiveId] = useState(detail.views[0].id);
  const [error, setError] = useState('');
  const [dirtyViews, setDirtyViews] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [recognitionAttempt, setRecognitionAttempt] = useState(0);
  const [recognizedFaces, setRecognizedFaces] = useState<Record<string, { basis: string; hasFrame: boolean }>>({});
  const [recognizingStructure, setRecognizingStructure] = useState(false);
  const [structureNotice, setStructureNotice] = useState('');
  const recognitionFront = detail.views.find(v => v.face === 'front');
  // Apron recognition runs only when asked: it is slow and often misses, so opening shows reference boxes to draw over.
  const shouldRecognize = user.role !== 'viewer' && detail.isCurrent && !!recognitionFront && recognitionAttempt > 0;
  const recognitionViewId = recognitionFront?.id;
  useEffect(() => {
    if (!shouldRecognize || !recognitionViewId) return;
    const controller = new AbortController();
    let active = true;
    async function recognize() {
      setRecognizing(true); setError('');
      try {
        const response = await fetchApi(`/api/catalog/products/${detail.id}/recognize-placement`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetVersionId: detail.assetVersionId }), signal: controller.signal });
        const result = await readApiJson(response, '识别位置失败');
        const recognized = catalogApronRecognitionResponseSchema.parse(result);
        if (!active) return;
        if (recognized.assetVersionId !== detail.assetVersionId || recognized.viewId !== recognitionViewId) throw new Error('识别结果与当前底图不一致，请重新打开');
        setSpecs(current => ({ ...current, [recognized.viewId]: recognized.specification }));
        setRecognizedFaces(current => ({ ...current, [recognized.viewId]: { hasFrame: recognized.hasFrame, basis: recognized.basis } }));
        if (recognized.hasFrame) { dirtyRef.current.add(recognized.viewId); setDirtyViews(new Set(dirtyRef.current)); }
        setReviewed(false); setSaveNotice('');
        setLayer('placement');
      } catch (error) { if (active) setError(`自动识别未完成：${error instanceof Error ? error.message : String(error)}。可重试或手动框选。`); }
      finally { if (active) setRecognizing(false); }
    }
    void recognize();
    return () => { active = false; controller.abort(); };
  }, [detail.id, detail.assetVersionId, recognitionViewId, shouldRecognize, recognitionAttempt]);
  const dirty = dirtyViews.size > 0;
  useEffect(() => {
    // Refresh saved revisions without discarding edits on the other face.
    setSpecs(current => Object.fromEntries(detail.views.map(v => [v.id, dirtyRef.current.has(v.id) ? current[v.id] : derived(v.id, v.latest?.specification ?? preview.faces.find(f => f.viewId === v.id)!.specification)])));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- derived() only reads detail and preview.
  }, [detail, preview]);
  const [historyId, setHistoryId] = useState('');
  const view = detail.views.find(v => v.id === activeId)!;
  const historical = view.history.find(v => v.id === historyId);
  const spec = historical?.specification ?? specs[activeId];
  // One set of points per style: the reference color is edited and applied to the style; a follower is read-only until made its own.
  const reference = style.colors.find(c => c.id === style.referenceVariantId) ?? null;
  const isReference = reference ? reference.id === detail.id : !detail.views.some(v => v.latest?.origin === 'inherited');
  const follows = !isReference && !!reference && detail.views.every(v => !v.latest || v.latest.origin === 'inherited');
  const syncState = colorSyncState(style.referenceVariantId, detail);
  const applies = isReference && style.colors.length > 1;
  // Other colors change only after 同款核对 is confirmed; count the ones still waiting for it.
  const waitingColors = style.colors.filter(c => c.id !== detail.id && ['stale', 'pending'].includes(colorSyncState(style.referenceVariantId, c).key)).length;
  const editable = user.role !== 'viewer' && detail.isCurrent && !historical && !busy && !recognizing && (!follows || unlocked);
  function change(next: PlacementStandard, id = activeId) { next = derived(id, next); setSpecs(current => ({ ...current, [id]: next })); dirtyRef.current.add(id); setDirtyViews(new Set(dirtyRef.current)); setReviewed(false); setSaveNotice(''); }
  function selectView(id: string) { setActiveId(id); setHistoryId(''); }
  const currentPosition = spec.positions.find(p => p.key === selectedKey) ?? spec.positions[0];
  const canReuse = !dirty && !busy && !historical && detail.isCurrent && detail.views.some(v => v.latest?.status === 'confirmed' && v.latest.origin === 'manual' && v.latest.id === v.confirmedId);
  // Confirmed with nothing left to confirm: the main button just opens 同款核对.
  const openCheck = applies && user.role !== 'viewer' && canReuse && !detail.views.some(v => v.latest?.status === 'draft');
  const currentSuggestion = preview.faces.find(f => f.viewId === view.id)!;
  // Caps and aprons use the whole photo when no outline was found; their boxes are drawn directly.
  const manual = manualStructure(spec);
  const needsBoundary = !manual && !view.latest && !currentSuggestion.frame && !manualBoundaries.has(view.id) && !recognizedFaces[view.id]?.hasFrame;
  const facesLabel = detail.views.length > 1 ? '正反面' : detail.views[0].face === 'front' ? '正面' : '背面';
  const missingBoundaries = detail.views.filter(v => !manualStructure(specs[v.id]) && !v.latest && !preview.faces.find(f => f.viewId === v.id)?.frame && !manualBoundaries.has(v.id) && !recognizedFaces[v.id]?.hasFrame);
  const incompleteFaces = detail.views.filter(v => missingBoundaries.includes(v) || !specs[v.id]?.positions.length);
  // Confirming points nobody moved looks like calibration but is still a guess; say which ones.
  const unmoved = detail.views.flatMap(v => {
    const current = specs[v.id], suggestion = preview.faces.find(f => f.viewId === v.id);
    if (!current || !sopDerived(current) || suggestion?.basis.startsWith('沿用同款')) return [];
    const reference = v.latest ? suggestedPlacement(current.structureType, v.face, current.garmentFrame, catalogReferenceType(detail.namespace, detail.styleCode).longSleeve).landmarks : suggestion?.specification.landmarks ?? [];
    // Only points the SOP rules use; the hem does not move any logo. Points recognized on the photo are not guesses.
    const same = current.landmarks.filter(l => l.key !== 'hemCenter' && !(!v.latest && suggestion?.recognized?.includes(l.key)) && reference.some(r => r.key === l.key && Math.abs(r.point.x - l.point.x) < .002 && Math.abs(r.point.y - l.point.y) < .002));
    if (!same.length) return [];
    const side = v.face === 'front' ? '正面' : '背面', names = same.map(l => landmarkLabel(l.key, l.label, v.face)).join('、');
    return [`${side}${v.latest ? same.length >= 5 ? '结构点仍是系统模板原值' : `「${names}」仍是系统模板位置` : `「${names}」仍是估算位置`}，请拖到衣服实际位置后再确认`];
  });
  const longSleeve = catalogReferenceType(detail.namespace, detail.styleCode).longSleeve;
  const templateFaces = detail.views.filter(v => specs[v.id] && sopDerived(specs[v.id]) && hasTemplateLandmarks(specs[v.id], v.face, longSleeve));
  const faceName = (v: CatalogView) => v.face === 'front' ? '正面' : '背面';
  // Overlaps show on the canvas as they happen; confirming waits until every print area is clear of them.
  const blocked = detail.views.flatMap(v => manualStructure(specs[v.id]) ? specs[v.id].positions.flatMap(p => { const hits = conflictsOf(specs[v.id], p.printableArea); return hits.length ? [`${faceName(v)}「${POSITION_LABELS[p.key]}」压到「${hits.map(e => e.label).join('、')}」`] : []; }) : []);
  const confirmationIssue = incompleteFaces.length ? (incompleteFaces.every(v => manualStructure(specs[v.id])) ? `请在${incompleteFaces.map(faceName).join('、')}至少画一个印花位置。` : `请先补全${incompleteFaces.map(faceName).join('、')}的衣服边界和位置标记。`)
    : blocked.length ? `${blocked.join('；')}，拖开或点「自动让开」后再确认。`
    : templateFaces.length ? `${templateFaces.map(v => v.face === 'front' ? '正面' : '背面').join('、')}的结构点还是系统模板位置，拖到衣服实际位置后才能确认。` : '';
  function finishBoundary(id: string, drawn: Box) {
    try {
      const current = specs[id], frame = current.garmentFrame;
      let box = drawn;
      if (manualStructure(current) && (drawingPositionKey || drawingExclusion)) {
        // A click places a default box there; any box is trimmed to the marked area instead of being refused.
        if (box.width < .02 || box.height < .02) { const width = frame.width * (drawingExclusion ? .3 : .25), height = frame.height * (drawingExclusion ? .1 : .2); box = { x: box.x - width / 2, y: box.y - height / 2, width, height }; }
        const x1 = Math.max(frame.x, box.x), y1 = Math.max(frame.y, box.y), x2 = Math.min(frame.x + frame.width, box.x + box.width), y2 = Math.min(frame.y + frame.height, box.y + box.height);
        if (x2 - x1 < .005 || y2 - y1 < .005) throw new Error('请在商品范围内画框');
        box = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      }
      if (drawingExclusion) {
        const id2 = crypto.randomUUID(), area = { x: (box.x - frame.x) / frame.width, y: (box.y - frame.y) / frame.height, width: box.width / frame.width, height: box.height / frame.height };
        change({ ...current, exclusions: [...current.exclusions, { id: id2, label: `避让区 ${current.exclusions.length + 1}`, area }] }, id);
        setSelectedExclusion(id2); setSelectedKey(null);
      } else if (drawingPositionKey) {
        const position = positionFromImageBox(drawingPositionKey, box, specs[id].garmentFrame);
        change({ ...specs[id], positions: [...specs[id].positions.filter(p => p.key !== drawingPositionKey), position] }, id);
        setSelectedKey(drawingPositionKey); setSelectedExclusion(null); setLayer('placement');
      } else {
        change({ ...specs[id], garmentFrame: box }, id);
        setManualBoundaries(current => new Set([...current, id])); setLayer('structure');
      }
      setError(''); setDrawingBoundaryId(null); setDrawingPositionKey(null); setDrawingExclusion(false);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  // key: the print position to draw; null: an exclusion. Pressing the same button again cancels.
  function startDrawing(key: PositionKey | null) {
    const same = drawingBoundaryId === view.id && (key ? drawingPositionKey === key : drawingExclusion);
    setError(''); setDrawingPositionKey(same ? null : key); setDrawingExclusion(!same && !key); setDrawingBoundaryId(same ? null : view.id); setLayer('placement');
  }
  function cancelDrawing() { setDrawingBoundaryId(null); setDrawingPositionKey(null); setDrawingExclusion(false); }
  function changeStructure(structure: StructureType) {
    if (needsBoundary && !MANUAL_STRUCTURES.includes(structure)) { setError('请先框选衣服布面，再生成位置标记'); return; }
    if ((view.latest || (dirtyViews.has(activeId) && spec.positions.length > 0)) && !window.confirm('更换结构会重新生成当前面的建议标记，替换尚未保存的调整；已保存版本仍保留。继续？')) return;
    const template = suggestedPlacement(structure, view.face, spec.garmentFrame, catalogReferenceType(detail.namespace, detail.styleCode).longSleeve);
    const keep = SOP_STRUCTURES.includes(structure) && ['neckCenter', 'leftShoulder', 'rightShoulder', 'leftArmpit', 'rightArmpit'].every(key => spec.landmarks.some(l => l.key === key));
    change(keep ? { ...template, landmarks: spec.landmarks.filter(l => structure === 'polo' || !l.key.startsWith('button')) } : template);
    setLayer(SOP_STRUCTURES.includes(structure) ? 'all' : 'placement');
  }
  // Replaces both faces' structure points with the ones recognized on the photo; unrecognized points stay put.
  async function recognizeStructure() {
    if (dirty && !window.confirm('重新识别会替换正反面的结构点，覆盖尚未保存的结构点调整，继续？')) return;
    setRecognizingStructure(true); setError(''); setStructureNotice('');
    try {
      const response = await fetchApi(`/api/catalog/products/${detail.id}/recognize-structure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetVersionId: detail.assetVersionId }) });
      const result = structureRecognitionSchema.parse(await readApiJson(response, '识别结构点失败'));
      if (result.assetVersionId !== detail.assetVersionId) throw new Error('识别结果与当前底图不一致，请重新打开');
      const notes: string[] = [];
      for (const face of result.faces) {
        const v = detail.views.find(item => item.id === face.viewId), current = specs[face.viewId];
        if (!v || !current || !sopDerived(current)) continue;
        const frame = current.garmentFrame, local = (p: Point) => ({ x: clamp((p.x - frame.x) / frame.width), y: clamp((p.y - frame.y) / frame.height) });
        const buttons = current.structureType === 'polo' && v.face === 'front' && face.points.button2 && face.points.button3
          ? [{ key: 'button2', label: '第二粒扣', point: local(face.points.button2) }, { key: 'button3', label: '第三粒扣', point: local(face.points.button3) }] : null;
        const landmarks = [...current.landmarks.filter(l => !(buttons && l.key.startsWith('button'))).map(l => face.points[l.key] ? { ...l, point: local(face.points[l.key]) } : l), ...(buttons ?? [])];
        change({ ...current, landmarks }, face.viewId);
        const missed = current.landmarks.filter(l => ['neckCenter', 'leftShoulder', 'rightShoulder', 'leftArmpit', 'rightArmpit'].includes(l.key) && !face.points[l.key]).map(l => landmarkLabel(l.key, l.label, v.face));
        notes.push(`${v.face === 'front' ? '正面' : '背面'}${missed.length ? `未识别「${missed.join('、')}」，保留原位置${face.error ? `（${face.error}）` : ''}` : '结构点已全部识别'}`);
      }
      setStructureNotice(`${notes.join('；')}。请核对后保存。`); setLayer('all');
    } catch (error) { setError(`重新识别未完成：${error instanceof Error ? error.message : String(error)}`); }
    finally { setRecognizingStructure(false); }
  }
  async function save(confirm: boolean) {
    if (savingRef.current) return;
    savingRef.current = true; setBusy(true); setError(''); setSaveNotice('');
    let savedResponse = false;
    try {
      const response = await fetchApi('/api/catalog/standards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetVersionId: detail.assetVersionId, confirm,
        views: detail.views.map(v => ({ viewId: v.id, expectedRevision: v.revision, specification: specs[v.id] })) }) });
      await readApiJson(response, '保存位置失败');
      savedResponse = true;
      dirtyRef.current.clear(); setDirtyViews(new Set()); setReviewed(false);
      await saved(detail.id);
      if (confirm && applies) setReuse(true);
      else setSaveNotice(!confirm ? `${facesLabel}草稿已一起保存。` : isReference ? `${facesLabel}位置已确认。` : `${facesLabel}位置已确认为本色单独标准，不随代表色更新。`);
    } catch (error) { setError(`${savedResponse ? `${facesLabel}已保存，但页面未能重新读取：` : ''}${error instanceof Error ? error.message : String(error)}`); }
    finally { savingRef.current = false; setBusy(false); }
  }
  function stopOwnEditing() {
    if (dirty && !window.confirm('放弃为本色单独打点的修改，继续跟随代表色？')) return;
    dirtyRef.current.clear(); setDirtyViews(new Set()); setReviewed(false); setUnlocked(false);
    setSpecs(Object.fromEntries(detail.views.map(v => [v.id, derived(v.id, v.latest?.specification ?? preview.faces.find(f => f.viewId === v.id)!.specification)])));
  }
  function dismiss() { if (dirty && !window.confirm('尚有未保存的位置修改，确认关闭？')) return; close(); }
  if (reuse) return <CatalogReuse variantId={detail.id} close={() => setReuse(false)} saved={() => saved(detail.id)} />;
  return <div className="catalog-backdrop"><section className="catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="cal-title">
    <header className="catalog-dialog-head"><div><h2 id="cal-title">{detail.styleCode} · {detail.colorName}</h2><p>印花位置 · 同屏核对正反面，左右以穿着者为准</p></div><button type="button" className="button" onClick={dismiss}>关闭</button></header>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {reference && !isReference && <div className={`cal-follow-banner ${follows && !unlocked ? '' : 'own'}`} role="note"><div>
      <strong>{unlocked ? '正在为本色单独打点' : follows ? (detail.views.some(v => v.latest) ? `本色跟随代表色「${reference.colorName}」` : `本色尚未应用代表色「${reference.colorName}」`) : `本色单独打点，不随代表色「${reference.colorName}」更新`}</strong>
      <p>{unlocked ? `确认后本色使用自己的点，代表色「${reference.colorName}」再改动也不会影响本色。` : !follows ? '如需改回跟随，可在代表色的「同款核对」里重新套用。' : syncState.key === 'stale' ? '代表色已更新，本色还在用旧版：到代表色上点「应用到同款」，核对无误后更新。' : detail.views.some(v => v.latest) ? '效果图用的是代表色的这套点。要改位置，请到代表色上修改并应用到同款。' : '到代表色上点「应用到同款」，在同款核对里勾选本色并确认无误后生效。'}</p>
    </div><div>{follows && !unlocked && <button type="button" className="button primary" onClick={() => selectColor(reference.id)}>去代表色修改</button>}{follows && !unlocked && user.role !== 'viewer' && detail.isCurrent && <button type="button" className="button" onClick={() => setUnlocked(true)}>为本色单独打点</button>}{unlocked && <button type="button" className="button" disabled={busy} onClick={stopOwnEditing}>取消，继续跟随</button>}</div></div>}
    <div className="catalog-style-toolbar"><div className="catalog-color-options" aria-label="切换同款颜色">{style.colors.map(color => <button type="button" key={color.id} aria-pressed={color.id === detail.id} onClick={() => { if (color.id !== detail.id && (!dirty || window.confirm('切换颜色将放弃未保存修改，继续？'))) selectColor(color.id); }} title={colorSyncState(style.referenceVariantId, color).label}><span className={`catalog-status-symbol ${colorSyncState(style.referenceVariantId, color).key}`} aria-hidden="true">{colorSyncState(style.referenceVariantId, color).symbol}</span> {color.colorName}</button>)}</div></div>
    <div className="cal-legend-bar"><div className="cal-layer-switch" aria-label="标记显示图层">{!manual && ([['all', '全部标记'], ['placement', '印花位置'], ['structure', '结构与避让']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={layer === key} onClick={() => setLayer(key)}>{label}</button>)}<button type="button" className="cal-link-toggle" aria-pressed={linked} title="开启后拖动一侧的结构点、印花位置或避让区，另一侧镜像跟着移动；再点一下关闭" onClick={() => setLinked(v => !v)}>{linked ? '左右联动：开' : '左右联动'}</button></div>{manual ? <><span><i className="cal-legend-area" />能印的范围</span><span><i className="cal-legend-logo" />示例 Logo · 默认大小</span></> : <><span><i className="cal-legend-point" />结构点</span><span><i className="cal-legend-anchor" />印花中心</span><span><i className="cal-legend-area" />可印范围</span></>}<span><i className="cal-legend-danger" />避让区域</span></div>
    <div className="catalog-calibration-body"><div className={`cal-faces ${detail.views.length === 1 ? 'cal-faces-single' : ''}` }>{detail.views.map(v => <FaceCanvas key={v.id} detail={detail} view={v} spec={v.id === activeId ? spec : specs[v.id]} active={v.id === activeId} editable={editable} layer={manualStructure(specs[v.id]) ? 'placement' : layer} linked={linked} selectedKey={manualStructure(specs[v.id]) ? selectedKey : currentPosition?.key ?? null} selectedExclusion={selectedExclusion} status={recognizing && v.face === 'front' ? '正在识别位置…' : dirtyViews.has(v.id) ? '有未保存调整' : v.latest?.status === 'confirmed' ? '已确认' : v.latest ? '草稿 · 待确认' : manualStructure(specs[v.id]) ? (specs[v.id].positions.length ? '参考框 · 未保存' : '还没画位置') : preview.faces.find(f => f.viewId === v.id)?.frame ? '参考标记 · 未保存' : '待手动框选衣服'} activate={() => selectView(v.id)} selectPosition={setSelectedKey} selectExclusion={setSelectedExclusion} change={next => change(next, v.id)} drawingBoundary={drawingBoundaryId === v.id} finishBoundary={box => finishBoundary(v.id, box)} cancelDrawing={cancelDrawing} />)}</div>
    <aside className="cal-inspector"><strong>{view.face === 'front' ? '正面' : '背面'}印花位置</strong><p className="cal-hint">{sopDerived(spec) ? `拖动结构点（领口中心、肩点、腋点${spec.structureType === 'polo' && view.face === 'front' ? '、扣位' : ''}），印花位置按效果图 SOP 自动计算；拖动印花中心可再微调位置，尺寸仍按 SOP 或客户要求，效果图使用同一结果。红色斜线区域需避让。` : manual ? '点「画框」后在照片上拖出能印的范围，只点一下会放一个默认框。框里的示例 Logo 表示默认印多大、印在哪；红色斜线是不能印的地方。' : '点选位置，拖动圆点调整印花中心；拖动绿色框调整范围，红色斜线区域需避让。'}</p>
      {!view.latest && manual && <div className="cal-suggestion-note"><strong>{recognizing ? '正在让 AI 框围裙位置' : recognizedFaces[view.id] ? 'AI 给的参考框 · 等你核对' : spec.positions.length ? '等你核对' : '还没画位置'}</strong><p>{recognizing ? '识别完成后会替换成 AI 给的框，请稍候。' : recognizedFaces[view.id] ? recognizedFaces[view.id].basis : spec.positions.length ? '把框拖到实际能印的布面上，示例 Logo 调到默认要印的大小。确认前不会用于生产。' : '在下面选一个位置点「画框」，到照片上拖出能印的范围。'}</p></div>}
      {!view.latest && !manual && <div className="cal-suggestion-note"><strong>{recognizing ? '正在自动识别围裙位置' : needsBoundary ? '需要手动定位衣服' : '参考标记 · 等待你核对'}</strong><p>{recognizing ? '正在观察实际照片并放大复核口袋边缘、分隔线与印花布面，请稍候。' : recognizedFaces[view.id] ? recognizedFaces[view.id].basis : manualBoundaries.has(view.id) ? '已使用你框选的衣服区域；生成参考标记后仍需核对具体印花位置与缝线等避让区。' : currentSuggestion.basis}</p><p>{recognizing ? '识别完成后会自动显示建议框；确认前不会用于生产。' : needsBoundary ? '先框选围裙或衣服本体，不包含头部、腿部和背景；框好后生成参考位置，再逐项调整。' : '这些是可调整的参考位置，确认前不会用于生产。'}</p></div>}
      {editable && !manual && <div className="cal-boundary-controls"><button type="button" className="button primary" onClick={() => { setDrawingPositionKey(null); setDrawingExclusion(false); setDrawingBoundaryId(drawingBoundaryId === view.id ? null : view.id); }}>{drawingBoundaryId === view.id ? '取消框选' : '框选衣服区域'}</button>{drawingBoundaryId === view.id && <p role="status">{drawingPositionKey ? `在图片上框选${POSITION_LABELS[drawingPositionKey]}的可印范围，避开缝线。` : '在图片上按住并拖出矩形，框住衣服布面。'}</p>}{!needsBoundary && !spec.positions.length && <p>区域已就绪，请点击下方“生成参考标记”。</p>}</div>}
      {editable && sopDerived(spec) && !needsBoundary && <div className="cal-suggestion-note"><strong>结构点识别</strong><p>{structureNotice || '肩点、腋点按衣服轮廓识别，领口中心和扣位由看图模型识别。点击后替换正反面结构点，保存确认后才生效。'}</p><button type="button" className="button" disabled={recognizingStructure || drawingBoundaryId !== null} onClick={() => void recognizeStructure()}>{recognizingStructure ? '识别中…' : '重新识别结构点'}</button></div>}
      {spec.structureType === 'apron' && view.face === 'front' && user.role !== 'viewer' && detail.isCurrent && !historical && <div className="cal-manual-ai"><button type="button" className="button" disabled={busy || recognizing || drawingBoundaryId !== null} onClick={() => { if (dirty && !window.confirm('AI 给的框会替换当前未保存的调整，继续？')) return; setRecognitionAttempt(current => current + 1); }}>{recognizing ? '识别中…' : '让 AI 试着框一下'}</button><small>较慢，也常不准；给出的框仍需核对。</small></div>}
      {manual && <ManualMarks spec={spec} face={view.face} editable={editable} drawingKey={drawingBoundaryId === view.id ? drawingPositionKey : null} drawingExclusion={drawingBoundaryId === view.id && drawingExclusion} selectedKey={selectedKey} selectedExclusion={selectedExclusion} draw={startDrawing} select={setSelectedKey} selectExclusion={setSelectedExclusion} change={next => change(next)} />}
      {spec.structureType === 'polo' && view.face === 'front' && <div className="cal-suggestion-note"><strong>Polo 扣位</strong><p>{spec.landmarks.some(l => l.key === 'button2') ? '胸标按 SOP 放在第二、三粒扣之间；高度超过 6 厘米时放在第三粒扣。' : '未标扣位时，胸标按领口下约 9.5 厘米估算。标出第二、三粒扣后按 SOP 精确放置。'}</p>{editable && <button type="button" className="button" disabled={needsBoundary} onClick={() => {
        if (spec.landmarks.some(l => l.key === 'button2')) { change({ ...spec, landmarks: spec.landmarks.filter(l => !l.key.startsWith('button')) }); return; }
        const neck = spec.landmarks.find(l => l.key === 'neckCenter'), left = spec.landmarks.find(l => l.key === 'leftArmpit'), right = spec.landmarks.find(l => l.key === 'rightArmpit');
        if (!neck || !left || !right) { setError('请先标出领口中心和左右腋点'); return; }
        const pixel = facePixels(spec, view, detail), cm = Math.abs(right.point.x - left.point.x) * pixel.width / PROJECTED_BODY_WIDTH_CM / pixel.height;
        change({ ...spec, landmarks: [...spec.landmarks, { key: 'button2', label: '第二粒扣', point: { x: neck.point.x, y: clamp(neck.point.y + 6.5 * cm) } }, { key: 'button3', label: '第三粒扣', point: { x: neck.point.x, y: clamp(neck.point.y + 13 * cm) } }] }); setLayer('all');
      }}>{spec.landmarks.some(l => l.key === 'button2') ? '移除扣位标记' : '标出第二、三粒扣'}</button>}</div>}
      {!manual && <div className="cal-position-list" aria-label="选择印花位置">{spec.positions.map(p => <button type="button" key={p.key} aria-pressed={currentPosition?.key === p.key} onClick={() => { setSelectedKey(p.key); setLayer(sopDerived(spec) ? 'all' : 'placement'); }}>{POSITION_LABELS[p.key]}<small>{currentPosition?.key === p.key ? '正在调整' : p.offsetCm ? '已微调' : '点击查看'}</small></button>)}</div>}
      {sopDerived(spec) && currentPosition && <div className="cal-offset" aria-label={`${POSITION_LABELS[currentPosition.key]}位置微调`}><strong>{POSITION_LABELS[currentPosition.key]}中心</strong><p className="cal-hint">{currentPosition.offsetCm ? `在 SOP 位置上${describeSopOffset(currentPosition.offsetCm)}。` : '当前按 SOP 位置。可直接拖动画布上的印花中心，或填写偏移。'}</p>
        <div className="cal-four">{(['x', 'y'] as const).map(axis => <label className="cal-number" key={axis}><span>{axis === 'x' ? '画面右移' : '下移'}</span><input type="number" min="-40" max="40" step="0.1" disabled={!editable} value={currentPosition.offsetCm?.[axis] ?? 0} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) change(withOffset(spec, currentPosition.key, { ...(currentPosition.offsetCm ?? { x: 0, y: 0 }), [axis]: value })); }} /><small>厘米</small></label>)}</div>
        {currentPosition.offsetCm && <button type="button" className="button" disabled={!editable} onClick={() => change(withOffset(spec, currentPosition.key, null))}>恢复 SOP 位置</button>}</div>}
      {(historical ?? view.latest)?.source && <p className="catalog-standard-source">共用自 {(historical ?? view.latest)!.source!.colorName} · 标准 v{(historical ?? view.latest)!.source!.revision}。单独修改并保存后，将形成当前颜色自己的标准。</p>}
      {user.role !== 'viewer' && <button className="button" type="button" onClick={() => { if (!dirty || window.confirm('添加颜色将放弃尚未保存的位置修改，继续？')) addColor(); }}>添加同款颜色</button>}
      <label className="cal-field">已保存版本<select value={historyId} onChange={e => setHistoryId(e.target.value)}><option value="">当前编辑</option>{view.history.map(h => <option key={h.id} value={h.id}>v{h.revision} · {h.status === 'confirmed' ? '已确认' : '草稿'} · {h.createdBy}</option>)}</select></label>
      <label className="cal-field">结构类型<select value={spec.structureType} disabled={!editable || drawingBoundaryId !== null} onChange={e => changeStructure(e.target.value as StructureType)}>{Object.entries(STRUCTURE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <fieldset disabled={!editable || needsBoundary || drawingBoundaryId !== null}>
      <button className="button" type="button" disabled={spec.structureType === 'unknown'} onClick={() => changeStructure(spec.structureType)}>{manual ? '恢复参考框' : spec.positions.length ? '重新生成参考标记' : '生成参考标记'}</button>
      {!manual && <details onToggle={event => { if (event.currentTarget.open) setLayer('structure'); }}><summary>调整衣服边界</summary><BoxFields value={spec.garmentFrame} change={b => change({ ...spec, garmentFrame: b })} /></details>}
      {sopDerived(spec) ? <details><summary>印花位置规则 · {spec.positions.length}</summary><ul className="cal-hint">
        <li>左/右胸：第二、三粒扣之间（无扣款为领口下约 9.5 厘米）；高度超过 6 厘米下移到第三粒扣；默认宽 8 厘米，高不超过 9 厘米。</li>
        <li>后背：肩点至袖窿底之间居中；默认宽 26 厘米，高不超过 22 厘米。后领下方：后领下约 3 厘米。</li>
        <li>袖子：距袖子缝合线约 0.75 厘米。正前面：上沿在领口下约 8 厘米。</li>
        <li>客户指定尺寸优先；尺寸按投影衣身宽 40 厘米换算。框内显示的是常见横版 Logo 的默认大小。</li>
        <li>微调：在 SOP 位置上叠加你设定的偏移（厘米），结构点改动后跟着移动，同款沿用标准时一起沿用；微调后的位置不会被自动推离避让区，重叠时会提示。</li>
      </ul></details> : !manual && <details><summary>精细调整印花位置 · {spec.positions.length}</summary>{spec.positions.map((position, i) => <div className="cal-position" key={position.key}><strong>{POSITION_LABELS[position.key]}</strong><button type="button" className="cal-remove" onClick={() => change({ ...spec, positions: spec.positions.filter((_, index) => i !== index) })}>移除</button><span className="cal-field-title">最大可印范围</span><BoxFields value={position.printableArea} change={box => change({ ...spec, positions: spec.positions.map((p, index) => i === index ? { ...p, printableArea: box } : p) })} /><div className="cal-four"><Percent label="锚点 X" value={position.anchor.x} change={x => change({ ...spec, positions: spec.positions.map((p, index) => i === index ? { ...p, anchor: { ...p.anchor, x } } : p) })} /><Percent label="锚点 Y" value={position.anchor.y} change={y => change({ ...spec, positions: spec.positions.map((p, index) => i === index ? { ...p, anchor: { ...p.anchor, y } } : p) })} /><Percent label="默认宽" value={position.defaultSize.width} change={width => change({ ...spec, positions: spec.positions.map((p, index) => i === index ? { ...p, defaultSize: { ...p.defaultSize, width } } : p) })} /><Percent label="默认高" value={position.defaultSize.height} change={height => change({ ...spec, positions: spec.positions.map((p, index) => i === index ? { ...p, defaultSize: { ...p.defaultSize, height } } : p) })} /></div></div>)}
      <select aria-label="添加印制位置" value="" onChange={e => { const key = e.target.value as keyof typeof POSITION_LABELS; if (key === 'apronPocket') { setDrawingPositionKey(key); setDrawingBoundaryId(view.id); setLayer('placement'); return; } if (key) change({ ...spec, positions: [...spec.positions, { key, anchor: { x: .5, y: .5 }, printableArea: { x: .4, y: .4, width: .2, height: .2 }, defaultSize: { width: .1, height: .1 } }] }); }}><option value="">＋ 添加并手动校准位置</option>{allowedPositions(spec.structureType, view.face).filter(key => !spec.positions.some(p => p.key === key)).map(key => <option key={key} value={key}>{POSITION_LABELS[key]}</option>)}</select></details>}
      {!manual && <details><summary>调整避让区域 · {spec.exclusions.length}</summary>{spec.exclusions.map((exclusion, i) => <div className="cal-position" key={exclusion.id}><input aria-label="禁区名称" value={exclusion.label} onChange={e => change({ ...spec, exclusions: spec.exclusions.map((x, index) => i === index ? { ...x, label: e.target.value } : x) })} /><BoxFields value={exclusion.area} change={box => change({ ...spec, exclusions: spec.exclusions.map((x, index) => i === index ? { ...x, area: box } : x) })} /><button type="button" className="cal-remove" onClick={() => change({ ...spec, exclusions: spec.exclusions.filter((_, index) => index !== i) })}>移除禁区</button></div>)}<button type="button" className="button" onClick={() => change({ ...spec, exclusions: [...spec.exclusions, { id: crypto.randomUUID(), label: '待标记禁区', area: { x: .45, y: .1, width: .1, height: .2 } }] })}>添加缝线等不可印区域</button></details>}
      <label className="cal-field">复核备注<textarea value={spec.note} maxLength={2000} onChange={e => change({ ...spec, note: e.target.value })} /></label>
      </fieldset>
      <details><summary>原图与底图版本</summary><button type="button" className="button" onClick={() => setImagePreview(true)}>放大查看衣服</button><p className="cal-hint">原文件按名称匹配，仅作来源候选；未冒充逐面人工复核结果。</p>{detail.sources.map((source, i) => <a className="cal-source-link" key={`${source.url}-${i}`} href={source.url} target="_blank" rel="noreferrer">{source.filename} ↗</a>)}{detail.versions.map(v => <p className="cal-hint" key={v.id}><button type="button" className="button" onClick={() => { if (!dirty || window.confirm('切换底图版本将放弃未保存修改，继续？')) loadVersion(v.id); }}>底图 v{v.version}{v.id === detail.assetVersionId ? ' · 正在查看' : ''}</button> · {v.sha256.slice(0, 12)}</p>)}<p className="cal-hint">{detail.sha256}</p>{user.role !== 'viewer' && detail.isCurrent && <button type="button" className="button" onClick={() => { if (!dirty || window.confirm('将放弃尚未保存的校准修改，继续上传新版底图？')) replace(); }}>上传新版底图</button>}</details>
    </aside></div>
    <footer className="catalog-dialog-foot cal-confirm-footer"><div className="cal-confirm-copy">{historical || !detail.isCurrent ? <span>历史版本只读</span> : openCheck ? <small>{waitingColors ? `同款还有 ${waitingColors} 色没用上这套位置，到同款核对里看过、点「确认无误」后生效。` : '同款颜色都已跟随代表色或单独打点，改位置后重新确认即可。'}</small> : <><label className="catalog-check"><input type="checkbox" checked={reviewed} disabled={!editable || !!confirmationIssue || drawingBoundaryId !== null} onChange={event => setReviewed(event.target.checked)} />{detail.views.every(v => manualStructure(specs[v.id])) ? `已核对${facesLabel}印花位置和避让区域` : `已核对${facesLabel}衣服边界、位置点和避让区域`}</label><small>{confirmationIssue || (applies ? '确认后打开同款核对：看过其他颜色套用后的位置，点「确认无误」才生效；单独打点的颜色保留。' : follows && !unlocked ? '本色跟随代表色，无需在这里确认。' : `一次保存${facesLabel}的全部调整。`)}</small>{!confirmationIssue && unmoved.map(text => <small key={text} className="cal-unmoved" role="note">{text}</small>)}{saveNotice && <small role="status">{saveNotice}</small>}</>}</div><div><button className="button" disabled={!editable || missingBoundaries.length > 0 || drawingBoundaryId !== null} onClick={() => void save(false)} type="button">{busy ? '保存中…' : `保存${facesLabel}草稿`}</button>{openCheck ? <button className="button primary" type="button" onClick={() => setReuse(true)}>{waitingColors ? `应用到同款 · ${waitingColors} 色待套用` : '查看同款 · 全部已生效'}</button> : <button className="button primary" disabled={!editable || !!confirmationIssue || drawingBoundaryId !== null || !reviewed} onClick={() => void save(true)} type="button">{applies ? '确认并应用到同款' : `确认${facesLabel}位置`}</button>}</div></footer>


  </section>{imagePreview && <CatalogImagePreview items={[detail]} initialId={detail.id} close={() => setImagePreview(false)} />}</div>;
}
