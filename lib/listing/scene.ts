/**
 * 电商主图 cover scene: on the masters whose cover is shot on location, the cover's picture is the
 * master's layout + where it is worn (地点, the plan's 穿在哪儿) + the cover's lead point, which the
 * picture acts out (防水: it rains and the jacket beads up). Two tables hold the rules; a new point or
 * place is one row. Tested on 2026-10-11 (output/listing-masters-20261008/trial9, trial10).
 */
import type { ServiceImageId } from './service';

/**
 * How a point is acted out on the cover, and the cover's big words for it. Fifty sets in a row all
 * said 「防水 / 冲锋衣定制」 (10-17): each point has a few two-character words (the masters' vertical
 * and calligraphy titles fit two) and small lines, and a set takes one of them by its seed.
 */
export const SELLS = {
  防水: { big: '防水', side: '冲锋衣定制', titles: ['防水', '拒水', '防雨'], subs: ['冲锋衣定制', '团体定制', '工服定制'], show: '雨水打在衣服肩上和胸前，挂着一颗颗水珠、顺着面料滚落，看得出衣服不湿透', line: '下着雨，衣服上挂着水珠' },
  轻量透气: { big: '透气', side: '轻量冲锋衣', titles: ['透气', '轻薄', '轻盈'], subs: ['轻量冲锋衣', '轻量工服', '通勤工服'], show: '人在大步往前走，衣服随动作自然摆动，看起来轻盈、不闷热', line: '晴天，人大步走动' },
  // No hood here: a cover of a stand-collar jacket grew one (10-17).
  防风: { big: '防风', side: '冲锋衣定制', titles: ['防风', '挡风'], subs: ['冲锋衣定制', '团体定制'], show: '风把衣角和袖子吹得贴向身体一侧，衣服挡住了风', line: '大风天，衣角被风吹动' },
  耐磨: { big: '耐磨', side: '抗撕裂冲锋衣', titles: ['耐磨', '耐造'], subs: ['抗撕裂冲锋衣', '耐穿工服'], show: '人在干粗活，衣服蹭过粗糙的东西也完好无损', line: '人在干粗活，衣服完好' },
  保暖: { big: '保暖', side: '冲锋衣定制', titles: ['保暖', '锁温'], subs: ['冲锋衣定制', '冬季工服'], show: '人在冷风里依然舒展，衣服把领口和袖口护得严实', line: '冷天，呼出白气' },
  防污: { big: '防污', side: '耐脏冲锋衣', titles: ['防污', '耐脏'], subs: ['耐脏冲锋衣', '好打理工服'], show: '油污或饮料溅到衣服上，在面料表面滚落，一擦就掉', line: '油污溅上去一擦就掉' },
} as const;
export type Sell = keyof typeof SELLS;

/**
 * One way a place looks: its colours, its light and its weather, in things a camera would find there.
 * Every cover had been a bright white showroom (the sample's light), blurred to cream (10-17).
 * `sells`: the points it can act out (rain for 防水); `dark`: low-key, the only kind 暗黑科技 takes.
 */
type Look = { name: string; text: string; sells: Sell[]; dark?: boolean };
type Place = { image: string; name: string; fits: Sell[]; acts: string[]; looks: Look[]; actFor?: Partial<Record<Sell, string>> };
const RAIN = '（雨很细，不画一道道粗白线）';
/** Where the cover is shot: what people there do, how it looks, and the points that fit it. */
export const PLACES = {
  登山: { image: '/listing-images/places/hike.jpg', name: '登山徒步', fits: ['轻量透气', '防风', '防水', '保暖'], actFor: { 耐磨: '手扶着粗糙的岩石往上攀' },
    acts: ['背着双肩登山包，一只手握着登山杖', '背着双肩包，一只手拉着肩带，另一只手握着登山杖', '背着双肩包，一只手拿着保温水壶', '背着双肩包，一只手轻轻整理领口'],
    looks: [
      { name: '晨雾林道', sells: ['轻量透气', '耐磨'], text: '山间徒步步道，清晨的薄雾还没散，身后是松林、湿润的土路和路边的蕨草；整体青绿、雾灰色调，柔和的晨光从树缝里斜照下来' },
      { name: '秋日山脊', sells: ['轻量透气', '防风'], text: '山脊上的徒步小路，身后是金黄、橙红的秋季灌木和远处层叠的山，起了风，草和灌木被吹向一边；整体暖黄、橙褐色调，下午低角度的侧光' },
      { name: '雨中林道', sells: ['防水'], text: `下着小雨的林间步道，石阶和树干被打湿发暗，身后的树林罩着一层水汽；整体深绿、灰色调，阴天的漫射光${RAIN}` },
      { name: '碎石垭口', sells: ['防风', '保暖'], text: '高处碎石垭口旁的步道，身后是灰色的岩石坡、低矮的草和压得很低的云，风很大，空气清冷、呼出白气；整体冷灰、灰蓝色调，阴天的漫射光' },
      { name: '雪后营地', sells: ['保暖'], text: '山里的营地边，地上有薄薄的积雪，身后是帐篷和冒着热气的炉子，空气清冷、呼出白气；整体白、灰蓝加一点帐篷的暖色，清早的冷光' },
    ] },
  工地: { image: '/listing-images/places/site.jpg', name: '工地', fits: ['耐磨', '防风', '防水'], actFor: { 耐磨: '肩上扛着一根钢管往前走' },
    acts: ['一只手拿着卷起来的图纸，另一只手拿着对讲机', '一只手把安全帽夹在腰侧', '一只手拿着平板电脑核对进度', '戴着工作手套，一只手拎着工具包'],
    looks: [
      { name: '晴天脚手架', sells: ['耐磨'], text: '建筑工地，身后是搭着绿色安全网的脚手架和塔吊，地上有钢筋和沙堆；整体土黄、灰绿色调，晴天上午的阳光，影子清楚' },
      { name: '雨天工棚', sells: ['防水'], text: `下着小雨的工地，人站在工棚边，身后是湿漉漉的泥地、积水和远处的塔吊；整体灰褐、冷灰色调，阴天的漫射光${RAIN}` },
      { name: '起风楼面', sells: ['防风'], text: '在建楼的楼面边上，身后是裸露的混凝土柱子、钢筋和远处的城市，起风了，安全网被吹得鼓起来；整体混凝土灰、灰蓝色调，阴天的光' },
      { name: '黄昏收工', sells: ['耐磨', '防风'], text: '傍晚收工时的工地，身后是逆光里的塔吊和脚手架剪影，地面有车辙；整体橙褐、暖灰色调，夕阳低低地从一侧照过来' },
      { name: '材料堆场', sells: ['耐磨'], text: '工地的材料堆场，身后是成捆的钢管、木模板和一台小挖机；整体木色、黄色加灰色，阴天柔和的光' },
    ] },
  餐饮: { image: '/listing-images/places/food.jpg', name: '餐饮门店', fits: ['防污', '防水'],
    acts: ['一只手端着放了一杯外带咖啡的托盘', '双手捧着一个装着餐品的托盘', '一只手拿着点单的平板，另一只手自然垂下', '一只手拎着打包好的外卖袋'],
    looks: [
      { name: '早上吧台', sells: ['防污'], text: '咖啡店的吧台后，身后是咖啡机、磨豆机和一排杯子；整体木色、奶咖色调，早上的阳光从窗户斜照进来' },
      { name: '雨天进店', sells: ['防水'], text: '餐厅门口，人刚从雨里进店，身后玻璃门上挂着雨滴，门外街道湿亮、有人撑伞走过；整体是门外的冷灰和店里暖黄灯光的对比' },
      { name: '后厨出餐口', sells: ['防污'], dark: true, text: '餐厅后厨的出餐口，身后是不锈钢台面、挂着的锅铲和冒着热气的灶台；整体不锈钢冷灰加灶火的暖橙，顶上的白色灯管光，暗处偏暗' },
      { name: '夜晚堂食', sells: ['防污', '防水'], dark: true, text: '晚上的餐厅堂食区，身后是木桌、低垂的吊灯和零星的客人，窗外下着雨、玻璃上挂着雨滴；整体暖褐、深色调，暖黄吊灯的光' },
      { name: '商场档口', sells: ['防污'], text: '商场里的轻食档口，身后是浅色瓷砖墙、冷柜和打包台；整体白、浅绿色调，商场明亮的顶灯' },
    ] },
  汽修: { image: '/listing-images/places/garage.jpg', name: '汽修车间', fits: ['耐磨', '防污'], actFor: { 耐磨: '单膝跪在粗糙的水泥地上修车，手里拿着扳手' },
    acts: ['戴着工作手套', '戴着工作手套，一只手拿着扳手', '一只手拿着平板电脑看检测数据', '一只手拿着一块擦车毛巾'],
    looks: [
      { name: '车间工位', sells: ['耐磨', '防污'], dark: true, text: '汽修车间的工位，旁边是打开的发动机舱和红色工具车，地面是带油渍的灰色环氧地坪；整体灰色、工具红点缀，顶上的白色灯管光，车间深处偏暗' },
      { name: '举升机下', sells: ['耐磨'], dark: true, text: '汽修车间，身后是举升机上抬起的一辆车、底盘和挂着的气管；整体深灰、冷白色调，一盏工作灯从侧面打过来，角落压暗' },
      { name: '卷帘门口', sells: ['耐磨', '防污'], text: '汽修店的卷帘门口，身后是半开的卷帘门、门口停着的车和堆着的轮胎；整体灰蓝、黑色调，门外白天的自然光照进来' },
      { name: '洗车区', sells: ['防污', '防水'], text: '汽修店的洗车区，地面湿漉漉的、有水渍和泡沫，身后是挂着水珠的车和水管；整体冷蓝、灰色调，阴天的自然光' },
      { name: '配件间', sells: ['耐磨', '防污'], dark: true, text: '汽修店的配件间，身后是摆满零件盒和机油的铁货架；整体暗灰、橙色点缀，一盏暖色台灯和窗外透进来的冷光' },
    ] },
  写字楼: { image: '/listing-images/places/office.jpg', name: '写字楼', fits: ['防水', '轻量透气', '防风'],
    acts: ['双手自然下垂', '一只手把一台合上的笔记本电脑夹在身侧', '一只手端着一杯外带咖啡，正从门口走过', '一只手捏着胸前的拉链头往上拉', '双手轻轻整理领口两边'],
    looks: [
      { name: '梧桐人行道', sells: ['轻量透气'], text: '写字楼外的人行道，头顶是梧桐树，阳光穿过树叶在人身上和地面落下斑驳的光点，身后是路边的自行车、绿化带和远处走过的行人；整体暖绿、米黄色调' },
      { name: '石材门廊', sells: ['防水'], text: '写字楼入口的门廊下，深色花岗岩墙面和石材地面被雨打湿，门廊外下着小雨，远处有人撑伞走过；整体深灰冷调，门廊顶上的筒灯给人物一点暖色' },
      { name: '露台黄昏', sells: ['防风'], text: '写字楼的屋顶露台，黄昏起风了，身后是栏杆、几盆被风吹弯的绿植和远处的楼群，天空是粉橙色渐变；整体粉橙暖色调，逆光，人物边缘有一圈暖光' },
      { name: '茶水间', sells: ['轻量透气'], text: '写字楼里的开放茶水间，身后是浅木色的吧台、一排绿植、咖啡机和挂着的马克杯，早上的阳光从侧面的窗户斜照进来；整体米色、浅木色和绿色' },
      { name: '雨天大堂', sells: ['防水'], text: '写字楼大堂的旋转门里面，门外正下着雨、玻璃上挂着雨滴，身后地面上有几道湿脚印和一把收起的伞；整体冷灰、浅米色调，大堂的暖色筒灯和门外的阴天光混在一起' },
      { name: '广场起风', sells: ['防风'], text: '写字楼前的广场，身后是石材台阶、行道树和远处的玻璃楼，起风了，树枝被吹向一边；整体冷灰、灰绿色调，阴天柔和的光' },
    ] },
  工厂: { image: '/listing-images/places/factory.jpg', name: '工厂车间', fits: ['耐磨', '防污', '保暖'],
    acts: ['一只手拿着平板电脑巡检', '一只手拿着写字板在记录', '戴着工作手套，一只手扶着设备的护栏', '一只手拿着对讲机'],
    looks: [
      { name: '装配线', sells: ['耐磨', '防污'], text: '整洁的工厂装配线旁，身后是浅绿色地坪、黄色安全线和成排的设备；整体浅绿、灰白色调、黄色点缀，顶上一排排白色灯管光' },
      { name: '仓库货架', sells: ['耐磨'], dark: true, text: '工厂仓库，身后是高高的蓝色货架、纸箱和一台叉车；整体蓝灰、牛皮纸色调，高窗透进来的光束，过道深处偏暗' },
      { name: '冬天厂区', sells: ['保暖'], text: '冬天清早的厂区道路，身后是厂房的铁皮外墙和路边的枯树，空气清冷、呼出白气；整体冷灰、灰蓝色调，低低的冬日阳光' },
      { name: '设备间', sells: ['耐磨', '防污'], dark: true, text: '工厂的设备间，身后是管道、仪表盘和金属机柜；整体深灰、金属冷色调，一盏工作灯从侧面打过来，四周偏暗' },
      { name: '车间门口', sells: ['保暖', '耐磨'], dark: true, text: '车间的大门口，身后是半开的大铁门、里面的设备和门口的叉车，门外是阴冷的天；整体深灰、橙黄色点缀，门里的暖色灯光和门外的冷光对比' },
    ] },
  '4S店': { image: '/listing-images/places/car.jpg', name: '4S 店', fits: ['防水', '轻量透气', '防风'],
    acts: ['一只手拿着平板电脑给客户讲解', '一只手把一把车钥匙递向镜头，钥匙在前景微微虚化', '一只手扶着身旁一辆车打开的车门上沿', '双手在腰前拿着一个打开的黑色文件夹', '一只手轻轻捏着胸前工牌的下沿'],
    looks: [
      { name: '雨天停车坪', sells: ['防水'], text: `4S 店门口的露天停车坪，下着小雨，深灰色的湿沥青地面映着倒影，身后停着几辆沾了雨水的车，再远是展厅和一排深绿色的灌木；整体冷灰、灰绿色调，阴天的漫射光${RAIN}` },
      { name: '傍晚门口', sells: ['轻量透气'], text: '傍晚的 4S 店展厅门口，夕阳从画面一侧低低地照过来，人物一侧被照成暖金色，身后玻璃上映着橙粉色的天空，路灯刚亮；整体暖金、橙色调' },
      { name: '售后车间', sells: ['防风'], text: '4S 店售后车间的门口，身后是举升机上抬起的一辆车、工具车和灰蓝色的环氧地坪，卷帘门半开，外面起风了，路边的树被吹得歪向一边；整体灰蓝工业色调，车间的白色灯管光混着门外的阴天光' },
      { name: '洽谈区', sells: ['防水'], text: '4S 店展厅里的客户洽谈区，身后是胡桃木色的洽谈桌、米色皮椅、桌上的茶杯和资料，头顶暖黄色的吊灯亮着，窗外下着雨、天色偏蓝；整体暖木色调，室内暖光和窗外冷光混在一起' },
      { name: '深色展厅', sells: ['轻量透气'], dark: true, text: '高端品牌的深色展厅，深灰色墙面和黑色亮面地砖，顶上一束束射灯打在身后一辆深色展车上，车身有一道道高光；整体深灰暗调，人物被一盏柔和的主灯照亮' },
      { name: '蓝调门口', sells: ['防水'], text: `天刚黑的蓝调时刻，4S 店门口的雨棚下，下着细雨、地面湿亮，展厅里透出暖黄色的灯光，天空是深蓝色；整体冷蓝和暖黄的对比${RAIN}` },
      { name: '门口起风', sells: ['防风'], text: '4S 店展厅外的停车坪，身后是一排车和路边的旗杆，旗子被风吹得笔直（旗子上没有字）；整体银灰、冷蓝色调，阴天的漫射光' },
    ] },
  物业: { image: '/listing-images/places/estate.jpg', name: '物业小区', fits: ['防水', '防风', '保暖'],
    acts: ['一只手拿着对讲机', '一只手拿着手电筒', '一只手拿着巡查用的写字板', '一只手拎着一把收起的长柄伞'],
    looks: [
      { name: '小区门岗', sells: ['防风', '保暖'], text: '住宅小区门口，身后是门岗亭、道闸和两侧的绿化，起风了，树叶被吹向一边；整体灰绿、米白色调，阴天柔和的光' },
      { name: '雨中巡查', sells: ['防水'], text: `下着雨的小区路上，身后是湿漉漉的步道、绿化带和远处的楼栋，有业主撑伞走过；整体深绿、冷灰色调，阴天的漫射光${RAIN}` },
      { name: '夜间巡逻', sells: ['防水', '防风'], dark: true, text: '晚上的小区路上，身后是路灯下的楼栋和停着的车，地面湿亮反光，起了风；整体深蓝夜色加暖黄路灯，光来自路灯和手电' },
      { name: '冬日门口', sells: ['保暖'], text: '冬天的小区门口，身后是门岗和落光叶子的树，空气清冷、呼出白气；整体冷灰、白色调，清早低低的阳光' },
      { name: '地库入口', sells: ['防水', '保暖'], dark: true, text: `小区地下车库的入口，身后是坡道、黄黑相间的防撞条和昏暗的车库，外面下着雨；整体深灰、黄色点缀，车库里的白色灯管和外面的阴天光${RAIN}` },
    ] },
  团建: { image: '/listing-images/places/team.jpg', name: '户外团建', fits: ['轻量透气', '防风', '防水'],
    acts: ['一只手拉着团队旗帜的一角（旗子上没有字）', '一只手拿着一瓶矿泉水', '一只手拿着一个飞盘', '一只手拉着背包的肩带'],
    looks: [
      { name: '草坪帐篷', sells: ['轻量透气'], text: '开阔的郊野草坪，身后是树林、几顶帐篷和挂着的彩旗（没有字）；整体嫩绿、天蓝色调，晴天上午的阳光' },
      { name: '湖边起风', sells: ['防风'], text: '湖边的草坡，身后是湖面、芦苇和远处的山，起风了，芦苇和草被吹向一边；整体灰蓝、草绿色调，阴天柔和的光' },
      { name: '雨中营地', sells: ['防水'], text: `下着小雨的露营地，身后是天幕、折叠桌椅和湿漉漉的草地；整体深绿、卡其色调，阴天的漫射光${RAIN}` },
      { name: '黄昏营地', sells: ['轻量透气', '防风'], text: '傍晚的露营地，身后是天幕、串灯和远处的树林剪影；整体橙粉、暖黄色调，夕阳从一侧低低地照过来' },
    ] },
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

/** A small stable number from text (FNV-1a): a set's seed, so the same plan always gets the same picks. */
export function seedOf(text: string) {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  return h;
}
/** The things a cover can act out at a place for a point: the point's own act first (扛钢管 for 耐磨). */
const actsOf = (place: PlaceId, sell: Sell) => { const p: Place = PLACES[place], own = p.actFor?.[sell]; return own ? [own, ...p.acts] : p.acts; };
/** The looks of a place for a point; 暗黑科技 (dark) takes the low-key ones only. Never empty. */
const looksOf = (place: PlaceId, sell: Sell, dark: boolean) => {
  const all: Look[] = PLACES[place].looks, tone = dark ? all.filter(l => l.dark) : all, fit = tone.filter(l => l.sells.includes(sell));
  return fit.length ? fit : tone.length ? tone : all;
};
/** The picks a plan stores for its cover (`scene.act`, `scene.look`), from its seed and where and what it shoots. */
export const coverPicks = (seed: number, place: string, sell: string) => { const h = seedOf(`${seed}:${place}:${sell}`); return { act: h % 997, look: Math.floor(h / 997) % 997 }; };
/** The cover's words for a point, by the plan's seed: 「拒水 / 团体定制」 one set, 「防水 / 冲锋衣定制」 another. */
export const sellTitle = (sell: Sell, seed: number) => { const s = SELLS[sell]; return { title: s.titles[seed % s.titles.length], sub: s.subs[Math.floor(seed / 7) % s.subs.length] }; };
/** Any point's cover word (what the page offers to put back when the title strays). */
export const isSellTitle = (t: string) => Object.values(SELLS).some(s => (s.titles as readonly string[]).includes(t.trim()));

/**
 * The cover's picture in words, for the page (line) and the prompt (bg, person); hint when the point
 * does not fit the place. `pick`: the plan's stored picks (a plan from before 10-17 has none: the first).
 */
export function coverScene(place: PlaceId, sell: Sell, pick: { act?: number; look?: number } = {}, master = 'M1') {
  const p: Place = PLACES[place], s = SELLS[sell], acts = actsOf(place, sell), looks = looksOf(place, sell, !!masterInfo(master).dark);
  const act = acts[(pick.act ?? 0) % acts.length], look = looks[(pick.look ?? 0) % looks.length];
  return {
    line: `${p.name} · ${look.name}，${act}`,
    bg: `实景：${look.text}`, person: `${act}；拉链停在胸口、不敞开；${s.show}`,
    hint: p.fits.includes(sell) ? '' : `「${sell}」在${p.name}不好演，建议换成${p.fits.join('、')}；或者把地点换掉`,
  };
}
/** What makes the background read as a real place (10-17 trial: the cream-blurred showrooms looked fake). */
export const REAL_PLACE = '背景是真实拍到的环境，有生活痕迹和细节（地面的磨损、桌上的杂物、远处走过的人影），光来自场景里真实存在的灯、窗和天光；景深适中，背景虚化但还认得出是什么地方，不要整片糊成一团；不要过于干净对称的样板间感、不要 CG 渲染感；背景里没有能看清的字、招牌和标识';
/**
 * The point a cover leads with at a place: the ticked points the place can act out, taken in turn by
 * the plan's seed so one product leads with 防水 and the next with 透气 (10-17); `first` (the AI's
 * pick) is among them. With none that fits, the first ticked point.
 */
export function bestSell(place: PlaceId, ticked: string[], seed = 0, first?: Sell): Sell | null {
  const sells = [...new Set([...(first ? [first] : []), ...ticked.map(sellOf).filter((s): s is Sell => !!s)])];
  const fit = sells.filter(s => (PLACES[place].fits as readonly Sell[]).includes(s));
  return fit.length ? fit[seed % fit.length] : sells[0] ?? null;
}
