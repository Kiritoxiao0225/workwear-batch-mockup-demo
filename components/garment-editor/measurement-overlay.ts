import * as fabric from 'fabric';
import type {
  MeasurementAxis,
  MockupGuide,
  MockupMeasurementState,
} from '@/lib/garment-editor/mockup-types';
import {
  guidePositionCm,
  measurementDistanceCm,
} from '@/lib/garment-editor/mockup-measurements';

export interface MeasurementScenePoint {
  x: number;
  y: number;
}

export interface MeasurementCalibrationOverlay {
  points: MeasurementScenePoint[];
  pending: boolean;
}

export interface MeasurementGuidePreview {
  axis: MeasurementAxis;
  scenePosition: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

function formatCm(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function distance(left: ScreenPoint, right: ScreenPoint) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function normalizeVector(vector: ScreenPoint) {
  const length = Math.max(0.0001, Math.hypot(vector.x, vector.y));
  return { x: vector.x / length, y: vector.y / length };
}

function sceneToScreen(
  point: MeasurementScenePoint,
  canvas: fabric.Canvas
): ScreenPoint {
  const viewportPoint = fabric.util.transformPoint(
    new fabric.Point(point.x, point.y),
    canvas.viewportTransform
  );
  return { x: viewportPoint.x, y: viewportPoint.y };
}

function clipInfiniteLine(
  point: ScreenPoint,
  direction: ScreenPoint,
  width: number,
  height: number
): [ScreenPoint, ScreenPoint] | null {
  const candidates: ScreenPoint[] = [];
  const addCandidate = (candidate: ScreenPoint) => {
    if (
      candidate.x >= -0.5 &&
      candidate.x <= width + 0.5 &&
      candidate.y >= -0.5 &&
      candidate.y <= height + 0.5 &&
      !candidates.some(existing => distance(existing, candidate) < 0.5)
    ) {
      candidates.push(candidate);
    }
  };

  if (Math.abs(direction.x) > 0.0001) {
    const leftT = -point.x / direction.x;
    addCandidate({ x: 0, y: point.y + leftT * direction.y });
    const rightT = (width - point.x) / direction.x;
    addCandidate({ x: width, y: point.y + rightT * direction.y });
  }
  if (Math.abs(direction.y) > 0.0001) {
    const topT = -point.y / direction.y;
    addCandidate({ x: point.x + topT * direction.x, y: 0 });
    const bottomT = (height - point.y) / direction.y;
    addCandidate({ x: point.x + bottomT * direction.x, y: height });
  }
  if (candidates.length < 2) return null;

  let pair: [ScreenPoint, ScreenPoint] = [candidates[0], candidates[1]];
  let longest = distance(pair[0], pair[1]);
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const nextDistance = distance(candidates[left], candidates[right]);
      if (nextDistance > longest) {
        pair = [candidates[left], candidates[right]];
        longest = nextDistance;
      }
    }
  }
  return pair;
}

function drawPill(
  context: CanvasRenderingContext2D,
  text: string,
  point: ScreenPoint,
  background: string,
  foreground = '#ffffff'
) {
  context.save();
  context.font = '600 11px system-ui, sans-serif';
  const width = Math.ceil(context.measureText(text).width) + 12;
  const height = 20;
  const canvasWidth = context.canvas.clientWidth || context.canvas.width;
  const canvasHeight = context.canvas.clientHeight || context.canvas.height;
  const x = Math.min(canvasWidth - width - 4, Math.max(4, point.x + 6));
  const y = Math.min(canvasHeight - height - 4, Math.max(4, point.y + 6));
  context.fillStyle = background;
  context.beginPath();
  context.roundRect(x, y, width, height, 6);
  context.fill();
  context.fillStyle = foreground;
  context.textBaseline = 'middle';
  context.fillText(text, x + 6, y + height / 2);
  context.restore();
}

function drawArrowHead(
  context: CanvasRenderingContext2D,
  tip: ScreenPoint,
  toward: ScreenPoint,
  color: string
) {
  const direction = normalizeVector({
    x: toward.x - tip.x,
    y: toward.y - tip.y,
  });
  const normal = { x: -direction.y, y: direction.x };
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(tip.x, tip.y);
  context.lineTo(
    tip.x + direction.x * 8 + normal.x * 4,
    tip.y + direction.y * 8 + normal.y * 4
  );
  context.lineTo(
    tip.x + direction.x * 8 - normal.x * 4,
    tip.y + direction.y * 8 - normal.y * 4
  );
  context.closePath();
  context.fill();
}

function guideScreenLine(
  canvas: fabric.Canvas,
  guide: MockupGuide,
  width: number,
  height: number
) {
  const anchorScene =
    guide.axis === 'x'
      ? { x: guide.scenePosition, y: 0 }
      : { x: 0, y: guide.scenePosition };
  const directionScene =
    guide.axis === 'x'
      ? { x: guide.scenePosition, y: 1 }
      : { x: 1, y: guide.scenePosition };
  const anchor = sceneToScreen(anchorScene, canvas);
  const directionPoint = sceneToScreen(directionScene, canvas);
  const direction = normalizeVector({
    x: directionPoint.x - anchor.x,
    y: directionPoint.y - anchor.y,
  });
  return clipInfiniteLine(anchor, direction, width, height);
}

function drawGuide(
  context: CanvasRenderingContext2D,
  canvas: fabric.Canvas,
  measurements: MockupMeasurementState,
  guide: MockupGuide,
  options: {
    selected?: boolean;
    preview?: boolean;
    width: number;
    height: number;
  }
) {
  const clipped = guideScreenLine(
    canvas,
    guide,
    options.width,
    options.height
  );
  if (!clipped) return;
  const color = options.preview
    ? '#16a34a'
    : options.selected
      ? '#f97316'
      : '#0891b2';
  const [start, end] = clipped;
  context.save();
  context.strokeStyle = color;
  context.lineWidth = options.selected ? 2 : 1.25;
  context.setLineDash(options.preview ? [7, 5] : [5, 4]);
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  context.restore();

  const labelPoint =
    guide.axis === 'x'
      ? start.y <= end.y
        ? start
        : end
      : start.x <= end.x
        ? start
        : end;
  const positionCm = measurements.scale
    ? options.preview && measurements.axisOrigins[guide.axis] === null
      ? 0
      : guidePositionCm(measurements, guide)
    : null;
  const positionLabel =
    positionCm === null ? '' : `  ${formatCm(positionCm)} cm`;
  drawPill(
    context,
    `${guide.label}${positionLabel}`,
    labelPoint,
    color
  );
}

function drawDimension(
  context: CanvasRenderingContext2D,
  canvas: fabric.Canvas,
  measurements: MockupMeasurementState,
  guideA: MockupGuide,
  guideB: MockupGuide,
  laneIndex: number,
  viewportWidth: number,
  viewportHeight: number
) {
  if (!measurements.scale) return;
  const anchorA = sceneToScreen(
    guideA.axis === 'x'
      ? { x: guideA.scenePosition, y: 0 }
      : { x: 0, y: guideA.scenePosition },
    canvas
  );
  const anchorB = sceneToScreen(
    guideB.axis === 'x'
      ? { x: guideB.scenePosition, y: 0 }
      : { x: 0, y: guideB.scenePosition },
    canvas
  );
  const laneOffset = 42 + laneIndex * 28;
  const dimensionA =
    guideA.axis === 'x'
      ? { x: anchorA.x, y: Math.min(laneOffset, viewportHeight - 20) }
      : {
          x: Math.max(20, viewportWidth - laneOffset),
          y: anchorA.y,
        };
  const dimensionB =
    guideB.axis === 'x'
      ? { x: anchorB.x, y: Math.min(laneOffset, viewportHeight - 20) }
      : {
          x: Math.max(20, viewportWidth - laneOffset),
          y: anchorB.y,
        };
  const edgeA =
    guideA.axis === 'x'
      ? { x: anchorA.x, y: 0 }
      : { x: viewportWidth, y: anchorA.y };
  const edgeB =
    guideB.axis === 'x'
      ? { x: anchorB.x, y: 0 }
      : { x: viewportWidth, y: anchorB.y };
  const color = '#047857';

  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 1.5;
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(edgeA.x, edgeA.y);
  context.lineTo(dimensionA.x, dimensionA.y);
  context.moveTo(edgeB.x, edgeB.y);
  context.lineTo(dimensionB.x, dimensionB.y);
  context.moveTo(dimensionA.x, dimensionA.y);
  context.lineTo(dimensionB.x, dimensionB.y);
  context.stroke();
  drawArrowHead(context, dimensionA, dimensionB, color);
  drawArrowHead(context, dimensionB, dimensionA, color);
  context.restore();

  drawPill(
    context,
    `${formatCm(
      measurementDistanceCm(measurements, guideA, guideB)
    )} cm`,
    {
      x: (dimensionA.x + dimensionB.x) / 2 - 28,
      y: (dimensionA.y + dimensionB.y) / 2 - 10,
    },
    color
  );
}

function drawCalibration(
  context: CanvasRenderingContext2D,
  canvas: fabric.Canvas,
  overlay: MeasurementCalibrationOverlay
) {
  if (overlay.points.length === 0) return;
  const points = overlay.points.map(point => sceneToScreen(point, canvas));
  context.save();
  context.strokeStyle = '#7c3aed';
  context.fillStyle = '#ffffff';
  context.lineWidth = 2;
  context.setLineDash([6, 4]);
  if (points.length > 1) {
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    context.lineTo(points[1].x, points[1].y);
    context.stroke();
  }
  points.forEach(point => {
    context.beginPath();
    context.arc(point.x, point.y, 5, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  });
  context.restore();
  if (points.length > 1) {
    drawPill(
      context,
      overlay.pending ? '输入已知长度' : '设置比例尺',
      {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2,
      },
      '#7c3aed'
    );
  }
}

export function drawMockupMeasurementOverlay(input: {
  overlayCanvas: HTMLCanvasElement;
  fabricCanvas: fabric.Canvas;
  measurements: MockupMeasurementState | undefined;
  selectedGuideId: string | null;
  calibrationOverlay: MeasurementCalibrationOverlay | null;
  guidePreview: MeasurementGuidePreview | null;
}) {
  const width = input.fabricCanvas.width ?? 0;
  const height = input.fabricCanvas.height ?? 0;
  const devicePixelRatio = window.devicePixelRatio || 1;
  const overlayCanvas = input.overlayCanvas;
  const nextWidth = Math.max(1, Math.round(width * devicePixelRatio));
  const nextHeight = Math.max(1, Math.round(height * devicePixelRatio));
  if (overlayCanvas.width !== nextWidth || overlayCanvas.height !== nextHeight) {
    overlayCanvas.width = nextWidth;
    overlayCanvas.height = nextHeight;
    overlayCanvas.style.width = `${width}px`;
    overlayCanvas.style.height = `${height}px`;
  }
  const context = overlayCanvas.getContext('2d');
  if (!context) return;
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);

  const measurements = input.measurements;
  if (!measurements?.visible) return;

  measurements.guides.forEach(guide =>
    drawGuide(context, input.fabricCanvas, measurements, guide, {
      selected: guide.id === input.selectedGuideId,
      width,
      height,
    })
  );
  const dimensionLaneCounts: Record<MeasurementAxis, number> = { x: 0, y: 0 };
  measurements.dimensions.forEach(dimension => {
    const guideA = measurements.guides.find(
      guide => guide.id === dimension.guideAId
    );
    const guideB = measurements.guides.find(
      guide => guide.id === dimension.guideBId
    );
    if (guideA && guideB && guideA.axis === guideB.axis) {
      const laneIndex = dimensionLaneCounts[guideA.axis];
      dimensionLaneCounts[guideA.axis] += 1;
      drawDimension(
        context,
        input.fabricCanvas,
        measurements,
        guideA,
        guideB,
        laneIndex,
        width,
        height
      );
    }
  });

  if (input.guidePreview) {
    const previewGuide: MockupGuide = {
      id: 'guide-preview',
      axis: input.guidePreview.axis,
      scenePosition: input.guidePreview.scenePosition,
      label: input.guidePreview.axis === 'x' ? 'V?' : 'H?',
    };
    drawGuide(context, input.fabricCanvas, measurements, previewGuide, {
      preview: true,
      width,
      height,
    });
  }
  if (input.calibrationOverlay) {
    drawCalibration(context, input.fabricCanvas, input.calibrationOverlay);
  }
}
