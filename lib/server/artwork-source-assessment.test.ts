import { beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
vi.mock('./ark-task-review', () => ({ inspectArtworkReferenceImage: vi.fn() }));
import { inspectArtworkReferenceImage } from './ark-task-review';
import { inspectArtworkSourceAssessment } from './artwork-source-assessment';
const assessment = { version: 'artwork-source-v1', kind: 'artwork-on-object', targetDescription: '衣服上的弧形字和花形', needsReconstruction: true,
  selection: { scope: 'region', bounds: { left: 100, top: 200, right: 900, bottom: 600 } }, evidence: ['目标位于胸前'], uncertainDetails: ['弧形第2字看不清'],
  recognizedContent: { text: [{ order: 1, location: '弧形第2字', value: '待核查', certain: false }], colors: ['红色'], layout: '弧形', structure: '中心花形' }, defects: [] };
beforeEach(() => vi.resetAllMocks());
it('performs one original-pixel crop read, preserves source coordinates and keeps uncertain characters explicit', async () => {
  const bytes = await sharp({ create: { width: 800, height: 1000, channels: 3, background: 'white' } }).png().toBuffer();
  vi.mocked(inspectArtworkReferenceImage).mockResolvedValue({ content: JSON.stringify(assessment), model: 'test', provider: 'test' });
  const result = await inspectArtworkSourceAssessment(`data:image/png;base64,${bytes.toString('base64')}`, '提取原弧形字，保留所有文字');
  expect(inspectArtworkReferenceImage).toHaveBeenCalledTimes(2);
  const focused = vi.mocked(inspectArtworkReferenceImage).mock.calls[1][0] as string;
  expect(await sharp(Buffer.from(focused.split(',')[1], 'base64')).metadata()).toMatchObject({ width: 640, height: 400 });
  expect(result.selection).toEqual(assessment.selection);
  expect(result.recognizedContent?.text[0]).toMatchObject({ value: '待核查', certain: false });
});
it('retains the first observation with an honest warning when the focused read fails', async () => {
  const bytes = await sharp({ create: { width: 800, height: 1000, channels: 3, background: 'white' } }).png().toBuffer();
  vi.mocked(inspectArtworkReferenceImage).mockResolvedValueOnce({ content: JSON.stringify(assessment), model: 'test', provider: 'test' }).mockRejectedValueOnce(new Error('timeout'));
  const result = await inspectArtworkSourceAssessment(`data:image/png;base64,${bytes.toString('base64')}`, '原图案');
  expect(result.kind).toBe('artwork-on-object');
  expect(result.uncertainDetails.join('')).toContain('人工核查');
  expect(inspectArtworkReferenceImage).toHaveBeenCalledTimes(2);
});

it('inspects the actual image with the target requirement and preserves uncertainties without guessing characters', async () => {
  const source = { version: 'artwork-source-v1', kind: 'artwork-on-object', targetDescription: '衣物表面红色胸标',
    needsReconstruction: true, evidence: ['衣料褶皱穿过胸标'], uncertainDetails: ['首字看不清'] };
  vi.mocked(inspectArtworkReferenceImage).mockResolvedValue({ content: `\x60\x60\x60json\n${JSON.stringify(source)}\n\x60\x60\x60`, model: 'test', provider: 'cliproxy' });
  expect(await inspectArtworkSourceAssessment('data:image/png;base64,cGhvdG8=', '左胸：图二')).toEqual(source);
  expect(inspectArtworkReferenceImage).toHaveBeenCalledWith('data:image/png;base64,cGhvdG8=', expect.stringContaining('左胸：图二'), expect.any(Object));
});

it('does not substitute preservation for an invalid or failed inspection', async () => {
  vi.mocked(inspectArtworkReferenceImage).mockResolvedValue({ content: '{"kind":"flat-artwork"}', model: 'test', provider: 'cliproxy' });
  await expect(inspectArtworkSourceAssessment('image', '目标')).rejects.toThrow();
  vi.mocked(inspectArtworkReferenceImage).mockRejectedValue(new Error('inspection timeout'));
  await expect(inspectArtworkSourceAssessment('image', '目标')).rejects.toThrow('inspection timeout');
});

it('does not pass a guessed name or contradictory characters to generation', async () => {
  const { reconcileArtworkSourceAssessment, artworkReconstructionPrompt } = await import('../artwork-source-assessment');
  const { artworkSourceAssessmentSchema } = await import('../artwork-source-assessment');
  const initial = artworkSourceAssessmentSchema.parse({ ...assessment, targetDescription: '猜测的机构名称', recognizedContent: { ...assessment.recognizedContent, text: [{ order: 1, location: '第二字', value: '宁', certain: true }] } });
  const focused = artworkSourceAssessmentSchema.parse({ ...assessment, recognizedContent: { ...assessment.recognizedContent, text: [{ order: 1, location: '第二字', value: '大', certain: true }] } });
  const reconciled = reconcileArtworkSourceAssessment(initial, focused);
  expect(reconciled.recognizedContent?.text[0]).toMatchObject({ value: '待核查', certain: false });
  expect(reconciled.uncertainDetails.join('')).toContain('两次识别不一致');
  expect(artworkReconstructionPrompt(reconciled, '图2')).not.toContain('猜测的机构名称');
});
