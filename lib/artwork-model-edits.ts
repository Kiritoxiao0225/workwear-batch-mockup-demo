/** Edits to regions of an existing bitmap cannot use the single-colour graphic mask. */
export function artworkModelEdits(input: { instruction: string; exactText: string }) {
  const clauses = input.instruction.split(/[，,。；;\n]/u).map(value => value.trim()).filter(Boolean);
  const changing = /改(?:成|为|色)|换(?:成|为|色)|变成|调(?:整|浅|深|亮|暗)|变(?:浅|深|亮|暗)|提亮|压暗|加深|淡化|减淡/u;
  const colour = /色|#[0-9a-f]{6}|调浅|调深|变浅|变深|提亮|压暗|加深|淡化|减淡/iu;
  const directColourChange = /(?:改|换|变)(?:成|为)?\s*(?:#[0-9a-f]{6}|深|浅|红|蓝|绿|白|黑|黄|橙|紫|灰|粉|银|金)/iu;
  const region = /描边|轮廓|边线|红线|底形|底色|字面|填充|阴影|投影|渐变|纹理|局部|其中|分别/u;
  const edits = clauses.filter(clause => !/(?:不要|无需|不需要|不得|禁止|不能|不改|不换|保持不变)/u.test(clause)
    && (changing.test(clause) && colour.test(clause) || directColourChange.test(clause)));
  // Text or regions named after "改为图N" describe the color source, not the part of our logo to edit.
  const targets = edits.map(clause => clause.split(/(?:改成|改为|换成|换为)\s*(?:WPS\s*)?图(?:片)?\s*(?:\d+|[一二三四五六七八九十]+)/iu)[0]);
  const bitmapTargets = targets.filter(clause => !input.exactText.trim() || !/文字|字体|字色/u.test(clause) || region.test(clause));
  const requiresModel = bitmapTargets.some(clause => region.test(clause)
    || /调浅|调深|变浅|变深|提亮|压暗|加深|淡化|减淡/u.test(clause)
    || (!input.exactText.trim() && /文字|字体|字色|主字/u.test(clause))) || bitmapTargets.length > 1;
  return requiresModel ? edits : [];
}

/** Foreground removal is a component edit inside composition, not background
 * removal or permission to redraw the whole design. Text replacement has its
 * own contract. Reference-only images never become editable content. */
export function artworkGraphicRemovals(input: { instruction: string; layoutNote: string; exactText: string; primaryImageRole?: string }) {
  if (input.primaryImageRole === 'reference') return [];
  const text = `${input.instruction}\n${input.layoutNote}`;
  const clauses = (input.exactText.trim() ? text.replaceAll(input.exactText, '') : text).split(/[，,。；;\n]/u).map(value => value.trim()).filter(Boolean);
  return [...new Set(clauses.filter(clause => {
    const removal = /删除|删掉|去掉|去除|移除|清除|擦除|抹掉|不保留/u.exec(clause);
    if (!removal) return /(?:只|仅)保留.{0,16}外轮廓/u.test(clause) && !/不要|无需|禁止|不能/u.test(clause);
    if (/(?:不要|无需|不需要|不得|禁止|不能|不再|不必|不)[^，。；]*$/u.test(clause.slice(0, removal.index))) return false;
    const targets = clause.slice(removal.index + removal[0].length).split(/(?:并|同时|但|然后)/u)[0].split(/[、和及与或]/u).map(value => value.trim()).filter(Boolean);
    // These are handled by cutout or the existing replace-text step.
    const backgroundOrText = /^(?:图\s*[一二三四五六七八九十\d]+(?:的)?|(?:图案|Logo|标志)(?:的)?)?(?:原有|原|旧|画布|外围|白色|黑色|纯色|透明|衣服|衣料|织物|拍摄|素材|图片|照片|图案)*\s*(?:背景|底色|白底|黑底|透明棋盘格|水印|文字|字|文案)$/iu;
    return targets.some(target => /眼睛|嘴巴|嘴|鼻子|五官|表情|内部|里面|中间|中心|装饰|图形|图案|星星|星形|花纹|符号|圆点|小点/u.test(target) && !backgroundOrText.test(target)
      && !/背景|底色|白底|黑底|棋盘格|水印|文字|字体|文案|旧字|白边|毛边|锯齿|噪点|^衣服$|^衣料$|^织物$/u.test(target));
  }))];
}

export function artworkGraphicRemovalPrompt(requirements: string[], exactText: string, wholeImage: boolean) {
  return [
    '这是图文组合中的局部删除步骤。输入图1是唯一内容源，只删除客户明确指定的内部元素，保留原设计。',
    `逐项删除范围：${JSON.stringify(requirements)}`,
    `后续由程序排版的新增文字为 ${JSON.stringify(exactText)}，本步骤不绘制新增文字。`,
    '原图的数量、外轮廓、未指定删除的文字、图形、颜色、尺寸比例与相对位置保持不变；不复制、不重新设计图案，不新增装饰。',
    wholeImage ? '保留原画布及背景，只清除指定前景元素。' : '输出相同画布的纯白背景 PNG，不绘制棋盘格或阴影。',
  ].join('\n');
}

export function artworkGraphicRemovalChecks(requirements: string[], exactText: string, wholeImage: boolean) {
  return [...requirements.map(requirement => `指定局部删除已完成：${requirement}。`),
    `未指定删除的图形、文字、外轮廓、配色、数量和相对位置保持原样，没有复制 Logo 或新增元素。${wholeImage ? '原背景与原画布保持原样。' : '外围白色画布可去除，内部设计颜色保留。'}`,
    ...(exactText.trim() ? [`没有提前绘制目标文字 ${JSON.stringify(exactText)}；目标文字由后续排版步骤添加。`] : []),
  ];
}

export const ARTWORK_EDIT_INSPECTION_VERSION = 'artwork-edit-inspection-v3';
export const ARTWORK_TEXT_INSPECTION_VERSION = 'artwork-text-inspection-v2';
export type ArtworkEditCheck = { requirement: string; status: 'passed' | 'failed' | 'uncertain'; evidence: string;
  category?: import('./artwork-review-policy').ArtworkReviewCategory;
  impact?: import('./artwork-review-policy').ArtworkReviewImpact;
  sourceObservation?: string | null; resultObservation?: string | null };
type ArtworkInspectionReceipt = { inspectionVersion?: string; promptSha256?: string; inputSha256?: string[]; requestAttempts?: number };
export type ArtworkEditVerification = {
  version: 'artwork-edit-check-v1';
  sourceSha256: string;
  outputSha256: string;
  model: string;
  checks: ArtworkEditCheck[];
  flatnessEvidence?: import('./server/artwork-flatness-evidence').ArtworkFlatnessEvidence;
} & ArtworkInspectionReceipt;

export type ArtworkTextComponentVerification = {
  version: 'artwork-text-component-v1';
  outputSha256: string;
  targetText: string;
  recognizedText: string | null;
  model: string;
  status: 'passed' | 'failed' | 'uncertain';
  evidence: string;
} & ArtworkInspectionReceipt;
