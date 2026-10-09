// What changed for one box between the file and the app's open under the Rust
// engine. Pure: the dry run's lane decides from it which boxes to paint, and
// the report is counted from it, so the two cannot disagree.
import { predictMiddle } from './dry-metrics.mjs';
import { safeId } from './common.mjs';

/** A box's id, the same string the capture corpus gives it (build-corpus.mjs). */
export function caseIdOf(stem, p, pi, b, bi) {
  return `c.${stem}.p${safeId(String(p.id ?? pi).toLowerCase())}.b${safeId(String(b.id ?? bi).toLowerCase())}`;
}

/**
 * A report id for every stored box, by where it stands in the file
 * (`at(pi, bi)`). The corpus id where the file gives the box one of its own;
 * a box with no id, or with an id another box of the chapter has, is one
 * whose id a load repairs (`loadProjectPages` mints a new one), so the id the
 * open document carries is not the file's: such a box is named by its place.
 * A box is therefore always matched to its partner after the open by where
 * it stands, which is how the loader carries it, and never by an id that the
 * load may have changed.
 */
export const at = (pi, bi) => `${pi}/${bi}`;
export function storedIds(stem, pages) {
  const ids = new Map();
  const used = new Set();
  const repaired = [];
  (pages ?? []).forEach((p, pi) =>
    (p.boxes ?? []).forEach((b, bi) => {
      let id = caseIdOf(stem, p, pi, b, bi);
      if (b.id == null || used.has(id)) {
        id = `c.${stem}.p${safeId(String(p.id ?? pi).toLowerCase())}.at${bi}`;
        repaired.push(id);
      }
      used.add(id);
      ids.set(at(pi, bi), id);
    }),
  );
  return { ids, repaired };
}

/**
 * The open document against the file, box for box: every stored box has a
 * partner at its place, and there is no box the file does not have. Anything
 * else is an error of the run - a row with no partner would be a box whose
 * changes are not counted - and is thrown, naming the chapter and the page.
 */
export function assertPartners(stem, storedPages, openPages, what) {
  const a = storedPages ?? [];
  const b = openPages ?? [];
  if (a.length !== b.length) throw new Error(`${stem}: ${what} has ${b.length} pages where the file has ${a.length}`);
  a.forEach((p, pi) => {
    const n = (p.boxes ?? []).length;
    const m = (b[pi].boxes ?? []).length;
    if (n !== m) throw new Error(`${stem}: ${what} has ${m} boxes on page ${pi + 1} where the file has ${n}`);
  });
}

/**
 * The pages of a stored chapter that the app's loader repairs from the page's
 * picture before anything is fitted (`loadChapter`, library.svelte.js): one
 * whose art was replaced at another size while the chapter was closed
 * (`needsRespace`: its boxes' x, width and size are rescaled), and one with
 * no size at all (measured from the picture). The dry run has no pictures,
 * so it cannot make either repair, and must not say "nothing changed" of a
 * chapter that has such a page.
 */
export function unrepairedPages(record) {
  const out = [];
  (record.pages ?? []).forEach((p, pi) => {
    if (p.needsRespace === true) out.push({ page: pi + 1, why: 'its art was replaced at another size (needsRespace): the open rescales its boxes from the picture' });
    else if (!(p.w > 0) || !(p.h > 0)) out.push({ page: pi + 1, why: 'it has no size: the open measures it from the picture' });
  });
  return out;
}

// A block that is this far from where Safari put it has moved; nearer is the
// two engines' own arithmetic (the app's containment check uses the same half
// pixel, CONTAIN_TOL in contain.js).
export const MOVED_PX = 0.5;
// How near the shift the ink boxes predict must be to the shift seen for the
// ink to be its cause. WebKit steps its ink box by 1/64 px; this is three steps.
export const INK_TOL_PX = 0.05;

const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * @param {object} of
 * @param {object} of.stored the box as the file has it: x, y, w, h, size, review
 * @param {{ state: object, lay: object | null }} of.rust the box after the open, and its lines
 * @param {object | null} of.wk Safari's layout record of the stored box, where the corpus has it
 * @param {object | null} of.font what the engine draws it in
 * @param {string} [of.id] the box's id, for the error below
 *
 * A box with text has a layout under the Rust engine or the run is wrong:
 * one whose layout threw is thrown here, by name. It is never "unchanged".
 */
export function changeOf({ stored, rust, wk, font, id = 'a box' }) {
  const after = rust.state;
  const lay = rust.lay;
  if (lay?.error) throw new Error(`${id}: no layout under the Rust engine (${lay.error})`);
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
  // These metrics were measured directly, before any placement. An altered
  // font-box baseline must not be attributed to ink, and altering blockY or
  // positioned ink cannot alter this prediction.
  const ink = compared && !lines ? predictMiddle(wk.directMetrics, lay.directMetrics) : null;
  const placement = compared ? predictMiddle(wk.directMetrics, lay.directMetrics) : null;
  const out = {
    x, w, size, dy: y, dh: h,
    grew: h > 0, shrank: h < 0,
    newlyFlagged: flaggedAfter && !flaggedBefore,
    unflagged: !flaggedAfter && flaggedBefore,
    flagChanged: flaggedAfter && flaggedBefore && JSON.stringify(after.review.overflow) !== JSON.stringify(stored.review.overflow),
    flaggedBySafari,
    compared, lines, blockDy, blockDx, moved, ink, placement,
    missing: !!font?.missing,
    borrows: !!(font && (font.borrowed.length || font.none.length || font.unread.length)),
  };
  out.any = out.x || out.w || out.size || h !== 0 || y !== 0 || out.newlyFlagged || out.unflagged || out.lines || out.moved;
  return out;
}
