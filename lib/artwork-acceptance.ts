import { ARTWORK_ROUTING_STANDARD, validArtworkClarity } from '@/lib/artwork-routing-standard';
import type { ArtworkValidation } from '@/lib/wps-production';

export function artworkQualityAdvice(validation: ArtworkValidation): string[] {
  const quality = validation.quality;
  const measurementIssues: string[] = [];
  if (validation.qualityError) measurementIssues.push(validation.qualityError);
  else if (!quality) measurementIssues.push('最终 PNG 尚未检测清晰度');
  else if (quality.protocol !== ARTWORK_ROUTING_STANDARD.scoreProtocol) measurementIssues.push('旧检测曾将模糊度当作清晰度，请重新检测画质；无需重新制作图案');
  else {
    const clarity = validArtworkClarity(quality);
    if (quality.sha256 !== validation.sha256) measurementIssues.push('评分不属于当前 PNG，请重新检测画质');
    if (clarity === null) measurementIssues.push('清晰度评分无效，请重新检测画质');
    else if (clarity < ARTWORK_ROUTING_STANDARD.clarityMinimum) measurementIssues.push(`模糊检查未通过：换算清晰度 ${clarity.toFixed(2)}，要求 ≥${ARTWORK_ROUTING_STANDARD.clarityMinimum}`);
    if (!Number.isFinite(quality.requiredScale) || quality.requiredScale <= 0) measurementIssues.push('有效像素检测无效，请重新检测画质');
    else if (quality.requiredScale > ARTWORK_ROUTING_STANDARD.directScaleMaximum) measurementIssues.push(`有效像素不足：放大到 ${ARTWORK_ROUTING_STANDARD.targetLongEdge}px 需 ${quality.requiredScale.toFixed(2)} 倍，超过 ${ARTWORK_ROUTING_STANDARD.directScaleMaximum} 倍`);
  }
  return [
    ...(validation.contentWarnings ?? []),
    ...(!validation.valid ? validation.issues : []),
    ...measurementIssues,
    // Old text was derived from the reversed metric. Preserve it in storage, but request a fresh check.
    ...(quality?.protocol === ARTWORK_ROUTING_STANDARD.scoreProtocol ? validation.qualityIssues ?? [] : []),
  ];
}

/** Cloud scores are optional advice. Only concrete file/content failures block confirmation. */
export function artworkAcceptanceIssues(validation: ArtworkValidation): string[] {
  return [...(!validation.valid ? validation.issues : []), ...(validation.contentIssues ?? []),
    ...(validation.qualityIssues ?? []).filter(issue => /(?:重绘未完成|特殊字形尚未生成|文字仅为.*占位|缺少|文件.*变化)/u.test(issue))];
}

/** Refreshing alpha/OCR/placement must not discard a score bound to the same file. */
export function retainArtworkQuality(previous: ArtworkValidation, fresh: ArtworkValidation): ArtworkValidation {
  return previous.sha256 === fresh.sha256 ? { ...fresh, quality: previous.quality, qualityError: previous.qualityError, qualityIssues: previous.qualityIssues, componentQuality: previous.componentQuality, contentIssues: previous.contentIssues, contentWarnings: previous.contentWarnings } : fresh;
}
