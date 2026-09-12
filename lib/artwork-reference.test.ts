import { describe, expect, it } from 'vitest';
import { artworkReferenceEvidence, artworkReferenceIssues, normalizeArtworkImageNumbers, sourceArtworkReferenceRequirement } from '@/lib/artwork-reference';
import { artworkRequirementFacts } from '@/lib/artwork-routing-request';
import { decideArtworkMethod } from '@/lib/artwork-routing-standard';

const flatAssessment = { version: 'artwork-source-v1' as const, kind: 'flat-artwork' as const, targetDescription: '独立平面 Logo', needsReconstruction: false, evidence: ['测试素材为独立平面图案'], uncertainDetails: [] };
const input = { sourceAssessment: flatAssessment, instruction: '保留图2，下方加文字', exactText: '志愿者', layoutNote: '', primaryImageLabel: '图2', sourceScope: 'subject' as const, processingRoute: 'auto' as const, referenceImages: [] as Array<{ label: string }> };
const source = '货号:719SF-黑色 B01SD-月牙白-L\n左胸：冲锋衣：图一    POLO衫：研+图5+2026【参考图四】\n后背：冲锋衣：宜宾学院研究生会志愿者【做扇形】 下面加图二 + 奉献、友爱、互助、进步 （后背排版和字体颜色参考图三）\n左袖 图一';

describe('reference identity and routing evidence', () => {
  it('keeps layout, font and color independently and rejects a derived instruction that lost two of them', () => {
    expect(artworkReferenceEvidence('排版，字体和颜色参考图3')).toMatchObject([{ attributes: ['layout', 'font', 'color'] }]);
    expect(artworkReferenceEvidence('只参考图3颜色')).toMatchObject([{ attributes: ['color'] }]);
    // 候选修复统一了漏图阻塞文案（REQUIRED_IMAGE_MISSING），语义不变：派生说明丢掉的原图引用必须阻塞。
    expect(artworkReferenceIssues({ ...input, sourceRequirementText: source, printPlacement: { key: 'back' }, instruction: '保留图2，排版参考图3', referenceImages: [{ label: '图3' }] }).join(' ')).toContain('原文要求使用图1（成品内容），但制作输入未绑定该图');
  });
  it.each(['图三', '图3', '图 3', '图３', '图片三'])('resolves %s to the same reference and whole-layout route', label => {
    const request = { ...input, instruction: `下方加图二，后背排版和字体颜色参考${label}`, referenceImages: [{ label: '图3' }] };
    expect(artworkReferenceEvidence(request.instruction)).toMatchObject([{ number: 3, role: 'layout' }]);
    expect(decideArtworkMethod(artworkRequirementFacts(request))).toMatchObject({ method: 'generate', state: 'ready' });
  });
  it('matches complete ordinals, including two-digit numbers', () => {
    expect(normalizeArtworkImageNumbers('图一 图十 图十三 图二十 图２１')).toBe('图1 图10 图13 图20 图21');
    expect(artworkReferenceIssues({ ...input, instruction: '排版参考图十三', referenceImages: [{ label: '图1' }] }).join(' ')).toContain('图13');
  });
  it('does not infer a reference role from an attachment or an unspecified reference', () => {
    expect(decideArtworkMethod(artworkRequirementFacts({ ...input, referenceImages: [{ label: '图3' }] })).method).toBe('compose');
    const request = { ...input, instruction: '研+图2+2026【参考图三】', referenceImages: [{ label: '图3' }] };
    expect(decideArtworkMethod(artworkRequirementFacts(request))).toMatchObject({ method: null, state: 'review' });
    expect(artworkReferenceIssues(request).join(' ')).toContain('用途尚未明确');
  });
  it('keeps an explicit font-only reference in C and complete layout in D', () => {
    const request = { ...input, instruction: '保留图2，下方加字，只参考图3字体', referenceImages: [{ label: '图3' }] };
    expect(decideArtworkMethod(artworkRequirementFacts(request)).method).toBe('compose');
    expect(decideArtworkMethod(artworkRequirementFacts({ ...request, layoutNote: '按图3的整体排版' })).method).toBe('generate');
  });
  it('does not use negated references or mistake a primary image for the following reference', () => {
    expect(artworkReferenceEvidence('图2保留，不要参考图3排版')).toEqual([]);
    expect(artworkReferenceEvidence('图2主体参考图3排版')).toMatchObject([{ number: 3 }]);
    expect(decideArtworkMethod(artworkRequirementFacts({ ...input, instruction: '图2保留，不参考图3排版', referenceImages: [{ label: '图3' }] })).method).toBe('compose');
  });
  it('scopes source references by both position and garment branch', () => {
    expect(artworkReferenceEvidence(sourceArtworkReferenceRequirement(source, 'leftChest', 1))).toEqual([]);
    expect(artworkReferenceEvidence(sourceArtworkReferenceRequirement(source, 'leftSleeve', 1))).toEqual([]);
    expect(artworkReferenceEvidence(sourceArtworkReferenceRequirement(source, 'leftChest', 5))).toMatchObject([{ number: 4, role: 'unknown' }]);
    expect(artworkReferenceEvidence(sourceArtworkReferenceRequirement(source, 'back', 2))).toMatchObject([{ number: 3, role: 'layout' }]);
  });
  it('blocks an omitted source reference even when the derived instruction also lost it', () => {
    const issues = artworkReferenceIssues({ ...input, sourceRequirementText: source, printPlacement: { key: 'back' } });
    // 候选修复统一了漏图阻塞文案（REQUIRED_IMAGE_MISSING），语义不变：原文引用的图号未绑定必须阻塞。
    expect(issues.join(' ')).toContain('原文要求使用图3（字体参考），但制作输入未绑定该图');
    expect(issues.join(' ')).toContain('原文要求使用图1（成品内容），但制作输入未绑定该图');
  });
  it.each(['后脖', '后领', '后领口', '后颈', '后背上方', '背面'])('keeps %s references out of the front position', placement => {
    const requirement = `301SRX-黑色\n正面 图一\n${placement}  图一前三排  按照图二做\n正面高35cm 后背宽8`;
    expect(artworkReferenceEvidence(sourceArtworkReferenceRequirement(requirement, 'frontCenter', 1))).toEqual([]);
    expect(artworkReferenceEvidence(sourceArtworkReferenceRequirement(requirement, 'back', 1))).toMatchObject([{ number: 2 }]);
  });
  it('requires both the reference purpose and the original partial selection', () => {
    const request = { ...input, sourceRequirementText: '正面 图一\n后脖 图一前三排 按照图二做', printPlacement: { key: 'back' }, primaryImageLabel: '图1', instruction: '后脖取图一的前三排，按照图二样式制作', referenceImages: [{ label: '图2' }] };
    expect(artworkReferenceIssues(request).join('；')).toContain('用途尚未明确');
    const clarified = { ...request, layoutNote: '图2只参考后领小图案的排版，内容仍取图1前三排。', sourceScope: 'custom' as const };
    expect(artworkReferenceIssues(clarified)).toEqual([]);
    expect(artworkReferenceIssues({ ...clarified, instruction: '使用图1完整图案，排版参考图2' }).join('；')).toContain('未完整保留该范围');
  });
});
