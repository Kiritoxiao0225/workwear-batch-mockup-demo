import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { catalogOssBrowserSigner, catalogOssObjects } from './catalog-oss';

export function fileSha256(bytes: Buffer | string) { return createHash('sha256').update(bytes).digest('hex'); }
export function catalogObjectPrefix(value = process.env.CATALOG_OSS_PREFIX) {
  const prefix = value ?? 'workwear-mockup/prod';
  if (!/^[a-z0-9][a-z0-9/-]*[a-z0-9]$/.test(prefix) || prefix.includes('//')) throw new Error(`CATALOG_OSS_PREFIX 无效：${prefix}`);
  return prefix;
}
function assertOssObjectKey(key: string) {
  const suffix = key.slice(catalogObjectPrefix().length + 1);
  if (!key.startsWith(`${catalogObjectPrefix()}/`) || !/^(?:production\/)?objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(suffix)) throw new Error(`文件不属于当前项目的 OSS 目录：${key}`);
}
export function catalogStorageConfig() {
  const local = process.env.CATALOG_LOCAL_OBJECT_ROOT;
  if (local) {
    if (process.env.NODE_ENV === 'production') throw new Error('生产环境禁止使用 CATALOG_LOCAL_OBJECT_ROOT');
    return { backend: 'local' as const, bucket: path.resolve(local) };
  }
  const bucket = process.env.CATALOG_OSS_BUCKET;
  if (!bucket || !process.env.CATALOG_OSS_REGION || !process.env.CATALOG_OSS_ACCESS_KEY_ID || !process.env.CATALOG_OSS_ACCESS_KEY_SECRET) throw new Error('尚未配置 CATALOG_OSS_BUCKET / REGION / ACCESS_KEY_ID / ACCESS_KEY_SECRET');
  catalogObjectPrefix();
  return { backend: 'oss' as const, bucket };
}
function localObjectPath(bucket: string, key: string) {
  if (!/^(?:production\/)?objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key)) throw new Error(`文件 object_key 无效：${key}`);
  const config = catalogStorageConfig();
  if (config.backend !== 'local' || config.bucket !== bucket) throw new Error('文件所属本地存储与当前配置不一致');
  return path.join(bucket, key);
}
export async function inspectCatalogImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error(`图片大小超出 1 B–64 MiB：${bytes.length}`);
  const metadata = await sharp(bytes, { failOn: 'error', limitInputPixels: 80_000_000 }).metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '') || !metadata.width || !metadata.height) throw new Error(`不支持的图片格式：${metadata.format}`);
  // Decode the complete image, not just its header, before accepting an upload.
  await sharp(bytes, { failOn: 'error', limitInputPixels: 80_000_000 }).stats();
  return { sha256: fileSha256(bytes), width: metadata.width, height: metadata.height, hasAlpha: metadata.hasAlpha ?? false, byteLength: bytes.length, mimeType: `image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}` };
}
export async function saveCatalogFile(bytes: Buffer, originalName: string, purpose: 'catalog' | 'production' = 'catalog',
  retain?: (client: CatalogQueryClient, id: string) => Promise<void>) {
  const config = catalogStorageConfig();
  const hash = fileSha256(bytes);
  const existing = await catalogDatabase().query('SELECT id FROM files WHERE backend=$1 AND bucket=$2 AND sha256=$3', [config.backend, config.bucket, hash]);
  let inspected: Awaited<ReturnType<typeof inspectCatalogImage>> | undefined;
  if (!existing.rowCount) {
    inspected = await inspectCatalogImage(bytes);
    const key = `${config.backend === 'oss' ? `${catalogObjectPrefix()}/` : ''}${purpose === 'production' ? 'production/' : ''}objects/${hash.slice(0, 2)}/${hash}`;
    // Commit the pending identity before contacting OSS. Even if the process
    // stops after PUT, retries can still find that object.
    await catalogDatabase().query(`INSERT INTO files(id,backend,bucket,object_key,sha256,mime_type,width,height,byte_length,has_alpha,original_name,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending') ON CONFLICT(backend,bucket,sha256) DO NOTHING`,
    [randomUUID(), config.backend, config.bucket, key, hash, inspected.mimeType, inspected.width, inspected.height, inspected.byteLength, inspected.hasAlpha, originalName]);
  }
  return catalogTransaction(async client => {
    // Use this connection for all SQL while holding the lock; never wait for another pool slot.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`file:${config.backend}:${config.bucket}:${hash}`]);
    const saved = await saveLocked(client);
    if (retain) await retain(client, saved.id);
    return saved;
  });
  async function saveLocked(client: ReturnType<typeof catalogDatabase>) {
  const config = catalogStorageConfig();
  const known = await client.query("SELECT id,object_key,width,height,has_alpha,byte_length,mime_type,sha256 FROM files WHERE backend=$1 AND bucket=$2 AND sha256=$3 AND status='ready' AND gc_state='active' FOR SHARE", [config.backend, config.bucket, fileSha256(bytes)]);
  if (known.rowCount) {
    const file = known.rows[0];
    if (config.backend === 'oss') assertOssObjectKey(file.object_key);
    return { id: file.id as string, width: file.width as number, height: file.height as number, hasAlpha: file.has_alpha as boolean, byteLength: Number(file.byte_length), mimeType: file.mime_type as string, sha256: file.sha256 as string };
  }
  const metadata = inspected ?? await inspectCatalogImage(bytes);
  const objectKey = `${config.backend === 'oss' ? `${catalogObjectPrefix()}/` : ''}${purpose === 'production' ? 'production/' : ''}objects/${metadata.sha256.slice(0, 2)}/${metadata.sha256}`;
  const inserted = await client.query(`INSERT INTO files(id,backend,bucket,object_key,sha256,mime_type,width,height,byte_length,has_alpha,original_name,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending') ON CONFLICT(backend,bucket,sha256) DO UPDATE SET sha256=EXCLUDED.sha256 RETURNING id,status,object_key,gc_state`,
  [randomUUID(), config.backend, config.bucket, objectKey, metadata.sha256, metadata.mimeType, metadata.width, metadata.height, metadata.byteLength, metadata.hasAlpha, originalName]);
  const file = inserted.rows[0];
  if (file.gc_state === 'deleting') throw new Error('文件正在回收，请稍后重试');
  if (file.status === 'ready' && file.gc_state === 'active') return { id: file.id as string, ...metadata };
  const storedKey = file.object_key as string;
  try {
    let versionId: string | null = null;
    let saved: Buffer;
    if (config.backend === 'local') {
      const destination = localObjectPath(config.bucket, storedKey);
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes); await rename(temporary, destination); saved = await readFile(destination);
    } else {
      const objectClient = catalogOssObjects(config.bucket);
      // A previous response may have been lost after OSS accepted the file. Read it before retrying PUT.
      let exists = false;
      try { const existing = await objectClient.get(storedKey); if (fileSha256(Buffer.from(existing.content)) !== metadata.sha256) throw new Error('已有对象内容不匹配'); exists = true; }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'NoSuchKey')) throw error; }
      try {
        const uploaded = exists ? null : await objectClient.put(storedKey, bytes, { mime: metadata.mimeType,
          headers: { 'x-oss-forbid-overwrite': 'true', 'x-oss-object-acl': 'private', 'Cache-Control': 'private, max-age=86400' } });
        const header = (uploaded?.res.headers as Record<string, unknown> | undefined)?.['x-oss-version-id'];
        if (uploaded) await client.query('UPDATE files SET upload_count=upload_count+1 WHERE id=$1', [file.id]);
        versionId = typeof header === 'string' ? header : null;
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'FileAlreadyExists')) throw error;
      }
      const downloaded = await objectClient.get(storedKey, { versionId: versionId ?? undefined });
      const header = (downloaded.res.headers as Record<string, unknown>)['x-oss-version-id'];
      versionId ??= typeof header === 'string' ? header : null;
      saved = Buffer.from(downloaded.content);
    }
    if (fileSha256(saved) !== metadata.sha256) throw new Error(`图片上传后 SHA-256 不一致：${originalName}`);
    await client.query("UPDATE files SET status='ready',gc_state='active',error=NULL,object_version_id=$2 WHERE id=$1", [file.id, versionId]);
    return { id: file.id as string, ...metadata };
  } catch (error) {
    await client.query("UPDATE files SET status='failed',error=$2 WHERE id=$1 AND status <> 'ready'", [file.id, error instanceof Error ? error.message : String(error)]);
    throw error;
  }
}}

export async function catalogFile(id: string) {
  const found = await catalogDatabase().query("SELECT * FROM files WHERE id=$1 AND status='ready'", [id]);
  if (!found.rowCount) throw new Error(`文件不存在或未通过上传校验：${id}`);
  if (found.rows[0].gc_state && found.rows[0].gc_state !== 'active') throw new Error(`文件正在回收：${id}`);
  return found.rows[0];
}
export async function readCatalogFile(id: string) {
  const file = await catalogFile(id);
  let bytes: Buffer;
  if (file.backend === 'local') bytes = await readFile(localObjectPath(file.bucket, file.object_key));
  else {
    const config = catalogStorageConfig();
    if (config.backend !== 'oss' || config.bucket !== file.bucket) throw new Error('文件所属 OSS Bucket 与当前配置不一致');
    assertOssObjectKey(file.object_key);
    const result = await catalogOssObjects(config.bucket).get(file.object_key, { versionId: file.object_version_id ?? undefined });
    bytes = Buffer.from(result.content);
  }
  if (fileSha256(bytes) !== file.sha256) throw new Error(`文件内容校验失败：${id}`);
  return { file, bytes };
}
export async function signedCatalogFile(id: string) {
  const file = await catalogFile(id);
  if (file.backend === 'local') return null;
  const config = catalogStorageConfig();
  if (config.backend !== 'oss' || config.bucket !== file.bucket) throw new Error('文件所属 OSS Bucket 与当前配置不一致');
  assertOssObjectKey(file.object_key);
  return catalogOssBrowserSigner(config.bucket).signatureUrlV4('GET', 900, { queries: file.object_version_id ? { versionId: file.object_version_id } : {} }, file.object_key);
}

/** One authorized list request signs the visible card thumbnails in one query. */
export async function signedCatalogThumbnails(urls: string[]) {
  const config = catalogStorageConfig();
  if (config.backend !== 'oss' || !urls.length) return new Map<string, string>();
  const ids = [...new Set(urls.map(url => {
    const match = /^\/api\/catalog\/files\/([0-9a-f-]{36})$/.exec(url);
    if (!match) throw new Error('缩略图必须使用素材库文件 ID');
    return match[1];
  }))];
  const { rows } = await catalogDatabase().query("SELECT id,backend,bucket,object_key,object_version_id FROM files WHERE id=ANY($1::uuid[]) AND status='ready' AND gc_state='active'", [ids]);
  const client = catalogOssBrowserSigner(config.bucket);
  const signed = new Map<string, string>();
  for (const file of rows) {
    if (file.backend !== 'oss' || file.bucket !== config.bucket) throw new Error('缩略图存储与当前配置不一致');
    assertOssObjectKey(file.object_key);
    signed.set(`/api/catalog/files/${file.id}`, await client.signatureUrlV4('GET', 900, { queries: file.object_version_id ? { versionId: file.object_version_id } : {} }, file.object_key));
  }
  return signed;
}
