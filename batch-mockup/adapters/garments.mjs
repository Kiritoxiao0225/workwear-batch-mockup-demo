import { readFile } from 'node:fs/promises';
import { allCatalogStyles,catalogDetail } from '../../lib/server/catalog-repository.ts';
import { readCatalogFile } from '../../lib/server/catalog-files.ts';
let stylesPromise,stylesAt=0,framePromise;
const details=new Map(),images=new Map();
export const garmentCatalog={
 styles:async()=>{if(!stylesPromise||Date.now()-stylesAt>60000){stylesAt=Date.now();stylesPromise=allCatalogStyles().catch(e=>{stylesPromise=null;throw e;});}return stylesPromise;},
 detail:async(id,version)=>{const key=id+':'+(version||'current');if(!details.has(key)){if(details.size>100)details.clear();details.set(key,catalogDetail(id,version).catch(e=>{details.delete(key);throw e;}));}return details.get(key);},
 bytes:async garment=>{
  const match=/^\/api\/catalog\/files\/([0-9a-f-]{36})$/.exec(garment.imageUrl);if(!match)throw Error('服装素材身份无效');
  if(!images.has(match[1])){if(images.size>8)images.clear();images.set(match[1],readCatalogFile(match[1]).then(r=>r.bytes).catch(e=>{images.delete(match[1]);throw e;}));}return images.get(match[1]);
 },
 frame:()=>framePromise??=readFile(new URL('../../public/brand/ant-shirt/confirmation-frame-v2.png',import.meta.url)),
};
