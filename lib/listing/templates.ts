/**
 * 电商主图 layouts: how the images look, never what they say. A layout is one template per kind of
 * image and shape — where the title, the tags, the cards and the people go, in percent of the image
 * — and a style sheet for the type, tags, cards, light and background. A template also says whether
 * the image has people (and how many) or shows the garment alone, laid flat, hung or on an invisible
 * form. The plan fills the zones with the product's points; the prompt is written zone by zone.
 */
import type { Task } from './category';

export type Ratio = 'square' | 'portrait' | 'long';
export const RATIO_LABEL: Record<Ratio, string> = { square: '1:1 主图', portrait: '3:4 主图', long: '2:3 长图' };
/** Where a zone is: left, top, width, height in percent of the image. */
export type Box = [number, number, number, number];
/**
 * title/sub/tag: words. card: one point's picture with a caption. icon: an icon and one line. person: the models. garment: the garment alone.
 * swatch: the colours in a row. badge: the lanyard badge on the model's chest. band: a solid bar the words sit on. fabric: the garment's
 * fabric filling the image as its background (no whole garment).
 */
export type ZoneKind = 'title' | 'sub' | 'tag' | 'card' | 'icon' | 'person' | 'garment' | 'swatch' | 'badge' | 'band' | 'fabric';
export type Zone = { id: string; kind: ZoneKind; box: Box };
/** 0: no people; 3: several. */
export type People = 0 | 1 | 2 | 3;
export type Display = '平铺' | '挂拍' | '隐形人台';
/**
 * `fabricOnly`: the image shows only the fabric (no garment, no parts), so it is made from a crop of the fabric.
 * `specCard`: the SKU image is put together by the program on the brand template (lib/server/listing-sku-card.ts), not drawn:
 * the zones are unused.
 * `six`: where six cards go when the points the user must show do not fit the template's own cards (tested in
 * output/listing-pack-20261012); without it the template takes no more cards than it has.
 */
export type Template = { people: People; display?: Display; zones: Zone[]; fabricOnly?: boolean; specCard?: boolean; six?: Box[] };
/** `cover`: the cover's own title type (a master's brush or vertical serif); every other image uses `title`. */
export type StyleSheet = { title: string; text: string; tag: string; card: string; light: string; background: string; cover?: string };
export type Layout = {
  id: string; name: string; description: string; samples: string[]; style: StyleSheet;
  templates: Record<Task, Record<'square' | 'portrait', Template>>; long: Template; sku: Template;
  own?: boolean; by?: string; createdAt?: string;
};

export const PEOPLE_LABEL = (t: Pick<Template, 'people' | 'display'>) => t.people === 0 ? (t.display ? `无人·${t.display}` : '无人') : t.people === 1 ? '单人' : t.people === 2 ? '双人' : '多人';
/** The template with people changed: the models' zone and the garment's zone trade places. */
export function withPeople(t: Template, people: People, display?: Display): Template {
  const zones = t.zones.map(z => people > 0 && z.kind === 'garment' ? { ...z, id: z.id.replace('garment', 'person'), kind: 'person' as const }
    : people === 0 && z.kind === 'person' ? { ...z, id: z.id.replace('person', 'garment'), kind: 'garment' as const } : z);
  return { people, ...(people === 0 ? { display: display ?? t.display ?? '平铺' } : {}), zones };
}

/** Zones in order; ids are the kind and its number ("card2"). */
export const T = (people: People, ...zones: [ZoneKind, ...Box][]): Template => {
  const seen = new Map<string, number>();
  return { people, zones: zones.map(([kind, ...box]) => { const n = (seen.get(kind) ?? 0) + 1; seen.set(kind, n); return { id: kind + n, kind, box }; }) };
};
export const flat = (display: Display, ...zones: [ZoneKind, ...Box][]): Template => ({ ...T(0, ...zones), display });

/** How many points a template holds: what the plan fills and what both shapes of an image must agree on. */
export function capacity(t: Template) {
  const n = (k: ZoneKind) => t.zones.filter(z => z.kind === k).length;
  return { cells: n('card') + n('icon'), tags: n('tag'), sub: n('sub') > 0, person: t.people > 0, swatch: n('swatch') > 0 };
}
/** Every zone that shows a point's picture, in reading order. */
export const cellZones = (t: Template) => t.zones.filter(z => z.kind === 'card' || z.kind === 'icon');
/**
 * The template for n points where it has room for more: the cards (or icons) share the area the
 * full set took, side by side when it is wide and one under another when it is tall, so an image
 * with two points has two large cards instead of four with two empty.
 */
export function fitTemplate(t: Template, n: number): Template {
  const cells = cellZones(t);
  if (n > cells.length && t.six) return squeezed(t, Math.min(n, 6));
  if (n >= cells.length) return t;
  const rest = t.zones.filter(z => !cells.includes(z));
  if (n <= 0) return { ...t, zones: rest };
  const l = Math.min(...cells.map(z => z.box[0])), top = Math.min(...cells.map(z => z.box[1]));
  const w = Math.max(...cells.map(z => z.box[0] + z.box[2])) - l, h = Math.max(...cells.map(z => z.box[1] + z.box[3])) - top;
  const gap = 2, wide = w >= h, step = ((wide ? w : h) - gap * (n - 1)) / n, kind = cells[0].kind;
  const made: Zone[] = Array.from({ length: n }, (_, k) => {
    const box: Box = wide ? [l + k * (step + gap), top, step, h] : [l, top + k * (step + gap), w, step];
    return { id: kind + (k + 1), kind, box: box.map(v => Math.round(v * 10) / 10) as Box };
  });
  return { ...t, zones: [...rest, ...made] };
}
/** The most cards a template takes: its own, or six where it can be squeezed. */
export const mostCells = (t: Template) => Math.max(cellZones(t).length, t.six ? 6 : 0);
/** The template squeezed to n (5 or 6) cards: the first n of `six`, the last row spread over its width again. */
function squeezed(t: Template, n: number): Template {
  const cells = cellZones(t), kind = cells[0]?.kind ?? 'card', boxes = t.six!.slice(0, n).map(b => [...b] as Box);
  const lastTop = Math.max(...boxes.map(b => b[1])), row = boxes.filter(b => b[1] === lastTop), full = t.six!.filter(b => b[1] === lastTop);
  if (row.length < full.length) {
    const l = Math.min(...full.map(b => b[0])), r = Math.max(...full.map(b => b[0] + b[2])), gap = 2, w = (r - l - gap * (row.length - 1)) / row.length;
    row.forEach((b, k) => { b[0] = Math.round((l + k * (w + gap)) * 10) / 10; b[2] = Math.round(w * 10) / 10; });
  }
  return { ...t, zones: [...t.zones.filter(z => !cells.includes(z)), ...boxes.map((box, k) => ({ id: kind + (k + 1), kind, box }))] };
}
/** The SKU images show the cover's people: the man and the woman together when the cover has two or more, else the lead. */
export const skuPair = (l: Layout) => l.templates.首图.square.people >= 2;
/** Does the set need the cast (the models every image with people is drawn from)? */
export const needsCast = (l: Layout, tasks: Task[]) => tasks.some(k => l.templates[k].square.people > 0 || l.templates[k].portrait.people > 0) || l.long.people > 0 || l.sku.people > 0;

/**
 * The five 冲锋衣 masters (母版). Each is a whole set learned from top competitors' main images: the
 * zones are measured on one standard sample per image (output/listing-masters-20261008, 模板库), the
 * style sheet holds what the five images share. The cover's place comes from the plan (穿在哪儿) on
 * the masters whose cover is shot on location; the 服务 image is the shop's kept one.
 */
const SERVICE_SLOT = flat('平铺', ['title', 8, 4, 84, 10]);
const LONG2 = T(2, ['person', 8, 4, 84, 80], ['title', 10, 86, 80, 8]);
/** Every master's SKU image: put together by the program on 易玛威's colour-image layout (output/listing-sku-20261012/top02). */
const SKU_CARD: Template = { ...flat('隐形人台', ['garment', 30, 5, 67, 91], ['title', 4, 4, 24, 7], ['card', 3, 14, 17, 74]), specCard: true };
const both = (t: Template) => ({ square: t, portrait: t });
/** 收口: several people in a row, the colours as dots, the words on a translucent bar. */
const CLOSER = T(3, ['person', 0, 14, 100, 86], ['swatch', 90, 4, 6, 12], ['band', 2, 74, 96, 19], ['title', 12, 76, 76, 9], ['sub', 16, 87, 68, 4]);
/** 场景: the team in one picture, when the points do not fill another image. */
const SCENE = T(3, ['person', 0, 22, 100, 78], ['title', 4, 4, 70, 11], ['sub', 4, 16, 70, 4]);
/** 细节: four parts in a grid with a line under each. */
const DETAIL4: Template = { ...T(0, ['title', 6, 3, 64, 9], ['card', 4, 15, 46, 38], ['card', 52, 15, 46, 38], ['card', 4, 57, 46, 38], ['card', 52, 57, 46, 38]),
  six: [[4, 15, 30, 38], [36, 15, 30, 38], [68, 15, 30, 38], [4, 57, 30, 38], [36, 57, 30, 38], [68, 57, 30, 38]] };
/** 细节: three rows, the words left and the part right. */
const DETAIL_ROWS: Template = { ...T(0, ['title', 8, 3, 40, 8], ['card', 10, 12, 86, 27], ['card', 10, 41, 86, 27], ['card', 10, 70, 86, 28]),
  six: [[10, 12, 42, 27], [54, 12, 42, 27], [10, 41, 42, 27], [54, 41, 42, 27], [10, 70, 42, 28], [54, 70, 42, 28]] };
/**
 * 功能: the fabric fills the image (beaded with water), the title and two facts on it (a small label
 * over a big word, 「防水等级 / 三级以上」: the second and third tags, from the material), the points as
 * round icons along the bottom.
 */
const FABRIC_ICONS: Template = { fabricOnly: true, ...T(0, ['fabric', 0, 0, 100, 100], ['tag', 4, 7, 30, 5], ['title', 4, 13, 58, 9], ['sub', 4, 24, 50, 9], ['tag', 4, 38, 44, 11], ['tag', 4, 52, 44, 11],
  ['icon', 5, 78, 21, 20], ['icon', 29, 78, 21, 20], ['icon', 52, 78, 21, 20], ['icon', 76, 78, 21, 20]), six: [[5, 66, 29.3, 15], [36.3, 66, 29.3, 15], [67.6, 66, 29.3, 15], [5, 83, 29.3, 15], [36.3, 83, 29.3, 15], [67.6, 83, 29.3, 15]] };

export const BUILT_IN_LAYOUTS: Layout[] = [
  {
    id: 'M1', name: '车展工牌 · 浅灰商务', description: '胸前特写挂工牌，竖排宋体大字，明亮通透',
    samples: ['/listing-images/masters/M1-1.jpg', '/listing-images/masters/M1-2.jpg', '/listing-images/masters/M1-3.jpg', '/listing-images/masters/M1-4.jpg', '/listing-images/masters/M1-5.jpg'],
    style: {
      title: '粗黑体，深灰黑', cover: '竖排粗宋体（标宋：横细竖粗、带衬线角），深灰黑', text: '细黑体，深灰',
      tag: '深灰实底小方标，白字', card: '浅灰圆角卡片，不描边', light: '柔和窗光从左上来，阴影很淡，整体通透', background: '浅灰白，明亮高调，低饱和；画面里唯一鲜艳的颜色是衣服',
    },
    templates: {
      首图: both(T(1, ['person', 0, 0, 100, 100], ['badge', 48, 52, 11, 22], ['title', 76, 58, 17, 22], ['sub', 79, 80, 13, 18])),
      服务: both(SERVICE_SLOT),
      功能: both({ ...T(0, ['card', 0, 0, 100, 42], ['title', 4, 4, 36, 8], ['sub', 4, 13, 40, 4], ['card', 2, 45, 47, 27], ['card', 51, 45, 47, 53], ['card', 2, 74, 47, 24]),
        six: [[0, 0, 100, 42], [2, 45, 30.7, 25.5], [34.7, 45, 30.7, 25.5], [67.3, 45, 30.7, 25.5], [2, 72.5, 47, 25.5], [51, 72.5, 47, 25.5]] }),
      细节: both({ ...T(0, ['title', 4, 9, 60, 8], ['sub', 4, 19, 50, 4], ['card', 4, 26, 92, 44], ['card', 4, 72, 29, 27], ['card', 36, 72, 29, 27], ['card', 68, 72, 28, 27]),
        six: [[4, 26, 92, 36], [4, 64, 29, 16.5], [36, 64, 29, 16.5], [68, 64, 28, 16.5], [4, 82.5, 45, 16], [51, 82.5, 45, 16]] }),
      实用: both(DETAIL4), 场景: both(SCENE), 收口: both(CLOSER),
    },
    long: LONG2, sku: SKU_CARD,
  },
  {
    id: 'M2', name: '暗黑科技', description: '深色冷光，水花和液体高速特写，科技感最强',
    samples: ['/listing-images/masters/M2-1.jpg', '/listing-images/masters/M2-2.jpg', '/listing-images/masters/M2-3.jpg', '/listing-images/masters/M2-4.jpg', '/listing-images/masters/M2-5.jpg'],
    style: {
      title: '白色粗黑体，笔画硬朗', text: '浅灰细黑体；英文粗体窄体大写', tag: '琥珀色细描边的深色胶囊，白字；纯黑色块白字',
      card: '深色圆角卡片', light: '冷白硬光从右上来，物体边缘有高光，画面四角压暗', background: '深灰到纯黑，冷调；只有衣服、水花和字是亮的',
    },
    templates: {
      首图: both(T(1, ['person', 0, 0, 100, 89], ['band', 0, 89, 100, 11], ['tag', 2, 90, 24, 9], ['title', 28, 90, 70, 9])),
      服务: both(SERVICE_SLOT),
      功能: both(T(0, ['card', 0, 0, 100, 100], ['title', 44, 13, 52, 11], ['sub', 3, 6, 22, 15], ['tag', 70, 4, 26, 6])),
      细节: both(DETAIL4), 实用: both(DETAIL4), 场景: both(SCENE), 收口: both(CLOSER),
    },
    long: LONG2, sku: SKU_CARD,
  },
  {
    id: 'M3', name: '上岗实拍 · 笔刷大字', description: '人在场景里干活，首图毛笔大字，其余图规整黑体',
    samples: ['/listing-images/masters/M3-1.jpg', '/listing-images/masters/M3-2.jpg', '/listing-images/masters/M3-3.jpg', '/listing-images/masters/M3-4.jpg', '/listing-images/masters/M3-5.jpg'],
    style: {
      title: '粗黑体，深色；规整，不用毛笔字', cover: '白色毛笔笔刷字（飞白明显、带一点投影）', text: '细黑体；英文粗体窄体大写',
      tag: '衣服主色的色块标签，白字', card: '白色圆角卡片', light: '实景跟着场景和天气；棚拍用暖白柔光', background: '暖白、米色，暖调',
    },
    templates: {
      首图: both(T(1, ['person', 0, 0, 100, 100], ['title', 5, 72, 36, 20], ['sub', 40, 77, 50, 9], ['tag', 42, 88, 44, 4])),
      服务: both(SERVICE_SLOT),
      功能: both({ fabricOnly: true, ...T(0, ['card', 0, 0, 50, 50], ['card', 50, 0, 50, 50], ['card', 0, 50, 50, 50], ['card', 50, 50, 50, 50]),
        six: [[0, 0, 33.3, 50], [33.3, 0, 33.4, 50], [66.7, 0, 33.3, 50], [0, 50, 33.3, 50], [33.3, 50, 33.4, 50], [66.7, 50, 33.3, 50]] }),
      细节: both(DETAIL_ROWS), 实用: both(DETAIL4), 场景: both(SCENE), 收口: both(CLOSER),
    },
    long: LONG2, sku: SKU_CARD,
  },
  {
    id: 'M4', name: '双人棚拍 · 清爽', description: '男女双人，浅灰棚拍底，干净清爽',
    samples: ['/listing-images/masters/M4-1.jpg', '/listing-images/masters/M4-2.jpg', '/listing-images/masters/M4-3.jpg', '/listing-images/masters/M4-4.jpg', '/listing-images/masters/M4-5.jpg'],
    style: {
      title: '粗黑体，深色', text: '细黑体，深灰', tag: '绿色圆角胶囊，白字', card: '浅灰细线框圆角卡片',
      light: '正面柔光箱，棚拍，有轻微渐变和脚下阴影', background: '浅灰白，干净偏冷；没有户外场景',
    },
    templates: {
      首图: both(T(2, ['person', 0, 0, 100, 100], ['title', 68, 8, 29, 18], ['tag', 72, 28, 24, 5])),
      服务: both(SERVICE_SLOT), 功能: both(FABRIC_ICONS), 细节: both(DETAIL4), 实用: both(DETAIL4), 场景: both(SCENE), 收口: both(CLOSER),
    },
    long: LONG2, sku: SKU_CARD,
  },
  {
    id: 'M5', name: '无模特 · 产品静物', description: '衣服悬浮或挂拍，棚拍光，全程不出现人',
    samples: ['/listing-images/masters/M5-1.jpg', '/listing-images/masters/M5-2.jpg', '/listing-images/masters/M5-3.jpg', '/listing-images/masters/M5-4.jpg', '/listing-images/masters/M5-5.jpg'],
    style: {
      title: '粗黑体深色，重点字用衣服主色', text: '细黑体，深灰', tag: '深灰实底小方标，白字', card: '白底圆角卡片',
      light: '柔和顶光，衣服下方有落地投影', background: '纯白、浅灰，最干净；没有人',
    },
    templates: {
      首图: both(flat('隐形人台', ['garment', 20, 6, 72, 90], ['title', 3, 12, 32, 13], ['tag', 3, 28, 26, 7], ['tag', 3, 42, 16, 6], ['tag', 3, 50, 16, 6])),
      服务: both(SERVICE_SLOT), 功能: both(FABRIC_ICONS), 细节: both(DETAIL_ROWS), 实用: both(DETAIL4),
      场景: both(flat('挂拍', ['garment', 14, 13, 72, 78], ['title', 6, 3, 88, 8])),
      收口: both(flat('挂拍', ['garment', 0, 14, 100, 66], ['title', 6, 84, 46, 9], ['swatch', 60, 84, 34, 10])),
    },
    long: flat('挂拍', ['garment', 12, 4, 76, 80], ['title', 10, 86, 80, 8]), sku: SKU_CARD,
  },
];

/** The flat-lay layout a team might learn: no people anywhere, so no cast and no model choice. */
export const FLAT_EXAMPLE: Omit<Layout, 'id' | 'samples'> = {
  name: '平铺静物', description: '木纹台面平铺、主色底条、白色笔刷标题',
  style: { title: '超大白色粗笔刷字', text: '白色无衬线小字', tag: '圆角胶囊，主色加深', card: '浅色圆角卡片', light: '柔和顶光，有一点自然投影', background: '浅暖灰色细木纹台面，底部主色极深的实色底条' },
  templates: {
    首图: { square: flat('平铺', ['garment', 17, 6, 66, 64], ['title', 6, 76, 88, 12], ['tag', 6, 90, 24, 6], ['tag', 33, 90, 30, 6]), portrait: flat('平铺', ['garment', 12, 5, 76, 66], ['title', 6, 76, 88, 10], ['tag', 6, 90, 24, 5], ['tag', 33, 90, 30, 5]) },
    服务: { square: flat('平铺', ['title', 8, 6, 84, 10], ['icon', 8, 22, 40, 34], ['icon', 52, 22, 40, 34], ['icon', 8, 60, 40, 34], ['icon', 52, 60, 40, 34]), portrait: flat('平铺', ['title', 8, 5, 84, 8], ['icon', 8, 18, 40, 38], ['icon', 52, 18, 40, 38], ['icon', 8, 59, 40, 38], ['icon', 52, 59, 40, 38]) },
    功能: { square: flat('平铺', ['title', 5, 4, 90, 10], ['garment', 4, 18, 46, 76], ['card', 54, 18, 42, 37], ['card', 54, 58, 42, 37], ['tag', 5, 94, 30, 5]), portrait: flat('平铺', ['title', 5, 3, 90, 8], ['garment', 6, 14, 88, 40], ['card', 6, 57, 42, 36], ['card', 52, 57, 42, 36], ['tag', 5, 95, 30, 4]) },
    细节: { square: flat('平铺', ['title', 10, 3, 80, 8], ['tag', 38, 13, 24, 4], ['card', 3, 20, 94, 38], ['card', 3, 60, 46, 37], ['card', 51, 60, 46, 37]), portrait: flat('平铺', ['title', 10, 3, 80, 7], ['tag', 38, 11, 24, 3], ['card', 4, 17, 92, 38], ['card', 4, 58, 45, 38], ['card', 51, 58, 45, 38]) },
    实用: { square: flat('平铺', ['title', 5, 4, 90, 10], ['garment', 6, 16, 56, 80], ['card', 60, 48, 36, 40]), portrait: flat('平铺', ['title', 5, 3, 90, 8], ['garment', 6, 13, 88, 50], ['card', 30, 66, 40, 30]) },
    场景: { square: flat('挂拍', ['title', 6, 3, 88, 10], ['garment', 18, 15, 64, 75], ['tag', 6, 92, 26, 6], ['tag', 35, 92, 26, 6]), portrait: flat('挂拍', ['title', 6, 3, 88, 8], ['garment', 14, 13, 72, 78], ['tag', 6, 93, 26, 5], ['tag', 35, 93, 26, 5]) },
    收口: { square: flat('平铺', ['title', 8, 4, 84, 10], ['garment', 4, 18, 92, 60], ['swatch', 5, 82, 90, 14]), portrait: flat('平铺', ['title', 8, 3, 84, 8], ['garment', 4, 14, 92, 64], ['swatch', 5, 82, 90, 13]) },
  },
  long: flat('挂拍', ['garment', 12, 4, 76, 80], ['title', 10, 86, 80, 8]),
  sku: flat('平铺', ['garment', 12, 14, 76, 82], ['title', 5, 4, 40, 8]),
};

/** Taobao main images are 1:1 or 3:4 only, so the shape of an uploaded image is measured, never guessed. */
export function shapeOf(width: number, height: number): '1:1' | '3:4' | '其他' {
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.02) return '1:1';
  if (Math.abs(ratio - 0.75) < 0.02) return '3:4';
  return '其他';
}
