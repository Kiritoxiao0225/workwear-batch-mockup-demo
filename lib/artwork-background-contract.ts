/** Background scope is not a colour. White lettering and a white canvas are
 * different objects; unspecified inner whites must never become an invented requirement. */
export const ARTWORK_BACKGROUND_VERSION = 'artwork-background-v1';
export type ArtworkBackgroundScope = 'legacy' | 'exterior' | 'all-background' | 'preserve' | 'ambiguous';
export type ArtworkBackgroundContract = {
  version: typeof ARTWORK_BACKGROUND_VERSION;
  scope: ArtworkBackgroundScope;
  evidence: string[];
  preserveWhiteArtwork: boolean;
};
export type ArtworkBackgroundInput = {
  instruction: string; layoutNote?: string; generationPrompt?: string; sourceScope?: string;
};

export function artworkBackgroundContract(input: ArtworkBackgroundInput): ArtworkBackgroundContract {
  // The current unit's authored requirement outranks an old generated staging prompt.
  const authored = `${input.instruction}\n${input.layoutNote ?? ''}`.split('\n【系统传递：当前印花位置原文】\n')[0];
  const resolve = (text: string) => {
    const clauses = text.split(/[，,。；;\n]/u).map(value => value.trim()).filter(Boolean);
    const active = clauses.filter(c => !/(?:不要|无需|不需要|不得|禁止|不能|不必).{0,6}(?:删除|去除|去掉|移除|抠|清除)/u.test(c));
    const all = active.filter(c => /(?:全部|所有|全图|内外|包含内部|包括内部).{0,12}(?:去底|去背景)|(?:全部|所有|全图|内外).{0,12}(?:背景|白底|底色).{0,10}(?:透明|去掉|去除|清除)|(?:去除|去掉|清除|移除).{0,8}(?:全部|所有|内外).{0,10}(?:背景|底色|白底)|(?:圆内|内部|圈内).{0,12}(?:也|全部|均|都).{0,8}(?:透明|去底|去除|去掉)|全去底/u.test(c));
    const exterior = clauses.filter(c => /(?:只|仅).{0,8}(?:去除|去掉|清除|移除|抠掉).{0,10}(?:外围|外部|画布边缘|外面)|(?:保留|保持|保护).{0,12}(?:徽章底色|圆内底色|内部底色|圆内白底|内部白底|内部留白)|(?:圆内|内部).{0,8}(?:底色|白底|背景).{0,8}(?:保留|不变)/u.test(c));
    const generic = active.filter(c => /去底|抠图|(?:去除|去掉|清除|移除).{0,12}(?:背景|白底|底色)/u.test(c));
    const preserveWhiteArtwork = clauses.some(c => /(?:保留|保持|保护).{0,24}(?:白字|白色文字|白色图形|白色轮廓|白色细节)/u.test(c) && !/不保留|不要保留/u.test(c));
    return { all, exterior, generic, preserveWhiteArtwork };
  };
  const direct = resolve(authored);
  const found = direct.all.length || direct.exterior.length || direct.generic.length
    ? direct : resolve(input.generationPrompt ?? '');
  const base: Omit<ArtworkBackgroundContract, 'scope'> = { version: ARTWORK_BACKGROUND_VERSION, evidence: [...found.all, ...found.exterior, ...found.generic], preserveWhiteArtwork: direct.preserveWhiteArtwork || found.preserveWhiteArtwork };
  if (found.all.length && (found.exterior.length || input.sourceScope === 'wholeImage')) return { ...base, scope: 'ambiguous' };
  if (found.all.length) return { ...base, scope: 'all-background' };
  if (input.sourceScope === 'wholeImage') return { ...base, scope: 'preserve' };
  if (found.exterior.length) return { ...base, scope: 'exterior' };
  if (found.generic.length) return { ...base, scope: 'ambiguous' };
  return { ...base, scope: 'legacy' };
}

export function artworkBackgroundRequirement(contract: ArtworkBackgroundContract): string {
  const foreground = '白色文字、白色轮廓、注册标记和客户底形属于前景，不得仅凭颜色删除。';
  switch (contract.scope) {
    case 'preserve': return `背景范围：明确整图保留，不执行去底；只修改客户指定内容。${foreground}`;
    case 'all-background': return `背景范围：明确全去底，已确定属于背景的内外底色（包括封闭区域）均应透明，不能通用恢复徽章内部底色。${foreground}无法区分白色图形与背景时保留疑点，不擅自挖空。`;
    case 'exterior': return `背景范围：仅去除外围背景，内部底色、内部留白与图形按原像素保留；不得要求圆内全部透明。${foreground}`;
    case 'ambiguous': return `背景范围待人工核查：没有明确区分内外背景，或保留与删除要求冲突。沿用历史外围去底及内部保护，不自动改成全去底；核对不得断言内部必须透明或必须不透明。${foreground}`;
    default: return `背景范围：沿用历史外围去底与徽章内部保护；原文未明确内部范围，不新增圆内全透明要求。${foreground}`;
  }
}
