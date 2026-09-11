import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { prepareTaskArtwork } from '@/lib/server/media-kit-artwork';
import {
  assessArtworkResolution,
  buildCanonicalArtworkModelPrompt,
  buildArtworkComponentPlan,
  compositionTextSegments,
  decideArtworkProcessingRoute,
  describeArtworkComposition,
  parseArtworkPreparationRequest,
  recommendedEnhancement,
  requiresCompleteModelComposition,
} from '@/lib/task-review-artwork';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MEDIAKIT_API_KEY;
  delete process.env.ARK_RUNTIME_API_KEY;
});

describe('task review artwork preparation contract', () => {
  it('validates one source image and keeps exact text separate', () => {
    const request = parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: 'Logo 改绿色，下方加文字',
      exactText: 'poppy手机数码',
      layoutNote: '图上字下',
      enhancementMode: 'auto',
      image: {
        fileName: 'logo.png',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,cG5n',
      },
    });

    expect(request.exactText).toBe('poppy手机数码');
    expect(request.image.fileName).toBe('logo.png');
    expect(request.enhancementMode).toBe('auto');
  });

  it('builds one auditable Seedream prompt with the real WPS-to-model image mapping', () => {
    const canonical = buildCanonicalArtworkModelPrompt({
      sourceRequirementText: '货号:719SF-黑色 B01SD-月牙白-L 左胸: 冲锋衣:图一 POLO衫:研+图5+2026【参考图四】',
      instruction: 'B01SD 月牙白 POLO 左胸按 WPS 原文制作：文字“研”＋图5＋文字“2026”；图4按原文仅作参考，不进入成品。',
      exactText: '研 2026',
      layoutNote: '原文明示顺序：“研”→图5→“2026”；图4按原文仅作参考，不进入成品；原文未说明大小、间距、对齐或颜色。',
      sourceScope: 'subject',
      primaryImageLabel: '图5',
      referenceImageLabels: ['图4'],
    });

    expect(canonical.imageMapping).toEqual([
      expect.objectContaining({ sourceLabel: '图5', modelInputLabel: '图1', role: 'content' }),
      expect.objectContaining({ sourceLabel: '图4', modelInputLabel: '图2', role: 'reference' }),
    ]);
    expect(canonical.prompt).toContain('模型输入图1 = WPS 图5');
    expect(canonical.prompt).toContain('模型输入图2 = WPS 图4');
    expect(canonical.prompt).toContain('需要新增的准确文字为“研 2026”');
    expect(canonical.prompt).toContain('【WPS 原文｜唯一客户事实】');
    expect(canonical.prompt).toContain('本生成单元的结构化解释｜系统生成');
    expect(canonical.prompt).not.toContain('“研”是尺寸最大的主视觉');
    expect(canonical.prompt).not.toContain('深黑或深色单色');
    expect(canonical.prompt).toContain('纯白背景（#FFFFFF）的 PNG');
    expect(canonical.prompt).toContain('后续由独立抠图步骤移除背景');
    expect(canonical.prompt).toContain('Logo 内部原有白色与其他细节保持原样');
    expect(canonical.prompt).not.toContain('真实 Alpha 通道的透明 PNG');
    expect(canonical.prompt).not.toContain('使用系统指定的均匀纯色抠像底');
    expect(canonical.version).toBe('task-review-artwork-v11');
    expect(canonical.promptHash).toMatch(/^fnv1a-[0-9a-f]{8}$/u);
  });

  it('uses explicit, non-official P0 thresholds for automatic routing', () => {
    const highResolution = assessArtworkResolution({ subjectWidth: 1000, subjectHeight: 1000 });
    const mediumResolution = assessArtworkResolution({ subjectWidth: 800, subjectHeight: 800 });
    expect(recommendedEnhancement({
      sourceWidth: 1200,
      sourceHeight: 1000,
      resolution: highResolution,
      quality: { vqscore: 80, blur: 18, noise: 90, compressionArtifacts: 4 },
      preserveGeometry: false,
    }).enhancement).toBe('none');
    expect(recommendedEnhancement({
      sourceWidth: 800,
      sourceHeight: 800,
      resolution: mediumResolution,
      quality: { vqscore: 60, blur: 40, noise: 70, compressionArtifacts: 20 },
      preserveGeometry: false,
    }).enhancement).toBe('standard');
    expect(recommendedEnhancement({
      sourceWidth: 800,
      sourceHeight: 800,
      resolution: mediumResolution,
      quality: { vqscore: 38, blur: 60, noise: 50, compressionArtifacts: 50 },
      preserveGeometry: false,
    }).enhancement).toBe('professional');
  });

  it('grades resolution from the visible subject rather than the white canvas', () => {
    expect(assessArtworkResolution({ subjectWidth: 1000, subjectHeight: 900 })).toMatchObject({
      level: 'usable',
      requiredScale: 1,
    });
    expect(assessArtworkResolution({ subjectWidth: 256, subjectHeight: 256 })).toMatchObject({
      level: 'low',
      requiredScale: 3.91,
    });
    expect(assessArtworkResolution({ subjectWidth: 150, subjectHeight: 120 })).toMatchObject({
      level: 'severe',
      requiredScale: 6.67,
    });
  });

  it('routes a whole-layout reference to one complete model generation', () => {
    const request = parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: 'POLO 衫左胸：“研”+图5+“2026”，排版参考图4。',
      exactText: '研 2026',
      layoutNote: '按参考图4排版，中间加图5',
      image: { fileName: '图5.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,cG5n' },
      primaryImageLabel: '图5',
      referenceImages: [{
        label: '图4',
        image: { fileName: '图4.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,cG5n' },
      }],
    });
    const decision = decideArtworkProcessingRoute({
      request,
      resolution: assessArtworkResolution({ subjectWidth: 147, subjectHeight: 64 }),
    });
    expect(decision).toMatchObject({
      route: 'model',
      userOverride: false,
      reasons: [
        '参考图同时决定图形与文字的整体版式、比例或视觉层级',
        '拆成独立组件会丢失完整构图关系，应把主要素材、参考图和完整要求一次交给模型',
      ],
    });
    expect(compositionTextSegments(request)).toEqual(['研', '2026']);
    expect(buildArtworkComponentPlan({
      request,
      resolution: assessArtworkResolution({ subjectWidth: 147, subjectHeight: 64 }),
      route: decision,
    })).toMatchObject({
      graphic: { label: '图5', method: 'model-rebuild-graphic' },
      texts: [
        { value: '研', method: 'deterministic-text', referenceLabels: [] },
        { value: '2026', method: 'deterministic-text', referenceLabels: [] },
      ],
      references: [{ label: '图4', method: 'reference-only', roles: ['style', 'layout'] }],
      sequence: [
        { kind: 'text', id: 'text-1' },
        { kind: 'graphic', label: '图5' },
        { kind: 'text', id: 'text-2' },
      ],
    });
  });

  it('keeps a single special-text style reference on the hybrid route', () => {
    const request = parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: '保留图1校徽，新增文字参考图2的书法字形。',
      exactText: '宜宾学院',
      layoutNote: '字体风格参考图2',
      image: { fileName: '图1.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,cG5n' },
      referenceImages: [{
        label: '图2',
        image: { fileName: '图2.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,cG5n' },
      }],
    });
    expect(decideArtworkProcessingRoute({
      request,
      resolution: assessArtworkResolution({ subjectWidth: 800, subjectHeight: 800 }),
    })).toMatchObject({ route: 'hybrid', userOverride: false });
  });

  it('uses the same ordered component interpretation for the UI and processing route', () => {
    expect(describeArtworkComposition({
      instruction: 'B01SD 月牙白 POLO 左胸制作一张完整图案：文字“研”在前，图5的宜宾学院中英文横版标志居中，文字“2026”在后；图4仅作特殊字形风格和排版参考，不进入成品。',
      exactText: '研 2026',
      layoutNote: '成品顺序为“研”→图5主体→“2026”；图4仅参考字形风格与排版',
      primaryImageLabel: '图5',
      referenceImageLabels: ['图4'],
    })).toMatchObject({
      textSegments: ['研', '2026'],
      sequence: [
        { kind: 'text', value: '研' },
        { kind: 'graphic', label: '图5' },
        { kind: 'text', value: '2026' },
      ],
      summary: [
        '图5：进入成品的主体图形',
        '文字“研”：进入成品的独立文字组件',
        '文字“2026”：进入成品的独立文字组件',
        '图4：仅作字体/风格与排版参考，不进入成品',
        '成品顺序：文字“研” ＋ 图5主体 ＋ 文字“2026”',
      ],
    });
  });

  it('exposes the whole-composition decision to the pre-generation UI', () => {
    expect(requiresCompleteModelComposition({
      instruction: 'B01SD 月牙白 POLO 左胸制作一张完整图案：文字“研”在前，图5主体居中，文字“2026”在后。',
      exactText: '研 2026',
      layoutNote: '图4决定整体字形风格、视觉层级、相对比例和紧凑排版',
      primaryImageLabel: '图5',
      referenceImageLabels: ['图4'],
    })).toBe(true);
    expect(requiresCompleteModelComposition({
      instruction: '保留图1校徽，新增文字参考图2的书法字形。',
      exactText: '宜宾学院',
      layoutNote: '文字放在图1右侧；只参考图2的字体风格',
      primaryImageLabel: '图1',
      referenceImageLabels: ['图2'],
    })).toBe(false);
  });

  it('splits two explicit text lines around a graphic in the requested order', () => {
    expect(describeArtworkComposition({
      instruction: '顶部将“宜宾学院研究生会志愿者”排成扇形，中间放图2，底部排“奉献、友爱、互助、进步”。',
      exactText: '宜宾学院研究生会志愿者\n奉献、友爱、互助、进步',
      layoutNote: '第一行扇形；中间放图2；底部放口号',
      primaryImageLabel: '图2',
      referenceImageLabels: [],
    }).sequence).toEqual([
      { kind: 'text', value: '宜宾学院研究生会志愿者' },
      { kind: 'graphic', label: '图2' },
      { kind: 'text', value: '奉献、友爱、互助、进步' },
    ]);
  });

  it('keeps a readable logo with a style reference on the hybrid route', () => {
    const request = parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: '保留图1校徽，新增文字参考图2的书法字形。',
      exactText: '宜宾学院',
      layoutNote: '字体风格参考图2',
      image: { fileName: '图1.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,cG5n' },
      referenceImages: [{
        label: '图2',
        image: { fileName: '图2.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,cG5n' },
      }],
    });
    expect(decideArtworkProcessingRoute({
      request,
      resolution: assessArtworkResolution({ subjectWidth: 800, subjectHeight: 800 }),
    })).toMatchObject({ route: 'hybrid', userOverride: false });
  });
});

describe('MediaKit artwork preparation adapter', () => {
  it('automatically sends the content source and whole-layout reference into one complete model generation', async () => {
    const source = await sharp({
      create: { width: 147, height: 64, channels: 3, background: '#ffffff' },
    }).composite([{
      input: await sharp({
        create: { width: 105, height: 28, channels: 4, background: '#777777' },
      }).png().toBuffer(),
      left: 21,
      top: 18,
    }]).png().toBuffer();
    const reference = await sharp({
      create: { width: 320, height: 320, channels: 3, background: '#eeeeee' },
    }).png().toBuffer();
    const generated = await sharp({
      create: { width: 512, height: 512, channels: 3, background: '#ffffff' },
    }).composite([{
      input: await sharp({
        create: { width: 260, height: 120, channels: 4, background: '#183f82' },
      }).png().toBuffer(),
      left: 126,
      top: 196,
    }]).png().toBuffer();
    const urls: string[] = [];
    const imageGenerationBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/chat/completions')) {
        return Response.json({ choices: [{ message: { content: JSON.stringify({
          summary: '图2主体配合图1排版，生成研 2026',
          source: {
            keep: ['图2横版标志'],
            remove: ['图2原文字'],
            visibleText: ['图2宜宾学院'],
            colorReference: '图1排版风格',
          },
          output: {
            description: '研、图2标志、2026组成完整图案',
            targetText: '研 2026',
            layout: '研在左，图形居中，2026在右',
            background: '纯白背景',
          },
          ambiguities: [],
          canGenerate: true,
          generationPrompt: '生成完整图案',
        }) } }] });
      }
      if (url.endsWith('/images/generations')) {
        imageGenerationBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ data: [{ url: 'https://result.example.com/model-artwork.png' }] });
      }
      if (url === 'https://result.example.com/model-artwork.png') {
        return new Response(new Uint8Array(generated), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`未预期请求：${url}`);
    }));
    process.env.ARK_RUNTIME_API_KEY = 'test-ark-key';

    const result = await prepareTaskArtwork(parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: 'POLO 衫左胸：“研”+图5+“2026”，排版参考图4。',
      exactText: '研 2026',
      layoutNote: '图4决定整体字形风格、视觉层级、相对比例和紧凑排版；成品顺序为“研”→图5主体→“2026”',
      image: {
        fileName: '图5.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${source.toString('base64')}`,
      },
      primaryImageLabel: '图5',
      referenceImages: [{
        label: '图4',
        image: {
          fileName: '图4.png',
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${reference.toString('base64')}`,
        },
      }],
      processingRoute: 'auto',
    }));

    expect(result.preprocessing.route.route).toBe('model');
    expect(result.preprocessing.route.userOverride).toBe(false);
    expect(result.preprocessing.generationModel).toBe('doubao-seedream-4-0-250828');
    expect(result.draft.mode).toBe('legacyFlattened');
    expect(urls.some((url) => url.includes('mediakit.cn-beijing.volces.com'))).toBe(false);
    expect(imageGenerationBodies).toHaveLength(1);
    expect(imageGenerationBodies[0].image).toEqual([
      `data:image/png;base64,${source.toString('base64')}`,
      `data:image/png;base64,${reference.toString('base64')}`,
      expect.stringMatching(/^data:image\/png;base64,/),
    ]);
    const canonical = buildCanonicalArtworkModelPrompt({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: 'POLO 衫左胸：“研”+图5+“2026”，排版参考图4。',
      exactText: '研 2026',
      layoutNote: '图4决定整体字形风格、视觉层级、相对比例和紧凑排版；成品顺序为“研”→图5主体→“2026”',
      sourceScope: 'subject',
      primaryImageLabel: '图5',
      referenceImageLabels: ['图4'],
    });
    expect(imageGenerationBodies[0].prompt).toBe(canonical.prompt);
    expect(result.preprocessing.resolvedPrompt).toBe(canonical.prompt);
    expect(result.preprocessing.promptVersion).toBe(canonical.version);
    expect(result.preprocessing.promptHash).toBe(canonical.promptHash);
    expect(result.preprocessing.imageMapping).toEqual(canonical.imageMapping);
  });

  it('stops before any paid model call when the displayed prompt hash is stale', async () => {
    const source = await sharp({
      create: { width: 320, height: 320, channels: 3, background: '#ffffff' },
    }).composite([{
      input: await sharp({
        create: { width: 180, height: 120, channels: 4, background: '#173b78' },
      }).png().toBuffer(),
      left: 70,
      top: 100,
    }]).png().toBuffer();
    const reference = await sharp({
      create: { width: 320, height: 320, channels: 3, background: '#eeeeee' },
    }).png().toBuffer();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(prepareTaskArtwork(parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: 'POLO 衫左胸：“研”+图5+“2026”，排版参考图4。',
      exactText: '研 2026',
      layoutNote: '图4决定整体字形风格、视觉层级和排版；成品顺序为“研”→图5主体→“2026”',
      image: {
        fileName: '图5.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${source.toString('base64')}`,
      },
      primaryImageLabel: '图5',
      referenceImages: [{
        label: '图4',
        image: {
          fileName: '图4.png',
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${reference.toString('base64')}`,
        },
      }],
      processingRoute: 'model',
      expectedPromptVersion: 'task-review-artwork-v11',
      expectedPromptHash: 'fnv1a-deadbeef',
    }))).rejects.toThrow('页面显示的制作要求与服务端最终要求不一致');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('processes the main logo and special text independently on the hybrid route', async () => {
    const source = await sharp({
      create: { width: 1200, height: 1200, channels: 4, background: '#ffffff' },
    }).composite([{
      input: await sharp({
        create: { width: 900, height: 600, channels: 4, background: '#2f3742' },
      }).png().toBuffer(),
      left: 150,
      top: 300,
    }]).png().toBuffer();
    const reference = await sharp({
      create: { width: 640, height: 480, channels: 3, background: '#eeeeee' },
    }).png().toBuffer();
    const generatedText = await sharp({
      create: { width: 512, height: 512, channels: 3, background: '#ffffff' },
    }).composite([{
      input: await sharp({
        create: { width: 220, height: 180, channels: 4, background: '#111111' },
      }).png().toBuffer(),
      left: 146,
      top: 166,
    }]).png().toBuffer();
    const generationBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/request-media-upload-url')) {
        return Response.json({
          success: true,
          result: {
            file_id: 'mediakit://hybrid-logo',
            upload_url: 'https://upload.example.com/hybrid-logo',
            upload_headers: [],
          },
        });
      }
      if (url === 'https://upload.example.com/hybrid-logo') return new Response(null, { status: 200 });
      if (url.endsWith('/evaluate-image-quality')) {
        return Response.json({
          success: true,
          result: { tool_version: 'standard', vqscore: 88, blur: 10, noise: 90, cmartifacts: 2 },
        });
      }
      if (url.endsWith('/images/generations')) {
        generationBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ data: [{ url: 'https://result.example.com/styled-text.png' }] });
      }
      if (url === 'https://result.example.com/styled-text.png') {
        return new Response(new Uint8Array(generatedText), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`未预期请求：${url}`);
    }));
    process.env.MEDIAKIT_API_KEY = 'test-mediakit-key';
    process.env.ARK_RUNTIME_API_KEY = 'test-ark-key';

    const result = await prepareTaskArtwork(parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本', enhancementMode: 'none',
      instruction: '保留图5的宜宾学院标志，新增文字“研究生会”，文字参考图4的书法字形。',
      exactText: '研究生会',
      layoutNote: '文字放在图5右侧；只参考图4的字体风格',
      image: {
        fileName: '图5.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${source.toString('base64')}`,
      },
      primaryImageLabel: '图5',
      referenceImages: [{
        label: '图4',
        image: {
          fileName: '图4.png',
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${reference.toString('base64')}`,
        },
      }],
    }));

    expect(result.preprocessing.route.route).toBe('hybrid');
    expect(result.preprocessing.componentPlan.references).toEqual([
      { label: '图4', method: 'reference-only', roles: ['style', 'layout'] },
    ]);
    expect(result.draft.mode).toBe('structured');
    expect(result.draft.graphic.role).toBe('logo');
    expect(result.draft.extraGraphics?.map((graphic) => ({ role: graphic.role, text: graphic.textValue }))).toEqual([
      { role: 'styledText', text: '研究生会' },
    ]);
    expect(generationBodies).toHaveLength(1);
    expect(generationBodies.every((body) => Array.isArray(body.image) && body.image.length === 2)).toBe(true);
    expect(String(generationBodies[0].prompt)).toContain('唯一允许出现的文字是“研究生会”');
  });

  it('uploads, evaluates, enhances, removes background and persists the result as a data URL', async () => {
    const sourcePixels = Buffer.alloc(320 * 320 * 3);
    for (let y = 0; y < 320; y += 1) {
      for (let x = 0; x < 320; x += 1) {
        const offset = (y * 320 + x) * 3;
        sourcePixels[offset] = (x * 17 + y * 7) % 256;
        sourcePixels[offset + 1] = (x * 3 + y * 19) % 256;
        sourcePixels[offset + 2] = (x * 13 + y * 11) % 256;
      }
    }
    const source = await sharp(sourcePixels, {
      raw: { width: 320, height: 320, channels: 3 },
    }).png().toBuffer();
    const transparent = await sharp({
      create: { width: 80, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{
      input: await sharp({
        create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 90, b: 40, alpha: 1 } },
      }).png().toBuffer(),
      left: 20,
      top: 20,
    }]).png().toBuffer();
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : null;
      calls.push({ url, body });
      if (url.endsWith('/request-media-upload-url')) {
        return Response.json({
          success: true,
          result: {
            file_id: 'mediakit://source-file',
            upload_url: 'https://upload.example.com/source',
            upload_headers: [],
          },
        });
      }
      if (url === 'https://upload.example.com/source') return new Response(null, { status: 200 });
      if (url.endsWith('/evaluate-image-quality')) {
        return Response.json({
          success: true,
          result: { tool_version: 'standard', vqscore: 60, blur: 40, noise: 80, cmartifacts: 10 },
        });
      }
      if (url.endsWith('/enhance-image')) {
        return Response.json({ success: true, result: { image_url: 'https://result.example.com/enhanced.png' } });
      }
      if (url.endsWith('/remove-image-background')) {
        return Response.json({ success: true, result: { image_url: 'https://result.example.com/transparent.png' } });
      }
      if (url === 'https://result.example.com/transparent.png') {
        return new Response(new Uint8Array(transparent), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`未预期请求：${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.MEDIAKIT_API_KEY = 'test-mediakit-key';

    const result = await prepareTaskArtwork(parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: 'Logo 改绿色，下方加文字',
      exactText: 'poppy手机数码',
      layoutNote: '图上字下',
      enhancementMode: 'auto',
      image: {
        fileName: 'logo.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${source.toString('base64')}`,
      },
    }));

    expect(result.preprocessing.enhancement).toBe('professional');
    expect(result.draft.mode).toBe('structured');
    expect(result.draft.text?.value).toBe('poppy手机数码');
    expect(result.draft.graphic.sourceUrl).toMatch(/^data:image\/png;base64,/u);
    expect(result.draft.graphic.recolorMaskUrl).toMatch(/^data:image\/png;base64,/u);
    expect(calls.find((call) => call.url.endsWith('/enhance-image'))?.body).toEqual({
      image_url: 'mediakit://source-file',
      tool_version: 'professional',
      multiple: 2,
      generative_enhance_mode: 'fidelity_first',
    });
    expect(calls.find((call) => call.url.endsWith('/remove-image-background'))?.body).toEqual({
      image_url: 'https://result.example.com/enhanced.png',
      scene: 'product',
      need_contour: false,
      need_crop_background: true,
      output_format: 'png',
    });
  });

  it('evaluates a clear flat-background graphic and keeps its cutout deterministic', async () => {
    const source = await sharp({
      create: { width: 1200, height: 1200, channels: 4, background: '#35ae5f' },
    }).composite([{
      input: await sharp({
        create: { width: 900, height: 900, channels: 4, background: '#111111' },
      }).png().toBuffer(),
      left: 150,
      top: 150,
    }]).png().toBuffer();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/request-media-upload-url')) {
        return Response.json({
          success: true,
          result: {
            file_id: 'mediakit://flat-source',
            upload_url: 'https://upload.example.com/flat-source',
            upload_headers: [],
          },
        });
      }
      if (url === 'https://upload.example.com/flat-source') return new Response(null, { status: 200 });
      if (url.endsWith('/evaluate-image-quality')) {
        return Response.json({
          success: true,
          result: { tool_version: 'standard', vqscore: 82, blur: 20, noise: 90, cmartifacts: 4 },
        });
      }
      throw new Error(`未预期请求：${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.MEDIAKIT_API_KEY = 'test-mediakit-key';

    const result = await prepareTaskArtwork(parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: '保留主体，Logo 改绿色',
      exactText: '',
      layoutNote: '',
      enhancementMode: 'none',
      image: {
        fileName: 'flat-logo.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${source.toString('base64')}`,
      },
    }));

    expect(result.preprocessing).toMatchObject({
      evaluation: null,
      enhancement: 'none',
      backgroundRemoval: 'edge-connected',
      sourceKind: 'flat-background',
      resolution: { level: 'usable' },
    });
    expect(calls.some((url) => url.endsWith('/enhance-image'))).toBe(false);
    expect(calls.some((url) => url.endsWith('/remove-image-background'))).toBe(false);
    expect(result.draft.graphic.recolorMaskUrl).toMatch(/^data:image\/png;base64,/u);
  });

  it('routes the real low-resolution school badge through professional fidelity enhancement before local cutout', async () => {
    const source = await sharp('public/task-review-originals/row2-1.png').png().toBuffer();
    let uploadedBadge: Buffer | null = null;
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : null;
      calls.push({ url, body });
      if (url.endsWith('/request-media-upload-url')) {
        return Response.json({
          success: true,
          result: {
            file_id: 'mediakit://badge-source',
            upload_url: 'https://upload.example.com/badge-source',
            upload_headers: [],
          },
        });
      }
      if (url === 'https://upload.example.com/badge-source') {
        if (!(init?.body instanceof Uint8Array)) throw new Error('校徽测试没有收到 PNG 上传内容');
        uploadedBadge = Buffer.from(init.body);
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/evaluate-image-quality')) {
        return Response.json({
          success: true,
          result: { tool_version: 'standard', vqscore: 82, blur: 20, noise: 90, cmartifacts: 4 },
        });
      }
      if (url.endsWith('/enhance-image')) {
        return Response.json({ success: true, result: { image_url: 'https://result.example.com/badge-enhanced.png' } });
      }
      if (url === 'https://result.example.com/badge-enhanced.png') {
        if (!uploadedBadge) throw new Error('校徽增强前没有记录裁剪输入');
        const metadata = await sharp(uploadedBadge).metadata();
        if (!metadata.width || !metadata.height) throw new Error('校徽裁剪输入缺少尺寸');
        const enhanced = await sharp(uploadedBadge)
          .resize({ width: metadata.width * 2, height: metadata.height * 2, fit: 'fill' })
          .png()
          .toBuffer();
        return new Response(new Uint8Array(enhanced), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`未预期请求：${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.MEDIAKIT_API_KEY = 'test-mediakit-key';

    const result = await prepareTaskArtwork(parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: '冲锋衣左胸使用图1校徽，保留校徽内文字和圆形边框，去掉外围白底。',
      exactText: '',
      layoutNote: '',
      enhancementMode: 'auto',
      processingRoute: 'fidelity',
      sourceScope: 'subject',
      image: {
        fileName: 'row2-1.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${source.toString('base64')}`,
      },
    }));

    expect(result.preprocessing).toMatchObject({
      enhancement: 'professional',
      backgroundRemoval: 'edge-connected',
      sourceKind: 'flat-background',
      resolution: {
        level: 'low',
        subjectWidth: 256,
        subjectHeight: 256,
        requiredScale: 3.91,
      },
    });
    expect(calls.find((call) => call.url.endsWith('/enhance-image'))?.body).toEqual({
      image_url: 'mediakit://badge-source',
      tool_version: 'professional',
      multiple: 2,
      generative_enhance_mode: 'fidelity_first',
    });
    expect(calls.some((call) => call.url.endsWith('/remove-image-background'))).toBe(false);
  });

  it('crops the real oversized green canvas before professional logo enhancement', async () => {
    const source = await sharp('public/task-review-originals/row1-1.png').png().toBuffer();
    let uploadedSubject: Buffer | null = null;
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : null;
      calls.push({ url, body });
      if (url.endsWith('/request-media-upload-url')) {
        return Response.json({
          success: true,
          result: {
            file_id: 'mediakit://cropped-hand',
            upload_url: 'https://upload.example.com/cropped-hand',
            upload_headers: [],
          },
        });
      }
      if (url === 'https://upload.example.com/cropped-hand') {
        if (!(init?.body instanceof Uint8Array)) throw new Error('手势测试没有收到 PNG 上传内容');
        uploadedSubject = Buffer.from(init.body);
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/evaluate-image-quality')) {
        return Response.json({
          success: true,
          result: { tool_version: 'standard', vqscore: 52, blur: 38, noise: 82, cmartifacts: 4 },
        });
      }
      if (url.endsWith('/enhance-image')) {
        return Response.json({ success: true, result: { image_url: 'https://result.example.com/hand-enhanced.png' } });
      }
      if (url === 'https://result.example.com/hand-enhanced.png') {
        if (!uploadedSubject) throw new Error('手势增强前没有记录裁剪输入');
        const metadata = await sharp(uploadedSubject).metadata();
        if (!metadata.width || !metadata.height) throw new Error('手势裁剪输入缺少尺寸');
        const enhanced = await sharp(uploadedSubject)
          .resize({ width: metadata.width * 2, height: metadata.height * 2, fit: 'fill' })
          .png()
          .toBuffer();
        return new Response(new Uint8Array(enhanced), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`未预期请求：${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.MEDIAKIT_API_KEY = 'test-mediakit-key';

    const result = await prepareTaskArtwork(parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: '左胸使用图1中的手势 Logo，去掉绿色背景，保留音符和手势内部细节，整体改为绿色。',
      exactText: 'poppy手机数码',
      layoutNote: 'Logo 在左，文字在右',
      enhancementMode: 'auto',
      sourceScope: 'subject',
      image: {
        fileName: 'row1-1.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${source.toString('base64')}`,
      },
    }));

    if (!uploadedSubject) throw new Error('手势测试缺少裁剪输入');
    const uploadedMetadata = await sharp(uploadedSubject).metadata();
    expect(uploadedMetadata.width).toBeGreaterThanOrEqual(256);
    expect(uploadedMetadata.height).toBeGreaterThanOrEqual(256);
    expect(Math.max(uploadedMetadata.width ?? 0, uploadedMetadata.height ?? 0)).toBeLessThanOrEqual(2048);
    expect(uploadedMetadata.height).toBeLessThan(2272);
    expect(result.preprocessing).toMatchObject({
      enhancement: 'professional',
      backgroundRemoval: 'edge-connected',
      sourceKind: 'flat-background',
    });
    expect(result.preprocessing.decisionRule).toContain('增强前已按全部前景安全裁剪');
    expect(calls.find((call) => call.url.endsWith('/enhance-image'))?.body).toEqual({
      image_url: 'mediakit://cropped-hand',
      tool_version: 'professional',
      multiple: 2,
      generative_enhance_mode: 'fidelity_first',
    });
    expect(calls.some((call) => call.url.endsWith('/remove-image-background'))).toBe(false);
  });

  it('pads the real 147x64 wordmark before professional fidelity enhancement', async () => {
    const source = await sharp('public/task-review-originals/row2-5.png').png().toBuffer();
    let uploadedWordmark: Buffer | null = null;
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : null;
      calls.push({ url, body });
      if (url.endsWith('/request-media-upload-url')) {
        return Response.json({
          success: true,
          result: {
            file_id: 'mediakit://padded-wordmark',
            upload_url: 'https://upload.example.com/padded-wordmark',
            upload_headers: [],
          },
        });
      }
      if (url === 'https://upload.example.com/padded-wordmark') {
        if (!(init?.body instanceof Uint8Array)) throw new Error('文字标测试没有收到 PNG 上传内容');
        uploadedWordmark = Buffer.from(init.body);
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/evaluate-image-quality')) {
        return Response.json({
          success: true,
          result: { tool_version: 'standard', vqscore: 82, blur: 20, noise: 90, cmartifacts: 4 },
        });
      }
      if (url.endsWith('/enhance-image')) {
        return Response.json({ success: true, result: { image_url: 'https://result.example.com/wordmark-enhanced.png' } });
      }
      if (url === 'https://result.example.com/wordmark-enhanced.png') {
        if (!uploadedWordmark) throw new Error('文字标增强前没有记录补边输入');
        const metadata = await sharp(uploadedWordmark).metadata();
        if (!metadata.width || !metadata.height) throw new Error('文字标补边输入缺少尺寸');
        const enhanced = await sharp(uploadedWordmark)
          .resize({ width: metadata.width * 2, height: metadata.height * 2, fit: 'fill' })
          .png()
          .toBuffer();
        return new Response(new Uint8Array(enhanced), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`未预期请求：${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.MEDIAKIT_API_KEY = 'test-mediakit-key';

    const result = await prepareTaskArtwork(parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: 'POLO 衫左胸：“研”+图5+“2026”，排版参考图4。',
      exactText: '研 2026',
      layoutNote: '按参考图4排版，中间加图5',
      enhancementMode: 'auto',
      processingRoute: 'fidelity',
      sourceScope: 'subject',
      image: {
        fileName: 'row2-5.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${source.toString('base64')}`,
      },
    }));

    if (!uploadedWordmark) throw new Error('文字标测试缺少补边输入');
    const uploadedMetadata = await sharp(uploadedWordmark).metadata();
    expect(uploadedMetadata.width).toBeGreaterThanOrEqual(256);
    expect(uploadedMetadata.height).toBeGreaterThanOrEqual(256);
    expect(result.preprocessing).toMatchObject({
      enhancement: 'professional',
      backgroundRemoval: 'edge-connected',
      sourceKind: 'flat-background',
      resolution: { level: 'severe' },
    });
    expect(calls.find((call) => call.url.endsWith('/enhance-image'))?.body).toEqual({
      image_url: 'mediakit://padded-wordmark',
      tool_version: 'professional',
      multiple: 2,
      generative_enhance_mode: 'fidelity_first',
    });
    expect(calls.some((call) => call.url.endsWith('/remove-image-background'))).toBe(false);
  });

  it('rejects whole-image routing unless the requirement explicitly keeps the full canvas', async () => {
    const source = await sharp({
      create: { width: 320, height: 320, channels: 3, background: '#ffffff' },
    }).png().toBuffer();

    await expect(prepareTaskArtwork(parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: '左胸使用图1校徽。',
      exactText: '',
      layoutNote: '',
      enhancementMode: 'auto',
      sourceScope: 'wholeImage',
      image: {
        fileName: 'badge.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${source.toString('base64')}`,
      },
    }))).rejects.toThrow('wholeImage 必须有明确的整图原样使用要求');
  });

  it('uploads a correctly oriented resized copy before standard enhancement for an oversized portrait', async () => {
    const width = 1280;
    const height = 2272;
    const sourcePixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        sourcePixels[offset] = (x * 17 + y * 7) % 256;
        sourcePixels[offset + 1] = (x * 3 + y * 19) % 256;
        sourcePixels[offset + 2] = (x * 13 + y * 11) % 256;
      }
    }
    const source = await sharp(sourcePixels, {
      raw: { width, height, channels: 3 },
    }).png().toBuffer();
    const transparent = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{
      input: await sharp({
        create: { width: 60, height: 60, channels: 4, background: { r: 20, g: 100, b: 50, alpha: 1 } },
      }).png().toBuffer(),
      left: 20,
      top: 20,
    }]).png().toBuffer();
    const uploadedImages: Buffer[] = [];
    const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    let uploadRequestCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : null;
      requests.push({ url, body });
      if (url.endsWith('/request-media-upload-url')) {
        const suffix = uploadRequestCount === 0 ? 'source' : 'resized';
        uploadRequestCount += 1;
        return Response.json({
          success: true,
          result: {
            file_id: `mediakit://${suffix}-file`,
            upload_url: `https://upload.example.com/${suffix}`,
            upload_headers: [],
          },
        });
      }
      if (url.startsWith('https://upload.example.com/')) {
        if (!(init?.body instanceof Uint8Array)) throw new Error(`上传体不是 Uint8Array：${typeof init?.body}`);
        uploadedImages.push(Buffer.from(init.body));
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/evaluate-image-quality')) {
        return Response.json({
          success: true,
          result: { tool_version: 'standard', vqscore: 60, blur: 40, noise: 80, cmartifacts: 10 },
        });
      }
      if (url.endsWith('/enhance-image')) {
        return Response.json({ success: true, result: { image_url: 'https://result.example.com/enhanced-large.png' } });
      }
      if (url.endsWith('/remove-image-background')) {
        return Response.json({ success: true, result: { image_url: 'https://result.example.com/transparent-large.png' } });
      }
      if (url === 'https://result.example.com/transparent-large.png') {
        return new Response(new Uint8Array(transparent), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`未预期请求：${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.MEDIAKIT_API_KEY = 'test-mediakit-key';

    await prepareTaskArtwork(parseArtworkPreparationRequest({
      sourceRequirementText: 'WPS 原始需求测试文本',
      instruction: '保留主体并去掉复杂背景',
      exactText: '',
      layoutNote: '',
      enhancementMode: 'standard',
      image: {
        fileName: 'portrait.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${source.toString('base64')}`,
      },
    }));

    expect(uploadedImages).toHaveLength(2);
    expect(await sharp(uploadedImages[1]).metadata()).toMatchObject({ width: 1217, height: 2160 });
    expect(requests.find((request) => request.url.endsWith('/enhance-image'))?.body).toMatchObject({
      image_url: 'mediakit://resized-file',
      tool_version: 'standard',
      multiple: 2,
    });
  }, 20_000);
});
