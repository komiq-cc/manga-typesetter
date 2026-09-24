// ===== how far past each edge of its box a box paints =====
//
// Per side, in the box's own frame (before rotation and flip), page px. The
// exact answer is contain.js's `boxInkRect`, which lays the text out; these are
// the answers that do not need a layout, for the places that must not pay for
// one.

import { inkActive, inkBounds, strokeExtent, shadowExtent } from './text-paint.js';

const NONE = Object.freeze({ l: 0, t: 0, r: 0, b: 0 });

// The hand-drawn ink's reach past each edge, with the finish wrapped around it
// (the box's outline bands and the shadows thrown from them - `drawInk`). The
// editor's ink canvas is grown by exactly this on each side. It used to be grown
// by `inkReach` on every side, which measures the overhang above and left of the
// box only - it cannot see the box's size - so a stroke carried past the right
// or the bottom edge was cut off at the canvas edge, while the export, which
// grows its footprint by the far-side overhang too (`layoutBox`), drew it whole.
export function inkOverhang(style, w, h) {
  if (!inkActive(style?.ink)) return NONE;
  const k = inkBounds(style.ink);
  if (!k) return NONE;
  const finish = Math.ceil(strokeExtent(style.strokes) + shadowExtent(style.shadows));
  const side = (v) => Math.ceil(Math.max(0, v)) + finish;
  return { l: side(-k.minX), t: side(-k.minY), r: side(k.maxX - w), b: side(k.maxY - h) };
}
