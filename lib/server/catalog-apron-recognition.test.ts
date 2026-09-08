import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { recognizeCatalogApron } from './catalog-apron-recognition';
import { readCatalogFile } from './catalog-files';
import { catalogFixture } from '@/lib/testing/production-garment-fixture';
import { APRON_REFINEMENT_PROMPT } from '@/lib/catalog-apron-recognition';
vi.mock('./catalog-files', () => ({ readCatalogFile: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
const recognition = { garment: { area: { x: 0, y: 0, width: 1, height: 1 }, confidence: .9, reason: '可见布面' }, landmarks: [], positions: ['apronUpper', 'apronPocket', 'frontCenter'].map((key, index) => ({ key, area: { x: .3, y: .1 + index * .25, width: .2, height: .15 }, confidence: .9, reason: '局部可见' })) };
function detail() { const value = catalogFixture(); value.styleCode = '103JJ'; value.namespace = 'normalized-garments-v1'; value.sha256 = randomUUID(); value.views = [value.views[0]]; value.views[0].crop = { x: 0, y: 0, width: 1, height: 1 }; return value; }
describe('apron model service', () => {
  it('runs overview and cropped refinement, shares in-flight requests and retains saved standards', async () => {
    vi.stubEnv('ARK_API_KEY', 'test-only');
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes: await sharp({ create: { width: 100, height: 200, channels: 3, background: 'white' } }).png().toBuffer() } as Awaited<ReturnType<typeof readCatalogFile>>);
    const toCorners = (area: { x: number; y: number; width: number; height: number }) => ({ x1: area.x, y1: area.y, x2: area.x + area.width, y2: area.y + area.height });
    const modelRecognition = { ...recognition, garment: { ...recognition.garment, area: toCorners(recognition.garment.area) }, positions: recognition.positions.map(p => ({ ...p, area: toCorners(p.area) })) };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelRecognition) } }], usage: { total_tokens: 10 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const item = detail(); const before = structuredClone(item);
    const [first, duplicate] = await Promise.all([recognizeCatalogApron(item), recognizeCatalogApron(item)]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.passes.map(p => p.stage)).toEqual(['全图定位', '局部放大复核']);
    expect(duplicate.cached).toBe(true);
    expect(first.specification.positions).toHaveLength(3);
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(sent.messages[0].content[0].text).toBe(APRON_REFINEMENT_PROMPT);
    expect(sent.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(item).toEqual(before);
    await recognizeCatalogApron(item); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('rejects other clothing and makes a failed request retryable', async () => {
    await expect(recognizeCatalogApron(catalogFixture())).rejects.toThrow('不是已知围裙');
    vi.stubEnv('ARK_API_KEY', 'test-only');
    vi.mocked(readCatalogFile).mockResolvedValue({ bytes: await sharp({ create: { width: 100, height: 200, channels: 3, background: 'white' } }).png().toBuffer() } as Awaited<ReturnType<typeof readCatalogFile>>);
    const fetchMock = vi.fn().mockRejectedValue(new Error('模型服务暂不可用'));
    vi.stubGlobal('fetch', fetchMock); const item = detail();
    await expect(recognizeCatalogApron(item)).rejects.toThrow('暂不可用');
    await expect(recognizeCatalogApron(item)).rejects.toThrow('暂不可用');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
