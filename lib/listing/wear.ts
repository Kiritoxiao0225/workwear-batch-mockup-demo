/**
 * 电商主图: how a jacket is worn, read from its material (10-21). Three types: 春秋薄款 (a single
 * shell, and a 3-in-1 whose liner is never shown), 有内胆 (a 3-in-1 shown with its liner) and 一体款
 * (padding or fleece sewn in). Only a 有内胆 jacket has SKU versions within a colour, and only the
 * versions the material shows: 「不要拼，不要猜，从素材里看到什么就整什么」. A shell photo and a
 * liner photo never make a 外壳加内胆 version; the program checks every version against the images
 * the model says show it, and drops it when none does.
 */
export const WEARS = ['薄款', '内胆', '一体'] as const;
export type WearType = (typeof WEARS)[number];
export const WEAR_LABEL: Record<WearType, string> = { 薄款: '春秋薄款', 内胆: '有内胆', 一体: '一体棉·绒' };
/** What a liner is made of, as an image shows it; 抓绒 counts as 摇粒绒. */
export const INNERS = ['摇粒绒', '羽绒', '棉', '其他'] as const;
export type Inner = (typeof INNERS)[number];
export const VERSION_KINDS = ['单外壳', '外壳加内胆', '单内胆'] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];
/** One SKU version the material shows: its colours (the shell's, or the liner's own for 单内胆) and the images showing it. */
export type SkuVersion = { kind: VersionKind; inner: Inner | ''; colors: string[]; from: string[] };
export type Wear = { type: WearType; why: string; versions: SkuVersion[] };

/** What the program needs of a sorted image to check a version. */
type Seen = { id: string; kind?: string; role?: string; inner?: string; innerColor?: string; color: string; colorsSeen?: string[] };
/** Real photos of the garment: a version needs one (10-21: one detail page read a down liner as 棉). */
const PHOTO_KINDS = new Set(['模特实拍', '静物', '3D渲染', '颜色款图']);

export const versionName = (v: Pick<SkuVersion, 'kind' | 'inner'>) => v.kind === '单外壳' ? '单外壳' : v.kind === '外壳加内胆' ? `外壳 + ${v.inner}内胆` : `单穿${v.inner}内胆`;

/**
 * One shell colour over one liner colour is one liner: read as two materials, the one most images
 * show is taken (10-21: 6609's 安哥拉红 over a black liner, 羽绒 on ten images and 棉 on one).
 */
function oneLinerEach(images: Seen[]): Seen[] {
  const key = (i: Seen) => i.role === '主体' && i.inner && i.color && i.innerColor ? `${i.color}|${i.innerColor}` : '';
  const counts = new Map<string, Map<string, number>>();
  for (const i of images) { const k = key(i); if (k) { const m = counts.get(k) ?? new Map(); m.set(i.inner!, (m.get(i.inner!) ?? 0) + 1); counts.set(k, m); } }
  const most = new Map([...counts].map(([k, m]) => [k, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
  return images.map(i => { const k = key(i); return k && most.get(k) !== i.inner ? { ...i, inner: most.get(k) } : i; });
}

/** Does this image show this version: the shell alone, the shell with this liner inside, or this liner alone. */
function shows(v: Pick<SkuVersion, 'kind' | 'inner'>, i: Seen) {
  if (v.kind === '单内胆') return i.role === '内胆' && i.inner === v.inner;
  if (i.role !== '主体') return false;
  return v.kind === '单外壳' ? !i.inner : i.inner === v.inner;
}

/**
 * The model's reading, kept only as far as the images bear it out: each version keeps the images
 * that really show it and the colours seen on them; a version no
 * image shows is dropped. A 有内胆 reading with no liner version left is a 3-in-1 whose liner is
 * never shown, so it is worn as 薄款.
 */
export function settleWear(raw: { type?: string; why?: string; versions?: { kind?: string; inner?: string; colors?: string[]; from?: string[] }[] } | null | undefined, sorted: Seen[], colors: string[]): Wear | null {
  if (!raw || !(WEARS as readonly string[]).includes(raw.type ?? '')) return null;
  const images = oneLinerEach(sorted);
  const byId = new Map(images.map(i => [i.id, i]));
  const shells = new Set(images.filter(i => i.role === '主体').map(i => i.color).filter(Boolean));
  const linerOnly = new Set(images.filter(i => i.role === '内胆').map(i => i.innerColor || i.color).filter(c => c && !shells.has(c)));
  const versions: SkuVersion[] = [];
  for (const r of raw.type === '内胆' ? raw.versions ?? [] : []) {
    const kind = (VERSION_KINDS as readonly string[]).includes(r.kind ?? '') ? r.kind as VersionKind : null;
    const inner = kind === '单外壳' ? '' : (INNERS as readonly string[]).includes(r.inner ?? '') ? r.inner as Inner : null;
    if (!kind || inner === null) continue;
    const from = [...new Set(r.from ?? [])].filter(id => { const i = byId.get(id); return !!i && shows({ kind, inner }, i); });
    const all = images.filter(i => shows({ kind, inner }, i));
    if (!from.length || !all.some(i => !i.kind || PHOTO_KINDS.has(i.kind))) continue;
    // Its colours from every image sorted as showing it, not only the few the reading names (10-21: 1888's 单外壳 named 2 of its 4 colours).
    // With a liner, only the shell that wears it counts: a poster of several shells paired every one of them with the liner.
    const seen = all.flatMap(i => kind === '单内胆' ? [i.innerColor || i.color] : kind === '外壳加内胆' ? [i.color] : [i.color, ...(i.colorsSeen ?? [])]).filter(Boolean);
    // A liner's own colour is not a shell colour, unless a shell is seen in it on its own (10-21: 1888's beige fleece, worn alone in the group photos).
    const shown = kind === '单内胆' ? [...new Set(seen)] : colors.filter(c => seen.includes(c) && (!linerOnly.has(c)));
    const same = versions.find(v => v.kind === kind && v.inner === inner);
    if (same) { same.from = [...new Set([...same.from, ...from])]; same.colors = [...new Set([...same.colors, ...shown])]; }
    else versions.push({ kind, inner, colors: shown, from });
  }
  const lined = versions.some(v => v.kind !== '单外壳');
  if (raw.type === '内胆' && !lined) return { type: '薄款', why: `素材里没拍到内胆，按春秋薄款穿（${raw.why ?? ''}）`.slice(0, 120), versions: [] };
  return { type: raw.type as WearType, why: (raw.why ?? '').slice(0, 120), versions: raw.type === '内胆' ? versions : [] };
}

/**
 * Whether the garment's own description (the writing step's, from the material) says a flap covers
 * its zip when closed. 10-23, 6609: 「拉链拉到胸口」 on a jacket whose 门襟 hides the zip drew a pull
 * floating on the flap; zipped up, the material shows the flap whole and no pull at all.
 */
export const coveredZip = (garment: string[]) => garment.some(l => /(遮住|盖住|遮盖|覆盖|挡住)[^。；]{0,6}(链齿|拉链)/.test(l));
/** How a zip under a flap looks closed, as the material shows it. */
export const COVERED_ZIP = '拉链藏在门襟下面看不见（不画拉头和链齿），门襟上有按扣的照样画出';
/** An open jacket: where its pull is (10-23: a pull drawn on its own in the middle of the jacket). */
const OPEN_PULL = '拉开后拉头在下摆底端，衣服中间不出现单独的拉头';

/**
 * How the jacket is worn on every image with people, by its type (the comparison images of 10-21):
 * 有内胆 open over its liner, 一体 zipped to the top. `liner`: the reference image that shows the
 * liner, on the cast and the SKU models; the main images copy the cast. `covered`: its zip is under
 * a flap (coveredZip). Null: as before, zipped to the chest over a white T-shirt.
 */
export function wearLine(type: WearType | undefined, liner?: number, color?: string, covered = false): string | null {
  if (type === '一体') return `${covered ? `门襟一直合到最顶，${COVERED_ZIP}` : '拉链一直拉到最顶'}，领子立起来护住脖子和下巴，看不到里面的 T 恤；衣服里面有填充，整体蓬松厚实，一看就是秋冬保暖款，不是一层薄外壳`;
  // The liner's colour said outright (10-22: drawn from a couple photo, 翠绿 took the light grey liner of the woman beside).
  if (type === '内胆') return liner
    ? `外套拉链拉开、敞着穿，${OPEN_PULL}，里面穿着这款配套的${color ? `${color}` : ''}内胆（参考图${liner}里外套下面那一件：${color ? `${color}，` : '颜色、'}材质、绗缝格子和领子都照它${color ? `；参考图里别人身上的别的颜色内胆不算` : ''}），内胆拉链拉到领口；一眼看得出是外壳加内胆两层，整体厚实保暖`
    : `外套拉链拉开、敞着穿，${OPEN_PULL}，里面穿着内胆（内胆的样子和定妆照里一样），内胆拉链拉到领口；一眼看得出是外壳加内胆两层，整体厚实保暖`;
  if (covered) return `门襟合到胸口，领口敞开一点露出里面的白色圆领 T 恤；${COVERED_ZIP}`;
  return null;
}
/** The reference line for the liner photo: only the liner is taken from it. */
export const linerRefLine = (n: number) => `参考图${n}是这款的内胆照片，只看外套里面那一件内胆的样子；照片里的人、外套、帽子、背景都不要带过来。`;

/** A photo to draw the cast's liner from: the shell over the liner, one person, in the main colour if there is one, facing the camera. */
export function linerPhoto(images: { id: string; kind: string; role?: string; inner?: string; color: string; person?: string; facing?: string; same?: string }[], inner: string, main: string): string | null {
  const rank = (i: (typeof images)[number]) => (i.color === main ? 4 : 0) + (i.person === '男' || i.person === '女' ? 2 : 0) + (i.kind === '模特实拍' ? 2 : 0) + (i.facing === '正对' ? 1 : 0);
  return images.filter(i => i.role === '主体' && i.inner === inner && !i.same && ['模特实拍', '静物', '3D渲染'].includes(i.kind)).sort((a, b) => rank(b) - rank(a))[0]?.id ?? null;
}

/** A liner sold alone, worn on its own (its SKU image). */
export const LINER_ALONE_WEAR = '只穿这件内胆，外面不穿外套：内胆拉链拉到胸口，里面是白色圆领 T 恤';
/** The first reference of a liner worn alone: its photo in the material, the liner only. */
export const linerSubject = (inner: string, color: string) => `参考图1是这件${inner}内胆「${color}」的照片，内胆的颜色、材质、领子和拉链以它为准；照片里的人、背景和别的衣服都不要带过来。`;

/**
 * A version over a liner with nothing clear to draw the liner from (10-22, 大俊's idea): zipped to the
 * top, the liner unseen, so it is never drawn wrong; the card's pill and thumbnail say which liner.
 */
export const ZIPPED_WEAR = '拉链一直拉到最顶，领子立起来，看不到里面穿的是什么；整体厚实保暖';
/** ZIPPED_WEAR for a zip under a flap. */
export const zippedWear = (covered: boolean) => covered ? `门襟一直合到最顶，${COVERED_ZIP}，领子立起来，看不到里面穿的是什么；整体厚实保暖` : ZIPPED_WEAR;
