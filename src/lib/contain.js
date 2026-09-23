// ===== containment: does a box's text stay inside the box =====
//
// API CONTRACT - other modules build on these exact shapes; keep them stable.
//
//   candidate  { x, y, w, h, style, text, fit }
//              A box as plain data: page-px geometry, its normalised style, its
//              RAW text (not case-applied - that happens here) and its balloon
//              fit or null. `boxCandidate(box, text)` builds one from a box.
//              Nothing in this module mutates a candidate, reads the store or
//              touches Svelte state; it is pure over its arguments plus the font
//              metrics measure.js reads.
//   page       { w, h } in page px. `strip` is the longstrip extent
//              `{ top, total }` from editor/strip.js, or null on a paged document.
//
//   placeBlock(cand, opts?)          -> where the block sits, box-local, unzoomed:
//       straight { s, text, isCurve: false, lines, inks, shift, lineH, blockH,
//                  blockY, anchorX, baseY }
//       curved   { s, text, isCurve: true, layout }
//       `opts.cache: false` keeps the layout out of measure.js's memo.
//   placeAtHeight(place, cand)       -> `place` moved to `cand`'s height, for a
//       candidate that differs from the one it was made for in `y`/`h` only.
//       No new layout: line breaking does not read the height.
//   boxInkRect(cand, place?)         -> { x, y, w, h } box-local, or null (no ink)
//   containBox(cand, place?)         -> { fits, overflow: { l, t, r, b } } (px, raw)
//   fitBox(cand, { page, strip, minSize, geometry })
//                                    -> { x, y, w, h, size, fits, overflow, review }
//       The ladder, run once: grow the height, then the width, within
//       `fitLimit`, then shrink the size no lower than `minSize`. `geometry:
//       false` locks x/y/w/h and only searches the size. Returns what to write
//       back; the caller writes it. A review it returns names why it gave up:
//       `alignedEdge` (ink past the edge the text is anchored to), `wideWord` (a
//       single word wider than the most room it could have) or `minSize`.
//   reviewFor(verdict, reason)       -> null | box.review
//   isAutoBox(cand), manualReason(cand), fitLimit(cand, page, strip)
//   REVIEW_REASONS, CONTAIN_TOL
//
//   box.review = { kind: 'overflow', overflow: { l, t, r, b }, reason } - absent
//   when the box fits. The shape and the reasons are data.js's (`normalizeReview`).
//
// ---------------------------------------------------------------------------
//
// The user's rule is short: text never goes outside its text box. It is not
// clipped to get there - `overflow: hidden` hides the user's words and hides the
// problem - so every box either fits or says it does not. This module is where
// "fits" is decided, in one place, for every path that asks: the store after an
// edit, the store on a chapter opening, the exporter and the PSD writer (which
// lay the block out through `placeBlock` so the check and the paint cannot
// describe two different blocks).
//
// "Fits" is about PIXELS, not line boxes. The ink is each line's own bounding
// box off `measureText` - which is where an italic's overhang, a J's tail, an
// accented capital and a letter-spaced line's real extent all show up - placed
// exactly where the exporter draws it, then outset by everything else that
// paints: the stroke bands and the shadows thrown from them.
//
// Tolerance is half a pixel. Anything under that is antialiasing on the box's
// own edge, and flagging it would make the flag noise.

import {
  applyCase,
  layoutLines,
  lineWidth,
  balloonWidthsFor,
  blockYFor,
  baselineInLine,
  blockInk,
  textInset,
  contentWidth,
  arcLayout,
  circleLayout,
  pathLayout,
} from './measure.js';
import { strokeExtent } from './text-paint.js';
import { warpActive } from './warp.js';
import { shapeBounds } from './balloon.js';
import { neededHeight } from './typeset.js';
import { normalizeFit, REVIEW_REASONS } from './data.js';

export { REVIEW_REASONS };

export const CONTAIN_TOL = 0.5;

// Probes the ladder makes that it may throw away. See `layoutLines`.
const NO_CACHE = { cache: false };

// A box as the functions below take it.
export function boxCandidate(box, text) {
  return { x: box.x, y: box.y, w: box.w, h: box.h, style: box.style, text, fit: box.fit ?? null };
}

// Glyph-by-glyph text - the bezier path, the closed ring, the arc - in the
// precedence every renderer states (path > circle > arc). A style question only;
// whether there is text to put on the curve is `placeBlock`'s.
function curvedStyle(s) {
  return !!((s?.path?.on && (s.path.pts?.length ?? 0) >= 2) || s?.circle?.on || (s?.curve && s.curve !== 0));
}

// ===== auto and manual =====
//
// An AUTO box is one the app may move, resize and shrink to make its text fit:
// auto sizing on, straight text, no mesh warp, and a width to lay out in. Every
// other box is MANUAL - the user shaped it by hand, bent its text along a curve,
// or pulled it through a mesh - and a manual box is never touched
// automatically. It is checked like any other and flagged when it overflows,
// and the flag's "Fit now" is how the user asks for the ladder on it.
//
// The warp is a manual marker rather than one more effect to count because its
// geometry is the user's hand-placed mesh points in box-local px: grow the box
// and the mesh no longer means what they drew.
export function isAutoBox(cand) {
  const s = cand?.style;
  if (!s || s.autoHeight === false) return false;
  if (curvedStyle(s)) return false;
  if (warpActive(s, cand.w, cand.h)) return false;
  return cand.w > 0;
}

// Why a manual box was left alone, for its flag.
export function manualReason(cand) {
  const s = cand?.style;
  if (curvedStyle(s)) return REVIEW_REASONS.curve;
  if (warpActive(s, cand?.w, cand?.h)) return REVIEW_REASONS.warp;
  return REVIEW_REASONS.manual;
}

// ===== where the block sits =====
//
// Extracted from the raster exporter's `layoutBox`, which drew from exactly
// these numbers, so that the exporter, the PSD writer and the containment check
// all read one statement of them. Box-local and unzoomed: the check is a fact
// about the document, and a zoom level must never change the verdict.
//
// For straight text:
//   lines    the broken lines, through `layoutLines` with the same arguments
//            the editor passes - the content width is `contentWidth`, the box
//            less its padding and its outline's reach - so all three break in
//            the same places
//   inks     each line's ink off `lineInk`, measured once (`blockInk`)
//   shift    the ink-centring shift for a middle-aligned block
//   blockY   the block's top inside the box (`blockYFor`)
//   anchorX  the x the canvas draws each line at, with `textAlign` set to the
//            style's alignment: the content box's left edge, right edge or the
//            box's centre - `textInset` in from the box's edge, the padding the
//            editor's `.tbox` lays out inside (measure.js)
//   baseY    each baseline's offset inside its line box
//
// For curves, the glyph layout, positions relative to the box centre.
export function placeBlock(cand, opts) {
  const s = cand.style;
  const size = s.size;
  const text = applyCase(String(cand.text ?? ''), s);
  const blank = text.trim() === '';
  const isPath = !blank && s.path?.on && (s.path.pts?.length ?? 0) >= 2;
  const isCircle = !blank && !isPath && s.circle?.on;
  if (isPath || isCircle || (!blank && s.curve && s.curve !== 0)) {
    const layout = isPath
      ? pathLayout(text, s, size, cand.w, cand.h)
      : isCircle
        ? circleLayout(text, s, size)
        : arcLayout(text, s, size);
    return { s, text, isCurve: true, layout };
  }
  // Guarded as `neededHeight` and `baselineInLine` guard it, so a style missing
  // the field is one line height to every reader rather than 0 to one of them.
  const lineH = size * (s.lineHeight > 0 ? s.lineHeight : 1);
  const lines = layoutLines(text, s, size, contentWidth(cand.w, s), balloonWidthsFor(cand, s, size), opts);
  const { inks, shift } = blockInk(lines, s, size);
  const blockH = lines.length * lineH;
  const align = s.align === 'left' || s.align === 'right' ? s.align : 'center';
  const inset = textInset(s);
  return {
    s,
    text,
    isCurve: false,
    lines,
    inks,
    shift,
    lineH,
    blockH,
    blockY: blockYFor(s, cand.h, blockH, shift),
    anchorX: align === 'left' ? inset : align === 'right' ? cand.w - inset : cand.w / 2,
    baseY: baselineInLine(s, size),
  };
}

// The same placement after a change of height alone. Line breaking does not
// read the height - the balloon's per-line widths come off the shape, not the
// box - so only the block's top moves, and the ladder's height steps do not pay
// for a fresh layout of an unchanged block.
export function placeAtHeight(place, cand) {
  if (place.isCurve) return placeBlock(cand, NO_CACHE);
  return { ...place, blockY: blockYFor(place.s, cand.h, place.blockH, place.shift) };
}

// ===== the ink =====
//
// A rectangle, box-local, as `{x0, y0, x1, y1}` while it is being built.
const unite = (r, x0, y0, x1, y1) =>
  r
    ? { x0: Math.min(r.x0, x0), y0: Math.min(r.y0, y0), x1: Math.max(r.x1, x1), y1: Math.max(r.y1, y1) }
    : { x0, y0, x1, y1 };

// Everything the box paints, as one box-local rectangle, or null when it paints
// nothing. The pieces, in the order the exporter paints them:
//
//   the glyphs   each line's ink at its anchor and baseline. A curve's glyphs,
//                one generous square per glyph around its anchor - the margin
//                the exporter pads a curved footprint by.
//   the strokes  outset by the outermost band's outer edge (`strokeExtent`) on
//                every side: the bands are round-joined outlines of the glyphs.
//   the shadows  each one the stroked silhouette moved by its own offset and
//                spread by its blur - per direction, so a shadow thrown down
//                and right grows the rectangle down and right and nowhere else.
//                The spread is twice the named blur, the same reach
//                `shadowExtent` gives it (the painter blurs at sigma = blur/2,
//                and a gaussian has let go by four sigma). A shadow with no
//                opacity paints nothing and counts for nothing.
//
// A flipped box mirrors the finished picture about its centre, so the rectangle
// is mirrored with it. Rotation is not applied: the box turns with its text, and
// "inside the box" is a question asked in the box's own frame.
export function boxInkRect(cand, place = placeBlock(cand)) {
  const s = place.s;
  let r = null;
  if (place.isCurve) {
    const cx = cand.w / 2;
    const cy = cand.h / 2;
    const half = s.size * 0.75;
    for (const g of place.layout) r = unite(r, cx + g.x - half, cy + g.y - half, cx + g.x + half, cy + g.y + half);
  } else {
    for (let i = 0; i < place.lines.length; i++) {
      const k = place.inks[i];
      if (!k) continue;
      const base = place.blockY + i * place.lineH + place.baseY;
      r = unite(r, place.anchorX + k.left, base - k.ascent, place.anchorX + k.right, base + k.descent);
    }
  }
  if (!r) return null;
  const so = strokeExtent(s.strokes);
  const sil = { x0: r.x0 - so, y0: r.y0 - so, x1: r.x1 + so, y1: r.y1 + so };
  let u = sil;
  for (const sh of s.shadows ?? []) {
    if (!(Number(sh?.opacity ?? 1) > 0)) continue;
    const dx = Number(sh?.x) || 0;
    const dy = Number(sh?.y) || 0;
    const spread = 2 * Math.max(0, Number(sh?.blur) || 0);
    u = unite(u, sil.x0 + dx - spread, sil.y0 + dy - spread, sil.x1 + dx + spread, sil.y1 + dy + spread);
  }
  if (s.flipH) u = { ...u, x0: cand.w - u.x1, x1: cand.w - u.x0 };
  if (s.flipV) u = { ...u, y0: cand.h - u.y1, y1: cand.h - u.y0 };
  return { x: u.x0, y: u.y0, w: u.x1 - u.x0, h: u.y1 - u.y0 };
}

// The verdict: how far the ink reaches past each edge of the box, and whether
// all four are within tolerance. The overflow is raw px, in the box's own frame
// as the user sees it (a flipped box's left overflow is on its left).
export function containBox(cand, place = placeBlock(cand)) {
  const ink = boxInkRect(cand, place);
  if (!ink) return { fits: true, overflow: { l: 0, t: 0, r: 0, b: 0 } };
  const overflow = {
    l: Math.max(0, -ink.x),
    t: Math.max(0, -ink.y),
    r: Math.max(0, ink.x + ink.w - cand.w),
    b: Math.max(0, ink.y + ink.h - cand.h),
  };
  const fits =
    overflow.l <= CONTAIN_TOL && overflow.t <= CONTAIN_TOL && overflow.r <= CONTAIN_TOL && overflow.b <= CONTAIN_TOL;
  return { fits, overflow };
}

// The flag for a verdict, or null when it fits. Whole px rounded up, and an edge
// inside the tolerance reads 0, so a badge never says "0.3px".
export function reviewFor(verdict, reason) {
  if (!verdict || verdict.fits) return null;
  const px = (v) => (v > CONTAIN_TOL ? Math.ceil(v) : 0);
  const o = verdict.overflow;
  return {
    kind: 'overflow',
    overflow: { l: px(o.l), t: px(o.t), r: px(o.r), b: px(o.b) },
    reason: reason || REVIEW_REASONS.stale,
  };
}

// ===== how far a box may grow =====
//
// The balloon it was fitted to - its bounding box - intersected with the page,
// or with the whole strip in a longstrip document, where a box may hang over a
// page seam. A box with no fit, or whose style has balloon layout switched off,
// is limited by the page alone.
//
// Never smaller than the box: a box the user made bigger than its balloon keeps
// that size, since nothing here shrinks a box, and a limit that excluded the box
// would read as "no room" when the room is simply the box's own.
export function fitLimit(cand, page, strip) {
  const pw = Number(page?.w) || 0;
  const ph = Number(page?.h) || 0;
  let x0 = 0;
  let x1 = pw > 0 ? pw : Infinity;
  let y0 = 0;
  let y1 = ph > 0 ? ph : Infinity;
  if (strip && strip.total > 0) {
    y0 = -strip.top;
    y1 = strip.total - strip.top;
  }
  const shape = cand.style?.balloon === false ? null : normalizeFit(cand.fit);
  const sb = shape ? shapeBounds(shape) : null;
  if (sb) {
    x0 = Math.max(x0, sb.x);
    y0 = Math.max(y0, sb.y);
    x1 = Math.min(x1, sb.x + sb.w);
    y1 = Math.min(y1, sb.y + sb.h);
  }
  return {
    x0: Math.min(x0, cand.x),
    y0: Math.min(y0, cand.y),
    x1: Math.max(x1, cand.x + cand.w),
    y1: Math.max(y1, cand.y + cand.h),
  };
}

// ===== the ladder =====
//
// For an auto box that does not fit, in this order, checking again after every
// step:
//
//   1. grow the height, anchored by `valign`, within the limit;
//   2. grow the width symmetrically within the limit, lay the text out again at
//      the new width, and go back to 1;
//   3. shrink the font, by binary search, no lower than `minSize`;
//   4. still no fit - flag it.
//
// Height first because it costs the reader nothing: the lines stay where they
// broke. Width next because a wider box re-breaks the text into fewer, longer
// lines, which is still the size the user chose. The size last, because it is
// the one the reader notices.
//
// The growth steps are exact rather than searched. Line breaking ignores the
// height, so the height a block needs follows from its overflow: a centred
// block gains half of any growth on each side, so it needs twice its worse
// side; a top-aligned block gains the whole growth at the bottom and none at
// the top. The width is the same arithmetic on the alignment. What cannot be
// grown away is the overflow on the edge the text is ANCHORED to - the top of
// a top-aligned block, the left of left-aligned text - since the text moves
// with that edge; that is its own reason on the flag.
//
// A box whose height is capped by the limit and still runs out of room at the
// bottom can still fit by being wider, which is the widest the ladder searches:
// the smallest width that fits, by binary search up to the limit's, so the box
// grows no more than the text needs.
//
// When nothing fits, the box keeps the growth (it is closer to fitting, and the
// flag says by how much) and its OWN size - never a shrink that did not buy a
// fit. That also makes the ladder idempotent: run again on its own answer it
// changes nothing, which is what lets it sit behind a reactive effect.
//
// Bounded: at most GROW_STEPS growth steps per size, a width search of log2 of
// the page width, and a size search of log2 of the shrink range in half-px
// steps. The size search probes each size at the largest box the limit allows,
// which answers "can this size fit at all" in one layout; only the size it
// settles on is grown step by step to the smallest box that holds it.
const GROW_STEPS = 6;
const SIZE_STEP = 0.5;
// The growth steps clear ALL of the overflow they can reach, not just what is
// over the tolerance. The tolerance is for the verdict - a box whose ink is a
// third of a pixel over its edge is not worth a flag - but a box the ladder is
// already growing may as well grow clear of it: a raster lays the box's far
// edges on a fractional pixel, and a third of a pixel of glyph there can light a
// whole pixel past the box. This much is float noise, and growing for it would
// only make a fit that never settles.
const GROW_EPS = 0.01;

const alignOf = (s) => (s.align === 'left' || s.align === 'right' ? s.align : 'center');
const valignOf = (s) => (s.valign === 'middle' || s.valign === 'bottom' ? s.valign : 'top');

// The overflow in the LAYOUT's frame, before a flip mirrored it: the ladder
// reasons about which edge the text is anchored to, and that is the unflipped
// one.
function layoutSides(s, o) {
  return {
    l: s.flipH ? o.r : o.l,
    r: s.flipH ? o.l : o.r,
    t: s.flipV ? o.b : o.t,
    b: s.flipV ? o.t : o.b,
  };
}

// How much taller / wider the box must be to clear the overflow it can clear.
function heightNeed(s, o) {
  const va = valignOf(s);
  return va === 'middle' ? 2 * Math.max(o.t, o.b) : va === 'top' ? o.b : o.t;
}
function widthNeed(s, o) {
  const al = alignOf(s);
  return al === 'center' ? 2 * Math.max(o.l, o.r) : al === 'left' ? o.r : o.l;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const withSize = (cand, size) => (size === cand.style.size ? cand : { ...cand, style: { ...cand.style, size } });

// Whole pixels of growth for an overflow, less the noise allowance, so 1.004px
// over is one pixel of growth rather than two.
const growFor = (over) => Math.ceil(over - GROW_EPS);

// One height step: at least the line boxes inside the content box (what auto
// height gives), plus whatever the ink still needs. Null when it would not grow.
function heightStep(c, place, o, limit) {
  const s = place.s;
  const lineNeed = place.isCurve ? 0 : neededHeight(place.lines.length, s, textInset(s));
  const over = heightNeed(s, o);
  const want = Math.max(lineNeed, over > GROW_EPS ? c.h + growFor(over) : 0);
  const newH = Math.min(want, limit.y1 - limit.y0);
  if (!(newH > c.h)) return null;
  const grow = newH - c.h;
  const va = valignOf(s);
  const y = va === 'top' ? c.y : va === 'bottom' ? c.y - grow : c.y - grow / 2;
  return { ...c, y: clamp(y, limit.y0, limit.y1 - newH), h: newH };
}

// One width step, symmetric about the box's centre. Null when it would not grow.
function widthStep(c, place, o, limit) {
  const over = widthNeed(place.s, o);
  if (!(over > GROW_EPS)) return null;
  return widenTo(c, c.w + growFor(over), limit);
}
function widenTo(c, w, limit) {
  const newW = Math.min(w, limit.x1 - limit.x0);
  if (!(newW > c.w)) return null;
  const x = c.x - (newW - c.w) / 2;
  return { ...c, x: clamp(x, limit.x0, limit.x1 - newW), w: newW };
}

// Steps 1 and 2, from `c` as it stands, at its own size.
function growLoop(c, limit, first) {
  let place = placeBlock(c, first ? undefined : NO_CACHE);
  let v = containBox(c, place);
  for (let i = 0; i < GROW_STEPS; i++) {
    const o = layoutSides(place.s, v.overflow);
    const hs = heightStep(c, place, o, limit);
    if (hs) {
      c = hs;
      place = placeAtHeight(place, c);
      v = containBox(c, place);
      continue;
    }
    const ws = widthStep(c, place, o, limit);
    if (!ws) break;
    c = ws;
    place = placeBlock(c, NO_CACHE);
    v = containBox(c, place);
  }
  return { c, place, v };
}

// Whether what is left over is overflow the growth steps could still clear -
// on an edge the text is not anchored to.
function clearable(place, v) {
  if (v.fits) return false;
  const o = layoutSides(place.s, v.overflow);
  return heightNeed(place.s, o) > CONTAIN_TOL || widthNeed(place.s, o) > CONTAIN_TOL;
}

// Steps 1 and 2 at one size, ending at the smallest box that holds the text, or
// the loop's own best when none does.
function growAt(cand, size, limit, first) {
  const c0 = withSize(cand, size);
  const r = growLoop(c0, limit, first);
  if (r.v.fits || !clearable(r.place, r.v)) return r;
  const maxW = limit.x1 - limit.x0;
  if (!Number.isFinite(maxW) || !(maxW > r.c.w + 1)) return r;
  // Room across but not down: the widest box first, and only a search when
  // the widest one fits.
  const tryW = (w) => {
    const c = widenTo(c0, w, limit);
    return c ? growLoop(c, limit, false) : null;
  };
  let best = tryW(maxW);
  if (!best?.v.fits) return r;
  let lo = Math.floor(r.c.w);
  let hi = Math.floor(maxW);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const t = tryW(mid);
    if (t?.v.fits) {
      hi = mid;
      best = t;
    } else lo = mid;
  }
  return best;
}

// Can the text fit at this size at all? Asked of the largest box the limit
// allows, which is one layout rather than a ladder.
function fitsAtAll(cand, size, limit, locked) {
  const c = withSize(cand, size);
  if (locked) return containBox(c, placeBlock(c, NO_CACHE)).fits;
  const W = limit.x1 - limit.x0;
  const H = limit.y1 - limit.y0;
  if (!Number.isFinite(W) || !Number.isFinite(H)) return growAt(cand, size, limit, false).v.fits;
  const big = { ...c, x: limit.x0, y: limit.y0, w: W, h: H };
  return containBox(big, placeBlock(big, NO_CACHE)).fits;
}

// ===== a word wider than its box (OVF-4) =====
//
// The shaped breaker keeps every word whole unless it can hyphenate it, and it
// only invents a hyphen inside a plain A-Z word with a vowel on both sides of
// the break (typeset.js). Anything else - an SFX with no vowels, "KRRSSHH!!", a
// word with an apostrophe or an accent in it, a Hangul word, a CJK sentence with
// no spaces - is one token however long it is, and a line of one token is
// allowed to be wider than the width it was broken to, because the only other
// thing the breaker could do with it is drop it. On its own line it runs past
// both sides of a centred box.
//
// The ladder's width step is what makes room for it: the box widens within its
// balloon by what the ink needs, and then the size comes down. When neither is
// enough, the flag should say it is the WORD that does not fit rather than the
// text: "cannot fit above minimum size" reads as too many words, which a
// letterer answers by cutting some, when the answer here is a break the breaker
// cannot invent, a shorter word, or a smaller size set by hand.
//
// A line counts when it is a single token and the breaker's own measure of it
// (`lineWidth`) is wider than the content box it was broken to - the advance,
// not the ink, so an italic's lean past a word that does fit is not one.
function hasWideWord(cand, place) {
  if (place.isCurve) return false;
  const room = contentWidth(cand.w, place.s) + GROW_EPS;
  return place.lines.some((line) => {
    const word = line.trim();
    return word !== '' && !/\s/.test(word) && lineWidth(word, place.s, place.s.size) > room;
  });
}

// Why the ladder gave up on what it was left with: overflow it cannot reach, on
// the edge the text is anchored to; or room it ran out of - for one word
// (above), or for the text as a whole.
function failReason(cand, place, v) {
  if (!clearable(place, v)) return REVIEW_REASONS.alignedEdge;
  const o = layoutSides(place.s, v.overflow);
  if (widthNeed(place.s, o) > CONTAIN_TOL && hasWideWord(cand, place)) return REVIEW_REASONS.wideWord;
  return REVIEW_REASONS.minSize;
}

export function fitBox(cand, opts = {}) {
  const locked = opts.geometry === false;
  const limit = fitLimit(cand, opts.page, opts.strip);
  const size0 = cand.style.size;
  const result = (r, review) => ({
    x: r.c.x,
    y: r.c.y,
    w: r.c.w,
    h: r.c.h,
    size: r.c.style.size,
    fits: r.v.fits,
    overflow: r.v.overflow,
    review,
  });
  const at = (size, first) => {
    if (!locked) return growAt(cand, size, limit, first);
    const c = withSize(cand, size);
    const place = placeBlock(c, first ? undefined : NO_CACHE);
    return { c, place, v: containBox(c, place) };
  };

  const own = at(size0, true);
  if (own.v.fits) return result(own, null);

  // Step 3. Half-px steps between the floor (rounded up onto the grid) and the
  // box's own size, which is known not to fit.
  const floor = Math.ceil((Number(opts.minSize) || 0) / SIZE_STEP) * SIZE_STEP;
  if (floor > 0 && floor < size0 && fitsAtAll(cand, floor, limit, locked)) {
    let lo = floor;
    let hi = size0;
    while (hi - lo > SIZE_STEP) {
      const mid = Math.ceil((lo + hi) / 2 / SIZE_STEP) * SIZE_STEP;
      if (!(mid > lo && mid < hi)) break;
      if (fitsAtAll(cand, mid, limit, locked)) lo = mid;
      else hi = mid;
    }
    const r = at(lo, false);
    if (r.v.fits) return result(r, null);
  }
  // Step 4.
  return result(own, reviewFor(own.v, failReason(own.c, own.place, own.v)));
}
