'use client';
import { fetchApi, readApiBlob } from './api-response';
import { artworkGraphicLayers, assertArtworkDraft, type ArtworkDraft, type ArtworkGraphicLayer } from '@/lib/artwork-editor';
import { artworkLayers, croppedGraphicGeometry, padArtworkPiece, splitArtworkPixels, updateArtworkLayer, wholeGraphicGeometry, type ArtworkSelection, type PixelPiece } from '@/lib/artwork-layers';
import { loadArtworkImage } from './render-artwork';
import { uploadLogo } from './logo';

function pixelCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前浏览器无法读取图层像素');
  return { canvas, context };
}

export async function splitArtworkGraphic(draft: ArtworkDraft, id: string, selection: ArtworkSelection, copy: boolean) {
  if (artworkLayers(draft).length >= 64) throw new Error('最多支持 64 个图层，请先整理图层');
  const graphic = artworkGraphicLayers(draft).find(layer => layer.id === id);
  if (!graphic || graphic.visible === false) throw new Error('请先选择一个可见的图片图层');
  const image = await loadArtworkImage(graphic.sourceUrl);
  const width = image.naturalWidth, height = image.naturalHeight;
  if (width * height > 32_000_000) throw new Error('图层超过 3200 万像素，请先上传较小的图片再拆层');
  const { context } = pixelCanvas(width, height); context.drawImage(image, 0, 0);
  const source = { width, height, data: context.getImageData(0, 0, width, height).data };
  const wholeGraphic = wholeGraphicGeometry(graphic, source);
  const pieces = splitArtworkPixels(source, wholeGraphic, selection);
  let mask: ImageData | null = null;
  if (graphic.recolorMaskUrl) {
    const maskImage = await loadArtworkImage(graphic.recolorMaskUrl), surface = pixelCanvas(width, height);
    surface.context.drawImage(maskImage, 0, 0, width, height); mask = surface.context.getImageData(0, 0, width, height);
  }
  const encode = (unpadded: PixelPiece): ArtworkGraphicLayer => {
    const piece = padArtworkPiece(unpadded, source);
    const surface = pixelCanvas(width, height);
    surface.context.putImageData(new ImageData(new Uint8ClampedArray(piece.data), piece.width, piece.height), piece.bounds.left, piece.bounds.top);
    let recolorMaskUrl: string | null = null;
    if (mask) {
      const maskSurface = pixelCanvas(width, height), data = maskSurface.context.createImageData(piece.width, piece.height);
      for (let y = 0; y < piece.height; y++) for (let x = 0; x < piece.width; x++) {
        const offset = (y * piece.width + x) * 4, original = ((y + piece.bounds.top) * width + x + piece.bounds.left) * 4;
        if (piece.data[offset + 3]) data.data.set(mask.data.subarray(original, original + 4), offset);
      }
      maskSurface.context.putImageData(data, piece.bounds.left, piece.bounds.top); recolorMaskUrl = maskSurface.canvas.toDataURL('image/png');
    }
    return { ...graphic, ...croppedGraphicGeometry(wholeGraphic, source, piece.bounds), sourceBounds: piece.bounds, sourceUrl: surface.canvas.toDataURL('image/png'), recolorMaskUrl, role: 'decoration', textValue: null };
  };
  const newId = `layer-${crypto.randomUUID()}`;
  const extracted = { ...encode(pieces.selected), id: newId, label: `${copy ? '复制' : '选区'}图层 ${artworkGraphicLayers(draft).length + 1}`, visible: true };
  let next = draft;
  if (!copy) next = updateArtworkLayer(draft, id, pieces.remaining ? encode(pieces.remaining) : { sourceUrl: pixelCanvas(1, 1).canvas.toDataURL('image/png'), sourceBounds: undefined, recolorMaskUrl: null, visible: false, role: 'decoration', textValue: null, label: `${graphic.label ?? '原图'}（空）` });
  const order = artworkLayers(draft).map(layer => layer.id); order.splice(order.indexOf(id) + 1, 0, newId);
  next = { ...next, mode: 'pixelLayers', layerOrder: order, extraGraphics: [...(next.extraGraphics ?? []), extracted], layout: { ...next.layout, preset: 'custom' } };
  assertArtworkDraft(next);
  return { draft: next, selectedId: newId };
}

/** Persist every new source/mask before writing the project; never save browser-only blob URLs. */
export async function persistArtworkLayerAssets(draft: ArtworkDraft, upload = uploadLogo): Promise<ArtworkDraft> {
  const uploads = new Map<string, Promise<string>>();
  const persist = (url: string) => {
    if (!/^(?:data:|blob:)/i.test(url)) return Promise.resolve(url);
    if (!uploads.has(url)) uploads.set(url, (async () => {
      const response = await fetchApi(url);
      const blob = await readApiBlob(response, '读取待保存图层失败');
      if (blob.type !== 'image/png') throw new Error('拆分图层必须保存为透明 PNG');
      return (await upload(new File([blob], `artwork-layer-${uploads.size + 1}.png`, { type: 'image/png' }))).url;
    })());
    return uploads.get(url)!;
  };
  const graphics = await Promise.all(artworkGraphicLayers(draft).map(async layer => ({ ...layer, sourceUrl: await persist(layer.sourceUrl), recolorMaskUrl: layer.recolorMaskUrl ? await persist(layer.recolorMaskUrl) : null })));
  return { ...draft, graphic: graphics[0], extraGraphics: graphics.slice(1) };
}
