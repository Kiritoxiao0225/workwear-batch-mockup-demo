import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createLegacyArtworkDraft } from '@/lib/artwork-editor';
import { parseArtworkPreparationRequest, type ArtworkPreparationResponse } from '@/lib/task-review-artwork';
import { artworkPromptHash, artworkRequirementFacts, standardArtworkPrompts } from '@/lib/artwork-routing-request';
import { NativeArtworkCandidateError, prepareStandardArtwork, type StandardArtworkServices } from '@/lib/server/artwork-standard-pipeline';
import { measureArtworkQuality, artworkSha256 } from '@/lib/server/artwork-quality';
import { redrawEligibility, type RedrawInspection } from '@/lib/server/ark-artwork-processing';
import type { ArtworkProgressEvent } from '@/lib/artwork-progress';
import { ArtworkCutoutPendingError } from './artwork-cutout';

const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
async function sample(transparent = false) {
  return sharp(Buffer.from(`<svg width="1200" height="900"><rect width="1200" height="900" fill="${transparent ? 'none' : 'white'}"/><path fill="#b41230" d="M100 100h900v300H100z M600 180v140h300V180z" fill-rule="evenodd"/><rect x="100" y="500" width="900" height="250" fill="#323b40"/></svg>`)).png().toBuffer();
}
async function setup(scores: number[] = [90, 90]) {
  const source = await sample(), prepared = await sample(true);
  const request = parseArtworkPreparationRequest({ instruction: '保留图1原图案', sourceRequirementText: '保留原图', printPlacement: { key: 'leftChest', sizeMode: 'widthCm', widthCm: 7.62 }, image: { dataUrl: url(source), mimeType: 'image/png', fileName: 'test.png' }, enhancementMode: 'auto' });
  const measure = vi.fn(async (bytes: Buffer) => measureArtworkQuality(bytes, async () => ({ blur: 100 - (scores.shift() ?? 90), vqscore: 75, noise: 60, compressionArtifacts: 30 })));
  const fidelity = vi.fn(async (input: typeof request) => ({ status: 'prepared', draft: createLegacyArtworkDraft(url(prepared)), preprocessing: { enhancement: input.enhancementMode, backgroundRemoval: 'edge-connected' } } as ArtworkPreparationResponse));
  const generate = vi.fn<StandardArtworkServices['generate']>(async () => ({ bytes: source, model: 'test-seedream' }));
  const inspect = vi.fn(async (): Promise<RedrawInspection> => ({ type: 'flat-logo', textReadable: true, graphicReadable: true, hasWhiteForeground: false, recognizedText: '', reasons: ['测试图为平面纯色'] }));
  const services: StandardArtworkServices = { measure, fidelity, generate, inspect,
    inspectSource: vi.fn<StandardArtworkServices['inspectSource']>(async () => ({ version: 'artwork-source-v1', kind: 'flat-artwork', targetDescription: '独立平面 Logo', needsReconstruction: false, recognizedContent: { text: [], layout: '原排版', colors: ['红色'], structure: '平面图形' }, selection: { scope: 'full-image' }, evidence: ['图案已独立，无实物载体'], uncertainDetails: [] })), cutout: vi.fn(async () => prepared), saveReport: vi.fn(), saveImage: vi.fn(), saveGeneration: vi.fn(), resolveReferenceColor: vi.fn(async () => { throw new Error('Unexpected reference color inspection'); }), verifyEdits: vi.fn(async () => { throw new Error('Unexpected edit verification'); }),
    verifyText: vi.fn<StandardArtworkServices['verifyText']>(async (bytes, targetText) => ({ version: 'artwork-text-component-v1', outputSha256: artworkSha256(bytes), targetText,
      recognizedText: targetText, model: 'test-inspector', status: 'passed', evidence: '只有目标文字' })) };
  return { request, services, measure, fidelity, generate, inspect, source };
}

describe('executed artwork standard', () => {
  it('resolves legacy flat-artwork selections and sends only selected pixels to quality and fidelity', async () => {
    const t = await setup();
    const legacy = await t.services.inspectSource('', '');
    delete legacy.selection;
    vi.mocked(t.services.inspectSource).mockClear().mockResolvedValue({ ...legacy, selection: {
      scope: 'region', bounds: { left: 50, top: 80, right: 870, bottom: 500 },
    } });
    const result = await prepareStandardArtwork({ ...t.request, sourceAssessment: legacy }, t.services);
    expect(t.services.inspectSource).toHaveBeenCalledOnce();
    const report = result.draft.preprocessing.routingReport!;
    expect(report.sourceSha256).toBe(artworkSha256(t.source));
    expect(report.sourceSelection).toMatchObject({ sourceSha256: artworkSha256(t.source), bounds: { left: 60, top: 72, width: 984, height: 378 } });
    const selected = t.measure.mock.calls[0][0];
    expect(artworkSha256(selected)).toBe(report.sourceSelection!.outputSha256);
    expect(t.fidelity.mock.calls[0][0].image.dataUrl).toBe(url(selected));
    expect(t.services.saveImage).toHaveBeenCalledWith(expect.any(String), 'selected-source', selected);
    expect(t.generate).not.toHaveBeenCalled();
  });
  it('stops uncertain selection before quality, enhancement or cutout', async () => {
    const t = await setup();
    const assessment = { ...await t.services.inspectSource('', ''), selection: { scope: 'unknown' as const } };
    await expect(prepareStandardArtwork({ ...t.request, sourceAssessment: assessment }, t.services)).rejects.toThrow('尚未确定本次要用的图案范围');
    expect(t.measure).not.toHaveBeenCalled();
    expect(t.fidelity).not.toHaveBeenCalled();
    expect(t.services.cutout).not.toHaveBeenCalled();
    expect(t.generate).not.toHaveBeenCalled();
  });
  it('resolves an explicit crop instruction through visual selection instead of retrying whole-image cutout', async () => {
    const t = await setup();
    vi.mocked(t.services.inspectSource).mockResolvedValue({ version: 'artwork-source-v1', kind: 'flat-artwork',
      targetDescription: '前三排图形', needsReconstruction: false, evidence: ['目标可用单个矩形完整隔离'], uncertainDetails: [],
      selection: { scope: 'region', bounds: { left: 50, top: 80, right: 870, bottom: 500 } } });
    const result = await prepareStandardArtwork({ ...t.request, instruction: '截取图1前三排', sourceScope: 'custom' }, t.services);
    expect(t.services.inspectSource).toHaveBeenCalledOnce();
    expect(result.draft.preprocessing.routingReport!.sourceSelection).toBeDefined();
    expect(t.measure.mock.calls[0][0]).not.toEqual(t.source);
    expect(t.generate).not.toHaveBeenCalled();
  });
  it('leaves explicit whole-image usage intact even with a stored region', async () => {
    const t = await setup();
    const assessment = { ...await t.services.inspectSource('', ''), selection: { scope: 'region' as const, bounds: { left: 50, top: 80, right: 870, bottom: 500 } } };
    const result = await prepareStandardArtwork({ ...t.request, sourceScope: 'wholeImage', instruction: '整张图片作为完整印花内容保留', sourceRequirementText: '整张图片直接印', sourceAssessment: assessment }, t.services);
    expect(t.measure.mock.calls[0][0]).toEqual(t.source);
    expect(result.draft.preprocessing.routingReport!.sourceSelection).toBeUndefined();
  });
  it('verifies internal deletion before composing arc text and retains the deletion receipt', async () => {
    const t = await setup();
    const cleared = await sharp(Buffer.from('<svg width="1200" height="900"><path fill="#b41230" d="M100 100h900v300H100z"/></svg>')).png().toBuffer();
    t.generate.mockResolvedValue({ bytes: cleared, model: 'test-editor' });
    t.services.cutout = vi.fn(async () => cleared);
    t.services.verifyEdits = vi.fn<StandardArtworkServices['verifyEdits']>(async (source, output, requirements) => ({
      version: 'artwork-edit-check-v1', sourceSha256: artworkSha256(source), outputSha256: artworkSha256(output), model: 'test',
      checks: requirements.map(requirement => ({ requirement, status: 'passed', evidence: '内部元素删除，其余保留' })),
    }));
    const result = await prepareStandardArtwork({ ...t.request, instruction: '去掉牙齿内部的眼睛和嘴巴，上方添加圆弧文字“小景是牙医”',
      layoutNote: '文字排成圆弧形，置于牙齿图形上方', exactText: '小景是牙医' }, t.services);
    expect(t.generate).toHaveBeenCalledOnce();
    expect(result.draft.graphic.sourceUrl).toBe(url(cleared));
    expect(result.draft.text).toMatchObject({ value: '小景是牙医', arc: { mode: 'up' } });
    expect(result.draft.extraGraphics ?? []).toHaveLength(0);
    expect(result.draft.preprocessing.routingReport).toMatchObject({ executedMethod: 'compose',
      textComposition: { graphicRemoval: { outputSha256: artworkSha256(cleared) } } });
    expect(result.draft.preprocessing.routingReport?.prompt).toContain('局部删除步骤');
    expect(t.services.verifyText).not.toHaveBeenCalled();
  });
  it.each(['failed', 'uncertain', 'unavailable', 'wrong-hash', 'missing-check'] as const)(
    'composes and saves with a warning when internal deletion inspection is %s', async status => {
      const t = await setup();
      t.services.verifyEdits = vi.fn<StandardArtworkServices['verifyEdits']>(async (source, output, requirements) => {
        if (status === 'unavailable') throw new Error('检查超时');
        return { version: 'artwork-edit-check-v1', sourceSha256: artworkSha256(source),
          outputSha256: status === 'wrong-hash' ? 'old-image' : artworkSha256(output), model: 'test',
          checks: (status === 'missing-check' ? requirements.slice(1) : requirements).map(requirement => ({
            requirement, status: status === 'failed' || status === 'uncertain' ? status : 'passed', evidence: '未删除或无法确认',
          })) };
      });
      const result = await prepareStandardArtwork({ ...t.request, instruction: '去掉眼睛，新增书法文字“小景是牙医”', exactText: '小景是牙医' }, t.services);
      expect(result.status).toBe('prepared');
      expect(result.draft.preprocessing.routingReport?.contentReview?.warnings.length).toBeGreaterThan(0);
      expect(t.generate).toHaveBeenCalledTimes(2);
      expect(t.services.verifyText).toHaveBeenCalledOnce();
      expect(t.services.saveReport).toHaveBeenCalledOnce();
    });
  it('clears the old lettering before adding replacement text, keeping one graphic layer', async () => {
    const t = await setup();
    const cleared = await sharp(Buffer.from('<svg width="1200" height="900"><path fill="#b41230" d="M100 100h900v300H100z"/></svg>')).png().toBuffer();
    t.generate.mockResolvedValue({ bytes: cleared, model: 'test-editor' });
    t.services.cutout = vi.fn(async () => cleared);
    t.services.verifyEdits = vi.fn<StandardArtworkServices['verifyEdits']>(async (source, output, requirements) => ({ version: 'artwork-edit-check-v1',
      sourceSha256: artworkSha256(source), outputSha256: artworkSha256(output), model: 'test-inspector',
      checks: requirements.map(requirement => ({ requirement, status: 'passed', evidence: '指定旧字消失，其余内容保留' })) }));
    const result = await prepareStandardArtwork({ ...t.request, instruction: '将Logo下方原文字替换为“康悦”，其余图形保留', exactText: '康悦' }, t.services);
    expect(t.generate).toHaveBeenCalledOnce();
    expect(t.generate.mock.calls[0][0]).toContain('不制作新文字');
    expect(result.draft.graphic.sourceUrl).toBe(url(cleared));
    expect(result.draft.text?.value).toBe('康悦');
    expect(result.draft.extraGraphics ?? []).toHaveLength(0);
    expect(result.preprocessing.modelLayoutPreserved).toBe(false);
    expect(result.draft.preprocessing.routingReport?.textComposition).toMatchObject({ operation: 'replace', removal: { outputSha256: artworkSha256(cleared) } });
    expect(t.services.verifyText).not.toHaveBeenCalled();
  });

  it.each(['failed', 'uncertain', 'unavailable', 'wrong-hash'] as const)('continues replacing text with a warning when old-text inspection is %s', async status => {
    const t = await setup();
    t.services.verifyEdits = vi.fn<StandardArtworkServices['verifyEdits']>(async (source, output, requirements) => {
      if (status === 'unavailable') throw new Error('检查暂不可用');
      return { version: 'artwork-edit-check-v1', sourceSha256: artworkSha256(source), outputSha256: status === 'wrong-hash' ? 'stale' : artworkSha256(output), model: 'test',
        checks: requirements.map(requirement => ({ requirement, status: status === 'wrong-hash' ? 'passed' : status, evidence: '旧字仍在或无法看清' })) };
    });
    const result = await prepareStandardArtwork({ ...t.request, instruction: '将原文字替换为“康悦”，使用书法字体', exactText: '康悦' }, t.services);
    expect(result.status).toBe('prepared');
    expect(result.draft.preprocessing.routingReport?.contentReview?.warnings.length).toBeGreaterThan(0);
    expect(t.generate).toHaveBeenCalledTimes(2);
    expect(t.services.verifyText).toHaveBeenCalledOnce();
    expect(t.services.saveReport).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'uncertain', 'unavailable', 'wrong-hash'] as const)('composes a styled-text component with an inspection warning: %s', async status => {
    const t = await setup();
    t.services.verifyText = vi.fn<StandardArtworkServices['verifyText']>(async (bytes, targetText) => {
      if (status === 'unavailable') throw new Error('检查暂不可用');
      return { version: 'artwork-text-component-v1', outputSha256: status === 'wrong-hash' ? 'stale' : artworkSha256(bytes), targetText,
        recognizedText: targetText, model: 'test', status: status === 'wrong-hash' ? 'passed' : status, evidence: '文字上方夹带了Logo或无法确认' };
    });
    const result = await prepareStandardArtwork({ ...t.request, instruction: '保留原字，新增书法文字“康悦”', exactText: '康悦' }, t.services);
    expect(result.status).toBe('prepared');
    expect(result.draft.preprocessing.routingReport?.contentReview?.warnings.length).toBeGreaterThan(0);
    expect(t.generate).toHaveBeenCalledOnce();
    expect(t.services.saveReport).toHaveBeenCalledOnce();
    expect(t.services.saveImage).toHaveBeenCalledWith(expect.any(String), 'styled-text-0-original', t.source);
  });

  it('marks an interrupted styled-text cutout as a component, never a finished generated artwork', async () => {
    const t = await setup();
    const pending = { status: 'pending' as const, receipt: { jobKey: 'b'.repeat(64), mode: 'auto' as const, route: 'meitu' as const,
      version: 'artwork-cutout-v4' as const, reasons: [], sourceSha256: artworkSha256(t.source), sourceUrl: url(t.source), actualCredits: null, estimatedCredits: 1, cacheHit: false } };
    t.services.cutout = vi.fn(async () => { throw new ArtworkCutoutPendingError(pending); });
    const error = await prepareStandardArtwork({ ...t.request, instruction: '新增书法文字“康悦”', exactText: '康悦' }, t.services).catch(error => error);
    expect(error.candidate).toMatchObject({ requiresEditVerification: true, cutout: pending });
    expect(t.services.verifyText).not.toHaveBeenCalled();
    expect(t.services.saveReport).not.toHaveBeenCalled();
  });
  it('keeps an interrupted regional edit as a component until its edit requirements have been verified', async () => {
    const t = await setup();
    const pending = { status: 'pending' as const, receipt: { jobKey: 'a'.repeat(64), mode: 'auto' as const, route: 'meitu' as const,
      version: 'artwork-cutout-v4' as const, reasons: [], sourceSha256: artworkSha256(t.source), sourceUrl: url(t.source), actualCredits: null, estimatedCredits: 1, cacheHit: false } };
    t.services.cutout = vi.fn(async () => { throw new ArtworkCutoutPendingError(pending); });
    const error = await prepareStandardArtwork({ ...t.request, instruction: '红色描边改成深蓝色，底形调浅', generationPrompt: '编辑图1' }, t.services).catch(error => error);
    expect(error.candidate).toMatchObject({ requiresEditVerification: true, cutout: pending });
    expect(t.services.verifyEdits).not.toHaveBeenCalled();
    expect(t.services.saveReport).not.toHaveBeenCalled();
    expect(t.generate).toHaveBeenCalledOnce();
  });
  it('edits the original before cutout and verifies both regional colour changes before preparing it', async () => {
    const t = await setup();
    const generated = await sharp(t.source).modulate({ brightness: .9 }).png().toBuffer();
    t.generate.mockResolvedValue({ bytes: generated, model: 'test-editor' });
    t.services.verifyEdits = vi.fn<StandardArtworkServices['verifyEdits']>(async (source, output, requirements) => ({ version: 'artwork-edit-check-v1',
      sourceSha256: artworkSha256(source), outputSha256: artworkSha256(output), model: 'test-inspector',
      checks: requirements.map(requirement => ({ requirement, status: 'passed', evidence: '对应部位修改正确' })) }));
    const request = { ...t.request, instruction: '将字体红色描边改成深蓝色，将原深蓝色底形调浅，其他内容保留原样', generationPrompt: '保留图1并按要求修改，白色背景' };
    const result = await prepareStandardArtwork(request, t.services);
    expect(t.generate).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(request.instruction), [t.request.image.dataUrl], { background: 'auto' });
    expect(t.services.cutout).toHaveBeenCalledExactlyOnceWith(generated, { scene: 'product', crop: false });
    expect(vi.mocked(t.services.cutout).mock.invocationCallOrder[0]).toBeGreaterThan(t.generate.mock.invocationCallOrder[0]);
    expect(t.services.verifyEdits).toHaveBeenCalledExactlyOnceWith(t.source, await sample(true), [
      '将字体红色描边改成深蓝色', '将原深蓝色底形调浅', expect.stringContaining('未点名修改'),
    ]);
    expect(t.fidelity).not.toHaveBeenCalled();
    expect(result.draft.preprocessing.routingReport?.executedMethod).toBe('generate');
    expect(t.services.saveGeneration).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ editVerification: expect.objectContaining({ sourceSha256: artworkSha256(t.source) }) }));
  });
  it.each(['failed', 'uncertain', 'unavailable'] as const)('saves the actual image and visible warnings when inspection is %s', async status => {
    const t = await setup();
    t.services.verifyEdits = vi.fn<StandardArtworkServices['verifyEdits']>(async (source, output, requirements) => {
      if (status === 'unavailable') throw new Error('inspection timeout');
      return { version: 'artwork-edit-check-v1', sourceSha256: artworkSha256(source), outputSha256: artworkSha256(output), model: 'test',
        checks: requirements.map(requirement => ({ requirement, status, category: 'color', impact: status === 'failed' ? 'material' : 'unknown', evidence: status === 'failed'
          ? 'SOURCE 是红色描边，RESULT 的描边仍然是红色。' : '无法确定 RESULT 的描边是否已改成深蓝色。' })) };
    });
    const result = await prepareStandardArtwork({ ...t.request, instruction: '红色描边改为深蓝色，深蓝色底形调浅', generationPrompt: '编辑图1' }, t.services);
    const review = result.draft.preprocessing.routingReport!.contentReview!;
    expect(result.status).toBe('prepared');
    expect(result.draft.graphic.sourceUrl).toBe(url(await sample(true)));
    expect(review.warnings).toHaveLength(1);
    expect(review.warnings[0]).not.toMatch(/SOURCE|RESULT/u);
    if (status === 'failed') {
      expect(review.warnings[0]).toContain('描边仍然是红色');
      expect(review.verification!.checks.every(check => check.status === 'failed')).toBe(true);
    }
    expect(t.services.saveReport).toHaveBeenCalledOnce();
    expect(t.services.saveGeneration).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'prepared-with-warnings' }));
    expect(t.services.saveImage).toHaveBeenCalledWith(expect.any(String), 'prepared-graphic', await sample(true));
    expect(t.generate).toHaveBeenCalledOnce(); expect(t.services.cutout).toHaveBeenCalledOnce();
  });
  it.each(['measurement', 'report-save'] as const)('retains the generated image when downstream %s fails', async failure => {
    const t = await setup();
    if (failure === 'measurement') t.measure.mockImplementationOnce(async bytes => measureArtworkQuality(bytes, async () => ({ blur: 10, vqscore: 75, noise: 60, compressionArtifacts: 30 }))).mockRejectedValue(new Error('result scoring unavailable'));
    else t.services.saveReport = vi.fn(async () => { throw new Error('report storage unavailable'); });
    const error = await prepareStandardArtwork({ ...t.request, instruction: '重新设计完整图案', generationPrompt: '生成完整独立图案', artworkMethod: 'generate' }, t.services).catch(error => error);
    expect(error).toBeInstanceOf(NativeArtworkCandidateError);
    expect(error.candidate).toMatchObject({ stage: 'processing', url: url(await sample(true)), retryable: true });
    expect(error.candidate.reason).toContain('图片已保留');
    expect(t.generate).toHaveBeenCalledOnce(); expect(t.services.cutout).toHaveBeenCalledOnce();
  });
  it('executes ordinary arc lettering above the logo without purchasing styled text', async () => {
    const t = await setup();
    const result = await prepareStandardArtwork({ ...t.request, exactText: '小景是牙医',
      instruction: '左胸制作圆弧形文字“小景是牙医”，文字下面组合WPS图1',
      layoutNote: '文字“小景是牙医”排成圆弧形，置于牙齿图形上方' }, t.services);
    expect(t.generate).not.toHaveBeenCalled();
    expect(result.draft.preprocessing.routingReport?.executedMethod).toBe('compose');
    expect(result.draft.layout.preset).toBe('verticalReverse');
    expect(result.draft.text).toMatchObject({ value: '小景是牙医', arc: { mode: 'up', bend: 65 } });
    expect(result.draft.text!.y).toBeLessThan(result.draft.graphic.y);
    expect(result.preprocessing.componentPlan).toMatchObject({ texts: [{ method: 'deterministic-transform' }],
      sequence: [{ kind: 'text', id: 'text-1' }, { kind: 'graphic' }] });
  });

  it('starts D generation alongside source scoring and exposes previews without skipping final quality', async () => {
    const t = await setup();
    const prepared = await sample(true);
    const sourceQuality = await t.measure(t.source), finalQuality = await t.measure(prepared);
    let releaseSource!: () => void, releaseCutout!: () => void, releaseFinal!: () => void;
    const sourceGate = new Promise<void>(resolve => { releaseSource = resolve; });
    const cutoutGate = new Promise<void>(resolve => { releaseCutout = resolve; });
    const finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
    t.measure.mockReset().mockImplementationOnce(async () => { await sourceGate; return sourceQuality; })
      .mockImplementationOnce(async () => finalQuality).mockImplementationOnce(async () => { await finalGate; return finalQuality; });
    t.services.cutout = vi.fn(async () => { await cutoutGate; return prepared; });
    const events: ArtworkProgressEvent[] = [];
    const complete = vi.fn();
    const run = prepareStandardArtwork({ ...t.request, artworkMethod: 'generate', generationPrompt: '保留图1，整图生成，纯白背景。' }, t.services, event => events.push(event)).then(result => { complete(); return result; });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'preview')).toHaveLength(1));
    expect(t.generate).toHaveBeenCalledOnce();
    expect(t.measure).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    // The cutout starts while source scoring is still blocked.
    await vi.waitFor(() => expect(t.services.cutout).toHaveBeenCalledOnce());
    releaseCutout();
    releaseSource();
    await vi.waitFor(() => expect(events.filter(event => event.type === 'preview')).toHaveLength(2));
    expect(complete).not.toHaveBeenCalled();
    releaseFinal();
    const result = await run;
    expect(result.draft.graphic.sourceUrl).toBe(url(prepared));
    expect(result.preprocessing.timings?.map(timing => timing.stage).sort()).toEqual(['cutout', 'generation', 'inspection', 'resultPixels', 'resultPixels', 'sourcePixels']);
    expect(events.some(event => event.type === 'progress' && event.generationFinished)).toBe(true);
  });

  it('preserves the paid model original when concurrent source scoring fails, without retry', async () => {
    const t = await setup();
    t.measure.mockRejectedValue(new Error('source scoring unavailable'));
    const rejected = await prepareStandardArtwork({ ...t.request, artworkMethod: 'generate', generationPrompt: '保留图1，整图生成，纯白背景。' }, t.services).catch(error => error);
    expect(rejected.candidate.url).toBe(url(t.source));
    expect(t.generate).toHaveBeenCalledOnce();
    expect(t.services.cutout).toHaveBeenCalledOnce();
    expect(t.services.saveGeneration).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'needs-review' }));
    expect(t.services.saveReport).not.toHaveBeenCalled();
  });
  it.each([false, true])('returns the paid original when its storage fails, even with source scoring failure=%s', async scoringFails => {
    const t = await setup();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    if (scoringFails) t.measure.mockRejectedValue(new Error('source scoring unavailable'));
    t.services.saveImage = vi.fn().mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT private-oss.example:443 agent status: {}'), { code: 'ETIMEDOUT' }));
    const events: ArtworkProgressEvent[] = [];
    try {
      const error = await prepareStandardArtwork({ ...t.request, instruction: '将红色描边改成深蓝色',
        artworkMethod: 'generate', generationPrompt: '按要求修改图1，整图生成，纯白背景。' }, t.services, event => events.push(event)).catch(error => error);
      expect(error.candidate).toMatchObject({ url: url(t.source), model: 'test-seedream', stage: 'original-save', requiresEditVerification: true });
      expect(error.message).toContain('保存原图失败');
      expect(error.message).not.toMatch(/ETIMEDOUT|private-oss|agent status/);
      expect(events.some(event => event.type === 'preview')).toBe(true);
      expect(events.some(event => event.type === 'progress' && event.generationFinished)).toBe(true);
      expect(t.generate).toHaveBeenCalledOnce();
      expect(t.services.saveImage).toHaveBeenCalledOnce();
      expect(t.services.cutout).not.toHaveBeenCalled();
      expect(t.services.saveReport).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });
  it('generates a white image then uses the cutout PNG with the model layout and white interiors preserved', async () => {
    const t = await setup();
    const original = await sharp(Buffer.from('<svg width="1200" height="1200"><circle cx="600" cy="600" r="280" fill="white" stroke="red" stroke-width="20"/><path fill="red" d="M500 500h200v200H500z"/><rect x="150" y="70" width="850" height="50" fill="#ffcc00"/><rect x="150" y="1060" width="850" height="50" fill="#ffcc00"/></svg>')).png().toBuffer();
    const whiteOriginal = await sharp(original).flatten({ background: '#ffffff' }).png().toBuffer();
    t.generate.mockResolvedValue({ bytes: whiteOriginal, model: 'gpt-image-2' });
    t.services.cutout = vi.fn(async () => original);
    const result = await prepareStandardArtwork({ ...t.request, printPlacement: { key: 'leftChest', sizeMode: 'widthCm', widthCm: 7 }, generationPrompt: '保留图1的内容，制作完整平面图案，纯白背景（#FFFFFF）。', artworkMethod: 'generate', instruction: '制作新的完整图案' }, t.services);
    expect(result.preprocessing).toMatchObject({ nativeOutput: false, modelLayoutPreserved: true, backgroundRemoval: 'product' });
    expect(result.draft.graphic.sourceUrl).toBe(url(original));
    expect(result.draft.text).toBeNull();
    expect(t.inspect).not.toHaveBeenCalled();
    expect(t.services.cutout).toHaveBeenCalledExactlyOnceWith(whiteOriginal, { scene: 'product', crop: false });
    expect(t.fidelity).not.toHaveBeenCalled();
    expect(t.services.saveGeneration).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'cutout-accepted', originalHasAlpha: false, backgroundRemoval: 'product' }));
    expect(t.services.saveImage).toHaveBeenCalledWith(expect.any(String), 'prepared-graphic', original);
  });
  it.each(['api-error', 'missing-alpha', 'opaque-alpha', 'empty'] as const)('retains the generated original when cutout fails (%s), without regenerating or saving it as prepared', async failure => {
    const t = await setup();
    const original = await sharp(t.source).removeAlpha().png().toBuffer();
    t.generate.mockResolvedValue({ bytes: original, model: 'gpt-image-2' });
    t.services.cutout = vi.fn(async () => {
      if (failure === 'api-error') throw new Error('cutout unavailable');
      if (failure === 'empty') return sharp({ create: { width: 1200, height: 900, channels: 4, background: '#00000000' } }).png().toBuffer();
      return (failure === 'opaque-alpha' ? sharp(original).ensureAlpha() : sharp(original).removeAlpha()).png().toBuffer();
    });
    const result = await prepareStandardArtwork({ ...t.request, generationPrompt: '保留图1的内容，制作完整平面图案，纯白背景（#FFFFFF）。', instruction: '按要求整图生成新的完整设计', artworkMethod: 'generate' }, t.services).catch(error => error);
    expect(result.candidate).toMatchObject({ url: url(original), model: 'gpt-image-2' });
    expect(result.message).toContain('图案已生成，但抠图未完成');
    expect(t.services.cutout).toHaveBeenCalledExactlyOnceWith(original, { scene: 'product', crop: false });
    expect(t.fidelity).not.toHaveBeenCalled();
    expect(t.generate).toHaveBeenCalledTimes(1);
    expect(t.services.saveImage).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'generated-original', original);
    expect(t.services.saveReport).not.toHaveBeenCalled();
    expect(t.services.saveGeneration).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'needs-review', originalSha256: artworkSha256(original) }));
  });
  it.each(['auto', 'compose', 'generate'] as const)('rejects missing references before any paid work even with method %s', async artworkMethod => {
    const t = await setup();
    await expect(prepareStandardArtwork({ ...t.request, artworkMethod, instruction: '使用图1，后背排版和字体颜色参考图三', exactText: '志愿者' }, t.services)).rejects.toThrow('未绑定');
    expect(t.measure).not.toHaveBeenCalled();
    expect(t.generate).not.toHaveBeenCalled();
    expect(t.fidelity).not.toHaveBeenCalled();
  });
  it('passes both content and layout reference images to D using their real WPS mapping', async () => {
    const t = await setup();
    const generationNote = 'Codex gpt-image-2（CLIProxyAPI）：请求 2048×2048 / Medium；实际 PNG 1254×1254';
    t.generate.mockResolvedValue({ bytes: t.source, model: 'gpt-image-2', generationNote });
    const reference = url(await sample(true));
    const result = await prepareStandardArtwork({ ...t.request, generationPrompt: '保留图2的内容，制作完整平面图案，纯白背景（#FFFFFF）。', primaryImageLabel: '图2', instruction: '上方志愿者文字做扇形，下方加图二，后背排版和字体颜色参考图三', exactText: '志愿者', referenceImages: [{ label: '图3', image: { dataUrl: reference, mimeType: 'image/png', fileName: 'layout.png' } }] }, t.services);
    expect(result.draft.preprocessing.routingReport?.executedMethod).toBe('generate');
    expect(result.draft.preprocessing.routingReport?.model).toBe('gpt-image-2');
    expect(result.draft.preprocessing.routingReport?.operations).toContain(generationNote);
    expect(t.fidelity).not.toHaveBeenCalled();
    expect(t.generate).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('输入图2 = WPS 图3（参考素材）'), [t.request.image.dataUrl, reference], { background: 'auto' });
    expect(t.generate.mock.calls[0][0]).toContain('【原图具体内容】');
    expect(result.draft.graphic.sourceUrl).toBe(url(await sample(true)));
    expect(result.preprocessing).toMatchObject({ nativeOutput: false, modelLayoutPreserved: true, backgroundRemoval: 'product' });
    expect(t.services.cutout).toHaveBeenCalledExactlyOnceWith(t.source, { scene: 'product', crop: false });
  });
  it('uses A cutout for a usable source and never calls a generator', async () => {
    const t = await setup();
    const result = await prepareStandardArtwork(t.request, t.services);
    expect(t.fidelity.mock.calls[0][0].enhancementMode).toBe('none');
    expect(t.generate).not.toHaveBeenCalled();
    expect(result.draft.preprocessing?.routingReport).toMatchObject({ executedMethod: 'preserve', repair: null, source: { score: 90 }, graphic: { score: 90 } });
  });
  it('uses A for an original logo even with an authored full-image prompt', async () => {
    const t = await setup();
    const result = await prepareStandardArtwork({ ...t.request, generationPrompt: '保留图1的全部原图形、文字、颜色与排版，完整二维图案，纯白背景。' }, t.services);
    expect(t.generate).not.toHaveBeenCalled();
    expect(result.draft.preprocessing.routingReport?.executedMethod).toBe('preserve');
  });
  it('composes a recolored logo and exact ordinary text without a whole-image generation', async () => {
    const t = await setup();
    const result = await prepareStandardArtwork({ ...t.request, instruction: '保留图1，Logo 改为绿色，添加文字“poppy手机数码”。', exactText: 'poppy手机数码',
      generationPrompt: '保留图1手势并改为绿色，下方写“poppy手机数码”，纯白背景。' }, t.services);
    expect(t.generate).not.toHaveBeenCalled();
    expect(result.draft.preprocessing.routingReport?.executedMethod).toBe('compose');
    expect(result.draft.text?.value).toBe('poppy手机数码');
    expect(result.draft.graphic.recolor.mode).toBe('solid');
  });
  it.each([
    ['将图案原黑色统一改为图3所示的深蓝色。', '图3', '#234967'],
    ['左胸使用图一完整标识，保留原有图形、文字和排版，整体改为图二标志所示的绿色。', '图2', '#18ee09'],
  ])('applies the sampled color for %s without regenerating the logo', async (instruction, label, hex) => {
    const t = await setup();
    const receipt = { version: 'reference-pixels-v1' as const, label, hex, description: '参考图印花', sourceSha256: artworkSha256(t.source),
      region: { left: 10, top: 10, width: 30, height: 30 }, sampleImageSize: { width: 1200, height: 900 }, sampledPixels: 50, model: 'test-vision' };
    const resolveColor = vi.fn<StandardArtworkServices['resolveReferenceColor']>(async () => receipt);
    t.services.resolveReferenceColor = resolveColor;
    const reference = { label, image: { dataUrl: url(t.source), mimeType: 'image/png' as const, fileName: 'reference.png' } };
    const result = await prepareStandardArtwork({ ...t.request, instruction, referenceImages: [reference] }, t.services);
    expect(resolveColor).toHaveBeenCalledOnce();
    expect(resolveColor.mock.calls[0][0].referenceImages[0]).toEqual(reference);
    expect(t.generate).not.toHaveBeenCalled();
    expect(result.draft.graphic.recolor).toEqual({ mode: 'solid', color: hex });
    expect(result.draft.graphic.sourceUrl).toBe(url(await sample(true)));
    expect(result.draft.preprocessing.referenceColor).toEqual(receipt);
    expect(result.draft.preprocessing.routingReport?.operations.join(' ')).toContain(hex);
  });
  it('does not substitute a preset or start other paid work when reference color inspection fails', async () => {
    const t = await setup();
    t.services.resolveReferenceColor = vi.fn(async () => { throw new Error('参考图的目标颜色尚不能确定'); });
    await expect(prepareStandardArtwork({ ...t.request, instruction: '图案改成图2的深蓝色', referenceImages: [{ label: '图2', image: t.request.image }] }, t.services)).rejects.toThrow('尚不能确定');
    expect(t.measure).not.toHaveBeenCalled();
    expect(t.fidelity).not.toHaveBeenCalled();
    expect(t.generate).not.toHaveBeenCalled();
    expect(t.services.saveReport).not.toHaveBeenCalled();
  });
  it('does not redraw a manually preserved logo when repair is insufficient', async () => {
    const t = await setup([25, 30]);
    const result = await prepareStandardArtwork({ ...t.request, artworkMethod: 'preserve', generationPrompt: '保留图1原设计，纯白背景。' }, t.services);
    expect(t.fidelity).toHaveBeenCalledTimes(1);
    expect(t.generate).not.toHaveBeenCalled();
    expect(result.draft.preprocessing.routingReport?.executedMethod).toBe('preserve');
  });
  it('enhances a small subject once without inspecting its score', async () => {
    const t = await setup([47.62, 85]);
    const result = await prepareStandardArtwork({ ...t.request, printPlacement: undefined }, t.services);
    expect(t.fidelity).toHaveBeenCalledTimes(1);
    expect(t.fidelity.mock.calls[0][0].enhancementMode).toBe('professional');
    expect(t.inspect).not.toHaveBeenCalled();
    expect(t.generate).not.toHaveBeenCalled();
    expect(result.draft.preprocessing?.routingReport?.repair?.score).toBe(85);
  });
  it('carries executed edge repair into the saved evidence and user-visible draft', async () => {
    const t = await setup();
    const fidelity = t.services.fidelity;
    t.services.fidelity = async (...args) => {
      const prepared = await fidelity(...args);
      prepared.preprocessing.edgeRefinement = '圆形外沿净边（circular-edge-v1）';
      return prepared;
    };
    const result = await prepareStandardArtwork(t.request, t.services);
    expect(result.draft.preprocessing.edgeRefinement).toBe('圆形外沿净边（circular-edge-v1）');
    expect(result.draft.preprocessing.routingReport?.operations).toContain('圆形外沿净边（circular-edge-v1）');
    expect(t.generate).not.toHaveBeenCalled();
  });
  it('ignores a zero post-score and never repeats enhancement or redraws automatically', async () => {
    const t = await setup([90, 0]);
    const result = await prepareStandardArtwork(t.request, t.services);
    expect(t.fidelity.mock.calls.map(([request]) => request.enhancementMode)).toEqual(['none']);
    expect(t.generate).not.toHaveBeenCalled();
    expect(result.status).toBe('prepared');
    expect(result.draft.preprocessing.routingReport?.reviewReasons).toEqual([]);
  });
  it('enhances an undersized subject once, retains an insufficient output with a warning and never redraws', async () => {
    const t = await setup([91, 0]);
    const result = await prepareStandardArtwork({ ...t.request, printPlacement: { key: 'leftChest', sizeMode: 'widthCm', widthCm: 12.7 } }, t.services);
    expect(t.fidelity.mock.calls.map(([request]) => request.enhancementMode)).toEqual(['professional']);
    expect(t.generate).not.toHaveBeenCalled();
    expect(t.inspect).not.toHaveBeenCalled();
    expect(result.draft.preprocessing.routingReport?.contentReview?.warnings.join('')).toContain('细节');
    expect(result.status).toBe('prepared');
  });
  it('uses programmatic exact text for C without generating a new logo', async () => {
    const t = await setup();
    const result = await prepareStandardArtwork({ ...t.request, instruction: '保留图1，下方加文字', exactText: '工作服', layoutNote: '图上字下' }, t.services);
    expect(result.draft.preprocessing?.routingReport?.executedMethod).toBe('compose');
    expect(result.draft.text?.value).toBe('工作服');
    expect(t.generate).not.toHaveBeenCalled();
  });
  it('uses D only for a complete design and skips fidelity repair', async () => {
    const t = await setup();
    t.generate.mockResolvedValue({ bytes: await sample(true), model: 'gpt-image-2' });
    const result = await prepareStandardArtwork({ ...t.request, generationPrompt: '保留图1的内容，制作完整平面图案，纯白背景（#FFFFFF）。', instruction: '重新设计完整图案，保留品牌文字' }, t.services);
    expect(t.generate).toHaveBeenCalledTimes(1);
    expect(t.fidelity).not.toHaveBeenCalled();
    expect(result.draft.preprocessing?.routingReport?.executedMethod).toBe('generate');
    expect(result.draft.graphic.width / result.draft.graphic.height).toBeCloseTo(1200 / 900, 2);
  });
  it('generates only the special text components in C', async () => {
    const t = await setup();
    const result = await prepareStandardArtwork({ ...t.request, instruction: '保留图1，下方加书法文字', exactText: '工作服', layoutNote: '图上字下' }, t.services);
    expect(t.generate).toHaveBeenCalledTimes(1);
    expect(result.draft.preprocessing.routingReport?.executedMethod).toBe('compose');
    expect(result.draft.extraGraphics?.[0].textValue).toBe('工作服');
    expect(result.draft.graphic.y).toBeLessThan(result.draft.extraGraphics![0].y);
    expect(result.draft.graphic.x).toBe(result.draft.extraGraphics![0].x);
    expect(result.draft.graphic.sourceUrl).toBe(t.fidelity.mock.results[0] ? (await t.fidelity.mock.results[0].value).draft.graphic.sourceUrl : 'missing');
  });
  it('requires an explicit graphic colour edit instead of using a garment colour', async () => {
    const t = await setup();
    const ordinary = await prepareStandardArtwork({ ...t.request, instruction: '大红衣服，保留图1，下方加文字', exactText: '工作服' }, t.services);
    expect(ordinary.draft.graphic.recolor.mode).toBe('original');
    const recolored = await prepareStandardArtwork({ ...t.request, instruction: 'Logo改绿色' }, t.services);
    expect(recolored.draft.preprocessing.routingReport?.executedMethod).toBe('compose');
    expect(recolored.draft.graphic.recolor.mode).toBe('solid');
  });
  it('rejects mismatched prompts or ambiguous cropping before any paid call', async () => {
    const t = await setup();
    await expect(prepareStandardArtwork({ ...t.request, expectedPromptHash: 'fnv1a-00000000' }, t.services)).rejects.toThrow('不一致');
    await expect(prepareStandardArtwork({ ...t.request, instruction: '截取图1前三排' }, t.services)).rejects.toThrow('补齐');
    expect(t.measure).not.toHaveBeenCalled();
    expect(t.fidelity).not.toHaveBeenCalled();
  });
  it('binds explicit route choice to prompt identity and rejects incompatible strict requirements', async () => {
    const t = await setup();
    expect(standardArtworkPrompts(t.request).hash).not.toBe(standardArtworkPrompts({ ...t.request, processingRoute: 'model' }).hash);
    expect(artworkRequirementFacts({ ...t.request, instruction: '重新设计图案，禁止重绘' }).blockers.length).toBeGreaterThan(0);
    expect(redrawEligibility({ type: 'flat-logo', textReadable: true, graphicReadable: true, hasWhiteForeground: true, recognizedText: '', reasons: [] })).toBe('ineligible');
    expect(redrawEligibility({ type: 'flat-logo', textReadable: null, graphicReadable: true, hasWhiteForeground: false, recognizedText: '', reasons: [] })).toBe('unknown');
  });
});

describe('operator-selected artwork methods', () => {
  it.each([0, 95])('executes explicitly selected reconstruction without a quality prerequisite: %s', async score => {
    const t = await setup([score, score]);
    const result = await prepareStandardArtwork({ ...t.request, artworkMethod: 'redraw' }, t.services);
    expect(result.draft.preprocessing.routingReport?.executedMethod).toBe('redraw');
    expect(t.fidelity).not.toHaveBeenCalled();
    expect(t.inspect).not.toHaveBeenCalled();
    expect(t.generate).toHaveBeenCalledOnce();
  });
  it('rejects a preservation selection that would discard the requested text before processing', async () => {
    const t = await setup();
    await expect(prepareStandardArtwork({ ...t.request, artworkMethod: 'preserve', exactText: '工作服', instruction: '图1下方添加工作服' }, t.services)).rejects.toThrow('加字');
    expect(t.fidelity).not.toHaveBeenCalled();
    expect(t.generate).not.toHaveBeenCalled();
    expect(t.measure).not.toHaveBeenCalled();
  });
  it('binds the selected method to the reviewed prompt hash', async () => {
    const t = await setup();
    const prompt = standardArtworkPrompts({ ...t.request, artworkMethod: 'preserve' });
    await expect(prepareStandardArtwork({ ...t.request, artworkMethod: 'redraw', expectedPromptHash: prompt.hash }, t.services)).rejects.toThrow('不一致');
    expect(t.measure).not.toHaveBeenCalled();
  });
});


it('blocks legacy whole-image generation before paid measurement until a final prompt is prepared', async () => {
  const t = await setup();
  await expect(prepareStandardArtwork({ ...t.request, instruction: '重新设计完整图案', artworkMethod: 'generate' }, t.services)).rejects.toThrow('请先整理生图提示词');
  expect(t.measure).not.toHaveBeenCalled();
  expect(t.generate).not.toHaveBeenCalled();
  expect(t.services.cutout).not.toHaveBeenCalled();
});


const objectAssessment = { version: 'artwork-source-v1' as const, kind: 'artwork-on-object' as const,
  targetDescription: '图二衣袋上方的红色弧形中文和中心医疗标志', needsReconstruction: true,
  recognizedContent: { text: [], layout: '上方弧形文字', colors: ['红色'], structure: '医疗标志' },
  evidence: ['衣料上有蓝色花纹，红色刺绣受褶皱和透视影响'], uncertainDetails: ['原文字个别笔画不清'] };
function verifyReconstruction(t: Awaited<ReturnType<typeof setup>>, status: 'passed' | 'failed' | 'uncertain' = 'passed') {
  t.services.verifyEdits = vi.fn<StandardArtworkServices['verifyEdits']>(async (source, result, requirements) => ({
    version: 'artwork-edit-check-v1', sourceSha256: artworkSha256(source), outputSha256: artworkSha256(result), model: 'test',
    checks: requirements.map(requirement => ({ requirement, status, evidence: status === 'passed' ? '目标图案已还原，未残留衣料' : '原文字看不清' })),
  }));
}
describe('reconstruction of artwork photographed on objects', () => {
  it('flattens only explicit whole-design ink before verification and binds the saved result to those pixels', async () => {
    const t = await setup();
    const candidate = await sharp(Buffer.from('<svg width="1200" height="900"><defs><linearGradient id="y"><stop stop-color="#efb90e"/><stop offset="1" stop-color="#f4c322"/></linearGradient></defs><path fill="url(#y)" fill-rule="evenodd" d="M100 100h900v600H100z M300 300h300v200H300z"/><rect x="1050" y="100" width="20" height="200" fill="#eeb810"/></svg>')).png().toBuffer();
    t.services.cutout = vi.fn(async () => candidate);
    verifyReconstruction(t);
    const result = await prepareStandardArtwork({ ...t.request, sourceAssessment: objectAssessment,
      instruction: '仅提取原图案', layoutNote: '整组使用统一金黄色', generationPrompt: '完整保留标志和两行字，整组图案维持统一金黄色。' }, t.services);
    const output = Buffer.from(result.draft.graphic.sourceUrl.split(',')[1], 'base64');
    const before = await sharp(candidate).ensureAlpha().raw().toBuffer(), after = await sharp(output).ensureAlpha().raw().toBuffer();
    const colors = new Set<string>();
    for (let i = 0; i < before.length; i += 4) {
      if (before[i + 3] !== after[i + 3]) throw new Error(`Alpha changed at pixel ${i / 4}`);
      if (after[i + 3]) colors.add(after.subarray(i, i + 3).toString('hex'));
    }
    expect(colors.size).toBe(1);
    expect(t.services.verifyEdits).toHaveBeenCalledWith(t.source, output, expect.arrayContaining([expect.stringContaining('整组统一颜色')]));
    expect(result.draft.preprocessing.routingReport?.graphic.sha256).toBe(artworkSha256(output));
    expect(t.services.saveGeneration).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      solidColor: expect.objectContaining({ inputSha256: artworkSha256(candidate), outputSha256: artworkSha256(output) }),
    }));
  });
  it('reuses the historical model prompt on resume and reports it without claiming the new template generated the image', async () => {
    const t = await setup();
    verifyReconstruction(t);
    const originalPrompt = '历史生图提示词：从图1还原独立图案';
    t.services.resumeGenerationPrompt = vi.fn(async () => originalPrompt);
    const result = await prepareStandardArtwork({ ...t.request, sourceAssessment: objectAssessment }, t.services);
    expect(t.generate).toHaveBeenCalledWith(originalPrompt, [url(t.source)], { background: 'auto' });
    expect(t.services.saveGeneration).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ prompt: originalPrompt, promptHash: artworkPromptHash(originalPrompt) }));
    expect(result.draft.preprocessing.routingReport?.promptHash).toBe(artworkPromptHash(originalPrompt));
  });
  it('saves an editable draft with an honest warning when inspection is unavailable, without regenerating', async () => {
    const t = await setup();
    t.services.verifyEdits = vi.fn(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('private host'), { code: 'ECONNRESET' }) }); });
    const result = await prepareStandardArtwork({ ...t.request, sourceAssessment: objectAssessment }, t.services);
    const warnings = result.draft.preprocessing.routingReport?.contentReview?.warnings.join(' ');
    expect(warnings).toContain('自动核对未完成，请人工核查');
    expect(warnings).not.toContain('private');
    expect(t.generate).toHaveBeenCalledOnce();
    expect(t.services.saveReport).toHaveBeenCalledOnce();
  });
  it('inspects legacy source pixels, generates the target first, then cuts out only the generated artwork', async () => {
    const t = await setup();
    const generated = await sharp(t.source).resize(1000, 750).png().toBuffer();
    t.services.inspectSource = vi.fn(async () => objectAssessment);
    t.generate.mockResolvedValue({ bytes: generated, model: 'test' });
    verifyReconstruction(t);
    const submittedPrompt = standardArtworkPrompts(t.request);
    const result = await prepareStandardArtwork({ ...t.request, expectedPromptVersion: submittedPrompt.version, expectedPromptHash: submittedPrompt.hash }, t.services);
    expect(t.services.inspectSource).toHaveBeenCalledExactlyOnceWith(t.request.image.dataUrl, expect.any(String));
    expect(t.fidelity).not.toHaveBeenCalled();
    expect(t.inspect).not.toHaveBeenCalled();
    expect(t.generate).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('【B 原设计重建】'), [url(t.source)], { background: 'auto' });
    expect(t.services.cutout).toHaveBeenCalledExactlyOnceWith(generated, { scene: 'product', crop: false });
    expect(vi.mocked(t.services.cutout).mock.invocationCallOrder[0]).toBeGreaterThan(t.generate.mock.invocationCallOrder[0]);
    const report = result.draft.preprocessing.routingReport!;
    expect(report).toMatchObject({ executedMethod: 'redraw', graphicMethod: 'redraw', repair: null, facts: { sourceAssessment: objectAssessment }, redraw: { status: 'completed' } });
    expect(report.operations.join(' ')).toContain('保留原设计配色');
    expect(t.services.verifyEdits).toHaveBeenCalledWith(t.source, expect.any(Buffer), expect.arrayContaining([expect.stringContaining('去除载体不算图案内容丢失')]));
    expect(result.preprocessing.modelLayoutPreserved).toBe(true);
  });
  it('reuses current image analysis and rebuilds the C graphic before deterministic text composition', async () => {
    const t = await setup(); verifyReconstruction(t);
    const result = await prepareStandardArtwork({ ...t.request, sourceAssessment: objectAssessment, exactText: '新增文字', instruction: '保留图1并添加文字“新增文字”' }, t.services);
    expect(t.services.inspectSource).not.toHaveBeenCalled();
    expect(t.fidelity).not.toHaveBeenCalled();
    expect(t.generate).toHaveBeenCalledOnce();
    expect(t.generate.mock.calls[0][0]).not.toContain('新增文字');
    expect(result.draft.text?.value).toBe('新增文字');
    expect(result.draft.preprocessing.routingReport).toMatchObject({ executedMethod: 'compose', graphicMethod: 'redraw' });
  });
  it.each(['failed', 'uncertain'] as const)('saves a reviewable reconstruction despite %s inspection, without regenerating', async status => {
    const t = await setup(); verifyReconstruction(t, status);
    const result = await prepareStandardArtwork({ ...t.request, sourceAssessment: objectAssessment }, t.services);
    expect(result.status).toBe('prepared');
    expect(result.draft.preprocessing.routingReport!.contentReview!.warnings.length).toBeGreaterThan(0);
    expect(result.draft.preprocessing.routingReport!.contentReview!.verification!.checks[0].status).toBe(status);
    expect(t.generate).toHaveBeenCalledOnce();
    expect(t.fidelity).not.toHaveBeenCalled();
    expect(t.services.saveReport).toHaveBeenCalledOnce();
    expect(t.services.saveGeneration).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sourceAssessment: objectAssessment, status: 'prepared-with-warnings' }));
  });
  it('does not guess a source route if inspection cannot identify the target', async () => {
    const t = await setup();
    t.services.inspectSource = vi.fn(async () => ({ ...objectAssessment, kind: 'unknown' as const, needsReconstruction: null }));
    await expect(prepareStandardArtwork(t.request, t.services)).rejects.toThrow('尚不能确定');
    expect(t.generate).not.toHaveBeenCalled(); expect(t.fidelity).not.toHaveBeenCalled(); expect(t.services.cutout).not.toHaveBeenCalled();
  });
  it('respects explicit whole-image usage even when the source includes a logo on clothing', async () => {
    const t = await setup();
    const result = await prepareStandardArtwork({ ...t.request, sourceAssessment: objectAssessment, sourceScope: 'wholeImage' }, t.services);
    expect(t.services.inspectSource).not.toHaveBeenCalled(); expect(t.generate).not.toHaveBeenCalled();
    expect(result.draft.preprocessing.routingReport?.executedMethod).toBe('preserve');
  });
});
