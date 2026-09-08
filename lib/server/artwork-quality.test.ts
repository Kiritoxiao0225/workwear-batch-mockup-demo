import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { artworkEvaluationInput, measureArtworkQuality, artworkSha256 } from '@/lib/server/artwork-quality';
import { originalFlatLogoPalette, cleanFlatLogo } from '@/lib/server/flat-logo-cleanup';
import { ARTWORK_ROUTING_STANDARD, artworkQualityPassed, decideArtworkMethod } from '@/lib/artwork-routing-standard';

describe('normalized artwork quality', () => {
  it('measures the same foreground at the same scale regardless of padding', async () => {
    const logo = await sharp(Buffer.from('<svg width="400" height="200"><rect width="400" height="200" fill="#b51235"/><circle cx="200" cy="100" r="70" fill="#343b40"/></svg>')).png().toBuffer();
    const padded = await sharp(logo).extend({ top: 100, bottom: 100, left: 300, right: 300, background: '#ffffff' }).png().toBuffer();
    // Explicit alpha avoids treating the full solid foreground rectangle itself as the background.
    const alphaLogo = await sharp(logo).ensureAlpha().extend({ top: 1, bottom: 1, left: 1, right: 1, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const paddedAlpha = await sharp(alphaLogo).extend({ top: 100, bottom: 100, left: 300, right: 300, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const first = await artworkEvaluationInput(alphaLogo), second = await artworkEvaluationInput(paddedAlpha);
    expect(first.bounds.width).toBe(400);
    expect(first.requiredScale).toBe(2.5);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect((await artworkEvaluationInput(padded)).bounds).toMatchObject({ width: 400, height: 200 });
    const metadata = await sharp(first.bytes).metadata();
    expect([metadata.width, metadata.height]).toEqual([1000, 500]);
  });
  it('preserves fractional scale and binds the score to the exact original bytes', async () => {
    const source = await sharp({ create: { width: 799, height: 500, channels: 4, background: '#b41235' } }).extend({ top: 20, bottom: 20, left: 20, right: 20, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const evaluate = vi.fn(async () => ({ blur: 15, vqscore: 62, noise: 40, compressionArtifacts: 20 }));
    const quality = await measureArtworkQuality(source, evaluate);
    expect(quality).toMatchObject({ score: 85, rawBlur: 15, vqscore: 62, sha256: artworkSha256(source), subjectWidth: 799 });
    expect(quality.requiredScale).toBeGreaterThan(1.25);
    expect(quality.requiredScale).toBeLessThan(1.26);
    await expect(measureArtworkQuality(source, async () => ({ blur: NaN, vqscore: 90, noise: null, compressionArtifacts: null }))).rejects.toThrow('无效');
  });
  it('replays the live clear/blurred control responses without rewarding added blur', async () => {
    // Same 999x1000 badge, 2026-09-07: current blur=2.56; Gaussian sigma 4 and 12 both blur=100.
    // Raw responses and request IDs: output/quality-direction-audit-20260907-171404/.
    const pixels = await sharp({ create: { width: 999, height: 1000, channels: 4, background: '#424477' } })
      .extend({ top: 1, bottom: 1, left: 1, right: 1, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const clear = await measureArtworkQuality(pixels, async () => ({ blur: 2.56, vqscore: 69.23, noise: 49.53, compressionArtifacts: 8.42 }));
    const blurred = await measureArtworkQuality(pixels, async () => ({ blur: 100, vqscore: 84.3, noise: 29.09, compressionArtifacts: 36.17 }));
    expect(clear).toMatchObject({ score: 97.44, rawBlur: 2.56, protocol: ARTWORK_ROUTING_STANDARD.scoreProtocol });
    expect(blurred).toMatchObject({ score: 0, rawBlur: 100 });
    expect(artworkQualityPassed(clear)).toBe(true);
    expect(artworkQualityPassed(blurred)).toBe(false);
    const facts = { intent: 'preserve' as const, intentReason: '沿用原校徽', sourcePresent: true, blockers: [], requiredScale: 1,
      repair: { attempts: 0, clarity: null, requiredScale: null }, redrawEligibility: 'unknown' as const, editSpecification: 'complete' as const, strictPreservation: false };
    expect(decideArtworkMethod({ ...facts, sourceClarity: clear }).action).toBe('clean');
    expect(decideArtworkMethod({ ...facts, sourceClarity: blurred }).action).toBe('repair-once');
  });
});

describe('guarded original-colour cleanup', () => {
  it('learns colours from this logo and clears enclosed holes without deleting fine marks', async () => {
    const source = await sharp(Buffer.from('<svg width="300" height="200"><rect width="300" height="200" fill="white"/><path d="M20 20h140v140H20z M50 50v80h80V50z" fill-rule="evenodd" fill="#125cab"/><rect x="180" y="40" width="80" height="120" fill="#356242"/><circle cx="278" cy="28" r="7" fill="#356242"/></svg>')).png().toBuffer();
    const palette = await originalFlatLogoPalette(source);
    expect(palette).toContainEqual([18, 92, 171]);
    expect(palette).toContainEqual([53, 98, 66]);
    const cleaned = await cleanFlatLogo(source, palette);
    const { data, info } = await sharp(cleaned).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
    expect(pixel(75, 75)[3]).toBe(0);
    expect(pixel(278, 28)).toEqual([53, 98, 66, 255]);
    await expect(cleanFlatLogo(source, [[255, 255, 255]])).rejects.toThrow('非白色');
  });
});
