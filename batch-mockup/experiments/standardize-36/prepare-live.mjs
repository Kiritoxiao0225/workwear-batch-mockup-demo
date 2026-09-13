import { readFile, open, unlink } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { here, repository, sourceRepository, outputRoot, hash, saveJSON, atomicFile, jsonFile, publish } from './core.mjs';
import { classifyWpsScope } from './wps-scope.mjs';

export function completeMetadata(result, expectedName) {
  if (result.protocol !== 'mockup-wps-1' || result.sheetName !== expectedName || !Number.isSafeInteger(result.sheetId) || result.sheetId <= 0) throw new Error('WPS来源身份不一致');
  if (!Array.isArray(result.fields_schema) || !Array.isArray(result.recordIds) || !Array.isArray(result.recordManifest)) throw new Error('WPS未返回完整字段和记录清单');
  const ids = new Set(result.recordIds);
  if (ids.size !== result.recordIds.length || ids.size !== result.recordManifest.length || new Set(result.recordManifest.map(x => x.id)).size !== ids.size || result.recordManifest.some(x => !ids.has(x.id) || !x.fields || typeof x.fields !== 'object')) throw new Error('WPS记录ID或数量不完整，不能当作全量');
  return result.recordManifest.filter(x => classifyWpsScope({ status: x.fields['任务状态'] }).stage === 'first_generation');
}
export function completeRead(result, ids, metadata) {
  if (result.sheetId !== metadata.sheetId || result.sheetName !== metadata.sheetName || JSON.stringify(result.fields_schema) !== JSON.stringify(metadata.fields_schema)) throw new Error('读取期间WPS表结构变化');
  if (!Array.isArray(result.records) || result.records.length !== ids.length || result.records.some((x, i) => x.id !== ids[i])) throw new Error('WPS原文读取数量或身份不一致');
  return result.records;
}
async function download(url) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hostname === 'localhost' || /^[\d:[\]]+$/u.test(target.hostname)) throw new Error('附件地址格式不正确');
  const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`附件下载HTTP ${response.status}`);
  const max = 40 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new Error('附件超过40MB'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('附件没有文件内容');
  let size = 0; const chunks = [];
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > max) throw new Error('附件超过40MB'); chunks.push(part.value); } }
  finally { await reader.cancel(); }
  if (!size) throw new Error('附件为空文件');
  return Buffer.concat(chunks);
}
async function prepareLive() {
  if (!process.env.A_REVIEW_OUTPUT || await jsonFile(resolve(outputRoot, 'manifest.json'), null)) throw new Error('全量读取须使用独立且尚未冻结的输出目录');
  const env = parseEnv(await readFile(resolve(sourceRepository, '.env.local'), 'utf8'));
  const endpoint = new URL(env.WPS_AIRSCRIPT_WEBHOOK), match = /^\/api\/v3\/ide\/file\/([A-Za-z0-9_-]+)\/script\/[A-Za-z0-9_-]+\/sync_task$/u.exec(endpoint.pathname);
  if (!['https://www.kdocs.cn', 'https://365.kdocs.cn'].includes(endpoint.origin) || !match || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !env.WPS_AIRSCRIPT_TOKEN) throw new Error('WPS只读配置不完整');
  const sourceLink = new URL(env.WPS_SOURCE_URL);
  if (!sourceLink.pathname.split('/').includes(match[1]) && env.WPS_DBSHEET_FILE_ID?.trim() !== match[1]) throw new Error('WPS脚本与指定源表不一致');
  const apiBase = new URL(env.CLIPROXY_API_BASE_URL);
  if (apiBase.protocol !== 'https:' || apiBase.username || apiBase.password || apiBase.search || apiBase.hash) throw new Error('识图API配置不正确');
  const receipts = [];
  async function call(input) {
    if (!['metadata', 'read'].includes(input.action)) throw new Error('仅允许只读操作');
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'AirScript-Token': env.WPS_AIRSCRIPT_TOKEN }, body: JSON.stringify({ Context: { argv: input } }), signal: AbortSignal.timeout(55000) });
    if (!response.ok) throw new Error(`WPS读取HTTP ${response.status}`);
    const raw = await response.text(), envelope = JSON.parse(raw);
    if (envelope.status !== 'finished' || envelope.error) throw new Error('WPS只读脚本未正常返回');
    const result = typeof envelope.data.result === 'string' ? JSON.parse(envelope.data.result) : envelope.data.result;
    receipts.push({ action: input.action, recordIds: input.recordIds, readAt: new Date().toISOString(), responseSHA256: hash(raw) });
    return result;
  }
  const startedAt = new Date().toISOString();
  const metadata = await call({ action: 'metadata' });
  const eligible = completeMetadata(metadata, env.WPS_DBSHEET_SHEET_NAME?.trim() || '效果图任务管理');
  const limit = process.env.A_REVIEW_LIMIT ? Number(process.env.A_REVIEW_LIMIT) : eligible.length;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('样本数量必须为正整数');
  const selected = eligible.slice(0, limit);
  console.log(`WPS complete: ${metadata.recordIds.length} rows, ${eligible.length} eligible, ${selected.length} selected in source order`);
  const previous = await jsonFile(resolve(repository, 'output/a-standardization-36-20260913-v2/scope.json'));
  const priorId = new Map(Object.entries(previous.cases).map(([caseId, c]) => [c.recordId, caseId]));
  const oldSupplements = await jsonFile(resolve(repository, 'output/a-standardization-36-20260913-v2/supplements.json'), {});
  if (Object.values(oldSupplements).some(x => x.items.some(i => !i.removedAt))) throw new Error('存在设计师补充图片，须一并明确纳入新输入，不能忽略后运行');
  const records = [];
  for (let n = 0; n < selected.length; n += 50) {
    const ids = selected.slice(n, n + 50).map(x => x.id);
    records.push(...completeRead(await call({ action: 'read', sheetId: metadata.sheetId, recordIds: ids }), ids, metadata));
  }
  const cases = [], scopeCases = {}; let freshNumber = 0;
  const queue = records.map(record => ({ record, caseId: priorId.get(record.id) || 'N' + String(++freshNumber).padStart(2, '0') }));
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const { record, caseId } = queue.shift();
      const c = { caseId, group: 'WPS当前全量', sourceRecordId: `${match[1]}:${metadata.sheetId}:${record.id}`, sourceText: '', sourceTextSHA256: '', images: [] };
      let fields = {};
      try {
        if (record.error || typeof record.fields !== 'string') throw new Error('原记录读取失败');
        fields = JSON.parse(record.fields);
        if (classifyWpsScope({ status: fields['任务状态'] }).stage !== 'first_generation') throw new Error('读取时状态已变化，未进行识图');
        const brief = fields['任务要求说明'];
        if (typeof brief !== 'string' || !brief.trim()) throw new Error('原始需求为空');
        c.sourceText = brief; c.sourceTextSHA256 = hash(brief); c.wpsStatus = fields['任务状态'];
        const materials = fields['任务素材图片'] || [];
        if (!Array.isArray(materials)) throw new Error('附件集合格式不正确');
        c.sourceAttachmentCount = materials.length;
        for (const [idx, item] of materials.entries()) {
          if (!item.id || typeof item.url !== 'string') throw new Error(`图${idx + 1}缺少稳定身份或下载地址`);
          const bytes = await download(item.url), decoder = sharp(bytes, { limitInputPixels: 80_000_000, failOn: 'warning' }), meta = await decoder.metadata();
          if (!['jpeg', 'png', 'webp'].includes(meta.format) || (meta.pages || 1) !== 1) throw new Error(`图${idx + 1}格式不受支持`);
          await decoder.stats();
          let input = bytes, mime = `image/${meta.format}`, transform = 'original';
          if (bytes.length > 8 * 1024 * 1024) { input = await sharp(bytes).webp({ lossless: true }).toBuffer(); mime = 'image/webp'; transform = 'lossless-webp'; if (input.length > 8 * 1024 * 1024) throw new Error(`图${idx + 1}无损处理后仍超过8MB，未静默缩小`); }
          const imageId = `${caseId}-${idx + 1}`, asset = `assets/${imageId}.${meta.format === 'jpeg' ? 'jpg' : meta.format}`, inputFile = `inputs/${imageId}.${mime.split('/')[1]}`;
          await atomicFile(resolve(outputRoot, 'public', asset), bytes); await atomicFile(resolve(outputRoot, inputFile), input);
          c.images.push({ index: idx + 1, imageId, asset, width: meta.width, height: meta.height, hasAlpha: !!meta.hasAlpha, attachmentId: String(item.id), sourceFileName: item.fileName || '', originalBytes: bytes.length, originalSHA256: hash(bytes), inputFile, inputBytes: input.length, inputSHA256: hash(input), mime, transform, fetchedAt: new Date().toISOString(), fetchURLSHA256: hash(item.url) });
        }
        console.log(`${caseId} ${record.id}: ${c.images.length} original images fetched`);
      } catch (error) {
        c.sourceReadError = /^(附件|图\d|原|读取|WPS)/u.test(error.message) ? error.message : '源素材下载或解码失败';
        await saveJSON(resolve(outputRoot, `results/${caseId}.json`), { status: 'failed', attempt: 0, error: c.sourceReadError + '；未调用模型', sourceFailure: true });
        console.log(`${caseId}: source blocked`);
      }
      cases.push(c);
      scopeCases[caseId] = { stage: 'first_generation', recordId: record.id, wpsStatus: fields['任务状态'] || '', decisionBy: 'live_wps_status', reason: '当前全表按待领取／未领取筛选，不按修改次数筛选。' };
      if (!c.sourceAttachmentCount && /logo|源文件|图[一二三123]/iu.test(c.sourceText)) scopeCases[caseId].missingMaterial = { target: '左胸Logo/图稿素材', reason: '原文引用图片或Logo，但WPS没有附件；可补传实际素材。' };
    }
  }));
  cases.sort((a, b) => selected.findIndex(x => a.sourceRecordId.endsWith(':' + x.id)) - selected.findIndex(x => b.sourceRecordId.endsWith(':' + x.id)));
  if (cases.length !== selected.length) throw new Error('全量输入数量不匹配');
  const prompt = (await readFile(resolve(here, 'prompt.txt'), 'utf8')).trimEnd();
  const run = { id: basename(outputRoot), label: '全量重新读取 · A独立初审', startedAt, sourceReadAt: receipts.at(-1).readAt, source: '本轮实时WPS全表清单及原始记录/附件', baseline: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), sourceFileId: match[1], sourceSheetId: metadata.sheetId, sourceSheetName: metadata.sheetName, totalSourceRecords: metadata.recordIds.length, caseCount: cases.length, imageCount: cases.reduce((n, x) => n + x.images.length, 0), promptSHA256: hash(prompt), provider: env.WPS_ANALYSIS_PROVIDER, apiEndpoint: apiBase.toString().replace(/\/$/u, '') + '/chat/completions', model: null, effort: null, requirementFormat: 'artwork-first', tools: [], noAutomaticRetry: true, previousURL: 'http://127.0.0.1:3199/', batchNote: '本轮重新读取当前状态全量，逐条重新调用同一提示词，不复用历史模型答案；原文、原图、实际返回和Codex初审分开保留。', confirmation: 'Codex初审完成后再供用户复核；接口成功不等于语义通过。' };
  Object.assign(run, { eligibleCount: eligible.length, selection: process.env.A_REVIEW_LIMIT ? `按源表顺序选取前${limit}条待领取/未领取，本批不是全量` : '全部待领取/未领取' });
  await saveJSON(resolve(outputRoot, 'source-receipt.json'), { startedAt, readAt: receipts.at(-1).readAt, action: 'metadata/read', readOnly: true, recordCount: metadata.recordIds.length, eligibleCount: eligible.length, selection: run.selection, statusCounts: metadata.recordManifest.reduce((a, x) => { const k = String(x.fields['任务状态'] || ''); a[k] = (a[k] || 0) + 1; return a; }, {}), selectedIds: selected.map(x => x.id), selectedCount: selected.length, calls: receipts, newCases: cases.filter(x => x.caseId.startsWith('N')).map(x => ({ caseId: x.caseId, recordId: x.sourceRecordId })) });
  await saveJSON(resolve(outputRoot, 'scope.json'), { version: 1, method: '实时WPS全量状态筛选', rules: ['只取待领取／未领取', '不按修改次数筛选', '缺素材另列问题并提供补图入口'], cases: scopeCases });
  await atomicFile(resolve(outputRoot, 'prompt.txt'), prompt);
  await saveJSON(resolve(outputRoot, 'manifest.json'), { run, cases });
  await publish();
  console.log(JSON.stringify({ prepared: cases.length, images: run.imageCount, sourceBlocked: cases.filter(x => x.sourceReadError).length, apiEndpoint: run.apiEndpoint, promptSHA256: run.promptSHA256 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await atomicFile(resolve(outputRoot, '.prepare-info'), new Date().toISOString());
  const lock = await open(resolve(outputRoot, '.preparing'), 'wx');
  try { await prepareLive(); } finally { await lock.close(); await unlink(resolve(outputRoot, '.preparing')); }
}
