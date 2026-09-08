import sharp from 'sharp';

type Color = { r: number; g: number; b: number };
export type CircularEdgeRepair = {
  version: 'circular-edge-v1';
  applied: boolean;
  reason: string;
  radius?: number;
  center?: { x: number; y: number };
  contourError95?: number;
  changedPixels?: number;
  preservedInteriorPixels?: number;
};
const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)];
const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** Only a filled circular badge with a continuous, uniform, contrasting outline qualifies.
 * Rebuild its outer coverage at pixel resolution; never key out the enclosed white artwork.
 * Non-circular logos, holes, fine strokes and white outlines are returned unchanged.
 */
export async function refineCircularArtworkEdge(bytes: Buffer, background: Color = { r: 255, g: 255, b: 255 }): Promise<{ bytes: Buffer; report: CircularEdgeRepair }> {
  const skip = (reason: string) => ({ bytes, report: { version: 'circular-edge-v1' as const, applied: false, reason } });
  const { data, info } = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] < 128) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  const bw = right - left + 1, bh = bottom - top + 1;
  if (Math.min(bw, bh) < 64 || Math.abs(bw / bh - 1) > 0.025 || left < 1 || top < 1 || right >= width - 1 || bottom >= height - 1) return skip('轮廓不是完整近圆形');
  const cx = (left + right) / 2, cy = (top + bottom) / 2, initialRadius = (bw + bh) / 4;
  const band = Math.max(3, initialRadius * 0.018);
  const bg = [background.r, background.g, background.b];
  const composite = (index: number, channel: number) => {
    const a = data[index * 4 + 3] / 255;
    return data[index * 4 + channel] * a + bg[channel] * (1 - a);
  };
  const sample = (x: number, y: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const result = [0, 0, 0];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = Math.max(0, Math.min(width - 1, x0 + dx)), sy = Math.max(0, Math.min(height - 1, y0 + dy));
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      for (let c = 0; c < 3; c++) result[c] += composite(sy * width + sx, c) * weight;
    }
    return result;
  };
  const colors: number[][] = [];
  let interior = 0, opaqueInterior = 0, visibleOutside = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const radius = Math.hypot(x - cx, y - cy), index = y * width + x;
    if (radius < initialRadius - band * 2) { interior++; if (data[index * 4 + 3] >= 250) opaqueInterior++; }
    if (radius > initialRadius + band && data[index * 4 + 3] > 16) visibleOutside++;
    if (radius < initialRadius - band || radius > initialRadius - 1 || data[index * 4 + 3] < 250) continue;
    const color = [data[index * 4], data[index * 4 + 1], data[index * 4 + 2]];
    if (Math.hypot(...color.map((v, c) => v - bg[c])) > 120) colors.push(color);
  }
  if (!interior || opaqueInterior / interior < 0.995 || visibleOutside > 4 || colors.length < initialRadius) return skip('不是实心徽章或没有可靠的深色外框');
  const median = bg.map((_, c) => quantile(colors.map(color => color[c]), 0.5));
  const solidColors = colors.filter(color => Math.hypot(...color.map((v, c) => v - median[c])) <= 24);
  if (solidColors.length / colors.length < 0.65) return skip('外框颜色不够一致');
  const foreground = bg.map((_, c) => quantile(solidColors.map(color => color[c]), 0.5));
  const direction = foreground.map((v, c) => v - bg[c]);
  const denominator = direction.reduce((sum, v) => sum + v * v, 0);
  const opacity = (color: number[]) => color.reduce((sum, v, c) => sum + (v - bg[c]) * direction[c], 0) / denominator;
  const points: { x: number; y: number }[] = [];
  const ringErrors: number[] = [];
  for (let angle = 0; angle < 360; angle++) {
    const theta = angle * Math.PI / 180, dx = Math.cos(theta), dy = Math.sin(theta);
    let previousRadius = initialRadius + band, previousAlpha = opacity(sample(cx + previousRadius * dx, cy + previousRadius * dy));
    if (previousAlpha >= 0.5) return skip('圆外仍存在其他图案');
    for (let radius = previousRadius - 0.25; radius >= initialRadius - band; radius -= 0.25) {
      const a = opacity(sample(cx + radius * dx, cy + radius * dy));
      if (a >= 0.5) {
        const crossing = previousRadius + (radius - previousRadius) * (0.5 - previousAlpha) / (a - previousAlpha);
        points.push({ x: crossing * dx, y: crossing * dy });
        const strokeInset = Math.max(1.25, initialRadius * 0.005);
        const insideColor = sample(cx + (crossing - strokeInset) * dx, cy + (crossing - strokeInset) * dy);
        ringErrors.push(Math.hypot(...insideColor.map((v, c) => v - foreground[c])));
        break;
      }
      previousRadius = radius; previousAlpha = a;
    }
  }
  if (points.length < 358 || quantile(ringErrors, 0.95) > 32) return skip('圆形外框存在缺口或颜色变化');
  // Least-squares circle in centered coordinates: x²+y² = 2*x*dx + 2*y*dy + k.
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const p of points) {
    const row = [2 * p.x, 2 * p.y, 1], value = p.x * p.x + p.y * p.y;
    for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) matrix[i][j] += row[i] * row[j]; matrix[i][3] += row[i] * value; }
  }
  for (let i = 0; i < 3; i++) {
    const pivot = matrix[i][i];
    if (Math.abs(pivot) < 1e-8) return skip('圆形拟合不稳定');
    for (let j = i; j < 4; j++) matrix[i][j] /= pivot;
    for (let k = 0; k < 3; k++) if (k !== i) { const factor = matrix[k][i]; for (let j = i; j < 4; j++) matrix[k][j] -= factor * matrix[i][j]; }
  }
  const dx = matrix[0][3], dy = matrix[1][3], radius = Math.sqrt(matrix[2][3] + dx * dx + dy * dy);
  const errors = points.map(p => Math.abs(Math.hypot(p.x - dx, p.y - dy) - radius));
  const error95 = quantile(errors, 0.95);
  if (error95 > Math.max(0.8, radius * 0.006) || Math.max(...errors) > Math.max(2, radius * 0.015) || Math.hypot(dx, dy) > band) return skip('轮廓偏离圆形，保留原设计');
  const center = { x: cx + dx, y: cy + dy };
  // Restrict edits to the measured outside edge. Interior pixels stay byte-identical.
  const editBand = Math.max(1.75, Math.min(3, error95 + 1.5));
  const output = Buffer.from(data);
  let changedPixels = 0, preservedInteriorPixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const distance = Math.hypot(x - center.x, y - center.y), index = (y * width + x) * 4;
    if (distance < radius - editBand) { preservedInteriorPixels++; continue; }
    let coverage = 0;
    if (distance < radius + 0.75) {
      if (distance < radius - 0.75) coverage = 1;
      else for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        if (Math.hypot(x + (sx + 0.5) / 4 - 0.5 - center.x, y + (sy + 0.5) / 4 - 0.5 - center.y) <= radius) coverage += 1 / 16;
      }
    }
    const alpha = Math.round(coverage * 255);
    // Fade the decontaminated outline into the unchanged inner side of the stroke.
    const blend = clamp((distance - (radius - editBand)) / Math.max(0.25, editBand - 0.75));
    for (let c = 0; c < 3; c++) output[index + c] = alpha === 0 ? 0 : Math.round(data[index + c] * (1 - blend) + foreground[c] * blend);
    output[index + 3] = alpha;
    if (output.subarray(index, index + 4).some((v, c) => v !== data[index + c])) changedPixels++;
  }
  return { bytes: await sharp(output, { raw: { width, height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer(), report: {
    version: 'circular-edge-v1', applied: true, reason: '完整深色圆框：亚像素轮廓净边，保留圆内全部像素', radius, center, contourError95: error95, changedPixels, preservedInteriorPixels,
  } };
}
