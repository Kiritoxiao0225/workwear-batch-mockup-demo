// Logo against garment color, from 效果图制作与质量标准 V1.0 §5 配色原则. A logo that the
// garment swallows is shown in one SOP color per garment color and position; the artwork is
// never regenerated for this, only its pixels are recolored with the alpha left untouched.
export const LOGO_COLOR_POLICY = 'sop-color-v1';

export type Rgb = readonly [number, number, number];
export type LogoInk = { color: string; label: string };

// Below 2:1 the logo merges into the cloth (深蓝黑 on 理想绿 measures 1.9, black 1.8), while the
// SOP's own approved 浅灰衣配金标 measures about 2.05. A color we pick ourselves aims for 3:1.
export const MIN_CONTRAST = 2;
export const TARGET_CONTRAST = 3;
// A logo whose edges are this often another logo color, rather than the garment, depends on
// those inner color changes (a white 字 on a red seal); one flat color would erase them.
export const MAX_INNER_EDGES = .25;

export const SOP_INKS = {
  white: { color: '#ffffff', label: '白色' },
  gold: { color: '#c8a45a', label: '金色' },
  silver: { color: '#bfc3c7', label: '银色' },
  black: { color: '#1a1a1a', label: '黑色' },
  navy: { color: '#1f2a44', label: '藏蓝' },
} satisfies Record<string, LogoInk>;

const linear = (v: number) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]: Rgb) => .2126 * linear(r) + .7152 * linear(g) + .0722 * linear(b);
export function contrastRatio(a: Rgb, b: Rgb) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
/** CIE L*, 0 (black) to 100 (white). */
export function lightness(rgb: Rgb) { const y = luminance(rgb); return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : y * 24389 / 27; }
function hueSaturation([r, g, b]: Rgb) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) { h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return { h, s: max ? d / max : 0 };
}
/** SOP 3.1 大红配大绿: both saturated and far apart in hue. */
export function saturatedClash(a: Rgb, b: Rgb) {
  const x = hueSaturation(a), y = hueSaturation(b), d = Math.abs(x.h - y.h);
  return x.s >= .55 && y.s >= .55 && Math.min(d, 360 - d) >= 100;
}
export const toHex = (rgb: Rgb) => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
export const fromHex = (color: string): Rgb => {
  if (!/^#[0-9a-f]{6}$/iu.test(color)) throw new Error('颜色无效');
  return [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
};

/** A garment's colors besides the body: the swatches after the largest that cover at least 3% of it (collar, cuffs, panels). */
export const garmentAccents = (palette: LogoColorAnalysis | null) => palette ? palette.swatches.slice(1).filter(s => s.share >= .03).map(s => s.rgb) : [];

export type LogoSwatch = { rgb: Rgb; share: number; edgeShare: number };
export type LogoColorAnalysis = { swatches: LogoSwatch[]; innerEdges: number };

/**
 * Colors of the opaque logo pixels. `share` is the area; `edgeShare` counts only pixels within
 * 2 px of the garment, which is what decides whether the outline reads. `innerEdges` is the
 * share of logo edges that are a strong lightness change between two logo colors.
 */
export function analyzeLogoColors(data: ArrayLike<number>, width: number, height: number): LogoColorAnalysis | null {
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3] >= 128;
  const light = new Float32Array(width * height);
  for (let p = 0; p < width * height; p++) light[p] = lightness([data[p * 4], data[p * 4 + 1], data[p * 4 + 2]]);
  const buckets = new Map<number, { n: number; e: number; r: number; g: number; b: number }>();
  let total = 0, edges = 0, outer = 0, inner = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!opaque(x, y)) continue;
    const p = y * width + x, i = p * 4;
    const nearGarment = [1, 2].some(d => !opaque(x - d, y) || !opaque(x + d, y) || !opaque(x, y - d) || !opaque(x, y + d));
    const key = (data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | data[i + 2] >> 4;
    const bucket = buckets.get(key) ?? { n: 0, e: 0, r: 0, g: 0, b: 0 };
    bucket.n++; bucket.r += data[i]; bucket.g += data[i + 1]; bucket.b += data[i + 2]; if (nearGarment) { bucket.e++; edges++; }
    buckets.set(key, bucket); total++;
    // Compared 2 px apart so an anti-aliased step still counts as one edge.
    if (!opaque(x - 1, y) || !opaque(x + 1, y) || !opaque(x, y - 1) || !opaque(x, y + 1)) outer++;
    else if ((opaque(x + 2, y) && Math.abs(light[p] - light[p + 2]) >= 30) || (opaque(x, y + 2) && Math.abs(light[p] - light[p + 2 * width]) >= 30)) inner++;
  }
  if (!total) return null;
  const swatches: { n: number; e: number; rgb: [number, number, number] }[] = [];
  for (const b of [...buckets.values()].sort((a, c) => c.n - a.n)) {
    const rgb: [number, number, number] = [b.r / b.n, b.g / b.n, b.b / b.n];
    const near = swatches.map(s => ({ s, d: Math.hypot(s.rgb[0] - rgb[0], s.rgb[1] - rgb[1], s.rgb[2] - rgb[2]) })).sort((a, c) => a.d - c.d)[0];
    if (near && (near.d < 40 || swatches.length >= 8)) {
      const n = near.s.n + b.n;
      near.s.rgb = near.s.rgb.map((v, k) => (v * near.s.n + rgb[k] * b.n) / n) as [number, number, number];
      near.s.n = n; near.s.e += b.e;
    } else swatches.push({ n: b.n, e: b.e, rgb });
  }
  return {
    swatches: swatches.map(s => ({ rgb: s.rgb, share: s.n / total, edgeShare: edges ? s.e / edges : 0 })).sort((a, b) => b.share - a.share),
    innerEdges: outer + inner ? inner / (outer + inner) : 0,
  };
}

export type LogoColorVerdict = { ok: boolean; reason: 'contrast' | 'clash' | null; contrast: number };
/** Fails when more than a quarter of the outline is under 2:1, or most of the logo clashes with the garment. */
export function judgeLogoColors(analysis: LogoColorAnalysis, garment: Rgb): LogoColorVerdict {
  const unreadable = analysis.swatches.reduce((sum, s) => sum + (contrastRatio(s.rgb, garment) < MIN_CONTRAST ? s.edgeShare : 0), 0);
  const clash = analysis.swatches.reduce((sum, s) => sum + (saturatedClash(s.rgb, garment) ? s.share : 0), 0);
  const main = analysis.swatches.reduce((best, s) => s.edgeShare > best.edgeShare ? s : best);
  const contrast = contrastRatio(main.rgb, garment);
  if (unreadable > .25) return { ok: false, reason: 'contrast', contrast };
  if (clash > .5) return { ok: false, reason: 'clash', contrast };
  return { ok: true, reason: null, contrast };
}

/**
 * SOP 5 1.2: on a two-tone garment the logo first takes the garment's own other colors, most area
 * first. Then 1.1: dark garments take a light logo (its own light color, then white, gold, silver),
 * light garments a dark one (its own brand color, then black, navy). The first that reaches 3:1
 * without a saturated clash wins; otherwise the highest contrast.
 */
export function recommendLogoColor(analysis: LogoColorAnalysis, garment: Rgb, accents: readonly Rgb[] = []): LogoInk & { contrast: number } {
  const l = lightness(garment);
  const own = analysis.swatches.filter(s => s.share >= .1).map(s => ({ color: toHex(s.rgb), label: '图稿原有色', l: lightness(s.rgb) }));
  const standard = l < 45 ? [SOP_INKS.white, SOP_INKS.gold, SOP_INKS.silver] : l > 70 ? [SOP_INKS.black, SOP_INKS.navy]
    : [SOP_INKS.white, SOP_INKS.black].sort((a, b) => contrastRatio(fromHex(b.color), garment) - contrastRatio(fromHex(a.color), garment));
  const candidates = [...accents.map(a => ({ color: toHex(a), label: '衣服撞色' })), ...own.filter(o => l < 45 ? o.l > l : l > 70 ? o.l < l : true), ...standard]
    .map(c => ({ color: c.color, label: c.label, contrast: contrastRatio(fromHex(c.color), garment), clash: saturatedClash(fromHex(c.color), garment) }));
  const chosen = candidates.find(c => c.contrast >= TARGET_CONTRAST && !c.clash) ?? candidates.reduce((a, b) => b.contrast > a.contrast ? b : a);
  return { color: chosen.color, label: chosen.label, contrast: chosen.contrast };
}

const COLOR_WORD = /#[0-9a-f]{6}|[白黑红橙橘桔黄绿青蓝紫粉灰棕咖金银]/iu;
const KEEPS_ORIGINAL = /沿用|保持|保留|原有|原来|原始|原图|原色|原配色|不改|包括|包含|其中/u;
/**
 * Whether the artwork text fixes the logo colors. The requirement model often spells out the
 * original colors ("沿用图2原有配色，包括酒红色、绿色…"); a clause naming a color only counts as the
 * customer's when it neither keeps colors nor points at the artwork's own subject image. Any change or
 * explicit requirement wording fixes the colors, a 参考 clause does unless it keeps the subject images'
 * own colors, and so does a missing 颜色 item.
 */
export function promptFixesLogoColor(prompt: string | undefined) {
  const item = prompt?.match(/^颜色：([^]*?)(?=^(?:主体|文字|字体|排版|尺寸|输出)：|(?![^]))/mu)?.[1]?.trim();
  if (!item) return true;
  const open = item.replace(/原需求未指定[^，,。；;\n]*|未指定|没有指定|未要求|不限/gu, '');
  if (/改为|改成|换成|换为|做成|统一|指定|要求/u.test(open)) return true;
  const images = (text: string) => [...text.matchAll(/图\s*(\d+)/gu)].map(m => m[1]);
  const subject = new Set(images(prompt!.match(/^主体：([^]*?)^文字：/mu)?.[1] ?? ''));
  const clauses = open.split(/[，,。；;\n]/u);
  // "参考图3的深蓝" or "参考图2" borrows a colour from elsewhere; "参考图1与图2的原有配色" for an artwork
  // made from 图1 and 图2 only keeps its own colours (W70bcd6a10902 lost its white chest logo to this).
  if (clauses.some(clause => /参考/u.test(clause) && (!KEEPS_ORIGINAL.test(clause) || images(clause).some(n => !subject.has(n))))) return true;
  return clauses.some(clause => COLOR_WORD.test(clause) && !KEEPS_ORIGINAL.test(clause) && !images(clause).some(n => subject.has(n)));
}

/**
 * Whether the customer's own words name a colour at all, garment colours aside. The requirement model
 * writes a 颜色 line for every artwork and often describes the reference ("文字使用白色，参考图1和图2的
 * 白色标识") when the customer said nothing; Wc24f3e5c74eb's right chest stayed white on sky blue for it.
 */
export function sourceMentionsColor(source: string | undefined, garmentColors: string[]) {
  let text = String(source ?? '');
  for (const name of [...new Set(garmentColors.filter(Boolean))].sort((a, b) => b.length - a.length)) text = text.split(name).join('');
  return COLOR_WORD.test(text);
}

export type LogoColorDecision = {
  color: string | null;
  source: 'original' | 'auto' | 'manual';
  verdict: LogoColorVerdict;
  recommendation: LogoInk & { contrast: number };
  blocked: 'customer' | 'inner-detail' | null;
};
/**
 * A failing logo takes the recommendation, except when a designer already set its color in the
 * artwork editor, the customer fixed its colors, or one flat color would erase inner detail.
 */
export function decideLogoColor(analysis: LogoColorAnalysis, garment: Rgb, { setByDesigner = false, fixedByCustomer = false, accents = [] as readonly Rgb[] } = {}): LogoColorDecision {
  const verdict = judgeLogoColors(analysis, garment), recommendation = recommendLogoColor(analysis, garment, accents);
  const base = { verdict, recommendation, color: null, source: setByDesigner ? 'manual' as const : 'original' as const };
  if (verdict.ok || setByDesigner) return { ...base, blocked: null };
  const blocked = fixedByCustomer ? 'customer' : analysis.innerEdges > MAX_INNER_EDGES ? 'inner-detail' : null;
  return blocked ? { ...base, blocked } : { ...base, blocked: null, color: recommendation.color, source: 'auto' };
}
