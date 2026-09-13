// Run once from an explicitly selected, frozen local workspace. No paid calls.
import { readFile,readdir } from 'node:fs/promises';
import { resolve,relative } from 'node:path';
import { cloudStorage,CLOUD_ROOT } from '../adapters/cloud-files.mjs';
import { atomicFile,saveJSON,jsonFile,hash } from '../adapters/a-files.mjs';
import { catalogDatabase,closeCatalogDatabase } from '../../lib/server/catalog-database.ts';
process.loadEnvFile('.env.local');
const source=resolve(process.argv[2]||''),workspace=process.env.BATCH_WORKSPACE||'main';
if(!process.argv[2])throw Error('需要指定已核对的本地工作目录');
async function files(dir){return(await Promise.all((await readdir(dir,{withFileTypes:true})).map(async x=>x.isDirectory()?files(resolve(dir,x.name)):resolve(dir,x.name)))).flat();}
try{
 const manifest=JSON.parse(await readFile(resolve(source,'manifest.json'),'utf8'));
 const existing=await cloudStorage(()=>jsonFile(resolve(CLOUD_ROOT,'manifest.json'),null),{workspace});if(existing&&existing.run.id!==manifest.run.id)throw Error('正式工作区已有不同数据，未覆盖');
 const dirs=['requirements-state','analysis-evidence','production-jobs','mockups'];let documents=0,images=0;
 const inputFiles=[];
 for(const name of ['prompt.txt','scope.json','supplements.json','qa-notes-v2.json','production-review.json'])try{inputFiles.push(resolve(source,name));}catch{}
 for(const name of dirs)try{inputFiles.push(...await files(resolve(source,name)));}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const path of inputFiles){let bytes;try{bytes=await readFile(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}const key=relative(source,path);
  await cloudStorage(async()=>{const dest=resolve(CLOUD_ROOT,key);if(key.endsWith('.json')){let value;try{value=JSON.parse(bytes);}catch{await atomicFile(dest,bytes);return;}const old=await jsonFile(dest,null);if(old!==null){if(JSON.stringify(old)!==JSON.stringify(value))throw Error('已有不同版本，未覆盖：'+key);return;}await saveJSON(dest,value);}else await atomicFile(dest,bytes);},{workspace});documents++;
 }
 // Copy only application images, not browser state, provider credentials, screenshots or build artifacts.
 for(const dir of ['assets','supplements','confirmed-assets','production-assets','production-results','mockup-assets','mockup-results']){
  let paths=[];try{paths=await files(resolve(source,'public',dir));}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const path of paths){if(!/\.(png|jpe?g|webp)$/i.test(path))continue;const bytes=await readFile(path);await cloudStorage(()=>atomicFile(resolve(CLOUD_ROOT,relative(source,path)),bytes),{workspace});images++;if(images%15===0)console.log({documents,images});}
 }
 await cloudStorage(()=>saveJSON(resolve(CLOUD_ROOT,'manifest.json'),manifest),{workspace});
 const receipt={at:new Date().toISOString(),workspace,sourceRun:manifest.run.id,cases:manifest.cases.length,documents,images,manifestSHA256:hash(JSON.stringify(manifest)),paidCalls:0};
 await cloudStorage(()=>saveJSON(resolve(CLOUD_ROOT,'import-receipt.json'),receipt),{workspace});
 console.log(receipt);console.log((await catalogDatabase().query('SELECT count(*)::int documents FROM batch_documents WHERE workspace=$1',[workspace])).rows);
}finally{await closeCatalogDatabase();}
