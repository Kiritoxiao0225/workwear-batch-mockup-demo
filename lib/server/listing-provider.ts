import { randomUUID } from 'node:crypto';
import { cliproxyListingImage } from './cliproxy-image-2';
/**
 * Model calls for 电商主图: the analysis and the images on EvoLink (gpt-image-2.5), as live, unless
 * LISTING_PLAN_PROVIDER=cliproxy or LISTING_IMAGE_PROVIDER=cliproxy moves that half to the Codex
 * relay (CLIProxy, gpt-image-2; the local setup uses it). One request per call. A relay image, which
 * costs nothing when it fails, says whether its failure was a passing one (`retry`), and the job goes
 * back in the queue for it (listing-generation); EvoLink is never repeated, a request sent may have been charged.
 */
type Env = Record<string, string | undefined>;
type Options = { env?: Env; fetchImplementation?: typeof fetch; beforeSubmit: () => Promise<void>; receipt: (id: string) => Promise<void> };

export const LISTING_PLAN_MODEL = (env: Env = process.env) => env.LISTING_PLAN_MODEL?.trim() || 'gpt-6.1-sol';

export function assertListingProviderConfigured(env: Env = process.env) {
  const used = [listingPlanProvider(env), listingImageProvider(env)];
  if (used.includes('evolink') && !env.EVOLINK_API_KEY?.trim()) throw new Error('EVOLINK_API_KEY 未配置，未冻结积分也未提交模型');
  if (used.includes('cliproxy') && !(env.CLIPROXY_API_KEY?.trim() && env.CLIPROXY_API_BASE_URL?.trim())) throw new Error('CLIPROXY_API_KEY 或 CLIPROXY_API_BASE_URL 未配置，未冻结积分也未提交模型');
}
/** Where the analysis runs: EvoLink unless moved to the Codex relay. */
export const listingPlanProvider = (env: Env = process.env): 'cliproxy' | 'evolink' => env.LISTING_PLAN_PROVIDER?.trim() === 'cliproxy' ? 'cliproxy' : 'evolink';
/** Where the images are made: EvoLink unless moved to the Codex relay. */
export const listingImageProvider = (env: Env = process.env): 'cliproxy' | 'evolink' => env.LISTING_IMAGE_PROVIDER?.trim() === 'cliproxy' ? 'cliproxy' : 'evolink';
/**
 * The relay makes about one image every 30 s however many it is sent, so more at once only makes
 * each slower: on 10-22 eight at once (4 on each of two workers) took 90–280 s and half passed the
 * timeout. A worker runs two.
 */
export const listingWorkerConcurrency = (env: Env = process.env) => Number(env.LISTING_WORKER_CONCURRENCY) || (listingImageProvider(env) === 'cliproxy' ? 2 : 6);

export type PlanCall = { content: string; model: string; requestId: string; usage: unknown; durationMs: number };

export async function callPlanModel(request: object, options: Options): Promise<PlanCall> {
  const env = options.env ?? process.env, transport = options.fetchImplementation ?? fetch;
  const relay = listingPlanProvider(env) === 'cliproxy';
  const key = (relay ? env.CLIPROXY_API_KEY : env.EVOLINK_API_KEY)?.trim();
  if (!key) throw new Error(relay ? 'CLIPROXY_API_KEY 未配置' : 'EVOLINK_API_KEY 未配置');
  const endpoint = relay ? `${env.CLIPROXY_API_BASE_URL?.trim().replace(/\/$/u, '')}/chat/completions` : 'https://direct.evolink.ai/v1/chat/completions';
  const started = Date.now();
  await options.beforeSubmit();
  // Streamed: the words come back as they are written, so a long analysis never sits silent long
  // enough for the connection to be cut (10-13: 199 photos, cut at about two minutes).
  const response = await transport(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(600_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, stream: true, stream_options: { include_usage: true } }),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('event-stream')) return wholeAnswer(response, key, options, started);
  let content = '', id = '', model = '', usage: unknown = null, finish = '', buffer = '';
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop()!;
    for (const line of lines) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data || data === '[DONE]') continue;
      let chunk: { id?: string; model?: string; usage?: unknown; choices?: { finish_reason?: string | null; delta?: { content?: string | null } }[] };
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.id && !id) { id = chunk.id; await options.receipt(id); }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) content += choice.delta.content;
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
    if (done) break;
  }
  if (content.includes(key)) throw new Error('响应含敏感配置，已丢弃');
  if (finish !== 'stop' || !content) throw new Error(`分析没有完整结束（${finish || '无结果'}）`);
  return { content, model, requestId: id, usage, durationMs: Date.now() - started };
}
/** An answer that came back whole (an error, or a provider that does not stream). */
async function wholeAnswer(response: Response, key: string, options: Options, started: number): Promise<PlanCall> {
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

const EVOLINK_IMAGE_MODEL = 'gpt-image-2.5-sunburst';
export const listingImageModel = (env: Env = process.env) => listingImageProvider(env) === 'cliproxy' ? 'gpt-image-2' : EVOLINK_IMAGE_MODEL;
/** gpt-image-2 sizes for the shapes (sides in multiples of 16). */
const RELAY_SIZES = { square: '1024x1024', portrait: '1152x1536', long: '1024x1536' } as const;
const mimeOf = (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/png';
const RATIOS = { square: '1:1', portrait: '3:4', long: '2:3' } as const;
/** A relay image that came back did so within 290 s on 10-22; past 8 minutes it is not coming. */
const RELAY_TIMEOUT_MS = 480_000;
// The provider's words help (a refusal reads differently from a timeout); links and token-like runs
// stay out of what the tenant sees.
export const providerReason = (text: string) => text.replace(/https?:\/\/\S+/gu, '[链接]').replace(/[A-Za-z0-9_\-+/=]{24,}/gu, '…').slice(0, 80);
export type ImageCall = { bytes: Buffer; taskId: string; credits: number | null; durationMs: number };

/**
 * One generated image at 1K, medium quality (≈ ¥0.15–0.36 depending on reference count).
 * A task the provider reports as failed or cancelled is not charged, so it throws with
 * `notCharged`; anything else after submission may have been charged.
 */
export async function generateListingImage(input: { prompt: string; references: Buffer[]; ratio: keyof typeof RATIOS; mask?: Buffer }, options: Options & { pollMs?: number; timeoutMs?: number }): Promise<ImageCall> {
  const env = options.env ?? process.env, transport = options.fetchImplementation ?? fetch;
  if (listingImageProvider(env) === 'cliproxy') {
    // The relay runs on a subscription: a failed image costs nothing, so the user is not charged for it.
    await options.beforeSubmit();
    try {
      const call = await cliproxyListingImage({ prompt: input.prompt, images: input.references, size: RELAY_SIZES[input.ratio], mask: input.mask, timeoutMs: RELAY_TIMEOUT_MS });
      return { bytes: call.bytes, taskId: '', credits: null, durationMs: call.durationMs };
    } catch (error) { throw Object.assign(error instanceof Error ? error : new Error('出图失败'), { notCharged: true }); }
  }
  const key = env.EVOLINK_API_KEY?.trim();
  if (!key) throw new Error('EVOLINK_API_KEY 未配置');
  const auth = { Authorization: `Bearer ${key}` };
  // A mask (a PNG the size of the first reference, transparent where to redraw) redraws only that part.
  const files = input.mask ? [...input.references, input.mask] : input.references;
  const uploaded = await Promise.all(files.map(async (bytes, i) => {
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
  const urls = input.mask ? uploaded.slice(0, -1) : uploaded, maskUrl = input.mask ? uploaded.at(-1) : undefined;
  const started = Date.now();
  await options.beforeSubmit();
  const created = await transport('https://api.evolink.ai/v1/images/generations', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000), headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EVOLINK_IMAGE_MODEL, prompt: input.prompt, image_urls: urls, ...(maskUrl ? { mask_url: maskUrl } : {}), size: RATIOS[input.ratio], resolution: '1K', quality: 'medium', background: 'opaque', output_format: 'png', n: 1 }),
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
  if (detail?.status === 'failed' || detail?.status === 'cancelled') {
    if (detail.error?.message) console.error('[listing] provider failed', task.id, detail.error.message);
    throw Object.assign(new Error(`出图没有成功（${detail.error?.message ? providerReason(detail.error.message) : detail.status}）`), { notCharged: true });
  }
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
