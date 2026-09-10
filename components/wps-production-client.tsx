'use client';
import { ProductionOperationLocks, productionOperation, productionOperationsOverlap, type ProductionOperation } from '@/lib/production-operation-lock';
import { artworkPixelFingerprint } from '@/lib/artwork-save-fingerprint';
import { artworkInputSelection, currentArtworkAmbiguities, isReferenceTextArtwork, artworkPlanIssues, isTextOnlyArtwork } from '@/lib/artwork-reference';
import { createProductionTextDraft, productionTextColor, requestedProductionTextColor } from '@/lib/client/production-text-artwork';
import { artworkBlockingAmbiguities, artworkProcessingRoute } from '@/lib/task-review-analysis';
import { productionFileId } from '@/lib/production-file-url';

import Image from 'next/image';
import { WpsMaterialImage } from '@/components/wps-material-image';
import { WpsCutoutControls, CutoutTaskStatus, cutoutInputDataUrl, cutoutRequest, type CutoutSession } from '@/components/wps-cutout-controls';
import { useArtworkCutoutSessions } from '@/hooks/use-artwork-cutout-sessions';
import { CUTOUT_ROUTE_LABELS, cutoutFeeLabel, type ArtworkCutoutMode, type ArtworkCutoutResult } from '@/lib/artwork-cutout';
import { WpsArtworkReview } from '@/components/wps-artwork-review';
import { WpsArtworkRouting, WpsArtworkMethodSelector } from '@/components/wps-artwork-routing';
import '@/components/wps-production-compact.css';
import { WpsPlacementEditor, type PlacementUpdate } from '@/components/wps-placement-editor';
import { WpsMockupPreview } from '@/components/wps-mockup-preview';
import { reuseProductionGeometry } from '@/lib/production-preview';
import { DEFAULT_WPS_STATUSES, WpsStatusFilter } from '@/components/wps-status-filter';
import { WPS_COMPOSITOR_VERSION } from '@/lib/confirmation-frame';
import { productionArtworkRouting, productionRecipe } from '@/lib/production-recipe';
import { initialTaskPlacement, productionArtworkStage } from '@/lib/production-preview';
import type { ArtworkValidation } from '@/lib/wps-production';
import type { BrowserLogoTextVerification } from '@/lib/client/browser-logo-ocr';
import { WPS_ANALYSIS_CONCURRENCY } from '@/lib/client/task-review-analysis-batch';
import { useWpsAutomaticAnalysis } from '@/hooks/use-wps-automatic-analysis';
import { WpsAnalysisStatusNotice } from '@/components/wps-analysis-status';
import { ARTWORK_CONCURRENCY, ArtworkWorkQueue, ArtworkQueueCancelledError, type ArtworkQueueJob } from '@/lib/artwork-work-queue';
import { productionArtworkSnapshot, assertProductionArtworkSnapshot, newerProductionState, productionActionSnapshot } from '@/lib/production-artwork-snapshot';
import { WpsArtworkSizePreview } from '@/components/wps-artwork-size-preview';
import { TaskReviewArtworkEditor } from '@/components/task-review-artwork-editor';
import { standardArtworkPrompts } from '@/lib/artwork-routing-request';
import { artworkAcceptanceIssues } from '@/lib/artwork-acceptance';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { WpsGarmentPreview, WpsGarmentSelector } from '@/components/wps-garment-selector';
import type { CatalogStyle } from '@/lib/catalog';
import { productionPositionLabel } from '@/lib/production-garment';
import { AppHeader } from '@/components/app-header';
import { useProjectSession } from '@/components/project-session';
import { artworkGraphicLayers, createLegacyArtworkDraft, type ArtworkDraft, type ArtworkGraphicLayer } from '@/lib/artwork-editor';
import type { SourceTaskRecord, TaskReview } from '@/lib/batch-task-review';
import { uploadProductionLogo as uploadLogo } from '@/lib/client/logo';
import { artworkPngFile, preloadArtworkDraft } from '@/lib/client/render-artwork';
import { cutoutReplacementDraft } from '@/lib/client/artwork-cutout-preview';
import { persistArtworkLayerAssets } from '@/lib/client/artwork-layer-editing';
import { preparePrintedArtwork } from '@/lib/client/prepare-printed-artwork';
import { artworkPrintPlacement } from '@/lib/production-artwork-layout';
import type { LogoStudioInputImage } from '@/lib/logo-studio';
import type { NativeArtworkCandidate } from '@/lib/task-review-artwork';
import { readArtworkResponse, ArtworkResponseError } from '@/lib/client/artwork-response';
import type { ArtworkTiming } from '@/lib/artwork-progress';
import { WpsArtworkProgress } from '@/components/wps-artwork-progress';
import { PLACEMENT_DEFAULTS, PLACEMENT_LABELS } from '@/lib/mockup';
import type { ProductionUnit, WpsProductionState } from '@/lib/wps-production';
import { liveWpsProductionState, orderWpsSourceRecords, pendingWpsAnalysisRecords, wpsSourceEvidence } from '@/lib/wps-source';

type WpsSyncResponse = {
  mode: 'live';
  configured: boolean;
  missingEnvironment: string[];
  records: SourceTaskRecord[];
  reviews: TaskReview[] | null;
  sourceUrl: string;
  syncedAt: string;
  sourceFile: { fileName: string };
  issues: string[];
  totalRecords: number;
};

type PlanForm = Pick<ProductionUnit, 'referenceMaterialIds' | 'sourceScope' | 'textMode' | 'exactText' | 'layoutNote' | 'instruction' | 'route' | 'generationPrompt'> & { materialId: string; ambiguities: string };

function artworkPrompt(unit: ProductionUnit, source: SourceTaskRecord) {
  return standardArtworkPrompts({
    sourceRequirementText: source.requirementText, instruction: unit.instruction, generationPrompt: unit.generationPrompt,
    exactText: unit.textMode === 'replace' ? unit.exactText : '', layoutNote: unit.layoutNote,
    sourceScope: unit.sourceScope, artworkMethod: unit.artworkMethod,
    processingRoute: unit.route === 'deterministic' ? 'fidelity' : unit.route === 'blocked' || unit.route === 'gpt-image-2' ? 'auto' : unit.route,
    printPlacement: artworkPrintPlacement(unit.placement),
    primaryImageLabel: artworkInputSelection(source, unit).primaryImageLabel,
    primaryImageRole: artworkInputSelection(source, unit).primaryImageRole,
    referenceImages: artworkInputSelection(source, unit).referenceMaterialIds.map(id => ({ label: `图${source.materials.findIndex(material => material.id === id) + 1}` })),
  });
}

function artworkPreparationIssue(unit: ProductionUnit, source: SourceTaskRecord) {
  if (isTextOnlyArtwork(unit)) return artworkPlanIssues(source, unit).join('；') || null;
  const primary = artworkInputSelection(source, unit).primary;
  if (!primary || !(primary.url ?? primary.previewUrl)) return isReferenceTextArtwork(unit) ? '样式参考图没有可读取的原图，请核对参考素材。' : '尚未绑定主要内容素材，或原图地址不可用，请核对素材。';
  if (!unit.instruction.trim()) return '请先填写制作要求。';
  if (unit.textMode === 'replace' && !unit.exactText.trim() && productionArtworkRouting(unit, source).facts.intent !== 'generate') return '请先填写要添加或替换的准确文字。';
  if (unit.referenceMaterialIds.length > 15) return '图案处理最多使用 15 张额外参考图，请先修改要求。';
  const routing = productionArtworkRouting({ ...unit, artwork: null }, source);
  if (routing.facts.intent === 'generate' && !unit.generationPrompt?.trim()) return '请先在修改要求中整理生图提示词，再制作图案。';
  if (routing.decision.state === 'review') return routing.facts.blockers.join('；') || routing.decision.reason;
  try { artworkPrompt(unit, source); } catch (error) { return error instanceof Error ? error.message : String(error); }
  return null;
}

function WpsArtworkPreparationDetails({ unit, source, preview }: { unit: ProductionUnit; source: SourceTaskRecord; preview: (url: string, title: string) => void }) {
  const routing = productionArtworkRouting(unit, source);
  const recipe = productionRecipe(unit, source);
  if (isTextOnlyArtwork(unit)) return <details className="wps-inline-records wps-production-details"><summary>查看制作详情</summary><p>准确文字：{unit.exactText}</p><p>{recipe.reason}</p><p>程序排版为透明图案，保存后可继续修改文字、颜色和位置。</p></details>;
  let canonical;
  let promptError;
  try { canonical = artworkPrompt(unit, source); } catch (error) { promptError = error instanceof Error ? error.message : String(error); }
  return <details className="wps-inline-records wps-production-details"><summary>查看制作详情</summary>
    <p>{unit.instruction}</p>
    {unit.textMode === 'replace' && <p>准确文字：{unit.exactText}</p>}
    <div className="wps-production-inputs">{source.materials.filter(material => material.id === unit.materialId || unit.referenceMaterialIds.includes(material.id)).map(material => {
      const url = material.previewUrl ?? material.url;
      const label = `图${source.materials.indexOf(material) + 1} · ${material.id === unit.materialId ? '内容' : '参考'}`;
      return <WpsMaterialImage key={material.id} src={url} alt={material.description} label={label} sizes="64px" open={() => url && preview(url, label)} />;
    })}</div>
    <WpsArtworkRouting unit={unit} source={source}/>
    {canonical ? <details><summary>本路线的提示词与输入映射</summary><small>{canonical.version} / {canonical.hash}</small>
      <pre>{canonical.imageMapping.map(mapping => `${mapping.sourceLabel} → ${mapping.modelInputLabel}：${mapping.role}`).join('\n')}</pre>
      {routing.facts.intent === 'generate' ? <pre>{unit.generationPrompt ? canonical.generate : '请先整理整图生成提示词。'}</pre>
        : routing.decision.method === 'redraw' ? <><p>以下为保真重绘约束；实际调用前会补入原图取色和可辨内容。</p><pre>{canonical.redraw}</pre></>
        : recipe.title === '保真主体＋模型文字' ? canonical.styledTexts.map(text => <pre key={text.text}>{text.prompt}</pre>)
        : <p>本路线先处理原图和准确文字；需要保真增强或符合条件的重绘时，记录实际执行步骤。</p>}
    </details> : <p>{promptError}</p>}
  </details>;
}

async function responseJson(response: Response) {
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body ? String(body.error) : `HTTP ${response.status}`;
    throw Object.assign(new Error(message), { authorizeUrl: body && typeof body === 'object' && 'authorizeUrl' in body ? body.authorizeUrl : null });
  }
  return body;
}

function responseState(body: unknown): WpsProductionState {
  if (!body || typeof body !== 'object') throw new Error('生产接口没有返回状态对象');
  if ('state' in body) return (body as { state: WpsProductionState }).state;
  return body as WpsProductionState;
}

async function modelInputImage(url: string, fileName: string): Promise<LogoStudioInputImage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${fileName} 下载失败：HTTP ${response.status}`);
  const blob = await response.blob();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw new Error(`${fileName} 不是 PNG、JPG 或 WebP`);
  if (blob.size <= 0 || blob.size > 8 * 1024 * 1024) throw new Error(`${fileName} 必须在 1B–8MB，实际 ${blob.size}B`);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${fileName}`));
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(`${fileName} 没有图片内容`));
    reader.readAsDataURL(blob);
  });
  return { fileName, mimeType: blob.type, dataUrl };
}

async function pngFile(dataUrl: string, fileName: string) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (blob.type !== 'image/png') throw new Error(`${fileName} 必须是 PNG，实际为 ${blob.type || '未知类型'}`);
  return new File([blob], fileName, { type: 'image/png' });
}

function formForUnit(unit: ProductionUnit): PlanForm {
  return { materialId: unit.materialId ?? '', referenceMaterialIds: unit.referenceMaterialIds,
    sourceScope: unit.sourceScope, textMode: unit.textMode, exactText: unit.exactText,
    layoutNote: unit.layoutNote, instruction: unit.instruction, generationPrompt: unit.generationPrompt ?? '', route: unit.route,
    ambiguities: unit.ambiguities.join('\n') };
}

export function WpsProductionClient() {
  const session = useProjectSession();
  const { user: catalogUser, initialized: sessionInitialized, refresh: refreshSession } = session;
  const [catalogStyles, setCatalogStyles] = useState<CatalogStyle[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const loadCatalog = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/catalog/production-garments', { cache: 'no-store', signal });
      if (response.status === 401) { setCatalogStyles([]); await refreshSession(); }
      const result = await responseJson(response) as { styles: CatalogStyle[] };
      if (!Array.isArray(result.styles)) throw new Error('素材库没有返回款式列表');
      if (!signal?.aborted) { setCatalogStyles(result.styles); setCatalogError(null); }
    } catch (error) { if (!signal?.aborted) setCatalogError(error instanceof Error ? error.message : String(error)); }
  }, [refreshSession]);
  useEffect(() => {
    if (!catalogUser) { setCatalogStyles([]); setCatalogError(null); return; }
    const abort = new AbortController();
    void loadCatalog(abort.signal);
    return () => abort.abort();
  }, [catalogUser, loadCatalog]);
  const [production, setProduction] = useState<WpsProductionState | null>(null);
  const [operations, setOperations] = useState<ProductionOperation[]>([]);
  const [operationLocks] = useState(() => new ProductionOperationLocks(setOperations));
  const [artworkJobs, setArtworkJobs] = useState<ArtworkQueueJob[]>([]);
  const [artworkQueue] = useState(() => new ArtworkWorkQueue(ARTWORK_CONCURRENCY, setArtworkJobs));

  const [message, setMessage] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('正在读取生产状态…');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncAuthorizeUrl, setSyncAuthorizeUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);
  const [artworkErrors, setArtworkErrors] = useState<Record<string, string>>({});
  const { sessions: cutoutSessions, store: cutoutStore } = useArtworkCutoutSessions(production, Boolean(catalogUser));
  const [cutoutSettings, setCutoutSettings] = useState<Record<string, boolean>>({});
  const [nativeCandidates, setNativeCandidates] = useState<Record<string, NativeArtworkCandidate>>({});
  const [artworkProgress, setArtworkProgress] = useState<Record<string, { preview?: { url: string; label: string }; timings: ArtworkTiming[] }>>({});
  const unsavedArtworks = useRef(new Map<string, Record<string, unknown>>());
  const [syncMode, setSyncMode] = useState<WpsSyncResponse['mode'] | null>(null);
  const [sourceInfo, setSourceInfo] = useState<WpsSyncResponse | null>(null);
  const [selectedStatuses, setSelectedStatuses] = useState<string[] | null>(() => [...DEFAULT_WPS_STATUSES]);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const sourceRecords = useRef<SourceTaskRecord[]>([]);
  const sourceInitialized = useRef(false);
  const syncRequest = useRef<AbortController | null>(null);
  const lastSyncStartedAt = useRef(0);
  const [editingUnitId, setEditingUnitId] = useState<string | null>(null);
  const [planningPrompt, setPlanningPrompt] = useState(false);
  const promptRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { promptRequest.current?.abort(); }, [editingUnitId]);
  const [planForm, setPlanForm] = useState<PlanForm | null>(null);
  const [artworkReviewId, setArtworkReviewId] = useState<string | null>(null);
  const [placingUnitId, setPlacingUnitId] = useState<string | null>(null);
  const [artworkEditor, setArtworkEditor] = useState<{ unit: ProductionUnit; draft: ArtworkDraft } | null>(null);

  const planSnapshot = useRef<Record<string, unknown>>({});
  const placementSnapshot = useRef<Record<string, unknown>>({});
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const inspectionRequest = useRef(0);
  const activeAttemptFor = (unit: ProductionUnit) => [...unit.attempts].reverse().find(attempt => ['submitted', 'processing', 'unknownSubmission'].includes(attempt.status));
  const busy = operations.length > 0 || artworkJobs.length > 0 || unsavedArtworks.current.size > 0 || Boolean(production?.units.some(activeAttemptFor) || production?.mockupVersions.some(version => version.status === 'composing'));

  const operationReason = (input: Record<string, unknown>, options: { ignoreAttempt?: string; ignorePending?: string; ignoreCutout?: string } = {}) => {
    if (!production) return '正在读取生产状态';
    const requested = productionOperation(production, '', input, '');
    const active = [...operationLocks.entries];
    for (const unit of production.units) {
      const job = artworkJobs.find(job => job.id === unit.id);
      const reason = artworkQueue.has(unit.id) ? job?.progress || '正在制作图案'
        : unsavedArtworks.current.has(unit.id) && options.ignorePending !== unit.id ? '图案等待保存，请先重试保存'
        : ['pending', 'unknown'].includes(cutoutSessions[unit.id]?.result.status) && options.ignoreCutout !== unit.id ? '抠图任务已提交，请继续查询本次结果'
        : activeAttemptFor(unit) && options.ignoreAttempt !== unit.id ? '正在制作，请查询进度' : null;
      if (reason) active.push({ key: `artwork:${unit.id}`, unitIds: [unit.id], batch: false, reason: `${unit.variantLabel} · ${unit.placement ? productionPositionLabel(unit.placement) : '图案'}：${reason}` });
    }
    for (const version of production.mockupVersions.filter(version => version.status === 'composing')) active.push({ key: `composing:${version.id}`, unitIds: version.unitIds, batch: false, reason: `${version.variantLabel}正在合成客户图` });
    return active.find(active => productionOperationsOverlap(requested, active))?.reason ?? null;
  };
  const beginOperation = (key: string, input: Record<string, unknown>, reason: string) => {
    if (!production) return null;
    const blocked = operationReason(input, input.action === 'pollGptImage2' ? { ignoreAttempt: String(input.unitId) } : {});
    if (blocked) { setError(blocked); return null; }
    return operationLocks.start(productionOperation(production, key, input, reason));
  };
  const unitBusyReason = (unitId: string) => operationReason({ action: 'confirmArtwork', unitId });
  const versionBusyReason = (versionId: string) => operationReason({ action: 'composeVersion', versionId });

  const acceptProductionState = useCallback((state: WpsProductionState) => {
    setProduction(current => {
      const next = reuseProductionGeometry(newerProductionState(current, state), current);
      if (sourceInitialized.current) return liveWpsProductionState(next, sourceRecords.current);
      if (!next.sourceRecordOrder) return next;
      const byId = new Map(next.records.map(record => [record.source.recordId, record]));
      return { ...next, records: orderWpsSourceRecords(next.sourceRecordOrder, next.records.map(record => record.source)).map(source => byId.get(source.recordId)!) };
    });
  }, []);
  const analysis = useWpsAutomaticAnalysis(production, syncMode === 'live' && Boolean(catalogUser) && catalogUser?.role !== 'viewer', acceptProductionState);

  useEffect(() => {
    if (!artworkJobs.length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [artworkJobs.length]);

  const rememberCutout = (unit: ProductionUnit, result: ArtworkCutoutResult, snapshot: string, purpose: CutoutSession['purpose'] = 'recut') => {
    return cutoutStore.remember(unit.id, result, snapshot, purpose);
  };
  const discardCutout = cutoutStore.discard;

  const cancelSync = useCallback(() => {
    syncRequest.current?.abort();
    syncRequest.current = null;
    setSyncing(false);
  }, []);

  const load = useCallback(async (background = false) => {
    if (syncRequest.current || (background && Date.now() - lastSyncStartedAt.current < 5_000)) return;
    const request = new AbortController();
    syncRequest.current = request;
    lastSyncStartedAt.current = Date.now();
    setSyncing(true);
    const timeout = window.setTimeout(() => request.abort(new DOMException('同步超时', 'TimeoutError')), 60_000);
    try {
      const [sync, stateBody] = await Promise.all([
        fetch('/api/wps-tasks', { cache: 'no-store', signal: request.signal }).then(responseJson) as Promise<WpsSyncResponse>,
        fetch('/api/wps-production', { cache: 'no-store', signal: request.signal }).then(responseJson).then(body => {
          // Saved work can render while WPS is still fetching its live records.
          if (!request.signal.aborted && syncRequest.current === request) acceptProductionState(responseState(body));
          return body;
        }),
      ]);
      if (sync.mode !== 'live' || !Array.isArray(sync.records)) throw new Error('WPS 未返回真实表格记录');
      const state = responseState(stateBody);
      // A user action may have cancelled this read while its response was arriving.
      if (request.signal.aborted || syncRequest.current !== request) return;
      const previousIds = new Set(sourceRecords.current.map((record) => record.recordId));
      const addedCount = previousIds.size ? sync.records.filter((record) => !previousIds.has(record.recordId)).length : 0;
      // The server persists discovery order, including across page reloads.
      sourceRecords.current = sync.records;
      sourceInitialized.current = true;
      setSourceInfo(sync);
      setSyncMode('live');
      setSyncAuthorizeUrl(null);
      acceptProductionState(state);
      setSyncMessage(`${addedCount ? `自动发现 ${addedCount} 条新增任务，匹配当前筛选的新增任务显示在最上方。` : ''}已同步 ${sync.records.length} 条设计中 / 待领取任务、${sync.records.reduce((total, record) => total + record.materials.length, 0)} 张素材；仅检查设计中和待领取任务，空闲时每 30 秒更新。`);
      setSyncError(sync.issues?.length ? sync.issues.join('；') : null);
    } catch (loadError) {
      if (syncRequest.current !== request || (request.signal.aborted && request.signal.reason?.name !== 'TimeoutError')) return;
      setSyncMode(null);
      setSyncMessage('本次同步未成功，可重试同步。');
      setSyncAuthorizeUrl(loadError && typeof loadError === 'object' && 'authorizeUrl' in loadError && typeof loadError.authorizeUrl === 'string' ? loadError.authorizeUrl : null);
      setSyncError(request.signal.reason?.name === 'TimeoutError' ? '同步超过 60 秒，请重试。' : loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      window.clearTimeout(timeout);
      if (syncRequest.current === request) {
        syncRequest.current = null;
        setSyncing(false);
      }
    }
  }, [acceptProductionState]);

  useEffect(() => {
    if (!sessionInitialized || !catalogUser) return;
    void load();
    return () => { syncRequest.current?.abort(); syncRequest.current = null; };
  }, [load, sessionInitialized, catalogUser]);

  const syncPaused = !sessionInitialized || !catalogUser || busy || Boolean(editingUnitId || artworkEditor || artworkReviewId || placingUnitId || preview);
  useEffect(() => {
    if (syncPaused) { cancelSync(); return; }
    const refresh = () => { if (!document.activeElement?.matches('.wps-production-table input, .wps-production-table select, .wps-production-table textarea, .wps-production-table details[open] *') && document.visibilityState === 'visible') void load(true); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [syncPaused, load, cancelSync]);

  const updateStatus = async (record: SourceTaskRecord, status: string) => {
    cancelSync();
    const release = beginOperation(`status:${record.recordId}`, { action: 'status', recordId: record.recordId }, '正在保存 WPS 状态');
    if (!release) return;
    setError(null);
    try {
      const result = await responseJson(await fetch('/api/wps-tasks/status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: record.recordId, status, expectedStatus: record.wpsSource?.status ?? '', expectedEvidence: wpsSourceEvidence(record) }),
      })) as { record: SourceTaskRecord; verifiedAt: string };
      sourceRecords.current = sourceRecords.current.map((source) => source.recordId === result.record.recordId ? result.record : source);
      setProduction((state) => state ? liveWpsProductionState(state, sourceRecords.current) : null);
      setMessage(`已写回 WPS 并回读确认：${record.customerId} → ${result.record.wpsSource?.status}`);
    } catch (statusError) {
      if (statusError && typeof statusError === 'object' && 'authorizeUrl' in statusError && typeof statusError.authorizeUrl === 'string') setAuthorizeUrl(statusError.authorizeUrl);
      setError(statusError instanceof Error ? statusError.message : String(statusError));
    } finally { release(); }
  };

  const statusEditor = (source: SourceTaskRecord) => source.wpsSource?.statusFieldName && source.wpsSource.statusWritable !== false
    ? <form className="wps-task-status" key={`${source.recordId}:${source.wpsSource.status}`} onSubmit={(event) => {
      event.preventDefault();
      void updateStatus(source, String(new FormData(event.currentTarget).get('status') ?? ''));
    }}><label>{source.wpsSource.statusFieldName}{source.wpsSource.statusOptions.length
      ? <select aria-label={`${source.customerId} WPS 状态`} name="status" defaultValue={source.wpsSource.status} required><option value="" disabled>选择状态</option>{source.wpsSource.statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}</select>
      : <input aria-label={`${source.customerId} WPS 状态`} name="status" defaultValue={source.wpsSource.status} maxLength={80} required />}</label><button disabled={Boolean(operationReason({ action: 'status', recordId: source.recordId })) || syncMode !== 'live'} type="submit">更新 WPS 状态</button>{source.wpsSource.statusNote && <small>{source.wpsSource.statusNote}</small>}</form>
    : <small>{source.wpsSource?.status || '未识别状态列'}{source.wpsSource?.statusNote && <><br />{source.wpsSource.statusNote}</>}</small>;

  const runAction = async (key: string, input: Record<string, unknown>, expectedRevision = production?.revision) => {
    if (!production) return null;
    cancelSync();
    const targetUnitId = typeof input.unitId === 'string' ? input.unitId : null;
    if (targetUnitId) setArtworkErrors(current => ({ ...current, [targetUnitId]: '' }));
    const release = beginOperation(key, input, input.action === 'composeVersion' ? '本版本正在合成客户图' : '正在保存本项修改');
    if (!release) return null;
    setError(null);
    try {
      const body = await responseJson(await fetch(input.action === 'selectGarment' ? '/api/catalog/production-garments' : '/api/wps-production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...productionActionSnapshot(production, input), ...input, expectedRevision }),
      }));
      const state = responseState(body);
      acceptProductionState(state);
      const checkedArtwork = input.action === 'checkArtworkQuality' ? state.units.find(unit => unit.id === input.unitId)?.artwork : null;
      setMessage(checkedArtwork ? '画质参考结果已保存，不影响人工确认；请对照原图核对图形、文字和颜色。'
        : input.action === 'composeVersion' ? '已合成同一件衣服的完整客户图，请核对后确认。' : input.action === 'confirmArtwork' ? 'Logo 已确认，下一步放到衣服上。' : '修改已保存。');
      return state;
    } catch (actionError) {
      let reason = actionError instanceof Error ? actionError.message : String(actionError);
      // Failed composition can still persist a failure record and revision.
      // Read that revision before allowing a retry.
      try {
        const state = responseState(await responseJson(await fetch('/api/wps-production', { cache: 'no-store' })));
        acceptProductionState(state);
      } catch (refreshError) { reason += `；状态刷新失败：${refreshError instanceof Error ? refreshError.message : String(refreshError)}`; }
      setError(reason);
      if (targetUnitId) setArtworkErrors(current => ({ ...current, [targetUnitId]: reason }));
      return null;
    } finally {
      release();
    }
  };

  const openArtworkReview = async (unit: ProductionUnit) => {
    if (!unit.artwork) return;
    const request = ++inspectionRequest.current;
    setInspectingId(unit.id); setError(null);
    try {
      const inspection = await responseJson(await fetch(`/api/wps-production/artwork-inspection?unitId=${encodeURIComponent(unit.id)}`, { method: 'POST', cache: 'no-store' })) as { validation: ArtworkValidation };
      if (request !== inspectionRequest.current) return;
      if (inspection.validation.sha256 !== unit.artwork.validation.sha256) throw new Error('图案已更新，请刷新后重新打开');
      setProduction(current => current ? { ...current, units: current.units.map(candidate => candidate.id === unit.id && candidate.artwork?.validation.sha256 === unit.artwork!.validation.sha256 ? { ...candidate, artwork: { ...candidate.artwork, validation: inspection.validation } } : candidate) } : current);
      setArtworkReviewId(unit.id);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { if (request === inspectionRequest.current) setInspectingId(null); }
  };

  const openPlacement = async (unit: ProductionUnit) => {
    if (!catalogUser) { void session.refresh(); return; }
    if (!unit.garment) { setError('请先选择衣服款式和颜色'); return; }
    cancelSync();
    const request = ++inspectionRequest.current;
    setInspectingId(unit.id); setError(null);
    try {
      const version = production?.mockupVersions.find(candidate => candidate.unitIds.includes(unit.id));
      const versionUnits = production?.units.filter(candidate => version?.unitIds.includes(candidate.id)) ?? [unit];
      // Opening only previews the saved snapshot. The save endpoint still verifies
      // every current file/binding and rejects concurrent edits before committing.
      const hasGeometry = versionUnits.every(candidate => {
        try {
          const placement = candidate.placement ?? { key: 'frontCenter' as const, ...PLACEMENT_DEFAULTS.frontCenter, templateVersion: 'catalog-v1' as const, sizeMode: 'standard' as const };
          initialTaskPlacement({ ...candidate, garment: unit.garment, placement }, candidate.artwork?.validation ?? { width: 1, height: 1 });
          return !candidate.artwork || Boolean(candidate.artwork.validation.contentBounds);
        } catch { return false; }
      });
      if (hasGeometry) {
        if (production) placementSnapshot.current = productionActionSnapshot(production, { action: 'savePlacements', updates: [{ unitId: unit.id }] });
        setArtworkReviewId(null); setPlacingUnitId(unit.id);
        return;
      }
      const inspected = await Promise.all(versionUnits.map(async candidate => {
        const inspection = await responseJson(await fetch(`/api/wps-production/artwork-inspection?unitId=${encodeURIComponent(candidate.id)}&sizing=true`, { method: 'POST', cache: 'no-store' })) as { validation: ArtworkValidation | null; garment: ProductionUnit['garment'] };
        if (candidate.artwork && inspection.validation?.sha256 !== candidate.artwork.validation.sha256) throw new Error('图案已变化，请重新打开');
        const placement = candidate.placement ?? { key: 'frontCenter' as const, ...PLACEMENT_DEFAULTS.frontCenter, templateVersion: 'catalog-v1' as const, sizeMode: 'standard' as const };
        initialTaskPlacement({ ...candidate, placement, garment: inspection.garment }, inspection.validation ?? { width: 1, height: 1 });
        return { candidate, inspection };
      }));
      if (request !== inspectionRequest.current) return;
      setProduction(current => current ? { ...current, units: current.units.map(candidate => {
        const match = inspected.find(item => item.candidate.id === candidate.id && item.candidate.updatedAt === candidate.updatedAt);
        if (!match) return candidate;
        return { ...candidate, garment: match.inspection.garment, artwork: candidate.artwork && match.inspection.validation ? { ...candidate.artwork, validation: match.inspection.validation } : candidate.artwork };
      }) } : current);
      if (production) placementSnapshot.current = productionActionSnapshot(production, { action: 'savePlacements', updates: [{ unitId: unit.id }] });
      setArtworkReviewId(null); setPlacingUnitId(unit.id);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { if (request === inspectionRequest.current) setInspectingId(null); }
  };

  const editArtwork = (unit: ProductionUnit) => {
    if (!unit.artwork) return;
    setError(null); setArtworkReviewId(null); setPlacingUnitId(null);
    setArtworkEditor({ unit, draft: unit.artwork.draft ?? createLegacyArtworkDraft(unit.artwork.url) });
  };

  const saveTaskPlacement = async (updates: PlacementUpdate[], confirmWholeVersion: boolean) => {
    if (!placingUnitId) return;
    const positioned = await runAction(`place:${placingUnitId}`, { action: 'savePlacements', ...placementSnapshot.current, updates, confirmWholeVersion, confirmArtworkPlacement: confirmWholeVersion, actor: '当前操作员' });
    if (!positioned) return;
    placementSnapshot.current = productionActionSnapshot(positioned, { action: 'savePlacements', updates });
    if (!confirmWholeVersion) { setPlacingUnitId(null); setMessage('整件位置草稿已保存。图案做齐后，在同一张图中核对并生成客户图。'); return; }
    const version = positioned.mockupVersions.find(version => version.unitIds.includes(placingUnitId));
    if (version?.status === 'readyToCompose') {
      setPlacingUnitId(null);
      const composed = await runAction(`compose:${version.id}`, { action: 'composeVersion', versionId: version.id, ...productionActionSnapshot(positioned, { action: 'composeVersion', versionId: version.id }) }, positioned.revision);
      if (!composed) return;
      const output = composed.mockupVersions.find(candidate => candidate.id === version.id)?.output;
      // The user may already be adjusting another garment by now. Keep the
      // completed image in its row instead of interrupting that work with a modal.
      if (output) setMessage(`${version.garmentLabel} · ${version.variantLabel} 客户图已生成，请点击对应图片查看并确认。`);
    } else {
      setPlacingUnitId(null);
      setMessage(updates.some(update => !positioned.units.find(unit => unit.id === update.unitId)?.gateB)
        ? '位置草稿已保存；图案做齐后，再核对整件效果。'
        : '位置已保存；同一件衣服全部完成后合成客户图。');
    }
  };

  const saveArtworkTextCheck = async (result: BrowserLogoTextVerification) => {
    const unit = production?.units.find(candidate => candidate.id === artworkReviewId);
    if (!unit?.artwork) throw new Error('当前检查的图案已关闭或变化');
    const state = await runAction(`ocr:${unit.id}`, { action: 'saveTextVerification', unitId: unit.id, artworkSha256: unit.artwork.validation.sha256, result });
    if (!state) throw new Error('文字检查结果未保存，请查看错误并重试');
  };

  const checkArtworkQuality = async () => {
    const unit = production?.units.find(candidate => candidate.id === artworkReviewId);
    if (unit) await runAction(`quality:${unit.id}`, { action: 'checkArtworkQuality', unitId: unit.id });
  };

  const planGenerationPrompt = async () => {
    if (!editingUnit || !editingRecord || planningPrompt) return;
    const controller = new AbortController();
    promptRequest.current = controller;
    setPlanningPrompt(true); setError(null);
    try {
      const result = await responseJson(await fetch('/api/wps-production/prompt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ unitId: editingUnit.id, expectedUnitSnapshot: productionArtworkSnapshot(editingUnit, editingRecord.source) }),
      })) as { generationPrompt: string; materialId: string | null; referenceMaterialIds: string[]; ambiguities: string[] };
      if (!controller.signal.aborted) setPlanForm(current => current ? { ...current, generationPrompt: result.generationPrompt,
        materialId: result.materialId ?? '', referenceMaterialIds: result.referenceMaterialIds, ambiguities: result.ambiguities.join('\n') } : current);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (promptRequest.current === controller) { promptRequest.current = null; setPlanningPrompt(false); }
    }
  };

  const savePlan = async () => {
    if (!editingUnitId || !planForm) return;
    if (!planForm.instruction.trim()) { setError('请填写制作要求'); return; }
    if (!planForm.generationPrompt && planForm.textMode === 'replace' && !planForm.exactText.trim()) { setError('请填写要添加或替换的准确文字'); return; }
    if (!editingUnit || !editingRecord) return;
    const planIssues = artworkPlanIssues(editingRecord.source, { ...editingUnit, ...planForm, materialId: planForm.materialId || null });
    if (planIssues.length) { setError(planIssues.join('；')); return; }
    const state = await runAction(`plan:${editingUnitId}`, {
      action: 'updatePlan', ...planSnapshot.current, unitId: editingUnitId,
      patch: {
        materialId: planForm.materialId || null, referenceMaterialIds: planForm.referenceMaterialIds,
        sourceScope: planForm.sourceScope, textMode: planForm.textMode, exactText: planForm.exactText,
        layoutNote: planForm.layoutNote, instruction: planForm.instruction, generationPrompt: planForm.generationPrompt ?? '',
        routeEvidence: '人工修正制作要求',
        ...(planForm.route === 'blocked' ? { artworkMethod: 'auto' } : {}),
        ambiguities: planForm.ambiguities.split('\n').map(value => value.trim()).filter(Boolean),
      },
    });
    if (state) { setEditingUnitId(null); setPlanForm(null); }
  };

  const reflowArtwork = async (unit: ProductionUnit) => {
    if (!production || !unit.artwork?.draft) return;
    const release = beginOperation(`reflow:${unit.id}`, { action: 'submitArtwork', unitId: unit.id }, '本图正在重新排版并保存');
    if (!release) return;
    setError(null);
    setMessage('正在复用已有 Logo，自动安排图文字高和印花尺寸…');
    try {
      if (unit.artwork.recipeFingerprint !== unit.recipeFingerprint) throw new Error('制作要求已改变，请重新识别原图');
      const layout = await preparePrintedArtwork(unit.artwork.draft, unit);
      if (layout.needsReview) throw new Error(layout.summary);
      const uploaded = await uploadLogo(await artworkPngFile(layout.draft, `${unit.id}-auto-layout.png`));
      const state = responseState(await responseJson(await fetch('/api/wps-production', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submitArtwork', ...productionActionSnapshot(production, { action: 'submitArtwork', unitId: unit.id }), expectedRevision: production.revision,
          unitId: unit.id, url: uploaded.url, name: uploaded.originalName, draft: layout.draft,
          automaticWidthCm: layout.automaticWidthCm, service: 'manual-upload',
          requestSummary: `自动重新排版；${layout.summary} 复用已有 Logo 图形，未调用模型或增强服务。`, actualCostCny: 0 }),
      })));
      acceptProductionState(state);
      setArtworkReviewId(null);
      setMessage(`${layout.summary} 新图案已保存。`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setMessage('本次自动排版未保存，页面保留上一次图案。');
    } finally { release(); }
  };

  const saveQueuedArtwork = async (unitId: string, payload: Record<string, unknown>) => {
    const state = responseState(await responseJson(await fetch('/api/wps-production', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })));
    unsavedArtworks.current.delete(unitId);
    cutoutStore.reconcile(state);
    return state;
  };

  const retryArtworkSave = async (unit: ProductionUnit) => {
    const payload = unsavedArtworks.current.get(unit.id);
    if (!payload || operationReason({ action: 'submitArtwork', unitId: unit.id }, { ignorePending: unit.id })) return;
    setArtworkErrors(current => ({ ...current, [unit.id]: '' }));
    try {
      await artworkQueue.run(unit.id, async (progress, finishGeneration) => {
        progress('正在保存已生成的图案…');
        finishGeneration();
        // Recover an uncertain response by reading first; never regenerate or blindly resubmit.
        const current = responseState(await responseJson(await fetch('/api/wps-production', { cache: 'no-store' })));
        if (current.units.find(candidate => candidate.id === unit.id)?.artwork?.url === payload.url) {
          unsavedArtworks.current.delete(unit.id);
          cutoutStore.reconcile(current);
          acceptProductionState(current);
        } else acceptProductionState(await saveQueuedArtwork(unit.id, payload));
        // Reconciliation also handles a save whose response was lost, using its receipts.
        if (String(payload.requestSummary).startsWith('仅重新抠图')) discardCutout(unit.id);
        setArtworkProgress(current => ({ ...current, [unit.id]: { timings: current[unit.id]?.timings ?? [] } }));
      });
    } catch (error) {
      if (!(error instanceof ArtworkQueueCancelledError)) setArtworkErrors(current => ({ ...current, [unit.id]: `保存未完成：${error instanceof Error ? error.message : String(error)}` }));
    }
  };

  const produceArtwork = async (unit: ProductionUnit) => {
    if (isTextOnlyArtwork(unit) && (unit.route !== 'deterministic' || unit.generationPrompt || artworkBlockingAmbiguities(unit.ambiguities).length)) {
      const state = await runAction(`textPlan:${unit.id}`, { action: 'updatePlan', unitId: unit.id,
        patch: { textMode: 'replace', exactText: unit.exactText, generationPrompt: '', route: 'deterministic' } });
      if (!state) return;
      unit = state.units.find(candidate => candidate.id === unit.id)!;
    }
    if (!production || unitBusyReason(unit.id)) return;
    cancelSync();
    const record = production.records.find((candidate) => candidate.source.recordId === unit.sourceRecordId);
    const selection = record ? artworkInputSelection(record.source, unit) : null;
    const primary = selection?.primary;
    const primaryUrl = primary?.url ?? primary?.previewUrl;
    const textOnly = isTextOnlyArtwork(unit);
    if (!record || (!textOnly && (!primary || !primaryUrl))) {
      setArtworkErrors(current => ({ ...current, [unit.id]: '缺少可读取的主要素材，请先修改要求。' }));
      return;
    }
    const preparationIssue = artworkPreparationIssue(unit, record.source);
    if (preparationIssue) { setArtworkErrors(current => ({ ...current, [unit.id]: preparationIssue })); return; }
    if (unit.attempts.some(attempt => ['submitted', 'processing', 'unknownSubmission'].includes(attempt.status))) return;
    const expectedUnitSnapshot = productionArtworkSnapshot(unit, record.source);
    const processingRoute = artworkProcessingRoute(unit);
    const started = performance.now();
    setArtworkProgress(current => ({ ...current, [unit.id]: { timings: [] } }));
    const recordTiming = (timing: ArtworkTiming) => setArtworkProgress(current => ({ ...current,
      [unit.id]: { ...current[unit.id], timings: [...(current[unit.id]?.timings ?? []), timing] } }));
    const timed = async <T,>(stage: string, task: () => Promise<T>): Promise<T> => {
      const beginning = performance.now();
      let status: ArtworkTiming['status'] = 'failed';
      try { const value = await task(); status = 'completed'; return value; }
      finally { recordTiming({ stage, startMs: Math.round(beginning - started), durationMs: Math.round(performance.now() - beginning), status }); }
    };
    setArtworkErrors(current => ({ ...current, [unit.id]: '' }));
    setError(null);
    try {
      await artworkQueue.run(unit.id, async (progress, finishGeneration) => {
        recordTiming({ stage: 'clientQueue', startMs: 0, durationMs: Math.round(performance.now() - started), status: 'completed' });
        const latest = await timed('snapshotCheck', async () => responseState(await responseJson(await fetch('/api/wps-production', { cache: 'no-store' }))));
        assertProductionArtworkSnapshot(latest, unit.id, expectedUnitSnapshot);
        if (textOnly) {
          progress('正在排版文字…');
          const color = requestedProductionTextColor(unit) ?? await productionTextColor(unit);
          const initial = await createProductionTextDraft(unit, color);
          const draft = await persistArtworkLayerAssets(initial, uploadLogo);
          const flattened = await uploadLogo(await artworkPngFile(draft, `${unit.id}-text.png`));
          finishGeneration();
          const payload = { action: 'submitArtwork', operationId: crypto.randomUUID(), expectedRevision: latest.revision,
            expectedUnitSnapshot, unitId: unit.id, url: flattened.url, name: flattened.originalName,
            service: 'deterministic', draft, inputImageUrls: [], estimatedCostCny: 0,
            requestSummary: `程序文字排版：${unit.exactText}；抖音美好体；字色 ${color}。` };
          unsavedArtworks.current.set(unit.id, payload);
          acceptProductionState(await saveQueuedArtwork(unit.id, payload));
          setArtworkProgress(current => ({ ...current, [unit.id]: { timings: current[unit.id]?.timings ?? [] } }));
          setMessage(`${unit.garmentLabel}：文字已保存，客户效果图预览将在后台更新。`);
          return;
        }
        const primaryIndex = record.source.materials.findIndex((material) => material.id === primary!.id);
        const references = selection!.referenceMaterialIds.map((materialId) => {
          const material = record.source.materials.find((candidate) => candidate.id === materialId);
          if (!material) throw new Error(`${unit.id} 引用了不存在的参考素材 ${materialId}`);
          return material;
        });
        if (references.length > 15) throw new Error(`图案处理最多使用 15 张额外参考图，实际 ${references.length} 张`);
        const canonicalPrompt = artworkPrompt(unit, record.source);
        const [image, referenceImages] = await timed('inputImages', () => Promise.all([
          modelInputImage(primaryUrl!, primary!.name || `图${primaryIndex + 1}.png`),
          Promise.all(references.map(async (material) => {
          const index = record.source.materials.findIndex((candidate) => candidate.id === material.id);
          const url = material.url ?? material.previewUrl;
          if (!url) throw new Error(`${material.name} 没有可读取的原图`);
          return { label: `图${index + 1}`, image: await modelInputImage(url, material.name) };
          })),
        ]));
        progress('正在制作图案，请稍候…');
        const requestStarted = performance.now();
        const artworkResponse = await fetch('/api/wps-production/artwork', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
          body: JSON.stringify({
            sourceRequirementText: record.source.requirementText,
            printPlacement: artworkPrintPlacement(unit.placement),
            instruction: unit.instruction, generationPrompt: unit.generationPrompt,
            exactText: unit.textMode === 'replace' ? unit.exactText : '',
            layoutNote: unit.layoutNote,
            image,
            primaryImageLabel: `图${primaryIndex + 1}`,
            primaryImageRole: selection!.primaryImageRole,
            referenceImages,
            artworkMethod: unit.artworkMethod,
            cutoutMode: unit.cutoutMode ?? 'auto',
            enhancementMode: 'auto',
            sourceScope: unit.sourceScope,
            processingRoute: processingRoute === 'deterministic' ? 'fidelity' : processingRoute,
            expectedPromptVersion: canonicalPrompt.version,
            expectedPromptHash: canonicalPrompt.hash,
          }),
        });
        const result = await readArtworkResponse(artworkResponse, event => {
          if (event.type === 'progress') { progress(event.message); if (event.generationFinished) finishGeneration(); }
          if (event.type === 'preview') setArtworkProgress(current => ({ ...current, [unit.id]: { ...current[unit.id], preview: event } }));
          if (event.type === 'timing') recordTiming({ ...event.timing, startMs: event.timing.startMs + Math.round(requestStarted - started) });
        }).catch(error => {
          if (!(error instanceof ArtworkResponseError)) throw error;
          const rejected = error.failure;
          const cutout = rejected.cutout ?? rejected.candidate?.cutout;
          if (cutout) rememberCutout(unit, cutout, expectedUnitSnapshot, rejected.candidate && !rejected.candidate.requiresEditVerification ? 'generated' : 'component');
          if (rejected.candidate) setNativeCandidates(current => ({ ...current, [unit.id]: rejected.candidate! }));
          throw error;
        });
        finishGeneration();
        setNativeCandidates(current => { const next = { ...current }; delete next[unit.id]; return next; });
        progress(result.preprocessing.modelLayoutPreserved ? '正在保存完整图案…' : '正在排版并保存图案…');
        setArtworkProgress(current => ({ ...current, [unit.id]: { ...current[unit.id], preview: { url: result.draft.graphic.sourceUrl, label: '处理结果预览 · 正在保存，尚未替换当前图案' } } }));
        const uploadedGraphics = await timed('layerUploads', () => Promise.all(artworkGraphicLayers(result.draft).map(async (graphic, index) => {
          const upload = async (url: string, name: string) => productionFileId(url) ? { url } : uploadLogo(await pngFile(url, name));
          const [preparedGraphic, mask] = await Promise.all([
            upload(graphic.sourceUrl, `${unit.id}-graphic-${index + 1}.png`),
            graphic.recolorMaskUrl ? upload(graphic.recolorMaskUrl, `${unit.id}-mask-${index + 1}.png`) : null,
          ]);
          return { ...graphic, sourceUrl: preparedGraphic.url, recolorMaskUrl: mask?.url ?? null } satisfies ArtworkGraphicLayer;
        })));
        let initialDraft: ArtworkDraft = { ...result.draft, graphic: uploadedGraphics[0], extraGraphics: uploadedGraphics.slice(1) };
        if (initialDraft.text && !requestedProductionTextColor(unit)) {
          const color = await productionTextColor(unit);
          initialDraft = { ...initialDraft, text: { ...initialDraft.text, color }, extraTexts: initialDraft.extraTexts?.map(text => ({ ...text, color })) };
        }
        const layout = result.preprocessing.modelLayoutPreserved
          ? { draft: initialDraft, automaticWidthCm: undefined, summary: '保留模型字体与排版；抠图后的透明图案按位置标准确定印花尺寸。' }
          : await timed('layout', () => preparePrintedArtwork(initialDraft, unit));
        const draft = layout.draft;
        const flattened = result.preprocessing.modelLayoutPreserved
          ? { url: uploadedGraphics[0].sourceUrl, originalName: `${unit.id}-model-artwork.png` }
          : await timed('flattenedUpload', async () => uploadLogo(await artworkPngFile(draft, `${unit.id}-artwork.png`)));
        const payload = {
            action: 'submitArtwork',
            operationId: crypto.randomUUID(),
            expectedRevision: latest.revision,
            expectedUnitSnapshot,
            unitId: unit.id,
            url: flattened.url,
            name: flattened.originalName,
            automaticWidthCm: layout.automaticWidthCm,
            service: processingRoute,
            draft,
            prompt: result.preprocessing.resolvedPrompt,
            promptHash: result.preprocessing.promptHash,
            inputImageUrls: [primaryUrl, ...references.map(material => (material.url ?? material.previewUrl)!)],
            requestSummary: `${layout.summary} 图案制作：${result.preprocessing.route.label}；${result.preprocessing.decisionRule}${result.preprocessing.generationModel ? `；模型：${result.preprocessing.generationModel}` : ''}`,
            estimatedCostCny: 0,
          };
        unsavedArtworks.current.set(unit.id, payload);
        const state = await timed('save', () => saveQueuedArtwork(unit.id, payload));
        acceptProductionState(state);
        setArtworkProgress(current => ({ ...current, [unit.id]: { timings: current[unit.id]?.timings ?? [] } }));
        setMessage(`${unit.garmentLabel} · ${unit.placement ? productionPositionLabel(unit.placement) : '待定位置'}：图案已保存，请在当前行核对；客户效果图预览将在后台更新。`);
      });
    } catch (productionError) {
      if (productionError instanceof ArtworkQueueCancelledError) return;
      const reason = productionError instanceof Error ? productionError.message : String(productionError);
      const pendingSave = unsavedArtworks.current.get(unit.id);
      setArtworkErrors(current => ({ ...current, [unit.id]: `${pendingSave ? '图案已生成，保存未完成：' : ''}${reason}` }));
      // A failed response may follow a persisted state change. Refresh before
      // another manual attempt instead of resubmitting against an old revision.
      try {
        const state = responseState(await responseJson(await fetch('/api/wps-production', { cache: 'no-store' })));
        acceptProductionState(state);
        if (pendingSave && state.units.find(candidate => candidate.id === unit.id)?.artwork?.url === pendingSave.url) {
          unsavedArtworks.current.delete(unit.id);
          setArtworkErrors(current => ({ ...current, [unit.id]: '' }));
          setArtworkProgress(current => ({ ...current, [unit.id]: { timings: current[unit.id]?.timings ?? [] } }));
        }
      } catch { setError('生产状态刷新失败，请同步后再试。'); }
    }
  };

  const runCutout = async (unit: ProductionUnit, mode: ArtworkCutoutMode, queryOnly = false) => {
    if (!production || artworkQueue.has(unit.id) || operationReason({ action: 'submitArtwork', unitId: unit.id }, { ignoreCutout: unit.id })) return;
    const source = production.records.find(record => record.source.recordId === unit.sourceRecordId)?.source;
    if (!source) return;
    const previous = cutoutSessions[unit.id];
    const snapshot = previous?.snapshot ?? productionArtworkSnapshot(unit, source);
    setArtworkErrors(current => ({ ...current, [unit.id]: '' }));
    try {
      await artworkQueue.run(unit.id, async progress => {
        progress(queryOnly ? '正在查询本次抠图…' : '正在处理背景，当前版本继续保留…');
        let result: ArtworkCutoutResult;
        if (queryOnly || previous?.result.status === 'pending' || previous?.result.status === 'unknown') {
          if (!previous) throw new Error('缺少抠图任务');
          result = await cutoutRequest({ action: 'query', jobKey: previous.result.receipt.jobKey });
        } else {
          const latest = responseState(await responseJson(await fetch('/api/wps-production', { cache: 'no-store' })));
          assertProductionArtworkSnapshot(latest, unit.id, snapshot);
          const primary = source.materials.find(material => material.id === unit.materialId);
          if (unit.artwork?.draft?.preprocessing.generationModel && !unit.artwork.draft.preprocessing.cutout?.sourceUrl && !previous) throw new Error('历史生成图案未保留抠图前原图，暂不能仅重新抠图。请上传该图案的原始文件。');
          const imageUrl = previous?.result.receipt.sourceUrl ?? unit.artwork?.draft?.preprocessing.cutout?.sourceUrl ?? nativeCandidates[unit.id]?.url ?? primary?.url ?? primary?.previewUrl;
          if (!imageUrl) throw new Error('未保留抠图前原图，请重新选择原始素材');
          const image = await cutoutInputDataUrl(imageUrl);
          result = await cutoutRequest({ action: 'process', mode, image, retryOf: previous?.result.status === 'failed' && previous.result.receipt.mode === mode ? previous.result.receipt.jobKey : undefined });
        }
        rememberCutout(unit, result, snapshot, previous?.purpose);
        const deadline = Date.now() + 45000;
        while (result.status === 'pending' && Date.now() < deadline) {
          progress('正在处理抠图，继续查询同一任务…');
          await new Promise(resolve => setTimeout(resolve, 1800));
          result = await cutoutRequest({ action: 'query', jobKey: result.receipt.jobKey });
          rememberCutout(unit, result, snapshot, previous?.purpose);
        }
        if (result.status === 'completed') {
          const active = cutoutStore.getSnapshot()[unit.id];
          if (!active) setMessage('这次抠图已用于当前图案，无需重复选用。');
          else if (active.purpose === 'component' || active.stale) {
            if (result.url) setPreview({ url: result.url, title: '上次制作的抠图素材' });
            setMessage('已取得同一次抠图结果，可下载后在图层编辑器中继续制作。');
          } else {
            if (unit.artwork) setArtworkReviewId(unit.id);
            setMessage(unit.artwork ? '重新抠图已完成，选用后才更新当前图案。' : '抠图已完成，保存后成为当前图案。');
          }
        }
      });
    } catch (error) { setArtworkErrors(current => ({ ...current, [unit.id]: error instanceof Error ? error.message : String(error) })); }
  };
  const applyCutout = async (unit: ProductionUnit) => {
    const session = cutoutSessions[unit.id];
    if (!production || session?.result.status !== 'completed' || !session.result.url || session.purpose === 'component' || session.stale) return;
    const resultUrl = session.result.url;
    const release = beginOperation(`applyCutout:${unit.id}`, { action: 'submitArtwork', unitId: unit.id }, '正在选用新抠图结果');
    if (!release) return;
    setError(null);
    try {
      const latest = responseState(await responseJson(await fetch('/api/wps-production', { cache: 'no-store' })));
      assertProductionArtworkSnapshot(latest, unit.id, session.snapshot);
      const result = session.result;
      const currentDraft = session.purpose === 'generated' ? undefined : unit.artwork?.draft;
      const replacement = currentDraft ? await cutoutReplacementDraft(currentDraft, result) : undefined;
      const aligned = { url: replacement?.graphic.sourceUrl ?? resultUrl };
      const uploaded = productionFileId(aligned.url) ? { url: aligned.url } : await uploadLogo(await pngFile(aligned.url, `${unit.id}-cutout.png`));
      let draft = replacement ?? createLegacyArtworkDraft(uploaded.url);
      draft.graphic = { ...draft.graphic, sourceUrl: uploaded.url };
      if (!currentDraft) {
        const bitmap = await createImageBitmap(await (await fetch(uploaded.url)).blob());
        const scale = Math.min(760 / bitmap.width, 760 / bitmap.height);
        draft.graphic.width = Math.round(bitmap.width * scale); draft.graphic.height = Math.round(bitmap.height * scale); bitmap.close();
      }
      draft.preprocessing = { ...draft.preprocessing, cutout: result.receipt };
      draft = await persistArtworkLayerAssets(draft, uploadLogo);
      const flattened = draft.mode === 'legacyFlattened' && !currentDraft ? { url: uploaded.url, originalName: `${unit.id}-cutout.png` }
        : await uploadLogo(await artworkPngFile(draft, `${unit.id}-artwork.png`));
      const payload = { action: 'submitArtwork', operationId: crypto.randomUUID(), expectedRevision: latest.revision, expectedUnitSnapshot: session.snapshot,
        unitId: unit.id, url: flattened.url, name: flattened.originalName, draft, service: unit.route === 'blocked' ? 'manual-upload' : unit.route,
        providerTaskId: result.receipt.taskId, requestSummary: `仅重新抠图：${CUTOUT_ROUTE_LABELS[result.receipt.route]}；${cutoutFeeLabel(result.receipt)}；选用后重新核对整件效果`, estimatedCostCny: 0 };
      unsavedArtworks.current.set(unit.id, payload);
      const state = await saveQueuedArtwork(unit.id, payload);
      acceptProductionState(state); discardCutout(unit.id); setArtworkReviewId(null);
      setNativeCandidates(current => { const next = { ...current }; delete next[unit.id]; return next; });
      setMessage('已选用新抠图结果，整件效果需要重新核对。');
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { release(); }
  };

  const editorSaveOperation = useRef<{ input: string; id: string } | null>(null);
  const saveArtworkDraft = async (draft: ArtworkDraft) => {
    if (!artworkEditor || !production) return;
    const unit = artworkEditor.unit;
    const release = beginOperation(`editArtwork:${unit.id}`, { action: 'saveArtworkDraft', unitId: unit.id }, '本图正在保存图层与 PNG');
    if (!release) throw new Error('本图正在处理，请稍后保存');
    setError(null);
    try {
      const currentUnit = production.units.find(candidate => candidate.id === unit.id);
      if (!currentUnit || currentUnit.recipeFingerprint !== unit.recipeFingerprint) throw new Error('图案要求已变化，请关闭编辑器后重新处理');
      if (unit.artwork?.draft && JSON.stringify(draft) === JSON.stringify(unit.artwork.draft)) {
        setArtworkEditor(null); setMessage('没有修改，已保留现有图层与 PNG。'); return;
      }
      const samePixels = unit.artwork?.draft && artworkPixelFingerprint(draft) === artworkPixelFingerprint(unit.artwork.draft);
      draft = await persistArtworkLayerAssets(draft, uploadLogo);
      const uploaded = samePixels ? { url: unit.artwork!.url, originalName: unit.artwork!.name } : await uploadLogo(await artworkPngFile(draft, `${unit.id}-artwork.png`));
      const source = production.records.find(record => record.source.recordId === unit.sourceRecordId)!.source;
      const operationInput = JSON.stringify({ id: unit.id, openedAt: unit.updatedAt, url: uploaded.url, draft });
      if (editorSaveOperation.current?.input !== operationInput) editorSaveOperation.current = { input: operationInput, id: crypto.randomUUID() };
      const state = responseState(await responseJson(await fetch('/api/wps-production', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'saveArtworkDraft', operationId: editorSaveOperation.current.id, expectedRevision: production.revision, expectedUnitSnapshot: productionArtworkSnapshot(unit, source),
          unitId: unit.id, url: uploaded.url, name: uploaded.originalName, draft,
          service: 'manual-upload', requestSummary: '人工调整图案文字和排版；未调用模型', actualCostCny: 0 }),
      })));
      acceptProductionState(state);
      setArtworkEditor(null);
      setArtworkReviewId(null);
      setMessage('图层与 PNG 已保存，效果图预览正在更新。');
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); throw error; }
    finally { release(); }
  };

  const uploadArtwork = async (unit: ProductionUnit, file: File) => {
    if (!production) return;
    const release = beginOperation(`upload:${unit.id}`, { action: 'submitArtwork', unitId: unit.id }, '本图正在上传并保存');
    if (!release) return;
    setError(null);
    try {
      const uploaded = await uploadLogo(file);
      const body = await responseJson(await fetch('/api/wps-production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submitArtwork',
          ...productionActionSnapshot(production, { action: 'submitArtwork', unitId: unit.id }),
          expectedRevision: production.revision,
          unitId: unit.id,
          url: uploaded.url,
          name: uploaded.originalName,
          service: 'manual-upload',
          requestSummary: '人工上传完整透明 PNG',
          estimatedCostCny: 0,
        }),
      }));
      const state = responseState(body);
      acceptProductionState(state);
      const updatedUnit = state.units.find((candidate) => candidate.id === unit.id);
      setArtworkReviewId(null);
      setMessage(updatedUnit?.artwork
        ? `${unit.garmentLabel} · ${unit.placement ? productionPositionLabel(unit.placement) : '待定位置'} 已通过透明 PNG 自动检查。`
        : `${unit.garmentLabel} 的文件未通过透明 PNG 自动检查，请查看失败原因。`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      release();
    }
  };

  const versionByUnit = useMemo(() => new Map(
    production?.mockupVersions.flatMap((version) => version.unitIds.map((unitId) => [unitId, version] as const)) ?? [],
  ), [production]);
  const statusCounts = useMemo(() => {
    const counts = new Map(['🔵待完善', '🔴待领取', '🟢设计中', '✔已完成', '⚫已取消'].map((status) => [status, 0]));
    for (const record of production?.records ?? []) {
      const status = record.source.wpsSource?.status || '未识别状态';
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return counts;
  }, [production]);
  const filteredRecords = production?.records.filter((record) => selectedStatuses === null || selectedStatuses.includes(record.source.wpsSource?.status || '未识别状态')) ?? [];
  const pendingAnalysisCount = pendingWpsAnalysisRecords(production?.records ?? []).length;
  const actualCost = production?.units.reduce((sum, unit) => sum + unit.attempts.reduce((inner, attempt) => inner + (attempt.actualCostCny ?? 0), 0), 0) ?? 0;
  const approvedVersions = production?.mockupVersions.filter((version) => version.status === 'approved').length ?? 0;
  const pendingUnits = production?.units.filter((unit) => unit.status !== 'artworkApproved').length ?? 0;
  const editingUnit = editingUnitId ? production?.units.find((unit) => unit.id === editingUnitId) ?? null : null;
  const editingRecord = editingUnit ? production?.records.find((record) => record.source.recordId === editingUnit.sourceRecordId) ?? null : null;
  const previewVersion = preview ? production?.mockupVersions.find(version => version.output?.url === preview.url && version.output.compositorVersion === WPS_COMPOSITOR_VERSION) : null;

  return (
    <div className="app-shell wps-production-shell">
      <AppHeader />
      <main className="wps-production-page">
        <header className="wps-production-heading">
          <div><span>WPS BATCH PRODUCTION</span><h1>效果图生产总表</h1><p>方案与位置、完整透明素材、正反面合成和客户确认，全部围绕同一个版本推进。</p></div>
          <div>{analysis.errors.length > 0 && <button className="button secondary" disabled={analysis.running || !analysis.enabled} onClick={() => analysis.retryFailed()} type="button">重试解析失败的任务（{analysis.errors.length}）</button>}<button className="button secondary" disabled={syncPaused || syncing} onClick={() => void load()} type="button">{syncing ? '正在同步 WPS…' : '同步 WPS 状态与素材'}</button>{approvedVersions > 0 && <a className="button primary" href="/api/wps-production/export">导出已确认 ZIP</a>}</div>
        </header>

        <p className="wps-production-queue" role="status" aria-live="polite">需求解析：最多同时 {WPS_ANALYSIS_CONCURRENCY} 条订单。图案制作：同时生图最多 {ARTWORK_CONCURRENCY} 张 · 制作中 {artworkJobs.filter(job => job.status === 'running').length} 张 · 后处理与保存 {artworkJobs.filter(job => job.status === 'finishing').length} 张 · 排队 {artworkJobs.filter(job => job.status === 'queued').length} 张{artworkJobs.length > 0 ? '。其他图案可继续确认、编辑或加入制作队列，请保持页面打开。' : '。点击各行“制作图案”即可加入队列。'}</p>

        <section className="wps-production-stats">
          <div><span>WPS 记录</span><strong>{production?.records.length ?? 0}</strong></div>
          <div><span>印花位置总数</span><strong>{production?.units.length ?? 0}</strong></div>
          <div><span>未完成的位置</span><strong>{pendingUnits}</strong></div>
          <div><span>已确认客户图</span><strong>{approvedVersions}</strong></div>
          <div><span>已记录费用 / 上限</span><strong>¥{actualCost.toFixed(2)} / ¥{(production?.budgetLimitCny ?? 0).toFixed(2)}</strong></div>
        </section>

        <p className="wps-production-message" aria-live="polite">{syncing ? sourceInfo ? '正在后台同步 WPS，可继续操作。' : '正在同步设计中和待领取任务；已显示的制作记录为上次保存内容…' : syncMessage}{sourceInfo && <> · <a href={sourceInfo.sourceUrl} target="_blank" rel="noreferrer">{sourceInfo.sourceFile.fileName}</a> · 最近同步 {new Date(sourceInfo.syncedAt).toLocaleTimeString('zh-CN')}</>}{!syncMode && sourceInfo ? ' · 连接异常，显示上次同步数据' : ''}</p>
        {message && <p className="wps-production-message" role="status">{message}</p>}
        {!sessionInitialized ? <p className="wps-sync-note">正在读取衣服款式…</p> : !catalogUser ? <div className="error-banner"><span>工作台暂时无法读取，请重试连接。</span><button type="button" onClick={() => void session.refresh()}>重新连接</button></div> : catalogError && <div className="error-banner" role="alert"><span>商品素材库：{catalogError}</span><button type="button" onClick={() => void loadCatalog()}>重新读取款式</button></div>}
        {syncError && <div className="error-banner" role="alert"><span>WPS 同步：{syncError}</span>{syncAuthorizeUrl && <a className="button primary" href={syncAuthorizeUrl}>连接 WPS</a>}<button disabled={syncPaused || syncing} onClick={() => void load()} type="button">重试同步</button></div>}
        {error && <div className="error-banner" role="alert"><span>{error}</span>{authorizeUrl && <a className="button primary" href={authorizeUrl}>连接 WPS</a>}<button onClick={() => setError(null)} type="button">关闭</button></div>}

        {!!production?.records.length && <div className="wps-production-filters">
          <strong>WPS 任务状态</strong>
          <WpsStatusFilter counts={statusCounts} selected={selectedStatuses} change={setSelectedStatuses} />
          <span role="status">显示 {filteredRecords.length} / {production.records.length} 条任务</span>
          {selectedStatuses !== null && <button type="button" onClick={() => setSelectedStatuses(null)}>查看全部</button>}
        </div>}

        <p className="wps-production-message" aria-live="polite">{analysis.running ? `正在自动解析需求：${analysis.completed}/${analysis.total}` : !analysis.enabled ? '自动解析暂未启动' : `新任务自动解析已开启${pendingAnalysisCount > analysis.errors.length ? ` · ${pendingAnalysisCount - analysis.errors.length} 条等待解析` : ''}${analysis.errors.length ? ` · ${analysis.errors.length} 条失败，请在对应行重试` : ''}`}</p>
        {analysis.errors.length > 0 && <p className="wps-production-row-error" role="alert">{analysis.errors.join('；')}</p>}
        {!production?.records.length ? <section className="wps-production-empty"><strong>{syncMode ? '当前没有设计中或待领取的 WPS 任务' : '等待连接真实 WPS 表'}</strong><p>仅同步设计中和待领取任务的原文、素材图与状态。</p>{!syncMode && <a className="button secondary" href="/wps-connect">查看原表接入步骤</a>}<button className="button primary" disabled={syncPaused || syncing} onClick={() => void load()} type="button">{syncing ? '正在同步 WPS…' : '同步 WPS'}</button></section> : !filteredRecords.length ? <section className="wps-production-empty"><strong>{selectedStatuses?.length === 0 ? '尚未选择任务状态' : `当前没有“${selectedStatuses?.join('、')}”任务`}</strong><p>{selectedStatuses?.length === 0 ? '可以同时勾选多个状态，也可以恢复为设计中和待领取。' : '自动同步后，符合任一所选状态的任务会出现在这里。'}</p><button className="button secondary" onClick={() => setSelectedStatuses([...DEFAULT_WPS_STATUSES])} type="button">恢复默认筛选</button><button className="button secondary" onClick={() => setSelectedStatuses(null)} type="button">查看全部任务</button></section> : <div className="wps-production-table-wrap" onPointerDownCapture={cancelSync} onFocusCapture={cancelSync}>
          <table className="wps-production-table">
            <thead><tr><th scope="col">客户需求与原始素材</th><th scope="col">服装方案与位置</th><th scope="col">AI理解需求</th><th scope="col">图案制作</th><th scope="col">客户效果图</th></tr></thead>
            {filteredRecords.map((record) => {
              const units = record.unitIds.flatMap((unitId) => {
                const unit = production.units.find((candidate) => candidate.id === unitId);
                return unit ? [unit] : [];
              });
              const repeatedSummary = units.map(candidate => `${candidate.garmentLabel} · ${candidate.placement ? PLACEMENT_LABELS[candidate.placement.key] : '位置待确认'}：${candidate.instruction}`).join('；');
              if (!units.length) return <tbody key={record.source.recordId}><tr><td className="wps-production-source">
                <small className="wps-technical-id">{record.source.recordId} · {record.source.revision}</small><strong>{record.source.customerId}</strong><p>{record.source.requirementText}</p><small>商品款式：{record.source.productStyleText}</small>
                <div>{record.source.materials.map((material, index) => <WpsMaterialImage key={material.id} src={material.previewUrl ?? material.url} alt={material.description} label={`图${index + 1}`} sizes="68px" open={() => material.url && setPreview({ url: material.url, title: material.description })} />)}</div>
                {statusEditor(record.source)}
              </td><td/><td className="wps-requirement-cell"><WpsAnalysisStatusNotice source={record.source} status={analysis.statuses[record.source.recordId]} enabled={analysis.enabled} retry={() => analysis.retryFailed(record.source)} /></td><td/><td/></tr></tbody>;
              const groups = [...new Set(units.map(unit => versionByUnit.get(unit.id)!.id))].map(id => ({
                version: versionByUnit.get(units.find(unit => versionByUnit.get(unit.id)!.id === id)!.id)!,
                units: units.filter(unit => versionByUnit.get(unit.id)!.id === id),
              }));
              return <tbody key={record.source.recordId}>{groups.flatMap((group, groupIndex) => group.units.map((unit, unitIndex) => {
                const version = group.version;
                const placement = unit.placement;
                const editRequest = () => { planSnapshot.current = productionActionSnapshot(production, { action: 'updatePlan', unitId: unit.id }); setError(null); setEditingUnitId(unit.id); setPlanForm(formForUnit(unit)); };
                const prepare = () => void produceArtwork(unit);
                const preparationIssue = artworkPreparationIssue(unit, record.source);
                const positionLabel = placement ? productionPositionLabel(placement) : '待定位置';
                const queueJob = artworkJobs.find(job => job.id === unit.id);
                const producingHere = Boolean(queueJob);
                const queuePosition = artworkJobs.filter(job => job.status === 'queued').findIndex(job => job.id === unit.id) + 1;
                const pendingSave = unsavedArtworks.current.get(unit.id);
                const unitBlocked = unitBusyReason(unit.id);
                const versionBlocked = versionBusyReason(version.id);
                const preparationDisabled = Boolean(unitBlocked || preparationIssue);
                const rowError = artworkErrors[unit.id];
                const nativeCandidate = nativeCandidates[unit.id];
                const activeAttempt = [...unit.attempts].reverse().find(attempt => ['submitted', 'processing', 'unknownSubmission'].includes(attempt.status));
                const reusableDraft = unit.artwork?.draft;
                const canReflow = Boolean(reusableDraft?.text && !reusableDraft.extraGraphics?.length && !reusableDraft.extraTexts?.length && reusableDraft.layout.preset !== 'custom' && unit.artwork?.recipeFingerprint === unit.recipeFingerprint);
                const issues = unit.artwork ? artworkAcceptanceIssues(unit.artwork.validation) : [];
                const stage = productionArtworkStage(unit);
                const textOnly = isTextOnlyArtwork(unit);
                const wholeGeneration = !textOnly && productionArtworkRouting(unit, record.source).facts.intent === 'generate';
                const visibleAmbiguities = textOnly ? artworkPlanIssues(record.source, unit) : currentArtworkAmbiguities(unit);
                const status = issues.length ? '图案有待完成项' : stage === '待核对 Logo' ? '已制作 · 待核对' : stage === 'Logo 已确认' ? '图案已核对' : stage;
                return <tr key={unit.id} data-version-id={version.id} data-unit-id={unit.id} className={unitIndex === 0 ? 'wps-version-start' : undefined}>
                  {groupIndex === 0 && unitIndex === 0 && <td className="wps-production-source" rowSpan={units.length}>
                    <small className="wps-technical-id">{record.source.recordId} · {record.source.revision}</small><strong>{record.source.customerId}</strong><p>{record.source.requirementText}</p><small>商品款式：{record.source.productStyleText}</small>
                    <div>{record.source.materials.map((material, index) => {
                      const url = material.previewUrl ?? material.url;
                      return <WpsMaterialImage key={material.id} src={url} alt={material.description} label={`图${index + 1}`} sizes="68px" open={() => url && setPreview({ url, title: `图${index + 1} · ${material.description}` })} />;
                    })}</div>
                    {statusEditor(record.source)}
                  </td>}
                  {unitIndex === 0 && <td className="wps-garment-cell" rowSpan={group.units.length}>
                    <strong>{version.garmentLabel}</strong><small>{version.variantLabel} · {group.units.length} 个印花位置</small>
                    <WpsGarmentSelector unit={unit} styles={catalogStyles} busy={Boolean(versionBlocked)} select={(variantId, assetVersionId) => { void runAction(`garment:${unit.id}`, { action: 'selectGarment', unitId: unit.id, variantId, assetVersionId }); }} />
                    <WpsGarmentPreview unit={unit} units={group.units} open={!versionBlocked && inspectingId !== unit.id ? () => void openPlacement(unit) : undefined} />
                    <small>本方案的 {group.units.length} 个位置共用款式与颜色</small>{versionBlocked && <small role="status">暂不可更换衣服或调整位置：{versionBlocked}</small>}
                  </td>}
                  <td className="wps-requirement-cell">
                    <div className="wps-requirements"><section>
                      <div className="wps-requirement-title"><strong>{positionLabel}</strong><button className="wps-text-button" type="button" disabled={Boolean(unitBlocked)} title={unitBlocked ?? undefined} onClick={editRequest}>修改要求</button></div>
                      <p className="wps-requirement-instruction">{unit.instruction}</p>
                      {unit.exactText && !unit.instruction.includes(unit.exactText) && <p className="wps-requirement-exact-text"><span>文字</span>{unit.exactText}</p>}
                      <div className="wps-requirement-materials"><span>{textOnly ? '纯文字 · 无需素材' : isReferenceTextArtwork(unit) ? '文字标识 · 图片作样式参考' : <>素材 {unit.materialId ? `图${record.source.materials.findIndex(material => material.id === unit.materialId) + 1}` : '待选择'}</>}</span>
                      {unit.referenceMaterialIds.length > 0 && <span>仅作参考 {unit.referenceMaterialIds.map(id => `图${record.source.materials.findIndex(material => material.id === id) + 1}`).join('、')}</span>}</div>
                      <div className="wps-requirement-details">
                        {!wholeGeneration && unit.layoutNote && <details><summary>排版要求</summary><p>{unit.layoutNote}</p></details>}
                        {!textOnly && unit.generationPrompt && <details><summary>{wholeGeneration ? '完整生图提示词' : '模型提示词'}</summary><p>{unit.generationPrompt}</p></details>}
                        {groupIndex === 0 && unitIndex === 0 && record.summary && record.summary !== repeatedSummary && <details><summary>整单理解</summary><p>{record.summary}</p></details>}
                      </div>
                      {visibleAmbiguities.length > 0 && <details className="wps-requirement-issues" open={artworkBlockingAmbiguities(visibleAmbiguities).length > 0}><summary>{artworkBlockingAmbiguities(visibleAmbiguities).length ? `有 ${visibleAmbiguities.length} 项待核对` : `AI 提醒 ${visibleAmbiguities.length} 条 · 可继续制作`}</summary><p>{visibleAmbiguities.join('；')}</p></details>}
                    </section></div>
                  </td>
                  <td className="wps-artwork-cell" aria-label={`${positionLabel}图案制作`} aria-busy={producingHere}>
                    {textOnly && !unit.artwork && <p className="wps-text-artwork-hint">纯文字排版 · 抖音美好体</p>}
                    {!textOnly && (!unit.artwork || cutoutSettings[unit.id]) && <div className="wps-artwork-settings">
                    <WpsArtworkMethodSelector unit={unit} source={record.source} busy={Boolean(unitBlocked)} change={method => { void runAction(`method:${unit.id}`, { action: 'updatePlan', unitId: unit.id, patch: { artworkMethod: method } }); }} />
                    {unit.route !== 'gpt-image-2' && unit.sourceScope !== 'wholeImage' && <WpsCutoutControls compact key={`${unit.id}:${unit.materialId}`} mode={unit.cutoutMode ?? 'auto'} sourceUrl={record.source.materials.find(material => material.id === unit.materialId)?.url ?? record.source.materials.find(material => material.id === unit.materialId)?.previewUrl} generated={productionArtworkRouting(unit, record.source).decision.method === 'generate'} busy={Boolean(unitBlocked)} change={mode => { void runAction(`cutoutMode:${unit.id}`, { action: 'updatePlan', unitId: unit.id, patch: { cutoutMode: mode } }); }} />}
                    </div>}
                    <div className="wps-artwork-current">
                      {unit.artwork ? <button className="wps-artwork-preview" aria-label={`编辑${unit.garmentLabel} ${placement ? productionPositionLabel(placement) : ''}图案`} disabled={Boolean(unitBlocked)} title={unitBlocked ?? undefined} onPointerEnter={() => { if (unit.artwork?.draft) preloadArtworkDraft(unit.artwork.draft); }} onFocus={() => { if (unit.artwork?.draft) preloadArtworkDraft(unit.artwork.draft); }} onClick={() => editArtwork(unit)} type="button"><Image alt={unit.artwork.name} fill sizes="200px" src={unit.artwork.url} unoptimized onLoad={() => { if (unit.artwork?.draft) preloadArtworkDraft(unit.artwork.draft); }}/></button> : !artworkProgress[unit.id]?.preview && <div className="wps-artwork-placeholder">{positionLabel}图案将在这里显示</div>}
                      {unit.artwork && <div className="wps-artwork-caption"><small>点击图案编辑</small><button type="button" className="wps-text-button" disabled={inspectingId === unit.id} onClick={() => void openArtworkReview(unit)}>{textOnly ? '查看文字图案' : '原图与抠图结果'}</button>{unit.route !== 'gpt-image-2' && issues.length === 0 && <button type="button" className="wps-artwork-redo" disabled={preparationDisabled || Boolean(activeAttempt)} title={unitBlocked ?? preparationIssue ?? '按当前要求重新制作，可能产生费用；上次图案保留供对照。'} onClick={prepare}>{queueJob ? queueJob.status === 'queued' ? '已加入队列' : '正在重做…' : '重做图案'}</button>}{unit.artwork.draft?.preprocessing.cutout && <small>{CUTOUT_ROUTE_LABELS[unit.artwork.draft.preprocessing.cutout.route]} · {cutoutFeeLabel(unit.artwork.draft.preprocessing.cutout)}</small>}</div>}
                    </div>
                    {unitBlocked && !queueJob && !activeAttempt && <small role="status">{unitBlocked}</small>}
                    <p role="status" aria-live="polite" className={`wps-artwork-status ${issues.length || unit.error || rowError ? 'needs-attention' : unit.gateB ? 'complete' : ''}`}>{queueJob ? queueJob.status === 'queued' ? `排队中 · 第 ${queuePosition} 张` : queueJob.progress : activeAttempt ? '正在制作，请查询进度' : rowError ? '这次没做完，请看下方原因' : status}</p>
                    {rowError && <p className="wps-production-row-error" role="alert">{rowError}</p>}
                    {artworkProgress[unit.id] && <WpsArtworkProgress {...artworkProgress[unit.id]} failed={Boolean(rowError) && !queueJob} open={(url, title) => setPreview({ url, title })} />}
                    {cutoutSessions[unit.id] && <>
                      <CutoutTaskStatus session={cutoutSessions[unit.id]} hasArtwork={Boolean(unit.artwork)} busy={Boolean(queueJob)} query={() => void runCutout(unit, cutoutSessions[unit.id].result.receipt.mode, true)} retry={() => void runCutout(unit, cutoutSessions[unit.id].result.receipt.mode)} discard={() => discardCutout(unit.id)} apply={!unit.artwork ? () => void applyCutout(unit) : undefined} />
                      {cutoutSessions[unit.id].result.status === 'completed' && cutoutSessions[unit.id].result.url && <button type="button" onClick={() => unit.artwork && cutoutSessions[unit.id].purpose !== 'component' && !cutoutSessions[unit.id].stale ? setArtworkReviewId(unit.id) : setPreview({ url: cutoutSessions[unit.id].result.url!, title: '本次抠图素材' })}>{cutoutSessions[unit.id].purpose === 'component' || cutoutSessions[unit.id].stale ? '查看抠图素材' : '查看新抠图结果'}</button>}
                      {cutoutSessions[unit.id].result.status === 'failed' && !cutoutSessions[unit.id].stale && ['standard', 'volcano'].includes(cutoutSessions[unit.id].result.receipt.route) && <button type="button" className="primary" disabled={Boolean(queueJob)} onClick={() => void runCutout(unit, 'meitu')}>可选：美图精细 · 预计 1 积分</button>}
                    </>}
                    {nativeCandidate && <div className="wps-production-row-error">
                      <a href={nativeCandidate.url} target="_blank" rel="noreferrer">{nativeCandidate.stage === 'edit-review' ? '查看这次做出的图（尚未保存成品）' : '查看刚生成的图（背景还没去好）'}</a>
                      <a href={nativeCandidate.url} download={`${unit.id}-candidate.png`}>下载这张图</a>
                      <small>这张图还没用到衣服上。需要保留的话，请先下载，再刷新页面。</small>
                    </div>}
                    {queueJob?.status === 'queued' && <button className="wps-text-button" type="button" onClick={() => artworkQueue.cancel(unit.id)}>取消排队</button>}
                    {pendingSave && !queueJob && <div className="wps-production-row-error"><button type="button" disabled={Boolean(operationReason({ action: 'submitArtwork', unitId: unit.id }, { ignorePending: unit.id }))} onClick={() => void retryArtworkSave(unit)}>重试保存图案</button><a href={String(pendingSave.url)} download>下载已生成图案</a><small>保存重试不会重新生图；请先保存或下载，再刷新页面。</small></div>}
                    {preparationIssue && (!unit.artwork || issues.length > 0) && <div className="wps-production-row-error"><p>{preparationIssue}</p><button className="wps-text-button" disabled={Boolean(unitBlocked)} title={unitBlocked ?? undefined} type="button" onClick={editRequest}>核对素材与参考要求</button></div>}
                    {unit.route !== 'gpt-image-2' && (!unit.artwork || issues.length > 0) && <button className="primary" disabled={preparationDisabled || Boolean(activeAttempt)} onClick={prepare} type="button">{queueJob ? queueJob.status === 'queued' ? '已加入队列' : '正在制作…' : `${unit.artwork ? '重新制作' : '制作'}${positionLabel}图案`}</button>}
                    {(unit.error || issues.length > 0) && <details className="wps-inline-records"><summary>查看原因</summary><ul>{[...new Set([unit.error, ...issues].filter((issue): issue is string => Boolean(issue)))].map(issue => <li key={issue}>{issue}</li>)}</ul></details>}
                    {!unit.artwork && unit.previousArtwork && <button className="wps-text-button" type="button" onClick={() => setPreview({ url: unit.previousArtwork!.url, title: '上次图案 · 制作要求已变化，仅供对照' })}>查看上次图案</button>}
                    {!unit.artwork && unit.route === 'gpt-image-2' && !activeAttempt && <form className="wps-gpt-cost" onSubmit={event => {
                      event.preventDefault();
                      const estimatedCostCny = Number(new FormData(event.currentTarget).get('estimatedCostCny'));
                      if (estimatedCostCny > 0) void runAction(`gpt:${unit.id}`, { action: 'startGptImage2', unitId: unit.id, estimatedCostCny });
                    }}><label>本次预计费用（元）<input name="estimatedCostCny" type="number" min="0.01" step="0.01" required disabled={Boolean(unitBlocked)} title={unitBlocked ?? undefined}/></label><small>GPT Image 2 · 1K · Low · 透明 PNG</small><button className="primary" disabled={Boolean(unitBlocked || preparationIssue)} title={unitBlocked ?? undefined} type="submit">制作{positionLabel}图案</button></form>}
                    {!textOnly && (!unit.artwork || issues.length > 0) && unit.route !== 'gpt-image-2' && <small className="wps-production-cost">制作可能调用付费图像服务，实际费用以服务商账单为准。</small>}

                    {activeAttempt?.providerTaskId && <button disabled={Boolean(operationReason({ action: 'pollGptImage2', unitId: unit.id }, { ignoreAttempt: unit.id }))} onClick={() => void runAction(`poll:${unit.id}`, { action: 'pollGptImage2', unitId: unit.id, attemptId: activeAttempt.id })} type="button">查询制作进度</button>}
                    <div className="wps-artwork-options"><details className="wps-artwork-more"><summary>更多操作</summary><div>
                      {unit.artwork && <>{!textOnly && <button type="button" onClick={() => setCutoutSettings(current => ({ ...current, [unit.id]: !current[unit.id] }))}>{cutoutSettings[unit.id] ? '收起制作设置' : '调整制作设置'}</button>}<button disabled={Boolean(unitBlocked)} title={unitBlocked ?? undefined} type="button" onClick={() => void runAction(`quality:${unit.id}`, { action: 'checkArtworkQuality', unitId: unit.id })}>画质参考（可选）</button></>}
                      {unit.artwork && unit.route !== 'gpt-image-2' && <><small>重新制作可能产生费用；保存后撤销原确认，上次图案保留供对照。</small>{preparationIssue && <p>{preparationIssue}</p>}</>}
                      {canReflow && <button disabled={Boolean(unitBlocked)} title={unitBlocked ?? undefined} type="button" onClick={() => void reflowArtwork(unit)}>自动调整图文比例</button>}
                      <label className="wps-upload">上传完成的 PNG<input accept="image/png" disabled={Boolean(unitBlocked)} title={unitBlocked ?? undefined} type="file" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadArtwork(unit, file); }}/></label>
                    </div></details>
                    <WpsArtworkPreparationDetails unit={unit} source={record.source} preview={(url, title) => setPreview({ url, title })} />
                    </div>
                    {unit.returnReason && <em>退回：{unit.returnReason}</em>}
                  </td>
                  {unitIndex === 0 && <td className="wps-version-cell" rowSpan={group.units.length}>
                    <strong>{version.garmentLabel} · {version.variantLabel}</strong>
                    <WpsMockupPreview version={version} units={group.units} open={setPreview} adjust={() => void openPlacement(unit)} disabled={Boolean(versionBlocked) || inspectingId === unit.id} paused={Boolean(placingUnitId && version.unitIds.includes(placingUnitId))} composing={operations.some(operation => operation.key === `compose:${version.id}`) || version.status === 'composing'} />

                    {version.output && version.output.compositorVersion !== WPS_COMPOSITOR_VERSION && <button disabled={Boolean(versionBlocked)} title={versionBlocked ?? undefined} type="button" onClick={() => void runAction(`compose:${version.id}`, { action: 'composeVersion', versionId: version.id })}>更新为高清客户图</button>}
                    <span className={`wps-state ${version.status === 'approved' ? 'done' : ''}`}>{{waitingArtwork:'待完成图案与位置',readyToCompose:'可合成客户图',composing:'正在合成',pendingFinalConfirmation:'待核对客户图',approved:'客户图已确认',failed:'合成失败'}[version.status]}</span>
                    {version.compositionError && <p role="alert">{version.compositionError}</p>}{(version.status === 'readyToCompose' || version.status === 'failed') && <button disabled={Boolean(versionBlocked)} title={versionBlocked ?? undefined} onClick={() => void runAction(`compose:${version.id}`, { action: 'composeVersion', versionId: version.id })} type="button">合成一张正反面效果图</button>}
                    {version.status === 'pendingFinalConfirmation' && <div className="wps-version-actions"><button disabled={Boolean(versionBlocked) || version.output?.compositorVersion !== WPS_COMPOSITOR_VERSION} onClick={() => void runAction(`approve:${version.id}`, { action: 'approveVersion', versionId: version.id, actor: '当前操作员' })} type="button">确认客户成品</button><button disabled={Boolean(versionBlocked)} title={versionBlocked ?? undefined} onClick={() => { const unitId = window.prompt(`输入要退回的单元 ID：\n${version.unitIds.join('\n')}`, version.unitIds[0]); const reason = unitId && window.prompt('填写退回原因'); if (unitId && reason) void runAction(`return:${unitId}`, { action: 'returnUnit', versionId: version.id, unitId, reason }); }} type="button">退回单个位置</button></div>}
                  </td>}
                </tr>;
              }))}</tbody>;
            })}
          </table>
        </div>}
      </main>
      {editingUnit && editingRecord && planForm && <div className="wps-plan-backdrop" onMouseDown={(event) => !unitBusyReason(editingUnit.id) && event.target === event.currentTarget && setEditingUnitId(null)}><div className="wps-plan-dialog" role="dialog" aria-modal="true" aria-labelledby="wps-plan-title">
        <header><div><small>修改制作要求</small><strong id="wps-plan-title">{editingRecord.source.customerId} · {editingUnit.garmentLabel} · {editingUnit.variantLabel}</strong></div><button disabled={Boolean(unitBusyReason(editingUnit.id))} onClick={() => setEditingUnitId(null)} type="button">关闭</button></header>
        <section className="wps-plan-evidence"><div><b>WPS 原文</b><p>{editingRecord.source.requirementText}</p></div><div><b>附件</b><div>{editingRecord.source.materials.map((material, index) => { const url = material.previewUrl ?? material.url; return <WpsMaterialImage key={material.id} src={url} alt={material.description} label={`图${index + 1}`} sizes="70px" open={() => url && setPreview({ url, title: `图${index + 1} · ${material.description}` })} />; })}</div></div></section>
        <section className="wps-plan-fields">
          <label><span>主要内容素材</span><select disabled={planningPrompt} value={planForm.materialId} onChange={(event) => setPlanForm({ ...planForm, materialId: event.target.value })}><option value="">无内容图片（文字制作）</option>{editingRecord.source.materials.map((material, index) => <option key={material.id} value={material.id}>图{index + 1} · {material.description}</option>)}</select></label>
          <label className="wide"><span>模型提示词（整理和保存不会切换处理方式）</span><textarea rows={9} maxLength={4000} disabled={planningPrompt} placeholder="根据 WPS 原文和图片整理，或直接填写完整生图要求。图片使用 WPS 图号，例如图5、图4。" value={planForm.generationPrompt ?? ''} onChange={(event) => setPlanForm({ ...planForm, generationPrompt: event.target.value })} /></label>
          {planForm.generationPrompt && <details className="wide"><summary>整图生成时使用的正文与图片对应关系</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{(() => {
            try { return artworkPrompt({ ...editingUnit, ...planForm, ambiguities: editingUnit.ambiguities, materialId: planForm.materialId || null }, editingRecord.source).generate; }
            catch (error) { return error instanceof Error ? error.message : String(error); }
          })()}</pre></details>}
          <div className="wide"><button disabled={planningPrompt || Boolean(unitBusyReason(editingUnit.id))} onClick={() => void planGenerationPrompt()} type="button">{planningPrompt ? '正在阅读原文和图片…' : '根据原文和图片整理提示词'}</button><p>整理结果先进入草稿；保存不会切换处理方式。A／C 的加字、改色和局部调整请填写下方制作要求，D 使用此正文生成完整图案。</p></div>
          <label><span>素材取用</span><select disabled={planningPrompt} value={planForm.sourceScope} onChange={(event) => setPlanForm({ ...planForm, sourceScope: event.target.value as ProductionUnit['sourceScope'] })}><option value="subject">去背景，保留全部前景</option><option value="subjectWithFrame">主体与内部框架</option><option value="wholeImage">完整整图</option><option value="custom">按描述取用</option></select></label>
          <label><span>文字处理</span><select disabled={planningPrompt} value={planForm.textMode ?? 'none'} onChange={(event) => setPlanForm({ ...planForm, textMode: event.target.value as NonNullable<ProductionUnit['textMode']> })}><option value="keep">保留原文字</option><option value="replace">替换/新增准确文字</option><option value="none">不需要文字</option></select></label>
          <label><span>准确文字</span><input disabled={planningPrompt} value={planForm.exactText} onChange={(event) => setPlanForm({ ...planForm, exactText: event.target.value })} /></label>
          <label className="wide"><span>制作要求</span><textarea disabled={planningPrompt} rows={3} value={planForm.instruction} onChange={event => setPlanForm({ ...planForm, instruction: event.target.value })} /></label>
          <label className="wide"><span>参考区域、字体与排版要求</span><textarea disabled={planningPrompt} rows={3} value={planForm.layoutNote} onChange={event => setPlanForm({ ...planForm, layoutNote: event.target.value })} /></label>
          <fieldset className="wide"><legend>一同发送的参考素材（用途写在提示词中）</legend>{editingRecord.source.materials.filter((material) => material.id !== planForm.materialId).map((material) => <label key={material.id}><input disabled={planningPrompt} checked={planForm.referenceMaterialIds.includes(material.id)} onChange={(event) => setPlanForm({ ...planForm, referenceMaterialIds: event.target.checked ? [...planForm.referenceMaterialIds, material.id] : planForm.referenceMaterialIds.filter((id) => id !== material.id) })} type="checkbox" />图{editingRecord.source.materials.indexOf(material) + 1} · {material.description}</label>)}</fieldset>
          <label className="wide"><span>仍未解决的歧义（每行一项；全部解决后清空）</span><textarea disabled={planningPrompt} rows={2} value={planForm.ambiguities} onChange={(event) => setPlanForm({ ...planForm, ambiguities: event.target.value })} /></label>

        </section>
        <footer>{error && <p className="wps-plan-error" role="alert">操作未完成：{error}</p>}<span>修改要求后需重新制作图案，上次图案保留供对照。</span><div><button disabled={Boolean(unitBusyReason(editingUnit.id))} onClick={() => setEditingUnitId(null)} type="button">取消</button><button className="primary" disabled={planningPrompt || Boolean(unitBusyReason(editingUnit.id))} onClick={() => void savePlan()} type="button">{unitBusyReason(editingUnit.id) ? '正在保存…' : '保存要求'}</button></div></footer>
      </div></div>}
      {artworkReviewId && (() => {
        const unit = production?.units.find(unit => unit.id === artworkReviewId);
        const source = production?.records.find(record => record.source.recordId === unit?.sourceRecordId)?.source;
        if (!unit?.artwork || !source) return null;
        return <WpsArtworkReview unit={unit} source={source} busy={artworkQueue.has(unit.id) || operations.some(operation => operation.batch || operation.unitIds.includes(unit.id))} error={error || artworkErrors[unit.id] || null} close={() => setArtworkReviewId(null)} edit={() => { setArtworkReviewId(null); setArtworkEditor({ unit, draft: unit.artwork!.draft ?? createLegacyArtworkDraft(unit.artwork!.url) }); }}
          cutoutSession={cutoutSessions[unit.id]} onReCutout={mode => void runCutout(unit, mode)} onQueryCutout={() => void runCutout(unit, cutoutSessions[unit.id]?.result.receipt.mode ?? 'auto', true)} onApplyCutout={() => void applyCutout(unit)} onDiscardCutout={() => discardCutout(unit.id)}
          onCheckQuality={checkArtworkQuality}
          onSaveTextCheck={saveArtworkTextCheck} />;
      })()}
      {placingUnitId && (() => {
        const unit = production?.units.find(unit => unit.id === placingUnitId);
        const version = versionByUnit.get(placingUnitId);
        if (!unit?.garment || !version) return null;
        return <WpsPlacementEditor key={unit.id} unit={unit} requirementText={production!.records.find(record => record.source.recordId === unit.sourceRecordId)?.source.requirementText} versionUnits={production!.units.filter(candidate => version.unitIds.includes(candidate.id))} busy={Boolean(versionBusyReason(version.id))} composing={operations.some(operation => operation.key === `compose:${version.id}`)} error={error} edit={editArtwork} close={() => setPlacingUnitId(null)} save={saveTaskPlacement} />;
      })()}
      {artworkEditor && <TaskReviewArtworkEditor title={`${artworkEditor.unit.garmentLabel} · 图案调整`} originalRequirement={production?.records.find(record => record.source.recordId === artworkEditor.unit.sourceRecordId)?.source.requirementText ?? ''} initialDraft={artworkEditor.draft} defaultTextColor={() => productionTextColor(artworkEditor.unit)} renderPreview={draft => <WpsArtworkSizePreview unit={artworkEditor.unit} draft={draft}/>} saveLabel="保存图案" saveHint="保存后返回生产台，保留图层并更新客户效果图。" saving={Boolean(unitBusyReason(artworkEditor.unit.id))} onCancel={() => setArtworkEditor(null)} onSave={saveArtworkDraft} />}
      {preview && <div className={`wps-preview-backdrop ${preview.title.includes("图案") || preview.title.startsWith("图") ? 'artwork-preview' : 'customer-preview'}`} onMouseDown={(event) => event.target === event.currentTarget && setPreview(null)}><div role="dialog" aria-modal="true" aria-label={preview.title}><header><strong>{preview.title}</strong><button  onClick={() => setPreview(null)} type="button">关闭</button></header><section><WpsMaterialImage src={preview.url} alt={preview.title} sizes="90vw" large /></section>{previewVersion?.output && <footer>{error && <p className="wps-plan-error" role="alert">{error}</p>}<span>{previewVersion.output.width} × {previewVersion.output.height} px · 用于核对整体位置与比例，小字请查看高清图案。</span><div><button  onClick={() => setPreview(null)} type="button">返回表格调整</button>{previewVersion.status === 'pendingFinalConfirmation' && <button className="primary" disabled={Boolean(versionBusyReason(previewVersion.id))} type="button" onClick={async () => { const state = await runAction(`approve:${previewVersion.id}`, { action: 'approveVersion', versionId: previewVersion.id, actor: '当前操作员' }); if (state) { setPreview(null); setMessage('客户图已确认，可以导出。'); } }}>确认客户成品</button>}</div></footer>}</div></div>}
    </div>
  );
}
