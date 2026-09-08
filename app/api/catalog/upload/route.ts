import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { catalogUser, CatalogHttpError } from '@/lib/server/catalog-auth';
import { catalogBody, catalogError } from '@/lib/server/catalog-http';
import { catalogDetail, catalogStyle } from '@/lib/server/catalog-repository';
import { importCatalogAsset } from '@/lib/server/catalog-import';
export async function POST(request: NextRequest) {
  try {
    const actor = await catalogUser(request, true);
    const length = Number(request.headers.get('content-length'));
    if (length > 65 * 1024 * 1024) throw new CatalogHttpError(413, '上传请求超过 65 MiB');
    const bytes = await catalogBody(request, 65 * 1024 * 1024);
    const form = await new Request(request.url, { method: 'POST', headers: request.headers, body: new Uint8Array(bytes) }).formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size > 64 * 1024 * 1024) throw new CatalogHttpError(400, '请选择不超过 64 MiB 的图片');
    const layout = z.enum(['front_back', 'front_only']).parse(form.get('layout'));
    if (form.get('layoutConfirmed') !== 'true') throw new CatalogHttpError(400, '请确认素材视图布局');
    const variantId = form.get('variantId');
    const styleId = form.get('styleId');
    if (variantId && styleId) throw new CatalogHttpError(400, '换版与添加同款颜色不能同时提交');
    const variant = variantId ? await catalogDetail(z.uuid().parse(variantId)) : null;
    const style = styleId ? await catalogStyle(z.uuid().parse(styleId)) : null;
    const imported = await importCatalogAsset({ namespace: variant?.namespace ?? style?.namespace ?? 'manual-upload', styleCode: variant?.styleCode ?? style?.styleCode ?? z.string().min(1).max(200).parse(form.get('styleCode')), colorName: variant?.colorName ?? z.string().min(1).max(100).parse(form.get('colorName')), bytes: Buffer.from(await file.arrayBuffer()), filename: file.name, layout, sources: [], actorId: actor.id,
      expectedAssetVersionId: variant ? z.uuid().parse(form.get('expectedAssetVersionId')) : undefined,
      provenance: { source: 'manual-upload', uploadedBy: actor.id, layoutConfirmed: true } });
    return NextResponse.json(imported);
  } catch (error) { return catalogError(error); }
}
