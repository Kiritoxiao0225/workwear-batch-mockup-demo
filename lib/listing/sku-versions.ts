/**
 * 电商主图 SKU images by version (10-22). A 有内胆 jacket is sold as its shell alone, the shell over a
 * liner, or a liner alone; the plan lists the versions its material shows (wear.ts) and the user ticks
 * them or adds one. Each ticked version gives one SKU image per colour it is shown in. Every colour
 * keeps its own SKU image under its key (the main images of several colours copy it): its 单外壳 one,
 * or its first version over a liner when the user dropped 单外壳. The other versions are keyed
 * `<colour key>~<version>`, a liner worn alone `~<version>~<n>` by its own colour.
 */
import type { Draft } from './draft';
import { INNERS, VERSION_KINDS, versionName, type Inner, type SkuVersion, type VersionKind } from './wear';

/**
 * A version on the plan: as read from the material, or added by the user (`added`, drawn from `ref`, an image's label).
 * `liners`: over a liner, the liner's colour under each shell colour the user set (10-22); '' is zipped up, the liner
 * unseen. A colour not set wears the liner the material shows it in, and one the material never shows it in is zipped up.
 */
export type DraftVersion = { key: string; kind: VersionKind; inner: Inner | ''; colors: string[]; on: boolean; added?: boolean; ref?: string; liners?: Record<string, string> };
export { INNERS, VERSION_KINDS };

export const draftVersions = (versions: SkuVersion[]): DraftVersion[] => versions.map((v, i) => ({ key: `v${i + 1}`, kind: v.kind, inner: v.inner, colors: v.colors, on: true }));

/** One SKU image: `color` the colour's key (none for a liner worn alone), `name` the colour it shows, `version` none as before. */
export type SkuItem = { key: string; color?: string; name: string; version?: DraftVersion; label: string };

export function skuItems(d: Pick<Draft, 'versions'>, colors: { name: string; sku: string }[]): SkuItem[] {
  const on = (d.versions ?? []).filter(v => v.on && v.colors.length);
  if (!on.length) return colors.map(c => ({ key: c.sku, color: c.sku, name: c.name, label: c.name }));
  const shell = on.find(v => v.kind === '单外壳'), items: SkuItem[] = [];
  for (const c of colors) {
    const lined = on.filter(v => v.kind === '外壳加内胆' && v.colors.includes(c.name));
    // The colour's own image: its shell alone when that is ticked (or nothing else shows the colour), else its first liner.
    const own = shell?.colors.includes(c.name) || !lined.length ? shell?.colors.includes(c.name) ? shell : undefined : lined[0];
    items.push({ key: c.sku, color: c.sku, name: c.name, ...(own ? { version: own } : {}), label: own ? `${c.name} · ${versionName(own)}` : c.name });
    for (const v of lined.filter(v => v !== own)) items.push({ key: `${c.sku}~${v.key}`, color: c.sku, name: c.name, version: v, label: `${c.name} · ${versionName(v)}` });
  }
  for (const v of on.filter(v => v.kind === '单内胆')) v.colors.forEach((n, i) => items.push({ key: `~${v.key}~${i}`, name: n, version: v, label: `${n} · ${versionName(v)}` }));
  return items;
}

type Img = { id: string; kind: string; role?: string; inner?: string; innerColor?: string; color: string; person?: string; face?: boolean; facing?: string; same?: string };
/** Does this image show this item: the shell in its colour alone, over its liner, or the liner alone in its colour. */
function shows(item: SkuItem, i: Img) {
  const v = item.version;
  if (!v) return i.role !== '内胆' && i.color === item.name;
  if (v.kind === '单内胆') return i.role === '内胆' && i.inner === v.inner && (i.innerColor || i.color) === item.name;
  return i.role === '主体' && i.color === item.name && (v.kind === '单外壳' ? !i.inner : i.inner === v.inner);
}
/**
 * The material's own model photo of an item, used as it is (no drawing, nothing charged): one person
 * (the lead first) or the pair the cover has, a clear face, facing the camera.
 */
export function itemPhoto(images: Img[], item: SkuItem, lead: '男' | '女', pair: boolean): string | null {
  const single = (p?: string) => p === '男' || p === '女';
  const rank = (i: Img) => (pair ? (i.person === '男女' ? 4 : 1) : i.person === lead ? 4 : single(i.person) ? 2 : 1) + (i.face ? 1 : 0) + (i.facing === '正对' ? 0.6 : i.facing === '微侧' ? 0.3 : 0);
  // One person for one, the pair for two (10-22: a couple photo stood for 翠绿, worn by the man beside a woman in white).
  // Over a liner, a photo in the liner colour it is drawn in (10-22).
  const liner = item.version?.kind === '外壳加内胆' ? linerFor(images, item.version, item.name) : null;
  return images.filter(i => i.kind === '模特实拍' && (pair ? i.person === '男女' : single(i.person)) && !i.same && shows(item, i) && (liner === null || i.innerColor === liner)).sort((a, b) => rank(b) - rank(a))[0]?.id ?? null;
}
/**
 * An image of an item to draw it from: the user's `ref` first, else one person or no one on it (a
 * still life). A group photo is never one (10-22: 翠绿 took the light grey liner of the woman beside);
 * with none, a version over a liner is drawn zipped up (ZIPPED_WEAR).
 */
export function itemReference(images: Img[], item: SkuItem, liner?: string): string | null {
  if (item.version?.ref) return item.version.ref;
  // Over a liner, one in the colour it is drawn in (10-22): another colour's photo would carry its liner over.
  if (item.version?.kind === '外壳加内胆' && liner !== undefined) {
    if (!liner) return null;
    const rank = (i: Img) => (i.color === item.name ? 4 : 0) + (i.kind === '模特实拍' ? 2 : 0) + (i.person === '男' || i.person === '女' ? 1 : 0);
    // No shell over it in that colour: the liner worn alone in it shows what to draw.
    return images.filter(i => !i.same && i.role === '主体' && i.inner === item.version!.inner && i.innerColor === liner && (!i.person || i.person === '男' || i.person === '女'))
      .sort((a, b) => rank(b) - rank(a))[0]?.id ?? linerAlone(images.filter(i => (i.innerColor || i.color) === liner), item.version.inner, liner);
  }
  const rank = (i: Img) => (i.kind === '模特实拍' ? 2 : i.kind === '静物' || i.kind === '3D渲染' ? 1 : 0) + (i.person === '男' || i.person === '女' ? 1 : 0);
  const best = (list: Img[]) => list.filter(i => !i.same && (!i.person || i.person === '男' || i.person === '女')).sort((a, b) => rank(b) - rank(a))[0]?.id ?? null;
  // A colour the user ticked that the material shows in this version only in other colours: its liner from one of them.
  return best(images.filter(i => shows(item, i))) ?? (item.version ? best(images.filter(i => shows({ ...item, name: i.color }, i) || (item.version!.kind === '单内胆' && shows({ ...item, name: i.innerColor || i.color }, i)))) : null);
}
/** The liner colours the material shows a shell colour in over this liner, most often first. */
export function linersSeen(images: Img[], inner: string, shell: string): string[] {
  const n = new Map<string, number>();
  for (const i of images) if (i.role === '主体' && i.inner === inner && i.color === shell && i.innerColor) n.set(i.innerColor, (n.get(i.innerColor) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}
/** Every colour the material shows this liner in, over a shell or alone. */
export const linerColors = (images: Img[], inner: string) => [...new Set(images.filter(i => i.inner === inner && (i.innerColor || (i.role === '内胆' && i.color))).map(i => i.innerColor || i.color))];
/** The liner colour a shell colour is drawn over in a version: the user's, else the material's, else none (zipped up). */
export const linerFor = (images: Img[], v: DraftVersion, shell: string): string => v.liners?.[shell] ?? linersSeen(images, v.inner, shell)[0] ?? '';

/**
 * A photo of the liner alone, for the thumbnail on a SKU card with a liner: in the liner's colour (the
 * one this shell is shown over), a real photo before a page of the detail (10-22: 6609's 「内胆 2 款可选」 page, both liners on it).
 */
export function linerAlone(images: Img[], inner: string, color?: string): string | null {
  // A white image of it (tidied or drawn on the plan, 10-22) before a photo with someone wearing it.
  const rank = (i: Img) => ((i.innerColor || i.color) === color ? 4 : 0) + (i.kind === '模特实拍' || i.kind === '静物' || i.kind === '3D渲染' ? 2 : 0) + (i.kind === '静物' ? 1 : 0);
  return images.filter(i => !i.same && i.role === '内胆' && i.inner === inner).sort((a, b) => rank(b) - rank(a))[0]?.id ?? null;
}
/** The liner colour a shell is shown over in this item's photo (or the one it is drawn from). */
export const linerColorOf = (images: Img[], label: string | null | undefined) => images.find(i => i.id === label)?.innerColor || undefined;

/**
 * The liner a shell colour wears on the cast and the main images (10-25: every main image copied the
 * cast's liner, so 6609's 白色, 白+咖啡 and 翠绿 covers all wore black down; its SKU images, each from
 * its own photo, were right). Among the ticked versions over a liner in this colour: the user's pick
 * (`wear.main`), else the one the material shows this shell over most (6609: 白色 over 浅灰 fleece,
 * 白+咖啡 over 咖啡色 fleece, 安哥拉红 over black down). Its liner colour and the image to draw it
 * from are the SKU image's (linerFor, itemReference); colour '' is zipped up. Null: no version over a
 * liner in this colour.
 */
export function mainLiner(images: Img[], d: Pick<Draft, 'versions' | 'wear'>, shell: string): { version: DraftVersion; color: string; ref: string | null } | null {
  const lined = (d.versions ?? []).filter(v => v.on && v.kind === '外壳加内胆' && v.inner && v.colors.includes(shell));
  const seen = (v: DraftVersion) => images.filter(i => i.role === '主体' && i.color === shell && i.inner === v.inner).length;
  const version = lined.find(v => v.key === d.wear?.main) ?? [...lined].sort((a, b) => seen(b) - seen(a))[0];
  if (!version) return null;
  const color = linerFor(images, version, shell);
  return { version, color, ref: color ? itemReference(images, { key: '', color: '', name: shell, version, label: '' }, color) : null };
}
/** The main images dress each colour in its own liner (mainLiner) once the plan has a version over one. */
export const linerByColor = (d: Pick<Draft, 'versions' | 'wear'>) => d.wear?.type === '内胆' && (d.versions ?? []).some(v => v.on && v.kind === '外壳加内胆' && v.inner && v.colors.length > 0);
