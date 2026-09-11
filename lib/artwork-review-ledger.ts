import { artworkGraphicLayers, artworkTextLayers, type ArtworkDraft } from './artwork-editor';
import { artworkPixelFingerprint } from './artwork-save-fingerprint';
import type { ArtworkEditVerification } from './artwork-model-edits';
import type { ArtworkValidation, ProductionArtwork, ProductionUnit } from './wps-production';

export const REVIEW_CATEGORIES = ['text', 'color', 'structure', 'layout', 'background', 'size', 'position'] as const;
export type ReviewCategory = typeof REVIEW_CATEGORIES[number];
export type ReviewState = 'passed' | 'failed' | 'uncertain' | 'pending' | 'accepted' | 'confirmed';
export type ArtworkReviewItem = { id: ReviewCategory; label: string; requirement: string; status: ReviewState; evidence: string; checks?: ArtworkEditVerification['checks']; actor?: string; note?: string; checkedAt?: string };
export type ArtworkReviewLedger = { version: 1; sha256: string; draftKey: string; requirementKey: string; placementKey: string; updatedAt: string; verification?: ArtworkEditVerification;
  items: ArtworkReviewItem[]; history: Array<{ sha256: string; at: string; items: ArtworkReviewItem[] }> };
const labels: Record<ReviewCategory, string> = { text: '文字', color: '颜色', structure: '图形', layout: '图文排列', background: '背景与载体', size: '印花尺寸', position: '印花位置' };
export const reviewStateLabels: Record<ReviewState, string> = { passed: '检查符合', failed: '待修正', uncertain: '待人工核查', pending: '待核查', accepted: '已接受差异', confirmed: '人工核对符合' };
const key = (value: unknown) => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const reviewDraftKey = (draft?: ArtworkDraft) => draft ? key(JSON.parse(artworkPixelFingerprint(draft))) : '';
const requirementKey = (unit: ProductionUnit) => key([unit.instruction, unit.layoutNote, unit.exactText, unit.materialId, unit.referenceMaterialIds, ...(unit.fontReference ? [unit.fontReference] : []), unit.textMode, unit.sourceScope]);
const placementKey = (unit: ProductionUnit) => key([unit.placement, unit.garment?.assetVersionId]);

function baseItems(unit: ProductionUnit): ArtworkReviewItem[] {
  const brief = `${unit.instruction}\n${unit.layoutNote}`.trim();
  return REVIEW_CATEGORIES.map(id => ({ id, label: labels[id], status: 'pending', evidence: '尚未核对当前结果',
    requirement: id === 'text' && unit.exactText ? `准确文字：${unit.exactText}${unit.fontReference ? `；字形按已绑定字体参考的指定区域：${unit.fontReference.description}` : ''}` : id === 'size'
      ? `按当前印花尺寸：${unit.placement?.sizeMode === 'heightCm' ? `${unit.placement.heightCm} cm 高` : unit.placement?.sizeMode === 'widthCm' ? `${unit.placement.widthCm} cm 宽` : '位置标准尺寸'}，核对上衣后实际大小`
      : id === 'position' ? `核对当前 ${unit.placement?.key ?? '未选位置'} 的上衣预览、中心和旋转` : `${labels[id]}：${brief}` }));
}

/** Conservatively invalidate only changes whose effect we can identify in editable layers. */
export function changedReviewCategories(before?: ArtworkDraft, after?: ArtworkDraft): Set<ReviewCategory> {
  const all = () => new Set<ReviewCategory>(REVIEW_CATEGORIES.filter(id => id !== 'position'));
  if (!before || !after) return all();
  const result = new Set<ReviewCategory>();
  const bg = artworkGraphicLayers(before), ag = artworkGraphicLayers(after);
  const bt = artworkTextLayers(before), at = artworkTextLayers(after);
  if (bg.length !== ag.length || bt.length !== at.length || key(before.layerOrder) !== key(after.layerOrder) || key(before.canvas) !== key(after.canvas)) return all();
  const compare = (left: object, right: object, text: boolean) => {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (key(a[field]) === key(b[field]) || ['id', 'label', 'role', 'textValue'].includes(field)) continue;
      if (['color', 'recolor', 'recolorScope', 'recolorMaskUrl'].includes(field)) result.add('color');
      else if (text && field === 'value') { result.add('text'); result.add('layout'); result.add('size'); }
      else if (['x', 'y', 'width', 'height', 'rotation', 'boxWidth', 'fontFamily', 'fontSize', 'letterSpacing', 'lineHeight', 'fontWeight', 'italic', 'underline', 'align', 'arc'].includes(field)) {
        result.add('layout'); result.add('size'); if (text) result.add('text');
      } else for (const category of all()) result.add(category);
    }
  };
  bg.forEach((g, i) => compare(g, ag[i], false)); bt.forEach((t, i) => compare(t, at[i], true));
  return result;
}

/** Saving pixels never resolves a content issue. No network or state writes on read. */
export function buildArtworkReview(unit: ProductionUnit, validation: ArtworkValidation, draft?: ArtworkDraft, previous?: ProductionArtwork): ArtworkReviewLedger {
  const old = previous?.validation.review;
  const draftKey = reviewDraftKey(draft), requirements = requirementKey(unit), placement = placementKey(unit);
  if (old && old.sha256 === validation.sha256 && old.draftKey === draftKey && old.requirementKey === requirements && old.placementKey === placement) return structuredClone(old);
  const now = validation.checkedAt;
  const items = baseItems(unit);
  const pixelsChanged = old?.sha256 !== validation.sha256;
  const affected = old?.requirementKey !== requirements ? new Set(REVIEW_CATEGORIES)
    : old.draftKey !== draftKey ? changedReviewCategories(previous?.draft, draft)
    : pixelsChanged ? new Set(REVIEW_CATEGORIES.filter(id => id !== 'position')) : new Set<ReviewCategory>();
  if (old?.placementKey !== placement) { affected.add('size'); affected.add('position'); }
  if (old) for (const item of items) {
    const prior = old.items.find(i => i.id === item.id);
    if (prior && !affected.has(item.id)) Object.assign(item, prior);
    else if (prior) item.evidence = `当前结果有变化，需重新核对。上一版：${prior.evidence}${prior.note ? `；人工说明：${prior.note}` : ''}`;
  }
  const report = draft?.preprocessing.routingReport;
  const verification = report?.contentReview?.verification;
  // Only checks of these final pixels can establish a pass. Intermediate checks are historical.
  if (verification?.outputSha256 === validation.sha256 && (!old || pixelsChanged && old.requirementKey === requirements)) applyChecks(items, verification, now);
  const history = old ? [...old.history, { sha256: old.sha256, at: old.updatedAt, items: old.items }] : [];
  return { version: 1, sha256: validation.sha256, draftKey, requirementKey: requirements, placementKey: placement, updatedAt: now, items, history,
    ...(old?.sha256 === validation.sha256 && old.verification ? { verification: old.verification } : verification?.outputSha256 === validation.sha256 ? { verification } : {}) };
}

/** Use only server-owned input here. Shared applications cannot inherit another position's decisions. */
export function reviewForAttachment(unit: ProductionUnit, validation: ArtworkValidation, draft?: ArtworkDraft) {
  const supplied = validation.review;
  if (supplied && supplied.sha256 === validation.sha256 && supplied.draftKey === reviewDraftKey(draft)
    && supplied.requirementKey === requirementKey(unit) && supplied.placementKey === placementKey(unit)) return structuredClone(supplied);
  const next = buildArtworkReview(unit, validation, draft, unit.artwork ?? unit.previousArtwork ?? undefined);
  if (supplied && supplied.sha256 === validation.sha256 && supplied.draftKey === reviewDraftKey(draft) && supplied.requirementKey === requirementKey(unit)) {
    next.items = next.items.map(item => {
      const checked = supplied.items.find(other => other.id === item.id);
      return !['size', 'position'].includes(item.id) && checked && ['passed', 'failed', 'uncertain'].includes(checked.status) && !checked.actor ? structuredClone(checked) : item;
    });
    next.verification = supplied.verification;
  }
  return next;
}
function applyChecks(items: ArtworkReviewItem[], verification: ArtworkEditVerification, now: string) {
  for (const item of items) {
    const checks = verification.checks.filter(c => (c.category === 'flatness' ? 'color' : c.category) === item.id);
    if (!checks.length || item.id === 'size' || item.id === 'position') continue;
    item.status = checks.some(c => c.status === 'failed') ? 'failed' : checks.some(c => c.status === 'uncertain') ? 'uncertain' : 'passed';
    item.evidence = checks.map(c => c.evidence).join('；'); item.checks = structuredClone(checks); item.checkedAt = now;
    delete item.actor; delete item.note;
  }
}
export function applyFinalArtworkReview(ledger: ArtworkReviewLedger, verification: ArtworkEditVerification, selected?: ReviewCategory[]) {
  if (verification.outputSha256 !== ledger.sha256) throw new Error('核对结果不属于当前最终图片');
  const next = structuredClone(ledger); next.history.push({ sha256: ledger.sha256, at: ledger.updatedAt, items: ledger.items });
  next.updatedAt = new Date().toISOString();
  next.verification = verification;
  applyChecks(next.items.filter(item => !selected || selected.includes(item.id)), verification, next.updatedAt);
  return next;
}
export function manualArtworkReview(ledger: ArtworkReviewLedger, ids: ReviewCategory[], decision: 'accepted' | 'confirmed', actor: string, note: string) {
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !ledger.items.some(i => i.id === id))) throw new Error('请选择当前核对项目');
  if (!actor.trim() || !note.trim()) throw new Error('请填写核对说明');
  const next = structuredClone(ledger); next.history.push({ sha256: ledger.sha256, at: ledger.updatedAt, items: ledger.items });
  next.updatedAt = new Date().toISOString();
  next.items = next.items.map(item => ids.includes(item.id) ? { ...item, status: decision, actor, note, checkedAt: next.updatedAt } : item);
  return next;
}
export function currentArtworkReview(unit: ProductionUnit) {
  return unit.artwork?.validation.review ? buildArtworkReview(unit, unit.artwork.validation, unit.artwork.draft, unit.artwork) : null;
}
export function artworkReviewSummary(review: ArtworkReviewLedger | null) {
  if (!review) return '';
  const failed = review.items.filter(i => i.status === 'failed').length;
  const pending = review.items.filter(i => i.status === 'pending' || i.status === 'uncertain').length;
  return failed ? `已保存 · ${failed} 项待修正${pending ? `，${pending} 项待核查` : ''}` : pending ? `已保存 · ${pending} 项待人工核查` : '核对已完成 · 含人工决定的项目可查看记录';
}
