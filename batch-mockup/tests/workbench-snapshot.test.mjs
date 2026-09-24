import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import postgres from 'postgres';
import EmbeddedPostgres from 'embedded-postgres';
import {readWorkbenchSnapshot} from '../adapters/workbench-snapshot.mjs';

test('revision checked snapshots transfer changes, isolate workspaces and fail closed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'wps-snapshot-'));
 const probe=createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
 const password=randomBytes(24).toString('hex');
 const server=new EmbeddedPostgres({databaseDir:join(root,'pg'),user:'test',password,port,persistent:true,authMethod:'scram-sha-256',postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
 let sql;
 try{
  await server.initialise();await server.start();
  sql=postgres({host:'127.0.0.1',port,user:'test',password,database:'postgres',max:1});
  await sql.unsafe('CREATE TABLE batch_documents(workspace text,path text,revision bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),content_json jsonb,content_gzip bytea,PRIMARY KEY(workspace,path))');
  let transferred;
  const db={query:async(text,args)=>{const rows=await sql.unsafe(text,args);transferred=rows;return {rows};}};
  const insert=(workspace,path,doc)=>sql.unsafe('INSERT INTO batch_documents(workspace,path,content_json) VALUES($1,$2,$3)',[workspace,path,doc]);
  await insert('snapshot-test-a','manifest.json',{cases:['A']});
  await insert('snapshot-test-a','requirements-state/A.json',{text:'original'});
  await insert('snapshot-test-a','analysis-evidence/A/private.json',{large:'not a workbench document'});
  await insert('snapshot-test-b','manifest.json',{cases:['B']});
  const first=await readWorkbenchSnapshot(db,'snapshot-test-a');assert.equal(first.length,2);assert.ok(transferred.every(r=>r.content_json));
  const second=await readWorkbenchSnapshot(db,'snapshot-test-a');assert.deepEqual(second,first);
  assert.ok(transferred.every(r=>r.unchanged&&r.content_json===null&&r.content_gzip===null),'unchanged payload bytes are omitted by PostgreSQL, including microsecond timestamps');
  assert.deepEqual((await readWorkbenchSnapshot(db,'snapshot-test-b'))[0].content_json,{cases:['B']});
  await sql.unsafe("UPDATE batch_documents SET revision=revision+1,updated_at=now(),content_json=$1 WHERE workspace='snapshot-test-a' AND path='requirements-state/A.json'",[{text:'new designer edit'}]);
  assert.equal((await readWorkbenchSnapshot(db,'snapshot-test-a')).find(r=>r.path==='requirements-state/A.json').content_json.text,'new designer edit');
  assert.equal(transferred.filter(r=>!r.unchanged).length,1);
  // Even a restore that reuses a revision must not reuse old content.
  await sql.unsafe("UPDATE batch_documents SET updated_at=now(),content_json=$1 WHERE workspace='snapshot-test-a' AND path='requirements-state/A.json'",[{text:'restored'}]);
  assert.equal((await readWorkbenchSnapshot(db,'snapshot-test-a')).find(r=>r.path==='requirements-state/A.json').content_json.text,'restored');
  await sql.unsafe("DELETE FROM batch_documents WHERE workspace='snapshot-test-a' AND path='requirements-state/A.json'");
  assert.equal((await readWorkbenchSnapshot(db,'snapshot-test-a')).length,1);
  await sql.unsafe('INSERT INTO batch_documents(workspace,path,content_gzip) VALUES($1,$2,$3)',['snapshot-test-a','mockups/A.json',gzipSync(JSON.stringify({cards:['image']}))]);
  await readWorkbenchSnapshot(db,'snapshot-test-a');
  const compressed=await readWorkbenchSnapshot(db,'snapshot-test-a');
  assert.deepEqual(JSON.parse(gunzipSync(compressed.find(r=>r.path==='mockups/A.json').content_gzip)),{cards:['image']});
  await assert.rejects(()=>readWorkbenchSnapshot({query:async()=>{throw Error('offline');}},'snapshot-test-a'),/offline/);
 }finally{if(sql)await sql.end();await server.stop();await rm(root,{recursive:true,force:true});}
});
