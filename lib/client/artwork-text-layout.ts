'use client';
import type { ArtworkTextLayer } from '@/lib/artwork-editor';
import { artworkTextFont, measureArtworkText } from '@/lib/artwork-text-metrics';
export { artworkTextFont } from '@/lib/artwork-text-metrics';
export async function loadArtworkFont(text: ArtworkTextLayer) {
  const loaded = await document.fonts.load(artworkTextFont(text), text.value);
  if (text.fontFamily.startsWith('Douyin Sans') && !loaded.length) throw new Error('抖音美好体加载失败，请重试');
}
export function artworkTextLayout(text: ArtworkTextLayer) {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) throw new Error('文字测量画布不可用');
  return measureArtworkText(text, context);
}
