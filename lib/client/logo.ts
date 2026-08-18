'use client';

import { usesBrowserStorage } from '@/lib/client/browser-demo-store';

type UploadedLogo = {
  url: string;
  originalName: string;
};

const MAX_LOGO_BYTES = 8 * 1024 * 1024;
const ALLOWED_LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function validateLogo(file: File) {
  if (!ALLOWED_LOGO_TYPES.has(file.type)) {
    throw new Error(`不支持的 Logo 类型：${file.type || '未知'}`);
  }
  if (file.size <= 0 || file.size > MAX_LOGO_BYTES) {
    throw new Error(`Logo 大小必须在 1B 到 8MB 之间，实际：${file.size}B`);
  }
}

function fileDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('浏览器无法读取 Logo 文件'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('浏览器返回了无效的 Logo 内容'));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export async function uploadLogo(file: File): Promise<UploadedLogo> {
  validateLogo(file);
  if (usesBrowserStorage()) {
    return { url: await fileDataUrl(file), originalName: file.name };
  }
  const formData = new FormData();
  formData.set('file', file);
  const response = await fetch('/api/logos', { method: 'POST', body: formData });
  const body: unknown = await response.json();
  if (!response.ok || !body || typeof body !== 'object' || !('url' in body)) {
    const message = body && typeof body === 'object' && 'error' in body
      ? String(body.error)
      : `Logo 上传失败：HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as UploadedLogo;
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`图片加载失败：${url}`));
    image.src = url;
  });
}

export async function removeWhiteBackground(
  logoUrl: string,
  logoName: string,
) {
  const image = await loadImage(logoUrl);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前浏览器无法创建 Logo 处理画布');
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const brightest = Math.max(red, green, blue);
    const darkest = Math.min(red, green, blue);
    if (brightest >= 242 && brightest - darkest <= 18) {
      pixels[offset + 3] = Math.round(((255 - brightest) / 13) * 255);
    }
  }
  context.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Logo 去白底结果为空')), 'image/png');
  });
  const baseName = logoName.replace(/\.[^.]+$/, '') || 'logo';
  return uploadLogo(new File([blob], `${baseName}-transparent.png`, { type: 'image/png' }));
}
