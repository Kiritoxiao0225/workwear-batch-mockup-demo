import { Agent, EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici';

/**
 * Node's fetch gives up after 300 s without response headers (or between two pieces of the body),
 * whatever its AbortSignal allows. Fixed one call at a time it came back three times: 整理素材 cut at
 * about two minutes (10-13), the 图稿 relay past five minutes (10-24), and the last part of a
 * 204-photo 整理 (10-26, six times in a row). So every process now raises it once when it starts
 * (`installLongRequests`): a request lasts as long as its own signal says, up to LONGEST_REQUEST_MS.
 * One that may take longer passes `waitUpTo(ms)` as its `dispatcher`. long-request.test.ts checks
 * every timeout in the code against this.
 */
export const LONGEST_REQUEST_MS = 600_000;

const agents = new Map<number, Dispatcher>();
/**
 * A dispatcher that waits up to `ms` for headers and between body pieces. With NODE_USE_ENV_PROXY=1
 * (this Mac) it goes through HTTP(S)_PROXY as Node's own fetch would; a plain Agent went around the
 * proxy, so local scripts calling the relay failed as 「连接中断或超时」.
 */
export function waitUpTo(ms: number): Dispatcher {
  let agent = agents.get(ms);
  if (!agent) agents.set(ms, agent = process.env.NODE_USE_ENV_PROXY === '1'
    ? new EnvHttpProxyAgent({ headersTimeout: ms, bodyTimeout: ms })
    : new Agent({ headersTimeout: ms, bodyTimeout: ms }));
  return agent;
}

/** Called once at the start of every server process (instrumentation.ts, scripts/artwork-worker.ts). */
export function installLongRequests() {
  setGlobalDispatcher(waitUpTo(LONGEST_REQUEST_MS));
}
