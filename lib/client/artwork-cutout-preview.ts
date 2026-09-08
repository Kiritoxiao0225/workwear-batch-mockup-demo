'use client';
import type { ArtworkDraft } from '@/lib/artwork-editor';
import type { ArtworkCutoutResult } from '@/lib/artwork-cutout';

/** Preview and save use the same aligned layer; text, masks and layout are retained. */
export async function cutoutReplacementDraft(current: ArtworkDraft, result: ArtworkCutoutResult) {
  const response = await fetch('/api/wps-production/cutout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'align', jobKey: result.receipt.jobKey, targetUrl: current.graphic.sourceUrl }) });
  const aligned = await response.json();
  if (!response.ok) throw new Error(aligned.error || '新图案预览暂未完成，请查询本次结果后再试');
  const draft = structuredClone(current);
  draft.graphic.sourceUrl = aligned.url;
  draft.preprocessing = { ...draft.preprocessing, cutout: result.receipt, cutoutRuns: [...(draft.preprocessing.cutoutRuns ?? []), result.receipt] };
  return draft;
}
