import sharp from 'sharp';
import { createHash } from 'node:crypto';

export type ArtworkFlatnessEvidence = { version: 'interior-flatness-v1'; sha256: string;
  status: 'within-tolerance' | 'inconclusive'; tolerance: number; samples: number; measuredFraction?: number;
  groups: Array<{ group: number; samples: number; channelSpread: number[] }> };

/** Measure only opaque interior pixels. This can disprove an alleged broad
 * gradient; it cannot prove correct colors, exact single ink, or shape fidelity. */
export async function artworkFlatnessEvidence(bytes: Buffer): Promise<ArtworkFlatnessEvidence> {
  const { data, info } = await sharp(bytes, { limitInputPixels: 32_000_000 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const evidence: ArtworkFlatnessEvidence = { version: 'interior-flatness-v1', sha256: createHash('sha256').update(bytes).digest('hex'),
    status: 'inconclusive', tolerance: 12, samples: 0, groups: [] };
  const groupAt = (x: number, y: number) => {
    const i = (y * info.width + x) * 4;
    if (data[i + 3] < 245) return -1;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    if (delta < 18) return max < 80 ? 12 : min > 190 ? 13 : 14;
    const hue = ((max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta) + 6) % 6;
    return Math.floor((hue * 2 + .5) % 12);
  };
  const groups = new Map<number, number[][]>();
  const step = Math.max(1, Math.ceil(Math.sqrt(info.width * info.height / 150_000)));
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 16) { transparent = true; break; }
  if (!transparent) return evidence;
  for (let y = 5; y < info.height - 5; y += step) for (let x = 5; x < info.width - 5; x += step) {
    const group = groupAt(x, y);
    if (group < 0 || [[-4, 0], [4, 0], [0, -4], [0, 4], [-3, -3], [3, 3], [-3, 3], [3, -3]]
      .some(([dx, dy]) => groupAt(x + dx, y + dy) !== group)) continue;
    const values = groups.get(group) ?? [[], [], []];
    for (let channel = 0; channel < 3; channel++) values[channel].push(data[(y * info.width + x) * 4 + channel]);
    groups.set(group, values); evidence.samples++;
  }
  for (const [group, values] of groups) evidence.groups.push({ group, samples: values[0].length,
    channelSpread: values.map(channels => {
      channels.sort((a, b) => a - b);
      return channels[Math.floor(channels.length * .95)] - channels[Math.floor(channels.length * .05)];
    }) });
  const measured = evidence.groups.filter(group => group.samples >= 30);
  evidence.measuredFraction = measured.reduce((sum, group) => sum + group.samples, 0) / Math.max(1, evidence.samples);
  // A few isolated compression colors cannot establish a broad gradient. Keep
  // their counts in the receipt and require 99.5% coverage before using this hint.
  if (evidence.samples >= 300 && evidence.measuredFraction >= .995 && measured.every(group => group.channelSpread.every(spread => spread <= evidence.tolerance))) {
    evidence.status = 'within-tolerance';
  }
  return evidence;
}
