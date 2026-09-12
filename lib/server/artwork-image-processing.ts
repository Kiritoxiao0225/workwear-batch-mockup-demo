import sharp from 'sharp';
import { estimateArtworkBackground } from './artwork-foreground-integrity';

export type ArtworkSourceKind =
  | 'transparent'
  | 'flat-background'
  | 'uncertain-background'
  | 'complex-background';

export type RgbColor = {
  r: number;
  g: number;
  b: number;
};

export type ArtworkSourceProfile = {
  kind: ArtworkSourceKind;
  width: number;
  height: number;
  transparentRatio: number;
  transparentBorderRatio: number;
  dominantBorderRatio: number;
  borderEdgeDensity: number;
  backgroundColor: RgbColor | null;
};

export type ArtworkAlphaMaskReport = {
  transparentRatio: number;
  transparentBorderRatio: number;
  visibleRatio: number;
  coreOpaqueRatio: number;
  softAlphaRatio: number;
  coreOpaqueAmongVisible: number;
  softAlphaAmongVisible: number;
};

export type ArtworkPixelBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const FLAT_BACKGROUND_BORDER_RATIO = 0.72;
const FLAT_BACKGROUND_EDGE_DENSITY = 0.12;
const COMPLEX_BACKGROUND_BORDER_RATIO = 0.45;
const COMPLEX_BACKGROUND_EDGE_DENSITY = 0.2;
const TRANSPARENT_BORDER_RATIO = 0.65;
const BACKGROUND_CORE_DISTANCE = 30;
const BACKGROUND_CONNECTED_DISTANCE = 72;

type DecodedRgba = {
  data: Buffer;
  width: number;
  height: number;
};

async function decodedRgba(bytes: Buffer): Promise<DecodedRgba> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) throw new Error('图片缺少可识别的宽高');
  return { data, width: info.width, height: info.height };
}

function squaredColorDistance(
  red: number,
  green: number,
  blue: number,
  target: RgbColor,
) {
  return (red - target.r) ** 2 + (green - target.g) ** 2 + (blue - target.b) ** 2;
}

function borderPixel(x: number, y: number, width: number, height: number, band: number) {
  return x < band || x >= width - band || y < band || y >= height - band;
}

function quantizedColorKey(red: number, green: number, blue: number, bits: 4 | 5) {
  return `${red >> bits},${green >> bits},${blue >> bits}`;
}

export async function inspectArtworkSource(bytes: Buffer): Promise<ArtworkSourceProfile> {
  const { data, width, height } = await decodedRgba(bytes);
  const totalPixels = width * height;
  const band = Math.max(2, Math.min(24, Math.round(Math.min(width, height) * 0.02)));
  let transparentPixels = 0;
  let transparentBorderPixels = 0;
  let borderAlphaPixels = 0;
  let opaquePixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= 8) transparentPixels += 1;
      if (alpha >= 240) opaquePixels += 1;
      if (!borderPixel(x, y, width, height, band)) continue;
      borderAlphaPixels += 1;
      if (alpha <= 8) transparentBorderPixels += 1;
    }
  }
  const transparentRatio = transparentPixels / totalPixels;
  const transparentBorderRatio = borderAlphaPixels > 0
    ? transparentBorderPixels / borderAlphaPixels
    : 0;
  const visiblePixels = totalPixels - transparentPixels;
  const opaqueAmongVisible = visiblePixels > 0 ? opaquePixels / visiblePixels : 0;
  if (transparentRatio >= 0.02
    && transparentBorderRatio >= TRANSPARENT_BORDER_RATIO
    && visiblePixels / totalPixels >= 0.005
    && opaqueAmongVisible >= 0.25) {
    return {
      kind: 'transparent',
      width,
      height,
      transparentRatio,
      transparentBorderRatio,
      dominantBorderRatio: 0,
      borderEdgeDensity: 0,
      backgroundColor: null,
    };
  }

  const bins = new Map<string, { count: number; red: number; green: number; blue: number }>();
  let borderPixels = 0;
  let comparedEdges = 0;
  let strongEdges = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!borderPixel(x, y, width, height, band)) continue;
      const offset = (y * width + x) * 4;
      if (data[offset + 3] < 240) continue;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const key = quantizedColorKey(red, green, blue, 4);
      const current = bins.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
      current.count += 1;
      current.red += red;
      current.green += green;
      current.blue += blue;
      bins.set(key, current);
      borderPixels += 1;

      if (x + 1 < width && borderPixel(x + 1, y, width, height, band)) {
        const next = offset + 4;
        if (data[next + 3] >= 240) {
          comparedEdges += 1;
          if ((red - data[next]) ** 2 + (green - data[next + 1]) ** 2 + (blue - data[next + 2]) ** 2 > 40 ** 2) {
            strongEdges += 1;
          }
        }
      }
      if (y + 1 < height && borderPixel(x, y + 1, width, height, band)) {
        const next = offset + width * 4;
        if (data[next + 3] >= 240) {
          comparedEdges += 1;
          if ((red - data[next]) ** 2 + (green - data[next + 1]) ** 2 + (blue - data[next + 2]) ** 2 > 40 ** 2) {
            strongEdges += 1;
          }
        }
      }
    }
  }

  const dominant = [...bins.values()].sort((left, right) => right.count - left.count)[0] ?? null;
  const dominantBorderRatio = dominant && borderPixels > 0 ? dominant.count / borderPixels : 0;
  const borderEdgeDensity = comparedEdges > 0 ? strongEdges / comparedEdges : 1;
  const backgroundColor = dominant
    ? {
        r: Math.round(dominant.red / dominant.count),
        g: Math.round(dominant.green / dominant.count),
        b: Math.round(dominant.blue / dominant.count),
      }
    : null;
  const smoothSimpleBackground = dominantBorderRatio >= 0.35 && borderEdgeDensity <= 0.02;
  const kind: ArtworkSourceKind = (dominantBorderRatio >= FLAT_BACKGROUND_BORDER_RATIO
    && borderEdgeDensity <= FLAT_BACKGROUND_EDGE_DENSITY)
    || smoothSimpleBackground
    ? 'flat-background'
    : dominantBorderRatio <= COMPLEX_BACKGROUND_BORDER_RATIO
      || borderEdgeDensity >= COMPLEX_BACKGROUND_EDGE_DENSITY
      ? 'complex-background'
      : 'uncertain-background';

  return {
    kind,
    width,
    height,
    transparentRatio,
    transparentBorderRatio,
    dominantBorderRatio,
    borderEdgeDensity,
    backgroundColor,
  };
}

export function mediaKitStandardInputSize(width: number, height: number) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error(`MediaKit 输入尺寸无效：${width}×${height}`);
  }
  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);
  const scale = Math.min(1, 1440 / shortEdge, 2160 / longEdge);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function connectedBackgroundPixels(
  data: Buffer,
  width: number,
  height: number,
  backgroundColor: RgbColor,
  backgroundAtPixel?: (index: number) => RgbColor,
) {
  const totalPixels = width * height;
  const connected = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  const maximumDistance = BACKGROUND_CONNECTED_DISTANCE ** 2;
  let queued = 0;
  let cursor = 0;
  const enqueue = (index: number) => {
    if (connected[index]) return;
    const offset = index * 4;
    if (data[offset + 3] === 0
      || squaredColorDistance(data[offset], data[offset + 1], data[offset + 2], backgroundAtPixel?.(index) ?? backgroundColor) <= maximumDistance) {
      connected[index] = 1;
      queue[queued] = index;
      queued += 1;
    }
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (cursor < queued) {
    const index = queue[cursor];
    cursor += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }
  return connected;
}

export async function removeFlatArtworkBackground(bytes: Buffer, backgroundColor: RgbColor) {
  const { data, width, height } = await decodedRgba(bytes);
  const output = Buffer.from(data);
  // Reuse the supported perimeter model, rejecting foreground outliers. Fit once;
  // a flat field keeps the existing constant-colour fast path. A gradient changes
  // both connectivity and alpha estimation, so a darker edge is not left opaque.
  const field = estimateArtworkBackground(data, width, height);
  const gradient = field && Math.hypot(...field.coefficients.map(([x, y]) => Math.abs(x) + Math.abs(y))) > BACKGROUND_CORE_DISTANCE ? field : null;
  const backgroundAtPixel = gradient ? (index: number): RgbColor => {
    const x = (index % width) / Math.max(1, width - 1), y = Math.floor(index / width) / Math.max(1, height - 1);
    const channel = (c: number) => Math.max(0, Math.min(255, gradient.coefficients[c][0] * x + gradient.coefficients[c][1] * y + gradient.coefficients[c][2]));
    return { r: channel(0), g: channel(1), b: channel(2) };
  } : undefined;
  const connected = connectedBackgroundPixels(data, width, height, backgroundColor, backgroundAtPixel);
  for (let index = 0; index < connected.length; index += 1) {
    if (!connected[index]) continue;
    const offset = index * 4;
    if (output[offset + 3] === 0) continue;
    const distance = Math.sqrt(squaredColorDistance(
      output[offset],
      output[offset + 1],
      output[offset + 2],
      backgroundAtPixel?.(index) ?? backgroundColor,
    ));
    const retainedAlpha = distance <= BACKGROUND_CORE_DISTANCE
      ? 0
      : Math.min(1, (distance - BACKGROUND_CORE_DISTANCE)
        / (BACKGROUND_CONNECTED_DISTANCE - BACKGROUND_CORE_DISTANCE));
    output[offset + 3] = Math.round(output[offset + 3] * retainedAlpha);
  }
  return sharp(output, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function alphaMaskReport(bytes: Buffer): Promise<ArtworkAlphaMaskReport> {
  const { data, width, height } = await decodedRgba(bytes);
  const band = Math.max(2, Math.min(24, Math.round(Math.min(width, height) * 0.02)));
  let transparentPixels = 0;
  let transparentBorderPixels = 0;
  let borderPixels = 0;
  let coreOpaquePixels = 0;
  let softAlphaPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= 8) transparentPixels += 1;
      else if (alpha >= 240) coreOpaquePixels += 1;
      else softAlphaPixels += 1;
      if (!borderPixel(x, y, width, height, band)) continue;
      borderPixels += 1;
      if (alpha <= 8) transparentBorderPixels += 1;
    }
  }
  const totalPixels = width * height;
  const visiblePixels = totalPixels - transparentPixels;
  return {
    transparentRatio: transparentPixels / totalPixels,
    transparentBorderRatio: borderPixels > 0 ? transparentBorderPixels / borderPixels : 0,
    visibleRatio: visiblePixels / totalPixels,
    coreOpaqueRatio: coreOpaquePixels / totalPixels,
    softAlphaRatio: softAlphaPixels / totalPixels,
    coreOpaqueAmongVisible: visiblePixels > 0 ? coreOpaquePixels / visiblePixels : 0,
    softAlphaAmongVisible: visiblePixels > 0 ? softAlphaPixels / visiblePixels : 0,
  };
}

export async function visibleArtworkBounds(bytes: Buffer): Promise<ArtworkPixelBounds> {
  const { data, width, height } = await decodedRgba(bytes);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= 8) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error('图案素材没有可见主体像素');
  return {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

function clampedByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export async function applyArtworkAlphaMask(
  imageBytes: Buffer,
  maskSourceBytes: Buffer,
  backgroundColor?: RgbColor,
  _strengthenSoftStrokes = false,
) {
  const imageMetadata = await sharp(imageBytes).metadata();
  const maskMetadata = await sharp(maskSourceBytes).metadata();
  if (!imageMetadata.width || !imageMetadata.height) throw new Error('增强图缺少可识别尺寸');
  if (!maskMetadata.width || !maskMetadata.height) throw new Error('Logo Alpha 蒙版缺少可识别尺寸');
  const imageAspectRatio = imageMetadata.width / imageMetadata.height;
  const maskAspectRatio = maskMetadata.width / maskMetadata.height;
  const aspectRatioDrift = Math.abs(imageAspectRatio / maskAspectRatio - 1);
  if (aspectRatioDrift > 0.01) {
    throw new Error(`保真增强后 Logo 长宽比变化 ${(aspectRatioDrift * 100).toFixed(2)}%，超过 1% 结构门禁`);
  }
  const { data: imageRgb } = await sharp(imageBytes)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data: resizedAlpha } = await sharp(maskSourceBytes)
    .ensureAlpha()
    .resize({ width: imageMetadata.width, height: imageMetadata.height, fit: 'fill' })
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  // A registered mark, thin line or weak antialiased stroke is not disposable
  // noise. Keep all supplied alpha samples; no island pruning, gap filling or
  // automatic thickening. The legacy argument remains accepted for callers.
  void _strengthenSoftStrokes;
  const outputAlpha = resizedAlpha;
  const output = Buffer.alloc(imageMetadata.width * imageMetadata.height * 4);
  for (let pixel = 0; pixel < outputAlpha.length; pixel += 1) {
    const alpha = outputAlpha[pixel];
    const sourceOffset = pixel * 3;
    const outputOffset = pixel * 4;
    if (alpha === 0) continue;
    if (backgroundColor && alpha < 250) {
      const opacity = alpha / 255;
      output[outputOffset] = clampedByte((imageRgb[sourceOffset] - backgroundColor.r * (1 - opacity)) / opacity);
      output[outputOffset + 1] = clampedByte((imageRgb[sourceOffset + 1] - backgroundColor.g * (1 - opacity)) / opacity);
      output[outputOffset + 2] = clampedByte((imageRgb[sourceOffset + 2] - backgroundColor.b * (1 - opacity)) / opacity);
    } else {
      output[outputOffset] = imageRgb[sourceOffset];
      output[outputOffset + 1] = imageRgb[sourceOffset + 1];
      output[outputOffset + 2] = imageRgb[sourceOffset + 2];
    }
    output[outputOffset + 3] = alpha;
  }
  return sharp(output, {
    raw: { width: imageMetadata.width, height: imageMetadata.height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export function assertUsableArtworkMask(report: ArtworkAlphaMaskReport) {
  if (report.visibleRatio < 0.005) {
    throw new Error('抠图结果主体面积不足 0.5%，已停止自动使用');
  }
  if (report.transparentRatio < 0.05) {
    throw new Error('抠图结果透明背景不足 5%，疑似没有正确移除背景');
  }
  if (report.transparentBorderRatio < 0.2) {
    throw new Error(`抠图结果画布边缘透明度不足：仅 ${(report.transparentBorderRatio * 100).toFixed(1)}%`);
  }
  if (report.coreOpaqueAmongVisible < 0.25) {
    throw new Error(`抠图后图案主体过于透明，贴到衣服上可能发虚或缺失（接近不透明的部分仅占可见区域 ${(report.coreOpaqueAmongVisible * 100).toFixed(1)}%，要求至少 25%）`);
  }
  if (report.softAlphaAmongVisible > 0.75) {
    throw new Error(`抠图结果半透明区域过多：占可见区域 ${(report.softAlphaAmongVisible * 100).toFixed(1)}%`);
  }
}

function connectedCandidateComponents(candidate: Uint8Array, width: number, height: number) {
  const labels = new Int32Array(candidate.length);
  const queue = new Int32Array(candidate.length);
  let label = 0;
  let largestLabel = 0;
  let largestCount = 0;
  const counts = [0];
  for (let start = 0; start < candidate.length; start += 1) {
    if (!candidate[start] || labels[start]) continue;
    label += 1;
    let cursor = 0;
    let queued = 1;
    let count = 0;
    queue[0] = start;
    labels[start] = label;
    while (cursor < queued) {
      const index = queue[cursor];
      cursor += 1;
      count += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
          if (xOffset === 0 && yOffset === 0) continue;
          const nextX = x + xOffset;
          const nextY = y + yOffset;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (!candidate[next] || labels[next]) continue;
          labels[next] = label;
          queue[queued] = next;
          queued += 1;
        }
      }
    }
    if (count > largestCount) {
      largestCount = count;
      largestLabel = label;
    }
    counts[label] = count;
  }
  return { labels, counts, largestLabel, largestCount };
}

/** Detect independent marks lost by a same-canvas cutout without changing either image. */
export async function missingArtworkForegroundRegions(
  sourceBytes: Buffer,
  cutoutBytes: Buffer,
  backgroundColor: RgbColor,
  options: { minimumAlpha?: number } = {},
): Promise<ArtworkPixelBounds[]> {
  const [source, cutout] = await Promise.all([
    decodedRgba(sourceBytes),
    decodedRgba(cutoutBytes),
  ]);
  if (source.width !== cutout.width || source.height !== cutout.height) {
    throw new Error(`抠图前后画布尺寸不一致，无法核对独立图形：${source.width}×${source.height} → ${cutout.width}×${cutout.height}`);
  }

  const candidate = new Uint8Array(source.width * source.height);
  for (let pixel = 0; pixel < candidate.length; pixel += 1) {
    const offset = pixel * 4;
    candidate[pixel] = source.data[offset + 3] > 200
      && squaredColorDistance(
        source.data[offset],
        source.data[offset + 1],
        source.data[offset + 2],
        backgroundColor,
      ) > 96 ** 2 ? 1 : 0;
  }
  const components = connectedCandidateComponents(candidate, source.width, source.height);
  const bounds = components.counts.map(() => ({
    left: source.width,
    top: source.height,
    right: 0,
    bottom: 0,
    retained: 0,
  }));
  for (let pixel = 0; pixel < candidate.length; pixel += 1) {
    const label = components.labels[pixel];
    if (!label) continue;
    const x = pixel % source.width;
    const y = Math.floor(pixel / source.width);
    const region = bounds[label];
    region.left = Math.min(region.left, x);
    region.top = Math.min(region.top, y);
    region.right = Math.max(region.right, x + 1);
    region.bottom = Math.max(region.bottom, y + 1);
    if (cutout.data[pixel * 4 + 3] >= (options.minimumAlpha ?? 160)) region.retained += 1;
  }

  // Six strong pixels keep small punctuation while excluding isolated JPEG specks.
  // Group overlapping bounds before filtering: a missing R must include its intact ring.
  const regions = bounds.flatMap((bound, label) => label > 0 && components.counts[label] >= 6
    ? [{ ...bound, missing: bound.retained / components.counts[label] < 0.8 }]
    : []);
  let merged = true;
  while (merged) {
    merged = false;
    mergeRegions: for (let index = 0; index < regions.length; index += 1) {
      const region = regions[index];
      for (let next = index + 1; next < regions.length; next += 1) {
        const other = regions[next];
        if (region.left >= other.right || other.left >= region.right
          || region.top >= other.bottom || other.top >= region.bottom) continue;
        region.left = Math.min(region.left, other.left);
        region.top = Math.min(region.top, other.top);
        region.right = Math.max(region.right, other.right);
        region.bottom = Math.max(region.bottom, other.bottom);
        region.missing ||= other.missing;
        regions.splice(next, 1);
        merged = true;
        break mergeRegions;
      }
    }
  }
  return regions.filter((region) => region.missing)
    .map((region) => ({
      left: region.left,
      top: region.top,
      width: region.right - region.left,
      height: region.bottom - region.top,
    }))
    .sort((left, right) => left.top - right.top || left.left - right.left);
}

function eligiblePixelsNearSeeds(
  seeds: Uint8Array,
  eligible: Uint8Array,
  width: number,
  height: number,
  radius: number,
) {
  const nearby = new Uint8Array(seeds.length);
  for (let index = 0; index < seeds.length; index += 1) {
    if (!seeds[index] || !eligible[index]) continue;
    nearby[index] = 1;
    const x = index % width;
    const y = Math.floor(index / width);
    for (let yOffset = -radius; yOffset <= radius; yOffset += 1) {
      for (let xOffset = -radius; xOffset <= radius; xOffset += 1) {
        if (xOffset === 0 && yOffset === 0) continue;
        const nextX = x + xOffset;
        const nextY = y + yOffset;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
        const next = nextY * width + nextX;
        if (eligible[next]) nearby[next] = 1;
      }
    }
  }
  return nearby;
}

function narrowTransparentGapsBetweenSeeds(
  seeds: Uint8Array,
  alpha: Buffer,
  width: number,
  height: number,
  radius: number,
) {
  const gaps = new Uint8Array(seeds.length);
  const seedInDirection = (x: number, y: number, xStep: number, yStep: number) => {
    const stepLength = Math.hypot(xStep, yStep);
    const maximumSteps = Math.ceil(radius / stepLength);
    for (let step = 1; step <= maximumSteps; step += 1) {
      const nextX = x + xStep * step;
      const nextY = y + yStep * step;
      if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) return false;
      if (seeds[nextY * width + nextX]) return true;
    }
    return false;
  };
  const axes = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
    [1, 2],
    [1, -2],
  ] as const;
  for (let index = 0; index < seeds.length; index += 1) {
    if (seeds[index] || alpha[index] > 20) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    gaps[index] = axes.some(([xStep, yStep]) => (
      seedInDirection(x, y, xStep, yStep)
      && seedInDirection(x, y, -xStep, -yStep)
    )) ? 1 : 0;
  }
  return gaps;
}

export async function createArtworkRecolorMask(bytes: Buffer, instruction: string) {
  const { data, width, height } = await decodedRgba(bytes);
  const bins = new Map<string, { count: number; red: number; green: number; blue: number }>();
  let visiblePixels = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] < 160) continue;
    visiblePixels += 1;
    const key = quantizedColorKey(data[offset], data[offset + 1], data[offset + 2], 5);
    const current = bins.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
    current.count += 1;
    current.red += data[offset];
    current.green += data[offset + 1];
    current.blue += data[offset + 2];
    bins.set(key, current);
  }
  const dominant = [...bins.values()].sort((left, right) => right.count - left.count)[0] ?? null;
  if (!dominant || visiblePixels === 0) return null;
  const dominantColor = {
    r: Math.round(dominant.red / dominant.count),
    g: Math.round(dominant.green / dominant.count),
    b: Math.round(dominant.blue / dominant.count),
  };
  const candidate = new Uint8Array(width * height);
  for (let index = 0; index < candidate.length; index += 1) {
    const offset = index * 4;
    if (data[offset + 3] < 20) continue;
    if (squaredColorDistance(data[offset], data[offset + 1], data[offset + 2], dominantColor) <= 100 ** 2) {
      candidate[index] = 1;
    }
  }

  const targetSpecificSubject = /手势|(?:主要|图形)主体|主体图形/iu.test(instruction)
    && !/(?:logo|图案).{0,6}(?:全部|整体)|全部元素|所有元素/iu.test(instruction);
  const components = targetSpecificSubject
    ? connectedCandidateComponents(candidate, width, height)
    : null;
  const minimumSubjectComponent = components
    ? Math.max(64, Math.ceil(components.largestCount * 0.03))
    : 0;
  let recolorCandidate = candidate;
  const reconstructedGap = new Uint8Array(candidate.length);
  if (components) {
    const selectedSubject = new Uint8Array(candidate.length);
    const eligibleConnectedDetail = new Uint8Array(candidate.length);
    let subjectLeft = width;
    let subjectTop = height;
    let subjectRight = -1;
    let subjectBottom = -1;
    for (let index = 0; index < candidate.length; index += 1) {
      const componentSize = components.counts[components.labels[index]] ?? 0;
      selectedSubject[index] = candidate[index] && componentSize >= minimumSubjectComponent ? 1 : 0;
      if (!selectedSubject[index]) continue;
      const x = index % width;
      const y = Math.floor(index / width);
      subjectLeft = Math.min(subjectLeft, x);
      subjectTop = Math.min(subjectTop, y);
      subjectRight = Math.max(subjectRight, x);
      subjectBottom = Math.max(subjectBottom, y);
    }
    const subjectMargin = Math.max(6, Math.round(Math.min(width, height) * 0.01));
    for (let index = 0; index < candidate.length; index += 1) {
      const offset = index * 4;
      const x = index % width;
      const y = Math.floor(index / width);
      const insideSubjectArea = x >= subjectLeft - subjectMargin
        && x <= subjectRight + subjectMargin
        && y >= subjectTop - subjectMargin
        && y <= subjectBottom + subjectMargin;
      const minimumChannel = Math.min(data[offset], data[offset + 1], data[offset + 2]);
      const maximumChannel = Math.max(data[offset], data[offset + 1], data[offset + 2]);
      const neutralLightDetail = minimumChannel >= 185 && maximumChannel - minimumChannel <= 45;
      eligibleConnectedDetail[index] = insideSubjectArea
        && data[offset + 3] >= 20
        && (selectedSubject[index] || !neutralLightDetail)
        ? 1
        : 0;
    }
    recolorCandidate = eligiblePixelsNearSeeds(
      selectedSubject,
      eligibleConnectedDetail,
      width,
      height,
      6,
    );
    for (let index = 0; index < candidate.length; index += 1) {
      if (recolorCandidate[index] && !candidate[index] && data[index * 4 + 3] < 240) {
        reconstructedGap[index] = 1;
      }
    }
    const alpha = Buffer.alloc(candidate.length);
    for (let index = 0; index < candidate.length; index += 1) {
      alpha[index] = data[index * 4 + 3];
    }
    const narrowGaps = narrowTransparentGapsBetweenSeeds(
      selectedSubject,
      alpha,
      width,
      height,
      12,
    );
    for (let index = 0; index < reconstructedGap.length; index += 1) {
      if (narrowGaps[index]) reconstructedGap[index] = 1;
    }
  }
  const output = Buffer.alloc(width * height * 4);
  let maskPixels = 0;
  for (let index = 0; index < recolorCandidate.length; index += 1) {
    if (!recolorCandidate[index] && !reconstructedGap[index]) continue;
    maskPixels += 1;
    const offset = index * 4;
    output[offset] = 255;
    output[offset + 1] = 255;
    output[offset + 2] = 255;
    output[offset + 3] = reconstructedGap[index] ? 255 : data[offset + 3];
  }
  if (maskPixels < Math.max(64, visiblePixels * 0.02)) return null;
  return sharp(output, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
