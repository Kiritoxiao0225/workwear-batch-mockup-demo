/** Shared, browser-safe requirements and recovery rules. No network or paid operations. */
export const WORKWEAR_LOGIC_VERSION = 'workwear-reliability-20260911-v1';
export const REQUIREMENTS_VERSION = 'artwork-requirements-v1';
export const FINAL_EVIDENCE_VERSION = 'final-evidence-v1';
export type ImageRole = 'content' | 'font' | 'color' | 'layout' | 'reference';
export type RequirementCategory = 'text' | 'color' | 'structure' | 'layout' | 'background';
export type RecoveryAction = 'wait' | 'verifySubmission' | 'retry' | 'recheckCutout' | 'changeCutoutMethod' | 'editRequirements' | 'recompose' | 'none';
export type ReliabilityIssue = { code: string; message: string; imageLabel?: string };
export type RequirementInput = {
  sourceRequirementText?: string; instruction: string; layoutNote: string; exactText?: string;
  generationPrompt?: string; primaryImageLabel: string; primaryImageRole?: 'content' | 'reference';
  referenceImages: Array<{ label: string }>; printPlacement?: { key: string } | null;
  sourceScope?: string; fontReference?: { label: string; description?: string; origin?: string };
};
export type ImageDependency = { label: string; role: ImageRole; evidence: string };
export type ArtworkRequirementContract = {
  version: typeof REQUIREMENTS_VERSION; logicVersion: typeof WORKWEAR_LOGIC_VERSION;
  /** Exact canonical JSON is used for equality. A non-cryptographic hash never authorizes a write. */
  key: string; sourceText: string; scopedSource: string; instruction: string; layoutNote: string;
  exactText: string; generationPrompt: string; dependencies: ImageDependency[];
  inputs: Array<{ sourceLabel: string; inputLabel: string; roles: ImageRole[] }>;
  requirements: Array<{ id: string; category: RequirementCategory; evidence: string }>;
  issues: ReliabilityIssue[];
};
const placementAliases: Record<string, string> = {
  正面左胸: 'leftChest', 正面右胸: 'rightChest', 后背上方: 'back', 后领口: 'back',
  正前面: 'frontCenter', 正面: 'frontCenter', 左胸: 'leftChest', 右胸: 'rightChest',
  后脖: 'back', 后颈: 'back', 后领: 'back', 后背: 'back', 背面: 'back', 左袖: 'leftSleeve', 右袖: 'rightSleeve',
};
const globalFields = new Set(['字体', '颜色', '工艺', '尺寸']);
export function canonicalJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, visit(v)]));
    return item;
  };
  return JSON.stringify(visit(value)) ?? 'null';
}
export function normalizeImageLabels(value: string): string {
  const digits = '零一二三四五六七八九';
  return value.normalize('NFKC').replace(/(?:图(?:片)?|第)\s*([0-9]+|[零一二三四五六七八九十]+)(?:张图(?:片)?)?/gu, (all, ordinal: string) => {
    const parts = ordinal.split('十');
    const n = /^\d+$/u.test(ordinal) ? Number(ordinal) : parts.length === 2
      ? (parts[0] ? digits.indexOf(parts[0]) : 1) * 10 + (parts[1] ? digits.indexOf(parts[1]) : 0) : digits.indexOf(ordinal);
    // Do not reinterpret an ordinary 第三行 as an image.
    if (all.startsWith('第') && !/张图/u.test(all)) return all;
    return n > 0 && n <= 999 ? `图${n}` : all;
  }).replace(/图(\d+)((?:\s*[+＋、&和及]\s*\d{1,2}(?![\dA-Za-z.%％厘毫件张号]))+)/gu, (_all, first: string, tail: string) =>
    // Bare numbers after a joint separator are image shorthand (图1+2 → 图1+图2) only when
    // short (1-2 digits) and not followed by another digit or a unit (2026 year, 20cm width, 3件 count).
    `图${first}${tail.replace(/([+＋、&和及]\s*)(\d+)/gu, '$1图$2')}`);
}
export function imageLabels(value: string): string[] {
  return [...new Set([...normalizeImageLabels(value).matchAll(/图([1-9]\d*)/gu)].map(m => `图${Number(m[1])}`))];
}
/** Keep exact source clauses for evidence; only matching uses normalized labels. */
export function scopedSourceRequirement(source: string, placement: string | null | undefined, primary: string): { text: string; ambiguous: boolean } {
  const names = [...Object.keys(placementAliases), ...globalFields].join('|');
  const fields = [...source.matchAll(new RegExp(`(${names})\\s*[:：]`, 'gu'))];
  if (!fields.some(field => placementAliases[field[1]])) return scopedByLeadingPlacement(source, placement);
  const placementHeaders = fields.map(field => placementAliases[field[1]]).filter(Boolean);
  // A source that names exactly one placement is unambiguous even when the request does not
  // carry a placement key: every requirement clearly belongs to that single placement.
  const singlePlacement = new Set(placementHeaders).size === 1 ? placementHeaders[0] : null;
  if (!placement && !singlePlacement) return { text: '', ambiguous: true };
  const effectivePlacement = placement ?? singlePlacement;
  const relevant = fields.flatMap((field, i) => placementAliases[field[1]] === effectivePlacement || globalFields.has(field[1])
    ? [{ header: field[1], text: source.slice(field.index! + field[0].length, fields[i + 1]?.index ?? source.length) }] : []);
  let ambiguous = false;
  const selected = relevant.map(section => {
    if (globalFields.has(section.header)) return `${section.header}：${section.text}`;
    const branches = [...section.text.matchAll(/([\p{L}\p{N}_-]{2,})\s*[:：]/gu)];
    if (branches.length < 2) return section.text;
    const pieces = branches.map((header, i) => section.text.slice(header.index!, branches[i + 1]?.index ?? section.text.length));
    const hits = pieces.filter(piece => imageLabels(piece).includes(normalizeImageLabels(primary)));
    if (hits.length === 1) return hits[0];
    ambiguous = true;
    return '';
  });
  return { text: selected.join('\n'), ambiguous };
}
/**
 * Fallback scoping when the source has no 「位置名：」 headers: WPS原文 often separates
 * placements on one line by spaces (「301SRX-黑色 正面 图一 后背 图一前三排 按照图二做」)
 * or by line breaks without any colon (「正面 图一\n后背 图二」). A token that is (or starts
 * with) a placement name opens a section for that placement; other tokens continue the
 * current section. Without this fallback the whole source leaks into every placement.
 */
function scopedByLeadingPlacement(source: string, placement: string | null | undefined): { text: string; ambiguous: boolean } {
  const placementNames = Object.keys(placementAliases).sort((a, b) => b.length - a.length);
  const globalNames = [...globalFields].sort((a, b) => b.length - a.length);
  const placementHeader = (token: string): { name: string; rest: string } | null => {
    for (const name of placementNames) {
      if (token === name || token.startsWith(name)) {
        return { name, rest: token.slice(name.length).replace(/^[\s:：]+/u, '') };
      }
    }
    return null;
  };
  const globalHeader = (token: string): { name: string; rest: string } | null => {
    for (const name of globalNames) {
      if (token === name || token.startsWith(name)) {
        return { name, rest: token.slice(name.length).replace(/^[\s:：]+/u, '') };
      }
    }
    return null;
  };
  type Section = { placement: string | null; global: string | null; parts: string[] };
  const sections: Section[] = [];
  const preamble: string[] = [];
  let current: Section | null = null;
  // Newlines and comma/semicolon-separated fragments always start fresh; within a fragment,
  // each whitespace-separated token is examined so space-delimited placements split correctly.
  for (const line of source.split(/\n/u)) {
    for (const fragment of line.split(/(?<=[，,。；;])/u)) {
      for (const token of fragment.split(/\s+/u)) {
        if (!token) continue;
        const placementMatch = placementHeader(token);
        const globalMatch = placementMatch ? null : globalHeader(token);
        if (placementMatch) {
          current = { placement: placementAliases[placementMatch.name], global: null, parts: placementMatch.rest ? [placementMatch.rest] : [] };
          sections.push(current);
        } else if (globalMatch) {
          current = { placement: null, global: globalMatch.name, parts: globalMatch.rest ? [globalMatch.rest] : [] };
          sections.push(current);
        } else if (current) current.parts.push(token);
        else preamble.push(token);
      }
    }
  }
  if (!sections.some(section => section.placement)) return { text: source, ambiguous: false };
  // Exactly one placement named in the source: unambiguous even without a request placement key.
  const namedPlacements = [...new Set(sections.filter(section => section.placement).map(section => section.placement))];
  if (!placement && namedPlacements.length > 1) return { text: '', ambiguous: true };
  const effectivePlacement = placement ?? namedPlacements[0];
  const selected = sections
    .filter(section => section.placement === effectivePlacement || section.global)
    .map(section => section.global ? `${section.global}：${section.parts.join(' ')}` : section.parts.join(' '));
  return { text: selected.join('\n'), ambiguous: false };
}
function roleFor(before: string, after: string): ImageRole {
  const prior = before.slice(-40), next = after.slice(0, 40);
  const style = /(?:参考|参照|仿照|依照|按|照|仿|学)\s*(?:WPS\s*)?$/iu.test(prior)
    || /(?:字体|字形|笔触|颜色|配色|排版|版式).{0,10}(?:参考|参照|按|照|用|学|仿)?\s*$/u.test(prior)
    || /^\s*(?:的)?(?:字体|字形|笔触|配色|版式|排版|颜色)/u.test(next)
    || /^\s*(?:仅|只)?(?:用作|作为|作)?(?:字体|字形|颜色|版式|排版)?参考/u.test(next);
  // 「整体改为图3所示的深蓝色」「统一改成WPS图2中的…荧光绿色」：a change verb before the
  // image label plus a colour word after it describes the colour source, not content to copy.
  const colourSource = /(?:改|换|变|调)(?:成|为|到)?\s*(?:WPS\s*)?$/u.test(prior)
    && /(?:所示|那种?|之中|中的)?[^\n]{0,30}(?:红|橙|黄|绿|青|蓝|紫|黑|白|灰|粉|棕|褐|金|银|荧光)色/u.test(next);
  if (colourSource) return 'color';
  if (!style) return 'content';
  const context = `${prior}\n${next}`;
  if (/字体|字形|笔触|书法/u.test(context)) return 'font';
  if (/颜色|配色|字色/u.test(context)) return 'color';
  if (/版式|排版|构图|布局/u.test(context)) return 'layout';
  return 'reference';
}
export function imageDependencies(text: string): ImageDependency[] {
  const result: ImageDependency[] = [];
  for (const raw of text.split(/[，,。；;\n]/u)) {
    const clause = normalizeImageLabels(raw);
    const matches = [...clause.matchAll(/图([1-9]\d*)/gu)];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const before = clause.slice(i ? matches[i - 1].index! + matches[i - 1][0].length : 0, m.index);
      const after = clause.slice(m.index! + m[0].length, matches[i + 1]?.index ?? clause.length);
      if (/(?:不要|不用|无需|不得|禁止|不再|不能)\s*(?:复制|参考|参照|使用|用|带入|取用)?\s*$/u.test(before)) continue;
      if (/^\s*(?:不使用|不用|不参考|不要)/u.test(after)) continue;
      let role = roleFor(before, after);
      // A trailing joint constraint applies to both images in 图1+图2的字体.
      if (matches.length > 1 && /[+＋、&和及]/u.test(clause) && /(?:字体|字形|配色|排版|版式)\s*$/u.test(clause)) {
        role = /字体|字形/u.test(clause) ? 'font' : /配色/u.test(clause) ? 'color' : 'layout';
      }
      result.push({ label: `图${Number(m[1])}`, role, evidence: raw.trim() });
    }
  }
  return result.filter((item, index) => result.findIndex(candidate => canonicalJson(candidate) === canonicalJson(item)) === index);
}
function requirementCategories(text: string): RequirementCategory[] {
  const categories: RequirementCategory[] = [];
  if (/文字|字体|字形|字色|数字|英文|中文|写|字/u.test(text)) categories.push('text');
  if (/颜色|配色|白|黑|红|蓝|绿|黄|#[\da-f]{6}|改色/iu.test(text)) categories.push('color');
  if (/排版|比例|大小|上下|左右|居中|对齐|排列|间距/u.test(text)) categories.push('layout');
  if (/背景|底色|底形|底板|红底|白底|去底|抠图|透明/u.test(text)) categories.push('background');
  if (/图\d|图[一二三四五六七八九]|标志|图形|logo|取用|截取|区域|保留/iu.test(text) || !categories.length) categories.push('structure');
  return categories;
}
export function compileArtworkRequirements(input: RequirementInput): ArtworkRequirementContract {
  const scope = scopedSourceRequirement(input.sourceRequirementText ?? '', input.printPlacement?.key, input.primaryImageLabel);
  const sourceDependencies = imageDependencies(scope.text || `${input.instruction}\n${input.layoutNote}`);
  // A manual font crop is an explicit override for font evidence only, never for content.
  const dependencies = sourceDependencies.map(dep => input.fontReference?.origin === 'manual' && dep.role === 'font'
    ? { ...dep, label: normalizeImageLabels(input.fontReference.label), evidence: `人工指定字体：${input.fontReference.label}；${input.fontReference.description ?? ''}` } : dep);
  const bound = [input.primaryImageLabel, ...input.referenceImages.map(image => image.label).sort((a, b) => Number(normalizeImageLabels(a).slice(1)) - Number(normalizeImageLabels(b).slice(1)))].map(normalizeImageLabels).filter(label => /^图[1-9]\d*$/u.test(label));
  const issues: ReliabilityIssue[] = [];
  if (scope.ambiguous) issues.push({ code: 'SOURCE_SCOPE_AMBIGUOUS', message: '原文包含多个款式或位置分支，当前图号不能唯一确定本位置，请先明确所属分支' });
  for (const dep of dependencies) if (!bound.includes(dep.label)) issues.push({ code: 'REQUIRED_IMAGE_MISSING', imageLabel: dep.label,
    message: `原文要求使用${dep.label}（${dep.role === 'content' ? '成品内容' : dep.role === 'font' ? '字体参考' : '参考依据'}），但制作输入未绑定该图` });
  for (const label of imageLabels(`${input.instruction}\n${input.layoutNote}\n${input.generationPrompt ?? ''}`)) if (!bound.includes(label)) {
    issues.push({ code: 'PROMPT_IMAGE_MISSING', imageLabel: label, message: `制作要求引用${label}，但本次没有传入该图` });
  }
  const inputs = bound.filter((label, index) => bound.indexOf(label) === index).map((sourceLabel, i) => {
    let roles = [...new Set(dependencies.filter(dep => dep.label === sourceLabel).map(dep => dep.role))];
    if (sourceLabel === input.fontReference?.label) roles = [...new Set([...roles.filter(role => role !== 'reference'), 'font' as const])];
    if (!roles.length) roles = [i === 0 && input.primaryImageRole !== 'reference' ? 'content' : 'reference'];
    return { sourceLabel, inputLabel: `图${i + 1}`, roles };
  });
  const rows = [scope.text, input.instruction, input.layoutNote].flatMap(text => text.split(/[。；;\n]/u)).map(text => text.trim()).filter(Boolean);
  // A manual font selection overrides font evidence rows too: otherwise the prompt carries
  // both the old and the new font reference numbers as contradictory instructions.
  const manualFont = input.fontReference?.origin === 'manual' ? input.fontReference : null;
  const requirements: ArtworkRequirementContract['requirements'] = [];
  for (const text of [...new Set(rows)]) for (const category of requirementCategories(text)) {
    const evidence = manualFont && /字体|字形/u.test(text)
      ? text.replace(/((?:字体|字形)[^\n。；;]{0,12}?)(图(?:[1-9]\d*|[一二三四五六七八九十]+))/gu, `$1${normalizeImageLabels(manualFont.label)}`)
      : text;
    requirements.push({ id: `r${requirements.length + 1}`, category, evidence });
  }
  if (input.exactText?.trim()) requirements.push({ id: `r${requirements.length + 1}`, category: 'text', evidence: `准确新增文字：${input.exactText}` });
  const uniqueIssues = issues.filter((issue, i) => issues.findIndex(other => other.code === issue.code && other.imageLabel === issue.imageLabel) === i);
  const contract: Omit<ArtworkRequirementContract, 'key'> = { version: REQUIREMENTS_VERSION, logicVersion: WORKWEAR_LOGIC_VERSION, sourceText: input.sourceRequirementText ?? '',
    scopedSource: scope.text, instruction: input.instruction, layoutNote: input.layoutNote, exactText: input.exactText ?? '',
    generationPrompt: input.generationPrompt ?? '', dependencies, inputs, requirements, issues: uniqueIssues };
  return { ...contract, key: canonicalJson(contract) };
}
export function dependencyIssues(input: RequirementInput): string[] { return compileArtworkRequirements(input).issues.map(issue => issue.message); }
export function contentImageLabels(input: RequirementInput): string[] {
  return compileArtworkRequirements(input).inputs.filter(image => image.roles.includes('content')).map(image => image.sourceLabel);
}
export function compiledRequirementPrompt(contract: ArtworkRequirementContract): string {
  return ['【当前印花位置的执行要求；保留原文证据】',
    ...contract.inputs.map(image => `输入${image.inputLabel} = WPS ${image.sourceLabel}；用途：${image.roles.map(role => ({ content: '必须进入成品的内容素材', font: '仅参考指定字体', color: '仅参考指定配色', layout: '仅参考指定排版', reference: '按本位置要求使用的参考素材' })[role]).join('、')}`),
    ...contract.requirements.map(item => `[${item.id}/${item.category}] ${item.evidence}`),
    '不要把字体或颜色参考图中的无关文字、人物、衣服、场景当成成品内容。准确文字、保留区和局部改色范围均以本位置原文与明确修改为依据。'].join('\n');
}
export function fullArtworkContentKey(unit: { sourceRecordId: string; materialId: string | null; referenceMaterialIds: string[]; sourceScope: string;
  fontReference?: unknown; textMode: unknown; exactText: string; layoutNote: string; instruction: string; generationPrompt?: string; sourceAssessment?: unknown;
  variantLabel: string; route: string; artworkMethod?: string; cutoutMode?: string }): string {
  return canonicalJson({ recordId: unit.sourceRecordId, materialId: unit.materialId, references: unit.referenceMaterialIds,
    sourceScope: unit.sourceScope, fontReference: unit.fontReference, textMode: unit.textMode, exactText: unit.exactText,
    layoutNote: unit.layoutNote, instruction: unit.instruction, generationPrompt: unit.generationPrompt ?? '', sourceAssessment: unit.sourceAssessment,
    variantLabel: unit.variantLabel, route: unit.route, method: unit.artworkMethod ?? 'auto', cutout: unit.cutoutMode ?? 'auto' });
}
export function artworkBusinessStep(key: string, stage: string): string {
  if (key.startsWith('final-review')) return '核对最终图案';
  if (key.startsWith('verifyText')) return '核对文字与字体';
  if (key.startsWith('verifyEdits')) return '核对局部修改';
  if (key.startsWith('inspectSource')) return '识别素材与取材范围';
  if (key.startsWith('referenceColor')) return '读取指定参考色';
  if (key.startsWith('measurePixels')) return '读取图案像素';
  if (key.includes('enhance-image')) return '图案保真增强';
  if (key.includes('download')) return '下载处理结果';
  if (key.startsWith('fidelity')) return '保真处理';
  if (key.startsWith('layout')) return '组合与排版';
  if (key.startsWith('cutout')) return '去除外围背景';
  if (key.startsWith('generate')) return '生成图案';
  return ({ generation: '生成图案', cutout: '去除外围背景', quality: '画质参考', inspection: '内容核对', processing: '图像处理' } as Record<string, string>)[stage] ?? '处理步骤';
}
export function safeErrorText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return text.replace(/https?:\/\/[^\s\]）)]+/gu, '[素材地址已隐藏]')
    .replace(/(?:Bearer\s+)[\w.\-]+/giu, 'Bearer [已隐藏]')
    .replace(/((?:token|secret|api[_-]?key|password|signature)\s*[=:]\s*)[^\s,;]+/giu, '$1[已隐藏]').slice(0, 2000);
}
export function recoveryForJob(job: { status: string; candidate?: { retryable?: boolean; stage?: string; cutout?: { status: string; candidate?: unknown } } | null;
  steps?: Array<{ stage: string; status: string; stepKey?: string; error?: string | null }>; error?: string | null; recheckAvailable?: boolean }): { action: RecoveryAction; label: string; mayCharge: boolean; reason: string } {
  if (job.status === 'unknown' || job.steps?.some(step => step.status === 'unknown')) return { action: 'verifySubmission', label: '核实原供应商任务', mayCharge: false, reason: '提交结果不确定，禁止自动重复付费' };
  if (['queued', 'running'].includes(job.status)) return { action: 'wait', label: '查看进度', mayCharge: false, reason: '已有任务正在处理' };
  if (job.status === 'completed') return { action: 'none', label: '图稿已保存', mayCharge: false, reason: '图稿保存与衣服合成分别管理' };
  const latestCutout = job.steps?.filter(step => step.stage === 'cutout').at(-1);
  const cutoutFailure = job.candidate?.cutout?.status === 'failed' || latestCutout?.status === 'failed'
    && /未通过检查|过于透明|主体面积不足|透明背景不足|疑似丢失|图案检查|半透明/u.test(latestCutout.error ?? job.error ?? '');
  if (cutoutFailure) return { action: 'changeCutoutMethod', label: '查看候选并调整抠图方式', mayCharge: true, reason: '旧抠图任务已经明确失败，普通续做不会产生新结果；保留原图，仅显式更换处理方式后新建尝试' };
  if (job.status === 'review' && !job.recheckAvailable) return { action: 'editRequirements', label: '核对图案和修改要求', mayCharge: false, reason: '不能把内容问题当作网络错误反复重试' };
  if (job.status === 'failed' || job.recheckAvailable) return { action: 'retry', label: job.recheckAvailable ? '复查已生成图片' : '继续未完成步骤',
    mayCharge: !job.steps?.some(step => step.stage === 'generation' && step.status === 'completed'), reason: '已完成步骤复用；未知付费提交不重提' };
  return { action: 'none', label: '暂无可恢复步骤', mayCharge: false, reason: '' };
}
export function isActiveSourceStatus(value: string | null | undefined): boolean {
  return ['待领取', '设计中'].includes((value ?? '').replace(/[🔴🟢\s]/gu, ''));
}
export function assertActiveSourceStatus(value: string | null | undefined): void {
  if (!isActiveSourceStatus(value)) throw new Error('当前WPS状态不允许开始新的自动制作；仅待领取、设计中可以制作');
}

const SOURCE_MARKER = '\n【系统传递：当前印花位置原文】\n';
/** The authored execution instruction, without the appended source-evidence section. */
export function authoredArtworkInstruction(instruction: string): string {
  return instruction.split(SOURCE_MARKER)[0];
}
/** Idempotent: the server and preview compiler see precisely the same request. */
export function withSourceRequirements<T extends RequirementInput>(input: T): T {
  const baseInstruction = input.instruction.split(SOURCE_MARKER)[0];
  const scope = scopedSourceRequirement(input.sourceRequirementText ?? '', input.printPlacement?.key, input.primaryImageLabel);
  if (!scope.text.trim() || scope.ambiguous) return input;
  // The execution source typically already lives verbatim in the instruction. Appending it
  // again duplicates edit clauses and misleads clause-counting editors (e.g. artworkModelEdits
  // treats the duplicate as two separate paid edit requests).
  const normalizedScope = normalizeImageLabels(scope.text.trim());
  if (normalizeImageLabels(baseInstruction).includes(normalizedScope)) return input;
  const executionSource = input.fontReference?.origin === 'manual' ? scope.text.split(/[，,。；;\n]/u).map(clause => {
    const deps = imageDependencies(clause);
    return deps.length && deps.every(dep => dep.role === 'font')
      ? `字体采用人工明确指定 ${input.fontReference!.label}：${input.fontReference!.description ?? ''}` : clause;
  }).join('；') : scope.text.trim();
  const instruction = `${baseInstruction}${SOURCE_MARKER}${executionSource}`;
  return instruction === input.instruction ? input : { ...input, instruction };
}
export function requirementDiff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter(key => canonicalJson(before[key] ?? null) !== canonicalJson(after[key] ?? null))
    .map(key => ({ field: key, before: before[key] ?? null, after: after[key] ?? null }));
}
export const editableRequirementFields = ['materialId', 'referenceMaterialIds', 'sourceScope', 'textMode', 'exactText', 'instruction', 'layoutNote', 'generationPrompt', 'fontReference'] as const;
export function editableRequirements(value: object): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  return Object.fromEntries(editableRequirementFields.map(field => [field, record[field] ?? null]));
}
export function sanitizeAssetIdentity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith('/api/')) return raw.split('?')[0];
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol)) return '[非公开素材]';
    for (const key of [...url.searchParams.keys()]) if (/^(?:expires|kssaccesskeyid|signature|response-cache-control|x-oss-|x-amz-)/iu.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return raw.startsWith('data:') ? '[内嵌图像]' : '[本地素材]'; }
}
