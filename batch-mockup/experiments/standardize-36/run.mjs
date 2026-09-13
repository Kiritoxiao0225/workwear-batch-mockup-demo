import { readFile, mkdir, open, unlink, copyFile } from 'node:fs/promises';
import { resolve, extname, basename } from 'node:path';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { here, repository, outputRoot, sourceRepository, hash, jsonFile, saveJSON, publish, atomicFile, parseResult, structuralObservations } from './core.mjs';

const mode = process.argv[2] || 'prepare';
if (!['prepare', 'run', 'publish'].includes(mode)) throw new Error('使用 prepare、run 或 publish');
const prompt = (await readFile(process.env.A_REVIEW_PROMPT ? resolve(repository, process.env.A_REVIEW_PROMPT) : resolve(here, 'prompt.txt'), 'utf8')).trimEnd();
const promptSHA = hash(prompt);

async function prepare() {
  const existing = await jsonFile(resolve(outputRoot, 'manifest.json'), null);
  if (existing) {
    if (existing.run.promptSHA256 !== promptSHA) throw new Error('本批提示词已固定；更改提示词须创建新批次，不能覆盖结果');
    return existing;
  }
  const root = resolve(sourceRepository, 'output/architecture-rebuild-20260912');
  const originals = await jsonFile(resolve(root, 'private/material-inventory.json'));
  const sources = [
    { path: resolve(root, 'review/design-cases.json'), base: resolve(root, 'review'), group: '开发案例' },
    { path: resolve(root, 'private/holdout-cases.json'), base: sourceRepository, group: '保留案例' },
  ];
  const cases = [];
  for (const source of sources) for (const c of await jsonFile(source.path)) {
    if (!/^[DH]\d{2}$/u.test(c.caseId) || typeof c.requirement !== 'string') throw new Error('案例身份/原文格式不正确');
    const images = [];
    for (const m of c.materials) {
      const sourceMaterial = m.extraction ? originals.find(x => x.caseId === c.caseId && x.index === m.index) : m;
      if (!sourceMaterial || (m.extraction && sourceMaterial.sha256 !== m.extraction.sourceSha256)) throw new Error('原图追溯信息不一致');
      const sourcePath = m.extraction ? resolve(root, 'private/originals', c.caseId, basename(sourceMaterial.file)) : resolve(source.base, m.file);
      const bytes = await readFile(sourcePath);
      if (hash(bytes) !== sourceMaterial.sha256 || bytes.length !== sourceMaterial.bytes) throw new Error(`${c.caseId} 图${m.index} 与冻结原图不一致`);
      const meta = await sharp(bytes, { limitInputPixels: 80_000_000 }).metadata();
      if (!['png', 'jpeg', 'webp'].includes(meta.format)) throw new Error('不支持的图片格式');
      let input = bytes, mime = `image/${meta.format}`, transform = 'original';
      if (bytes.length > 8 * 1024 * 1024) {
        input = await sharp(bytes).rotate().webp({ lossless: true }).toBuffer();
        mime = 'image/webp'; transform = 'lossless-webp';
        if (input.length > 8 * 1024 * 1024) throw new Error(`${c.caseId} 图${m.index} 无损压缩后仍大于8MB；不能静默降低画质`);
      }
      const imageId = `${c.caseId}-${m.index}`;
      const asset = `assets/${imageId}${extname(sourcePath).toLowerCase()}`;
      await mkdir(resolve(outputRoot, 'public/assets'), { recursive: true });
      await copyFile(sourcePath, resolve(outputRoot, 'public', asset));
      const inputFile = `inputs/${imageId}.${mime.split('/')[1]}`;
      await atomicFile(resolve(outputRoot, inputFile), input);
      images.push({ index: m.index, imageId, asset, width: meta.width, height: meta.height, hasAlpha: !!meta.hasAlpha,
        originalBytes: bytes.length, originalSHA256: hash(bytes), inputFile, inputBytes: input.length, inputSHA256: hash(input), mime, transform, restoredFullOriginal: !!m.extraction });
    }
    // Historical titles, acceptance, expected, observed and prior interpretations are deliberately excluded.
    cases.push({ caseId: c.caseId, group: source.group, sourceText: c.requirement, sourceTextSHA256: hash(c.requirement), images });
  }
  if (cases.length !== 36 || new Set(cases.map(c => c.caseId)).size !== 36) throw new Error('案例数量或身份不一致');
  const manifest = { run: { id: basename(outputRoot), startedAt: new Date().toISOString(), baseline: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    promptSHA256: promptSHA, source: '既有36条真实WPS案例快照；非实时重新拉取后台', caseCount: 36, imageCount: cases.reduce((s, c) => s + c.images.length, 0),
    provider: 'cliproxy', model: null, effort: null, requirementFormat: 'artwork-first', tools: [], noAutomaticRetry: true, originalRestoration: '所有输入均追溯完整原图；不使用历史分享裁图', confirmation: '待人工审阅；接口返回不等于理解正确',
    holdoutBoundary: '12条保留案例本次按用户授权进入同一模型评测；未向网页版Pro发送，也不再宣称严格未见过的盲测' }, cases };
  await saveJSON(resolve(outputRoot, 'manifest.json'), manifest);
  await atomicFile(resolve(outputRoot, 'prompt.txt'), prompt);
  return manifest;
}

async function run() {
  const manifest = await prepare();
  const env = parseEnv(await readFile(resolve(sourceRepository, '.env.local'), 'utf8'));
  if (env.WPS_ANALYSIS_PROVIDER !== 'cliproxy') throw new Error('当前配置不为已选定的cliproxy；未切换供应商');
  const key = env.CLIPROXY_API_KEY?.trim(), base = new URL(env.CLIPROXY_API_BASE_URL);
  if (!key || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname.replace(/\/$/u, '') !== '/v1') throw new Error('现有识图配置不完整');
  const model = env.WPS_ANALYSIS_MODEL?.trim() || 'gpt-5.6-sol';
  const effort = env.WPS_ANALYSIS_REASONING_EFFORT?.trim() || 'medium';
  if (manifest.run.model && (manifest.run.model !== model || manifest.run.effort !== effort)) throw new Error('不能在同一批内静默切换模型参数');
  Object.assign(manifest.run, { model, effort });
  await saveJSON(resolve(outputRoot, 'manifest.json'), manifest);
  await publish();
  const lockPath = resolve(outputRoot, '.running');
  const lock = await open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  let stopped = false;
  const one = async c => {
    const scope = await jsonFile(resolve(outputRoot, 'scope.json'), null);
    if (scope && scope.cases[c.caseId]?.stage !== 'first_generation') return;
    const output = resolve(outputRoot, `results/${c.caseId}.json`);
    if (await jsonFile(output, null)) return; // Never resend an unknown or completed request on resume.
    if (stopped) return;
    const content = [{ type: 'text', text: JSON.stringify({ 原始需求: c.sourceText, 图片数量: c.images.length }) }];
    for (const img of c.images) {
      const bytes = await readFile(resolve(outputRoot, img.inputFile));
      if (hash(bytes) !== img.inputSHA256) throw new Error('实际发送图片与输入快照不一致');
      content.push({ type: 'text', text: `图${img.index}（${img.width}×${img.height}，${img.hasAlpha ? '文件含透明通道' : '文件不含透明通道'}）：` });
      content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${bytes.toString('base64')}`, detail: 'high' } });
    }
    const request = { model, reasoning_effort: effort, max_completion_tokens: 16000, response_format: { type: 'json_object' }, stream: false,
      messages: [{ role: 'system', content: prompt }, { role: 'user', content }] };
    const encoded = JSON.stringify(request);
    const started = Date.now();
    const record = { status: 'running', startedAt: new Date(started).toISOString(), model, effort, promptSHA256: promptSHA,
      requestSHA256: hash(encoded), requestBytes: Buffer.byteLength(encoded), inputImages: c.images.length, sourceTextSHA256: c.sourceTextSHA256, attempt: 1 };
    await saveJSON(resolve(outputRoot, `requests/${c.caseId}.json`), { ...record, parameters: { model, reasoning_effort: effort, max_completion_tokens: 16000, response_format: 'json_object', detail: 'high', stream: false, tools: [] },
      inputImages: c.images.map(x => ({ index: x.index, inputFile: x.inputFile, sha256: x.inputSHA256 })), sourceText: c.sourceText });
    await saveJSON(output, record);
    console.log(`${c.caseId} start (${c.images.length} images)`);
    try {
      const response = await fetch(`${base.toString().replace(/\/$/u, '')}/chat/completions`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: encoded, signal: AbortSignal.timeout(240000) });
      record.httpStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403, 429].includes(response.status)) stopped = true;
        throw new Error(`HTTP ${response.status}；未自动重试或切换模型`);
      }
      const responseText = await response.text();
      record.responseSHA256 = hash(responseText);
      if (responseText.includes(key)) throw new Error('响应包含敏感配置，未保存其内容');
      const body = JSON.parse(responseText);
      const choice = body.choices?.[0];
      if (!choice?.message) throw new Error('响应缺少choices/message');
      const raw = { id: body.id, model: body.model, created: body.created, usage: body.usage, choices: [{ finish_reason: choice.finish_reason, message: { role: choice.message.role, content: choice.message.content, refusal: choice.message.refusal } }] };
      await saveJSON(resolve(outputRoot, `responses/${c.caseId}.json`), raw);
      Object.assign(record, { responseId: body.id, reportedModel: body.model, usage: body.usage, finishReason: choice.finish_reason, rawContent: choice.message.content });
      if (choice.finish_reason === 'length' || choice.message.refusal) throw new Error('模型输出被截断或未完成；保留实际返回');
      try {
        record.parsed = parseResult(choice.message.content);
        record.structuralObservations = structuralObservations(record.parsed, c.images.length, manifest.run.requirementFormat);
        record.status = 'returned';
      } catch (error) { record.status = 'invalid_output'; record.error = error.message; }
    } catch (error) {
      record.status = record.httpStatus === 200 ? 'invalid_output' : 'failed';
      record.error = error.name === 'TimeoutError' ? '等待响应超时，结果未知；未自动重试' : /^(HTTP |响应|模型输出)/u.test(error.message) ? error.message : '连接或响应处理失败；未自动重试';
    }
    record.elapsedMs = Date.now() - started;
    record.finishedAt = new Date().toISOString();
    await saveJSON(output, record);
    console.log(`${c.caseId} ${record.status} ${(record.elapsedMs / 1000).toFixed(1)}s`);
    await publish();
  };
  try {
    // One real case first verifies the existing endpoint without spending on an extra artificial probe.
    const first = manifest.cases.find(c => c.caseId === 'D04') || manifest.cases[0];
    if (first) await one(first);
    const queue = manifest.cases.filter(c => c !== first);
    await Promise.all(Array.from({ length: 2 }, async () => { while (queue.length && !stopped) await one(queue.shift()); }));
    const data = await publish();
    const summary = { completedAt: new Date().toISOString(), total: data.cases.length, returned: data.cases.filter(c => c.result.status === 'returned').length,
      invalid: data.cases.filter(c => c.result.status === 'invalid_output').length, failed: data.cases.filter(c => c.result.status === 'failed').length,
      notRun: data.cases.filter(c => !c.result.attempt).length,
      submitted: data.cases.filter(c => c.result.attempt).length,
      scope: Object.fromEntries(['first_generation', 'status_excluded', 'stage_unknown'].map(stage => {
        const items = data.cases.filter(c => c.scope?.stage === stage);
        return [stage, { total: items.length, returned: items.filter(c => c.result.status === 'returned').length, submitted: items.filter(c => c.result.attempt).length, notRun: items.filter(c => !c.result.attempt).length }];
      })), model, effort, promptSHA256: promptSHA, stoppedForProvider: stopped };
    await saveJSON(resolve(outputRoot, 'run-summary.json'), summary);
    console.log(JSON.stringify(summary));
  } finally { await lock.close(); await unlink(lockPath); }
}

if (mode === 'prepare') { const m = await prepare(); await publish(); console.log(JSON.stringify({ cases: m.cases.length, images: m.run.imageCount, promptSHA256: promptSHA, compressed: m.cases.flatMap(c => c.images.filter(i => i.transform !== 'original').map(i => ({ caseId: c.caseId, index: i.index, bytes: i.inputBytes }))) })); }
if (mode === 'run') await run();
if (mode === 'publish') { const d = await publish(); console.log(`Published ${d.cases.length} cases`); }
