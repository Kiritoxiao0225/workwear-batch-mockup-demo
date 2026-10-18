/**
 * Output size of a generated artwork. The picture is always drawn at about one megapixel (1K);
 * 2K and 4K are that picture enlarged by the Volcengine upscaler and then scaled so its long edge
 * is exactly 2048 or 4096 px. Shared by the page (to show the size before starting) and the
 * production pipeline, so what is shown is what is delivered.
 */
export const OUTPUT_RATIOS = [
  ['original', '原比例'],
  ['1:1', '1:1'],
  ['3:4', '3:4'],
  ['4:3', '4:3'],
  ['2:3', '2:3'],
  ['3:2', '3:2'],
] as const;
export const OUTPUT_RESOLUTIONS = ['1K', '2K', '4K'] as const;
export type OutputRatio = (typeof OUTPUT_RATIOS)[number][0];
export type OutputResolution = (typeof OUTPUT_RESOLUTIONS)[number];
export type Size = { width: number; height: number };

const LONG_EDGE: Record<Exclude<OutputResolution, '1K'>, number> = { '2K': 2048, '4K': 4096 };
// The image model draws sides in multiples of 16 and nothing narrower than 3:1.
const STEP = 16, MAX_RATIO = 3, AREA_1K = 1024 * 1024;

/** Width ÷ height of a ratio choice; `original` follows the first reference image, if any. */
export function ratioValue(ratio: OutputRatio, reference?: Size | null): number | null {
  if (ratio === 'original') return reference && reference.width > 0 && reference.height > 0 ? reference.width / reference.height : null;
  const [w, h] = ratio.split(':').map(Number);
  return w / h;
}

/** The 1K drawing size for a width ÷ height: about one megapixel, sides in multiples of 16. */
export function drawSize(ratio: number): Size {
  const r = Math.min(MAX_RATIO, Math.max(1 / MAX_RATIO, ratio));
  const width = Math.sqrt(AREA_1K * r);
  return { width: Math.round(width / STEP) * STEP, height: Math.round(width / r / STEP) * STEP };
}

/**
 * A width ÷ height as the simplest "w:h" within 1% (1280×2272 → 9:16), clamped like the drawing.
 * The Codex relay ignores the requested size and follows the proportion written in the prompt.
 */
export function ratioLabel(ratio: number): string {
  const r = Math.min(MAX_RATIO, Math.max(1 / MAX_RATIO, ratio));
  let best = '1:1', bestOff = Infinity;
  for (let h = 1; h <= 32; h++) {
    const w = Math.max(1, Math.round(r * h)), off = Math.abs(Math.log(w / h / r));
    if (off <= 0.01) return `${w}:${h}`;
    if (off < bestOff) { best = `${w}:${h}`; bestOff = off; }
  }
  return best;
}

/**
 * Final size delivered, or null when the model chooses (原比例 with no reference image). 2K and 4K
 * keep the 1K drawing's proportions with the long edge at 2048 or 4096 px.
 */
export function outputSize(ratio: OutputRatio, resolution: OutputResolution, reference?: Size | null): Size | null {
  const value = ratioValue(ratio, reference);
  if (value === null) return null;
  const drawn = drawSize(value);
  if (resolution === '1K') return drawn;
  const scale = LONG_EDGE[resolution] / Math.max(drawn.width, drawn.height);
  return { width: Math.round(drawn.width * scale), height: Math.round(drawn.height * scale) };
}

/** How many 2× Volcengine passes a resolution needs before the final exact scaling. */
export const upscalePasses = (resolution: OutputResolution) => (resolution === '1K' ? 0 : resolution === '2K' ? 1 : 2);
