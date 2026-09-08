import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { catalogDatabaseConfig } from '../lib/server/catalog-database';

process.loadEnvFile('.env.local');
const directory = 'output/production-cloud-20260907';
const credentials = JSON.parse(await readFile('data/catalog-local/credentials.json', 'utf8'));
const manifest = JSON.parse(await readFile(`${directory}/migration-manifest.json`, 'utf8'));
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await readFile('data/wps-production-state.json')), manifest.stateSha256, '本地制作状态已变化，停止切换');
const local = postgres(`postgresql://catalog_local:${encodeURIComponent(credentials.databasePassword)}@127.0.0.1:55439/postgres`, { connection: { search_path: 'garment_catalog,public' } });
const { connectionString, ...options } = catalogDatabaseConfig();
const cloud = postgres(connectionString, options);
try {
  const email = process.env.CATALOG_LOGIN_EMAIL!;
  const [localUser] = await local`SELECT id,email,role,disabled FROM users WHERE email=${email}`;
  const [cloudUser] = await cloud`SELECT id,email,role,disabled FROM users WHERE email=${email}`;
  assert.deepEqual(cloudUser, localUser, '云端与本地工作台身份不一致');
  assert.equal(localUser.disabled, false);
  // Transfer only existing unexpired sessions for the same workspace identity.
  // The cloud password, account roles and other users remain authoritative.
  const sessions = await local`SELECT * FROM sessions WHERE user_id=${localUser.id} AND expires_at>now()`;
  await cloud.begin(async transaction => {
    for (const session of sessions) await transaction`INSERT INTO sessions ${transaction(session)} ON CONFLICT(token_hash) DO NOTHING`;
  });
  for (const session of sessions) assert.equal((await cloud`SELECT user_id FROM sessions WHERE token_hash=${session.token_hash}`)[0]?.user_id, localUser.id);
  const [state] = await cloud`SELECT revision FROM production_states WHERE state_key='main'`;
  assert.equal(Number(state.revision), manifest.revision ?? JSON.parse(await readFile('data/wps-production-state.json', 'utf8')).revision);
  const env = await readFile('.env.local', 'utf8');
  await writeFile(`${directory}/runtime-env.before`, env, { mode: 0o600, flag: 'wx' });
  const updated = env.replace(/^WPS_PRODUCTION_STORAGE=.*\n?/gm, '').replace(/^CATALOG_LOCAL_OBJECT_ROOT=.*\n?/gm, '') + '\nWPS_PRODUCTION_STORAGE=cloud\n';
  await writeFile('.env.local', updated, { mode: 0o600 });
  const receipt = { preparedAt: new Date().toISOString(), copiedSessions: sessions.length, sameWorkspaceIdentity: true, passwordUnchanged: true, sourceSha256: manifest.stateSha256, cloudRevision: state.revision, switchedRuntime: false };
  await writeFile(`${directory}/session-cutover.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally { await local.end(); await cloud.end(); }
