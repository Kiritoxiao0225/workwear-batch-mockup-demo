import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import type { QueryResultRow } from 'pg';
import postgres from 'postgres';
import { after } from 'next/server';

export function catalogDatabaseConfig(environment: Record<string, string | undefined> = process.env) {
  const connectionString = environment.CATALOG_DATABASE_URL;
  if (!connectionString) throw new Error('尚未配置 CATALOG_DATABASE_URL，请先配置 PostgreSQL 并执行 catalog:migrate');
  let url: URL;
  try { url = new URL(connectionString); }
  catch { throw new Error('CATALOG_DATABASE_URL 不是有效的数据库连接地址'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('CATALOG_DATABASE_URL 必须使用 postgresql 协议');
  const certificate = environment.CATALOG_DATABASE_CA_CERT?.replaceAll('\\n', '\n').trim();
  const sslParameters = [...url.searchParams.keys()].filter(key => key.startsWith('ssl'));
  if (certificate && sslParameters.length) throw new Error(`配置 CATALOG_DATABASE_CA_CERT 时，连接地址不能同时指定 ${sslParameters.join(', ')}`);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && !certificate && url.searchParams.get('sslmode') !== 'verify-full') throw new Error(`远程数据库 ${url.hostname} 必须配置 CA 证书或 sslmode=verify-full`);
  return {
    connectionString, max: environment.VERCEL === '1' ? 1 : 5, connect_timeout: 10, idle_timeout: 30,
    connection: { application_name: 'workwear-mockup', search_path: 'garment_catalog,public', statement_timeout: 30000 },
    ...(!local ? { socket: () => new Promise<Socket>((resolve, reject) => {
      const port = Number(url.port || 5432);
      const socket = createConnection({ host: url.hostname, port, family: 4, timeout: 10000 });
      const failed = (error: Error) => { socket.destroy(); reject(error); };
      const timedOut = () => failed(new Error(`数据库连接超时：${url.hostname}:${port}`));
      socket.once('error', failed);
      socket.once('timeout', timedOut);
      socket.once('connect', () => {
        socket.removeListener('error', failed);
        socket.removeListener('timeout', timedOut);
        socket.setTimeout(0);
        Object.assign(socket, { host: url.hostname, port });
        resolve(socket);
      });
    }) } : {}),
    ...(certificate ? { ssl: { ca: certificate, rejectUnauthorized: true,
      checkServerIdentity: (...args: Parameters<typeof checkServerIdentity>) => checkServerIdentity(url.hostname, args[1]) } } : {}),
  };
}

type CatalogConnection = ReturnType<typeof postgres>;
export type CatalogQueryClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: QueryResultRow[]; rowCount: number }> };
let connection: CatalogConnection | undefined;
let activeOperations = 0;
function connectedDatabase() {
  if (!connection) {
    const { connectionString, ...options } = catalogDatabaseConfig();
    connection = postgres(connectionString, options);
  }
  return connection;
}
function queryClient(client: Pick<CatalogConnection, 'unsafe'>): CatalogQueryClient {
  return { query: async (sql, values = []) => {
    const rows = await client.unsafe(sql, values as postgres.ParameterOrJSON<never>[]);
    return { rows: [...rows], rowCount: rows.count ?? rows.length };
  } };
}
export function catalogDatabase() {
  return { query: (sql: string, values?: unknown[]) => withDatabase(client => queryClient(client).query(sql, values)) };
}
async function withDatabase<T>(operation: (client: CatalogConnection) => Promise<T>): Promise<T> {
  const pool = connectedDatabase();
  if (process.env.VERCEL === '1') {
    // Serverless suspension can freeze the driver's idle timer. Close idle pools
    // during the request lifecycle; never close another request's active transaction.
    after(async () => {
      if (connection !== pool || activeOperations !== 0) return;
      connection = undefined;
      await pool.end();
    });
  }
  activeOperations++;
  try { return await operation(pool); }
  finally { activeOperations--; }
}
export async function catalogTransaction<T>(operation: (client: CatalogQueryClient) => Promise<T>): Promise<T> {
  return withDatabase(async pool => {
    const reserved = await pool.reserve();
    const client = queryClient(reserved);
    try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { reserved.release(); }
  });
}
export async function closeCatalogDatabase() { const pool = connection; connection = undefined; if (pool) await pool.end(); }
export async function migrateCatalog() {
  return catalogTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('garment_catalog_migrations'))");
    await client.query('CREATE SCHEMA IF NOT EXISTS garment_catalog');
    await client.query('CREATE TABLE IF NOT EXISTS garment_catalog.schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = path.join(process.cwd(), 'db/migrations');
    const applied: string[] = [];
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(path.join(directory, name), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query('SELECT sha256 FROM garment_catalog.schema_migrations WHERE name=$1', [name]);
      if (previous.rowCount) { if (previous.rows[0].sha256 !== hash) throw new Error(`已执行迁移 ${name} 的内容发生变化`); continue; }
      await client.query(sql);
      await client.query('INSERT INTO garment_catalog.schema_migrations(name,sha256) VALUES($1,$2)', [name, hash]);
      applied.push(name);
    }
    return applied;
  });
}
