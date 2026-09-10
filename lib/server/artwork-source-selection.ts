import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { artworkSourceSelectionSchema, type ArtworkSourceAssessment } from '@/lib/artwork-source-assessment';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export type ArtworkSourceSelectionReceipt = {
  version: 'artwork-source-selection-v1'; sourceSha256: string; outputSha256: string;
  sourceWidth: number; sourceHeight: number;
  bounds: { left: number; top: number; width: number; height: number };
};

/** Select pixels before quality/enhancement/cutout; background removal cannot select a logo. */
export async function selectArtworkSource(bytes: Buffer, selection: ArtworkSourceAssessment['selection']) {
  const parsed = artworkSourceSelectionSchema.safeParse(selection);
  if (!parsed.success || parsed.data.scope === 'unknown') {
    throw new Error('尚未确定本次要用的图案范围，请在制作要求中明确横版、竖版或所在区域；本次尚未开始增强和抠图。');
  }
  if (parsed.data.scope === 'full-image') return { bytes };
  const { width, height } = await sharp(bytes).metadata();
  if (!width || !height) throw new Error('素材缺少可识别的尺寸，无法定位目标图案');
  const box = parsed.data.bounds;
  const left = Math.floor(box.left * width / 1000), top = Math.floor(box.top * height / 1000);
  const bounds = { left, top, width: Math.ceil(box.right * width / 1000) - left, height: Math.ceil(box.bottom * height / 1000) - top };
  if (bounds.width < 8 || bounds.height < 8) throw new Error('识别到的目标图案范围过小，请核对目标区域；本次尚未开始增强和抠图。');
  const output = await sharp(bytes).extract(bounds).png().toBuffer();
  const receipt: ArtworkSourceSelectionReceipt = { version: 'artwork-source-selection-v1',
    sourceSha256: sha(bytes), outputSha256: sha(output), sourceWidth: width, sourceHeight: height, bounds };
  return { bytes: output, receipt };
}
