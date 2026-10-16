//! One tile of a pattern fill, drawn by the engine.
//!
//! A pattern fill repeats a small square tile: dots, a screentone stagger,
//! stripes, hatching. The canvas used to draw that tile (`drawPatternTile`
//! in the app) and hand the engine its pixels, so the dots of a tone were
//! antialiased the way each browser does it. [`tile`] draws the same eleven
//! tiles with the engine's own rasteriser, and a tone is the same pixels
//! everywhere.
//!
//! The shapes are stated in tile units, 0 to 1 across the square, and are
//! the app's to the number. A tile has to repeat without a seam, so every
//! shape either sits wholly inside the square or runs the full width or
//! height of it.

use super::geom::{positive, Affine, IBox, Polys, Pt};
use super::job::{Fill, Rgba};
use super::raster::{Part, Rasterizer};
use super::shade::Shader;
use super::{budget, finish, plan, Planned};
use crate::Error;

/// Largest tile side drawn, in pixels. The app's tile is a third of the
/// font size at twice the page's resolution; this is far past that.
pub const MAX_TILE_SIDE: u32 = 4096;

/// The patterns, numbered as `PATTERN_KIND` in `text-engine/js/paint.mjs`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Dots,
    Halftone,
    Stripes,
    HStripes,
    Diagonal,
    DiagonalAlt,
    Crosshatch,
    Checker,
    Grid,
    VLines,
    HLines,
}

impl Kind {
    pub fn from_id(id: u32) -> Option<Self> {
        Some(match id {
            0 => Self::Dots,
            1 => Self::Halftone,
            2 => Self::Stripes,
            3 => Self::HStripes,
            4 => Self::Diagonal,
            5 => Self::DiagonalAlt,
            6 => Self::Crosshatch,
            7 => Self::Checker,
            8 => Self::Grid,
            9 => Self::VLines,
            10 => Self::HLines,
            _ => return None,
        })
    }
}

fn rect(out: &mut budget::Buffer<Polys>, x0: f64, y0: f64, x1: f64, y1: f64) -> Result<(), Error> {
    let mut polys = Polys::default();
    for p in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)] {
        polys.push(Pt::new(p.0, p.1));
    }
    polys.close();
    budget::push(out, polys)
}

fn dot(out: &mut budget::Buffer<Polys>, cx: f64, cy: f64, r: f64, tol: f64) -> Result<(), Error> {
    // A chord across an angle `t` leaves the arc by `r (1 - cos(t / 2))`.
    let step = if tol < r {
        2.0 * (1.0 - tol / r).acos()
    } else {
        core::f64::consts::FRAC_PI_2
    };
    let n = (core::f64::consts::TAU / step).ceil().clamp(8.0, 4096.0) as usize;
    let mut polys = Polys::default();
    for i in 0..n {
        let (sin, cos) = (core::f64::consts::TAU * i as f64 / n as f64).sin_cos();
        polys.push(Pt::new(cx + r * cos, cy + r * sin));
    }
    polys.close();
    budget::push(out, polys)
}

/// 45 degree bands across the tile, `dir` 1 for "/" and -1 for "\", `duty`
/// the share of each period a band covers.
///
/// Measured along the bands' own perpendicular, one tile across moves the
/// phase by `1 / sqrt(2)`, so that is the period the bands repeat at for
/// the tile's left edge to meet its right. Two periods either side of the
/// centre cover the square whichever way it is turned; what falls outside
/// it is not painted.
fn bands(out: &mut budget::Buffer<Polys>, dir: f64, duty: f64) -> Result<(), Error> {
    let period = core::f64::consts::FRAC_1_SQRT_2;
    let half = period * duty / 2.0;
    let (sin, cos) = (dir * core::f64::consts::FRAC_PI_4).sin_cos();
    let turned = Affine::translate(0.5, 0.5).after(&Affine::rotate(cos, sin));
    for k in -2..=2 {
        let y = f64::from(k) * period;
        let mut polys = Polys::default();
        for p in [(-1.0, y - half), (1.0, y - half), (1.0, y + half), (-1.0, y + half)] {
            polys.push(turned.apply(Pt::new(p.0, p.1)));
        }
        polys.close();
        budget::push(out, polys)?;
    }
    Ok(())
}

/// The foreground shapes of a tile, in tile units. `line` is the width of a
/// hairline (grid, vlines, hlines) as a share of the tile.
fn shapes(kind: Kind, line: f64, tol: f64) -> Result<budget::Buffer<Polys>, Error> {
    let mut out = budget::Buffer::new();
    let o = &mut out;
    match kind {
        Kind::Dots => dot(o, 0.5, 0.5, 0.25, tol)?,
        // The screentone stagger: two dots on the diagonal read as a 45
        // degree grid once the tile repeats.
        Kind::Halftone => {
            dot(o, 0.25, 0.25, 0.17, tol)?;
            dot(o, 0.75, 0.75, 0.17, tol)?;
        }
        Kind::Stripes => rect(o, 0.0, 0.0, 0.5, 1.0)?,
        Kind::HStripes => rect(o, 0.0, 0.0, 1.0, 0.5)?,
        Kind::Diagonal => bands(o, 1.0, 0.5)?,
        Kind::DiagonalAlt => bands(o, -1.0, 0.5)?,
        // Thinner than the single bands, or the two sets meet and the tile
        // is the foreground alone.
        Kind::Crosshatch => {
            bands(o, 1.0, 0.3)?;
            bands(o, -1.0, 0.3)?;
        }
        Kind::Checker => {
            rect(o, 0.0, 0.0, 0.5, 0.5)?;
            rect(o, 0.5, 0.5, 1.0, 1.0)?;
        }
        Kind::Grid => {
            rect(o, 0.0, 0.0, 1.0, line)?;
            rect(o, 0.0, 0.0, line, 1.0)?;
        }
        Kind::VLines => rect(o, 0.0, 0.0, line, 1.0)?,
        Kind::HLines => rect(o, 0.0, 0.0, 1.0, line)?,
    }
    Ok(out)
}

/// One tile of `kind`, `side` pixels square, as straight RGBA8: `bg` over
/// the whole square and `fg` over it where the pattern's shapes are.
///
/// `line` is the width of a hairline as a share of the tile, for the kinds
/// that have one; the app keeps a hairline at a page pixel or more, which
/// only it can turn into a share.
pub fn tile(
    kind: Kind,
    fg: Rgba,
    bg: Rgba,
    side: u32,
    line: f64,
    rasterizer: &dyn Rasterizer,
) -> Result<Vec<u8>, Error> {
    if side == 0 || side > MAX_TILE_SIDE || !line.is_finite() {
        return Err(Error::BadSpec);
    }
    let line = line.clamp(0.0, 1.0);
    let n = side as usize;
    let square = IBox {
        x0: 0,
        y0: 0,
        x1: side as i32,
        y1: side as i32,
    };
    let to_pixels = Affine::scale(f64::from(side), f64::from(side));
    let tol = super::FLATTEN_TOLERANCE / f64::from(side);

    let mut parts = budget::Buffer::new();
    for polys in shapes(kind, line, tol)?.iter() {
        let placed = polys.map(&to_pixels);
        if !placed.is_empty() {
            budget::push(&mut parts, Part::plain(placed))?;
        }
    }
    // The share of each pixel the shapes cover, as the alpha of a white
    // layer.
    const OPAQUE: Fill = Fill::Solid(Rgba([255, 255, 255, 255]));
    let cover = match Shader::new(&OPAQUE, &Affine::IDENTITY, &[]).and_then(|s| plan(parts, s, 1.0))
    {
        Some(planned) if !planned.bx.intersect(&square).is_empty() => {
            let mut layers: budget::Buffer<Planned<'_>> = budget::Buffer::new();
            budget::push(&mut layers, planned)?;
            Some(finish(layers, square, rasterizer)?)
        }
        _ => None,
    };

    let premul = |c: Rgba| {
        let a = f32::from(c.0[3]) / 255.0;
        [
            f32::from(c.0[0]) / 255.0 * a,
            f32::from(c.0[1]) / 255.0 * a,
            f32::from(c.0[2]) / 255.0 * a,
            a,
        ]
    };
    let (f, b) = (premul(fg), premul(bg));
    let mut out = budget::filled(n * n * 4, 0u8)?;
    for (i, px) in out.chunks_exact_mut(4).enumerate() {
        let share = cover
            .as_ref()
            .map_or(0.0, |c| f32::from(c[i * 4 + 3]) / 255.0);
        // The foreground over the background, both premultiplied.
        let under = 1.0 - f[3] * share;
        let p = [
            f[0] * share + b[0] * under,
            f[1] * share + b[1] * under,
            f[2] * share + b[2] * under,
            f[3] * share + b[3] * under,
        ];
        let a = p[3];
        let straight = |v: f32| {
            if positive(f64::from(a)) {
                (v / a * 255.0).round().clamp(0.0, 255.0) as u8
            } else {
                0
            }
        };
        px[0] = straight(p[0]);
        px[1] = straight(p[1]);
        px[2] = straight(p[2]);
        px[3] = (a * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    Ok(out.into_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::Exact;

    const FG: Rgba = Rgba([0, 0, 0, 255]);
    const BG: Rgba = Rgba([255, 255, 255, 255]);

    fn drawn(kind: Kind, side: u32) -> Vec<u8> {
        let _budget = budget::Scope::new();
        tile(kind, FG, BG, side, 0.12, &Exact).unwrap()
    }

    /// The share of the tile the foreground covers, 0 to 1.
    fn ink(t: &[u8]) -> f64 {
        let dark: f64 = t
            .chunks_exact(4)
            .map(|p| 1.0 - f64::from(p[0]) / 255.0)
            .sum();
        dark / (t.len() / 4) as f64
    }

    fn at(t: &[u8], side: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * side + x) * 4) as usize;
        [t[i], t[i + 1], t[i + 2], t[i + 3]]
    }

    #[test]
    fn every_kind_covers_the_share_its_shapes_do() {
        let pi = core::f64::consts::PI;
        for (kind, share) in [
            (Kind::Dots, pi * 0.25 * 0.25),
            (Kind::Halftone, 2.0 * pi * 0.17 * 0.17),
            (Kind::Stripes, 0.5),
            (Kind::HStripes, 0.5),
            (Kind::Diagonal, 0.5),
            (Kind::DiagonalAlt, 0.5),
            // Two sets of bands at 0.3, less where they cross.
            (Kind::Crosshatch, 0.3 + 0.3 - 0.09),
            (Kind::Checker, 0.5),
            (Kind::Grid, 0.12 + 0.12 - 0.0144),
            (Kind::VLines, 0.12),
            (Kind::HLines, 0.12),
        ] {
            let got = ink(&drawn(kind, 64));
            assert!((got - share).abs() < 0.005, "{kind:?}: {got} for {share}");
        }
    }

    #[test]
    fn a_tile_is_opaque_and_whole() {
        for id in 0..11 {
            let t = drawn(Kind::from_id(id).unwrap(), 33);
            assert_eq!(t.len(), 33 * 33 * 4);
            assert!(t.chunks_exact(4).all(|p| p[3] == 255), "kind {id}");
        }
        assert!(Kind::from_id(11).is_none());
    }

    #[test]
    fn the_shapes_are_where_the_app_drew_them() {
        let t = drawn(Kind::Dots, 64);
        assert_eq!(at(&t, 64, 32, 32), [0, 0, 0, 255]);
        assert_eq!(at(&t, 64, 2, 2), [255, 255, 255, 255]);
        let t = drawn(Kind::Halftone, 64);
        assert_eq!(at(&t, 64, 16, 16), [0, 0, 0, 255]);
        assert_eq!(at(&t, 64, 48, 48), [0, 0, 0, 255]);
        assert_eq!(at(&t, 64, 48, 16), [255, 255, 255, 255]);
        let t = drawn(Kind::Stripes, 64);
        assert_eq!(at(&t, 64, 10, 50), [0, 0, 0, 255]);
        assert_eq!(at(&t, 64, 50, 10), [255, 255, 255, 255]);
        let t = drawn(Kind::Checker, 64);
        assert_eq!(at(&t, 64, 10, 10), [0, 0, 0, 255]);
        assert_eq!(at(&t, 64, 50, 50), [0, 0, 0, 255]);
        assert_eq!(at(&t, 64, 50, 10), [255, 255, 255, 255]);
        let t = drawn(Kind::VLines, 100);
        assert_eq!(at(&t, 100, 5, 70), [0, 0, 0, 255]);
        assert_eq!(at(&t, 100, 20, 70), [255, 255, 255, 255]);
    }

    /// "/" bands run from the lower left to the upper right: the centre is
    /// inked, and so is the point up and to the right of it.
    #[test]
    fn the_two_diagonals_lean_opposite_ways() {
        let a = drawn(Kind::Diagonal, 64);
        let b = drawn(Kind::DiagonalAlt, 64);
        assert_eq!(at(&a, 64, 32, 32), [0, 0, 0, 255]);
        assert_eq!(at(&b, 64, 32, 32), [0, 0, 0, 255]);
        // Mirrored left to right, one is the other.
        for y in 0..64 {
            for x in 0..64 {
                let (p, q) = (at(&a, 64, x, y), at(&b, 64, 63 - x, y));
                assert!((i32::from(p[0]) - i32::from(q[0])).abs() <= 1, "{x},{y}");
            }
        }
        assert_ne!(a, b);
    }

    /// A tile repeats: what leaves by one edge comes in by the other, so
    /// the first and last columns of a diagonal are one row apart in phase.
    #[test]
    fn a_diagonal_meets_itself_across_the_edge() {
        let side = 64;
        let t = drawn(Kind::Diagonal, side);
        // The band through the centre leaves the right edge where its twin
        // enters the left: column 0 at row y is column `side` at row y,
        // which is column `side - 1` moved one step along the band.
        for y in 1..side {
            let left = at(&t, side, 0, y)[0];
            let right = at(&t, side, side - 1, y - 1)[0];
            assert!(
                (i32::from(left) - i32::from(right)).abs() <= 1,
                "row {y}: {left} against {right}"
            );
        }
    }

    #[test]
    fn colours_with_alpha_are_laid_one_over_the_other() {
        let _budget = budget::Scope::new();
        let clear = Rgba([0, 0, 0, 0]);
        let t = tile(Kind::Stripes, Rgba([255, 0, 0, 255]), clear, 8, 0.12, &Exact).unwrap();
        assert_eq!(at(&t, 8, 1, 1), [255, 0, 0, 255]);
        assert_eq!(at(&t, 8, 6, 1), [0, 0, 0, 0]);
        let half = tile(Kind::Stripes, Rgba([255, 0, 0, 128]), BG, 8, 0.12, &Exact).unwrap();
        let p = at(&half, 8, 1, 1);
        assert_eq!(p[3], 255);
        assert!((i32::from(p[1]) - 127).abs() <= 1, "{p:?}");
    }

    #[test]
    fn a_tile_out_of_range_is_refused() {
        let _budget = budget::Scope::new();
        assert!(tile(Kind::Dots, FG, BG, 0, 0.12, &Exact).is_err());
        assert!(tile(Kind::Dots, FG, BG, MAX_TILE_SIDE + 1, 0.12, &Exact).is_err());
        assert!(tile(Kind::Grid, FG, BG, 8, f64::NAN, &Exact).is_err());
    }
}
