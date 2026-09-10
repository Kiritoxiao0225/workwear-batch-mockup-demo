import { createRequire } from 'node:module';
createRequire(import.meta.url)('@next/env').loadEnvConfig(process.cwd());
const { catalogDatabase, closeCatalogDatabase } = await import('../lib/server/catalog-database');
const { productionStateKey, usesProductionCloud } = await import('../lib/server/production-storage');
const { migrateCutoutImages } = await import('../lib/server/artwork-cutout-store');
if (!usesProductionCloud()) throw new Error('需要 WPS_PRODUCTION_STORAGE=cloud');
const apply = process.argv.includes('--apply');
const limit = Number(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] ?? 10);
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 必须是 1–100');
try {
  if (apply) console.log(JSON.stringify(await migrateCutoutImages(limit)));
  const row = (await catalogDatabase().query("SELECT count(*)::int AS remaining,coalesce(sum(pg_column_size(job_json)),0)::bigint AS json_bytes FROM artwork_cutout_jobs WHERE state_key=$1 AND job_json::text LIKE '%data:image/%'", [productionStateKey()])).rows[0];
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'read-only', stateKey: productionStateKey(), ...row }));
} finally { await closeCatalogDatabase(); }
