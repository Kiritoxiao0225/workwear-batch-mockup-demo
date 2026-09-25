'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as fabric from 'fabric';
import { AligningGuidelines } from 'fabric/extensions';
import { CustomizationState, CanvasElement, ElementType, MOCKUP_TEXT_PLACEHOLDER } from '@/lib/garment-editor/mockup-types';
import type {
  CapturedMockupProduct,
  DecorationRelativeTransform,
  MeasurementAxis,
  TextGradient,
  ObjectTransform,
} from '@/lib/garment-editor/mockup-types';
import { RotateCw, Plus, Minus, Maximize2, Trash2, Copy, Ruler } from 'lucide-react';
import { useToast } from '@/components/garment-editor/ui/toast';
import MeasurementPanel from '@/components/garment-editor/MeasurementPanel';
import type { PendingMeasurementCalibration } from '@/components/garment-editor/MeasurementPanel';
import { detectProductGarmentGeometry } from '@/components/garment-editor/detect-product-garment-geometry';
import {
  drawMockupMeasurementOverlay,
  type MeasurementCalibrationOverlay,
  type MeasurementGuidePreview,
  type MeasurementScenePoint,
} from '@/components/garment-editor/measurement-overlay';
import {
  CANVAS_CORS_ERROR_MESSAGE,
  canvasToDataUrl,
  drawGuidelinesOnlyWithTopContext,
  getNewProductPlacement,
  isRemoteImageUrl,
} from '@/components/garment-editor/editor-canvas-utils';
import {
  createCanvasScale,
  createGuide,
  createMeasurementState,
  createOffsetGuide,
  measurementDistanceCm,
  nextGuideLabel,
  removeElementFromCustomizationState,
  removeGuideFromMeasurements,
  scenePositionFromCm,
} from '@/lib/garment-editor/mockup-measurements';
import {
  copyMockupElement,
  explicitDecorationCaptureMatch,
  isDecorationElement,
  mockupPlacementAnchor,
  setMockupProductGarmentGeometry,
} from '@/lib/garment-editor/mockup-element-relations';

const fontLoadCache = new Set<string>();

const loadFont = async (fontFamily: string): Promise<void> => {
  if (!fontFamily || fontFamily.startsWith('/') || fontLoadCache.has(fontFamily)) return;
  try {
    await document.fonts.load(`12px "${fontFamily}"`);
    fontLoadCache.add(fontFamily);
  } catch (e) {
    console.warn('Font load error:', fontFamily, e);
  }
};

const loadFonts = async (fontFamilies: string[]): Promise<void> => {
  const uniqueFonts = [...new Set(fontFamilies.filter(f => f && !f.startsWith('/')))];
  await Promise.all(uniqueFonts.map(font => loadFont(font)));
};

function makeFabricGradient(gradient: TextGradient): fabric.Gradient<'linear'> {
  const rad = ((90 - gradient.angle) * Math.PI) / 180;
  const x2 = 0.5 + 0.5 * Math.cos(rad);
  const y2 = 0.5 - 0.5 * Math.sin(rad);
  return new fabric.Gradient({
    type: 'linear',
    gradientUnits: 'percentage',
    coords: { x1: 1 - x2, y1: 1 - y2, x2, y2 },
    colorStops: [...gradient.stops]
      .sort((a, b) => a.position - b.position)
      .map(s => ({ offset: s.position / 100, color: s.color })),
  });
}

const TEXT_FONT_SIZE = 30;
const DEFAULT_TEXT_FONT = '文源黑体Regular';
const DEFAULT_ARC_BEND = 60;
const MIN_LEGACY_ARC_RADIUS = 50;
const MAX_LEGACY_ARC_RADIUS = 300;

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function legacyArcRadiusToBend(radius?: number) {
  if (!Number.isFinite(radius)) return DEFAULT_ARC_BEND;
  const clamped = clampNumber(radius!, MIN_LEGACY_ARC_RADIUS, MAX_LEGACY_ARC_RADIUS);
  return Math.round(((MAX_LEGACY_ARC_RADIUS - clamped) / (MAX_LEGACY_ARC_RADIUS - MIN_LEGACY_ARC_RADIUS)) * 100);
}

function getArcBend(element: CanvasElement) {
  if (Number.isFinite(element.arcBend)) return clampNumber(element.arcBend!, 0, 100);
  return legacyArcRadiusToBend(element.arcRadius);
}

function getTextAlign(element: CanvasElement) {
  return element.textAlign ?? 'center';
}

function measureTextWidth(textObj: fabric.IText) {
  const measured = (textObj as any).calcTextWidth?.();
  if (Number.isFinite(measured) && measured > 0) return measured;
  const width = textObj.width || 0;
  return Math.max(width, (textObj.fontSize || TEXT_FONT_SIZE) * 2);
}

function createArcPathForText(textObj: fabric.IText, arcMode: 'up' | 'down', arcBend: number) {
  const fontSize = textObj.fontSize || TEXT_FONT_SIZE;
  const textWidth = Math.max(measureTextWidth(textObj), fontSize * 2);
  const angleDeg = 8 + (clampNumber(arcBend, 0, 100) / 100) * 172;
  const angleRad = (angleDeg * Math.PI) / 180;
  const pathLength = textWidth * 1.04;
  const radius = Math.max(pathLength / angleRad, fontSize * 1.5);
  const halfAngle = angleRad / 2;
  const cosHalf = Math.cos(halfAngle);
  const pointCount = Math.max(12, Math.ceil(angleDeg / 6));
  const yDirection = arcMode === 'down' ? -1 : 1;
  const points: string[] = [];

  for (let i = 0; i <= pointCount; i++) {
    const t = -halfAngle + (angleRad * i) / pointCount;
    const x = radius * Math.sin(t);
    const y = yDirection * (radius * Math.cos(t) - radius * cosHalf);
    points.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`);
  }

  return new fabric.Path(points.join(' '), {
    visible: false,
    fill: '',
    stroke: '',
    strokeWidth: 0,
  });
}

function applyArcPath(textObj: fabric.IText, element: CanvasElement) {
  const isArc = element.arcMode && element.arcMode !== 'none' && (element.text || '').length > 0;
  const path = isArc ? createArcPathForText(textObj, element.arcMode as 'up' | 'down', getArcBend(element)) : undefined;
  textObj.set({
    path,
    pathAlign: 'center' as any,
    pathSide: 'left' as any,
    pathStartOffset: 0,
    textAlign: getTextAlign(element),
  });
  (textObj as any).initDimensions?.();
  textObj.setCoords();
}

// Logarithmic slider mapping for better zoom UX
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const RESTORED_IMAGE_LOAD_TIMEOUT_MS = 8000;
const MIN_LOG = Math.log(MIN_ZOOM);
const MAX_LOG = Math.log(MAX_ZOOM);

const sliderToZoom = (val: number) => Math.exp(MIN_LOG + (val / 100) * (MAX_LOG - MIN_LOG));
const zoomToSlider = (zoom: number) => ((Math.log(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom))) - MIN_LOG) / (MAX_LOG - MIN_LOG)) * 100;

async function loadFabricImage(imageUrl: string, renderSignal: AbortSignal) {
  const imageLoadController = new AbortController();
  const abortImageLoad = () => imageLoadController.abort();
  renderSignal.addEventListener('abort', abortImageLoad, { once: true });
  const timeoutId = window.setTimeout(
    () => imageLoadController.abort(),
    RESTORED_IMAGE_LOAD_TIMEOUT_MS
  );

  try {
    return await fabric.Image.fromURL(imageUrl, {
      ...(isRemoteImageUrl(imageUrl) ? { crossOrigin: 'anonymous' as const } : {}),
      signal: imageLoadController.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
    renderSignal.removeEventListener('abort', abortImageLoad);
  }
}

class ExportSafeAligningGuidelines extends AligningGuidelines {
  beforeRender() {
    drawGuidelinesOnlyWithTopContext(this.canvas, () => super.beforeRender());
  }

  afterRender() {
    drawGuidelinesOnlyWithTopContext(this.canvas, () => super.afterRender());
  }
}

interface EditorProps {
  state: CustomizationState;
  onUpdateState: (updates: Partial<CustomizationState>) => void;
  onSelectElement: (id: string | null, type: ElementType | null) => void;
  selectedElementId?: string | null;
  selectedElementType?: ElementType | null;
  mobileBottomInset?: number;
  exportRef?: React.MutableRefObject<(() => void) | null>;
  thumbnailRef?: React.MutableRefObject<(() => Promise<string>) | null>;
  pickerMode?: boolean;
  pickerSelectedProductIds?: Set<string>;
  pickerDisabledProductIds?: Set<string>;
  onTogglePickerProduct?: (elementId: string) => void;
  /** Puts a text element into inline editing with its content selected (waits if not drawn yet). */
  textEditRef?: React.MutableRefObject<((elementId: string) => void) | null>;
  captureProductsRef?: React.MutableRefObject<
    ((productElementIds: string[]) => Promise<CapturedMockupProduct[]>) | null
  >;
}

const IMAGE_MIN_SCALE_FACTOR = 0.2;
const LOGO_MAX_SCALE_FACTOR = 10;
const PRODUCT_MAX_SCALE_FACTOR = 4;
const TEXT_MIN_SCALE = 0.2;
const TEXT_MAX_SCALE = 4;
const TOUCH_MOVE_THRESHOLD = 8;
const MOBILE_CONTROL_TOUCH_SIZE = 16;

interface TouchTransformState {
  target: fabric.Object;
  startPoint: { x: number; y: number };
  startScaleX: number;
  startScaleY: number;
  startAngle: number;
  startedOnControl: boolean;
  moved: boolean;
}

export default function Editor({
  state,
  onUpdateState,
  onSelectElement,
  selectedElementId: externalSelectedElementId,
  selectedElementType: externalSelectedElementType,
  mobileBottomInset = 0,
  exportRef,
  thumbnailRef,
  pickerMode = false,
  pickerSelectedProductIds,
  pickerDisabledProductIds,
  onTogglePickerProduct,
  captureProductsRef,
  textEditRef,
}: EditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderedProductIdsRef = useRef(new Set<string>());
  const measurementCanvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvas = useRef<fabric.Canvas | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastPanPoint = useRef<{ x: number; y: number } | null>(null);
  const isPanningRef = useRef(false);
  const pinchStartDistance = useRef<number | null>(null);
  const pinchStartZoom = useRef<number | null>(null);
  const pinchLastCenter = useRef<{ x: number; y: number } | null>(null);
  const isPinching = useRef(false);
  const ignoreNextTapAfterPinch = useRef(false);
  const lastTapTime = useRef<number>(0);
  const lastValidViewportTransform = useRef<fabric.TMat2D>([1, 0, 0, 1, 0, 0]);
  const touchTransformRef = useRef<TouchTransformState | null>(null);
  const touchTapRef = useRef<{ startPoint: { x: number; y: number } | null; moved: boolean }>({
    startPoint: null,
    moved: false,
  });
  const clipboardRef = useRef<string | null>(null);
  const hasFitToScreen = useRef(false);
  const lifecycleFrameRef = useRef<number | null>(null);
  const lifecycleResizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const garmentGeometryAttemptKeysRef = useRef(new Set<string>());
  const pendingTextEditRef = useRef<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadFont(DEFAULT_TEXT_FONT), 2500);
    return () => window.clearTimeout(timer);
  }, []);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [zoomLevel, setZoomLevel] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [failedImageCount, setFailedImageCount] = useState(0);
  const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null);
  const [dimensionStartGuideId, setDimensionStartGuideId] = useState<string | null>(null);
  const [calibrationDraft, setCalibrationDraft] = useState<{
    points: MeasurementScenePoint[];
  } | null>(null);
  const [pendingCalibration, setPendingCalibration] = useState<(
    PendingMeasurementCalibration & {
      points: MeasurementScenePoint[];
    }
  ) | null>(null);
  const [guidePreview, setGuidePreview] = useState<MeasurementGuidePreview | null>(null);

  const elementsKey = state.elements.map(e => `${e.id}:${e.type}:${e.face ?? ''}:${e.backOfElementId ?? ''}:${e.placedOnProductId ?? ''}:${e.placement ?? ''}:${e.relativeTransform ? JSON.stringify(e.relativeTransform) : ''}:${e.garmentGeometry ? JSON.stringify(e.garmentGeometry) : ''}:${e.type === 'text' ? `${e.text}:${e.fontFamily}:${e.fontWeight}:${e.fontStyle}:${e.textUnderline}:${e.textAlign}:${e.textColor}:${e.textGradient ? JSON.stringify(e.textGradient) : ''}:${e.arcMode}:${e.arcRadius}:${e.arcBend}:${e.letterSpacing}` : e.image?.slice(-50)}`).join('|');
  const measurements = state.measurements ?? createMeasurementState(false);
  const measurementVisible = !pickerMode && measurements.visible;

  const newMeasurementId = useCallback((prefix: string) => {
    const suffix =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2, 12);
    return `${prefix}-${suffix}`;
  }, []);

  const clientPointToCanvasScene = useCallback(
    (clientX: number, clientY: number): MeasurementScenePoint | null => {
      const canvas = fabricCanvas.current;
      if (!canvas) return null;
      const rect = canvas.upperCanvasEl.getBoundingClientRect();
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return null;
      }
      const viewportPoint = new fabric.Point(
        ((clientX - rect.left) / rect.width) * (canvas.width ?? rect.width),
        ((clientY - rect.top) / rect.height) * (canvas.height ?? rect.height)
      );
      const scenePoint = fabric.util.transformPoint(
        viewportPoint,
        fabric.util.invertTransform(canvas.viewportTransform)
      );
      return { x: scenePoint.x, y: scenePoint.y };
    },
    []
  );

  useEffect(() => {
    if (
      selectedGuideId &&
      !measurements.guides.some(guide => guide.id === selectedGuideId)
    ) {
      setSelectedGuideId(null);
    }
    if (
      dimensionStartGuideId &&
      !measurements.guides.some(
        guide => guide.id === dimensionStartGuideId
      )
    ) {
      setDimensionStartGuideId(null);
    }
  }, [
    dimensionStartGuideId,
    measurements.guides,
    selectedGuideId,
  ]);

  const getCanvasEventPoint = useCallback((event: any): { x: number; y: number } | null => {
    const source = event?.clientX !== undefined
      ? event
      : event?.touches?.[0] || event?.changedTouches?.[0];

    const x = source?.clientX;
    const y = source?.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }, []);

  const isTouchLikeEvent = useCallback((event: any) => (
    !!event?.touches || !!event?.changedTouches || event?.pointerType === 'touch'
  ), []);

  const hasMovedBeyondTap = useCallback((from: { x: number; y: number } | null, to: { x: number; y: number } | null) => {
    if (!from || !to) return false;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    return Math.sqrt(dx * dx + dy * dy) > TOUCH_MOVE_THRESHOLD;
  }, []);

  const rememberValidViewport = useCallback((canvas: fabric.Canvas) => {
    const vpt = canvas.viewportTransform;
    if (vpt?.every(Number.isFinite)) {
      lastValidViewportTransform.current = vpt.slice() as fabric.TMat2D;
    }
  }, []);

  const restoreValidViewport = useCallback((canvas: fabric.Canvas) => {
    canvas.setViewportTransform(lastValidViewportTransform.current.slice() as fabric.TMat2D);
    canvas.requestRenderAll();
  }, []);

  const safeRelativePan = useCallback((canvas: fabric.Canvas, dx: number, dy: number) => {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;

    rememberValidViewport(canvas);
    canvas.relativePan(new fabric.Point(dx, dy));

    if (!canvas.viewportTransform?.every(Number.isFinite)) {
      restoreValidViewport(canvas);
      return false;
    }

    rememberValidViewport(canvas);
    return true;
  }, [rememberValidViewport, restoreValidViewport]);

  const getObjectScaleBounds = useCallback((obj: fabric.Object) => {
    const baseScale = (obj as any)._baseScale;
    const elementType = (obj as any)._elementType as ElementType | undefined;

    if ((elementType === 'logo' || elementType === 'product') && Number.isFinite(baseScale) && baseScale > 0) {
      const maxScaleFactor =
        elementType === 'logo'
          ? LOGO_MAX_SCALE_FACTOR
          : PRODUCT_MAX_SCALE_FACTOR;
      return {
        min: baseScale * IMAGE_MIN_SCALE_FACTOR,
        max: baseScale * maxScaleFactor,
        reset: baseScale,
      };
    }

    return {
      min: TEXT_MIN_SCALE,
      max: TEXT_MAX_SCALE,
      reset: 1,
    };
  }, []);

  const clampObjectScale = useCallback((obj: fabric.Object, scaleX?: number, scaleY?: number) => {
    const bounds = getObjectScaleBounds(obj);
    const nextScaleX = scaleX ?? obj.scaleX ?? bounds.reset;
    const nextScaleY = scaleY ?? obj.scaleY ?? bounds.reset;
    if (!Number.isFinite(nextScaleX) || !Number.isFinite(nextScaleY)) return false;

    obj.set({
      scaleX: Math.min(bounds.max, Math.max(bounds.min, nextScaleX)),
      scaleY: Math.min(bounds.max, Math.max(bounds.min, nextScaleY)),
    });
    return true;
  }, [getObjectScaleBounds]);

  // ---- Fit to screen ----
  const fitToScreen = useCallback(() => {
    if (!fabricCanvas.current) return;
    const canvas = fabricCanvas.current;

    const objects = canvas.getObjects();
    if (!objects.length) return;

    const canvasW = canvas.width!;
    const canvasH = canvas.height!;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const obj of objects) {
      const bound = obj.getBoundingRect();
      if (bound.left < minX) minX = bound.left;
      if (bound.top < minY) minY = bound.top;
      if (bound.left + bound.width > maxX) maxX = bound.left + bound.width;
      if (bound.top + bound.height > maxY) maxY = bound.top + bound.height;
    }

    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);

    const padding = 0.85;
    const fitZoom = Math.min((canvasW * padding) / contentW, (canvasH * padding) / contentH);

    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.setZoom(fitZoom);

    const contentCenterX = minX + contentW / 2;
    const contentCenterY = minY + contentH / 2;
    canvas.viewportTransform[4] = canvasW / 2 - contentCenterX * fitZoom;
    canvas.viewportTransform[5] = canvasH / 2 - contentCenterY * fitZoom;
    canvas.requestRenderAll();
    rememberValidViewport(canvas);
    setZoomLevel(fitZoom);
  }, [rememberValidViewport]);

  const getContentBounds = useCallback(() => {
    if (!fabricCanvas.current) return null;
    const canvas = fabricCanvas.current;
    const objects = canvas.getObjects();
    if (!objects.length) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const obj of objects) {
      const bound = obj.getBoundingRect();
      if (bound.left < minX) minX = bound.left;
      if (bound.top < minY) minY = bound.top;
      if (bound.left + bound.width > maxX) maxX = bound.left + bound.width;
      if (bound.top + bound.height > maxY) maxY = bound.top + bound.height;
    }

    const padding = 48;
    return {
      left: minX - padding,
      top: minY - padding,
      width: maxX - minX + padding * 2,
      height: maxY - minY + padding * 2,
    };
  }, []);

  // ---- Zoom helpers ----
  const applyZoom = useCallback((target: number) => {
    if (!fabricCanvas.current) return;
    const canvas = fabricCanvas.current;
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, target));
    canvas.zoomToPoint(new fabric.Point(canvas.width! / 2, canvas.height! / 2), clamped);
    canvas.requestRenderAll();
    rememberValidViewport(canvas);
    setZoomLevel(clamped);
  }, [rememberValidViewport]);

  const animateZoom = useCallback((target: number) => {
    if (!fabricCanvas.current) return;
    const canvas = fabricCanvas.current;
    const startZoom = canvas.getZoom();
    const clampedTarget = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, target));
    const duration = 200;
    const startTime = performance.now();

    const animate = (time: number) => {
      const elapsed = time - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const currentZoom = startZoom + (clampedTarget - startZoom) * eased;

      canvas.zoomToPoint(new fabric.Point(canvas.width! / 2, canvas.height! / 2), currentZoom);
      canvas.requestRenderAll();
      rememberValidViewport(canvas);
      setZoomLevel(currentZoom);

      if (progress < 1) requestAnimationFrame(animate);
    };

    requestAnimationFrame(animate);
  }, [rememberValidViewport]);

  const zoomIn = useCallback(() => animateZoom((fabricCanvas.current?.getZoom() ?? 1) + 0.25), [animateZoom]);
  const zoomOut = useCallback(() => animateZoom((fabricCanvas.current?.getZoom() ?? 1) - 0.25), [animateZoom]);

  const keepActiveTextAboveMobileInset = useCallback(() => {
    if (!fabricCanvas.current || !mobileBottomInset || externalSelectedElementType !== 'text') return;
    const canvas = fabricCanvas.current;
    const activeObject = canvas.getActiveObject();
    const vpt = canvas.viewportTransform;
    if (!activeObject || !vpt) return;

    activeObject.setCoords();
    const bounds = activeObject.getBoundingRect();
    const corners = [
      new fabric.Point(bounds.left, bounds.top),
      new fabric.Point(bounds.left + bounds.width, bounds.top),
      new fabric.Point(bounds.left, bounds.top + bounds.height),
      new fabric.Point(bounds.left + bounds.width, bounds.top + bounds.height),
    ].map(point => fabric.util.transformPoint(point, vpt));

    const screenTop = Math.min(...corners.map(point => point.y));
    const screenBottom = Math.max(...corners.map(point => point.y));
    const topLimit = 20;
    const bottomLimit = Math.max(topLimit + 120, (canvas.height || 0) - mobileBottomInset - 24);
    let shiftY = 0;

    if (screenBottom > bottomLimit) {
      shiftY = bottomLimit - screenBottom;
    } else if (screenTop < topLimit) {
      shiftY = topLimit - screenTop;
    }

    if (Math.abs(shiftY) > 1) {
      const nextVpt = vpt.slice() as fabric.TMat2D;
      nextVpt[5] += shiftY;
      canvas.setViewportTransform(nextVpt);
      canvas.requestRenderAll();
      rememberValidViewport(canvas);
    }
  }, [externalSelectedElementType, mobileBottomInset, rememberValidViewport]);

  const revealObjectWithoutChangingZoom = useCallback((obj: fabric.Object) => {
    const canvas = fabricCanvas.current;
    const vpt = canvas?.viewportTransform;
    if (!canvas || !vpt) return;
    obj.setCoords();
    const bounds = obj.getBoundingRect();
    const corners = [
      new fabric.Point(bounds.left, bounds.top),
      new fabric.Point(bounds.left + bounds.width, bounds.top + bounds.height),
    ].map(point => fabric.util.transformPoint(point, vpt));
    const margin = 32;
    const left = corners[0].x;
    const top = corners[0].y;
    const right = corners[1].x;
    const bottom = corners[1].y;
    let shiftX = 0;
    let shiftY = 0;
    if (right > (canvas.width ?? 0) - margin) {
      shiftX = (canvas.width ?? 0) - margin - right;
    } else if (left < margin) {
      shiftX = margin - left;
    }
    if (bottom > (canvas.height ?? 0) - margin) {
      shiftY = (canvas.height ?? 0) - margin - bottom;
    } else if (top < margin) {
      shiftY = margin - top;
    }
    if (shiftX || shiftY) {
      const nextVpt = vpt.slice() as fabric.TMat2D;
      nextVpt[4] += shiftX;
      nextVpt[5] += shiftY;
      canvas.setViewportTransform(nextVpt);
      rememberValidViewport(canvas);
    }
    canvas.requestRenderAll();
  }, [rememberValidViewport]);

  const closeMeasurements = useCallback(() => {
    const currentMeasurements =
      stateRef.current.measurements ?? createMeasurementState(false);
    onUpdateState({
      measurements: { ...currentMeasurements, visible: false },
    });
    setCalibrationDraft(null);
    setPendingCalibration(null);
    setGuidePreview(null);
    setSelectedGuideId(null);
    setDimensionStartGuideId(null);
  }, [onUpdateState]);

  const toggleMeasurements = useCallback(() => {
    const currentMeasurements =
      stateRef.current.measurements ?? createMeasurementState(false);
    if (currentMeasurements.visible) {
      closeMeasurements();
      return;
    }

    const products = stateRef.current.elements.filter(
      element => element.type === 'product'
    );
    if (products.length === 0) {
      toast.error('请先添加要测量的产品图');
      return;
    }

    onUpdateState({
      measurements: { ...currentMeasurements, visible: true },
    });
  }, [
    closeMeasurements,
    onUpdateState,
    toast,
  ]);

  const startCalibration = useCallback(() => {
    if (!fabricCanvas.current) {
      toast.error('画布还没有加载完成，请稍后重试');
      return;
    }
    setCalibrationDraft({ points: [] });
    setPendingCalibration(null);
    setGuidePreview(null);
  }, [toast]);

  const cancelCalibration = useCallback(() => {
    setCalibrationDraft(null);
    setPendingCalibration(null);
  }, []);

  const captureCalibrationPoint = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!calibrationDraft) return;
      event.preventDefault();
      event.stopPropagation();
      const point = clientPointToCanvasScene(event.clientX, event.clientY);
      if (!point) {
        toast.error('比例尺端点必须落在画布范围内');
        return;
      }
      if (calibrationDraft.points.length === 0) {
        setCalibrationDraft({ ...calibrationDraft, points: [point] });
        return;
      }

      const firstPoint = calibrationDraft.points[0];
      const axis: MeasurementAxis =
        Math.abs(point.x - firstPoint.x) >=
        Math.abs(point.y - firstPoint.y)
          ? 'x'
          : 'y';
      const firstSceneCoordinate =
        axis === 'x' ? firstPoint.x : firstPoint.y;
      const secondSceneCoordinate = axis === 'x' ? point.x : point.y;
      if (Math.abs(secondSceneCoordinate - firstSceneCoordinate) < 1) {
        toast.error('比例尺两点需要有明显的水平或垂直距离');
        return;
      }
      const snappedSecondPoint =
        axis === 'x'
          ? { x: point.x, y: firstPoint.y }
          : { x: firstPoint.x, y: point.y };
      setPendingCalibration({
        axis,
        firstSceneCoordinate,
        secondSceneCoordinate,
        points: [firstPoint, snappedSecondPoint],
      });
      setCalibrationDraft(null);
    },
    [calibrationDraft, clientPointToCanvasScene, toast]
  );

  const confirmCalibration = useCallback(
    (distanceCm: number) => {
      if (!pendingCalibration) return;
      try {
        const currentMeasurements =
          stateRef.current.measurements ?? createMeasurementState(true);
        const scale = createCanvasScale({
          axis: pendingCalibration.axis,
          firstSceneCoordinate: pendingCalibration.firstSceneCoordinate,
          secondSceneCoordinate: pendingCalibration.secondSceneCoordinate,
          distanceCm,
        });
        let guides = currentMeasurements.guides;
        let dimensions = currentMeasurements.dimensions;
        const axisOrigins = { ...currentMeasurements.axisOrigins };
        const hadScale = currentMeasurements.scale !== null;
        if (!hadScale && guides.length === 0) {
          const firstScenePosition = Math.min(
            scale.firstSceneCoordinate,
            scale.secondSceneCoordinate
          );
          const secondScenePosition = Math.max(
            scale.firstSceneCoordinate,
            scale.secondSceneCoordinate
          );
          const firstGuide = createGuide({
            id: newMeasurementId('guide'),
            axis: scale.axis,
            scenePosition: firstScenePosition,
            label: nextGuideLabel(guides, scale.axis),
          });
          const secondGuide = createGuide({
            id: newMeasurementId('guide'),
            axis: scale.axis,
            scenePosition: secondScenePosition,
            label: nextGuideLabel([...guides, firstGuide], scale.axis),
          });
          axisOrigins[scale.axis] = firstScenePosition;
          guides = [...guides, firstGuide, secondGuide];
          dimensions = [
            ...dimensions,
            {
              id: newMeasurementId('dimension'),
              guideAId: firstGuide.id,
              guideBId: secondGuide.id,
            },
          ];
          setSelectedGuideId(secondGuide.id);
        } else if (axisOrigins[scale.axis] === null) {
          axisOrigins[scale.axis] = Math.min(
            scale.firstSceneCoordinate,
            scale.secondSceneCoordinate
          );
        }
        onUpdateState({
          measurements: {
            ...currentMeasurements,
            visible: true,
            scale,
            axisOrigins,
            guides,
            dimensions,
          },
        });
        setPendingCalibration(null);
        toast.success(
          hadScale
            ? '比例尺已更新，所有基准线保持原位'
            : '比例尺已设置，横向和纵向将共用此比例'
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '比例尺设置失败');
      }
    },
    [newMeasurementId, onUpdateState, pendingCalibration, toast]
  );

  const updateGuidePosition = useCallback(
    (guideId: string, positionCm: number) => {
      const currentMeasurements =
        stateRef.current.measurements ?? createMeasurementState(true);
      const sourceGuide = currentMeasurements.guides.find(
        guide => guide.id === guideId
      );
      if (!sourceGuide) return;
      try {
        const guide = createGuide({
          ...sourceGuide,
          scenePosition: scenePositionFromCm(
            currentMeasurements,
            sourceGuide.axis,
            positionCm
          ),
        });
        onUpdateState({
          measurements: {
            ...currentMeasurements,
            guides: currentMeasurements.guides.map(item =>
              item.id === guideId ? guide : item
            ),
          },
        });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : '基准线坐标更新失败'
        );
      }
    },
    [onUpdateState, toast]
  );

  const createOffsetMeasurementGuide = useCallback(
    (
      guideId: string,
      direction: 'negative' | 'positive',
      offsetCm: number
    ) => {
      const currentMeasurements =
        stateRef.current.measurements ?? createMeasurementState(true);
      const baseGuide = currentMeasurements.guides.find(
        guide => guide.id === guideId
      );
      if (!baseGuide) return;
      try {
        if (!currentMeasurements.scale) {
          toast.error('请先设置比例尺');
          return;
        }
        const guide = createOffsetGuide({
          id: newMeasurementId('guide'),
          label: nextGuideLabel(currentMeasurements.guides, baseGuide.axis),
          baseGuide,
          scale: currentMeasurements.scale,
          direction,
          offsetCm,
        });
        if (
          currentMeasurements.guides.some(
            item =>
              item.axis === guide.axis &&
              Math.abs(item.scenePosition - guide.scenePosition) < 0.001
          )
        ) {
          toast.error('该位置已有同方向基准线');
          return;
        }
        onUpdateState({
          measurements: {
            ...currentMeasurements,
            guides: [...currentMeasurements.guides, guide],
          },
        });
        setSelectedGuideId(guide.id);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : '偏移基准线创建失败'
        );
      }
    },
    [newMeasurementId, onUpdateState, toast]
  );

  const deleteMeasurementGuide = useCallback(
    (guideId: string) => {
      const currentMeasurements =
        stateRef.current.measurements ?? createMeasurementState(true);
      onUpdateState({
        measurements: removeGuideFromMeasurements(
          currentMeasurements,
          guideId
        ),
      });
      if (selectedGuideId === guideId) setSelectedGuideId(null);
      if (dimensionStartGuideId === guideId) setDimensionStartGuideId(null);
    },
    [dimensionStartGuideId, onUpdateState, selectedGuideId]
  );

  const createMeasurementDimension = useCallback(
    (guideAId: string, guideBId: string) => {
      const currentMeasurements =
        stateRef.current.measurements ?? createMeasurementState(true);
      const guideA = currentMeasurements.guides.find(
        guide => guide.id === guideAId
      );
      const guideB = currentMeasurements.guides.find(
        guide => guide.id === guideBId
      );
      if (!guideA || !guideB) return;
      try {
        measurementDistanceCm(currentMeasurements, guideA, guideB);
        const duplicate = currentMeasurements.dimensions.some(
          dimension =>
            (dimension.guideAId === guideAId &&
              dimension.guideBId === guideBId) ||
            (dimension.guideAId === guideBId &&
              dimension.guideBId === guideAId)
        );
        if (!duplicate) {
          onUpdateState({
            measurements: {
              ...currentMeasurements,
              dimensions: [
                ...currentMeasurements.dimensions,
                {
                  id: newMeasurementId('dimension'),
                  guideAId,
                  guideBId,
                },
              ],
            },
          });
        }
        setDimensionStartGuideId(null);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '尺寸标注失败');
      }
    },
    [newMeasurementId, onUpdateState, toast]
  );

  const deleteMeasurementDimension = useCallback(
    (dimensionId: string) => {
      const currentMeasurements =
        stateRef.current.measurements ?? createMeasurementState(true);
      onUpdateState({
        measurements: {
          ...currentMeasurements,
          dimensions: currentMeasurements.dimensions.filter(
            dimension => dimension.id !== dimensionId
          ),
        },
      });
    },
    [onUpdateState]
  );

  const startGuideDrag = useCallback(
    (axis: MeasurementAxis, event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!measurements.scale) {
        toast.error('请先设置比例尺');
        return;
      }

      let latestPreview: MeasurementGuidePreview | null = null;
      const updatePreview = (clientX: number, clientY: number) => {
        const scenePoint = clientPointToCanvasScene(clientX, clientY);
        if (!scenePoint) {
          latestPreview = null;
          setGuidePreview(null);
          return;
        }
        latestPreview = {
          axis,
          scenePosition: axis === 'x' ? scenePoint.x : scenePoint.y,
        };
        setGuidePreview(latestPreview);
      };
      const handlePointerMove = (pointerEvent: PointerEvent) => {
        updatePreview(pointerEvent.clientX, pointerEvent.clientY);
      };
      const handlePointerUp = () => {
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
        const preview = latestPreview;
        setGuidePreview(null);
        if (!preview) return;
        const currentMeasurements =
          stateRef.current.measurements ?? createMeasurementState(true);
        if (
          currentMeasurements.guides.some(
            guide =>
              guide.axis === preview.axis &&
              Math.abs(guide.scenePosition - preview.scenePosition) < 0.001
          )
        ) {
          toast.error('该位置已有同方向基准线');
          return;
        }
        const guide = createGuide({
          id: newMeasurementId('guide'),
          axis: preview.axis,
          scenePosition: preview.scenePosition,
          label: nextGuideLabel(currentMeasurements.guides, preview.axis),
        });
        const axisOrigins = { ...currentMeasurements.axisOrigins };
        if (axisOrigins[guide.axis] === null) {
          axisOrigins[guide.axis] = guide.scenePosition;
        }
        onUpdateState({
          measurements: {
            ...currentMeasurements,
            axisOrigins,
            guides: [...currentMeasurements.guides, guide],
          },
        });
        setSelectedGuideId(guide.id);
      };

      updatePreview(event.clientX, event.clientY);
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp, { once: true });
      window.addEventListener('pointercancel', handlePointerUp, { once: true });
    },
    [
      clientPointToCanvasScene,
      measurements.scale,
      newMeasurementId,
      onUpdateState,
      toast,
    ]
  );
  const calibrationOverlay = useMemo<MeasurementCalibrationOverlay | null>(
    () =>
      calibrationDraft
        ? {
            points: calibrationDraft.points,
            pending: false,
          }
        : pendingCalibration
          ? {
              points: pendingCalibration.points,
              pending: true,
            }
          : null,
    [calibrationDraft, pendingCalibration]
  );

  // ---- Initialize Canvas ----
  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return;

    const canvas = new fabric.Canvas(canvasRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 700,
      backgroundColor: '#ffffff',
      preserveObjectStacking: true,
      selection: false,
      renderOnAddRemove: false,
    });

    fabricCanvas.current = canvas;

    const guidelines = new ExportSafeAligningGuidelines(canvas, {
      margin: 4,
      width: 1,
      color: 'rgba(255,0,102,0.8)',
    });

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width && height && fabricCanvas.current) {
          fabricCanvas.current.setDimensions({ width, height });
          fabricCanvas.current.requestRenderAll();
        }
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      guidelines.dispose();
      canvas.dispose();
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const canvas = fabricCanvas.current;
    const overlayCanvas = measurementCanvasRef.current;
    if (!canvas || !overlayCanvas) return;
    const drawMeasurements = () => {
      drawMockupMeasurementOverlay({
        overlayCanvas,
        fabricCanvas: canvas,
        measurements: stateRef.current.measurements,
        selectedGuideId,
        calibrationOverlay,
        guidePreview,
      });
    };
    canvas.on('after:render', drawMeasurements);
    drawMeasurements();
    return () => {
      canvas.off('after:render', drawMeasurements);
    };
  }, [
    calibrationOverlay,
    guidePreview,
    measurements,
    selectedGuideId,
  ]);

  const clearTopContext = useCallback((canvas: fabric.Canvas) => {
    if (!canvas.contextTop) return;
    canvas.clearContext(canvas.contextTop);
    (canvas as any).contextTopDirty = false;
  }, []);

  const resetCanvasInteraction = useCallback(() => {
    const canvas = fabricCanvas.current;
    if (!canvas) return;
    pinchStartDistance.current = null;
    pinchStartZoom.current = null;
    pinchLastCenter.current = null;
    isPinching.current = false;
    ignoreNextTapAfterPinch.current = false;
    lastTapTime.current = 0;
    touchTransformRef.current = null;
    touchTapRef.current = { startPoint: null, moved: false };
    isPanningRef.current = false;
    setIsPanning(false);
    lastPanPoint.current = null;
    canvas.skipTargetFind = false;
    canvas.selection = false;
    (canvas as any)._currentTransform = null;
    canvas.discardActiveObject();
    setSelectedElementId(null);
    onSelectElement(null, null);
    clearTopContext(canvas);
    canvas.requestRenderAll();
  }, [clearTopContext, onSelectElement]);

  const refreshCanvasAfterLifecycleResume = useCallback(() => {
    if (lifecycleFrameRef.current !== null) {
      cancelAnimationFrame(lifecycleFrameRef.current);
    }

    lifecycleFrameRef.current = requestAnimationFrame(() => {
      lifecycleFrameRef.current = null;

      const canvas = fabricCanvas.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      resetCanvasInteraction();

      const width = container.clientWidth;
      const height = container.clientHeight || 700;
      if (width > 0 && height > 0) {
        canvas.setDimensions({ width, height });
      }

      canvas.calcOffset();

      if (!canvas.viewportTransform?.every(Number.isFinite)) {
        restoreValidViewport(canvas);
      } else {
        rememberValidViewport(canvas);
      }

      clearTopContext(canvas);
      canvas.requestRenderAll();
    });
  }, [clearTopContext, rememberValidViewport, resetCanvasInteraction, restoreValidViewport]);

  // ---- Wheel zoom (zoom to cursor) ----
  const handleWheel = useCallback((opt: any) => {
    const delta = opt.e.deltaY;
    if (!fabricCanvas.current) return;
    const canvas = fabricCanvas.current;
    let zoom = canvas.getZoom();
    zoom *= 0.995 ** delta;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    rememberValidViewport(canvas);
    canvas.zoomToPoint(new fabric.Point(opt.e.offsetX, opt.e.offsetY), zoom);
    canvas.requestRenderAll();
    rememberValidViewport(canvas);
    setZoomLevel(zoom);

    opt.e.preventDefault();
    opt.e.stopPropagation();
  }, [rememberValidViewport]);

  // ---- Double click / double tap (reset selected object size) ----
  const handleDoubleClick = useCallback(() => {
    if (pickerMode) return;
    if (!fabricCanvas.current) return;
    const activeObject = fabricCanvas.current.getActiveObject();
    if (!activeObject) return;
    // Don't reset scale for IText — let Fabric.js inline editing work
    if (activeObject instanceof fabric.IText) return;
    const { reset } = getObjectScaleBounds(activeObject);
    activeObject.set({ scaleX: reset, scaleY: reset }).setCoords();
    fabricCanvas.current.requestRenderAll();
    activeObject.fire('modified');
  }, [getObjectScaleBounds, pickerMode]);

  // ---- Native touch handler for pinch-to-zoom ----
  // Fabric.js v7's touch:gesture event never fires (gesture binding is commented out in Canvas.ts),
  // so we use native TouchEvents directly on the upper canvas element.
  const handleNativeTouch = useCallback((e: TouchEvent) => {
    if (!fabricCanvas.current) return;
    const canvas = fabricCanvas.current;

    if (e.touches.length !== 2) {
      if (isPinching.current || pinchStartDistance.current !== null) {
        resetCanvasInteraction();
        ignoreNextTapAfterPinch.current = true;
        lastTapTime.current = 0;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
      }

      const touchPoint = getCanvasEventPoint(e);
      if (e.type === 'touchstart' && e.touches.length === 1) {
        touchTapRef.current = { startPoint: touchPoint, moved: false };
      }
      if (e.type === 'touchmove' && e.touches.length === 1) {
        if (hasMovedBeyondTap(touchTapRef.current.startPoint, touchPoint)) {
          touchTapRef.current.moved = true;
          if (touchTransformRef.current) touchTransformRef.current.moved = true;
        }
      }

      // Double-tap detection for mobile (Fabric.js dblclick never fires on touch)
      if (e.type === 'touchend' && e.touches.length === 0 && e.changedTouches.length === 1) {
        if (ignoreNextTapAfterPinch.current) {
          ignoreNextTapAfterPinch.current = false;
          lastTapTime.current = 0;
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          return;
        }
        const wasDrag = touchTapRef.current.moved || !!touchTransformRef.current?.moved;
        const wasControlTransform = !!touchTransformRef.current?.startedOnControl;
        touchTransformRef.current = null;
        touchTapRef.current = { startPoint: null, moved: false };
        if (wasDrag || wasControlTransform) {
          lastTapTime.current = 0;
          return;
        }
        const now = Date.now();
        if (now - lastTapTime.current < 300) {
          handleDoubleClick();
          lastTapTime.current = 0;
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          return;
        }
        lastTapTime.current = now;
      }
      // Prevent iOS rubber-band scroll on canvas
      if (e.type === 'touchmove' && e.touches.length === 1) {
        e.preventDefault();
      }
      if (e.type === 'touchcancel') {
        resetCanvasInteraction();
        ignoreNextTapAfterPinch.current = true;
      }
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // Cancel any ongoing single-finger interaction when entering pinch
    if (!isPinching.current) {
      isPinching.current = true;
      canvas.discardActiveObject();
      canvas.skipTargetFind = true;
      (canvas as any)._currentTransform = null;
      touchTransformRef.current = null;
      touchTapRef.current = { startPoint: null, moved: false };
      isPanningRef.current = false;
      setIsPanning(false);
      lastPanPoint.current = null;
      setSelectedElementId(null);
      onSelectElement(null, null);
    }

    const t0 = e.touches[0];
    const t1 = e.touches[1];

    const dx = t1.clientX - t0.clientX;
    const dy = t1.clientY - t0.clientY;
    const currentDistance = Math.sqrt(dx * dx + dy * dy);

    const centerX = (t0.clientX + t1.clientX) / 2;
    const centerY = (t0.clientY + t1.clientY) / 2;
    const rect = canvas.upperCanvasEl.getBoundingClientRect();
    const focalX = centerX - rect.left;
    const focalY = centerY - rect.top;

    if (pinchStartDistance.current === null) {
      pinchStartDistance.current = currentDistance;
      pinchStartZoom.current = canvas.getZoom();
      pinchLastCenter.current = { x: centerX, y: centerY };
      return;
    }

    const ratio = currentDistance / pinchStartDistance.current;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStartZoom.current! * ratio));

    canvas.zoomToPoint(new fabric.Point(focalX, focalY), newZoom);

    if (pinchLastCenter.current) {
      const panDx = centerX - pinchLastCenter.current.x;
      const panDy = centerY - pinchLastCenter.current.y;
      safeRelativePan(canvas, panDx, panDy);
    }
    pinchLastCenter.current = { x: centerX, y: centerY };

    canvas.requestRenderAll();
    rememberValidViewport(canvas);
    setZoomLevel(newZoom);
  }, [getCanvasEventPoint, handleDoubleClick, hasMovedBeyondTap, rememberValidViewport, resetCanvasInteraction, safeRelativePan, onSelectElement]);

  // ---- Pan mode mouse handlers (auto-pan on background click) ----
  const handleMouseDown = useCallback((opt: any) => {
    if (isPinching.current || opt.e?.touches?.length >= 2) return;
    const point = getCanvasEventPoint(opt.e);

    if (opt.target && isTouchLikeEvent(opt.e)) {
      const transform = opt.transform || (fabricCanvas.current as any)?._currentTransform;
      const action = transform?.action;
      const startedOnControl = !!transform?.corner || (!!action && action !== 'drag');
      touchTransformRef.current = {
        target: opt.target,
        startPoint: point || { x: 0, y: 0 },
        startScaleX: opt.target.scaleX ?? 1,
        startScaleY: opt.target.scaleY ?? opt.target.scaleX ?? 1,
        startAngle: opt.target.angle ?? 0,
        startedOnControl,
        moved: false,
      };
      return;
    }

    if (!opt.target) {
      if (!point) {
        isPanningRef.current = false;
        setIsPanning(false);
        lastPanPoint.current = null;
        return;
      }
      isPanningRef.current = true;
      setIsPanning(true);
      lastPanPoint.current = point;
    }
  }, [getCanvasEventPoint, isTouchLikeEvent]);

  const handleMouseMove = useCallback((opt: any) => {
    if (isPinching.current || opt.e?.touches?.length >= 2) return;
    const point = getCanvasEventPoint(opt.e);

    if (touchTransformRef.current && opt.target === touchTransformRef.current.target) {
      if (hasMovedBeyondTap(touchTransformRef.current.startPoint, point)) {
        touchTransformRef.current.moved = true;
        touchTapRef.current.moved = true;
      }
      return;
    }

    if (!isPanningRef.current || !lastPanPoint.current || !fabricCanvas.current) return;

    if (!point) {
      isPanningRef.current = false;
      setIsPanning(false);
      lastPanPoint.current = null;
      return;
    }

    const dx = point.x - lastPanPoint.current.x;
    const dy = point.y - lastPanPoint.current.y;
    lastPanPoint.current = point;

    const canvas = fabricCanvas.current;
    if (safeRelativePan(canvas, dx, dy)) {
      canvas.requestRenderAll();
    }
  }, [getCanvasEventPoint, hasMovedBeyondTap, safeRelativePan]);

  const handleMouseUp = useCallback(() => {
    isPanningRef.current = false;
    setIsPanning(false);
    lastPanPoint.current = null;
  }, []);

  // ---- Delete object ----
  const performDelete = useCallback((obj: fabric.Object) => {
    if (!fabricCanvas.current) return;
    const canvas = fabricCanvas.current;
    const elementId = (obj as any)._elementId;
    if (!elementId) return;

    const currentState = stateRef.current;
    onUpdateState(removeElementFromCustomizationState(currentState, elementId));

    canvas.remove(obj);
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    setSelectedElementId(null);
    onSelectElement(null, null);
  }, [onUpdateState, onSelectElement]);

  const deleteSelectedObject = useCallback(() => {
    const obj = fabricCanvas.current?.getActiveObject();
    if (obj) performDelete(obj);
  }, [performDelete]);

  // ---- Copy selected element ----
  const copySelectedElement = useCallback(() => {
    if (!fabricCanvas.current) return;
    const obj = fabricCanvas.current.getActiveObject();
    if (!obj) return;
    const elementId = (obj as any)._elementId;
    if (!elementId) return;

    const currentState = stateRef.current;
    const source = currentState.elements.find(e => e.id === elementId);
    if (!source) return;

    const newId = Math.random().toString(36).slice(2, 11);
    onUpdateState({
      elements: copyMockupElement(currentState.elements, elementId, newId),
    });
    setSelectedElementId(newId);
    onSelectElement(newId, source.type);
  }, [onSelectElement, onUpdateState]);

  // ---- Scale selected object (for mobile floating bar) ----
  const scaleObject = useCallback((factor: number) => {
    if (!fabricCanvas.current) return;
    const obj = fabricCanvas.current.getActiveObject();
    if (!obj) return;
    const scaleX = (obj.scaleX || 1) * factor;
    const scaleY = (obj.scaleY || obj.scaleX || 1) * factor;
    if (!clampObjectScale(obj, scaleX, scaleY)) return;
    obj.setCoords();
    fabricCanvas.current.requestRenderAll();
    obj.fire('modified');
  }, [clampObjectScale]);

  // ---- Selection tracking ----
  const handleSelectionChange = useCallback(() => {
    if (!fabricCanvas.current) return;
    const obj = fabricCanvas.current.getActiveObject();
    const id = (obj as any)?._elementId || null;
    const type = (obj as any)?._elementType || null;
    setSelectedElementId(id);
    onSelectElement(id, type);
  }, [onSelectElement]);

  const handleSelectionCleared = useCallback(() => {
    setSelectedElementId(null);
    onSelectElement(null, null);
  }, [onSelectElement]);

  // ---- Keyboard (arrow nudge, delete, zoom shortcuts) ----
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;

    // Zoom shortcuts
    if ((e.metaKey || e.ctrlKey) && e.key === '=') {
      e.preventDefault();
      const cur = fabricCanvas.current?.getZoom() ?? 1;
      animateZoom(cur + 0.25);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === '-') {
      e.preventDefault();
      const cur = fabricCanvas.current?.getZoom() ?? 1;
      animateZoom(cur - 0.25);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === '0') {
      e.preventDefault();
      fitToScreen();
      return;
    }
    if (pickerMode) return;

    if (!fabricCanvas.current) return;
    const activeObject = fabricCanvas.current.getActiveObject();
    if (!activeObject) return;

    // Skip custom shortcuts when IText is in editing mode
    const isTextEditing = activeObject instanceof fabric.IText && activeObject.isEditing;

    // Ctrl/Cmd+C — copy
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && !isTextEditing) {
      e.preventDefault();
      clipboardRef.current = (activeObject as any)._elementId ?? null;
      return;
    }

    // Ctrl/Cmd+V — paste
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && !isTextEditing) {
      e.preventDefault();
      if (clipboardRef.current) {
        const source = stateRef.current.elements.find(el => el.id === clipboardRef.current);
        if (source) {
          const newId = Math.random().toString(36).slice(2, 11);
          onUpdateState({
            elements: copyMockupElement(
              stateRef.current.elements,
              source.id,
              newId
            ),
          });
          setSelectedElementId(newId);
          onSelectElement(newId, source.type);
        }
      }
      return;
    }

    // Ctrl/Cmd+B — toggle bold
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && !isTextEditing) {
      e.preventDefault();
      const elementId = (activeObject as any)._elementId;
      if (elementId) {
        const el = stateRef.current.elements.find(x => x.id === elementId);
        if (el && el.type === 'text') {
          const updated = stateRef.current.elements.map(x =>
            x.id === elementId ? { ...x, fontWeight: (x.fontWeight === 'bold' ? 'normal' : 'bold') as 'normal' | 'bold' } : x
          );
          onUpdateState({ elements: updated });
        }
      }
      return;
    }

    // Ctrl/Cmd+I — toggle italic
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i' && !isTextEditing) {
      e.preventDefault();
      const elementId = (activeObject as any)._elementId;
      if (elementId) {
        const el = stateRef.current.elements.find(x => x.id === elementId);
        if (el && el.type === 'text') {
          const updated = stateRef.current.elements.map(x =>
            x.id === elementId ? { ...x, fontStyle: (x.fontStyle === 'italic' ? 'normal' : 'italic') as 'normal' | 'italic' } : x
          );
          onUpdateState({ elements: updated });
        }
      }
      return;
    }

    const step = e.shiftKey ? 10 : 1;
    let handled = true;

    switch (e.key) {
      case 'ArrowLeft':  activeObject.left! -= step; break;
      case 'ArrowRight': activeObject.left! += step; break;
      case 'ArrowUp':    activeObject.top!  -= step; break;
      case 'ArrowDown':  activeObject.top!  += step; break;
      case 'Delete':
      case 'Backspace':
        performDelete(activeObject);
        return;
      default: handled = false;
    }

    if (handled) {
      e.preventDefault();
      activeObject.setCoords();
      fabricCanvas.current.requestRenderAll();
      (activeObject as any).fire('modified');
    }
  }, [animateZoom, fitToScreen, onSelectElement, onUpdateState, performDelete, pickerMode]);

  // ---- Bind events ----
  useEffect(() => {
    const canvas = fabricCanvas.current;
    if (!canvas) return;

    canvas.on('mouse:wheel', handleWheel);
    canvas.on('mouse:dblclick', handleDoubleClick);
    canvas.on('mouse:down', handleMouseDown);
    canvas.on('mouse:move', handleMouseMove);
    canvas.on('mouse:up', handleMouseUp);
    canvas.on('selection:created', handleSelectionChange);
    canvas.on('selection:updated', handleSelectionChange);
    canvas.on('selection:cleared', handleSelectionCleared);
    window.addEventListener('keydown', handleKeyDown);

    // Native touch events for pinch-to-zoom (Fabric.js v7 touch:gesture never fires)
    const upperEl = canvas.upperCanvasEl;
    upperEl.style.touchAction = 'none';
    upperEl.style.webkitUserSelect = 'none';
    upperEl.addEventListener('touchstart', handleNativeTouch, { passive: false, capture: true });
    upperEl.addEventListener('touchmove', handleNativeTouch, { passive: false, capture: true });
    upperEl.addEventListener('touchend', handleNativeTouch, { passive: false, capture: true });
    upperEl.addEventListener('touchcancel', handleNativeTouch, { passive: false, capture: true });

    return () => {
      canvas.off('mouse:wheel', handleWheel);
      canvas.off('mouse:dblclick', handleDoubleClick);
      canvas.off('mouse:down', handleMouseDown);
      canvas.off('mouse:move', handleMouseMove);
      canvas.off('mouse:up', handleMouseUp);
      canvas.off('selection:created', handleSelectionChange);
      canvas.off('selection:updated', handleSelectionChange);
      canvas.off('selection:cleared', handleSelectionCleared);
      window.removeEventListener('keydown', handleKeyDown);

      upperEl.removeEventListener('touchstart', handleNativeTouch, true);
      upperEl.removeEventListener('touchmove', handleNativeTouch, true);
      upperEl.removeEventListener('touchend', handleNativeTouch, true);
      upperEl.removeEventListener('touchcancel', handleNativeTouch, true);
    };
  }, [handleWheel, handleNativeTouch, handleDoubleClick, handleKeyDown, handleMouseDown, handleMouseMove, handleMouseUp, handleSelectionChange, handleSelectionCleared]);

  // ---- Mobile lifecycle recovery ----
  useEffect(() => {
    const resetOnSuspend = () => {
      resetCanvasInteraction();
    };

    const refreshOnResume = () => {
      refreshCanvasAfterLifecycleResume();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        resetOnSuspend();
      } else {
        refreshOnResume();
      }
    };

    const handleViewportChange = () => {
      if (lifecycleResizeTimerRef.current) {
        clearTimeout(lifecycleResizeTimerRef.current);
      }
      lifecycleResizeTimerRef.current = setTimeout(() => {
        lifecycleResizeTimerRef.current = null;
        refreshOnResume();
      }, 120);
    };

    const handleGlobalTouchFinalized = (event: TouchEvent) => {
      if (event.touches.length !== 0) return;
      const canvas = fabricCanvas.current;
      const hasDanglingTouchState =
        event.type === 'touchcancel' ||
        isPinching.current ||
        pinchStartDistance.current !== null ||
        !!touchTransformRef.current ||
        isPanningRef.current ||
        !!(canvas && (canvas as any)._currentTransform);

      if (hasDanglingTouchState) {
        resetCanvasInteraction();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', resetOnSuspend);
    window.addEventListener('blur', resetOnSuspend);
    window.addEventListener('pageshow', refreshOnResume);
    window.addEventListener('focus', refreshOnResume);
    window.addEventListener('orientationchange', handleViewportChange);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('touchend', handleGlobalTouchFinalized);
    window.addEventListener('touchcancel', handleGlobalTouchFinalized);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', resetOnSuspend);
      window.removeEventListener('blur', resetOnSuspend);
      window.removeEventListener('pageshow', refreshOnResume);
      window.removeEventListener('focus', refreshOnResume);
      window.removeEventListener('orientationchange', handleViewportChange);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('touchend', handleGlobalTouchFinalized);
      window.removeEventListener('touchcancel', handleGlobalTouchFinalized);

      if (lifecycleResizeTimerRef.current) {
        clearTimeout(lifecycleResizeTimerRef.current);
        lifecycleResizeTimerRef.current = null;
      }
      if (lifecycleFrameRef.current !== null) {
        cancelAnimationFrame(lifecycleFrameRef.current);
        lifecycleFrameRef.current = null;
      }
    };
  }, [refreshCanvasAfterLifecycleResume, resetCanvasInteraction]);

  // ---- Transform safety ----
  const isFiniteTransform = (transform?: ObjectTransform | null): transform is ObjectTransform => (
    !!transform &&
    Number.isFinite(transform.left) &&
    Number.isFinite(transform.top) &&
    Number.isFinite(transform.scaleX) &&
    Number.isFinite(transform.scaleY) &&
    Number.isFinite(transform.angle)
  );

  const rememberObjectTransform = (obj: fabric.Object) => {
    const transform: ObjectTransform = {
      left: obj.left ?? NaN,
      top: obj.top ?? NaN,
      scaleX: obj.scaleX ?? NaN,
      scaleY: obj.scaleY ?? NaN,
      angle: obj.angle ?? 0,
    };
    if (isFiniteTransform(transform)) {
      (obj as any)._lastValidTransform = transform;
      return transform;
    }
    return null;
  };

  const restoreObjectTransform = (obj: fabric.Object) => {
    const lastValid = (obj as any)._lastValidTransform;
    if (isFiniteTransform(lastValid)) {
      obj.set(lastValid);
      obj.setCoords();
      return true;
    }
    return false;
  };

  const enforceTouchBodyDragTransform = (obj: fabric.Object) => {
    const touchTransform = touchTransformRef.current;
    if (!touchTransform || touchTransform.target !== obj || touchTransform.startedOnControl) return false;
    obj.set({
      scaleX: touchTransform.startScaleX,
      scaleY: touchTransform.startScaleY,
      angle: touchTransform.startAngle,
    });
    obj.setCoords();
    return true;
  };

  const guardObjectTransform = (obj: fabric.Object) => {
    const lockedBodyDrag = enforceTouchBodyDragTransform(obj);
    if (!clampObjectScale(obj)) {
      restoreObjectTransform(obj);
      fabricCanvas.current?.requestRenderAll();
      return;
    }
    obj.setCoords();
    if (!rememberObjectTransform(obj)) {
      restoreObjectTransform(obj);
      fabricCanvas.current?.requestRenderAll();
    }
    if (lockedBodyDrag) {
      fabricCanvas.current?.requestRenderAll();
    }
  };

  const decorationTransformRelativeToProduct = (
    productObject: fabric.Object,
    decorationObject: fabric.Object
  ): DecorationRelativeTransform | null => {
    const productCenter = productObject.getCenterPoint();
    const decorationCenter = decorationObject.getCenterPoint();
    const productScaleX = productObject.scaleX ?? 1;
    const productScaleY = productObject.scaleY ?? 1;
    const productWidth = Math.max(1, (productObject.width ?? 1) * productScaleX);
    const productHeight = Math.max(1, (productObject.height ?? 1) * productScaleY);
    if (productScaleX <= 0 || productScaleY <= 0) return null;

    const angle = ((productObject.angle ?? 0) * Math.PI) / 180;
    const deltaX = decorationCenter.x - productCenter.x;
    const deltaY = decorationCenter.y - productCenter.y;
    const localX = Math.cos(angle) * deltaX + Math.sin(angle) * deltaY;
    const localY = -Math.sin(angle) * deltaX + Math.cos(angle) * deltaY;
    const relativeTransform: DecorationRelativeTransform = {
      x: localX / productWidth,
      y: localY / productHeight,
      scaleX: (decorationObject.scaleX ?? 1) / productScaleX,
      scaleY: (decorationObject.scaleY ?? 1) / productScaleY,
      angle: (decorationObject.angle ?? 0) - (productObject.angle ?? 0),
    };
    return Object.values(relativeTransform).every(Number.isFinite)
      ? relativeTransform
      : null;
  };

  const positionDecorationFromProduct = (
    productObject: fabric.Object,
    decorationObject: fabric.Object,
    relativeTransform: DecorationRelativeTransform
  ) => {
    const productCenter = productObject.getCenterPoint();
    const productScaleX = productObject.scaleX ?? 1;
    const productScaleY = productObject.scaleY ?? 1;
    const productWidth = Math.max(1, (productObject.width ?? 1) * productScaleX);
    const productHeight = Math.max(1, (productObject.height ?? 1) * productScaleY);
    const angle = ((productObject.angle ?? 0) * Math.PI) / 180;
    const localX = relativeTransform.x * productWidth;
    const localY = relativeTransform.y * productHeight;
    const center = new fabric.Point(
      productCenter.x + Math.cos(angle) * localX - Math.sin(angle) * localY,
      productCenter.y + Math.sin(angle) * localX + Math.cos(angle) * localY
    );
    decorationObject.set({
      scaleX: relativeTransform.scaleX * productScaleX,
      scaleY: relativeTransform.scaleY * productScaleY,
      angle: relativeTransform.angle + (productObject.angle ?? 0),
    });
    decorationObject.setPositionByOrigin(center, 'center', 'center');
    decorationObject.setCoords();
    rememberObjectTransform(decorationObject);
  };

  const productObjectForElement = (
    canvas: fabric.Canvas,
    productElementId: string | null | undefined
  ) => productElementId
    ? canvas.getObjects().find(object =>
        (object as any)._elementId === productElementId &&
        (object as any)._elementType === 'product'
      )
    : undefined;

  const applyDecorationRelationship = (
    canvas: fabric.Canvas,
    element: CanvasElement,
    decorationObject: fabric.Object
  ) => {
    if (!isDecorationElement(element)) return false;
    const productObject = productObjectForElement(canvas, element.placedOnProductId);
    if (!productObject) return false;

    if (element.relativeTransform) {
      positionDecorationFromProduct(
        productObject,
        decorationObject,
        element.relativeTransform
      );
      return true;
    }
    if (element.transform) return false;

    const productElement = stateRef.current.elements.find(
      candidate =>
        candidate.id === element.placedOnProductId &&
        candidate.type === 'product'
    );
    const objectGarmentGeometry = (productObject as any)._garmentGeometry;
    const anchorProduct = productElement
      ? {
          ...productElement,
          garmentGeometry:
            objectGarmentGeometry ?? productElement.garmentGeometry,
        }
      : undefined;
    const anchor = mockupPlacementAnchor(
      anchorProduct,
      element.placement ?? 'custom'
    );
    const productCenter = productObject.getCenterPoint();
    const productWidth = Math.max(
      1,
      (productObject.width ?? 1) * (productObject.scaleX ?? 1)
    );
    const productHeight = Math.max(
      1,
      (productObject.height ?? 1) * (productObject.scaleY ?? 1)
    );
    const angle = ((productObject.angle ?? 0) * Math.PI) / 180;
    const localX = anchor.x * productWidth;
    const localY = anchor.y * productHeight;
    decorationObject.setPositionByOrigin(
      new fabric.Point(
        productCenter.x + Math.cos(angle) * localX - Math.sin(angle) * localY,
        productCenter.y + Math.sin(angle) * localX + Math.cos(angle) * localY
      ),
      'center',
      'center'
    );
    decorationObject.set({ angle: productObject.angle ?? 0 });
    decorationObject.setCoords();
    rememberObjectTransform(decorationObject);
    return true;
  };

  const pointInsidePolygon = (
    point: fabric.Point,
    polygon: fabric.Point[]
  ) => {
    let inside = false;
    for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
      const currentPoint = polygon[current];
      const previousPoint = polygon[previous];
      const crosses =
        (currentPoint.y > point.y) !== (previousPoint.y > point.y) &&
        point.x <
          ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
            (previousPoint.y - currentPoint.y) +
            currentPoint.x;
      if (crosses) inside = !inside;
    }
    return inside;
  };

  const ownerAfterDecorationMove = (
    canvas: fabric.Canvas,
    decorationObject: fabric.Object,
    currentOwnerId: string | null
  ) => {
    const center = decorationObject.getCenterPoint();
    const candidates = canvas.getObjects().filter(object =>
      (object as any)._elementType === 'product' &&
      pointInsidePolygon(center, object.getCoords())
    );
    if (candidates.length === 1) {
      return (candidates[0] as any)._elementId as string;
    }
    if (candidates.length > 1 && currentOwnerId) {
      const currentOwnerStillContainsDecoration = candidates.some(
        candidate => (candidate as any)._elementId === currentOwnerId
      );
      if (currentOwnerStillContainsDecoration) return currentOwnerId;
    }
    // Outside every product keeps an existing owner; an ambiguous unowned
    // element stays unowned instead of guessing.
    return currentOwnerId;
  };

  const applyOwnedDecorationTransforms = (
    canvas: fabric.Canvas,
    productElementId: string
  ) => {
    const productObject = productObjectForElement(canvas, productElementId);
    if (!productObject) return;
    stateRef.current.elements.forEach(element => {
      if (
        !isDecorationElement(element) ||
        element.placedOnProductId !== productElementId ||
        !element.relativeTransform
      ) return;
      const decorationObject = canvas.getObjects().find(
        object => (object as any)._elementId === element.id
      );
      if (!decorationObject) return;
      positionDecorationFromProduct(
        productObject,
        decorationObject,
        element.relativeTransform
      );
    });
    canvas.requestRenderAll();
  };

  // ---- Main render logic ----
  useEffect(() => {
    if (!fabricCanvas.current) return;

    const canvas = fabricCanvas.current;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const render = async () => {
      if (abortController.signal.aborted) return;

      try {
        const newProduct = [...stateRef.current.elements].reverse().find(
          element => element.type === 'product' && !renderedProductIdsRef.current.has(element.id)
        );
        setFailedImageCount(0);
        const restoredImageFailureCount = await renderElements(canvas, abortController.signal);
        if (abortController.signal.aborted) return;
        renderedProductIdsRef.current = new Set(stateRef.current.elements.filter(element => element.type === 'product').map(element => element.id));
        setFailedImageCount(restoredImageFailureCount);
        if (state.elements.length > 0) {
          if (!hasFitToScreen.current) {
            fitToScreen();
            hasFitToScreen.current = true;
          } else if (newProduct && !pickerMode) {
            const productObject = canvas
              .getObjects()
              .find(object => (object as any)._elementId === newProduct.id);
            if (productObject) {
              canvas.setActiveObject(productObject);
              setSelectedElementId(newProduct.id);
              onSelectElement(newProduct.id, 'product');
              revealObjectWithoutChangingZoom(productObject);
            }
          }
        } else {
          canvas.remove(...canvas.getObjects());
          canvas.requestRenderAll();
          hasFitToScreen.current = false;
        }
        // Persist initial positions too: opening a saved project on a different
        // viewport must not recalculate where previously untouched elements sit.
        if (stateRef.current.elements.some(element => !element.transform && canvas.getObjects().some(object => (object as any)._elementId === element.id))) {
          syncState(canvas);
        }
      } catch (err) {
        console.error('Editor render error:', err);
        canvas.requestRenderAll();
      }
    };

    render();

    return () => {
      abortController.abort();
    };
    // elementsKey is the render invalidation boundary; renderElements reads the same snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elementsKey, fitToScreen, onSelectElement, pickerMode, revealObjectWithoutChangingZoom]);

  // ---- Transform-only sync (lightweight, for undo/redo) ----
  const transformsKey = useMemo(() => JSON.stringify(
    state.elements.map(e => e.transform ? `${e.id}:${e.transform.left},${e.transform.top},${e.transform.scaleX},${e.transform.scaleY},${e.transform.angle}` : e.id)
  ), [state.elements]);

  useEffect(() => {
    if (!fabricCanvas.current) return;
    const canvas = fabricCanvas.current;

    for (const element of state.elements) {
      const obj = canvas.getObjects().find(o => (o as any)._elementId === element.id);
      if (obj && element.transform && isFiniteTransform(element.transform)) {
        obj.set(element.transform);
        clampObjectScale(obj);
        obj.setCoords();
        rememberObjectTransform(obj);
      }
    }
    canvas.requestRenderAll();
    // transformsKey captures every transform value; helper identities are intentionally ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transformsKey]);

  useEffect(() => {
    if (!fabricCanvas.current || externalSelectedElementId === undefined) return;
    const canvas = fabricCanvas.current;

    if (!externalSelectedElementId) {
      if (canvas.getActiveObject()) {
        canvas.discardActiveObject();
        canvas.requestRenderAll();
      }
      setSelectedElementId(null);
      return;
    }

    const obj = canvas.getObjects().find(o => (o as any)._elementId === externalSelectedElementId);
    if (obj && canvas.getActiveObject() !== obj) {
      canvas.setActiveObject(obj);
      setSelectedElementId(externalSelectedElementId);
      canvas.requestRenderAll();
      requestAnimationFrame(keepActiveTextAboveMobileInset);
    }
  }, [externalSelectedElementId, elementsKey, keepActiveTextAboveMobileInset]);

  useEffect(() => {
    if (!mobileBottomInset || externalSelectedElementType !== 'text') return;
    requestAnimationFrame(keepActiveTextAboveMobileInset);
  }, [mobileBottomInset, externalSelectedElementType, selectedElementId, elementsKey, keepActiveTextAboveMobileInset]);

  // ---- renderElements ----
  const renderElements = async (canvas: fabric.Canvas, signal: AbortSignal): Promise<number> => {
    const elements = state.elements;
    if (!elements.length) {
      canvas.remove(...canvas.getObjects());
      canvas.requestRenderAll();
      return 0;
    }

    // Load fonts
    const fontFamilies = elements.filter(e => e.type === 'text' && e.fontFamily).map(e => e.fontFamily!);
    await loadFonts(fontFamilies);
    if (signal.aborted) return 0;

    // Remove orphaned objects
    const elementIds = new Set(elements.map(e => e.id));
    canvas.getObjects()
      .filter(o => !elementIds.has((o as any)._elementId))
      .forEach(o => canvas.remove(o));

    // Render elements in order (z-index = array index)
    // First render product images (send to back), then logos, then texts
    const sortedElements = [...elements].sort((a, b) => {
      const order = { product: 0, logo: 1, text: 2 };
      return order[a.type] - order[b.type];
    });

    const imageElements = sortedElements.filter(
      element => element.type === 'product' || element.type === 'logo'
    );
    const positionedImageElements = imageElements.filter(element => element.transform);
    const unpositionedImageElements = imageElements.filter(element => !element.transform);

    const renderPositionedImage = async (element: CanvasElement) => {
      if (signal.aborted) return;
      const existingObj = canvas.getObjects().find(o => (o as any)._elementId === element.id);
      await renderImageElement(canvas, element, existingObj, signal);
    };

    const positionedImageResults = await Promise.allSettled(
      positionedImageElements.map(renderPositionedImage)
    );
    if (signal.aborted) return 0;

    const failedPositionedImages = positionedImageResults
      .map((result, index) => result.status === 'rejected' ? positionedImageElements[index] : null)
      .filter((element): element is CanvasElement => element !== null);

    let restoredImageFailureCount = 0;
    if (failedPositionedImages.length > 0) {
      const retryResults = await Promise.allSettled(
        failedPositionedImages.map(renderPositionedImage)
      );
      if (signal.aborted) return 0;

      const failedElementIds = retryResults
        .map((result, index) => result.status === 'rejected' ? failedPositionedImages[index].id : null)
        .filter((elementId): elementId is string => elementId !== null);
      restoredImageFailureCount = failedElementIds.length;
      if (failedElementIds.length > 0) {
        console.error('Editor image restore failed after retry:', { failedElementIds });
      }
    }

    // New products without saved coordinates still load in order because placement depends
    // on the right edge of products already added to the canvas.
    for (const element of unpositionedImageElements) {
      const existingObj = canvas.getObjects().find(o => (o as any)._elementId === element.id);
      await renderImageElement(canvas, element, existingObj, signal);
      if (signal.aborted) return 0;
    }

    for (const element of sortedElements.filter(candidate => candidate.type === 'text')) {
      const existingObj = canvas.getObjects().find(o => (o as any)._elementId === element.id);
      renderTextElement(canvas, element, existingObj);
    }

    sortedElements.forEach((element, index) => {
      const object = canvas
        .getObjects()
        .find(candidate => (candidate as any)._elementId === element.id);
      if (object) canvas.moveObjectTo(object, index);
    });

    canvas.requestRenderAll();

    // Sync initial positions to state
    const currentState = stateRef.current;
    const hasMissingTransformOrRelationship = currentState.elements.some(
      element =>
        !element.transform ||
        (isDecorationElement(element) &&
          !!element.placedOnProductId &&
          !element.relativeTransform)
    );
    if (!hasMissingTransformOrRelationship) return restoredImageFailureCount;

    const updatedElements = currentState.elements.map(element => {
      const obj = canvas.getObjects().find(o => (o as any)._elementId === element.id);
      if (!obj) return element;
      const transform = element.transform ?? rememberObjectTransform(obj);
      if (!transform) {
        restoreObjectTransform(obj);
        return element;
      }
      if (isDecorationElement(element) && element.placedOnProductId) {
        const productObject = productObjectForElement(
          canvas,
          element.placedOnProductId
        );
        const relativeTransform = productObject
          ? decorationTransformRelativeToProduct(productObject, obj)
          : null;
        return {
          ...element,
          transform,
          relativeTransform: relativeTransform ?? element.relativeTransform,
        };
      }
      return element.transform ? element : { ...element, transform };
    });
    onUpdateState({ elements: updatedElements });
    return restoredImageFailureCount;
  };

  const renderImageElement = async (canvas: fabric.Canvas, element: CanvasElement, existingObj: fabric.Object | undefined, signal: AbortSignal) => {
    if (!element.image) return;

    const existingImg = existingObj as fabric.Image | undefined;
    const isProduct = element.type === 'product';

    if (existingImg && (existingImg.getElement() as HTMLImageElement)?.src === element.image) {
      // Same image - just update transform
      if (isProduct) {
        (existingImg as any)._garmentGeometry = element.garmentGeometry;
      }
      if (!Number.isFinite((existingImg as any)._baseScale)) {
        const canvasH = fabricCanvas.current?.height ?? 700;
        const targetHeight = Math.min(900, Math.max(420, canvasH * 0.82));
        const scale = targetHeight / existingImg.height!;
        (existingImg as any)._baseScale = scale;
      }
      if (!applyDecorationRelationship(canvas, element, existingImg)) {
        applyElementTransform(existingImg, element.transform);
      }
      existingImg.set({
        selectable: !pickerMode,
        hasControls: !pickerMode,
        lockMovementX: pickerMode,
        lockMovementY: pickerMode,
      });
      rememberObjectTransform(existingImg);
      return;
    }

    const img = await loadFabricImage(element.image, signal);
    if (signal.aborted || !fabricCanvas.current) return;

    const canvasH = fabricCanvas.current?.height ?? 700;
    const canvasW = fabricCanvas.current?.width ?? 900;
    const targetHeight = Math.min(900, Math.max(420, canvasH * 0.82));
    const baseScale = isProduct
      ? Math.min(
          targetHeight / img.height!,
          (canvasW * 0.82) / img.width!
        )
      : targetHeight * 0.08 / img.height!;

    img.set({
      scaleX: baseScale, scaleY: baseScale,
      originX: 'center', originY: 'center',
      cornerColor: '#3b82f6', cornerStrokeColor: '#ffffff',
      cornerSize: 12, touchCornerSize: MOBILE_CONTROL_TOUCH_SIZE, transparentCorners: false,
      padding: 8, borderColor: '#3b82f6', borderScaleFactor: 2,
      hoverCursor: 'pointer', moveCursor: 'grabbing',
      selectable: !pickerMode,
      evented: true,
      hasControls: !pickerMode,
      lockMovementX: pickerMode,
      lockMovementY: pickerMode,
    });
    (img as any)._elementId = element.id;
    (img as any)._elementType = element.type;
    (img as any)._baseScale = baseScale;
    if (isProduct) {
      (img as any)._garmentGeometry = element.garmentGeometry;
      if (!element.garmentGeometry) {
        const analysisKey = `${element.id}:${element.image.length}:${element.image.slice(0, 64)}:${element.image.slice(-64)}`;
        if (!garmentGeometryAttemptKeysRef.current.has(analysisKey)) {
          garmentGeometryAttemptKeysRef.current.add(analysisKey);
          try {
            const imageElement = img.getElement();
            if (imageElement instanceof HTMLImageElement) {
              const garmentGeometry = detectProductGarmentGeometry(imageElement);
              if (garmentGeometry && !signal.aborted) {
                (img as any)._garmentGeometry = garmentGeometry;
                const currentState = stateRef.current;
                const currentProduct = currentState.elements.find(
                  candidate => candidate.id === element.id
                );
                if (
                  currentProduct?.type === 'product' &&
                  currentProduct.image === element.image &&
                  !currentProduct.garmentGeometry
                ) {
                  const updatedElements = setMockupProductGarmentGeometry(
                    currentState.elements,
                    element.id,
                    garmentGeometry
                  );
                  stateRef.current = {
                    ...currentState,
                    elements: updatedElements,
                  };
                  onUpdateState({ elements: updatedElements });
                }
              }
            }
          } catch (error) {
            console.warn('Product garment geometry detection skipped:', {
              elementId: element.id,
              error,
            });
          }
        }
      }
    }
    if (pickerMode && isProduct) {
      img.on('mousedown', () => {
        if (!pickerDisabledProductIds?.has(element.id)) {
          onTogglePickerProduct?.(element.id);
        }
      });
    }

    if (!element.transform && isProduct) {
      const existingProducts = canvas
        .getObjects()
        .filter(object => (object as any)._elementType === 'product')
        .map(object => object.getBoundingRect());
      const placement = getNewProductPlacement(
        existingProducts,
        img.getScaledWidth(),
        canvas.getVpCenter()
      );
      img.set({ left: placement.x, top: placement.y });
      img.setCoords();
    } else if (!applyDecorationRelationship(canvas, element, img)) {
      applyElementTransform(img, element.transform);
    }
    rememberObjectTransform(img);

    const baseScaleConst = baseScale;
    const guardAndFollowOwnedDecorations = () => {
      guardObjectTransform(img);
      if (isProduct) applyOwnedDecorationTransforms(canvas, element.id);
    };
    img.on('moving', guardAndFollowOwnedDecorations);
    img.on('scaling', guardAndFollowOwnedDecorations);
    img.on('rotating', guardAndFollowOwnedDecorations);
    img.on('modified', () => syncState(canvas, img));
    img.on('mousedblclick', () => {
      // For product images, don't reset scale on double-click (useful for AI actions)
      if (isProduct) return;
      img.set({ scaleX: baseScaleConst, scaleY: baseScaleConst });
      img.setCoords();
      canvas.requestRenderAll();
      syncState(canvas, img);
    });
    img.on('scaling', () => {
      const scale = img.scaleX || 1;
      if (Math.abs(scale - baseScaleConst) < baseScaleConst * 0.1) {
        img.set({ borderColor: '#22c55e', cornerColor: '#22c55e' });
      } else {
        img.set({ borderColor: '#3b82f6', cornerColor: '#3b82f6' });
      }
    });
    // Keep the old image until its replacement is ready. Removing an active
    // Fabric object first emits selection:cleared and unmounts the Logo picker.
    // Read the live selection after loading so a user who switched elements
    // while the image was loading does not get pulled back to this one.
    const replacedObject = canvas.getObjects().find(o => (o as any)._elementId === element.id);
    const replaceActiveObject = !!replacedObject && canvas.getActiveObject() === replacedObject;
    canvas.add(img);
    if (replaceActiveObject) canvas.setActiveObject(img);
    if (replacedObject) canvas.remove(replacedObject);
    canvas.requestRenderAll();
  };

  const renderTextElement = (canvas: fabric.Canvas, element: CanvasElement, existingObj: fabric.Object | undefined) => {
    const textFill = element.textGradient ? makeFabricGradient(element.textGradient) : element.textColor || '#000000';
    const textAlign = getTextAlign(element);
    const configureTextObject = (textObj: fabric.IText) => {
      (textObj as any)._baseScale = 1;
      textObj.set({
        text: element.text || '',
        fontFamily: element.fontFamily || '文源黑体Regular',
        fill: textFill,
        fontSize: TEXT_FONT_SIZE,
        originX: textAlign,
        originY: 'center',
        fontWeight: (element.fontWeight || 'normal') as any,
        fontStyle: (element.fontStyle || 'normal') as any,
        underline: element.textUnderline,
        charSpacing: (element.letterSpacing || 0) * 10,
        textAlign,
        selectable: !pickerMode,
        evented: !pickerMode,
      });
      applyArcPath(textObj, element);
      if (!textObj.isEditing) {
        if (!applyDecorationRelationship(canvas, element, textObj)) {
          applyElementTransform(textObj, element.transform);
        }
        rememberObjectTransform(textObj);
      }
    };

    if (existingObj && existingObj instanceof fabric.IText && !(existingObj as any)._isArcGroup) {
      configureTextObject(existingObj);
      return;
    }

    if (existingObj) {
      canvas.remove(existingObj);
    }

    const textObj = new fabric.IText(element.text || '', {
      fontFamily: element.fontFamily || '文源黑体Regular',
      fill: textFill,
      fontSize: TEXT_FONT_SIZE,
      originX: textAlign,
      originY: 'center',
      fontWeight: (element.fontWeight || 'normal') as any,
      fontStyle: (element.fontStyle || 'normal') as any,
      underline: element.textUnderline,
      charSpacing: (element.letterSpacing || 0) * 10,
      textAlign,
    });
    configureTextObject(textObj);

    textObj.set({
      originY: 'center',
      cornerColor: '#3b82f6', cornerStrokeColor: '#ffffff',
      cornerSize: 12, touchCornerSize: MOBILE_CONTROL_TOUCH_SIZE, transparentCorners: false,
      padding: 8, borderColor: '#3b82f6', borderScaleFactor: 2,
    });
    (textObj as any)._elementId = element.id;
    (textObj as any)._elementType = 'text';
    (textObj as any)._baseScale = 1;
    textObj.on('moving', () => guardObjectTransform(textObj));
    textObj.on('scaling', () => guardObjectTransform(textObj));
    textObj.on('rotating', () => guardObjectTransform(textObj));
    textObj.on('modified', () => syncState(canvas, textObj));
    // Sync text content back to state when edited on canvas
    textObj.on('changed', () => {
      syncTextContent(canvas);
    });
    textObj.on('editing:exited', () => {
      const text = (textObj.text || '').trim();
      if (text && text !== MOCKUP_TEXT_PLACEHOLDER) return;
      // A text left empty or untouched is removed instead of staying as an empty layer.
      const current = stateRef.current;
      if (!current.elements.some(item => item.id === element.id)) return;
      onUpdateState(removeElementFromCustomizationState(current, element.id));
      onSelectElement(null, null);
    });
    textObj.on('scaling', () => {
      const scale = textObj.scaleX || 1;
      if (Math.abs(scale - 1) < 0.08) {
        textObj.set({ borderColor: '#22c55e', cornerColor: '#22c55e' });
      } else {
        textObj.set({ borderColor: '#3b82f6', cornerColor: '#3b82f6' });
      }
    });
    canvas.add(textObj);
    if (pendingTextEditRef.current === element.id) {
      requestAnimationFrame(() => {
        if (pendingTextEditRef.current === element.id) beginTextEditing(element.id);
      });
    }
  };

  // New text opens in inline editing with the placeholder selected, so typing replaces it.
  // It is drawn at once instead of waiting for images and the 4.5MB Chinese font; the font
  // swaps in when it arrives.
  const beginTextEditing = (elementId: string, attempt = 0) => {
    const canvas = fabricCanvas.current;
    let textObj = canvas?.getObjects().find(object => (object as any)._elementId === elementId);
    if (canvas && !textObj) {
      const element = stateRef.current.elements.find(item => item.id === elementId && item.type === 'text');
      if (element && (!element.placedOnProductId || productObjectForElement(canvas, element.placedOnProductId))) {
        renderTextElement(canvas, element, undefined);
        textObj = canvas.getObjects().find(object => (object as any)._elementId === elementId);
        const family = element.fontFamily || DEFAULT_TEXT_FONT;
        if (!fontLoadCache.has(family)) {
          void loadFont(family).then(() => {
            fabric.cache.clearFontCache(family);
            const drawn = canvas.getObjects().find(object => (object as any)._elementId === elementId);
            if (drawn instanceof fabric.IText) { drawn.initDimensions(); drawn.setCoords(); canvas.requestRenderAll(); }
          });
        }
      } else if (attempt < 10) {
        // The new element reaches this component on its next render.
        pendingTextEditRef.current = elementId;
        requestAnimationFrame(() => {
          if (pendingTextEditRef.current === elementId) beginTextEditing(elementId, attempt + 1);
        });
        return;
      }
    }
    if (!canvas || !(textObj instanceof fabric.IText)) {
      pendingTextEditRef.current = elementId;
      return;
    }
    pendingTextEditRef.current = null;
    canvas.setActiveObject(textObj);
    textObj.enterEditing();
    textObj.selectAll();
    canvas.requestRenderAll();
  };

  const applyElementTransform = (obj: fabric.Object, transform?: ObjectTransform) => {
    if (transform && isFiniteTransform(transform)) {
      obj.set(transform);
      clampObjectScale(obj);
      obj.setCoords();
    } else {
      // Default position: center of current viewport
      const canvas = fabricCanvas.current;
      if (canvas) {
        const center = canvas.getVpCenter();
        obj.set({ left: center.x, top: center.y });
        obj.setCoords();
      }
    }
  };

  // ---- syncState ----
  // Sync only text content from canvas IText objects back to state (Bug 3)
  const syncTextContent = useCallback((canvas: fabric.Canvas) => {
    const currentState = stateRef.current;
    let changed = false;
    const updatedElements = currentState.elements.map(element => {
      if (element.type !== 'text') return element;
      const obj = canvas.getObjects().find(o => (o as any)._elementId === element.id);
      if (!obj || !(obj instanceof fabric.IText)) return element;
      const newText = obj.text || '';
      if (newText !== (element.text || '')) {
        changed = true;
        return { ...element, text: newText };
      }
      return element;
    });
    if (changed) {
      onUpdateState({ elements: updatedElements });
    }
  }, [onUpdateState]);

  const syncState = useCallback((
    canvas: fabric.Canvas,
    modifiedObject?: fabric.Object
  ) => {
    const currentState = stateRef.current;
    const modifiedElementId = (modifiedObject as any)?._elementId as string | undefined;
    const modifiedElement = modifiedElementId
      ? currentState.elements.find(element => element.id === modifiedElementId)
      : null;
    const movedDecorationOwnerId =
      modifiedObject && modifiedElement && isDecorationElement(modifiedElement)
        ? ownerAfterDecorationMove(
            canvas,
            modifiedObject,
            modifiedElement.placedOnProductId ?? null
          )
        : undefined;

    const relationshipUpdatedElements = currentState.elements.map(element => {
      if (
        element.id !== modifiedElementId ||
        !isDecorationElement(element) ||
        movedDecorationOwnerId === undefined
      ) return element;
      return {
        ...element,
        placedOnProductId: movedDecorationOwnerId,
        placement: 'custom' as const,
        relativeTransform: undefined,
      };
    });

    const updatedElements = relationshipUpdatedElements.map(element => {
      const obj = canvas.getObjects().find(o => (o as any)._elementId === element.id);
      if (!obj) return element;
      const transform = rememberObjectTransform(obj);
      if (!transform) {
        restoreObjectTransform(obj);
        return element;
      }
      let nextElement: CanvasElement = element.type === 'text' && obj instanceof fabric.IText
        ? { ...element, transform, text: obj.text || '' }
        : { ...element, transform };
      if (isDecorationElement(nextElement) && nextElement.placedOnProductId) {
        const productObject = productObjectForElement(
          canvas,
          nextElement.placedOnProductId
        );
        const relativeTransform = productObject
          ? decorationTransformRelativeToProduct(productObject, obj)
          : null;
        if (relativeTransform) {
          nextElement = { ...nextElement, relativeTransform };
        }
      }
      return nextElement;
    });
    onUpdateState({ elements: updatedElements });
    // Transform guard helpers use refs/current Fabric objects and do not form callback state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onUpdateState]);

  // ---- Export ----
  const handleExport = async () => {
    if (!fabricCanvas.current) return;
    const canvas = fabricCanvas.current;

    const savedVpt = canvas.viewportTransform.slice() as fabric.TMat2D;
    const savedZoom = canvas.getZoom();

    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.setZoom(1);
    canvas.requestRenderAll();

    const exportBounds = getContentBounds();
    const exportOptions = {
      multiplier: 2,
      format: 'jpeg' as const,
      quality: 1,
      ...(exportBounds || {}),
    };
    const hasElements = state.elements.length > 0;
    const fileName = `custom-garment-mockup${hasElements ? '' : '-empty'}.jpg`;
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    try {
      if (isMobile) {
        if (navigator.share) {
          const dataURL = canvasToDataUrl(canvas, exportOptions);
          const blob = await fetch(dataURL).then(r => r.blob());
          const file = new File([blob], fileName, { type: 'image/jpeg' });
          await navigator.share({ files: [file] });
          return;
        }

        if (navigator.clipboard?.write) {
          try {
            const dataURL = canvasToDataUrl(canvas, { ...exportOptions, format: 'png' as const });
            const pngBlob = await fetch(dataURL).then(r => r.blob());
            if (pngBlob) {
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
              toast.success('图片已复制到剪贴板');
            }
          } catch (err: any) {
            console.warn('Clipboard write failed:', err);
          }
          return;
        }
      }

      const dataURL = canvasToDataUrl(canvas, exportOptions);
      const link = document.createElement('a');
      link.download = fileName;
      link.href = dataURL;
      link.click();
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      if (e instanceof Error && e.message === CANVAS_CORS_ERROR_MESSAGE) {
        toast.error(e.message);
        return;
      }

      if (isMobile) {
        console.warn('Mobile share/clipboard failed, fallback to download:', e);
        try {
          const dataURL = canvasToDataUrl(canvas, exportOptions);
          const link = document.createElement('a');
          link.download = fileName;
          link.href = dataURL;
          link.click();
        } catch (fallbackErr) {
          toast.error(fallbackErr instanceof Error ? fallbackErr.message : '下载失败，请稍后重试');
        }
      }
    } finally {
      canvas.setViewportTransform(savedVpt);
      canvas.setZoom(savedZoom);
      canvas.requestRenderAll();
    }
  };

  if (exportRef) exportRef.current = handleExport;

  const captureThumbnail = async (): Promise<string> => {
    if (!fabricCanvas.current) return '';
    const canvas = fabricCanvas.current;

    const savedVpt = canvas.viewportTransform.slice() as fabric.TMat2D;
    const savedZoom = canvas.getZoom();

    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.setZoom(1);
    canvas.requestRenderAll();

    try {
      const bounds = getContentBounds();
      return canvasToDataUrl(canvas, {
        multiplier: 1,
        format: 'jpeg' as const,
        quality: 0.6,
        ...(bounds || {}),
      });
    } finally {
      canvas.setViewportTransform(savedVpt);
      canvas.setZoom(savedZoom);
      canvas.requestRenderAll();
    }
  };

  if (thumbnailRef) thumbnailRef.current = captureThumbnail;

  const captureProducts = async (
    productElementIds: string[]
  ): Promise<CapturedMockupProduct[]> => {
    const canvas = fabricCanvas.current;
    if (!canvas) return [];
    const savedViewport = canvas.viewportTransform.slice() as fabric.TMat2D;
    const savedActiveObject = canvas.getActiveObject();
    const objects = canvas.getObjects();
    const savedVisibility = new Map(objects.map(object => [object, object.visible]));
    const savedShadows = new Map(objects.map(object => [object, object.shadow]));
    const elementById = new Map(
      stateRef.current.elements.map(element => [element.id, element] as const)
    );
    const results: CapturedMockupProduct[] = [];

    try {
      canvas.discardActiveObject();
      canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
      objects.forEach(object => object.set('shadow', undefined));
      for (const productElementId of productElementIds) {
        const productObject = objects.find(
          object =>
            (object as any)._elementId === productElementId &&
            (object as any)._elementType === 'product'
        );
        if (!productObject) continue;
        productObject.setCoords();
        const productBounds = productObject.getBoundingRect();
        const relatedObjects = objects.filter(object => {
          if (object === productObject) return true;
          const type = (object as any)._elementType as ElementType | undefined;
          if (type !== 'logo' && type !== 'text') return false;
          const decorationElementId = (object as any)._elementId as string;
          const decorationElement = elementById.get(decorationElementId);
          if (decorationElement) {
            const explicitMatch = explicitDecorationCaptureMatch(
              decorationElement,
              productElementId
            );
            if (explicitMatch !== null) return explicitMatch;
          }
          // Geometry is compatibility-only for historical saves that do not
          // have an explicit placedOnProductId field.
          object.setCoords();
          const bounds = object.getBoundingRect();
          const centerX = bounds.left + bounds.width / 2;
          const centerY = bounds.top + bounds.height / 2;
          const centerInside =
            centerX >= productBounds.left &&
            centerX <= productBounds.left + productBounds.width &&
            centerY >= productBounds.top &&
            centerY <= productBounds.top + productBounds.height;
          const intersectionWidth = Math.max(
            0,
            Math.min(
              productBounds.left + productBounds.width,
              bounds.left + bounds.width
            ) - Math.max(productBounds.left, bounds.left)
          );
          const intersectionHeight = Math.max(
            0,
            Math.min(
              productBounds.top + productBounds.height,
              bounds.top + bounds.height
            ) - Math.max(productBounds.top, bounds.top)
          );
          const smallerArea = Math.max(
            1,
            Math.min(
              productBounds.width * productBounds.height,
              bounds.width * bounds.height
            )
          );
          return (
            centerInside ||
            (intersectionWidth * intersectionHeight) / smallerArea >= 0.15
          );
        });
        const relatedSet = new Set(relatedObjects);
        objects.forEach(object => object.set('visible', relatedSet.has(object)));
        const visibleBounds = relatedObjects.map(object => object.getBoundingRect());
        const padding = 32;
        const left =
          Math.min(...visibleBounds.map(bounds => bounds.left)) - padding;
        const top =
          Math.min(...visibleBounds.map(bounds => bounds.top)) - padding;
        const right =
          Math.max(...visibleBounds.map(bounds => bounds.left + bounds.width)) +
          padding;
        const bottom =
          Math.max(...visibleBounds.map(bounds => bounds.top + bounds.height)) +
          padding;
        const width = Math.max(1, right - left);
        const height = Math.max(1, bottom - top);
        const multiplier = Math.min(2, 2048 / Math.max(width, height));
        canvas.requestRenderAll();
        results.push({
          productElementId,
          dataUrl: canvasToDataUrl(canvas, {
            left,
            top,
            width,
            height,
            multiplier,
            format: 'jpeg',
            quality: 0.92,
          }),
          logoElementIds: relatedObjects.flatMap(object =>
            (object as any)._elementType === 'logo'
              ? [(object as any)._elementId as string]
              : []
          ),
        });
      }
      return results;
    } finally {
      objects.forEach(object =>
        object.set({
          visible: savedVisibility.get(object) ?? true,
          shadow: savedShadows.get(object),
        })
      );
      canvas.setViewportTransform(savedViewport);
      if (savedActiveObject) canvas.setActiveObject(savedActiveObject);
      canvas.requestRenderAll();
    }
  };

  if (captureProductsRef) captureProductsRef.current = captureProducts;
  if (textEditRef) textEditRef.current = beginTextEditing;

  const pickerSelectedKey = [...(pickerSelectedProductIds ?? new Set<string>())]
    .sort()
    .join('|');
  useEffect(() => {
    if (!pickerMode || !fabricCanvas.current) return;
    const selectedIds = pickerSelectedProductIds ?? new Set<string>();
    const disabledIds = pickerDisabledProductIds ?? new Set<string>();
    for (const object of fabricCanvas.current.getObjects()) {
      if ((object as any)._elementType !== 'product') continue;
      const elementId = (object as any)._elementId;
      const selected = selectedIds.has(elementId);
      const disabled = disabledIds.has(elementId);
      object.set({
        opacity: disabled ? 0.55 : selected ? 1 : 0.82,
        shadow: disabled
          ? new fabric.Shadow({
              color: 'rgba(59,130,246,0.85)',
              blur: 16,
              offsetX: 0,
              offsetY: 0,
            })
          : selected
          ? new fabric.Shadow({
              color: 'rgba(34,197,94,0.9)',
              blur: 18,
              offsetX: 0,
              offsetY: 0,
            })
          : undefined,
      });
    }
    fabricCanvas.current.requestRenderAll();
    // pickerSelectedKey is the stable value boundary for a Set prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elementsKey, pickerMode, pickerSelectedKey, pickerDisabledProductIds]);

  const handleRotateChange = () => {
    if (!fabricCanvas.current) return;
    let activeObject = fabricCanvas.current.getActiveObject();
    if (!activeObject) {
      const target = fabricCanvas.current.getObjects().find(o => o.selectable);
      if (target) { fabricCanvas.current.setActiveObject(target); activeObject = target; }
    }
    if (!activeObject) return;
    activeObject.set('angle', ((activeObject.angle || 0) + 45) % 360).setCoords();
    fabricCanvas.current.requestRenderAll();
    activeObject.fire('modified');
  };

  // ---- Render ----
  return (
    <div className="relative h-full bg-canvas overflow-hidden">
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ cursor: isPanning ? 'grabbing' : 'default', touchAction: 'none', overscrollBehavior: 'none' }}
      >
        <canvas ref={canvasRef} style={{ touchAction: 'none' }} />
      </div>

      <canvas
        ref={measurementCanvasRef}
        className="pointer-events-none absolute inset-0 z-20"
        aria-hidden="true"
      />

      {measurementVisible && (
        <>
          <div
            role="button"
            tabIndex={0}
            onPointerDown={event => startGuideDrag('x', event)}
            className="absolute left-7 right-0 top-0 z-40 hidden h-7 cursor-row-resize items-center border-b border-cyan-200 bg-white/95 px-3 text-[9px] font-semibold text-cyan-700 shadow-sm backdrop-blur md:flex"
            style={{
              backgroundImage:
                'repeating-linear-gradient(90deg, transparent 0, transparent 9px, rgba(8,145,178,.35) 10px)',
            }}
            title="按住并向下拖出竖向基准线"
          >
            <span className="rounded bg-white/90 px-1.5 py-0.5">
              竖向基准线 · 向下拖
            </span>
          </div>
          <div
            role="button"
            tabIndex={0}
            onPointerDown={event => startGuideDrag('y', event)}
            className="absolute bottom-0 left-0 top-7 z-40 hidden w-7 cursor-col-resize items-start justify-center border-r border-cyan-200 bg-white/95 pt-3 text-[9px] font-semibold text-cyan-700 shadow-sm backdrop-blur md:flex"
            style={{
              backgroundImage:
                'repeating-linear-gradient(0deg, transparent 0, transparent 9px, rgba(8,145,178,.35) 10px)',
            }}
            title="按住并向右拖出横向基准线"
          >
            <span
              className="whitespace-nowrap rounded bg-white/90 px-1.5 py-0.5"
              style={{ writingMode: 'vertical-rl' }}
            >
              横向基准线 · 向右拖
            </span>
          </div>

          {calibrationDraft && (
            <div
              className="absolute inset-0 z-30 cursor-crosshair"
              onPointerDown={captureCalibrationPoint}
              aria-label="在画布上选择两个比例尺端点"
            >
              <div className="pointer-events-none absolute left-1/2 top-10 -translate-x-1/2 rounded-lg bg-violet-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-lg">
                点击两个已知位置 · 已选 {calibrationDraft.points.length}/2
              </div>
            </div>
          )}

          <MeasurementPanel
            measurements={measurements}
            guides={measurements.guides}
            dimensions={measurements.dimensions}
            selectedGuideId={selectedGuideId}
            dimensionStartGuideId={dimensionStartGuideId}
            calibrationDraftActive={calibrationDraft !== null}
            calibrationDraftPointCount={calibrationDraft?.points.length ?? 0}
            pendingCalibration={pendingCalibration}
            onClose={closeMeasurements}
            onStartCalibration={startCalibration}
            onCancelCalibration={cancelCalibration}
            onConfirmCalibration={confirmCalibration}
            onSelectGuide={setSelectedGuideId}
            onUpdateGuidePosition={updateGuidePosition}
            onDeleteGuide={deleteMeasurementGuide}
            onCreateOffsetGuide={createOffsetMeasurementGuide}
            onSetDimensionStart={setDimensionStartGuideId}
            onCreateDimension={createMeasurementDimension}
            onDeleteDimension={deleteMeasurementDimension}
          />
        </>
      )}

      {failedImageCount > 0 && (
        <div
          role="alert"
          className="pointer-events-none absolute top-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-amber-200 bg-amber-50/95 px-3 py-2 text-xs font-medium text-amber-800 shadow-sm backdrop-blur-sm"
        >
          {failedImageCount} 张图片加载失败，其余内容已保留。请检查图片后重试。
        </div>
      )}

      {/* Mobile floating action bar for selected objects */}
      {!pickerMode && selectedElementId && externalSelectedElementType !== 'text' && (
        <div className="md:hidden absolute bottom-40 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-white/95 backdrop-blur-md px-2 py-1.5 rounded-xl border border-border shadow-lg z-50">
          <button onClick={() => scaleObject(0.8)} className="w-7 h-7 flex items-center justify-center bg-canvas rounded-md active:bg-border text-ink-2" title="缩小">
            <Minus size={12} />
          </button>
          <button onClick={handleDoubleClick} className="w-7 h-7 flex items-center justify-center bg-canvas rounded-md active:bg-border text-ink-2 text-[8px] font-bold" title="重置大小">
            1x
          </button>
          <button onClick={() => scaleObject(1.25)} className="w-7 h-7 flex items-center justify-center bg-canvas rounded-md active:bg-border text-ink-2" title="放大">
            <Plus size={12} />
          </button>

          <div className="w-px h-5 bg-border mx-0.5" />

          <button onClick={handleRotateChange} className="w-7 h-7 flex items-center justify-center bg-canvas rounded-md active:bg-border text-ink-2" title="旋转">
            <RotateCw size={12} />
          </button>

          <div className="w-px h-5 bg-border mx-0.5" />

          <button onClick={copySelectedElement} className="w-7 h-7 flex items-center justify-center bg-canvas rounded-md active:bg-border text-ink-2" title="复制">
            <Copy size={12} />
          </button>

          <div className="w-px h-5 bg-border mx-0.5" />

          <button onClick={deleteSelectedObject} className="flex items-center gap-0.5 px-1.5 py-1 bg-red-50 text-red-600 rounded-md text-[10px] font-bold active:bg-red-100">
            <Trash2 size={11} />
            删除
          </button>
        </div>
      )}

      {/* Mobile: minimal zoom bar — hidden when floating action bar is showing */}
      {!selectedElementId && (
      <div className="md:hidden absolute bottom-24 left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-white/90 backdrop-blur-md px-2 py-1 rounded-lg border border-border shadow-md z-20">
        <button onClick={fitToScreen} className="px-2 py-1 text-[10px] font-semibold text-ink-2 hover:bg-canvas rounded transition-all tabular-nums" title="适应屏幕">
          {Math.round(zoomLevel * 100)}%
        </button>
        <div className="w-px h-3.5 bg-border" />
        <button onClick={fitToScreen} className="p-1 text-ink-3 hover:bg-canvas rounded transition-all" title="适应屏幕">
          <Maximize2 size={12} />
        </button>
      </div>
      )}

      {/* Bottom center: zoom toolbar (desktop only) */}
      <div className="hidden md:flex absolute bottom-3 left-1/2 -translate-x-1/2 items-center gap-0.5 bg-white/95 backdrop-blur-md px-1.5 py-1 rounded-xl border border-border shadow-lg z-20">
          <button onClick={zoomOut} className="p-2 rounded-lg text-ink-2 hover:bg-canvas transition-all" title="缩小 (Ctrl -)">
            <Minus size={16} />
          </button>
          <button onClick={fitToScreen} className="min-w-[48px] text-center text-xs font-semibold text-ink-2 hover:bg-canvas px-1.5 py-1 rounded-lg transition-all tabular-nums" title="适应屏幕 (Ctrl 0)">
            {Math.round(zoomLevel * 100)}%
          </button>
          <button onClick={zoomIn} className="p-2 rounded-lg text-ink-2 hover:bg-canvas transition-all" title="放大 (Ctrl =)">
            <Plus size={16} />
          </button>

          <div className="w-px h-5 bg-border mx-0.5" />
          <input
            type="range" min="0" max="100" step="1"
            value={zoomToSlider(zoomLevel)}
            onChange={(e) => applyZoom(sliderToZoom(parseFloat(e.target.value)))}
            className="w-24 h-1.5 bg-border rounded-full appearance-none cursor-pointer accent-brand-500 mx-1"
            title={`缩放: ${Math.round(zoomLevel * 100)}%`}
          />
          <div className="w-px h-5 bg-border mx-0.5" />
          <button onClick={fitToScreen} className="p-2 rounded-lg text-ink-2 hover:bg-canvas transition-all" title="适应屏幕">
            <Maximize2 size={16} />
          </button>

          {!pickerMode && (
            <>
              <div className="w-px h-5 bg-border mx-0.5" />
              <button
                onClick={toggleMeasurements}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition-all ${
                  measurementVisible
                    ? 'bg-cyan-50 text-cyan-700'
                    : 'text-ink-2 hover:bg-canvas'
                }`}
                title="标尺、基准线和尺寸标注"
              >
                <Ruler size={16} />
                <span className="text-xs font-medium">标尺</span>
              </button>
            </>
          )}

          {!pickerMode && selectedElementId && (
            <>
              <div className="w-px h-5 bg-border mx-0.5" />
              <button onClick={copySelectedElement} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-brand-600 hover:bg-brand-50 transition-all" title="复制选中元素">
                <Copy size={16} />
                <span className="text-xs font-medium">复制</span>
              </button>
              <button onClick={deleteSelectedObject} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-red-600 hover:bg-red-50 transition-all" title="删除选中元素">
                <Trash2 size={16} />
                <span className="text-xs font-medium">删除</span>
              </button>
            </>
          )}
      </div>
    </div>
  );
}
