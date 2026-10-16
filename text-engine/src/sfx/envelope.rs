//! Warp envelopes: where each node of a grid over a box goes when the box is
//! bent into an arch, a valley, a flag or a rise. Pure maths; the app lays the
//! points over the word as its mesh warp (`style.warp.pts`).
//!
//! The grid is `(cols + 1) * (rows + 1)` nodes, row-major, top-left first.
//! `bend` is a fraction of the box's height: the arch's middle goes up by half
//! of `bend * h` and its ends down by as much. A `bend` of zero leaves the
//! identity grid, to the bit.

use core::f64::consts::PI;

use crate::paint::budget;

/// A shape the box is bent into. It crosses the wire as its index in
/// [`ENVELOPES`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Envelope {
    /// The middle up, the ends down.
    Arch,
    /// The middle down, the ends up.
    Valley,
    /// One full sine along the box, as a flag in the wind.
    Flag,
    /// The right side up, the left down, and the top leaning with it.
    Rise,
}

pub const ENVELOPES: [Envelope; 4] = [
    Envelope::Arch,
    Envelope::Valley,
    Envelope::Flag,
    Envelope::Rise,
];

impl Envelope {
    pub fn id(self) -> &'static str {
        match self {
            Envelope::Arch => "arch",
            Envelope::Valley => "valley",
            Envelope::Flag => "flag",
            Envelope::Rise => "rise",
        }
    }

    /// The envelope at `i` in [`ENVELOPES`].
    pub fn from_index(i: u32) -> Option<Envelope> {
        ENVELOPES.get(i as usize).copied()
    }
}

/// Most columns or rows a grid may have.
pub const MAX_ENVELOPE_GRID: usize = 64;

/// `bend` is held to this, either way.
const BEND_RANGE: f64 = 2.0;

/// `(cols + 1) * (rows + 1)` points, row-major, top-left first: where each
/// node of the identity grid over a box `w` by `h` goes. This is
/// `style.warp.pts` of the app.
///
/// Node `(i, j)` starts at `(w * i / cols, h * j / rows)`. With `u = i / cols`,
/// `v = j / rows` and `k = bend * h` (`bend` held to -2..2), y moves by
///
/// ```text
/// Arch    k * (0.5 - 4 u (1 - u))
/// Valley  -k * (0.5 - 4 u (1 - u))
/// Flag    -k / 2 * sin(2 pi u)
/// Rise    k * (0.5 - (1 - cos(pi u)) / 2),  and x moves by k / 2 * (0.5 - v)
/// ```
///
/// A number that is not finite, a box with no area, a grid with no columns or
/// rows or more than [`MAX_ENVELOPE_GRID`] of either, or an allocation the
/// painter's budget refuses, gives an empty result, never a panic.
pub fn mesh(kind: Envelope, bend: f64, cols: usize, rows: usize, w: f64, h: f64) -> Vec<[f64; 2]> {
    build(kind, bend, cols, rows, w, h).unwrap_or_default()
}

fn build(
    kind: Envelope,
    bend: f64,
    cols: usize,
    rows: usize,
    w: f64,
    h: f64,
) -> Option<Vec<[f64; 2]>> {
    let grid = 1..=MAX_ENVELOPE_GRID;
    if !(bend.is_finite() && w.is_finite() && h.is_finite())
        || w <= 0.0
        || h <= 0.0
        || !grid.contains(&cols)
        || !grid.contains(&rows)
    {
        return None;
    }
    let k = bend.clamp(-BEND_RANGE, BEND_RANGE) * h;
    let mut pts = Vec::new();
    budget::reserve_raw(&mut pts, (cols + 1) * (rows + 1)).ok()?;
    for j in 0..=rows {
        let v = j as f64 / rows as f64;
        let y0 = (h * j as f64) / rows as f64;
        for i in 0..=cols {
            let u = i as f64 / cols as f64;
            let x0 = (w * i as f64) / cols as f64;
            let (mut x, mut y) = (x0, y0);
            if k != 0.0 {
                match kind {
                    Envelope::Arch => y = y0 + k * (0.5 - 4.0 * u * (1.0 - u)),
                    Envelope::Valley => y = y0 - k * (0.5 - 4.0 * u * (1.0 - u)),
                    Envelope::Flag => y = y0 - k * 0.5 * (2.0 * PI * u).sin(),
                    Envelope::Rise => {
                        y = y0 + k * (0.5 - (1.0 - (PI * u).cos()) / 2.0);
                        x = x0 + 0.5 * k * (0.5 - v);
                    }
                }
            }
            pts.push([x, y]);
        }
    }
    // A box so large that the maths overflows has no answer.
    pts.iter()
        .all(|p| p[0].is_finite() && p[1].is_finite())
        .then_some(pts)
}
