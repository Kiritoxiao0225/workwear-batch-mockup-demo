import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { parseArtworkPreparationRequest } from '@/lib/task-review-artwork';
import { artworkQualityFixture } from '@/lib/testing/artwork-quality-fixture';
import { artworkSha256 } from './artwork-quality';
import { prepareStandardArtwork, standardArtworkServices, type StandardArtworkServices } from './artwork-standard-pipeline';

describe('reference-only lettering through the model pipeline', () => {
  it('sends every input only as reference and saves the generated cutout without extracting source graphics', async () => {
    const source = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#db314f' } }).png().toBuffer();
    const output = await sharp(Buffer.from('<svg width="1000" height="600"><rect x="100" y="100" width="800" height="300" fill="black"/></svg>')).png().toBuffer();
    const whiteOutput = await sharp(output).flatten({ background: '#fff' }).png().toBuffer();
    const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
    const request = parseArtworkPreparationRequest({
      image: { dataUrl: dataUrl(source), mimeType: 'image/png', fileName: 'reference.png' },
      primaryImageLabel: '图2', primaryImageRole: 'reference',
      referenceImages: [{ label: '图1', image: { dataUrl: dataUrl(source), mimeType: 'image/png', fileName: 'second-reference.png' } }],
      instruction: '按图2的样式制作 XJY 与享聚源，排版参考图1。', exactText: 'XJY\n享聚源',
      sourceRequirementText: '左胸:XJY 享聚源，参考图2样式及图1排版',
      generationPrompt: '文字 XJY 与享聚源，按照图2字形和图1排版。不得复制参考图中的人物、衣服与原文字，纯白背景。',
    });
    const generate = vi.fn<StandardArtworkServices['generate']>(async () => ({ bytes: whiteOutput, model: 'test-image-model' }));
    const fidelity = vi.fn<StandardArtworkServices['fidelity']>();
    const cutout = vi.fn<StandardArtworkServices['cutout']>(async () => output);
    const saveGeneration = vi.fn<StandardArtworkServices['saveGeneration']>();
    const verifyEdits = vi.fn<StandardArtworkServices['verifyEdits']>();
    const result = await prepareStandardArtwork(request, { ...standardArtworkServices, generate, fidelity, cutout, saveGeneration, verifyEdits,
      measure: vi.fn(async bytes => artworkQualityFixture(artworkSha256(bytes))),
      inspect: vi.fn(), saveImage: vi.fn(), saveReport: vi.fn(), resolveReferenceColor: vi.fn(),
    });
    expect(generate).toHaveBeenCalledOnce();
    const [prompt, images] = generate.mock.calls[0];
    expect(prompt).toContain('输入图1 = WPS 图2（参考素材）');
    expect(prompt).toContain('输入图2 = WPS 图1（参考素材）');
    expect(prompt).not.toContain('内容素材');
    expect(images).toHaveLength(2);
    expect(fidelity).not.toHaveBeenCalled();
    expect(verifyEdits).not.toHaveBeenCalled();
    expect(cutout).toHaveBeenCalledOnce();
    expect(cutout.mock.calls[0][0]).toEqual(whiteOutput);
    expect(result.preprocessing.modelLayoutPreserved).toBe(true);
    expect(result.draft.graphic.sourceUrl).toBe(dataUrl(output));
    expect(result.preprocessing.componentPlan.summary.join()).not.toContain('必须进入成品的主体');
    expect(saveGeneration).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ imageMapping: [expect.objectContaining({ role: 'reference' }), expect.objectContaining({ role: 'reference' })] }));
  });
});
