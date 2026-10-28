'use client';
/* eslint-disable @next/next/no-img-element -- covers come from /api/listing/assets (private storage) */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '@/components/app-header';
import { PageHeader } from '@/components/page-header';
import { publishStorage, sizeText, storageLevel, UNLIMITED_BYTES } from '@/lib/storage-status';
import type { StoragePart, StorageProduct } from '@/lib/server/storage-usage';
import type { RemoveMode, TrashItem } from '@/lib/server/listing-trash';
import { RemoveDialog } from '@/components/remove-dialog';

type Storage = {
  // When it was read: 「超过 30 天没动过的」 counts from here.
  at: number;
  usage: { bytesUsed: number; storageQuotaBytes: number };
  parts: Record<StoragePart, { bytes: number; files: number }>;
  products: StorageProduct[];
  trash: TrashItem[];
};

const PARTS: [StoragePart, string][] = [['listing', '电商主图'], ['artwork', '图稿生成'], ['layouts', '自己学的版式'], ['other', '其他']];
const STATUS: Record<string, string> = {
  uploading: '上传中', planning: '整理中', review: '待定方案', materials: '待定方案', confirmed: '已定方案',
  writing: '写文案中', generating: '出图中', square: '方图已出', done: '已完成', failed: '没做成',
};
// Deleting refuses while the product is being analysed or drawn; don't offer it then.
const BUSY = new Set(['planning', 'writing', 'generating']);
const STALE_DAYS = 30;
const MODE: Record<RemoveMode, string> = { sources: '只删原图', images: '只删图片', all: '整款删除' };

async function send<T>(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { cache: 'no-store', ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `请求失败（HTTP ${response.status}）`);
  return body;
}

export function StorageClient() {
  const [data, setData] = useState<Storage | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const [removing, setRemoving] = useState<StorageProduct | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [emptying, setEmptying] = useState(false);

  const load = useCallback(async () => {
    const [storage, trash] = await Promise.all([
      send<Omit<Storage, 'at' | 'trash'>>('/api/account/storage'),
      send<{ items: TrashItem[] }>('/api/account/trash'),
    ]);
    setData({ ...storage, trash: trash.items, at: Date.now() });
    publishStorage(storage.usage);
  }, []);
  useEffect(() => {
    void (async () => {
      try { await load(); } catch (loadError) { setError(loadError instanceof Error ? loadError.message : String(loadError)); }
    })();
  }, [load]);

  // The dialog shows its own error and stays open when this throws.
  const remove = async (product: StorageProduct, mode: RemoveMode) => {
    const done = await send<{ freedBytes: number }>(`/api/listing/projects/${product.id}/remove`, { method: 'POST', body: JSON.stringify({ mode }) });
    setRemoving(null); setError('');
    setNotice(`「${product.name}」${MODE[mode]}，腾出 ${sizeText(done.freedBytes)}。7 天内可以在下面的回收站恢复`);
    await load();
  };
  const act = async (key: string, body: unknown, said: string) => {
    setWorking(key); setError(''); setNotice('');
    try {
      await send('/api/account/trash', { method: 'POST', body: JSON.stringify(body) });
      setNotice(said); setEmptying(false);
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setWorking(null); }
  };

  const unlimited = (data?.usage.storageQuotaBytes ?? 0) >= UNLIMITED_BYTES;
  const level = storageLevel(data?.usage ?? null);
  const ratio = data ? Math.min(100, (data.usage.bytesUsed / Math.max(1, data.usage.storageQuotaBytes)) * 100) : 0;
  const cutoff = (data?.at ?? 0) - STALE_DAYS * 864e5;
  const products = (data?.products ?? []).filter(p => !stale || (p.kind === 'product' && Date.parse(p.updatedAt) < cutoff));

  return (
    <main>
      <AppHeader />
      <div className="page-frame account-page">
        <PageHeader title="存储空间" description="空间都用在了哪里。删掉不用的，空间马上退回；7 天内还能从回收站恢复。" />
        <Link className="storage-back" href="/account">← 我的账户</Link>
        {error && <p className="login-error" role="alert">{error}</p>}
        {notice && <p className="storage-notice" role="status">{notice}</p>}
        {!data && !error && <p className="muted-note" role="status">正在读取…</p>}

        {data && (
          <>
            <section className={`storage-total ${level}`}>
              <div className="storage-total__head">
                <span>已用</span>
                <b>{sizeText(data.usage.bytesUsed)}</b>
                <span>{unlimited ? '空间不限' : `/ 共 ${sizeText(data.usage.storageQuotaBytes)}`}</span>
                {!unlimited && <em>{level === 'full' ? '空间已满，新的上传和出图会失败，请先删掉不用的商品' : `还剩 ${sizeText(Math.max(0, data.usage.storageQuotaBytes - data.usage.bytesUsed))}`}</em>}
              </div>
              {!unlimited && <div className="quota-bar"><i style={{ width: `${ratio}%` }} /></div>}
              <ul className="storage-parts">
                {PARTS.filter(([key]) => key !== 'other' || data.parts.other.bytes > 0).map(([key, label]) => (
                  <li key={key}><span>{label}</span><b>{sizeText(data.parts[key].bytes)}</b><small>{data.parts[key].files} 个文件</small></li>
                ))}
              </ul>
            </section>

            <section className="account-ledger storage-list">
              <div className="storage-list__head">
                <h2>电商主图（{data.products.filter(p => p.kind === 'product').length} 款）</h2>
                <div className="storage-seg" role="radiogroup" aria-label="筛选">
                  <button type="button" role="radio" aria-checked={!stale} className={!stale ? 'on' : ''} onClick={() => setStale(false)}>全部</button>
                  <button type="button" role="radio" aria-checked={stale} className={stale ? 'on' : ''} onClick={() => setStale(true)}>超过 {STALE_DAYS} 天没动过的</button>
                </div>
              </div>
              <p className="muted-note">按占用从大到小排。同一张图被几款共用时，要等用到它的都删掉才腾出空间，所以「删掉能腾出」可能比「占用」小。</p>
              {products.length === 0 ? <p className="muted-note">{stale ? `没有超过 ${STALE_DAYS} 天没动过的商品。` : '还没有商品。'}</p> : (
                <table>
                  <thead><tr><th>商品</th><th>状态</th><th>最后改动</th><th className="right">占用</th><th className="right">删掉能腾出</th><th /></tr></thead>
                  <tbody>
                    {products.map(p => (
                      <tr key={p.id}>
                        <td>
                          <div className="storage-item">
                            {p.cover ? <img src={p.cover} alt="" loading="lazy" /> : <span className="storage-item__blank" />}
                            <div><b>{p.kind === 'shop' ? '店铺资料' : p.name}</b><small>{p.kind === 'shop' ? '店铺 LOGO、服务图等，跟着店铺走' : `${p.files} 个文件${p.imagesCleared ? ' · 图片已清理' : p.sourcesCleared ? ' · 原图已清理' : ''}`}</small></div>
                          </div>
                        </td>
                        <td>{p.kind === 'shop' ? '—' : STATUS[p.status] ?? p.status}</td>
                        <td>{new Date(p.updatedAt).toLocaleDateString('zh-CN')}</td>
                        <td className="right">{sizeText(p.bytes)}</td>
                        <td className="right">{p.kind === 'shop' ? '—' : sizeText(p.freeableBytes)}</td>
                        <td className="right nowrap">
                          {p.kind === 'product' && (BUSY.has(p.status) ? <small>做完才能删</small>
                            : <button type="button" className="button" onClick={() => { setRemoving(p); setNotice(''); }}>删除</button>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="account-ledger storage-list">
              <div className="storage-list__head">
                <h2>回收站（{data.trash.length}）</h2>
                {data.trash.length > 0 && (emptying ? (
                  <span className="storage-confirm">
                    <span>回收站里的全部彻底删除，不能再恢复</span>
                    <button type="button" className="button danger" disabled={!!working} onClick={() => void act('all', { action: 'purge-all' }, '回收站已清空')}>{working === 'all' ? '正在清空…' : '确认清空'}</button>
                    <button type="button" className="button" disabled={!!working} onClick={() => setEmptying(false)}>取消</button>
                  </span>
                ) : <button type="button" className="button" onClick={() => setEmptying(true)}>清空回收站</button>)}
              </div>
              <p className="muted-note">删掉的东西在这里放 7 天，期间可以原样恢复；空间在删的时候就已经退回了，恢复时会重新占用。7 天后自动彻底删除。</p>
              {data.trash.length === 0 ? <p className="muted-note">回收站是空的。</p> : (
                <table>
                  <thead><tr><th>删了什么</th><th>删法</th><th>删除时间</th><th className="right">腾出</th><th>还能恢复</th><th /></tr></thead>
                  <tbody>
                    {data.trash.map(item => {
                      const days = Math.max(0, Math.ceil((Date.parse(item.purgeAfter) - data.at) / 864e5));
                      return (
                        <tr key={item.id}>
                          <td><b>{item.name}</b><small>{item.feature === 'listing' ? '电商主图' : '图稿生成'} · {item.files} 个文件</small></td>
                          <td>{MODE[item.mode]}</td>
                          <td>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                          <td className="right">{sizeText(item.bytes)}</td>
                          <td><span className="trash-days">{days <= 1 ? '不到 1 天' : `${days} 天`}</span></td>
                          <td className="right nowrap">
                            {item.restorable
                              ? <button type="button" className="button" disabled={!!working} onClick={() => void act(item.id, { action: 'restore', id: item.id }, `「${item.name}」已恢复`)}>{working === item.id ? '正在恢复…' : '恢复'}</button>
                              : <small>先恢复这款后面那次删除</small>}
                            <button type="button" className="button danger" disabled={!!working} onClick={() => void act(item.id + ':purge', { action: 'purge', id: item.id }, `「${item.name}」已彻底删除`)}>{working === item.id + ':purge' ? '正在删…' : '彻底删除'}</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>

            <section className="account-ledger storage-list">
              <h2>图稿生成</h2>
              <p>共占 <b>{sizeText(data.parts.artwork.bytes)}</b>（{data.parts.artwork.files} 个文件）。</p>
              <p className="muted-note">图稿按条查看占用、删除后退回空间的功能，下一步上线。现在在「我的图稿」里删除一条，只是不再显示，空间暂时不会退回。</p>
            </section>
          </>
        )}
      </div>
      {removing && <RemoveDialog name={removing.name} sourcesCleared={removing.sourcesCleared} imagesCleared={removing.imagesCleared}
        freeableBytes={removing.freeableBytes} onConfirm={mode => remove(removing, mode)} onClose={() => setRemoving(null)} />}
    </main>
  );
}
