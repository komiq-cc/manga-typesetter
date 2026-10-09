// What changed for one box between the file and the app's open under the Rust
// engine. Pure: the dry run's lane decides from it which boxes to paint, and
// the report is counted from it, so the two cannot disagree.
import { safeId } from './common.mjs';

/** A box's id, the same string the capture corpus gives it (build-corpus.mjs). */
export function caseIdOf(stem, p, pi, b, bi) {
  return `c.${stem}.p${safeId(String(p.id ?? pi).toLowerCase())}.b${safeId(String(b.id ?? bi).toLowerCase())}`;
}

// A block that is this far from where Safari put it has moved; nearer is the
// two engines' own arithmetic (the app's containment check uses the same half
// pixel, CONTAIN_TOL in contain.js).
export const MOVED_PX = 0.5;

const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * @param {object} of
 * @param {object} of.stored the box as the file has it: x, y, w, h, size, review
 * @param {{ state: object, lay: object | null }} of.rust the box after the open, and its lines
 * @param {object | null} of.wk Safari's layout record of the stored box, where the corpus has it
 * @param {object | null} of.font what the engine draws it in
 */
export function changeOf({ stored, rust, wk, font }) {
  const after = rust.state;
  const lay = rust.lay;
  const d = (k) => after[k] - stored[k];
  const x = d('x') !== 0;
  const w = d('w') !== 0;
  const size = stored.size != null && after.size !== stored.size;
  const y = d('y');
  const h = d('h');
  const flaggedBefore = !!stored.review;
  const flaggedAfter = !!after.review;
  // Safari's own verdict on the stored box: the flag the app would write if it
  // opened this file today.
  const flaggedBySafari = wk?.verdict ? !wk.verdict.fits : null;
  const compared = !!(wk && Array.isArray(wk.lines) && lay && Array.isArray(lay.lines));
  const lines = compared && !same(wk.lines, lay.lines);
  // Where the block's top is on the page, before and after.
  let blockDy = null;
  let blockDx = null;
  if (compared && wk.blockY != null && lay.blockY != null) {
    blockDy = after.y + lay.blockY - (stored.y + wk.blockY);
    if (!lines && Array.isArray(wk.lineX) && Array.isArray(lay.lineX)) {
      blockDx = lay.lineX.reduce((worst, v, i) => (Math.abs(v - wk.lineX[i]) > Math.abs(worst) ? v - wk.lineX[i] : worst), 0);
    }
  }
  const moved = (blockDy != null && Math.abs(blockDy) > MOVED_PX) || (blockDx != null && Math.abs(blockDx) > MOVED_PX);
  const out = {
    x, w, size, dy: y, dh: h,
    grew: h > 0, shrank: h < 0,
    newlyFlagged: flaggedAfter && !flaggedBefore,
    unflagged: !flaggedAfter && flaggedBefore,
    flagChanged: flaggedAfter && flaggedBefore && JSON.stringify(after.review.overflow) !== JSON.stringify(stored.review.overflow),
    flaggedBySafari,
    compared, lines, blockDy, blockDx, moved,
    missing: !!font?.missing,
    borrows: !!(font && (font.borrowed.length || font.none.length || font.unread.length)),
  };
  out.any = out.x || out.w || out.size || h !== 0 || y !== 0 || out.newlyFlagged || out.unflagged || out.lines || out.moved;
  return out;
}
