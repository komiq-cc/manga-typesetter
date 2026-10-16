//! Roughening: the box's outlines carried through a field of noise.
//!
//! The app used to roughen by moving the PIXELS of the finished picture: the
//! pixel at `p` was copied from `p + d(p)` (an SVG `feDisplacementMap` fed by
//! `feTurbulence`, and `roughenPixels` in `src/lib/text-paint.js`, which is
//! that filter worked out by hand). Moved pixels are antialiased edges torn
//! apart and averaged back together, and a stroke thinner than the field is
//! fine comes out in pieces.
//!
//! Here the same field moves the OUTLINE, before there are pixels: a point
//! `q` of a letter goes to `q - d(q)`, which is where the copy above showed
//! it (to first order in `d`), and the letter is rasterised after. So the
//! crumple falls on the same letters the same way, `amount`, `detail` and
//! `seed` mean what they meant, and an edge is as sharp roughened as plain.
//!
//! The field is `feTurbulence type="fractalNoise"` from the SVG 1.1
//! specification, number for number what `text-paint.js` computes: this file
//! is held to that one by `tests/data/roughen.txt`, which
//! `parity/roughen.mjs` writes from the JS.

use super::budget;
use super::geom::Pt;
use super::warp::Cut;
use crate::Error;

// The specification's generator: r = (16807 * r) mod (2^31 - 1), by
// Schrage's method.
const RAND_M: i64 = 2_147_483_647;
const RAND_A: i64 = 16807;
const RAND_Q: i64 = 127_773; // m / a
const RAND_R: i64 = 2836; // m % a

const B_SIZE: usize = 0x100;
const B_MASK: i32 = 0xff;
/// Keeps the lattice lookup on positive coordinates.
const PERLIN_N: f64 = 4096.0;
/// One entry more than twice the lattice, so `b + 1` needs no second mask.
const LATTICE: usize = B_SIZE + B_SIZE + 2;

/// How many octaves the fractal sum runs to (`OCTAVES`, text-paint.js).
pub const OCTAVES: u32 = 2;

/// Where the field sits against the pixels it used to move: half a pixel,
/// the phase `text-paint.js` starts from (`DEFAULT_NOISE_PHASE`). Stated so
/// a chapter roughened before keeps its crumple where it was.
const PHASE: f64 = 0.5;

/// Largest `amount` and `detail` a job may state. Guards: the app's sliders
/// stop at 20 and 0.2.
pub const MAX_AMOUNT: f64 = 4096.0;
pub const MAX_DETAIL: f64 = 8.0;

/// The grit's base frequency, cycles per job unit: its two octaves are four
/// and two units long, the size of the tear a moved pixel used to leave.
/// Fixed, where the crumple's own frequency is the style's: grit is the
/// tooth of the paper and does not grow with the letters.
pub const GRIT_DETAIL: f64 = 0.25;

/// What is added to the seed for the grit's field, so it is not the
/// crumple's field over again at another size.
const GRIT_SEED: f64 = 101.0;

fn next_rand(seed: i64) -> i64 {
    let r = RAND_A * (seed % RAND_Q) - RAND_R * (seed / RAND_Q);
    if r <= 0 {
        r + RAND_M
    } else {
        r
    }
}

/// `setupSeed`: any number to a seed the generator accepts.
fn setup_seed(seed: f64) -> i64 {
    let m = (RAND_M - 1) as f64;
    let mut s = if seed.is_finite() { seed.trunc() } else { 0.0 };
    if s <= 0.0 {
        s = -(s % m) + 1.0;
    }
    if s > m {
        s = m;
    }
    s as i64
}

/// The lattice and the gradients of the two channels that are read, R for
/// the move across and G for the move down.
struct Noise {
    lattice: [usize; LATTICE],
    grad: [[f64; LATTICE * 2]; 2],
}

impl Noise {
    fn new(seed: f64) -> Result<Box<Self>, Error> {
        let mut noise = budget::boxed(Noise {
            lattice: [0; LATTICE],
            grad: [[0.0; LATTICE * 2]; 2],
        })?;
        let mut s = setup_seed(seed);
        // All four channels are drawn although two are kept: the shuffle
        // below continues the same stream, and drawing fewer would move
        // every lattice index.
        for k in 0..4 {
            for i in 0..B_SIZE {
                noise.lattice[i] = i;
                s = next_rand(s);
                let gx = ((s % (B_SIZE + B_SIZE) as i64) - B_SIZE as i64) as f64 / B_SIZE as f64;
                s = next_rand(s);
                let gy = ((s % (B_SIZE + B_SIZE) as i64) - B_SIZE as i64) as f64 / B_SIZE as f64;
                let len = (gx * gx + gy * gy).sqrt();
                let len = if len == 0.0 { 1.0 } else { len };
                if let Some(g) = noise.grad.get_mut(k) {
                    g[i * 2] = gx / len;
                    g[i * 2 + 1] = gy / len;
                }
            }
        }
        // Fisher-Yates downwards from the last index: the specification's
        // `while(--i)`, which leaves slot 0 alone.
        for i in (1..B_SIZE).rev() {
            let k = noise.lattice[i];
            s = next_rand(s);
            let j = (s % B_SIZE as i64) as usize;
            noise.lattice[i] = noise.lattice[j];
            noise.lattice[j] = k;
        }
        for i in 0..B_SIZE + 2 {
            noise.lattice[B_SIZE + i] = noise.lattice[i];
            for g in &mut noise.grad {
                g[(B_SIZE + i) * 2] = g[i * 2];
                g[(B_SIZE + i) * 2 + 1] = g[i * 2 + 1];
            }
        }
        Ok(noise)
    }

    /// Gradient noise at `(vx, vy)` on one channel: the specification's
    /// `noise2`. The arithmetic is written in the order the JS writes it,
    /// and nothing is fused, so the two give the same bits.
    fn noise2(&self, channel: usize, vx: f64, vy: f64) -> f64 {
        let lat = &self.lattice;
        let g = &self.grad[channel];

        let t = vx + PERLIN_N;
        let ix = t.floor();
        let bx0 = (ix as i32 & B_MASK) as usize;
        let bx1 = (bx0 + 1) & B_MASK as usize;
        let rx0 = t - ix;
        let rx1 = rx0 - 1.0;

        let t = vy + PERLIN_N;
        let iy = t.floor();
        let by0 = (iy as i32 & B_MASK) as usize;
        let by1 = (by0 + 1) & B_MASK as usize;
        let ry0 = t - iy;
        let ry1 = ry0 - 1.0;

        let i = lat[bx0];
        let j = lat[bx1];
        let b00 = lat[i + by0];
        let b10 = lat[j + by0];
        let b01 = lat[i + by1];
        let b11 = lat[j + by1];

        let sx = rx0 * rx0 * (3.0 - 2.0 * rx0);
        let sy = ry0 * ry0 * (3.0 - 2.0 * ry0);

        let u = rx0 * g[b00 * 2] + ry0 * g[b00 * 2 + 1];
        let v = rx1 * g[b10 * 2] + ry0 * g[b10 * 2 + 1];
        let a = u + sx * (v - u);
        let u = rx0 * g[b01 * 2] + ry1 * g[b01 * 2 + 1];
        let v = rx1 * g[b11 * 2] + ry1 * g[b11 * 2 + 1];
        let b = u + sx * (v - u);
        a + sy * (b - a)
    }

    /// The fractal sum at a point already multiplied by the base frequency,
    /// as the colour channel it is in the filter: `(sum + 1) / 2`, in 0..1.
    fn turbulence(&self, channel: usize, vx0: f64, vy0: f64) -> f64 {
        let (mut vx, mut vy) = (vx0, vy0);
        let mut sum = 0.0;
        let mut ratio = 1.0;
        for _ in 0..OCTAVES {
            sum += self.noise2(channel, vx, vy) / ratio;
            vx *= 2.0;
            vy *= 2.0;
            ratio *= 2.0;
        }
        ((sum + 1.0) / 2.0).clamp(0.0, 1.0)
    }
}

/// A box's roughening, as its style states it (`style.roughen`), and where
/// the field starts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Roughen {
    /// The whole span a point may be moved over, job units: half each way.
    pub amount: f64,
    /// The field's base frequency, cycles per job unit.
    pub detail: f64,
    pub seed: f64,
    /// The field's origin in job space: the corner of the text block, where
    /// the editor's filter had its own.
    pub origin: Pt,
    /// The span of a second, fine field laid over the first, job units: the
    /// torn edge. Moving pixels left one by accident, a pixel at a time;
    /// moved outlines are smooth, so it is asked for. 0 for none.
    pub grit: f64,
}

impl Roughen {
    /// Whether the numbers are ones the painter takes.
    pub(crate) fn sound(&self) -> bool {
        self.amount.abs() <= MAX_AMOUNT
            && (0.0..=MAX_DETAIL).contains(&self.detail)
            && self.seed.is_finite()
            && self.origin.x.is_finite()
            && self.origin.y.is_finite()
            && (0.0..=MAX_AMOUNT).contains(&self.grit)
    }

    /// The map this roughening is, or `None` when it moves nothing: no
    /// amount, or a field with no frequency, which is the same value
    /// everywhere and that value is "stay".
    pub(crate) fn map(&self) -> Result<Option<RoughMap>, Error> {
        if !self.sound() {
            return Err(Error::BadSpec);
        }
        let crumple = self.amount != 0.0 && self.detail != 0.0;
        if !crumple && self.grit == 0.0 {
            return Ok(None);
        }
        Ok(Some(RoughMap {
            noise: if crumple { Some(Noise::new(self.seed)?) } else { None },
            amount: self.amount,
            detail: self.detail,
            origin: self.origin,
            grit: if self.grit != 0.0 {
                Some((Noise::new(self.seed + GRIT_SEED)?, self.grit))
            } else {
                None
            },
        }))
    }
}

/// A roughening that moves something.
pub(crate) struct RoughMap {
    /// The crumple's field, when it moves anything.
    noise: Option<Box<Noise>>,
    amount: f64,
    detail: f64,
    origin: Pt,
    /// The grit's field and its span.
    grit: Option<(Box<Noise>, f64)>,
}

impl RoughMap {
    /// How far the pixel at `p` was copied from, across and down: the
    /// filter's `scale * (channel - 0.5)`.
    fn offset(&self, p: Pt) -> Pt {
        let (x, y) = (p.x - self.origin.x + PHASE, p.y - self.origin.y + PHASE);
        let field = |noise: &Noise, span: f64, detail: f64| {
            let (vx, vy) = (x * detail, y * detail);
            Pt::new(
                span * (noise.turbulence(0, vx, vy) - 0.5),
                span * (noise.turbulence(1, vx, vy) - 0.5),
            )
        };
        let mut d = Pt::new(0.0, 0.0);
        if let Some(noise) = &self.noise {
            d = field(noise, self.amount, self.detail);
        }
        if let Some((noise, span)) = &self.grit {
            d = d.plus(field(noise, *span, GRIT_DETAIL));
        }
        d
    }

    /// Where the job-space point `p` goes.
    pub(crate) fn at(&self, p: Pt) -> Pt {
        p.minus(self.offset(p))
    }

    /// How an outline is cut for this map. Inside one cell of the finest
    /// octave's lattice the field is one polynomial, so no piece is longer
    /// than half of that cell; how far a piece then leaves its chord is
    /// found by looking.
    pub(crate) fn cut(&self, tol: f64) -> Cut {
        let crumple = if self.noise.is_some() { self.detail } else { 0.0 };
        let grit = if self.grit.is_some() { GRIT_DETAIL } else { 0.0 };
        let finest = crumple.max(grit) * f64::from(1u32 << (OCTAVES - 1));
        Cut::of(0.5 / finest, f64::INFINITY, tol)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The field is the one in `text-paint.js`, to the bit:
    /// `tests/data/roughen.txt`, written by `parity/roughen.mjs` from
    /// `turbulenceChannel`. `src/lib/roughen-fixture.test.js` holds the file
    /// to the JS; this holds the port to the file.
    #[test]
    fn the_field_is_the_one_in_text_paint_js() {
        let _scope = budget::Scope::new();
        let text = include_str!("../../tests/data/roughen.txt");
        let mut noise: Option<(f64, Box<Noise>)> = None;
        let mut seen = 0;
        for line in text.lines() {
            let f: Vec<&str> = line.split(' ').collect();
            assert_eq!(f[0], "noise", "{line}");
            let num = |k: usize| f[k].parse::<f64>().unwrap();
            let (seed, channel, freq, x, y) = (num(1), num(2) as usize, num(3), num(4), num(5));
            let want = f64::from_bits(u64::from_str_radix(f[6], 16).unwrap());
            if noise.as_ref().map(|n| n.0.to_bits()) != Some(seed.to_bits()) {
                noise = Some((seed, Noise::new(seed).unwrap()));
            }
            let got = noise.as_ref().unwrap().1.turbulence(channel, x * freq, y * freq);
            assert_eq!(got.to_bits(), want.to_bits(), "{line}: got {got}");
            seen += 1;
        }
        assert!(seen > 1000, "{seen} points");
    }

    fn map(amount: f64, detail: f64) -> RoughMap {
        Roughen {
            amount,
            detail,
            seed: 7.0,
            origin: Pt::new(3.0, 5.0),
            grit: 0.0,
        }
        .map()
        .unwrap()
        .unwrap()
    }

    #[test]
    fn no_point_moves_further_than_half_the_amount() {
        let _scope = budget::Scope::new();
        let m = map(8.0, 0.05);
        let mut far: f64 = 0.0;
        for j in 0..200 {
            for i in 0..200 {
                let p = Pt::new(f64::from(i) * 1.7 - 40.0, f64::from(j) * 1.3 - 30.0);
                let d = m.at(p).minus(p);
                assert!(d.x.abs() <= 4.0 && d.y.abs() <= 4.0, "{p:?} moved {d:?}");
                far = far.max(d.x.abs()).max(d.y.abs());
            }
        }
        // And the field does something.
        assert!(far > 1.0, "furthest move {far}");
    }

    #[test]
    fn a_roughening_with_no_amount_or_no_frequency_is_no_map() {
        let _scope = budget::Scope::new();
        let r = Roughen {
            amount: 0.0,
            detail: 0.05,
            seed: 7.0,
            origin: Pt::new(0.0, 0.0),
            grit: 0.0,
        };
        assert!(r.map().unwrap().is_none());
        assert!(Roughen { amount: 4.0, detail: 0.0, ..r }.map().unwrap().is_none());
        assert!(Roughen { amount: 1e9, ..r }.map().is_err());
        assert!(Roughen { detail: -1.0, ..r }.map().is_err());
        assert!(Roughen { grit: -1.0, ..r }.map().is_err());
        // Grit alone is a map: the edge is torn where it stands.
        assert!(Roughen { grit: 2.0, ..r }.map().unwrap().is_some());
    }

    /// Grit adds at most half its span to a move, is a finer field than the
    /// crumple, and with none the map is the crumple alone to the bit.
    #[test]
    fn grit_is_a_fine_field_over_the_crumple() {
        let _scope = budget::Scope::new();
        let base = Roughen {
            amount: 8.0,
            detail: 0.05,
            seed: 7.0,
            origin: Pt::new(3.0, 5.0),
            grit: 0.0,
        };
        let plain = base.map().unwrap().unwrap();
        let torn = Roughen { grit: 2.0, ..base }.map().unwrap().unwrap();
        let alone = Roughen { amount: 0.0, grit: 2.0, ..base }.map().unwrap().unwrap();
        let (mut far, mut turns_plain, mut turns_torn) = (0.0f64, 0, 0);
        // The last two moves down, of each map, to count its turns.
        let mut seen: [(f64, f64); 2] = [(0.0, 0.0); 2];
        for i in 0..4000 {
            let p = Pt::new(f64::from(i) * 0.25 - 100.0, 17.3);
            let (a, b, c) = (plain.at(p), torn.at(p), alone.at(p));
            // The two fields add: the torn point is the crumpled one moved
            // by what the grit alone moves it.
            let grit = c.minus(p);
            assert!((b.x - a.x - grit.x).abs() < 1e-9 && (b.y - a.y - grit.y).abs() < 1e-9);
            assert!(grit.x.abs() <= 1.0 && grit.y.abs() <= 1.0, "{p:?} grit {grit:?}");
            far = far.max(grit.x.abs()).max(grit.y.abs());
            let now = (a.y - p.y, b.y - p.y);
            if i > 1 {
                if (seen[1].0 - seen[0].0) * (now.0 - seen[1].0) < 0.0 {
                    turns_plain += 1;
                }
                if (seen[1].1 - seen[0].1) * (now.1 - seen[1].1) < 0.0 {
                    turns_torn += 1;
                }
            }
            seen = [seen[1], now];
        }
        assert!(far > 0.2, "the grit moved nothing: {far}");
        assert!(turns_torn > turns_plain * 3, "{turns_torn} turns against {turns_plain}");
        assert!(torn.cut(0.1).max_len < plain.cut(0.1).max_len);
    }

    #[test]
    fn the_seed_is_read_as_the_js_reads_it() {
        assert_eq!(setup_seed(0.0), 1);
        assert_eq!(setup_seed(7.9), 7);
        assert_eq!(setup_seed(-3.0), 4);
        assert_eq!(setup_seed(1e12), RAND_M - 1);
        assert_eq!(setup_seed(f64::NAN), 1);
    }
}
