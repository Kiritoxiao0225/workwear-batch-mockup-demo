/**
 * 电商主图 categories. A category says what each of the five main images is for and, from the
 * best-selling competitors' main images, which selling points buyers expect: how many competitors
 * show each kind of point, how often it is on the cover, the usual wording and how it is drawn.
 * Built offline (output/category-points/build-library.mjs); a product outside every category uses
 * the generic one, which has the five images but no competitor data.
 */
import workwear from './categories/workwear.json';

export const POINT_TYPES = ['定位', '功能', '面料', '做工', '实用', '服务定制', '颜色款式', '人群场景'] as const;
export type PointType = (typeof POINT_TYPES)[number];
/**
 * What one main image is for. 服务 is the workwear image of design, delivery, invoices and checks;
 * 场景 shows the garment worn at work when the points do not fill another image.
 */
export type Task = '首图' | '服务' | '功能' | '细节' | '实用' | '场景' | '收口';
export const TASKS: Task[] = ['首图', '服务', '功能', '细节', '实用', '场景', '收口'];
export const TASK_LABEL: Record<Task, string> = { 首图: '首图', 服务: '服务说明', 功能: '功能', 细节: '细节', 实用: '实用', 场景: '场景', 收口: '收口' };
export const TASK_HINT: Record<Task, string> = {
  首图: '定位做大标题，标签放最强的卖点，衣服要大，为搜索列表里的点击服务',
  服务: '定制服务：设计、发货、开票、质检，图标加一句话',
  功能: '面料和功能，每条卖点配一个演示画面',
  细节: '做工细节特写，每格一个部位',
  实用: '实用设计的演示',
  场景: '穿着上班、团队一起穿的样子，卖点不多时用它',
  收口: '几色可选和适合的人，推动下单',
};

/** coverage: share of competitors showing it; share: the same weighted by sales; includes: kinds it already covers (三防 covers 防水). */
export type Concept = { id: string; name: string; type: PointType; keywords: string[]; coverage: number; share: number; cover: number; wordings: string[]; proofs: string[]; includes: string[] };
/** tasks: the kinds of image the category uses, in the order they are shown. */
export type Category = { id: string; name: string; items: number; source: string; tasks: Task[]; concepts: Concept[] };

export const CATEGORIES: Category[] = [
  { ...(workwear as Omit<Category, 'tasks' | 'concepts'> & { tasks: string[]; concepts: Concept[] }), tasks: workwear.tasks as Task[] },
  { id: 'generic', name: '通用', items: 0, source: '', tasks: ['首图', '功能', '细节', '实用', '场景', '收口'], concepts: [] },
];
/**
 * The words that say which kind of garment it is, most telling first, with what in the points shows
 * it: a cover shot in the studio says 「三合一 / 冲锋衣」 like the masters' 「轻量化 / 连帽单冲」.
 * Functions (防风防水) are not here: nearly every garment of the category has them.
 */
export const BUILDS: Record<string, [string, RegExp][]> = {
  workwear: [['三合一', /三合一|可拆卸?.{0,6}内胆|一衣[两三]穿/], ['软壳', /软壳/], ['硬壳', /硬壳/], ['单层', /单层|单冲/], ['轻量化', /轻量|轻薄|超轻/], ['加绒', /加绒|加厚/]],
};
export const categoryById = (id: string) => CATEGORIES.find(c => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];

/** How a point stands among competitors: most show it, many do, few do, or none (the product's own). */
export type PointGroup = '必打' | '常打' | '少见' | '独有' | '补充';
export const GROUP_LABEL: Record<PointGroup, string> = { 必打: '必打', 常打: '常打', 少见: '少见', 独有: '你独有', 补充: '补充' };
export const GROUP_HINT: Record<PointGroup, string> = {
  必打: '一半以上的竞品都在讲，不讲吃亏',
  常打: '四分之一以上的竞品在讲',
  少见: '讲的竞品不多，可以当差异点',
  独有: '竞品没人讲：差异点，最多一条上首图',
  补充: '竞品常讲、你的素材里没写',
};
export const groupOf = (concept: Concept | undefined): Exclude<PointGroup, '补充'> =>
  !concept ? '独有' : concept.coverage >= 0.5 ? '必打' : concept.coverage >= 0.25 ? '常打' : '少见';

/** One line with the numbers behind a point, for the list of points. */
export function evidenceOf(concept: Concept | undefined, category: Category) {
  if (!concept || !category.items) return '';
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const inc = concept.includes.map(id => category.concepts.find(c => c.id === id)).filter((c): c is Concept => !!c);
  const top = inc.sort((a, b) => b.share - a.share)[0];
  return `竞品 ${pct(concept.coverage)} 在讲，按销量算 ${pct(concept.share)}${concept.cover ? `，${concept.cover} 次上首图` : ''}${top && top.share > concept.share ? `；它包含${inc.map(c => c.name).join('、')}，按${top.name}算 ${pct(top.share)}` : ''}`;
}
