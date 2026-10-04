import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { planViews, type PlanSource } from './listing-plan-views';

const solid = (r: number, g: number, b: number, width = 400, height = 400) => sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toBuffer();
const source = async (id: string, folder: string, name: string, shape: PlanSource['shape'], rgb: [number, number, number], width = 400, height = 400): Promise<PlanSource> =>
  ({ id, folder, name, shape, width, height, bytes: await solid(...rgb, width, height) });

describe('planning views', () => {
  it('sends a small folder one image at a time and leaves out only exact look-alikes', async () => {
    const sources = [await source('M1', '主图', 'a.jpg', '1:1', [200, 100, 30]), await source('M2', '主图', 'b.jpg', '1:1', [200, 100, 30]),
      await source('M3', 'SKU', '黑.jpg', '1:1', [20, 20, 20]), await source('M4', 'SKU', '灰.jpg', '1:1', [40, 40, 40])];
    const { views, duplicates } = await planViews(sources);
    expect([...duplicates]).toEqual([['M2', 'M1']]);
    expect(views.map(v => v.ids)).toEqual([['M1'], ['M3'], ['M4']]);
  });

  it('packs a large folder: photos in grids, detail slices stitched, colour images single, every image once', async () => {
    const sources: PlanSource[] = [];
    for (let i = 0; i < 30; i++) sources.push(await source(`M${i + 1}`, '模特图', `IMG_${i + 1}.jpg`, i < 20 ? '1:1' : '3:4', [8 * i, 255 - 8 * i, 60], 400, i < 20 ? 400 : 533));
    for (let i = 0; i < 9; i++) sources.push(await source(`M${31 + i}`, '详情页', `详情_${i + 1}.jpg`, '其他', [250, 250 - 10 * i, 240], 790, 1100));
    for (let i = 0; i < 4; i++) sources.push(await source(`M${40 + i}`, 'SKU图', `色${i}.jpg`, '1:1', [60 * i, 30, 200]));
    const { views, duplicates } = await planViews(sources);
    expect(duplicates.size).toBe(0);
    const ids = views.flatMap(v => v.ids);
    expect(ids.sort()).toEqual(sources.map(s => s.id).sort());
    // 43 images fit under the 50-picture limit: photos stay single (384 px), slices are stitched, colour images single.
    expect(views.some(v => v.text.startsWith('【拼图'))).toBe(false);
    expect(views.filter(v => v.text.startsWith('【长图')).map(v => v.ids.length)).toEqual([2, 2, 2, 2]);
    expect(views.slice(0, 4).map(v => v.ids[0])).toEqual(['M40', 'M41', 'M42', 'M43']);
    expect(views.length).toBe(4 + 30 + 5);
  });

  it('packs photos into grids only as far as the 50-picture limit needs, and refuses what cannot fit', async () => {
    const photos: PlanSource[] = [];
    for (let i = 0; i < 120; i++) photos.push(await source(`M${i + 1}`, '模特图', `IMG_${i + 1}.jpg`, '1:1', [(i * 23) % 256, (i * 61) % 256, (i * 97) % 256]));
    const { views } = await planViews([...photos, await source('M200', 'SKU图', '黑色.jpg', '1:1', [10, 10, 10])]);
    expect(views.length).toBeLessThanOrEqual(48);
    expect(views[0].ids).toEqual(['M200']);
    expect(views.filter(v => v.text.startsWith('【拼图')).map(v => v.ids.length)).toEqual([...Array(30).fill(4)]);
    expect(views.find(v => v.text.startsWith('【拼图'))!.text).toContain('从左到右、从上到下依次是 M1（模特图/IMG_1.jpg）、M2');
    const colours: PlanSource[] = [];
    for (let i = 0; i < 50; i++) colours.push(await source(`C${i + 1}`, 'SKU', `色${i + 1}.jpg`, '1:1', [(i * 37) % 256, (i * 11) % 256, (i * 73) % 256]));
    await expect(planViews(colours)).rejects.toThrow('一次分析放不下');
  });
});

describe('look-alikes', () => {
  // A garment-shaped block on a white background, like a SKU shot; only the garment's colour changes.
  const sku = (rgb: [number, number, number]) => sharp({ create: { width: 600, height: 600, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 300, height: 420, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }, left: 150, top: 120 }]).png().toBuffer();
  const of = async (id: string, bytes: Buffer): Promise<PlanSource> => ({ id, folder: 'SKU', name: id + '.png', shape: '1:1', width: 600, height: 600, bytes });

  it('keeps close colours of the same shot apart and drops only pixel-identical copies', async () => {
    const black = await sku([28, 28, 30]);
    const cases = [
      await of('黑色', black), await of('深藏青', await sku([28, 32, 46])), await of('炭黑', await sku([36, 36, 38])),
      await of('白色', await sku([244, 244, 244])), await of('米白', await sku([244, 238, 226])), await of('浅灰', await sku([232, 232, 232])),
      await of('黑色重存', await sharp(black).jpeg({ quality: 92 }).toBuffer()),
      await of('黑色缩放副本', await sharp(black).resize(400).resize(600).png().toBuffer()),
    ];
    const { duplicates } = await planViews(cases);
    // A re-saved JPEG shifts the colour as much as charcoal does, so it is kept too; only the exact copy goes.
    expect([...duplicates]).toEqual([['黑色缩放副本', '黑色']]);
  });
});
