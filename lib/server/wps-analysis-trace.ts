import { randomUUID } from 'node:crypto';
import type { WpsAnalysisProgress, WpsAnalysisStage, WpsAnalysisTiming } from '@/lib/wps-analysis-progress';

/** Log durations and identifiers only; never source text, images, credentials or model responses. */
export class WpsAnalysisTrace {
  readonly requestId = randomUUID();
  readonly startedAt = Date.now();
  readonly timings: WpsAnalysisTiming[] = [];
  stage: WpsAnalysisStage = 'source';
  constructor(private notify?: (event: WpsAnalysisProgress) => void) {}
  start(stage: WpsAnalysisStage) { this.stage = stage; this.notify?.({ type: 'stage', stage }); }
  finish(stage: WpsAnalysisStage, started: number, status: WpsAnalysisTiming['status']) {
    const timing = { stage, durationMs: Date.now() - started, status };
    this.timings.push(timing); this.notify?.({ type: 'timing', timing });
    console.info('[wps-analysis]', { requestId: this.requestId, ...timing });
  }
  async measure<T>(stage: WpsAnalysisStage, work: () => Promise<T> | T): Promise<T> {
    const started = Date.now(); this.start(stage);
    try { const result = await work(); this.finish(stage, started, 'completed'); return result; }
    catch (error) { this.finish(stage, started, 'failed'); throw error; }
  }
}
