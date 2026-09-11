import path from 'node:path';
import { createCanvas, loadImage, GlobalFonts, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { artworkCanvasBounds, artworkGraphicBounds, artworkGraphicFrame, artworkTextLayers, assertArtworkDraft,
  createLegacyArtworkDraft, inferredArtworkTextArc, artworkGraphicLayers, type ArtworkDraft, type ArtworkGraphicLayer, type ArtworkTextLayer } from '@/lib/artwork-editor';
import { artworkLayers, recolorArtworkPixels, wholeGraphicGeometry, addArtworkText } from '@/lib/artwork-layers';
import { spreadArtworkInk } from '@/lib/artwork-ink-spread';
import { artworkTextFont, measureArtworkText } from '@/lib/artwork-text-metrics';
import { fitArtworkForPrint } from '@/lib/production-artwork-layout';
import { printedTextHeights } from '@/lib/production-legibility';
import { printSizeCm } from '@/lib/production-sizing';
import { contrastingArtworkTextColor, DEFAULT_ARTWORK_FONT } from '@/lib/artwork-text-defaults';
import { taskPlacementAnchor } from '@/lib/production-preview';
import type { ProductionUnit } from '@/lib/wps-production';
import { readProductionFile } from './production-storage';

let fontReady = false;
function ensureFont() {
  if (!fontReady) {
    if (!GlobalFonts.registerFromPath(path.join(process.cwd(), 'public/fonts/DOUYINSANSBOLD.TTF'), 'Douyin Sans')) throw new Error('后台抖音美好体加载失败');
    fontReady = true;
  }
}
export function serverArtworkTextLayout(text: ArtworkTextLayer) {
  ensureFont();
  // New automatic artwork uses the bundled font; silently substituting a missing font would change print size.
  if (!text.fontFamily.startsWith('Douyin Sans')) throw new Error(`后台缺少字体 ${text.fontFamily}，请在编辑器核对后保存`);
  return measureArtworkText(text, createCanvas(1, 1).getContext('2d'));
}
async function load(url: string) {
  return loadImage(url.startsWith('data:image/') ? Buffer.from(url.slice(url.indexOf(',') + 1), 'base64') : await readProductionFile(url));
}
async function graphicRaster(graphic: ArtworkGraphicLayer) {
  const image = await load(graphic.sourceUrl);
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  if (graphic.recolor.mode === 'solid') {
    let mask: Uint8ClampedArray | undefined;
    if (graphic.recolorScope !== 'visible' && graphic.recolorMaskUrl) {
      const surface = createCanvas(image.width, image.height), ctx = surface.getContext('2d');
      ctx.drawImage(await load(graphic.recolorMaskUrl), 0, 0, image.width, image.height);
      mask = ctx.getImageData(0, 0, image.width, image.height).data;
    }
    if (graphic.recolor.color && (mask || graphic.recolorScope === 'visible')) {
      const pixels = context.getImageData(0, 0, image.width, image.height);
      pixels.data.set(recolorArtworkPixels(pixels.data, graphic.recolor.color, mask));
      context.putImageData(pixels, 0, 0);
    }
  }
  if (!graphic.inkSpread) return canvas;
  const crop = graphic.sourceBounds ?? { left: 0, top: 0, width: canvas.width, height: canvas.height };
  const spread = graphic.inkSpread, frame = artworkGraphicFrame(graphic);
  const view = surface(Math.ceil(frame.width * 2), Math.ceil(frame.height * 2)), ctx = view.getContext('2d');
  const sx = view.width / frame.width, sy = view.height / frame.height;
  ctx.drawImage(canvas, crop.left, crop.top, crop.width, crop.height, spread * sx, spread * sy, graphic.width * sx, graphic.height * sy);
  const pixels = ctx.getImageData(0, 0, view.width, view.height);
  pixels.data.set(spreadArtworkInk(pixels.data, view.width, view.height, spread * sx, spread * sy));
  ctx.putImageData(pixels, 0, 0);
  return view;
}
function surface(width: number, height: number): Canvas {
  if (width > 16384 || height > 16384 || width * height > 32_000_000) throw new Error('图案尺寸过大，请减小图层尺寸或间距后保存');
  return createCanvas(width, height);
}
function drawText(context: SKRSContext2D, text: ArtworkTextLayer) {
  const { glyphs, alignmentOffset } = serverArtworkTextLayout(text);
  context.save(); context.translate(text.x + alignmentOffset, text.y); context.font = artworkTextFont(text);
  context.fillStyle = text.color; context.strokeStyle = text.color; context.textAlign = 'center'; context.textBaseline = 'middle';
  context.lineCap = 'round'; context.lineWidth = Math.max(1.5, text.fontSize / 24);
  for (const glyph of glyphs) {
    context.save(); context.translate(glyph.x, glyph.y); context.rotate(glyph.rotation * Math.PI / 180); context.scale(glyph.horizontalScale, 1);
    context.fillText(glyph.char, 0, 0);
    if (text.underline && glyph.char.trim()) {
      const advance = glyph.advance / Math.max(glyph.horizontalScale, .01);
      context.beginPath(); context.moveTo(-advance * .38, text.fontSize * .58); context.lineTo(advance * .38, text.fontSize * .58); context.stroke();
    }
    context.restore();
  }
  context.restore();
}
export async function renderServerArtwork(draft: ArtworkDraft) {
  assertArtworkDraft(draft);
  const layers = artworkLayers(draft).filter(layer => layer.value.visible !== false);
  const bounds = artworkCanvasBounds(layers.map(layer => layer.kind === 'text' ? serverArtworkTextLayout(layer.value).bounds : artworkGraphicBounds(layer.value)));
  const canvas = surface(bounds.width * 2, bounds.height * 2), ctx = canvas.getContext('2d');
  ctx.scale(2, 2); ctx.translate(-bounds.left, -bounds.top);
  for (const layer of layers) {
    if (layer.kind === 'text') drawText(ctx, layer.value);
    else {
      const raster = await graphicRaster(layer.value);
      const graphic = layer.value.inkSpread ? { ...layer.value, ...artworkGraphicFrame(layer.value) } : wholeGraphicGeometry(layer.value, raster);
      ctx.save(); ctx.translate(graphic.x, graphic.y); ctx.rotate(graphic.rotation * Math.PI / 180);
      ctx.drawImage(raster, -graphic.width / 2, -graphic.height / 2, graphic.width, graphic.height); ctx.restore();
    }
  }
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) if (pixels[(y * canvas.width + x) * 4 + 3]) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left) throw new Error('完整图案没有任何非透明像素');
  const x = Math.max(0, left - 56), y = Math.max(0, top - 56);
  const output = surface(Math.min(canvas.width - 1, right + 56) - x + 1, Math.min(canvas.height - 1, bottom + 56) - y + 1);
  output.getContext('2d').drawImage(canvas, x, y, output.width, output.height, 0, 0, output.width, output.height);
  return { bytes: await output.encode('png'), width: output.width, height: output.height,
    contentBounds: { left: left - x, top: top - y, width: right - left + 1, height: bottom - top + 1 },
    letters: artworkTextLayers(draft).filter(text => text.visible !== false).flatMap(text => serverArtworkTextLayout(text).letters.map(letter => ({ ...letter, height: letter.height * 2 }))) };
}
export async function prepareServerPrintedArtwork(draft: ArtworkDraft, unit: Pick<ProductionUnit, 'placement'>) {
  if (!unit.placement) throw new Error('缺少印花位置，无法确定图文字高');
  const fitted = fitArtworkForPrint(await visibleAutomaticArtwork(draft), unit.placement, serverArtworkTextLayout);
  const rendered = await renderServerArtwork(fitted.draft);
  const size = printSizeCm(fitted.placement, rendered.contentBounds.width / rendered.contentBounds.height);
  const heights = printedTextHeights(rendered.letters, rendered.contentBounds.height, size.height);
  return { ...fitted, rendered, summary: fitted.needsReview || heights.some(group => group.small)
    ? '自动排版后的小字尺寸需要核对。' : `已自动安排图文大小：整组 ${size.width.toFixed(1)} × ${size.height.toFixed(1)} cm。` };
}

/** Automatic spacing uses painted pixels, never transparent padding from a model output.
 * Manual/custom layouts and flattened brand artwork retain their existing geometry. */
export async function visibleAutomaticArtwork(original: ArtworkDraft): Promise<ArtworkDraft> {
  if (original.mode !== 'structured' || original.layout.preset === 'custom'
    || (!original.text && !original.extraGraphics?.some(layer => layer.role === 'styledText'))) return original;
  const draft = structuredClone(original);
  for (const graphic of artworkGraphicLayers(draft).filter(layer => layer.visible !== false)) {
    if (graphic.rotation || graphic.inkSpread) continue;
    const image = await load(graphic.sourceUrl);
    const canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
    let left = image.width, top = image.height, right = -1, bottom = -1;
    // Almost invisible cutout residue must not turn back into layout whitespace.
    // Keep the original raster intact; an entirely faint graphic uses its full alpha.
    for (const threshold of [16, 1]) {
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (pixels[(y * image.width + x) * 4 + 3] >= threshold) {
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
      if (right >= left) break;
    }
    if (right < left) throw new Error('自动排版的图片图层没有可见内容');
    const previous = graphic.sourceBounds ?? { left: 0, top: 0, width: image.width, height: image.height };
    const width = right - left + 1, height = bottom - top + 1;
    graphic.width *= width / previous.width; graphic.height *= height / previous.height;
    graphic.sourceBounds = { left, top, width, height };
  }
  return draft;
}
export async function serverProductionTextColor(unit: ProductionUnit) {
  if (!unit.garment || !unit.placement) throw new Error('请先选择衣服与印花位置，以便自动选择字色');
  const anchor = taskPlacementAnchor(unit);
  const view = unit.garment.views.find(view => view.face === (unit.placement!.key === 'back' ? 'back' : 'front'))!;
  const image = await load(unit.garment.imageUrl.replace('/api/catalog/files/', '/api/production-files/'));
  const canvas = createCanvas(24, 24), context = canvas.getContext('2d');
  const size = Math.max(4, unit.garment.width * view.crop.width * .035);
  const centerX = (view.crop.x + anchor.centerX * view.crop.width) * unit.garment.width;
  const centerY = (view.crop.y + anchor.centerY * view.crop.height) * unit.garment.height;
  context.drawImage(image, centerX - size / 2, centerY - size / 2, size, size, 0, 0, 24, 24);
  const pixels = context.getImageData(0, 0, 24, 24).data;
  const channels: [number[], number[], number[]] = [[], [], []];
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] >= 200) channels.forEach((channel, index) => channel.push(pixels[i + index]));
  if (channels[0].length < 24) throw new Error('印花区域没有足够的衣服像素，请检查位置');
  return contrastingArtworkTextColor(channels.map(channel => channel.sort((a, b) => a - b)[Math.floor(channel.length / 2)]) as [number, number, number]);
}
export async function serverProductionTextDraft(unit: ProductionUnit, color: string) {
  const base = createLegacyArtworkDraft(createCanvas(1, 1).toDataURL('image/png'));
  base.graphic = { ...base.graphic, visible: false, label: '透明底', width: 1, height: 1 };
  const draft = addArtworkText(base, { x: 512, y: 512 }, color).draft;
  draft.mode = 'structured'; draft.layout.preset = 'custom';
  draft.text = { ...draft.text!, label: '准确文字', value: unit.exactText, fontFamily: DEFAULT_ARTWORK_FONT, fontSize: 96, boxWidth: 880, letterSpacing: 2, color,
    arc: inferredArtworkTextArc(`${unit.instruction}\n${unit.layoutNote}`, unit.exactText) };
  draft.preprocessing = { qualityScore: null, blurScore: null, enhancement: 'none', backgroundRemoval: 'none', processingRoute: 'fidelity', componentSummary: [`程序排版准确文字：${unit.exactText}`] };
  return draft;
}
