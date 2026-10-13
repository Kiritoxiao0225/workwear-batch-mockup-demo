'use client';

/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- Fabric crop and preview images use runtime data or signed URLs. */

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ensureAsset, garmentAiFetch, type CutoutMeta, type CutoutMode } from '@/lib/garment-editor/client-api';
import {
  CustomizationState,
  CanvasElement,
  ElementType,
  FONTS,
  MOCKUP_TEXT_PLACEHOLDER,
  type MockupPlacement,
} from '@/lib/garment-editor/mockup-types';
import TextInspector from '@/components/garment-editor/TextInspector';
import {
  Upload, Type, ChevronRight, Sparkles, X, Download, Maximize2,
  Crop, Plus, Copy, Trash2,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import ReactCrop, { type Crop as CropArea, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import {
  DEFAULT_LOGO_EDGE_CLEANUP_STRENGTH,
  erodedLogoMaskDataUrl,
  logoImageProvenanceKey,
  logoSourceImageForCutout,
  readCompressedImageFile,
  rememberLogoCutoutSource,
  inspectLogoBackground,
  type LogoBackgroundKind,
} from '@/components/garment-editor/image-editing';
import { useToast } from '@/components/garment-editor/ui/toast';
import type { MockupStateUpdate } from '@/components/garment-editor/useMockupUndoHistory';
import {
  appendElementForCurrentGeneration,
  appendGeneratedBackForCurrentGeneration,
  mergeElementImagesForCurrentGeneration,
} from '@/lib/garment-editor/mockup-async-state';
import { removeElementFromCustomizationState } from '@/lib/garment-editor/mockup-measurements';
import {
  MOCKUP_PLACEMENT_LABELS,
  assignDecorationToProduct,
  copyMockupElement,
  defaultDecorationProductId,
  defaultPlacementForDecoration,
  placementMatchesProductFace,
  placementsForProductFace,
  productFace,
  setDecorationPlacement,
  setMockupProductFace,
} from '@/lib/garment-editor/mockup-element-relations';
import {
  applyLogoRedrawResult,
  type LogoRedrawApplyTarget,
} from '@/lib/garment-editor/mockup-logo-redraw';
import { garmentLabel, imageKey, type ArtworkHandoff } from '@/lib/garment-editor/artwork-handoff';

/** One studio result as the garment editor's "my artworks" strip lists it. */
interface StudioArtwork {
  id?: string;
  caseId: string;
  text: string;
  status: string;
  error: string | null;
  createdAt: string;
  transparent: boolean | null;
  asset: string | null;
}
export interface PendingArtwork { url: string; handoff: ArtworkHandoff | null }
export interface ArtworkReplaceSource { elementId: string; label: string; image: string }

interface SidebarProps {
  state: CustomizationState;
  stateGeneration: number;
  getStateGeneration: () => number;
  getCurrentState: () => CustomizationState;
  getCanvasDimensions: () => { width: number; height: number };
  onUpdateState: (update: MockupStateUpdate) => void;
  onCollapse?: () => void;
  isLoggedIn?: boolean;
  selectedElementId: string | null;
  selectedElementType: ElementType | null;
  onSelectElement: (id: string | null, type: ElementType | null) => void;
  onResetCanvas: () => void;
  activeTab: SidebarTab;
  /** Left panel content (lists, uploads) is portaled here; the inspector shows the selection. */
  panelHost: HTMLElement | null;
  inspectorHost: HTMLElement | null;
  onStartTextEditing?: (elementId: string) => void;
  /** Leave for the artwork studio; with a logo, the result replaces that logo when it comes back. */
  onOpenArtworkStudio?: (replace?: ArtworkReplaceSource) => void;
  /** A studio result brought back through /garment-mockup?artwork=… */
  pendingArtwork?: PendingArtwork | null;
  onPendingArtworkHandled?: () => void;
}
export type SidebarTab = 'garment' | 'logo' | 'text' | 'layers';
type CutoutStatus =
  | { state: 'running'; startedAt: number; mode: CutoutMode }
  | { state: 'done'; meta?: CutoutMeta; ms: number }
  | { state: 'failed'; error: string };

const LOGO_COLORS = [
  { hex: '#ffffff', label: '白色' },
  { hex: '#000000', label: '黑色' },
  { hex: '#ef4444', label: '红色' },
  { hex: '#f59e0b', label: '金色' },
  { hex: '#3b82f6', label: '蓝色' },
];

const DEFAULT_ARC_BEND = 60;
const newId = () => Math.random().toString(36).slice(2, 11);

function productLabelForElements(
  elements: CanvasElement[],
  productId: string
) {
  const products = elements.filter(element => element.type === 'product');
  const index = products.findIndex(product => product.id === productId);
  const product = index >= 0 ? products[index] : null;
  if (!product) return '未归属';
  return `产品 ${index + 1} · ${productFace(product) === 'back' ? '背面' : '正面'}`;
}

function omitElementId<T>(
  valuesByElementId: Record<string, T>,
  elementId: string
) {
  if (!(elementId in valuesByElementId)) return valuesByElementId;
  const remainingValuesByElementId = { ...valuesByElementId };
  delete remainingValuesByElementId[elementId];
  return remainingValuesByElementId;
}

function ClientPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;
  return createPortal(children, (document.getElementById('garment-editor-portals') || document.body));
}

function imageNaturalDimensions(source: string, subjectLabel: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    const timeout = window.setTimeout(() => {
      image.src = '';
      reject(new Error(`读取${subjectLabel}尺寸超过 15 秒，未应用生成结果`));
    }, 15_000);
    image.onload = () => {
      window.clearTimeout(timeout);
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error(`${subjectLabel}缺少有效尺寸，未应用生成结果`));
        return;
      }
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error(`${subjectLabel}图片读取失败，未应用生成结果`));
    };
    image.src = source;
  });
}

async function mockupAiErrorMessage(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === 'string' && body.error.trim()
      ? body.error
      : fallback;
  } catch {
    return fallback;
  }
}

export default function Sidebar({ state, stateGeneration, getStateGeneration, getCurrentState, getCanvasDimensions, onUpdateState, isLoggedIn, selectedElementId, selectedElementType, onSelectElement, activeTab, panelHost, inspectorHost, onStartTextEditing, onOpenArtworkStudio, pendingArtwork, onPendingArtworkHandled }: SidebarProps) {
  const productInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const [aiProcessingType, setAiProcessingType] = useState<'removeBackground' | 'generateBack' | null>(null);
  const [previewingElement, setPreviewingElement] = useState<string | null>(null);
  const [artworks, setArtworks] = useState<StudioArtwork[] | null>(null);
  const [artworksReadAt, setArtworksReadAt] = useState(0);
  // Credits a click may cost, shown on the paid buttons; internal accounts are exempt.
  const [prices, setPrices] = useState<{ exempt: boolean; cutout: number; back: number } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/garment-mockup/prices', { cache: 'no-store' })
      .then(async response => { if (response.ok && alive) setPrices(await response.json()); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const costHint = (credits: number) => (prices && !prices.exempt ? <small className="gme-cost">最多 {credits} 积分</small> : null);
  const [artworksError, setArtworksError] = useState('');
  const handledPendingArtworkRef = useRef<PendingArtwork | null>(null);

  const [croppingElementId, setCroppingElementId] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropArea>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const cropImageRef = useRef<HTMLImageElement>(null);
  const logoColorRequestTokensRef = useRef(new Map<string, symbol>());
  const [logoImageBeforeCutoutById, setLogoImageBeforeCutoutById] = useState<Record<string, string>>({});
  const [logoMaskByElementId, setLogoMaskByElementId] = useState<Record<string, { mask: string; original: string }>>({});
  const [logoErosionStrengthByElementId, setLogoErosionStrengthByElementId] = useState<Record<string, number>>({});
  const [logoErosionUpdatePending, setLogoErosionUpdatePending] = useState(false);
  const [canvasImageOperationPending, setCanvasImageOperationPending] = useState(false);
  const latestMaskAppliedImageRef = useRef(new Map<string, string>());
  const cutoutSourceByAppliedImageKeyRef = useRef(new Map<string, Map<string, string>>());
  const logoErosionUpdateSequenceRef = useRef(0);
  const logoErosionUpdatePendingRef = useRef(false);
  const canvasImageOperationTokensRef = useRef(new Set<symbol>());
  const mountedRef = useRef(true);
  const [cutoutStatusById, setCutoutStatusById] = useState<Record<string, CutoutStatus>>({});
  const [nowTick, setNowTick] = useState(0);
  // Auto cutout runs from upload callbacks; the ref sees the busy flag without a stale closure.
  const aiBusyRef = useRef(false);
  const [backgroundKindById, setBackgroundKindById] = useState<Record<string, { key: string; kind: LogoBackgroundKind }>>({});

  const rememberMaskAppliedImage = useCallback((elementId: string, image: string, sourceImage: string) => {
    latestMaskAppliedImageRef.current.set(elementId, image);
    const sourceByAppliedImageKey = cutoutSourceByAppliedImageKeyRef.current.get(elementId);
    if (sourceByAppliedImageKey) {
      rememberLogoCutoutSource(sourceByAppliedImageKey, image, sourceImage);
      return;
    }
    const newSourceByAppliedImageKey = new Map<string, string>();
    rememberLogoCutoutSource(newSourceByAppliedImageKey, image, sourceImage);
    cutoutSourceByAppliedImageKeyRef.current.set(elementId, newSourceByAppliedImageKey);
  }, []);

  const invalidateLogoCutoutCachesAfterManualImageEdit = (elementId: string) => {
    logoErosionUpdateSequenceRef.current += 1;
    logoErosionUpdatePendingRef.current = false;
    setLogoErosionUpdatePending(false);
    setLogoImageBeforeCutoutById(previousImages =>
      omitElementId(previousImages, elementId)
    );
    setLogoMaskByElementId(previousMasks =>
      omitElementId(previousMasks, elementId)
    );
    setLogoErosionStrengthByElementId(previousStrengths =>
      omitElementId(previousStrengths, elementId)
    );
    latestMaskAppliedImageRef.current.delete(elementId);
    cutoutSourceByAppliedImageKeyRef.current.delete(elementId);
  };

  useEffect(() => {
    // Strict Mode mounts, unmounts and mounts again; mark the live mount every time.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const beginCanvasImageOperation = useCallback(() => {
    const token = Symbol('canvas-image-operation');
    canvasImageOperationTokensRef.current.add(token);
    setCanvasImageOperationPending(true);
    return token;
  }, []);

  const finishCanvasImageOperation = useCallback((token: symbol) => {
    canvasImageOperationTokensRef.current.delete(token);
    if (mountedRef.current) {
      setCanvasImageOperationPending(canvasImageOperationTokensRef.current.size > 0);
    }
  }, []);

  useEffect(() => {
    latestMaskAppliedImageRef.current.clear();
    cutoutSourceByAppliedImageKeyRef.current.clear();
    logoErosionUpdateSequenceRef.current += 1;
    logoErosionUpdatePendingRef.current = false;
    canvasImageOperationTokensRef.current.clear();
    setLogoErosionUpdatePending(false);
    setCanvasImageOperationPending(false);
    setLogoMaskByElementId({});
    setLogoImageBeforeCutoutById({});
    setLogoErosionStrengthByElementId({});
    setCutoutStatusById({});
    aiBusyRef.current = false;
    setAiProcessingType(null);
  }, [stateGeneration]);

  // Tell the user up front whether removing the background is free: border check only, no request.
  const logoImagesKey = state.elements.filter(element => element.type === 'logo').map(element => `${element.id}:${logoImageProvenanceKey(element.image ?? '')}`).join('|');
  useEffect(() => {
    let active = true;
    for (const logo of getCurrentState().elements) {
      if (logo.type !== 'logo' || !logo.image) continue;
      const key = logoImageProvenanceKey(logo.image);
      if (backgroundKindById[logo.id]?.key === key) continue;
      void inspectLogoBackground(logo.image).then(kind => {
        if (active) setBackgroundKindById(previous => ({ ...previous, [logo.id]: { key, kind } }));
      });
    }
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Recheck only when a logo image changes.
  }, [logoImagesKey]);

  const cutoutRunning = Object.values(cutoutStatusById).some(status => status.state === 'running');
  useEffect(() => {
    if (!cutoutRunning) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [cutoutRunning]);

  const operationIsCurrent = useCallback(
    (operationGeneration: number) =>
      mountedRef.current && getStateGeneration() === operationGeneration,
    [getStateGeneration]
  );

  // ---- Derived data ----
  const products = state.elements.filter(e => e.type === 'product');
  const logos = state.elements.filter(e => e.type === 'logo');
  const texts = state.elements.filter(e => e.type === 'text');
  const selectedElement = selectedElementId
    ? state.elements.find(e => e.id === selectedElementId)
    : null;
  const selectedLogoForImageEdit =
    selectedElementType === 'logo' &&
    selectedElement?.type === 'logo' &&
    selectedElement.image
      ? selectedElement
      : null;
  const selectedLogoForImageEditId = selectedLogoForImageEdit?.id ?? null;
  const selectedLogoErosionStrength = selectedLogoForImageEditId
    ? logoErosionStrengthByElementId[selectedLogoForImageEditId] ?? DEFAULT_LOGO_EDGE_CLEANUP_STRENGTH
    : DEFAULT_LOGO_EDGE_CLEANUP_STRENGTH;
  const selectedProductForBackGeneration =
    selectedElementType === 'product' &&
    selectedElement?.type === 'product' &&
    productFace(selectedElement) === 'front' &&
    selectedElement.image
      ? selectedElement
      : null;
  const selectedProductHasGeneratedBack = selectedProductForBackGeneration
    ? products.some(
        product =>
          product.face === 'back' &&
          product.backOfElementId === selectedProductForBackGeneration.id
      )
    : false;
  // Leaving mid-operation would drop a result the canvas is waiting for.
  const artworkStudioLocked =
    aiProcessingType !== null ||
    logoErosionUpdatePending ||
    canvasImageOperationPending;

  const openArtworkStudio = (replace?: ArtworkReplaceSource) => {
    if (artworkStudioLocked) {
      toast.info('请等待当前图片处理完成后再去生成图稿');
      return;
    }
    if (!isLoggedIn) {
      toast.info('请先登录后再使用 AI 生成');
      return;
    }
    onOpenArtworkStudio?.(replace);
  };

  const logoLabel = (elements: CanvasElement[], id: string) =>
    `Logo ${elements.filter(element => element.type === 'logo').findIndex(element => element.id === id) + 1}`;

  /**
   * Put a studio result on the canvas. "add" follows the upload rule (or the target chosen
   * in the studio); "replace" keeps the old logo's position, size and garment.
   */
  const placeArtwork = useCallback(async (
    source: string,
    target:
      | { mode: 'add'; ownerId?: string | null; placement?: MockupPlacement }
      | { mode: 'replace'; elementId: string; expectedImageKey?: string }
  ) => {
    const operationGeneration = getStateGeneration();
    const operationToken = beginCanvasImageOperation();
    try {
      const image = await ensureAsset(source, '图稿生成结果.png');
      if (!operationIsCurrent(operationGeneration)) return;
      const current = getCurrentState();
      if (target.mode === 'replace') {
        const logo = current.elements.find(element =>
          element.id === target.elementId &&
          element.type === 'logo' &&
          !!element.image &&
          (!target.expectedImageKey || imageKey(element.image) === target.expectedImageKey)
        );
        if (logo?.image) {
          const owner = logo.placedOnProductId
            ? current.elements.find(element => element.id === logo.placedOnProductId && element.type === 'product')
            : null;
          const [sourceDimensions, generatedDimensions, ownerDimensions] = await Promise.all([
            imageNaturalDimensions(logo.image, '当前 Logo'),
            imageNaturalDimensions(image, '图稿'),
            owner?.image && (!logo.transform || !logo.relativeTransform)
              ? imageNaturalDimensions(owner.image, '归属衣服')
              : Promise.resolve(undefined),
          ]);
          if (!operationIsCurrent(operationGeneration)) return;
          const latest = getCurrentState();
          const replaceTarget: LogoRedrawApplyTarget = {
            mode: 'replace',
            elementId: logo.id,
            expectedImage: logo.image,
            expectedPlacementState: {
              placedOnProductId: logo.placedOnProductId,
              placement: logo.placement,
              transform: logo.transform ? { ...logo.transform } : undefined,
              relativeTransform: logo.relativeTransform ? { ...logo.relativeTransform } : undefined,
            },
            operationGeneration,
          };
          const next = applyLogoRedrawResult({
            state: latest,
            target: replaceTarget,
            currentGeneration: getStateGeneration(),
            generatedImage: image,
            generatedSourceImage: image,
            sourceDimensions,
            generatedDimensions,
            ownerDimensions,
            canvasDimensions: getCanvasDimensions(),
          });
          onUpdateState({ elements: next.elements });
          invalidateLogoCutoutCachesAfterManualImageEdit(logo.id);
          setCutoutStatusById(previous => omitElementId(previous, logo.id));
          onSelectElement(logo.id, 'logo');
          toast.success(`${logoLabel(latest.elements, logo.id)} 已替换，位置和大小不变，可撤销`);
          return;
        }
      }
      const elements = current.elements;
      const requestedOwner = target.mode === 'add' && target.ownerId
        ? elements.find(element => element.id === target.ownerId && element.type === 'product')
        : null;
      const ownerId = requestedOwner ? requestedOwner.id : defaultDecorationProductId(elements, selectedElementId);
      const owner = ownerId ? elements.find(element => element.id === ownerId) : null;
      const requestedPlacement = target.mode === 'add' ? target.placement : undefined;
      const placement = !owner
        ? 'custom'
        : requestedPlacement && requestedOwner && placementMatchesProductFace(requestedPlacement, productFace(owner))
          ? requestedPlacement
          : defaultPlacementForDecoration('logo', productFace(owner));
      const elementId = newId();
      onUpdateState(previousState =>
        appendElementForCurrentGeneration(
          previousState,
          { id: elementId, type: 'logo', image, placedOnProductId: ownerId, placement },
          operationGeneration,
          getStateGeneration()
        )
      );
      onSelectElement(elementId, 'logo');
      const where = owner ? `${garmentLabel(elements, owner.id)} · ${MOCKUP_PLACEMENT_LABELS[placement]}` : '画布中间，未归属衣服';
      toast[target.mode === 'replace' ? 'info' : 'success'](
        target.mode === 'replace'
          ? `原 Logo 已变化，已作为新 Logo 放到${where}`
          : `已放到${where}，可撤销`
      );
    } catch (error) {
      console.error('Place artwork failed:', error);
      if (operationIsCurrent(operationGeneration)) {
        toast.error(error instanceof Error ? error.message : '图稿放到画布失败，请重试');
      }
    } finally {
      finishCanvasImageOperation(operationToken);
    }
  }, [beginCanvasImageOperation, finishCanvasImageOperation, getCanvasDimensions, getCurrentState, getStateGeneration, onSelectElement, onUpdateState, operationIsCurrent, selectedElementId, toast]);

  // A result brought back from the studio lands where the user chose before leaving.
  useEffect(() => {
    if (!pendingArtwork || handledPendingArtworkRef.current === pendingArtwork) return;
    handledPendingArtworkRef.current = pendingArtwork;
    const { url, handoff } = pendingArtwork;
    void placeArtwork(url, handoff?.replace
      ? { mode: 'replace', elementId: handoff.replace.elementId, expectedImageKey: handoff.replace.imageKey }
      : { mode: 'add', ownerId: handoff?.ownerId ?? null, placement: handoff?.placement }
    ).finally(() => onPendingArtworkHandled?.());
  }, [onPendingArtworkHandled, pendingArtwork, placeArtwork]);

  // "My artworks": the newest studio results, refreshed while one is still being made.
  const showArtworks = activeTab === 'logo' && !!panelHost;
  const artworksRunning = !!artworks?.some(artwork => artwork.status === 'queued' || artwork.status === 'running');
  useEffect(() => {
    if (!showArtworks) return;
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch('/api/batch/api/studio/results', { cache: 'no-store' });
        const body = await response.json() as { items?: StudioArtwork[]; error?: string };
        if (!response.ok || !Array.isArray(body.items)) throw new Error(body.error || '图稿读取失败');
        if (alive) { setArtworks(body.items); setArtworksReadAt(Date.now()); setArtworksError(''); }
      } catch (error) {
        if (alive) setArtworksError(error instanceof Error ? error.message : '图稿读取失败');
      }
    };
    void load();
    const timer = artworksRunning
      ? window.setInterval(() => { if (!document.hidden) void load(); }, 4000)
      : 0;
    return () => { alive = false; window.clearInterval(timer); };
  }, [artworksRunning, showArtworks]);

  const updateElement = (id: string, updates: Partial<CanvasElement>) => {
    onUpdateState(previousState => {
      if (!previousState.elements.some(element => element.id === id)) return {};
      return {
        elements: previousState.elements.map(element =>
          element.id === id ? { ...element, ...updates } : element
        ),
      };
    });
  };

  const deleteElement = (id: string) => {
    onUpdateState(previousState =>
      removeElementFromCustomizationState(previousState, id)
    );
    setLogoImageBeforeCutoutById(previousImages =>
      omitElementId(previousImages, id)
    );
    setLogoMaskByElementId(previousMasks =>
      omitElementId(previousMasks, id)
    );
    setLogoErosionStrengthByElementId(previousStrengths =>
      omitElementId(previousStrengths, id)
    );
    latestMaskAppliedImageRef.current.delete(id);
    cutoutSourceByAppliedImageKeyRef.current.delete(id);
    setCutoutStatusById(previous => omitElementId(previous, id));
    setBackgroundKindById(previous => omitElementId(previous, id));
    if (selectedElementId === id) onSelectElement(null, null);
  };

  const copyElement = (id: string) => {
    const source = state.elements.find(e => e.id === id);
    if (!source) return;
    const copiedElementId = newId();
    onUpdateState(previousState => {
      if (!previousState.elements.some(element => element.id === id)) return {};
      return {
        elements: copyMockupElement(
          previousState.elements,
          id,
          copiedElementId
        ),
      };
    });
    onSelectElement(copiedElementId, source.type);
  };

  const updateDecorationOwner = (id: string, productElementId: string | null) => {
    onUpdateState(previousState => ({
      elements: assignDecorationToProduct(
        previousState.elements,
        id,
        productElementId
      ),
    }));
  };

  const updateDecorationPlacement = (
    id: string,
    placement: CanvasElement['placement']
  ) => {
    if (!placement) return;
    onUpdateState(previousState => ({
      elements: setDecorationPlacement(previousState.elements, id, placement),
    }));
  };

  const updateProductFace = (id: string, face: 'front' | 'back') => {
    onUpdateState(previousState => ({
      elements: setMockupProductFace(previousState.elements, id, face),
    }));
  };

  // ---- File processors ----
  const readProductImageFile = useCallback((file: File) => {
    const operationGeneration = stateGeneration;
    const elementId = newId();
    const operationToken = beginCanvasImageOperation();
    readCompressedImageFile(file, 1500)
      .then(base64 => {
        if (!operationIsCurrent(operationGeneration)) return;
        const element: CanvasElement = {
          id: elementId,
          type: 'product',
          image: base64,
          face: 'front',
        };
        onUpdateState(previousState =>
          appendElementForCurrentGeneration(
            previousState,
            element,
            operationGeneration,
            getStateGeneration()
          )
        );
        onSelectElement(elementId, 'product');
      })
      .catch(err => {
        console.error('Product image read failed:', err);
        if (operationIsCurrent(operationGeneration)) {
          toast.error(err instanceof Error ? err.message : '产品图读取失败，请重试');
        }
      })
      .finally(() => finishCanvasImageOperation(operationToken));
  }, [beginCanvasImageOperation, finishCanvasImageOperation, getStateGeneration, onSelectElement, onUpdateState, operationIsCurrent, stateGeneration, toast]);

  const readLogoImageFile = useCallback((file: File) => {
    const operationGeneration = stateGeneration;
    const elementId = newId();
    const operationToken = beginCanvasImageOperation();
    readCompressedImageFile(file, 1000)
      .then(base64 => {
        if (!operationIsCurrent(operationGeneration)) return;
        const currentElements = getCurrentState().elements;
        const ownerId = defaultDecorationProductId(
          currentElements,
          selectedElementId
        );
        const owner = ownerId
          ? currentElements.find(candidate => candidate.id === ownerId)
          : null;
        const element: CanvasElement = {
          id: elementId,
          type: 'logo',
          image: base64,
          placedOnProductId: ownerId,
          placement: owner
            ? defaultPlacementForDecoration('logo', productFace(owner))
            : 'custom',
        };
        onUpdateState(previousState =>
          appendElementForCurrentGeneration(
            previousState,
            element,
            operationGeneration,
            getStateGeneration()
          )
        );
        onSelectElement(elementId, 'logo');
      })
      .catch(err => {
        console.error('Logo image read failed:', err);
        if (operationIsCurrent(operationGeneration)) {
          toast.error(err instanceof Error ? err.message : 'Logo 读取失败，请重试');
        }
      })
      .finally(() => finishCanvasImageOperation(operationToken));
  }, [beginCanvasImageOperation, finishCanvasImageOperation, getCurrentState, getStateGeneration, onSelectElement, onUpdateState, operationIsCurrent, selectedElementId, stateGeneration, toast]);

  // ---- Paste handler ----
  // Paste an image anywhere outside a text field: the garment tab adds a garment, others a logo.
  useEffect(() => {
    const handleGlobalPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      const item = [...(event.clipboardData?.items ?? [])].find(entry => entry.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (!file) return;
      event.preventDefault();
      if (activeTab === 'garment') readProductImageFile(file);
      else readLogoImageFile(file);
    };
    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [activeTab, readLogoImageFile, readProductImageFile]);

  const addTextElement = () => {
    const id = newId();
    const currentElements = getCurrentState().elements;
    const ownerId = defaultDecorationProductId(currentElements, selectedElementId);
    const owner = ownerId ? currentElements.find(element => element.id === ownerId) : null;
    const element: CanvasElement = {
      id,
      type: 'text',
      text: MOCKUP_TEXT_PLACEHOLDER,
      fontFamily: FONTS[0].value,
      fontWeight: 'normal',
      fontStyle: 'normal',
      textUnderline: false,
      textAlign: 'center',
      textColor: '#000000',
      arcMode: 'none',
      arcBend: DEFAULT_ARC_BEND,
      placedOnProductId: ownerId,
      // On the garment, not the middle of the canvas: chest centre, or upper back on a back view.
      placement: owner ? (productFace(owner) === 'back' ? 'upper_back' : 'front_center') : 'custom',
    };
    onUpdateState(previousState => ({
      elements: [...previousState.elements, element],
    }));
    onSelectElement(id, 'text');
    onStartTextEditing?.(id);
  };

  const productOptionLabel = (productId: string) => {
    return productLabelForElements(state.elements, productId);
  };

  const decorationPlacementControls = (element: CanvasElement) => {
    if (element.type !== 'logo' && element.type !== 'text') return null;
    const owner = element.placedOnProductId
      ? products.find(product => product.id === element.placedOnProductId)
      : null;
    const placementOptions = owner
      ? placementsForProductFace(productFace(owner))
      : ['custom' as const];

    return (
      <div className="grid grid-cols-1 gap-2 rounded-xl border border-border bg-canvas/60 p-2.5">
        <label className="grid gap-1 text-[10px] font-bold text-ink-3">
          所属产品
          <select
            value={element.placedOnProductId ?? ''}
            onChange={(event) => updateDecorationOwner(
              element.id,
              event.target.value || null
            )}
            className="h-8 rounded-lg border border-border bg-white px-2 text-xs font-medium text-ink outline-none focus:border-brand-400"
          >
            <option value="">未归属</option>
            {products.map(product => (
              <option key={product.id} value={product.id}>
                {productOptionLabel(product.id)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[10px] font-bold text-ink-3">
          定制位置
          <select
            value={element.placement ?? 'custom'}
            disabled={!owner}
            onChange={(event) => updateDecorationPlacement(
              element.id,
              event.target.value as CanvasElement['placement']
            )}
            className="h-8 rounded-lg border border-border bg-white px-2 text-xs font-medium text-ink outline-none focus:border-brand-400 disabled:bg-border/40 disabled:text-ink-3"
          >
            {placementOptions.map(placement => (
              <option key={placement} value={placement}>
                {MOCKUP_PLACEMENT_LABELS[placement]}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[10px] leading-relaxed text-ink-3">
          {owner
            ? `当前属于${productOptionLabel(owner.id)}；拖到其他产品上松手即可切换。`
            : '当前未归属。请选择产品，或把它拖到一件产品上。'}
        </p>
      </div>
    );
  };

  // ---- AI Features ----
  const handleGenerateBack = async () => {
    if (!isLoggedIn) { toast.info('请先登录后再使用 AI 生成背面图功能'); return; }
    if (aiProcessingType || aiBusyRef.current) return;

    const frontProduct = selectedProductForBackGeneration;
    if (!frontProduct?.image) {
      toast.info('请先选择一张正面产品图');
      return;
    }
    const operationGeneration = stateGeneration;
    const sourceImage = frontProduct.image;
    const backElementId = newId();

    aiBusyRef.current = true;
    setAiProcessingType('generateBack');
    try {
      const res = await garmentAiFetch('/api/garment-mockup/generate-back', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base64Image: sourceImage,
          imageRef: frontProduct.imageRef,
        }),
      });
      if (!res.ok) {
        throw new Error(
          await mockupAiErrorMessage(res, 'AI 生成背面图失败，请稍后重试')
        );
      }
      const { image } = await res.json();
      const backElement: CanvasElement = {
        id: backElementId,
        type: 'product',
        image,
        face: 'back',
        backOfElementId: frontProduct.id,
      };
      if (!operationIsCurrent(operationGeneration)) return;
      onUpdateState(previousState =>
        appendGeneratedBackForCurrentGeneration(
          previousState,
          frontProduct.id,
          sourceImage,
          backElement,
          operationGeneration,
          getStateGeneration()
        )
      );
    } catch (err) {
      console.error('Generate back failed:', err);
      if (operationIsCurrent(operationGeneration)) {
        toast.error(
          err instanceof Error
            ? err.message
            : 'AI 生成背面图失败，请稍后重试'
        );
      }
    } finally {
      aiBusyRef.current = false;
      if (operationIsCurrent(operationGeneration)) {
        setAiProcessingType(null);
      }
    }
  };

  const removeLogoBackground = async (
    logoId: string,
    { mode = 'auto', auto = false }: { mode?: CutoutMode; auto?: boolean } = {}
  ) => {
    if (!isLoggedIn) { if (!auto) toast.info('请先登录后再去背景'); return; }
    if (aiBusyRef.current) { if (!auto) toast.info('请等待当前图片处理完成'); return; }

    const logo = getCurrentState().elements.find(
      element => element.id === logoId && element.type === 'logo'
    );
    if (!logo?.image) {
      if (!auto) toast.info('请先选择一个 Logo 再去背景');
      return;
    }
    const operationGeneration = stateGeneration;
    const displayedSourceImage = logo.image;
    const sameSessionSources = cutoutSourceByAppliedImageKeyRef.current.get(logo.id);
    const sourceFromSameSession = logoSourceImageForCutout(
      displayedSourceImage,
      sameSessionSources
    );
    const sameSessionSourceImage = sameSessionSources?.has(
      logoImageProvenanceKey(displayedSourceImage)
    )
      ? sourceFromSameSession
      : undefined;
    const cleanSourceImage = sameSessionSourceImage ?? logo.originalImage ??
      displayedSourceImage;
    const cleanSourceImageRef = sameSessionSourceImage
      ? undefined
      : logo.originalImage
        ? logo.originalImageRef
        : logo.imageRef;
    const erosionStrength =
      logoErosionStrengthByElementId[logo.id] ?? DEFAULT_LOGO_EDGE_CLEANUP_STRENGTH;
    aiBusyRef.current = true;
    setAiProcessingType('removeBackground');
    // eslint-disable-next-line react-hooks/purity -- Only called from click handlers, never while rendering.
    const startedAt = Date.now();
    setNowTick(startedAt);
    setCutoutStatusById(previous => ({ ...previous, [logo.id]: { state: 'running', startedAt, mode } }));

    try {
      const res = await garmentAiFetch('/api/garment-mockup/remove-bg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base64Image: cleanSourceImage,
          imageRef: cleanSourceImageRef,
          mode,
          elementId: logo.id,
        }),
      });
      if (!res.ok) {
        throw new Error(
          await mockupAiErrorMessage(res, '去背景失败，请稍后重试')
        );
      }
      const { mask, original, meta } = (await res.json()) as { mask: string; original: string; meta?: CutoutMeta };
      const image = await erodedLogoMaskDataUrl(
        mask,
        original,
        erosionStrength
      );

      if (!operationIsCurrent(operationGeneration)) return;
      const currentState = getCurrentState();
      const currentElement = currentState.elements.find(
        (element) => element.id === logo.id
      );
      if (
        currentElement?.type !== 'logo' ||
        currentElement.image !== displayedSourceImage
      ) {
        setCutoutStatusById(previous => omitElementId(previous, logo.id));
        return;
      }
      setCutoutStatusById(previous => ({ ...previous, [logo.id]: { state: 'done', meta, ms: Date.now() - startedAt } }));
      setLogoImageBeforeCutoutById(previousImages => ({
        ...previousImages,
        [logo.id]: cleanSourceImage,
      }));
      setLogoMaskByElementId(previousMasks => ({
        ...previousMasks,
        [logo.id]: { mask, original },
      }));
      setLogoErosionStrengthByElementId(previousStrengths => ({
        ...previousStrengths,
        [logo.id]: erosionStrength,
      }));
      rememberMaskAppliedImage(logo.id, image, cleanSourceImage);
      onUpdateState(previousState =>
        mergeElementImagesForCurrentGeneration(
          previousState,
          [{
            elementId: logo.id,
            elementType: 'logo',
            expectedImage: displayedSourceImage,
            image,
          }],
          operationGeneration,
          getStateGeneration()
        )
      );
    } catch (err) {
      console.error('Remove background failed:', err);
      const message = err instanceof Error ? err.message : '去背景失败，请稍后重试';
      if (operationIsCurrent(operationGeneration)) {
        setCutoutStatusById(previous => ({ ...previous, [logo.id]: { state: 'failed', error: message } }));
        if (auto) toast.info(`自动去背景未完成：${message}。可在右侧重试，原图已保留。`);
        else toast.error(message);
      }
    } finally {
      aiBusyRef.current = false;
      if (operationIsCurrent(operationGeneration)) {
        setAiProcessingType(null);
      }
    }
  };
  // Re-composite when erosion strength changes
  useEffect(() => {
    if (!selectedLogoForImageEditId) return;
    const cachedMask = logoMaskByElementId[selectedLogoForImageEditId];
    const expectedImage = latestMaskAppliedImageRef.current.get(
      selectedLogoForImageEditId
    );
    if (!cachedMask || !expectedImage) return;
    const cleanSourceImage = logoSourceImageForCutout(
      expectedImage,
      cutoutSourceByAppliedImageKeyRef.current.get(selectedLogoForImageEditId)
    );

    const operationGeneration = stateGeneration;
    const updateSequence = ++logoErosionUpdateSequenceRef.current;
    logoErosionUpdatePendingRef.current = true;
    setLogoErosionUpdatePending(true);
    let cancelled = false;
    const finishPendingUpdate = () => {
      if (logoErosionUpdateSequenceRef.current !== updateSequence) return;
      logoErosionUpdatePendingRef.current = false;
      if (mountedRef.current) setLogoErosionUpdatePending(false);
    };
    const timer = setTimeout(() => {
      void erodedLogoMaskDataUrl(
        cachedMask.mask,
        cachedMask.original,
        selectedLogoErosionStrength
      )
        .then(image => {
          if (
            cancelled ||
            logoErosionUpdateSequenceRef.current !== updateSequence ||
            !operationIsCurrent(operationGeneration)
          ) return;
          const currentState = getCurrentState();
          const currentElement = currentState.elements.find(
            (element) => element.id === selectedLogoForImageEditId
          );
          if (
            currentElement?.type !== 'logo' ||
            currentElement.image !== expectedImage
          ) {
            return;
          }
          onUpdateState(previousState =>
            mergeElementImagesForCurrentGeneration(
              previousState,
              [{
                elementId: selectedLogoForImageEditId,
                elementType: 'logo',
                expectedImage,
                image,
              }],
              operationGeneration,
              getStateGeneration()
            )
          );
          rememberMaskAppliedImage(
            selectedLogoForImageEditId,
            image,
            cleanSourceImage
          );
        })
        .catch(err => console.error('Logo erosion update failed:', err))
        .finally(finishPendingUpdate);
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      finishPendingUpdate();
    };
  }, [
    getCurrentState,
    getStateGeneration,
    logoMaskByElementId,
    onUpdateState,
    operationIsCurrent,
    rememberMaskAppliedImage,
    selectedLogoErosionStrength,
    selectedLogoForImageEditId,
    stateGeneration,
  ]);

  const handleUndoRemoveBackground = () => {
    const logo = selectedLogoForImageEdit;
    if (!logo?.image) {
      toast.info('请先选择一个 Logo');
      return;
    }
    const imageBeforeCutout = logoImageBeforeCutoutById[logo.id];
    if (!imageBeforeCutout) return;
    onUpdateState(previousState =>
      mergeElementImagesForCurrentGeneration(
        previousState,
        [{
          elementId: logo.id,
          elementType: 'logo',
          expectedImage: logo.image,
          image: imageBeforeCutout,
        }],
        stateGeneration,
        getStateGeneration()
      )
    );
    setLogoImageBeforeCutoutById(previousImages =>
      omitElementId(previousImages, logo.id)
    );
    setLogoMaskByElementId(previousMasks =>
      omitElementId(previousMasks, logo.id)
    );
    setLogoErosionStrengthByElementId(previousStrengths =>
      omitElementId(previousStrengths, logo.id)
    );
    latestMaskAppliedImageRef.current.delete(logo.id);
    cutoutSourceByAppliedImageKeyRef.current.delete(logo.id);
  };

  const handleLocalRemoveBackground = async () => {
    if (aiProcessingType || aiBusyRef.current) return;

    const logo = selectedLogoForImageEdit;
    if (!logo?.image) {
      toast.info('请先选择一个 Logo 再去白底');
      return;
    }
    const operationGeneration = stateGeneration;
    const sourceImage = logo.image;
    aiBusyRef.current = true;
    setAiProcessingType('removeBackground');

    const removeWhiteBg = (src: string, tolerance = 30): Promise<string> =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            if (r > 255 - tolerance && g > 255 - tolerance && b > 255 - tolerance) {
              const whiteness = Math.min(r, g, b);
              const alpha = Math.round((1 - (whiteness - (255 - tolerance)) / tolerance) * 255);
              data[i + 3] = Math.max(0, alpha);
            }
          }
          ctx.putImageData(imageData, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = reject;
        img.src = src;
      });

    try {
      const image = await removeWhiteBg(sourceImage);
      if (!operationIsCurrent(operationGeneration)) return;
      const currentElement = getCurrentState().elements.find(
        (element) => element.id === logo.id
      );
      if (
        currentElement?.type !== 'logo' ||
        currentElement.image !== sourceImage
      ) {
        return;
      }
      setLogoImageBeforeCutoutById(previousImages => ({
        ...previousImages,
        [logo.id]: sourceImage,
      }));
      setLogoMaskByElementId(previousMasks =>
        omitElementId(previousMasks, logo.id)
      );
      setLogoErosionStrengthByElementId(previousStrengths =>
        omitElementId(previousStrengths, logo.id)
      );
      latestMaskAppliedImageRef.current.delete(logo.id);
      cutoutSourceByAppliedImageKeyRef.current.delete(logo.id);
      onUpdateState(previousState =>
        mergeElementImagesForCurrentGeneration(
          previousState,
          [{
            elementId: logo.id,
            elementType: 'logo',
            expectedImage: sourceImage,
            image,
          }],
          operationGeneration,
          getStateGeneration()
        )
      );
    } catch (err) {
      console.error('Local remove bg failed:', err);
      if (operationIsCurrent(operationGeneration)) {
        toast.error('本地抠图失败，请重试');
      }
    } finally {
      aiBusyRef.current = false;
      if (operationIsCurrent(operationGeneration)) {
        setAiProcessingType(null);
      }
    }
  };

  const handleDownloadImage = (element: CanvasElement) => {
    if (!element.image) return;
    const link = document.createElement('a');
    link.href = element.image;
    link.download = `${element.type}-${element.id}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const applyCrop = () => {
    if (!cropImageRef.current || !completedCrop || !croppingElementId) return;
    const croppingElement = state.elements.find(
      element => element.id === croppingElementId
    );
    const img = cropImageRef.current;
    const scaleX = img.naturalWidth / img.width;
    const scaleY = img.naturalHeight / img.height;
    const canvas = document.createElement('canvas');
    canvas.width = completedCrop.width * scaleX;
    canvas.height = completedCrop.height * scaleY;
    canvas.getContext('2d')!.drawImage(
      img,
      completedCrop.x * scaleX, completedCrop.y * scaleY,
      completedCrop.width * scaleX, completedCrop.height * scaleY,
      0, 0, canvas.width, canvas.height,
    );
    updateElement(croppingElementId, {
      image: canvas.toDataURL('image/png'),
      ...(croppingElement?.type === 'product'
        ? { garmentGeometry: undefined }
        : croppingElement?.type === 'logo'
          ? { originalImage: undefined, originalImageRef: undefined }
          : {}),
    });
    if (croppingElement?.type === 'logo') {
      invalidateLogoCutoutCachesAfterManualImageEdit(croppingElementId);
    }
    setCroppingElementId(null);
    setCrop(undefined);
    setCompletedCrop(undefined);
  };

  const applyLogoColor = async (id: string, color: string) => {
    const logoElement = getCurrentState().elements.find(e => e.id === id && e.type === 'logo');
    if (!logoElement?.image) return;
    const operationGeneration = stateGeneration;
    const sourceImage = logoElement.image;
    const requestToken = Symbol('logo-color');
    logoColorRequestTokensRef.current.set(id, requestToken);
    const requestIsCurrent = () =>
      operationIsCurrent(operationGeneration) &&
      logoColorRequestTokensRef.current.get(id) === requestToken;
    const operationToken = beginCanvasImageOperation();
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = sourceImage;
      await img.decode();
      if (!requestIsCurrent()) return;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('浏览器无法创建 Logo 换色画布');
      ctx.drawImage(img, 0, 0);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL('image/png');
      onUpdateState(previousState => {
        const merged = mergeElementImagesForCurrentGeneration(
          previousState,
          [{ elementId: id, elementType: 'logo', expectedImage: sourceImage, image }],
          operationGeneration,
          getStateGeneration()
        );
        if (!merged.elements) return merged;
        return {
          elements: merged.elements.map(element =>
            element.id === id && element.type === 'logo' && element.image === image
              ? {
                  ...element,
                  originalImage: undefined,
                  originalImageRef: undefined,
                }
              : element
          ),
        };
      });
      const updatedLogo = getCurrentState().elements.find(element => element.id === id);
      if (updatedLogo?.type === 'logo' && updatedLogo.image === image) {
        invalidateLogoCutoutCachesAfterManualImageEdit(id);
      }
    } catch (err) {
      console.error('Logo color update failed:', err);
      if (requestIsCurrent()) {
        toast.error('Logo 换色失败，原图已保留，请稍后重试');
      }
    } finally {
      if (logoColorRequestTokensRef.current.get(id) === requestToken) {
        logoColorRequestTokensRef.current.delete(id);
      }
      finishCanvasImageOperation(operationToken);
    }
  };

  const openFilePicker = (kind: 'product' | 'logo') =>
    (kind === 'product' ? productInputRef : logoInputRef).current?.click();
  const dropFile = (kind: 'product' | 'logo') => (event: React.DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    if (kind === 'product') readProductImageFile(file);
    else readLogoImageFile(file);
  };
  const engineLabel = (meta?: CutoutMeta) =>
    meta?.engine === 'meitu' ? '美图图形精细' : meta?.engine === 'volcengine' ? '火山标准' : '本地';
  const cutoutStatusText = (status: CutoutStatus) => {
    if (status.state === 'running') {
      const seconds = Math.max(0, (nowTick - status.startedAt) / 1000).toFixed(1);
      return `去背景中 ${seconds}s${status.mode === 'graphic' ? ' · 美图图形精细' : ''}`;
    }
    if (status.state === 'failed') return `去背景未完成：${status.error}`;
    const meta = status.meta, seconds = `${(status.ms / 1000).toFixed(1)}s`;
    if (!meta) return `已去背景 · ${seconds}`;
    if (meta.route === 'passthrough') return '自带透明背景，已跳过';
    if (meta.route === 'local_flat') return `已去背景 · 纯色底本地处理 · ${seconds}`;
    if (meta.route === 'cache') return `已去背景 · 复用同图结果（${engineLabel(meta)}）· 未扣费`;
    const fallback = meta.fallbackFrom ? `（${meta.fallbackFrom === 'volcengine' ? '火山' : '美图'}未完成，已自动换用）` : '';
    return `已去背景 · ${engineLabel(meta)}${fallback} · ${seconds}`;
  };
  // One short line for the list; the inspector shows the full status.
  const cutoutShortText = (status: CutoutStatus) => {
    if (status.state !== 'done') return cutoutStatusText(status);
    const meta = status.meta;
    if (meta?.route === 'passthrough') return '✓ 自带透明';
    if (meta?.route === 'local_flat') return '✓ 已去背景 · 本地';
    return `✓ 已去背景 · ${engineLabel(meta)}`;
  };
  const productIndex = (id: string) => products.findIndex(product => product.id === id);

  const garmentPanel = (
    <button type="button" className="gme-drop" onClick={() => openFilePicker('product')} onDrop={dropFile('product')} onDragOver={event => event.preventDefault()}>
      <Upload size={16} aria-hidden="true" />
      <span><b>上传本地衣服图</b><small>点击、拖入，或在此页粘贴</small></span>
    </button>
  );

  const batchAsset = (asset: string) => '/api/batch/' + asset;
  const elapsed = (from: string) => {
    // Measured at the last refresh, which runs every few seconds while something is being made.
    const seconds = Math.max(0, Math.round((artworksReadAt - Date.parse(from)) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const selectedLogoLabel = selectedLogoForImageEdit ? logoLabel(state.elements, selectedLogoForImageEdit.id) : '';
  const regenerateSelectedLogo = () => {
    if (!selectedLogoForImageEdit?.image) return;
    openArtworkStudio({ elementId: selectedLogoForImageEdit.id, label: selectedLogoLabel, image: selectedLogoForImageEdit.image });
  };
  const artworkTile = (artwork: StudioArtwork) => {
    const tag = artwork.transparent === false ? '有底色' : artwork.transparent ? '透明' : '';
    if (artwork.status === 'queued' || artwork.status === 'running') {
      return (
        <li key={artwork.id ?? artwork.caseId} className="gme-art is-running" title={artwork.text}>
          <i className="gme-spin" aria-hidden="true" /><small>{artwork.status === 'queued' ? '排队中' : `制作中 ${elapsed(artwork.createdAt)}`}</small>
        </li>
      );
    }
    if (!artwork.asset) {
      return (
        <li key={artwork.id ?? artwork.caseId} className="gme-art is-failed" title={artwork.error || artwork.text}>
          <small>未完成</small>
        </li>
      );
    }
    const url = batchAsset(artwork.asset);
    const image = <><img src={url} alt="" loading="lazy" />{tag && <i className="gme-art-tag">{tag}</i>}</>;
    // With a logo selected, a tile can replace it or be added beside it.
    return selectedLogoForImageEdit ? (
      <li key={artwork.id ?? artwork.caseId} className="gme-art gme-checker" title={artwork.text}>
        {image}
        <span className="gme-art-actions">
          <button type="button" disabled={!isLoggedIn || canvasImageOperationPending} aria-label={`用这张图稿替换${selectedLogoLabel}`}
            onClick={() => void placeArtwork(url, { mode: 'replace', elementId: selectedLogoForImageEdit.id })}>替换</button>
          <button type="button" disabled={!isLoggedIn || canvasImageOperationPending} aria-label="把这张图稿新增到画布"
            onClick={() => void placeArtwork(url, { mode: 'add' })}>新增</button>
        </span>
      </li>
    ) : (
      <li key={artwork.id ?? artwork.caseId}>
        <button type="button" className="gme-art gme-checker" title={artwork.text} aria-label={`放到衣服上：${artwork.text}`}
          disabled={!isLoggedIn || canvasImageOperationPending} onClick={() => void placeArtwork(url, { mode: 'add' })}>
          {image}
        </button>
      </li>
    );
  };
  const artworkSection = (
    <section className="gme-artworks" aria-label="我的图稿">
      <div className="gme-sec-head">
        <h3>我的图稿</h3>
        <button type="button" className="gme-link" disabled={artworkStudioLocked} onClick={() => openArtworkStudio()}>全部 →</button>
      </div>
      <ul className="gme-art-grid">
        <li>
          <button type="button" className="gme-art gme-art-new" disabled={artworkStudioLocked} onClick={() => openArtworkStudio()}>
            <Sparkles size={16} aria-hidden="true" /><b>AI 生成新 Logo</b>
          </button>
        </li>
        {(artworks ?? []).slice(0, 11).map(artworkTile)}
      </ul>
      {artworksError
        ? <p className="gme-hint">{artworksError}，稍后重新打开 Logo 面板可再试。</p>
        : <p className="gme-hint">{artworks === null
          ? '正在读取图稿…'
          : selectedLogoForImageEdit
            ? `在图稿生成里做的图都在这里。已选中${selectedLogoLabel}，可替换或新增。`
            : '在图稿生成里做的图都在这里，点一下放到当前衣服。'}</p>}
    </section>
  );

  const logoPanel = (
    <section className="gme-sec">
      <div className="gme-sec-head"><h3>Logo</h3><span>{logos.length} 个</span></div>
      <button type="button" className="gme-drop" onClick={() => openFilePicker('logo')} onDrop={dropFile('logo')} onDragOver={event => event.preventDefault()}>
        <Upload size={16} aria-hidden="true" />
        <span><b>拖入、粘贴或点击上传</b><small>放到当前衣服的默认位置，需要时再去背景</small></span>
      </button>
      {logos.length > 0 && (
        <ul className="gme-list">
          {logos.map((logo, index) => {
            const status = cutoutStatusById[logo.id];
            const kind = backgroundKindById[logo.id]?.kind;
            const needsButton = status?.state !== 'running' && status?.state !== 'done' && kind !== 'transparent';
            return (
              <li key={logo.id} className={`gme-row${selectedElementId === logo.id ? ' is-active' : ''}`}>
                <button type="button" className="gme-item" onClick={() => onSelectElement(logo.id, 'logo')}>
                  <span className="gme-thumb gme-checker"><img crossOrigin="anonymous" src={logo.image} alt="" /></span>
                  <span className="gme-item-text">
                    <b>Logo {index + 1}</b>
                    {status ? (
                      <small className={`gme-st gme-st-${status.state}`}>
                        {status.state === 'running' && <i className="gme-spin" aria-hidden="true" />}
                        {status.state === 'failed' ? '去背景未完成，可重试' : cutoutShortText(status)}
                      </small>
                    ) : kind === 'transparent' ? (
                      <small className="gme-st gme-st-done">✓ 自带透明</small>
                    ) : kind === 'flat' ? (
                      <small className="gme-st gme-st-hint">纯色底 · 去背景免费</small>
                    ) : (
                      <small>{logo.placedOnProductId ? productOptionLabel(logo.placedOnProductId) : '未归属'}</small>
                    )}
                  </span>
                </button>
                {needsButton && (
                  <button type="button" className="gme-row-action" disabled={aiProcessingType !== null}
                    onClick={() => { onSelectElement(logo.id, 'logo'); void removeLogoBackground(logo.id); }}>
                    {status?.state === 'failed' ? '重试' : '去背景'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {artworkSection}
    </section>
  );

  const textPanel = (
    <section className="gme-sec">
      <div className="gme-sec-head"><h3>文字</h3><span>{texts.length} 段</span></div>
      <button type="button" className="gme-drop gme-drop-sm" onClick={addTextElement}>
        <Plus size={15} aria-hidden="true" />
        <span><b>添加文字</b><small>加到当前衣服，右侧可改字体、颜色和弧度</small></span>
      </button>
      {texts.length > 0 && (
        <ul className="gme-list">
          {texts.map(text => (
            <li key={text.id}>
              <button type="button" className={`gme-item${selectedElementId === text.id ? ' is-active' : ''}`} onClick={() => onSelectElement(text.id, 'text')}>
                <span className="gme-thumb"><Type size={15} aria-hidden="true" /></span>
                <span className="gme-item-text">
                  <b>{text.text || '空文字'}</b>
                  <small>{text.placedOnProductId ? productOptionLabel(text.placedOnProductId) : '未归属'}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const panelContent = activeTab === 'garment' ? garmentPanel : activeTab === 'logo' ? logoPanel : activeTab === 'text' ? textPanel : null;

  const selectedCutout = selectedLogoForImageEditId ? cutoutStatusById[selectedLogoForImageEditId] : undefined;
  const selectedHasCutout = !!selectedLogoForImageEditId && (!!logoMaskByElementId[selectedLogoForImageEditId] || selectedCutout?.state === 'done');
  const selectedCutoutEngine = selectedCutout?.state === 'done' ? selectedCutout.meta : undefined;
  const cutoutSection = selectedLogoForImageEdit && (
    <section className="gme-insp-sec">
      <h4>去背景</h4>
      {selectedCutout?.state === 'running' && (
        <>
          <div className="gme-progress" aria-hidden="true"><i /></div>
          <p className="gme-insp-status is-running">{cutoutStatusText(selectedCutout)}</p>
          <p className="gme-hint">通常几秒内完成，可以先调位置。关闭页面不会重复扣费。</p>
        </>
      )}
      {selectedCutout?.state === 'done' && <p className="gme-insp-status is-done">✓ {cutoutStatusText(selectedCutout)}</p>}
      {selectedCutout?.state === 'failed' && <p className="gme-insp-status is-failed">{cutoutStatusText(selectedCutout)}</p>}
      {selectedCutout?.state !== 'running' && (
        selectedHasCutout && selectedCutoutEngine?.route !== 'passthrough' ? (
          <>
            <div className="gme-seg" role="group" aria-label="换一种去背景方式">
              {([['standard', '标准 · 火山', 'volcengine'], ['graphic', '图形精细 · 美图', 'meitu']] as const).map(([mode, label, engine]) => {
                const current = selectedCutoutEngine?.route !== 'local_flat' && selectedCutoutEngine?.engine === engine;
                return (
                  <button key={mode} type="button" aria-pressed={current} disabled={current || aiProcessingType !== null}
                    onClick={() => void removeLogoBackground(selectedLogoForImageEdit.id, { mode })}>
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="gme-hint">
              {selectedCutoutEngine?.route === 'local_flat'
                ? '纯色底已在本地免费处理。边缘不理想时，可选一种方式重做（扣 1 次积分）。'
                : '细字、多色图形边缘不干净时，换另一种方式重做一次（扣 1 次积分）。'}
            </p>
          </>
        ) : !selectedHasCutout && (
          <button type="button" className="gme-btn-primary" disabled={aiProcessingType !== null} onClick={() => void removeLogoBackground(selectedLogoForImageEdit.id)}>
            <Sparkles size={14} aria-hidden="true" />{selectedCutout?.state === 'failed' ? '重试去背景' : '去背景'}{prices && costHint(prices.cutout)}
          </button>
        )
      )}
      {selectedLogoForImageEditId && logoMaskByElementId[selectedLogoForImageEditId] && (
        <label className="gme-range">
          <span>去边强度<em>{selectedLogoErosionStrength}</em></span>
          <input
            type="range" min="0" max="100" value={selectedLogoErosionStrength}
            onChange={(event) => {
              const logoId = selectedLogoForImageEditId;
              if (!logoId) return;
              logoErosionUpdateSequenceRef.current += 1;
              logoErosionUpdatePendingRef.current = true;
              setLogoErosionUpdatePending(true);
              setLogoErosionStrengthByElementId(previousStrengths => ({
                ...previousStrengths,
                [logoId]: Number(event.target.value),
              }));
            }}
          />
          <small><span>保留细节</span><span>强力去边（细字慎用）</span></small>
        </label>
      )}
      <div className="gme-links">
        <button type="button" onClick={handleLocalRemoveBackground} disabled={aiProcessingType !== null}>只去掉白色（不调用 AI）</button>
        {selectedLogoForImageEditId && logoImageBeforeCutoutById[selectedLogoForImageEditId] && (
          <button type="button" onClick={handleUndoRemoveBackground}>恢复原图</button>
        )}
      </div>
    </section>
  );

  const elementTitle = !selectedElement ? '' : selectedElement.type === 'product'
    ? `衣服 ${productIndex(selectedElement.id) + 1} · ${productFace(selectedElement) === 'back' ? '背面' : '正面'}`
    : selectedElement.type === 'logo' ? `Logo ${logos.findIndex(logo => logo.id === selectedElement.id) + 1}` : '文字';
  const footer = selectedElement && (
    <div className="gme-insp-foot">
      <button type="button" onClick={() => copyElement(selectedElement.id)}><Copy size={14} aria-hidden="true" />复制</button>
      <button type="button" className="is-danger" onClick={() => deleteElement(selectedElement.id)}><Trash2 size={14} aria-hidden="true" />删除</button>
    </div>
  );

  const inspector = selectedElement && selectedElementType === selectedElement.type ? (
    <div className="gme-insp">
      <div className="gme-insp-head">
        <b>{elementTitle}</b>
        <button type="button" aria-label="关闭属性面板" onClick={() => onSelectElement(null, null)}><X size={16} /></button>
      </div>
      <div className="gme-insp-body">
        {selectedElement.type === 'product' && (
          <>
            <section className="gme-insp-sec">
              <div className="gme-preview"><img crossOrigin="anonymous" src={selectedElement.image} alt="衣服预览" /></div>
              <div className="gme-tools">
                <button type="button" onClick={() => { setCroppingElementId(selectedElement.id); setCrop(undefined); setCompletedCrop(undefined); }}><Crop size={14} aria-hidden="true" />裁剪</button>
              </div>
            </section>
            <section className="gme-insp-sec">
              <h4>这张图是</h4>
              <div className="gme-seg" role="group" aria-label="这张产品图片表示的面">
                {(['front', 'back'] as const).map(face => (
                  <button key={face} type="button" aria-pressed={productFace(selectedElement) === face} onClick={() => updateProductFace(selectedElement.id, face)}>
                    {face === 'front' ? '正面' : '背面'}
                  </button>
                ))}
              </div>
              <p className="gme-hint">只标记当前这张图，用于定制位置，不会替换图片。</p>
            </section>
            {selectedProductForBackGeneration && !selectedProductHasGeneratedBack && (
              <section className="gme-insp-sec">
                <h4>背面参考</h4>
                <button type="button" className="gme-btn" onClick={handleGenerateBack} disabled={aiProcessingType !== null}>
                  {aiProcessingType === 'generateBack'
                    ? <><i className="gme-spin" aria-hidden="true" />正在生成背面图…</>
                    : <><Sparkles size={14} aria-hidden="true" />AI 生成背面图{prices && costHint(prices.back)}</>}
                </button>
                <p className="gme-hint">没有背面素材时使用，生成结果仅作参考。</p>
              </section>
            )}
          </>
        )}
        {selectedElement.type === 'logo' && (
          <>
            <section className="gme-insp-sec">
              <div className="gme-preview gme-checker"><img crossOrigin="anonymous" src={selectedElement.image} alt="Logo 预览" /></div>
              <div className="gme-tools">
                <button type="button" onClick={() => setPreviewingElement(selectedElement.id)}><Maximize2 size={14} aria-hidden="true" />预览</button>
                <button type="button" onClick={() => { setCroppingElementId(selectedElement.id); setCrop(undefined); setCompletedCrop(undefined); }}><Crop size={14} aria-hidden="true" />裁剪</button>
                <button type="button" onClick={() => handleDownloadImage(selectedElement)}><Download size={14} aria-hidden="true" />下载</button>
              </div>
            </section>
            {cutoutSection}
            <section className="gme-insp-sec">
              <h4>位置</h4>
              {decorationPlacementControls(selectedElement)}
            </section>
            <section className="gme-insp-sec">
              <h4>颜色</h4>
              <div className="gme-swatches">
                {LOGO_COLORS.map(({ hex, label }) => (
                  <button key={hex} type="button" title={label} aria-label={`改成${label}`} onClick={() => applyLogoColor(selectedElement.id, hex)} style={{ background: hex }} />
                ))}
                <label title="自定义颜色" className="gme-swatch-custom">
                  <input type="color" aria-label="Logo 自定义颜色" onInput={(e) => applyLogoColor(selectedElement.id, e.currentTarget.value)} />
                </label>
              </div>
              <p className="gme-hint">把整个 Logo 换成一种颜色，可用顶部撤销恢复。</p>
            </section>
            <section className="gme-insp-sec">
              <button type="button" className="gme-ai-entry" onClick={regenerateSelectedLogo} disabled={artworkStudioLocked || !isLoggedIn}>
                <span className="gme-ai-badge"><Sparkles size={16} aria-hidden="true" /></span>
                <span className="gme-item-text">
                  <b>用它重新生成<em>AI</em></b>
                  <small>{artworkStudioLocked ? '当前图片处理中，完成后即可开始' : `去图稿生成，做好后替换${selectedLogoLabel}`}</small>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </section>
          </>
        )}
        {selectedElement.type === 'text' && (
          <>
            <section className="gme-insp-sec">
              <h4>位置</h4>
              {decorationPlacementControls(selectedElement)}
            </section>
            <section className="gme-insp-sec">
              <TextInspector
                element={selectedElement}
                onUpdate={(updates) => updateElement(selectedElement.id, updates)}
                onCopy={() => copyElement(selectedElement.id)}
                onDelete={() => deleteElement(selectedElement.id)}
              />
            </section>
          </>
        )}
      </div>
      {selectedElement.type !== 'text' && footer}
    </div>
  ) : null;

  return (
    <>
      {panelHost && panelContent && createPortal(panelContent, panelHost)}
      {inspectorHost && inspector && createPortal(inspector, inspectorHost)}

      {/* Preview modal */}
      <ClientPortal>
        <AnimatePresence>
          {previewingElement && (() => {
            const item = state.elements.find(e => e.id === previewingElement);
            return item?.image ? (
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 md:p-6"
                onClick={() => setPreviewingElement(null)}
              >
                <motion.img
                  initial={{ scale: 0.8 }} animate={{ scale: 1 }} exit={{ scale: 0.8 }}
                  crossOrigin="anonymous"
                  src={item.image}
                  alt="Preview"
                  className="max-w-full max-h-full object-contain drop-shadow-2xl"
                  onClick={(e) => e.stopPropagation()}
                />
              </motion.div>
            ) : null;
          })()}
        </AnimatePresence>
      </ClientPortal>

      {/* Crop modal */}
      <ClientPortal>
        <AnimatePresence>
          {croppingElementId && (() => {
            const item = state.elements.find(e => e.id === croppingElementId);
            return item?.image ? (
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-md flex items-center justify-center p-3 md:p-6"
                onClick={() => setCroppingElementId(null)}
              >
                <motion.div
                  initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
                  className="bg-white w-full max-w-md rounded-2xl md:rounded-[32px] overflow-hidden shadow-2xl p-4 md:p-6"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className="font-bold text-ink mb-4">裁剪图片</h3>
                  <ReactCrop crop={crop} onChange={setCrop} onComplete={setCompletedCrop}>
                    <img ref={cropImageRef} crossOrigin="anonymous" src={item.image} alt="Crop" className="max-w-full" />
                  </ReactCrop>
                  <div className="flex gap-3 mt-4">
                    <button onClick={() => setCroppingElementId(null)} className="flex-1 py-2.5 text-sm font-medium text-ink-2 bg-canvas rounded-xl hover:bg-border transition-all">取消</button>
                    <button onClick={applyCrop} disabled={!completedCrop} className="flex-1 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-xl hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all">确认裁剪</button>
                  </div>
                </motion.div>
              </motion.div>
            ) : null;
          })()}
        </AnimatePresence>
      </ClientPortal>

      <input
        ref={productInputRef}
        type="file" className="hidden" accept="image/*"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) { readProductImageFile(f); e.target.value = ''; } }}
      />
      <input
        ref={logoInputRef}
        type="file" className="hidden" accept="image/*"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) { readLogoImageFile(f); e.target.value = ''; } }}
      />
    </>
  );
}
