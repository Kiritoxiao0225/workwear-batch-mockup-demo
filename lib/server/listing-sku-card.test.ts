import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { colorRow } from '../listing/sku-card';
import { renderSkuCard, SKU_CARD_SIZE } from './listing-sku-card';

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
