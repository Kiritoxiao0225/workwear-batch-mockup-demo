import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WpsPlacementEditor } from '@/components/wps-placement-editor';
import { garmentFixture } from '@/lib/testing/production-garment-fixture';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { attachProductionArtwork, emptyWpsProductionState, importTaskReviews } from '@/lib/wps-production';

it('renders both faces using their own pinned and newly adopted body widths', () => {
  const review = taskReviewFixture()[2];
  review.units.forEach(unit => { unit.garment = garmentFixture(); });
  let state = importTaskReviews(emptyWpsProductionState(), [review]);
  for (const [index, unit] of state.units.entries()) state = attachProductionArtwork(state, unit.id, {
    url: `/uploads/logos/face-${index}.png`, name: 'logo.png', service: 'manual-upload', requestSummary: 'isolated render',
    validation: { valid: true, mimeType: 'image/png', width: 100, height: 100, byteLength: 100, sha256: 'a'.repeat(64),
      transparentPixelRatio: .5, visiblePixelRatio: .5, checkedAt: '2026-09-11T00:00:00Z', ruleVersion: 'transparent-artwork-v1', issues: [] },
  }, `face-${index}`);
  for (const unit of state.units) {
    const face = unit.placement!.key === 'back' ? 'back' : 'front';
    unit.garment!.views.forEach(view => {
      view.standard = null;
      if (view.face === face) view.bodyScale = { widthRatio: face === 'front' ? .45 : .65, basis: 'confirmed-armpits' };
      else delete view.bodyScale;
    });
  }
  const html = renderToStaticMarkup(createElement(WpsPlacementEditor, {
    unit: state.units[0], versionUnits: state.units, busy: false, error: null, edit: () => {}, close: () => {}, save: async () => {},
  }));
  expect(html).toContain('href="/uploads/logos/face-0.png"');
  expect(html).toContain('href="/uploads/logos/face-1.png"');
});
