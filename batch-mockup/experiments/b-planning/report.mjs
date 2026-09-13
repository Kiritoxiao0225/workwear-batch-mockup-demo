import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { jsonFile, assetPath, saveJSON, hash } from '../../adapters/a-files.mjs';
import { validateBPlan } from '../../application/b-validation.mjs';
const root = resolve(process.argv[2]);
await mkdir(resolve(root, 'public/assets'), { recursive: true });
const escape = text => String(text ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const names = { reuse: '复用原图', 'render-text': '本地排字', 'compose-white': '旧白底合成', compose: '按需组合', 'enhance-mediakit': '保真增强候选', 'generate-cliproxy': '参考/文字生成候选', 'cutout-meitu': '美图抠图候选', 'cutout-mediakit': 'MediaKit抠图候选' };
const histories = new Map();
const batches = await jsonFile(resolve(root, 'report-batches.json'), ['', 'followup', 'followup-pixels']);
for (const batch of batches) {
  for (const row of await jsonFile(resolve(root, batch, 'summary.json'), [])) {
    const run = resolve(root, batch, 'runs', row.runId);
    const input = await jsonFile(resolve(run, 'input.json')), plan = await jsonFile(resolve(run, 'plan.json'), null);
    const audit = plan ? await validateBPlan(plan, input) : null;
    await saveJSON(resolve(run, 'current-check.json'), audit);
    if (!histories.has(row.caseId)) histories.set(row.caseId, []);
    histories.get(row.caseId).push({ row, run, input, plan, audit, aRoot: resolve(root, batch, 'a-test') });
  }
}
const notes = await jsonFile(resolve(root, 'review-notes.json'), {});
const reviewStatus = await jsonFile(resolve(root, 'review-status.json'), {});
let cards = '', callCount = 0;
for (const [id, history] of histories) {
  const { row, input, plan, audit } = history.at(-1); callCount += history.length;
  let pictures = '';
  // Every image is the exact source file; display on white so dark artwork remains visible.
  for (const image of input.confirmation.images) {
    const bytes = await readFile(assetPath(history.at(-1).aRoot, image.asset));
    const facts = input.images.find(i => i.id === image.id);
    if (hash(bytes) !== image.sha256) throw new Error('展示素材与A确认图片不一致');
    const asset = `assets/${image.sha256}.${facts.format}`;
    await writeFile(resolve(root, 'public', asset), bytes);
    pictures += `<figure><a href="${asset}" target="_blank"><img alt="${escape(id + ' ' + image.label)}" src="${asset}" /></a><figcaption>${escape(image.label)} · ${facts.width}×${facts.height} · ${facts.hasTransparentPixels ? '存在真实透明像素' : '无透明像素'}</figcaption></figure>`;
  }
  const steps = plan?.steps.map(s => `<li><b>${escape(names[s.capabilityId] || s.capabilityId)}${s.capabilityId === 'compose' ? (s.params.background === 'transparent' ? ' · 透明画布' : ' · 白底导出') : ''}</b><p>${escape(s.reason)}</p><small>输入：${escape(s.inputs.map(i => i.id + '（' + i.role + '）').join('、') || '无素材输入')}</small></li>`).join('') || '';
  cards += `<article id="${escape(id)}"><h2>${escape(id)} <span>${row.status === 'blocked' ? '明确阻塞 · 未制作' : audit?.valid ? '结构通过 · 未制作' : '计划被拦截 · 未制作'}</span></h2><div class="grid"><section><h3>原文与原图</h3><pre>${escape(input.confirmation.sourceText)}</pre>${pictures}</section><section><h3>A正文（原样传入）</h3><pre>${escape(input.confirmation.text)}</pre><h3>独立初审 · 非模型原文</h3><p><b>${escape(reviewStatus[id] || '待初审')}</b></p><div class="notice">${escape(notes[id] || '待独立审阅')}</div><p class="muted">隔离测试确认，不是客户订单人工定稿。</p></section><section><h3>B实际返回的路线</h3><ol>${steps}</ol>${(plan?.artworks || []).filter(a => a.blockedReason).map(a => `<div class="notice">${escape(a.blockedReason)}</div>`).join('')}<details><summary>校验结果及待验事项</summary><pre>${escape(JSON.stringify(audit, null, 2))}</pre></details><details><summary>完整模型计划 JSON</summary><pre>${escape(JSON.stringify(plan, null, 2))}</pre></details><details><summary>调用历史 · ${history.length} 次</summary>${history.map(h => `<p>${escape(h.row.status)} · ${(h.row.durationMs / 1000).toFixed(1)} 秒 · HTTP ${h.row.httpStatus || '未知'}<br/><small>请求SHA：${escape(h.row.requestSHA256)}<br/>响应SHA：${escape(h.row.responseSHA256)}</small></p>`).join('')}</details></section></div></article>`;
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>B 制作规划 · 真实API试验</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f6f4;color:#203b31;font-family:system-ui,-apple-system,sans-serif;line-height:1.65}header{padding:32px 4vw;background:#184c3d;color:white}h1{margin:0;font-size:29px}header p{max-width:1000px}nav{display:flex;gap:12px;flex-wrap:wrap}nav a{color:white;border:1px solid #b3cec1;border-radius:6px;padding:5px 18px}main{padding:24px 3vw}article{background:white;border:1px solid #ceddd5;border-radius:10px;margin:0 0 28px;overflow:hidden;scroll-margin-top:15px}h2{margin:0;padding:16px 22px;background:#e7efea;font-size:23px}h2 span{font-size:14px;font-weight:500;margin-left:18px}.grid{display:grid;grid-template-columns:1fr 1fr 1.2fr}section{padding:22px;min-width:0;border-right:1px solid #e0e8e3}h3{margin:0 0 12px;font-size:18px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:14px}figure{margin:18px 0}img{display:block;max-width:100%;max-height:380px;margin:auto;background-color:#e8e8e8;background-image:conic-gradient(#fff 25%,transparent 0 50%,#fff 0 75%,transparent 0);background-size:20px 20px;object-fit:contain}figcaption,small,.muted{font-size:12px;color:#61786c;overflow-wrap:anywhere}ol{padding-left:22px}li{margin:0 0 20px}li p{margin:6px 0;font-size:14px}.notice{border-left:4px solid #bd895b;background:#fcf5eb;padding:14px;white-space:pre-wrap}details{margin-top:18px;border-top:1px solid #ddd;padding-top:10px}summary{cursor:pointer;font-weight:600}@media(max-width:1000px){.grid{grid-template-columns:1fr}section{border-bottom:1px solid #e0e8e3}}@media print{details{display:none}article{break-before:page}nav{display:none}.grid{grid-template-columns:1fr 1fr 1.2fr}}
</style><header><h1>B 制作规划 · 真实API试验</h1><p>${histories.size} 条真实需求，${callCount} 次实际规划调用。API：CLIProxy / gpt-5.6-sol / low。本版默认保留原图透明性，单图可直接输出；2048×2048仅供按需排字/组合，不强制放大或加白底。页面底色只是预览，不改动素材文件。此页展示A输入、B计划和独立检查；没有实际生图、增强或抠图，所有C能力尚未准入。</p><nav>${[...histories.keys()].map(id => `<a href="#${escape(id)}">${escape(id)}</a>`).join('')}</nav></header><main>${cards}</main></html>`;
await mkdir(resolve(root, 'public'), { recursive: true }); await writeFile(resolve(root, 'public/index.html'), html);
console.log(JSON.stringify({ cases: histories.size, calls: callCount, bytes: Buffer.byteLength(html), path: resolve(root, 'public/index.html') }));
