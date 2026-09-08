'use client';
import { artworkTextLayers, type ArtworkDraft } from '@/lib/artwork-editor';
import { fitArtworkForPrint } from '@/lib/production-artwork-layout';
import type { ProductionUnit } from '@/lib/wps-production';
import { artworkTextLayout, loadArtworkFont } from './artwork-text-layout';
import { renderArtworkPreview } from './render-artwork';
import { printedTextHeights } from '@/lib/production-legibility';
import { printSizeCm } from '@/lib/production-sizing';

export async function preparePrintedArtwork(draft: ArtworkDraft, unit: Pick<ProductionUnit, 'placement'>) {
  if (!unit.placement) return { draft, automaticWidthCm: undefined, needsReview: true, summary: '缺少印花位置，无法自动确定图文字高。' };
  await Promise.all(artworkTextLayers(draft).map(loadArtworkFont));
  const fitted = fitArtworkForPrint(draft, unit.placement, artworkTextLayout);
  if (fitted.needsReview) return fitted;
  // Verify the actual exported pixels, rather than trusting layout estimates alone.
  const preview = await renderArtworkPreview(fitted.draft);
  const size = printSizeCm(fitted.placement, preview.contentBounds.width / preview.contentBounds.height);
  const heights = printedTextHeights(preview.letters, preview.contentBounds.height, size.height);
  if (heights.some(group => group.small)) return { ...fitted, needsReview: true, summary: '自动排版后的实际 PNG 小字仍低于提醒线，请核对该图案。' };
  return { ...fitted, summary: `已自动安排图文大小：整组 ${size.width.toFixed(1)} × ${size.height.toFixed(1)} cm；${heights.map(group => `${group.name}字高约 ${group.heightCm.toFixed(2)} cm`).join('，')}。` };
}
