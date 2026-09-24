import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'vitest';

import sharp from 'sharp';

import type {
  LogoRedrawAnalysis,
  LogoRedrawGenerateRequest,
} from '../garment-editor/mockup-logo-redraw';
import {
  formatLogoRedrawArkError,
  generateMockupLogoRedraw,
  understandMockupLogoRedraw,
} from './ark-garment-logo-redraw';

const tinyReference = `data:image/png;base64,${Buffer.from('reference').toString('base64')}`;
const analysis: LogoRedrawAnalysis = {
  status: 'ready_for_confirmation',
  summary: '盾牌在左、NORTHLAB 在右的深绿色完整 Logo。',
  keep: ['图1盾牌结构'],
  change: ['文字改为 NORTHLAB', '颜色改为深绿色'],
  output: {
    description: '盾牌与 NORTHLAB 组成的完整 Logo',
    targetText: 'NORTHLAB',
    color: '深绿色',
    layout: '盾牌在左，文字在右',
    background: '透明背景',
  },
  ambiguities: [],
  confidence: { text: 'high', color: 'high', structure: 'medium' },
  generationPrompt: '生成盾牌与 NORTHLAB 组成的完整 Logo',
};

test('understanding calls only the analysis model and supports zero reference images', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const result = await understandMockupLogoRedraw(
    { instruction: '生成深绿色 NORTHLAB 盾牌 Logo', images: [] },
    {
      env: { ARK_RUNTIME_API_KEY: 'test-key' },
      fetchImplementation: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(analysis) } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    }
  );

  assert.equal(result.analysis.status, 'ready_for_confirmation');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /chat\/completions$/);
  assert.equal(requests[0].body.model, 'doubao-seed-2-0-lite-260215');
  const messages = requests[0].body.messages as Array<Record<string, unknown>>;
  const content = messages[0].content as Array<Record<string, unknown>>;
  assert.equal(content.filter(item => item.type === 'image_url').length, 0);
});

test('generation performs one Seedream call, appends a text guide, and omits 5.0-only fields for Seedream 4.0', async () => {
  const generatedPng = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 4,
      background: { r: 255, g: 0, b: 255, alpha: 1 },
    },
  }).composite([{
    input: {
      create: {
        width: 4,
        height: 4,
        channels: 4,
        background: { r: 0, g: 80, b: 70, alpha: 1 },
      },
    },
    left: 2,
    top: 2,
  }]).png().toBuffer();
  const generationBodies: Record<string, unknown>[] = [];
  const request: LogoRedrawGenerateRequest = {
    instruction: '按参考图盾牌生成 NORTHLAB Logo',
    images: [{ fileName: '盾牌.png', base64Image: tinyReference }],
    confirmed: true,
    analysis,
  };

  const result = await generateMockupLogoRedraw(request, {
    env: { ARK_RUNTIME_API_KEY: 'test-key' },
    fetchImplementation: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/images/generations')) {
        generationBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>
        );
        return new Response(
          JSON.stringify({ data: [{ url: 'https://example.com/generated.png' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === 'https://example.com/generated.png') {
        return new Response(new Uint8Array(generatedPng), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(generationBodies.length, 1);
  assert.equal(generationBodies[0].model, 'doubao-seedream-4-0-250828');
  assert.equal(generationBodies[0].size, '1K');
  assert.equal(generationBodies[0].output_format, undefined);
  const images = generationBodies[0].image as string[];
  assert.equal(images[0], tinyReference);
  assert.match(images[1], /^data:image\/png;base64,/);
  assert.match(result.image.dataUrl, /^data:image\/png;base64,/);
  assert.equal(result.image.contentType, 'image/png');
});

test('Seedream 5.0 override sends output_format png', async () => {
  const generatedPng = await sharp({
    create: {
      width: 6,
      height: 6,
      channels: 4,
      background: { r: 255, g: 0, b: 255, alpha: 1 },
    },
  }).composite([{
    input: {
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      },
    },
    left: 2,
    top: 2,
  }]).png().toBuffer();
  const generationBodies: Record<string, unknown>[] = [];

  await generateMockupLogoRedraw(
    {
      instruction: '生成无文字的深绿色盾牌',
      images: [],
      confirmed: true,
      analysis: {
        ...analysis,
        output: { ...analysis.output, targetText: '' },
      },
    },
    {
      env: {
        ARK_RUNTIME_API_KEY: 'test-key',
        MOCKUP_LOGO_GENERATION_MODEL: 'doubao-seedream-5-0-pro-260628',
      },
      fetchImplementation: async (input, init) => {
        if (String(input).endsWith('/images/generations')) {
          generationBodies.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>
          );
          return new Response(
            JSON.stringify({ data: [{ url: 'https://example.com/generated.png' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(new Uint8Array(generatedPng), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      },
    }
  );

  const generationBody = generationBodies[0];
  assert.ok(generationBody);
  assert.equal(generationBody.output_format, 'png');
  assert.equal(generationBody.image, undefined);
});

test('generation returns the raw non-magenta candidate without removing or cropping its background', async () => {
  const width = 7;
  const height = 5;
  const pixels = Buffer.alloc(width * height * 4);
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    pixels[offset] = 238;
    pixels[offset + 1] = 238;
    pixels[offset + 2] = 238;
    pixels[offset + 3] = 255;
  }
  for (let y = 1; y <= 3; y += 1) {
    for (let x = 2; x <= 4; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 0;
      pixels[offset + 1] = 80;
      pixels[offset + 2] = 70;
    }
  }
  const generatedPng = await sharp(pixels, {
    raw: { width, height, channels: 4 },
  }).png().toBuffer();

  const result = await generateMockupLogoRedraw(
    {
      instruction: '生成无文字的深绿色盾牌',
      images: [],
      confirmed: true,
      analysis: {
        ...analysis,
        output: { ...analysis.output, targetText: '' },
      },
    },
    {
      env: { ARK_RUNTIME_API_KEY: 'test-key' },
      fetchImplementation: async (input) => {
        if (String(input).endsWith('/images/generations')) {
          return new Response(
            JSON.stringify({ data: [{ url: 'https://example.com/raw-candidate.png' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(new Uint8Array(generatedPng), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      },
    }
  );
  const returnedPng = Buffer.from(
    result.image.dataUrl.slice('data:image/png;base64,'.length),
    'base64'
  );
  const { data, info } = await sharp(returnedPng)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  assert.equal(result.image.contentType, 'image/png');
  assert.equal(result.image.model, 'doubao-seedream-4-0-250828');
  assert.equal(result.image.width, width);
  assert.equal(result.image.height, height);
  assert.ok(result.durationMs >= 0);
  assert.equal(info.width, width);
  assert.equal(info.height, height);
  assert.deepEqual([...data.subarray(0, 4)], [238, 238, 238, 255]);
  const logoPixelOffset = (2 * width + 3) * 4;
  assert.deepEqual(
    [...data.subarray(logoPixelOffset, logoPixelOffset + 4)],
    [0, 80, 70, 255]
  );
});

test('generation rejects a raw PNG candidate that remains over 10MB after normalization', async () => {
  const width = 1_920;
  const height = 1_920;
  const generatedPng = await sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(generatedPng.byteLength > 10 * 1024 * 1024);
  assert.ok(generatedPng.byteLength < 20 * 1024 * 1024);

  await assert.rejects(
    () => generateMockupLogoRedraw(
      {
        instruction: '生成无文字的深绿色盾牌',
        images: [],
        confirmed: true,
        analysis: {
          ...analysis,
          output: { ...analysis.output, targetText: '' },
        },
      },
      {
        env: { ARK_RUNTIME_API_KEY: 'test-key' },
        fetchImplementation: async (input) => {
          if (String(input).endsWith('/images/generations')) {
            return new Response(
              JSON.stringify({ data: [{ url: 'https://example.com/oversized.png' }] }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response(new Uint8Array(generatedPng), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          });
        },
      }
    ),
    /Logo 原始候选超过 10MB 限制/
  );
});

test('Ark permission and quota errors are actionable and redact upstream metadata', () => {
  const permission = formatLogoRedrawArkError('Logo 生成模型', 403, {
    error: {
      message: 'account 123 has no access; request id secret-request-id',
    },
  });
  const quota = formatLogoRedrawArkError('Logo 生成模型', 429, {
    error: {
      code: 'SetLimitExceeded',
      message: 'account 123 reached Safe Experience Mode request secret-request-id',
    },
  });

  assert.match(permission.message, /模型权限/);
  assert.equal(permission.status, 403);
  assert.doesNotMatch(permission.message, /123|secret-request-id/);
  assert.match(quota.message, /额度|安心体验/);
  assert.equal(quota.status, 429);
  assert.doesNotMatch(quota.message, /123|secret-request-id/);
});
