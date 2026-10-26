import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
createRequire(import.meta.url)('@next/env').loadEnvConfig(process.cwd());
// From the Beijing host, R2 and the image service are across the border. Node gives each resolved
// address only 250 ms to connect; when all of them run over, the job ends with an empty-message
// AggregateError although nothing was sent. Let a slow handshake finish instead.
setDefaultAutoSelectFamilyAttemptTimeout(3000);
// Requests last as long as their own timeout says, not Node fetch's 300 s (long-request.ts).
(await import('../lib/server/long-request')).installLongRequests();

if (process.env.BATCH_WORKBENCH_ENABLED !== '1') throw new Error('旧版后台已停用，请开启 BATCH_WORKBENCH_ENABLED=1');
if (process.env.VERCEL === '1') throw new Error('后台任务需要持续运行的服务');
await import('../lib/server/sharp-policy');
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
const { createAdmissionGate, idleRecycle } = await import('../batch-mockup/runtime/resource-guard.mjs');
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
// Memory that stays above the resume line while nothing runs is only released by a new process;
// exiting lets Zeabur start one instead of the worker sitting paused (2026-10-15 night).
let recycling = false;
const recycleDue = idleRecycle({ admission, busy: () => worker.status().running > 0 || listingWorker.running() > 0 || backup.status().running });
const recycleTimer = setInterval(() => {
  if (recycling || !recycleDue()) return;
  recycling = true;
  console.warn('[batch-worker] 内存降不下来且没有任务，重启进程', JSON.stringify(admission.status()));
  stop();
}, 15_000);
// Customers' work is served by the external worker; the main worker keeps watch so a stall shows
// up in the logs even when the external worker itself is the one stuck.
const { queueAlarm } = await import('../lib/server/queue-health');
const alarm = worker.status().scope === 'main' ? queueAlarm() : null;
const alarmTimer = alarm ? setInterval(() => { void alarm().catch(error => console.error('[queue-alarm] check failed', error?.name)); }, 60_000) : undefined;
// Day-old upload chunks and AI 整理 requests are removed hourly by the main worker only.
const { sweepAnalysisRequests, sweepUploadChunks } = await import('../batch-mockup/runtime/chunk-sweep.mjs');
const sweepFailed = (error: Error) => console.error('[chunk-sweep] failed', error?.name, String(error?.message ?? '').slice(0, 200));
const sweep = () => void sweepUploadChunks().then(removed => { if (removed) console.info('[chunk-sweep] removed', removed); }, sweepFailed)
  .then(() => sweepAnalysisRequests()).then(removed => { if (removed) console.info('[chunk-sweep] removed analysis requests', removed); }, sweepFailed);
const sweepStart = worker.status().scope === 'main' ? setTimeout(sweep, 5 * 60_000) : undefined;
const sweepTimer = worker.status().scope === 'main' ? setInterval(sweep, 3600_000) : undefined;
try { await stopped; clearInterval(recycleTimer); clearInterval(alarmTimer); clearTimeout(sweepStart); clearInterval(sweepTimer); await Promise.all([worker.close(), listingWorker.close(), backup.close()]); }
finally { health?.close(); await closeCatalogDatabase(); }
if (recycling) process.exit(75);
