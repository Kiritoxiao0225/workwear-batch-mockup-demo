/**
 * 电商主图 SKU images, put together by the program instead of drawn by the image model: the layout
 * top workwear shops use for every colour (learned from 易玛威's colour images, output/listing-sku-20261012/top02).
 * Left: the shop's logo, a two-line title, three rows (style, fabric, colour) and a card on the colour's
 * fabric with the lead feature and three small icons. Right: the colour's model photo (the material's
 * own or one drawn from the cast), or its garment cut out of the white-background image. Only the
 * colour name, the fabric card and the picture change from one colour to the next, and the person (or
 * garment) is the same size on every colour: found on the photo's plain background and scaled to one height.
 */
import path from 'node:path';
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import sharp from 'sharp';
import { iconFor, type SkuIcon, type SkuText } from '../listing/sku-card';
import type { Frame } from './listing-recognize';

export const SKU_CARD_SIZE = 1200;
/** The words (lib/listing/sku-card.ts, the colour row last), the shop's logo, the fabric and the picture. */
export type SkuCard = SkuText & {
  logo?: Buffer | null;
  /** A close-up of this colour's fabric: the feature card's background. */
  fabric: Buffer;
  /** The colour's model photo, or its garment without background (`cutout`); `frame`: where the model is, found by the analysis model (photos on a plain background need none). */
  photo: { bytes: Buffer; cutout: boolean; frame?: Frame | null };
  /** A short tag such as 「男女同款」: a dark pill under the title. */
  tag?: string | null;
};

/** `serif`: the title's (Noto Serif SC Black, GB2312 level one only; OFL, public/fonts/NotoSerifSC-OFL.txt). */
const FONT = { regular: 'PuHui Regular', bold: 'PuHui Bold', heavy: 'PuHui Heavy', serif: 'Listing Serif Black' };
let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  for (const [file, family] of [['Regular', FONT.regular], ['Bold', FONT.bold], ['Heavy', FONT.heavy]] as const)
    if (!GlobalFonts.registerFromPath(path.join(process.cwd(), `public/fonts/AlibabaPuHuiTi-${file}.ttf`), family)) throw new Error(`后台普惠体（${file}）加载失败`);
  if (!GlobalFonts.registerFromPath(path.join(process.cwd(), 'public/fonts/NotoSerifSC-Black-GB2312.otf'), FONT.serif)) throw new Error('后台宋体加载失败');
  fontsReady = true;
}

/** Text at a size that fits `max` pixels, never larger than `size`. */
function fitText(ctx: SKRSContext2D, text: string, family: string, size: number, max: number) {
  let s = size;
  ctx.font = `${s}px "${family}"`;
  while (s > 12 && ctx.measureText(text).width > max) { s -= 1; ctx.font = `${s}px "${family}"`; }
  return s;
}

/**
 * Words with the unit marks the fonts lack (10-18: 「MMH₂O」 printed 「MMH」, 「4000⁺」 「4000」): ₂ is
 * drawn as a small 2 below the line, ⁺ and ² as small marks above it, ㎡ as m².
 */
type Run = { t: string; at: 'line' | 'below' | 'above' };
export function runs(text: string): Run[] {
  const out: Run[] = [];
  const push = (t: string, at: Run['at']) => { const last = out[out.length - 1]; if (last?.at === at) last.t += t; else out.push({ t, at }); };
  for (const ch of text) {
    if (ch === '₂') push('2', 'below');
    else if (ch === '⁺') push('+', 'above');
    else if (ch === '²') push('2', 'above');
    else if (ch === '㎡') { push('m', 'line'); push('2', 'above'); }
    else push(ch, 'line');
  }
  return out;
}
const runSize = (r: Run, size: number) => r.at === 'line' ? size : Math.round(size * 0.62);
function measureRuns(ctx: SKRSContext2D, text: string, family: string, size: number) {
  return runs(text).reduce((w, r) => { ctx.font = `${runSize(r, size)}px "${family}"`; return w + ctx.measureText(r.t).width; }, 0);
}
function drawRuns(ctx: SKRSContext2D, text: string, family: string, size: number, x: number, y: number, align: 'left' | 'center' = 'left') {
  let at = align === 'center' ? x - measureRuns(ctx, text, family, size) / 2 : x;
  const was = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const r of runs(text)) {
    ctx.font = `${runSize(r, size)}px "${family}"`;
    ctx.fillText(r.t, at, y + (r.at === 'below' ? size * 0.18 : r.at === 'above' ? -size * 0.38 : 0));
    at += ctx.measureText(r.t).width;
  }
  ctx.textAlign = was;
}
/**
 * Words laid out to fit `max` pixels: one line from `size` down to `min`, else (with `lines` 2) two lines
 * broken between words, never inside a run of letters and figures. Null when even that does not fit:
 * nothing is cut (lib/listing/sku-card.ts keeps the words to what fits).
 */
function layoutText(ctx: SKRSContext2D, text: string, family: string, size: number, min: number, max: number, lines: 1 | 2 = 1): { size: number; lines: string[] } | null {
  for (let s = size; s >= min; s--) if (measureRuns(ctx, text, family, s) <= max) return { size: s, lines: [text] };
  if (lines < 2) return null;
  const chars = [...text], tight = /[A-Za-z0-9.+⁺₂²]/;
  let best: string[] | null = null, widest = Infinity;
  for (let i = 1; i < chars.length; i++) {
    if (tight.test(chars[i - 1]) && tight.test(chars[i])) continue;
    const pair = [chars.slice(0, i).join('').trim(), chars.slice(i).join('').replace(/^[，、；\s]+/, '').trim()];
    if (!pair[0] || !pair[1]) continue;
    const w = Math.max(...pair.map(l => measureRuns(ctx, l, family, min)));
    if (w < widest) { widest = w; best = pair; }
  }
  if (!best) return null;
  for (let s = size; s >= min; s--) if (best.every(l => measureRuns(ctx, l, family, s) <= max)) return { size: s, lines: best };
  return null;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Line icons drawn around (cx, cy) in a box of 2r. */
function drawIcon(ctx: SKRSContext2D, icon: SkuIcon, cx: number, cy: number, r: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(2, r / 9); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const u = r / 10;
  const line = (pts: number[][]) => { ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(cx + x * u, cy + y * u) : ctx.moveTo(cx + x * u, cy + y * u)); ctx.stroke(); };
  switch (icon) {
    case 'style': // a jacket from the front
      line([[-3, -8], [-8, -6], [-10, 6], [-7, 6.5], [-6, -1], [-6, 8], [6, 8], [6, -1], [7, 6.5], [10, 6], [8, -6], [3, -8], [0, -5], [-3, -8]]);
      line([[0, -5], [0, 8]]); break;
    case 'fabric': // a woven patch
      for (let k = -6; k <= 6; k += 3) { line([[k - 4, -6], [k + 4, 6]]); line([[k + 4, -6], [k - 4, 6]]); } break;
    case 'color': // a palette
      ctx.beginPath(); ctx.arc(cx, cy, 8 * u, 0.25 * Math.PI, 2.1 * Math.PI); ctx.quadraticCurveTo(cx + 2 * u, cy + 2 * u, cx + 5.5 * u, cy + 5.8 * u); ctx.stroke();
      for (const [x, y] of [[-4, -3], [0, -5], [4, -3], [-4.5, 2]]) { ctx.beginPath(); ctx.arc(cx + x * u, cy + y * u, 1.3 * u, 0, 2 * Math.PI); ctx.fill(); } break;
    case 'water': // a drop over waves
      ctx.beginPath(); ctx.moveTo(cx, cy - 8 * u); ctx.bezierCurveTo(cx + 5 * u, cy - 2 * u, cx + 5 * u, cy + 3 * u, cx, cy + 3 * u); ctx.bezierCurveTo(cx - 5 * u, cy + 3 * u, cx - 5 * u, cy - 2 * u, cx, cy - 8 * u); ctx.stroke();
      for (const y of [6, 9]) { ctx.beginPath(); ctx.moveTo(cx - 7 * u, cy + y * u); ctx.quadraticCurveTo(cx - 3.5 * u, cy + (y - 2) * u, cx, cy + y * u); ctx.quadraticCurveTo(cx + 3.5 * u, cy + (y + 2) * u, cx + 7 * u, cy + y * u); ctx.stroke(); } break;
    case 'breathe': // three arrows up
      for (const x of [-5, 0, 5]) { line([[x, 8], [x, -7]]); line([[x - 2.2, -4.5], [x, -7], [x + 2.2, -4.5]]); } break;
    case 'wear': // a shield with a tick
      line([[0, -8], [7, -5], [6.5, 2], [0, 8], [-6.5, 2], [-7, -5], [0, -8]]); line([[-3, 0], [-0.5, 2.8], [3.5, -2.5]]); break;
    case 'wind': // wind lines
      for (const [y, w] of [[-4, 9], [0, 6], [4, 8]]) { ctx.beginPath(); ctx.moveTo(cx - 8 * u, cy + y * u); ctx.lineTo(cx + (w - 8 + 6) * u, cy + y * u); ctx.arc(cx + (w - 2) * u, cy + (y - 1.6) * u, 1.6 * u, 0.5 * Math.PI, -0.9 * Math.PI, true); ctx.stroke(); } break;
    case 'warm': // a thermometer
      roundRect(ctx, cx - 2 * u, cy - 9 * u, 4 * u, 12 * u, 2 * u); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy + 5.5 * u, 3.2 * u, 0, 2 * Math.PI); ctx.stroke(); line([[0, 5.5], [0, -3]]); break;
    case 'light': // a feather
      ctx.beginPath(); ctx.moveTo(cx - 6 * u, cy + 8 * u); ctx.bezierCurveTo(cx - 6 * u, cy - 4 * u, cx + 2 * u, cy - 9 * u, cx + 7 * u, cy - 8 * u); ctx.bezierCurveTo(cx + 7 * u, cy - 1 * u, cx + 1 * u, cy + 5 * u, cx - 6 * u, cy + 8 * u); ctx.stroke();
      line([[-6, 8], [3, -3]]); break;
    case 'scene': // mountains
      line([[-9, 7], [-3, -4], [1, 2], [4, -2], [9, 7], [-9, 7]]); ctx.beginPath(); ctx.arc(cx + 5 * u, cy - 7 * u, 1.6 * u, 0, 2 * Math.PI); ctx.fill(); break;
    case 'zip': // a zip with its pull
      line([[0, -9], [0, 9]]); for (let y = -7; y <= 7; y += 3) line([[-2.5, y], [2.5, y]]);
      roundRect(ctx, cx - 2.5 * u, cy - 1 * u, 5 * u, 7 * u, 1.5 * u); ctx.stroke(); break;
    default:
      ctx.beginPath(); ctx.arc(cx, cy, 3 * u, 0, 2 * Math.PI); ctx.fill();
  }
  ctx.restore();
}

/** Water drops beading on the fabric, and the arrows of air going out through it. */
function drawDrops(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, light: boolean) {
  const drops: [number, number, number][] = [[0.58, 0.1, 11], [0.72, 0.24, 8], [0.88, 0.08, 6], [0.93, 0.27, 10], [0.5, 0.22, 5]];
  for (const [fx, fy, r] of drops) {
    const cx = x + fx * w, cy = y + fy * h;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = r * 0.6; ctx.shadowOffsetY = r * 0.25;
    const body = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    body.addColorStop(0, 'rgba(255,255,255,0.55)'); body.addColorStop(0.6, 'rgba(255,255,255,0.12)'); body.addColorStop(1, light ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.35)');
    ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fill();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.35, r * 0.22, 0, 2 * Math.PI); ctx.fill();
  }
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  for (const k of [0, 1, 2]) {
    const sx = x + w * (0.6 + k * 0.11), sy = y + h * 0.3, ex = sx + w * 0.04, ey = y + h * 0.05;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(sx - w * 0.05, (sy + ey) / 2, ex, ey); ctx.stroke();
    const a = Math.atan2(ey - (sy + ey) / 2, ex - (sx - w * 0.05));
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - 14 * Math.cos(a - 0.5), ey - 14 * Math.sin(a - 0.5)); ctx.moveTo(ex, ey); ctx.lineTo(ex - 14 * Math.cos(a + 0.5), ey - 14 * Math.sin(a + 0.5)); ctx.stroke();
  }
  ctx.restore();
}

/**
 * Where the person (or garment) is on a picture, as fractions of it, from its transparent or plain
 * background (the border's colour). `cut`: it runs off the bottom edge. `bg`: the background colour.
 * Null when the background is not plain enough to tell.
 */
export async function subjectBox(bytes: Buffer) {
  const { data, info } = await sharp(bytes, { limitInputPixels: 60_000_000 }).rotate().resize(320, 320, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info, at = (x: number, y: number) => (y * w + x) * 4;
  // The background is read above the head: the top edge and the top fifth of the sides (a photo cut at
  // the knees has the person on the bottom edge, a pair may reach the sides lower down).
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(at(x, 0), at(x, 1));
  for (let y = 0; y < h * 0.2; y++) border.push(at(0, y), at(1, y), at(w - 1, y), at(w - 2, y));
  const clear = border.filter(i => data[i + 3] < 32).length / border.length > 0.5;
  const median = (k: number) => { const v = border.map(i => data[i + k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const bg = { r: median(0), g: median(1), b: median(2) };
  const off = (i: number) => clear ? data[i + 3] >= 32 : data[i + 3] >= 32 && Math.hypot(data[i] - bg.r, data[i + 1] - bg.g, data[i + 2] - bg.b) > 34;
  if (!clear && border.filter(off).length / border.length > 0.25) return null;
  const rows = new Array(h).fill(0), cols = new Array(w).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (off(at(x, y))) { rows[y]++; cols[x]++; }
  const first = (a: number[], min: number) => a.findIndex(n => n > min), last = (a: number[], min: number) => a.length - 1 - [...a].reverse().findIndex(n => n > min);
  const top = first(rows, w * 0.015), bottom = last(rows, w * 0.015), left = first(cols, h * 0.015), right = last(cols, h * 0.015);
  if (top < 0 || left < 0 || bottom <= top || right <= left) return null;
  // A head touching the top edge: not a subject standing on a plain background.
  if (top <= 1) return null;
  return { x: left / w, y: top / h, w: (right + 1 - left) / w, h: (bottom + 1 - top) / h, cut: bottom >= h - 3, bg: `rgb(${bg.r},${bg.g},${bg.b})` };
}

const SKU_THIGH = 0.8;
const asImage = async (bytes: Buffer) => loadImage(await sharp(bytes, { limitInputPixels: 60_000_000 }).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).png().toBuffer());

/** One colour's SKU image, 1200 px square, JPEG. */
export async function renderSkuCard(c: SkuCard): Promise<Buffer> {
  ensureFonts();
  const S = SKU_CARD_SIZE, canvas = createCanvas(S, S), ctx = canvas.getContext('2d');
  const BG = '#ececec', INK = '#1d1d1d', SOFT = '#555555';
  const bg = ctx.createLinearGradient(0, 0, S, S);
  bg.addColorStop(0, '#f2f2f2'); bg.addColorStop(1, '#e2e2e2');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, S, S);

  // Right: the model photo in a rounded panel (its own background stays), or the garment standing on the grey.
  if (!c.photo.cutout) {
    const img = await asImage(c.photo.bytes), panel = { x: 452, y: 36, w: S - 452 - 36, h: S - 72 };
    // Head to mid-thigh (SKU_THIGH of the way to the knees) fills the panel on every colour: head to knees
    // left the person small with room around them (10-14), most photos ending above the knees. A photo on a
    // plain background is measured here (a full-length one's knees about 72% of the height down); a scene
    // photo by its `frame`.
    const box = c.photo.frame ? null : await subjectBox(c.photo.bytes);
    const at = c.photo.frame ?? (box && { top: box.y, knee: box.y + box.h * (box.cut ? 1 : 0.72), left: box.x, right: box.x + box.w });
    // A pair may run a little past the panel's sides (shoulders cut, never more than about 8% a side): shrinking
    // it to fit would leave the top empty. A plain background fills what the photo does not cover; a scene
    // photo is never smaller than the panel and is kept covering it.
    const cover = Math.max(panel.w / img.width, panel.h / img.height);
    let scale = cover, dx = panel.x + (panel.w - img.width * cover) / 2, dy = panel.y + (panel.h - img.height * cover) * 0.3;
    if (at) {
      scale = Math.min((panel.h * 0.95) / ((at.knee - at.top) * SKU_THIGH * img.height), panel.w * 1.16 / ((at.right - at.left) * img.width));
      if (!box) scale = Math.max(scale, cover);
      dx = panel.x + panel.w / 2 - ((at.left + at.right) / 2) * img.width * scale; dy = panel.y + panel.h * 0.05 - at.top * img.height * scale;
      if (!box) { dx = Math.min(panel.x, Math.max(panel.x + panel.w - img.width * scale, dx)); dy = Math.min(panel.y, Math.max(panel.y + panel.h - img.height * scale, dy)); }
      // A photo cut at the knees never ends above the panel's bottom: the cut would show.
      else if (box.cut) dy = Math.max(dy, panel.y + panel.h - img.height * scale);
    }
    const dw = img.width * scale, dh = img.height * scale;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.12)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 6;
    ctx.fillStyle = box?.bg ?? BG; roundRect(ctx, panel.x, panel.y, panel.w, panel.h, 26); ctx.fill(); ctx.restore();
    ctx.save(); roundRect(ctx, panel.x, panel.y, panel.w, panel.h, 26); ctx.clip();
    ctx.drawImage(img, dx, dy, dw, dh); ctx.restore();
  } else {
    const trimmed = await sharp(c.photo.bytes).trim({ threshold: 1 }).png().toBuffer();
    const img = await loadImage(trimmed), box = { x: 480, y: 70, w: 680, h: 1050 }, scale = Math.min(box.w / img.width, box.h / img.height);
    const dw = img.width * scale, dh = img.height * scale, dx = box.x + (box.w - dw) / 2, dy = box.y + box.h - dh;
    const shadow = ctx.createRadialGradient(dx + dw / 2, dy + dh, 10, dx + dw / 2, dy + dh, dw * 0.55);
    shadow.addColorStop(0, 'rgba(0,0,0,0.18)'); shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save(); ctx.translate(0, dy + dh); ctx.scale(1, 0.12); ctx.fillStyle = shadow; ctx.beginPath(); ctx.arc(dx + dw / 2, 0, dw * 0.55, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  // Left: logo, title, the three rows.
  const L = 60, W = 350;
  let y = 70;
  if (c.logo) {
    const logo = await asImage(c.logo), scale = Math.min(260 / logo.width, 110 / logo.height);
    ctx.drawImage(logo, L, y, logo.width * scale, logo.height * scale);
    y += logo.height * scale + 50;
  } else y += 40;
  ctx.textBaseline = 'alphabetic';
  // A heavy serif title under a small spaced English line (10-16: the black sans read as a sale sign).
  if (c.kicker) {
    ctx.fillStyle = '#8c8c8c'; ctx.font = `20px "${FONT.regular}"`; ctx.letterSpacing = '6px';
    ctx.fillText(c.kicker, L + 2, y + 6); ctx.letterSpacing = '0px'; y += 22;
  }
  ctx.fillStyle = INK;
  for (const t of c.title.slice(0, 2)) {
    ctx.letterSpacing = '4px'; fitText(ctx, t, FONT.serif, 64, W); ctx.fillText(t, L, y + 56); ctx.letterSpacing = '0px'; y += 82;
  }
  if (c.tag) {
    // Under the title, in place of its short bar.
    ctx.font = `30px "${FONT.heavy}"`;
    const w = Math.min(W, ctx.measureText(c.tag).width + 44);
    ctx.fillStyle = INK; roundRect(ctx, L, y + 2, w, 52, 26); ctx.fill();
    ctx.fillStyle = '#ffffff'; fitText(ctx, c.tag, FONT.heavy, 30, w - 44); ctx.fillText(c.tag, L + 22, y + 39);
    ctx.fillStyle = INK; y += 92;
  } else { ctx.fillRect(L, y + 10, 62, 6); y += 60; }
  // The rows share the room down to the card, at most 150 px apart.
  const card = { x: 38, y: 868, w: 390, h: 300 }, rows = c.rows.slice(0, 3);
  const room = (c.feature ? card.y - 20 : S - 60) - y, pitch = Math.min(150, room / Math.max(1, rows.length));
  y += (room - pitch * rows.length) / 2; // fewer rows sit in the middle of the room
  rows.forEach((row, i) => {
    const top = y + i * pitch;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.13)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(L + 40, top + 50, 42, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
    drawIcon(ctx, row.icon, L + 40, top + 50, 24, INK);
    ctx.fillStyle = '#2b2b2b'; fitText(ctx, row.label, FONT.bold, 21, W - 110); ctx.fillText(row.label, L + 110, top + 24);
    const value = layoutText(ctx, row.value, FONT.heavy, 38, 22, W - 110) ?? { size: 18, lines: [row.value] };
    ctx.fillStyle = INK; drawRuns(ctx, value.lines[0], FONT.heavy, value.size, L + 110, top + 68);
    const sub = row.sub ? layoutText(ctx, row.sub, FONT.regular, 19, 15, W - 110) : null;
    if (sub) { ctx.fillStyle = SOFT; drawRuns(ctx, sub.lines[0], FONT.regular, sub.size, L + 110, top + 100); }
    if (i < rows.length - 1) { ctx.fillStyle = '#c9c9c9'; ctx.fillRect(L - 8, top + pitch - 18, W + 10, 1.5); }
  });

  // Bottom left: the lead feature on this colour's fabric.
  if (!c.feature) return sharp(await canvas.encode('png')).jpeg({ quality: 92 }).toBuffer();
  const fabric = await sharp(c.fabric).resize(card.w * 2, card.h * 2, { fit: 'cover' }).png().toBuffer();
  const { channels } = await sharp(fabric).stats(), luma = 0.299 * channels[0].mean + 0.587 * channels[1].mean + 0.114 * channels[2].mean, light = luma > 150;
  ctx.save();
  roundRect(ctx, card.x, card.y, card.w, card.h, 20); ctx.clip();
  ctx.drawImage(await loadImage(fabric), card.x, card.y, card.w, card.h);
  const veil = ctx.createLinearGradient(card.x, card.y, card.x, card.y + card.h);
  veil.addColorStop(0, light ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.05)'); veil.addColorStop(1, light ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)');
  ctx.fillStyle = veil; ctx.fillRect(card.x, card.y, card.w, card.h);
  drawDrops(ctx, card.x, card.y, card.w, card.h, light);
  ctx.restore();
  const ink = light ? INK : '#ffffff';
  ctx.save(); ctx.strokeStyle = ink; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(card.x + 46, card.y + 22); ctx.lineTo(card.x + 70, card.y + 32); ctx.lineTo(card.x + 68, card.y + 56); ctx.lineTo(card.x + 46, card.y + 72); ctx.lineTo(card.x + 24, card.y + 56); ctx.lineTo(card.x + 22, card.y + 32); ctx.closePath(); ctx.stroke(); ctx.restore();
  drawIcon(ctx, iconFor(c.feature.title), card.x + 46, card.y + 47, 12, ink);
  // A two-line note lifts the title and the note one line, clear of the icons.
  const sub = c.feature.sub ? layoutText(ctx, c.feature.sub, FONT.regular, 20, 16, card.w - 50, 2) : null, lift = sub && sub.lines.length > 1 ? 22 : 0;
  const title = layoutText(ctx, c.feature.title, FONT.heavy, 40, 28, card.w - 50) ?? { size: 28, lines: [c.feature.title] };
  ctx.fillStyle = ink; drawRuns(ctx, title.lines[0], FONT.heavy, title.size, card.x + 24, card.y + 138 - lift);
  sub?.lines.forEach((line, k) => drawRuns(ctx, line, FONT.regular, sub.size, card.x + 24, card.y + 172 - lift + k * 24));
  // Fewer than three icons sit in the middle of the card.
  const icons = c.feature.icons.slice(0, 3), step = card.w / Math.max(3, icons.length), from = card.x + (card.w - step * icons.length) / 2;
  icons.forEach((it, k) => {
    const cx = from + step * (k + 0.5), cy = card.y + 222;
    ctx.save(); ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, 25, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
    drawIcon(ctx, it.icon, cx, cy, 14, ink);
    const label = layoutText(ctx, it.label, FONT.bold, 18, 15, step - 10, 2);
    ctx.fillStyle = ink;
    label?.lines.forEach((line, j) => drawRuns(ctx, line, FONT.bold, label.size, cx, cy + (label.lines.length > 1 ? 46 : 52) + j * 19, 'center'));
  });
  return sharp(await canvas.encode('png')).jpeg({ quality: 92 }).toBuffer();
}
