import { afterEach, describe, expect, it, vi } from 'vitest';
import { listWpsSourceTaskRecords, updateWpsTaskStatus, wpsFieldMapping, wpsTaskMaterials } from '@/lib/server/wps-dbsheet';
import { wpsSourceEvidence } from '@/lib/wps-source';
vi.mock('@/lib/server/wps-user-oauth', () => ({ wpsUserAccessToken: async () => 'test-token' }));
vi.mock('@/lib/server/wps-source-assets', () => ({ cacheWpsMaterial: async (material: unknown) => material }));
const fields = [
  { id: 'a', name: '任务要求说明', type: 'MultiLineText' },
  { id: 'b', name: '任务素材图片', type: 'Attachment' },
  { id: 'c', name: '状态', type: 'SingleSelect', data: { items: [{ value: '待领取' }, { value: '设计中' }] } },
];
const record = (status = '待领取', id = 'rec-1') => ({ id, fields: JSON.stringify({ 任务要求说明: '左胸放图1', 任务素材图片: [{ id: 'img-1', fileName: 'logo.png', url: 'https://cdn.wps.cn/logo.png' }], 状态: status }) });
function mockWps() {
  vi.stubEnv('WPS_CONNECTION_MODE', 'oauth');
  vi.stubEnv('WPS_APP_ID', 'test-app'); vi.stubEnv('WPS_APP_KEY', 'test-key');
  vi.stubEnv('WPS_SOURCE_URL', 'https://365.kdocs.cn/l/cj5Qvp0WVtjz');
  vi.stubEnv('WPS_DBSHEET_SHEET_ID', '4'); vi.stubEnv('WPS_DBSHEET_FILE_ID', 'file-1');
  let status = '待领取';
  const requests: { url: string; body: Record<string, unknown> | null }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, body });
    let data: unknown;
    if (url.includes('/links/')) data = { file_id: 'file-1' };
    else if (url.includes('/files/')) data = { type: 'db', name: '真实任务表' };
    else if (url.endsWith('/records/update')) { status = JSON.parse(body.records[0].fields_value).状态; data = {}; }
    else data = { fields_schema: fields, records: [record(status)], page_token: '' };
    return Response.json({ code: 0, data });
  }));
  return requests;
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('WPS dbsheet API', () => {
  it('maps source schema and all attachments in their original order', () => {
    expect(wpsFieldMapping(fields).statusOptions).toEqual(['待领取', '设计中']);
    expect(wpsTaskMaterials('rec', [{ id: 'a', url: 'https://cdn.wps.cn/a.png' }, { id: 'b', url: 'https://cdn.wps.cn/b.png' }]).map((image) => image.id)).toEqual(['rec:a', 'rec:b']);
    expect(() => wpsTaskMaterials('rec', [{ id: 'missing-url' }])).toThrow('没有 HTTPS');
  });
  it('keeps computed status visible and allows edits only for the verified claim workflow', () => {
    const schema = fields.map((field) => field.name === '状态' ? { ...field, type: 'Formula', data: {} } : field);
    expect(wpsFieldMapping(schema)).toMatchObject({ status: { name: '状态', type: 'Formula' }, statusWritable: false });
    const claim = schema.map((field) => field.name === '状态' ? { ...field, data: { workflow: 'claim-checkbox-v1', items: [{ value: '🔴待领取' }, { value: '🟢设计中' }] } } : field);
    expect(wpsFieldMapping(claim)).toMatchObject({ statusWritable: true, claimWorkflow: true, statusOptions: ['🔴待领取', '🟢设计中'] });
  });
  it('writes only the selected record status and verifies it by an independent read', async () => {
    const requests = mockWps();
    const sync = await listWpsSourceTaskRecords();
    const source = sync.records[0];
    const result = await updateWpsTaskStatus(source.recordId, '待领取', wpsSourceEvidence(source), '设计中');
    expect(result.record.wpsSource?.status).toBe('设计中');
    const writeIndex = requests.findIndex((request) => request.url.endsWith('/records/update'));
    expect(requests[writeIndex].body).toEqual({ prefer_id: false, records: [{ id: 'rec-1', fields_value: JSON.stringify({ 状态: '设计中' }) }] });
    expect(requests.slice(writeIndex + 1).some((request) => request.url.endsWith('/records'))).toBe(true);
  });
  it('rejects stale state, altered source evidence and unknown status options before writing', async () => {
    const requests = mockWps();
    const source = (await listWpsSourceTaskRecords()).records[0];
    await expect(updateWpsTaskStatus(source.recordId, '已完成', wpsSourceEvidence(source), '设计中')).rejects.toThrow('WPS_SOURCE_CONFLICT');
    await expect(updateWpsTaskStatus(source.recordId, '待领取', 'stale-source', '设计中')).rejects.toThrow('原文或素材已变化');
    await expect(updateWpsTaskStatus(source.recordId, '待领取', wpsSourceEvidence(source), '随意新状态')).rejects.toThrow('不在 WPS 选项中');
    expect(requests.some((request) => request.url.endsWith('/records/update'))).toBe(false);
  });
});
