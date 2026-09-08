import type { SourceTaskRecord, TaskReview } from '@/lib/batch-task-review';

export const TASK_REVIEW_ANALYSIS_CACHE_VERSION = 'task-review-analysis-v7';

type AnalysisCacheStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

type CachedTaskReview = {
  version: string;
  sourceFingerprint: string;
  model: string;
  cachedAt: string;
  review: TaskReview;
};

function sourceFingerprintInput(record: SourceTaskRecord) {
  return JSON.stringify({
    version: TASK_REVIEW_ANALYSIS_CACHE_VERSION,
    recordId: record.recordId,
    customerId: record.customerId,
    revision: record.revision,
    requirementText: record.requirementText,
    productStyleText: record.productStyleText,
    materials: record.materials.map((material) => ({
      id: material.id,
      name: material.name,
      description: material.description,
    })),
  });
}

function fnv1a(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function taskReviewSourceFingerprint(record: SourceTaskRecord) {
  return fnv1a(sourceFingerprintInput(record));
}

export function taskReviewAnalysisCacheKey(record: SourceTaskRecord) {
  return `${TASK_REVIEW_ANALYSIS_CACHE_VERSION}:${record.recordId}:${taskReviewSourceFingerprint(record)}`;
}

function cachedTaskReview(value: unknown, record: SourceTaskRecord): CachedTaskReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`任务分析缓存必须是对象：${record.recordId}`);
  }
  const cache = value as Record<string, unknown>;
  if (cache.version !== TASK_REVIEW_ANALYSIS_CACHE_VERSION) {
    throw new Error(`任务分析缓存版本无效：${record.recordId}/${String(cache.version)}`);
  }
  const expectedFingerprint = taskReviewSourceFingerprint(record);
  if (cache.sourceFingerprint !== expectedFingerprint) {
    throw new Error(`任务分析缓存原始证据已变化：${record.recordId}`);
  }
  if (typeof cache.model !== 'string' || !cache.model.trim()) {
    throw new Error(`任务分析缓存缺少模型：${record.recordId}`);
  }
  if (typeof cache.cachedAt !== 'string' || Number.isNaN(Date.parse(cache.cachedAt))) {
    throw new Error(`任务分析缓存时间无效：${record.recordId}/${String(cache.cachedAt)}`);
  }
  if (!cache.review || typeof cache.review !== 'object' || Array.isArray(cache.review)) {
    throw new Error(`任务分析缓存缺少 review：${record.recordId}`);
  }
  const review = cache.review as TaskReview;
  if (review.source?.recordId !== record.recordId || !Array.isArray(review.units) || review.units.length === 0) {
    throw new Error(`任务分析缓存 review 不属于当前源记录：${record.recordId}`);
  }
  return cache as CachedTaskReview;
}

export function readTaskReviewAnalysisCache(
  storage: AnalysisCacheStorage,
  record: SourceTaskRecord,
) {
  const key = taskReviewAnalysisCacheKey(record);
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`任务分析缓存 JSON 无效：${record.recordId}；${error instanceof Error ? error.message : String(error)}`);
  }
  return cachedTaskReview(parsed, record);
}

export function writeTaskReviewAnalysisCache(
  storage: AnalysisCacheStorage,
  record: SourceTaskRecord,
  review: TaskReview,
  model: string,
) {
  if (review.source.recordId !== record.recordId) {
    throw new Error(`不能缓存其他源记录的分析结果：${record.recordId}/${review.source.recordId}`);
  }
  if (!model.trim()) throw new Error(`任务分析缓存模型不能为空：${record.recordId}`);
  const value: CachedTaskReview = {
    version: TASK_REVIEW_ANALYSIS_CACHE_VERSION,
    sourceFingerprint: taskReviewSourceFingerprint(record),
    model: model.trim(),
    cachedAt: new Date().toISOString(),
    review,
  };
  storage.setItem(taskReviewAnalysisCacheKey(record), JSON.stringify(value));
  return value;
}

export function removeTaskReviewAnalysisCache(
  storage: AnalysisCacheStorage,
  record: SourceTaskRecord,
) {
  storage.removeItem(taskReviewAnalysisCacheKey(record));
}
