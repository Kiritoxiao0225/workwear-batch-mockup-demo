import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { ARTWORK_ROUTING_STANDARD, ARTWORK_PIXEL_PROTOCOL, clarityFromStandardBlur, type ArtworkQualityMeasurement } from '@/lib/artwork-routing-standard';
import { inspectArtworkSource, removeFlatArtworkBackground, visibleArtworkBounds } from '@/lib/server/artwork-image-processing';
import { evaluateArtworkBytes } from '@/lib/server/media-kit-artwork';
import type { ArtworkQualityEvaluation } from '@/lib/task-review-artwork';

export const artworkSha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function artworkEvaluationInput(bytes: Buffer) {
  const profile = await inspectArtworkSource(bytes);
  // A tightly cropped transparent PNG can fall below the cutout classifier's 2% alpha threshold.
  // Never remove another colour from such a file just to measure it.
  const stats = await sharp(bytes).stats();
  const hasAlpha = stats.channels.length === 4 && stats.channels[3].min < 255;
  const transparent = !hasAlpha && profile.kind === 'flat-background' && profile.backgroundColor
    ? await removeFlatArtworkBackground(bytes, profile.backgroundColor) : bytes;
  const bounds = hasAlpha || profile.kind === 'transparent' || profile.kind === 'flat-background'
    ? await visibleArtworkBounds(transparent) : { left: 0, top: 0, width: profile.width, height: profile.height };
  const target = ARTWORK_ROUTING_STANDARD.targetLongEdge;
  const canvas = await sharp(transparent).extract(bounds).flatten({ background: '#ffffff' })
    .resize({ width: target, height: target, fit: 'inside' }).png().toBuffer();
  return { bytes: canvas, bounds, requiredScale: target / Math.max(bounds.width, bounds.height) };
}

export async function measureArtworkQuality(bytes: Buffer, evaluate: (bytes: Buffer) => Promise<ArtworkQualityEvaluation> = evaluateArtworkBytes): Promise<ArtworkQualityMeasurement> {
  const input = await artworkEvaluationInput(bytes);
  const result = await evaluate(input.bytes);
  for (const [key, value] of Object.entries(result)) {
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) throw new Error(`画质服务返回无效 ${key} 分数`);
  }
  if (!Number.isFinite(result.blur) || !Number.isFinite(result.vqscore)) throw new Error('画质服务没有返回清晰度或综合画质');
  return { score: clarityFromStandardBlur(result.blur), rawBlur: result.blur, protocol: ARTWORK_ROUTING_STANDARD.scoreProtocol, sha256: artworkSha256(bytes), checkedAt: new Date().toISOString(),
    vqscore: result.vqscore, noise: result.noise, compressionArtifacts: result.compressionArtifacts,
    subjectWidth: input.bounds.width, subjectHeight: input.bounds.height, requiredScale: input.requiredScale };
}

/** Local measurement only: never upload to or invoke a numeric scoring service. */
export async function measureArtworkPixels(bytes: Buffer): Promise<ArtworkQualityMeasurement> {
  const input = await artworkEvaluationInput(bytes);
  return { score: null, vqscore: null, noise: null, compressionArtifacts: null,
    protocol: ARTWORK_PIXEL_PROTOCOL, sha256: artworkSha256(bytes), checkedAt: new Date().toISOString(),
    subjectWidth: input.bounds.width, subjectHeight: input.bounds.height, requiredScale: input.requiredScale };
}

export function artworkPixelTarget(measurement: ArtworkQualityMeasurement, placement?: import('@/lib/production-artwork-layout').ArtworkPrintPlacement) {
  const configuredPpi = Number(process.env.ARTWORK_REFERENCE_PPI ?? 300);
  const ppi = Number.isFinite(configuredPpi) && configuredPpi > 0 && configuredPpi <= 1200 ? configuredPpi : 300;
  const specifiedHeight = placement?.sizeMode === 'heightCm' ? placement.heightCm : null;
  const specifiedWidth = placement?.sizeMode === 'widthCm' ? placement.widthCm : null;
  const scale = specifiedHeight ? Math.round(specifiedHeight / 2.54 * ppi) / measurement.subjectHeight
    : specifiedWidth ? Math.round(specifiedWidth / 2.54 * ppi) / measurement.subjectWidth
      : ARTWORK_ROUTING_STANDARD.targetLongEdge / Math.max(measurement.subjectWidth, measurement.subjectHeight);
  return { ...measurement, requiredScale: scale,
    targetLongEdge: Math.ceil(scale * Math.max(measurement.subjectWidth, measurement.subjectHeight)),
    targetBasis: specifiedHeight || specifiedWidth ? `指定${specifiedHeight ? '高度' : '宽度'} ${specifiedHeight ?? specifiedWidth}cm，参考 ${ppi} PPI` : '未指定实际尺寸，参考主体长边 1000px；不作为放行门槛' };
}
