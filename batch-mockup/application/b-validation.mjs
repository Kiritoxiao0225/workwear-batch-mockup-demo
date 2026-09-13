import { readFile } from 'node:fs/promises';
import { planSchema } from '../domain/b-plan.mjs';
import { missingGlyphs } from '../adapters/font-coverage.ts';
import { hash } from '../adapters/a-files.mjs';
import { fontPath } from './b-input.mjs';

export async function validateBPlan(value, input) {
  const errors = [], waiting = [], warnings = [];
  const bad = (at, message) => errors.push({ at, message });
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) return { valid: false, executable: false, errors: parsed.error.issues.map(i => ({ at: i.path.join('.'), message: i.message })), waiting, warnings };
  const plan = parsed.data, body = input.confirmation.text;
  const images = new Map(input.confirmation.images.map(i => [i.id, i]));
  const artworkIds = new Set(), steps = new Map(), uses = new Set(), exclusions = new Set(), assessments = new Set(), dimensions = new Map(), backgrounds = new Map();
  const isRegion = r => r.x + r.width <= 1.00000001 && r.y + r.height <= 1.00000001;
  const font = await readFile(fontPath);
  const quote = (s, at) => { if (!body.includes(s)) bad(at, '引用不在A确认正文中，不能新增或改写依据'); };
  for (const a of plan.artworks) {
    if (artworkIds.has(a.id)) bad(a.id, '图稿身份重复');
    artworkIds.add(a.id); quote(a.requirementQuote, a.id);
    for (const application of a.applications) quote(application, a.id + '.applications');
    if (a.outputStepId === null) {
      if (!a.blockedReason) bad(a.id, '没有制作路线时必须说明具体阻塞原因，不能伪造空白成品');
      else waiting.push({ at: a.id, message: a.blockedReason });
    } else if (a.blockedReason) bad(a.id, '有最终输出的图稿不能同时标为缺少路线');
  }
  for (const a of plan.imageAssessments) {
    if (!images.has(a.imageId) || assessments.has(a.imageId)) bad(a.imageId, '图片观察身份无效或重复');
    assessments.add(a.imageId);
    if (a.region && !isRegion(a.region)) bad(a.imageId, '主体估计范围越界');
    const facts = input.images.find(i => i.id === a.imageId);
    if (facts && a.region) warnings.push({ at: a.imageId, message: `主体像素估计约${Math.round(facts.width * a.region.width)}×${Math.round(facts.height * a.region.height)}；来自模型选区，不是清晰度验收` });
  }
  for (const id of images.keys()) if (!assessments.has(id)) bad(id, '未观察这张图片');
  for (const e of plan.excludedImages) {
    if (!images.has(e.imageId) || exclusions.has(e.imageId)) bad(e.imageId, '排除素材不存在或重复');
    quote(e.requirementQuote, e.imageId); exclusions.add(e.imageId);
    warnings.push({ at: e.imageId, message: '素材排除依据需语义核对：' + e.requirementQuote });
  }
  for (const step of plan.steps) {
    if (steps.has(step.id)) bad(step.id, '步骤身份重复');
    if (!artworkIds.has(step.artworkId)) bad(step.id, '步骤属于不存在的图稿');
    const capability = input.capabilities.operations.find(c => c.id === step.capabilityId);
    if (!capability) bad(step.id, '目录中没有该能力');
    else if (!capability.cReady) waiting.push({ at: step.id, capability: capability.id, message: 'C适配与真实结果验收尚未完成' });
    const refKeys = new Set();
    for (const ref of step.inputs) {
      const key = `${ref.kind}:${ref.id}:${ref.role}`;
      if (refKeys.has(key)) bad(step.id, '重复的素材绑定');
      refKeys.add(key);
      if (ref.kind === 'image') {
        if (!images.has(ref.id) || exclusions.has(ref.id)) bad(step.id, '素材不存在或被排除');
        uses.add(ref.id);
      } else if (!steps.has(ref.id) || steps.get(ref.id).artworkId !== step.artworkId) bad(step.id, '步骤输入必须是前序同图稿输出，不能串胸背或循环');
    }
    const op = capability?.operation, p = step.params;
    const first = step.inputs[0];
    const sourceSize = first?.kind === 'image' ? input.images.find(i => i.id === first.id) : dimensions.get(first?.id);
    // Cropping and cutout cannot create detail. Enhancement/generation need actual C output measurements.
    const estimated = op === 'cutout' && first?.kind === 'image' ? plan.imageAssessments.find(a => a.imageId === first.id)?.region : null;
    if (['reuse', 'cutout'].includes(op) && sourceSize) dimensions.set(step.id, {
      width: sourceSize.width * (p.crop?.width || estimated?.width || 1), height: sourceSize.height * (p.crop?.height || estimated?.height || 1),
      estimated: Boolean(estimated || sourceSize.estimated),
    });
    const composing = ['compose', 'compose-white'].includes(op);
    const allowed = op === 'reuse' ? ['crop'] : op === 'render-text' ? ['text', 'fontId', 'fontAuthorizationQuote', 'styleProposal', 'color', 'layout'] : op === 'compose' ? ['placements', 'background', 'backgroundAuthorizationQuote'] : op === 'compose-white' ? ['placements'] : [];
    if (Object.keys(p).some(k => !allowed.includes(k))) bad(step.id, '该能力不支持这些参数');
    if (op !== 'render-text' && !step.inputs.length && op !== 'generate') bad(step.id, '制作步骤缺少输入');
    if (['reuse', 'enhance', 'cutout'].includes(op) && (step.inputs.length !== 1 || step.inputs[0].role !== 'content')) bad(step.id, '此步骤必须只接收一个内容输入');
    if (p.crop) {
      if (!isRegion(p.crop) || step.inputs[0]?.kind !== 'image') bad(step.id, '裁切需要有效原图选区');
      else waiting.push({ at: step.id, message: '模型裁切范围需用C实际候选核对，尚未验证不会切掉内容' });
    }
    if (op === 'render-text') {
      if (!p.text || !p.fontId || (!p.fontAuthorizationQuote && !p.styleProposal) || !p.color || !p.layout || step.inputs.some(ref => ref.kind !== 'image' || !['layout', 'color'].includes(ref.role))) bad(step.id, '本地排字缺少精确文字/字体依据或建议标记/颜色/排版，或将内容图/字体参考冒充本地排字输入');
      else {
        // References explain selected numeric layout/color; they are never raster content layers.
        if (step.inputs.length) warnings.push({ at: step.id, message: '排字图片仅是排版/颜色依据，不是输出图层；C按明确text/font/layout/color排字，不粘贴参考照片' });
        quote(p.text, step.id + '.text'); if (p.fontAuthorizationQuote) quote(p.fontAuthorizationQuote, step.id + '.font');
        const selected = input.fonts.find(f => f.id === p.fontId);
        if (!selected || selected.sha256 !== hash(font) || (!p.styleProposal && !p.fontAuthorizationQuote.includes(selected.name))) bad(step.id, '实际字体不存在、已变化或A未授权此字体');
        if (p.styleProposal) {
          waiting.push({ at: step.id, message: '字体/颜色为制作建议，不是A确认内容；需核对建议后才能制作，不自动替换指定或参考字体' });
          if (!plan.reviewNotes.length) bad(step.id, '默认样式建议必须在reviewNotes中明确说明');
        }
        const missing = missingGlyphs(font, p.text);
        if (missing.length) bad(step.id, '字体缺字：' + missing.join(''));
        if (p.layout.kind === 'arc' && (p.text.includes('\n') || !p.layout.degrees || !p.layout.direction)) bad(step.id, '弧形只支持单行且需角度和方向');
      }
    }
    const sourceBackground = first?.kind === 'image' ? (sourceSize?.hasTransparentPixels ? 'alpha' : 'opaque') : backgrounds.get(first?.id);
    if (op === 'reuse') backgrounds.set(step.id, sourceBackground);
    if (op === 'render-text' || op === 'cutout') backgrounds.set(step.id, 'alpha');
    if (op === 'enhance' || op === 'generate') {
      backgrounds.set(step.id, 'unknown');
      waiting.push({ at: step.id, message: '供应商实际结果须检查背景和Alpha；增强不能默认保留透明，生成不能默认已抠干净，不自动追加重复抠图' });
    }
    if (composing) {
      const background = op === 'compose-white' ? 'white' : p.background;
      if (!background) bad(step.id, '合成必须明确透明或白色画布，不能靠预览底色推断');
      if (background === 'white' && input.output.background !== 'white') {
        if (!p.backgroundAuthorizationQuote) bad(step.id, '未明确要求白底，禁止把图稿强制合成白底');
        else {
          quote(p.backgroundAuthorizationQuote, step.id + '.background');
          waiting.push({ at: step.id, message: '白底导出依据需核对是否指成品背景，而非衣色/白字/白边；保留原图和透明中间稿' });
        }
      }
      if (input.output.background === 'transparent' && background === 'white') bad(step.id, '透明输出要求与白底合成冲突');
      backgrounds.set(step.id, background === 'white' ? 'white' : 'unknown');
      dimensions.set(step.id, { width: input.output.width, height: input.output.height });
      if (background === 'transparent') waiting.push({ at: step.id, message: '透明画布不等于图层背景已去除；须核对实际合成Alpha和内容边缘' });
      const contentIds = step.inputs.map(i => i.id), placed = (p.placements || []).map(i => i.inputId);
      if (step.inputs.some(i => i.role !== 'content') || contentIds.length !== new Set(contentIds).size || placed.length !== contentIds.length || new Set(placed).size !== placed.length || contentIds.some(id => !placed.includes(id))) bad(step.id, '合成必须完整绑定内容图层，不能把字体或颜色参考贴到成品');
      for (const layer of p.placements || []) {
        if (layer.x + layer.width > input.output.width || layer.y + layer.height > input.output.height) bad(step.id, '图层超出目标画布');
        const ref = step.inputs.find(i => i.id === layer.inputId);
        const size = ref?.kind === 'image' ? input.images.find(i => i.id === ref.id) : dimensions.get(ref?.id);
        if (size) {
          const scale = Math.min(layer.width / size.width, layer.height / size.height);
          if (scale > 1.001) waiting.push({ at: step.id, message: `${size.estimated ? '按模型主体范围估计，' : ''}原图内容将放大${scale.toFixed(2)}倍但未经过细节恢复；需核对目标尺寸和清晰度，不能当作已高清` });
        }
      }
    }
    steps.set(step.id, step);
  }
  for (const id of images.keys()) if (!uses.has(id) && !exclusions.has(id)) bad(id, '素材没有实际绑定到制作步骤，也没有明确排除依据');
  const reachable = new Set();
  const visit = id => { if (reachable.has(id)) return; const s = steps.get(id); if (!s) return; reachable.add(id); s.inputs.filter(i => i.kind === 'step').forEach(i => visit(i.id)); };
  for (const a of plan.artworks) {
    if (a.outputStepId === null) continue;
    const final = steps.get(a.outputStepId);
    if (!final || final.artworkId !== a.id) bad(a.id, '图稿必须引用自身实际最后一个必要步骤，不强制合成');
    if (final) {
      const background = backgrounds.get(final.id), size = dimensions.get(final.id);
      if (input.output.background === 'white' && background !== 'white') waiting.push({ at: a.id, message: '明确的白底导出要求尚需实际像素核验，不能把直接输出当成已满足白底' });
      if (input.output.background === 'transparent' && background !== 'alpha') waiting.push({ at: a.id, message: '透明成品要求尚需真实输出Alpha核验，当前不能确认满足' });
      if ((input.output.sizing || 'exact') === 'exact' && (!size || size.width !== input.output.width || size.height !== input.output.height)) waiting.push({ at: a.id, message: '指定画布尺寸尚未满足或未测量；需实际输出尺寸核验，不能静默放大' });
    }
    visit(a.outputStepId);
  }
  for (const s of plan.steps) if (!reachable.has(s.id)) bad(s.id, '步骤没有进入最终输出，不应执行或付费');
  return { valid: !errors.length, executable: !errors.length && !waiting.length && !plan.reviewNotes.length,
    errors, waiting, warnings: [...warnings, ...plan.reviewNotes.map(message => ({ at: 'model', message }))], semanticStatus: 'needs_review', visualStatus: 'not_executed' };
}
