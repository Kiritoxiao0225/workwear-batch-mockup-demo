/**
 * The 电商主图 page's calls to /api/listing. On the local demo page (/listing-demo, never in a
 * production build) the same calls are answered by ./demo/api from fixed data, so the page can be
 * tried without the server, a database or paid model calls.
 */
import type { SlotState } from './api-types';

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
export const assetUrl = (id: string) => isDemo() ? (id.startsWith('/') ? id : `/listing-demo/${id}`) : `/api/listing/assets/${id}`;
export const downloadUrl = (projectId: string) => isDemo() ? '#demo-download' : `/api/listing/projects/${projectId}/download`;

/**
 * 「点图修改」 on one image of a product (or of the shop): uploads the reference image if any, asks
 * for the redraw and waits for it (about 40 seconds). Resolves to the new version, not yet adopted.
 */
export async function redrawImage(projectId: string, slot: string, ask: string, file: File | null): Promise<{ id: string; url: string }> {
  const reference = file ? (await api<{ asset: string }>(`projects/${projectId}/refs`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) } })).asset : undefined;
  const { job } = await post<{ job: string }>(`projects/${projectId}/redraw`, { slot, ask, reference });
  for (let i = 0; i < 160; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const s = (await api<{ slots: SlotState[] }>(`projects/${projectId}`)).slots.find(x => x.slot === slot);
    if (s?.redraw?.job !== job || s.redraw.status === 'running') continue;
    if (s.redraw.status === 'failed') throw new Error(s.redraw.error || '没生成出来，没扣积分，可以再试一次');
    const made = s.history.find(v => v.job === job);
    if (made) return { id: made.id, url: assetUrl(made.id) };
  }
  throw new Error('等太久了，关掉这个窗口过一会儿再点开看看');
}
