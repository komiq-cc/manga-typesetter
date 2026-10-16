//! Bending outlines: the box's mesh warp and a letter's drip, as maps of job
//! space applied to the polylines themselves.
//!
//! The mesh maths is `src/lib/warp.js`, function for function, so that the
//! gizmo's handles (which that file places) and the letters this file bends
//! agree about where a point goes:
//!
//! ```text
//! one cell, corners not a parallelogram   the homography onto the four corners
//! one cell otherwise                      the cell's two triangles, each affine
//! a grid                                  the Catmull-Rom surface through the nodes
//! ```
//!
//! A map that is not affine does not take a straight edge to a straight
//! edge, so an outline is cut finer before it is carried through one
//! ([`bend`]): every edge is first split to pieces no longer than a length
//! the map names (half a mesh cell), and a piece is then cut in three for as
//! long as the map carries a point of it further than the tolerance from the
//! chord. The outline bends, and the pixels are made from the bent outline:
//! nothing is resampled, so the letters are as sharp bent as straight.

use super::budget;
use super::geom::{Affine, Polys, Pt};
use crate::Error;

/// Most cells a mesh may have along one side. The app stops at 24
/// (`WARP_MAX_GRID`, `src/lib/data.js`); this is a guard, not a design limit.
pub const MAX_MESH_SIDE: u32 = 64;

/// A mesh point within this of its place on the undeformed grid has not been
/// moved (`isIdentityMesh`): a hundredth of a job unit.
const IDENTITY_EPS: f64 = 0.01;

/// Most pieces one edge is split into before it is refined. A guard.
const MAX_PIECES: f64 = 4096.0;

/// How many times a piece may be cut in three: 3^6 pieces at most.
const MAX_DEPTH: u32 = 6;

/// A coordinate past this after bending is a map gone to its horizon, and
/// the job is refused. The rasteriser's own limit is the same number.
const MAX_COORD: f64 = 1e9;

/// A box's mesh: `(cols + 1) * (rows + 1)` control points, row by row from
/// the top left, each relative to the corner of the rectangle the mesh is
/// defined on. The undeformed mesh is the grid laid over that rectangle.
#[derive(Clone, Debug, PartialEq)]
pub struct Mesh {
    pub cols: u32,
    pub rows: u32,
    /// Where each node of the grid goes, relative to `(x, y)`.
    pub pts: Vec<Pt>,
    /// The rectangle's corner in job space, and its size.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Mesh {
    fn node_count(&self) -> Option<usize> {
        (self.cols as usize + 1).checked_mul(self.rows as usize + 1)
    }

    /// The undeformed place of node `(i, j)`. Written `(w * i) / cols`, as
    /// the JS writes it, so the last column is exactly `w`.
    fn grid(&self, i: usize, j: usize) -> Pt {
        Pt::new(
            (self.w * i as f64) / f64::from(self.cols),
            (self.h * j as f64) / f64::from(self.rows),
        )
    }

    fn idx(&self, i: usize, j: usize) -> usize {
        j * (self.cols as usize + 1) + i
    }

    /// Whether the mesh can be read at all: a size, a grid within the
    /// guard, and a point for every node.
    fn sound(&self) -> bool {
        self.w > 0.0
            && self.h > 0.0
            && (1..=MAX_MESH_SIDE).contains(&self.cols)
            && (1..=MAX_MESH_SIDE).contains(&self.rows)
            && self.node_count() == Some(self.pts.len())
            && [self.x, self.y, self.w, self.h]
                .iter()
                .all(|v| v.is_finite())
            && self.pts.iter().all(|p| p.x.is_finite() && p.y.is_finite())
    }

    fn is_identity(&self) -> bool {
        let cols = self.cols as usize;
        self.pts.iter().enumerate().all(|(k, p)| {
            let g = self.grid(k % (cols + 1), k / (cols + 1));
            (p.x - g.x).abs() <= IDENTITY_EPS && (p.y - g.y).abs() <= IDENTITY_EPS
        })
    }

    /// The map this mesh is (`meshMap`), or `None` when it moves nothing or
    /// cannot be read, which paints the job as if it had no mesh. `BadSpec`
    /// when the painter's budget has no room for the grid's lattice.
    pub(crate) fn map(&self) -> Result<Option<MeshMap<'_>>, Error> {
        if !self.sound() || self.is_identity() {
            return Ok(None);
        }
        let kind = if self.cols == 1 && self.rows == 1 {
            // Row-major tl, tr, bl, br to polygon order.
            let quad = [self.pts[0], self.pts[1], self.pts[3], self.pts[2]];
            let src = [
                self.grid(0, 0),
                self.grid(1, 0),
                self.grid(1, 1),
                self.grid(0, 1),
            ];
            let exact = is_parallelogram(&quad);
            match (exact, solve_homography(&src, &quad)) {
                (false, Some(h)) => Kind::Projective(h),
                _ => Kind::Affine { exact },
            }
        } else {
            Kind::Smooth(Lattice::new(self)?)
        };
        Ok(Some(MeshMap { mesh: self, kind }))
    }
}

enum Kind {
    Projective([f64; 9]),
    /// The cell's two triangles; `exact` when they are one affine map (a
    /// parallelogram) and there is no crease between them.
    Affine {
        exact: bool,
    },
    Smooth(Lattice),
}

/// How an outline is cut before a map is handed it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Cut {
    /// No piece is carried through the map longer than this: the scale under
    /// which the map is one smooth piece.
    pub max_len: f64,
    /// A piece no longer than this stays within the tolerance of its chord
    /// whatever the map does to it, and is not looked into: a chord of
    /// length `l` leaves a curve whose second derivative is at most `k` by at
    /// most `k l^2 / 8`.
    pub flat_len: f64,
}

impl Cut {
    pub(crate) fn of(max_len: f64, curve: f64, tol: f64) -> Self {
        // No curvature is a straight map, and a bound that is not a number
        // is no bound: every piece is looked into.
        let flat_len = if curve == 0.0 {
            f64::INFINITY
        } else if curve.is_finite() {
            (8.0 * tol / curve).sqrt()
        } else {
            0.0
        };
        Self { max_len, flat_len }
    }

    /// For one map after another: the finer cut of the two, and no piece
    /// taken on trust.
    pub(crate) fn both(self, o: Cut) -> Self {
        Self {
            max_len: self.max_len.min(o.max_len),
            flat_len: 0.0,
        }
    }
}

/// A mesh that moves something, and which of the three maps it is.
pub(crate) struct MeshMap<'a> {
    mesh: &'a Mesh,
    kind: Kind,
}

impl MeshMap<'_> {
    /// Where the job-space point `p` goes.
    pub(crate) fn at(&self, p: Pt) -> Pt {
        let m = self.mesh;
        let (x, y) = (p.x - m.x, p.y - m.y);
        let q = match &self.kind {
            Kind::Projective(h) => apply_homography(h, x, y),
            Kind::Affine { .. } => affine_point(m, x, y),
            Kind::Smooth(lattice) => lattice.at(m, x, y),
        };
        Pt::new(q.x + m.x, q.y + m.y)
    }

    /// How an outline inside `bounds` (job space, `x0, y0, x1, y1`) is cut
    /// for this map, to stay within `tol` of the bent outline.
    pub(crate) fn cut(&self, bounds: (f64, f64, f64, f64), tol: f64) -> Cut {
        let m = self.mesh;
        match &self.kind {
            // One affine map: a straight edge stays one.
            Kind::Affine { exact: true } => Cut::of(f64::INFINITY, 0.0, tol),
            // Two, with a crease where they meet: found by looking.
            Kind::Affine { exact: false } => Cut::of(m.w.max(m.h), f64::INFINITY, tol),
            Kind::Projective(h) => {
                let (x0, y0, x1, y1) = bounds;
                Cut::of(
                    m.w.max(m.h),
                    homography_curve(h, (x0 - m.x, y0 - m.y, x1 - m.x, y1 - m.y)),
                    tol,
                )
            }
            // Half a cell, where the surface is one cubic each way.
            Kind::Smooth(lattice) => Cut::of(
                (m.w / f64::from(m.cols)).min(m.h / f64::from(m.rows)) / 2.0,
                lattice.curve,
                tol,
            ),
        }
    }

    /// The most the map lengthens a short piece of outline by: the largest
    /// stretch of its slope over the mesh's rectangle, read at every node,
    /// in the middle of every cell and of every cell's side, across a
    /// sixteenth of a cell. Exact for one affine map and for each of a
    /// cell's two triangles. An outline is flattened before it is bent, and a
    /// chord that was within the tolerance of its curve is this much further
    /// from it once the map has carried both (`paint_job_with`).
    pub(crate) fn stretch(&self) -> f64 {
        let m = self.mesh;
        let (cw, ch) = (m.w / f64::from(m.cols), m.h / f64::from(m.rows));
        let (hx, hy) = (cw / 16.0, ch / 16.0);
        let mut most = 0.0f64;
        for j in 0..=2 * m.rows {
            for i in 0..=2 * m.cols {
                let p = Pt::new(m.x + cw * f64::from(i) / 2.0, m.y + ch * f64::from(j) / 2.0);
                let across = |d: Pt, half: f64| {
                    self.at(p.plus(d))
                        .minus(self.at(p.minus(d)))
                        .scale(0.5 / half)
                };
                let dx = across(Pt::new(hx, 0.0), hx);
                let dy = across(Pt::new(0.0, hy), hy);
                let s = Affine([dx.x, dx.y, dy.x, dy.y, 0.0, 0.0]).max_scale();
                // Written so that a NaN is no stretch.
                if s > most {
                    most = s;
                }
            }
        }
        most
    }

    /// The affine map nearest this one over the rectangle `x0, y0, x1, y1`
    /// (job space): it takes the rectangle's middle where the mesh takes it,
    /// and its slope is the mesh's across the whole rectangle, from one side's
    /// middle to the other's. That is what the mesh does to a thing the size
    /// of a letter; the slope at one point would follow every dent of a fine
    /// mesh. The identity moved to where the middle goes when there is no
    /// slope to read (a fold, a horizon).
    pub(crate) fn tangent_over(&self, (x0, y0, x1, y1): (f64, f64, f64, f64)) -> Affine {
        let p = Pt::new((x0 + x1) / 2.0, (y0 + y1) / 2.0);
        let least = self.mesh.w.min(self.mesh.h).min(1.0) * 1e-3;
        let (hx, hy) = (((x1 - x0) / 2.0).max(least), ((y1 - y0) / 2.0).max(least));
        let o = self.at(p);
        let across = |d: Pt, half: f64| {
            self.at(p.plus(d))
                .minus(self.at(p.minus(d)))
                .scale(0.5 / half)
        };
        let dx = across(Pt::new(hx, 0.0), hx);
        let dy = across(Pt::new(0.0, hy), hy);
        let m = Affine([
            dx.x,
            dx.y,
            dy.x,
            dy.y,
            o.x - (dx.x * p.x + dy.x * p.y),
            o.y - (dx.y * p.x + dy.y * p.y),
        ]);
        if m.invert().is_some() {
            m
        } else if o.x.is_finite() && o.y.is_finite() {
            Affine::translate(o.x - p.x, o.y - p.y)
        } else {
            Affine::IDENTITY
        }
    }
}

/// The lower part of one letter pulled down: a point at height `y` goes to
/// `y + pull * smoothstep(mid, bottom, y)`. Above `mid` nothing moves, so the
/// letter's top stays level; below `bottom` everything moves by `pull`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Drip {
    pub mid: f64,
    pub bottom: f64,
    pub pull: f64,
}

impl Drip {
    pub(crate) fn at(&self, p: Pt) -> Pt {
        let t = ((p.y - self.mid) / (self.bottom - self.mid)).clamp(0.0, 1.0);
        Pt::new(p.x, p.y + self.pull * t * t * (3.0 - 2.0 * t))
    }

    /// Half the stretch the pull is spread over, and the curve of a
    /// smoothstep: its second derivative is at most `6 / range^2`.
    pub(crate) fn cut(&self, tol: f64) -> Cut {
        let range = self.bottom - self.mid;
        Cut::of(range / 2.0, 6.0 * self.pull.abs() / (range * range), tol)
    }
}

/// `polys` carried through `map`, cut finer first (`cut`) so that the result
/// is within `tol` of the true bent outline.
///
/// `BadSpec` when the map sends a point nowhere (a homography's horizon) or
/// further than any surface reaches.
pub(crate) fn bend(
    polys: &Polys,
    map: impl Fn(Pt) -> Pt,
    cut: Cut,
    tol: f64,
) -> Result<Polys, Error> {
    let mut out = Polys::default();
    budget::reserve(&mut out.pts, polys.pts.len())?;
    budget::reserve(&mut out.ends, polys.ends.len())?;
    let flat2 = cut.flat_len * cut.flat_len;
    for c in polys.contours() {
        let mut p = c[0];
        let mut mp = map(p);
        out.push(mp);
        for k in 1..=c.len() {
            // The contour's last edge runs back to its first point.
            let (a, b) = (p, c[k % c.len()]);
            let len = b.minus(a).len();
            // A NaN or a length that is not above zero is one piece.
            let n = (len / cut.max_len).ceil();
            let n = if n >= 1.0 {
                n.min(MAX_PIECES) as usize
            } else {
                1
            };
            for i in 1..=n {
                let q = if i == n {
                    b
                } else {
                    a.plus(b.minus(a).scale(i as f64 / n as f64))
                };
                let mq = map(q);
                refine(&mut out, &map, (p, mp), (q, mq), (tol, flat2), 0);
                // The first point is in already (`close` joins it).
                if i < n || k < c.len() {
                    out.push(mq);
                }
                (p, mp) = (q, mq);
            }
        }
        out.close();
        budget::check()?;
    }
    let sound = out
        .pts
        .iter()
        .all(|p| p.x.abs() < MAX_COORD && p.y.abs() < MAX_COORD);
    if sound {
        Ok(out)
    } else {
        Err(Error::BadSpec)
    }
}

/// Pushes the points strictly between the two ends of one piece: none when
/// the piece is short enough to be flat for certain (`flat2`, the square of
/// `Cut::flat_len`) or the map carries its thirds onto the chord's thirds
/// (within `tol`), else the thirds and what each third needs in its turn.
///
/// Two inner points and not the midpoint alone: along a line the surface is
/// a cubic, and a cubic can leave its chord on both sides and cross it at the
/// middle. One that is on the chord at both thirds and both ends is the chord.
fn refine(
    out: &mut Polys,
    map: &impl Fn(Pt) -> Pt,
    (p, mp): (Pt, Pt),
    (q, mq): (Pt, Pt),
    (tol, flat2): (f64, f64),
    depth: u32,
) {
    let d = q.minus(p);
    if d.dot(d) <= flat2 {
        return;
    }
    let (a, b) = (p.plus(d.scale(1.0 / 3.0)), p.plus(d.scale(2.0 / 3.0)));
    let (ma, mb) = (map(a), map(b));
    let md = mq.minus(mp);
    let off_a = ma.minus(mp.plus(md.scale(1.0 / 3.0))).len();
    let off_b = mb.minus(mp.plus(md.scale(2.0 / 3.0))).len();
    // Written so that a NaN is "on the chord": it is refused at the end, and
    // must not be chased to the bottom of the recursion first.
    let bent = off_a > tol || off_b > tol;
    if !bent || depth >= MAX_DEPTH {
        return;
    }
    refine(out, map, (p, mp), (a, ma), (tol, flat2), depth + 1);
    out.push(ma);
    refine(out, map, (a, ma), (b, mb), (tol, flat2), depth + 1);
    out.push(mb);
    refine(out, map, (b, mb), (q, mq), (tol, flat2), depth + 1);
}

// ---- one cell: the two triangles ----

/// The affine map taking triangle `s` onto triangle `d`, as the canvas
/// matrix `(a, b, c, d, e, f)`, or `None` for a triangle with no area.
fn affine_from_triangle(s: [Pt; 3], d: [Pt; 3]) -> Option<[f64; 6]> {
    let (u1, u2) = (s[1].minus(s[0]), s[2].minus(s[0]));
    let det = u1.cross(u2);
    if !det.is_finite() || det.abs() < 1e-12 {
        return None;
    }
    let (v1, v2) = (d[1].minus(d[0]), d[2].minus(d[0]));
    let a = (v1.x * u2.y - v2.x * u1.y) / det;
    let c = (v2.x * u1.x - v1.x * u2.x) / det;
    let b = (v1.y * u2.y - v2.y * u1.y) / det;
    let dd = (v2.y * u1.x - v1.y * u2.x) / det;
    let e = d[0].x - (a * s[0].x + c * s[0].y);
    let f = d[0].y - (b * s[0].x + dd * s[0].y);
    let m = [a, b, c, dd, e, f];
    m.iter().all(|v| v.is_finite()).then_some(m)
}

/// `affineWarpPoint`: the cell the point falls in (the nearest one for a
/// point outside the grid), the half of it the diagonal puts the point on,
/// and that triangle's affine map.
fn affine_point(m: &Mesh, x: f64, y: f64) -> Pt {
    let (c, r) = (m.cols as usize, m.rows as usize);
    let cell = |v: f64, n: usize, size: f64| {
        let k = ((v * n as f64) / size).floor();
        // A NaN is cell 0.
        if k >= 1.0 {
            (k as usize).min(n - 1)
        } else {
            0
        }
    };
    let (i, j) = (cell(x, c, m.w), cell(y, r, m.h));
    let (p0, p1) = (m.grid(i, j), m.grid(i + 1, j + 1));
    let u = (x - p0.x) / (p1.x - p0.x);
    let v = (y - p0.y) / (p1.y - p0.y);
    let (tl, br) = (m.idx(i, j), m.idx(i + 1, j + 1));
    let map = if v <= u {
        let tr = m.idx(i + 1, j);
        affine_from_triangle(
            [p0, m.grid(i + 1, j), p1],
            [m.pts[tl], m.pts[tr], m.pts[br]],
        )
    } else {
        let bl = m.idx(i, j + 1);
        affine_from_triangle(
            [p0, p1, m.grid(i, j + 1)],
            [m.pts[tl], m.pts[br], m.pts[bl]],
        )
    };
    match map {
        Some(a) => Pt::new(a[0] * x + a[2] * y + a[4], a[1] * x + a[3] * y + a[5]),
        None => Pt::new(x, y),
    }
}

// ---- one cell: the projective corner ----

/// Whether the affine map is already exact for this quad (polygon order).
/// The tolerance is relative to the quad's own size.
fn is_parallelogram(q: &[Pt; 4]) -> bool {
    let dx = q[0].x + q[2].x - q[1].x - q[3].x;
    let dy = q[0].y + q[2].y - q[1].y - q[3].y;
    let span = q.iter().fold(0.0f64, |s, p| {
        s.max((p.x - q[0].x).abs()).max((p.y - q[0].y).abs())
    });
    dx.hypot(dy) <= 1e-6 * span.max(1.0)
}

/// Four points in polygon order that turn the same way at every corner,
/// with no three of them in a line.
fn convex_quad(q: &[Pt; 4]) -> bool {
    let mut sign = 0.0;
    for i in 0..4 {
        let u = q[(i + 1) % 4].minus(q[i]);
        let v = q[(i + 2) % 4].minus(q[(i + 1) % 4]);
        let cross = u.cross(v);
        let scale = u.len() * v.len();
        // Written so that a NaN is "in a line".
        let turns = scale > 0.0 && cross.abs() > 1e-9 * scale;
        if !turns {
            return false;
        }
        let s = cross.signum();
        if sign == 0.0 {
            sign = s;
        } else if s != sign {
            return false;
        }
    }
    true
}

/// Gaussian elimination with partial pivoting over an 8 x 9 augmented
/// matrix. `None` when the system is singular.
fn solve_linear(mut rows: [[f64; 9]; 8]) -> Option<[f64; 8]> {
    const N: usize = 8;
    for col in 0..N {
        let mut best = col;
        for (r, row) in rows.iter().enumerate().skip(col + 1) {
            if row[col].abs() > rows[best][col].abs() {
                best = r;
            }
        }
        let piv = rows[best][col];
        if !piv.is_finite() || piv.abs() < 1e-12 {
            return None;
        }
        rows.swap(col, best);
        let pivot = rows[col];
        for (r, row) in rows.iter_mut().enumerate() {
            if r == col {
                continue;
            }
            let f = row[col] / piv;
            if f == 0.0 {
                continue;
            }
            for (v, p) in row.iter_mut().zip(&pivot).skip(col) {
                *v -= f * p;
            }
        }
    }
    let mut out = [0.0; N];
    for (i, v) in out.iter_mut().enumerate() {
        *v = rows[i][N] / rows[i][i];
        if !v.is_finite() {
            return None;
        }
    }
    Some(out)
}

/// The projective map taking `src`'s corners onto `dst`'s (both in polygon
/// order), as the nine coefficients of its matrix, the last one 1. `None`
/// when either quad is not convex or the system does not resolve.
fn solve_homography(src: &[Pt; 4], dst: &[Pt; 4]) -> Option<[f64; 9]> {
    if !convex_quad(src) || !convex_quad(dst) {
        return None;
    }
    let mut rows = [[0.0; 9]; 8];
    for (i, (s, d)) in src.iter().zip(dst).enumerate() {
        let (x, y) = (s.x, s.y);
        let (u, v) = (d.x, d.y);
        rows[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
        rows[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v];
    }
    let h = solve_linear(rows)?;
    Some([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1.0])
}

/// A point through a homography; NaN on the map's horizon, which [`bend`]
/// refuses.
fn apply_homography(h: &[f64; 9], x: f64, y: f64) -> Pt {
    let w = h[6] * x + h[7] * y + h[8];
    if !w.is_finite() || w.abs() < 1e-12 {
        return Pt::new(f64::NAN, f64::NAN);
    }
    Pt::new(
        (h[0] * x + h[1] * y + h[2]) / w,
        (h[3] * x + h[4] * y + h[5]) / w,
    )
}

/// An upper bound of the second derivative of the homography over the
/// rectangle `x0, y0, x1, y1` (the mesh's own coordinates), along any line:
/// what [`Cut`] needs. Infinite when the horizon may cross the rectangle.
///
/// Each coordinate is `f = n / w` with `n` and `w` linear, so its Hessian is
/// `-(dn dw' + dw dn') / w^2 + 2 n dw dw' / w^3`, of norm at most
/// `2 |dw| (|dn| + |f| |dw|) / w^2`. Over a rectangle clear of the horizon
/// `|w|` is least and `|f|` greatest at a corner.
fn homography_curve(h: &[f64; 9], (x0, y0, x1, y1): (f64, f64, f64, f64)) -> f64 {
    let corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
    let (mut w_min, mut fx, mut fy) = (f64::INFINITY, 0.0f64, 0.0f64);
    let mut sign = 0.0;
    for (x, y) in corners {
        let w = h[6] * x + h[7] * y + h[8];
        // Written so that a NaN is a horizon.
        let clear = w.abs() > 1e-12 && (sign == 0.0 || w.signum() == sign);
        if !clear {
            return f64::INFINITY;
        }
        sign = w.signum();
        w_min = w_min.min(w.abs());
        fx = fx.max(((h[0] * x + h[1] * y + h[2]) / w).abs());
        fy = fy.max(((h[3] * x + h[4] * y + h[5]) / w).abs());
    }
    let g = h[6].hypot(h[7]);
    let of = |n: f64, f: f64| 2.0 * g * (n + f * g) / (w_min * w_min);
    of(h[0].hypot(h[1]), fx) + of(h[3].hypot(h[4]), fy)
}

// ---- a grid: the Catmull-Rom surface ----

/// Control point `(i, j)`, or the lattice extended in a straight line for an
/// index one past its edge on either axis.
fn node_at(m: &Mesh, i: isize, j: isize) -> Pt {
    let (cols, rows) = (m.cols as isize, m.rows as isize);
    if i < 0 || i > cols {
        let (e, d) = if i < 0 { (0, 1) } else { (cols, -1) };
        let (a, b) = (node_at(m, e, j), node_at(m, e + d, j));
        return Pt::new(2.0 * a.x - b.x, 2.0 * a.y - b.y);
    }
    if j < 0 || j > rows {
        let (e, d) = if j < 0 { (0, 1) } else { (rows, -1) };
        let (a, b) = (node_at(m, i, e), node_at(m, i, e + d));
        return Pt::new(2.0 * a.x - b.x, 2.0 * a.y - b.y);
    }
    m.pts[m.idx(i as usize, j as usize)]
}

/// A coordinate in cell units, snapped to the node it is within
/// floating-point dust of, so that a node reads back its own point.
fn cell_units(v: f64, n: u32, size: f64) -> f64 {
    let s = (v * f64::from(n)) / size;
    let k = s.round();
    if (s - k).abs() < 1e-9 {
        k
    } else {
        s
    }
}

/// One axis of the surface at `s`, in cell units, on a row of `n` cells:
/// the first of the four nodes that count (as an index into a row of the
/// lattice, which starts one node before the grid) and the weight of each.
///
/// Inside the grid the weights are the Catmull-Rom blend. Outside it the
/// curve goes straight on along its tangent at the end node, which is half
/// the step between that node's two neighbours.
fn axis(s: f64, n: usize) -> (usize, [f64; 4]) {
    let floor = s.floor();
    if floor < 0.0 {
        (0, [-0.5 * s, 1.0, 0.5 * s, 0.0])
    } else if floor >= n as f64 {
        let ext = s - n as f64;
        (n - 1, [0.0, -0.5 * ext, 1.0, 0.5 * ext])
    } else {
        let t = s - floor;
        let t2 = t * t;
        let t3 = t2 * t;
        (
            floor as usize,
            [
                -0.5 * t3 + t2 - 0.5 * t,
                1.5 * t3 - 2.5 * t2 + 1.0,
                -1.5 * t3 + 2.0 * t2 + 0.5 * t,
                0.5 * t3 - 0.5 * t2,
            ],
        )
    }
}

/// A grid's control points with one more node on every side (`node_at`),
/// so that a point of the surface is sixteen nodes read in place, and how
/// sharply the surface can bend.
struct Lattice {
    /// `(cols + 3) * (rows + 3)` nodes, row by row; node `(i, j)` of the
    /// mesh is at `(i + 1, j + 1)`.
    nodes: Vec<Pt>,
    /// An upper bound of the surface's second derivative along any line,
    /// per job unit squared.
    curve: f64,
}

impl Lattice {
    fn new(m: &Mesh) -> Result<Self, Error> {
        let (cols, rows) = (m.cols as usize, m.rows as usize);
        let stride = cols + 3;
        let mut nodes = Vec::new();
        budget::reserve_raw(&mut nodes, stride * (rows + 3))?;
        for j in -1..=rows as isize + 1 {
            for i in -1..=cols as isize + 1 {
                nodes.push(node_at(m, i, j));
            }
        }
        // The largest second difference along a row, along a column, and
        // across a cell. A Catmull-Rom segment's second derivative is at most
        // three times the larger of its two second differences, and the
        // blend across the other axis weighs four of them by at most 1.25 in
        // all; the mixed derivative is at most 1.5 * 1.5 times the largest
        // mixed difference. Along a unit direction `(a, b)` the three add up
        // to `a^2 xx + 2ab xy + b^2 yy`, at most the larger of `xx` and `yy`
        // plus `xy`.
        let at = |i: usize, j: usize| nodes[j * stride + i];
        let (mut du, mut dv, mut mixed) = (0.0f64, 0.0f64, 0.0f64);
        for j in 0..rows + 3 {
            for i in 0..stride {
                if i + 2 < stride {
                    let d = at(i, j).minus(at(i + 1, j).scale(2.0)).plus(at(i + 2, j));
                    du = du.max(d.len());
                }
                if j + 2 < rows + 3 {
                    let d = at(i, j).minus(at(i, j + 1).scale(2.0)).plus(at(i, j + 2));
                    dv = dv.max(d.len());
                }
                if i + 1 < stride && j + 1 < rows + 3 {
                    let d = at(i + 1, j + 1)
                        .minus(at(i + 1, j))
                        .minus(at(i, j + 1))
                        .plus(at(i, j));
                    mixed = mixed.max(d.len());
                }
            }
        }
        let (ku, kv) = (f64::from(m.cols) / m.w, f64::from(m.rows) / m.h);
        let curve = (3.75 * du * ku * ku).max(3.75 * dv * kv * kv) + 2.25 * mixed * ku * kv;
        Ok(Self { nodes, curve })
    }

    /// Where `(x, y)` goes under the surface (`smoothPoint`): the spline
    /// along each of the four rows the point's cell borders, then the spline
    /// across those four answers.
    fn at(&self, m: &Mesh, x: f64, y: f64) -> Pt {
        let su = cell_units(x, m.cols, m.w);
        let sv = cell_units(y, m.rows, m.h);
        let (cols, rows) = (m.cols as usize, m.rows as usize);
        let on_node = su.fract() == 0.0
            && sv.fract() == 0.0
            && (0.0..=cols as f64).contains(&su)
            && (0.0..=rows as f64).contains(&sv);
        if on_node {
            return m.pts[m.idx(su as usize, sv as usize)];
        }
        let (i, wu) = axis(su, cols);
        let (j, wv) = axis(sv, rows);
        let stride = cols + 3;
        let mut out = Pt::default();
        for (b, wv) in wv.iter().enumerate() {
            let from = (j + b) * stride + i;
            let Some(row) = self.nodes.get(from..from + 4) else {
                // A NaN coordinate: no cell, no point.
                return Pt::new(f64::NAN, f64::NAN);
            };
            let rx = wu[0] * row[0].x + wu[1] * row[1].x + wu[2] * row[2].x + wu[3] * row[3].x;
            let ry = wu[0] * row[0].y + wu[1] * row[1].y + wu[2] * row[2].y + wu[3] * row[3].y;
            out = Pt::new(out.x + wv * rx, out.y + wv * ry);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mesh(cols: u32, rows: u32, w: f64, h: f64) -> Mesh {
        let mut m = Mesh {
            cols,
            rows,
            pts: Vec::new(),
            x: 0.0,
            y: 0.0,
            w,
            h,
        };
        for j in 0..=rows as usize {
            for i in 0..=cols as usize {
                m.pts.push(m.grid(i, j));
            }
        }
        m
    }

    fn near(a: Pt, b: Pt, eps: f64) -> bool {
        (a.x - b.x).abs() <= eps && (a.y - b.y).abs() <= eps
    }

    /// `tests/data/mesh_map.txt`, written by `parity/mesh-map.mjs` from
    /// `meshMap` in `src/lib/warp.js`: a mesh per `mesh` line and, under it,
    /// points and where the JS sends them.
    #[test]
    fn the_map_is_the_one_in_warp_js() {
        let text = include_str!("../../tests/data/mesh_map.txt");
        let mut current: Option<(Mesh, String)> = None;
        let (mut meshes, mut points) = (0, 0);
        for line in text.lines() {
            let mut f = line.split_whitespace();
            match f.next() {
                Some("mesh") => {
                    let kind = f.next().unwrap().to_owned();
                    let n: Vec<f64> = f.map(|v| v.parse().unwrap()).collect();
                    let pts = n[4..].chunks(2).map(|p| Pt::new(p[0], p[1])).collect();
                    let m = Mesh {
                        cols: n[0] as u32,
                        rows: n[1] as u32,
                        pts,
                        x: 0.0,
                        y: 0.0,
                        w: n[2],
                        h: n[3],
                    };
                    current = Some((m, kind));
                    meshes += 1;
                }
                Some("pt") => {
                    let n: Vec<f64> = f.map(|v| v.parse().unwrap()).collect();
                    let (m, kind) = current.as_ref().unwrap();
                    let map = m
                        .map()
                        .unwrap()
                        .expect("a mesh in the file moves something");
                    let is = match map.kind {
                        Kind::Projective(_) => "projective",
                        Kind::Affine { .. } => "affine",
                        Kind::Smooth(_) => "smooth",
                    };
                    assert_eq!(is, kind, "{line}");
                    let got = map.at(Pt::new(n[0], n[1]));
                    let want = Pt::new(n[2], n[3]);
                    // The same arithmetic in the same order: what differs is
                    // the last bits of a product the two compilers fused or
                    // did not.
                    let eps = 1e-9 * (1.0 + want.x.abs().max(want.y.abs()));
                    assert!(near(got, want, eps), "{kind} {line}: {got:?}");
                    points += 1;
                }
                _ => {}
            }
        }
        assert!(
            meshes >= 8 && points >= 400,
            "{meshes} meshes, {points} points"
        );
    }

    #[test]
    fn a_mesh_that_moves_nothing_is_no_map() {
        assert!(mesh(1, 1, 100.0, 50.0).map().unwrap().is_none());
        assert!(mesh(3, 2, 100.0, 50.0).map().unwrap().is_none());
        // Dust is not a drag.
        let mut m = mesh(3, 3, 90.0, 60.0);
        m.pts[5].x += 0.009;
        assert!(m.map().unwrap().is_none());
        m.pts[5].x += 0.01;
        assert!(m.map().unwrap().is_some());
        // Unreadable: a point short, no size, a grid past the guard.
        let mut m = mesh(2, 2, 90.0, 60.0);
        m.pts[4].y += 10.0;
        m.pts.pop();
        assert!(m.map().unwrap().is_none());
        let mut m = mesh(1, 1, 0.0, 60.0);
        m.pts[1].x = 30.0;
        assert!(m.map().unwrap().is_none());
        let mut m = mesh(1, 1, 10.0, 10.0);
        m.pts[3] = Pt::new(20.0, f64::NAN);
        assert!(m.map().unwrap().is_none());
        let mut m = mesh(1, 1, 10.0, 10.0);
        m.cols = MAX_MESH_SIDE + 1;
        assert!(m.map().unwrap().is_none());
    }

    #[test]
    fn a_node_reads_back_its_own_point_and_the_rect_moves_the_map() {
        let mut m = mesh(3, 2, 90.0, 60.0);
        m.pts[5] = Pt::new(41.5, 17.25);
        m.pts[11] = Pt::new(100.0, 70.0);
        let at = m.map().unwrap().unwrap().at(Pt::new(30.0, 30.0));
        assert_eq!(at, Pt::new(41.5, 17.25));
        // The same mesh on a rectangle elsewhere: the same picture, moved.
        let mut moved = m.clone();
        (moved.x, moved.y) = (7.0, -3.0);
        let map = moved.map().unwrap().unwrap();
        assert_eq!(map.at(Pt::new(37.0, 27.0)), Pt::new(48.5, 14.25));
        let (p, q) = (
            m.map().unwrap().unwrap().at(Pt::new(51.0, 44.0)),
            map.at(Pt::new(58.0, 41.0)),
        );
        assert!(near(Pt::new(p.x + 7.0, p.y - 3.0), q, 1e-9));
    }

    /// Pieces up to `max_len`, every one of them looked into.
    fn whole(max_len: f64) -> Cut {
        Cut {
            max_len,
            flat_len: 0.0,
        }
    }

    /// Every mesh of the fixture file.
    fn fixture_meshes() -> Vec<Mesh> {
        include_str!("../../tests/data/mesh_map.txt")
            .lines()
            .filter_map(|line| line.strip_prefix("mesh "))
            .map(|line| {
                let n: Vec<f64> = line
                    .split_whitespace()
                    .skip(1)
                    .map(|v| v.parse().unwrap())
                    .collect();
                Mesh {
                    cols: n[0] as u32,
                    rows: n[1] as u32,
                    pts: n[4..].chunks(2).map(|p| Pt::new(p[0], p[1])).collect(),
                    x: 0.0,
                    y: 0.0,
                    w: n[2],
                    h: n[3],
                }
            })
            .collect()
    }

    #[test]
    fn a_piece_taken_on_trust_is_within_the_tolerance_of_its_chord() {
        // Every mesh of the file; pieces of exactly the length the cut calls
        // flat, laid at many places and angles inside the box and a little
        // past it. The map's own point at the middle of each is no further
        // than the tolerance from the middle of its chord.
        let tol = 0.01;
        let mut seed = 12345u32;
        let mut rnd = move || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            f64::from(seed) / f64::from(u32::MAX)
        };
        let (mut tried, mut worst) = (0, 0.0f64);
        for m in fixture_meshes() {
            let map = m.map().unwrap().unwrap();
            for _ in 0..400 {
                let c = Pt::new(m.w * (rnd() * 1.2 - 0.1), m.h * (rnd() * 1.2 - 0.1));
                let bounds = (c.x - 20.0, c.y - 20.0, c.x + 20.0, c.y + 20.0);
                let cut = map.cut(bounds, tol);
                if cut.flat_len == 0.0 {
                    continue;
                }
                let len = cut.flat_len.min(cut.max_len).min(20.0);
                let (sin, cos) = (rnd() * 6.3).sin_cos();
                let half = Pt::new(cos, sin).scale(len / 2.0);
                let (a, b) = (map.at(c.minus(half)), map.at(c.plus(half)));
                let off = map.at(c).minus(a.plus(b).scale(0.5)).len();
                assert!(
                    off <= tol * 1.0001,
                    "{}x{}: {off} over {len}",
                    m.cols,
                    m.rows
                );
                worst = worst.max(off);
                tried += 1;
            }
        }
        // The bound is not so loose that nothing is ever trusted.
        assert!(
            tried > 2000 && worst > tol / 50.0,
            "{tried} pieces, worst {worst}"
        );
        // A drip's bound holds too.
        let d = Drip {
            mid: 20.0,
            bottom: 50.0,
            pull: 12.0,
        };
        let cut = d.cut(tol);
        assert_eq!(cut.max_len, 15.0);
        for k in 0..200 {
            let y = 15.0 + 0.2 * f64::from(k);
            let (a, b) = (d.at(Pt::new(0.0, y)), d.at(Pt::new(0.0, y + cut.flat_len)));
            let mid = d.at(Pt::new(0.0, y + cut.flat_len / 2.0));
            assert!((mid.y - (a.y + b.y) / 2.0).abs() <= tol * 1.0001);
        }
    }

    fn square(x0: f64, y0: f64, side: f64) -> Polys {
        let mut p = Polys::default();
        for (x, y) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)] {
            p.push(Pt::new(x0 + x * side, y0 + y * side));
        }
        p.close();
        p
    }

    #[test]
    fn an_affine_map_adds_no_points_and_a_curved_one_stays_within_the_tolerance() {
        let sq = square(10.0, 10.0, 40.0);
        let shear = |p: Pt| Pt::new(p.x + 0.5 * p.y, p.y * 2.0);
        let out = bend(&sq, shear, whole(1000.0), 0.01).unwrap();
        assert_eq!(out.pts.len(), 4);
        assert_eq!(&*out.ends, &vec![4]);
        assert_eq!(out.pts[2], Pt::new(75.0, 100.0));
        assert_eq!(out.area2(), sq.area2() * 2.0);

        // y' = y + x^2 / 100: the top and bottom edges become parabolas.
        let curve = |p: Pt| Pt::new(p.x, p.y + p.x * p.x / 100.0);
        let tol = 0.01;
        let out = bend(&sq, curve, whole(1000.0), tol).unwrap();
        assert!(out.pts.len() > 20, "{}", out.pts.len());
        assert_eq!(out.ends.len(), 1);
        // Every chord's midpoint is within the tolerance of the curve, and
        // the area is the square's (the map keeps areas).
        let n = out.pts.len();
        for i in 0..n {
            let (a, b) = (out.pts[i], out.pts[(i + 1) % n]);
            let mid = a.plus(b).scale(0.5);
            if (a.x - b.x).abs() > 1e-9 {
                let on = [10.0, 50.0]
                    .iter()
                    .map(|y| (mid.y - (y + mid.x * mid.x / 100.0)).abs())
                    .fold(f64::MAX, f64::min);
                assert!(on <= tol * 1.5, "{on}");
            }
        }
        assert!((out.area2() - sq.area2()).abs() < 2.0);
        // A long edge is split to the map's scale even where the map is
        // straight: 40 / 5 pieces a side.
        let out = bend(&sq, shear, whole(5.0), 0.01).unwrap();
        assert_eq!(out.pts.len(), 32);
    }

    #[test]
    fn a_cubic_that_crosses_its_chord_at_the_middle_is_still_cut() {
        // Odd about x = 30, the middle of the top edge: a midpoint test
        // would see nothing.
        let s = |p: Pt| {
            let t = (p.x - 30.0) / 20.0;
            Pt::new(p.x, p.y + 6.0 * (t * t * t - t))
        };
        let out = bend(&square(10.0, 10.0, 40.0), s, whole(1000.0), 0.01).unwrap();
        assert!(out.pts.len() > 20, "{}", out.pts.len());
    }

    #[test]
    fn a_point_sent_nowhere_refuses_the_outline() {
        let sq = square(0.0, 0.0, 10.0);
        let hole = |p: Pt| {
            if p.x > 5.0 {
                Pt::new(f64::NAN, p.y)
            } else {
                p
            }
        };
        assert_eq!(
            bend(&sq, hole, whole(100.0), 0.01).err(),
            Some(Error::BadSpec)
        );
        let far = |p: Pt| Pt::new(p.x * 1e9, p.y);
        assert_eq!(
            bend(&sq, far, whole(100.0), 0.01).err(),
            Some(Error::BadSpec)
        );
    }

    #[test]
    fn a_drip_keeps_the_top_level_and_moves_the_bottom_by_its_pull() {
        let d = Drip {
            mid: 20.0,
            bottom: 40.0,
            pull: 8.0,
        };
        for y in [-5.0, 0.0, 19.9, 20.0] {
            assert_eq!(d.at(Pt::new(3.0, y)), Pt::new(3.0, y));
        }
        assert_eq!(d.at(Pt::new(3.0, 30.0)), Pt::new(3.0, 34.0));
        assert_eq!(d.at(Pt::new(3.0, 40.0)), Pt::new(3.0, 48.0));
        assert_eq!(d.at(Pt::new(3.0, 45.0)), Pt::new(3.0, 53.0));
        // It never folds: a lower point stays lower.
        let mut last = f64::MIN;
        for k in 0..=100 {
            let y = d.at(Pt::new(0.0, 10.0 + 0.4 * f64::from(k))).y;
            assert!(y > last);
            last = y;
        }
    }

    #[test]
    fn a_mesh_turned_over_says_so() {
        let over = |m: &Mesh| {
            m.map()
                .unwrap()
                .unwrap()
                .tangent_over((30.0, 10.0, 50.0, 30.0))
        };
        let mut m = mesh(1, 1, 100.0, 50.0);
        // Left and right swapped.
        m.pts = vec![
            Pt::new(100.0, 0.0),
            Pt::new(0.0, 0.0),
            Pt::new(100.0, 50.0),
            Pt::new(0.0, 50.0),
        ];
        assert!(over(&m).det() < 0.0);
        let mut m = mesh(2, 2, 100.0, 50.0);
        m.pts[4].y -= 12.0;
        assert!(over(&m).det() > 0.0);
        // A shear is its own tangent, wherever it is asked.
        let mut m = mesh(1, 1, 100.0, 50.0);
        for p in &mut m.pts {
            *p = Pt::new(p.x + 0.4 * p.y + 3.0, p.y * 1.5 - 2.0);
        }
        let t = over(&m);
        for (got, want) in t.0.iter().zip([1.0, 0.0, 0.4, 1.5, 3.0, -2.0]) {
            assert!((got - want).abs() < 1e-9, "{:?}", t.0);
        }
    }
}
