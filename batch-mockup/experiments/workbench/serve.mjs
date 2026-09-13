import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startServer } from '../standardize-36/serve.mjs';
import { hash, jsonFile } from '../../adapters/a-files.mjs';

export async function workbenchData(root, manifest) {
  const reviews = await jsonFile(resolve(root, 'reviews.json'), {});
  const supplements = await jsonFile(resolve(root, 'supplements.json'), {});
  const notes = await jsonFile(resolve(root, 'qa-notes.json'), {});
  const bIndex = await jsonFile(resolve(root, 'b-index.json'), {});
  const cases = [];
  for (const c of manifest.cases) {
    const result = await jsonFile(resolve(root, 'results', c.caseId + '.json'), { status: 'pending' });
    const state = await jsonFile(resolve(root, 'a-state', c.caseId + '.json'), { analyses: [], confirmations: [] });
    const review = reviews[c.caseId];
    const supplement = supplements[c.caseId] || { revision: 0, items: [] };
    const text = review?.text ?? result.parsed?.standardizedRequirement ?? '';
    const runId = (await jsonFile(resolve(root, 'b-index', c.caseId + '.json'), null))?.runId || bIndex[c.caseId];
    const b = runId ? await jsonFile(resolve(root, 'b-runs', runId, 'result.json'), null) : null;
    if (b) b.stale = b.aTextSHA256 !== hash(text) || b.supplementRevision !== supplement.revision || b.reviewRevision !== (review?.revision || 0);
    cases.push({ ...c, result, review: review || null, supplement, state, text, b, notes: notes[c.caseId] || [] });
  }
  const stage = await jsonFile(resolve(root, 'workbench-stage.json'), { planningReady: false });
  return { run: manifest.run, cases, planningReady: stage.planningReady === true, productionEnabled: false };
}

export async function startWorkbench(root, port = 3210, options = {}) {
  return startServer(root, port, { ...options, indexFile: fileURLToPath(new URL('./table.html', import.meta.url)),
    extraRoutes: async ({ req, res, url, manifest, json, readBody }) => {
      if (url.pathname === '/api/workbench' && req.method === 'GET') { json(res, 200, await workbenchData(root, manifest)); return true; }
      if (url.pathname === '/api/b-plan' && req.method === 'POST') {
        if (req.headers.origin !== `http://${req.headers.host}` || !req.headers['content-type']?.startsWith('application/json')) { json(res, 403, { error: '请求来源不匹配' }); return true; }
        const body = await readBody(req, 16000);
        if (!manifest.cases.some(c => c.caseId === body.caseId)) { json(res, 404, { error: '未找到这条需求' }); return true; }
        if (!(await jsonFile(resolve(root, 'workbench-stage.json'), {})).planningReady) { json(res, 409, { error: '本批先完成 A；B 尚在构建，暂未开放规划' }); return true; }
        const { planWorkbenchCase } = await import('../../application/b-v2.mjs');
        const result = await planWorkbenchCase(root, body.caseId, { expectedReviewRevision: body.reviewRevision, expectedSupplementRevision: body.supplementRevision, expectedTextSHA256: body.textSHA256 });
        json(res, 200, result); return true;
      }
      return false;
    } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2] || 'output/abcde-workbench-30-20260913');
  await readFile(resolve(root, 'manifest.json'));
  const server = await startWorkbench(root, Number(process.env.WORKBENCH_PORT || 3210));
  console.log(`ABCDE: http://127.0.0.1:${server.address().port}/`);
}
