import { describe, expect, it } from 'vitest';
import { assertConfirmedStandard, emptyStandard, standardSchema, type PlacementStandard } from './catalog';
import { estimatedLandmarks, moveSopStructure, sopEstimatedExclusions, sopPlacement, sopPrintSize, sopStandardPositions, sopStructureFromStandard, type SopStructure } from './sop-placement';

const px = 10; // 400 px projected torso = 40 cm
const polo: SopStructure = {
  structureType: 'polo', neck: { x: 500, y: 200 }, leftShoulder: { x: 280, y: 260 }, rightShoulder: { x: 720, y: 260 }, leftArmpit: { x: 300, y: 500 }, rightArmpit: { x: 700, y: 500 },
  bodyWidth: 400, center: 500, bounds: { x: 0, y: 0, width: 1000, height: 1400 }, exclusions: [], hem: 1100,
};
// A structure type the v5 length rules do not cover keeps the v4 neck-based rules.
const hoodie: SopStructure = { ...polo, structureType: 'hoodie' };

describe('SOP placement rules', () => {
  it('uses the default sizes: chest 8 cm wide and at most 6 cm tall, back 28 cm (height ≤ 22)', () => {
    expect(sopPrintSize('leftChest', .5)).toEqual({ width: 8, height: 4 });
    expect(sopPrintSize('leftChest', 1)).toEqual({ width: 6, height: 6 });
    expect(sopPrintSize('leftChest', 1.5)).toEqual({ width: 4, height: 6 });
    expect(sopPrintSize('backCenter', .3).width).toBe(28);
    expect(sopPrintSize('backCenter', 1).height).toBe(22);
    expect(sopPrintSize('backCenter', .3, 'polo', 'sop-v4').width).toBe(26);
  });
  it('widens a single flat back line to 30 cm, lets portrait artwork reach 28 cm tall and keeps vests at 21 cm', () => {
    expect(sopPrintSize('backCenter', .25).width).toBeCloseTo(29);
    expect(sopPrintSize('backCenter', .1).width).toBeCloseTo(30);
    expect(sopPrintSize('backCenter', 1.2).height).toBeCloseTo(25);
    expect(sopPrintSize('backCenter', 1.4)).toMatchObject({ height: 28, width: 20 });
    expect(sopPrintSize('backCenter', .3, 'vest').width).toBe(21);
  });
  it('widens flat chest logos evenly from 8 cm at 3:1 to 10 cm at 5:1', () => {
    expect(sopPrintSize('leftChest', 1 / 3).width).toBeCloseTo(8);
    expect(sopPrintSize('rightChest', .25).width).toBeCloseTo(9);
    expect(sopPrintSize('leftChest', 1 / 7).width).toBeCloseTo(10);
  });
  it('centers chest logos of any height on the 3rd (lowest) button', () => {
    const buttons = { ...polo, button2: { x: 500, y: 290 }, button3: { x: 500, y: 360 } };
    expect(sopPlacement(buttons, 'leftChest', { width: 8, height: 2.4 }, px)).toMatchObject({ y: 360, rule: '居中于第三粒扣（门襟最下一粒）' });
    expect(sopPlacement(buttons, 'leftChest', { width: 7, height: 7 }, px).y).toBe(360);
    // Wearer's left chest is the image right; right chest mirrors it.
    expect(sopPlacement(buttons, 'leftChest', { width: 8, height: 2.4 }, px).x).toBeCloseTo(500 + .27 * 400);
    expect(sopPlacement(buttons, 'rightChest', { width: 8, height: 2.4 }, px).x).toBeCloseTo(500 - .27 * 400);
  });
  it('puts chest logos without marked buttons a share of the shoulder-line-to-hem distance down: polo 17%, vest 20%, jacket 22%', () => {
    // Shoulder line 260, hem 1100.
    expect(sopPlacement(polo, 'leftChest', { width: 8, height: 2 }, px)).toMatchObject({ rule: '肩线至下摆17%处（约为第三粒扣位置）' });
    expect(sopPlacement(polo, 'leftChest', { width: 8, height: 2 }, px).y).toBeCloseTo(260 + .17 * 840);
    expect(sopPlacement({ ...polo, structureType: 'vest' }, 'leftChest', { width: 8, height: 2 }, px).y).toBeCloseTo(260 + .2 * 840);
    expect(sopPlacement({ ...polo, structureType: 'jacket' }, 'leftChest', { width: 8, height: 2 }, px).y).toBeCloseTo(260 + .22 * 840);
    // Vest chest logos sit closer to the zipper.
    expect(sopPlacement({ ...polo, structureType: 'vest' }, 'leftChest', { width: 8, height: 2 }, px).x).toBeCloseTo(500 + .21 * 400);
  });
  it('measures T-shirts from the back neck, since their shoulder points vary with drop shoulders, and keeps the v4 chest', () => {
    const tee = { ...polo, structureType: 'crewneck' as const };
    expect(sopPlacement(tee, 'leftChest', { width: 8, height: 2 }, px).y).toBeCloseTo(200 + 95);
    // Back neck 200, hem 1100.
    expect(sopPlacement(tee, 'backCenter', { width: 28, height: 8 }, px)).toMatchObject({ rule: '后领至下摆28%处' });
    expect(sopPlacement(tee, 'backCenter', { width: 28, height: 8 }, px).y).toBeCloseTo(200 + .28 * 900);
  });
  it('keeps the v4 neck-based rules for structures outside the samples', () => {
    expect(sopPlacement(hoodie, 'leftChest', { width: 8, height: 2 }, px).y).toBeCloseTo(200 + 95);
    expect(sopPlacement(hoodie, 'leftChest', { width: 6, height: 8 }, px).y).toBeCloseTo(200 + 128);
    expect(sopPlacement(hoodie, 'backCenter', { width: 26, height: 8 }, px)).toMatchObject({ x: 500, y: 380 });
    expect(sopPlacement(hoodie, 'backCenter', { width: 16, height: 22 }, px)).toMatchObject({ y: 200 + 80 + 110, rule: '图稿较高，上沿保持在后领下约8厘米' });
  });
  it('centers the back logo a share of the shoulder-line-to-hem distance down: polo 21%, jacket 25%', () => {
    expect(sopPlacement(polo, 'backCenter', { width: 28, height: 8 }, px)).toMatchObject({ x: 500, rule: '肩线至下摆21%处' });
    expect(sopPlacement(polo, 'backCenter', { width: 28, height: 8 }, px).y).toBeCloseTo(260 + .21 * 840);
    expect(sopPlacement({ ...polo, structureType: 'jacket' }, 'backCenter', { width: 28, height: 8 }, px).y).toBeCloseTo(260 + .25 * 840);
  });
  it('moves a tall back print down so its top edge stays below the shoulder-line limit and 8 cm below the neck', () => {
    // 30 cm tall: centered at 436 its top would be at 286, above 260 + 4.5% of 840 = 297.8.
    const p = sopPlacement(polo, 'backCenter', { width: 20, height: 30 }, px);
    expect(p.y).toBeCloseTo(297.8 + 150);
    expect(p.rule).toBe('图稿较高，上沿不高于肩线至下摆4.5%处、后领下8厘米');
  });
  it('moves every structure point into the composite, recognized buttons included', () => {
    const moved = moveSopStructure({ ...polo, button2: { x: 500, y: 290 }, button3: { x: 500, y: 360 } }, 30, 200, { x: 30, y: 200, width: 1000, height: 1400 });
    expect([moved.button3?.y, moved.hem, moved.neck.y, moved.center]).toEqual([560, 1300, 400, 530]);
    expect(sopPlacement(moved, 'leftChest', { width: 8, height: 2 }, px).y).toBe(560);
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
  it('keeps a catalog fine-tuning offset in cm, for the catalog box and the composite alike', () => {
    const base = sopStandardPositions(spec, 'front', pixel, 400, ['leftChest', 'frontCenter'])!;
    const tuned = standardSchema.parse({ ...spec, positions: base.map(p => p.key === 'frontCenter' ? { ...p, offsetCm: { x: -1, y: 2.5 } } : p) });
    const again = sopStandardPositions(tuned, 'front', pixel, 400, ['leftChest', 'frontCenter'])!;
    const before = base.find(p => p.key === 'frontCenter')!, after = again.find(p => p.key === 'frontCenter')!;
    expect(after.offsetCm).toEqual({ x: -1, y: 2.5 });
    expect(after.offsetPolicy).toBe('sop-v5');
    expect((after.anchor.x - before.anchor.x) * 1000).toBeCloseTo(-10);
    expect((after.anchor.y - before.anchor.y) * 1400).toBeCloseTo(25);
    expect(again.find(p => p.key === 'leftChest')).toEqual(base.find(p => p.key === 'leftChest'));
    // The composite reads the same offset; a bigger customer logo keeps the SOP top-edge rule shifted by it.
    const s = sopStructureFromStandard(tuned, pixel, 400)!, plain = sopStructureFromStandard(spec, pixel, 400)!;
    const placed = sopPlacement(s, 'frontCenter', { width: 30, height: 20 }, px), sop = sopPlacement(plain, 'frontCenter', { width: 30, height: 20 }, px);
    expect([placed.x - sop.x, placed.y - sop.y]).toEqual([-10, 25]);
    expect(placed.rule).toMatch(/按素材库微调（画面左移1厘米、下移2.5厘米）/);
  });
  it('converts an offset set under sop-v4 so the print stays where the person put it', () => {
    const base = sopStandardPositions(spec, 'front', pixel, 400, ['leftChest'])!;
    const legacy = (y: number) => standardSchema.parse({ ...spec, positions: base.map(p => ({ ...p, offsetCm: { x: 0, y } })) });
    // v4 put the reference chest logo 9.5 cm below the neck point; the person moved it 3 cm further down.
    const neck = spec.landmarks.find(l => l.key === 'neckCenter')!.point.y * 1400, wanted = neck + 95 + 30;
    const s = sopStructureFromStandard(legacy(3), pixel, 400)!;
    expect(sopPlacement(s, 'leftChest', sopPrintSize('leftChest', .32), px).y).toBeCloseTo(wanted, -0.5);
    const shown = sopStandardPositions(legacy(3), 'front', pixel, 400, ['leftChest'])![0];
    expect(shown.offsetPolicy).toBe('sop-v5');
    expect(shown.anchor.y * 1400).toBeCloseTo(wanted, -0.5);
    // An offset that only moved the print to where v5 now puts it is dropped: the print follows the rule again.
    const v5 = sopPlacement(sopStructureFromStandard(spec, pixel, 400)!, 'leftChest', sopPrintSize('leftChest', .32), px).y;
    expect(sopStructureFromStandard(legacy((v5 - neck - 95) / px), pixel, 400)!.offsets).toEqual({});
  });
  it('never pushes a fine-tuned center out of an avoidance zone, and reports the overlap', () => {
    const jacket = { ...polo, structureType: 'jacket' as const, offsets: { leftChest: { x: -10, y: 0 } } };
    jacket.exclusions = sopEstimatedExclusions('jacket', 'front', jacket, px).map(e => e.box);
    const p = sopPlacement(jacket, 'leftChest', { width: 8, height: 2 }, px);
    expect(p.x).toBeCloseTo(500 + .27 * 400 - 100);
    expect(p.conflict).toMatch(/避让区域/);
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
