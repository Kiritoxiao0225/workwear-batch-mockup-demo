import sharp from 'sharp';
import { resolve } from 'node:path';
import { hash, jsonFile, saveJSON, atomicFile, assetPath, fail, readBytes } from '../adapters/a-files.mjs';
import { inspectPixels } from '../adapters/production-images.mjs';
import { applyRepairStroke, validateRepairStrokes } from './repair-pixels.mjs';

function jobDir(root, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw fail('制作编号无效');
  return resolve(root, 'production-jobs', id);
}
export async function readRepairState(root, id) {
  return jsonFile(resolve(jobDir(root, id), 'repair-state.json'), { revision: 0, current: null, history: [] });
}
export async function readRepairInput(root, id) {
  const job = await jsonFile(resolve(jobDir(root, id), 'state.json'), null);
  if (!job?.raw) throw fail('尚无可修补图片', 409);
  if (['running', 'queued', 'unknown'].includes(job.status)) throw fail('制作尚未结束，暂不能修补', 409);
  const state = await readRepairState(root, id), original = job.final || job.raw, current = state.current?.file || original;
  if ([original, current].some(f => f.width !== job.raw.width || f.height !== job.raw.height)) throw fail('原图与结果尺寸不一致，无法准确对齐修补', 409);
  if (job.raw.width * job.raw.height > 16_000_000) throw fail('当前修补工具最多支持1600万像素', 409);
  return { jobId: id, name: `${job.caseId} · ${job.name}`, revision: state.revision, raw: job.raw, original, current, history: state.history };
}
async function decode(root, file) {
  const bytes = await readBytes(assetPath(root, file.asset));
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw fail('图片文件校验失败，未保存修补', 409);
  const { data, info } = await sharp(bytes, { limitInputPixels: 16_000_000 }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== file.width || info.height !== file.height || info.channels !== 4) throw fail('图片尺寸与记录不一致', 409);
  return data;
}

// Call through the server's serialized write queue. No provider is used or imported.
export async function saveProductionRepair(root, body) {
  if (!body || !/^[a-f0-9-]{36}$/u.test(body.requestId || '') || !Number.isInteger(body.revision) || body.revision < 0) throw fail('修补请求格式不正确');
  const input = await readRepairInput(root, body.jobId), state = await readRepairState(root, body.jobId);
  const requestSHA256 = hash(JSON.stringify({ revision: body.revision, currentSHA256: body.currentSHA256, rawSHA256: body.rawSHA256, strokes: body.strokes }));
  const existing = state.history.find(x => x.requestId === body.requestId);
  if (existing) {
    if (existing.requestSHA256 !== requestSHA256) throw fail('保存编号已用于其他修补内容', 409);
    return { ...state, savedRevision: existing.revision, replayed: true };
  }
  if (input.revision !== body.revision || input.current.sha256 !== body.currentSHA256 || input.raw.sha256 !== body.rawSHA256) throw fail('图片已在其他页面修补，请保留本页笔画，重新打开最新结果再修改', 409);
  try { validateRepairStrokes(body.strokes, input.raw.width, input.raw.height); } catch (e) { throw fail(e.message); }
  const [source, base, original] = await Promise.all([decode(root, input.raw), decode(root, input.current), decode(root, input.original)]);
  const pixels = Buffer.from(base), { width, height } = input.raw;
  try { for (const stroke of body.strokes) applyRepairStroke(pixels, source, original, width, height, stroke); }
  catch (e) { throw fail(e.message); }
  const bytes = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const inspected = await inspectPixels(bytes);
  if (!inspected.visiblePixels) throw fail('修补结果完全透明，请撤销部分去除操作后再保存');
  const revision = state.revision + 1, sha256 = hash(bytes), asset = `production-results/${body.jobId}/repair-${revision}-${sha256}.png`;
  await atomicFile(assetPath(root, asset), bytes);
  if (hash(await readBytes(assetPath(root, asset))) !== sha256) throw fail('修补图片写入校验失败', 500);
  const entry = { revision, requestId: body.requestId, requestSHA256, savedAt: new Date().toISOString(), source: 'manual_repair',
    baseSHA256: input.current.sha256, rawSHA256: input.raw.sha256, originalSHA256: input.original.sha256,
    file: { asset, sha256, bytes: bytes.length, ...inspected }, qualityStatus: 'not_reviewed' };
  await saveJSON(resolve(jobDir(root, body.jobId), `repair-${revision}.json`), { ...entry, strokes: body.strokes });
  const next = { revision, current: entry, history: [...state.history, entry] };
  await saveJSON(resolve(jobDir(root, body.jobId), 'repair-state.json'), next);
  return { ...next, savedRevision: revision, replayed: false };
}
