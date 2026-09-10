import { beforeEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { inspectArtworkReferenceImage } from './ark-task-review';
import { inspectArtworkWatermarks, verifyArtworkModelEdits } from './artwork-content-inspection';
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
  reply({ checks: [{ index: 1, status: 'passed', confidence: 'low', evidence: '底形看不清' }, { index: 0, status: 'failed', confidence: 'high', evidence: '描边仍为红色' }] });
  const result = await verifyArtworkModelEdits(before, after, ['红描边变蓝', '底形变浅']);
  expect(result).toMatchObject({ sourceSha256: artworkSha256(before), outputSha256: artworkSha256(after), checks: [
    { requirement: '红描边变蓝', status: 'failed' }, { requirement: '底形变浅', status: 'uncertain' },
  ] });
});
it('does not silently pass a missing customer requirement', async () => {
  reply({ checks: [{ index: 0, status: 'passed', confidence: 'high', evidence: '蓝色描边' }] });
  await expect(verifyArtworkModelEdits(await source(), await source(), ['描边改蓝', '底形调浅'])).rejects.toThrow('逐项');
});
