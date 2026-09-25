// Shared text measurement + line wrapping (used by curved rendering and export).
import { fontCssFor } from './store.svelte.js';
import { balanceLines, neededHeight, balancedBlockSize, BALANCED_DEFAULTS } from './typeset.js';
import { interiorLineWidths } from './balloon.js';
import { normalizeFit } from './data.js';
import { strokeExtent } from './text-paint.js';

const _c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const _ctx = _c ? _c.getContext('2d') : null;

// Whether this environment can actually measure text. Node cannot, and every
// function below falls back to a stand-in metric there so nothing throws - but a
// stand-in is fine for laying out a line and not fine for writing a number into
// the user's document, so the auto-height path asks this first.
export function canMeasure() {
  return _ctx != null;
}

// The bare padding a text box lays out inside, on every edge, before its
// outline is counted - see `textInset`, which is what every renderer actually
// pads by. 2px, scaled with zoom in the editor so wrapping is zoom-stable.
export const BOX_PAD = 2;

// The box's CONTENT BOX: the box inset by this much on every side, in every
// renderer. The padding plus the outline's reach, rounded up to a whole pixel,
// so text laid out to the content box - a line that fills its width, a block
// anchored to its top, a block the auto height sized - has its outline inside
// the box as well as its glyphs.
//
// It used to be the padding alone, and the default outline is 3px against 2px of
// padding: every line the breaker filled to the width had a pixel of its outline
// outside the box, every left-aligned line starting on a letter with little or
// no side bearing (T, J, W) - and every right-aligned one ending on one - had it
// outside on the edge it was aligned to, where no growth can clear it, and every
// auto height was a pixel short of its outline above and below (OVF-3). The outline is part of the lettering the reader sees - "inside
// the box" is about what is painted, not about the glyphs' advances - so the
// layout has to leave room for it, and the room is the outline's own width.
// Rounded up so a fractional outline is never the reason a stroked line sits a
// fraction of a pixel over the edge.
//
// One rule, read by everything that places text in a box, because they all have
// to draw the same picture:
//   the editor     `.tbox` is padded by it (TextBox.svelte, scaled with zoom),
//                  so its flex layout and text-align put the block there;
//   the width      `contentWidth` below: the lines are broken to it, by the
//                  editor, `placeBlock` and the balloon's per-line widths;
//   the anchors    `placeBlock`'s x for left- and right-aligned lines, and
//                  `blockYFor`'s top and bottom;
//   the height     auto height pads the block by it (`neededHeight`'s pad), and
//                  so does the balanced size a new box is placed at;
//   the exports    the raster exporter through `placeBlock`, and the PSD type
//                  layer's origin and frame - with its importer undoing it.
export function textInset(style) {
  return BOX_PAD + Math.ceil(strokeExtent(style?.strokes));
}
export function contentWidth(boxW, style) {
  return Math.max(1, boxW - textInset(style) * 2);
}

// Where a text block's top edge sits inside its box, as an offset from the
// box's top-left, for straight (non-curved) text. `blockH` is the block's own
// height - line count times line height.
//
// Anything other than 'middle' or 'bottom' is the top, `undefined` included:
// a partial style with no `valign` at all reaches this from the PSD writer,
// and it has to answer the same way the exporter always has.
//
// Stated once here because three places need it and they have to agree: the
// raster exporter draws from it (layoutBox in exporter.js), the auto-height
// helper sizes boxes with it, and the PSD writer anchors a live Photoshop type
// layer with it. When the writer did NOT - it anchored every type layer at
// the top - a middle- or bottom-aligned box exported pixels the app agreed with
// and engine data it did not, and the words jumped upward the moment Photoshop
// re-rendered the layer.
//
// The top and bottom are the content box's (`textInset`), which is where the
// editor's padded flex layout puts a top- or bottom-aligned block.
//
// `inkShift` is the correction `inkShiftY` below works out, and it applies to
// the middle alignment only: a centred block is centred on its INK, which is the
// thing the reader sees centred in the bubble. Top and bottom stay anchored by
// their line boxes - a top-aligned block is aligned to an edge, and nudging it
// by its own ascender would move it off that edge.
export function blockYFor(style, boxH, blockH, inkShift = 0) {
  if (style?.valign === 'middle') return (boxH - blockH) / 2 + (Number(inkShift) || 0);
  if (style?.valign === 'bottom') return boxH - textInset(style) - blockH;
  return textInset(style);
}

// ---- where the glyphs sit inside a line box ----
//
// A line box is `size * lineHeight` tall, and the browser puts the font's
// content area - its ascent plus its descent, which is NOT the font size - in
// the middle of it, with half the leading above and half below. The baseline is
// therefore `halfLeading + ascent` below the top of the line box, and that is
// the number the raster exporter has to draw at if the PNG is to be the picture
// on the canvas. It used to draw the em SQUARE centred instead (`textBaseline:
// 'top'` at `(lineH - size) / 2`), which lands the baseline `(ascent + descent -
// size) / 2` lower than the editor's - 2px for Arial at 40px, and 5px or more
// for the comic faces whose vertical metrics run to 1.3 of the size.
//
// The metrics are the font's own, read off `measureText` - Chrome's
// `fontBoundingBoxAscent`/`Descent` are the same ascent and descent its layout
// engine builds line boxes from. A stand-in of 0.8/0.2 of the size where there
// is no canvas or the browser predates the property, so the function is total.
export function fontMetrics(style, sizePx) {
  const size = sizePx > 0 ? sizePx : 0;
  const fallback = { ascent: size * 0.8, descent: size * 0.2 };
  if (!_ctx || !(size > 0)) return fallback;
  _ctx.font = fontShorthand(style, size, familyFor(style));
  const m = _ctx.measureText('Hg');
  const a = m.fontBoundingBoxAscent;
  const d = m.fontBoundingBoxDescent;
  return a >= 0 && d >= 0 ? { ascent: a, descent: d } : fallback;
}

// The baseline's offset from the top of its line box, as the browser lays it.
export function baselineInLine(style, sizePx) {
  const lineH = sizePx * (style?.lineHeight > 0 ? style.lineHeight : 1);
  const { ascent, descent } = fontMetrics(style, sizePx);
  return (lineH - (ascent + descent)) / 2 + ascent;
}

// How far a middle-aligned block has to move so that its INK is centred rather
// than its line boxes. Positive is down.
//
// The block is `lines * lineH` tall and the box centres that rectangle, but the
// rectangle is not what the reader sees: an all-caps line has nothing below the
// baseline and a whole descender's worth of empty line box under it, so its
// letters sit high; a last line ending in "Jumpy" hangs its tails into the
// leading, so the block sits low. Measured across Chrome's system faces at 40px
// the drift is under 2px for capitals and 2 to 7px - five to seventeen percent
// of the size - once descenders are involved, and the comic faces this app is
// used with have wilder ascent/descent than any of those. TyperTools, the
// Photoshop plugin every scanlation group has used, sidesteps all of it by
// reading the rendered layer's pixel bounds and centring THOSE on the bubble;
// this is the same rule, computed from the glyph metrics instead of from pixels
// so that the editor, the exporter and the PSD writer can each apply it before
// anything is drawn.
//
// Every line is looked at rather than just the first and the last, because at a
// tight leading a tall glyph on the second line can outreach a line of dots on
// the first. Zero where there is nothing to measure: no canvas (the node test
// runner, where every metric is a stand-in and a shift written into a document
// from one would be a lie), or a block with no ink in it.
export function inkShiftY(lines, style, sizePx) {
  return blockInk(lines, style, sizePx).shift;
}

// Every line's ink (`lineInk`) and the centring shift above, from ONE
// measurement per line. The shift needs each line's ascent and descent, and the
// containment check in contain.js needs each line's whole ink box; asked
// separately that is every line measured twice for every box, and the fitting
// ladder asks for every candidate it tries. So the two answers come out of the
// same pass, and `inkShiftY` is this function with the boxes thrown away - which
// also makes "the exporter centres on the ink the check measured" true by
// construction.
//
// The shift keeps its old refusals exactly: no canvas, a browser without ink
// metrics, or a line whose ink lies wholly above or below its baseline (a row of
// underscores has a negative ascent) gives a shift of zero for the whole block,
// as it always has.
export function blockInk(lines, style, sizePx) {
  const list = Array.isArray(lines) ? lines : [];
  const inks = list.map((ln) => lineInk(ln, style, sizePx));
  if (!_ctx || list.length === 0 || !(sizePx > 0)) return { inks, shift: 0 };
  const lineH = sizePx * (style?.lineHeight > 0 ? style.lineHeight : 1);
  const base = baselineInLine(style, sizePx);
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < inks.length; i++) {
    const k = inks[i];
    if (!k) continue;
    if (k.approx || !(k.ascent >= 0) || !(k.descent >= 0)) return { inks, shift: 0 };
    top = Math.min(top, i * lineH + base - k.ascent);
    bottom = Math.max(bottom, i * lineH + base + k.descent);
  }
  if (!(bottom > top)) return { inks, shift: 0 };
  return { inks, shift: (list.length * lineH) / 2 - (top + bottom) / 2 };
}

// ---- typesetting engine switch (beta) ----
// The shaped line breaking, hyphenation and balloon fitting in typeset.js /
// balloon.js are a beta feature, off unless the user turns it on in Settings.
// This is the one switch every layout path reads: `layoutLines` falls back to
// plain CSS-equivalent wrapping and `balloonWidthsFor` answers null when it is
// off, so the editor, the exporter, the PSD writer and auto-height all agree
// without each of them knowing about the preference. Set from the prefs
// module at boot and on toggle; default off so a cold test run is plain.
let _typeset = false;
export function setTypesetEnabled(on) {
  _typeset = !!on;
  // Every cached break was decided under the old switch. See `clearLayoutMemo`.
  clearLayoutMemo();
}
export function typesetEnabled() {
  return _typeset;
}

// Build a CSS font shorthand. `family` is a CSS family list (e.g. "'Bangers', cursive").
export function fontShorthand(style, sizePx, family) {
  const w = style.bold ? '700' : '400';
  const i = style.italic ? 'italic ' : '';
  return `${i}${w} ${sizePx}px ${family}`;
}

export function familyFor(style) {
  return fontCssFor(style.font);
}

export function applyCase(text, style) {
  return style.uppercase ? text.toUpperCase() : text;
}

// Per-character advances (width incl. letterSpacing is added by caller).
export function charWidths(text, style, sizePx) {
  if (!text || sizePx <= 0) return [];
  if (!_ctx) return [...text].map(() => sizePx * 0.55);
  _ctx.font = fontShorthand(style, sizePx, familyFor(style));
  return [...text].map((ch) => _ctx.measureText(ch).width);
}

// Lay out characters along a circular arc. Returns positions relative to the
// box center (0,0). Reduces to a flat line as curve → 0. `curve` is -100..100.
// For canvas: translate(cx+x, cy+y); rotate(rot); draw char centered.
// For DOM: place each span at box center, then translate(x,y) rotate(rot).
export function arcLayout(text, style, sizePx) {
  if (!text || sizePx <= 0 || !style || (style.size ?? 0) <= 0) return [];
  const chars = [...text];
  const widths = charWidths(text, style, sizePx);
  // Guard against missing letterSpacing or zero style.size causing NaN
  const ls = (Number(style?.letterSpacing) || 0) * (style.size > 0 ? sizePx / style.size : 0);
  const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, chars.length - 1) * ls;
  if (!Number.isFinite(total) || total <= 0) return [];
  const curve = Number(style?.curve) || 0;
  const maxAng = Math.max((Math.abs(curve) / 100) * 2.4, 1e-4);
  const R = total / maxAng;
  const sign = Math.sign(curve) || 1;
  const out = [];
  let cum = 0;
  for (let i = 0; i < chars.length; i++) {
    const centerOff = cum + widths[i] / 2;
    const a = (centerOff - total / 2) / R;
    out.push({
      ch: chars[i],
      x: R * Math.sin(a),
      y: sign * (R - R * Math.cos(a)),
      rot: sign * a, // radians
      w: widths[i],
    });
    cum += widths[i] + ls;
  }
  return out;
}

// Lay out characters around a FULL circle, closed exactly: the radius comes
// from the text's own advance (R = total / 2π), so the last letter meets the
// first again whatever the font or size. Same contract as `arcLayout`:
// positions relative to the box centre, rotation in radians, glyph drawn
// centred on its anchor.
//
// `style.circle.angle` (degrees, clockwise) turns the whole ring.
// `style.circle.inside` puts the text on the inner face instead - the bottom
// arc of a badge: it starts at six o'clock, runs counter-clockwise, and every
// glyph's top points at the centre, which is what keeps it readable.
//
// Letter spacing buys the ring one gap PER character rather than the line's
// n-1: the ring closes, so the seam between the last glyph and the first is a
// neighbour gap like any other - and widening the spacing is also the one
// knob that grows the circle.
//
// `style.circle.r` overrides that: a radius in page px (0 = auto, the closed
// ring above). The text then keeps its own advance and simply wraps as far
// around a circle of THAT size as it reaches - short text is an arc, not a
// stretched ring - and the run is CENTRED on `angle` rather than started
// there, because a partial arc has a middle worth aiming and the closed ring
// does not. Spacing goes back to the line's n-1 gaps, since there is no seam.
// The radius is in the style's own px, so it scales with the zoom exactly as
// `size` and `letterSpacing` do.
export function circleLayout(text, style, sizePx) {
  if (!text || sizePx <= 0 || !style || (style.size ?? 0) <= 0) return [];
  const chars = [...text];
  const widths = charWidths(text, style, sizePx);
  const scale = style.size > 0 ? sizePx / style.size : 0;
  const ls = (Number(style?.letterSpacing) || 0) * scale;
  const fixed = Math.max(0, Number(style.circle?.r) || 0) * scale;
  const ink = widths.reduce((a, b) => a + b, 0);
  // The closed ring pays a gap per character; the open arc pays the line's n-1.
  const total = ink + (fixed > 0 ? Math.max(0, chars.length - 1) : chars.length) * ls;
  if (!Number.isFinite(total) || total <= 0) return [];
  const R = fixed > 0 ? fixed : total / (2 * Math.PI);
  // A fixed ring is centred on `angle`; the closed one starts there.
  const half = fixed > 0 ? total / 2 : 0;
  const inside = !!style.circle?.inside;
  const a0 = ((Number(style.circle?.angle) || 0) * Math.PI) / 180;
  const out = [];
  let cum = 0;
  for (let i = 0; i < chars.length; i++) {
    // Angle is arc length over radius - which for the auto ring is 2π x the
    // share of the advance, R being total/2π. Measured clockwise from twelve
    // o'clock, which is where `angle` 0 starts.
    const t = (cum + widths[i] / 2 - half) / R;
    const th = inside ? a0 + Math.PI - t : a0 + t;
    out.push({
      ch: chars[i],
      x: R * Math.sin(th),
      y: -R * Math.cos(th),
      rot: inside ? th - Math.PI : th,
      w: widths[i],
    });
    cum += widths[i] + ls;
  }
  return out;
}

// ---- text on a bezier path ----
//
// The path is `style.path.pts`: anchors in box-local page px, each with in/out
// handle OFFSETS. Between anchor i and i+1 runs the cubic (P[i], P[i]+out[i],
// P[i+1]+in[i+1], P[i+1]). Glyphs are placed by cumulative advance along the
// path's arc length - real text-on-path rather than closest-point projection,
// which folds glyphs together on tight bends - and rotated to the tangent.
// The line as a whole sits on the path by `align`: left starts at the path's
// start, right ends at its end, center centres it; text longer than the path
// runs off the ends along the end tangents.
//
// Same contract as `arcLayout`: positions are relative to the BOX CENTRE, in
// the same px `sizePx` is in (the caller passes zoomed size and gets zoomed
// coordinates), rotation in radians, glyph drawn centred on its anchor.
const PATH_SEG_SAMPLES = 48;

function bez(p0, c1, c2, p1, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
  ];
}

function bezTan(p0, c1, c2, p1, t) {
  const u = 1 - t;
  const x = 3 * u * u * (c1[0] - p0[0]) + 6 * u * t * (c2[0] - c1[0]) + 3 * t * t * (p1[0] - c2[0]);
  const y = 3 * u * u * (c1[1] - p0[1]) + 6 * u * t * (c2[1] - c1[1]) + 3 * t * t * (p1[1] - c2[1]);
  // A degenerate tangent (handles collapsed onto the anchor at t=0/1) falls
  // back to the chord, so a glyph never gets rotation NaN.
  if (x === 0 && y === 0) return [p1[0] - p0[0], p1[1] - p0[1]];
  return [x, y];
}

// The path baked to a polyline with cumulative arc lengths and per-sample
// tangents. `scale` maps the stored page-px anchors into the caller's px.
function bakePath(pts, scale) {
  const P = pts.map((p) => ({
    a: [p.x * scale, p.y * scale],
    i: [(p.x + p.ix) * scale, (p.y + p.iy) * scale],
    o: [(p.x + p.ox) * scale, (p.y + p.oy) * scale],
  }));
  const xs = [];
  const tans = [];
  const lens = [0];
  let total = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i].a;
    const c1 = P[i].o;
    const c2 = P[i + 1].i;
    const p1 = P[i + 1].a;
    const from = i === 0 ? 0 : 1; // segment joints share a sample
    for (let k = from; k <= PATH_SEG_SAMPLES; k++) {
      const t = k / PATH_SEG_SAMPLES;
      const pt = bez(p0, c1, c2, p1, t);
      const tn = bezTan(p0, c1, c2, p1, t);
      if (xs.length) {
        const prev = xs[xs.length - 1];
        total += Math.hypot(pt[0] - prev[0], pt[1] - prev[1]);
        lens.push(total);
      }
      xs.push(pt);
      tans.push(tn);
    }
  }
  return { xs, tans, lens, total };
}

// Position + unit-ish tangent at arc length `s`, extrapolating past both ends
// along the end tangents so an over-long line keeps its direction.
function pathAt(baked, s) {
  const { xs, tans, lens, total } = baked;
  const unit = (v) => {
    const n = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / n, v[1] / n];
  };
  if (s <= 0) {
    const t = unit(tans[0]);
    return { x: xs[0][0] + t[0] * s, y: xs[0][1] + t[1] * s, tan: t };
  }
  if (s >= total) {
    const last = xs.length - 1;
    const t = unit(tans[last]);
    const over = s - total;
    return { x: xs[last][0] + t[0] * over, y: xs[last][1] + t[1] * over, tan: t };
  }
  // Binary search for the sample span holding `s`.
  let lo = 0;
  let hi = lens.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (lens[mid] <= s) lo = mid;
    else hi = mid;
  }
  const span = lens[hi] - lens[lo] || 1;
  const f = (s - lens[lo]) / span;
  const t = unit([
    tans[lo][0] + (tans[hi][0] - tans[lo][0]) * f,
    tans[lo][1] + (tans[hi][1] - tans[lo][1]) * f,
  ]);
  return {
    x: xs[lo][0] + (xs[hi][0] - xs[lo][0]) * f,
    y: xs[lo][1] + (xs[hi][1] - xs[lo][1]) * f,
    tan: t,
  };
}

// Split the path's longest segment in half and return a NEW pts array with an
// anchor at the split. De Casteljau at t = 0.5, so the curve through the new
// anchor is byte-for-byte the curve that was there - the anchor adds control,
// never a kink. "Longest" is measured on the baked polyline, which is the
// length the eye sees.
export function insertPathAnchor(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return pts;
  // Per-segment baked length.
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = bakePath([pts[i], pts[i + 1]], 1);
    if (seg.total > bestLen) {
      bestLen = seg.total;
      best = i;
    }
  }
  const a = pts[best];
  const b = pts[best + 1];
  const p0 = [a.x, a.y];
  const c1 = [a.x + a.ox, a.y + a.oy];
  const c2 = [b.x + b.ix, b.y + b.iy];
  const p3 = [b.x, b.y];
  const mid = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
  const q0 = mid(p0, c1);
  const q1 = mid(c1, c2);
  const q2 = mid(c2, p3);
  const r0 = mid(q0, q1);
  const r1 = mid(q1, q2);
  const m = mid(r0, r1);
  const out = pts.map((p) => ({ ...p }));
  out[best] = { ...out[best], ox: q0[0] - a.x, oy: q0[1] - a.y };
  out[best + 1] = { ...out[best + 1], ix: q2[0] - b.x, iy: q2[1] - b.y };
  out.splice(best + 1, 0, {
    x: m[0],
    y: m[1],
    ix: r0[0] - m[0],
    iy: r0[1] - m[1],
    ox: r1[0] - m[0],
    oy: r1[1] - m[1],
  });
  return out;
}

// Remove one anchor, keeping at least two so the path stays a path.
export function removePathAnchor(pts, i) {
  if (!Array.isArray(pts) || pts.length <= 2 || i < 0 || i >= pts.length) return pts;
  const out = pts.map((p) => ({ ...p }));
  out.splice(i, 1);
  return out;
}

// The baked path as a flat point list, for the editor's gizmo polyline.
// `scale` maps the stored page px into the caller's px (the zoom).
export function pathPolyline(pts, scale = 1) {
  if (!Array.isArray(pts) || pts.length < 2) return [];
  return bakePath(pts, scale).xs;
}

export function pathLayout(text, style, sizePx, boxW, boxH) {
  const pts = style?.path?.pts;
  if (!text || sizePx <= 0 || !style || (style.size ?? 0) <= 0) return [];
  if (!Array.isArray(pts) || pts.length < 2) return [];
  const chars = [...text];
  const widths = charWidths(text, style, sizePx);
  const scale = sizePx / style.size;
  const ls = (Number(style?.letterSpacing) || 0) * scale;
  const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, chars.length - 1) * ls;
  if (!Number.isFinite(total) || total <= 0) return [];
  const baked = bakePath(pts, scale);
  if (!(baked.total > 0)) return [];
  const start =
    style.align === 'left' ? 0 : style.align === 'right' ? baked.total - total : (baked.total - total) / 2;
  const hw = (boxW * scale) / 2;
  const hh = (boxH * scale) / 2;
  const out = [];
  let cum = 0;
  for (let i = 0; i < chars.length; i++) {
    const at = pathAt(baked, start + cum + widths[i] / 2);
    out.push({
      ch: chars[i],
      x: at.x - hw,
      y: at.y - hh,
      rot: Math.atan2(at.tan[1], at.tan[0]),
      w: widths[i],
    });
    cum += widths[i] + ls;
  }
  return out;
}

// Greedy word-wrap to a max pixel width. Respects explicit newlines.
export function wrapLines(text, style, sizePx, maxWidth) {
  if (!text) return [''];
  if (sizePx <= 0) return text.split('\n').map((l) => l.replace(/\s+$/, ''));
  if (!_ctx) return text.split('\n').map((l) => l.replace(/\s+$/, ''));
  _ctx.font = fontShorthand(style, sizePx, familyFor(style));
  const ls = (Number(style?.letterSpacing) || 0) * (style?.size > 0 ? sizePx / style.size : 0); // scale ls to this size
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/); // keep spaces
    let line = '';
    const widthOf = (s) => _ctx.measureText(s).width + Math.max(0, [...s].length - 1) * ls;
    for (const word of words) {
      const trial = line + word;
      if (line && widthOf(trial) > maxWidth) {
        out.push(line.replace(/\s+$/, ''));
        line = word.replace(/^\s+/, '');
      } else {
        line = trial;
      }
    }
    // Terminal line must strip trailing whitespace to match wrapped lines and wrapLinesDOM
    out.push(line.replace(/\s+$/, ''));
  }
  return out.length ? out : [''];
}

// Wrap text EXACTLY like the editor by laying it out in a hidden DOM element
// with identical CSS, then reading the browser's own line breaks. Greedy canvas
// wrapping (wrapLines) only breaks on spaces, so it can't reproduce CSS rules
// like hyphen breaks or `word-break:break-word` (breaking inside long words).
// `contentWidthPx` must be the box's CONTENT width (box.w minus horizontal
// padding) so breaks land where the editor puts them. `text` should already be
// case-applied; this sets text-transform:none.
export function wrapLinesDOM(text, style, sizePx, contentWidthPx) {
  if (typeof document === 'undefined') return wrapLines(text, style, sizePx, contentWidthPx);
  const ls = (Number(style?.letterSpacing) || 0) * (style?.size > 0 ? sizePx / style.size : 0);
  const el = document.createElement('div');
  el.style.cssText =
    'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:pre-wrap;' +
    'word-break:break-word;overflow-wrap:break-word;box-sizing:content-box;padding:0;margin:0;border:0;' +
    `width:${Math.max(1, contentWidthPx)}px;` +
    `font-family:${familyFor(style)};font-weight:${style.bold ? 700 : 400};` +
    `font-style:${style.italic ? 'italic' : 'normal'};font-size:${sizePx}px;` +
    `line-height:${style.lineHeight};letter-spacing:${ls}px;text-transform:none;text-align:${style.align};`;
  document.body.appendChild(el);
  const out = [];
  try {
    for (const para of text.split('\n')) {
      if (para === '') {
        out.push('');
        continue;
      }
      el.textContent = para;
      const node = el.firstChild;
      const range = document.createRange();
      let curTop = null;
      let start = 0;
      for (let i = 0; i < para.length;) {
        const cp = para.codePointAt(i);
        const charLen = cp > 0xffff ? 2 : 1;
        range.setStart(node, i);
        range.setEnd(node, i + charLen);
        const rects = range.getClientRects();
        const rect = rects[rects.length - 1];
        if (!rect) {
          i += charLen;
          continue;
        }
        const top = Math.round(rect.top);
        if (curTop === null) curTop = top;
        else if (Math.abs(top - curTop) > 1) {
          const raw = para.slice(start, i).replace(/\s+$/, '');
          out.push(start === 0 ? raw : raw.replace(/^\s+/, ''));
          start = i;
          curTop = top;
        }
        i += charLen;
      }
      const raw = para.slice(start).replace(/\s+$/, '');
      out.push(start === 0 ? raw : raw.replace(/^\s+/, ''));
    }
  } finally {
    el.remove();
  }
  return out.length ? out : [''];
}

// ===== where one line's ink actually lands =====
//
// Everything above measures ADVANCES - how far the pen moves - because that is
// what line breaking needs. The pixels are something else. An italic's last
// stroke leans past its advance, a J or a j reaches back behind the pen, an
// accented capital rises above the font's own ascent, a descender can run below
// its descent, and a trailing letter-spacing gap is advance with no ink in it at
// all. Containment - "does the text stay inside its box" - is a question about
// the pixels, so it needs the glyphs' own bounding box: `actualBoundingBox*` off
// `measureText`, which is the browser's answer for exactly the string it would
// draw.
//
// Answered for the line as the raster exporter DRAWS it (`paintBox`): the
// style's font, the style's letter spacing, `textAlign` set to the style's
// alignment and an alphabetic baseline. So `left` and `right` are offsets from
// the line's ANCHOR - its left edge, its centre or its right edge, whichever
// `align` names - and `ascent`/`descent` are distances above and below its
// baseline.
//
// The spacing is added by arithmetic rather than by setting `ctx.letterSpacing`
// and measuring, and that is not a shortcut. The canvas draws a spaced line by
// moving every glyph i gaps to the right, so the ink runs from the unspaced
// ink's left edge to its right edge plus n-1 gaps (a negative spacing pulls the
// left edge instead), and the ALIGNMENT places the whole advance - trailing gap
// included, since the canvas and CSS both put a gap after the last glyph too.
// Measuring with the property set would be simpler if every canvas answered it
// honestly, and one does not: the node canvas the real-font tests draw with
// paints a spaced line correctly and reports its ink box as if the spacing had
// been applied twice over, which would make every spaced box look like it
// overflowed. The arithmetic is the same on every canvas. It is also a bound
// rather than an estimate: a glyph that overhangs further than the last one
// still sits inside it.
//
// The line is measured exactly as it will be drawn, leading spaces and all,
// because under a centre or right alignment a space moves the ink.
// Null for a line with nothing to draw.
//
// No canvas - the node test runner - falls back to the same stand-in every other
// function here uses: `size * 0.55` a character, the fallback font metrics for
// the height, and no overhang. Consistent with the stand-in line breaker, so a
// test sees ink that agrees with the breaks it was given.
export function lineInk(line, style, sizePx) {
  const str = String(line ?? '');
  if (!/\S/.test(str) || !(sizePx > 0) || !style) return null;
  const align = style.align === 'left' || style.align === 'right' ? style.align : 'center';
  const ls = (Number(style.letterSpacing) || 0) * (style.size > 0 ? sizePx / style.size : 0);
  const n = [...str].length;
  const spread = Math.max(0, n - 1) * ls;
  // Where the pen starts relative to the anchor, given the run's whole advance.
  const start = (advance) => (align === 'left' ? 0 : align === 'right' ? -advance : -advance / 2);
  if (!_ctx) {
    const cw = sizePx * 0.55;
    const lead = [...str].length - [...str.trimStart()].length;
    const inked = [...str.trim()].length;
    const x0 = start(n * (cw + ls)) + lead * (cw + ls);
    const { ascent, descent } = fontMetrics(style, sizePx);
    return { left: x0, right: x0 + inked * cw + Math.max(0, inked - 1) * ls, ascent, descent };
  }
  _ctx.font = fontShorthand(style, sizePx, familyFor(style));
  _ctx.textAlign = 'left';
  _ctx.textBaseline = 'alphabetic';
  const m = _ctx.measureText(str);
  const x0 = start(m.width + n * ls);
  const L = m.actualBoundingBoxLeft;
  const R = m.actualBoundingBoxRight;
  const A = m.actualBoundingBoxAscent;
  const D = m.actualBoundingBoxDescent;
  if ([L, R, A, D].every(Number.isFinite)) {
    return { left: x0 - L + Math.min(0, spread), right: x0 + R + Math.max(0, spread), ascent: A, descent: D };
  }
  // A browser that predates the ink metrics: the advance, placed by the
  // alignment, and the font's own ascent and descent. Loose, and the best there
  // is - and marked, so the centring shift above can refuse it as it always
  // refused a browser with no ink metrics.
  const { ascent, descent } = fontMetrics(style, sizePx);
  return { left: x0, right: x0 + m.width + spread, ascent, descent, approx: true };
}

// The ink of ONE glyph drawn the way the curved renderers draw it: centred on
// its anchor, horizontally and vertically (`textAlign: 'center'`,
// `textBaseline: 'middle'`), before the glyph's own rotation. Offsets from the
// anchor, same shape as `lineInk`. The shared context is put back to the
// alphabetic baseline afterwards, because `fontMetrics` and `inkShiftY` read
// their numbers relative to whatever baseline is set and never set one.
//
// The stand-in is the stand-in advance wide and one em tall, centred - the em
// square is what 'middle' centres, and the stand-in font's ascent and descent
// are exactly one em between them.
export function glyphInk(ch, style, sizePx) {
  const str = String(ch ?? '');
  if (!/\S/.test(str) || !(sizePx > 0) || !style) return null;
  if (!_ctx) {
    const hw = [...str].length * sizePx * 0.275;
    return { left: -hw, right: hw, ascent: sizePx / 2, descent: sizePx / 2 };
  }
  _ctx.font = fontShorthand(style, sizePx, familyFor(style));
  _ctx.textAlign = 'center';
  _ctx.textBaseline = 'middle';
  const m = _ctx.measureText(str);
  _ctx.textAlign = 'left';
  _ctx.textBaseline = 'alphabetic';
  const L = m.actualBoundingBoxLeft;
  const R = m.actualBoundingBoxRight;
  const A = m.actualBoundingBoxAscent;
  const D = m.actualBoundingBoxDescent;
  if ([L, R, A, D].every(Number.isFinite)) return { left: -L, right: R, ascent: A, descent: D };
  const hw = (m.width || sizePx * 0.55) / 2;
  return { left: -hw, right: hw, ascent: sizePx / 2, descent: sizePx / 2 };
}

// Measured width of a single wrapped line at sizePx, including letter-spacing
// between characters (matches how wrapLines measures and how the canvas draws
// with ctx.letterSpacing). Trailing spaces are trimmed like the app does.
export function lineWidth(line, style, sizePx) {
  if (!line || sizePx <= 0) return 0;
  const s = line.replace(/\s+$/, '');
  if (!_ctx) return s.length * sizePx * 0.55;
  _ctx.font = fontShorthand(style, sizePx, familyFor(style));
  const ls = (Number(style?.letterSpacing) || 0) * (style?.size > 0 ? sizePx / style.size : 0);
  return _ctx.measureText(s).width + Math.max(0, [...s].length - 1) * ls;
}

// Scanlation-shaped line breaking, with this module's real metric wired into
// the pure core in `typeset.js`. `text` must already be case-applied - same
// contract as `wrapLinesDOM` - because uppercasing changes every width.
//
// `widthsFor` is optional and, when given, replaces the single content width
// with a per-line one: `widthsFor(lineCount) -> number[]`, the usable width of
// each line of a block of that many lines. That is how a balloon's actual shape
// gets into the line breaker - inside an ellipse the room narrows towards the
// top and the bottom, and a block laid out against one flat number runs into the
// curve at both ends. `contentWidthPx` stays required and stays the answer when
// no callback is supplied, so every existing caller means exactly what it did.
export function shapedLines(text, style, sizePx, contentWidthPx, widthsFor) {
  return balanceLines(text, widthsFor ?? contentWidthPx, (s) => lineWidth(s, style, sizePx), {
    minOrphan: style.minOrphan ?? 3,
    // `??` rather than a plain read, and the distinction is load-bearing:
    // `TYPESET_DEFAULTS.hyphenate` is true, so handing `undefined` across would
    // turn the feature OFF for every style saved before the knob existed. A
    // missing key means "the default", which is what `normalizeStyle` would
    // have supplied anyway had the style come through it.
    hyphenate: style.hyphenate ?? true,
    // The silhouette the block aims for inside the room its rows have (BRK-3):
    // 'auto' fills each row, 'oval' tapers to the ends, 'rect' keeps the lines
    // even. 'off' never gets here - `layoutLines` wraps plainly for it.
    shape: style.shape ?? 'auto',
  });
}

// ===== the balloon a box was fitted to, as a `widthsFor` callback =====
//
// THE one place a box's stored fit turns into per-line widths, and the reason it
// is one place is the same reason `layoutLines` is: the editor, the raster
// exporter and the PSD's type layers all lay the same box out, and they have to
// agree glyph for glyph or the canvas and the exports draw different pictures of
// the same document. Three copies of this arithmetic would be three chances to
// round differently.
//
// Returns null - meaning "no per-line widths, use the flat content width" - for
// a box with no fit, a malformed one, or a box whose style has balloon layout
// switched off. That null is what makes the promise "a box with no fit produces
// byte-identical output to today" true by construction rather than by testing:
// `layoutLines` ignores an absent `widthsFor` entirely.
//
// Every alignment follows the balloon. A row's room is symmetric about the
// balloon's centre, and centred lines are too, so a line no wider than its row
// sits inside the curve at both ends. A left- or right-aligned line is set in
// from the box's edge to its row's own edge (`lineIndents`, below), so it starts
// - or ends - at the curve rather than at the box, which on the top and bottom
// rows is outside it.
//
// Two adjustments to what `balloon.js` hands back, and both are the caller's own
// debt rather than something that module could have done:
//
//   the inset per edge. `interiorLineWidths` returns the BALLOON's usable
//   width. The text is laid out inside the box's content box, `textInset` in
//   from every edge - the padding plus the outline's reach, which is what every
//   flat call site takes off through `contentWidth` - so the same inset comes
//   off each side here.
//
//   the box's own content width is a ceiling. No line is laid out wider than the
//   rectangle the user drags, resizes and aligns - past it the box would stop
//   describing its own text (the bug `autoFitBox` exists to prevent on the other
//   axis), and the PSD's paragraph frame, which is the content box, would re-wrap
//   the line. A box placed on a balloon is as wide as the balloon's inset
//   interior (`balloonFrame`), so the widest row is exactly the content width and
//   the ceiling never binds: every row keeps its taper. It binds only on a box
//   narrower than the balloon - narrowed by hand, or placed before boxes were
//   sized that way - where it flattens the rows that the box is too narrow for.
//
// The widths are read off the shape in PAGE coordinates, for the rows the block
// is drawn on (GEO-2): its top is `box.y + blockYFor(...)`, where the editor,
// the exporter and the PSD put it - less the few pixels a middle block's ink
// centring moves it, which depends on the very lines being chosen and which the
// balloon's safety inset absorbs. They used to be read for a block
// placed inside the shape by `valign` alone, which is the right rows only for a
// middle-aligned box centred on its balloon: a top-aligned block was measured
// at the balloon's crown, a first row with almost no room, and broke into more
// lines than the rows it is actually on need. A block drawn partly past the
// curve - a box dragged away from its balloon - gets the rows of the nearest
// place inside it (`interiorLineWidths`), which is why the Inspector offers
// both a re-fit and an off switch, and why neither is optional chrome.
//
// Every line count hangs its block from one point - the top of the content box,
// its middle or its bottom, by `valign` - and that ANCHOR is what the key
// carries rather than the box's y and height. The rows move with it, and it is
// what a height change anchored by `valign` (auto height, the ladder's height
// step) leaves where it is, so growing a box does not break its lines again. It
// is rounded to a thousandth of a pixel, in the key and in the arithmetic alike,
// so the float noise of `y - grow / 2 + (h + grow) / 2` is not a new layout.
//
// Built for any rectangle, so a caller weighing a candidate box - the ladder, a
// solver - asks it of that rectangle and gets the rows the box would draw on.
export function balloonWidthsFor(box, style, sizePx) {
  // Balloon layout is part of the typesetting beta, so the switch is read here
  // rather than at each of the three call sites: with it off there are no
  // per-line widths at all, which is the state every box was in before fitting
  // existed and the state `layoutLines` treats as "just wrap it".
  if (!typesetEnabled()) return null;
  if (!box || !style || style.balloon === false) return null;
  const shape = normalizeFit(box.fit);
  if (!shape) return null;
  const inset = textInset(style);
  const contentW = contentWidth(box.w, style);
  const lineH = sizePx * (style.lineHeight ?? 1);
  const valign = style.valign ?? 'middle';
  const anchor = Math.round((box.y + blockYFor(style, box.h, 0)) * 1000) / 1000;
  const fn = (lineCount) => {
    const blockH = lineCount * lineH;
    const top = anchor + blockYFor(style, box.h, blockH) - blockYFor(style, box.h, 0);
    return interiorLineWidths(shape, lineH, lineCount, valign, { top }).map((w) =>
      Math.max(1, Math.min(contentW, w - inset * 2)),
    );
  };
  // What this closure IS, written down, so `layoutLines` can memoise a result
  // that depends on it. A callback cannot be a cache key - two closures built
  // from the same shape are different objects - and the alternative, hashing
  // the widths it hands back, means calling it, which is a share of the work
  // being avoided. Everything the closure captures is here; a `widthsFor` from
  // anywhere else carries no key and is simply not cached (see `memoKey`).
  fn.key = JSON.stringify([shape, lineH, valign, anchor, contentW, inset]);
  return fn;
}

// ===== where a flush line starts, inside a balloon =====
//
// How far each line of a left- or right-aligned block is set in from the edge
// it is aligned to, in unzoomed px: THE one statement of it, which the editor's
// `.tline` padding, the raster exporter's x per line (through `placeBlock`'s
// `lineX`), the containment check and the PSD's paragraph indents all read.
//
// A row's room (`balloonWidthsFor`) is centred on the box, as a centred line is,
// so a flush line's row starts half the room the row lacks in from the content
// box's edge: `(contentW - row) / 2`. That is the row's interior edge less the
// box's inset, the same inset the breaker took off the row. A box centred on its
// balloon - every box `fittedRect` places - puts that edge on the curve; a box
// dragged sideways off it moves its rows with it, as it moves a centred block.
//
// Never so far in that the line would cross the content box's other edge. A
// line wider than its row - a word the breaker had to keep whole - is set in by
// what the box has left beside it, so it may reach past the curve but never
// past the box, which is the rule every renderer is held to. It also keeps the
// editor honest: a CSS line wider than the room its padding leaves overflows at
// its end whatever its alignment, and a right-aligned one would then draw from
// the other edge to the export.
//
// Null - no indent anywhere - for centred text, a box with no rows, plain
// wrapping (which ignores the rows: `layoutLines`), or a block whose every row
// is as wide as the box. So a box with no balloon, or one whose block sits
// inside the rectangle its rows all clear, draws exactly as it always did.
export function lineIndents(lines, style, sizePx, contentWidthPx, widthsFor) {
  if (!widthsFor || !Array.isArray(lines) || lines.length === 0) return null;
  if (style?.align !== 'left' && style?.align !== 'right') return null;
  if (!typesetEnabled() || (style.shape ?? 'auto') === 'off') return null;
  const w = contentWidthPx > 1 ? contentWidthPx : 1;
  const rows = widthsFor(lines.length);
  let any = false;
  const out = lines.map((line, i) => {
    const row = rows[i] ?? w;
    const v = Math.max(0, Math.min((w - row) / 2, w - lineWidth(line, style, sizePx)));
    if (v > 0) any = true;
    return v;
  });
  return any ? out : null;
}

// ===== the same block, broken twice =====
//
// `layoutLines` is not cheap - a shaped break runs the balancer over every
// candidate split, and on a page of fifteen boxes that is tens of milliseconds -
// and the app asks it the same question repeatedly with the same answer. A page
// turn used to pay for two full passes over every box on the page (the component
// laying its lines out, and auto-height counting them); the exporter asks a
// third time for a page the editor has just drawn; and `balancedBoxSize` walks
// five candidate widths, some of which repeat.
//
// So the answer is remembered, keyed on every input that can change it. The
// bound is a count rather than bytes: an entry is a handful of short strings,
// and the number that matters is "more than a chapter's worth of visible boxes,
// less than a chapter" - a resident window of fifteen-box pages is under a
// hundred, and five hundred leaves room for the exporter walking a chapter
// without letting the map grow with one.
//
// The returned array is SHARED with every other caller holding the same key.
// Nothing in the app mutates a `layoutLines` result - the editor iterates it,
// auto-height takes its length, the exporter measures it - and a copy per call
// would give back a real share of what the memo saves.
const MEMO_MAX = 500;
const memo = new Map();

// Everything that decides where the lines fall, and nothing that does not.
//
// `text` is already case-applied by every caller (that is `layoutLines`'s
// contract), so `uppercase` cannot change the answer - it is in the key anyway,
// because a style whose case flag disagrees with the text it was applied to is a
// bug elsewhere and this is not the place to make it invisible.
//
// The font FAMILY is keyed as `style.font`, the app's own name for it, rather
// than the resolved CSS list. What the name resolves to can change - a user font
// finishing its registration is exactly that - and so can the metrics of a face
// already resolved. Neither is visible in any argument here, which is why the
// map is cleared wholesale on that event instead; see `clearLayoutMemo`.
//
// Null - meaning "do not cache this one" - for a `widthsFor` this module did not
// build, since there is nothing to say about what it will return.
function memoKey(text, style, sizePx, w, widthsFor) {
  if (widthsFor && !widthsFor.key) return null;
  return JSON.stringify([
    _typeset,
    text,
    style.font,
    sizePx,
    style.size,
    style.bold ? 1 : 0,
    style.italic ? 1 : 0,
    style.lineHeight,
    style.letterSpacing,
    style.uppercase ? 1 : 0,
    style.align,
    style.shape ?? 'auto',
    style.minOrphan ?? 3,
    style.hyphenate ?? true,
    w,
    widthsFor ? widthsFor.key : 0,
  ]);
}

// Every measurement in this module is stale. Called from `relayoutAll` in the
// store - the one event that says a face has arrived, been replaced or been
// removed - and from the typesetting switch above. Both are rare and both change
// the answer to every question this map holds, so the map goes rather than being
// invalidated key by key.
export function clearLayoutMemo() {
  memo.clear();
}

// For the tests, and for the same sort of introspection `pagePixelsHeld` offers.
export const layoutMemoSize = () => memo.size;

// THE place the question "where does this box's text break" is answered, and the
// only one either the editor or the exporter is allowed to ask. Both call this
// with identical arguments - the box's unzoomed style size and its content width
// - so the canvas and the exported PNG break in the same places by construction
// rather than by two implementations happening to agree.
//
// `shape: 'off'` hands the job back to `wrapLinesDOM`, which reproduces the
// browser's own greedy wrapping. That is the path for a user who wants plain CSS
// behaviour, and it is unchanged - including that it ignores `widthsFor`, since
// the browser has no way to wrap text to a width that varies line by line and
// pretending otherwise would break the one promise that path makes.
// `shape: 'off'` - and the typesetting switch being off, which is the same thing
// said for the whole document - hands the job back to `wrapLinesDOM`.
//
// A line at the START or the END of a block that holds nothing but whitespace is
// not a line: it is a stray Return the user pressed, and it moved the text up or
// down the box, grew the box under auto-height, and shifted the export by a
// whole line. Interior blank lines stay - between two paragraphs a blank line is
// the paragraph break, and it is the only way to type one. Trimmed here rather
// than in each renderer because every path that lays a box out comes through
// this function, so one rule covers the editor, the export, the PSD and
// auto-height at once. Empty text still answers `['']`: a caller that asks for
// the lines of an empty box gets one empty line to place a caret in, not
// nothing to iterate.
//
// `opts.cache: false` asks without remembering the answer. A hit is still used -
// it costs nothing - but a miss is not written back. That is for the fitting
// ladder in contain.js, which tries a dozen widths and sizes to find the one it
// keeps: remembered, its rejected candidates would push out the entries the
// editor is actually drawing from, and the one it keeps is laid out again by the
// editor and the exporter through the ordinary path anyway.
//
// A tab comes out as one space (OVF-10). Nothing that draws these lines agrees
// on what a tab is: a browser's canvas turns it into a space before it measures
// or paints (the spec says to), the node canvas the real-font tests draw with
// measures it as a glyph of its own, wider than a space, and the editor's
// `.tline` - `white-space: pre` - advances it to the next of CSS's tab stops,
// eight spaces apart. So a box with a tab in it broke to one width, painted to a
// second and showed a third, up to seven spaces wider than the breaker had
// room for, past the edge of the box on the canvas where no check could see it.
// A space is the one thing all of them draw alike, so the lines every renderer
// takes from here hold spaces; the stored text keeps its tab.
export function layoutLines(text, style, sizePx, contentWidthPx, widthsFor, opts) {
  if (typeof text === 'string' && text.includes('\t')) text = text.replace(/\t/g, ' ');
  // A pixel is the narrowest a column can be. Every caller computes the width as
  // the box less its inset (`contentWidth`) and a box may be narrower than that, so the
  // width handed in can be zero or negative - and the editor clamped it while
  // the raster exporter and the PSD's type layers did not, which is three
  // renderers free to break the same box in three different places. Clamped here
  // instead, where the one rule reaches all of them.
  const w = contentWidthPx > 1 ? contentWidthPx : 1;
  // Asked and answered - see the memo above. A hit promotes, so what survives
  // eviction is what the editor is actually laying out rather than whatever a
  // chapter export happened to walk past last.
  const key = memoKey(text, style, sizePx, w, widthsFor);
  if (key !== null) {
    const hit = memo.get(key);
    if (hit) {
      memo.delete(key);
      memo.set(key, hit);
      return hit;
    }
  }
  const lines =
    !typesetEnabled() || (style.shape ?? 'auto') === 'off'
      ? wrapLinesDOM(text, style, sizePx, w)
      : shapedLines(text, style, sizePx, w, widthsFor);
  let a = 0;
  let b = lines.length;
  while (a < b && !/\S/.test(lines[a])) a++;
  while (b > a && !/\S/.test(lines[b - 1])) b--;
  const out = a === 0 && b === lines.length ? lines : b > a ? lines.slice(a, b) : [''];
  if (key !== null && opts?.cache !== false) {
    memo.set(key, out);
    // One over the bound, once per miss, so the oldest key is the only thing
    // that ever has to be found - `Map` iterates in insertion order.
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  }
  return out;
}

// ===== the size a box should be placed at, when nothing else knows =====
//
// `balancedBlockSize` in typeset.js answers this in closed form from an area and
// an aspect. This is the half that needs a metric: it measures the text, seeds
// the closed form with it, and then CHECKS the answer against the real line
// breaker rather than trusting the arithmetic.
//
// The check is not ceremony. The closed form models breaking as "cut the text
// into n equal pieces", and the breaker does nothing of the sort - it refuses to
// leave an orphan, it hyphenates, it balances the ragged edge, and any one of
// those can turn the width that should give n lines into one that gives n-1 or
// n+1. So each candidate line count near the ideal is laid out for real, its
// actual height taken from the actual line count, and the candidate whose block
// comes out closest to the target aspect wins. The score is on the log of the
// ratio so that being a factor of two too wide and a factor of two too tall cost
// the same - on a plain difference, wide always looks cheaper.
//
// Returns a BOX size: the content width plus the inset a box breaks its lines
// inside (`textInset`), and the height through `neededHeight`, so the caller can
// use it as a rectangle without knowing what either is.
//
// Null when there is nothing to measure: no text, or no size.
//
// "No canvas to measure with" is deliberately NOT checked here, and the omission
// is the same one `layoutLines` makes. Under node every metric in this file falls
// back to a stand-in, which is fine for deciding where a line breaks and not fine
// for writing a number into the user's document - so the guard belongs to the
// caller that is doing the writing, exactly as `autoFitBox` guards itself with
// `canMeasure()` before it touches a box. Putting it here as well would look like
// belt and braces and is in fact worse than useless: a `vi.mock` of this module
// replaces the EXPORT, not the call this function would make to its own local
// binding, so the guard would be un-mockable and the balanced size would be dead
// code in every test that grants the stand-in metric.
export function balancedBoxSize(text, style, opts = {}) {
  const o = { ...BALANCED_DEFAULTS, ...opts };
  const size = Number(style?.size);
  if (!(size > 0)) return null;
  const cased = applyCase(String(text ?? ''), style);
  if (!/\S/.test(cased)) return null;
  const lh = size * (style.lineHeight > 0 ? style.lineHeight : 1);
  // Paragraphs, because a typed Return is a line the breaker cannot undo: three
  // paragraphs are at least three lines however wide the box is, so they are the
  // floor on the search below as well as the pieces the total is summed from.
  const paras = cased.split('\n').filter((s) => /\S/.test(s));
  let total = 0;
  for (const s of paras) total += lineWidth(s, style, size);
  if (!(total > 0)) return null;

  const seed = balancedBlockSize(total, lh, o);
  if (!seed) return null;
  const lo = Math.max(1, paras.length, seed.lines - 2);
  const hi = Math.max(lo, Math.min(Math.round(o.maxLines), seed.lines + 2));
  let best = null;
  for (let n = lo; n <= hi; n++) {
    const contentW = Math.max(o.minWidth, (total / n) * o.slack);
    const count = layoutLines(cased, style, size, contentW, null).length;
    const h = count * lh;
    if (!(h > 0)) continue;
    const score = Math.abs(Math.log(contentW / h / o.targetAspect));
    if (!best || score < best.score) best = { score, contentW, count };
  }
  if (!best) return null;
  return {
    w: Math.ceil(best.contentW) + textInset(style) * 2,
    h: neededHeight(best.count, style, textInset(style)),
    lines: best.count,
  };
}
