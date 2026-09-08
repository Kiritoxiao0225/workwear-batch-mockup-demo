import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLegacyArtworkDraft } from '@/lib/artwork-editor';

class TestImage {
  static created: TestImage[] = [];
  src = '';
  crossOrigin = '';
  naturalWidth = 100;
  naturalHeight = 100;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { TestImage.created.push(this); }
}
const file = (index: number) => `/api/production-files/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
beforeEach(() => { vi.resetModules(); TestImage.created = []; vi.stubGlobal('Image', TestImage); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shares a pending immutable image and its loaded image, while new files remain separate', async () => {
  const { loadArtworkImage } = await import('./render-artwork');
  const first = loadArtworkImage(file(1)), second = loadArtworkImage(file(1));
  expect(second).toBe(first); expect(TestImage.created).toHaveLength(1);
  TestImage.created[0].onload!();
  expect(await first).toBe(await loadArtworkImage(file(1)));
  const changed = loadArtworkImage(file(2));
  expect(TestImage.created).toHaveLength(2);
  TestImage.created[1].onload!(); await changed;
});

it('retries failed loads and expires retained images after five minutes', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const { loadArtworkImage } = await import('./render-artwork');
  const failed = loadArtworkImage(file(1));
  TestImage.created[0].onerror!(); await expect(failed).rejects.toThrow('图形图层加载失败');
  const retry = loadArtworkImage(file(1)); TestImage.created[1].onload!(); await retry;
  now.mockReturnValue(301001);
  const expired = loadArtworkImage(file(1));
  expect(TestImage.created).toHaveLength(3);
  TestImage.created[2].onload!(); await expired;
});

it('does not retain mutable, external or browser-only URLs', async () => {
  const { loadArtworkImage } = await import('./render-artwork');
  for (const url of ['/uploads/logos/editable.png', 'https://example.test/image.png', 'data:image/png;base64,AA==', 'blob:temporary']) {
    const first = loadArtworkImage(url), a = TestImage.created.at(-1)!; a.onload!(); await first;
    const second = loadArtworkImage(url), b = TestImage.created.at(-1)!;
    expect(a).not.toBe(b); b.onload!(); await second;
    if (url.startsWith('https:')) expect(b.crossOrigin).toBe('anonymous');
  }
});

it('limits retained decoded pixels and evicts least recently used images', async () => {
  const { loadArtworkImage } = await import('./render-artwork');
  for (let index = 1; index <= 3; index++) {
    const pending = loadArtworkImage(file(index)), image = TestImage.created.at(-1)!;
    image.naturalWidth = 2000; image.naturalHeight = 2000; image.onload!(); await pending;
  }
  expect(await loadArtworkImage(file(2))).toBe(TestImage.created[1]);
  const evicted = loadArtworkImage(file(1));
  expect(TestImage.created).toHaveLength(4);
  TestImage.created[3].onload!(); await evicted;
});

it('preloads only visible layer inputs with two downloads at a time and shares an in-flight open', async () => {
  const { preloadArtworkDraft, loadArtworkImage } = await import('./render-artwork');
  const draft = createLegacyArtworkDraft(file(1));
  draft.graphic.recolorMaskUrl = file(90);
  draft.extraGraphics = [2,3,4].map(index => ({ ...draft.graphic, id: `layer-${index}`, sourceUrl: file(index), visible: index !== 4 }));
  preloadArtworkDraft(draft); preloadArtworkDraft(draft);
  expect(TestImage.created.map(image => image.src)).toEqual([file(1),file(2)]);
  const opened = loadArtworkImage(file(1));
  expect(TestImage.created).toHaveLength(2);
  TestImage.created[0].onload!(); await opened;
  await vi.waitFor(() => expect(TestImage.created).toHaveLength(3));
  expect(TestImage.created[2].src).toBe(file(3));
  TestImage.created[1].onload!(); TestImage.created[2].onload!();
});

it('prepares the mask only when the current color needs it', async () => {
  const { preloadArtworkDraft } = await import('./render-artwork');
  const draft = createLegacyArtworkDraft(file(1));
  draft.graphic.recolor = { mode: 'solid', color: '#123456' };
  draft.graphic.recolorMaskUrl = file(2);
  preloadArtworkDraft(draft);
  expect(TestImage.created.map(image => image.src)).toEqual([file(1), file(2)]);
  TestImage.created.forEach(image => image.onload!());
});
