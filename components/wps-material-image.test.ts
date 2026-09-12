import { type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WpsMaterialImage } from './wps-material-image';
import { WpsPreviewBackgroundControls } from './wps-preview-background';
import { imageFailureReason } from '@/lib/client/api-response';

// Handler/hook unit harness, not a DOM renderer. Real React markup and full
// dialog semantics are covered separately by wps-image-preview-dialog.test.ts.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effectCursor: 0,
  effects: [] as Array<{ deps?: readonly unknown[]; cleanup?: () => void }>, pending: [] as Array<() => void>, pixels: [255, 255, 255, 255] }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState<T>(initial: T | (() => T)) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [hooks.values[index] as T, (value: T | ((old: T) => T)) => {
      hooks.values[index] = typeof value === 'function' ? (value as (old: T) => T)(hooks.values[index] as T) : value;
    }] as const;
  },
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
    const index = hooks.effectCursor++, old = hooks.effects[index];
    if (old && deps && old.deps && deps.length === old.deps.length && deps.every((value, i) => Object.is(value, old.deps![i]))) return;
    old?.cleanup?.();
    hooks.effects[index] = { deps };
    hooks.pending.push(() => { const cleanup = effect(); if (typeof cleanup === 'function') hooks.effects[index].cleanup = cleanup; });
  },
}));
vi.mock('@/lib/client/api-response', () => ({ imageFailureReason: vi.fn(async () => '离线图片不可读') }));
type Node = ReactElement<Record<string, unknown>>;
function find(node: unknown, predicate: (node: Node) => boolean): Node | undefined {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) { const match = find(child, predicate); if (match) return match; } return; }
  const element = node as Node;
  if (!element.props) return;
  return predicate(element) ? element : find(element.props.children, predicate);
}
function render(props: Parameters<typeof WpsMaterialImage>[0]) {
  hooks.cursor = hooks.effectCursor = 0;
  const wrapper = WpsMaterialImage(props);
  const tree = (wrapper.type as (props: typeof wrapper.props) => Node)(wrapper.props);
  for (const effect of hooks.pending.splice(0)) effect();
  return tree;
}
const image = (tree: Node) => find(tree, node => typeof node.props.src === 'string')!;
const button = (tree: Node) => find(tree, node => node.type === 'button' && String(node.props.className).includes('wps-material-image'))!;
const call = (node: Node, name: string, ...args: unknown[]) => (node.props[name] as (...args: unknown[]) => void)(...args);
const props = { src: '/api/production-files/00000000-0000-4000-8000-000000000099', alt: '原始大图', sizes: '90vw', large: true, viewingBackground: true };
const cleanup = () => { for (const effect of hooks.effects) effect.cleanup?.(); };
beforeEach(() => {
  hooks.values = []; hooks.effects = []; hooks.pending = []; hooks.cursor = hooks.effectCursor = 0;
  vi.clearAllMocks(); vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.stubGlobal('document', { createElement: vi.fn(() => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn(), getImageData: () => ({ data: hooks.pixels }) }) })) });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('B6 original image background and retry lifecycle', () => {
  it.each([
    ['白字', [255, 255, 255, 255, 0, 0, 0, 0], 'dark'],
    ['黑字', [0, 0, 0, 255, 255, 255, 255, 0], 'light'],
    ['多色明暗混合', [255, 255, 255, 255, 0, 0, 0, 255], 'gray'],
    ['全透明', [255, 255, 255, 0], 'gray'],
  ] as const)('%s changes only viewing CSS; original pixels/URL remain untouched', (_label, pixels, selected) => {
    hooks.pixels = [...pixels]; const originalPixels = [...pixels];
    let tree = render(props);
    call(image(tree), 'onLoad', { currentTarget: { naturalWidth: 4096, naturalHeight: 2048 } });
    tree = render(props);
    expect(button(tree).props['data-preview-background']).toBe(selected);
    expect(image(tree).props.src).toBe(props.src);
    expect(image(tree).props.unoptimized).toBe(true);
    expect(hooks.pixels).toEqual(originalPixels);
    expect(imageFailureReason).not.toHaveBeenCalled();
    const controls = find(tree, node => node.type === WpsPreviewBackgroundControls)!;
    const swatches = WpsPreviewBackgroundControls(controls.props as Parameters<typeof WpsPreviewBackgroundControls>[0]);
    const dark = find(swatches, node => node.props['aria-label'] === '深底')!;
    call(dark, 'onClick'); tree = render(props);
    expect(button(tree).props['data-preview-background']).toBe('dark');
    expect(image(tree).props.src).toBe(props.src);
    expect(find(button(tree), node => node.type === WpsPreviewBackgroundControls)).toBeUndefined();
  });
  it('handles CORS-unreadable originals with manual backgrounds instead of replacing the image', () => {
    vi.stubGlobal('document', { createElement: () => { throw new Error('canvas not readable'); } });
    let tree = render(props);
    call(image(tree), 'onLoad', { currentTarget: { naturalWidth: 600, naturalHeight: 600 } }); tree = render(props);
    expect(button(tree).props['data-preview-background']).toBe('gray');
    expect(image(tree).props.src).toBe(props.src);
  });
  it('keeps customer images on their own background and does not sample them', () => {
    const customer = { ...props, viewingBackground: false };
    let tree = render(customer); call(image(tree), 'onLoad', {}); tree = render(customer);
    expect(button(tree).props.style).toBeUndefined();
    expect(document.createElement).not.toHaveBeenCalled();
    expect(find(tree, node => node.type === WpsPreviewBackgroundControls)).toBeUndefined();
  });
  it('retries failed originals three times, exposes the reason, and permits a fresh manual retry', async () => {
    let tree = render(props);
    for (const delay of [1000, 2000, 4000]) {
      call(image(tree), 'onError'); tree = render(props);
      expect(button(tree).props['data-load-state']).toBe('waiting');
      vi.advanceTimersByTime(delay); tree = render(props);
      expect(image(tree).props.src).toContain('_imageRetry=');
      expect(image(tree).props.src).not.toContain('thumbnail');
    }
    call(image(tree), 'onError'); tree = render(props);
    await Promise.resolve(); tree = render(props);
    expect(button(tree).props['data-load-state']).toBe('failed');
    expect(button(tree).props.title).toContain('离线图片不可读');
    expect(imageFailureReason).toHaveBeenCalledWith(props.src, expect.any(AbortSignal));
    call(button(tree), 'onClick'); tree = render(props);
    expect(button(tree).props['data-load-state']).toBe('loading');
    expect(image(tree).props.src).toContain('_imageRetry=');
  });
  it('never appends retry parameters to signed external originals, and cancels pending retry on close', () => {
    const signed = { ...props, src: 'https://fixture.invalid/original.png?signature=offline-fixture' };
    let tree = render(signed); call(image(tree), 'onError'); tree = render(signed);
    vi.advanceTimersByTime(1000); tree = render(signed);
    expect(image(tree).props.src).toBe(signed.src);
    call(image(tree), 'onError'); render(signed);
    const before = structuredClone(hooks.values);
    cleanup(); vi.advanceTimersByTime(8000);
    expect(hooks.values).toEqual(before);
  });
  it('keys a changed source separately so stale loading state cannot carry to another original', () => {
    expect(WpsMaterialImage(props).key).toBe(props.src);
    expect(WpsMaterialImage({ ...props, src: '/new-original.png' }).key).toBe('/new-original.png');
  });
});
