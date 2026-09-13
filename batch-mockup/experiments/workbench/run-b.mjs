import { resolve } from 'node:path';
import { planWorkbenchCase, readPlanV2Handoff } from '../../application/b-v2.mjs';
import { jsonFile, saveJSON } from '../../adapters/a-files.mjs';
const root = resolve(process.argv[2] || 'output/abcde-workbench-30-20260913');
const manifest = await jsonFile(resolve(root, 'manifest.json'));
const a = await jsonFile(resolve(root, 'run-summary.json'), null);
if (!a?.completedAt || a.returned !== manifest.cases.length) throw new Error('先完成本批所有A调用，再运行B');
const selected = process.argv.slice(3);
const cases = manifest.cases.filter(c => !selected.length || selected.includes(c.caseId));
if (selected.length && cases.length !== new Set(selected).size) throw new Error('案例ID不完整');
let stopped = false;
const one = async c => {
  console.log(c.caseId + ' B start');
  const result = await planWorkbenchCase(root, c.caseId);
  if (result.status === 'unknown' && /HTTP (401|403|429)/u.test(result.error || '')) stopped = true;
  if (['planned', 'blocked', 'invalid_output'].includes(result.status)) {
    const handoff = await readPlanV2Handoff(resolve(root, 'b-runs', result.runId));
    if (handoff.generationRequirement !== handoff.input.requirement.text || handoff.canExecute) throw new Error('B交接违反原样正文或C边界');
  }
  console.log(JSON.stringify({ caseId: c.caseId, status: result.status, durationMs: result.durationMs, artworks: result.plan?.artworks?.length, errors: result.validation?.errors, routes: result.plan?.artworks?.map(a => a.route) }));
  return result;
};
const first = cases.find(c => c.caseId === 'D02') || cases[0];
if (first) { const r = await one(first); if (r.status === 'invalid_output') stopped = true; }
const queue = cases.filter(c => c !== first);
await Promise.all(Array.from({ length: 2 }, async () => { while (queue.length && !stopped) await one(queue.shift()); }));
const rows = [];
for (const c of manifest.cases) {
  const index = await jsonFile(resolve(root, 'b-index', c.caseId + '.json'), null);
  const r = index ? await jsonFile(resolve(root, 'b-runs', index.runId, 'result.json'), null) : null;
  rows.push({ caseId: c.caseId, status: r?.status || 'pending', runId: r?.runId, durationMs: r?.durationMs, inputAuthority: r?.inputAuthority });
}
await saveJSON(resolve(root, 'b-run-summary.json'), { completedAt: new Date().toISOString(), aCompletedAt: a.completedAt, total: manifest.cases.length, rows, stopped, imageProductionCalls: 0 });
console.log(JSON.stringify({ counts: rows.reduce((s, r) => { s[r.status] = (s[r.status] || 0) + 1; return s; }, {}), stopped }));
