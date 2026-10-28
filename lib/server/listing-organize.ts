/**
 * 电商主图, step one for a raw product folder: the model sorts every image (kind, colour, whether
 * the whole garment is shown from the front, which detail it shows, whether it carries selling
 * text, which other image it copies), lists the colours and the selling points with their
 * sources, each point with its own explanation from the material. The program then picks one
 * image per colour and the structure references (full front view, collar, zip and cuffs, pocket,
 * fabric, back); lib/listing/plan.ts shares the points out over the images.
 */
import { innerName, settleWear, type Inner, type Wear } from '../listing/wear';
import { z } from 'zod';
import { CATEGORIES, TASKS, type Category } from '../listing/category';
import { GARMENT_ROLES, isComponent, isGroup, type GarmentRole } from '../listing/garment-role';
import { PROOFS } from '../listing/proofs';
import { MASTER_INFO, PLACE_IDS, PLACES, SELLS, type PlaceId, type Sell } from '../listing/scene';
import { BUILT_IN_LAYOUTS } from '../listing/templates';
import { modelJson } from './listing-json';
import type { PlanView } from './listing-plan-views';

export const MATERIAL_KINDS = ['颜色款图', '静物', '3D渲染', '模特实拍', '细节特写', '卖点图', '详情页', '海报', '尺码表', '无关'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];
/** The whole garment seen from the front; the other structure parts are named after what the garment has. */
export const FRONT = '正面全身';
/** At most this many close-up parts are offered, plus the back view; the user may add more. */
const MAX_PARTS = 8;

const ROLE = '你是淘宝服装店的素材整理员。';
/** How squarely the garment faces the camera; images sorted before 10-19 have none. */
export const FACINGS = ['', '正对', '微侧', '侧身', '背面'] as const;
/**
 * A colour's reference is drawn from: a squarer view first. 10-18: 「front」 alone let a model turned
 * half away (one sleeve and its badge hidden) win on resolution over the ones facing the camera.
 */
export const facingScore = (i: { facing?: string }) => ({ 正对: 2, 微侧: 1, 侧身: 0, 背面: -2 } as Record<string, number>)[i.facing ?? ''] ?? 0;
/** Every image's rules: kind, colour, front, part, words, LOGO, people, face, copies. */
const IMAGE_RULES = `每张图（images，一张不漏，按编号）：
- kind：颜色款图（用来区分颜色款的图，通常一个颜色一张、带颜色名）/ 静物（平铺、挂拍、人台、白底产品图）/ 3D渲染 / 模特实拍（没有加文字的模特照片）/ 细节特写（局部近拍）/ 卖点图（做好的主图或营销图，上面有卖点文字）/ 详情页（详情页切片，长图或图文排版）/ 海报 / 尺码表 / 无关（二维码、聊天截图、价格说明、空白图、别的商品等）。
- role：画面里衣服的角色：主体（这款卖的衣服本身，穿着或挂拍时露出内胆也算主体）/ 内胆（单独拍的可拆内胆，抓绒、摇粒绒、羽绒、软壳等都算；三合一的内胆有时本身就像一件外套，文件夹名、文件名写着内胆或某种内胆的，按内胆算）/ 配件（单独拍的帽子、袖套等可拆配件）/ 组合（外套和内胆拆开并排摆）/ 不确定。单独拍的内胆再干净、再正面完整也写内胆，不能当外套。
- colorsSeen：画面里清楚看到的每一件主体衣服的颜色名（多人合照逐件列，同色只列一次）；名字照抄颜色清单的写法，清单里没有的按看到的起常见名；内胆、内搭、裤子的颜色不算；没有主体衣服留空数组。
- color：画面里这件衣服的颜色名，和 colors 里的名字一致；图上写了颜色名就一字不改地照抄，没写就按你看到的起一个常见颜色名；一张图里有多种颜色或看不出时留空。
- front：衣服是否完整、正面朝前地出现（领口到下摆都在画面里，没被手、包、文字挡住主体）。没人穿的图（静物、3D渲染、颜色款图）还要衣服合拢、门襟拉链拉上：敞开的、露出内胆或里布的、翻过来的、斜挂着的都写 false。
- facing：穿着的人（或衣服）朝向镜头的角度：正对（身体正面对着镜头，左右两侧衣身和两只袖子的外侧都看得到）/ 微侧（转身不到约 30 度，两只袖子仍都看得到）/ 侧身（转得更多，一侧袖子或一侧衣身被挡住或看不到）/ 背面；画面里没有整件衣服留空。
- detail：如果是局部特写，拍的是这件衣服的哪个部位，用这件衣服实际有的东西来叫，2–6 个字（如 连帽、帽檐调节、立领、门襟拉链、袖口、下摆抽绳、口袋、腋下透气拉链、内胆、面料、背面）；看清楚再叫，帽子就写帽子相关的名字，不要叫成领口。同一个部位在不同图里用同一个叫法。不是特写留空。整件衣服的背面照片 detail 也写“背面”。
- parts：画面里能看清特写的所有部位（详情页、卖点图常常一张拼了好几个部位的特写，比如门襟拉链和口袋、袖口在同一张里，都写上），叫法和 detail 一样；没有就空数组。
- text：画面上有没有能读出的卖点文字（面料、功能、工艺、服务等）。
- logo：衣服本身上有没有 logo、品牌标、印字或图案（只看衣服，不看背景和图上加的字）。
- person：画面里有没有真人模特：只有一位男生写 男，只有一位女生写 女，一男一女写 男女，三人以上写 多人，没有人留空。
- face：画面里模特的脸是否正对或微侧镜头、五官清楚、没被墨镜、口罩、手或帽檐挡住，脸足够大能看清长相。没有人写 false。
- open：画面里有没有外套是敞开穿的（拉链拉开、门襟敞着、能看到里面穿的东西），多人合照里有一件敞开就写 true；外套都拉上、或画面里没有外套写 false。
- inner：画面里看得到的内胆叫什么，2–4 个字，不带“内胆”两个字：素材自己写了就照抄素材的叫法（文件夹名、文件名、图上的字，如“软壳静物”写软壳，“可拆卸摇粒绒内胆”写摇粒绒）；没写才按看到的料起常见名（如 摇粒绒、羽绒、软壳、棉、针织）：表面看得到一粒粒绒毛的（抓绒也算）叫摇粒绒；表面光滑、哑光、像薄外套一样挺括有弹性的叫软壳，袖口、领里露一点绒也是软壳；一格一格鼓起来的绗缝叫羽绒，薄一些的绗缝夹棉叫棉。同一件内胆在每张图里都用同一个名字。外套敞开、里面穿着内胆的照片写里面那件；role 是内胆的写它自己；看不到内胆（只穿外套、里面是 T 恤或衬衫，或外套拉链拉上看不到里面）留空。衣服里缝死的里布、里绒不算内胆，留空。
- innerColor：inner 不为空时，那件内胆的颜色（如 黑色、米色、藏青）；否则留空。
- same：如果这张和另一张是同一张照片（裁剪、缩放、调色、加字前后的版本），写那一张的编号，否则留空。`;
/** The whole product's rules: colours, points, category, checks, titles, master. */
const WHOLE_RULES = `整款：
- colors：这款衣服的全部颜色，每张图 colorsSeen 里的颜色都要算上（只在多人合照里出现的颜色也是这款的颜色）；单独拍的内胆、配件的颜色不算。名字严格照抄颜色图、色卡、详情页上写的颜色名，一个字都不改（带品牌词的如“爱马仕橙”也照抄，不要换说法、不要自己起更好听的名字）；素材上完全没写颜色名的，才按你看到的颜色起一个常见名；hex 是你看到的颜色；from 写能看到这个颜色衣服的图的编号（最多 5 个）。色卡或文字里提到、但素材里没有这个颜色衣服图的，也要列出来，from 留空。同一个颜色在不同地方写法不一样（字的顺序不同，如“黑拼白”和“黑白拼”；或多一个“色”字），算一个颜色，只列一次，名字用颜色图或色卡上的写法。
- points：卖点，只能来自图上的文字或清楚可见的演示（如水珠滚落），不要编造；text 只做提炼：用素材原文里的字和说法（品牌名、型号、数字都照原样保留），不改写、不换说法、不美化；原文超过 16 个字时只截取其中最关键的连续部分；note 是素材里专门解释这条卖点本身的说明，同样只提炼原文（如卖点“防水三级以上”配“防水指数三级以上 雨天外出更安心”），不超过 16 个字，不带句末标点。讲的是另一个部位、另一个功能或另一种材料的字，哪怕排在旁边也不能用（比如卖点“防风保暖”旁边写着“帽围自由调节”，那是在讲帽子；卖点是衣身成分，旁边写的是包边条成分），这时 note 留空；type 是 定位/功能/面料/做工/实用/颜色款式/人群场景/服务定制 之一；from 写出处编号。最多 16 条，按重要性从高到低排，排第一、第二的会放上首图。重要性看两点：① 商家有多强调——在素材里反复出现、放在显眼位置（大标题、首屏）讲的更重要；② 买家有多在乎——买这类衣服的人做决定时最先看的更重要。why 用一句话（不超过 30 个字）说明排在这里的理由，如“主图和详情页 5 处都在讲，冲锋衣买家最先看防水”。
- 每条卖点还要写：concept（它属于下面"卖点类别"里的哪一类，写类别编号；哪一类都不是就写 null）；proof（这条卖点在图上怎么证明，从下面"画法"里选一个编号；做工、实用类讲的是衣服某个部位的，选 part）；part（选了 part 或讲的是某个部位时，写部位名，用 images 里 detail 的叫法，如“袖口”）；short（这条卖点放进小图标、标签时的短说法，最多 6 个汉字宽，英文和数字两个算一个字：只从 text 里删掉字得到，不换词、不加 text 里没有的字，要读得通、意思不变；先删“设计”“工艺”“效应”“采用”这类可有可无的字，型号、数字、品牌名和最能区分它的词留下，比如“可呼吸冲锋衣透气面料”写“透气面料”，“可拆卸摇粒内胆”写“可拆内胆”，“IP4.0防水层”写“IP4.0防水”，“压胶缝工艺拉链”写“压胶拉链”，“荷叶滚珠效应”写“荷叶滚珠”；text 本身放得下就照抄 text）。
- notes：你发现的问题，比如“色卡里有藏青，但没有藏青的衣服图”“没有背面图”，没有就空数组。

整款还要写：
- category：这款按哪个品类来排，写品类编号（下面列出的）。按衣服本身判断，不看素材里的文案怎么叫它：workwear（冲锋衣）指连帽或高立领、前门襟是拉链（外露的、或被挡风片盖住的都算）、面料防风防泼水的外套（单层、软壳、三合一都算）；T 恤、衬衫、马甲、羽绒服、棉服、卫衣、POLO 都不是，写 generic。categoryWhy：一句话理由（不超过 40 个字），如“连帽、外露拉链、防泼水面料，是冲锋衣”。
- checks：下面"卖点类别"里属于衣服功能的每一类（不含服务类），看这件衣服的图判断它像不像有：seen 写 有 / 看不出 / 不像；why 一句话依据（不超过 30 个字），如“单层薄款，没看到内胆或加绒”。素材里已经讲到的类别也要判断。
- titles：给每类主图各写 2–3 句候选大标题（4–10 个字，概括这类图要讲的，口语、有力，如“细节经得起看”“三防面料 雨天不怕”），类别：${TASKS.filter(t => t !== '收口').join('、')}。只能根据素材里有的卖点写，不编造参数和承诺。
- wear：这款衣服怎么穿（定妆照、有人的图和 SKU 图都照它），type 三选一：
  · 内胆：可拆内胆的三合一，并且素材里真的拍到了内胆（套在外套里面露出来，或内胆单独拍、单独穿）。
  · 一体：棉、绒、羽绒缝在衣服里拆不下来（一体棉、加棉、夹棉、一体绒、加绒、一体羽绒），看文字、文件夹名，也看图里是不是蓬松鼓起、有绗缝。
  · 薄款：春秋单层外套；三合一但素材里一张内胆都没拍到的，也算薄款。
  why：一句话依据（不超过 40 个字），写看到了哪些字、哪些图，如“文件夹写一体羽绒，模特图衣身鼓起有绗缝”。
  versions：只有 type 是内胆才写，列素材里真的拍到的每一种穿法，一种一条：kind 是 单外壳（外套里面没穿内胆）/ 外壳加内胆（外套里面穿着内胆）/ 单内胆（只穿或只拍内胆）；inner 写内胆的名字（和每张图分类里的写法一致，单外壳留空）；colors 写这个穿法拍到了哪些颜色（外套的颜色名，单内胆写内胆自己的颜色）；from 写拍到这个穿法的图编号。不要拼、不要猜：有外套的图、也有内胆的图，但没有一张是外套里穿着这件内胆，就不能写外壳加内胆；内胆只露在外套里面、没有单独拍的，就不能写单内胆；文字里提到、图里没拍到的穿法不写。
- look：这款用哪套母版、首图在哪儿拍、首图主打哪个卖点。先看素材里有没有写给谁穿、什么行业（如 4S 店、物业、工地、餐饮、团建），写了就照着选；没写就看衣服本身：颜色深浅、功能卖点多不多、偏商务还是偏户外。master：从下面"母版"里选一个编号；M4 只在素材讲男女同款、情侣或年轻团队时选；M5 是给不想用模特、想省积分的店铺自己换的，不要选；素材里没有模特图不要紧，出图时模特是另画的。place：首图地点编号，只有首图是实景的母版才写，不能选这套母版不能拍的地点，否则留空。sell：首图主打的卖点，从下面"首图卖点"里选一个，要是 points 里讲到的、并且在这个地点演得出来的（看地点后面列的）；都不沾留空。why：一句话理由（不超过 40 个字），如“三防卖点多、深色款，选暗黑科技；素材写了物业保安，在小区门口拍”。`;
const IMAGE_SHAPE = '{ "id": "M1", "kind": "", "role": "", "colorsSeen": [], "color": "", "front": false, "facing": "", "detail": "", "parts": [], "text": false, "logo": false, "person": "", "face": false, "open": false, "inner": "", "innerColor": "", "same": "" }';
const WHOLE_SHAPE = `"colors": [{ "name": "", "hex": "", "from": ["M1"] }],
  "points": [{ "type": "", "text": "", "note": "", "from": ["M1"], "why": "", "concept": null, "proof": "", "part": "", "short": "" }],
  "notes": [""], "category": "", "categoryWhy": "", "checks": [{ "concept": "", "seen": "", "why": "" }], "titles": { "功能": [""] },
  "look": { "master": "", "place": "", "sell": "", "why": "" },
  "wear": { "type": "", "why": "", "versions": [{ "kind": "", "inner": "", "colors": [""], "from": ["M1"] }] }`;

/** The one-call analysis (kept for small folders' tests and as the reference wording). */
const SYSTEM = `${ROLE}你会收到同一款衣服的一大批原始素材（实拍、静物、3D 图、做好的主图和详情页、海报、颜色图等，可能很乱），每张都标了编号。
任务：逐张整理，并读出颜色和卖点。颜色和卖点只做提炼，素材里写了什么就用什么，不做任何调整。只输出 JSON。

${IMAGE_RULES}

${WHOLE_RULES}

{CATALOG}

输出：
{ "images": [${IMAGE_SHAPE}],
  ${WHOLE_SHAPE} }`;
/**
 * Step one in parts (10-13): the images sorted a batch at a time, each batch kept when it comes
 * back, so a cut connection only costs the batch it cut (「继续整理」 does the rest).
 */
const SORT_SYSTEM = `${ROLE}你会收到同一款衣服的一部分原始素材（实拍、静物、3D 图、做好的主图和详情页、海报、颜色图等，可能很乱），每张都标了编号。
任务：逐张整理。只输出 JSON。

${IMAGE_RULES}

输出：
{ "images": [${IMAGE_SHAPE}] }`;
/**
 * Before any image is sorted (10-14): the product's colours, read from its colour images, swatches,
 * detail pages and a few photos of each folder, and from every file's path. The batches then name an
 * image's colour from this list only, so one colour is never two names (「橙色」 for 「爱马仕橙」).
 */
const COLORS_SYSTEM = `${ROLE}你会收到同一款衣服的一部分原始素材（颜色图、色卡、详情页、主图，和每个文件夹里抽的几张照片），每张都标了编号，还有全部素材的文件名。
任务：列出这款衣服的全部颜色。只输出 JSON。

- 名字严格照抄颜色图、色卡、详情页或文件名、文件夹名上写的颜色名，一个字都不改（带品牌词的如“爱马仕橙”也照抄，不要换说法、不要自己起更好听的名字）；素材上完全没写颜色名的，才按你看到的颜色起一个常见名。
- 同一个颜色在不同地方写法不一样（字的顺序不同，如“黑拼白”和“黑白拼”；或多一个“色”字），算一个颜色，只列一次，名字用颜色图或色卡上的写法。
- 色卡或文字里写了、照片里没看到的颜色也要列；照片里看到、哪里都没写名字的颜色也要列。
- hex 是你看到的这个颜色。

输出：
{ "colors": [{ "name": "", "hex": "" }] }`;
const coloursSchema = z.object({ colors: z.array(z.object({ name: z.string().trim().min(1).max(12), hex: z.string().default('') })) });
/** The first part of the analysis: the colour list. */
export function coloursRequest(input: { views: PlanView[]; paths: string[]; model: string; product: string }) {
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 4000, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: COLORS_SYSTEM }, { role: 'user', content: [
      { type: 'text' as const, text: `全部素材的文件名：\n${input.paths.join('\n')}` },
      ...userContent(`商品：${input.product}。下面是用来认颜色的素材（拼在一起的，每一格、每一段都是一张独立素材，按说明里的顺序对应编号）。`, input.views)] }] };
}
/** The colour list, one entry per colour however it was written. */
export function parseColours(content: string): { name: string; hex: string }[] {
  const raw = modelJson(content, '颜色清单不是完整的 JSON');
  const parsed = coloursSchema.safeParse(raw);
  if (!parsed.success) throw new Error('颜色清单缺少颜色');
  return parsed.data.colors.filter((c, i, all) => all.findIndex(o => colorKey(o.name) === colorKey(c.name)) === i);
}
/** The line that holds a step to the colour list. */
const paletteLine = (colors: string[] | undefined, read: boolean) => !colors?.length ? '' : read
  ? `这款的颜色清单（已经定好）：${colors.join('、')}。colors 按这份清单输出，名字一字不改；素材里明显还有清单外的颜色才补上。\n`
  : `这款的颜色清单：${colors.join('、')}。每张图的 color 只能从清单里选，照抄清单里的写法；一张图里有几种颜色、或看不出是清单里哪一个，留空。\n`;
/** Then the whole product, from the images that matter and how each was sorted. */
const READ_SYSTEM = `${ROLE}你会收到同一款衣服的原始素材（已经去掉无关和重复的图），每张都标了编号，还有每张图已经整理好的分类（类别、颜色、部位、有没有字）。
任务：读出颜色和卖点。颜色和卖点只做提炼，素材里写了什么就用什么，不做任何调整。只输出 JSON。

${WHOLE_RULES}
- recolor：分类里写的颜色和 colors 的名字对不上的图（例如分类写“橙色”，colors 里是“落霞橙”和“爱马仕橙”），看图判断它是哪个颜色，写 { "编号": "colors 里的名字" }；一张图里有几种颜色或看不出的不写。对得上的图不用写。

{CATALOG}

输出：
{ ${WHOLE_SHAPE}, "recolor": {} }`;

/** The categories, their kinds of point and the ways of drawing a point, for the model to choose from. */
const catalog = (categories: Category[]) => [
  `品类：${categories.map(c => `${c.id}（${c.name}）`).join('、')}`,
  ...categories.filter(c => c.concepts.length).map(c => `「${c.name}」的卖点类别（编号：名字，类型，常见说法）：\n${c.concepts.map(x => `${x.id}：${x.name}，${x.type}，${x.keywords.slice(0, 4).join('/')}`).join('\n')}`),
  `画法（编号：名字，怎么画）：\n${PROOFS.map(p => `${p.id}：${p.name}，${p.recipe}${p.person ? '（要有人）' : ''}`).join('\n')}`,
  `母版（编号：名字，样子；适合；首图）：\n${BUILT_IN_LAYOUTS.filter(l => MASTER_INFO[l.id]).map(l => { const m = MASTER_INFO[l.id], deny = Object.keys(m.deny);
    return `${l.id}：${l.name}，${l.description}；适合${m.fit}；首图${m.cover}${deny.length ? `，不能在${deny.join('、')}拍` : ''}`; }).join('\n')}`,
  `首图地点（编号：名字，在这儿演得出的卖点）：\n${PLACE_IDS.map(id => `${id}：${PLACES[id].name}，${PLACES[id].fits.join('/')}`).join('\n')}`,
  `首图卖点：${Object.keys(SELLS).join('、')}`,
].join('\n\n');

/** The part of the catalog points are written against: the kinds of point and the ways of drawing one. */
const pointCatalog = (categories: Category[]) => catalog(categories).split('\n\n').filter(part => part.startsWith('品类：') || part.includes('的卖点类别') || part.startsWith('画法')).join('\n\n');

export function organizeRequest(input: { views: PlanView[]; model: string; product: string }) {
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
    { type: 'text', text: `商品：${input.product}。下面是全部素材（拼在一起的，每一格、每一段都是一张独立素材，按说明里的顺序对应编号）。` }];
  for (const view of input.views) content.push({ type: 'text', text: view.text }, { type: 'image_url', image_url: { url: view.dataUrl } });
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 24000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: SYSTEM.replace('{CATALOG}', catalog(CATEGORIES)) }, { role: 'user', content }] };
}

const userContent = (lead: string, views: PlanView[]) => {
  const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [{ type: 'text', text: lead }];
  for (const view of views) content.push({ type: 'text', text: view.text }, { type: 'image_url', image_url: { url: view.dataUrl } });
  return content;
};
/** One batch of images to sort. */
export function sortRequest(input: { views: PlanView[]; model: string; product: string; colors?: string[] }) {
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 16000, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: SORT_SYSTEM }, { role: 'user', content: userContent(`${paletteLine(input.colors, false)}商品：${input.product}。下面是这款的一部分素材（拼在一起的，每一格、每一段都是一张独立素材，按说明里的顺序对应编号）。`, input.views) }] };
}
/** The whole product, read from the images worth reading and how each was sorted. */
/** One sorted image as a line of text, for the readings that follow the sort. */
const imageLine = (i: SortedImage) => {
  const inner = i.role === '内胆' ? `，单拍内胆（${i.innerColor ?? ''}${i.inner ?? ''}）` : i.inner ? `，外套里穿着${i.innerColor ?? ''}${i.inner}内胆` : '';
  return `${i.id}：${i.kind}${i.color ? `，${i.color}` : ''}${i.detail || i.parts?.length ? `，部位 ${[...new Set([i.detail, ...(i.parts ?? [])].filter(Boolean))].join('、')}` : ''}${i.front ? '，正面全身' : ''}${i.text ? '，有卖点字' : ''}${i.person ? `，${i.person}` : ''}${inner}`;
};
export function readRequest(input: { views: PlanView[]; model: string; product: string; images: SortedImage[]; colors?: string[] }) {
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 12000, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: READ_SYSTEM.replace('{CATALOG}', catalog(CATEGORIES)) }, { role: 'user', content: [
      { type: 'text' as const, text: `${paletteLine(input.colors, true)}每张图已经整理好的分类：\n${input.images.map(imageLine).join('\n')}` },
      ...userContent(`商品：${input.product}。下面是要读的素材（拼在一起的，每一格、每一段都是一张独立素材，按说明里的顺序对应编号）。`, input.views)] }] };
}

/**
 * A big product read in parts (10-26). In one call, the whole product from up to 50 pictures took
 * longer than ten minutes on the relay (6608, 204 photos: cut six times at the last step). Read in
 * parts instead: the points off the pictures with words, READ_GROUP_VIEWS pictures a call, then the
 * rest of the product (colours, category, how it is worn, the look, titles) from the photos and the
 * points already read. Every part is kept, so 「继续整理」 asks only for what is missing. A product
 * with READ_SPLIT_VIEWS pictures or fewer is still read in one call.
 */
export const READ_SPLIT_VIEWS = 12, READ_GROUP_VIEWS = 8;
const RULE_LINES = WHOLE_RULES.split('\n'), isPointRule = (line: string) => line.startsWith('- points：') || line.startsWith('- 每条卖点还要写');
const POINTS_SYSTEM = `${ROLE}你会收到同一款衣服的一部分素材（带卖点文字的那些），每张都标了编号，还有每张图已经整理好的分类。
任务：只读出这些图上的卖点。卖点只做提炼，素材里写了什么就用什么，不做任何调整。只输出 JSON。

${RULE_LINES.filter(isPointRule).join('\n')}
- notes：你发现的问题，比如“这页卖点字被裁掉一半看不清”，没有就空数组。

{CATALOG}

输出：
{ ${WHOLE_SHAPE.split('\n').find(l => l.includes('"points"'))!.trim()}
  "notes": [""] }`;
const WHOLE_SYSTEM = `${ROLE}你会收到同一款衣服的原始素材（已经去掉无关和重复的图，带卖点文字的那些已经单独读过），每张都标了编号，还有每张图已经整理好的分类、已经读出的卖点。
任务：读出颜色和整款的判断。颜色只做提炼，素材里写了什么就用什么，不做任何调整。卖点已经读好，不用再输出；titles 和 look 的 sell 只能根据已经读出的卖点写。只输出 JSON。

${RULE_LINES.filter(line => !isPointRule(line)).join('\n')}
- recolor：分类里写的颜色和 colors 的名字对不上的图（例如分类写“橙色”，colors 里是“落霞橙”和“爱马仕橙”），看图判断它是哪个颜色，写 { "编号": "colors 里的名字" }；一张图里有几种颜色或看不出的不写。对得上的图不用写。

{CATALOG}

输出：
{ ${WHOLE_SHAPE.split('\n').filter(l => !l.includes('"points"')).join('\n').trim()}, "recolor": {} }`;
export type ReadPoints = Pick<z.infer<typeof organizeSchema>, 'points' | 'notes'>;

/** One group of the pictures with words: its points. */
export function pointsRequest(input: { views: PlanView[]; model: string; product: string; images: SortedImage[] }) {
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 8000, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: POINTS_SYSTEM.replace('{CATALOG}', pointCatalog(CATEGORIES)) }, { role: 'user', content: [
      { type: 'text' as const, text: `这些图已经整理好的分类：\n${input.images.map(imageLine).join('\n')}` },
      ...userContent(`商品：${input.product}。下面是这款带卖点字的一部分素材（拼在一起的，每一格、每一段都是一张独立素材，按说明里的顺序对应编号）。`, input.views)] }] };
}
export function parsePoints(content: string): ReadPoints {
  const parsed = organizeSchema.pick({ points: true, notes: true }).safeParse(modelJson(content, '卖点不是完整的 JSON'));
  if (!parsed.success) throw new Error('卖点结果缺少内容');
  return parsed.data;
}
/** The groups' points as one list: a point read twice in the same words (a page shown in two groups) once, with both pictures. */
export function mergePoints(parts: ReadPoints[]): ReadPoints {
  const points: ReadPoints['points'] = [];
  for (const p of parts.flatMap(x => x.points)) {
    const same = points.find(q => q.text.replace(/\s/gu, '') === p.text.replace(/\s/gu, ''));
    if (same) same.from = [...new Set([...same.from, ...p.from])]; else points.push({ ...p, from: [...p.from] });
  }
  return { points, notes: [...new Set(parts.flatMap(x => x.notes))] };
}
/** The rest of the product, with the points already read. */
export function wholeRequest(input: { views: PlanView[]; model: string; product: string; images: SortedImage[]; colors?: string[]; points: ReadPoints['points'] }) {
  const point = (p: ReadPoints['points'][number], n: number) => `${n + 1}. ${p.text}${p.note ? `（${p.note}）` : ''}，${p.type}，来自 ${p.from.join('、') || '—'}`;
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 8000, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: WHOLE_SYSTEM.replace('{CATALOG}', catalog(CATEGORIES)) }, { role: 'user', content: [
      { type: 'text' as const, text: `${paletteLine(input.colors, true)}每张图已经整理好的分类：\n${input.images.map(imageLine).join('\n')}\n\n已经读出的卖点：\n${input.points.map(point).join('\n') || '（没有）'}` },
      ...userContent(`商品：${input.product}。下面是要看的素材（拼在一起的，每一格、每一段都是一张独立素材，按说明里的顺序对应编号）。`, input.views)] }] };
}
/** The whole product put together as the one-call reading gives it. */
export function parseWhole(content: string, images: SortedImage[], read: ReadPoints): Organized {
  const raw = modelJson(content, '整理结果不是完整的 JSON') as Record<string, unknown>;
  const notes = Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === 'string') : [];
  return parseRead(JSON.stringify({ ...raw, points: read.points, notes: [...read.notes, ...notes] }), images);
}

/**
 * The liner check (10-21): sorted at about 200 px a picture, a black fleece and a black T-shirt
 * look alike, and a zipped-up shell hides what is inside. The images that may show a liner (sorted
 * as showing one, or in a folder or file named for one) are looked at again one by one at 768 px,
 * LINER_CHECK_BATCH to a call (10-21: 6609 had 94, and the ones past the first 40 lost their liners; 10-22: in a call of 40
 * a black fleece under 1888's 黑白 shell was missed, in a call of 2 it was seen every time).
 */
export const LINER_CHECK_SIDE = 768, LINER_CHECK_BATCH = 10, LINER_CHECK_MAX = 160;
const LINER_WORDS = /内胆|羽绒|抓绒|摇粒|加绒|加棉|夹棉|一体/, LINER_PRODUCT = /三合一|内胆|可拆|一衣[两三]穿/;
/** Whole-garment photos, and how many of each folder's are looked at even when nothing names a liner. */
const LINER_PHOTOS = new Set(['静物', '3D渲染', '模特实拍', '颜色款图']);
export const LINER_FOLDER_SAMPLE = 3;
const folderOf = (pathOf: (id: string) => string, id: string) => pathOf(id).split('/').slice(0, -1).join('/');
export function linerCandidates(images: SortedImage[], pathOf: (id: string) => string, product = ''): string[] {
  // An open jacket may show a liner the sort could not make out at its size (10-22: 1888's 黑白 over a black fleece, in a couple photo).
  const maybe = images.filter(i => i.kind !== '无关' && !i.same && (i.role === '内胆' || !!i.inner || !!i.open || LINER_WORDS.test(pathOf(i.id))));
  // A few photos of every folder too (10-28): a liner may look like a jacket of its own, in a folder named
  // for a liner no word list knows (8828's 「软壳静物」); linerFolderRest looks at the rest where one is found.
  // Only where a liner may be: a T-shirt or a single shell is not looked at again.
  const lined = maybe.length > 0 || images.some(i => i.role === '组合') || LINER_PRODUCT.test([product, ...images.map(i => pathOf(i.id))].join('\n'));
  const sample = new Map<string, SortedImage[]>();
  for (const i of lined ? images : []) {
    if (maybe.includes(i) || i.same || !LINER_PHOTOS.has(i.kind)) continue;
    const f = folderOf(pathOf, i.id), list = sample.get(f) ?? [];
    if (list.length < LINER_FOLDER_SAMPLE) sample.set(f, [...list, i]);
  }
  // The ones sorted as showing a liner first, then the rest by folder, a few from each, up to the limit.
  const seen = maybe.filter(i => i.role === '内胆' || i.inner || i.open), rest = [...maybe.filter(i => !seen.includes(i)), ...[...sample.values()].flat()];
  const byFolder = new Map<string, SortedImage[]>();
  for (const i of rest) { const f = folderOf(pathOf, i.id); byFolder.set(f, [...(byFolder.get(f) ?? []), i]); }
  const spread: SortedImage[] = [];
  for (let k = 0; spread.length < rest.length; k++) for (const list of byFolder.values()) if (list[k]) spread.push(list[k]);
  return [...seen, ...spread].slice(0, LINER_CHECK_MAX).map(i => i.id);
}
/** The photos not yet looked at in every folder where the check found a liner, up to what the limit leaves. */
export function linerFolderRest(images: SortedImage[], checks: LinerCheck[], checked: string[], pathOf: (id: string) => string): string[] {
  const looked = new Set(checked);
  const found = new Set(checks.filter(c => looked.has(c.id) && (c.role === '内胆' || c.inner)).map(c => folderOf(pathOf, c.id)));
  return images.filter(i => !looked.has(i.id) && !i.same && LINER_PHOTOS.has(i.kind) && found.has(folderOf(pathOf, i.id)))
    .slice(0, Math.max(0, LINER_CHECK_MAX - checked.length)).map(i => i.id);
}
const LINER_SYSTEM = `${ROLE}你会收到同一款衣服的一些照片，每张都标了编号，都是原图放大看的。
任务：逐张看清楚外套里面有没有内胆。只输出 JSON。

每张图：
- role：主体（穿着或摆着这款外套）/ 内胆（单独穿、单独拍的内胆，外面没有套外套）/ 其他（细节特写、详情页文字图等看不出的）。三合一的内胆有时本身就像一件外套（软壳、摇粒绒外套、轻薄羽绒）：文件夹名、文件名写着内胆或某种内胆的，或者和这款的外套明显不是同一件（没有帽子、料子不同、更薄更短），写内胆。
- open：外套是不是敞开的、能看清里面穿的是什么；拉链拉上、领口只露一点点看不清的写 false。role 是内胆时写 true。
- inner：外套里面（或单独拍的）那件内胆叫什么，2–4 个字，不带“内胆”两个字：素材自己写了就照抄素材的叫法（文件夹名、文件名、图上的字，如“软壳静物”写软壳，“可拆卸摇粒绒内胆”写摇粒绒）；没写才按看到的料起常见名（如 摇粒绒、羽绒、软壳、棉、针织）：表面看得到一粒粒绒毛的（抓绒也算）叫摇粒绒；表面光滑、哑光、像薄外套一样挺括有弹性的叫软壳，袖口、领里露一点绒也是软壳；一格一格鼓起来的绗缝叫羽绒，薄一些的绗缝夹棉叫棉。同一件内胆在每张图里都用同一个名字。里面只是 T 恤、衬衫、卫衣、运动背心、打底衫，或 open 是 false 的，留空。衣服里缝死的里布、里绒不算内胆，留空。
- innerColor：inner 不为空时，内胆的颜色（如 黑色、米色、藏青）；否则留空。
- shellColor：role 是主体时，外套的颜色名（多人合照里有好几件，写穿着内胆的那一件），名字从下面的颜色清单里选，选不出留空。

输出：
{ "images": [{ "id": "M1", "role": "", "open": false, "inner": "", "innerColor": "", "shellColor": "" }] }`;
/** `named`: the liner names earlier batches gave (10-28), so one liner keeps one name across batches. */
export function linerRequest(input: { views: PlanView[]; model: string; product: string; colors?: string[]; named?: string[] }) {
  const named = input.named?.length ? `前面的图里已经出现的内胆：${input.named.join('、')}；是同一件就用同一个名字，是另一件才起新名字。\n` : '';
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 6000, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: LINER_SYSTEM }, { role: 'user', content: userContent(`${input.colors?.length ? `这款的颜色清单：${input.colors.join('、')}。\n` : ''}${named}商品：${input.product}。下面每张都是一张独立素材。`, input.views) }] };
}
const linerSchema = z.object({ images: z.array(z.object({ id: z.string(), role: z.enum(['主体', '内胆', '其他']).catch('其他'), open: z.boolean().catch(false),
  inner: z.string().catch('').transform(innerName), innerColor: z.string().trim().max(12).catch(''), shellColor: z.string().trim().max(12).catch('') })) });
export type LinerCheck = z.infer<typeof linerSchema>['images'][number];
/** One batch of the liner check. */
export function parseLinerBatch(content: string): LinerCheck[] {
  const parsed = linerSchema.safeParse(modelJson(content, '内胆复核结果不是完整的 JSON'));
  if (!parsed.success) throw new Error('内胆复核结果缺少每张图');
  return parsed.data.images;
}
/**
 * The checked images take the liner check's word; an image the check did not look at keeps no liner,
 * so only what was seen at full size stands behind a SKU version (wear.ts).
 */
export function applyLiners(checks: LinerCheck[], images: SortedImage[], checked: string[]): SortedImage[] {
  const byId = new Map(checks.map(i => [i.id, i])), looked = new Set(checked);
  return images.map(i => {
    const r = byId.get(i.id);
    if (!looked.has(i.id) || !r) return i.inner || i.role === '内胆' ? { ...i, inner: '', innerColor: '', ...(i.role === '内胆' ? { role: '不确定' as const } : {}) } : i;
    const inner = r.role === '其他' || (r.role === '主体' && !r.open) ? '' : r.inner;
    return { ...i, role: r.role === '内胆' ? '内胆' : r.role === '主体' ? '主体' : i.role, inner, innerColor: inner ? r.innerColor : '', ...(r.role === '主体' && r.shellColor ? { color: i.color || r.shellColor } : {}) };
  });
}

/** The images worth reading for the whole product: not unrelated, not a copy of another. */
export const worthReading = (images: SortedImage[]) => images.filter(i => i.kind !== '无关' && !i.same);

const imageSchema = z.object({
  id: z.string(), kind: z.enum(MATERIAL_KINDS).catch('无关'), color: z.string().default(''), front: z.boolean().default(false),
  detail: z.string().trim().max(12).catch(''), parts: z.array(z.string().trim().max(12)).max(8).catch([]).default([]), text: z.boolean().default(false), logo: z.boolean().default(false), same: z.string().default(''),
  person: z.enum(['', '男', '女', '男女', '多人']).catch('').default(''), face: z.boolean().catch(false).default(false),
  facing: z.enum(FACINGS).optional().catch(undefined),
  /** Set by the program, not the model: a still life that is really on white (listing-plain). */
  plain: z.boolean().optional().catch(undefined),
  role: z.enum(GARMENT_ROLES).optional().catch(undefined), colorsSeen: z.array(z.string().trim().min(1).max(12)).max(12).optional().catch(undefined),
  /** The liner the image shows, inside the shell or on its own (10-21); missing on material sorted before. */
  inner: z.string().transform(innerName).optional().catch(undefined), innerColor: z.string().trim().max(12).optional().catch(undefined),
  /** A jacket on it is worn open (10-22): easy to see at ~200 px, so the liner check looks at every one. */
  open: z.boolean().optional().catch(undefined),
});
const organizeSchema = z.object({
  images: z.array(imageSchema),
  colors: z.array(z.object({ name: z.string().trim().min(1).max(12), hex: z.string().default(''), from: z.array(z.string()).default([]) })),
  points: z.array(z.object({ type: z.string().default(''), text: z.string().trim().min(1).max(20), note: z.string().trim().max(30).default(''), from: z.array(z.string()).default([]), why: z.string().max(80).default(''),
    concept: z.string().max(40).nullable().catch(null).default(null), proof: z.string().max(40).catch('').default(''), part: z.string().trim().max(12).catch('').default(''), short: z.string().trim().max(12).catch('').default('') })).default([]),
  notes: z.array(z.string()).default([]),
  category: z.string().max(40).catch('generic').default('generic'), categoryWhy: z.string().max(120).catch('').default(''),
  checks: z.array(z.object({ concept: z.string().max(40), seen: z.enum(['有', '看不出', '不像']).catch('看不出'), why: z.string().max(80).catch('').default('') })).catch([]).default([]),
  titles: z.record(z.string(), z.array(z.string().trim().min(1).max(20)).max(4)).catch({}).default({}),
  themes: z.array(z.object({ title: z.string().trim().min(1).max(20), kind: z.string().max(8).catch('功能'), points: z.array(z.number().int()).max(16), show: z.string().max(120).catch('').default('') })).max(8).catch([]).default([]),
  look: z.object({ master: z.string().max(8).catch(''), place: z.string().max(12).catch(''), sell: z.string().max(8).catch(''), why: z.string().max(120).catch('').default('') }).nullable().catch(null).default(null),
  wear: z.object({ type: z.string().max(8).catch(''), why: z.string().max(200).catch('').default(''),
    versions: z.array(z.object({ kind: z.string().max(8).catch(''), inner: z.string().max(8).catch(''), colors: z.array(z.string().max(12)).max(16).catch([]).default([]), from: z.array(z.string()).max(60).catch([]).default([]) })).max(12).catch([]).default([]) }).nullable().catch(null).default(null),
});
/** The AI's pick of the master, where the cover is shot and the point it acts out; empty parts fall back to the plan's rules. */
export type Look = { master: string; place?: PlaceId; sell?: Sell; why: string };
export type Organized = Omit<z.infer<typeof organizeSchema>, 'look' | 'images' | 'wear'> & { look: Look | null; images: SortedImage[]; wear: Wear | null };
/** `parts` is missing on material sorted before 10-13; `role` and `colorsSeen` before 10-16. */
export type SortedImage = Omit<z.infer<typeof imageSchema>, 'parts' | 'role' | 'colorsSeen' | 'inner'> & { parts?: string[]; role?: GarmentRole; colorsSeen?: string[]; inner?: Inner | '' };

/** A colour name's characters, in any order, without 色: 「黑白拼」 and 「黑拼白」 are the same colour. */
const colorKey = (name: string) => [...name.replace(/[色\s]/gu, '')].sort().join('');
/**
 * One colour written two ways (10-13: 「黑拼白」 on the colour images, 「黑白拼」 in a line of text)
 * was listed twice, the second with no garment image and so a red 「没有衣服图」. A colour without an
 * image that reads the same as one with an image is that colour.
 */
export function mergeSameColors<C extends { name: string; from: string[] }>(colors: C[]): C[] {
  return colors.filter(c => c.from.length || !colors.some(o => o !== c && o.from.length && colorKey(o.name) === colorKey(c.name)));
}
/**
 * Colours seen on a garment image that the colour list does not have (10-15: 白色 and 军绿 worn
 * only on a group photo were left out, and the set went out with four colours of six): a note for
 * the user, not a colour added on the model's word.
 */
export function unlistedColors(images: SortedImage[], names: string[]): string[] {
  const listed = (name: string) => {
    const core = (x: string) => x.replace(/[色\s]/gu, ''), own = core(name);
    return !own || names.some(n => colorKey(n) === colorKey(name) || n.includes(own) || (!!core(n) && own.includes(core(n))));
  };
  const seen = new Map<string, string[]>();
  for (const i of images) {
    if (i.same || i.kind === '无关' || isComponent(i)) continue;
    for (const c of i.colorsSeen ?? []) if (!listed(c)) seen.set(c, [...(seen.get(c) ?? []), i.id]);
  }
  return [...seen].map(([c, ids]) => `${ids.slice(0, 3).join('、')} 里还有「${c}」的衣服，颜色清单里没有：核对一下是不是漏了这个颜色`);
}
export function parseOrganized(content: string, ids: string[]): Organized {
  const raw = modelJson(content, '整理结果不是完整的 JSON');
  const parsed = organizeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`整理结果缺少必要内容（${[...new Set(parsed.error.issues.map(i => String(i.path[0] ?? '结构')))].join('、')}）`);
  const known = new Set(ids), data = parsed.data;
  data.images = data.images.filter(i => known.has(i.id));
  // An image the model skipped is kept as unsorted rather than lost.
  for (const id of ids) if (!data.images.some(i => i.id === id)) data.images.push({ id, kind: '无关', color: '', front: false, detail: '', parts: [], text: false, logo: false, same: '', person: '', face: false });
  data.images = settleCopies(data.images);
  for (const c of data.colors) c.from = c.from.filter(id => known.has(id));
  data.colors = mergeSameColors(data.colors);
  data.notes = [...data.notes, ...unlistedColors(data.images, data.colors.map(c => c.name))];
  for (const p of data.points) p.from = p.from.filter(id => known.has(id));
  // Only kinds, ways of drawing and categories that exist.
  const category = CATEGORIES.find(c => c.id === data.category) ?? CATEGORIES[CATEGORIES.length - 1];
  const kinds = new Set(category.concepts.map(c => c.id)), proofs = new Set(PROOFS.map(p => p.id));
  data.category = category.id;
  for (const p of data.points) { if (p.concept && !kinds.has(p.concept)) p.concept = null; if (!proofs.has(p.proof)) p.proof = ''; }
  data.checks = data.checks.filter(c => kinds.has(c.concept));
  data.titles = Object.fromEntries(Object.entries(data.titles).filter(([k]) => (TASKS as string[]).includes(k)));
  // A theme keeps only the points that exist (numbered from 1).
  data.themes = data.themes.map(t => ({ ...t, points: t.points.filter(n => n >= 1 && n <= data.points.length) })).filter(t => t.points.length);
  // Only the versions the images show (wear.ts): 不要拼，不要猜.
  return { ...data, look: lookOf(data.look), wear: settleWear(data.wear, data.images, data.colors.map(c => c.name)) };
}

const sortedSchema = z.object({ images: z.array(imageSchema) });
const readSchema = organizeSchema.omit({ images: true }).extend({ recolor: z.record(z.string(), z.string()).catch({}).default({}) });
const unsorted = (id: string): SortedImage => ({ id, kind: '无关', color: '', front: false, detail: '', parts: [], text: false, logo: false, same: '', person: '', face: false });
/** One batch's images; one the model skipped is kept as unsorted rather than lost. */
export function parseSorted(content: string, ids: string[]): SortedImage[] {
  const raw = modelJson(content, '整理结果不是完整的 JSON');
  const parsed = sortedSchema.safeParse(raw);
  if (!parsed.success) throw new Error('整理结果缺少每张图的分类');
  const known = new Set(ids), images = parsed.data.images.filter(i => known.has(i.id));
  for (const i of images) if (i.same && !known.has(i.same)) i.same = '';
  return [...images, ...ids.filter(id => !images.some(i => i.id === id)).map(unsorted)];
}
/**
 * The model marks a copy with `same`, sometimes both ways round (10-14: every colour's white-
 * background still life and its colour image on the detail page, each marked the other's copy),
 * and an image marked `same` is skipped everywhere, so neither was used. A group of copies with
 * no original keeps one: the best source for a product image; a group with one is left as it is.
 */
export function settleCopies<I extends SortedImage>(images: I[]): I[] {
  const byId = new Map(images.map(i => [i.id, i])), links = new Map<string, Set<string>>();
  const link = (a: string, b: string) => links.set(a, (links.get(a) ?? new Set()).add(b));
  for (const i of images) if (i.same && byId.has(i.same) && i.same !== i.id) { link(i.id, i.same); link(i.same, i.id); }
  const keep = new Map<string, string>(), seen = new Set<string>();
  for (const start of images) {
    if (!links.has(start.id) || seen.has(start.id)) continue;
    const group: I[] = [], queue = [start.id];
    while (queue.length) { const id = queue.pop()!; if (seen.has(id)) continue; seen.add(id); group.push(byId.get(id)!); queue.push(...links.get(id)!); }
    if (group.some(i => !i.same)) continue;
    const best = group.reduce((a, b) => copyRank(b) > copyRank(a) ? b : a);
    for (const i of group) keep.set(i.id, i === best ? '' : best.id);
  }
  return images.map(i => i.same && !byId.has(i.same) ? { ...i, same: '' } : keep.has(i.id) ? { ...i, same: keep.get(i.id)! } : i);
}
const copyRank = (i: SortedImage) => (colourRank[i.kind] ?? 0) * 2 + (i.text ? 0 : 1);
/** The sorted images and the whole product's reading, put together as the one-call analysis gave them. */
export function parseRead(content: string, images: SortedImage[]): Organized {
  const raw = modelJson(content, '整理结果不是完整的 JSON');
  const parsed = readSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`整理结果缺少必要内容（${[...new Set(parsed.error.issues.map(i => String(i.path[0] ?? '结构')))].join('、')}）`);
  const { recolor, ...data } = parsed.data;
  return parseOrganized(JSON.stringify({ ...data, images: recolored(images, data.colors.map(c => c.name), recolor) }), images.map(i => i.id));
}
/**
 * Images are sorted in batches before the colours are known, so a batch may call a colour by a
 * name of its own (10-14: 「橙色」 on every model photo of a product in 「落霞橙」 and 「爱马仕橙」), and
 * those images were never picked for a colour. The reading names their colour (`recolor`); a label
 * that one colour's name alone contains (「蓝色」 with only 「北欧蓝」) is that colour.
 */
export function recolored<I extends { id: string; color: string }>(images: I[], names: string[], recolor: Record<string, string> = {}): I[] {
  const known = new Set(names.map(colorKey));
  return images.map(i => {
    if (!i.color || known.has(colorKey(i.color))) return i;
    const to = names.find(n => n === recolor[i.id]?.trim());
    if (to) return { ...i, color: to };
    const core = i.color.replace(/[色\s]/gu, ''), holding = core ? names.filter(n => n.includes(core)) : [];
    return holding.length === 1 ? { ...i, color: holding[0] } : i;
  });
}

/** Only a master that exists, a place it can shoot (on location only) and a known point. */
function lookOf(raw: { master: string; place: string; sell: string; why: string } | null): Look | null {
  const info = raw && MASTER_INFO[raw.master];
  if (!raw || !info || !BUILT_IN_LAYOUTS.some(l => l.id === raw.master)) return null;
  const place = info.cover === '实景' && raw.place in PLACES && !info.deny[raw.place as PlaceId] ? raw.place as PlaceId : undefined;
  const sell = place && raw.sell in SELLS ? raw.sell as Sell : undefined;
  return { master: raw.master, ...(place ? { place } : {}), ...(sell ? { sell } : {}), why: raw.why.trim() };
}

/** What one image is worth as the source of a colour's white-background product image. */
const colourRank: Partial<Record<MaterialKind, number>> = { 静物: 5, '3D渲染': 4, 颜色款图: 3, 模特实拍: 2, 卖点图: 1 };
type Size = { id: string; width: number; height: number };

/**
 * The program's pick from the sorted images: per colour the best whole-front image (a clean still
 * life first), a whole front view, and the parts with the most close-ups, under the names the model
 * gave them (the back view last). `sizes` breaks ties by resolution.
 */
export function chooseMaterials(sorted: Pick<Organized, 'images' | 'colors'>, sizes: Size[]) {
  const px = new Map(sizes.map(s => [s.id, s.width * s.height]));
  const usable = sorted.images.filter(i => !i.same && i.kind !== '无关' && i.kind !== '尺码表');
  const best = (list: SortedImage[], rank: (i: SortedImage) => number) => [...list].sort((a, b) => rank(b) - rank(a) || (px.get(b.id) ?? 0) - (px.get(a.id) ?? 0))[0]?.id ?? null;
  const colors = sorted.colors.map(c => {
    const own = usable.filter(i => !isComponent(i) && colourRank[i.kind] && (colorKey(i.color) === colorKey(c.name) || c.from.includes(i.id)));
    // With no whole front view, the garment itself open on a hanger (10-15: each 3-in-1 jacket showed its
    // liner; the liner alone was the only front view) is drawn closed rather than the colour left without one.
    // Its shell on its own first (10-22: 1888's 乌梅紫 was picked open over its down liner, the only front view sorted so).
    const fronts = own.filter(i => i.front), closed = fronts.filter(i => !i.inner), alone = own.filter(i => i.role === '主体' && !i.inner && !i.open);
    const candidates = closed.length ? closed : alone.length ? alone : fronts.length ? fronts : own.filter(i => i.role === '主体');
    // A shell worn open over its liner makes a poor white image: it would be drawn closed from guesswork (10-22: 1888's 乌梅紫).
    return { name: c.name, hex: c.hex, pick: best(candidates, i => (colourRank[i.kind] ?? 0) * 2 + facingScore(i) + (i.logo ? 0 : 1) - (isGroup(i) ? 3 : 0) - (i.plain === false ? 1 : 0) - (i.inner ? 4 : i.open ? 2 : 0)), candidates: candidates.map(i => i.id) };
  });
  // A full front view shows one garment: an image with one colour, ideally a colour's own pick.
  const picked = new Set(colors.map(c => c.pick));
  const fronts = usable.filter(i => !isComponent(i) && i.front && i.color && colourRank[i.kind]);
  // None whole and closed (10-19: 552's hanger shots, every jacket open): the first colour's own image, as
  // the colours themselves fall back to it, rather than a plan that cannot start until one is picked.
  const front = { part: FRONT, pick: best(fronts, i => (picked.has(i.id) ? 10 : 0) + (colourRank[i.kind] ?? 0) + facingScore(i) - (i.inner ? 4 : i.open ? 2 : 0)) ?? colors.find(c => c.pick)?.pick ?? null,
    candidates: fronts.length ? fronts.map(i => i.id) : colors.flatMap(c => c.pick ? [c.pick] : []) };
  const named = new Map<string, SortedImage[]>();
  // A part counts from an image sorted as it, and from a detail page that shows it among others (`parts`).
  for (const i of usable) for (const x of new Set([i.detail, ...(i.parts ?? [])])) if (x && x !== '其他') named.set(x, [...(named.get(x) ?? []), i]);
  const back = named.get('背面');
  named.delete('背面');
  const parts = [...[...named].sort(([, x], [, y]) => y.length - x.length).slice(0, MAX_PARTS), ...(back ? [['背面', back] as const] : [])]
    .map(([part, list]) => ({ part, pick: best(list, i => (i.detail === part ? 2 : 0) + (i.kind === '细节特写' ? 1 : 0)), candidates: list.map(i => i.id) }));
  return { colors, parts: [front, ...parts] };
}
