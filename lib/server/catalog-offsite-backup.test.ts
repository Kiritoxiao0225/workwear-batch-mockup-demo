import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { catalogSession, catalogDatabase } from './catalog-database';
import { streamCatalogBackup } from './catalog-backup-stream';
import { runOffsiteBackup, backupFresh } from './catalog-offsite-backup';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => ({
 S3Client: vi.fn(function() { return { send, destroy: vi.fn() }; }),
 PutObjectCommand: vi.fn(function(input) { return { kind: 'put', input }; }),
 HeadObjectCommand: vi.fn(function(input) { return { kind: 'head', input }; }),
 ListObjectsV2Command: vi.fn(function(input) { return { kind: 'list', input }; }),
 DeleteObjectCommand: vi.fn(function(input) { return { kind: 'delete', input }; }),
}));
vi.mock('./catalog-database', () => ({ catalogSession: vi.fn(), catalogDatabase: vi.fn() }));
vi.mock('./catalog-backup-stream', () => ({ streamCatalogBackup: vi.fn() }));
const query = vi.fn(), cleanup = vi.fn();
let stored: Buffer, wrong: 'digest' | 'length' | null, directory: string;
beforeEach(async () => {
 vi.clearAllMocks(); wrong = null;
 for (const name of ['ENDPOINT', 'ACCESS_KEY_ID', 'ACCESS_KEY_SECRET', 'BUCKET']) vi.stubEnv('CATALOG_R2_' + name, 'test');
 directory = await mkdtemp(path.join(tmpdir(), 'backup-test-'));
 const bytes = Buffer.from('verified test archive'), file = path.join(directory, 'backup.gz');
 await writeFile(file, bytes);
 vi.mocked(streamCatalogBackup).mockResolvedValue({ archivePath: file, snapshotAt: new Date().toISOString(), sha256: 'payload-sha', archiveSHA256: 'archive-sha', archiveMD5: createHash('md5').update(bytes).digest('hex'), contentMD5: createHash('md5').update(bytes).digest('base64'), bytes: bytes.length, tables: 48, payloadBytes: 100, cleanup });
 query.mockImplementation(async (sql: string) => ({ rows: sql.includes('pg_try_advisory') ? [{ locked: true }] : [], rowCount: 0 }));
 vi.mocked(catalogSession).mockImplementation(operation => operation({ query }));
 vi.mocked(catalogDatabase).mockReturnValue({ query });
 send.mockImplementation(async command => {
  if (command.kind === 'put') {
   const chunks = []; for await (const chunk of command.input.Body) chunks.push(chunk); stored = Buffer.concat(chunks);
   expect(command.input.ContentMD5).toBe(createHash('md5').update(stored).digest('base64'));
   expect(command.input.ContentLength).toBe(stored.length);
  }
  if (command.kind === 'head') return { ContentLength: stored.length + (wrong === 'length' ? 1 : 0), ETag: '"' + (wrong === 'digest' ? 'wrong' : createHash('md5').update(stored).digest('hex')) + '"' };
  return {};
 });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
it('records a verified streamed upload and releases the session lock without an upload transaction', async () => {
 const result = await runOffsiteBackup(true);
 expect(result).toMatchObject({ verification: 'r2-content-md5+head', archiveMD5: createHash('md5').update(stored).digest('hex'), bytes: stored.length });
 expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO batch_documents'))).toBe(true);
 expect(query.mock.calls.at(-1)?.[0]).toContain('pg_advisory_unlock');
 expect(query.mock.calls.some(([sql]) => /BEGIN|COMMIT/.test(sql))).toBe(false);
 expect(cleanup).toHaveBeenCalledOnce();
});
it.each(['digest', 'length'] as const)('preserves previous backups on a stored %s mismatch', async kind => {
 wrong = kind; await expect(runOffsiteBackup(true)).rejects.toThrow('readback mismatch');
 expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO batch_documents'))).toBe(false);
 expect(send.mock.calls.some(([command]) => ['list', 'delete'].includes(command.kind))).toBe(false);
 expect(query.mock.calls.at(-1)?.[0]).toContain('pg_advisory_unlock');
 expect(cleanup).toHaveBeenCalledOnce();
});
it('does not export when another backup owns the lock', async () => {
 query.mockResolvedValue({ rows: [{ locked: false }], rowCount: 1 });
 expect(await runOffsiteBackup(true)).toBeNull(); expect(streamCatalogBackup).not.toHaveBeenCalled();
});
it('uses snapshot age rather than upload completion time for freshness', () => {
 expect(backupFresh({ at: new Date().toISOString(), snapshotAt: new Date(Date.now() - 27 * 3600000).toISOString() })).toBe(false);
 expect(backupFresh({ at: new Date().toISOString(), snapshotAt: new Date(Date.now() - 20 * 3600000).toISOString() })).toBe(true);
 expect(backupFresh({ at: 'invalid' })).toBe(false);
 expect(backupFresh({ at: new Date(Date.now() + 60000).toISOString() })).toBe(false);
});
it('keeps only the newest three backups after a verified upload', async () => {
 const prefix = 'workwear-mockup/prod/backups/scheduled-v1/', name = (day: number) => `${prefix}2026-10-${day}T00-00-00.000Z-${'a'.repeat(64)}.json.gz`;
 const listed = [20, 21, 22, 23, 24].map(name);
 const base = send.getMockImplementation()!;
 send.mockImplementation(async command => command.kind === 'list' ? { Contents: [...listed, `${prefix}notes.txt`].map(Key => ({ Key })) } : base(command));
 await runOffsiteBackup(true);
 const deleted = send.mock.calls.filter(([command]) => command.kind === 'delete').map(([command]) => command.input.Key);
 expect(deleted).toEqual([name(20), name(21)]);
});
