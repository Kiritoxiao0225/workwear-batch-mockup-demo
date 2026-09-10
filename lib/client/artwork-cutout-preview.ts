'use client';
import { fetchApi, readApiJson } from '@/lib/client/api-response';
import type { ArtworkDraft } from '@/lib/artwork-editor';
import type { ArtworkCutoutResult } from '@/lib/artwork-cutout';

/** Preview and save use the same aligned layer; text, masks and layout are retained. */
export async function cutoutReplacementDraft(current: ArtworkDraft, result: ArtworkCutoutResult) {
  const response = await fetchApi('/api/wps-production/cutout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'align', jobKey: result.receipt.jobKey, targetUrl: current.graphic.sourceUrl }) });
  const aligned = await readApiJson(response, '读取新图案预览失败');
  const draft = structuredClone(current);
  draft.graphic.sourceUrl = aligned.url;
  draft.preprocessing = { ...draft.preprocessing, cutout: result.receipt, cutoutRuns: [...(draft.preprocessing.cutoutRuns ?? []), result.receipt] };
  return draft;
}
