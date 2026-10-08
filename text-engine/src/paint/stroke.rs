//! Offsetting closed polylines: the stroke of an outline, and an outline
//! grown outward.
//!
//! Both come from one routine, [`offset_loop`], which walks a contour and
//! writes the curve a fixed distance to one side of it. What it writes is
//! *weakly* correct: the loop may cross itself, but filled with the non-zero
//! rule it covers exactly the true region. In terms of the pieces a stroke is
//! made of, the loop on one side is the contour plus one half-rectangle per
//! edge and one sector per outside corner, all turning the same way, less
//! the overlap of two neighbouring half-rectangles where an inside corner
//! was cut short at their intersection. So the winding number never changes
//! sign across the stroke and never reaches zero inside it.

use super::geom::{positive, Polys, Pt};

/// How two offset edges are joined on the outside of a corner.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Join {
    /// A circular arc about the corner: canvas `lineJoin = "round"`.
    Round,
    /// The two offset edges produced to their intersection, unless that
    /// lies further from the corner than `limit` half-widths: then a bevel.
    Miter { limit: f64 },
}

/// Which side of a contour, as it is walked, an offset goes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// The side of the normal `(-dy, dx)`.
    Left,
    Right,
}

impl Side {
    fn sign(self) -> f64 {
        match self {
            Side::Left => 1.0,
            Side::Right => -1.0,
        }
    }
}

/// Turns sharper than this are joined; shallower ones are a single point.
/// The cross product of two unit directions: about a millionth of a degree.
const STRAIGHT: f64 = 1e-10;

/// The region within `radius` of the contours of `src` (canvas `stroke()`
/// with `lineWidth = 2 * radius` on closed paths), appended to `out` as
/// contours to fill with the non-zero rule.
pub fn stroke(src: &Polys, radius: f64, join: Join, tol: f64, out: &mut Polys) {
    if !positive(radius) {
        return;
    }
    for c in src.contours() {
        offset_loop(c, radius, Side::Left, join, tol, out);
        let from = out.pts.len();
        offset_loop(c, radius, Side::Right, join, tol, out);
        // Walked backwards, the far side turns the same way round the
        // stroke as the near side does.
        out.pts[from..].reverse();
    }
}

/// The contours of `src` moved `radius` to `side`, appended to `out`. With
/// the side that faces away from the ink this is the outline grown by
/// `radius`: the fill and its stroke as one shape.
pub fn grow(src: &Polys, radius: f64, side: Side, join: Join, tol: f64, out: &mut Polys) {
    if !positive(radius) {
        out.append(src);
        return;
    }
    for c in src.contours() {
        offset_loop(c, radius, side, join, tol, out);
    }
}

fn unit(v: Pt) -> Option<(Pt, f64)> {
    let len = v.len();
    (len > 0.0 && len.is_finite()).then(|| (v.scale(1.0 / len), len))
}

/// Writes points on the arc of `radius` about `centre` from direction `u0`
/// to `u1` (both unit, less than a half turn apart), ends excluded.
fn arc(centre: Pt, radius: f64, u0: Pt, u1: Pt, tol: f64, out: &mut Polys, depth: u32) {
    // Sagitta of the chord from u0 to u1.
    let cos_half = ((1.0 + u0.dot(u1)) / 2.0).max(0.0).sqrt();
    if radius * (1.0 - cos_half) <= tol || depth >= 12 {
        return;
    }
    let Some((mid, _)) = unit(u0.plus(u1)) else {
        return;
    };
    arc(centre, radius, u0, mid, tol, out, depth + 1);
    out.push(centre.plus(mid.scale(radius)));
    arc(centre, radius, mid, u1, tol, out, depth + 1);
}

/// One closed contour offset by `radius` to `side`, as one closed contour.
fn offset_loop(pts: &[Pt], radius: f64, side: Side, join: Join, tol: f64, out: &mut Polys) {
    let n = pts.len();
    if n < 2 {
        return;
    }
    let s = side.sign();
    // Direction and length of the edge leaving each point. `Polys` holds no
    // repeated points, so every edge has a direction.
    let edge = |i: usize| unit(pts[(i + 1) % n].minus(pts[i]));
    let Some(mut prev) = edge(n - 1) else {
        return;
    };
    for (i, &p) in pts.iter().enumerate() {
        let Some(next) = edge(i) else {
            continue;
        };
        let (da, la) = prev;
        let (db, lb) = next;
        // Offset directions of the two edges on this side.
        let na = Pt::new(-da.y, da.x).scale(s);
        let nb = Pt::new(-db.y, db.x).scale(s);
        let cross = da.cross(db);
        let dot = da.dot(db);
        // Where the two offset edges meet, measured from the corner.
        let meet = |dot: f64| p.plus(na.plus(nb).scale(radius / (1.0 + dot)));
        if cross.abs() < STRAIGHT && dot > 0.0 {
            out.push(p.plus(nb.scale(radius)));
        } else if s * cross > 0.0 {
            // This side is the inside of the corner. The offset edges cross
            // `radius * tan(turn / 2)` back from the corner; if both edges
            // are long enough for that, the crossing is the offset's corner.
            // Half an edge each keeps the cuts at an edge's two ends apart.
            let cut = radius * cross.abs() / (1.0 + dot);
            if dot > -1.0 && cut <= la / 2.0 && cut <= lb / 2.0 {
                out.push(meet(dot));
            } else {
                // Otherwise through the corner itself, as Skia's stroker
                // does: the loop doubles back, and the non-zero rule fills
                // the fold.
                out.push(p.plus(na.scale(radius)));
                out.push(p);
                out.push(p.plus(nb.scale(radius)));
            }
        } else {
            // The outside of the corner (a hairpin, `cross == 0`, counts as
            // outside on the left and inside on the right).
            if cross.abs() < STRAIGHT && s < 0.0 {
                out.push(p.plus(na.scale(radius)));
                out.push(p);
                out.push(p.plus(nb.scale(radius)));
                prev = next;
                continue;
            }
            let a = p.plus(na.scale(radius));
            let b = p.plus(nb.scale(radius));
            match join {
                Join::Miter { limit } => {
                    // Distance to the miter tip in half-widths: 1 / cos(turn / 2).
                    let cos_half = ((1.0 + dot) / 2.0).max(0.0).sqrt();
                    if cos_half > 0.0 && 1.0 / cos_half <= limit {
                        out.push(meet(dot));
                    } else {
                        out.push(a);
                        out.push(b);
                    }
                }
                Join::Round => {
                    out.push(a);
                    // The arc bulges away from the corner: through the
                    // direction `da - db`, which is the only stable way to
                    // name its middle when the turn nears a half turn.
                    let mid = if dot < 0.0 {
                        unit(da.minus(db)).map(|(m, _)| m)
                    } else {
                        unit(na.plus(nb)).map(|(m, _)| m)
                    };
                    if let Some(mid) = mid {
                        arc(p, radius, na, mid, tol, out, 0);
                        out.push(p.plus(mid.scale(radius)));
                        arc(p, radius, mid, nb, tol, out, 0);
                    }
                    out.push(b);
                }
            }
        }
        prev = next;
    }
    out.close();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(side: f64) -> Polys {
        let mut p = Polys::default();
        for (x, y) in [(0.0, 0.0), (side, 0.0), (side, side), (0.0, side)] {
            p.push(Pt::new(x, y));
        }
        p.close();
        p
    }

    #[test]
    fn a_round_stroke_reaches_exactly_one_radius_from_the_outline() {
        let mut out = Polys::default();
        stroke(&square(10.0), 3.0, Join::Round, 0.001, &mut out);
        let (x0, y0, x1, y1) = out.bounds().unwrap();
        for (got, want) in [(x0, -3.0), (y0, -3.0), (x1, 13.0), (y1, 13.0)] {
            assert!((got - want).abs() < 1e-9, "{got} vs {want}");
        }
        // Two loops per contour, and every point of the outer one within a
        // radius of the square (a round corner, not a mitred one).
        assert_eq!(out.ends.len(), 2);
        for p in &out.pts {
            let dx = (p.x - p.x.clamp(0.0, 10.0)).abs();
            let dy = (p.y - p.y.clamp(0.0, 10.0)).abs();
            assert!(dx.hypot(dy) <= 3.0 + 1e-9);
        }
    }

    #[test]
    fn the_inside_of_a_corner_is_cut_at_the_crossing() {
        let mut out = Polys::default();
        // The square is walked with its inside on the left (y up), so the
        // left loop is the inner one: a square 3 in from every side.
        offset_loop(
            &square(10.0).pts,
            3.0,
            Side::Left,
            Join::Round,
            0.001,
            &mut out,
        );
        assert_eq!(out.pts.len(), 4);
        assert_eq!(out.bounds(), Some((3.0, 3.0, 7.0, 7.0)));
        assert!((out.area2() - 32.0).abs() < 1e-9);
    }

    #[test]
    fn growing_changes_the_area_like_a_minkowski_sum() {
        let mut out = Polys::default();
        grow(&square(10.0), 2.0, Side::Right, Join::Round, 1e-5, &mut out);
        // Area of a square grown by r with round corners: s^2 + 4 s r + pi r^2.
        let want = 100.0 + 80.0 + core::f64::consts::PI * 4.0;
        assert!(
            (out.area2() / 2.0 - want).abs() < 1e-2,
            "{}",
            out.area2() / 2.0
        );

        let mut mitred = Polys::default();
        grow(
            &square(10.0),
            2.0,
            Side::Right,
            Join::Miter { limit: 4.0 },
            1e-5,
            &mut mitred,
        );
        assert!((mitred.area2() / 2.0 - 196.0).abs() < 1e-9);
        // A right angle needs sqrt(2) half-widths: under that limit, a bevel.
        let mut bevel = Polys::default();
        grow(
            &square(10.0),
            2.0,
            Side::Right,
            Join::Miter { limit: 1.2 },
            1e-5,
            &mut bevel,
        );
        assert!((bevel.area2() / 2.0 - (196.0 - 4.0 * 2.0)).abs() < 1e-9);
    }

    #[test]
    fn a_radius_larger_than_the_shape_still_yields_a_closed_loop() {
        let mut out = Polys::default();
        stroke(&square(1.0), 5.0, Join::Round, 0.01, &mut out);
        assert_eq!(out.ends.len(), 2);
        assert!(out.pts.iter().all(|p| p.x.is_finite() && p.y.is_finite()));
        let (x0, _, x1, _) = out.bounds().unwrap();
        assert!((x0 + 5.0).abs() < 1e-9 && (x1 - 6.0).abs() < 1e-9);
    }
}
