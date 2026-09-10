import type { ArtworkEditCheck, ArtworkEditVerification } from './artwork-model-edits';

export const ARTWORK_REVIEW_POLICY_VERSION = 'artwork-review-v2';
export type ArtworkReviewCategory = 'text' | 'color' | 'flatness' | 'structure' | 'layout' | 'background' | 'other';
export type ArtworkReviewImpact = 'none' | 'minor' | 'material' | 'unknown';

/** Severity controls the warning order, never whether the generated image survives.
 * Keep legacy failures visible without presenting them as a passed inspection. */
export function artworkMaterialIssue(check: ArtworkEditCheck) {
  if (check.status !== 'failed') return false;
  if (!check.impact || !check.category) return true;
  return check.impact === 'material' && ['text', 'color', 'flatness', 'structure', 'background'].includes(check.category);
}

export function artworkReviewDecision(verification: ArtworkEditVerification) {
  const issues = verification.checks.filter(artworkMaterialIssue);
  const reminders = verification.checks.filter(check => (check.status !== 'passed' || check.impact === 'minor') && !artworkMaterialIssue(check));
  const warnings = [...issues, ...reminders];
  const messages = (checks: ArtworkEditCheck[]) => [...new Set(checks.map(check => check.evidence.trim()
    .replace(/\bSOURCE\b/giu, '原图').replace(/\bRESULT\b/giu, '这次图案').replace(/[。；;\s]+$/u, '')))];
  return { version: ARTWORK_REVIEW_POLICY_VERSION, issues, warnings,
    issueMessages: messages(issues), warningMessages: messages(warnings) };
}

/** Compile one check per concern; the complete brief is context, not another
 * duplicate preservation requirement that reports the same fault five times. */
export function reconstructionReviewRequirements(target: string, brief: string) {
  return [
    `文字内容：只核对目标“${target}”内可辨文字是否错字、漏字、多字。以下为完整制作背景，仅据此确定本项要求，不重复评价其他项：${brief}`,
    '标志结构：只核对目标图形是否缺失、增加或换成另一种图形；微小轮廓、笔画粗细、抗锯齿和原图看不清的细节单独记为提醒。',
    '图案配色：保留目标前景原色，执行明确的改色要求；衣服、配色板和临时抠图背景不是图案配色依据。',
    '相对排版：检查元素顺序、居中关系及文字与标志的相对大小；先消除整图缩放、留白、拍摄透视影响。一般比例和间距变化记为提醒，元素缺失或顺序错误归入标志结构。',
    '载体残留：检查是否夹带衣服、布料、人物、场景或额外背景。去掉载体、消除拍摄形变和换成透明背景均为预期处理。',
  ];
}
