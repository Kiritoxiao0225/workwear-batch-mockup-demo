import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
createRequire(import.meta.url)('@next/env').loadEnvConfig(process.cwd());
const { artworkJobsEnabled, claimArtworkJob, heartbeatArtworkWorker } = await import('../lib/server/artwork-job-store');
const { processArtworkJob } = await import('../lib/server/artwork-job-worker');
const { recoverProductionRenders } = await import('../lib/server/production-render-recovery');
const { WORKWEAR_LOGIC_VERSION } = await import('../lib/artwork-reliability');
const { catalogStorageConfig } = await import('../lib/server/catalog-files');
const { catalogObjectStore } = await import('../lib/server/catalog-oss');
let renderRecovery: Promise<void> | null = null, nextRenderRecovery = 0;
const { wpsAnalysisJobsEnabled, claimWpsAnalysis, heartbeatWpsAnalysis } = await import('../lib/server/wps-analysis-jobs');
const { processWpsAnalysis, discoverWpsAnalysis } = await import('../lib/server/wps-analysis-worker');
const analysisRunning = new Set<Promise<void>>();
let discovery: Promise<void> | null = null, nextDiscovery = 0;
const { closeCatalogDatabase } = await import('../lib/server/catalog-database');
if (!artworkJobsEnabled()) throw new Error('后台需要 WPS_PRODUCTION_STORAGE=cloud 和 ARTWORK_DURABLE_JOBS=1');
if (process.env.VERCEL === '1') throw new Error('后台任务需要持续运行的服务，请勿作为 Vercel 请求执行');
const storage = catalogStorageConfig();
const objectStore = storage.backend === 'oss' ? catalogObjectStore() : storage.backend;
const owner = randomUUID(), running = new Set<Promise<void>>();
let stopping = false;
process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
await heartbeatArtworkWorker(owner);
if (wpsAnalysisJobsEnabled()) await heartbeatWpsAnalysis(owner);
let lastHeartbeat = Date.now();
const health = process.env.PORT ? createServer((_request, response) => {
  const ready = !stopping && Date.now() - lastHeartbeat < 30_000;
  response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ ready, running: running.size, logicVersion: WORKWEAR_LOGIC_VERSION, commit: process.env.WORKWEAR_BUILD_COMMIT ?? null, objectStore }));
}).listen(Number(process.env.PORT), '0.0.0.0') : undefined;
console.log('[artwork-worker] ready: generation 6, cutout 2, quality 1');
const heartbeat = setInterval(() => { void Promise.all([heartbeatArtworkWorker(owner), ...(wpsAnalysisJobsEnabled() ? [heartbeatWpsAnalysis(owner)] : [])]).then(() => { lastHeartbeat = Date.now(); }).catch(error => console.error('[artwork-worker] heartbeat failed', error instanceof Error ? error.name : 'Error')); }, 10_000);
try {
  while (!stopping) {
    if (!renderRecovery && Date.now() >= nextRenderRecovery) {
      nextRenderRecovery = Date.now() + 30_000;
      renderRecovery = recoverProductionRenders(2).then(() => undefined)
        .catch(error => console.error('[render-recovery]', error instanceof Error ? error.name : 'Error'))
        .finally(() => { renderRecovery = null; });
    }
    if (wpsAnalysisJobsEnabled()) {
      if (!discovery && Date.now() >= nextDiscovery) {
        nextDiscovery = Date.now() + 30_000;
        discovery = discoverWpsAnalysis(owner).catch(error => console.error('[wps-analysis-discovery]', error instanceof Error ? error.message : 'Error')).finally(() => { discovery = null; });
      }
      if (analysisRunning.size < 5) {
        const analysis = await claimWpsAnalysis(owner).catch(error => { console.error('[wps-analysis-claim]', error instanceof Error ? error.message : 'Error'); return null; });
        if (analysis) {
          const work = processWpsAnalysis(analysis).catch(error => console.error('[wps-analysis-worker]', error instanceof Error ? error.message : 'Error')).finally(() => analysisRunning.delete(work));
          analysisRunning.add(work);
        }
      }
    }
    if (running.size >= 24) { await delay(500); continue; }
    const job = await claimArtworkJob(owner).catch(error => { console.error('[artwork-worker] claim failed', error instanceof Error ? error.name : 'Error'); return null; });
    if (!job) { await delay(1000); continue; }
    const work = processArtworkJob(job).catch(error => console.error('[artwork-worker] job interrupted', { id: job.id, name: error instanceof Error ? error.name : 'Error' })).finally(() => running.delete(work));
    running.add(work);
  }
  await Promise.allSettled([...running, ...analysisRunning, ...(discovery ? [discovery] : []), ...(renderRecovery ? [renderRecovery] : [])]);
} finally { health?.close(); clearInterval(heartbeat); await closeCatalogDatabase(); }
