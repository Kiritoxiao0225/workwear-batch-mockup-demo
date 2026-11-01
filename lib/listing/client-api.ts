/**
 * The 电商主图 page's calls to /api/listing. On the local demo page (/listing-demo, never in a
 * production build) the same calls are answered by ./demo/api from fixed data, so the page can be
 * tried without the server, a database or paid model calls.
 */
import type { SlotState } from './api-types';
import { shrink } from './shrink';

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
export const assetUrl = (id: string) => isDemo() ? (id.startsWith('/') || id.startsWith('blob:') ? id : `/listing-demo/${id}`) : `/api/listing/assets/${id}`;
export const downloadUrl = (projectId: string) => isDemo() ? '#demo-download' : `/api/listing/projects/${projectId}/download`;

/**
 * 「点图修改」 on one image of a product (or of the shop): uploads the reference images if any (made
 * small first: a phone original is slow and may pass the upload limit) and asks for the redraw. It
 * is made in the background; the image's `redraw` says how it goes.
 */
export async function askRedraw(projectId: string, slot: string, ask: string, files: File[]): Promise<string> {
  // Several since 11-01 (up to 4), in the order the user put them; each is framed in the browser first if they asked.
  const references = await Promise.all(files.map(async file => (await api<{ asset: string }>(`projects/${projectId}/refs`, { method: 'POST', body: await shrink(file), headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) } })).asset));
  return (await post<{ job: string }>(`projects/${projectId}/redraw`, { slot, ask, ...(references.length ? { references } : {}) })).job;
}
/** {@link askRedraw}, then waits for it (about 40 seconds, longer in a queue). Resolves to the new version, not yet adopted. */
export async function redrawImage(projectId: string, slot: string, ask: string, files: File[]): Promise<{ id: string; url: string }> {
  const job = await askRedraw(projectId, slot, ask, files);
  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const s = (await api<{ slots: SlotState[] }>(`projects/${projectId}`)).slots.find(x => x.slot === slot);
    if (s?.redraw?.job !== job || s.redraw.status === 'queued' || s.redraw.status === 'running') continue;
    if (s.redraw.status === 'failed') throw new Error(s.redraw.error || '没生成出来，没扣积分，可以再试一次');
    const made = s.history.find(v => v.job === job);
    if (made) return { id: made.id, url: assetUrl(made.id) };
  }
  throw new Error('等太久了，关掉这个窗口过一会儿再点开看看');
}

/** What a liner image added on the plan is (10-22): its material and colour, so the plan counts it as that liner worn alone. */
export type LinerTag = { inner: string; color: string };
/**
 * Draws one image for the plan before anything is made (10-22, a liner colour the material lacks):
 * from the user's own words and the images they ticked (`refs`, material labels; `assets`, references
 * uploaded for it). Charged as one image; waits for it (about 40 seconds). Not part of the material
 * until adopted.
 */
export async function drawMaterial(projectId: string, prompt: string, refs: string[], assets: string[] = []): Promise<{ asset: string; url: string }> {
  const { job } = await post<{ job: string }>(`projects/${projectId}/draw`, { prompt, refs, assets });
  for (let i = 0; i < 160; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const s = await api<{ status: string; error: string | null; asset: string | null }>(`projects/${projectId}/draws/${job}`);
    if (s.status === 'succeeded' && s.asset) return { asset: s.asset, url: assetUrl(s.asset) };
    if (s.status === 'failed' || s.status === 'unknown') throw new Error(s.error || '没生成出来，没扣积分，可以再试一次');
  }
  throw new Error('还在生成，过一会儿再看');
}
/** A drawn image taken into the material as a liner worn alone; resolves to its label. */
export const adoptDrawn = (projectId: string, asset: string, liner: LinerTag) => post<{ label: string; url: string }>(`projects/${projectId}/adopt`, { asset, ...liner });
