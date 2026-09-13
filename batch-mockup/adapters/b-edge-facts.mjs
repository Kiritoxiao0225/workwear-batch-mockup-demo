import sharp from 'sharp';

// A pixel observation, not a semantic segmentation or an automatic quality score.
export async function inspectEdgeContrast(bytes) {
  const { data, info } = await sharp(bytes).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (width < 4 || height < 4) return { method: 'corner_color_edge_contrast', applicable: false, note: '图片过小，不估计边缘主体' };
  const pixel = (x, y) => [...data.subarray((y * width + x) * channels, (y * width + x) * channels + 4)];
  const mx = Math.max(1, Math.floor(width * .02)), my = Math.max(1, Math.floor(height * .02));
  const corners = [pixel(mx, my), pixel(width - mx - 1, my), pixel(mx, height - my - 1), pixel(width - mx - 1, height - my - 1)];
  const median = [0, 1, 2].map(k => corners.map(p => p[k]).sort((a, b) => a - b)[1]);
  const distance = p => Math.max(...median.map((v, k) => Math.abs(v - p[k])));
  if (corners.some(p => p[3] < 250 || distance(p) > 35)) return { method: 'corner_color_edge_contrast', applicable: false, note: '四角颜色不一致或透明，不能按单色背景估计边界主体' };
  const edges = [];
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const length = ['left', 'right'].includes(side) ? height : width, hits = [];
    for (let n = 2; n < length - 2; n++) {
      const p = side === 'left' ? pixel(0, n) : side === 'right' ? pixel(width - 1, n) : side === 'top' ? pixel(n, 0) : pixel(n, height - 1);
      if (p[3] > 240 && distance(p) > 55) hits.push(n);
    }
    if (hits.length >= Math.max(5, length * .015)) edges.push({ side, fromPixel: hits[0], toPixel: hits.at(-1), contrastingPixels: hits.length, fraction: Number((hits.length / length).toFixed(4)) });
  }
  return { method: 'corner_color_edge_contrast', applicable: true, estimatedBackgroundRGB: median, edges,
    note: '边缘高反差像素可能是主体被截断，也可能是装饰或扫描边；须结合原图判断。不是主体识别、清晰度评分或缺失轮廓还原。' };
}
