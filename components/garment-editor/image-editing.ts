export function compressedImageDataUrl(base64Image: string, maxPx: number): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      if (img.width <= maxPx && img.height <= maxPx) {
        resolve(base64Image);
        return;
      }

      const scale = maxPx / Math.max(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const isPng = base64Image.startsWith('data:image/png');
      resolve(canvas.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.92));
    };
    img.onerror = () => resolve(base64Image);
    img.src = base64Image;
  });
}

export function readCompressedImageFile(file: File, maxPx: number): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`上传文件必须是图片，收到 ${file.type || file.name}`);
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async event => {
      const base64Image = event.target?.result;
      if (typeof base64Image !== 'string') {
        reject(new Error(`图片读取失败，文件 ${file.name} 没有返回 base64 内容`));
        return;
      }

      resolve(await compressedImageDataUrl(base64Image, maxPx));
    };
    reader.onerror = () => reject(new Error(`图片读取失败，文件 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export const DEFAULT_LOGO_EDGE_CLEANUP_STRENGTH = 0;
export const MAX_LOGO_CUTOUT_PROVENANCE_ENTRIES = 256;

export function logoImageProvenanceKey(image: string) {
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b9;
  for (let index = 0; index < image.length; index++) {
    const charCode = image.charCodeAt(index);
    hashA = Math.imul(hashA ^ charCode, 0x01000193);
    hashB = Math.imul(hashB ^ (charCode + index), 0x85ebca6b);
    hashB ^= hashB >>> 13;
  }
  return `${image.length}:${(hashA >>> 0).toString(16)}:${(hashB >>> 0).toString(16)}`;
}

export function rememberLogoCutoutSource(
  sourceImageByAppliedImageKey: Map<string, string>,
  appliedImage: string,
  sourceImage: string
) {
  const appliedImageKey = logoImageProvenanceKey(appliedImage);
  sourceImageByAppliedImageKey.delete(appliedImageKey);
  sourceImageByAppliedImageKey.set(appliedImageKey, sourceImage);
  while (sourceImageByAppliedImageKey.size > MAX_LOGO_CUTOUT_PROVENANCE_ENTRIES) {
    const oldestAppliedImageKey = sourceImageByAppliedImageKey.keys().next().value;
    if (oldestAppliedImageKey === undefined) break;
    sourceImageByAppliedImageKey.delete(oldestAppliedImageKey);
  }
}

export function logoSourceImageForCutout(
  displayedImage: string,
  sourceImageByAppliedImageKey: ReadonlyMap<string, string> | undefined
) {
  return sourceImageByAppliedImageKey?.get(logoImageProvenanceKey(displayedImage)) ?? displayedImage;
}

export function erodedLogoMaskAlpha(
  alpha: Uint8Array,
  width: number,
  height: number,
  strength: number
) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`Logo mask dimensions must be positive integers, received ${width}x${height}`);
  }
  if (alpha.length !== width * height) {
    throw new Error(`Logo mask alpha length ${alpha.length} does not match ${width}x${height}`);
  }
  if (!Number.isFinite(strength) || strength < 0 || strength > 100) {
    throw new Error(`Logo edge cleanup strength must be between 0 and 100, received ${strength}`);
  }

  const eroded = new Uint8Array(alpha);
  if (strength === 0) return eroded;

  const edgeThreshold = 100 + strength * 1.55;
  const penalty = strength * 0.8;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const pixelIndex = y * width + x;
      if (alpha[pixelIndex] > 0 && alpha[pixelIndex] < 255) {
        const minNeighbor = Math.min(
          alpha[pixelIndex - 1],
          alpha[pixelIndex + 1],
          alpha[pixelIndex - width],
          alpha[pixelIndex + width],
        );
        if (minNeighbor < alpha[pixelIndex]) {
          eroded[pixelIndex] = Math.max(0, alpha[pixelIndex] - penalty);
        }
      }
      if (eroded[pixelIndex] < edgeThreshold && eroded[pixelIndex] > 0) {
        const distance = eroded[pixelIndex] / edgeThreshold;
        eroded[pixelIndex] = Math.floor(eroded[pixelIndex] * distance * distance);
      }
    }
  }
  return eroded;
}

export async function erodedLogoMaskDataUrl(maskSrc: string, originalSrc: string, strength: number): Promise<string> {
  const origImg = new Image();
  origImg.src = originalSrc;
  await origImg.decode();

  const maskImg = new Image();
  maskImg.src = maskSrc;
  await maskImg.decode();

  const canvas = document.createElement('canvas');
  canvas.width = origImg.naturalWidth;
  canvas.height = origImg.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(origImg, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = canvas.width;
  maskCanvas.height = canvas.height;
  const maskCtx = maskCanvas.getContext('2d')!;
  maskCtx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
  const maskData = maskCtx.getImageData(0, 0, canvas.width, canvas.height);

  const width = canvas.width;
  const height = canvas.height;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = maskData.data[i * 4];
  }

  const eroded = erodedLogoMaskAlpha(alpha, width, height, strength);
  for (let i = 0; i < imageData.data.length; i += 4) {
    imageData.data[i + 3] = eroded[i >> 2];
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

export type LogoBackgroundKind = 'transparent' | 'flat' | 'complex';

/**
 * Border check in the browser, mirroring the server's free paths: transparent, or one flat
 * colour with none of it enclosed inside the design (white letter counters need a model).
 */
export function inspectLogoBackground(source: string): Promise<LogoBackgroundKind> {
  return new Promise(resolve => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const scale = Math.min(1, 200 / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) { resolve('complex'); return; }
      context.drawImage(image, 0, 0, width, height);
      const { data } = context.getImageData(0, 0, width, height);
      const band = Math.max(1, Math.round(Math.min(width, height) * 0.03));
      const bins = new Map<string, { count: number; r: number; g: number; b: number }>();
      let border = 0, transparent = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (x >= band && x < width - band && y >= band && y < height - band) continue;
          border++;
          const offset = (y * width + x) * 4;
          if (data[offset + 3] <= 8) { transparent++; continue; }
          const key = `${data[offset] >> 4},${data[offset + 1] >> 4},${data[offset + 2] >> 4}`;
          const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
          bin.count++; bin.r += data[offset]; bin.g += data[offset + 1]; bin.b += data[offset + 2];
          bins.set(key, bin);
        }
      }
      if (border && transparent / border >= 0.2) { resolve('transparent'); return; }
      const dominant = [...bins.values()].sort((a, b) => b.count - a.count)[0];
      if (!dominant || dominant.count / (border - transparent || 1) < 0.9) { resolve('complex'); return; }
      const bg = { r: dominant.r / dominant.count, g: dominant.g / dominant.count, b: dominant.b / dominant.count };
      const near = (index: number, limit: number) => {
        const offset = index * 4;
        return data[offset + 3] > 8 && (data[offset] - bg.r) ** 2 + (data[offset + 1] - bg.g) ** 2 + (data[offset + 2] - bg.b) ** 2 <= limit * limit;
      };
      // Flood the background from the border; background-coloured pixels it cannot reach are enclosed.
      const reached = new Uint8Array(width * height), queue: number[] = [];
      for (let x = 0; x < width; x++) { queue.push(x, (height - 1) * width + x); }
      for (let y = 0; y < height; y++) { queue.push(y * width, y * width + width - 1); }
      while (queue.length) {
        const index = queue.pop()!;
        if (reached[index] || !near(index, 48)) continue;
        reached[index] = 1;
        const x = index % width;
        if (x > 0) queue.push(index - 1);
        if (x < width - 1) queue.push(index + 1);
        if (index >= width) queue.push(index - width);
        if (index < width * (height - 1)) queue.push(index + width);
      }
      let design = 0, enclosed = 0;
      for (let index = 0; index < width * height; index++) {
        if (reached[index] || data[index * 4 + 3] <= 8) continue;
        design++;
        if (near(index, 24)) enclosed++;
      }
      resolve(design && enclosed / design <= 0.003 ? 'flat' : 'complex');
    };
    image.onerror = () => resolve('complex');
    image.src = source;
  });
}
