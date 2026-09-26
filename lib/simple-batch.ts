import { z } from 'zod';
import { PLACEMENT_DEFAULTS, PLACEMENT_LABELS, placementCenter, placementWidthRatio } from '@/lib/mockup';
import { PLACEMENT_KEYS } from '@/lib/types';
import { drawnSlots, MANUAL_STRUCTURES, POSITION_LABELS, slotPositionKey, type StructureType } from '@/lib/catalog';
import { productByCode } from '@/lib/products';
import { garmentBindingSchema } from '@/lib/production-garment';
import { catalogReferenceType, placementPreviewSchema, suggestedPlacement } from '@/lib/catalog-placement-suggestions';
import { MOCKUP_BODY_WIDTH_CM } from '@/lib/production-sizing';
import type { LogoPlacement, MockupTask, PlacementKey, Product } from '@/lib/types';

export const simpleCatalogBindingSchema = z.object({ garment: garmentBindingSchema, placementDefaults: placementPreviewSchema });
export function simpleCanvasImageUrl(url: string) {
  return url.replace(/^\/api\/catalog\/files\/([0-9a-f-]{36})$/, '/api/production-files/$1');
}
export function simpleTaskProduct(task: MockupTask): Product | null {
  const g = task.garment;
  return g ? { code: g.styleCode, name: g.colorName, color: g.colorName, originalUrl: g.imageUrl,
    thumbnailUrl: g.imageUrl, width: g.width, height: g.height, garmentWidthCm: 55 } : productByCode(task.productCode);
}

// Simple mode consumes confirmed positions when present, otherwise the same
// saved/default preview used by the catalog editor. Defaults never become confirmations.
function positionContext(task: MockupTask, key: PlacementKey, placement?: LogoPlacement) {
  const g = task.garment;
  const view = g?.views.find(view => view.face === (key === 'back' ? 'back' : 'front'));
  if (!g || !view) return null;
  const confirmed = view.standard?.specification;
  const savedDefault = task.placementDefaults?.faces.find(face => face.viewId === view.id)?.specification;
  const reference = catalogReferenceType('normalized-garments-v1', g.styleCode);
  const structure = simpleStructure(task, key);
  const catalogKey = slotPositionKey(key, placement?.catalogPosition, structure);
  const frame = savedDefault?.garmentFrame ?? confirmed?.garmentFrame ?? { x: 0, y: 0, width: 1, height: 1 };
  const suggested = savedDefault ?? suggestedPlacement(reference.structure === 'unknown' ? 'crewneck' : reference.structure, view.face, frame, reference.longSleeve);
  // Caps and aprons never borrow a clothing template: an undrawn position stays missing.
  const standard = confirmed?.positions.some(p => p.key === catalogKey) ? confirmed
    : suggested.positions.some(p => p.key === catalogKey) ? suggested
      : drawn(structure) ? null : suggestedPlacement('crewneck', view.face, frame, reference.longSleeve);
  if (!standard) return null;
  const position = standard.positions.find(p => p.key === catalogKey);
  if (!position) return null;
  return { view, standard, position, confirmed: standard === confirmed };
}
const drawn = (structure: StructureType) => MANUAL_STRUCTURES.includes(structure);
/** The structure the catalog confirmed for this face, else its saved default, else the style's reference type. */
function simpleStructure(task: MockupTask, key: PlacementKey): StructureType {
  const g = task.garment, view = g?.views.find(view => view.face === (key === 'back' ? 'back' : 'front'));
  if (!g) return 'unknown';
  return view?.standard?.specification.structureType ?? task.placementDefaults?.faces.find(face => face.viewId === view?.id)?.specification.structureType ?? catalogReferenceType('normalized-garments-v1', g.styleCode).structure;
}
/** Caps and aprons: sizes are relative to the sample logo drawn in the catalog; 100% is the slot's default width. */
export function simpleRelativeSize(task: MockupTask, key: PlacementKey) {
  return drawn(simpleStructure(task, key)) ? PLACEMENT_DEFAULTS[key].widthCm : null;
}
/** The production slots this task offers: every clothing slot, or one slot per drawn cap or apron position. */
export function simpleSlots(task: MockupTask): Array<{ key: PlacementKey; label: string }> {
  const slots = drawnSlots(simpleStructure(task, 'frontCenter')).filter(({ slot }) => task.garment?.views.some(view => view.face === (slot === 'back' ? 'back' : 'front')));
  return slots.length ? slots.map(({ slot, key }) => ({ key: slot, label: POSITION_LABELS[key] })) : PLACEMENT_KEYS.map(key => ({ key, label: PLACEMENT_LABELS[key] }));
}
export function simplePlacementLabel(task: MockupTask, key: PlacementKey) {
  return simpleSlots(task).find(slot => slot.key === key)?.label ?? PLACEMENT_LABELS[key];
}
export function simplePositionSource(task: MockupTask, key: PlacementKey, placement?: LogoPlacement) {
  return positionContext(task, key, placement)?.confirmed ? '已校准位置' : '默认位置';
}
export function simpleBackPositions(task: MockupTask): Array<'upperBack' | 'backCenter'> {
  if (task.garment && drawn(simpleStructure(task, 'back'))) return [];
  return !task.garment || task.garment.views.some(view => view.face === 'back') ? ['backCenter', 'upperBack'] : [];
}
export function simplePositionIssue(task: MockupTask, key: PlacementKey, placement?: LogoPlacement) {
  if (!task.garment) return null;
  if (positionContext(task, key, placement)) return null;
  const face = key === 'back' ? '背面' : '正面';
  return task.garment.views.some(view => view.face === (key === 'back' ? 'back' : 'front')) ? `该款没有确认过「${simplePlacementLabel(task, key)}」，请到商品素材库画框` : `该衣服缺少${face}底图`;
}
export function simplePlacementGeometry(task: MockupTask, key: PlacementKey, placement: LogoPlacement, aspectRatio: number) {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) throw new Error('Logo 宽高比无效');
  if (!task.garment) {
    const product = simpleTaskProduct(task);
    if (!product) throw new Error(`找不到商品 ${task.productCode}`);
    const center = placementCenter(key, placement);
    const width = product.width * placementWidthRatio(placement, product);
    return { width, height: width / aspectRatio, centerX: center.x * product.width, centerY: center.y * product.height };
  }
  const context = positionContext(task, key, placement);
  if (!context) throw new Error(simplePositionIssue(task, key) ?? '缺少制作位置');
  const { view, standard: spec, position } = context;
  const g = task.garment, frame = spec.garmentFrame;
  const left = spec.landmarks.find(p => p.key === 'leftArmpit');
  const right = spec.landmarks.find(p => p.key === 'rightArmpit');
  const bodyRatio = view.bodyScale?.widthRatio ?? (left && right ? Math.abs(right.point.x - left.point.x) * frame.width : frame.width * .55);
  const relative = simpleRelativeSize(task, key);
  // Caps and aprons: the sample logo drawn in the catalog, fitted to this logo's proportions and scaled by the chosen size.
  const width = relative ? Math.min(position.defaultSize.width * frame.width * view.crop.width * g.width, position.defaultSize.height * frame.height * view.crop.height * g.height * aspectRatio) * placement.widthCm / relative
    : placement.widthCm / MOCKUP_BODY_WIDTH_CM * g.width * view.crop.width * bodyRatio;
  if (!Number.isFinite(width) || width <= 0) throw new Error('Logo 尺寸无效');
  return { width, height: width / aspectRatio,
    centerX: (view.crop.x + view.crop.width * (frame.x + (position.anchor.x + placement.offsetX / 100) * frame.width)) * g.width,
    centerY: (view.crop.y + view.crop.height * (frame.y + (position.anchor.y + placement.offsetY / 100) * frame.height)) * g.height };
}
export function simpleOffsetScale(task: MockupTask, key: PlacementKey) {
  const context = positionContext(task, key, task.placements[key]);
  return context ? { x: context.view.crop.width * context.standard.garmentFrame.width, y: context.view.crop.height * context.standard.garmentFrame.height } : { x: 1, y: 1 };
}
export function simplePositionAnchor(task: MockupTask, key: PlacementKey, placement?: LogoPlacement) {
  const context = positionContext(task, key, placement);
  if (!context) return null;
  const { view, standard: { garmentFrame: frame }, position } = context;
  return { x: view.crop.x + view.crop.width * (frame.x + position.anchor.x * frame.width),
    y: view.crop.y + view.crop.height * (frame.y + position.anchor.y * frame.height) };
}
export function simpleGeometryIssue(task: MockupTask, key: PlacementKey, placement: LogoPlacement, aspectRatio: number) {
  try {
    const geometry = simplePlacementGeometry(task, key, placement, aspectRatio);
    const product = simpleTaskProduct(task)!;
    const radians = placement.rotation * Math.PI / 180;
    const halfW = (Math.abs(Math.cos(radians)) * geometry.width + Math.abs(Math.sin(radians)) * geometry.height) / 2;
    const halfH = (Math.abs(Math.sin(radians)) * geometry.width + Math.abs(Math.cos(radians)) * geometry.height) / 2;
    if (geometry.centerX - halfW < 0 || geometry.centerY - halfH < 0 || geometry.centerX + halfW > product.width || geometry.centerY + halfH > product.height) return `${simplePlacementLabel(task, key)}：部分 Logo 超出整张图片，导出会裁掉超出部分`;
    return null;
  } catch (error) { return `${simplePlacementLabel(task, key)}：${error instanceof Error ? error.message : String(error)}`; }
}
