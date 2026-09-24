import { describe, it, expect } from 'vitest';
import { reviewReason, reviewReach, reviewWhere, reviewTitle } from './review-label.js';
import { reviewFor, REVIEW_REASONS } from './contain.js';
import { normalizeReview } from './data.js';

const flag = (overflow, reason = REVIEW_REASONS.minSize) =>
  reviewFor({ fits: false, overflow: { l: 0, t: 0, r: 0, b: 0, ...overflow } }, reason);

describe('the review flag in words (UX-6)', () => {
  it('says the reason as REVIEW_REASONS words it, capitalised for a line of its own', () => {
    expect(reviewReason(flag({ b: 3 }))).toBe('Cannot fit above minimum size');
    expect(reviewReason(flag({ r: 40 }, REVIEW_REASONS.wideWord))).toBe('Word wider than balloon');
    expect(reviewReason(null)).toBe('');
  });

  it('names every edge the ink crosses, furthest first, in whole px', () => {
    const r = flag({ r: 3.2, b: 11.6 });
    expect(reviewWhere(r)).toBe('12px past the bottom, 4px past the right');
    expect(reviewReach(r)).toBe(12);
  });

  it('keeps top, right, bottom, left for a tie', () => {
    expect(reviewWhere(flag({ l: 5, t: 5 }))).toBe('5px past the top, 5px past the left');
  });

  it('reads a flag loaded from disk with no reason as "no longer fits"', () => {
    const r = normalizeReview({ kind: 'overflow', overflow: { t: 2 } });
    expect(reviewTitle(r)).toBe('Needs review: no longer fits - 2px past the top');
  });

  it('says nothing about edges for a box with no flag', () => {
    expect(reviewWhere(undefined)).toBe('');
    expect(reviewReach(undefined)).toBe(0);
  });
});
