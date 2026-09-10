import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { analyzeSourceTaskRecords, inspectArtworkReferenceImage, planArtworkGenerationPrompt } from '@/lib/server/ark-task-review';
import { sourceTaskSnapshot } from '@/lib/task-review-snapshot';
import { WpsAnalysisTrace } from './wps-analysis-trace';

vi.mock('@/lib/server/wps-production-garments', () => ({ productionCatalogStyles: async () => [] }));

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubEnv('WPS_ANALYSIS_PROVIDER', 'ark');
  vi.stubEnv('WPS_ANALYSIS_MODEL', '');
  vi.stubEnv('WPS_ANALYSIS_REASONING_EFFORT', 'medium');
  vi.stubEnv('VISION_MODEL_EP', 'doubao-seed-2-0-lite-260215');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.ARK_RUNTIME_API_KEY;
});

describe('focused artwork inspection recovery', () => {
  const inspectedImage = 'data:image/png;base64,aW1hZ2U=';
  const inspectionReply = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"checks":[{"status":"failed"}]}' } }] }));

  it.each(['ark', 'cliproxy'])('retries %s transport failures with exactly the same image, prompt and model', async provider => {
    vi.useFakeTimers();
    if (provider === 'cliproxy') useProxy(); else process.env.ARK_RUNTIME_API_KEY = 'test-key';
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(inspectionReply());
    vi.stubGlobal('fetch', fetchMock);
    const result = inspectArtworkReferenceImage(inspectedImage, '逐项核对');
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ provider, inspectionAttempts: 2, content: '{"checks":[{"status":"failed"}]}' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0]);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
    expect(fetchMock.mock.calls[1][1]?.body).toContain(inspectedImage);
  });

  it.each(['ark', 'cliproxy'])('keeps labeled image order and unchanged model settings when retrying a %s comparison', async provider => {
    vi.useFakeTimers();
    if (provider === 'cliproxy') { useProxy(); vi.stubEnv('WPS_ANALYSIS_MODEL', 'gpt-5.6-sol'); vi.stubEnv('WPS_ANALYSIS_REASONING_EFFORT', 'low'); }
    else process.env.ARK_RUNTIME_API_KEY = 'test-key';
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(inspectionReply());
    vi.stubGlobal('fetch', fetchMock);
    const input = [{ label: 'SOURCE 原图', dataUrl: inspectedImage }, { label: 'RESULT 实际结果', dataUrl: 'data:image/png;base64,cmVzdWx0' }];
    const result = inspectArtworkReferenceImage(input, '检查文字与轮廓');
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ inspectionAttempts: 2, provider });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: '检查文字与轮廓' },
      ...input.flatMap(image => [{ type: 'text', text: image.label }, { type: 'image_url', image_url: { url: image.dataUrl, ...(provider === 'cliproxy' ? { detail: 'high' } : {}) } }]),
    ]);
    if (provider === 'cliproxy') expect(body).toMatchObject({ model: 'gpt-5.6-sol', reasoning_effort: 'low' });
    expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['TimeoutError', 'AbortError', 'socket'])('recovers a %s while reading the response body', async errorName => {
    vi.useFakeTimers(); useProxy();
    const brokenResponse = new Response('');
    vi.spyOn(brokenResponse, 'json').mockRejectedValue(errorName === 'socket'
      ? new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }) : new DOMException('body deadline', errorName));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(brokenResponse).mockResolvedValueOnce(inspectionReply());
    vi.stubGlobal('fetch', fetchMock);
    const result = inspectArtworkReferenceImage(inspectedImage, '逐项核对');
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ inspectionAttempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers proxy throttling without reading private upstream error text', async () => {
    vi.useFakeTimers(); useProxy();
    const response = new Response('secret-upstream-details', { status: 429, headers: { 'Retry-After': '10' } });
    const readBody = vi.spyOn(response, 'json');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(response).mockResolvedValueOnce(inspectionReply());
    vi.stubGlobal('fetch', fetchMock);
    const result = inspectArtworkReferenceImage(inspectedImage, '逐项核对');
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ inspectionAttempts: 2 });
    expect(readBody).not.toHaveBeenCalled();
  });

  it.each([401, 403, 200])('does not retry HTTP %s permission failures or malformed JSON', async status => {
    useProxy();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('invalid json', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(inspectArtworkReferenceImage(inspectedImage, '逐项核对')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reports exhausted inspection requests without claiming that no retry occurred', async () => {
    vi.useFakeTimers(); useProxy();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('secret-upstream-details', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = inspectArtworkReferenceImage(inspectedImage, '逐项核对').catch(error => error);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).toMatchObject({ inspectionAttempts: 3 });
    expect(error.message).toContain('内容核对（CLIProxyAPI）HTTP 503');
    expect(error.message).not.toMatch(/未自动重试|secret-upstream/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function useProxy() {
  vi.stubEnv('WPS_ANALYSIS_PROVIDER', 'cliproxy');
  vi.stubEnv('CLIPROXY_API_BASE_URL', 'https://example.test/v1');
  vi.stubEnv('CLIPROXY_API_KEY', 'proxy-test-key');
}

function validAnalysis() {
  const [record] = sourceTaskSnapshot();
  return { records: [{ recordId: record.recordId, summary: '左胸图案', units: [{
    id: `${record.recordId}-u1`, garmentLabel: 'B01SD-活力黑', variantLabel: '版本1', productCode: null,
    placement: 'leftChest', logoMaterialId: record.materials[0].id, referenceMaterialIds: [], sourceScope: 'subject',
    textMode: 'replace', exactText: 'poppy手机数码', layoutNote: '', instruction: '左胸使用图1，加文字“poppy手机数码”。', generationPrompt: '以图1为内容源，下方添加准确文字“poppy手机数码”，完整平面图案，纯白背景。', ambiguities: [],
  }] }] };
}

describe('task review vision analysis input', () => {
  it('accepts empty generation prompts for plain text without asking for another model call', async () => {
    useProxy();
    const source = { ...sourceTaskSnapshot()[0], requirementText: '左胸:诺维特酒店保洁 后背: 字体: 颜色:', materials: [] };
    const body = validAnalysis();
    Object.assign(body.records[0].units[0], { logoMaterialId: null, exactText: '诺维特酒店保洁', instruction: '左胸制作文字“诺维特酒店保洁”。', generationPrompt: '' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await analyzeSourceTaskRecords([source]);
    expect(result.reviews[0].units[0].generationPrompt).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps model requests at five across calls and frees a failed slot without retrying', async () => {
    useProxy();
    const replies: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => replies.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const jobs = Array.from({ length: 6 }, () => analyzeSourceTaskRecords([sourceTaskSnapshot()[0]]).catch(error => error));
    await vi.waitFor(() => expect(replies).toHaveLength(5));
    replies[0](new Response('', { status: 429 }));
    await vi.waitFor(() => expect(replies).toHaveLength(6));
    for (const reply of replies.slice(1)) reply(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(validAnalysis()) } }] })));
    const results = await Promise.all(jobs);
    expect(results.filter(result => result instanceof Error)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([['gpt-5.6-sol', 'low'], ['gpt-5.6-luna', 'max'], ['gpt-6-astra', 'low']])('passes the configured %s / %s without changing inputs', async (model, effort) => {
    useProxy(); vi.stubEnv('WPS_ANALYSIS_MODEL', model); vi.stubEnv('WPS_ANALYSIS_REASONING_EFFORT', effort);
    const mock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validAnalysis()) } }] })));
    vi.stubGlobal('fetch', mock);
    expect(await analyzeSourceTaskRecords([sourceTaskSnapshot()[0]])).toMatchObject({ model, reasoningEffort: effort });
    const init = (mock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1];
    expect(JSON.parse(String(init.body))).toMatchObject({ model, reasoning_effort: effort });
  });
  it('embeds local public originals as data URLs instead of sending unreachable paths', async () => {
    process.env.ARK_RUNTIME_API_KEY = 'test-key';
    const [record] = sourceTaskSnapshot();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: Array<Record<string, unknown>> }>;
      };
      const imageBlock = body.messages[0].content.find((block) => block.type === 'image_url') as {
        image_url: { url: string };
      };
      expect(imageBlock.image_url.url).toMatch(/^data:image\/png;base64,/u);
      expect(imageBlock.image_url.url).not.toContain('/task-review-originals/');
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          records: [{
            recordId: record.recordId,
            summary: '一条左胸图案任务。',
            units: [{
              id: `${record.recordId}-u1`,
              garmentLabel: 'B01SD-活力黑',
              variantLabel: '版本1',
              productCode: null,
              placement: 'leftChest',
              logoMaterialId: record.materials[0].id,
              referenceMaterialIds: [],
              sourceScope: 'subject',
              textMode: 'replace',
              exactText: 'poppy手机数码',
              layoutNote: '',
              instruction: '左胸使用图1，加文字“poppy手机数码”，Logo 改为绿色。',
              generationPrompt: '取图1的标志并改为绿色，下方加字“poppy手机数码”，纯白背景。',
              ambiguities: [],
            }],
          }],
        }) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await analyzeSourceTaskRecords([record]);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0].units[0].logo.materialId).toBe(record.materials[0].id);
  });

  it('reports a row-specific Chinese error when Ark times out', async () => {
    process.env.ARK_RUNTIME_API_KEY = 'test-key';
    const [record] = sourceTaskSnapshot();
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn(async () => { throw timeout; }));

    await expect(analyzeSourceTaskRecords([record])).rejects.toThrow(
      `任务分析模型处理超时（180 秒）：${record.customerId}/${record.recordId}；该行请求失败不会影响其他行，可重新分析`,
    );
  });

  it('uses the selected proxy model with labeled original images and a reasoning-compatible JSON request', async () => {
    useProxy();
    const [record] = sourceTaskSnapshot();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(validAnalysis()) } }] })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await analyzeSourceTaskRecords([record]);
    expect(result).toMatchObject({ model: 'gpt-5.6-sol', provider: 'cliproxy' });
    expect(result.reviews[0].units[0].logo.materialId).toBe(record.materials[0].id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer proxy-test-key' });
    expect(init.redirect).toBe('error');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'gpt-5.6-sol', reasoning_effort: 'medium', max_completion_tokens: 16000, stream: false, response_format: { type: 'json_object' } });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    const images = body.messages[0].content.filter((block: { type: string }) => block.type === 'image_url');
    expect(images).toHaveLength(record.materials.length);
    expect(images[0].image_url).toMatchObject({ detail: 'high', url: expect.stringMatching(/^data:image\/png;base64,/u) });
    expect(body.messages[0].content[1].text).toContain(record.materials[0].id);
  });

  it.each([
    ['WPS_ANALYSIS_PROVIDER', 'unknown'],
    ['WPS_ANALYSIS_REASONING_EFFORT', 'fastest'],
    ['CLIPROXY_API_KEY', ''],
    ['CLIPROXY_API_BASE_URL', 'http://example.test/v1'],
    ['CLIPROXY_API_BASE_URL', 'https://user:secret@example.test/v1'],
    ['CLIPROXY_API_BASE_URL', 'https://example.test/wrong'],
  ])('rejects invalid %s configuration before any network call', async (key, value) => {
    useProxy();
    vi.stubEnv(key, value);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(analyzeSourceTaskRecords([sourceTaskSnapshot()[0]])).rejects.toThrow('WPS_ANALYSIS_CONFIG_ERROR:');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isolates proxy throttling without leaking upstream text, retrying, or falling back to Ark', async () => {
    useProxy();
    process.env.ARK_RUNTIME_API_KEY = 'existing-ark-key';
    const fetchMock = vi.fn(async () => new Response('secret-upstream-details', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(analyzeSourceTaskRecords([sourceTaskSnapshot()[0]])).rejects.toThrow('需求解析（CLIProxyAPI）HTTP 429：额度或并发受限，请检查代理服务状态；未自动重试或切换模型');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects truncated output even when it happens to contain valid JSON', async () => {
    useProxy();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(validAnalysis()) } }] }))));
    await expect(analyzeSourceTaskRecords([sourceTaskSnapshot()[0]])).rejects.toThrow('任务分析输出被截断');
  });

  it('records separate input, model wait, response and expansion durations without logging content', async () => {
    useProxy();
    const source = sourceTaskSnapshot()[0];
    const body = validAnalysis(), unit = body.records[0].units[0];
    const reply = { records: [{ recordId: source.recordId, summary: '测试',
      garments: [{ id: 'g1', styleCode: 'B01SD', colorText: '活力黑', sizeText: '' }, { id: 'g2', styleCode: 'B01SD', colorText: '月牙白', sizeText: '' }],
      artworks: [{ ...unit, id: 'a1', garmentIds: ['g1', 'g2'] }],
    }] };
    const progress = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }))));
    const result = await analyzeSourceTaskRecords([source], { trace: new WpsAnalysisTrace(progress) });
    expect(result.optimization).toMatchObject({ artworkDefinitions: 1, expandedUnits: 2, candidateStyles: 0 });
    expect(result.timing.stages.map(item => item.stage)).toEqual(['queue', 'catalog', 'images', 'model', 'response', 'expand']);
    expect(result.timing.stages.every(item => item.durationMs >= 0 && item.status === 'completed')).toBe(true);
    expect(progress.mock.calls.filter(([event]) => event.type === 'stage').map(([event]) => event.stage)).toEqual(result.timing.stages.map(item => item.stage));
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(source.requirementText);
  });

  it('removes canceled queued work so it never calls the paid model later', async () => {
    useProxy();
    const replies: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => replies.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const jobs = Array.from({ length: 5 }, () => analyzeSourceTaskRecords([sourceTaskSnapshot()[0]]));
    await vi.waitFor(() => expect(replies).toHaveLength(5));
    const controller = new AbortController();
    const canceled = analyzeSourceTaskRecords([sourceTaskSnapshot()[0]], { signal: controller.signal }).catch(error => error);
    controller.abort(new DOMException('deadline', 'TimeoutError'));
    expect((await canceled).name).toBe('TimeoutError');
    replies.forEach(reply => reply(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validAnalysis()) } }] }))));
    await Promise.all(jobs);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('labels a response-body timeout and releases the request instead of treating it as invalid JSON', async () => {
    useProxy();
    const response = new Response('');
    vi.spyOn(response, 'json').mockRejectedValue(new DOMException('body timeout', 'TimeoutError'));
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await expect(analyzeSourceTaskRecords([sourceTaskSnapshot()[0]])).rejects.toThrow('模型返回内容超时');
  });
});


describe('focused generation prompt planning', () => {
  it('reads the original requirement and every source attachment with the configured Sol model', async () => {
    useProxy();
    const [source] = sourceTaskSnapshot();
    source.materials.push({ ...source.materials[0], id: 'extra-reference' });
    const reply = { generationPrompt: '使用图1与图2制作完整图案，纯白背景。', primaryImageLabel: '图1', referenceImageLabels: ['图2'], ambiguities: [] };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await planArtworkGenerationPrompt(source, { id: 'unit-1', garmentLabel: 'B01SD', variantLabel: '版本1', placement: null });
    expect(result).toMatchObject({ ...reply, model: 'gpt-5.6-sol' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(sent.model).toBe('gpt-5.6-sol');
    const content = sent.messages[0].content;
    expect(content.filter((item: {type: string}) => item.type === 'image_url')).toHaveLength(source.materials.length);
    expect(content[0].text).toContain(source.requirementText);
    expect(content[0].text).toContain('衣服款式和颜色不是图案配色指令');
    expect(content[0].text).toContain('generationPrompt');
    expect(content[0].text).toContain('本次只整理正文，不替用户选择或改变处理方式');
    expect(content[0].text).not.toContain('widthCm');
  });
  it('rejects references that do not exist or repeat the primary source', async () => {
    useProxy();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ generationPrompt: '制作图案', primaryImageLabel: '图1', referenceImageLabels: ['图1'], ambiguities: [] }) } }] }), { status: 200 })));
    await expect(planArtworkGenerationPrompt(sourceTaskSnapshot()[0], { id: 'unit-1', garmentLabel: 'B01SD', variantLabel: '版本1', placement: null })).rejects.toThrow('重复');
  });
});
