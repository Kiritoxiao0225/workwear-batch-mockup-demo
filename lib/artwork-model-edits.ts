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

export type ArtworkEditCheck = { requirement: string; status: 'passed' | 'failed' | 'uncertain'; evidence: string };
export type ArtworkEditVerification = {
  version: 'artwork-edit-check-v1';
  sourceSha256: string;
  outputSha256: string;
  model: string;
  checks: ArtworkEditCheck[];
};
