import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { closeDatabase, initializeLocalDatabase } from '../adapters/postgres';
import { seedLocalOrders } from './seed';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.join(project, 'output/batch-mockup-local');
await mkdir(root, { recursive: true, mode: 0o700 });
const secretFile = path.join(root, 'local-credentials.json');
const password = existsSync(secretFile) ? (JSON.parse(await readFile(secretFile, 'utf8')) as {
    password: string;
}).password : randomBytes(24).toString('hex');
if (!existsSync(secretFile))
    await writeFile(secretFile, JSON.stringify({ password }), { mode: 0o600, flag: 'wx' });
const port = Number(process.env.BATCH_LOCAL_PORT ?? 3196), dbPort = Number(process.env.BATCH_LOCAL_DB_PORT ?? 55448);
const clean: NodeJS.ProcessEnv = { NODE_ENV: 'development', PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NEXT_TELEMETRY_DISABLED: '1', BATCH_MOCKUP_MODE: 'offline', BATCH_MOCKUP_DATABASE_URL: `postgresql://batch_local:${password}@127.0.0.1:${dbPort}/postgres`, BATCH_MOCKUP_OBJECT_ROOT: path.join(root, 'objects'), BATCH_MOCKUP_PROJECT_ROOT: project, BATCH_MOCKUP_ORIGIN: `http://127.0.0.1:${port}`, BATCH_MOCKUP_FAULT_TESTING: '1' };
for (const [key, value] of Object.entries(clean))
    if (value !== undefined)
        process.env[key] = value;
const database = new EmbeddedPostgres({ databaseDir: path.join(root, 'postgres'), user: 'batch_local', password, port: dbPort, persistent: true, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'], onLog: () => { }, onError: m => console.error(m) });
const children: ReturnType<typeof spawn>[] = [];
let stopping = false;
async function stop() { if (stopping)
    return; stopping = true; for (const child of children)
    child.kill('SIGTERM'); await Promise.all(children.map(c => new Promise<void>(resolve => { if (c.exitCode !== null)
    return resolve(); c.once('exit', () => resolve()); setTimeout(() => { c.kill('SIGKILL'); resolve(); }, 5000).unref(); }))); await closeDatabase(); await database.stop(); }
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
process.on('SIGINT', () => void stop().then(() => process.exit(0)));
try {
    if (!existsSync(path.join(root, 'postgres/PG_VERSION')))
        await database.initialise();
    await database.start();
    await initializeLocalDatabase();
    await seedLocalOrders(process.argv[2]);
    await closeDatabase();
    children.push(spawn(process.execPath, ['--import', path.join(project, 'node_modules/tsx/dist/loader.mjs'), path.join(project, 'batch-mockup/scripts/worker.ts')], { cwd: project, env: clean, stdio: 'inherit' }));
    children.push(spawn(process.execPath, [path.join(project, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: path.join(project, 'batch-mockup'), env: clean, stdio: 'inherit' }));
    console.log(`本地验收工作台：http://127.0.0.1:${port}/batch-mockup（无生产环境配置）`);
    await Promise.race(children.map(c => new Promise<void>((resolve, reject) => { c.once('error', reject); c.once('exit', code => { if (code === 0)
        resolve();
    else
        reject(new Error(`本地进程退出：${code}`)); }); })));
}
finally {
    await stop();
}
