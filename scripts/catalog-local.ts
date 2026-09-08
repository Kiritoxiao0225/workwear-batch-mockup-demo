import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { catalogDatabase, closeCatalogDatabase, migrateCatalog } from '../lib/server/catalog-database';
import { createCatalogUser } from '../lib/server/catalog-auth';
import { importCatalogManifest } from '../lib/server/catalog-import';

const root = path.resolve('data/catalog-local');
await mkdir(root, { recursive: true, mode: 0o700 });
const configFile = path.join(root, 'credentials.json');
const credentials = existsSync(configFile) ? JSON.parse(await readFile(configFile, 'utf8')) as { databasePassword: string; email: string; password: string }
  : { databasePassword: randomBytes(24).toString('hex'), email: 'local@example.test', password: randomBytes(16).toString('hex') };
if (!existsSync(configFile)) await writeFile(configFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
process.env.CATALOG_DATABASE_URL = `postgresql://catalog_local:${credentials.databasePassword}@127.0.0.1:55439/postgres`;
process.env.CATALOG_LOCAL_OBJECT_ROOT = path.join(root, 'objects');
process.env.CATALOG_LOGIN_EMAIL = credentials.email;
process.env.CATALOG_AUTH_MODE = 'open';
process.env.CATALOG_NEXT_DIST_DIR = '.next-catalog';
process.env.CATALOG_APP_ORIGIN = 'http://127.0.0.1:3177';
const database = new EmbeddedPostgres({ databaseDir: path.join(root, 'postgres'), user: 'catalog_local', password: credentials.databasePassword, port: 55439, persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: message => console.error(message) });
let web: ReturnType<typeof spawn> | undefined;
let stopping = false;
async function stop() { if (stopping) return; stopping = true; web?.kill('SIGTERM'); await closeCatalogDatabase(); await database.stop(); }
process.on('SIGINT', () => void stop().then(() => process.exit(0)));
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
try {
  if (!existsSync(path.join(root, 'postgres/PG_VERSION'))) await database.initialise();
  await database.start();
  await migrateCatalog();
  const account = await catalogDatabase().query('SELECT id FROM users WHERE email=$1', [credentials.email]);
  if (!account.rowCount) await createCatalogUser(credentials.email, '本地验收', credentials.password, 'admin');
  const manifest = process.argv[2];
  if (manifest) {
    let completed = 0;
    const result = await importCatalogManifest(JSON.parse(await readFile(manifest, 'utf8')), message => { completed++; if (completed % 25 === 0 || message.startsWith('失败')) console.log(message); });
    console.log(JSON.stringify(result));
    if (result.counts.some(c => c.status === 'failed')) throw new Error('部分素材导入失败，请查看 import_items 并单独重试');
  }
  console.log(`本地 PostgreSQL 已就绪；登录信息：${configFile}`);
  web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3177'], { stdio: 'inherit', env: process.env });
  await new Promise<void>(resolve => web!.once('exit', () => resolve()));
} finally { await stop(); }
