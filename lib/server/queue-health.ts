import { catalogDatabase, type CatalogQueryClient } from './catalog-database';

export type QueueHealth = {
  queued: number; running: number; oldestQueuedMinutes: number | null;
  externalWorkerSeenSecondsAgo: number | null;
};

/** Paying customers' work: everything outside the internal `main` workspace, plus 电商主图. */
export async function externalQueueHealth(db: CatalogQueryClient = catalogDatabase()): Promise<QueueHealth> {
  const { rows: [row] } = await db.query(`
    WITH waiting AS (
      SELECT status, created_at FROM batch_queue WHERE workspace <> 'main' AND status IN ('queued','running')
      UNION ALL
      -- A 电商主图 job waiting on an earlier step is not stuck; it counts from when it could start.
      SELECT j.status, GREATEST(j.created_at, (SELECT max(d.updated_at) FROM listing_jobs d WHERE d.id::text = ANY(j.depends)))
        FROM listing_jobs j
       WHERE j.status = 'running' OR (j.status = 'queued'
         AND NOT EXISTS (SELECT 1 FROM listing_jobs d WHERE d.id::text = ANY(j.depends) AND d.status <> 'succeeded')))
    SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
           count(*) FILTER (WHERE status = 'running')::int AS running,
           extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'queued')) / 60 AS oldest,
           (SELECT extract(epoch FROM now() - max(heartbeat_at)) FROM batch_workers WHERE id LIKE 'external:%') AS seen
      FROM waiting`);
  return {
    queued: Number(row?.queued ?? 0), running: Number(row?.running ?? 0),
    oldestQueuedMinutes: row?.oldest == null ? null : Math.floor(Number(row.oldest)),
    externalWorkerSeenSecondsAgo: row?.seen == null ? null : Math.round(Number(row.seen)),
  };
}

/** Work is waiting and nothing is moving: the state a paused worker leaves behind. */
export const queueStuck = (health: QueueHealth, thresholdMinutes = 3) => health.running === 0 && (health.oldestQueuedMinutes ?? 0) >= thresholdMinutes;

/**
 * On 2026-10-15 customers' work sat queued all night and we heard it from them. Work waiting over
 * `thresholdMinutes` with nothing running now shows up in the logs, at most every `repeatMinutes`.
 * A busy queue (tasks waiting behind running ones) is not an alarm.
 */
export function queueAlarm({ check = () => externalQueueHealth(), log = (message: string, detail: QueueHealth) => console.error(message, JSON.stringify(detail)),
  thresholdMinutes = 3, repeatMinutes = 10, now = Date.now }: {
  check?: () => Promise<QueueHealth>; log?: (message: string, detail: QueueHealth) => void;
  thresholdMinutes?: number; repeatMinutes?: number; now?: () => number;
} = {}) {
  let lastAlarm = -Infinity;
  return async () => {
    const health = await check();
    const stuck = queueStuck(health, thresholdMinutes);
    if (stuck && now() - lastAlarm >= repeatMinutes * 60_000) {
      lastAlarm = now();
      log(`[queue-alarm] 客户任务排队 ${health.oldestQueuedMinutes} 分钟没人处理`, health);
    }
    if (!stuck) lastAlarm = -Infinity;
    return health;
  };
}
