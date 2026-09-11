import { beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { inspectArtworkReferenceImage } from './ark-task-review';
import { inspectArtworkWatermarks, verifyArtworkModelEdits, verifyArtworkTextComponent } from './artwork-content-inspection';
import { artworkSha256 } from './artwork-quality';

vi.mock('./ark-task-review', () => ({ inspectArtworkReferenceImage: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const source = () => sharp(Buffer.from('<svg width="400" height="300"><rect width="400" height="300" fill="white"/><rect x="70" y="50" width="200" height="180" fill="blue"/><text x="320" y="285" font-size="12">LABEL</text></svg>')).png().toBuffer();
const missing = [{ left: 320, top: 270, width: 60, height: 15 }];
function reply(body: unknown) { vi.mocked(inspectArtworkReferenceImage).mockResolvedValue({ content: JSON.stringify(body), model: 'test-vision', provider: 'cliproxy' }); }

it.each([
  ['generation-watermark', 'high', true, '豆包 AI 生成', 1],
  ['artwork', 'high', true, 'ZHOUNIANQINGDIAN', 0],
  ['generation-watermark', 'low', true, '豆包AI生成', 0],
  ['generation-watermark', 'high', false, '豆包AI生成', 0],
  ['generation-watermark', 'high', true, 'ACME © 2026', 0],
])('requires positive generator identification, not corner position: %s %s %s %s', async (kind, confidence, isolatedFromArtwork, text, count) => {
  reply({ groups: [{ index: 0, kind, confidence, isolatedFromArtwork, text }] });
  const result = await inspectArtworkWatermarks(await source(), missing);
  expect(result).toHaveLength(count);
  if (count) expect(result[0].bounds).toEqual(missing[0]);
});
it('does not infer watermark status for an empty loss report or a large lost subject', async () => {
  expect(await inspectArtworkWatermarks(await source(), [])).toEqual([]);
  expect(await inspectArtworkWatermarks(await source(), [{ left: 50, top: 50, width: 300, height: 200 }])).toEqual([]);
  expect(inspectArtworkReferenceImage).not.toHaveBeenCalled();
});
it('refuses duplicate or invented region IDs', async () => {
  reply({ groups: [{ index: 1, kind: 'generation-watermark', confidence: 'high', isolatedFromArtwork: true, text: '豆包AI生成' }] });
  await expect(inspectArtworkWatermarks(await source(), missing)).rejects.toThrow('对应');
});
it('binds every edit check to both actual images and downgrades low confidence instead of passing', async () => {
  const before = await source(), after = await sharp(before).modulate({ brightness: .9 }).png().toBuffer();
  reply({ checks: [{ index: 1, status: 'passed', confidence: 'low', sourceObservation: '蓝色', resultObservation: '蓝色', evidence: '底形看不清' },
    { index: 0, status: 'failed', confidence: 'high', sourceObservation: '红色描边', resultObservation: '红色描边', evidence: '描边仍为红色' }] });
  const result = await verifyArtworkModelEdits(before, after, ['红描边变蓝', '底形变浅']);
  expect(result).toMatchObject({ sourceSha256: artworkSha256(before), outputSha256: artworkSha256(after), checks: [
    { requirement: '红描边变蓝', status: 'failed' }, { requirement: '底形变浅', status: 'uncertain' },
  ] });
});
it('sends separate full frames without squashing small details into a comparison sheet', async () => {
  const before = await sharp({ create: { width: 1500, height: 700, channels: 3, background: '#1264a8' } }).png().toBuffer();
  const after = await sharp({ create: { width: 700, height: 1500, channels: 3, background: '#aa1020' } }).png().toBuffer();
  reply({ checks: [{ index: 0, status: 'failed', confidence: 'high', sourceObservation: '蓝色', resultObservation: '红色', evidence: '颜色不同' }] });
  const result = await verifyArtworkModelEdits(before, after, ['保留蓝色']);
  const input = vi.mocked(inspectArtworkReferenceImage).mock.calls[0][0];
  expect(typeof input).not.toBe('string');
  if (typeof input === 'string') throw new Error('Expected separate images');
  expect(input.map(image => image.label)).toEqual([expect.stringContaining('SOURCE'), expect.stringContaining('RESULT')]);
  const previews = input.map(image => Buffer.from(image.dataUrl.split(',')[1], 'base64'));
  expect(await sharp(previews[0]).metadata()).toMatchObject({ width: 1500, height: 700 });
  expect(await sharp(previews[1]).metadata()).toMatchObject({ width: 700, height: 1500 });
  expect((await sharp(previews[0]).raw().toBuffer()).equals(await sharp(before).raw().toBuffer())).toBe(true);
  expect(result).toMatchObject({ inspectionVersion: 'artwork-edit-inspection-v5', promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    inputSha256: previews.map(artworkSha256), sourceSha256: artworkSha256(before), outputSha256: artworkSha256(after) });
  expect(inspectArtworkReferenceImage).toHaveBeenCalledOnce();
});
it.each([null, undefined])('downgrades an unsupported high-confidence pass when an observation is %s', async sourceObservation => {
  reply({ checks: [{ index: 0, status: 'passed', confidence: 'high', sourceObservation, resultObservation: '文字完整', evidence: '已经符合要求' }] });
  const result = await verifyArtworkModelEdits(await source(), await source(), ['保留原有笔画']);
  expect(result.checks[0]).toMatchObject({ status: 'uncertain', evidence: expect.stringContaining('看不清') });
  expect(inspectArtworkReferenceImage).toHaveBeenCalledOnce();
});
it('rejects duplicated checks instead of leaving another requirement unchecked', async () => {
  reply({ checks: [0, 0].map(index => ({ index, status: 'passed', confidence: 'high', sourceObservation: '蓝色', resultObservation: '蓝色', evidence: '蓝色' })) });
  await expect(verifyArtworkModelEdits(await source(), await source(), ['文字保留', '标志保留'])).rejects.toThrow('逐项');
});
it('does not silently pass a missing customer requirement', async () => {
  reply({ checks: [{ index: 0, status: 'passed', confidence: 'high', evidence: '蓝色描边' }] });
  await expect(verifyArtworkModelEdits(await source(), await source(), ['描边改蓝', '底形调浅'])).rejects.toThrow('逐项');
});
it('uses interior pixels to downgrade an unsupported gradient claim without approving a wrong color', async () => {
  const bytes = await sharp(Buffer.from('<svg width="400" height="300"><rect x="20" y="20" width="360" height="260" fill="#cc1830"/></svg>')).png().toBuffer();
  reply({ checks: [
    { index: 0, status: 'failed', confidence: 'high', category: 'flatness', impact: 'material', sourceObservation: '原渐变', resultObservation: '仍有渐变', evidence: '仍有大片渐变' },
    { index: 1, status: 'failed', confidence: 'high', category: 'color', impact: 'material', sourceObservation: '蓝色', resultObservation: '红色', evidence: '蓝色变成红色' },
  ] });
  const result = await verifyArtworkModelEdits(bytes, bytes, ['渐变改纯色', '保留蓝色']);
  expect(result.flatnessEvidence?.status).toBe('within-tolerance');
  expect(result.checks[0]).toMatchObject({ status: 'uncertain', impact: 'minor' });
  expect(result.checks[1]).toMatchObject({ status: 'failed', impact: 'material' });
});
it('preserves transport causes for persisted step errors and allows 120 seconds for visual verification', async () => {
  vi.mocked(inspectArtworkReferenceImage).mockRejectedValue(new TypeError('fetch failed', { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) }));
  await expect(verifyArtworkModelEdits(await source(), await source(), ['整组统一黄色'])).rejects.toThrow('连接被中途断开');
  expect(vi.mocked(inspectArtworkReferenceImage).mock.calls[0][2]).toMatchObject({ timeoutMs: 120_000 });
  expect(inspectArtworkReferenceImage).toHaveBeenCalledOnce();
});

it.each([
  ['康悦', true, 'high', 'passed'],
  ['康悦', false, 'high', 'failed'],
  ['到家帮 康悦', true, 'high', 'failed'],
  ['康说', true, 'high', 'failed'],
  ['康悦', true, 'low', 'uncertain'],
  [null, true, 'high', 'uncertain'],
  ['康悦', null, 'high', 'uncertain'],
] as const)('checks actual text and graphics instead of trusting the layer label: %s %s %s', async (recognizedText, onlyText, confidence, status) => {
  reply({ recognizedText, onlyText, confidence, evidence: onlyText ? '图片中的文字' : '文字上方还有一个盾牌图形' });
  const bytes = await source();
  const result = await verifyArtworkTextComponent(bytes, '康悦');
  expect(result).toMatchObject({ status, outputSha256: artworkSha256(bytes), targetText: '康悦', recognizedText });
  expect(vi.mocked(inspectArtworkReferenceImage).mock.calls[0][1]).toContain('整张图');
});

it('rejects malformed content inspection instead of accepting it', async () => {
  reply({ recognizedText: '康悦', confidence: 'high', evidence: '没有返回是否夹带图形' });
  await expect(verifyArtworkTextComponent(await source(), '康悦')).rejects.toThrow();
});

it('transcribes without revealing the expected answer and compares punctuation and case in code', async () => {
  reply({ recognizedText: 'ACME-A8', onlyText: true, confidence: 'high', evidence: '读到 ACME-A8' });
  const result = await verifyArtworkTextComponent(await source(), 'Acme-A8');
  expect(result.status).toBe('failed');
  const [, prompt] = vi.mocked(inspectArtworkReferenceImage).mock.calls[0];
  expect(prompt).not.toContain('Acme-A8');
  expect(prompt).not.toContain('ACME-A8');
  expect(result).toMatchObject({ inspectionVersion: 'artwork-text-inspection-v2', promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
});
it('uses light and dark previews of transparent text without altering the candidate', async () => {
  const bytes = await sharp(Buffer.from('<svg width="240" height="80"><rect x="20" y="20" width="40" height="40" fill="white"/><rect x="100" y="20" width="40" height="40" fill="black"/></svg>')).png().toBuffer();
  const original = Buffer.from(bytes);
  reply({ recognizedText: 'AB', onlyText: true, confidence: 'high', evidence: '两种背景读到同样的 AB' });
  const result = await verifyArtworkTextComponent(bytes, 'AB');
  const input = vi.mocked(inspectArtworkReferenceImage).mock.calls[0][0];
  if (typeof input === 'string') throw new Error('Expected separate previews');
  expect(input).toHaveLength(2);
  const data = await Promise.all(input.map(image => sharp(Buffer.from(image.dataUrl.split(',')[1], 'base64')).raw().toBuffer()));
  expect([...data[0].subarray(0, 3)]).toEqual([255, 255, 255]);
  expect([...data[1].subarray(0, 3)]).toEqual([32, 32, 32]);
  expect(bytes).toEqual(original);
  expect(result.outputSha256).toBe(artworkSha256(original));
  expect(inspectArtworkReferenceImage).toHaveBeenCalledOnce();
});
