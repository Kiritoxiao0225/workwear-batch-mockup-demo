import { describe, expect, it } from 'vitest';
import { apronRecognitionStandard, parseApronModelResponse, projectApronRecognition, type ApronRecognition } from './catalog-apron-recognition';
import { assertConfirmedStandard } from './catalog';
function recognition(): ApronRecognition {
  return { garment: { area: { x: .2, y: .2, width: .6, height: .6 }, confidence: .9, reason: '布面可见' },
    landmarks: [ ['bibTop', .5, .2], ['bibLeft', .4, .2], ['bibRight', .6, .2], ['waistLeft', .2, .4], ['waistRight', .8, .4], ['hemCenter', .5, .8] ].map(([key, x, y]) => ({ key: key as ApronRecognition['landmarks'][number]['key'], point: { x: Number(x), y: Number(y) } })),
    positions: [ { key: 'apronUpper', area: { x: .4, y: .25, width: .2, height: .1 }, confidence: .9, reason: '上部布面' }, { key: 'apronPocket', area: { x: .3, y: .5, width: .2, height: .15 }, confidence: .8, reason: '画面左口袋' }, { key: 'frontCenter', area: { x: .4, y: .68, width: .2, height: .1 }, confidence: .9, reason: '袋下布面' } ] };
}
describe('apron vision results', () => {
  it('projects actual image areas and landmarks into the apron without making a pocket exclusion', () => {
    const result = apronRecognitionStandard(recognition());
    expect(result.specification.positions.map(p => p.key)).toEqual(['apronUpper', 'apronPocket', 'frontCenter']);
    expect(result.specification.positions[1].printableArea.x).toBeCloseTo(.2);
    expect(result.specification.exclusions).toEqual([]);
    expect(() => assertConfirmedStandard(result.specification, 'front')).not.toThrow();
  });
  it('leaves invisible and uncertain pockets unmarked, not replaced by a fixed rectangle', () => {
    const raw = recognition(); raw.positions[1].confidence = .4;
    const result = apronRecognitionStandard(raw);
    expect(result.specification.positions.some(p => p.key === 'apronPocket')).toBe(false);
    expect(result.basis).toContain('未识别清楚');
    raw.positions[1].confidence = .95; raw.positions[1].area = null;
    expect(apronRecognitionStandard(raw).specification.positions).toHaveLength(2);
    raw.garment.confidence = .3;
    expect(apronRecognitionStandard(raw)).toMatchObject({ hasFrame: false, specification: { positions: [] } });
  });
  it('rejects duplicate labels, out-of-cloth areas, invalid coordinates and missing evidence', () => {
    const raw = recognition(); raw.positions[1].area!.x = .01;
    expect(() => apronRecognitionStandard(raw)).toThrow('超出衣服边界');
    const duplicate = recognition(); duplicate.positions[1].key = 'apronUpper';
    expect(() => apronRecognitionStandard(duplicate)).toThrow('重复');
    const invalid = recognition(); invalid.positions[1].area!.height = -1;
    expect(() => apronRecognitionStandard(invalid)).toThrow();
    const missing = recognition(); missing.positions[1].reason = '';
    expect(() => apronRecognitionStandard(missing)).toThrow();
  });
});

it('reads corner coordinates as corners and projects a zoomed result back into the original photo', () => {
  const raw = recognition();
  const corners = (area: { x: number; y: number; width: number; height: number } | null) => area ? { x1: area.x, y1: area.y, x2: area.x + area.width, y2: area.y + area.height } : null;
  const parsed = parseApronModelResponse({ ...raw, garment: { ...raw.garment, area: corners(raw.garment.area) }, positions: raw.positions.map(p => ({ ...p, area: corners(p.area) })) });
  expect(parsed.positions[1].area!.width).toBeCloseTo(.2);
  const projected = projectApronRecognition(parsed, { x: .3, y: .2, width: .4, height: .7 });
  expect(projected.positions[1].area!.x).toBeCloseTo(.42);
  expect(projected.positions[1].area!.y).toBeCloseTo(.55);
  expect(projected.positions[1].area!.width).toBeCloseTo(.08);
  expect(projected.landmarks[0].point.x).toBeCloseTo(.5);
  expect(() => parseApronModelResponse(raw)).toThrow();
});
