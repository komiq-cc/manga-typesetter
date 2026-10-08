//! The glyph painter: a paint job in, straight-alpha RGBA8 pixels out.
//!
//! [`paint_job`] does what `src/lib/text-engine/browser-painter.js` does
//! with canvas calls, for everything a job can say:
//!
//! ```text
//! job ── shape.rs ──▶ positioned glyphs
//!        outline.rs ─▶ closed polylines in job space, one set per glyph
//!        stroke.rs ──▶ a band's ring, or an outline grown (bold, silhouette)
//!        raster.rs ──▶ coverage of each layer's shape   ◀── the rasteriser
//!        shade.rs ───▶ colour of each covered pixel
//!        compose.rs ─▶ layers over each other, to RGBA8
//! ```
//!
//! A job becomes a few layers, bottom first: one per stroke band, widest
//! first, then the fill (one layer, or one per line or per glyph when each
//! has a fill of its own). Each layer is ONE shape laid down ONCE. That is
//! deliberate and it is where this painter parts from the canvas, which
//! strokes every line and every glyph on its own: a translucent band is one
//! even tone here, where on a canvas it is darker wherever the strokes of
//! two neighbouring glyphs or lines overlap.

mod compose;
mod geom;
mod job;
mod outline;
mod raster;
mod scene;
mod shade;
mod shape;
mod stroke;

#[cfg(any(
    feature = "raster-tiny-skia",
    feature = "raster-zeno",
    feature = "raster-vello"
))]
#[path = "raster_compare.rs"]
pub mod compare;

use geom::positive;
pub use geom::{Affine, IBox, Polys, Pt};
pub use job::{
    decode, Align, Band, Fill, Job, Request, Rgba, Run, Stop, Tile, MAGIC, WIRE_VERSION,
};
pub use outline::FLATTEN_TOLERANCE;
pub use raster::{Coverage, Exact, Rasterizer, STRIP_ROWS};
pub use scene::Scene;
pub use shape::{align_offset, curved_origin, shape_run, Placed, ShapedRun};
pub use stroke::{Join, Side};

use compose::{compose, Layer};
use shade::Shader;

use crate::engine::{Engine, Face};
use crate::font::OBLIQUE_SKEW;
use crate::metrics::bold_outset;
use crate::Error;

/// Largest surface side accepted. A guard against a bad job asking for
/// gigabytes, not a design limit.
pub const MAX_SIDE: u32 = 16384;

/// Largest surface accepted, in pixels: 256 MB of RGBA.
pub const MAX_PIXELS: usize = 1 << 26;

/// How a synthesised bold joins its outline at a corner.
///
/// The one place this is decided. Skia mitres (SPIKE.md rule 8); the
/// engine's metrics (`bold_outset`, `line_ink`) assume a round join, which
/// grows every edge of the ink box by exactly one outset, and so does the
/// painter. To follow Skia instead, change this to
/// `Join::Miter { limit: .. }` and widen the bold ink box in `metrics.rs` to
/// match; a stroke band outside a mitred bold would then also need the
/// mitred outline as its base (see `Glyphs::band`).
pub const BOLD_JOIN: Join = Join::Round;

/// The pixels a job paints.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Raster {
    /// Device pixel of the top-left corner.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// Straight-alpha RGBA8, row by row from the top.
    pub data: Vec<u8>,
}

/// One glyph's outline in job space, and which way is out.
struct GlyphPolys {
    polys: Polys,
    /// The side of its contours that faces away from the ink.
    out: Side,
    /// Half the pen a synthesised bold adds, in job units; 0 for none.
    bold: f64,
}

/// The outlines of a job's glyphs, and the shapes made from them.
#[derive(Default)]
pub(crate) struct Glyphs {
    items: Vec<GlyphPolys>,
}

impl Glyphs {
    /// Adds the glyphs of a shaped run. `frame` maps the run's own frame
    /// (origin at its start on the baseline, y down) to job space.
    pub(crate) fn add_run(
        &mut self,
        engine: &Engine,
        run: &ShapedRun,
        frame: &Affine,
        tol: f64,
    ) -> Result<(), Error> {
        for g in &run.glyphs {
            let entry = engine.font(g.font)?;
            let per_unit = g.size / f64::from(entry.info.units_per_em);
            let skew = if g.synth.oblique {
                f64::from(OBLIQUE_SKEW)
            } else {
                0.0
            };
            let mut polys = Polys::default();
            let place = frame.after(&Affine::translate(g.x, g.y));
            outline::glyph_polys(entry, g.glyph, &place, per_unit, skew, tol, &mut polys);
            if polys.is_empty() {
                continue;
            }
            // Ink lies to the left of a contour walked anticlockwise in the
            // sense of `(-dy, dx)`, which is when the area is positive.
            // Holes run the other way round and get the same answer, which
            // is right: away from the ink is into the hole.
            let out = if polys.area2() > 0.0 {
                Side::Right
            } else {
                Side::Left
            };
            self.items.push(GlyphPolys {
                polys,
                out,
                bold: if g.synth.bold {
                    bold_outset(g.size)
                } else {
                    0.0
                },
            });
        }
        Ok(())
    }

    pub(crate) fn len(&self) -> usize {
        self.items.len()
    }

    /// The glyphs `range` as they are filled: the outline, grown by the
    /// bold pen and by `extra` more. `extra` grows with a round join, which
    /// is what a canvas stroke with `lineJoin = "round"` adds.
    fn solid(&self, range: core::ops::Range<usize>, extra: f64, tol: f64) -> Polys {
        let mut out = Polys::default();
        for g in &self.items[range] {
            if g.bold > 0.0 && extra > 0.0 && BOLD_JOIN != Join::Round {
                // Two different joins: grow once for the bold, then again.
                let mut bold = Polys::default();
                stroke::grow(&g.polys, g.bold, g.out, BOLD_JOIN, tol, &mut bold);
                stroke::grow(&bold, extra, g.out, Join::Round, tol, &mut out);
            } else {
                let join = if extra > 0.0 { Join::Round } else { BOLD_JOIN };
                stroke::grow(&g.polys, g.bold + extra, g.out, join, tol, &mut out);
            }
        }
        out
    }

    /// The ring a band of canvas `lineWidth = line` covers around the glyphs
    /// `range`: everything within half of it of the outline, on both sides.
    /// Returned as the two shapes of `stroke::stroke_sides`.
    ///
    /// A synthesised bold is itself a pen run round the outline, and with a
    /// round join two round pens add up to one wider pen, so the band of a
    /// bold glyph is one stroke of the plain outline.
    fn band(&self, range: core::ops::Range<usize>, line: f64, tol: f64) -> (Polys, Polys) {
        let (mut outer, mut inner) = (Polys::default(), Polys::default());
        for g in &self.items[range] {
            let radius = line / 2.0 + g.bold;
            stroke::stroke_sides(
                &g.polys,
                radius,
                g.out,
                Join::Round,
                tol,
                &mut outer,
                &mut inner,
            );
        }
        (outer, inner)
    }
}

/// The whole-pixel box that holds `polys`, or `None` if they hold nothing.
fn pixel_box(polys: &Polys) -> Option<IBox> {
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

/// A layer before its coverage is prepared: a shape in device pixels and
/// what to paint it with.
struct Planned<'a> {
    polys: Polys,
    /// For a stroke: its inner shape, to be taken out of `polys`.
    minus: Option<Polys>,
    bx: IBox,
    shader: Shader<'a>,
    alpha: f32,
}

fn plan<'a>(
    shape: &Polys,
    transform: &Affine,
    shader: Shader<'a>,
    alpha: f64,
) -> Option<Planned<'a>> {
    if !positive(alpha) {
        return None;
    }
    if let Some(c) = shader.solid() {
        if c[3] <= 0.0 {
            return None;
        }
    }
    let polys = shape.map(transform);
    let bx = pixel_box(&polys)?;
    Some(Planned {
        polys,
        minus: None,
        bx,
        shader,
        alpha: alpha.min(1.0) as f32,
    })
}

/// [`plan`] for a stroke given as its outer and inner shapes.
fn plan_ring<'a>(
    outer: &Polys,
    inner: &Polys,
    transform: &Affine,
    shader: Shader<'a>,
    alpha: f64,
) -> Option<Planned<'a>> {
    let mut planned = plan(outer, transform, shader, alpha)?;
    planned.minus = Some(inner.map(transform));
    Some(planned)
}

fn finish(planned: Vec<Planned<'_>>, surface: IBox, rasterizer: &dyn Rasterizer) -> Vec<u8> {
    let mut layers: Vec<Layer<'_>> = planned
        .into_iter()
        .filter_map(|p| {
            let bx = p.bx.intersect(&surface);
            (!bx.is_empty()).then(|| Layer {
                bx,
                cov: match &p.minus {
                    Some(inner) => rasterizer.prepare_ring(&p.polys, inner, bx),
                    None => rasterizer.prepare(&p.polys, bx),
                },
                shader: p.shader,
                alpha: p.alpha,
            })
        })
        .collect();
    compose(&mut layers, surface)
}

/// Paints one job with the exact-area rasteriser.
///
/// Returns the pixels and where they go, in a raster no larger than the ink
/// (strokes included) needs, or `None` when the job draws nothing.
pub fn paint_job(engine: &mut Engine, request: &Request) -> Result<Option<Raster>, Error> {
    paint_job_with(engine, request, &Exact)
}

/// [`paint_job`] with a rasteriser of the caller's choice.
pub fn paint_job_with(
    engine: &mut Engine,
    request: &Request,
    rasterizer: &dyn Rasterizer,
) -> Result<Option<Raster>, Error> {
    let Request {
        job,
        face,
        transform,
        tiles,
    } = request;
    let face: Face = *face;
    // Checks that the font exists even when there is nothing to draw.
    engine.font(face.font)?;
    if !transform.is_finite() || transform.invert().is_none() || !positive(face.size) {
        return Ok(None);
    }
    // The flattening tolerance is a distance in device pixels.
    let tol = FLATTEN_TOLERANCE / transform.max_scale();

    // Every run's glyphs, and for each run the frame its fill is stated in.
    let mut glyphs = Glyphs::default();
    let mut runs: Vec<(core::ops::Range<usize>, Affine)> = Vec::with_capacity(job.runs.len());
    for run in &job.runs {
        let spacing = if job.curved { 0.0 } else { job.letter_spacing };
        let shaped = shape_run(engine, face, &run.text, spacing)?;
        let frame = if job.curved {
            // translate(x, y); rotate(rot); the glyph centred on the origin.
            let (sin, cos) = run.rot.sin_cos();
            Affine::translate(run.x, run.y).after(&Affine::rotate(cos, sin))
        } else {
            Affine::IDENTITY
        };
        let start = if job.curved {
            let (dx, dy) = curved_origin(engine, face, shaped.advance)?;
            frame.after(&Affine::translate(dx, dy))
        } else {
            Affine::translate(run.x + align_offset(job.align, shaped.advance), run.y)
        };
        let from = glyphs.len();
        glyphs.add_run(engine, &shaped, &start, tol)?;
        runs.push((from..glyphs.len(), frame));
    }
    let all = 0..glyphs.len();
    if all.is_empty() {
        return Ok(None);
    }

    let mut planned: Vec<Planned<'_>> = Vec::new();
    if let Some(color) = job.silhouette {
        // The glyphs and their widest band as one solid shape: grown by
        // half that band's pen, not a stroke laid over a fill.
        let extra = job.bands.first().map_or(0.0, |b| (b.line / 2.0).max(0.0));
        let shape = glyphs.solid(all.clone(), extra, tol);
        let shader = Shader::new(&Fill::Solid(color), transform, tiles);
        planned.extend(shader.and_then(|s| plan(&shape, transform, s, 1.0)));
    } else {
        for band in &job.bands {
            if !positive(band.line) {
                continue;
            }
            let (outer, inner) = glyphs.band(all.clone(), band.line, tol);
            let shader = Shader::new(&Fill::Solid(band.color), transform, tiles);
            planned
                .extend(shader.and_then(|s| plan_ring(&outer, &inner, transform, s, band.opacity)));
        }
        // One fill layer per run of glyphs that share a fill. A job-wide
        // fill is one layer; per-line and per-glyph fills are one each,
        // except that neighbours with the same flat colour are merged.
        let mut groups: Vec<(core::ops::Range<usize>, &Fill, Affine)> = Vec::new();
        for (run, (range, frame)) in job.runs.iter().zip(&runs) {
            // A run's own fill is stated in the run's frame, the job's in
            // the job's.
            let (fill, frame) = match (&run.fill, &job.fill) {
                (Some(fill), _) => (fill, *frame),
                (None, Some(fill)) => (fill, Affine::IDENTITY),
                (None, None) => continue,
            };
            match groups.last_mut() {
                // A flat colour is the same in every frame.
                Some((r, f, fr))
                    if *f == fill && (*fr == frame || matches!(fill, Fill::Solid(_))) =>
                {
                    r.end = range.end;
                }
                _ => groups.push((range.clone(), fill, frame)),
            }
        }
        for (range, fill, frame) in groups {
            if range.is_empty() {
                continue;
            }
            let shape = glyphs.solid(range, 0.0, tol);
            let shader = Shader::new(fill, &transform.after(&frame), tiles);
            planned.extend(shader.and_then(|s| plan(&shape, transform, s, 1.0)));
        }
    }

    let Some(surface) = planned.iter().map(|p| p.bx).reduce(|a, b| a.union(&b)) else {
        return Ok(None);
    };
    let (width, height) = (surface.width(), surface.height());
    if width > MAX_SIDE as usize || height > MAX_SIDE as usize || width * height > MAX_PIXELS {
        return Err(Error::BadSpec);
    }
    let data = finish(planned, surface, rasterizer);
    Ok(Some(Raster {
        x: surface.x0,
        y: surface.y0,
        width: width as u32,
        height: height as u32,
        data,
    }))
}
