/** Business routing rules shared by the production UI and processing callers. */
export const ARTWORK_ROUTING_STANDARD = {
  version: 'artwork-routing-v4',
  clarityMinimum: 80,
  directScaleMaximum: 1.25,
  repairLimit: 1,
  targetLongEdge: 1000,
  scoreProtocol: 'foreground-white-1000-inverse-blur-v2',
} as const;

export type ArtworkMethod = 'preserve' | 'redraw' | 'compose' | 'generate';
export type ArtworkIntentKind = 'preserve' | 'compose' | 'generate' | 'unknown';
export type ArtworkRuleCheck = { label: string; value: string; state: 'pass' | 'fail' | 'pending' };

export const ARTWORK_PIXEL_PROTOCOL = 'foreground-native-pixels-v1';

export const ARTWORK_METHODS: Record<ArtworkMethod, { code: string; label: string; criteria: string[]; operation: string }> = {
  preserve: {
    code: 'A', label: '原图保真',
    criteria: ['目标已是独立平面图案，原结构与排版可直接沿用；明确保留整图时按原图处理', '按有效主体像素和实际使用尺寸判断是否需要放大', '像素不足或确认存在模糊、压缩损伤时，最多保真增强一次；仍不足只提醒'],
    operation: '只去底、去杂点；需要时保真增强，不重新设计。',
  },
  redraw: {
    code: 'B', label: '原设计重建',
    criteria: ['保留原设计；目标位于实物表面或需要校正透视、褶皱时，直接重建独立图案', '低清本身只触发保真增强；仅实拍还原或明确重建要求使用模型', '先生成图案，再去底并核对文字、标志与载体残留', '纯色净化仅适用于已确认的纯色平面图案，保留设计本身的白色与渐变'],
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
  score: number | null;
  protocol: string;
};

export type ArtworkQualityMeasurement = ArtworkClarityMeasurement & {
  /** MediaKit standard blur is a severity value: lower means less blur. */
  rawBlur?: number;
  sha256: string;
  checkedAt: string;
  vqscore: number | null;
  noise: number | null;
  compressionArtifacts: number | null;
  subjectWidth: number;
  subjectHeight: number;
  requiredScale: number;
  targetLongEdge?: number;
  targetBasis?: string;
};

/** Verified with identical current/blurred inputs; this is a conversion, not a provider clarity score. */
export function clarityFromStandardBlur(blur: number) {
  if (!Number.isFinite(blur) || blur < 0 || blur > 100) throw new Error('无效的标准版模糊度');
  return Math.round((100 - blur) * 100) / 100;
}

export function artworkClarityLabel(quality: ArtworkClarityMeasurement | null | undefined) {
  if (!quality) return '未记录';
  if (quality.protocol === ARTWORK_PIXEL_PROTOCOL) return '按实际像素处理，未调用评分';
  if (quality.protocol !== ARTWORK_ROUTING_STANDARD.scoreProtocol) {
    return `旧评分口径待更新（原始 blur ${quality.score !== null && Number.isFinite(quality.score) ? quality.score.toFixed(2) : '无效'}）`;
  }
  return `${quality.score?.toFixed(2) ?? '未记录'} 分（历史换算）`;
}

export type ArtworkRoutingReport = {
  contentReview?: { verification?: import('./artwork-model-edits').ArtworkEditVerification; warnings: string[] };
  sourceSelection?: import('./server/artwork-source-selection').ArtworkSourceSelectionReceipt;
  timings?: import('./artwork-progress').ArtworkTiming[];
  version: typeof ARTWORK_ROUTING_STANDARD.version | 'artwork-routing-v3' | 'artwork-routing-v2';
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
  textComposition?: {
    operation: import('./artwork-text-contract').ArtworkTextOperation;
    removal?: import('./artwork-model-edits').ArtworkEditVerification;
    graphicRemoval?: import('./artwork-model-edits').ArtworkEditVerification;
    components: import('./artwork-model-edits').ArtworkTextComponentVerification[];
  };
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
    && value.score !== null && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100 ? value.score : null;
}

function validScale(value: number | null) {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
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

  const sourceScale = validScale(facts.requiredScale);
  checks.push({ label: '有效像素', value: sourceScale === null ? '处理前读取主体尺寸' : `目标放大 ${sourceScale.toFixed(2)} 倍；仅作增强依据`, state: sourceScale === null ? 'pending' : 'pass' });
  if (facts.repair.attempts >= ARTWORK_ROUTING_STANDARD.repairLimit) {
    return finish('preserve', 'ready', 'clean', '已完成一次保真增强；保留实际结果，尺寸或内容疑点作为人工核查提醒。');
  }
  if (sourceScale === null) return finish('preserve', 'pending', 'inspect', '先读取主体实际尺寸，再判断是否需要保真增强。');
  const damaged = facts.sourceAssessment?.defects?.some(defect => defect.confirmed && ['blur', 'compression'].includes(defect.kind));
  return sourceScale > 1 || damaged
    ? finish('preserve', 'ready', 'repair-once', '主体像素不足或已识别模糊、压缩损伤，执行一次保真增强。')
    : finish('preserve', 'ready', 'clean', '主体像素足够且没有已确认的清晰度问题，直接处理图案。');
}
