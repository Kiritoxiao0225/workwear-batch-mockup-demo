/** Snapshot of everything the WPS delivery depends on, for a before/after comparison. */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
// The TLS certificate lives in .env.local; the admin file only overrides the connection URL.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
if (existsSync('.env.catalog-admin.local')) process.loadEnvFile('.env.catalog-admin.local');
if (process.env.CATALOG_DATABASE_MIGRATION_URL) process.env.CATALOG_DATABASE_URL = process.env.CATALOG_DATABASE_MIGRATION_URL;
const { catalogDatabase, closeCatalogDatabase } = await import('../lib/server/catalog-database');

const out = process.argv[2];
if (!out) throw new Error('用法：tsx scripts/migration-baseline.ts <输出路径>');

const db = catalogDatabase();
const counts = await db.query(`
  SELECT 'batch_documents' AS t, count(*)::int AS n FROM garment_catalog.batch_documents WHERE workspace='main'
  UNION ALL SELECT 'batch_assets', count(*)::int FROM garment_catalog.batch_assets WHERE workspace='main'
  UNION ALL SELECT 'batch_queue', count(*)::int FROM garment_catalog.batch_queue WHERE workspace='main'
  UNION ALL SELECT 'garment_styles', count(*)::int FROM garment_catalog.garment_styles
  UNION ALL SELECT 'garment_variants', count(*)::int FROM garment_catalog.garment_variants
  UNION ALL SELECT 'garment_asset_versions', count(*)::int FROM garment_catalog.garment_asset_versions
  UNION ALL SELECT 'garment_views', count(*)::int FROM garment_catalog.garment_views
  UNION ALL SELECT 'placement_standard_versions', count(*)::int FROM garment_catalog.placement_standard_versions
  UNION ALL SELECT 'standard_reuse_checks', count(*)::int FROM garment_catalog.standard_reuse_checks
  UNION ALL SELECT 'asset_sources', count(*)::int FROM garment_catalog.asset_sources
  UNION ALL SELECT 'files', count(*)::int FROM garment_catalog.files
  UNION ALL SELECT 'production_states', count(*)::int FROM garment_catalog.production_states
  UNION ALL SELECT 'production_file_refs', count(*)::int FROM garment_catalog.production_file_refs
  UNION ALL SELECT 'import_batches', count(*)::int FROM garment_catalog.import_batches
  UNION ALL SELECT 'users', count(*)::int FROM garment_catalog.users
  ORDER BY 1`);

const digests = await db.query(`
  SELECT
    (SELECT md5(string_agg(path||'|'||revision, E'\n' ORDER BY path)) FROM garment_catalog.batch_documents WHERE workspace='main') AS docs,
    (SELECT md5(string_agg(path||'|'||sha256, E'\n' ORDER BY path)) FROM garment_catalog.batch_assets WHERE workspace='main') AS assets,
    (SELECT md5(string_agg(s.style_code||'|'||v.color_name||'|'||a.version||'|'||a.file_id::text, E'\n' ORDER BY s.style_code, v.color_name, a.version))
       FROM garment_catalog.garment_styles s
       JOIN garment_catalog.garment_variants v ON v.style_id=s.id
       JOIN garment_catalog.garment_asset_versions a ON a.variant_id=v.id) AS catalog,
    (SELECT md5(string_agg(id::text||'|'||revision::text, E'\n' ORDER BY id)) FROM garment_catalog.placement_standard_versions) AS standards`);

const migrations = await db.query('SELECT name FROM garment_catalog.schema_migrations ORDER BY name');
const snapshot = {
  takenAt: new Date().toISOString(),
  migrations: migrations.rows.map(r => r.name),
  counts: Object.fromEntries(counts.rows.map(r => [r.t, r.n])),
  digests: digests.rows[0],
};
await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(snapshot, null, 2));
await closeCatalogDatabase();
