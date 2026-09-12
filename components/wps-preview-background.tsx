'use client';

import { useState } from 'react';
import { artworkPreviewTone, type ArtworkPreviewTone } from '@/lib/artwork-preview-background';

export type PreviewBackground = 'auto' | 'light' | 'dark' | 'checker';
const backgrounds = { light: '#f5f5f5', dark: '#333333', gray: '#808080', checker: 'conic-gradient(#dce1dc 25%, #fff 0 50%, #dce1dc 0 75%, #fff 0) 0 0 / 16px 16px' };
const options = [['auto', '自动'], ['light', '浅底'], ['dark', '深底'], ['checker', '棋盘格']] as const;

/** Sampling chooses a CSS background only. It never replaces the displayed image
 * with a canvas, changes its bytes, saves layers, or calls a model. */
export function usePreviewBackground() {
  const [background, setBackground] = useState<PreviewBackground>('auto');
  const [tone, setTone] = useState<ArtworkPreviewTone>('gray');
  const selected = background === 'auto' ? tone : background;
  function inspect(image: HTMLImageElement) {
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 192 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      setTone(artworkPreviewTone(context.getImageData(0, 0, canvas.width, canvas.height).data));
    } catch {
      // Signed external originals remain viewable even without readable CORS pixels.
      setTone('gray');
    }
  }
  return { background, setBackground, selected, cssBackground: backgrounds[selected], inspect };
}

export function WpsPreviewBackgroundControls({ alt, value, onChange }: {
  alt: string; value: PreviewBackground; onChange: (background: PreviewBackground) => void;
}) {
  return <div className="wps-artwork-preview-backgrounds" role="group" aria-label={`${alt}的预览底色`}>
    {options.map(([background, label]) => <button key={background} type="button" aria-label={label}
      title={`${label} · 只改变预览底色`} aria-pressed={value === background}
      className={`wps-artwork-preview-swatch ${background}`} onClick={() => onChange(background)}>
      {background === 'auto' ? '自动' : <span aria-hidden="true" />}
    </button>)}
  </div>;
}
