import { describe, expect, it } from 'vitest';
import { spreadArtworkInk } from './artwork-ink-spread';
import { artworkGraphicBounds, artworkGraphicFrame, assertArtworkDraft, createLegacyArtworkDraft } from './artwork-editor';
import { duplicateArtworkLayers, editableArtworkDraft, recordArtworkHistory, travelArtworkHistory, updateArtworkLayer } from './artwork-layers';
import { artworkPixelFingerprint } from './artwork-save-fingerprint';

const raster = (w: number, h: number, ink: (x: number, y: number) => boolean) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink(x, y)) data.set([181, 27, 48, 255], (y * w + x) * 4);
  return data;
};
describe('image layer ink spread', () => {
  it('expands only ink, preserves solid pixels, color, open counters and transparent background', () => {
    const source = raster(15, 15, (x, y) => x >= 3 && x <= 11 && y >= 3 && y <= 11 && (x === 3 || x === 11 || y === 3 || y === 11));
    const original = new Uint8ClampedArray(source), result = spreadArtworkInk(source, 15, 15, 1);
    expect(source).toEqual(original);
    expect(result[(7 * 15 + 2) * 4 + 3]).toBe(255);
    expect(result[(7 * 15 + 7) * 4 + 3]).toBe(0);
    expect(result[3]).toBe(0);
    for (let at = 0; at < source.length; at += 4) {
      if (source[at + 3]) expect(result.slice(at, at + 4)).toEqual(source.slice(at, at + 4));
      if (result[at + 3]) expect([...result.slice(at, at + 3)]).toEqual([181, 27, 48]);
    }
  });
  it('has monotonic fractional strength, a pixel-exact reset and no noise on empty inputs', () => {
    const source = raster(9, 9, (x, y) => x === 4 && y === 4);
    const light = spreadArtworkInk(source, 9, 9, .3), strong = spreadArtworkInk(source, 9, 9, .8);
    expect(light[(4 * 9 + 3) * 4 + 3]).toBeGreaterThan(0);
    expect(strong[(4 * 9 + 3) * 4 + 3]).toBeGreaterThan(light[(4 * 9 + 3) * 4 + 3]);
    expect(spreadArtworkInk(source, 9, 9, 0)).toEqual(source);
    expect(spreadArtworkInk(new Uint8ClampedArray(100), 5, 5, 3)).toEqual(new Uint8ClampedArray(100));
  });
  it('keeps expansion inside the rotated frame without changing source geometry', () => {
    const graphic = { ...createLegacyArtworkDraft('/a.png').graphic, width: 100, height: 20, x: 0, y: 0, rotation: 90, inkSpread: 2 };
    expect(artworkGraphicFrame(graphic)).toEqual({ left: -52, top: -12, width: 104, height: 24 });
    expect(artworkGraphicBounds(graphic).width).toBeCloseTo(24);
    expect(artworkGraphicBounds(graphic).height).toBeCloseTo(104);
    expect(graphic.width).toBe(100);
  });
  it('persists per layer, invalidates saved pixels, supports undo/redo and rejects unsafe strengths', () => {
    const original = editableArtworkDraft(createLegacyArtworkDraft('/a.png'));
    const pair = duplicateArtworkLayers(original, [original.graphic.id!]).draft;
    const id = pair.extraGraphics![0].id!;
    const changed = updateArtworkLayer(pair, id, { inkSpread: .7 });
    const restored = editableArtworkDraft(JSON.parse(JSON.stringify(changed)));
    assertArtworkDraft(restored);
    expect(restored.graphic).toEqual(pair.graphic);
    expect(restored.extraGraphics![0].inkSpread).toBe(.7);
    expect(artworkPixelFingerprint(changed)).not.toBe(artworkPixelFingerprint(pair));
    const history = recordArtworkHistory({ past: [], present: pair, future: [] }, changed);
    expect(travelArtworkHistory(history, 'undo').present).toEqual(pair);
    expect(travelArtworkHistory(travelArtworkHistory(history, 'undo'), 'redo').present).toEqual(changed);
    for (const inkSpread of [-1, 3.1, NaN, Infinity, '1']) expect(() => assertArtworkDraft({ ...original, graphic: { ...original.graphic, inkSpread } })).toThrow('inkSpread');
    expect(() => assertArtworkDraft(original)).not.toThrow();
  });
});
