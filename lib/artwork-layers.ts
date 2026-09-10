import { artworkGraphicLayers, artworkTextLayers, type ArtworkBounds, type ArtworkDraft, type ArtworkGraphicLayer, type ArtworkTextLayer } from './artwork-editor';
import { DEFAULT_ARTWORK_FONT } from './artwork-text-defaults';

export type ArtworkLayer = { kind: 'graphic'; id: string; index: number; value: ArtworkGraphicLayer } | { kind: 'text'; id: string; index: number; value: ArtworkTextLayer };
export type ArtworkPoint = { x: number; y: number };
/** Selection is transient editor state; persisted layers keep the existing PNG format. */
export type ArtworkSelection = ArtworkBounds & { points?: ArtworkPoint[] };

export function artworkPolygonSelection(points: ArtworkPoint[]): ArtworkSelection | null {
  if (points.length < 3 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  if (Math.abs(area) < 1e-8) return null;
  const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
  return { left, top, width: Math.max(...points.map(p => p.x)) - left, height: Math.max(...points.map(p => p.y)) - top, points: points.map(p => ({ ...p })) };
}

function selectionContainsPoint(selection: ArtworkSelection, x: number, y: number) {
  if (x < selection.left || x > selection.left + selection.width || y < selection.top || y > selection.top + selection.height) return false;
  const points = selection.points;
  if (!points) return x < selection.left + selection.width && y < selection.top + selection.height;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    const cross = (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
    if (Math.abs(cross) < 1e-8 && x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x) && y >= Math.min(a.y, b.y) && y <= Math.max(a.y, b.y)) return true;
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Map a pointer to the unrotated layer, for alpha-aware picking at any canvas zoom. */
export function artworkPointInLayer(point: { x: number; y: number }, bounds: ArtworkBounds, rotation = 0) {
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const dx = point.x - bounds.left - bounds.width / 2, dy = point.y - bounds.top - bounds.height / 2;
  const angle = rotation * Math.PI / 180;
  const x = (dx * Math.cos(angle) + dy * Math.sin(angle)) / bounds.width + .5;
  const y = (-dx * Math.sin(angle) + dy * Math.cos(angle)) / bounds.height + .5;
  return x >= 0 && x < 1 && y >= 0 && y < 1 ? { x, y } : null;
}

/** Old projects keep their original paint order until opened for editing. */
export function artworkLayers(draft: ArtworkDraft): ArtworkLayer[] {
  const layers: ArtworkLayer[] = [
    ...artworkGraphicLayers(draft).map((value, index) => ({ kind: 'graphic' as const, id: value.id ?? `graphic-${index + 1}`, index, value })),
    ...artworkTextLayers(draft).map((value, index) => ({ kind: 'text' as const, id: value.id ?? `text-${index + 1}`, index, value })),
  ];
  return draft.layerOrder ? draft.layerOrder.map(id => layers.find(layer => layer.id === id)!).filter(Boolean) : layers;
}

export function editableArtworkDraft(original: ArtworkDraft): ArtworkDraft {
  const draft = structuredClone(original);
  const used = new Set<string>();
  const items = [...artworkGraphicLayers(draft), ...artworkTextLayers(draft)];
  items.forEach((layer, index) => {
    let id = layer.id || `layer-${index + 1}`;
    while (used.has(id)) id += '-copy';
    used.add(id); layer.id = id;
  });
  draft.layerOrder ??= items.map(layer => layer.id!);
  return draft;
}

export function updateArtworkLayer(draft: ArtworkDraft, id: string, patch: Partial<ArtworkGraphicLayer & ArtworkTextLayer>): ArtworkDraft {
  const graphics = artworkGraphicLayers(draft).map(layer => layer.id === id ? { ...layer, ...patch } : layer);
  const texts = artworkTextLayers(draft).map(layer => layer.id === id ? { ...layer, ...patch } : layer);
  return { ...draft, graphic: graphics[0], extraGraphics: graphics.slice(1), text: texts[0] ?? null, extraTexts: texts.slice(1) };
}

function availableLayerId(draft: ArtworkDraft, prefix: string) {
  const ids = new Set(artworkLayers(draft).map(layer => layer.id));
  if (ids.size >= 64) throw new Error('最多支持 64 个图层，请先删除不需要的图层。');
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}

/** A new overlay is authored text, never an inferred editable version of lettering in the source image. */
export function addArtworkText(draft: ArtworkDraft, position: { x: number; y: number }, color = '#000000') {
  const next = editableArtworkDraft(draft), id = availableLayerId(next, 'text');
  const layer: ArtworkTextLayer = {
    id, label: '新文字', visible: true, value: '新文字', x: position.x, y: position.y,
    boxWidth: 600, fontFamily: DEFAULT_ARTWORK_FONT,
    fontSize: 64, color, letterSpacing: 2, lineHeight: 1.4, fontWeight: 700,
    italic: false, underline: false, align: 'center', arc: { mode: 'none', bend: 40 },
  };
  const texts = [...artworkTextLayers(next), layer];
  return { draft: { ...next, mode: next.mode === 'legacyFlattened' ? 'pixelLayers' as const : next.mode,
    text: texts[0], extraTexts: texts.slice(1), layerOrder: [...next.layerOrder!, id] }, selectedId: id };
}

export function duplicateArtworkLayers(draft: ArtworkDraft, ids: string[]) {
  let next = editableArtworkDraft(draft);
  const selectedIds: string[] = [];
  for (const layer of artworkLayers(next).filter(layer => ids.includes(layer.id))) {
    const id = availableLayerId(next, layer.kind === 'graphic' ? 'graphic-copy' : 'text-copy');
    const value = { ...structuredClone(layer.value), id, label: `${layer.value.label || (layer.kind === 'graphic' ? '图形' : '文字')} 副本`,
      x: Math.min(2048, layer.value.x + 32), y: Math.min(2048, layer.value.y + 32) };
    if (layer.kind === 'graphic') next = { ...next, extraGraphics: [...(next.extraGraphics ?? []), value as ArtworkGraphicLayer] };
    else { const texts = [...artworkTextLayers(next), value as ArtworkTextLayer]; next = { ...next, text: texts[0], extraTexts: texts.slice(1) }; }
    next = { ...next, mode: next.mode === 'legacyFlattened' ? 'pixelLayers' : next.mode, layerOrder: [...next.layerOrder!, id] };
    selectedIds.push(id);
  }
  return { draft: next, selectedIds };
}

export function removeArtworkLayers(draft: ArtworkDraft, ids: string[]) {
  const next = editableArtworkDraft(draft);
  const graphics = artworkGraphicLayers(next).filter(layer => !ids.includes(layer.id!));
  if (!graphics.length) throw new Error('最后一个原图图层需要保留；可以隐藏它，仅显示新增文字。');
  const texts = artworkTextLayers(next).filter(layer => !ids.includes(layer.id!));
  return { ...next, graphic: graphics[0], extraGraphics: graphics.slice(1), text: texts[0] ?? null, extraTexts: texts.slice(1),
    layerOrder: next.layerOrder!.filter(id => !ids.includes(id)) };
}

export function reorderArtworkLayer(draft: ArtworkDraft, id: string, direction: -1 | 1): ArtworkDraft {
  const order = artworkLayers(draft).map(layer => layer.id), index = order.indexOf(id), next = index + direction;
  if (index < 0 || next < 0 || next >= order.length) return draft;
  [order[index], order[next]] = [order[next], order[index]];
  return { ...draft, layerOrder: order };
}

export type PixelRaster = { width: number; height: number; data: Uint8ClampedArray };
export type PixelPiece = PixelRaster & { bounds: ArtworkBounds };

/** Match the pixels that splitting would take, not the layer's transparent rectangle. */
export function artworkRasterIntersectsSelection(source: PixelRaster, bounds: ArtworkBounds, selection: ArtworkSelection, rotation = 0): boolean {
  if (bounds.width <= 0 || bounds.height <= 0 || selection.width <= 0 || selection.height <= 0) return false;
  const angle = rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const centerX = bounds.left + bounds.width / 2, centerY = bounds.top + bounds.height / 2;
  const corners = [
    [selection.left, selection.top], [selection.left + selection.width, selection.top],
    [selection.left, selection.top + selection.height], [selection.left + selection.width, selection.top + selection.height],
  ].map(([x, y]) => ({
    x: (((x - centerX) * cos + (y - centerY) * sin) / bounds.width + .5) * source.width,
    y: ((-(x - centerX) * sin + (y - centerY) * cos) / bounds.height + .5) * source.height,
  }));
  const left = Math.max(0, Math.floor(Math.min(...corners.map(p => p.x)))), right = Math.min(source.width, Math.ceil(Math.max(...corners.map(p => p.x))));
  const top = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y)))), bottom = Math.min(source.height, Math.ceil(Math.max(...corners.map(p => p.y))));
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    if (source.data[(y * source.width + x) * 4 + 3] <= 8) continue;
    const dx = ((x + .5) / source.width - .5) * bounds.width, dy = ((y + .5) / source.height - .5) * bounds.height;
    const px = centerX + dx * cos - dy * sin, py = centerY + dx * sin + dy * cos;
    if (selectionContainsPoint(selection, px, py)) return true;
  }
  return false;
}

/** Transparent padding keeps browser interpolation from clamping to a cropped visible edge. */
export function padArtworkPiece(piece: PixelPiece, source: Pick<PixelRaster, 'width' | 'height'>): PixelPiece {
  const left = Math.max(0, piece.bounds.left - 2), top = Math.max(0, piece.bounds.top - 2);
  const width = Math.min(source.width, piece.bounds.left + piece.width + 2) - left;
  const height = Math.min(source.height, piece.bounds.top + piece.height + 2) - top;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < piece.height; y++) data.set(piece.data.subarray(y * piece.width * 4, (y + 1) * piece.width * 4), ((y + piece.bounds.top - top) * width + piece.bounds.left - left) * 4);
  return { width, height, data, bounds: { left, top, width, height } };
}

function croppedPixels(data: Uint8ClampedArray, width: number, height: number): PixelPiece | null {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!data[(y * width + x) * 4 + 3]) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left) return null;
  const w = right - left + 1, h = bottom - top + 1, result = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) result.set(data.subarray(((y + top) * width + left) * 4, ((y + top) * width + left + w) * 4), y * w * 4);
  return { width: w, height: h, data: result, bounds: { left, top, width: w, height: h } };
}

/** Rectangle or polygon is in artwork coordinates; source pixels keep their native grid and alpha. */
export function splitArtworkPixels(source: PixelRaster, graphic: ArtworkGraphicLayer, selection: ArtworkSelection) {
  if (source.data.length !== source.width * source.height * 4) throw new Error('图层像素尺寸不匹配');
  if (![selection.left, selection.top, selection.width, selection.height].every(Number.isFinite) || selection.width <= 0 || selection.height <= 0) throw new Error('请先框选图层内容');
  if (selection.points && !artworkPolygonSelection(selection.points)) throw new Error('请至少选择三个不在同一直线上的点');
  const extracted = new Uint8ClampedArray(source.data.length), remaining = new Uint8ClampedArray(source.data);
  const angle = graphic.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const offset = (y * source.width + x) * 4;
    if (!source.data[offset + 3]) continue;
    const localX = ((x + .5) / source.width - .5) * graphic.width, localY = ((y + .5) / source.height - .5) * graphic.height;
    const canvasX = graphic.x + localX * cos - localY * sin, canvasY = graphic.y + localX * sin + localY * cos;
    if (!selectionContainsPoint(selection, canvasX, canvasY)) continue;
    extracted.set(source.data.subarray(offset, offset + 4), offset);
    remaining.fill(0, offset, offset + 4);
  }
  const selected = croppedPixels(extracted, source.width, source.height);
  if (!selected) throw new Error('选区内没有当前图层的可见内容，请重新框选');
  return { selected, remaining: croppedPixels(remaining, source.width, source.height) };
}

export function croppedGraphicGeometry(graphic: ArtworkGraphicLayer, source: Pick<PixelRaster, 'width' | 'height'>, bounds: ArtworkBounds) {
  const dx = ((bounds.left + bounds.width / 2) / source.width - .5) * graphic.width;
  const dy = ((bounds.top + bounds.height / 2) / source.height - .5) * graphic.height;
  const angle = graphic.rotation * Math.PI / 180;
  return { x: graphic.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: graphic.y + dx * Math.sin(angle) + dy * Math.cos(angle), width: graphic.width * bounds.width / source.width, height: graphic.height * bounds.height / source.height };
}

export function wholeGraphicGeometry(graphic: ArtworkGraphicLayer, source: Pick<PixelRaster, 'width' | 'height'>): ArtworkGraphicLayer {
  const frame = graphic.sourceBounds;
  if (!frame) return graphic;
  if (frame.left + frame.width > source.width || frame.top + frame.height > source.height) throw new Error('图层可见范围超出原始图片');
  const dx = (source.width / 2 - frame.left - frame.width / 2) * graphic.width / frame.width;
  const dy = (source.height / 2 - frame.top - frame.height / 2) * graphic.height / frame.height;
  const angle = graphic.rotation * Math.PI / 180;
  return { ...graphic, sourceBounds: undefined, x: graphic.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: graphic.y + dx * Math.sin(angle) + dy * Math.cos(angle), width: graphic.width * source.width / frame.width, height: graphic.height * source.height / frame.height };
}

export function recolorArtworkPixels(source: Uint8ClampedArray, color: string, mask?: Uint8ClampedArray) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('请选择有效颜色');
  const result = new Uint8ClampedArray(source), rgb = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16));
  for (let offset = 0; offset < result.length; offset += 4) {
    if (!result[offset + 3] || (mask && mask[offset + 3] <= 8)) continue;
    result[offset] = rgb[0]; result[offset + 1] = rgb[1]; result[offset + 2] = rgb[2];
  }
  return result;
}

export type ArtworkHistory = { past: ArtworkDraft[]; present: ArtworkDraft; future: ArtworkDraft[] };
export function recordArtworkHistory(history: ArtworkHistory, next: ArtworkDraft): ArtworkHistory {
  if (JSON.stringify(history.present) === JSON.stringify(next)) return history;
  return { past: [...history.past.slice(-39), history.present], present: next, future: [] };
}
export function travelArtworkHistory(history: ArtworkHistory, direction: 'undo' | 'redo'): ArtworkHistory {
  if (direction === 'undo') return history.past.length ? { past: history.past.slice(0, -1), present: history.past.at(-1)!, future: [history.present, ...history.future] } : history;
  return history.future.length ? { past: [...history.past, history.present], present: history.future[0], future: history.future.slice(1) } : history;
}
