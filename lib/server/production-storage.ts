import { INTERNAL_TENANT_ID } from './catalog-auth';
import { registerFileRef } from './file-authorization';
import type { CatalogQueryClient } from './catalog-database';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { catalogUser } from './catalog-auth';
import { readCatalogFile, saveCatalogFile } from './catalog-files';
import { productionFileId, productionFileUrl } from '@/lib/production-file-url';

export const usesProductionCloud = () => process.env.WPS_PRODUCTION_STORAGE === 'cloud';
export const productionStateKey = () => process.env.WPS_PRODUCTION_STATE_KEY || 'main';
export async function productionUser(request: Request | undefined, write = false) {
  if (!usesProductionCloud()) return null;
  if (!request) throw new Error('云端生产接口需要登录');
  return catalogUser(new NextRequest(request.url, { method: request.method, headers: request.headers }), write);
}
export async function readProductionFile(url: string) {
  const id = productionFileId(url);
  if (id) return (await readCatalogFile(id)).bytes;
  const match = /^\/uploads\/(logos|mockups|wps-source)\/([^/\\]+)$/u.exec(url);
  if (!match || ['.', '..'].includes(match[2])) throw new Error(`不支持的生产文件地址：${url}`);
  if (usesProductionCloud()) throw new Error(`云端状态仍引用本地文件，请完成迁移：${url}`);
  return readFile(path.join(process.cwd(), 'public', 'uploads', match[1], match[2]));
}
export async function saveProductionFile(bytes: Buffer, name: string, retain?: (client: CatalogQueryClient, id: string) => Promise<void>, tenantId = INTERNAL_TENANT_ID) {
  const file = await saveCatalogFile(bytes, name, 'production', retain);
  // Registered here rather than at each call site: a production file nobody references
  // cannot be read back, and the WPS workflow writes these from a dozen places.
  await registerFileRef(file.id, tenantId, 'production', name);
  return { ...file, url: productionFileUrl(file.id), originalName: name };
}
/** Used at import/cutover and for server-generated data URLs; existing cloud IDs are untouched. */
export async function persistProductionReferences<T>(value: T): Promise<T> {
  const saved = new Map<string, Promise<string>>();
  const waiting: Array<() => void> = [];
  let active = 0;
  async function upload(task: () => Promise<string>) {
    if (active >= 3) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try { return await task(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  }
  // Drain all scheduled writes on failure, without publishing a partial object.
  async function all<T>(promises: Promise<T>[]): Promise<T[]> {
    const results = await Promise.allSettled(promises);
    return results.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
  }
  async function visit(item: unknown): Promise<unknown> {
    if (typeof item === 'string') {
      const local = /^\/uploads\/(logos|mockups|wps-source)\/([^/\\]+)$/u.exec(item);
      const inline = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/u.exec(item);
      if (!local && !inline) return item;
      if (local && ['.', '..'].includes(local[2])) throw new Error('无效文件路径');
      if (!saved.has(item)) saved.set(item, upload(async () => {
        const bytes = local ? await readFile(path.join(process.cwd(), 'public', 'uploads', local[1], local[2])) : Buffer.from(inline![2], 'base64');
        return (await saveProductionFile(bytes, local?.[2] ?? `generated.${inline![1]}`)).url;
      }));
      return saved.get(item)!;
    }
    if (Array.isArray(item)) return all(item.map(visit));
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      if ('id' in record && 'description' in record && 'url' in record && 'previewUrl' in record) {
        result.originalUrl = record.originalUrl ?? record.url;
        result.originalPreviewUrl = record.originalPreviewUrl ?? record.previewUrl;
      }
      const entries = await all(Object.entries(item).map(async ([key, value]) => [key, ['originalUrl', 'originalPreviewUrl'].includes(key) ? value : await visit(value)] as const));
      for (const [key, value] of entries) result[key] = value;
      return result;
    }
    return item;
  }
  return await visit(value) as T;
}
/** Keep each role and layer slot, including hidden layers and masks, when sharing file bytes. */
export function productionFileReferences(value: unknown, prefix = ''): { ref: string; id: string }[] {
  if (typeof value === 'string') {
    const id = productionFileId(value);
    if (id) return [{ ref: prefix, id }];
    if (/^\/uploads\/(logos|mockups|wps-source)\//u.test(value)) throw new Error(`尚未迁移的文件引用：${prefix}`);
    if (/^(?:data:image\/|blob:)/u.test(value)) throw new Error(`尚未保存的图层文件：${prefix}`);
    return [];
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).filter(([key]) => !['originalUrl', 'originalPreviewUrl'].includes(key)).flatMap(([key, entry]) => productionFileReferences(entry, `${prefix}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
}
