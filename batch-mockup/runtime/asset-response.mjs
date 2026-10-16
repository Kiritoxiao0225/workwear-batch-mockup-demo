import sharp from 'sharp';
import { extname } from 'node:path';
import { readBytes, atomicFile, assetDigest, assetPath } from '../adapters/a-files.mjs';

export const PREVIEW_EDGE = 1600;
export const previewPath = path => path + '.preview.webp';
const contentType = path => ({ '.png': 'image/png', '.webp': 'image/webp' })[extname(path)] ?? 'image/jpeg';
// A stored path never changes content (writeBytes refuses another version), so a week of private
// caching is safe; the ETag turns a revisit after that into a 304 instead of the whole picture.
const CACHE = 'private, max-age=604800';

// A history page asks for many previews at once; only two originals are decoded at a time.
let decoding = 0;
const waiting = [];
async function limited(work) {
  while (decoding >= 2) await new Promise(resolve => waiting.push(resolve));
  decoding++;
  try { return await work(); } finally { decoding--; waiting.shift()?.(); }
}

/**
 * A stored picture as a response: the original, or with `preview` a display copy at most
 * PREVIEW_EDGE px that is made on first view and kept next to it. Download and editing still
 * use the original; pages showing results only need the preview.
 */
export async function assetResponse(root, path, { preview = false, ifNoneMatch = null } = {}) {
  const original = assetPath(root, path);
  const digest = await assetDigest(original);
  if (!digest) return { status: 404 };
  const asPreview = preview && !path.endsWith('.preview.webp');
  const etag = `"${digest}${asPreview ? '-preview' : ''}"`;
  const headers = { 'Cache-Control': CACHE, ETag: etag, 'X-Content-Type-Options': 'nosniff' };
  if (ifNoneMatch === etag) return { status: 304, headers };
  if (!asPreview) return { status: 200, headers: { ...headers, 'Content-Type': contentType(path) }, bytes: await readBytes(original) };
  const kept = assetPath(root, previewPath(path));
  if (await assetDigest(kept)) return { status: 200, headers: { ...headers, 'Content-Type': 'image/webp' }, bytes: await readBytes(kept) };
  const bytes = await limited(async () => sharp(await readBytes(original), { limitInputPixels: 80_000_000 })
    .resize(PREVIEW_EDGE, PREVIEW_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, alphaQuality: 90 }).toBuffer());
  // Kept for the next view. If it cannot be saved (storage quota), this view still gets it.
  await atomicFile(kept, bytes).catch(error => console.error('[asset-preview] not kept', error?.name));
  return { status: 200, headers: { ...headers, 'Content-Type': 'image/webp' }, bytes };
}
