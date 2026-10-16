//! A surface of premultiplied pixels, and the passes that are laid over a
//! finished picture: a gaussian blur, a move by a fraction of a pixel, and a
//! weighted sum of moved copies.
//!
//! The canvas did these (`ctx.filter = blur()`, `drawImage` at an offset,
//! `globalCompositeOperation = 'lighter'`), and each browser does them its
//! own way. Here they are arithmetic, the same on every machine.
//!
//! The pixels are premultiplied RGBA8, as a canvas holds them: a pass over
//! premultiplied colour does not drag the colour of a clear pixel into its
//! neighbours. Each pass computes in `f32` and rounds once on the way out.

use super::budget;
use super::geom::IBox;
use crate::Error;

/// A surface: `width * height` premultiplied RGBA8 pixels, row by row.
pub(crate) struct Surface {
    pub width: usize,
    pub height: usize,
    pub data: budget::Buffer<u8>,
}

impl Surface {
    pub(crate) fn new(width: usize, height: usize) -> Result<Self, Error> {
        let len = width
            .checked_mul(height)
            .and_then(|n| n.checked_mul(4))
            .ok_or(Error::BadSpec)?;
        Ok(Self {
            width,
            height,
            data: budget::filled(len, 0u8)?,
        })
    }

    pub(crate) fn clear(&mut self) {
        self.data.fill(0);
    }

    /// The box of pixels with any alpha, or `None` for a clear surface.
    pub(crate) fn ink(&self) -> Option<IBox> {
        let (w, h) = (self.width, self.height);
        let row_has = |y: usize| self.data[y * w * 4..(y + 1) * w * 4].chunks_exact(4).any(|p| p[3] != 0);
        let y0 = (0..h).find(|&y| row_has(y))?;
        let y1 = (y0..h).rev().find(|&y| row_has(y))? + 1;
        let (mut x0, mut x1) = (w, 0);
        for y in y0..y1 {
            let row = &self.data[y * w * 4..(y + 1) * w * 4];
            if let Some(a) = row.chunks_exact(4).position(|p| p[3] != 0) {
                x0 = x0.min(a);
                let b = row.chunks_exact(4).rposition(|p| p[3] != 0).unwrap_or(a);
                x1 = x1.max(b + 1);
            }
        }
        Some(IBox {
            x0: x0 as i32,
            y0: y0 as i32,
            x1: x1 as i32,
            y1: y1 as i32,
        })
    }

    fn bounds(&self) -> IBox {
        IBox {
            x0: 0,
            y0: 0,
            x1: self.width as i32,
            y1: self.height as i32,
        }
    }

    /// `bx` grown by `by` pixels on every side, cut to the surface.
    fn grown(&self, bx: IBox, by: i32) -> IBox {
        IBox {
            x0: bx.x0.saturating_sub(by),
            y0: bx.y0.saturating_sub(by),
            x1: bx.x1.saturating_add(by),
            y1: bx.y1.saturating_add(by),
        }
        .intersect(&self.bounds())
    }

    /// Straight RGBA8 pixels, `width` to the row, laid source-over with
    /// their corner at `(x, y)`. What falls outside the surface is cut.
    pub(crate) fn draw(&mut self, pixels: &[u8], width: usize, x: i32, y: i32) {
        if width == 0 {
            return;
        }
        let height = pixels.len() / (width * 4);
        let src = IBox {
            x0: x,
            y0: y,
            x1: x.saturating_add(width as i32),
            y1: y.saturating_add(height as i32),
        };
        let bx = src.intersect(&self.bounds());
        if bx.is_empty() {
            return;
        }
        for dy in bx.y0..bx.y1 {
            let from = ((dy - y) as usize * width + (bx.x0 - x) as usize) * 4;
            let to = (dy as usize * self.width + bx.x0 as usize) * 4;
            let n = bx.width() * 4;
            let rows = pixels[from..from + n]
                .chunks_exact(4)
                .zip(self.data[to..to + n].chunks_exact_mut(4));
            for (s, d) in rows {
                let a = u32::from(s[3]);
                if a == 0 {
                    continue;
                }
                let keep = 255 - a;
                for c in 0..3 {
                    d[c] = (div255(u32::from(s[c]) * a) + div255(u32::from(d[c]) * keep)) as u8;
                }
                d[3] = (a + div255(u32::from(d[3]) * keep)) as u8;
            }
        }
    }

    /// The surface as straight RGBA8, cut to `bx`.
    pub(crate) fn straight(&self, bx: IBox) -> Result<Vec<u8>, Error> {
        let bx = bx.intersect(&self.bounds());
        let mut out = budget::filled(bx.width() * bx.height() * 4, 0u8)?;
        for (row, y) in (bx.y0..bx.y1).enumerate() {
            let from = (y as usize * self.width + bx.x0 as usize) * 4;
            let n = bx.width() * 4;
            let pairs = self.data[from..from + n]
                .chunks_exact(4)
                .zip(out[row * n..(row + 1) * n].chunks_exact_mut(4));
            for (s, d) in pairs {
                let a = u32::from(s[3]);
                if a == 0 {
                    continue;
                }
                if a == 255 {
                    d.copy_from_slice(s);
                    continue;
                }
                for c in 0..3 {
                    d[c] = ((u32::from(s[c]) * 255 + a / 2) / a).min(255) as u8;
                }
                d[3] = s[3];
            }
        }
        Ok(out.into_vec())
    }
}

/// `v / 255`, rounded, for `v` up to `255 * 255`.
fn div255(v: u32) -> u32 {
    (v + 127) / 255
}

fn to_u8(v: f32) -> u8 {
    // A NaN is 0, and anything past the ends is the end.
    (v + 0.5).clamp(0.0, 255.0) as u8
}

// ---- the gaussian ----

/// A gaussian under this sigma, in pixels, is the kernel itself; from here
/// up it is three box blurs, which keeps a wide blur at a few operations a
/// pixel however wide it is.
const BOX_FROM_SIGMA: f64 = 2.0;

/// How many boxes stand for a gaussian.
const BOXES: f64 = 3.0;

/// The box three of which have the variance of a gaussian of `sigma`: `r`
/// whole pixels each side of the centre, and a share `edge` of the pixel
/// beyond each end (Gwosdek et al., "Theoretical foundations of gaussian
/// convolution by extended box filtering"). A box of whole pixels can only
/// have some variances, and three of them miss a small sigma by a tenth of
/// it; the share at the ends makes the variance exact for every sigma, so a
/// blur grows evenly as its number does.
fn extended_box(sigma: f64) -> (usize, f32) {
    let v = sigma * sigma / BOXES;
    let r = (((12.0 * v + 1.0).sqrt() - 1.0) / 2.0).floor().clamp(0.0, 65536.0);
    let edge = (2.0 * r + 1.0) * (r * (r + 1.0) - 3.0 * v) / (6.0 * (v - (r + 1.0) * (r + 1.0)));
    (r as usize, edge.clamp(0.0, 1.0) as f32)
}

/// How far a gaussian of `sigma` reaches, in whole pixels: what the passes
/// below can move ink by.
pub(crate) fn blur_reach(sigma: f64) -> i32 {
    if !(sigma > 0.0) {
        return 0;
    }
    let reach = if sigma < BOX_FROM_SIGMA {
        (sigma * 3.0).ceil()
    } else {
        BOXES * (extended_box(sigma).0 as f64 + 1.0)
    };
    reach.min(f64::from(i32::MAX / 4)) as i32
}

// The passes work in whole numbers: a value is a channel of 0 to 255 with
// eight more bits below the point, so three boxes one after another lose
// nothing a level could show, and a running sum is exact - it cannot drift,
// and it does not wait on the last addition the way a sum of floats does.

/// Bits below the point in a value.
const FRAC: u32 = 8;
/// A box divides by its width; it multiplies by `2^INV_BITS` over it.
const INV_BITS: u32 = 40;
/// A kernel's weights add up to `2^WEIGHT_BITS`.
const WEIGHT_BITS: u32 = 16;
/// Columns are blurred this many at a time, so a tall plane is read in
/// pieces that stay in the cache.
const STRIP: usize = 64;

/// One pass along a line of values: a box, or a kernel.
enum Pass {
    /// The mean of the value, `r` values each side of it, and the share
    /// `edge` (of `1 << FRAC`) of the one beyond each end; `inv` is
    /// `2^INV_BITS` over the width of all that.
    Box { r: usize, edge: u64, inv: u64 },
    /// The weights from the centre out; the kernel is symmetric.
    Kernel(budget::Buffer<u64>),
}

fn passes(sigma: f64) -> Result<budget::Buffer<Pass>, Error> {
    let mut out = budget::Buffer::new();
    if sigma < BOX_FROM_SIGMA {
        let radius = (sigma * 3.0).ceil() as usize;
        let mut half = budget::filled(radius + 1, 0u64)?;
        let weight = |i: usize| {
            let x = i as f64 / sigma;
            (-0.5 * x * x).exp()
        };
        let sum: f64 = (0..=radius).map(|i| weight(i) * if i == 0 { 1.0 } else { 2.0 }).sum();
        let one = 1u64 << WEIGHT_BITS;
        let mut rest = 0;
        for (i, w) in half.iter_mut().enumerate().skip(1) {
            *w = (weight(i) / sum * one as f64).round() as u64;
            rest += 2 * *w;
        }
        // The centre takes what the rounding left, so the weights are one
        // whole and a flat patch stays the value it was.
        half[0] = one.saturating_sub(rest);
        budget::push(&mut out, Pass::Kernel(half))?;
        return Ok(out);
    }
    let (r, edge) = extended_box(sigma);
    let edge = (f64::from(edge) * f64::from(1u32 << FRAC)).round() as u64;
    let width = (((2 * r + 1) as u64) << FRAC) + 2 * edge;
    let inv = ((1u64 << INV_BITS) + width / 2) / width;
    for _ in 0..BOXES as usize {
        budget::push(&mut out, Pass::Box { r, edge, inv })?;
    }
    Ok(out)
}

impl Pass {
    /// How many values past each end of a line the pass reads.
    fn pad(&self) -> usize {
        match self {
            Pass::Box { r, .. } => r + 1,
            Pass::Kernel(half) => half.len() - 1,
        }
    }
}

/// What a box makes of a running sum and the two values beyond its ends.
#[inline(always)]
fn boxed(sum: u64, beyond: u64, edge: u64, inv: u64) -> u16 {
    ((((sum << FRAC) + edge * beyond) * inv + (1 << (INV_BITS - 1))) >> INV_BITS) as u16
}

/// A line of pixels, `N` channels each, through one pass. `padded` is the
/// line with `pad` clear pixels before it and after it, `pad` at least the
/// pass's own; `out` is the line alone. Outside the line is clear, which
/// the padding says without a test in the loop.
fn along<const N: usize>(pass: &Pass, padded: &[u16], pad: usize, out: &mut [u16]) {
    match pass {
        Pass::Box { r, edge, inv } => {
            let (r, edge, inv) = (*r, *edge, *inv);
            // `p` starts `r + 1` pixels before the line. The window over
            // pixel `i` is `i - r ..= i + r`, kept as a running sum.
            let p = &padded[(pad - (r + 1)) * N..];
            let mut sum = [0u64; N];
            for px in p[N..(2 * r + 1) * N].chunks_exact(N) {
                for c in 0..N {
                    sum[c] += u64::from(px[c]);
                }
            }
            let pixels = out
                .chunks_exact_mut(N)
                .zip(p.chunks_exact(N))
                .zip(p[N..].chunks_exact(N))
                .zip(p[(2 * r + 1) * N..].chunks_exact(N))
                .zip(p[(2 * r + 2) * N..].chunks_exact(N));
            for ((((o, before), leaves), enters), after) in pixels {
                for c in 0..N {
                    let s = sum[c] + u64::from(enters[c]);
                    o[c] = boxed(s, u64::from(before[c]) + u64::from(after[c]), edge, inv);
                    sum[c] = s - u64::from(leaves[c]);
                }
            }
        }
        Pass::Kernel(half) => {
            let r = half.len() - 1;
            let p = &padded[(pad - r) * N..];
            for (i, o) in out.chunks_exact_mut(N).enumerate() {
                for c in 0..N {
                    let mut v = u64::from(p[(i + r) * N + c]) * half[0];
                    for k in 1..=r {
                        let pair = u64::from(p[(i + r - k) * N + c]) + u64::from(p[(i + r + k) * N + c]);
                        v += pair * half[k];
                    }
                    o[c] = ((v + (1 << (WEIGHT_BITS - 1))) >> WEIGHT_BITS) as u16;
                }
            }
        }
    }
}

/// Every column of a strip through one pass, a row at a time. `src` and
/// `dst` are rows of `stride` values of which `used` count, `h` rows with
/// `pad` clear rows above and below; `sum` is one row of running sums.
/// Going down the rows and not down each column keeps the pass in step
/// with the memory.
fn down(pass: &Pass, src: &[u16], dst: &mut [u16], (stride, used): (usize, usize), pad: usize, h: usize, sum: &mut [u64]) {
    let row = |y: usize| &src[y * stride..y * stride + used];
    let sum = &mut sum[..used];
    match pass {
        Pass::Box { r, edge, inv } => {
            let (r, edge, inv) = (*r, *edge, *inv);
            // Row `top` is `r + 1` rows above the first.
            let top = pad - (r + 1);
            sum.fill(0);
            for k in 1..=2 * r {
                for (s, v) in sum.iter_mut().zip(row(top + k)) {
                    *s += u64::from(*v);
                }
            }
            for y in 0..h {
                let values = dst[(pad + y) * stride..(pad + y) * stride + used]
                    .iter_mut()
                    .zip(sum.iter_mut())
                    .zip(row(top + y))
                    .zip(row(top + y + 1))
                    .zip(row(top + y + 2 * r + 1))
                    .zip(row(top + y + 2 * r + 2));
                for (((((o, sum), before), leaves), enters), after) in values {
                    let s = *sum + u64::from(*enters);
                    *o = boxed(s, u64::from(*before) + u64::from(*after), edge, inv);
                    *sum = s - u64::from(*leaves);
                }
            }
        }
        Pass::Kernel(half) => {
            let r = half.len() - 1;
            let top = pad - r;
            for y in 0..h {
                for (s, v) in sum.iter_mut().zip(row(top + y + r)) {
                    *s = u64::from(*v) * half[0];
                }
                for k in 1..=r {
                    let pairs = sum.iter_mut().zip(row(top + y + r - k)).zip(row(top + y + r + k));
                    for ((s, above), below) in pairs {
                        *s += (u64::from(*above) + u64::from(*below)) * half[k];
                    }
                }
                let out = &mut dst[(pad + y) * stride..(pad + y) * stride + used];
                for (o, s) in out.iter_mut().zip(sum.iter()) {
                    *o = ((*s + (1 << (WEIGHT_BITS - 1))) >> WEIGHT_BITS) as u16;
                }
            }
        }
    }
}

/// Blurs `N` channels of every pixel of `bx`, from channel `first` on.
fn blur_channels<const N: usize>(s: &mut Surface, bx: IBox, passes: &[Pass], first: usize) -> Result<(), Error> {
    let (w, h) = (bx.width(), bx.height());
    let pad = passes.iter().map(Pass::pad).max().unwrap_or(0);
    let corner = |y: usize| ((bx.y0 as usize + y) * s.width + bx.x0 as usize) * 4;
    // What the rows made, kept whole for the columns: a plane of values.
    let mut plane = budget::filled(w * h * N, 0u16)?;
    {
        let mut a = budget::filled((w + 2 * pad) * N, 0u16)?;
        let mut b = budget::filled((w + 2 * pad) * N, 0u16)?;
        let line = pad * N..(pad + w) * N;
        for y in 0..h {
            let src = &s.data[corner(y)..corner(y) + w * 4];
            for (v, p) in a[line.clone()].chunks_exact_mut(N).zip(src.chunks_exact(4)) {
                for c in 0..N {
                    v[c] = u16::from(p[first + c]) << FRAC;
                }
            }
            for pass in passes {
                along::<N>(pass, &a, pad, &mut b[line.clone()]);
                core::mem::swap(&mut a, &mut b);
            }
            plane[y * w * N..(y + 1) * w * N].copy_from_slice(&a[line.clone()]);
            if y % 64 == 0 {
                budget::check()?;
            }
        }
    }
    let stride = STRIP.min(w) * N;
    let mut a = budget::filled((h + 2 * pad) * stride, 0u16)?;
    let mut b = budget::filled((h + 2 * pad) * stride, 0u16)?;
    let mut sum = budget::filled(stride, 0u64)?;
    for x0 in (0..w).step_by(STRIP) {
        let used = STRIP.min(w - x0) * N;
        for y in 0..h {
            a[(pad + y) * stride..(pad + y) * stride + used]
                .copy_from_slice(&plane[(y * w + x0) * N..(y * w + x0) * N + used]);
        }
        for pass in passes {
            down(pass, &a, &mut b, (stride, used), pad, h, &mut sum);
            core::mem::swap(&mut a, &mut b);
        }
        for y in 0..h {
            let to = corner(y) + x0 * 4;
            let values = a[(pad + y) * stride..(pad + y) * stride + used].chunks_exact(N);
            for (p, v) in s.data[to..to + used / N * 4].chunks_exact_mut(4).zip(values) {
                for c in 0..N {
                    p[first + c] = ((u32::from(v[c]) + (1 << (FRAC - 1))) >> FRAC).min(255) as u8;
                }
            }
        }
        budget::check()?;
    }
    Ok(())
}

/// Blurs the surface by a gaussian of `sigma` pixels. Only the rows and
/// columns the ink can reach are touched.
pub(crate) fn gaussian(s: &mut Surface, sigma: f64) -> Result<(), Error> {
    blurred(s, sigma, None)
}

/// [`gaussian`] for a surface that holds one colour at varying alpha, which
/// a shadow's silhouette is: `rgb` is that colour, straight. Only the alpha
/// is blurred and the colour is laid back under it, a quarter of the work
/// for the same picture.
pub(crate) fn gaussian_flat(s: &mut Surface, sigma: f64, rgb: [u8; 3]) -> Result<(), Error> {
    blurred(s, sigma, Some(rgb))
}

fn blurred(s: &mut Surface, sigma: f64, flat: Option<[u8; 3]>) -> Result<(), Error> {
    if !(sigma > 0.0) {
        return Ok(());
    }
    let Some(ink) = s.ink() else {
        return Ok(());
    };
    let bx = s.grown(ink, blur_reach(sigma));
    let w = bx.width();
    if w == 0 || bx.height() == 0 {
        return Ok(());
    }
    let passes = passes(sigma)?;
    match flat {
        Some(_) => blur_channels::<1>(s, bx, &passes, 3)?,
        None => blur_channels::<4>(s, bx, &passes, 0)?,
    }
    for y in bx.y0 as usize..bx.y1 as usize {
        let from = (y * s.width + bx.x0 as usize) * 4;
        for p in s.data[from..from + w * 4].chunks_exact_mut(4) {
            let a = p[3];
            match flat {
                // The one colour, under the alpha it has now.
                Some(rgb) => {
                    for c in 0..3 {
                        p[c] = div255(u32::from(rgb[c]) * u32::from(a)) as u8;
                    }
                }
                // Rounding each channel on its own can leave a colour a
                // level above its alpha, which is no colour: premultiplied
                // channels never pass it.
                None => {
                    p[0] = p[0].min(a);
                    p[1] = p[1].min(a);
                    p[2] = p[2].min(a);
                }
            }
        }
    }
    Ok(())
}

// ---- moved copies ----

/// One copy of a picture in a sum of them: moved by `(dx, dy)` pixels and
/// scaled by `weight`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Moved {
    pub dx: f64,
    pub dy: f64,
    pub weight: f64,
}

/// The four source pixels a moved copy reads for each pixel it writes, and
/// how much of each: the pixel `(ix, iy)` further back, its right-hand and
/// lower neighbours, and the one diagonal to it. A move by whole pixels
/// reads one.
struct Taps {
    ix: i64,
    iy: i64,
    k: [f32; 4],
}

impl Taps {
    fn new(m: &Moved) -> Self {
        // The pixel at `x` shows the source at `x - dx`.
        let (sx, sy) = (-m.dx, -m.dy);
        let (fx, fy) = (sx.floor(), sy.floor());
        let (tx, ty) = ((sx - fx) as f32, (sy - fy) as f32);
        let w = m.weight as f32;
        Self {
            ix: fx as i64,
            iy: fy as i64,
            k: [
                (1.0 - tx) * (1.0 - ty) * w,
                tx * (1.0 - ty) * w,
                (1.0 - tx) * ty * w,
                tx * ty * w,
            ],
        }
    }
}

/// Adds to `acc`, which is one row of premultiplied pixels as `f32`, the row
/// `y` of `src` seen through one move: only the columns `x0..x1`, and only
/// from inside `ink`, outside which `src` is clear.
fn add_row(acc: &mut [f32], src: &Surface, ink: IBox, y: i64, (x0, x1): (usize, usize), t: &Taps) {
    let w = src.width as i64;
    for (row, k) in [(y + t.iy, [t.k[0], t.k[1]]), (y + t.iy + 1, [t.k[2], t.k[3]])] {
        if row < i64::from(ink.y0) || row >= i64::from(ink.y1) || (k[0] == 0.0 && k[1] == 0.0) {
            continue;
        }
        let line = &src.data[(row * w * 4) as usize..((row + 1) * w * 4) as usize];
        for (shift, k) in [(t.ix, k[0]), (t.ix + 1, k[1])] {
            if k == 0.0 {
                continue;
            }
            // Destination columns whose source column `x + shift` has ink.
            let a = (i64::from(ink.x0) - shift).max(x0 as i64);
            let b = (i64::from(ink.x1) - shift).min(x1 as i64);
            if a >= b {
                continue;
            }
            let (a, b) = (a as usize, b as usize);
            let from = (a as i64 + shift) as usize;
            let s = &line[from * 4..(from + b - a) * 4];
            for (d, s) in acc[a * 4..b * 4].iter_mut().zip(s) {
                *d += f32::from(*s) * k;
            }
        }
    }
}

/// How far `moves` can carry ink, in whole pixels.
fn reach(moves: &[Moved]) -> i32 {
    let far = moves
        .iter()
        .map(|m| m.dx.abs().max(m.dy.abs()))
        .fold(0.0, f64::max);
    (far.ceil() + 1.0).min(f64::from(i32::MAX / 4)) as i32
}

/// The sum of `src` seen through each of `moves`, added and clamped: canvas
/// `lighter`, a copy at a time. `src` is replaced by it.
pub(crate) fn sum_moved(src: &mut Surface, moves: &[Moved]) -> Result<(), Error> {
    let Some(ink) = src.ink() else {
        return Ok(());
    };
    let bx = src.grown(ink, reach(moves));
    let mut out = budget::filled(bx.width() * bx.height() * 4, 0u8)?;
    let mut acc = budget::filled(src.width * 4, 0.0f32)?;
    let mut taps = budget::Buffer::new();
    for m in moves {
        budget::push(&mut taps, Taps::new(m))?;
    }
    let (x0, x1) = (bx.x0 as usize, bx.x1 as usize);
    let n = bx.width() * 4;
    for (row, y) in (bx.y0..bx.y1).enumerate() {
        acc[x0 * 4..x1 * 4].fill(0.0);
        for t in taps.iter() {
            add_row(&mut acc, src, ink, i64::from(y), (x0, x1), t);
        }
        for (d, v) in out[row * n..(row + 1) * n].iter_mut().zip(&acc[x0 * 4..x1 * 4]) {
            *d = to_u8(*v);
        }
        if row % 64 == 0 {
            budget::check()?;
        }
    }
    // The picture is what was summed and nothing else: clear what it was.
    for y in ink.y0 as usize..ink.y1 as usize {
        let from = (y * src.width + ink.x0 as usize) * 4;
        src.data[from..from + ink.width() * 4].fill(0);
    }
    for (row, y) in (bx.y0 as usize..bx.y1 as usize).enumerate() {
        let to = (y * src.width + x0) * 4;
        src.data[to..to + n].copy_from_slice(&out[row * n..(row + 1) * n]);
    }
    Ok(())
}

/// `layer` moved by `(dx, dy)` pixels, laid source-over on `dst` at
/// `opacity`. The two are the same size.
pub(crate) fn over_moved(
    dst: &mut Surface,
    layer: &Surface,
    (dx, dy): (f64, f64),
    opacity: f64,
) -> Result<(), Error> {
    let Some(ink) = layer.ink() else {
        return Ok(());
    };
    let m = Moved {
        dx,
        dy,
        weight: opacity.clamp(0.0, 1.0),
    };
    let bx = dst.grown(ink, 0).union_moved(&m).intersect(&dst.bounds());
    if bx.is_empty() {
        return Ok(());
    }
    let t = Taps::new(&m);
    let mut acc = budget::filled(dst.width * 4, 0.0f32)?;
    let (x0, x1) = (bx.x0 as usize, bx.x1 as usize);
    for y in bx.y0..bx.y1 {
        acc[x0 * 4..x1 * 4].fill(0.0);
        add_row(&mut acc, layer, ink, i64::from(y), (x0, x1), &t);
        let to = (y as usize * dst.width + x0) * 4;
        let pairs = dst.data[to..to + (x1 - x0) * 4]
            .chunks_exact_mut(4)
            .zip(acc[x0 * 4..x1 * 4].chunks_exact(4));
        for (d, s) in pairs {
            if s[3] <= 0.0 {
                continue;
            }
            let keep = 1.0 - s[3] / 255.0;
            for c in 0..4 {
                d[c] = to_u8(s[c] + f32::from(d[c]) * keep);
            }
        }
    }
    Ok(())
}

impl IBox {
    /// The box, and where a move carries it: both, as one box.
    fn union_moved(&self, m: &Moved) -> IBox {
        let far = |v: f64, lo: bool| {
            let v = if lo { v.floor() } else { v.ceil() };
            v.clamp(-1e9, 1e9) as i32
        };
        IBox {
            x0: self.x0.saturating_add(far(m.dx, true).min(0)),
            y0: self.y0.saturating_add(far(m.dy, true).min(0)),
            x1: self.x1.saturating_add(far(m.dx, false).max(0) + 1),
            y1: self.y1.saturating_add(far(m.dy, false).max(0) + 1),
        }
    }
}

/// Scales every pixel of `s` by the alpha of `mask` (straight RGBA8 covering
/// `bx`), or by what is left of it when `keep_outside`. Where the mask does
/// not reach it is clear: nothing kept, or everything.
pub(crate) fn mask(s: &mut Surface, mask: &[u8], bx: IBox, keep_outside: bool) {
    let (w, h) = (s.width, s.height);
    for y in 0..h {
        let row = &mut s.data[y * w * 4..(y + 1) * w * 4];
        let inside = (y as i32) >= bx.y0 && (y as i32) < bx.y1;
        for (x, p) in row.chunks_exact_mut(4).enumerate() {
            if p[3] == 0 {
                continue;
            }
            let m = if inside && (x as i32) >= bx.x0 && (x as i32) < bx.x1 {
                let i = ((y as i32 - bx.y0) as usize * bx.width() + (x as i32 - bx.x0) as usize) * 4 + 3;
                u32::from(mask.get(i).copied().unwrap_or(0))
            } else {
                0
            };
            let k = if keep_outside { 255 - m } else { m };
            if k == 255 {
                continue;
            }
            for c in p.iter_mut() {
                *c = div255(u32::from(*c) * k) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dot(w: usize, h: usize, x: usize, y: usize) -> Surface {
        let mut s = Surface::new(w, h).unwrap();
        s.data[(y * w + x) * 4..(y * w + x) * 4 + 4].copy_from_slice(&[255, 0, 0, 255]);
        s
    }

    fn alpha_sum(s: &Surface) -> u64 {
        s.data.chunks_exact(4).map(|p| u64::from(p[3])).sum()
    }

    #[test]
    fn a_blur_keeps_the_ink_it_spreads() {
        for sigma in [0.6, 1.5, 1.99, 2.0, 2.01, 3.0, 6.3, 12.0] {
            let _scope = budget::Scope::new();
            let mut s = Surface::new(200, 200).unwrap();
            for y in 90..110 {
                for x in 80..120 {
                    s.data[(y * 200 + x) * 4..(y * 200 + x) * 4 + 4].copy_from_slice(&[0, 0, 255, 255]);
                }
            }
            let before = alpha_sum(&s);
            gaussian(&mut s, sigma).unwrap();
            let after = alpha_sum(&s);
            let off = (after as f64 - before as f64).abs() / before as f64;
            assert!(off < 0.01, "sigma {sigma}: {before} to {after}");
            // It reaches about three sigma and no further than its reach.
            let ink = s.ink().unwrap();
            let spread = 80 - ink.x0;
            assert!(f64::from(spread) >= sigma * 1.5, "sigma {sigma} spread {spread}");
            assert!(spread <= blur_reach(sigma), "sigma {sigma} spread {spread}");
            // Colour stays under its alpha.
            assert!(s.data.chunks_exact(4).all(|p| p[2] <= p[3] && p[0] == 0));
        }
    }

    #[test]
    fn the_kernel_and_the_boxes_meet_at_two() {
        let _scope = budget::Scope::new();
        let (mut a, mut b) = (dot(64, 64, 32, 32), dot(64, 64, 32, 32));
        // One pixel is the worst case for three boxes; a block is the fair one.
        for s in [&mut a, &mut b] {
            for y in 24..40 {
                for x in 24..40 {
                    s.data[(y * 64 + x) * 4..(y * 64 + x) * 4 + 4].copy_from_slice(&[255, 0, 0, 255]);
                }
            }
        }
        gaussian(&mut a, 1.999).unwrap();
        gaussian(&mut b, 2.0).unwrap();
        let worst = a
            .data
            .iter()
            .zip(b.data.iter())
            .map(|(x, y)| x.abs_diff(*y))
            .max()
            .unwrap();
        assert!(worst <= 6, "the two differ by {worst} of 255");
    }

    #[test]
    fn a_blur_is_centred() {
        for sigma in [1.0, 2.0, 2.4, 3.1, 5.0] {
            let _scope = budget::Scope::new();
            let mut s = Surface::new(101, 101).unwrap();
            for y in 45..56 {
                for x in 45..56 {
                    s.data[(y * 101 + x) * 4 + 3] = 255;
                }
            }
            gaussian(&mut s, sigma).unwrap();
            for y in 0..101 {
                for x in 0..50 {
                    let a = s.data[(y * 101 + x) * 4 + 3];
                    let b = s.data[(y * 101 + 100 - x) * 4 + 3];
                    let c = s.data[(x * 101 + y) * 4 + 3];
                    assert!(a.abs_diff(b) <= 1 && a.abs_diff(c) <= 1, "sigma {sigma} at {x},{y}");
                }
            }
        }
    }

    /// Rows and columns go through two different loops; a picture turned
    /// on its diagonal has to come out turned the same way. The shape is
    /// against an edge, where a pass runs off the surface.
    #[test]
    fn rows_and_columns_are_blurred_alike() {
        for sigma in [0.7, 1.9, 2.0, 3.3, 7.5] {
            let _scope = budget::Scope::new();
            let (mut a, mut b) = (Surface::new(40, 40).unwrap(), Surface::new(40, 40).unwrap());
            for y in 0..9 {
                for x in 12..31 {
                    let v = (40 + x * 5 + y * 3) as u8;
                    a.data[(y * 40 + x) * 4..(y * 40 + x) * 4 + 4].copy_from_slice(&[v / 2, v / 3, v, v]);
                    b.data[(x * 40 + y) * 4..(x * 40 + y) * 4 + 4].copy_from_slice(&[v / 2, v / 3, v, v]);
                }
            }
            gaussian(&mut a, sigma).unwrap();
            gaussian(&mut b, sigma).unwrap();
            for y in 0..40 {
                for x in 0..40 {
                    for c in 0..4 {
                        let (p, q) = (a.data[(y * 40 + x) * 4 + c], b.data[(x * 40 + y) * 4 + c]);
                        assert!(p.abs_diff(q) <= 1, "sigma {sigma} at {x},{y} channel {c}: {p} and {q}");
                    }
                }
            }
        }
    }

    /// A surface in one colour: blurring its alpha and laying the colour
    /// back is the blur of all four channels.
    #[test]
    fn one_colour_blurred_by_its_alpha_is_the_same_picture() {
        for sigma in [1.2, 4.0] {
            let _scope = budget::Scope::new();
            let rgb = [200u8, 40, 120];
            let (mut full, mut flat) = (Surface::new(48, 32).unwrap(), Surface::new(48, 32).unwrap());
            for y in 8..20 {
                for x in 10..40 {
                    let a = if (x + y) % 3 == 0 { 255u32 } else { 90 };
                    let px = [
                        div255(u32::from(rgb[0]) * a) as u8,
                        div255(u32::from(rgb[1]) * a) as u8,
                        div255(u32::from(rgb[2]) * a) as u8,
                        a as u8,
                    ];
                    full.data[(y * 48 + x) * 4..(y * 48 + x) * 4 + 4].copy_from_slice(&px);
                    flat.data[(y * 48 + x) * 4..(y * 48 + x) * 4 + 4].copy_from_slice(&px);
                }
            }
            gaussian(&mut full, sigma).unwrap();
            gaussian_flat(&mut flat, sigma, rgb).unwrap();
            for (i, (p, q)) in full.data.iter().zip(flat.data.iter()).enumerate() {
                assert!(p.abs_diff(*q) <= 1, "sigma {sigma} byte {i}: {p} and {q}");
            }
        }
    }

    #[test]
    fn a_move_by_whole_pixels_is_a_copy_and_half_a_pixel_is_shared() {
        let _scope = budget::Scope::new();
        let mut s = dot(16, 16, 5, 5);
        sum_moved(&mut s, &[Moved { dx: 3.0, dy: -2.0, weight: 1.0 }]).unwrap();
        assert_eq!(s.ink().map(|b| (b.x0, b.y0, b.x1, b.y1)), Some((8, 3, 9, 4)));
        assert_eq!(&s.data[(3 * 16 + 8) * 4..(3 * 16 + 8) * 4 + 4], &[255, 0, 0, 255]);
        let mut s = dot(16, 16, 5, 5);
        sum_moved(&mut s, &[Moved { dx: 0.5, dy: 0.0, weight: 1.0 }]).unwrap();
        assert_eq!(s.data[(5 * 16 + 5) * 4 + 3], 128);
        assert_eq!(s.data[(5 * 16 + 6) * 4 + 3], 128);
    }

    #[test]
    fn copies_add_and_stop_at_full() {
        let _scope = budget::Scope::new();
        let mut s = dot(16, 16, 5, 5);
        let half = |dx| Moved { dx, dy: 0.0, weight: 0.5 };
        sum_moved(&mut s, &[half(0.0), half(2.0)]).unwrap();
        assert_eq!(s.data[(5 * 16 + 5) * 4 + 3], 128);
        assert_eq!(s.data[(5 * 16 + 7) * 4 + 3], 128);
        let mut s = dot(16, 16, 5, 5);
        let whole = Moved { dx: 0.0, dy: 0.0, weight: 1.0 };
        sum_moved(&mut s, &[whole, whole]).unwrap();
        assert_eq!(&s.data[(5 * 16 + 5) * 4..(5 * 16 + 5) * 4 + 4], &[255, 0, 0, 255]);
    }

    #[test]
    fn a_layer_is_laid_over_at_its_opacity() {
        let _scope = budget::Scope::new();
        let mut dst = Surface::new(8, 8).unwrap();
        dst.data[(2 * 8 + 3) * 4..(2 * 8 + 3) * 4 + 4].copy_from_slice(&[0, 255, 0, 255]);
        let layer = dot(8, 8, 2, 2);
        over_moved(&mut dst, &layer, (1.0, 0.0), 0.5).unwrap();
        // Half red over green.
        assert_eq!(&dst.data[(2 * 8 + 3) * 4..(2 * 8 + 3) * 4 + 4], &[128, 128, 0, 255]);
        let mut clear = Surface::new(8, 8).unwrap();
        over_moved(&mut clear, &layer, (-1.0, 2.0), 1.0).unwrap();
        assert_eq!(&clear.data[(4 * 8 + 1) * 4..(4 * 8 + 1) * 4 + 4], &[255, 0, 0, 255]);
        assert_eq!(alpha_sum(&clear), 255);
    }

    #[test]
    fn straight_pixels_go_in_and_come_out() {
        let _scope = budget::Scope::new();
        let mut s = Surface::new(4, 4).unwrap();
        s.draw(&[200, 100, 50, 128, 10, 20, 30, 255], 2, 1, 1);
        // Half over the edge is cut.
        s.draw(&[1, 2, 3, 255, 4, 5, 6, 255], 2, 3, 3);
        let out = s.straight(s.ink().unwrap()).unwrap();
        // Rows 1..4, columns 1..4.
        assert_eq!(&out[0..4], &[199, 100, 50, 128]);
        assert_eq!(&out[4..8], &[10, 20, 30, 255]);
        assert_eq!(&out[(2 * 3 + 2) * 4..(2 * 3 + 2) * 4 + 4], &[1, 2, 3, 255]);
    }
}
