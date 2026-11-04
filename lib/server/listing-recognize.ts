/**
 * 电商主图: where the things on a finished image really are. The generator places the layout's
 * zones only roughly, so after each main image is made the analysis model is shown it with the
 * list of what should be on it and returns a box for each thing it finds (and for anything the
 * generator added on its own). The 画板 outlines these; without them it falls back to the layout.
 */
import { z } from 'zod';
import type { Element } from '../listing/api-types';

/** One thing the plan put on the image: its zone ("card2"), kind and words. */
export type Expected = { zone: string; kind: string; text?: string };

const SYSTEM = `你会收到一张做好的电商主图，和它的设计说明（这张图上应该有哪些东西）。找出图上实际画出来的每样东西在哪里。只输出 JSON。
- box 是 [左, 上, 宽, 高]，都是占整张图宽或高的百分比（0–100），紧贴那样东西的外沿。
- 说明里有、图上也画了的：zone 照抄说明里的编号，kind 照抄；text 写图上实际读到的字（和说明里的不一样就照图上的写）。
- 说明里有、图上没画的：不要列。
- 图上有、说明里没有的平面元素（模型自己加的字、图标、徽章、色块、小图、箭头）：zone 写 null，kind 写 other，label 用几个字说是什么，text 写上面的字。背景和场景里的东西（家具、植物、文具、建筑、道具）不要列。
- 人物写一个框，框住人的身体（多人就框住所有人）。卡片框住整张卡片，包括卡片下面的那行字。`;

export function recognizeRequest(input: { image: Buffer; expected: Expected[]; model: string }) {
  const list = input.expected.map(e => `${e.zone}（${e.kind}）${e.text ? `：「${e.text}」` : ''}`).join('\n');
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 3000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: [
      { type: 'text', text: `设计说明：\n${list}\n\n输出：{ "elements": [{ "zone": "title1", "kind": "title", "box": [0, 0, 0, 0], "text": "", "label": "" }] }` },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.image.toString('base64')}` } },
    ] }] };
}

const KINDS = ['title', 'sub', 'tag', 'card', 'icon', 'person', 'garment', 'swatch', 'other'] as const;
const schema = z.object({ elements: z.array(z.object({
  zone: z.string().max(20).nullable().catch(null), kind: z.enum(KINDS).catch('other'),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]), text: z.string().max(80).default(''), label: z.string().max(30).default(''),
})).max(30) });

/** The model's boxes, kept inside the image; a zone the plan does not have becomes one of the model's own. */
export function parseRecognized(content: string, expected: Expected[]): Element[] {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return []; }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return [];
  const zones = new Set(expected.map(e => e.zone)), seen = new Set<string>();
  return parsed.data.elements.flatMap((e, i) => {
    const [l, t, w, h] = e.box.map(v => Math.max(0, Math.min(100, v)));
    if (w < 1 || h < 1) return [];
    const zone = e.zone && zones.has(e.zone) && !seen.has(e.zone) ? e.zone : undefined;
    if (zone) seen.add(zone);
    const box: Element['box'] = [l, t, Math.min(w, 100 - l), Math.min(h, 100 - t)].map(v => Math.round(v * 10) / 10) as Element['box'];
    return [{ id: zone ?? `x${i + 1}`, kind: zone ? e.kind : 'other', box, ...(e.text ? { text: e.text } : {}), ...(zone ? { zone } : { label: e.label || '模型自己加的' }) }];
  });
}

/** Where the model is on a photo, in fractions: the top of the head, the knees (below 1 when out of the frame), the left and right of the body. */
export type Frame = { top: number; knee: number; left: number; right: number };

const FRAME_SYSTEM = `你会收到一张服装模特照片。找出照片里的模特（几个人就把所有人当成一个整体），只输出 JSON。
- top：头顶（含头发和帽子）离画面上沿的距离；knee：膝盖离画面上沿的距离；left、right：人身体（含手臂）最左、最右边离画面左沿的距离。
- 都是占整张图高或宽的百分比。膝盖在画面外的，按身体比例推算，写大于 100 的数。`;

/** A SKU image shows the material's model photo head to knees; the analysis model finds them. */
export function frameRequest(input: { image: Buffer; model: string }) {
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 1000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: FRAME_SYSTEM }, { role: 'user', content: [
      { type: 'text', text: '输出：{ "top": 0, "knee": 0, "left": 0, "right": 0 }' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.image.toString('base64')}` } },
    ] }] };
}

const frameSchema = z.object({ top: z.number().min(0).max(90), knee: z.number().max(250), left: z.number().min(0).max(100), right: z.number().min(0).max(100) });
/** The frame, or null when it makes no sense (knees above the head, no width). */
export function parseFrame(content: string): Frame | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  const f = frameSchema.safeParse(raw);
  if (!f.success || f.data.knee - f.data.top < 10 || f.data.right - f.data.left < 5) return null;
  return { top: f.data.top / 100, knee: f.data.knee / 100, left: f.data.left / 100, right: f.data.right / 100 };
}

/**
 * 一体 cover worn open (11-01): the material's photo of the inside often shows two linings, the front
 * panels' (what one sees when one side is pulled open) and the back's down the middle, in another
 * colour or print. Sent whole, the model painted the back's big silver print onto the opened front
 * (8826; a crop of the front panel alone came out right), so the analysis model finds that panel first.
 */
const INSIDE_SYSTEM = `你会收到一张衣服里面的照片（衣服翻开平铺、挂着敞开，或人穿着拉开一边）。只输出 JSON。
人穿上这件衣服、一只手把一边门襟拉开时，露出来的是「前片的里面」：靠门襟拉链的那一长条衣片的反面。找出它在照片里的位置。
- 衣服里面常常不是一块料：前片里面和后背中间的里布颜色、花纹、绗缝可能都不一样。只框前片里面，不要框进后背中间那块、外面的面料、帽子、吊牌、背景。
- 左右两边前片都看得到时，选更完整、更清楚、没有缝标签的一边。
- 照片本来就是人穿着拉开一边的特写时，框住露出来的那片里面。
- box 是 [左, 上, 宽, 高]，都是占整张图宽或高的百分比（0–100），从领口下面框到下摆。
- 找不到前片里面（比如只拍了面料、或看不出哪块是前片），found 写 false。`;

export function insideBoxRequest(input: { image: Buffer; model: string }) {
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 1000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: INSIDE_SYSTEM }, { role: 'user', content: [
      { type: 'text', text: '输出：{ "found": true, "box": [0, 0, 0, 0], "what": "几个字说框住的是什么" }' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.image.toString('base64')}` } },
    ] }] };
}

/**
 * A liner on a photo for its SKU thumbnail (11-04): is this liner on it, and where. 8828's 红色 soft
 * liner photo was a shop rack, and may have shown the shell, not the liner.
 */
const LINER_SYSTEM = `你会收到一张素材照片，和一件三合一外套的内胆（可以单独穿的那件里层衣服）的名字和颜色。只输出 JSON。
找出照片里这件内胆的位置，用来把它整理成电商白底图。
- 只认这件内胆本身：名字说的那种内胆（比如羽绒、软壳、抓绒），颜色对得上。外面那件外壳、别的衣服、衣架、货架、背景都不算。
- 照片里有人穿着它时，框住它露出来的整件，不要框人脸和下半身。
- 照片里有好几件时，选最完整、最清楚、颜色对得上的那一件。
- 照片里看不到这件内胆（比如拍的是外壳，或只是一角看不清），found 写 false。
- box 是 [左, 上, 宽, 高]，都是占整张图宽或高的百分比（0–100），框住整件，四周别留太多。`;

export function linerBoxRequest(input: { image: Buffer; inner: string; color: string; model: string }) {
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 1000, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: LINER_SYSTEM }, { role: 'user', content: [
      { type: 'text', text: `内胆：${input.inner}内胆，颜色「${input.color}」。\n输出：{ "found": true, "box": [0, 0, 0, 0], "what": "几个字说框住的是什么" }` },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.image.toString('base64')}` } },
    ] }] };
}
/** The liner as fractions [left, top, width, height], or null: not on the photo, or too small to show it. */
export function parseLinerBox(content: string): [number, number, number, number] | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  const p = insideSchema.safeParse(raw);
  if (!p.success || !p.data.found || !p.data.box) return null;
  const [l, t, w, h] = p.data.box.map(v => Math.max(0, Math.min(100, v)));
  const box = [l, t, Math.min(w, 100 - l), Math.min(h, 100 - t)];
  return box[2] < 8 || box[3] < 8 ? null : box.map(v => v / 100) as [number, number, number, number];
}

/**
 * Can a liner's photo on white show it as it is (11-04): from the front, zipped, whole, nobody in it. 8828's
 * black down liner had three on white: laid open showing its inside (ranked first and used), its back, its front.
 */
export function linerViewRequest(input: { image: Buffer; inner: string; color: string; model: string }) {
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 600, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: '你会收到一张三合一外套内胆的商品照片。只输出 JSON。判断这张照片能不能直接当「这件内胆长什么样」的参考：'
      + '要从正面看（不是背面、不是侧面、不是拉开摊平露出里面），拉链拉好或基本合上，整件都在画面里（领子到下摆、两只袖子），没有人穿。' },
      { role: 'user', content: [
        { type: 'text', text: `内胆：${input.inner}内胆，颜色「${input.color}」。\n输出：{ "front": true, "zipped": true, "whole": true, "worn": false, "what": "几个字说拍的是什么样子" }` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.image.toString('base64')}` } },
      ] }] };
}
/** Front, zipped, whole and not worn; false when the answer cannot be read. */
export function parseLinerView(content: string): boolean {
  try {
    const v = z.object({ front: z.boolean(), zipped: z.boolean(), whole: z.boolean(), worn: z.boolean().optional() }).safeParse(JSON.parse(content));
    return v.success && v.data.front && v.data.zipped && v.data.whole && !v.data.worn;
  } catch { return false; }
}

/**
 * What a liner's surface is like, read off its photo on white (11-04), for the SKU images over it: the
 * words come from the photo, never from a rule (8828's down liner had come out smooth).
 */
export function linerLookRequest(input: { image: Buffer; name: string; model: string }) {
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 600, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: `你会收到一件三合一外套内胆的白底图。只输出 JSON。用不超过 30 个字说这件内胆表面看起来什么样，给画图的人照着画：有没有绗缝格子、格子是横的竖的还是菱形、大概多宽、每格鼓不鼓、亮面还是哑光、面料什么质感。只说看得到的，不猜材料成分。` },
      { role: 'user', content: [
        { type: 'text', text: `这是一件${input.name}内胆。输出：{ "look": "……" }` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.image.toString('base64')}` } },
      ] }] };
}
export function parseLinerLook(content: string): string {
  try { const look = z.object({ look: z.string() }).safeParse(JSON.parse(content)); return look.success ? look.data.look.trim().replace(/[。\s]+$/, '').slice(0, 40) : ''; } catch { return ''; }
}

/**
 * Is the liner showing on a drawn SKU image the one on its photo on white (11-04): the image is drawn
 * once more when not, so the user is not asked to look for it.
 */
export function linerMatchRequest(input: { drawn: Buffer; liner: Buffer; name: string; model: string }) {
  const url = (b: Buffer) => `data:image/jpeg;base64,${b.toString('base64')}`;
  return { model: input.model, reasoning_effort: 'low', max_completion_tokens: 600, response_format: { type: 'json_object' }, stream: false,
    messages: [{ role: 'system', content: `你会收到两张图。图1：模特穿着三合一外套，外套敞开，里面露出一件内胆。图2：这件${input.name}内胆单独的白底图。只输出 JSON。
看图1里露出来的那一长条内胆和图2是不是同一件：表面的绗缝格子（有没有、方向、间距）、每格鼓起的厚薄、亮面还是哑光对不对得上。颜色深浅、光线、角度不同不算错；图1露出的部分本来就窄，只要看得出是同样的格子和鼓起就算对。
图2有明显绗缝而图1露出的内胆是光滑平整的一片，算不对。` },
      { role: 'user', content: [
        { type: 'text', text: '输出：{ "same": true, "why": "不对时用一句话说图1哪里和图2不一样" }' },
        { type: 'image_url', image_url: { url: url(input.drawn) } }, { type: 'image_url', image_url: { url: url(input.liner) } },
      ] }] };
}
/** The verdict, or null when it cannot be read (then the image is kept as drawn). */
export function parseLinerMatch(content: string): { same: boolean; why: string } | null {
  try { const m = z.object({ same: z.boolean(), why: z.string().optional() }).safeParse(JSON.parse(content)); return m.success ? { same: m.data.same, why: (m.data.why ?? '').trim().slice(0, 80) } : null; } catch { return null; }
}

const insideSchema = z.object({ found: z.boolean(), box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional() });
/** The front panel's inside as fractions [left, top, width, height], or null: not found, or too small to be a panel. */
export function parseInsideBox(content: string): [number, number, number, number] | null {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return null; }
  const p = insideSchema.safeParse(raw);
  if (!p.success || !p.data.found || !p.data.box) return null;
  const [l, t, w, h] = p.data.box.map(v => Math.max(0, Math.min(100, v)));
  const box = [l, t, Math.min(w, 100 - l), Math.min(h, 100 - t)];
  return box[2] < 5 || box[3] < 15 ? null : box.map(v => v / 100) as [number, number, number, number];
}
