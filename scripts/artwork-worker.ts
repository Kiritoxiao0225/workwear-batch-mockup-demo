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
const worker = await startBatchWorker();
const { startGarmentWorker } = await import('../lib/server/garment-mockup-ai');
const garmentWorker = await startGarmentWorker();
const { startOffsiteBackup } = await import('../lib/server/catalog-offsite-backup');
const backup = startOffsiteBackup();
const health = process.env.PORT ? createServer((_request, response) => {
  const status = worker.status();
  const databaseBackup = backup.status();
  response.writeHead(status.ready && databaseBackup.ready ? 200 : 503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ ...status, workflow: 'batch', legacyEnabled: false, databaseBackup,
    logicVersion: WORKWEAR_LOGIC_VERSION, commit: process.env.WORKWEAR_BUILD_COMMIT ?? null, objectStore }));
}).listen(Number(process.env.PORT), '0.0.0.0') : undefined;
console.log('[batch-worker] ready:', worker.status().scope, 'legacy worker disabled');
try { await stopped; await worker.close(); await garmentWorker.close(); await backup.close(); }
finally { health?.close(); await closeCatalogDatabase(); }
