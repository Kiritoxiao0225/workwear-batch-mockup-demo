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

export type ListingLayout = { id: string; name: string; description: string; samples: string[]; style: string };
export const LISTING_LAYOUTS: ListingLayout[] = [
  {
    id: 'warm-impact', name: '爆款暖光', description: '毛笔大标题、底部压暗、主色卖点标签、暖色逆光',
    samples: ['/listing-images/square-1.webp', '/listing-images/square-3.webp', '/listing-images/sku-K1.webp'],
    style: '淘宝爆款风格：每张一个超大白色粗犷毛笔书法主标题，画面下方压一层由透明到深色的渐变承托文字；卖点用衣服主色的醒目飘带或圆角标签；暖色侧逆光、背景虚化成光斑；画面直观演示卖点（如水珠演示防泼水）。',
  },
  {
    id: 'commute-split', name: '通勤质感分栏', description: '粗黑标题、分栏信息卡、柔和自然光',
    samples: ['/listing-images/layout-commute-1.webp', '/listing-images/layout-commute-2.webp', '/listing-images/layout-commute-3.webp'],
    style: '通勤质感风格：主标题用粗黑无衬线字体，信息放在浅色半透明圆角卡片和分栏里；以衣服主色为视觉中心，背景是低饱和、轻虚化的现代室内空间；柔和侧向自然光；标签用主色加深色的圆角胶囊。',
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
