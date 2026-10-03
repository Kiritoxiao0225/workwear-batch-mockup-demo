import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
createRequire(import.meta.url)('@next/env').loadEnvConfig(process.cwd());
if(process.argv.includes('--local')){
  const root=resolve('data/catalog-local');
  const credentials=JSON.parse(await readFile(root+'/credentials.json','utf8'));
  process.env.CATALOG_DATABASE_URL=`postgresql://catalog_local:${encodeURIComponent(credentials.databasePassword)}@127.0.0.1:55439/postgres`;
  process.env.CATALOG_DATABASE_CA_CERT='';
  process.env.CATALOG_LOCAL_OBJECT_ROOT=root+'/objects';
  Object.assign(process.env,{NODE_ENV:'development'});
}
const { startListingWorker } = await import('../lib/server/listing-jobs');
const { closeCatalogDatabase } = await import('../lib/server/catalog-database');
const worker=await startListingWorker();
console.log('电商主图独立 worker 已启动：'+(process.argv.includes('--local')?'本地试用库':'项目环境配置'));
await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
await worker.close();await closeCatalogDatabase();
