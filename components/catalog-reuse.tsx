'use client';
import { fetchApi, readApiJson } from '@/lib/client/api-response';

import { useEffect, useState } from 'react';
import { POSITION_LABELS, type CatalogItem, type CatalogView, type PlacementStandard, type ReusePreview } from '@/lib/catalog';

export function StandardPreview({ item, crop, specification }: { item: CatalogItem; crop: CatalogView['crop']; specification: PlacementStandard | null }) {
  const frame = specification?.garmentFrame;
  return <svg className="catalog-reuse-image" viewBox="0 0 1000 1000" preserveAspectRatio="none" style={{ aspectRatio: `${item.width * crop.width} / ${item.height * crop.height}` }} role="img" aria-label={`${item.colorName}位置套用预览`}>
    <image href={item.imageUrl} x={-crop.x / crop.width * 1000} y={-crop.y / crop.height * 1000} width={1000 / crop.width} height={1000 / crop.height} preserveAspectRatio="none" />
    {specification && frame && specification.positions.map(position => <g key={position.key}>
      <rect x={(frame.x + position.printableArea.x * frame.width) * 1000} y={(frame.y + position.printableArea.y * frame.height) * 1000} width={position.printableArea.width * frame.width * 1000} height={position.printableArea.height * frame.height * 1000} className="cal-print-area" />
      <rect x={(frame.x + (position.anchor.x - position.defaultSize.width / 2) * frame.width) * 1000} y={(frame.y + (position.anchor.y - position.defaultSize.height / 2) * frame.height) * 1000} width={position.defaultSize.width * frame.width * 1000} height={position.defaultSize.height * frame.height * 1000} className="cal-logo-size" />
      <circle cx={(frame.x + position.anchor.x * frame.width) * 1000} cy={(frame.y + position.anchor.y * frame.height) * 1000} r="10" className="cal-anchor" /><text x={(frame.x + position.anchor.x * frame.width) * 1000} y={(frame.y + (position.printableArea.y + position.printableArea.height) * frame.height) * 1000 + 26} textAnchor="middle">{POSITION_LABELS[position.key]}</text>
    </g>)}
    {specification && frame && specification.exclusions.map(exclusion => <rect key={exclusion.id} x={(frame.x + exclusion.area.x * frame.width) * 1000} y={(frame.y + exclusion.area.y * frame.height) * 1000} width={exclusion.area.width * frame.width * 1000} height={exclusion.area.height * frame.height * 1000} className="cal-exclusion" />)}
  </svg>;
}

export function CatalogReuse({ variantId, close, saved }: { variantId: string; close: () => void; saved: () => Promise<void> }) {
  const [preview, setPreview] = useState<ReusePreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    void fetchApi('/api/catalog/reuse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variantId }), signal: abort.signal }).then(async response => {
      const next = await readApiJson(response, '读取位置复用方案失败');
      if (abort.signal.aborted) return;
      const ready = next as ReusePreview; setPreview(ready);
      setSelected(new Set(ready.colors.flatMap(color => {
        const faces = color.faces.filter(f => f.checkId);
        return faces.every(f => f.status === 'aligned') ? faces.map(f => f.checkId!) : [];
      })));
    }).catch(error => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error)); });
    return () => abort.abort();
  }, [variantId]);
  async function apply() {
    setBusy(true); setError('');
    try {
      const response = await fetchApi('/api/catalog/reuse', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceVariantId: variantId, checkIds: [...selected], reviewed }) });
      const responseBody = await readApiJson(response, '应用位置到其他颜色失败');
      setResult(`已套用到 ${responseBody.colors} 个颜色、${responseBody.faces} 个面。`); await saved();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const selectedColors = preview?.colors.filter(c => c.faces.some(f => f.checkId && selected.has(f.checkId))).length ?? 0;
  return <div className="catalog-backdrop"><section className="catalog-dialog catalog-reuse-dialog" role="dialog" aria-modal="true" aria-labelledby="reuse-title">
    <header className="catalog-dialog-head"><div><h2 id="reuse-title">全款核对</h2><p>{preview ? `${preview.source.styleCode} · 代表颜色：${preview.source.colorName}` : '正在读取代表颜色…'}</p></div><button type="button" className="button" disabled={busy} onClick={close}>返回印花位置</button></header>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {result ? <div className="catalog-reuse-success" role="status"><h3>{result}</h3><p>这些颜色现在跟随代表色：以后在代表色上「确认并应用到全款」，它们会一起更新。某个颜色换图后需要重新核对。</p><button className="button primary" type="button" onClick={close}>完成</button></div> : !preview ? <p className="catalog-reuse-loading">{error ? '检查未完成，可以返回后重试。' : '正在读取真实图片，比较轮廓并计算位置…'}</p> : <>
      <div className="catalog-reuse-scroll">
        <div className="catalog-reuse-reference"><div><strong>代表颜色的已确认位置</strong><p>绿色框是可印范围，黄色框是默认图案大小。请对照领口、门襟、口袋核对下面各色；轮廓检查不代表这些结构已自动识别。</p><p>下面每个颜色显示效果图正在用的位置。已跟随最新版、单独打点的颜色不用处理；「需要核对」的颜色轮廓与代表色有差异，逐项看过后勾选套用。</p></div><div className="catalog-reuse-faces">{preview.source.views.filter(v => v.latest?.status === 'confirmed' && v.latest.origin === 'manual').map(v => <div key={v.id}><small>{v.face === 'front' ? '正面' : '背面'}</small><StandardPreview item={preview.source} crop={v.crop} specification={v.latest!.specification} /></div>)}</div></div>
        <div className="catalog-reuse-grid">{preview.colors.map(color => {
          const candidates = color.faces.filter(f => f.checkId);
          const checked = candidates.length > 0 && candidates.every(f => selected.has(f.checkId!));
          const needsReview = candidates.some(f => f.status === 'review');
          return <article className={`catalog-reuse-card ${checked ? 'selected' : ''}`} key={color.item.id}><label className="catalog-reuse-title"><input type="checkbox" aria-label={`共用到${color.item.colorName}`} disabled={!candidates.length || busy} checked={checked} onChange={e => { setSelected(current => { const next = new Set(current); for (const face of candidates) { if (e.target.checked) next.add(face.checkId!); else next.delete(face.checkId!); } return next; }); setReviewed(false); }} /><strong>{color.item.colorName}</strong><span>{!candidates.length ? (color.faces.every(f => f.reason.startsWith('已跟随')) ? '已跟随最新版' : color.faces.some(f => f.reason.includes('单独打点')) ? '单独打点 · 保留' : '保留当前状态') : needsReview ? '需要核对' : '轮廓已对齐，可套用'}</span></label>
            <div className="catalog-reuse-faces">{color.faces.map(face => <div key={face.face}><small>{face.face === 'front' ? '正面' : '背面'}{face.score !== null ? ` · 轮廓重合 ${Math.round(face.score * 1000) / 10}%` : ''}</small><StandardPreview item={color.item} crop={face.crop} specification={face.specification} /><p>{face.reason}</p></div>)}</div>
          </article>;
        })}</div>
        {!preview.colors.length && <p>这个款式尚无其他颜色。</p>}
      </div>
      <footer className="catalog-dialog-foot"><label className="catalog-check"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} disabled={busy} />已核对所选颜色的结构与位置，同意跟随代表色</label><button className="button primary" disabled={busy || !reviewed || !selected.size} type="button" onClick={() => void apply()}>{busy ? '正在保存…' : selected.size ? `套用到 ${selectedColors} 色 · ${selected.size} 面` : '没有需要套用的颜色'}</button></footer>
    </>}
  </section></div>;
}
