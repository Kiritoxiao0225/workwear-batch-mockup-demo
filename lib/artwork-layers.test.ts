import { describe, expect, it, vi } from 'vitest';
import { createLegacyArtworkDraft, assertArtworkDraft, type ArtworkGraphicLayer } from './artwork-editor';
import { artworkRasterIntersectsSelection, artworkPointInLayer, artworkPolygonSelection, artworkLayers, croppedGraphicGeometry, editableArtworkDraft, recordArtworkHistory, reorderArtworkLayer, travelArtworkHistory, splitArtworkPixels, recolorArtworkPixels, wholeGraphicGeometry, type PixelPiece } from './artwork-layers';
import { persistArtworkLayerAssets } from './client/artwork-layer-editing';
import { addArtworkText, duplicateArtworkLayers, removeArtworkLayers, updateArtworkLayer } from './artwork-layers';

const graphic: ArtworkGraphicLayer = { sourceUrl: '/uploads/logos/source.png', x: 200, y: 250, width: 80, height: 60, rotation: 0, recolor: { mode: 'original', color: null } };
function raster() {
  const data = new Uint8ClampedArray(8 * 6 * 4);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
    const offset = (y * 8 + x) * 4;
    if (x === 0 || (x === 4 && y === 1)) continue;
    data.set([y < 3 ? 210 : 40, 40, x * 10, x === 1 ? 45 : 255], offset);
  }
  return { width: 8, height: 6, data };
}
function restore(piece: PixelPiece | null, target: Uint8ClampedArray, width: number) {
  if (!piece) return;
  for (let y = 0; y < piece.height; y++) for (let x = 0; x < piece.width; x++) {
    const from = (y * piece.width + x) * 4, to = ((y + piece.bounds.top) * width + x + piece.bounds.left) * 4;
    if (piece.data[from + 3]) target.set(piece.data.subarray(from, from + 4), to);
  }
}

describe('direct picking coordinates', () => {
  const bounds = { left: 100, top: 200, width: 80, height: 40 };
  it('maps points to source pixels and rejects transparent-padding candidates outside the bounds', () => {
    expect(artworkPointInLayer({ x: 120, y: 210 }, bounds)).toEqual({ x: .25, y: .25 });
    expect(artworkPointInLayer({ x: 99, y: 210 }, bounds)).toBeNull();
    expect(artworkPointInLayer({ x: 180, y: 210 }, bounds)).toBeNull();
    expect(artworkPointInLayer({ x: 120, y: 240 }, bounds)).toBeNull();
    expect(artworkPointInLayer({ x: 120, y: 210 }, { ...bounds, width: 0 })).toBeNull();
  });
  it.each([90, -30, 180])('undoes a %s degree rotation before sampling alpha', rotation => {
    const angle = rotation * Math.PI / 180, dx = -20, dy = -10;
    const point = { x: 140 + dx * Math.cos(angle) - dy * Math.sin(angle), y: 220 + dx * Math.sin(angle) + dy * Math.cos(angle) };
    const local = artworkPointInLayer(point, bounds, rotation)!;
    expect(local.x).toBeCloseTo(.25); expect(local.y).toBeCloseTo(.25);
  });
  it('picks the same source pixel at different display scales', () => {
    for (const scale of [.5, 1, 2.5]) {
      const local = artworkPointInLayer({ x: 120 * scale, y: 210 * scale }, { left: 100 * scale, top: 200 * scale, width: 80 * scale, height: 40 * scale });
      expect(local).toEqual({ x: .25, y: .25 });
    }
  });
});

describe('marquee chooses the content inside the rectangle', () => {
  const source = raster();
  const bounds = { left: 160, top: 220, width: 80, height: 60 };
  it('selects the second separate layer even when the first layer was selected previously', () => {
    const layers = [{ id: 'first', bounds }, { id: 'second', bounds: { ...bounds, left: 280 } }];
    const rectangle = { left: 275, top: 210, width: 90, height: 90 };
    expect(layers.filter(layer => artworkRasterIntersectsSelection(source, layer.bounds, rectangle)).map(layer => layer.id)).toEqual(['second']);
  });
  it('does not select transparent padding, a hole or an empty rectangle', () => {
    expect(artworkRasterIntersectsSelection(source, bounds, { left: 160, top: 220, width: 10, height: 60 })).toBe(false);
    expect(artworkRasterIntersectsSelection(source, bounds, { left: 200, top: 230, width: 10, height: 10 })).toBe(false);
    expect(artworkRasterIntersectsSelection(source, bounds, { left: 600, top: 600, width: 60, height: 60 })).toBe(false);
    expect(artworkRasterIntersectsSelection(source, bounds, { left: 175, top: 225, width: 0, height: 60 })).toBe(false);
  });
  it.each([0, 45, 90, -30])('matches visible source pixels after rotation %s', rotation => {
    const angle = rotation * Math.PI / 180;
    const selectionAround = (x: number, y: number) => ({ left: graphic.x + x * Math.cos(angle) - y * Math.sin(angle) - 1, top: graphic.y + x * Math.sin(angle) + y * Math.cos(angle) - 1, width: 2, height: 2 });
    expect(artworkRasterIntersectsSelection(source, bounds, selectionAround(-25, -15), rotation)).toBe(true);
    expect(artworkRasterIntersectsSelection(source, bounds, selectionAround(5, -15), rotation)).toBe(false);
  });
  it('includes every touched layer and stays consistent across zoom levels', () => {
    const second = { ...bounds, left: 280 };
    for (const scale of [.5, 1, 3]) {
      const scaled = (box: typeof bounds) => ({ left: box.left * scale, top: box.top * scale, width: box.width * scale, height: box.height * scale });
      const selection = scaled({ left: 155, top: 215, width: 210, height: 80 });
      expect([bounds, second].map(box => artworkRasterIntersectsSelection(source, scaled(box), selection))).toEqual([true, true]);
    }
  });
});

describe('pixel selections preserve source artwork', () => {
  it.each([0, 45, 90, -30])('cuts the active source at rotation %s without losing or duplicating a pixel', rotation => {
    const source = raster(), before = new Uint8ClampedArray(source.data);
    const parts = splitArtworkPixels(source, { ...graphic, rotation }, { left: 160, top: 220, width: 80, height: 30 });
    const merged = new Uint8ClampedArray(source.data.length);
    restore(parts.remaining, merged, source.width); restore(parts.selected, merged, source.width);
    expect(merged).toEqual(source.data); expect(source.data).toEqual(before);
    for (let i = 3; i < source.data.length; i += 4) {
      const a = new Uint8ClampedArray(source.data.length), b = new Uint8ClampedArray(source.data.length);
      restore(parts.remaining, a, source.width); restore(parts.selected, b, source.width);
      expect(Boolean(a[i]) && Boolean(b[i])).toBe(false);
    }
  });
  it('selects only the upper red region, preserving the lower lettering and transparent holes', () => {
    const source = raster(), { selected, remaining } = splitArtworkPixels(source, graphic, { left: 160, top: 220, width: 80, height: 30 });
    expect(selected.bounds).toEqual({ left: 1, top: 0, width: 7, height: 3 });
    expect(remaining?.bounds).toEqual({ left: 1, top: 3, width: 7, height: 3 });
    const colored = recolorArtworkPixels(selected.data, '#008800');
    for (let i = 0; i < colored.length; i += 4) {
      expect(colored[i + 3]).toBe(selected.data[i + 3]);
      if (colored[i + 3]) expect([...colored.slice(i, i + 3)]).toEqual([0, 136, 0]);
    }
    expect(remaining!.data[0]).toBe(40);
    expect(selected.data[3]).toBe(45);
  });
  it('keeps the same canvas coordinates after native pixel cropping and rotation', () => {
    const rotated = { ...graphic, rotation: 90 };
    const g = croppedGraphicGeometry(rotated, raster(), { left: 1, top: 0, width: 7, height: 3 });
    expect(g).toEqual({ x: 215, y: 255, width: 70, height: 30 });
    const restored = wholeGraphicGeometry({ ...rotated, ...g, sourceBounds: { left: 1, top: 0, width: 7, height: 3 } }, raster());
    expect(restored.x).toBeCloseTo(rotated.x); expect(restored.y).toBeCloseTo(rotated.y);
    expect(restored.width).toBeCloseTo(rotated.width); expect(restored.height).toBeCloseTo(rotated.height);
  });
  it('rejects a transparent selection and allows selecting the whole layer', () => {
    expect(() => splitArtworkPixels(raster(), graphic, { left: 0, top: 0, width: 10, height: 10 })).toThrow('没有当前图层');
    const result = splitArtworkPixels(raster(), graphic, { left: 0, top: 0, width: 1024, height: 1024 });
    expect(result.remaining).toBeNull();
  });
  it('never fills transparent pixels or increases edge opacity even when a subject mask is larger', () => {
    const source = new Uint8ClampedArray([99, 22, 33, 0, 199, 18, 18, 30]);
    const mask = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
    expect([...recolorArtworkPixels(source, '#0000ff', mask)]).toEqual([99, 22, 33, 0, 0, 0, 255, 30]);
  });
});

describe('polygon selections isolate irregular artwork', () => {
  // A concave selection excludes the upper-right notch even though it is inside the bounding box.
  const vertices = [[1, 0], [4, 0], [4, 3], [7, 3], [7, 6], [1, 6]];
  const polygon = (rotation = 0, scale = 1, reverse = false) => {
    const angle = rotation * Math.PI / 180;
    const points = vertices.map(([x, y]) => {
      const dx = (x - 4) * 10, dy = (y - 3) * 10;
      return { x: (graphic.x + dx * Math.cos(angle) - dy * Math.sin(angle)) * scale, y: (graphic.y + dx * Math.sin(angle) + dy * Math.cos(angle)) * scale };
    });
    return artworkPolygonSelection(reverse ? points.reverse() : points)!;
  };

  it.each([0, 45, 90, -30])('keeps exactly the selected native pixels at rotation %s, with no loss or overlap', rotation => {
    const source = raster(), before = new Uint8ClampedArray(source.data);
    for (const scale of [.5, 1, 3]) for (const reverse of [false, true]) {
      const layer = { ...graphic, rotation, x: graphic.x * scale, y: graphic.y * scale, width: graphic.width * scale, height: graphic.height * scale };
      const selection = polygon(rotation, scale, reverse);
      const parts = splitArtworkPixels(source, layer, selection);
      const taken = new Uint8ClampedArray(source.data.length), kept = new Uint8ClampedArray(source.data.length);
      restore(parts.selected, taken, source.width); restore(parts.remaining, kept, source.width);
      for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
        const offset = (y * source.width + x) * 4, selected = x >= 1 && x < 7 && (x < 4 || y >= 3);
        expect(taken.slice(offset, offset + 4)).toEqual(selected ? source.data.slice(offset, offset + 4) : new Uint8ClampedArray(4));
        expect(kept.slice(offset, offset + 4)).toEqual(selected ? new Uint8ClampedArray(4) : source.data.slice(offset, offset + 4));
      }
      expect(artworkRasterIntersectsSelection(source, { left: layer.x - layer.width / 2, top: layer.y - layer.height / 2, width: layer.width, height: layer.height }, selection, rotation)).toBe(true);
    }
    expect(source.data).toEqual(before);
  });

  it('does not select a separate layer lying only in the polygon bounding box', () => {
    const selection = polygon(), source = raster();
    const notch = { left: 203, top: 222, width: 20, height: 20 };
    expect(artworkRasterIntersectsSelection(source, notch, selection)).toBe(false);
    const { left, top, width, height } = selection, rectangle = { left, top, width, height };
    expect(artworkRasterIntersectsSelection(source, notch, rectangle)).toBe(true);
  });

  it('recolors the remaining outline while the extracted interior and all alpha values stay unchanged', () => {
    const source = raster(), parts = splitArtworkPixels(source, graphic, polygon());
    const interiorBefore = new Uint8ClampedArray(parts.selected.data);
    const colored = { ...parts.remaining!, data: recolorArtworkPixels(parts.remaining!.data, '#008800') };
    const result = new Uint8ClampedArray(source.data.length), selected = new Uint8ClampedArray(source.data.length);
    restore(parts.selected, selected, source.width); restore(parts.selected, result, source.width); restore(colored, result, source.width);
    for (let i = 0; i < result.length; i += 4) {
      expect(result[i + 3]).toBe(source.data[i + 3]);
      if (selected[i + 3]) expect(result.slice(i, i + 4)).toEqual(source.data.slice(i, i + 4));
      else if (source.data[i + 3]) expect([...result.slice(i, i + 3)]).toEqual([0, 136, 0]);
    }
    expect(parts.selected.data).toEqual(interiorBefore);
  });

  it('recolors only the lasso interior, leaving adjacent pixels inside its rectangular bounds untouched', () => {
    const source = raster(), parts = splitArtworkPixels(source, graphic, polygon());
    const result = new Uint8ClampedArray(source.data.length);
    restore(parts.remaining, result, source.width);
    restore({ ...parts.selected, data: recolorArtworkPixels(parts.selected.data, '#ff0000') }, result, source.width);
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      const offset = (y * source.width + x) * 4;
      const inside = x >= 1 && x < 7 && (x < 4 || y >= 3);
      expect(result[offset + 3]).toBe(source.data[offset + 3]);
      if (!inside) expect(result.slice(offset, offset + 4)).toEqual(source.data.slice(offset, offset + 4));
      else if (source.data[offset + 3]) expect([...result.slice(offset, offset + 3)]).toEqual([255, 0, 0]);
    }
  });

  it('rejects incomplete, non-finite, collinear and transparent selections', () => {
    expect(artworkPolygonSelection([])).toBeNull();
    expect(artworkPolygonSelection([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull();
    expect(artworkPolygonSelection([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toBeNull();
    expect(artworkPolygonSelection([{ x: 0, y: 0 }, { x: Infinity, y: 0 }, { x: 0, y: 2 }])).toBeNull();
    const empty = artworkPolygonSelection([{ x: 160, y: 220 }, { x: 169, y: 220 }, { x: 169, y: 240 }])!;
    expect(() => splitArtworkPixels(raster(), graphic, empty)).toThrow('没有当前图层');
    expect(() => splitArtworkPixels(raster(), graphic, { ...polygon(), points: [] })).toThrow('至少选择三个');
  });
});

describe('editable project state', () => {
  it('adds separately authored text to an old image without replacing its source pixels', () => {
    const original = createLegacyArtworkDraft('/uploads/logos/old.png');
    const first = addArtworkText(original, { x: 512, y: 720 });
    const second = addArtworkText(first.draft, { x: 512, y: 850 });
    const edited = updateArtworkLayer(second.draft, first.selectedId, { value: '宜宾学院\n志愿者', lineHeight: 1.8 });
    const reopened = JSON.parse(JSON.stringify(edited));
    expect(() => assertArtworkDraft(reopened)).not.toThrow();
    expect(reopened.mode).toBe('pixelLayers');
    expect(reopened.graphic.sourceUrl).toBe(original.graphic.sourceUrl);
    expect(reopened.text.value).toBe('宜宾学院\n志愿者');
    expect(reopened.text.lineHeight).toBe(1.8);
    expect(reopened.extraTexts[0].value).toBe('新文字');
    expect(first.selectedId).not.toBe(second.selectedId);
    expect(original.text).toBeNull();
    expect(original.mode).toBe('legacyFlattened');
  });
  it('copies source metadata and styles independently, then removes selected layers without losing the survivors', () => {
    const original = addArtworkText(createLegacyArtworkDraft('/uploads/logos/old.png'), { x: 500, y: 800 }).draft;
    original.graphic.sourceBounds = { left: 2, top: 3, width: 200, height: 100 };
    original.graphic.recolorMaskUrl = '/uploads/logos/mask.png';
    original.text!.arc.mode = 'up';
    const copied = duplicateArtworkLayers(original, original.layerOrder!);
    copied.draft.extraTexts![0].arc.mode = 'down';
    expect(original.text!.arc.mode).toBe('up');
    expect(copied.draft.extraGraphics![0].sourceBounds).toEqual(original.graphic.sourceBounds);
    expect(copied.draft.extraGraphics![0].recolorMaskUrl).toBe(original.graphic.recolorMaskUrl);
    const remaining = removeArtworkLayers(copied.draft, original.layerOrder!);
    expect(remaining.layerOrder).toEqual(copied.selectedIds);
    expect(remaining.graphic.id).toBe(copied.selectedIds[0]);
    expect(remaining.text!.arc.mode).toBe('down');
    expect(() => assertArtworkDraft(remaining)).not.toThrow();
    expect(() => removeArtworkLayers(remaining, [remaining.graphic.id!])).toThrow('最后一个原图图层');
    expect(removeArtworkLayers(remaining, [remaining.text!.id!]).text).toBeNull();
  });
  it('rejects additions beyond the persisted layer limit without mutating the draft', () => {
    let draft = editableArtworkDraft(createLegacyArtworkDraft('/uploads/logos/old.png'));
    for (let index = 0; index < 63; index++) draft = addArtworkText(draft, { x: 512, y: 512 }).draft;
    expect(() => assertArtworkDraft(draft)).not.toThrow();
    expect(() => addArtworkText(draft, { x: 512, y: 512 })).toThrow('64');
    expect(() => duplicateArtworkLayers(draft, [draft.graphic.id!])).toThrow('64');
    expect(artworkLayers(draft)).toHaveLength(64);
  });
  it('keeps old drafts readable and persists a validated order of independent pixel layers', () => {
    const old = createLegacyArtworkDraft('/uploads/logos/old.png'), draft = editableArtworkDraft(old);
    expect(old.layerOrder).toBeUndefined();
    expect(() => assertArtworkDraft(draft)).not.toThrow();
    draft.mode = 'pixelLayers'; draft.extraGraphics = [{ ...draft.graphic, id: 'extracted', visible: false }];
    draft.layerOrder!.push('extracted');
    const next = reorderArtworkLayer(draft, 'extracted', -1);
    const reopened = JSON.parse(JSON.stringify(next));
    expect(() => assertArtworkDraft(reopened)).not.toThrow();
    expect(artworkLayers(reopened).map(layer => layer.id)).toEqual(['extracted', draft.graphic.id]);
    expect(artworkLayers(reopened)[0].value.visible).toBe(false);
    expect(() => assertArtworkDraft({ ...draft, layerOrder: ['extracted', 'extracted'] })).toThrow('顺序');
  });
  it('undoes a split and redoes it, clearing redo after a new edit', () => {
    const original = editableArtworkDraft(createLegacyArtworkDraft('/uploads/logos/old.png'));
    const changed = { ...original, graphic: { ...original.graphic, x: 300 } };
    const history = recordArtworkHistory({ past: [], present: original, future: [] }, changed);
    const undone = travelArtworkHistory(history, 'undo');
    expect(undone.present).toEqual(original);
    expect(travelArtworkHistory(undone, 'redo').present).toEqual(changed);
    expect(recordArtworkHistory(undone, { ...changed, graphic: { ...changed.graphic, x: 400 } }).future).toEqual([]);
  });
  it('uploads transient sources once, including hidden layers, before saving a reopenable project', async () => {
    const draft = editableArtworkDraft(createLegacyArtworkDraft('data:image/png;base64,AQ=='));
    draft.mode = 'pixelLayers'; draft.graphic.recolorMaskUrl = draft.graphic.sourceUrl;
    draft.extraGraphics = [{ ...draft.graphic, id: 'hidden', sourceUrl: 'data:image/png;base64,Ag==', visible: false }]; draft.layerOrder!.push('hidden');
    const upload = vi.fn(async (file: File) => ({ url: `/uploads/logos/${(new Uint8Array(await file.arrayBuffer()))[0]}.png`, originalName: file.name }));
    const saved = await persistArtworkLayerAssets(draft, upload);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(saved.graphic.sourceUrl).toBe('/uploads/logos/1.png');
    expect(saved.graphic.recolorMaskUrl).toBe(saved.graphic.sourceUrl);
    expect(saved.extraGraphics![0].sourceUrl).toBe('/uploads/logos/2.png');
    expect(draft.graphic.sourceUrl).toMatch(/^data:/);
    expect(() => assertArtworkDraft(JSON.parse(JSON.stringify(saved)))).not.toThrow();
  });
  it('fails a save if a source upload fails, leaving the original draft reusable', async () => {
    const draft = editableArtworkDraft(createLegacyArtworkDraft('data:image/png;base64,AQ=='));
    await expect(persistArtworkLayerAssets(draft, async () => { throw new Error('upload failed'); })).rejects.toThrow('upload failed');
    expect(draft.graphic.sourceUrl).toMatch(/^data:/);
  });
});
