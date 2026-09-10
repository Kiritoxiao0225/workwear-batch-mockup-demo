import { artworkNetworkFailure } from './artwork-network-error';

export const ARTWORK_INSPECTION_ATTEMPTS = 3;
export const ARTWORK_INSPECTION_BUDGET_MS = 180_000;
export type InspectionRetryNotice = { attempt: number; maxAttempts: number; delayMs: number };

export function transientArtworkInspectionFailure(error: unknown) {
  const status = error && typeof error === 'object' && 'httpStatus' in error ? error.httpStatus : undefined;
  if (typeof status === 'number') return [408, 429, 500, 502, 503, 504].includes(status);
  const network = artworkNetworkFailure(error);
  if (!network) return false;
  // Configuration, DNS-name and certificate errors will not improve by repeating them.
  return !network.codes.some(code => ['ENOTFOUND', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code));
}

/** Retry the read-only inspection request, never generation, cutout, or a valid rejected verdict. */
export async function retryArtworkInspection<T>(work: (timeoutMs: number) => Promise<T>, options: {
  timeoutMs?: number; onRetry?: (notice: InspectionRetryNotice) => Promise<void> | void;
} = {}) {
  const started = Date.now();
  let lastError: unknown;
  const exhausted = (attempts: number) => Object.assign(new Error(lastError instanceof Error ? lastError.message : '内容核对请求失败', { cause: lastError }), { inspectionAttempts: attempts });
  for (let attempt = 1; ; attempt++) {
    const remainingMs = ARTWORK_INSPECTION_BUDGET_MS - (Date.now() - started);
    if (remainingMs <= 0) throw exhausted(attempt - 1);
    try {
      return { value: await work(Math.min(options.timeoutMs ?? 120_000, remainingMs)), attempts: attempt };
    } catch (error) {
      if (!transientArtworkInspectionFailure(error)) throw error;
      lastError = error;
      const retryAfter = error && typeof error === 'object' && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number' ? error.retryAfterMs : 0;
      const delayMs = Math.max(retryAfter, (attempt === 1 ? 2000 : 5000) + Math.floor(Math.random() * 500));
      if (attempt >= ARTWORK_INSPECTION_ATTEMPTS || Date.now() - started + delayMs + 1000 >= ARTWORK_INSPECTION_BUDGET_MS) {
        throw exhausted(attempt);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (Date.now() - started >= ARTWORK_INSPECTION_BUDGET_MS) throw exhausted(attempt);
      // Recheck durable ownership after the backoff, immediately before a new request.
      await options.onRetry?.({ attempt: attempt + 1, maxAttempts: ARTWORK_INSPECTION_ATTEMPTS, delayMs });
    }
  }
}
