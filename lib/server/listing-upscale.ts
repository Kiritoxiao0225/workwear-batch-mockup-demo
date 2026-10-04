/**
 * Main images and the poster go out at the platforms' sizes: MediaKit's standard enhance doubles
 * the 1K image, then it is scaled to the exact size. If MediaKit fails the 1K image is scaled
 * directly, so the image is still delivered at the right size. SKU and product images keep 1K.
 */
import sharp from 'sharp';

export const LISTING_SIZES = { square: [1440, 1440], portrait: [1440, 1920], poster: [1440, 2160] } as const;
export type ListingSizeKind = keyof typeof LISTING_SIZES;
type Enhance = (bytes: Buffer) => Promise<Buffer>;

const MEDIA_KIT = 'https://mediakit.cn-beijing.volces.com/api/v1/tools-sync/';

async function mediaKit(path: string, body: object, key: string) {
  const r = await fetch(MEDIA_KIT + path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const json = await r.json().catch(() => null) as { success?: boolean; code?: unknown; result?: Record<string, unknown> } | null;
  if (!r.ok || json?.success !== true || !json.result) throw new Error(`MediaKit ${path} HTTP ${r.status} code=${json?.code ?? 'unknown'}`);
  return json.result;
}

/** MediaKit standard enhance, 2x. */
export async function mediaKitEnhance(bytes: Buffer): Promise<Buffer> {
  const key = process.env.MEDIAKIT_API_KEY?.trim();
  if (!key) throw new Error('MEDIAKIT_API_KEY is not configured');
  const ticket = await mediaKit('request-media-upload-url', {}, key);
  const headers = Object.fromEntries(((ticket.upload_headers ?? []) as { key?: string; name?: string; value: string }[]).map(h => [h.key ?? h.name ?? '', h.value]));
  const put = await fetch(String(ticket.upload_url), { method: 'PUT', headers: { ...headers, 'Content-Type': 'image/png' }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(60_000) });
  if (!put.ok) throw new Error(`MediaKit upload HTTP ${put.status}`);
  const result = await mediaKit('enhance-image', { image_url: ticket.file_id, tool_version: 'standard', multiple: 2 }, key);
  const download = await fetch(String(result.image_url), { signal: AbortSignal.timeout(60_000) });
  if (!download.ok) throw new Error(`MediaKit download HTTP ${download.status}`);
  return Buffer.from(await download.arrayBuffer());
}

/** The image at its platform size as JPEG; `enhanced` is false when MediaKit was skipped. */
export async function upscaleListingImage(bytes: Buffer, kind: ListingSizeKind, enhance: Enhance = mediaKitEnhance) {
  const [width, height] = LISTING_SIZES[kind];
  let source = bytes, enhanced = true;
  try { source = await enhance(bytes); } catch (error) {
    enhanced = false;
    console.error('[listing] upscale', error instanceof Error ? error.message : error);
  }
  // A 3:4 image from the generator is 880×1184, slightly taller than 3:4: centre-crop the ~1 % extra.
  const out = await sharp(source).resize(width, height, { fit: 'cover', position: 'centre', kernel: 'lanczos3' }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  return { bytes: out, enhanced };
}
