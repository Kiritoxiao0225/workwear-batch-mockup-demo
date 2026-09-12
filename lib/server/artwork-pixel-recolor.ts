import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { assertArtworkMask } from './artwork-panel-mask';

type RecolorRequest = { instruction: string; layoutNote?: string; exactText?: string; generationPrompt?: string;
  primaryImageRole?: string; referenceImages?: unknown[]; correction?: unknown; fontReference?: unknown };

/** Deliberately narrow: a single global foreground colour, no shape/text/style edit.
 * An opaque white area is not evidence of a negative space. Such inputs do not
 * qualify; they continue through explicit cutout/integrity review. */
export function pixelRecolorTarget(input: RecolorRequest): [number, number, number] | null {
  if (input.exactText?.trim() || input.referenceImages?.length || input.correction || input.fontReference || input.primaryImageRole === 'reference') return null;
  const text = `${input.instruction.split('\n【系统传递：当前印花位置原文】\n')[0]}\n${input.layoutNote ?? ''}`;
  if (/重新设计|重绘|重新排版|加粗|变细|增加|添加|删除|替换.{0,8}(?:文字|字体)|改字|渐变|调浅|调深|发光|阴影|左边改|右边改|上方改|下方改/u.test(text)) return null;
  if (/(?:不要|无需|不得|禁止|不能|不必|不需要)[^，,。；;\n]{0,20}(?:改|换|统一)|(?:仅|只)(?:将|把)?(?:文字|字面|描边|底形|轮廓)|(?:左侧|右侧|上半|下半|局部).{0,8}(?:改|换)/u.test(text)) return null;
  const targets = [...text.matchAll(/(?:改成|改为|改|换成|换为|统一为|统一成|统一|变为)\s*(#[0-9a-fA-F]{6}|白色?|黑色?)/gu)].map(match => match[1]);
  if (!targets.length || new Set(targets.map(t => t.toLowerCase())).size !== 1) return null;
  if (!/(?:前景|图案|整体|整组|全部|所有|紫色|红色|黑色|蓝色|绿色|白色)/u.test(text)) return null;
  const target = targets[0];
  if (target.startsWith('#')) return [1, 3, 5].map(i => parseInt(target.slice(i, i + 2), 16)) as [number, number, number];
  return target.startsWith('白') ? [255, 255, 255] : [0, 0, 0];
}

export async function recolorArtworkPixels(source: Buffer, input: RecolorRequest) {
  const target = pixelRecolorTarget(input);
  if (!target) return null;
  const meta = await sharp(source).metadata();
  if (!meta.hasAlpha) return null;
  try { await assertArtworkMask(source); } catch { return null; }
  const { data, info } = await sharp(source).ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const opaque: number[][] = [[], [], []];
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] >= 240) for (let c = 0; c < 3; c++) opaque[c].push(data[i + c]);
  if (!opaque[0].length) return null;
  const median = opaque.map(values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]);
  let outsidePalette = 0, core = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] >= 240) {
    core++; if (Math.hypot(data[i] - median[0], data[i + 1] - median[1], data[i + 2] - median[2]) > 24) outsidePalette++;
  }
  // Even a small second design colour disables this path. Small compression noise
  // is tolerated, but never merged by adding/removing alpha or components.
  if (outsidePalette > Math.max(2, core * .001)) return null;
  const output = Buffer.from(data), alpha = Buffer.alloc(data.length / 4);
  let recoloredPixels = 0;
  for (let i = 0; i < output.length; i += 4) {
    alpha[i / 4] = data[i + 3];
    if (!data[i + 3]) continue;
    output[i] = target[0]; output[i + 1] = target[1]; output[i + 2] = target[2]; recoloredPixels++;
  }
  const bytes = await sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return { bytes, receipt: { version: 'pixel-recolor-v1', width: info.width, height: info.height, target,
    recoloredPixels, alphaSha256: createHash('sha256').update(alpha).digest('hex'), geometry: 'original-alpha-unchanged' } };
}
