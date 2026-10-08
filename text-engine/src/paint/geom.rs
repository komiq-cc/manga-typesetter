//! Points, affine maps and closed polylines: all the geometry the painter has.
//!
//! Everything is `f64`. Coordinates reach tens of thousands of device pixels
//! and coverage is wanted to a few thousandths of one, which is more than an
//! `f32` holds.

/// Whether `v` is a number above zero. Written as a function because the
/// painter asks it of every length it is given, and "not above zero" has to
/// include a NaN: a job built in Rust, unlike a decoded one, could hold one.
pub fn positive(v: f64) -> bool {
    v > 0.0
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

impl Pt {
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn plus(self, o: Pt) -> Pt {
        Pt::new(self.x + o.x, self.y + o.y)
    }

    pub fn minus(self, o: Pt) -> Pt {
        Pt::new(self.x - o.x, self.y - o.y)
    }

    pub fn scale(self, k: f64) -> Pt {
        Pt::new(self.x * k, self.y * k)
    }

    pub fn dot(self, o: Pt) -> f64 {
        self.x * o.x + self.y * o.y
    }

    pub fn cross(self, o: Pt) -> f64 {
        self.x * o.y - self.y * o.x
    }

    pub fn len(self) -> f64 {
        self.dot(self).sqrt()
    }
}

/// The canvas matrix `(a, b, c, d, e, f)`:
/// `x' = a x + c y + e`, `y' = b x + d y + f`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Affine(pub [f64; 6]);

impl Affine {
    pub const IDENTITY: Self = Self([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);

    pub fn translate(x: f64, y: f64) -> Self {
        Self([1.0, 0.0, 0.0, 1.0, x, y])
    }

    /// Canvas `rotate(angle)`, given the angle's cosine and sine.
    pub fn rotate(cos: f64, sin: f64) -> Self {
        Self([cos, sin, -sin, cos, 0.0, 0.0])
    }

    pub fn scale(sx: f64, sy: f64) -> Self {
        Self([sx, 0.0, 0.0, sy, 0.0, 0.0])
    }

    pub fn apply(&self, p: Pt) -> Pt {
        let [a, b, c, d, e, f] = self.0;
        Pt::new(a * p.x + c * p.y + e, b * p.x + d * p.y + f)
    }

    /// The map that applies `first` and then `self`: what a canvas holds
    /// after `ctx.transform(first)` on a context whose matrix was `self`.
    pub fn after(&self, first: &Affine) -> Affine {
        let [a, b, c, d, e, f] = self.0;
        let [fa, fb, fc, fd, fe, ff] = first.0;
        Affine([
            a * fa + c * fb,
            b * fa + d * fb,
            a * fc + c * fd,
            b * fc + d * fd,
            a * fe + c * ff + e,
            b * fe + d * ff + f,
        ])
    }

    pub fn det(&self) -> f64 {
        self.0[0] * self.0[3] - self.0[1] * self.0[2]
    }

    pub fn is_finite(&self) -> bool {
        self.0.iter().all(|v| v.is_finite())
    }

    /// `None` when the map flattens the plane, which leaves nothing to draw.
    pub fn invert(&self) -> Option<Affine> {
        let [a, b, c, d, e, f] = self.0;
        let det = self.det();
        if !det.is_finite() || det == 0.0 {
            return None;
        }
        let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
        let inv = Affine([ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)]);
        inv.is_finite().then_some(inv)
    }

    /// The largest factor by which the map stretches a length.
    pub fn max_scale(&self) -> f64 {
        let [a, b, c, d, ..] = self.0;
        let s = a * a + b * b + c * c + d * d;
        let det = self.det();
        let disc = (s * s - 4.0 * det * det).max(0.0);
        ((s + disc.sqrt()) / 2.0).sqrt()
    }
}

/// `[x0, y0, x1, y1)` in whole device pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IBox {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

impl IBox {
    pub fn width(&self) -> usize {
        (self.x1 - self.x0).max(0) as usize
    }

    pub fn height(&self) -> usize {
        (self.y1 - self.y0).max(0) as usize
    }

    pub fn is_empty(&self) -> bool {
        self.x1 <= self.x0 || self.y1 <= self.y0
    }

    pub fn union(&self, o: &IBox) -> IBox {
        IBox {
            x0: self.x0.min(o.x0),
            y0: self.y0.min(o.y0),
            x1: self.x1.max(o.x1),
            y1: self.y1.max(o.y1),
        }
    }

    pub fn intersect(&self, o: &IBox) -> IBox {
        IBox {
            x0: self.x0.max(o.x0),
            y0: self.y0.max(o.y0),
            x1: self.x1.min(o.x1),
            y1: self.y1.min(o.y1),
        }
    }
}

/// Closed polylines. Contour `i` is `pts[ends[i - 1]..ends[i]]`, and its last
/// point joins its first.
#[derive(Clone, Debug, Default)]
pub struct Polys {
    pub pts: Vec<Pt>,
    pub ends: Vec<usize>,
}

impl Polys {
    pub fn is_empty(&self) -> bool {
        self.ends.is_empty()
    }

    pub fn clear(&mut self) {
        self.pts.clear();
        self.ends.clear();
    }

    fn open_from(&self) -> usize {
        self.ends.last().copied().unwrap_or(0)
    }

    /// Adds a point to the contour under construction. A point equal to the
    /// one before it is dropped: a zero-length edge has no direction, and the
    /// stroker needs one from every edge.
    pub fn push(&mut self, p: Pt) {
        if self.pts.len() > self.open_from() && self.pts[self.pts.len() - 1] == p {
            return;
        }
        self.pts.push(p);
    }

    /// Ends the contour under construction. One with fewer than two distinct
    /// points encloses and outlines nothing, and is dropped.
    pub fn close(&mut self) {
        let from = self.open_from();
        while self.pts.len() > from + 1 && self.pts[self.pts.len() - 1] == self.pts[from] {
            self.pts.pop();
        }
        if self.pts.len() - from < 2 {
            self.pts.truncate(from);
            return;
        }
        self.ends.push(self.pts.len());
    }

    pub fn contours(&self) -> impl Iterator<Item = &[Pt]> + '_ {
        let mut from = 0;
        self.ends.iter().map(move |&end| {
            let c = &self.pts[from..end];
            from = end;
            c
        })
    }

    pub fn append(&mut self, other: &Polys) {
        let base = self.pts.len();
        self.pts.extend_from_slice(&other.pts);
        self.ends.extend(other.ends.iter().map(|e| e + base));
    }

    /// The same contours under `m`.
    pub fn map(&self, m: &Affine) -> Polys {
        Polys {
            pts: self.pts.iter().map(|&p| m.apply(p)).collect(),
            ends: self.ends.clone(),
        }
    }

    /// `(x_min, y_min, x_max, y_max)` of every point, or `None` when empty.
    pub fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
        let first = self.pts.first()?;
        let mut b = (first.x, first.y, first.x, first.y);
        for p in &self.pts {
            b.0 = b.0.min(p.x);
            b.1 = b.1.min(p.y);
            b.2 = b.2.max(p.x);
            b.3 = b.3.max(p.y);
        }
        Some(b)
    }

    /// Twice the signed area of all contours together.
    pub fn area2(&self) -> f64 {
        self.contours()
            .map(|c| {
                let mut sum = 0.0;
                for i in 0..c.len() {
                    sum += c[i].cross(c[(i + 1) % c.len()]);
                }
                sum
            })
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn after_composes_like_a_canvas() {
        // ctx.scale(2, 2); ctx.translate(10, 5): a point is moved, then scaled.
        let m = Affine::scale(2.0, 2.0).after(&Affine::translate(10.0, 5.0));
        assert_eq!(m.apply(Pt::new(1.0, 1.0)), Pt::new(22.0, 12.0));
        let inv = m.invert().unwrap();
        assert_eq!(inv.apply(Pt::new(22.0, 12.0)), Pt::new(1.0, 1.0));
        assert!(Affine([1.0, 2.0, 2.0, 4.0, 0.0, 0.0]).invert().is_none());
    }

    #[test]
    fn max_scale_is_the_larger_axis_and_ignores_rotation() {
        assert!((Affine::scale(2.0, 3.0).max_scale() - 3.0).abs() < 1e-12);
        let r = Affine::rotate(0.6, 0.8).after(&Affine::scale(2.0, 2.0));
        assert!((r.max_scale() - 2.0).abs() < 1e-12);
    }

    #[test]
    fn contours_drop_repeats_and_degenerate_loops() {
        let mut p = Polys::default();
        for (x, y) in [(0.0, 0.0), (0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 0.0)] {
            p.push(Pt::new(x, y));
        }
        p.close();
        p.push(Pt::new(5.0, 5.0));
        p.close();
        assert_eq!(p.ends, vec![3]);
        assert_eq!(p.area2(), 1.0);
    }
}
