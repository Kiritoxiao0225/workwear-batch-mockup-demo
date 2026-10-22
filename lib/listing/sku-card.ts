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
 * The words of a product's SKU images. Two rows above the colour, the first the material has of:
 * style number (the part of the product's name before 「#」), fabric, fit, workmanship, where it is
 * worn. The card: the first function point, split into a short title and up to three icons.
 */
export function skuCardText(input: { name: string; category: string; points: (Pick<Point, 'text' | 'note' | 'type' | 'on' | 'source'> & { short?: string })[]; color?: string }): SkuText {
  const own = input.points.filter(p => p.source === '素材' && p.type !== '定位' && p.text.trim());
  type Own = (typeof own)[number];
  const all = (type: string, ok: (p: Own) => boolean = () => true) => [...own.filter(p => p.type === type && p.on && ok(p)), ...own.filter(p => p.type === type && !p.on && ok(p))];
  const style = /^\s*([A-Za-z0-9][A-Za-z0-9-]{0,11})\s*#/.exec(input.name)?.[1];
  // A point too long for the row gives its first phrase, or its place to the next point.
  const row = (label: string, list: Own[], icon?: SkuIcon): SkuRow | null => {
    for (const p of list) {
      const value = fits(p.text, SKU_FIT.value) ? p.text.trim() : words(p.text).find((w, k) => k === 0 && fits(w, SKU_FIT.value));
      if (value) return { label, value, sub: fits(p.note, SKU_FIT.sub) ? p.note.trim() : '', icon: icon ?? iconFor(p.text) };
    }
    return null;
  };
  const twoTone = !input.color || /拼|撞/.test(input.color);
  const rows = [
    style ? { label: 'STYLE NO./款号', value: style, sub: '', icon: 'style' as const } : null,
    row('FABRIC/面料', all('面料', p => !FILLING.test(p.text)), 'fabric'), row('FIT/版型', all('颜色款式', p => twoTone || !TWO_TONE.test(p.text)), 'style'),
    row('DETAIL/工艺', all('做工')), row('SCENE/适用', all('人群场景'), 'scene'),
  ].filter((r): r is SkuRow => !!r).slice(0, 2);

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
