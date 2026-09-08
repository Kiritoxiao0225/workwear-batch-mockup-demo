import sharp from 'sharp';

export type ArtworkBadgeRegion = { x: number; y: number; radius: number };

/** Locate complete circular frames containing both white backing and separate artwork.
 * Empty rings (including O/0), broken frames and already transparent interiors do not qualify.
 * This is deliberately a narrow badge rule, not a general interpretation of white pixels.
 */
export async function detectArtworkBadges(bytes: Buffer): Promise<ArtworkBadgeRegion[]> {
  const meta = await sharp(bytes).metadata();
  const { data, info } = await sharp(bytes).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info, n = w * h;
  const labels = new Int32Array(n), queue = new Int32Array(n);
  const foreground = (p: number) => {
    const i = p * 4;
    return data[i + 3] >= 240 && Math.min(data[i], data[i + 1], data[i + 2]) < 170;
  };
  const regions: ArtworkBadgeRegion[] = [];
  let label = 0;
  for (let start = 0; start < n; start++) {
    if (labels[start] || !foreground(start)) continue;
    label++;
    let head = 0, tail = 1, left = w, right = -1, top = h, bottom = -1;
    queue[0] = start; labels[start] = label;
    while (head < tail) {
      const p = queue[head++], x = p % w, y = Math.floor(p / w);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && !labels[q] && foreground(q)) { labels[q] = label; queue[tail++] = q; }
      }
    }
    const bw = right - left + 1, bh = bottom - top + 1;
    if (Math.min(bw, bh) < Math.max(64, Math.min(w, h) * .2) || Math.abs(bw / bh - 1) > .035 || left < 1 || top < 1 || right >= w - 1 || bottom >= h - 1) continue;
    const x = (left + right) / 2, y = (top + bottom) / 2, radius = (bw + bh) / 4;
    if (tail / (Math.PI * radius * radius) > .3) continue; // filled discs are not enclosing frames
    const band = Math.max(3, radius * .05);
    let coverage = 0;
    for (let angle = 0; angle < 360; angle++) {
      const theta = angle * Math.PI / 180;
      for (let r = radius + 1; r >= radius - band; r -= .5) {
        const sx = Math.round(x + r * Math.cos(theta)), sy = Math.round(y + r * Math.sin(theta));
        if (sx >= 0 && sx < w && sy >= 0 && sy < h && labels[sy * w + sx] === label) { coverage++; break; }
      }
    }
    if (coverage !== 360) continue;
    let interior = 0, white = 0, opaque = 0, artwork = 0, frameInside = 0;
    for (let sy = top; sy <= bottom; sy++) for (let sx = left; sx <= right; sx++) {
      if (Math.hypot(sx - x, sy - y) >= radius - band) continue;
      const p = sy * w + sx, i = p * 4;
      interior++;
      if (data[i + 3] >= 250) opaque++;
      if (data[i + 3] >= 250 && Math.min(data[i], data[i + 1], data[i + 2]) >= 225) white++;
      if (foreground(p) && labels[p] !== label) artwork++;
      if (labels[p] === label) frameInside++;
    }
    if (!interior || opaque / interior < .995 || white / interior < .15 || artwork / interior < .03 || frameInside / interior > .03) continue;
    // Stop within the frame stroke: leave its outer anti-aliased edge to the cutout.
    const scale = meta.width! / w;
    regions.push({ x: (x + .5) * scale - .5, y: (y + .5) * scale - .5, radius: (radius - Math.max(1.5, radius * .01)) * scale });
  }
  return regions.filter(region => !regions.some(other => other !== region && other.radius > region.radius && Math.hypot(region.x - other.x, region.y - other.y) + region.radius < other.radius));
}

/** Both providers use the original pixels inside a verified badge; never paint invented white. */
export async function protectArtworkBadges(source: Buffer, result: Buffer) {
  const regions = await detectArtworkBadges(source);
  if (!regions.length) return { bytes: result, regions, restoredPixels: 0 };
  const [original, cutout] = await Promise.all([
    sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(result).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (original.info.width !== cutout.info.width || original.info.height !== cutout.info.height) throw new Error('徽章保护需要抠图前后画布一致，当前结果无法安全保留原图底色');
  const { width, height } = original.info;
  const output = Buffer.from(cutout.data);
  let restoredPixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!regions.some(region => Math.hypot(x - region.x, y - region.y) < region.radius)) continue;
    const i = (y * width + x) * 4;
    if (!original.data.subarray(i, i + 4).equals(output.subarray(i, i + 4))) restoredPixels++;
    original.data.copy(output, i, i, i + 4);
  }
  return { bytes: await sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer(), regions, restoredPixels };
}
