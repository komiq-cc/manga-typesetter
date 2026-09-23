// ===== What the transform gizmo draws, and what a drag does to the mesh =====
//
// The gizmo itself is `editor/WarpGizmo.svelte`: an SVG over the selected box.
// Everything it draws and everything a gesture changes is worked out here
// instead, for the reason `warp.js` exists at all - the geometry is testable in
// node and the component is then only pointers and markup.
//
// Two halves, and the rule between them is the file's own boundary:
//
//   - Above the rule: pure. Positions, segments, index maths, the new mesh a
//     drag or a grid change produces. Nothing here reads or writes a document.
//   - Below it: the three gestures the gizmo commits - a handle drag, its
//     cancel, and Reset - which DO write the box and record history, one step
//     per gesture, exactly as the mask tool's shapes do. They live here rather
//     than in the component so that "one history entry per drag" is a claim a
//     node test can make.
//
// Every coordinate above the rule is box-local page px, the same space
// `warp.pts`, `clip.shapes` and `ink` are stored in. The zoom and the box's
// rotation are the component's business: it is a child of the box element, so
// the rotation is already applied to it, and the zoom is one multiply at the
// point of drawing.

import { identityMesh, isIdentityMesh, resampleMesh, meshMap } from './warp.js';
import { WARP_MIN_GRID, WARP_MAX_GRID } from './data.js';
import { cloneStyle, markUnsaved, reviewBox, pageById } from './store.svelte.js';
import { record } from './editor/history.svelte.js';

// The handle's radius on SCREEN, px, and it is screen px on purpose: a handle
// is a target for a pointer, so it is the same size at every zoom. The mesh
// hairline is the same idea - one device pixel, whatever the page is scaled to.
export const HANDLE_R = 5;

// The finest grid the gizmo puts handles on. 9x9 = 81 dots is already more
// than can be shown without them touching; a mesh finer than this - which the
// liquify tool routinely makes - draws as hairlines only, and is reshaped with
// the liquify tool or reset, not dragged dot by dot.
export const HANDLE_GRID_MAX = 8;

// The keyboard's step, PAGE px - the unit the mesh is stored in, so a nudge
// moves a control point by the same amount at every zoom and a letterer can say
// "two pixels left" and get two pixels. Shift multiplies, the way every nudge in
// every editor does.
export const NUDGE_STEP = 1;
export const NUDGE_BIG_STEP = 10;

// How long a burst of arrow keys stays one edit. The Inspector's own settle
// window (SETTLE_MS), and the same number for the same reason: a held arrow key
// auto-repeats, and one history entry per repeat would empty a five-step stack
// in half a second and leave the user unable to undo back past the nudge.
export const NUDGE_SETTLE_MS = 400;

// Which way an arrow key moves a control point, page px, or null for a key that
// is not a nudge. Pure so the component's key handler is a lookup and a guard.
export function nudgeDelta(key, shift = false) {
  const d = shift ? NUDGE_BIG_STEP : NUDGE_STEP;
  if (key === 'ArrowLeft') return [-d, 0];
  if (key === 'ArrowRight') return [d, 0];
  if (key === 'ArrowUp') return [0, -d];
  if (key === 'ArrowDown') return [0, d];
  return null;
}

const gridN = (n) => {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return WARP_MIN_GRID;
  return Math.min(WARP_MAX_GRID, Math.max(WARP_MIN_GRID, v));
};

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

// The mesh the gizmo shows. A warp that has never been dragged stores no points
// at all (see data.js), and a gizmo cannot put handles on nothing - so the
// identity grid is materialised for the DRAWING without being written to the
// document. It reaches the document only when a drag actually moves one.
export function gizmoPts(warp, w, h) {
  const cols = gridN(warp?.cols);
  const rows = gridN(warp?.rows);
  const want = (cols + 1) * (rows + 1);
  const pts = warp?.pts;
  if (Array.isArray(pts) && pts.length === want) {
    // Copied, never aliased: this is handed to the drag as its starting point,
    // and a drag that mutated the live array in place would leave nothing to
    // cancel back to.
    const out = [];
    for (const p of pts) {
      const x = +p?.[0];
      const y = +p?.[1];
      // One unreadable point makes the whole mesh undrawable - the same
      // all-or-nothing rule the sanitiser keeps - so the gizmo falls back to
      // the grid rather than showing a handle at NaN.
      if (!Number.isFinite(x) || !Number.isFinite(y)) return identityMesh(cols, rows, w, h);
      out.push([x, y]);
    }
    return out;
  }
  return identityMesh(cols, rows, w, h);
}

// One entry per control point: which index in `pts` it writes, where it sits,
// and which corner/edge of the grid it is (`col`/`row`), because a corner
// handle of a 1x1 mesh sits exactly where the box's own resize handle would and
// the component wants to say so in its markup.
export function handlePoints(warp, w, h) {
  const cols = gridN(warp?.cols);
  const rows = gridN(warp?.rows);
  const pts = gizmoPts(warp, w, h);
  const out = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const k = j * (cols + 1) + i;
      out.push({ i: k, col: i, row: j, x: pts[k][0], y: pts[k][1] });
    }
  }
  return out;
}

// How closely the wireframe follows a curved cell edge: one sample about every
// this many page px along it, between one and MESH_LINE_MAX per cell. A 100px
// cell on a balloon gets eight straight pieces, which reads as a curve at any
// zoom the editor offers; a liquify mesh's 12px cells get one, because its
// nodes are already closer together than a sample would be.
export const MESH_LINE_STEP = 12;
export const MESH_LINE_MAX = 8;

const samplesPerCell = (cell) =>
  Math.max(1, Math.min(MESH_LINE_MAX, Math.round((Number(cell) || 0) / MESH_LINE_STEP)));

// The hairline mesh, as polylines: every grid row left to right, then every
// grid column top to bottom, each a list of `[x, y]` that starts and ends on
// control points and passes through every control point on its way. Between
// the points a line follows the map the painter draws through - straight for a
// one-cell mesh (an affine or projective map keeps lines straight), sampled
// along the bicubic surface for a grid - so the wireframe is not an
// approximation of the warp, it is the warp's own cell boundaries.
export function meshLines(warp, w, h) {
  const cols = gridN(warp?.cols);
  const rows = gridN(warp?.rows);
  const W = Math.max(0, num(w));
  const H = Math.max(0, num(h));
  const pts = gizmoPts(warp, w, h);
  const map = meshMap(pts, cols, rows, W, H);
  const curve = map?.kind === 'smooth' ? map.at : null;
  const kx = curve ? samplesPerCell(W / cols) : 1;
  const ky = curve ? samplesPerCell(H / rows) : 1;
  const at = (i, j) => pts[j * (cols + 1) + i];
  const out = [];
  for (let j = 0; j <= rows; j++) {
    const line = [];
    const y = (H * j) / rows;
    for (let i = 0; i < cols; i++) {
      line.push(at(i, j));
      for (let s = 1; s < kx; s++) line.push(curve((W * (i + s / kx)) / cols, y));
    }
    line.push(at(cols, j));
    out.push(line);
  }
  for (let i = 0; i <= cols; i++) {
    const line = [];
    const x = (W * i) / cols;
    for (let j = 0; j < rows; j++) {
      line.push(at(i, j));
      for (let s = 1; s < ky; s++) line.push(curve(x, (H * (j + s / ky)) / rows));
    }
    line.push(at(i, rows));
    out.push(line);
  }
  return out;
}

// The dashed ghost: where the box's outline was before the mesh moved it, as a
// closed polygon (tl, tr, br, bl). It is the box rect itself, because that is
// what the identity mesh is - the one reference a user needs to read how far
// they have pulled something.
export function ghostOutline(w, h) {
  const W = Math.max(0, num(w));
  const H = Math.max(0, num(h));
  return [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ];
}

// A drag: the mesh with control point `i` put at (x, y). A fresh array of fresh
// points, so the caller can hold the pre-drag mesh as its cancel state and the
// document's own array is replaced rather than edited under the renderer.
//
// An index outside the mesh, or a destination that is not a number, changes
// nothing: a pointer event that arrived after a grid change (the one way the
// two can disagree) must not tear the mesh.
export function movedPts(pts, i, x, y) {
  if (!Array.isArray(pts)) return [];
  const k = Math.floor(Number(i));
  const px = +x;
  const py = +y;
  const out = pts.map((p) => [+p?.[0], +p?.[1]]);
  if (!(k >= 0 && k < out.length)) return out;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return out;
  out[k] = [px, py];
  return out;
}

// The warp block after a grid stepper moves. The DEFORMATION SURVIVES: the new
// grid's identity points are pushed through the old mesh (`resampleMesh`), so
// 1x1 dragged into a perspective and then stepped to 3x3 keeps that
// perspective and gains interior handles inside it. See `resampleMesh` for why
// it is not reversible - a 3x3 stepped back to 1x1 keeps only the corners,
// which is what a 1x1 mesh can say.
//
// A mesh that has not been dragged stays empty rather than being materialised
// at the new size: empty IS identity everywhere in this codebase, and writing
// eighty-one identity points into the file for a warp nobody has touched would
// only make the document bigger.
export function regridWarp(warp, cols, rows, w, h) {
  const oldCols = gridN(warp?.cols);
  const oldRows = gridN(warp?.rows);
  const c = gridN(cols);
  const r = gridN(rows);
  const on = warp?.on === true;
  const pts = warp?.pts;
  const same = (c + 1) * (r + 1);
  const had = Array.isArray(pts) && pts.length === (oldCols + 1) * (oldRows + 1);
  if (!had || isIdentityMesh(pts, oldCols, oldRows, w, h)) {
    return { on, cols: c, rows: r, pts: [] };
  }
  if (c === oldCols && r === oldRows) {
    return { on, cols: c, rows: r, pts: pts.map((p) => [+p[0], +p[1]]) };
  }
  const next = resampleMesh(pts, oldCols, oldRows, c, r, w, h);
  return { on, cols: c, rows: r, pts: next.length === same ? next : [] };
}

// A mesh that has come back to identity is stored as no mesh at all, so that a
// drag out and back leaves the document exactly as it found it - and so that
// `warpActive` skips the whole texture pass rather than drawing a box through a
// mesh that does nothing.
function normalisePts(warp, w, h) {
  if (!Array.isArray(warp?.pts) || !warp.pts.length) return;
  if (isIdentityMesh(warp.pts, warp.cols, warp.rows, w, h)) warp.pts = [];
}

// ===========================================================================
// The gestures. Below this line a document is being written.
// ===========================================================================

// Pointer-down on a handle. Takes the before-snapshot FIRST - the repo's own
// rule, learned the hard way in the Inspector, where a snapshot taken after the
// mutation diffed as before === after and recorded nothing - and only then
// materialises the identity mesh the gizmo has been drawing, so that the drag
// has an array to write into.
//
// Hands back the snapshot the other two gestures need. Nothing is recorded
// here: a gesture is one history step and this is only its beginning.
export function beginWarpDrag(box) {
  const before = cloneStyle(box.style);
  box.style.warp.pts = gizmoPts(box.style.warp, box.w, box.h);
  return before;
}

// Pointer-move. Writes the live style, because the box is drawn from it - the
// canvas the gizmo repaints reads `warp.pts` through the painter, and a draft
// held to one side would mean two meshes to keep in step. Deliberately silent:
// no `markUnsaved`, no record, nothing that settles - a drag in progress is not
// an edit until the pointer comes up.
export function dragWarpTo(box, i, x, y) {
  box.style.warp.pts = movedPts(box.style.warp.pts, i, x, y);
}

// Escape, or a cancelled pointer. The style goes back whole rather than the
// mesh alone: `before` is a clone of the entire style, which is the same thing
// the `style` history kind restores, so cancel and undo can never mean two
// different things.
export function cancelWarpDrag(box, before) {
  box.style = cloneStyle(before);
}

// Pointer-up: ONE history step for the whole drag, or none at all.
//
// None at all is the common case worth naming: a click on a handle that moves
// nothing materialised the identity mesh in `beginWarpDrag`, and committing
// that would put an entry on the stack for a gesture that changed no pixel. So
// an identity mesh is normalised back to the empty array first and the styles
// are compared after - a press-and-release leaves the document byte for byte
// what it was, and the undo stack untouched.
export function commitWarpDrag(box, pageId, before) {
  normalisePts(box.style.warp, box.w, box.h);
  const after = cloneStyle(box.style);
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  markUnsaved();
  // The mesh carries the box's ink wherever it was dragged, and the flag has to
  // say whether that is still inside the box (OVF-7). Once, here: a flag per
  // pointer move would repaint every badge on the page forty times a second.
  reviewBox(box, pageById(pageId) ?? undefined);
  record({ t: 'style', pageId, boxId: box.id, before, after });
  return true;
}

// One gesture, from the moment it starts to the one commit or cancel it is
// allowed. Every way a gesture can end goes through here - pointer-up, Escape,
// a pointer the browser cancelled, the settle at the end of a keyboard burst,
// and the gizmo being unmounted while the pointer is still down - and `settled`
// is what makes "exactly one history step per gesture" a property of the object
// rather than a discipline four call sites have to keep.
//
// It exists because of the last of those endings. A gizmo can go away mid-drag
// without a pointer event ever arriving: the user arms the brush, switches
// sub-tab, or clicks another box. Tearing down the listeners is not enough -
// the mesh is left wherever the pointer had dragged it to, with no entry on the
// stack that could undo it. So the component's teardown ends the gesture like
// any other ending, and this is the thing that guarantees the ending happens
// once whichever way it is reached.
export function warpDragGesture(box, pageId, index) {
  const before = beginWarpDrag(box);
  let settled = false;
  return {
    index,
    box,
    get settled() {
      return settled;
    },
    // Absolute, in box-local page px: where the control point goes now.
    to(x, y) {
      if (settled) return false;
      dragWarpTo(box, index, x, y);
      return true;
    },
    // Relative, which is what a keyboard nudge has: the point as it stands, plus
    // the step. Read from the live mesh rather than kept alongside it, so a
    // nudge and a drag of the same gesture cannot drift apart.
    by(dx, dy) {
      if (settled) return false;
      const p = box.style.warp.pts?.[index];
      if (!p) return false;
      return this.to(+p[0] + (+dx || 0), +p[1] + (+dy || 0));
    },
    commit() {
      if (settled) return false;
      settled = true;
      return commitWarpDrag(box, pageId, before);
    },
    cancel() {
      if (settled) return false;
      settled = true;
      cancelWarpDrag(box, before);
      return true;
    },
  };
}

// Reset: the mesh back to identity, one history step, and nothing at all when
// there is nothing to reset.
export function resetWarp(box, pageId) {
  const w = box.style.warp;
  if (!Array.isArray(w.pts) || !w.pts.length) return false;
  const before = cloneStyle(box.style);
  w.pts = [];
  markUnsaved();
  reviewBox(box, pageById(pageId) ?? undefined);
  record({ t: 'style', pageId, boxId: box.id, before, after: cloneStyle(box.style) });
  return true;
}
