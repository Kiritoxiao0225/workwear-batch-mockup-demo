import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { CutoutTaskStatus, type CutoutSession } from './wps-cutout-controls';

function render(purpose: CutoutSession['purpose'], status: CutoutSession['result']['status'] = 'completed', stale = false, hasArtwork = true) {
  const session: CutoutSession = { purpose, snapshot: '{}', stale, result: { status, url: '/result.png', receipt: {
    jobKey: 'a'.repeat(64), route: 'meitu', mode: 'auto', version: 'artwork-cutout-v3', reasons: [], sourceSha256: 'source', sourceUrl: '/source.png', actualCredits: 1, estimatedCredits: 1, cacheHit: false,
  } } };
  return renderToStaticMarkup(createElement(CutoutTaskStatus, { session, busy: false, hasArtwork, query: vi.fn(), retry: vi.fn(), apply: vi.fn(), discard: vi.fn() }));
}
it('does not describe an interrupted component as a second complete artwork to select', () => {
  const html = render('component');
  expect(html).toContain('抠图已完成，图案制作未完成');
  expect(html).toContain('同一次抠图结果');
  expect(html).toContain('下载抠图素材');
  expect(html).toContain('关闭这条提示');
  expect(html).not.toContain('使用这版抠图');
  expect(html).not.toContain('保留当前版本');
});
it('keeps explicit replacement for a current recut candidate', () => {
  expect(render('recut')).toContain('使用这版抠图');
  expect(render('recut')).toContain('保留当前版本');
});
it('does not offer to retain a current artwork when none exists', () => {
  const html = render('generated', 'completed', false, false);
  expect(html).toContain('保存为当前图案');
  expect(html).not.toContain('保留当前版本');
});
it.each(['pending', 'unknown'] as const)('provides query only for an unresolved %s task', status => {
  const html = render('component', status);
  expect(html).toContain('查询本次结果');
  expect(html).not.toContain('重试抠图');
  expect(html).not.toContain('关闭这条提示');
});
it('permits inspecting stale results without an apply or retry action', () => {
  const html = render('recut', 'completed', true);
  expect(html).toContain('图案、要求或状态已变化');
  expect(html).toContain('下载抠图素材');
  expect(html).not.toContain('使用这版抠图');
  expect(render('component', 'failed', true)).not.toContain('重试抠图');
});
