import { randomUUID } from 'node:crypto';
/**
 * EvoLink calls for 电商主图. One paid request per call; nothing here retries, because a request
 * that was sent may already have been charged.
 */
type Env = Record<string, string | undefined>;
type Options = { env?: Env; fetchImplementation?: typeof fetch; beforeSubmit: () => Promise<void>; receipt: (id: string) => Promise<void> };

export const LISTING_PLAN_MODEL = (env: Env = process.env) => env.LISTING_PLAN_MODEL?.trim() || 'gpt-6.1-sol';

export function assertListingProviderConfigured(env: Env = process.env) {
  if (!env.EVOLINK_API_KEY?.trim()) throw new Error('EVOLINK_API_KEY 未配置，未冻结积分也未提交模型');
}

export type PlanCall = { content: string; model: string; requestId: string; usage: unknown; durationMs: number };

export async function callPlanModel(request: object, options: Options): Promise<PlanCall> {
  const env = options.env ?? process.env, transport = options.fetchImplementation ?? fetch;
  const key = env.EVOLINK_API_KEY?.trim();
  if (!key) throw new Error('EVOLINK_API_KEY 未配置');
  const started = Date.now();
  await options.beforeSubmit();
  const response = await transport('https://direct.evolink.ai/v1/chat/completions', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(600_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  });
  const raw = await response.text();
  if (raw.includes(key)) throw new Error('响应含敏感配置，已丢弃');
  let body: { id?: string; model?: string; usage?: unknown; choices?: { finish_reason?: string; message?: { content?: string } }[] } = {};
  try { body = JSON.parse(raw); } catch { /* reported below */ }
  if (body.id) await options.receipt(body.id);
  if (!response.ok) throw Object.assign(new Error(`分析接口 HTTP ${response.status}`), { definite: response.status >= 400 && response.status < 500 });
  const choice = body.choices?.[0];
  if (choice?.finish_reason !== 'stop' || !choice.message?.content) throw new Error(`分析没有完整结束（${choice?.finish_reason ?? '无结果'}）`);
  return { content: choice.message.content, model: body.model ?? '', requestId: body.id ?? '', usage: body.usage ?? null, durationMs: Date.now() - started };
}

export const LISTING_IMAGE_MODEL = 'gpt-image-2.5-sunburst';
const mimeOf = (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/png';
const RATIOS = { square: '1:1', portrait: '3:4', poster: '2:3' } as const;
export type ImageCall = { bytes: Buffer; taskId: string; credits: number | null; durationMs: number };

/**
 * One generated image at 1K, medium quality (≈ ¥0.15–0.36 depending on reference count).
 * A task the provider reports as failed or cancelled is not charged, so it throws with
 * `notCharged`; anything else after submission may have been charged.
 */
export async function generateListingImage(input: { prompt: string; references: Buffer[]; ratio: keyof typeof RATIOS }, options: Options & { pollMs?: number; timeoutMs?: number }): Promise<ImageCall> {
  const env = options.env ?? process.env, transport = options.fetchImplementation ?? fetch;
  const key = env.EVOLINK_API_KEY?.trim();
  if (!key) throw new Error('EVOLINK_API_KEY 未配置');
  const auth = { Authorization: `Bearer ${key}` };
  const urls = await Promise.all(input.references.map(async (bytes, i) => {
    const response = await transport('https://files-api.evolink.ai/api/v1/files/upload/base64', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000), headers: { ...auth, 'Content-Type': 'application/json' },
      // Unique names: concurrent uploads under one name overwrote each other, and jobs got
      // another colour's reference image.
      body: JSON.stringify({ base64_data: `data:${mimeOf(bytes)};base64,${bytes.toString('base64')}`, file_name: `listing-${randomUUID()}-${i + 1}.${mimeOf(bytes).split('/')[1]}` }),
    });
    const body = await response.json().catch(() => null) as { success?: boolean; data?: { file_url?: string } } | null;
    if (!response.ok || !body?.success || !String(body.data?.file_url).startsWith('https://')) throw new Error(`参考图上传失败（HTTP ${response.status}）`);
    return body.data!.file_url!;
  }));
  const started = Date.now();
  await options.beforeSubmit();
  const created = await transport('https://api.evolink.ai/v1/images/generations', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000), headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: LISTING_IMAGE_MODEL, prompt: input.prompt, image_urls: urls, size: RATIOS[input.ratio], resolution: '1K', quality: 'medium', background: 'opaque', output_format: 'png', n: 1 }),
  });
  const task = await created.json().catch(() => null) as { id?: string } | null;
  if (!created.ok || !task?.id) throw Object.assign(new Error(`出图提交失败（HTTP ${created.status}）`), { notCharged: created.status >= 400 && created.status < 500 });
  await options.receipt(task.id);
  type Detail = { status?: string; results?: string[]; result_data?: { url?: string }[]; usage?: { credits_used?: number }; error?: { message?: string } };
  const poll = async () => {
    const r = await transport(`https://api.evolink.ai/v1/tasks/${encodeURIComponent(task.id!)}`, { headers: auth, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    return r?.ok ? await r.json().catch(() => null) as Detail | null : null;
  };
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000), wait = () => new Promise(r => setTimeout(r, options.pollMs ?? 3000));
  let detail: Detail | null = null;
  while (Date.now() < deadline) {
    await wait();
    detail = (await poll()) ?? detail;
    if (['completed', 'failed', 'cancelled'].includes(detail?.status ?? '')) break;
  }
  if (detail?.status === 'failed' || detail?.status === 'cancelled') throw Object.assign(new Error(`出图没有成功（${detail.error?.message ?? detail.status}）`), { notCharged: true });
  // Billing settles shortly after completion; wait briefly for the real figure.
  for (let i = 0; detail?.status === 'completed' && detail.usage?.credits_used === undefined && i < 5; i++) { await wait(); detail = (await poll()) ?? detail; }
  if (detail?.status !== 'completed') throw new Error('出图结果未知，任务编号已保存');
  // The image is made and paid for: fetching it again costs nothing, so a slow or broken download
  // is retried with a fresh result URL instead of giving the image up (a 180 s stall lost one).
  for (let attempt = 1; ; attempt++) {
    const url = detail?.results?.[0] ?? detail?.result_data?.[0]?.url;
    try {
      if (!url?.startsWith('https://')) throw new Error('结果地址无效');
      const download = await transport(url, { signal: AbortSignal.timeout(90_000) });
      if (!download.ok) throw new Error(`HTTP ${download.status}`);
      return { bytes: Buffer.from(await download.arrayBuffer()), taskId: task.id, credits: detail?.usage?.credits_used ?? null, durationMs: Date.now() - started };
    } catch (error) {
      if (attempt >= 4) throw new Error(`图已做好但下载失败（${error instanceof Error ? error.message : '超时'}），任务编号已保存`);
      await wait();
      detail = (await poll()) ?? detail;
    }
  }
}
