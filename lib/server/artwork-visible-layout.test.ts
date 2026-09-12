import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { createStructuredArtworkDraft, type ArtworkDraft } from '@/lib/artwork-editor';
import { fitArtworkForPrint } from '@/lib/production-artwork-layout';
import { prepareServerPrintedArtwork, serverArtworkTextLayout, visibleAutomaticArtwork } from './render-artwork';
import type { ProductionPlacement } from '@/lib/wps-production';

const placement: ProductionPlacement = { key: 'leftChest', sizeMode: 'widthCm', widthCm: 7, offsetX: 0, offsetY: 0, rotation: 0, templateVersion: 'catalog-v1' };
function paddedDraft() {
  const canvas = createCanvas(800, 1000), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#00a6b8'; ctx.fillRect(200, 100, 400, 300);
  ctx.fillStyle = 'rgba(0,0,0,0.01)'; ctx.fillRect(1, 950, 1, 1);
  return createStructuredArtworkDraft({ graphicSourceUrl: canvas.toDataURL('image/png'), graphicWidth: 800, graphicHeight: 1000,
    exactText: '康悦', instruction: '图上字下', layoutNote: '', enhancement: 'none', backgroundRemoval: 'general' });
}
describe('visible artwork spacing', () => {
  // Two complete PNG renders exceed the default 5 seconds on the Linux CI runner.
  it('spaces ordinary lettering from visible Logo edges and keeps the source pixels unchanged', async () => {
    const before = paddedDraft();
    const fitted = await prepareServerPrintedArtwork(before, { placement });
    expect(fitted.draft.graphic.sourceUrl).toBe(before.graphic.sourceUrl);
    expect(fitted.draft.graphic.sourceBounds).toEqual({ left: 200, top: 100, width: 400, height: 300 });
    const text = serverArtworkTextLayout(fitted.draft.text!).bounds;
    const bottom = fitted.draft.graphic.y + fitted.draft.graphic.height / 2;
    expect(text.top - bottom).toBeCloseTo(32);
    const twice = await prepareServerPrintedArtwork(fitted.draft, { placement: fitted.placement });
    expect(twice.draft).toEqual(fitted.draft);
    expect(before.graphic.sourceBounds).toBeUndefined();
  }, 20_000);
  it('leaves manually positioned and flattened artwork untouched', async () => {
    for (const draft of [{ ...paddedDraft(), layout: { preset: 'custom', gap: 40, groupAlign: 'center' } },
      { ...paddedDraft(), mode: 'legacyFlattened' }] as ArtworkDraft[]) {
      expect(await visibleAutomaticArtwork(draft)).toBe(draft);
    }
  });
  it('arranges styled lettering by visible size in both directions without shrinking it to an equal-slot thumbnail', () => {
    for (const preset of ['vertical', 'verticalReverse', 'horizontal', 'horizontalReverse'] as const) {
      const draft = paddedDraft(); draft.text = null; draft.layout.preset = preset;
      const vertical = preset.startsWith('vertical'), reverse = preset.endsWith('Reverse');
      draft.graphic = { ...draft.graphic, x: reverse ? 680 : 340, y: reverse ? 680 : 340, width: 400, height: 300 };
      draft.extraGraphics = [{ ...draft.graphic, id: 'text-1', role: 'styledText', textValue: '康悦', x: reverse ? 340 : 680, y: reverse ? 340 : 680, width: 200, height: 90 }];
      const result = fitArtworkForPrint(draft, placement, serverArtworkTextLayout);
      const g = result.draft.graphic, t = result.draft.extraGraphics![0];
      const gap = vertical ? Math.abs(t.y - g.y) - (t.height + g.height) / 2 : Math.abs(t.x - g.x) - (t.width + g.width) / 2;
      expect(gap).toBeCloseTo(32);
      expect(t.height).toBeCloseTo(130);
      expect(vertical ? t.y < g.y : t.x < g.x).toBe(reverse);
      expect(result.needsReview).toBe(true);
      expect(fitArtworkForPrint(result.draft, placement, serverArtworkTextLayout).draft).toEqual(result.draft);
    }
  });
});
