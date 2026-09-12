'use client';

import Image from 'next/image';
import { usePreviewBackground, WpsPreviewBackgroundControls } from './wps-preview-background';
import { productionThumbnailUrl } from '@/lib/production-file-url';
import { useEffect, useState } from 'react';
import { imageFailureReason } from '@/lib/client/api-response';

const RETRY_DELAYS = [1000, 2000, 4000];

type Props = {
  src?: string | null;
  alt: string;
  label?: string;
  sizes: string;
  large?: boolean;
  /** View-only controls for full-resolution source/artwork, never customer composites. */
  viewingBackground?: boolean;
  open?: () => void;
};

// Changing the source resets this image only, including any pending retry timer.
export function WpsMaterialImage(props: Props) {
  return <MaterialImageAttempt key={props.src} {...props} />;
}

function MaterialImageAttempt({ src, alt, label, sizes, large = false, viewingBackground = false, open }: Props) {
  const background = usePreviewBackground();
  const selectableBackground = large && viewingBackground;
  const [status, setStatus] = useState<'loading' | 'loaded' | 'waiting' | 'failed'>('loading');
  const [attempt, setAttempt] = useState({ count: 0, nonce: '' });
  const [failure, setFailure] = useState('');
  const sourceUrl = src && !large ? productionThumbnailUrl(src) : src;
  useEffect(() => {
    if (status !== 'failed' || !sourceUrl) return;
    const abort = new AbortController();
    void imageFailureReason(sourceUrl, abort.signal).then(message => { if (!abort.signal.aborted) setFailure(message); }).catch(() => { /* An obsolete image was cancelled. */ });
    return () => abort.abort();
  }, [status, sourceUrl]);

  useEffect(() => {
    if (status !== 'waiting') return;
    const timer = window.setTimeout(() => {
      setAttempt(current => ({ count: current.count + 1, nonce: String(Date.now()) }));
      setStatus('loading');
    }, RETRY_DELAYS[attempt.count]);
    return () => window.clearTimeout(timer);
  }, [status, attempt.count]);

  const retry = () => {
    setFailure('');
    setAttempt({ count: 0, nonce: String(Date.now()) });
    setStatus('loading');
  };
  if (!large && src) src = productionThumbnailUrl(src);
  // Bust cached failures on our file endpoint. Never change WPS signed URLs.
  const imageSrc = src && attempt.nonce && src.startsWith('/api/production-files/')
    ? `${src}${src.includes('?') ? '&' : '?'}_imageRetry=${attempt.nonce}-${attempt.count}`
    : src;
  const message = !src ? '暂无图片' : status === 'failed' ? `${failure || '图片加载失败，正在读取原因…'} 点击重试`
    : status === 'waiting' ? `准备重试 ${attempt.count + 1}/3`
      : status === 'loading' ? (attempt.count ? `重试 ${attempt.count}/3` : '加载中…') : '';

  const image = <button type="button" className={`wps-material-image${large ? ' wps-material-image-large' : ''}`}
    style={selectableBackground ? { background: background.cssBackground } : undefined}
    data-preview-background={selectableBackground ? background.selected : undefined}
    disabled={!src} aria-label={status === 'failed' ? `${alt}，${message}` : alt}
    title={message || alt} data-load-state={src ? status : 'missing'}
    onClick={() => status === 'failed' ? retry() : open?.()}>
    {imageSrc && <Image key={`${attempt.nonce}:${attempt.count}`} src={imageSrc} alt={alt} fill sizes={sizes} unoptimized
      style={{ opacity: status === 'loaded' ? 1 : 0 }}
      onLoad={event => { setStatus('loaded'); if (selectableBackground) background.inspect(event.currentTarget); }}
      onError={() => setStatus(attempt.count < RETRY_DELAYS.length ? 'waiting' : 'failed')} />}
    {message && <i className="wps-material-image-status" role="status">{message}</i>}
    {label && <span>{label}</span>}
  </button>;
  return selectableBackground ? <div className="wps-material-viewer">{image}
    <div className="wps-material-viewer-controls"><WpsPreviewBackgroundControls alt={alt} value={background.background} onChange={background.setBackground} /><small>仅改变查看底色，不改变原图</small></div>
  </div> : image;
}
