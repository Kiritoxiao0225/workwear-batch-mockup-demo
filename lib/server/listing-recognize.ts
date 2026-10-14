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
