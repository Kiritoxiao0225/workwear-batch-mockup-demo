import { describe, expect, it } from 'vitest';
import { artworkPreviewTone } from './artwork-preview-background';

describe('artwork preview contrast', () => {
  it('shows white and pale colored ink on dark gray', () => {
    expect(artworkPreviewTone([255, 255, 255, 255, 245, 220, 190, 255])).toBe('dark');
  });
  it('shows black and navy ink on a light background', () => {
    expect(artworkPreviewTone([0, 0, 0, 255, 25, 38, 65, 255])).toBe('light');
  });
  it('keeps both black and white parts visible', () => {
    expect(artworkPreviewTone([255, 255, 255, 255, 0, 0, 0, 255])).toBe('gray');
  });
  it('ignores transparent padding RGB around sparse white lettering', () => {
    const pixels = new Uint8ClampedArray(40004);
    pixels.set([255, 255, 255, 255], 40000);
    expect(artworkPreviewTone(pixels)).toBe('dark');
  });
  it('weights soft edges without letting almost invisible dark pixels dominate', () => {
    const pixels = Array.from({ length: 100 }, () => [0, 0, 0, 2]).flat();
    pixels.push(255, 255, 255, 128);
    expect(artworkPreviewTone(pixels)).toBe('dark');
  });
  it('uses neutral gray when there is no visible artwork', () => {
    expect(artworkPreviewTone([255, 255, 255, 0])).toBe('gray');
    expect(artworkPreviewTone([])).toBe('gray');
  });
});
