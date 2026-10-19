import { describe, expect, it } from 'vitest';
import { bigWords, bigWordsLine, cleanWords, conciseTag, fitHeight, shortName, tagFits } from './point-words';

describe('a point\'s words on images (10-19)', () => {
  it('puts right the typos the suppliers\' copy carries and takes off a field name in front', () => {
    expect(cleanWords('轻试雨水自动滑落，易清洁、易搭理')).toEqual({ text: '轻拭雨水自动滑落，易清洁、易打理', fixed: ['轻试→轻拭', '易搭理→易打理'] });
    expect(cleanWords('放冷风侵入，收口便捷').text).toBe('防冷风侵入，收口便捷');
    expect(cleanWords('面料:100%聚酯纤维')).toEqual({ text: '100%聚酯纤维', fixed: [] });
    expect(cleanWords('面料：')).toEqual({ text: '面料：', fixed: [] });
    // A note keeps its words in front; only the text is a field's value.
    expect(cleanWords('面料:透气', false).text).toBe('面料:透气');
  });
  it('makes a tag of the words that fit, the most telling part first, never a cut word', () => {
    expect(conciseTag('德国SUPER-TEX', 12)).toBe('德国SUPER-TEX');
    expect(conciseTag('高防水透气膜 德国SUPER-TEX 全天候防护', 12)).toBe('德国SUPER-TEX');
    expect(conciseTag('持久防大雨，不怕雨水渗透衣内', 12)).toBe('不怕雨水渗透衣内');
    expect(conciseTag('一二三四五六七八九十一二三四', 12)).toBeNull();
  });
  it('counts a fact by its two parts and plain words as a whole', () => {
    expect(tagFits('面料科技｜德国SUPER-TEX', 12)).toBe(true);
    expect(tagFits('一二三四五六七八九十一二三', 12)).toBe(false);
    expect(tagFits('面料科技｜一二三四五六七八九十一二三', 12)).toBe(false);
    expect(tagFits('甲｜乙｜丙', 12)).toBe(false);
  });
  it('sets long words smaller to fit their box, short ones at the design\'s size', () => {
    expect(fitHeight('高防水', 44, 7)).toBe(7);
    expect(fitHeight('德国SUPER-TEX', 44, 7)).toBeLessThan(7);
    expect(fitHeight('德国SUPER-TEX', 44, 7) * 6.95).toBeLessThanOrEqual(44);
    expect(fitHeight('一二三四五六七八九十一二三四五六七八九十', 10, 3)).toBe(1.6);
  });
  it('sets big words that would shrink a lot on two lines at about the design\'s size, when there is room', () => {
    expect(bigWords('高防水透气膜', 44, 7)).toEqual({ size: 7, lines: 1 });
    // A little smaller stays on one line.
    expect(bigWords('德国SUPER-TEX', 44, 7).lines).toBe(1);
    // The user liked 「石墨烯远红外蓄热纤维」 on two lines at 7 % better than one line at 4 % (10-19).
    expect(bigWords('石墨烯远红外蓄热纤维', 44, 7)).toEqual({ size: 7, lines: 2 });
    expect(bigWords('石墨烯远红外蓄热纤维', 44, 7, 10)).toEqual({ size: fitHeight('石墨烯远红外蓄热纤维', 44, 7), lines: 1 });
    expect(bigWordsLine({ size: 7, lines: 2 })).toContain('分两行写，在词与词之间断开');
    expect(bigWordsLine({ size: 7, lines: 1 })).toContain('一行写完、不换行');
  });
  it('takes a short name only when it is the point\'s own words, in order, at most six wide', () => {
    expect(shortName('透气面料', '可呼吸冲锋衣透气面料')).toBe('透气面料');
    expect(shortName('可拆内胆', '可拆卸摇粒内胆')).toBe('可拆内胆');
    expect(shortName('IP4.0防水', 'IP4.0防水层透气膜')).toBe('IP4.0防水');
    // Words not in the point, out of order or too wide are not one.
    expect(shortName('透气好料', '可呼吸冲锋衣透气面料')).toBe('');
    expect(shortName('面料透气', '可呼吸冲锋衣透气面料')).toBe('');
    expect(shortName('日常穿搭户外旅游', '从日常穿搭到户外旅游')).toBe('');
    // A point narrow enough is its own short name.
    expect(shortName('', '魔术贴袖口')).toBe('魔术贴袖口');
  });
});
