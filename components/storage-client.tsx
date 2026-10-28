'use client';
/* eslint-disable @next/next/no-img-element -- covers come from /api/listing/assets (private storage) */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '@/components/app-header';
import { PageHeader } from '@/components/page-header';
import { publishStorage, sizeText, storageLevel, UNLIMITED_BYTES } from '@/lib/storage-status';
import type { StoragePart, StorageProduct } from '@/lib/server/storage-usage';

type Storage = {
  // When it was read: 「超过 30 天没动过的」 counts from here.
  at: number;
  usage: { bytesUsed: number; storageQuotaBytes: number };
  parts: Record<StoragePart, { bytes: number; files: number }>;
  products: StorageProduct[];
};

const PARTS: [StoragePart, string][] = [['listing', '电商主图'], ['artwork', '图稿生成'], ['layouts', '自己学的版式'], ['other', '其他']];
const STATUS: Record<string, string> = {
  uploading: '上传中', planning: '整理中', review: '待定方案', materials: '待定方案', confirmed: '已定方案',
  writing: '写文案中', generating: '出图中', square: '方图已出', done: '已完成', failed: '没做成',
};
// Deleting refuses while the product is being analysed or drawn; don't offer it then.
const BUSY = new Set(['planning', 'writing', 'generating']);
const STALE_DAYS = 30;

export function StorageClient() {
  const [data, setData] = useState<Storage | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch('/api/account/storage', { cache: 'no-store' });
    const body = await response.json() as Omit<Storage, 'at'> & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `读取失败（HTTP ${response.status}）`);
    setData({ ...body, at: Date.now() });
    publishStorage(body.usage);
  }, []);
  useEffect(() => {
    void (async () => {
      try { await load(); } catch (loadError) { setError(loadError instanceof Error ? loadError.message : String(loadError)); }
    })();
  }, [load]);

  const remove = async (product: StorageProduct) => {
    setDeleting(true); setError('');
    try {
      const response = await fetch(`/api/listing/projects/${product.id}`, { method: 'DELETE', cache: 'no-store' });
      const body = await response.json() as { freedBytes?: number; error?: string };
      if (!response.ok) throw new Error(body.error ?? `删除失败（HTTP ${response.status}）`);
      setAsking(null);
      setNotice(`已删除「${product.name}」，腾出 ${sizeText(body.freedBytes ?? 0)}`);
      await load();
    } catch (removeError) { setError(removeError instanceof Error ? removeError.message : String(removeError)); }
    finally { setDeleting(false); }
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
        <PageHeader title="存储空间" description="空间都用在了哪里。删掉不用的商品，空间马上退回。" />
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
                            <div><b>{p.kind === 'shop' ? '店铺资料' : p.name}</b><small>{p.kind === 'shop' ? '店铺 LOGO、服务图等，跟着店铺走' : `${p.files} 个文件${p.sourcesCleared ? ' · 原图已清理' : ''}`}</small></div>
                          </div>
                        </td>
                        <td>{p.kind === 'shop' ? '—' : STATUS[p.status] ?? p.status}</td>
                        <td>{new Date(p.updatedAt).toLocaleDateString('zh-CN')}</td>
                        <td className="right">{sizeText(p.bytes)}</td>
                        <td className="right">{p.kind === 'shop' ? '—' : sizeText(p.freeableBytes)}</td>
                        <td className="right nowrap">
                          {p.kind === 'product' && (asking === p.id ? (
                            <span className="storage-confirm">
                              <span>上传的图和出好的图都会删掉，删了找不回</span>
                              <button type="button" className="button danger" disabled={deleting} onClick={() => void remove(p)}>{deleting ? '正在删…' : '确认删除'}</button>
                              <button type="button" className="button" disabled={deleting} onClick={() => setAsking(null)}>取消</button>
                            </span>
                          ) : BUSY.has(p.status) ? <small>做完才能删</small>
                            : <button type="button" className="button" onClick={() => { setAsking(p.id); setNotice(''); }}>删除</button>)}
                        </td>
                      </tr>
                    ))}
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
    </main>
  );
}
