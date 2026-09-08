import { describe, expect, it } from 'vitest';

import type { SourceTaskRecord, TaskReview } from '@/lib/batch-task-review';
import {
  readTaskReviewAnalysisCache,
  TASK_REVIEW_ANALYSIS_CACHE_VERSION,
  taskReviewAnalysisCacheKey,
  writeTaskReviewAnalysisCache,
} from '@/lib/client/task-review-analysis-cache';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function record(requirementText = '左胸：图1') : SourceTaskRecord {
  return {
    recordId: 'row-1',
    customerId: '客户A',
    revision: '第1次',
    requirementText,
    productStyleText: 'B01SD-活力黑',
    materials: [{
      id: 'row-1-image-1',
      name: '图1',
      description: '图1',
      previewUrl: '/image-1.png',
      url: '/image-1.png',
    }],
  };
}

function review(source: SourceTaskRecord): TaskReview {
  return {
    source,
    summary: '左胸使用图1',
    units: [{
      id: 'row-1-unit-1',
      garmentLabel: 'B01SD-活力黑',
      variantLabel: '版本1',
      productCode: null,
      placement: 'leftChest',
      logo: { materialId: 'row-1-image-1', url: null, name: '图1' },
      referenceMaterialIds: [],
      sourceScope: 'subject',
      textMode: 'keep',
      exactText: '',
      layoutNote: '',
      instruction: '左胸使用图1。',
      ambiguities: [],
      artworkDraft: null,
      needsRegeneration: false,
      confirmed: false,
    }],
  };
}

describe('task review analysis browser cache', () => {
  it('invalidates earlier analysis caches after reference and selection validation changed', () => {
    expect(TASK_REVIEW_ANALYSIS_CACHE_VERSION).toBe('task-review-analysis-v7');
    expect(taskReviewAnalysisCacheKey(record())).toContain('task-review-analysis-v7:');
  });

  it('restores an unchanged source record', () => {
    const cacheStorage = storage();
    const source = record();
    writeTaskReviewAnalysisCache(cacheStorage, source, review(source), 'vision-model');

    const cached = readTaskReviewAnalysisCache(cacheStorage, source);
    expect(cached?.review.summary).toBe('左胸使用图1');
    expect(cached?.model).toBe('vision-model');
  });

  it('changes the cache key when the WPS original text changes', () => {
    expect(taskReviewAnalysisCacheKey(record('左胸：图1')))
      .not.toBe(taskReviewAnalysisCacheKey(record('左胸：图2')));
  });

  it('keeps the cache key when only a temporary attachment URL changes', () => {
    const original = record();
    const refreshed = {
      ...original,
      materials: original.materials.map((material) => ({
        ...material,
        previewUrl: '/image-1.png?signature=new',
        url: '/image-1.png?signature=new',
      })),
    };
    expect(taskReviewAnalysisCacheKey(refreshed)).toBe(taskReviewAnalysisCacheKey(original));
  });

  it('rejects a cached review belonging to another record', () => {
    const cacheStorage = storage();
    const source = record();
    const otherReview = review({ ...source, recordId: 'row-2' });

    expect(() => writeTaskReviewAnalysisCache(cacheStorage, source, otherReview, 'vision-model'))
      .toThrow('不能缓存其他源记录的分析结果');
  });
});
