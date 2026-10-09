/**
 * The 电商主图 page's calls to /api/listing. On the local demo page (/listing-demo, never in a
 * production build) the same calls are answered by ./demo/api from fixed data, so the page can be
 * tried without the server, a database or paid model calls.
 */
export const isDemo = () => process.env.NODE_ENV !== 'production' && typeof window !== 'undefined' && window.location.pathname.startsWith('/listing-demo');

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (isDemo()) { const { demoApi } = await import('./demo/api'); return demoApi(path, init) as Promise<T>; }
  const response = await fetch('/api/listing/' + path, { cache: 'no-store', ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body as T;
}
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
/** An uploaded or generated image. */
export const assetUrl = (id: string) => isDemo() ? `/listing-demo/${id}` : `/api/listing/assets/${id}`;
export const downloadUrl = (projectId: string) => isDemo() ? '#demo-download' : `/api/listing/projects/${projectId}/download`;
