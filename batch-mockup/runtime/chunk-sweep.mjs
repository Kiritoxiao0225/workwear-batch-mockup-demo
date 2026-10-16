import { catalogDatabase } from '../../lib/server/catalog-database.ts';

// The three upload-chunk stores. Each chunk is only read while its upload is put together, so a
// day-old one belongs to an upload that finished or was abandoned.
const CHUNK_PATHS = "(path LIKE 'intake-chunks/%' OR path LIKE 'upload-chunks/%' OR path LIKE 'production-jobs/%/edit-upload/%')";

/**
 * Remove upload chunks older than `olderThanHours`. They used to stay in batch_documents (and in
 * every offsite backup) forever. Not removed right after assembly: a failed save is retried with
 * the same upload id.
 *
 * Each chunk carries 1–1.5 MB of picture data, and freeing it is what takes the time: a 500-row
 * batch ran past the 30 s statement timeout on 2026-10-16. Small batches with a pause keep every
 * statement short and the shared disk free for the site.
 */
export async function sweepUploadChunks({ db = catalogDatabase(), olderThanHours = 24, batch = 20, maxBatches = 50, pauseMs = 500 } = {}) {
  let removed = 0;
  for (let n = 0; n < maxBatches; n++) {
    if (n) await new Promise(resolve => setTimeout(resolve, pauseMs));
    const result = await db.query(`DELETE FROM batch_documents d USING (
        SELECT workspace, path FROM batch_documents WHERE ${CHUNK_PATHS} AND updated_at < now() - make_interval(hours => $1) LIMIT $2) old
      WHERE d.workspace = old.workspace AND d.path = old.path`, [olderThanHours, batch]);
    removed += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < batch) break;
  }
  return removed;
}
