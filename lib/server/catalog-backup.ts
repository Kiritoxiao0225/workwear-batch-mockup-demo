import { z } from 'zod';
import { catalogTransaction } from './catalog-database';
import { fileSha256 } from './catalog-files';

const TABLES = ['users', 'sessions', 'files', 'catalog_body_geometry', 'garment_styles', 'garment_variants', 'garment_asset_versions', 'asset_sources', 'garment_views', 'placement_standard_versions', 'standard_reuse_checks', 'import_batches', 'import_items', 'audit_events', 'production_states', 'production_file_refs', 'production_operations', 'production_renders', 'production_render_cache', 'production_save_receipts', 'artwork_cutout_jobs', 'artwork_run_records', 'artwork_jobs', 'artwork_job_steps', 'artwork_job_files', 'artwork_stage_slots', 'artwork_workers'] as const;
const payloadSchema = z.object({ schemaVersion: z.literal(1), migrations: z.array(z.object({ name: z.string(), sha256: z.string() }).strict()), tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) }).strict();
export async function backupCatalog() {
  const payload = await catalogTransaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const migrations = await client.query('SELECT name,sha256 FROM schema_migrations ORDER BY name');
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const table of TABLES) {
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
  if (Object.keys(backup.payload.tables).sort().join(',') !== [...TABLES].sort().join(',')) throw new Error('备份包含缺失或未知的数据表');
  return catalogTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('garment_catalog_restore'))");
    const migrations = await client.query('SELECT name,sha256 FROM schema_migrations ORDER BY name');
    if (JSON.stringify(migrations.rows) !== JSON.stringify(backup.payload.migrations)) throw new Error('恢复目标的迁移版本与备份不同');
    for (const table of TABLES) {
      const count = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
      if (count.rows[0].count !== 0) throw new Error(`恢复目标必须为空库；${table} 已有 ${count.rows[0].count} 条记录`);
    }
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const table of TABLES) await client.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table},$1::json)`, [backup.payload.tables[table]]);
    return { restoredTables: TABLES.length };
  });
}
