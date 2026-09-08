import { z } from 'zod';
import { emptyStandard, type Box, type CatalogDetail } from '@/lib/catalog';
import { catalogReferenceType, placementPreviewSchema, suggestedPlacement } from '@/lib/catalog-placement-suggestions';
import { garmentSilhouette } from './catalog-alignment';
import { readCatalogFile } from './catalog-files';

// Only immutable image geometry is cached; standards and revisions always come from the database.
// Each server instance keeps at most 256 small frame results, never original image buffers.
const imageFrames = new Map<string, Promise<(Box | null)[]>>();
async function previewFrames(detail: CatalogDetail, fileId: string) {
  const key = JSON.stringify([detail.assetVersionId, fileId, detail.views.map(view => view.crop)]);
  const existing = imageFrames.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const { bytes } = await readCatalogFile(fileId);
    return Promise.all(detail.views.map(async view => (await garmentSilhouette(bytes, view.crop))?.bounds ?? null));
  })();
  imageFrames.set(key, pending);
  if (imageFrames.size > 256) imageFrames.delete(imageFrames.keys().next().value!);
  try { return await pending; }
  catch (error) { if (imageFrames.get(key) === pending) imageFrames.delete(key); throw error; }
}

export async function catalogPlacementPreview(detail: CatalogDetail) {
  const reference = catalogReferenceType(detail.namespace, detail.styleCode);
  // Thumbnail is tied to this asset version and preserves the original alpha layout.
  const fileId = z.uuid().parse(detail.thumbnailUrl.split('/').at(-1));
  const frames = detail.views.some(v => !v.latest) ? await previewFrames(detail, fileId) : null;
  const faces = detail.views.map((view, index) => {
    if (view.latest) return { viewId: view.id, frame: view.latest.specification.garmentFrame, specification: view.latest.specification, basis: '已保存的位置标记' };
    const frame = frames?.[index] ?? null;
    return { viewId: view.id, frame,
      specification: frame ? suggestedPlacement(reference.structure, view.face, frame, reference.longSleeve) : { ...emptyStandard(), structureType: reference.structure },
      basis: !frame ? '照片含人物或背景，未检测到可靠衣服轮廓。请先框选衣服布面、调整衣服边界，再生成参考标记。' : reference.structure === 'unknown' ? '衣服轮廓已对齐，请选择结构类型以显示建议标记。' : '参考标记已对齐当前图片轮廓；请核对领口、袖子、口袋与印花位置。',
    };
  });
  return placementPreviewSchema.parse({ assetVersionId: detail.assetVersionId, faces });
}
