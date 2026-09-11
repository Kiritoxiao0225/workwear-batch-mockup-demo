import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { catalogDatabase, catalogTransaction, type CatalogQueryClient } from './catalog-database';
import { catalogOssBrowserSigner, catalogOssObjects } from './catalog-oss';
import { imageStoreConfig, imageStoreRequest, signedImageStoreFile } from './catalog-image-store';

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
  if (process.env.CATALOG_IMAGE_STORAGE === 'zeabur') {
    catalogObjectPrefix();
    return { backend: 'zeabur' as const, bucket: imageStoreConfig().bucket };
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
  if (config.backend === 'zeabur') {
    const legacy = await catalogTransaction(async client => {
      const file = (await client.query("SELECT * FROM files WHERE backend='oss' AND bucket=$1 AND sha256=$2 AND status='ready' AND gc_state='active' FOR UPDATE", [process.env.CATALOG_OSS_BUCKET, hash])).rows[0];
      if (!file) return null;
      if (retain) await retain(client, file.id);
      return { id: file.id as string, width: file.width as number, height: file.height as number, hasAlpha: file.has_alpha as boolean, byteLength: Number(file.byte_length), mimeType: file.mime_type as string, sha256: hash };
    });
    if (legacy) return legacy;
  }
  const existing = await catalogDatabase().query('SELECT id FROM files WHERE backend=$1 AND bucket=$2 AND sha256=$3', [config.backend, config.bucket, hash]);
  let inspected: Awaited<ReturnType<typeof inspectCatalogImage>> | undefined;
  if (!existing.rowCount) {
    inspected = await inspectCatalogImage(bytes);
    const key = `${config.backend !== 'local' ? `${catalogObjectPrefix()}/` : ''}${purpose === 'production' ? 'production/' : ''}objects/${hash.slice(0, 2)}/${hash}`;
    // Commit the pending identity before contacting OSS. Even if the process
    // stops after PUT, retries can still find that object.
    await catalogDatabase().query(`INSERT INTO files(id,backend,bucket,object_key,sha256,mime_type,width,height,byte_length,has_alpha,original_name,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending') ON CONFLICT(backend,bucket,sha256) DO NOTHING`,
    [randomUUID(), config.backend, config.bucket, key, hash, inspected.mimeType, inspected.width, inspected.height, inspected.byteLength, inspected.hasAlpha, originalName]);
  }
  const owner = randomUUID(), deadline = Date.now() + 150_000;
  const descriptor = (file: Record<string, unknown>) => ({ id: file.id as string, width: file.width as number, height: file.height as number,
    hasAlpha: file.has_alpha as boolean, byteLength: Number(file.byte_length), mimeType: file.mime_type as string, sha256: file.sha256 as string });
  // Transactions only claim/finalize metadata. OSS I/O never holds a pool connection.
  while (Date.now() < deadline) {
    const claimed = await catalogTransaction(async client => {
      const file = (await client.query('SELECT * FROM files WHERE backend=$1 AND bucket=$2 AND sha256=$3 FOR UPDATE', [config.backend, config.bucket, hash])).rows[0];
      if (!file) throw new Error('文件登记丢失，请重试');
      if (config.backend !== 'local') assertOssObjectKey(file.object_key);
      if (file.status === 'ready' && file.gc_state === 'active') {
        if (retain) await retain(client, file.id);
        return { file, ready: true };
      }
      if (file.gc_state === 'deleting') throw new Error('文件正在回收，请稍后重试');
      const lease = await client.query(`INSERT INTO production_operations(operation_key,owner,lease_until)
        VALUES($1,$2,now()+interval '2 minutes') ON CONFLICT(operation_key) DO UPDATE
        SET owner=EXCLUDED.owner,lease_until=EXCLUDED.lease_until,updated_at=now()
        WHERE production_operations.lease_until<=now() RETURNING owner`, [`file-upload:${file.id}`, owner]);
      if (!lease.rowCount) return null;
      await client.query("UPDATE files SET status='pending',gc_state='active',error=NULL WHERE id=$1", [file.id]);
      return { file, ready: false };
    });
    if (!claimed) { await delay(250); continue; }
    const { file } = claimed;
    if (claimed.ready) return descriptor(file);
    const key = `file-upload:${file.id}`;
    const heartbeat = setInterval(() => { void catalogDatabase().query("UPDATE production_operations SET lease_until=now()+interval '2 minutes',updated_at=now() WHERE operation_key=$1 AND owner=$2", [key, owner]).catch(() => {}); }, 15_000);
    let versionId: string | null = null, uploaded = false;
    try {
      let saved: Buffer;
      if (config.backend === 'local') {
        const destination = localObjectPath(config.bucket, file.object_key);
        await mkdir(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${owner}.tmp`;
        await writeFile(temporary, bytes); await rename(temporary, destination); saved = await readFile(destination);
      } else if (config.backend === 'zeabur') {
        const response = await imageStoreRequest(file.object_key, 'PUT', bytes);
        const receipt = await response.json();
        if (receipt.sha256 !== hash || receipt.backedUp !== true) throw new Error('图片或独立备份尚未通过校验');
        uploaded = true;
        saved = Buffer.from(await (await imageStoreRequest(file.object_key, 'GET')).arrayBuffer());
      } else {
        const client = catalogOssObjects(config.bucket);
        let exists = false;
        try { const previous = await client.get(file.object_key); if (fileSha256(Buffer.from(previous.content)) !== hash) throw new Error('已有对象内容不匹配'); exists = true; }
        catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'NoSuchKey')) throw error; }
        if (!exists) {
          try {
            const result = await client.put(file.object_key, bytes, { mime: file.mime_type,
              headers: { 'x-oss-forbid-overwrite': 'true', 'x-oss-object-acl': 'private', 'Cache-Control': 'private, max-age=86400' } });
            uploaded = true;
            const header = (result.res.headers as Record<string, unknown>)['x-oss-version-id'];
            versionId = typeof header === 'string' ? header : null;
          } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'FileAlreadyExists')) throw error; }
        }
        const result = await client.get(file.object_key, { versionId: versionId ?? undefined });
        const header = (result.res.headers as Record<string, unknown>)['x-oss-version-id'];
        versionId ??= typeof header === 'string' ? header : null;
        saved = Buffer.from(result.content);
      }
      if (fileSha256(saved) !== hash) throw new Error(`图片上传后 SHA-256 不一致：${originalName}`);
      return await catalogTransaction(async client => {
        await client.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [file.id]);
        const lease = await client.query('SELECT owner FROM production_operations WHERE operation_key=$1 AND owner=$2 AND lease_until>now() FOR UPDATE', [key, owner]);
        if (!lease.rowCount) throw new Error('文件上传租约已过期，请重试读取已上传文件');
        await client.query("UPDATE files SET status='ready',gc_state='active',error=NULL,object_version_id=$2,upload_count=upload_count+$3 WHERE id=$1", [file.id, versionId, uploaded ? 1 : 0]);
        if (retain) await retain(client, file.id);
        await client.query('DELETE FROM production_operations WHERE operation_key=$1 AND owner=$2', [key, owner]);
        return descriptor(file);
      });
    } catch (error) {
      await catalogTransaction(async client => {
        await client.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [file.id]);
        const removed = await client.query('DELETE FROM production_operations WHERE operation_key=$1 AND owner=$2 RETURNING owner', [key, owner]);
        if (removed.rowCount) await client.query("UPDATE files SET status='failed',error=$2 WHERE id=$1 AND status<>'ready'", [file.id, error instanceof Error ? error.message : String(error)]);
      });
      throw error;
    } finally { clearInterval(heartbeat); }
  }
  throw new Error('相同文件仍在上传，请稍后重试；已上传内容会自动复用');
}

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
  else if (file.backend === 'zeabur') {
    if (file.bucket !== imageStoreConfig().bucket) throw new Error('图片存储归属不匹配');
    bytes = Buffer.from(await (await imageStoreRequest(file.object_key, 'GET')).arrayBuffer());
  } else {
    if (file.backend !== 'oss' || process.env.CATALOG_OSS_BUCKET !== file.bucket) throw new Error('文件所属 OSS Bucket 与当前配置不一致');
    assertOssObjectKey(file.object_key);
    const result = await catalogOssObjects(file.bucket).get(file.object_key, { versionId: file.object_version_id ?? undefined });
    bytes = Buffer.from(result.content);
  }
  if (fileSha256(bytes) !== file.sha256) throw new Error(`文件内容校验失败：${id}`);
  return { file, bytes };
}
export async function signedCatalogFile(id: string) {
  const file = await catalogFile(id);
  if (file.backend === 'local') return null;
  if (file.backend === 'zeabur') {
    if (file.bucket !== imageStoreConfig().bucket) throw new Error('图片存储归属不匹配');
    return signedImageStoreFile(file.object_key);
  }
  if (file.backend !== 'oss' || process.env.CATALOG_OSS_BUCKET !== file.bucket) throw new Error('文件所属 OSS Bucket 与当前配置不一致');
  assertOssObjectKey(file.object_key);
  return catalogOssBrowserSigner(file.bucket).signatureUrlV4('GET', 900, { queries: file.object_version_id ? { versionId: file.object_version_id } : {} }, file.object_key);
}

/** One authorized list request signs the visible card thumbnails in one query. */
export async function signedCatalogThumbnails(urls: string[]) {
  const config = catalogStorageConfig();
  if (config.backend === 'local' || !urls.length) return new Map<string, string>();
  const ids = [...new Set(urls.map(url => {
    const match = /^\/api\/catalog\/files\/([0-9a-f-]{36})$/.exec(url);
    if (!match) throw new Error('缩略图必须使用素材库文件 ID');
    return match[1];
  }))];
  const { rows } = await catalogDatabase().query("SELECT id,backend,bucket,object_key,object_version_id FROM files WHERE id=ANY($1::uuid[]) AND status='ready' AND gc_state='active'", [ids]);
  let client: ReturnType<typeof catalogOssBrowserSigner> | undefined;
  const signed = new Map<string, string>();
  for (const file of rows) {
    if (file.backend === 'zeabur') {
      if (file.bucket !== imageStoreConfig().bucket) throw new Error('缩略图存储归属不匹配');
      signed.set(`/api/catalog/files/${file.id}`, signedImageStoreFile(file.object_key));
      continue;
    }
    if (file.backend !== 'oss' || file.bucket !== process.env.CATALOG_OSS_BUCKET) throw new Error('缩略图存储与当前配置不一致');
    client ??= catalogOssBrowserSigner(file.bucket);
    assertOssObjectKey(file.object_key);
    signed.set(`/api/catalog/files/${file.id}`, await client.signatureUrlV4('GET', 900, { queries: file.object_version_id ? { versionId: file.object_version_id } : {} }, file.object_key));
  }
  return signed;
}
