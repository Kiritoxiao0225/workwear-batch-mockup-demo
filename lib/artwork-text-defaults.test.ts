import { describe, expect, it } from 'vitest';
import { contrastingArtworkTextColor, DEFAULT_ARTWORK_FONT } from './artwork-text-defaults';
import { addArtworkText } from './artwork-layers';
import { createLegacyArtworkDraft } from './artwork-editor';
import { requestedProductionTextColor } from './client/production-text-artwork';

describe('production text defaults', () => {
  it.each([[0, 0, 0, '#ffffff'], [255, 255, 255, '#000000'], [200, 200, 205, '#000000'], [0, 255, 255, '#ff0000'], [255, 0, 0, '#ffffff']])('chooses maximum color distance for %s,%s,%s', (r, g, b, expected) => {
    expect(contrastingArtworkTextColor([Number(r), Number(g), Number(b)])).toBe(expected);
  });
  it('adds the supplied font and color without changing existing layers', () => {
    const original = createLegacyArtworkDraft('/test.png');
    const { draft } = addArtworkText(original, { x: 512, y: 512 }, '#ff0000');
    expect(draft.text).toMatchObject({ fontFamily: DEFAULT_ARTWORK_FONT, color: '#ff0000', fontWeight: 700 });
    expect(original.text).toBeNull();
  });
  it.each(['在黑色衣服左胸制作文字“红色保洁”。', '左胸文字“红色保洁”，未指定字体和颜色。'])('does not confuse garment or printed words with ink color: %s', instruction => {
    expect(requestedProductionTextColor({ instruction, exactText: '红色保洁', layoutNote: '' })).toBeNull();
  });
  it.each([['文字改为白色', '#ffffff'], ['字色：黑', '#000000'], ['红色文字', '#ff0000'], ['文字颜色 #12ab34', '#12ab34']])('preserves explicit ink %s', (layoutNote, color) => {
    expect(requestedProductionTextColor({ instruction: '灰色衣服左胸文字“酒店保洁”', exactText: '酒店保洁', layoutNote })).toBe(color);
  });
});
