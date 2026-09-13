// Explicit local experiment. Never writes the source review workspace or WPS.
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assetPath, hash, jsonFile, saveJSON } from '../../adapters/a-files.mjs';
import { confirmRequirement, readBInput } from '../../application/a-review.mjs';
import { planConfirmedRequirement, readCInput } from '../../application/b-planning.mjs';

const [source, destination, ...selected] = process.argv.slice(2);
if (!source || !destination || !selected.length) throw new Error('用法：tsx .../run.mjs A来源目录 独立输出目录 案例ID...（每个新输入实际调用一次API）');
if (resolve(source) === resolve(destination)) throw new Error('测试必须用独立目录');
const original = await jsonFile(resolve(source, 'manifest.json'));
const aRoot = resolve(destination, 'a-test'), manifest = { ...original, run: { ...original.run, id: 'b-planning-isolated-test' }, cases: original.cases.filter(c => selected.includes(c.caseId)) };
if (manifest.cases.length !== new Set(selected).size) throw new Error('案例ID缺失或重复');
await saveJSON(resolve(aRoot, 'manifest.json'), manifest);
const summaries = await jsonFile(resolve(destination, 'summary.json'), []);
for (const c of manifest.cases) {
  const sourceResult = await jsonFile(resolve(source, 'results', c.caseId + '.json'));
  for (const img of c.images) {
    const target = assetPath(aRoot, img.asset); await mkdir(dirname(target), { recursive: true });
    await copyFile(assetPath(source, img.asset), target);
  }
  await saveJSON(resolve(aRoot, 'results', c.caseId + '.json'), sourceResult);
  const state = await jsonFile(resolve(aRoot, 'a-state', c.caseId + '.json'), { confirmations: [] });
  let confirmationId = state.confirmations[0]?.confirmationId;
  if (!confirmationId) {
    // Only a test identity. These are NOT designer-confirmed customer orders.
    const text = sourceResult.parsed.standardizedRequirement;
    const reviews = await jsonFile(resolve(aRoot, 'reviews.json'), {});
    reviews[c.caseId] = { text, revision: 1, supplementRevision: 0 };
    await saveJSON(resolve(aRoot, 'reviews.json'), reviews);
    confirmationId = randomUUID();
    await confirmRequirement(aRoot, manifest, { caseId: c.caseId, requestId: confirmationId, text,
      reviewRevision: 1, supplementRevision: 0, confirmedBy: 'Codex隔离规划测试；不代表客户人工确认' });
  }
  const receipt = await readBInput(aRoot, manifest, c.caseId, confirmationId);
  const result = await planConfirmedRequirement({ receipt, readAsset: asset => readFile(assetPath(aRoot, asset)),
    output: { width: 2048, height: 2048, background: 'preserve', sizing: 'native', basis: '单图可保留原生尺寸；2048画布仅在需要排字/组合时使用，不强制放大；图稿物理尺寸保留A正文' }, root: resolve(destination, 'runs') });
  let handoffVerified = false;
  if (['planned', 'blocked'].includes(result.status)) {
    const received = await readCInput(resolve(destination, 'runs', result.runId), receipt);
    if (received.input.confirmation.text !== receipt.input.text || received.input.confirmation.textSHA256 !== hash(receipt.input.text)) throw new Error('正文不一致');
    handoffVerified = true;
  }
  const row = { caseId: c.caseId, ...result, handoffVerified, confirmationId, inputAuthority: 'isolated_test_not_customer_confirmation' };
  const existing = summaries.findIndex(s => s.runId === row.runId);
  if (existing < 0) summaries.push(row); else summaries[existing] = row;
  await saveJSON(resolve(destination, 'summary.json'), summaries);
  console.log(JSON.stringify({ caseId: c.caseId, status: result.status, durationMs: result.durationMs, errors: result.validation?.errors, handoffVerified }));
}
