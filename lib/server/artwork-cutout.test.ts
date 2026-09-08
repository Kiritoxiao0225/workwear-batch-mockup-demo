import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyzeArtworkCutout } from './artwork-cutout-analysis';
import { startArtworkCutout, queryArtworkCutout, type CutoutServices } from './artwork-cutout';
import { meituCutoutPayload } from './meitu-cutout';
import { alignCutoutLayer } from './artwork-cutout-layer';
import { visibleArtworkBounds } from './artwork-image-processing';
import { cutoutFeeLabel } from '../artwork-cutout';

let directory: string;
const svg = (content: string, transparent = false) => sharp(Buffer.from(`<svg width="400" height="300">${transparent ? '' : '<rect width="400" height="300" fill="white"/>'}${content}</svg>`)).png().toBuffer();
const solid = '<rect x="90" y="60" width="220" height="180" fill="black"/>';
const hole = '<path d="M90 60h220v180H90z M130 100v100h140V100z" fill="black" fill-rule="evenodd"/>';
async function setup() {
  const output = await svg(hole, true);
  const services: CutoutServices = { upload: vi.fn(async () => 'https://test.stariidata.com/input.png'), submit: vi.fn(async () => ({ code: 0, data: { task_id: 'provider-1' } })),
    query: vi.fn(async () => ({ code: 0, data: { status: 10, result: { media_info_list: [{ media_data: 'https://test.meitudata.com/output.png' }] } } })), download: vi.fn(async () => output), credits: vi.fn(async () => 1), volcano: vi.fn(async (_bytes, options) => { await options?.beforeSubmit?.(); return 'https://test.volces.com/output.png'; }), volcanoDownload: vi.fn(async () => output) };
  return { source: await svg(hole), output, services };
}
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'cutout-test-')); vi.stubEnv('WPS_PRODUCTION_STORAGE', 'local'); vi.stubEnv('ARTWORK_CUTOUT_CACHE_DIR', directory); vi.stubEnv('MEITU_OPENAPI_ACCESS_KEY', 'test-account'); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
describe('cutout routing and paid task recovery', () => {
  it('reuses qualified alpha, keeps simple holes on Volcano and selects Meitu only for fine details', async () => {
    expect((await analyzeArtworkCutout(await svg(solid))).route).toBe('standard');
    expect((await analyzeArtworkCutout(await svg(hole))).route).toBe('volcano');
    expect((await analyzeArtworkCutout(await svg(hole, true), 'meitu')).route).toBe('reuse');
    const thin = Array.from({ length: 8 }, (_, i) => `<rect x="${60 + i * 35}" y="70" width="5" height="150" fill="black"/>`).join('');
    expect((await analyzeArtworkCutout(await svg(thin))).route).toBe('meitu');
    expect((await analyzeArtworkCutout(await svg(thin), 'standard')).route).toBe('volcano');
    expect((await analyzeArtworkCutout(await svg(solid), 'meitu')).route).toBe('meitu');
  });
  it('uses Volcano for user-selected standard artwork with holes, without calling Meitu', async () => {
    const t = await setup(); const result = await startArtworkCutout(t.source, 'standard', { services: t.services });
    expect(result.status).toBe('completed'); expect(result.receipt.route).toBe('volcano'); expect(result.receipt.actualCredits).toBeNull(); expect(t.services.volcano).toHaveBeenCalledTimes(1); expect(t.services.submit).not.toHaveBeenCalled();
  });
  it('runs local processing without cloud calls for simple art', async () => {
    const t = await setup(); const result = await startArtworkCutout(await svg(solid), 'standard', { services: t.services });
    expect(result.status).toBe('completed'); expect(result.receipt.route).toBe('standard');
    expect(t.services.volcano).not.toHaveBeenCalled(); expect(t.services.submit).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent Volcano calls and caches results without inventing free billing', async () => {
    const t = await setup(); const results = await Promise.all([startArtworkCutout(t.source, 'auto', { services: t.services }), startArtworkCutout(t.source, 'auto', { services: t.services })]);
    expect(t.services.volcano).toHaveBeenCalledTimes(1); expect(t.services.submit).not.toHaveBeenCalled();
    expect(results[0].receipt.jobKey).toBe(results[1].receipt.jobKey);
    const result = await startArtworkCutout(t.source, 'auto', { services: t.services });
    expect(result.status).toBe('completed'); expect(result.receipt.cacheHit).toBe(true);
    expect(cutoutFeeLabel({ ...result.receipt, cacheHit: false })).toContain('金额未回传');
    expect(cutoutFeeLabel(result.receipt)).toContain('本次未调用火山');
  });
  it('resumes Volcano downloads using the durable URL without resubmission', async () => {
    const t = await setup(); vi.mocked(t.services.volcanoDownload).mockRejectedValueOnce(new Error('download timeout'));
    const first = await startArtworkCutout(t.source, 'auto', { services: t.services });
    expect(first.status).toBe('pending');
    expect((await queryArtworkCutout(first.receipt.jobKey, t.services)).status).toBe('completed');
    expect(t.services.volcano).toHaveBeenCalledTimes(1); expect(t.services.submit).not.toHaveBeenCalled();
  });
  it('blocks uncertain Volcano submissions and does not switch providers', async () => {
    const t = await setup(); vi.mocked(t.services.volcano).mockImplementation(async (_bytes, options) => { await options?.beforeSubmit?.(); throw new Error('timeout'); });
    const first = await startArtworkCutout(t.source, 'auto', { services: t.services });
    expect(first.status).toBe('unknown');
    expect((await startArtworkCutout(t.source, 'auto', { services: t.services })).status).toBe('unknown');
    await expect(startArtworkCutout(t.source, 'auto', { services: t.services, retryOf: first.receipt.jobKey })).rejects.toThrow('只有已明确失败');
    expect(t.services.volcano).toHaveBeenCalledTimes(1); expect(t.services.submit).not.toHaveBeenCalled();
  });
  it('rejects missing detached artwork and lets the user choose a retry after a known result failure', async () => {
    const t = await setup(); const source = await svg(`${hole}<rect x="10" y="10" width="20" height="20" fill="black"/>`);
    const first = await startArtworkCutout(source, 'auto', { services: t.services });
    expect(first.status).toBe('failed'); expect(first.error).toContain('文字或独立图形');
    expect(t.services.submit).not.toHaveBeenCalled();
    await startArtworkCutout(source, 'auto', { services: t.services, retryOf: first.receipt.jobKey });
    expect(t.services.volcano).toHaveBeenCalledTimes(2);
  });
  it('accepts visible anti-aliased stroke edges without confusing them with deleted lettering', async () => {
    const t = await setup();
    const softened = await sharp(t.output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let visible = 0;
    for (let i = 3; i < softened.data.length; i += 4) if (softened.data[i]) { visible++; if (visible % 4 === 0) softened.data[i] = 120; }
    vi.mocked(t.services.volcanoDownload).mockResolvedValue(await sharp(softened.data, { raw: { width: softened.info.width, height: softened.info.height, channels: 4 } }).png().toBuffer());
    const result = await startArtworkCutout(t.source, 'standard', { services: t.services });
    expect(result.status).toBe('completed');
  });
  it.each(['auto', 'meitu'] as const)('protects original badge whites with provider mode %s', async mode => {
    const t = await setup();
    const badge = '<circle cx="200" cy="150" r="105" stroke="red" stroke-width="6" fill="none"/><rect x="165" y="115" width="70" height="70" fill="red"/>';
    vi.mocked(t.services.download).mockResolvedValue(await svg(badge, true)); vi.mocked(t.services.volcanoDownload).mockResolvedValue(await svg(badge, true));
    let result = await startArtworkCutout(await svg(badge), mode, { services: t.services });
    if (result.status === 'pending') result = await queryArtworkCutout(result.receipt.jobKey, t.services);
    expect(result.status).toBe('completed'); expect(result.receipt.badgeProtection?.regions).toBe(1);
    const pixels = await sharp(Buffer.from(result.url!.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer();
    expect([...pixels.subarray((150 * 400 + 130) * 4, (150 * 400 + 130) * 4 + 4)]).toEqual([255, 255, 255, 255]);
    expect(pixels[3]).toBe(0);
  });
  it('deduplicates concurrent submissions and returns the durable result on reuse', async () => {
    const t = await setup(); const results = await Promise.all([startArtworkCutout(t.source, 'meitu', { services: t.services }), startArtworkCutout(t.source, 'meitu', { services: t.services })]);
    expect(t.services.submit).toHaveBeenCalledTimes(1); expect(results[0].receipt.jobKey).toBe(results[1].receipt.jobKey);
    const complete = await queryArtworkCutout(results[0].receipt.jobKey, t.services); expect(complete.status).toBe('completed'); expect(complete.receipt.actualCredits).toBe(1);
    const cached = await startArtworkCutout(t.source, 'meitu', { services: t.services }); expect(cached.receipt.cacheHit).toBe(true); expect(cached.url).toBe(complete.url); expect(t.services.submit).toHaveBeenCalledTimes(1);
  });
  it('does not resubmit an unknown submission, even after another process reads the record', async () => {
    const t = await setup(); vi.mocked(t.services.submit).mockRejectedValue(new Error('timeout'));
    const result = await startArtworkCutout(t.source, 'meitu', { services: t.services }); expect(result.status).toBe('unknown');
    expect((await startArtworkCutout(t.source, 'meitu', { services: t.services })).status).toBe('unknown');
    await expect(startArtworkCutout(t.source, 'meitu', { services: t.services, retryOf: result.receipt.jobKey })).rejects.toThrow('只有已明确失败');
    expect(t.services.submit).toHaveBeenCalledTimes(1);
  });
  it('queries after a download failure and never creates another paid task', async () => {
    const t = await setup(); vi.mocked(t.services.download).mockRejectedValueOnce(new Error('download timeout'));
    const result = await startArtworkCutout(t.source, 'meitu', { services: t.services });
    expect((await queryArtworkCutout(result.receipt.jobKey, t.services)).status).toBe('pending');
    expect((await queryArtworkCutout(result.receipt.jobKey, t.services)).status).toBe('completed'); expect(t.services.submit).toHaveBeenCalledTimes(1);
  });
  it('recognizes provider status 2 as terminal failure and deduplicates explicit retries', async () => {
    const t = await setup(); vi.mocked(t.services.query).mockResolvedValue({ code: 0, data: { status: 2 } });
    const result = await startArtworkCutout(t.source, 'meitu', { services: t.services });
    expect((await queryArtworkCutout(result.receipt.jobKey, t.services)).status).toBe('failed');
    await Promise.all([startArtworkCutout(t.source, 'meitu', { services: t.services, retryOf: result.receipt.jobKey }), startArtworkCutout(t.source, 'meitu', { services: t.services, retryOf: result.receipt.jobKey })]);
    expect(t.services.submit).toHaveBeenCalledTimes(2);
  });
  it('rejects opaque output and does not invent an actual charge without a matched bill', async () => {
    const t = await setup(); vi.mocked(t.services.download).mockResolvedValue(t.source); vi.mocked(t.services.credits).mockResolvedValue(null);
    const result = await startArtworkCutout(t.source, 'meitu', { services: t.services }); const rejected = await queryArtworkCutout(result.receipt.jobKey, t.services);
    expect(rejected.status).toBe('failed'); expect(rejected.receipt.actualCredits).toBeNull();
  });
  it('matches billing to the provider trace and saves the image even while billing is unavailable', async () => {
    const t = await setup();
    vi.mocked(t.services.query).mockResolvedValue({ code: 0, data: { status: 10, result: { media_info_list: [{ media_data: 'https://test.meitudata.com/output.png' }], parameters: { result: { submit_body: { parameter: { trace_id: 'actual-trace::upstream' } } } } } } });
    vi.mocked(t.services.credits).mockRejectedValueOnce(new Error('billing timeout'));
    const started = await startArtworkCutout(t.source, 'meitu', { services: t.services });
    const first = await queryArtworkCutout(started.receipt.jobKey, t.services);
    expect(first.status).toBe('completed'); expect(first.receipt.actualCredits).toBeNull();
    const recovered = await queryArtworkCutout(started.receipt.jobKey, t.services);
    expect(recovered.receipt.actualCredits).toBe(1); expect(t.services.credits).toHaveBeenLastCalledWith('actual-trace');
    expect(t.services.download).toHaveBeenCalledTimes(1); expect(t.services.submit).toHaveBeenCalledTimes(1);
  });
  it('keeps the existing cropped canvas and visible position when replacing a layer', async () => {
    const current = await sharp(await svg(hole, true)).extract({ left: 70, top: 40, width: 260, height: 220 }).png().toBuffer();
    const aligned = await alignCutoutLayer(await svg(hole, true), current);
    expect(await visibleArtworkBounds(aligned)).toEqual(await visibleArtworkBounds(current));
    expect(await sharp(aligned).metadata()).toMatchObject({ width: 260, height: 220, hasAlpha: true });
    const { data, info } = await sharp(aligned).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[(110 * info.width + 130) * 4 + 3]).toBe(0);
  });
  it('uses the verified graphic command contract without the old REST listing', () => {
    const payload = meituCutoutPayload('https://test.stariidata.com/input.png', 'request-1');
    expect(payload).toMatchObject({ task: 'image-cutout', task_type: 'formula', request_id: 'request-1', rsp_media_type: 'url' });
    expect(JSON.parse(payload.params)).toEqual({ parameter: { model_type: 2 } });
  });
});
