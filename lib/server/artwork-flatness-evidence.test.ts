import { expect, it } from 'vitest';
import sharp from 'sharp';
import { artworkFlatnessEvidence } from './artwork-flatness-evidence';

const render = (fill: string) => sharp(Buffer.from(`<svg width="420" height="300"><defs><linearGradient id="g"><stop stop-color="#702010"/><stop offset="1" stop-color="#ee9060"/></linearGradient></defs><rect x="30" y="30" width="360" height="240" rx="20" fill="${fill}"/></svg>`)).png().toBuffer();
it('allows antialiasing without treating it as an interior gradient', async () => {
  const result = await artworkFlatnessEvidence(await render('#cd1828'));
  expect(result.status).toBe('within-tolerance'); expect(result.samples).toBeGreaterThan(300);
});
it('does not declare a real continuous gradient flat', async () => {
  expect((await artworkFlatnessEvidence(await render('url(#g)'))).status).toBe('inconclusive');
});
it('keeps blue and green inks separate instead of inventing a gradient between regions', async () => {
  const bytes = await sharp(Buffer.from('<svg width="420" height="300"><rect x="20" y="20" width="180" height="260" fill="#01773d"/><rect x="220" y="20" width="180" height="260" fill="#0091d8"/></svg>')).png().toBuffer();
  const result = await artworkFlatnessEvidence(bytes);
  expect(result.status).toBe('within-tolerance'); expect(result.groups).toHaveLength(2);
});
it('does not make a foreground claim for an opaque canvas or insufficient tiny details', async () => {
  const opaque = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#cd1828' } }).png().toBuffer();
  expect((await artworkFlatnessEvidence(opaque)).status).toBe('inconclusive');
  expect((await artworkFlatnessEvidence(await sharp(await render('#cd1828')).resize(12, 12).png().toBuffer())).status).toBe('inconclusive');
});
