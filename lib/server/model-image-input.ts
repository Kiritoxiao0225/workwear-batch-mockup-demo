import sharp from 'sharp';
export const MAX_MODEL_IMAGE_BYTES = 8 * 1024 * 1024;

/** Keep normal images byte-for-byte. Only oversized analysis inputs need a derivative. */
export async function boundedModelImage(bytes: Buffer, allowResize = true) {
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('模型素材必须为 1B–64MB');
  const metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: 80_000_000 }).metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || !metadata.width || !metadata.height) throw new Error('模型素材格式不支持');
  const output = (data: Buffer, mimeType: string) => ({ bytes: data, mimeType, dataUrl: `data:${mimeType};base64,${data.toString('base64')}` });
  if (bytes.length <= MAX_MODEL_IMAGE_BYTES) return output(bytes, `image/${metadata.format}`);
  const lossless = await sharp(bytes).rotate().webp({ lossless: true }).toBuffer();
  if (lossless.length <= MAX_MODEL_IMAGE_BYTES) return output(lossless, 'image/webp');
  if (!allowResize) throw new Error('素材无损压缩后仍超过 8MB，请提供较小原图；保真制作不会自动降低清晰度');
  // For understanding only: try full resolution first to retain small text.
  let edge = Math.max(metadata.width, metadata.height);
  while (edge >= 1024) {
    const data = await sharp(bytes).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).webp({ quality: 95 }).toBuffer();
    if (data.length <= MAX_MODEL_IMAGE_BYTES) return output(data, 'image/webp');
    edge = Math.floor(edge * 0.8);
  }
  throw new Error('素材过大，无法在保留解析细节时满足 8MB 限制');
}

/** Production processing keeps its historical upright PNG pixels; WebP is lossless only. */
export async function fidelityModelImage(bytes: Buffer) {
  const png = await sharp(bytes, { limitInputPixels: 32_000_000 }).rotate().png().toBuffer();
  return boundedModelImage(png, false);
}
