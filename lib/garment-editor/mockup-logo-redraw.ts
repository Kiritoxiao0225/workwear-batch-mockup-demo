import type {
  CanvasElement,
  CustomizationState,
  DecorationRelativeTransform,
  MockupPlacement,
  ObjectTransform,
  ProductFace,
} from './mockup-types';
import {
  mockupPlacementAnchor,
  placementMatchesProductFace,
  productFace,
} from './mockup-element-relations';


// Put a new logo on the canvas, or swap a logo's image while keeping its garment,
// position and visual size. Used when a studio artwork is placed or replaces a logo.
export type LogoRedrawApplyTarget =
  | {
      mode: 'replace';
      elementId: string;
      expectedImage: string;
      expectedPlacementState: {
        placedOnProductId: string | null | undefined;
        placement: MockupPlacement | undefined;
        transform: ObjectTransform | undefined;
        relativeTransform: DecorationRelativeTransform | undefined;
      };
      operationGeneration: number;
    }
  | {
      mode: 'add';
      elementId: string;
      placedOnProductId: string | null;
      placement: MockupPlacement;
      expectedOwnerImage?: string;
      expectedOwnerFace?: ProductFace;
      operationGeneration: number;
    };

interface ImageDimensions {
  width: number;
  height: number;
}

export class LogoRedrawApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogoRedrawApplyError';
  }
}

export class LogoRedrawTargetStaleError extends LogoRedrawApplyError {
  constructor(message: string) {
    super(message);
    this.name = 'LogoRedrawTargetStaleError';
  }
}


function validDimensions(
  dimensions: ImageDimensions | undefined,
  field: string
): ImageDimensions {
  if (
    !dimensions ||
    !Number.isFinite(dimensions.width) ||
    dimensions.width <= 0 ||
    !Number.isFinite(dimensions.height) ||
    dimensions.height <= 0
  ) {
    throw new LogoRedrawApplyError(`${field} 必须包含有效的图片宽高`);
  }
  return dimensions;
}

function preserveVisualFootprint<T extends { scaleX: number; scaleY: number }>(
  transform: T,
  sourceDimensions: ImageDimensions,
  generatedDimensions: ImageDimensions
): T {
  if (
    !Number.isFinite(transform.scaleX) ||
    transform.scaleX === 0 ||
    !Number.isFinite(transform.scaleY) ||
    transform.scaleY === 0
  ) {
    throw new LogoRedrawApplyError('目标 Logo 的缩放值必须是有效的非零数字');
  }
  const oldWidth = sourceDimensions.width * Math.abs(transform.scaleX);
  const oldHeight = sourceDimensions.height * Math.abs(transform.scaleY);
  const containedScale = Math.min(
    oldWidth / generatedDimensions.width,
    oldHeight / generatedDimensions.height
  );
  if (!Number.isFinite(containedScale) || containedScale <= 0) {
    throw new LogoRedrawApplyError('无法计算重绘 Logo 的安全缩放比例');
  }
  return {
    ...transform,
    scaleX: Math.sign(transform.scaleX) * containedScale,
    scaleY: Math.sign(transform.scaleY) * containedScale,
  } as T;
}

function ownedProductGeometry(
  state: CustomizationState,
  element: CanvasElement,
  ownerDimensions: ImageDimensions | undefined
) {
  const owner = element.placedOnProductId
    ? state.elements.find(
        candidate =>
          candidate.id === element.placedOnProductId &&
          candidate.type === 'product'
      )
    : null;
  const ownerTransform = owner?.transform;
  if (
    !owner ||
    !ownerTransform ||
    !finiteTransform(ownerTransform) ||
    ownerTransform.scaleX <= 0 ||
    ownerTransform.scaleY <= 0
  ) {
    throw new LogoRedrawTargetStaleError(
      'Logo 的归属产品已变化，当前结果不能安全替换'
    );
  }
  const ownerImageDimensions = validDimensions(
    ownerDimensions,
    'ownerDimensions'
  );
  return {
    owner,
    ownerTransform,
    ownerWidth: ownerImageDimensions.width * ownerTransform.scaleX,
    ownerHeight: ownerImageDimensions.height * ownerTransform.scaleY,
  };
}

function relativeTransformFromAbsolute(
  state: CustomizationState,
  element: CanvasElement,
  transform: ObjectTransform,
  ownerDimensions: ImageDimensions | undefined
) {
  if (!finiteTransform(transform) || transform.scaleX <= 0 || transform.scaleY <= 0) {
    throw new LogoRedrawTargetStaleError(
      '目标 Logo 的画布位置已变化，当前结果不能安全替换'
    );
  }
  const geometry = ownedProductGeometry(state, element, ownerDimensions);
  const angleRadians = geometry.ownerTransform.angle * Math.PI / 180;
  const deltaX = transform.left - geometry.ownerTransform.left;
  const deltaY = transform.top - geometry.ownerTransform.top;
  const relativeTransform: DecorationRelativeTransform = {
    x:
      (Math.cos(angleRadians) * deltaX + Math.sin(angleRadians) * deltaY) /
      geometry.ownerWidth,
    y:
      (-Math.sin(angleRadians) * deltaX + Math.cos(angleRadians) * deltaY) /
      geometry.ownerHeight,
    scaleX: transform.scaleX / geometry.ownerTransform.scaleX,
    scaleY: transform.scaleY / geometry.ownerTransform.scaleY,
    angle: transform.angle - geometry.ownerTransform.angle,
  };
  if (!finiteRelativeTransform(relativeTransform)) {
    throw new LogoRedrawTargetStaleError(
      '无法安全恢复目标 Logo 与归属产品的相对位置'
    );
  }
  return relativeTransform;
}

function replacementElement(
  state: CustomizationState,
  element: CanvasElement,
  generatedImage: string,
  generatedSourceImage: string,
  sourceDimensions: ImageDimensions | undefined,
  generatedDimensions: ImageDimensions | undefined,
  ownerDimensions: ImageDimensions | undefined,
  canvasDimensions: ImageDimensions | undefined
) {
  let transform = element.transform;
  let relativeTransform = element.relativeTransform;
  if (transform) {
    if (!finiteTransform(transform)) {
      throw new LogoRedrawTargetStaleError(
        '目标 Logo 的画布位置已变化，当前结果不能安全替换'
      );
    }
    if (relativeTransform && !finiteRelativeTransform(relativeTransform)) {
      throw new LogoRedrawTargetStaleError(
        '目标 Logo 的相对位置已变化，当前结果不能安全替换'
      );
    }
    const oldDimensions = validDimensions(sourceDimensions, 'sourceDimensions');
    const newDimensions = validDimensions(
      generatedDimensions,
      'generatedDimensions'
    );
    const nextTransform = preserveVisualFootprint(
      transform,
      oldDimensions,
      newDimensions
    );
    if (relativeTransform) {
      relativeTransform = {
        ...relativeTransform,
        scaleX:
          relativeTransform.scaleX * (nextTransform.scaleX / transform.scaleX),
        scaleY:
          relativeTransform.scaleY * (nextTransform.scaleY / transform.scaleY),
      };
    }
    transform = nextTransform;
  } else if (relativeTransform) {
    if (!finiteRelativeTransform(relativeTransform)) {
      throw new LogoRedrawTargetStaleError(
        '目标 Logo 的相对位置已变化，当前结果不能安全替换'
      );
    }
    const geometry = ownedProductGeometry(state, element, ownerDimensions);
    const oldDimensions = validDimensions(sourceDimensions, 'sourceDimensions');
    const newDimensions = validDimensions(
      generatedDimensions,
      'generatedDimensions'
    );
    relativeTransform = preserveVisualFootprint(
      relativeTransform,
      oldDimensions,
      newDimensions
    );
    const angleRadians = geometry.ownerTransform.angle * Math.PI / 180;
    const localX = relativeTransform.x * geometry.ownerWidth;
    const localY = relativeTransform.y * geometry.ownerHeight;
    transform = {
      left:
        geometry.ownerTransform.left +
        Math.cos(angleRadians) * localX -
        Math.sin(angleRadians) * localY,
      top:
        geometry.ownerTransform.top +
        Math.sin(angleRadians) * localX +
        Math.cos(angleRadians) * localY,
      scaleX: relativeTransform.scaleX * geometry.ownerTransform.scaleX,
      scaleY: relativeTransform.scaleY * geometry.ownerTransform.scaleY,
      angle: relativeTransform.angle + geometry.ownerTransform.angle,
    };
  } else {
    const oldDimensions = validDimensions(sourceDimensions, 'sourceDimensions');
    const newDimensions = validDimensions(
      generatedDimensions,
      'generatedDimensions'
    );
    const canvas = validDimensions(canvasDimensions, 'canvasDimensions');
    const targetHeight = Math.min(900, Math.max(420, canvas.height * 0.82));
    const sourceScale = targetHeight * 0.08 / oldDimensions.height;
    let initialTransform: ObjectTransform;
    if (element.placedOnProductId) {
      const geometry = ownedProductGeometry(state, element, ownerDimensions);
      const placement = element.placement ?? 'custom';
      if (!placementMatchesProductFace(placement, productFace(geometry.owner))) {
        throw new LogoRedrawTargetStaleError(
          '目标 Logo 的定制位置与归属产品面别不一致'
        );
      }
      const anchor = mockupPlacementAnchor(geometry.owner, placement);
      const angleRadians = geometry.ownerTransform.angle * Math.PI / 180;
      const localX = anchor.x * geometry.ownerWidth;
      const localY = anchor.y * geometry.ownerHeight;
      initialTransform = {
        left:
          geometry.ownerTransform.left +
          Math.cos(angleRadians) * localX -
          Math.sin(angleRadians) * localY,
        top:
          geometry.ownerTransform.top +
          Math.sin(angleRadians) * localX +
          Math.cos(angleRadians) * localY,
        scaleX: sourceScale,
        scaleY: sourceScale,
        angle: geometry.ownerTransform.angle,
      };
    } else {
      initialTransform = {
        left: canvas.width / 2,
        top: canvas.height / 2,
        scaleX: sourceScale,
        scaleY: sourceScale,
        angle: 0,
      };
    }
    transform = preserveVisualFootprint(
      initialTransform,
      oldDimensions,
      newDimensions
    );
  }

  if (element.placedOnProductId && !relativeTransform) {
    relativeTransform = relativeTransformFromAbsolute(
      state,
      element,
      transform,
      ownerDimensions
    );
  }

  const nextElement: CanvasElement = {
    ...element,
    image: generatedImage,
    originalImage: generatedSourceImage,
    transform,
    relativeTransform,
  };
  delete nextElement.imageRef;
  delete nextElement.originalImageRef;
  return nextElement;
}

function finiteTransform(transform: ObjectTransform | undefined) {
  return Boolean(
    transform &&
    Number.isFinite(transform.left) &&
    Number.isFinite(transform.top) &&
    Number.isFinite(transform.scaleX) &&
    transform.scaleX > 0 &&
    Number.isFinite(transform.scaleY) &&
    transform.scaleY > 0 &&
    Number.isFinite(transform.angle)
  );
}

function finiteRelativeTransform(
  transform: DecorationRelativeTransform | undefined
) {
  return Boolean(
    transform &&
    Number.isFinite(transform.x) &&
    Number.isFinite(transform.y) &&
    Number.isFinite(transform.scaleX) &&
    transform.scaleX > 0 &&
    Number.isFinite(transform.scaleY) &&
    transform.scaleY > 0 &&
    Number.isFinite(transform.angle)
  );
}

function sameObjectTransform(
  left: ObjectTransform | undefined,
  right: ObjectTransform | undefined
) {
  if (!left || !right) return left === right;
  return (
    Object.is(left.left, right.left) &&
    Object.is(left.top, right.top) &&
    Object.is(left.scaleX, right.scaleX) &&
    Object.is(left.scaleY, right.scaleY) &&
    Object.is(left.angle, right.angle)
  );
}

function sameRelativeTransform(
  left: DecorationRelativeTransform | undefined,
  right: DecorationRelativeTransform | undefined
) {
  if (!left || !right) return left === right;
  return (
    Object.is(left.x, right.x) &&
    Object.is(left.y, right.y) &&
    Object.is(left.scaleX, right.scaleX) &&
    Object.is(left.scaleY, right.scaleY) &&
    Object.is(left.angle, right.angle)
  );
}

function replacementPlacementIsLocked(
  element: CanvasElement,
  target: Extract<LogoRedrawApplyTarget, { mode: 'replace' }>
) {
  const expected = target.expectedPlacementState;
  return (
    Object.is(element.placedOnProductId, expected.placedOnProductId) &&
    Object.is(element.placement, expected.placement) &&
    sameObjectTransform(element.transform, expected.transform) &&
    sameRelativeTransform(
      element.relativeTransform,
      expected.relativeTransform
    )
  );
}

function newLogoPlacement(input: {
  state: CustomizationState;
  target: Extract<LogoRedrawApplyTarget, { mode: 'add' }>;
  generatedDimensions: ImageDimensions | undefined;
  ownerDimensions: ImageDimensions | undefined;
  canvasDimensions: ImageDimensions | undefined;
}) {
  const generatedDimensions = validDimensions(
    input.generatedDimensions,
    'generatedDimensions'
  );
  const ownerId = input.target.placedOnProductId;
  if (!ownerId) {
    const positionedProducts = input.state.elements.filter(
      element => element.type === 'product' && finiteTransform(element.transform)
    );
    const positionedElements = positionedProducts.length > 0
      ? positionedProducts
      : input.state.elements.filter(element => finiteTransform(element.transform));
    const center = positionedElements.length > 0
      ? positionedElements.reduce(
          (sum, element) => ({
            left: sum.left + element.transform!.left,
            top: sum.top + element.transform!.top,
          }),
          { left: 0, top: 0 }
        )
      : input.canvasDimensions
        ? {
            left: input.canvasDimensions.width / 2,
            top: input.canvasDimensions.height / 2,
          }
        : undefined;
    if (
      !center ||
      !Number.isFinite(center.left) ||
      !Number.isFinite(center.top)
    ) {
      throw new LogoRedrawApplyError(
        '画布中心尚未准备完成，请稍候后重试应用'
      );
    }
    const divisor = positionedElements.length || 1;
    const scale = Math.min(
      160 / generatedDimensions.width,
      64 / generatedDimensions.height
    );
    return {
      transform: {
        left: center.left / divisor,
        top: center.top / divisor,
        scaleX: scale,
        scaleY: scale,
        angle: 0,
      },
      relativeTransform: undefined,
    };
  }

  const owner = input.state.elements.find(
    element => element.id === ownerId && element.type === 'product'
  );
  if (!owner?.image) {
    throw new LogoRedrawTargetStaleError(
      '原定归属产品已被删除，当前结果不能安全添加'
    );
  }
  if (
    input.target.expectedOwnerImage &&
    owner.image !== input.target.expectedOwnerImage
  ) {
    throw new LogoRedrawTargetStaleError(
      '原定归属产品图片已发生变化，当前结果不能安全添加'
    );
  }
  if (
    input.target.expectedOwnerFace &&
    productFace(owner) !== input.target.expectedOwnerFace
  ) {
    throw new LogoRedrawTargetStaleError(
      '原定归属产品正背面已发生变化，当前结果不能安全添加'
    );
  }
  if (!placementMatchesProductFace(input.target.placement, productFace(owner))) {
    throw new LogoRedrawTargetStaleError(
      '原定 Logo 位置不适用于当前产品正背面，当前结果不能安全添加'
    );
  }
  if (!finiteTransform(owner.transform)) {
    throw new LogoRedrawApplyError(
      '归属产品位置尚未准备完成，请关闭流程后稍候重试'
    );
  }
  const ownerDimensions = validDimensions(
    input.ownerDimensions,
    'ownerDimensions'
  );
  const ownerTransform = owner.transform!;
  const ownerWidth = ownerDimensions.width * Math.abs(ownerTransform.scaleX);
  const ownerHeight = ownerDimensions.height * Math.abs(ownerTransform.scaleY);
  const scale = Math.min(
    ownerWidth * 0.22 / generatedDimensions.width,
    ownerHeight * 0.09 / generatedDimensions.height
  );
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new LogoRedrawApplyError('无法计算新 Logo 的安全初始尺寸');
  }
  const anchor = mockupPlacementAnchor(owner, input.target.placement);
  const angleRadians = ownerTransform.angle * Math.PI / 180;
  const localX = anchor.x * ownerWidth;
  const localY = anchor.y * ownerHeight;
  return {
    transform: {
      left:
        ownerTransform.left +
        Math.cos(angleRadians) * localX -
        Math.sin(angleRadians) * localY,
      top:
        ownerTransform.top +
        Math.sin(angleRadians) * localX +
        Math.cos(angleRadians) * localY,
      scaleX: scale,
      scaleY: scale,
      angle: ownerTransform.angle,
    },
    relativeTransform: {
      x: anchor.x,
      y: anchor.y,
      scaleX: scale / ownerTransform.scaleX,
      scaleY: scale / ownerTransform.scaleY,
      angle: 0,
    },
  };
}

export function applyLogoRedrawResult(input: {
  state: CustomizationState;
  target: LogoRedrawApplyTarget;
  currentGeneration: number;
  generatedImage: string;
  generatedSourceImage: string;
  sourceDimensions?: ImageDimensions;
  generatedDimensions?: ImageDimensions;
  ownerDimensions?: ImageDimensions;
  canvasDimensions?: ImageDimensions;
}): CustomizationState {
  const { state, target } = input;
  if (target.operationGeneration !== input.currentGeneration) {
    throw new LogoRedrawTargetStaleError(
      '画布已切换或恢复，当前生成结果不能安全应用'
    );
  }
  if (!input.generatedImage) {
    throw new LogoRedrawApplyError('生成结果图片不能为空');
  }
  if (!input.generatedSourceImage) {
    throw new LogoRedrawApplyError('生成原始候选图片不能为空');
  }

  if (target.mode === 'add') {
    if (state.elements.some((element) => element.id === target.elementId)) {
      throw new LogoRedrawTargetStaleError(`新 Logo ID 已存在：${target.elementId}`);
    }
    const placement = newLogoPlacement({
      state,
      target,
      generatedDimensions: input.generatedDimensions,
      ownerDimensions: input.ownerDimensions,
      canvasDimensions: input.canvasDimensions,
    });
    return {
      ...state,
      elements: [
        ...state.elements,
        {
          id: target.elementId,
          type: 'logo',
          image: input.generatedImage,
          originalImage: input.generatedSourceImage,
          placedOnProductId: target.placedOnProductId,
          placement: target.placement,
          transform: placement.transform,
          relativeTransform: placement.relativeTransform,
        },
      ],
    };
  }

  const targetIndex = state.elements.findIndex(
    (element) =>
      element.id === target.elementId &&
      element.type === 'logo' &&
      element.image === target.expectedImage
  );
  if (targetIndex < 0) {
    throw new LogoRedrawTargetStaleError(
      '目标 Logo 已被修改或删除，当前生成结果不能安全替换'
    );
  }
  if (!replacementPlacementIsLocked(state.elements[targetIndex], target)) {
    throw new LogoRedrawTargetStaleError(
      '目标 Logo 的位置、归属产品或定制位置已变化，当前结果不能安全替换'
    );
  }
  const elements = [...state.elements];
  elements[targetIndex] = replacementElement(
    state,
    elements[targetIndex],
    input.generatedImage,
    input.generatedSourceImage,
    input.sourceDimensions,
    input.generatedDimensions,
    input.ownerDimensions,
    input.canvasDimensions
  );
  return { ...state, elements };
}
