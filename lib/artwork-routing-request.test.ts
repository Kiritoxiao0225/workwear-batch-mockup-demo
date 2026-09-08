import { describe, expect, it } from 'vitest';
import { artworkMethodIssue, artworkRequirementFacts, type ArtworkRequirementInput } from './artwork-routing-request';

const input = (patch: Partial<ArtworkRequirementInput> = {}): ArtworkRequirementInput => ({
  instruction: '左胸使用图1，保留原图案', layoutNote: '', exactText: '', primaryImageLabel: '图1',
  sourceScope: 'subject', processingRoute: 'auto', referenceImages: [], ...patch,
});

describe('requirement-driven artwork methods', () => {
  it.each([undefined, '保留图1全部原图形、文字、颜色和排版，制作完整二维图案，纯白背景。'])('keeps original-logo work in A with prompt %s', generationPrompt => {
    expect(artworkRequirementFacts(input({ generationPrompt }))).toMatchObject({ intent: 'preserve', blockers: [] });
  });
  it('keeps logo recoloring and ordinary lettering in C after prompt authoring', () => {
    const request = input({ instruction: '保留图1，Logo 改为绿色，添加文字“poppy手机数码”。', exactText: 'poppy手机数码',
      generationPrompt: '以图1为内容，保留手势造型并改为绿色，下方写“poppy手机数码”，完整图案，纯白背景。' });
    expect(artworkRequirementFacts(request)).toMatchObject({ intent: 'compose', editSpecification: 'complete' });
    expect(artworkMethodIssue(request, 'compose')).toBeNull();
    expect(artworkMethodIssue(request, 'preserve')).not.toBeNull();
  });
  it('distinguishes a font reference from a reference that sets the whole layout', () => {
    const request = input({ exactText: '研', instruction: '保留图1并添加“研”，只参考图2的字体', referenceImages: [{ label: '图2' }],
      generationPrompt: '图1为内容，只参考图2的字形制作文字“研”，纯白背景。' });
    expect(artworkRequirementFacts(request).intent).toBe('compose');
    expect(artworkRequirementFacts({ ...request, layoutNote: '图2决定整组图案的排版与比例' }).intent).toBe('generate');
    expect(artworkRequirementFacts({ ...request, generationPrompt: '参考图2的整体构图与排版，制作图1＋研。' }).intent).toBe('generate');
  });
  it('retains manual preservation and generation without letting a prompt select a route', () => {
    const request = input({ generationPrompt: '保留图1原设计，输出完整白底图。' });
    expect(artworkRequirementFacts({ ...request, artworkMethod: 'preserve' })).toMatchObject({ intent: 'preserve', strictPreservation: true });
    expect(artworkRequirementFacts({ ...request, artworkMethod: 'generate' })).toMatchObject({ intent: 'generate' });
    expect(artworkMethodIssue(input({ instruction: '严格保真，禁止重绘', generationPrompt: request.generationPrompt }), 'generate')).toContain('严格保真');
  });
  it('does not let an authored prompt hide a missing reference from the source order', () => {
    expect(artworkRequirementFacts(input({ sourceRequirementText: '左胸：图1，整体排版参考图2', printPlacement: { key: 'leftChest' } as ArtworkRequirementInput['printPlacement'],
      generationPrompt: '使用图1，保留原图案。' })).blockers.join(' ')).toContain('原文要求参考图2');
  });
  it('keeps cropping as C and requests the missing crop instead of generating a new design', () => {
    expect(artworkRequirementFacts(input({ instruction: '取用图1前三排', sourceScope: 'custom', generationPrompt: '仅取图1前三排内容，纯白背景。' })))
      .toMatchObject({ intent: 'compose', editSpecification: 'incomplete' });
  });
});
