import { usesProductionCloud, saveProductionFile } from './production-storage';
import { artworkPrintInstruction, artworkPrintPlacement } from '@/lib/production-artwork-layout';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import type { ProductionRecord, ProductionUnit } from '@/lib/wps-production';

const EVOLINK_API_ROOT = 'https://api.evolink.ai';
const MAX_RESULT_BYTES = 12 * 1024 * 1024;

type EvolinkTaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type EvolinkTask = {
  id: string;
  status: EvolinkTaskStatus;
  progress: number;
  results: string[];
  creditsReserved: number | null;
  error: string | null;
};

export class EvolinkConfigurationError extends Error {}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function apiKey() {
  const value = process.env.EVOLINK_API_KEY?.trim();
  if (!value) throw new EvolinkConfigurationError('EVOLINK_API_KEY 尚未配置；未发起 GPT Image 2 付费请求');
  return value;
}

export function assertGptImage2Configured() {
  apiKey();
}

function absoluteInputUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('只允许 HTTPS');
    return parsed.toString();
  } catch {
    if (!url.startsWith('/')) throw new Error(`EvoLink 输入图片不是有效 URL：${url}`);
    const base = process.env.EVOLINK_PUBLIC_ASSET_BASE_URL?.trim();
    if (!base) {
      throw new EvolinkConfigurationError(`素材 ${url} 是本地路径；请配置可公网 HTTPS 访问的 EVOLINK_PUBLIC_ASSET_BASE_URL 后再提交`);
    }
    const resolved = new URL(url, base);
    if (resolved.protocol !== 'https:') throw new EvolinkConfigurationError('EVOLINK_PUBLIC_ASSET_BASE_URL 必须是 HTTPS');
    return resolved.toString();
  }
}

function taskValue(value: unknown, requireResults = false): EvolinkTask {
  const body = objectValue(value, 'EvoLink response');
  if (typeof body.id !== 'string' || !body.id.trim()) throw new Error('EvoLink 响应缺少任务 id');
  if (!['pending', 'processing', 'completed', 'failed'].includes(String(body.status))) {
    throw new Error(`EvoLink 返回未知任务状态：${String(body.status)}`);
  }
  const results = body.results === undefined ? [] : Array.isArray(body.results)
    ? body.results.map((result, index) => {
        if (typeof result !== 'string' || !result.startsWith('https://')) throw new Error(`EvoLink results[${index}] 不是 HTTPS URL`);
        return result;
      })
    : (() => { throw new Error('EvoLink results 必须是数组'); })();
  if (requireResults && body.status === 'completed' && results.length === 0) throw new Error('EvoLink 任务已完成但没有结果 URL');
  const usage = body.usage && typeof body.usage === 'object' && !Array.isArray(body.usage)
    ? body.usage as Record<string, unknown>
    : null;
  const creditsReserved = usage?.credits_reserved === undefined ? null : Number(usage.credits_reserved);
  if (creditsReserved !== null && (!Number.isFinite(creditsReserved) || creditsReserved < 0)) {
    throw new Error(`EvoLink credits_reserved 无效：${String(usage?.credits_reserved)}`);
  }
  const errorObject = body.error && typeof body.error === 'object' && !Array.isArray(body.error)
    ? body.error as Record<string, unknown>
    : null;
  return {
    id: body.id.trim(),
    status: body.status as EvolinkTaskStatus,
    progress: typeof body.progress === 'number' && Number.isFinite(body.progress) ? body.progress : 0,
    results,
    creditsReserved,
    error: errorObject ? String(errorObject.message ?? errorObject.code ?? 'EvoLink 任务失败') : null,
  };
}

async function evolinkJson(url: string, init: RequestInit, timeoutMs: number) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body
      ? (body as { error?: { code?: unknown; message?: unknown } }).error
      : null;
    throw new Error(`EvoLink HTTP ${response.status}：${String(error?.message ?? error?.code ?? '未知错误')}`);
  }
  return body;
}

export function buildGptImage2Request(record: ProductionRecord, unit: ProductionUnit) {
  if (unit.route !== 'gpt-image-2') throw new Error(`定制单元 ${unit.id} 不是 GPT Image 2 路线`);
  const materialIds = [unit.materialId, ...unit.referenceMaterialIds].filter((value): value is string => Boolean(value));
  const imageUrls = materialIds.map((materialId) => {
    const material = record.source.materials.find((candidate) => candidate.id === materialId);
    if (!material) throw new Error(`定制单元 ${unit.id} 引用了不存在的素材：${materialId}`);
    const sourceUrl = material.url ?? material.previewUrl;
    if (!sourceUrl) throw new Error(`素材 ${materialId} 没有可供 EvoLink 下载的 URL`);
    return absoluteInputUrl(sourceUrl);
  });
  if (imageUrls.length < 1 || imageUrls.length > 16) throw new Error(`EvoLink 输入图必须是 1 到 16 张，实际：${imageUrls.length}`);
  const prompt = [
    '生成一个单独、完整、独立的服装定制素材，直接输出透明背景 PNG。',
    '背景像素 alpha 必须为 0；不要生成白色、彩色或渐变背景。',
    '不要生成衣服、人物、模特、场景、展示板、地面、投影或环境阴影。',
    `客户原始要求：${record.source.requirementText}`,
    `本单元制作要求：${unit.instruction}`,
    unit.exactText ? `准确文字必须逐字保留：${unit.exactText}` : '没有新增准确文字。',
    unit.layoutNote ? `字体与版式参考要求：${unit.layoutNote}` : '',
    `输入图1是必须进入成品的内容素材；${unit.referenceMaterialIds.length > 0 ? '后续输入图仅作为明确要求的字体或版式参考，不得复制其中人物、衣服或背景。' : '没有额外风格参考图。'}`,
    artworkPrintInstruction(artworkPrintPlacement(unit.placement)),
    '只输出一张完整 PNG，保留有效 Alpha 透明通道。',
  ].filter(Boolean).join('\n');
  if ([...prompt].length > 32_000) throw new Error(`GPT Image 2 prompt 超过 32000 字符：${[...prompt].length}`);
  return {
    model: 'gpt-image-2' as const,
    prompt,
    promptHash: createHash('sha256').update(prompt).digest('hex'),
    image_urls: imageUrls,
    size: '1:1' as const,
    resolution: '1K' as const,
    quality: 'low' as const,
    background: 'transparent' as const,
    n: 1 as const,
    ...(process.env.EVOLINK_CALLBACK_URL?.startsWith('https://')
      ? { callback_url: process.env.EVOLINK_CALLBACK_URL }
      : {}),
  };
}

export async function createGptImage2Task(request: ReturnType<typeof buildGptImage2Request>) {
  const body = await evolinkJson(`${EVOLINK_API_ROOT}/v1/images/generations`, {
    method: 'POST',
    body: JSON.stringify(request),
  }, 30_000);
  return taskValue(body);
}

export async function queryGptImage2Task(taskId: string) {
  if (!/^task-unified-[a-zA-Z0-9-]+$/u.test(taskId)) throw new Error(`EvoLink task ID 格式无效：${taskId}`);
  const body = await evolinkJson(`${EVOLINK_API_ROOT}/v1/tasks/${encodeURIComponent(taskId)}`, { method: 'GET' }, 20_000);
  return taskValue(body, true);
}

export async function downloadGptImage2Result(url: string, unitId: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`EvoLink 结果必须是 HTTPS：${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
  if (!response.ok) throw new Error(`下载 EvoLink 结果失败：HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_RESULT_BYTES) throw new Error(`EvoLink 结果超过 ${MAX_RESULT_BYTES} 字节`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length <= 0 || bytes.length > MAX_RESULT_BYTES) throw new Error(`EvoLink 结果大小无效：${bytes.length}`);
  const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
  if (metadata.format !== 'png') throw new Error(`EvoLink 结果不是 PNG：${metadata.format ?? 'unknown'}`);
  const safeUnitId = unitId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const name = `${Date.now()}-${safeUnitId}-gpt-image-2.png`;
  if (usesProductionCloud()) return { url: (await saveProductionFile(bytes, name)).url, name };
  const directory = path.join(process.cwd(), 'public', 'uploads', 'logos');
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes);
  await rename(temporary, path.join(directory, name));
  return { url: `/uploads/logos/${name}`, name };
}
