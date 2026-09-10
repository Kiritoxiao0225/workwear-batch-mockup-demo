/** The legacy textMode=replace also means addition. Resolve the operation from
 * this unit's requirement, never from another variant or the whole WPS row. */
export type ArtworkTextInput = { instruction: string; layoutNote: string; exactText: string; primaryImageRole?: 'content' | 'reference'; sourceScope?: string };
export type ArtworkTextOperation = 'none' | 'add' | 'replace';

export function artworkTextOperation(input: ArtworkTextInput): ArtworkTextOperation {
  if (!input.exactText.trim()) return 'none';
  if (input.primaryImageRole === 'reference') return 'add';
  const target = input.exactText.replace(/\s/gu, '');
  const clauses = `${input.instruction}\n${input.layoutNote}`.split(/[，,。；;\n]/u).map(value => value.trim());
  const negated = (prefix: string) => /(?:不要|无需|不需要|不得|禁止|不能|不再|不必|不)[^，。；]*$/u.test(prefix);
  const replacement = clauses.some(clause => {
    const removal = /(?:删除|删掉|去掉|去除|移除|清除).{0,12}(?:原文字|原有文字|旧文字|原字|旧字|原文案)/u.exec(clause);
    if (removal && !negated(clause.slice(0, removal.index))) return true;
    const change = /(?:替换(?:成|为)?|更换为|换(?:成|为)|改(?:成|为))/u.exec(clause);
    if (!change) return false;
    const before = clause.slice(0, change.index), after = clause.slice(change.index + change[0].length).replace(/\s/gu, '');
    if (negated(before)) return false;
    // Changing font/colour is not permission to erase existing lettering.
    if (/(?:字体|字形|字色|颜色|配色|描边|笔画|字号)/u.test(before) && !/(?:原文字|旧文字|原字|旧字)/u.test(before)) return false;
    return after.includes(target) || /原(?:有)?文字|旧文字|原字|旧字|原文案/u.test(`${before}${after}`);
  });
  return replacement ? 'replace' : 'add';
}

/** Only bounded typography attributes enter a text-component prompt. Freeform
 * logo descriptions and the full composition instruction never enter it. */
export function artworkTextStyle(input: ArtworkTextInput) {
  const clauses = `${input.instruction}\n${input.layoutNote}`.split(/[，,。；;\n]/u);
  const relevant = clauses.filter(clause => /文字|字体|字形|字色|笔画|书法|手写|楷体|宋体|黑体|字距|行距/u.test(clause)
    && !/(?:不要|无需|不需要|不得|禁止|不能)/u.test(clause));
  const text = relevant.join('\n');
  const styles = text.match(/抖音美好体|Douyin Sans|Noto Sans SC|微软雅黑|思源黑体|思源宋体|黑体|宋体|楷体|隶书|行书|草书|篆书|书法|手写|圆角|方正|几何|粗重|粗体|加粗|细体|笔画厚实|紧凑|斜体|立体|描边/giu) ?? [];
  const colors = relevant.flatMap(clause => {
    // A description of the house/shield colour is not a text-colour request.
    if (/盾牌|房屋|外框|图形|图标|Logo/iu.test(clause) && !/文字.{0,30}(?:色|#[\da-f]{6})|字色|字体颜色/iu.test(clause)) return [];
    return clause.match(/#[\da-f]{6}\b|(?:深|浅)?(?:蓝|绿|红|黑|白|灰|黄|橙|紫|粉|金|银)色/giu) ?? [];
  });
  const spacing = text.match(/(?:字距|行距|笔画宽度|描边宽度)\s*[:：]?\s*\d+(?:\.\d+)?\s*(?:px|像素|毫米|mm)/giu) ?? [];
  return { styles: [...new Set(styles)], colors: [...new Set(colors)], spacing: [...new Set(spacing)] };
}

export function artworkTextRemovalPrompt(input: ArtworkTextInput) {
  return [
    '这是制作过程中的去旧字步骤，输入图1为唯一内容源。只删除本制作单元明确要求替换的旧文字，不制作新文字。',
    `客户本单元的修改范围（只用于定位要删除的旧字）：${JSON.stringify(input.instruction)}`,
    `后续由程序添加的目标文字为 ${JSON.stringify(input.exactText)}；本步骤绝对不要绘制它，也不要绘制其他新文字。`,
    '只清除指定旧字；未被要求替换的品牌字、编号、注册标记等原文字必须保留。保留原有图形的数量、形状、内部结构、配色、位置与比例，不新增、不复制、不重新设计 Logo。',
    input.sourceScope === 'wholeImage'
      ? '输出一张去掉指定旧字后的完整图片，保持原画布、原背景及配色；原字区域按周围底色自然填补。空出的区域不新增装饰。'
      : '输出一张去掉指定旧字后的图案，画布与原图一致，纯白背景；空出的区域不新增装饰，不生成衣服、场景或水印。',
  ].join('\n');
}

export function artworkTextRemovalChecks(input: ArtworkTextInput) {
  return [
    `按本单元要求删除指定旧文字：${input.instruction}。本步骤只检查指定旧字已经消失；暂时不需要出现新文字。`,
    `没有提前添加目标文字 ${JSON.stringify(input.exactText)}，没有新增其他文字；未被指定替换的原文字、品牌字、编号与注册标记仍与原图一致。`,
    `原图的 Logo 图形数量、形状、内部结构、配色及相对位置保持一致，没有新增或重复图形。${input.sourceScope === 'wholeImage' ? '原背景与原画布也必须保留，只允许处理指定旧字区域。' : '只允许删除指定旧字、外围背景与无关来源水印。'}`,
  ];
}
