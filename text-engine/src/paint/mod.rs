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
    decode, Align, Band, Fill, Job, Request, Rgba, Run, Stop, Tile, MAGIC, MAX_WEIGHT, WIRE_VERSION,
};
pub use outline::FLATTEN_TOLERANCE;
pub use raster::{Coverage, Exact, Part, Rasterizer, STRIP_ROWS};
pub use scene::Scene;
pub use shape::{align_offset, curved_origin, shape_run, Placed, ShapedRun};
pub use stroke::{Join, Side};

use compose::{compose, Layer};
use shade::Shader;

use crate::engine::{BoldAdvance, Engine, Face, WEBKIT_BOLD_ADVANCE};
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

/// How a synthesised bold is drawn. The references do not agree
/// (P5A-REPORT.md has the measurements and the pictures), and each way
/// belongs to one way of measuring: the engine's `boldAdvance` rule decides
/// both, so the ink the engine measures (`line_ink`) is the ink painted. A
/// request can still name one outright (`boldDraw` in `paint.mjs`), which is
/// for looking at the other and for tests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BoldDraw {
    /// Skia: the outline grown by [`bold_outset`] on every side, joined by
    /// [`BOLD_JOIN`]. Stems and bars thicken alike. Goes with an unchanged
    /// advance.
    #[default]
    Outset,
    /// WebKit: the glyph drawn at its place and again `size / 36` to the
    /// right ([`WEBKIT_BOLD_ADVANCE`]), as one shape. Upright stems thicken
    /// by that much, level bars not at all. Goes with WebKit's wider advance,
    /// which is that same step.
    Smear,
}

impl BoldDraw {
    /// The drawing that goes with a `boldAdvance` rule.
    pub fn for_rule(rule: BoldAdvance) -> Self {
        match rule {
            BoldAdvance::Unchanged => BoldDraw::Outset,
            BoldAdvance::WebKit => BoldDraw::Smear,
        }
    }
}

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

/// One glyph's outline in job space, and what a synthesised bold does to it.
struct GlyphPolys {
    polys: Polys,
    /// Half the pen an outset bold adds, in job units; 0 for none.
    bold: f64,
    /// The step a smeared bold is drawn over, in job space.
    smear: Option<Pt>,
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
        bold_draw: BoldDraw,
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
            let (bold, smear) = match (g.synth.bold, bold_draw) {
                (false, _) => (0.0, None),
                (true, BoldDraw::Outset) => (bold_outset(g.size), None),
                (true, BoldDraw::Smear) => {
                    // To the right in the run's own frame, wherever the
                    // frame has turned that to.
                    let m = &frame.0;
                    let by = g.size * WEBKIT_BOLD_ADVANCE;
                    (0.0, Some(Pt::new(m[0] * by, m[1] * by)))
                }
            };
            self.items.push(GlyphPolys { polys, bold, smear });
        }
        Ok(())
    }

    pub(crate) fn len(&self) -> usize {
        self.items.len()
    }

    /// One glyph's contours moved to `side`: by the bold pen and `extra`
    /// more, then along the smear. `extra` grows with a round join, which is
    /// what a canvas stroke with `lineJoin = "round"` adds.
    ///
    /// A synthesised bold is itself a pen run round the outline, and with a
    /// round join two round pens add up to one wider pen, so a bold glyph
    /// grown by `extra` is the plain outline grown once by both.
    fn moved(g: &GlyphPolys, extra: f64, side: Side, tol: f64) -> Polys {
        let mut out = Polys::default();
        if g.bold > 0.0 && extra > 0.0 && BOLD_JOIN != Join::Round {
            // Two different joins: grow once for the bold, then again.
            let mut bold = Polys::default();
            stroke::grow(&g.polys, g.bold, side, BOLD_JOIN, tol, &mut bold);
            stroke::grow(&bold, extra, side, Join::Round, tol, &mut out);
        } else {
            let join = if extra > 0.0 { Join::Round } else { BOLD_JOIN };
            stroke::grow(&g.polys, g.bold + extra, side, join, tol, &mut out);
        }
        match g.smear {
            Some(v) => {
                let mut swept = Polys::default();
                stroke::sweep(&out, v, side, &mut swept);
                swept
            }
            None => out,
        }
    }

    /// One part per glyph of `range`, in device pixels: the glyph as it is
    /// filled, grown by `extra` job units, or with `ring` the band within
    /// `extra` of that shape's edge (canvas `lineWidth = 2 * extra`).
    ///
    /// Nothing here asks which way a contour runs. Each glyph is handed to
    /// the rasteriser moved both ways and the rasteriser tells grown from
    /// shrunk by the sign of what it sums (`raster.rs`).
    fn parts(
        &self,
        range: core::ops::Range<usize>,
        extra: f64,
        ring: bool,
        transform: &Affine,
        tol: f64,
    ) -> Vec<Part> {
        self.items[range]
            .iter()
            .filter_map(|g| {
                let extra = extra.max(0.0);
                if g.bold + extra <= 0.0 && g.smear.is_none() {
                    // Nothing moves the outline: no band, and the fill as
                    // the font drew it.
                    return (!ring).then(|| Part::plain(g.polys.map(transform)));
                }
                Some(Part {
                    right: Self::moved(g, extra, Side::Right, tol).map(transform),
                    left: Some(Self::moved(g, extra, Side::Left, tol).map(transform)),
                    ring,
                })
            })
            .collect()
    }
}

/// A layer before its coverage is prepared: its parts in device pixels and
/// what to paint them with.
struct Planned<'a> {
    parts: Vec<Part>,
    bx: IBox,
    shader: Shader<'a>,
    alpha: f32,
}

fn plan<'a>(parts: Vec<Part>, shader: Shader<'a>, alpha: f64) -> Option<Planned<'a>> {
    if !positive(alpha) {
        return None;
    }
    if let Some(c) = shader.solid() {
        if c[3] <= 0.0 {
            return None;
        }
    }
    let bx = parts
        .iter()
        .filter_map(Part::pixel_box)
        .reduce(|a, b| a.union(&b))?;
    Some(Planned {
        parts,
        bx,
        shader,
        alpha: alpha.min(1.0) as f32,
    })
}

fn finish(planned: Vec<Planned<'_>>, surface: IBox, rasterizer: &dyn Rasterizer) -> Vec<u8> {
    let mut layers: Vec<Layer<'_>> = planned
        .into_iter()
        .filter_map(|p| {
            let bx = p.bx.intersect(&surface);
            (!bx.is_empty()).then(|| Layer {
                bx,
                cov: rasterizer.prepare(&p.parts, bx),
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
        bold_draw,
        weight,
        transform,
        tiles,
    } = request;
    let face: Face = *face;
    let bold_draw = bold_draw.unwrap_or(BoldDraw::for_rule(engine.rules.bold_advance));
    // Checks that the font exists even when there is nothing to draw.
    engine.font(face.font)?;
    if !transform.is_finite() || transform.invert().is_none() || !positive(face.size) {
        return Ok(None);
    }
    // The flattening tolerance is a distance in device pixels.
    let tol = FLATTEN_TOLERANCE / transform.max_scale();
    // The weight is stated in device pixels and applied in job units, where
    // every other pen is: divided by the scale that keeps areas, which is
    // the scale itself for every transform that does not stretch one way
    // more than another.
    let weight = if positive(*weight) {
        *weight / transform.det().abs().sqrt()
    } else {
        0.0
    };

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
        glyphs.add_run(engine, &shaped, &start, bold_draw, tol)?;
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
        let parts = glyphs.parts(all.clone(), extra + weight, false, transform, tol);
        let shader = Shader::new(&Fill::Solid(color), transform, tiles);
        planned.extend(shader.and_then(|s| plan(parts, s, 1.0)));
    } else {
        for band in &job.bands {
            if !positive(band.line) {
                continue;
            }
            // The band lies round the glyph as it is filled, heavier or not.
            let reach = band.line / 2.0 + weight;
            let parts = glyphs.parts(all.clone(), reach, true, transform, tol);
            let shader = Shader::new(&Fill::Solid(band.color), transform, tiles);
            planned.extend(shader.and_then(|s| plan(parts, s, band.opacity)));
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
            let parts = glyphs.parts(range, weight, false, transform, tol);
            let shader = Shader::new(fill, &transform.after(&frame), tiles);
            planned.extend(shader.and_then(|s| plan(parts, s, 1.0)));
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
