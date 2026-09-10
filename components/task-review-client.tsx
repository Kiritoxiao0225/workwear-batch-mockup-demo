'use client';
import { readApiPayload, readApiBlob, fetchApi, readApiJson, assertApiResponse } from '@/lib/client/api-response';

/* eslint-disable react-hooks/refs -- async MediaKit responses must compare against the latest recipe before committing; refs are read only inside event handlers */

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AppHeader } from '@/components/app-header';
import { TaskReviewArtworkEditor } from '@/components/task-review-artwork-editor';
import {
  artworkRecipeFingerprint,
  editedArtworkUnit,
  preparedArtworkUnit,
} from '@/lib/batch-task-review';
import {
  canConfirmUnit,
  selectedMaterial,
  taskReviewDisplayGroups,
  unitReviewIssues,
  type GenerationUnit,
  type ArtworkProcessingRouteMode,
  type ReviewFilter,
  type SourceScope,
  type SourceTaskRecord,
  type TaskReview,
} from '@/lib/batch-task-review';
import {
  artworkDraftExactText,
  artworkGraphicLayers,
  createLegacyArtworkDraft,
  type ArtworkDraft,
  type ArtworkGraphicLayer,
} from '@/lib/artwork-editor';
import { uploadLogo } from '@/lib/client/logo';
import { artworkPngFile } from '@/lib/client/render-artwork';
import { persistArtworkLayerAssets } from '@/lib/client/artwork-layer-editing';
import {
  readTaskReviewAnalysisCache,
  removeTaskReviewAnalysisCache,
  writeTaskReviewAnalysisCache,
} from '@/lib/client/task-review-analysis-cache';
import type { LogoStudioInputImage } from '@/lib/logo-studio';
import { PLACEMENT_LABELS } from '@/lib/mockup';
import { PRODUCTS, productByCode } from '@/lib/products';
import {
  buildCanonicalArtworkModelPrompt,
  describeArtworkComposition,
  requiresCompleteModelComposition,
  type CanonicalArtworkModelPrompt,
  type ArtworkPreparationResponse,
} from '@/lib/task-review-artwork';
import type { PlacementKey } from '@/lib/types';
import type { WpsProductionState } from '@/lib/wps-production';
import { canAnalyzeWpsTask } from '@/lib/wps-source';

type SyncResponse = {
  mode: 'live';
  configured: boolean;
  missingEnvironment: string[];
  sourceUrl: string;
  records: SourceTaskRecord[];
  reviews: TaskReview[] | null;
  syncedAt: string | null;
};

type BusyAction = 'sync' | 'create' | `upload:${string}` | `prepare:${string}` | `save-artwork:${string}` | null;

type EditingTarget = {
  reviewId: string;
  unitId: string;
};

type MaterialPreviewTarget = {
  reviewId: string;
  materialId: string;
  unitId: string | null;
};

type AnalysisProgress = {
  active: boolean;
  total: number;
  completed: number;
  cached: number;
  failed: number;
};

type WpsAuthorizationRequiredResponse = {
  error: string;
  authorizeUrl: string;
};

const EMPTY_ANALYSIS_PROGRESS: AnalysisProgress = {
  active: false,
  total: 0,
  completed: 0,
  cached: 0,
  failed: 0,
};
const ANALYSIS_CONCURRENCY = 2;
const WPS_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

const SOURCE_SCOPE_OPTIONS: Array<{
  value: SourceScope;
  label: string;
  shortLabel: string;
  instruction: string;
}> = [
  {
    value: 'subject',
    label: '去背景（默认）',
    shortLabel: '去背景',
    instruction: '只移除与画布边缘连通的背景或底色；保留全部非背景前景元素，包括音符、文字、边框、装饰、内部细节与负形。客户没有明确要求删除的前景元素不得删除。',
  },
  {
    value: 'subjectWithFrame',
    label: '主体＋内部框架',
    shortLabel: '主体＋框架',
    instruction: '提取指定的 Logo/图形主体并保留其内部框架，例如校徽圆环或徽章边框；只移除背景，客户没有明确要求删除的其他前景元素不得删除。',
  },
  {
    value: 'wholeImage',
    label: '整张素材',
    shortLabel: '整图',
    instruction: '完整使用主要素材中的全部图形、文字与框架，不裁掉其中的组成部分。',
  },
  {
    value: 'custom',
    label: '自定义（按描述）',
    shortLabel: '自定义',
    instruction: '严格按用户描述决定保留和删除范围；没有写明的元素不要擅自加入结果。',
  },
];

const PROCESSING_ROUTE_OPTIONS: Array<{
  value: ArtworkProcessingRouteMode;
  label: string;
  description: string;
}> = [
  { value: 'auto', label: '自动判断', description: '按制作意图、主体像素和参考关系选择路线' },
  { value: 'fidelity', label: '原图保真', description: '去背景、保真增强、换色和普通准确文字' },
  { value: 'hybrid', label: '混合处理', description: '保留主要图形，模型处理特殊字体或参考排版' },
  { value: 'model', label: '模型生成', description: '低清重建、多素材组合或复杂局部重组' },
];

async function jsonResponse<T>(response: Response): Promise<T> {
  return readApiJson(response, '任务请求失败') as Promise<T>;
}

function unitLabel(unit: GenerationUnit) {
  return `${unit.garmentLabel} · ${unit.variantLabel}`;
}

function unitScope(unit: GenerationUnit) {
  return SOURCE_SCOPE_OPTIONS.find((option) => option.value === unit.sourceScope)
    ?? SOURCE_SCOPE_OPTIONS[0];
}

function artworkType(unit: GenerationUnit) {
  if (unit.textMode === 'replace') return '主体图形＋文字';
  if (unit.textMode === 'none') return '主体图形';
  if (unit.sourceScope === 'wholeImage') return '完整原图案';
  return '主体图形图案';
}

function plannedComponentSummary(review: TaskReview, unit: GenerationUnit) {
  if (unit.artworkDraft?.preprocessing.componentSummary?.length) {
    return unit.artworkDraft.preprocessing.componentSummary;
  }
  const primary = selectedMaterial(review, unit.logo.materialId);
  const primaryIndex = primary
    ? review.source.materials.findIndex((material) => material.id === primary.id)
    : -1;
  const references = unit.referenceMaterialIds
    .map((id) => review.source.materials.findIndex((material) => material.id === id))
    .filter((index) => index >= 0)
    .map((index) => `图${index + 1}`);
  const compositionInput = {
    instruction: unit.instruction,
    exactText: unit.textMode === 'replace' ? unit.exactText : '',
    layoutNote: unit.layoutNote,
    primaryImageLabel: primaryIndex >= 0 ? `图${primaryIndex + 1}` : '主要素材',
    referenceImageLabels: references,
  };
  const composition = describeArtworkComposition(compositionInput);
  const selectedRoute = unit.processingRoute ?? 'auto';
  if (selectedRoute === 'model'
    || (selectedRoute === 'auto' && requiresCompleteModelComposition(compositionInput))) {
    return [
      `${compositionInput.primaryImageLabel}：作为必须进入成品的内容源`,
      ...composition.textSegments.map((value) => `文字“${value}”：作为准确内容进入完整生成`),
      ...references.map((label) => `${label}：只参考字形、整体层级和排版，不复制人物、衣服或背景`),
      `${[
        compositionInput.primaryImageLabel,
        ...references,
      ].join('＋')}＋完整要求一次进入模型，输出一张不可分层的完整候选`,
    ];
  }
  return composition.summary;
}

function predictsCompleteModelRoute(review: TaskReview, unit: GenerationUnit) {
  const selectedRoute = unit.processingRoute ?? 'auto';
  if (selectedRoute === 'model') return true;
  if (selectedRoute !== 'auto') return false;
  const primary = selectedMaterial(review, unit.logo.materialId);
  const primaryIndex = primary
    ? review.source.materials.findIndex((material) => material.id === primary.id)
    : -1;
  const references = unit.referenceMaterialIds
    .map((id) => review.source.materials.findIndex((material) => material.id === id))
    .filter((index) => index >= 0)
    .map((index) => `图${index + 1}`);
  return requiresCompleteModelComposition({
    instruction: unit.instruction,
    exactText: unit.textMode === 'replace' ? unit.exactText : '',
    layoutNote: unit.layoutNote,
    primaryImageLabel: primaryIndex >= 0 ? `图${primaryIndex + 1}` : '主要素材',
    referenceImageLabels: references,
  });
}

function indexedReviewMaterials(review: TaskReview, materialIds: string[]) {
  return materialIds.flatMap((materialId) => {
    const index = review.source.materials.findIndex((material) => material.id === materialId);
    if (index < 0) return [];
    return [{
      material: review.source.materials[index],
      label: `图${index + 1}`,
    }];
  });
}

function understoodComposition(review: TaskReview, unit: GenerationUnit) {
  const primary = selectedMaterial(review, unit.logo.materialId);
  const primaryIndex = primary
    ? review.source.materials.findIndex((material) => material.id === primary.id)
    : -1;
  const references = unit.referenceMaterialIds
    .map((id) => review.source.materials.findIndex((material) => material.id === id))
    .filter((index) => index >= 0)
    .map((index) => `图${index + 1}`);
  return describeArtworkComposition({
    instruction: unit.instruction,
    exactText: unit.textMode === 'replace' ? unit.exactText : '',
    layoutNote: unit.layoutNote,
    primaryImageLabel: primaryIndex >= 0 ? `图${primaryIndex + 1}` : '来源图待确认',
    referenceImageLabels: references,
  });
}

function canonicalModelPromptForUnit(
  review: TaskReview,
  unit: GenerationUnit,
): CanonicalArtworkModelPrompt | null {
  const primary = selectedMaterial(review, unit.logo.materialId);
  if (!primary) return null;
  const primaryIndex = review.source.materials.findIndex((material) => material.id === primary.id);
  if (primaryIndex < 0) return null;
  const referenceImageLabels = [...new Set(unit.referenceMaterialIds)]
    .filter((materialId) => materialId !== primary.id)
    .flatMap((materialId) => {
    const referenceIndex = review.source.materials.findIndex((material) => material.id === materialId);
    return referenceIndex >= 0 ? [`图${referenceIndex + 1}`] : [];
  });
  return buildCanonicalArtworkModelPrompt({
    sourceRequirementText: review.source.requirementText,
    instruction: unit.instruction,
    exactText: unit.textMode === 'replace' ? unit.exactText : '',
    layoutNote: unit.layoutNote,
    sourceScope: unit.sourceScope, sourceAssessment: unit.sourceAssessment,
    primaryImageLabel: `图${primaryIndex + 1}`,
    referenceImageLabels,
  });
}

function unitPlacementLabel(unit: GenerationUnit) {
  return unit.placement ? PLACEMENT_LABELS[unit.placement] : '位置待确认';
}

function dataUrlMimeType(dataUrl: string) {
  return dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,/)?.[1] ?? null;
}

async function logoInputImage(url: string, fileName: string): Promise<LogoStudioInputImage> {
  const dataMimeType = dataUrlMimeType(url);
  if (dataMimeType) return { fileName, mimeType: dataMimeType, dataUrl: url };
  const response = await fetchApi(url);
  await assertApiResponse(response, `${fileName} 下载失败`);
  const blob = await readApiBlob(response);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) {
    throw new Error(`${fileName} 不是可用的 PNG、JPG 或 WebP 图片`);
  }
  if (blob.size <= 0 || blob.size > 8 * 1024 * 1024) {
    throw new Error(`${fileName} 必须在 1B–8MB，实际 ${blob.size}B`);
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${fileName}`));
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error(`${fileName} 没有返回图片内容`));
    reader.readAsDataURL(blob);
  });
  return { fileName, mimeType: blob.type, dataUrl };
}

function routeLabel(unit: GenerationUnit) {
  const resolved = unit.artworkDraft?.preprocessing.processingRoute;
  if (resolved) return PROCESSING_ROUTE_OPTIONS.find((option) => option.value === resolved)?.label ?? resolved;
  return unit.processingRoute && unit.processingRoute !== 'auto'
    ? PROCESSING_ROUTE_OPTIONS.find((option) => option.value === unit.processingRoute)?.label ?? unit.processingRoute
    : '待自动判断';
}

async function dataUrlFile(dataUrl: string, fileName: string) {
  const response = await fetchApi(dataUrl);
  await assertApiResponse(response, `${fileName} 转换失败`);
  const blob = await readApiBlob(response);
  if (blob.type !== 'image/png') throw new Error(`${fileName} 必须是透明 PNG，实际为 ${blob.type || '未知类型'}`);
  return new File([blob], fileName, { type: 'image/png' });
}

function artworkStatus(unit: GenerationUnit) {
  if (unit.confirmed) return {
    label: '图案已确认',
    description: '最终制作图案，已确认可用于效果图',
    className: 'confirmed',
  };
  if (unit.needsRegeneration && unit.logo.url) return {
    label: '要求已修改',
    description: '上一版候选仍保留，按新要求重新生成后才能确认',
    className: 'stale',
  };
  if (!unit.logo.url) return {
    label: '图案未生成',
    description: '当前展示制作配方，不是生成结果',
    className: 'pending',
  };
  return {
    label: '图案待确认',
    description: '完整图案候选，等待人工核对',
    className: 'pending',
  };
}

export function TaskReviewClient() {
  const router = useRouter();
  const [sync, setSync] = useState<SyncResponse | null>(null);
  const [reviews, setReviews] = useState<TaskReview[]>([]);
  const [busy, setBusy] = useState<BusyAction>('sync');
  const [error, setError] = useState<string | null>(null);
  const [wpsAuthorizeUrl, setWpsAuthorizeUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState('正在同步并批量理解 WPS 任务…');
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const [editingTarget, setEditingTarget] = useState<EditingTarget | null>(null);
  const [focusedUnitId, setFocusedUnitId] = useState<string | null>(null);
  const [materialPreviewTarget, setMaterialPreviewTarget] = useState<MaterialPreviewTarget | null>(null);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress>(EMPTY_ANALYSIS_PROGRESS);
  const reviewsRef = useRef(reviews);
  const analysisRunRef = useRef(0);
  const syncInFlightRef = useRef(false);

  const replaceReviews = useCallback((next: TaskReview[]) => {
    reviewsRef.current = next;
    setReviews(next);
  }, []);

  const mutateReviews = useCallback((transform: (current: TaskReview[]) => TaskReview[]) => {
    const next = transform(reviewsRef.current);
    reviewsRef.current = next;
    setReviews(next);
  }, []);

  const analyzeRecords = useCallback(async (
    sourceRecords: SourceTaskRecord[],
    options: { force: boolean; preserveCurrent: boolean },
  ) => {
    const records = sourceRecords.filter((record) => canAnalyzeWpsTask(record) && record.requirementText.trim());
    const runId = analysisRunRef.current + 1;
    analysisRunRef.current = runId;
    setError(null);

    const sourceOrder = new Map(records.map((record, index) => [record.recordId, index]));
    const upsertReview = (review: TaskReview) => {
      mutateReviews((current) => {
        const byRecordId = new Map(current.map((candidate) => [candidate.source.recordId, candidate]));
        byRecordId.set(review.source.recordId, review);
        return [...byRecordId.values()]
          .filter((candidate) => sourceOrder.has(candidate.source.recordId))
          .sort((left, right) => (sourceOrder.get(left.source.recordId) ?? Number.MAX_SAFE_INTEGER)
            - (sourceOrder.get(right.source.recordId) ?? Number.MAX_SAFE_INTEGER));
      });
    };

    const cachedReviews: TaskReview[] = [];
    const recordsToAnalyze: SourceTaskRecord[] = [];
    if (options.force) {
      for (const record of records) {
        removeTaskReviewAnalysisCache(window.localStorage, record);
      }
      recordsToAnalyze.push(...records);
    } else {
      for (const record of records) {
        try {
          const cached = readTaskReviewAnalysisCache(window.localStorage, record);
          if (cached) cachedReviews.push(cached.review);
          else recordsToAnalyze.push(record);
        } catch (cacheError) {
          console.warn(cacheError);
          removeTaskReviewAnalysisCache(window.localStorage, record);
          recordsToAnalyze.push(record);
        }
      }
    }

    if (!options.preserveCurrent) replaceReviews(cachedReviews);
    else cachedReviews.forEach(upsertReview);

    let completed = cachedReviews.length;
    let failed = 0;
    const failures: string[] = [];
    const modelNames = new Set<string>();
    setAnalysisProgress({
      active: recordsToAnalyze.length > 0,
      total: records.length,
      completed,
      cached: cachedReviews.length,
      failed,
    });

    if (recordsToAnalyze.length === 0) {
      setNotice(records.length === 0 ? '当前没有待领取或设计中的可分析任务。' : `已从浏览器缓存恢复 ${cachedReviews.length} 条任务理解；原文和素材未变化，没有重新调用模型。`);
      return;
    }

    setNotice(cachedReviews.length > 0
      ? `已从缓存恢复 ${cachedReviews.length}/${records.length} 条；其余 ${recordsToAnalyze.length} 条正在逐条分析。`
      : `正在逐条分析 ${records.length} 条 WPS 任务；每完成一条就立即显示。`);

    let nextRecordIndex = 0;
    const analyzeNextRecord = async () => {
      while (nextRecordIndex < recordsToAnalyze.length) {
        const record = recordsToAnalyze[nextRecordIndex];
        nextRecordIndex += 1;
        try {
          const result = await jsonResponse<{ reviews: TaskReview[]; model: string }>(await fetchApi('/api/wps-production/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: [record] }),
          }));
          if (result.reviews.length !== 1 || result.reviews[0].source.recordId !== record.recordId) {
            throw new Error(`单行分析返回了错误记录：期望 ${record.recordId}，实际 ${result.reviews.map((review) => review.source.recordId).join('、') || '空'}`);
          }
          if (analysisRunRef.current !== runId) return;
          const [review] = result.reviews;
          upsertReview(review);
          writeTaskReviewAnalysisCache(window.localStorage, record, review, result.model);
          modelNames.add(result.model);
        } catch (analysisError) {
          if (analysisRunRef.current !== runId) return;
          failed += 1;
          failures.push(`${record.customerId}（${record.recordId}）：${analysisError instanceof Error ? analysisError.message : String(analysisError)}`);
        } finally {
          if (analysisRunRef.current !== runId) return;
          completed += 1;
          setAnalysisProgress({
            active: completed < records.length,
            total: records.length,
            completed,
            cached: cachedReviews.length,
            failed,
          });
          setNotice(`任务理解进度 ${completed}/${records.length}；缓存 ${cachedReviews.length} 条，失败 ${failed} 条。`);
        }
      }
    };

    await Promise.all(Array.from(
      { length: Math.min(ANALYSIS_CONCURRENCY, recordsToAnalyze.length) },
      () => analyzeNextRecord(),
    ));
    if (analysisRunRef.current !== runId) return;
    setAnalysisProgress({
      active: false,
      total: records.length,
      completed,
      cached: cachedReviews.length,
      failed,
    });
    if (failures.length > 0) {
      setError(`有 ${failures.length} 条任务分析失败，其他任务已正常显示：${failures.join('；')}`);
      setNotice(`已完成 ${records.length - failures.length}/${records.length} 条任务理解；失败行不会清空其他结果，可再次重新分析。`);
      return;
    }
    const modelLabel = [...modelNames].join('、') || '缓存';
    setNotice(options.force
      ? `已用 ${modelLabel} 逐条重新理解 ${records.length} 条任务；所有完整制作图案需要重新人工确认。`
      : `已完成 ${records.length} 条任务理解，其中 ${cachedReviews.length} 条来自浏览器缓存。`);
  }, [mutateReviews, replaceReviews]);

  const loadSource = useCallback(async () => {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    setBusy('sync');
    setError(null);
    try {
      const response = await fetchApi('/api/wps-tasks', { cache: 'no-store' });
      if (response.status === 401) {
        const body = await readApiPayload(response, '读取 WPS 授权状态失败') as Partial<WpsAuthorizationRequiredResponse>;
        setSync(null);
        replaceReviews([]);
        setWpsAuthorizeUrl(typeof body.authorizeUrl === 'string' ? body.authorizeUrl : '/api/wps/oauth/start');
        setError(typeof body.error === 'string' ? body.error : '请先连接有该表查看权限的 WPS 账号');
        setNotice('等待完成一次 WPS 用户授权；授权后会自动读取真实表格。');
        return;
      }
      const nextSync = await jsonResponse<SyncResponse>(response);
      setWpsAuthorizeUrl(null);
      setSync(nextSync);
      if (nextSync.reviews) {
        replaceReviews(nextSync.reviews);
        setNotice(`已同步并解析 ${nextSync.records.length} 条真实 WPS 记录。`);
        return;
      }
      if (nextSync.records.length === 0) {
        replaceReviews([]);
        setNotice('WPS 当前没有可分析的任务记录。');
        return;
      }
      setBusy(null);
      await analyzeRecords(nextSync.records, { force: false, preserveCurrent: false });
    } catch (loadError) {
      setSync(null);
      replaceReviews([]);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      syncInFlightRef.current = false;
      setBusy(null);
    }
  }, [analyzeRecords, replaceReviews]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void loadSource(), 0);
    const refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadSource();
    }, WPS_REFRESH_INTERVAL_MS);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
    };
  }, [loadSource]);

  useEffect(() => {
    if (!editingTarget && !materialPreviewTarget) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (materialPreviewTarget) {
        setMaterialPreviewTarget(null);
        return;
      }
      setEditingTarget(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [editingTarget, materialPreviewTarget]);

  const analyze = async () => {
    if (!sync?.records.length) return;
    await analyzeRecords(sync.records, { force: true, preserveCurrent: true });
  };

  const updateUnit = (
    reviewId: string,
    unitId: string,
    transform: (unit: GenerationUnit, review: TaskReview) => GenerationUnit,
  ) => {
    mutateReviews((current) => current.map((review) => review.source.recordId === reviewId
        ? { ...review, units: review.units.map((unit) => {
            if (unit.id !== unitId) return unit;
            const nextUnit = transform(unit, review);
            if (nextUnit !== unit && (nextUnit.logo.materialId !== unit.logo.materialId || nextUnit.sourceScope !== unit.sourceScope
              || nextUnit.instruction !== unit.instruction || nextUnit.layoutNote !== unit.layoutNote)) nextUnit.sourceAssessment = undefined;
            return nextUnit === unit ? unit : { ...nextUnit, confirmed: false };
          }) }
        : review));
  };

  const openArtwork = (reviewId: string, unitId: string) => {
    setEditingTarget({ reviewId, unitId });
  };

  const focusInlineUnit = (unitId: string) => {
    setFocusedUnitId(unitId);
    window.requestAnimationFrame(() => {
      const editor = document.querySelector<HTMLElement>(`[data-unit-editor="${CSS.escape(unitId)}"]`);
      editor?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      editor?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
    });
  };

  const changeSourceScope = (reviewId: string, unitId: string, nextScope: SourceScope) => {
    updateUnit(reviewId, unitId, (current, currentReview) => {
      if (nextScope === current.sourceScope) return current;
      const sourceMaterial = selectedMaterial(currentReview, current.logo.materialId);
      const sourceIsFinishedArtwork = nextScope === 'wholeImage' && current.textMode === 'keep';
      return {
        ...current,
        sourceScope: nextScope,
        logo: {
          ...current.logo,
          url: sourceIsFinishedArtwork ? sourceMaterial?.url ?? null : current.logo.url,
        },
        artworkDraft: sourceIsFinishedArtwork && sourceMaterial?.url
          ? createLegacyArtworkDraft(sourceMaterial.url)
          : current.artworkDraft,
        needsRegeneration: sourceIsFinishedArtwork ? false : Boolean(current.logo.url),
      };
    });
  };

  const selectLogo = (reviewId: string, unitId: string, materialId: string) => {
    updateUnit(reviewId, unitId, (unit, review) => {
      const material = selectedMaterial(review, materialId);
      if (!material) throw new Error(`素材不存在：${materialId}`);
      if (unit.logo.materialId === material.id) return unit;
      const sourceIsFinishedArtwork = unit.textMode === 'keep' && unit.sourceScope === 'wholeImage';
      return {
        ...unit,
        logo: {
          materialId: material.id,
          url: sourceIsFinishedArtwork ? material.url : unit.logo.url,
          name: material.name,
        },
        artworkDraft: sourceIsFinishedArtwork && material.url
          ? createLegacyArtworkDraft(material.url)
          : unit.artworkDraft,
        needsRegeneration: sourceIsFinishedArtwork ? false : Boolean(unit.logo.url),
      };
    });
  };

  const uploadUnitLogo = async (reviewId: string, unitId: string, file: File | null) => {
    if (!file) return;
    setBusy(`upload:${unitId}`);
    setError(null);
    try {
      const uploaded = await uploadLogo(file);
      updateUnit(reviewId, unitId, (unit) => ({
        ...unit,
        logo: { ...unit.logo, url: uploaded.url, name: uploaded.originalName },
        artworkDraft: createLegacyArtworkDraft(uploaded.url),
        needsRegeneration: false,
      }));
      openArtwork(reviewId, unitId);
      setNotice(`${file.name} 已上传；请在表格中核对完整制作图案后人工确认。`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setBusy(null);
    }
  };

  const prepareUnitArtwork = async (review: TaskReview, unit: GenerationUnit) => {
    const primaryMaterial = selectedMaterial(review, unit.logo.materialId);
    if (!primaryMaterial) {
      setError(`${unitLabel(unit)} 还没有指定主要图形素材。`);
      return;
    }
    const primaryUrl = primaryMaterial.url ?? unit.logo.url;
    if (!primaryUrl) {
      setError('当前选中的素材没有可用原图。请先在审核窗口上传高清素材。');
      return;
    }
    const requestFingerprint = artworkRecipeFingerprint(unit);
    setBusy(`prepare:${unit.id}`);
    setError(null);
    try {
      const image = await logoInputImage(primaryUrl, primaryMaterial.name || '图1.png');
      const primaryMaterialIndex = review.source.materials.findIndex((candidate) => candidate.id === primaryMaterial.id);
      if (primaryMaterialIndex < 0) throw new Error(`主要素材不属于当前 WPS 记录：${primaryMaterial.id}`);
      const referenceMaterials = [...new Set(unit.referenceMaterialIds)]
        .filter((materialId) => materialId !== primaryMaterial.id)
        .map((materialId) => selectedMaterial(review, materialId))
        .filter((material): material is NonNullable<typeof material> => material !== null);
      if (referenceMaterials.length > 1) {
        throw new Error(`当前模型路线最多同时使用 1 张额外参考图，当前需要 ${referenceMaterials.length} 张；请先精简参考关系`);
      }
      const referenceImages = await Promise.all(referenceMaterials.map(async (material) => {
        const url = material.url;
        if (!url) throw new Error(`${material.name} 没有可供模型使用的原图`);
        const materialIndex = review.source.materials.findIndex((candidate) => candidate.id === material.id);
        if (materialIndex < 0) throw new Error(`参考素材不属于当前 WPS 记录：${material.id}`);
        return {
          label: `图${materialIndex + 1}`,
          image: await logoInputImage(url, material.name || `图${materialIndex + 1}.png`),
        };
      }));
      const canonicalPrompt = buildCanonicalArtworkModelPrompt({
        sourceRequirementText: review.source.requirementText,
        instruction: unit.instruction,
        exactText: unit.textMode === 'replace' ? unit.exactText : '',
        layoutNote: unit.layoutNote,
        sourceScope: unit.sourceScope, sourceAssessment: unit.sourceAssessment,
        primaryImageLabel: `图${primaryMaterialIndex + 1}`,
        referenceImageLabels: referenceImages.map((reference) => reference.label),
      });
      const result = await jsonResponse<ArtworkPreparationResponse>(await fetchApi('/api/task-review/artwork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceRequirementText: review.source.requirementText,
          instruction: unit.instruction,
          exactText: unit.textMode === 'replace' ? unit.exactText : '',
          layoutNote: unit.layoutNote,
          image,
          primaryImageLabel: `图${primaryMaterialIndex + 1}`,
          referenceImages,
          enhancementMode: 'auto',
          sourceScope: unit.sourceScope, sourceAssessment: unit.sourceAssessment,
          processingRoute: unit.processingRoute ?? 'auto',
          expectedPromptVersion: canonicalPrompt.version,
          expectedPromptHash: canonicalPrompt.promptHash,
        }),
      }));
      const latestAfterPreparation = reviewsRef.current
        .find((candidate) => candidate.source.recordId === review.source.recordId)
        ?.units.find((candidate) => candidate.id === unit.id);
      if (!latestAfterPreparation || artworkRecipeFingerprint(latestAfterPreparation) !== requestFingerprint) {
        throw new Error('云端处理期间制作要求或素材已变化，这次结果没有覆盖当前图案，请重新处理');
      }
      const uploadedGraphics = await Promise.all(artworkGraphicLayers(result.draft).map(async (graphic, index) => {
        const preparedGraphic = await uploadLogo(await dataUrlFile(
          graphic.sourceUrl,
          `${unit.id}-graphic-${index + 1}.png`,
        ));
        const preparedRecolorMask = graphic.recolorMaskUrl
          ? await uploadLogo(await dataUrlFile(
              graphic.recolorMaskUrl,
              `${unit.id}-recolor-mask-${index + 1}.png`,
            ))
          : null;
        return {
          ...graphic,
          sourceUrl: preparedGraphic.url,
          recolorMaskUrl: preparedRecolorMask?.url ?? null,
        } satisfies ArtworkGraphicLayer;
      }));
      const draft: ArtworkDraft = {
        ...result.draft,
        graphic: uploadedGraphics[0],
        extraGraphics: uploadedGraphics.slice(1),
      };
      const flattenedArtwork = await uploadLogo(await artworkPngFile(draft, `${unit.id}-artwork.png`));
      const latestBeforeCommit = reviewsRef.current
        .find((candidate) => candidate.source.recordId === review.source.recordId)
        ?.units.find((candidate) => candidate.id === unit.id);
      if (!latestBeforeCommit || artworkRecipeFingerprint(latestBeforeCommit) !== requestFingerprint) {
        throw new Error('图案上传期间制作要求或素材已变化，这次结果没有覆盖当前图案，请重新处理');
      }
      updateUnit(review.source.recordId, unit.id, (current) => ({
        ...preparedArtworkUnit(current, requestFingerprint, {
          draft,
          url: flattenedArtwork.url,
          name: flattenedArtwork.originalName,
        }),
      }));
      setEditingTarget({ reviewId: review.source.recordId, unitId: unit.id });
      setNotice(`${unitLabel(unit)} 已走“${result.preprocessing.route.label}”路线：${result.preprocessing.route.reasons.join('；')}`);
    } catch (generationError) {
      setError(generationError instanceof Error ? generationError.message : String(generationError));
    } finally {
      setBusy(null);
    }
  };

  const saveArtwork = async (
    reviewId: string,
    unitId: string,
    draft: ArtworkDraft,
  ) => {
    setBusy(`save-artwork:${unitId}`);
    setError(null);
    try {
      draft = await persistArtworkLayerAssets(draft);
      const uploaded = await uploadLogo(await artworkPngFile(draft, `${unitId}-artwork.png`));
      const latest = reviewsRef.current
        .find((candidate) => candidate.source.recordId === reviewId)
        ?.units.find((candidate) => candidate.id === unitId);
      if (!latest) throw new Error(`找不到需要保存的图案：${reviewId}/${unitId}`);
      const savedExactText = artworkDraftExactText(draft);
      updateUnit(reviewId, unitId, (current) => editedArtworkUnit(
        savedExactText ? {
          ...current,
          textMode: 'replace',
          exactText: savedExactText,
        } : current,
        {
          draft,
          url: uploaded.url,
          name: uploaded.originalName,
        },
      ));
      setEditingTarget(null);
      setNotice(`${unitLabel(latest)} 的 Logo、文字和排版已保存；请在表格中看图确认。`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      throw saveError;
    } finally {
      setBusy(null);
    }
  };

  const confirmUnit = (review: TaskReview, unit: GenerationUnit) => {
    const issues = unitReviewIssues(review, unit);
    if (issues.length > 0) {
      setError(`${unitLabel(unit)} 仍不能确认：${issues.join('；')}`);
      focusInlineUnit(unit.id);
      return;
    }
    mutateReviews((current) => current.map((item) => item.source.recordId === review.source.recordId
      ? { ...item, units: item.units.map((candidate) => candidate.id === unit.id
        ? { ...candidate, confirmed: true }
        : candidate) }
      : item));
    setEditingTarget(null);
    setError(null);
    setNotice(`${unitLabel(unit)} 的完整制作图案已人工确认。修改任一字段会自动取消确认。`);
  };

  const createBatch = async () => {
    setBusy('create');
    setError(null);
    try {
      let production = await jsonResponse<WpsProductionState>(await fetchApi('/api/wps-production', { cache: 'no-store' }));
      production = await jsonResponse<WpsProductionState>(await fetchApi('/api/wps-production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'importReviews', expectedRevision: production.revision, reviews }),
      }));
      const confirmedUnits = reviews.flatMap((review) => review.units.filter((unit) => unit.confirmed));
      for (const unit of confirmedUnits) {
        if (!unit.logo.url) throw new Error(`${unitLabel(unit)} 缺少已确认的透明素材 URL`);
        let productionUnit = production.units.find((candidate) => candidate.id === unit.id);
        if (!productionUnit || productionUnit.route === 'blocked') throw new Error(`${unitLabel(unit)} 的生产路线仍未确定`);
        if (!productionUnit.gateA) {
          production = await jsonResponse<WpsProductionState>(await fetchApi('/api/wps-production', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'confirmPlan', expectedRevision: production.revision, unitId: unit.id, actor: '当前操作员' }),
          }));
          productionUnit = production.units.find((candidate) => candidate.id === unit.id)!;
        }
        if (!productionUnit.artwork) {
          production = await jsonResponse<WpsProductionState>(await fetchApi('/api/wps-production', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'submitArtwork',
              expectedRevision: production.revision,
              unitId: unit.id,
              url: unit.logo.url,
              name: unit.logo.name || `${unit.id}.png`,
              service: 'manual-upload',
              requestSummary: `从任务预检导入已人工确认的完整透明 PNG；原处理路线：${productionUnit.route}`,
              estimatedCostCny: 0,
            }),
          }));
          productionUnit = production.units.find((candidate) => candidate.id === unit.id)!;
        }
        if (!productionUnit.gateB) {
          production = await jsonResponse<WpsProductionState>(await fetchApi('/api/wps-production', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'confirmArtwork', expectedRevision: production.revision, unitId: unit.id, actor: '当前操作员' }),
          }));
        }
      }
      setNotice(`已导入 ${production.mockupVersions.length} 个效果图版本；正反面单元会合并成一张客户图。`);
      router.push('/wps-production');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(null);
    }
  };

  const rows = useMemo(() => reviews.flatMap((review) => review.units.map((unit, index) => ({ review, unit, index }))), [reviews]);
  const confirmedCount = rows.filter(({ unit }) => unit.confirmed).length;
  const pendingCount = rows.length - confirmedCount;
  const visibleGroups = useMemo(() => taskReviewDisplayGroups(reviews, filter), [reviews, filter]);
  const editingRow = editingTarget
    ? rows.find(({ review, unit }) => review.source.recordId === editingTarget.reviewId && unit.id === editingTarget.unitId) ?? null
    : null;
  const materialPreview = materialPreviewTarget ? (() => {
    const review = reviews.find((candidate) => candidate.source.recordId === materialPreviewTarget.reviewId);
    const material = review?.source.materials.find((candidate) => candidate.id === materialPreviewTarget.materialId);
    const unit = materialPreviewTarget.unitId
      ? review?.units.find((candidate) => candidate.id === materialPreviewTarget.unitId)
      : null;
    return review && material ? { review, material, unit: unit ?? null } : null;
  })() : null;
  const canCreate = confirmedCount > 0
    && !analysisProgress.active;

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="task-review-page batch-review-page">
        <header className="batch-review-heading">
          <div>
            <span className="batch-review-eyebrow">WPS 批量效果图</span>
            <h1>一张表，直接把图案处理完</h1>
            <p>素材、原文和 AI 理解留在原位；选择来源、修改要求、决定路线和处理图案都在对应子行完成。</p>
          </div>
          <div className="batch-review-heading-actions">
            <span className={sync?.mode === 'live' ? 'live' : ''}>● WPS {sync ? '真实表已连接' : '等待连接'} · {sync?.records.length ?? 0} 条记录</span>
            {sync?.sourceUrl && <Link href={sync.sourceUrl} target="_blank">打开原表 ↗</Link>}
            <button className="button secondary" disabled={busy !== null || analysisProgress.active} type="button" onClick={() => void loadSource()}>{busy === 'sync' ? '同步中…' : '重新同步'}</button>
          </div>
        </header>

        <section className="batch-review-toolbar">
          <div className="batch-review-tabs" aria-label="任务筛选">
            {([['all', `全部 ${rows.length}`], ['confirmed', `图案已确认 ${confirmedCount}`], ['pending', `图案待处理 ${pendingCount}`]] as [ReviewFilter, string][]).map(([value, label]) => (
              <button aria-pressed={filter === value} className={filter === value ? 'active' : ''} key={value} type="button" onClick={() => setFilter(value)}>{label}</button>
            ))}
          </div>
          <div className="batch-review-progress" aria-label={`已确认 ${confirmedCount} / ${rows.length} 个完整图案`}>
            <span>已确认 {confirmedCount} / {rows.length} 个完整图案</span>
            <i><b style={{ width: `${rows.length > 0 ? (confirmedCount / rows.length) * 100 : 0}%` }} /></i>
          </div>
          <button className="batch-review-reanalyze" disabled={!sync?.records.length || busy !== null || analysisProgress.active} type="button" onClick={() => void analyze()}>{analysisProgress.active ? `逐条分析中 ${analysisProgress.completed}/${analysisProgress.total}` : '重新分析全部任务'}</button>
        </section>

        <section className="batch-review-notice"><strong>✓ 表格负责判断与处理；生成后的大画布只负责 Logo、文字和排版精修。</strong><span>原文不折叠</span></section>
        <p className="batch-review-live-message" aria-live="polite">{notice}</p>
        {error && <div className="error-banner batch-review-error" role="alert"><span>{error}</span>{wpsAuthorizeUrl && <a className="button primary" href={wpsAuthorizeUrl}>连接 WPS</a>}<button type="button" onClick={() => setError(null)}>关闭</button></div>}

        <div className="batch-review-table-wrap">
          <table className="batch-review-table" aria-label="WPS 完整制作图案批量审核表">
            <colgroup><col className="batch-review-col-context" /><col className="batch-review-col-artwork" /><col className="batch-review-col-mapping" /></colgroup>
            <thead><tr><th>任务理解区 · 原始证据与 AI 理解</th><th>完整制作图案（必须确认）</th><th>衣服与位置</th></tr></thead>
            {visibleGroups.map(({ review, units }, visibleGroupIndex) => {
              const confirmedInRecord = review.units.filter((unit) => unit.confirmed).length;
              const recordNumber = reviews.findIndex((candidate) => candidate.source.recordId === review.source.recordId) + 1;
              return (
                <tbody className="batch-review-record-group" data-record-id={review.source.recordId} key={review.source.recordId}>
                  {units.map((unit, visibleIndex) => {
                    const originalIndex = review.units.findIndex((candidate) => candidate.id === unit.id);
                    const material = selectedMaterial(review, unit.logo.materialId);
                    const materialIndex = material ? review.source.materials.findIndex((candidate) => candidate.id === material.id) : -1;
                    const sourcePreview = material?.previewUrl ?? material?.url ?? null;
                    const status = artworkStatus(unit);
                    const product = unit.productCode ? productByCode(unit.productCode) : null;
                    const hasUsableSource = Boolean(material?.url);
                    const issues = unitReviewIssues(review, unit);
                    const generating = busy === `prepare:${unit.id}`;
                    const uploading = busy === `upload:${unit.id}`;
                    const completeModelRoute = predictsCompleteModelRoute(review, unit);
                    const selectedProcessingRoute = unit.processingRoute ?? 'auto';
                    const canonicalModelPrompt = canonicalModelPromptForUnit(review, unit);
                    const modelReferenceMaterials = completeModelRoute
                      ? indexedReviewMaterials(review, unit.referenceMaterialIds)
                      : [];
                    const modelTextSegments = completeModelRoute
                      ? understoodComposition(review, unit).textSegments
                      : [];
                    return (
                      <tr className={unit.confirmed ? 'confirmed' : 'pending'} key={`${review.source.recordId}:${unit.id}`}>
                        {visibleIndex === 0 && <td className="batch-review-context" rowSpan={units.length}>
                          <div className="batch-review-record-heading">
                            <div><span>任务 {String(recordNumber).padStart(2, '0')}</span><strong>{review.source.customerId} · {review.source.revision}</strong><small>{review.source.productStyleText}</small></div>
                            <b>{confirmedInRecord === review.units.length ? '全部已确认' : `待确认 ${review.units.length - confirmedInRecord}`}</b>
                          </div>
                          <section className="batch-review-evidence-row batch-review-materials">
                            <header><strong>WPS 素材</strong><span>{review.source.materials.length} 张</span></header>
                            <div>{review.source.materials.map((sourceMaterial, sourceIndex) => { const preview = sourceMaterial.previewUrl ?? sourceMaterial.url; return <button aria-haspopup="dialog" aria-label={`放大查看图${sourceIndex + 1}`} className="batch-review-material-preview" key={sourceMaterial.id} title={`${sourceMaterial.description}（点击查看大图）`} type="button" onClick={() => setMaterialPreviewTarget({ reviewId: review.source.recordId, materialId: sourceMaterial.id, unitId: null })}>{preview ? <Image alt={sourceMaterial.description} fill priority={visibleGroupIndex === 0 && sourceIndex === 0} sizes="70px" src={preview} unoptimized /> : <b>图{sourceIndex + 1}</b>}<span>图{sourceIndex + 1}</span></button>; })}</div>
                          </section>
                          <section className="batch-review-evidence-row batch-review-raw">
                            <header><strong>WPS 需求原文</strong><span>完整展示</span></header>
                            <p>{review.source.requirementText}</p>
                          </section>
                          <section className="batch-review-understanding">
                            <header><div><strong>AI 对整条需求的理解</strong><span>{review.summary}</span></div><small>逐条可修改</small></header>
                            <div className="batch-review-understanding-list">{review.units.map((understoodUnit, understoodIndex) => {
                              const composition = understoodComposition(review, understoodUnit);
                              return <article key={understoodUnit.id}><b>{understoodIndex + 1}</b><div><strong>{unitPlacementLabel(understoodUnit)}：{composition.description}</strong><span>{composition.summary.join(' ｜ ')} · {unitScope(understoodUnit).shortLabel}</span></div><button type="button" onClick={() => focusInlineUnit(understoodUnit.id)}>修改</button></article>;
                            })}</div>
                          </section>
                        </td>}
                        <td className="batch-review-artwork-child">
                          <div className="batch-review-artwork-heading">
                            <div><small>图案 {originalIndex + 1}{unit.artworkDraft ? ` · 上次实际路线：${routeLabel(unit)}` : ''}</small><strong>{unit.garmentLabel} · {unit.variantLabel}</strong></div>
                            <div className="batch-review-artwork-heading-controls">
                              <label className={(unit.processingRoute ?? 'auto') === 'auto' ? 'batch-review-inline-route' : 'batch-review-inline-route manual'}>
                                <span>{(unit.processingRoute ?? 'auto') === 'auto' ? '处理路线' : '人工指定'}</span>
                                <select aria-label={`${unitLabel(unit)}处理路线`} value={unit.processingRoute ?? 'auto'} onChange={(event) => updateUnit(review.source.recordId, unit.id, (current) => ({
                                  ...current,
                                  processingRoute: event.target.value as ArtworkProcessingRouteMode,
                                  needsRegeneration: Boolean(current.logo.url),
                                }))}>{PROCESSING_ROUTE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
                              </label>
                              {completeModelRoute && <span className="batch-review-route-prediction">预计：模型一体生成</span>}
                              <span className={`batch-review-artwork-state ${status.className}`}>{status.label}</span>
                            </div>
                          </div>

                          <div className={focusedUnitId === unit.id ? 'batch-review-inline-editor focused' : 'batch-review-inline-editor'} data-unit-editor={unit.id}>
                            {unit.logo.url && <button aria-haspopup={!unit.needsRegeneration ? 'dialog' : undefined} aria-label={`查看${unitLabel(unit)}的完整制作图案`} className={unit.needsRegeneration ? 'batch-review-final-artwork stale' : 'batch-review-final-artwork'} type="button" onClick={() => unit.needsRegeneration ? focusInlineUnit(unit.id) : openArtwork(review.source.recordId, unit.id)}><span><Image alt={`${unitLabel(unit)}完整制作图案`} fill sizes="118px" src={unit.logo.url} unoptimized /></span><div><strong>{unit.needsRegeneration ? '上一版完整图案' : '完整制作图案'}</strong><small>{status.description}</small></div></button>}

                            <div className={completeModelRoute ? 'batch-review-inline-recipe complete-model' : 'batch-review-inline-recipe'}>
                              {completeModelRoute ? <div className="batch-review-model-evidence-strip">
                                <button aria-haspopup="dialog" aria-label={`放大查看${material?.name ?? '主要素材'}`} className="batch-review-model-evidence" type="button" onClick={() => material && setMaterialPreviewTarget({ reviewId: review.source.recordId, materialId: material.id, unitId: unit.id })}>
                                  <span>{sourcePreview ? <Image alt={`${material?.description ?? '主要素材'}，必须进入成品`} fill sizes="74px" src={sourcePreview} unoptimized /> : <b>无图</b>}</span>
                                  <div><small>内容源 · 必须进入成品</small><strong>{materialIndex >= 0 ? `图${materialIndex + 1}` : '主要素材待确认'}</strong></div>
                                </button>
                                {modelReferenceMaterials.map(({ material: referenceMaterial, label }) => {
                                  const preview = referenceMaterial.previewUrl ?? referenceMaterial.url;
                                  return <button aria-haspopup="dialog" aria-label={`放大查看${label}排版参考`} className="batch-review-model-evidence reference" key={referenceMaterial.id} type="button" onClick={() => setMaterialPreviewTarget({ reviewId: review.source.recordId, materialId: referenceMaterial.id, unitId: unit.id })}>
                                    <span>{preview ? <Image alt={`${label}，仅参考字形和排版`} fill sizes="74px" src={preview} unoptimized /> : <b>{label}</b>}</span>
                                    <div><small>风格参考 · 不复制背景</small><strong>{label}</strong></div>
                                  </button>;
                                })}
                                {modelTextSegments.length > 0 && <label className="batch-review-model-exact-text"><small>准确文字 · 作为骨架输入</small><input aria-label={`${unitLabel(unit)}准确文字`} value={unit.exactText} onChange={(event) => updateUnit(review.source.recordId, unit.id, (current) => ({ ...current, exactText: event.target.value, needsRegeneration: Boolean(current.logo.url) }))} /><span>{modelTextSegments.map((text) => `“${text}”`).join(' · ')}</span></label>}
                                <div className="batch-review-model-output"><small>一次输出</small><strong>一张完整图案</strong><span>不做机械分层拼接</span></div>
                              </div> : <div className="batch-review-recipe-composition">
                                <button aria-haspopup="dialog" aria-label={`放大查看${material?.name ?? '主要素材'}`} className="batch-review-recipe-source" type="button" onClick={() => material && setMaterialPreviewTarget({ reviewId: review.source.recordId, materialId: material.id, unitId: unit.id })}>{sourcePreview ? <Image alt={`${material?.description ?? '主要素材'}，仅作为制作来源`} fill sizes="82px" src={sourcePreview} unoptimized /> : <b>来源待确认</b>}<i>{materialIndex >= 0 ? `图${materialIndex + 1}` : '未选图'} · {unitScope(unit).shortLabel}</i></button>
                                {unit.textMode === 'replace' && <><b className="batch-review-recipe-plus">＋</b><label className="batch-review-inline-text"><span>准确文字</span><input aria-label={`${unitLabel(unit)}准确文字`} value={unit.exactText} onChange={(event) => updateUnit(review.source.recordId, unit.id, (current) => ({ ...current, exactText: event.target.value, needsRegeneration: Boolean(current.logo.url) }))} /></label></>}
                                <div className="batch-review-recipe-summary"><strong>{artworkType(unit)}</strong><small>{unit.layoutNote || unitScope(unit).label}</small></div>
                              </div>}

                              <div className="batch-review-inline-fields">
                                <label className="instruction"><span>制作要求</span><textarea aria-label={`${unitLabel(unit)}制作要求`} rows={2} value={unit.instruction} onChange={(event) => updateUnit(review.source.recordId, unit.id, (current) => ({ ...current, instruction: event.target.value, needsRegeneration: Boolean(current.logo.url) }))} /></label>
                                <label><span>主要素材</span><select aria-label={`${unitLabel(unit)}主要素材`} value={unit.logo.materialId ?? ''} onChange={(event) => selectLogo(review.source.recordId, unit.id, event.target.value)}><option disabled value="">请选择素材…</option>{review.source.materials.map((sourceMaterial, sourceIndex) => <option key={sourceMaterial.id} value={sourceMaterial.id}>图{sourceIndex + 1} · {sourceMaterial.description}</option>)}</select></label>
                                <label><span>素材范围</span><select aria-label={`${unitLabel(unit)}素材范围`} value={unit.sourceScope} onChange={(event) => changeSourceScope(review.source.recordId, unit.id, event.target.value as SourceScope)}>{SOURCE_SCOPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                              </div>
                            </div>

                            {(completeModelRoute || selectedProcessingRoute === 'auto') ? <div className="batch-review-model-brief" aria-label={`${unitLabel(unit)}完整模型提示词`}>
                              <div><b>{completeModelRoute ? '实际提交给 Seedream 的完整提示词' : '模型一体生成兜底提示词'}</b><span>{canonicalModelPrompt ? `${canonicalModelPrompt.version} · ${canonicalModelPrompt.promptHash}` : '主要素材待确认'}</span></div>
                              {!completeModelRoute && <small>当前预计先走组件处理；只有服务端画质判断改走模型一体生成时，才会原样提交下面这份完整提示词。</small>}
                              {canonicalModelPrompt && <div className="batch-review-model-input-map">{canonicalModelPrompt.imageMapping.map((mapping) => <span className={mapping.role} key={`${mapping.sourceLabel}:${mapping.modelInputLabel}`}><b>WPS {mapping.sourceLabel}</b><i>→</i><b>模型输入{mapping.modelInputLabel}</b><small>{mapping.role === 'content' ? '必须进入成品' : '仅作风格/排版参考'}</small></span>)}</div>}
                              <p>{canonicalModelPrompt?.prompt ?? '请先选择主要素材，系统才能生成并锁定最终制作要求。'}</p>
                            </div> : <div className="batch-review-component-plan" aria-label={`${unitLabel(unit)}组件处理方案`}>
                              <b>组件处理</b>
                              <div>{plannedComponentSummary(review, unit).map((summary) => <span key={summary}>{summary}</span>)}</div>
                            </div>}
                            {unit.artworkDraft?.preprocessing.processingRoute && <p className="batch-review-route-result"><b>上次处理：</b>{routeLabel(unit)} · {unit.artworkDraft.preprocessing.routeReasons?.join('；')}</p>}
                            {unit.ambiguities.length > 0 && <div className="batch-review-inline-ambiguities"><strong>模型不确定项</strong>{unit.ambiguities.map((ambiguity) => <span key={ambiguity}>{ambiguity}</span>)}</div>}
                            {!hasUsableSource && <p className="task-review-source-warning">当前主要素材没有可用原图。请更换素材或直接上传完整图案。</p>}
                            {unit.needsRegeneration && unit.logo.url && <p className="task-review-stale-warning">制作要求、素材或路线已修改；上一版候选仍保留，但重新处理前不能确认。</p>}
                            {issues.length > 0 && <ul className="batch-review-inline-issues">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}

                            <div className="batch-review-artwork-actions">
                              <label className="batch-review-upload-artwork">{uploading ? '上传中…' : '已有成品，直接上传'}<input accept="image/png,image/jpeg,image/webp" disabled={busy !== null} type="file" onChange={(event) => void uploadUnitLogo(review.source.recordId, unit.id, event.target.files?.[0] ?? null)} /></label>
                              <button className="batch-review-generate-artwork" disabled={busy !== null || !unit.logo.materialId || !hasUsableSource} type="button" onClick={() => void prepareUnitArtwork(review, unit)}>{generating ? '正在判断路线并处理…' : unit.needsRegeneration ? '按新要求重新处理' : unit.logo.url ? '重新处理图案' : '处理图案'}</button>
                              {unit.logo.url && !unit.needsRegeneration && <button aria-haspopup="dialog" className={unit.confirmed ? 'batch-review-open-artwork confirmed' : 'batch-review-open-artwork'} type="button" onClick={() => openArtwork(review.source.recordId, unit.id)}>{unit.confirmed ? '查看已确认图案' : '调整图案'}</button>}
                              {unit.logo.url && !unit.needsRegeneration && !unit.confirmed && <button className="batch-review-confirm-artwork" disabled={!canConfirmUnit(review, unit) || busy !== null} type="button" onClick={() => confirmUnit(review, unit)}>确认图案</button>}
                            </div>
                          </div>
                        </td>
                        <td className="batch-review-mapping-cell">
                          <span>对应效果图</span>
                          <label><span>衣服款式</span><select aria-label={`${unitLabel(unit)}衣服款式`} value={product?.code ?? ''} onChange={(event) => updateUnit(review.source.recordId, unit.id, (current) => ({ ...current, productCode: event.target.value || null }))}><option value="">请选择实际衣服…</option>{PRODUCTS.map((candidate) => <option key={candidate.code} value={candidate.code}>{candidate.code} · {candidate.name}</option>)}</select></label>
                          <label><span>制作位置</span><select aria-label={`${unitLabel(unit)}制作位置`} value={unit.placement ?? ''} onChange={(event) => updateUnit(review.source.recordId, unit.id, (current) => ({ ...current, placement: (event.target.value || null) as PlacementKey | null }))}><option value="">请选择位置…</option>{(Object.entries(PLACEMENT_LABELS) as [PlacementKey, string][]).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </table>
          {visibleGroups.length === 0 && busy === null && !analysisProgress.active && <div className="batch-review-empty">当前筛选下没有任务。</div>}
          {rows.length === 0 && (busy !== null || analysisProgress.active) && <div className="batch-review-empty">{analysisProgress.active ? `正在逐条分析 WPS 任务 ${analysisProgress.completed}/${analysisProgress.total}…` : '正在同步 WPS 任务…'}</div>}
        </div>

        <footer className="task-review-gate batch-review-gate"><div><strong>已确认 {confirmedCount} / {rows.length} 张制作图案</strong><span>{analysisProgress.active ? `正在逐条分析源任务 ${analysisProgress.completed}/${analysisProgress.total}；已完成的行会立即显示。` : pendingCount > 0 ? `另外 ${pendingCount} 张图案可稍后处理，不阻塞已确认任务。` : rows.length > 0 ? '全部制作图案均已人工确认。' : '还没有可确认的制作图案。'}</span></div><button className="button primary" disabled={!canCreate || busy !== null} type="button" onClick={() => void createBatch()}>{busy === 'create' ? '正在导入生产台…' : `把已确认的 ${confirmedCount} 个图案导入生产台`}</button></footer>
      </main>

      {editingRow && (() => {
        const { review, unit } = editingRow;
        const draft = unit.artworkDraft ?? (unit.logo.url ? createLegacyArtworkDraft(unit.logo.url) : null);
        if (!draft) return null;
        return (
          <TaskReviewArtworkEditor
            initialDraft={draft}
            originalRequirement={review.source.requirementText}
            saving={busy === `save-artwork:${unit.id}`}
            title={`${unitLabel(unit)} · ${unitPlacementLabel(unit)}`}
            onCancel={() => setEditingTarget(null)}
            onSave={(nextDraft) => saveArtwork(review.source.recordId, unit.id, nextDraft)}
          />
        );
      })()}
      {materialPreview && (() => {
        const { review, material, unit } = materialPreview;
        const preview = material.url ?? material.previewUrl;
        const materialIndex = review.source.materials.findIndex((candidate) => candidate.id === material.id);
        const isSelected = unit?.logo.materialId === material.id;
        return (
          <div className="task-review-material-lightbox" role="presentation" onMouseDown={() => setMaterialPreviewTarget(null)}>
            <section aria-label={`放大查看${material.name}`} aria-modal="true" className="task-review-material-dialog" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
              <header><div><span>WPS 原始素材</span><h2>图{materialIndex + 1} · {material.name}</h2></div><button aria-label="关闭素材大图" type="button" onClick={() => setMaterialPreviewTarget(null)}>×</button></header>
              <div className="task-review-material-large">{preview ? <Image alt={material.description} fill sizes="min(900px, 92vw)" src={preview} unoptimized /> : <strong>该素材没有可预览图片</strong>}</div>
              <footer><div><strong>{material.description}</strong><span>点击缩略图只会打开此大图，不会改变已生成的图案。</span></div>{unit && <button className="button primary" disabled={isSelected} type="button" onClick={() => {
                selectLogo(review.source.recordId, unit.id, material.id);
                setMaterialPreviewTarget(null);
              }}>{isSelected ? '当前主要素材' : '设为主要素材'}</button>}</footer>
            </section>
          </div>
        );
      })()}
    </div>
  );
}
