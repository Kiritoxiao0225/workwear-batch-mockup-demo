/**
 * What the planning model looks at. Up to PLAN_FULL_SIZE_IMAGES images go one by one at 1024 px.
 * A larger product folder is still seen in full, just packed: near-identical shots are seen once,
 * detail-page slices are stitched back into tall pages, and photos go nine to a grid. Images whose
 * folder or name says they are colour images stay single so the colour is read at full detail.
 */
import sharp from 'sharp';
import type { PlanImage } from './listing-plan';

export const PLAN_FULL_SIZE_IMAGES = 40;
export type PlanSource = Omit<PlanImage, 'dataUrl'> & { bytes: Buffer };
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

/** Identical copies: each extra copy points at the one that is seen. */
export async function findDuplicates(sources: PlanSource[]) {
  // Of two look-alikes the shorter name is kept: copies tend to get suffixes (IMG_1 vs IMG_1_连拍).
  const ordered = [...sources].sort((a, b) => a.name.length - b.name.length || byPath(a, b)), kept: { source: PlanSource; print: Print }[] = [], duplicates = new Map<string, string>();
  for (const source of ordered) {
    const print = await fingerprint(source.bytes);
    const twin = kept.find(k => k.source.shape === source.shape && Math.abs(k.source.width / k.source.height - source.width / source.height) < 0.02 && nearlySame(k.print, print));
    if (twin) duplicates.set(source.id, twin.source.id); else kept.push({ source, print });
  }
  return { kept: kept.map(k => k.source), duplicates };
}

const single = async (s: PlanSource, side: number): Promise<PlanView> => ({
  ids: [s.id], text: `【${s.id}】形状：${s.shape}（${s.width}×${s.height}），所在文件夹：${s.folder || '（根目录）'}，文件名：${s.name}`,
  dataUrl: await jpeg(sharp(s.bytes, { limitInputPixels: 60_000_000 }).rotate().resize(side, side, { fit: 'inside' })),
});

/** Consecutive slices of one detail page (same folder, same width) stacked back into one tall image. */
async function strips(slices: PlanSource[]): Promise<PlanView[]> {
  const runs: PlanSource[][] = [];
  for (const s of [...slices].sort(byPath)) {
    const run = runs.at(-1), first = run?.[0];
    const height = run ? run.reduce((h, x) => h + x.height * (first!.width / x.width), 0) : 0;
    if (run && first && first.folder === s.folder && Math.abs(first.width - s.width) <= 2 && run.length < 4 && height + s.height <= first.width * 3.2) run.push(s); else runs.push([s]);
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

/** Photos of one shape, `perSide`² to a sheet, in folder order. Cells shrink as sheets get denser. */
const CELL: Record<number, number> = { 2: 400, 3: 340, 4: 280, 5: 230, 6: 190, 7: 160 };
async function grids(photos: PlanSource[], shape: '1:1' | '3:4', perSide: number): Promise<PlanView[]> {
  const c = CELL[perSide], [cw, ch] = shape === '1:1' ? [c, c] : [Math.round(c * 0.88), Math.round(c * 1.18)];
  const gap = 8, per = perSide * perSide, ordered = [...photos].sort(byPath), views: PlanView[] = [];
  for (let i = 0; i < ordered.length; i += per) {
    const page = ordered.slice(i, i + per), cols = Math.min(perSide, page.length), rows = Math.ceil(page.length / perSide);
    const cells = await Promise.all(page.map(s => sharp(s.bytes, { limitInputPixels: 60_000_000 }).rotate().resize(cw, ch, { fit: 'contain', background: '#ffffff' }).toBuffer()));
    const sheet = sharp({ create: { width: cols * cw + (cols - 1) * gap, height: rows * ch + (rows - 1) * gap, channels: 3, background: '#d0d0d0' } })
      .composite(cells.map((input, k) => ({ input, left: (k % perSide) * (cw + gap), top: Math.floor(k / perSide) * (ch + gap) })));
    views.push({
      ids: page.map(s => s.id),
      text: `【拼图：${page.length} 张 ${shape} 素材排成 ${rows} 行 ${cols} 列（灰线隔开），从左到右、从上到下依次是 ${page.map(describe).join('、')}】每一格都是一张独立素材，形状都是 ${shape}`,
      dataUrl: await jpeg(sheet),
    });
  }
  return views;
}

/** The provider takes at most 50 pictures per request; a little room is left. */
export const PLAN_MAX_PICTURES = 48;

/**
 * The pictures for one planning call, plus which images were left out as copies of which. The
 * price follows the pixels sent, not the number of pictures, so packing is only for the
 * 50-picture limit: colour images (by folder or file name) go one by one at 768 px, detail
 * slices are stitched back into tall pages, and the other photos go one by one at 384 px, packed
 * into grids only as far as needed to fit.
 */
export async function planViews(sources: PlanSource[], fullSize = PLAN_FULL_SIZE_IMAGES) {
  const { kept, duplicates } = await findDuplicates(sources);
  if (kept.length <= fullSize) return { views: await Promise.all([...kept].sort(byPath).map(s => single(s, 1024))), duplicates };
  const colour = kept.filter(s => s.shape !== '其他' && SKU_HINT.test(s.folder + '/' + s.name)).sort(byPath);
  const photos = kept.filter(s => s.shape !== '其他' && !colour.includes(s)).sort(byPath);
  const detail = await strips(kept.filter(s => s.shape === '其他'));
  const room = PLAN_MAX_PICTURES - detail.length - colour.length;
  const tooMany = () => new Error(`素材太多（去掉重复后 ${kept.length} 张），一次分析放不下，请拆成几款再传`);
  if (room < 1) throw tooMany();
  let photoViews: PlanView[];
  if (photos.length <= room) photoViews = await Promise.all(photos.map(s => single(s, 384)));
  else {
    const square = photos.filter(s => s.shape === '1:1'), portrait = photos.filter(s => s.shape === '3:4');
    const perSide = [2, 3, 4, 5, 6, 7].find(n => Math.ceil(square.length / n / n) + Math.ceil(portrait.length / n / n) <= room);
    if (!perSide) throw tooMany();
    photoViews = [...await grids(square, '1:1', perSide), ...await grids(portrait, '3:4', perSide)];
  }
  return { views: [...await Promise.all(colour.map(s => single(s, 768))), ...photoViews, ...detail], duplicates };
}
