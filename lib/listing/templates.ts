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
/** title/sub/tag: words. card: one point's picture with a caption. icon: an icon and one line. person: the models. garment: the garment alone. swatch: the colours in a row. */
export type ZoneKind = 'title' | 'sub' | 'tag' | 'card' | 'icon' | 'person' | 'garment' | 'swatch';
export type Zone = { id: string; kind: ZoneKind; box: Box };
/** 0: no people; 3: several. */
export type People = 0 | 1 | 2 | 3;
export type Display = '平铺' | '挂拍' | '隐形人台';
export type Template = { people: People; display?: Display; zones: Zone[] };
export type StyleSheet = { title: string; text: string; tag: string; card: string; light: string; background: string };
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
const T = (people: People, ...zones: [ZoneKind, ...Box][]): Template => {
  const seen = new Map<string, number>();
  return { people, zones: zones.map(([kind, ...box]) => { const n = (seen.get(kind) ?? 0) + 1; seen.set(kind, n); return { id: kind + n, kind, box }; }) };
};
const flat = (display: Display, ...zones: [ZoneKind, ...Box][]): Template => ({ ...T(0, ...zones), display });

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
/** Does the set need the cast (the models every image with people is drawn from)? */
export const needsCast = (l: Layout, tasks: Task[]) => tasks.some(k => l.templates[k].square.people > 0 || l.templates[k].portrait.people > 0) || l.long.people > 0 || l.sku.people > 0;

export const BUILT_IN_LAYOUTS: Layout[] = [
  {
    id: 'commute-split', name: '通勤质感分栏', description: '粗黑标题、分栏信息卡、柔和自然光',
    samples: ['/listing-images/layout-commute-1.webp', '/listing-images/layout-commute-2.webp', '/listing-images/layout-commute-3.webp'],
    style: {
      title: '粗黑无衬线大字，深色压在浅底上、白色压在深底上；首图用超大笔刷字', text: '小号无衬线，宽字距',
      tag: '衣服主色加深的圆角胶囊，白字', card: '浅色半透明圆角卡片，细描边，底部一行说明字',
      light: '柔和侧向自然光，衣服正面明亮', background: '低饱和、轻虚化的现代室内空间',
    },
    templates: {
      首图: {
        square: T(1, ['person', 16, 0, 70, 100], ['title', 6, 72, 88, 14], ['tag', 6, 88, 24, 6], ['tag', 33, 88, 28, 6], ['sub', 6, 95, 60, 4]),
        portrait: T(1, ['person', 12, 3, 76, 80], ['title', 6, 76, 88, 10], ['tag', 6, 89, 24, 5], ['tag', 33, 89, 28, 5], ['sub', 6, 95, 60, 3]),
      },
      服务: {
        square: flat('平铺', ['title', 8, 3, 84, 10], ['sub', 8, 13, 84, 3], ['icon', 10, 18, 39, 15], ['icon', 51, 18, 39, 15], ['icon', 10, 35, 39, 15], ['icon', 51, 35, 39, 15], ['garment', 4, 52, 92, 46]),
        portrait: flat('平铺', ['title', 8, 4, 84, 8], ['sub', 8, 13, 84, 3], ['garment', 5, 18, 90, 46], ['icon', 6, 65, 43, 15], ['icon', 51, 65, 43, 15], ['icon', 6, 81, 43, 15], ['icon', 51, 81, 43, 15]),
      },
      功能: {
        square: T(1, ['person', 38, 0, 62, 100], ['title', 4, 5, 34, 10], ['sub', 4, 16, 34, 4], ['card', 4, 23, 32, 35], ['card', 4, 61, 32, 35], ['tag', 40, 4, 22, 5]),
        portrait: T(1, ['title', 6, 4, 88, 8], ['sub', 6, 13, 88, 3], ['person', 30, 18, 70, 82], ['card', 4, 22, 34, 30], ['card', 4, 56, 34, 30], ['tag', 6, 90, 30, 5]),
      },
      细节: {
        square: T(0, ['title', 10, 3, 80, 8], ['sub', 20, 12, 60, 3], ['tag', 38, 16, 24, 4], ['card', 3, 21, 94, 37], ['card', 3, 60, 46, 37], ['card', 51, 60, 46, 37]),
        portrait: T(0, ['title', 15, 3, 70, 7], ['sub', 25, 11, 50, 3], ['tag', 38, 15, 24, 4], ['card', 4, 21, 92, 37], ['card', 4, 61, 45, 35], ['card', 51, 61, 45, 35]),
      },
      实用: {
        square: T(1, ['title', 5, 3, 90, 10], ['person', 8, 14, 58, 86], ['card', 60, 48, 36, 40], ['tag', 5, 90, 40, 6]),
        portrait: T(1, ['title', 5, 3, 90, 8], ['person', 6, 12, 64, 88], ['card', 58, 56, 38, 32], ['tag', 5, 92, 40, 5]),
      },
      场景: {
        square: T(2, ['title', 6, 3, 88, 10], ['sub', 6, 14, 88, 4], ['person', 0, 18, 100, 82], ['tag', 6, 90, 26, 6], ['tag', 35, 90, 26, 6]),
        portrait: T(2, ['title', 6, 3, 88, 8], ['sub', 6, 12, 88, 3], ['person', 0, 15, 100, 85], ['tag', 6, 92, 26, 5], ['tag', 35, 92, 26, 5]),
      },
      收口: {
        square: T(3, ['title', 8, 4, 84, 10], ['sub', 8, 15, 84, 4], ['person', 0, 20, 100, 62], ['swatch', 5, 84, 90, 12]),
        portrait: T(3, ['title', 8, 3, 84, 8], ['sub', 8, 12, 84, 3], ['person', 0, 17, 100, 64], ['swatch', 5, 84, 90, 12]),
      },
    },
    long: T(2, ['person', 8, 4, 84, 80], ['title', 10, 86, 80, 8]),
    sku: T(2, ['person', 10, 10, 80, 90], ['title', 5, 4, 40, 8], ['tag', 5, 13, 22, 4], ['card', 5, 70, 24, 24]),
  },
  {
    id: 'warm-impact', name: '爆款暖光', description: '毛笔大标题、底部压暗、主色卖点标签、暖色逆光',
    samples: ['/listing-images/square-1.webp', '/listing-images/square-3.webp', '/listing-images/sku-K1.webp'],
    style: {
      title: '超大白色粗犷毛笔书法字，带轻微投影', text: '白色无衬线小字',
      tag: '衣服主色的飘带或圆角标签，白字', card: '圆角特写框，下沿一个主色短标签',
      light: '暖色侧逆光，轮廓发光，背景虚化成光斑', background: '画面下方由透明到深色的渐变承托文字',
    },
    templates: {
      首图: {
        square: T(1, ['person', 10, 0, 80, 100], ['tag', 6, 56, 26, 6], ['tag', 64, 56, 28, 6], ['title', 4, 63, 92, 18], ['sub', 8, 83, 84, 5]),
        portrait: T(1, ['person', 8, 0, 84, 82], ['tag', 6, 62, 26, 5], ['tag', 64, 62, 28, 5], ['title', 4, 68, 92, 14], ['sub', 8, 84, 84, 4]),
      },
      服务: {
        square: T(0, ['title', 5, 3, 90, 14], ['icon', 6, 22, 42, 32], ['icon', 52, 22, 42, 32], ['icon', 6, 58, 42, 32], ['icon', 52, 58, 42, 32], ['sub', 6, 93, 88, 5]),
        portrait: T(0, ['title', 5, 3, 90, 11], ['icon', 6, 18, 42, 36], ['icon', 52, 18, 42, 36], ['icon', 6, 57, 42, 36], ['icon', 52, 57, 42, 36], ['sub', 6, 95, 88, 4]),
      },
      功能: {
        square: T(1, ['title', 5, 3, 90, 16], ['person', 12, 18, 58, 82], ['card', 68, 26, 28, 28], ['card', 68, 58, 28, 28], ['tag', 6, 88, 30, 6], ['sub', 6, 94, 88, 5]),
        portrait: T(1, ['title', 5, 3, 90, 12], ['person', 6, 15, 62, 85], ['card', 64, 24, 32, 26], ['card', 64, 54, 32, 26], ['tag', 6, 88, 30, 5], ['sub', 6, 94, 88, 4]),
      },
      细节: {
        square: T(0, ['title', 5, 3, 90, 14], ['card', 3, 20, 94, 40], ['card', 3, 62, 46, 30], ['card', 51, 62, 46, 30], ['tag', 30, 15, 40, 4], ['sub', 5, 94, 90, 5]),
        portrait: T(0, ['title', 5, 3, 90, 11], ['card', 3, 17, 94, 40], ['card', 3, 59, 46, 34], ['card', 51, 59, 46, 34], ['tag', 30, 13, 40, 3], ['sub', 5, 95, 90, 4]),
      },
      实用: {
        square: T(1, ['title', 5, 3, 90, 14], ['person', 10, 16, 56, 84], ['card', 62, 56, 34, 34], ['tag', 6, 88, 30, 6], ['sub', 6, 94, 88, 5]),
        portrait: T(1, ['title', 5, 3, 90, 11], ['person', 6, 14, 62, 86], ['card', 60, 60, 36, 28], ['tag', 6, 90, 30, 4], ['sub', 6, 95, 88, 4]),
      },
      场景: {
        square: T(2, ['person', 0, 0, 100, 100], ['tag', 6, 60, 26, 6], ['tag', 36, 60, 26, 6], ['title', 4, 67, 92, 16], ['sub', 8, 85, 84, 5]),
        portrait: T(2, ['person', 0, 0, 100, 86], ['tag', 6, 64, 26, 5], ['tag', 36, 64, 26, 5], ['title', 4, 70, 92, 13], ['sub', 8, 85, 84, 4]),
      },
      收口: {
        square: T(3, ['title', 5, 3, 90, 14], ['person', 0, 18, 100, 62], ['swatch', 5, 80, 90, 12], ['sub', 6, 93, 88, 5]),
        portrait: T(3, ['title', 5, 3, 90, 11], ['person', 0, 15, 100, 64], ['swatch', 5, 80, 90, 11], ['sub', 6, 94, 88, 4]),
      },
    },
    long: T(2, ['title', 6, 3, 88, 10], ['person', 6, 12, 88, 86]),
    sku: T(2, ['person', 10, 8, 80, 92], ['title', 4, 4, 40, 9], ['tag', 4, 14, 22, 4], ['card', 4, 70, 24, 24]),
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
