import { productionGarmentPreviewCrop } from '@/lib/production-garment';
import { positionFromImageBox, suggestedPlacement } from '@/lib/catalog-placement-suggestions';
import { describe, expect, it } from 'vitest';
import { matchProductionGarment, productionPlacementGeometry, garmentPlacementIssue, requestedCatalogPlacement } from '@/lib/production-garment';
import { garmentFixture, styleFixture } from '@/lib/testing/production-garment-fixture';
import { taskReviewFixture } from '@/lib/testing/task-review-fixture';
import { emptyWpsProductionState, importTaskReviews, selectProductionGarment, upsertTaskReviews, type ProductionPlacement } from '@/lib/wps-production';
import { liveWpsProductionState } from '@/lib/wps-source';

const styles = [styleFixture('301SRX', ['极致黑', '安可拉红', '酒红']), styleFixture('B01SD', ['活力黑', '月牙白', '冰霜蓝'], 1), styleFixture('719SF', ['黑色'], 2), styleFixture('9600SRX', ['大红'], 3)];
function match(text: string, label: string, productStyleText = '未填商品款式') {
  return matchProductionGarment({ ...taskReviewFixture()[0].source, requirementText: text, productStyleText }, { garmentLabel: label, productCode: null }, styles);
}
describe('real garment matching', () => {
  it('resolves unique generic black and exact source-style field', () => {
    expect(match('301SRX-黑色\n正面 图一', '301SRX-黑色').item?.colorName).toBe('极致黑');
    expect(match('左胸:图一', '款式待确认', '9600SRX-大红').item?.styleCode).toBe('9600SRX');
  });
  it('keeps multiple reds provisional and stable, with no out-of-family guess', () => {
    const first = match('301SRX-红色', '301SRX');
    expect(first.selection).toBe('provisional');
    expect(match('301SRX-红色', '301SRX').item?.id).toBe(first.item?.id);
    expect(match('301SRX-黄色', '301SRX').item).toBeNull();
    expect(match('301SRX\n左胸 Logo黑色', '301SRX').item).toBeNull();
  });
  it('separates logo color, size and multiple garments without stripping code suffixes', () => {
    expect(match('货号:B01SD-活力黑-\n左胸:1+poppy手机数码（logo做绿色）', 'B01SD').item?.colorName).toBe('活力黑');
    const text = '货号:719SF-黑色 B01SD-月牙白-L\n左胸 图一';
    expect(match(text, '719SF-黑色').item?.styleCode).toBe('719SF');
    expect(match(text, 'B01SD-月牙白').item?.colorName).toBe('月牙白');
    expect(match('301SRX2-黑色', '301SRX').item).toBeNull();
    expect(match(text, '未确定').item).toBeNull();
  });
  it('handles spaces and two colors of the same style independently', () => {
    expect(match('B01SD 月牙白 L', 'B01SD 月牙白').item?.colorName).toBe('月牙白');
    const text = 'B01SD-活力黑-L B01SD-月牙白-L';
    expect(match(text, 'B01SD 活力黑').item?.colorName).toBe('活力黑');
    expect(match(text, 'B01SD 月牙白').item?.colorName).toBe('月牙白');
    expect(match(text, 'B01SD').item).toBeNull();
  });
  it.each(['、', '，', ',', '；', ';'])('matches every garment separated by %s, including the first and middle colors', separator => {
    const labels = ['B01SD-活力黑', 'B01SD-月牙白', 'B01SD-冰霜蓝'];
    const text = `货号:${labels.join(separator)}\n左胸:logo+下面文字 激宇光电\n后背:\n字体:\n颜色:\n工艺:刺绣\n尺寸：`;
    for (const label of labels) {
      expect(match(text, label)).toMatchObject({ item: { styleCode: 'B01SD', colorName: label.slice('B01SD-'.length) }, selection: 'exact' });
    }
    expect(match(text, 'B01SD').item).toBeNull();
  });
  it('keeps dunhao-separated styles, sizes and logo colors separate', () => {
    const text = '货号:B01SD-月牙白-L、719SF-黑色-XL\n左胸:Logo改冰霜蓝、文字做活力黑';
    expect(match(text, 'B01SD-月牙白').item?.colorName).toBe('月牙白');
    expect(match(text, '719SF-黑色').item?.styleCode).toBe('719SF');
    expect(match(text, '未确定').item).toBeNull();
  });
  it('does not merge same style codes from different namespaces', () => {
    const source = { ...taskReviewFixture()[0].source, productStyleText: '301SRX-黑色', requirementText: '左胸图一' };
    expect(matchProductionGarment(source, { garmentLabel: '301SRX', productCode: null }, [styles[0], { ...styles[0], id: 'other', namespace: 'other' }]).item).toBeNull();
  });
});
const placement: ProductionPlacement = { key: 'frontCenter', widthCm: 10, offsetX: 0, offsetY: 0, rotation: 0, templateVersion: 'catalog-v1', sizeMode: 'standard' };
describe('catalog placement and persistence', () => {
  it('checks task-local coordinates, rotation, exclusions and real centimeter measurements', () => {
    const garment = garmentFixture();
    const manual = { ...placement, manual: { centerX: .5, centerY: .5, width: .2 } };
    expect(productionPlacementGeometry(garment, manual, 2)).toMatchObject({ centerX: 250, centerY: 250, width: 100, height: 50 });
    garment.views[0].standard!.specification.exclusions = [{ id: 'collar', label: '领标', area: { x: .4, y: .4, width: .2, height: .2 } }];
    expect(() => productionPlacementGeometry(garment, manual)).toThrow('领标');
    garment.views[0].standard = null;
    expect(() => productionPlacementGeometry(garment, { ...manual, sizeMode: 'widthCm' })).toThrow('实测衣宽');
    expect(() => productionPlacementGeometry(garment, { ...manual, manual: { centerX: .9, centerY: .9, width: .2 }, rotation: 45 })).toThrow('超出');
    expect(() => productionPlacementGeometry(garment, { ...manual, manual: { centerX: NaN, centerY: .5, width: .2 } })).toThrow('无效');
  });
  it('projects separate face crops and garment frames and blocks uncalibrated/physical sizes', () => {
    const garment = garmentFixture();
    garment.views[0].standard!.specification.garmentFrame = { x: 0.1, y: 0.2, width: 0.6, height: 0.6 };
    expect(productionPlacementGeometry(garment, placement).centerX).toBeCloseTo(200);
    expect(productionPlacementGeometry(garment, { ...placement, key: 'back' }).centerX).toBeCloseTo(750);
    garment.views[0].standard!.specification.measuredWidthCm = null;
    expect(garmentPlacementIssue(garment, { ...placement, sizeMode: 'widthCm' })).toContain('实测衣宽');
    garment.views[0].standard = null;
    expect(() => productionPlacementGeometry(garment, placement)).toThrow('尚未校准');
  });
  it('extracts explicit front height without applying it to the back', () => {
    const source = { ...taskReviewFixture()[0].source, requirementText: '301SRX-黑色\n正面 图一\n后脖 图一\n正面高35cm 后背宽8' };
    expect(requestedCatalogPlacement(source, { placement: 'frontCenter', instruction: '正面图一' })).toMatchObject({ sizeMode: 'heightCm', heightCm: 35 });
    expect(requestedCatalogPlacement(source, { placement: 'back', instruction: '后脖 图一' })).toMatchObject({ sizeMode: 'widthCm', widthCm: 8, requestedSize: { inferredUnit: true }, catalogPosition: 'upperBack' });
  });
  it('rejects out-of-range dimensions and honors height rather than interpreting it as width', () => {
    const garment = garmentFixture();
    const geometry = productionPlacementGeometry(garment, { ...placement, sizeMode: 'heightCm', heightCm: 10 }, 2);
    expect(geometry.height).toBe(100); expect(geometry.width).toBe(200);
    expect(() => productionPlacementGeometry(garment, { ...placement, sizeMode: 'widthCm', widthCm: 50 })).toThrow('超出');
  });
  it('changes all faces of one version, persists manual colors through sync, and separates variants', () => {
    const review = taskReviewFixture()[2];
    review.units = review.units.map(unit => ({ ...unit, garment: garmentFixture() }));
    let state = importTaskReviews(emptyWpsProductionState(), [review]);
    const chosen = { ...garmentFixture(), variantId: '00000000-0000-4000-8000-000000000099', colorName: '月牙白', selection: 'manual' as const };
    state = selectProductionGarment(state, state.units[0].id, chosen);
    expect(state.units.every(unit => unit.garment?.colorName === '月牙白')).toBe(true);
    expect(state.mockupVersions).toHaveLength(1);
    expect(state.units.every(unit => !unit.gateA)).toBe(true);
    state = upsertTaskReviews(state, [review]);
    expect(state.units.every(unit => unit.garment?.selection === 'manual')).toBe(true);
    const visible = liveWpsProductionState(state, [review.source]);
    expect(visible.units.every(unit => unit.garment?.colorName === '月牙白')).toBe(true);
    review.units[1] = { ...review.units[1], garment: chosen };
    expect(importTaskReviews(emptyWpsProductionState(), [review]).mockupVersions).toHaveLength(2);
  });
});

it('projects apron upper, pocket and center using separate confirmed coordinates and rejects an absent pocket', () => {
  const garment = garmentFixture();
  const spec = suggestedPlacement('apron', 'front', { x: 0, y: 0, width: 1, height: 1 });
  garment.views[0].standard!.specification = spec;
  const placement: ProductionPlacement = { key: 'frontCenter', catalogPosition: 'apronPocket', sizeMode: 'standard', widthCm: 10, offsetX: 0, offsetY: 0, rotation: 0, templateVersion: 'catalog-v1' };
  expect(garmentPlacementIssue(garment, placement)).toContain('没有已确认标准');
  spec.positions.push(positionFromImageBox('apronPocket', { x: .35, y: .55, width: .3, height: .15 }, spec.garmentFrame));
  expect(garmentPlacementIssue(garment, placement)).toBeNull();
  const pocket = productionPlacementGeometry(garment, placement);
  const upper = productionPlacementGeometry(garment, { ...placement, catalogPosition: 'apronUpper' });
  const center = productionPlacementGeometry(garment, { ...placement, catalogPosition: 'frontCenter' });
  expect(pocket.centerY).toBeCloseTo(312.5);
  expect(upper.centerY).toBeCloseTo(147.5);
  expect(center.centerY).toBeCloseTo(320);
});


it('previews only the requested face, independent of calibration, and never substitutes a missing back', () => {
  const garment = garmentFixture();
  garment.views.forEach(view => { view.standard = null; });
  expect(productionGarmentPreviewCrop(garment, { key: 'leftChest' })).toMatchObject({ face: 'front', x: 0, y: 0, width: 500, height: 500 });
  expect(productionGarmentPreviewCrop(garment, { key: 'back' })).toMatchObject({ face: 'back', x: 500, y: 0, width: 500, height: 500 });
  garment.views = garment.views.filter(view => view.face === 'front');
  expect(productionGarmentPreviewCrop(garment, { key: 'back' })).toBeNull();
});
