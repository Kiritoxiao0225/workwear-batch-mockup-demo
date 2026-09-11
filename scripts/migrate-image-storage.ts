/** Copy/verify first; activate only after all live readers support zeabur records. Never deletes OSS. */
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { catalogDatabase, catalogTransaction, closeCatalogDatabase } from '../lib/server/catalog-database';
import { readCatalogFile, fileSha256 } from '../lib/server/catalog-files';
import { imageStoreRequest, imageStoreConfig } from '../lib/server/catalog-image-store';

if (process.env.IMAGE_MIGRATION_ENV) process.loadEnvFile(process.env.IMAGE_MIGRATION_ENV);
const [mode, manifest] = process.argv.slice(2);
if (!['copy','activate','audit'].includes(mode) || !manifest) throw new Error('Usage: migrate-image-storage.ts copy|activate|audit manifest.jsonl');
type Entry = { id: string; backend: string; bucket: string; object_key: string; object_version_id: string | null; sha256: string; byte_length: string; copiedAt: string };
try {
  if (mode === 'copy') {
    let previous: Entry[] = [];
    try { previous = (await readFile(manifest,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const done = new Set(previous.map(r=>r.id));
    const rows = (await catalogDatabase().query("SELECT id,backend,bucket,object_key,object_version_id,sha256,byte_length::text FROM files WHERE backend='oss' AND bucket=$1 AND status='ready' AND gc_state='active' ORDER BY created_at,id",[process.env.CATALOG_OSS_BUCKET])).rows as Entry[];
    const pending = rows.filter(r=>!done.has(r.id));
    let index=0, copied=0, failed=0;
    console.log(JSON.stringify({mode,total:rows.length,pending:pending.length,previous:previous.length}));
    const copy = async () => {
      while (index<pending.length) {
        const row=pending[index++];
        try {
          const {bytes}=await readCatalogFile(row.id);
          const receipt=await (await imageStoreRequest(row.object_key,'PUT',bytes)).json();
          if(receipt.sha256!==row.sha256 || receipt.backedUp!==true) throw new Error('Primary/backup acknowledgement mismatch');
          const saved=Buffer.from(await (await imageStoreRequest(row.object_key,'GET')).arrayBuffer());
          if(fileSha256(saved)!==row.sha256 || saved.length!==Number(row.byte_length)) throw new Error('Primary readback mismatch');
          if(!process.env.IMAGE_MIGRATION_BACKUP_URL || !process.env.IMAGE_MIGRATION_BACKUP_TOKEN) throw new Error('Backup verification credentials missing');
          const result=await fetch(`${process.env.IMAGE_MIGRATION_BACKUP_URL}/v1/objects/${row.object_key}`,{headers:{Authorization:`Bearer ${process.env.IMAGE_MIGRATION_BACKUP_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(120000)});
          if(!result.ok || fileSha256(Buffer.from(await result.arrayBuffer()))!==row.sha256) throw new Error('Independent backup readback mismatch');
          await appendFile(manifest,JSON.stringify({...row,copiedAt:new Date().toISOString()})+'\n',{mode:0o600});
          copied++; if(copied%20===0) console.log(JSON.stringify({copied,failed,remaining:pending.length-copied-failed}));
        } catch(e) {failed++;console.log(JSON.stringify({failedId:row.id,error:e instanceof Error?e.message:String(e)}));}
      }
    };
    await Promise.all([copy(),copy()]);
    console.log(JSON.stringify({mode,complete:true,copied,failed}));if(failed)process.exitCode=1;
  } else if(mode==='activate') {
    const entries=(await readFile(manifest,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)) as Entry[];
    let activated=0,skipped=0;
    for(const row of entries) {
      // Verify the destination again before moving the stable ID. No customer references change.
      const result=await imageStoreRequest(row.object_key,'HEAD');
      if(result.headers.get('x-image-sha256')!==row.sha256 || Number(result.headers.get('content-length'))!==Number(row.byte_length)) throw new Error(`Destination verification failed: ${row.id}`);
      const moved=await catalogTransaction(async c=>{
        const file=(await c.query('SELECT * FROM files WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
        if(!file || file.backend!=='oss' || file.status!=='ready' || file.gc_state!=='active' || file.bucket!==row.bucket || file.object_key!==row.object_key || file.sha256!==row.sha256 || file.object_version_id!==row.object_version_id) return false;
        await c.query("UPDATE files SET backend='zeabur',bucket=$2,object_version_id=NULL WHERE id=$1",[row.id,imageStoreConfig().bucket]);return true;
      });
      if(moved)activated++;else skipped++;
      if((activated+skipped)%100===0)console.log(JSON.stringify({activated,skipped}));
    }
    console.log(JSON.stringify({mode,complete:true,activated,skipped}));
  } else {
    const rows=(await catalogDatabase().query("SELECT backend,status,gc_state,count(*)::int AS files,sum(byte_length)::text AS bytes FROM files GROUP BY backend,status,gc_state ORDER BY backend,status,gc_state")).rows;
    await writeFile(manifest,JSON.stringify({at:new Date().toISOString(),rows},null,2),{mode:0o600});console.log(JSON.stringify(rows));
  }
} finally { await closeCatalogDatabase(); }
