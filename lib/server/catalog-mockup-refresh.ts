import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { CatalogQueryClient } from './catalog-database';

/**
 * A new confirmation changes where logos sit on every color of the style (own or shared points),
 * but mockups only re-render when something queues them. Queue each requirement whose cards use a
 * color of this style, in the confirming transaction; re-composing reuses the finished artwork.
 */
export async function queueStyleMockups(client: CatalogQueryClient, tenantId: string, styleId: string) {
  const tenant = (await client.query('SELECT workspace FROM tenants WHERE id=$1', [tenantId])).rows[0];
  if (!tenant?.workspace) return 0;
  const variants = (await client.query('SELECT id FROM garment_variants WHERE style_id=$1', [styleId])).rows.map(r => r.id as string);
  if (!variants.length) return 0;
  // Small documents are matched in SQL; the rare gzip-compressed one is decoded here.
  const rows = (await client.query(`SELECT path,content_gzip FROM batch_documents WHERE workspace=$1 AND starts_with(path,'mockups/') AND (content_gzip IS NOT NULL
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(content_json->'cards') c WHERE c->>'variantId'=ANY($2::text[])))`, [tenant.workspace, variants])).rows;
  let queued = 0;
  for (const row of rows) {
    const caseId = /^mockups\/([a-zA-Z0-9_-]{1,100})\.json$/.exec(row.path)?.[1];
    if (!caseId) continue;
    if (row.content_gzip && !JSON.parse(gunzipSync(row.content_gzip).toString()).cards?.some((c: { variantId?: string }) => c.variantId && variants.includes(c.variantId))) continue;
    const added = await client.query(`INSERT INTO batch_queue(id,workspace,kind,payload) SELECT $1,$2,'mockup',$3
      WHERE NOT EXISTS(SELECT 1 FROM batch_queue WHERE workspace=$2 AND kind='mockup' AND status='queued' AND payload->>'caseId'=$4)`, [randomUUID(), tenant.workspace, { caseId }, caseId]);
    queued += added.rowCount;
  }
  return queued;
}
