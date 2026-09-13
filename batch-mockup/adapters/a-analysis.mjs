import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { fail } from './a-files.mjs';

// Same provider and parameters as the approved A experiment. No automatic retries.
export async function configuredAnalyzer() {
  const env = process.env.A_ANALYSIS_ENV_FILE ? { ...parseEnv(await readFile(resolve(process.env.A_ANALYSIS_ENV_FILE), 'utf8')), ...process.env } : process.env;
  const key = env.CLIPROXY_API_KEY?.trim(), base = new URL(env.CLIPROXY_API_BASE_URL);
  if (env.WPS_ANALYSIS_PROVIDER !== 'cliproxy' || !key || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/u, '') !== '/v1') throw fail('已选识图API配置不可用', 503);
  if (env.WPS_ANALYSIS_MODEL?.trim() !== 'gpt-5.6-sol' || env.WPS_ANALYSIS_REASONING_EFFORT?.trim() !== 'low') throw fail('当前识图配置与已确认的gpt-5.6-sol / low不一致', 503);
  return async request => {
    const response = await fetch(base.toString().replace(/\/$/u, '') + '/chat/completions', {
      method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(240000),
    });
    if (!response.ok) { await response.body?.cancel(); throw fail(`识图API返回HTTP ${response.status}；未自动重试`, 502); }
    const raw = await response.text();
    if (raw.includes(key)) throw fail('响应含敏感配置，未保存', 502);
    const body = JSON.parse(raw), choice = body.choices?.[0];
    if (!choice?.message || choice.finish_reason !== 'stop' || choice.message.refusal) throw fail('识图输出未完整完成；未自动重试', 502);
    return { rawContent: choice.message.content, responseId: body.id, reportedModel: body.model, usage: body.usage, httpStatus: response.status };
  };
}
