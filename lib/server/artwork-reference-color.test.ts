import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sampleArtworkReferenceColor, type ReferenceColorDetection } from './artwork-reference-color';

const detection: ReferenceColorDetection = { status: 'identified', scope: 'uniform-graphic', confidence: 'high', description: '胸前深蓝印花', region: { left: .3, top: .4, width: .2, height: .2 }, rgbHint: [30, 65, 95] };

describe('reference pixel sampling', () => {
  it('samples print ink inside the selected region, excluding black borders and light clothing', async () => {
    const source = await sharp(Buffer.from('<svg width="200" height="300"><rect width="200" height="300" fill="black"/><rect x="20" y="90" width="160" height="130" fill="#beddef"/><path fill="#234967" d="M62 124h34v8H62z M62 145h34v8H62z M62 168h34v8H62z"/></svg>')).png().toBuffer();
    const result = await sampleArtworkReferenceColor(source, detection);
    expect(result.hex).toBe('#234967');
    expect(result.sampledPixels).toBe(816);
    expect(result.region).toEqual({ left: 60, top: 120, width: 40, height: 60 });
  });
  it('uses fluorescent green image pixels without substituting the preset green', async () => {
    const source = await sharp(Buffer.from('<svg width="200" height="300"><rect width="200" height="300" fill="#050710"/><rect x="65" y="130" width="25" height="40" fill="#18ee09"/></svg>')).png().toBuffer();
    expect((await sampleArtworkReferenceColor(source, { ...detection, rgbHint: [20, 240, 10] })).hex).toBe('#18ee09');
  });
  it('stops when location is uncertain, pixels disagree or multiple target parts are requested', async () => {
    const source = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#000000' } }).png().toBuffer();
    await expect(sampleArtworkReferenceColor(source, { ...detection, status: 'ambiguous', confidence: 'low' })).rejects.toThrow('尚不能确定');
    await expect(sampleArtworkReferenceColor(source, detection)).rejects.toThrow('没有足够');
    await expect(sampleArtworkReferenceColor(source, { ...detection, scope: 'partial-or-multiple' })).rejects.toThrow('多个不同改色对象');
    await expect(sampleArtworkReferenceColor(source, { ...detection, region: { left: .9, top: .4, width: .5, height: .2 } })).rejects.toThrow('取色区域超出图片');
  });
});
