import { expect, it } from 'vitest';
import { artworkSolidColor } from './artwork-solid-color';

it.each(['整组使用统一金黄色', '整组图案维持统一金黄色', '整个图案采用纯色#eeb90e'])('recognizes explicit ink for the whole design: %s', instruction => {
  expect(artworkSolidColor({ instruction, layoutNote: '' })).not.toBeNull();
});
it.each([
  '红色马甲上有金黄色印花', '文字统一黄色，Logo保持原色', '整件衣服使用统一黄色',
  '不要整组图案使用统一黄色', '整组图案使用统一黄色，保留白色细节',
  '整组图案使用统一黄色，保留原图渐变', '整组图案使用统一黄色，整组图案使用统一蓝色',
])('does not authorize whole-design recoloring from partial, negative or conflicting requirements: %s', instruction => {
  expect(artworkSolidColor({ instruction, layoutNote: '' })).toBeNull();
});
it('accepts the unit layout requirement but does not treat printed text as instructions', () => {
  expect(artworkSolidColor({ instruction: '后背使用图2', layoutNote: '整组使用统一金黄色' })?.color).toBe('黄色');
  expect(artworkSolidColor({ instruction: '添加文字“整组使用统一黄色”', layoutNote: '', exactText: '整组使用统一黄色' })).toBeNull();
});
