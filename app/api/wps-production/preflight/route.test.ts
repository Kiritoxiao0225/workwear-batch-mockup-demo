import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { internalScope } from '@/lib/server/tenant-scope';
import sharp from 'sharp';
import { taskBFixture } from '@/lib/testing/task-b-fixture';
import { productionUser, usesProductionCloud } from '@/lib/server/production-storage';
import { readWpsProductionState } from '@/lib/server/wps-production-store';
import { withGarmentBodyScale } from '@/lib/server/wps-garment-sizing';
import { CatalogHttpError } from '@/lib/server/catalog-auth';
import { prepareProductionPreviewUnit } from '@/lib/server/production-preview-readiness';
import { POST } from './route';
import { POST as submitJobs } from '../jobs/route';
import { GET as diagnostics } from '../diagnostics/route';
import { GET as preview } from '../../catalog/production-preview/route';

vi.mock('@/lib/server/file-authorization', () => ({ registerFileRef: vi.fn(), assertFileAccess: vi.fn() }));
vi.mock('@/lib/server/tenant-scope', () => ({ tenantScope: vi.fn(async () => ({ user: { id: 'operator', email: 'operator@example.test', displayName: '操作员', role: 'editor' as const }, tenant: { id: '00000000-0000-0000-0000-000000000001', name: '内部', plan: 'internal' as const, billingMode: 'exempt' as const, styleQuota: 1, storageQuotaBytes: 1, workspace: 'main' } })), internalScope: vi.fn(async () => ({ user: { id: 'operator', email: 'operator@example.test', displayName: '操作员', role: 'editor' as const }, tenant: { id: '00000000-0000-0000-0000-000000000001', name: '内部', plan: 'internal' as const, billingMode: 'exempt' as const, styleQuota: 1, storageQuotaBytes: 1, workspace: 'main' } })) }));
vi.mock('../jobs/route', () => ({ POST: vi.fn(async () => Response.json({ accepted: true })) }));
vi.mock('@/lib/server/wps-production-store', () => ({ readWpsProductionState: vi.fn() }));
vi.mock('@/lib/server/production-storage', async original => ({ ...await original<typeof import('@/lib/server/production-storage')>(), productionUser: vi.fn(), usesProductionCloud: vi.fn() }));
vi.mock('@/lib/server/catalog-auth', async original => ({ ...await original<typeof import('@/lib/server/catalog-auth')>(), catalogUser: vi.fn() }));
vi.mock('@/lib/server/wps-garment-sizing', async original => ({ ...await original<typeof import('@/lib/server/wps-garment-sizing')>(), withGarmentBodyScale: vi.fn() }));
vi.mock('@/lib/server/artwork-job-store', () => ({ readArtworkJobs: vi.fn(async () => ({ enabled: false, workerOnline: false, jobs: [] })) }));
vi.mock('@/lib/server/catalog-database', () => ({ catalogDatabase: () => { throw new Error('No DB allowed in these route fixtures'); } }));
vi.mock('@/lib/server/wps-analysis-save', () => ({ verifyWpsAnalysisSources: vi.fn(() => { throw new Error('No live WPS allowed'); }) }));
// The real HTTP preview route invokes the real readiness resolver; substitute
// only the final frame pixels, whose production artwork is not in the bundle.
vi.mock('@/lib/server/wps-production-assets', () => ({ renderProductionPreview: vi.fn(async (_version, units) => {
  for (const unit of units) if (unit.artwork && unit.placement) await prepareProductionPreviewUnit(unit);
  return sharp({ create: { width: 80, height: 80, channels: 4, background: 'white' } }).png().toBuffer();
}) }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(usesProductionCloud).mockReturnValue(false);
  vi.mocked(withGarmentBodyScale).mockImplementation(async garment => structuredClone(garment));
  vi.mocked(submitJobs).mockImplementation(async () => Response.json({ accepted: true }) as Awaited<ReturnType<typeof submitJobs>>);
});
const request = (unitId: string, target = 'mockup', extra = {}) => new Request('http://localhost/api/wps-production/preflight', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify({ action: 'check', unitIds: [unitId], target, ...extra }),
});
function stored(artwork = false) {
  const fixture = taskBFixture(artwork);
  fixture.source.wpsSource = { fileId: 'task-b-synthetic', sheetId: 1, sheetName: 'fixture', statusFieldName: '任务状态', status: '设计中', statusOptions: [] };
  vi.mocked(readWpsProductionState).mockResolvedValue(fixture.state);
  return fixture;
}
describe('B1/B2 compact diagnostics, batch check and real preview HTTP boundary', () => {
  it('does not report missing calibration for alpha torso/no manual standard; batch is eligible', async () => {
    const { state, unit } = stored(false), before = structuredClone(state);
    const checked = await POST(request(unit.id));
    expect(checked.status).toBe(200);
    const body = await checked.json();
    expect(body.eligible).toBe(1);
    expect(body.results[0]).toMatchObject({ garmentIssue: null, temporaryPlacement: true, blockers: [] });
    const report = await (await diagnostics(new Request('http://localhost/api/wps-production/diagnostics'))).json();
    expect(report.orders[0].units[0]).toMatchObject({ garmentIssue: null, temporaryPlacement: true });
    expect(state).toEqual(before);
    expect(submitJobs).not.toHaveBeenCalled();
    expect(productionUser).toHaveBeenCalledWith(expect.any(Request), true);
  });
  it('preserves artwork-only eligibility when width is unknown, with a direct pinned calibration link', async () => {
    const { state, unit } = stored(false);
    unit.garment!.views.forEach(view => { delete view.bodyScale; });
    const before = structuredClone(state);
    const mockup = await (await POST(request(unit.id))).json();
    expect(mockup.eligible).toBe(0);
    expect(mockup.results[0].garmentIssue).toContain('衣身宽度');
    const artwork = await (await POST(request(unit.id, 'artwork'))).json();
    expect(artwork.eligible).toBe(1);
    expect(artwork.results[0].calibrationUrl).toContain(unit.garment!.assetVersionId);
    expect(state).toEqual(before);
    expect(submitJobs).not.toHaveBeenCalled();
  });
  it('keeps target-bound review tokens and forwards the original Origin only after rechecking', async () => {
    const { unit } = stored(false);
    const check = await (await POST(request(unit.id, 'artwork'))).json();
    const mismatch = await POST(request(unit.id, 'mockup', { action: 'enqueue', reviewToken: check.reviewToken }));
    expect(mismatch.status).toBe(409);
    expect(submitJobs).not.toHaveBeenCalled();
    expect((await POST(request(unit.id, 'artwork', { action: 'enqueue', reviewToken: check.reviewToken }))).status).toBe(200);
    const forwarded = vi.mocked(submitJobs).mock.calls[0][0];
    expect(forwarded.headers.get('origin')).toBe('http://localhost');
    expect((await forwarded.json()).target).toBe('artwork');
  });
  it('returns PNG at the real preview API, while missing scale produces 422 and keeps the draft', async () => {
    const { state, unit, version } = stored(true), before = structuredClone(state);
    const url = `http://localhost/api/catalog/production-preview?versionId=${encodeURIComponent(version.id)}`;
    const ok = await preview(new NextRequest(url));
    expect(ok.status).toBe(200); expect(ok.headers.get('content-type')).toBe('image/png');
    expect((await ok.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(state).toEqual(before);
    unit.garment!.views.forEach(view => { delete view.bodyScale; });
    const failed = await preview(new NextRequest(url));
    expect(failed.status).toBe(422); expect((await failed.json()).error).toContain('衣身宽度');
    expect(unit.artwork).toEqual(before.units[0].artwork);
    const report = await (await diagnostics(new Request('http://localhost/api/wps-production/diagnostics'))).json();
    expect(report.orders[0].versions[0]).toMatchObject({ current: false, readyPositions: 1 });
    // The preview route now proves internal-tenant membership instead of merely being signed in.
    expect(internalScope).toHaveBeenCalled();
  });
  it('never bulk-regenerates an existing saved draft and authenticates before any state read', async () => {
    const { unit } = stored(true);
    const result = await (await POST(request(unit.id))).json();
    expect(result.eligible).toBe(0);
    expect(result.results[0].blockers.join(' ')).toContain('图稿已保存');
    vi.mocked(readWpsProductionState).mockClear();
    vi.mocked(productionUser).mockRejectedValueOnce(new CatalogHttpError(403, 'denied'));
    expect((await POST(request(unit.id))).status).toBe(403);
    expect(readWpsProductionState).not.toHaveBeenCalled();
    expect(submitJobs).not.toHaveBeenCalled();
  });
});
