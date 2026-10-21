import { describe, expect, it } from 'vitest';
import { CORNER_LINE, cornerTemplate, cornerZones } from './corner';
import type { Template } from './templates';

describe('the corner kept for the shop\'s LOGO', () => {
  it('moves a layout with words up there down as a whole, and leaves the picture behind where it is', () => {
    const { zones, band } = cornerZones([
      '左0% 上0% 宽100% 高100%：人物：参考图2里的男生。',
      '左4% 上3% 宽16% 高4%：胶囊。',
      '左4% 上9% 宽60% 高8%：大标题「细节见品质」。',
      '左4% 上72% 宽29% 高27%：小格。',
      '画面里没有任何人。',
    ]);
    expect(zones).toEqual([
      CORNER_LINE,
      '左0% 上0% 宽100% 高100%：人物：参考图2里的男生。',
      '左4% 上16% 宽16% 高3%：胶囊。',
      '左4% 上21% 宽60% 高7%：大标题「细节见品质」。',
      '左4% 上76% 宽29% 高23%：小格。',
      '画面里没有任何人。',
    ]);
    expect(band).toBe(false);
  });

  it('leaves a layout alone when nothing is up there (a full person, words elsewhere), and only asks for the corner', () => {
    const cover = ['左0% 上0% 宽100% 高100%：人物。', '左76% 上58% 宽17% 高22%：竖排大标题。', '左89% 上3% 宽6% 高30%：色点。'];
    expect(cornerZones(cover)).toEqual({ zones: [CORNER_LINE, ...cover], band: false });
  });

  it('a grid that starts at the top edge moves down under a band the background is told about', () => {
    expect(cornerZones(['左0% 上0% 宽50% 高50%：左上格。', '左50% 上0% 宽50% 高50%：右上格。']).band).toBe(true);
  });

  it('a template moves its boxes the same way', () => {
    const t: Template = { people: 0, zones: [{ id: 'garment1', kind: 'garment', box: [0, 0, 100, 100] }, { id: 'title1', kind: 'title', box: [5, 4, 40, 8] }] };
    expect(cornerTemplate(t).template.zones.map(z => z.box)).toEqual([[0, 0, 100, 100], [5, 16, 40, 7]]);
    const clear: Template = { people: 0, zones: [{ id: 'title1', kind: 'title', box: [60, 4, 36, 8] }] };
    expect(cornerTemplate(clear).template).toBe(clear);
  });
});
