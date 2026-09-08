export function logoTextGuideLines(targetText: string) {
  const normalizedText = targetText.trim();
  if (!normalizedText) throw new Error('目标文字不能为空');
  return [normalizedText];
}
