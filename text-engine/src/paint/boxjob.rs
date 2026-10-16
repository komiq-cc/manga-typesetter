//! A box job: one box of the page, finished, in one call.
//!
//! A glyph job ([`paint_job`](super::paint_job)) paints a box's letters,
//! their bands and their fills. A box is more than that: its shadows lie
//! under the letters, a blur and a smear lie over the whole, and a mask cuts
//! what is shown. The canvas used to lay those over the engine's glyphs
//! (`paintShadows`, `applyTextFilters` and `drawClipShapes` in the app), a
//! pass each, in a different way in every browser. A box job states them
//! beside the glyph job and the engine does all of it:
//!
//! ```text
//! shadows   last in the style first: the job as a silhouette, blurred,
//!           moved, laid at its opacity
//! glyphs    the job itself, over them
//! blur      a gaussian over the whole
//! smear     a weighted sum of moved copies (the motion blur)
//! mask      shapes that keep, or cut, what they cover
//! ```
//!
//! Every length is in the job's own units and the job's transform carries
//! it to pixels: a shadow's throw through its linear part, a blur's radius
//! by the scale that keeps areas. So a box painted larger, turned or
//! mirrored is the same request with another transform, and its shadow
//! turns with it.
//!
//! [`decode_box`] reads the wire form `encodeBox` in
//! `text-engine/js/paint.mjs` writes.

use super::blur::{self, Moved, Surface};
use super::geom::{positive, Affine, IBox, Polys, Pt};
use super::job::{decode, Fill, Request, Rgba};
use super::raster::{Part, Rasterizer};
use super::shade::Shader;
use super::{
    budget, finish, magnified, paint_job_with, plan, Exact, Planned, Raster, FLATTEN_TOLERANCE,
};
use super::{MAX_PIXELS, MAX_SIDE};
use crate::engine::Engine;
use crate::Error;

/// "MTPB", little-endian.
pub const BOX_MAGIC: u32 = 0x4250_544d;
pub const BOX_WIRE_VERSION: u32 = 1;

/// A guard, not a design limit: the app writes at most 129 taps. Shadows and
/// the mask's shapes and points have no count of their own: the app lets a
/// style have as many shadows as a person adds and a mask as many strokes,
/// as long, as a person draws, and the canvas paints every one, so a count
/// here would be a box the engine will not paint. What bounds them is what
/// bounds any record, the bytes they arrive in and the painter's budget, and
/// one layer serves every shadow (`paint_box_with`), so the 17th costs its 36
/// bytes and its time and no more memory than the first.
pub const MAX_TAPS: usize = 512;
/// Largest blur, and largest distance a shadow or a tap may state, in job
/// units.
pub const MAX_BLUR: f64 = 4096.0;
pub const MAX_THROW: f64 = 65536.0;

/// One shadow of the box (`style.shadows`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shadow {
    pub color: Rgba,
    pub opacity: f64,
    /// How far it is thrown, job units.
    pub x: f64,
    pub y: f64,
    /// A canvas shadow's `blur`: twice the gaussian's sigma, job units.
    pub blur: f64,
}

/// One copy in the motion blur's sum (`motionBlurTaps`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tap {
    pub dx: f64,
    pub dy: f64,
    pub weight: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClipMode {
    /// Only what the shapes cover is shown.
    Include,
    /// What the shapes cover is not.
    Exclude,
}

/// One shape of the mask (`style.clip.shapes`), in the box's own units from
/// its top-left corner.
#[derive(Clone, Debug, PartialEq)]
pub enum ClipShape {
    Ellipse { centre: Pt, rx: f64, ry: f64 },
    /// Closed, filled by the non-zero rule.
    Polygon(Vec<Pt>),
    /// A line `size` wide with round caps and joins; one point is a dot.
    Stroke { size: f64, pts: Vec<Pt> },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Clip {
    pub mode: ClipMode,
    /// The box's corner in job space: the shapes are stated from it.
    pub origin: Pt,
    pub shapes: Vec<ClipShape>,
}

/// A decoded box job.
pub struct BoxRequest {
    /// The surface, device pixels. Its corner is device `(0, 0)`.
    pub width: u32,
    pub height: u32,
    /// First on top.
    pub shadows: Vec<Shadow>,
    /// The whole-box blur: a gaussian's sigma, job units. Zero for none.
    pub blur: f64,
    pub taps: Vec<Tap>,
    pub clip: Option<Clip>,
    /// The glyph job, and the transform everything above is carried by.
    pub request: Request,
}

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

    /// A finite number, as in a glyph job.
    fn f64(&mut self) -> Result<f64, Error> {
        let b = self.take(8)?;
        let v = f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
        if v.is_finite() {
            Ok(v)
        } else {
            Err(Error::BadSpec)
        }
    }

    /// A number within `max` of zero.
    fn within(&mut self, max: f64) -> Result<f64, Error> {
        let v = self.f64()?;
        if v.abs() <= max {
            Ok(v)
        } else {
            Err(Error::BadSpec)
        }
    }

    /// A number from 0 to `max`.
    fn upto(&mut self, max: f64) -> Result<f64, Error> {
        let v = self.f64()?;
        if (0.0..=max).contains(&v) {
            Ok(v)
        } else {
            Err(Error::BadSpec)
        }
    }

    fn pt(&mut self) -> Result<Pt, Error> {
        Ok(Pt::new(self.within(MAX_THROW)?, self.within(MAX_THROW)?))
    }

    /// A count of at most `max` records of at least `min_size` bytes each,
    /// checked against what is left before anything is allocated.
    fn count(&mut self, max: usize, min_size: usize) -> Result<usize, Error> {
        let n = self.u32()? as usize;
        let left = self.bytes.len() - self.at;
        if n > max || n.checked_mul(min_size).ok_or(Error::BadSpec)? > left {
            return Err(Error::BadSpec);
        }
        Ok(n)
    }

    fn pts(&mut self) -> Result<Vec<Pt>, Error> {
        let n = self.count(usize::MAX, 16)?;
        budget::collect((0..n).map(|_| self.pt()))
    }

    fn shape(&mut self) -> Result<ClipShape, Error> {
        Ok(match self.u32()? {
            1 => ClipShape::Ellipse {
                centre: self.pt()?,
                rx: self.within(MAX_THROW)?,
                ry: self.within(MAX_THROW)?,
            },
            2 => ClipShape::Polygon(self.pts()?),
            3 => ClipShape::Stroke {
                size: self.upto(MAX_THROW)?,
                pts: self.pts()?,
            },
            _ => return Err(Error::BadSpec),
        })
    }
}

/// Reads one box job from its wire form.
///
/// ```text
/// u32 magic, u32 version
/// u32 width, u32 height        the surface, device pixels; its corner is (0, 0)
/// u32 shadow count, then per shadow, first in the style first:
///     rgba colour, f64 opacity, f64 x, y, f64 blur
/// f64 blur                     the whole-box blur; 0 for none
/// u32 tap count, then per tap: f64 dx, dy, f64 weight
/// u32 clip mode                0 none, 1 include, 2 exclude; when not 0:
///     f64 ox, oy               the box's corner in job space
///     u32 shape count, then per shape: u32 kind, then
///       1 ellipse: f64 cx, cy, rx, ry
///       2 polygon: u32 n, then n points (f64 x, y)
///       3 stroke:  f64 size, u32 n, then n points; one point is a dot
/// u32 job byte length, then a glyph job in its own wire form
/// ```
///
/// Refused: a surface with no size or past the painter's guards, more than
/// 512 taps, a count the bytes cannot hold, an opacity or a weight outside 0 to
/// 1, a blur outside 0 to 4096, a throw, a tap or a point further than 65536
/// from zero, and anything a glyph job is refused for.
pub fn decode_box(bytes: &[u8]) -> Result<BoxRequest, Error> {
    let mut r = Reader { bytes, at: 0 };
    if r.u32()? != BOX_MAGIC || r.u32()? != BOX_WIRE_VERSION {
        return Err(Error::BadSpec);
    }
    let (width, height) = (r.u32()?, r.u32()?);
    if width == 0
        || height == 0
        || width > MAX_SIDE
        || height > MAX_SIDE
        || width as usize * height as usize > MAX_PIXELS
    {
        return Err(Error::BadSpec);
    }
    let n = r.count(usize::MAX, 36)?;
    let shadows = budget::collect((0..n).map(|_| {
        let b = r.take(4)?;
        Ok(Shadow {
            color: Rgba([b[0], b[1], b[2], b[3]]),
            opacity: r.upto(1.0)?,
            x: r.within(MAX_THROW)?,
            y: r.within(MAX_THROW)?,
            blur: r.upto(MAX_BLUR)?,
        })
    }))?;
    let blur = r.upto(MAX_BLUR)?;
    let n = r.count(MAX_TAPS, 24)?;
    let taps = budget::collect((0..n).map(|_| {
        Ok(Tap {
            dx: r.within(MAX_THROW)?,
            dy: r.within(MAX_THROW)?,
            weight: r.upto(1.0)?,
        })
    }))?;
    let clip = match r.u32()? {
        0 => None,
        mode @ (1 | 2) => {
            let origin = r.pt()?;
            let n = r.count(usize::MAX, 4)?;
            Some(Clip {
                mode: if mode == 1 {
                    ClipMode::Include
                } else {
                    ClipMode::Exclude
                },
                origin,
                shapes: budget::collect((0..n).map(|_| r.shape()))?,
            })
        }
        _ => return Err(Error::BadSpec),
    };
    let len = r.u32()? as usize;
    let request = decode(r.take(len)?)?;
    if r.at != bytes.len() {
        return Err(Error::BadSpec);
    }
    Ok(BoxRequest {
        width,
        height,
        shadows,
        blur,
        taps,
        clip,
        request,
    })
}

/// A circle of radius `r` about `c` as a closed polygon that stays within
/// `tol` of it.
fn disc(out: &mut Polys, c: Pt, rx: f64, ry: f64, tol: f64) {
    let r = rx.abs().max(ry.abs());
    if !positive(r) {
        return;
    }
    // A chord across an angle `t` leaves the arc by `r (1 - cos(t / 2))`.
    let step = if tol < r {
        2.0 * (1.0 - tol / r).acos()
    } else {
        core::f64::consts::FRAC_PI_2
    };
    let n = (core::f64::consts::TAU / step).ceil().clamp(8.0, 4096.0) as usize;
    for i in 0..n {
        let (sin, cos) = (core::f64::consts::TAU * i as f64 / n as f64).sin_cos();
        out.push(Pt::new(c.x + rx * cos, c.y + ry * sin));
    }
    out.close();
}

/// The mask's shapes as parts in job space, one part to a piece: a part
/// fills what its own contours wind round whichever way they run, and parts
/// are united, so a stroke's segments and the discs at its joints make one
/// line and not a darker patch where they overlap.
fn clip_parts(clip: &Clip, tol: f64) -> Result<budget::Buffer<Polys>, Error> {
    let mut out = budget::Buffer::new();
    let at = |p: Pt| p.plus(clip.origin);
    for shape in &clip.shapes {
        match shape {
            ClipShape::Ellipse { centre, rx, ry } => {
                let mut polys = Polys::default();
                disc(&mut polys, at(*centre), *rx, *ry, tol);
                budget::push(&mut out, polys)?;
            }
            ClipShape::Polygon(pts) => {
                let mut polys = Polys::default();
                for p in pts {
                    polys.push(at(*p));
                }
                polys.close();
                budget::push(&mut out, polys)?;
            }
            ClipShape::Stroke { size, pts } => {
                let r = size / 2.0;
                if !positive(r) {
                    continue;
                }
                for (i, p) in pts.iter().enumerate() {
                    let mut polys = Polys::default();
                    disc(&mut polys, at(*p), r, r, tol);
                    budget::push(&mut out, polys)?;
                    let Some(q) = pts.get(i + 1) else {
                        continue;
                    };
                    let d = q.minus(*p);
                    let len = d.len();
                    if !positive(len) {
                        continue;
                    }
                    let n = Pt::new(-d.y, d.x).scale(r / len);
                    let mut polys = Polys::default();
                    for corner in [p.plus(n), q.plus(n), q.minus(n), p.minus(n)] {
                        polys.push(at(corner));
                    }
                    polys.close();
                    budget::push(&mut out, polys)?;
                }
            }
        }
        budget::check()?;
    }
    Ok(out)
}

/// The mask's coverage over the surface: straight RGBA8 whose alpha is the
/// share of each pixel the shapes cover, and the box of pixels it is for.
/// `None` when the shapes cover nothing of the surface.
fn clip_mask(
    clip: &Clip,
    request: &Request,
    surface: IBox,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<(Vec<u8>, IBox)>, Error> {
    let transform = &request.transform;
    // The shapes are the box's, so the box's mesh bends them with its
    // letters, and enlarges them as it does the letters (`magnified`).
    let mesh = match &request.job.mesh {
        Some(m) => m.map()?,
        None => None,
    };
    let tol = FLATTEN_TOLERANCE / (transform.max_scale() * magnified(mesh.as_ref()));
    let mut parts = budget::Buffer::new();
    for polys in clip_parts(clip, tol)?.iter() {
        let placed = match (&mesh, polys.bounds()) {
            (Some(m), Some(bounds)) => {
                super::warp::bend(polys, |p| m.at(p), m.cut(bounds, tol), tol)?.map(transform)
            }
            _ => polys.map(transform),
        };
        if !placed.is_empty() {
            budget::push(&mut parts, Part::plain(placed))?;
        }
    }
    const OPAQUE: Fill = Fill::Solid(Rgba([255, 255, 255, 255]));
    let Some(planned) =
        Shader::new(&OPAQUE, &Affine::IDENTITY, &[]).and_then(|s| plan(parts, s, 1.0))
    else {
        return Ok(None);
    };
    let bx = planned.bx.intersect(&surface);
    if bx.is_empty() {
        return Ok(None);
    }
    let mut layers: budget::Buffer<Planned<'_>> = budget::Buffer::new();
    budget::push(&mut layers, planned)?;
    Ok(Some((finish(layers, bx, rasterizer)?, bx)))
}

/// A raster cut to `surface`, or `None` when nothing of it is inside.
fn cut(r: Raster, surface: IBox) -> Result<Option<Raster>, Error> {
    let have = IBox {
        x0: r.x,
        y0: r.y,
        x1: r.x.saturating_add(r.width as i32),
        y1: r.y.saturating_add(r.height as i32),
    };
    let bx = have.intersect(&surface);
    if bx.is_empty() {
        return Ok(None);
    }
    if bx == have {
        return Ok(Some(r));
    }
    let mut data = budget::filled(bx.width() * bx.height() * 4, 0u8)?;
    let n = bx.width() * 4;
    for (row, y) in (bx.y0..bx.y1).enumerate() {
        let from = ((y - r.y) as usize * r.width as usize + (bx.x0 - r.x) as usize) * 4;
        data[row * n..(row + 1) * n].copy_from_slice(&r.data[from..from + n]);
    }
    Ok(Some(Raster {
        x: bx.x0,
        y: bx.y0,
        width: bx.width() as u32,
        height: bx.height() as u32,
        data: data.into_vec(),
    }))
}

/// Paints one box job with the exact-area rasteriser.
///
/// Returns the pixels and where they go: the smallest raster that holds
/// every pixel with any alpha, cut to the surface, or `None` when the box
/// draws nothing. The request is handed back as it came.
pub fn paint_box(engine: &mut Engine, request: &mut BoxRequest) -> Result<Option<Raster>, Error> {
    paint_box_with(engine, request, &Exact)
}

/// [`paint_box`] with a rasteriser of the caller's choice.
pub fn paint_box_with(
    engine: &mut Engine,
    request: &mut BoxRequest,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<Raster>, Error> {
    let _budget = budget::Scope::new();
    let (width, height) = (request.width as usize, request.height as usize);
    if width == 0
        || height == 0
        || width > MAX_SIDE as usize
        || height > MAX_SIDE as usize
        || width * height > MAX_PIXELS
    {
        return Err(Error::BadSpec);
    }
    let surface = IBox {
        x0: 0,
        y0: 0,
        x1: width as i32,
        y1: height as i32,
    };
    let transform = request.request.transform;
    // Lengths are carried by the scale that keeps areas, vectors by the
    // transform's linear part.
    let scale = transform.det().abs().sqrt();
    let carried = |x: f64, y: f64| {
        let m = &transform.0;
        (m[0] * x + m[2] * y, m[1] * x + m[3] * y)
    };
    let shadows = request.shadows.iter().filter(|s| positive(s.opacity));
    let taps = request.taps.iter().filter(|t| positive(t.weight));
    let blur_sigma = request.blur * scale;
    if shadows.clone().next().is_none()
        && !positive(blur_sigma)
        && taps.clone().next().is_none()
        && request.clip.is_none()
    {
        // Nothing but glyphs: the glyph job, and its own raster.
        return match paint_job_with(engine, &request.request, rasterizer)? {
            Some(r) => cut(r, surface),
            None => Ok(None),
        };
    }
    if !scale.is_finite() || !positive(scale) {
        return Ok(None);
    }

    let mut s = Surface::new(width, height)?;
    // Shadows, the last first, so the first is on top of the rest. One
    // layer serves them all.
    let mut layer: Option<Surface> = None;
    let job_silhouette = request.request.job.silhouette;
    for sh in request.shadows.iter().rev().filter(|s| positive(s.opacity)) {
        request.request.job.silhouette = Some(sh.color);
        let painted = paint_job_with(engine, &request.request, rasterizer);
        request.request.job.silhouette = job_silhouette;
        let Some(r) = painted? else {
            continue;
        };
        let layer = match &mut layer {
            Some(l) => {
                l.clear();
                l
            }
            none => none.insert(Surface::new(width, height)?),
        };
        layer.draw(&r.data, r.width as usize, r.x, r.y);
        drop(r);
        // A silhouette is one colour, so only its alpha needs the blur.
        let [r, g, b, _] = sh.color.0;
        blur::gaussian_flat(layer, sh.blur / 2.0 * scale, [r, g, b])?;
        blur::over_moved(&mut s, layer, carried(sh.x, sh.y), sh.opacity)?;
    }
    drop(layer);

    if let Some(r) = paint_job_with(engine, &request.request, rasterizer)? {
        s.draw(&r.data, r.width as usize, r.x, r.y);
    }
    blur::gaussian(&mut s, blur_sigma)?;
    if taps.clone().next().is_some() {
        let mut moves = budget::Buffer::new();
        for t in taps {
            let (dx, dy) = carried(t.dx, t.dy);
            budget::push(
                &mut moves,
                Moved {
                    dx,
                    dy,
                    weight: t.weight,
                },
            )?;
        }
        blur::sum_moved(&mut s, &moves)?;
    }
    if let Some(clip) = &request.clip {
        let keep_outside = clip.mode == ClipMode::Exclude;
        match clip_mask(clip, &request.request, surface, rasterizer)? {
            Some((mask, bx)) => blur::mask(&mut s, &mask, bx, keep_outside),
            // Shapes that cover nothing keep nothing, or cut nothing.
            None if keep_outside => {}
            None => s.clear(),
        }
    }

    let Some(ink) = s.ink() else {
        return Ok(None);
    };
    Ok(Some(Raster {
        x: ink.x0,
        y: ink.y0,
        width: ink.width() as u32,
        height: ink.height() as u32,
        data: s.straight(ink)?,
    }))
}
