import { beforeEach, expect, it, vi } from 'vitest';

// email_quota's conditional upsert, in memory: a row stops counting once it reaches the limit.
const counters = new Map<string, number>();
vi.mock('./catalog-database', () => ({
  catalogTransaction: async (work: (client: unknown) => Promise<unknown>) => work({
    query: async (_sql: string, [scope, seconds, start, limit]: [string, number, string, number]) => {
      const key = `${scope}|${seconds}|${start}`, used = counters.get(key) ?? 0;
      if (used >= limit) return { rowCount: 0, rows: [] };
      counters.set(key, used + 1); return { rowCount: 1, rows: [{ used: used + 1 }] };
    },
  }),
}));
const { limitUploads } = await import('./upload-limit');
beforeEach(() => counters.clear());

it('lets uploads through up to the hourly limit, then refuses with 429', async () => {
  for (let n = 0; n < 3; n++) await limitUploads('upload:t1', [[3600, 3], [86400, 10]]);
  await expect(limitUploads('upload:t1', [[3600, 3], [86400, 10]])).rejects.toMatchObject({ status: 429, message: '上传太频繁，请稍后再试' });
});

it('says the day is used up when the daily window runs out first', async () => {
  for (let n = 0; n < 2; n++) await limitUploads('upload:t2', [[3600, 50], [86400, 2]]);
  await expect(limitUploads('upload:t2', [[3600, 50], [86400, 2]])).rejects.toMatchObject({ status: 429, message: '今天的上传次数已用完，明天再试' });
});

it('counts each tenant or workspace on its own', async () => {
  for (let n = 0; n < 3; n++) await limitUploads('upload:t3', [[3600, 3]]);
  await expect(limitUploads('upload:t4', [[3600, 3]])).resolves.toBeUndefined();
});
