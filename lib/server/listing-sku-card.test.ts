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

describe('SKU 图角标 (10-26)', () => {
  const dark = async (image: Buffer, left: number, top: number) => {
    const { data } = await sharp(image).extract({ left, top, width: 2, height: 2 }).raw().toBuffer({ resolveWithObject: true });
    return data[0] < 60 && data[1] < 60 && data[2] < 60;
  };
  const card = async (badge: { text: string; place: 'corner' | 'right' } | null, logo: Buffer | null) => renderSkuCard({ title: ['高端定制'], rows: [colorRow('黑色')], fabric: await solid(300, 300, '#eeeeee'),
    photo: { bytes: await solid(900, 1200, '#d8d8d8'), cutout: false }, feature: null, logo, badge });
  it('puts the badge in the top-left corner in place of the LOGO, or at the top right of the picture', async () => {
    const logo = await solid(260, 110, '#c02020');
    const withLogo = await card(null, logo), corner = await card({ text: '男女同款', place: 'corner' }, logo), right = await card({ text: '男女同款', place: 'right' }, logo);
    // The LOGO's red at the top left; the corner badge's dark pill there instead, and no red anywhere it was.
    const { data } = await sharp(withLogo).extract({ left: 100, top: 100, width: 2, height: 2 }).raw().toBuffer({ resolveWithObject: true });
    expect(data[0] > 150 && data[1] < 80).toBe(true);
    expect(await dark(corner, 66, 70 + 33)).toBe(true);
    const { data: under } = await sharp(corner).extract({ left: 200, top: 150, width: 2, height: 2 }).raw().toBuffer({ resolveWithObject: true });
    expect(under[0] - under[1]).toBeLessThan(30);
    // On the right: the pill's right end over the picture, the LOGO left where it was.
    expect(await dark(right, SKU_CARD_SIZE - 36 - 24 - 14, 36 + 24 + 33)).toBe(true);
    expect(await dark(withLogo, SKU_CARD_SIZE - 36 - 24 - 14, 36 + 24 + 33)).toBe(false);
  });
});

describe('一体款的里面小框 (10-29)', () => {
  // No LOGO, a one-line title: the box sits under it at the left, 190 × 150 from (60, 196).
  const card = async (liner: { photo: Buffer | null; close?: boolean }) => renderSkuCard({ title: ['高端定制'], rows: [colorRow('黑色')], fabric: await solid(300, 300, '#eeeeee'),
    photo: { bytes: await solid(900, 1200, '#d8d8d8'), cutout: false }, feature: null, liner });
  const at = async (image: Buffer) => [...(await sharp(image).extract({ left: 150, top: 270, width: 2, height: 2 }).raw().toBuffer({ resolveWithObject: true })).data.slice(0, 3)];
  it('fills the box with the inside close-up, with no name across it', async () => {
    const [r, g, b] = await at(await card({ photo: await solid(600, 600, '#c03018'), close: true }));
    expect(r > 150 && g < 90 && b < 70).toBe(true);
    // Where a liner's name strip would darken it, still the photo.
    const made = await card({ photo: await solid(600, 600, '#c03018'), close: true });
    const { data } = await sharp(made).extract({ left: 150, top: 196 + 150 - 20, width: 2, height: 2 }).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(150);
  });
  it('leaves the box empty and plain grey without a photo, to be filled in by hand', async () => {
    const [r, g, b] = await at(await card({ photo: null }));
    expect([r, g, b].every(x => Math.abs(x - 0xdc) < 6)).toBe(true);
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
