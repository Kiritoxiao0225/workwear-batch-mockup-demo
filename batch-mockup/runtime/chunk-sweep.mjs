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
  return sweepDocuments(db, CHUNK_PATHS, { olderThanHours, batch, maxBatches, pauseMs });
}

// The request of an 「AI 整理」, sent to the model as it is: the customer's pictures inside as base64,
// up to 60 MB each. Only the analysis task reads it, while it runs; the pictures stay as their own
// files and the analysis keeps their list and the request's hash. 10-25: 215 of them (1.2 GB) made
// every offsite backup about 800 MB until it no longer went through.
const REQUEST_PATHS = "(path LIKE 'analysis-evidence/%-request.json')";

/** Remove analysis requests older than `olderThanHours`, two at a time (each can be 60 MB to free). */
export async function sweepAnalysisRequests({ db = catalogDatabase(), olderThanHours = 24, batch = 2, maxBatches = 60, pauseMs = 1000 } = {}) {
  return sweepDocuments(db, REQUEST_PATHS, { olderThanHours, batch, maxBatches, pauseMs });
}

async function sweepDocuments(db, paths, { olderThanHours, batch, maxBatches, pauseMs }) {
  let removed = 0;
  for (let n = 0; n < maxBatches; n++) {
    if (n) await new Promise(resolve => setTimeout(resolve, pauseMs));
    const result = await db.query(`DELETE FROM batch_documents d USING (
        SELECT workspace, path FROM batch_documents WHERE ${paths} AND updated_at < now() - make_interval(hours => $1) LIMIT $2) old
      WHERE d.workspace = old.workspace AND d.path = old.path`, [olderThanHours, batch]);
    removed += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < batch) break;
  }
  return removed;
}
