import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { catalogUser } from '@/lib/server/catalog-auth';
import { catalogDetail } from '@/lib/server/catalog-repository';
import { mutateWpsProductionState } from '@/lib/server/wps-production-store';
import { catalogFixture, garmentFixture } from '@/lib/testing/production-garment-fixture';
import { emptyWpsProductionState, importTaskReviews } from '@/lib/wps-production';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
vi.mock('@/lib/server/catalog-auth', () => ({ catalogUser: vi.fn(), CatalogHttpError: class extends Error {} }));
vi.mock('@/lib/server/catalog-repository', () => ({ catalogDetail: vi.fn(), listCatalogStyles: vi.fn() }));
vi.mock('@/lib/server/wps-production-store', () => ({ mutateWpsProductionState: vi.fn(), ProductionRevisionConflictError: class extends Error {} }));
const detail = catalogFixture();
function request(extra: Record<string, unknown> = {}) { return new NextRequest('http://localhost:3001/api/catalog/production-garments', { method: 'POST', headers: { 'Content-Type': 'application/json', origin: 'http://localhost:3001' }, body: JSON.stringify({ action: 'selectGarment', expectedRevision: 1, unitId: 'snapshot-03-u1', variantId: detail.id, ...extra }) }); }
beforeEach(() => { vi.clearAllMocks(); vi.mocked(catalogDetail).mockResolvedValue(detail); vi.mocked(catalogUser).mockResolvedValue({ id: 'operator', role: 'editor', email: 'operator@example.test', displayName: '操作员' }); });
describe('production catalog selection', () => {
  it('reads the catalog under authenticated write access and persists a server binding for both faces', async () => {
    const review = taskReviewFixture()[2]; review.units.forEach(unit => { unit.garment = garmentFixture(); });
    const state = importTaskReviews(emptyWpsProductionState(), [review]);
    vi.mocked(mutateWpsProductionState).mockImplementation(async (_revision, mutation) => mutation(state));
    const response = await POST(request()); const result = await response.json();
    expect(response.status).toBe(200); expect(catalogUser).toHaveBeenCalledWith(expect.any(NextRequest), true);
    expect(catalogDetail).toHaveBeenCalledWith(detail.id, undefined);
    expect(result.units.every((unit: { garment: { selection: string; variantId: string } }) => unit.garment.selection === 'manual' && unit.garment.variantId === detail.id)).toBe(true);
    expect(result.revision).toBe(state.revision + 1);
  });
  it('rejects injected asset snapshots and invalid IDs before reading or persisting', async () => {
    expect((await POST(request({ garment: garmentFixture() }))).status).toBe(400);
    expect((await POST(request({ variantId: 'wrong' }))).status).toBe(400);
    expect(catalogDetail).not.toHaveBeenCalled(); expect(mutateWpsProductionState).not.toHaveBeenCalled();
  });
});
