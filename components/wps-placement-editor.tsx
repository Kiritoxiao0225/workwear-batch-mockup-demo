'use client';
import { useRef, useState, type PointerEvent } from 'react';
import type { ProductionPlacement, ProductionUnit } from '@/lib/wps-production';
import { MOCKUP_SIZE_POLICY, defaultPrintSize, printSizeCm } from '@/lib/production-sizing';
import { artworkAspectRatio, artworkContentBounds, initialTaskPlacement, placementPreview, productionPreviewCalibrationKey } from '@/lib/production-preview';
import { WpsTextSizeNotice } from '@/components/wps-text-size-notice';
import { catalogPositionKey, drawnPlacement, placementFace, productionPositionLabel } from '@/lib/production-garment';
import { POSITION_LABELS } from '@/lib/catalog';
import { PLACEMENT_DEFAULTS, PLACEMENT_LABELS } from '@/lib/mockup';
import { artworkAcceptanceIssues } from '@/lib/artwork-acceptance';
import { PLACEMENT_KEYS, type PlacementKey } from '@/lib/types';
import { bindPrintSizeRequest } from '@/lib/print-size-request';

export type PlacementUpdate = { unitId: string; placement: ProductionPlacement; expectedCalibration?: string };
type Props = { unit: ProductionUnit; versionUnits: ProductionUnit[]; requirementText?: string; busy: boolean; composing?: boolean; error: string | null; edit: (unit: ProductionUnit) => void; close: () => void; save: (updates: PlacementUpdate[], confirmWholeVersion: boolean) => Promise<void> };

export function WpsPlacementEditor({ unit: openingUnit, versionUnits, requirementText, busy, composing, error, edit, close, save }: Props) {
  const garment = openingUnit.garment!;
  const [activeId, setActiveId] = useState(openingUnit.id);
  const unit = versionUnits.find(candidate => candidate.id === activeId) ?? openingUnit;
  const activeGarment = unit.garment ?? garment;
  const dimensions = unit.artwork?.validation ?? { width: 1, height: 1 };
  const [drafts, setDrafts] = useState<Record<string, ProductionPlacement>>({});
  const [inputError, setInputError] = useState<string | null>(null);
  const [imageStatus, setImageStatus] = useState<Record<string, 'loaded' | 'failed'>>({});
  const imageUrls = [garment.imageUrl, ...versionUnits.flatMap(candidate => candidate.artwork ? [candidate.artwork.url] : [])];
  const imagesReady = imageUrls.every(url => imageStatus[url] === 'loaded');
  const imageEvent = (url: string, status: 'loaded' | 'failed') => setImageStatus(current => ({ ...current, [url]: status }));
  const basePlacement = (candidate: ProductionUnit) => {
    const value = candidate.placement ?? { key: 'frontCenter' as const, ...PLACEMENT_DEFAULTS.frontCenter, sizeMode: 'standard' as const, templateVersion: 'catalog-v1' as const };
    return requirementText === undefined ? value : bindPrintSizeRequest(requirementText, value);
  };
  const initial = (candidate: ProductionUnit) => initialTaskPlacement({ ...candidate, garment: candidate.garment ?? garment, placement: basePlacement(candidate) }, candidate.artwork?.validation ?? { width: 1, height: 1 });
  const placement = drafts[unit.id] ?? initial(unit);
  const aspectRatio = artworkAspectRatio(dimensions);
  const size = printSizeCm(placement, aspectRatio);
  const requested = placement.requestedSize;
  // Caps and aprons: the catalog's drawn positions, sized relative to the sample logo drawn there.
  const drawn = drawnPlacement(activeGarment, placement);
  const sizeLocked = !drawn && Boolean(requested && !placement.sizeOverride);
  const defaults = defaultPrintSize(placement);
  let drawnDefaultWidth = 0;
  if (drawn) { try { drawnDefaultWidth = initialTaskPlacement({ ...unit, garment: activeGarment, placement: { ...placement, manual: undefined, offsetX: 0, offsetY: 0 } }, dimensions).manual!.width; } catch { /* shown as placementError */ } }
  const drawnPercent = drawnDefaultWidth > 0 && placement.manual ? Math.round(placement.manual.width / drawnDefaultWidth * 100) : 100;
  const scaleDrawn = (percent: number) => {
    if (!Number.isFinite(percent) || percent < 10 || percent > 400) { setInputError('大小请填 10–400%'); return; }
    change({ ...placement, manual: { ...placement.manual!, width: drawnDefaultWidth * percent / 100 } });
  };
  const drawnOptions = drawn ? activeGarment.views.flatMap(view => (view.standard?.specification.positions ?? []).map(p => ({ value: `${view.face === 'back' ? 'back' : 'frontCenter'}:${p.key}`, label: POSITION_LABELS[p.key] }))) : [];
  const positionValue = drawn ? `${placement.key === 'back' ? 'back' : 'frontCenter'}:${catalogPositionKey(placement, placementFace(activeGarment, placement)?.standard?.specification.structureType)}`
    : placement.key === 'back' ? `back:${placement.catalogPosition ?? 'backCenter'}` : placement.key;
  const face = activeGarment.views.find(view => view.face === (placement.key === 'back' ? 'back' : 'front'))!;
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<{ mode: 'move' | 'resize'; x: number; y: number; centerX: number; centerY: number; widthCm: number; manualWidth: number; radius: number; anchorX: number; anchorY: number } | null>(null);
  const change = (next: ProductionPlacement) => { setInputError(null); setDrafts(current => ({ ...current, [unit.id]: next })); };
  const resize = (axis: 'widthCm' | 'heightCm', value: number) => {
    try {
      if (sizeLocked) throw new Error('当前沿用客户尺寸；如需调整大小，请先选择自定义尺寸');
      const next = { ...placement, sizePolicy: MOCKUP_SIZE_POLICY, sizeMode: axis, [axis]: value };
      if (axis === 'widthCm') delete next.heightCm;
      if (!Number.isFinite(value) || value <= 0) throw new Error('请输入大于 0 的厘米尺寸');
      const result = printSizeCm(next, aspectRatio);
      if (result.width < 1 || result.width > 50) throw new Error('图案宽度需在 1–50 cm 之间');
      change(next);
    } catch (error) { setInputError(error instanceof Error ? error.message : String(error)); }
  };
  const point = (event: PointerEvent) => {
    const matrix = svgRef.current?.getScreenCTM();
    if (!matrix) throw new Error('衣服画布坐标未准备好');
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  };
  const selectPosition = (value: string) => {
    const [key, catalogPosition] = value.split(':') as [PlacementKey, ProductionPlacement['catalogPosition']];
    const next: ProductionPlacement = { ...placement, key, catalogPosition, manual: undefined, offsetX: 0, offsetY: 0, rotation: 0 };
    change(initialTaskPlacement({ ...unit, garment: activeGarment, placement: requirementText === undefined ? next : bindPrintSizeRequest(requirementText, next) }, dimensions));
  };
  let placementError: string | null = null;
  try { placementPreview(activeGarment, placement, dimensions); } catch (error) { placementError = error instanceof Error ? error.message : String(error); }
  const complete = versionUnits.every(candidate => candidate.artwork?.validation.valid && candidate.artwork.recipeFingerprint === candidate.recipeFingerprint && !artworkAcceptanceIssues(candidate.artwork.validation).length);
  const submit = (confirmWholeVersion: boolean) => {
    const updates: Record<string, ProductionPlacement> = {};
    for (const candidate of versionUnits) {
      try {
        const value = drafts[candidate.id] ?? initial(candidate);
        placementPreview(candidate.garment ?? garment, value, candidate.artwork?.validation ?? { width: 1, height: 1 });
        updates[candidate.id] = value;
      } catch (error) { setActiveId(candidate.id); setInputError(error instanceof Error ? error.message : String(error)); return; }
    }
    void save(Object.entries(updates).map(([unitId, placement]) => ({ unitId, placement,
      expectedCalibration: productionPreviewCalibrationKey([versionUnits.find(candidate => candidate.id === unitId)!]),
    })), confirmWholeVersion);
  };
  return <div className="wps-review-backdrop"><section className="wps-review-dialog wps-placement-dialog" role="dialog" aria-modal="true" aria-labelledby="wps-placement-title">
    <header><div><small>同一件衣服 · 正反面一起调整</small><h2 id="wps-placement-title">{garment.styleCode} · {garment.colorName}</h2></div><button disabled={busy} onClick={close} type="button">关闭</button></header>
    <div className="wps-placement-body"><div className="wps-placement-stage">
      <div className="wps-position-tabs" aria-label="本件印花位置">{versionUnits.map(candidate => <button key={candidate.id} type="button" disabled={busy} aria-pressed={candidate.id === unit.id} onClick={() => { setActiveId(candidate.id); setInputError(null); }}>{candidate.placement ? productionPositionLabel(drafts[candidate.id] ?? candidate.placement, candidate.garment ?? garment) : '位置待定'}{drafts[candidate.id] ? ' · 已调整' : ''}</button>)}</div>
      <p>拖动图案调整位置；有客户尺寸时保持比例大小，选择自定义尺寸后可拖动右下角缩放。正反面一起保存。</p>
      {!imagesReady && <p role="status">{imageUrls.some(url => imageStatus[url] === 'failed') ? '部分图片加载失败，请关闭后重新打开。' : '正在加载衣服与图案…'}</p>}
      <svg ref={svgRef} className="wps-placement-canvas" data-images-ready={imagesReady} viewBox={`0 0 ${garment.width} ${garment.height}`} role="group" aria-label="衣服与 Logo 位置调整画布">
        <image href={garment.imageUrl} width={garment.width} height={garment.height} onLoad={() => imageEvent(garment.imageUrl, 'loaded')} onError={() => imageEvent(garment.imageUrl, 'failed')}/>
        {versionUnits.map(candidate => {
          const selected = candidate.id === unit.id;
          const candidateDimensions = candidate.artwork?.validation ?? { width: 1, height: 1 };
          let candidatePlacement: ProductionPlacement, geometry;
          try { candidatePlacement = selected ? placement : drafts[candidate.id] ?? initial(candidate); geometry = placementPreview(candidate.garment ?? garment, candidatePlacement, candidateDimensions); }
          catch { return null; }
          const content = artworkContentBounds(candidateDimensions);
          const endDrag = () => { dragging.current = null; };
          return <g key={candidate.id} role="button" aria-label={`调整${productionPositionLabel(candidatePlacement, candidate.garment ?? garment)}图案`} aria-pressed={selected} tabIndex={busy ? -1 : 0} onKeyDown={event => { if (!busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setActiveId(candidate.id); setInputError(null); } }} transform={`translate(${geometry.centerX} ${geometry.centerY}) rotate(${candidatePlacement.rotation})`} style={{ cursor: selected ? 'grab' : 'pointer', touchAction: 'none' }}
            onPointerDown={event => {
              if (busy) return;
              if (!selected) { setActiveId(candidate.id); setInputError(null); }
              const start = point(event);
              const mode = (event.target as Element).getAttribute('data-resize') ? 'resize' : 'move';
              dragging.current = { mode, x: start.x, y: start.y, centerX: candidatePlacement.manual!.centerX, centerY: candidatePlacement.manual!.centerY, widthCm: printSizeCm(candidatePlacement, artworkAspectRatio(candidateDimensions)).width, manualWidth: candidatePlacement.manual!.width, radius: Math.hypot(start.x - geometry.centerX, start.y - geometry.centerY), anchorX: geometry.centerX, anchorY: geometry.centerY };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
              const start = dragging.current;
              if (!selected || !start || busy) return;
              const cursor = point(event);
              if (start.mode === 'resize' && drawn) { change({ ...placement, manual: { ...placement.manual!, width: Math.max(.005, Math.min(1, start.manualWidth * Math.hypot(cursor.x - start.anchorX, cursor.y - start.anchorY) / Math.max(1, start.radius))) } }); return; }
              if (start.mode === 'resize') { resize('widthCm', Math.min(50, Math.max(1, start.widthCm * Math.hypot(cursor.x - start.anchorX, cursor.y - start.anchorY) / Math.max(1, start.radius)))); return; }
              change({ ...placement, manual: { ...placement.manual!, centerX: Math.min(.95, Math.max(.05, start.centerX + (cursor.x - start.x) / (garment.width * face.crop.width))), centerY: Math.min(.95, Math.max(.05, start.centerY + (cursor.y - start.y) / (garment.height * face.crop.height))) } });
            }} onPointerUp={endDrag} onPointerCancel={endDrag}>
            <rect x={-Math.max(geometry.width + 10, garment.width / 22) / 2} y={-geometry.height / 2 - garment.width / 30} width={Math.max(geometry.width + 10, garment.width / 22)} height={geometry.height + garment.width / 30 + 5} fill="transparent" pointerEvents="all"/>
            {candidate.artwork ? <svg x={-geometry.width / 2} y={-geometry.height / 2} width={geometry.width} height={geometry.height} viewBox={`${content.left} ${content.top} ${content.width} ${content.height}`}><image href={candidate.artwork.url} width={candidateDimensions.width} height={candidateDimensions.height} onLoad={() => imageEvent(candidate.artwork!.url, 'loaded')} onError={() => imageEvent(candidate.artwork!.url, 'failed')}/></svg> : <rect x={-geometry.width / 2} y={-geometry.height / 2} width={geometry.width} height={geometry.height} fill="#176b4633"/>}
            <text x={0} y={-geometry.height / 2 - garment.width / 80} textAnchor="middle" fontSize={garment.width / 65} fill="#176b46" stroke="white" strokeWidth={garment.width / 500} paintOrder="stroke">{productionPositionLabel(candidatePlacement, candidate.garment ?? garment)}</text>
            <rect x={-geometry.width / 2 - 5} y={-geometry.height / 2 - 5} width={geometry.width + 10} height={geometry.height + 10} fill="transparent" stroke={selected ? '#16815b' : '#66796d'} strokeWidth={garment.width / 400} strokeDasharray={selected ? undefined : '8 5'}/>
            {selected && !sizeLocked && <rect data-resize="true" x={geometry.width / 2 - garment.width / 110} y={geometry.height / 2 - garment.width / 110} width={garment.width / 55} height={garment.width / 55} fill="white" stroke="#16815b" strokeWidth={garment.width / 400} style={{ cursor: 'nwse-resize' }}/>}
          </g>;
        })}
      </svg>
      {!unit.artwork && <p className="wps-compact-notice">图案尚未制作，色框表示预计位置。图案完成后再核对实际大小。</p>}
    </div><aside>
      <label className="wps-position-select">印花位置<select aria-label="印花位置" disabled={busy} value={positionValue} onChange={event => selectPosition(event.target.value)}>{drawn ? drawnOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>) : PLACEMENT_KEYS.filter(key => garment.views.some(view => view.face === (key === 'back' ? 'back' : 'front'))).flatMap(key => key === 'back' ? [<option key="back" value="back:backCenter">后背居中</option>, <option key="upperBack" value="back:upperBack">后背上方</option>] : [<option key={key} value={key}>{PLACEMENT_LABELS[key]}</option>])}</select></label>
      {!drawn && (requested || placement.requestedSizeIssue) && <div className="wps-size-request">
        {requested && <p><strong>客户要求：{requested.axis === 'heightCm' ? '高' : '宽'} {requested.valueCm} cm</strong><br/><small>原文：{requested.evidence}{requested.inferredUnit ? '（单位已根据同一句尺寸或位置距离补全，按厘米显示）' : ''}</small></p>}
        {placement.requestedSizeIssue && <p>{placement.requestedSizeIssue}</p>}
        <label><input type="checkbox" checked={Boolean(placement.sizeOverride)} disabled={busy} onChange={event => {
          const next = { ...placement, sizeOverride: event.target.checked, sizeMode: 'widthCm' as const, widthCm: size.width, heightCm: undefined };
          change(event.target.checked || requirementText === undefined ? next : bindPrintSizeRequest(requirementText, next));
        }}/>自定义尺寸（覆盖客户要求）</label>
        {placement.sizeOverride && <p role="status">本次采用自定义尺寸，客户原要求仍保留供核对。</p>}
      </div>}
      {drawn ? <><div className="wps-placement-dimensions"><label>大小（%）<input aria-label="图案大小（相对示例 Logo）" type="number" min="10" max="400" step="1" disabled={busy} value={drawnPercent} onChange={event => scaleDrawn(Number(event.target.value))}/></label></div>
      <small>100% 为商品素材库里这个位置的示例 Logo 大小；帽子、围裙按相对大小，不换算厘米</small></> : <><div className="wps-placement-dimensions"><label>宽度（cm）<input aria-label="图案宽度（cm）" type="number" min="1" max="50" step="0.1" disabled={busy || sizeLocked} value={Number(size.width.toFixed(2))} onChange={event => resize('widthCm', Number(event.target.value))}/></label><label>高度（cm）<input aria-label="图案高度（cm）" type="number" min="0.1" max="100" step="0.1" disabled={busy || sizeLocked} value={Number(size.height.toFixed(2))} onChange={event => resize('heightCm', Number(event.target.value))}/></label></div>
      <small>宽高等比例联动 · 衣身按 55 cm 换算</small></>}
      <label>旋转 {placement.rotation}°<input aria-label="Logo 旋转" type="range" min="-45" max="45" disabled={busy} value={placement.rotation} onChange={event => change({ ...placement, rotation: Number(event.target.value) })}/></label>
      <button type="button" disabled={busy} onClick={() => change({ ...initialTaskPlacement({ ...unit, garment: activeGarment, placement: { ...placement, manual: undefined, offsetX: 0, offsetY: 0, rotation: 0, sizeMode: 'standard', sizeOverride: false } }, dimensions) })}>{requested && !drawn ? '恢复默认位置与客户尺寸' : '恢复默认位置与尺寸'}</button>
      <small>{drawn ? '默认放在素材库画好的位置，大小同示例 Logo。' : requested ? '客户尺寸优先，仅在上衣贴图时等比缩放；不重新制作或抠图。' : `未指定尺寸时，默认装入 ${defaults.width} × ${defaults.height} cm 范围`}</small>
      {unit.artwork && <><button disabled={busy} type="button" onClick={() => edit(unit)}>编辑这个图案</button><details><summary>小字检查</summary><WpsTextSizeNotice unit={unit} placement={placement} edit={() => edit(unit)}/></details></>}
      <details><summary>位置参考说明</summary><p>{face.standard ? '已有位置标准，系统会检查可印范围和已标记禁区。' : '本款暂无通用标准，请目视避开领口、门襟、口袋和缝线。'}</p><p>当前操作只修改本次任务的位置。</p></details>
      {(inputError || placementError || error) && <p className="error-banner" role="alert">{inputError ?? placementError ?? error}</p>}
    </aside></div>
    <footer><span role="status">{composing ? '位置已保存，正在合成并保存客户图…' : busy ? '正在核对并保存图案与位置…' : complete ? '请核对本件全部图案的文字、颜色、大小与位置；保存后一起生成客户图。' : '图案尚未做齐或存在制作问题，可先保存整件的位置草稿。'}</span><div><button className={complete ? undefined : 'primary'} disabled={busy || Boolean(inputError || placementError)} onClick={() => submit(false)} type="button">{busy && !composing ? '正在保存…' : '保存草稿'}</button>{complete && <button className="primary" disabled={busy || Boolean(inputError || placementError)} onClick={() => submit(true)} type="button">{composing ? '正在生成客户图…' : busy ? '正在保存…' : '保存并生成客户图'}</button>}</div></footer>
  </section></div>;
}
