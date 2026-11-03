import { describe, expect, it } from 'vitest';
import { linerBoxRequest, linerMatchRequest, parseInsideBox, parseLinerBox, parseLinerLook, parseLinerMatch } from './listing-recognize';

describe('the front panel inside an 一体 jacket (11-01)', () => {
  it('reads the box as fractions, kept inside the photo', () => {
    expect(parseInsideBox('{"found":true,"box":[20,25,15,60]}')).toEqual([0.2, 0.25, 0.15, 0.6]);
    expect(parseInsideBox('{"found":true,"box":[90,10,30,95]}')).toEqual([0.9, 0.1, 0.1, 0.9]);
  });
  it('gives none when not found, too small, or not JSON: the whole photo is sent', () => {
    expect(parseInsideBox('{"found":false}')).toBeNull();
    expect(parseInsideBox('{"found":true,"box":[10,10,3,50]}')).toBeNull();
    expect(parseInsideBox('{"found":true,"box":[10,10,30,10]}')).toBeNull();
    expect(parseInsideBox('not json')).toBeNull();
  });
});

describe('a liner on its photo, for the SKU cards\' thumbnail (11-04)', () => {
  it('its box as fractions; not on the photo, or too small to show it, none', () => {
    expect(parseLinerBox('{"found":true,"box":[30,20,40,60],"what":"红色软壳内胆"}')).toEqual([0.3, 0.2, 0.4, 0.6]);
    expect(parseLinerBox('{"found":false,"what":"只拍到外壳"}')).toBeNull();
    expect(parseLinerBox('{"found":true,"box":[10,10,5,50]}')).toBeNull();
    expect(parseLinerBox('nope')).toBeNull();
  });
  it('asks for the liner by name and colour, the shell and the rack not counting', () => {
    const r = linerBoxRequest({ image: Buffer.from('x'), inner: '软壳', color: '红色', model: 'm' });
    expect(JSON.stringify(r)).toContain('软壳内胆，颜色「红色」');
    expect(r.messages[0].content).toContain('外面那件外壳、别的衣服、衣架、货架、背景都不算');
  });
});

describe('the liner on a SKU model over it, read off and checked against its photo on white (11-04)', () => {
  it('its surface in a few words; nothing read, no words', () => {
    expect(parseLinerLook('{"look":"横向绗缝，每格约4厘米，鼓起明显，微亮面。"}')).toBe('横向绗缝，每格约4厘米，鼓起明显，微亮面');
    expect(parseLinerLook('oops')).toBe('');
  });
  it('the check: smooth where the photo is quilted is wrong; unreadable, no verdict', () => {
    expect(parseLinerMatch('{"same":false,"why":"图1内胆光滑没有绗缝"}')).toEqual({ same: false, why: '图1内胆光滑没有绗缝' });
    expect(parseLinerMatch('{"same":true}')).toEqual({ same: true, why: '' });
    expect(parseLinerMatch('{"ok":1}')).toBeNull();
    const r = linerMatchRequest({ drawn: Buffer.from('a'), liner: Buffer.from('b'), name: '羽绒', model: 'm' });
    expect(r.messages[0].content).toContain('图2有明显绗缝而图1露出的内胆是光滑平整的一片，算不对');
  });
});

