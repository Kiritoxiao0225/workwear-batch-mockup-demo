import type {
  CanvasElement,
  CustomizationState,
  MeasurementAxis,
  MockupCanvasScale,
  MockupDimension,
  MockupGuide,
  MockupMeasurementState,
} from './mockup-types';
import { removeMockupElementRelationships } from './mockup-element-relations';

const MAX_CALIBRATIONS = 40;
const MAX_GUIDES = 200;
const MAX_DIMENSIONS = 200;
const MAX_ABSOLUTE_SCENE_UNIT = 10_000_000;
const MAX_ABSOLUTE_CM = 100_000;
const MAX_SCENE_UNITS_PER_CM = 1_000_000;

interface LegacyAxisCalibration {
  id: string;
  productElementId: string;
  axis: MeasurementAxis;
  originLocal: number;
  localUnitsPerCm: number;
}

interface LegacyGuide {
  id: string;
  productElementId: string;
  axis: MeasurementAxis;
  positionCm: number;
  label: string;
}

interface LegacyMeasurementState {
  version: 1;
  visible: boolean;
  calibrations: LegacyAxisCalibration[];
  guides: LegacyGuide[];
  dimensions: MockupDimension[];
}

export class MockupMeasurementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockupMeasurementValidationError';
  }
}

function finiteNumber(
  value: unknown,
  field: string,
  options?: {
    positive?: boolean;
    maxAbsolute?: number;
  }
) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (options?.positive && value <= 0) ||
    (options?.maxAbsolute !== undefined &&
      Math.abs(value) > options.maxAbsolute)
  ) {
    throw new MockupMeasurementValidationError(
      `${field} 必须是有效数字，收到 ${String(value)}`
    );
  }
  return value;
}

function nullableFiniteNumber(value: unknown, field: string) {
  return value === null
    ? null
    : finiteNumber(value, field, {
        maxAbsolute: MAX_ABSOLUTE_SCENE_UNIT,
      });
}

function stableId(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) {
    throw new MockupMeasurementValidationError(
      `${field} 必须是 1-80 个字符的非空字符串，收到 ${String(value)}`
    );
  }
  return value;
}

function measurementAxis(value: unknown, field: string): MeasurementAxis {
  if (value !== 'x' && value !== 'y') {
    throw new MockupMeasurementValidationError(
      `${field} 只支持 x 或 y，收到 ${String(value)}`
    );
  }
  return value;
}

function measurementRecord(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MockupMeasurementValidationError(`${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, field: string, limit: number) {
  if (!Array.isArray(value) || value.length > limit) {
    throw new MockupMeasurementValidationError(
      `${field} 必须是最多 ${limit} 项的数组`
    );
  }
  return value;
}

function assertUniqueIds(items: Array<{ id: string }>, field: string) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      throw new MockupMeasurementValidationError(
        `${field}[${index}].id 重复：${item.id}`
      );
    }
    seen.add(item.id);
  });
}

function assertCompatibleGuides(left: MockupGuide, right: MockupGuide) {
  if (left.axis !== right.axis) {
    throw new MockupMeasurementValidationError('只能测量同方向基准线');
  }
}

export function createMeasurementState(
  visible = true
): MockupMeasurementState {
  return {
    version: 2,
    visible,
    scale: null,
    axisOrigins: { x: null, y: null },
    guides: [],
    dimensions: [],
  };
}

export function createCanvasScale(input: {
  axis: MeasurementAxis;
  firstSceneCoordinate: number;
  secondSceneCoordinate: number;
  distanceCm: number;
}): MockupCanvasScale {
  const firstSceneCoordinate = finiteNumber(
    input.firstSceneCoordinate,
    'scale.firstSceneCoordinate',
    { maxAbsolute: MAX_ABSOLUTE_SCENE_UNIT }
  );
  const secondSceneCoordinate = finiteNumber(
    input.secondSceneCoordinate,
    'scale.secondSceneCoordinate',
    { maxAbsolute: MAX_ABSOLUTE_SCENE_UNIT }
  );
  const distanceCm = finiteNumber(input.distanceCm, 'scale.distanceCm', {
    positive: true,
    maxAbsolute: MAX_ABSOLUTE_CM,
  });
  const sceneDistance = Math.abs(
    secondSceneCoordinate - firstSceneCoordinate
  );
  if (sceneDistance < 1) {
    throw new MockupMeasurementValidationError(
      `比例尺两点距离过小：${sceneDistance}`
    );
  }
  const unitsPerCm = sceneDistance / distanceCm;
  if (unitsPerCm > MAX_SCENE_UNITS_PER_CM) {
    throw new MockupMeasurementValidationError(
      `比例尺每厘米画布单位过大：${unitsPerCm}`
    );
  }

  return {
    axis: measurementAxis(input.axis, 'scale.axis'),
    firstSceneCoordinate,
    secondSceneCoordinate,
    distanceCm,
  };
}

export function canvasScaleUnitsPerCm(scale: MockupCanvasScale) {
  return (
    Math.abs(scale.secondSceneCoordinate - scale.firstSceneCoordinate) /
    scale.distanceCm
  );
}

export function createGuide(input: {
  id: string;
  axis: MeasurementAxis;
  scenePosition: number;
  label: string;
}): MockupGuide {
  return {
    id: stableId(input.id, 'guide.id'),
    axis: measurementAxis(input.axis, 'guide.axis'),
    scenePosition: finiteNumber(
      input.scenePosition,
      'guide.scenePosition',
      { maxAbsolute: MAX_ABSOLUTE_SCENE_UNIT }
    ),
    label: stableId(input.label, 'guide.label'),
  };
}

export function createOffsetGuide(input: {
  id: string;
  label: string;
  baseGuide: MockupGuide;
  scale: MockupCanvasScale;
  direction: 'negative' | 'positive';
  offsetCm: number;
}) {
  const offsetCm = finiteNumber(input.offsetCm, 'guide.offsetCm', {
    positive: true,
    maxAbsolute: MAX_ABSOLUTE_CM,
  });
  const direction = input.direction === 'negative' ? -1 : 1;
  return createGuide({
    id: input.id,
    label: input.label,
    axis: input.baseGuide.axis,
    scenePosition:
      input.baseGuide.scenePosition +
      direction * offsetCm * canvasScaleUnitsPerCm(input.scale),
  });
}

export function guidePositionCm(
  measurements: MockupMeasurementState,
  guide: MockupGuide
) {
  if (!measurements.scale) {
    throw new MockupMeasurementValidationError('请先设置比例尺');
  }
  const origin = measurements.axisOrigins[guide.axis];
  if (origin === null) {
    throw new MockupMeasurementValidationError(
      `${guide.axis === 'x' ? '竖向' : '横向'}基准线缺少坐标原点`
    );
  }
  return (
    (guide.scenePosition - origin) /
    canvasScaleUnitsPerCm(measurements.scale)
  );
}

export function scenePositionFromCm(
  measurements: MockupMeasurementState,
  axis: MeasurementAxis,
  positionCm: number
) {
  if (!measurements.scale) {
    throw new MockupMeasurementValidationError('请先设置比例尺');
  }
  const origin = measurements.axisOrigins[axis];
  if (origin === null) {
    throw new MockupMeasurementValidationError(
      `${axis === 'x' ? '竖向' : '横向'}基准线缺少坐标原点`
    );
  }
  const validPositionCm = finiteNumber(positionCm, 'guide.positionCm', {
    maxAbsolute: MAX_ABSOLUTE_CM,
  });
  return origin + validPositionCm * canvasScaleUnitsPerCm(measurements.scale);
}

export function measurementDistanceCm(
  measurements: MockupMeasurementState,
  left: MockupGuide,
  right: MockupGuide
) {
  assertCompatibleGuides(left, right);
  if (!measurements.scale) {
    throw new MockupMeasurementValidationError('请先设置比例尺');
  }
  return (
    Math.abs(left.scenePosition - right.scenePosition) /
    canvasScaleUnitsPerCm(measurements.scale)
  );
}

export function nextGuideLabel(
  guides: MockupGuide[],
  axis: MeasurementAxis
) {
  const prefix = axis === 'x' ? 'V' : 'H';
  const highest = guides
    .filter(guide => guide.axis === axis)
    .reduce((current, guide) => {
      const match = new RegExp(`^${prefix}(\\d+)$`).exec(guide.label);
      return match ? Math.max(current, Number(match[1])) : current;
    }, 0);
  return `${prefix}${highest + 1}`;
}

export function removeGuideFromMeasurements(
  measurements: MockupMeasurementState,
  guideId: string
): MockupMeasurementState {
  return {
    ...measurements,
    guides: measurements.guides.filter(guide => guide.id !== guideId),
    dimensions: measurements.dimensions.filter(
      dimension =>
        dimension.guideAId !== guideId && dimension.guideBId !== guideId
    ),
  };
}

export function removeElementFromCustomizationState(
  state: CustomizationState,
  elementId: string
): CustomizationState {
  return removeMockupElementRelationships(state, elementId);
}

function parseDimensions(
  value: unknown,
  guideById: Map<string, { id: string; axis: MeasurementAxis }>
) {
  const dimensions = boundedArray(
    value,
    'measurements.dimensions',
    MAX_DIMENSIONS
  ).map((item, index) => {
    const record = measurementRecord(
      item,
      `measurements.dimensions[${index}]`
    );
    const dimension: MockupDimension = {
      id: stableId(record.id, `measurements.dimensions[${index}].id`),
      guideAId: stableId(
        record.guideAId,
        `measurements.dimensions[${index}].guideAId`
      ),
      guideBId: stableId(
        record.guideBId,
        `measurements.dimensions[${index}].guideBId`
      ),
    };
    const guideA = guideById.get(dimension.guideAId);
    const guideB = guideById.get(dimension.guideBId);
    if (!guideA || !guideB) {
      throw new MockupMeasurementValidationError(
        `measurements.dimensions[${index}] 引用了不存在的基准线：${dimension.guideAId}/${dimension.guideBId}`
      );
    }
    if (guideA.id === guideB.id || guideA.axis !== guideB.axis) {
      throw new MockupMeasurementValidationError(
        `measurements.dimensions[${index}] 只能引用两条不同的同方向基准线`
      );
    }
    return dimension;
  });
  assertUniqueIds(dimensions, 'measurements.dimensions');
  return dimensions;
}

function parseLegacyMeasurements(
  measurements: Record<string, unknown>,
  elements: CanvasElement[]
): LegacyMeasurementState {
  const productIds = new Set(
    elements
      .filter(element => element.type === 'product')
      .map(element => element.id)
  );
  const calibrations = boundedArray(
    measurements.calibrations,
    'measurements.calibrations',
    MAX_CALIBRATIONS
  ).map((value, index) => {
    const record = measurementRecord(
      value,
      `measurements.calibrations[${index}]`
    );
    const calibration: LegacyAxisCalibration = {
      id: stableId(record.id, `measurements.calibrations[${index}].id`),
      productElementId: stableId(
        record.productElementId,
        `measurements.calibrations[${index}].productElementId`
      ),
      axis: measurementAxis(
        record.axis,
        `measurements.calibrations[${index}].axis`
      ),
      originLocal: finiteNumber(
        record.originLocal,
        `measurements.calibrations[${index}].originLocal`,
        { maxAbsolute: MAX_ABSOLUTE_SCENE_UNIT }
      ),
      localUnitsPerCm: finiteNumber(
        record.localUnitsPerCm,
        `measurements.calibrations[${index}].localUnitsPerCm`,
        { positive: true, maxAbsolute: MAX_SCENE_UNITS_PER_CM }
      ),
    };
    if (!productIds.has(calibration.productElementId)) {
      throw new MockupMeasurementValidationError(
        `measurements.calibrations[${index}].productElementId 不存在：${calibration.productElementId}`
      );
    }
    return calibration;
  });
  assertUniqueIds(calibrations, 'measurements.calibrations');

  const calibrationByKey = new Map<string, LegacyAxisCalibration>();
  calibrations.forEach((calibration, index) => {
    const key = `${calibration.productElementId}:${calibration.axis}`;
    if (calibrationByKey.has(key)) {
      throw new MockupMeasurementValidationError(
        `measurements.calibrations[${index}] 重复标定坐标轴：${key}`
      );
    }
    calibrationByKey.set(key, calibration);
  });

  const guides = boundedArray(
    measurements.guides,
    'measurements.guides',
    MAX_GUIDES
  ).map((value, index) => {
    const record = measurementRecord(value, `measurements.guides[${index}]`);
    const guide: LegacyGuide = {
      id: stableId(record.id, `measurements.guides[${index}].id`),
      productElementId: stableId(
        record.productElementId,
        `measurements.guides[${index}].productElementId`
      ),
      axis: measurementAxis(
        record.axis,
        `measurements.guides[${index}].axis`
      ),
      positionCm: finiteNumber(
        record.positionCm,
        `measurements.guides[${index}].positionCm`,
        { maxAbsolute: MAX_ABSOLUTE_CM }
      ),
      label: stableId(record.label, `measurements.guides[${index}].label`),
    };
    const calibrationKey = `${guide.productElementId}:${guide.axis}`;
    if (!calibrationByKey.has(calibrationKey)) {
      throw new MockupMeasurementValidationError(
        `measurements.guides[${index}] 缺少对应标定：${calibrationKey}`
      );
    }
    return guide;
  });
  assertUniqueIds(guides, 'measurements.guides');
  const guideById = new Map(guides.map(guide => [guide.id, guide]));
  const dimensions = parseDimensions(measurements.dimensions, guideById);

  return {
    version: 1,
    visible: measurements.visible as boolean,
    calibrations,
    guides,
    dimensions,
  };
}

function parseCurrentMeasurements(
  measurements: Record<string, unknown>
): MockupMeasurementState {
  const scale =
    measurements.scale === null
      ? null
      : createCanvasScale({
          axis: measurementAxis(
            measurementRecord(measurements.scale, 'measurements.scale').axis,
            'measurements.scale.axis'
          ),
          firstSceneCoordinate: measurementRecord(
            measurements.scale,
            'measurements.scale'
          ).firstSceneCoordinate as number,
          secondSceneCoordinate: measurementRecord(
            measurements.scale,
            'measurements.scale'
          ).secondSceneCoordinate as number,
          distanceCm: measurementRecord(
            measurements.scale,
            'measurements.scale'
          ).distanceCm as number,
        });
  const origins = measurementRecord(
    measurements.axisOrigins,
    'measurements.axisOrigins'
  );
  const axisOrigins = {
    x: nullableFiniteNumber(origins.x, 'measurements.axisOrigins.x'),
    y: nullableFiniteNumber(origins.y, 'measurements.axisOrigins.y'),
  };
  const guides = boundedArray(
    measurements.guides,
    'measurements.guides',
    MAX_GUIDES
  ).map((value, index) => {
    const record = measurementRecord(value, `measurements.guides[${index}]`);
    return createGuide({
      id: stableId(record.id, `measurements.guides[${index}].id`),
      axis: measurementAxis(record.axis, `measurements.guides[${index}].axis`),
      scenePosition: finiteNumber(
        record.scenePosition,
        `measurements.guides[${index}].scenePosition`,
        { maxAbsolute: MAX_ABSOLUTE_SCENE_UNIT }
      ),
      label: stableId(record.label, `measurements.guides[${index}].label`),
    });
  });
  assertUniqueIds(guides, 'measurements.guides');
  guides.forEach((guide, index) => {
    if (axisOrigins[guide.axis] === null) {
      throw new MockupMeasurementValidationError(
        `measurements.guides[${index}] 缺少 ${guide.axis} 轴坐标原点`
      );
    }
  });
  const guideById = new Map(guides.map(guide => [guide.id, guide]));
  const dimensions = parseDimensions(measurements.dimensions, guideById);

  return {
    version: 2,
    visible: measurements.visible as boolean,
    scale,
    axisOrigins,
    guides,
    dimensions,
  };
}

export function assertValidMockupMeasurements(
  value: unknown,
  elements: CanvasElement[]
) {
  if (value === undefined) return;
  const measurements = measurementRecord(value, 'measurements');
  if (typeof measurements.visible !== 'boolean') {
    throw new MockupMeasurementValidationError(
      `measurements.visible 必须是布尔值，收到 ${String(measurements.visible)}`
    );
  }
  if (measurements.version === 1) {
    parseLegacyMeasurements(measurements, elements);
    return;
  }
  if (measurements.version === 2) {
    parseCurrentMeasurements(measurements);
    return;
  }
  throw new MockupMeasurementValidationError(
    `measurements.version 只支持 1 或 2，收到 ${String(measurements.version)}`
  );
}

function legacyGuideScenePosition(
  guide: LegacyGuide,
  calibration: LegacyAxisCalibration,
  element: CanvasElement | undefined
) {
  const transform = element?.transform;
  if (!transform) return null;
  const values = [
    transform.left,
    transform.top,
    transform.scaleX,
    transform.scaleY,
    transform.angle,
  ];
  if (!values.every(Number.isFinite)) return null;

  const localCoordinate =
    calibration.originLocal + guide.positionCm * calibration.localUnitsPerCm;
  const cosine = Math.cos((transform.angle * Math.PI) / 180);
  return guide.axis === 'x'
    ? transform.left + cosine * transform.scaleX * localCoordinate
    : transform.top + cosine * transform.scaleY * localCoordinate;
}

function canMigrateCanvasScale(
  firstSceneCoordinate: number,
  secondSceneCoordinate: number,
  distanceCm: number
) {
  const sceneDistance = Math.abs(
    secondSceneCoordinate - firstSceneCoordinate
  );
  return (
    Number.isFinite(firstSceneCoordinate) &&
    Number.isFinite(secondSceneCoordinate) &&
    Number.isFinite(distanceCm) &&
    Math.abs(firstSceneCoordinate) <= MAX_ABSOLUTE_SCENE_UNIT &&
    Math.abs(secondSceneCoordinate) <= MAX_ABSOLUTE_SCENE_UNIT &&
    distanceCm > 0 &&
    distanceCm <= MAX_ABSOLUTE_CM &&
    sceneDistance >= 1 &&
    sceneDistance / distanceCm <= MAX_SCENE_UNITS_PER_CM
  );
}

function migrateLegacyMeasurements(
  legacy: LegacyMeasurementState,
  elements: CanvasElement[]
): MockupMeasurementState {
  const elementById = new Map(elements.map(element => [element.id, element]));
  const calibrationByKey = new Map(
    legacy.calibrations.map(calibration => [
      `${calibration.productElementId}:${calibration.axis}`,
      calibration,
    ])
  );
  const guideScenePositionById = new Map<string, number | null>();
  legacy.guides.forEach(guide => {
    const calibration = calibrationByKey.get(
      `${guide.productElementId}:${guide.axis}`
    );
    guideScenePositionById.set(
      guide.id,
      calibration
        ? legacyGuideScenePosition(
            guide,
            calibration,
            elementById.get(guide.productElementId)
          )
        : null
    );
  });

  const labelCounts: Record<MeasurementAxis, number> = { x: 0, y: 0 };
  const guides = legacy.guides.map(guide => {
    labelCounts[guide.axis] += 1;
    return createGuide({
      id: guide.id,
      axis: guide.axis,
      scenePosition:
        guideScenePositionById.get(guide.id) ?? guide.positionCm,
      label: `${guide.axis === 'x' ? 'V' : 'H'}${labelCounts[guide.axis]}`,
    });
  });
  const axisOrigins: MockupMeasurementState['axisOrigins'] = {
    x: guides.find(guide => guide.axis === 'x')?.scenePosition ?? null,
    y: guides.find(guide => guide.axis === 'y')?.scenePosition ?? null,
  };
  const legacyGuideById = new Map(
    legacy.guides.map(guide => [guide.id, guide])
  );

  let scale: MockupCanvasScale | null = null;
  for (const dimension of legacy.dimensions) {
    const legacyGuideA = legacyGuideById.get(dimension.guideAId);
    const legacyGuideB = legacyGuideById.get(dimension.guideBId);
    const firstSceneCoordinate = guideScenePositionById.get(
      dimension.guideAId
    );
    const secondSceneCoordinate = guideScenePositionById.get(
      dimension.guideBId
    );
    if (
      !legacyGuideA ||
      !legacyGuideB ||
      legacyGuideA.axis !== legacyGuideB.axis ||
      firstSceneCoordinate === null ||
      firstSceneCoordinate === undefined ||
      secondSceneCoordinate === null ||
      secondSceneCoordinate === undefined
    ) {
      continue;
    }
    const distanceCm = Math.abs(
      legacyGuideA.positionCm - legacyGuideB.positionCm
    );
    if (
      !canMigrateCanvasScale(
        firstSceneCoordinate,
        secondSceneCoordinate,
        distanceCm
      )
    ) {
      continue;
    }
    scale = createCanvasScale({
      axis: legacyGuideA.axis,
      firstSceneCoordinate,
      secondSceneCoordinate,
      distanceCm,
    });
    break;
  }

  if (!scale) {
    for (const calibration of legacy.calibrations) {
      const element = elementById.get(calibration.productElementId);
      const first = legacyGuideScenePosition(
        {
          id: 'legacy-scale-start',
          productElementId: calibration.productElementId,
          axis: calibration.axis,
          positionCm: 0,
          label: 'legacy-scale-start',
        },
        calibration,
        element
      );
      const second = legacyGuideScenePosition(
        {
          id: 'legacy-scale-end',
          productElementId: calibration.productElementId,
          axis: calibration.axis,
          positionCm: 1,
          label: 'legacy-scale-end',
        },
        calibration,
        element
      );
      if (first === null || second === null) continue;
      if (!canMigrateCanvasScale(first, second, 1)) {
        continue;
      }
      scale = createCanvasScale({
        axis: calibration.axis,
        firstSceneCoordinate: first,
        secondSceneCoordinate: second,
        distanceCm: 1,
      });
      break;
    }
  }

  return {
    version: 2,
    visible: legacy.visible,
    scale,
    axisOrigins,
    guides,
    dimensions: legacy.dimensions,
  };
}

export function normalizeMockupMeasurementState(
  value: unknown,
  elements: CanvasElement[]
): MockupMeasurementState | undefined {
  if (value === undefined) return undefined;
  const measurements = measurementRecord(value, 'measurements');
  if (typeof measurements.visible !== 'boolean') {
    throw new MockupMeasurementValidationError(
      `measurements.visible 必须是布尔值，收到 ${String(measurements.visible)}`
    );
  }
  if (measurements.version === 2) {
    return parseCurrentMeasurements(measurements);
  }
  if (measurements.version === 1) {
    return migrateLegacyMeasurements(
      parseLegacyMeasurements(measurements, elements),
      elements
    );
  }
  throw new MockupMeasurementValidationError(
    `measurements.version 只支持 1 或 2，收到 ${String(measurements.version)}`
  );
}

export function normalizeCustomizationMeasurements(
  state: CustomizationState
): CustomizationState {
  return {
    ...state,
    measurements: normalizeMockupMeasurementState(
      state.measurements,
      state.elements
    ),
  };
}
