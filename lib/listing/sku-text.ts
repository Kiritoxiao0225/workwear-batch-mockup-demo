/**
 * 「改 SKU 图文字」 (11-01): every word the program prints on a SKU image (the model photo on the right
 * is the only drawn part) can be written by hand, for the whole product at once or for one image.
 * An edit is the whole set of words, not a patch: the form starts from what the image says now.
 * Whole-product edits keep the colour row following each image's own colour unless it is unticked.
 */
import { iconFor, SKU_FIT, textUnits, type SkuFeature, type SkuIcon, type SkuRow } from './sku-card';

export type SkuTextRow = { label: string; value: string; sub: string;
  /** The colour row on a whole-product edit: each image's own colour name and line under it. */
  color?: boolean };
export type SkuTextEdit = {
  /** The dark pill (男女同款…) where the image has it: under the title, or in a corner. '' none. */
  badge: string;
  kicker: string; title: [string, string];
  /** The name across the liner's picture; only on images that have one. */
  liner: string;
  rows: SkuTextRow[];
  /** The card at the bottom; an empty title: no card. */
  feature: { title: string; sub: string; icons: string[] };
};
/** `all`: the whole product's words; `one`: an image's own (by its item key), before the whole product's. */
export type SkuEdits = { all?: SkuTextEdit; one?: Record<string, SkuTextEdit> };
export const SKU_TEXT_ROWS = 3, SKU_TEXT_ICONS = 3;

/** The longest each place takes, in textUnits (the card prints it smaller up to there, then it does not fit). */
export const SKU_TEXT_MAX = { badge: 8, kicker: 24, title: 6, liner: 8, label: 12, value: SKU_FIT.value, sub: SKU_FIT.sub, featureTitle: SKU_FIT.title, featureSub: 36, icon: SKU_FIT.label } as const;

/** Where a word is too long for its place, said the way the form names it; empty when all fit. */
export function skuTextProblems(e: SkuTextEdit): { where: string; max: number }[] {
  const out: { where: string; max: number }[] = [];
  const check = (text: string, max: number, where: string) => { if (textUnits(text.trim()) > max) out.push({ where, max }); };
  check(e.badge, SKU_TEXT_MAX.badge, '角标'); check(e.kicker, SKU_TEXT_MAX.kicker, '英文小字');
  e.title.forEach((t, i) => check(t, SKU_TEXT_MAX.title, `标题第 ${i + 1} 行`));
  check(e.liner, SKU_TEXT_MAX.liner, '内胆小图的名字');
  e.rows.forEach((r, i) => {
    check(r.label, SKU_TEXT_MAX.label, `第 ${i + 1} 行的小字`); if (!r.color) check(r.value, SKU_TEXT_MAX.value, `第 ${i + 1} 行的大字`);
    if (!r.color) check(r.sub, SKU_TEXT_MAX.sub, `第 ${i + 1} 行的说明`);
  });
  check(e.feature.title, SKU_TEXT_MAX.featureTitle, '卖点卡片标题'); check(e.feature.sub, SKU_TEXT_MAX.featureSub, '卖点卡片小字');
  e.feature.icons.forEach((t, i) => check(t, SKU_TEXT_MAX.icon, `图标 ${i + 1} 的字`));
  return out;
}

/** A row's icon by its words: the field it names, else what the words are about. */
export function rowIcon(label: string, value: string): SkuIcon {
  const rules: [RegExp, SkuIcon][] = [[/颜色|COLOR/i, 'color'], [/货号|款号|型号|STYLE|FIT|版型|款式/i, 'style'], [/面料|FABRIC|材质/i, 'fabric'], [/适用|场景|SCENE/i, 'scene']];
  return rules.find(([re]) => re.test(label))?.[1] ?? iconFor(`${label} ${value}`);
}

/** The words a SKU image prints, as the card is drawn from them (listing-sku-card renderSkuCard). */
export type CardWords = {
  kicker?: string; title: string[]; rows: SkuRow[]; feature: SkuFeature | null;
  /** The pill and where it is: under the title (`title`), or a corner; null none. */
  pill: { text: string; place: 'title' | 'corner' | 'right' } | null;
  linerName?: string;
  /** The image's colour row, for a row marked to follow the colour on a scheme that prints none. */
  colorRow?: SkuRow;
};

/** The form's words from an image's own (the colour row marked when `colorRow` is that row). */
export function editOf(w: CardWords): SkuTextEdit {
  return {
    badge: w.pill?.text ?? '', kicker: w.kicker ?? '', title: [w.title[0] ?? '', w.title[1] ?? ''], liner: w.linerName ?? '',
    rows: w.rows.slice(0, SKU_TEXT_ROWS).map(r => ({ label: r.label, value: r.value, sub: r.sub, ...(r.icon === 'color' ? { color: true } : {}) })),
    feature: { title: w.feature?.title ?? '', sub: w.feature?.sub ?? '', icons: (w.feature?.icons ?? []).map(i => i.label).slice(0, SKU_TEXT_ICONS) },
  };
}

/**
 * An image's words with an edit on them. `own`: the image's words as the plan gives them, which keep
 * the colour row's (`color`) and where the pill goes; `pillPlace`: where a pill goes when the image had
 * none (the caller's: the shop's corner, else under the title, else top right when a liner's box is there).
 */
export function applyEdit(own: CardWords, e: SkuTextEdit, pillPlace: 'title' | 'corner' | 'right'): CardWords {
  const color = own.rows.find(r => r.icon === 'color') ?? own.colorRow;
  const rows = e.rows.slice(0, SKU_TEXT_ROWS).flatMap((r): SkuRow[] => {
    if (r.color) return color ? [{ ...color, label: r.label.trim() || color.label }] : [];
    const value = r.value.trim();
    return value ? [{ label: r.label.trim(), value, sub: r.sub.trim(), icon: rowIcon(r.label, value) }] : [];
  });
  const title = e.title.map(t => t.trim()).filter(Boolean);
  const badge = e.badge.trim(), place = own.pill?.place ?? pillPlace;
  const icons = e.feature.icons.map(t => t.trim()).filter(Boolean).slice(0, SKU_TEXT_ICONS).map(label => ({ icon: iconFor(label), label }));
  return {
    kicker: e.kicker.trim() || undefined, title, rows,
    feature: e.feature.title.trim() ? { title: e.feature.title.trim(), sub: e.feature.sub.trim(), icons } : null,
    pill: badge ? { text: badge, place } : null,
    ...(own.linerName !== undefined ? { linerName: e.liner.trim() } : {}),
  };
}

/** The edit an image prints with: its own, else the whole product's; none when neither was made. */
export const editFor = (edits: SkuEdits | undefined, key: string) => edits?.one?.[key] ?? edits?.all;
