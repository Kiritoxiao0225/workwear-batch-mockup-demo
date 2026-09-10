import { beforeEach, expect, it, vi } from 'vitest';
import { after, NextRequest } from 'next/server';
import sharp from 'sharp';
import { GET } from '../../app/api/catalog/production-preview/route';
import { prepareProductionPreview } from './production-render-cache';
import { readWpsProductionState } from './wps-production-store';
import { readCloudProductionPreviewState } from './production-cloud-state';
import { finishProductionSave } from './production-post-save';
import { garmentFixture } from '../testing/production-garment-fixture';
import { taskReviewFixture } from '../testing/task-review-fixture';
import { emptyWpsProductionState, importTaskReviews } from '../wps-production';

vi.mock('next/server', async original => ({ ...await original<typeof import('next/server')>(), after: vi.fn() }));
vi.mock('./production-render-cache', () => ({ prepareProductionPreview: vi.fn() }));
vi.mock('./production-storage', () => ({ usesProductionCloud: () => true }));
vi.mock('./wps-production-store', () => ({ readWpsProductionState: vi.fn() }));
vi.mock('./production-cloud-state', () => ({ readCloudProductionPreviewState: vi.fn() }));
vi.mock('./wps-production-assets', () => ({ renderProductionPreview: vi.fn() }));
vi.mock('./production-post-save', () => ({ finishProductionSave: vi.fn() }));
vi.mock('./catalog-auth', async original => ({ ...await original<typeof import('./catalog-auth')>(), catalogUser: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
async function setup() {
  const reviews = taskReviewFixture();
  reviews.forEach(review => review.units.forEach(unit => { unit.garment = garmentFixture(); }));
  const state = importTaskReviews(emptyWpsProductionState(), reviews);
  vi.mocked(readWpsProductionState).mockResolvedValue(state);
  vi.mocked(readCloudProductionPreviewState).mockResolvedValue(state);
  const bytes = await sharp({ create: { width: 3252, height: 2301, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const persist = vi.fn(async () => {});
  vi.mocked(prepareProductionPreview).mockResolvedValue({ bytes, persist });
  const url = `http://localhost/api/catalog/production-preview?versionId=${state.mockupVersions[0].id}`;
  return { bytes, persist, url };
}
it('responds with a light card before any output upload, then persists in after()', async () => {
  const t = await setup();
  const response = await GET(new NextRequest(`${t.url}&size=card`));
  expect(response.status).toBe(200);
  expect(readWpsProductionState).not.toHaveBeenCalled();
  expect(response.headers.get('content-type')).toBe('image/webp');
  expect(t.persist).not.toHaveBeenCalled();
  const pixels = Buffer.from(await response.arrayBuffer());
  expect((await sharp(pixels).metadata()).width).toBe(1084);
  expect(pixels.length).toBeLessThan(t.bytes.length);
  await (vi.mocked(after).mock.calls[0][0] as () => Promise<void>)();
  expect(t.persist).toHaveBeenCalledOnce();
  expect(finishProductionSave).toHaveBeenCalledOnce();
});
it('keeps the original full resolution for opening the preview', async () => {
  const t = await setup();
  const response = await GET(new NextRequest(t.url));
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(t.bytes);
  expect(t.persist).not.toHaveBeenCalled();
});
it('rejects an obsolete image request rather than labeling new pixels with its old revision', async () => {
  const t = await setup();
  const response = await GET(new NextRequest(`${t.url}&revision=old`));
  expect(response.status).toBe(409);
  expect(prepareProductionPreview).not.toHaveBeenCalled();
  expect(after).not.toHaveBeenCalled();
});
