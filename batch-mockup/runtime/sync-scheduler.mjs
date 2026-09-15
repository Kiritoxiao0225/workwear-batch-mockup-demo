import { randomUUID } from 'node:crypto';
import { catalogDatabase, catalogTransaction } from '../../lib/server/catalog-database.ts';
import { workspaceId } from '../adapters/cloud-files.mjs';

export const WPS_SYNC_INTERVAL_SECONDS = 30;
export const WPS_SYNC_FAILURE_DELAY_SECONDS = 60;

// Both the button and every worker replica use this transaction. A slow WPS
// request occupies one durable job; ticks and browser clicks cannot pile up.
export async function enqueueWpsSync({ automatic = false, workspace = workspaceId() } = {}) {
  return catalogTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`batch-wps-sync:${workspace}`]);
    const active = (await client.query("SELECT id,status FROM batch_queue WHERE workspace=$1 AND kind='sync' AND status IN ('queued','running') ORDER BY created_at LIMIT 1", [workspace])).rows[0];
    if (active) return { ...active, reused: true };
    if (automatic) {
      // Only the configured, initialized workspace is polled. Test/archived
      // workspaces are never discovered by enumerating the database.
      const initialized = await client.query("SELECT 1 FROM batch_documents WHERE workspace=$1 AND path='manifest.json'", [workspace]);
      if (!initialized.rowCount) return null;
      const recent = await client.query(`SELECT updated_at>now()-(CASE WHEN status='finished' THEN $2::int ELSE $3::int END)*interval '1 second' AS recent
        FROM batch_queue WHERE workspace=$1 AND kind='sync' ORDER BY created_at DESC LIMIT 1`,
      [workspace, WPS_SYNC_INTERVAL_SECONDS, WPS_SYNC_FAILURE_DELAY_SECONDS]);
      if (recent.rows[0]?.recent) return null;
    }
    const id = randomUUID();
    await client.query("INSERT INTO batch_queue(id,workspace,kind,payload) VALUES($1,$2,'sync',$3)", [id, workspace, { automatic }]);
    return { id, status: 'queued', reused: false };
  });
}

export async function readWpsSyncStatus(workspace = workspaceId()) {
  const result = await catalogDatabase().query(`SELECT id,status,error,payload,updated_at,
    (SELECT created_at FROM batch_queue WHERE workspace=$1 AND kind='sync' AND payload->>'automatic'='true' ORDER BY created_at DESC LIMIT 1) AS last_automatic_at
    FROM batch_queue WHERE workspace=$1 AND kind='sync' ORDER BY created_at DESC LIMIT 1`, [workspace]);
  const row = result.rows[0];
  return {
    automatic: Boolean(row?.last_automatic_at), intervalSeconds: WPS_SYNC_INTERVAL_SECONDS,
    status: row?.status ?? 'idle', error: row?.error ?? null,
    updatedAt: row?.updated_at ?? null, lastAutomaticAt: row?.last_automatic_at ?? null,
  };
}
