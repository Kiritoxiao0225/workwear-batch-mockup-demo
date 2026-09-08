/** Rounded alpha dilation: extend nearby ink colors, never paint a background.
 * Fractional coverage makes small adjustments possible without blurring solid ink.
 * The caller supplies transparent padding; the input remains the reset baseline.
 */
export function spreadArtworkInk(source: Uint8ClampedArray, width: number, height: number, radiusX: number, radiusY = radiusX) {
  if (source.length !== width * height * 4 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('加粗图层像素尺寸不匹配');
  if (![radiusX, radiusY].every(value => Number.isFinite(value) && value >= 0 && value <= 8)) throw new Error('加粗强度超出支持范围');
  const output = new Uint8ClampedArray(source);
  if (!radiusX || !radiusY) return output;
  const offsets: Array<{ x: number; y: number; coverage: number }> = [];
  for (let y = -Math.ceil(radiusY); y <= Math.ceil(radiusY); y++) for (let x = -Math.ceil(radiusX); x <= Math.ceil(radiusX); x++) {
    if (!x && !y) continue;
    const distance = Math.hypot(x / radiusX, y / radiusY);
    const coverage = Math.min(1, Math.max(0, 1 + (1 - distance) * Math.min(radiusX, radiusY)));
    if (coverage) offsets.push({ x, y, coverage });
  }
  offsets.sort((a, b) => b.coverage - a.coverage || Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    if (source[at + 3] === 255) continue;
    let alpha = source[at + 3], colorAt = at;
    for (const offset of offsets) {
      if (255 * offset.coverage <= alpha) break;
      const sx = x + offset.x, sy = y + offset.y;
      if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
      const from = (sy * width + sx) * 4, candidate = Math.round(source[from + 3] * offset.coverage);
      if (candidate > alpha) { alpha = candidate; colorAt = from; }
    }
    if (alpha > source[at + 3]) {
      output[at] = source[colorAt]; output[at + 1] = source[colorAt + 1]; output[at + 2] = source[colorAt + 2]; output[at + 3] = alpha;
    }
  }
  return output;
}
