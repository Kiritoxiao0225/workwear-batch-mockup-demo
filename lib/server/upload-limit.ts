import { CatalogHttpError } from './catalog-auth';
import { catalogTransaction } from './catalog-database';

export type UploadWindow = readonly [seconds: number, limit: number];

/** Studio upload chunks live in batch_documents and are not counted against storage, so they are rate limited instead. */
export const CHUNK_WINDOWS: UploadWindow[] = [[3600, 600], [86400, 1500]];
/** 电商主图 uploads are checked against storage first; this only bounds a flood (a product may hold 500 images). */
export const LISTING_UPLOAD_WINDOWS: UploadWindow[] = [[3600, 1500], [86400, 5000]];

/**
 * Count one upload in every window, in one transaction: a refused window rolls back the others, so
 * a rejected request never uses up the rest. Same counter table and shape as the login limits.
 */
export async function limitUploads(scope: string, windows: UploadWindow[]) {
  await catalogTransaction(async client => {
    for (const [seconds, limit] of windows) {
      const start = new Date(Math.floor(Date.now() / (seconds * 1000)) * seconds * 1000).toISOString();
      const counted = await client.query(`INSERT INTO email_quota(scope,window_seconds,window_start,used) VALUES($1,$2,$3,1)
        ON CONFLICT(scope,window_seconds,window_start) DO UPDATE SET used=email_quota.used+1 WHERE email_quota.used<$4 RETURNING used`,
      [scope, seconds, start, limit]);
      if (!counted.rowCount) throw new CatalogHttpError(429, seconds <= 3600 ? '上传太频繁，请稍后再试' : '今天的上传次数已用完，明天再试');
    }
  });
}
