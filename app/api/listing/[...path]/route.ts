import { NextRequest, NextResponse } from 'next/server';
import { tenantScope } from '@/lib/server/tenant-scope';
import { catalogBody, catalogError } from '@/lib/server/catalog-http';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { assertPageAccess } from '@/lib/server/page-access';
import { addReference, addSourceImage, chooseVersion, createProject, listProjects, MAX_SOURCE_BYTES, projectDetail, readListingAsset } from '@/lib/server/listing-store';
import { removeProject, REMOVE_MODES } from '@/lib/server/listing-trash';
import { addExtraImage, imagePrices, planPrice, requestPlan, submitDraft } from '@/lib/server/listing-jobs';
import { innerName } from '@/lib/listing/wear';
import { copyProject } from '@/lib/server/listing-copy';
import { addSet, adoptDrawn, downloadZip, drawMaterial, drawState, editSlot, recast, recardSkus, redoSkus, redoSlot, redrawSlot, slotStates, startVerticals, stopImages } from '@/lib/server/listing-generation';
import { createShopSet, deleteShopSet, makeServices, removeShopLogo, saveShop, saveShopBrand, saveShopCorner, saveSkuBadge, saveShopLogo, shopBrand, shopOfAsset, shopState, updateShopSet } from '@/lib/server/listing-shop';
import { cornerAssets, pasteShopLogo } from '@/lib/server/listing-corner';
import { SKU_PEOPLE } from '@/lib/listing/draft';
import { limitUploads, LISTING_UPLOAD_WINDOWS } from '@/lib/server/upload-limit';
import { addLayoutRef, createLayout, deleteLayout, layoutCards, layoutFile, layoutState, openLayouts, saveLayout, startLearning } from '@/lib/server/listing-layouts';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const header = (request: NextRequest, name: string) => { const v = request.headers.get(name) ?? ''; try { return decodeURIComponent(v); } catch { return v; } };

export async function GET(request: NextRequest, context: Context) {
  try {
    const { tenant, user } = await tenantScope(request), { path } = await context.params;
    await assertPageAccess(user.id, ['/listing-images']);
    if (path[0] === 'config') return json({ layouts: await layoutCards(tenant.id), learning: await openLayouts(tenant.id, user.id), ...await planPrice(), ...await imagePrices(), exempt: tenant.billingMode === 'exempt' });
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
    // Several shops (10-22): `?set=` names the one, none the default.
    if (path[0] === 'shop' && !path[1]) return json(await shopState(tenant.id, user.id, request.nextUrl.searchParams.get('set')));
    if (path[0] === 'projects' && path[1] && path[2] === 'draws' && path[3]) return json(await drawState(tenant.id, path[1], path[3]));
    if (path[0] === 'projects' && path[1]) return json({ ...await projectDetail(tenant.id, path[1]), slots: await slotStates(path[1]) });
    if (path[0] === 'projects') return json(await listProjects(tenant.id));
    if (path[0] === 'assets' && path[1]) {
      // A main image that kept the corner is shown with the shop's LOGO as it is now (off, or another LOGO later):
      // the browser asks again each time and gets 304 while it has not changed. Any other asset ID always names the same bytes.
      const brand = (await cornerAssets(tenant.id, [path[1]])).size ? await shopBrand(tenant.id, await shopOfAsset(tenant.id, path[1])) : undefined;
      const tag = brand === undefined ? null : `"corner-1-${brand?.id ?? 'off'}"`;
      if (tag && request.headers.get('if-none-match') === tag) return new NextResponse(null, { status: 304, headers: { ETag: tag, 'Cache-Control': 'private, no-cache' } });
      const file = await readListingAsset(tenant.id, path[1]);
      let bytes = file.bytes, pasted = !!brand;
      // Without its LOGO for now (it could not be read) the image is shown as drawn, and not kept under the tag.
      if (brand) try { bytes = await pasteShopLogo(file.bytes, await brand.bytes()); } catch (error) { pasted = false; console.error('[listing] corner logo', error instanceof Error ? error.message : error); }
      const cache: Record<string, string> = !tag ? { 'Cache-Control': 'private, max-age=31536000, immutable' } : brand && !pasted ? { 'Cache-Control': 'no-store' } : { 'Cache-Control': 'private, no-cache', ETag: tag };
      return new NextResponse(new Uint8Array(bytes), { headers: { 'Content-Type': file.file.mime_type, 'X-Content-Type-Options': 'nosniff', ...cache } });
    }
    throw new CatalogHttpError(404, '接口不存在');
  } catch (error) { return catalogError(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const { tenant, user } = await tenantScope(request, true), { path } = await context.params;
    await assertPageAccess(user.id, ['/listing-images']);
    const upload = (path[0] === 'layouts' && path[1] && path[2] === 'refs') || (path[0] === 'shop' && (path[1] === 'logo' || path[1] === 'brand'))
      || (path[0] === 'projects' && path[1] && ['refs', 'extra', 'images'].includes(path[2]));
    if (upload) await limitUploads(`upload:${tenant.id}`, LISTING_UPLOAD_WINDOWS);
    if (path[0] === 'layouts' && path[1] && path[2] === 'refs') {
      const bytes = await catalogBody(request, MAX_SOURCE_BYTES);
      return json(await addLayoutRef(tenant.id, path[1], bytes, header(request, 'x-file-name') || '参考图'));
    }
    if (path[0] === 'projects' && path[1] && path[2] === 'refs') {
      const bytes = await catalogBody(request, MAX_SOURCE_BYTES);
      return json(await addReference(tenant.id, path[1], bytes, header(request, 'x-file-name') || '参考图'));
    }
    if (path[0] === 'shop' && path[1] === 'logo') {
      const bytes = await catalogBody(request, MAX_SOURCE_BYTES);
      return json(await saveShopLogo(tenant.id, user.id, bytes, header(request, 'x-file-name') || 'LOGO', header(request, 'x-shop-set') || null));
    }
    if (path[0] === 'shop' && path[1] === 'brand') {
      const bytes = await catalogBody(request, MAX_SOURCE_BYTES);
      return json(await saveShopBrand(tenant.id, user.id, bytes, header(request, 'x-file-name') || '店铺LOGO', header(request, 'x-shop-set') || null));
    }
    if (path[0] === 'projects' && path[1] && path[2] === 'extra') {
      const bytes = await catalogBody(request, MAX_SOURCE_BYTES);
      // A liner photo says what it is (10-22): that liner worn alone, in that colour.
      const inner = innerName(header(request, 'x-liner-inner')), color = header(request, 'x-liner-color').trim().slice(0, 12);
      return json(await addExtraImage(tenant.id, path[1], bytes, header(request, 'x-file-name') || '补传.jpg', inner && color ? { inner, color } : undefined));
    }
    if (path[0] === 'projects' && path[1] && path[2] === 'images') {
      const bytes = await catalogBody(request, MAX_SOURCE_BYTES);
      return json(await addSourceImage(tenant.id, path[1], bytes, header(request, 'x-file-name') || '图片', header(request, 'x-file-path')));
    }
    const body = JSON.parse((await catalogBody(request, 256 * 1024)).toString('utf8') || '{}');
    if (path[0] === 'projects' && !path[1]) return json(await createProject(tenant.id, user.id, body));
    if (path[0] === 'layouts' && !path[1]) return json(await createLayout(tenant.id, user.id, body));
    if (path[0] === 'layouts' && path[2] === 'learn') return json(await startLearning(tenant, path[1]));
    if (path[0] === 'layouts' && path[2] === 'save') return json(await saveLayout(tenant.id, path[1], body));
    if (path[0] === 'projects' && path[2] === 'plan') return json(await requestPlan(tenant, user.id, path[1]));
    if (path[0] === 'projects' && path[2] === 'start') return json(await submitDraft(tenant, user.id, path[1], body));
    if (path[0] === 'projects' && path[2] === 'sets') return json(await addSet(tenant, user.id, path[1], body));
    if (path[0] === 'projects' && path[2] === 'copies') return json(await copyProject(tenant.id, user.id, path[1], body));
    // 删除 (10-28): sources / images / all, each to the 回收站 for 7 days.
    if (path[0] === 'projects' && path[1] && path[2] === 'remove') {
      const mode = REMOVE_MODES.find(m => m === body.mode);
      if (!mode) throw new CatalogHttpError(400, '删除方式不对');
      return json(await removeProject(tenant.id, user.id, path[1], mode));
    }
    if (path[0] === 'projects' && path[2] === 'redo') return json(await redoSlot(tenant, user.id, path[1], String(body.slot ?? ''), String(body.note ?? '')));
    if (path[0] === 'projects' && path[2] === 'stop') return json(await stopImages(tenant, path[1]));
    if (path[0] === 'projects' && path[2] === 'draw') return json(await drawMaterial(tenant, user.id, path[1], body));
    if (path[0] === 'projects' && path[2] === 'adopt') return json(await adoptDrawn(tenant.id, path[1], body));
    if (path[0] === 'projects' && path[2] === 'skus') return json(await redoSkus(tenant, user.id, path[1], undefined, SKU_PEOPLE.find(p => p === body.people)));
    if (path[0] === 'projects' && path[2] === 'recard') return json(await recardSkus(tenant, user.id, path[1]));
    if (path[0] === 'projects' && path[2] === 'verticals') return json(await startVerticals(tenant, user.id, path[1]));
    if (path[0] === 'projects' && path[2] === 'cast') return json(await recast(tenant, user.id, path[1]));
    if (path[0] === 'projects' && path[2] === 'edit') return json(await editSlot(tenant, user.id, path[1], body));
    if (path[0] === 'projects' && path[2] === 'redraw') return json(await redrawSlot(tenant, user.id, path[1], body));
    // One of several shops (10-22): `set` in the body, none the default.
    const shopSet = typeof body.set === 'string' ? body.set : null;
    if (path[0] === 'shop' && !path[1]) return json(await saveShop(tenant.id, user.id, body, shopSet));
    if (path[0] === 'shop' && path[1] === 'make') return json(await makeServices(tenant, user.id, shopSet));
    if (path[0] === 'shop' && path[1] === 'corner') return json(await saveShopCorner(tenant.id, user.id, body, shopSet));
    if (path[0] === 'shop' && path[1] === 'sku-badge') return json(await saveSkuBadge(tenant.id, user.id, body, shopSet));
    if (path[0] === 'shop' && path[1] === 'sets' && !path[2]) return json(await createShopSet(tenant.id, user.id, body));
    if (path[0] === 'shop' && path[1] === 'sets' && path[2]) return json(await updateShopSet(tenant.id, user.id, path[2], body));
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
    if (path[0] === 'shop' && (path[1] === 'logo' || path[1] === 'brand') && !path[2]) return json(await removeShopLogo(tenant.id, user.id, path[1], request.nextUrl.searchParams.get('set')));
    if (path[0] === 'shop' && path[1] === 'sets' && path[2]) return json(await deleteShopSet(tenant.id, user.id, path[2]));
    if (path[0] !== 'projects' || !path[1]) throw new CatalogHttpError(404, '接口不存在');
    return json(await removeProject(tenant.id, user.id, path[1], 'all'));
  } catch (error) { return catalogError(error); }
}
