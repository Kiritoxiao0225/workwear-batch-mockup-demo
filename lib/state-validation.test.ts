import { describe, expect, it } from 'vitest';

import { assertDemoState } from '@/lib/state-validation';

const validState = {
  version: 1,
  updatedAt: '2026-08-18T08:00:00.000Z',
  tasks: [
    {
      id: 'task-1',
      productCode: '301SRX',
      placements: {
        leftChest: {
          logoUrl: '/uploads/logos/demo.png',
          logoName: 'demo.png',
          widthCm: 7,
          offsetX: 0,
          offsetY: 0,
          rotation: 0,
        },
      },
      createdAt: '2026-08-18T08:00:00.000Z',
      updatedAt: '2026-08-18T08:00:00.000Z',
      exportedAt: null,
    },
  ],
};

describe('demo state validation', () => {
  it('accepts a task backed by a known product and a valid placement', () => {
    expect(() => assertDemoState(validState)).not.toThrow();
  });

  it('fails fast when a task references an unknown product', () => {
    expect(() =>
      assertDemoState({
        ...validState,
        tasks: [{ ...validState.tasks[0], productCode: 'UNKNOWN' }],
      }),
    ).toThrow('任务引用了不存在的商品：UNKNOWN');
  });

  it('fails fast when the same task id appears twice', () => {
    expect(() =>
      assertDemoState({
        ...validState,
        tasks: [validState.tasks[0], validState.tasks[0]],
      }),
    ).toThrow('任务 ID 重复：task-1');
  });

  it('rejects unsupported positions and invalid physical width', () => {
    expect(() =>
      assertDemoState({
        ...validState,
        tasks: [
          {
            ...validState.tasks[0],
            placements: {
              collar: validState.tasks[0].placements.leftChest,
            },
          },
        ],
      }),
    ).toThrow('包含未知位置：collar');

    expect(() =>
      assertDemoState({
        ...validState,
        tasks: [
          {
            ...validState.tasks[0],
            placements: {
              leftChest: {
                ...validState.tasks[0].placements.leftChest,
                widthCm: 0,
              },
            },
          },
        ],
      }),
    ).toThrow('widthCm 超出 1-50cm：0');
  });
});
