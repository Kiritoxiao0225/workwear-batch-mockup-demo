import { describe, expect, it } from 'vitest';
import { assertConfirmedStandard, standardSchema, type StructureType } from '@/lib/catalog';
import { catalogReferenceType, positionFromImageBox, suggestedPlacement } from './catalog-placement-suggestions';

const frame = { x: .04, y: .02, width: .9, height: .95 };
describe('editable placement suggestions', () => {
  it('keeps every proposed print area inside the garment and outside structure-specific exclusions', () => {
    for (const structure of ['polo', 'crewneck', 'hoodie', 'jacket', 'shell', 'vest', 'cap', 'apron'] as StructureType[]) {
      for (const face of ['front', 'back'] as const) for (const long of [false, true]) {
        const spec = suggestedPlacement(structure, face, frame, long);
        standardSchema.parse(spec);
        expect(spec.garmentFrame).toEqual(frame);
        if (spec.positions.length) expect(() => assertConfirmedStandard(spec, face), `${structure}/${face}/${long}`).not.toThrow();
      }
    }
  });
  it('places wearer left on image right and differentiates short sleeves, long sleeves, and vests', () => {
    const short = suggestedPlacement('polo', 'front', frame);
    const long = suggestedPlacement('polo', 'front', frame, true);
    expect(short.positions.find(p => p.key === 'leftChest')!.anchor.x).toBeGreaterThan(.5);
    expect(short.positions.find(p => p.key === 'rightChest')!.anchor.x).toBeLessThan(.5);
    expect(short.positions.find(p => p.key === 'leftSleeve')!.printableArea).not.toEqual(long.positions.find(p => p.key === 'leftSleeve')!.printableArea);
    expect(suggestedPlacement('vest', 'front', frame).positions.some(p => p.key.includes('Sleeve'))).toBe(false);
    expect(suggestedPlacement('jacket', 'front', frame).positions.some(p => p.key === 'frontCenter')).toBe(false);
  });
  it('does not infer another supplier or unknown style from a coincidentally matching code', () => {
    expect(catalogReferenceType('normalized-garments-v1', '301SRX').structure).toBe('polo');
    expect(catalogReferenceType('other-supplier', '301SRX').structure).toBe('unknown');
    expect(catalogReferenceType('normalized-garments-v1', 'future-style').structure).toBe('unknown');
    expect(suggestedPlacement('unknown', 'front', frame).positions).toEqual([]);
  });
});

describe('apron print locations', () => {
  it('keeps upper and center distinct and never invents a pocket or pocket exclusion', () => {
    const spec = suggestedPlacement('apron', 'front', frame);
    expect(spec.positions.map(p => p.key)).toEqual(['apronUpper', 'frontCenter']);
    expect(spec.exclusions).toEqual([]);
    expect(suggestedPlacement('apron', 'back', frame).positions).toEqual([]);
  });
  it('converts a manually selected pocket from image coordinates into garment coordinates', () => {
    const boundary = { x: .2, y: .1, width: .5, height: .8 };
    const pocket = positionFromImageBox('apronPocket', { x: .3, y: .5, width: .2, height: .16 }, boundary);
    expect(pocket.printableArea.x).toBeCloseTo(.2);
    expect(pocket.printableArea.y).toBeCloseTo(.5);
    expect(pocket.anchor.x).toBeCloseTo(.4);
    expect(pocket.anchor.y).toBeCloseTo(.6);
    const spec = suggestedPlacement('apron', 'front', boundary);
    spec.positions.push(pocket);
    expect(() => assertConfirmedStandard(spec, 'front')).not.toThrow();
    expect(() => positionFromImageBox('apronPocket', { x: .1, y: .5, width: .2, height: .16 }, boundary)).toThrow('超出衣服边界');
    spec.exclusions.push({ id: 'seam', label: '口袋缝线', area: pocket.printableArea });
    expect(() => assertConfirmedStandard(spec, 'front')).toThrow('口袋缝线');
  });
});
