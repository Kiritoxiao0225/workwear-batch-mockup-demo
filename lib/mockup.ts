import type {
  DemoState,
  LogoPlacement,
  MockupTask,
  PlacementKey,
  Product,
  TaskStatus,
} from '@/lib/types';

export const PLACEMENT_LABELS: Record<PlacementKey, string> = {
  leftChest: '左胸',
  back: '后背',
  leftSleeve: '左袖',
  rightSleeve: '右袖',
};

export const PLACEMENT_DEFAULTS: Record<
  PlacementKey,
  Pick<LogoPlacement, 'widthCm' | 'offsetX' | 'offsetY' | 'rotation'>
> = {
  leftChest: { widthCm: 7, offsetX: 0, offsetY: 0, rotation: 0 },
  back: { widthCm: 28, offsetX: 0, offsetY: 0, rotation: 0 },
  leftSleeve: { widthCm: 8, offsetX: 0, offsetY: 0, rotation: 0 },
  rightSleeve: { widthCm: 8, offsetX: 0, offsetY: 0, rotation: 0 },
};

export const PLACEMENT_ANCHORS: Record<PlacementKey, { x: number; y: number }> = {
  leftChest: { x: 0.35, y: 0.4 },
  back: { x: 0.75, y: 0.39 },
  leftSleeve: { x: 0.43, y: 0.42 },
  rightSleeve: { x: 0.1, y: 0.42 },
};

export function taskStatus(task: MockupTask): TaskStatus {
  if (Object.keys(task.placements).length === 0) return 'waitingLogo';
  if (task.exportedAt) return 'exported';
  return 'ready';
}

export function createTask(productCode: string, now = new Date()): MockupTask {
  const timestamp = now.toISOString();
  return {
    id: crypto.randomUUID(),
    productCode,
    placements: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    exportedAt: null,
  };
}

export function stateWithNewTasks(
  state: DemoState,
  productCodes: string[],
  now = new Date(),
): DemoState {
  const newTasks = productCodes.map((productCode) => createTask(productCode, now));
  return {
    ...state,
    tasks: [...state.tasks, ...newTasks],
    updatedAt: now.toISOString(),
  };
}

export function placementWidthRatio(
  placement: LogoPlacement,
  product: Product,
) {
  return (placement.widthCm / product.garmentWidthCm) * 0.46;
}

export function placementCenter(
  key: PlacementKey,
  placement: LogoPlacement,
) {
  const anchor = PLACEMENT_ANCHORS[key];
  return {
    x: anchor.x + placement.offsetX / 100,
    y: anchor.y + placement.offsetY / 100,
  };
}
