import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hash, jsonFile, saveJSON } from '../../adapters/a-files.mjs';
import { readPlanV2Handoff } from '../../application/b-v2.mjs';
import { validatePlanV2 } from '../../application/b-validation-v2.mjs';

const root = resolve(process.argv[2]), origin = process.argv[3] || 'http://127.0.0.1:3210';
if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) throw Error('仅验证本机审阅服务');
const manifest = await jsonFile(resolve(root, 'manifest.json'));
const aSummary = await jsonFile(resolve(root, 'run-summary.json'));
const prompt = await readFile(resolve(root, 'prompt.txt'), 'utf8');
const live = await (await fetch(origin + '/api/workbench')).json();
assert.equal(live.productionEnabled, false); assert.equal(live.cases.length, manifest.cases.length);
assert.equal(hash(prompt), manifest.run.promptSHA256);
let aImages = 0, bImages = 0;
const rows = [], runs = [];
for (const c of manifest.cases) {
  assert.equal(hash(c.sourceText), c.sourceTextSHA256);
  assert.match(c.wpsStatus, /待领取|未领取/u);
  const a = await jsonFile(resolve(root, 'results', c.caseId + '.json'));
  const response = await jsonFile(resolve(root, 'responses', c.caseId + '.json'));
  assert.equal(a.status, 'returned'); assert.equal(a.httpStatus, 200);
  assert.deepEqual(a.parsed, JSON.parse(response.choices[0].message.content));
  const content = [{ type: 'text', text: JSON.stringify({ 原始需求: c.sourceText, 图片数量: c.images.length }) }];
  for (const i of c.images) {
    const image = await readFile(resolve(root, i.inputFile));
    assert.equal(hash(image), i.inputSHA256);
    const original = await readFile(resolve(root, 'public', i.asset));
    assert.equal(hash(original), i.originalSHA256); assert.equal(original.length, i.originalBytes);
    const served = Buffer.from(await (await fetch(origin + '/' + i.asset)).arrayBuffer());
    assert.deepEqual(served, original);
    content.push({ type: 'text', text: `图${i.index}（${i.width}×${i.height}，${i.hasAlpha ? '文件含透明通道' : '文件不含透明通道'}）：` }, { type: 'image_url', image_url: { url: `data:${i.mime};base64,${image.toString('base64')}`, detail: 'high' } });
    aImages++;
  }
  const request = { model: a.model, reasoning_effort: a.effort, max_completion_tokens: 16000, response_format: { type: 'json_object' }, stream: false, messages: [{ role: 'system', content: prompt }, { role: 'user', content }] };
  assert.equal(hash(JSON.stringify(request)), a.requestSHA256);
  const served = live.cases.find(x => x.caseId === c.caseId);
  assert.equal(served.sourceText, c.sourceText); assert.equal(served.text, served.review?.text ?? a.parsed.standardizedRequirement);
  const index = await jsonFile(resolve(root, 'b-index', c.caseId + '.json'));
  const b = await jsonFile(resolve(root, 'b-runs', index.runId, 'result.json'));
  assert.ok(['planned', 'blocked', 'invalid_output', 'unknown'].includes(b.status), `${c.caseId}仍未完成B`);
  assert.equal(b.runId, served.b.runId); assert.equal(b.canExecuteC, false); assert.equal(b.actualImageProduction, false);
  assert.equal(b.aTextSHA256, hash(served.text));
  if (['planned', 'blocked'].includes(b.status)) {
    const currentValidation = await validatePlanV2(b.plan, await jsonFile(resolve(root, 'b-runs', index.runId, 'input.json')));
    assert.equal(currentValidation.valid, true, c.caseId + ': ' + currentValidation.errors.join('; '));
  }
  rows.push({ caseId: c.caseId, status: b.status, runId: b.runId, repaired: !!b.repairOf, durationMs: b.durationMs, inputAuthority: b.inputAuthority, errors: b.validation?.errors || [], routes: b.plan?.artworks?.map(x => ({ name: x.name, route: x.route, blocked: !!x.blockedReason, steps: x.steps.map(s => s.capabilityId) })) || [] });
}
for (const entry of await readdir(resolve(root, 'b-runs'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = resolve(root, 'b-runs', entry.name), r = await jsonFile(resolve(dir, 'result.json'));
  const request = await jsonFile(resolve(dir, 'request.json')), input = await jsonFile(resolve(dir, 'input.json'));
  assert.equal(hash(JSON.stringify(request)), r.requestSHA256); assert.equal(r.requestSHA256, entry.name);
  assert.equal(hash(JSON.stringify(input)), r.inputSHA256); assert.equal(hash(request.messages[0].content), r.promptSHA256);
  assert.equal(input.requirement.textSHA256, hash(input.requirement.text));
  assert.deepEqual(JSON.parse(request.messages[1].content[0].text).input, input);
  assert.equal(input.cExecutionEnabled, false); assert.equal(r.actualImageProduction, false);
  assert.ok(Date.parse(r.startedAt) >= Date.parse(aSummary.completedAt), 'B不能先于整批A完成');
  const images = request.messages[1].content.filter(x => x.type === 'image_url');
  assert.equal(images.length, input.requirement.images.length);
  images.forEach((image, n) => { assert.equal(hash(Buffer.from(image.image_url.url.split(',')[1], 'base64')), input.requirement.images[n].sha256); bImages++; });
  if (r.plan) { const h = await readPlanV2Handoff(dir); assert.equal(h.generationRequirement, input.requirement.text); }
  assert.equal(r.httpStatus, 200);
  runs.push({ caseId: r.caseId, runId: r.runId, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.durationMs, repairOf: r.repairOf || null, promptSHA256: r.promptSHA256, requestedModel: r.model, reportedModel: r.reportedModel, effort: r.effort, usage: r.usage });
}
for (const path of ['/requests/D02.json', '/b-runs/secret/request.json', '/manifest.json', '/.env', '/api/c-run']) assert.equal((await fetch(origin + path)).status, 404, path);
const counts = rows.reduce((o, r) => ({ ...o, [r.status]: (o[r.status] || 0) + 1 }), {});
const evidence = { verifiedAt: new Date().toISOString(), origin, baseline: manifest.run.baseline, sourceReadAt: manifest.run.sourceReadAt,
  sourceRecords: manifest.run.totalSourceRecords, eligibleRecords: manifest.run.eligibleCount, selected: manifest.cases.length,
  a: { calls: aSummary.submitted, returned: aSummary.returned, imageCount: aImages, originalBytesAndHTTP: true, requestSHA256Rebuilt: true, rawOutputPreserved: true, promptSHA256: manifest.run.promptSHA256 },
  b: { calls: runs.length, current: counts, imagePayloadsChecked: bImages, completeAAndImagesUnchanged: true, allRequestsAfterAComplete: true, rows, runs },
  api: { endpoint: manifest.run.apiEndpoint, model: manifest.run.model, effort: manifest.run.effort },
  currentConfirmations: live.cases.filter(c => c.state.confirmations.length).length,
  boundaries: { productionEnabled: false, imageProductionCalls: 0, callsToWPSWrite: 0, privateFilesNotServed: true, semanticAccuracyGuaranteed: false, deployed: false } };
await saveJSON(resolve(root, 'evidence', 'verification.json'), evidence);
console.log(JSON.stringify({ selected: evidence.selected, aCalls: evidence.a.calls, images: aImages, bCalls: runs.length, bCurrent: counts, confirmations: evidence.currentConfirmations }));
