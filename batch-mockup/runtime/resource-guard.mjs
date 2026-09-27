import { existsSync, readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
const MiB = 1024 ** 2;
function positive(value, fallback) {
 const n = Number(value ?? fallback);
 if (!Number.isFinite(n) || n <= 0) throw Error('Worker memory thresholds must be positive');
 return n;
}
export function systemMemory() {
 if (process.platform !== 'linux') return { available: freemem(), total: totalmem() };
 const text = readFileSync('/proc/meminfo', 'utf8');
 const available = Number(text.match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024;
 const total = Number(text.match(/^MemTotal:\s+(\d+)/m)?.[1]) * 1024;
 if (!Number.isFinite(available) || !total) throw Error('Host memory unavailable');
 return { available, total };
}
export function createAdmissionGate({
 sample = () => ({ ...systemMemory(), rss: process.memoryUsage().rss }),
 draining = () => existsSync('/tmp/batch-worker-drain'),
 rssMiB = positive(process.env.BATCH_WORKER_RSS_PAUSE_MB, 1536),
 reserveMiB = positive(process.env.BATCH_WORKER_HOST_RESERVE_MB, 1024),
} = {}) {
 let memoryPaused = false, status = { paused: false, reason: null };
 return {
  check() {
   if (draining()) return status = { ...status, paused: true, reason: 'deployment_drain' };
   try {
    const { available, total, rss } = sample();
    const reserve = Math.max(reserveMiB * MiB, total * .15);
    // Hysteresis avoids rapidly alternating between admission and pause.
    memoryPaused = memoryPaused ? rss > rssMiB * MiB * .8 || available < reserve * 1.25 : rss >= rssMiB * MiB || available < reserve;
    status = { paused: memoryPaused, reason: memoryPaused ? 'memory_pressure' : null,
     rssMiB: Math.round(rss / MiB), availableMiB: Math.round(available / MiB), reserveMiB: Math.round(reserve / MiB), rssPauseMiB: rssMiB };
   } catch { status = { ...status, paused: true, reason: 'memory_sample_unavailable' }; }
   return status;
  },
  status: () => status,
 };
}
