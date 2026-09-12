import { describe, expect, it } from 'vitest';
import { normalizeGarmentChecks } from './garment-readiness-view';

describe('preflight response rendering contract', () => {
  it('accepts blocker-only rows returned by missing units, missing orders and caught errors', () => {
    expect(normalizeGarmentChecks([{ unitId: 'missing', blockers: ['该位置已不存在'] }, { unitId: 'deleted', blockers: ['原始订单已不存在'] }, { unitId: 'error', blockers: ['failed'] }])).toEqual([]);
  });
  it('normalizes standalone, empty and shared checks without inventing missing geometry', () => {
    expect(normalizeGarmentChecks([{ unitId: 'one', garmentIssue: 'width missing', garmentChecks: [] }, { unitId: 'shared', garmentChecks: [{ unitId: 'two', label: '藏青', garmentIssue: 'width missing', calibrationUrl: '/products?variantId=two' }, { unitId: 'ok', garmentIssue: null }] }])).toEqual([
      { unitId: 'one', label: '', garmentIssue: 'width missing', calibrationUrl: '/products' },
      { unitId: 'two', label: '藏青', garmentIssue: 'width missing', calibrationUrl: '/products?variantId=two' },
    ]);
  });
  it('does not crash on absent or malformed optional collections', () => {
    expect(normalizeGarmentChecks(undefined)).toEqual([]);
    expect(normalizeGarmentChecks([null, 4, { garmentChecks: null }, { garmentChecks: [null, 4, {}] }])).toEqual([]);
  });
});
