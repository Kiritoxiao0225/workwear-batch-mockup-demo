export type ArtworkSolidColor = { requirement: string; color: string };
export type ArtworkColorRequirements = { instruction: string; layoutNote: string; generationPrompt?: string; exactText?: string };

/** Only an explicit whole-artwork instruction authorizes flattening every foreground pixel. */
export function artworkSolidColor(input: ArtworkColorRequirements): ArtworkSolidColor | null {
  const text = [input.instruction, input.layoutNote, input.generationPrompt ?? ''].join('\n');
  const clauses = (input.exactText ? text.replaceAll(input.exactText, '') : text).split(/[，,。；;\n]/u);
  const active = clauses.filter(clause => !/(?:不要|不用|无需|不需要|不得|禁止|不能|不加|不带|去除|消除)/u.test(clause));
  if (active.some(clause => /(?:保留|保持|使用|采用|带有).{0,12}(?:渐变|多色|双色|白色分隔|白色细节|金属质感)/u.test(clause))) return null;
  const colors = new Map<string, ArtworkSolidColor>();
  for (const clause of active) {
    const match = clause.match(/(?:整组(?:图案)?|整个(?:图案|标志|Logo)|全部(?:图案|印花)|所有(?:图形和文字|文字和图形)|整幅图案|整体图案|整张图案|图案整体)(?:均|都)?\s*(?:(?:维持|保持|使用|采用|为|是|填充为|改为|改成)\s*)?(?:统一(?:的)?|单一(?:的)?|单色|纯色)\s*(#[0-9a-f]{6}|金黄色|金色|黄色|橙色|红色|绿色|蓝色|紫色|粉色|黑色|白色|灰色)/iu);
    if (!match) continue;
    const color = match[1].toLowerCase().replace(/^金黄色$/u, '黄色');
    colors.set(color, { requirement: clause.trim(), color });
  }
  return colors.size === 1 ? [...colors.values()][0] : null;
}
