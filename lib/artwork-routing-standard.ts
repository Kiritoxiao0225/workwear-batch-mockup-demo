/** Business routing rules shared by the production UI and processing callers. */
export const ARTWORK_ROUTING_STANDARD = {
  version: 'artwork-routing-v3',
  clarityMinimum: 80,
  directScaleMaximum: 1.25,
  repairLimit: 1,
  targetLongEdge: 1000,
  scoreProtocol: 'foreground-white-1000-inverse-blur-v2',
} as const;

export type ArtworkMethod = 'preserve' | 'redraw' | 'compose' | 'generate';
export type ArtworkIntentKind = 'preserve' | 'compose' | 'generate' | 'unknown';
export type ArtworkRuleCheck = { label: string; value: string; state: 'pass' | 'fail' | 'pending' };

const { clarityMinimum, directScaleMaximum, repairLimit } = ARTWORK_ROUTING_STANDARD;

export const ARTWORK_METHODS: Record<ArtworkMethod, { code: string; label: string; criteria: string[]; operation: string }> = {
  preserve: {
    code: 'A', label: '原图保真',
    criteria: ['目标已是独立平面图案，原结构与排版可直接沿用；明确保留整图时按原图处理', `清晰度 ≥ ${clarityMinimum} 且目标放大 ≤ ${directScaleMaximum} 倍：直接去底`, `清晰度 < ${clarityMinimum} 或目标放大 > ${directScaleMaximum} 倍：先保真修复 ${repairLimit} 次，再评分`],
    operation: '只去底、去杂点；需要时保真增强，不重新设计。',
  },
  redraw: {
    code: 'B', label: '原设计重建',
    criteria: ['保留原设计；目标位于实物表面或需要校正透视、褶皱时，直接重建独立图案', `独立低清 Logo 先保真修复 ${repairLimit} 次，仍未达标且满足纯色条件时重建`, '先生成图案，再去底并核对文字、标志与载体残留', '纯色净化仅适用于已确认的纯色平面图案，保留设计本身的白色与渐变'],
    operation: '按原设计重建独立图案，再去底并核对内容。',
  },
  compose: {
    code: 'C', label: '图文组合',
    criteria: ['保留主体，只加字、换字、整体单色替换、裁切或调整局部排版', '描边、底形或明暗分别调整时，使用模型编辑完整图案', '原 Logo 按 A／B 单独处理；普通文字由程序排版，特殊字体才用模型'],
    operation: '分开处理原图与新增部分，再合成完整图案。',
  },
  generate: {
    code: 'D', label: '整图生成',
    criteria: ['重新设计、参考图决定整体构图，或原图需要分区域改色与明暗调整', '原图局部编辑先完成指定修改，保留其余内容，再抠图并逐项核对', '仅有参考附件、图片很小或要求裁切，不满足此条件'],
    operation: '将完整要求和对应参考图一起交给模型，生成一个完整候选。',
  },
};

export type ArtworkClarityMeasurement = {
  score: number;
  protocol: string;
};

export type ArtworkQualityMeasurement = ArtworkClarityMeasurement & {
  /** MediaKit standard blur is a severity value: lower means less blur. */
  rawBlur?: number;
  sha256: string;
  checkedAt: string;
  vqscore: number;
  noise: number | null;
  compressionArtifacts: number | null;
  subjectWidth: number;
  subjectHeight: number;
  requiredScale: number;
};

/** Verified with identical current/blurred inputs; this is a conversion, not a provider clarity score. */
export function clarityFromStandardBlur(blur: number) {
  if (!Number.isFinite(blur) || blur < 0 || blur > 100) throw new Error('无效的标准版模糊度');
  return Math.round((100 - blur) * 100) / 100;
}

export function artworkClarityLabel(quality: ArtworkClarityMeasurement | null | undefined) {
  if (!quality) return '未检测';
  if (quality.protocol !== ARTWORK_ROUTING_STANDARD.scoreProtocol) {
    return `旧评分口径待更新（原始 blur ${Number.isFinite(quality.score) ? quality.score.toFixed(2) : '无效'}）`;
  }
  return `${quality.score.toFixed(2)} 分（换算）`;
}

export type ArtworkRoutingReport = {
  timings?: import('./artwork-progress').ArtworkTiming[];
  version: typeof ARTWORK_ROUTING_STANDARD.version | 'artwork-routing-v2';
  runId: string;
  requestHash: string;
  sourceSha256: string;
  decision: ArtworkRoutingDecision;
  graphicDecision: ArtworkRoutingDecision;
  executedMethod: ArtworkMethod;
  graphicMethod: ArtworkMethod;
  facts: ArtworkRoutingFacts;
  source: ArtworkQualityMeasurement;
  repair: ArtworkQualityMeasurement | null;
  graphic: ArtworkQualityMeasurement;
  reviewReasons: string[];
  operations: string[];
  model: string | null;
  prompt: string | null;
  promptHash: string;
  redraw?: {
    status: 'completed' | 'failed';
    stage: 'generation' | 'cleanup' | 'measurement';
    model: string | null;
    inputSha256: string;
    promptHash: string;
    error?: string;
  };
};

export function artworkQualityPassed(quality: ArtworkQualityMeasurement | null | undefined, sha256?: string) {
  if (!quality) return false;
  const score = validArtworkClarity(quality);
  return score !== null && score >= ARTWORK_ROUTING_STANDARD.clarityMinimum
    && Number.isFinite(quality.requiredScale) && quality.requiredScale > 0
    && quality.requiredScale <= ARTWORK_ROUTING_STANDARD.directScaleMaximum
    && (!sha256 || quality.sha256 === sha256);
}

export type ArtworkRoutingFacts = {
  sourceAssessment?: import('./artwork-source-assessment').ArtworkSourceAssessment;
  sourceAssessmentRequired?: boolean;
  reconstructSource?: boolean;
  intent: ArtworkIntentKind;
  intentReason: string;
  sourcePresent: boolean;
  blockers: string[];
  sourceClarity: ArtworkClarityMeasurement | null;
  requiredScale: number | null;
  repair: { attempts: number; clarity: ArtworkClarityMeasurement | null; requiredScale: number | null };
  // A white background does not prove that the foreground is a flat-colour logo.
  redrawEligibility: 'verified-flat-readable' | 'ineligible' | 'unknown';
  editSpecification: 'complete' | 'incomplete' | 'unknown';
  strictPreservation: boolean;
};

export type ArtworkRoutingDecision = {
  version: typeof ARTWORK_ROUTING_STANDARD.version;
  method: ArtworkMethod | null;
  state: 'ready' | 'pending' | 'review';
  action: 'clean' | 'repair-once' | 'redraw' | 'compose' | 'generate' | 'inspect' | 'review';
  reason: string;
  checks: ArtworkRuleCheck[];
};

export function validArtworkClarity(value: ArtworkClarityMeasurement | null): number | null {
  return value?.protocol === ARTWORK_ROUTING_STANDARD.scoreProtocol
    && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100 ? value.score : null;
}

function validScale(value: number | null) {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function scoreCheck(label: string, value: ArtworkClarityMeasurement | null): ArtworkRuleCheck {
  const score = validArtworkClarity(value);
  return { label, value: score === null ? value ? value.protocol !== ARTWORK_ROUTING_STANDARD.scoreProtocol ? '旧口径，待同尺度复测' : '评分无效，需重新检测' : '未检测' : `${score.toFixed(2)} / 100 · 标准 ≥ ${clarityMinimum}`,
    state: score === null ? 'pending' : score >= ARTWORK_ROUTING_STANDARD.clarityMinimum ? 'pass' : 'fail' };
}

/** Unknown evidence never counts as a passed condition. This function makes no API calls. */
export function decideArtworkMethod(facts: ArtworkRoutingFacts): ArtworkRoutingDecision {
  const checks: ArtworkRuleCheck[] = [{ label: '需求类型', value: facts.intentReason, state: facts.intent === 'unknown' ? 'pending' : 'pass' }];
  const finish = (method: ArtworkMethod | null, state: ArtworkRoutingDecision['state'], action: ArtworkRoutingDecision['action'], reason: string): ArtworkRoutingDecision => (
    { version: ARTWORK_ROUTING_STANDARD.version, method, state, action, reason, checks }
  );
  if (!facts.sourcePresent || facts.blockers.length > 0 || facts.intent === 'unknown') {
    checks.push({ label: '必要资料', value: !facts.sourcePresent ? '缺少可读取的主体素材' : facts.blockers.join('；') || '需求不能唯一判断', state: 'fail' });
    return finish(null, 'review', 'review', '先补齐资料或核对需求，再选择处理方案。');
  }
  if ((facts.intent === 'generate' || facts.intent === 'compose') && facts.editSpecification !== 'complete') {
    checks.push({ label: '修改要求', value: '需明确准确文字、修改范围或参考用途', state: 'pending' });
    return finish(facts.intent, 'review', 'review', '方案类型已判断；补齐具体修改要求后才能执行。');
  }
  if (facts.sourceAssessmentRequired && (!facts.sourceAssessment || facts.sourceAssessment.kind === 'unknown'
    || facts.sourceAssessment.needsReconstruction === null)) {
    checks.push({ label: '素材形态', value: '尚未判断目标是否为独立图案，制作前读图判断', state: 'pending' });
    return finish(null, 'pending', 'inspect', '先识别目标图案与载体，再决定保真处理或原设计重建。');
  }
  if (facts.sourceAssessmentRequired && facts.sourceAssessment) checks.push({ label: '素材形态', value: facts.sourceAssessment.evidence.join('；'), state: 'pass' });
  if (facts.reconstructSource && facts.strictPreservation) return finish(null, 'review', 'review', '目标需要重建，但当前指定保留原像素；请选择原设计重建或提供独立图稿。');
  if (facts.reconstructSource && facts.intent === 'preserve') {
    return finish('redraw', 'ready', 'redraw', `目标需要还原为独立图案，直接按原设计重建：${facts.sourceAssessment?.evidence.join('；')}`);
  }
  if (facts.intent === 'generate' || facts.intent === 'compose') {
    const method = facts.intent;
    checks.push({ label: '修改要求', value: facts.editSpecification === 'complete' ? '所需文字、修改范围和参考用途已明确' : '需明确准确文字、修改范围或参考用途', state: facts.editSpecification === 'complete' ? 'pass' : 'pending' });
    return facts.editSpecification === 'complete'
      ? finish(method, 'ready', method, facts.intentReason)
      : finish(method, 'review', 'review', '方案类型已判断；补齐具体修改要求后才能执行。');
  }

  const sourceScore = validArtworkClarity(facts.sourceClarity);
  const sourceScale = validScale(facts.requiredScale);
  checks.push(scoreCheck('原图清晰度', facts.sourceClarity));
  checks.push({ label: '目标放大', value: sourceScale === null ? '未检测有效图案像素' : `${sourceScale.toFixed(2)} 倍 · 直接使用 ≤ 1.25 倍`, state: sourceScale === null ? 'pending' : sourceScale <= ARTWORK_ROUTING_STANDARD.directScaleMaximum ? 'pass' : 'fail' });
  if (facts.repair.attempts < ARTWORK_ROUTING_STANDARD.repairLimit) {
    if (sourceScore === null || sourceScale === null) return finish('preserve', 'pending', 'inspect', '先检测原图清晰度和有效像素，再决定直接去底或保真修复。');
    return sourceScore >= ARTWORK_ROUTING_STANDARD.clarityMinimum && sourceScale <= ARTWORK_ROUTING_STANDARD.directScaleMaximum
      ? finish('preserve', 'ready', 'clean', '清晰度与有效像素均达标，直接去底。')
      : finish('preserve', 'ready', 'repair-once', '原图未满足直接使用标准，先保真修复 1 次。');
  }

  const repairedScore = validArtworkClarity(facts.repair.clarity);
  const repairedScale = validScale(facts.repair.requiredScale);
  checks.push(scoreCheck('修复后清晰度', facts.repair.clarity));
  checks.push({ label: '修复后放大', value: repairedScale === null ? '未检测' : `${repairedScale.toFixed(2)} 倍 · 标准 ≤ 1.25 倍`, state: repairedScale === null ? 'pending' : repairedScale <= ARTWORK_ROUTING_STANDARD.directScaleMaximum ? 'pass' : 'fail' });
  if (repairedScore === null || repairedScale === null) return finish('preserve', 'pending', 'inspect', '已有修复记录，但缺少修复后的同尺度评分；先复测，不重复修复或直接重绘。');
  if (repairedScore >= ARTWORK_ROUTING_STANDARD.clarityMinimum && repairedScale <= ARTWORK_ROUTING_STANDARD.directScaleMaximum) return finish('preserve', 'ready', 'clean', '保真修复后已达标，沿用修复结果。');
  if (facts.strictPreservation) return finish('preserve', 'review', 'review', '修复未达标，且已指定严格保真；需要更清晰原图或人工处理。');
  checks.push({ label: '重绘适用性', value: facts.redrawEligibility === 'verified-flat-readable' ? '纯色平面图案，文字和图形已确认，无白色前景' : facts.redrawEligibility === 'ineligible' ? '不适用纯色图案重绘净化' : '待核对纯色类型、原文字与图形', state: facts.redrawEligibility === 'verified-flat-readable' ? 'pass' : facts.redrawEligibility === 'ineligible' ? 'fail' : 'pending' });
  return facts.redrawEligibility === 'verified-flat-readable'
    ? finish('redraw', 'ready', 'redraw', '保真修复仍未达标，且满足纯色图案重绘条件。')
    : finish('redraw', 'review', 'review', '修复仍未达标；重绘适用条件未全部通过，不能自动重绘。');
}
