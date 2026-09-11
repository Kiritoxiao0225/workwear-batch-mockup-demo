import type { ArtworkValidation } from '@/lib/wps-production';

export function artworkQualityAdvice(validation: ArtworkValidation): string[] {
  const quality = validation.quality;
  return [...(validation.contentWarnings ?? []), ...(!validation.valid ? validation.issues : []),
    ...(quality?.protocol === 'foreground-native-pixels-v1' && quality.requiredScale > 1
      ? [`当前主体 ${quality.subjectWidth}×${quality.subjectHeight}px，放大后细节可能不足，请人工核查`] : [])];
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
