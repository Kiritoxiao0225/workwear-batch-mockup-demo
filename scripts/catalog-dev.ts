import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { catalogDatabase, closeCatalogDatabase } from '../lib/server/catalog-database';
import { catalogStorageConfig } from '../lib/server/catalog-files';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
if (process.argv.length > 2) throw new Error('catalog:dev 只启动云端素材库；导入素材请使用 catalog:import');
if (catalogStorageConfig().backend !== 'oss') throw new Error('catalog:dev 需要 OSS 配置；离线验收请显式使用 catalog:dev:local');
const hostname = new URL(process.env.CATALOG_DATABASE_URL ?? '').hostname;
if (['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) throw new Error('catalog:dev 需要远程数据库；离线验收请使用 catalog:dev:local');
try {
  const result = await catalogDatabase().query("SELECT current_database() AS database, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS encrypted, (SELECT count(*)::int FROM garment_styles) AS styles");
  if (!result.rows[0]?.encrypted) throw new Error('云端数据库连接未加密，停止启动');
  console.log('云端素材库连接已验证：', result.rows[0]);
} finally { await closeCatalogDatabase(); }
process.env.CATALOG_NEXT_DIST_DIR = '.next-catalog';
process.env.CATALOG_APP_ORIGIN ??= 'http://127.0.0.1:3177';
const web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3177'], { stdio: 'inherit', env: process.env });
process.on('SIGINT', () => web.kill('SIGINT'));
process.on('SIGTERM', () => web.kill('SIGTERM'));
web.on('error', error => { console.error('素材库启动失败：', error.message); process.exitCode = 1; });
web.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 0 : 1); });
