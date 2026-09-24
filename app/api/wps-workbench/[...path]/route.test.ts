import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { internalScope } from '@/lib/server/tenant-scope';
import { GET as batchGet } from '@/app/api/batch/[...path]/route';
import { GET, POST } from './route';
import { wpsWorkbenchPaths } from '@/lib/wps-workbench-paths';

vi.mock('@/lib/server/tenant-scope', () => ({ internalScope: vi.fn() }));
vi.mock('@/app/api/batch/[...path]/route', () => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('@/app/api/catalog/files/[id]/route', () => ({ GET: vi.fn() }));
vi.mock('@/app/api/production-files/[id]/route', () => ({ GET: vi.fn() }));
const fetchMock = vi.fn();
const request = (path: string, body?: unknown) => new NextRequest(`http://localhost:3001/api/wps-workbench/${path}`, {
  method: body ? 'POST' : 'GET', headers: { Origin: 'http://localhost:3001', Cookie: 'catalog_session=not-forwarded' },
  body: body ? JSON.stringify(body) : undefined,
});
const context = (path: string) => ({ params: Promise.resolve({ path: path.split('/') }) });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('WPS_LOCAL_COMPAT_ORIGIN', 'http://127.0.0.1:3002');
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(internalScope).mockResolvedValue({} as Awaited<ReturnType<typeof internalScope>>);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('integrated WPS workspace', () => {
  it('rejects an external tenant before forwarding any request', async () => {
    vi.mocked(internalScope).mockRejectedValue(new CatalogHttpError(403, '该功能仅限内部账号'));
    expect((await GET(request('ui'), context('ui'))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('keeps the original workbench and its asset URLs in this app', async () => {
    vi.mocked(batchGet).mockResolvedValue(new Response('<script src="/api/batch/mockup-editor.mjs"></script>', { headers: { 'Content-Type': 'text/html' } }));
    const response = await GET(request('ui'), context('ui'));
    expect(await response.text()).toContain('/api/wps-workbench/mockup-editor.mjs');
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('preserves write authorization and canonical image URLs without forwarding cookies', async () => {
    fetchMock.mockResolvedValue(Response.json({ saved: true }));
    await POST(request('api/mockups', { imageUrl: '/api/wps-workbench/catalog-files/123', revision: 4 }), context('api/mockups'));
    expect(internalScope).toHaveBeenCalledWith(expect.any(NextRequest), true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:3002/api/batch/api/mockups');
    expect(init.headers).toEqual({ Origin: 'http://127.0.0.1:3002', 'Content-Type': 'application/json', 'x-wps-workbench': '1' });
    expect(JSON.parse(init.body)).toEqual({ imageUrl: '/api/catalog/files/123', revision: 4 });
  });
  it('retains private caching for immutable batch images after authorization', async () => {
    const path = 'mockup-results/card/version.png';
    const bytes = new Uint8Array([137, 80, 78, 71]);
    fetchMock.mockResolvedValue(new Response(bytes, { headers: { 'Content-Type': 'image/png' } }));
    const response = await GET(request(path), context(path));
    expect(internalScope).toHaveBeenCalledWith(expect.any(NextRequest), false);
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400, immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
  it.each([
    ['api/requirements', 200, 'application/json', '{"cases":[]}'],
    ['mockup-results/card/version.png', 404, 'image/png', 'missing'],
    ['catalog-files/00000000-0000-0000-0000-000000000001', 200, 'image/png', 'file'],
  ])('does not cache state, failed images or unrelated file endpoints: %s', async (path, status, contentType, body) => {
    fetchMock.mockResolvedValue(new Response(body, { status, headers: { 'Content-Type': contentType } }));
    expect((await GET(request(path), context(path))).headers.get('cache-control')).toBe('private, no-store');
  });
  it('does not serve or cache an immutable image to an unauthorized user', async () => {
    vi.mocked(internalScope).mockRejectedValue(new CatalogHttpError(403, '该功能仅限内部账号'));
    const path = 'mockup-results/card/version.png';
    const response = await GET(request(path), context(path));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).not.toContain('immutable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['https://remote.example', 'http://localhost:3001', 'http://127.0.0.1:3002/other'])('rejects invalid compatibility targets %s', async origin => {
    vi.stubEnv('WPS_LOCAL_COMPAT_ORIGIN', origin);
    expect((await GET(request('api/requirements'), context('api/requirements'))).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('never enables the local compatibility service in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect((await GET(request('api/requirements'), context('api/requirements'))).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('uses the current application backend after the coordinated database migration', async () => {
    vi.stubEnv('WPS_LOCAL_COMPAT_ORIGIN', '');
    vi.mocked(batchGet).mockResolvedValue(Response.json({ imageUrl: '/api/catalog/files/abc', cases: [] }));
    const response = await GET(request('api/requirements'), context('api/requirements'));
    expect(await response.json()).toEqual({ imageUrl: '/api/wps-workbench/catalog-files/abc', cases: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(batchGet).mock.calls[0][0].url).toBe('http://localhost:3001/api/batch/api/requirements');
    expect(vi.mocked(batchGet).mock.calls[0][0].headers.get('x-wps-workbench')).toBe('1');
  });
  it('does not navigate users to an upstream login or old page', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 307, headers: { Location: '/login' } }));
    expect((await GET(request('api/requirements'), context('api/requirements'))).status).toBe(500);
  });
  it('shares concurrent list reads but starts a fresh read after completion', async () => {
    let complete!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { complete = resolve; }));
    const reads = [GET(request('api/requirements'), context('api/requirements')), GET(request('api/requirements'), context('api/requirements'))];
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    complete(Response.json({ cases: [{ caseId: 'D08' }] }));
    const responses = await Promise.all(reads);
    expect(await Promise.all(responses.map(response => response.json()))).toEqual([
      { cases: [{ caseId: 'D08' }] }, { cases: [{ caseId: 'D08' }] },
    ]);
    fetchMock.mockResolvedValueOnce(Response.json({ cases: [] }));
    expect(await (await GET(request('api/requirements'), context('api/requirements'))).json()).toEqual({ cases: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('round-trips saved editor image URLs without altering image data or requirement prose', () => {
    const draft = { sourceUrl: '/api/batch/assets/a.png', extra: ['/api/production-files/123'], requirement: '见 /api/batch/ 的原稿', png: 'data:image/png;base64,abc' };
    expect(wpsWorkbenchPaths(wpsWorkbenchPaths(draft), true)).toEqual(draft);
    expect(wpsWorkbenchPaths(draft).requirement).toBe(draft.requirement);
  });
});
