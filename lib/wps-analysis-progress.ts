import type { TaskReview } from './batch-task-review';

// Leave time for source verification, queued work and a useful error before the platform deadline.
export const WPS_ANALYSIS_MODEL_TIMEOUT_MS = 180_000;
export const WPS_ANALYSIS_REQUEST_TIMEOUT_MS = 270_000;
export const WPS_ANALYSIS_CLIENT_TIMEOUT_MS = 300_000;
export const WPS_ANALYSIS_STAGE_LABELS = {
  source: '核对 WPS 原文与附件', queue: '等待解析名额', catalog: '核对相关衣服款色',
  images: '读取图案素材', model: '等待模型解析结果', response: '读取模型返回内容', expand: '展开款色与位置方案',
} as const;
export type WpsAnalysisStage = keyof typeof WPS_ANALYSIS_STAGE_LABELS;
export type WpsAnalysisTiming = { stage: WpsAnalysisStage; durationMs: number; status: 'completed' | 'failed' };
export type WpsAnalysisProgress = { type: 'stage'; stage: WpsAnalysisStage } | { type: 'timing'; timing: WpsAnalysisTiming };
export type WpsAnalysisResult = {
  targetSnapshots?: Record<string, string>;
  reviews: TaskReview[]; model: string; provider?: string; reasoningEffort?: string;
  requestId?: string;
  timing?: { queueMs: number; processingMs: number; totalMs: number; stages: WpsAnalysisTiming[] };
  optimization?: { catalogStyles: number; candidateStyles: number; promptCharacters: number; outputCharacters: number; artworkDefinitions: number; expandedUnits: number };
};
export type WpsAnalysisFailure = { error: string; status: number; requestId?: string; stage?: WpsAnalysisStage; timings?: WpsAnalysisTiming[] };
export type WpsAnalysisStreamEvent = WpsAnalysisProgress | { type: 'ping' }
  | { type: 'complete'; result: WpsAnalysisResult } | ({ type: 'error' } & WpsAnalysisFailure);
