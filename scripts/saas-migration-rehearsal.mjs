/** Offline production-backup rehearsal. Never loads environment files or connects to production. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createServer} from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
const input=process.argv[2],output=process.argv[3];if(!input||!output)throw Error('需要备份路径和报告路径');
const backup=JSON.parse(await readFile(input,'utf8'));
assert.equal(createHash('sha256').update(JSON.stringify(backup.payload)).digest('hex'),backup.sha256);
const root=await mkdtemp(join(tmpdir(),'saas-rehearsal-')),probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const password=randomBytes(24).toString('hex');
process.env.CATALOG_DATABASE_URL=`postgresql://rehearsal:${password}@127.0.0.1:${port}/postgres`;
process.env.CATALOG_DATABASE_CA_CERT='';process.env.CATALOG_LOCAL_OBJECT_ROOT=join(root,'objects');
const database=new EmbeddedPostgres({databaseDir:join(root,'pg'),user:'rehearsal',password,port,persistent:true,authMethod:'scram-sha-256',postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:e=>console.error(e.name||'database error')});
const {catalogDatabase:db,catalogTransaction:transaction,migrateCatalog,closeCatalogDatabase}=await import('../lib/server/catalog-database.ts');
const {restoreCatalog}=await import('../lib/server/catalog-backup.ts');
const report={backupSHA256:backup.sha256,productionConnected:false,objectBytesVerified:false,checks:[]};
const passed=name=>{report.checks.push(name);console.log('PASS',name);};
async function snapshot(){const counts={},digests={};for(const table of ['batch_documents','batch_assets','batch_queue','garment_styles','garment_variants','garment_asset_versions','garment_views','placement_standard_versions','standard_reuse_checks','asset_sources','files','production_states','production_file_refs','import_batches','users'])counts[table]=(await db().query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
 for(const [name,query]of Object.entries({docs:"SELECT md5(string_agg(path||'|'||revision,E'\\n' ORDER BY path)) d FROM batch_documents WHERE workspace='main'",assets:"SELECT md5(string_agg(path||'|'||sha256,E'\\n' ORDER BY path)) d FROM batch_assets WHERE workspace='main'",catalog:"SELECT md5(string_agg(s.style_code||'|'||v.color_name||'|'||a.version||'|'||a.file_id::text,E'\\n' ORDER BY s.style_code,v.color_name,a.version)) d FROM garment_styles s JOIN garment_variants v ON v.style_id=s.id JOIN garment_asset_versions a ON a.variant_id=v.id",standards:"SELECT md5(string_agg(id::text||'|'||revision::text,E'\\n' ORDER BY id)) d FROM placement_standard_versions"}))digests[name]=(await db().query(query)).rows[0].d;
 return {counts,digests};}
try{await database.initialise();await database.start();
 await transaction(async client=>{await client.query('CREATE SCHEMA garment_catalog');await client.query('CREATE TABLE garment_catalog.schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');for(const m of backup.payload.migrations){assert(/^[0-9]{3}_[a-z0-9_]+\.sql$/.test(m.name));const sql=await readFile(resolve('db/migrations',m.name),'utf8');assert.equal(createHash('sha256').update(sql).digest('hex'),m.sha256);await client.query(sql);await client.query('INSERT INTO garment_catalog.schema_migrations(name,sha256) VALUES($1,$2)',[m.name,m.sha256]);}});
 await restoreCatalog(backup);passed('016 备份在独立空库完整恢复');const before=await snapshot();
 const migrations=await migrateCatalog();assert.deepEqual(migrations,['017_tenants_identities.sql','018_sms_challenges.sql','019_catalog_tenant.sql','020_credits.sql','021_email_challenges.sql','022_email_password_flows.sql']);const after=await snapshot();assert.deepEqual(after,before);report.before=before;report.after=after;passed('非空生产副本迁移 017–022，业务计数与四项指纹完全相同');
 assert.equal((await db().query('SELECT count(*)::int n FROM files f WHERE NOT EXISTS(SELECT 1 FROM tenant_file_refs r WHERE r.file_id=f.id)')).rows[0].n,0);passed('全部历史文件租户引用回填完整');
 const {cloudStorage,CLOUD_ROOT}=await import('../batch-mockup/adapters/cloud-files.mjs');const {saveJSON}=await import('../batch-mockup/adapters/a-files.mjs');
 const tenant=randomUUID();await db().query("INSERT INTO tenants(id,name,style_quota,storage_quota_bytes,workspace) VALUES($1,'测试',10,1000000,'rehearsal-external')",[tenant]);await db().query('INSERT INTO credit_accounts(tenant_id) VALUES($1)',[tenant]);
 const task={id:randomUUID(),kind:'analysis',payload:{caseId:'rehearsal'}};
 await assert.rejects(()=>cloudStorage(async adapter=>{await saveJSON(join(CLOUD_ROOT,'rehearsal.json'),{saved:true});adapter.enqueue(task);},{workspace:'rehearsal-external'}),e=>e.status===402);
 for(const table of ['batch_documents','batch_queue'])assert.equal((await db().query(`SELECT count(*)::int n FROM ${table} WHERE workspace='rehearsal-external'`)).rows[0].n,0);
 assert.equal((await db().query('SELECT count(*)::int n FROM credit_holds WHERE tenant_id=$1',[tenant])).rows[0].n,0);passed('余额不足时文档、队列与冻结全部回滚');
 await db().query('UPDATE credit_accounts SET balance_cents=100 WHERE tenant_id=$1',[tenant]);
 await cloudStorage(async adapter=>{await saveJSON(join(CLOUD_ROOT,'rehearsal.json'),{saved:true});adapter.enqueue(task);},{workspace:'rehearsal-external'});
 assert.equal((await db().query('SELECT held_cents::int n FROM credit_accounts WHERE tenant_id=$1',[tenant])).rows[0].n,15);passed('外部任务与 15 分冻结同事务提交');
 const {claimNextTask,expireTasks}=await import('../batch-mockup/runtime/worker.mjs');
 const claimed=await claimNextTask('external:test','external');assert.equal(claimed.id,task.id);assert.equal(claimed.workspace,'rehearsal-external');
 const main=await claimNextTask('main:test','main');if(main)assert.equal(main.workspace,'main');passed('main 与 external 实际 SQL 领单范围互斥');
 await db().query("UPDATE batch_queue SET lease_until=now()-interval '1 minute' WHERE id=$1",[task.id]);await expireTasks('main');assert.equal((await db().query('SELECT status FROM batch_queue WHERE id=$1',[task.id])).rows[0].status,'running');await expireTasks('external');assert.equal((await db().query('SELECT status FROM batch_queue WHERE id=$1',[task.id])).rows[0].status,'unknown');passed('过期任务回收同样按工作区隔离，付费任务不自动重发');
 await db().query('UPDATE tenants SET disabled=true WHERE id=$1',[tenant]);await db().query("INSERT INTO batch_queue(id,workspace,kind,payload) VALUES($1,'rehearsal-external','mockup',$2)",[randomUUID(),{caseId:'disabled'}]);assert.equal(await claimNextTask('external:test','external'),null);passed('停用租户不再领取任务');
 // Independent 016 recovery database proves the fallback without writing over the upgraded database.
 await db().query('CREATE DATABASE recovery');await closeCatalogDatabase();process.env.CATALOG_DATABASE_URL=`postgresql://rehearsal:${password}@127.0.0.1:${port}/recovery`;
 await transaction(async client=>{await client.query('CREATE SCHEMA garment_catalog');await client.query('CREATE TABLE garment_catalog.schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');for(const m of backup.payload.migrations){await client.query(await readFile(resolve('db/migrations',m.name),'utf8'));await client.query('INSERT INTO garment_catalog.schema_migrations(name,sha256) VALUES($1,$2)',[m.name,m.sha256]);}});
 await restoreCatalog(backup);assert.deepEqual(await snapshot(),before);passed('另建 016 恢复库回读一致，未对原库 restore');
 report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2));
}finally{await closeCatalogDatabase();await database.stop();await rm(root,{recursive:true,force:true});}
