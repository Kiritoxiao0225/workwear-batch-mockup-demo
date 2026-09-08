import sharp from 'sharp';
import { z } from 'zod';
import { boxSchema, type Box } from '@/lib/catalog';
import { catalogDatabase } from './catalog-database';
import { fileSha256, readCatalogFile } from './catalog-files';

// Find the central torso run below the underarms; separated long sleeves do not
// contribute to this width. Opaque photos have no usable silhouette evidence.
export async function torsoWidthRatio(bytes: Buffer, crop: Box): Promise<number | null> {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.hasAlpha) return null;
  const { data: pixels, info } = await sharp(bytes).extract({ left: Math.round(crop.x * metadata.width!), top: Math.round(crop.y * metadata.height!), width: Math.round(crop.width * metadata.width!), height: Math.round(crop.height * metadata.height!) })
    .resize(512, 640, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const opaque = (x: number, y: number) => pixels[(y * info.width + x) * info.channels + info.channels - 1] >= 128;
  let top = info.height, bottom = -1, left = info.width, right = -1, count = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (opaque(x, y)) {
    top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x); count++;
  }
  if (count < info.width * info.height * .02 || count > info.width * info.height * .97 || bottom <= top) return null;
  // A rectangular photo on a transparent canvas is still a photo, not a torso.
  if (count / ((right - left + 1) * (bottom - top + 1)) > .94) return null;
  const center = Math.round((left + right) / 2);
  const widths: number[] = [];
  for (let y = Math.round(top + (bottom - top) * .6); y <= top + (bottom - top) * .8; y++) {
    if (!opaque(center, y)) continue;
    let x0 = center, x1 = center;
    while (x0 > 0 && opaque(x0 - 1, y)) x0--;
    while (x1 < info.width - 1 && opaque(x1 + 1, y)) x1++;
    widths.push(x1 - x0 + 1);
  }
  if (widths.length < 12) return null;
  widths.sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)];
  if (median < info.width * .15 || widths[Math.floor(widths.length * .9)] / widths[Math.floor(widths.length * .1)] > 1.15) return null;
  return median / info.width;
}

const inputSchema = z.object({ fileId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive(), height: z.number().int().positive(), crops: z.array(boxSchema).min(1).max(2) });
const resultSchema = z.array(z.number().positive().max(1).nullable()).min(1).max(2);
export type BodyGeometryInput = z.infer<typeof inputSchema>;
export const BODY_GEOMETRY_ALGORITHM = 'alpha-torso-v1';
const pendingGeometry = new Map<string, Promise<(number | null)[]>>();

/** Durable derived data; null means the verified image needs manual calibration.
 * The key changes with pixels, dimensions, face crops or algorithm. No task or
 * manual standard is written. Importers supply their already-verified bytes.
 */
export async function loadBodyGeometry(raw: BodyGeometryInput, suppliedBytes?: Buffer): Promise<(number | null)[]> {
  const input = inputSchema.parse(raw);
  const fingerprint = fileSha256(JSON.stringify([BODY_GEOMETRY_ALGORITHM, input.sha256, input.width, input.height, input.crops]));
  const persistent = Boolean(process.env.CATALOG_DATABASE_URL);
  const memoryKey = `${process.env.CATALOG_DATABASE_URL ?? 'local'}:${input.fileId}:${fingerprint}`;
  const known = pendingGeometry.get(memoryKey);
  if (known) return known;
  const work = (async () => {
    if (persistent && !suppliedBytes) {
      const cached = await catalogDatabase().query(`SELECT g.width_ratios FROM catalog_body_geometry g
        JOIN files f ON f.id=$2 AND f.sha256=$3 AND f.width=$4 AND f.height=$5 AND f.status='ready' AND f.gc_state='active'
        WHERE g.input_hash=$1`, [fingerprint, input.fileId, input.sha256, input.width, input.height]);
      if (cached.rowCount) {
        const result = resultSchema.parse(cached.rows[0].width_ratios);
        if (result.length !== input.crops.length) throw new Error('衣身比例记录与正反面数量不一致');
        return result;
      }
    }
    const bytes = suppliedBytes ?? (await readCatalogFile(input.fileId)).bytes;
    if (fileSha256(bytes) !== input.sha256) throw new Error('衣身尺寸读取失败，底图内容已变化');
    const metadata = await sharp(bytes).metadata();
    if (metadata.width !== input.width || metadata.height !== input.height) throw new Error('衣身尺寸读取失败，底图像素尺寸已变化');
    const result = resultSchema.parse(await Promise.all(input.crops.map(crop => torsoWidthRatio(bytes, crop))));
    if (persistent) {
      const saved = await catalogDatabase().query(`INSERT INTO catalog_body_geometry(input_hash,file_id,algorithm,image_sha256,image_width,image_height,crops,width_ratios)
        SELECT $1,id,$3,$4,$5,$6,$7::jsonb,$8::jsonb FROM files
        WHERE id=$2 AND sha256=$4 AND width=$5 AND height=$6 AND status='ready' AND gc_state='active'
        ON CONFLICT(input_hash) DO UPDATE SET width_ratios=EXCLUDED.width_ratios RETURNING input_hash`,
      [fingerprint, input.fileId, BODY_GEOMETRY_ALGORITHM, input.sha256, input.width, input.height, input.crops, result]);
      if (!saved.rowCount) throw new Error('底图文件已变化，未保存衣身比例');
    }
    return result;
  })();
  pendingGeometry.set(memoryKey, work);
  if (pendingGeometry.size > 256) pendingGeometry.delete(pendingGeometry.keys().next().value!);
  try { return await work; }
  catch (error) { if (pendingGeometry.get(memoryKey) === work) pendingGeometry.delete(memoryKey); throw error; }
}
