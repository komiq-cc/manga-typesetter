// ===== Drawing through the mesh =====
//
// One pass, used by both renderers: the box is already a finished picture on a
// canvas - type, ink, shadows, blur, smear, mask, all of it - and this carries
// that texture through the mesh onto a new one. `warp.js` owns the geometry and
// knows nothing about canvases; this file owns the canvas and works out no
// geometry of its own beyond the things a rasteriser needs and pure maths does
// not: how far past the mesh the destination has to reach, and how the
// triangles go down so the joins between them do not show.
//
// The texture is the whole box FOOTPRINT, not the box rect: a glyph can hang
// out of its box and ink is routinely drawn over the edge, and warping a box
// must not be the thing that crops them. So the mesh's own cells are drawn, and
// around them a band of cells covering the rest of the footprint, mapped by
// extending the outermost cell - which is exactly what `warpPoint` does with a
// point outside the grid, so the extension is continuous with the inside and is
// stated in one place.

import { isIdentityMesh, affineFromTriangle, affineWarpPoint, meshMap } from './warp.js';

// How far past the deformed mesh the destination canvas reaches, page px. Two
// is the antialiasing bleed: a triangle whose edge lands on the last pixel of
// the canvas has half its coverage cut off, and on a folded mesh the overdraw
// guard below pushes each edge out by a fraction of a pixel more.
export const WARP_PAD = 2;

// How finely a curved map is subdivided before it is drawn, at the floor and at
// the ceiling. The projective map and the bicubic surface are both approximated
// by a straight affine piece per virtual cell, and the error of that
// approximation is a fraction of the CELL, not of the box: measured against the
// homography it approximates, eight by eight is a third of a pixel out on a
// 100px balloon and thirteen out on a 4000px full-page SFX under a moderate
// drag - which facets visibly, and gets worse the harder the corner is pulled.
// So the grid follows the box's size - one cell per ~120 page px - and the two
// bounds are what keeps that honest at both ends: never coarser than the 8x8
// that was right for a small box, never finer than 32x32 on a side, which is
// 2048 triangles and already past the point where another one changes a pixel.
//
// For a MESH the count is per side of the whole box, spread over the mesh's
// own cells: a 3x3 on a balloon gets three virtual cells per mesh cell, a
// 24x24 liquify mesh gets one (its cells are already finer than the floor
// asks), and nothing gets more than the ceiling on a side.
export const WARP_SUB = 8;
export const WARP_SUB_MAX = 32;
export const WARP_SUB_PX = 120;

// The virtual grid for a box this big. Exported because it is a claim about
// quality that deserves a test of its own rather than a number buried in a
// planner.
export function subdivisionFor(w, h) {
  const span = Math.max(num(w), num(h));
  if (!(span > 0)) return WARP_SUB;
  return Math.min(WARP_SUB_MAX, Math.max(WARP_SUB, Math.round(span / WARP_SUB_PX)));
}

// What a canvas may actually be. Every browser refuses past some size, and the
// numbers below are the smallest of the common caps with room to spare: 16384
// on a side, and an area that keeps one bitmap under a quarter of a gigabyte -
// this app has put two whole gigabytes in the webview before, and a warp is not
// the place to do it again.
//
// A mesh can ask for more than that only when it is close to degenerate - a
// near-horizon projective quad, where a few pixels of drag blow the footprint
// up by orders of magnitude. The response is graded: the bitmap is rendered at
// a lower resolution first, keeping the picture and losing sharpness, and only
// a demand so far past the cap that even that will not fit is refused outright
// (which draws the box unwarped, the one outcome that is always bounded).
export const MAX_DEVICE = 16384;
export const MAX_DEVICE_AREA = 64e6;
export const MIN_DEVICE_SCALE = 0.25;

// How far each destination triangle's clip is grown on a FOLDED mesh, page px.
// Canvas antialiases a clip edge, so two triangles meeting along a shared edge
// each cover about half of the pixels on it, and laid one over the other they
// composite to about three quarters - a hairline of background showing through
// every join. Growing both clips past the join makes each one cover it fully,
// and the second draw lands on pixels the first already filled. Three quarters
// of a pixel is enough for the AA ramp and small enough that the texture it
// pulls in from over the edge is the neighbouring cell's own content.
//
// It has a price, and it is why a mesh that lies flat is not drawn this way: a
// join is drawn twice, so a translucent pixel on it composites with itself - a
// half-opaque shadow comes out three quarters opaque along every join. A flat
// mesh adds its triangles instead (see `warpBoxCanvas`), which is exact.
export const SEAM_OVERDRAW = 0.75;

// A refusal to draw: the map has sent the footprint somewhere no raster can
// hold it (a projective map's horizon crossing the band, most likely), so the
// plan is thrown away and the caller falls back. Stated as a multiple of the
// source's own size rather than an absolute, so it means the same thing for a
// 40px box and a 4000px one.
const SPAN_LIMIT = 32;

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const gridN = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 1 ? v : 1;
};

// One triangle with every EDGE pushed `pad` px outwards: each edge's line is
// offset along its own outward normal and the new corners are where the offset
// lines cross.
//
// It has to be the edges and not the vertices. Moving each vertex `pad` away
// from the centroid is the obvious version and it does not work: on a
// half-cell cut along its diagonal, that displacement moves the diagonal
// itself only a fraction of `pad`, so two neighbouring halves still each cover
// about half of the pixels on their shared edge - and half over half
// composites to three quarters, which is the seam this exists to close. With
// the edge offset at three quarters of a pixel, every pixel the edge crosses
// is COMPLETELY inside at least one of the two triangles, and completely
// inside is the only coverage that composites to opaque.
//
// A miter at a very sharp corner runs away, so the vertex displacement is
// capped; a triangle with no area has no normals and is returned as it came.
export function expandTriangle(tri, pad) {
  const p = num(pad, 0);
  if (!Array.isArray(tri) || tri.length < 3) return tri;
  const a = tri.slice(0, 3).map((q) => [+q?.[0], +q?.[1]]);
  if (!p || !a.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]))) return a;
  // One offset line per edge, as `n . x = c` with `n` pointing away from the
  // triangle's third corner.
  const lines = [];
  for (let i = 0; i < 3; i++) {
    const [ax, ay] = a[i];
    const [bx, by] = a[(i + 1) % 3];
    const [cx, cy] = a[(i + 2) % 3];
    const ex = bx - ax;
    const ey = by - ay;
    const len = Math.hypot(ex, ey);
    if (!(len > 0)) return a;
    let nx = ey / len;
    let ny = -ex / len;
    if (nx * (cx - ax) + ny * (cy - ay) > 0) {
      nx = -nx;
      ny = -ny;
    }
    lines.push([nx, ny, nx * ax + ny * ay + p]);
  }
  const out = [];
  for (let i = 0; i < 3; i++) {
    // Vertex i is where the edges (i-1, i) and (i, i+1) meet, so it is the
    // crossing of those two offset lines.
    const [n1x, n1y, c1] = lines[(i + 2) % 3];
    const [n2x, n2y, c2] = lines[i];
    const det = n1x * n2y - n2x * n1y;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return a;
    let x = (c1 * n2y - c2 * n1y) / det;
    let y = (n1x * c2 - n2x * c1) / det;
    const dx = x - a[i][0];
    const dy = y - a[i][1];
    const d = Math.hypot(dx, dy);
    const cap = Math.abs(p) * 10;
    if (d > cap) {
      x = a[i][0] + (dx / d) * cap;
      y = a[i][1] + (dy / d) * cap;
    }
    out.push([x, y]);
  }
  return out;
}

// The source grid lines for one axis: the mesh's own cell boundaries, each cell
// cut into `per` virtual ones, plus the band the footprint reaches past them.
// Returns the coordinates and, for each, which mesh column/row it is (-1 for a
// virtual or band line, which has no control point and is mapped rather than
// read).
function axisLines(n, per, size, lo, hi) {
  const at = [];
  const m = n * per;
  for (let i = 0; i <= m; i++) at.push({ v: (size * i) / m, k: i % per === 0 ? i / per : -1 });
  if (Number.isFinite(lo) && lo < at[0].v) at.unshift({ v: lo, k: -1 });
  if (Number.isFinite(hi) && hi > at[at.length - 1].v) at.push({ v: hi, k: -1 });
  return at;
}

// Every cell of a rectangular grid as two triangles, cut top-left to
// bottom-right and emitted (tl, tr, br) then (tl, br, bl) - the same convention
// `cellTriangles` states, for the same reason: both halves carry the diagonal's
// endpoints as the same coordinates read from the same entries, so a cell's own
// diagonal cannot open a gap.
function gridTriangles(xs, ys, dst) {
  const w = xs.length;
  const out = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const tl = j * w + i;
      const tr = j * w + i + 1;
      const bl = (j + 1) * w + i;
      const br = (j + 1) * w + i + 1;
      const s = {
        tl: [xs[i].v, ys[j].v],
        tr: [xs[i + 1].v, ys[j].v],
        bl: [xs[i].v, ys[j + 1].v],
        br: [xs[i + 1].v, ys[j + 1].v],
      };
      out.push({ src: [s.tl, s.tr, s.br], dst: [dst[tl], dst[tr], dst[br]] });
      out.push({ src: [s.tl, s.br, s.bl], dst: [dst[tl], dst[br], dst[bl]] });
    }
  }
  return out;
}

// One candidate plan: map every grid point, refuse the whole thing if any of
// them is unusable or if the result has flown off to somewhere no canvas can
// hold. Refusing as a whole is deliberate - half a warped box is worse than an
// unwarped one, and the caller has a fallback to take.
function planFor(xs, ys, map, span) {
  const dst = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const y of ys) {
    for (const x of xs) {
      const q = map(x, y);
      const px = +q?.[0];
      const py = +q?.[1];
      if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
      dst.push([px, py]);
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
  }
  if (!Number.isFinite(minX)) return null;
  if (maxX - minX > span * SPAN_LIMIT || maxY - minY > span * SPAN_LIMIT) return null;
  return { tris: gridTriangles(xs, ys, dst), bounds: { minX, minY, maxX, maxY }, outline: outlineOf(xs.length, ys.length, dst) };
}

// The grid's outer edge in the destination, once round: along the top, down
// the right, back along the bottom, up the left.
function outlineOf(w, h, dst) {
  const ring = [];
  for (let i = 0; i < w; i++) ring.push(dst[i]);
  for (let j = 1; j < h; j++) ring.push(dst[j * w + w - 1]);
  for (let i = w - 2; i >= 0; i--) ring.push(dst[(h - 1) * w + i]);
  for (let j = h - 2; j >= 1; j--) ring.push(dst[j * w]);
  return ring;
}

const turn = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const within = (a, b, c) =>
  Math.min(a[0], b[0]) <= c[0] &&
  c[0] <= Math.max(a[0], b[0]) &&
  Math.min(a[1], b[1]) <= c[1] &&
  c[1] <= Math.max(a[1], b[1]);

// Whether two segments share any point at all, ends included.
function segmentsMeet(p, q, r, s) {
  const d1 = turn(r, s, p);
  const d2 = turn(r, s, q);
  const d3 = turn(p, q, r);
  const d4 = turn(p, q, s);
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (
    (d1 === 0 && within(r, s, p)) ||
    (d2 === 0 && within(r, s, q)) ||
    (d3 === 0 && within(p, q, r)) ||
    (d4 === 0 && within(p, q, s))
  );
}

// Whether a plan's mesh lies over itself anywhere: a handle dragged past its
// neighbour folds part of the sheet back over the rest, and a hard enough twist
// wraps the edge round past where it started. The painter has to know, because
// the additive draw that makes a flat mesh's joins exact would ADD the two
// layers of a fold together rather than lay one over the other.
//
// Two checks, and together they are a proof rather than a guess. Every source
// triangle winds the same way, so a destination triangle that winds the other
// way has been turned over. And when none has, the number of triangles over any
// point is the winding number of the outline around it - every inner edge is
// walked once each way and cancels - which an outline that never touches itself
// holds to one. So: nothing turned over, and a simple outline, means no point
// is covered twice. A triangle squashed to no area covers nothing and counts
// as neither.
export function meshFolds(plan) {
  for (const { dst } of plan.tris) {
    const [a, b, c] = dst;
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < -1e-9) return true;
  }
  const ring = plan.outline;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    // Each edge against every later one that does not share an end with it.
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsMeet(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

// What the painter draws: `{ tris, bounds, projective }` in box-local page px,
// or null when there is nothing to do (an identity mesh, or a mesh that cannot
// be drawn at all).
//
// `rect` is the texture's own extent in box-local px - `{ x, y, w, h }`, with a
// negative origin for the overhang above and left of the box - and is what the
// band of cells is sized from. Omit it and only the box rect is carried.
//
// The map is `meshMap`'s - the homography for a four-handle perspective, the
// bicubic surface for a grid - and a curved map is drawn by subdividing every
// mesh cell into virtual cells whose corners come from the map, because one
// cell drawn as two triangles creases along its diagonal. `subdivisionFor` of
// them per side of the box unless a caller names a number (`opts.sub`): the
// error of an affine piece is a fraction of the cell, and a full-page box needs
// more cells than a balloon does. The control points themselves are carried
// exactly, read straight off the mesh rather than back through the map. A
// one-cell mesh whose affine reading is already exact (a parallelogram) takes
// the plain path - both routes draw the same picture there.
export function warpPlan(warp, w, h, rect = null, opts = {}) {
  const W = num(w);
  const H = num(h);
  if (!(W > 0) || !(H > 0)) return null;
  const cols = gridN(warp?.cols);
  const rows = gridN(warp?.rows);
  const pts = warp?.pts;
  if (isIdentityMesh(pts, cols, rows, W, H)) return null;
  const map = meshMap(pts, cols, rows, W, H);
  if (!map) return null;

  const sub = gridN(opts.sub ?? subdivisionFor(W, H));
  const x0 = rect ? Math.min(0, num(rect.x)) : 0;
  const y0 = rect ? Math.min(0, num(rect.y)) : 0;
  const x1 = rect ? Math.max(W, num(rect.x) + num(rect.w)) : W;
  const y1 = rect ? Math.max(H, num(rect.y) + num(rect.h)) : H;
  const span = Math.max(x1 - x0, y1 - y0, W, H);

  // How many virtual cells each mesh cell is cut into on an axis of `n` cells:
  // enough to reach `sub` per side, never past the ceiling, never fewer than
  // one - and exactly one for the affine reading, which is straight already.
  const per = (n) =>
    map.kind === 'affine' ? 1 : Math.max(1, Math.min(Math.ceil(sub / n), Math.floor(WARP_SUB_MAX / n)));
  const plan = (at, kx, ky) => {
    const xs = axisLines(cols, kx, W, x0, x1);
    const ys = axisLines(rows, ky, H, y0, y1);
    return planFor(
      xs,
      ys,
      (x, y) => (x.k >= 0 && y.k >= 0 ? pts[y.k * (cols + 1) + x.k] : at(x.v, y.v)),
      span,
    );
  };

  const curved = plan(map.at, per(cols), per(rows));
  if (curved) return { ...curved, projective: map.kind === 'projective' };
  // A projective quad whose horizon crosses the band, or one so extreme the
  // raster would be useless: the two triangles are a worse picture than that
  // one, but they are a picture.
  const flat = plan((x, y) => affineWarpPoint(pts, cols, rows, W, H, x, y), 1, 1);
  return flat && { ...flat, projective: false };
}

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// The destination of a plan, sized to what the mesh actually covers plus the AA
// bleed, and snapped outwards to whole page px so the box's origin inside it
// stays an integer offset - which is what lets the page composite go on
// snapping the bitmap to the pixel grid.
function planExtent(plan, pad) {
  const left = Math.floor(plan.bounds.minX - pad);
  const top = Math.floor(plan.bounds.minY - pad);
  const right = Math.ceil(plan.bounds.maxX + pad);
  const bottom = Math.ceil(plan.bounds.maxY + pad);
  return { left, top, outW: Math.max(1, right - left), outH: Math.max(1, bottom - top) };
}

/**
 * Where a texture lands once the mesh has carried it, without drawing it: the
 * `{ ox, oy, cw, ch }` `warpBoxCanvas` would hand back for the same options,
 * page px. Null where the mesh does nothing. For whoever needs to know what a
 * warped box covers and has no reason to paint it.
 */
export function warpExtent(opts = {}) {
  const { warp, w, h, ox, oy, cw, ch } = opts;
  const plan = warpPlan(warp, w, h, { x: -ox, y: -oy, w: cw, h: ch }, { sub: opts.sub });
  if (!plan) return null;
  const e = planExtent(plan, num(opts.pad ?? WARP_PAD));
  return { ox: -e.left, oy: -e.top, cw: e.outW, ch: e.outH };
}

// Draw the finished box texture `src` through the mesh, onto a canvas of its
// own. Returns `{ canvas, ox, oy, cw, ch }` in the same terms the texture came
// in - `ox`/`oy` is where the box's top-left sits inside the footprint, `cw`/`ch`
// is the footprint in page px - or null when the mesh does nothing, which is the
// caller's signal to keep the texture it already has, byte for byte.
//
// `ss` is the texture's supersampling: it is drawn at its own pixel size, so
// nothing is resampled here beyond the warp itself - unless the footprint the
// mesh asks for is bigger than a canvas may be, in which case the RESOLUTION
// gives way and the geometry does not. `cw`/`ch` are always the page px the
// bitmap spans, whatever resolution it was rendered at, so a caller places it
// the same way either way.
export function warpBoxCanvas(src, opts = {}) {
  const { warp, w, h, ox, oy, cw, ch } = opts;
  const ss = num(opts.ss, 1) || 1;
  const pad = num(opts.pad ?? WARP_PAD);
  const overdraw = num(opts.overdraw ?? SEAM_OVERDRAW);
  const make = opts.makeCanvas ?? newCanvas;
  const plan = warpPlan(warp, w, h, { x: -ox, y: -oy, w: cw, h: ch }, { sub: opts.sub });
  if (!plan) return null;

  const { left, top, outW, outH } = planExtent(plan, pad);

  // What a canvas may be. A mesh close to degenerate can ask for a footprint
  // orders of magnitude past the box - `SPAN_LIMIT` is the outer bound and it is
  // 32 times the source - and at the export's supersample that is a bitmap no
  // browser will hand out: `getContext` on an oversized canvas returns null in
  // some, throws in others, and silently gives back a blank one in the rest, so
  // every one of them ends in a box that vanished from the page.
  //
  // Resolution is what gives way first: the same picture, rendered at fewer
  // device px per page px, still lands in the right place at the right size.
  // Only a demand so far past the cap that even a quarter of a device pixel per
  // page pixel will not fit is refused, and a refusal here is the caller's
  // signal to draw the box UNWARPED - the one outcome that is bounded whatever
  // the mesh says.
  const fit = Math.min(
    1,
    MAX_DEVICE / (outW * ss),
    MAX_DEVICE / (outH * ss),
    Math.sqrt(MAX_DEVICE_AREA / (outW * ss * outH * ss)),
  );
  if (!(fit > 0)) return null;
  const rs = ss * Math.min(1, fit);
  if (rs < MIN_DEVICE_SCALE) return null;

  const canvas = make(Math.max(1, Math.round(outW * rs)), Math.max(1, Math.round(outH * rs)));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  // Box-local page px, at whatever resolution survived the cap.
  ctx.setTransform(rs, 0, 0, rs, 0, 0);
  ctx.translate(-left, -top);

  // How the triangles go down. Where the mesh lies flat they tile the
  // destination edge to edge, so each is clipped to exactly itself and ADDED
  // ('lighter') onto this empty canvas. A clip edge is antialiased, and the two
  // triangles either side of a join cover complementary parts of every pixel on
  // it - their coverages sum to one, so their sum is the texture's own pixel:
  // opaque stays opaque, and a half-opaque shadow, outline or ink edge stays
  // half opaque rather than compositing with itself.
  //
  // A fold is where adding is wrong - two layers of the mesh over the same
  // pixels, and a white outline plus a black fill is white. A folded mesh is
  // laid down the way paper is instead, each triangle over the ones before it,
  // with every clip grown by `SEAM_OVERDRAW` so the joins are covered.
  const additive = !meshFolds(plan);
  if (additive) ctx.globalCompositeOperation = 'lighter';

  for (const tri of plan.tris) {
    const m = affineFromTriangle(tri.src, tri.dst);
    if (!m) continue; // a cell with no area covers no pixels either
    const e = additive ? tri.dst : expandTriangle(tri.dst, overdraw);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(e[0][0], e[0][1]);
    ctx.lineTo(e[1][0], e[1][1]);
    ctx.lineTo(e[2][0], e[2][1]);
    ctx.closePath();
    ctx.clip();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    // Now in the texture's own (pre-warp) box-local coordinates: its top-left
    // corner is (-ox, -oy) there, and it is `cw` x `ch` page px across.
    ctx.drawImage(src, -ox, -oy, cw, ch);
    ctx.restore();
  }
  return { canvas, ox: -left, oy: -top, cw: outW, ch: outH };
}
