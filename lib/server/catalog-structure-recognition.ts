import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Box } from '@/lib/catalog';
import type { StructurePoints } from './catalog-structure-estimate';

// Plain relative/type-only imports: the batch worker loads this file with Node's type stripping.
export const STRUCTURE_RECOGNITION_VERSION = 'seed-structure-v2';
export function structureRecognitionModel() { return process.env.CATALOG_PLACEMENT_MODEL?.trim() || process.env.VISION_MODEL_EP?.trim() || 'doubao-seed-2-0-lite-260215'; }

// The neck point and buttons sit inside the garment, where the outline says nothing. On 2026-09-25
// samples the model placed them well but guessed shoulders, so it is asked only for what the outline cannot give.
function prompt(face: 'front' | 'back', polo: boolean) {
  return `这是一张服装平铺商品图（${face === 'front' ? '正面' : '背面'}），画面左右即图片左右。请找出以下结构点，坐标用 0-1000 归一化（x 从左到右，y 从上到下）。看不清或不存在的点返回 null，不要猜。
${face === 'front' ? `- neckCenter：前领口中心，前中线上领子与衣身缝合处的最低点。Polo 衫为门襟顶端、两片领尖之间；圆领为领口罗纹下沿的最低点；立领/拉链夹克为领子下沿与衣身的缝合线，不是领子顶边。` : '- neckCenter：后领中心，后中线上领子（或罗纹）下沿与衣身的缝合处，不是领子顶边。'}
${polo && face === 'front' ? '- button2、button3：门襟上从上往下第二、第三粒纽扣的中心。\n' : ''}- leftArmpit、rightArmpit：图片左侧、右侧的腋点，即袖窿最低点、袖子内侧与衣身侧缝相接处，在肩点正下方较远处（大约胸围线高度），不是肩膀附近。长袖自然下垂贴着衣身时，沿袖子与衣身之间的折痕或阴影线找到它的最上端。
只输出 JSON：{"neckCenter":[x,y]|null,${polo && face === 'front' ? '"button2":[x,y]|null,"button3":[x,y]|null,' : ''}"leftArmpit":[x,y]|null,"rightArmpit":[x,y]|null}`;
}
const pair = (value: unknown) => Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && v >= 0 && v <= 1000) ? { x: value[0] / 1000, y: value[1] / 1000 } : null;

/** Model answer → points, keeping only what is anatomically consistent; the neck and buttons sit on the outline's center line. */
export function parseStructureAnswer(text: string, center: number, polo: boolean): StructurePoints {
  const raw: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
  if (!raw || typeof raw !== 'object') throw new Error('结构点识别结果不是 JSON 对象');
  const answer = raw as Record<string, unknown>, points: StructurePoints = {};
  const neck = pair(answer.neckCenter), left = pair(answer.leftArmpit), right = pair(answer.rightArmpit);
  const armpitY = left && right ? Math.min(left.y, right.y) : left?.y ?? right?.y ?? 1;
  if (neck && neck.y < armpitY) points.neckCenter = { x: center, y: neck.y };
  if (left && right && left.x < center && right.x > center && Math.abs(left.y - right.y) < .08) { points.leftArmpit = left; points.rightArmpit = right; }
  const b2 = polo ? pair(answer.button2) : null, b3 = polo ? pair(answer.button3) : null;
  if (points.neckCenter && b2 && b3 && points.neckCenter.y < b2.y && b2.y < b3.y && b3.y < armpitY) { points.button2 = { x: center, y: b2.y }; points.button3 = { x: center, y: b3.y }; }
  return points;
}

async function request(image: Buffer, text: string) {
  const key = process.env.ARK_RUNTIME_API_KEY?.trim() || process.env.ARK_API_KEY?.trim();
  if (!key) throw new Error('尚未配置结构点识别模型：需要 ARK_RUNTIME_API_KEY 或 ARK_API_KEY');
  const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: structureRecognitionModel(), messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } }] }], temperature: 0, max_tokens: 400, thinking: { type: 'disabled' } }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json() as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (!response.ok) throw new Error(`结构点识别失败（HTTP ${response.status}）：${body.error?.message ?? '无错误说明'}`);
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('结构点识别没有返回内容');
  return content;
}

// Results depend only on the image, crop and prompt; failures are not cached so a later open retries.
const cache = new Map<string, Promise<StructurePoints>>();
/** An immutable image: `key` names its content (a file id or hash); `load` is called only when the model is asked. */
export type RecognitionImage = { key: string; load: () => Promise<Buffer> };
/**
 * Neck center, polo buttons and armpits read from the face image by the vision model, in crop fractions.
 * Never throws: a failed or disabled recognition returns no points and the reason.
 */
export async function recognizeStructurePoints(source: RecognitionImage, crop: Box, face: 'front' | 'back', structure: string, center: number): Promise<{ points: StructurePoints; error: string | null }> {
  if (!['polo', 'crewneck', 'hoodie', 'jacket', 'shell', 'vest'].includes(structure)) return { points: {}, error: null };
  // Tests never call the paid model.
  if (process.env.NODE_ENV === 'test' || process.env.CATALOG_STRUCTURE_RECOGNITION === 'off') return { points: {}, error: '结构点识别已关闭' };
  const polo = structure === 'polo', text = prompt(face, polo);
  const key = createHash('sha256').update(JSON.stringify([source.key, crop, face, polo, center, structureRecognitionModel(), STRUCTURE_RECOGNITION_VERSION, text])).digest('hex');
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const bytes = await source.load();
      const { width, height } = await sharp(bytes).metadata();
      const left = Math.round(crop.x * width!), top = Math.round(crop.y * height!);
      const image = await sharp(bytes).extract({ left, top, width: Math.min(Math.round(crop.width * width!), width! - left), height: Math.min(Math.round(crop.height * height!), height! - top) })
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).flatten({ background: 'white' }).png().toBuffer();
      return parseStructureAnswer(await request(image, text), center, polo);
    })();
    cache.set(key, pending);
    if (cache.size > 256) cache.delete(cache.keys().next().value!);
  }
  try { return { points: await pending, error: null }; }
  catch (error) {
    if (cache.get(key) === pending) cache.delete(key);
    return { points: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One face's recognized points: shoulders, armpits and hem from the outline; neck and buttons from the
 * model; the model's armpits only where the outline could not separate the sleeves from the body.
 */
export async function faceStructurePoints(source: RecognitionImage, crop: Box, face: 'front' | 'back', structure: string, outline: StructurePoints, center: number) {
  const { points: seen, error } = await recognizeStructurePoints(source, crop, face, structure, center);
  const points: StructurePoints = { ...outline, neckCenter: seen.neckCenter, button2: seen.button2, button3: seen.button3 };
  // The armpit hangs well below the shoulder (about half the shoulder width on catalog photos); a model
  // answer next to the shoulder mistook the sleeve crease and is dropped.
  const { leftShoulder: ls, rightShoulder: rs } = outline, { leftArmpit: la, rightArmpit: ra } = seen;
  const plausible = !!la && !!ra && (!ls || !rs || Math.min(la.y, ra.y) - Math.max(ls.y, rs.y) > (rs.x - ls.x) * .25);
  if (!outline.leftArmpit && !outline.rightArmpit && plausible) { points.leftArmpit = la; points.rightArmpit = ra; }
  for (const key of Object.keys(points) as (keyof StructurePoints)[]) if (!points[key]) delete points[key];
  return { points, error };
}
