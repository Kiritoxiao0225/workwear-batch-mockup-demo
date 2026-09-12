import { describe, expect, it } from 'vitest';
import { bindPrintSizeRequest, parsePrintSizeRequest } from './print-size-request';
import { printSizeCm } from './production-sizing';
import type { ProductionPlacement } from './wps-production';

const base: ProductionPlacement = { key: 'frontCenter', widthCm: 30.097144904508518, heightCm: 35, sizeMode: 'widthCm', offsetX: 0, offsetY: 0, rotation: 0, templateVersion: 'catalog-v1', sizePolicy: 'body-55-v1' };
const requirement = '301SRX-黑色\n正面 图一\n后脖 图一前三排 按照图二做\n正面高35cm 后背宽8';
describe('customer dimensions apply only when placing the transparent artwork', () => {
  it('keeps the requested axis after cropping and a stale width-mode save', () => {
    const placement = bindPrintSizeRequest(requirement, base);
    expect(placement).toMatchObject({ sizeMode: 'heightCm', heightCm: 35, requestedSize: { axis: 'heightCm', valueCm: 35, inferredUnit: false } });
    expect(printSizeCm(placement, 522 / 968)).toEqual({ width: 35 * 522 / 968, height: 35 });
    expect(printSizeCm({ ...placement, sizeMode: 'widthCm', widthCm: 40 }, 522 / 968).height).toBe(35);
    expect(printSizeCm(placement, 1).height).toBe(35);
  });
  it('uses 8 cm as the back width instead of fitting an 8 by 4 default box', () => {
    const placement = bindPrintSizeRequest(requirement, { ...base, key: 'back', catalogPosition: 'upperBack' });
    expect(placement.requestedSize).toMatchObject({ axis: 'widthCm', valueCm: 8, inferredUnit: true, evidence: '后背宽8' });
    expect(placement.heightCm).toBeUndefined();
    expect(printSizeCm(placement, 1070 / 588)).toEqual({ width: 8, height: 8 * 588 / 1070 });
  });
  it('preserves explicit manual overrides and restores the source size on request', () => {
    const custom = bindPrintSizeRequest(requirement, { ...base, sizeOverride: true });
    expect(custom.requestedSize?.valueCm).toBe(35);
    expect(printSizeCm(custom, 522 / 968).height).toBeCloseTo(55.81233);
    expect(printSizeCm(bindPrintSizeRequest(requirement, { ...custom, sizeOverride: false }), 522 / 968).height).toBe(35);
  });
  it.each([
    ['正面：图一，图案高度 35 CM', 'frontCenter', 'heightCm', 35],
    ['左胸图案宽度80毫米', 'leftChest', 'widthCm', 8],
    ['后领宽8公分', 'back', 'widthCm', 8],
  ] as const)('reads source syntax: %s', (text, key, axis, valueCm) => {
    expect(parsePrintSizeRequest(text, key).request).toMatchObject({ axis, valueCm, inferredUnit: false });
  });
  it.each(['后背宽8', '正面高35cm\n后背宽8', '正面高35cm 后背宽8 左胸宽80mm'])('does not invent units from another line or mixed units: %s', text => {
    expect(parsePrintSizeRequest(text, 'back').issue).toContain('未注明单位');
  });
  it.each([
    ['货号：002HM 左胸:图一 宽9（位置：领口往下约18cm、门襟往左约9cm）标注在效果图上', 9],
    ['左胸宽9，距领口18厘米、距门襟9公分', 9],
    ['左胸宽90，领口下180毫米、门襟左90mm', 9],
    ['左胸宽9，向下约18 CM、左移9cm', 9],
    ['左胸宽9cm，往下180mm', 9],
  ])('uses a consistent position-distance unit without borrowing its value: %s', (text, valueCm) => {
    expect(parsePrintSizeRequest(text, 'leftChest').request).toMatchObject({ axis: 'widthCm', valueCm,
      inferredUnit: !text.includes('宽9cm') });
  });
  it.each([
    '左胸宽9，往下18cm、往左90mm',
    '左胸宽9\n往下18cm', '左胸宽9\r往下18cm',
    '左胸宽9；往下18cm', '往下18cm。左胸宽9',
    '左胸宽9，文字“18cm”', '左胸宽9，数量18',
  ])('does not infer units from conflicting or unrelated context: %s', text => {
    expect(parsePrintSizeRequest(text, 'leftChest').issue).toContain('未注明单位');
  });
  it.each(['左胸宽9英寸，往下18cm', '左胸宽9in，往下18cm', '左胸宽9寸，往下18cm', '左胸宽9米，往下18cm'])(
    'does not replace an explicit unsupported unit with a nearby cm: %s', text => {
      expect(parsePrintSizeRequest(text, 'leftChest').issue).toContain('单位暂不支持');
    });
  it('does not silently choose between conflicting garments or stretch incompatible dimensions', () => {
    expect(parsePrintSizeRequest('A款正面高35cm B款正面高20cm', 'frontCenter').issue).toContain('多条尺寸');
    expect(parsePrintSizeRequest('正面宽20cm 高35cm', 'frontCenter').issue).toContain('多条尺寸');
    expect(parsePrintSizeRequest('衣长70cm 胸围110cm 正面用图一', 'frontCenter')).toEqual({ request: undefined });
    expect(parsePrintSizeRequest('正面高35cm', 'back')).toEqual({ request: undefined });
  });
});
