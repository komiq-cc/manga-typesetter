//! What a covered pixel is painted with: a flat colour, a gradient or a
//! repeated tile. A [`Shader`] answers one question, the premultiplied
//! colour at a device pixel's centre.

use super::budget;
use super::geom::{positive, Affine, Pt};
use super::job::{Fill, Rgba, Stop, Tile};

/// Premultiplied RGBA, each channel 0 to 1.
pub type Premul = [f32; 4];

fn premul(c: [f32; 4]) -> Premul {
    [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]
}

fn unit(c: Rgba) -> [f32; 4] {
    c.0.map(|v| f32::from(v) / 255.0)
}

/// A canvas gradient's colour line.
///
/// Stops are kept in ascending position, equal positions in the order they
/// were given, as `addColorStop` keeps them. Colours are interpolated channel
/// by channel **before** premultiplying, which is what the canvas does (and
/// what CSS gradients do not): halfway from opaque red to transparent blue is
/// half-transparent purple, not half-transparent red.
pub struct Ramp {
    stops: budget::Buffer<(f64, [f32; 4], usize)>,
}

impl Ramp {
    pub fn new(stops: &[Stop]) -> Self {
        let mut sorted = budget::Buffer::new();
        if super::budget::reserve(&mut sorted, stops.len()).is_err() {
            return Self { stops: sorted };
        }
        sorted.extend(
            stops
                .iter()
                .enumerate()
                .map(|(i, s)| (s.pos.clamp(0.0, 1.0), unit(s.color), i)),
        );
        // The index preserves equal-position order without stable sort's
        // hidden, infallible scratch allocation.
        sorted.sort_unstable_by(|a, b| a.0.total_cmp(&b.0).then(a.2.cmp(&b.2)));
        let stops = sorted;
        Self { stops }
    }

    /// The premultiplied colour at `t`. Outside the first and last stop the
    /// end colours carry on; a gradient without stops paints nothing.
    pub fn at(&self, t: f64) -> Premul {
        let Some(&(first_pos, first, _)) = self.stops.first() else {
            return [0.0; 4];
        };
        if t <= first_pos {
            return premul(first);
        }
        // The first stop beyond `t`: with two stops at one position that is
        // the later one, so the colour jumps there as it does on a canvas.
        let Some(i) = self.stops.iter().position(|s| t < s.0) else {
            return premul(self.stops[self.stops.len() - 1].1);
        };
        let (p0, c0, _) = self.stops[i - 1];
        let (p1, c1, _) = self.stops[i];
        // `p0 <= t < p1`, so the span is positive.
        let f = ((t - p0) / (p1 - p0)) as f32;
        premul([
            c0[0] + (c1[0] - c0[0]) * f,
            c0[1] + (c1[1] - c0[1]) * f,
            c0[2] + (c1[2] - c0[2]) * f,
            c0[3] + (c1[3] - c0[3]) * f,
        ])
    }
}

pub enum Shader<'a> {
    Solid(Premul),
    /// `t = tx * X + ty * Y + t0` along the gradient line, in device pixels.
    Linear {
        ramp: Ramp,
        tx: f64,
        ty: f64,
        t0: f64,
    },
    /// `t` is the distance from the centre over the radius, measured in the
    /// fill's own frame, which `to_frame` maps a device point into.
    Radial {
        ramp: Ramp,
        to_frame: Affine,
        centre: Pt,
        radius: f64,
    },
    Pattern {
        tile: &'a Tile,
        /// Device pixels to tile pixels.
        to_tile: Affine,
        /// Samples taken per device pixel along x and y when the tile is
        /// drawn smaller than it is.
        taps: (u32, u32),
    },
}

impl<'a> Shader<'a> {
    /// The shader for `fill`, given the map from the fill's frame to device
    /// pixels. `None` means the fill paints nothing at all.
    pub fn new(fill: &Fill, frame: &Affine, tiles: &'a [Tile]) -> Option<Self> {
        match fill {
            Fill::Solid(c) => Some(Shader::Solid(premul(unit(*c)))),
            Fill::Linear { from, to, stops } => {
                let inv = frame.invert()?;
                let d = to.minus(*from);
                let len2 = d.dot(d);
                // A canvas gradient whose two points coincide paints nothing.
                if !positive(len2) || stops.is_empty() {
                    return None;
                }
                // t(P) = (inv(P) - from) . d / |d|^2, which is affine in P.
                let [a, b, c, e, tx0, ty0] = inv.0;
                Some(Shader::Linear {
                    ramp: Ramp::new(stops),
                    tx: (a * d.x + b * d.y) / len2,
                    ty: (c * d.x + e * d.y) / len2,
                    t0: ((tx0 - from.x) * d.x + (ty0 - from.y) * d.y) / len2,
                })
            }
            Fill::Radial {
                centre,
                radius,
                stops,
            } => {
                if !positive(*radius) || stops.is_empty() {
                    return None;
                }
                Some(Shader::Radial {
                    ramp: Ramp::new(stops),
                    to_frame: frame.invert()?,
                    centre: *centre,
                    radius: *radius,
                })
            }
            Fill::Pattern {
                tile,
                pitch,
                origin,
                fallback,
            } => {
                let Some(tile) = tiles.get(*tile as usize).filter(|t| !t.is_empty()) else {
                    // No tile could be made: the canvas painter falls back
                    // to the style's flat colour.
                    return Some(Shader::Solid(premul(unit(*fallback))));
                };
                if !positive(*pitch) {
                    return None;
                }
                // The pattern matrix [pitch / w, 0, 0, pitch / h, ax, ay]
                // takes tile pixels to the fill's frame.
                let to_frame = Affine([
                    pitch / tile.width as f64,
                    0.0,
                    0.0,
                    pitch / tile.height as f64,
                    origin.x,
                    origin.y,
                ]);
                let to_tile = frame.after(&to_frame).invert()?;
                // Tile pixels stepped over per device pixel, along each axis.
                let [a, b, c, d, ..] = to_tile.0;
                let taps = |step: f64| (step - 0.25).ceil().clamp(1.0, 8.0) as u32;
                Some(Shader::Pattern {
                    tile,
                    to_tile,
                    taps: (taps(a.hypot(b)), taps(c.hypot(d))),
                })
            }
        }
    }

    /// Whether every pixel gets the same colour, and which.
    pub fn solid(&self) -> Option<Premul> {
        match self {
            Shader::Solid(c) => Some(*c),
            _ => None,
        }
    }

    /// The colour of device pixel `(x, y)`, sampled at its centre.
    pub fn at(&self, x: i32, y: i32) -> Premul {
        let (px, py) = (f64::from(x) + 0.5, f64::from(y) + 0.5);
        match self {
            Shader::Solid(c) => *c,
            Shader::Linear { ramp, tx, ty, t0 } => ramp.at(tx * px + ty * py + t0),
            Shader::Radial {
                ramp,
                to_frame,
                centre,
                radius,
            } => {
                let p = to_frame.apply(Pt::new(px, py)).minus(*centre);
                ramp.at(p.len() / radius)
            }
            Shader::Pattern {
                tile,
                to_tile,
                taps,
            } => {
                let (nx, ny) = *taps;
                if nx == 1 && ny == 1 {
                    return tile.sample(to_tile.apply(Pt::new(px, py)));
                }
                // The tile is being shrunk: one bilinear sample would skip
                // tile pixels, so average a grid of them over the pixel.
                let mut sum = [0.0f32; 4];
                for j in 0..ny {
                    for i in 0..nx {
                        let sx = px - 0.5 + (f64::from(i) + 0.5) / f64::from(nx);
                        let sy = py - 0.5 + (f64::from(j) + 0.5) / f64::from(ny);
                        let c = tile.sample(to_tile.apply(Pt::new(sx, sy)));
                        for k in 0..4 {
                            sum[k] += c[k];
                        }
                    }
                }
                let n = (nx * ny) as f32;
                sum.map(|v| v / n)
            }
        }
    }
}

impl Tile {
    /// Bilinear sample at `p` in tile pixels, the tile repeating in both
    /// directions. A tile pixel's colour sits at its centre, so a tile drawn
    /// at its own size and merely shifted is resampled by exact area.
    pub fn sample(&self, p: Pt) -> Premul {
        let (w, h) = (self.width as f64, self.height as f64);
        let u = p.x - 0.5;
        let v = p.y - 0.5;
        let (u0, v0) = (u.floor(), v.floor());
        let (fx, fy) = ((u - u0) as f32, (v - v0) as f32);
        // `rem_euclid` of a finite value by a positive one is in [0, w).
        let wrap = |i: f64, n: f64| (i.rem_euclid(n) as usize).min(n as usize - 1);
        let (x0, x1) = (wrap(u0, w), wrap(u0 + 1.0, w));
        let (y0, y1) = (wrap(v0, h), wrap(v0 + 1.0, h));
        let at = |x: usize, y: usize| self.texels[y * self.width as usize + x];
        let (c00, c10, c01, c11) = (at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1));
        let mut out = [0.0f32; 4];
        for k in 0..4 {
            let top = c00[k] + (c10[k] - c00[k]) * fx;
            let bottom = c01[k] + (c11[k] - c01[k]) * fx;
            out[k] = top + (bottom - top) * fy;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stop(pos: f64, rgba: [u8; 4]) -> Stop {
        Stop {
            pos,
            color: Rgba(rgba),
        }
    }

    fn close(a: Premul, b: [f32; 4]) -> bool {
        a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-6)
    }

    #[test]
    fn a_ramp_holds_its_ends_and_mixes_before_premultiplying() {
        let ramp = Ramp::new(&[stop(0.25, [255, 0, 0, 255]), stop(0.75, [0, 0, 255, 0])]);
        assert!(close(ramp.at(-3.0), [1.0, 0.0, 0.0, 1.0]));
        assert!(close(ramp.at(0.25), [1.0, 0.0, 0.0, 1.0]));
        // Midway: straight (0.5, 0, 0.5, 0.5), so premultiplied a quarter of
        // each colour. Mixing premultiplied values would give red 0.5 and no
        // blue at all.
        assert!(close(ramp.at(0.5), [0.25, 0.0, 0.25, 0.5]));
        assert!(close(ramp.at(0.75), [0.0, 0.0, 0.0, 0.0]));
        assert!(close(ramp.at(9.0), [0.0, 0.0, 0.0, 0.0]));
    }

    #[test]
    fn stops_are_sorted_by_position_and_keep_their_order_at_a_tie() {
        let ramp = Ramp::new(&[
            stop(1.0, [0, 0, 255, 255]),
            stop(0.5, [0, 255, 0, 255]),
            stop(0.5, [255, 255, 255, 255]),
            stop(0.0, [255, 0, 0, 255]),
        ]);
        // Just under the tie the ramp is nearly the first of the two, at it
        // and beyond the second.
        assert!(ramp.at(0.4999)[1] > 0.99 && ramp.at(0.4999)[2] < 0.01);
        assert!(close(ramp.at(0.5), [1.0, 1.0, 1.0, 1.0]));
        assert!(close(ramp.at(0.75), [0.5, 0.5, 1.0, 1.0]));
        assert!(close(Ramp::new(&[]).at(0.5), [0.0; 4]));
        assert!(close(
            Ramp::new(&[stop(0.3, [0, 255, 0, 255])]).at(0.9),
            [0.0, 1.0, 0.0, 1.0]
        ));
    }

    #[test]
    fn a_linear_gradient_is_measured_along_its_line_under_the_transform() {
        let fill = Fill::Linear {
            from: Pt::new(10.0, 0.0),
            to: Pt::new(20.0, 0.0),
            stops: vec![stop(0.0, [0, 0, 0, 255]), stop(1.0, [255, 255, 255, 255])],
        };
        // At 2x the line runs from device x = 20 to 40.
        let s = Shader::new(&fill, &Affine::scale(2.0, 2.0), &[]).unwrap();
        // Pixel 29 has its centre at 29.5: t = 0.475.
        assert!((s.at(29, 7)[0] - 0.475).abs() < 1e-6);
        assert!(close(s.at(5, 0), [0.0, 0.0, 0.0, 1.0]));
        assert!(close(s.at(60, 0), [1.0, 1.0, 1.0, 1.0]));
        // Coincident points paint nothing.
        let none = Fill::Linear {
            from: Pt::new(1.0, 1.0),
            to: Pt::new(1.0, 1.0),
            stops: vec![stop(0.0, [0, 0, 0, 255])],
        };
        assert!(Shader::new(&none, &Affine::IDENTITY, &[]).is_none());
    }

    #[test]
    fn a_radial_gradient_is_the_distance_from_its_centre() {
        let fill = Fill::Radial {
            centre: Pt::new(10.0, 10.0),
            radius: 10.0,
            stops: vec![stop(0.0, [0, 0, 0, 255]), stop(1.0, [255, 255, 255, 255])],
        };
        let s = Shader::new(&fill, &Affine::IDENTITY, &[]).unwrap();
        // Centre of pixel (14, 9) is (14.5, 9.5): 4.5 right and 0.5 up.
        let want = (4.5f64.hypot(0.5) / 10.0) as f32;
        assert!((s.at(14, 9)[0] - want).abs() < 1e-6);
        assert!(close(s.at(40, 40), [1.0, 1.0, 1.0, 1.0]));
    }

    fn checker() -> Tile {
        // 2 x 2: black, white / white, black.
        Tile::from_rgba(
            2,
            2,
            &[
                0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
            ],
        )
        .unwrap()
    }

    #[test]
    fn a_pattern_repeats_at_its_pitch_from_its_origin() {
        let tiles = [checker()];
        let fill = Fill::Pattern {
            tile: 0,
            // One tile every 4 px, so each tile pixel is 2 px wide.
            pitch: 4.0,
            origin: Pt::new(1.0, 0.5),
            fallback: Rgba([9, 9, 9, 255]),
        };
        let s = Shader::new(&fill, &Affine::IDENTITY, &tiles).unwrap();
        // Row 1 has its centre on the centre of the tile's first row. Along
        // it, device pixel x has its centre at tile x = (x + 0.5 - 1) / 2:
        // pixels 1 and 2 lie in the black tile pixel, a quarter of the way
        // to a white one on either side, and 3 and 4 in the white one.
        let row: Vec<f32> = (0..12).map(|x| s.at(x, 1)[0]).collect();
        for x in 0..8 {
            assert!((row[x] - row[x + 4]).abs() < 1e-6, "period at {x}");
        }
        for (x, want) in [(1, 0.25), (2, 0.25), (3, 0.75), (4, 0.75)] {
            assert!((row[x] - want).abs() < 1e-6, "pixel {x}: {}", row[x]);
        }
        // Every pixel is opaque: the tile is.
        assert!((0..12).all(|x| (s.at(x, 3)[3] - 1.0).abs() < 1e-6));
        // Shrunk to a quarter, a pixel holds two tiles each way and
        // averages to mid grey.
        let small = Shader::new(&fill, &Affine::scale(0.125, 0.125), &tiles).unwrap();
        assert!((small.at(3, 3)[0] - 0.5).abs() < 0.05);
        // No tile: the flat fallback colour.
        let flat = Shader::new(&fill, &Affine::IDENTITY, &[]).unwrap();
        assert!(close(
            flat.at(0, 0),
            [9.0 / 255.0, 9.0 / 255.0, 9.0 / 255.0, 1.0]
        ));
    }
}
