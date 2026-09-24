import type {
  MockupGarmentGeometry,
  NormalizedMockupRegion,
} from '@/lib/garment-editor/mockup-types';
import {
  detectMockupGarmentGeometry,
  mapMockupGarmentGeometryToRegion,
  mockupGarmentDetectionSize,
  mockupGarmentRefinementRegion,
  mockupGarmentRefinementSize,
} from '@/lib/garment-editor/mockup-garment-geometry';

function imagePixels(
  image: HTMLImageElement,
  sourceRegion: NormalizedMockupRegion,
  destinationSize: { width: number; height: number }
) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const sourceLeft = Math.max(0, Math.floor(sourceRegion.x * sourceWidth));
  const sourceTop = Math.max(0, Math.floor(sourceRegion.y * sourceHeight));
  const sourceRight = Math.min(
    sourceWidth,
    Math.ceil((sourceRegion.x + sourceRegion.width) * sourceWidth)
  );
  const sourceBottom = Math.min(
    sourceHeight,
    Math.ceil((sourceRegion.y + sourceRegion.height) * sourceHeight)
  );
  const actualRegion = {
    x: sourceLeft / sourceWidth,
    y: sourceTop / sourceHeight,
    width: (sourceRight - sourceLeft) / sourceWidth,
    height: (sourceBottom - sourceTop) / sourceHeight,
  };
  const canvas = document.createElement('canvas');
  canvas.width = destinationSize.width;
  canvas.height = destinationSize.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法创建服装几何检测画布');
  context.drawImage(
    image,
    sourceLeft,
    sourceTop,
    sourceRight - sourceLeft,
    sourceBottom - sourceTop,
    0,
    0,
    destinationSize.width,
    destinationSize.height
  );
  return {
    pixels: context.getImageData(
      0,
      0,
      destinationSize.width,
      destinationSize.height
    ).data,
    actualRegion,
  };
}

export function detectProductGarmentGeometry(
  image: HTMLImageElement
): MockupGarmentGeometry | null {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error(`产品图尺寸无效：${sourceWidth}x${sourceHeight}`);
  }

  const fullRegion = { x: 0, y: 0, width: 1, height: 1 };
  const coarseSize = mockupGarmentDetectionSize(sourceWidth, sourceHeight);
  const coarseImage = imagePixels(image, fullRegion, coarseSize);
  const coarseGeometry = detectMockupGarmentGeometry({
    pixels: coarseImage.pixels,
    width: coarseSize.width,
    height: coarseSize.height,
  });
  if (!coarseGeometry || Math.max(sourceWidth, sourceHeight) <= 512) {
    return coarseGeometry;
  }

  const refinementRegion = mockupGarmentRefinementRegion(coarseGeometry);
  const refinementSize = mockupGarmentRefinementSize(
    sourceWidth,
    sourceHeight,
    refinementRegion
  );
  const refinementImage = imagePixels(
    image,
    refinementRegion,
    refinementSize
  );
  const refinedGeometry = detectMockupGarmentGeometry({
    pixels: refinementImage.pixels,
    width: refinementSize.width,
    height: refinementSize.height,
  });
  return refinedGeometry
    ? mapMockupGarmentGeometryToRegion(
        refinedGeometry,
        refinementImage.actualRegion
      )
    : coarseGeometry;
}
