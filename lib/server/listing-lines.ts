/**
 * Lines that several 电商主图 prompts share (listing-prompts, listing-specs).
 */

/**
 * Several colours in one image: each keeps its own structure. 「款式都一样」 made the model give two
 * colours of one product the other colours' pockets and seams (10-18: 318's 灰绿 and 米白).
 */
export const SAME_STYLE = '款式也照各自对应的参考图：不同颜色之间的结构差异（拼接线、口袋、挡片、帽绳、袖臂袋）要保留，不要统一成一种';

/**
 * What the garment itself carries stays as it is. 「不要任何 logo、文字」 made the model redraw a
 * sleeve badge as a triangle and drop the printed words on a sleeve (10-18: 1888's 袖标); the user wants
 * whatever is on the garment kept, brand words too.
 */
export const OWN_MARKS = '衣服本身带的袖标、织标、印字和图案照参考图原样保留：形状、字、颜色、大小和在哪只袖子上都不变，不要改画，也不要左右镜像';

/** Nothing printed on the chest (the plan's 「不印」): the garment's own marks still stay. */
export const NO_CHEST = '胸口不另外印字。';
