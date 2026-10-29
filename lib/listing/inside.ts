/**
 * 电商主图: the inside of an 一体 jacket (10-29), its lining, fleece or quilting sewn in. The SKU image
 * shows it in the small box under the title where a 有内胆 one shows its liner (left empty, to be put in
 * by hand, when the material has none); the cover may wear the jacket open on it, drawn from that photo.
 */
import { colorKeys, type Draft } from './draft';

/** A close-up's part (listing-organize's `detail`) that is the inside: in an 一体 jacket 「内胆」 is its sewn-in one. */
const INSIDE = /内里|里布|里料|里绒|内衬|衬里|夹棉|填充|里子|内胆|绗缝/;
/** Photos only: a detail page or a selling image has words and other pictures around it. */
const INSIDE_KINDS = new Set(['细节特写', '静物', '模特实拍', '3D渲染']);
type Img = { id: string; kind: string; role?: string; detail?: string; color: string; same?: string };

export const isInside = (i: Img) => !i.same && INSIDE_KINDS.has(i.kind) && !['内胆', '配件', '组合'].includes(i.role ?? '') && INSIDE.test(i.detail ?? '');

/**
 * The material's photo of a colour's inside: one of that colour, a close-up first. When the inside
 * photos say no colour of this product, any of them; when they are of other colours only, none: a red
 * jacket may be lined black and a white one white (不拿别的颜色的图来凑).
 */
export function insidePhoto(images: Img[], color: string, colors: string[]): string | null {
  const all = images.filter(isInside), own = all.filter(i => i.color === color);
  const list = own.length ? own : all.some(i => colors.includes(i.color)) ? [] : all;
  const rank = (i: Img) => (i.kind === '细节特写' ? 2 : i.kind === '静物' ? 1 : 0);
  return [...list].sort((a, b) => rank(b) - rank(a))[0]?.id ?? null;
}

/**
 * A colour's inside photo by its key (colorKeys): the plan's choice ('' is none, the box left empty),
 * else the material's. The colour is the one the AI read on its chosen image, so a renamed colour still finds it.
 */
export function insideFor(images: Img[], d: Pick<Draft, 'colors' | 'wear'>, key: string): string | null {
  const set = d.wear?.insides?.[key];
  if (set !== undefined) return set || null;
  const keys = colorKeys(d.colors), at = keys.indexOf(key);
  if (at < 0) return null;
  const read = (c: Draft['colors'][number]) => images.find(i => i.id === c.pick)?.color || c.name;
  return insidePhoto(images, read(d.colors[at]), d.colors.map(read));
}

/** Words of a point that heats or holds warmth: the open cover's small orange badge goes on the inside only then. */
const HEAT = /石墨烯|发热|蓄热|恒温|远红外|自发热|聚热/;
export const heatPoint = (points: Pick<Draft['points'][number], 'text' | 'note' | 'on' | 'source'>[]) =>
  points.some(p => p.on && p.source === '素材' && HEAT.test(`${p.text} ${p.note}`));
