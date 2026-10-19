/**
 * The words of a point as they go on images: the material's own words, with what the suppliers' copy
 * gets wrong put right, and short enough for the place they go.
 */

/** How wide words are, in Chinese characters: Latin letters, figures and the unit marks are about half one. */
export const textUnits = (s: string) => [...s.trim()].reduce((n, ch) => n + (/[\x00-\x7f⁺₂²]/.test(ch) ? 0.55 : 1), 0);
const len = (s: string) => [...s.trim()].length;

/**
 * Typos the suppliers' copy carries and the material was copied with (10-18: 「轻试雨水」「易搭理」 on
 * SKU cards, 「放冷风侵入」 on a close-up). Only words that are wrong wherever they appear in clothing copy.
 */
export const TYPOS: [string, string][] = [
  ['轻试', '轻拭'], ['易搭理', '易打理'], ['好搭理', '好打理'], ['放冷风', '防冷风'], ['放泼水', '防泼水'], ['保媛', '保暖'], ['耐模', '耐磨'],
];

/** A field's own name written in front of its words (10-18: 「面料:100%聚酯纤维」 in the fabric row). */
const LEAD = /^(面料成分|面料|成分|材质|材料|版型|工艺|功能|特点|卖点)\s*[:：]\s*/;

/** A point's words with the typos put right and a field name in front taken off; `fixed` says what changed. */
export function cleanWords(text: string, lead = true): { text: string; fixed: string[] } {
  const fixed: string[] = [];
  let out = text.trim();
  if (lead && LEAD.test(out) && out.replace(LEAD, '').trim()) out = out.replace(LEAD, '').trim();
  for (const [wrong, right] of TYPOS) if (out.includes(wrong)) { out = out.split(wrong).join(right); fixed.push(`${wrong}→${right}`); }
  return { text: out, fixed };
}

/**
 * A point's short name for an icon or a tag (the analysis writes it, 10-19): at most six characters
 * wide (textUnits) taken from its words in order, nothing added (「可呼吸冲锋衣透气面料」 → 「透气面料」,
 * 「IP4.0防水层」 → 「IP4.0防水」). Empty when it is not one; a point that narrow is its own short name.
 */
export function shortName(short: string, text: string): string {
  const t = text.trim();
  if (textUnits(t) <= 6) return t;
  const s = [...cleanWords(short, false).text.replace(/\s+/g, '')];
  if (s.length < 2 || textUnits(s.join('')) > 6) return '';
  let k = 0;
  for (const ch of t) if (ch === s[k]) k++;
  return k === s.length ? s.join('') : '';
}

/** The two parts of a fact tag (「面料科技｜德国SUPER-TEX」): a short label over its word. */
export const FACT = { label: 6, word: 12 } as const;

/**
 * Words for a tag of at most `max` characters: the point's words when they fit, else its most telling
 * part that fits (one with a figure or a Latin name first: 「高防水透气膜 德国SUPER-TEX」 → 「德国SUPER-TEX」),
 * never a cut word; null when no part fits (10-19: a 16-character tag stopped 「开始出图」).
 */
export function conciseTag(text: string, max: number): string | null {
  const t = text.trim();
  if (len(t) <= max) return t || null;
  const parts = t.split(/[、，,；;：:\s/／|｜()（）]+/).map(x => x.trim()).filter(x => len(x) >= 2 && len(x) <= max);
  parts.sort((a, b) => Number(/[A-Za-z0-9%]/.test(b)) - Number(/[A-Za-z0-9%]/.test(a)) || len(b) - len(a));
  return parts[0] ?? null;
}

/** A tag fits its place: plain words at most `plain` characters; a fact by its two parts (FACT). */
export function tagFits(tag: string, plain: number) {
  const [label, word, ...more] = tag.split('｜');
  if (more.length) return false;
  return word === undefined ? len(label) >= 1 && len(label) <= plain : len(label) >= 1 && len(label) <= FACT.label && len(word) >= 1 && len(word) <= FACT.word;
}

/**
 * Big words in a box `width` percent wide: one line at the design's size, or a little smaller (down to
 * `keep` of it); words that would shrink more take two lines at about the design's size, broken between
 * words by the model, when `room` (the height in percent they may take) holds two lines. The user liked
 * 「石墨烯远红外蓄热纤维」 on two lines at 7 % better than on one line at 4 % (10-19).
 */
export function bigWords(text: string, width: number, max: number, room = Infinity, keep = 0.8): { size: number; lines: 1 | 2 } {
  const one = fitHeight(text, width, max);
  if (one >= max * keep) return { size: one, lines: 1 };
  // A break between words is seldom in the middle: a line may take about 60 % of the words.
  const two = Math.round(Math.min(max, (width * 0.95) / (textUnits(text) * 0.6)) * 10) / 10;
  return two > one && two * 2.3 <= room ? { size: two, lines: 2 } : { size: one, lines: 1 };
}
/** How the prompt says it: one line, or two broken between words. */
export const bigWordsLine = (b: { size: number; lines: 1 | 2 }) => b.lines === 2
  ? `太长就分两行写，在词与词之间断开、不把一个词拆到两行，每行字高约占画面 ${b.size}%`
  : `一行写完、不换行，字高约占画面 ${b.size}%`;

/**
 * How high words can be, in percent of the image, to fit a box `width` percent wide on one line: at
 * most `max` (the design's size), never under `min`. Long words get smaller rather than run out of
 * their box (10-19: the size came from the box's height alone).
 */
export function fitHeight(text: string, width: number, max: number, min = 1.6) {
  const fit = (width * 0.95) / Math.max(1, textUnits(text));
  return Math.round(Math.max(min, Math.min(max, fit)) * 10) / 10;
}
