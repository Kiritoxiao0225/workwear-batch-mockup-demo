import { describe, expect, it } from 'vitest';
import { assertConfirmedStandard, emptyStandard, type PlacementStandard } from './catalog';
import { estimatedLandmarks, sopEstimatedExclusions, sopPlacement, sopPrintSize, sopStandardPositions, sopStructureFromStandard, type SopStructure } from './sop-placement';

const px = 10; // 400 px projected torso = 40 cm
const polo: SopStructure = {
  structureType: 'polo', neck: { x: 500, y: 200 }, leftShoulder: { x: 280, y: 260 }, rightShoulder: { x: 720, y: 260 }, leftArmpit: { x: 300, y: 500 }, rightArmpit: { x: 700, y: 500 },
  bodyWidth: 400, center: 500, bounds: { x: 0, y: 0, width: 1000, height: 1400 }, exclusions: [],
};

describe('SOP placement rules', () => {
  it('uses the SOP default widths: chest 8 cm (height ≤ 9), back 26 cm (height ≤ 22)', () => {
    expect(sopPrintSize('leftChest', .3)).toEqual({ width: 8, height: 2.4 });
    expect(sopPrintSize('leftChest', 1.5)).toEqual({ width: 6, height: 9 });
    expect(sopPrintSize('backCenter', .3).width).toBe(26);
    expect(sopPrintSize('backCenter', 1).height).toBe(22);
  });
  it('centers chest logos between the 2nd and 3rd button and moves logos taller than 6 cm to the 3rd button', () => {
    const buttons = { ...polo, button2: { x: 500, y: 290 }, button3: { x: 500, y: 360 } };
    expect(sopPlacement(buttons, 'leftChest', { width: 8, height: 2.4 }, px).y).toBe(325);
    expect(sopPlacement(buttons, 'leftChest', { width: 7, height: 7 }, px).y).toBe(360);
    // Wearer's left chest is the image right; right chest mirrors it.
    expect(sopPlacement(buttons, 'leftChest', { width: 8, height: 2.4 }, px).x).toBeCloseTo(500 + .27 * 400);
    expect(sopPlacement(buttons, 'rightChest', { width: 8, height: 2.4 }, px).x).toBeCloseTo(500 - .27 * 400);
  });
  it('falls back to 9.5 cm below the neck point (plus half a button spacing for tall logos) without buttons', () => {
    expect(sopPlacement(polo, 'leftChest', { width: 8, height: 2 }, px).y).toBeCloseTo(200 + 95);
    expect(sopPlacement(polo, 'leftChest', { width: 6, height: 8 }, px).y).toBeCloseTo(200 + 128);
  });
  it('centers the back logo between the shoulder line and the armhole bottom', () => {
    const p = sopPlacement(polo, 'backCenter', { width: 26, height: 8 }, px);
    expect(p).toMatchObject({ x: 500, y: 380 });
  });
  it('keeps sleeve logos 0.75 cm outside the sleeve seam on the wearer side', () => {
    const left = sopPlacement(polo, 'leftSleeve', { width: 6, height: 3 }, px);
    expect(left.y).toBe(380);
    expect(left.x - 30).toBeCloseTo(710 + 7.5);
    expect(sopPlacement(polo, 'rightSleeve', { width: 6, height: 3 }, px).x + 30).toBeCloseTo(290 - 7.5);
  });
  it('moves the least distance out of a zipper and reports overlaps it cannot resolve', () => {
    const jacket = { ...polo, structureType: 'jacket' as const };
    jacket.exclusions = sopEstimatedExclusions('jacket', 'front', jacket, px).map(e => e.box);
    const p = sopPlacement(jacket, 'leftChest', { width: 17, height: 5 }, px);
    expect(p.conflict).toBeNull();
    expect(p.x - 85).toBeGreaterThanOrEqual(525);
    expect(p.x - 85).toBeLessThan(528);
    const blocked = { ...polo, exclusions: [{ x: 0, y: 0, width: 1000, height: 1400 }] };
    expect(sopPlacement(blocked, 'leftChest', { width: 8, height: 2 }, px).conflict).toMatch(/避让区域/);
  });
});

describe('catalog standards derived from structure points', () => {
  const pixel = { width: 1000, height: 1400 };
  const spec: PlacementStandard = { ...emptyStandard(), structureType: 'polo',
    landmarks: estimatedLandmarks('polo', 'front', { top: .05, bottom: .95, armpit: .4, center: .5, bodyWidth: .4 }) };
  it('produces confirmable positions that match the composite rule for a reference logo', () => {
    spec.positions = sopStandardPositions(spec, 'front', pixel, 400, ['leftChest', 'rightChest', 'frontCenter', 'leftSleeve', 'rightSleeve'])!;
    expect(spec.positions.map(p => p.key)).toEqual(['leftChest', 'rightChest', 'frontCenter', 'leftSleeve', 'rightSleeve']);
    expect(() => assertConfirmedStandard(spec, 'front')).not.toThrow();
    const s = sopStructureFromStandard(spec, pixel, 400)!;
    const chest = spec.positions.find(p => p.key === 'leftChest')!;
    expect(chest.anchor.y * 1400).toBeCloseTo(sopPlacement(s, 'leftChest', sopPrintSize('leftChest', .32), px).y);
    expect(chest.anchor.x).toBeGreaterThan(.5);
  });
  it('needs the structure points before it can derive a position', () => {
    expect(sopStandardPositions({ ...emptyStandard(), structureType: 'polo' }, 'front', pixel, 400, ['leftChest'])).toBeNull();
  });
});

describe('positions offered per structure', async () => {
  const { sopPositionKeys } = await import('./catalog-placement-suggestions');
  it('gives zipped outerwear no full front print, and keeps sleeves off vests', () => {
    expect(sopPositionKeys('polo', 'front')).toContain('frontCenter');
    expect(sopPositionKeys('jacket', 'front')).toEqual(['leftChest', 'rightChest', 'leftSleeve', 'rightSleeve']);
    expect(sopPositionKeys('vest', 'front')).toEqual(['leftChest', 'rightChest']);
    expect(sopPositionKeys('crewneck', 'back')).toEqual(['upperBack', 'backCenter']);
  });
});
