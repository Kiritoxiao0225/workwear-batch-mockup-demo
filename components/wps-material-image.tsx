'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';

const RETRY_DELAYS = [1000, 2000, 4000];

type Props = {
  src?: string | null;
  alt: string;
  label?: string;
  sizes: string;
  large?: boolean;
  open?: () => void;
};

// Changing the source resets this image only, including any pending retry timer.
export function WpsMaterialImage(props: Props) {
  return <MaterialImageAttempt key={props.src} {...props} />;
}

function MaterialImageAttempt({ src, alt, label, sizes, large = false, open }: Props) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'waiting' | 'failed'>('loading');
  const [attempt, setAttempt] = useState({ count: 0, nonce: '' });

  useEffect(() => {
    if (status !== 'waiting') return;
    const timer = window.setTimeout(() => {
      setAttempt(current => ({ count: current.count + 1, nonce: String(Date.now()) }));
      setStatus('loading');
    }, RETRY_DELAYS[attempt.count]);
    return () => window.clearTimeout(timer);
  }, [status, attempt.count]);

  const retry = () => {
    setAttempt({ count: 0, nonce: String(Date.now()) });
    setStatus('loading');
  };
  // Bust cached failures on our file endpoint. Never change WPS signed URLs.
  const imageSrc = src && attempt.nonce && src.startsWith('/api/production-files/')
    ? `${src}${src.includes('?') ? '&' : '?'}_imageRetry=${attempt.nonce}-${attempt.count}`
    : src;
  const message = !src ? '暂无图片' : status === 'failed' ? '加载失败，点击重试'
    : status === 'waiting' ? `准备重试 ${attempt.count + 1}/3`
      : status === 'loading' ? (attempt.count ? `重试 ${attempt.count}/3` : '加载中…') : '';

  return <button type="button" className={`wps-material-image${large ? ' wps-material-image-large' : ''}`}
    disabled={!src} aria-label={status === 'failed' ? `${alt}，加载失败，点击重试` : alt}
    title={message || alt} data-load-state={src ? status : 'missing'}
    onClick={() => status === 'failed' ? retry() : open?.()}>
    {imageSrc && <Image key={`${attempt.nonce}:${attempt.count}`} src={imageSrc} alt={alt} fill sizes={sizes} unoptimized
      style={{ opacity: status === 'loaded' ? 1 : 0 }}
      onLoad={() => setStatus('loaded')}
      onError={() => setStatus(attempt.count < RETRY_DELAYS.length ? 'waiting' : 'failed')} />}
    {message && <i className="wps-material-image-status" role="status">{message}</i>}
    {label && <span>{label}</span>}
  </button>;
}
