import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import EmbeddedPostgres from 'embedded-postgres';
import { sweepUploadChunks } from '../runtime/chunk-sweep.mjs';

test('上传分片：只删超过一天的三类分片，任务状态、清单和新分片都不动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chunk-sweep-'));
  const probe = createServer(); await new Promise(ok => probe.listen(0, '127.0.0.1', ok)); const port = probe.address().port; await new Promise(ok => probe.close(ok));
  const password = randomBytes(24).toString('hex');
  const server = new EmbeddedPostgres({ databaseDir: join(root, 'pg'), user: 'test', password, port, persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} });
  let sql;
  try {
    await server.initialise(); await server.start();
    sql = postgres({ host: '127.0.0.1', port, user: 'test', password, database: 'postgres', max: 1 });
    await sql.unsafe('CREATE TABLE batch_documents(workspace text,path text,revision bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),content_json jsonb,content_gzip bytea,PRIMARY KEY(workspace,path))');
    const db = { query: async (text, args) => { const rows = await sql.unsafe(text, args); return { rows, rowCount: rows.count }; } };
    const put = (workspace, path, hoursAgo) => sql.unsafe("INSERT INTO batch_documents(workspace,path,content_json,updated_at) VALUES($1,$2,'{}',now()-make_interval(hours=>$3))", [workspace, path, hoursAgo]);
    await put('t-a', 'intake-chunks/1111/0.json', 30);
    await put('t-a', 'upload-chunks/2222/0.json', 30);
    await put('t-a', 'production-jobs/job-1/edit-upload/req-1/0.json', 30);
    await put('t-b', 'intake-chunks/3333/0.json', 30);
    await put('t-a', 'intake-chunks/4444/0.json', 2);
    await put('t-a', 'production-jobs/job-1/state.json', 30);
    await put('t-a', 'manifest.json', 30);
    await put('t-a', 'requirements-state/A.json', 30);
    assert.equal(await sweepUploadChunks({ db, batch: 2, pauseMs: 0 }), 4, '分批删也能删完');
    const left = (await sql.unsafe('SELECT workspace, path FROM batch_documents ORDER BY workspace, path')).map(r => `${r.workspace}:${r.path}`);
    assert.deepEqual(left, ['t-a:intake-chunks/4444/0.json', 't-a:manifest.json', 't-a:production-jobs/job-1/state.json', 't-a:requirements-state/A.json']);
    assert.equal(await sweepUploadChunks({ db }), 0);
  } finally {
    await sql?.end();
    await server.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
