import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
createRequire(import.meta.url)('@next/env').loadEnvConfig(process.cwd());
const { artworkJobsEnabled, claimArtworkJob, heartbeatArtworkWorker } = await import('../lib/server/artwork-job-store');
const { processArtworkJob } = await import('../lib/server/artwork-job-worker');
const { closeCatalogDatabase } = await import('../lib/server/catalog-database');
if (!artworkJobsEnabled()) throw new Error('后台需要 WPS_PRODUCTION_STORAGE=cloud 和 ARTWORK_DURABLE_JOBS=1');
if (process.env.VERCEL === '1') throw new Error('后台任务需要持续运行的服务，请勿作为 Vercel 请求执行');
const owner = randomUUID(), running = new Set<Promise<void>>();
let stopping = false;
process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
await heartbeatArtworkWorker(owner);
let lastHeartbeat = Date.now();
const health = process.env.PORT ? createServer((_request, response) => {
  const ready = !stopping && Date.now() - lastHeartbeat < 30_000;
  response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ ready, running: running.size }));
}).listen(Number(process.env.PORT), '0.0.0.0') : undefined;
console.log('[artwork-worker] ready: generation 6, cutout 2, quality 1');
const heartbeat = setInterval(() => { void heartbeatArtworkWorker(owner).then(() => { lastHeartbeat = Date.now(); }).catch(error => console.error('[artwork-worker] heartbeat failed', error instanceof Error ? error.name : 'Error')); }, 10_000);
try {
  while (!stopping) {
    if (running.size >= 24) { await delay(500); continue; }
    const job = await claimArtworkJob(owner).catch(error => { console.error('[artwork-worker] claim failed', error instanceof Error ? error.name : 'Error'); return null; });
    if (!job) { await delay(1000); continue; }
    const work = processArtworkJob(job).catch(error => console.error('[artwork-worker] job interrupted', { id: job.id, name: error instanceof Error ? error.name : 'Error' })).finally(() => running.delete(work));
    running.add(work);
  }
  await Promise.allSettled([...running]);
} finally { health?.close(); clearInterval(heartbeat); await closeCatalogDatabase(); }
