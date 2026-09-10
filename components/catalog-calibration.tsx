'use client';
import { fetchApi, readApiJson } from '@/lib/client/api-response';

import { useEffect, useRef, useState } from 'react';
import { allowedPositions, POSITION_LABELS, STRUCTURE_LABELS, type Box, type CatalogStyle, type CatalogDetail, type CatalogUser, type CatalogView, type PlacementStandard, type Point, type PositionKey, type StructureType } from '@/lib/catalog';
import { CatalogImagePreview } from '@/components/catalog-image-preview';
import { catalogApronRecognitionResponseSchema } from '@/lib/catalog-apron-recognition';
import { CatalogReuse } from '@/components/catalog-reuse';
import { catalogReferenceType, positionFromImageBox, suggestedPlacement, type CatalogPlacementPreview } from '@/lib/catalog-placement-suggestions';

type Layer = 'all' | 'placement' | 'structure';
type Drag = { kind: 'frame' | 'landmark' | 'anchor' | 'area' | 'exclusion'; index: number; resize?: boolean };
function localPoint(p: Point, frame: Box): Point { return { x: frame.x + p.x * frame.width, y: frame.y + p.y * frame.height }; }
function localBox(b: Box, frame: Box): Box { return { ...localPoint(b, frame), width: b.width * frame.width, height: b.height * frame.height }; }
const clamp = (n: number, max = 1) => Math.max(0, Math.min(max, n));

function FaceCanvas({ detail, view, spec, active, editable, layer, selectedKey, status, activate, selectPosition, change, drawingBoundary, finishBoundary }: {
  detail: CatalogDetail; view: CatalogView; spec: PlacementStandard; active: boolean; editable: boolean; layer: Layer;
  selectedKey: PositionKey | null; status: string; activate: () => void; selectPosition: (key: PositionKey) => void; change: (next: PlacementStandard) => void; drawingBoundary: boolean; finishBoundary: (box: Box) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ target: Drag; from: Point; original: PlacementStandard } | null>(null);
  const boundaryStart = useRef<Point | null>(null);
  const [boundaryBox, setBoundaryBox] = useState<Box | null>(null);
  const frame = spec.garmentFrame;
  function boundaryAt(event: React.PointerEvent): Box | null {
    const start = boundaryStart.current;
    if (!start) return null;
    const end = atPointer(event);
    return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
  }
  function beginBoundary(event: React.PointerEvent) {
    if (!drawingBoundary || !editable) return;
    event.stopPropagation(); activate();
    boundaryStart.current = atPointer(event); setBoundaryBox(null);
    svg.current!.setPointerCapture(event.pointerId);
  }
  function endPointer(event: React.PointerEvent) {
    if (drawingBoundary && boundaryStart.current) {
      const box = boundaryAt(event);
      boundaryStart.current = null; setBoundaryBox(null);
      if (box && box.width >= .02 && box.height >= .02) finishBoundary(box);
    }
    drag.current = null;
  }
  const faceLabel = view.face === 'front' ? '正面' : '背面';
  const aspect = detail.width * view.crop.width / (detail.height * view.crop.height);
  const canvasHeight = 1000 / aspect;
  function atPointer(event: React.PointerEvent): Point {
    const point = svg.current!.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    const mapped = point.matrixTransform(svg.current!.getScreenCTM()!.inverse());
    return { x: clamp(mapped.x / 1000), y: clamp(mapped.y / canvasHeight) };
  }
  function start(event: React.PointerEvent, target: Drag) {
    event.stopPropagation(); activate();
    if (target.kind === 'anchor' || target.kind === 'area') selectPosition(spec.positions[target.index].key);
    if (!editable || (target.kind === 'frame' && layer !== 'structure')) return;
    drag.current = { target, from: atPointer(event), original: structuredClone(spec) };
    svg.current!.setPointerCapture(event.pointerId);
  }
  function move(event: React.PointerEvent) {
    if (drawingBoundary && boundaryStart.current) { setBoundaryBox(boundaryAt(event)); return; }
    const gesture = drag.current;
    if (!gesture || !editable) return;
    const { target, original, from } = gesture;
    const canvas = atPointer(event);
    const dx = (canvas.x - from.x) / (target.kind === 'frame' ? 1 : original.garmentFrame.width);
    const dy = (canvas.y - from.y) / (target.kind === 'frame' ? 1 : original.garmentFrame.height);
    const next = structuredClone(original);
    const box = target.kind === 'frame' ? next.garmentFrame : target.kind === 'area' ? next.positions[target.index].printableArea : target.kind === 'exclusion' ? next.exclusions[target.index].area : null;
    if (box) {
      if (target.resize) { box.width = Math.max(.005, Math.min(1 - box.x, box.width + dx)); box.height = Math.max(.005, Math.min(1 - box.y, box.height + dy)); }
      else {
        const x = clamp(box.x + dx, 1 - box.width); const y = clamp(box.y + dy, 1 - box.height);
        if (target.kind === 'area') { const anchor = next.positions[target.index].anchor; anchor.x += x - box.x; anchor.y += y - box.y; }
        box.x = x; box.y = y;
      }
    } else {
      const point = target.kind === 'landmark' ? next.landmarks[target.index].point : next.positions[target.index].anchor;
      point.x = clamp(point.x + dx); point.y = clamp(point.y + dy);
    }
    change(next);
  }
  function rectangle(b: Box, target: Drag, className: string, label: string) {
    const draggable = editable && (target.kind !== 'frame' || layer === 'structure');
    // eslint-disable-next-line react-hooks/refs -- Refs are read only in the deferred pointer event, never during rendering.
    return <g><rect x={b.x * 1000} y={b.y * 1000} width={b.width * 1000} height={b.height * 1000} className={className} aria-label={label} onPointerDown={event => start(event, target)} />{draggable && <rect x={(b.x + b.width) * 1000 - 9} y={(b.y + b.height) * 1000 - 9} width="18" height="18" className="cal-resize" aria-label={`调整${label}大小`} onPointerDown={event => start(event, { ...target, resize: true })} />}</g>;
  }
  return <section className={`cal-face ${active ? 'active' : ''}`}>
    <button type="button" className="cal-face-title" onClick={activate}><strong>{faceLabel}</strong><span>{status}</span></button>
    <div className="cal-canvas-fit"><svg ref={svg} className={`cal-canvas ${drawingBoundary ? 'cal-drawing-boundary' : ''}`} viewBox={`0 0 1000 ${canvasHeight}`} preserveAspectRatio="xMidYMid meet" role="group" aria-label={`${faceLabel}印花位置与避让区域`} onPointerDownCapture={beginBoundary} onPointerDown={activate} onPointerMove={move} onPointerUp={endPointer} onPointerCancel={() => { drag.current = null; boundaryStart.current = null; setBoundaryBox(null); }}>
      <g transform={`scale(1 ${1 / aspect})`}><defs><clipPath id={`face-crop-${view.id}`}><rect width="1000" height="1000" /></clipPath><pattern id={`danger-${view.id}`} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="12" height="12" fill="#fff2ee66" /><rect width="4" height="12" fill="#c94e4666" /></pattern></defs>
      <image clipPath={`url(#face-crop-${view.id})`} href={detail.thumbnailUrl} x={-view.crop.x / view.crop.width * 1000} y={-view.crop.y / view.crop.height * 1000} width={1000 / view.crop.width} height={1000 / view.crop.height} preserveAspectRatio="none" />
      <image clipPath={`url(#face-crop-${view.id})`} href={detail.imageUrl} x={-view.crop.x / view.crop.width * 1000} y={-view.crop.y / view.crop.height * 1000} width={1000 / view.crop.width} height={1000 / view.crop.height} preserveAspectRatio="none" />
      {layer !== 'placement' && rectangle(frame, { kind: 'frame', index: 0 }, 'cal-frame', '衣服边界')}
      {spec.exclusions.map((e, index) => { const box = localBox(e.area, frame); return <g key={e.id} style={{ '--cal-danger-fill': `url(#danger-${view.id})` } as React.CSSProperties}>{rectangle(box, { kind: 'exclusion', index }, 'cal-exclusion', e.label)}<text className="cal-exclusion-label" x={(box.x + box.width / 2) * 1000} y={box.y * 1000 + 22} textAnchor="middle">{e.label}</text></g>; })}
      {layer !== 'structure' && spec.positions.map((p, index) => {
        const point = localPoint(p.anchor, frame);
        const preview = localBox({ x: p.anchor.x - p.defaultSize.width / 2, y: p.anchor.y - p.defaultSize.height / 2, ...p.defaultSize }, frame);
        const box = localBox(p.printableArea, frame);
        return <g key={p.key} className={active && selectedKey === p.key ? 'cal-selected-position' : ''}>
          {rectangle(box, { kind: 'area', index }, 'cal-print-area', `${POSITION_LABELS[p.key]}可印范围`)}
          <rect x={preview.x * 1000} y={preview.y * 1000} width={preview.width * 1000} height={preview.height * 1000} className="cal-logo-size" />
          <circle cx={point.x * 1000} cy={point.y * 1000} r="12" className="cal-anchor" aria-label={POSITION_LABELS[p.key]} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); selectPosition(p.key); } }} onPointerDown={event => start(event, { kind: 'anchor', index })} />
          <text className="cal-position-label" x={point.x * 1000} y={(box.y + box.height) * 1000 + 25} textAnchor="middle">{POSITION_LABELS[p.key]}</text>
        </g>;
      })}
      {layer !== 'placement' && spec.landmarks.map((p, index) => { const point = localPoint(p.point, frame); return <g key={p.key}><circle cx={point.x * 1000} cy={point.y * 1000} r="10" className="cal-point" aria-label={p.label} onPointerDown={event => start(event, { kind: 'landmark', index })} /><text x={point.x * 1000 + 14} y={point.y * 1000 > 950 ? point.y * 1000 - 14 : point.y * 1000 + 30}>{p.label}</text></g>; })}
      {drawingBoundary && boundaryBox && <rect className="cal-boundary-selection" x={boundaryBox.x * 1000} y={boundaryBox.y * 1000} width={boundaryBox.width * 1000} height={boundaryBox.height * 1000} />}
      </g>
    </svg></div>
  </section>;
}
function Percent({ label, value, change }: { label: string; value: number; change: (value: number) => void }) {
  return <label className="cal-number"><span>{label}</span><input type="number" min="0" max="100" step="0.1" value={Number.isFinite(value) ? Math.round(value * 10000) / 100 : ''} onChange={event => change(Number(event.target.value) / 100)} /><small>%</small></label>;
}
function BoxFields({ value, change }: { value: Box; change: (value: Box) => void }) {
  return <div className="cal-four">{(['x', 'y', 'width', 'height'] as const).map((key, i) => <Percent key={key} label={['X', 'Y', '宽', '高'][i]} value={value[key]} change={n => change({ ...value, [key]: n })} />)}</div>;
}
export function CatalogCalibration({ detail, preview, style, user, close, saved, replace, addColor, loadVersion, selectColor }: { detail: CatalogDetail; preview: CatalogPlacementPreview; style: CatalogStyle; user: CatalogUser; close: () => void; saved: (id: string) => Promise<void>; replace: () => void; addColor: () => void; loadVersion: (assetVersionId: string) => void; selectColor: (id: string) => void }) {
  const [reuse, setReuse] = useState(false);
  const [imagePreview, setImagePreview] = useState(false);
  const [layer, setLayer] = useState<Layer>('placement');
  const [drawingBoundaryId, setDrawingBoundaryId] = useState<string | null>(null);
  const [drawingPositionKey, setDrawingPositionKey] = useState<PositionKey | null>(null);
  const [manualBoundaries, setManualBoundaries] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<PositionKey | null>(null);
  const [reviewedViews, setReviewedViews] = useState<Set<string>>(new Set());
  const dirtyRef = useRef(new Set<string>());
  const [specs, setSpecs] = useState<Record<string, PlacementStandard>>(() => Object.fromEntries(detail.views.map(v => [v.id, v.latest?.specification ?? preview.faces.find(f => f.viewId === v.id)!.specification])));
  const [activeId, setActiveId] = useState(detail.views[0].id);
  const [error, setError] = useState('');
  const [dirtyViews, setDirtyViews] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [recognitionAttempt, setRecognitionAttempt] = useState(0);
  const [recognizedFaces, setRecognizedFaces] = useState<Record<string, { basis: string; hasFrame: boolean }>>({});
  const recognitionFront = detail.views.find(v => v.face === 'front');
  const shouldRecognize = user.role !== 'viewer' && detail.isCurrent && !!recognitionFront && (recognitionAttempt > 0 || (!recognitionFront.latest && catalogReferenceType(detail.namespace, detail.styleCode).structure === 'apron'));
  const recognitionViewId = recognitionFront?.id;
  useEffect(() => {
    if (!shouldRecognize || !recognitionViewId) return;
    const controller = new AbortController();
    let active = true;
    async function recognize() {
      setRecognizing(true); setError('');
      try {
        const response = await fetchApi(`/api/catalog/products/${detail.id}/recognize-placement`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetVersionId: detail.assetVersionId }), signal: controller.signal });
        const result = await readApiJson(response, '识别位置失败');
        const recognized = catalogApronRecognitionResponseSchema.parse(result);
        if (!active) return;
        if (recognized.assetVersionId !== detail.assetVersionId || recognized.viewId !== recognitionViewId) throw new Error('识别结果与当前底图不一致，请重新打开');
        setSpecs(current => ({ ...current, [recognized.viewId]: recognized.specification }));
        setRecognizedFaces(current => ({ ...current, [recognized.viewId]: { hasFrame: recognized.hasFrame, basis: recognized.basis } }));
        if (recognized.hasFrame) { dirtyRef.current.add(recognized.viewId); setDirtyViews(new Set(dirtyRef.current)); }
        setReviewedViews(current => { const next = new Set(current); next.delete(recognized.viewId); return next; });
        setLayer('placement');
      } catch (error) { if (active) setError(`自动识别未完成：${error instanceof Error ? error.message : String(error)}。可重试或手动框选。`); }
      finally { if (active) setRecognizing(false); }
    }
    void recognize();
    return () => { active = false; controller.abort(); };
  }, [detail.id, detail.assetVersionId, recognitionViewId, shouldRecognize, recognitionAttempt]);
  const dirty = dirtyViews.size > 0;
  useEffect(() => {
    // Refresh saved revisions without discarding edits on the other face.
    setSpecs(current => Object.fromEntries(detail.views.map(v => [v.id, dirtyRef.current.has(v.id) ? current[v.id] : v.latest?.specification ?? preview.faces.find(f => f.viewId === v.id)!.specification])));
  }, [detail, preview]);
  const [historyId, setHistoryId] = useState('');
  const view = detail.views.find(v => v.id === activeId)!;
  const historical = view.history.find(v => v.id === historyId);
  const spec = historical?.specification ?? specs[activeId];
  const editable = user.role !== 'viewer' && detail.isCurrent && !historical && !busy && !recognizing;
  function change(next: PlacementStandard, id = activeId) { setSpecs(current => ({ ...current, [id]: next })); dirtyRef.current.add(id); setDirtyViews(new Set(dirtyRef.current)); setReviewedViews(current => { const next = new Set(current); next.delete(id); return next; }); }
  function selectView(id: string) { setActiveId(id); setHistoryId(''); }
  const currentPosition = spec.positions.find(p => p.key === selectedKey) ?? spec.positions[0];
  const canReuse = !dirty && !busy && !historical && detail.isCurrent && detail.views.some(v => v.latest?.status === 'confirmed' && v.latest.origin === 'manual' && v.latest.id === v.confirmedId);
  const currentSuggestion = preview.faces.find(f => f.viewId === view.id)!;
  const needsBoundary = !view.latest && !currentSuggestion.frame && !manualBoundaries.has(view.id) && !recognizedFaces[view.id]?.hasFrame;
  function finishBoundary(id: string, box: Box) {
    try {
      if (drawingPositionKey) {
        const position = positionFromImageBox(drawingPositionKey, box, specs[id].garmentFrame);
        change({ ...specs[id], positions: [...specs[id].positions.filter(p => p.key !== drawingPositionKey), position] }, id);
        setSelectedKey(drawingPositionKey); setLayer('placement');
      } else {
        change({ ...specs[id], garmentFrame: box }, id);
        setManualBoundaries(current => new Set([...current, id])); setLayer('structure');
      }
      setError(''); setDrawingBoundaryId(null); setDrawingPositionKey(null);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  function changeStructure(structure: StructureType) {
    if (needsBoundary) { setError('请先框选衣服布面，再生成位置标记'); return; }
    if ((view.latest || (dirtyViews.has(activeId) && spec.positions.length > 0)) && !window.confirm('更换结构会重新生成当前面的建议标记，替换尚未保存的调整；已保存版本仍保留。继续？')) return;
    change(suggestedPlacement(structure, view.face, spec.garmentFrame, catalogReferenceType(detail.namespace, detail.styleCode).longSleeve));
    setLayer('placement');
  }
  async function save(confirm: boolean) {
    setBusy(true); setError('');
    try {
      const response = await fetchApi('/api/catalog/standards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewId: view.id, assetVersionId: detail.assetVersionId, expectedRevision: view.revision, specification: spec, confirm }) });
      await readApiJson(response, '保存位置失败');
      dirtyRef.current.delete(activeId); setDirtyViews(new Set(dirtyRef.current)); await saved(detail.id);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function dismiss() { if (dirty && !window.confirm('尚有未保存的位置修改，确认关闭？')) return; close(); }
  if (reuse) return <CatalogReuse variantId={detail.id} close={() => setReuse(false)} saved={() => saved(detail.id)} />;
  return <div className="catalog-backdrop"><section className="catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="cal-title">
    <header className="catalog-dialog-head"><div><h2 id="cal-title">{detail.styleCode} · {detail.colorName}</h2><p>印花位置 · 同屏核对正反面，左右以穿着者为准</p></div><button type="button" className="button" onClick={dismiss}>关闭</button></header>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <div className="catalog-style-toolbar"><div className="catalog-color-options" aria-label="切换同款颜色">{style.colors.map(color => <button type="button" key={color.id} aria-pressed={color.id === detail.id} onClick={() => { if (color.id !== detail.id && (!dirty || window.confirm('切换颜色将放弃未保存修改，继续？'))) selectColor(color.id); }}>{color.colorName}{color.id === style.referenceVariantId ? ' ★' : ''}</button>)}</div></div>
    <div className="cal-legend-bar"><div className="cal-layer-switch" aria-label="标记显示图层">{([['all', '全部标记'], ['placement', '印花位置'], ['structure', '结构与避让']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={layer === key} onClick={() => setLayer(key)}>{label}</button>)}</div><span><i className="cal-legend-point" />结构点</span><span><i className="cal-legend-anchor" />印花中心</span><span><i className="cal-legend-area" />可印范围</span><span><i className="cal-legend-danger" />避让区域</span></div>
    <div className="catalog-calibration-body"><div className={`cal-faces ${detail.views.length === 1 ? 'cal-faces-single' : ''}` }>{detail.views.map(v => <FaceCanvas key={v.id} detail={detail} view={v} spec={v.id === activeId ? spec : specs[v.id]} active={v.id === activeId} editable={editable} layer={layer} selectedKey={currentPosition?.key ?? null} status={recognizing && v.face === 'front' ? '正在识别位置…' : dirtyViews.has(v.id) ? '有未保存调整' : v.latest?.status === 'confirmed' ? '已确认' : v.latest ? '草稿 · 待确认' : preview.faces.find(f => f.viewId === v.id)?.frame ? '参考标记 · 未保存' : '待手动框选衣服'} activate={() => selectView(v.id)} selectPosition={setSelectedKey} change={next => change(next, v.id)} drawingBoundary={drawingBoundaryId === v.id} finishBoundary={box => finishBoundary(v.id, box)} />)}</div>
    <aside className="cal-inspector"><strong>{view.face === 'front' ? '正面' : '背面'}印花位置</strong><p className="cal-hint">点选位置，拖动圆点调整印花中心；拖动绿色框调整范围，红色斜线区域需避让。</p>
      {!view.latest && <div className="cal-suggestion-note"><strong>{recognizing ? '正在自动识别围裙位置' : needsBoundary ? '需要手动定位衣服' : '参考标记 · 等待你核对'}</strong><p>{recognizing ? '正在观察实际照片并放大复核口袋边缘、分隔线与印花布面，请稍候。' : recognizedFaces[view.id] ? recognizedFaces[view.id].basis : manualBoundaries.has(view.id) ? '已使用你框选的衣服区域；生成参考标记后仍需核对具体印花位置与缝线等避让区。' : currentSuggestion.basis}</p><p>{recognizing ? '识别完成后会自动显示建议框；确认前不会用于生产。' : needsBoundary ? '先框选围裙或衣服本体，不包含头部、腿部和背景；框好后生成参考位置，再逐项调整。' : '这些是可调整的参考位置，确认前不会用于生产。'}</p></div>}
      {editable && <div className="cal-boundary-controls"><button type="button" className="button primary" onClick={() => { setDrawingPositionKey(null); setDrawingBoundaryId(drawingBoundaryId === view.id ? null : view.id); }}>{drawingBoundaryId === view.id ? '取消框选' : '框选衣服区域'}</button>{drawingBoundaryId === view.id && <p role="status">{drawingPositionKey ? `在图片上框选${POSITION_LABELS[drawingPositionKey]}的可印范围，避开缝线。` : '在图片上按住并拖出矩形，框住衣服布面。'}</p>}{!needsBoundary && !spec.positions.length && <p>区域已就绪，请点击下方“生成参考标记”。</p>}</div>}
      {spec.structureType === 'apron' && view.face === 'front' && <div className="cal-suggestion-note"><strong>围裙按三个位置分别校准</strong>{recognizing && <p role="status">正在识别围裙布面、上部、口袋和正前面…</p>}{view.latest && recognizedFaces[view.id] && <p>{recognizedFaces[view.id].basis}</p>}{user.role !== 'viewer' && detail.isCurrent && !historical && <button type="button" className="button" disabled={busy || recognizing || drawingBoundaryId !== null} onClick={() => { if (dirty && !window.confirm('重新读取模型建议会替换当前未保存的调整，继续？')) return; setRecognitionAttempt(current => current + 1); }}> {recognizing ? '识别中…' : '识别围裙位置'}</button>}<p>上部、口袋、正前面可以分别印花。系统根据实际照片建议位置，仍需核对口袋边缘和缝线；口袋本身不是禁区。</p><div className="cal-position-list">{(['apronUpper', 'apronPocket', 'frontCenter'] as const).map(key => <button type="button" key={key} disabled={!editable || needsBoundary || drawingBoundaryId !== null} onClick={() => { setError(''); setDrawingPositionKey(key); setDrawingBoundaryId(view.id); setLayer('placement'); }}><span>框选{POSITION_LABELS[key]}</span><small>{spec.positions.some(p => p.key === key) ? '已有标记 · 可重新框选' : '尚未标记'}</small></button>)}</div>{spec.exclusions.some(e => /口袋/.test(e.label)) && <p>已保存版本中仍有口袋禁区。若该处需要印花，请在“调整避让区域”核对并移除对应禁区；缝线可单独保留。</p>}</div>}
      <div className="cal-position-list" aria-label="选择印花位置">{spec.positions.map(p => <button type="button" key={p.key} aria-pressed={currentPosition?.key === p.key} onClick={() => { setSelectedKey(p.key); setLayer('placement'); }}>{POSITION_LABELS[p.key]}<small>{currentPosition?.key === p.key ? '正在调整' : '点击查看'}</small></button>)}</div>
      {(historical ?? view.latest)?.source && <p className="catalog-standard-source">共用自 {(historical ?? view.latest)!.source!.colorName} · 标准 v{(historical ?? view.latest)!.source!.revision}。单独修改并保存后，将形成当前颜色自己的标准。</p>}
      {user.role !== 'viewer' && <button className="button" type="button" onClick={() => { if (!dirty || window.confirm('添加颜色将放弃尚未保存的位置修改，继续？')) addColor(); }}>添加同款颜色</button>}
      <label className="cal-field">已保存版本<select value={historyId} onChange={e => setHistoryId(e.target.value)}><option value="">当前编辑</option>{view.history.map(h => <option key={h.id} value={h.id}>v{h.revision} · {h.status === 'confirmed' ? '已确认' : '草稿'} · {h.createdBy}</option>)}</select></label>
      <fieldset disabled={!editable || needsBoundary || drawingBoundaryId !== null}>
      <label className="cal-field">结构类型<select value={spec.structureType} onChange={e => changeStructure(e.target.value as StructureType)}>{Object.entries(STRUCTURE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <button className="button" type="button" disabled={spec.structureType === 'unknown'} onClick={() => changeStructure(spec.structureType)}>{spec.positions.length ? '重新生成参考标记' : '生成参考标记'}</button>
      <details onToggle={event => { if (event.currentTarget.open) setLayer('structure'); }}><summary>调整衣服边界与实测尺寸</summary><BoxFields value={spec.garmentFrame} change={b => change({ ...spec, garmentFrame: b })} /><label className="cal-field">已实测衣宽（cm，可留空）<input type="number" min="1" max="300" value={spec.measuredWidthCm ?? ''} onChange={e => change({ ...spec, measuredWidthCm: e.target.value ? Number(e.target.value) : null })} /></label></details>
      <details><summary>精细调整印花位置 · {spec.positions.length}</summary>{spec.positions.map((position, i) => <div className="cal-position" key={position.key}><strong>{POSITION_LABELS[position.key]}</strong><button type="button" className="cal-remove" onClick={() => change({ ...spec, positions: spec.positions.filter((_, index) => i !== index) })}>移除</button><span className="cal-field-title">最大可印范围</span><BoxFields value={position.printableArea} change={box => change({ ...spec, positions: spec.positions.map((p, index) => i === index ? { ...p, printableArea: box } : p) })} /><div className="cal-four"><Percent label="锚点 X" value={position.anchor.x} change={x => change({ ...spec, positions: spec.positions.map((p, index) => i === index ? { ...p, anchor: { ...p.anchor, x } } : p) })} /><Percent label="锚点 Y" value={position.anchor.y} change={y => change({ ...spec, positions: spec.positions.map((p, index) => i === index ? { ...p, anchor: { ...p.anchor, y } } : p) })} /><Percent label="默认宽" value={position.defaultSize.width} change={width => change({ ...spec, positions: spec.positions.map((p, index) => i === index ? { ...p, defaultSize: { ...p.defaultSize, width } } : p) })} /><Percent label="默认高" value={position.defaultSize.height} change={height => change({ ...spec, positions: spec.positions.map((p, index) => i === index ? { ...p, defaultSize: { ...p.defaultSize, height } } : p) })} /></div></div>)}
      <select aria-label="添加印制位置" value="" onChange={e => { const key = e.target.value as keyof typeof POSITION_LABELS; if (key === 'apronPocket') { setDrawingPositionKey(key); setDrawingBoundaryId(view.id); setLayer('placement'); return; } if (key) change({ ...spec, positions: [...spec.positions, { key, anchor: { x: .5, y: .5 }, printableArea: { x: .4, y: .4, width: .2, height: .2 }, defaultSize: { width: .1, height: .1 } }] }); }}><option value="">＋ 添加并手动校准位置</option>{allowedPositions(spec.structureType, view.face).filter(key => !spec.positions.some(p => p.key === key)).map(key => <option key={key} value={key}>{POSITION_LABELS[key]}</option>)}</select></details>
      <details><summary>调整避让区域 · {spec.exclusions.length}</summary>{spec.exclusions.map((exclusion, i) => <div className="cal-position" key={exclusion.id}><input aria-label="禁区名称" value={exclusion.label} onChange={e => change({ ...spec, exclusions: spec.exclusions.map((x, index) => i === index ? { ...x, label: e.target.value } : x) })} /><BoxFields value={exclusion.area} change={box => change({ ...spec, exclusions: spec.exclusions.map((x, index) => i === index ? { ...x, area: box } : x) })} /><button type="button" className="cal-remove" onClick={() => change({ ...spec, exclusions: spec.exclusions.filter((_, index) => index !== i) })}>移除禁区</button></div>)}<button type="button" className="button" onClick={() => change({ ...spec, exclusions: [...spec.exclusions, { id: crypto.randomUUID(), label: '待标记禁区', area: { x: .45, y: .1, width: .1, height: .2 } }] })}>添加缝线等不可印区域</button></details>
      <label className="cal-field">复核备注<textarea value={spec.note} maxLength={2000} onChange={e => change({ ...spec, note: e.target.value })} /></label>
      </fieldset>
      <details><summary>原图与底图版本</summary><button type="button" className="button" onClick={() => setImagePreview(true)}>放大查看衣服</button><p className="cal-hint">原文件按名称匹配，仅作来源候选；未冒充逐面人工复核结果。</p>{detail.sources.map((source, i) => <a className="cal-source-link" key={`${source.url}-${i}`} href={source.url} target="_blank" rel="noreferrer">{source.filename} ↗</a>)}{detail.versions.map(v => <p className="cal-hint" key={v.id}><button type="button" className="button" onClick={() => { if (!dirty || window.confirm('切换底图版本将放弃未保存修改，继续？')) loadVersion(v.id); }}>底图 v{v.version}{v.id === detail.assetVersionId ? ' · 正在查看' : ''}</button> · {v.sha256.slice(0, 12)}</p>)}<p className="cal-hint">{detail.sha256}</p>{user.role !== 'viewer' && detail.isCurrent && <button type="button" className="button" onClick={() => { if (!dirty || window.confirm('将放弃尚未保存的校准修改，继续上传新版底图？')) replace(); }}>上传新版底图</button>}</details>
    </aside></div>
    <footer className="catalog-dialog-foot cal-confirm-footer"><div className="cal-confirm-copy">{historical || !detail.isCurrent ? <span>历史版本只读</span> : <><label className="catalog-check"><input type="checkbox" checked={reviewedViews.has(activeId)} disabled={!editable || needsBoundary || !spec.positions.length || drawingBoundaryId !== null} onChange={event => setReviewedViews(current => { const next = new Set(current); if (event.target.checked) next.add(activeId); else next.delete(activeId); return next; })} />已核对{view.face === 'front' ? '正面' : '背面'}衣服边界、位置点和避让区域</label><small>正反面分别保存；确认后可应用到同款其他颜色。</small></>}</div><div><button className="button" disabled={!editable || needsBoundary || drawingBoundaryId !== null} onClick={() => void save(false)} type="button">{busy ? '保存中…' : `保存${view.face === 'front' ? '正面' : '背面'}草稿`}</button><button className="button primary" disabled={!editable || needsBoundary || !spec.positions.length || drawingBoundaryId !== null || !reviewedViews.has(activeId)} onClick={() => void save(true)} type="button">确认{view.face === 'front' ? '正面' : '背面'}位置</button>{user.role !== 'viewer' && style.colors.length > 1 && <button className="button" type="button" disabled={!canReuse} title="确认至少一面的位置后，查看同款其他颜色的套用预览" onClick={() => setReuse(true)}>应用到同款其他颜色</button>}</div></footer>


  </section>{imagePreview && <CatalogImagePreview items={[detail]} initialId={detail.id} close={() => setImagePreview(false)} />}</div>;
}
