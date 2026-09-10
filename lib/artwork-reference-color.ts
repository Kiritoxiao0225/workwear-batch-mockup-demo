import { artworkReferenceEvidence, normalizeArtworkImageNumbers } from './artwork-reference';

export type ArtworkReferenceColor = { label: string; requirement: string };
export type ArtworkReferenceColorReceipt = {
  version: 'reference-pixels-v1';
  label: string;
  hex: string;
  description: string;
  sourceSha256: string;
  region: { left: number; top: number; width: number; height: number };
  sampleImageSize: { width: number; height: number };
  sampledPixels: number;
  model: string;
};

/** Keep a reference-backed color separate from a named preset. Image numbers are not color values. */
export function artworkReferenceColors(input: { instruction: string; layoutNote: string; primaryImageLabel?: string }): ArtworkReferenceColor[] {
  const colors = new Map<string, string[]>();
  for (const evidence of artworkReferenceEvidence(`${input.instruction}\n${input.layoutNote}`)) {
    if (!evidence.attributes.includes('color')) continue;
    const label = `图${evidence.number}`;
    if (input.primaryImageLabel && normalizeArtworkImageNumbers(input.primaryImageLabel) === label) continue;
    colors.set(label, [...(colors.get(label) ?? []), evidence.clause]);
  }
  return [...colors].map(([label, requirements]) => ({ label, requirement: [...new Set(requirements)].join('；') }));
}
