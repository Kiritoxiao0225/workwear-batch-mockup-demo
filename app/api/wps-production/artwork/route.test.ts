import { beforeEach, expect, it, vi } from 'vitest';
import { POST } from './route';
import { NativeArtworkCandidateError, prepareStandardArtwork } from '@/lib/server/artwork-standard-pipeline';
import { persistProductionReferences, productionUser, usesProductionCloud } from '@/lib/server/production-storage';
import { assertCutoutStoreReady } from '@/lib/server/artwork-cutout-store';
import { after } from 'next/server';
import type { ArtworkPreparationResponse } from '@/lib/task-review-artwork';
import { createLegacyArtworkDraft } from '@/lib/artwork-editor';

vi.mock('next/server', async importOriginal => ({ ...await importOriginal<typeof import('next/server')>(), after: vi.fn() }));
vi.mock('@/lib/server/artwork-standard-pipeline', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/server/artwork-standard-pipeline')>(), prepareStandardArtwork: vi.fn() }));
vi.mock('@/lib/task-review-artwork', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/task-review-artwork')>(), parseArtworkPreparationRequest: (value: unknown) => value }));
vi.mock('@/lib/server/production-storage', () => ({ productionUser: vi.fn(), usesProductionCloud: vi.fn(), persistProductionReferences: vi.fn() }));
vi.mock('@/lib/server/artwork-cutout-store', () => ({ assertCutoutStoreReady: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); vi.mocked(assertCutoutStoreReady).mockResolvedValue(undefined); vi.mocked(usesProductionCloud).mockReturnValue(false); });

it('streams preview before completion and retains request lifetime through file persistence on disconnect', async () => {
  let release!: (result: ArtworkPreparationResponse) => void;
  const gate = new Promise<ArtworkPreparationResponse>(resolve => { release = resolve; });
  vi.mocked(prepareStandardArtwork).mockImplementation(async (_request, _services, notify) => {
    notify?.({ type: 'preview', url: 'original', label: '尚未保存' });
    return gate;
  });
  vi.mocked(usesProductionCloud).mockReturnValue(true);
  vi.mocked(persistProductionReferences).mockImplementation(async value => value);
  const response = await POST(new Request('http://localhost/api/wps-production/artwork', { method: 'POST', headers: { Accept: 'application/x-ndjson' }, body: '{}' }));
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  const reader = response.body!.getReader();
  const preview = new TextDecoder().decode((await reader.read()).value);
  expect(JSON.parse(preview).type).toBe('preview');
  expect(persistProductionReferences).not.toHaveBeenCalled();
  expect(after).toHaveBeenCalledOnce();
  await reader.cancel();
  release({ status: 'prepared', draft: createLegacyArtworkDraft('/api/production-files/ready'), preprocessing: {} } as ArtworkPreparationResponse);
  await vi.mocked(after).mock.calls[0][0];
  expect(persistProductionReferences).toHaveBeenCalledOnce();
  expect(prepareStandardArtwork).toHaveBeenCalledOnce();
});

it('sends structured streaming failures, and authenticates before opening the stream', async () => {
  vi.mocked(prepareStandardArtwork).mockRejectedValue(new Error('模型服务暂不可用'));
  const request = () => new Request('http://localhost/api/wps-production/artwork', { method: 'POST', headers: { Accept: 'application/x-ndjson' }, body: '{}' });
  const response = await POST(request());
  expect((await response.text()).trim()).toBe(JSON.stringify({ type: 'error', status: 502, error: '模型服务暂不可用' }));
  vi.mocked(prepareStandardArtwork).mockClear();
  vi.mocked(productionUser).mockRejectedValueOnce(new Error('unauthenticated'));
  const rejected = await POST(request());
  expect(rejected.headers.get('content-type')).toContain('application/json');
  expect(prepareStandardArtwork).not.toHaveBeenCalled();
});

it('streams complete only after generated references are persisted', async () => {
  const result = { status: 'prepared', draft: createLegacyArtworkDraft('/api/production-files/ready'), preprocessing: {} } as ArtworkPreparationResponse;
  vi.mocked(prepareStandardArtwork).mockResolvedValue(result);
  vi.mocked(usesProductionCloud).mockReturnValue(true);
  vi.mocked(persistProductionReferences).mockImplementation(async value => value);
  const response = await POST(new Request('http://localhost/api/wps-production/artwork', { method: 'POST', headers: { Accept: 'application/x-ndjson' }, body: '{}' }));
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  expect(events.map(event => event.type)).toEqual(['timing', 'complete']);
  expect(events[1].result.draft.graphic.sourceUrl).toBe('/api/production-files/ready');
  expect(events[1].result.preprocessing.timings[0].stage).toBe('filePersistence');
});

it('stops before generation when the durable cutout store is unavailable', async () => {
  vi.mocked(assertCutoutStoreReady).mockRejectedValueOnce(new Error('抠图服务尚未启用：本次尚未开始付费处理。'));
  const response = await POST(new Request('http://localhost/api/wps-production/artwork', { method: 'POST', body: '{}' }));
  expect(response.status).toBe(503); expect(prepareStandardArtwork).not.toHaveBeenCalled();
});

it('returns the unchanged rejected model candidate with 422 after authenticating, without a prepared result', async () => {
  const candidate = { runId: 'run-id', url: 'data:image/png;base64,AAAA', model: 'gpt-image-2', reason: '透明未通过', promptHash: 'hash' };
  vi.mocked(prepareStandardArtwork).mockRejectedValue(new NativeArtworkCandidateError(candidate));
  const request = new Request('http://localhost/api/wps-production/artwork', { method: 'POST', body: '{}' });
  const response = await POST(request);
  expect(productionUser).toHaveBeenCalledWith(request, true);
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: '透明未通过', candidate });
  expect(persistProductionReferences).not.toHaveBeenCalled();
});

it('persists a rejected candidate through the existing cloud file contract when enabled', async () => {
  const candidate = { runId: 'run-id', url: 'data:image/png;base64,AAAA', model: 'gpt-image-2', reason: '透明未通过', promptHash: 'hash' };
  vi.mocked(usesProductionCloud).mockReturnValue(true);
  vi.mocked(prepareStandardArtwork).mockRejectedValue(new NativeArtworkCandidateError(candidate));
  vi.mocked(persistProductionReferences).mockResolvedValue({ error: candidate.reason, candidate: { ...candidate, url: '/api/production-files/candidate' } });
  const response = await POST(new Request('http://localhost/api/wps-production/artwork', { method: 'POST', body: '{}' }));
  expect(response.status).toBe(422);
  expect(persistProductionReferences).toHaveBeenCalledWith({ error: candidate.reason, candidate });
  expect((await response.json()).candidate.url).toBe('/api/production-files/candidate');
});
