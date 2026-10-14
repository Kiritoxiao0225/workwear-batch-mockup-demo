/**
 * What the planning model looks at. Up to PLAN_FULL_SIZE_IMAGES images go one by one at 1024 px.
 * A larger product folder is still seen in full, just packed: near-identical shots are seen once,
 * detail-page slices are stitched back into tall pages, and photos go nine to a grid. Images whose
 * folder or name says they are colour images stay single so the colour is read at full detail.
 */
import sharp from 'sharp';
export const PLAN_FULL_SIZE_IMAGES = 40;
/** One uploaded image: its label (M1, M2, …), where it was in the folder, its measured shape and bytes. */
export type PlanSource = { id: string; name: string; folder: string; shape: '1:1' | '3:4' | '其他'; width: number; height: number; bytes: Buffer };
/** One picture sent to the model and the line that tells it which images it holds. */
export type PlanView = { text: string; dataUrl: string; ids: string[] };

const SKU_HINT = /sku|颜色|色卡|色号|款色/i;
const jpeg = async (image: ReturnType<typeof sharp>) => `data:image/jpeg;base64,${(await image.jpeg({ quality: 80 }).toBuffer()).toString('base64')}`;
const byPath = (a: PlanSource, b: PlanSource) => (a.folder + '/' + a.name).localeCompare(b.folder + '/' + b.name, 'zh-CN', { numeric: true });
const describe = (s: PlanSource) => `${s.id}（${s.folder ? s.folder + '/' : ''}${s.name}）`;

/**
 * 64-bit difference hash plus an 8×8 colour thumbnail, compared cell by cell. A re-saved JPEG shifts
 * a garment's colour by 4–8/255, as much as a genuinely close colour does (black vs charcoal), so
 * only pixel-identical copies (resized or converted, every cell within 2/255) count as the same
 * picture. Burst shots and re-saves stay separate; the grids keep them cheap. Merging two colours
 * of one shot would lose a SKU, which costs far more than a few extra grid cells.
 */
async function fingerprint(bytes: Buffer) {
  const grey = await sharp(bytes, { limitInputPixels: 60_000_000 }).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  const bits: boolean[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(grey[y * 9 + x] > grey[y * 9 + x + 1]);
  const cells = await sharp(bytes, { limitInputPixels: 60_000_000 }).rotate().removeAlpha().resize(8, 8, { fit: 'fill' }).raw().toBuffer();
  return { bits, cells };
}
type Print = Awaited<ReturnType<typeof fingerprint>>;
const nearlySame = (a: Print, b: Print) => a.bits.every((bit, i) => bit === b.bits[i]) && a.cells.every((v, i) => Math.abs(v - b.cells[i]) <= 2);

/**
 * Copies of one picture: each extra copy points at the one that is seen. Two kinds:
 * - the same file name (in any folder) with the same proportions and the same structure: a
 *   resized or re-saved copy, like a 小图 folder. A different colour of a garment never shares a
 *   file name, so a loose colour match is safe here; the largest copy is kept.
 * - any other pair that is pixel-identical (see nearlySame).
 */
export async function findDuplicates(sources: PlanSource[]) {
  const prints = new Map<string, Print>();
  for (const s of sources) prints.set(s.id, await fingerprint(s.bytes));
  const duplicates = new Map<string, string>(), ratio = (s: PlanSource) => s.width / s.height;
  const byName = new Map<string, PlanSource[]>();
  for (const s of sources) byName.set(s.name.toLowerCase(), [...(byName.get(s.name.toLowerCase()) ?? []), s]);
  for (const group of byName.values()) {
    const ordered = [...group].sort((a, b) => b.width * b.height - a.width * a.height || byPath(a, b));
    for (const [i, s] of ordered.entries()) {
      const keep = ordered.slice(0, i).find(k => !duplicates.has(k.id) && Math.abs(ratio(k) - ratio(s)) < 0.02
        && prints.get(k.id)!.bits.filter((bit, j) => bit !== prints.get(s.id)!.bits[j]).length <= 10);
      if (keep) duplicates.set(s.id, keep.id);
    }
  }
  // Of two pixel-identical pictures the shorter name is kept: copies tend to get suffixes (IMG_1 vs IMG_1_连拍).
  const ordered = sources.filter(s => !duplicates.has(s.id)).sort((a, b) => a.name.length - b.name.length || byPath(a, b)), kept: PlanSource[] = [];
  for (const source of ordered) {
    const twin = kept.find(k => k.shape === source.shape && Math.abs(ratio(k) - ratio(source)) < 0.02 && nearlySame(prints.get(k.id)!, prints.get(source.id)!));
    if (twin) duplicates.set(source.id, twin.id); else kept.push(source);
  }
  return { kept, duplicates };
}

const single = async (s: PlanSource, side: number): Promise<PlanView> => ({
  ids: [s.id], text: `【${s.id}】形状：${s.shape}（${s.width}×${s.height}），所在文件夹：${s.folder || '（根目录）'}，文件名：${s.name}`,
  dataUrl: await jpeg(sharp(s.bytes, { limitInputPixels: 60_000_000 }).rotate().resize(side, side, { fit: 'inside' })),
});

/**
 * A detail-page slice: Taobao detail pages are 750–790 px wide, or the piece is very tall. Camera
 * photos, their small copies and posters are photos even when they are not 1:1 or 3:4. A slice
 * taken for a photo (or the other way round) only changes how it is packed, never the result.
 */
const isSlice = (s: PlanSource) => s.shape === '其他' && ((s.width >= 700 && s.width <= 800) || s.height / s.width > 2.2);

/** Consecutive slices of one detail page (same folder, same width) stacked back into one tall image. */
async function strips(slices: PlanSource[], maxRun: number, maxRatio: number): Promise<PlanView[]> {
  const runs: PlanSource[][] = [];
  for (const s of [...slices].sort(byPath)) {
    const run = runs.at(-1), first = run?.[0];
    const height = run ? run.reduce((h, x) => h + x.height * (first!.width / x.width), 0) : 0;
    if (run && first && first.folder === s.folder && Math.abs(first.width - s.width) <= 2 && run.length < maxRun && height + s.height <= first.width * maxRatio) run.push(s); else runs.push([s]);
  }
  return Promise.all(runs.map(async run => {
    if (run.length === 1) return single(run[0], 1024);
    const width = Math.min(run[0].width, 800);
    const parts = await Promise.all(run.map(s => sharp(s.bytes, { limitInputPixels: 60_000_000 }).rotate().resize({ width }).toBuffer({ resolveWithObject: true })));
    const height = parts.reduce((h, p) => h + p.info.height, 0);
    let top = 0;
    const layers = parts.map(p => { const layer = { input: p.data, left: 0, top }; top += p.info.height; return layer; });
    return {
      ids: run.map(s => s.id),
      text: `【长图：同一个详情页的 ${run.length} 段切片按顺序拼在一起，从上到下依次是 ${run.map(describe).join('、')}】每一段都是一张独立素材，形状都是“其他”，所在文件夹：${run[0].folder || '（根目录）'}`,
      dataUrl: await jpeg(sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).composite(layers)),
    };
  }));
}

/** Photos are packed with others of a similar shape so the cells waste little room. */
type Group = { label: string; w: number; h: number };
const GROUPS: Record<string, Group> = {
  square: { label: '1:1', w: 1, h: 1 }, portrait: { label: '3:4', w: 0.88, h: 1.18 },
  tall: { label: '“其他”（竖图）', w: 0.8, h: 1.25 }, wide: { label: '“其他”（横图）', w: 1.25, h: 0.8 }, other: { label: '“其他”', w: 1, h: 1 },
};
const groupOf = (s: PlanSource) => s.shape === '1:1' ? 'square' : s.shape === '3:4' ? 'portrait' : s.height / s.width > 1.1 ? 'tall' : s.width / s.height > 1.1 ? 'wide' : 'other';

/** Photos of one group, `perSide`² to a sheet, in folder order. Cells shrink as sheets get denser. */
const CELL: Record<number, number> = { 2: 400, 3: 340, 4: 280, 5: 230, 6: 190, 7: 160 };
async function grids(photos: PlanSource[], group: Group, perSide: number): Promise<PlanView[]> {
  const c = CELL[perSide], cw = Math.round(c * group.w), ch = Math.round(c * group.h);
  const gap = 8, per = perSide * perSide, ordered = [...photos].sort(byPath), views: PlanView[] = [];
  for (let i = 0; i < ordered.length; i += per) {
    const page = ordered.slice(i, i + per), cols = Math.min(perSide, page.length), rows = Math.ceil(page.length / perSide);
    const cells = await Promise.all(page.map(s => sharp(s.bytes, { limitInputPixels: 60_000_000 }).rotate().resize(cw, ch, { fit: 'contain', background: '#ffffff' }).toBuffer()));
    const sheet = sharp({ create: { width: cols * cw + (cols - 1) * gap, height: rows * ch + (rows - 1) * gap, channels: 3, background: '#d0d0d0' } })
      .composite(cells.map((input, k) => ({ input, left: (k % perSide) * (cw + gap), top: Math.floor(k / perSide) * (ch + gap) })));
    views.push({
      ids: page.map(s => s.id),
      text: `【拼图：${page.length} 张素材排成 ${rows} 行 ${cols} 列（灰线隔开），从左到右、从上到下依次是 ${page.map(describe).join('、')}】每一格都是一张独立素材，形状都是 ${group.label}`,
      dataUrl: await jpeg(sheet),
    });
  }
  return views;
}

/** Packs photos into as few sheets as needed to fit `room`, using the least dense grid that fits. */
async function packed(photos: PlanSource[], room: number) {
  const byGroup = new Map<string, PlanSource[]>();
  for (const s of photos) byGroup.set(groupOf(s), [...(byGroup.get(groupOf(s)) ?? []), s]);
  const perSide = [2, 3, 4, 5, 6, 7].find(n => [...byGroup.values()].reduce((sum, list) => sum + Math.ceil(list.length / n / n), 0) <= room);
  if (!perSide) return null;
  return (await Promise.all([...byGroup].map(([key, list]) => grids(list, GROUPS[key], perSide)))).flat();
}

/** The provider takes at most 50 pictures per request; a little room is left. */
export const PLAN_MAX_PICTURES = 48;

/**
 * The pictures for one planning call, plus which images were left out as copies of which. The
 * price follows the pixels sent, not the number of pictures, so packing is only for the
 * 50-picture limit: colour images (by folder or file name) go one by one at 768 px, detail
 * slices are stitched back into tall pages, and the other photos (any shape) go one by one at
 * 384 px, packed into grids only as far as needed to fit. If that is still too many, slices are
 * stitched into longer pages and colour images are packed too.
 */
export async function planViews(sources: PlanSource[], fullSize = PLAN_FULL_SIZE_IMAGES) {
  const { kept, duplicates } = await findDuplicates(sources);
  if (kept.length <= fullSize) return { views: await Promise.all([...kept].sort(byPath).map(s => single(s, 1024))), duplicates };
  const colour = kept.filter(s => !isSlice(s) && SKU_HINT.test(s.folder + '/' + s.name)).sort(byPath);
  // Each step gives up a little clarity to fit: longer detail pages, then colour images in grids,
  // then everything in grids (a small photo taken for a slice only costs packing, never the call).
  const steps = [{ run: 4, ratio: 3.2, colours: 'single' }, { run: 8, ratio: 6.5, colours: 'single' }, { run: 8, ratio: 6.5, colours: 'packed' }, { run: 0, ratio: 0, colours: 'packed' }] as const;
  for (const step of steps) {
    const slices = step.run ? kept.filter(isSlice) : [];
    const photos = kept.filter(s => !slices.includes(s) && !colour.includes(s)).sort(byPath);
    const detail = step.run ? await strips(slices, step.run, step.ratio) : [];
    const colourViews = step.colours === 'single'
      ? (colour.length + detail.length <= PLAN_MAX_PICTURES - 6 ? await Promise.all(colour.map(s => single(s, 768))) : null)
      : await packed(colour, Math.max(1, Math.floor((PLAN_MAX_PICTURES - detail.length) / 3)));
    if (!colourViews) continue;
    const room = PLAN_MAX_PICTURES - detail.length - colourViews.length;
    if (room < 1 && photos.length) continue;
    const photoViews = photos.length <= room ? await Promise.all(photos.map(s => single(s, 384))) : await packed(photos, room);
    if (photoViews) return { views: [...colourViews, ...photoViews, ...detail], duplicates };
  }
  throw new Error(`素材太多（去掉重复后 ${kept.length} 张），一次分析放不下，请拆成几款再传`);
}

/**
 * What the colour list is read from before anything is sorted (10-14): every colour image, swatch,
 * detail page and main image (by folder or file name), and a few photos spread over every other
 * folder, so a colour shown only in photos is seen too.
 */
export function colourSources(sources: PlanSource[], perFolder = 4): PlanSource[] {
  const told = (s: PlanSource) => SKU_HINT.test(s.folder + '/' + s.name) || /详情|主图|首图/.test(s.folder + '/' + s.name);
  const rest = new Map<string, PlanSource[]>();
  for (const s of [...sources].sort(byPath)) if (!told(s)) rest.set(s.folder, [...(rest.get(s.folder) ?? []), s]);
  const spread = (list: PlanSource[]) => list.length <= perFolder ? list : Array.from({ length: perFolder }, (_, k) => list[Math.floor((k + 0.5) * list.length / perFolder)]);
  return [...sources.filter(told), ...[...rest.values()].flatMap(spread)];
}
