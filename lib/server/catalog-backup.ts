import { z } from 'zod';
import { INTERNAL_TENANT_ID } from './catalog-auth';
import { catalogTransaction } from './catalog-database';
import { fileSha256 } from './catalog-files';

// Verification codes, send quotas and in-flight capacity reservations are deliberately
// excluded: they are short-lived state, and restoring stale windows would rate-limit users
// or hold capacity on a freshly recovered database.
// `tenant_file_refs` and `tenant_usage` are NOT optional — without them a restored database
// has files nobody owns and quota counters reset to zero.
const TABLES = ['tenants', 'users', 'user_identities', 'tenant_file_refs', 'tenant_usage', 'credit_accounts', 'price_list', 'credit_holds', 'credit_ledger', 'usage_events', 'sessions', 'files', 'catalog_body_geometry', 'garment_styles', 'garment_variants', 'garment_asset_versions', 'asset_sources', 'garment_views', 'placement_standard_versions', 'standard_reuse_checks', 'import_batches', 'import_items', 'audit_events', 'production_states', 'production_file_refs', 'production_operations', 'production_renders', 'production_render_cache', 'production_save_receipts', 'artwork_cutout_jobs', 'artwork_run_records', 'artwork_jobs', 'artwork_job_steps', 'artwork_job_files', 'artwork_stage_slots', 'artwork_workers', 'artwork_cutout_files', 'wps_analysis_jobs', 'wps_analysis_files', 'batch_documents', 'batch_assets', 'batch_queue', 'batch_workers', 'garment_mockup_projects', 'garment_mockup_assets', 'garment_mockup_revisions', 'garment_mockup_ai_jobs', 'garment_mockup_ai_attempts', 'listing_projects', 'listing_assets', 'listing_jobs', 'listing_attempts'] as const;
// Rows created by a migration rather than by business activity: an otherwise empty restore
// target already contains them, and the backup carries its own copy.
const SEEDED_ROWS: Partial<Record<(typeof TABLES)[number], { column: string; value: string }>> = {
  tenants: { column: 'id', value: INTERNAL_TENANT_ID },
  tenant_usage: { column: 'tenant_id', value: INTERNAL_TENANT_ID },
  credit_accounts: { column: 'tenant_id', value: INTERNAL_TENANT_ID },
};
// The starter price list is seeded by the migration and restored from the backup, so it is
// cleared wholesale rather than by a single id.
const SEEDED_TABLES = ['price_list'] as const;
export const CATALOG_BACKUP_TABLES: readonly string[] = TABLES;
// Each persisted table must be backed up or explicitly documented as disposable.
export const CATALOG_BACKUP_EXCLUDED_TABLES = ['schema_migrations', 'email_challenges', 'email_quota', 'sms_challenges', 'sms_quota', 'sms_attempts', 'quota_reservations', 'garment_mockup_workers', 'listing_workers', 'email_password_tickets'];
const payloadSchema = z.object({ schemaVersion: z.literal(1), migrations: z.array(z.object({ name: z.string(), sha256: z.string() }).strict()), tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) }).strict();
export async function backupCatalog() {
  const payload = await catalogTransaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // A consistent snapshot of every table legitimately runs longer than an interactive query,
    // and the server's default statement timeout would cut it off part way through.
    await client.query("SET LOCAL statement_timeout = '15min'");
    const migrations = await client.query('SELECT name,sha256 FROM schema_migrations ORDER BY name');
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of TABLES) {
      // A database that has not run the newer migrations yet still needs to be backed up;
      // that snapshot is the safety net for running them.
      const present = await client.query('SELECT to_regclass($1) AS oid', [`garment_catalog.${table}`]);
      if (!present.rows[0].oid) continue;
      const rows = await client.query(`SELECT row_to_json(t) AS row FROM ${table} t`);
      tables[table] = rows.rows.map(row => row.row);
    }
    return { schemaVersion: 1 as const, migrations: migrations.rows as { name: string; sha256: string }[], tables };
  });
  return { sha256: fileSha256(JSON.stringify(payload)), payload };
}
export async function restoreCatalog(raw: unknown) {
  const backup = z.object({ sha256: z.string(), payload: payloadSchema }).strict().parse(raw);
  if (fileSha256(JSON.stringify(backup.payload)) !== backup.sha256) throw new Error('备份 SHA-256 校验失败');
  const backedUp = Object.keys(backup.payload.tables) as (typeof TABLES)[number][];
  const unknown = backedUp.filter(table => !(TABLES as readonly string[]).includes(table));
  if (unknown.length) throw new Error(`备份包含未知的数据表：${unknown.join(', ')}`);
  return catalogTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('garment_catalog_restore'))");
    const migrations = await client.query('SELECT name,sha256 FROM schema_migrations ORDER BY name');
    if (JSON.stringify(migrations.rows) !== JSON.stringify(backup.payload.migrations)) throw new Error('恢复目标的迁移版本与备份不同');
    // Migration 017 seeds the internal tenant, so an otherwise empty target is not literally
    // empty. That one row is expected; the backup carries its own copy.
    for (const table of backedUp) {
      if ((SEEDED_TABLES as readonly string[]).includes(table)) continue;
      const seeded = SEEDED_ROWS[table];
      const count = seeded
        ? await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${seeded.column} <> $1`, [seeded.value])
        : await client.query(`SELECT count(*)::int AS count FROM ${table}`);
      if (count.rows[0].count !== 0) throw new Error(`恢复目标必须为空库；${table} 已有 ${count.rows[0].count} 条记录`);
    }
    for (const table of SEEDED_TABLES.filter(table => backedUp.includes(table))) await client.query(`DELETE FROM ${table}`);
    // Ordered so a child row never outlives the parent it points at.
    for (const [table, seeded] of Object.entries(SEEDED_ROWS).reverse()) {
      if (!backedUp.includes(table as (typeof TABLES)[number])) continue;
      await client.query(`DELETE FROM ${table} WHERE ${seeded.column}=$1`, [seeded.value]);
    }
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const table of TABLES) {
      if (!backup.payload.tables[table]) continue;
      await client.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table},$1::json)`, [backup.payload.tables[table]]);
    }
    return { restoredTables: backedUp.length };
  });
}
