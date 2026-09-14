import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { service, executeTask, workbenchData } from '../../runtime/service.mjs';
import { startServer } from '../standardize-36/serve.mjs';
import { jsonFile, saveJSON } from '../../adapters/a-files.mjs';
import { readRequirementState, reserveRequirementAnalysis, finishRequirementAnalysis,
  saveRequirementDraft, confirmRequirementDraft, readArtworkInput } from '../../application/requirements.mjs';

import { readProductionJobs, reserveProduction, createProductionWorker } from '../../application/production.mjs';
import { configuredProduction } from '../../adapters/production-images.mjs';
import { readRepairInput, saveProductionRepair } from '../../application/production-repair.mjs';

export async function startRequirements(root, port = 3214, options = {}) {
  const manifest = await jsonFile(resolve(root, 'manifest.json'));
  const jobs = new Set();
  const pendingTasks=[];let taskPump=false;
  async function pumpTasks(){if(taskPump)return;taskPump=true;try{while(pendingTasks.length){const task=pendingTasks.shift();try{await server.enqueue(()=>executeTask(root,task));}catch(e){console.error('[local-batch]',e.message);}}}finally{taskPump=false;}}
  const productionEnabled = options.productionEnabled ?? process.env.REQUIREMENTS_PRODUCTION_ENABLED === '1';
  let productionWorker;
  const server = await startServer(root, port, { indexFile: fileURLToPath(new URL('./requirements.html', import.meta.url)),
    extraRoutes: async ({ req, res, url, enqueue, json, readBody }) => {
      const editorFiles = { '/compact-layout.css': './compact-layout.css', '/mockup-save.mjs': './mockup-save.mjs', '/requirements-editor.mjs': './requirements-editor.mjs', '/repair-editor.mjs': './repair-editor.mjs', '/repair-editor.css': './repair-editor.css', '/repair-pixels.mjs': '../../application/repair-pixels.mjs', '/mockup-editor.mjs': './mockup-editor.mjs', '/mockup-editor.css': './mockup-editor.css' };
      if (editorFiles[url.pathname] && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(await readFile(fileURLToPath(new URL(editorFiles[url.pathname], import.meta.url)))); return true;
      }
      if (url.pathname === '/api/garments' || url.pathname.startsWith('/api/mockups') || url.pathname === '/api/wps/sync') {
        if(req.method==='POST' && req.headers.origin !== `http://${req.headers.host}`){json(res,403,{error:'请求来源不匹配'});return true;}
        const body=req.method==='POST'?await readBody(req,100000):Object.fromEntries(url.searchParams);
        const value=await enqueue(()=>service(root,url.pathname,req.method,body,{enqueue:async task=>{pendingTasks.push(task);}}));
        json(res,200,value);void pumpTasks();return true;
      }
      if (url.pathname === '/api/production/repair' && req.method === 'GET') {
        json(res, 200, await readRepairInput(root, url.searchParams.get('jobId'))); return true;
      }
      if (url.pathname === '/api/production/repair' && req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host}` || !req.headers['content-type']?.startsWith('application/json')) { json(res, 403, { error: '请求来源不匹配' }); return true; }
        const body = await readBody(req, 2 * 1024 * 1024);
        const saved=await enqueue(()=>saveProductionRepair(root,body));const j=(await readProductionJobs(root)).find(j=>j.id===body.jobId);pendingTasks.push({kind:'mockup',payload:{caseId:j.caseId}});void pumpTasks();json(res,200,saved);return true;
      }
      if (url.pathname === '/api/requirements' && req.method === 'GET') {
        const data = await workbenchData(root);json(res,200,{...data,generationEnabled:productionEnabled}); return true;
      }
      if (url.pathname === '/api/production' && req.method === 'POST') {
        if (!productionEnabled || req.headers.origin !== `http://${req.headers.host}` || !req.headers['content-type']?.startsWith('application/json')) { json(res, 403, { error: '本地制作未启用或请求来源不匹配' }); return true; }
        const body = await readBody(req, 50000);
        const reserved = await enqueue(() => reserveProduction(root, manifest, body.requests));
        void productionWorker.pump(); json(res, 202, { jobs: reserved }); return true;
      }
      if (url.pathname === '/api/artwork-input' && req.method === 'GET') {
        json(res, 200, await readArtworkInput(root, manifest, url.searchParams.get('caseId'), url.searchParams.get('confirmationId'), url.searchParams.get('artworkId'))); return true;
      }
      if (url.pathname === '/api/prompt' && req.method === 'GET') { json(res, 200, { text: await readFile(resolve(root, 'prompt.txt'), 'utf8'), sha256: manifest.run.promptSHA256 }); return true; }
      if (['/api/requirements/analyze', '/api/requirements/save', '/api/requirements/confirm'].includes(url.pathname) && req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host}` || !req.headers['content-type']?.startsWith('application/json')) { json(res, 403, { error: '请求来源不匹配' }); return true; }
        const body = await readBody(req, 900000);
        if (url.pathname.endsWith('/save')) { const state = await enqueue(() => saveRequirementDraft(root, manifest, body)); json(res, 200, { revision: state.revision }); return true; }
        if (url.pathname.endsWith('/confirm')) { json(res, 200, await enqueue(() => confirmRequirementDraft(root, manifest, body))); return true; }
        const reserved = await enqueue(() => reserveRequirementAnalysis(root, manifest, body, options.analyzerFactory));
        if (reserved.execute) {
          const job = reserved.execute().then(result => enqueue(() => finishRequirementAnalysis(root, manifest, body.caseId, reserved.analysis.id, result)),
            error => enqueue(() => finishRequirementAnalysis(root, manifest, body.caseId, reserved.analysis.id, null, error)));
          jobs.add(job); job.catch(() => {}).finally(() => jobs.delete(job));
        }
        json(res, 202, { id: reserved.analysis.id, status: reserved.analysis.status }); return true;
      }
      // Only the existing, verified supplementary-upload endpoint is shared with the old experiment.
      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/supplements') { json(res, 404, { error: '本页尚未接通该操作' }); return true; }
      return false;
    } });
  // The root lock has been acquired. Interrupted requests are not silently submitted again.
  for (const c of manifest.cases) {
    const s = await readRequirementState(root, c.caseId); let changed = false;
    for (const a of s.analyses) if (a.status === 'running') { a.status = 'unknown'; a.error = '服务中断，原请求结果未知；没有自动重发'; changed = true; }
    if (changed) await saveJSON(resolve(root, 'requirements-state', `${c.caseId}.json`), s);
  }
  if (productionEnabled) { productionWorker = await createProductionWorker(root, options.productionFactory || configuredProduction, {onProgress:job=>{if(job.status==='returned'){pendingTasks.push({kind:'mockup',payload:{caseId:job.caseId}});void pumpTasks();}}}); void productionWorker.pump(); server.on('close', () => productionWorker.close()); }
  server.waitForRequirementAnalyses = () => Promise.allSettled([...jobs]);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startRequirements(resolve(process.argv[2] || 'output/requirements-v3-30-20260914'), Number(process.env.REQUIREMENTS_PORT || 3214));
  console.log(`Requirements: http://127.0.0.1:${server.address().port}`);
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}
