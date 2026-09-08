import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { catalogDatabase, closeCatalogDatabase } from '../lib/server/catalog-database';
import { loadBodyGeometry } from '../lib/server/catalog-body-geometry';
import { boxSchema } from '../lib/catalog';
import { z } from 'zod';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const rowSchema = z.object({ asset_id: z.uuid(), file_id: z.uuid(), sha256: z.string(), width: z.number().int(), height: z.number().int(), crops: z.array(boxSchema) });
const started = Date.now();
try {
  // Include historical versions: existing tasks can still pin those images.
  const rows = (await catalogDatabase().query(`SELECT a.id AS asset_id,f.id AS file_id,f.sha256,f.width,f.height,
    jsonb_agg(g.crop ORDER BY CASE g.face WHEN 'front' THEN 0 ELSE 1 END) AS crops
    FROM garment_asset_versions a JOIN files f ON f.id=a.file_id JOIN garment_views g ON g.asset_version_id=a.id
    WHERE f.status='ready' AND f.gc_state='active' GROUP BY a.id,f.id ORDER BY a.id`)).rows.map(row => rowSchema.parse(row));
  const results: { assetVersionId: string; widthRatios?: (number | null)[]; error?: string }[] = [];
  for (let offset = 0; offset < rows.length; offset += 3) {
    results.push(...await Promise.all(rows.slice(offset, offset + 3).map(async row => {
      try {
        const widthRatios = await loadBodyGeometry({ fileId: row.file_id, sha256: row.sha256, width: row.width, height: row.height, crops: row.crops });
        return { assetVersionId: row.asset_id, widthRatios };
      } catch (error) { return { assetVersionId: row.asset_id, error: error instanceof Error ? error.message : String(error) }; }
    })));
    if ((offset + 3) % 30 === 0) console.log({ prepared: results.length, total: rows.length });
  }
  const summary = { assets: rows.length, prepared: results.filter(r => r.widthRatios).length, needsCalibration: results.filter(r => r.widthRatios?.some(value => value === null)).length, failed: results.filter(r => r.error).length, elapsedMs: Date.now() - started, results };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(summary, null, 2));
  console.log({ ...summary, results: undefined });
  if (summary.failed) process.exitCode = 1;
} finally { await closeCatalogDatabase(); }
