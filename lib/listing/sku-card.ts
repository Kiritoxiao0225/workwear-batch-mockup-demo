/**
 * 电商主图 SKU images put together by the program (lib/server/listing-sku-card.ts draws them): what
 * they say and which picture each colour gets. The words come only from the material: a row it has
 * nothing for gives way to the next one, so nothing is made up.
 */
import type { Point } from './draft';

export type SkuIcon = 'style' | 'fabric' | 'color' | 'water' | 'breathe' | 'wear' | 'wind' | 'warm' | 'light' | 'zip' | 'scene' | 'dot';
export type SkuRow = { label: string; value: string; sub: string; icon: SkuIcon };
export type SkuFeature = { title: string; sub: string; icons: { icon: SkuIcon; label: string }[] };
export type SkuText = { title: string[]; rows: SkuRow[]; feature: SkuFeature | null };

/** The icon that says a point best, by its words. */
export function iconFor(text: string): SkuIcon {
  const rules: [RegExp, SkuIcon][] = [[/防?水|泼|雨/, 'water'], [/透气|透湿|排汗|吸汗/, 'breathe'], [/耐磨|撕裂|抗|结实/, 'wear'], [/防风|挡风/, 'wind'],
    [/保暖|锁温|加绒|御寒|内胆/, 'warm'], [/轻/, 'light'], [/拉链/, 'zip'], [/面料|纤维|锦纶|涤纶|棉/, 'fabric'], [/户外|露营|登山|通勤|场景|工地|办公/, 'scene']];
  return rules.find(([re]) => re.test(text))?.[1] ?? 'dot';
}

const cut = (s: string, n: number) => [...s.trim()].slice(0, n).join('');
const words = (s: string) => s.split(/[、，,；;\s/|]+/).map(x => x.trim()).filter(Boolean);

/** The colour row, the last row of every SKU image. */
export const colorRow = (name: string): SkuRow => ({ label: 'COLOR/颜色', value: cut(name, 10), sub: '经典配色 百搭耐看', icon: 'color' });

/**
 * The words of a product's SKU images. Two rows above the colour, the first the material has of:
 * style number (the part of the product's name before 「#」), fabric, fit, workmanship, where it is
 * worn. The card: the first function point, split into a short title and up to three icons.
 */
export function skuCardText(input: { name: string; category: string; points: Pick<Point, 'text' | 'note' | 'type' | 'on' | 'source'>[] }): SkuText {
  const own = input.points.filter(p => p.source === '素材' && p.type !== '定位' && p.text.trim());
  const first = (type: string) => own.find(p => p.type === type && p.on) ?? own.find(p => p.type === type);
  const style = /^\s*([A-Za-z0-9][A-Za-z0-9-]{0,11})\s*#/.exec(input.name)?.[1];
  const row = (label: string, p: (typeof own)[number] | undefined, icon?: SkuIcon): SkuRow | null =>
    p ? { label, value: cut(p.text, 12), sub: cut(p.note, 14), icon: icon ?? iconFor(p.text) } : null;
  const rows = [
    style ? { label: 'STYLE NO./款号', value: style, sub: '', icon: 'style' as const } : null,
    row('FABRIC/面料', first('面料'), 'fabric'), row('FIT/版型', first('颜色款式'), 'style'),
    row('DETAIL/工艺', first('做工')), row('SCENE/适用', first('人群场景'), 'scene'),
  ].filter((r): r is SkuRow => !!r).slice(0, 2);

  const functions = [...own.filter(p => p.type === '功能' && p.on), ...own.filter(p => p.type === '功能' && !p.on)];
  const lead = functions[0];
  let feature: SkuFeature | null = null;
  if (lead) {
    const parts = words(lead.text);
    const labels = [...new Set([...(parts.length > 1 ? parts : []), ...functions.slice(1).map(p => words(p.text)[0])].map(x => cut(x, 4)).filter(Boolean))].slice(0, 3);
    feature = {
      title: parts.length > 1 ? cut(parts[0] + parts[1], 6) : cut(lead.text, 6),
      sub: cut(lead.note || (parts.length > 2 ? parts.slice(2).join(' ') : ''), 14),
      icons: labels.map(label => ({ icon: iconFor(label), label })),
    };
  }
  return { title: input.category === 'workwear' ? ['高端定制', '支持印绣'] : ['品质做工', '舒适百搭'], rows, feature };
}

/**
 * The material's own photo of a model wearing a colour, for its SKU image: a photo with a person in
 * it, of that colour (by the colour the AI read on the colour's chosen image, so a renamed colour still
 * finds them). The SKU image has the cover's people: a man and a woman together first for a pair
 * (`pair`), else one person (the lead's gender before the other); a clear face counts. None: the
 * cast's models are drawn in that colour (lib/server/listing-generation.ts).
 */
export function modelPhotoFor(images: { id: string; kind: string; color: string; same?: string; person?: string; face?: boolean }[], pick: string, name: string, lead?: '男' | '女', pair = false) {
  const color = images.find(i => i.id === pick)?.color || name;
  const single = (p?: string) => p === '男' || p === '女';
  const rank = (i: (typeof images)[number]) => (pair
    ? (i.person === '男女' ? 4 : i.person === '多人' ? 2 : 1)
    : (i.person === lead ? 4 : single(i.person) ? 2 : 1)) + (i.face ? 1 : 0);
  return images.filter(i => i.kind === '模特实拍' && !!i.person && !i.same && (i.color === color || i.color === name)).sort((a, b) => rank(b) - rank(a))[0]?.id ?? null;
}

/** Each colour's own model photo, by the colour's image label; colours without one are left out. */
export function skuPhotos(d: { colors: { name: string; pick: string | null }[]; model: { lead: '男' | '女' } }, images: Parameters<typeof modelPhotoFor>[0], pair: boolean): Record<string, string> {
  return Object.fromEntries(d.colors.flatMap(c => { const label = c.pick ? modelPhotoFor(images, c.pick, c.name, d.model.lead, pair) : null; return label ? [[c.pick!, label]] : []; }));
}
