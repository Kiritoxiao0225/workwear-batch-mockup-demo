import { createElement, useEffect, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WpsImagePreviewDialog } from './wps-image-preview-dialog';
import { WpsMaterialImage } from './wps-material-image';

// Server markup checks use real React. Direct event tests capture only the
// dialog's effect registration, without claiming a browser rendering test.
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useEffect: vi.fn() }));
beforeEach(() => vi.mocked(useEffect).mockClear());
type Node = ReactElement<{ children?: Node | Node[]; onMouseDown?: (event: { target: unknown; currentTarget: unknown }) => void; onClick?: () => void }>;
function children(node: Node): Node[] { return [node.props.children].flat().filter(Boolean) as Node[]; }
describe('B6 full-resolution view-only dialog', () => {
  it.each(['原图', '白色图稿', '处理候选'])('%s offers all four backgrounds without a thumbnail source', title => {
    const original = '/api/production-files/00000000-0000-4000-8000-000000000099?download=original';
    const html = renderToStaticMarkup(createElement(WpsImagePreviewDialog, { url: original, title, close: vi.fn() }));
    for (const label of ['自动', '浅底', '深底', '棋盘格']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`src="${original}"`);
    expect(html).not.toContain('thumbnail');
    expect(html).toContain('仅改变查看底色，不改变原图');
  });
  it('does not expose background controls on a customer composite', () => {
    const html = renderToStaticMarkup(createElement(WpsImagePreviewDialog, { url: '/customer.png', title: '成品', customer: true, close: vi.fn() }));
    expect(html).toContain('customer-preview'); expect(html).toContain('/customer.png');
    expect(html).not.toContain('aria-label="深底"');
    expect(html).not.toContain('data-preview-background');
  });
  it('keeps a small image thumbnail separate from the original enlarged source', () => {
    const url = '/api/production-files/00000000-0000-4000-8000-000000000099';
    const small = renderToStaticMarkup(createElement(WpsMaterialImage, { src: url, alt: '缩略', sizes: '70px' }));
    const large = renderToStaticMarkup(createElement(WpsMaterialImage, { src: url, alt: '原图', sizes: '90vw', large: true, viewingBackground: true }));
    expect(small).not.toContain(`src="${url}"`);
    expect(large).toContain(`src="${url}"`);
  });
  it('closes only via Escape, the outer backdrop or explicit close, and removes the listener', () => {
    const close = vi.fn(), add = vi.fn(), remove = vi.fn();
    vi.stubGlobal('window', { addEventListener: add, removeEventListener: remove });
    try {
      const tree = WpsImagePreviewDialog({ url: '/original.png', title: '原图', close }) as Node;
      const effect = vi.mocked(useEffect).mock.calls[0][0], cleanup = effect();
      const escape = add.mock.calls[0][1] as (event: { key: string }) => void;
      escape({ key: 'Enter' }); expect(close).not.toHaveBeenCalled();
      escape({ key: 'Escape' }); expect(close).toHaveBeenCalledTimes(1);
      const target = {};
      tree.props.onMouseDown!({ target: {}, currentTarget: target }); expect(close).toHaveBeenCalledTimes(1);
      tree.props.onMouseDown!({ target, currentTarget: target }); expect(close).toHaveBeenCalledTimes(2);
      const dialog = children(tree)[0], header = children(dialog)[0], button = children(header)[1];
      button.props.onClick!(); expect(close).toHaveBeenCalledTimes(3);
      if (typeof cleanup === 'function') cleanup();
      expect(remove).toHaveBeenCalledWith('keydown', escape);
    } finally { vi.unstubAllGlobals(); }
  });
});
