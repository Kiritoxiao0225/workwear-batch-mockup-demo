/**
 * Is a colour's own still life on white? A clean front still life is the white-background product image
 * as it is (draft.ts directKeys, from what the analysis read), padded to a white square. A still life in
 * a scene was used that way too (10-18: 7718's M219 on a branch in a desert, M257 on a grey plinth), so
 * the picture itself is checked: the band around its edge must be white or transparent.
 */
import sharp from 'sharp';

/** The share of the edge band that must be white: the scenes scored 0.00–0.08, the real white ones 0.94 and up (45 still lifes, 10-19). */
export const ON_WHITE = 0.85;

/** The share of the outer 4% band (on a 256 px copy) that is near white or transparent. */
export async function whiteBorder(bytes: Buffer) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 80_000_000 }).rotate().resize(256, 256, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info, band = Math.max(3, Math.round(Math.min(w, h) * 0.04));
  let n = 0, white = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= band && x < w - band && y >= band && y < h - band) continue;
    const i = (y * w + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    n++;
    if (data[i + 3] < 32 || (Math.min(r, g, b) >= 232 && Math.max(r, g, b) - Math.min(r, g, b) <= 14)) white++;
  }
  return white / n;
}

/**
 * The still lifes that could be a colour's white image as they are (clean, front, no LOGO), marked
 * `plain`: whether the picture is really on white. Done once when the material is sorted, so the plan
 * page's price, the hold and the images all see the same answer. Other images are left unmarked.
 */
export async function markPlain<T extends { id: string; kind: string; front: boolean; logo: boolean; plain?: boolean }>(images: T[], sources: { id: string; bytes: Buffer }[]): Promise<T[]> {
  const bytes = new Map(sources.map(s => [s.id, s.bytes]));
  return Promise.all(images.map(async i => {
    const b = (i.kind === '静物' || i.kind === '3D渲染') && i.front && !i.logo ? bytes.get(i.id) : undefined;
    return b ? { ...i, plain: (await whiteBorder(b).catch(() => 1)) >= ON_WHITE } : i;
  }));
}
