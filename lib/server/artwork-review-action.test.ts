import { beforeEach, expect, it, vi } from 'vitest';
import { POST } from './wps-production-actions';
import { readWpsProductionState, mutateWpsProductionState } from './wps-production-store';
import { productionUser } from './production-storage';
import { inspectFinalArtwork } from './artwork-final-review';
import { emptyWpsProductionState, importTaskReviews, type ArtworkValidation } from '@/lib/wps-production';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { productionActionSnapshot } from '@/lib/production-artwork-snapshot';
vi.mock('./wps-production-store', async original => ({ ...await original<typeof import('./wps-production-store')>(), readWpsProductionState: vi.fn(), mutateWpsProductionState: vi.fn() }));
vi.mock('./production-storage', async original => ({ ...await original<typeof import('./production-storage')>(), productionUser: vi.fn(), usesProductionCloud: () => false }));
vi.mock('./artwork-final-review', () => ({ inspectFinalArtwork: vi.fn() }));
let state = emptyWpsProductionState();
beforeEach(() => {
  vi.clearAllMocks(); state = importTaskReviews(emptyWpsProductionState(), [taskReviewFixture()[2]]);
  state.units[0].artwork = { url: '/uploads/logos/test.png', name: 'test', recipeFingerprint: state.units[0].recipeFingerprint, createdAt: state.updatedAt,
    validation: { sha256: 'a'.repeat(64), valid: true, issues: [], checkedAt: state.updatedAt } as unknown as ArtworkValidation };
  vi.mocked(productionUser).mockResolvedValue({ id: 'account-id', displayName: '真实账号', email: 'test@example.com', role: 'editor' });
  vi.mocked(readWpsProductionState).mockImplementation(async () => structuredClone(state));
  vi.mocked(mutateWpsProductionState).mockImplementation(async (_revision, change, guard) => { await guard?.(state); state = await change(structuredClone(state)); return state; });
});
function request(extra: Record<string, unknown> = {}) {
  const input = { action: 'reviewArtwork', unitId: state.units[0].id, sha256: state.units[0].artwork!.validation.sha256, mode: 'accepted', itemIds: ['color'], note: '客户接受此配色', actor: '伪造姓名', ...extra };
  return new Request('http://localhost/api/wps-production', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, expectedRevision: state.revision, ...productionActionSnapshot(state, input) }) });
}
it('saves only review metadata, preserving other units, approvals and customer previews', async () => {
  const before = structuredClone(state);
  const response = await POST(request()); expect(response.status).toBe(200);
  expect(state.revision).toBe(before.revision + 1);
  expect(state.units.slice(1)).toEqual(before.units.slice(1)); expect(state.mockupVersions).toEqual(before.mockupVersions);
  expect(state.units[0].gateB).toEqual(before.units[0].gateB);
  expect(state.units[0].artwork!.url).toBe(before.units[0].artwork!.url);
  expect(state.units[0].artwork!.validation.review!.items.find(i => i.id === 'color')).toMatchObject({ status: 'accepted', actor: '真实账号 (account-id)', note: '客户接受此配色' });
  expect(inspectFinalArtwork).not.toHaveBeenCalled();
});
it('rejects finalized records without mutation or inspection', async () => {
  state.mockupVersions[0].finalConfirmation = { actor: '客户', confirmedAt: state.updatedAt, fingerprint: 'final' };
  const before = structuredClone(state); const response = await POST(request());
  expect(response.status).not.toBe(200); expect(state).toEqual(before); expect(mutateWpsProductionState).not.toHaveBeenCalled();
});
it('rejects an old image or missing human explanation', async () => {
  expect((await POST(request({ sha256: 'old' }))).status).toBe(409);
  expect((await POST(request({ note: '' }))).status).not.toBe(200); expect(mutateWpsProductionState).not.toHaveBeenCalled();
});
it('rejects concurrent target changes after inspection without overwriting the new artwork', async () => {
  vi.mocked(inspectFinalArtwork).mockImplementation(async (_unit, _source, _url, ledger) => {
    state.units[0].updatedAt = '2026-09-12T00:00:00Z'; state.units[0].artwork!.validation.sha256 = 'new'; return ledger;
  });
  expect((await POST(request({ mode: 'automatic' }))).status).toBe(409);
  expect(state.units[0].artwork!.validation.sha256).toBe('new'); expect(state.units[0].artwork!.validation.review).toBeUndefined();
});
