import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST } from '../../app/api/wps-production/artwork/route';
import { prepareStandardArtwork, NativeArtworkCandidateError } from './artwork-standard-pipeline';
import { ArtworkCutoutPendingError } from './artwork-cutout';
import { persistProductionReferences } from './production-storage';
import { ArtworkResponseError, readArtworkResponse } from '../client/artwork-response';
import type { ArtworkCutoutResult } from '../artwork-cutout';

vi.mock('next/server', async original => ({ ...await original<typeof import('next/server')>(), after: vi.fn() }));
vi.mock('./production-storage', () => ({ productionUser: vi.fn(), usesProductionCloud: () => true, persistProductionReferences: vi.fn() }));
vi.mock('./artwork-cutout-store', () => ({ assertCutoutStoreReady: vi.fn() }));
vi.mock('./artwork-standard-pipeline', async original => ({ ...await original<typeof import('./artwork-standard-pipeline')>(), prepareStandardArtwork: vi.fn() }));
const input = { sourceRequirementText: '保留原始 Logo', instruction: '保留原图', image: { fileName: 'logo.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,cG5n' } };
const cutout = { status: 'unknown', error: '美图提交结果待核实，不会自动重提', receipt: { jobKey: 'a'.repeat(64), sourceUrl: input.image.dataUrl } } as ArtworkCutoutResult;
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

it.each(['application/x-ndjson', 'application/json'])('retains the original task and source when error persistence fails (%s)', async accept => {
  vi.mocked(prepareStandardArtwork).mockRejectedValue(new ArtworkCutoutPendingError(cutout));
  vi.mocked(persistProductionReferences).mockRejectedValue(new Error('storage unavailable'));
  const response = await POST(new Request('http://localhost/api/wps-production/artwork', { method: 'POST', headers: { accept }, body: JSON.stringify(input) }));
  const error = await readArtworkResponse(response, () => {}).catch(error => error);
  expect(error).toBeInstanceOf(ArtworkResponseError);
  expect(error.failure.cutout).toEqual(cutout);
  expect(error.message).toContain(cutout.error);
  expect(error.message).toContain('错误记录附件暂未保存');
});

it('retains a generated candidate without rerunning the model when its failure attachment cannot be saved', async () => {
  const candidate = { runId: 'run-1', url: input.image.dataUrl, model: 'test', reason: '抠图未完成', promptHash: 'hash', cutout };
  vi.mocked(prepareStandardArtwork).mockRejectedValue(new NativeArtworkCandidateError(candidate));
  vi.mocked(persistProductionReferences).mockRejectedValue(new Error('storage unavailable'));
  const response = await POST(new Request('http://localhost/api/wps-production/artwork', { method: 'POST', headers: { accept: 'application/x-ndjson' }, body: JSON.stringify(input) }));
  const error = await readArtworkResponse(response, () => {}).catch(error => error);
  expect(error.failure.candidate).toEqual(candidate);
  expect(prepareStandardArtwork).toHaveBeenCalledOnce();
});
