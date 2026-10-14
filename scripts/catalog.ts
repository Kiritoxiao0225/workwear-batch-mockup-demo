import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { closeCatalogDatabase, migrateCatalog } from '../lib/server/catalog-database';
import { createCatalogUser } from '../lib/server/catalog-auth';
import { backupCatalog, restoreCatalog } from '../lib/server/catalog-backup';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const [command, ...args] = process.argv.slice(2);
if (['migrate', 'restore'].includes(command) && existsSync('.env.catalog-admin.local')) process.loadEnvFile('.env.catalog-admin.local');
if (['migrate', 'restore'].includes(command) && process.env.CATALOG_DATABASE_MIGRATION_URL) process.env.CATALOG_DATABASE_URL = process.env.CATALOG_DATABASE_MIGRATION_URL;
try {
  if (command === 'migrate') console.log({ applied: await migrateCatalog() });
  else if (command === 'backup') {
    if (!args[0]) throw new Error('用法：catalog:backup <备份输出路径>');
    const backup = await backupCatalog();
    await writeFile(args[0], JSON.stringify(backup), { mode: 0o600, flag: 'wx' });
    console.log({ backup: path.resolve(args[0]), sha256: backup.sha256 });
  } else if (command === 'restore') {
    if (!args[0]) throw new Error('用法：catalog:restore <备份路径>，目标必须已建表且没有业务数据');
    console.log(await restoreCatalog(JSON.parse(await readFile(args[0], 'utf8'))));
  }
  else if (command === 'create-user') {
    if (!args[0] || !args[1] || !process.env.CATALOG_USER_PASSWORD) throw new Error('用法：通过环境变量提供 CATALOG_USER_PASSWORD，再执行 catalog:user <邮箱> <姓名>');
    console.log({ userId: await createCatalogUser(args[0], args[1], process.env.CATALOG_USER_PASSWORD, 'admin') });
  } else throw new Error(`未知命令：${command}`);
} finally { await closeCatalogDatabase(); }
