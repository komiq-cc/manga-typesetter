// ===== how far past each edge of its box a box paints =====
//
// Per side, `{ l, t, r, b }` in page px, in the box's own frame before its
// rotation. The exact answer is contain.js's `boxInkRect`, which lays the text
// out; these are the answers that do not need a layout, for the places that
// must not pay for one.

import { inkActive, inkBounds, strokeExtent, shadowExtent, motionBlurTaps } from './text-paint.js';

const NONE = Object.freeze({ l: 0, t: 0, r: 0, b: 0 });

// The hand-drawn ink's reach past each edge, with the finish wrapped around it
// (the box's outline bands and the shadows thrown from them - `drawInk`). The
// editor's ink canvas is grown by exactly this on each side. It used to be grown
// by `inkReach` on every side, which measures the overhang above and left of the
// box only - it cannot see the box's size - so a stroke carried past the right
// or the bottom edge was cut off at the canvas edge, while the export, which
// grows its footprint by the far-side overhang too (`layoutBox`), drew it whole.
// The whole-text filters are run over that canvas too (`applyTextFilters`), so
// it is grown by how far they carry the ink as well, or a blur or a smear would
// be cut off square at its edge.
export function inkOverhang(style, w, h) {
  if (!inkActive(style?.ink)) return NONE;
  const k = inkBounds(style.ink);
  if (!k) return NONE;
  const finish = strokeExtent(style.strokes) + shadowExtent(style.shadows);
  const g = filterReach(style);
  const side = (v, grow) => Math.ceil(Math.max(0, v) + finish + grow);
  return { l: side(-k.minX, g.x), t: side(-k.minY, g.y), r: side(k.maxX - w, g.x), b: side(k.maxY - h, g.y) };
}

// How far the whole-text filters carry a picture past its own edge, per axis,
// in page px: the blur at three sigma, the smear to its furthest tap along each
// axis, and the crumple by half its span - one after another, as they are run.
function filterReach(style) {
  const blur = 3 * Math.max(0, Number(style.blur) || 0);
  let mx = 0;
  let my = 0;
  if (style.motionBlur?.on) {
    for (const t of motionBlurTaps(style.motionBlur.x, style.motionBlur.y, style.motionBlur.amount)) {
      mx = Math.max(mx, Math.abs(t.dx));
      my = Math.max(my, Math.abs(t.dy));
    }
  }
  const rough = style.roughen?.on ? (Math.abs(Number(style.roughen.amount) || 0) + Math.max(0, Number(style.roughen.grit) || 0)) / 2 : 0;
  return { x: blur + mx + rough, y: blur + my + rough };
}

// Everything the box's style can paint past each edge, on the assumption that
// the glyphs themselves are inside the box: the hand-drawn ink, then outset
// the way `boxInkRect` outsets the glyphs - the outline bands, each shadow
// moved by its OWN offset and spread by its blur (so a shadow thrown down and
// right reaches down and right, not all round), the whole-picture blur at three
// sigma, the smear along each axis to its furthest tap, and the crumple - then
// mirrored with the flip, which mirrors the finished picture. An include mask
// could only take some of it away, and is left out.
//
// Glyphs past the box are the one thing this cannot see without a layout. The
// containment check can, and a box whose glyphs overflow carries the check's
// numbers in `box.review` - see `boxPaintReach` in editor/strip.js, which
// takes the larger of the two per side.
export function styleReach(style, w, h) {
  if (!style) return NONE;
  let x0 = 0;
  let y0 = 0;
  let x1 = w;
  let y1 = h;
  if (inkActive(style.ink)) {
    const k = inkBounds(style.ink);
    if (k) {
      x0 = Math.min(x0, k.minX);
      y0 = Math.min(y0, k.minY);
      x1 = Math.max(x1, k.maxX);
      y1 = Math.max(y1, k.maxY);
    }
  }
  const so = strokeExtent(style.strokes);
  const sil = { x0: x0 - so, y0: y0 - so, x1: x1 + so, y1: y1 + so };
  const u = { ...sil };
  for (const sh of style.shadows ?? []) {
    if (!(Number(sh?.opacity ?? 1) > 0)) continue;
    const dx = Number(sh?.x) || 0;
    const dy = Number(sh?.y) || 0;
    const spread = 2 * Math.max(0, Number(sh?.blur) || 0);
    u.x0 = Math.min(u.x0, sil.x0 + dx - spread);
    u.y0 = Math.min(u.y0, sil.y0 + dy - spread);
    u.x1 = Math.max(u.x1, sil.x1 + dx + spread);
    u.y1 = Math.max(u.y1, sil.y1 + dy + spread);
  }
  // The filters grow the whole of that, one after another, as they do there.
  const { x: gx, y: gy } = filterReach(style);
  const out = {
    l: Math.max(0, gx - u.x0),
    t: Math.max(0, gy - u.y0),
    r: Math.max(0, u.x1 + gx - w),
    b: Math.max(0, u.y1 + gy - h),
  };
  return {
    l: style.flipH ? out.r : out.l,
    r: style.flipH ? out.l : out.r,
    t: style.flipV ? out.b : out.t,
    b: style.flipV ? out.t : out.b,
  };
}
