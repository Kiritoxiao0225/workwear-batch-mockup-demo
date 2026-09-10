import { requestedArtworkColor } from './artwork-editor';
import type { ProductionUnit } from './wps-production';
/** Only explicit ink instructions count; garment labels and the printed words are not ink requests. */
export function requestedProductionTextColor(unit: Pick<ProductionUnit, 'exactText' | 'instruction' | 'layoutNote'>) {
  const text = `${unit.layoutNote}\n${unit.instruction}`.replaceAll(unit.exactText, '');
  const tokens = '(#[0-9a-fA-F]{6}|深蓝|藏蓝|大红|玫红|绿色|蓝色|金色|黄色|橙色|粉色|紫色|灰色|红色|黑色|白色|红|黑|白)';
  for (const clause of text.split(/[。；;\n]/u)) {
    const match = clause.match(new RegExp(`(?:文字颜色|字体颜色|文字|字色|颜色|印花|字)[ \t]*(?:(?:用|使用|为|设为|改为|改成|做成|做|是|[:：])[ \t]*){0,3}${tokens}`, 'u'))
      ?? clause.match(new RegExp(`${tokens}(?:的)?(?:文字|字)`, 'u'));
    if (!match) continue;
    const value = match[1];
    if (['黑', '黑色'].includes(value)) return '#000000';
    if (['白', '白色'].includes(value)) return '#ffffff';
    if (['红', '红色'].includes(value)) return '#ff0000';
    return requestedArtworkColor(value);
  }
  return null;
}
