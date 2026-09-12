/** The staging background is a removable technical surface, never a reason to
 * change the foreground ink. Existing saved briefs need the same normalization. */
export function artworkSeparationPrompt(prompt: string, preserveWholeImage = false) {
  if (prompt.includes('【整图背景保留】')) return prompt;
  if (preserveWholeImage) return `${prompt.split('\n【前景与临时底色】')[0]}\n【整图背景保留】本位置明确 sourceScope=wholeImage，画布与内部背景均属于要保留的内容；不更换临时底色、不执行去底。此范围优先于旧模板中的纯白背景或后续抠图说明。只修改客户点名内容；范围冲突保留疑点，不擅自重新选择背景。`;
  if (prompt.includes('【前景与临时底色】')) return prompt;
  const normalized = prompt
    .replace(/(?:纯白色?|白色|白底)\s*(?:背景|底色)(?:\s*[（(]?\s*#FFFFFF\s*[）)]?)?/giu, '与全部前景可分离的纯色临时背景')
    .replace(/(?:背景|底色)(?:为|是|采用|使用|[:：])?\s*(?:纯白色?|白色|#FFFFFF)(?:\s*[（(]?\s*#FFFFFF\s*[）)]?)?/giu, '背景使用与全部前景可分离的临时纯色');
  return `${normalized}\n【前景与临时底色】仅改变画布底色来方便后续去底，不能为看清图案而改变任何前景颜色。先保留目标文字、标志的真实配色；若含白色或近白前景，选择不与任何前景混淆的中灰、深灰或其他纯色背景，禁止白字变深色、增加描边或阴影。没有白色前景时可用白底。临时背景不是成品内容，后续会去掉。\n【参考取材】只使用当前制作位置对应的目标及其局部放大图；衣服颜色、配色板、设计说明和其他位置的相似标识不能替代目标图案。`;
}
