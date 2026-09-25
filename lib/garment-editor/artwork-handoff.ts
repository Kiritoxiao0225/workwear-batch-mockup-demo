import type { CanvasElement, MockupPlacement, ProductFace } from './mockup-types';
import {
  MOCKUP_PLACEMENT_LABELS,
  defaultDecorationProductId,
  defaultPlacementForDecoration,
  placementMatchesProductFace,
  productFace,
} from './mockup-element-relations';

/**
 * What the garment editor hands the artwork studio when the user leaves to make a logo:
 * where the result should land when it comes back. Kept in this tab's sessionStorage only.
 */
export interface ArtworkHandoff {
  version: 1;
  createdAt: number;
  projectId: string;
  projectName: string;
  products: { id: string; label: string; face: ProductFace }[];
  ownerId: string | null;
  placement: MockupPlacement;
  replace?: {
    elementId: string;
    label: string;
    /** A short fingerprint of the logo image at the time of leaving; the image itself may be a large data URL. */
    imageKey: string;
    /** A saved copy of that logo, so the studio can use it as 图1. */
    refUrl: string;
  };
}

const KEY = 'garment-artwork-handoff';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const imageKey = (image: string) =>
  `${image.length}:${image.slice(0, 64)}:${image.slice(-64)}`;

export function garmentLabel(elements: CanvasElement[], productId: string) {
  const products = elements.filter(element => element.type === 'product');
  const index = products.findIndex(product => product.id === productId);
  if (index < 0) return '未指定衣服';
  return `衣服 ${index + 1} · ${productFace(products[index]) === 'back' ? '背面' : '正面'}`;
}

export function targetLabel(handoff: Pick<ArtworkHandoff, 'products' | 'ownerId' | 'placement'>) {
  const owner = handoff.products.find(product => product.id === handoff.ownerId);
  return owner ? `${owner.label} · ${MOCKUP_PLACEMENT_LABELS[handoff.placement]}` : '未指定衣服';
}

/** The same rule as an upload: the selected garment, the garment under the selection, or the only garment. */
export function newArtworkHandoff(input: {
  elements: CanvasElement[];
  selectedElementId: string | null;
  projectId: string;
  projectName: string;
  replace?: ArtworkHandoff['replace'];
}): ArtworkHandoff {
  const { elements } = input;
  const products = elements
    .filter(element => element.type === 'product')
    .map(product => ({ id: product.id, label: garmentLabel(elements, product.id), face: productFace(product) }));
  const replaced = input.replace ? elements.find(element => element.id === input.replace!.elementId) : null;
  const ownerId = replaced ? replaced.placedOnProductId ?? null : defaultDecorationProductId(elements, input.selectedElementId);
  const owner = products.find(product => product.id === ownerId);
  return {
    version: 1,
    createdAt: Date.now(),
    projectId: input.projectId,
    projectName: input.projectName,
    products,
    ownerId: owner ? owner.id : null,
    placement: replaced?.placement ?? (owner ? defaultPlacementForDecoration('logo', owner.face) : 'custom'),
    ...(input.replace ? { replace: input.replace } : {}),
  };
}

/** Changing the garment in the studio resets the position to that face's default. */
export function retargetHandoff(handoff: ArtworkHandoff, ownerId: string | null, placement?: MockupPlacement): ArtworkHandoff {
  const owner = handoff.products.find(product => product.id === ownerId);
  if (!owner) return { ...handoff, ownerId: null, placement: 'custom' };
  const next = placement && placementMatchesProductFace(placement, owner.face)
    ? placement
    : ownerId === handoff.ownerId && placementMatchesProductFace(handoff.placement, owner.face)
      ? handoff.placement
      : defaultPlacementForDecoration('logo', owner.face);
  return { ...handoff, ownerId: owner.id, placement: next };
}

export function writeArtworkHandoff(handoff: ArtworkHandoff) {
  try { sessionStorage.setItem(KEY, JSON.stringify(handoff)); return true; } catch { return false; }
}

export function readArtworkHandoff(): ArtworkHandoff | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) || 'null') as ArtworkHandoff | null;
    if (!value || value.version !== 1 || typeof value.projectId !== 'string' || !Array.isArray(value.products)) return null;
    if (!(Date.now() - value.createdAt < MAX_AGE_MS)) return null;
    return value;
  } catch { return null; }
}

export function clearArtworkHandoff() {
  try { sessionStorage.removeItem(KEY); } catch { /* storage unavailable: nothing to clear */ }
}
