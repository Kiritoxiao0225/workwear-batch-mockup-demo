import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { catalogUser } from '@/lib/server/catalog-auth';
import { tenantScope, isInternalTenant } from '@/lib/server/tenant-scope';
import { catalogBody } from '@/lib/server/catalog-http';
import { assertPageAccess,artworkRouteOf } from '@/lib/server/page-access';
import { cloudStorage,CLOUD_ROOT,queueHealth,queueActivity,flagStop } from '@/batch-mockup/adapters/cloud-files.mjs';
import { service } from '@/batch-mockup/runtime/service.mjs';
import { enqueueWpsSync,readWpsSyncStatus } from '@/batch-mockup/runtime/sync-scheduler.mjs';
import { assetResponse } from '@/batch-mockup/runtime/asset-response.mjs';
import { limitUploads,CHUNK_WINDOWS } from '@/lib/server/upload-limit';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=300;
const staticFiles={'saas-editors':'ui/saas-editors.html','preview-tone.mjs':'../lib/artwork-preview-tone.mjs','compact-layout.css':'experiments/workbench/compact-layout.css','mockup-save.mjs':'experiments/workbench/mockup-save.mjs',ui:'experiments/workbench/requirements.html','requirements-editor.mjs':'experiments/workbench/requirements-editor.mjs','repair-editor.mjs':'experiments/workbench/repair-editor.mjs','repair-editor.css':'experiments/workbench/repair-editor.css','repair-pixels.mjs':'application/repair-pixels.mjs','mockup-editor.mjs':'experiments/workbench/mockup-editor.mjs','mockup-editor.css':'experiments/workbench/mockup-editor.css'};
function scopeURLs(text){return text.replace(/(["'`])\/(?!\/)/g,'$1/api/batch/');}
async function handle(request,context){
 try{
  const write=request.method!=='GET';await catalogUser(request,write);
 // Both browser surfaces resolve their workspace from the authenticated tenant; fail closed.
 const scope=await tenantScope(request,write),tenant=scope.tenant;
 // Pages that work through this endpoint, including the WPS workbench proxy. The garment page
 // only reads artwork results; writing (which can start paid work) needs one of the others.
 await assertPageAccess(scope.user.id,write?['/batch','/artwork-studio','/wps-production']:['/batch','/artwork-studio','/wps-production','/garment-mockup']);
 const workspace=tenant.workspace;
 const internal=isInternalTenant(tenant);
 const wpsOnly=internal&&request.headers.get('x-wps-workbench')==='1';
 // The 出图通道 an administrator set for this account (null: it picks on the page); production holds to it.
 const route=await artworkRouteOf(scope.user.id);
  const params=await context.params,path=params.path.join('/'),url=new URL(request.url);
  if(!write&&staticFiles[path]){
   let raw=await readFile(resolve(process.cwd(),'batch-mockup',staticFiles[path]),'utf8');
   if(path==='ui'){
    // Deliver editor styles with the page so a delayed stylesheet request cannot expose full-size assets.
    for(const name of ['repair-editor.css','mockup-editor.css','compact-layout.css']){
     const css=await readFile(resolve(process.cwd(),'batch-mockup',staticFiles[name]),'utf8');
     raw=raw.replace(`<link rel="stylesheet" href="/${name}">`,`<style data-editor-style="${name}">${css}</style>`);
    }
   }
   // The workbench HTML is shared with /wps-production. A tenant that cannot call the WPS
   // endpoints should not see controls for them either.
   if(path==='ui'&&!internal)raw=raw.replace('</head>','<style>#sync-wps,[data-action="adopt-source"]{display:none!important}</style></head>');
   return new Response(path==='saas-editors'?raw.replace(/(href=|from\s+)(["'])\/(?!api\/batch\/)/g,'$1$2/api/batch/'):scopeURLs(raw),{headers:{'Content-Type':['ui','saas-editors'].includes(path)?'text/html; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'self'"}});
  }
  if(!write&&!path.startsWith('api/')&&!path.endsWith('.json')){
   if(!/^(assets|confirmed-assets|production-assets|production-results|supplements|wps-assets|mockup-assets|mockup-results)\/[a-zA-Z0-9_./-]+$/.test(path)||path.includes('..'))return NextResponse.json({error:'图片地址无效'},{status:404});
   // Pages show ?preview=1 (a small display copy); download and editing fetch the original.
   const asset=await cloudStorage(()=>assetResponse(CLOUD_ROOT,path,{preview:url.searchParams.get('preview')==='1',ifNoneMatch:request.headers.get('if-none-match')}),{workspace});
   if(asset.status===404)return NextResponse.json({error:'图片尚未保存'},{status:404});
   if(asset.status===304)return new Response(null,{status:304,headers:asset.headers});
   const bytes=asset.bytes;let offset=0;const stream=new ReadableStream({pull(controller){if(offset>=bytes.length){controller.close();return;}const end=Math.min(offset+65536,bytes.length);controller.enqueue(new Uint8Array(bytes.subarray(offset,end)));offset=end;}});return new Response(stream,{headers:asset.headers});
  }
  // Sync and adopt read and write the customer's real WPS table.
  if(write&&['api/wps/sync','api/wps/adopt'].includes(path)&&!internal&&process.env.WPS_WRITE_INTERNAL_ONLY!=='0')
   return NextResponse.json({error:'WPS 同步仅限内部账号'},{status:403,headers:{'Cache-Control':'no-store'}});
  // Upload chunks are kept in batch_documents outside the storage quota; they are rate limited per workspace instead.
  if(write&&['api/cases/image','api/supplements/chunk','api/production/edit/chunk'].includes(path))await limitUploads('upload-chunk:'+workspace,CHUNK_WINDOWS);
  const body=write?JSON.parse((await catalogBody(request,4*1024*1024)).toString('utf8')):Object.fromEntries(url.searchParams);
  const result=await cloudStorage(async adapter=>{if(!['api/mockups','api/mockups/prepare','api/garments','api/wps/sync'].includes(path))await adapter.preload();return service(CLOUD_ROOT,'/'+path,request.method,body,{enqueue:task=>adapter.enqueue(task),scheduleSync:()=>enqueueWpsSync(),stopProduction:id=>flagStop(workspace,id),workspace,wpsOnly,route});},{workspace});
  if(path==='api/requirements'){
   result.storage='cloud';result.imageRoute=route;[result.workerOnline,result.activity,result.wpsSync]=await Promise.all([queueHealth(workspace),queueActivity(workspace),internal?readWpsSyncStatus():null]);
   if(wpsOnly){const ids=new Set(result.cases.map(item=>item.caseId));result.activity=result.activity.filter(item=>item.kind==='sync'||ids.has(item.caseId));}
  }
  return NextResponse.json(result,{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){const status=Number(e.status)||500;console.error('[batch-api]',e.name);return NextResponse.json({error:status===500?'保存或读取暂时失败，请稍后重试；已保存内容保留':e.message},{status,headers:{'Cache-Control':'no-store'}});}
}
export const GET=handle;
export const POST=handle;
