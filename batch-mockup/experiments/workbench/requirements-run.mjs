import { mkdir, readFile, cp } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hash, jsonFile, saveJSON, atomicFile, assetPath } from '../../adapters/a-files.mjs';

const [mode, arg, target] = process.argv.slice(2);
if (mode === 'prepare') {
  const source = resolve(arg), root = resolve(target), manifest = await jsonFile(resolve(source, 'manifest.json'));
  if (await jsonFile(resolve(root, 'manifest.json'), null)) throw new Error('目标批次已存在，不能覆盖');
  const reviews = await jsonFile(resolve(source, 'reviews.json'), {});
  if (Object.keys(reviews).length) throw new Error('源批次已有人工修改，须明确迁移人工稿后再准备，不自动丢弃');
  await mkdir(resolve(root, 'public'), { recursive: true });
  const prompt = await readFile(fileURLToPath(new URL('../../application/requirements-prompt.txt', import.meta.url)), 'utf8');
  const supplements = await jsonFile(resolve(source, 'supplements.json'), {});
  for (const c of manifest.cases) {
    if (hash(c.sourceText) !== c.sourceTextSHA256) throw new Error('原文校验失败');
    for (const i of c.images) {
      const bytes = await readFile(assetPath(source, i.asset));
      if (hash(bytes) !== i.originalSHA256) throw new Error('原图校验失败');
      await atomicFile(assetPath(root, i.asset), bytes);
    }
    for (const i of supplements[c.caseId]?.items || []) await atomicFile(assetPath(root, i.asset), await readFile(assetPath(source, i.asset)));
  }
  const priorRun = manifest.run;
  manifest.run = { ...priorRun, id: basename(root), startedAt: new Date().toISOString(),
    label: '固定七项需求理解 · 30条真实素材复测', source: '沿用上轮WPS原文与完整原图快照，本轮未重新读取WPS状态',
    promptSHA256: hash(prompt), requirementFormat: 'artwork-fixed-seven-v3', previousRunId: priorRun.id,
    batchNote: '一次理解并选择生图/高清放大/直接复用；没有单独B规划。生图与风险评分尚未执行。' };
  await atomicFile(resolve(root, 'prompt.txt'), prompt);
  await saveJSON(resolve(root, 'manifest.json'), manifest); await saveJSON(resolve(root, 'supplements.json'), supplements);
  await saveJSON(resolve(root, 'previous-run.json'), priorRun);
  await cp(resolve(source, 'source-receipt.json'), resolve(root, 'source-receipt.json'));
  console.log(JSON.stringify({ root, cases: manifest.cases.length, images: manifest.run.imageCount, promptSHA256: hash(prompt) }));
} else if (mode === 'run') {
  const base = arg, ids = target ? new Set(target.split(',')) : null;
  let data = await (await fetch(base + '/api/requirements')).json();
  const todo = data.cases.filter(c => (!ids || ids.has(c.caseId)) && !c.analysis);
  let cursor = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (;;) {
      const c = todo[cursor++]; if (!c) return;
      const response = await fetch(base + '/api/requirements/analyze', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseId: c.caseId, revision: c.revision, supplementRevision: c.supplement.revision, requestId: randomUUID() }) });
      if (!response.ok) { console.log(c.caseId, 'submit_failed', response.status); continue; }
      let current;
      do {
        await new Promise(r => setTimeout(r, 3000));
        data = await (await fetch(base + '/api/requirements')).json(); current = data.cases.find(x => x.caseId === c.caseId);
      } while (current.analysis?.status === 'running');
      console.log(c.caseId, current.analysis?.status, current.analysis?.elapsedMs, current.draft?.artworks.length ?? 0);
    }
  }));
} else throw new Error('用法：prepare <旧批次目录> <新目录> 或 run <本地URL> [逗号分隔caseId]');
