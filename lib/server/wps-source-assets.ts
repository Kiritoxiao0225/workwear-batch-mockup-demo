import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { TaskMaterial } from '@/lib/batch-task-review';
import { saveProductionFile, usesProductionCloud } from './production-storage';

const ROOT = path.join(process.cwd(), 'public', 'uploads', 'wps-source');
const MAX_BYTES = 40 * 1024 * 1024;
const cloudCache = new Map<string, { url: string; previewUrl: string; expiresAt: number }>();

export async function cacheWpsMaterial(material: TaskMaterial): Promise<TaskMaterial> {
  if (!material.url) throw new Error(`素材 ${material.name} (${material.id}) 没有可下载地址`);
  const remote = new URL(material.url);
  if (remote.protocol !== 'https:' || remote.username || remote.password
    || remote.hostname === 'localhost' || /^[\d:[\]]+$/u.test(remote.hostname)) {
    throw new Error(`素材 ${material.id} 下载域名无效：${remote.hostname}`);
  }
  const key = createHash('sha256').update(`${material.id}\n${remote.origin}${remote.pathname}`).digest('hex');
  const manifest = path.join(ROOT, `${key}.json`);
  const cloud = usesProductionCloud();
  const cachedCloud = cloudCache.get(key);
  if (cloud && cachedCloud && cachedCloud.expiresAt > Date.now()) return { ...material, url: cachedCloud.url, previewUrl: cachedCloud.previewUrl, originalUrl: material.url, originalPreviewUrl: material.previewUrl };
  if (!cloud) try {
    const cached = JSON.parse(await readFile(manifest, 'utf8')) as { url: string; previewUrl: string };
    for (const url of [cached.url, cached.previewUrl]) {
      if (typeof url !== 'string' || !/^\/uploads\/wps-source\/[a-f0-9]{64}(?:-preview)?\.(png|jpg|webp)$/u.test(url)) throw new Error(`WPS 素材缓存路径无效：${String(url)}`);
      await access(path.join(process.cwd(), 'public', url));
    }
    return { ...material, ...cached };
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(remote, { cache: 'no-store', signal: AbortSignal.timeout(45_000), redirect: 'error' });
  if (!response.ok) throw new Error(`WPS 素材 ${material.name} 下载失败：HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error(`WPS 素材 ${material.id} 超过 40MB`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`WPS 素材 ${material.id} 没有文件内容`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) throw new Error(`WPS 素材 ${material.id} 超过 40MB`);
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  if (!size) throw new Error(`WPS 素材 ${material.id} 是空文件`);
  const original = Buffer.concat(chunks);
  const metadata = await sharp(original, { failOn: 'error', limitInputPixels: 100_000_000 }).metadata();
  const format = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
  if (!format || !['png', 'jpg', 'webp'].includes(format)) throw new Error(`WPS 素材 ${material.name} 格式 ${format} 暂不支持，请提供 PNG/JPG/WebP`);
  const hash = createHash('sha256').update(original).digest('hex');
  if (cloud) {
    const url = (await saveProductionFile(original, `${hash}.${format}`)).url;
    const previewUrl = size > 8 * 1024 * 1024
      ? (await saveProductionFile(await sharp(original).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer(), `${hash}-preview.webp`)).url
      : url;
    if (cloudCache.size >= 500) cloudCache.delete(cloudCache.keys().next().value!);
    cloudCache.set(key, { url, previewUrl, expiresAt: Date.now() + 15 * 60 * 1000 });
    return { ...material, url, previewUrl, originalUrl: material.url, originalPreviewUrl: material.previewUrl };
  }
  await mkdir(ROOT, { recursive: true });
  await writeFile(path.join(ROOT, `${hash}.${format}`), original);
  const url = `/uploads/wps-source/${hash}.${format}`;
  let previewUrl = url;
  if (size > 8 * 1024 * 1024) {
    const preview = await sharp(original).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
    await writeFile(path.join(ROOT, `${hash}-preview.webp`), preview);
    previewUrl = `/uploads/wps-source/${hash}-preview.webp`;
  }
  const pending = `${manifest}.${process.pid}.pending`;
  await writeFile(pending, JSON.stringify({ url, previewUrl }));
  await rename(pending, manifest);
  return { ...material, url, previewUrl };
}
