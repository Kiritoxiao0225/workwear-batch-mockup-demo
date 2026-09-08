import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { wpsLinkId } from '@/lib/server/wps-spreadsheet';

type JsonObject = Record<string, unknown>;
const PROTOCOL = 'mockup-wps-1';

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象，实际值：${JSON.stringify(value)}`);
  return value as JsonObject;
}

export function airscriptConfiguration() {
  const webhook = new URL(process.env.WPS_AIRSCRIPT_WEBHOOK?.trim() || 'https://invalid.local');
  const match = /^\/api\/v3\/ide\/file\/([A-Za-z0-9_-]+)\/script\/([A-Za-z0-9_-]+)\/sync_task$/u.exec(webhook.pathname);
  if (!['https://www.kdocs.cn', 'https://365.kdocs.cn'].includes(webhook.origin) || webhook.username || webhook.password || webhook.search || webhook.hash || !match) {
    throw new Error('请使用原表脚本菜单中复制的完整 Webhook 链接（kdocs.cn / sync_task）');
  }
  const expectedFileId = process.env.WPS_DBSHEET_FILE_ID?.trim();
  const sourceLinkId = wpsLinkId(process.env.WPS_SOURCE_URL?.trim() || '');
  if (match[1] !== sourceLinkId && match[1] !== expectedFileId) throw new Error(`脚本所属文件 ${match[1]} 与客户原表 ${sourceLinkId} 不一致，停止读写`);
  const token = process.env.WPS_AIRSCRIPT_TOKEN?.trim();
  if (!token) throw new Error('缺少原表的 AirScript 脚本令牌');
  return { webhook: webhook.href, fileId: match[1], token };
}

async function runScript(input: JsonObject) {
  const config = airscriptConfiguration();
  const response = await fetch(config.webhook, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'AirScript-Token': config.token },
    body: JSON.stringify({ Context: { argv: input } }),
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`原表脚本调用失败：HTTP ${response.status}；请核对脚本令牌及其账号对原表的权限`);
  let parsed: unknown;
  try { parsed = await response.json(); } catch { throw new Error('原表脚本返回非 JSON，请检查 Webhook 链接'); }
  const envelope = objectValue(parsed, '脚本响应');
  if (envelope.error) {
    const message = String(envelope.error).replaceAll(config.token, '[已隐藏]');
    throw new Error(message.includes('WPS_SOURCE_CONFLICT:') ? message.slice(message.indexOf('WPS_SOURCE_CONFLICT:')) : `原表脚本运行失败：${message}`);
  }
  if (envelope.status !== 'finished') throw new Error(`原表脚本未完成：${String(envelope.status)}`);
  const rawResult = objectValue(envelope.data, '脚本执行数据').result;
  const result = objectValue(typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult, '脚本结果');
  if (result.protocol !== PROTOCOL) throw new Error('原表脚本版本不匹配，请粘贴项目提供的完整接入脚本');
  if (typeof result.sheetId !== 'number' || !Number.isSafeInteger(result.sheetId) || result.sheetId <= 0) throw new Error(`脚本数据表 ID 无效：${String(result.sheetId)}`);
  const expectedName = process.env.WPS_DBSHEET_SHEET_NAME?.trim() || '效果图任务管理';
  if (result.sheetName !== expectedName || (input.sheetId !== undefined && result.sheetId !== input.sheetId)) throw new Error(`脚本返回了不同的数据表：${String(result.sheetName)} / ${result.sheetId}`);
  return result;
}

function manifestFingerprint(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(manifestFingerprint).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + manifestFingerprint((value as JsonObject)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
const recordCache = new Map<string, { fingerprint: string; record: JsonObject; readAt: number }>();

let loadedCachePath = '';
function recordCachePath() { return process.env.WPS_AIRSCRIPT_CACHE_PATH || (process.env.VERCEL ? path.join(tmpdir(), 'workwear-wps-airscript-cache.json') : path.join(process.cwd(), 'data', 'wps-airscript-cache.json')); }
async function loadRecordCache() {
  const file = recordCachePath();
  if (loadedCachePath === file) return;
  let saved: unknown;
  try { saved = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') { loadedCachePath = file; return; }
    throw error;
  }
  if (!Array.isArray(saved) || saved.length > 20_000) throw new Error('WPS 增量缓存格式无效');
  for (const entry of saved) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') throw new Error('WPS 缓存索引格式无效');
    const cached = objectValue(entry[1], 'WPS 缓存');
    const record = objectValue(cached.record, 'WPS 缓存记录');
    if (typeof cached.fingerprint !== 'string' || typeof cached.readAt !== 'number' || typeof record.id !== 'string' || typeof record.fields !== 'string' || typeof record.evidence !== 'string') throw new Error('WPS 缓存记录格式无效');
    recordCache.set(entry[0], { fingerprint: cached.fingerprint, readAt: cached.readAt, record });
  }
  loadedCachePath = file;
}
async function saveRecordCache() {
  const file = recordCachePath();
  await mkdir(path.dirname(file), { recursive: true });
  const pending = `${file}.${randomUUID()}.pending`;
  await writeFile(pending, JSON.stringify([...recordCache]), { mode: 0o600 });
  await rename(pending, file);
}

export async function airscriptSource() {
  const result = await runScript({ action: 'metadata' });
  if (!Array.isArray(result.recordIds) || result.recordIds.length > 10_000 || !result.recordIds.every((id) => typeof id === 'string' && id.length > 0)) throw new Error('脚本未返回有效的记录 ID 列表（最多 10000 条）');
  const recordIds = result.recordIds as string[];
  if (new Set(recordIds).size !== recordIds.length) throw new Error('脚本返回重复记录 ID，停止同步');
  if (!Array.isArray(result.fields_schema)) throw new Error('脚本未返回字段定义');
  if (!Array.isArray(result.recordManifest)) throw new Error('原表脚本缺少增量清单，请更新接入脚本');
  const fingerprints: Record<string, string> = {};
  const manifestFields: Record<string, JsonObject> = {};
  for (const entry of result.recordManifest) {
    const record = objectValue(entry, '原表清单');
    if (typeof record.id !== 'string' || !recordIds.includes(record.id) || fingerprints[record.id]) throw new Error(`原表清单 ID 无效或重复：${String(record.id)}`);
    manifestFields[record.id] = objectValue(record.fields, '清单字段');
    fingerprints[record.id] = createHash('sha256').update(manifestFingerprint(manifestFields[record.id])).digest('hex');
  }
  if (Object.keys(fingerprints).length !== recordIds.length) throw new Error('原表清单与记录 ID 数量不一致');
  return {
    fileId: airscriptConfiguration().fileId, fileName: '【测试】效果图任务管理系统v3.5', fileType: 'db', version: '',
    sheetId: result.sheetId as number, sheetName: result.sheetName as string,
    sourceUrl: process.env.WPS_SOURCE_URL!.trim(),
    scriptSnapshot: { recordIds, fields: result.fields_schema, fingerprints, manifestFields },
  };
}

export async function airscriptRecords(source: { sheetId: number; scriptSnapshot: { recordIds: string[]; fields: unknown[]; fingerprints?: Record<string, string> } }, fresh = false) {
  await loadRecordCache();
  const identity = `${airscriptConfiguration().webhook}:${source.sheetId}:${JSON.stringify(source.scriptSnapshot.fields)}:`;
  const results = new Map<string, JsonObject>();
  const pendingIds: string[] = [];
  for (const id of source.scriptSnapshot.recordIds) {
    const cached = recordCache.get(identity + id);
    const fingerprint = source.scriptSnapshot.fingerprints?.[id];
    // Attachment URLs are signed and expire even when the source row is unchanged.
    if (!fresh && fingerprint && cached?.fingerprint === fingerprint && Date.now() - cached.readAt < 5 * 60 * 1000) results.set(id, cached.record);
    else pendingIds.push(id);
  }
  // Read independent groups concurrently; each script retains its exact ID order.
  for (let offset = 0; offset < pendingIds.length; offset += 150) {
    const batches = [pendingIds.slice(offset, offset + 50), pendingIds.slice(offset + 50, offset + 100), pendingIds.slice(offset + 100, offset + 150)].filter((ids) => ids.length);
    const responses = await Promise.allSettled(batches.map((ids) => runScript({ action: 'read', sheetId: source.sheetId, recordIds: ids })));
    for (const [batchIndex, response] of responses.entries()) {
      if (response.status === 'rejected') throw response.reason;
      const result = response.value;
      const ids = batches[batchIndex];
      if (JSON.stringify(result.fields_schema) !== JSON.stringify(source.scriptSnapshot.fields)) throw new Error('同步期间原表字段发生变化，请重新同步');
      if (!Array.isArray(result.records) || result.records.length !== ids.length) throw new Error('脚本返回记录数量不一致，请重新同步');
      for (const [index, entry] of result.records.entries()) {
        const record = objectValue(entry, '脚本记录');
        const id = ids[index];
        if (record.id !== id || (!record.error && (typeof record.fields !== 'string' || typeof record.evidence !== 'string'))) throw new Error(`脚本记录格式或 ID 不匹配：${String(record.id)}`);
        results.set(id, record);
        const fingerprint = source.scriptSnapshot.fingerprints?.[id];
        if (!record.error && fingerprint) recordCache.set(identity + id, { fingerprint, record, readAt: Date.now() });
      }
    }
  }
  if (recordCache.size > 20_000) recordCache.clear();
  if (pendingIds.length) await saveRecordCache();
  return source.scriptSnapshot.recordIds.map((id) => results.get(id)!);
}

export function invalidateAirscriptRecord(sheetId: number, recordId: string) {
  const prefix = `${airscriptConfiguration().webhook}:${sheetId}:`;
  for (const key of recordCache.keys()) if (key.startsWith(prefix) && key.endsWith(`:${recordId}`)) recordCache.delete(key);
}

export async function writeAirscriptStatus(sheetId: number, record: JsonObject, statusFieldName: string, expectedStatus: string, status: string) {
  if (typeof record.evidence !== 'string') throw new Error(`记录 ${String(record.id)} 缺少写前校验信息`);
  await runScript({ action: 'update-status', sheetId, recordId: record.id, statusFieldName, expectedStatus, expectedEvidence: record.evidence, status });
}
