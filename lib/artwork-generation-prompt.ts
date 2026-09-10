export const GENERATION_PROMPT_WRITING_RULES = `每个单元必须输出 generationPrompt：一份可直接用于生图的完整提示词正文，约 150–800 字，最长 4000 字。
直接面向生图模型说明要制作什么、取用哪张图的什么内容、参考哪张图的哪个区域和哪些可见特征、替换什么、保留什么。正文统一使用 WPS 图N 指代原图，图片对应关系由程序标明，不要自己把原图重新编号。
实际观察参考图后，把客户希望仿照的字形、相对大小、排列和间距写清楚。客户只写“参考样式”时，结合该制作位置理解参考区域；不复述“仅作参考、不进入成品”来代替视觉要求。人物、衣服、其他位置的印花及背景不得复制到图案，衣服颜色不等于印花颜色。提取 Logo 时，素材图用于衬托 Logo 的纯色矩形背景应去除，不作为印花底板；只有原文明确要求保留底块，或底块确属标识结构时才保留。
原文明示的准确文字、素材内容、改色与取材范围必须保留。参考“字体颜色”只约束所指文字，不代表将内容素材里的标识或整组图案一起改色；未被明确要求改色的 Logo 保持主要素材原色。尺寸只有原文明示单位时才沿用；裸数字不得擅自补成 cm、mm 等单位，应把单位问题写入 ambiguities，正文不将该数字转换为已确定的物理尺寸。未给出具体字号或间距时，参照样式合理排版并适配目标印花位置；不追加“原文未说明尺寸”等无助于执行的说明。无法看清的细节不要编造，不猜测或复述参考图中不进入成品的校名或品牌；只有影响目标内容正确性的疑问写入 ambiguities。
最终生成的是独立二维完整图案，纯白背景（#FFFFFF）的 PNG，供后续独立抠图；不生成衣服、场景、阴影、模拟透明棋盘格、额外校徽、水印或说明。保留原标识的文字和细节，不擅自把整组图案改成衣服颜色。
临时画布底色由制作流程自动选择，不是需要用户决策的印花配色。如果前景为白色或接近白色，选用与全部前景不同的灰色或其他纯色临时背景，保留前景原色；不得为满足白底而把白字改深、加阴影或描边，也不因此新增 ambiguities。后续仅去掉临时背景。
制作方式必须按客户实际需求区分：沿用原图先 A 保真，保真增强仍不够且满足条件才 B 重绘；原 Logo 加字、换色或局部组合为 C；重新设计完整图案或参考图决定整组构图才 D。不得因存在提示词、素材小或仅参考单个文字字体就判为整图生成。
instruction 必须保留所有可执行操作：原图保留、局部取材、加字、换色及作用范围。textMode 与 exactText 记录准确新增文字，layoutNote 保留实际观察得到的参考区域、字形和排版要求；这些字段用于 A／B／C 的执行，不能压缩为缺失操作的摘要，也不能用固定模板覆盖视觉观察。generationPrompt 是模型步骤使用的正文，存在该字段不改变制作分类。`;

export function parseGenerationPrompt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > 4000) throw new Error('generationPrompt 必须是 4000 字以内的生图提示词');
  return value.trim() || undefined;
}

/** Only label the attached files; never rewrite or append visual requirements. */
export function compileGenerationPrompt(value: string, images: Array<{ sourceLabel: string; modelInputLabel: string; role: 'content' | 'reference' }>) {
  const text = parseGenerationPrompt(value);
  if (!text) throw new Error('请先整理生图提示词');
  const labels = new Set(images.map(image => image.sourceLabel));
  for (const match of text.matchAll(/图\s*([1-9][0-9]*)/gu)) {
    if (!labels.has(`图${Number(match[1])}`)) throw new Error(`生图提示词引用了未附上的图${Number(match[1])}，请核对输入图片`);
  }
  return [
    '【输入图片对应关系】正文图号均为 WPS 原图号。',
    ...images.map(image => `输入${image.modelInputLabel} = WPS ${image.sourceLabel}（${image.role === 'content' ? '内容素材' : '参考素材'}）`),
    '', text,
  ].join('\n');
}
