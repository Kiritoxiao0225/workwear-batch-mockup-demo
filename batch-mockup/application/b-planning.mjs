import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configuredAnalyzer } from '../adapters/a-analysis.mjs';
import { hash, fail, saveJSON, jsonFile, assetPath } from '../adapters/a-files.mjs';
import { planJSONSchema } from '../domain/b-plan.mjs';
import { prepareBInput } from './b-input.mjs';
import { validateBPlan } from './b-validation.mjs';

export async function buildPlanningRequest(input, bytes) {
  const prompt = await readFile(new URL('./b-prompt.txt', import.meta.url), 'utf8');
  const content = [{ type: 'text', text: JSON.stringify({ input, outputSchema: planJSONSchema }) }];
  for (const image of input.confirmation.images) {
    const facts = input.images.find(i => i.id === image.id), data = bytes.get(image.asset);
    if (!data || hash(data) !== image.sha256) throw fail('模型请求图片与A确认不一致');
    content.push({ type: 'text', text: JSON.stringify({ imageId: image.id, label: image.label, usage: image.target }) },
      { type: 'image_url', image_url: { url: `data:image/${facts.format};base64,${data.toString('base64')}`, detail: 'high' } });
  }
  return { model: 'gpt-5.6-sol', reasoning_effort: 'low', response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: prompt }, { role: 'user', content }] };
}

// Independent module entry: one paid proposal, immutable evidence, never an automatic retry.
export async function planConfirmedRequirement({ receipt, readAsset, output, root, analyzerFactory = configuredAnalyzer }) {
  const { input, bytes } = await prepareBInput(receipt, readAsset, output);
  const request = await buildPlanningRequest(input, bytes);
  const requestSHA256 = hash(JSON.stringify(request)), runId = requestSHA256, dir = resolve(root, runId);
  await mkdir(root, { recursive: true });
  // Resolve missing configuration before reserving a paid request.
  const analyze = await analyzerFactory();
  try { await mkdir(dir); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return await jsonFile(resolve(dir, 'result.json'), { runId, status: 'unknown', error: '同一输入已有运行；只读回已有结果，未重发API' });
  }
  const result = { schema: 'b-run-v1', runId, requestSHA256, inputSHA256: hash(JSON.stringify(input)),
    promptSHA256: hash(request.messages[0].content), model: request.model, effort: request.reasoning_effort,
    startedAt: new Date().toISOString(), status: 'running', actualImageProduction: false };
  await saveJSON(resolve(dir, 'input.json'), input);
  await saveJSON(resolve(dir, 'request.json'), request);
  await saveJSON(resolve(dir, 'result.json'), result);
  const start = Date.now();
  try {
    const response = await analyze(request);
    await saveJSON(resolve(dir, 'response.json'), response);
    result.responseSHA256 = hash(JSON.stringify(response));
    result.responseId = response.responseId; result.httpStatus = response.httpStatus; result.reportedModel = response.reportedModel;
    const plan = JSON.parse(response.rawContent);
    result.validation = await validateBPlan(plan, input);
    await saveJSON(resolve(dir, 'plan.json'), plan);
    result.status = result.validation.valid ? (plan.artworks.some(a => a.outputStepId === null) ? 'blocked' : 'planned') : 'invalid_plan';
    if (result.validation.valid) {
      // Copy verified source bytes; A asset paths and identities remain unchanged.
      for (const image of input.confirmation.images) {
        const target = assetPath(dir, image.asset); await mkdir(resolve(target, '..'), { recursive: true });
        await writeFile(target, bytes.get(image.asset), { flag: 'wx', mode: 0o600 });
      }
      const payload = { schema: 'b-to-c-v1', runId, input, plan, validation: result.validation, actualImageProduction: false };
      await saveJSON(resolve(dir, 'handoff.json'), { sha256: hash(JSON.stringify(payload)), payload });
    }
  } catch (error) {
    const gotResponse = await jsonFile(resolve(dir, 'response.json'), null);
    result.status = gotResponse ? 'invalid_output' : 'unknown';
    result.error = gotResponse ? '模型输出解析、校验或保存失败：' + error.message : 'API结果未知或提交失败；保留请求，未自动重发';
  }
  result.durationMs = Date.now() - start; result.finishedAt = new Date().toISOString();
  await saveJSON(resolve(dir, 'result.json'), result);
  return result;
}

// C reception contract only: validates current A version and actual image bytes.
// No executor is invoked by reception, reading a report, or refreshing a page.
export async function readCInput(dir, currentReceipt) {
  const bundle = await jsonFile(resolve(dir, 'handoff.json'));
  if (bundle.sha256 !== hash(JSON.stringify(bundle.payload)) || bundle.payload.schema !== 'b-to-c-v1') throw fail('B交接文件校验失败');
  const { input, plan } = bundle.payload;
  if (currentReceipt?.inputSHA256 !== input.confirmationSHA256 || hash(JSON.stringify(currentReceipt.input)) !== input.confirmationSHA256) throw fail('A确认版本已变化或缺失，需要按对应版本重新规划', 409);
  const prepared = await prepareBInput(currentReceipt, asset => readFile(assetPath(dir, asset)), input.output);
  if (hash(JSON.stringify(prepared.input)) !== hash(JSON.stringify(input))) throw fail('能力、字体或图片事实已变化，需要重新校验规划', 409);
  const validation = await validateBPlan(plan, prepared.input);
  if (!validation.valid) throw fail('制作计划校验不通过', 409);
  return { ...bundle.payload, validation, canExecute: validation.executable };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [aRoot, caseId, confirmationId, width, height, destination] = process.argv.slice(2);
  if (!destination) throw new Error('用法：tsx batch-mockup/application/b-planning.mjs A目录 案例ID 确认ID 宽像素 高像素 输出目录');
  const { readBInput } = await import('./a-review.mjs');
  const receipt = await readBInput(aRoot, await jsonFile(resolve(aRoot, 'manifest.json')), caseId, confirmationId);
  console.log(JSON.stringify(await planConfirmedRequirement({ receipt, readAsset: asset => readFile(assetPath(aRoot, asset)),
    output: { width: Number(width), height: Number(height), background: 'preserve', sizing: 'exact', basis: '运行时指定的目标像素；背景默认保留透明' }, root: destination }), null, 2));
}
