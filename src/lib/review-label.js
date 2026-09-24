// ===== the "needs review" flag, in words =====
//
// What the editor's badge and the queue's list say about a box's `review` (the
// flag contain.js writes when the text does not fit - see data.js for its
// shape). The reason is already plain words: it is one of REVIEW_REASONS, which
// were written to be shown. What is added here is where the ink goes, in px,
// largest first, because "12px past the bottom" is what tells a letterer which
// edge to pull.

const SIDES = [
  ['t', 'top'],
  ['r', 'right'],
  ['b', 'bottom'],
  ['l', 'left'],
];

// The reason with a capital letter, for a line of its own.
export function reviewReason(review) {
  const r = String(review?.reason ?? '').trim();
  return r ? r[0].toUpperCase() + r.slice(1) : '';
}

// The furthest the ink reaches past any edge, whole px.
export function reviewReach(review) {
  const o = review?.overflow ?? {};
  return Math.max(0, ...SIDES.map(([k]) => Number(o[k]) || 0));
}

// "12px past the bottom, 4px past the right": every edge the ink crosses,
// furthest first; ties keep top, right, bottom, left.
export function reviewWhere(review) {
  const o = review?.overflow ?? {};
  return SIDES.map(([k, name]) => ({ px: Number(o[k]) || 0, name }))
    .filter((s) => s.px > 0)
    .sort((a, b) => b.px - a.px)
    .map((s) => `${s.px}px past the ${s.name}`)
    .join(', ');
}

// The whole thing as one sentence, for a tooltip.
export function reviewTitle(review) {
  const where = reviewWhere(review);
  return `Needs review: ${review?.reason ?? ''}${where ? ` - ${where}` : ''}`;
}
