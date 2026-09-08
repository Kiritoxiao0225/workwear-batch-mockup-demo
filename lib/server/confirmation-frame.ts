import sharp from 'sharp';
import { z } from 'zod';
import { boxSchema } from '@/lib/catalog';
import { CONFIRMATION_FRAME, CONFIRMATION_OUTPUT } from '@/lib/confirmation-frame';

const faceSchema = z.array(z.object({ face: z.enum(['front', 'back']), crop: boxSchema }).strict()).min(1).max(2)
  .refine(faces => faces.some(face => face.face === 'front') && new Set(faces.map(face => face.face)).size === faces.length, '必须有正面，且不能重复视图');

// Call with a bare garment for catalog preview, or an already printed garment for delivery.
// Garment and print pixels are transformed together, without changing calibration coordinates.
export async function renderConfirmationFrame(garmentBytes: Buffer, frameBytes: Buffer, rawFaces: unknown) {
  const faces = faceSchema.parse(rawFaces).sort((a, b) => (a.face === 'front' ? 0 : 1) - (b.face === 'front' ? 0 : 1));
  const [garment, frame] = await Promise.all([sharp(garmentBytes, { failOn: 'error' }).metadata(), sharp(frameBytes, { failOn: 'error' }).metadata()]);
  if (!garment.width || !garment.height) throw new Error(`服装图尺寸无效：${garment.width} × ${garment.height}`);
  if (frame.width !== CONFIRMATION_OUTPUT.width || frame.height !== CONFIRMATION_OUTPUT.height) throw new Error(`底框尺寸应为 ${CONFIRMATION_OUTPUT.width} × ${CONFIRMATION_OUTPUT.height}，实际为 ${frame.width} × ${frame.height}`);
  const cropped = await Promise.all(faces.map(async view => {
    const left = Math.round(view.crop.x * garment.width!);
    const top = Math.round(view.crop.y * garment.height!);
    const width = Math.min(garment.width! - left, Math.round(view.crop.width * garment.width!));
    const height = Math.min(garment.height! - top, Math.round(view.crop.height * garment.height!));
    if (width < 1 || height < 1) throw new Error(`${view.face} 裁剪区域不足一个像素：${JSON.stringify(view.crop)}`);
    const bytes = await sharp(garmentBytes).extract({ left, top, width, height }).ensureAlpha().png().toBuffer();
    const alpha = (await sharp(bytes).stats()).channels[3];
    if (alpha.max === 0) throw new Error(`${view.face} 视图完全透明，不能生成带框预览`);
    // Opaque photos keep their background. Never remove white pixels from white garments.
    const image = alpha.min < 255 ? sharp(bytes).trim({ background: '#00000000', threshold: 0 }) : sharp(bytes);
    return image.png().toBuffer({ resolveWithObject: true });
  }));
  const outputScale = CONFIRMATION_OUTPUT.scale;
  const area = {
    left: CONFIRMATION_FRAME.garmentArea.left * outputScale,
    top: CONFIRMATION_FRAME.garmentArea.top * outputScale,
    width: CONFIRMATION_FRAME.garmentArea.width * outputScale,
    height: CONFIRMATION_FRAME.garmentArea.height * outputScale,
  };
  const gap = CONFIRMATION_FRAME.faceGap * outputScale;
  const slotWidth = (area.width - gap * (faces.length - 1)) / faces.length;
  const scale = Math.min(...cropped.map(image => Math.min(slotWidth / image.info.width, area.height / image.info.height)));
  const overlays = await Promise.all(cropped.map(async (image, index) => {
    const width = Math.max(1, Math.floor(image.info.width * scale));
    const height = Math.max(1, Math.floor(image.info.height * scale));
    return {
      input: await sharp(image.data).resize(width, height, { fit: 'fill' }).png().toBuffer(),
      left: Math.round(area.left + index * (slotWidth + gap) + (slotWidth - width) / 2),
      top: area.top + area.height - height,
    };
  }));
  // The template is already rendered from vector outlines at native output size.
  return sharp(frameBytes)
    .composite(overlays).flatten({ background: '#ffffff' }).png().toBuffer();
}
