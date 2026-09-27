import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readdir, readFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { CATALOG_BACKUP_TABLES, CATALOG_BACKUP_EXCLUDED_TABLES } from './catalog-backup';
import { catalogTransaction } from './catalog-database';

export async function localBackupMigrations() {
  const directory = path.join(process.cwd(), 'db/migrations');
  return Promise.all((await readdir(directory)).filter(n => n.endsWith('.sql')).sort().map(async name => ({
    name, sha256: createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex'),
  })));
}

// Preserve the existing v1 JSON and checksum contract. The snapshot and compressed
// archive live in a private temporary directory; only a small cursor batch is decoded at a time.
export async function streamCatalogBackup(directory = process.env.CATALOG_BACKUP_TMPDIR || tmpdir()) {
  const work = await mkdtemp(path.join(directory, 'catalog-backup-'));
  const cleanup = () => rm(work, { recursive: true, force: true });
  const payloadPath = path.join(work, 'payload.json'), archivePath = path.join(work, 'backup.json.gz');
  try {
    const space = await statfs(work);
    const maxBytes = Math.min(2 * 1024 ** 3, Math.floor(space.bavail * space.bsize / 3));
    if (maxBytes < 64 * 1024 ** 2) throw Error('Backup temporary disk space insufficient');
    const expected = await localBackupMigrations();
    const payloadHash = createHash('sha256');
    const file = await open(payloadPath, 'wx', 0o600);
    let payloadBytes = 0;
    const write = async (text: string) => {
      const bytes = Buffer.from(text);
      payloadBytes += bytes.length;
      if (payloadBytes > maxBytes) throw Error('Backup temporary disk budget exceeded');
      payloadHash.update(bytes);
      await file.writeFile(bytes);
    };
    let snapshotAt = '';
    try {
      await catalogTransaction(async db => {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await db.query("SET LOCAL statement_timeout='2min'");
        await db.query("SET LOCAL idle_in_transaction_session_timeout='1min'");
        const migrations = (await db.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows;
        snapshotAt = new Date().toISOString();
        if (JSON.stringify(migrations) !== JSON.stringify(expected)) throw Error('Backup migration manifest mismatch');
        const present = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='garment_catalog' ORDER BY tablename")).rows.map(r => r.tablename as string);
        const covered = [...CATALOG_BACKUP_TABLES, ...CATALOG_BACKUP_EXCLUDED_TABLES];
        if (present.some(t => !covered.includes(t)) || CATALOG_BACKUP_TABLES.some(t => !present.includes(t))) throw Error('Backup table coverage mismatch');
        if (!(await db.query('SELECT 1 FROM users LIMIT 1')).rowCount) throw Error('Refusing uninitialized database backup');
        await write('{"schemaVersion":1,"migrations":' + JSON.stringify(migrations) + ',"tables":{');
        for (const [index, table] of CATALOG_BACKUP_TABLES.entries()) {
          await write((index ? ',' : '') + JSON.stringify(table) + ':[');
          await db.query(`DECLARE backup_rows NO SCROLL CURSOR FOR SELECT row_to_json(t) AS row FROM ${table} t`);
          let first = true;
          while (true) {
            const rows = (await db.query('FETCH FORWARD 16 FROM backup_rows')).rows;
            if (!rows.length) break;
            for (const row of rows) { await write((first ? '' : ',') + JSON.stringify(row.row)); first = false; }
          }
          await db.query('CLOSE backup_rows');
          await write(']');
        }
        await write('}}');
      });
    } finally { await file.close(); }
    // The database transaction has ended before compression or any remote I/O.
    const sha256 = payloadHash.digest('hex'), archiveHash = createHash('sha256'), md5 = createHash('md5');
    let bytes = 0;
    async function* envelope() {
      yield '{"sha256":' + JSON.stringify(sha256) + ',"payload":';
      for await (const chunk of createReadStream(payloadPath)) yield chunk;
      yield '}';
    }
    await pipeline(Readable.from(envelope()), createGzip(), new Transform({
      transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; archiveHash.update(chunk); md5.update(chunk); callback(null, chunk); },
    }), createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
    const digest = md5.digest();
    return { archivePath, snapshotAt, sha256, archiveSHA256: archiveHash.digest('hex'), archiveMD5: digest.toString('hex'),
      contentMD5: digest.toString('base64'), bytes, tables: CATALOG_BACKUP_TABLES.length, payloadBytes, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
