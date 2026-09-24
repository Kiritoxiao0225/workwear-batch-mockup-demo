'use client';

/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable @next/next/no-img-element -- Fabric crop and preview images use runtime data or signed URLs. */

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { garmentAiFetch } from '@/lib/garment-editor/client-api';
import dynamic from 'next/dynamic';
import {
  CustomizationState,
  CanvasElement,
  ElementType,
  FONTS,
} from '@/lib/garment-editor/mockup-types';
import TextInspector from '@/components/garment-editor/TextInspector';
import type {
  LogoRedrawCandidate,
  LogoRedrawCurrentReference,
} from '@/components/garment-editor/LogoRedrawFlow';
import {
  Upload, Type, ImageIcon,
  ChevronRight, LayoutGrid, RefreshCcw, Sparkles,
  X, FileUp, ClipboardPaste, Download, Maximize2, ChevronLeft,
  Crop, Palette, Plus, Copy,
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
  placementsForProductFace,
  productFace,
  setDecorationPlacement,
  setMockupProductFace,
} from '@/lib/garment-editor/mockup-element-relations';
import {
  applyLogoRedrawResult,
  type LogoRedrawApplyTarget,
} from '@/lib/garment-editor/mockup-logo-redraw';

const LogoRedrawFlow = dynamic(() => import('@/components/garment-editor/LogoRedrawFlow'), { ssr: false });

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
}

interface LogoRedrawSession {
  target: LogoRedrawApplyTarget;
  applicationTargetLabel: string;
  currentLogoReference?: LogoRedrawCurrentReference;
}

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

export default function Sidebar({ state, stateGeneration, getStateGeneration, getCurrentState, getCanvasDimensions, onUpdateState, onCollapse, isLoggedIn, selectedElementId, selectedElementType, onSelectElement, onResetCanvas }: SidebarProps) {
  const productInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const [activeUpload, setActiveUpload] = useState<'product' | 'logo' | null>(null);
  const [aiProcessingType, setAiProcessingType] = useState<'removeBackground' | 'generateBack' | null>(null);
  const [previewingElement, setPreviewingElement] = useState<string | null>(null);
  const [logoRedrawSession, setLogoRedrawSession] = useState<LogoRedrawSession | null>(null);

  const [croppingElementId, setCroppingElementId] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropArea>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const cropImageRef = useRef<HTMLImageElement>(null);
  const [colorPickerTarget, setColorPickerTarget] = useState<string | null>(null);
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
    setAiProcessingType(null);
  }, [stateGeneration]);

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
  const logoRedrawEntryLocked =
    aiProcessingType !== null ||
    logoErosionUpdatePending ||
    canvasImageOperationPending;

  const openLogoRedraw = () => {
    if (
      aiProcessingType !== null ||
      logoErosionUpdatePendingRef.current ||
      canvasImageOperationTokensRef.current.size > 0
    ) {
      toast.info('请等待当前图片处理完成后再开始 Logo 重绘');
      return;
    }
    if (!isLoggedIn) {
      toast.info('请先登录后再使用 AI Logo 重绘功能');
      return;
    }
    setActiveUpload(null);
    setPreviewingElement(null);
    setCroppingElementId(null);
    setCrop(undefined);
    setCompletedCrop(undefined);
    setColorPickerTarget(null);
    const currentElements = getCurrentState().elements;
    const currentSelectedLogo =
      selectedElementType === 'logo' && selectedElementId
        ? currentElements.find(
            element =>
              element.id === selectedElementId &&
              element.type === 'logo' &&
              !!element.image
          )
        : null;
    if (currentSelectedLogo?.image) {
      setLogoRedrawSession({
        target: {
          mode: 'replace',
          elementId: currentSelectedLogo.id,
          expectedImage: currentSelectedLogo.image,
          expectedPlacementState: {
            placedOnProductId: currentSelectedLogo.placedOnProductId,
            placement: currentSelectedLogo.placement,
            transform: currentSelectedLogo.transform
              ? { ...currentSelectedLogo.transform }
              : undefined,
            relativeTransform: currentSelectedLogo.relativeTransform
              ? { ...currentSelectedLogo.relativeTransform }
              : undefined,
          },
          operationGeneration: getStateGeneration(),
        },
        applicationTargetLabel: '将替换当前选中的 Logo，并保留它在画布中的位置与所属产品',
        currentLogoReference: {
          fileName: '当前 Logo',
          base64Image: currentSelectedLogo.image,
          imageRef: currentSelectedLogo.imageRef,
          previewUrl: currentSelectedLogo.image,
        },
      });
      return;
    }

    const ownerId = defaultDecorationProductId(currentElements, selectedElementId);
    const owner = ownerId
      ? currentElements.find(
          element => element.id === ownerId && element.type === 'product'
        )
      : null;
    const placement = owner
      ? defaultPlacementForDecoration('logo', productFace(owner))
      : 'custom';
    setLogoRedrawSession({
      target: {
        mode: 'add',
        elementId: newId(),
        placedOnProductId: ownerId,
        placement,
        ...(owner?.image
          ? {
              expectedOwnerImage: owner.image,
              expectedOwnerFace: productFace(owner),
            }
          : {}),
        operationGeneration: getStateGeneration(),
      },
      applicationTargetLabel: owner
        ? `将新增到${productLabelForElements(currentElements, owner.id)} · ${MOCKUP_PLACEMENT_LABELS[placement]}`
        : '将作为未归属 Logo 添加到画布中心',
    });
  };

  const applyLogoRedrawCandidate = async (candidate: LogoRedrawCandidate) => {
    const session = logoRedrawSession;
    if (!session) throw new Error('Logo 重绘会话已关闭，未应用生成结果');
    const currentElements = getCurrentState().elements;
    const replacementExpectedImage = session.target.mode === 'replace'
      ? session.target.expectedImage
      : null;
    const replacementLogo = replacementExpectedImage
      ? currentElements.find(
          element =>
            element.id === session.target.elementId &&
            element.type === 'logo' &&
            element.image === replacementExpectedImage
        )
      : null;
    const replacementOwner = replacementLogo?.placedOnProductId
      ? currentElements.find(
          element =>
            element.id === replacementLogo.placedOnProductId &&
            element.type === 'product'
        )
      : null;
    const sourceDimensions = session.target.mode === 'replace'
      ? await imageNaturalDimensions(session.target.expectedImage, '当前 Logo')
      : undefined;
    const ownerImage = session.target.mode === 'add'
      ? session.target.expectedOwnerImage
      : replacementLogo?.placedOnProductId &&
          (!replacementLogo.transform || !replacementLogo.relativeTransform)
        ? replacementOwner?.image
        : undefined;
    const ownerDimensions = ownerImage
      ? await imageNaturalDimensions(ownerImage, '归属产品')
      : undefined;

    onUpdateState(previousState => {
      const nextState = applyLogoRedrawResult({
        state: previousState,
        target: session.target,
        currentGeneration: getStateGeneration(),
        generatedImage: candidate.dataUrl,
        generatedSourceImage: candidate.rawDataUrl,
        sourceDimensions,
        generatedDimensions: {
          width: candidate.width,
          height: candidate.height,
        },
        ownerDimensions,
        canvasDimensions: getCanvasDimensions(),
      });
      return { elements: nextState.elements };
    });
    const appliedElementId = session.target.elementId;
    if (session.target.mode === 'replace') {
      setLogoMaskByElementId(previousMasks =>
        omitElementId(previousMasks, appliedElementId)
      );
      setLogoErosionStrengthByElementId(previousStrengths =>
        omitElementId(previousStrengths, appliedElementId)
      );
      latestMaskAppliedImageRef.current.delete(appliedElementId);
      cutoutSourceByAppliedImageKeyRef.current.delete(appliedElementId);
    }
    setLogoImageBeforeCutoutById(previousImages => ({
      ...previousImages,
      [appliedElementId]: candidate.rawDataUrl,
    }));
    rememberMaskAppliedImage(
      appliedElementId,
      candidate.dataUrl,
      candidate.rawDataUrl
    );
    onSelectElement(appliedElementId, 'logo');
    toast.success(
      session.target.mode === 'replace'
        ? 'Logo 已替换，可使用顶部撤销恢复'
        : 'Logo 已添加，可使用顶部撤销移除'
    );
  };

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
    setColorPickerTarget(null);
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
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      if (activeUpload === 'logo') {
        const item = e.clipboardData?.items[0];
        if (item?.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) { readLogoImageFile(file); setActiveUpload(null); }
        }
        return;
      }
      if (activeUpload === 'product') {
        const item = e.clipboardData?.items[0];
        if (item?.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) { readProductImageFile(file); setActiveUpload(null); }
        }
      }
    };
    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [activeUpload, readLogoImageFile, readProductImageFile]);

  const addTextElement = () => {
    const id = newId();
    const ownerId = defaultDecorationProductId(state.elements, selectedElementId);
    const element: CanvasElement = {
      id,
      type: 'text',
      text: '',
      fontFamily: FONTS[0].value,
      fontWeight: 'normal',
      fontStyle: 'normal',
      textUnderline: false,
      textAlign: 'center',
      textColor: '#000000',
      arcMode: 'none',
      arcBend: DEFAULT_ARC_BEND,
      placedOnProductId: ownerId,
      placement: 'custom',
    };
    onUpdateState(previousState => ({
      elements: [...previousState.elements, element],
    }));
    onSelectElement(id, 'text');
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
    if (aiProcessingType) return;

    const frontProduct = selectedProductForBackGeneration;
    if (!frontProduct?.image) {
      toast.info('请先选择一张正面产品图');
      return;
    }
    const operationGeneration = stateGeneration;
    const sourceImage = frontProduct.image;
    const backElementId = newId();

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
      if (operationIsCurrent(operationGeneration)) {
        setAiProcessingType(null);
      }
    }
  };

  const handleRemoveBackground = async () => {
    if (!isLoggedIn) { toast.info('请先登录后再使用 AI 抠图功能'); return; }
    if (aiProcessingType) return;

    const logo = selectedLogoForImageEdit;
    if (!logo?.image) {
      toast.info('请先选择一个 Logo 再抠图');
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
    setAiProcessingType('removeBackground');

    try {
      const res = await garmentAiFetch('/api/garment-mockup/remove-bg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base64Image: cleanSourceImage,
          imageRef: cleanSourceImageRef,
        }),
      });
      if (!res.ok) {
        throw new Error(
          await mockupAiErrorMessage(res, 'AI 抠图失败，请稍后重试')
        );
      }
      const { mask, original } = (await res.json()) as { mask: string; original: string };
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
        return;
      }
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
      if (operationIsCurrent(operationGeneration)) {
        toast.error(
          err instanceof Error ? err.message : 'AI 抠图失败，请稍后重试'
        );
      }
    } finally {
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
    if (aiProcessingType) return;

    const logo = selectedLogoForImageEdit;
    if (!logo?.image) {
      toast.info('请先选择一个 Logo 再去白底');
      return;
    }
    const operationGeneration = stateGeneration;
    const sourceImage = logo.image;
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

  return (
    <div className="w-full h-full bg-canvas flex flex-col overflow-y-auto custom-scrollbar relative">
      {/* Header */}
      <div className="min-h-16 md:min-h-20 flex items-center justify-between px-4 md:px-8 border-b border-border flex-shrink-0 bg-white safe-top">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-brand-600 rounded-xl flex items-center justify-center">
            <LayoutGrid className="text-white" size={20} />
          </div>
          <div>
            <h1 className="text-sm font-bold text-ink tracking-tight">成衣效果图</h1>
            <p className="text-[10px] text-ink-3 font-medium uppercase tracking-[0.1em]">图稿上衣 · 精细排版</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onResetCanvas}
            className="p-2 text-ink-3 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
            title="重置所有"
          >
            <RefreshCcw size={16} />
          </button>
          <button
            onClick={onCollapse}
            className="p-2 text-ink-3 hover:text-ink-2 hover:bg-canvas rounded-lg transition-all"
            title="收起侧边栏"
          >
            <ChevronLeft size={16} />
          </button>
        </div>
      </div>

      {/* Upload modal */}
      <ClientPortal>
        <AnimatePresence>
          {activeUpload && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-md flex items-center justify-center p-3 md:p-6"
              onClick={() => setActiveUpload(null)}
            >
              <motion.div
                initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 20 }}
                className="bg-white w-full max-w-sm rounded-2xl md:rounded-[32px] overflow-hidden shadow-2xl p-5 md:p-8"
                onClick={(e) => e.stopPropagation()}
                onPaste={(e) => {
                  const item = e.clipboardData.items[0];
                  if (item?.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) {
                      if (activeUpload === 'product') readProductImageFile(file);
                      else readLogoImageFile(file);
                      setActiveUpload(null);
                    }
                  }
                }}
              >
                <div className="flex items-center justify-between mb-8">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${activeUpload === 'product' ? 'bg-brand-50' : 'bg-brand-50'}`}>
                      <Upload size={16} className={activeUpload === 'product' ? 'text-brand-600' : 'text-brand-600'} />
                    </div>
                    <h3 className="font-bold text-ink">上传{activeUpload === 'product' ? '产品图' : 'Logo'}</h3>
                  </div>
                  <button onClick={() => setActiveUpload(null)} className="p-2 hover:bg-canvas rounded-full transition-colors">
                    <X size={16} className="text-ink-3" />
                  </button>
                </div>
                <div className="space-y-4">
                  <button
                    onClick={() => (activeUpload === 'product' ? productInputRef : logoInputRef).current?.click()}
                    className={`w-full flex items-center justify-center gap-3 py-4 text-white rounded-2xl font-bold transition-all shadow-lg ${activeUpload === 'product' ? 'bg-brand-600 hover:bg-brand-700' : 'bg-brand-600 hover:bg-brand-700'}`}
                  >
                    <FileUp size={18} />
                    选择电脑文件
                  </button>
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-border" /></div>
                    <div className="relative flex justify-center text-xs"><span className="px-2 bg-white text-ink-3 font-medium">或</span></div>
                  </div>
                  <div className="p-4 md:p-6 bg-canvas rounded-2xl border-2 border-dashed border-border text-center">
                    <ClipboardPaste size={24} className="mx-auto text-ink-3 mb-2" />
                    <p className="text-xs text-ink-3 font-medium">按 Ctrl+V 粘贴图片</p>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </ClientPortal>

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

      {logoRedrawSession && (
        <LogoRedrawFlow
          mode={logoRedrawSession.target.mode}
          applicationTargetLabel={logoRedrawSession.applicationTargetLabel}
          currentLogoReference={logoRedrawSession.currentLogoReference}
          onClose={() => setLogoRedrawSession(null)}
          onApply={applyLogoRedrawCandidate}
        />
      )}

      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 md:space-y-8">

        {/* Section 1: 产品图 */}
        <section className="space-y-4">
          <label className="flex items-center gap-2 text-xs font-bold text-ink uppercase tracking-wider">
            <Upload size={14} className="text-brand-600" />
            上传产品图
          </label>

          {selectedElementType === 'product' && selectedElement ? (
            /* Product selected: show properties */
            <div className="space-y-3">
              <div className="relative h-28 rounded-2xl border-2 border-brand-200 bg-brand-50/10 overflow-hidden flex items-center justify-center group">
                <img crossOrigin="anonymous" src={selectedElement.image} alt="product" className="max-h-full max-w-full object-contain" />
                <div className="absolute top-1 right-1 flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  <button onClick={() => { setCroppingElementId(selectedElement.id); setCrop(undefined); setCompletedCrop(undefined); }} className="p-1 bg-brand-500 text-white rounded-md shadow-md hover:bg-brand-600" title="裁剪">
                    <Crop size={10} />
                  </button>
                  <button onClick={() => copyElement(selectedElement.id)} className="p-1 bg-ink-2 text-white rounded-md shadow-md hover:bg-ink" title="复制">
                    <Copy size={10} />
                  </button>
                  <button onClick={() => deleteElement(selectedElement.id)} className="p-1 bg-red-500 text-white rounded-md shadow-md hover:bg-red-600" title="删除">
                    <X size={10} />
                  </button>
                </div>
              </div>

              <div className="grid gap-2 rounded-xl border border-border bg-canvas/60 p-2.5">
                <span className="text-[10px] font-bold text-ink-3">
                  这张图片表示
                </span>
                <div
                  className="grid grid-cols-2 gap-1 rounded-lg bg-border/40 p-1"
                  role="group"
                  aria-label="这张产品图片表示的面"
                >
                  {(['front', 'back'] as const).map(face => {
                    const active = productFace(selectedElement) === face;
                    return (
                      <button
                        key={face}
                        type="button"
                        aria-pressed={active}
                        onClick={() => updateProductFace(selectedElement.id, face)}
                        className={`h-8 rounded-md text-xs font-semibold transition-colors ${
                          active
                            ? 'bg-white text-brand-700 shadow-sm'
                            : 'text-ink-3 hover:text-ink'
                        }`}
                      >
                        {face === 'front' ? '正面' : '背面'}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[10px] leading-relaxed text-ink-3">
                  这里只标记当前这张产品图，不会切换或替换下方图片。
                </p>
              </div>

              {selectedProductForBackGeneration &&
                !selectedProductHasGeneratedBack && (
                <button
                  onClick={handleGenerateBack}
                  disabled={aiProcessingType !== null}
                  className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold transition-all border ${
                    aiProcessingType === 'generateBack'
                      ? 'bg-brand-600 border-brand-600 text-white'
                      : aiProcessingType !== null
                        ? 'bg-canvas border-border text-ink-3 cursor-not-allowed'
                        : 'bg-brand-50 border-brand-200 text-brand-700 hover:bg-brand-100'
                  }`}
                >
                  {aiProcessingType === 'generateBack' ? (
                    <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />正在 AI 生成背面图...</>
                  ) : (
                    <><Sparkles size={13} />AI 生成背面图</>
                  )}
                </button>
              )}

            </div>
          ) : products.length > 0 ? (
            /* Has products but none selected: show thumbnails */
            <div className="space-y-2">
              {products.map((p, productIndex) => (
                <div
                  key={p.id}
                  onClick={() => onSelectElement(p.id, 'product')}
                  className="flex items-center gap-3 p-2 rounded-xl border border-border hover:border-brand-200 hover:bg-brand-50/50 cursor-pointer transition-all"
                >
                  <div className="w-10 h-10 rounded-lg border border-border bg-canvas overflow-hidden flex-shrink-0 flex items-center justify-center">
                    <img crossOrigin="anonymous" src={p.image} alt="" className="max-w-full max-h-full object-contain" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-ink-2">
                      产品 {productIndex + 1} · {productFace(p) === 'back' ? '背面' : '正面'}
                    </span>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); deleteElement(p.id); }} className="p-1 text-ink-3 hover:text-red-500 transition-colors flex-shrink-0">
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            /* No products: show upload */
            <div
              onClick={() => setActiveUpload('product')}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) readProductImageFile(f); }}
              onDragOver={(e) => e.preventDefault()}
              className="h-28 rounded-2xl border-2 border-dashed border-border hover:border-brand-400 flex items-center justify-center gap-2 text-[11px] font-semibold text-ink-3 hover:text-brand-600 transition-all cursor-pointer"
            >
              <Upload size={16} />
              点击上传产品图
            </div>
          )}

          {products.length > 0 && (
            <button
              onClick={() => setActiveUpload('product')}
              className="w-full h-9 rounded-xl border-2 border-dashed border-border bg-white hover:bg-brand-50/50 hover:border-brand-200 flex items-center justify-center gap-2 text-[10px] font-semibold text-ink-2 hover:text-brand-600 transition-all"
            >
              <Plus size={12} className="text-brand-500" />
              上传另一张产品图
            </button>
          )}

          <input
            ref={productInputRef}
            type="file" className="hidden" accept="image/*"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { readProductImageFile(f); setActiveUpload(null); e.target.value = ''; } }}
          />
        </section>

        {/* Section 2: Logo */}
        <section className="space-y-4">
          <label className="flex items-center gap-2 text-xs font-bold text-ink uppercase tracking-wider">
            <ImageIcon size={14} className="text-brand-600" />
            定制 Logo
          </label>

          {selectedElementType === 'logo' && selectedElement ? (
            /* Logo selected: show properties */
            <div className="space-y-3">
              <div className="relative h-24 rounded-2xl border-2 border-brand-200 bg-brand-50/10 overflow-hidden flex items-center justify-center group">
                <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#000 1px, transparent 1px)', backgroundSize: '8px 8px' }} />
                <img crossOrigin="anonymous" src={selectedElement.image} alt="logo" className="max-h-full max-w-full object-contain drop-shadow-sm" />
                <div className="absolute top-1 right-1 flex items-center gap-1 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  <button onClick={() => setPreviewingElement(selectedElement.id)} className="p-1 bg-white text-ink-2 rounded-md shadow-md hover:bg-canvas border border-border" title="预览">
                    <Maximize2 size={10} />
                  </button>
                  <button onClick={() => { setCroppingElementId(selectedElement.id); setCrop(undefined); setCompletedCrop(undefined); }} className="p-1 bg-brand-500 text-white rounded-md shadow-md hover:bg-brand-600" title="裁剪">
                    <Crop size={10} />
                  </button>
                  <button onClick={() => setColorPickerTarget(prev => prev === selectedElement.id ? null : selectedElement.id)} className="p-1 bg-brand-500 text-white rounded-md shadow-md hover:bg-brand-600" title="色彩替换">
                    <Palette size={10} />
                  </button>
                  <button onClick={() => handleDownloadImage(selectedElement)} className="p-1 bg-emerald-500 text-white rounded-md shadow-md hover:bg-emerald-600" title="下载">
                    <Download size={10} />
                  </button>
                  <button onClick={() => copyElement(selectedElement.id)} className="p-1 bg-ink-2 text-white rounded-md shadow-md hover:bg-ink" title="复制">
                    <Copy size={10} />
                  </button>
                  <button onClick={() => deleteElement(selectedElement.id)} className="p-1 bg-red-500 text-white rounded-md shadow-md hover:bg-red-600" title="删除">
                    <X size={10} />
                  </button>
                </div>
              </div>

              {decorationPlacementControls(selectedElement)}

              {colorPickerTarget === selectedElement.id && (
                <div className="flex items-center gap-1.5 px-2 py-2 bg-brand-50 rounded-xl border border-brand-100 flex-wrap">
                  {LOGO_COLORS.map(({ hex, label }) => (
                    <button
                      key={hex}
                      onClick={() => applyLogoColor(selectedElement.id, hex)}
                      title={label}
                      className="w-5 h-5 rounded-full border-2 border-white shadow-sm hover:scale-110 transition-transform flex-shrink-0"
                      style={{ background: hex, outline: hex === '#ffffff' ? '1px solid #e5e7eb' : 'none' }}
                    />
                  ))}
                  <label title="自定义颜色" className="w-5 h-5 rounded-full border-2 border-white shadow-sm hover:scale-110 transition-transform overflow-hidden cursor-pointer flex-shrink-0 relative" style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }}>
                    <input type="color" aria-label="Logo 自定义颜色" className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" onInput={(e) => applyLogoColor(selectedElement.id, e.currentTarget.value)} />
                  </label>
                </div>
              )}
            </div>
          ) : logos.length > 0 ? (
            /* Has logos but none selected: show thumbnails */
            <div className="space-y-2">
              {logos.map(l => (
                <div
                  key={l.id}
                  onClick={() => onSelectElement(l.id, 'logo')}
                  className="flex items-center gap-3 p-2 rounded-xl border border-border hover:border-brand-200 hover:bg-brand-50/50 cursor-pointer transition-all"
                >
                  <div className="w-10 h-10 rounded-lg border border-border bg-canvas overflow-hidden flex-shrink-0 flex items-center justify-center">
                    <img crossOrigin="anonymous" src={l.image} alt="" className="max-w-full max-h-full object-contain" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-ink-2">Logo</span>
                    <span className="block truncate text-[10px] text-ink-3">
                      {l.placedOnProductId ? productOptionLabel(l.placedOnProductId) : '未归属'}
                    </span>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); deleteElement(l.id); }} className="p-1 text-ink-3 hover:text-red-500 transition-colors flex-shrink-0">
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            /* No logos: show upload */
            <div
              onClick={() => setActiveUpload('logo')}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) readLogoImageFile(f); }}
              onDragOver={(e) => e.preventDefault()}
              className="h-20 rounded-2xl border-2 border-dashed border-border hover:border-brand-400 flex items-center justify-center gap-2 text-[11px] font-semibold text-ink-3 hover:text-brand-600 transition-all cursor-pointer"
            >
              <Upload size={16} />
              点击上传 Logo
            </div>
          )}

          <button
            type="button"
            onClick={openLogoRedraw}
            disabled={logoRedrawEntryLocked}
            className="group w-full rounded-2xl border border-brand-200 bg-gradient-to-br from-white to-brand-50 p-3 text-left shadow-sm transition-all hover:border-brand-400 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-brand-200 disabled:hover:shadow-sm"
            aria-label={
              logoRedrawEntryLocked
                ? '当前图片处理中，暂时不能开始 Logo 重绘'
                : selectedLogoForImageEdit
                  ? '重绘当前选中的 Logo'
                  : '制作一个新 Logo 并添加到画布'
            }
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm transition-transform group-hover:scale-105">
                <Sparkles size={16} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-xs font-bold text-ink">
                  {selectedLogoForImageEdit ? '重绘当前 Logo' : '制作新 Logo'}
                  <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-[9px] font-bold text-brand-700">
                    AI
                  </span>
                </span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-ink-3">
                  {!isLoggedIn
                    ? '登录后可用 · 文字必填，参考图可选'
                    : logoRedrawEntryLocked
                      ? '当前图片处理中，完成后即可开始重绘'
                      : selectedLogoForImageEdit
                        ? '按文字要求重新绘制；完成后只替换当前 Logo'
                        : logos.length > 0
                          ? '当前未选 Logo；完成后会新增，不替换已有 Logo'
                          : '只写要求也能生成；完成后添加到画布'}
                </span>
              </span>
              <ChevronRight
                size={16}
                className="shrink-0 text-brand-500 transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </span>
          </button>

          {/* AI Toolbox for logos */}
          {logos.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className="p-4 bg-gradient-to-br from-brand-50 to-emerald-50 rounded-2xl border border-brand-100 shadow-sm"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold text-brand-600 uppercase tracking-wider">AI 增强工具箱</span>
                <Sparkles size={12} className="text-brand-600 animate-pulse" />
              </div>
              <p className="text-[10px] text-brand-900/60 leading-relaxed mb-3">
                {selectedLogoForImageEdit
                  ? '仅对当前选中的 Logo 生效。'
                  : '请先在上方选择一个 Logo。'}
              </p>
              <div className="space-y-2">
                <button
                  onClick={handleRemoveBackground}
                  disabled={aiProcessingType !== null || !selectedLogoForImageEdit}
                  className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold transition-all border ${
                    aiProcessingType === 'removeBackground'
                      ? 'bg-brand-600 border-brand-600 text-white'
                      : aiProcessingType !== null || !selectedLogoForImageEdit
                        ? 'bg-canvas border-border text-ink-3 cursor-not-allowed'
                        : 'bg-white border-brand-200 text-brand-700 hover:bg-brand-50'
                  }`}
                >
                  {aiProcessingType === 'removeBackground' ? (
                    <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />AI 抠图中...</>
                  ) : (
                    <><Sparkles size={13} />AI 一键抠图</>
                  )}
                </button>
                {selectedLogoForImageEditId &&
                  logoMaskByElementId[selectedLogoForImageEditId] && (
                  <div className="px-1 py-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] text-brand-600 font-medium">去边色（细字慎用）</span>
                      <span className="text-[10px] text-brand-400 font-mono">{selectedLogoErosionStrength}</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={selectedLogoErosionStrength}
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
                      className="w-full h-2 bg-brand-100 rounded-lg appearance-none cursor-pointer accent-brand-600"
                    />
                    <div className="flex justify-between text-[9px] text-brand-300 mt-0.5"><span>保留细节</span><span>强力去边</span></div>
                  </div>
                )}
                <button onClick={handleLocalRemoveBackground} disabled={aiProcessingType !== null || !selectedLogoForImageEdit} className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold transition-all border bg-white border-border text-ink-2 hover:bg-canvas disabled:opacity-40 disabled:cursor-not-allowed">
                  本地去白底（无 AI）
                </button>
                {selectedLogoForImageEditId &&
                  logoImageBeforeCutoutById[selectedLogoForImageEditId] && (
                  <button onClick={handleUndoRemoveBackground} className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold transition-all border bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100">
                    撤销抠图，恢复原图
                  </button>
                )}
              </div>
            </motion.div>
          )}

          {logos.length > 0 && (
            <button
              onClick={() => setActiveUpload('logo')}
              className="w-full h-9 rounded-xl border-2 border-dashed border-border bg-white hover:bg-brand-50/50 hover:border-brand-200 flex items-center justify-center gap-2 text-[10px] font-semibold text-ink-2 hover:text-brand-600 transition-all"
            >
              <Plus size={12} className="text-brand-500" />
              添加新 Logo
            </button>
          )}

          <input
            ref={logoInputRef}
            type="file" className="hidden" accept="image/*"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { readLogoImageFile(f); setActiveUpload(null); e.target.value = ''; } }}
          />
        </section>

        {/* Section 3: 文字 */}
        <section className="space-y-4">
          <label className="flex items-center gap-2 text-xs font-bold text-ink uppercase tracking-wider">
            <Type size={14} className="text-brand-600" />
            定制文字
          </label>

          {selectedElementType === 'text' && selectedElement ? (
            /* Text selected: show properties */
            <div className="p-3 bg-white rounded-2xl border border-border space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-ink-3">文字编辑</span>
              </div>
              {decorationPlacementControls(selectedElement)}
              <TextInspector
                element={selectedElement}
                onUpdate={(updates) => updateElement(selectedElement.id, updates)}
                onCopy={() => copyElement(selectedElement.id)}
                onDelete={() => deleteElement(selectedElement.id)}
              />
            </div>
          ) : texts.length > 0 ? (
            /* Has texts but none selected: show text list */
            <div className="space-y-2">
              {texts.map(t => (
                <div
                  key={t.id}
                  onClick={() => onSelectElement(t.id, 'text')}
                  className="flex items-center gap-3 p-2 rounded-xl border border-border hover:border-brand-200 hover:bg-brand-50/50 cursor-pointer transition-all"
                >
                  <div className="w-10 h-10 rounded-lg border border-border bg-canvas overflow-hidden flex-shrink-0 flex items-center justify-center">
                    <Type size={14} className="text-ink-3" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-ink-2 truncate block">{t.text || '空文字'}</span>
                    <span className="block truncate text-[10px] text-ink-3">
                      {t.placedOnProductId ? productOptionLabel(t.placedOnProductId) : '未归属'}
                    </span>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); deleteElement(t.id); }} className="p-1 text-ink-3 hover:text-red-500 transition-colors flex-shrink-0">
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            /* No texts: show add button */
            <button
              onClick={addTextElement}
              className="w-full h-14 rounded-2xl border-2 border-dashed border-border hover:border-brand-400 flex items-center justify-center gap-2 text-[11px] font-semibold text-ink-3 hover:text-brand-600 transition-all"
            >
              <Plus size={14} />
              添加文字
            </button>
          )}

          <button
            onClick={addTextElement}
            className="w-full h-9 rounded-xl border-2 border-dashed border-border bg-white hover:bg-brand-50/50 hover:border-brand-200 flex items-center justify-center gap-2 text-[10px] font-semibold text-ink-2 hover:text-brand-600 transition-all"
          >
            <Plus size={12} className="text-brand-500" />
            添加新文字
          </button>
        </section>

      </div>

      {/* Mobile bottom collapse button */}
      <div className="sm:hidden p-4 border-t border-border bg-white flex-shrink-0 safe-bottom">
        <button onClick={onCollapse} className="w-full flex items-center justify-center gap-2 py-3 bg-brand-600 text-white rounded-2xl text-sm font-bold shadow-lg active:bg-brand-700 transition-all">
          <span>查看预览</span>
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
