import type { ProductionUnit } from './wps-production';
import { currentArtworkReview, type ArtworkReviewItem } from './artwork-review-ledger';
import { safeErrorText } from './artwork-reliability';

export type ArtworkCurrentWarning = { kind: 'difference' | 'uncertain' | 'unavailable' | 'pending'; label: string; message: string };
const unavailable = /(?:自动)?(?:核对|检查|复核)未完成|(?:核对|检查)服务.{0,16}(?:失败|超时|不可用)/u;
const resolved = (item: ArtworkReviewItem) => ['passed', 'accepted', 'confirmed'].includes(item.status);

/** Display-only. Consult the version-bound ledger, not old routing warnings or
 * generation history. A human acceptance stays effective until that item changes.
 * Frozen deliveries use their own stored ledger, never a new inferred result.
 */
export function currentArtworkWarnings(unit: ProductionUnit, fixed = false): ArtworkCurrentWarning[] {
  const artwork = unit.artwork;
  if (!artwork) return [];
  const stored = artwork.validation.review;
  const review = fixed ? stored?.sha256 === artwork.validation.sha256 ? stored : null : currentArtworkReview(unit);
  if (!review) return [{ kind: 'pending', label: '当前图稿', message: '尚无对应当前图稿的逐项核对记录，请对照原始要求人工核对。' }];
  const warnings: ArtworkCurrentWarning[] = [];
  const pending: string[] = [];
  for (const item of review.items) {
    if (resolved(item)) continue;
    // Never present a previous version's failure embedded in pending evidence as
    // an actual failure of the current pixels/requirements.
    if (item.status === 'pending' || (review.verification && review.verification.outputSha256 !== artwork.validation.sha256)) { pending.push(item.label); continue; }
    const serviceFailed = unavailable.test(item.evidence);
    if (item.status === 'failed') warnings.push({ kind: 'difference', label: item.label, message: safeErrorText(item.evidence) });
    else if (!serviceFailed) warnings.push({ kind: 'uncertain', label: item.label, message: safeErrorText(item.evidence) });
    if (serviceFailed) warnings.push({ kind: 'unavailable', label: item.label, message: '本项自动核对未完成，不能据此判断符合或不符合，请人工核对。' });
  }
  if (pending.length) warnings.push({ kind: 'pending', label: pending.join('、'), message: '等待人工核对当前结果；保存图稿不代表这些项目已通过。' });
  return warnings;
}
