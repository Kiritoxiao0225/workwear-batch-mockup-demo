'use client';

import Image from 'next/image';
import { type CSSProperties, type ButtonHTMLAttributes } from 'react';
import { usePreviewBackground, WpsPreviewBackgroundControls } from './wps-preview-background';
import { productionThumbnailUrl } from '@/lib/production-file-url';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { src: string; alt: string };

export function WpsArtworkPreview({ src, ...props }: Props) {
  // A new artwork starts in automatic mode; stale image loads cannot color its preview.
  return <ArtworkPreviewImage key={src} src={src} {...props} />;
}

function ArtworkPreviewImage({ src, alt, className = '', ...buttonProps }: Props) {
  const { background, setBackground, selected, cssBackground, inspect } = usePreviewBackground();
  return <div className="wps-artwork-preview-frame">
    <button {...buttonProps} type="button" className={`wps-artwork-preview ${className}`}
      data-preview-background={selected}
      style={{ ...buttonProps.style, '--artwork-preview-background': cssBackground } as CSSProperties}>
      <Image alt={alt} fill sizes="200px" src={productionThumbnailUrl(src)} unoptimized onLoad={event => inspect(event.currentTarget)} />
    </button>
    <WpsPreviewBackgroundControls alt={alt} value={background} onChange={setBackground} />
  </div>;
}
