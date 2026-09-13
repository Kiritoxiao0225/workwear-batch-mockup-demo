import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { hash, fail } from '../adapters/a-files.mjs';
import { receiveConfirmedRequirement } from './b-intake.mjs';
import { capabilities } from '../domain/b-capabilities.mjs';

export const fontPath = new URL('../../public/fonts/DOUYINSANSBOLD.TTF', import.meta.url);

export async function inspectImage(bytes) {
  const image = sharp(bytes, { limitInputPixels: 40000000 });
  const meta = await image.metadata();
  if (!['png', 'jpeg', 'webp'].includes(meta.format) || (meta.pages || 1) !== 1) throw fail('B仅支持静态PNG/JPEG/WebP原图');
  // Decode actual pixels; PNG extension or an alpha channel alone is not transparency.
  const { data, info } = await image.rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0, visible = 0, left = info.width, top = info.height, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const a = data[(y * info.width + x) * info.channels + info.channels - 1];
    if (a < 255) transparent++;
    if (a > 0) { visible++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  if (!visible) throw fail('原图完全透明，没有可制作内容');
  return { width: info.width, height: info.height, format: meta.format, orientation: meta.orientation || 1,
    hasTransparentPixels: transparent > 0, transparentFraction: transparent / (info.width * info.height),
    alphaContentBounds: transparent ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : null,
    effectiveSubjectPixels: null, subjectPixelNote: 'Alpha范围是可见像素范围，不等于Logo主体；不透明照片需结合视觉选区判断，不能把整张照片像素当图案像素。' };
}

export async function prepareBInput(receipt, readAsset, output) {
  if (receipt?.status !== 'received' || receipt.inputSHA256 !== hash(JSON.stringify(receipt.input))) throw fail('需要A保存的确认接收回执', 409);
  if (!output || !['width', 'height'].every(k => Number.isInteger(output[k]) && output[k] >= 64 && output[k] <= 8192) || output.width * output.height > 40000000 || !['preserve', 'transparent', 'white'].includes(output.background) || (output.sizing && !['native', 'exact'].includes(output.sizing)) || (output.fit && output.fit !== 'contain') || !output.basis?.trim()) throw fail('请明确画布宽高像素、背景策略、尺寸模式及配置依据；服装尺码不能充当图稿像素');
  const bytes = new Map();
  await receiveConfirmedRequirement(receipt.input, async asset => {
    const value = await readAsset(asset); bytes.set(asset, value); return value;
  });
  const ids = receipt.input.images.map(i => i.id);
  if (new Set(ids).size !== ids.length) throw fail('素材身份重复');
  const facts = [];
  for (const image of receipt.input.images) facts.push({ id: image.id, label: image.label, ...await inspectImage(bytes.get(image.asset)) });
  const font = await readFile(fontPath);
  const input = { schema: 'b-input-v1', confirmation: structuredClone(receipt.input), confirmationSHA256: receipt.inputSHA256,
    output: structuredClone(output), images: facts, capabilities: structuredClone(capabilities),
    fonts: [{ id: 'douyin-sans', name: '抖音美好体', sha256: hash(font), boundary: '只有需求允许此字体才可选择；存在不等于符合参考字体' }] };
  return { input, bytes };
}
