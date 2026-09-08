import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateStandardArtwork } from '@/lib/server/ark-artwork-processing';
import { CliproxyImageConfigurationError, generateCliproxyArtwork } from '@/lib/server/cliproxy-image-2';

const png = () => sharp({ create: { width: 16, height: 16, channels: 4, background: '#123456' } }).png().toBuffer();
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
const resultResponse = (bytes: Buffer) => new Response(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));

beforeEach(() => {
  vi.stubEnv('ARTWORK_IMAGE_PROVIDER', 'cliproxy');
  vi.stubEnv('CLIPROXY_API_BASE_URL', 'https://proxy.example.com/v1/');
  vi.stubEnv('CLIPROXY_API_KEY', 'test-private-key');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('WPS Codex Image 2 provider', () => {
  it('explains a rejected native alpha request without exposing the upstream body or retrying', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'invalid_value', type: 'image_generation_user_error', message: 'Transparent background is not supported for this model. secret-test-private-key' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await generateCliproxyArtwork('透明 Logo', [], { background: 'transparent' }).catch(error => error as Error);
    if (!(error instanceof Error)) throw new Error('Expected provider failure');
    expect(error.message).toContain('当前模型调用路径不支持原生透明输出');
    expect(error.message).not.toContain('test-private-key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('requests native alpha per call and records safe response evidence without changing returned PNG bytes', async () => {
    const bytes = await png();
    const mock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: bytes.toString('base64'), background: 'transparent', revised_prompt: '实际制作提示词', private_field: 'excluded' }] })));
    vi.stubGlobal('fetch', mock);
    const result = await generateStandardArtwork('完整图案', [dataUrl(bytes)], { background: 'transparent' });
    const body = (mock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1].body as FormData;
    expect(body.get('background')).toBe('transparent');
    expect(result.bytes).toEqual(bytes);
    expect(result.generationMetadata).toEqual({ requestedBackground: 'transparent', hasAlpha: true, background: 'transparent', revised_prompt: '实际制作提示词', queueMs: expect.any(Number), requestMs: expect.any(Number) });
  });
  it('caps the shared provider at two requests and releases a failed slot without retrying', async () => {
    const bytes = await png();
    const replies: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => replies.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const requests = ['one', 'two', 'three'].map(prompt => generateStandardArtwork(prompt, []).catch(error => error));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    replies[0](new Response('', { status: 429 }));
    expect((await requests[0]).message).toContain('429');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    replies[1](resultResponse(bytes)); replies[2](resultResponse(bytes));
    expect((await requests[1]).model).toBe('gpt-image-2');
    expect((await requests[2]).model).toBe('gpt-image-2');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('uses the common generator, preserving exact prompt and ordered primary/reference bytes', async () => {
    const primary = await png();
    const reference = await sharp(primary).negate().png().toBuffer();
    const fetchMock = vi.fn(async () => resultResponse(primary));
    vi.stubGlobal('fetch', fetchMock);
    const prompt = '输入图1是图5主体，输入图2只参考图4整体排版。准确文字：研 2026。';
    expect(await generateStandardArtwork(prompt, [dataUrl(primary), dataUrl(reference)])).toEqual({ bytes: primary, model: 'gpt-image-2', generationNote: 'Codex gpt-image-2（CLIProxyAPI）：请求 2048×2048 / Medium；实际 PNG 16×16', generationMetadata: { requestedBackground: 'auto', hasAlpha: true, queueMs: expect.any(Number), requestMs: expect.any(Number) } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://proxy.example.com/v1/images/edits');
    expect(init.headers).toEqual({ Authorization: 'Bearer test-private-key' });
    expect(init.redirect).toBe('error');
    const body = init.body as FormData;
    expect(body.get('prompt')).toBe(prompt);
    expect(body.get('model')).toBe('gpt-image-2');
    expect(body.get('size')).toBe('2048x2048');
    expect(body.get('quality')).toBe('medium');
    expect(body.get('background')).toBe('auto');
    expect(body.get('output_format')).toBe('png');
    expect(body.get('response_format')).toBe('b64_json');
    expect(body.get('n')).toBe('1');
    expect(body.has('input_fidelity')).toBe(false);
    expect(body.has('watermark')).toBe(false);
    const files = body.getAll('image[]') as File[];
    expect(files.map(file => file.name)).toEqual(['input-1.png', 'input-2.png']);
    expect(await Promise.all(files.map(async file => Buffer.from(await file.arrayBuffer())))).toEqual([primary, reference]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses generations for text-only requests', async () => {
    const fetchMock = vi.fn(async () => resultResponse(await png()));
    vi.stubGlobal('fetch', fetchMock);
    await generateCliproxyArtwork('生成准确文字：2026', []);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://proxy.example.com/v1/images/generations');
    expect(JSON.parse(init.body as string)).toMatchObject({ prompt: '生成准确文字：2026', model: 'gpt-image-2', n: 1 });
  });

  it.each([401, 403, 429, 500, 502])('does not retry, leak upstream details or fall back on HTTP %s', async status => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'secret-test-private-key oauth-token' } }), { status }));
    vi.stubGlobal('fetch', fetchMock);
    const error = await generateStandardArtwork('测试', []).catch(error => error as Error);
    if (!(error instanceof Error)) throw new Error('Expected provider failure');
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).not.toMatch(/secret|test-private-key|oauth-token/u);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an uncertain result without resubmitting on timeout', async () => {
    const fetchMock = vi.fn(async () => { throw new DOMException('private transport details', 'TimeoutError'); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateStandardArtwork('测试', [])).rejects.toThrow('结果未确认；未自动重试');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'http://proxy.example.com/v1', 'https://user:pass@proxy.example.com/v1', 'https://proxy.example.com/v1?key=secret', 'https://proxy.example.com'])('rejects invalid base %s before submitting', async base => {
    vi.stubEnv('CLIPROXY_API_BASE_URL', base);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateStandardArtwork('测试', [])).rejects.toBeInstanceOf(CliproxyImageConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not use Ark when the selected proxy lacks credentials', async () => {
    vi.stubEnv('CLIPROXY_API_KEY', '');
    vi.stubEnv('ARK_RUNTIME_API_KEY', 'unused-ark-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateStandardArtwork('测试', [])).rejects.toBeInstanceOf(CliproxyImageConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown provider and malformed image inputs before submitting', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateStandardArtwork('测试', ['https://asset.example.com/a.png'])).rejects.toThrow('base64 图片');
    vi.stubEnv('ARTWORK_IMAGE_PROVIDER', 'typo');
    await expect(generateStandardArtwork('测试', [])).rejects.toBeInstanceOf(CliproxyImageConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { data: [] }, { data: [{ url: 'https://example.com/result.png' }] },
    { data: [{ b64_json: 'invalid!' }] }, { data: [{ b64_json: 'AAAA' }] },
    { data: [{ b64_json: 'AAAA' }, { b64_json: 'AAAA' }] },
    { error: { message: 'secret' } },
  ])('rejects missing, ambiguous or corrupt images', async body => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateStandardArtwork('测试', [])).rejects.toThrow('Codex 生图');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds the response and rejects proxy HTML without reflecting it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>private error details</html>')));
    await expect(generateStandardArtwork('测试', [])).rejects.toThrow('无效 JSON');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'content-length': String(31 * 1024 * 1024) } })));
    await expect(generateStandardArtwork('测试', [])).rejects.toThrow('超过 30MB');
  });

  it('retains the existing Ark contract only when explicitly selected', async () => {
    vi.stubEnv('ARTWORK_IMAGE_PROVIDER', 'ark');
    vi.stubEnv('ARK_RUNTIME_API_KEY', 'ark-key');
    const bytes = await png();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ url: 'https://image.example.com/result.png' }] }))).mockResolvedValueOnce(new Response(new Uint8Array(bytes)));
    vi.stubGlobal('fetch', fetchMock);
    expect((await generateStandardArtwork('原要求', [])).model).toBe('doubao-seedream-5-0-lite-260128');
    expect(fetchMock.mock.calls[0][0]).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
  });
});
