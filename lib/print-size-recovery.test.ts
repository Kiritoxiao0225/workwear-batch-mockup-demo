import { expect, it } from 'vitest';
import { recoverProductionPrintSizes } from './print-size-request';
import { emptyWpsProductionState, importTaskReviews, updateProductionPlan } from './wps-production';
import { taskReviewFixture } from './testing/task-review-fixture';
import { garmentFixture } from './testing/production-garment-fixture';
import { productionActionAssertion, productionActionSnapshot } from './production-artwork-snapshot';
import { placementPreview, productionPreviewRevision } from './production-preview';

function legacy() {
  const reviews = taskReviewFixture().slice(0, 2);
  const state = importTaskReviews(emptyWpsProductionState(), reviews);
  state.records[0].source.requirementText = '002HM 左胸图一宽9（位置：领口往下约18cm、门襟往左约9cm）';
  state.units[0].garment = garmentFixture();
  state.units[0].placement = { key: 'leftChest', templateVersion: 'catalog-v1', sizePolicy: 'body-55-v1',
    sizeMode: 'standard', widthCm: 10, rotation: 3, offsetX: 2, offsetY: 1,
    manual: { centerX: .5, centerY: .5, width: .15 },
    requestedSizeIssue: '“左胸宽9”未注明单位，请核对后填写自定义尺寸' };
  return state;
}

it('restores the old preview at 9 cm while retaining source state, artwork and save snapshots', () => {
  const state = legacy(), before = structuredClone(state);
  const recovered = recoverProductionPrintSizes(state), unit = recovered.units[0];
  expect(unit.placement).toMatchObject({ widthCm: 9, sizeMode: 'widthCm', requestedSize: { valueCm: 9, inferredUnit: true },
    manual: before.units[0].placement!.manual, rotation: 3, offsetX: 2, offsetY: 1 });
  expect(unit.placement!.requestedSizeIssue).toBeUndefined();
  const geometry = placementPreview(unit.garment!, unit.placement!, { width: 100, height: 100 });
  expect(geometry.width).toBeCloseTo(45); // 9 / 55 cm * 500 face pixels * 0.55 torso ratio
  expect(unit.artwork).toBe(state.units[0].artwork);
  expect(unit.attempts).toBe(state.units[0].attempts);
  expect(recovered.units[1]).toBe(state.units[1]);
  expect(recovered.mockupVersions).toBe(state.mockupVersions);
  expect(recovered.revision).toBe(state.revision);
  expect(state).toEqual(before);
  expect(recoverProductionPrintSizes(recovered)).toBe(recovered);
  const action = { action: 'savePlacements', updates: [{ unitId: unit.id }] };
  expect(() => productionActionAssertion({ ...action, ...productionActionSnapshot(recovered, action) })!(state)).not.toThrow();
  expect(productionPreviewRevision(recovered.mockupVersions[0], recovered.units))
    .not.toBe(productionPreviewRevision(state.mockupVersions[0], state.units));
  const saved = updateProductionPlan(state, unit.id, { placement: unit.placement });
  expect(saved.units[0].placement).toEqual(unit.placement);
  expect(saved.revision).toBe(state.revision + 1);
});

it.each(['override', 'confirmed', 'output', 'final', 'no-unit', 'mixed', 'other-issue', 'bound'])(
  'preserves existing decisions and unresolved requirements: %s', kind => {
    const state = legacy(), unit = state.units[0], version = state.mockupVersions[0];
    const confirmation = { actor: 'tester', confirmedAt: state.updatedAt, fingerprint: 'confirmed' };
    if (kind === 'override') unit.placement!.sizeOverride = true;
    if (kind === 'confirmed') unit.gateA = confirmation;
    if (kind === 'output') version.output = { url: '/saved.png' } as NonNullable<typeof version.output>;
    if (kind === 'final') version.finalConfirmation = confirmation;
    if (kind === 'no-unit') state.records[0].source.requirementText = '左胸宽9';
    if (kind === 'mixed') state.records[0].source.requirementText += '、向右20mm';
    if (kind === 'other-issue') unit.placement!.requestedSizeIssue = '同一位置出现多条尺寸要求';
    if (kind === 'bound') unit.placement!.requestedSize = { axis: 'widthCm', valueCm: 8, inferredUnit: false, evidence: '左胸宽8cm' };
    const before = structuredClone(state);
    expect(recoverProductionPrintSizes(state)).toBe(state);
    expect(state).toEqual(before);
  });
