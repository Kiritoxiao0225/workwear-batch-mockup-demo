import { randomUUID } from 'node:crypto';
import { catalogDatabase,catalogTransaction } from '../../lib/server/catalog-database.ts';
import { cloudStorage,CLOUD_ROOT } from '../adapters/cloud-files.mjs';
import { executeTask,markInterrupted } from './service.mjs';
import { enqueueWpsSync } from './sync-scheduler.mjs';
export function workerScope(value = process.env.BATCH_WORKER_SCOPE || 'main') {
 if (!['main', 'external'].includes(value)) throw new Error('BATCH_WORKER_SCOPE 必须为 main 或 external');
 return value;
}
// One requirement's artworks write separate job documents, so they may generate side by side;
// every other pair on the same requirement (analysis, mock-up) still waits for the one running.
export async function claimNextTask(owner, scope) {
 workerScope(scope);
 return catalogTransaction(async client => {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('batch-queue-claim'))");
  const row = (await client.query(`SELECT q.id FROM batch_queue q
   WHERE q.status='queued'
    AND (($1='main' AND q.workspace='main') OR ($1='external' AND q.workspace<>'main'
      AND q.kind<>'sync' AND EXISTS(SELECT 1 FROM tenants t WHERE t.workspace=q.workspace AND NOT t.disabled)
      AND (SELECT count(*) FROM batch_queue r WHERE r.workspace=q.workspace AND r.status='running')<2))
    AND NOT EXISTS(SELECT 1 FROM batch_queue r WHERE r.status='running' AND r.workspace=q.workspace
      AND ((r.payload->>'caseId'=q.payload->>'caseId' AND NOT (q.kind='production' AND r.kind='production'))
        OR (q.kind='sync' AND r.kind='sync')))
   ORDER BY q.created_at, q.id FOR UPDATE SKIP LOCKED LIMIT 1`, [scope])).rows[0];
  if (!row) return null;
  return (await client.query("UPDATE batch_queue SET status='running',owner=$2,lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=$1 RETURNING *",[row.id,owner])).rows[0];
 });
}
export async function expireTasks(scope) {
 workerScope(scope);
 return catalogDatabase().query(`UPDATE batch_queue SET status=CASE WHEN kind IN ('mockup','sync') THEN 'queued' ELSE 'unknown' END,
 owner=NULL,lease_until=NULL,error='后台中断，未自动重复付费'
 WHERE status='running' AND lease_until<now()
 AND (($1='main' AND workspace='main') OR ($1='external' AND workspace<>'main')) RETURNING *`, [scope]);
}
// Most of a generation is spent waiting on the provider, so a worker can hold many at once.
export function workerConcurrency(value = process.env.BATCH_WORKER_CONCURRENCY || '3') {
 const n = Number(value);
 if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error('BATCH_WORKER_CONCURRENCY 必须是 1 到 50 的整数');
 return n;
}
export async function startBatchWorker({scope = workerScope(), concurrency = workerConcurrency()} = {}){
 workerScope(scope);
 const owner=scope+':'+randomUUID(),db=catalogDatabase(),running=new Set();let closed=false,pumping=false,lastHeartbeat=0;
 async function heartbeat(){await db.query('INSERT INTO batch_workers(id,build_commit) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET heartbeat_at=now()',[owner,process.env.WORKWEAR_BUILD_COMMIT||null]);await db.query("UPDATE batch_queue SET lease_until=now()+interval '2 minutes',updated_at=now() WHERE owner=$1 AND status='running'",[owner]);lastHeartbeat=Date.now();}
 async function pump(){if(closed||pumping)return;pumping=true;
  try{
   const expired=await expireTasks(scope);
   for(const task of expired.rows)if(task.status==='unknown')await cloudStorage(()=>markInterrupted(CLOUD_ROOT,task),{workspace:task.workspace});
   if(scope==='main')await enqueueWpsSync({automatic:true,workspace:'main'});
   while(running.size<concurrency&&!closed){
    const task=await claimNextTask(owner,scope);
    if(!task)break;
    const work=(async()=>{
     try{await cloudStorage(async adapter=>{await adapter.preload();return executeTask(CLOUD_ROOT,task,t=>adapter.enqueue(t));},{workspace:task.workspace,lease:{id:task.id,owner}});await db.query("UPDATE batch_queue SET status='finished',lease_until=NULL,updated_at=now() WHERE id=$1 AND owner=$2 AND status='running'",[task.id,owner]);}
     catch(e){if(['mockup','sync'].includes(task.kind)&&e.status===409&&(task.payload.attempt||0)<3){await db.query("UPDATE batch_queue SET status='queued',owner=NULL,lease_until=NULL,payload=$3,updated_at=now() WHERE id=$1 AND owner=$2",[task.id,owner,{...task.payload,attempt:(task.payload.attempt||0)+1}]);return;}await db.query("UPDATE batch_queue SET status=$3,error=$4,lease_until=NULL,updated_at=now() WHERE id=$1 AND owner=$2 AND status='running'",[task.id,owner,['mockup','sync'].includes(task.kind)?'failed':'unknown',String(e.message).slice(0,1200)]);if(['production','analysis'].includes(task.kind))await cloudStorage(()=>markInterrupted(CLOUD_ROOT,task),{workspace:task.workspace}).catch(()=>{});console.error('[batch-worker]',task.kind,task.id,e.message);}
    })().finally(()=>running.delete(work));running.add(work);
   }
  }finally{pumping=false;}
 }
 await heartbeat();const beat=setInterval(()=>{void heartbeat().catch(e=>console.error('[batch-heartbeat]',e.name));},10000),tick=setInterval(()=>{void pump().catch(e=>console.error('[batch-pump]',e.name));},2000);
 void pump().catch(e=>console.error('[batch-pump]',e.name));return {status:()=>({scope,concurrency,automaticWpsSync:scope==='main',ready:!closed&&Date.now()-lastHeartbeat<30000,running:running.size}),close:async()=>{closed=true;clearInterval(tick);while(pumping)await new Promise(resolve=>setTimeout(resolve,50));await Promise.allSettled([...running]);clearInterval(beat);}};
}
