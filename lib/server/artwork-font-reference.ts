import sharp from 'sharp';
import type { FontReferenceInput } from '@/lib/artwork-font-reference';
import type { ArtworkPreparationRequest } from '@/lib/task-review-artwork';

/** Crop only the selected reference; source assets and unrelated images stay intact. */
export async function cropFontReference(bytes: Buffer, reference: FontReferenceInput) {
  if (!reference.region) return bytes;
  const normalized = await sharp(bytes).rotate().png().toBuffer();
  const metadata = await sharp(normalized).metadata();
  const width = metadata.width!, height = metadata.height!, region = reference.region;
  const left = Math.min(width - 1, Math.floor(region.x * width));
  const top = Math.min(height - 1, Math.floor(region.y * height));
  return sharp(normalized).extract({ left, top,
    width: Math.max(1, Math.min(width - left, Math.ceil(region.width * width))),
    height: Math.max(1, Math.min(height - top, Math.ceil(region.height * height))),
  }).png().toBuffer();
}

export async function cropArtworkFontInput(request: ArtworkPreparationRequest): Promise<ArtworkPreparationRequest> {
  const reference = request.fontReference;
  if (!reference?.region) return request;
  const crop = async (image: ArtworkPreparationRequest['image']) => {
    const bytes = Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64');
    const result = await cropFontReference(bytes, reference);
    return { ...image, mimeType: 'image/png' as const, dataUrl: `data:image/png;base64,${result.toString('base64')}` };
  };
  if (reference.label === request.primaryImageLabel) {
    if (request.primaryImageRole !== 'reference') throw new Error('字体参考裁片不能裁切主要内容图');
    return { ...request, image: await crop(request.image) };
  }
  return { ...request, referenceImages: await Promise.all(request.referenceImages.map(async image => image.label === reference.label
    ? { ...image, image: await crop(image.image) } : image)) };
}
