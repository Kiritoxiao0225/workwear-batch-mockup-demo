import { z } from 'zod';
import { emptyStandard, type Box, type CatalogDetail, type CatalogStyle } from '@/lib/catalog';
import { catalogReferenceType, estimatedSopStandard, placementPreviewSchema, structureRecognitionSchema, suggestedPlacement } from '@/lib/catalog-placement-suggestions';
import { plausibleTorso } from '@/lib/sop-placement';
import { garmentSilhouette } from './catalog-alignment';
import { torsoWidthRatio } from './catalog-body-geometry';
import { readCatalogFile } from './catalog-files';
import { measureSilhouette, type SilhouetteMeasure, type StructurePoints } from './catalog-structure-estimate';
import { faceStructurePoints } from './catalog-structure-recognition';
import { sharedStyleStandards, type SharedStandard } from './catalog-shared-standard';

// Loads another color of the style (detail and thumbnail bytes) within the caller's tenant.
type StyleSharing = { style: CatalogStyle; load: (id: string) => Promise<{ detail: CatalogDetail; bytes: Buffer }> };

const landmarkName = (key: string, label: string, face: 'front' | 'back') => key === 'neckCenter' ? (face === 'front' ? '前领口中心' : '后领中心') : label;
type FaceGeometry = { frame: Box | null; measure: SilhouetteMeasure | null; bodyWidthRatio: number | null };
// Only immutable image geometry is cached; standards and revisions always come from the database.
// Each server instance keeps at most 256 small results, never original image buffers.
const imageGeometry = new Map<string, Promise<FaceGeometry[]>>();
async function previewGeometry(detail: CatalogDetail, fileId: string) {
  const key = JSON.stringify([detail.assetVersionId, fileId, detail.views.map(view => view.crop)]);
  const existing = imageGeometry.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const { bytes } = await readCatalogFile(fileId);
    return Promise.all(detail.views.map(async view => {
      const measure = await measureSilhouette(bytes, view.crop);
      // Same width evidence order as the composite.
      return { frame: (await garmentSilhouette(bytes, view.crop))?.bounds ?? null, measure, bodyWidthRatio: await torsoWidthRatio(bytes, view.crop) ?? measure?.torsoAtArmpit ?? null };
    }));
  })();
  imageGeometry.set(key, pending);
  if (imageGeometry.size > 256) imageGeometry.delete(imageGeometry.keys().next().value!);
  try { return await pending; }
  catch (error) { if (imageGeometry.get(key) === pending) imageGeometry.delete(key); throw error; }
}

export async function catalogPlacementPreview(detail: CatalogDetail, sharing?: StyleSharing) {
  const reference = catalogReferenceType(detail.namespace, detail.styleCode);
  // Thumbnail is tied to this asset version and preserves the original alpha layout.
  const fileId = z.uuid().parse(detail.thumbnailUrl.split('/').at(-1));
  // Saved faces still need the torso width so the calibration view derives positions like the composite.
  // Opening fully saved faces must not fail on the image: the view then falls back to the armpit width.
  const geometry = await previewGeometry(detail, fileId).catch(error => {
    if (detail.views.every(view => view.latest)) return detail.views.map((): FaceGeometry => ({ frame: null, measure: null, bodyWidthRatio: null }));
    throw error;
  });
  // Other colors' confirmations change independently of this image, so they are never cached here.
  let shared: Partial<Record<'front' | 'back', SharedStandard>> = {};
  if (sharing && detail.views.some(v => !v.latest)) shared = await sharedStyleStandards(detail, (await readCatalogFile(fileId)).bytes, sharing.style, sharing.load);
  // Only faces that get a suggestion ask the model; it is cached per image and read lazily.
  let bytes: Promise<Buffer> | null = null;
  const image = { key: fileId, load: () => bytes ??= readCatalogFile(fileId).then(file => file.bytes) };
  const recognition = await Promise.all(detail.views.map((view, index) => {
    const measure = geometry[index].measure;
    return measure && !view.latest && !shared[view.face] ? faceStructurePoints(image, view.crop, view.face, reference.structure, measure.points, measure.center) : { points: measure?.points ?? {}, error: null };
  }));
  const faces = detail.views.map((view, index) => {
    const { frame, measure, bodyWidthRatio: measured } = geometry[index], { points, error: recognitionError } = recognition[index];
    const borrowed = !view.latest && shared[view.face];
    const standard = view.latest?.specification ?? (borrowed || null)?.specification, outline = standard?.garmentFrame ?? frame;
    const bodyWidthRatio = outline ? plausibleTorso(standard?.structureType ?? reference.structure, measured, outline.width) : measured;
    if (borrowed) return { viewId: view.id, frame: borrowed.specification.garmentFrame, specification: borrowed.specification, bodyWidthRatio,
      basis: `沿用同款「${borrowed.colorName}」已确认的结构点（轮廓一致），效果图也按此放置。如本色需要不同位置，调整后保存为本色标准。` };
    if (view.latest) return { viewId: view.id, frame: view.latest.specification.garmentFrame, specification: view.latest.specification, basis: '已保存的位置标记', bodyWidthRatio };
    const pixel = frame && { width: frame.width * view.crop.width * detail.width, height: frame.height * view.crop.height * detail.height };
    const estimated = frame && measure && pixel && reference.structure !== 'unknown' ? estimatedSopStandard(reference.structure, view.face, frame, { ...measure, points }, pixel, bodyWidthRatio && bodyWidthRatio * view.crop.width * detail.width, reference.longSleeve) : null;
    const recognized = estimated ? estimated.landmarks.filter(l => points[l.key as keyof StructurePoints]).map(l => l.key) : [];
    const missing = estimated ? estimated.landmarks.filter(l => l.key !== 'hemCenter' && !recognized.includes(l.key)).map(l => landmarkName(l.key, l.label, view.face)) : [];
    return { viewId: view.id, frame, bodyWidthRatio, recognized,
      specification: estimated ?? (frame ? suggestedPlacement(reference.structure, view.face, frame, reference.longSleeve) : { ...emptyStandard(), structureType: reference.structure }),
      basis: !frame ? '照片含人物或背景，未检测到可靠衣服轮廓。请先框选衣服布面、调整衣服边界，再生成参考标记。' : reference.structure === 'unknown' ? '衣服轮廓已对齐，请选择结构类型以显示建议标记。'
        : estimated ? `结构点从照片识别：肩点、腋点按衣服轮廓，领口中心${recognized.includes('button2') ? '和第二、三粒扣' : ''}由看图模型识别；印花位置按效果图 SOP 由结构点计算。${missing.length ? `未能识别「${missing.join('、')}」${recognitionError ? `（${recognitionError}）` : ''}，暂按比例估算，请拖到实际位置。` : '请核对后确认。'}`
          : '参考标记已对齐当前图片轮廓；请核对领口、袖子、口袋与印花位置。',
    };
  });
  return placementPreviewSchema.parse({ assetVersionId: detail.assetVersionId, faces });
}

/** Recognizes every face's structure points again, saved or not, for a person to review before saving. */
export async function recognizeCatalogStructure(detail: CatalogDetail) {
  const reference = catalogReferenceType(detail.namespace, detail.styleCode);
  const fileId = z.uuid().parse(detail.thumbnailUrl.split('/').at(-1));
  const geometry = await previewGeometry(detail, fileId);
  let bytes: Promise<Buffer> | null = null;
  const image = { key: fileId, load: () => bytes ??= readCatalogFile(fileId).then(file => file.bytes) };
  const faces = await Promise.all(detail.views.map(async (view, index) => {
    const measure = geometry[index].measure, structure = view.latest?.specification.structureType ?? reference.structure;
    if (!measure) return { viewId: view.id, points: {}, error: '未检测到可靠衣服轮廓，请先框选衣服区域' };
    const { points, error } = await faceStructurePoints(image, view.crop, view.face, structure, measure.points, measure.center);
    return { viewId: view.id, points, error };
  }));
  return structureRecognitionSchema.parse({ assetVersionId: detail.assetVersionId, faces });
}
