import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { fail } from './a-files.mjs';
import { tokenCost } from './evolink.mjs';

// Two confirmed routes: Codex (CLIProxy, gpt-5.6-sol / low) and EvoLink (gpt-6-sol / low).
// The request is saved before the call with the model filled in here. No automatic retries.
const ROUTES = {
  cliproxy: { model: 'gpt-5.6-sol', effort: 'low' },
  evolink: { model: 'gpt-6-sol', effort: 'low', endpoint: 'https://direct.evolink.ai/v1/chat/completions' },
};
// 图稿生成「AI 拆成多张」only counts pictures, so it takes the cheap EvoLink model whatever
// the requirement reading uses; it still sees the images.
const PLAN_ROUTE = { model: 'gpt-6-luna', effort: 'low', endpoint: ROUTES.evolink.endpoint };
const analysisEnv = async () => process.env.A_ANALYSIS_ENV_FILE ? { ...parseEnv(await readFile(resolve(process.env.A_ANALYSIS_ENV_FILE), 'utf8')), ...process.env } : process.env;
export async function configuredPlanAnalyzer() {
  const env = await analysisEnv(), key = env.EVOLINK_API_KEY?.trim();
  if (!key) throw fail('拆张数用的 EvoLink 未配置', 503);
  return Object.assign(caller('evolink', PLAN_ROUTE.endpoint, key, PLAN_ROUTE.model, env), { model: PLAN_ROUTE.model, effort: PLAN_ROUTE.effort });
}
export async function configuredAnalyzer() {
  const env = await analysisEnv();
  const provider = env.WPS_ANALYSIS_PROVIDER, route = ROUTES[provider];
  if (!route) throw fail('已选识图API配置不可用', 503);
  if (env.WPS_ANALYSIS_MODEL?.trim() !== route.model || env.WPS_ANALYSIS_REASONING_EFFORT?.trim() !== route.effort) throw fail(`当前识图配置与已确认的${route.model} / ${route.effort}不一致`, 503);
  let endpoint, key;
  if (provider === 'cliproxy') {
    key = env.CLIPROXY_API_KEY?.trim();
    const base = new URL(env.CLIPROXY_API_BASE_URL);
    if (!key || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/u, '') !== '/v1') throw fail('已选识图API配置不可用', 503);
    endpoint = base.toString().replace(/\/$/u, '') + '/chat/completions';
  } else {
    key = env.EVOLINK_API_KEY?.trim();
    if (!key) throw fail('已选识图API配置不可用', 503);
    endpoint = route.endpoint;
  }
  return Object.assign(caller(provider, endpoint, key, route.model, env), { model: route.model, effort: route.effort });
}
function caller(provider, endpoint, key, model, env) {
  return async request => {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(240000),
    });
    if (!response.ok) { await response.body?.cancel(); throw fail(`识图API返回HTTP ${response.status}；未自动重试`, 502); }
    const raw = await response.text();
    if (raw.includes(key)) throw fail('响应含敏感配置，未保存', 502);
    const body = JSON.parse(raw), choice = body.choices?.[0];
    if (!choice?.message || choice.finish_reason !== 'stop' || choice.message.refusal) throw fail('识图输出未完整完成；未自动重试', 502);
    const cost = provider === 'evolink' ? tokenCost(model, body.usage, env) : { provider: 'codex', cny: 0, method: 'subscription' };
    return { rawContent: choice.message.content, responseId: body.id, reportedModel: body.model, usage: body.usage, httpStatus: response.status, ...(cost ? { cost } : {}) };
  };
}
