/**
 * 电商主图 SKU images put together by the program (lib/server/listing-sku-card.ts draws them): what
 * they say and which picture each colour gets. The words come only from the material: a row it has
 * nothing for gives way to the next one, so nothing is made up.
 */
import { colorKeys, type Gender, type Point, type SkuPeople } from './draft';
import { itemPhoto, skuItems, type DraftVersion } from './sku-versions';
import { isComponent } from './garment-role';
import { textUnits } from './point-words';

export type SkuIcon = 'style' | 'fabric' | 'color' | 'water' | 'breathe' | 'wear' | 'wind' | 'warm' | 'light' | 'zip' | 'scene' | 'dot';
export type SkuRow = { label: string; value: string; sub: string; icon: SkuIcon };
export type SkuFeature = { title: string; sub: string; icons: { icon: SkuIcon; label: string }[] };
/** `kicker`: the small spaced English line over the title. */
export type SkuText = { kicker?: string; title: string[]; rows: SkuRow[]; feature: SkuFeature | null };

/** The icon that says a point best, by its words. */
export function iconFor(text: string): SkuIcon {
  const rules: [RegExp, SkuIcon][] = [[/防?水|泼|雨/, 'water'], [/透气|透湿|排汗|吸汗/, 'breathe'], [/耐磨|撕裂|抗|结实/, 'wear'], [/防风|挡风/, 'wind'],
    [/保暖|锁温|加绒|御寒|内胆/, 'warm'], [/轻/, 'light'], [/拉链/, 'zip'], [/面料|纤维|锦纶|涤纶|棉/, 'fabric'], [/户外|露营|登山|通勤|场景|工地|办公/, 'scene']];
  return rules.find(([re]) => re.test(text))?.[1] ?? 'dot';
}

const words = (s: string) => s.split(/[、，,；;\s/|]+/).map(x => x.trim()).filter(Boolean);
export { textUnits };
/**
 * The longest each place takes, in textUnits, at the smallest size the card prints it (listing-sku-card):
 * a row's big words, its small line, the card's title, an icon's words (two lines). Words that do not
 * fit give way to the next ones; they are never cut (10-18: 「可拆卸摇」「IP4.0防」「防水指数40」).
 */
export const SKU_FIT = { value: 9, sub: 16, title: 11, label: 12 } as const;
const fits = (s: string, max: number) => !!s.trim() && textUnits(s) <= max;
/** Down is the filling, not the fabric (10-18: 「纯净白鸭绒90%」 in the fabric row). */
const FILLING = /鸭绒|鹅绒|含绒|充绒|填充/;
/** Words about two colours meeting, only true of a two-colour colour (10-18: 「撞色设计剪裁」 on plain black). */
const TWO_TONE = /撞色|拼色/;

/** The colour row, the last row of every SKU image. */
export const colorRow = (name: string): SkuRow => ({ label: 'COLOR/颜色', value: name.trim(), sub: '经典配色 百搭耐看', icon: 'color' });

/**
 * What the left column of a SKU image can say (11-01, 店铺设置「SKU 图字段组合」): a shop saves named
 * combos of these, in the order they print, at most SKU_FIELD_MAX rows; a product uses the shop's
 * default one or picks another. The built-in 「自动」 (SKU_AUTO) is the rule from before: the first two
 * the material has of 货号, 面料, 版型, 工艺, 适用, then the colour.
 */
export const SKU_FIELDS = [['style', '货号'], ['fabric', '面料'], ['fit', '版型'], ['detail', '工艺'], ['scene', '适用场景'], ['color', '颜色']] as const;
export type SkuField = (typeof SKU_FIELDS)[number][0];
/** The fields with words of their own (the colour's are the colour's name). */
export type SkuWordField = Exclude<SkuField, 'color'>;
export type SkuWords = Partial<Record<SkuWordField, string>>;
export type SkuFieldSet = { id: string; name: string; fields: SkuField[] };
/** A shop's combos and the one new products use (SKU_AUTO when it saved none). */
export type SkuFieldSets = { sets: SkuFieldSet[]; default: string };
export const SKU_AUTO = 'auto';
export const SKU_AUTO_SET: SkuFieldSet = { id: SKU_AUTO, name: '自动', fields: [] };
export const DEFAULT_SKU_FIELDS: SkuFieldSets = { sets: [], default: SKU_AUTO };
export const SKU_FIELD_MAX = 3, SKU_SETS_MAX = 10, SKU_SET_NAME_MAX = 8, SKU_WORD_MAX = 12;
export const skuFieldName = (f: SkuField) => SKU_FIELDS.find(([id]) => id === f)![1];
/** The combo a product's SKU images use: its own pick while the shop still has it, else the shop's default, else 自动. */
export function skuSetOf(shop: SkuFieldSets | undefined, pick?: string): SkuFieldSet {
  const all = [SKU_AUTO_SET, ...(shop?.sets ?? [])];
  return all.find(x => x.id === pick) ?? all.find(x => x.id === shop?.default) ?? SKU_AUTO_SET;
}

/**
 * The style number (货号) at the front of a product's name, as the folder was named: 「8826款羽绒一体」,
 * 「6608#立领薄款」, 「LD1425-黑」, 「XHM24 卡车帽」. Before 11-01 only a number followed by 「#」 counted,
 * so 8826's SKU images lost the number the team picks goods by.
 */
export function styleNo(name: string): string | null {
  const m = /^\s*([A-Za-z]{0,4}\d[A-Za-z0-9-]{0,11})/.exec(name);
  return m ? m[1].replace(/-+$/, '') || null : null;
}

type CardInput = {
  name: string; category: string; points: (Pick<Point, 'text' | 'note' | 'type' | 'on' | 'source'> & { short?: string })[]; color?: string;
  /** Words typed on the plan (11-01), before the material's; 货号 before the name's. */
  words?: SkuWords;
  /** Worn over a liner or lined (有内胆, 一体): the fabric is the shell's, said so (11-01: 「100%聚酯纤维」 read as the liner's). */
  outer?: boolean;
};
/** Each field's row for a product, or null when neither the plan nor the material has words for it. */
export function fieldRows(input: CardInput): Record<SkuWordField, SkuRow | null> {
  const own = input.points.filter(p => p.source === '素材' && p.type !== '定位' && p.text.trim());
  type Own = (typeof own)[number];
  const all = (type: string, ok: (p: Own) => boolean = () => true) => [...own.filter(p => p.type === type && p.on && ok(p)), ...own.filter(p => p.type === type && !p.on && ok(p))];
  // A point too long for the row gives its first phrase, or its place to the next point.
  const row = (label: string, list: Own[], icon?: SkuIcon): SkuRow | null => {
    for (const p of list) {
      const value = fits(p.text, SKU_FIT.value) ? p.text.trim() : words(p.text).find((w, k) => k === 0 && fits(w, SKU_FIT.value));
      if (value) return { label, value, sub: fits(p.note, SKU_FIT.sub) ? p.note.trim() : '', icon: icon ?? iconFor(p.text) };
    }
    return null;
  };
  const twoTone = !input.color || /拼|撞/.test(input.color);
  const typed = (f: SkuWordField, label: string, icon: SkuIcon) => { const v = input.words?.[f]?.trim(); return v ? { label, value: v, sub: '', icon } : null; };
  const style = styleNo(input.name), fabric = input.outer ? 'FABRIC/外层面料' : 'FABRIC/面料';
  return {
    style: typed('style', 'STYLE NO./货号', 'style') ?? (style ? { label: 'STYLE NO./货号', value: style, sub: '', icon: 'style' } : null),
    fabric: typed('fabric', fabric, 'fabric') ?? row(fabric, all('面料', p => !FILLING.test(p.text)), 'fabric'),
    fit: typed('fit', 'FIT/版型', 'style') ?? row('FIT/版型', all('颜色款式', p => twoTone || !TWO_TONE.test(p.text)), 'style'),
    detail: typed('detail', 'DETAIL/工艺', 'dot') ?? row('DETAIL/工艺', all('做工')),
    scene: typed('scene', 'SCENE/适用', 'scene') ?? row('SCENE/适用', all('人群场景'), 'scene'),
  };
}

/**
 * The rows of a SKU image's left column, in print order, the colour's (`color`, with its version's line
 * under it) included: the combo's fields that have words (a field with none is left out, never made up),
 * or with 自动 the first two the product has, then the colour.
 */
export function skuCardRows(input: CardInput, set: SkuFieldSet, color: SkuRow): SkuRow[] {
  const rows = fieldRows(input);
  if (!set.fields.length) return [...skuCardText(input).rows, color];
  return set.fields.slice(0, SKU_FIELD_MAX).map(f => f === 'color' ? color : rows[f]).filter((r): r is SkuRow => !!r);
}

/** The word fields a combo prints for a product, in order (with 自动 the two the product has), for the plan page to show and edit. */
export function skuFieldsUsed(input: CardInput, set: SkuFieldSet): SkuWordField[] {
  if (set.fields.length) return set.fields.filter((f): f is SkuWordField => f !== 'color');
  const rows = fieldRows(input);
  return (['style', 'fabric', 'fit', 'detail', 'scene'] as const).filter(f => rows[f]).slice(0, 2);
}

/**
 * The words of a product's SKU images. 自动's two rows above the colour, the first the product has of:
 * 货号 (styleNo), fabric, fit, workmanship, where it is worn. The card: the first function point, split
 * into a short title and up to three icons.
 */
export function skuCardText(input: CardInput): SkuText {
  const own = input.points.filter(p => p.source === '素材' && p.type !== '定位' && p.text.trim());
  type Own = (typeof own)[number];
  const all = (type: string, ok: (p: Own) => boolean = () => true) => [...own.filter(p => p.type === type && p.on && ok(p)), ...own.filter(p => p.type === type && !p.on && ok(p))];
  const f = fieldRows(input);
  const rows = [f.style, f.fabric, f.fit, f.detail, f.scene].filter((r): r is SkuRow => !!r).slice(0, 2);

  const functions = all('功能');
  const lead = functions[0];
  let feature: SkuFeature | null = null;
  if (lead) {
    const parts = words(lead.text);
    // An icon's words name a point: a bare figure (「40000+」) is not one.
    // Another point's icon says its short name (2–6 characters, 10-19) when the analysis gave one, else its first words.
    const labels = [...new Set([...(parts.length > 1 ? parts : []), ...functions.slice(1).map(p => p.short || words(p.text)[0])].filter(x => x && fits(x, SKU_FIT.label) && /[\u4e00-\u9fff]/.test(x)))].slice(0, 3);
    const title = [parts.length > 1 ? parts[0] + parts[1] : '', lead.text, parts[0]].find(t => t && fits(t, parts.length > 1 && t === parts[0] + parts[1] ? 8 : SKU_FIT.title));
    feature = title ? {
      title: title.trim(),
      sub: lead.note || (parts.length > 2 ? parts.slice(2).join(' ') : ''),
      icons: labels.map(label => ({ icon: iconFor(label), label })),
    } : null;
  }
  const workwear = input.category === 'workwear';
  return { kicker: workwear ? 'PREMIUM CUSTOM' : 'PREMIUM QUALITY', title: workwear ? ['高端定制', '支持印绣'] : ['品质做工', '舒适百搭'], rows, feature };
}

/**
 * The material's own photo of a model wearing a colour, for its SKU image: a photo with a person in
 * it, of that colour (by the colour the AI read on the colour's chosen image, so a renamed colour still
 * finds them). The SKU image has the cover's people: a man and a woman together first for a pair
 * (`pair`), else one person (the lead's gender before the other); a clear face counts. None: the
 * cast's models are drawn in that colour (lib/server/listing-generation.ts).
 */
export function modelPhotoFor(images: { id: string; kind: string; color: string; same?: string; person?: string; face?: boolean; facing?: string; role?: string; detail?: string }[], pick: string, name: string, lead?: '男' | '女', pair = false) {
  const color = images.find(i => i.id === pick)?.color || name;
  const single = (p?: string) => p === '男' || p === '女';
  // A photo facing the camera shows both sleeves (10-18: a model turned away hid the badge).
  const rank = (i: (typeof images)[number]) => (pair
    ? (i.person === '男女' ? 4 : i.person === '多人' ? 2 : 1)
    : (i.person === lead ? 4 : single(i.person) ? 2 : 1)) + (i.face ? 1 : 0) + (i.facing === '正对' ? 0.6 : i.facing === '微侧' ? 0.3 : 0);
  return images.filter(i => i.kind === '模特实拍' && !!i.person && !i.same && !isComponent(i) && (i.color === color || i.color === name)).sort((a, b) => rank(b) - rank(a))[0]?.id ?? null;
}

/** Each colour's own model photo, by the colour's key (colorKeys); colours without one are left out, and all of them when the plan draws the models. */
export function skuPhotos(d: { colors: { name: string; pick: string | null }[]; model: { lead: '男' | '女' }; skuPeople?: SkuPeople; versions?: DraftVersion[] }, images: Parameters<typeof modelPhotoFor>[0], pair: boolean): Record<string, string> {
  if (d.skuPeople && d.skuPeople !== '实拍') return {};
  const keys = colorKeys(d.colors);
  // By version (10-22): each SKU image's own photo, the shell alone, over its liner, or the liner alone.
  if (d.versions?.some(v => v.on)) {
    const items = skuItems(d, d.colors.flatMap((c, k) => keys[k] ? [{ name: c.name, sku: keys[k]! }] : []));
    return Object.fromEntries(items.flatMap(it => { const label = itemPhoto(images, it, d.model.lead, pair); return label ? [[it.key, label]] : []; }));
  }
  return Object.fromEntries(d.colors.flatMap((c, k) => { const label = c.pick ? modelPhotoFor(images, c.pick, c.name, d.model.lead, pair) : null; return label ? [[keys[k]!, label]] : []; }));
}

/** Who a drawn SKU model is: the plan's choice, else the cover's people (a man and a woman when it has two, else the lead). */
export const skuWho = (d: { model: { lead: Gender }; skuPeople?: SkuPeople }, pair: boolean): Gender | '男女' =>
  d.skuPeople && d.skuPeople !== '实拍' ? d.skuPeople : pair ? '男女' : d.model.lead;
