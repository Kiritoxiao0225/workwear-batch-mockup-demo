import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
createRequire(import.meta.url)('@next/env').loadEnvConfig(process.cwd());
// From the Beijing host, R2 and the image service are across the border. Node gives each resolved
// address only 250 ms to connect; when all of them run over, the job ends with an empty-message
// AggregateError although nothing was sent. Let a slow handshake finish instead.
setDefaultAutoSelectFamilyAttemptTimeout(3000);

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
try { await stopped; await Promise.all([worker.close(), listingWorker.close(), backup.close()]); }
finally { health?.close(); await closeCatalogDatabase(); }
