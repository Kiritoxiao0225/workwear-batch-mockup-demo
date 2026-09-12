import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { taskBFixture } from '@/lib/testing/task-b-fixture';
import { WpsSharedArtworks } from './wps-shared-artworks';

function fixture(shared: boolean, widthKnown: boolean) {
  const { state, unit, source, version } = taskBFixture(false);
  state.units = [unit]; state.mockupVersions = [version]; state.sharedArtworks = [];
  delete unit.sharedArtworkId;
  if (!widthKnown) unit.garment!.views.forEach(view => { delete view.bodyScale; });
  if (shared) {
    unit.sharedArtworkId = 'readiness-test-group';
    state.sharedArtworks = [{ id: unit.sharedArtworkId, sourceRecordId: unit.sourceRecordId, sourceUnitId: unit.id, unitIds: [unit.id], versions: [] }];
  }
  const before = structuredClone(state), make = vi.fn(), action = vi.fn();
  const html = renderToStaticMarkup(createElement(WpsSharedArtworks, {
    state, recordId: source.recordId, busy: () => null, make, edit: vi.fn(), preview: vi.fn(), action,
    progress: () => '', error: () => '', feedback: () => undefined, refresh: async () => {},
    renderUnit: () => ({ requirements: null, artwork: createElement('button', { onClick: make }, '制作左胸图案') }),
  }));
  return { html, state, before, make, action };
}

describe('standalone and shared unmade artwork cards within the shared panel', () => {
  it.each([false, true])('shows missing torso evidence before making, shared=%s', shared => {
    const t = fixture(shared, false);
    expect(t.html).toContain('上衣暂不可用'); expect(t.html).toContain('独立图案仍可制作');
    expect(t.html).toContain('打开该款色核对衣身宽度与位置'); expect(t.html).toContain('assetVersionId=');
    expect(t.html).toContain('制作左胸图案'); expect(t.make).not.toHaveBeenCalled(); expect(t.action).not.toHaveBeenCalled();
    expect(t.state).toEqual(t.before);
  });
  it.each([false, true])('uses the same temporary position notice with genuine torso width, shared=%s', shared => {
    const t = fixture(shared, true);
    expect(t.html).toContain('使用临时预览位置'); expect(t.html).toContain('尚未人工确认'); expect(t.html).not.toContain('上衣暂不可用');
    expect(t.state).toEqual(t.before);
  });
});
