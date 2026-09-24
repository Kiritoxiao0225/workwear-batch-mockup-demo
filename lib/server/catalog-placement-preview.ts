import { z } from 'zod';
import { emptyStandard, type Box, type CatalogDetail, type CatalogStyle } from '@/lib/catalog';
import { catalogReferenceType, estimatedSopStandard, placementPreviewSchema, suggestedPlacement } from '@/lib/catalog-placement-suggestions';
import { plausibleTorso } from '@/lib/sop-placement';
import { garmentSilhouette } from './catalog-alignment';
import { torsoWidthRatio } from './catalog-body-geometry';
import { readCatalogFile } from './catalog-files';
import { measureSilhouette, type SilhouetteMeasure } from './catalog-structure-estimate';
import { sharedStyleStandards, type SharedStandard } from './catalog-shared-standard';

// Loads another color of the style (detail and thumbnail bytes) within the caller's tenant.
type StyleSharing = { style: CatalogStyle; load: (id: string) => Promise<{ detail: CatalogDetail; bytes: Buffer }> };

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
  const faces = detail.views.map((view, index) => {
    const { frame, measure, bodyWidthRatio: measured } = geometry[index];
    const borrowed = !view.latest && shared[view.face];
    const standard = view.latest?.specification ?? (borrowed || null)?.specification, outline = standard?.garmentFrame ?? frame;
    const bodyWidthRatio = outline ? plausibleTorso(standard?.structureType ?? reference.structure, measured, outline.width) : measured;
    if (borrowed) return { viewId: view.id, frame: borrowed.specification.garmentFrame, specification: borrowed.specification, bodyWidthRatio,
      basis: `沿用同款「${borrowed.colorName}」已确认的结构点（轮廓一致），效果图也按此放置。如本色需要不同位置，调整后保存为本色标准。` };
    if (view.latest) return { viewId: view.id, frame: view.latest.specification.garmentFrame, specification: view.latest.specification, basis: '已保存的位置标记', bodyWidthRatio };
    const pixel = frame && { width: frame.width * view.crop.width * detail.width, height: frame.height * view.crop.height * detail.height };
    const estimated = frame && measure && pixel && reference.structure !== 'unknown' ? estimatedSopStandard(reference.structure, view.face, frame, measure, pixel, bodyWidthRatio && bodyWidthRatio * view.crop.width * detail.width, reference.longSleeve) : null;
    return { viewId: view.id, frame, bodyWidthRatio,
      specification: estimated ?? (frame ? suggestedPlacement(reference.structure, view.face, frame, reference.longSleeve) : { ...emptyStandard(), structureType: reference.structure }),
      basis: !frame ? '照片含人物或背景，未检测到可靠衣服轮廓。请先框选衣服布面、调整衣服边界，再生成参考标记。' : reference.structure === 'unknown' ? '衣服轮廓已对齐，请选择结构类型以显示建议标记。'
        : estimated ? `结构点按衣服轮廓估算${measure?.armpitDetected ? '' : '（腋下线未能识别，偏差可能较大）'}；印花位置按效果图 SOP 由结构点计算。请拖正领口、肩点、腋下${reference.structure === 'polo' ? '，并可标出第二、三粒扣' : ''}后确认。`
          : '参考标记已对齐当前图片轮廓；请核对领口、袖子、口袋与印花位置。',
    };
  });
  return placementPreviewSchema.parse({ assetVersionId: detail.assetVersionId, faces });
}
