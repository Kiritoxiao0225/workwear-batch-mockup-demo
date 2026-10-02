import { after, NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantScope } from '@/lib/server/tenant-scope';
import { catalogBody, catalogError } from '@/lib/server/catalog-http';
import { catalogDatabase } from '@/lib/server/catalog-database';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { assertPageAccess } from '@/lib/server/page-access';
import { importAsset, listProjects, projectDetail, projectHead, readAsset, saveProject, storeAsset, ProjectConflictError } from '@/lib/server/garment-mockup-store';
import { enqueueGarmentAi, garmentAiStatus } from '@/lib/server/garment-mockup-ai';
import { runGarmentCutout, garmentCutoutStatus } from '@/lib/server/garment-cutout';
import { currentPrices, microToCents, priceOf } from '@/lib/server/credits';

export const dynamic='force-dynamic';
// A cutout may use its primary engine and one fallback within a single request.
export const maxDuration=60;
type Context={params:Promise<{path:string[]}>};
const json=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}});
const header=(request:NextRequest,name:string)=>{const v=request.headers.get(name);try{return v?decodeURIComponent(v):null;}catch{return v;}};
export async function GET(request:NextRequest,context:Context){
  try{
    const {tenant,user}=await tenantScope(request),{path}=await context.params;
    await assertPageAccess(user.id,['/garment-mockup']);
    if(path[0]==='projects'){
      if(!path[1])return json(await listProjects(tenant.id));
      if(path[2]==='head')return json(await projectHead(tenant.id,path[1]));
      if(path[2]==='revisions'){
        await projectDetail(tenant.id,path[1]);
        return json((await catalogDatabase().query('SELECT revision,created_at FROM garment_mockup_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 100',[path[1]])).rows);
      }
      const rev=request.nextUrl.searchParams.get('revision');
      return json(await projectDetail(tenant.id,path[1],rev?z.coerce.number().int().positive().parse(rev):undefined));
    }
    if(path[0]==='assets'&&path[1]){
      const file=await readAsset(tenant.id,path[1]);
      // An asset ID always names the same content-addressed bytes, so the browser may keep it.
      return new NextResponse(new Uint8Array(file.bytes),{headers:{'Content-Type':file.file.mime_type,'Cache-Control':'private, max-age=31536000, immutable','ETag':`"${file.file.sha256}"`,'X-Content-Type-Options':'nosniff'}});
    }
    if(path[0]==='prices'){
      // Most a click can cost: background removal may fall back to the dearer engine.
      const prices=await currentPrices();
      return json({exempt:tenant.billingMode==='exempt',cutout:microToCents(Math.max(priceOf(prices,'cutout').userMicroCents,priceOf(prices,'cutout_standard').userMicroCents)),back:microToCents(priceOf(prices,'back_reference').userMicroCents)});
    }
    if(path[0]==='cutouts'&&path[1])return json(await garmentCutoutStatus(tenant.id,path[1]));
    if(path[0]==='jobs')return json(await garmentAiStatus(tenant.id,path[1]));
    throw new CatalogHttpError(404,'接口不存在');
  }catch(e){return catalogError(e);}
}
export async function POST(request:NextRequest,context:Context){
  try{
    const {tenant,user}=await tenantScope(request,true),{path}=await context.params;
    await assertPageAccess(user.id,['/garment-mockup']);
    if(path[0]==='assets'&&path.length===1){
      const bytes=await catalogBody(request,25*1024*1024);
      return json(await storeAsset(tenant.id,bytes,decodeURIComponent(request.headers.get('x-file-name')||'图片.png')));
    }
    if(path[0]==='cutouts'&&path.length===1){
      const outcome=await runGarmentCutout(tenant,user.id,{bytes:await catalogBody(request,12*1024*1024),requestId:request.headers.get('x-request-id')||'',
        mode:request.headers.get('x-cutout-mode'),projectId:request.headers.get('x-project-id'),elementId:header(request,'x-element-id'),fileName:header(request,'x-file-name')});
      if(outcome.status===202)return json({jobId:outcome.jobId,status:'running'},202);
      if(outcome.persist){const persist=outcome.persist;try{after(persist);}catch{void persist();}}
      return new NextResponse(new Uint8Array(outcome.png),{headers:{'Content-Type':'image/png','Cache-Control':'no-store','X-Cutout-Meta':encodeURIComponent(JSON.stringify(outcome.meta))}});
    }
    const body=JSON.parse((await catalogBody(request,1024*1024)).toString('utf8'));
    if(path[0]==='import')return json(await importAsset(tenant.id,body));
    if(path[0]==='projects')return json(await saveProject(tenant.id,user.id,body));
    if(path[0]==='jobs')return json(await enqueueGarmentAi(tenant,user.id,body));
    throw new CatalogHttpError(404,'接口不存在');
  }catch(e){
    if(e instanceof ProjectConflictError)return json({error:e.message,code:'revision_conflict',serverRevision:e.serverRevision,serverUpdatedAt:e.serverUpdatedAt},409);
    return catalogError(e);
  }
}
export async function DELETE(request:NextRequest,context:Context){
  try{
    const {tenant,user}=await tenantScope(request,true),{path}=await context.params;
    await assertPageAccess(user.id,['/garment-mockup']);
    if(path[0]!=='projects'||!path[1])throw new CatalogHttpError(404,'接口不存在');
    z.uuid().parse(path[1]);
    const result=await catalogDatabase().query('UPDATE garment_mockup_projects SET deleted_at=now() WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL RETURNING id',[path[1],tenant.id]);
    if(!result.rowCount)throw new CatalogHttpError(404,'工程不存在');
    return json({deleted:true});
  }catch(e){return catalogError(e);}
}
