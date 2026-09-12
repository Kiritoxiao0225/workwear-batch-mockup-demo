'use client';
import { fetchApi, readApiJson } from '@/lib/client/api-response';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AppHeader } from '@/components/app-header';
import { CatalogImagePreview } from '@/components/catalog-image-preview';
import { CatalogCalibration } from '@/components/catalog-calibration';
import { POSITION_LABELS, type CatalogDetail, type CatalogStyle } from '@/lib/catalog';
import { calibrationStatus } from '@/lib/catalog-calibration-status';
import { useProjectSession } from '@/components/project-session';
import { placementPreviewSchema, type CatalogPlacementPreview } from '@/lib/catalog-placement-suggestions';

type PreviewDetail = CatalogDetail & { placementPreview: CatalogPlacementPreview };

type CatalogPage = { items: CatalogStyle[]; total: number; totalColors: number; matchingColors: number; page: number; pageSize: number; importIssues: { filename: string; status: string; error: string }[] };
async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetchApi(url, { ...options, cache: 'no-store' });
  return readApiJson(response, '素材库请求失败') as Promise<T>;
}
function StyleCard({ style, priority, viewer, open, preview }: { style: CatalogStyle; priority: boolean; viewer: boolean; open: (id: string) => void; preview: (id: string) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null);
  const preferred = style.matchedIds.includes(style.referenceVariantId ?? '') ? style.referenceVariantId : style.colors.find(c => style.matchedIds.includes(c.id))?.id;
  const item = style.colors.find(c => c.id === selectedId) ?? style.colors.find(c => c.id === preferred) ?? style.colors[0];
  const ready = style.colors.filter(c => calibrationStatus(c).key === 'confirmed').length;
  const status = calibrationStatus(item);
  const thumbnail = item.signedThumbnailUrl && failedThumbnail !== item.signedThumbnailUrl ? item.signedThumbnailUrl : item.thumbnailUrl;
  return <article className="catalog-card catalog-style-card"><button type="button" className="catalog-card-image" onClick={() => preview(item.id)} aria-label={`查看 ${item.styleCode} ${item.colorName} 高清图`}><Image src={thumbnail} onError={() => setFailedThumbnail(thumbnail)} alt={`${item.styleCode} ${item.colorName}`} fill sizes="(max-width: 680px) 50vw, (max-width: 1100px) 33vw, 25vw" priority={priority} unoptimized /><span className="catalog-color-count">{style.colors.length} 色</span></button>
    <div className="catalog-card-copy"><div><h2>{style.styleCode}</h2><span>{item.colorName}</span></div>
      <div className="catalog-color-options" aria-label={`${style.styleCode}的颜色`}>{style.colors.map(color => <button type="button" key={color.id} aria-pressed={item.id === color.id} title={`${color.colorName} · ${calibrationStatus(color).label}${color.id === style.referenceVariantId ? ' · 代表颜色' : ''}`} className={style.matchedIds.includes(color.id) ? '' : 'not-matched'} onClick={() => setSelectedId(color.id)}><span className={`catalog-status-symbol ${calibrationStatus(color).key}`} aria-hidden="true">{calibrationStatus(color).symbol}</span> {color.colorName}{color.id === style.referenceVariantId ? ' ★' : ''}</button>)}</div>
      <section className="catalog-calibration-summary" aria-label={`${item.colorName}校准状态`}>
        <strong className={`catalog-calibration-badge ${status.key}`}>{status.symbol} {item.colorName} · {status.label}</strong>
        {item.calibrationFaces?.map(face => <div key={face.face} className="catalog-face-status"><b>{face.face === 'front' ? '正面' : '背面'} · {face.status === 'confirmed' ? '已确认' : face.status === 'draft' ? '草稿待确认' : '未校准'}</b><p>{face.positions.length ? `${face.status === 'confirmed' ? '已确认位置' : '草稿位置'}：${face.positions.map(key => POSITION_LABELS[key]).join('、')}` : '尚无已保存位置'}</p>{face.status === 'draft' && face.confirmedPositions.length > 0 && <p>旧版已确认：{face.confirmedPositions.map(key => POSITION_LABELS[key]).join('、')}；本次修改待确认</p>}{face.status === 'confirmed' && face.origin === 'inherited' && <p>来自同款复用</p>}</div>)}
        {item.layout === 'front_only' && <p className="catalog-no-back">仅正面素材，无背面</p>}
      </section>
      <small>全款 {ready}/{style.colors.length} 色已确认 · 其余 {style.colors.length - ready} 色待处理</small>
      <button className="button" type="button" onClick={() => open(item.id)}>{viewer ? '查看印花位置' : item.hasDraft ? '继续调整位置' : '查看印花位置'}</button>
    </div></article>;
}
function UploadDialog({ target, style, close, saved }: { target: CatalogDetail | null; style?: CatalogStyle; close: () => void; saved: (variantId: string) => Promise<void> }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const form = new FormData(event.currentTarget);
      if (target) { form.set('variantId', target.id); form.set('expectedAssetVersionId', target.assetVersionId); }
      else if (style) form.set('styleId', style.id);
      const result = await requestJson<{ variantId: string }>('/api/catalog/upload', { method: 'POST', body: form });
      await saved(result.variantId);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <div className="catalog-backdrop"><form className="catalog-upload" role="dialog" aria-modal="true" aria-labelledby="upload-title" onSubmit={event => void submit(event)}><h2 id="upload-title">{target ? '上传新版底图' : '添加商品素材'}</h2><p>{target ? `${target.styleCode} · ${target.colorName}。新版本将重新校准，已有图片与标准继续保留。` : '款号、颜色分别保存；请上传已经核对过视图布局的图片。'}</p>
    {!target && <>{style ? <p>添加到款式：<strong>{style.styleCode}</strong></p> : <label className="cal-field">完整款号<input name="styleCode" required maxLength={200} /></label>}<label className="cal-field">原颜色名<input name="colorName" required maxLength={100} /></label></>}
    <label className="cal-field">素材布局<select name="layout" defaultValue={target?.layout ?? 'front_back'}><option value="front_back">双面：左正面、右背面，各占半幅画布</option><option value="front_only">单面：只保留现有正面</option></select></label>
    <label className="cal-field">图片文件<input name="file" type="file" accept="image/png,image/jpeg,image/webp" required /></label><label className="catalog-check"><input type="checkbox" name="layoutConfirmed" value="true" required />已核对图片与上述布局一致</label>
    {error && <div className="error-banner" role="alert">{error}</div>}<div className="catalog-upload-actions"><button type="button" className="button" disabled={busy} onClick={close}>取消</button><button className="button primary" type="submit" disabled={busy}>{busy ? '上传并校验…' : '保存素材'}</button></div></form></div>;
}
export function CatalogLibraryClient() {
  const { user, initialized, refresh } = useProjectSession();
  const [page, setPage] = useState<CatalogPage | null>(null);
  const [query, setQuery] = useState(''); const [status, setStatus] = useState('all'); const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<PreviewDetail | null>(null);
  const [detailStyle, setDetailStyle] = useState<CatalogStyle | null>(null);
  const detailRequest = useRef(0);
  const [imagePreview, setImagePreview] = useState<{ style: CatalogStyle; id: string } | null>(null);
  const [opening, setOpening] = useState<{ id: string; assetVersionId?: string } | null>(null);
  const [openingError, setOpeningError] = useState('');
  const [upload, setUpload] = useState<{ target: CatalogDetail | null; style?: CatalogStyle } | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!user) {
      const reset = setTimeout(() => { detailRequest.current++; setPage(null); setDetail(null); setDetailStyle(null); setUpload(null); setOpening(null); setImagePreview(null); }, 0);
      return () => clearTimeout(reset);
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      void requestJson<CatalogPage>(`/api/catalog/styles?q=${encodeURIComponent(query)}&status=${status}&page=${pageNumber}`, { signal: abort.signal })
        .then(result => { setPage(result); setError(''); })
        .catch(error => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [user, query, status, pageNumber, reload]);
  async function openDetail(id: string, assetVersionId?: string, quiet = false) {
    const requestId = ++detailRequest.current;
    if (!quiet) { setOpening({ id, assetVersionId }); setOpeningError(''); }
    try {
      const next = await requestJson<PreviewDetail>(`/api/catalog/products/${id}?placementPreview=1${assetVersionId ? `&assetVersionId=${assetVersionId}` : ''}`);
      next.placementPreview = placementPreviewSchema.parse(next.placementPreview);
      if (next.placementPreview.assetVersionId !== next.assetVersionId || next.views.some(v => !next.placementPreview.faces.some(f => f.viewId === v.id))) throw new Error('位置预览与当前底图不一致，请重新打开');
      // The list already contains every color. Refresh it after writes, not on every open.
      const knownStyle = page?.items.find(style => style.id === next.styleId) ?? (detailStyle?.id === next.styleId ? detailStyle : null);
      const style = !quiet && knownStyle ? knownStyle : await requestJson<CatalogStyle>(`/api/catalog/styles/${next.styleId}`);
      if (requestId !== detailRequest.current) return;
      setDetailStyle(style); setDetail(next); setOpening(null);
    } catch (error) {
      if (requestId !== detailRequest.current) return;
      const message = error instanceof Error ? error.message : String(error);
      if (quiet) { setError(message); throw error; }
      setOpeningError(message);
    }
  }
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    const variantId = params.get('variantId'), assetVersionId = params.get('assetVersionId') ?? undefined;
    const timer = setTimeout(() => { if (variantId) void openDetail(variantId, assetVersionId); }, 0);
    return () => clearTimeout(timer);
    // The link opens once after authentication; later modal changes stay local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  async function saved(id: string) { await openDetail(id, undefined, true); setReload(n => n + 1); }
  function closeDetail() { detailRequest.current++; setDetail(null); }
  return <div className="app-shell"><AppHeader /><main className="catalog-page">
    <div className="catalog-heading"><div><h1>商品素材库</h1><p>按款号和颜色找素材，逐款建立可复用的位置标准。</p></div><div className="catalog-account"><Link href="/products?mode=append">添加到简单批量生图 ↗</Link></div></div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!initialized ? <p>正在读取素材库…</p> : !user ? <div className="catalog-login"><h2>工作台暂时无法读取</h2><p>请重试连接，详细原因见页面顶部。</p><button type="button" className="button primary" onClick={() => void refresh()}>重新连接</button></div> : <>
    <div className="catalog-toolbar"><input type="search" aria-label="搜索款号或颜色" placeholder="搜索完整款号、颜色…" value={query} onChange={e => { setQuery(e.target.value); setPageNumber(1); }} /><div className="catalog-filters">{[['all', '全部'], ['pending', '待校准'], ['draft', '有草稿'], ['confirmed', '已确认'], ['front_only', '仅正面']].map(([key, label]) => <button key={key} type="button" aria-pressed={status === key} onClick={() => { setStatus(key); setPageNumber(1); }}>{label}</button>)}</div>{user.role !== 'viewer' && <button type="button" className="button primary" onClick={() => setUpload({ target: null })}>添加素材</button>}</div>
    <div className="catalog-count"><span>{page?.total ?? '—'} 个款式 · {page?.totalColors ?? '—'} 个颜色{query || status !== 'all' ? ` · ${page?.matchingColors ?? 0} 个颜色符合筛选` : ''}{loading ? ' · 正在读取…' : ''}</span><button className="button" type="button" onClick={() => setReload(n => n + 1)}>刷新</button></div>
    {page?.importIssues.length ? <details className="catalog-issues"><summary>{page.importIssues.length} 项导入待处理</summary>{page.importIssues.map((issue, i) => <p key={`${issue.filename}-${i}`}><strong>{issue.filename}</strong> · {issue.error}</p>)}</details> : null}
    {!loading && page?.items.length === 0 && <div className="empty-state">{query || status !== 'all' ? '没有符合条件的素材。' : '还没有商品素材，可以添加图片或运行整批导入。'}</div>}
    <p className="catalog-status-legend">颜色状态：✓ 已确认 · ◐ 草稿或部分确认 · ○ 未校准；绿色描边表示当前选色。</p><div className="catalog-grid">{page?.items.map((style, index) => <StyleCard key={`${style.id}:${query}:${status}`} style={style} priority={index < 4} viewer={user.role === 'viewer'} open={id => void openDetail(id)} preview={id => setImagePreview({ style, id })} />)}</div>
    <div className="catalog-pagination"><button className="button" type="button" disabled={pageNumber <= 1 || loading} onClick={() => setPageNumber(n => n - 1)}>上一页</button><span>第 {pageNumber} / {Math.max(1, Math.ceil((page?.total ?? 0) / (page?.pageSize ?? 24)))} 页</span><button className="button" type="button" disabled={loading || pageNumber * (page?.pageSize ?? 24) >= (page?.total ?? 0)} onClick={() => setPageNumber(n => n + 1)}>下一页</button></div>
    </>}
  </main>{imagePreview && user && <CatalogImagePreview items={imagePreview.style.colors} initialId={imagePreview.id} close={() => setImagePreview(null)} />}{opening && user && <div className="catalog-backdrop catalog-opening"><section className="catalog-upload" role="dialog" aria-modal="true" aria-labelledby="opening-title"><h2 id="opening-title">{openingError ? '位置标记未能打开' : '正在打开印花位置…'}</h2><p role={openingError ? 'alert' : 'status'}>{openingError || '正在读取这件衣服的正反面、已保存标记和建议位置。'}</p><div className="catalog-upload-actions"><button className="button" type="button" onClick={() => { detailRequest.current++; setOpening(null); }}>关闭</button>{openingError && <button className="button primary" type="button" onClick={() => void openDetail(opening.id, opening.assetVersionId)}>重试</button>}</div></section></div>}{detail && detailStyle && user && !upload && <CatalogCalibration key={detail.assetVersionId} detail={detail} preview={detail.placementPreview} style={detailStyle} user={user} close={closeDetail} saved={saved} replace={() => setUpload({ target: detail })} addColor={() => setUpload({ target: null, style: detailStyle })} loadVersion={assetVersionId => void openDetail(detail.id, assetVersionId)} selectColor={id => void openDetail(id)} />}{upload && user && <UploadDialog target={upload.target} style={upload.style} close={() => setUpload(null)} saved={async id => { await saved(id); setUpload(null); }} />}</div>;
}
