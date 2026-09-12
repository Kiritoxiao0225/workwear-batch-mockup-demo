import { beforeEach, expect, it, vi } from 'vitest';
import { createProductionCleanupScheduler, finishProductionSave } from './production-post-save';
import { readCloudProductionState } from './production-cloud-state';
import { mutateWpsProductionState, readWpsProductionState } from './wps-production-store';
import type { WpsProductionState } from '@/lib/wps-production';
import { savedProductionRender } from './production-render-cache';
import { cleanupReplacedFiles } from './production-replaced-files';
import { emptyWpsProductionState, importTaskReviews } from '../wps-production';
import { taskReviewFixture } from '../testing/task-review-fixture';
import { garmentFixture } from '../testing/production-garment-fixture';

vi.mock('./production-cloud-state', () => ({ readCloudProductionState: vi.fn() }));
vi.mock('./production-render-cache', () => ({ savedProductionRender: vi.fn() }));
vi.mock('./production-replaced-files', () => ({ cleanupReplacedFiles: vi.fn() }));
// 候选修复把保存后的合成改为 trackedProductionRender（lib/server/production-render-recovery）：
// 它在调用 savedProductionRender 前后读写 wps-production-store 记录可恢复结果，测试需一并 mock。
vi.mock('./wps-production-store', () => ({ readWpsProductionState: vi.fn(), mutateWpsProductionState: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks(); vi.mocked(cleanupReplacedFiles).mockResolvedValue({ deleted: [], failures: [] });
  const storeState = { revision: 1, renderOutcomes: undefined, mockupVersions: [], units: [], records: [] } as unknown as WpsProductionState;
  vi.mocked(readWpsProductionState).mockResolvedValue(storeState);
  vi.mocked(mutateWpsProductionState).mockImplementation(async (_revision: number, mutate: (state: WpsProductionState) => WpsProductionState | Promise<WpsProductionState>) => mutate(storeState));
  vi.mocked(savedProductionRender).mockResolvedValue({ file: { id: 'rendered', sha256: 'a'.repeat(64), width: 100, height: 100, byte_length: 10, mime_type: 'image/png' }, bytes: Buffer.from('png') } as never);
});

it('uses the latest saved input and only renders the affected garment version', async () => {
  const reviews = taskReviewFixture();
  reviews.forEach(review => review.units.forEach(unit => { unit.garment = garmentFixture(); }));
  const state = importTaskReviews(emptyWpsProductionState(), reviews);
  const unit = state.units[0];
  // 候选修复的 productionRenderInputKey 会读取 artwork.validation.sha256（类型必填），补全夹具。
  unit.artwork = { url: '/api/production-files/latest', validation: { sha256: 'latest-artwork' } } as NonNullable<typeof unit.artwork>;
  const version = state.mockupVersions.find(version => version.unitIds.includes(unit.id))!;
  vi.mocked(readCloudProductionState).mockResolvedValue(state);
  await finishProductionSave({ action: 'saveArtworkDraft', unitId: unit.id });
  expect(savedProductionRender).toHaveBeenCalledExactlyOnceWith(version, version.unitIds.map(id => state.units.find(unit => unit.id === id)));
  expect(cleanupReplacedFiles).toHaveBeenCalledOnce();
});

it('still retries deletion when reading state fails, and does not reject the completed save', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(readCloudProductionState).mockRejectedValue(new Error('offline'));
  await expect(finishProductionSave({ action: 'submitArtwork', unitId: 'one' })).resolves.toBeUndefined();
  expect(savedProductionRender).not.toHaveBeenCalled();
  expect(cleanupReplacedFiles).toHaveBeenCalledOnce();
  log.mockRestore();
});

it('reading the page retries deletion without regenerating all pictures', async () => {
  await finishProductionSave();
  expect(readCloudProductionState).not.toHaveBeenCalled();
  expect(savedProductionRender).not.toHaveBeenCalled();
  expect(cleanupReplacedFiles).toHaveBeenCalledOnce();
});

it('does not compete with the explicit whole-garment compose request', async () => {
  await finishProductionSave({ action: 'savePlacements', confirmWholeVersion: true, updates: [{ unitId: 'one' }] });
  expect(readCloudProductionState).not.toHaveBeenCalled();
  expect(savedProductionRender).not.toHaveBeenCalled();
  expect(cleanupReplacedFiles).toHaveBeenCalledOnce();
});

it('coalesces simultaneous preview reads and limits idle checks without delaying writes', async () => {
  let clock = 0;
  let resolve!: (value: { deleted: string[]; failures: { id: string; error: string }[] }) => void;
  const result = { deleted: [], failures: [] };
  const run = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(result);
  const schedule = createProductionCleanupScheduler(run, () => clock);
  const first = schedule(false), duplicate = schedule(false), write = schedule(true);
  expect(run).toHaveBeenCalledOnce();
  resolve(result);
  await Promise.all([first, duplicate, write]);
  expect(run).toHaveBeenCalledTimes(2);
  await schedule(false);
  expect(run).toHaveBeenCalledTimes(2);
  clock = 30_000;
  await schedule(false);
  expect(run).toHaveBeenCalledTimes(3);
});

it('does not hide a failed read cleanup behind the cooldown', async () => {
  const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ deleted: [], failures: [] });
  const schedule = createProductionCleanupScheduler(run, () => 0);
  await expect(schedule(false)).rejects.toThrow('offline');
  await schedule(false);
  expect(run).toHaveBeenCalledTimes(2);
});
