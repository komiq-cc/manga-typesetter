// ===== Liquify, applied to a box's mesh =====
//
// The liquify field (`liquify.js`) moves points. Here the points are the control
// points of the box's warp mesh - the same `style.warp` the Transform sub-tab
// drags by hand - so one tool bends the type and the ink together, through the
// texture path the exporter already has, and the result is stored as nothing
// but a mesh. A liquified box is a warped box; undo, reset and export all
// already know what to do with one.
//
// Two halves, the rule between them being this file's boundary, as in
// `warp-gizmo.js`: above it pure geometry a node test can hold; below it the
// one gesture that writes a document.
//
// Every coordinate is BOX-LOCAL page px.

import { liquifyField } from './liquify.js';
import { WARP_MAX_GRID, WARP_MIN_GRID } from './data.js';
import { gizmoPts, regridWarp } from './warp-gizmo.js';
import { cloneStyle, markUnsaved, reviewBox, pageById } from './store.svelte.js';
import { record } from './editor/history.svelte.js';

// The mesh spacing the tool wants, as a fraction of its radius. Cells about
// three fifths of the radius put two or three control points under the tool,
// which is enough for the falloff to read as a curve rather than a kink; finer
// costs triangles per frame for no visible gain.
const CELL_PER_RADIUS = 0.6;
// The smallest cell worth having, page px: below this a mesh is more handles
// than picture.
const CELL_MIN = 10;

// One frame at 60 Hz, in ms - the engine's own unit for the hold modes.
export const FRAME_MS = 16.7;

// The frame weight for a gap of `dt` ms. No clock reads as one frame; a gap of
// zero or less is time that did not pass.
export function frameScaleFor(dt) {
  const n = +dt;
  if (!Number.isFinite(n)) return 1;
  return n > 0 ? n / FRAME_MS : 0;
}

// The grid a tool of `radius` wants over a box of `w` x `h`. Never coarser
// than the mesh already has (`cur`), so a hand-set transform is not thrown
// away by picking up the liquify tool - `regridWarp` carries the deformation
// over either way, but only a finer grid keeps all of it.
export function liquifyGrid(w, h, radius, cur = null) {
  const cell = Math.max(CELL_MIN, (Number(radius) || 0) * CELL_PER_RADIUS);
  const want = (len) =>
    Math.min(WARP_MAX_GRID, Math.max(WARP_MIN_GRID, Math.ceil((Number(len) || 0) / cell)));
  const cols = Math.max(want(w), Number(cur?.cols) || WARP_MIN_GRID);
  const rows = Math.max(want(h), Number(cur?.rows) || WARP_MIN_GRID);
  return { cols: Math.min(cols, WARP_MAX_GRID), rows: Math.min(rows, WARP_MAX_GRID) };
}

// One application of the tool to a list of mesh points, as a NEW array - or
// THE SAME array when no point moved, which is what lets a drag that wanders
// off the box cost no repaint and, at the end, no history entry. `opts` is
// `applyLiquify`'s: { mode, cx, cy, radius, strength, dx, dy, scale }.
export function liquifyMesh(pts, opts) {
  const list = Array.isArray(pts) ? pts : [];
  const o = opts ?? {};
  let moved = false;
  const out = list.map((p) => {
    const x = +p[0];
    const y = +p[1];
    const [ox, oy] = liquifyField(o.mode, o.cx, o.cy, o.radius, o.strength, o.dx, o.dy, x, y, o.scale);
    if (ox === 0 && oy === 0) return p;
    moved = true;
    return [x + ox, y + oy];
  });
  return moved ? out : list;
}

// ===========================================================================
// The gesture. Below this line a document is being written.
// ===========================================================================

// One drag, from pointer-down to its one history step. The mesh is switched on
// and materialised at the tool's density when the gesture begins, so there is
// something to bend; a drag that then moved nothing is committed as nothing,
// with the style put back exactly as it was found - a click on the tool must
// not leave a box "warped" by an identity mesh.
//
// `settled` makes "one step per gesture" a property of the object: pointer-up,
// Escape, a cancelled pointer and an unmount mid-drag all go through commit or
// cancel, and only the first of them does anything.
export function liquifyMeshGesture(box, pageId, tool) {
  const before = cloneStyle(box.style);
  const w = box.style.warp;
  const grid = liquifyGrid(box.w, box.h, tool.radius, w);
  const next = regridWarp(w, grid.cols, grid.rows, box.w, box.h);
  next.on = true;
  next.pts = gizmoPts(next, box.w, box.h);
  box.style.warp = next;
  let settled = false;
  let changed = false;
  return {
    tool,
    get settled() {
      return settled;
    },
    get changed() {
      return changed;
    },
    // One application, centred at (cx, cy); `dx`/`dy` the pointer's delta since
    // the last one (push reads it; the hold modes take `scale`). Returns
    // whether the mesh moved.
    step({ cx, cy, dx = 0, dy = 0, scale = 1 } = {}) {
      if (settled) return false;
      const cur = box.style.warp.pts;
      const push = tool.mode === 'push';
      const out = liquifyMesh(cur, {
        mode: tool.mode,
        cx,
        cy,
        radius: tool.radius,
        strength: tool.strength,
        dx: push ? dx : 0,
        dy: push ? dy : 0,
        scale,
      });
      if (out === cur) return false;
      // The live style, because the box is drawn from it. Silent: a drag in
      // progress is not an edit until the pointer comes up.
      box.style.warp.pts = out;
      changed = true;
      return true;
    },
    commit() {
      if (settled) return false;
      settled = true;
      if (!changed) {
        box.style = cloneStyle(before);
        return false;
      }
      markUnsaved();
      // Where the mesh left the box's ink decides its flag (OVF-7), and the
      // gesture's end is the one moment to ask.
      reviewBox(box, pageById(pageId) ?? undefined);
      record({ t: 'style', pageId, boxId: box.id, before, after: cloneStyle(box.style) });
      return true;
    },
    cancel() {
      if (settled) return false;
      settled = true;
      box.style = cloneStyle(before);
      return true;
    },
  };
}
