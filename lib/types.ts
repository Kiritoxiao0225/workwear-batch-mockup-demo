export const PLACEMENT_KEYS = [
  'frontCenter',
  'leftChest',
  'rightChest',
  'back',
  'leftSleeve',
  'rightSleeve',
] as const;

export type PlacementKey = (typeof PLACEMENT_KEYS)[number];

export type LogoPlacement = {
  catalogPosition?: 'upperBack' | 'backCenter';
  logoUrl: string;
  logoName: string;
  widthCm: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
};

export type MockupTask = {
  garment?: import('@/lib/production-garment').GarmentBinding;
  placementDefaults?: import('@/lib/catalog-placement-suggestions').CatalogPlacementPreview;
  id: string;
  productCode: string;
  placements: Partial<Record<PlacementKey, LogoPlacement>>;
  createdAt: string;
  updatedAt: string;
  exportedAt: string | null;
};

export type DemoState = {
  version: 1;
  tasks: MockupTask[];
  updatedAt: string;
};

export type Product = {
  code: string;
  name: string;
  color: string;
  originalUrl: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  garmentWidthCm: number;
};

export type TaskStatus = 'waitingLogo' | 'ready' | 'exported';
