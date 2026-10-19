import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { colorRow } from '../listing/sku-card';
import { renderSkuCard, runs, SKU_CARD_SIZE } from './listing-sku-card';

const solid = (w: number, h: number, background: string) => sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();

describe('renderSkuCard', () => {
  it('puts a colour together from a photo, or from a cut-out garment without a card', async () => {
    const photo = { bytes: await solid(900, 1200, '#3a5a7a'), cutout: false };
    const made = await renderSkuCard({ title: ['高端定制', '支持印绣'], rows: [colorRow('北欧蓝')], fabric: await solid(300, 300, '#283040'), photo,
      feature: { title: '防水透气', sub: '穿着舒适', icons: [{ icon: 'water', label: '防水' }] } });
    expect(await sharp(made).metadata()).toMatchObject({ format: 'jpeg', width: SKU_CARD_SIZE, height: SKU_CARD_SIZE });
    // The photo panel on the right carries the photo's colour.
    const { data } = await sharp(made).extract({ left: 800, top: 600, width: 4, height: 4 }).raw().toBuffer({ resolveWithObject: true });
    expect(Math.abs(data[2] - 0x7a)).toBeLessThan(12);

    const garment = await sharp({ create: { width: 400, height: 500, channels: 4, background: { r: 200, g: 60, b: 20, alpha: 1 } } }).png().toBuffer();
    const cut = await renderSkuCard({ title: ['高端定制'], rows: [], feature: null, fabric: await solid(10, 10, '#000'), photo: { bytes: garment, cutout: true } });
    expect((await sharp(cut).metadata()).width).toBe(SKU_CARD_SIZE);
  });
});

describe('the unit marks the fonts lack (10-19)', () => {
  // The cards' fonts have no ₂ ⁺ ² ㎡: the server (no fallback fonts) printed nothing for them, so they are drawn as small figures.
  it('splits the marks off as small figures below or above the line', () => {
    expect(runs('MMH₂O')).toEqual([{ t: 'MMH', at: 'line' }, { t: '2', at: 'below' }, { t: 'O', at: 'line' }]);
    expect(runs('4000⁺ G/㎡')).toEqual([{ t: '4000', at: 'line' }, { t: '+', at: 'above' }, { t: ' G/m', at: 'line' }, { t: '2', at: 'above' }]);
  });
  it('draws a card with them and with an icon word too long for one line', async () => {
    const made = await renderSkuCard({ title: ['高端定制'], rows: [colorRow('黑色')], fabric: await solid(300, 300, '#eeeeee'), photo: { bytes: await solid(900, 1200, '#3a5a7a'), cutout: false },
      feature: { title: 'IP4.0防水层', sub: '防水指数40000⁺ MMH₂O', icons: [{ icon: 'breathe', label: '可呼吸冲锋衣透气面料' }, { icon: 'wind', label: '防风' }] } });
    expect((await sharp(made).metadata()).width).toBe(SKU_CARD_SIZE);
  });
});
