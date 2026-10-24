import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { saveJSON, atomicFile, checkpoint } from './a-files.mjs';

// EvoLink bills in credits. List rate: 1.02 credits = $0.015. What a credit costs us depends on
// the top-up actually bought, so the CNY rate is configuration, not a constant.
export const EVOLINK_USD_PER_CREDIT = 0.015 / 1.02;
// Per million tokens, EvoLink rates (10% under the official list). Checked against the account
// balance on 2026-09-25: 22 gpt-6-sol calls summed to within 0.04% of the balance change.
const TOKEN_USD_PER_MILLION = { 'gpt-6-sol': { input: 1.8, cachedInput: 0.18, output: 9 }, 'gpt-6-luna': { input: 0.09, cachedInput: 0.009, output: 0.45 } };

export function costRates(env = process.env) {
  const cnyPerCredit = Number(env.EVOLINK_CNY_PER_CREDIT || 10 / 650 * 7.1);
  const meituCutout = Number(env.MEITU_CUTOUT_CNY || 0.142);
  const mediakitEnhance = Number(env.MEDIAKIT_ENHANCE_CNY || 0.006);
  if (![cnyPerCredit, meituCutout, mediakitEnhance].every(n => Number.isFinite(n) && n >= 0)) throw new Error('费用换算配置无效');
  return { cnyPerCredit, meituCutout, mediakitEnhance };
}
const round = (n, digits = 4) => Number(n.toFixed(digits));
export const creditCost = (credits, method, extra = {}, env = process.env) =>
  ({ provider: 'evolink', credits: round(credits), cny: round(credits * costRates(env).cnyPerCredit), method, ...extra });

/** Analysis cost from the returned token usage; chat completions carry no billing receipt. */
export function tokenCost(model, usage, env = process.env) {
  const rate = TOKEN_USD_PER_MILLION[model];
  if (!rate || !usage) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  const usd = ((usage.prompt_tokens - cached) * rate.input + cached * rate.cachedInput + usage.completion_tokens * rate.output) / 1e6;
  return creditCost(usd / EVOLINK_USD_PER_CREDIT, 'tokens', { model, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }, env);
}

export function evolinkKey(env = process.env) {
  const key = env.EVOLINK_API_KEY?.trim();
  if (!key) throw new Error('EvoLink 凭据未配置');
  return key;
}
const scrubber = key => value => String(value).split(key).join('[REDACTED]');

// EvoLink keeps an uploaded file for 72 hours. Reuse it for 48 so the same source image is sent
// once however many artworks (or regenerations) use it; the promise is shared while in flight.
const uploads = new Map();
function uploadOnce(key, image, name) {
  const hit = uploads.get(image.sha256);
  if (hit && hit.expires > Date.now()) return hit.url;
  const url = uploadImage(key, image.path, name).catch(e => { uploads.delete(image.sha256); throw e; });
  uploads.set(image.sha256, { url, expires: Date.now() + 48 * 3600e3 });
  if (uploads.size > 2000) uploads.delete(uploads.keys().next().value);
  return url;
}
export const forgetUploads = images => { for (const image of images) uploads.delete(image.sha256); };
async function uploadImage(key, path, name) {
  const bytes = await readFile(path), meta = await sharp(bytes).metadata();
  const response = await fetch('https://files-api.evolink.ai/api/v1/files/upload/base64', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64_data: `data:image/${meta.format};base64,${bytes.toString('base64')}`, file_name: `${name}.${meta.format}` }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success || typeof body.data?.file_url !== 'string' || !body.data.file_url.startsWith('https://'))
    throw Object.assign(new Error(`EvoLink 素材上传失败 HTTP ${response.status}`), { definiteFailure: true });
  return body.data.file_url;
}

/**
 * The images an artwork actually uses, in source order, with a note when the model would
 * otherwise read the Nth attachment as 图N. Sending every requirement image to every artwork
 * paid for inputs the prompt never referenced.
 */
export function referenceImages(input) {
  const used = input.images.filter(i => input.imageIds.includes(i.id)).sort((a, b) => a.index - b.index);
  const contiguous = used.every((image, n) => image.index === n + 1);
  const note = used.length && !contiguous ? `参考图顺序：${used.map((image, n) => `第${n + 1}张为图${image.index}`).join('，')}。\n\n` : '';
  return { used, note };
}

// Asked for transparency with a coloured garment as reference, Sunburst painted the garment's red
// behind a white logo with a glow, and drew a reference's size marks into the artwork (We25299b0935f).
export const TRANSPARENT_NOTE = '\n\n透明背景：只绘制图稿本身，背景完全透明；除正文写明的色块外，不要添加底色块、衣料颜色、外发光、光晕或投影；参考图上的尺寸标注、箭头、虚线框和圈线不属于图稿。';

/**
 * GPT Image 2.5 Sunburst through EvoLink: asynchronous task, polled by id; the task's own
 * billing record is the cost. Never retried automatically: a submitted task may already be paid.
 */
export async function evolinkGenerate(input, dir, { env = process.env, pollMs = 3000, timeoutMs = 15 * 60_000 } = {}) {
  const key = evolinkKey(env), scrub = scrubber(key);
  const { used, note } = referenceImages(input);
  const urls = await Promise.all(used.map(image => uploadOnce(key, image, `${input.caseId}-${image.index}`)));
  const background = input.transparentBackground === false ? 'opaque' : 'transparent';
  const body = { model: 'gpt-image-2.5-sunburst', prompt: note + input.prompt + (background === 'transparent' ? TRANSPARENT_NOTE : ''), ...(urls.length ? { image_urls: urls } : {}),
    size: input.size || 'auto', quality: input.quality === 'high' ? 'high' : 'medium', background, output_format: 'png', n: 1 };
  await saveJSON(`${dir}/request.json`, { ...body, image_urls: used.map(i => ({ id: i.id, index: i.index, sha256: i.sha256 })) });
  const created = await fetch('https://api.evolink.ai/v1/images/generations', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const createdText = await created.text(); await atomicFile(`${dir}/created.json`, scrub(createdText)); await checkpoint();
  let task; try { task = JSON.parse(createdText); } catch {}
  // 402: the account ran dry (2026-10-24 01:21, a tenant then retried it three times on 原通道).
  if (created.status === 402) { forgetUploads(used); throw Object.assign(new Error('原通道暂时不可用（余额不足），没有扣费；请换「新通道」重新制作'), { definiteFailure: true }); }
  // A rejected submission may mean a reused file has expired early; upload afresh next time.
  if (!created.ok || !task?.id) { forgetUploads(used); throw Object.assign(new Error(`EvoLink 生图提交失败 HTTP ${created.status}；没有自动重试`), { definiteFailure: created.status >= 400 && created.status < 500 }); }
  await saveJSON(`${dir}/task.json`, { taskId: task.id });
  const started = Date.now();
  let detail;
  while (Date.now() - started < timeoutMs) {
    await new Promise(r => setTimeout(r, pollMs));
    const r = await fetch(`https://api.evolink.ai/v1/tasks/${encodeURIComponent(task.id)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    detail = r?.ok ? await r.json().catch(() => null) : detail;
    if (['completed', 'failed', 'cancelled'].includes(detail?.status)) break;
  }
  // Billing settles shortly after completion; wait for it rather than record a guess.
  for (let i = 0; detail?.status === 'completed' && detail.usage?.credits_used === undefined && i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await fetch(`https://api.evolink.ai/v1/tasks/${encodeURIComponent(task.id)}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
    detail = r?.ok ? await r.json().catch(() => detail) : detail;
  }
  await atomicFile(`${dir}/receipt.json`, scrub(JSON.stringify(detail ?? null))); await checkpoint();
  if (detail?.status === 'failed' || detail?.status === 'cancelled') throw Object.assign(new Error(`EvoLink 生图未成功（${detail.status}）；平台不收费，没有自动重试`), { definiteFailure: true });
  const url = detail?.results?.[0] ?? detail?.result_data?.[0]?.url;
  if (detail?.status !== 'completed' || typeof url !== 'string' || !url.startsWith('https://')) throw new Error('EvoLink 生图结果未知；任务编号已保存，没有自动重试');
  const download = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
  if (!download.ok) throw new Error(`生图结果下载 HTTP ${download.status}；任务编号已保存，不重新制作`);
  const bytes = Buffer.from(await download.arrayBuffer());
  const credits = detail.usage?.credits_used;
  const cost = credits === undefined ? { provider: 'evolink', method: 'receipt_pending', taskId: task.id }
    : creditCost(credits, 'receipt', { taskId: task.id, referenceImages: used.length, imageInputTokens: detail.usage.image_input_tokens, imageOutputTokens: detail.usage.image_output_tokens }, env);
  return { bytes, cost, transparentRequested: background === 'transparent' };
}
