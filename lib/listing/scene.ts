/**
 * 电商主图 cover scene: on the masters whose cover is shot on location, the cover's picture is the
 * master's layout + where it is worn (地点, the plan's 穿在哪儿) + the cover's lead point, which the
 * picture acts out (防水: it rains and the jacket beads up). Two tables hold the rules; a new point or
 * place is one row. Tested on 2026-10-11 (output/listing-masters-20261008/trial9, trial10).
 */
import type { ServiceImageId } from './service';

/** How a point is acted out on the cover, and the cover's big words for it. */
export const SELLS = {
  // Weather shown by its marks (wet ground, beads, bent grass), not drawn rain streaks or racing clouds: those made the covers look fake (10-13).
  防水: { big: '防水', side: '冲锋衣定制', weather: '下着小雨，天色阴，地面湿漉漉的、有积水反光（雨很细，不画一道道粗白线）', show: '雨水打在衣服肩上和胸前，挂着一颗颗水珠、顺着面料滚落，看得出衣服不湿透', line: '下着雨，衣服上挂着水珠' },
  轻量透气: { big: '透气', side: '轻量冲锋衣', weather: '晴天，阳光明亮', show: '人在大步往前走，衣服随动作自然摆动，看起来轻盈、不闷热', line: '晴天，人大步走动' },
  防风: { big: '防风', side: '冲锋衣定制', weather: '起风了，柔和的阴天漫射光，路边的草和树枝被吹向一边', show: '风把衣角和帽子吹得鼓起来，衣服贴着身体挡住风', line: '大风天，衣角被风吹鼓' },
  耐磨: { big: '耐磨', side: '抗撕裂冲锋衣', weather: '白天，自然光', show: '人在干粗活，衣服蹭过粗糙的东西也完好无损', line: '人在干粗活，衣服完好' },
  保暖: { big: '保暖', side: '冲锋衣定制', weather: '冷天，空气清冷，呼出白气', show: '人在冷风里依然舒展，衣服把领口和袖口护得严实', line: '冷天，呼出白气' },
  防污: { big: '防污', side: '耐脏冲锋衣', weather: '室内', show: '油污或饮料溅到衣服上，在面料表面滚落，一擦就掉', line: '油污溅上去一擦就掉' },
} as const;
export type Sell = keyof typeof SELLS;

type Place = { image: string; name: string; where: string; act: string; fits: Sell[]; outdoorLeisure?: boolean; bright?: boolean; actFor?: Partial<Record<Sell, string>> };
/** Where the cover is shot: the background, what people there do, and the points that fit it. */
export const PLACES = {
  登山: { image: '/listing-images/places/hike.jpg', name: '登山徒步', where: '山间徒步步道，身后是虚化的树林和山坡（不出现远处雪山和壮阔大景，只是普通的林间小路）', act: '背着双肩登山包，一只手握着登山杖', fits: ['轻量透气', '防风', '防水', '保暖'], outdoorLeisure: true, bright: true, actFor: { 耐磨: '手扶着粗糙的岩石往上攀' } },
  工地: { image: '/listing-images/places/site.jpg', name: '工地', where: '建筑工地，身后是脚手架和塔吊', act: '一只手拿着卷起来的图纸，另一只手拿着对讲机', fits: ['耐磨', '防风', '防水'], bright: true, actFor: { 耐磨: '肩上扛着一根钢管往前走' } },
  餐饮: { image: '/listing-images/places/food.jpg', name: '餐饮门店', where: '餐厅或咖啡店里，身后是吧台和餐具', act: '一只手端着放了一杯外带咖啡的托盘', fits: ['防污', '防水'], actFor: { 防水: '刚从雨里进店，衣服肩上挂着水珠' } },
  汽修: { image: '/listing-images/places/garage.jpg', name: '汽修车间', where: '汽修车间，旁边是打开的汽车发动机舱和工具车', act: '戴着工作手套', fits: ['耐磨', '防污'], actFor: { 耐磨: '单膝跪在粗糙的水泥地上修车，手里拿着扳手' } },
  写字楼: { image: '/listing-images/places/office.jpg', name: '写字楼', where: '明亮的写字楼大堂，玻璃幕墙和前台虚化', act: '双手自然下垂', fits: ['防水', '轻量透气', '防风'], bright: true, actFor: { 防水: '玻璃门外正下着雨，人刚从雨里走进大堂，衣服肩上挂着水珠' } },
  工厂: { image: '/listing-images/places/factory.jpg', name: '工厂车间', where: '整洁的工厂车间，身后是设备和货架', act: '一只手拿着平板电脑巡检', fits: ['耐磨', '防污', '保暖'] },
  '4S店': { image: '/listing-images/places/car.jpg', name: '4S 店', where: '明亮的汽车 4S 店展厅，身后是锃亮的新车和玻璃幕墙，大面积虚化', act: '一只手拿着平板电脑给客户讲解', fits: ['防水', '轻量透气', '防风'], bright: true, actFor: { 防水: '展厅玻璃门外正下着雨，人刚从雨里走进来迎客，衣服肩上挂着水珠' } },
  物业: { image: '/listing-images/places/estate.jpg', name: '物业小区', where: '整洁的住宅小区门口，身后是门岗、道闸和绿化', act: '一只手拿着对讲机', fits: ['防水', '防风', '保暖'], actFor: { 防水: '下着雨，人在小区门口巡查，衣服肩上和胸前挂着水珠' } },
  团建: { image: '/listing-images/places/team.jpg', name: '户外团建', where: '开阔的郊野草坪，远处是树林和几顶帐篷', act: '一只手拉着团队旗帜的一角', fits: ['轻量透气', '防风', '防水'], outdoorLeisure: true, bright: true },
} as const satisfies Record<string, Place>;
export type PlaceId = keyof typeof PLACES;
export const PLACE_IDS = Object.keys(PLACES) as PlaceId[];

/**
 * What each master needs from the plan: whether its cover is shot on location (only then is a place
 * chosen), which places it cannot use and why, and which of the shop's service images it shows.
 */
/** How the cover frames the model on the masters shot on location (tested in trial9/trial10). */
const CHEST = '取景是胸前特写，画面上沿切在鼻子到下巴之间，看不到眼睛和额头，衣服占画面大半';
export const MASTER_INFO: Record<string, { cover: '实景' | '棚拍' | '无人'; fit: string; font: string; palette: string[]; dark?: boolean; deny: Partial<Record<PlaceId, string>>; service: ServiceImageId; crop?: string }> = {
  M1: { cover: '实景', fit: '4S 店、科技公司、销售团队', font: '首图竖排粗宋体，其余黑体', palette: ['#E9EBEC', '#C9CED3', '#2A2F36', '#5D7A99'], deny: { 登山: '户外休闲不挂工牌', 团建: '户外休闲不挂工牌' }, service: 'A-light', crop: CHEST },
  M2: { cover: '实景', fit: '三防、防水功能多的款', font: '白色粗黑体', dark: true, palette: ['#0E1013', '#2B2F35', '#FFFFFF', '#E8A13A'], deny: { 登山: '明亮户外会丢掉科技感', 工地: '明亮户外会丢掉科技感', 写字楼: '明亮场景会丢掉科技感', '4S店': '明亮场景会丢掉科技感', 团建: '明亮户外会丢掉科技感' }, service: 'A-dark', crop: CHEST },
  M3: { cover: '实景', fit: '工地、餐饮、汽修、户外，哪里都行', font: '首图毛笔字，其余黑体', palette: ['#B8242A', '#F3E6D3', '#1D1D1D', '#E07B2E'], deny: {}, service: 'D-warm', crop: CHEST },
  M4: { cover: '棚拍', fit: '男女同款、年轻团队', font: '粗黑体', palette: ['#F4F6F8', '#A9C4DE', '#2F3B4A', '#7FA36B'], deny: {}, service: 'B-light' },
  M5: { cover: '无人', fit: '不想用模特、想省积分', font: '粗黑体，重点字用主色', palette: ['#F2F2F0', '#DADBD6', '#20262E', '#1E9DB0'], deny: {}, service: 'A-light' },
};
export const masterInfo = (id: string) => MASTER_INFO[id] ?? MASTER_INFO.M1;

const luma = (hex: string) => { const n = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0; return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); };
/**
 * The colour whose fabric fills an image of fabric only: the lightest on a light master, the darkest
 * on the dark one (暗黑科技), so the image keeps the master's look. Every colour of a garment is the same fabric.
 */
export function fabricColor<C extends { hex: string }>(master: string, colors: C[]): C | undefined {
  const dark = !!masterInfo(master).dark;
  return [...colors].sort((a, b) => dark ? luma(a.hex) - luma(b.hex) : luma(b.hex) - luma(a.hex))[0];
}

/** The point a cover leads with, read from the plan's points (三防面料 counts as 防水). */
export function sellOf(text: string): Sell | null {
  if (/防水|三防|拒水|防雨/.test(text)) return '防水';
  if (/透气|轻量|轻薄/.test(text)) return '轻量透气';
  if (/防风/.test(text)) return '防风';
  if (/耐磨|抗撕裂|耐穿/.test(text)) return '耐磨';
  if (/保暖|锁温/.test(text)) return '保暖';
  if (/防污|耐脏|防油/.test(text)) return '防污';
  return null;
}

/** The cover's picture in words, for the page (line) and the prompt (bg, person); hint when the point does not fit the place. */
export function coverScene(place: PlaceId, sell: Sell) {
  const p: Place = PLACES[place], s = SELLS[sell], act = p.actFor?.[sell];
  const fits = p.fits.includes(sell);
  return {
    line: `${p.name}，${act ?? `${s.line}，${p.act}`}`,
    bg: `实景：${p.where}；${s.weather}`, person: `${act ?? p.act}；${s.show}`, big: s.big, side: s.side,
    hint: fits ? '' : `「${sell}」在${p.name}不好演，建议换成${p.fits.join('、')}；或者把地点换掉`,
  };
}
/** The best point for a place among the ticked ones, in the order the plan ranks them. */
export function bestSell(place: PlaceId, ticked: string[]): Sell | null {
  const sells = ticked.map(sellOf).filter((s): s is Sell => !!s);
  return sells.find(s => (PLACES[place].fits as readonly Sell[]).includes(s)) ?? sells[0] ?? null;
}
