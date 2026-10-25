import { createReadStream } from 'node:fs';
import { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { catalogDatabase, catalogSession } from './catalog-database';
import { streamCatalogBackup } from './catalog-backup-stream';

// One a day, the newest 3 kept (10-25: every 6 hours for 7 days was 28 copies, 15 GB on R2).
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const BACKUP_KEEP = 3;
const prefix = 'workwear-mockup/prod/backups/scheduled-v1/';
export type BackupReceipt = { at: string; snapshotAt?: string; key: string; sha256: string; archiveSHA256: string; archiveMD5?: string; verification?: string; bytes: number; tables: number };
export async function readBackupReceipt(): Promise<BackupReceipt | null> {
  return (await catalogDatabase().query("SELECT content_json FROM batch_documents WHERE workspace='main' AND path='ops/database-backup.json'")).rows[0]?.content_json ?? null;
}
export function backupFresh(receipt: Pick<BackupReceipt, 'at' | 'snapshotAt'> | null, age = BACKUP_INTERVAL_MS + 2 * 60 * 60 * 1000) {
  const timestamp = Date.parse(receipt?.snapshotAt ?? receipt?.at ?? '');
  return Number.isFinite(timestamp) && timestamp <= Date.now() && Date.now() - timestamp < age;
}
export async function runOffsiteBackup(force = false): Promise<BackupReceipt | null> {
  const { CATALOG_R2_ENDPOINT: endpoint, CATALOG_R2_ACCESS_KEY_ID: accessKeyId, CATALOG_R2_ACCESS_KEY_SECRET: secretAccessKey, CATALOG_R2_BUCKET: Bucket } = process.env;
  if (!endpoint || !accessKeyId || !secretAccessKey || !Bucket) throw Error('R2 backup configuration missing');
  const client = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  try {
    return await catalogSession(async db => {
      const lock = await db.query("SELECT pg_try_advisory_lock(hashtext('catalog-offsite-backup')) AS locked");
      if (!lock.rows[0]?.locked) return null;
      try {
        const prior = await readBackupReceipt();
        if (!force && backupFresh(prior, BACKUP_INTERVAL_MS)) return prior;
        const backup = await streamCatalogBackup();
        try {
          const Key = prefix + backup.snapshotAt.replaceAll(':', '-') + '-' + backup.archiveSHA256 + '.json.gz';
          const body = createReadStream(backup.archivePath);
          try {
            await client.send(new PutObjectCommand({ Bucket, Key, Body: body, ContentLength: backup.bytes, ContentMD5: backup.contentMD5, ContentType: 'application/gzip', IfNoneMatch: '*' }), { abortSignal: AbortSignal.timeout(300000) });
          } finally { body.destroy(); }
          const read = await client.send(new HeadObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(30000) });
          if (read.ContentLength !== backup.bytes || read.ETag?.replaceAll('"', '') !== backup.archiveMD5) throw Error('Offsite backup readback mismatch');
          const receipt: BackupReceipt = { at: new Date().toISOString(), snapshotAt: backup.snapshotAt, key: Key, sha256: backup.sha256, archiveSHA256: backup.archiveSHA256, archiveMD5: backup.archiveMD5, verification: 'r2-content-md5+head', bytes: backup.bytes, tables: backup.tables };
          await db.query(`INSERT INTO batch_documents(workspace,path,content_json) VALUES('main','ops/database-backup.json',$1)
            ON CONFLICT(workspace,path) DO UPDATE SET content_json=EXCLUDED.content_json,content_gzip=NULL,revision=batch_documents.revision+1,updated_at=now()`, [receipt]);
          // Cleanup failure does not invalidate an already verified and recorded backup.
          try {
            let token: string | undefined;
            const archives: string[] = [];
            do {
              const list = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }), { abortSignal: AbortSignal.timeout(30000) });
              for (const item of list.Contents || []) if (item.Key && /^\d{4}-\d{2}-\d{2}T[\d.-]+Z-[a-f0-9]{64}\.json\.gz$/.test(item.Key.slice(prefix.length))) archives.push(item.Key);
              token = list.IsTruncated ? list.NextContinuationToken : undefined;
            } while (token);
            // Named by snapshot time, so the newest sort last; the one just made is always among them.
            for (const old of archives.sort().slice(0, -BACKUP_KEEP)) if (old !== Key) await client.send(new DeleteObjectCommand({ Bucket, Key: old }), { abortSignal: AbortSignal.timeout(30000) });
          } catch { console.error('[database-backup] retention cleanup failed; verified archive retained'); }
          return receipt;
        } finally { await backup.cleanup(); }
      } finally { await db.query("SELECT pg_advisory_unlock(hashtext('catalog-offsite-backup'))"); }
    });
  } finally { client.destroy(); }
}
