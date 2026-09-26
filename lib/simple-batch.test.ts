import { describe, it, expect } from 'vitest';
import { createTask } from '@/lib/mockup';
import { assertDemoState } from '@/lib/state-validation';
import { garmentFixture, catalogFixture } from '@/lib/testing/production-garment-fixture';
import { bindingFromCatalog } from '@/lib/production-garment';
import { simpleTaskProduct, simplePositionAnchor, simplePositionIssue, simplePlacementGeometry, simpleOffsetScale, simpleCanvasImageUrl, simpleSlots, simpleBackPositions } from '@/lib/simple-batch';
import { positionFromImageBox, suggestedPlacement } from '@/lib/catalog-placement-suggestions';
import type { LogoPlacement } from '@/lib/types';

const logo: LogoPlacement = { logoUrl: '/uploads/logos/test.png', logoName: 'test.png', widthCm: 7, offsetX: 0, offsetY: 0, rotation: 0 };
function task() { return { ...createTask('B01SD'), garment: garmentFixture() }; }
describe('simple batch catalog connection', () => {
  it('offers a cap only its drawn positions and sizes logos relative to the sample logo', () => {
    const current = task();
    const [front, back] = current.garment.views, frame = { x: 0, y: 0, width: 1, height: 1 };
    front.standard!.specification = suggestedPlacement('cap', 'front', frame);
    front.standard!.specification.positions.push(positionFromImageBox('capLeftSide', { x: .8, y: .3, width: .15, height: .2 }, frame));
    back.standard!.specification = suggestedPlacement('cap', 'back', frame);
    expect(simpleSlots(current).map(slot => slot.label)).toEqual(['帽子正面', '帽子后面', '帽子左侧', '帽子右侧']);
    expect(simpleBackPositions(current)).toEqual([]);
    expect(simplePositionIssue(current, 'rightSleeve')).toContain('没有确认过「帽子右侧」');
    const capFront = front.standard!.specification.positions.find(p => p.key === 'capFront')!;
    // 28 is the front slot's default width, i.e. 100% of the sample logo; 14 is half of it.
    const full = simplePlacementGeometry(current, 'frontCenter', { ...logo, widthCm: 28 }, 2);
    expect(full.width).toBeCloseTo(Math.min(capFront.defaultSize.width * 500, capFront.defaultSize.height * 500 * 2));
    expect(simplePlacementGeometry(current, 'frontCenter', { ...logo, widthCm: 14 }, 2).width).toBeCloseTo(full.width / 2);
  });
  it('uses the authenticated byte endpoint for canvas, not the OSS display redirect', () => {
    const url = garmentFixture().imageUrl;
    expect(simpleCanvasImageUrl(url)).toBe(url.replace('/catalog/files/', '/production-files/'));
    expect(simpleCanvasImageUrl('/products/originals/1101.png')).toBe('/products/originals/1101.png');
    expect(simpleCanvasImageUrl('data:image/png;base64,test')).toBe('data:image/png;base64,test');
  });
  it('projects each garment crop and frame; drag delta uses the same coordinate system', () => {
    const current = task();
    const front = current.garment.views[0];
    front.crop = { x: .07, y: .1, width: .4, height: .8 };
    front.standard!.specification.garmentFrame = { x: .1, y: .1, width: .8, height: .7 };
    front.standard!.specification.positions.find(p => p.key === 'leftChest')!.anchor = { x: .65, y: .35 };
    const anchor = simplePositionAnchor(current, 'leftChest')!;
    expect(anchor.x).toBeCloseTo(.318);
    expect(anchor.y).toBeCloseTo(.376);
    const geometry = simplePlacementGeometry(current, 'leftChest', logo, 2);
    expect(geometry.centerX).toBeCloseTo(318);
    expect(geometry.centerY).toBeCloseTo(188);
    expect(geometry.width).toBeCloseTo(28);
    expect(geometry.height).toBeCloseTo(14);
    const scale = simpleOffsetScale(current, 'leftChest');
    const moved = simplePlacementGeometry(current, 'leftChest', { ...logo, offsetX: 1 / scale.x }, 2);
    expect(moved.centerX - geometry.centerX).toBeCloseTo(10);
  });
  it('maps both back positions and permits defaults without confirmed standards', () => {
    const current = task();
    const spec = current.garment.views[1].standard!.specification;
    spec.positions.find(p => p.key === 'upperBack')!.anchor.y = .25;
    expect(simplePlacementGeometry(current, 'back', { ...logo, catalogPosition: 'upperBack' }, 2).centerY).toBe(125);
    expect(simplePlacementGeometry(current, 'back', { ...logo, catalogPosition: 'backCenter' }, 2).centerY).toBe(250);
    current.garment.views[0].standard = null;
    expect(simplePositionIssue(current, 'leftChest')).toBeNull();
    expect(simplePlacementGeometry(current, 'leftChest', logo, 2).width).toBeGreaterThan(0);
    expect(current.garment.views[0].standard).toBeNull();
  });
  it('never adopts a draft and keeps an older confirmed snapshot independent', () => {
    const detail = catalogFixture();
    detail.views[0].confirmedId = null;
    detail.views[0].history[0].status = 'draft';
    const binding = bindingFromCatalog(detail, { selection: 'manual', colorText: '', evidence: 'test' });
    expect(binding.views[0].standard).toBeNull();
    const current = task(); const pinned = structuredClone(current);
    current.garment.views[0].standard!.specification.positions[0].anchor.x = .4;
    expect(pinned.garment.views[0].standard!.specification.positions[0].anchor.x).toBe(.5);
  });
  it('allows tall artwork and calibration-range overlap in simple mode without hiding it', () => {
    const current = task();
    expect(simplePlacementGeometry(current, 'leftChest', { ...logo, offsetX: 45 }, .2).height).toBeGreaterThan(100);
    current.garment.views[0].standard!.specification.exclusions = [{ id: 'pocket', label: '口袋', area: { x: .45, y: .45, width: .1, height: .1 } }];
    expect(() => simplePlacementGeometry(current, 'leftChest', logo, 2)).not.toThrow();
  });
  it('uses catalog default preview coordinates without stamping them confirmed', () => {
    const current = task();
    const defaultSpec = structuredClone(current.garment.views[0].standard!.specification);
    defaultSpec.positions.find(p => p.key === 'leftChest')!.anchor = { x: .7, y: .3 };
    const defaultTask = { ...current, placementDefaults: { assetVersionId: current.garment.assetVersionId, faces: [{ viewId: current.garment.views[0].id, frame: defaultSpec.garmentFrame, specification: defaultSpec, basis: '默认位置' }] } };
    expect(simplePositionAnchor(defaultTask, 'leftChest')?.x).toBe(.25);
    current.garment.views[0].standard = null;
    expect(simplePositionAnchor(defaultTask, 'leftChest')?.x).toBe(.35);
    expect(simplePlacementGeometry(defaultTask, 'leftChest', logo, 2).centerY).toBe(150);
    expect(current.garment.views[0].standard).toBeNull();
    current.garment.views = current.garment.views.filter(view => view.face !== 'back');
    expect(simplePositionIssue(current, 'back')).toContain('缺少背面底图');
  });
  it('roundtrips catalog tasks alongside untouched legacy tasks; rejects mismatched identity', () => {
    const current = task(); current.placements.leftChest = logo;
    const state = { version: 1, updatedAt: current.updatedAt, tasks: [createTask('1101'), current] };
    expect(() => assertDemoState(JSON.parse(JSON.stringify(state)))).not.toThrow();
    expect(simpleTaskProduct(current)?.originalUrl).toBe(current.garment.imageUrl);
    expect(simpleTaskProduct(state.tasks[0])?.code).toBe('1101');
    current.productCode = 'WRONG';
    expect(() => assertDemoState(state)).toThrow('不一致');
  });
});
