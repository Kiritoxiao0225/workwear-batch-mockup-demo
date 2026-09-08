'use client';
import { useState, useId } from 'react';
import type { CatalogStyle } from '@/lib/catalog';
import type { ProductionUnit } from '@/lib/wps-production';
import { productionPositionLabel } from '@/lib/production-garment';
import { taskPlacementAnchor } from '@/lib/production-preview';
import { useProjectSession } from '@/components/project-session';

export function WpsGarmentPreview({ unit, units = [unit], open }: { unit: ProductionUnit; units?: ProductionUnit[]; open?: () => void }) {
  const session = useProjectSession();
  const previewId = useId();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const garment = unit.garment;
  if (!garment) return <div className="wps-garment-empty">选好款式和颜色后，选择印花位置</div>;
  if (!session.initialized) return <div className="wps-image-notice" role="status">正在读取服装底图…</div>;
  if (!session.user) return <div className="wps-image-notice"><button type="button" onClick={() => void session.refresh()}>重新连接工作台</button></div>;
  const imageKey = `${garment.imageUrl}:${session.user.id}`;
  if (failedImage === imageKey) return <div className="wps-image-notice" role="alert"><strong>服装底图暂时无法读取</strong><button type="button" onClick={() => setFailedImage(null)}>重新读取</button></div>;
  return <button className="wps-garment-open" type="button" onClick={open} disabled={!open} aria-label={`批量调整${garment.styleCode} ${garment.colorName} ${unit.variantLabel}的印花位置`}>
    <span className="wps-garment-faces">{(['front', 'back'] as const).map(face => {
      const view = garment.views.find(view => view.face === face);
      return <span className="wps-garment-face" key={face}><span>{face === 'front' ? '正面' : '背面'}</span>{view ? <svg viewBox={`${view.crop.x * garment.width} ${view.crop.y * garment.height} ${view.crop.width * garment.width} ${view.crop.height * garment.height}`} role="img" aria-label={`${garment.styleCode} ${face === 'front' ? '正面' : '背面'}`}>
        <defs><clipPath id={`${previewId}-${face}`}><rect x={view.crop.x * garment.width} y={view.crop.y * garment.height} width={view.crop.width * garment.width} height={view.crop.height * garment.height}/></clipPath></defs>
        <g clipPath={`url(#${previewId}-${face})`}><image href={garment.imageUrl} width={garment.width} height={garment.height} onError={() => setFailedImage(imageKey)} />
          {units.filter(candidate => candidate.placement && (candidate.placement.key === 'back' ? 'back' : 'front') === face).map(candidate => {
            let anchor;
            try { anchor = taskPlacementAnchor({ ...candidate, garment }); } catch { return null; }
            const x = (view.crop.x + anchor.centerX * view.crop.width) * garment.width;
            const y = (view.crop.y + anchor.centerY * view.crop.height) * garment.height;
            const label = productionPositionLabel(candidate.placement!);
            const fontSize = Math.min(garment.width / 18, view.crop.width * garment.width / (label.length + 1.5));
            const labelWidth = (label.length + 1) * fontSize;
            const labelX = Math.max(view.crop.x * garment.width + labelWidth / 2, Math.min(x, (view.crop.x + view.crop.width) * garment.width - labelWidth / 2));
            return <g key={candidate.id}>
              <circle cx={x} cy={y} r={garment.width / 95} fill="#176b46" stroke="white" strokeWidth={garment.width / 400}/>
              <rect x={labelX - labelWidth / 2} y={y + fontSize * .6} width={labelWidth} height={fontSize * 1.5} rx={fontSize / 4} fill="white" fillOpacity=".94"/>
              <text x={labelX} y={y + fontSize * 1.7} textAnchor="middle" fontSize={fontSize} fill="#21583b" fontWeight="600">{label}</text>
            </g>;
          })}
        </g>
      </svg> : <span className="wps-face-missing">暂无底图</span>}</span>;
    })}</span><span className="wps-garment-open-hint">批量调整位置 ↗</span>
  </button>;
}

export function WpsGarmentSelector({ unit, styles, busy, select }: { unit: ProductionUnit; styles: CatalogStyle[]; busy: boolean; select: (variantId: string, assetVersionId?: string) => void }) {
  const [chosenStyleId, setChosenStyleId] = useState<string | null>(null);
  const styleId = chosenStyleId ?? unit.garment?.styleId ?? '';
  const style = styles.find(style => style.id === styleId);
  const variantId = unit.garment?.styleId === styleId ? unit.garment.variantId : '';
  return <div className="wps-garment-selectors">
    <label>衣服款式<select aria-label={`${unit.id} 衣服款式`} disabled={busy || !styles.length} value={styleId} onChange={event => setChosenStyleId(event.target.value)}><option value="">请选择款式</option>{!style && unit.garment && styleId === unit.garment.styleId && <option value={styleId}>{unit.garment.styleCode}（已保存）</option>}{styles.map(style => <option key={style.id} value={style.id}>{style.styleCode}{styles.some(other => other.id !== style.id && other.styleCode === style.styleCode) ? ` · ${style.namespace}` : ''}</option>)}</select></label>
    <label>衣服颜色<select aria-label={`${unit.id} 衣服颜色`} disabled={busy || !style} value={variantId} onChange={event => { if (event.target.value) select(event.target.value); }}><option value="">请选择颜色</option>{variantId && unit.garment && !style?.colors.some(color => color.id === variantId) && <option value={variantId}>{unit.garment.colorName}（已保存）</option>}{style?.colors.map(color => <option key={color.id} value={color.id}>{color.colorName}</option>)}</select></label>
    {unit.garment?.selection === 'provisional' && <small>颜色暂选，请核对。</small>}
  </div>;
}
