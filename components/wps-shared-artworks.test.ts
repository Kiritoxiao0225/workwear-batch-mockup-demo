import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { detachSharedArtwork } from '@/lib/shared-artwork';
import { sharedFixture } from '@/lib/testing/shared-artwork-fixture';
import type { WpsProductionState } from '@/lib/wps-production';
import { WpsSharedArtworks } from './wps-shared-artworks';

function render(state: WpsProductionState) {
  return renderToStaticMarkup(createElement(WpsSharedArtworks, {
    state, recordId: state.records[0].source.recordId,
    busy: () => null, make: vi.fn(), edit: vi.fn(), preview: vi.fn(), action: vi.fn(),
    progress: () => '', error: () => '', feedback: () => undefined, refresh: vi.fn(),
    renderUnit: unit => ({ requirements: unit.instruction, artwork: `制作${unit.id}` }),
  }));
}

describe('artwork sharing shown by actual applications', () => {
  it('shows legacy single-location artwork as independent without rewriting stored identity', () => {
    const state = sharedFixture(1, true), before = structuredClone(state);
    const html = render(state);
    expect(html).toContain('单独制作');
    expect(html).toContain('制作左胸图案');
    expect(html).toContain('仅用于此位置');
    expect(html).not.toContain('共用');
    expect(html).not.toContain('应用到 1 件衣服');
    expect(state).toEqual(before);
  });

  it('keeps chest logo and back text in separate single-location cards', () => {
    const state = sharedFixture(2, true);
    state.units[1].sharedArtworkId = 'separate-back-text';
    state.units[1].placement = { ...state.units[1].placement!, key: 'back' };
    state.units[1].instruction = '后背制作文字“逛康美烁，可美可省钱”。';
    state.sharedArtworks = [];
    const html = render(state);
    expect(html).toContain('制作左胸图案');
    expect(html).toContain('制作后背居中图案');
    expect(html.match(/单独制作/g)).toHaveLength(2);
    expect(html).not.toContain('共用');
  });

  it('updates the remaining source display after another application is detached', () => {
    const state = detachSharedArtwork(sharedFixture(2, true), 'shared-u2');
    const before = structuredClone(state), html = render(state);
    expect(html).toContain('制作左胸图案');
    expect(html).not.toContain('共用');
    expect(state).toEqual(before);
  });

  it('retains the shared controls for a source used by eight garments', () => {
    const html = render(sharedFixture(8, true));
    expect(html).toContain('8 处共用');
    expect(html).toContain('制作共用稿');
    expect(html).toContain('共 8 处，制作一次后自动应用');
  });
});
