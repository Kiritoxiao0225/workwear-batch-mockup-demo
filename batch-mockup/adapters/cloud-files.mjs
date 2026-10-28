import { readWorkbenchSnapshot } from './workbench-snapshot.mjs';
import { resolve, relative, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { catalogDatabase, catalogTransaction } from '../../lib/server/catalog-database.ts';
import { saveCatalogFile, readCatalogFile } from '../../lib/server/catalog-files.ts';
import { assertStorageRoom, STORAGE_FULL } from '../../lib/server/quota.ts';
import { currentPrices, ceilingMicroCents, microToCents, holdCredits } from '../../lib/server/credits.ts';
import { emptyWpsProductionState } from '../../lib/wps-production.ts';
import { withFileStorage, hash, fail } from './a-files.mjs';
export const CLOUD_ROOT = '/tmp/workwear-batch-runtime';
export const workspaceId = () => process.env.BATCH_WORKSPACE || 'main';
const decode = row => row.content_json ?? JSON.parse(gunzipSync(row.content_gzip).toString('utf8'));
export async function cloudStorage(action, { workspace = workspaceId(), lease } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(workspace)) throw fail('工作区无效');
  const db = catalogDatabase(), reads = new Map(), pending = new Map(), queue = [], cache = new Map();
  let preloaded=false,productionDirectories=null;
  const workbenchKey=key=>['manifest.json','supplements.json','qa-notes-v2.json','production-review.json','auto-flow.json'].includes(key)||key.startsWith('requirements-state/')||key.startsWith('mockups/')||/^production-jobs\/[^/]+\/(?:state|repair-state)\.json$/.test(key);
  const keyFor = path => {
    const key = relative(CLOUD_ROOT, resolve(path));
    if (!key || key.startsWith('..') || key.startsWith(sep)) throw fail('存储路径越界');
    return key;
  };
  async function load(key, fallback) {
    if (pending.has(key)) return structuredClone(pending.get(key));
    const row=cache.has(key)?cache.get(key):preloaded&&workbenchKey(key)?null:(await db.query('SELECT revision,content_json,content_gzip FROM batch_documents WHERE workspace=$1 AND path=$2',[workspace,key])).rows[0];
    cache.set(key,row||null);
    reads.set(key, row ? Number(row.revision) : 0);
    if (!row) { if (fallback !== undefined) return structuredClone(fallback); throw Object.assign(fail('尚未找到保存内容：'+key,404),{code:'ENOENT'}); }
    return structuredClone(decode(row));
  }
  const adapter = {
    preload:async()=>{
      const [rows,dirs]=await Promise.all([readWorkbenchSnapshot(db,workspace),db.query("SELECT DISTINCT split_part(path,'/',2) AS directory FROM batch_documents WHERE workspace=$1 AND starts_with(path,'production-jobs/')",[workspace])]);
      for(const row of rows)cache.set(row.path,row);
      productionDirectories=dirs.rows.map(row=>row.directory);preloaded=true;
    },
    readJSON: (path,fallback) => load(keyFor(path),fallback),
    writeJSON: async (path,value) => { const key=keyFor(path);if(!reads.has(key))await load(key,null);pending.set(key,structuredClone(value)); },
    readBytes: async path => {
      const key=keyFor(path);
      if(key.startsWith('public/')) {
        const row=(await db.query('SELECT file_id FROM batch_assets WHERE workspace=$1 AND path=$2',[workspace,key])).rows[0];
        if(!row)throw fail('图片尚未保存：'+key,404);
        return (await readCatalogFile(row.file_id)).bytes;
      }
      const value=await load(key);return value?.encoding==='base64' ? Buffer.from(value.value,'base64') : Buffer.from(JSON.stringify(value));
    },
    assetDigest: async path => {
      const key=keyFor(path);
      if(!key.startsWith('public/'))return null;
      return (await db.query('SELECT sha256 FROM batch_assets WHERE workspace=$1 AND path=$2',[workspace,key])).rows[0]?.sha256??null;
    },
    writeBytes: async (path,bytes) => {
      const key=keyFor(path);
      if(key.startsWith('public/')) {
        const sha=hash(bytes);
        // Refused before the object store PUT when the workspace is already full; the transaction below still decides.
        const owner=(await db.query('SELECT id FROM tenants WHERE workspace=$1 AND NOT disabled',[workspace])).rows[0];
        if(owner)await assertStorageRoom(owner.id,bytes.length,sha,db);
        await saveCatalogFile(bytes,key.split('/').at(-1),'production',async(client,id)=>{
          const existing=(await client.query('SELECT sha256 FROM batch_assets WHERE workspace=$1 AND path=$2',[workspace,key])).rows[0];
          if(existing&&existing.sha256!==sha)throw fail('不可覆盖已有图片版本',409);
          // Legacy deployments can still run cleanup during rolling cutover. Pin through their known reference table too.
          const pin='batch-assets-'+workspace;await client.query('INSERT INTO production_states(state_key,revision,state_jsonb) VALUES($1,0,$2) ON CONFLICT DO NOTHING',[pin,emptyWpsProductionState()]);
          await client.query('INSERT INTO production_file_refs(state_key,ref_key,file_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[pin,hash(key),id]);
          await client.query('INSERT INTO batch_assets(workspace,path,file_id,sha256) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[workspace,key,id,sha]);
          const tenant=(await client.query('SELECT id,storage_quota_bytes FROM tenants WHERE workspace=$1 AND NOT disabled',[workspace])).rows[0];
          if(!tenant)throw fail('工作区不存在或已停用',403);
          // Lock the usage row before checking an existing ref: concurrent same-file uploads
          // count bytes once, while a different tenant must still acquire its own reference.
          await client.query('SELECT tenant_id FROM tenant_usage WHERE tenant_id=$1 FOR UPDATE',[tenant.id]);
          const owned=await client.query('SELECT 1 FROM tenant_file_refs WHERE tenant_id=$1 AND file_id=$2 LIMIT 1',[tenant.id,id]);
          if(!owned.rowCount){
            const counted=await client.query('UPDATE tenant_usage SET bytes_used=bytes_used+$2 WHERE tenant_id=$1 AND bytes_used+bytes_reserved+$2<=$3 RETURNING tenant_id',[tenant.id,bytes.length,tenant.storage_quota_bytes]);
            if(!counted.rowCount)throw fail(STORAGE_FULL,413);
          }
          await client.query("INSERT INTO tenant_file_refs(tenant_id,file_id,purpose,display_name) VALUES($1,$2,'batch',$3) ON CONFLICT DO NOTHING",[tenant.id,id,key.split('/').at(-1)]);
        });
      } else await adapter.writeJSON(path,{encoding:'base64',value:bytes.toString('base64')});
    },
    listDirectories: async path => {
      const key=keyFor(path)+'/';
      if(key==='production-jobs/'&&productionDirectories)return [...new Set([...productionDirectories,...[...pending.keys()].filter(p=>p.startsWith(key)).map(p=>p.slice(key.length).split('/')[0])])];
      const rows=await db.query('SELECT path FROM batch_documents WHERE workspace=$1 AND starts_with(path,$2)',[workspace,key]);
      return [...new Set([...rows.rows.map(r=>r.path),...pending.keys()].filter(p=>p.startsWith(key)).map(p=>p.slice(key.length).split('/')[0]))];
    },
    enqueue: task => queue.push(task),
    flush: async () => {
      if(!pending.size&&!queue.length)return;
      await catalogTransaction(async client=>{
        if(lease){const current=await client.query("SELECT id FROM batch_queue WHERE id=$1 AND owner=$2 AND status='running' AND lease_until>now() FOR UPDATE",[lease.id,lease.owner]);if(!current.rowCount)throw fail('后台租约已失效，未覆盖新结果',409);}
        for(const [key,value] of [...pending].sort(([a],[b])=>a.localeCompare(b))){
          const encoded=JSON.stringify(value),compressed=Buffer.byteLength(encoded)>262144;
          const found=await client.query(`INSERT INTO batch_documents(workspace,path,content_json,content_gzip) SELECT $1,$2,$3,$4 WHERE $5::bigint=0
            ON CONFLICT(workspace,path) DO UPDATE SET content_json=EXCLUDED.content_json,content_gzip=EXCLUDED.content_gzip,revision=batch_documents.revision+1,updated_at=now()
            WHERE batch_documents.revision=$5 RETURNING revision`,[workspace,key,compressed?null:value,compressed?gzipSync(encoded):null,reads.get(key)||0]);
          // INSERT SELECT with an existing revision produces no candidate row; use explicit CAS update.
          if(!found.rowCount&&reads.get(key)) {
            const updated=await client.query('UPDATE batch_documents SET content_json=$3,content_gzip=$4,revision=revision+1,updated_at=now() WHERE workspace=$1 AND path=$2 AND revision=$5 RETURNING revision',[workspace,key,compressed?null:value,compressed?gzipSync(encoded):null,reads.get(key)]);
            if(!updated.rowCount)throw fail('内容已在其他页面更新，请刷新后重试；未覆盖已有修改',409);
          }else if(!found.rowCount)throw fail('内容已在其他页面创建，请刷新后重试',409);
        }
        for(const task of queue){
          // The hold and queue commit with the documents, including automatic follow-on jobs.
          // main stays entirely outside billing, preserving the customer's delivery path.
          if(workspace!=='main'&&['analysis','production'].includes(task.kind)){
            const tenant=(await client.query('SELECT id,billing_mode FROM tenants WHERE workspace=$1 AND NOT disabled FOR SHARE',[workspace])).rows[0];
            if(!tenant)throw fail('工作区不存在或已停用',403);
            if(tenant.billing_mode!=='exempt'){
              const key='production-jobs/'+task.payload.jobId+'/state.json';
              const job=task.kind==='production'?(pending.get(key)??await load(key)):null;
              const snapshot=await currentPrices();
              const amountCents=microToCents(ceilingMicroCents(snapshot,task.kind==='analysis'?{analyze:true}:{route:job.route}));
              await holdCredits(client,{id:workspace+':'+task.id,tenantId:tenant.id,kind:task.kind,
                jobRef:task.kind==='analysis'?task.payload.caseId:job.caseId+'/'+(job.artworkId||job.id),
                billingMode:tenant.billing_mode,amountCents,snapshot});
            }
          }
          // Every finished artwork asks for its requirement's mock-ups; one waiting render already reads
          // them all when it starts, so a second waiting one is never added (one case queued 17 renders).
          if(task.kind==='mockup'){await client.query(`INSERT INTO batch_queue(id,workspace,kind,payload) SELECT $1,$2,$3,$4
            WHERE NOT EXISTS(SELECT 1 FROM batch_queue WHERE workspace=$2 AND kind='mockup' AND status='queued' AND payload->>'caseId'=$5) ON CONFLICT DO NOTHING`,[task.id,workspace,task.kind,task.payload,String(task.payload?.caseId??'')]);continue;}
          await client.query('INSERT INTO batch_queue(id,workspace,kind,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[task.id,workspace,task.kind,task.payload]);
        }
      });
      if(productionDirectories)productionDirectories=[...new Set([...productionDirectories,...[...pending.keys()].filter(p=>p.startsWith('production-jobs/')).map(p=>p.split('/')[1])])];
      for(const [key,value] of pending){reads.set(key,(reads.get(key)||0)+1);cache.set(key,{revision:reads.get(key),content_json:structuredClone(value)});}
      pending.clear();queue.length=0;
    },
  };
  return withFileStorage(adapter,async()=>{const result=await action(adapter);await adapter.flush();return result;});
}
/** 停止重试 from the page: true when the job still has a queue row that can take the flag. */
export async function flagStop(workspace,id){
 const r=await catalogDatabase().query(`UPDATE batch_queue SET payload=payload||'{"stop":true}'::jsonb,updated_at=now()
  WHERE workspace=$1 AND id=$2 AND kind='production' AND status IN ('queued','running') RETURNING id`,[workspace,id]);
 return r.rowCount>0;
}
export async function queueHealth(workspace='main'){const r=await catalogDatabase().query("SELECT max(heartbeat_at) AS last FROM batch_workers WHERE heartbeat_at>now()-interval '45 seconds' AND (($1='main' AND id NOT LIKE 'external:%') OR ($1<>'main' AND id LIKE 'external:%'))",[workspace]);return !!r.rows[0]?.last;}

export async function queueActivity(workspace=workspaceId()){const rows=await catalogDatabase().query("SELECT id,kind,payload->>'caseId' AS case_id,status,updated_at FROM batch_queue WHERE workspace=$1 AND (status IN ('queued','running') OR updated_at>now()-interval '1 day') ORDER BY updated_at DESC LIMIT 100",[workspace]);return rows.rows.map(r=>({id:r.id,kind:r.kind,caseId:r.case_id,status:r.status,updatedAt:r.updated_at}));}
