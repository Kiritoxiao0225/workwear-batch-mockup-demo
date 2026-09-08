import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildLogoAnalysisPrompt,
  parseLogoStudioAnalysis,
  parseLogoStudioRequest,
} from '@/lib/logo-studio';
import {
  buildCompleteLogoGenerationPrompt,
  formatArkErrorMessage,
  runLogoStudio,
} from '@/lib/server/ark-logo-studio';

const tinyPng = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
const tinyJpeg = `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`;

const userInstruction = '中间的Logo+汉方嘉铁永坊店【上下排版，文字颜色用下图文字的那个蓝色】';

const parsedAnalysis = {
  summary: '保留中间蓝色图形，在下方放置蓝色文字“汉方嘉铁永坊店”',
  source: {
    keep: ['中间蓝色几何 Logo 图形'],
    remove: ['顶部红色白云山字样', '底部旧文字维一实业'],
    visibleText: ['白云山', '维一实业'],
    colorReference: '底部“维一实业”的蓝色',
  },
  output: {
    description: '蓝色图形在上、蓝色目标文字在下的完整 Logo',
    targetText: '汉方嘉铁永坊店',
    layout: '中间图形在上，目标文字在下，上下居中排版',
    background: '纯白背景',
  },
  ambiguities: [],
  canGenerate: true,
  generationPrompt: '保留中间蓝色图形，删除上下旧字，在下方加入目标文字',
};

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ARK_RUNTIME_API_KEY;
  delete process.env.ARK_IMAGE_MODEL;
});

describe('Logo Studio simple request contract', () => {
  it('accepts one or two numbered images and one natural-language instruction', () => {
    const request = parseLogoStudioRequest({
      instruction: ` ${userInstruction} `,
      images: [
        { fileName: 'logo.png', mimeType: 'image/png', dataUrl: tinyPng },
        { fileName: 'font.jpg', mimeType: 'image/jpeg', dataUrl: tinyJpeg },
      ],
    });

    expect(request.instruction).toBe(userInstruction);
    expect(request.images.map((image) => image.fileName)).toEqual(['logo.png', 'font.jpg']);
    expect(buildLogoAnalysisPrompt(request)).toContain(userInstruction);
    expect(buildLogoAnalysisPrompt(request)).toContain('图1、图2');
    expect(buildLogoAnalysisPrompt(request)).toContain('顶部、中间、底部、左边、右边');
    expect(buildLogoAnalysisPrompt(request)).toContain('完整、居中、干净的 Logo');

    expect(parseLogoStudioRequest({
      instruction: userInstruction,
      images: [{ fileName: 'logo.png', mimeType: 'image/png', dataUrl: tinyPng }],
    }).images).toHaveLength(1);
  });

  it('fails fast unless there are one or two valid images and an instruction', () => {
    expect(() => parseLogoStudioRequest({
      instruction: '',
      images: [{ fileName: 'logo.png', mimeType: 'image/png', dataUrl: tinyPng }],
    })).toThrow('instruction 必须是非空文字');

    expect(() => parseLogoStudioRequest({ instruction: userInstruction })).toThrow(
      'images 必须包含 1–2 张上传图片',
    );

    expect(() => parseLogoStudioRequest({
      instruction: userInstruction,
      images: [
        { fileName: '1.png', mimeType: 'image/png', dataUrl: tinyPng },
        { fileName: '2.png', mimeType: 'image/png', dataUrl: tinyPng },
        { fileName: '3.png', mimeType: 'image/png', dataUrl: tinyPng },
      ],
    })).toThrow(
      'images 必须包含 1–2 张上传图片',
    );

    expect(() => parseLogoStudioRequest({
      instruction: userInstruction,
      images: [{ fileName: 'logo.gif', mimeType: 'image/gif', dataUrl: 'data:image/gif;base64,cG5n' }],
    })).toThrow('images[0].mimeType 不支持');
  });
});

describe('Logo Studio analysis contract', () => {
  it('accepts the complete-logo understanding', () => {
    const analysis = parseLogoStudioAnalysis(`\`\`\`json\n${JSON.stringify(parsedAnalysis)}\n\`\`\``);

    expect(analysis.source.keep).toEqual(['中间蓝色几何 Logo 图形']);
    expect(analysis.source.remove).toContain('顶部红色白云山字样');
    expect(analysis.output.targetText).toBe('汉方嘉铁永坊店');
    expect(analysis.output.layout).toContain('图形在上');
  });

  it('rejects a generation-ready response without a generation prompt', () => {
    expect(() => parseLogoStudioAnalysis(JSON.stringify({
      ...parsedAnalysis,
      generationPrompt: '',
    }))).toThrow('可生成任务必须包含 generationPrompt');
  });
});

describe('Logo Studio complete-logo generation prompt', () => {
  it('edits the original image and generates the complete logo in one image request', () => {
    const request = parseLogoStudioRequest({
      instruction: userInstruction,
      images: [
        { fileName: 'logo.png', mimeType: 'image/png', dataUrl: tinyPng },
        { fileName: 'font.jpg', mimeType: 'image/jpeg', dataUrl: tinyJpeg },
      ],
    });
    const prompt = buildCompleteLogoGenerationPrompt(request, parsedAnalysis);

    expect(prompt).toContain('一次生成一个完整 Logo');
    expect(prompt).toContain('图1：logo.png');
    expect(prompt).toContain('图2：font.jpg');
    expect(prompt).toContain('第三张输入图是程序生成的目标文字黑白骨架');
    expect(prompt).toContain('不得默认把图1当作 Logo 来源');
    expect(prompt).toContain('最终新文字只能是“汉方嘉铁永坊店”');
    expect(prompt).toContain('中间蓝色几何 Logo 图形');
    expect(prompt).toContain('不得重新设计、替换或改变');
    expect(prompt).toContain('底部“维一实业”的蓝色');
    expect(prompt).toContain('不能使用普通黑体');
    expect(prompt).toContain('只输出一个完整版本');
    expect(prompt).not.toContain('候选');
  });

  it('calls the analysis and image models once with two numbered references and the text guide', async () => {
    const generatedPng = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 0, g: 60, b: 160, alpha: 1 },
      },
    }).png().toBuffer();
    const analysisRequests: Record<string, unknown>[] = [];
    const imageRequests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/chat/completions')) {
        analysisRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(parsedAnalysis) } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.endsWith('/images/generations')) {
        imageRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: [{ url: 'https://example.com/logo.png' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === 'https://example.com/logo.png') {
        return new Response(new Uint8Array(generatedPng), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      throw new Error(`测试遇到未预期请求：${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.ARK_RUNTIME_API_KEY = 'test-key';

    const response = await runLogoStudio(parseLogoStudioRequest({
      instruction: userInstruction,
      images: [
        { fileName: 'logo.png', mimeType: 'image/png', dataUrl: tinyPng },
        { fileName: 'font.jpg', mimeType: 'image/jpeg', dataUrl: tinyJpeg },
      ],
    }));

    expect(response.status).toBe('generated');
    expect(analysisRequests).toHaveLength(1);
    const analysisContent = ((analysisRequests[0].messages as Array<Record<string, unknown>>)[0]
      .content as Array<Record<string, unknown>>);
    expect(analysisContent.filter((item) => item.type === 'image_url')).toEqual([
      { type: 'image_url', image_url: { url: tinyPng } },
      { type: 'image_url', image_url: { url: tinyJpeg } },
    ]);
    expect(analysisContent.filter((item) => item.type === 'text').map((item) => item.text)).toEqual(
      expect.arrayContaining(['以下是图1：logo.png', '以下是图2：font.jpg']),
    );
    expect(imageRequests).toHaveLength(1);
    expect(imageRequests[0].model).toBe('doubao-seedream-4-0-250828');
    expect(imageRequests[0].size).toBe('1K');
    expect(imageRequests[0]).not.toHaveProperty('sequential_image_generation');
    expect(imageRequests[0]).not.toHaveProperty('output_format');
    expect(imageRequests[0].image).toEqual([
      tinyPng,
      tinyJpeg,
      expect.stringMatching(/^data:image\/png;base64,/),
    ]);
    expect(String(imageRequests[0].prompt)).toContain('不要分别生成后拼接');

    process.env.ARK_IMAGE_MODEL = 'doubao-seedream-5-0-pro-260628';
    await runLogoStudio(parseLogoStudioRequest({
      instruction: userInstruction,
      images: [
        { fileName: 'logo.png', mimeType: 'image/png', dataUrl: tinyPng },
        { fileName: 'font.jpg', mimeType: 'image/jpeg', dataUrl: tinyJpeg },
      ],
    }));

    expect(imageRequests).toHaveLength(2);
    expect(imageRequests[1].model).toBe('doubao-seedream-5-0-pro-260628');
    expect(imageRequests[1].size).toBe('1K');
    expect(imageRequests[1].output_format).toBe('png');
  });

  it('turns the Ark safe-experience 429 into an actionable Chinese error', () => {
    const message = formatArkErrorMessage('Logo 图片生成模型', 429, {
      error: {
        code: 'SetLimitExceeded',
        message: 'Your account [2112711966] has reached the set inference limit. Please close the Safe Experience Mode. Request id: secret-request-id',
      },
    });

    expect(message).toContain('安心体验');
    expect(message).toContain('服务已暂停');
    expect(message).toContain('按量计费');
    expect(message).not.toContain('2112711966');
    expect(message).not.toContain('secret-request-id');
  });

  it('turns a model permission 403 into an actionable error without request metadata', () => {
    const message = formatArkErrorMessage('完整 Logo 图片生成模型', 403, {
      error: {
        code: 'AccessDenied',
        message: 'The request failed because you do not have access to the requested resource. Request id: secret-request-id',
      },
    });

    expect(message).toContain('API Key');
    expect(message).toContain('请求的 Seedream 模型');
    expect(message).toContain('模型权限');
    expect(message).not.toContain('secret-request-id');
  });
});
