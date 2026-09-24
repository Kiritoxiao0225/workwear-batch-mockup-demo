'use client';

/* eslint-disable @next/next/no-img-element -- Logo previews use runtime data URLs and signed URLs. */
/* eslint-disable react-hooks/set-state-in-effect -- The portal becomes available only after client mount. */

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  FileImage,
  ImagePlus,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { garmentAiFetch } from '@/lib/garment-editor/client-api';

import {
  LOGO_REDRAW_MAX_IMAGE_BYTES,
  LOGO_REDRAW_MAX_IMAGES,
  LOGO_REDRAW_MAX_INSTRUCTION_LENGTH,
  LogoRedrawTargetStaleError,
  parseLogoRedrawAnalysisValue,
  type LogoRedrawAnalysis,
  type LogoRedrawReferenceInput,
} from '@/lib/garment-editor/mockup-logo-redraw';
import {
  erodedLogoMaskDataUrl,
  readCompressedImageFile,
} from '@/components/garment-editor/image-editing';
import Button from '@/components/garment-editor/ui/button';
import ConfirmDialog from '@/components/garment-editor/ui/confirm-dialog';

export interface LogoRedrawCandidate {
  dataUrl: string;
  rawDataUrl: string;
  transparentDataUrl?: string;
  width: number;
  height: number;
  rawWidth: number;
  rawHeight: number;
  transparentWidth?: number;
  transparentHeight?: number;
  model: string;
  durationMs: number;
  contentType?: 'image/png';
  cutoutStatus: 'processing' | 'ready' | 'failed';
  cutoutError?: string;
  cutoutDurationMs?: number;
}

export interface LogoRedrawCurrentReference {
  fileName: string;
  base64Image: string;
  imageRef?: string;
  previewUrl: string;
}

export interface LogoRedrawFlowProps {
  mode: 'replace' | 'add';
  applicationTargetLabel: string;
  currentLogoReference?: LogoRedrawCurrentReference;
  onClose: () => void;
  onApply: (candidate: LogoRedrawCandidate) => Promise<void>;
}

type FlowStep = 1 | 2 | 3 | 4;
type ConfirmationAction = 'close' | 'stop-generation' | null;
type PreviewBackground = 'transparent' | 'white' | 'dark';
type PreviewVersion = 'raw' | 'transparent';
type GenerationOrigin = 'confirmation' | 'review';
type ReviewKey = 'text' | 'color' | 'structure';

interface ReferenceEntry extends LogoRedrawReferenceInput {
  id: string;
  previewUrl: string;
  source: 'current' | 'upload';
}

interface CandidateEntry extends LogoRedrawCandidate {
  id: string;
  cutoutToken: number;
}

interface CandidateCutoutOperation {
  controller: AbortController;
  token: number;
  rawDataUrl: string;
  sessionEpoch: number;
  startedAt: number;
}

interface CandidateReview {
  text: boolean;
  color: boolean;
  structure: boolean;
}

interface AnalysisResponse {
  analysis: LogoRedrawAnalysis;
  model: string;
  durationMs: number;
}

interface GenerationResponse {
  image: {
    dataUrl: string;
    contentType: 'image/png';
    model: string;
    width: number;
    height: number;
  };
  durationMs: number;
}

const supportedUploadTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const stepLabels = ['描述与参考', '确认理解', '生成 Logo', '复核并应用'];
const quickPhrases = [
  { label: '保留参考图形', text: '保留参考图中的主要图形' },
  { label: '修改文字', text: '把 Logo 文字修改为：' },
  { label: '调整配色', text: '调整 Logo 配色为：' },
  { label: '调整布局', text: '调整图形与文字的布局' },
  { label: '透明背景', text: '输出透明背景' },
] as const;
const confidenceLabels = {
  high: '已识别',
  medium: '需人工确认',
  low: '需重点确认',
} as const;
const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function newEntryId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatDuration(durationMs: number) {
  const seconds = Math.max(0, durationMs) / 1_000;
  return seconds < 10 ? `${seconds.toFixed(1)} 秒` : `${Math.round(seconds)} 秒`;
}

export function assertUsableTransparentRgba(rgba: Uint8ClampedArray) {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new Error(`透明 Logo 像素数据无效，RGBA 长度为 ${rgba.length}。`);
  }
  let hasTransparentPixel = false;
  let hasVisiblePixel = false;
  for (let alphaIndex = 3; alphaIndex < rgba.length; alphaIndex += 4) {
    const alpha = rgba[alphaIndex];
    if (alpha === 0) hasTransparentPixel = true;
    if (alpha > 0) hasVisiblePixel = true;
    if (hasTransparentPixel && hasVisiblePixel) return;
  }
  if (!hasVisiblePixel) {
    throw new Error('抠图结果全部透明，遮罩可能是全黑退化结果。');
  }
  throw new Error('抠图结果没有透明像素，遮罩可能是全白退化结果。');
}

function inspectTransparentImage(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        reject(new Error('透明 Logo 缺少有效尺寸。'));
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        reject(new Error('透明 Logo 像素检查无法创建画布。'));
        return;
      }
      context.drawImage(image, 0, 0);
      try {
        assertUsableTransparentRgba(
          context.getImageData(0, 0, canvas.width, canvas.height).data
        );
      } catch (error) {
        reject(error);
        return;
      }
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => reject(new Error('透明 Logo 尺寸读取失败。'));
    image.src = dataUrl;
  });
}

function requestReferences(references: ReferenceEntry[]): LogoRedrawReferenceInput[] {
  return references.map(({ fileName, base64Image, imageRef }) => ({
    fileName,
    base64Image,
    ...(imageRef ? { imageRef } : {}),
  }));
}

async function responseErrorMessage(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === 'string' && body.error.trim()
      ? body.error
      : fallback;
  } catch {
    return fallback;
  }
}

function requestFailureMessage(error: unknown, fallback: string) {
  if (error instanceof TypeError) {
    return `${fallback}：网络连接中断，请检查网络后重试。`;
  }
  if (error instanceof SyntaxError) {
    return `${fallback}：服务返回格式异常，请稍后重试。`;
  }
  return error instanceof Error ? error.message : fallback;
}

function parseAnalysisResponse(value: unknown): AnalysisResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const response = value as Partial<AnalysisResponse>;
  if (
    !response.analysis ||
    typeof response.model !== 'string' ||
    !response.model.trim() ||
    !Number.isFinite(response.durationMs) ||
    Number(response.durationMs) < 0
  ) return null;
  try {
    return {
      analysis: parseLogoRedrawAnalysisValue(response.analysis),
      model: response.model,
      durationMs: Number(response.durationMs),
    };
  } catch {
    return null;
  }
}

function isGenerationResponse(value: unknown): value is GenerationResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as Partial<GenerationResponse>;
  const image = response.image;
  return Boolean(
    image &&
    typeof image.dataUrl === 'string' &&
    image.dataUrl.startsWith('data:image/png;base64,') &&
    image.contentType === 'image/png' &&
    typeof image.model === 'string' &&
    Number.isFinite(image.width) &&
    Number(image.width) > 0 &&
    Number.isFinite(image.height) &&
    Number(image.height) > 0 &&
    Number.isFinite(response.durationMs)
  );
}

function StatusMessage({ tone, children }: { tone: 'error' | 'warning' | 'info'; children: ReactNode }) {
  const classes = tone === 'error'
    ? 'border-red-200 bg-red-50 text-red-700'
    : tone === 'warning'
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-brand-200 bg-brand-50 text-brand-800';
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm leading-relaxed ${classes}`} role={tone === 'error' ? 'alert' : 'status'}>
      {tone === 'error' || tone === 'warning'
        ? <AlertTriangle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
        : <ShieldCheck size={17} className="mt-0.5 shrink-0" aria-hidden="true" />}
      <div>{children}</div>
    </div>
  );
}

export default function LogoRedrawFlow({
  mode,
  applicationTargetLabel,
  currentLogoReference,
  onClose,
  onApply,
}: LogoRedrawFlowProps) {
  const initialReferences = useMemo<ReferenceEntry[]>(() => (
    currentLogoReference
      ? [{
          ...currentLogoReference,
          id: newEntryId('current-logo'),
          source: 'current',
        }]
      : []
  ), [currentLogoReference]);

  const [mounted, setMounted] = useState(false);
  const [step, setStep] = useState<FlowStep>(1);
  const [instruction, setInstruction] = useState('');
  const [references, setReferences] = useState<ReferenceEntry[]>(initialReferences);
  const [hasReferenceEdits, setHasReferenceEdits] = useState(false);
  const [referenceError, setReferenceError] = useState('');
  const [isReadingImages, setIsReadingImages] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [analysis, setAnalysis] = useState<LogoRedrawAnalysis | null>(null);
  const [analysisMeta, setAnalysisMeta] = useState<{ model: string; durationMs: number } | null>(null);
  const [isUnderstanding, setIsUnderstanding] = useState(false);
  const [understandingError, setUnderstandingError] = useState('');
  const [understandingConfirmed, setUnderstandingConfirmed] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationElapsedMs, setGenerationElapsedMs] = useState(0);
  const [generationError, setGenerationError] = useState('');
  const [candidates, setCandidates] = useState<CandidateEntry[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [reviewsByCandidateId, setReviewsByCandidateId] = useState<Record<string, CandidateReview>>({});
  const [previewBackground, setPreviewBackground] = useState<PreviewBackground>('transparent');
  const [previewVersion, setPreviewVersion] = useState<PreviewVersion>('raw');
  const [activeCutoutCandidateId, setActiveCutoutCandidateId] = useState<string | null>(null);
  const [cutoutElapsedMs, setCutoutElapsedMs] = useState(0);
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [applyRequiresNewTarget, setApplyRequiresNewTarget] = useState(false);
  const [confirmationAction, setConfirmationAction] = useState<ConfirmationAction>(null);

  const shellRef = useRef<HTMLDivElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const referencesRef = useRef(initialReferences);
  const imageReadInProgressRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const understandingAbortRef = useRef<AbortController | null>(null);
  const generationAbortRef = useRef<AbortController | null>(null);
  const cutoutOperationsRef = useRef(new Map<string, CandidateCutoutOperation>());
  const cutoutTokenRef = useRef(0);
  const cutoutSessionEpochRef = useRef(0);
  const cutoutStartedAtRef = useRef(0);
  const generationStartedAtRef = useRef(0);
  const generationOriginRef = useRef<GenerationOrigin>('confirmation');

  const selectedCandidate = useMemo(
    () => candidates.find(candidate => candidate.id === selectedCandidateId) ?? null,
    [candidates, selectedCandidateId]
  );
  const currentReview = selectedCandidate
    ? reviewsByCandidateId[selectedCandidate.id] ?? { text: false, color: false, structure: false }
    : { text: false, color: false, structure: false };
  const requiredReviewKeys = useMemo<ReviewKey[]>(() => {
    if (!analysis) return [];
    const keys: ReviewKey[] = [];
    if (analysis.output.targetText.trim()) keys.push('text');
    if (analysis.output.color.trim()) keys.push('color');
    keys.push('structure');
    return keys;
  }, [analysis]);
  const reviewComplete = Boolean(
    understandingConfirmed &&
    previewVersion === 'transparent' &&
    selectedCandidate?.cutoutStatus === 'ready' &&
    selectedCandidate.transparentDataUrl &&
    requiredReviewKeys.every(key => currentReview[key])
  );
  const isCuttingOut = activeCutoutCandidateId !== null;
  const instructionIsValid = instruction.trim().length > 0 && instruction.length <= LOGO_REDRAW_MAX_INSTRUCTION_LENGTH;
  const hasWorkInProgress = Boolean(
    instruction.trim() ||
    hasReferenceEdits ||
    analysis ||
    candidates.length > 0 ||
    isUnderstanding ||
    isGenerating ||
    isCuttingOut
  );

  const invalidateDownstream = useCallback(() => {
    understandingAbortRef.current?.abort();
    generationAbortRef.current?.abort();
    for (const operation of cutoutOperationsRef.current.values()) {
      operation.controller.abort();
    }
    cutoutOperationsRef.current.clear();
    understandingAbortRef.current = null;
    generationAbortRef.current = null;
    requestSequenceRef.current += 1;
    cutoutSessionEpochRef.current += 1;
    setIsUnderstanding(false);
    setIsGenerating(false);
    setUnderstandingError('');
    setGenerationError('');
    setAnalysis(null);
    setAnalysisMeta(null);
    setUnderstandingConfirmed(false);
    setCandidates([]);
    setSelectedCandidateId(null);
    setReviewsByCandidateId({});
    setActiveCutoutCandidateId(null);
    setCutoutElapsedMs(0);
    setPreviewVersion('raw');
    setApplyError('');
    setApplyRequiresNewTarget(false);
  }, []);

  const commitReferences = useCallback((nextReferences: ReferenceEntry[]) => {
    referencesRef.current = nextReferences;
    setReferences(nextReferences);
    setHasReferenceEdits(true);
    setReferenceError('');
    invalidateDownstream();
  }, [invalidateDownstream]);

  const requestClose = useCallback(() => {
    if (isApplying) return;
    if (!hasWorkInProgress) {
      onClose();
      return;
    }
    setConfirmationAction('close');
  }, [hasWorkInProgress, isApplying, onClose]);

  useEffect(() => {
    setMounted(true);
    mountedRef.current = true;
    const cutoutOperations = cutoutOperationsRef.current;
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      cutoutSessionEpochRef.current += 1;
      understandingAbortRef.current?.abort();
      generationAbortRef.current?.abort();
      for (const operation of cutoutOperations.values()) {
        operation.controller.abort();
      }
      cutoutOperations.clear();
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const shell = shellRef.current;
    if (!shell) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The editor registers canvas and undo shortcuts on window. Keep every
      // modal keystroke inside this flow while preserving normal text input.
      event.stopPropagation();
      // The shared ConfirmDialog installs its own focus trap on document. Let
      // that same-target listener handle Tab/Escape while still blocking the
      // event from bubbling onward to the canvas/window shortcuts.
      if (confirmationAction) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(shell.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) {
        event.preventDefault();
        shell.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !shell.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !shell.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [confirmationAction, mounted, requestClose]);

  useEffect(() => {
    if (!mounted || step !== 1) return;
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [mounted, step]);

  useEffect(() => {
    if (!mounted || step === 1 || confirmationAction) return;
    const frame = window.requestAnimationFrame(() => stepHeadingRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [confirmationAction, isGenerating, mounted, step]);

  useEffect(() => {
    if (!isGenerating) return;
    const timer = window.setInterval(() => {
      setGenerationElapsedMs(Date.now() - generationStartedAtRef.current);
    }, 500);
    return () => window.clearInterval(timer);
  }, [isGenerating]);

  useEffect(() => {
    if (!isCuttingOut) return;
    const timer = window.setInterval(() => {
      setCutoutElapsedMs(Date.now() - cutoutStartedAtRef.current);
    }, 500);
    return () => window.clearInterval(timer);
  }, [isCuttingOut]);

  const updateInstruction = (value: string) => {
    setInstruction(value);
    invalidateDownstream();
  };

  const appendQuickPhrase = (phrase: typeof quickPhrases[number]['text']) => {
    if (instruction.includes(phrase)) return;
    const selectionStart = textareaRef.current?.selectionStart ?? instruction.length;
    const selectionEnd = textareaRef.current?.selectionEnd ?? selectionStart;
    const before = instruction.slice(0, selectionStart);
    const after = instruction.slice(selectionEnd);
    const separator = before && !/[\s，。；：]$/u.test(before) ? '；' : '';
    const nextInstruction = `${before}${separator}${phrase}${after}`;
    if (nextInstruction.length > LOGO_REDRAW_MAX_INSTRUCTION_LENGTH) return;
    updateInstruction(nextInstruction);
    const nextCursor = before.length + separator.length + phrase.length;
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const addImageFiles = useCallback(async (files: File[]) => {
    if (files.length === 0 || isUnderstanding) return;
    if (imageReadInProgressRef.current) {
      setReferenceError('参考图正在读取，请完成后再添加。');
      return;
    }
    const supportedTypeFiles = files.filter(file => supportedUploadTypes.has(file.type));
    const unsupportedCount = files.length - supportedTypeFiles.length;
    const oversizedCount = supportedTypeFiles.filter(
      file => file.size > LOGO_REDRAW_MAX_IMAGE_BYTES
    ).length;
    const supportedFiles = supportedTypeFiles.filter(
      file => file.size <= LOGO_REDRAW_MAX_IMAGE_BYTES
    );
    const availableSlots = LOGO_REDRAW_MAX_IMAGES - referencesRef.current.length;
    if (availableSlots <= 0) {
      setReferenceError(`最多添加 ${LOGO_REDRAW_MAX_IMAGES} 张参考图；请先移除一张。`);
      return;
    }
    if (supportedFiles.length === 0) {
      setReferenceError([
        unsupportedCount > 0 ? `${unsupportedCount} 张格式不支持` : '',
        oversizedCount > 0 ? `${oversizedCount} 张超过单张 8MB 限制` : '',
      ].filter(Boolean).join('；') || '没有可添加的参考图。');
      return;
    }

    const filesToRead = supportedFiles.slice(0, availableSlots);
    imageReadInProgressRef.current = true;
    setIsReadingImages(true);
    setReferenceError('');
    try {
      const dataUrls = await Promise.all(
        filesToRead.map(file => readCompressedImageFile(file, 1_600))
      );
      if (!mountedRef.current) return;
      const slotsAtCommit = LOGO_REDRAW_MAX_IMAGES - referencesRef.current.length;
      const additions = filesToRead.slice(0, slotsAtCommit).map((file, index): ReferenceEntry => ({
        id: newEntryId('reference'),
        fileName: file.name || `粘贴图片-${index + 1}.png`,
        base64Image: dataUrls[index],
        previewUrl: dataUrls[index],
        source: 'upload',
      }));
      if (additions.length > 0) {
        commitReferences([...referencesRef.current, ...additions]);
      }
      const skippedCount = supportedFiles.length - additions.length;
      if (unsupportedCount > 0 || oversizedCount > 0 || skippedCount > 0) {
        setReferenceError([
          unsupportedCount > 0 ? `${unsupportedCount} 张格式不支持` : '',
          oversizedCount > 0 ? `${oversizedCount} 张超过单张 8MB 限制` : '',
          skippedCount > 0 ? `${skippedCount} 张超过最多 ${LOGO_REDRAW_MAX_IMAGES} 张的限制` : '',
        ].filter(Boolean).join('；'));
      }
    } catch (error) {
      if (mountedRef.current) {
        setReferenceError(error instanceof Error ? error.message : '参考图读取失败。');
      }
    } finally {
      imageReadInProgressRef.current = false;
      if (mountedRef.current) setIsReadingImages(false);
    }
  }, [commitReferences, isUnderstanding]);

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void addImageFiles(files);
  };

  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const imageFiles: File[] = [];
    for (const item of Array.from(event.clipboardData.items)) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) imageFiles.push(file);
    }
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void addImageFiles(imageFiles);
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    void addImageFiles(Array.from(event.dataTransfer.files));
  };

  const submitUnderstanding = async () => {
    if (
      !instructionIsValid ||
      isReadingImages ||
      isUnderstanding ||
      understandingAbortRef.current
    ) return;
    cutoutSessionEpochRef.current += 1;
    for (const operation of cutoutOperationsRef.current.values()) {
      operation.controller.abort();
    }
    cutoutOperationsRef.current.clear();
    const controller = new AbortController();
    const sequence = ++requestSequenceRef.current;
    understandingAbortRef.current = controller;
    setIsUnderstanding(true);
    setUnderstandingError('');
    setUnderstandingConfirmed(false);
    setAnalysis(null);
    setAnalysisMeta(null);
    setCandidates([]);
    setSelectedCandidateId(null);
    setReviewsByCandidateId({});
    setActiveCutoutCandidateId(null);
    setCutoutElapsedMs(0);
    setPreviewVersion('raw');
    setGenerationError('');
    setApplyError('');
    setApplyRequiresNewTarget(false);
    try {
      const response = await garmentAiFetch('/api/garment-mockup/logo-redraw/understand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          instruction: instruction.trim(),
          images: requestReferences(referencesRef.current),
        }),
      });
      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `理解 Logo 要求失败（HTTP ${response.status}）`));
      }
      const body: unknown = await response.json();
      const parsedBody = parseAnalysisResponse(body);
      if (!parsedBody) {
        throw new Error('Logo 理解接口没有返回完整结果。');
      }
      if (!mountedRef.current || requestSequenceRef.current !== sequence) return;
      setAnalysis(parsedBody.analysis);
      setAnalysisMeta({ model: parsedBody.model, durationMs: parsedBody.durationMs });
      setStep(2);
    } catch (error) {
      if (
        !mountedRef.current ||
        requestSequenceRef.current !== sequence ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) return;
      setUnderstandingError(requestFailureMessage(error, '理解 Logo 要求失败'));
    } finally {
      if (mountedRef.current && requestSequenceRef.current === sequence) {
        setIsUnderstanding(false);
        understandingAbortRef.current = null;
      }
    }
  };

  const runCandidateCutout = useCallback(async (
    candidateId: string,
    rawDataUrl: string
  ) => {
    if (cutoutOperationsRef.current.size > 0) return;
    const controller = new AbortController();
    const token = ++cutoutTokenRef.current;
    const sessionEpoch = cutoutSessionEpochRef.current;
    const startedAt = Date.now();
    const operation: CandidateCutoutOperation = {
      controller,
      token,
      rawDataUrl,
      sessionEpoch,
      startedAt,
    };
    cutoutOperationsRef.current.set(candidateId, operation);
    cutoutStartedAtRef.current = startedAt;
    setActiveCutoutCandidateId(candidateId);
    setCutoutElapsedMs(0);
    setPreviewVersion('raw');
    setCandidates(current => current.map(candidate => (
      candidate.id === candidateId && candidate.rawDataUrl === rawDataUrl
        ? {
            ...candidate,
            cutoutToken: token,
            dataUrl: rawDataUrl,
            transparentDataUrl: undefined,
            transparentWidth: undefined,
            transparentHeight: undefined,
            cutoutStatus: 'processing',
            cutoutError: undefined,
            cutoutDurationMs: undefined,
          }
        : candidate
    )));
    setReviewsByCandidateId(current => ({
      ...current,
      [candidateId]: { text: false, color: false, structure: false },
    }));

    const operationIsCurrent = () => {
      const current = cutoutOperationsRef.current.get(candidateId);
      return Boolean(
        mountedRef.current &&
        cutoutSessionEpochRef.current === sessionEpoch &&
        current?.token === token &&
        current.rawDataUrl === rawDataUrl &&
        current.controller === controller &&
        !controller.signal.aborted
      );
    };

    try {
      const response = await garmentAiFetch('/api/garment-mockup/remove-bg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ base64Image: rawDataUrl }),
      });
      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `Logo 抠图失败（HTTP ${response.status}）`));
      }
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        typeof (body as { mask?: unknown }).mask !== 'string' ||
        typeof (body as { original?: unknown }).original !== 'string'
      ) {
        throw new Error('Logo 抠图接口没有返回有效遮罩。');
      }
      const { mask, original } = body as { mask: string; original: string };
      const transparentDataUrl = await erodedLogoMaskDataUrl(mask, original, 0);
      const transparentDimensions = await inspectTransparentImage(transparentDataUrl);
      if (!operationIsCurrent()) return;
      const cutoutDurationMs = Date.now() - startedAt;
      setCandidates(current => current.map(candidate => (
        candidate.id === candidateId &&
        candidate.rawDataUrl === rawDataUrl &&
        candidate.cutoutToken === token
          ? {
              ...candidate,
              dataUrl: transparentDataUrl,
              transparentDataUrl,
              width: transparentDimensions.width,
              height: transparentDimensions.height,
              transparentWidth: transparentDimensions.width,
              transparentHeight: transparentDimensions.height,
              cutoutStatus: 'ready',
              cutoutError: undefined,
              cutoutDurationMs,
            }
          : candidate
      )));
      setCutoutElapsedMs(cutoutDurationMs);
      setPreviewVersion('transparent');
    } catch (error) {
      if (
        !operationIsCurrent() ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) return;
      const cutoutDurationMs = Date.now() - startedAt;
      const cutoutError = requestFailureMessage(error, 'Logo 抠图失败');
      setCandidates(current => current.map(candidate => (
        candidate.id === candidateId &&
        candidate.rawDataUrl === rawDataUrl &&
        candidate.cutoutToken === token
          ? {
              ...candidate,
              dataUrl: rawDataUrl,
              transparentDataUrl: undefined,
              transparentWidth: undefined,
              transparentHeight: undefined,
              width: candidate.rawWidth,
              height: candidate.rawHeight,
              cutoutStatus: 'failed',
              cutoutError,
              cutoutDurationMs,
            }
          : candidate
      )));
      setCutoutElapsedMs(cutoutDurationMs);
      setPreviewVersion('raw');
    } finally {
      if (operationIsCurrent()) {
        cutoutOperationsRef.current.delete(candidateId);
        setActiveCutoutCandidateId(null);
      }
    }
  }, []);

  const runGeneration = async (origin: GenerationOrigin) => {
    if (
      !analysis ||
      analysis.status !== 'ready_for_confirmation' ||
      !understandingConfirmed ||
      isGenerating ||
      generationAbortRef.current ||
      cutoutOperationsRef.current.size > 0 ||
      isApplying ||
      candidates.length >= 3
    ) return;
    const controller = new AbortController();
    const sequence = ++requestSequenceRef.current;
    generationAbortRef.current = controller;
    generationOriginRef.current = origin;
    generationStartedAtRef.current = Date.now();
    setGenerationElapsedMs(0);
    setGenerationError('');
    setApplyError('');
    setIsGenerating(true);
    setStep(3);
    let generatedCandidate: CandidateEntry | null = null;
    try {
      const response = await garmentAiFetch('/api/garment-mockup/logo-redraw/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          instruction: instruction.trim(),
          images: requestReferences(referencesRef.current),
          analysis,
          confirmed: true,
        }),
      });
      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, `生成 Logo 失败（HTTP ${response.status}）`));
      }
      const body: unknown = await response.json();
      if (!isGenerationResponse(body)) {
        throw new Error('Logo 生成接口没有返回有效 PNG。');
      }
      if (!mountedRef.current || requestSequenceRef.current !== sequence) return;
      const candidate: CandidateEntry = {
        id: newEntryId('candidate'),
        dataUrl: body.image.dataUrl,
        rawDataUrl: body.image.dataUrl,
        transparentDataUrl: undefined,
        contentType: body.image.contentType,
        model: body.image.model,
        width: body.image.width,
        height: body.image.height,
        rawWidth: body.image.width,
        rawHeight: body.image.height,
        transparentWidth: undefined,
        transparentHeight: undefined,
        durationMs: body.durationMs,
        cutoutStatus: 'processing',
        cutoutError: undefined,
        cutoutDurationMs: undefined,
        cutoutToken: 0,
      };
      generatedCandidate = candidate;
      setCandidates(current => [...current, candidate].slice(-3));
      setSelectedCandidateId(candidate.id);
      setReviewsByCandidateId(current => ({
        ...current,
        [candidate.id]: { text: false, color: false, structure: false },
      }));
      setPreviewBackground('transparent');
      setPreviewVersion('raw');
      setApplyRequiresNewTarget(false);
      setStep(4);
    } catch (error) {
      if (
        !mountedRef.current ||
        requestSequenceRef.current !== sequence ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) return;
      setGenerationElapsedMs(Date.now() - generationStartedAtRef.current);
      setGenerationError(requestFailureMessage(error, '生成 Logo 失败'));
      setStep(origin === 'review' ? 4 : 3);
    } finally {
      if (mountedRef.current && requestSequenceRef.current === sequence) {
        setIsGenerating(false);
        generationAbortRef.current = null;
        setConfirmationAction(current =>
          current === 'stop-generation' ? null : current
        );
      }
    }
    if (
      generatedCandidate &&
      mountedRef.current &&
      requestSequenceRef.current === sequence
    ) {
      void runCandidateCutout(
        generatedCandidate.id,
        generatedCandidate.rawDataUrl
      );
    }
  };

  const stopGeneration = () => {
    if (!generationAbortRef.current) {
      setConfirmationAction(null);
      return;
    }
    requestSequenceRef.current += 1;
    generationAbortRef.current?.abort();
    generationAbortRef.current = null;
    setGenerationElapsedMs(Date.now() - generationStartedAtRef.current);
    setIsGenerating(false);
    setConfirmationAction(null);
    setStep(generationOriginRef.current === 'review' ? 4 : 2);
  };

  const stopActiveCutoutForEditing = () => {
    const candidateId = activeCutoutCandidateId;
    if (!candidateId) return;
    const operation = cutoutOperationsRef.current.get(candidateId);
    if (!operation) return;
    const cutoutDurationMs = Date.now() - operation.startedAt;
    cutoutSessionEpochRef.current += 1;
    operation.controller.abort();
    cutoutOperationsRef.current.delete(candidateId);
    setActiveCutoutCandidateId(null);
    setCutoutElapsedMs(cutoutDurationMs);
    setCandidates(current => current.map(candidate => (
      candidate.id === candidateId &&
      candidate.rawDataUrl === operation.rawDataUrl &&
      candidate.cutoutToken === operation.token &&
      candidate.cutoutStatus === 'processing'
        ? {
            ...candidate,
            dataUrl: candidate.rawDataUrl,
            transparentDataUrl: undefined,
            transparentWidth: undefined,
            transparentHeight: undefined,
            width: candidate.rawWidth,
            height: candidate.rawHeight,
            cutoutStatus: 'failed',
            cutoutError: '已停止抠图；可返回候选页重新抠图。',
            cutoutDurationMs,
          }
        : candidate
    )));
    setPreviewVersion('raw');
  };

  const returnToDescription = () => {
    stopActiveCutoutForEditing();
    setStep(1);
  };

  const confirmClose = () => {
    requestSequenceRef.current += 1;
    cutoutSessionEpochRef.current += 1;
    understandingAbortRef.current?.abort();
    generationAbortRef.current?.abort();
    for (const operation of cutoutOperationsRef.current.values()) {
      operation.controller.abort();
    }
    cutoutOperationsRef.current.clear();
    understandingAbortRef.current = null;
    generationAbortRef.current = null;
    setConfirmationAction(null);
    onClose();
  };

  const toggleReview = (key: ReviewKey) => {
    if (
      !selectedCandidate ||
      selectedCandidate.cutoutStatus !== 'ready' ||
      !selectedCandidate.transparentDataUrl ||
      previewVersion !== 'transparent' ||
      isCuttingOut ||
      isApplying ||
      applyRequiresNewTarget
    ) return;
    setReviewsByCandidateId(current => {
      const existing = current[selectedCandidate.id] ?? { text: false, color: false, structure: false };
      return {
        ...current,
        [selectedCandidate.id]: { ...existing, [key]: !existing[key] },
      };
    });
    setApplyError('');
  };

  const retrySelectedCandidateCutout = () => {
    if (
      !selectedCandidate ||
      selectedCandidate.cutoutStatus !== 'failed' ||
      cutoutOperationsRef.current.size > 0 ||
      isApplying
    ) return;
    void runCandidateCutout(
      selectedCandidate.id,
      selectedCandidate.rawDataUrl
    );
  };

  const applySelectedCandidate = async () => {
    if (
      !selectedCandidate ||
      selectedCandidate.cutoutStatus !== 'ready' ||
      !selectedCandidate.transparentDataUrl ||
      previewVersion !== 'transparent' ||
      !reviewComplete ||
      isApplying ||
      isCuttingOut ||
      applyRequiresNewTarget
    ) return;
    const candidate: LogoRedrawCandidate = {
      dataUrl: selectedCandidate.transparentDataUrl,
      rawDataUrl: selectedCandidate.rawDataUrl,
      transparentDataUrl: selectedCandidate.transparentDataUrl,
      width: selectedCandidate.width,
      height: selectedCandidate.height,
      rawWidth: selectedCandidate.rawWidth,
      rawHeight: selectedCandidate.rawHeight,
      transparentWidth: selectedCandidate.transparentWidth,
      transparentHeight: selectedCandidate.transparentHeight,
      model: selectedCandidate.model,
      durationMs: selectedCandidate.durationMs,
      contentType: selectedCandidate.contentType,
      cutoutStatus: selectedCandidate.cutoutStatus,
      cutoutError: selectedCandidate.cutoutError,
      cutoutDurationMs: selectedCandidate.cutoutDurationMs,
    };
    setIsApplying(true);
    setApplyError('');
    try {
      await onApply(candidate);
      if (mountedRef.current) onClose();
    } catch (error) {
      if (mountedRef.current) {
        const targetIsStale = error instanceof LogoRedrawTargetStaleError;
        setApplyRequiresNewTarget(targetIsStale);
        setApplyError(
          targetIsStale
            ? `${error.message}。请关闭流程并重新选择画布目标。`
            : error instanceof Error
              ? error.message
              : '应用 Logo 失败。'
        );
      }
    } finally {
      if (mountedRef.current) setIsApplying(false);
    }
  };

  const downloadCandidateImage = (snapshot: {
    candidateId: string;
    candidateNumber: number;
    dataUrl: string;
    suffix: 'raw' | 'transparent';
  }) => {
    if (isApplying || !snapshot.candidateId || !snapshot.dataUrl) return;
    const link = document.createElement('a');
    link.href = snapshot.dataUrl;
    link.download = `logo-redraw-${snapshot.candidateNumber}-${snapshot.suffix}.png`;
    link.click();
  };

  const renderStepOne = () => (
    <div className="mx-auto grid w-full max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
        <div className="mb-5">
          <h2 className="text-xl font-semibold text-ink">描述你想要的 Logo</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
            先写清最终文字、颜色、图形与排版。参考图可不上传，也可以点按钮、拖入或直接粘贴。
          </p>
        </div>

        <div
          onPaste={onPaste}
          onDragEnter={event => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={event => event.preventDefault()}
          onDragLeave={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
          }}
          onDrop={onDrop}
          className={`rounded-2xl border bg-white transition-colors ${dragActive ? 'border-brand-500 bg-brand-50/50' : 'border-border'}`}
        >
          <textarea
            ref={textareaRef}
            value={instruction}
            onChange={event => updateInstruction(event.target.value)}
            maxLength={LOGO_REDRAW_MAX_INSTRUCTION_LENGTH}
            rows={7}
            disabled={isUnderstanding}
            aria-label="Logo 重绘要求"
            placeholder="例如：保留盾牌轮廓和 NORTHLAB 字样，主色改为深绿色，去掉底部小字，整体更简洁，并输出透明背景。"
            className="block w-full resize-none rounded-t-2xl border-0 bg-transparent px-4 py-4 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-3 focus:ring-0"
          />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-2.5">
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                className="hidden"
                onChange={onFileInputChange}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={references.length >= LOGO_REDRAW_MAX_IMAGES || isReadingImages || isUnderstanding}
                aria-label="添加 Logo 参考图"
              >
                {isReadingImages
                  ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                  : <ImagePlus size={16} aria-hidden="true" />}
                添加参考图
              </Button>
              <span className="hidden text-xs text-ink-3 sm:inline">也可粘贴或拖入</span>
            </div>
            <span className={`text-xs ${instruction.length >= LOGO_REDRAW_MAX_INSTRUCTION_LENGTH ? 'text-amber-700' : 'text-ink-3'}`}>
              {instruction.length}/{LOGO_REDRAW_MAX_INSTRUCTION_LENGTH}
            </span>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Logo 描述快捷词">
          <span className="text-xs text-ink-3">快捷补充</span>
          {quickPhrases.map(phrase => (
            <button
              key={phrase.text}
              type="button"
              onClick={() => appendQuickPhrase(phrase.text)}
              disabled={
                isUnderstanding ||
                instruction.includes(phrase.text) ||
                instruction.length + phrase.text.length + 1 > LOGO_REDRAW_MAX_INSTRUCTION_LENGTH
              }
              className="rounded-full border border-border bg-white px-2.5 py-1 text-xs text-ink-2 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {phrase.label}
            </button>
          ))}
        </div>

        {dragActive && (
          <p className="mt-2 text-center text-sm font-medium text-brand-700">松开即可添加参考图</p>
        )}
        {referenceError && <div className="mt-3"><StatusMessage tone="warning">{referenceError}</StatusMessage></div>}

        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-ink">参考图（可选）</h3>
            <span className="text-xs text-ink-3">{references.length}/{LOGO_REDRAW_MAX_IMAGES} 张</span>
          </div>
          {references.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-canvas px-4 py-5 text-center">
              <FileImage size={22} className="mx-auto text-ink-3" aria-hidden="true" />
              <p className="mt-2 text-sm text-ink-2">未添加参考图，将按文字要求创建新 Logo。</p>
              <p className="mt-1 text-xs text-ink-3">系统不会声称看过或复刻不存在的原 Logo。</p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {references.map(reference => (
                <div key={reference.id} className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-canvas p-2.5">
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-white">
                    <img src={reference.previewUrl} alt={reference.fileName} className="max-h-full max-w-full object-contain" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{reference.fileName}</p>
                    <p className="mt-1 text-xs text-ink-3">
                      参考 {references.findIndex(item => item.id === reference.id) + 1} · {reference.source === 'current' ? '当前 Logo（默认参考）' : '补充参考图'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => commitReferences(referencesRef.current.filter(item => item.id !== reference.id))}
                    disabled={isUnderstanding}
                    className="rounded-lg p-2 text-ink-3 transition-colors hover:bg-red-50 hover:text-red-600"
                    aria-label={`移除参考图 ${reference.fileName}`}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {currentLogoReference &&
            !references.some(reference => reference.source === 'current') &&
            references.length < LOGO_REDRAW_MAX_IMAGES && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                disabled={isUnderstanding}
                onClick={() => commitReferences([
                  {
                    ...currentLogoReference,
                    id: newEntryId('current-logo'),
                    source: 'current',
                  },
                  ...referencesRef.current,
                ])}
              >
                <RotateCcw size={14} aria-hidden="true" />
                重新加入当前 Logo
              </Button>
            )}
          <p className="mt-2 text-xs text-ink-3">PNG、JPEG 或 WebP，单张不超过 8MB。</p>
        </div>

        {understandingError && <div className="mt-4"><StatusMessage tone="error">{understandingError}</StatusMessage></div>}
      </section>

      <aside className="rounded-2xl border border-border bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Sparkles size={17} className="text-brand-600" aria-hidden="true" />
          怎样描述更准确
        </div>
        <ol className="mt-4 space-y-4 text-sm text-ink-2">
          <li><span className="font-medium text-ink">1. 最终保留什么</span><p className="mt-1 text-xs leading-relaxed text-ink-3">图形、文字，以及它们的相对位置。</p></li>
          <li><span className="font-medium text-ink">2. 具体修改什么</span><p className="mt-1 text-xs leading-relaxed text-ink-3">改字、改色、删元素或调整排版。</p></li>
          <li><span className="font-medium text-ink">3. 说清最终结果</span><p className="mt-1 text-xs leading-relaxed text-ink-3">尤其要逐字写出 Logo 最终文字。</p></li>
        </ol>
        <div className="mt-5 rounded-xl bg-amber-50 px-3 py-3 text-xs leading-relaxed text-amber-800">
          AI 只负责理解和生成候选，文字、颜色与结构仍需你在应用前逐项复核。
        </div>
      </aside>
    </div>
  );

  const renderStepTwo = () => {
    if (!analysis) {
      return (
        <div className="mx-auto max-w-xl rounded-2xl border border-border bg-white p-6 text-center shadow-sm">
          <AlertTriangle size={28} className="mx-auto text-amber-600" aria-hidden="true" />
          <h2 ref={stepHeadingRef} tabIndex={-1} className="mt-3 text-lg font-semibold text-ink outline-none">还没有可确认的理解结果</h2>
          <p className="mt-2 text-sm text-ink-2">请返回描述页，重新让 AI 理解要求。</p>
        </div>
      );
    }
    const needsClarification = analysis.status === 'needs_clarification';
    return (
      <div className="mx-auto grid w-full max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="rounded-2xl border border-border bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 ref={stepHeadingRef} tabIndex={-1} className="text-xl font-semibold text-ink outline-none">确认 AI 对要求的理解</h2>
              <p className="mt-1.5 text-sm text-ink-2">这一步只确认要求，不会自动生成或替换画布中的 Logo。</p>
            </div>
            {analysisMeta && (
              <span className="rounded-full bg-canvas px-3 py-1 text-xs text-ink-3" title={analysisMeta.model}>
                理解用时 {formatDuration(analysisMeta.durationMs)}
              </span>
            )}
          </div>

          <div className="mt-5 rounded-2xl border border-brand-200 bg-brand-50/60 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-brand-700">完整理解</p>
            <p className="mt-2 text-base font-medium leading-relaxed text-ink">{analysis.summary}</p>
          </div>

          {needsClarification && (
            <div className="mt-4">
              <StatusMessage tone="warning">
                <p className="font-medium">还有内容无法唯一确定，请返回补充：</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {analysis.ambiguities.map(item => <li key={item}>{item}</li>)}
                </ul>
              </StatusMessage>
            </div>
          )}

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-semibold text-ink">必须保留</h3>
              {analysis.keep.length > 0 ? (
                <ul className="mt-3 space-y-2 text-sm text-ink-2">
                  {analysis.keep.map(item => <li key={item} className="flex gap-2"><Check size={15} className="mt-0.5 shrink-0 text-brand-600" aria-hidden="true" />{item}</li>)}
                </ul>
              ) : <p className="mt-3 text-sm text-ink-3">没有指定保留项。</p>}
            </div>
            <div className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-semibold text-ink">必须修改或删除</h3>
              {analysis.change.length > 0 ? (
                <ul className="mt-3 space-y-2 text-sm text-ink-2">
                  {analysis.change.map(item => <li key={item} className="flex gap-2"><ArrowLeft size={15} className="mt-0.5 shrink-0 rotate-180 text-amber-600" aria-hidden="true" />{item}</li>)}
                </ul>
              ) : <p className="mt-3 text-sm text-ink-3">没有指定修改项。</p>}
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-border">
            {[
              ['最终构成', analysis.output.description],
              ['最终文字', analysis.output.targetText || '无可见文字'],
              ['颜色', analysis.output.color || '未指定固定颜色'],
              ['排版', analysis.output.layout],
              ['背景', analysis.output.background],
            ].map(([label, value]) => (
              <div key={label} className="grid gap-1 border-b border-border px-4 py-3 last:border-0 sm:grid-cols-[96px_1fr]">
                <span className="text-xs font-medium text-ink-3">{label}</span>
                <span className="text-sm leading-relaxed text-ink">{value}</span>
              </div>
            ))}
          </div>

          {!needsClarification && (
            <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 hover:bg-canvas">
              <input
                type="checkbox"
                checked={understandingConfirmed}
                onChange={event => setUnderstandingConfirmed(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-500"
              />
              <span>
                <span className="block text-sm font-medium text-ink">我已逐项核对，上述理解可以用于生成</span>
                <span className="mt-1 block text-xs leading-relaxed text-ink-3">生成后仍需人工复核结果中的文字、颜色和图形结构。</span>
              </span>
            </label>
          )}
        </section>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-ink">理解置信度</h3>
            <div className="mt-3 space-y-3">
              {([
                ['文字', analysis.confidence.text],
                ['颜色', analysis.confidence.color],
                ['结构', analysis.confidence.structure],
              ] as const).map(([label, confidence]) => (
                <div key={label} className="flex items-center justify-between text-sm">
                  <span className="text-ink-2">{label}</span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${confidence === 'high' ? 'bg-brand-50 text-brand-700' : confidence === 'medium' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>
                    {confidenceLabels[confidence]}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs leading-relaxed text-ink-3">置信度只是风险提示，不代表已经验证正确，也不使用虚构百分比。</p>
          </div>
          <div className="rounded-2xl border border-border bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-ink">参考依据</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              {references.length > 0
                ? `本次使用文字要求和 ${references.length} 张真实参考图。`
                : '本次仅使用文字要求创建，没有参考图，不会标记为原 Logo 复刻。'}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-4 w-full"
              onClick={() => {
                setUnderstandingConfirmed(false);
                returnToDescription();
              }}
            >
              理解不准确，返回修改
            </Button>
          </div>
        </aside>
      </div>
    );
  };

  const renderStepThree = () => (
    <div className="mx-auto flex min-h-[52vh] w-full max-w-2xl items-center justify-center">
      <section className="w-full rounded-2xl border border-border bg-white p-6 text-center shadow-sm sm:p-10">
        {isGenerating ? (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
              <LoaderCircle size={32} className="animate-spin" aria-hidden="true" />
            </div>
            <h2 ref={stepHeadingRef} tabIndex={-1} className="mt-5 text-xl font-semibold text-ink outline-none">正在生成 Logo 原图</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">原图返回后会立即进入候选页，再使用独立抠图服务处理透明背景；完成前不会改动画布。</p>
            <div className="mt-4 rounded-xl bg-canvas px-4 py-3 text-left text-sm text-ink-2">
              <p className="font-medium text-ink">{analysis?.summary ?? '已确认 Logo 要求'}</p>
              <p className="mt-1 text-xs text-ink-3">本轮使用 {references.length} 张参考图；一般需要约 30–120 秒。</p>
            </div>
            <div className="mt-4 grid gap-2 text-left text-xs text-ink-2 sm:grid-cols-3">
              <span className="rounded-lg bg-brand-50 px-3 py-2 text-brand-700">✓ 需求已确认</span>
              <span className="rounded-lg bg-brand-50 px-3 py-2 text-brand-700">正在生成原图</span>
              <span className="rounded-lg bg-canvas px-3 py-2 text-ink-3">等待独立抠图与复核</span>
            </div>
            <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-canvas px-3 py-1.5 text-sm text-ink-2">
              <Clock3 size={15} aria-hidden="true" />
              已用时 {formatDuration(generationElapsedMs)}
            </div>
            <p className="mt-3 text-xs text-ink-3">生成时长由模型决定，此处仅显示真实经过时间，不估算百分比。</p>
          </>
        ) : (
          <>
            <AlertTriangle size={34} className="mx-auto text-red-600" aria-hidden="true" />
            <h2 ref={stepHeadingRef} tabIndex={-1} className="mt-4 text-xl font-semibold text-ink outline-none">本次生成没有完成</h2>
            <p className="mt-2 text-sm text-ink-2">实际等待 {formatDuration(generationElapsedMs)}</p>
            {generationError && <div className="mt-5 text-left"><StatusMessage tone="error">{generationError}</StatusMessage></div>}
          </>
        )}
      </section>
    </div>
  );

  const renderStepFour = () => {
    if (!selectedCandidate || !analysis) {
      return (
        <div className="mx-auto max-w-xl rounded-2xl border border-border bg-white p-6 text-center shadow-sm">
          <AlertTriangle size={28} className="mx-auto text-amber-600" aria-hidden="true" />
          <h2 ref={stepHeadingRef} tabIndex={-1} className="mt-3 text-lg font-semibold text-ink outline-none">还没有可复核的 Logo 候选</h2>
          <p className="mt-2 text-sm text-ink-2">请返回确认页开始生成。</p>
        </div>
      );
    }

    const selectedCandidateIndex = candidates.findIndex(
      candidate => candidate.id === selectedCandidate.id
    );
    const selectedTransparentReady =
      selectedCandidate.cutoutStatus === 'ready' &&
      Boolean(selectedCandidate.transparentDataUrl);
    const transparentDownloadDataUrl = selectedCandidate.transparentDataUrl;
    const selectedPreviewDataUrl =
      previewVersion === 'transparent' && selectedCandidate.transparentDataUrl
        ? selectedCandidate.transparentDataUrl
        : selectedCandidate.rawDataUrl;
    const transparentKeepsRawCanvas =
      selectedCandidate.transparentWidth === selectedCandidate.rawWidth &&
      selectedCandidate.transparentHeight === selectedCandidate.rawHeight;
    const resultControlsLocked = isApplying || isCuttingOut || isGenerating;
    const reviewControlsLocked =
      resultControlsLocked ||
      applyRequiresNewTarget ||
      previewVersion !== 'transparent' ||
      !selectedTransparentReady;

    const previewStyle = previewBackground === 'transparent'
      ? {
          backgroundColor: '#ffffff',
          backgroundImage: 'linear-gradient(45deg, #e5e7eb 25%, transparent 25%), linear-gradient(-45deg, #e5e7eb 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e7eb 75%), linear-gradient(-45deg, transparent 75%, #e5e7eb 75%)',
          backgroundSize: '20px 20px',
          backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
        }
      : { backgroundColor: previewBackground === 'white' ? '#ffffff' : '#17201d' };

    return (
      <div className="mx-auto grid w-full max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-2xl border border-border bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 ref={stepHeadingRef} tabIndex={-1} className="text-xl font-semibold text-ink outline-none">复核生成结果</h2>
              <p className="mt-1 text-sm text-ink-2">
                {candidates.length > 1
                  ? `当前查看候选 ${selectedCandidateIndex + 1} / ${candidates.length}；切换候选不会继承其他候选的复核结果。`
                  : '当前只有 1 个真实候选；重新生成后才会出现候选切换。'}
              </p>
            </div>
            <div className="flex items-center rounded-lg border border-border p-1" role="group" aria-label="预览背景">
              {([
                ['transparent', '透明格'],
                ['white', '白色'],
                ['dark', '深色'],
              ] as const).map(([background, label]) => (
                <button
                  key={background}
                  type="button"
                  onClick={() => setPreviewBackground(background)}
                  disabled={resultControlsLocked}
                  aria-pressed={previewBackground === background}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${previewBackground === background ? 'bg-brand-50 text-brand-700' : 'text-ink-3 hover:bg-canvas hover:text-ink'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center rounded-lg border border-border p-1" role="group" aria-label="候选图片版本">
              <button
                type="button"
                onClick={() => setPreviewVersion('raw')}
                disabled={resultControlsLocked}
                aria-pressed={previewVersion === 'raw'}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${previewVersion === 'raw' ? 'bg-brand-50 text-brand-700' : 'text-ink-3 hover:bg-canvas hover:text-ink'}`}
              >
                生成原图
              </button>
              <button
                type="button"
                onClick={() => setPreviewVersion('transparent')}
                disabled={resultControlsLocked || !selectedTransparentReady}
                aria-pressed={previewVersion === 'transparent'}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${previewVersion === 'transparent' ? 'bg-brand-50 text-brand-700' : 'text-ink-3 hover:bg-canvas hover:text-ink'}`}
              >
                透明图
              </button>
            </div>
            <span className="text-xs text-ink-3">
              当前预览：{previewVersion === 'transparent' && selectedTransparentReady ? '透明图' : '生成原图'}
            </span>
          </div>

          <div className="mt-4 flex min-h-[360px] items-center justify-center overflow-hidden rounded-2xl border border-border p-8" style={previewStyle}>
            <img
              src={selectedPreviewDataUrl}
              alt={`Logo 候选 ${selectedCandidateIndex + 1}${previewVersion === 'transparent' && selectedTransparentReady ? '透明图' : '生成原图'}`}
              className="max-h-[430px] max-w-full object-contain drop-shadow-sm"
            />
          </div>

          <div className="mt-4">
            {selectedCandidate.cutoutStatus === 'processing' ? (
              <StatusMessage tone="info">
                原图已生成，正在使用独立抠图服务处理透明背景。已用时 {formatDuration(cutoutElapsedMs)}；此时不会再次调用 Logo 生成接口。
              </StatusMessage>
            ) : selectedCandidate.cutoutStatus === 'failed' ? (
              <StatusMessage tone="error">
                <p className="font-medium">透明背景处理失败，生成原图已保留。</p>
                <p className="mt-1">{selectedCandidate.cutoutError || '请重新抠图或下载原图。'}</p>
              </StatusMessage>
            ) : (
              <StatusMessage tone="info">
                透明图已就绪，抠图用时 {formatDuration(selectedCandidate.cutoutDurationMs ?? 0)}。原图与透明图均已保留。
                {transparentKeepsRawCanvas
                  ? ` 本次只合成透明通道、不裁切画布，透明图与原图均为 ${selectedCandidate.rawWidth} × ${selectedCandidate.rawHeight}。`
                  : ` 透明图实际尺寸为 ${selectedCandidate.transparentWidth} × ${selectedCandidate.transparentHeight}，原图为 ${selectedCandidate.rawWidth} × ${selectedCandidate.rawHeight}。`}
              </StatusMessage>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            {candidates.length > 1 ? (
              <div className="flex min-w-0 gap-2 overflow-x-auto pb-1">
              {candidates.map((candidate, index) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => {
                    setSelectedCandidateId(candidate.id);
                    setPreviewVersion(
                      candidate.cutoutStatus === 'ready' && candidate.transparentDataUrl
                        ? 'transparent'
                        : 'raw'
                    );
                    if (!applyRequiresNewTarget) setApplyError('');
                  }}
                  disabled={resultControlsLocked}
                  aria-pressed={candidate.id === selectedCandidate.id}
                  className={`flex shrink-0 items-center gap-2 rounded-xl border p-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${candidate.id === selectedCandidate.id ? 'border-brand-500 bg-brand-50' : 'border-border hover:bg-canvas'}`}
                >
                  <span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-md bg-white">
                    <img src={candidate.transparentDataUrl ?? candidate.rawDataUrl} alt="" className="max-h-full max-w-full object-contain" />
                  </span>
                  <span>
                    <span className="block text-xs font-medium text-ink">候选 {index + 1}</span>
                    <span className="block text-[11px] text-ink-3">
                      {candidate.cutoutStatus === 'processing'
                        ? '正在抠图'
                        : candidate.cutoutStatus === 'ready'
                          ? '透明图就绪'
                          : '抠图失败'}
                    </span>
                  </span>
                </button>
              ))}
              </div>
            ) : (
              <p className="text-xs text-ink-3">首次生成只有这个真实候选；重新生成后才会出现候选切换。</p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => downloadCandidateImage({
                  candidateId: selectedCandidate.id,
                  candidateNumber: selectedCandidateIndex + 1,
                  dataUrl: selectedCandidate.rawDataUrl,
                  suffix: 'raw',
                })}
                disabled={isApplying}
              >
                <Download size={15} aria-hidden="true" />
                下载原图 PNG
              </Button>
              {transparentDownloadDataUrl && selectedCandidate.cutoutStatus === 'ready' && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => downloadCandidateImage({
                    candidateId: selectedCandidate.id,
                    candidateNumber: selectedCandidateIndex + 1,
                    dataUrl: transparentDownloadDataUrl,
                    suffix: 'transparent',
                  })}
                  disabled={isApplying}
                >
                  <Download size={15} aria-hidden="true" />
                  下载透明 PNG
                </Button>
              )}
              {selectedCandidate.cutoutStatus === 'failed' && (
                <Button
                  variant="soft"
                  size="sm"
                  onClick={retrySelectedCandidateCutout}
                  disabled={isApplying || isCuttingOut || isGenerating}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  重新抠图
                </Button>
              )}
            </div>
          </div>
          <p className="mt-3 truncate text-xs text-ink-3" title={selectedCandidate.model}>
            {selectedCandidate.width} × {selectedCandidate.height} · 原图生成 {formatDuration(selectedCandidate.durationMs)}
            {selectedCandidate.cutoutDurationMs !== undefined ? ` · 抠图 ${formatDuration(selectedCandidate.cutoutDurationMs)}` : ''} · {selectedCandidate.model}
          </p>
          {generationError && <div className="mt-4"><StatusMessage tone="error">重新生成未完成：{generationError}</StatusMessage></div>}
          {candidates.length >= 3 && (
            <div className="mt-4">
              <StatusMessage tone="info">本轮已生成 3 个候选。若都不合适，请返回修改描述并重新确认要求。</StatusMessage>
            </div>
          )}
        </section>

        <aside className="rounded-2xl border border-border bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <ShieldCheck size={18} className="text-brand-600" aria-hidden="true" />
            <h3 className="text-base font-semibold text-ink">应用前人工复核</h3>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-3">
            {selectedTransparentReady
              ? previewVersion === 'transparent'
                ? '只勾选你亲眼核对过的透明图。全部适用项目完成后，应用按钮才会启用。'
                : '当前正在查看生成原图。请切换到透明图后再进行复核和应用。'
              : '透明图尚未就绪。原图可以预览和下载，但不能复核或应用。'}
          </p>

          <div className="mt-4 rounded-xl border border-brand-200 bg-brand-50/60 px-3 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-brand-700">应用目标</p>
            <p className="mt-1 text-sm leading-relaxed text-ink">{applicationTargetLabel}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-3">应用时会再次校验目标；若画布已变化，会停止应用并要求重新选择。</p>
          </div>

          <div className="mt-4 space-y-3">
            {analysis.output.targetText.trim() ? (
              <label className={`flex items-start gap-3 rounded-xl border border-border p-3 ${reviewControlsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-canvas'}`}>
                <input type="checkbox" checked={currentReview.text} onChange={() => toggleReview('text')} disabled={reviewControlsLocked} className="mt-0.5 h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-500" />
                <span className="text-sm leading-relaxed text-ink">文字与“<strong>{analysis.output.targetText}</strong>”逐字一致</span>
              </label>
            ) : (
              <div className="flex items-start gap-3 rounded-xl bg-canvas p-3 text-sm text-ink-3"><CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />本次无可见文字，不需勾选文字项。</div>
            )}
            {analysis.output.color.trim() ? (
              <label className={`flex items-start gap-3 rounded-xl border border-border p-3 ${reviewControlsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-canvas'}`}>
                <input type="checkbox" checked={currentReview.color} onChange={() => toggleReview('color')} disabled={reviewControlsLocked} className="mt-0.5 h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-500" />
                <span className="text-sm leading-relaxed text-ink">颜色符合：<strong>{analysis.output.color}</strong></span>
              </label>
            ) : (
              <div className="flex items-start gap-3 rounded-xl bg-canvas p-3 text-sm text-ink-3"><CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />未指定固定颜色，不需勾选颜色项。</div>
            )}
            <label className={`flex items-start gap-3 rounded-xl border border-border p-3 ${reviewControlsLocked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-canvas'}`}>
              <input type="checkbox" checked={currentReview.structure} onChange={() => toggleReview('structure')} disabled={reviewControlsLocked} className="mt-0.5 h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-500" />
              <span className="text-sm leading-relaxed text-ink">图形结构与排版符合已确认要求</span>
            </label>
          </div>

          <div className="mt-4 rounded-xl bg-amber-50 px-3 py-3 text-xs leading-relaxed text-amber-800">
            {selectedTransparentReady
              ? '结构必须人工判断；即使模型置信度较高，也不会自动代替你勾选。'
              : '抠图失败不会丢失原图，也不会自动重新生成；请重新抠图后再复核。'}
          </div>
          {applyError && <div className="mt-4"><StatusMessage tone="error">{applyError}</StatusMessage></div>}
        </aside>
      </div>
    );
  };

  const renderMain = () => {
    if (step === 1) return renderStepOne();
    if (step === 2) return renderStepTwo();
    if (step === 3) return renderStepThree();
    return renderStepFour();
  };

  const renderFooter = () => {
    if (step === 1) {
      return (
        <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:gap-3">
          <p className="hidden text-xs text-ink-3 sm:block">参考图不是必填；描述至少 1 个字符。</p>
          <div className="ml-auto flex w-full flex-wrap justify-end gap-2 sm:w-auto sm:gap-3">
            {analysis && candidates.length > 0 && (
              <Button variant="ghost" onClick={() => setStep(4)}>返回查看已有候选</Button>
            )}
            <Button variant="secondary" onClick={requestClose}>取消</Button>
            <Button onClick={() => void submitUnderstanding()} disabled={!instructionIsValid || isReadingImages || isUnderstanding} loading={isUnderstanding} loadingText="正在理解要求">
              <Sparkles size={16} aria-hidden="true" />
              {understandingError ? '重试理解' : '继续：确认理解'}
            </Button>
          </div>
        </div>
      );
    }
    if (step === 2) {
      const ready = analysis?.status === 'ready_for_confirmation';
      return (
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <Button variant="secondary" onClick={() => {
            setUnderstandingConfirmed(false);
            returnToDescription();
          }}>
            <ArrowLeft size={16} aria-hidden="true" />
            返回修改描述
          </Button>
          <div className="ml-auto flex w-full flex-wrap justify-end gap-2 sm:w-auto sm:gap-3">
            {candidates.length > 0 && <Button variant="ghost" onClick={() => setStep(4)}>查看已有候选</Button>}
            <Button
              onClick={() => void runGeneration('confirmation')}
              disabled={!ready || !understandingConfirmed || candidates.length >= 3 || isCuttingOut || isApplying}
            >
              <Sparkles size={16} aria-hidden="true" />
              {candidates.length >= 3 ? '已生成 3 个候选' : '确认理解并生成 Logo'}
            </Button>
          </div>
        </div>
      );
    }
    if (step === 3) {
      return isGenerating ? (
        <div className="flex w-full justify-center">
          <Button variant="outlineDanger" onClick={() => setConfirmationAction('stop-generation')}>
            <Square size={14} fill="currentColor" aria-hidden="true" />
            停止等待并返回
          </Button>
        </div>
      ) : (
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <Button variant="secondary" onClick={returnToDescription}>
            <ArrowLeft size={16} aria-hidden="true" />
            返回修改描述
          </Button>
          <Button onClick={() => void runGeneration('confirmation')}>
            <RotateCcw size={16} aria-hidden="true" />
            重试生成
          </Button>
        </div>
      );
    }
    if (applyRequiresNewTarget) {
      return (
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-ink-3">画布目标已变化；当前候选不会被错误覆盖到其他 Logo。</p>
          <Button onClick={confirmClose}>关闭并重新选择目标</Button>
        </div>
      );
    }
    return (
      <div className="flex w-full flex-wrap items-center justify-between gap-3">
        <Button variant="secondary" onClick={returnToDescription} disabled={isApplying}>
          <ArrowLeft size={16} aria-hidden="true" />
          返回修改描述
        </Button>
        <div className="ml-auto flex w-full flex-wrap justify-end gap-2 sm:w-auto sm:gap-3">
          <Button
            variant="secondary"
            onClick={() => void runGeneration('review')}
            disabled={candidates.length >= 3 || isApplying || isCuttingOut || isGenerating}
            title={candidates.length >= 3 ? '最多保留 3 个真实候选' : undefined}
          >
            <RotateCcw size={16} aria-hidden="true" />
            {candidates.length >= 3 ? '已达 3 个候选' : '重新生成一个候选'}
          </Button>
          <Button
            onClick={() => void applySelectedCandidate()}
            disabled={!reviewComplete || isApplying || isCuttingOut || isGenerating}
            loading={isApplying}
            loadingText="正在应用"
          >
            <Check size={16} aria-hidden="true" />
            {mode === 'replace' ? '应用并替换当前 Logo' : '添加到画布'}
          </Button>
        </div>
      </div>
    );
  };

  if (!mounted) return null;

  return createPortal(
    <>
      <div
        ref={shellRef}
        role="dialog"
        aria-modal={confirmationAction ? undefined : true}
        aria-hidden={confirmationAction ? true : undefined}
        inert={confirmationAction ? true : undefined}
        aria-label="Logo 重绘"
        tabIndex={-1}
        className="fixed inset-0 z-[10000] flex h-[100dvh] flex-col bg-canvas"
      >
        <header className="safe-top shrink-0 border-b border-border bg-white px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                <Sparkles size={18} aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold text-ink">Logo 重绘</h1>
                <p className="break-words text-xs leading-snug text-ink-3 sm:truncate" title={applicationTargetLabel}>{applicationTargetLabel}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={requestClose}
              disabled={isApplying}
              className="rounded-lg border border-border bg-white p-2 text-ink-3 transition-colors hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="关闭 Logo 重绘"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          <nav className="mx-auto mt-3 max-w-5xl" aria-label="Logo 重绘步骤">
            <ol className="grid grid-cols-4 gap-1 sm:gap-3">
              {stepLabels.map((label, index) => {
                const stepNumber = index + 1;
                const active = stepNumber === step;
                const complete = stepNumber < step;
                const statusLabel = active ? '进行中' : complete ? '已完成' : '待进行';
                return (
                  <li key={label} className="flex min-w-0 flex-col items-center gap-1 sm:flex-row sm:gap-2">
                    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${active ? 'bg-brand-600 text-white' : complete ? 'bg-brand-50 text-brand-700' : 'bg-canvas text-ink-3'}`}>
                      {complete ? <Check size={13} aria-hidden="true" /> : stepNumber}
                    </span>
                    <span className="min-w-0 text-center sm:text-left" aria-current={active ? 'step' : undefined}>
                      <span className={`block truncate text-[10px] sm:text-xs ${active ? 'font-medium text-ink' : 'text-ink-3'}`}>{label}</span>
                      <span className={`block text-[9px] sm:text-[10px] ${active ? 'text-brand-700' : complete ? 'text-brand-600' : 'text-ink-3'}`}>{statusLabel}</span>
                    </span>
                    {index < stepLabels.length - 1 && <span className="ml-auto hidden h-px min-w-3 flex-1 bg-border sm:block" aria-hidden="true" />}
                  </li>
                );
              })}
            </ol>
          </nav>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
          {renderMain()}
        </main>

        <footer className="safe-bottom shrink-0 border-t border-border bg-white px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-7xl">{renderFooter()}</div>
        </footer>
      </div>

      <ConfirmDialog
        open={confirmationAction !== null}
        layerClassName="z-[10010]"
        title={confirmationAction === 'stop-generation'
          ? '停止本次生成？'
          : isGenerating
            ? '停止生成并退出？'
            : isCuttingOut
              ? '停止抠图并退出？'
            : isUnderstanding
              ? '停止理解并退出？'
              : '退出 Logo 重绘？'}
        description={confirmationAction === 'stop-generation'
          ? '这会停止本页面等待并忽略迟到结果，画布不会改变；请求已提交给模型，不能承诺同步停止上游处理或计费。'
          : isGenerating
            ? '这会停止本页面等待并退出，画布不会改变；请求已提交给模型，不能承诺同步停止上游处理或计费。'
            : isCuttingOut
              ? '这会中止本页面的抠图等待并退出；Logo 原图不会应用到画布，迟到的抠图结果会被忽略。'
            : '尚未应用到画布的描述、理解结果和候选将不会保留。'}
        confirmText={confirmationAction === 'stop-generation'
          ? '停止等待'
          : isGenerating
            ? '停止等待并退出'
            : isCuttingOut
              ? '停止抠图并退出'
            : isUnderstanding
              ? '停止理解并退出'
              : '确认退出'}
        cancelText="继续编辑"
        danger
        onConfirm={confirmationAction === 'stop-generation' ? stopGeneration : confirmClose}
        onCancel={() => setConfirmationAction(null)}
      />
    </>,
    (document.getElementById('garment-editor-portals') || document.body)
  );
}
