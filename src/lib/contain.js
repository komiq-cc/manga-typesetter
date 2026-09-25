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
//                  blockY, anchorX, indents, lineX, baseY }
//       curved   { s, text, isCurve: true, layout }
//       `opts.cache: false` keeps the layout out of measure.js's memo.
//   placeAtHeight(place, cand)       -> `place` moved to `cand`'s height, for a
//       candidate that differs from the one it was made for in `y`/`h` only.
//       No new layout unless the balloon's rows moved with the anchor.
//   boxInkRect(cand, place?)         -> { x, y, w, h } box-local, or null (no ink).
//       Everything the export paints for the box: glyphs, outline, shadows,
//       hand-drawn ink, blur, smear, roughening, an include mask's cut and the
//       mesh warp, in the frame the user sees (after a flip).
//   containBox(cand, place?)         -> { fits, overflow: { l, t, r, b } } (px, raw)
//   growAround(cand, place?)         -> null when the box fits, or
//       { x, y, w, h, dx, dy }: the box grown around everything it paints, and
//       the translation that carries its ink and mask shapes so nothing moves
//       on the page. For a box with no text in it (OVF-7).
//   inkHeight(cand, place?)          -> the height the box needs for its ink to
//       clear its top and bottom, grown the way `valign` grows it, or 0 when
//       no height would change the verdict. For the grow-only paths, which may
//       only ever make a box taller.
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
//       Manual: auto sizing off, text on a curve, a mesh warp, hand-drawn ink
//       or a mask - `manualReason` names which, in that order.
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
// paints: the stroke bands, the shadows thrown from them, the hand-drawn ink,
// the blurs, the roughening and the mesh (OVF-7, at `boxInkRect`). Every pixel
// the export can make visible counts, and nothing opts out.
//
// Tolerance is half a pixel. Anything under that is antialiasing on the box's
// own edge, and flagging it would make the flag noise.

import {
  applyCase,
  layoutLines,
  lineWidth,
  balloonWidthsFor,
  lineIndents,
  blockYFor,
  baselineInLine,
  blockInk,
  glyphInk,
  textInset,
  contentWidth,
  arcLayout,
  circleLayout,
  pathLayout,
} from './measure.js';
import {
  strokeExtent,
  motionBlurTaps,
  inkActive,
  inkBounds,
  clipActive,
  clipShapesBounds,
} from './text-paint.js';
import { warpActive, affineFromTriangle } from './warp.js';
import { warpPlan } from './warp-paint.js';
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
// auto sizing on, straight text, nothing hand-placed inside it (below), and a
// width to lay out in. Every other box is MANUAL - the user shaped it by hand,
// bent its text along a curve, pulled it through a mesh, drew on it or masked
// it - and a manual box is never touched automatically. It is checked like any
// other and flagged when it overflows, and the flag's "Fit now" is how the user
// asks for the ladder on it.
//
// The warp is a manual marker - as well as something the check counts - because
// its geometry is the user's hand-placed mesh points in box-local px: grow the
// box and the mesh no longer means what they drew. Hand-drawn ink and a mask's
// shapes are the same kind of thing (OVF-7): box-local px measured from the
// box's corner, which the ladder does not carry when it writes the box's new
// rectangle. The text re-anchors inside the grown box; the strokes and the
// mask stay pinned to its corner, so every growth step would slide the user's
// lettering, or the cut-out, against the text it was drawn around. The ladder's
// arithmetic is wrong for them as well: it grows a box by what its ANCHORED text
// needs, and ink past the top or the left of a box moves with that corner
// however far the box grows - so an inked box would grow to its limit for
// nothing, and again on the next edit.
export function isAutoBox(cand) {
  const s = cand?.style;
  if (!s || s.autoHeight === false) return false;
  if (handPlaced(cand)) return false;
  return cand.w > 0;
}

// What makes a box manual whatever its sizing switch says, as the flag names it,
// or null.
function handPlaced(cand) {
  const s = cand?.style;
  if (curvedStyle(s)) return REVIEW_REASONS.curve;
  if (warpActive(s, cand?.w, cand?.h)) return REVIEW_REASONS.warp;
  if (inkActive(s?.ink)) return REVIEW_REASONS.ink;
  if (clipActive(s?.clip)) return REVIEW_REASONS.mask;
  return null;
}

// Why a manual box was left alone, for its flag.
export function manualReason(cand) {
  return handPlaced(cand) ?? REVIEW_REASONS.manual;
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
//   anchorX  the x the canvas draws a line at, with `textAlign` set to the
//            style's alignment: the content box's left edge, right edge or the
//            box's centre - `textInset` in from the box's edge, the padding the
//            editor's `.tbox` lays out inside (measure.js)
//   indents  how far each flush line is set in from that edge to its balloon
//            row's own (`lineIndents`), or null when none is
//   lineX    the x each line is drawn at: `anchorX`, moved in by its indent
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
  const rows = balloonWidthsFor(cand, s, size);
  const lines = layoutLines(text, s, size, contentWidth(cand.w, s), rows, opts);
  const { inks, shift } = blockInk(lines, s, size);
  const blockH = lines.length * lineH;
  const align = s.align === 'left' || s.align === 'right' ? s.align : 'center';
  const inset = textInset(s);
  const anchorX = align === 'left' ? inset : align === 'right' ? cand.w - inset : cand.w / 2;
  const indents = lineIndents(lines, s, size, contentWidth(cand.w, s), rows);
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
    anchorX,
    indents,
    lineX: lines.map((_, i) => anchorX + (indents ? (align === 'left' ? indents[i] : -indents[i]) : 0)),
    baseY: baselineInLine(s, size),
    rowsKey: rows?.key ?? null,
  };
}

// The same placement after a change of height alone. Line breaking reads the
// height only through the balloon's rows, which hang from the point the block is
// anchored to (`balloonWidthsFor`), and a height change anchored by `valign` -
// every height step the ladder and auto height take - leaves that point where
// it is. So only the block's top moves, and the height steps do not pay for a
// fresh layout of an unchanged block. A step the page or the balloon clamped
// moves the anchor, and gets one.
export function placeAtHeight(place, cand) {
  if (place.isCurve) return placeBlock(cand, NO_CACHE);
  if ((balloonWidthsFor(cand, place.s, place.s.size)?.key ?? null) !== place.rowsKey) return placeBlock(cand, NO_CACHE);
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
// nothing. OVF-7 settled what "everything" is: every pixel the export can make
// visible - the letters and their outline and every effect laid on them - with
// no switch to leave any of it out. The pieces, in the order the exporter
// paints them (`renderBoxTexture`, then `warpTexture`):
//
//   the glyphs   each line's ink at its anchor and baseline. A curve's glyphs
//                one by one: each glyph's own ink (`glyphInk` - centred on its
//                anchor, on a middle baseline, the way every curved renderer
//                draws it) turned by the glyph's rotation (OVF-6, below).
//   the ink      the hand-drawn strokes, each one's reach with its tip
//                (`inkBounds`), box-local from the box's corner.
//   the strokes  outset by the outermost band's outer edge (`strokeExtent`) on
//                every side: the bands are round-joined outlines of the glyphs,
//                and the same bands are grown around the ink (`paintFinish`).
//   the shadows  each one that silhouette - glyphs and ink - moved by its own
//                offset and spread by its blur, per direction, so a shadow
//                thrown down and right grows the rectangle down and right and
//                nowhere else. A shadow with no opacity paints nothing and
//                counts for nothing.
//   the blur     the whole picture's gaussian, on every side.
//   the smear    the directional blur: the picture drawn again at every tap of
//                `motionBlurTaps` - the list the exporter draws - so it reaches
//                along each axis as far as the furthest tap does, and across
//                the smear not at all.
//   the crumple  roughening moves each pixel by at most half its `amount` along
//                each axis: `amount` is feDisplacementMap's `scale`, the full
//                span of the displacement (`roughenOffset`).
//   the mask     an include mask shows nothing outside its shapes, so the
//                rectangle is cut to theirs. An exclude mask only takes pixels
//                away from the inside of it, which a rectangle cannot say
//                without the pixels; left as it is, it is still a bound.
//   the mesh     a warped box's finished picture, carried through the mesh
//                (`warpedRect`, below).
//
// Visible means the export can make the pixel non-zero. A gaussian of anything
// inside a rectangle is, three sigma past its edge, at most 1 - Phi(3) = 0.135%
// of full ink - under half of one 8-bit step, so it rounds to nothing - and the
// browsers' three-box approximation of the gaussian stops short of three sigma
// anyway. So the whole-text blur (sigma = `blur`, the filter's own radius) is
// counted three sigma out, which is the reach the exporter pads its canvas by.
// A shadow keeps twice its named blur, the contract's number and the reach
// `shadowExtent` pads for: its sigma is half the blur, so that is four sigma, a
// sigma past the rule. The smear has no tail to cut: every tap is a copy of the
// picture at the tap's weight, and even the faintest - the outermost tap at the
// most iterations, 0.07/33 of the ink - lights over half an 8-bit step, so it
// counts to the last tap.
//
// A flipped box mirrors the finished picture about its centre, so the rectangle
// is mirrored with it, last. Rotation is not applied: the box turns with its
// text, and "inside the box" is a question asked in the box's own frame.
export function boxInkRect(cand, place = placeBlock(cand)) {
  const s = place.s;
  let r = null;
  if (place.isCurve) {
    const cx = cand.w / 2;
    const cy = cand.h / 2;
    for (const g of place.layout) {
      const k = glyphInk(g.ch, s, s.size);
      if (k) r = unite(r, ...turnedInk(k, g.rot, cx + g.x, cy + g.y));
    }
  } else {
    for (let i = 0; i < place.lines.length; i++) {
      const k = place.inks[i];
      if (!k) continue;
      const base = place.blockY + i * place.lineH + place.baseY;
      r = unite(r, place.lineX[i] + k.left, base - k.ascent, place.lineX[i] + k.right, base + k.descent);
    }
  }
  const ink = inkActive(s.ink) ? inkBounds(s.ink) : null;
  if (ink) r = unite(r, ink.minX, ink.minY, ink.maxX, ink.maxY);
  if (!r) return null;
  const so = strokeExtent(s.strokes);
  const sil = grow(r, so, so);
  let u = sil;
  for (const sh of s.shadows ?? []) {
    if (!(Number(sh?.opacity ?? 1) > 0)) continue;
    const dx = Number(sh?.x) || 0;
    const dy = Number(sh?.y) || 0;
    const spread = 2 * Math.max(0, Number(sh?.blur) || 0);
    u = unite(u, sil.x0 + dx - spread, sil.y0 + dy - spread, sil.x1 + dx + spread, sil.y1 + dy + spread);
  }
  const blur = Math.max(0, Number(s.blur) || 0);
  if (blur > 0) u = grow(u, 3 * blur, 3 * blur);
  if (s.motionBlur?.on) {
    let mx = 0;
    let my = 0;
    for (const t of motionBlurTaps(s.motionBlur.x, s.motionBlur.y, s.motionBlur.amount)) {
      mx = Math.max(mx, Math.abs(t.dx));
      my = Math.max(my, Math.abs(t.dy));
    }
    u = grow(u, mx, my);
  }
  if (s.roughen?.on) {
    const d = Math.abs(Number(s.roughen.amount) || 0) / 2;
    u = grow(u, d, d);
  }
  if (clipActive(s.clip) && s.clip.mode === 'include') {
    const m = clipShapesBounds(s.clip.shapes);
    u = m && cut(u, m.minX, m.minY, m.maxX, m.maxY);
    if (!u) return null;
  }
  if (warpActive(s, cand.w, cand.h)) u = warpedRect(u, s.warp, cand.w, cand.h);
  if (s.flipH) u = { ...u, x0: cand.w - u.x1, x1: cand.w - u.x0 };
  if (s.flipV) u = { ...u, y0: cand.h - u.y1, y1: cand.h - u.y0 };
  return { x: u.x0, y: u.y0, w: u.x1 - u.x0, h: u.y1 - u.y0 };
}

const grow = (r, dx, dy) => ({ x0: r.x0 - dx, y0: r.y0 - dy, x1: r.x1 + dx, y1: r.y1 + dy });

// The part of `r` inside the rectangle given, or null when they do not meet.
function cut(r, x0, y0, x1, y1) {
  const out = { x0: Math.max(r.x0, x0), y0: Math.max(r.y0, y0), x1: Math.min(r.x1, x1), y1: Math.min(r.y1, y1) };
  return out.x0 < out.x1 && out.y0 < out.y1 ? out : null;
}

// OVF-7, the mesh. A warp carries the box's finished picture - type, ink and
// every filter above - through its mesh, and the painter draws that as the
// triangles `warpPlan` lays out, each one under the affine map its three
// corners define. The rectangle is carried the same way: cut to each triangle,
// and the corners of each piece mapped by that triangle's own affine. The
// pieces, not the rectangle's edges: a liquify twirl or a handle dragged across
// its neighbours folds the mesh over itself, and then the ink that lands
// furthest out need not come from an edge.
//
// Where this can part from the painter is the band of cells past the box: the
// painter lays it out to its padded canvas and this to the rectangle, and the
// band is one cell deep, so a point in it is interpolated over a different
// span - the same map, read a fraction of a pixel apart under a strong
// perspective. A mesh the painter will not draw at all (`warpPlan` refusing it)
// leaves the box unwarped on both sides.
function warpedRect(u, warp, w, h) {
  const plan = warpPlan(warp, w, h, { x: u.x0, y: u.y0, w: u.x1 - u.x0, h: u.y1 - u.y0 });
  if (!plan) return u;
  let out = null;
  for (const t of plan.tris) {
    const m = affineFromTriangle(t.src, t.dst);
    if (!m) continue;
    for (const [x, y] of clipToRect(t.src, u)) {
      const X = m[0] * x + m[2] * y + m[4];
      const Y = m[1] * x + m[3] * y + m[5];
      out = unite(out, X, Y, X, Y);
    }
  }
  return out ?? u;
}

// A convex polygon cut to an axis-aligned rectangle (Sutherland-Hodgman), as
// the corners of what is left.
function clipToRect(poly, r) {
  let out = poly;
  for (const [axis, edge, keepAbove] of [
    [0, r.x0, true],
    [0, r.x1, false],
    [1, r.y0, true],
    [1, r.y1, false],
  ]) {
    const src = out;
    out = [];
    const inside = (p) => (keepAbove ? p[axis] >= edge : p[axis] <= edge);
    for (let i = 0; i < src.length; i++) {
      const a = src[i];
      const b = src[(i + 1) % src.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) {
        const k = (edge - a[axis]) / (b[axis] - a[axis]);
        out.push([a[0] + k * (b[0] - a[0]), a[1] + k * (b[1] - a[1])]);
      }
    }
    if (!out.length) break;
  }
  return out;
}

// OVF-6. Text on an arc, a ring or a path is drawn glyph by glyph, each one
// translated to its anchor and rotated to the curve (`ctx.rotate(g.rot)` in the
// exporter, `rotate()` on the editor's span), so where its ink lands is the
// glyph's own ink rectangle turned by that angle. The bounds of the four turned
// corners hold every pixel of the glyph at any angle: exact for an upright or a
// quarter-turned glyph, and a little generous for one turned part-way, whose
// ink need not reach its rectangle's corners - a round or slanted letter near
// 45 degrees is the loosest case (about 0.3 em for an italic at the end of an
// arc, in the real-font lane).
//
// What this replaced was a square one and a half em across around every
// anchor, the margin the exporter pads a curved footprint by: generous enough
// never to miss ink and a third of an em or more past it on every side, so a
// ring or an arc inside its box with less than that to spare was flagged, and
// every flag's numbers were the padding's rather than the text's. The review's case was an
// arc whose glyphs span 368px in a box 120 across; it is flagged either way,
// but only these rectangles say by how much.
//
// Canvas rotation, y down: (u, v) goes to (u cos - v sin, u sin + v cos).
function turnedInk(k, rot, ax, ay) {
  const a = Number(rot) || 0;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const u of [k.left, k.right]) {
    for (const v of [-k.ascent, k.descent]) {
      const x = u * cos - v * sin;
      const y = u * sin + v * cos;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return [ax + x0, ay + y0, ax + x1, ay + y1];
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

// ===== the height the ink needs =====
//
// The line boxes are not the ink. `neededHeight` sizes a box as its lines times
// the line height plus the padding, and the glyphs are not bound by that: an
// accented capital rises above the font's ascent, a deep descender drops below
// its descent, a line height under 1 packs the lines tighter than the glyphs
// stand, and the outline and the shadows reach past all of it (OVF-8). So the
// height a box needs is the larger of what its lines need and what its ink
// needs, and this is the second one, read off the same verdict as everything
// else here.
//
// Grown the way the box grows - `valign` anchors it: a centred block gains half
// of any growth on each side, a top-aligned one gains it all at the bottom -
// and only when the verdict is actually failing on an edge a taller box can
// clear. Within the tolerance is inside, and a box the grow-only paths grew for
// a third of a pixel would be every box in a chapter changing height the first
// time it opened. Ink past the edge the block is anchored to is no reason to
// grow: the block moves with that edge.
//
// Once it grows, it grows clear of all of it (see GROW_EPS), as the ladder's
// height step does, so the answer is the same whichever of the two gets there.
export function inkHeight(cand, place = placeBlock(cand)) {
  if (place.isCurve) return 0;
  const s = place.s;
  const o = layoutSides(s, containBox(cand, place).overflow);
  const va = valignOf(s);
  const failing = va === 'middle' ? Math.max(o.t, o.b) : va === 'top' ? o.b : o.t;
  if (!(failing > CONTAIN_TOL)) return 0;
  return cand.h + growFor(heightNeed(s, o));
}

// ===== a box grown around what is pinned to it =====
//
// Hand-drawn ink and a mask's shapes are box-local px measured from the box's
// corner (OVF-7), so they cannot be fitted the way text is: nothing about them
// shrinks, and a box that grows the way the ladder grows it drags them along
// with its corner. What does hold them is the other way round - the box grows
// by what is outside it, on the side it is outside, and they are carried back
// by the same amount, so they stay exactly where they are on the page and only
// the box's own rectangle changes. That is how a box born around its ink is
// made to hold the ink's finish (`addInkBox`), and what "Fit now" does for a
// box that is only ink.
//
// Text does not stay put: it is anchored to the box by `align` and `valign`
// and re-anchors inside the grown box, which is why this is for boxes with no
// text in them. (A box with text is the ladder's.) Nor does anything laid out
// over the box's size rather than pinned to its corner - a curve, a mesh - so
// neither is one of these boxes either. The one thing that does shift is a
// roughened box's grain, which is laid from the box's text stack and moves
// with it; the crumple's reach, which is what the check counts, does not.
//
// The sides are the verdict's, in the frame the user sees - a flipped box's
// left overflow is on its left - and each grows by whole px, clear of the
// overflow (see GROW_EPS). Two things keep everything in place on the page
// whatever the box's flip and rotation are:
//
//   the rectangle   the flip mirrors about the box's centre and the rotation
//                   turns about it, so the centre is what has to move: by half
//                   the difference between the two sides of each pair, turned
//                   with the box (`paintBoxOnPage` turns the picture by
//                   `rotation` about the centre, with the mirror inside).
//   the carry       in the box's own unmirrored frame, the pinned geometry
//                   moves by the growth on the side it is drawn from: the left
//                   one, or the right one under a horizontal flip, which
//                   mirrors the picture's left onto the box's right.
//
// Returns null when the box fits, or `{ x, y, w, h, dx, dy }`: the grown box,
// and the translation that carries the pinned geometry.
export function growAround(cand, place = placeBlock(cand)) {
  const v = containBox(cand, place);
  if (v.fits) return null;
  const side = (o) => (o > CONTAIN_TOL ? growFor(o) : 0);
  const l = side(v.overflow.l);
  const t = side(v.overflow.t);
  const r = side(v.overflow.r);
  const b = side(v.overflow.b);
  const s = cand.style;
  const w = cand.w + l + r;
  const h = cand.h + t + b;
  const a = ((Number(s.rotation) || 0) * Math.PI) / 180;
  const mx = (r - l) / 2;
  const my = (b - t) / 2;
  const cx = cand.x + cand.w / 2 + Math.cos(a) * mx - Math.sin(a) * my;
  const cy = cand.y + cand.h / 2 + Math.sin(a) * mx + Math.cos(a) * my;
  return {
    x: cx - w / 2,
    y: cy - h / 2,
    w,
    h,
    dx: s.flipH ? r : l,
    dy: s.flipV ? b : t,
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
