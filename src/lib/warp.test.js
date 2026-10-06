import { describe, it, expect } from 'vitest';
import {
  identityMesh,
  isIdentityMesh,
  cellTriangles,
  affineFromTriangle,
  warpPoint,
  resampleMesh,
  meshBounds,
  solveHomography,
  applyHomography,
  isParallelogram,
  warpActive,
  meshMap,
  affineWarpPoint,
  unwarpPoint,
} from './warp.js';
import { normalizeStyle, normalizeWarp, defaultStyle } from './data.js';

// The worked example the hand-computed cases below all use: a 100x100 box with
// a 1x1 mesh whose bottom-right corner has been dragged to (120, 140). Every
// expected number in this file was worked out on paper from these four points.
const W = 100;
const H = 100;
const BR = [
  [0, 0],
  [100, 0],
  [0, 100],
  [120, 140],
];

describe('identityMesh', () => {
  it('lays a 1x1 grid out as the box corners, row-major', () => {
    expect(identityMesh(1, 1, 100, 50)).toEqual([
      [0, 0],
      [100, 0],
      [0, 50],
      [100, 50],
    ]);
  });

  it('gives (cols+1) * (rows+1) points and lands the last column on w exactly', () => {
    const pts = identityMesh(3, 2, 90, 60);
    expect(pts).toHaveLength(12);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[3]).toEqual([90, 0]);
    expect(pts[4]).toEqual([0, 30]);
    expect(pts[11]).toEqual([90, 60]);
    // Every row starts at x = 0 and ends at x = w, with no float drift.
    for (let j = 0; j <= 2; j++) {
      expect(pts[j * 4][0]).toBe(0);
      expect(pts[j * 4 + 3][0]).toBe(90);
    }
  });

  it('treats a grid size that is not a usable count as one cell', () => {
    const one = identityMesh(1, 1, 10, 10);
    expect(identityMesh(0, 0, 10, 10)).toEqual(one);
    expect(identityMesh(NaN, undefined, 10, 10)).toEqual(one);
    expect(identityMesh(-4, 0.5, 10, 10)).toEqual(one);
  });
});

describe('isIdentityMesh', () => {
  it('reads an empty pts list as identity, which is what the stored default is', () => {
    expect(isIdentityMesh([], 1, 1, W, H)).toBe(true);
    expect(isIdentityMesh(undefined, 2, 2, W, H)).toBe(true);
  });

  it('reads the identity grid itself as identity', () => {
    expect(isIdentityMesh(identityMesh(2, 3, W, H), 2, 3, W, H)).toBe(true);
  });

  it('holds inside epsilon and breaks outside it', () => {
    const near = identityMesh(1, 1, W, H);
    near[3] = [100.005, 100];
    expect(isIdentityMesh(near, 1, 1, W, H)).toBe(true);
    const far = identityMesh(1, 1, W, H);
    far[3] = [100.5, 100];
    expect(isIdentityMesh(far, 1, 1, W, H)).toBe(false);
    // And the epsilon is the caller's to widen.
    expect(isIdentityMesh(far, 1, 1, W, H, 1)).toBe(true);
  });

  it('reads a mesh of the wrong length, or with an unreadable point, as identity', () => {
    expect(isIdentityMesh([[0, 0], [1, 1]], 1, 1, W, H)).toBe(true);
    const torn = identityMesh(1, 1, W, H);
    torn[3] = [NaN, 100];
    expect(isIdentityMesh(torn, 1, 1, W, H)).toBe(true);
  });
});

describe('cellTriangles', () => {
  it('cuts one cell into two triangles that share the diagonal exactly', () => {
    const [a, b] = cellTriangles(BR, 1, 1, W, H);
    expect(cellTriangles(BR, 1, 1, W, H)).toHaveLength(2);
    // src is the identity grid over the box - the texture the box was drawn
    // into - whatever dst does.
    expect(a.src).toEqual([[0, 0], [100, 0], [100, 100]]);
    expect(b.src).toEqual([[0, 0], [100, 100], [0, 100]]);
    expect(a.dst).toEqual([[0, 0], [100, 0], [120, 140]]);
    expect(b.dst).toEqual([[0, 0], [120, 140], [0, 100]]);
    // THE GUARANTEE: the diagonal's two endpoints are the same coordinates in
    // both halves, in src and dst alike - triangle A carries them at 0 and 2,
    // triangle B at 0 and 1.
    expect(a.src[0]).toEqual(b.src[0]);
    expect(a.src[2]).toEqual(b.src[1]);
    expect(a.dst[0]).toEqual(b.dst[0]);
    expect(a.dst[2]).toEqual(b.dst[1]);
  });

  it('cuts every cell of a bigger grid the same way', () => {
    const tris = cellTriangles([], 2, 2, W, H);
    expect(tris).toHaveLength(8);
    for (let k = 0; k < tris.length; k += 2) {
      const a = tris[k];
      const b = tris[k + 1];
      expect(a.src[0]).toEqual(b.src[0]);
      expect(a.src[2]).toEqual(b.src[1]);
      expect(a.dst[0]).toEqual(b.dst[0]);
      expect(a.dst[2]).toEqual(b.dst[1]);
      // Top-left to bottom-right, never the other diagonal.
      expect(a.src[2][0]).toBeGreaterThan(a.src[0][0]);
      expect(a.src[2][1]).toBeGreaterThan(a.src[0][1]);
    }
  });

  it('draws a mesh of the wrong length undeformed rather than not at all', () => {
    const junk = cellTriangles([[0, 0]], 1, 1, W, H);
    for (const t of junk) expect(t.dst).toEqual(t.src);
  });

  it('copies the points out rather than aliasing the caller’s mesh', () => {
    const pts = BR.map((p) => [...p]);
    const [a] = cellTriangles(pts, 1, 1, W, H);
    a.dst[2][0] = 999;
    expect(pts[3]).toEqual([120, 140]);
  });
});

describe('affineFromTriangle', () => {
  // The unit triangle scaled 2x horizontally, 4x vertically and moved to (2,3).
  it('solves a known scale-and-translate', () => {
    const m = affineFromTriangle(
      [[0, 0], [1, 0], [0, 1]],
      [[2, 3], [4, 3], [2, 7]],
    );
    expect(m).toEqual([2, 0, 0, 4, 2, 3]);
    // Which is to say: x' = 2x + 2, y' = 4y + 3.
    const [a, b, c, d, e, f] = m;
    expect([a * 0.5 + c * 0.5 + e, b * 0.5 + d * 0.5 + f]).toEqual([3, 5]);
  });

  it('solves a quarter turn, coefficients in canvas order', () => {
    // (0,0)->(0,0), (2,0)->(0,2), (0,2)->(-2,0): x' = -y, y' = x.
    expect(affineFromTriangle(
      [[0, 0], [2, 0], [0, 2]],
      [[0, 0], [0, 2], [-2, 0]],
    )).toEqual([0, 1, -1, 0, 0, 0]);
  });

  it('is the identity when the two triangles are the same', () => {
    const t = [[0, 0], [100, 0], [100, 100]];
    expect(affineFromTriangle(t, t)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('returns null for a degenerate source triangle rather than exploding', () => {
    expect(affineFromTriangle([[0, 0], [1, 1], [2, 2]], [[0, 0], [1, 0], [0, 1]])).toBeNull();
    expect(affineFromTriangle([[0, 0], [0, 0], [0, 0]], [[0, 0], [1, 0], [0, 1]])).toBeNull();
    expect(affineFromTriangle(null, null)).toBeNull();
  });
});

describe('warpPoint', () => {
  it('moves nothing through an identity mesh', () => {
    const id = identityMesh(2, 2, W, H);
    for (const [x, y] of [[0, 0], [17, 43], [100, 100], [50, 50]]) {
      const [px, py] = warpPoint(id, 2, 2, W, H, x, y);
      expect(px).toBeCloseTo(x, 10);
      expect(py).toBeCloseTo(y, 10);
    }
    // And through no mesh at all.
    expect(warpPoint([], 1, 1, W, H, 17, 43)).toEqual([17, 43]);
  });

  it('carries the grid points to exactly where the mesh puts them', () => {
    expect(warpPoint(BR, 1, 1, W, H, 100, 100)).toEqual([120, 140]);
    expect(warpPoint(BR, 1, 1, W, H, 0, 0)).toEqual([0, 0]);
    expect(warpPoint(BR, 1, 1, W, H, 100, 0)).toEqual([100, 0]);
    expect(warpPoint(BR, 1, 1, W, H, 0, 100)).toEqual([0, 100]);
  });

  // The dragged corner makes a quad that is not a parallelogram, so the four
  // handles read as a perspective: the same homography the painter draws
  // through, not the two triangles that would crease along the diagonal.
  it('reads a four-handle quad through the homography the painter draws', () => {
    const src = identityMesh(1, 1, W, H);
    const m = solveHomography([src[0], src[1], src[3], src[2]], [BR[0], BR[1], BR[3], BR[2]]);
    for (const [x, y] of [[80, 20], [20, 80], [50, 50]]) {
      const want = applyHomography(m, x, y);
      const got = warpPoint(BR, 1, 1, W, H, x, y);
      expect(got[0]).toBeCloseTo(want[0], 10);
      expect(got[1]).toBeCloseTo(want[1], 10);
    }
    // Which is NOT the triangles' answer in the middle of the cell - (60, 70)
    // is where the diagonal's midpoint would land, and the crease with it.
    const [cx, cy] = warpPoint(BR, 1, 1, W, H, 50, 50);
    expect(Math.abs(cx - 60) + Math.abs(cy - 70)).toBeGreaterThan(1);
    expect(meshMap(BR, 1, 1, W, H).kind).toBe('projective');
  });

  it('reads a parallelogram through the affine map, which is exact there', () => {
    const shear = [[0, 0], [100, 0], [30, 100], [130, 100]];
    expect(meshMap(shear, 1, 1, W, H).kind).toBe('affine');
    const [x, y] = warpPoint(shear, 1, 1, W, H, 50, 50);
    expect(x).toBeCloseTo(65, 10);
    expect(y).toBeCloseTo(50, 10);
  });

  // The plain reading, kept for the two cases where it is the honest one and
  // for the painter's fallback. (80, 20) sits in the upper-right half (v <= u),
  // so it is read against (TL, TR, BR) with barycentric weights 0.2 / 0.6 / 0.2:
  //   0.6 * (100, 0) + 0.2 * (120, 140) = (84, 28)
  // and (20, 80) against (TL, BR, BL) with weights 0.2 / 0.2 / 0.6:
  //   0.2 * (120, 140) + 0.6 * (0, 100) = (24, 88)
  it('affineWarpPoint interpolates each triangle by its barycentrics', () => {
    expect(affineWarpPoint(BR, 1, 1, W, H, 80, 20)[0]).toBeCloseTo(84, 10);
    expect(affineWarpPoint(BR, 1, 1, W, H, 80, 20)[1]).toBeCloseTo(28, 10);
    expect(affineWarpPoint(BR, 1, 1, W, H, 20, 80)[0]).toBeCloseTo(24, 10);
    expect(affineWarpPoint(BR, 1, 1, W, H, 20, 80)[1]).toBeCloseTo(88, 10);
    // (-50, 0) is left of the only cell, and left of the diagonal's line, so it
    // is read against the lower-left triangle and carries that triangle's
    // stretch outwards: x' = 1.2x, y' = 0.4x + y.
    expect(affineWarpPoint(BR, 1, 1, W, H, -50, 0)[0]).toBeCloseTo(-60, 10);
    expect(affineWarpPoint(BR, 1, 1, W, H, -50, 0)[1]).toBeCloseTo(-20, 10);
  });

  it('resolves a point outside the grid continuously with the inside', () => {
    // A step across the box's edge is a step, not a jump.
    const inside = warpPoint(BR, 1, 1, W, H, 1e-6, 60);
    const outside = warpPoint(BR, 1, 1, W, H, -1e-6, 60);
    expect(outside[0]).toBeCloseTo(inside[0], 4);
    expect(outside[1]).toBeCloseTo(inside[1], 4);
    // And a point past the bottom-right stays a number.
    const [bx, by] = warpPoint(BR, 1, 1, W, H, 200, 100);
    expect(Number.isFinite(bx)).toBe(true);
    expect(Number.isFinite(by)).toBe(true);
  });

  it('hands back a box with no area, or a point that is not a number, unchanged', () => {
    expect(warpPoint(BR, 1, 1, 0, 0, 5, 6)).toEqual([5, 6]);
    expect(warpPoint(BR, 1, 1, W, H, NaN, 6)[0]).toBeNaN();
  });
});

describe('unwarpPoint', () => {
  // warpPoint(unwarpPoint(p)) is p again, to well under a pixel.
  const roundTrip = (pts, c, r, w, h, targets) => {
    for (const [x, y] of targets) {
      const [ux, uy] = unwarpPoint(pts, c, r, w, h, x, y);
      const [bx, by] = warpPoint(pts, c, r, w, h, ux, uy);
      expect(bx).toBeCloseTo(x, 4);
      expect(by).toBeCloseTo(y, 4);
    }
  };

  it('moves nothing through an identity mesh or no mesh', () => {
    expect(unwarpPoint(identityMesh(2, 2, W, H), 2, 2, W, H, 17, 43)).toEqual([17, 43]);
    expect(unwarpPoint([], 1, 1, W, H, 17, 43)).toEqual([17, 43]);
  });

  it('undoes a four-handle perspective, inside the box and past it', () => {
    roundTrip(BR, 1, 1, W, H, [[50, 50], [110, 120], [5, 95], [-80, -60], [300, 250]]);
    const [x, y] = unwarpPoint(BR, 1, 1, W, H, 120, 140);
    expect(x).toBeCloseTo(100, 4);
    expect(y).toBeCloseTo(100, 4);
  });

  it('undoes a one-cell parallelogram (the affine map)', () => {
    const shear = [[0, 0], [100, 0], [30, 100], [130, 100]];
    roundTrip(shear, 1, 1, W, H, [[65, 50], [0, 0], [200, -40]]);
  });

  it('undoes the bicubic surface of a bent grid', () => {
    const bent = identityMesh(3, 3, W, H).map((p, k) => (k === 5 ? [45, 50] : p));
    roundTrip(bent, 3, 3, W, H, [[45, 50], [40, 40], [60, 70], [10, 90], [-150, 20], [140, 400]]);
  });

  // A real box's mesh (a short wide balloon line, 2x2, gently skewed), with
  // the pointer across it and out to the far edge of the mask tool's reach.
  it('undoes a real, gently bent 2x2 on a wide, short box', () => {
    const w = 169.79796330845772;
    const h = 40.379990494296585;
    const pts = [
      [0.0594106463878461, -6.55002376425864], [85.02894244320231, -6.137862404943007], [176.53364534267826, -6.501752614068437],
      [0, 20.189995247148293], [84.89898165422886, 20.189995247148293], [169.79796330845772, 20.189995247148293],
      [-3.5980572718631834, 46.339620960076054], [83.92241915422886, 45.726948669201484], [178.24912775712698, 44.234256178707206],
    ];
    roundTrip(pts, 2, 2, w, h, [[20, 10], [85, 20], [160, 40], [-300, -300], [470, 340]]);
  });
});

describe('resampleMesh', () => {
  // 1x1 -> 2x2 over the worked example. Corners are kept, and every new point
  // is where the perspective puts the identity point - so the handles the user
  // gains sit ON the picture they were already looking at.
  it('keeps the deformed shape when the grid gets finer', () => {
    const out = resampleMesh(BR, 1, 1, 2, 2, W, H);
    expect(out).toHaveLength(9);
    expect(out[0]).toEqual([0, 0]);
    expect(out[8]).toEqual([120, 140]);
    identityMesh(2, 2, W, H).forEach(([x, y], k) => {
      const want = warpPoint(BR, 1, 1, W, H, x, y);
      expect(out[k][0], `x of point ${k}`).toBeCloseTo(want[0], 10);
      expect(out[k][1], `y of point ${k}`).toBeCloseTo(want[1], 10);
    });
  });

  it('leaves an identity mesh identical at any grid size', () => {
    const out = resampleMesh(identityMesh(1, 1, W, H), 1, 1, 3, 3, W, H);
    identityMesh(3, 3, W, H).forEach(([x, y], k) => {
      expect(out[k][0]).toBeCloseTo(x, 10);
      expect(out[k][1]).toBeCloseTo(y, 10);
    });
  });

  it('keeps only the corners when the grid gets coarser, and says so', () => {
    const fine = resampleMesh(BR, 1, 1, 2, 2, W, H);
    // Push one interior handle somewhere the corners cannot describe.
    fine[4] = [10, 90];
    const coarse = resampleMesh(fine, 2, 2, 1, 1, W, H);
    expect(coarse).toHaveLength(4);
    coarse.forEach(([x, y], k) => {
      expect(x).toBeCloseTo(BR[k][0], 10);
      expect(y).toBeCloseTo(BR[k][1], 10);
    });
    // The interior drag is gone - that is the documented, one-way cost of
    // coarsening, not a rounding error.
    const back = resampleMesh(coarse, 1, 1, 2, 2, W, H);
    expect(back[4][0]).not.toBeCloseTo(10, 1);
  });

  it('resamples a mesh whose points do not match its grid as identity', () => {
    const out = resampleMesh([[0, 0]], 1, 1, 2, 2, W, H);
    expect(out).toEqual(identityMesh(2, 2, W, H));
  });
});

describe('meshBounds', () => {
  it('bounds the deformed mesh, which can reach outside the box', () => {
    expect(meshBounds(BR)).toEqual({ minX: 0, minY: 0, maxX: 120, maxY: 140 });
  });

  it('bounds a mesh dragged out to the left and up as well', () => {
    expect(meshBounds([[-20, -5], [100, 0], [0, 100], [100, 100]])).toEqual({
      minX: -20,
      minY: -5,
      maxX: 100,
      maxY: 100,
    });
  });

  it('is null when there is nothing to bound, and skips unreadable points', () => {
    expect(meshBounds([])).toBeNull();
    expect(meshBounds(null)).toBeNull();
    expect(meshBounds([[NaN, 1], ['x', 'y']])).toBeNull();
    expect(meshBounds([[NaN, 1], [3, 4]])).toEqual({ minX: 3, minY: 4, maxX: 3, maxY: 4 });
  });
});

describe('the warp style block', () => {
  it('defaults to off, the 3x3 mesh, and no points', () => {
    expect(defaultStyle().warp).toEqual({ on: false, cols: 3, rows: 3, pts: [] });
    expect(normalizeStyle({}).warp).toEqual({ on: false, cols: 3, rows: 3, pts: [] });
  });

  it('keeps a well-formed mesh as written', () => {
    const w = normalizeWarp({ on: true, cols: 1, rows: 1, pts: BR });
    expect(w).toEqual({ on: true, cols: 1, rows: 1, pts: BR });
    // Copied out, not aliased: the sanitiser's job is to hand back a fresh
    // document, the way normalizeFit does.
    expect(w.pts).not.toBe(BR);
    expect(w.pts[0]).not.toBe(BR[0]);
  });

  it('clamps the grid to 1..24, rounds it to whole cells, and defaults an unreadable one', () => {
    expect(normalizeWarp({ cols: 0, rows: -3 })).toMatchObject({ cols: 1, rows: 1 });
    expect(normalizeWarp({ cols: 99, rows: 8.4 })).toMatchObject({ cols: 24, rows: 8 });
    expect(normalizeWarp({ cols: 2.6, rows: 'nope' })).toMatchObject({ cols: 3, rows: 3 });
  });

  it('resets a mesh of the wrong length to identity rather than repairing it', () => {
    // A 2x2 grid wants nine points; three is a torn mesh, not a coarse one.
    expect(normalizeWarp({ on: true, cols: 2, rows: 2, pts: BR }).pts).toEqual([]);
    expect(normalizeWarp({ cols: 1, rows: 1, pts: [[0, 0], [1, 1]] }).pts).toEqual([]);
    expect(normalizeWarp({ cols: 1, rows: 1, pts: 'nope' }).pts).toEqual([]);
  });

  it('drops the WHOLE mesh when one point is unreadable', () => {
    const torn = [[0, 0], [100, 0], [0, 100], [NaN, 140]];
    expect(normalizeWarp({ cols: 1, rows: 1, pts: torn }).pts).toEqual([]);
    expect(normalizeWarp({ cols: 1, rows: 1, pts: [[0, 0], [100, 0], [0, 100], 'x'] }).pts).toEqual([]);
  });

  it('keeps `on` as given even when the mesh was lost', () => {
    expect(normalizeWarp({ on: true, cols: 1, rows: 1, pts: [[0, 0]] })).toEqual({
      on: true, cols: 1, rows: 1, pts: [],
    });
    expect(normalizeWarp({ on: 'yes' }).on).toBe(false);
    expect(normalizeWarp(undefined).on).toBe(false);
  });

  it('round-trips: normalising a normalised warp changes nothing', () => {
    for (const src of [
      undefined,
      { on: true, cols: 3, rows: 2, pts: identityMesh(3, 2, W, H) },
      { on: true, cols: 99, rows: 0, pts: BR },
      { on: false, cols: 1, rows: 1, pts: [[NaN, 0], [1, 1], [2, 2], [3, 3]] },
    ]) {
      const once = normalizeWarp(src);
      expect(normalizeWarp(once)).toEqual(once);
    }
  });

  it('round-trips a whole style through normalizeStyle', () => {
    const once = normalizeStyle({ warp: { on: true, cols: 2, rows: 1, pts: identityMesh(2, 1, W, H) } });
    expect(once.warp.pts).toHaveLength(6);
    expect(normalizeStyle(once)).toEqual(once);
  });

  it('is what the engine calls identity when the mesh is untouched', () => {
    const w = normalizeWarp({ on: true, cols: 2, rows: 2 });
    expect(isIdentityMesh(w.pts, w.cols, w.rows, W, H)).toBe(true);
  });
});

// ===========================================================================
// The projective map
// ===========================================================================
// The four-handle case is not two triangles: they meet along the diagonal at an
// angle and the box creases. These are the numbers the painter subdivides
// through instead. The worked example is a homography chosen so every expected
// value can be read straight off it - `g = 0.5` and nothing else - and the quad
// it produces is then handed back to the solver to recover.

// The unit square in polygon order, which is the order both solver arguments
// are given in.
const UNIT = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
// That square through h = [1,0,0, 0,1,0, 0.5,0,1]: x' = x / (1 + x/2),
// y' = y / (1 + x/2). A trapezoid, right edge pulled in to 2/3.
const TRAP = [
  [0, 0],
  [2 / 3, 0],
  [2 / 3, 2 / 3],
  [0, 1],
];

const near = (a, b, digits = 10) => {
  expect(a).toHaveLength(b.length);
  b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, digits));
};

describe('solveHomography', () => {
  it('recovers the map that made a hand-computed trapezoid', () => {
    near(solveHomography(UNIT, TRAP), [1, 0, 0, 0, 1, 0, 0.5, 0, 1]);
  });

  it('carries each corner exactly where it was asked to', () => {
    const h = solveHomography(UNIT, TRAP);
    UNIT.forEach((p, i) => near(applyHomography(h, p[0], p[1]), TRAP[i]));
  });

  it('degenerates to the affine map when the quad is a parallelogram', () => {
    // A pure shear: no perspective in it, so the two projective terms are zero
    // and what is left is the affine map's six numbers.
    const shear = [
      [0, 0],
      [2, 0],
      [3, 1],
      [1, 1],
    ];
    const h = solveHomography(UNIT, shear);
    near(h, [2, 1, 0, 0, 1, 0, 0, 0, 1]);
    // And it agrees with the affine solve on a point neither was fitted at.
    const m = affineFromTriangle([UNIT[0], UNIT[1], UNIT[2]], [shear[0], shear[1], shear[2]]);
    const [x, y] = applyHomography(h, 0.25, 0.75);
    expect(x).toBeCloseTo(m[0] * 0.25 + m[2] * 0.75 + m[4], 10);
    expect(y).toBeCloseTo(m[1] * 0.25 + m[3] * 0.75 + m[5], 10);
  });

  it('is not the affine answer in the middle of a perspective quad', () => {
    // The whole reason this exists: at the centre of the unit square the
    // projective map says (0.4, 0.4) - 1/2 over the denominator 1 + 1/4 - while
    // reading the quad's corners linearly says (1/3, 5/12). That gap is the
    // crease the painter would otherwise draw.
    const h = solveHomography(UNIT, TRAP);
    near(applyHomography(h, 0.5, 0.5), [0.4, 0.4]);
    const bilinear = TRAP.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    expect(bilinear[0]).toBeCloseTo(1 / 3, 10);
    expect(bilinear[1]).toBeCloseTo(5 / 12, 10);
  });

  it('is null for a quad that is not one: collinear, crossed, or collapsed', () => {
    expect(solveHomography(UNIT, [[0, 0], [1, 0], [2, 0], [0, 1]])).toBeNull(); // three in a line
    expect(solveHomography(UNIT, [[0, 0], [1, 0], [0, 1], [1, 1]])).toBeNull(); // bowtie
    expect(solveHomography(UNIT, [[0, 0], [0, 0], [0, 0], [0, 0]])).toBeNull(); // no area
    expect(solveHomography([[0, 0], [1, 0], [1, 0], [0, 1]], UNIT)).toBeNull(); // degenerate source
    expect(solveHomography(UNIT, [[0, 0], [1, 0], [1, 1], [NaN, 1]])).toBeNull();
    expect(solveHomography(UNIT, [[0, 0], [1, 0], [1, 1]])).toBeNull(); // not four points
  });

  it('works in page px, not only on the unit square', () => {
    // The box the rest of this file uses, its bottom-right corner dragged out.
    const src = [[0, 0], [W, 0], [W, H], [0, H]];
    const dst = [[0, 0], [100, 0], [120, 140], [0, 100]];
    const h = solveHomography(src, dst);
    src.forEach((p, i) => near(applyHomography(h, p[0], p[1]), dst[i], 8));
  });
});

describe('applyHomography', () => {
  it('is the identity for a map it cannot read', () => {
    expect(applyHomography(null, 3, 4)).toEqual([3, 4]);
    expect(applyHomography([1, 2, 3], 3, 4)).toEqual([3, 4]);
  });

  it('says NaN on the horizon rather than a number that is not there', () => {
    // The line 1 + 0.5x = 0 has no image at all: x = -2.
    const h = solveHomography(UNIT, TRAP);
    const [x, y] = applyHomography(h, -2, 0.5);
    expect(Number.isNaN(x)).toBe(true);
    expect(Number.isNaN(y)).toBe(true);
  });
});

describe('isParallelogram', () => {
  it('is true for the identity mesh and for anything affine done to it', () => {
    // Polygon order, which is what this takes: the identity mesh is row-major,
    // so its last two points swap places on the way in.
    const id = identityMesh(1, 1, W, H);
    expect(isParallelogram([id[0], id[1], id[3], id[2]])).toBe(true);
    expect(isParallelogram([[0, 0], [2, 0], [3, 1], [1, 1]])).toBe(true);
    expect(isParallelogram([[10, 10], [10, 30], [-10, 30], [-10, 10]])).toBe(true);
  });

  it('is false the moment one corner leaves the parallelogram', () => {
    expect(isParallelogram([[0, 0], [100, 0], [120, 140], [0, 100]])).toBe(false);
    // And the tolerance is relative: a tenth of a pixel on a 100px box counts.
    expect(isParallelogram([[0, 0], [100, 0], [100.1, 100], [0, 100]])).toBe(false);
  });

  it('reads a mesh it cannot understand as one, so the caller skips the solve', () => {
    expect(isParallelogram(null)).toBe(true);
    expect(isParallelogram([[0, 0], [1, 0], [NaN, 1]])).toBe(true);
  });
});

describe('the bicubic surface a grid draws through', () => {
  const id = identityMesh(3, 3, W, H);
  // One interior handle pulled down and right.
  const bent = id.map((p, k) => (k === 5 ? [45, 50] : p));

  it('is the map for any grid, and none at all for an untouched one', () => {
    expect(meshMap(bent, 3, 3, W, H).kind).toBe('smooth');
    expect(meshMap(id, 3, 3, W, H)).toBeNull();
    expect(meshMap(bent, 3, 3, 0, 0)).toBeNull();
  });

  it('passes through every control point exactly', () => {
    id.forEach(([x, y], k) => {
      expect(warpPoint(bent, 3, 3, W, H, x, y)).toEqual(bent[k]);
    });
  });

  it('reproduces an affine deformation exactly, so a sheared grid stays flat', () => {
    const aff = id.map(([x, y]) => [1.5 * x + 0.3 * y + 10, 0.2 * x + 0.8 * y - 5]);
    for (const [x, y] of [[13, 27], [50, 50], [99, 1], [33.3, 66.6], [-20, 50], [120, 130]]) {
      const [px, py] = warpPoint(aff, 3, 3, W, H, x, y);
      expect(px).toBeCloseTo(1.5 * x + 0.3 * y + 10, 9);
      expect(py).toBeCloseTo(0.2 * x + 0.8 * y - 5, 9);
    }
  });

  it('has no fold at a cell edge: the slope is the same on both sides of it', () => {
    const d = 1e-4;
    const edge = W / 3;
    const f = (x) => warpPoint(bent, 3, 3, W, H, x, 20);
    const left = (f(edge)[0] - f(edge - d)[0]) / d;
    const right = (f(edge + d)[0] - f(edge)[0]) / d;
    expect(left).toBeCloseTo(right, 2);
    // Whereas the plain triangle reading of the same mesh does fold there.
    const g = (x) => affineWarpPoint(bent, 3, 3, W, H, x, 20);
    const aLeft = (g(edge)[0] - g(edge - d)[0]) / d;
    const aRight = (g(edge + d)[0] - g(edge)[0]) / d;
    expect(Math.abs(aLeft - aRight)).toBeGreaterThan(0.05);
  });

  it('bends between the dots rather than cutting straight across the cell', () => {
    // The middle of the top-left cell sits between a moved node and three
    // unmoved ones; the surface curves towards the moved one.
    const [x, y] = warpPoint(bent, 3, 3, W, H, W / 6, H / 6);
    expect(x).toBeGreaterThan(W / 6);
    expect(y).toBeGreaterThan(H / 6);
    // But not as far as the bilinear average of the four corners would say -
    // the cubic is pulled back by the unmoved nodes past them.
    expect(x).toBeLessThan((W / 6 + 45 / 2) / 1);
  });

  it('continues straight past the edge of the grid, along the surface’s own tangent', () => {
    const g = (x) => warpPoint(bent, 3, 3, W, H, x, 50)[0];
    const far = (g(-10) - g(-20)) / 10;
    const near = (g(-1e-3) - g(-2e-3)) / 1e-3;
    const inside = (g(1e-3) - g(0)) / 1e-3;
    expect(far).toBeCloseTo(near, 6);
    expect(near).toBeCloseTo(inside, 3);
    // And never NaN, however far out.
    expect(Number.isFinite(warpPoint(bent, 3, 3, W, H, -5000, 9000)[0])).toBe(true);
  });

  it('carries a drag onto a finer grid and back to a coarser one', () => {
    const fine = resampleMesh(bent, 3, 3, 6, 6, W, H);
    expect(fine).toHaveLength(49);
    // Every old node is still exactly where it was.
    expect(fine[2 * 7 + 2]).toEqual([45, 50]);
    // A 1x1 keeps only the corners, and they never moved.
    expect(resampleMesh(bent, 3, 3, 1, 1, W, H)).toEqual(identityMesh(1, 1, W, H));
  });
});

describe('warpActive', () => {
  const style = (warp) => ({ warp });

  it('is false when the block is off, however the mesh was dragged', () => {
    expect(warpActive(style({ on: false, cols: 1, rows: 1, pts: BR }), W, H)).toBe(false);
    expect(warpActive({}, W, H)).toBe(false);
    expect(warpActive(null)).toBe(false);
  });

  it('is false for a mesh that changes nothing', () => {
    const pts = identityMesh(2, 2, W, H);
    expect(warpActive(style({ on: true, cols: 2, rows: 2, pts }), W, H)).toBe(false);
    // No points at all is the stored default, and the same answer.
    expect(warpActive(style({ on: true, cols: 1, rows: 1, pts: [] }), W, H)).toBe(false);
  });

  it('is true once a handle has moved', () => {
    expect(warpActive(style({ on: true, cols: 1, rows: 1, pts: BR }), W, H)).toBe(true);
  });

  it('counts a stated mesh as active when it is asked without the box', () => {
    // What psd.js does: it has the style and not the box, and would rather ship
    // pixels than a type layer Photoshop re-renders unwarped.
    expect(warpActive(style({ on: true, cols: 1, rows: 1, pts: identityMesh(1, 1, W, H) }))).toBe(true);
    expect(warpActive(style({ on: true, cols: 1, rows: 1, pts: [] }))).toBe(false);
    // A mesh the sanitiser would have thrown away is not a mesh.
    expect(warpActive(style({ on: true, cols: 2, rows: 2, pts: BR }))).toBe(false);
  });
});
