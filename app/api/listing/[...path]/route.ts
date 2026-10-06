import { NextRequest, NextResponse } from 'next/server';
import { tenantScope } from '@/lib/server/tenant-scope';
import { catalogBody, catalogError } from '@/lib/server/catalog-http';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { assertPageAccess } from '@/lib/server/page-access';
import { addSourceImage, chooseVersion, createProject, deleteProject, listProjects, MAX_SOURCE_BYTES, projectDetail, readListingAsset } from '@/lib/server/listing-store';
import { addExtraImage, imagePrices, planPrice, requestPlan, submitDraft } from '@/lib/server/listing-jobs';
import { addSet, downloadZip, redoSlot, slotStates } from '@/lib/server/listing-generation';
import { addLayoutRef, createLayout, deleteLayout, layoutCards, layoutFile, layoutState, openLayouts, saveLayout, startLearning } from '@/lib/server/listing-layouts';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const header = (request: NextRequest, name: string) => { const v = request.headers.get(name) ?? ''; try { return decodeURIComponent(v); } catch { return v; } };

export async function GET(request: NextRequest, context: Context) {
  try {
    const { tenant, user } = await tenantScope(request), { path } = await context.params;
    await assertPageAccess(user.id, ['/listing-images']);
    if (path[0] === 'config') return json({ layouts: await layoutCards(tenant.id), learning: await openLayouts(tenant.id, user.id), planCredits: await planPrice(), ...await imagePrices(), exempt: tenant.billingMode === 'exempt' });
    if (path[0] === 'layouts' && path[1] && path[2] === 'files' && path[3] && path[4]) {
      const file = await layoutFile(tenant.id, path[1], path[3], Number(path[4]));
      return new NextResponse(new Uint8Array(file.bytes), { headers: { 'Content-Type': file.file.mime_type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (path[0] === 'layouts' && path[1]) return json(await layoutState(tenant.id, path[1]));
    if (path[0] === 'projects' && path[1] && path[2] === 'download') {
      await projectDetail(tenant.id, path[1]);
      const zip = await downloadZip(path[1]);
      return new NextResponse(new Uint8Array(zip.bytes), { headers: { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="listing-images.zip"; filename*=UTF-8''${encodeURIComponent(zip.name)}` } });
    }
    if (path[0] === 'projects' && path[1]) return json({ ...await projectDetail(tenant.id, path[1]), slots: await slotStates(path[1]) });
    if (path[0] === 'projects') return json(await listProjects(tenant.id));
    if (path[0] === 'assets' && path[1]) {
      const file = await readListingAsset(tenant.id, path[1]);
      // An asset ID always names the same bytes, so the browser may keep it.
      return new NextResponse(new Uint8Array(file.bytes), { headers: { 'Content-Type': file.file.mime_type, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } });
    }
    throw new CatalogHttpError(404, '接口不存在');
  } catch (error) { return catalogError(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const { tenant, user } = await tenantScope(request, true), { path } = await context.params;
    await assertPageAccess(user.id, ['/listing-images']);
    if (path[0] === 'layouts' && path[1] && path[2] === 'refs') {
      const bytes = await catalogBody(request, MAX_SOURCE_BYTES);
      return json(await addLayoutRef(tenant.id, path[1], bytes, header(request, 'x-file-name') || '参考图'));
    }
    if (path[0] === 'projects' && path[1] && path[2] === 'extra') {
      const bytes = await catalogBody(request, MAX_SOURCE_BYTES);
      return json(await addExtraImage(tenant.id, path[1], bytes, header(request, 'x-file-name') || '补传.jpg'));
    }
    if (path[0] === 'projects' && path[1] && path[2] === 'images') {
      const bytes = await catalogBody(request, MAX_SOURCE_BYTES);
      return json(await addSourceImage(tenant.id, path[1], bytes, header(request, 'x-file-name') || '图片', header(request, 'x-file-path')));
    }
    const body = JSON.parse((await catalogBody(request, 256 * 1024)).toString('utf8') || '{}');
    if (path[0] === 'projects' && !path[1]) return json(await createProject(tenant.id, user.id, body));
    if (path[0] === 'layouts' && !path[1]) return json(await createLayout(tenant.id, user.id, body));
    if (path[0] === 'layouts' && path[2] === 'learn') return json(await startLearning(tenant, path[1]));
    if (path[0] === 'layouts' && path[2] === 'save') return json(await saveLayout(tenant.id, path[1]));
    if (path[0] === 'projects' && path[2] === 'plan') return json(await requestPlan(tenant, user.id, path[1]));
    if (path[0] === 'projects' && path[2] === 'start') return json(await submitDraft(tenant, user.id, path[1], body));
    if (path[0] === 'projects' && path[2] === 'sets') return json(await addSet(tenant, user.id, path[1], body));
    if (path[0] === 'projects' && path[2] === 'redo') {
      return json(await redoSlot(tenant, user.id, path[1], String(body.slot ?? ''), String(body.note ?? ''),
        { mode: body.mode === 'text' ? 'text' : 'redraw', words: body.words, base: typeof body.base === 'string' ? body.base : undefined, colors: body.colors }));
    }
    if (path[0] === 'projects' && path[2] === 'current') {
      await projectDetail(tenant.id, path[1]);
      return json(await chooseVersion(tenant.id, path[1], String(body.slot ?? ''), String(body.asset ?? '')));
    }
    throw new CatalogHttpError(404, '接口不存在');
  } catch (error) { return catalogError(error); }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { tenant, user } = await tenantScope(request, true), { path } = await context.params;
    await assertPageAccess(user.id, ['/listing-images']);
    if (path[0] === 'layouts' && path[1]) return json(await deleteLayout(tenant.id, path[1]));
    if (path[0] !== 'projects' || !path[1]) throw new CatalogHttpError(404, '接口不存在');
    return json(await deleteProject(tenant.id, path[1]));
  } catch (error) { return catalogError(error); }
}
