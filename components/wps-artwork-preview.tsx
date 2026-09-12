'use client';

import Image from 'next/image';
import { useState, type CSSProperties, type ButtonHTMLAttributes } from 'react';
import { artworkPreviewTone, type ArtworkPreviewTone } from '@/lib/artwork-preview-background';
import { productionThumbnailUrl } from '@/lib/production-file-url';

type Background = 'auto' | 'light' | 'dark' | 'checker';
const backgrounds = { light: '#f5f5f5', dark: '#333333', gray: '#808080', checker: 'conic-gradient(#dce1dc 25%, #fff 0 50%, #dce1dc 0 75%, #fff 0) 0 0 / 16px 16px' };
const options = [['auto', '自动'], ['light', '浅底'], ['dark', '深底'], ['checker', '棋盘格']] as const;
type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { src: string; alt: string };

export function WpsArtworkPreview({ src, ...props }: Props) {
  // A new artwork starts in automatic mode; stale image loads cannot color its preview.
  return <ArtworkPreviewImage key={src} src={src} {...props} />;
}

function ArtworkPreviewImage({ src, alt, className = '', ...buttonProps }: Props) {
  const [background, setBackground] = useState<Background>('auto');
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
      // External images without CORS remain viewable, with manual background controls.
      setTone('gray');
    }
  }
  return <div className="wps-artwork-preview-frame">
    <button {...buttonProps} type="button" className={`wps-artwork-preview ${className}`}
      data-preview-background={selected}
      style={{ ...buttonProps.style, '--artwork-preview-background': backgrounds[selected] } as CSSProperties}>
      <Image alt={alt} fill sizes="200px" src={productionThumbnailUrl(src)} unoptimized onLoad={event => inspect(event.currentTarget)} />
    </button>
    <div className="wps-artwork-preview-backgrounds" role="group" aria-label={`${alt}的预览底色`}>
      {options.map(([value, label]) => <button key={value} type="button" aria-label={label}
        title={`${label} · 只改变预览底色`} aria-pressed={background === value}
        className={`wps-artwork-preview-swatch ${value}`} onClick={() => setBackground(value)}>
        {value === 'auto' ? '自动' : <span aria-hidden="true" />}
      </button>)}
    </div>
  </div>;
}
