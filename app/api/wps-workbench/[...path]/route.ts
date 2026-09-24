import { NextRequest, NextResponse } from 'next/server';
import { internalScope } from '@/lib/server/tenant-scope';
import { catalogBody, catalogError } from '@/lib/server/catalog-http';
import { wpsWorkbenchPaths, wpsWorkbenchSource } from '@/lib/wps-workbench-paths';
import { GET as batchGet, POST as batchPost } from '@/app/api/batch/[...path]/route';
import { GET as catalogFile } from '@/app/api/catalog/files/[id]/route';
import { GET as productionFile } from '@/app/api/production-files/[id]/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;
type Context = { params: Promise<{ path: string[] }> };
const localWorkbenchFiles = new Set(['ui', 'preview-tone.mjs', 'compact-layout.css', 'mockup-save.mjs',
  'requirements-editor.mjs', 'repair-editor.mjs', 'repair-editor.css', 'repair-pixels.mjs',
  'mockup-editor.mjs', 'mockup-editor.css']);
const pendingRequirementReads = new Map<string, Promise<Response>>();

async function compatibilityFetch(url: URL, init: RequestInit) {
  // The original UI polls while a read is still running. Share only concurrent list reads,
  // after authorization; never cache a completed response or merge writes/editor requests.
  if (init.method !== 'GET' || url.pathname !== '/api/batch/api/requirements') return fetch(url, init);
  const key = url.href;
  let pending = pendingRequirementReads.get(key);
  if (!pending) {
    pending = fetch(url, init).then(async response => new Response(await response.arrayBuffer(), {
      status: response.status, headers: response.headers,
    })).finally(() => pendingRequirementReads.delete(key));
    pendingRequirementReads.set(key, pending);
  }
  return (await pending).clone();
}

async function handle(request: NextRequest, context: Context) {
  try {
    const write = request.method !== 'GET';
    // WPS is the internal delivery workspace, never a tenant-selected proxy target.
    await internalScope(request, write);
    const { path } = await context.params;
    if (path.some(part => !part || part === '..' || part === '.' || /[\\/]/.test(part))) {
      return NextResponse.json({ error: '无效的 WPS 地址' }, { status: 400 });
    }
    const fileKind = ['catalog-files', 'production-files'].includes(path[0]) ? path[0] : null;
    if (fileKind && (write || path.length !== 2 || !/^[0-9a-f-]{36}$/.test(path[1]))) {
      return NextResponse.json({ error: '图片地址无效' }, { status: 400 });
    }
    const upstreamPath = fileKind === 'catalog-files' ? `/api/catalog/files/${path[1]}`
      : fileKind === 'production-files' ? `/api/production-files/${path[1]}`
        : `/api/batch/${path.map(encodeURIComponent).join('/')}`;
    const compatibilityOrigin = process.env.WPS_LOCAL_COMPAT_ORIGIN;
    const body = write ? JSON.stringify(wpsWorkbenchPaths(JSON.parse((await catalogBody(request, 4 * 1024 * 1024)).toString('utf8')), true)) : undefined;
    let response: Response;
    if (!write && path.length === 1 && localWorkbenchFiles.has(path[0])) {
      // The page and editors belong to this application. Only production data needs compatibility.
      response = await batchGet(request, context);
    } else if (compatibilityOrigin) {
      // Local SaaS development uses schema 020; the original delivery service still uses 016.
      // Keep its API behind this app's internal-account checks until the coordinated release.
      const origin = new URL(compatibilityOrigin);
      if (process.env.NODE_ENV !== 'development' || origin.protocol !== 'http:' ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
          origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
          origin.origin === request.nextUrl.origin) throw new Error('WPS 本地兼容服务配置无效');
      response = await compatibilityFetch(new URL(upstreamPath + request.nextUrl.search, origin), {
        method: request.method,
        headers: write ? { 'Content-Type': 'application/json', Origin: origin.origin, 'x-wps-workbench': '1' } : { 'x-wps-workbench': '1' },
        body,
        redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(180_000),
      });
    } else {
      const nativeHeaders = new Headers(request.headers);
      nativeHeaders.delete('content-length');
      nativeHeaders.set('x-wps-workbench', '1');
      const nativeRequest = new NextRequest(new URL(upstreamPath + request.nextUrl.search, request.url), { method: request.method, headers: nativeHeaders, body });
      response = fileKind === 'catalog-files' ? await catalogFile(nativeRequest, { params: Promise.resolve({ id: path[1] }) })
        : fileKind === 'production-files' ? await productionFile(nativeRequest, { params: Promise.resolve({ id: path[1] }) })
          : await (write ? batchPost : batchGet)(nativeRequest, context);
    }
    const headers = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    headers.set('Content-Type', contentType);
    // Batch assets are immutable: their storage writer rejects replacing a path with
    // different bytes. Keep the original private browser cache for these images;
    // polling must not download every unchanged PNG again. State and errors stay fresh.
    const batchAsset = /^(assets|confirmed-assets|production-assets|production-results|supplements|wps-assets|mockup-assets|mockup-results)\/[a-zA-Z0-9_./-]+$/.test(path.join('/'));
    if (!write && response.status === 200 && batchAsset && contentType.startsWith('image/')) {
      headers.set('Cache-Control', 'private, max-age=86400, immutable');
    }
    const location = response.headers.get('location');
    if (location) {
      // Signed object-storage redirects are images only; never send the page to a legacy UI.
      if (!fileKind || !location.startsWith('https://')) throw new Error('WPS 服务返回了意外跳转');
      headers.set('Location', location);
    }
    if (contentType.includes('application/json')) {
      return NextResponse.json(wpsWorkbenchPaths(await response.json()), { status: response.status, headers });
    }
    if (/text\/html|javascript|text\/css/.test(contentType)) {
      headers.set('Content-Security-Policy', "frame-ancestors 'self'");
      return new Response(wpsWorkbenchSource(await response.text()), { status: response.status, headers });
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) { return catalogError(error); }
}

export const GET = handle;
export const POST = handle;
