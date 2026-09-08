import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { APRON_RECOGNITION_PROMPT, APRON_REFINEMENT_PROMPT, APRON_RECOGNITION_VERSION, parseApronModelResponse, apronRecognitionStandard, projectApronRecognition, type ApronRecognition } from '@/lib/catalog-apron-recognition';
import { catalogReferenceType } from '@/lib/catalog-placement-suggestions';
import type { CatalogDetail } from '@/lib/catalog';
import { readCatalogFile } from './catalog-files';
import { formatArkErrorMessage } from './ark-logo-studio';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const responseSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1), usage: z.unknown().optional() });
export function apronRecognitionModel() { return process.env.CATALOG_PLACEMENT_MODEL?.trim() || process.env.VISION_MODEL_EP?.trim() || 'doubao-seed-2-0-lite-260215'; }
async function requestApronRecognition(image: Buffer, prompt: string) {
  const key = process.env.ARK_RUNTIME_API_KEY?.trim() || process.env.ARK_API_KEY?.trim();
  if (!key) throw new Error('尚未配置围裙识别模型：需要 ARK_RUNTIME_API_KEY 或 ARK_API_KEY');
  const model = apronRecognitionModel();
  const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } }] }], temperature: .1, max_tokens: 3000, stream: false }),
    signal: AbortSignal.timeout(90000),
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(formatArkErrorMessage('围裙位置识别', response.status, body));
  const parsed = responseSchema.parse(body);
  const recognition = parseApronModelResponse(JSON.parse(parsed.choices[0].message.content.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')));
  return { recognition, model, usage: parsed.usage ?? null };
}
export async function prepareApronRefinement(image: Buffer, recognition: ApronRecognition) {
  const frame = recognition.garment.area;
  if (!frame || recognition.garment.confidence < .65) return null;
  const { width, height } = await sharp(image).metadata();
  const left = Math.max(0, Math.floor((frame.x - .02) * width!));
  const top = Math.max(0, Math.floor((frame.y - .02) * height!));
  const right = Math.min(width!, Math.ceil((frame.x + frame.width + .02) * width!));
  const bottom = Math.min(height!, Math.ceil((frame.y + frame.height + .02) * height!));
  return { image: await sharp(image).extract({ left, top, width: right - left, height: bottom - top }).resize({ width: 1600, height: 1600, fit: 'inside' }).png().toBuffer(), crop: { x: left / width!, y: top / height!, width: (right - left) / width!, height: (bottom - top) / height! } };
}
export async function refineApronRecognition(image: Buffer, first: { recognition: ApronRecognition; usage: unknown }) {
  const focused = await prepareApronRefinement(image, first.recognition);
  const refined = focused ? await requestApronRecognition(focused.image, APRON_REFINEMENT_PROMPT) : null;
  const recognition = refined && focused ? projectApronRecognition(refined.recognition, focused.crop) : first.recognition;
  const passes = [{ stage: '全图定位', inputHash: digest(image), promptHash: digest(APRON_RECOGNITION_PROMPT), crop: null as { x: number; y: number; width: number; height: number } | null }];
  if (focused) passes.push({ stage: '局部放大复核', inputHash: digest(focused.image), promptHash: digest(APRON_REFINEMENT_PROMPT), crop: focused.crop });
  return { ...apronRecognitionStandard(recognition), recognition, model: apronRecognitionModel(), version: APRON_RECOGNITION_VERSION,
    promptHash: digest(APRON_RECOGNITION_PROMPT + APRON_REFINEMENT_PROMPT), inputHash: digest(image), passes,
    usage: { overview: first.usage, refinement: refined?.usage ?? null } };
}
export async function recognizeApronImage(image: Buffer) {
  return refineApronRecognition(image, await requestApronRecognition(image, APRON_RECOGNITION_PROMPT));
}
export async function apronRecognitionInput(detail: CatalogDetail) {
  const view = detail.views.find(v => v.face === 'front');
  if (!view) throw new Error(`围裙 ${detail.id} 缺少正面图片`);
  const { bytes } = await readCatalogFile(z.uuid().parse(detail.imageUrl.split('/').at(-1)));
  const metadata = await sharp(bytes).metadata();
  const left = Math.round(view.crop.x * metadata.width!); const top = Math.round(view.crop.y * metadata.height!);
  return sharp(bytes).extract({ left, top, width: Math.min(Math.round(view.crop.width * metadata.width!), metadata.width! - left), height: Math.min(Math.round(view.crop.height * metadata.height!), metadata.height! - top) })
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).flatten({ background: 'white' }).png().toBuffer();
}
// Cache image suggestions only, never overwrite saved standards. Failed calls are retryable.
const recognitionCache = new Map<string, Promise<Awaited<ReturnType<typeof recognizeApronImage>>>>();
export async function recognizeCatalogApron(detail: CatalogDetail) {
  const front = detail.views.find(v => v.face === 'front');
  if (!front || (catalogReferenceType(detail.namespace, detail.styleCode).structure !== 'apron' && front.latest?.specification.structureType !== 'apron')) throw new Error(`款式 ${detail.styleCode} 不是已知围裙，请先设置结构类型`);
  const key = JSON.stringify([detail.sha256, front.crop, apronRecognitionModel(), APRON_RECOGNITION_VERSION, digest(APRON_RECOGNITION_PROMPT + APRON_REFINEMENT_PROMPT)]);
  let pending = recognitionCache.get(key);
  const cached = !!pending;
  if (!pending) {
    pending = apronRecognitionInput(detail).then(recognizeApronImage);
    recognitionCache.set(key, pending);
    if (recognitionCache.size > 64) recognitionCache.delete(recognitionCache.keys().next().value!);
  }
  try { return { ...await pending, assetVersionId: detail.assetVersionId, viewId: front.id, cached }; }
  catch (error) { if (recognitionCache.get(key) === pending) recognitionCache.delete(key); throw error; }
}
