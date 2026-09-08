import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createLegacyArtworkDraft } from '@/lib/artwork-editor';
import { parseArtworkPreparationRequest, type ArtworkPreparationResponse } from '@/lib/task-review-artwork';
import { artworkPromptHash, artworkRequirementFacts, standardArtworkPrompts } from '@/lib/artwork-routing-request';
import { prepareStandardArtwork, type StandardArtworkServices } from '@/lib/server/artwork-standard-pipeline';
import { measureArtworkQuality, artworkSha256 } from '@/lib/server/artwork-quality';
import { redrawEligibility, type RedrawInspection } from '@/lib/server/ark-artwork-processing';
import type { ArtworkProgressEvent } from '@/lib/artwork-progress';

const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
async function sample(transparent = false) {
  return sharp(Buffer.from(`<svg width="1200" height="900"><rect width="1200" height="900" fill="${transparent ? 'none' : 'white'}"/><path fill="#b41230" d="M100 100h900v300H100z M600 180v140h300V180z" fill-rule="evenodd"/><rect x="100" y="500" width="900" height="250" fill="#323b40"/></svg>`)).png().toBuffer();
}
async function setup(scores: number[] = [90, 90]) {
  const source = await sample(), prepared = await sample(true);
  const request = parseArtworkPreparationRequest({ instruction: '保留图1原图案', sourceRequirementText: '保留原图', image: { dataUrl: url(source), mimeType: 'image/png', fileName: 'test.png' }, enhancementMode: 'auto' });
  const measure = vi.fn(async (bytes: Buffer) => measureArtworkQuality(bytes, async () => ({ blur: 100 - (scores.shift() ?? 90), vqscore: 75, noise: 60, compressionArtifacts: 30 })));
  const fidelity = vi.fn(async (input: typeof request) => ({ status: 'prepared', draft: createLegacyArtworkDraft(url(prepared)), preprocessing: { enhancement: input.enhancementMode, backgroundRemoval: 'edge-connected' } } as ArtworkPreparationResponse));
  const generate = vi.fn<StandardArtworkServices['generate']>(async () => ({ bytes: source, model: 'test-seedream' }));
  const inspect = vi.fn(async (): Promise<RedrawInspection> => ({ type: 'flat-logo', textReadable: true, graphicReadable: true, hasWhiteForeground: false, recognizedText: '', reasons: ['测试图为平面纯色'] }));
  const services: StandardArtworkServices = { measure, fidelity, generate, inspect, cutout: vi.fn(async () => prepared), saveReport: vi.fn(), saveImage: vi.fn(), saveGeneration: vi.fn() };
  return { request, services, measure, fidelity, generate, inspect, source };
}

describe('executed artwork standard', () => {
  it('starts D generation alongside source scoring and exposes previews without skipping final quality', async () => {
    const t = await setup();
    const prepared = await sample(true);
    const sourceQuality = await t.measure(t.source), finalQuality = await t.measure(prepared);
    let releaseSource!: () => void, releaseCutout!: () => void, releaseFinal!: () => void;
    const sourceGate = new Promise<void>(resolve => { releaseSource = resolve; });
    const cutoutGate = new Promise<void>(resolve => { releaseCutout = resolve; });
    const finalGate = new Promise<void>(resolve => { releaseFinal = resolve; });
    t.measure.mockReset().mockImplementationOnce(async () => { await sourceGate; return sourceQuality; })
      .mockImplementationOnce(async () => { await finalGate; return finalQuality; });
    t.services.cutout = vi.fn(async () => { await cutoutGate; return prepared; });
    const events: ArtworkProgressEvent[] = [];
    const complete = vi.fn();
    const run = prepareStandardArtwork({ ...t.request, artworkMethod: 'generate', generationPrompt: '保留图1，整图生成，纯白背景。' }, t.services, event => events.push(event)).then(result => { complete(); return result; });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'preview')).toHaveLength(1));
    expect(t.generate).toHaveBeenCalledOnce();
    expect(t.measure).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    releaseSource();
    await vi.waitFor(() => expect(t.services.cutout).toHaveBeenCalledOnce());
    releaseCutout();
    await vi.waitFor(() => expect(events.filter(event => event.type === 'preview')).toHaveLength(2));
    expect(complete).not.toHaveBeenCalled();
    releaseFinal();
    const result = await run;
    expect(result.draft.graphic.sourceUrl).toBe(url(prepared));
    expect(result.preprocessing.timings?.map(timing => timing.stage).sort()).toEqual(['cutout', 'generation', 'resultQuality', 'sourceQuality']);
    expect(events.some(event => event.type === 'progress' && event.generationFinished)).toBe(true);
  });

  it('preserves the paid model original when concurrent source scoring fails, without retry', async () => {
    const t = await setup();
    t.measure.mockRejectedValue(new Error('source scoring unavailable'));
    const rejected = await prepareStandardArtwork({ ...t.request, artworkMethod: 'generate', generationPrompt: '保留图1，整图生成，纯白背景。' }, t.services).catch(error => error);
    expect(rejected.candidate.url).toBe(url(t.source));
    expect(t.generate).toHaveBeenCalledOnce();
    expect(t.services.cutout).not.toHaveBeenCalled();
    expect(t.services.saveGeneration).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: 'needs-review' }));
    expect(t.services.saveReport).not.toHaveBeenCalled();
  });
  it('generates a white image then uses the cutout PNG with the model layout and white interiors preserved', async () => {
    const t = await setup();
    const original = await sharp(Buffer.from('<svg width="1200" height="1200"><circle cx="600" cy="600" r="280" fill="white" stroke="red" stroke-width="20"/><path fill="red" d="M500 500h200v200H500z"/><rect x="150" y="70" width="850" height="50" fill="#ffcc00"/><rect x="150" y="1060" width="850" height="50" fill="#ffcc00"/></svg>')).png().toBuffer();
    const whiteOriginal = await sharp(original).flatten({ background: '#ffffff' }).png().toBuffer();
    t.generate.mockResolvedValue({ bytes: whiteOriginal, model: 'gpt-image-2' });
    t.services.cutout = vi.fn(async () => original);
    const result = await prepareStandardArtwork({ ...t.request, generationPrompt: '保留图1的内容，制作完整平面图案，纯白背景（#FFFFFF）。', artworkMethod: 'generate', instruction: '制作新的完整图案' }, t.services);
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
    expect(t.generate).toHaveBeenCalledExactlyOnceWith('【输入图片对应关系】正文图号均为 WPS 原图号。\n输入图1 = WPS 图2（内容素材）\n输入图2 = WPS 图3（参考素材）\n\n保留图2的内容，制作完整平面图案，纯白背景（#FFFFFF）。', [t.request.image.dataUrl, reference], { background: 'auto' });
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
  it('does not redraw a manually preserved logo when repair is insufficient', async () => {
    const t = await setup([25, 30]);
    const result = await prepareStandardArtwork({ ...t.request, artworkMethod: 'preserve', generationPrompt: '保留图1原设计，纯白背景。' }, t.services);
    expect(t.fidelity).toHaveBeenCalledTimes(1);
    expect(t.generate).not.toHaveBeenCalled();
    expect(result.draft.preprocessing.routingReport?.executedMethod).toBe('preserve');
  });
  it('repairs once and stops when the repaired graphic passes', async () => {
    const t = await setup([47.62, 85]);
    const result = await prepareStandardArtwork(t.request, t.services);
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
  it('repairs a cutout that deteriorated even if the source passed', async () => {
    const t = await setup([90, 62, 88]);
    const result = await prepareStandardArtwork(t.request, t.services);
    expect(t.fidelity.mock.calls.map(([request]) => request.enhancementMode)).toEqual(['none', 'professional']);
    expect(result.draft.preprocessing?.routingReport?.repair?.score).toBe(88);
    expect(t.generate).not.toHaveBeenCalled();
  });
  it('uses exactly one B redraw after failed repair and a positive source check', async () => {
    const t = await setup([47, 63, 91]);
    t.inspect.mockResolvedValue({ type: 'flat-logo', textReadable: true, graphicReadable: true, hasWhiteForeground: false, recognizedText: '测试', structureDescription: '红色图块在灰色横条上方', reasons: [] });
    const generate = vi.fn<StandardArtworkServices['generate']>(async () => ({ bytes: t.source, model: 'test-seedream' }));
    t.services.generate = generate;
    const result = await prepareStandardArtwork(t.request, t.services);
    const report = result.draft.preprocessing!.routingReport!;
    expect(t.fidelity).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ executedMethod: 'redraw', repair: { score: 63 }, graphic: { score: 91 }, reviewReasons: [] });
    expect(report.graphic.sha256).toBe(artworkSha256(Buffer.from(result.draft.graphic.sourceUrl.split(',')[1], 'base64')));
    const [prompt, images] = generate.mock.calls[0];
    expect(prompt).toContain('#B41230');
    expect(prompt).toContain('#323B40');
    expect(prompt).toContain('测试');
    expect(prompt).toContain('红色图块在灰色横条上方');
    const modelInput = Buffer.from(images[0].split(',')[1], 'base64');
    expect(await sharp(modelInput).metadata()).toMatchObject({ format: 'png', width: 972, height: 722 });
    expect(report.redraw).toMatchObject({ status: 'completed', stage: 'measurement', model: 'test-seedream', inputSha256: artworkSha256(modelInput), promptHash: artworkPromptHash(prompt) });
    expect(report.promptHash).toBe(artworkPromptHash(prompt));
    expect(result.draft.preprocessing.promptHash).toBe(report.promptHash);
  });
  it.each(['photo', 'gradient', 'unknown'] as const)('does not redraw %s after repair fails', async type => {
    const t = await setup([47, 60]);
    t.inspect.mockResolvedValue({ type, textReadable: true, graphicReadable: true, hasWhiteForeground: false, recognizedText: '', reasons: [] });
    const result = await prepareStandardArtwork(t.request, t.services);
    expect(t.generate).not.toHaveBeenCalled();
    expect(result.draft.preprocessing?.routingReport?.reviewReasons.length).toBeGreaterThan(0);
  });
  it('does not redraw strictly preserved artwork', async () => {
    const t = await setup([47, 60]);
    await prepareStandardArtwork({ ...t.request, processingRoute: 'fidelity' }, t.services);
    expect(t.inspect).not.toHaveBeenCalled();
    expect(t.generate).not.toHaveBeenCalled();
  });
  it('keeps the measured A candidate if B post-measurement fails and does not retry', async () => {
    const t = await setup([47, 60]);
    const ordinaryMeasure = t.services.measure;
    let calls = 0;
    t.services.measure = async bytes => { if (++calls === 3) throw new Error('test score timeout'); return ordinaryMeasure(bytes); };
    const result = await prepareStandardArtwork(t.request, t.services);
    const report = result.draft.preprocessing!.routingReport!;
    expect(t.generate).toHaveBeenCalledTimes(1);
    expect(report.executedMethod).toBe('preserve');
    expect(report.graphic.sha256).toBe(artworkSha256(Buffer.from(result.draft.graphic.sourceUrl.split(',')[1], 'base64')));
    expect(report.reviewReasons.join(' ')).toContain('不自动重试');
    expect(report.redraw).toMatchObject({ status: 'failed', stage: 'measurement', model: 'test-seedream', error: 'test score timeout' });
    expect(report.decision).toMatchObject({ state: 'review', action: 'review' });
    expect(report.decision.reason).toContain('当前显示 A 保真候选');
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
  it('executes a selected redraw only after failed repair and source eligibility checks', async () => {
    const t = await setup([47, 60, 91]);
    const result = await prepareStandardArtwork({ ...t.request, artworkMethod: 'redraw' }, t.services);
    expect(result.draft.preprocessing.routingReport?.executedMethod).toBe('redraw');
    expect(t.fidelity).toHaveBeenCalledTimes(1);
    expect(t.inspect).toHaveBeenCalledTimes(1);
    expect(t.generate).toHaveBeenCalledTimes(1);
  });
  it('does not substitute A silently when the operator selected B', async () => {
    const t = await setup([90, 90]);
    await expect(prepareStandardArtwork({ ...t.request, artworkMethod: 'redraw' }, t.services)).rejects.toThrow('未执行重绘');
    expect(t.generate).not.toHaveBeenCalled();
    expect(t.services.saveReport).not.toHaveBeenCalled();
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
