import type { ArtworkCutoutResult } from './artwork-cutout';
import type { ArtworkPreparationResponse, NativeArtworkCandidate } from './task-review-artwork';

/** Offsets share the request's clock; parallel durations must not be added together. */
export type ArtworkTiming = { stage: string; startMs: number; durationMs: number; status: 'completed' | 'failed' };
export type ArtworkProgressEvent =
  | { type: 'progress'; message: string; generationFinished?: boolean }
  | { type: 'preview'; url: string; label: string }
  | { type: 'timing'; timing: ArtworkTiming };
export type ArtworkFailure = { error: string; candidate?: NativeArtworkCandidate; cutout?: ArtworkCutoutResult };
export type ArtworkStreamEvent = ArtworkProgressEvent
  | { type: 'ping' }
  | { type: 'complete'; result: ArtworkPreparationResponse }
  | ({ type: 'error'; status: number } & ArtworkFailure);
