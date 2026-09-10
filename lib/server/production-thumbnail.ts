import sharp from 'sharp';
import { readCatalogFile } from './catalog-files';
const cache = new Map<string, Buffer>();
const pending = new Map<string, Promise<Buffer>>();
let total = 0;
export const PRODUCTION_THUMBNAIL_VERSION = 'thumb-320-v1';
/** Rebuildable, bounded cache; originals and source fingerprints are untouched. */
export async function productionThumbnail(id: string, sha: string) {
  const key = `${PRODUCTION_THUMBNAIL_VERSION}:${sha}`;
  const saved = cache.get(key);
  if (saved) { cache.delete(key); cache.set(key, saved); return saved; }
  const existing = pending.get(key);
  if (existing) return existing;
  const work = (async () => {
    const { bytes } = await readCatalogFile(id);
    const thumbnail = await sharp(bytes, { limitInputPixels: 80_000_000 }).rotate().resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    while (cache.size && (cache.size >= 256 || total + thumbnail.length > 32 * 1024 * 1024)) {
      const oldest = cache.keys().next().value!; total -= cache.get(oldest)!.length; cache.delete(oldest);
    }
    cache.set(key, thumbnail); total += thumbnail.length;
    return thumbnail;
  })().finally(() => pending.delete(key));
  pending.set(key, work); return work;
}
