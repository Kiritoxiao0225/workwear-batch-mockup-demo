import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLegacyArtworkDraft } from '@/lib/artwork-editor';
import { artworkQualityFixture } from '@/lib/testing/artwork-quality-fixture';
import { artworkSha256, measureArtworkQuality } from '@/lib/server/artwork-quality';
import { validateProductionArtworkDraft, validateProductionArtworkQuality } from '@/lib/server/production-artwork-quality';
import { readArtworkRoutingReport } from '@/lib/server/artwork-routing-records';
import { artworkAcceptanceIssues } from '@/lib/artwork-acceptance';
import type { ArtworkRoutingReport } from '@/lib/artwork-routing-standard';

vi.mock('@/lib/server/artwork-routing-records', () => ({ readArtworkRoutingReport: vi.fn() }));
vi.mock('@/lib/server/artwork-quality', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/server/artwork-quality')>(),
  measureArtworkQuality: vi.fn(async () => { throw new Error('External quality calls are forbidden in this test'); }),
}));
const files: string[] = [];
afterEach(async () => { await Promise.all(files.splice(0).map(file => unlink(file))); vi.clearAllMocks(); });
async function savedLogo(color = '#b42244') {
  const bytes = await sharp(Buffer.from(`<svg width="1200" height="1000"><rect x="100" y="100" width="1000" height="800" fill="${color}"/></svg>`)).png().toBuffer();
  const name = `quality-integration-${randomUUID()}.png`;
  const file = path.join(process.cwd(), 'public/uploads/logos', name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes); files.push(file);
  return { bytes, url: `/uploads/logos/${name}`, sha: artworkSha256(bytes) };
}
describe('server-verified final PNG quality', () => {
  it('evaluates the actual saved file and retains a usable transparent candidate if the quality service fails', async () => {
    const logo = await savedLogo();
    const draft = createLegacyArtworkDraft(logo.url);
    const measure = vi.fn(async (bytes: Buffer) => artworkQualityFixture(artworkSha256(bytes)));
    const result = await validateProductionArtworkQuality(logo.url, draft, measure);
    expect(result.validation.quality?.sha256).toBe(logo.sha);
    expect(result.validation.componentQuality?.[0].measurement.sha256).toBe(logo.sha);
    expect(artworkAcceptanceIssues(result.validation)).toEqual([]);
    const failed = await validateProductionArtworkQuality(logo.url, draft, async () => { throw new Error('service unavailable'); });
    expect(failed.validation.valid).toBe(true);
    expect(failed.validation.qualityError).toContain('service unavailable');
    expect(failed.draft?.graphic.sourceUrl).toBe(logo.url);
    expect(artworkAcceptanceIssues(failed.validation)).toEqual([]);
  });
  it('replaces forged client scores with persisted server evidence and blocks a low quality component', async () => {
    const logo = await savedLogo();
    const draft = createLegacyArtworkDraft(logo.url);
    const report = { runId: randomUUID(), version: 'artwork-routing-v1', graphic: artworkQualityFixture(logo.sha, { score: 60 }), reviewReasons: [] } as unknown as ArtworkRoutingReport;
    vi.mocked(readArtworkRoutingReport).mockResolvedValue(report);
    draft.preprocessing.routingReport = { ...report, graphic: { ...report.graphic, score: 100 } };
    const measured = await validateProductionArtworkQuality(logo.url, draft, async bytes => artworkQualityFixture(artworkSha256(bytes)));
    expect(measured.validation.quality?.score).toBe(90);
    expect(measured.draft?.preprocessing.routingReport?.graphic.score).toBe(60);
    expect(measured.validation.qualityIssues?.join(' ')).toContain('60.00');
    expect(artworkAcceptanceIssues(measured.validation)).toEqual([]);
  });
  it('does not reuse a run report for edited component bytes', async () => {
    const logo = await savedLogo();
    const draft = createLegacyArtworkDraft(logo.url);
    const report = { runId: randomUUID(), version: 'artwork-routing-v1', graphic: artworkQualityFixture('old-pixels'), reviewReasons: [] } as unknown as ArtworkRoutingReport;
    vi.mocked(readArtworkRoutingReport).mockResolvedValue(report);
    draft.preprocessing.routingReport = report;
    const measured = await validateProductionArtworkQuality(logo.url, draft, async bytes => artworkQualityFixture(artworkSha256(bytes)));
    expect(measured.draft?.preprocessing.routingReport).toBeUndefined();
    expect(measured.validation.componentQuality?.[0].measurement.sha256).toBe(logo.sha);
  });
  it('remeasures old reversed component scores, preserving history and non-score review issues', async () => {
    const logo = await savedLogo();
    const draft = createLegacyArtworkDraft(logo.url);
    const report = { runId: randomUUID(), version: 'artwork-routing-v1',
      graphic: artworkQualityFixture(logo.sha, { score: 3.33, protocol: 'foreground-white-1000-v1' }),
      reviewReasons: ['净边后主体清晰度 3.33 / 80；目标放大 1.96 倍，仍需画质核对', '高清重绘未完成：供应商拒绝；当前保留 A 候选'] } as unknown as ArtworkRoutingReport;
    vi.mocked(readArtworkRoutingReport).mockResolvedValue(report);
    draft.preprocessing.routingReport = report;
    const measure = vi.fn(async (bytes: Buffer) => artworkQualityFixture(artworkSha256(bytes), { score: 96.67, rawBlur: 3.33 }));
    const measured = await validateProductionArtworkQuality(logo.url, draft, measure);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measured.validation.componentQuality?.[0].measurement.score).toBe(96.67);
    expect(measured.validation.qualityIssues).toEqual(['高清重绘未完成：供应商拒绝；当前保留 A 候选']);
    expect(measured.draft?.preprocessing.routingReport?.graphic.score).toBe(3.33);
  });

  it('saves editable PNG layers without cloud scoring, keeping trusted component evidence for later', async () => {
    const logo = await savedLogo(), hidden = await savedLogo('#009900');
    const draft = createLegacyArtworkDraft(logo.url);
    draft.extraGraphics = [{ ...draft.graphic, id: 'hidden', sourceUrl: hidden.url, visible: false }];
    const previous = (await validateProductionArtworkQuality(logo.url, draft, async bytes => artworkQualityFixture(artworkSha256(bytes)))).validation;
    const saved = await validateProductionArtworkDraft(logo.url, draft, previous);
    expect(measureArtworkQuality).not.toHaveBeenCalled();
    expect(saved.draft).toEqual(draft);
    expect(saved.validation.valid).toBe(true);
    expect(saved.validation.quality).toBeUndefined();
    expect(saved.validation.componentQuality).toEqual(previous.componentQuality);
    expect(artworkAcceptanceIssues(saved.validation)).toEqual([]);
  });

  it('rejects missing hidden layers and browser-only masks before saving the draft', async () => {
    const logo = await savedLogo();
    const draft = createLegacyArtworkDraft(logo.url);
    draft.extraGraphics = [{ ...draft.graphic, id: 'hidden', sourceUrl: '/uploads/logos/missing-layer.png', visible: false }];
    await expect(validateProductionArtworkDraft(logo.url, draft)).rejects.toThrow();
    draft.extraGraphics = [];
    draft.graphic.recolorMaskUrl = 'blob:unsaved-mask';
    await expect(validateProductionArtworkDraft(logo.url, draft)).rejects.toThrow('不支持');
    expect(measureArtworkQuality).not.toHaveBeenCalled();
  });

  it('reuses unchanged passing components after an edited PNG, but rechecks changed, failed and old-protocol pixels', async () => {
    const logo = await savedLogo(), edited = await savedLogo('#002244');
    const draft = createLegacyArtworkDraft(logo.url);
    const previous = (await validateProductionArtworkQuality(logo.url, draft, async bytes => artworkQualityFixture(artworkSha256(bytes)))).validation;
    const measure = vi.fn(async (bytes: Buffer) => artworkQualityFixture(artworkSha256(bytes)));
    const saved = await validateProductionArtworkDraft(edited.url, draft, previous);
    const checked = await validateProductionArtworkQuality(edited.url, draft, measure, saved.validation);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure.mock.calls[0][0]).toEqual(edited.bytes);
    expect(checked.validation.componentQuality).toEqual(previous.componentQuality);
    for (const measurement of [
      artworkQualityFixture(logo.sha, { score: 60 }),
      artworkQualityFixture(logo.sha, { protocol: 'foreground-white-1000-v1' }),
      artworkQualityFixture('changed-sha'),
    ]) {
      measure.mockClear();
      const stale = { ...previous, componentQuality: [{ id: draft.graphic.id!, measurement }] };
      await validateProductionArtworkQuality(edited.url, draft, measure, stale);
      expect(measure).toHaveBeenCalledTimes(2);
    }
  });
});
