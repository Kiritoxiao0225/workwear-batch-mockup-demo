import { NextRequest, NextResponse } from 'next/server';
import { tenantScope } from '@/lib/server/tenant-scope';
import { catalogBody, catalogError } from '@/lib/server/catalog-http';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { assertPageAccess } from '@/lib/server/page-access';
import { addSourceImage, chooseVersion, confirmProject, createProject, deleteProject, listProjects, MAX_SOURCE_BYTES, projectDetail, readListingAsset, saveReview } from '@/lib/server/listing-store';
import { imagePrices, planPrice, requestPlan } from '@/lib/server/listing-jobs';
import { downloadZip, estimate, redoSlot, slotStates, startGeneration } from '@/lib/server/listing-generation';
import { LISTING_LAYOUTS } from '@/lib/listing/layouts';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const header = (request: NextRequest, name: string) => { const v = request.headers.get(name) ?? ''; try { return decodeURIComponent(v); } catch { return v; } };

export async function GET(request: NextRequest, context: Context) {
  try {
    const { tenant, user } = await tenantScope(request), { path } = await context.params;
    await assertPageAccess(user.id, ['/listing-images']);
    if (path[0] === 'config') return json({ layouts: LISTING_LAYOUTS, planCredits: await planPrice(), ...await imagePrices(), exempt: tenant.billingMode === 'exempt' });
    if (path[0] === 'projects' && path[1] && path[2] === 'download') {
      await projectDetail(tenant.id, path[1]);
      const zip = await downloadZip(path[1]);
      return new NextResponse(new Uint8Array(zip.bytes), { headers: { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="listing-images.zip"; filename*=UTF-8''${encodeURIComponent(zip.name)}` } });
    }
    if (path[0] === 'projects' && path[1]) {
      const detail = await projectDetail(tenant.id, path[1]);
      const priced = ['review', 'confirmed'].includes(detail.status) && detail.plan ? await estimate(detail.plan as never, detail.review, detail.counts).catch(() => null) : null;
      return json({ ...detail, estimate: priced, slots: await slotStates(path[1]) });
    }
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
    if (path[0] === 'projects' && path[1] && path[2] === 'images') {
      const bytes = await catalogBody(request, MAX_SOURCE_BYTES);
      return json(await addSourceImage(tenant.id, path[1], bytes, header(request, 'x-file-name') || '图片', header(request, 'x-file-path')));
    }
    const body = JSON.parse((await catalogBody(request, 256 * 1024)).toString('utf8') || '{}');
    if (path[0] === 'projects' && !path[1]) return json(await createProject(tenant.id, user.id, body));
    if (path[0] === 'projects' && path[2] === 'plan') return json(await requestPlan(tenant, user.id, path[1]));
    if (path[0] === 'projects' && path[2] === 'review') return json(await saveReview(tenant.id, path[1], body));
    if (path[0] === 'projects' && path[2] === 'confirm') return json(await confirmProject(tenant.id, path[1]));
    if (path[0] === 'projects' && path[2] === 'generate') return json(await startGeneration(tenant, user.id, path[1]));
    if (path[0] === 'projects' && path[2] === 'redo') {
      return json(await redoSlot(tenant, user.id, path[1], String(body.slot ?? ''), String(body.note ?? ''),
        { mode: body.mode === 'text' ? 'text' : 'redraw', words: body.words, base: typeof body.base === 'string' ? body.base : undefined }));
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
    if (path[0] !== 'projects' || !path[1]) throw new CatalogHttpError(404, '接口不存在');
    return json(await deleteProject(tenant.id, path[1]));
  } catch (error) { return catalogError(error); }
}
