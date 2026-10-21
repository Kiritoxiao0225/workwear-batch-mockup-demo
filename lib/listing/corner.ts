/**
 * 电商主图: the shop's own LOGO in the top-left corner of its 1:1 and 3:4 main images (店铺设置, 10-18).
 * The model never draws it (a redrawn LOGO comes out wrong, and again on every 3:4 relayout): the
 * prompt keeps the corner empty, and the program pastes the LOGO on the image as it is shown and
 * downloaded (listing-corner.ts). The stored image stays clean for the 3:4 relayout, 画板 and 点图修改,
 * and turning it off or changing the LOGO needs no image made again. Tested on M1–M5 before shipping
 * (all 30 kept the corner, 3:4 included).
 */
import type { Box, Template } from './templates';

/** Where the LOGO goes, as fractions of the image's width: the same pixels on 1:1 and 3:4. */
export const LOGO_BOX = { left: 0.04, top: 0.035, width: 0.2, height: 0.08 } as const;

/** The corner kept empty, in percent of a square image; a layout with something up there moves down to start below it. */
const CORNER = { width: 26, height: 13 };
const TOP = 13, SCALE = 0.87;

export const CORNER_LINE = `左0% 上0% 宽${CORNER.width}% 高${CORNER.height}%：左上角空位，之后要贴店铺 LOGO。这块只有背景本身，和旁边的背景自然连着；不放任何字、英文、图标、标签、色块、线条和装饰，人物的头和手也不伸进来。`;
/** When a layout that starts at the top edge moved down: what is left above it. */
export const CORNER_BAND = `画面最上面约 ${TOP}% 高是一条留白横条，用和整体协调的干净底色，左上角空位就在这条里。`;
/** A 3:4 image laid out again from a square one that kept the corner. */
export const CORNER_KEEP = '参考图1左上角留着一块空位（之后要贴店铺 LOGO）：竖图里也照样留着，左0% 上0% 宽26% 高10% 只有背景，不放任何字、英文、图标和装饰，人物的头和手也不伸进来；参考图1里排在空位下面的字和卡片，竖图里也排在它下面。';
/** An image redrawn as the user asks: the corner stays empty. */
export const cornerStay = (portrait: boolean) => `左上角那块空位（之后要贴店铺 LOGO）照样空着：左0% 上0% 宽26% 高${portrait ? 10 : 13}% 只有背景，不放任何字、英文、图标和装饰。`;

/** The whole picture (a person or a scene behind everything) stays where it is; it is only told to keep out. */
const behind = (b: Box) => b[2] >= 90 && b[3] >= 85;
const inCorner = (b: Box) => !behind(b) && b[0] < CORNER.width && b[1] < CORNER.height;
const down = (b: Box): Box => [b[0], Math.round(TOP + b[1] * SCALE), b[2], Math.round(b[3] * SCALE)];
/** Whether the boxes move down (one of them is in the corner), and whether one of them started at the top edge. */
function plan(boxes: (Box | null)[]) {
  const move = boxes.some(b => !!b && inCorner(b));
  return { move, band: move && boxes.some(b => !!b && !behind(b) && b[1] === 0 && b[0] < CORNER.width) };
}

const AT = /^左(\d+)% 上(\d+)% 宽(\d+)% 高(\d+)%：/;
/**
 * A spec's zones (listing-specs.ts) with the corner kept: the corner line first, and when anything
 * but the picture behind is up there, every such zone moved down together, so nothing overlaps.
 */
export function cornerZones(zones: string[]) {
  const boxes = zones.map(z => { const m = AT.exec(z); return m ? m.slice(1, 5).map(Number) as Box : null; });
  const { move, band } = plan(boxes);
  return {
    zones: [CORNER_LINE, ...zones.map((z, i) => {
      const b = boxes[i];
      if (!move || !b || behind(b)) return z;
      const [l, t, w, h] = down(b);
      return z.replace(AT, `左${l}% 上${t}% 宽${w}% 高${h}%：`);
    })],
    band,
  };
}

/** A template (templates.ts) with the corner kept, the same way. */
export function cornerTemplate(t: Template) {
  const { move, band } = plan(t.zones.map(z => z.box));
  return { template: move ? { ...t, zones: t.zones.map(z => behind(z.box) ? z : { ...z, box: down(z.box) }) } : t, band };
}
