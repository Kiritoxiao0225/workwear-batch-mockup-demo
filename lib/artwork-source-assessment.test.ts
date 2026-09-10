import { describe, expect, it } from 'vitest';
import { artworkSourceAssessmentSchema, type ArtworkSourceAssessment } from './artwork-source-assessment';
import { artworkMethodIssue, artworkRequirementFacts, standardArtworkPrompts, type ArtworkRequirementInput } from './artwork-routing-request';
import { decideArtworkMethod } from './artwork-routing-standard';

const photo: ArtworkSourceAssessment = { version: 'artwork-source-v1', kind: 'artwork-on-object',
  targetDescription: '图二衣袋上方的红色弧形中文和中心医疗标志', needsReconstruction: true,
  evidence: ['红色刺绣位于有蓝色花纹的衣料上', '褶皱与斜拍造成变形'], uncertainDetails: ['个别中文字看不清'] };
const input = (patch: Partial<ArtworkRequirementInput> = {}): ArtworkRequirementInput => ({
  sourceAssessment: photo, instruction: '左胸使用图二中的红色弧形中文文字与中心花形标识，保留原图案内容和排列。',
  sourceRequirementText: '货号:BT6678JSH-黑色-L\n左胸：图二', layoutNote: '', exactText: '',
  primaryImageLabel: '图2', sourceScope: 'subject', processingRoute: 'auto', referenceImages: [], ...patch,
});
const decision = (patch: Partial<ArtworkRequirementInput> = {}) => decideArtworkMethod(artworkRequirementFacts(input(patch)));

describe('visual source evidence selects artwork processing', () => {
  it('routes the hospital chest photo directly to B, without a failed repair or guessed exact text', () => {
    expect(decision()).toMatchObject({ method: 'redraw', action: 'redraw', state: 'ready' });
    expect(artworkRequirementFacts(input()).blockers).toEqual([]);
    expect(artworkMethodIssue(input(), 'preserve')).toContain('实物表面');
    expect(artworkMethodIssue(input(), 'redraw')).toBeNull();
    expect(artworkRequirementFacts(input({ artworkMethod: 'generate' }))).toMatchObject({ intent: 'generate', reconstructSource: false });
  });
  it('does not classify source media from instruction keywords', () => {
    const flat = { ...photo, kind: 'flat-artwork' as const, needsReconstruction: false, evidence: ['白底独立平面 Logo'] };
    expect(decision({ sourceAssessment: flat, instruction: '将此 Logo 用于刺绣，保留原图' })).toMatchObject({ method: 'preserve' });
    expect(decision({ instruction: '图二' })).toMatchObject({ method: 'redraw' });
  });
  it('keeps explicit whole-photo usage and reference-only images out of reconstruction', () => {
    expect(artworkRequirementFacts(input({ sourceScope: 'wholeImage' }))).toMatchObject({ reconstructSource: false, sourceAssessmentRequired: false });
    expect(decision({ sourceScope: 'wholeImage' }).method).toBe('preserve');
    expect(artworkRequirementFacts(input({ primaryImageRole: 'reference', exactText: '新文字' }))).toMatchObject({ intent: 'generate', reconstructSource: false });
  });
  it('keeps photo illustrations intact when the photo itself is the requested content', () => {
    expect(decision({ sourceAssessment: { ...photo, kind: 'photo-content', needsReconstruction: false } }).method).toBe('preserve');
  });
  it('resolves missing visual evidence before recommending A, including legacy tasks', () => {
    expect(decision({ sourceAssessment: undefined })).toMatchObject({ method: null, state: 'pending', action: 'inspect' });
    expect(decision({ sourceAssessment: { ...photo, kind: 'unknown', needsReconstruction: null } }).method).toBeNull();
  });
  it('keeps explicit no-redraw requirements as a real conflict', () => {
    expect(decision({ instruction: '保留原像素，不得重绘' })).toMatchObject({ state: 'review' });
  });
  it('reconstructs C source graphics before adding requested lettering', () => {
    const facts = artworkRequirementFacts(input({ exactText: '新增文字', instruction: '使用图2，添加文字“新增文字”' }));
    expect(facts).toMatchObject({ intent: 'compose', reconstructSource: true });
    expect(decideArtworkMethod(facts).method).toBe('compose');
    expect(decideArtworkMethod({ ...facts, intent: 'preserve' }).method).toBe('redraw');
  });
  it('keeps source letters and white/gradient design details in reconstruction prompts', () => {
    const prompts = standardArtworkPrompts({ ...input(), sourceRequirementText: '左胸：图二' });
    expect(prompts.reconstruct).toContain('WPS 图2');
    expect(prompts.reconstruct).toContain('图案本身的白色、渐变');
    expect(prompts.reconstruct).toContain('不把推测写成确定文字');
    expect(standardArtworkPrompts({ ...input({ sourceAssessment: undefined }), sourceRequirementText: '左胸：图二' }).hash).not.toBe(prompts.hash);
    expect(() => artworkSourceAssessmentSchema.parse({ ...photo, kind: 'shirt' })).toThrow();
  });
});
