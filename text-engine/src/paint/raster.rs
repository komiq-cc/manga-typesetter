//! Coverage: how much of each device pixel a shape covers.
//!
//! This is the one interface the choice of rasteriser sits behind. A
//! [`Rasterizer`] is handed the [`Part`]s of a layer's shape, in device
//! pixels, and returns a [`Coverage`] that the compositor asks for a few rows
//! at a time. Everything above it (shaping, stroking, shading, compositing)
//! is the same whichever rasteriser is in use.
//!
//! The one in use is [`Exact`]: signed-area accumulation, the method of
//! FreeType's smooth rasteriser and of font-rs. Each edge adds, to every
//! pixel it passes through, the exact area of that pixel lying to its right,
//! and a running sum along the row turns those into the integral of the
//! winding number over each pixel. There is no sampling, so there is no
//! sample grid for a thin stem to fall between: a stroke 0.3 px wide covers
//! 0.3 of every pixel it runs through.
//!
//! # Parts, and why a layer is not one shape
//!
//! A layer of a paint (a fill, a band) is the union of one part per glyph.
//! Each part is rasterised on its own and the parts are then united pixel by
//! pixel. Two things are bought with that:
//!
//! - Glyphs cannot undo each other. Summed as one shape, a glyph whose
//!   contours run clockwise cancels a neighbour whose contours run the other
//!   way wherever the two overlap. A part is filled by the non-zero rule by
//!   itself, so which way a font winds its contours does not matter.
//! - Where two glyphs both cover part of a pixel, the sum of their coverage
//!   counts what they share twice. How much they share is estimated from
//!   which way each one's edge faces there (`unite`): nothing for two edges
//!   that face each other (letters side by side: the sum is right), all of
//!   the smaller for two that face the same way (one inside the other), and
//!   `a * b` for two that cross at a right angle (the bands of two letters).
//!   Any one fixed rule is wrong for two of those three; `parity/raster.mjs`
//!   has the measurements of each.
//!
//! # A part that has been moved, and which way is out
//!
//! A band, a synthesised bold and a heavier weight all need a glyph's shape
//! grown, and a band needs it shrunk as well. The stroker can move every
//! contour a distance to its right or to its left; what it cannot know is
//! which of those is outward, because that is a property of the whole glyph
//! (a hole is a contour whose *outside* is ink) and of a font's habits (some
//! wind clockwise, some mix the two between the pieces of one glyph).
//!
//! It does not need to know. Write `R` for the winding number of the
//! contours all moved to their right and `L` for all moved to their left.
//! Along any line, moving right takes each upward crossing one way and each
//! downward crossing the other, so at a point `x`
//!
//! ```text
//! R(x) >= the largest winding number of the glyph within reach of x
//! L(x) <= the smallest
//! ```
//!
//! and therefore, whatever the directions of the contours,
//!
//! ```text
//! grown   = { R > 0 } or { L < 0 }    the non-zero shape, dilated
//! shrunk  = { L > 0 } or { R < 0 }    the part of it further in than the reach
//! ```
//!
//! A glyph wound anticlockwise is grown by its `R` alone and one wound
//! clockwise by its `L`; a glyph that mixes them is grown by each where it
//! applies; and where an inward offset turns inside out (a stem or a hole
//! thinner than the pen) it shows up with the other sign, inside what is
//! grown anyway, which is how a hole thinner than the pen comes out covered.
//! A ring, the band of a stroke, is `grown - shrunk`.
//!
//! What the method gives up: the sums are integrals of the winding number
//! over a pixel, not the area where it is non-zero, so two contours of ONE
//! part that both cover a pixel partly and overlap inside it are counted
//! twice there (and clamped). For text that is a glyph whose own pieces
//! cross, or a fold of a stroke on a curve tighter than the pen.
//! `parity/raster.mjs` measures how much.
//!
//! The other candidates that were measured, tiny-skia's supersampling
//! rasteriser, zeno's and vello_cpu's, are kept behind the `raster-compare`
//! feature so the comparison in P5A-REPORT.md can be run again.

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

/// The whole-pixel box that holds `polys`, or `None` if they hold nothing.
pub fn pixel_box(polys: &Polys) -> Option<IBox> {
    let (x0, y0, x1, y1) = polys.bounds()?;
    // Far outside any surface the guard would accept; also what a
    // non-finite coordinate would fail.
    let limit = 1e9;
    if !(x0 > -limit && y0 > -limit && x1 < limit && y1 < limit) {
        return None;
    }
    let bx = IBox {
        x0: x0.floor() as i32,
        y0: y0.floor() as i32,
        x1: x1.ceil() as i32,
        y1: y1.ceil() as i32,
    };
    (!bx.is_empty()).then_some(bx)
}

/// One part of a layer's shape, in device pixels: one glyph, as it is or
/// moved. A layer covers the union of its parts.
#[derive(Clone, Debug, Default)]
pub struct Part {
    /// The contours moved to their right, or as they are when nothing moves
    /// them.
    pub right: Polys,
    /// The same contours moved the same way to their left. `None` when
    /// nothing was moved: the part is then the contours filled by the
    /// non-zero rule.
    pub left: Option<Polys>,
    /// With `left`: `false` for the shape grown, `true` for the ring between
    /// the shape grown and the shape shrunk (a stroke).
    pub ring: bool,
}

impl Part {
    /// The contours as they are, filled by the non-zero rule.
    pub fn plain(polys: Polys) -> Self {
        Self {
            right: polys,
            left: None,
            ring: false,
        }
    }

    /// The box of pixels the part can touch.
    pub fn pixel_box(&self) -> Option<IBox> {
        let a = pixel_box(&self.right);
        let b = self.left.as_ref().and_then(pixel_box);
        match (a, b) {
            (Some(a), Some(b)) => Some(a.union(&b)),
            (a, b) => a.or(b),
        }
    }

    /// The part as contours for a rasteriser that can only fill one path by
    /// the non-zero rule, appended to `out`. The larger of the two moved
    /// shapes is taken for the grown one, and a ring's inner shape is walked
    /// backwards so that it cuts a hole. Right for a glyph whose contours
    /// all agree on which way is out, which is all the comparison needs.
    pub fn one_shape(&self, out: &mut Polys) {
        let Some(left) = &self.left else {
            out.append(&self.right);
            return;
        };
        let (grown, shrunk) = if self.right.area2().abs() >= left.area2().abs() {
            (&self.right, left)
        } else {
            (left, &self.right)
        };
        out.append(grown);
        if self.ring {
            let mut start = out.pts.len();
            let from = out.ends.len();
            out.append(shrunk);
            for i in from..out.ends.len() {
                let end = out.ends[i];
                out.pts[start..end].reverse();
                start = end;
            }
        }
    }
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
    /// The union of `parts`; only what lies inside `bx` is wanted.
    fn prepare(&self, parts: &[Part], bx: IBox) -> Box<dyn Coverage>;
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
                let (mut xa, mut xb) = if x <= x_end { (x, x_end) } else { (x_end, x) };
                x = x_end;
                let mut d = dy as f32 * e.dir;
                let local = row - row_lo;
                let line = &mut out[local * stride..(local + 1) * stride];
                let span = &mut spans[local];
                // The box cuts the edge, it does not bend it. The stretch of
                // the edge left of the box covers everything to its right,
                // so its share of the row's height goes whole into column 0;
                // the stretch right of the box covers nothing inside. What
                // is left between them is integrated as on a surface without
                // bounds. (Moving the ends to the box instead would change
                // the slope, and with it the coverage of the pixels the edge
                // crosses on its way in.)
                if xb >= wf {
                    // Whatever is open to the left of this edge stays open
                    // as far as the box goes.
                    span.1 = span.1.max(width as u32);
                    if xa >= wf {
                        continue;
                    }
                    d *= ((wf - xa) / (xb - xa)) as f32;
                    xb = wf;
                }
                if xa < 0.0 {
                    span.0 = 0;
                    span.1 = span.1.max(1);
                    if xb <= 0.0 {
                        line[0] += d;
                        continue;
                    }
                    let outside = d * (-xa / (xb - xa)) as f32;
                    line[0] += outside;
                    d -= outside;
                    xa = 0.0;
                }
                let ia = xa.floor() as usize;
                let ib = xb.ceil() as usize;
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

/// One part, ready to be rasterised: its edges, cut to its own box.
struct Piece {
    /// The pixels the part can touch, inside the layer's box.
    bx: IBox,
    right: Edges,
    left: Option<Edges>,
    ring: bool,
}

struct ExactCoverage {
    pieces: Vec<Piece>,
    bx: IBox,
    scratch: Scratch,
    /// One piece's coverage over one strip: a row above, the strip's rows, a
    /// row below, each with a spare column at both ends, so that every pixel
    /// of the strip has its four neighbours.
    cov: Vec<f32>,
    /// The columns of each of those rows that can be non-zero.
    rows: Vec<(u32, u32)>,
    /// Which way the edge runs in each pixel of the layer's strip that one
    /// piece covers partly so far: the slope of that piece's coverage,
    /// across and down. Zero where no piece or more than one has been.
    slope: [Vec<f32>; 2],
}

/// The two running sums of a piece being rasterised, and their spans.
struct Scratch {
    sums: [Vec<f32>; 2],
    spans: [Vec<(u32, u32)>; 2],
}

impl Rasterizer for Exact {
    fn prepare(&self, parts: &[Part], bx: IBox) -> Box<dyn Coverage> {
        let pieces = parts
            .iter()
            .filter_map(|part| {
                let pbx = part.pixel_box()?.intersect(&bx);
                (!pbx.is_empty()).then(|| Piece {
                    bx: pbx,
                    right: Edges::new(&part.right, pbx),
                    left: part.left.as_ref().map(|l| Edges::new(l, pbx)),
                    ring: part.ring,
                })
            })
            .collect();
        Box::new(ExactCoverage {
            pieces,
            bx,
            scratch: Scratch {
                sums: [Vec::new(), Vec::new()],
                spans: [Vec::new(), Vec::new()],
            },
            cov: Vec::new(),
            rows: Vec::new(),
            slope: [Vec::new(), Vec::new()],
        })
    }
}

impl Piece {
    /// The strip of the piece's own rows that its row `row` is in.
    fn strip(&self, row: usize) -> usize {
        (strip_of(self.bx.y0 + row as i32) - strip_of(self.bx.y0)) as usize
    }

    /// The piece's coverage of its rows `row_lo..row_hi`, which lie in one
    /// strip. `dest` holds `width + 2` zeroed values a row, the pixel of
    /// column `x` at `x + 1`; `spans` gets the columns that can be non-zero.
    fn cover(
        &self,
        row_lo: usize,
        row_hi: usize,
        scratch: &mut Scratch,
        dest: &mut [f32],
        spans: &mut [(u32, u32)],
    ) {
        let rows = row_hi - row_lo;
        let width = self.bx.width();
        let stride = width + 2;
        let k = self.strip(row_lo);
        let sides = [Some(&self.right), self.left.as_ref()];
        for (side, edges) in sides.iter().enumerate() {
            let Some(edges) = edges else { continue };
            let (sums, side_spans) = (&mut scratch.sums[side], &mut scratch.spans[side]);
            sums.clear();
            sums.resize(stride * rows, 0.0);
            side_spans.clear();
            side_spans.resize(rows, (u32::MAX, 0));
            edges.accumulate(k, row_lo, row_hi, width, sums, stride, side_spans);
        }
        for r in 0..rows {
            let (mut start, mut end) = scratch.spans[0][r];
            if self.left.is_some() {
                start = start.min(scratch.spans[1][r].0);
                end = end.max(scratch.spans[1][r].1);
            }
            let (start, end) = (start as usize, (end as usize).min(width));
            if start >= end {
                spans[r] = (0, 0);
                continue;
            }
            spans[r] = (start as u32, end as u32);
            let line = &mut dest[r * stride + 1 + start..r * stride + 1 + end];
            let right = &scratch.sums[0][r * stride + start..r * stride + end];
            // A running sum is minus the winding number: a region wound +1
            // in the sense of `area2` has its left edge running up.
            if self.left.is_none() {
                let mut acc = 0.0f32;
                for (cell, &v) in line.iter_mut().zip(right) {
                    acc += v;
                    *cell = acc.abs().min(1.0);
                }
                continue;
            }
            let left = &scratch.sums[1][r * stride + start..r * stride + end];
            let (mut ra, mut la) = (0.0f32, 0.0f32);
            for ((cell, &rv), &lv) in line.iter_mut().zip(right).zip(left) {
                ra += rv;
                la += lv;
                // Grown: the right-moved contours wind positive, or the
                // left-moved ones negative. Shrunk: the other two.
                let grown = (-ra).max(la).max(0.0);
                *cell = if self.ring {
                    // Not clamped before the difference: where two pieces of
                    // one glyph overlap, the grown sum is 2 and the stroke
                    // of the one inside the other stands, as a canvas stroke
                    // of both contours does.
                    let shrunk = (-la).max(ra).max(0.0);
                    (grown - shrunk).clamp(0.0, 1.0)
                } else {
                    grown.min(1.0)
                };
            }
        }
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
        debug_assert!(stride >= self.bx.width() + 2);
        debug_assert_eq!(strip_of(y0), strip_of(y1 - 1));
        let rows = (y1 - y0) as usize;
        for s in spans[..rows].iter_mut() {
            *s = (u32::MAX, 0);
        }
        let Self {
            pieces,
            bx,
            scratch,
            cov,
            rows: cov_rows,
            slope,
        } = self;
        for s in slope.iter_mut() {
            s.clear();
            s.resize(stride * rows, 0.0);
        }
        let [slope_x, slope_y] = slope;
        for piece in pieces.iter() {
            let (py0, py1) = (y0.max(piece.bx.y0), y1.min(piece.bx.y1));
            if py0 >= py1 {
                continue;
            }
            let prows = (py1 - py0) as usize;
            let cs = piece.bx.width() + 2;
            let (row_lo, row_hi) = ((py0 - piece.bx.y0) as usize, (py1 - piece.bx.y0) as usize);
            // The piece's coverage of these rows, and of the row above and
            // the row below them (in the neighbouring strips, or nothing).
            cov.clear();
            cov.resize(cs * (prows + 2), 0.0);
            cov_rows.clear();
            cov_rows.resize(prows + 2, (0, 0));
            if row_lo > 0 {
                piece.cover(
                    row_lo - 1,
                    row_lo,
                    scratch,
                    &mut cov[..cs],
                    &mut cov_rows[..1],
                );
            }
            piece.cover(
                row_lo,
                row_hi,
                scratch,
                &mut cov[cs..cs * (prows + 1)],
                &mut cov_rows[1..prows + 1],
            );
            if row_hi < piece.bx.height() {
                piece.cover(
                    row_hi,
                    row_hi + 1,
                    scratch,
                    &mut cov[cs * (prows + 1)..],
                    &mut cov_rows[prows + 1..],
                );
            }
            // Where this piece's columns start in the layer's rows.
            let dx = (piece.bx.x0 - bx.x0) as usize;
            let first_row = (py0 - y0) as usize;
            for r in 0..prows {
                let (start, end) = (cov_rows[r + 1].0 as usize, cov_rows[r + 1].1 as usize);
                if start >= end {
                    continue;
                }
                let row = first_row + r;
                let span = &mut spans[row];
                *span = (
                    span.0.min((dx + start) as u32),
                    span.1.max((dx + end) as u32),
                );
                let base = (r + 1) * cs + 1;
                for x in start..end {
                    let c = cov[base + x];
                    if c <= 0.0 {
                        continue;
                    }
                    let i = row * stride + dx + x;
                    let o = out[i];
                    if o >= 1.0 {
                        continue;
                    }
                    if c >= 1.0 {
                        out[i] = 1.0;
                        continue;
                    }
                    // The slope of this piece's coverage here: it points
                    // from the piece's edge into the piece.
                    let gx = cov[base + x + 1] - cov[base + x - 1];
                    let gy = cov[base + x + cs] - cov[base + x - cs];
                    if o <= 0.0 {
                        out[i] = c;
                        slope_x[i] = gx;
                        slope_y[i] = gy;
                        continue;
                    }
                    out[i] = unite(o, c, slope_x[i], slope_y[i], gx, gy);
                    // More than one piece is here now: no one direction.
                    slope_x[i] = 0.0;
                    slope_y[i] = 0.0;
                }
            }
        }
        for s in spans[..rows].iter_mut() {
            if s.0 >= s.1 {
                *s = (0, 0);
            }
        }
    }
}

/// The share of a pixel covered by two parts that cover `a` and `b` of it,
/// both partly.
///
/// What the two share cannot be read off `a` and `b`: side by side they
/// share nothing (the union is `a + b`), one inside the other they share the
/// smaller (`max(a, b)`), and two edges crossing at a right angle share
/// `a * b`. Which it is shows in which way each part's edge faces, and that
/// is the slope of its coverage, `(ax, ay)` and `(bx, by)`: two letters
/// standing next to each other face each other, a band inside a wider band
/// faces the same way, and where the bands of two letters cross the edges
/// are across one another. So the shared part is taken between those three
/// by the cosine of the angle between the slopes. A slope of zero (unknown,
/// or more than one part there already) counts as a right angle.
#[inline]
fn unite(a: f32, b: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let norm = ((ax * ax + ay * ay) * (bx * bx + by * by)).sqrt();
    let cos = if norm > 0.0 {
        ((ax * bx + ay * by) / norm).clamp(-1.0, 1.0)
    } else {
        0.0
    };
    let crossed = a * b;
    let shared = if cos < 0.0 {
        crossed + ((a + b - 1.0).max(0.0) - crossed) * -cos
    } else {
        crossed + (a.min(b) - crossed) * cos
    };
    (a + b - shared).min(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::geom::Pt;

    fn render(polys: &Polys, bx: IBox) -> Vec<f32> {
        render_parts(&[Part::plain(polys.clone())], bx)
    }

    fn render_parts(parts: &[Part], bx: IBox) -> Vec<f32> {
        let mut cov = Exact.prepare(parts, bx);
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
    fn a_ring_is_the_shape_grown_less_the_shape_shrunk_whichever_way_it_winds() {
        let outer = [(1.0, 1.0), (9.0, 1.0), (9.0, 9.0), (1.0, 9.0)];
        let inner = [(3.5, 3.0), (7.0, 3.0), (7.0, 7.0), (3.5, 7.0)];
        let rev = |p: &[(f64, f64)]| p.iter().rev().copied().collect::<Vec<_>>();
        let ring = |right: Polys, left: Polys| Part {
            right,
            left: Some(left),
            ring: true,
        };
        // Wound one way the grown loop is the one moved right, wound the
        // other way it is the one moved left; nothing is told which.
        for part in [
            ring(poly(&outer), poly(&inner)),
            ring(poly(&rev(&inner)), poly(&rev(&outer))),
        ] {
            let c = render_parts(core::slice::from_ref(&part), bx(0, 0, 10, 10));
            let at = |x: usize, y: usize| c[y * 10 + x];
            assert_eq!(at(2, 2), 1.0);
            assert_eq!(at(5, 5), 0.0);
            assert_eq!(at(3, 5), 0.5);
            assert_eq!(at(8, 5), 1.0);
            assert_eq!(at(0, 5), 0.0);
            // The same part without the ring is the grown shape, solid.
            let solid = render_parts(
                &[Part {
                    ring: false,
                    ..part.clone()
                }],
                bx(0, 0, 10, 10),
            );
            assert_eq!((solid[5 * 10 + 5], solid[5 * 10 + 3]), (1.0, 1.0));
            // A rasteriser that only fills gets the same ring as one path.
            let mut path = Polys::default();
            part.one_shape(&mut path);
            let c = render(&path, bx(0, 0, 10, 10));
            assert_eq!(
                (c[5 * 10 + 5], c[5 * 10 + 3], c[2 * 10 + 2]),
                (0.0, 0.5, 1.0)
            );
        }
        // An inward loop wound against the outward one has turned inside
        // out: it holds nothing, and nothing is taken out.
        let c = render_parts(&[ring(poly(&outer), poly(&rev(&inner)))], bx(0, 0, 10, 10));
        assert_eq!(c[5 * 10 + 5], 1.0);
    }

    #[test]
    fn two_parts_are_united_whichever_way_each_winds() {
        let square = [(1.0, 1.0), (9.0, 1.0), (9.0, 9.0), (1.0, 9.0)];
        let rev = |p: &[(f64, f64)]| p.iter().rev().copied().collect::<Vec<_>>();
        // The same square twice, wound oppositely. As one shape the two
        // cancel and nothing is painted.
        let two = [Part::plain(poly(&square)), Part::plain(poly(&rev(&square)))];
        let c = render_parts(&two, bx(0, 0, 10, 10));
        assert_eq!((c[5 * 10 + 5], c[10 + 1], c[0]), (1.0, 1.0, 0.0));
        let mut one = poly(&square);
        one.append(&poly(&rev(&square)));
        assert_eq!(render(&one, bx(0, 0, 10, 10))[5 * 10 + 5], 0.0);
        // Overlapping by half, one each way: all of both is covered.
        let shifted: Vec<(f64, f64)> = square.iter().map(|&(x, y)| (x + 4.0, y)).collect();
        let two = [
            Part::plain(poly(&square)),
            Part::plain(poly(&rev(&shifted))),
        ];
        let c = render_parts(&two, bx(0, 0, 14, 10));
        for x in 1..13 {
            assert_eq!(c[5 * 14 + x], 1.0, "column {x}");
        }
    }

    #[test]
    fn parts_that_cross_inside_a_pixel_are_not_counted_twice() {
        // The left half of pixel (2, 2) and its top half: three quarters of
        // it between them, where their coverages add up to the whole.
        let a = poly(&[(0.0, 0.0), (2.5, 0.0), (2.5, 5.0), (0.0, 5.0)]);
        let b = poly(&[(0.0, 0.0), (5.0, 0.0), (5.0, 2.5), (0.0, 2.5)]);
        let c = render_parts(&[Part::plain(a), Part::plain(b)], bx(0, 0, 5, 5));
        assert_eq!(c[2 * 5 + 2], 0.75);
        assert_eq!((c[2 * 5 + 1], c[5 + 2], c[3 * 5 + 3]), (1.0, 1.0, 0.0));
    }

    #[test]
    fn what_two_parts_share_in_a_pixel_goes_by_which_way_their_edges_face() {
        let rect = |x0: f64, x1: f64| poly(&[(x0, 0.0), (x1, 0.0), (x1, 5.0), (x0, 5.0)]);
        let two = |a: Polys, b: Polys| {
            render_parts(&[Part::plain(a), Part::plain(b)], bx(0, 0, 6, 5))[2 * 6 + 2]
        };
        // Side by side, 0.2 px apart inside pixel 2: they share nothing, and
        // the gap between them stays open.
        assert!((two(rect(0.0, 2.3), rect(2.5, 6.0)) - 0.8).abs() < 1e-6);
        // Side by side and overlapping by 0.1 px: the pixel is full.
        assert_eq!(two(rect(0.0, 2.6), rect(2.5, 6.0)), 1.0);
        // One inside the other, both ending in pixel 2: the larger of them.
        assert!((two(rect(0.0, 2.3), rect(0.0, 2.6)) - 0.6).abs() < 1e-6);
        assert!((two(rect(1.0, 2.6), rect(0.0, 2.3)) - 0.6).abs() < 1e-6);
    }

    #[test]
    fn a_glyph_of_two_pieces_wound_oppositely_is_grown_at_both() {
        use crate::paint::stroke::{grow, Join, Side};
        // Two squares apart from each other, one each way round: by the
        // non-zero rule both are ink. One total area would call the same
        // side "out" for both and shrink one of them.
        let mut glyph = poly(&[(4.0, 4.0), (10.0, 4.0), (10.0, 10.0), (4.0, 10.0)]);
        glyph.append(&poly(&[
            (20.0, 4.0),
            (20.0, 10.0),
            (26.0, 10.0),
            (26.0, 4.0),
        ]));
        let moved = |side| {
            let mut out = Polys::default();
            grow(&glyph, 2.0, side, Join::Round, 1e-3, &mut out);
            out
        };
        let part = |ring| Part {
            right: moved(Side::Right),
            left: Some(moved(Side::Left)),
            ring,
        };
        let solid = render_parts(&[part(false)], bx(0, 0, 30, 14));
        let ring = render_parts(&[part(true)], bx(0, 0, 30, 14));
        for x0 in [4usize, 20] {
            // Grown by 2 to the left, the right, above and below.
            for (x, y) in [(x0 - 2, 7), (x0 + 7, 7), (x0 + 3, 2), (x0 + 3, 11)] {
                assert!(solid[y * 30 + x] > 0.9999, "solid at ({x},{y})");
                assert!(ring[y * 30 + x] > 0.9999, "ring at ({x},{y})");
            }
            assert_eq!(solid[7 * 30 + x0 - 3], 0.0);
            // The middle of each square: filled, and further than the pen
            // from any edge, so not in the ring.
            assert_eq!(solid[7 * 30 + x0 + 3], 1.0);
            assert_eq!(ring[7 * 30 + x0 + 2], 0.0);
            assert_eq!(ring[7 * 30 + x0 + 1], 1.0);
        }
    }

    #[test]
    fn a_band_covers_a_hole_thinner_than_its_pen() {
        use crate::paint::stroke::{grow, Join, Side};
        // A block with a slit 1.5 wide through it and a sliver of a
        // triangle beside that, both wound against it: true holes. A pen of
        // radius 2 strokes each from both of its sides, as a canvas does, so
        // nothing of either is left open; the inward loop of each has
        // turned inside out.
        for reversed in [false, true] {
            let mut glyph = poly(&[(4.0, 4.0), (30.0, 4.0), (30.0, 24.0), (4.0, 24.0)]);
            glyph.append(&poly(&[
                (10.0, 8.0),
                (10.0, 20.0),
                (11.5, 20.0),
                (11.5, 8.0),
            ]));
            glyph.append(&poly(&[(20.0, 8.0), (20.5, 20.0), (22.0, 8.0)]));
            if reversed {
                glyph.pts.reverse();
                let n = glyph.pts.len();
                glyph.ends = glyph.ends.iter().rev().skip(1).map(|e| n - e).collect();
                glyph.ends.push(n);
            }
            let plain = render(&glyph, bx(0, 0, 34, 28));
            assert_eq!((plain[14 * 34 + 10], plain[14 * 34 + 11]), (0.0, 0.5));
            assert!(plain[9 * 34 + 20] < 0.1);
            let moved = |side| {
                let mut out = Polys::default();
                grow(&glyph, 2.0, side, Join::Round, 1e-3, &mut out);
                out
            };
            let band = render_parts(
                &[Part {
                    right: moved(Side::Right),
                    left: Some(moved(Side::Left)),
                    ring: true,
                }],
                bx(0, 0, 34, 28),
            );
            for y in 7..21 {
                for x in 9..13 {
                    assert!(band[y * 34 + x] > 0.9999, "slit, ({x},{y})");
                }
            }
            for (x, y) in [(20, 8), (21, 9), (20, 14), (20, 19), (21, 12)] {
                assert!(band[y * 34 + x] > 0.9999, "triangle, ({x},{y})");
            }
            // Far from every edge the band is not.
            assert_eq!(band[14 * 34 + 26], 0.0);
            assert_eq!(band[14 * 34 + 16], 0.0);
        }
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

    #[test]
    fn an_edge_that_crosses_the_box_is_cut_by_it_and_not_bent() {
        // A slanted bar that enters by the left side of the box and leaves
        // by the right, crossing several columns in a row. Painted on a box
        // that holds all of it and on one that cuts it, the pixels both
        // boxes have must be the same: the cut is not a clamp of the edge's
        // ends, which would change its slope where it comes in.
        let bar = poly(&[(-7.3, 2.2), (-3.1, 1.4), (23.6, 17.9), (19.2, 19.3)]);
        let whole = render(&bar, bx(-8, 0, 24, 20));
        let cut = render(&bar, bx(0, 0, 12, 20));
        let mut worst = 0.0f32;
        for y in 0..20 {
            for x in 0..12 {
                let (a, b) = (whole[y * 32 + x + 8], cut[y * 12 + x]);
                worst = worst.max((a - b).abs());
            }
        }
        assert!(worst < 1e-5, "{worst}");
        // And something of it is in the columns at both sides.
        assert!((0..20).any(|y| cut[y * 12] > 0.0 && cut[y * 12] < 1.0));
        assert!((0..20).any(|y| cut[y * 12 + 11] > 0.0 && cut[y * 12 + 11] < 1.0));
    }
}
