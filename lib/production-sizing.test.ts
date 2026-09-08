import { describe, expect, it } from 'vitest';
import { defaultPrintSize, MOCKUP_SIZE_POLICY, printSizeCm } from './production-sizing';
import { productionPlacementGeometry } from './production-garment';
import { initialTaskPlacement } from './production-preview';
import { garmentFixture } from './testing/production-garment-fixture';
import { emptyWpsProductionState, importTaskReviews, type ProductionPlacement, type ArtworkValidation } from './wps-production';
import { taskReviewFixture } from './testing/task-review-fixture';

const placement: ProductionPlacement = { key: 'leftChest', sizePolicy: MOCKUP_SIZE_POLICY, sizeMode: 'standard', widthCm: 10, rotation: 0, offsetX: 0, offsetY: 0, templateVersion: 'catalog-v1' };
describe('55 cm mockup sizing', () => {
  it.each([
    ['leftChest', undefined, 7, 7], ['rightChest', undefined, 7, 7], ['leftSleeve', undefined, 6, 6], ['rightSleeve', undefined, 6, 6],
    ['frontCenter', undefined, 24, 28], ['back', 'backCenter', 26, 30], ['back', 'upperBack', 8, 4],
  ] as const)('fits whole artwork without distortion: %s %s', (key, catalogPosition, width, height) => {
    const selected = { ...placement, key, catalogPosition };
    expect(defaultPrintSize(selected)).toEqual({ width, height });
    for (const aspect of [.15, .76, 1, 3, 8]) {
      const size = printSizeCm(selected, aspect);
      expect(size.width).toBeLessThanOrEqual(width);
      expect(size.height).toBeLessThanOrEqual(height + .000001);
      expect(size.width / size.height).toBeCloseTo(aspect);
      expect(Math.max(size.width / width, size.height / height)).toBeCloseTo(1);
    }
  });
  it('honors requested width or height instead of default bounds', () => {
    expect(printSizeCm({ ...placement, sizeMode: 'widthCm', widthCm: 9 }, 3)).toEqual({ width: 9, height: 3 });
    expect(printSizeCm({ ...placement, sizeMode: 'heightCm', heightCm: 4.5 }, .75)).toEqual({ width: 3.375, height: 4.5 });
    expect(() => printSizeCm({ ...placement, sizeMode: 'heightCm', heightCm: 200 }, 1)).toThrow('尺寸无效');
  });
  it('uses body width, excluding sleeves and whitespace, equally on both faces', () => {
    const garment = garmentFixture();
    garment.views.forEach(view => { view.standard = null; });
    for (const key of ['leftChest', 'back'] as const) {
      const sized = { ...placement, key, sizeMode: 'widthCm' as const, widthCm: 11, manual: { centerX: .5, centerY: .5, width: .9 } };
      const geometry = productionPlacementGeometry(garment, sized, 2);
      expect(geometry.width).toBeCloseTo(55); // 11 / 55 * 275 body pixels
      expect(geometry.height).toBeCloseTo(27.5);
      expect(geometry.centerX).toBe(key === 'back' ? 750 : 250);
    }
  });
  it('does not silently resize explicit/default dimensions to a small safe area', () => {
    const garment = garmentFixture();
    const position = garment.views[0].standard!.specification.positions.find(p => p.key === 'frontCenter')!;
    position.printableArea = { x: .45, y: .45, width: .1, height: .1 };
    expect(() => productionPlacementGeometry(garment, { ...placement, key: 'frontCenter' }, 1)).toThrow('可印范围');
  });
  it('keeps the accepted center, trims padding, and changes no saved confirmations on opening', () => {
    const state = importTaskReviews(emptyWpsProductionState(), [taskReviewFixture()[0]]);
    const unit = { ...state.units[0], garment: garmentFixture(), placement: { ...placement, sizePolicy: undefined, manual: { centerX: .64, centerY: .34, width: .15 } } };
    const before = JSON.stringify(unit);
    const validation = { width: 1111, height: 1419, contentBounds: { left: 56, top: 56, width: 999, height: 1307 } } as ArtworkValidation;
    const updated = initialTaskPlacement(unit, validation);
    expect(updated.manual?.centerX).toBe(.64);
    expect(updated.manual?.centerY).toBe(.34);
    expect(printSizeCm(updated, 999 / 1307).height).toBeCloseTo(7);
    expect(printSizeCm(updated, 999 / 1307).width).toBeCloseTo(5.3504, 3);
    expect(JSON.stringify(unit)).toBe(before);
  });
  it('keeps legacy saved geometry until the placement is explicitly edited', () => {
    const garment = garmentFixture();
    const legacy = { ...placement, sizePolicy: undefined, manual: { centerX: .5, centerY: .5, width: .2 } };
    expect(productionPlacementGeometry(garment, legacy, 2).width).toBe(100);
    expect(productionPlacementGeometry(garment, { ...legacy, sizePolicy: MOCKUP_SIZE_POLICY }, 2).width).toBe(35);
  });
});
