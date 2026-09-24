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
type LocalCredentials = { databasePassword: string; email: string; password: string; smsPepper?: string };
const stored = existsSync(configFile) ? JSON.parse(await readFile(configFile, 'utf8')) as LocalCredentials : null;
const credentials: LocalCredentials = stored
  ? { ...stored, smsPepper: stored.smsPepper ?? randomBytes(24).toString('hex') }
  : { databasePassword: randomBytes(24).toString('hex'), email: 'local@example.test', password: randomBytes(16).toString('hex'), smsPepper: randomBytes(24).toString('hex') };
if (!stored || !stored.smsPepper) await writeFile(configFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
process.env.CATALOG_DATABASE_URL = `postgresql://catalog_local:${credentials.databasePassword}@127.0.0.1:55439/postgres`;
process.env.CATALOG_LOCAL_OBJECT_ROOT = path.join(root, 'objects');
// The embedded server speaks plain TCP. Leaving a CA certificate in the environment would
// make the driver demand TLS from it, and .env.local supplies one for the cloud database.
process.env.CATALOG_DATABASE_CA_CERT = '';
// .env.local carries the live AirScript webhook and token, plus real paid-provider keys.
// A throwaway local database is one click away from the customer's delivery data, so the
// connection is opt-in rather than inherited by accident.
const liveWps = process.env.CATALOG_LOCAL_WPS === '1';
if (!liveWps) {
  process.env.WPS_AIRSCRIPT_WEBHOOK = '';
  process.env.WPS_AIRSCRIPT_TOKEN = '';
  process.env.WPS_SOURCE_URL = '';
}
process.env.CATALOG_LOGIN_EMAIL = credentials.email;
// CATALOG_LOCAL_AUTH=1 exercises the real sign-in flow; the default keeps the historical
// password-free workspace so existing local acceptance runs are unchanged.
const realAuth = process.env.CATALOG_LOCAL_AUTH === '1';
// Set explicitly either way: deleting it would let .env.local put `open` back when Next
// loads its own env files in the child process.
process.env.CATALOG_AUTH_MODE = realAuth ? 'password' : 'open';
// Mock providers never send real messages; integration tests consume the returned test codes.
process.env.SMS_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'mock';
process.env.EMAIL_PEPPER = credentials.smsPepper!;
process.env.SMS_PEPPER = credentials.smsPepper!;
process.env.CATALOG_NEXT_DIST_DIR = '.next-catalog';
// Port is configurable so several local instances can run side by side; the origin has to
// match it or same-origin checks reject every write.
const port = process.env.CATALOG_LOCAL_PORT?.trim() || '3177';
process.env.CATALOG_APP_ORIGIN = `http://127.0.0.1:${port}`;
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
  console.log(`打开 http://127.0.0.1:${port}`);
  if (liveWps) {
    console.warn('⚠ 已连接真实 WPS 原表：同步会拉取客户全部记录与附件，工作台的状态切换会写回客户任务。');
  } else {
    console.log('WPS 未连接（本地默认）。要连真实原表请用 CATALOG_LOCAL_WPS=1 启动。');
  }
  console.log(realAuth
    ? `已启用真实登录：邮箱账号 ${credentials.email} / 密码见上述文件；邮箱注册验证码通过集成测试验收`
    : '当前为免密码共享工作台；要试登录流程请用 CATALOG_LOCAL_AUTH=1 重新启动');
  web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', port], { stdio: 'inherit', env: process.env });
  await new Promise<void>(resolve => web!.once('exit', () => resolve()));
} finally { await stop(); }
