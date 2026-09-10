'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import type { CatalogItem } from '@/lib/catalog';
import { imageFailureReason } from '@/lib/client/api-response';

function GarmentImage({ item, zoomed, framed }: { item: CatalogItem; zoomed: boolean; framed: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState('');
  const imageUrl = framed ? `/api/catalog/products/${item.id}/framed-preview?assetVersionId=${item.assetVersionId}` : item.imageUrl;
  useEffect(() => {
    if (!failed) return;
    const abort = new AbortController();
    void imageFailureReason(imageUrl, abort.signal).then(message => { if (!abort.signal.aborted) setFailure(message); }).catch(() => { /* An obsolete image was cancelled. */ });
    return () => abort.abort();
  }, [failed, imageUrl]);
  return <>
    <div className={`catalog-preview-scroll ${zoomed ? 'is-zoomed' : ''}`}>
      <div className="catalog-preview-picture">
        {!framed && <Image src={item.thumbnailUrl} alt="" fill unoptimized sizes="90vw" />}
        <Image key={attempt} src={imageUrl} alt={`${item.styleCode} · ${item.colorName} · ${item.layout === 'front_back' ? '正面与背面' : '正面'}`} fill unoptimized sizes="90vw" style={{ opacity: loaded ? 1 : 0 }} onLoad={() => { setLoaded(true); setFailed(false); }} onError={() => setFailed(true)} />
      </div>
    </div>
    <div className="catalog-preview-status" role="status">{failed ? <>{framed ? '带框预览读取失败。' : '高清图读取失败，当前显示缩略图。'} {failure || '正在读取失败原因…'}<button className="button" type="button" onClick={() => { setFailed(false); setFailure(''); setAttempt(n => n + 1); }}>重新加载</button></> : loaded ? (framed ? '带框试排 · 使用现有底框截图；高清模板待补充' : '高清图已加载') : framed ? '正在排版衣服与底框…' : '正在加载高清图，先显示缩略图…'}</div>
  </>;
}

export function CatalogImagePreview({ items, initialId, close }: { items: CatalogItem[]; initialId: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selectedId, setSelectedId] = useState(initialId);
  const [zoomed, setZoomed] = useState(false);
  const [framed, setFramed] = useState(false);
  const item = items.find(color => color.id === selectedId);
  if (!item) throw new Error(`预览颜色不存在：${selectedId}`);
  useEffect(() => {
    const element = dialog.current!;
    const overflow = document.body.style.overflow;
    element.showModal(); document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = overflow; };
  }, []);
  return <dialog ref={dialog} className="catalog-image-preview" aria-labelledby="image-preview-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="catalog-preview-content">
      <header className="catalog-dialog-head"><div><h2 id="image-preview-title">{item.styleCode} · {item.colorName}</h2><p>商品大图 · {items.length} 个颜色 · {item.layout === 'front_back' ? '左正面 / 右背面' : '仅正面'}</p></div><div className="catalog-preview-actions"><button className="button" type="button" aria-pressed={framed} onClick={() => { setFramed(value => !value); setZoomed(false); }}>{framed ? '查看服装原图' : '带框预览'}</button><button className="button" type="button" aria-pressed={zoomed} onClick={() => setZoomed(value => !value)}>{zoomed ? '适应窗口' : '放大 2 倍'}</button><button className="button" type="button" onClick={close}>关闭大图</button></div></header>
      <div className="catalog-preview-colors catalog-color-options" aria-label="选择预览颜色">{items.map(color => <button key={color.id} type="button" aria-pressed={color.id === selectedId} onClick={() => { setSelectedId(color.id); setZoomed(false); }}>{color.colorName}</button>)}</div>
      <GarmentImage key={`${item.imageUrl}:${framed}`} item={item} zoomed={zoomed} framed={framed} />
    </section>
  </dialog>;
}
