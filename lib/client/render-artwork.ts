'use client';

import {
  artworkCanvasBounds,
  artworkGraphicBounds,
  artworkGraphicFrame,
  artworkGraphicLayers,
  artworkTextLayers,
  assertArtworkDraft,
  type ArtworkDraft,
  type ArtworkGraphicLayer,
  type ArtworkTextLayer,
} from '@/lib/artwork-editor';
import { artworkLayers, recolorArtworkPixels, wholeGraphicGeometry } from '@/lib/artwork-layers';
import { spreadArtworkInk } from '@/lib/artwork-ink-spread';

import { artworkTextFont, artworkTextLayout, loadArtworkFont } from './artwork-text-layout';

type PixelBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export const ARTWORK_EXPORT_SCALE = 2;

export function artworkDraftCanvasBounds(draft: ArtworkDraft) {
  return artworkCanvasBounds(artworkLayers(draft).filter(layer => layer.value.visible !== false).map(layer =>
    layer.kind === 'text' ? artworkTextLayout(layer.value).bounds : artworkGraphicBounds(layer.value)));
}

export function loadArtworkImage(sourceUrl: string) {
  // Only persisted, immutable file IDs can outlive a single load. Other URLs
  // may be mutable or revoked and keep the existing browser loading behavior.
  const reusable = /^\/api\/production-files\/[a-f0-9-]{36}$/u.test(sourceUrl);
  const known = artworkImages.get(sourceUrl);
  if (known && known.expires > Date.now()) {
    artworkImages.delete(sourceUrl); artworkImages.set(sourceUrl, known);
    return known.promise;
  }
  if (known) artworkImages.delete(sourceUrl);
  const entry: ArtworkImageEntry = { promise: undefined!, pixels: 0, expires: Date.now() + 5 * 60_000 };
  entry.promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    if (/^https?:\/\//iu.test(sourceUrl)) image.crossOrigin = 'anonymous';
    image.onload = () => {
      entry.pixels = image.naturalWidth * image.naturalHeight;
      if (reusable) trimArtworkImages();
      resolve(image);
    };
    image.onerror = () => {
      if (artworkImages.get(sourceUrl) === entry) artworkImages.delete(sourceUrl);
      reject(new Error(`图形图层加载失败：${sourceUrl.slice(0, 120)}`));
    };
    image.src = sourceUrl;
  });
  if (reusable) { artworkImages.set(sourceUrl, entry); trimArtworkImages(); }
  return entry.promise;
}

type ArtworkImageEntry = { promise: Promise<HTMLImageElement>; pixels: number; expires: number };
const artworkImages = new Map<string, ArtworkImageEntry>();
function trimArtworkImages() {
  let pixels = [...artworkImages.values()].reduce((total, entry) => total + entry.pixels, 0);
  for (const [url, entry] of artworkImages) {
    if (artworkImages.size <= 24 && pixels <= 8_000_000) break;
    artworkImages.delete(url); pixels -= entry.pixels;
  }
}

const preloadQueue = new Set<string>();
let activePreloads = 0;
/** Called only for loaded table thumbnails or user intent, never all orders. */
export function preloadArtworkDraft(draft: ArtworkDraft) {
  for (const graphic of artworkGraphicLayers(draft).filter(layer => layer.visible !== false)) {
    const urls = [graphic.sourceUrl, ...(graphic.recolor.mode === 'solid' && graphic.recolorScope !== 'visible' && graphic.recolorMaskUrl ? [graphic.recolorMaskUrl] : [])];
    for (const url of urls) {
      if (/^\/api\/production-files\/[a-f0-9-]{36}$/u.test(url) && (artworkImages.get(url)?.expires ?? 0) <= Date.now() && preloadQueue.size < 64) preloadQueue.add(url);
    }
  }
  drainPreloads();
}
function drainPreloads() {
  while (activePreloads < 2 && preloadQueue.size) {
    const url = preloadQueue.values().next().value!;
    preloadQueue.delete(url); activePreloads++;
    void loadArtworkImage(url).catch(() => { /* Opening retries and shows errors. */ }).finally(() => { activePreloads--; drainPreloads(); });
  }
}

function context2d(canvas: HTMLCanvasElement, label: string) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error(`当前浏览器无法创建${label}画布`);
  return context;
}

function recoloredImage(image: HTMLImageElement, mask: HTMLImageElement | null, color: string | null) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = context2d(canvas, '图形换色');
  context.drawImage(image, 0, 0);
  if (!color) return canvas;
  let maskPixels: ImageData | null = null;
  if (mask) {
    const maskCanvas = document.createElement('canvas'); maskCanvas.width = image.naturalWidth; maskCanvas.height = image.naturalHeight;
    const maskContext = context2d(maskCanvas, '主体换色蒙版');
    maskContext.drawImage(mask, 0, 0, maskCanvas.width, maskCanvas.height);
    maskPixels = maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
  }
  const sourcePixels = context.getImageData(0, 0, canvas.width, canvas.height);
  if (color) sourcePixels.data.set(recolorArtworkPixels(sourcePixels.data, color, maskPixels?.data));
  context.putImageData(sourcePixels, 0, 0);
  return canvas;
}

export async function loadArtworkGraphicRaster(graphic: ArtworkGraphicLayer) {
  const [image, mask] = await Promise.all([
    loadArtworkImage(graphic.sourceUrl),
    graphic.recolor.mode === 'solid' && graphic.recolorScope !== 'visible' && graphic.recolorMaskUrl ? loadArtworkImage(graphic.recolorMaskUrl) : null,
  ]);
  return recoloredImage(image, mask, graphic.recolor.mode === 'solid' && (mask || graphic.recolorScope === 'visible') ? graphic.recolor.color : null);
}

/** Shared editor/export appearance. Zero spread retains native source sampling. */
export async function loadArtworkGraphicView(graphic: ArtworkGraphicLayer) {
  const source = await loadArtworkGraphicRaster(graphic);
  if (!graphic.inkSpread && !graphic.sourceBounds) return source;
  const crop = graphic.sourceBounds ?? { left: 0, top: 0, width: source.width, height: source.height };
  const canvas = document.createElement('canvas');
  const spread = graphic.inkSpread ?? 0;
  const frame = artworkGraphicFrame(graphic);
  canvas.width = spread ? Math.ceil(frame.width * ARTWORK_EXPORT_SCALE) : crop.width;
  canvas.height = spread ? Math.ceil(frame.height * ARTWORK_EXPORT_SCALE) : crop.height;
  if (canvas.width * canvas.height > 32_000_000) throw new Error('加粗图层尺寸过大，请先减小图层尺寸');
  const context = context2d(canvas, '图层笔画');
  if (!spread) { context.drawImage(source, -crop.left, -crop.top); return canvas; }
  const sx = canvas.width / frame.width, sy = canvas.height / frame.height;
  context.drawImage(source, crop.left, crop.top, crop.width, crop.height, spread * sx, spread * sy, graphic.width * sx, graphic.height * sy);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  pixels.data.set(spreadArtworkInk(pixels.data, canvas.width, canvas.height, spread * sx, spread * sy));
  context.putImageData(pixels, 0, 0);
  return canvas;
}

export function drawArtworkText(context: CanvasRenderingContext2D, text: ArtworkTextLayer) {
  const { glyphs, alignmentOffset } = artworkTextLayout(text);
  if (glyphs.length === 0) return;
  context.save();
  context.translate(text.x + alignmentOffset, text.y);
  context.font = artworkTextFont(text);
  context.fillStyle = text.color;
  context.strokeStyle = text.color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineCap = 'round';
  context.lineWidth = Math.max(1.5, text.fontSize / 24);
  for (const glyph of glyphs) {
    context.save();
    context.translate(glyph.x, glyph.y);
    context.rotate(glyph.rotation * Math.PI / 180);
    context.scale(glyph.horizontalScale, 1);
    context.fillText(glyph.char, 0, 0);
    if (text.underline && glyph.char.trim()) {
      const underlineY = text.fontSize * 0.58;
      context.beginPath();
      const unscaledAdvance = glyph.advance / Math.max(glyph.horizontalScale, 0.01);
      context.moveTo(-unscaledAdvance * 0.38, underlineY);
      context.lineTo(unscaledAdvance * 0.38, underlineY);
      context.stroke();
    }
    context.restore();
  }
  context.restore();
}

export function alphaContentBounds(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): PixelBounds | null {
  if (pixels.length !== width * height * 4) {
    throw new Error(`像素数量与 ${width}×${height} 画布不匹配：${pixels.length}`);
  }
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left ? null : { left, top, right, bottom };
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob
      ? resolve(blob)
      : reject(new Error('完整图案 PNG 输出为空')), 'image/png');
  });
}

export async function renderArtworkPreview(draft: ArtworkDraft) {
  assertArtworkDraft(draft);
  await Promise.all(artworkTextLayers(draft).filter(text => text.visible !== false).map(loadArtworkFont));
  const surface = artworkDraftCanvasBounds(draft);
  const canvas = document.createElement('canvas');
  const width = surface.width * ARTWORK_EXPORT_SCALE, height = surface.height * ARTWORK_EXPORT_SCALE;
  if (width > 16384 || height > 16384 || width * height > 32_000_000) throw new Error('图案尺寸过大，请减小图层尺寸或间距后保存。');
  canvas.width = width;
  canvas.height = height;
  const context = context2d(canvas, '完整图案');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.scale(ARTWORK_EXPORT_SCALE, ARTWORK_EXPORT_SCALE);
  context.translate(-surface.left, -surface.top);
  for (const layer of artworkLayers(draft).filter(layer => layer.value.visible !== false)) {
    if (layer.kind === 'text') { await loadArtworkFont(layer.value); drawArtworkText(context, layer.value); }
    else {
      if (layer.value.inkSpread) {
        const raster = await loadArtworkGraphicView(layer.value), frame = artworkGraphicFrame(layer.value);
        context.save(); context.translate(layer.value.x, layer.value.y); context.rotate(layer.value.rotation * Math.PI / 180);
        context.drawImage(raster, -frame.width / 2, -frame.height / 2, frame.width, frame.height); context.restore();
        continue;
      }
      const raster = await loadArtworkGraphicRaster(layer.value), graphic = wholeGraphicGeometry(layer.value, raster);
      context.save(); context.translate(graphic.x, graphic.y); context.rotate(graphic.rotation * Math.PI / 180);
      context.drawImage(raster, -graphic.width / 2, -graphic.height / 2, graphic.width, graphic.height); context.restore();
    }
  }

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const bounds = alphaContentBounds(imageData.data, canvas.width, canvas.height);
  if (!bounds) throw new Error('完整图案没有任何非透明像素，请检查 Logo 和文字图层');
  const safeMargin = 28 * ARTWORK_EXPORT_SCALE;
  const cropLeft = Math.max(0, bounds.left - safeMargin);
  const cropTop = Math.max(0, bounds.top - safeMargin);
  const cropRight = Math.min(canvas.width - 1, bounds.right + safeMargin);
  const cropBottom = Math.min(canvas.height - 1, bounds.bottom + safeMargin);
  const output = document.createElement('canvas');
  output.width = cropRight - cropLeft + 1;
  output.height = cropBottom - cropTop + 1;
  context2d(output, '裁边输出').drawImage(
    canvas,
    cropLeft,
    cropTop,
    output.width,
    output.height,
    0,
    0,
    output.width,
    output.height,
  );
  return { blob: await canvasBlob(output), width: output.width, height: output.height,
    contentBounds: { left: bounds.left - cropLeft, top: bounds.top - cropTop, width: bounds.right - bounds.left + 1, height: bounds.bottom - bounds.top + 1 },
    letters: artworkTextLayers(draft).filter(text => text.visible !== false).flatMap(text => artworkTextLayout(text).letters.map(letter => ({ ...letter, height: letter.height * ARTWORK_EXPORT_SCALE }))),
  };
}

export async function renderArtworkPng(draft: ArtworkDraft) {
  return (await renderArtworkPreview(draft)).blob;
}

export async function artworkPngFile(draft: ArtworkDraft, fileName: string) {
  const normalizedName = fileName.replace(/\.[^.]+$/u, '').replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'artwork';
  return new File([await renderArtworkPng(draft)], `${normalizedName}-edited.png`, {
    type: 'image/png',
  });
}
