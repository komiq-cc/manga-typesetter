//! A paint job: everything one box's glyphs need drawn, as plain data.
//!
//! It mirrors the job `glyphJob` builds in `src/lib/exporter.js`, with the
//! parts the JS loader resolves already resolved: colours are RGBA bytes,
//! the face is a font id with a size, and a pattern names a tile by index.
//!
//! [`decode`] reads the wire form `text-engine/js/paint.mjs` writes: one
//! little-endian buffer per job.

use super::geom::{Affine, Pt};
use super::roughen::Roughen;
use super::shade::Premul;
use super::warp::{Mesh, MAX_MESH_SIDE};
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
    /// Curved text only: the glyph's own scale, about its centre and before
    /// the skew and the turn. Negative mirrors. The run's fill is not scaled
    /// with it: a gradient or a pattern is stated in the frame `x, y, rot`
    /// make, so it is not stretched from letter to letter.
    pub sx: f64,
    pub sy: f64,
    /// Curved text only: the glyph leans, radians, after it is scaled and
    /// before it is turned. Positive leans the top of the letter to the right.
    pub skew: f64,
    /// Curved text only: the lower half of the glyph is pulled down by this
    /// many job units while its top stays where it is; 0 for none. Down is
    /// the job's, whichever way the glyph is turned. A band is pulled with
    /// the outline it is a stroke of.
    pub drip: f64,
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
    /// No fill at all: no run's fill and not the job's is painted, and the
    /// glyphs as they would have been filled are cut out of the bands under
    /// them, so what is left of a band is its outer half. With a silhouette
    /// it is cut the same way: the widest band's outer half in one colour.
    /// A job with no band then paints nothing.
    pub no_fill: bool,
    pub fill: Option<Fill>,
    /// The box's mesh warp: every outline, grown by its band or its bold
    /// first, is carried through it before the transform. `None`, or a mesh
    /// that moves nothing, paints the job as it is. A gradient or a pattern
    /// is carried with each glyph it fills, by the mesh's tangent at that
    /// glyph, so a letter keeps the part of the fill it had.
    pub mesh: Option<Mesh>,
    /// The box's roughening: every outline, grown by its band or its bold
    /// first, is carried through a field of noise before the mesh. `None`
    /// paints the job as it is. A fill is not moved with it: only the shape
    /// of a letter is roughened, not what it is filled with.
    pub roughen: Option<Roughen>,
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
        let mut texels = Vec::new();
        super::budget::reserve_raw(&mut texels, n).ok()?;
        texels.extend(rgba.chunks_exact(4).map(|p| {
            let a = f32::from(p[3]) / 255.0;
            [
                f32::from(p[0]) / 255.0 * a,
                f32::from(p[1]) / 255.0 * a,
                f32::from(p[2]) / 255.0 * a,
                a,
            ]
        }));
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
    /// pixels on every side before it is painted. Zero paints the outline
    /// as the font has it.
    ///
    /// A band is not moved by it: it stays a stroke of the outline the font
    /// has, so the heavier fill covers that much more of it. That is what
    /// was measured: Safari on a Mac draws filled text heavier than its
    /// outline and stroked text exactly on it (P5B-REPORT.md). The
    /// silhouette, which is the fill and the widest band as one shape, is
    /// as wide as the wider of the two.
    pub weight: f64,
    pub transform: Affine,
    pub tiles: Vec<Tile>,
}

/// First four bytes of the wire form: "MTPJ".
pub const MAGIC: u32 = 0x4a50_544d;
/// Bumped when the wire form changes; `paint.mjs` writes the same number.
pub const WIRE_VERSION: u32 = 7;

/// Largest extra weight accepted, in device pixels. A guard, not a design
/// limit: the weight that was measured against the browsers is under one.
pub const MAX_WEIGHT: f64 = 64.0;

/// A run's scale must be at least this far from zero and at most this big
/// (in absolute value): a guard against a glyph collapsed to nothing or
/// grown to fill a surface, not a design limit.
const SCALE_RANGE: core::ops::RangeInclusive<f64> = 0.01..=100.0;

/// Largest skew accepted, radians (about 80 degrees; the tangent is 5.8).
const MAX_SKEW: f64 = 1.4;

/// Largest drip accepted, job units. A guard: a drip is a share of the
/// letter's size.
const MAX_DRIP: f64 = 4096.0;

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
        super::budget::collect((0..n).map(|_| {
            Ok(Stop {
                pos: self.f64()?,
                color: self.rgba()?,
            })
        }))
    }

    fn mesh(&mut self) -> Result<Option<Mesh>, Error> {
        let cols = self.u32()?;
        if cols == 0 {
            return Ok(None);
        }
        let rows = self.u32()?;
        if cols > MAX_MESH_SIDE || !(1..=MAX_MESH_SIDE).contains(&rows) {
            return Err(Error::BadSpec);
        }
        let (x, y, w, h) = (self.f64()?, self.f64()?, self.f64()?, self.f64()?);
        if w <= 0.0 || h <= 0.0 {
            return Err(Error::BadSpec);
        }
        // Within the guard the product is small; the bytes left bound it
        // before anything is allocated.
        let n = (cols as usize + 1) * (rows as usize + 1);
        if n * 16 > self.bytes.len() - self.at {
            return Err(Error::BadSpec);
        }
        let pts = super::budget::collect((0..n).map(|_| self.pt()))?;
        Ok(Some(Mesh {
            cols,
            rows,
            pts,
            x,
            y,
            w,
            h,
        }))
    }

    fn roughen(&mut self) -> Result<Option<Roughen>, Error> {
        if self.u32()? == 0 {
            return Ok(None);
        }
        let r = Roughen {
            amount: self.f64()?,
            detail: self.f64()?,
            seed: self.f64()?,
            origin: self.pt()?,
            grit: self.f64()?,
        };
        if r.sound() {
            Ok(Some(r))
        } else {
            Err(Error::BadSpec)
        }
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
/// u32 flags (1 curved, 2 silhouette, 4 no fill), u32 align (0 left, 1 centre, 2 right)
/// f64 letter spacing
/// rgba silhouette
/// u32 band count, then per band: rgba colour, f64 opacity, f64 line
/// fill (the job's)
/// mesh
/// roughen
/// u32 run count, then per run: f64 x, y, rot, sx, sy, skew, drip, fill,
///                              u32 byte length, UTF-8 text
/// u32 tile count, then per tile: u32 width, u32 height, RGBA8 pixels
///
/// fill: u32 kind, then
///   0 none
///   1 solid:   rgba
///   2 linear:  f64 x0, y0, x1, y1, stops
///   3 radial:  f64 cx, cy, r, stops
///   4 pattern: u32 tile, f64 pitch, f64 ax, ay, rgba fallback
/// mesh: u32 cols, 0 for a job with no mesh; else
///   u32 rows, f64 x, y, w, h (the rectangle the mesh is defined on),
///   then (cols + 1) * (rows + 1) points, row by row from the top left:
///   f64 x, y, relative to the rectangle's corner
/// roughen: u32 0 for a job that is not roughened; else u32 1, then
///   f64 amount, detail, seed, f64 x, y (the field's origin in job space),
///   f64 grit
/// stops: u32 count, then per stop: f64 position, rgba
/// rgba: four bytes, straight alpha
/// ```
///
/// A run's `sx` and `sy` are 0.01 to 100 in absolute value and its `skew` is
/// within 1.4 radians, its `drip` is 0 to 4096, or the job is refused. A
/// straight job's runs write 1, 1, 0, 0: only a curved job reads them. A mesh
/// has 1 to 64 cells each way and a rectangle with a size. A roughening's
/// amount is within 4096 either way, its detail is 0 to 8 and its grit is 0
/// to 4096.
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
    let bands = super::budget::collect((0..r.count(20)?).map(|_| {
        Ok(Band {
            color: r.rgba()?,
            opacity: r.f64()?,
            line: r.f64()?,
        })
    }))?;
    let fill = r.fill()?;
    let mesh = r.mesh()?;
    let roughen = r.roughen()?;
    let runs = super::budget::collect((0..r.count(64)?).map(|_| {
        let (x, y, rot) = (r.f64()?, r.f64()?, r.f64()?);
        let (sx, sy, skew) = (r.f64()?, r.f64()?, r.f64()?);
        let drip = r.f64()?;
        if !SCALE_RANGE.contains(&sx.abs())
            || !SCALE_RANGE.contains(&sy.abs())
            || skew.abs() > MAX_SKEW
            || !(0.0..=MAX_DRIP).contains(&drip)
        {
            return Err(Error::BadSpec);
        }
        let fill = r.fill()?;
        let len = r.u32()? as usize;
        if len > super::budget::MAX_RUN_BYTES {
            return Err(Error::BadSpec);
        }
        let text = core::str::from_utf8(r.take(len)?).map_err(|_| Error::BadText)?;
        let mut owned = Vec::new();
        super::budget::reserve_raw(&mut owned, text.len())?;
        owned.extend_from_slice(text.as_bytes());
        // Valid UTF-8 was checked above; this conversion does not allocate.
        let text = String::from_utf8(owned).map_err(|_| Error::BadText)?;
        Ok(Run {
            text,
            x,
            y,
            rot,
            sx,
            sy,
            skew,
            drip,
            fill,
        })
    }))?;
    let tiles = super::budget::collect((0..r.count(8)?).map(|_| {
        let (width, height) = (r.u32()?, r.u32()?);
        if width > MAX_TILE_SIDE || height > MAX_TILE_SIDE {
            return Err(Error::BadSpec);
        }
        let len = width as usize * height as usize * 4;
        Tile::from_rgba(width, height, r.take(len)?).ok_or(Error::BadSpec)
    }))?;
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
            no_fill: flags & 4 != 0,
            fill,
            mesh,
            roughen,
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
