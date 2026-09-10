import { describe, expect, it } from 'vitest';
import { buildTaskReviewPrompt, parseTaskReviewAnalysis, taskReviewCatalogCandidates } from './task-review-analysis';
import { sourceTaskSnapshot } from './task-review-snapshot';
import { styleFixture } from './testing/production-garment-fixture';
import { matchProductionGarment } from './production-garment';
import { emptyWpsProductionState, importTaskReviews } from './wps-production';

const colors = ['藏青', '豆绿', '黑色', '红色', '黄色', '米白', '墨绿', '天蓝'];
const source = { ...sourceTaskSnapshot()[0], recordId: 'cj5Qvp0WVtjz:1:Bdx8', customerId: '007', productStyleText: '未填商品款式',
  requirementText: `货号:${colors.map(color => `5166ZC-${color}`).join('，')}\n左胸:logo\n后背:Sales ELT\nLearn.Lead.Grow\n字体:\n颜色:\n工艺:\n尺寸：` };
const styles = [styleFixture('5166ZC', colors), styleFixture('5166', ['白色'], 1), styleFixture('B01SD', ['活力黑'], 2)];
function compact() {
  const logo = { id: 'a1', garmentIds: colors.map((_, i) => `g${i + 1}`), variantLabel: '版本1', placement: 'leftChest',
    logoMaterialId: source.materials[0].id as string | null, referenceMaterialIds: [] as string[], sourceScope: 'subject', textMode: 'keep',
    exactText: '', layoutNote: '', instruction: '左胸使用图1的原 Logo，保留原色。', generationPrompt: '取图1的完整 Logo，保留原文字与颜色，独立平面图稿，纯白背景。', ambiguities: [] as string[] };
  return { records: [{ recordId: source.recordId, summary: '八种衣服颜色共用左胸 Logo 和后背文字。',
    garments: colors.map((color, i) => ({ id: `g${i + 1}`, styleCode: '5166ZC', colorText: color, sizeText: '' })),
    artworks: [logo, { ...logo, id: 'a2', placement: 'back', logoMaterialId: null, textMode: 'replace',
      exactText: 'Sales ELT\nLearn.Lead.Grow', instruction: '后背制作文字“Sales ELT\nLearn.Lead.Grow”。', generationPrompt: '' }],
  }] };
}

describe('shared artwork analysis', () => {
  it('expands two definitions into sixteen independently editable units and eight garment versions', () => {
    const raw = compact();
    const [review] = parseTaskReviewAnalysis([source], JSON.stringify(raw));
    expect(review.units).toHaveLength(16);
    expect(new Set(review.units.map(unit => unit.id)).size).toBe(16);
    expect(review.source).toEqual(source);
    for (const color of colors) {
      const units = review.units.filter(unit => unit.garmentRequest?.colorText === color);
      expect(units.map(unit => unit.placement)).toEqual(['leftChest', 'back']);
      expect(units[0].logo.materialId).toBe(source.materials[0].id);
      expect(units[1].exactText).toBe('Sales ELT\nLearn.Lead.Grow');
      expect(units[1].generationPrompt).toBe('');
      expect(units.every(unit => !unit.confirmed)).toBe(true);
      expect(units.map(unit => matchProductionGarment(source, unit, styles).item?.colorName)).toEqual([color, color]);
    }
    const state = importTaskReviews(emptyWpsProductionState(), [review]);
    expect(state.sharedArtworks).toHaveLength(2);
    expect(state.sharedArtworks!.map(group => group.unitIds.length)).toEqual([8, 8]);
    expect(new Set(review.units.map(unit => unit.sharedArtworkId)).size).toBe(2);
    expect(state.mockupVersions).toHaveLength(8);
    expect(state.mockupVersions.every(version => version.unitIds.length === 2)).toBe(true);
    review.units[0].ambiguities.push('只修改第一件');
    expect(review.units[2].ambiguities).not.toContain('只修改第一件');
    expect(JSON.stringify(raw).length).toBeLessThan(JSON.stringify(review).length * .5);
  });

  it('keeps color-specific artwork and additional versions separate from the shared definition', () => {
    const raw = compact(), row = raw.records[0];
    row.artworks[0].garmentIds = row.artworks[0].garmentIds.filter(id => id !== 'g4');
    row.artworks.push({ ...row.artworks[0], id: 'a3', garmentIds: ['g4'], instruction: '左胸使用图1，Logo 改白色。', generationPrompt: '图1的 Logo 改为白色，保持形状。' });
    row.artworks.push({ ...row.artworks[0], id: 'a4', garmentIds: ['g4'], variantLabel: '图1第二版', instruction: '左胸使用图1，Logo 改黑色。' });
    const different = { ...source, requirementText: `${source.requirementText}\n红色衣服左胸 Logo 做白色，另出一版黑色。` };
    const [review] = parseTaskReviewAnalysis([different], JSON.stringify(raw));
    const red = review.units.filter(unit => unit.garmentRequest?.colorText === '红色' && unit.placement === 'leftChest');
    expect(red).toHaveLength(2);
    expect(red.map(unit => unit.variantLabel)).toEqual(['版本1', '图1第二版']);
    expect(red[0].generationPrompt).toContain('白色');
    expect(review.units.find(unit => unit.garmentRequest?.colorText === '黑色')?.generationPrompt).toContain('原文字与颜色');
  });

  it.each(['unknown-garment', 'duplicate-reference', 'duplicate-slot', 'unreferenced-garment', 'duplicate-garment', 'unknown-material', 'unknown-record', 'mixed-format'])('rejects %s instead of silently losing or duplicating work', problem => {
    const raw = compact(), row = raw.records[0];
    if (problem === 'unknown-garment') row.artworks[0].garmentIds.push('g99');
    if (problem === 'duplicate-reference') row.artworks[0].garmentIds.push('g1');
    if (problem === 'duplicate-slot') row.artworks.push({ ...row.artworks[0], id: 'a3' });
    if (problem === 'unreferenced-garment') row.artworks.forEach(artwork => { artwork.garmentIds = artwork.garmentIds.filter(id => id !== 'g8'); });
    if (problem === 'duplicate-garment') row.garments.push({ ...row.garments[0], id: 'g9' });
    if (problem === 'unknown-material') row.artworks[0].logoMaterialId = 'missing';
    if (problem === 'unknown-record') row.recordId = 'other-record';
    if (problem === 'mixed-format') Object.assign(row, { units: [] });
    expect(() => parseTaskReviewAnalysis([source], JSON.stringify(raw))).toThrow();
  });

  it('narrows by full style code, preserves suffixes and keeps an unmatched source intact', () => {
    expect(taskReviewCatalogCandidates([source], styles).map(style => style.styleCode)).toEqual(['5166ZC']);
    expect(taskReviewCatalogCandidates([{ ...source, requirementText: '5166ZC2-黑色' }], styles)).toEqual([]);
    const multi = { ...source, requirementText: '货号:5166ZC-黑色、B01SD-活力黑\n左胸图1' };
    expect(taskReviewCatalogCandidates([multi], styles)).toHaveLength(2);
    expect(taskReviewCatalogCandidates([{ ...source, requirementText: '５１６６ＺＣ-黑色' }], styles)).toHaveLength(1);
    const prompt = buildTaskReviewPrompt([source], styles);
    expect(prompt).toContain('5166ZC |'); expect(prompt).not.toContain('B01SD |'); expect(prompt).not.toContain('5166 |');
    expect(prompt).toContain('8 个 garments、2 个 artworks'); expect(prompt).not.toContain('150–800');
    const unknown = { ...source, requirementText: '货号:UNKNOWN9-未收录颜色\n左胸图1' };
    const missing = buildTaskReviewPrompt([unknown], styles);
    expect(missing).toContain('没有匹配到原文完整货号'); expect(missing).toContain('UNKNOWN9-未收录颜色');
    expect(missing).not.toContain('5166ZC |');
  });
});
