/**
 * 电商主图 image prompts. The generator never sees the uploaded listing images: it gets a
 * white-background product image (or the colour's SKU image) plus these words. Ported from the
 * scripts validated in output/listing-studio-demo-20260929 (gen-brief.mjs, gen-layout.mjs).
 */
import type { ListingLayout, MainRole } from '../listing/layouts';

export type Color = { name: string; hex: string };
const lines = (items: string[]) => items.filter(Boolean).map(item => `- ${item}`).join('\n');
const NO_EXTRA = '不要出现：任何品牌 logo、店铺名、水印、道具上的文字，以及上面引号以外的任何文字。版式里没有分到文字的位置只放图形或留空，不要自己补充文案、卖点或说明。所有中文逐字正确、笔画清晰，文字不挡住领口、拉链和口袋。';

export function productPrompt(input: { color: string; garment: string[] }) {
  return `从参考图里把这件衣服单独提取出来，做成一张电商白底产品图，正方形 1:1。
- 隐形模特效果（ghost mannequin）：衣服立体地“穿”在看不见的人身上，正面朝前，拉链或扣子合上，两只袖子自然下垂。
- 纯白背景，柔和均匀的棚拍光，只有一点点地面投影。
- 画面里只有这件衣服：不要人、不要手、不要任何文字、标签、logo、水印、图标和道具。
衣服必须和参考图一模一样：
${lines(input.garment)}
- 颜色：${input.color}，和参考图里的衣服颜色完全一致，不偏色、不变浅。`;
}

export function skuPrompt(input: { layout: ListingLayout; color: string; anchor?: string; tag: string; fabric: string; garment: string[] }) {
  const words = [`颜色名「${input.color}」`, input.tag && `款式标签「${input.tag}」`, input.fabric && `面料小图下方的小字「${input.fabric}」`].filter(Boolean).join('，');
  return `为淘宝制作一张 SKU 规格图（买家切换颜色时看到的图），正方形 1:1。
参考图：
图1：这件衣服「${input.color}」的白底产品图，衣服的颜色和款式以它为准。
${input.anchor ? `图2：同一套 SKU 图里已经做好的「${input.anchor}」那张。人物长相、发型、姿势、背景、光线、构图，以及文字的位置、大小和样式全部照图2，只把衣服换成图1 的颜色，颜色名换成「${input.color}」。\n` : ''}
衣服（必须和图1一模一样）：
${lines(input.garment)}
- 颜色：所有人都穿「${input.color}」，和图1 完全一致，不偏色；画面里只有这一种衣服颜色。

版式：${input.layout.sku}
风格：${input.layout.style}
画面上的文字只有：${words}。

${NO_EXTRA}画面里不能出现其他颜色名。`;
}

export type MainSlot = { kind: 'square' | 'portrait' | 'poster'; n: number; total: number; role: MainRole | '海报'; title: string; subtitle: string; bullets: string[]; scene: string; colors: string[] };
const RATIO_NAME = { square: '正方形 1:1', portrait: '竖版 3:4', poster: '竖版 2:3' } as const;

/**
 * One main image. `fromSku` means the references are the colours' SKU images (multi-colour
 * images: colours are exact and the models match the SKU set); otherwise one product image.
 */
export function mainPrompt(input: { layout: ListingLayout; slot: MainSlot; used: Color[]; all: Color[]; fromSku: boolean; garment: string[] }) {
  const { slot, used, all } = input;
  const colorRule = used.length > 1
    ? `- 参考图是这款衣服各颜色的${input.fromSku ? ' SKU 图' : '白底产品图'}：${used.map((c, i) => `图${i + 1}=${c.name}`).join('，')}。画面里每件衣服的颜色必须和对应参考图一致，款式都一样；${input.fromSku ? '模特沿用参考图里的人，姿势、场景、构图按下面重新做，不照搬参考图的版式和文字；' : ''}只能出现这 ${used.length} 种颜色。\n- 本商品共 ${all.length} 色：${all.map(c => `「${c.name}」`).join('')}。画面里写颜色名只能用这些名字，逐字；色块颜色分别是 ${all.map(c => `${c.name} ${c.hex}`).join('、')}。`
    : `- 颜色：${used[0]?.name ?? all[0]?.name}，和参考图一致，不偏色。`;
  const words = [`主标题「${slot.title}」`, slot.subtitle && `副标题「${slot.subtitle}」`, ...slot.bullets.filter(Boolean).map(b => `要点「${b}」`)].filter(Boolean);
  const total = slot.kind === 'poster' ? '' : `整套 ${slot.total} 张中的第 ${slot.n} 张：${slot.role}。`;
  return `为淘宝制作一张服装商品主图，${RATIO_NAME[slot.kind]}。${total}
参考图只用来确定衣服长什么样；人物、场景、构图、文字都按下面的要求全新创作。

衣服（必须和参考图一模一样）：
${lines(input.garment)}
${colorRule}

这张图的内容：
${slot.scene ? `- 画面（要用画面直观演示卖点）：${slot.scene}\n` : ''}- 版式：${input.layout.roles[slot.role]}
- 风格：${input.layout.style}
- 画面上的文字只有这几句：${words.join('，')}。

${NO_EXTRA}`;
}

type Words = { title: string; subtitle: string; bullets: string[] };
/**
 * Change only the words of a finished main image: the image itself is the reference, so the
 * people, scene and layout stay; the text keeps its place and style.
 */
export function textEditPrompt(input: { kind: MainSlot['kind']; from: Words; to: Words }) {
  const { from, to } = input;
  const line = (label: string, a: string, b: string) => a === b ? (b ? `- ${label}「${b}」不变` : '') : !a ? `- 新增${label}「${b}」，放在和整体排版协调的位置` : !b ? `- 去掉${label}「${a}」，那里改成画面或留空` : `- ${label}「${a}」改成「${b}」`;
  const bullets = from.bullets.join('、') === to.bullets.join('、') ? (to.bullets.length ? `- 标签「${to.bullets.join('」「')}」不变` : '')
    : `- 标签${from.bullets.length ? `「${from.bullets.join('」「')}」` : '（原来没有）'}改成${to.bullets.length ? `「${to.bullets.join('」「')}」` : '没有标签，原来的标签位置改成画面'}`;
  const words = [`主标题「${to.title}」`, to.subtitle && `副标题「${to.subtitle}」`, ...to.bullets.map(b => `标签「${b}」`)].filter(Boolean);
  return `参考图是一张已经做好的淘宝服装主图，${RATIO_NAME[input.kind]}。在这张图上只改文字，其他一律不动：
- 人物、衣服、姿势、表情、背景、光线、构图、配色、图标和装饰，全部和参考图一模一样。
- 文字的位置、大小、字体风格、颜色和排版照参考图，只换内容。

文字这样改：
${[line('主标题', from.title, to.title), line('副标题', from.subtitle, to.subtitle), bullets].filter(Boolean).join('\n')}

改完后画面上的文字只有：${words.join('，')}。
${NO_EXTRA}`;
}
