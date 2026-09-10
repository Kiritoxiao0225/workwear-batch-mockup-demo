import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArtworkPreparationRequest } from '@/lib/task-review-artwork';
import { prepareStandardArtwork, standardArtworkServices } from './artwork-standard-pipeline';
import { artworkSha256, measureArtworkQuality } from './artwork-quality';
import { inspectArtworkSource, removeFlatArtworkBackground } from './artwork-image-processing';
import { ArtworkCutoutPendingError } from './artwork-cutout';
import { prepareTaskArtwork } from './media-kit-artwork';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function setup(width = 782, score = 90) {
  // The canvas is large, but the narrow artwork (including white strokes) is not.
  const source = await sharp(Buffer.from(`<svg width="1500" height="762"><rect width="1500" height="762" fill="#00000a"/>
    <path d="M300 300h${width}v20H300z M300 420h${width}v34H300z" fill="#00ff00"/>
    <path d="M500 330h1v70h-1z M550 350h${width - 250}v2H550z" fill="white"/></svg>`)).png().toBuffer();
  const request = parseArtworkPreparationRequest({ instruction: '保留图1完整标识、原文字和配色，去除背景', sourceRequirementText: '后背使用图1',
    image: { dataUrl: `data:image/png;base64,${source.toString('base64')}`, mimeType: 'image/png', fileName: 'logo.png' }, enhancementMode: 'auto' });
  const events: string[] = [];
  let uploaded: Buffer;
  let enhanced: Buffer;
  vi.stubEnv('MEDIAKIT_API_KEY', 'test-key');
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url);
    if (address.endsWith('/request-media-upload-url')) return Response.json({ success: true, result: { upload_url: 'https://test.invalid/upload', file_id: 'mediakit://original' } });
    if (address === 'https://test.invalid/upload') { uploaded = Buffer.from(init!.body as Uint8Array); return new Response(null, { status: 200 }); }
    if (address.endsWith('/enhance-image')) {
      events.push('enhance');
      expect(JSON.parse(init!.body as string)).toMatchObject({ tool_version: 'professional', multiple: 2, generative_enhance_mode: 'fidelity_first' });
      const metadata = await sharp(uploaded).metadata();
      // Simulates a provider response to test orchestration, not actual AI quality.
      enhanced = await sharp(uploaded).resize(metadata.width! * 2, metadata.height! * 2).png().toBuffer();
      return Response.json({ success: true, result: { image_url: 'https://test.invalid/enhanced' } });
    }
    if (address === 'https://test.invalid/enhanced') { events.push('enhancement-downloaded'); return new Response(new Uint8Array(enhanced)); }
    throw new Error(`Unexpected network call: ${address}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const measure = vi.fn(async (bytes: Buffer) => {
    const first = !events.includes('source-quality');
    events.push(first ? 'source-quality' : 'result-quality');
    return measureArtworkQuality(bytes, async () => ({ blur: 100 - (first ? score : 90), vqscore: 90, noise: 90, compressionArtifacts: 0 }));
  });
  const cutout = vi.fn(async (bytes: Buffer) => {
    events.push('cutout');
    const profile = await inspectArtworkSource(bytes);
    expect(profile.transparentRatio).toBe(0);
    return removeFlatArtworkBackground(bytes, profile.backgroundColor!);
  });
  const services = { ...standardArtworkServices, measure, cutout,
    inspectSource: vi.fn<typeof standardArtworkServices.inspectSource>(async () => ({ version: 'artwork-source-v1', kind: 'flat-artwork', targetDescription: '独立平面图案', needsReconstruction: false, evidence: ['测试输入为独立平面图稿'], uncertainDetails: [] })), saveImage: vi.fn(), saveReport: vi.fn(),
    generate: vi.fn(async () => { throw new Error('Unexpected generation'); }),
    inspect: vi.fn(async () => { throw new Error('Unexpected redraw inspection'); }) };
  return { source, request, services, measure, cutout, events, fetcher };
}

describe('production enhancement before cutout', () => {
  it.each([[782, 90], [900, 79]])('enhances before cutout for subject width %i and clarity %i', async (width, score) => {
    const t = await setup(width, score);
    const result = await prepareStandardArtwork(t.request, t.services);
    expect(t.events).toEqual(['source-quality', 'enhance', 'enhancement-downloaded', 'cutout', 'result-quality']);
    expect(t.measure.mock.calls[0][0]).toEqual(t.source);
    const originalQuality = await t.measure.mock.results[0].value;
    expect(originalQuality.subjectWidth).toBe(width);
    expect(originalQuality.requiredScale).toBeCloseTo(1000 / width);
    const cutoutInput = t.cutout.mock.calls[0][0];
    expect(artworkSha256(cutoutInput)).not.toBe(artworkSha256(t.source));
    expect((await sharp(cutoutInput).metadata()).width).toBeGreaterThan(width * 2);
    expect(result.preprocessing.enhancement).toBe('professional');
    expect(result.draft.preprocessing.routingReport?.repair?.score).toBe(90);
    expect(t.services.generate).not.toHaveBeenCalled();
  });

  it('keeps the 80-point and 1.25-scale inclusive boundaries without enhancement', async () => {
    const t = await setup(800, 80);
    const result = await prepareStandardArtwork(t.request, t.services);
    expect(t.events).toEqual(['source-quality', 'cutout', 'result-quality']);
    expect(t.cutout).toHaveBeenCalledExactlyOnceWith(t.source, undefined);
    expect(result.preprocessing.enhancement).toBe('none');
    expect(result.draft.preprocessing.routingReport?.repair).toBeNull();
  });

  it('retains the cutout failure after enhancement without saving a finished artwork or retrying', async () => {
    const t = await setup();
    t.cutout.mockImplementation(async bytes => {
      t.events.push('cutout');
      throw new ArtworkCutoutPendingError({ status: 'failed', error: '抠图结果疑似丢失文字', receipt: {
        jobKey: 'a'.repeat(64), version: 'artwork-cutout-v4', mode: 'auto', route: 'meitu', cacheHit: false,
        sourceSha256: artworkSha256(bytes), sourceUrl: `data:image/png;base64,${bytes.toString('base64')}`,
        reasons: [], estimatedCredits: 1, actualCredits: 1,
      } });
    });
    await expect(prepareStandardArtwork(t.request, t.services)).rejects.toThrow('疑似丢失文字');
    expect(t.events).toEqual(['source-quality', 'enhance', 'enhancement-downloaded', 'cutout']);
    expect(t.services.saveReport).not.toHaveBeenCalled();
    expect(t.services.generate).not.toHaveBeenCalled();
  });

  it('stops before cutout if enhancement fails', async () => {
    const t = await setup();
    const fetcher = t.fetcher.getMockImplementation()!;
    t.fetcher.mockImplementation(async (url, init) => String(url).endsWith('/enhance-image')
      ? Response.json({ success: false }, { status: 502 }) : fetcher(url, init));
    await expect(prepareStandardArtwork(t.request, t.services)).rejects.toThrow('画质增强失败');
    expect(t.cutout).not.toHaveBeenCalled();
    expect(t.services.saveReport).not.toHaveBeenCalled();
  });

  it('still rejects a geometrically distorted enhancement before cutout', async () => {
    const t = await setup();
    const distorted = await sharp(t.source).resize(1000, 1000, { fit: 'fill' }).png().toBuffer();
    const fetcher = t.fetcher.getMockImplementation()!;
    t.fetcher.mockImplementation(async (url, init) => String(url) === 'https://test.invalid/enhanced'
      ? new Response(new Uint8Array(distorted)) : fetcher(url, init));
    await expect(prepareStandardArtwork(t.request, t.services)).rejects.toThrow('超过 1%');
    expect(t.cutout).not.toHaveBeenCalled();
  });

  it('fits a large complex-background original to the existing enhancement input limits before cutout', async () => {
    const t = await setup();
    const source = await sharp(Buffer.from('<svg width="5200" height="900"><defs><pattern id="tiles" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#b51235"/><rect width="2" height="4" fill="#257dc1"/></pattern></defs><rect width="5200" height="900" fill="url(#tiles)"/></svg>')).png().toBuffer();
    expect((await inspectArtworkSource(source)).kind).toBe('complex-background');
    const cutout = vi.fn(async (bytes: Buffer) => {
      const metadata = await sharp(bytes).metadata();
      expect(metadata.width).toBe(4096);
      expect(metadata.height).toBeGreaterThanOrEqual(512);
      throw new Error('Reached cutout after enhancement');
    });
    await expect(prepareTaskArtwork({ ...t.request, processingRoute: 'fidelity', enhancementMode: 'professional',
      image: { ...t.request.image, dataUrl: `data:image/png;base64,${source.toString('base64')}` } }, {
      measuredQuality: { blur: 30, vqscore: 90, noise: 90, compressionArtifacts: 0 }, cutout,
    })).rejects.toThrow('Reached cutout after enhancement');
    expect(cutout).toHaveBeenCalledOnce();
    expect(t.events).toEqual(['enhance', 'enhancement-downloaded']);
  });
});
