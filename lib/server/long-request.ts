import { Agent } from 'undici';

/**
 * Node's fetch gives up after 300 s without response headers, whatever its AbortSignal allows.
 * The Codex relay sends its headers only once the picture is drawn, so on a slow night every
 * image past five minutes failed as 「等待服务响应超时」 (图稿生成, 2026-10-24 01:28–02:01). Pass
 * this as `dispatcher` with the same limit as the signal.
 */
const agents = new Map<number, Agent>();
export function waitUpTo(ms: number) {
  let agent = agents.get(ms);
  if (!agent) agents.set(ms, agent = new Agent({ headersTimeout: ms, bodyTimeout: ms }));
  return agent;
}
