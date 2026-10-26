import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Agent, EnvHttpProxyAgent, getGlobalDispatcher } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLongRequests, LONGEST_REQUEST_MS, waitUpTo } from './long-request';
import { PLAN_TIMEOUT_MS, RELAY_TIMEOUT_MS } from './listing-provider';

const ROOT = path.resolve(__dirname, '../..');
/** Timeouts written as a name: what they come to. A new name fails the check until it is added here. */
const NAMED: Record<string, number> = {
  PLAN_TIMEOUT_MS,
  // batch-mockup/adapters/production-images.mjs, the 图稿 relay (read off the file: importing it loads the whole engine).
  RELAY_WAIT_MS: Number(readFileSync(path.join(ROOT, 'batch-mockup/adapters/production-images.mjs'), 'utf8').match(/RELAY_WAIT_MS = ([\d_]+)/)![1].replace(/_/g, '')),
  // cliproxy-image-2.ts: the caller's timeoutMs, RELAY_TIMEOUT_MS from listing-provider (else 300 s).
  wait: Math.max(RELAY_TIMEOUT_MS, 300_000),
  // wps-spreadsheet.ts wpsJson: 30 s unless a caller passes more (none does).
  timeoutMs: 30_000,
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const file = path.join(dir, name);
    if (['node_modules', 'tests', '.next', '.next-catalog'].includes(name)) return [];
    if (statSync(file).isDirectory()) return sources(file);
    return /\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name) ? [file] : [];
  });
}
/** Every `AbortSignal.timeout(…)` in the server code, with where it is. */
function timeouts() {
  const found: { where: string; arg: string }[] = [];
  for (const file of [...['lib', 'app', 'batch-mockup', 'scripts'].flatMap(d => sources(path.join(ROOT, d))), path.join(ROOT, 'instrumentation.ts')]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/AbortSignal\.timeout\(((?:[^()]|\([^()]*\))*)\)/g))
      found.push({ where: `${path.relative(ROOT, file)}:${text.slice(0, m.index).split('\n').length}`, arg: m[1].trim() });
  }
  return found;
}

describe("Node fetch's 300 s (10-26)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('no timeout in the code is longer than the processes let a request wait', () => {
    const list = timeouts();
    expect(list.length).toBeGreaterThan(20);
    const over = list.flatMap(({ where, arg }) => {
      const numbers = [...arg.matchAll(/\d[\d_]*/g)].map(n => Number(n[0].replace(/_/g, '')));
      const names = [...arg.matchAll(/\b[A-Za-z_]\w*\b/g)].map(n => n[0]).filter(n => !['method', 'DELETE', 'HEAD'].includes(n));
      const unknown = names.filter(n => !(n in NAMED));
      if (unknown.length) return [`${where}: ${arg}（新的超时写法，加进 long-request.test.ts 的 NAMED）`];
      const longest = Math.max(0, ...numbers, ...names.map(n => NAMED[n]));
      return longest > LONGEST_REQUEST_MS ? [`${where}: ${arg} 超过 ${LONGEST_REQUEST_MS / 1000} 秒，要么调大 LONGEST_REQUEST_MS，要么这一处传 dispatcher: waitUpTo(…)`] : [];
    });
    expect(over).toEqual([]);
  });

  it('the web server and the workers raise the limit when they start', () => {
    for (const entry of ['instrumentation.ts', 'scripts/artwork-worker.ts'])
      expect(readFileSync(path.join(ROOT, entry), 'utf8'), entry).toContain('installLongRequests()');
    installLongRequests();
    expect(getGlobalDispatcher()).toBe(waitUpTo(LONGEST_REQUEST_MS));
  });

  it('goes through the proxy on this Mac (NODE_USE_ENV_PROXY=1), straight elsewhere', () => {
    vi.stubEnv('NODE_USE_ENV_PROXY', '1'); vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:9');
    expect(waitUpTo(12_345)).toBeInstanceOf(EnvHttpProxyAgent);
    vi.stubEnv('NODE_USE_ENV_PROXY', '');
    expect(waitUpTo(12_346)).toBeInstanceOf(Agent);
  });
});
