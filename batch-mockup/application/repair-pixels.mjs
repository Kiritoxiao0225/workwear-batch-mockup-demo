// Shared by the editor preview and server. Coordinates and radius are source pixels.
export function validateRepairStrokes(strokes, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16_000_000) throw new Error('图片尺寸不适合当前修补工具（最多1600万像素）');
  if (!Array.isArray(strokes) || !strokes.length || strokes.length > 1000) throw new Error('请先涂抹需要修补的区域，单次最多1000笔');
  let count = 0, work = 0;
  for (const s of strokes) {
    if (s?.mode === 'reset' && Object.keys(s).length === 1) { work += width * height; continue; }
    if (s?.mode === 'fill') {
      if (!['brush', 'region'].includes(s.scope) || !Array.isArray(s.point) || s.point.length !== 2 || s.point.some(v => !Number.isFinite(v)) || s.point[0] < 0 || s.point[0] >= width || s.point[1] < 0 || s.point[1] >= height || s.scope === 'brush' && (!Number.isFinite(s.radius) || s.radius < .5 || s.radius > 256)) throw new Error('补空白范围或坐标无效');
      work += width * height;
      if (work > 160_000_000) throw new Error('本次修补笔画较多，请分次保存');
      continue;
    }
    if (!s || !['keep', 'remove'].includes(s.mode) || !Number.isFinite(s.radius) || s.radius < .5 || s.radius > 256 || !Array.isArray(s.points) || !s.points.length) throw new Error('修补笔画无效');
    count += s.points.length;
    for (let i = 0; i < s.points.length; i++) {
      const p = s.points[i], a = s.points[Math.max(0, i - 1)];
      if (!Array.isArray(p) || p.length !== 2 || p.some(v => !Number.isFinite(v)) || p[0] < 0 || p[0] > width || p[1] < 0 || p[1] > height) throw new Error('修补坐标超出图片范围');
      work += Math.min(width, Math.abs(p[0] - a[0]) + 2 * s.radius + 2) * Math.min(height, Math.abs(p[1] - a[1]) + 2 * s.radius + 2);
    }
    if (count > 30000 || work > 160_000_000) throw new Error('本次修补笔画较多，请分次保存');
  }
  if (work > 160_000_000) throw new Error('本次修补笔画较多，请分次保存');
}

export function applyRepairStroke(target, source, original, width, height, stroke) {
  if (stroke.mode === 'reset') { target.set(original); return; }
  if (stroke.mode === 'fill') return fillRepairHoles(target, source, width, height, stroke);
  const r = stroke.radius;
  for (let i = 0; i < stroke.points.length; i++) {
    const [ax, ay] = stroke.points[Math.max(0, i - 1)], [bx, by] = stroke.points[i];
    const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
    const left = Math.max(0, Math.floor(Math.min(ax, bx) - r)), right = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + r));
    const top = Math.max(0, Math.floor(Math.min(ay, by) - r)), bottom = Math.min(height - 1, Math.ceil(Math.max(ay, by) + r));
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const t = length ? Math.max(0, Math.min(1, ((x + .5 - ax) * dx + (y + .5 - ay) * dy) / length)) : 0;
      if ((x + .5 - ax - t * dx) ** 2 + (y + .5 - ay - t * dy) ** 2 > r * r) continue;
      const p = (y * width + x) * 4;
      if (stroke.mode === 'remove') target[p + 3] = 0;
      else { target[p] = source[p]; target[p + 1] = source[p + 1]; target[p + 2] = source[p + 2]; target[p + 3] = source[p + 3]; }
    }
  }
}

// Fill only user-selected, enclosed areas whose alpha was lost during cutout.
// Eight-connected traversal treats even a diagonal opening as connected to the exterior.
function fillRepairHoles(target, source, width, height, stroke) {
  const total = width * height, visited = new Uint8Array(total), queue = new Uint32Array(total);
  const [cx, cy] = stroke.point, radius = stroke.radius;
  const eligible = i => target[i * 4 + 3] < 250 && source[i * 4 + 3] > target[i * 4 + 3];
  let restored = 0, foundExterior = false;
  function component(seed) {
    let head = 0, end = 1, exterior = false;
    queue[0] = seed; visited[seed] = 1;
    while (head < end) {
      const i = queue[head++], x = i % width, y = Math.floor(i / width);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) exterior = true;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
        const next = yy * width + xx;
        if (!visited[next] && eligible(next)) { visited[next] = 1; queue[end++] = next; }
      }
    }
    if (exterior) { foundExterior = true; return; }
    for (let n = 0; n < end; n++) {
      const i = queue[n], x = i % width, y = Math.floor(i / width);
      if (stroke.scope === 'brush' && (x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 > radius * radius) continue;
      const p = i * 4; target[p] = source[p]; target[p + 1] = source[p + 1]; target[p + 2] = source[p + 2]; target[p + 3] = source[p + 3]; restored++;
    }
  }
  if (stroke.scope === 'region') {
    const seed = Math.floor(cy) * width + Math.floor(cx);
    if (!eligible(seed)) throw new Error('请点在被抠空的区域内；已有图案不会改动');
    component(seed);
  } else {
    const left = Math.max(0, Math.floor(cx - radius)), right = Math.min(width - 1, Math.ceil(cx + radius));
    const top = Math.max(0, Math.floor(cy - radius)), bottom = Math.min(height - 1, Math.ceil(cy + radius));
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const i = y * width + x;
      if ((x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= radius * radius && !visited[i] && eligible(i)) component(i);
    }
  }
  if (!restored) throw new Error(foundExterior ? '这块空白与外部背景连通，未填补；可用保留笔局部修补' : '这里没有可补回的空白，已有图案保持不变');
  return { restoredPixels: restored };
}
