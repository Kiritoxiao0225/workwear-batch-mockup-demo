export const WPS_ANALYSIS_CONCURRENCY = 5;

/** Models run concurrently; commits run one at a time so revisions never race within a batch. */
export async function runTaskReviewAnalysisBatch<T, R>(
  records: T[],
  analyze: (record: T) => Promise<R>,
  save: (result: R, record: T) => Promise<void>,
  completed: (record: T, error: unknown | null) => void,
) {
  let cursor = 0;
  let commits: Promise<void> = Promise.resolve();
  await Promise.all(Array.from({ length: Math.min(WPS_ANALYSIS_CONCURRENCY, records.length) }, async () => {
    while (cursor < records.length) {
      const record = records[cursor++];
      try {
        const result = await analyze(record);
        const commit = commits.then(() => save(result, record));
        commits = commit.catch(() => {});
        await commit;
        completed(record, null);
      } catch (error) {
        completed(record, error);
      }
    }
  }));
}
