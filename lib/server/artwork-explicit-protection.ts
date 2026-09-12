import sharp from 'sharp';
import { redPanelRegions, restoreProtectedRgba, type ArtworkProtectionPolicy } from '@/lib/artwork-protection';
/** Zero paid calls. Preserves the original foreground pixels, including white lettering. */
export async function protectExplicitArtwork(source: Buffer, output: Buffer, policy?: ArtworkProtectionPolicy) {
  if (!policy?.keepRedPanels) return { bytes: output, protectedPanels: 0 };
  const [a, b] = await Promise.all([
    sharp(source, { limitInputPixels: 25_000_000 }).ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true }),
    sharp(output, { limitInputPixels: 25_000_000 }).ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) throw new Error('保留品牌底形需要前后图片同尺寸；请先核对候选');
  const regions = redPanelRegions(a.data, a.info.width, a.info.height);
  if (!regions.length) throw new Error('已要求保留红色底形，但未能安全确定完整矩形区域；已保留候选，请标明选区或上传处理好的图案，不自动删除该底形');
  const restored = restoreProtectedRgba(a.data, b.data, a.info.width, a.info.height, regions);
  return { bytes: await sharp(Buffer.from(restored), { raw: { width: a.info.width, height: a.info.height, channels: 4 } }).png().toBuffer(), protectedPanels: regions.length };
}
