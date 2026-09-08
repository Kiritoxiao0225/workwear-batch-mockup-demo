import { z } from 'zod';
import type { ProductionPlacement } from './wps-production';

export const printSizeRequestSchema = z.object({
  axis: z.enum(['widthCm', 'heightCm']),
  valueCm: z.number().positive().max(100),
  evidence: z.string().min(1).max(500),
  inferredUnit: z.boolean(),
}).strict();
export type PrintSizeRequest = z.infer<typeof printSizeRequestSchema>;

const positions = '正前面|正面|前胸|左胸|右胸|后背|背面|后脖|后领|左袖|右袖';
const names: Record<ProductionPlacement['key'], string[]> = {
  frontCenter: ['正前面', '正面', '前胸'], leftChest: ['左胸'], rightChest: ['右胸'],
  back: ['后背', '背面', '后脖', '后领'], leftSleeve: ['左袖'], rightSleeve: ['右袖'],
};

/** Customer facts are read from the source, never from generated prompts.
 * Missing units may inherit only an explicit dimension unit on the same line. */
export function parsePrintSizeRequest(text: string, key: ProductionPlacement['key']): { request?: PrintSizeRequest; issue?: string } {
  const markers = [...text.matchAll(new RegExp(positions, 'gu'))];
  const requests: PrintSizeRequest[] = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (!names[key].includes(marker[0])) continue;
    const segment = text.slice(marker.index!, markers[i + 1]?.index ?? text.length).split(/[\n\r。；;]/u)[0];
    const matches = [...segment.matchAll(/(宽|高)(?:度)?[：:\s]*(\d+(?:\.\d+)?)[ \t]*(厘米|公分|毫米|cm|mm)?(?![\d.])/giu)];
    for (const match of matches) {
      let unit = match[3]?.toLowerCase();
      const inferredUnit = !unit;
      if (!unit) {
        const start = text.lastIndexOf('\n', marker.index!) + 1;
        const end = text.indexOf('\n', marker.index!);
        const line = text.slice(start, end < 0 ? text.length : end);
        const units = new Set([...line.matchAll(/(?:宽|高)(?:度)?[：:\s]*\d+(?:\.\d+)?[ \t]*(厘米|公分|毫米|cm|mm)/giu)]
          .map(value => /mm|毫米/iu.test(value[1]) ? 'mm' : 'cm'));
        if (units.size !== 1) return { issue: `“${marker[0]}${match[0].trim()}”未注明单位，请核对后填写自定义尺寸` };
        unit = [...units][0];
      }
      const valueCm = Number(match[2]) / (/mm|毫米/iu.test(unit) ? 10 : 1);
      const axis = match[1] === '宽' ? 'widthCm' : 'heightCm';
      if (!(valueCm > 0) || valueCm > (axis === 'widthCm' ? 50 : 100)) return { issue: `“${segment.trim()}”超出支持的贴图尺寸，请核对` };
      requests.push({ axis, valueCm, inferredUnit, evidence: segment.trim().slice(0, 500) });
    }
  }
  const distinct = new Set(requests.map(value => `${value.axis}:${value.valueCm}`));
  if (distinct.size > 1) return { issue: '同一位置出现多条尺寸要求，请核对对应款式及宽高比例后填写自定义尺寸' };
  return { request: requests[0] };
}

/** Only placement changes bind these facts; reading an old task never rewrites it. */
export function bindPrintSizeRequest(text: string, placement: ProductionPlacement): ProductionPlacement {
  const { request, issue } = parsePrintSizeRequest(text, placement.key);
  const next = { ...placement };
  delete next.requestedSize;
  delete next.requestedSizeIssue;
  if (request) next.requestedSize = request;
  if (issue) next.requestedSizeIssue = issue;
  if (request && !next.sizeOverride) {
    next.sizeMode = request.axis;
    next[request.axis] = request.valueCm;
    // Do not leave an old height that appears active while width controls scaling.
    if (request.axis === 'widthCm') delete next.heightCm;
  }
  return next;
}
