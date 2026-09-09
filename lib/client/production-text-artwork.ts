'use client';
import { contrastingArtworkTextColor, DEFAULT_ARTWORK_FONT } from '@/lib/artwork-text-defaults';
import { createLegacyArtworkDraft, requestedArtworkColor, type ArtworkDraft } from '@/lib/artwork-editor';
import { addArtworkText } from '@/lib/artwork-layers';
import { taskPlacementAnchor } from '@/lib/production-preview';
import type { ProductionUnit } from '@/lib/wps-production';
import { loadArtworkImage } from './render-artwork';

/** Sample the actual garment at this print position, excluding transparent pixels. */
export async function productionTextColor(unit: ProductionUnit) {
  if (!unit.garment || !unit.placement) throw new Error('请先选择衣服与印花位置，以便自动选择字色');
  const anchor = taskPlacementAnchor(unit);
  const view = unit.garment.views.find(view => view.face === (unit.placement!.key === 'back' ? 'back' : 'front'))!;
  // The catalog URL redirects to OSS; the existing production file route serves
  // the same immutable file through the authenticated origin for canvas reads.
  const image = await loadArtworkImage(unit.garment.imageUrl.replace('/api/catalog/files/', '/api/production-files/'));
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 24;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('衣服取色画布不可用');
  const size = Math.max(4, unit.garment.width * view.crop.width * .035);
  const centerX = (view.crop.x + anchor.centerX * view.crop.width) * unit.garment.width;
  const centerY = (view.crop.y + anchor.centerY * view.crop.height) * unit.garment.height;
  context.drawImage(image, centerX - size / 2, centerY - size / 2, size, size, 0, 0, 24, 24);
  const pixels = context.getImageData(0, 0, 24, 24).data;
  const channels: [number[], number[], number[]] = [[], [], []];
  for (let offset = 0; offset < pixels.length; offset += 4) if (pixels[offset + 3] >= 200) {
    channels.forEach((channel, index) => channel.push(pixels[offset + index]));
  }
  if (channels[0].length < 24) throw new Error('印花区域没有足够的衣服像素，请检查位置');
  const median = channels.map(channel => channel.sort((a, b) => a - b)[Math.floor(channel.length / 2)]) as [number, number, number];
  return contrastingArtworkTextColor(median);
}

export async function createProductionTextDraft(unit: ProductionUnit, color: string): Promise<ArtworkDraft> {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const base = createLegacyArtworkDraft(canvas.toDataURL('image/png'));
  base.graphic = { ...base.graphic, visible: false, label: '透明底', width: 1, height: 1 };
  const draft = addArtworkText(base, { x: 512, y: 512 }, color).draft;
  draft.mode = 'structured'; draft.layout.preset = 'custom';
  draft.text = { ...draft.text!, label: '准确文字', value: unit.exactText, fontFamily: DEFAULT_ARTWORK_FONT,
    fontSize: 96, boxWidth: 880, letterSpacing: 2, color };
  draft.preprocessing = { qualityScore: null, blurScore: null, enhancement: 'none', backgroundRemoval: 'none',
    processingRoute: 'fidelity', componentSummary: [`程序排版准确文字：${unit.exactText}`] };
  return draft;
}

/** Only explicit ink instructions count; garment labels and the printed words are not ink requests. */
export function requestedProductionTextColor(unit: Pick<ProductionUnit, 'exactText' | 'instruction' | 'layoutNote'>) {
  const text = `${unit.layoutNote}\n${unit.instruction}`.replaceAll(unit.exactText, '');
  const tokens = '(#[0-9a-fA-F]{6}|深蓝|藏蓝|大红|玫红|绿色|蓝色|金色|黄色|橙色|粉色|紫色|灰色|红色|黑色|白色|红|黑|白)';
  for (const clause of text.split(/[。；;\n]/u)) {
    const match = clause.match(new RegExp(`(?:文字颜色|字体颜色|文字|字色|颜色|印花|字)[ \t]*(?:(?:用|使用|为|设为|改为|改成|做成|做|是|[:：])[ \t]*){0,3}${tokens}`, 'u'))
      ?? clause.match(new RegExp(`${tokens}(?:的)?(?:文字|字)`, 'u'));
    if (!match) continue;
    const value = match[1];
    if (['黑', '黑色'].includes(value)) return '#000000';
    if (['白', '白色'].includes(value)) return '#ffffff';
    if (['红', '红色'].includes(value)) return '#ff0000';
    return requestedArtworkColor(value);
  }
  return null;
}
