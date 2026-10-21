/**
 * 电商主图: the shop's own LOGO pasted into the top-left corner its main images were drawn with
 * (lib/listing/corner.ts). The stored image stays clean; the LOGO goes on as the image is shown
 * (/api/listing/assets) and downloaded (the zip), so turning it off or changing it needs no image made
 * again. An image drew the corner when its attempt's receipt says `corner` (listing-generation).
 */
import sharp, { type OverlayOptions } from 'sharp';
import { LOGO_BOX } from '../listing/corner';
import { removeFlatArtworkBackground } from './artwork-image-processing';
import { catalogDatabase } from './catalog-database';
import { CatalogHttpError } from './catalog-auth';

/**
 * An uploaded shop LOGO as it is kept: trimmed to it, transparent around it. A LOGO on white (a JPEG,
 * a white PNG) has the white taken off; one on a coloured block keeps the block, since it is the LOGO.
 */
export async function brandImage(bytes: Buffer) {
  try {
    const image = sharp(bytes, { failOn: 'error', limitInputPixels: 60_000_000 }).rotate();
    const data = await image.clone().ensureAlpha().raw().toBuffer();
    let opaque = true;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 250) { opaque = false; break; }
    const png = await image.png().toBuffer(), [r, g, b] = [data[0], data[1], data[2]];
    const white = Math.min(r, g, b) > 232 && Math.max(r, g, b) - Math.min(r, g, b) < 14;
    const clear = opaque && white ? await removeFlatArtworkBackground(png, { r, g, b }) : png;
    const out = await sharp(clear).trim({ threshold: 1 }).resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    if (out.info.width < 8 || out.info.height < 8) throw new Error('empty');
    return out.data;
  } catch { throw new CatalogHttpError(400, '这张 LOGO 读不出来，换一张 PNG 或 JPG 试试'); }
}

/**
 * The image with the LOGO in its corner, at the same size and format. Its own colours on a light,
 * plain corner; white on a dark one; dark grey on a coloured or mid-tone one; and a soft plate under
 * it when the corner came out busy (a real scene behind it). Tested on M1–M5 (10-18). A LOGO that is a
 * solid block keeps its own colours and needs no plate.
 */
export async function pasteShopLogo(image: Buffer, logo: Buffer) {
  const meta = await sharp(image).metadata(), W = meta.width!, H = meta.height!;
  const left = Math.round(W * LOGO_BOX.left), top = Math.round(W * LOGO_BOX.top);
  const { data: px, info: li } = await sharp(logo).resize(Math.round(W * LOGO_BOX.width), Math.round(W * LOGO_BOX.height), { fit: 'inside', kernel: 'lanczos3' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // What is under the LOGO, a little wider: how bright, how colourful and how busy.
  const pad = Math.round(W * 0.012), x = Math.max(0, left - pad), y = Math.max(0, top - pad);
  const w = Math.min(W - x, li.width + 2 * pad), h = Math.min(H - y, li.height + 2 * pad);
  const { data: bg } = await sharp(image).extract({ left: x, top: y, width: w, height: h }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0, sq = 0, chroma = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const r = bg[i * 3], g = bg[i * 3 + 1], b = bg[i * 3 + 2], l = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += l; sq += l * l; chroma += Math.max(r, g, b) - Math.min(r, g, b);
  }
  let clear = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 128) clear++;
  const block = clear < px.length / 4 * 0.05;
  const light = sum / n, busy = !block && Math.sqrt(Math.max(0, sq / n - light * light)) > 34;
  const tone = block ? null : light < 120 ? 255 : light < 175 || chroma / n > 45 ? 30 : null;
  if (tone !== null) for (let i = 0; i < px.length; i += 4) { px[i] = tone; px[i + 1] = tone; px[i + 2] = tone; }
  const layers: OverlayOptions[] = [];
  if (busy) {
    const pw = li.width + 2 * pad, ph = li.height + 2 * pad, fill = tone === 255 ? 'rgba(0,0,0,0.38)' : 'rgba(255,255,255,0.72)';
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}"><rect width="${pw}" height="${ph}" rx="${Math.round(pad * 0.9)}" fill="${fill}"/></svg>`), left: left - pad, top: top - pad });
  }
  layers.push({ input: await sharp(px, { raw: { width: li.width, height: li.height, channels: 4 } }).png().toBuffer(), left, top });
  const out = sharp(image).composite(layers);
  return meta.format === 'png' ? out.png().toBuffer() : out.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Which of the tenant's images were drawn with the corner kept. */
export async function cornerAssets(tenant: string, ids: string[]) {
  const asked = ids.filter(id => UUID.test(id));
  if (!asked.length) return new Set<string>();
  // Only 1:1 and 3:4 main images can have kept it, so the attempts (not indexed by job) are looked at for those alone.
  const rows = (await catalogDatabase().query(`SELECT a.id FROM listing_assets a WHERE a.id=ANY($1::uuid[]) AND a.tenant_id=$2 AND a.slot ~ '^(square|portrait):'
    AND EXISTS (SELECT 1 FROM listing_attempts t WHERE t.job_id=a.job_id AND t.status='succeeded' AND t.receipt->>'corner'='true')`, [asked, tenant])).rows as { id: string }[];
  return new Set(rows.map(r => r.id));
}
