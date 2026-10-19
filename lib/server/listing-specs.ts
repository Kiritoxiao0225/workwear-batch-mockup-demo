/**
 * 电商主图「母版说明书」: each master's cover, feature, close-up and closer images written the way
 * their sample images were drawn (output/listing-masters-20261008: trial4–trial10 prompts), word for
 * word, with only what changes from one product to the next left open: the words, the colours, the
 * demonstrations and, for a cover on location, the place. The sample image itself goes to the model
 * as the last reference, for the layout, type, colours and light: the competitor's image the master
 * was learnt from, washed of its brand (public/listing-images/rivals, trial11/wash.py), not our own
 * trial of it, which had lost the competitor's small things (English corner words, two-line notes,
 * icon rows) and kept the trial's AI look (tested 2026-10-13, trial11). Images the specs do not cover
 * (or with more or fewer cards than the sample) keep the general prompt (listing-prompts mainPrompt).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '../listing/category';
import { crowdLine, DEFAULT_PLACE } from './listing-crowd';
import { NO_CHEST, OWN_MARKS, SAME_STYLE } from './listing-lines';

/** What a spec fills its open places with. */
export type Fill = {
  title: string; sub: string; tags: string[];
  /** 「label｜word」 tags, split. */
  facts: { label: string; word: string }[];
  /** The images' cards: words, the point's note, how it is shown, its English word for the masters that print one. */
  cells: { text: string; note: string; recipe: string; en: string }[];
  /** The colour of the garment (or fabric) in this image, and on the closer every colour used. */
  color: string; colors: { name: string; hex: string }[]; all: { name: string; hex: string }[];
  /** The fabric of an image of fabric only is light (dark words on it). */
  light: boolean;
  /** Who is in it ("参考图2里的男生"), what they do and the scene, for the cover. */
  who: string; act?: string; scene?: string;
  /** The words on the lanyard badge (车展工牌), or nothing. */
  badge: string;
  /** The customer's LOGO reference number, when it is sent (the closer puts it in a corner too). */
  logoRef?: number;
  /** The cast's reference number, and where the closer's group is shot (the plan's `place`). */
  castRef?: number; place?: string;
};
export type Spec = {
  /** The sample image (public path), sent as the layout reference. */
  sample: string;
  /** The sample is our own trial, not a competitor's (无模特's cover: the user liked ours better). */
  own?: boolean;
  /** Asked to look like a real photograph (people, a place, or something being shown being done). */
  photo?: boolean;
  /** How many cards the sample has: a plan with another count keeps the general prompt. */
  cells: number;
  /** Only fabric is shown (no garment): its reference is a piece of the fabric. */
  fabric?: boolean;
  /** People in it: the cast is a reference. */
  people?: boolean;
  zones: (f: Fill) => (string | false | null | undefined)[];
  background: (f: Fill) => string;
  /** The style line (the samples' 「整体风格」), when it differs from the master's. */
  style?: string;
};

const two = (s: string) => { const [a, ...b] = s.trim().split(/\s+/); return b.length ? [a, b.join('')] : [s.trim(), '']; };
const dots = (f: Fill) => `一个竖向的浅色细描边圆角胶囊框，里面上下排 ${f.all.length} 个小圆点，颜色依次是 ${f.all.map(c => c.hex).join('、')}，不写字`;
/** A competitor's sample, washed of its brand (trial11/wash.py). */
const rival = (ref: string) => `/listing-images/rivals/${ref}.jpg`;
/** The English words of an image's cards, once each. */
const ens = (f: Fill) => [...new Set(f.cells.map(c => c.en).filter(Boolean))];
/** A point's note in two short lines (「帽围自由调节 挡风遮雨」), as the samples print it. */
const lines = (note: string) => { const [a, ...b] = note.trim().split(/[\s，,；;]+/).filter(Boolean); return b.length ? [a, b.join(' ')] : a ? [a] : []; };
/** A short note goes under a card's words; a long one would crowd it. */
const short = (note: string) => !!note && note.length <= 8;
/**
 * The three small icon words under a 四宫格 card (门店上岗's feature image), by the card's English
 * word: fixed, so nothing the model makes up gets printed and nothing claims a part the garment may lack.
 */
const ICON_WORDS: Record<string, [string, string, string]> = {
  WATERPROOF: ['荷叶拒水', '防泼溅', '雨天不渗'], WINDPROOF: ['高密防风', '挡风锁温', '户外不冷'], BREATHABLE: ['透湿排汗', '清爽舒适', '久穿不闷'],
  DURABLE: ['防刮耐磨', '抗撕裂', '耐穿耐造'], WARM: ['锁住体温', '抵御寒风', '轻暖舒适'], LIGHTWEIGHT: ['轻盈无感', '活动自如', '便于收纳'],
  'EASY CARE': ['防油防污', '一擦即净', '好打理'], 'ANTI-WRINKLE': ['抗皱有型', '不易起褶', '挺括耐看'], STRETCH: ['弹力舒展', '活动自如', '不紧绷'],
};
/** The rack's garments left to right: every colour, at least four (colours repeat in turn). */
const rack = (f: Fill) => Array.from({ length: Math.max(4, f.colors.length) }, (_, k) => f.colors[k % f.colors.length]?.name ?? '');
/** A word as a script decoration (「Windproof」). */
const script = (en: string) => en ? en[0] + en.slice(1).toLowerCase() : '';

/** The English word some masters print over a point (「WATERPROOF」), from its words; none when it says something else. */
export function enOf(text: string) {
  const rules: [RegExp, string][] = [[/防水|拒水|泼水|防雨/, 'WATERPROOF'], [/防风|挡风/, 'WINDPROOF'], [/透气|透湿|呼吸|排汗/, 'BREATHABLE'], [/耐磨|撕裂|结实|耐造/, 'DURABLE'],
    [/保暖|锁温|内胆|御寒/, 'WARM'], [/轻量|轻薄|超轻|轻盈/, 'LIGHTWEIGHT'], [/防污|耐脏|易打理|易清洗/, 'EASY CARE'], [/抗皱/, 'ANTI-WRINKLE'], [/弹力|伸展/, 'STRETCH']];
  return rules.find(([re]) => re.test(text))?.[1] ?? '';
}

/** Styles as the samples wrote them (「整体风格」), one per master. */
export const SPEC_STYLE: Record<string, { all: string; cover: string }> = {
  M1: { all: '色调浅灰白，明亮高调，低饱和；画面里唯一鲜艳的颜色是衣服；字体首图标题竖排粗宋体（标宋：横细竖粗、带衬线角）深灰黑；功能图标题细宋体；其余标题中粗黑体深灰黑；说明字细黑体深灰；英文小字极细、字距拉开；标签和卡片深灰实底小方标、白字；卡片圆角浅灰底，不描边；光柔和窗光从左上来，阴影很淡，整体通透。',
    cover: '字体：粗宋体（标宋：横细竖粗、带衬线角），深灰黑；标签深灰实底小方标、白字。' },
  M2: { all: '色调深灰到纯黑，冷调；只有衣服、水花和字是亮的；字体标题白色粗黑体，笔画硬朗；小字浅灰细黑体；英文粗体窄体大写；标签和卡片深色底、琥珀色细描边的胶囊标签，白字；卡片是深色圆角；光冷白硬光从右上来，物体边缘有高光，画面四角压暗。',
    cover: '字体：粗黑体，笔画硬朗；横条琥珀色实底，左边纯黑色块白字。暗调画面，冷白硬光从右上来，边缘高光，四角压暗。' },
  M3: { all: '色调暖白、米色，暖调；字体只有首图大标题用毛笔笔刷字；这一张如果不是首图，所有字都用规整的粗黑体和细黑体，不用毛笔字、书法字；英文用中粗无衬线大写（不是窄体）；标签和卡片衣服主色的色块标签、白字；卡片白色圆角；光暖色室内光；棚拍的图用暖白柔光。',
    cover: '字体：只有大字用书法毛笔字（行书，粗细对比强），其余用规整黑体；英文小字细体、字距拉开。' },
  M4: { all: '色调浅灰白，干净偏冷；没有户外场景；字体标题深色粗黑体；说明字深灰细黑体，字号不要太小；标签和卡片绿色圆角胶囊标签、白字；卡片白色圆角、细浅灰边、轻投影；光正面柔光箱，棚拍，有轻微渐变和脚下阴影。',
    cover: '色调浅灰白，干净偏冷；没有户外场景；字体标题深色粗黑体；标签绿色圆角胶囊、白字；光正面柔光箱，棚拍，有轻微渐变和脚下阴影。' },
  M5: { all: '色调纯白、浅灰，最干净；没有人；字体标题粗黑体深色，重点字用衣服主色；说明字细黑体深灰；标签和卡片线描圆形图标；卡片白底；光柔和顶光，衣服下方有落地投影。',
    cover: '色调纯白、浅灰，最干净；没有人；字体标题粗黑体深色，重点字用衣服主色；说明字细黑体深灰；线描圆形图标；光柔和顶光，衣服下方有落地投影。' },
};

/** The fabric of fabric-only images on the light masters: words dark on light fabric, white on dark. */
const ink = (f: Fill) => f.light ? '深色' : '白色', soft = (f: Fill) => f.light ? '深灰' : '白色';
/** 面料铺底 + 参数 + 图标行 (双人棚拍, 无模特; sample 67-3): the tag, title, two lines, two facts, four round icons. */
const fabricSheet = (sample: string): Spec => ({
  sample, cells: 4, fabric: true,
  zones: f => [
    f.tags[0] && `左4% 上7% 宽30% 高5%：${f.light ? '深灰' : '白色'}细描边圆角胶囊，里面${ink(f)}字「${f.tags[0]}」，字高约占画面 2.5%。`,
    `左4% 上13% 宽58% 高9%：大标题「${f.title}」，${ink(f)}粗黑体，字高约占画面 7%；标题下面一条${soft(f)}短横线。`,
    f.sub && `左4% 上25% 宽50% 高7%：${soft(f)}细黑体「${f.sub}」，字高约占画面 3%。`,
    ...f.facts.slice(0, 2).flatMap((x, i) => [`左4% 上${40 + i * 18}% 宽24% 高3%：${soft(f)}细黑体「${x.label}」，字高约占画面 2.5%。`, `左4% 上${44 + i * 18}% 宽44% 高9%：${ink(f)}大号粗体字「${x.word}」，字高约占画面 7%。`]),
    f.facts.length > 1 && `左4% 上55% 宽36% 高1%：两组参数之间一条${soft(f)}细虚线。`,
    ...f.cells.map((c, i) => `左${[5, 29, 52, 76][i]}% 上78% 宽21% 高20%：${ink(f)}线描圆形图标，下方${ink(f)}字「${c.text}」，字高约占画面 2.8%${short(c.note) ? `；再下面一行${soft(f)}小字「${c.note}」，字高约占画面 1.8%` : ''}。`),
    '左4% 上78% 宽92% 高20%：四个图标之间用细细的竖线隔开。',
    '画面里没有任何人。',
  ],
  background: f => `整张铺满这件衣服${f.color}色的面料当背景（颜色照这次的面料，不照参考图的深蓝），有柔软起伏的大褶皱${f.cells.some(c => /水/.test(c.text + c.recipe)) ? '，表面散落大小水珠' : ''}；这一张只有面料，看不到领口、帽子、袖子、拉链、口袋，右半边也只有面料${f.cells.some(c => /水/.test(c.text + c.recipe)) ? '和水珠' : ''}。`,
});
/** 四格部位特写 + 格下一句话 + 右上英文角标 (暗黑科技, 双人棚拍; sample 11-4). */
const detailGrid = (sample: string, dark: boolean): Spec => ({
  sample, cells: 4,
  zones: f => [
    `左6% 上3% 宽64% 高9%：大标题「${f.title}」，${dark ? '白色' : '深色'}中粗黑体，字高约占画面 5.5%。`,
    `左78% 上4% 宽18% 高6%：右上角右对齐：${dark ? '琥珀色' : '深灰'}细体大写英文「CUSTOMIZE」（字高约占画面 1.6%），下面一行同色小箭头「>>>」。`,
    ...f.cells.map((c, i) => `左${[4, 52, 4, 52][i]}% 上${[15, 15, 57, 57][i]}% 宽46% 高${[36, 36, 35, 35][i]}%：格子：${c.recipe}${dark ? '，深色背景，衣服边缘有冷白高光' : ''}。`),
    ...f.cells.map((c, i) => `左${[4, 52, 4, 52][i]}% 上${[52, 52, 93, 93][i]}% 宽46% 高${[4, 4, 5, 5][i]}%：${['左上', '右上', '左下', '右下'][i]}格下方居中的${dark ? '浅灰' : '深灰'}细黑体「${short(c.note) ? `${c.text}，${c.note}` : c.text}」，字高约占画面 2.6%，清楚好读。`),
    '画面里没有任何人。',
  ],
  background: () => dark ? '深炭灰底，四个格子是稍浅一点的深灰圆角卡片，部位图贴满卡片（色调照这套母版的暗色，不照参考图的浅色）。' : '浅灰白纯色底，四个部位特写格子是圆角图片。',
});
/** 三张白卡片：左边字、右边部位图，右上英文角标 (上岗实拍, 无模特; sample 13-3). */
const detailRows = (sample: string): Spec => ({
  sample, cells: 3,
  zones: f => [
    `左6% 上3% 宽40% 高8%：大标题「${f.title}」，深灰黑中粗黑体，字高约占画面 5%。`,
    `左62% 上3% 宽32% 高8%：右上角右对齐的角标：深灰细体大写英文「DETAIL DISPLAY」（字高约占画面 1.8%），下面一行深灰细黑体「${f.sub || '品质细节看得见'}」（字高约占画面 1.8%），角标右边一条深色细竖线。`,
    ...f.cells.flatMap((c, i) => {
      const note = lines(c.note);
      return [
        `左5% 上${14 + i * 29}% 宽90% 高26%：第 ${i + 1} 张白色圆角卡片，有很轻的投影；卡片左边 38% 是白底文字区，右边 62% 是部位图，图片贴满卡片右半边。`,
        `左10% 上${19 + i * 29}% 宽26% 高16%：卡片左边文字：深灰黑中粗黑体「${c.text}」（字高约占画面 3.5%）${note.length ? `，下面${note.length}行深灰细黑体${note.map(x => `「${x}」`).join('')}（每行字高约占画面 2.3%）` : ''}。`,
        `左43% 上${14 + i * 29}% 宽52% 高26%：部位图：${c.recipe}，浅灰白背景，柔和光。`,
      ];
    }),
    '画面里没有任何人。',
  ],
  background: () => '很浅的冷灰白纯色底。',
});
/**
 * The closer (「6色可选」): the team doing something together at the set's place, under the master's
 * band; from the sample only the band and its words, never its studio line-up.
 */
const closer = (sample: string, band: string, words: string, style?: string): Spec => ({
  sample, cells: 0, people: true, photo: true,
  zones: f => [
    `左0% 上12% 宽100% 高88%：人物：${crowdLine(f.colors, f.castRef ? `参考图${f.castRef}` : '定妆照')}；站位和姿势不照示例图，示例图只学横条和字。`,
    !!f.logoRef && `左3% 上3% 宽18% 高10%：左上角放客户的 LOGO（照参考图${f.logoRef}），深灰单色，小小的。`,
    `左89% 上3% 宽6% 高${Math.min(30, 5 + f.all.length * 4)}%：${dots(f)}。`,
    `左2% 上73% 宽96% 高19%：横条：${band}，压在人物腿部前面。`,
    `左10% 上75% 宽80% 高9%：横条里水平居中的大标题「${f.title}」，白色${words}粗黑体，字高约占画面 6%。`,
    f.sub && `左14% 上86% 宽72% 高4%：大标题下面水平居中的一条白色细线和白色细黑体「${f.sub}」，字距略拉开，字高约占画面 2.6%；横条里的字整体居中，左右留白对称。`,
  ],
  background: f => `实景合影：${f.place || DEFAULT_PLACE}；背景有自然的景深虚化，人物和背景在同一种光下，不能像抠图拼上去。`, style,
});

export const SPECS: Record<string, Partial<Record<Task, Spec>>> = {
  M1: {
    首图: { sample: rival('6-1'), cells: 0, people: true, photo: true,
      zones: f => [
        `左0% 上0% 宽100% 高100%：人物：${f.who}穿着这件衣服，拉链拉到胸口，内搭白色 T 恤${f.act ? `；${f.act}` : ''}。`,
        `左48% 上52% 宽11% 高22%：工牌：脖子上挂一条浅灰挂绳，胸前垂一张竖向白色工牌卡，${f.badge ? `卡上印「${f.badge}」${f.badge.length}个深色字` : '卡上只有简单色块和线条，不写字'}。`,
        `左76% 上58% 宽17% 高22%：竖排粗宋体大标题「${f.title}」，深灰黑，从上到下一列，每个字高约占画面 9%。`,
        enOf(f.title) && `左84% 上55% 宽14% 高6%：竖排大标题右上方一行细细的深灰英文手写花体「${script(enOf(f.title))}」，比大字小很多，只当装饰。`,
        f.sub && `左79% 上80% 宽8% 高18%：竖排粗宋体「${f.sub}」，深灰黑，从上到下一列，每个字高约占画面 4.5%。`,
        enOf(f.title) && `左90% 上78% 宽3% 高20%：竖排一行极小的深灰细体大写英文「${enOf(f.title)} WORK JACKET」，字距拉开，字高约占画面 1.2%。`,
      ],
      background: f => f.scene ?? '实景：明亮的写字楼大堂，玻璃幕墙和前台大面积虚化、偏白。' },
    功能: { sample: rival('6-3'), cells: 4, photo: true,
      zones: f => [
        `左0% 上0% 宽100% 高42%：大演示格（下沿左右圆角）：纯黑底，镜头贴近这件衣服的肩部和帽子边缘，不画整件衣服；${f.cells[0].recipe}，冷白硬光。`,
        `左4% 上4% 宽40% 高8%：大标题「${f.title}」，白色细宋体（横细竖粗、优雅，不要粗黑体），字高约占画面 6.5%。`,
        ens(f).length > 0 && `左4% 上13% 宽44% 高3%：标题下面一条白色短横线，线下一行白色极小的细体大写英文「${ens(f).join(' · ')}」，字距拉开，字高约占画面 1.1%。`,
        f.sub && `左4% 上17% 宽40% 高4%：白色细黑体「${f.sub}」，字高约占画面 2.4%。`,
        `左2% 上45% 宽47% 高27%：圆角演示格：${f.cells[1].recipe}；格子左上角深灰宋体「${f.cells[1].text}」（字高约占画面 3.5%）${f.cells[1].en ? `，下面深灰极小大写英文「${f.cells[1].en}」（字高约占画面 1.1%）` : ''}。`,
        `左51% 上45% 宽47% 高53%：圆角演示格：${f.cells[2].recipe}；格子左下角深灰宋体「${f.cells[2].text}」（字高约占画面 3.5%）${f.cells[2].en ? `，下面深灰极小大写英文「${f.cells[2].en}」（字高约占画面 1.1%）` : ''}；右下角一个小小的白色斜线图标。`,
        `左2% 上74% 宽47% 高24%：圆角演示格：${f.cells[3].recipe}；格子左上角深灰宋体「${f.cells[3].text}」（字高约占画面 3.5%）${f.cells[3].en ? `，下面深灰极小大写英文「${f.cells[3].en}」（字高约占画面 1.1%）` : ''}。`,
        '画面里没有任何人。',
      ],
      background: f => `上方大演示格是纯黑底；下面三格是浅灰的${f.color}面料或部位特写；整张底色浅灰白，格子之间留细缝。` },
    细节: { sample: rival('12-3'), cells: 4,
      zones: f => [
        '左4% 上3% 宽16% 高4%：深灰实底圆角小胶囊，里面一个白色放大镜小图标和白色细体大写英文「DETAILS」，字高约占画面 1.6%。',
        `左4% 上9% 宽60% 高8%：大标题「${f.title}」，深灰黑中粗黑体，字高约占画面 6%。`,
        f.sub && `左4% 上19% 宽50% 高4%：深灰细黑体「${f.sub}」，字距拉开，字高约占画面 3%。`,
        `左4% 上26% 宽92% 高44%：大图：${f.cells[0].recipe}；左下角深灰实底小方标、白字「${f.cells[0].text}」，字高约占画面 2.8%。`,
        ...f.cells.slice(1).map((c, i) => `左${[4, 36, 68][i]}% 上72% 宽${[29, 29, 28][i]}% 高27%：小格：${c.recipe}；格子底部深灰实底小方标、白字「${c.text}」，字高约占画面 2.5%。`),
        '画面里没有任何人。',
      ],
      background: () => '浅灰纯色底。' },
    收口: closer(rival('2-1'), '深灰半透明圆角横条', ''),
  },
  M2: {
    首图: { sample: rival('30-1'), cells: 0, people: true, photo: true,
      zones: f => [
        `左0% 上0% 宽100% 高89%：人物：${f.who}穿着这件衣服${f.act ? `；${f.act}` : ''}。`,
        '左0% 上89% 宽100% 高11%：横条：底部一条横贯画面的琥珀色实底横条。',
        // The black block says 免费印绣 when the shop offers it (as on the sample), else the cover's tag.
        (f.badge || f.tags[0]) && `左2% 上90% 宽24% 高9%：横条左边一块纯黑色块，里面白色粗黑体「${f.badge || f.tags[0]}」。`,
        `左${f.badge || f.tags[0] ? 28 : 4}% 上90% 宽${f.badge || f.tags[0] ? 70 : 92}% 高9%：横条${f.badge || f.tags[0] ? '右边' : '里'}黑色粗黑体大字「${[f.title, f.sub].filter(Boolean).join(' ')}」。`,
      ],
      background: f => f.scene ?? '实景：汽修车间，背景机器隐没在暗处。' },
    功能: { sample: rival('21-4'), cells: 1,
      zones: f => [
        `左0% 上0% 宽100% 高100%：整幅演示：镜头贴得很近，只拍这件衣服的一侧肩膀、帽子边缘和胸口一角，不画整件衣服；${f.cells[0].recipe}。`,
        f.sub && `左3% 上6% 宽20% 高15%：左上角一个白色线描图标，下面${f.cells[0].en ? `一行白色细体大写英文「${f.cells[0].en}」，再下面` : ''}浅灰小字「${f.sub}」。`,
        (f.tags[0] || f.cells[0].en) && `左70% 上4% 宽26% 高6%：右上角琥珀色细描边圆角胶囊，里面白字「${f.tags[0] || f.cells[0].en}」。`,
        `左44% 上13% 宽52% 高11%：大标题「${f.title}」，白色粗黑体。`,
        '画面里没有任何人。',
      ],
      background: () => '纯黑底，只有这一处演示的高速特写。' },
    细节: detailGrid(rival('11-4'), true),
    收口: closer(rival('2-1'), '纯黑半透明圆角横条，上沿一条细细的琥珀色线', '',
      '色调深灰到纯黑，冷调；这一张多色合影是实景合影，靠横条和字保持暗黑科技的样子；字体标题白色粗黑体，笔画硬朗；说明字浅灰细黑体；标签和卡片纯黑半透明横条；琥珀色点缀；光正面柔光，人物边缘有一点冷色轮廓光。'),
  },
  M3: {
    首图: { sample: rival('49-1'), cells: 0, people: true, photo: true,
      zones: f => [
        `左0% 上0% 宽100% 高100%：人物：${f.who}穿着这件衣服，拉链拉到胸口，像抓拍、不看镜头${f.act ? `；${f.act}` : ''}。`,
        `左3% 上68% 宽38% 高22%：白色书法大字「${f.title}」：行书毛笔字，笔画粗细对比强、有连笔和尖锐的出锋，飘逸不粗笨，带很淡的投影，每个字高约占画面 14%。`,
        enOf(f.title) && `左8% 上80% 宽30% 高6%：大字下面压着一行半透明的浅铜棕色英文手写花体「${script(enOf(f.title))}」，比大字小很多，只当装饰。`,
        enOf(f.title) && `左6% 上88% 宽26% 高6%：两行白色细体大写英文「${enOf(f.title)}」「WORK JACKET」，字距拉开，字高约占画面 1.8%。`,
        f.sub && `左42% 上74% 宽52% 高9%：白色粗黑体「${f.sub}」，字高约占画面 7%。`,
        f.tags[0] && `左42% 上85% 宽52% 高5%：一条白色细横线，线下白色细黑体「${f.tags[0]}」，字距拉得很开${/\s/.test(f.tags[0].trim()) ? '，两组词之间用细斜杠隔开' : ''}，字高约占画面 2.3%。`,
      ],
      background: f => f.scene ?? '实景：工作现场。' },
    功能: { sample: rival('2-3'), cells: 4, fabric: true, photo: true,
      zones: f => [
        ...f.cells.map((c, i) => {
          const ink = i === 3 ? '深灰' : '白色', icons = ICON_WORDS[c.en];
          return `左${[0, 50, 0, 50][i]}% 上${[0, 0, 50, 50][i]}% 宽50% 高50%：${['左上', '右上', '左下', '右下'][i]}格（${['暗处，冷白侧光，背景压暗', '明亮的阴天户外柔光，背景虚化成灰绿山野', '暗调，暖色侧光', '明亮的自然光'][i]}）：${c.recipe}；左上角${c.en ? `${ink}中粗无衬线大写英文「${c.en}」（字高约占画面 3.5%），下面一行${ink}细黑体「${c.text}」（字高约占画面 2.6%）` : `${ink}粗黑体「${c.text}」（字高约占画面 3.5%）`}${icons ? `；格子下部一排三个${ink}细线描小图标，各自下面${ink}小字${icons.map(w => `「${w}」`).join('')}（字高约占画面 1.7%）` : ''}。`;
        }),
        '画面里没有任何人。',
      ],
      background: f => `四个等大方格紧挨着拼满整张图，格子之间没有缝；四格的光和明暗各不相同，拼在一起有节奏；每格主体都是${f.color}面料，可以有道具和手，不出现衣服的领口、帽子、袖子、拉链、口袋。` },
    细节: detailRows(rival('13-3')),
    收口: closer(rival('2-1'), '深棕色半透明直角横条', '规整'),
  },
  M4: {
    首图: { sample: rival('1-1'), cells: 0, people: true, photo: true,
      zones: f => [
        `左0% 上0% 宽100% 高100%：人物：${f.who}，两人都穿这件${f.color}的衣服，拉链拉到胸口；从头顶拍到臀部，两人脸部清楚。`,
        two(f.title)[1] ? `左68% 上8% 宽29% 高18%：两行深色粗黑体大字，右对齐：第一行「${two(f.title)[0]}」，第二行「${two(f.title)[1]}」；每个字高约占画面 7%。`
          : `左68% 上8% 宽29% 高18%：深色粗黑体大字「${f.title}」，右对齐，每个字高约占画面 7%。`,
        f.tags[0] && `左72% 上28% 宽24% 高5%：绿色圆角胶囊，里面白字「${f.tags[0]}」，字高约占画面 2.5%。`,
      ],
      background: () => '浅灰棚拍纯色底，从上到下轻微渐变，没有场景。' },
    功能: fabricSheet(rival('67-3')),
    细节: detailGrid(rival('11-4'), false),
    // The master's own look says no outdoor scene; its closer is the one picture shot where the set is.
    收口: closer(rival('2-1'), '深灰半透明圆角横条', '', '色调干净偏冷；字体标题深色粗黑体；说明字深灰细黑体；标签绿色圆角胶囊、白字；这一张多色合影是实景合影，光跟着实景走，不是棚拍。'),
  },
  M5: {
    // The user liked our own cover (主色、深色两行标题 + 粗字卖点 + 圆形图标) better than the competitor's small type (10-13).
    首图: { sample: '/listing-images/masters/M5-1.jpg', own: true, cells: 0,
      zones: f => [
        '左20% 上6% 宽72% 高90%：衣服：画面里没有人，这件衣服立体地“穿”在看不见的人身上（隐形人台），拉链拉开一点，帽子立起，略微侧转。',
        two(f.title)[1] ? `左3% 上12% 宽32% 高13%：两行大标题：第一行「${two(f.title)[0]}」用衣服主色 ${f.colors[0]?.hex ?? ''}，第二行「${two(f.title)[1]}」深色；粗黑体，每行字高约占画面 6%。`
          : `左3% 上12% 宽32% 高13%：大标题「${f.title}」，深色粗黑体，字高约占画面 6%。`,
        f.tags[0] && `左3% 上28% 宽26% 高7%：深色粗黑体「${f.tags[0]}」，字高约占画面 5%。`,
        ...f.tags.slice(1, 3).map((t, i) => `左3% 上${42 + i * 16}% 宽14% 高13%：深色线描圆形图标，下方深灰字「${t}」，字高约占画面 2.8%。`),
        '画面里没有任何人。',
      ],
      background: () => '纯白底，衣服下方有淡淡的落地投影。' },
    功能: fabricSheet(rival('67-3')),
    细节: detailRows(rival('13-3')),
    收口: { sample: rival('98-2'), cells: 0, photo: true,
      zones: f => [
        // A free-standing rack with both posts in the picture: told only to leave 5% each side, the end
        // sleeves still ran off the edge (10-18, 05/10/15/20/25/45); the posts keep the garments in.
        `左6% 上14% 宽88% 高66%：衣服：画面里没有人，${rack(f).length}件这款衣服挂在落地衣架的横杆上、两根立柱之间排成一排，从左到右依次是${rack(f).join('、')}，每件都正面朝前、等距挂好，彼此留一点空隙，不互相遮挡门襟和口袋；最左和最右两件的袖子离画面左右边缘至少 5%，整排衣服完整地在画面里。`,
        // The rack leaves room for the count only (「6色可选」), as on the sample.
        `左6% 上84% 宽46% 高9%：大标题「${f.title.replace(/^团体定制 · /, '')}」，深色粗黑体，字高约占画面 7%。`,
        `左54% 上84% 宽42% 高12%：${f.all.length} 个圆形色块 ${f.all.map(c => c.hex).join('、')}，各自下面一行深灰字${f.all.map(c => `「${c.name}」`).join('')}，字高约占画面 2.2%。`,
        '画面里没有任何人。',
      ],
      background: () => '实景挂拍：浅灰色墙面（照这里写的浅灰，不照参考图的深灰竖条纹墙），一个落地金属衣架：一根横杆架在左右两根立柱上，两根立柱和底座都完整在画面里，立柱离画面左右边缘各约 5%，横杆不伸出立柱；衣服都挂在两根立柱之间；柔和顶光，衣服的影子落在墙上。' },
  },
};

/** The spec for an image, when its master has one with as many cards as the plan gave it. */
export function specFor(master: string, task: Task, cells: number): Spec | null {
  const spec = SPECS[master]?.[task];
  return spec && spec.cells === cells ? spec : null;
}
/** The sample image's bytes, for the reference. */
export const sampleBytes = (spec: Spec) => readFile(path.join(process.cwd(), 'public', spec.sample));

/** What the prompt is told besides the fill: the image's place in the set and its references, in order. */
export type SpecInput = {
  master: string; task: Task; taskLabel: string; n: number; total: number; spec: Spec; fill: Fill;
  /** The garment's description (the writing step's), and what goes on the chest (null: nothing). */
  garment: string[]; logo: string | null;
  /** Reference numbers: the garment's (one per colour, or the piece of fabric), the cast, the customer's LOGO; the sample comes last. */
  refs: { garment: { name: string }[]; cast?: number; logo?: number; sample: number };
};
const bullet = (xs: (string | false | null | undefined)[]) => xs.filter((x): x is string => !!x).map(x => `- ${x}`).join('\n');
/** Half of the competitors' polish: not every line in the heaviest type. */
const TYPE = '字的层次：英文和说明小字用细体、字距略拉开，和大标题形成明显的大小、粗细对比；不要每行字都用最粗最黑的字；整张图留白充足，不挤。';
/** What made the covers look fake (trial9's epic mountains): asked for a real photograph instead. */
const PHOTO = '照片质感：真实的商业摄影，像全画幅相机 50mm 镜头实拍；主体清楚，背景有自然的景深虚化；有人时人物和背景在同一种光下（光的方向、色温一致），不能像抠图贴上去，皮肤有真实纹理、不磨皮；衣服有真实的褶皱和垂坠；色彩自然克制。不要 HDR、不要过度锐化、不要过饱和、不要电影海报式的戏剧天空和夸张特效。';

/** A main image's prompt from its master's spec, in the samples' own order and words. */
export function specPrompt(i: SpecInput) {
  const { spec, fill, refs } = i, cover = i.task === '首图', style = SPEC_STYLE[i.master];
  // A cover shot somewhere took the sample's pose and its bright showroom along with its layout (10-17): those are ours.
  const own = cover && spec.photo && !!fill.scene;
  const f: Fill = { ...fill, logoRef: refs.logo, ...(own ? {
    act: `${fill.act ? `${fill.act}；` : ''}人物的姿势、手的动作和机位不照参考图${refs.sample}，按这里写的重新拍`,
    scene: `${fill.scene}；背景的颜色、光线和地点都不照参考图${refs.sample}，按这里写的场景拍`,
  } : {}) };
  const refLines = [
    ...refs.garment.map((g, k) => spec.fabric ? `参考图${k + 1}：这件衣服「${g.name}」面料的一小块特写，只用来确定面料的颜色和纹理。` : `参考图${k + 1}：「${g.name}」的白底产品图，衣服的颜色和款式以它为准。`),
    !!refs.cast && `参考图${refs.cast}：模特定妆照，只用来确定模特长什么样；姿势、${spec.own ? '' : '光线、'}背景、构图按下面重新做。`,
    !!refs.logo && `参考图${refs.logo}：客户的 LOGO，只用来印在衣服胸口${spec.people && !cover ? '和放在左上角' : ''}。`,
    spec.own ? `参考图${refs.sample}：这套母版的示例图。版式、字体字号、配色、光影和背景的做法都照它；它是用别的衣服做的，图里的字、衣服颜色和款式、人物长相都不要照搬，一律以这次写的为准；卡片里画的衣服结构（夹层、填充、缝线、口袋、帽子等）也不要照它，只按产品图和给到的部位实拍画。`
      : `参考图${refs.sample}：一张同类商品卖得很好的主图（别家的店、别的衣服）。这一张就照它的做法：排版位置、字的大小和粗细层次（大标题、英文小字、说明小字、细线）、卡片和图标的质感、光影和照片质感都学它；图里的人、衣服、颜色和文字内容一律不要照搬，衣服结构（夹层、填充、缝线、口袋、帽子等）也不照它，以这次写的为准。`,
  ];
  const what = spec.fabric ? `面料：${f.color}，细密织纹、柔和哑光，颜色和纹理照参考图1。`
    : `衣服（必须和产品图一模一样）：\n${bullet([...i.garment,
      refs.garment.length > 1 ? `画面里每件衣服的颜色和对应参考图一致，${SAME_STYLE}；只能出现这 ${refs.garment.length} 种颜色。` : `颜色：${f.color}，和参考图一致，不偏色。`,
      i.logo ?? NO_CHEST, OWN_MARKS])}`;
  return `为淘宝制作一张冲锋衣团体定制商品主图，正方形 1:1。这是一套 ${i.total} 张里的第 ${i.n} 张：${i.taskLabel}。

参考图分工：
${bullet(refLines)}

${what}

版式（位置用画面百分比，按这里排）：
${bullet(spec.zones(f))}

背景：${spec.background(f)}
${cover ? style.cover : `整体风格（整套 5 张都一样）：${spec.style ?? style.all}`}
${spec.own ? '' : `${TYPE}\n`}${spec.photo ? `${PHOTO}\n` : ''}
${spec.own ? `不要：上面没写到的东西（不额外加${cover ? '' : '整件衣服、'}人、卡片、标签、图标）；另外加上的真实品牌 logo、水印；「」以外的任何文字；背景里不要浅色大号英文水印字。所有中文逐字正确、笔画清晰。`
    // The competitor's small things (corner words, icons, thin lines) are welcome; words of its own are not.
    : `不要：上面没写到的文字和人${cover || spec.people ? '' : '、整件衣服'}（参考图里的字一律不要照搬，英文只用上面写到的）；另外加上的真实品牌 logo、店名、水印；背景里大号英文水印字。所有中文逐字正确、笔画清晰。`}`;
}
