'use client';

import { useEffect, type ReactNode } from 'react';
import { WpsMaterialImage } from './wps-material-image';

/** No save or generation action belongs to the image viewer. Customer controls
 * are explicitly supplied by the existing parent and never run on close. */
export function WpsImagePreviewDialog({ url, title, customer = false, close, footer }: {
  url: string; title: string; customer?: boolean; close: () => void; footer?: ReactNode;
}) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [close]);
  return <div className={`wps-preview-backdrop ${customer ? 'customer-preview' : 'artwork-preview'}`}
    onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div role="dialog" aria-modal="true" aria-label={title}>
      <header><strong>{title}</strong><button onClick={close} type="button">关闭</button></header>
      <section><WpsMaterialImage src={url} alt={title} sizes="90vw" large viewingBackground={!customer} /></section>
      {footer}
    </div>
  </div>;
}
