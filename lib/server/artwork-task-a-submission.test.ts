import { beforeEach, expect, it, vi } from 'vitest';
import { catalogDatabase } from './catalog-database';
import { inArtworkJob, assertArtworkComponentSubmissionSafe, ArtworkGenerationUnknownError, artworkStepHash, artworkJobStep } from './artwork-job-runtime';
import type { ArtworkJob } from './artwork-job-store';
vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn() }));
const job = { id: 'task-a-isolated-job', input: {} } as ArtworkJob;
const prompt = '局部去字', images = ['data:image/png;base64,fixture'], settings = { background: 'auto' as const };
const key = `generate:${artworkStepHash([prompt, images, settings])}`;
const query = vi.fn();
beforeEach(() => { vi.resetAllMocks(); vi.mocked(catalogDatabase).mockReturnValue({ query } as unknown as ReturnType<typeof catalogDatabase>); });
it.each(['running', 'unknown'])('blocks a changed component hash when any prior submission is %s', async status => {
  query.mockResolvedValue({ rows: [{ step_key: 'generate:old-input', status }] });
  await expect(inArtworkJob(job, () => assertArtworkComponentSubmissionSafe(prompt, images, settings))).rejects.toBeInstanceOf(ArtworkGenerationUnknownError);
  expect(query).toHaveBeenCalledOnce();
});
it('does not repurchase an older completed component with a different un-replayed hash', async () => {
  query.mockResolvedValue({ rows: [{ step_key: 'generate:old-input', status: 'completed' }] });
  await expect(inArtworkJob(job, () => assertArtworkComponentSubmissionSafe(prompt, images, settings))).rejects.toThrow('已有未重放的生图结果');
});
it('allows exact cached replay and the next legitimate component after that replay, with zero paid callbacks', async () => {
  query.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('SELECT *') ? [{ step_key: key, status: 'completed', result: 'cached bytes' }] : [{ step_key: key, status: 'completed' }] }));
  const paid = vi.fn(async () => 'must not execute');
  await inArtworkJob(job, async () => {
    await assertArtworkComponentSubmissionSafe(prompt, images, settings);
    expect(await artworkJobStep('generate', 'generation', [prompt, images, settings], paid)).toBe('cached bytes');
    await assertArtworkComponentSubmissionSafe('next independent styled text', images, settings);
  });
  expect(paid).not.toHaveBeenCalled();
  expect(query.mock.calls.every(([sql]) => String(sql).startsWith('SELECT'))).toBe(true);
});
