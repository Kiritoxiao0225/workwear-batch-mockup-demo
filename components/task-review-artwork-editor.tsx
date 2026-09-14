'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode, type PointerEvent, type KeyboardEvent } from 'react';
import { ARTWORK_CANVAS_SIZE, ARTWORK_SNAP_SCREEN_PX, artworkGraphicBounds, artworkGraphicFrame, snapArtworkPosition, type ArtworkBounds, type ArtworkDraft, type ArtworkGraphicLayer, type ArtworkTextLayer, type ArtworkSnapGuide } from '@/lib/artwork-editor';
import './task-review-artwork-editor.css';
import './artwork-inline-repair.css';
import { InlineRepair, type RepairTool } from './artwork-inline-repair';
import { addArtworkText, duplicateArtworkLayers, removeArtworkLayers, artworkLayers, artworkPointInLayer, artworkPolygonSelection, artworkRasterIntersectsSelection, editableArtworkDraft, recordArtworkHistory, reorderArtworkLayer, travelArtworkHistory, updateArtworkLayer, type ArtworkHistory, type ArtworkLayer, type ArtworkPoint, type ArtworkSelection } from '@/lib/artwork-layers';
import { splitArtworkGraphic } from '@/lib/client/artwork-layer-editing';
import { artworkTextLayout, loadArtworkFont } from '@/lib/client/artwork-text-layout';
import { artworkDraftCanvasBounds, drawArtworkText, loadArtworkGraphicView } from '@/lib/client/render-artwork';
import { DEFAULT_ARTWORK_FONT, ARTWORK_TEXT_COLORS } from '@/lib/artwork-text-defaults';

type Props = { repairEnabled?: boolean; repairOriginalURL?: string; title: string; originalRequirement: string; initialDraft: ArtworkDraft; saving: boolean; onCancel: () => void; onSave: (draft: ArtworkDraft) => Promise<void>; renderPreview?: (draft: ArtworkDraft) => ReactNode; saveLabel?: string; saveHint?: string; defaultTextColor?: () => Promise<string> };
const FONTS = [[DEFAULT_ARTWORK_FONT, '抖音美好体（默认）'], ['Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif', '现代黑体'], ['PingFang SC, Microsoft YaHei, sans-serif', '苹方 / 微软雅黑'], ['STKaiti, KaiTi, serif', '楷体'], ['STSong, SimSun, serif', '宋体'], ['FZKai-Z03, STKaiti, serif', '标题楷体']];
const S = ARTWORK_CANVAS_SIZE;
const labelOf = (layer: ArtworkLayer) => layer.value.label || (layer.kind === 'graphic' ? `图形 ${layer.index + 1}` : `文字 ${layer.index + 1}`);
function boundsOf(layer: ArtworkLayer): ArtworkBounds {
  if (layer.kind === 'text') return artworkTextLayout(layer.value).bounds;
  return artworkGraphicBounds(layer.value);
}
function arrangePair(draft: ArtworkDraft, preset: 'vertical' | 'verticalReverse' | 'horizontal' | 'horizontalReverse', gap = draft.layout.gap, align = draft.layout.groupAlign) {
  const visible = artworkLayers(draft).filter(layer => layer.value.visible !== false);
  const graphics = visible.filter(layer => layer.kind === 'graphic'), texts = visible.filter(layer => layer.kind === 'text');
  if (!graphics.length || !texts.length) return draft;
  const group = (items: ArtworkLayer[]) => { const bounds = items.map(boundsOf); const left = Math.min(...bounds.map(b => b.left)), top = Math.min(...bounds.map(b => b.top)); return { left, top, width: Math.max(...bounds.map(b => b.left + b.width)) - left, height: Math.max(...bounds.map(b => b.top + b.height)) - top }; };
  const g = group(graphics), textBounds = texts.map(boundsOf);
  const tw = Math.max(...textBounds.map(b => b.width)), th = textBounds.reduce((sum, b) => sum + b.height, 0) + Math.max(0, texts.length - 1) * 18;
  const vertical = preset === 'vertical' || preset === 'verticalReverse', reverse = preset === 'horizontalReverse' || preset === 'verticalReverse';
  const width = vertical ? Math.max(g.width, tw) : g.width + gap + tw, height = vertical ? g.height + gap + th : Math.max(g.height, th);
  const originX = 512 - width / 2, originY = 512 - height / 2;
  const crossOffset = (available: number, size: number) => align === 'left' ? 0 : align === 'right' ? available - size : (available - size) / 2;
  const gx = originX + (vertical ? crossOffset(width, g.width) : reverse ? tw + gap : 0);
  const gy = originY + (vertical ? reverse ? th + gap : 0 : crossOffset(height, g.height));
  const tx = originX + (vertical ? crossOffset(width, tw) : reverse ? 0 : g.width + gap);
  let ty = originY + (vertical ? reverse ? 0 : g.height + gap : crossOffset(height, th));
  let next = graphics.reduce((value, layer) => updateArtworkLayer(value, layer.id, { x: layer.value.x + gx - g.left, y: layer.value.y + gy - g.top }), draft);
  texts.forEach((layer, index) => { const b = textBounds[index]; next = updateArtworkLayer(next, layer.id, { x: layer.value.x + tx + crossOffset(tw, b.width) - b.left, y: layer.value.y + ty - b.top }); ty += b.height + 18; });
  return { ...next, layout: { ...next.layout, preset, gap, groupAlign: align } };
}
const ICONS: Record<string, string> = {
  text: 'M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3', layers: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  pointer: 'm5 3 14 10-7 1-3 7L5 3Z', select: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4',
  lasso: 'm4 5 15-2 2 12-10 5-7-8V5Zm0 7-2 7 5 3',
  undo: 'M8 5 3 10l5 5M3 10h10a7 7 0 0 1 7 7', redo: 'm16 5 5 5-5 5M21 10H11a7 7 0 0 0-7 7',
  up: 'm6 11 6-6 6 6M12 5v15', down: 'm6 13 6 6 6-6M12 4v15', copy: 'M8 8h12v12H8ZM15 8V4H4v11h4',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6', plus: 'M12 5v14M5 12h14',
};
function EditorIcon({ name }: { name: string }) { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name] ?? ICONS.text}/></svg>; }
function NumericInput({ label, value, min, max, onChange, step = 1, suffix = 'px' }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; step?: number; suffix?: string }) {
  return <label>{label}<span className="artwork-v2-number"><input aria-label={label} type="number" value={Number(value.toFixed(2))} min={min} max={max} step={step} onChange={event => { if (event.target.value === '') return; const next = Number(event.target.value); if (Number.isFinite(next) && next >= min && next <= max) onChange(next); }}/><small>{suffix}</small></span></label>;
}
const SWATCHES = [...ARTWORK_TEXT_COLORS, '#44416d', '#24654b'];
function GraphicView({ graphic, onError }: { graphic: ArtworkGraphicLayer; onError: (error: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { sourceUrl, recolorMaskUrl, recolorScope, recolor: { mode, color }, inkSpread = 0 } = graphic;
  const renderWidth = inkSpread ? graphic.width : 0, renderHeight = inkSpread ? graphic.height : 0;
  const { left, top, width, height } = graphic.sourceBounds ?? {};
  const imageKey = JSON.stringify([sourceUrl, recolorMaskUrl, recolorScope, mode, color, left, top, width, height, inkSpread, renderWidth, renderHeight]);
  const [painted, setPainted] = useState<{ key: string; status: 'ready' | 'failed' } | null>(null);
  useEffect(() => {
    let active = true;
    void loadArtworkGraphicView({ sourceUrl, recolorMaskUrl, recolorScope, recolor: { mode, color }, inkSpread, width: renderWidth, height: renderHeight, x: 0, y: 0, rotation: 0, sourceBounds: left === undefined ? undefined : { left, top: top!, width: width!, height: height! } }).then(image => {
      const canvas = ref.current;
      if (!active || !canvas) return;
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('图形画布不可用');
      context.drawImage(image, 0, 0);
      setPainted({ key: imageKey, status: 'ready' });
    }).catch(error => { if (active) { setPainted({ key: imageKey, status: 'failed' }); onError(error instanceof Error ? error.message : String(error)); } });
    return () => { active = false; };
  }, [sourceUrl, recolorMaskUrl, recolorScope, mode, color, onError, left, top, width, height, imageKey, inkSpread, renderWidth, renderHeight]);
  const status = painted?.key === imageKey ? painted.status : 'loading';
  return <><canvas ref={ref} data-image-state={status} aria-busy={status === 'loading'} style={{ width: '100%', height: '100%', pointerEvents: 'none', visibility: status === 'ready' ? 'visible' : 'hidden' }}/>{status !== 'ready' && <span role="status" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 12, color: '#52675b', background: '#ffffffcc', pointerEvents: 'none' }}>{status === 'failed' ? '图案加载失败，请重新打开' : '正在加载图案…'}</span>}</>;
}
function TextView({ text, scale, onError, onFontLoaded }: { text: ArtworkTextLayer; scale: number; onError: (error: string) => void; onFontLoaded: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true;
    void loadArtworkFont(text).then(() => {
      const canvas = ref.current;
      if (!active || !canvas) return;
      const bounds = artworkTextLayout(text).bounds, density = Math.max(1, window.devicePixelRatio);
      canvas.width = Math.max(1, Math.ceil(bounds.width * scale * density)); canvas.height = Math.max(1, Math.ceil(bounds.height * scale * density));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('文字画布不可用');
      context.scale(canvas.width / bounds.width, canvas.height / bounds.height); context.translate(-bounds.left, -bounds.top); drawArtworkText(context, text);
      onFontLoaded();
    }).catch(error => { if (active) onError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [text, scale, onError, onFontLoaded]);
  return <canvas ref={ref} style={{ width: '100%', height: '100%', pointerEvents: 'none' }}/>;
}

export function TaskReviewArtworkEditor({ title, originalRequirement, initialDraft, saving, onCancel, onSave, renderPreview, defaultTextColor, saveLabel = '保存调整并返回任务表', repairEnabled = false, repairOriginalURL, saveHint = '图层与透明 PNG 一起保存，下次打开可以继续分层编辑。' }: Props) {
  const [history, setHistory] = useState<ArtworkHistory>(() => ({ past: [], present: editableArtworkDraft(initialDraft), future: [] }));
  const historyRef = useRef(history), gesture = useRef<ArtworkDraft | null>(null);
  const [gestureChanged, setGestureChanged] = useState(false);
  const draft = history.present;
  const [selectedIds, setSelectedIds] = useState<string[]>(() => artworkLayers(editableArtworkDraft(initialDraft)).filter(layer => layer.value.visible !== false).slice(-1).map(layer => layer.id));
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const [repairScope,setRepairScope]=useState<'region'|'brush'>('region'),[repairRadius,setRepairRadius]=useState(48),[repairMessage,setRepairMessage]=useState(''),[canRestore,setCanRestore]=useState(false);
  const [tool, setTool] = useState<'auto' | 'marquee' | 'lasso' | RepairTool>('auto');
  const repairMode:RepairTool|null=tool==='fill'||tool==='keep'||tool==='remove'?tool:null;
  const repairLabel=repairMode==='fill'?'补空白':repairMode==='keep'?'保留笔':'去除笔';
  const [background, setBackground] = useState<'checker' | 'white' | 'dark'>('checker');
  const inspector = useRef<HTMLElement>(null), dialog = useRef<HTMLElement>(null), textInput = useRef<HTMLTextAreaElement>(null), focusNewText = useRef(false);
  const [pointerCursor, setPointerCursor] = useState('crosshair');
  const [selection, setSelection] = useState<ArtworkSelection | null>(null);
  const [lassoPoints, setLassoPoints] = useState<ArtworkPoint[]>([]);
  const [lassoCursor, setLassoCursor] = useState<ArtworkPoint | null>(null);
  const marquee = useRef<{ x: number; y: number; clientX: number; clientY: number; pointerId: number; started: boolean } | null>(null);
  const drag = useRef<{ id: string; pointerId: number; startX: number; startY: number; layer: ArtworkLayer; companions: ArtworkLayer[]; resize: boolean; started: boolean } | null>(null);
  const [splitting, setSplitting] = useState(false), [error, setError] = useState<string | null>(null);
  const extracting = useRef(false);
  const clearSelection = () => { setSelection(null); setLassoPoints([]); setLassoCursor(null); setError(null); };
  const [snap, setSnap] = useState(true), [guides, setGuides] = useState<ArtworkSnapGuide[]>([]);
  const [fitViewport, setFitViewport] = useState({ width: 420, height: 420 }), [zoom, setZoom] = useState(1), [previewOpen, setPreviewOpen] = useState(false);
  const [pointerView, setPointerView] = useState<{ surface: ArtworkBounds; scale: number } | null>(null);
  const [, setFontRevision] = useState(0);
  const fontLoaded = useCallback(() => setFontRevision(value => value + 1), []);
  const viewport = useRef<HTMLDivElement>(null), board = useRef<HTMLDivElement>(null);
  const surface = pointerView?.surface ?? artworkDraftCanvasBounds(draft);
  const scale = pointerView?.scale ?? zoom * Math.min(fitViewport.width / surface.width, fitViewport.height / surface.height), busy = saving || splitting;
  const layers = artworkLayers(draft).filter(layer => !(layer.kind === 'graphic' && layer.value.label === '透明底' && layer.value.visible === false)), selected = layers.find(layer => layer.id === selectedId) ?? null;
  const graphic = selected?.kind === 'graphic' ? selected.value : null, text = selected?.kind === 'text' ? selected.value : null;
  const publish = (next: ArtworkHistory) => { historyRef.current = next; setHistory(next); };
  const beginGesture = () => { gesture.current ??= historyRef.current.present; };
  const finishGesture = () => {
    if (!gesture.current) return;
    const base = gesture.current; gesture.current = null; setGestureChanged(false);
    publish(recordArtworkHistory({ ...historyRef.current, present: base }, historyRef.current.present));
  };
  const change = (transform: (current: ArtworkDraft) => ArtworkDraft) => {
    const current = historyRef.current, next = transform(current.present);
    if (gesture.current && next !== current.present) setGestureChanged(true);
    publish(gesture.current ? { ...current, present: next } : recordArtworkHistory(current, next));
    setError(null);
  };
  const patch = (value: Partial<ArtworkGraphicLayer & ArtworkTextLayer>) => { if (selectedId) change(current => updateArtworkLayer(current, selectedId, value)); };
  const choose = (id: string | null) => {
    finishGesture(); if(repairMode&&artworkLayers(historyRef.current.present).find(layer=>layer.id===id)?.kind==='text')setTool('auto'); setSelectedIds(id ? [id] : []); clearSelection(); setError(null); if (inspector.current) inspector.current.scrollTop = 0;
  };
  const startRepair=(mode:RepairTool)=>{
    const candidate=graphic&&graphic.visible!==false?selected:layers.find(layer=>layer.kind==='graphic'&&layer.value.visible!==false);
    if(!candidate)return;finishGesture();clearSelection();setSelectedIds([candidate.id]);setPreviewOpen(false);setTool(mode);setRepairMessage(mode==='fill'?'直接点画布里的透明空洞，一次补回整块。':mode==='keep'?'在当前图层上涂抹，恢复原图中的内容。':'在当前图层上涂抹，去除多余像素。');if(inspector.current)inspector.current.scrollTop=0;
  };
  const addText = async () => {
    if (busy) return;
    finishGesture();
    setSplitting(true);
    try {
      const color = defaultTextColor ? await defaultTextColor() : '#000000';
      const visible = artworkLayers(historyRef.current.present).filter(layer => layer.value.visible !== false);
      const bottom = Math.max(300, ...visible.map(layer => { const b = boundsOf(layer); return b.top + b.height; }));
      const result = addArtworkText(historyRef.current.present, { x: 512, y: Math.min(1980, bottom + 84) }, color);
      change(() => result.draft); setSelectedIds([result.selectedId]); clearSelection(); setPreviewOpen(false); setTool('auto'); focusNewText.current = true;
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setSplitting(false); }
  };
  const modifyLayers = (action: 'duplicate' | 'delete') => {
    if (busy || !selectedIds.length) return;
    finishGesture();
    try {
      if (action === 'duplicate') { const result = duplicateArtworkLayers(historyRef.current.present, selectedIds); change(() => result.draft); setSelectedIds(result.selectedIds); }
      else { const next = removeArtworkLayers(historyRef.current.present, selectedIds); change(() => next); setSelectedIds([]); }
      clearSelection();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => { if (focusNewText.current && textInput.current) { textInput.current.focus(); textInput.current.select(); focusNewText.current = false; } }, [selectedId]);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const travel = (direction: 'undo' | 'redo') => {
    finishGesture();
    const next = travelArtworkHistory(historyRef.current, direction); publish(next);
    setSelectedIds(ids => ids.filter(id => artworkLayers(next.present).some(layer => layer.id === id && layer.value.visible !== false)));
    clearSelection(); setError(null); setGuides([]);
  };
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = () => { if (!element.clientWidth || !element.clientHeight) return; setFitViewport({ width: Math.max(1, element.clientWidth - 4), height: Math.max(1, element.clientHeight - 4) }); };
    resize(); const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const point = (event: PointerEvent) => {
    const rect = board.current!.getBoundingClientRect();
    return { x: surface.left + Math.max(0, Math.min(surface.width, (event.clientX - rect.left - 1) / scale)), y: surface.top + Math.max(0, Math.min(surface.height, (event.clientY - rect.top - 1) / scale)) };
  };
  const hitLayer = (location: { x: number; y: number }) => {
    for (const layer of [...layers].reverse()) {
      if (layer.value.visible === false) continue;
      const bounds = layer.kind === 'graphic' ? artworkGraphicFrame(layer.value) : boundsOf(layer);
      const local = artworkPointInLayer(location, bounds, layer.kind === 'graphic' ? layer.value.rotation : 0);
      if (!local) continue;
      const canvas = board.current?.querySelector<HTMLCanvasElement>(`[data-layer-id="${CSS.escape(layer.id)}"] canvas`);
      if (!canvas?.width || !canvas.height) continue;
      const alpha = canvas.getContext('2d', { willReadFrequently: true })?.getImageData(Math.floor(local.x * canvas.width), Math.floor(local.y * canvas.height), 1, 1).data[3];
      if (alpha && alpha > 8) return layer;
    }
    return null;
  };
  const layersInSelection = (area: ArtworkSelection) => layers.filter(layer => {
    if (layer.value.visible === false) return false;
    const outer = boundsOf(layer);
    if (outer.left >= area.left + area.width || outer.left + outer.width <= area.left || outer.top >= area.top + area.height || outer.top + outer.height <= area.top) return false;
    const canvas = board.current?.querySelector<HTMLCanvasElement>(`[data-layer-id="${CSS.escape(layer.id)}"] canvas`);
    const context = canvas?.getContext('2d', { willReadFrequently: true });
    if (!canvas || !context) return false;
    const bounds = layer.kind === 'graphic' ? artworkGraphicFrame(layer.value) : outer;
    return artworkRasterIntersectsSelection(context.getImageData(0, 0, canvas.width, canvas.height), bounds, area, layer.kind === 'graphic' ? layer.value.rotation : 0);
  }).map(layer => layer.id);
  const closeLasso = () => {
    if (busy) return;
    const area = artworkPolygonSelection(lassoPoints);
    if (!area) { setError('请至少选择三个不在同一直线上的点，再闭合选区。'); return; }
    setSelection(area); setSelectedIds(layersInSelection(area)); setLassoPoints([]); setLassoCursor(null); setError(null);
    board.current?.focus({ preventScroll: true });
  };
  const beginMove = (event: PointerEvent<HTMLElement>, layer: ArtworkLayer, resize = false) => {
    if (busy || event.button !== 0) return;
    event.stopPropagation(); finishGesture(); board.current?.focus({ preventScroll: true }); if (resize || !selectedIds.includes(layer.id)) choose(layer.id);
    drag.current = { id: layer.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, layer, companions: !resize && selectedIds.includes(layer.id) ? layers.filter(other => selectedIds.includes(other.id) && other.id !== layer.id && other.value.visible !== false) : [], resize, started: false };
    setPointerView({ surface, scale });
    setPointerCursor(resize ? 'nwse-resize' : 'grabbing');
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const beginPointer = (event: PointerEvent<HTMLDivElement>) => {
    if(repairMode){event.preventDefault();setRepairMessage('请在当前选中的图片图层内操作。');return;}
    if (busy || event.button !== 0) return;
    const location = point(event);
    if (tool === 'lasso') {
      event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
      if (lassoPoints.length >= 3 && Math.hypot(location.x - lassoPoints[0].x, location.y - lassoPoints[0].y) * scale <= 8) { closeLasso(); return; }
      if (!lassoPoints.length) { finishGesture(); choose(null); }
      const last = lassoPoints.at(-1);
      if (!last || Math.hypot(location.x - last.x, location.y - last.y) * scale >= 2) setLassoPoints(points => [...points, location]);
      setLassoCursor(location); setPointerCursor('crosshair'); setError(null); return;
    }
    const hit = event.altKey || tool === 'marquee' ? null : hitLayer(location);
    if (hit && event.shiftKey) { finishGesture(); setSelectedIds(ids => ids.includes(hit.id) ? ids.filter(id => id !== hit.id) : [...ids, hit.id]); clearSelection(); return; }
    if (hit) { beginMove(event, hit); return; }
    finishGesture(); event.currentTarget.focus({ preventScroll: true }); choose(null);
    marquee.current = { ...location, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, started: false };
    setPointerView({ surface, scale });
    setPointerCursor('crosshair'); event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if(repairMode)return;
    if (tool === 'lasso' && !busy) { setPointerCursor('crosshair'); if (lassoPoints.length) setLassoCursor(point(event)); return; }
    if (marquee.current?.pointerId === event.pointerId) {
      const cursor = point(event), start = marquee.current;
      if (!start.started && Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 4) return;
      start.started = true;
      setSelection({ left: Math.min(start.x, cursor.x), top: Math.min(start.y, cursor.y), width: Math.abs(cursor.x - start.x), height: Math.abs(cursor.y - start.y) }); return;
    }
    const active = drag.current;
    if (busy) return;
    if (!active) { setPointerCursor(event.altKey || tool === 'marquee' || !hitLayer(point(event)) ? 'crosshair' : 'grab'); return; }
    if (active.pointerId !== event.pointerId) return;
    if (!active.started && Math.hypot(event.clientX - active.startX, event.clientY - active.startY) < 4) return;
    if (!active.started) { active.started = true; beginGesture(); }
    const dx = (event.clientX - active.startX) / scale, dy = (event.clientY - active.startY) / scale, layer = active.layer, bounds = boundsOf(layer);
    if (active.resize) {
      const ratio = Math.max(.02, 1 + 2 * dx / bounds.width);
      const graphicRatio = layer.kind === 'graphic' ? Math.max(1 / Math.min(layer.value.width, layer.value.height), Math.min(ratio, S * 2 / Math.max(layer.value.width, layer.value.height))) : ratio;
      change(current => updateArtworkLayer(current, active.id, layer.kind === 'graphic' ? { width: layer.value.width * graphicRatio, height: layer.value.height * graphicRatio } : { fontSize: Math.min(300, Math.max(8, layer.value.fontSize * ratio)), letterSpacing: Math.min(80, Math.max(-20, layer.value.letterSpacing * ratio)) })); return;
    }
    const other = layers.find(item => item.id !== active.id && !active.companions.some(companion => companion.id === item.id) && item.value.visible !== false);
    const otherBounds = other ? boundsOf(other) : null;
    const result = snapArtworkPosition({ rawX: bounds.left + bounds.width / 2 + dx - surface.left, rawY: bounds.top + bounds.height / 2 + dy - surface.top, movingWidth: bounds.width, movingHeight: bounds.height, canvasWidth: surface.width, canvasHeight: surface.height, otherBounds: otherBounds ? { ...otherBounds, left: otherBounds.left - surface.left, top: otherBounds.top - surface.top } : null, threshold: ARTWORK_SNAP_SCREEN_PX / scale, enabled: snap });
    setGuides(result.guides.map(guide => ({ ...guide, position: guide.position + (guide.axis === 'x' ? surface.left : surface.top) })));
    const deltaX = result.x + surface.left - bounds.left - bounds.width / 2, deltaY = result.y + surface.top - bounds.top - bounds.height / 2;
    change(current => { const moved = [layer, ...active.companions].reduce((next, item) => updateArtworkLayer(next, item.id, { x: item.value.x + deltaX, y: item.value.y + deltaY }), current); return { ...moved, layout: { ...current.layout, preset: 'custom' } }; });
  };
  const endPointer = (event?: PointerEvent<HTMLDivElement>) => {
    const start = marquee.current;
    if (start?.started && event) {
      const cursor = point(event), area = { left: Math.min(start.x, cursor.x), top: Math.min(start.y, cursor.y), width: Math.abs(cursor.x - start.x), height: Math.abs(cursor.y - start.y) };
      setSelection(area);
      setSelectedIds(layersInSelection(area));
    }
    drag.current = null; marquee.current = null; finishGesture(); setPointerView(null); setGuides([]); setPointerCursor('crosshair');
  };
  const extract = async (copy: boolean, recolor?: ArtworkGraphicLayer['recolor']) => {
    if (!selectedIds.length || !selection || busy || extracting.current || selectedIds.some(id => layers.find(layer => layer.id === id)?.kind !== 'graphic')) return;
    extracting.current = true;
    finishGesture(); setSplitting(true); setError(null);
    try {
      let next = historyRef.current.present;
      const extractedIds: string[] = [];
      for (const id of selectedIds) {
        const result = await splitArtworkGraphic(next, id, selection, copy);
        next = result.draft; extractedIds.push(result.selectedId);
      }
      // Apply color only after the polygon's pixels have been isolated, in one undo step.
      if (recolor) for (const id of extractedIds) next = updateArtworkLayer(next, id, { recolorScope: 'visible', recolor });
      change(() => next); setSelectedIds(extractedIds); clearSelection(); setTool('auto');
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { extracting.current = false; setSplitting(false); }
  };
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Tab') {
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]') ?? [])].filter(element => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (busy || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"]'))) return;
    const key = event.key.toLowerCase();
    if (lassoPoints.length && event.key === 'Enter') { event.preventDefault(); closeLasso(); return; }
    if (lassoPoints.length && ['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); setLassoPoints(points => points.slice(0, -1)); setError(null); return; }
    if ((event.metaKey || event.ctrlKey) && key === 'z') { event.preventDefault(); travel(event.shiftKey ? 'redo' : 'undo'); return; }
    if (!(event.metaKey || event.ctrlKey) && key === 't') { event.preventDefault(); addText(); return; }
    if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); modifyLayers('delete'); return; }
    if (event.key === 'Escape') { if(repairMode)setTool('auto'); endPointer(); clearSelection(); setError(null); return; }
    if (!selected || selected.value.visible === false || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !(event.target instanceof HTMLElement && event.target.closest('[role="application"]'))) return;
    event.preventDefault(); const step = event.shiftKey ? 10 : 1;
    patch({ x: selected.value.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), y: selected.value.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) });
  };
  const empty = !layers.some(layer => layer.value.visible !== false);
  const save = async () => { finishGesture(); setError(null); try { await onSave(structuredClone(historyRef.current.present)); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } };
  const canArrange = layers.some(layer => layer.kind === 'graphic' && layer.value.visible !== false) && layers.some(layer => layer.kind === 'text' && layer.value.visible !== false);
  const emptyText = layers.some(layer => layer.kind === 'text' && !layer.value.value.trim());
  const centerAll = () => change(current => {
    const visible = artworkLayers(current).filter(layer => layer.value.visible !== false), bounds = visible.map(boundsOf);
    if (!bounds.length) return current;
    const left = Math.min(...bounds.map(b => b.left)), right = Math.max(...bounds.map(b => b.left + b.width));
    const top = Math.min(...bounds.map(b => b.top)), bottom = Math.max(...bounds.map(b => b.top + b.height));
    return visible.reduce((value, layer) => updateArtworkLayer(value, layer.id, { x: layer.value.x + 512 - (left + right) / 2, y: layer.value.y + 512 - (top + bottom) / 2 }), current);
  });
  const canEditSelection = Boolean(selection && selectedIds.length && selectedIds.every(id => layers.find(layer => layer.id === id)?.kind === 'graphic'));
  const selectedColor = text?.color ?? (graphic?.recolor.mode === 'solid' ? graphic.recolor.color : null);
  const setGraphicColor = (recolor: ArtworkGraphicLayer['recolor']) => {
    if (selection) { void extract(false, recolor); return; }
    if (!busy) patch({ recolorScope: 'visible', recolor });
  };
  const setColor = (color: string) => !selection && text ? patch({ color }) : setGraphicColor({ mode: 'solid', color });
  const colorLabel = selection ? '选区颜色' : text ? '文字颜色' : '图层颜色';
  const colorControls = <div className="artwork-v2-swatches">{SWATCHES.map(color => <button key={color} type="button" className="artwork-v2-swatch" style={{ background: color }} aria-label={`${colorLabel} ${color}`} aria-pressed={selectedColor === color} onClick={() => setColor(color)}/>)}<input type="color" aria-label={colorLabel} value={selectedColor ?? '#44416d'} onChange={event => setColor(event.target.value)}/><code>{selectedColor?.toUpperCase() ?? '原色'}</code></div>;

  return <div className="artwork-editor-backdrop artwork-v2-backdrop" role="presentation"><section className="artwork-editor-dialog artwork-layer-editor artwork-editor-approved" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${title}图案精修`} onKeyDown={keys}>
    <header className="artwork-editor-header"><span className="artwork-v2-mark"><EditorIcon name="layers"/></span><div><span>图案编辑</span><h2>{title.replace(/\s*·\s*图案调整$/u, '')}</h2></div><p className="artwork-v2-context"><span>图案与文字独立编辑</span>选中内容，在右侧调整</p><button type="button" aria-label="关闭图案精修" disabled={busy} onClick={onCancel}>×</button></header>
    {repairEnabled ? (<div className="artwork-v2-tools flat-tools" role="toolbar" aria-label="图案编辑工具">
      <span className="tool-group-label">编辑</span>
      <button type="button" disabled={busy} aria-label="选择与移动" aria-pressed={tool==='auto'} onClick={()=>{setTool('auto');clearSelection();}}><EditorIcon name="pointer"/>移动</button>
      <button type="button" disabled={busy||layers.length>=64} onClick={addText}><EditorIcon name="text"/>添加文字</button>
      <button type="button" disabled={busy} aria-label="框选拆层" aria-pressed={tool==='marquee'} onClick={()=>{setTool('marquee');clearSelection();setPreviewOpen(false);}}><EditorIcon name="select"/>框选</button>
      <button type="button" disabled={busy} aria-label="多边形套索" aria-pressed={tool==='lasso'} onClick={()=>{finishGesture();setTool('lasso');clearSelection();setSelectedIds([]);setPreviewOpen(false);}}><EditorIcon name="lasso"/>套索</button>
      <span className="artwork-v2-divider"/><span className="tool-group-label">修补</span>
      {(['fill','keep','remove'] as const).map(mode=><button type="button" className="flat-repair-tool" key={mode} aria-label={mode==='fill'?'补空白':mode==='keep'?'保留笔':'去除笔'} disabled={busy||!layers.some(layer=>layer.kind==='graphic'&&layer.value.visible!==false)} aria-pressed={tool===mode} title={mode==='fill'?'点击画布空洞补回整块':mode==='keep'?'涂抹恢复原图内容':'涂抹去除多余部分'} onClick={()=>startRepair(mode)}><span className={'flat-tool-symbol '+mode} aria-hidden="true">{mode==='fill'?'◒':mode==='keep'?'＋':'−'}</span>{mode==='fill'?'补空白':mode==='keep'?'保留笔':'去除笔'}</button>)}
      <span className="artwork-v2-divider"/>
      <button type="button" disabled={busy||(!history.past.length&&!gestureChanged)} onClick={()=>travel('undo')} aria-label="撤销" title="撤销 ⌘Z"><EditorIcon name="undo"/></button>
      <button type="button" disabled={busy||!history.future.length} onClick={()=>travel('redo')} aria-label="重做" title="重做 ⇧⌘Z"><EditorIcon name="redo"/></button>
      <button type="button" className="artwork-v2-snap" disabled={busy} aria-pressed={snap} onClick={()=>setSnap(v=>!v)}>吸附：{snap?'开':'关'}</button>
    </div>) : (<div className="artwork-v2-tools" role="toolbar" aria-label="图案编辑工具">
      <button type="button" className="primary artwork-v2-add" disabled={busy || layers.length >= 64} onClick={addText}><EditorIcon name="text"/>添加文字</button>
      <button type="button" className="artwork-v2-icon" disabled={busy} aria-label="选择与移动" title="选择与移动" aria-pressed={tool === 'auto'} onClick={() => { setTool('auto'); clearSelection(); }}><EditorIcon name="pointer"/></button>
      <button type="button" className="artwork-v2-icon" disabled={busy} aria-label="框选拆层" title="框选拆层" aria-pressed={tool === 'marquee'} onClick={() => { setTool('marquee'); clearSelection(); setPreviewOpen(false); }}><EditorIcon name="select"/></button>
      <button type="button" className="artwork-v2-lasso-tool" disabled={busy} aria-label="多边形套索" title="多边形套索：逐点圈选不规则区域" aria-pressed={tool === 'lasso'} onClick={() => { finishGesture(); setTool('lasso'); clearSelection(); setSelectedIds([]); setPreviewOpen(false); }}><EditorIcon name="lasso"/>套索</button>
      <span className="artwork-v2-divider"/>
      <button type="button" className="artwork-v2-icon" disabled={busy || (!history.past.length && !gestureChanged)} onClick={() => travel('undo')} aria-label="撤销" title="撤销 ⌘Z"><EditorIcon name="undo"/></button><button type="button" className="artwork-v2-icon" disabled={busy || !history.future.length} onClick={() => travel('redo')} aria-label="重做" title="重做 ⇧⌘Z"><EditorIcon name="redo"/></button>
      <span className="artwork-v2-tool-hint">点选图案或文字，分别编辑</span><button type="button" className="artwork-v2-snap" disabled={busy} aria-pressed={snap} onClick={() => setSnap(value => !value)}>自动吸附：{snap ? '开' : '关'}</button>
    </div>)}
    <div className="artwork-editor-body">
      <aside className="artwork-v2-layers" aria-label="图层面板"><div className="artwork-v2-panel-title"><strong>图层</strong><small>{layers.length} 个图层</small></div><div className="artwork-v2-layer-scroll"><div className="artwork-layer-list">{[...layers].reverse().map(layer => <div key={layer.id} className={`artwork-layer-row${selectedIds.includes(layer.id) ? ' active' : ''}${layer.value.visible === false ? ' hidden-layer' : ''}`}>
        <button type="button" className="artwork-layer-pick" aria-label={`选择图层：${labelOf(layer)}`} aria-pressed={selectedIds.includes(layer.id)} disabled={busy} onClick={() => choose(layer.id)}><span className="artwork-layer-thumb" style={layer.kind === 'graphic' ? { backgroundImage: `url(${JSON.stringify(layer.value.sourceUrl)})` } : undefined}>{layer.kind === 'text' ? 'T' : ''}</span><span>{labelOf(layer)}<small>{layer.kind === 'text' ? '可编辑文字' : '图片图层'}</small></span></button>
        <button type="button" className="artwork-layer-visibility" aria-label={`${layer.value.visible === false ? '显示' : '隐藏'}${labelOf(layer)}`} aria-pressed={layer.value.visible !== false} disabled={busy} onClick={() => { finishGesture(); change(current => updateArtworkLayer(current, layer.id, { visible: layer.value.visible === false })); clearSelection(); }}>{layer.value.visible === false ? '○' : <EditorIcon name="eye"/>}</button>
      </div>)}</div><button type="button" className="artwork-v2-add-inline" disabled={busy || layers.length >= 64} onClick={addText}><EditorIcon name="plus"/>再添加一段文字</button><p className="artwork-v2-help">每段文字都是独立图层，<br/>可单独改字、换色和移动。</p></div>
      <div className="artwork-v2-layer-footer"><div className="artwork-v2-layer-actions"><button type="button" disabled={busy || !selected || layers.at(-1)?.id === selectedId} aria-label="图层上移" title="上移一层" onClick={() => { finishGesture(); change(current => reorderArtworkLayer(current, selectedId!, 1)); }}><EditorIcon name="up"/></button><button type="button" disabled={busy || !selected || layers[0]?.id === selectedId} aria-label="图层下移" title="下移一层" onClick={() => { finishGesture(); change(current => reorderArtworkLayer(current, selectedId!, -1)); }}><EditorIcon name="down"/></button><button type="button" disabled={busy || !selectedIds.length || layers.length + selectedIds.length > 64} aria-label="复制图层" title="复制所选图层" onClick={() => modifyLayers('duplicate')}><EditorIcon name="copy"/></button><button type="button" disabled={busy || !selectedIds.length} aria-label="删除图层" title="删除所选图层" onClick={() => modifyLayers('delete')}><EditorIcon name="trash"/></button></div>
      <details className="artwork-v2-requirement"><summary>查看 WPS 原文与要求</summary><p>{originalRequirement}</p></details></div></aside>
      <div className="artwork-editor-canvas-column">
        <div className="artwork-editor-toolbar"><strong>{previewOpen ? '上衣效果与字高' : '透明图案'}</strong><span className="artwork-v2-current">{selected ? `已选择：${labelOf(selected)}` : selectedIds.length ? `已选择 ${selectedIds.length} 个图层` : '点击图案或文字进行编辑'}</span>{renderPreview && <button type="button" aria-expanded={previewOpen} onClick={() => { clearSelection(); setPreviewOpen(value => !value); }}>{previewOpen ? '返回编辑画布' : '上衣效果与字高 ↗'}</button>}</div>
      <div className="artwork-editor-canvas-viewport" ref={viewport} hidden={previewOpen}><div className={`artwork-editor-artboard artwork-background-${background}`} style={{ width: surface.width * scale, height: surface.height * scale, cursor: pointerCursor }} ref={board} role="application" aria-label="图案编辑画布" tabIndex={0} onPointerMove={move} onPointerUp={endPointer} onPointerCancel={() => { endPointer(); clearSelection(); setSelectedIds([]); }} onPointerDown={beginPointer}>
        {layers.filter(layer => layer.value.visible !== false).map(layer => {
          const bounds = layer.kind === 'graphic' ? artworkGraphicFrame(layer.value) : boundsOf(layer);
          return <button type="button" key={layer.id} data-layer-id={layer.id} aria-label={`${labelOf(layer)}图层`} aria-pressed={selectedIds.includes(layer.id)} className={`artwork-editor-layer ${layer.kind}${!selection && selectedIds.includes(layer.id) ? ' selected' : ''}`} style={{ left: (bounds.left - surface.left) * scale, top: (bounds.top - surface.top) * scale, width: bounds.width * scale, height: bounds.height * scale, transform: layer.kind === 'graphic' ? `rotate(${layer.value.rotation}deg)` : undefined, zIndex: layers.findIndex(item => item.id === layer.id) + 1, cursor: 'inherit' }} disabled={busy} onClick={event => { if (event.detail === 0) { event.stopPropagation(); choose(layer.id); } }}>
            {layer.kind === 'graphic' ? (repairMode&&selectedId===layer.id?<InlineRepair graphic={layer.value} originalURL={layer.id===initialDraft.graphic.id&&!layer.value.sourceBounds?repairOriginalURL:undefined} mode={repairMode} scope={repairScope} radius={repairRadius} displayWidth={bounds.width*scale} displayHeight={bounds.height*scale} onCommit={url=>change(current=>updateArtworkLayer(current,layer.id,{sourceUrl:url}))} onStatus={setRepairMessage} onReady={setCanRestore}/>:<GraphicView graphic={layer.value} onError={setError}/>) : <TextView text={layer.value} scale={scale} onError={setError} onFontLoaded={fontLoaded}/>}
            {selectedId === layer.id && !selection && tool === 'auto' && <span className="artwork-editor-resize" title="拖动等比缩放" onPointerDown={event => beginMove(event, layer, true)}/>}
          </button>;
        })}
        {guides.map(guide => <i key={`${guide.axis}:${guide.label}`} className={`artwork-editor-smart-guide ${guide.axis}`} style={{ zIndex: 100, ...(guide.axis === 'x' ? { left: (guide.position - surface.left) * scale } : { top: (guide.position - surface.top) * scale }) }}/>) }
        {selection && !selection.points && <div className="artwork-marquee" style={{ left: (selection.left - surface.left) * scale, top: (selection.top - surface.top) * scale, width: selection.width * scale, height: selection.height * scale }} aria-label="当前矩形选区"/>}
        {(lassoPoints.length > 0 || selection?.points) && <svg className="artwork-lasso-overlay" viewBox={`0 0 ${surface.width * scale} ${surface.height * scale}`} role="img" aria-label={selection?.points ? '当前多边形选区' : '正在绘制套索'}>
          {selection?.points ? <polygon points={selection.points.map(p => `${(p.x - surface.left) * scale},${(p.y - surface.top) * scale}`).join(' ')} fillRule="evenodd"/> : <>
            <polyline points={[...lassoPoints, ...(lassoCursor ? [lassoCursor] : [])].map(p => `${(p.x - surface.left) * scale},${(p.y - surface.top) * scale}`).join(' ')}/>
            {lassoPoints.map((p, index) => <circle key={index} cx={(p.x - surface.left) * scale} cy={(p.y - surface.top) * scale} r={index === 0 ? 5 : 3} className={index === 0 ? 'lasso-start' : undefined}/>)}
          </>}
        </svg>}
      </div></div>

        {previewOpen && renderPreview && <div className="artwork-v2-garment-preview">{renderPreview(draft)}</div>}
        <div className="artwork-selection-actions">{repairMode?<p className="inline-repair-status" role="status">{repairMessage}</p>:!previewOpen && lassoPoints.length > 0 ? <>
          <p>逐点圈选 · 点击起点或 Enter 闭合 · Backspace 退一点</p>
          <button type="button" className="primary" disabled={busy || lassoPoints.length < 3} onClick={closeLasso}>闭合选区</button>
          <button type="button" disabled={busy} onClick={() => { setLassoPoints(points => points.slice(0, -1)); setError(null); }}>退回一点</button>
          <button type="button" disabled={busy} onClick={clearSelection}>取消选区</button>
        </> : selection && !previewOpen && selection.width > 0 && selection.height > 0 ? <>
          <button type="button" className="primary" disabled={busy || !selectedIds.length || selectedIds.some(id => layers.find(layer => layer.id === id)?.kind !== 'graphic')} onClick={() => void extract(false)}>拆为新图层</button>
          <button type="button" disabled={busy || !selectedIds.length || selectedIds.some(id => layers.find(layer => layer.id === id)?.kind !== 'graphic')} onClick={() => void extract(true)}>复制为新图层</button>
          <button type="button" disabled={busy} onClick={clearSelection}>取消选区</button>
          {!selectedIds.length && <p>选区内没有可见内容，请重新圈选。</p>}
        </> : <p>{splitting ? '正在拆分图层…' : previewOpen ? '位置与字高沿用当前任务设置' : tool === 'lasso' ? '逐点圈住要改色的部分，闭合后可直接选颜色；Esc 取消' : tool === 'marquee' ? '拖动框选图片区域，拆出独立图层；原字仍为图片内容' : '拖动移动 · 拖动角点缩放 · Shift 多选 · 方向键微调'}</p>}</div>
        <div className="artwork-v2-canvas-footer"><div className="artwork-v2-backgrounds"><span>背景</span>{(['checker', 'white', 'dark'] as const).map(value => <button type="button" key={value} className={`artwork-background-${value}`} aria-label={value === 'checker' ? '透明棋盘背景' : value === 'white' ? '白色背景' : '深色背景'} aria-pressed={background === value} onClick={() => setBackground(value)}/>)}</div><div className="artwork-editor-zoom"><button type="button" aria-label="缩小视图" onClick={() => setZoom(value => Math.max(.5, value - .25))}>−</button><span>{Math.round(zoom * 100)}%</span><button type="button" aria-label="放大视图" onClick={() => setZoom(value => Math.min(3, value + .25))}>＋</button><button type="button" onClick={() => setZoom(1)}>适应全部</button></div></div>
      </div>
      <aside className="artwork-editor-inspector" ref={inspector} aria-label="属性面板">
        <div className="artwork-v2-property-title"><span>{text ? 'T' : graphic ? <EditorIcon name="layers"/> : <EditorIcon name="select"/>}</span><strong>{repairMode ? repairLabel : selection ? '选区编辑' : text ? '文字编辑' : graphic ? '图片编辑' : selectedIds.length > 1 ? '多图层选择' : '整体图案'}</strong><small>{repairMode?'直接在画布操作':selection ? '仅圈内像素' : text ? '独立文字图层' : graphic ? '图片图层' : ''}</small></div>
        <fieldset className="artwork-properties" disabled={busy} onFocusCapture={event => { if (event.target instanceof HTMLElement && event.target.matches('input,textarea')) beginGesture(); }} onBlurCapture={finishGesture}>
          {repairMode&&<section className="artwork-v2-property-section flat-repair-settings"><span className="flat-current-layer">当前图层 · {graphic?.label||'图片'}</span><h3>{repairMode==='fill'?'点一下，补回空洞':repairMode==='keep'?'涂抹，恢复内容':'涂抹，去除内容'}</h3><p className="flat-repair-help">{repairMode==='fill'?'点击图案内部仍然透明的地方。默认补满这一整块空洞。':repairMode==='keep'?'画笔经过的区域会恢复抠图前的原始内容。':'画笔经过的像素会变成透明，其他区域保持原样。'}</p>
            {repairMode==='fill'&&<><label>补回范围</label><div className="artwork-editor-segmented"><button type="button" aria-pressed={repairScope==='region'} onClick={()=>setRepairScope('region')}>整块空洞</button><button type="button" aria-pressed={repairScope==='brush'} onClick={()=>setRepairScope('brush')}>画笔圈内</button></div></>}
            {(repairMode!=='fill'||repairScope==='brush')&&<label>画笔直径 · {repairRadius*2} px<input aria-label="修补画笔大小" type="range" min="2" max="256" value={repairRadius*2} onChange={e=>setRepairRadius(+e.target.value/2)}/></label>}
            {repairMode!=='remove'&&!canRestore&&<p className="flat-restore-note">正在核对原图；若当前图层没有对应原图，可使用去除笔。</p>}
            <div className="flat-repair-note">{repairMode==='fill'?'被图案分隔的空洞，分别点击。与外部背景连通的空白不会整片填回。':repairMode==='keep'?'保留笔也会恢复经过的背景，放大画布更方便控制边缘。':'可以随时用顶部“撤销”回退这一笔。'}<br/><br/>修改直接进入当前草稿，和改字、选区共用顶部撤销与底部保存。</div>
          </section>}
          {selection && <section className="artwork-v2-property-section">
            {canEditSelection ? <><label>选区颜色</label>{colorControls}<button type="button" className="artwork-v2-wide" onClick={() => setGraphicColor({ mode: 'original', color: null })}>选区保留原色</button><p className="artwork-v2-note">只修改圈内的图片像素，圈外保持不变。改色时自动拆成独立图层，可一次撤销。</p></> : <p className="artwork-v2-note">{selectedIds.length ? '选区包含独立文字，请先选择图片区域后改色。' : '选区内没有可见内容，请重新圈选。'}</p>}
          </section>}
          {text && !selection && <>
            <section className="artwork-v2-property-section"><label>文字内容 <small>支持换行</small><textarea ref={textInput} aria-label="文字内容" value={text.value} maxLength={4000} placeholder="在这里输入要添加的文字" onChange={event => patch({ value: event.target.value, label: event.target.value.trim().split('\n')[0].slice(0, 24) || '空白文字' })}/></label><p className="artwork-v2-help">直接改字，画布同步更新。</p></section>
            <section className="artwork-v2-property-section"><h3>文字变形</h3><div className="artwork-editor-segmented">{(['none', 'up', 'down'] as const).map(mode => <button type="button" key={mode} aria-pressed={text.arc.mode === mode} onClick={() => patch({ arc: { ...text.arc, mode } })}>{mode === 'none' ? '直排' : mode === 'up' ? '上弧' : '下弧'}</button>)}</div>{text.arc.mode !== 'none' && <><label>弯曲程度 {text.arc.bend}%<input type="range" aria-label="弯曲强度" min="0" max="100" value={text.arc.bend} onChange={event => patch({ arc: { ...text.arc, bend: Number(event.target.value) } })}/></label><p className="artwork-v2-help">弧形按单行显示，切回直排保留原换行。</p></>}</section>
            <section className="artwork-v2-property-section"><label>字体<select aria-label="字体" value={text.fontFamily} onChange={event => patch({ fontFamily: event.target.value })}>{!FONTS.some(([value]) => value === text.fontFamily) && <option value={text.fontFamily}>{text.fontFamily}</option>}{FONTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="artwork-v2-form-row"><NumericInput label="文字字号" value={text.fontSize} min={8} max={300} onChange={fontSize => patch({ fontSize })}/><NumericInput label="文字字距" value={text.letterSpacing} min={-20} max={80} onChange={letterSpacing => patch({ letterSpacing })}/></div><div className="artwork-editor-segmented"><button type="button" aria-label="粗体" aria-pressed={text.fontWeight >= 700} onClick={() => patch({ fontWeight: text.fontWeight >= 700 ? 500 : 700 })}><b>B</b></button><button type="button" aria-label="斜体" aria-pressed={text.italic} onClick={() => patch({ italic: !text.italic })}><i>I</i></button><button type="button" aria-label="下划线" aria-pressed={text.underline} onClick={() => patch({ underline: !text.underline })}><u>U</u></button></div><label className="artwork-v2-weight">字重<select aria-label="字重" value={text.fontWeight} onChange={event => patch({ fontWeight: Number(event.target.value) as ArtworkTextLayer['fontWeight'] })}>{[400, 500, 600, 700, 800].map(value => <option key={value} value={value}>{value}</option>)}</select></label></section>
            <section className="artwork-v2-property-section"><label>文字颜色</label>{colorControls}<label>文字对齐</label><div className="artwork-editor-segmented">{(['left', 'center', 'right'] as const).map(align => <button key={align} type="button" aria-pressed={text.align === align} onClick={() => patch({ align })}>{align === 'left' ? '左对齐' : align === 'center' ? '居中' : '右对齐'}</button>)}</div><div className="artwork-v2-form-row"><NumericInput label="行距" value={text.lineHeight ?? 1.4} min={1} max={3} step={.1} suffix="倍" onChange={lineHeight => patch({ lineHeight })}/><NumericInput label="对齐框宽度" value={text.boxWidth} min={20} max={S * 2} onChange={boxWidth => patch({ boxWidth })}/></div></section>
          </>}
          {graphic && !selection && !repairMode && <><section className="artwork-v2-property-section"><label>图层名称<input aria-label="图层名称" maxLength={80} value={graphic.label ?? labelOf(selected!)} onChange={event => patch({ label: event.target.value })}/></label><label>笔画加粗 <small>{graphic.inkSpread ? `强度 ${graphic.inkSpread.toFixed(1)}` : '原始'}</small><input type="range" aria-label="图片笔画加粗" min="0" max="3" step="0.1" value={graphic.inkSpread ?? 0} onPointerDown={beginGesture} onPointerUp={finishGesture} onPointerCancel={finishGesture} onChange={event => patch({ inkSpread: Number(event.target.value) })}/></label><div className="artwork-v2-spread-labels"><span>原始</span><span>轻微</span><span>较粗</span></div><button type="button" className="artwork-v2-wide" disabled={!graphic.inkSpread} onClick={() => { finishGesture(); patch({ inkSpread: 0 }); }}>恢复原始粗细</button><p className="artwork-v2-note">只加粗当前图片图层的笔画，透明背景保持不变。建议从轻微开始，留意小字内孔和字间距。</p><label>图层颜色</label>{colorControls}<button type="button" className="artwork-v2-wide" aria-pressed={graphic.recolor.mode === 'original'} onClick={() => setGraphicColor({ mode: 'original', color: null })}>保留原色</button><p className="artwork-v2-note">图片中的原字仍属于图片。可以另外添加文字，不会改动原图内容。</p><button type="button" className="artwork-v2-add-inline" onClick={addText}><EditorIcon name="plus"/>在图案旁添加文字</button></section><section className="artwork-v2-property-section"><h3>大小与位置</h3><div className="artwork-v2-form-row"><NumericInput label="图层宽度" value={graphic.width} min={1} max={Math.min(S * 2, S * 2 * graphic.width / graphic.height)} onChange={width => patch({ width, height: graphic.height * width / graphic.width })}/><NumericInput label="旋转" value={graphic.rotation} min={-180} max={180} suffix="°" onChange={rotation => patch({ rotation })}/></div></section></>}
          {selected && !selection && !repairMode && <section className="artwork-v2-property-section"><div className="artwork-editor-segmented"><button type="button" onClick={() => { const bounds = boundsOf(selected); patch({ x: selected.value.x + 512 - bounds.left - bounds.width / 2 }); }}>水平居中</button><button type="button" onClick={() => { const bounds = boundsOf(selected); patch({ y: selected.value.y + 512 - bounds.top - bounds.height / 2 }); }}>垂直居中</button></div>{selected.value.visible === false && <p className="artwork-v2-note">当前图层已隐藏，可在图层列表中显示。</p>}</section>}
          {!selected && !selection && <section className="artwork-v2-property-section"><button type="button" className="primary artwork-v2-wide" onClick={addText}><EditorIcon name="text"/>添加独立文字</button><p className="artwork-v2-help">{selectedIds.length > 1 ? '所选图层可以一起移动、复制或删除；点选一个图层可修改其属性。' : '选择图层分别编辑，或调整整体图文关系。'}</p></section>}
          <section hidden={!!repairMode} className="artwork-v2-property-section"><h3>整体排版</h3><div className="artwork-v2-layout-options">{(['vertical', 'verticalReverse', 'horizontal', 'horizontalReverse'] as const).map(preset => <button type="button" key={preset} disabled={!canArrange} aria-pressed={draft.layout.preset === preset} onClick={() => change(current => arrangePair(current, preset))}><span aria-hidden="true">{preset === 'vertical' ? '▧ / T' : preset === 'verticalReverse' ? 'T / ▧' : preset === 'horizontal' ? '▧ T' : 'T ▧'}</span>{preset === 'vertical' ? '图上字下' : preset === 'verticalReverse' ? '字上图下' : preset === 'horizontal' ? '图左字右' : '字左图右'}</button>)}<button type="button" onClick={centerAll}><span aria-hidden="true">⊞</span>整体居中</button></div>{canArrange ? <><label>图文间距 {draft.layout.gap}px<input type="range" aria-label="图文间距" min="0" max="160" value={draft.layout.gap} onChange={event => { const gap = Number(event.target.value); change(current => arrangePair(current, current.layout.preset === 'custom' ? 'vertical' : current.layout.preset, gap)); }}/></label><label>整体对齐</label><div className="artwork-editor-segmented">{(['left', 'center', 'right'] as const).map(align => <button type="button" key={align} aria-pressed={draft.layout.groupAlign === align} onClick={() => change(current => arrangePair(current, current.layout.preset === 'custom' ? 'vertical' : current.layout.preset, current.layout.gap, align))}>{align === 'left' ? '起点' : align === 'center' ? '居中' : '终点'}</button>)}</div></> : <p className="artwork-v2-help">添加文字后，可一键安排图文关系。</p>}</section>
          {selectedIds.length > 0 && !repairMode && <section className="artwork-v2-property-section"><div className="artwork-editor-segmented"><button type="button" onClick={() => modifyLayers('duplicate')}><EditorIcon name="copy"/>复制图层</button><button type="button" onClick={() => modifyLayers('delete')}><EditorIcon name="trash"/>删除</button></div></section>}
        </fieldset>
      </aside>
    </div>
    {(error || empty || emptyText) && <div className="artwork-editor-error" role="alert">{error ?? (empty ? '至少显示一个图层后再保存。' : '有空白文字图层，请填写内容或删除该层后保存。')}</div>}
    <footer className="artwork-editor-footer"><div><strong><i/>{layers.length} 个图层 · {layers.filter(layer => layer.value.visible !== false).length} 个可见</strong><span>{saveHint}</span></div><div><button type="button" disabled={busy} onClick={() => { finishGesture(); change(() => editableArtworkDraft(initialDraft)); setSelectedIds([]); clearSelection(); }}>恢复打开时状态</button><button type="button" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="primary" disabled={busy || empty || emptyText} onClick={() => void save()}>{saving ? '正在保存图层与 PNG…' : saveLabel}</button></div></footer>
  </section></div>;
}
