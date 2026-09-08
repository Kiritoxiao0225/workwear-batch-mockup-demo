import type { SourceTaskRecord, TaskMaterial } from '@/lib/batch-task-review';
import { wpsUserAccessToken } from '@/lib/server/wps-user-oauth';
import { cacheWpsMaterial } from '@/lib/server/wps-source-assets';
import { wpsLinkId } from '@/lib/server/wps-spreadsheet';
import { wpsSourceEvidence } from '@/lib/wps-source';
import { airscriptRecords, airscriptSource, invalidateAirscriptRecord, writeAirscriptStatus } from '@/lib/server/wps-airscript';

const API = 'https://openapi.wps.cn/v7';
const MAX_RECORDS = 10_000;
type JsonObject = Record<string, unknown>;
type FieldSchema = { id: string; name: string; type: string; data?: JsonObject };
type SyncOptions = { pendingOnly?: boolean; recordIds?: string[]; downloadMaterials?: boolean };
const isPendingStatus = (value: unknown) => ['🔴待领取', '待领取'].includes(textValue(value));

export function wpsConfigurationStatus() {
  const mode = process.env.WPS_CONNECTION_MODE?.trim() || 'airscript';
  const required = mode === 'oauth'
    ? ['WPS_APP_ID', 'WPS_APP_KEY', 'WPS_SOURCE_URL', 'WPS_DBSHEET_SHEET_ID']
    : ['WPS_AIRSCRIPT_WEBHOOK', 'WPS_AIRSCRIPT_TOKEN', 'WPS_SOURCE_URL'];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (!['airscript', 'oauth'].includes(mode)) missing.push('WPS_CONNECTION_MODE（仅支持 airscript / oauth）');
  return { configured: !missing.length, missing, mode };
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象，实际值：${JSON.stringify(value)}`);
  return value as JsonObject;
}

async function wpsRequest(endpoint: string, token: string, payload?: unknown): Promise<JsonObject> {
  const response = await fetch(`${API}${endpoint}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    cache: 'no-store', signal: AbortSignal.timeout(30_000),
  });
  let parsed: unknown;
  try { parsed = await response.json(); } catch { throw new Error(`WPS 返回非 JSON：HTTP ${response.status}`); }
  const body = objectValue(parsed, 'WPS 响应');
  if (response.status === 401 || response.status === 403) throw new Error(`WPS_USER_AUTH_REQUIRED: WPS 拒绝访问：HTTP ${response.status}，${String(body.msg)}；请确认应用多维表格权限和账号对原表的权限`);
  if (!response.ok || body.code !== 0) throw new Error(`WPS 请求失败：HTTP ${response.status}，code=${String(body.code)}，${String(body.msg)}`);
  return objectValue(body.data, 'WPS data');
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('；');
  const entry = objectValue(value, 'WPS 字段');
  for (const key of ['value', 'text', 'name', 'display_name', 'title']) {
    if (entry[key] !== undefined) return textValue(entry[key]);
  }
  throw new Error(`WPS 字段不是支持的文本格式：${JSON.stringify(value)}`);
}

function parsedFields(value: unknown): JsonObject {
  if (typeof value !== 'string') throw new Error(`WPS 记录 fields 必须是 JSON 字符串：${JSON.stringify(value)}`);
  return objectValue(JSON.parse(value), 'WPS fields');
}

export function wpsTaskMaterials(recordId: string, value: unknown): TaskMaterial[] {
  if (value === null || value === undefined || value === '') return [];
  const items: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(items)) throw new Error(`记录 ${recordId} 的素材必须是附件数组`);
  return items.map((item, index) => {
    const attachment = objectValue(item, `${recordId} 图${index + 1}`);
    const id = attachment.id ?? attachment.file_id ?? attachment.fileId ?? attachment.attachment_id;
    if (typeof id !== 'string' && typeof id !== 'number') throw new Error(`${recordId} 图${index + 1} 缺少稳定附件 ID`);
    const url = [attachment.url, attachment.download_url, attachment.downloadUrl, attachment.fileData, attachment.src].find((entry) => typeof entry === 'string' && entry.startsWith('https://'));
    if (typeof url !== 'string') throw new Error(`${recordId} 图${index + 1} (${id}) 没有 HTTPS 下载地址`);
    const name = textValue(attachment.fileName ?? attachment.file_name ?? attachment.name ?? `图${index + 1}`);
    return { id: `${recordId}:${String(id)}`, name, description: `WPS 原始素材图${index + 1}：${name}`, url, previewUrl: url };
  });
}

function selectedField(fields: FieldSchema[], aliases: string[], required: boolean) {
  const matches = fields.filter((field) => aliases.includes(field.name));
  if (matches.length > 1) throw new Error(`WPS 字段映射不唯一：${matches.map((field) => field.name).join('、')}`);
  if (!matches.length && required) throw new Error(`WPS 缺少 ${aliases.join('/')}；实际字段：${fields.map((field) => field.name).join('、')}`);
  return matches[0] ?? null;
}

export function wpsFieldMapping(value: unknown) {
  if (!Array.isArray(value)) throw new Error('WPS 响应缺少 fields_schema 数组');
  const fields = value.map((entry) => {
    const field = objectValue(entry, 'WPS 字段定义');
    for (const key of ['id', 'name', 'type']) if (typeof field[key] !== 'string' || !field[key]) throw new Error(`WPS 字段缺少 ${key}：${JSON.stringify(entry)}`);
    return field as FieldSchema;
  });
  const configuredStatus = process.env.WPS_STATUS_FIELD_NAME?.trim();
  const status = selectedField(fields, configuredStatus ? [configuredStatus] : ['任务状态', '制作状态', '设计状态', '状态'], Boolean(configuredStatus));
  const claimWorkflow = status?.type === 'Formula' && status.data?.workflow === 'claim-checkbox-v1';
  const options = status?.type === 'SingleSelect' || claimWorkflow
    ? (Array.isArray(status.data?.items) ? status.data.items.map((item) => textValue(objectValue(item, '状态选项').value)) : []) : [];
  return {
    requirement: selectedField(fields, ['任务要求说明', '任务需求说明', '需求说明'], true)!,
    customer: selectedField(fields, ['客户旺旺ID', '客户ID'], false),
    revision: selectedField(fields, ['修改次数', '修改轮次'], false),
    style: selectedField(fields, ['商品款式', '款式'], false),
    materials: selectedField(fields, ['任务素材图片', '素材图片', '素材图'], true)!,
    status,
    statusWritable: Boolean(status && (claimWorkflow || ['SingleSelect', 'SingleLineText', 'MultiLineText', 'Text'].includes(status.type))),
    claimWorkflow,
    statusOptions: options,
  };
}

async function configuration(token: string) {
  const missing = wpsConfigurationStatus().missing;
  if (missing.length) throw new Error(`WPS_SYNC_NOT_CONFIGURED: 缺少 ${missing.join(', ')}`);
  if (wpsConfigurationStatus().mode === 'airscript') return airscriptSource();
  const sourceUrl = process.env.WPS_SOURCE_URL!.trim();
  const linkId = wpsLinkId(sourceUrl);
  const link = await wpsRequest(`/links/${encodeURIComponent(linkId)}/meta`, token);
  const fileId = typeof link.file_id === 'string' || typeof link.file_id === 'number' ? String(link.file_id) : '';
  if (!fileId) throw new Error(`WPS 链接 ${linkId} 未返回 file_id`);
  const configuredFile = process.env.WPS_DBSHEET_FILE_ID?.trim();
  if (configuredFile && configuredFile !== fileId) throw new Error(`WPS 链接对应文件 ${fileId} 与配置 ${configuredFile} 不一致，停止读写`);
  const file = await wpsRequest(`/files/${encodeURIComponent(fileId)}/meta?with_permission=true`, token);
  if (file.type !== 'db') throw new Error(`WPS 链接应为多维表格，实际类型：${String(file.type)}`);
  const sheetId = Number(process.env.WPS_DBSHEET_SHEET_ID);
  if (!Number.isSafeInteger(sheetId) || sheetId <= 0) throw new Error(`WPS_DBSHEET_SHEET_ID 无效：${process.env.WPS_DBSHEET_SHEET_ID}`);
  return { fileId, sheetId, sourceUrl, fileName: textValue(file.name) || fileId, fileType: 'db', version: String(file.version ?? file.mtime ?? ''), sheetName: process.env.WPS_DBSHEET_SHEET_NAME?.trim() || `数据表 ${sheetId}` };
}

async function rawRecords(token: string, source: Awaited<ReturnType<typeof configuration>>, fresh = false) {
  if ('scriptSnapshot' in source) return { records: await airscriptRecords(source, fresh), mapping: wpsFieldMapping(source.scriptSnapshot.fields) };
  const records: JsonObject[] = [];
  const seenPages = new Set<string>();
  const seenRecords = new Set<string>();
  let schema: unknown;
  let pageToken = '';
  do {
    const page = await wpsRequest(`/coop/dbsheet/${encodeURIComponent(source.fileId)}/sheets/${source.sheetId}/records`, token, {
      page_size: 100, page_token: pageToken, prefer_id: false, text_value: 'original', show_fields_info: true,
    });
    if (!Array.isArray(page.records)) throw new Error('WPS 响应缺少 records 数组');
    if (schema === undefined) schema = page.fields_schema;
    for (const entry of page.records) {
      const record = objectValue(entry, 'WPS 记录');
      if (typeof record.id !== 'string' || !record.id) throw new Error(`WPS 记录缺少 ID：${JSON.stringify(entry)}`);
      if (seenRecords.has(record.id)) throw new Error(`WPS 分页出现重复记录 ${record.id}，请重试同步`);
      seenRecords.add(record.id);
      records.push(record);
    }
    if (records.length > MAX_RECORDS) throw new Error(`WPS 任务超过 ${MAX_RECORDS} 条上限，请限定数据表范围`);
    if (page.page_token !== undefined && typeof page.page_token !== 'string') throw new Error('WPS page_token 必须是字符串');
    pageToken = typeof page.page_token === 'string' ? page.page_token : '';
    if (pageToken && seenPages.has(pageToken)) throw new Error(`WPS 分页游标重复：${pageToken}`);
    seenPages.add(pageToken);
  } while (pageToken);
  return { records, mapping: wpsFieldMapping(schema) };
}

async function sourceTaskRecord(record: JsonObject, source: Awaited<ReturnType<typeof configuration>>, mapping: ReturnType<typeof wpsFieldMapping>, downloadMaterials = true): Promise<SourceTaskRecord> {
  if (record.error) throw new Error(String(record.error));
  const fields = parsedFields(record.fields);
  const id = record.id as string;
  const requirementText = textValue(fields[mapping.requirement.name]);
  // New WPS rows may be saved before their requirement is entered; keep them visible.
  const materials: TaskMaterial[] = [];
  for (const material of wpsTaskMaterials(id, fields[mapping.materials.name])) materials.push(downloadMaterials ? await cacheWpsMaterial(material) : material);
  return {
    recordId: `${source.fileId}:${source.sheetId}:${id}`,
    customerId: mapping.customer ? textValue(fields[mapping.customer.name]) || '未填客户ID' : '未填客户ID',
    revision: mapping.revision ? textValue(fields[mapping.revision.name]) || '未填修改次数' : '未填修改次数',
    productStyleText: mapping.style ? textValue(fields[mapping.style.name]) || '未填商品款式' : '未填商品款式',
    requirementText, materials,
    wpsSource: { fileId: source.fileId, sheetId: source.sheetId, sheetName: source.sheetName,
      statusFieldName: mapping.status?.name ?? null, status: mapping.status ? textValue(fields[mapping.status.name]) : '', statusOptions: mapping.statusOptions,
      statusWritable: mapping.statusWritable && (!mapping.claimWorkflow || mapping.statusOptions.includes(textValue(fields[mapping.status!.name]))),
      statusNote: mapping.claimWorkflow ? '领取或退回通过原表“领取任务”更新；已完成由交付成品决定，已取消由异常标签决定。' : mapping.status?.type === 'Formula' ? '原表公式计算状态，仅供查看。' : undefined },
  };
}

let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function syncWpsSourceTaskRecords(options: SyncOptions) {
  return serialized(async () => {
    const token = wpsConfigurationStatus().mode === 'oauth' ? await wpsUserAccessToken() : '';
    let source = await configuration(token);
    // The existing bridge manifest already contains statuses. Narrow IDs before
    // asking WPS for attachment download links; no bridge installation is needed.
    if ('scriptSnapshot' in source) {
      const snapshot = source.scriptSnapshot;
      const mapping = wpsFieldMapping(snapshot.fields);
      if (options.pendingOnly && !mapping.status) throw new Error('WPS 缺少任务状态，无法只同步待领取任务');
      const ids = snapshot.recordIds.filter(id =>
        (!options.recordIds || options.recordIds.includes(`${source.fileId}:${source.sheetId}:${id}`))
        && (!options.pendingOnly || isPendingStatus(snapshot.manifestFields[id][mapping.status!.name])));
      source = { ...source, scriptSnapshot: { ...snapshot, recordIds: ids } };
    }
    const { records: allRaw, mapping } = await rawRecords(token, source);
    if (options.pendingOnly && !mapping.status) throw new Error('WPS 缺少任务状态，无法只同步待领取任务');
    const raw = allRaw.filter(record =>
      (!options.recordIds || options.recordIds.includes(`${source.fileId}:${source.sheetId}:${record.id}`))
      && (!options.pendingOnly || (record.error || isPendingStatus(parsedFields(record.fields)[mapping.status!.name]))));
    const records: SourceTaskRecord[] = [];
    const issues: string[] = [];
    for (let offset = 0; offset < raw.length; offset += 6) {
      const results = await Promise.allSettled(raw.slice(offset, offset + 6).map((record) => sourceTaskRecord(record, source, mapping, options.downloadMaterials !== false)));
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') records.push(result.value);
        else {
          const recordId = String(raw[offset + index].id);
          if ('scriptSnapshot' in source) invalidateAirscriptRecord(source.sheetId, recordId);
          issues.push(`记录 ${recordId}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        }
      }
    }
    if (raw.length > 0 && records.length === 0 && issues.length) throw new Error(`原表读取失败，未导入任何记录：${issues.slice(0,3).join('；')}`);
    return { records, issues, totalRecords: raw.length, syncedAt: new Date().toISOString(), source, cacheHit: false };
  });
}

const sourceSyncs = new Map<string, ReturnType<typeof syncWpsSourceTaskRecords>>();
export function listWpsSourceTaskRecords(options: SyncOptions = {}) {
  const key = JSON.stringify(options);
  if (!sourceSyncs.has(key)) sourceSyncs.set(key, syncWpsSourceTaskRecords(options).finally(() => { sourceSyncs.delete(key); }));
  return sourceSyncs.get(key)!;
}

export function updateWpsTaskStatus(recordId: string, expectedStatus: string, expectedEvidence: string, status: unknown) {
  if (typeof status !== 'string' || !status.trim() || status.length > 80 || /[\r\n]/u.test(status)) throw new Error(`WPS 状态必须是 1–80 字的单行文字，实际值：${JSON.stringify(status)}`);
  const nextStatus = status.trim();
  return serialized(async () => {
    const token = wpsConfigurationStatus().mode === 'oauth' ? await wpsUserAccessToken() : '';
    const source = await configuration(token);
    const targetSource = 'scriptSnapshot' in source ? { ...source, scriptSnapshot: { ...source.scriptSnapshot, recordIds: source.scriptSnapshot.recordIds.filter((id) => `${source.fileId}:${source.sheetId}:${id}` === recordId) } } : source;
    const { records, mapping } = await rawRecords(token, targetSource, true);
    const raw = records.find((record) => `${source.fileId}:${source.sheetId}:${record.id}` === recordId);
    if (!raw) throw new Error(`WPS_SOURCE_CONFLICT: 记录 ${recordId} 已不存在`);
    const before = await sourceTaskRecord(raw, source, mapping);
    if (wpsSourceEvidence(before) !== expectedEvidence) throw new Error(`WPS_SOURCE_CONFLICT: ${recordId} 原文或素材已变化，请重新同步`);
    if (!mapping.status || !mapping.statusWritable) throw new Error('WPS 状态由原表公式计算，当前规则不支持直接修改');
    if (mapping.claimWorkflow && nextStatus !== before.wpsSource?.status && (!mapping.statusOptions.includes(nextStatus) || !mapping.statusOptions.includes(before.wpsSource?.status ?? ''))) throw new Error('只能领取或退回未交付任务；已完成由原表交付成品决定，已取消由异常标签决定');
    if (mapping.status.type === 'SingleSelect' && !mapping.statusOptions.includes(nextStatus)) throw new Error(`状态“${nextStatus}”不在 WPS 选项中：${mapping.statusOptions.join('、')}`);
    const currentStatus = before.wpsSource!.status;
    if (currentStatus !== expectedStatus && currentStatus !== nextStatus) throw new Error(`WPS_SOURCE_CONFLICT: 状态已从“${expectedStatus}”变为“${currentStatus}”，请重新同步`);
    if (currentStatus !== nextStatus) {
      if ('scriptSnapshot' in source) await writeAirscriptStatus(source.sheetId, raw, mapping.status.name, currentStatus, nextStatus);
      else await wpsRequest(`/coop/dbsheet/${encodeURIComponent(source.fileId)}/sheets/${source.sheetId}/records/update`, token, {
        prefer_id: false, records: [{ id: raw.id, fields_value: JSON.stringify({ [mapping.status.name]: nextStatus }) }],
      });
    }
    const freshSource = await configuration(token);
    if (freshSource.fileId !== source.fileId || freshSource.sheetId !== source.sheetId) throw new Error('WPS 写回期间来源数据表发生变化，请重新同步核对');
    const verifySource = 'scriptSnapshot' in freshSource ? { ...freshSource, scriptSnapshot: { ...freshSource.scriptSnapshot, recordIds: freshSource.scriptSnapshot.recordIds.filter((id) => id === raw.id) } } : freshSource;
    const verified = await rawRecords(token, verifySource, true);
    const afterRaw = verified.records.find((record) => record.id === raw.id);
    if (!afterRaw) throw new Error(`WPS 更新后记录 ${recordId} 不存在`);
    const after = await sourceTaskRecord(afterRaw, source, verified.mapping);
    if (after.wpsSource?.status !== nextStatus || wpsSourceEvidence(after) !== expectedEvidence) throw new Error(`WPS 状态写入后回读不一致：${recordId}，实际状态“${after.wpsSource?.status}”`);
    return { record: after, verifiedAt: new Date().toISOString() };
  });
}
