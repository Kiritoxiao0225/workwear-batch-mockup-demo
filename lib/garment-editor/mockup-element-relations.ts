import type {
  CanvasElement,
  CustomizationState,
  DecorationRelativeTransform,
  MockupGarmentGeometry,
  MockupPlacement,
  ProductFace,
} from './mockup-types';

const PRODUCT_FACES = new Set<ProductFace>(['front', 'back']);
const PLACEMENTS = new Set<MockupPlacement>([
  'custom',
  'left_chest',
  'right_chest',
  'front_center',
  'upper_back',
  'back_center',
]);

const FRONT_PLACEMENTS = new Set<MockupPlacement>([
  'custom',
  'left_chest',
  'right_chest',
  'front_center',
]);
const BACK_PLACEMENTS = new Set<MockupPlacement>([
  'custom',
  'upper_back',
  'back_center',
]);

export const MOCKUP_PLACEMENT_LABELS: Record<MockupPlacement, string> = {
  custom: '自定义位置',
  left_chest: '左前胸',
  right_chest: '右前胸',
  front_center: '前胸居中',
  upper_back: '后背上方',
  back_center: '后背居中',
};

export const MOCKUP_PLACEMENT_ANCHORS: Record<MockupPlacement, { x: number; y: number }> = {
  custom: { x: 0, y: 0 },
  // Apparel naming follows the wearer: left chest is viewer-right.
  left_chest: { x: 0.2, y: -0.2 },
  right_chest: { x: -0.2, y: -0.2 },
  front_center: { x: 0, y: -0.12 },
  upper_back: { x: 0, y: -0.2 },
  back_center: { x: 0, y: 0 },
};

const CHEST_BODY_OFFSET_RATIO = 0.36;

function roundedAnchor(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function mockupPlacementAnchor(
  product: CanvasElement | null | undefined,
  placement: MockupPlacement
) {
  const fallback = MOCKUP_PLACEMENT_ANCHORS[placement];
  const geometry = product?.type === 'product'
    ? product.garmentGeometry
    : undefined;
  if (!geometry || (placement !== 'left_chest' && placement !== 'right_chest')) {
    return fallback;
  }
  const direction = placement === 'left_chest' ? 1 : -1;
  return {
    x: roundedAnchor(
      geometry.bodyCenterX +
        direction * geometry.bodyWidth * CHEST_BODY_OFFSET_RATIO -
        0.5
    ),
    y: roundedAnchor(geometry.chestY - 0.5),
  };
}

export class MockupElementRelationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockupElementRelationValidationError';
  }
}

export function isDecorationElement(
  element: CanvasElement
): element is CanvasElement & { type: 'logo' | 'text' } {
  return element.type === 'logo' || element.type === 'text';
}

export function explicitDecorationCaptureMatch(
  element: CanvasElement,
  productElementId: string
): boolean | null {
  if (!isDecorationElement(element)) return false;
  if (!Object.prototype.hasOwnProperty.call(element, 'placedOnProductId')) {
    return null;
  }
  return element.placedOnProductId === productElementId;
}

export function productFace(element: CanvasElement): ProductFace {
  return element.face === 'back' ? 'back' : 'front';
}

export function placementsForProductFace(face: ProductFace): MockupPlacement[] {
  return face === 'back'
    ? ['upper_back', 'back_center', 'custom']
    : ['left_chest', 'right_chest', 'front_center', 'custom'];
}

export function placementMatchesProductFace(
  placement: MockupPlacement,
  face: ProductFace
) {
  return (face === 'back' ? BACK_PLACEMENTS : FRONT_PLACEMENTS).has(placement);
}

export function defaultPlacementForDecoration(
  type: 'logo' | 'text',
  face: ProductFace
): MockupPlacement {
  if (type === 'text') return 'custom';
  return face === 'back' ? 'upper_back' : 'left_chest';
}

export function defaultDecorationProductId(
  elements: CanvasElement[],
  selectedElementId: string | null
) {
  const products = elements.filter(element => element.type === 'product');
  const selectedProduct = products.find(product => product.id === selectedElementId);
  if (selectedProduct) return selectedProduct.id;
  return products.length === 1 ? products[0].id : null;
}

export function copyMockupElement(
  elements: CanvasElement[],
  sourceElementId: string,
  newElementId: string,
  offset = 20
): CanvasElement[] {
  const source = elements.find(element => element.id === sourceElementId);
  if (!source) return elements;
  if (elements.some(element => element.id === newElementId)) {
    throw new MockupElementRelationValidationError(
      `复制元素 ID 重复：${newElementId}`
    );
  }

  const copy: CanvasElement = {
    ...source,
    id: newElementId,
    transform: source.transform
      ? {
          ...source.transform,
          left: source.transform.left + offset,
          top: source.transform.top + offset,
        }
      : undefined,
  };

  if (copy.type === 'product') {
    delete copy.backOfElementId;
  } else {
    copy.placement = 'custom';
    // The absolute offset is authoritative until Fabric recomputes the copied
    // element's product-local position on its first render.
    delete copy.relativeTransform;
  }

  return [...elements, copy];
}

export function assignDecorationToProduct(
  elements: CanvasElement[],
  decorationElementId: string,
  productElementId: string | null
) {
  const decoration = elements.find(element => element.id === decorationElementId);
  if (!decoration || !isDecorationElement(decoration)) return elements;

  if (productElementId === null) {
    return elements.map(element =>
      element.id === decorationElementId
        ? {
            ...element,
            placedOnProductId: null,
            placement: 'custom' as const,
            relativeTransform: undefined,
          }
        : element
    );
  }

  const product = elements.find(
    element => element.id === productElementId && element.type === 'product'
  );
  if (!product) {
    throw new MockupElementRelationValidationError(
      `定制元素 ${decorationElementId} 不能归属到不存在的产品 ${productElementId}`
    );
  }
  const face = productFace(product);
  const currentPlacement = decoration.placement ?? 'custom';
  const placement = placementMatchesProductFace(currentPlacement, face)
    ? currentPlacement
    : defaultPlacementForDecoration(decoration.type, face);

  return elements.map(element =>
    element.id === decorationElementId
      ? {
          ...element,
          placedOnProductId: productElementId,
          placement,
          // Re-render the decoration from its product-local coordinates. When
          // no relative transform exists, Editor uses the placement preset.
          transform: undefined,
        }
      : element
  );
}

export function setDecorationPlacement(
  elements: CanvasElement[],
  decorationElementId: string,
  placement: MockupPlacement
) {
  const decoration = elements.find(element => element.id === decorationElementId);
  if (!decoration || !isDecorationElement(decoration)) return elements;
  if (!PLACEMENTS.has(placement)) {
    throw new MockupElementRelationValidationError(
      `定制位置不合法：${String(placement)}`
    );
  }
  if (!decoration.placedOnProductId && placement !== 'custom') {
    throw new MockupElementRelationValidationError('请先选择定制内容所属产品');
  }

  const owner = decoration.placedOnProductId
    ? elements.find(
        element =>
          element.id === decoration.placedOnProductId && element.type === 'product'
      )
    : null;
  if (owner && !placementMatchesProductFace(placement, productFace(owner))) {
    throw new MockupElementRelationValidationError(
      `${MOCKUP_PLACEMENT_LABELS[placement]} 不适用于${productFace(owner) === 'back' ? '背面' : '正面'}产品`
    );
  }

  const anchor = mockupPlacementAnchor(owner, placement);
  return elements.map(element => {
    if (element.id !== decorationElementId) return element;
    const relativeTransform = element.relativeTransform
      ? { ...element.relativeTransform, x: anchor.x, y: anchor.y }
      : undefined;
    return {
      ...element,
      placement,
      relativeTransform,
      transform: placement === 'custom' ? element.transform : undefined,
    };
  });
}

function finiteGarmentGeometry(
  value: MockupGarmentGeometry | undefined
): value is MockupGarmentGeometry {
  if (!value || value.version !== 2) return false;
  const { garmentBounds } = value;
  if (
    value.confidence !== 'high' &&
    value.confidence !== 'medium'
  ) {
    return false;
  }
  if (
    ![
      garmentBounds.x,
      garmentBounds.y,
      garmentBounds.width,
      garmentBounds.height,
      value.bodyCenterX,
      value.bodyWidth,
      value.chestY,
    ].every(Number.isFinite)
  ) {
    return false;
  }
  const epsilon = 0.000001;
  return (
    garmentBounds.x >= 0 &&
    garmentBounds.y >= 0 &&
    garmentBounds.width > 0 &&
    garmentBounds.height > 0 &&
    garmentBounds.x + garmentBounds.width <= 1 + epsilon &&
    garmentBounds.y + garmentBounds.height <= 1 + epsilon &&
    value.bodyCenterX >= garmentBounds.x - epsilon &&
    value.bodyCenterX <= garmentBounds.x + garmentBounds.width + epsilon &&
    value.bodyWidth > 0 &&
    value.bodyWidth <= garmentBounds.width + epsilon &&
    value.chestY >= garmentBounds.y - epsilon &&
    value.chestY <= garmentBounds.y + garmentBounds.height + epsilon
  );
}

export function setMockupProductGarmentGeometry(
  elements: CanvasElement[],
  productElementId: string,
  garmentGeometry: MockupGarmentGeometry
) {
  if (!finiteGarmentGeometry(garmentGeometry)) {
    throw new MockupElementRelationValidationError(
      `产品 ${productElementId} 的 garmentGeometry 不合法`
    );
  }
  const product = elements.find(
    element => element.id === productElementId && element.type === 'product'
  );
  if (!product) return elements;
  const updatedProduct = { ...product, garmentGeometry };

  return elements.map(element => {
    if (element.id === productElementId) return updatedProduct;
    if (
      !isDecorationElement(element) ||
      element.placedOnProductId !== productElementId ||
      (element.placement !== 'left_chest' &&
        element.placement !== 'right_chest')
    ) {
      return element;
    }
    if (!element.relativeTransform) return element;
    const anchor = mockupPlacementAnchor(updatedProduct, element.placement!);
    return {
      ...element,
      relativeTransform: {
        ...element.relativeTransform,
        x: anchor.x,
        y: anchor.y,
      },
    };
  });
}

export function setMockupProductFace(
  elements: CanvasElement[],
  productElementId: string,
  face: ProductFace
) {
  if (!PRODUCT_FACES.has(face)) {
    throw new MockupElementRelationValidationError(`产品面别不合法：${String(face)}`);
  }
  const target = elements.find(
    element => element.id === productElementId && element.type === 'product'
  );
  if (!target) return elements;

  return elements.map(element => {
    if (element.id === productElementId) {
      const next = { ...element, face };
      if (face === 'front') delete next.backOfElementId;
      return next;
    }
    if (element.type === 'product' && element.backOfElementId === productElementId) {
      const next = { ...element };
      delete next.backOfElementId;
      return next;
    }
    if (
      isDecorationElement(element) &&
      element.placedOnProductId === productElementId &&
      element.placement &&
      !placementMatchesProductFace(element.placement, face)
    ) {
      return { ...element, placement: 'custom' as const };
    }
    return element;
  });
}

export function removeMockupElementRelationships(
  state: CustomizationState,
  elementId: string
): CustomizationState {
  const removed = state.elements.find(element => element.id === elementId);
  const remainingElements = state.elements
    .filter(element => element.id !== elementId)
    .map(element => {
      if (removed?.type === 'product' && isDecorationElement(element)) {
        if (element.placedOnProductId === elementId) {
          return {
            ...element,
            placedOnProductId: null,
            placement: 'custom' as const,
            relativeTransform: undefined,
          };
        }
      }
      if (element.type === 'product' && element.backOfElementId === elementId) {
        const next = { ...element };
        delete next.backOfElementId;
        return next;
      }
      return element;
    });
  return { ...state, elements: remainingElements };
}

function finiteRelativeTransform(
  value: DecorationRelativeTransform | undefined
): value is DecorationRelativeTransform {
  return !!value && [value.x, value.y, value.scaleX, value.scaleY, value.angle]
    .every(Number.isFinite);
}

export function normalizeMockupElementRelations(
  elements: CanvasElement[]
): CanvasElement[] {
  const products = new Map(
    elements
      .filter(element => element.type === 'product')
      .map(element => [element.id, element] as const)
  );

  return elements.map(element => {
    if (element.type === 'product') {
      const next: CanvasElement = { ...element };
      if (
        element.face !== undefined &&
        !PRODUCT_FACES.has(element.face as ProductFace)
      ) {
        next.face = 'front';
      }
      const front = next.backOfElementId
        ? products.get(next.backOfElementId)
        : null;
      if (
        next.face !== 'back' ||
        !front ||
        productFace(front) !== 'front'
      ) {
        delete next.backOfElementId;
      }
      if (!finiteGarmentGeometry(next.garmentGeometry)) {
        delete next.garmentGeometry;
      }
      return next;
    }

    if (!isDecorationElement(element)) return element;
    const normalizedDecoration: CanvasElement = { ...element };
    delete normalizedDecoration.garmentGeometry;
    const owner = element.placedOnProductId
      ? products.get(element.placedOnProductId)
      : null;
    if (!owner) {
      return {
        ...normalizedDecoration,
        placedOnProductId: null,
        placement: 'custom',
        relativeTransform: undefined,
      };
    }

    const face = productFace(owner);
    const placement =
      element.placement &&
      PLACEMENTS.has(element.placement) &&
      placementMatchesProductFace(element.placement, face)
        ? element.placement
        : 'custom';
    return {
      ...normalizedDecoration,
      placedOnProductId: owner.id,
      placement,
      relativeTransform: finiteRelativeTransform(element.relativeTransform)
        ? element.relativeTransform
        : undefined,
    };
  });
}

export function normalizeMockupCustomizationState(
  state: CustomizationState
): CustomizationState {
  return { ...state, elements: normalizeMockupElementRelations(state.elements) };
}

export function assertValidMockupElementRelations(elements: CanvasElement[]) {
  const ids = new Set<string>();
  elements.forEach((element, index) => {
    if (!element.id || ids.has(element.id)) {
      throw new MockupElementRelationValidationError(
        `elements[${index}].id 为空或重复：${element.id}`
      );
    }
    ids.add(element.id);
  });

  const products = new Map(
    elements
      .filter(element => element.type === 'product')
      .map(element => [element.id, element] as const)
  );

  elements.forEach((element, index) => {
    if (element.type === 'product') {
      if (element.face !== undefined && !PRODUCT_FACES.has(element.face)) {
        throw new MockupElementRelationValidationError(
          `elements[${index}].face 不合法：${String(element.face)}`
        );
      }
      if (element.backOfElementId) {
        const front = products.get(element.backOfElementId);
        if (
          productFace(element) !== 'back' ||
          !front ||
          productFace(front) !== 'front'
        ) {
          throw new MockupElementRelationValidationError(
            `背面产品 ${element.id} 的 backOfElementId 不合法：${element.backOfElementId}`
          );
        }
      }
      if (
        element.garmentGeometry !== undefined &&
        !finiteGarmentGeometry(element.garmentGeometry)
      ) {
        throw new MockupElementRelationValidationError(
          `elements[${index}].garmentGeometry 不合法`
        );
      }
      return;
    }

    if (!isDecorationElement(element)) return;
    if (element.garmentGeometry !== undefined) {
      throw new MockupElementRelationValidationError(
        `elements[${index}].garmentGeometry 仅允许产品元素保存`
      );
    }
    if (element.placement !== undefined && !PLACEMENTS.has(element.placement)) {
      throw new MockupElementRelationValidationError(
        `elements[${index}].placement 不合法：${String(element.placement)}`
      );
    }
    if (!element.placedOnProductId) {
      if (element.relativeTransform !== undefined) {
        throw new MockupElementRelationValidationError(
          `未归属定制元素 ${element.id} 不能保存 relativeTransform`
        );
      }
      return;
    }
    const owner = products.get(element.placedOnProductId);
    if (!owner) {
      throw new MockupElementRelationValidationError(
        `定制元素 ${element.id} 引用了不存在的产品 ${element.placedOnProductId}`
      );
    }
    if (
      element.placement &&
      !placementMatchesProductFace(element.placement, productFace(owner))
    ) {
      throw new MockupElementRelationValidationError(
        `定制元素 ${element.id} 的位置 ${element.placement} 与产品面别不匹配`
      );
    }
    if (
      element.relativeTransform !== undefined &&
      (!finiteRelativeTransform(element.relativeTransform) ||
        element.relativeTransform.scaleX <= 0 ||
        element.relativeTransform.scaleY <= 0)
    ) {
      throw new MockupElementRelationValidationError(
        `定制元素 ${element.id} 的 relativeTransform 不合法`
      );
    }
  });
}
