// ===== SFX lettering: the JS side of the engine's per-letter layout =====
//
// SFX is a fourth glyph-by-glyph layout, beside the arc, the ring and the path
// (measure.js). It differs from them in two ways: the Rust engine computes it
// (`sfxLayout` on the engine object, text-engine/), and each glyph carries a
// scale and a lean as well as a place and a turn.
//
//   layout   [{ ch, x, y, rot, sx, sy, skew, w }], one per code point of the
//            text, positions in px from the box centre, `rot` and `skew` in
//            radians, `sx`/`sy` the glyph's own scale. The same shape the other
//            curves give, plus the three, so everything that reads a curve's
//            layout reads this one.
//
// It works ONLY with the Rust engine. `sfxActive` is false under the browser
// engine, and false for a style with no moves, and every reader in the app
// asks that one question: an SFX style under the browser engine is plain text,
// exactly as it was before the field existed.

import { textEngine } from './text-engine/index.js';
import { faceFor } from './measure.js';
import { normalizeSfx, normalizeWarp } from './data.js';

export function sfxAvailable() {
  return typeof textEngine()?.sfxLayout === 'function';
}

// Whether a style is laid out as SFX right now.
export function sfxActive(style) {
  const sfx = style?.sfx;
  return !!sfx?.on && (sfx.moves?.length ?? 0) > 0 && sfxAvailable();
}

// Whether the engine's refusal of a layout has been said (below).
let refused = false;

// The layout for the (already case-applied) `text` at `sizePx`, or [] when the
// style is not SFX. Rows are the text's own lines; `flow: 'stack'` is the
// engine's to apply. Line height and letter spacing are the box's, scaled to
// `sizePx` as `arcLayout` scales them, so a zoomed layout is the unzoomed one
// times the zoom.
//
// One entry per code point of `text`, newlines included: the other curves give
// one, and what reads them by index (the caret on a curve, the borrowed
// letters of a run) counts on it. The engine places only the letters, so each
// newline gets a glyph of no advance at the end of the row it closes, which
// paints nothing and measures as no ink.
export function sfxLayout(text, style, sizePx) {
  if (!text || !(sizePx > 0) || !(style?.size > 0) || !sfxActive(style)) return [];
  const sfx = style.sfx;
  const chars = [...text];
  let placed;
  try {
    placed = textEngine().sfxLayout(faceFor(style, sizePx), String(text).split('\n'), {
      lineHeight: sizePx * (style.lineHeight > 0 ? style.lineHeight : 1),
      letterSpacing: (Number(style.letterSpacing) || 0) * (sizePx / style.size),
      amount: sfx.amount,
      seed: sfx.seed,
      flow: sfx.flow,
      rowShift: sfx.rowShift,
      moves: sfx.moves.map((m) => ({ kind: m.kind, a: m.a, b: m.b })),
    });
  } catch (error) {
    // The engine refuses a recipe or a size it cannot answer for. A layout
    // that threw would take the box's whole placement with it (and the page's
    // relayout): the box is left with no letters, and the engine's reason is
    // said once.
    if (!refused) console.error('SFX layout refused by the text engine:', error);
    refused = true;
    return [];
  }
  if (!Array.isArray(placed)) return [];
  const letters = chars.filter((c) => c !== '\n').length;
  // An engine that returned something else than a glyph per letter has its
  // own idea of the text; its answer is used as it came.
  if (placed.length !== letters) return placed.map((g, i) => ({ ...g, ch: g.ch ?? chars[i] }));
  const out = [];
  let at = 0;
  for (const ch of chars) {
    if (ch === '\n') {
      const prev = out[out.length - 1];
      out.push({ ch, x: prev?.x ?? 0, y: prev?.y ?? 0, rot: 0, sx: 1, sy: 1, skew: 0, w: 0 });
    } else {
      const g = placed[at++];
      out.push({ ...g, ch });
    }
  }
  return out;
}

// ---- what the engine knows: move kinds and built-in presets ----
//
// Asked once per engine and kept: the tables do not change while it lives.
// Kept BY the engine, weakly: an engine the app has let go of (Rust switched
// off, another wasm loaded) is not held alive by its tables, and its memory
// goes with it. A plain "last engine asked" slot did hold it, for as long as
// no other engine with tables was asked, which under the browser engine is
// for ever.
const NONE = Object.freeze({ kinds: [], presets: [] });
const infoOf = new WeakMap();

export function sfxInfo() {
  const e = textEngine();
  if (!e || typeof e.sfxInfo !== 'function') return NONE;
  let info = infoOf.get(e);
  if (!info) {
    const got = e.sfxInfo();
    info = {
      kinds: Array.isArray(got?.kinds) ? got.kinds : [],
      presets: Array.isArray(got?.presets) ? got.presets : [],
    };
    infoOf.set(e, info);
  }
  return info;
}
export const sfxPresets = () => sfxInfo().presets;
export const sfxKinds = () => sfxInfo().kinds;

// ---- applying a recipe ----

// SFX is one glyph layout among four, and the others are switched off when it
// is switched on, so the Inspector does not show an arc that has no effect.
export function enableSfx(style) {
  style.sfx.on = true;
  style.curve = 0;
  style.circle.on = false;
  style.path.on = false;
}

// ---- envelopes: a preset that bends the whole box ----
//
// An envelope preset (Valley) has no moves. Its shape is a
// mesh the engine generates (`sfxEnvelope`) and it is written to `style.warp`,
// the mesh the box already has: the Transform gizmo and Liquify edit it from
// there, and both engines draw it. Nothing says afterwards that a preset made
// the mesh; a box "has" an envelope while its mesh is exactly the one the
// engine would make for its size.

// `style.warp` for an envelope over a box `w` by `h`, or null when the engine
// has none to give.
export function envelopeWarp(env, w, h) {
  const e = textEngine();
  if (!env || typeof e?.sfxEnvelope !== 'function' || !(w > 0) || !(h > 0)) return null;
  let pts;
  try {
    pts = e.sfxEnvelope(env.kind, env.bend, env.cols, env.rows, w, h);
  } catch {
    return null;
  }
  const warp = normalizeWarp({ on: true, cols: env.cols, rows: env.rows, pts });
  return warp.pts.length ? warp : null;
}

// Whether the box's mesh is that envelope, untouched (to a hundredth of a px).
export function isEnvelope(style, env, w, h) {
  const have = style?.warp;
  if (!env || !have?.on || have.cols !== env.cols || have.rows !== env.rows) return false;
  const want = envelopeWarp(env, w, h);
  if (!want || want.pts.length !== have.pts?.length) return false;
  return want.pts.every((p, i) => Math.abs(p[0] - have.pts[i][0]) <= 0.01 && Math.abs(p[1] - have.pts[i][1]) <= 0.01);
}

// The built-in preset whose envelope the box's mesh is, or null.
export function envelopeOf(style, w, h) {
  if (!style?.warp?.on) return null;
  return sfxPresets().find((p) => p.envelope && isEnvelope(style, p.envelope, w, h)) ?? null;
}

// What a preset writes over on the box, as it stands now.
function standing(style) {
  return {
    letterSpacing: Number(style.letterSpacing) || 0,
    lineHeight: style.lineHeight,
    curve: style.curve,
    circle: !!style.circle?.on,
    path: !!style.path?.on,
    warp: normalizeWarp(style.warp),
  };
}

// The box's mesh with a preset's envelope taken off it: the mesh the box had
// before SFX, or none.
const unbent = (style, before) => normalizeWarp(before?.warp ?? { on: false, cols: style.warp.cols, rows: style.warp.rows, pts: [] });

// Mutates `style` to the preset: the recipe, and the gap between letters and
// between lines. The seed stays the box's own. Font, size, colour and strokes
// are the user's and are not touched.
//
// What it writes over is kept in `sfx.before`, taken once, when SFX goes on:
// a second preset is laid over the first one's values, which are not the
// box's. `clearSfx` puts it back.
//
// `box` gives the size an envelope is laid over (`{ w, h }`). A preset with an
// envelope REPLACES the box's mesh with it, a hand-made one included. A preset
// without one leaves a hand-made mesh alone and takes away only a mesh that
// is another preset's envelope, so picking Grow after Valley is Grow.
export function applySfxPreset(style, preset, box = null) {
  const before = style.sfx?.on ? (style.sfx.before ?? null) : standing(style);
  const had = box ? envelopeOf(style, box.w, box.h) : null;
  const bent = box ? envelopeWarp(preset.envelope, box.w, box.h) : null;
  if (bent) style.warp = bent;
  else if (had) style.warp = unbent(style, before);
  style.sfx = normalizeSfx({
    on: true,
    amount: 1,
    seed: style.sfx?.seed,
    flow: preset.flow,
    rowShift: preset.rowShift,
    moves: preset.moves,
    before,
  });
  enableSfx(style);
  style.letterSpacing = (Number(preset.gap) || 0) * style.size;
  style.lineHeight = preset.lineHeight ?? before?.lineHeight ?? style.lineHeight;
}

// A recipe pasted from another box (`pasteStyle`) carries what SFX wrote over
// on THAT box (`sfx.before`). The paste does not move a box's own geometry -
// its mesh and its path stay this box's - so what Remove SFX puts back of them
// is this box's too, as they stand, and never the other box's mesh brought
// back later by a preset that takes its envelope off.
export function rebaseSfx(style) {
  const before = style?.sfx?.before;
  if (!before) return;
  before.warp = normalizeWarp(style.warp);
  before.path = !!style.path?.on;
}

// Switches SFX off and puts back what the preset wrote over: the gaps, the
// bends SFX switched off, and the mesh. A mesh that is a preset's envelope
// goes (`box` gives the size to tell by); one the user made or edited after
// stays. `keepBends` leaves the arc, the ring and the path as they are now,
// for a caller that is switching one of them on.
export function clearSfx(style, box = null, keepBends = false) {
  const before = style.sfx.before;
  if (box && envelopeOf(style, box.w, box.h)) style.warp = unbent(style, before);
  if (before) {
    style.letterSpacing = before.letterSpacing;
    style.lineHeight = before.lineHeight;
    if (!keepBends) {
      style.curve = before.curve;
      style.circle.on = before.circle;
      style.path.on = before.path;
    }
  }
  style.sfx.on = false;
  style.sfx.before = null;
}
