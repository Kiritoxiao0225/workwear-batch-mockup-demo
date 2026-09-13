import { readFile } from 'node:fs/promises';
import { planV2Schema, cutoutIds, toolIds, backgroundSchema } from '../domain/b-plan-v2.mjs';
import { missingGlyphs } from '../adapters/font-coverage.ts';
import { fontPath } from './b-input.mjs';
import { hash } from '../adapters/a-files.mjs';

export async function validatePlanV2(value, input) {
  const parsed = planV2Schema.safeParse(value), errors = [], warnings = [];
  const bad = (id, s) => errors.push(id + '：' + s);
  if (!parsed.success) return { valid: false, executable: false, errors: parsed.error.issues.map(x => x.path.join('.') + ': ' + x.message), warnings, semanticStatus: 'needs_review', visualStatus: 'not_executed' };
  const plan = parsed.data, text = input.requirement.text, imageIds = new Set(input.requirement.images.map(i => i.id));
  const quote = (s, id) => { if (!s || !text.includes(s)) bad(id, '引用必须逐字来自A正文'); };
  const bounded = r => !r || r.x + r.width <= 1.00000001 && r.y + r.height <= 1.00000001;
  const assessments = new Set(), used = new Set(), excluded = new Set(), artIds = new Set();
  for (const a of plan.imageAssessments) { if (!imageIds.has(a.imageId) || assessments.has(a.imageId)) bad(a.imageId, '观察图片身份无效/重复'); assessments.add(a.imageId); if (!bounded(a.region)) bad(a.imageId, '选区越界'); }
  for (const id of imageIds) if (!assessments.has(id)) bad(id, '未观察原图');
  for (const e of plan.excludedImages) { if (!imageIds.has(e.imageId) || excluded.has(e.imageId)) bad(e.imageId, '排除身份无效/重复'); excluded.add(e.imageId); warnings.push('素材排除需核对：' + e.reason); }
  const font = await readFile(fontPath);
  for (const a of plan.artworks) {
    if (artIds.has(a.id)) bad(a.id, '图稿身份重复'); artIds.add(a.id);
    quote(a.requirementQuote, a.id); a.applications.forEach(x => quote(x, a.id));
    if (a.output.background === 'white') quote(a.output.whiteAuthorizationQuote, a.id + '.white');
    if (a.output.sizing === 'chosen' && (!a.output.width || !a.output.height)) bad(a.id, '自选画布必须指定宽高');
    if (a.output.width && a.output.height && a.output.width * a.output.height > 40_000_000) bad(a.id, '画布超过像素限制');
    const refs = new Set();
    for (const r of a.references) { if (!imageIds.has(r.imageId) || excluded.has(r.imageId)) bad(a.id, '引用未知或已排除图片'); refs.add(r.imageId + ':' + r.role); if (a.blockedReason) used.add(r.imageId); }
    if (a.blockedReason) { if (a.steps.length || a.output.stepId !== null || a.background.timing !== 'none' || a.background.action !== 'not_applicable' || a.background.capabilityId !== null || a.background.sourceStepId !== null) bad(a.id, '阻塞稿不得带可执行步骤或假输出'); continue; }
    if (!a.steps.length || !a.output.stepId) bad(a.id, '无步骤或输出，须明确阻塞');
    const steps = new Map(), actualRefs = new Set();
    for (const s of a.steps) {
      if (steps.has(s.id)) bad(s.id, '同图稿步骤重复');
      if (!toolIds.includes(s.capabilityId)) bad(s.id, '未登记能力');
      const keys = new Set();
      for (const r of s.inputs) {
        const key = r.kind + ':' + r.id + ':' + r.role;
        if (keys.has(key)) bad(s.id, '重复输入'); keys.add(key);
        if (r.kind === 'image') { if (!imageIds.has(r.id) || excluded.has(r.id) || !refs.has(r.id + ':' + r.role)) bad(s.id, '实际输入必须绑定已声明的图片用途'); actualRefs.add(r.id + ':' + r.role); used.add(r.id); }
        else if (!steps.has(r.id)) bad(s.id, '输入必须是同一图稿的前序步骤，不能循环或串图');
      }
      const p = s.params, tool = s.capabilityId;
      const allowed = tool === 'reuse' ? ['crop'] : tool === 'render-text' ? ['text', 'fontId', 'fontAuthorizationQuote', 'styleProposal', 'color', 'layout'] : tool === 'compose' ? ['background', 'backgroundAuthorizationQuote', 'placements'] : [];
      if (Object.keys(p).some(k => !allowed.includes(k))) bad(s.id, '禁止隐藏prompt或未登记的工具参数');
      if (['reuse', 'enhance-mediakit', ...cutoutIds].includes(tool) && (s.inputs.length !== 1 || s.inputs[0].role !== 'content')) bad(s.id, '该工具只接一个内容输入');
      if (p.crop && (!bounded(p.crop) || s.inputs[0]?.kind !== 'image')) bad(s.id, '裁切范围无效');
      if (tool === 'render-text') {
        if (!p.text || !p.fontId || !p.color || !p.layout) bad(s.id, '排字参数不完整');
        else {
          quote(p.text, s.id + '.text');
          const f = input.fonts.find(f => f.id === p.fontId);
          if (!f || f.sha256 !== hash(font)) bad(s.id, '实际字体不存在或版本变化');
          if (!p.styleProposal) { quote(p.fontAuthorizationQuote, s.id + '.font'); if (f && !p.fontAuthorizationQuote?.includes(f.name)) bad(s.id, '字体依据与实际字体不符'); }
          else if (!plan.reviewNotes.length) bad(s.id, '样式建议必须明确展示');
          if (missingGlyphs(font, p.text).length) bad(s.id, '实际字体缺字');
          if (p.layout.kind === 'arc' && (p.text.includes('\n') || !p.layout.degrees || !p.layout.direction)) bad(s.id, '弧形需单行、角度和方向');
        }
        if (s.inputs.some(r => r.kind !== 'image' || !['layout', 'color'].includes(r.role))) bad(s.id, '本地排字不能复刻字体参考或粘入内容图');
      }
      if (tool === 'compose') {
        if (!p.background || a.output.sizing !== 'chosen') bad(s.id, '组合需明确画布和背景');
        if (p.background === 'white') quote(p.backgroundAuthorizationQuote || a.output.whiteAuthorizationQuote, s.id + '.white');
        const ids = s.inputs.map(r => r.id), placed = (p.placements || []).map(r => r.inputId);
        if (s.inputs.some(r => r.role !== 'content') || new Set(ids).size !== ids.length || new Set(placed).size !== placed.length || ids.length !== placed.length || ids.some(id => !placed.includes(id))) bad(s.id, '组合须完整绑定内容图层');
        for (const r of p.placements || []) if (r.x + r.width > a.output.width || r.y + r.height > a.output.height) bad(s.id, '图层越过画布边界');
      }
      steps.set(s.id, s);
    }
    for (const r of refs) if (!actualRefs.has(r)) bad(a.id, '素材用途仅写说明，没有实际绑定：' + r);
    const generations = a.steps.filter(s => s.capabilityId === 'generate-cliproxy');
    if (a.route === 'model_generate') {
      if (generations.length !== 1 || a.steps.some(s => !['generate-cliproxy', 'reuse'].includes(s.capabilityId))) bad(a.id, '生成路线仅一次生成及必要参考裁切，不得先增强、抠图或追加组合');
      const g = generations[0];
      if (g && (a.output.stepId !== g.id || a.background.sourceStepId !== g.id)) bad(a.id, '必须等待当前生成步骤的实际结果');
      if (a.background.timing !== 'after_generation' || a.background.action !== 'await_image' || a.background.capabilityId !== null) bad(a.id, '生成后再决定抠图，不能提前写死模型');
    } else {
      if (generations.length || a.background.timing === 'after_generation') bad(a.id, '非生成路线不能藏生成或等待不存在的生成');
      if (a.route === 'preserve_asset' && a.steps.some(s => ['render-text', 'compose'].includes(s.capabilityId))) bad(a.id, '排字组合须明确local_render主路线');
      if (a.route === 'local_render' && !a.steps.some(s => ['render-text', 'compose'].includes(s.capabilityId))) bad(a.id, '本地路线未包含排字或组合');
      const cuts = a.steps.filter(s => cutoutIds.includes(s.capabilityId));
      if (a.background.timing === 'now') {
        const s = steps.get(a.background.sourceStepId);
        if (a.background.action !== 'cutout' || !s || !cutoutIds.includes(s.capabilityId) || s.capabilityId !== a.background.capabilityId) bad(a.id, '现在抠图必须绑定实际抠图步骤和一致配置');
      } else if (cuts.length || a.background.capabilityId || a.background.sourceStepId) bad(a.id, '背景决策与实际步骤不一致');
      if (a.background.action === 'reuse_alpha') {
        const content = a.steps.flatMap(s => s.inputs).filter(r => r.kind === 'image' && r.role === 'content');
        if (content.length && content.some(r => !input.images.find(i => i.id === r.id)?.hasTransparentPixels)) bad(a.id, '不透明原图不能声明复用透明底');
      }
    }
    if (!steps.has(a.output.stepId)) bad(a.id, '输出未指向自身步骤');
    const reached = new Set(); const visit = id => { if (reached.has(id)) return; const s = steps.get(id); if (!s) return; reached.add(id); s.inputs.filter(i => i.kind === 'step').forEach(i => visit(i.id)); }; visit(a.output.stepId);
    for (const id of steps.keys()) if (!reached.has(id)) bad(id, '孤立步骤不应执行或付费');
  }
  for (const id of imageIds) if (!used.has(id) && !excluded.has(id)) bad(id, '原图没有实际用途或排除说明');
  return { valid: !errors.length, executable: false, errors, warnings, semanticStatus: 'needs_review', visualStatus: 'not_executed', cStage: 'not_started' };
}

export function validateBackgroundDecision(value, facts) {
  const p = backgroundSchema.safeParse(value), errors = [];
  if (!p.success) return { valid: false, errors: p.error.issues.map(i => i.message), executable: false };
  if (value.action === 'cutout' && !value.capabilityId) errors.push('抠图必须选择登记配置');
  if (value.action !== 'cutout' && value.capabilityId !== null) errors.push('跳过/阻塞不得调用抠图');
  if (value.action === 'skip' && !facts.hasTransparentPixels) errors.push('不透明文件不能仅凭模型声称已具备透明背景');
  return { valid: !errors.length, errors, executable: false, visualStatus: 'needs_final_review' };
}
