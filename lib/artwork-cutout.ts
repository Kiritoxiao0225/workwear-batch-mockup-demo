export type ArtworkCutoutMode = 'auto' | 'standard' | 'meitu';
export type ArtworkCutoutRoute = 'reuse' | 'standard' | 'volcano' | 'meitu';
export const ARTWORK_CUTOUT_VERSION = 'artwork-cutout-v4' as const;
export type ArtworkCutoutDecision = {
  route: ArtworkCutoutRoute;
  reasons: string[];
  estimatedCredits: number | null;
  version: 'artwork-cutout-v1' | 'artwork-cutout-v2' | 'artwork-cutout-v3' | typeof ARTWORK_CUTOUT_VERSION;
};
export type ArtworkCutoutIntegrity = { version: string; status: 'checked' | 'uncertain' | 'mask-only'; basis: string; warning?: string };
export type ArtworkCutoutReceipt = ArtworkCutoutDecision & {
  protection?: import('./artwork-protection').ArtworkProtectionPolicy;
  reusedFrom?: string;
  /** Local validation version is deliberately separate from the paid submission key. */
  localValidationVersion?: string;
  integrityCheck?: ArtworkCutoutIntegrity;
  localValidationOnly?: boolean;
  providerOutputUrl?: string;
  diagnostics?: { stage: 'provider-mask' | 'protection' | 'final-mask' | 'completeness' | 'completed';
    rawMaskError?: string; rawMask?: import('./server/artwork-image-processing').ArtworkAlphaMaskReport;
    acceptance?: 'standard' | 'explicit-full-bleed-panel' };
  jobKey: string;
  mode: ArtworkCutoutMode;
  sourceSha256: string;
  outputSha256?: string;
  sourceUrl: string;
  taskId?: string;
  actualCredits: number | null;
  cacheHit: boolean;
  completedAt?: string;
  badgeProtection?: { regions: number; restoredPixels: number };
  excludedWatermarks?: Array<{ bounds: ArtworkCutoutRegion; text: string; model: string }>;
};
export type ArtworkCutoutRegion = { left: number; top: number; width: number; height: number };
export type ArtworkCutoutResult = {
  status: 'completed' | 'pending' | 'failed' | 'unknown';
  receipt: ArtworkCutoutReceipt;
  url?: string;
  error?: string;
  /** Failed or uncertain-integrity output remains available as a candidate. A completed URL is not content approval. */
  candidate?: { url: string; width: number; height: number; missingRegions: ArtworkCutoutRegion[] };
};
export const CUTOUT_ROUTE_LABELS = { reuse: '透明图复用', standard: '标准抠图 · 本地', volcano: '标准抠图 · 火山', meitu: '美图精细' };
export function cutoutFeeLabel(receipt: ArtworkCutoutReceipt) {
  if (receipt.route === 'volcano') return receipt.cacheHit ? '复用结果 · 本次未调用火山' : '火山按服务账单计费 · 金额未回传';
  return receipt.cacheHit ? '复用结果 · 本次 0 积分' : receipt.actualCredits === null ? `预计 ${receipt.estimatedCredits} 积分 · 账单待回查` : `${receipt.actualCredits} 积分`;
}
