import { describe, expect, it } from 'vitest';
import { printedTextHeights } from './production-legibility';
import { arcGlyphTransforms } from './artwork-editor';
describe('printed text readability reminders', () => {
  it('uses glyph height within the visible artwork, independent of transparent padding or screen zoom', () => {
    const result = printedTextHeights([{ char: '手', height: 120 }, { char: '机', height: 130 }, { char: 'p', height: 110 }], 1307, 7);
    expect(result[0].heightCm).toBeCloseTo(.64269);
    expect(result[0].small).toBe(true);
    expect(result[1].heightCm).toBeCloseTo(.58914);
    expect(result[1].small).toBe(true);
  });
  it('recalculates after resizing and reports missing editable text without inventing a measurement', () => {
    expect(printedTextHeights([{ char: '字', height: 160 }], 1000, 7)[0].small).toBe(false);
    expect(printedTextHeights([], 1000, 7)).toEqual([]);
    expect(() => printedTextHeights([{ char: '字', height: NaN }], 1000, 7)).toThrow('无效');
  });
  it('uses measured font advances and never squashes long text to its alignment box', () => {
    const glyphs = arcGlyphTransforms('W中', 80, 2, 20, 'none', 0, [75, 80]);
    expect(glyphs.map(glyph => glyph.advance)).toEqual([77, 82]);
    expect(glyphs.map(glyph => glyph.horizontalScale)).toEqual([1, 1]);
    expect(() => arcGlyphTransforms('W中', 80, 2, 20, 'none', 0, [75])).toThrow('无效');
  });
});
