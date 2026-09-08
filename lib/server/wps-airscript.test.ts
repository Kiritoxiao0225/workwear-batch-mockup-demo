import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { airscriptConfiguration, airscriptRecords, airscriptSource } from '@/lib/server/wps-airscript';
import { listWpsSourceTaskRecords, updateWpsTaskStatus, wpsConfigurationStatus } from '@/lib/server/wps-dbsheet';
import { wpsSourceEvidence } from '@/lib/wps-source';

vi.mock('@/lib/server/wps-user-oauth', () => ({ wpsUserAccessToken: vi.fn(() => { throw new Error('不得调用旧应用授权'); }) }));
vi.mock('@/lib/server/wps-source-assets', () => ({ cacheWpsMaterial: async (material: unknown) => material }));
const cacheRoot = mkdtempSync(path.join(os.tmpdir(), 'wps-airscript-test-'));
afterAll(() => rmSync(cacheRoot, { recursive: true, force: true }));
const script = readFileSync(path.join(process.cwd(), 'public/integrations/wps-task-bridge.txt'), 'utf8');
const descriptors = [
  { Id: 'f1', Name: '任务要求说明', Type: 'MultiLineText' },
  { Id: 'f2', Name: '任务素材图片', Type: 'Attachment' },
  { Id: 'f3', Name: '任务状态', Type: 'SingleSelect', Select: { Items: [{ value: '待领取' }, { value: '设计中' }] } },
  { Id: 'private', Name: '内部成本', Type: 'Number' },
];

// This provider fixture exercises the saved, installable AirScript against the
// documented synchronous range API, including the nested attachment values.
const claimFormula = '=IFS(效果图任务管理![@任务要求说明]="","🔵待完善",效果图任务管理![@异常标签]<>"","⚫已取消",效果图任务管理![@领取任务]=0,IF(效果图任务管理![@交付效果图成品]="","🔴待领取","✔已完成"),效果图任务管理![@领取任务]=1,IF(效果图任务管理![@交付效果图成品]="","🟢设计中","✔已完成"))';
function originalTable(formula = false) {
  const tableFields = formula ? descriptors.map((field) => field.Name === '任务状态' ? { ...field, Type: 'Formula', Formula: { Formula: claimFormula } } : field).concat([{ Id: 'claim', Name: '领取任务', Type: 'Checkbox' }]) : descriptors;
  const rows = new Map<string, Record<string, unknown>>([
    ['r1', { 任务要求说明: '左胸放图1，背后参考图2', 任务状态: '待领取', 任务素材图片: { Value: [
      { FileId: 'image-a', FileName: '标志.png', LinkUrl: 'https://cdn.wps.cn/a.png?sign=1' },
      { FileId: 'image-b', FileName: '参考.png', LinkUrl: 'https://cdn.wps.cn/b.png?sign=1' },
    ] }, 内部成本: 100 }],
  ]);
  const writes: { id: string; field: string; value: unknown }[] = [];
  function textFor(row: Record<string, unknown>, field: string) {
    if (formula && field === '任务状态') return row.交付效果图成品 ? '✔已完成' : row.异常标签 ? '⚫已取消' : row.领取任务 ? '🟢设计中' : '🔴待领取';
    return String(row[field] ?? '');
  }
  const range = Object.assign((id: string | string[], selector?: string | string[]) => {
    if (id === '1:' + rows.size) return { Id: [...rows.keys()] };
    if (Array.isArray(id) && Array.isArray(selector)) {
      return { Id: id,
        Text: id.map((key) => selector.map((field) => textFor(rows.get(key)!, field.slice(1)))),
        Value: id.map((key) => selector.map((field) => rows.get(key)![field.slice(1)])),
      };
    }
    if (typeof id !== 'string' || typeof selector !== 'string') throw new Error('Invalid single cell selector');
    const row = rows.get(id);
    if (!row) throw new Error(`记录不存在：${id}`);
    const field = selector.slice(1);
    return {
      Id: [id], get Text() { return textFor(row, field); },
      get Value() { return row[field]; },
      set Value(value: unknown) { writes.push({ id, field, value }); row[field] = value; },
    };
  }, { get Count() { return rows.size; } }); // Live AirScript leaves root RecordRange.Id undefined.
  Object.defineProperty(range, 'Count', { get: () => rows.size });
  const sheet = {
    Name: '效果图任务管理', Id: 9, RecordRange: range,
    FieldDescriptors: { Count: tableFields.length, Item: (selector: string | number) => typeof selector === 'number' ? tableFields[selector - 1] : tableFields.find((field) => '@' + field.Name === selector) },
  };
  function run(argv: Record<string, unknown> = {}) {
    const Application = { Sheets: (name: string) => { if (name !== sheet.Name) throw new Error(`数据表不存在：${name}`); return sheet; }, Record: {
      GetRecords: ({ Fields }: { Fields: string[] }) => ({ records: [...rows].map(([id, row]) => ({ id, fields: Object.fromEntries(Fields.map((field) => [field, field === '任务状态' ? textFor(row, field) : row[field]])) })) }),
    } };
    return JSON.parse(JSON.stringify(vm.runInNewContext(`(function () {${script}\n})()`, { Application, Context: { argv } }, { timeout: 1000 })));
  }
  return { run, rows, writes };
}

function configure() {
  vi.stubEnv('WPS_AIRSCRIPT_CACHE_PATH', path.join(cacheRoot, 'records.json'));
  vi.stubEnv('WPS_CONNECTION_MODE', 'airscript');
  vi.stubEnv('WPS_AIRSCRIPT_WEBHOOK', 'https://www.kdocs.cn/api/v3/ide/file/556933135475/script/V2-test/sync_task');
  vi.stubEnv('WPS_AIRSCRIPT_TOKEN', 'test-personal-token');
  vi.stubEnv('WPS_DBSHEET_FILE_ID', '556933135475');
  vi.stubEnv('WPS_SOURCE_URL', 'https://365.kdocs.cn/view/l/cj5Qvp0WVtjz');
  vi.stubEnv('WPS_DBSHEET_SHEET_NAME', '效果图任务管理');
  vi.stubEnv('WPS_STATUS_FIELD_NAME', '');
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('original-table AirScript bridge', () => {
  it('does not write when manually run, exports only task fields, and preserves attachment identities', () => {
    const table = originalTable();
    const metadata = table.run();
    expect(metadata.recordIds).toEqual(['r1']);
    expect(metadata.sheetId).toBe(9);
    expect(metadata.fields_schema.map((field: { name: string }) => field.name)).not.toContain('内部成本');
    const record = table.run({ action: 'read', sheetId: 9, recordIds: ['r1'] }).records[0];
    expect(JSON.parse(record.fields).任务素材图片.map((item: { id: string }) => item.id)).toEqual(['image-a', 'image-b']);
    expect(JSON.parse(record.fields)).not.toHaveProperty('内部成本');
    expect(table.writes).toEqual([]);
  });

  it('rejects stale content, status, unknown options and arbitrary-field updates without changing the original', () => {
    const table = originalTable();
    const record = table.run({ action: 'read', sheetId: 9, recordIds: ['r1'] }).records[0];
    const input = { action: 'update-status', sheetId: 9, recordId: 'r1', statusFieldName: '任务状态', expectedStatus: '待领取', expectedEvidence: record.evidence, status: '设计中' };
    expect(() => table.run({ ...input, expectedEvidence: 'stale' })).toThrow('需求或素材已变化');
    expect(() => table.run({ ...input, expectedStatus: '已完成' })).toThrow('状态已被其他人修改');
    expect(() => table.run({ ...input, status: '添加一个选项' })).toThrow('不允许创建');
    expect(() => table.run({ ...input, statusFieldName: '任务要求说明' })).toThrow('状态列已变化');
    expect(() => table.run({ ...input, sheetId: 4 })).toThrow('数据表 ID 已变化');
    expect(table.writes).toEqual([]);
    table.run(input);
    table.run(input); // Retry after an uncertain response does not duplicate the write.
    expect(table.writes).toEqual([{ id: 'r1', field: '任务状态', value: '设计中' }]);
    expect(table.rows.get('r1')?.任务要求说明).toBe('左胸放图1，背后参考图2');
  });

  it('reads and writes through the installable script, then makes an independent read without OAuth', async () => {
    configure();
    const table = originalTable();
    const actions: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toMatch(/^https:\/\/www.kdocs.cn\/api\/v3\/ide\/file\/556933135475\//);
      expect(init.redirect).toBe('error');
      expect(init.headers).toHaveProperty('AirScript-Token', 'test-personal-token');
      const input = JSON.parse(String(init.body)).Context.argv;
      actions.push(input.action);
      return Response.json({ status: 'finished', error: '', data: { result: table.run(input) } });
    }));
    const sync = await listWpsSourceTaskRecords();
    expect(sync.issues).toEqual([]);
    expect(sync.records[0].recordId).toBe('556933135475:9:r1');
    expect(sync.records[0].materials).toHaveLength(2);
    expect(sync.records[0].wpsSource?.statusOptions).toEqual(['待领取', '设计中']);
    const updated = await updateWpsTaskStatus(sync.records[0].recordId, '待领取', wpsSourceEvidence(sync.records[0]), '设计中');
    expect(updated.record.wpsSource?.status).toBe('设计中');
    expect(actions.slice(actions.indexOf('update-status') + 1)).toEqual(['metadata', 'read']);
    expect(table.writes).toHaveLength(1);
  });

  it('reads formula status and updates only the existing claim checkbox, without completing or cancelling customer tasks', () => {
    const table = originalTable(true);
    const record = table.run({ action: 'read', sheetId: 9, recordIds: ['r1'] }).records[0];
    expect(JSON.parse(record.fields).任务状态).toBe('🔴待领取');
    const input = { action: 'update-status', sheetId: 9, recordId: 'r1', statusFieldName: '任务状态', expectedStatus: '🔴待领取', expectedEvidence: record.evidence, status: '🟢设计中' };
    expect(() => table.run({ ...input, status: '✔已完成' })).toThrow('只能领取或退回');
    table.run(input);
    table.run(input);
    expect(table.writes).toEqual([{ id: 'r1', field: '领取任务', value: 1 }]);
    expect(table.rows.get('r1')?.任务状态).toBe('待领取'); // The stored formula cell was never overwritten.
    table.rows.get('r1')!.交付效果图成品 = 'real-delivery.png';
    expect(() => table.run({ ...input, expectedStatus: '✔已完成', status: '🔴待领取' })).toThrow('只能领取或退回');
    expect(table.writes).toHaveLength(1);
  });

  it('accepts the exact 365 webhook copied from the original table and uses its link identity', () => {
    configure();
    vi.stubEnv('WPS_AIRSCRIPT_WEBHOOK', 'https://365.kdocs.cn/api/v3/ide/file/cj5Qvp0WVtjz/script/V2-test/sync_task');
    expect(airscriptConfiguration().fileId).toBe('cj5Qvp0WVtjz');
  });

  it('detects newly inserted blank rows and changed attachments while reusing unchanged rows', async () => {
    configure();
    vi.stubEnv('WPS_AIRSCRIPT_WEBHOOK', 'https://365.kdocs.cn/api/v3/ide/file/cj5Qvp0WVtjz/script/V2-incremental-test/sync_task');
    const table = originalTable();
    const readIds: string[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const input = JSON.parse(String(init.body)).Context.argv;
      if (input.action === 'read') readIds.push(input.recordIds);
      return Response.json({ status: 'finished', error: '', data: { result: table.run(input) } });
    }));
    await airscriptRecords(await airscriptSource());
    await airscriptRecords(await airscriptSource());
    expect(readIds).toEqual([['r1']]);
    table.rows.set('r2', { 任务要求说明: '', 任务素材图片: { Value: [] }, 任务状态: '待领取' });
    const added = await listWpsSourceTaskRecords();
    expect(added.records.map((row) => row.recordId)).toEqual(['cj5Qvp0WVtjz:9:r1', 'cj5Qvp0WVtjz:9:r2']);
    expect(added.records[1].requirementText).toBe('');
    expect(readIds.at(-1)).toEqual(['r2']);
    table.rows.get('r1')!.任务素材图片 = { Value: [{ FileId: 'new-image', FileName: '标志.png', LinkUrl: 'https://cdn.wps.cn/new.png' }] };
    const changed = await airscriptRecords(await airscriptSource());
    expect(readIds.at(-1)).toEqual(['r1']);
    expect(JSON.parse(changed[0].fields as string).任务素材图片[0].id).toBe('new-image');
  });

  it('blocks wrong-file webhooks and redirects before exposing the token', async () => {
    configure();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('WPS_AIRSCRIPT_WEBHOOK', 'https://www.kdocs.cn/api/v3/ide/file/wrong/script/V2-test/sync_task');
    await expect(airscriptSource()).rejects.toThrow('与客户原表');
    vi.stubEnv('WPS_AIRSCRIPT_WEBHOOK', 'https://example.com/api/v3/ide/file/556933135475/script/V2-test/sync_task');
    await expect(airscriptSource()).rejects.toThrow('完整 Webhook');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces script failures and treats absent credentials as unconfigured rather than falling back', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'finished', error: 'WPS_SOURCE_CONFLICT: 需求发生变化', data: { result: null } })));
    await expect(airscriptSource()).rejects.toThrow(/^WPS_SOURCE_CONFLICT:/);
    vi.stubEnv('WPS_AIRSCRIPT_TOKEN', '');
    expect(wpsConfigurationStatus()).toMatchObject({ configured: false, mode: 'airscript', missing: ['WPS_AIRSCRIPT_TOKEN'] });
  });
});
