import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../app/api/wps-production/prompt/route';
import { productionUser } from './production-storage';
import { readWpsProductionState } from './wps-production-store';
import { listWpsSourceTaskRecords } from './wps-dbsheet';
import { planArtworkGenerationPrompt } from './ark-task-review';
import { CatalogHttpError } from './catalog-auth';
import { emptyWpsProductionState, importTaskReviews, type WpsProductionState } from '@/lib/wps-production';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { productionArtworkSnapshot } from '@/lib/production-artwork-snapshot';

vi.mock('./production-storage', () => ({ productionUser: vi.fn() }));
vi.mock('./wps-production-store', () => ({ readWpsProductionState: vi.fn() }));
vi.mock('./wps-dbsheet', () => ({ listWpsSourceTaskRecords: vi.fn() }));
vi.mock('./ark-task-review', () => ({ planArtworkGenerationPrompt: vi.fn() }));
let state: WpsProductionState;
beforeEach(() => {
  vi.resetAllMocks();
  state = importTaskReviews(emptyWpsProductionState(), [taskReviewFixture()[0]]);
  state.records[0].source.wpsSource = { fileId: 'file', sheetId: 1, sheetName: '设计', statusFieldName: '状态', status: '设计中', statusOptions: [] };
  vi.mocked(readWpsProductionState).mockImplementation(async () => structuredClone(state));
  vi.mocked(listWpsSourceTaskRecords).mockResolvedValue({ records: [structuredClone(state.records[0].source)] } as Awaited<ReturnType<typeof listWpsSourceTaskRecords>>);
  vi.mocked(planArtworkGenerationPrompt).mockResolvedValue({ generationPrompt: '使用图1，保留品牌字形，纯白背景。', primaryImageLabel: '图1', referenceImageLabels: [], ambiguities: [], model: 'gpt-5.6-sol', provider: 'cliproxy', reasoningEffort: 'low' });
});
const request = (snapshot = productionArtworkSnapshot(state.units[0], state.records[0].source)) => new Request('http://localhost/api/wps-production/prompt', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unitId: state.units[0].id, expectedUnitSnapshot: snapshot }),
});

describe('focused prompt endpoint', () => {
  it('keeps reference-only text plans free of a fabricated primary content image', async () => {
    state.units[0].textMode = 'replace';
    state.units[0].exactText = 'XJY\n享聚源';
    vi.mocked(planArtworkGenerationPrompt).mockResolvedValueOnce({ generationPrompt: '参考图1样式制作 XJY 与享聚源，不复制原文字。', primaryImageLabel: null, referenceImageLabels: ['图1'], ambiguities: [], model: 'test', provider: 'cliproxy', reasoningEffort: 'low' });
    const response = await POST(request());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.materialId).toBeNull();
    expect(result.referenceMaterialIds).toEqual([state.records[0].source.materials[0].id]);
    expect(result.finalPrompt).toContain('输入图1 = WPS 图1（参考素材）');
    expect(result.finalPrompt).not.toContain('内容素材');
  });
  it('previews the exact body and attached image identities without modifying production state', async () => {
    const before = JSON.stringify(state);
    const response = await POST(request());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.materialId).toBe(state.records[0].source.materials[0].id);
    expect(result.finalPrompt).toBe(`【输入图片对应关系】正文图号均为 WPS 原图号。\n输入图1 = WPS 图1（内容素材）\n\n${result.generationPrompt}`);
    expect(JSON.stringify(state)).toBe(before);
    expect(planArtworkGenerationPrompt).toHaveBeenCalledWith(state.records[0].source, expect.objectContaining({ id: state.units[0].id, instruction: state.units[0].instruction, exactText: state.units[0].exactText, layoutNote: state.units[0].layoutNote, artworkMethod: state.units[0].artworkMethod }));
  });
  it('rejects a stale unit before any inference', async () => {
    expect((await POST(request('stale'))).status).toBe(409);
    expect(planArtworkGenerationPrompt).not.toHaveBeenCalled();
  });
  it('checks the live WPS source before inference', async () => {
    state.records[0].source.requirementText += '客户修改';
    expect((await POST(request())).status).toBe(409);
    expect(planArtworkGenerationPrompt).not.toHaveBeenCalled();
  });
  it('discards a late response if the saved unit changes while the model is running', async () => {
    const snapshot = productionArtworkSnapshot(state.units[0], state.records[0].source);
    vi.mocked(readWpsProductionState).mockResolvedValueOnce(structuredClone(state));
    state.units[0].recipeFingerprint = 'changed';
    expect((await POST(request(snapshot))).status).toBe(409);
    expect(planArtworkGenerationPrompt).toHaveBeenCalledTimes(1);
  });
  it('honors write-role authentication before any source read or inference', async () => {
    vi.mocked(productionUser).mockRejectedValueOnce(new CatalogHttpError(403, '没有编辑权限'));
    expect((await POST(request())).status).toBe(403);
    expect(readWpsProductionState).not.toHaveBeenCalled();
  });
});
