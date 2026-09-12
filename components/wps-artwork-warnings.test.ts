import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { sharedFixture } from '@/lib/testing/shared-artwork-fixture';
import { taskBArtwork } from '@/lib/testing/task-b-fixture';
import { buildArtworkReview, applyFinalArtworkReview, manualArtworkReview } from '@/lib/artwork-review-ledger';
import { WpsSharedArtworks } from './wps-shared-artworks';
import type { WpsProductionState } from '@/lib/wps-production';

function render(state: WpsProductionState) {
  return renderToStaticMarkup(createElement(WpsSharedArtworks, { state, recordId: state.records[0].source.recordId,
    busy: () => null, make: vi.fn(), edit: vi.fn(), preview: vi.fn(), action: vi.fn(), progress: () => '', error: () => '',
    feedback: () => undefined, refresh: vi.fn(), renderUnit: () => ({ requirements: '', artwork: 'INNER_CHECKLIST' }),
  }));
}
function fixture() {
  const state = sharedFixture(2, true);
  for (const [index, unit] of state.units.entries()) {
    unit.artwork = taskBArtwork(unit, (index ? 'c' : 'b').repeat(64));
    unit.artwork.validation.review = applyFinalArtworkReview(buildArtworkReview(unit, unit.artwork.validation), {
      version: 'artwork-edit-check-v1', outputSha256: unit.artwork.validation.sha256, sourceSha256: 'a'.repeat(64), model: 'offline-fixture',
      checks: [{ category: 'structure', status: index ? 'failed' : 'uncertain', requirement: '保留Logo', evidence: index ? '整块Logo丢失' : '注册标记需要人工核对' }],
    });
  }
  return state;
}
describe('B5 main shared artwork cards', () => {
  it('shows each actual current application’s issue before the collapsed checklist', () => {
    const state = fixture(), before = structuredClone(state), html = render(state);
    expect(html).toContain('整块Logo丢失');
    expect(html).toContain('注册标记需要人工核对');
    expect(html).toContain('发现不一致'); expect(html).toContain('存在疑点');
    expect(html.indexOf('整块Logo丢失')).toBeLessThan(html.indexOf('INNER_CHECKLIST'));
    expect(html).toContain('放大核对当前图稿');
    expect(html).toContain('这些提醒不妨碍编辑保存或人工确认');
    expect(state).toEqual(before);
  });
  it('suppresses only explicitly accepted current differences', () => {
    const state = fixture(), unit = state.units[1], review = unit.artwork!.validation.review!;
    unit.artwork!.validation.review = manualArtworkReview(review, review.items.map(item => item.id), 'accepted', '操作员', '客户接受此版差异');
    const html = render(state);
    expect(html).not.toContain('整块Logo丢失');
    expect(html).toContain('注册标记需要人工核对');
  });
  it('shows a new failed attempt together with the retained current artwork, not a false save/pass', () => {
    const state = fixture();
    state.units[0].error = '本次制作服务失败';
    const html = render(state);
    expect(html).toContain('本次制作未完成'); expect(html).toContain('本次制作服务失败');
    expect(html).toContain('/uploads/logos/task-b-synthetic.png');
    expect(html).toContain('注册标记需要人工核对');
  });
});
