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
