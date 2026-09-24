import type {
  CanvasElement,
  CustomizationState,
  ElementType,
} from "./mockup-types";

export interface PendingElementImage {
  elementId: string;
  image: string;
  elementType: ElementType;
  expectedImage?: string;
}

export function appendElementForCurrentGeneration(
  state: CustomizationState,
  element: CanvasElement,
  operationGeneration: number,
  currentGeneration: number
): Partial<CustomizationState> {
  if (operationGeneration !== currentGeneration) return {};
  if (state.elements.some((candidate) => candidate.id === element.id)) return {};
  return { elements: [...state.elements, element] };
}

export function mergeElementImagesForCurrentGeneration(
  state: CustomizationState,
  pendingImages: readonly PendingElementImage[],
  operationGeneration: number,
  currentGeneration: number
): Partial<CustomizationState> {
  if (operationGeneration !== currentGeneration || pendingImages.length === 0) {
    return {};
  }

  const pendingById = new Map(
    pendingImages.map((pendingImage) => [pendingImage.elementId, pendingImage])
  );
  let changed = false;
  const elements = state.elements.map((element) => {
    const pendingImage = pendingById.get(element.id);
    if (!pendingImage || element.type !== pendingImage.elementType) return element;
    if (
      pendingImage.expectedImage !== undefined &&
      element.image !== pendingImage.expectedImage
    ) {
      return element;
    }
    if (element.image === pendingImage.image) return element;
    changed = true;
    return { ...element, image: pendingImage.image };
  });

  return changed ? { elements } : {};
}

export function appendGeneratedBackForCurrentGeneration(
  state: CustomizationState,
  sourceElementId: string,
  expectedSourceImage: string,
  backElement: CanvasElement,
  operationGeneration: number,
  currentGeneration: number
): Partial<CustomizationState> {
  if (operationGeneration !== currentGeneration) return {};
  const sourceElement = state.elements.find(
    (element) => element.id === sourceElementId
  );
  if (
    !sourceElement ||
    sourceElement.type !== "product" ||
    sourceElement.image !== expectedSourceImage
  ) {
    return {};
  }
  if (
    state.elements.some(
      (element) =>
        element.id === backElement.id ||
        (element.type === "product" &&
          element.backOfElementId === sourceElementId)
    )
  ) {
    return {};
  }
  return { elements: [...state.elements, backElement] };
}
