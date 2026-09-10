import { describe, expect, it } from 'vitest';
import { artworkTextGlyphLayout, createStructuredArtworkDraft, type ArtworkTextLayer } from './artwork-editor';
import { artworkPrintInstruction, artworkPrintPlacementSchema, fitArtworkForPrint } from './production-artwork-layout';
import type { ProductionPlacement } from './wps-production';

const placement: ProductionPlacement = { key: 'leftChest', sizeMode: 'standard', widthCm: 10, offsetX: 0, offsetY: 0, rotation: 0, templateVersion: 'catalog-v1' };
function draft(text = 'poppy手机数码') {
  return createStructuredArtworkDraft({ graphicSourceUrl: '/logo.png', graphicWidth: 300, graphicHeight: 500, exactText: text, instruction: 'logo做绿色', layoutNote: '图上字下', enhancement: 'none', backgroundRemoval: 'general' });
}
function measure(text: ArtworkTextLayer) {
  const letters = [...text.value].map(char => ({ char, height: text.fontSize * (/\p{Script=Han}/u.test(char) ? .9 : .55) }));
  const width = [...text.value].reduce((width, char) => width + text.fontSize * (/\p{Script=Han}/u.test(char) ? 1 : .58) + text.letterSpacing, 0);
  const height = Math.max(...letters.map(letter => letter.height));
  return { letters, bounds: { left: text.x - width / 2, top: text.y - height / 2, width, height } };
}
describe('first-draft physical text layout', () => {
  it('keeps the dentist lettering curved and above its graphic through print fitting and serialization', () => {
    const initial = createStructuredArtworkDraft({ graphicSourceUrl: '/tooth.png', graphicWidth: 480, graphicHeight: 440,
      exactText: '小景是牙医', instruction: '左胸制作圆弧形文字“小景是牙医”，文字下面组合WPS图1',
      layoutNote: '文字“小景是牙医”排成圆弧形，置于牙齿图形上方', enhancement: 'none', backgroundRemoval: 'general' });
    // Include the deformed glyph bounds so a straight-line estimate cannot hide overlaps.
    const curvedMeasure = (text: ArtworkTextLayer) => {
      const base = measure(text), glyphs = artworkTextGlyphLayout(text);
      const top = Math.min(...glyphs.map(g => text.y + g.y - text.fontSize));
      const bottom = Math.max(...glyphs.map(g => text.y + g.y + text.fontSize));
      return { ...base, bounds: { ...base.bounds, top, height: bottom - top } };
    };
    const first = fitArtworkForPrint(initial, placement, curvedMeasure);
    expect(first.needsReview).toBe(false);
    const second = fitArtworkForPrint(JSON.parse(JSON.stringify(first.draft)), first.placement, curvedMeasure);
    for (const d of [initial, first.draft, second.draft]) {
      expect(d.layout.preset).toBe('verticalReverse');
      expect(d.text!.arc).toEqual({ mode: 'up', bend: 65 });
      expect(d.text!.value).toBe('小景是牙医');
      expect(d.graphic.sourceUrl).toBe('/tooth.png');
      const textBounds = curvedMeasure(d.text!).bounds;
      expect(textBounds.top + textBounds.height).toBeLessThan(d.graphic.y - d.graphic.height / 2);
      const glyphs = artworkTextGlyphLayout(d.text!);
      expect(glyphs[2].y).toBeLessThan(glyphs[0].y);
    }
  });

  it('automatically arranges the real mixed-language chest logo and persists a suitable size without rewriting words or colors', () => {
    const initial = draft();
    const before = structuredClone(initial);
    const result = fitArtworkForPrint(initial, placement, measure);
    expect(result.needsReview).toBe(false);
    expect(result.automaticWidthCm).toBeGreaterThan(7);
    expect(result.automaticWidthCm).toBeLessThanOrEqual(9);
    expect(result.draft.text!.value).toBe(before.text!.value);
    expect(result.draft.text!.color).toBe(before.text!.color);
    expect(result.draft.graphic.sourceUrl).toBe(before.graphic.sourceUrl);
    expect(result.draft.graphic.width / result.draft.graphic.height).toBeCloseTo(.6);
    expect(initial).toEqual(before);
    expect(result.summary).toContain('字高约');
  });
  it('does not enlarge the lettering again when processing an already fitted draft', () => {
    const first = fitArtworkForPrint(draft(), placement, measure);
    const second = fitArtworkForPrint(first.draft, first.placement, measure);
    expect(second.needsReview).toBe(false);
    expect(second.draft.text!.fontSize).toBeCloseTo(first.draft.text!.fontSize);
    expect(second.draft.graphic.width).toBeCloseTo(first.draft.graphic.width);
    expect(second.placement.widthCm).toBe(first.placement.widthCm);
  });
  it('preserves explicit customer dimensions and reports a real conflict rather than squeezing long text', () => {
    const fixed = { ...placement, sizeMode: 'widthCm' as const, widthCm: 4 };
    const result = fitArtworkForPrint(draft(), fixed, measure);
    expect(result.needsReview).toBe(true);
    expect(result.automaticWidthCm).toBeUndefined();
    expect(result.placement).toEqual(fixed);
    expect(result.draft.text!.value).toBe('poppy手机数码');
  });
  it('uses the back print size and does not turn all artwork into chest-sized logos', () => {
    const result = fitArtworkForPrint(draft(), { ...placement, key: 'back' }, measure);
    expect(result.needsReview).toBe(false);
    expect(result.automaticWidthCm).toBeGreaterThan(9);
  });
  it('does not label flattened logos or unmeasured special text as automatically checked', () => {
    const flattened = { ...draft(), mode: 'legacyFlattened' as const, text: null };
    expect(fitArtworkForPrint(flattened, placement, measure).needsReview).toBe(true);
  });
  it('puts physical constraints into model input and rejects invalid dimensions', () => {
    const context = artworkPrintPlacementSchema.parse({ key: 'leftChest', sizeMode: 'widthCm', widthCm: 6 });
    expect(artworkPrintInstruction(context)).toContain('本次已确定整组宽 6 cm');
    expect(artworkPrintInstruction(context)).toContain('中文实际字高优先 1 cm');
    expect(() => artworkPrintPlacementSchema.parse({ ...context, widthCm: -1 })).toThrow();
  });
});
