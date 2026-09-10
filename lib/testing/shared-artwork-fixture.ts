import { emptyWpsProductionState, importTaskReviews } from '../wps-production';
import { taskReviewFixture } from './task-review-fixture';

export function sharedFixture(count = 3, explicit = false) {
  const review = taskReviewFixture()[0];
  review.source.requirementText = '同一Logo与文字用于三个颜色的左胸';
  review.units = Array.from({ length: count }, (_, index) => ({ ...structuredClone(review.units[0]),
    id: `shared-u${index + 1}`, garmentLabel: `衣服${index + 1}`, instruction: '图1加文字“poppy手机数码”',
    ...(explicit ? { sharedArtworkId: `${review.source.recordId}:artwork:a1` } : {}) }));
  const state = importTaskReviews(emptyWpsProductionState(), [review]);
  if (!explicit) {
    state.sharedArtworks = [];
    state.units = state.units.map(unit => ({ ...unit, sharedArtworkId: undefined, sharedArtworkVersion: undefined }));
  }
  return state;
}
