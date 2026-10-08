//! A paint job: everything one box's glyphs need drawn, as plain data.
//!
//! It mirrors the job `glyphJob` builds in `src/lib/exporter.js`, with the
//! parts the JS loader resolves already resolved: colours are RGBA bytes,
//! the face is a font id with a size, and a pattern names a tile by index.
//!
//! [`decode`] reads the wire form `text-engine/js/paint.mjs` writes: one
//! little-endian buffer per job.

use super::geom::{Affine, Pt};
use super::shade::Premul;
use super::BoldDraw;
use crate::engine::{Face, Synth};
use crate::Error;

/// Straight (not premultiplied) RGBA, the layout of canvas `ImageData`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgba(pub [u8; 4]);

impl Rgba {
    /// From `0xRRGGBBAA`.
    pub fn from_u32(rgba: u32) -> Self {
        Self(rgba.to_be_bytes())
    }

    pub fn alpha(self) -> f32 {
        f32::from(self.0[3]) / 255.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stop {
    pub pos: f64,
    pub color: Rgba,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Fill {
    Solid(Rgba),
    /// Canvas `createLinearGradient(from, to)`.
    Linear {
        from: Pt,
        to: Pt,
        stops: Vec<Stop>,
    },
    /// Canvas `createRadialGradient(c, 0, c, radius)`.
    Radial {
        centre: Pt,
        radius: f64,
        stops: Vec<Stop>,
    },
    /// Tile number `tile`, repeated every `pitch` job units in both
    /// directions with a tile corner at `origin`.
    Pattern {
        tile: u32,
        pitch: f64,
        origin: Pt,
        /// Painted flat when there is no such tile.
        fallback: Rgba,
    },
}

/// One stroke of the outline, wider than the one painted after it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Band {
    pub color: Rgba,
    /// Canvas `globalAlpha` for this stroke.
    pub opacity: f64,
    /// Canvas `lineWidth`: the whole pen, half of it outside the outline.
    pub line: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    pub text: String,
    /// Straight text: the anchor `align` names, on the alphabetic baseline.
    /// Curved text: where the glyph's centre goes.
    pub x: f64,
    pub y: f64,
    /// Curved text only: the glyph's rotation about `(x, y)`, radians.
    pub rot: f64,
    /// This run's own fill; `None` means the job's.
    pub fill: Option<Fill>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    /// One glyph per run, each centred on its point and turned.
    pub curved: bool,
    pub align: Align,
    /// Straight text only: added after every cluster, the last included.
    pub letter_spacing: f64,
    /// Outermost first.
    pub bands: Vec<Band>,
    /// Paint the glyphs and their widest band as one flat shape in this
    /// colour, instead of bands and fills.
    pub silhouette: Option<Rgba>,
    pub fill: Option<Fill>,
    pub runs: Vec<Run>,
}

/// A pattern tile: premultiplied pixels, row by row from the top.
#[derive(Clone, Debug, PartialEq)]
pub struct Tile {
    pub width: u32,
    pub height: u32,
    pub texels: Vec<Premul>,
}

impl Tile {
    /// From straight RGBA8, the layout of canvas `ImageData`.
    pub fn from_rgba(width: u32, height: u32, rgba: &[u8]) -> Option<Self> {
        let n = (width as usize).checked_mul(height as usize)?;
        if rgba.len() != n.checked_mul(4)? {
            return None;
        }
        let texels = rgba
            .chunks_exact(4)
            .map(|p| {
                let a = f32::from(p[3]) / 255.0;
                [
                    f32::from(p[0]) / 255.0 * a,
                    f32::from(p[1]) / 255.0 * a,
                    f32::from(p[2]) / 255.0 * a,
                    a,
                ]
            })
            .collect();
        Some(Self {
            width,
            height,
            texels,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }
}

/// A decoded request: the job and everything that came beside it.
pub struct Request {
    pub job: Job,
    /// The font, its size and synthetic style, and the fallback chain a
    /// letter it lacks is looked for in (zero for none).
    pub face: Face,
    /// How a synthesised bold is drawn; `None` for the way that goes with
    /// the engine's `boldAdvance` rule ([`BoldDraw::for_rule`]).
    pub bold_draw: Option<BoldDraw>,
    /// Extra weight: every filled glyph shape is grown by this many device
    /// pixels on every side before it is painted, and bands lie round the
    /// grown shape. Zero paints the outline as the font has it.
    pub weight: f64,
    pub transform: Affine,
    pub tiles: Vec<Tile>,
}

/// First four bytes of the wire form: "MTPJ".
pub const MAGIC: u32 = 0x4a50_544d;
/// Bumped when the wire form changes; `paint.mjs` writes the same number.
pub const WIRE_VERSION: u32 = 3;

/// Largest extra weight accepted, in device pixels. A guard, not a design
/// limit: the weight that was measured against the browsers is under one.
pub const MAX_WEIGHT: f64 = 64.0;

/// Largest tile side accepted, a guard like the surface's.
const MAX_TILE_SIDE: u32 = 4096;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let end = self.at.checked_add(n).ok_or(Error::BadSpec)?;
        let s = self.bytes.get(self.at..end).ok_or(Error::BadSpec)?;
        self.at = end;
        Ok(s)
    }

    fn u32(&mut self) -> Result<u32, Error> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    /// A number that must be finite: a NaN or an infinity in a job is a
    /// malformed job, and refusing it here is what lets the painter's own
    /// arithmetic never meet one.
    fn f64(&mut self) -> Result<f64, Error> {
        let b = self.take(8)?;
        let v = f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        if v.is_finite() {
            Ok(v)
        } else {
            Err(Error::BadSpec)
        }
    }

    fn rgba(&mut self) -> Result<Rgba, Error> {
        let b = self.take(4)?;
        Ok(Rgba([b[0], b[1], b[2], b[3]]))
    }

    fn pt(&mut self) -> Result<Pt, Error> {
        Ok(Pt::new(self.f64()?, self.f64()?))
    }

    /// A count of records of at least `min_size` bytes each, checked against
    /// what is left so a bad count cannot ask for a huge allocation.
    fn count(&mut self, min_size: usize) -> Result<usize, Error> {
        let n = self.u32()? as usize;
        let left = self.bytes.len() - self.at;
        if n.checked_mul(min_size).ok_or(Error::BadSpec)? > left {
            return Err(Error::BadSpec);
        }
        Ok(n)
    }

    fn stops(&mut self) -> Result<Vec<Stop>, Error> {
        let n = self.count(12)?;
        (0..n)
            .map(|_| {
                Ok(Stop {
                    pos: self.f64()?,
                    color: self.rgba()?,
                })
            })
            .collect()
    }

    fn fill(&mut self) -> Result<Option<Fill>, Error> {
        Ok(Some(match self.u32()? {
            0 => return Ok(None),
            1 => Fill::Solid(self.rgba()?),
            2 => Fill::Linear {
                from: self.pt()?,
                to: self.pt()?,
                stops: self.stops()?,
            },
            3 => Fill::Radial {
                centre: self.pt()?,
                radius: self.f64()?,
                stops: self.stops()?,
            },
            4 => Fill::Pattern {
                tile: self.u32()?,
                pitch: self.f64()?,
                origin: self.pt()?,
                fallback: self.rgba()?,
            },
            _ => return Err(Error::BadSpec),
        }))
    }
}

/// Reads one request from its wire form.
///
/// ```text
/// u32 magic, u32 version
/// u32 font, u32 synth bits (1 bold, 2 oblique)
/// u32 fallback chain (0 none)
/// u32 bold drawing (0 as the engine's bold rule has it, 1 outset, 2 smear)
/// f64 size
/// f64 x 6 transform (a, b, c, d, e, f)
/// f64 weight (device pixels, 0 to 64)
/// u32 flags (1 curved, 2 silhouette), u32 align (0 left, 1 centre, 2 right)
/// f64 letter spacing
/// rgba silhouette
/// u32 band count, then per band: rgba colour, f64 opacity, f64 line
/// fill (the job's)
/// u32 run count, then per run: f64 x, f64 y, f64 rot, fill,
///                              u32 byte length, UTF-8 text
/// u32 tile count, then per tile: u32 width, u32 height, RGBA8 pixels
///
/// fill: u32 kind, then
///   0 none
///   1 solid:   rgba
///   2 linear:  f64 x0, y0, x1, y1, stops
///   3 radial:  f64 cx, cy, r, stops
///   4 pattern: u32 tile, f64 pitch, f64 ax, ay, rgba fallback
/// stops: u32 count, then per stop: f64 position, rgba
/// rgba: four bytes, straight alpha
/// ```
pub fn decode(bytes: &[u8]) -> Result<Request, Error> {
    let mut r = Reader { bytes, at: 0 };
    if r.u32()? != MAGIC || r.u32()? != WIRE_VERSION {
        return Err(Error::BadSpec);
    }
    let font = r.u32()?;
    let synth = Synth::from_bits(r.u32()?);
    let chain = r.u32()?;
    let bold_draw = match r.u32()? {
        0 => None,
        1 => Some(BoldDraw::Outset),
        2 => Some(BoldDraw::Smear),
        _ => return Err(Error::BadSpec),
    };
    let size = r.f64()?;
    let mut m = [0.0; 6];
    for v in &mut m {
        *v = r.f64()?;
    }
    let weight = r.f64()?;
    if !(0.0..=MAX_WEIGHT).contains(&weight) {
        return Err(Error::BadSpec);
    }
    let flags = r.u32()?;
    let align = match r.u32()? {
        0 => Align::Left,
        1 => Align::Center,
        2 => Align::Right,
        _ => return Err(Error::BadSpec),
    };
    let letter_spacing = r.f64()?;
    let silhouette = r.rgba()?;
    let bands = (0..r.count(20)?)
        .map(|_| {
            Ok(Band {
                color: r.rgba()?,
                opacity: r.f64()?,
                line: r.f64()?,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let fill = r.fill()?;
    let runs = (0..r.count(32)?)
        .map(|_| {
            let (x, y, rot) = (r.f64()?, r.f64()?, r.f64()?);
            let fill = r.fill()?;
            let len = r.u32()? as usize;
            let text = core::str::from_utf8(r.take(len)?).map_err(|_| Error::BadText)?;
            Ok(Run {
                text: text.to_owned(),
                x,
                y,
                rot,
                fill,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let tiles = (0..r.count(8)?)
        .map(|_| {
            let (width, height) = (r.u32()?, r.u32()?);
            if width > MAX_TILE_SIDE || height > MAX_TILE_SIDE {
                return Err(Error::BadSpec);
            }
            let len = width as usize * height as usize * 4;
            Tile::from_rgba(width, height, r.take(len)?).ok_or(Error::BadSpec)
        })
        .collect::<Result<Vec<_>, Error>>()?;
    if r.at != bytes.len() {
        return Err(Error::BadSpec);
    }
    Ok(Request {
        job: Job {
            curved: flags & 1 != 0,
            align,
            letter_spacing,
            bands,
            silhouette: (flags & 2 != 0).then_some(silhouette),
            fill,
            runs,
        },
        face: Face {
            font,
            size,
            synth,
            chain,
        },
        bold_draw,
        weight,
        transform: Affine(m),
        tiles,
    })
}
