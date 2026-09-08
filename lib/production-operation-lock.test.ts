import { describe, expect, it, vi } from 'vitest';
import { ProductionOperationLocks, productionOperation } from './production-operation-lock';
import { emptyWpsProductionState, importTaskReviews } from './wps-production';
import { taskReviewFixture } from './testing/task-review-fixture';

const state = importTaskReviews(emptyWpsProductionState(), taskReviewFixture());
const first = state.mockupVersions.find(version => version.unitIds.length === 2)!;
const other = state.mockupVersions.find(version => version.id !== first.id)!;
const unit = (id: string) => ({ action: 'submitArtwork', unitId: id });
const version = (id: string) => ({ action: 'composeVersion', versionId: id });

describe('production operation scope', () => {
  it('allows another image, including the other face, while preventing double clicks and changing its shared garment', () => {
    const locks = new ProductionOperationLocks(vi.fn());
    expect(locks.start(productionOperation(state, 'generate', unit(first.unitIds[0]), '制作中'))).toBeTypeOf('function');
    expect(locks.start(productionOperation(state, 'confirm', { action: 'confirmArtwork', unitId: first.unitIds[0] }, '确认中'))).toBeNull();
    expect(locks.start(productionOperation(state, 'garment', { action: 'selectGarment', unitId: first.unitIds[1] }, '换衣服'))).toBeNull();
    expect(locks.start(productionOperation(state, 'back', unit(first.unitIds[1]), '制作中'))).toBeTypeOf('function');
    expect(locks.start(productionOperation(state, 'other', version(other.id), '合成中'))).toBeTypeOf('function');
    expect(locks.start(productionOperation(state, 'analyze', { action: 'upsertReviews' }, '分析中'))).toBeNull();
  });

  it('releases only the completed or failed operation, even when an old finally runs again', () => {
    const locks = new ProductionOperationLocks(vi.fn());
    const firstOp = productionOperation(state, 'first', unit(first.unitIds[0]), '保存中');
    const release = locks.start(firstOp)!;
    locks.start(productionOperation(state, 'other', unit(other.unitIds[0]), '保存中'));
    release();
    expect(locks.entries.map(operation => operation.key)).toEqual(['other']);
    const next = locks.start({ ...firstOp })!;
    release();
    expect(locks.entries).toHaveLength(2);
    next();
    expect(locks.entries.map(operation => operation.key)).toEqual(['other']);
  });

  it('holds an entire version for placement and composition, but not unrelated versions', () => {
    const locks = new ProductionOperationLocks(vi.fn());
    locks.start(productionOperation(state, 'placement', { action: 'savePlacements', updates: [{ unitId: first.unitIds[0] }] }, '保存位置'));
    expect(locks.start(productionOperation(state, 'back', unit(first.unitIds[1]), '编辑'))).toBeNull();
    expect(locks.start(productionOperation(state, 'other', unit(other.unitIds[0]), '编辑'))).toBeTypeOf('function');
  });
});
