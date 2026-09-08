'use client';

import type { OcrResultItem } from '@paddleocr/paddleocr-js';

import {
  evaluateLogoText,
  logoTextSimilarity,
  type LogoTextGateResult,
} from '@/lib/logo-text-gate';

const PADDLE_OCR_TINY_DETECTION_MODEL =
  '/ocr-models/PP-OCRv6_tiny_det_onnx_infer.tar';
const PADDLE_OCR_TINY_RECOGNITION_MODEL =
  '/ocr-models/PP-OCRv6_tiny_rec_onnx_infer.tar';
const PADDLE_OCR_WASM_BASE_URL =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/';

type BrowserPaddleOcr = Awaited<
  ReturnType<(typeof import('@paddleocr/paddleocr-js'))['PaddleOCR']['create']>
>;

export type BrowserLogoTextVerification = LogoTextGateResult & {
  detectedLines: number;
  durationMs: number;
  contrastBackground: 'white' | 'black';
};

let browserPaddleOcrPromise: Promise<BrowserPaddleOcr> | null = null;

function browserPaddleOcr() {
  if (browserPaddleOcrPromise) return browserPaddleOcrPromise;
  browserPaddleOcrPromise = import('@paddleocr/paddleocr-js')
    .then(({ PaddleOCR }) => PaddleOCR.create({
      worker: true,
      textDetectionModelName: 'PP-OCRv6_tiny_det',
      textRecognitionModelName: 'PP-OCRv6_tiny_rec',
      textDetectionModelAsset: { url: PADDLE_OCR_TINY_DETECTION_MODEL },
      textRecognitionModelAsset: { url: PADDLE_OCR_TINY_RECOGNITION_MODEL },
      ortOptions: {
        backend: 'wasm',
        wasmPaths: PADDLE_OCR_WASM_BASE_URL,
        numThreads: 1,
        simd: true,
      },
    }))
    .catch((error) => {
      browserPaddleOcrPromise = null;
      throw error;
    });
  return browserPaddleOcrPromise;
}

function toGateItems(items: OcrResultItem[]) {
  return items.map((item) => ({
    text: item.text,
    score: item.score,
    poly: item.poly.map(([x, y]) => ({ x, y })),
  }));
}

function loadLogoImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const timeoutId = window.setTimeout(() => {
      image.src = '';
      reject(new Error('Logo 图片加载超过 15 秒'));
    }, 15_000);
    image.onload = () => {
      window.clearTimeout(timeoutId);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timeoutId);
      reject(new Error(`Logo 图片加载失败：${url}`));
    };
    image.decoding = 'async';
    image.src = url;
  });
}

function logoOnBackground(image: HTMLImageElement, background: 'white' | 'black') {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法创建 OCR 画布');
  context.fillStyle = background === 'white' ? '#ffffff' : '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  return canvas;
}

function preferredResult(
  candidates: Array<LogoTextGateResult & { contrastBackground: 'white' | 'black' }>,
) {
  return [...candidates].sort((left, right) => {
    if (left.passed !== right.passed) return left.passed ? -1 : 1;
    if (left.exactText !== right.exactText) return left.exactText ? -1 : 1;
    const similarityDifference = logoTextSimilarity(
      right.normalizedExpectedText,
      right.normalizedRecognizedText,
    ) - logoTextSimilarity(
      left.normalizedExpectedText,
      left.normalizedRecognizedText,
    );
    if (similarityDifference !== 0) return similarityDifference;
    return right.minimumScore - left.minimumScore;
  })[0];
}

function withOcrTimeout<T>(operation: Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(
      () => reject(new Error('PP-OCRv6 单次识别超过 30 秒，请刷新后重试或转人工')),
      30_000,
    );
    operation.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

async function predictOnBackground(
  ocr: BrowserPaddleOcr,
  canvas: HTMLCanvasElement,
) {
  const [result] = await withOcrTimeout(ocr.predict(canvas, {
    textDetLimitSideLen: 960,
    textDetLimitType: 'min',
    textDetMaxSideLimit: 2048,
    textDetThresh: 0.2,
    textDetBoxThresh: 0.35,
    textDetUnclipRatio: 1.35,
    textRecScoreThresh: 0,
  }));
  if (!result) throw new Error('PP-OCRv6 没有返回 Logo 检测结果');
  return result;
}

export async function verifyBrowserLogoText(
  logoUrl: string,
  expectedText: string,
): Promise<BrowserLogoTextVerification> {
  const normalizedUrl = logoUrl.trim();
  if (!normalizedUrl) throw new Error('当前 Logo 地址为空');

  const sourceImage = await loadLogoImage(normalizedUrl);
  const backgrounds = ['white', 'black'] as const;
  const ocr = await browserPaddleOcr();
  const startedAt = performance.now();
  const results = [];
  const candidates = [];
  for (const background of backgrounds) {
    const result = await predictOnBackground(ocr, logoOnBackground(sourceImage, background));
    results.push(result);
    const candidate = {
      ...evaluateLogoText(expectedText, toGateItems(result.items)),
      contrastBackground: background,
    };
    candidates.push(candidate);
    if (candidate.passed) break;
  }
  const selected = preferredResult(candidates);
  if (!selected) throw new Error('PP-OCRv6 没有返回 Logo 检测结果');
  const selectedIndex = backgrounds.indexOf(selected.contrastBackground);
  const selectedOcrResult = results[selectedIndex];

  return {
    ...selected,
    detectedLines: selectedOcrResult.items.length,
    durationMs: performance.now() - startedAt,
  };
}
