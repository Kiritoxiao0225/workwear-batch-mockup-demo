import { beforeEach, expect, it, vi } from 'vitest';
import { createProductionCleanupScheduler, finishProductionSave } from './production-post-save';
import { readCloudProductionState } from './production-cloud-state';
import { savedProductionRender } from './production-render-cache';
import { cleanupReplacedFiles } from './production-replaced-files';
import { emptyWpsProductionState, importTaskReviews } from '../wps-production';
import { taskReviewFixture } from '../testing/task-review-fixture';
import { garmentFixture } from '../testing/production-garment-fixture';

vi.mock('./production-cloud-state', () => ({ readCloudProductionState: vi.fn() }));
vi.mock('./production-render-cache', () => ({ savedProductionRender: vi.fn() }));
vi.mock('./production-replaced-files', () => ({ cleanupReplacedFiles: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(cleanupReplacedFiles).mockResolvedValue({ deleted: [], failures: [] }); });

it('uses the latest saved input and only renders the affected garment version', async () => {
  const reviews = taskReviewFixture();
  reviews.forEach(review => review.units.forEach(unit => { unit.garment = garmentFixture(); }));
  const state = importTaskReviews(emptyWpsProductionState(), reviews);
  const unit = state.units[0];
  unit.artwork = { url: '/api/production-files/latest' } as NonNullable<typeof unit.artwork>;
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
