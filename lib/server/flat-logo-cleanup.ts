import sharp from 'sharp';
import { inspectArtworkSource, removeFlatArtworkBackground, visibleArtworkBounds } from './artwork-image-processing';

type Color = [number, number, number];
const distance = (a: Color, b: Color) => a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0);
function sameHueFamily(a: Color, b: Color) {
  const hue = (color: Color) => {
    const max = Math.max(...color), min = Math.min(...color), delta = max - min;
    const saturation = max ? delta / max : 0;
    const h = !delta ? 0 : max === color[0] ? (color[1] - color[2]) / delta : max === color[1] ? 2 + (color[2] - color[0]) / delta : 4 + (color[0] - color[1]) / delta;
    return { saturation, degrees: ((h * 60) % 360 + 360) % 360 };
  };
  const left = hue(a), right = hue(b);
  if (left.saturation < .3 || right.saturation < .3) return left.saturation < .3 && right.saturation < .3;
  const difference = Math.abs(left.degrees - right.degrees);
  return Math.min(difference, 360 - difference) <= 12;
}

/** Match the successful reference input: actual foreground + small safe margins,
 * PNG, no upscaling. Large blank canvases must not determine the redraw layout. */
export async function flatLogoRedrawInput(source: Buffer) {
  const profile = await inspectArtworkSource(source);
  const cutout = profile.kind === 'transparent' ? source : profile.kind === 'flat-background' && profile.backgroundColor
    ? await removeFlatArtworkBackground(source, profile.backgroundColor) : null;
  if (!cutout) throw new Error('纯色重绘缺少可靠的主体边界');
  const bounds = await visibleArtworkBounds(cutout);
  const padding = Math.max(16, Math.ceil(Math.max(bounds.width, bounds.height) * .04));
  const left = Math.max(0, bounds.left - padding), top = Math.max(0, bounds.top - padding);
  const width = Math.min(profile.width, bounds.left + bounds.width + padding) - left;
  const height = Math.min(profile.height, bounds.top + bounds.height + padding) - top;
  const whiteSource = profile.backgroundColor && distance([profile.backgroundColor.r, profile.backgroundColor.g, profile.backgroundColor.b], [255, 255, 255]) <= 15 ** 2;
  const bytes = await sharp(whiteSource ? source : cutout).extract({ left, top, width, height }).flatten({ background: '#ffffff' }).png().toBuffer();
  return { bytes, bounds: { left, top, width, height }, palette: await originalFlatLogoPalette(cutout) };
}

/** Only called after the semantic inspection excludes photos, gradients and white foreground. */
export async function originalFlatLogoPalette(source: Buffer): Promise<Color[]> {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bins = new Map<string, { count: number; sum: Color }>();
  for (let y = 1; y < info.height - 1; y++) for (let x = 1; x < info.width - 1; x++) {
    const offset = (y * info.width + x) * 4;
    const pixel: Color = [data[offset], data[offset + 1], data[offset + 2]];
    if (data[offset + 3] < 240 || distance(pixel, [255, 255, 255]) < 80 ** 2) continue;
    // Sample opaque interiors, not the mixed colour at antialiased edges.
    if ([-4, 4, -info.width * 4, info.width * 4].some(delta => distance(pixel, [data[offset + delta], data[offset + delta + 1], data[offset + delta + 2]]) > 24 ** 2)) continue;
    const key = pixel.map(value => Math.floor(value / 24)).join(',');
    const bin = bins.get(key) ?? { count: 0, sum: [0, 0, 0] };
    bin.count++;
    pixel.forEach((value, index) => { bin.sum[index] += value; });
    bins.set(key, bin);
  }
  const sorted = [...bins.values()].sort((a, b) => b.count - a.count);
  const total = sorted.reduce((sum, bin) => sum + bin.count, 0);
  if (total < 20) throw new Error('无法从原图可靠提取纯色，请提供标准色或更清晰原图');
  const clusters: Array<{ count: number; color: Color }> = [];
  for (const bin of sorted) {
    const color = bin.sum.map(value => value / bin.count) as Color;
    const existing = clusters.find(cluster => distance(cluster.color, color) <= 40 ** 2);
    if (existing) {
      existing.color = existing.color.map((value, index) => (value * existing.count + bin.sum[index]) / (existing.count + bin.count)) as Color;
      existing.count += bin.count;
    } else clusters.push({ count: bin.count, color });
  }
  clusters.sort((a, b) => b.count - a.count);
  const chosen: typeof clusters = [];
  let covered = clusters.slice(0, 6).reduce((sum, cluster) => sum + cluster.count, 0);
  for (const cluster of clusters.slice(0, 6)) {
    const minorShade = cluster.count / total < .05 && chosen.some(primary => primary.count / total >= .05 && sameHueFamily(primary.color, cluster.color));
    if (minorShade && (covered - cluster.count) / total >= .95) covered -= cluster.count;
    else chosen.push(cluster);
  }
  if (chosen.reduce((sum, cluster) => sum + cluster.count, 0) / total < .95) throw new Error('原图实色不集中：六种主色覆盖不足 95%，不执行纯色净化');
  return chosen.map(cluster => cluster.color.map(Math.round) as Color);
}

export async function cleanFlatLogo(generated: Buffer, palette: Color[]) {
  if (!palette.length || palette.length > 6 || palette.some(color => distance(color, [255, 255, 255]) < 50 ** 2)) throw new Error('纯色净化需要 1–6 个非白色前景标准色');
  const { data, info } = await sharp(generated).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const size = info.width * info.height;
  const rgba = Buffer.alloc(size * 4);
  const opacity = Buffer.alloc(size);
  const pixelColors = new Uint8Array(size);
  const colorErrors = new Float32Array(size);
  const vectors = palette.map(color => color.map(value => value - 255));
  const denominators = vectors.map(vector => vector.reduce((sum, value) => sum + value * value, 0));
  // Estimate colour family separately from coverage. A darker neutral outline is
  // not a new brand colour; the previous clamped projection rejected it as drift.
  for (let p = 0, q = 0; p < data.length; p += 3, q += 4) {
    let best = { alpha: 0, error: Infinity, index: 0 };
    for (const [index, vector] of vectors.entries()) {
      const alpha = Math.max(0, Math.min(1.5, vector.reduce((sum, value, channel) => sum + value * (data[p + channel] - 255), 0) / denominators[index]));
      const error = vector.reduce((sum, value, index) => sum + (data[p + index] - (255 + alpha * value)) ** 2, 0);
      if (error < best.error) best = { alpha, error, index };
    }
    const pixel = q / 4;
    opacity[pixel] = best.alpha < .08 ? 0 : Math.round(Math.min(1, best.alpha) * 255);
    pixelColors[pixel] = best.index;
    colorErrors[pixel] = best.error;
  }
  const smoothed = await sharp(opacity, { raw: { width: info.width, height: info.height, channels: 1 } }).median(3).toColourspace('b-w').raw().toBuffer();
  const labels = new Int32Array(size), queue = new Int32Array(size);
  const components: Array<{ pixels: number; votes: number[]; errors: number; core: number }> = [{ pixels: 0, votes: [], errors: 0, core: 0 }];
  for (let start = 0; start < size; start++) {
    if (smoothed[start] <= 20 || labels[start]) continue;
    const id = components.length, component = { pixels: 0, votes: palette.map(() => 0), errors: 0, core: 0 };
    components.push(component); labels[start] = id; queue[0] = start;
    let head = 0, tail = 1;
    while (head < tail) {
      const pixel = queue[head++], x = pixel % info.width;
      component.pixels++;
      if (smoothed[pixel] >= 230) {
        component.votes[pixelColors[pixel]]++; component.core++;
        if (colorErrors[pixel] > 40 ** 2) component.errors++;
      }
      const add = (next: number) => { if (next < 0 || next >= size || labels[next] || smoothed[next] <= 20) return; labels[next] = id; queue[tail++] = next; };
      if (x > 0) add(pixel - 1); if (x + 1 < info.width) add(pixel + 1);
      add(pixel - info.width); add(pixel + info.width);
    }
  }
  // A few isolated compression pixels must not become opaque flecks. Keep small
  // meaningful marks (including detached punctuation / registered signs).
  const minimumIsland = 6;
  let visible = 0, mismatched = 0;
  const choices = components.map(component => {
    const maximum = Math.max(...component.votes, 0), color = component.votes.indexOf(maximum);
    if (component.pixels >= minimumIsland) { visible += component.pixels; mismatched += component.errors; }
    return component.core && maximum / component.core >= .85 ? color : -1;
  });
  if (visible < size * .005) throw new Error('净化后的可见图案不足，停止自动使用');
  if (mismatched / visible > .1) throw new Error('重绘图出现无法匹配原图的色相，保留候选供人工检查');
  // Only transfer the component's dominant colour into contaminated edge pixels.
  // A legitimate second colour touching it, or enclosed within it, stays intact.
  const edgeDistance = new Uint8Array(size);
  let head = 0, tail = 0;
  for (let pixel = 0; pixel < size; pixel++) {
    if (!labels[pixel]) continue;
    edgeDistance[pixel] = 255;
    const x = pixel % info.width;
    if (x === 0 || x === info.width - 1 || pixel < info.width || pixel >= size - info.width
      || !labels[pixel - 1] || !labels[pixel + 1] || !labels[pixel - info.width] || !labels[pixel + info.width]) {
      edgeDistance[pixel] = 1; queue[tail++] = pixel;
    }
  }
  while (head < tail) {
    const pixel = queue[head++];
    if (edgeDistance[pixel] >= 6) continue;
    const x = pixel % info.width;
    const add = (next: number) => { if (next < 0 || next >= size || !labels[next] || edgeDistance[next] !== 255) return; edgeDistance[next] = edgeDistance[pixel] + 1; queue[tail++] = next; };
    if (x > 0) add(pixel - 1); if (x + 1 < info.width) add(pixel + 1); add(pixel - info.width); add(pixel + info.width);
  }
  for (let pixel = 0; pixel < size; pixel++) {
    const id = labels[pixel];
    if (!id || components[id].pixels < minimumIsland) continue;
    const ownColor = pixelColors[pixel];
    const rgb: Color = [data[pixel * 3], data[pixel * 3 + 1], data[pixel * 3 + 2]];
    const colorIndex = choices[id] >= 0 && edgeDistance[pixel] <= 6 && distance(rgb, palette[ownColor]) > 24 ** 2 ? choices[id] : ownColor;
    const color = palette[colorIndex];
    const alpha = smoothed[pixel] > 230 ? 255 : smoothed[pixel];
    for (let c = 0; c < 3; c++) rgba[pixel * 4 + c] = color[c];
    rgba[pixel * 4 + 3] = alpha;
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}
