import { describe, expect, it } from 'vitest';
import { sharedFixture } from './testing/shared-artwork-fixture';
import { sharedArtworkGroups } from './shared-artwork';
import { sharedActionCompleted, sharedArtworkStatus, productionActionError } from './shared-artwork-status';
import type { ProductionArtwork } from './wps-production';

function saved() {
  const state = sharedFixture(3, true);
  const group = sharedArtworkGroups(state)[0];
  state.units = state.units.map(unit => ({ ...unit, sharedArtworkVersion: 1, artwork: {
    url: '/uploads/logos/test.png', name: 'test.png', recipeFingerprint: unit.recipeFingerprint, createdAt: state.updatedAt,
    validation: { valid: true, sha256: unit.id, mimeType: 'image/png', width: 1000, height: 1000, byteLength: 1000,
      transparentPixelRatio: .3, visiblePixelRatio: .7, checkedAt: state.updatedAt, ruleVersion: 'transparent-artwork-v1', issues: [] },
  } as ProductionArtwork }));
  group.versions = [{ number: 1, artwork: state.units[0].artwork!, automaticTextColor: true, createdAt: state.updatedAt }];
  state.sharedArtworks = [group];
  return { state, group };
}

describe('shared application results and confirmation recovery', () => {
  it('distinguishes saved applications from human confirmation', () => {
    const { state, group } = saved();
    expect(sharedArtworkStatus(state, group)).toMatchObject({ applied: 3, confirmed: 0, confirmable: 3, complete: false });
    state.units.forEach(unit => { unit.gateB = { actor: 'test', confirmedAt: state.updatedAt, fingerprint: unit.artwork!.validation.sha256 }; });
    expect(sharedArtworkStatus(state, group)).toMatchObject({ applied: 3, confirmed: 3, confirmable: 0, complete: true });
  });
  it('does not call a partly applied group complete or replace a protected garment', () => {
    const { state, group } = saved();
    state.units[1].sharedArtworkVersion = 0;
    state.units[1].sharedArtworkError = '底图暂时不可读';
    state.units[2].sharedArtworkVersion = 0;
    state.mockupVersions[2].finalConfirmation = { actor: '客户', confirmedAt: state.updatedAt, fingerprint: 'fixed' };
    const result = sharedArtworkStatus(state, group);
    expect(result).toMatchObject({ applied: 1, confirmed: 0, confirmable: 1, failed: 1, complete: false });
    expect(result.applications[1]).toMatchObject({ status: '应用失败', canApply: true, canConfirm: false });
    expect(result.applications[2]).toMatchObject({ fixed: true, canApply: false, canConfirm: false });
  });
  it('rejects stale confirmations and concrete content failures but permits optional quality advice', () => {
    const { state, group } = saved();
    state.units[0].artwork!.recipeFingerprint = 'old';
    state.units[1].artwork!.validation.contentIssues = ['缺少文字'];
    state.units[2].gateB = { actor: 'test', confirmedAt: state.updatedAt, fingerprint: 'old-image' };
    state.units[2].artwork!.validation.qualityError = '评分服务超时';
    expect(sharedArtworkStatus(state, group)).toMatchObject({ confirmable: 1, confirmed: 0, complete: false });
  });
  it('only recovers a lost confirmation response when all requested image identities match', () => {
    const { state } = saved();
    const after = structuredClone(state), input = { action: 'confirmSharedArtwork', unitId: state.units[0].id };
    expect(sharedActionCompleted(state, after, input)).toBe(false);
    after.units.forEach(unit => { unit.gateB = { actor: 'test', confirmedAt: after.updatedAt, fingerprint: unit.artwork!.validation.sha256 }; });
    expect(sharedActionCompleted(state, after, input)).toBe(true);
    after.units[1].artwork!.validation.sha256 = 'new-image';
    expect(sharedActionCompleted(state, after, input)).toBe(false);
  });
  it('a failed or missing application cannot be reported as recovered', () => {
    const { state } = saved();
    const after = structuredClone(state), input = { action: 'applySharedArtwork', unitId: state.units[1].id };
    after.units[1].sharedArtworkError = '应用失败';
    expect(sharedActionCompleted(state, after, input)).toBe(false);
    after.units[1].sharedArtworkError = undefined;
    expect(sharedActionCompleted(state, after, input)).toBe(true);
    after.units[1].artwork = null;
    expect(sharedActionCompleted(state, after, input)).toBe(false);
  });
  it('shows a readable outage without mistaking it for a failed image generation', () => {
    expect(productionActionError(new Error('canceling statement due to statement timeout'))).toBe('服务响应超时');
    expect(productionActionError(new Error('工作台账号不存在或已停用'))).toBe('工作台账号暂不可用');
  });
});
