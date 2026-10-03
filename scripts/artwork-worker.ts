import { createServer } from 'node:http';
import { createRequire } from 'node:module';
createRequire(import.meta.url)('@next/env').loadEnvConfig(process.cwd());

if (process.env.BATCH_WORKBENCH_ENABLED !== '1') throw new Error('旧版后台已停用，请开启 BATCH_WORKBENCH_ENABLED=1');
if (process.env.VERCEL === '1') throw new Error('后台任务需要持续运行的服务');
const { startBatchWorker } = await import('../batch-mockup/runtime/worker.mjs');
const { closeCatalogDatabase } = await import('../lib/server/catalog-database');
const { catalogStorageConfig } = await import('../lib/server/catalog-files');
const { catalogObjectStore } = await import('../lib/server/catalog-oss');
const { WORKWEAR_LOGIC_VERSION } = await import('../lib/artwork-reliability');
const storage = catalogStorageConfig();
const objectStore = storage.backend === 'oss' ? catalogObjectStore() : storage.backend;
let stop!: () => void;
const stopped = new Promise<void>(resolve => { stop = resolve; });
process.once('SIGTERM', stop); process.once('SIGINT', stop);
const { createAdmissionGate } = await import('../batch-mockup/runtime/resource-guard.mjs');
const admission = createAdmissionGate();
const worker = await startBatchWorker({ admission });
const { startGarmentWorker } = await import('../lib/server/garment-mockup-ai');
const garmentWorker = await startGarmentWorker({ canAccept: () => !admission.check().paused });
const { startListingWorker } = await import('../lib/server/listing-jobs');
const listingWorker = await startListingWorker({ canAccept: () => !admission.check().paused });
const { startOffsiteBackup } = await import('../lib/server/catalog-backup-scheduler');
const backup = startOffsiteBackup();
const health = process.env.PORT ? createServer((_request, response) => {
  const status = worker.status();
  const databaseBackup = backup.status();
  const ready = _request.url === '/ops/backup' ? databaseBackup.ready : _request.url === '/live' ? true : status.ready;
  response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ ...status, workflow: 'batch', legacyEnabled: false, databaseBackup,
    stabilityRelease: process.env.STABILITY_RELEASE_SHA256 ?? null, logicVersion: WORKWEAR_LOGIC_VERSION, commit: process.env.WORKWEAR_BUILD_COMMIT ?? null, objectStore }));
}).listen(Number(process.env.PORT), '0.0.0.0') : undefined;
console.log('[batch-worker] ready:', worker.status().scope, 'legacy worker disabled');
try { await stopped; await Promise.all([worker.close(), garmentWorker.close(), listingWorker.close(), backup.close()]); }
finally { health?.close(); await closeCatalogDatabase(); }
