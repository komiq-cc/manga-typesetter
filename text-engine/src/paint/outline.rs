//! Glyph outlines as closed polylines in job space.

use skrifa::outline::OutlinePen;

use super::geom::{Affine, Polys, Pt};
use crate::font::FontEntry;

/// How far, in device pixels, a flattened curve may lie from the curve.
///
/// A chord cuts off a sliver at most this deep, so the coverage of an edge
/// pixel is wrong by at most this share of a pixel: a fortieth of a pixel is
/// six of the 255 alpha levels at the very worst and under one on average
/// (`parity/raster.mjs` measures it against a 32x supersampled raster).
pub const FLATTEN_TOLERANCE: f64 = 0.025;

/// Most chords one curve segment is cut into. A guard against an absurd
/// transform, not a quality setting.
const MAX_CHORDS: f64 = 512.0;

/// Receives one glyph's outline in font units and writes it to `out`,
/// flattened, in job space.
struct FlattenPen<'a> {
    out: &'a mut Polys,
    /// Font units, y up and already slanted, to job space.
    place: Affine,
    skew: f64,
    /// [`FLATTEN_TOLERANCE`] expressed in job units.
    tol: f64,
    cur: Pt,
}

impl FlattenPen<'_> {
    fn map(&self, x: f32, y: f32) -> Pt {
        let (x, y) = (f64::from(x), f64::from(y));
        self.place.apply(Pt::new(x + self.skew * y, y))
    }

    /// Chords needed so that a curve whose second difference is `dd` stays
    /// within the tolerance. For a parabola cut into `n` equal parameter
    /// steps the largest gap is `|dd| / (4 n^2)`.
    fn chords(&self, dd: f64) -> usize {
        let n = (dd / (4.0 * self.tol)).sqrt().ceil();
        // Anything else is one chord, and that includes the NaN of a zero
        // tolerance.
        if n >= 1.0 {
            n.min(MAX_CHORDS) as usize
        } else {
            1
        }
    }
}

impl OutlinePen for FlattenPen<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        self.out.close();
        self.cur = self.map(x, y);
        self.out.push(self.cur);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.cur = self.map(x, y);
        self.out.push(self.cur);
    }

    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        let (p0, p1, p2) = (self.cur, self.map(cx0, cy0), self.map(x, y));
        let dd = p0.minus(p1.scale(2.0)).plus(p2).len();
        let n = self.chords(dd);
        for i in 1..n {
            let t = i as f64 / n as f64;
            let u = 1.0 - t;
            self.out.push(
                p0.scale(u * u)
                    .plus(p1.scale(2.0 * u * t))
                    .plus(p2.scale(t * t)),
            );
        }
        self.out.push(p2);
        self.cur = p2;
    }

    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        let (p0, p1, p2, p3) = (
            self.cur,
            self.map(cx0, cy0),
            self.map(cx1, cy1),
            self.map(x, y),
        );
        // A cubic's second derivative is at most six times the larger of its
        // two second differences, a parabola's exactly twice its one: so the
        // cubic is treated as a parabola with three times that difference.
        let d0 = p0.minus(p1.scale(2.0)).plus(p2).len();
        let d1 = p1.minus(p2.scale(2.0)).plus(p3).len();
        let n = self.chords(3.0 * d0.max(d1));
        for i in 1..n {
            let t = i as f64 / n as f64;
            let u = 1.0 - t;
            self.out.push(
                p0.scale(u * u * u)
                    .plus(p1.scale(3.0 * u * u * t))
                    .plus(p2.scale(3.0 * u * t * t))
                    .plus(p3.scale(t * t * t)),
            );
        }
        self.out.push(p3);
        self.cur = p3;
    }

    fn close(&mut self) {
        self.out.close();
    }
}

/// Appends glyph `glyph` of `entry` to `out` as closed polylines.
///
/// `place` maps the glyph's own frame in pixels (x right, y **down**, origin
/// at the glyph's origin on the baseline) to job space; `px_per_unit` is the
/// font size over the units per em, `skew` the synthetic slant in font units
/// of x per unit of y, and `tol` the flattening tolerance in job units.
pub fn glyph_polys(
    entry: &FontEntry,
    glyph: u32,
    place: &Affine,
    px_per_unit: f64,
    skew: f64,
    tol: f64,
    out: &mut Polys,
) {
    // Font units are y up; the glyph frame is y down.
    let place = place.after(&Affine::scale(px_per_unit, -px_per_unit));
    let mut pen = FlattenPen {
        out,
        place,
        skew,
        tol,
        cur: Pt::default(),
    };
    entry.draw_glyph(glyph, &mut pen);
    pen.out.close();
}
