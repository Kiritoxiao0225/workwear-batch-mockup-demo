import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../app/api/wps-production/route';
import { productionArtworkSnapshot, newerProductionState, productionActionSnapshot, productionActionAssertion } from '@/lib/production-artwork-snapshot';
import { attachProductionArtwork, confirmProductionArtwork, confirmProductionPlan, emptyWpsProductionState, importTaskReviews, updateProductionPlan, WPS_COMPOSITOR_VERSION, type WpsProductionState } from '@/lib/wps-production';
import { createLegacyArtworkDraft } from '@/lib/artwork-editor';
import { addArtworkText, updateArtworkLayer } from '@/lib/artwork-layers';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { artworkQualityFixture } from '@/lib/testing/artwork-quality-fixture';
import { validateProductionArtworkDraft, validateProductionArtworkQuality } from './production-artwork-quality';
import { mutateWpsProductionState, readWpsProductionState } from './wps-production-store';
import { composeProductionMockup } from './wps-production-assets';

// Exercise the actual store queue and revision guards, using a private in-memory file.
const disk = vi.hoisted(() => ({ state: '', temporary: new Map<string, string>() }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real,
    readFile: vi.fn(async (...args: Parameters<typeof real.readFile>) => String(args[0]).endsWith('/data/wps-production-state.json') ? disk.state : real.readFile(...args)),
    writeFile: vi.fn(async (...args: Parameters<typeof real.writeFile>) => { if (String(args[0]).includes('/data/wps-production-state.json.')) disk.temporary.set(String(args[0]), String(args[1])); else return real.writeFile(...args); }),
    rename: vi.fn(async (...args: Parameters<typeof real.rename>) => { if (String(args[1]).endsWith('/data/wps-production-state.json')) { disk.state = disk.temporary.get(String(args[0]))!; disk.temporary.delete(String(args[0])); } else return real.rename(...args); }),
  };
});
vi.mock('./production-artwork-quality', () => ({ validateProductionArtworkQuality: vi.fn(), validateProductionArtworkDraft: vi.fn() }));
vi.mock('./wps-production-assets', async importOriginal => ({ ...await importOriginal<typeof import('./wps-production-assets')>(), composeProductionMockup: vi.fn() }));
const validation = (suffix: string) => ({ valid: true, mimeType: 'image/png' as const, width: 1000, height: 1000, byteLength: 1000, sha256: suffix.repeat(64), quality: artworkQualityFixture(suffix.repeat(64)), transparentPixelRatio: .5, visiblePixelRatio: .5, checkedAt: '2026-09-07T00:00:00.000Z', ruleVersion: 'transparent-artwork-v1' as const, issues: [] });
let initial: WpsProductionState;
beforeEach(() => {
  vi.clearAllMocks();
  initial = importTaskReviews(emptyWpsProductionState(), [taskReviewFixture()[2]]);
  disk.state = JSON.stringify(initial);
  disk.temporary.clear();
  vi.mocked(validateProductionArtworkDraft).mockImplementation(async url => ({ validation: validation(url.includes('first') ? 'a' : 'b'), draft: undefined }));
});
function input(index: number) {
  const unit = initial.units[index];
  return { action: 'submitArtwork', expectedRevision: initial.revision, expectedUnitSnapshot: productionArtworkSnapshot(unit, initial.records[0].source), unitId: unit.id,
    url: `/uploads/logos/${index ? 'second' : 'first'}.png`, name: 'generated.png', service: unit.route, requestSummary: '并发验收' };
}
const post = (body: Record<string, unknown>) => POST(new Request('http://localhost/api/wps-production', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

describe('concurrent artwork commits', () => {
  for (const outcome of ['success', 'failure', 'target-changed'] as const) it(`isolates a version composition ${outcome} from unrelated saves`, async () => {
    initial = importTaskReviews(emptyWpsProductionState(), [taskReviewFixture()[2], taskReviewFixture()[0]]);
    const versionId = initial.mockupVersions.find(version => version.unitIds.includes('snapshot-03-u1'))!.id;
    for (const id of ['snapshot-03-u1', 'snapshot-03-u2']) {
      initial = confirmProductionPlan(initial, id, 'tester');
      initial = attachProductionArtwork(initial, id, { url: '/uploads/logos/original.png', name: 'original.png', validation: validation('a'), service: 'manual-upload', requestSummary: 'original' }, `original-${id}`);
      initial = confirmProductionArtwork(initial, id, 'tester');
    }
    disk.state = JSON.stringify(initial);
    vi.mocked(composeProductionMockup).mockImplementationOnce(async version => {
      const current = await readWpsProductionState();
      const changedId = outcome === 'target-changed' ? 'snapshot-03-u2' : 'snapshot-01-u1';
      await mutateWpsProductionState(current.revision, state => updateProductionPlan(state, changedId, outcome === 'target-changed'
        ? { placement: { ...state.units.find(unit => unit.id === changedId)!.placement!, rotation: 5 } }
        : { instruction: '并行修改制作要求' }));
      if (outcome === 'failure') throw new Error('test rendering failure');
      return { url: '/uploads/mockups/composed.png', name: 'composed.png', sha256: 'f'.repeat(64), width: 1084, height: 767, byteLength: 1000,
        compositorVersion: WPS_COMPOSITOR_VERSION, composeFingerprint: version.composeFingerprint!, createdAt: new Date().toISOString() };
    });
    const action = { action: 'composeVersion', versionId };
    const response = await post({ ...action, ...productionActionSnapshot(initial, action), expectedRevision: initial.revision });
    expect(response.status).toBe(outcome === 'success' ? 200 : outcome === 'failure' ? 502 : 409);
    const saved = await readWpsProductionState();
    const version = saved.mockupVersions.find(version => version.id === versionId)!;
    if (outcome === 'success') expect(version.output?.url).toBe('/uploads/mockups/composed.png');
    else expect(version.output).toBeNull();
    if (outcome === 'failure') expect(version.compositionError).toBe('test rendering failure');
    if (outcome === 'target-changed') {
      expect(version.compositionError).toBeNull();
      expect(saved.units.find(unit => unit.id === 'snapshot-03-u2')?.placement?.rotation).toBe(5);
    } else expect(saved.units.find(unit => unit.id === 'snapshot-01-u1')?.instruction).toBe('并行修改制作要求');
  });

  it('confirms one image while the other image saves from the same revision', async () => {
    initial = attachProductionArtwork(initial, initial.units[0].id, { url: '/uploads/logos/original.png', name: 'original.png', validation: validation('a'), service: 'manual-upload', requestSummary: 'original' }, 'original');
    disk.state = JSON.stringify(initial);
    const confirmation = { action: 'confirmArtwork', unitId: initial.units[0].id, actor: 'tester' };
    const request = { ...confirmation, ...productionActionSnapshot(initial, confirmation), expectedRevision: initial.revision };
    const results = await Promise.all([post(input(1)), post(request)]);
    expect(results.map(response => response.status)).toEqual([200, 200]);
    const saved = await readWpsProductionState();
    expect(saved.revision).toBe(initial.revision + 2);
    expect(saved.units[0].gateB?.fingerprint).toBe(validation('a').sha256);
    expect(saved.units[1].artwork?.url).toBe('/uploads/logos/second.png');
    expect(saved.records).toEqual(initial.records);
  });

  it('rejects confirmation of a replaced image, without confirming the unseen replacement', async () => {
    initial = attachProductionArtwork(initial, initial.units[0].id, { url: '/uploads/logos/original.png', name: 'original.png', validation: validation('a'), service: 'manual-upload', requestSummary: 'original' }, 'original');
    const confirmation = { action: 'confirmArtwork', unitId: initial.units[0].id, actor: 'tester' };
    const request = { ...confirmation, ...productionActionSnapshot(initial, confirmation), expectedRevision: initial.revision };
    const replaced = attachProductionArtwork(initial, initial.units[0].id, { url: '/uploads/logos/replaced.png', name: 'replaced.png', validation: validation('b'), service: 'manual-upload', requestSummary: 'replacement' }, 'replacement');
    disk.state = JSON.stringify(replaced);
    expect((await post(request)).status).toBe(409);
    expect(await readWpsProductionState()).toEqual(replaced);
    expect(replaced.units[0].gateB).toBeNull();
  });

  it('allows a plan edit on another image during generation and retains both changes', async () => {
    const update = { action: 'updatePlan', unitId: initial.units[0].id, patch: { instruction: '新的局部制作要求' } };
    const results = await Promise.all([post(input(1)), post({ ...update, ...productionActionSnapshot(initial, update), expectedRevision: initial.revision })]);
    expect(results.map(response => response.status)).toEqual([200, 200]);
    const saved = await readWpsProductionState();
    expect(saved.units[0].instruction).toBe('新的局部制作要求');
    expect(saved.units[1].artwork).not.toBeNull();
  });

  it('allows an editor save while another image finishes, but rejects a stale editor for the same image', async () => {
    initial = attachProductionArtwork(initial, initial.units[0].id, { url: '/uploads/logos/original.png', name: 'original.png', validation: validation('a'), service: 'manual-upload', requestSummary: 'original' }, 'original');
    disk.state = JSON.stringify(initial);
    const draft = createLegacyArtworkDraft('/uploads/logos/edited.png');
    const edit = { action: 'saveArtworkDraft', unitId: initial.units[0].id, url: '/uploads/logos/edited.png', name: 'edited.png', draft, service: 'manual-upload', requestSummary: 'edit' };
    const request = { ...edit, ...productionActionSnapshot(initial, edit), expectedRevision: initial.revision };
    const responses = await Promise.all([post(input(1)), post(request)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect((await post(request)).status).toBe(409);
    expect((await readWpsProductionState()).units.map(unit => unit.artwork?.url)).toEqual(['/uploads/logos/edited.png', '/uploads/logos/second.png']);
  });

  it('binds version actions to all their images and rejects forged scope snapshots', () => {
    const versions = importTaskReviews(emptyWpsProductionState(), taskReviewFixture());
    const target = versions.mockupVersions.find(version => version.unitIds.length > 1)!;
    const other = versions.mockupVersions.find(version => version.id !== target.id)!;
    const action = { action: 'composeVersion', versionId: target.id };
    const guard = productionActionAssertion({ ...action, ...productionActionSnapshot(versions, action) })!;
    const unrelated = updateProductionPlan(versions, other.unitIds[0], { instruction: '其他版本的新要求' });
    expect(() => guard(unrelated)).not.toThrow();
    const changed = updateProductionPlan(unrelated, target.unitIds[1], { instruction: '本版本背面新要求' });
    expect(() => guard(changed)).toThrow('本服装版本');
    const forged = productionActionAssertion({ ...action, ...productionActionSnapshot(versions, { action: 'confirmArtwork', unitId: target.unitIds[0] }) })!;
    expect(() => forged(versions)).toThrow();
  });

  it('saves an edit without quality calls and allows human confirmation without a score', async () => {
    const unit = initial.units[0];
    const original = createLegacyArtworkDraft('/uploads/logos/original.png');
    let state = attachProductionArtwork(initial, unit.id, { url: original.graphic.sourceUrl, name: 'original.png', draft: original,
      validation: validation('a'), service: 'manual-upload', requestSummary: 'original' }, 'original');
    state = confirmProductionArtwork(state, unit.id, 'tester');
    disk.state = JSON.stringify(state);
    const draft = structuredClone(original); draft.graphic.x += 30;
    vi.mocked(validateProductionArtworkDraft).mockResolvedValue({ validation: { ...validation('b'), quality: undefined }, draft });
    const response = await post({ action: 'saveArtworkDraft', expectedRevision: state.revision, unitId: unit.id,
      url: '/uploads/logos/edited.png', name: 'edited.png', draft, service: 'manual-upload', requestSummary: 'edit' });
    expect(response.status).toBe(200);
    expect(validateProductionArtworkQuality).not.toHaveBeenCalled();
    expect(validateProductionArtworkDraft).toHaveBeenCalledWith('/uploads/logos/edited.png', draft, state.units[0].artwork!.validation, state.units[0].artwork!.draft);
    const saved = await readWpsProductionState();
    expect(saved.units[0].artwork?.draft).toEqual(draft);
    expect(saved.units[0].gateB).toBeNull();
    expect(saved.units[1]).toEqual(state.units[1]);
    expect(confirmProductionArtwork(saved, unit.id, 'tester').units[0].gateB).not.toBeNull();
  });

  it('saves two different units from the same starting revision without losing either image', async () => {
    const [first, second] = await Promise.all([post(input(0)), post(input(1))]);
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    const saved = await readWpsProductionState();
    expect(saved.revision).toBe(initial.revision + 2);
    expect(saved.units.map(unit => unit.artwork?.url)).toEqual(['/uploads/logos/first.png', '/uploads/logos/second.png']);
    expect(saved.records).toEqual(initial.records);
    expect(saved.units.every(unit => unit.attempts.length === 1)).toBe(true);
  });

  it('saves independent multiline text layers through the actual route and reopens their full styles', async () => {
    const unit = initial.units[0], original = createLegacyArtworkDraft('/uploads/logos/original.png');
    const state = attachProductionArtwork(initial, unit.id, { url: original.graphic.sourceUrl, name: 'original.png', draft: original,
      validation: validation('a'), service: 'manual-upload', requestSummary: 'original' }, 'original');
    disk.state = JSON.stringify(state);
    const first = addArtworkText(original, { x: 512, y: 800 });
    const second = addArtworkText(first.draft, { x: 512, y: 950 });
    const draft = updateArtworkLayer(second.draft, first.selectedId, { value: '宜宾学院\n志愿者', lineHeight: 1.8, color: '#24654b' });
    vi.mocked(validateProductionArtworkDraft).mockResolvedValue({ validation: { ...validation('b'), quality: undefined }, draft });
    const response = await post({ action: 'saveArtworkDraft', expectedRevision: state.revision, unitId: unit.id,
      url: '/uploads/logos/edited.png', name: 'edited.png', draft, service: 'manual-upload', requestSummary: '新增独立文字' });
    expect(response.status).toBe(200);
    const reopened = await readWpsProductionState();
    expect(reopened.units[0].artwork?.draft).toEqual(draft);
    expect(reopened.units[0].artwork?.draft?.graphic.sourceUrl).toBe(original.graphic.sourceUrl);
    expect(reopened.units[0].gateB).toBeNull();
    expect(reopened.units[1]).toEqual(state.units[1]);
    expect(validateProductionArtworkQuality).not.toHaveBeenCalled();
  });

  it('rejects a changed task before quality calls, while allowing the other task to finish', async () => {
    await mutateWpsProductionState(initial.revision, state => updateProductionPlan(state, initial.units[0].id, { exactText: '新要求' }));
    expect((await post(input(0))).status).toBe(409);
    expect(validateProductionArtworkQuality).not.toHaveBeenCalled();
    expect((await post(input(1))).status).toBe(200);
  });

  it('rechecks the task inside the write queue if it changes during quality inspection', async () => {
    vi.mocked(validateProductionArtworkDraft).mockImplementationOnce(async () => {
      await mutateWpsProductionState(initial.revision, state => updateProductionPlan(state, initial.units[0].id, { instruction: '已改为新的制作要求' }));
      return { validation: validation('a'), draft: undefined };
    });
    expect((await post(input(0))).status).toBe(409);
    expect((await readWpsProductionState()).units[0].artwork).toBeNull();
  });

  it('allows only one of two simultaneous submissions for the same frozen task', async () => {
    const responses = await Promise.all([post(input(0)), post(input(0))]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await readWpsProductionState()).units[0].attempts).toHaveLength(1);
  });

  it('does not overwrite a newly imported source using the old request', async () => {
    const changed = structuredClone(initial);
    changed.records[0].source.requirementText += ' 新的原始要求';
    disk.state = JSON.stringify(changed);
    expect((await post(input(0))).status).toBe(409);
    expect(validateProductionArtworkQuality).not.toHaveBeenCalled();
  });

  it('isolates a failed quality call and preserves strict revisions for legacy submissions', async () => {
    vi.mocked(validateProductionArtworkDraft).mockRejectedValueOnce(new Error('quality unavailable'));
    expect((await post(input(0))).status).toBe(400);
    expect((await post(input(1))).status).toBe(200);
    const legacy: Record<string, unknown> = input(0); delete legacy.expectedUnitSnapshot;
    expect((await post(legacy)).status).toBe(409);
    const saved = await readWpsProductionState();
    expect(saved.units[0].artwork).toBeNull(); expect(saved.units[1].artwork).not.toBeNull();
    expect(newerProductionState(saved, initial)).toBe(saved);
    expect(newerProductionState(initial, saved)).toBe(saved);
  });
});
