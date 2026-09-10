import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLegacyArtworkDraft } from '@/lib/artwork-editor';
import { addArtworkText } from '@/lib/artwork-layers';
import { artworkQualityFixture } from '@/lib/testing/artwork-quality-fixture';
import { sharedFixture } from '@/lib/testing/shared-artwork-fixture';
import { bindSharedArtwork, detachSharedArtwork, sharedArtworkGroups } from '@/lib/shared-artwork';
import { attachProductionArtwork, type ArtworkValidation } from '@/lib/wps-production';
import { assertWpsProductionState } from './wps-production-store';
import { prepareSharedArtwork, commitSharedArtwork, type ArtworkAttachment } from './shared-artwork';
import { serverProductionTextColor, renderServerArtwork } from './render-artwork';
import { validateProductionArtworkDraft } from './production-artwork-quality';

vi.mock('./render-artwork', () => ({ serverProductionTextColor: vi.fn(), renderServerArtwork: vi.fn() }));
vi.mock('./production-storage', () => ({ usesProductionCloud: () => true, saveProductionFile: vi.fn(async () => ({ url: '/uploads/logos/variant.png' })) }));
vi.mock('./production-artwork-quality', () => ({ validateProductionArtworkDraft: vi.fn() }));
function validation(sha = 'a'.repeat(64)): ArtworkValidation {
  return { valid: true, mimeType: 'image/png', width: 1000, height: 1000, byteLength: 1000, sha256: sha, transparentPixelRatio: .3, visiblePixelRatio: .7,
    checkedAt: new Date().toISOString(), ruleVersion: 'transparent-artwork-v1', issues: [], quality: artworkQualityFixture(sha) };
}
function input(): ArtworkAttachment {
  const draft = addArtworkText(createLegacyArtworkDraft('/uploads/logos/source.png'), { x: 512, y: 512 }, '#ffffff').draft;
  draft.text!.value = 'poppy手机数码';
  return { url: '/uploads/logos/source.png', name: 'source.png', draft, validation: validation(), service: 'auto', requestSummary: '一次制作', actualCostCny: .2 };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(serverProductionTextColor).mockImplementation(async unit => unit.id === 'shared-u2' ? '#000000' : '#ffffff');
  vi.mocked(renderServerArtwork).mockResolvedValue({ bytes: Buffer.from('png'), width: 1000, height: 1000, contentBounds: { left: 0, top: 0, width: 1000, height: 1000 }, letters: [] });
  vi.mocked(validateProductionArtworkDraft).mockImplementation(async (_url, draft) => ({ validation: validation('b'.repeat(64)), draft }));
});
describe('publishing shared source and color variants', () => {
  it('saves all eight applications with one paid attempt and renders matching colors once', async () => {
    const state = sharedFixture(8, true), source = input();
    const next = commitSharedArtwork(state, (await prepareSharedArtwork(state, 'shared-u1', source))!);
    expect(next.units.every(unit => unit.artwork && unit.sharedArtworkVersion === 1)).toBe(true);
    expect(next.units[1].artwork?.draft?.text?.color).toBe('#000000');
    expect(next.units[2].artwork?.url).toBe(source.url);
    expect(renderServerArtwork).toHaveBeenCalledTimes(1);
    expect(next.units.reduce((sum, unit) => sum + unit.attempts.length, 0)).toBe(1);
    expect(next.revision).toBe(state.revision + 1);
    expect(next.units.map(unit => unit.placement)).toEqual(state.units.map(unit => unit.placement));
    assertWpsProductionState(next);
  });
  it('preserves an existing manual target and a finalized garment when first linking', async () => {
    let state = sharedFixture();
    state = attachProductionArtwork(state, 'shared-u2', { ...input(), service: 'manual-upload', validation: validation('c'.repeat(64)) }, 'old');
    state = bindSharedArtwork(state, 'shared-u1', ['shared-u2', 'shared-u3'], 'g');
    state.mockupVersions[2].finalConfirmation = { actor: '客户', at: new Date().toISOString(), fingerprint: 'fixed' } as never;
    const before = structuredClone(state);
    const next = commitSharedArtwork(state, (await prepareSharedArtwork(state, 'shared-u1', input(), { preserveExisting: true }))!);
    expect(next.units[1]).toEqual(before.units[1]);
    expect(next.units[2]).toEqual(before.units[2]);
    expect(next.mockupVersions[2]).toEqual(before.mockupVersions[2]);
    expect(next.sharedArtworks![0].versions).toHaveLength(1);
  });
  it('isolates a failed application and retries without generating or publishing another version', async () => {
    const state = sharedFixture(3, true);
    vi.mocked(serverProductionTextColor).mockRejectedValueOnce(new Error('底图暂时不可读'));
    const next = commitSharedArtwork(state, (await prepareSharedArtwork(state, 'shared-u1', input()))!);
    expect(next.units[0].artwork).toBeTruthy();
    expect(next.units[1].sharedArtworkError).toBe('底图暂时不可读');
    const restored = commitSharedArtwork(next, (await prepareSharedArtwork(next, 'shared-u1', { ...input(), service: 'manual-upload' }, { applyUnitId: 'shared-u2' }))!);
    expect(restored.units[1].artwork).toBeTruthy();
    expect(restored.units[1].sharedArtworkError).toBeUndefined();
    expect(restored.sharedArtworks![0].versions).toHaveLength(1);
  });
  it('keeps detached versions independent and does not recolor a manual common color edit', async () => {
    let state = sharedFixture(3, true);
    state = commitSharedArtwork(state, (await prepareSharedArtwork(state, 'shared-u1', input()))!);
    state = detachSharedArtwork(state, 'shared-u3', 'branch');
    const source = input(); source.service = 'manual-upload'; source.draft!.text!.color = '#ff0000';
    const next = commitSharedArtwork(state, (await prepareSharedArtwork(state, 'shared-u1', source))!);
    expect(next.units[1].artwork?.draft?.text?.color).toBe('#ff0000');
    expect(next.units[2].artwork?.draft?.text?.color).toBe('#ffffff');
    expect(sharedArtworkGroups(next).find(group => group.id === 'branch')?.derivedFrom).toBeTruthy();
    assertWpsProductionState(next);
  });
  it('adds a new application using the existing version and no new run', async () => {
    let state = bindSharedArtwork(sharedFixture(), 'shared-u1', ['shared-u2'], 'g');
    state = commitSharedArtwork(state, (await prepareSharedArtwork(state, 'shared-u1', input()))!);
    state = bindSharedArtwork(state, 'shared-u1', ['shared-u3'], 'ignored');
    const next = commitSharedArtwork(state, (await prepareSharedArtwork(state, 'shared-u1', { ...input(), service: 'manual-upload' }, { applyUnitIds: ['shared-u3'], preserveExisting: true }))!);
    expect(next.units[2].sharedArtworkVersion).toBe(1);
    expect(next.sharedArtworks![0].versions).toHaveLength(1);
    expect(next.units.reduce((sum, unit) => sum + unit.attempts.length, 0)).toBe(1);
  });
  it('records a new source run once even when the source garment is already finalized', async () => {
    let state = sharedFixture(3, true);
    state = commitSharedArtwork(state, (await prepareSharedArtwork(state, 'shared-u1', input()))!);
    state.mockupVersions[0].finalConfirmation = { actor: '客户', at: new Date().toISOString(), fingerprint: 'fixed' } as never;
    const before = structuredClone(state);
    const source = { ...input(), validation: validation('d'.repeat(64)) };
    const next = commitSharedArtwork(state, (await prepareSharedArtwork(state, 'shared-u1', source))!);
    expect(next.units[0].artwork).toEqual(before.units[0].artwork);
    expect(next.units[0].sharedArtworkVersion).toBe(1);
    expect(next.units[0].attempts).toHaveLength(2);
    expect(next.units[1].sharedArtworkVersion).toBe(2);
    expect(next.mockupVersions[0]).toEqual(before.mockupVersions[0]);
  });
});
