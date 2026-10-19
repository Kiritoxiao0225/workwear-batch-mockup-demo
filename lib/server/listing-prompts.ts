/**
 * 电商主图 image prompts, written zone by zone from the layout's template: where each zone is (in
 * percent of the image), what words it carries, how large they are and what picture it shows. The
 * generator never sees the uploaded listing images or the competitors' ones: it gets the
 * white-background product image (or the colours' SKU images, or only a crop of the fabric when the
 * image shows no garment), the cast (the models every image with people is drawn from) and these
 * words. Only the shop's service images learn from a (washed) competitor sample.
 */
import type { ServiceImageDef } from '../listing/service';
import { crowdLine, DEFAULT_PLACE, othersLine } from './listing-crowd';
import { NO_CHEST, OWN_MARKS, SAME_STYLE } from './listing-lines';
import { bigWords, bigWordsLine, fitHeight, textUnits } from '../listing/point-words';
import type { Box, Display, Layout, StyleSheet, Template, Zone } from '../listing/templates';

export type Color = { name: string; hex: string };
const lines = (items: string[]) => items.filter(Boolean).map(item => `- ${item}`).join('\n');
const area = (b: Box) => `区域 左${b[0]}% 上${b[1]}% 宽${b[2]}% 高${b[3]}%`;
/** The look of the set; only the cover gets the master's cover type, so the others never see it (a brush named anywhere spread to every image). */
const style = (s: StyleSheet, cover = false) => `整体风格：标题字${cover && s.cover ? s.cover : s.title}；小字${s.text}；标签${s.tag}；卡片${s.card}；光线${s.light}；背景${s.background}。`;
const NO_EXTRA = `不要出现：另外加上的真实品牌 logo、店铺名、水印、道具上的文字（${OWN_MARKS}），背景里浅色大号英文水印字，以及上面「」里以外的任何文字。上面没写到的位置不画标签、色块、文字框、空卡片，也不额外加人或整件衣服。所有中文逐字正确、笔画清晰，文字不挡住领口、拉链和口袋。`;
const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)) * 2) / 2;
/**
 * How large a zone's words are, in percent of the image (the masters' rule: titles 6–8 %, small
 * words about 3 %, never under 2.5 %). A zone taller than wide is written top to bottom. The words
 * also have to fit the zone's width (or, written top to bottom, its height): longer words are set
 * smaller rather than run out of their box (10-19).
 */
function size(z: Zone, text = '') {
  const [, , w, h] = z.box, vertical = h > w * 1.2 && (z.kind === 'title' || z.kind === 'sub'), n = Math.max(1, textUnits(text));
  if (vertical) {
    const base = z.kind === 'title' ? clamp(w * 0.55, 5, 12) : clamp(w * 0.35, 2.5, 6);
    return `竖排，从上到下一列，每个字高约占画面 ${text ? Math.min(base, Math.max(z.kind === 'title' ? 3 : 2, Math.floor((h * 0.92) / n * 2) / 2)) : base}%`;
  }
  const pct = z.kind === 'title' ? clamp(h * 0.75, 5, 16) : z.kind === 'sub' ? clamp(h * 0.7, 2.5, 6) : clamp(h * 0.6, 2.5, 4);
  return `字高约占画面 ${text ? fitHeight(text, w, pct, z.kind === 'title' ? 3 : 1.8) : pct}%`;
}
const DISPLAY: Record<Display, string> = { 平铺: '平铺在台面上，正面朝上，袖子自然展开', 挂拍: '挂在衣架上，正面朝前', 隐形人台: '立体地“穿”在看不见的人身上（隐形人台），正面朝前' };
const RATIO_NAME = { square: '正方形 1:1', portrait: '竖版 3:4', long: '竖版 2:3' } as const;
export type Ratio = keyof typeof RATIO_NAME;

/** `group`: the reference is a photo of several garments; only the one in this colour is taken (10-15: two colours on one group photo). */
export function productPrompt(input: { color: string; garment: string[]; group?: boolean }) {
  const pick = input.group ? `参考图里有好几件衣服，只取其中「${input.color}」的那一件外套：不取别人身上的衣服，不把别的颜色改成「${input.color}」，内搭、裤子、包和配饰都不要。\n` : '';
  return `${pick}从参考图里把这件衣服单独提取出来，做成一张电商白底产品图，正方形 1:1。
- 隐形模特效果（ghost mannequin）：衣服立体地“穿”在看不见的人身上，正面朝前，拉链或扣子合上，两只袖子自然下垂。
- 纯白背景，柔和均匀的棚拍光，只有一点点地面投影。
- 画面里只有这件衣服：不要人、不要手、不要道具；不额外加任何文字、标签、logo、水印或图标。
- ${OWN_MARKS}。
衣服必须和参考图一模一样：
${lines(input.garment)}
- 颜色：${input.color}，和参考图里的衣服颜色完全一致，不偏色、不变浅。`;
}

/** The cast: a young man and a young woman in the main colour, plain grey, faces clear. Every image with people is drawn from it. */
export function castPrompt(input: { color: string; garment: string[] }) {
  return `为一套服装商品主图生成一张“模特定妆照”，竖版 3:4。它只用来确定后面每张图里的模特长什么样。
参考图是这件衣服的白底产品图，衣服以它为准。

衣服（必须和参考图一模一样）：
${lines(input.garment)}
- 颜色：${input.color}，和参考图一致，不偏色。

画面：
- 一男一女两位二十多岁的中国职场员工，并排正面站立，男生在左、女生在右，都穿这件衣服，拉链拉到胸口，里面是白色圆领 T 恤，下身深灰色休闲裤。
- 男生短黑发、利落干净；女生黑色长发披肩。两人的脸正对镜头、表情自然微笑，五官、发型、肤色清楚。
- 从头顶拍到大腿中部，头顶离画面上沿约 5%。
- 纯浅灰色背景，柔和均匀的棚拍光，没有道具。
- 画面里不额外加任何文字、标签、logo 和水印；${OWN_MARKS}。`;
}

/**
 * Half of a cast drawn from the material: one person, from their photo (`photo`) or made up. Two
 * people drawn at once from two photos come out with the second face made up, so each is drawn alone.
 */
export function castOnePrompt(input: { color: string; garment: string[]; who: '男' | '女'; photo: boolean }) {
  const person = input.who === '男' ? '男生' : '女生', pronoun = input.who === '男' ? '他' : '她';
  return `为一套服装商品主图生成一张“模特定妆照”，竖版 3:4。它只用来确定后面每张图里的模特长什么样。
参考图1是这件衣服的白底产品图，衣服以它为准。${input.photo ? `参考图2是素材里的${person}模特照片，只用来认人：${pronoun}穿的衣服、帽子、墨镜、背包、手里拿的东西、背景都不要带过来。` : ''}

衣服（必须和参考图1一模一样）：
${lines(input.garment)}
- 颜色：${input.color}，和参考图1一致，不偏色。

画面：
- 只有一位${person}，${input.photo ? `就是参考图2里的那个人：脸型、五官、发型、肤色、年龄都和照片一模一样。长相照原样画，不要美化、不要改成网红脸${input.who === '女' ? '或娃娃脸' : ''}。` : input.who === '男' ? '二十多岁的中国职场员工，短黑发、利落干净。' : '二十多岁的中国职场员工，黑色长发披肩。'}
- ${pronoun}穿这件衣服，拉链拉到胸口，里面是白色圆领 T 恤，下身深灰色休闲裤；不戴帽子和墨镜，正面站立，脸正对镜头、表情自然。
- 从头顶拍到大腿中部，头顶离画面上沿约 5%。
- 纯浅灰色背景，柔和均匀的棚拍光，没有道具。
- 画面里不额外加任何文字、标签、logo 和水印；${OWN_MARKS}。`;
}

/**
 * The cast wearing one colour, for that colour's SKU image (lib/server/listing-sku-card.ts puts it on
 * the template): the man and the woman when the cover has two people (`pair`), else the lead. The cast
 * is one image of both, or (`halves`) one image per person. Every colour is drawn at the same framing
 * on the same plain grey, so the people come out the same size from one colour to the next.
 */
/** The SKU models' poses, one per colour in turn: standing at ease (the user's pick over walking), the front of the garment always in view. */
const SKU_POSES = [
  '一手插在裤兜里，另一只手自然垂下，像走着路刚停下来看镜头',
  '一手轻拉胸前的拉链头，另一只手自然垂下，重心放在一条腿上',
  '双手自然垂下，身体微微侧向一边，重心放在一条腿上',
  '一手拇指勾着裤兜，身体微微侧向一边，回头看镜头',
];
const PAIR_POSES = [
  '两人肩并肩朝镜头走来，边走边笑着聊天',
  '女生挽着男生的手臂，两人都看着镜头笑',
  '男生一手插兜，女生侧身笑着看向男生，再一起看镜头',
];

/**
 * A colour's SKU model, photographed where the set is (10-16: on plain grey, hands down and square to
 * the camera, every one came out stiff); `pose`: the colour's place in the set, so the poses vary.
 * Head to knees as before: the SKU image finds the person on it and fills its panel.
 */
export function skuModelPrompt(input: { color: string; garment: string[]; lead: '男' | '女'; who: 'pair' | 'lead'; halves: boolean; logo: string | null; logoRef?: number; place?: string; pose?: number }) {
  const pair = input.who === 'pair', person = input.lead === '男' ? '男生' : '女生';
  const castRefs = pair && input.halves ? '参考图2是男模特、参考图3是女模特的定妆照' : `参考图2是这套图的模特定妆照`;
  const only = !pair && !input.halves ? `：只画里面的${person}，另一个人不出现` : '';
  const who = pair
    ? `- 一男一女两位模特，${input.halves ? '男生就是参考图2里的人、女生就是参考图3里的人' : '就是参考图2里的两个人'}：脸型、五官、发型、肤色、身材都一模一样。男生在左、女生在右，靠在一起站：女生在男生右侧稍前半步，两人身体微微侧向对方、脸朝镜头，肩膀前后交叠一点，整体不要站得太宽；男生比女生略高。
- 两人穿同一件衣服（这个颜色）`
    : `- 只有一位${person}，就是参考图2里的${person}：脸型、五官、发型、肤色、身材都和参考图2一模一样。
- ${input.lead === '男' ? '他' : '她'}穿这件衣服`;
  const n = input.pose ?? 0, pose = pair ? PAIR_POSES[n % PAIR_POSES.length] : SKU_POSES[n % SKU_POSES.length];
  return `为服装商品的 SKU 图生成一张${pair ? '双人' : '单人'}模特实拍图，竖版 3:4。
参考图1是这件衣服「${input.color}」的白底产品图，衣服的颜色和款式以它为准。${castRefs}，只用来认人${only}${input.logoRef ? `；参考图${input.logoRef}是客户的 LOGO，只用来印在衣服胸口` : ''}。

衣服（必须和参考图1一模一样）：
${lines(input.garment)}
- 颜色：${input.color}，和参考图1完全一致，不偏色、不变浅，不要画成定妆照里衣服的颜色。
- ${input.logo ?? NO_CHEST}

画面：
${who}，拉链拉到胸口，里面是白色圆领 T 恤，下身深灰色休闲裤；不戴帽子和墨镜。
- 场景实拍：${input.place || DEFAULT_PLACE}；背景有明显的景深虚化，${pair ? '人物' : '人'}和背景在同一种光下（光的方向、色温一致），不能像抠图贴上去。
- 姿势自然放松：${pose}；脸朝镜头、表情自然微笑；衣服正面（门襟拉链、口袋、领子）清楚完整，不被手臂挡住。
- 取景固定：从头顶拍到膝盖，膝盖正好在画面下沿；头顶离画面上沿约 5%；${pair ? '两人整体' : '人'}在画面正中间${pair ? '；两人加起来的宽度不超过画面宽度的 85%，左右两边都露出背景，手臂和肩膀不能碰到画面边缘' : '，左右两边都露出背景'}。
- 真实的商业摄影质感，皮肤有真实纹理、不磨皮，衣服有真实的褶皱和垂坠；不要 HDR、不要过饱和。
- 画面里不额外加任何文字、标签和水印；${OWN_MARKS}。`;
}

/** Who is on an image: the cast's people, by how many the template has room for. */
function people(t: Template, lead: '男' | '女', cast: number) {
  const ref = `参考图${cast}`;
  if (t.people === 1) return `只有一位模特：${ref}里的${lead === '男' ? '男生' : '女生'}，脸型、五官、发型、肤色、身材都和${ref}一模一样；${ref}里的另一个人不出现。`;
  if (t.people === 2) return `一男一女两位模特：就是${ref}里的两个人，长相、发型都和${ref}一样。`;
  return `几位模特并排：${othersLine(ref, t.people, ref)}。`;
}

/** What fills an image's zones. Cells and tags in reading order; `act`: what the models do; `scene`: background and action details the writing step added. */
/** `photo` on a card: the label of the material's own photo of the part it shows close up (sent as a reference image). */
export type Content = { title: string; sub: string; tags: string[]; cells: { text: string; recipe: string; icon?: boolean; note?: string; photo?: string }[]; act?: string; scene: string; badge?: string };

/**
 * One main image (or the long image) from its template. References: the garment's image(s) first,
 * then the cast when the template has people. Zones without words or a picture are left out.
 */
export function mainPrompt(input: {
  ratio: Ratio; task: string; template: Template; layout: Layout; content: Content; used: Color[]; all: Color[]; garment: string[]; lead: '男' | '女';
  fromSku: boolean; cast: number | null; n?: number; total?: number;
  /** What goes on the chest (null: nothing printed); `logoRef`: the reference image of the customer's LOGO. */
  logo?: string | null; logoRef?: number;
  /** The image shows only fabric: its reference is a crop of the fabric, and no garment is drawn. */
  fabric?: boolean;
  /** Where the set's SKU models and its group of colours are shot (the plan's `place`). */
  place?: string;
}) {
  const { template: t, content: c, used, all } = input;
  // Several colours on several people: the team together, each place its colour (listing-crowd.ts).
  const group = used.length > 1 && t.people > 2;
  const garmentRefs = input.fabric ? `参考图1是这件衣服「${used[0]?.name ?? all[0]?.name}」面料的一小块特写，只用来确定面料的颜色和纹理`
    : used.length > 1 ? used.map((x, i) => `参考图${i + 1}是「${x.name}」的${input.fromSku ? ' SKU 图' : '白底产品图'}`).join('，') : `参考图1是这件衣服的白底产品图`;
  const refs = `${garmentRefs}${input.fabric ? '' : '，衣服的颜色和款式以它为准'}${input.cast ? `；参考图${input.cast}是这套图的模特定妆照，只用来确定模特长什么样，姿势、场景、构图按下面重新做，不照搬它的背景和站姿` : ''}${input.logoRef ? `；参考图${input.logoRef}是客户的 LOGO，只用来印在衣服胸口` : ''}。`;
  const colorRule = used.length > 1
    ? `- 画面里每件衣服的颜色和对应参考图一致，${SAME_STYLE}；只能出现这 ${used.length} 种颜色，每人一种。`
    : `- 颜色：${used[0]?.name ?? all[0]?.name}，和参考图一致，不偏色；画面里只有这一种衣服颜色。`;
  let cell = 0, tag = 0;
  // The fabric fills the whole image (面料铺底): round icons on it, and the fabric itself is the picture.
  const sheet = !!input.fabric && t.zones.some(z => z.kind === 'fabric');
  const zone = (z: Template['zones'][number]) => {
    switch (z.kind) {
      case 'title': return c.title && `大标题「${c.title}」：${area(z.box)}，${size(z, c.title)}。`;
      case 'sub': return c.sub && `小字「${c.sub}」：${area(z.box)}，${size(z, c.sub)}。`;
      case 'tag': {
        const text = c.tags[tag++];
        if (!text) return '';
        // A fact (「面料科技｜德国SUPER-TEX」): a small label over a big word, straight on the background, no box.
        const [label, word] = text.includes('｜') ? text.split('｜') : [null, text];
        return label ? `参数：${area(z.box)}；上面一行细黑体小字「${label}」（字高约占画面 ${fitHeight(label, z.box[2], 2.5)}%），下面紧跟粗黑体大字「${word}」（${bigWordsLine(bigWords(word, z.box[2], 6, z.box[3] - 4))}），左对齐，直接写在背景上，不加框和色块。`
          : `标签「${text}」：${area(z.box)}，${size(z, text)}。`;
      }
      case 'card': case 'icon': {
        const x = c.cells[cell++];
        if (!x) return '';
        if (sheet && z.kind === 'icon') return `图标：${area(z.box)}；一个细线圆框，框里一个简洁的线描图标，圆框下面一行字「${x.text}」（字高约占画面 ${fitHeight(x.text, z.box[2], 3)}%）；不加方形卡片底，直接在面料上。`;
        // An icon card shows no garment: one with a strip of tape behind a taped-seam icon made the tape up (10-16).
        return z.kind === 'icon' || x.icon ? `图标卡片：${area(z.box)}；一个简洁的线描图标配一行字「${x.text}」，字高约占画面 ${fitHeight(x.text, z.box[2], 2.8)}%；卡片底是干净的纯色，不画衣服、面料、胶条或任何结构。`
          : `卡片：${area(z.box)}；卡片里画：${x.recipe}；卡片底部一行字「${x.text}」，字高约占画面 ${fitHeight(x.text, z.box[2], 3)}%。`;
      }
      case 'person': return `人物：${area(z.box)}；${group ? `${crowdLine(used, input.cast ? `参考图${input.cast}` : '定妆照')}。` : input.cast ? people(t, input.lead, input.cast) : '模特穿着这件衣服。'}${c.act ? `动作：${c.act}。` : ''}`;
      case 'garment': return `衣服：${area(z.box)}；画面里没有人，衣服${DISPLAY[t.display ?? '平铺']}。`;
      case 'swatch': return `色块：${area(z.box)}；一排圆形色块，每个色块下写颜色名（字高约占画面 2.5%）：${all.map(x => `「${x.name}」${x.hex}`).join('、')}。`;
      case 'badge': return `工牌：${area(z.box)}；模特脖子上挂一条挂绳，胸前垂一张竖向白色工牌卡${c.badge ? `，卡上印「${c.badge}」` : '，卡上只有简单色块和线条，不写字'}。`;
      case 'band': return `横条：${area(z.box)}；一条实底横条，颜色和质感照这套图的标签样式（${input.layout.style.tag}），上面压着这里写的字。`;
      case 'fabric': return `面料铺底：${area(z.box)}；这件衣服的面料铺满当背景，有大块柔软起伏的褶皱；这一块只有面料，看不到领口、帽子、袖子、拉链、口袋。`;
    }
  };
  const head = input.n ? `整套 ${input.total} 张中的第 ${input.n} 张：${input.task}。` : '';
  const logo = input.logo ? `- ${input.logo}` : `- ${NO_CHEST}`;
  const garment = input.fabric ? `面料：${used[0]?.name ?? all[0]?.name}，颜色和纹理照参考图1；这张图只拍面料，不画整件衣服，看不到领口、帽子、袖子、拉链、口袋。`
    : `衣服（必须和参考图一模一样）：\n${lines(input.garment)}\n${colorRule}\n${logo}`;
  // Several colours on people are photographed together where the set is shot, whatever the master's tone (10-16).
  const together = used.length > 1 && t.people > 0 ? `\n- 多色同框：实景合影，${input.place || DEFAULT_PLACE}；光线自然，每件衣服的颜色都看得清；字体和标签样式照整体风格。` : '';
  return `为淘宝制作一张冲锋衣团体定制商品${input.ratio === 'long' ? '竖版长图（手淘推荐流）' : '主图'}，${RATIO_NAME[input.ratio]}。${head}
${refs}

${garment}

版式（位置用画面百分比，按这里排，不要自己加东西）：
${lines(t.zones.map(zone).filter((x): x is string => !!x))}
${t.people ? '' : c.cells.some(x => x.recipe.includes('手')) ? '- 画面里没有模特：只有卡片里写到的手可以出现，只露手，不露脸和身体。\n' : '- 画面里没有任何人：没有模特、没有手、没有人体的任何部位。\n'}${t.zones.some(z => z.kind === 'person' || z.kind === 'garment') ? '' : '- 这张图不画整件衣服：卡片和格子里只画写到的部位或面料，其余是字、图标和背景。\n'}- 场景和画面细节：${sheet ? fabricLook(c) : c.scene || '干净简洁，衬托衣服'}${together}
${style(input.layout.style, input.task === '首图')}

${NO_EXTRA}`;
}

/**
 * How an image of fabric only is shot: the fabric is the picture, so it has the light and the
 * demonstration (water beading on it when the image speaks of water), not the written scene of a table.
 */
function fabricLook(c: Content) {
  const water = c.cells.some(x => /水珠|泼水|淋水/.test(x.recipe)) || /水/.test(c.title);
  return `微距拍面料特写，柔和的侧光从左上方打来，褶皱的起伏有明显的明暗过渡，能看清织物纹理，整体干净高级，不要拍成一片平的白或一片死黑。${water ? '面料表面挂着大小不一、饱满透亮的圆水珠，集中在画面中部偏右的空处，最大的几颗有清晰的高光和倒影，有一两颗正在滚落；水珠不压到字和图标。' : ''}`;
}

/** The SKU image of one colour, in the layout's SKU template; colours after the first copy the first one's picture. */
export function skuPrompt(input: { layout: Layout; color: string; tag: string; fabric: string; garment: string[]; lead: '男' | '女'; cast: number | null; anchor: number | null; anchorColor?: string; logo?: string | null; logoRef?: number }) {
  const t = input.layout.sku;
  const zone = (z: Template['zones'][number]) => z.kind === 'title' ? `颜色名「${input.color}」：${area(z.box)}，大号粗体。`
    : z.kind === 'tag' ? input.tag && `款式标签「${input.tag}」：${area(z.box)}，圆角胶囊。`
    : z.kind === 'card' ? input.fabric && `面料小图：${area(z.box)}；圆角方框里是同色面料的微距特写，方框下方一行小字「${input.fabric}」。`
    : z.kind === 'person' ? `人物：${area(z.box)}；${input.cast ? people(t, input.lead, input.cast) : ''}所有人都穿「${input.color}」。`
    : z.kind === 'garment' ? `衣服：${area(z.box)}；画面里没有人，衣服${DISPLAY[t.display ?? '平铺']}。` : '';
  return `为淘宝制作一张 SKU 规格图（买家切换颜色时看到的图），正方形 1:1。
参考图1是这件衣服「${input.color}」的白底产品图，衣服的颜色和款式以它为准。${input.cast ? `参考图${input.cast}是模特定妆照，只用来确定模特长什么样。` : ''}${input.anchor ? `参考图${input.anchor}是同一套 SKU 图里已经做好的「${input.anchorColor}」那张：人物姿势、背景、光线、构图，以及文字的位置、大小和样式全部照它，只把衣服换成参考图1 的颜色，颜色名换成「${input.color}」。` : ''}

衣服（必须和参考图1 一模一样）：
${lines(input.garment)}
- 颜色：画面里只有「${input.color}」这一种衣服颜色，和参考图1 完全一致。
- ${input.logo ?? NO_CHEST}${input.logoRef ? `（参考图${input.logoRef}是客户的 LOGO）` : ''}

版式（位置用画面百分比）：
${lines(t.zones.map(zone).filter((x): x is string => !!x))}
${style(input.layout.style)}

${NO_EXTRA}画面里不能出现其他颜色名。`;
}

/**
 * A change on the 画板: only the masked box (`area`) is redrawn on the finished image; everything
 * outside it stays as it is (and is pasted back pixel for pixel afterwards).
 */
export function editPrompt(input: { ratio: Ratio; box: Box; to?: Box; what: string; style: StyleSheet }) {
  const where = input.to ? `原来在（${area(input.box)}）的那一块挪到（${area(input.to)}）：原来的位置补成和周围一致的背景，新的位置画这一块，样式照原来的` : `只重画遮罩透明的那一块（${area(input.box)}）`;
  return `参考图是一张已经做好的淘宝服装主图，${RATIO_NAME[input.ratio]}。${where}；框外的人物、衣服、文字、背景全部保持原样，框里的新内容和周围的光线、色调、字体风格衔接自然。
框里画：${input.what}
${style(input.style)}
不要在框里出现「」以外的文字，不要改动框外的任何字；中文逐字正确、笔画清晰。`;
}

/* ---------- the shop's service images ---------- */

/** Each service image learns its layout, tone and finish from one washed competitor sample (reference 1); the shop's words replace the sample's. */
const SERVICE_BODY: Record<ServiceImageDef['id'], (words: string[][], logo: boolean) => string> = {
  'A-light': w => `照参考图1学：上面一行小字、中间两行超大口号、下面一行说明、再下面一个深灰半透明圆角框，框里两列两行共 4 项服务；浅灰压淡的照片底，干净柔和。
背景照片的内容：明亮的工作台上叠放着几件浅灰色的衣服样品，轻度虚化，不出现人脸。

画面里的文字（只能出现这些，逐字正确，字号照参考图1）：
- 最上面一行深灰小字「如果您喜欢 我们建议」
- 两行超大白色粗黑体口号：第一行「先看样，」，第二行「再决定。」
- 口号下面一行白色细黑体「眼见为实 满意再下单」
- 框里 4 项（白字）：${w.map(x => `「${x[0]}」`).join('')}`,
  'A-dark': w => `照参考图1学：上面一行小字、中间两行超大口号、下面一行说明、再下面 2×2 四张半透明圆角权益卡（左边线描图标、中间一条细竖线、右边两行字）；暗灰单色调，背景是一张压暗、柔和虚化的照片：一双手在缝纫机上车缝深色面料，近景，只讲这一件事。

画面里的文字（只能出现这些，逐字正确，字号照参考图1）：
- 最上面一行浅灰小字「如果您喜欢 我们建议」
- 中间两行超大白色粗黑体口号：第一行「先看样」，第二行「再决定」
- 口号下面一行浅灰小字「眼见为实 品质看得见」
${w.map((x, i) => `- ${['左上', '右上', '左下', '右下'][i]}权益卡：「${x[0]}」「${x[1]}」，配一个和它意思相符的白色线描图标`).join('\n')}`,
  'D-warm': (w, logo) => `照参考图1学：左上两行大标题、下面三列竖长圆角图片（每列一种印绣工艺的布面特写）、每列下面一个工艺名和一行说明；暖白纯色底，干净。
三张图片的内容：${logo ? '图案都用参考图2的 LOGO' : '都是抽象图案或「LOGO」字样，不是任何真实品牌'}——${w.map((x, i) => `第 ${i + 1} 列是「${x[0]}」工艺做在布面上的特写`).join('；')}；每列的布面颜色和图案配色各不相同。

画面里的文字（只能出现这些，逐字正确，字号照参考图1；全部用规整黑体，不用毛笔字）：
- 两行大标题：第一行「多种印绣工艺」，第二行「印出团队好形象」
${w.map((x, i) => `- 第 ${i + 1} 列：「${x[0]}」，下面一行「${x[1]}」`).join('\n')}`,
  'B-light': w => `照参考图1学：左上大标题、右上两行小字、中间一张大圆角照片（照片上压一行白色大字）、下面 2×2 四张白色圆角卡片（左边线描图标，右边粗体标题，下面一行说明）；浅灰底，干净明亮。
大照片的内容：明亮的缝纫车间里，一双手在整理叠好的冲锋衣，轻度虚化；不出现人脸。

画面里的文字（只能出现这些，逐字正确，字号照参考图1）：
- 左上大标题「服务保障」
- 右上两行深灰小字「眼见为实」「满意再下单」
- 大照片上的白色大字「精选面料 用心做好每一件」
${w.map((x, i) => `- ${['左上', '右上', '左下', '右下'][i]}卡片：「${x[0]}」，说明「${x[1]}」，配一个和它意思相符的线描图标`).join('\n')}`,
};
const pairs = (words: string[]) => words.map(w => w.split('｜'));

/** A service image of the shop: reference 1 is its washed sample, reference 2 the shop's sample LOGO (crafts image only). */
export function servicePrompt(def: ServiceImageDef, words: string[], logo: boolean) {
  return `为淘宝制作一张冲锋衣团体定制的服务说明主图，正方形 1:1。它放在每款商品主图的第 2 张。

参考图分工：
- 参考图1：一张做得很高级的服务说明图。完整学习它的版式、色调、背景、卡片质感和图标风格，只把文字和照片内容换成下面写的。${logo ? '\n- 参考图2：店铺的样例 LOGO，只用作工艺图里的图案。' : ''}

${SERVICE_BODY[def.id](pairs(words), logo)}

照片里如果出现衣服，用中性灰色。
不要：参考图1里有、上面没写的任何字；背景里浅色大号英文水印字；任何真实品牌标志、店名、水印；人脸。`;
}

/** The shop changed some services: only those words (and their icons) are redrawn on the made image (reference 1). */
export function serviceWordsPrompt(changes: { from: string; to: string }[]) {
  const say = (w: string) => pairs([w])[0].filter(Boolean).map(x => `「${x}」`).join('');
  return `参考图1是一张已经做好的淘宝服务说明主图，正方形 1:1。只把下面这几处的字换掉，图标换成和新字意思相符的同风格图标；其余的字、照片、卡片、排版、颜色、字体全部保持原样，一点都不改。

${changes.map(c => `- ${say(c.from)} 换成 ${say(c.to)}`).join('\n')}

新字的字体、字号、颜色和位置照原来那一处。所有中文逐字正确、笔画清晰；不要加任何新的字。`;
}

/** A square image laid out again as a 3:4 image: same content, words and style, only the arrangement follows the taller shape. */
/**
 * A 3:4 image from its finished square one (reference 1); `garment`: reference 2 is the colour's white
 * image, for the details of a garment shown whole (a close-up gets none: it made the model add a garment).
 */
export function relayoutPrompt(garment = false) {
  return `参考图1是一张做好的淘宝服装主图，正方形 1:1。把它重新排成竖版 3:4：内容、所有文字（逐字照抄）、照片、卡片、图标、颜色、字体和风格都和参考图1一样，只按竖图调整位置和比例，让画面上下撑满、不留空白条；${garment ? '人物和衣服在竖图里要完整自然，不被裁坏；参考图2是这件衣服的白底产品图，衣服的款式和细节以它为准，颜色照参考图1。' : ''}不要加任何新的字和元素。所有中文逐字正确、笔画清晰。`;
}

/**
 * The 2:3 long image from the finished square cover (reference 1): the cover's words and type word for
 * word, the same shoot drawn back so the whole person shows (the cover crops the face on most masters:
 * `cast` is the cast's reference then); `garment`: reference 2 is the colour's white image.
 */
export function longPrompt(input: { garment: boolean; cast: number | null }) {
  return `参考图1是这套图的首图（正方形 1:1，已经做好）。照它做一张竖版 2:3 长图，放在手淘推荐流里：
- 字：参考图1上的所有字逐字照抄，一个不多、一个不少；字体、字号的大小层次、颜色、投影和装饰（英文小字、手写花体、细线、色块）都和参考图1一模一样，只按竖图调整位置，放在画面下部或参考图1原来的那一侧，不挡脸。
- 画面：同一个场景、同一种光和色调、同一件衣服（胸口印的字和 LOGO 也照参考图1），${input.cast ? `像同一次拍摄里退后几步拍的另一张：人拉远，从头顶拍到大腿，头部完整、脸部清楚自然，动作照参考图1；参考图${input.cast}是模特定妆照，画面里的人照它的长相（参考图1里是男生就照男生，是女生就照女生）。`
    : '衣服的摆法照参考图1；画面里没有任何人，只有衣服，衣服完整、放大，占画面大半。'}
${input.garment ? '- 参考图2是这件衣服的白底产品图，衣服的款式和细节以它为准，颜色照参考图1。\n' : ''}- 画面上下撑满、不留空白条；不要加任何新的字和元素。所有中文逐字正确、笔画清晰。`;
}

/**
 * 「点图修改」: the current image (reference 1) is redrawn as the user asks; what they did not ask
 * about stays. Reference 2, when given, is the user's example of what they want.
 */
export function redrawPrompt(input: { ratio: Ratio; ask: string; reference: boolean; style?: StyleSheet }) {
  return `参考图1是一张已经做好的淘宝服装主图，${RATIO_NAME[input.ratio]}。按下面的要求改它，没提到的地方（衣服的款式和颜色、模特的长相、其余文字、排版）保持原样。

要求：${input.ask}
${input.reference ? '参考图2是用户给的参考，只学它和要求有关的部分（比如背景、姿势、光线），不要照搬它上面的文字、logo 和人物长相。\n' : ''}${input.style ? `${style(input.style)}\n` : ''}所有中文逐字正确、笔画清晰；要求里写到的新字就用那几个字，除此之外不要加新的字。`;
}
