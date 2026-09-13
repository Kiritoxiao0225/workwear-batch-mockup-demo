import { resolve } from 'node:path';
import { planWorkbenchCase } from '../../application/b-v2.mjs';
import { jsonFile } from '../../adapters/a-files.mjs';
const [rootArg, ...ids] = process.argv.slice(2);
if (!rootArg || !ids.length) throw new Error('必须指定本批目录和确实需要修正的案例');
const root = resolve(rootArg);
const feedback = await jsonFile(resolve(root, 'b-review-feedback.json'), {});
const queue = [...new Set(ids)];
await Promise.all(Array.from({ length: 2 }, async () => {
  while (queue.length) {
    const caseId = queue.shift(), index = await jsonFile(resolve(root, 'b-index', caseId + '.json'));
    const prior = await jsonFile(resolve(root, 'b-runs', index.runId, 'result.json'));
    if (!(prior.status === 'invalid_output' || prior.status === 'planned' && feedback[caseId]) || (prior.repairDepth ?? (prior.repairOf ? 1 : 0)) >= 2) { console.log(caseId + ': not eligible; no request'); continue; }
    console.log(caseId + ' correcting known validation errors');
    const r = await planWorkbenchCase(root, caseId, { repairOf: index.runId, ...(feedback[caseId] ? { reviewEvidence: feedback[caseId] } : {}) });
    console.log(JSON.stringify({ caseId, status: r.status, durationMs: r.durationMs, errors: r.validation?.errors, repairOf: r.repairOf }));
  }
}));
