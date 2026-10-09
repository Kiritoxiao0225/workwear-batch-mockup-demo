/**
 * 电商主图 image prompts, written zone by zone from the layout's template: where each zone is (in
 * percent of the image), what words it carries and what picture it shows. The generator never sees
 * the uploaded listing images: it gets the white-background product image (or the colours' SKU
 * images), the cast (the models every image with people is drawn from) and these words.
 */
import type { Box, Display, Layout, StyleSheet, Template } from '../listing/templates';

export type Color = { name: string; hex: string };
const lines = (items: string[]) => items.filter(Boolean).map(item => `- ${item}`).join('\n');
const area = (b: Box) => `区域 左${b[0]}% 上${b[1]}% 宽${b[2]}% 高${b[3]}%`;
const style = (s: StyleSheet) => `整体风格：标题字${s.title}；小字${s.text}；标签${s.tag}；卡片${s.card}；光线${s.light}；背景${s.background}。`;
const NO_EXTRA = '不要出现：任何品牌 logo、店铺名、水印、道具上的文字，以及上面「」里以外的任何文字。上面没写到的位置不画标签、色块、文字框或空卡片。所有中文逐字正确、笔画清晰，文字不挡住领口、拉链和口袋。';
const DISPLAY: Record<Display, string> = { 平铺: '平铺在台面上，正面朝上，袖子自然展开', 挂拍: '挂在衣架上，正面朝前', 隐形人台: '立体地“穿”在看不见的人身上（隐形人台），正面朝前' };
const RATIO_NAME = { square: '正方形 1:1', portrait: '竖版 3:4', long: '竖版 2:3' } as const;
export type Ratio = keyof typeof RATIO_NAME;

export function productPrompt(input: { color: string; garment: string[] }) {
  return `从参考图里把这件衣服单独提取出来，做成一张电商白底产品图，正方形 1:1。
- 隐形模特效果（ghost mannequin）：衣服立体地“穿”在看不见的人身上，正面朝前，拉链或扣子合上，两只袖子自然下垂。
- 纯白背景，柔和均匀的棚拍光，只有一点点地面投影。
- 画面里只有这件衣服：不要人、不要手、不要任何文字、标签、logo、水印、图标和道具。
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
- 画面里没有任何文字、标签、logo 和水印。`;
}

/** Who is on an image: the cast's people, by how many the template has room for. */
function people(t: Template, lead: '男' | '女', cast: number) {
  const ref = `参考图${cast}`;
  if (t.people === 1) return `只有一位模特：${ref}里的${lead === '男' ? '男生' : '女生'}，脸型、五官、发型、肤色、身材都和${ref}一模一样；${ref}里的另一个人不出现。`;
  if (t.people === 2) return `一男一女两位模特：就是${ref}里的两个人，长相、发型都和${ref}一样。`;
  return `几位模特并排：${ref}里的一男一女都在，长相不变；其余的人男女交替。`;
}

/** What fills an image's zones. Cells and tags in reading order; `act`: what the models do; `scene`: background and action details the writing step added. */
export type Content = { title: string; sub: string; tags: string[]; cells: { text: string; recipe: string; icon?: boolean }[]; act?: string; scene: string };

/**
 * One main image (or the long image) from its template. References: the garment's image(s) first,
 * then the cast when the template has people. Zones without words or a picture are left out.
 */
export function mainPrompt(input: {
  ratio: Ratio; task: string; template: Template; layout: Layout; content: Content; used: Color[]; all: Color[]; garment: string[]; lead: '男' | '女';
  fromSku: boolean; cast: number | null; n?: number; total?: number;
}) {
  const { template: t, content: c, used, all } = input;
  const garmentRefs = used.length > 1 ? used.map((x, i) => `参考图${i + 1}是「${x.name}」的${input.fromSku ? ' SKU 图' : '白底产品图'}`).join('，') : `参考图1是这件衣服的白底产品图`;
  const refs = `${garmentRefs}，衣服的颜色和款式以它为准${input.cast ? `；参考图${input.cast}是这套图的模特定妆照，只用来确定模特长什么样，姿势、场景、构图按下面重新做，不照搬它的背景和站姿` : ''}。`;
  const colorRule = used.length > 1
    ? `- 画面里每件衣服的颜色和对应参考图一致，款式都一样；只能出现这 ${used.length} 种颜色，每人一种。`
    : `- 颜色：${used[0]?.name ?? all[0]?.name}，和参考图一致，不偏色；画面里只有这一种衣服颜色。`;
  let cell = 0, tag = 0;
  const zone = (z: Template['zones'][number]) => {
    switch (z.kind) {
      case 'title': return c.title && `大标题「${c.title}」：${area(z.box)}。`;
      case 'sub': return c.sub && `小字「${c.sub}」：${area(z.box)}。`;
      case 'tag': { const text = c.tags[tag++]; return text && `标签「${text}」：${area(z.box)}，圆角胶囊。`; }
      case 'card': case 'icon': {
        const x = c.cells[cell++];
        if (!x) return '';
        return z.kind === 'icon' || x.icon ? `图标卡片：${area(z.box)}；一个简洁的线描图标配一行字「${x.text}」。` : `卡片：${area(z.box)}；卡片里画：${x.recipe}；卡片底部一行字「${x.text}」。`;
      }
      case 'person': return `人物：${area(z.box)}；${input.cast ? people(t, input.lead, input.cast) : '模特穿着这件衣服。'}${c.act ? `动作：${c.act}。` : ''}`;
      case 'garment': return `衣服：${area(z.box)}；画面里没有人，衣服${DISPLAY[t.display ?? '平铺']}。`;
      case 'swatch': return `色块：${area(z.box)}；一排圆形色块，每个色块下写颜色名：${all.map(x => `「${x.name}」${x.hex}`).join('、')}。`;
    }
  };
  const head = input.n ? `整套 ${input.total} 张中的第 ${input.n} 张：${input.task}。` : '';
  return `为淘宝制作一张服装商品${input.ratio === 'long' ? '竖版长图（手淘推荐流）' : '主图'}，${RATIO_NAME[input.ratio]}。${head}
${refs}

衣服（必须和参考图一模一样）：
${lines(input.garment)}
${colorRule}

版式（位置用画面百分比，按这里排，不要自己加东西）：
${lines(t.zones.map(zone).filter((x): x is string => !!x))}
${t.people ? '' : '- 画面里没有任何人：没有模特、没有手、没有人体的任何部位。\n'}${t.zones.some(z => z.kind === 'person' || z.kind === 'garment') ? '' : '- 这张图不画衣服：只有上面写的字、图标和卡片，背景按整体风格。\n'}- 场景和画面细节：${c.scene || '干净简洁，衬托衣服'}
${style(input.layout.style)}

${NO_EXTRA}`;
}

/** The SKU image of one colour, in the layout's SKU template; colours after the first copy the first one's picture. */
export function skuPrompt(input: { layout: Layout; color: string; tag: string; fabric: string; garment: string[]; lead: '男' | '女'; cast: number | null; anchor: number | null; anchorColor?: string }) {
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
