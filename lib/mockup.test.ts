import { describe, expect, it } from 'vitest';

import {
  createTask,
  placementCenter,
  placementWidthRatio,
  stateWithNewTasks,
  taskStatus,
} from '@/lib/mockup';
import { productByCode } from '@/lib/products';
import type { DemoState, LogoPlacement } from '@/lib/types';

const now = new Date('2026-08-18T08:00:00.000Z');
const placement: LogoPlacement = {
  logoUrl: '/uploads/logos/demo.png',
  logoName: 'demo.png',
  widthCm: 7,
  offsetX: 5,
  offsetY: -3,
  rotation: 0,
};

describe('mockup task rules', () => {
  it('creates one empty task for a selected product', () => {
    const task = createTask('301SRX', now);

    expect(task.productCode).toBe('301SRX');
    expect(task.placements).toEqual({});
    expect(task.updatedAt).toBe(now.toISOString());
    expect(taskStatus(task)).toBe('waitingLogo');
  });

  it('derives ready and exported states without a generation step', () => {
    const readyTask = {
      ...createTask('301SRX', now),
      placements: { leftChest: placement },
    };

    expect(taskStatus(readyTask)).toBe('ready');
    expect(taskStatus({ ...readyTask, exportedAt: now.toISOString() })).toBe('exported');
  });

  it('appends multiple product tasks to the current batch', () => {
    const state: DemoState = {
      version: 1,
      tasks: [createTask('011HYX', now)],
      updatedAt: now.toISOString(),
    };

    const nextState = stateWithNewTasks(state, ['301SRX', '388'], now);

    expect(nextState.tasks.map((task) => task.productCode)).toEqual([
      '011HYX',
      '301SRX',
      '388',
    ]);
  });
});

describe('mockup placement rules', () => {
  it('converts physical logo width to the combined product image ratio', () => {
    const product = productByCode('301SRX');
    expect(product).toBeDefined();

    expect(placementWidthRatio(placement, product!)).toBeCloseTo(0.0644, 4);
  });

  it('adds drag offsets to the selected placement anchor', () => {
    const center = placementCenter('leftChest', placement);
    expect(center.x).toBeCloseTo(0.4);
    expect(center.y).toBeCloseTo(0.37);
  });

  it('places a full front graphic on the center of the front garment view', () => {
    const center = placementCenter('frontCenter', { ...placement, offsetX: 0, offsetY: 0 });

    expect(center).toEqual({ x: 0.25, y: 0.48 });
  });
});
