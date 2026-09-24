import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { tenantScope } from '@/lib/server/tenant-scope';
import { catalogBody, catalogError } from '@/lib/server/catalog-http';
import { catalogDatabase } from '@/lib/server/catalog-database';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { importAsset, listProjects, projectDetail, readAsset, saveProject, storeAsset } from '@/lib/server/garment-mockup-store';
import { enqueueGarmentAi, garmentAiStatus } from '@/lib/server/garment-mockup-ai';

export const dynamic='force-dynamic';
type Context={params:Promise<{path:string[]}>};
const json=(data:unknown)=>NextResponse.json(data,{headers:{'Cache-Control':'no-store'}});
export async function GET(request:NextRequest,context:Context){
  try{
    const {tenant}=await tenantScope(request),{path}=await context.params;
    if(path[0]==='projects'){
      if(!path[1])return json(await listProjects(tenant.id));
      if(path[2]==='revisions'){
        await projectDetail(tenant.id,path[1]);
        return json((await catalogDatabase().query('SELECT revision,created_at FROM garment_mockup_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 100',[path[1]])).rows);
      }
      const rev=request.nextUrl.searchParams.get('revision');
      return json(await projectDetail(tenant.id,path[1],rev?z.coerce.number().int().positive().parse(rev):undefined));
    }
    if(path[0]==='assets'&&path[1]){
      const file=await readAsset(tenant.id,path[1]);
      return new NextResponse(new Uint8Array(file.bytes),{headers:{'Content-Type':file.file.mime_type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    }
    if(path[0]==='jobs')return json(await garmentAiStatus(tenant.id,path[1]));
    throw new CatalogHttpError(404,'接口不存在');
  }catch(e){return catalogError(e);}
}
export async function POST(request:NextRequest,context:Context){
  try{
    const {tenant,user}=await tenantScope(request,true),{path}=await context.params;
    if(path[0]==='assets'&&path.length===1){
      const bytes=await catalogBody(request,25*1024*1024);
      return json(await storeAsset(tenant.id,bytes,decodeURIComponent(request.headers.get('x-file-name')||'图片.png')));
    }
    const body=JSON.parse((await catalogBody(request,1024*1024)).toString('utf8'));
    if(path[0]==='import')return json(await importAsset(tenant.id,body));
    if(path[0]==='projects')return json(await saveProject(tenant.id,user.id,body));
    if(path[0]==='jobs')return json(await enqueueGarmentAi(tenant,user.id,body));
    throw new CatalogHttpError(404,'接口不存在');
  }catch(e){return catalogError(e);}
}
export async function DELETE(request:NextRequest,context:Context){
  try{
    const {tenant}=await tenantScope(request,true),{path}=await context.params;
    if(path[0]!=='projects'||!path[1])throw new CatalogHttpError(404,'接口不存在');
    z.uuid().parse(path[1]);
    const result=await catalogDatabase().query('UPDATE garment_mockup_projects SET deleted_at=now() WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL RETURNING id',[path[1],tenant.id]);
    if(!result.rowCount)throw new CatalogHttpError(404,'工程不存在');
    return json({deleted:true});
  }catch(e){return catalogError(e);}
}
