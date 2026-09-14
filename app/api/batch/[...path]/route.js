import { readFile } from 'node:fs/promises';
import { resolve,extname } from 'node:path';
import { NextResponse } from 'next/server';
import { catalogUser } from '@/lib/server/catalog-auth';
import { catalogBody } from '@/lib/server/catalog-http';
import { cloudStorage,CLOUD_ROOT,queueHealth,queueActivity } from '@/batch-mockup/adapters/cloud-files.mjs';
import { service } from '@/batch-mockup/runtime/service.mjs';
import { readBytes,assetPath } from '@/batch-mockup/adapters/a-files.mjs';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=300;
const staticFiles={'preview-tone.mjs':'../lib/artwork-preview-tone.mjs','compact-layout.css':'experiments/workbench/compact-layout.css','mockup-save.mjs':'experiments/workbench/mockup-save.mjs',ui:'experiments/workbench/requirements.html','requirements-editor.mjs':'experiments/workbench/requirements-editor.mjs','repair-editor.mjs':'experiments/workbench/repair-editor.mjs','repair-editor.css':'experiments/workbench/repair-editor.css','repair-pixels.mjs':'application/repair-pixels.mjs','mockup-editor.mjs':'experiments/workbench/mockup-editor.mjs','mockup-editor.css':'experiments/workbench/mockup-editor.css'};
function scopeURLs(text){return text.replace(/(["'`])\/(?!\/)/g,'$1/api/batch/');}
async function handle(request,context){
 try{
  const write=request.method!=='GET';await catalogUser(request,write);
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
   return new Response(scopeURLs(raw),{headers:{'Content-Type':path==='ui'?'text/html; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'self'"}});
  }
  if(!write&&!path.startsWith('api/')&&!path.endsWith('.json')){
   if(!/^(assets|confirmed-assets|production-assets|production-results|supplements|wps-assets|mockup-assets|mockup-results)\/[a-zA-Z0-9_./-]+$/.test(path)||path.includes('..'))return NextResponse.json({error:'图片地址无效'},{status:404});
   const bytes=await cloudStorage(()=>readBytes(assetPath(CLOUD_ROOT,path)));const ext=extname(path);let offset=0;const stream=new ReadableStream({pull(controller){if(offset>=bytes.length){controller.close();return;}const end=Math.min(offset+65536,bytes.length);controller.enqueue(new Uint8Array(bytes.subarray(offset,end)));offset=end;}});return new Response(stream,{headers:{'Content-Type':ext==='.png'?'image/png':ext==='.webp'?'image/webp':'image/jpeg','Cache-Control':'private, max-age=86400, immutable','X-Content-Type-Options':'nosniff'}});
  }
  const body=write?JSON.parse((await catalogBody(request,4*1024*1024)).toString('utf8')):Object.fromEntries(url.searchParams);
  const result=await cloudStorage(async adapter=>{if(!['api/mockups','api/mockups/prepare','api/garments'].includes(path))await adapter.preload();return service(CLOUD_ROOT,'/'+path,request.method,body,{enqueue:task=>adapter.enqueue(task)});});
  if(path==='api/requirements'){result.storage='cloud';result.workerOnline=await queueHealth();result.activity=await queueActivity();}
  return NextResponse.json(result,{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){const status=Number(e.status)||500;console.error('[batch-api]',e.name);return NextResponse.json({error:status===500?'保存或读取暂时失败，请稍后重试；已保存内容保留':e.message},{status,headers:{'Cache-Control':'no-store'}});}
}
export const GET=handle;
export const POST=handle;
