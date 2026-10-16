//! Sound-effect lettering: where each letter of a word goes, how big it is
//! and how it leans, as pure maths.
//!
//! [`layout`] takes the advance of every code point (the caller measured them
//! with the face it paints with) and a recipe of up to [`MAX_MOVES`] moves,
//! and gives back one [`Placed`] per code point: the glyph's centre, turn,
//! scale and lean, relative to the centre of the whole block. The painter
//! takes it from there: a curved job (`paint::Run` with `sx`, `sy`, `skew`)
//! draws one such glyph per run.
//!
//! ```text
//! table.rs   the kinds the UI lists and the built-in presets
//! json.rs    that table as one JSON string (`mt_sfx_info`)
//! envelope.rs the warp grids a preset can ask for (`mt_sfx_envelope`)
//! wire.rs    the params as the bytes `mt_sfx_layout` reads
//! tests.rs   hand-computed expectations, one per kind
//! ```
//!
//! Conventions. Lengths are pixels, `size` the font size, "em" in a move is
//! `a * amount * size`. A rotation is positive clockwise on the screen (y
//! points down); a positive skew leans the top of the letter to the right.
//! A move's random numbers come from [`noise`], a small integer hash, so the
//! same seed paints the same way on every platform.

mod envelope;
mod json;
mod table;
#[cfg(test)]
mod tests;
mod wire;

pub use envelope::{mesh, Envelope, ENVELOPES, MAX_ENVELOPE_GRID};
pub use json::info_json;
pub use table::{Env, Kind, KindInfo, Preset, KINDS, PRESETS};
pub use wire::decode_params;

use crate::paint::budget;

/// Moves past this many in a recipe are ignored.
pub const MAX_MOVES: usize = 8;

/// A letter is never drawn smaller or bigger than this, as a multiple of the
/// face's size, whatever the moves add up to.
const SCALE_RANGE: (f64, f64) = (0.1, 8.0);

/// Largest lean, radians (75 degrees).
const MAX_SKEW: f64 = 75.0 * core::f64::consts::PI / 180.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flow {
    /// The rows are the lines the text came in.
    Row,
    /// Every letter is a row of its own.
    Stack,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Move {
    pub kind: Kind,
    /// Strength, in the unit the kind's table row names; times `amount`.
    pub a: f64,
    /// The kind's second number (cycles, hops, ...); see [`KINDS`].
    pub b: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    /// The face's size, pixels.
    pub size: f64,
    /// From one row's baseline to the next, pixels.
    pub line_height: f64,
    /// Added after every letter but a row's last, pixels.
    pub letter_spacing: f64,
    /// Scales every move at once; 1 is the recipe as written.
    pub amount: f64,
    pub seed: u32,
    pub flow: Flow,
    /// How far each row moves sideways from the one above, in ems.
    pub row_shift: f64,
    pub moves: Vec<Move>,
}

/// One letter placed. `x`, `y` are its centre in pixels, from the centre of
/// the box that holds the whole block.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Placed {
    pub x: f64,
    pub y: f64,
    /// Radians, clockwise.
    pub rot: f64,
    pub sx: f64,
    pub sy: f64,
    /// Radians; positive leans the top to the right.
    pub skew: f64,
    /// The letter's advance as it came in, unscaled.
    pub w: f64,
    /// Pixels, never negative: the painter pulls the lower half of that
    /// letter's outline down by this much while its top stays where it is.
    pub drip: f64,
}

/// A random number in `[-1, 1]` for one channel of one move at one glyph.
///
/// `lowbias32` (a bijective 32-bit integer mixer) is folded over the seed,
/// the move's index, the glyph's index in the whole text and the channel.
/// Integer arithmetic only, then one division, so the number is the same in
/// every build.
pub fn noise(seed: u32, mv: usize, glyph: usize, channel: u32) -> f64 {
    fn mix(mut x: u32) -> u32 {
        x ^= x >> 16;
        x = x.wrapping_mul(0x7feb_352d);
        x ^= x >> 15;
        x = x.wrapping_mul(0x846c_a68b);
        x ^ (x >> 16)
    }
    let mut h = mix(seed ^ 0x9e37_79b9);
    h = mix(h ^ (mv as u32).wrapping_mul(0x85eb_ca6b));
    h = mix(h ^ (glyph as u32).wrapping_mul(0xc2b2_ae35));
    h = mix(h ^ channel.wrapping_mul(0x27d4_eb2f));
    f64::from(h) / f64::from(u32::MAX) * 2.0 - 1.0
}

/// One glyph as the moves leave it, before it is flowed into a row.
#[derive(Clone, Copy)]
struct Acc {
    dx: f64,
    dy: f64,
    rot: f64,
    /// Uniform scale.
    s: f64,
    /// Extra scale in y.
    ys: f64,
    skew: f64,
    /// How far the letter's lower half runs down, pixels.
    drip: f64,
}

/// Where a glyph stands in the text, for the moves that ask.
#[derive(Clone, Copy)]
struct At {
    /// Index in the whole text, for the hash and `lead`.
    g: usize,
    /// Index in its row and the row's length.
    i: usize,
    n: usize,
    /// The row's width, for `wave`.
    row_width: f64,
}

fn deg(v: f64) -> f64 {
    v.to_radians()
}

/// The moves applied to one glyph. `slant` is a row's business and is
/// skipped here.
fn glyph(params: &Params, at: At) -> Acc {
    let size = params.size;
    let (i, n) = (at.i, at.n);
    let t = if n > 1 {
        i as f64 / (n - 1) as f64
    } else {
        0.5
    };
    let c = t - 0.5;
    let odd = i % 2 == 1;
    let mut a = Acc {
        dx: 0.0,
        dy: 0.0,
        rot: 0.0,
        s: 1.0,
        ys: 1.0,
        skew: 0.0,
        drip: 0.0,
    };
    for (m, mv) in params.moves.iter().take(MAX_MOVES).enumerate() {
        let big_a = mv.a * params.amount;
        let b_or = |d: f64| if mv.b > 0.0 { mv.b } else { d };
        let rnd = |channel| noise(params.seed, m, at.g, channel);
        match mv.kind {
            Kind::Step => a.dy -= big_a * c * size,
            Kind::Zigzag => a.dy += if odd { big_a } else { -big_a } * size,
            Kind::Wave => {
                let cycles = b_or(1.0);
                let ph = 2.0 * core::f64::consts::PI * cycles * t;
                a.dy += ph.sin() * big_a * size;
                let slope = big_a * size * 2.0 * core::f64::consts::PI * cycles * ph.cos()
                    / at.row_width.max(size);
                a.rot += slope.atan();
            }
            Kind::Bounce => {
                let hops = b_or(2.0);
                let h = (core::f64::consts::PI * hops * t).sin().abs();
                a.dy -= h * big_a * size;
                a.ys *= 1.0 - 0.2 * (1.0 - h) * (big_a.abs() * 2.0).clamp(0.0, 1.0);
            }
            Kind::Jitter => {
                a.dx += rnd(0) * big_a * 0.6 * size;
                a.dy += rnd(1) * big_a * size;
                a.rot += deg(rnd(2) * mv.b * params.amount);
            }
            Kind::Mix => a.s *= (1.0 + rnd(0) * big_a).max(0.2),
            Kind::Grow => a.s *= (1.0 + big_a * c).max(0.2),
            Kind::Swell => {
                let k = (core::f64::consts::PI * t).sin();
                a.s *= (1.0 - 0.28 * big_a + 0.78 * big_a * k * k).max(0.6);
            }
            Kind::Fan => a.rot += deg(c * big_a),
            Kind::Tilt => a.rot += deg(big_a),
            Kind::Alt => a.rot += deg(if odd { big_a } else { -big_a }),
            Kind::Tumble => a.rot += deg(t.powf(b_or(1.0)) * big_a),
            Kind::Drop => a.dy += t.powf(b_or(1.0)) * big_a * size,
            Kind::Lean => a.skew += deg(big_a),
            Kind::Domino => a.skew += deg(t * big_a),
            Kind::Explode => {
                a.dx += c * big_a * size;
                a.dy += if odd { -1.0 } else { 1.0 } * c.abs() * big_a * 0.75 * size;
                a.rot += deg(c * big_a * 70.0);
                a.s *= 1.0 + c.abs() * big_a.abs() * 0.45;
            }
            Kind::Stretch => a.ys *= (1.0 + big_a).max(0.2),
            Kind::Lead => {
                if at.g == 0 {
                    a.s *= 1.0 + big_a;
                }
            }
            Kind::Taper => a.s *= (1.0 - (t - mv.b).max(0.0) * big_a).max(0.2),
            Kind::Slant => {}
            Kind::Drip => {
                // Some letters run, some stay dry: `share` of them, by the hash.
                let share = b_or(0.5);
                let (r0, r1) = ((rnd(0) + 1.0) / 2.0, (rnd(1) + 1.0) / 2.0);
                if r0 < share {
                    a.drip += big_a * size * (0.4 + 0.6 * r1);
                }
            }
        }
    }
    a.s = a.s.clamp(SCALE_RANGE.0, SCALE_RANGE.1);
    // Never up, and never more than four ems' worth of face.
    a.drip = a.drip.max(0.0).min(4.0 * size.max(0.0));
    a
}

/// A letter on its way to a row.
struct Item {
    adv: f64,
    row: usize,
    g: usize,
    i: usize,
    n: usize,
}

fn finite(params: &Params) -> bool {
    [
        params.size,
        params.line_height,
        params.letter_spacing,
        params.amount,
        params.row_shift,
    ]
    .iter()
    .all(|v| v.is_finite())
        && params
            .moves
            .iter()
            .all(|m| m.a.is_finite() && m.b.is_finite())
}

/// Places every letter of `rows`; `rows[r][k]` is the advance of the `k`th
/// code point of row `r` at `params.size`, unscaled.
///
/// The result has one [`Placed`] per code point, row by row. Empty rows are
/// kept: they place nothing but they take a line. A number that is not finite
/// anywhere in the input, or an allocation the painter's budget refuses,
/// gives an empty result, never a panic.
///
/// In `Row` flow a letter's `i` and `n` are its index in its row and the
/// row's length. In `Stack` flow every letter is a row of its own, and `i`
/// and `n` run over the whole text. Then, in this order:
///
/// 1. every letter's size, from the moves that scale (clamped);
/// 2. each row flowed left to right by `advance * scale + letter_spacing` and
///    centred on x = 0, which is the width `wave` needs;
/// 3. each letter's offset, turn and lean added;
/// 4. each row's `slant` (the sum of its moves' degrees): the row's letters
///    turn about the row's origin, and each turns by as much;
/// 5. row `r` moved down by `r * line_height` and right by
///    `r * row_shift * size`;
/// 6. the block's box (every letter's centre plus or minus half its scaled
///    advance and half its scaled height, and the bottom lower by the
///    letter's `drip`) centred on the origin.
pub fn layout(rows: &[Vec<f64>], params: &Params) -> Vec<Placed> {
    place(rows, params).unwrap_or_default()
}

fn place(rows: &[Vec<f64>], params: &Params) -> Option<Vec<Placed>> {
    if !finite(params) || rows.iter().flatten().any(|v| !v.is_finite()) {
        return None;
    }
    let total: usize = rows.iter().map(Vec::len).sum();
    if total == 0 {
        return Some(Vec::new());
    }
    let mut items = Vec::new();
    budget::reserve_raw(&mut items, total).ok()?;
    let mut groups: Vec<core::ops::Range<usize>> = Vec::new();
    budget::reserve_raw(
        &mut groups,
        match params.flow {
            Flow::Row => rows.len(),
            Flow::Stack => total,
        },
    )
    .ok()?;
    for (r, row) in rows.iter().enumerate() {
        let start = items.len();
        for (k, &adv) in row.iter().enumerate() {
            let g = items.len();
            let (row, i, n) = match params.flow {
                Flow::Row => (r, k, row.len()),
                Flow::Stack => (g, g, total),
            };
            items.push(Item { adv, row, g, i, n });
            if params.flow == Flow::Stack {
                groups.push(g..g + 1);
            }
        }
        if params.flow == Flow::Row {
            groups.push(start..items.len());
        }
    }

    // 1. Sizes. `wave` is the only move that reads a row's width, and the
    // width needs the sizes, so this pass leaves it out of the picture.
    let mut accs = Vec::new();
    budget::reserve_raw(&mut accs, total).ok()?;
    for it in &items {
        let at = At {
            g: it.g,
            i: it.i,
            n: it.n,
            row_width: params.size,
        };
        accs.push(glyph(params, at));
    }
    // 2. Each row's width, then everything the moves do to a glyph.
    let slant: f64 = params
        .moves
        .iter()
        .take(MAX_MOVES)
        .filter(|m| m.kind == Kind::Slant)
        .map(|m| m.a * params.amount)
        .sum();
    let theta = deg(slant);
    let (sin, cos) = theta.sin_cos();
    let mut out = Vec::new();
    budget::reserve_raw(&mut out, total).ok()?;
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for group in &groups {
        // An empty row places nothing; its line is counted by the row numbers.
        if group.is_empty() {
            continue;
        }
        let width = group
            .clone()
            .map(|k| items[k].adv * accs[k].s + params.letter_spacing)
            .sum::<f64>()
            - params.letter_spacing;
        let row = items[group.start].row;
        let mut pen = -width / 2.0;
        for k in group.clone() {
            let it = &items[k];
            let at = At {
                g: it.g,
                i: it.i,
                n: it.n,
                row_width: width,
            };
            let a = glyph(params, at);
            let w = it.adv * a.s;
            let px = pen + w / 2.0;
            pen += w + params.letter_spacing;
            let (lx, ly) = (px + a.dx, a.dy);
            let (lx, ly) = (lx * cos - ly * sin, lx * sin + ly * cos);
            let sy = (a.s * a.ys).clamp(SCALE_RANGE.0, SCALE_RANGE.1);
            let p = Placed {
                x: lx + row as f64 * params.row_shift * params.size,
                y: ly + row as f64 * params.line_height,
                rot: a.rot + theta,
                sx: a.s,
                sy,
                skew: a.skew.clamp(-MAX_SKEW, MAX_SKEW),
                w: it.adv,
                drip: a.drip,
            };
            x0 = x0.min(p.x - w / 2.0);
            x1 = x1.max(p.x + w / 2.0);
            y0 = y0.min(p.y - params.size * sy / 2.0);
            y1 = y1.max(p.y + params.size * sy / 2.0 + p.drip);
            out.push(p);
        }
    }
    let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    for p in &mut out {
        p.x -= cx;
        p.y -= cy;
    }
    let sound = out.iter().all(|p| {
        [p.x, p.y, p.rot, p.sx, p.sy, p.skew, p.w, p.drip]
            .iter()
            .all(|v| v.is_finite())
    });
    sound.then_some(out)
}
