import { ARTWORK_ROUTING_STANDARD, type ArtworkQualityMeasurement } from '@/lib/artwork-routing-standard';

/** Simulated provider result for isolated state/compositor tests; never used as live evidence. */
export function artworkQualityFixture(sha256: string, overrides: Partial<ArtworkQualityMeasurement> = {}): ArtworkQualityMeasurement {
  return { score: 90, protocol: ARTWORK_ROUTING_STANDARD.scoreProtocol, sha256, checkedAt: '2026-09-07T00:00:00.000Z',
    vqscore: 75, noise: 60, compressionArtifacts: 30, subjectWidth: 1000, subjectHeight: 800, requiredScale: 1, ...overrides };
}
