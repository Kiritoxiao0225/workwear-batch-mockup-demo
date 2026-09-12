import { z } from 'zod';
import type { ProductionPlacement, WpsProductionState } from './wps-production';

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
 * Missing units may inherit a consistent dimension/distance unit in the same
 * source clause. A position distance supplies its unit, never its numeric value. */
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
        const suffix = segment.slice(match.index! + match[0].length);
        if (/^(?:英寸|英尺|寸|尺|米|(?:in(?:ch(?:es)?)?|ft|m)\b|["″])/iu.test(suffix)) {
          return { issue: `“${segment.trim()}”的尺寸单位暂不支持，请填写厘米尺寸` };
        }
        const before = text.slice(0, marker.index!).split(/[\n\r。；;]/u).at(-1)!;
        const after = text.slice(marker.index!).split(/[\n\r。；;]/u)[0];
        const clause = before + after;
        const units = new Set([...clause.matchAll(/(?:(?:宽|高)(?:度)?|(?:往|向)[上下左右](?:方|侧|边)?|[上下左右]移|(?:距离|距|离)[^\d\n\r。；;，,]{0,16}|(?:领口|门襟)[上下左右](?:方|侧|边)?)[：:\s]*(?:约|大约)?[ \t]*\d+(?:\.\d+)?[ \t]*(厘米|公分|毫米|cm|mm)(?![a-z])/giu)]
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

export type PrintSizeRecoveryState = Pick<WpsProductionState, 'units' | 'mockupVersions'> & {
  records: { source: Pick<WpsProductionState['records'][number]['source'], 'recordId' | 'requirementText'> }[];
};

/** Recover only unresolved draft dimensions from the saved customer source.
 * This is a derived read; normal placement saves persist the same binding.
 * Keep saved fingerprints and timestamps so read-only recovery does not make
 * concurrent artwork jobs or placement snapshots stale. */
export function recoverProductionPrintSizes<T extends PrintSizeRecoveryState>(state: T): T {
  const fixed = new Set(state.mockupVersions.filter(version => version.output || version.finalConfirmation)
    .flatMap(version => version.unitIds));
  const sources = new Map(state.records.map(record => [record.source.recordId, record.source.requirementText]));
  let changed = false;
  const units = state.units.map(unit => {
    const placement = unit.placement;
    if (!placement?.requestedSizeIssue?.includes('未注明单位') || placement.requestedSize || placement.sizeOverride
      || unit.gateA || fixed.has(unit.id) || placement.templateVersion !== 'catalog-v1') return unit;
    const text = sources.get(unit.sourceRecordId);
    if (!text) return unit;
    const recovered = bindPrintSizeRequest(text, placement);
    if (!recovered.requestedSize || recovered.requestedSizeIssue) return unit;
    changed = true;
    return { ...unit, placement: recovered };
  });
  return changed ? { ...state, units } : state;
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
