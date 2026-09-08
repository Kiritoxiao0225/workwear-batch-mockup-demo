/** Remove a white matte and its colour spill without changing the logo palette.
 * Works on straight (unpremultiplied) RGBA from Canvas. No erosion or resizing.
 */
export function cleanLogoWhiteBackground(source: Uint8ClampedArray, width: number, height: number) {
  const size = width * height;
  if (source.length !== size * 4) throw new Error('Logo 像素尺寸不一致');
  const output = new Uint8ClampedArray(source);
  const background = new Uint8Array(size);
  const labels = new Int32Array(size);
  const queue = new Int32Array(size);
  const neighbors = (p: number, visit: (q: number) => void) => {
    const x = p % width;
    if (x > 0) visit(p - 1);
    if (x + 1 < width) visit(p + 1);
    if (p >= width) visit(p - width);
    if (p + width < size) visit(p + width);
  };
  for (let p = 0; p < size; p++) {
    const i = p * 4;
    background[p] = Number(source[i + 3] === 0 || Math.min(source[i], source[i + 1], source[i + 2]) >= 242);
  }

  // Locate enclosing frames before removing any white. A coloured character
  // counter alone is not evidence of a white foreground region.
  let label = 0;
  const components: Array<{ left: number; right: number; top: number; bottom: number; pixels: number }> = [];
  for (let start = 0; start < size; start++) {
    if (background[start] || labels[start]) continue;
    labels[start] = ++label;
    const component = { left: width, right: -1, top: height, bottom: -1, pixels: 0 };
    components[label] = component;
    let head = 0, tail = 1;
    queue[0] = start;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      component.left = Math.min(component.left, x); component.right = Math.max(component.right, x);
      component.top = Math.min(component.top, y); component.bottom = Math.max(component.bottom, y);
      component.pixels++;
      neighbors(p, q => {
        if (!background[q] && !labels[q]) { labels[q] = label; queue[tail++] = q; }
      });
    }
  }
  const cleared = new Uint8Array(size);
  const protectedWhite = new Uint8Array(size);
  for (let id = 1; id < components.length; id++) {
    const { left, right, top, bottom, pixels } = components[id];
    const bw = right - left + 1, bh = bottom - top + 1;
    if (Math.min(bw, bh) < 64 || Math.abs(bw / bh - 1) > .04 || left < 1 || top < 1 || right >= width - 1 || bottom >= height - 1) continue;
    const cx = (left + right) / 2, cy = (top + bottom) / 2, radius = (bw + bh) / 4;
    if (pixels / (Math.PI * radius * radius) > .3) continue;
    const frameBand = Math.max(5, radius * .06);
    let complete = true;
    for (let angle = 0; angle < 360; angle++) {
      const theta = angle * Math.PI / 180;
      let found = false;
      for (let r = radius + 1; r >= radius - frameBand; r -= .5) {
        const x = Math.round(cx + r * Math.cos(theta)), y = Math.round(cy + r * Math.sin(theta));
        if (x >= 0 && x < width && y >= 0 && y < height && labels[y * width + x] === id) { found = true; break; }
      }
      if (!found) { complete = false; break; }
    }
    if (!complete) continue;
    let interior = 0, white = 0, opaque = 0, artwork = 0, frameInside = 0;
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      if (Math.hypot(x - cx, y - cy) >= radius - frameBand) continue;
      const p = y * width + x, i = p * 4;
      interior++;
      if (source[i + 3] >= 250) opaque++;
      if (source[i + 3] >= 250 && Math.min(source[i], source[i + 1], source[i + 2]) >= 225) white++;
      if (labels[p] && labels[p] !== id && Math.min(source[i], source[i + 1], source[i + 2]) < 170) artwork++;
      if (labels[p] === id) frameInside++;
    }
    // Complete circular frame + opaque white backing + separate inner artwork.
    // Empty O/0, broken rings and pre-existing transparent holes do not qualify.
    if (!interior || opaque / interior < .995 || white / interior < .15 || artwork / interior < .03 || frameInside / interior > .03) continue;
    const protectedRadius = radius - Math.max(1.5, radius * .01);
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      if (Math.hypot(x - cx, y - cy) < protectedRadius) protectedWhite[y * width + x] = 1;
    }
  }
  for (let p = 0; p < size; p++) {
    if (background[p] && !protectedWhite[p]) { cleared[p] = 1; output.fill(0, p * 4, p * 4 + 4); }
  }

  // Only inspect a narrow band around removed background. Infer coverage from
  // the original nearby ink, and remove white from RGB as well as from alpha.
  // Reading immutable source pixels avoids progressively thinning the strokes.
  const band = new Uint8Array(size);
  let head = 0, tail = 0;
  for (let p = 0; p < size; p++) {
    if (background[p]) continue;
    neighbors(p, q => { if (cleared[q] && !band[p]) { band[p] = 1; queue[tail++] = p; } });
  }
  while (head < tail) {
    const p = queue[head++];
    if (band[p] >= 3) continue;
    neighbors(p, q => {
      if (!background[q] && !band[q]) { band[q] = band[p] + 1; queue[tail++] = q; }
    });
  }
  for (let n = 0; n < tail; n++) {
    const p = queue[n], i = p * 4, x = p % width, y = Math.floor(p / width);
    if (protectedWhite[p]) continue;
    const rgb = [source[i], source[i + 1], source[i + 2]];
    // An existing translucent ink pixel already has foreground RGB; applying
    // the white-matte equation again would multiply its coverage a second time.
    if (source[i + 3] < 255 && Math.min(...rgb) < 224) continue;
    let bestAlpha = 1, bestColor = rgb, bestDistance = Infinity, preserve = false;
    for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
      if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
      const q = (y + dy) * width + x + dx, j = q * 4;
      if (protectedWhite[q] && background[q]) { preserve = true; continue; }
      if (background[q] || source[j + 3] < source[i + 3]) continue;
      const color = [source[j], source[j + 1], source[j + 2]];
      if (Math.min(...color) >= Math.min(...rgb) - 8) continue;
      let dot = 0, norm = 0;
      for (let c = 0; c < 3; c++) { dot += (255 - rgb[c]) * (255 - color[c]); norm += (255 - color[c]) ** 2; }
      const alpha = dot / norm;
      if (alpha <= 0 || alpha >= 1) continue;
      // Do not turn a different hue or a true interior colour into edge coverage.
      if (rgb.some((v, c) => Math.abs(v - (255 + alpha * (color[c] - 255))) > 6)) continue;
      const distance = dx * dx + dy * dy;
      if (alpha < bestAlpha - .02 || (Math.abs(alpha - bestAlpha) <= .02 && distance < bestDistance)) {
        bestAlpha = alpha; bestColor = color; bestDistance = distance;
      }
    }
    if (preserve || bestAlpha === 1) continue;
    output[i] = bestColor[0]; output[i + 1] = bestColor[1]; output[i + 2] = bestColor[2];
    output[i + 3] = Math.round(source[i + 3] * bestAlpha);
  }
  return output;
}
