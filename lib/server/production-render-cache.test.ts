import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareProductionPreview, savedProductionRender } from './production-render-cache';
import { catalogDatabase, catalogTransaction } from './catalog-database';
import { readCatalogFile } from './catalog-files';
import { productionPreviewUnits, renderProductionMockup } from './wps-production-assets';
import { saveProductionFile } from './production-storage';
import { queueReplacedFiles } from './production-replaced-files';
import { garmentFixture } from '../testing/production-garment-fixture';
import { taskReviewFixture } from '../testing/task-review-fixture';
import { attachProductionArtwork, emptyWpsProductionState, importTaskReviews } from '../wps-production';
import { recoverProductionPrintSizes } from '../print-size-request';

vi.mock('./catalog-database', () => ({ catalogDatabase: vi.fn(), catalogTransaction: vi.fn() }));
vi.mock('./catalog-files', () => ({ readCatalogFile: vi.fn(), fileSha256: (value: string) => createHash('sha256').update(value).digest('hex') }));
vi.mock('./wps-production-assets', () => ({ productionPreviewUnits: vi.fn(), renderProductionMockup: vi.fn() }));
vi.mock('./production-replaced-files', () => ({ queueReplacedFiles: vi.fn() }));
vi.mock('./production-storage', () => ({ productionStateKey: () => 'main', saveProductionFile: vi.fn() }));
const query = vi.fn(), transactionQuery = vi.fn();
function fixture() {
  const review = taskReviewFixture()[2];
  review.units.forEach(unit => { unit.garment = garmentFixture(); });
  let state = importTaskReviews(emptyWpsProductionState(), [review]);
  for (const unit of state.units) state = attachProductionArtwork(state, unit.id, {
    url: '/uploads/logos/test.png', name: 'test.png', service: 'manual-upload', requestSummary: 'test',
    validation: { valid: true, mimeType: 'image/png', width: 1000, height: 1000, byteLength: 1000, sha256: 'b'.repeat(64), transparentPixelRatio: .5, visiblePixelRatio: .5, checkedAt: '2026-09-08T00:00:00Z', ruleVersion: 'transparent-artwork-v1', issues: [] },
  }, `test-${unit.id}`);
  return state;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(catalogDatabase).mockReturnValue({ query });
  vi.mocked(catalogTransaction).mockImplementation(async work => work({ query: transactionQuery }));
  vi.mocked(productionPreviewUnits).mockImplementation(async units => units);
  vi.mocked(readCatalogFile).mockResolvedValue({ file: { id: 'cached' }, bytes: Buffer.from('verified cached image') });
});

it('publishes a recovered size preview against the same derived geometry under the state lock', async () => {
  const original = fixture();
  original.records[0].source.requirementText = '正面宽9，领口往下18cm';
  const placement = original.units[0].placement!;
  delete placement.requestedSize;
  placement.requestedSizeIssue = '“正面宽9”未注明单位，请核对后填写自定义尺寸';
  const state = recoverProductionPrintSizes(original);
  expect(state.units[0].placement?.requestedSize?.valueCm).toBe(9);
  query.mockResolvedValue({ rowCount: 1, rows: [{ file_id: 'cached', is_current: false }] });
  transactionQuery.mockImplementation(async (sql: string) => ({ rowCount: 1,
    rows: sql.includes('FROM production_states') ? [{ state_jsonb: original }] : [] }));
  await savedProductionRender(state.mockupVersions[0], state.units);
  expect(transactionQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO production_renders'))).toBe(true);
  expect(original.units[0].placement?.requestedSizeIssue).toContain('未注明单位');
});

describe('preview before durable storage', () => {
  it('returns pixels without taking or waiting for the durable render lease', async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    vi.mocked(renderProductionMockup).mockResolvedValue(Buffer.from('new pixels'));
    const state = fixture();
    const preview = await prepareProductionPreview(state.mockupVersions[0], state.units);
    expect(preview.bytes.toString()).toBe('new pixels');
    expect(query).toHaveBeenCalledOnce();
    expect(saveProductionFile).not.toHaveBeenCalled();
    expect(catalogTransaction).not.toHaveBeenCalled();
  });

  it('persists the displayed pixels afterwards and rejects publication when input changed', async () => {
    const state = fixture(), latest = structuredClone(state);
    latest.units[0].placement!.widthCm += 1;
    query.mockImplementation(async (sql: string) => ({ rowCount: sql.includes('INSERT INTO production_operations') ? 1 : 0, rows: [] }));
    transactionQuery.mockResolvedValue({ rowCount: 1, rows: [{ state_jsonb: latest }] });
    vi.mocked(renderProductionMockup).mockResolvedValue(Buffer.from('new pixels'));
    vi.mocked(saveProductionFile).mockResolvedValue({ id: 'new-file' } as Awaited<ReturnType<typeof saveProductionFile>>);
    const preview = await prepareProductionPreview(state.mockupVersions[0], state.units);
    // 候选修复强化发布失败语义（对应验收 A33）：合成期间输入变化时，旧图保留但不作为当前效果图返回，persist 显式报错。
    await expect(preview.persist()).rejects.toThrow('合成期间要求或位置已变化，旧图已保留但没有作为当前效果图返回');
    expect(renderProductionMockup).toHaveBeenCalledOnce();
    expect(saveProductionFile).toHaveBeenCalledWith(preview.bytes, expect.any(String));
    expect(queueReplacedFiles).toHaveBeenCalledWith(expect.anything(), ['new-file']);
    expect(transactionQuery).toHaveBeenCalledOnce();
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM production_operations'))).toBe(true);
  });

  it('does not invalidate the returned preview when background storage fails', async () => {
    query.mockImplementation(async (sql: string) => ({ rowCount: sql.includes('INSERT INTO production_operations') ? 1 : 0, rows: [] }));
    vi.mocked(renderProductionMockup).mockResolvedValue(Buffer.from('visible pixels'));
    vi.mocked(saveProductionFile).mockRejectedValue(new Error('OSS timeout'));
    const state = fixture();
    const preview = await prepareProductionPreview(state.mockupVersions[0], state.units);
    await expect(preview.persist()).rejects.toThrow('OSS timeout');
    expect(preview.bytes.toString()).toBe('visible pixels');
    expect(catalogTransaction).not.toHaveBeenCalled();
  });
});
describe('unchanged render cache hits', () => {
  it('reads verified bytes while re-verifying the current input under a lock', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ file_id: 'cached', is_current: true }] });
    const state = fixture();
    // 候选修复把 is_current 命中也改为锁下复核（读标记与返回之间存在并发换图窗口），指针幂等重发布同一文件。
    transactionQuery.mockImplementation(async (sql: string) => ({ rowCount: 1, rows: sql.includes('FROM production_states') ? [{ state_jsonb: state }] : [] }));
    const result = await savedProductionRender(state.mockupVersions[0], state.units);
    expect(result.bytes.toString()).toBe('verified cached image');
    expect(readCatalogFile).toHaveBeenCalledWith('cached');
    expect(catalogTransaction).toHaveBeenCalledOnce();
    expect(transactionQuery.mock.calls.some(([sql]) => sql.includes('FOR UPDATE'))).toBe(true);
  });
  it('still checks latest input under a lock before publishing a different pointer', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ file_id: 'cached', is_current: false }] });
    const state = fixture();
    transactionQuery.mockImplementation(async (sql: string) => ({ rowCount: 1, rows: sql.includes('FROM production_states') ? [{ state_jsonb: state }] : [] }));
    await savedProductionRender(state.mockupVersions[0], state.units);
    expect(transactionQuery.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(transactionQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO production_renders'))).toBe(true);
  });
  it('starts the verified file read while the current-input check is still waiting', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ file_id: 'cached', is_current: false }] });
    const state = fixture();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM production_states')) { await waiting; return { rowCount: 1, rows: [{ state_jsonb: state }] }; }
      return { rowCount: 1, rows: [] };
    });
    const pending = savedProductionRender(state.mockupVersions[0], state.units);
    try { await vi.waitFor(() => expect(readCatalogFile).toHaveBeenCalledWith('cached')); }
    finally { release(); }
    expect((await pending).bytes.toString()).toBe('verified cached image');
    expect(transactionQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO production_renders'))).toBe(true);
  });
  it('cannot let a late cached result overwrite a newer placement', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ file_id: 'cached', is_current: false }] });
    const state = fixture(), latest = structuredClone(state);
    latest.units[0].placement!.widthCm += 1;
    transactionQuery.mockResolvedValue({ rowCount: 1, rows: [{ state_jsonb: latest }] });
    // 候选修复：迟到的缓存结果不再静默返回，必须显式报错并提示读取最新效果图（A33）。
    await expect(savedProductionRender(state.mockupVersions[0], state.units)).rejects.toThrow('合成期间要求或位置已变化，请读取最新效果图');
    expect(transactionQuery).toHaveBeenCalledOnce();
    expect(queueReplacedFiles).toHaveBeenCalledWith(expect.anything(), ['cached']);
  });
  it('publishes unchanged input after jsonb reordered its object keys', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ file_id: 'cached', is_current: false }] });
    const state = fixture();
    const persisted = JSON.parse(JSON.stringify(state, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value));
    transactionQuery.mockImplementation(async (sql: string) => ({ rowCount: 1, rows: sql.includes('FROM production_states') ? [{ state_jsonb: persisted }] : [] }));
    await savedProductionRender(state.mockupVersions[0], state.units);
    expect(transactionQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO production_renders'))).toBe(true);
  });
});

it('renders new geometry after catalog calibration even when the task itself was not saved', async () => {
  const state = fixture(), before = structuredClone(state);
  query.mockResolvedValue({ rowCount: 0, rows: [] });
  vi.mocked(renderProductionMockup).mockResolvedValue(Buffer.from('preview'));
  let widthRatio = .45;
  vi.mocked(productionPreviewUnits).mockImplementation(async units => units.map(unit => ({ ...unit, garment: {
    ...unit.garment!, views: unit.garment!.views.map(view => ({ ...view, bodyScale: { widthRatio, basis: 'confirmed-armpits' } })),
  } })));
  await prepareProductionPreview(state.mockupVersions[0], state.units);
  const first = query.mock.calls[0][1][0];
  widthRatio = .6;
  await prepareProductionPreview(state.mockupVersions[0], state.units);
  expect(query.mock.calls[1][1][0]).not.toBe(first);
  expect(renderProductionMockup).toHaveBeenCalledTimes(2);
  expect(state).toEqual(before);
});
