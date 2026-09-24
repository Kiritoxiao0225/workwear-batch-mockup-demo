import { readFile } from 'node:fs/promises';
import { allCatalogStyles,catalogDetail } from '../../lib/server/catalog-repository.ts';
import { readCatalogFile } from '../../lib/server/catalog-files.ts';
import { assertFileAccess } from '../../lib/server/file-authorization.ts';
import { tenantByWorkspace } from '../../lib/server/tenant-scope.ts';
import { fail } from './a-files.mjs';
let framePromise;
const catalogs=new Map();
function catalogForTenant(tenantId){
 let stylesPromise,stylesAt=0;
 const details=new Map(),images=new Map();
 return {
  styles:async()=>{if(!stylesPromise||Date.now()-stylesAt>60000){stylesAt=Date.now();stylesPromise=allCatalogStyles(tenantId).catch(e=>{stylesPromise=null;throw e;});}return stylesPromise;},
  detail:async(id,version)=>{const key=id+':'+(version||'current');if(!details.has(key)){if(details.size>100)details.clear();details.set(key,catalogDetail(id,version,tenantId).catch(e=>{details.delete(key);throw e;}));}return details.get(key);},
  bytes:async garment=>{
   const match=/^\/api\/catalog\/files\/([0-9a-f-]{36})$/.exec(garment.imageUrl);if(!match)throw Error('服装素材身份无效');
   // Authorize even cached bytes: knowing another tenant's file id is never sufficient.
   await assertFileAccess(match[1],tenantId);
   if(!images.has(match[1])){if(images.size>8)images.clear();images.set(match[1],readCatalogFile(match[1]).then(r=>r.bytes).catch(e=>{images.delete(match[1]);throw e;}));}return images.get(match[1]);
  },
  frame:()=>framePromise??=readFile(new URL('../../public/brand/ant-shirt/confirmation-frame-v2.png',import.meta.url)),
 };
}
export async function garmentCatalogForWorkspace(workspace){
 const tenant=await tenantByWorkspace(workspace);
 if(!tenant)throw fail('工作区不存在或已停用',403);
 if(!catalogs.has(tenant.id)){if(catalogs.size>=50)catalogs.clear();catalogs.set(tenant.id,catalogForTenant(tenant.id));}
 return catalogs.get(tenant.id);
}
