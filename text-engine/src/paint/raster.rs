//! Coverage: how much of each device pixel a shape covers.
//!
//! This is the one interface the choice of rasteriser sits behind. A
//! [`Rasterizer`] is handed closed polylines in device pixels, to be filled
//! with the non-zero rule, and returns a [`Coverage`] that the compositor
//! asks for a few rows at a time. Everything above it (shaping, stroking,
//! shading, compositing) is the same whichever rasteriser is in use.
//!
//! The one in use is [`Exact`]: signed-area accumulation, the method of
//! FreeType's smooth rasteriser and of font-rs. Each edge adds, to every
//! pixel it passes through, the exact area of that pixel lying to its right,
//! and a running sum along the row turns those into coverage. There is no
//! sampling, so there is no sample grid for a thin stem to fall between: a
//! stroke 0.3 px wide covers 0.3 of every pixel it runs through.
//!
//! What it gives up: the running sum is the *integral* of the winding number
//! over the pixel, not the area where the winding number is non-zero. The
//! two agree unless two parts of the shape that wind the same way both cover
//! a pixel partly and overlap inside it, in which case the overlap is counted
//! twice (and clamped at full coverage). For text that is the single pixel
//! where the strokes of two neighbouring glyphs cross, or a fold of a stroke
//! on a curve tighter than the pen. `parity/raster.mjs` measures how much.
//!
//! The other candidates that were measured, tiny-skia's supersampling
//! rasteriser and zeno's, are kept behind the `raster-compare` feature so the
//! comparison in P5A-REPORT.md can be run again.

use super::geom::{IBox, Polys};

/// Rows the compositor works through at a time. A band of rows this tall of
/// a 1200 px wide block is 150 KB of coverage and 600 KB of colour, which
/// stays in the cache; the whole surface at once would not.
pub const STRIP_ROWS: i32 = 32;

/// The strip a device row belongs to. Strips are aligned to device row 0, so
/// every layer of a paint cuts its rows at the same places.
pub fn strip_of(y: i32) -> i32 {
    y.div_euclid(STRIP_ROWS)
}

/// Coverage of one shape, produced a strip at a time.
pub trait Coverage {
    /// Writes the coverage of device rows `y0..y1`, which lie in one strip
    /// and inside the box the coverage was prepared for.
    ///
    /// `out` holds `stride` values per row, zeroed by the caller, where
    /// `stride` is at least the box's width plus two; on return
    /// `out[row * stride + x]` is the share, 0 to 1, of pixel `x` (counted
    /// from the box's left edge) that the shape covers. `spans[row]` is set
    /// to the half-open range of columns that can be non-zero.
    fn render(
        &mut self,
        y0: i32,
        y1: i32,
        out: &mut [f32],
        stride: usize,
        spans: &mut [(u32, u32)],
    );
}

/// Turns shapes into coverage.
pub trait Rasterizer {
    /// `polys` are closed polylines in device pixels, filled with the
    /// non-zero rule; only the part inside `bx` is wanted.
    fn prepare(&self, polys: &Polys, bx: IBox) -> Box<dyn Coverage>;

    /// A stroke given as two shapes (`stroke::stroke_sides`): what is inside
    /// `outer` and not inside `inner`. The two wind the same way round what
    /// they hold, and `inner` winds the other way, or not at all, wherever
    /// it holds nothing.
    ///
    /// The default is for a rasteriser that can only fill: the two as one
    /// shape, `inner` walked backwards so that it cuts a hole.
    fn prepare_ring(&self, outer: &Polys, inner: &Polys, bx: IBox) -> Box<dyn Coverage> {
        let mut ring = outer.clone();
        let from = ring.pts.len();
        ring.append(inner);
        let mut start = from;
        for &end in &ring.ends[outer.ends.len()..] {
            ring.pts[start..end].reverse();
            start = end;
        }
        self.prepare(&ring, bx)
    }
}

/// Exact-area coverage by signed-area accumulation.
pub struct Exact;

/// One edge, in pixels from the box's corner, running downwards.
#[derive(Clone, Copy)]
struct Edge {
    x0: f64,
    y0: f64,
    x1: f64,
    y1: f64,
    /// +1 if the contour ran down this edge, -1 if up.
    dir: f32,
}

/// The edges of one shape, sorted into the strips they cross.
struct Edges {
    edges: Vec<Edge>,
    /// `bucket[k]..bucket[k + 1]` indexes `order` for the box's `k`th strip.
    bucket: Vec<u32>,
    order: Vec<u32>,
}

impl Edges {
    fn new(polys: &Polys, bx: IBox) -> Self {
        let (ox, oy) = (f64::from(bx.x0), f64::from(bx.y0));
        let height = bx.height() as f64;
        let mut edges = Vec::with_capacity(polys.pts.len());
        for c in polys.contours() {
            for i in 0..c.len() {
                let (p, q) = (c[i], c[(i + 1) % c.len()]);
                if p.y == q.y {
                    continue;
                }
                let (top, bottom, dir) = if p.y < q.y { (p, q, 1.0) } else { (q, p, -1.0) };
                let e = Edge {
                    x0: top.x - ox,
                    y0: top.y - oy,
                    x1: bottom.x - ox,
                    y1: bottom.y - oy,
                    dir,
                };
                if e.y1 <= 0.0 || e.y0 >= height {
                    continue;
                }
                edges.push(e);
            }
        }
        // Counting sort of the edges into the strips they cross.
        let first_strip = strip_of(bx.y0);
        let strips = (strip_of(bx.y1 - 1) - first_strip + 1).max(1) as usize;
        let last_row = bx.y1 - bx.y0 - 1;
        let strip_range = |e: &Edge| {
            let top = (e.y0.max(0.0).floor() as i32).min(last_row);
            // The last row an edge reaches is the one holding the point just
            // above its lower end.
            let bottom = ((e.y1.min(height).ceil() as i32) - 1).clamp(top, last_row);
            let a = (strip_of(bx.y0 + top) - first_strip) as usize;
            let b = (strip_of(bx.y0 + bottom) - first_strip) as usize;
            (a, b)
        };
        let mut bucket = vec![0u32; strips + 1];
        for e in &edges {
            let (a, b) = strip_range(e);
            for k in a..=b {
                bucket[k + 1] += 1;
            }
        }
        for k in 0..strips {
            bucket[k + 1] += bucket[k];
        }
        let mut fill = bucket.clone();
        let mut order = vec![0u32; bucket[strips] as usize];
        for (i, e) in edges.iter().enumerate() {
            let (a, b) = strip_range(e);
            for k in a..=b {
                order[fill[k] as usize] = i as u32;
                fill[k] += 1;
            }
        }
        Self {
            edges,
            bucket,
            order,
        }
    }

    /// Adds, to every pixel of rows `row_lo..row_hi` (counted from the box's
    /// top, all in strip `k` of the box), the signed area each edge leaves to
    /// its right, and widens `spans` to the columns touched. A running sum
    /// along a row then gives the integral of the winding number over each
    /// pixel.
    #[allow(clippy::too_many_arguments)]
    fn accumulate(
        &self,
        k: usize,
        row_lo: usize,
        row_hi: usize,
        width: usize,
        out: &mut [f32],
        stride: usize,
        spans: &mut [(u32, u32)],
    ) {
        let (lo, hi, wf) = (row_lo as f64, row_hi as f64, width as f64);
        let (from, to) = (self.bucket[k] as usize, self.bucket[k + 1] as usize);
        for &i in &self.order[from..to] {
            let e = self.edges[i as usize];
            let dxdy = (e.x1 - e.x0) / (e.y1 - e.y0);
            let top = e.y0.max(lo);
            let bottom = e.y1.min(hi);
            if bottom <= top {
                continue;
            }
            let mut x = e.x0 + (top - e.y0) * dxdy;
            let first = top.floor() as usize;
            let last = (bottom.ceil() as usize).max(first + 1);
            for row in first..last {
                let ya = top.max(row as f64);
                let yb = bottom.min((row + 1) as f64);
                let dy = yb - ya;
                if dy <= 0.0 {
                    continue;
                }
                let x_end = x + dy * dxdy;
                // An edge left of the box still covers everything to its
                // right; one right of it covers nothing inside.
                let (xa, xb) = if x <= x_end { (x, x_end) } else { (x_end, x) };
                let (xa, xb) = (xa.clamp(0.0, wf), xb.clamp(0.0, wf));
                x = x_end;
                let d = dy as f32 * e.dir;
                let local = row - row_lo;
                let line = &mut out[local * stride..(local + 1) * stride];
                let ia = xa.floor() as usize;
                let ib = xb.ceil() as usize;
                let span = &mut spans[local];
                span.0 = span.0.min(ia as u32);
                if ib <= ia + 1 {
                    // The edge stays inside one pixel column on this row:
                    // the pixel keeps the part of the row's height that lies
                    // to the edge's right, the next one gets the rest.
                    let mid = (0.5 * (xa + xb) - ia as f64) as f32;
                    line[ia] += d - d * mid;
                    line[ia + 1] += d * mid;
                    span.1 = span.1.max(ia as u32 + 2);
                } else {
                    // The edge crosses several columns: a triangle in the
                    // first and last, a trapezoid in each one between.
                    let s = 1.0 / (xb - xa);
                    let fa = xa - ia as f64;
                    let a0 = 0.5 * s * (1.0 - fa) * (1.0 - fa);
                    let fb = xb - (ib - 1) as f64;
                    let am = 0.5 * s * fb * fb;
                    line[ia] += d * a0 as f32;
                    if ib == ia + 2 {
                        line[ia + 1] += d * (1.0 - a0 - am) as f32;
                    } else {
                        let a1 = s * (1.5 - fa);
                        line[ia + 1] += d * (a1 - a0) as f32;
                        for cell in &mut line[ia + 2..ib - 1] {
                            *cell += d * s as f32;
                        }
                        let a2 = a1 + (ib - ia - 3) as f64 * s;
                        line[ib - 1] += d * (1.0 - a2 - am) as f32;
                    }
                    line[ib] += d * am as f32;
                    span.1 = span.1.max(ib as u32 + 1);
                }
            }
        }
    }
}

/// What is taken out of a ring: the stroke's inner shape.
struct Minus {
    edges: Edges,
    /// The sign the running sum has inside the part to take out.
    sign: f32,
    sums: Vec<f32>,
    spans: Vec<(u32, u32)>,
}

struct ExactCoverage {
    plus: Edges,
    minus: Option<Minus>,
    bx: IBox,
    first_strip: i32,
}

impl Rasterizer for Exact {
    fn prepare(&self, polys: &Polys, bx: IBox) -> Box<dyn Coverage> {
        Box::new(ExactCoverage {
            plus: Edges::new(polys, bx),
            minus: None,
            bx,
            first_strip: strip_of(bx.y0),
        })
    }

    /// The outer shape's winding sum less the inner shape's, each summed on
    /// its own.
    ///
    /// As one shape, the two sides of a stem thinner than the pen are two
    /// bands that overlap, and a signed-area sum counts the overlap twice.
    /// Apart, each is one curve round its region. The inner one counts only
    /// where it winds the way the outer one does, which drops the parts of
    /// an inward offset that have turned inside out.
    fn prepare_ring(&self, outer: &Polys, inner: &Polys, bx: IBox) -> Box<dyn Coverage> {
        // A region wound +1 in the sense of `area2` has its left edge
        // running up, so the running sum inside it is -1.
        let area = outer.area2();
        let minus = (area != 0.0 && !inner.is_empty()).then(|| Minus {
            edges: Edges::new(inner, bx),
            sign: if area > 0.0 { -1.0 } else { 1.0 },
            sums: Vec::new(),
            spans: vec![(0, 0); STRIP_ROWS as usize],
        });
        Box::new(ExactCoverage {
            plus: Edges::new(outer, bx),
            minus,
            bx,
            first_strip: strip_of(bx.y0),
        })
    }
}

impl Coverage for ExactCoverage {
    fn render(
        &mut self,
        y0: i32,
        y1: i32,
        out: &mut [f32],
        stride: usize,
        spans: &mut [(u32, u32)],
    ) {
        let width = self.bx.width();
        debug_assert!(stride >= width + 2);
        debug_assert_eq!(strip_of(y0), strip_of(y1 - 1));
        let rows = (y1 - y0) as usize;
        let (row_lo, row_hi) = ((y0 - self.bx.y0) as usize, (y1 - self.bx.y0) as usize);
        let k = (strip_of(y0) - self.first_strip) as usize;
        for s in spans[..rows].iter_mut() {
            *s = (u32::MAX, 0);
        }
        self.plus
            .accumulate(k, row_lo, row_hi, width, out, stride, spans);
        if let Some(m) = &mut self.minus {
            m.sums.clear();
            m.sums.resize(stride * rows, 0.0);
            for s in m.spans[..rows].iter_mut() {
                *s = (u32::MAX, 0);
            }
            m.edges
                .accumulate(k, row_lo, row_hi, width, &mut m.sums, stride, &mut m.spans);
        }
        // The running sum of what the edges left is the signed coverage.
        for (row, span) in spans[..rows].iter_mut().enumerate() {
            let end = (span.1 as usize).min(width);
            let start = span.0 as usize;
            if start >= end {
                *span = (0, 0);
                continue;
            }
            *span = (start as u32, end as u32);
            let line = &mut out[row * stride + start..row * stride + end];
            let mut acc = 0.0f32;
            let Some(m) = &self.minus else {
                for cell in line.iter_mut() {
                    acc += *cell;
                    *cell = acc.abs().min(1.0);
                }
                continue;
            };
            // A ring. The outer sum is kept unclamped until the inner one is
            // off it: where the grown shapes of two contours overlap it is
            // 2, and taking one contour's inside out of that must leave the
            // other's stroke standing, as the non-zero rule would.
            for cell in line.iter_mut() {
                acc += *cell;
                *cell = acc.abs();
            }
            let (from, to) = (
                m.spans[row].0 as usize,
                (m.spans[row].1 as usize).min(width),
            );
            if from < to {
                // The inner shape's sum starts where its own edges start;
                // outside the outer shape's columns there is nothing to cut.
                let sums = &m.sums[row * stride..row * stride + to];
                let mut acc = 0.0f32;
                for (x, &v) in sums.iter().enumerate().skip(from) {
                    acc += v;
                    if x >= start && x < end {
                        out[row * stride + x] -= (acc * m.sign).max(0.0);
                    }
                }
            }
            for cell in out[row * stride + start..row * stride + end].iter_mut() {
                *cell = cell.clamp(0.0, 1.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::geom::Pt;

    fn render(polys: &Polys, bx: IBox) -> Vec<f32> {
        let mut cov = Exact.prepare(polys, bx);
        let (w, h) = (bx.width(), bx.height());
        let stride = w + 2;
        let mut all = vec![0.0f32; w * h];
        let mut y = bx.y0;
        while y < bx.y1 {
            let y_end = ((strip_of(y) + 1) * STRIP_ROWS).min(bx.y1);
            let rows = (y_end - y) as usize;
            let mut out = vec![0.0f32; stride * rows];
            let mut spans = vec![(0u32, 0u32); rows];
            cov.render(y, y_end, &mut out, stride, &mut spans);
            for r in 0..rows {
                let (a, b) = spans[r];
                for x in a as usize..b as usize {
                    all[((y - bx.y0) as usize + r) * w + x] = out[r * stride + x];
                }
            }
            y = y_end;
        }
        all
    }

    fn poly(points: &[(f64, f64)]) -> Polys {
        let mut p = Polys::default();
        for &(x, y) in points {
            p.push(Pt::new(x, y));
        }
        p.close();
        p
    }

    fn bx(x0: i32, y0: i32, x1: i32, y1: i32) -> IBox {
        IBox { x0, y0, x1, y1 }
    }

    #[test]
    fn coverage_is_the_exact_area_of_each_pixel() {
        // A rectangle with every edge at a fraction of a pixel.
        let r = poly(&[(1.25, 1.5), (3.75, 1.5), (3.75, 2.75), (1.25, 2.75)]);
        let c = render(&r, bx(0, 0, 5, 4));
        let want = [
            [0.0, 0.0, 0.0, 0.0, 0.0],
            [0.0, 0.375, 0.5, 0.375, 0.0],
            [0.0, 0.5625, 0.75, 0.5625, 0.0],
            [0.0, 0.0, 0.0, 0.0, 0.0],
        ];
        for (y, row) in want.iter().enumerate() {
            for (x, w) in row.iter().enumerate() {
                assert!(
                    (c[y * 5 + x] - w).abs() < 1e-6,
                    "({x},{y}) {}",
                    c[y * 5 + x]
                );
            }
        }
        let total: f32 = c.iter().sum();
        assert!((total - 2.5 * 1.25).abs() < 1e-5);
    }

    #[test]
    fn a_sliver_thinner_than_a_pixel_keeps_its_area() {
        // 0.1 px wide: a 4x4 supersampling grid has samples 0.25 px apart
        // and can miss it altogether.
        let r = poly(&[(2.31, 0.0), (2.41, 0.0), (2.41, 8.0), (2.31, 8.0)]);
        let c = render(&r, bx(0, 0, 5, 8));
        for y in 0..8 {
            assert!((c[y * 5 + 2] - 0.1).abs() < 1e-6);
        }
    }

    #[test]
    fn slanted_edges_sum_to_the_shape_area_across_strips() {
        // A triangle taller than one strip, off the pixel grid.
        let t = poly(&[(3.3, 2.2), (90.7, 40.4), (20.1, 77.9)]);
        let c = render(&t, bx(0, 0, 96, 80));
        let total: f64 = c.iter().map(|&v| f64::from(v)).sum();
        assert!((total - t.area2().abs() / 2.0).abs() < 1e-2, "{total}");
        assert!(c.iter().all(|&v| (0.0..=1.0).contains(&v)));
    }

    #[test]
    fn the_same_shape_twice_is_still_one_layer_of_coverage() {
        let mut two = poly(&[(1.0, 1.0), (9.0, 1.0), (9.0, 9.0), (1.0, 9.0)]);
        // A second square the same way round, overlapping the first.
        two.append(&poly(&[(5.0, 5.0), (13.0, 5.0), (13.0, 13.0), (5.0, 13.0)]));
        let c = render(&two, bx(0, 0, 14, 14));
        assert_eq!(c[7 * 14 + 7], 1.0);
        assert_eq!(c[2 * 14 + 2], 1.0);
        assert_eq!(c[11 * 14 + 2], 0.0);
        // A hole wound the other way does cut.
        let mut ring = poly(&[(1.0, 1.0), (9.0, 1.0), (9.0, 9.0), (1.0, 9.0)]);
        ring.append(&poly(&[(3.0, 3.0), (3.0, 7.0), (7.0, 7.0), (7.0, 3.0)]));
        let c = render(&ring, bx(0, 0, 10, 10));
        assert_eq!(c[5 * 10 + 5], 0.0);
        assert_eq!(c[2 * 10 + 2], 1.0);
    }

    #[test]
    fn a_ring_is_the_outer_shape_less_the_inner_whichever_way_they_wind() {
        let outer = [(1.0, 1.0), (9.0, 1.0), (9.0, 9.0), (1.0, 9.0)];
        let inner = [(3.5, 3.0), (7.0, 3.0), (7.0, 7.0), (3.5, 7.0)];
        let rev = |p: &[(f64, f64)]| p.iter().rev().copied().collect::<Vec<_>>();
        for (o, i) in [
            (poly(&outer), poly(&inner)),
            (poly(&rev(&outer)), poly(&rev(&inner))),
        ] {
            let mut cov = Exact.prepare_ring(&o, &i, bx(0, 0, 10, 10));
            let mut out = vec![0.0f32; 12 * 10];
            let mut spans = vec![(0u32, 0u32); 10];
            cov.render(0, 10, &mut out, 12, &mut spans);
            let at = |x: usize, y: usize| out[y * 12 + x];
            assert_eq!(at(2, 2), 1.0);
            assert_eq!(at(5, 5), 0.0);
            assert_eq!(at(3, 5), 0.5);
            assert_eq!(at(8, 5), 1.0);
            assert_eq!(at(0, 5), 0.0);
        }
        // An inner shape wound against the outer one has turned inside out:
        // it holds nothing, and nothing is taken out.
        let mut cov = Exact.prepare_ring(&poly(&outer), &poly(&rev(&inner)), bx(0, 0, 10, 10));
        let mut out = vec![0.0f32; 12 * 10];
        let mut spans = vec![(0u32, 0u32); 10];
        cov.render(0, 10, &mut out, 12, &mut spans);
        assert_eq!(out[5 * 12 + 5], 1.0);
        // A rasteriser that only fills gets the same ring as one shape.
        struct FillOnly;
        impl Rasterizer for FillOnly {
            fn prepare(&self, polys: &Polys, bx: IBox) -> Box<dyn Coverage> {
                Exact.prepare(polys, bx)
            }
        }
        let mut cov = FillOnly.prepare_ring(&poly(&outer), &poly(&inner), bx(0, 0, 10, 10));
        let mut out = vec![0.0f32; 12 * 10];
        cov.render(0, 10, &mut out, 12, &mut spans);
        assert_eq!(
            (out[5 * 12 + 5], out[5 * 12 + 3], out[2 * 12 + 2]),
            (0.0, 0.5, 1.0)
        );
    }

    #[test]
    fn a_shape_reaching_past_the_box_is_clipped_not_lost() {
        let r = poly(&[(-5.0, -5.0), (3.5, -5.0), (3.5, 50.0), (-5.0, 50.0)]);
        let c = render(&r, bx(0, 0, 6, 4));
        for y in 0..4 {
            assert_eq!(&c[y * 6..y * 6 + 6], &[1.0, 1.0, 1.0, 0.5, 0.0, 0.0]);
        }
        // Entirely to the right, or to the left with nothing closing it.
        let far = poly(&[(20.0, 0.0), (30.0, 0.0), (30.0, 4.0), (20.0, 4.0)]);
        assert!(render(&far, bx(0, 0, 6, 4)).iter().all(|&v| v == 0.0));
    }
}
