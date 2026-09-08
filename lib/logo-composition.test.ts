import { describe, expect, it } from 'vitest';

import {
  chooseRequestedBand,
  splitVerticalContentBands,
} from '@/lib/server/logo-composition';

describe('Logo graphic vertical region selection', () => {
  const occupiedRows = [
    true, true, false, false,
    true, true, true, false, false,
    true, true,
  ];

  it('splits separated top, middle and bottom content', () => {
    expect(splitVerticalContentBands(occupiedRows, 1)).toEqual([
      { top: 0, bottom: 1 },
      { top: 4, bottom: 6 },
      { top: 9, bottom: 10 },
    ]);
  });

  it('selects the middle region requested by the model analysis', () => {
    const bands = splitVerticalContentBands(occupiedRows, 1);
    expect(chooseRequestedBand(bands, '图片中间的菱形图形 Logo', 11)).toEqual({
      top: 4,
      bottom: 6,
    });
  });
});
