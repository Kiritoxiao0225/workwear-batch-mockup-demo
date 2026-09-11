'use client';
import Image from 'next/image';
import { useRef, useState, type PointerEvent } from 'react';
import type { SourceTaskRecord } from '@/lib/batch-task-review';
import type { ArtworkFontReference } from '@/lib/artwork-font-reference';

type Props = { source: SourceTaskRecord; reference?: ArtworkFontReference | null; change?: (reference: ArtworkFontReference | null) => void; disabled?: boolean; edit?: () => void };

function FontCrop({ url, reference, change, disabled }: { url: string; reference: ArtworkFontReference; change?: Props['change']; disabled?: boolean }) {
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  const [failed, setFailed] = useState(false);
  const [drag, setDrag] = useState<ArtworkFontReference['region']>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const region = drag ?? reference.region;
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) };
  };
  const bounds = (event: PointerEvent<HTMLDivElement>) => {
    const end = point(event), first = start.current!;
    return { x: Math.min(end.x, first.x), y: Math.min(end.y, first.y), width: Math.abs(end.x - first.x), height: Math.abs(end.y - first.y) };
  };
  if (failed) return <p role="alert">字体参考图片加载失败，请查看原素材后重试。</p>;
  return <>
    {change && <div style={{ position: 'relative', maxWidth: 420, touchAction: 'none', cursor: disabled ? 'default' : 'crosshair' }}
      onPointerDown={event => { if (disabled || event.button !== 0) return; start.current = point(event); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (start.current) setDrag(bounds(event)); }}
      onPointerUp={event => { if (!start.current) return; const next = bounds(event); start.current = null; setDrag(null); if (next.width > .005 && next.height > .005) change({ ...reference, region: next, origin: 'manual', evidence: '人工调整字体参考区域' }); }}
      onPointerCancel={() => { start.current = null; setDrag(null); }}>
      <Image src={url} alt="拖动框选要仿照的文字" width={1000} height={1000} unoptimized draggable={false} style={{ display: 'block', width: '100%', height: 'auto' }} onError={() => setFailed(true)} onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}/>
      {region && <span style={{ position: 'absolute', pointerEvents: 'none', border: '2px solid #22815b', background: '#22815b18', left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}/>}
    </div>}
    <div style={{ width: '100%', maxWidth: change ? 300 : 180, overflow: 'hidden' }}>
      <div style={{ position: 'relative', overflow: 'hidden', aspectRatio: String(region ? dimensions.width * region.width / (dimensions.height * region.height) : dimensions.width / dimensions.height), background: '#f1f3f0' }}>
        <Image src={url} alt={region ? '字体参考裁片' : '字体参考原图（尚未框选区域）'} width={1000} height={1000} unoptimized draggable={false} onError={() => setFailed(true)}
          onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          style={{ position: 'absolute', maxWidth: 'none', width: `${100 / (region?.width ?? 1)}%`, height: 'auto', left: `${-100 * (region?.x ?? 0) / (region?.width ?? 1)}%`, top: `${-100 * (region?.y ?? 0) / (region?.height ?? 1)}%` }}/>
      </div>
    </div>
  </>;
}

export function WpsFontReference({ source, reference, change, disabled, edit }: Props) {
  const material = source.materials.find(item => item.id === reference?.materialId);
  const url = material?.url ?? material?.previewUrl;
  if (!reference && !change) return null;
  return <div className="wps-font-reference" style={{ display: 'grid', gap: 8, marginBlock: 10 }}>
    {change ? <label><span>字体参考图</span><select disabled={disabled} value={reference?.materialId ?? ''} onChange={event => change(event.target.value ? {
      materialId: event.target.value, region: null, description: '', evidence: '人工指定字体参考图', origin: 'manual',
    } : null)}><option value="">不指定字体参考</option>{source.materials.map((item, index) => <option key={item.id} value={item.id}>图{index + 1} · {item.description}</option>)}</select></label>
      : <strong>字体参考：{material ? `图${source.materials.indexOf(material) + 1}` : '素材缺失'}{reference?.origin === 'visual' ? ' · AI 建议' : ''}</strong>}
    {reference && <>
      {url && <FontCrop key={url} url={url} reference={reference} change={change} disabled={disabled}/>}
      {change ? <><small>在原图上拖动，圈住要仿照的完整文字；下方展示实际参考区域。</small>
        {reference.region && <button type="button" disabled={disabled} onClick={() => change({ ...reference, region: null, origin: 'manual' })}>取消框选，使用原图</button>}
        <label><span>参考区域与字形特点</span><textarea disabled={disabled} maxLength={500} rows={2} value={reference.description} onChange={event => change({ ...reference, description: event.target.value, origin: 'manual' })}/></label></>
        : <><small>{reference.region ? '已框选文字区域' : '使用原图 · 未框选区域'}{reference.description ? `：${reference.description}` : ''}</small>{edit && <button type="button" disabled={disabled} onClick={edit}>修改字体参考</button>}</>}
      {reference.evidence && <small>{reference.origin === 'visual' ? '判断依据：' : ''}{reference.evidence}</small>}
    </>}
  </div>;
}
