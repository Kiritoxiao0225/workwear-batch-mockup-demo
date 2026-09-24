import type {
  MockupGarmentGeometry,
  NormalizedMockupRegion,
} from './mockup-types';

const COARSE_MAX_EDGE = 512;
const REFINEMENT_MAX_EDGE = 1024;
const REFINEMENT_PADDING_RATIO = 0.08;
const BORDER_BAND_RATIO = 0.03;
const BACKGROUND_BUCKET_SHIFT = 5;
const MIN_DOMINANT_BORDER_RATIO = 0.3;
const MIN_TRANSPARENT_BORDER_RATIO = 0.3;
const FOREGROUND_COLOR_DIFFERENCE = 18;
const MIN_COMPONENT_AREA_RATIO = 0.03;
const MAX_COMPONENT_AREA_RATIO = 0.97;
const MIN_COMPONENT_WIDTH_RATIO = 0.12;
const MIN_COMPONENT_HEIGHT_RATIO = 0.2;
const MIN_COMPONENT_DENSITY = 0.12;
const AMBIGUOUS_SECOND_COMPONENT_RATIO = 0.58;
const BODY_BAND_TOP_RATIO = 0.62;
const BODY_BAND_BOTTOM_RATIO = 0.88;
const BODY_WIDTH_MIN_RATIO = 0.7;
const BODY_WIDTH_MAX_RATIO = 1.3;
const BODY_CENTER_TOLERANCE_RATIO = 0.08;
const MAX_BODY_WIDTH_DEVIATION_RATIO = 0.18;
const MAX_BODY_CENTER_DEVIATION_RATIO = 0.05;
const MIN_BODY_TO_GARMENT_WIDTH_RATIO = 0.28;
const CHEST_HEIGHT_BODY_WIDTH_RATIO = 0.42;
const CHEST_HEIGHT_MIN_GARMENT_RATIO = 0.18;
const CHEST_HEIGHT_MAX_GARMENT_RATIO = 0.3;

type DetectMockupGarmentGeometryInput = {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
};

type Background =
  | { kind: 'transparent' }
  | { kind: 'color'; red: number; green: number; blue: number };

type ForegroundComponent = {
  label: number;
  pixelCount: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type ForegroundRun = {
  left: number;
  right: number;
  width: number;
  center: number;
};

function normalizedNumber(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function assertDetectionInput({
  pixels,
  width,
  height,
}: DetectMockupGarmentGeometryInput) {
  if (
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0
  ) {
    throw new Error(`服装几何检测尺寸必须是正整数：${width}x${height}`);
  }
  const expectedLength = width * height * 4;
  if (pixels.length !== expectedLength) {
    throw new Error(
      `服装几何检测需要 ${expectedLength} 个 RGBA 值，实际收到 ${pixels.length}`
    );
  }
}

export function mockupGarmentDetectionSize(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    width <= 0 ||
    !Number.isInteger(height) ||
    height <= 0
  ) {
    throw new Error(`服装几何检测尺寸必须是正整数：${width}x${height}`);
  }
  const scale = Math.min(1, COARSE_MAX_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function mockupGarmentRefinementRegion(
  geometry: MockupGarmentGeometry
): NormalizedMockupRegion {
  const { garmentBounds } = geometry;
  const horizontalPadding = garmentBounds.width * REFINEMENT_PADDING_RATIO;
  const verticalPadding = garmentBounds.height * REFINEMENT_PADDING_RATIO;
  const left = Math.max(0, garmentBounds.x - horizontalPadding);
  const top = Math.max(0, garmentBounds.y - verticalPadding);
  const right = Math.min(
    1,
    garmentBounds.x + garmentBounds.width + horizontalPadding
  );
  const bottom = Math.min(
    1,
    garmentBounds.y + garmentBounds.height + verticalPadding
  );
  return {
    x: normalizedNumber(left),
    y: normalizedNumber(top),
    width: normalizedNumber(right - left),
    height: normalizedNumber(bottom - top),
  };
}

export function mockupGarmentRefinementSize(
  sourceWidth: number,
  sourceHeight: number,
  region: NormalizedMockupRegion
) {
  if (
    !Number.isInteger(sourceWidth) ||
    sourceWidth <= 0 ||
    !Number.isInteger(sourceHeight) ||
    sourceHeight <= 0
  ) {
    throw new Error(
      `服装几何精检尺寸必须是正整数：${sourceWidth}x${sourceHeight}`
    );
  }
  const regionWidth = Math.max(1, Math.round(sourceWidth * region.width));
  const regionHeight = Math.max(1, Math.round(sourceHeight * region.height));
  const scale = Math.min(
    1,
    REFINEMENT_MAX_EDGE / Math.max(regionWidth, regionHeight)
  );
  return {
    width: Math.max(1, Math.round(regionWidth * scale)),
    height: Math.max(1, Math.round(regionHeight * scale)),
  };
}

function backgroundBucketKey(red: number, green: number, blue: number) {
  return `${red >> BACKGROUND_BUCKET_SHIFT}:${green >> BACKGROUND_BUCKET_SHIFT}:${blue >> BACKGROUND_BUCKET_SHIFT}`;
}

function borderBackground(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): Background | null {
  const band = Math.max(
    1,
    Math.round(Math.min(width, height) * BORDER_BAND_RATIO)
  );
  const buckets = new Map<
    string,
    { count: number; redSum: number; greenSum: number; blueSum: number }
  >();
  let borderCount = 0;
  let transparentCount = 0;
  let opaqueCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x >= band && x < width - band && y >= band && y < height - band) {
        continue;
      }
      borderCount += 1;
      const offset = (y * width + x) * 4;
      if (pixels[offset + 3] < 64) {
        transparentCount += 1;
        continue;
      }
      opaqueCount += 1;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const key = backgroundBucketKey(red, green, blue);
      const bucket = buckets.get(key) ?? {
        count: 0,
        redSum: 0,
        greenSum: 0,
        blueSum: 0,
      };
      bucket.count += 1;
      bucket.redSum += red;
      bucket.greenSum += green;
      bucket.blueSum += blue;
      buckets.set(key, bucket);
    }
  }

  if (
    borderCount > 0 &&
    transparentCount / borderCount >= MIN_TRANSPARENT_BORDER_RATIO
  ) {
    return { kind: 'transparent' };
  }

  let dominant:
    | { count: number; redSum: number; greenSum: number; blueSum: number }
    | undefined;
  for (const bucket of buckets.values()) {
    if (!dominant || bucket.count > dominant.count) dominant = bucket;
  }
  if (
    !dominant ||
    opaqueCount === 0 ||
    dominant.count / opaqueCount < MIN_DOMINANT_BORDER_RATIO
  ) {
    return null;
  }
  return {
    kind: 'color',
    red: dominant.redSum / dominant.count,
    green: dominant.greenSum / dominant.count,
    blue: dominant.blueSum / dominant.count,
  };
}

function foregroundMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  background: Background
) {
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const alpha = pixels[offset + 3];
    if (background.kind === 'transparent') {
      if (alpha >= 64) mask[index] = 1;
      continue;
    }
    if (alpha < 64) continue;
    const difference = Math.max(
      Math.abs(pixels[offset] - background.red),
      Math.abs(pixels[offset + 1] - background.green),
      Math.abs(pixels[offset + 2] - background.blue)
    );
    if (difference >= FOREGROUND_COLOR_DIFFERENCE) mask[index] = 1;
  }
  return mask;
}

function foregroundComponents(mask: Uint8Array, width: number, height: number) {
  const labels = new Int32Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: ForegroundComponent[] = [];
  let label = 0;

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || labels[start] !== 0) continue;
    label += 1;
    labels[start] = label;
    queue[0] = start;
    let queueLength = 1;
    let queueIndex = 0;
    let pixelCount = 0;
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;

    while (queueIndex < queueLength) {
      const pixelIndex = queue[queueIndex];
      queueIndex += 1;
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      pixelCount += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);

      if (x > 0) {
        const neighbor = pixelIndex - 1;
        if (mask[neighbor] === 1 && labels[neighbor] === 0) {
          labels[neighbor] = label;
          queue[queueLength] = neighbor;
          queueLength += 1;
        }
      }
      if (x + 1 < width) {
        const neighbor = pixelIndex + 1;
        if (mask[neighbor] === 1 && labels[neighbor] === 0) {
          labels[neighbor] = label;
          queue[queueLength] = neighbor;
          queueLength += 1;
        }
      }
      if (y > 0) {
        const neighbor = pixelIndex - width;
        if (mask[neighbor] === 1 && labels[neighbor] === 0) {
          labels[neighbor] = label;
          queue[queueLength] = neighbor;
          queueLength += 1;
        }
      }
      if (y + 1 < height) {
        const neighbor = pixelIndex + width;
        if (mask[neighbor] === 1 && labels[neighbor] === 0) {
          labels[neighbor] = label;
          queue[queueLength] = neighbor;
          queueLength += 1;
        }
      }
    }

    components.push({ label, pixelCount, left, top, right, bottom });
  }
  return { labels, components };
}

function isPlausibleComponent(
  component: ForegroundComponent,
  width: number,
  height: number
) {
  const componentWidth = component.right - component.left + 1;
  const componentHeight = component.bottom - component.top + 1;
  const areaRatio = component.pixelCount / (width * height);
  const widthRatio = componentWidth / width;
  const heightRatio = componentHeight / height;
  const density = component.pixelCount / (componentWidth * componentHeight);
  const aspectRatio = componentWidth / componentHeight;
  const isWideBanner = aspectRatio > 3.5 && heightRatio < 0.25;
  return (
    areaRatio >= MIN_COMPONENT_AREA_RATIO &&
    areaRatio <= MAX_COMPONENT_AREA_RATIO &&
    widthRatio >= MIN_COMPONENT_WIDTH_RATIO &&
    heightRatio >= MIN_COMPONENT_HEIGHT_RATIO &&
    density >= MIN_COMPONENT_DENSITY &&
    aspectRatio >= 0.18 &&
    !isWideBanner
  );
}

function median(values: number[]) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function normalizedBounds(
  component: ForegroundComponent,
  width: number,
  height: number
): NormalizedMockupRegion {
  return {
    x: component.left / width,
    y: component.top / height,
    width: (component.right - component.left + 1) / width,
    height: (component.bottom - component.top + 1) / height,
  };
}

function bodyRunForRow(
  component: ForegroundComponent,
  labels: Int32Array,
  width: number,
  y: number
): ForegroundRun | null {
  const runs: ForegroundRun[] = [];
  const rowOffset = y * width;
  let runLeft = -1;

  for (let x = component.left; x <= component.right; x += 1) {
    const isComponentPixel = labels[rowOffset + x] === component.label;
    if (isComponentPixel && runLeft < 0) runLeft = x;
    if (
      runLeft >= 0 &&
      (!isComponentPixel || x === component.right)
    ) {
      const runRight = isComponentPixel && x === component.right ? x : x - 1;
      runs.push({
        left: runLeft,
        right: runRight,
        width: runRight - runLeft + 1,
        center: (runLeft + runRight + 1) / 2,
      });
      runLeft = -1;
    }
  }

  if (runs.length === 0) return null;
  const componentCenter = (component.left + component.right + 1) / 2;
  const centerRuns = runs.filter(
    run => run.left <= componentCenter && run.right + 1 >= componentCenter
  );
  const candidates = centerRuns.length > 0 ? centerRuns : runs;
  return candidates.sort((left, right) => {
    const widthDifference = right.width - left.width;
    if (widthDifference !== 0) return widthDifference;
    return (
      Math.abs(left.center - componentCenter) -
      Math.abs(right.center - componentCenter)
    );
  })[0];
}

function geometryFromComponent(
  component: ForegroundComponent,
  labels: Int32Array,
  width: number,
  height: number
): MockupGarmentGeometry | null {
  const componentWidth = component.right - component.left + 1;
  const componentHeight = component.bottom - component.top + 1;
  const bandTop = Math.max(
    component.top,
    Math.round(component.top + componentHeight * BODY_BAND_TOP_RATIO)
  );
  const bandBottom = Math.min(
    component.bottom,
    Math.round(component.top + componentHeight * BODY_BAND_BOTTOM_RATIO)
  );
  const rows: Array<{ width: number; center: number }> = [];

  for (let y = bandTop; y <= bandBottom; y += 1) {
    const bodyRun = bodyRunForRow(component, labels, width, y);
    if (bodyRun) rows.push(bodyRun);
  }

  const minimumStableRows = Math.max(
    3,
    Math.round((bandBottom - bandTop + 1) * 0.35)
  );
  if (rows.length < minimumStableRows) return null;

  const initialWidth = median(rows.map(row => row.width));
  const initialCenter = median(rows.map(row => row.center));
  const stableRows = rows.filter(row =>
    row.width >= initialWidth * BODY_WIDTH_MIN_RATIO &&
    row.width <= initialWidth * BODY_WIDTH_MAX_RATIO &&
    Math.abs(row.center - initialCenter) <=
      componentWidth * BODY_CENTER_TOLERANCE_RATIO
  );
  if (stableRows.length < minimumStableRows) return null;

  const bodyWidthPixels = median(stableRows.map(row => row.width));
  const bodyCenterPixels = median(stableRows.map(row => row.center));
  if (bodyWidthPixels / componentWidth < MIN_BODY_TO_GARMENT_WIDTH_RATIO) {
    return null;
  }
  const widthDeviation = median(
    stableRows.map(row => Math.abs(row.width - bodyWidthPixels))
  ) / bodyWidthPixels;
  const centerDeviation = median(
    stableRows.map(row => Math.abs(row.center - bodyCenterPixels))
  ) / componentWidth;
  if (
    widthDeviation > MAX_BODY_WIDTH_DEVIATION_RATIO ||
    centerDeviation > MAX_BODY_CENTER_DEVIATION_RATIO
  ) {
    return null;
  }

  const garmentBounds = normalizedBounds(component, width, height);
  const chestHeightPixels = Math.min(
    componentHeight * CHEST_HEIGHT_MAX_GARMENT_RATIO,
    Math.max(
      componentHeight * CHEST_HEIGHT_MIN_GARMENT_RATIO,
      bodyWidthPixels * CHEST_HEIGHT_BODY_WIDTH_RATIO
    )
  );
  return {
    version: 2,
    garmentBounds,
    bodyCenterX: bodyCenterPixels / width,
    bodyWidth: bodyWidthPixels / width,
    chestY: (component.top + chestHeightPixels) / height,
    confidence:
      stableRows.length / rows.length >= 0.65 &&
      widthDeviation <= 0.08 &&
      centerDeviation <= 0.025
        ? 'high'
        : 'medium',
  };
}

export function detectMockupGarmentGeometry(
  input: DetectMockupGarmentGeometryInput
): MockupGarmentGeometry | null {
  assertDetectionInput(input);
  const background = borderBackground(input.pixels, input.width, input.height);
  if (!background) return null;
  const { labels, components } = foregroundComponents(
    foregroundMask(input.pixels, input.width, input.height, background),
    input.width,
    input.height
  );
  const candidates = components
    .filter(component => isPlausibleComponent(component, input.width, input.height))
    .sort((left, right) => right.pixelCount - left.pixelCount);
  const [largest, secondLargest] = candidates;
  if (!largest) return null;
  if (
    secondLargest &&
    secondLargest.pixelCount / largest.pixelCount >=
      AMBIGUOUS_SECOND_COMPONENT_RATIO
  ) {
    return null;
  }
  return geometryFromComponent(
    largest,
    labels,
    input.width,
    input.height
  );
}

export function mapMockupGarmentGeometryToRegion(
  geometry: MockupGarmentGeometry,
  region: NormalizedMockupRegion
): MockupGarmentGeometry {
  return {
    ...geometry,
    garmentBounds: {
      x: normalizedNumber(region.x + geometry.garmentBounds.x * region.width),
      y: normalizedNumber(region.y + geometry.garmentBounds.y * region.height),
      width: normalizedNumber(geometry.garmentBounds.width * region.width),
      height: normalizedNumber(geometry.garmentBounds.height * region.height),
    },
    bodyCenterX: normalizedNumber(
      region.x + geometry.bodyCenterX * region.width
    ),
    bodyWidth: normalizedNumber(geometry.bodyWidth * region.width),
    chestY: normalizedNumber(region.y + geometry.chestY * region.height),
  };
}
