import type * as fabric from 'fabric';

export const CANVAS_CORS_ERROR_MESSAGE = '图片跨域配置未完成，请在 OSS CORS 中允许当前域名的 GET/HEAD 请求后再保存或下载。';

interface CanvasTopContextState {
  contextTop?: unknown;
}

export interface ProductBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function getNewProductPlacement(
  existingProducts: ProductBounds[],
  newProductDisplayWidth: number,
  viewportCenter: { x: number; y: number }
) {
  if (existingProducts.length === 0) return viewportCenter;

  const rightEdge = Math.max(
    ...existingProducts.map(product => product.left + product.width)
  );
  const centers = existingProducts
    .map(product => product.top + product.height / 2)
    .sort((left, right) => left - right);
  const middle = Math.floor(centers.length / 2);
  const centerY =
    centers.length % 2 === 0
      ? (centers[middle - 1] + centers[middle]) / 2
      : centers[middle];
  const gap = Math.min(120, Math.max(72, newProductDisplayWidth * 0.12));

  return {
    x: rightEdge + gap + newProductDisplayWidth / 2,
    y: centerY,
  };
}

export function drawGuidelinesOnlyWithTopContext(canvas: CanvasTopContextState, drawGuidelines: () => void) {
  if (!canvas.contextTop) return;
  drawGuidelines();
}

export function isRemoteImageUrl(src: string) {
  return /^https?:\/\//i.test(src) || src.startsWith('//');
}

export function isCanvasSecurityError(err: unknown) {
  const error = err as { name?: string; message?: string };
  return error?.name === 'SecurityError' || /tainted|insecure|cross-origin/i.test(error?.message || '');
}

export function canvasToDataUrl(canvas: fabric.Canvas, options: Parameters<fabric.Canvas['toDataURL']>[0]) {
  try {
    return canvas.toDataURL(options);
  } catch (err) {
    if (isCanvasSecurityError(err)) {
      throw new Error(CANVAS_CORS_ERROR_MESSAGE);
    }
    throw err;
  }
}
