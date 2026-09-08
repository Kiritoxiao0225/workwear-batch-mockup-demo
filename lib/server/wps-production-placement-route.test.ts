import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../app/api/wps-production/route';
import { mutateWpsProductionState, readWpsProductionState } from './wps-production-store';
import { verifyGarmentBinding } from './wps-production-garments';
import { withGarmentBodyScale } from './wps-garment-sizing';
import { validateProductionArtwork } from './wps-production-assets';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { garmentFixture } from '@/lib/testing/production-garment-fixture';
import { artworkQualityFixture } from '@/lib/testing/artwork-quality-fixture';
import { attachProductionArtwork, confirmProductionArtwork, emptyWpsProductionState, importTaskReviews, updateProductionPlan, type ArtworkValidation, type WpsProductionState } from '@/lib/wps-production';
import { initialTaskPlacement } from '@/lib/production-preview';
import { printSizeCm } from '@/lib/production-sizing';

vi.mock('./wps-production-store', () => ({ mutateWpsProductionState: vi.fn(), readWpsProductionState: vi.fn(), ProductionRevisionConflictError: class extends Error {} }));
vi.mock('./wps-production-garments', () => ({ verifyGarmentBinding: vi.fn(), prepareCatalogReviews: vi.fn() }));
vi.mock('./wps-garment-sizing', () => ({ withGarmentBodyScale: vi.fn() }));
vi.mock('./wps-production-assets', () => ({ validateProductionArtwork: vi.fn(), composeProductionMockup: vi.fn() }));
let stored: WpsProductionState;
const sha = 'b'.repeat(64);
const validation: ArtworkValidation = { valid: true, mimeType: 'image/png', width: 1000, height: 1000, byteLength: 1000, sha256: sha, quality: artworkQualityFixture(sha), transparentPixelRatio: .5, visiblePixelRatio: .5, checkedAt: '2026-09-07T00:00:00.000Z', ruleVersion: 'transparent-artwork-v1', issues: [] };
beforeEach(() => {
  vi.resetAllMocks();
  const review = taskReviewFixture()[2];
  for (const unit of review.units) unit.garment = garmentFixture();
  stored = importTaskReviews(emptyWpsProductionState(), [review]);
  for (const unit of stored.units) stored = updateProductionPlan(stored, unit.id, { garment: garmentFixture(), placement: { ...unit.placement!, templateVersion: 'catalog-v1', sizeMode: 'standard', sizePolicy: 'body-55-v1', widthCm: 7 } });
  vi.mocked(mutateWpsProductionState).mockImplementation(async (revision, mutate) => {
    if (revision !== stored.revision) throw new Error('stale revision');
    const result = await mutate(structuredClone(stored));
    stored = result;
    return result;
  });
  vi.mocked(readWpsProductionState).mockImplementation(async () => structuredClone(stored));
  vi.mocked(withGarmentBodyScale).mockImplementation(async garment => garment);
  vi.mocked(validateProductionArtwork).mockResolvedValue(validation);
});
const updates = () => stored.units.map(unit => ({ unitId: unit.id, placement: initialTaskPlacement(unit, { width: 1, height: 1 }) }));
const request = (entries = updates(), confirmArtworkPlacement = true, confirmWholeVersion = false) => new Request('http://localhost:3000/api/wps-production', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'savePlacements', expectedRevision: stored.revision, actor: '测试操作员', confirmArtworkPlacement, confirmWholeVersion, updates: entries }) });
function prepareBothArtworks() {
  for (const unit of stored.units) stored = attachProductionArtwork(stored, unit.id, { url: '/uploads/logos/test.png', name: 'test.png', validation, service: 'manual-upload', requestSummary: 'test' }, `test-${unit.id}`);
}

describe('saving the garment position canvas', () => {
  it('binds source dimensions on the server and preserves artwork when old clients submit stale sizes', async () => {
    prepareBothArtworks();
    stored.records[0].source.requirementText = '正面高35cm 后背宽8';
    // No restrictive catalog standard: this test isolates source sizing from safe-area validation.
    stored.units.forEach(unit => unit.garment!.views.forEach(view => { view.standard = null; }));
    const before = structuredClone(stored);
    const entries = updates().map(entry => ({ ...entry, placement: { ...entry.placement, sizeMode: 'widthCm' as const, widthCm: 30, heightCm: 35 } }));
    const response = await POST(request(entries, false));
    expect(response.status).toBe(200);
    expect(printSizeCm(stored.units[0].placement!, 1).height).toBe(35);
    expect(printSizeCm(stored.units[1].placement!, 1).width).toBe(8);
    expect(stored.units.map(unit => unit.artwork)).toEqual(before.units.map(unit => unit.artwork));
    expect(stored.units.map(unit => unit.recipeFingerprint)).toEqual(before.units.map(unit => unit.recipeFingerprint));
    expect(stored.units.map(unit => unit.attempts)).toEqual(before.units.map(unit => unit.attempts));
    expect(stored.records).toEqual(before.records);
  });
  it('records an explicit custom size without discarding the customer requirement', async () => {
    prepareBothArtworks();
    stored.records[0].source.requirementText = '正面高35cm 后背宽8';
    stored.units.forEach(unit => unit.garment!.views.forEach(view => { view.standard = null; }));
    const entries = updates().map(entry => ({ ...entry, placement: { ...entry.placement, sizeOverride: true, sizeMode: 'widthCm' as const, widthCm: 12 } }));
    expect((await POST(request(entries, false))).status).toBe(200);
    expect(stored.units[0].placement).toMatchObject({ sizeOverride: true, requestedSize: { axis: 'heightCm', valueCm: 35 } });
    expect(printSizeCm(stored.units[0].placement!, 1).width).toBe(12);
  });
  it('shares identical garment checks, while checking both image files before a single commit', async () => {
    prepareBothArtworks();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(verifyGarmentBinding).mockImplementation(async () => { await pending; return undefined as never; });
    const before = structuredClone(stored);
    const saving = POST(request(updates(), false));
    await vi.waitFor(() => expect(validateProductionArtwork).toHaveBeenCalledTimes(2));
    expect(verifyGarmentBinding).toHaveBeenCalledOnce();
    expect(stored).toEqual(before);
    release();
    expect((await saving).status).toBe(200);
    expect(stored.revision).toBe(before.revision + 1);
  });
  it('confirms all artwork and placements with one save, preserving the source record', async () => {
    prepareBothArtworks();
    const revision = stored.revision, records = structuredClone(stored.records);
    expect(stored.units.every(unit => !unit.gateB)).toBe(true);
    expect((await POST(request(updates(), true, true))).status).toBe(200);
    expect(stored.revision).toBe(revision + 1);
    expect(stored.records).toEqual(records);
    expect(stored.units.every(unit => unit.gateA && unit.gateB?.fingerprint === sha)).toBe(true);
    expect(stored.mockupVersions[0].status).toBe('readyToCompose');
    expect(stored.mockupVersions[0].finalConfirmation).toBeNull();
  });
  it('saves all drafts without implicitly confirming existing artwork', async () => {
    prepareBothArtworks();
    expect((await POST(request(updates(), false))).status).toBe(200);
    expect(stored.units.every(unit => unit.placement?.manual && !unit.gateA && !unit.gateB)).toBe(true);
  });
  it('rejects an incomplete whole garment confirmation', async () => {
    prepareBothArtworks();
    const before = structuredClone(stored);
    expect((await POST(request([updates()[0]], true, true))).status).toBe(400);
    expect(stored).toEqual(before);
  });
  it('rolls back the entire confirmation when a later face has a changed image', async () => {
    prepareBothArtworks();
    const before = structuredClone(stored);
    vi.mocked(validateProductionArtwork).mockResolvedValueOnce(validation).mockResolvedValueOnce({ ...validation, sha256: 'c'.repeat(64) });
    expect((await POST(request(updates(), true, true))).status).toBe(422);
    expect(stored).toEqual(before);
  });
  it('rejects whole garment confirmation while any artwork is missing', async () => {
    const unit = stored.units[0];
    stored = attachProductionArtwork(stored, unit.id, { url: '/uploads/logos/test.png', name: 'test.png', validation, service: 'manual-upload', requestSummary: 'test' }, 'test');
    const before = structuredClone(stored);
    expect((await POST(request(updates(), true, true))).status).toBe(422);
    expect(stored).toEqual(before);
  });
  it('saves both face drafts atomically before a Logo exists, without confirming them', async () => {
    const revision = stored.revision, records = structuredClone(stored.records);
    expect(stored.units).toHaveLength(2);
    expect((await POST(request())).status).toBe(200);
    expect(stored.revision).toBe(revision + 1);
    expect(stored.records).toEqual(records);
    expect(stored.units.every(unit => unit.placement?.manual && !unit.gateA && !unit.gateB && !unit.artwork)).toBe(true);
    expect(validateProductionArtwork).not.toHaveBeenCalled();
  });
  it('leaves both positions unchanged when the second face is out of bounds', async () => {
    const before = structuredClone(stored), entries = updates();
    entries[1].placement.manual!.centerX = .999;
    entries[1].placement.widthCm = 50;
    entries[1].placement.sizeMode = 'widthCm';
    expect((await POST(request(entries))).status).toBe(400);
    expect(stored).toEqual(before);
  });
  it('rejects a position outside this garment version before touching bindings', async () => {
    const entries = updates();
    entries[1].unitId = 'another-version';
    expect((await POST(request(entries))).status).toBe(400);
    expect(verifyGarmentBinding).not.toHaveBeenCalled();
  });
  it('confirms placement only for the current confirmed Logo and keeps source evidence', async () => {
    const unit = stored.units[0];
    stored = attachProductionArtwork(stored, unit.id, { url: '/uploads/logos/test.png', name: 'test.png', validation, service: 'manual-upload', requestSummary: 'test', actualCostCny: 0 }, 'test-attempt');
    stored = confirmProductionArtwork(stored, unit.id, '测试操作员');
    const revision = stored.revision;
    expect((await POST(request([updates()[0]]))).status).toBe(200);
    expect(stored.revision).toBe(revision + 1);
    expect(stored.units[0].gateA).not.toBeNull();
    expect(stored.units[1].gateA).toBeNull();
    expect(stored.units[0].gateB?.fingerprint).toBe(sha);
  });
  it('does not confirm a replaced image using the previous Logo approval', async () => {
    const unit = stored.units[0];
    stored = attachProductionArtwork(stored, unit.id, { url: '/uploads/logos/test.png', name: 'test.png', validation, service: 'manual-upload', requestSummary: 'test' }, 'test-attempt');
    stored = confirmProductionArtwork(stored, unit.id, '测试操作员');
    const before = structuredClone(stored);
    vi.mocked(validateProductionArtwork).mockResolvedValue({ ...validation, sha256: 'c'.repeat(64) });
    expect((await POST(request([updates()[0]]))).status).toBe(422);
    expect(stored).toEqual(before);
  });
  it('selecting a garment position keeps the Logo unpositioned even after artwork approval', async () => {
    const unit = stored.units[0];
    stored = attachProductionArtwork(stored, unit.id, { url: '/uploads/logos/test.png', name: 'test.png', validation, service: 'manual-upload', requestSummary: 'test' }, 'test-attempt');
    stored = confirmProductionArtwork(stored, unit.id, '测试操作员');
    const records = structuredClone(stored.records);
    expect((await POST(request([updates()[0]], false))).status).toBe(200);
    expect(stored.units[0].placement?.manual).toBeTruthy();
    expect(stored.units[0].gateA).toBeNull();
    expect(stored.units[0].gateB?.fingerprint).toBe(sha);
    expect(stored.records).toEqual(records);
  });
});
