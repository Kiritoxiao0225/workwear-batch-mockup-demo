import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { readAState, recoverAnalyses, reserveAnalysis, finishAnalysis, acceptAnalysis, confirmRequirement, readBInput, canConfirm } from '../../application/a-review.mjs';
import { outputRoot, jsonFile, saveJSON, atomicFile, hash } from './core.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
async function readBody(req, limit) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail('文件或内容过大', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('JSON无效'); }
}
async function saveSupplement(root, body, caseIds) {
  if (!body || !caseIds.has(body.caseId) || !Number.isInteger(body.revision) || !['upload', 'remove'].includes(body.action)) throw fail('补图请求格式不正确');
  const scope = await jsonFile(resolve(root, 'scope.json'), null);
  if (scope && scope.cases[body.caseId]?.stage !== 'first_generation') throw fail('本轮只处理首次制作，当前案例已移出', 409);
  const all = await jsonFile(resolve(root, 'supplements.json'), {});
  const current = all[body.caseId] || { revision: 0, items: [] };
  if (body.action === 'upload') {
    if (typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(body.id) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 240 || typeof body.target !== 'string' || !body.target.trim() || body.target.length > 200 || typeof body.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body.base64)) throw fail('请选择图片并填写素材用途');
    const bytes = Buffer.from(body.base64, 'base64');
    if (bytes.length > 15 * 1024 * 1024) throw fail('单张图片不能超过15MB', 413);
    if (bytes.toString('base64') !== body.base64) throw fail('图片编码不完整');
    const sha256 = hash(bytes), existing = current.items.find(x => x.id === body.id);
    if (existing) {
      if (existing.sha256 !== sha256 || existing.target !== body.target.trim() || existing.name !== body.name) throw fail('上传标识已用于其他内容', 409);
      return current; // Retry an uncertain upload without duplicating the attachment.
    }
    if (body.revision !== current.revision) throw fail('素材已在其他页面更新，请刷新后再操作', 409);
    if (current.items.filter(x => !x.removedAt).length >= 10) throw fail('每条最多补充10张图片');
    let metadata;
    try {
      const decoder = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
      metadata = await decoder.metadata();
      if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) throw new Error();
      await decoder.stats(); // Decode the complete image, not only its header.
    } catch { throw fail('无法读取图片，请使用完整的PNG、JPG或WebP静态图片（不超过4000万像素）'); }
    const asset = `supplements/${body.caseId}/${body.id}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`;
    await atomicFile(resolve(root, 'public', asset), bytes);
    current.items.push({ id: body.id, name: body.name, target: body.target.trim(), sha256, bytes: bytes.length, width: metadata.width, height: metadata.height, asset, uploadedAt: new Date().toISOString(), source: 'designer_upload' });
  } else {
    if (body.revision !== current.revision) throw fail('素材已在其他页面更新，请刷新后再操作', 409);
    const item = current.items.find(x => x.id === body.id && !x.removedAt);
    if (!item) throw fail('未找到这张补图', 404);
    item.removedAt = new Date().toISOString(); // Retain bytes and audit history; original attachments are never altered.
  }
  current.revision += 1;
  current.updatedAt = new Date().toISOString();
  current.status = current.items.some(x => !x.removedAt) ? 'pending_reanalysis' : 'no_active_supplements';
  all[body.caseId] = current;
  await saveJSON(resolve(root, 'supplements.json'), all);
  return current;
}

export function validateReview(body, caseIds, current) {
  if (!body || !caseIds.has(body.caseId) || typeof body.text !== 'string' || body.text.length > 40000 || typeof body.note !== 'string' || body.note.length > 4000 || !['pending', 'checked', 'needs_changes'].includes(body.state) || !Number.isInteger(body.revision)) throw Object.assign(new Error('审阅内容格式不正确'), { status: 400 });
  if (body.revision !== (current?.revision || 0)) throw Object.assign(new Error('本条审阅已在其他页面更新，请刷新后重新核对'), { status: 409 });
  return { caseId: body.caseId, text: body.text, note: body.note, state: body.state, revision: body.revision + 1, updatedAt: new Date().toISOString() };
}
export async function startServer(root = outputRoot, port = 3197, options = {}) {
  const publicRoot = resolve(root, 'public');
  const manifest = await jsonFile(resolve(root, 'manifest.json'));
  const caseIds = new Set(manifest.cases.map(c => c.caseId));
  const lockPath = resolve(root, '.a-review-server.lock');
  try { const previous = JSON.parse(readFileSync(lockPath, 'utf8')); let alive = true; try { process.kill(previous.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw fail('本目录的审阅服务已在运行，请使用现有服务', 409); unlinkSync(lockPath);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, JSON.stringify({ pid: process.pid })); closeSync(lock);
  try { await recoverAnalyses(root, manifest); } catch(e) { unlinkSync(lockPath); throw e; }
  let writeQueue = Promise.resolve();
  const enqueue = fn => { const result = writeQueue.then(fn); writeQueue = result.catch(() => {}); return result; };
  const running = new Set();
  const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    const allowedHosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
    if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: '仅限本机访问' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (options.extraRoutes && await options.extraRoutes({ req, res, url, root, manifest, enqueue, json, readBody })) return;
      if (url.pathname === '/' && req.method === 'GET' && options.indexFile) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(await readFile(options.indexFile));
      }
      if (url.pathname === '/api/a-state' && req.method === 'GET') {
        const states = {}; for (const id of caseIds) states[id] = await readAState(root, id);
        return json(res, 200, states);
      }
      if (url.pathname === '/api/b-input' && req.method === 'GET') return json(res, 200, await readBInput(root, manifest, url.searchParams.get('caseId'), url.searchParams.get('confirmationId')));
      if (['/api/reanalyze', '/api/adopt-analysis', '/api/confirm'].includes(url.pathname) && req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host}` || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: '请求来源不匹配' });
        const body = await readBody(req, 180000);
        if (url.pathname === '/api/confirm') return json(res, 200, await enqueue(() => confirmRequirement(root, manifest, body)));
        if (url.pathname === '/api/adopt-analysis') return json(res, 200, await enqueue(() => acceptAnalysis(root, manifest, body)));
        const reserved = await enqueue(() => reserveAnalysis(root, manifest, body, options.analyzerFactory));
        if (reserved.execute) {
          const job = reserved.execute().then(result => enqueue(() => finishAnalysis(root, body.caseId, reserved.analysis.id, result)),
            error => enqueue(() => finishAnalysis(root, body.caseId, reserved.analysis.id, null, error)));
          running.add(job); job.catch(() => {}).finally(() => running.delete(job));
        }
        return json(res, 202, reserved.analysis);
      }
      if (url.pathname === '/api/reviews' && req.method === 'GET') return json(res, 200, await jsonFile(resolve(root, 'reviews.json'), {}));
      if (url.pathname === '/api/supplements' && req.method === 'GET') return json(res, 200, await jsonFile(resolve(root, 'supplements.json'), {}));
      if (url.pathname === '/api/supplements' && req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host}` || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: '请求来源不匹配' });
        const body = await readBody(req, 22 * 1024 * 1024);
        const action = writeQueue.then(() => saveSupplement(root, body, caseIds));
        writeQueue = action.catch(() => {});
        return json(res, 200, await action);
      }
      if (url.pathname === '/api/reviews' && req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host}` || !req.headers['content-type']?.startsWith('application/json')) return json(res, 403, { error: '请求来源不匹配' });
        const body = await readBody(req, 150000);
        const action = writeQueue.then(async () => {
          const supplements = await jsonFile(resolve(root, 'supplements.json'), {});
          if (body?.state === 'checked' && !body.analysisId && !await canConfirm(root, body.caseId, supplements[body.caseId]?.revision || 0)) throw fail('补充素材尚未纳入模型结果，请先保留为待核对', 409);
          if (body.supplementRevision !== undefined && body.supplementRevision !== (supplements[body.caseId]?.revision || 0)) throw fail('素材已更新，请刷新后再保存', 409);
          const reviews = await jsonFile(resolve(root, 'reviews.json'), {});
          const review = validateReview(body, caseIds, reviews[body.caseId]);
          if (body.analysisId) { const state = await readAState(root, body.caseId); const analysis = state.analyses.find(a => a.id === body.analysisId); const previous = reviews[body.caseId]; if (analysis?.status !== 'returned' || (previous?.analysisId !== body.analysisId && (analysis.supplementRevision !== (supplements[body.caseId]?.revision || 0) || analysis.reviewRevision !== (previous?.revision || 0))) || (body.state === 'checked' && analysis.supplementRevision !== (supplements[body.caseId]?.revision || 0))) throw fail('识别结果基于旧正文或素材，请重新识别', 409); review.analysisId = body.analysisId; }
          review.supplementRevision = supplements[body.caseId]?.revision || 0;
          reviews[body.caseId] = review;
          await saveJSON(resolve(root, 'reviews.json'), reviews);
          return review;
        });
        writeQueue = action.catch(() => {});
        return json(res, 200, await action);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '方法不支持' });
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const path = resolve(publicRoot, '.' + relative);
      if (!path.startsWith(publicRoot + sep) || !/\.(?:html|json|txt|png|jpe?g|webp)$/iu.test(path)) return json(res, 404, { error: '未找到' });
      const info = await stat(path); if (!info.isFile()) return json(res, 404, { error: '未找到' });
      const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
      res.writeHead(200, { 'Content-Type': types[extname(path).toLowerCase()], 'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': /\.(html|json|txt)$/u.test(path) ? 'no-store' : 'private, max-age=3600', 'Referrer-Policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : await readFile(path));
    } catch (error) { json(res, error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error.status ? error.message : '本地文件读取或保存失败' }); }
  });
  server.on('close', () => { unlinkSync(lockPath); });
  try { await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); }); } catch (e) { unlinkSync(lockPath); throw e; }
  server.waitForAnalyses = () => Promise.allSettled([...running]);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startServer(outputRoot, Number(process.env.A_REVIEW_PORT || 3197));
  console.log(`Review: http://127.0.0.1:${server.address().port}`);
}
