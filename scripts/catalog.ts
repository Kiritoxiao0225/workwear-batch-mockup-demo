import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCatalogManifest, importCatalogManifest, verifyCatalogFiles } from '../lib/server/catalog-import';
import { closeCatalogDatabase, migrateCatalog } from '../lib/server/catalog-database';
import { createCatalogUser } from '../lib/server/catalog-auth';
import { backupCatalog, restoreCatalog } from '../lib/server/catalog-backup';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const [command, ...args] = process.argv.slice(2);
if (['migrate', 'restore'].includes(command) && existsSync('.env.catalog-admin.local')) process.loadEnvFile('.env.catalog-admin.local');
if (['migrate', 'restore'].includes(command) && process.env.CATALOG_DATABASE_MIGRATION_URL) process.env.CATALOG_DATABASE_URL = process.env.CATALOG_DATABASE_MIGRATION_URL;
try {
  if (command === 'manifest') {
    if (args.length !== 2) throw new Error('用法：catalog:manifest <底图汇总目录> <清单输出路径>');
    const manifest = await buildCatalogManifest(args[0]);
    await mkdir(path.dirname(path.resolve(args[1])), { recursive: true });
    await writeFile(args[1], `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ manifest: path.resolve(args[1]), files: manifest.entries.length, bytes: manifest.entries.reduce((sum, e) => sum + e.byteLength, 0), quarantined: manifest.entries.filter(e => e.issue), missingSourceMappings: manifest.entries.filter(e => !e.issue && !e.sources.length).map(e => e.filename), sourceIssues: manifest.sourceIssues }, null, 2));
  } else if (command === 'migrate') console.log({ applied: await migrateCatalog() });
  else if (command === 'backup') {
    if (!args[0]) throw new Error('用法：catalog:backup <备份输出路径>');
    const backup = await backupCatalog();
    await writeFile(args[0], JSON.stringify(backup), { mode: 0o600, flag: 'wx' });
    console.log({ backup: path.resolve(args[0]), sha256: backup.sha256 });
  } else if (command === 'restore') {
    if (!args[0]) throw new Error('用法：catalog:restore <备份路径>，目标必须已建表且没有业务数据');
    console.log(await restoreCatalog(JSON.parse(await readFile(args[0], 'utf8'))));
  }
  else if (command === 'import') {
    if (!args[0]) throw new Error('用法：catalog:import <清单路径>');
    const result = await importCatalogManifest(JSON.parse(await readFile(args[0], 'utf8')), message => console.log(message));
    console.log(JSON.stringify(result, null, 2));
    if (result.counts.some(c => c.status === 'failed' && c.count)) process.exitCode = 1;
  } else if (command === 'verify') console.log(await verifyCatalogFiles());
  else if (command === 'create-user') {
    if (!args[0] || !args[1] || !process.env.CATALOG_USER_PASSWORD) throw new Error('用法：通过环境变量提供 CATALOG_USER_PASSWORD，再执行 catalog:user <邮箱> <姓名>');
    console.log({ userId: await createCatalogUser(args[0], args[1], process.env.CATALOG_USER_PASSWORD, 'admin') });
  } else throw new Error(`未知命令：${command}`);
} finally { await closeCatalogDatabase(); }
