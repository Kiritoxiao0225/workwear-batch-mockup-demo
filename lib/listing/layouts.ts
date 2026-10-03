/**
 * 电商主图: what a project produces and the built-in layouts. Shared by the page and the server.
 * A layout decides how images look; the product's own plan decides what they say.
 */
import { z } from 'zod';

export const MAIN_ROLES = {
  首图: '一句话定位 + 1–2 个最强卖点；衣服要大（模特可裁到下巴），字要少，为搜索列表里的点击服务',
  功能: '面料与功能卖点（如防护、透气、耐磨），模特 + 图标式要点',
  细节: '做工细节特写（领口、袖口、拉链等），多格特写，每格一句短标注',
  实用: '实用设计（口袋、活动方便等），动作场景 + 局部放大',
  收口: '推动下单：多色可选 / 适用人群岗位 / 定制与服务，多人多色并排',
} as const;
export type MainRole = keyof typeof MAIN_ROLES;

/** Roles in buying-decision order: the first is always the cover, the last always the closer. */
export function rolesFor(count: number): MainRole[] {
  const all = Object.keys(MAIN_ROLES) as MainRole[];
  const picks: Record<number, MainRole[]> = { 0: [], 1: ['首图'], 2: ['首图', '收口'], 3: ['首图', '功能', '收口'], 4: ['首图', '功能', '细节', '收口'] };
  return picks[count] ?? all.slice(0, count);
}

export const countsSchema = z.object({
  square: z.number().int().min(0).max(5),
  portrait: z.number().int().min(0).max(5),
  poster: z.number().int().min(0).max(1),
}).refine(c => c.square + c.portrait + c.poster > 0, '至少要出一张主图');
export type ListingCounts = z.infer<typeof countsSchema>;
export const DEFAULT_COUNTS: ListingCounts = { square: 5, portrait: 5, poster: 1 };

/** `roles` say where things go on each kind of image; the words come from the product's own plan. */
export type ListingLayout = { id: string; name: string; description: string; samples: string[]; style: string;
  roles: Record<MainRole | '海报', string>; sku: string };
export const LISTING_LAYOUTS: ListingLayout[] = [
  {
    id: 'warm-impact', name: '爆款暖光', description: '毛笔大标题、底部压暗、主色卖点标签、暖色逆光',
    samples: ['/listing-images/square-1.webp', '/listing-images/square-3.webp', '/listing-images/sku-K1.webp'],
    style: '淘宝爆款风格：每张一个超大白色粗犷毛笔书法主标题，画面下方压一层由透明到深色的渐变承托文字；卖点用衣服主色的醒目飘带或圆角标签；暖色侧逆光、背景虚化成光斑；画面直观演示卖点（如水珠演示防泼水）。',
    roles: {
      首图: '模特正面站立、镜头略微仰拍，画面上边缘切在下巴，不露眼睛和头发；衣服占画面约 75%，领口、拉链、口袋完整清楚。画面下方 40% 由透明到近黑渐变，上面压超大白色毛笔书法主标题，横跨画面宽度；主标题左上方斜放一个主色飘带标签，右上方一个白底主色字圆角标签；主标题下方一行白色副标题。',
      功能: '上方约 20% 放横跨画面的白色毛笔大标题；中间是模特半身，正在用动作演示这张图的卖点；画面一侧上下排列两个线描图标，各配一个主色标签；底部深色渐变条放副标题。',
      细节: '无模特全身。上方约 18% 放白色毛笔大标题，压深色底；中间一大两小三格衣服局部特写（领口、袖口、拉链等）；每格下沿一个主色短标签；底部一行副标题。',
      实用: '顶部超大白色毛笔标题；中央模特做演示卖点的动作（比如把手机放进口袋）；右下角一个圆角局部放大框，用细线连到演示部位；底部深色渐变上放副标题和主色标签。',
      收口: '顶部超大白色毛笔标题；中间几位模特并排站立、男女交替，每人穿一种颜色，下摆和口袋可见；人物下方一排圆形色块，每个色块下写颜色名；底部近黑渐变上放副标题和主色标签。',
      海报: '竖版海报：上方约 15% 是暖色光斑，左上两行超大白色毛笔标题；中间一男一女从头顶到膝盖、向前行走，衣服是视觉中心；底部深色渐变上放副标题和一个主色标签。',
    },
    sku: '干净的浅色背景（浅暖灰到白的柔和渐变），棚拍柔光，没有场景和道具。一男一女并排，从头顶拍到大腿中部，男生外套敞开、内搭白色 T 恤，女生拉链拉到领口，两件衣服占画面约 75%。左上角大号粗体颜色名，下面一个主色圆角小标签；左下角一个圆角小方框，里面是同色面料微距特写，方框下方一行小字。',
  },
  {
    id: 'commute-split', name: '通勤质感分栏', description: '粗黑标题、分栏信息卡、柔和自然光',
    samples: ['/listing-images/layout-commute-1.webp', '/listing-images/layout-commute-2.webp', '/listing-images/layout-commute-3.webp'],
    style: '通勤质感风格：主标题用粗黑无衬线字体，信息放在浅色半透明圆角卡片和分栏里；以衣服主色为视觉中心，背景是低饱和、轻虚化的现代室内空间；柔和侧向自然光；标签用主色加深色的圆角胶囊。',
    roles: {
      首图: '单人正面站姿，画面从下颌附近裁到大腿上部，衣服居中略偏右、占画面约 70%。底部约四分之一由透明到深色渐变；超大笔刷主标题错落压在画面下方；标题上沿叠一个主色胶囊标签；标题下方一行小号副标题。',
      功能: '人物在画面右侧约三分之二，从头顶拍到大腿；左侧是竖向信息栏：顶部粗黑主标题和一行小号副标题，下面上下两个浅色圆角卡片，上卡放这件衣服的正面产品图，下卡放演示卖点的局部特写，卡片底部各一行小字；右上角一个窄竖条标签，文字竖排。',
      细节: '无人物。顶部居中粗黑主标题、一行小号副标题和一个主色小标签；中部一张横向大幅局部特写，下方左右两张等大的局部特写；每张特写左下角半透明说明底上放一句短标注。',
      实用: '顶部单行超大粗黑标题；中间人物低头、做演示卖点的动作；底部一张横向圆角信息卡，左半是衣服局部近景，右半深色半透明底上三行带勾选图标的要点。',
      收口: '顶部浅色实底标题区，放粗黑主标题和一行副标题；中间几位模特并排，中间的略靠前；底部浅色实底分成几栏，每栏一个圆形色点和颜色名。',
      海报: '竖版海报：人物从头顶到膝盖，衣服居中；底部约四分之一由透明到深色渐变，超大笔刷主标题压在下方，标题上沿一个主色胶囊标签，下面一行小号副标题。',
    },
    sku: '双人并排，从头顶拍到大腿上部，身体正面或轻微侧转，衣服正面充分展示；背景是低饱和、轻虚化的现代室内空间，柔和侧光。左上角一个半透明圆角面板：左边一条竖向短色条，右边大号粗黑颜色名，下面一个由主色向右淡出的胶囊款式标签；左下角一张面料微距方形卡片，轻圆角，卡片下方一行小字。',
  },
];
export const layoutById = (id: string) => LISTING_LAYOUTS.find(layout => layout.id === id);

export const ASSET_ROLES = ['主图', 'SKU', '详情', '尺码表', '不用'] as const;
export type AssetRole = (typeof ASSET_ROLES)[number];

/** Taobao main images are 1:1 or 3:4 only, so the shape is measured, never guessed. */
export function shapeOf(width: number, height: number): '1:1' | '3:4' | '其他' {
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.02) return '1:1';
  if (Math.abs(ratio - 0.75) < 0.02) return '3:4';
  return '其他';
}
