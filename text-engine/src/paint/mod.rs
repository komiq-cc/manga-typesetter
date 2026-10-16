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

mod blur;
mod boxjob;
pub(crate) mod budget;
mod compose;
mod geom;
mod job;
mod outline;
mod pattern;
mod raster;
mod roughen;
mod scene;
mod shade;
mod shape;
mod stroke;
mod warp;

#[cfg(any(
    feature = "raster-tiny-skia",
    feature = "raster-zeno",
    feature = "raster-vello"
))]
#[path = "raster_compare.rs"]
pub mod compare;

use geom::positive;
pub use boxjob::{
    decode_box, paint_box, paint_box_with, BoxRequest, Clip, ClipMode, ClipShape, Shadow, Tap,
    BOX_MAGIC, BOX_WIRE_VERSION,
};
pub use geom::{Affine, IBox, Polys, Pt};
pub use job::{
    decode, Align, Band, Fill, Job, Request, Rgba, Run, Stop, Tile, MAGIC, MAX_WEIGHT, WIRE_VERSION,
};
pub use outline::FLATTEN_TOLERANCE;
pub use pattern::{tile as pattern_tile, Kind as PatternKind, MAX_TILE_SIDE};
pub use raster::{Coverage, Exact, Part, Rasterizer, STRIP_ROWS};
pub use roughen::Roughen;
pub use scene::Scene;
pub use shape::{align_offset, curved_origin, shape_run, Placed, ShapedRun};
pub use stroke::{Join, Side};
pub use warp::{Mesh, MAX_MESH_SIDE};
use warp::Cut;

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
pub use budget::MAX_PAINT_BYTES;

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

/// What bends every outline of a job, after the glyph's own drip: the box's
/// roughening, stated in the unbent box, and then its mesh.
#[derive(Clone, Copy, Default)]
pub(crate) struct Bends<'a> {
    pub rough: Option<&'a roughen::RoughMap>,
    pub mesh: Option<&'a warp::MeshMap<'a>>,
}

/// One glyph's outline in job space, and what a synthesised bold does to it.
struct GlyphPolys {
    polys: Polys,
    /// Half the pen an outset bold adds, in job units; 0 for none.
    bold: f64,
    /// The step a smeared bold is drawn over, in job space.
    smear: Option<Pt>,
    /// The letter's drip: the lower half of this outline pulled down.
    drip: Option<warp::Drip>,
}

impl GlyphPolys {
    /// `polys`, which are this glyph's contours as they are or moved, where
    /// they are painted: through the letter's drip, then the box's
    /// roughening, then its mesh, then `transform`. The bends come after the
    /// outline is moved, so a band bends with the letter it is a stroke of.
    fn placed(
        &self,
        polys: &Polys,
        bends: Bends<'_>,
        transform: &Affine,
        tol: f64,
    ) -> Result<Polys, Error> {
        let Some(bounds) = polys.bounds() else {
            return Ok(polys.map(transform));
        };
        let (drip, rough, mesh) = (self.drip, bends.rough, bends.mesh);
        let cuts = [
            drip.map(|d| d.cut(tol)),
            rough.map(|r| r.cut(tol)),
            mesh.map(|m| m.cut(bounds, tol)),
        ];
        let mut cuts = cuts.into_iter().flatten();
        // Nothing bends: the numbers a job always had.
        let Some(first) = cuts.next() else {
            return Ok(polys.map(transform));
        };
        // One map is cut as that map asks; one after another, by the finer
        // cut of them all.
        let cut = cuts.fold(first, Cut::both);
        let map = |p: Pt| {
            let p = drip.map_or(p, |d| d.at(p));
            let p = rough.map_or(p, |r| r.at(p));
            mesh.map_or(p, |m| m.at(p))
        };
        Ok(warp::bend(polys, map, cut, tol)?.map(transform))
    }

    /// Whether the mesh turns this glyph over.
    fn mirrored(&self, mesh: Option<&warp::MeshMap<'_>>) -> bool {
        mesh.is_some_and(|m| self.tangent(m).det() < 0.0)
    }

    /// The affine map that is the mesh over this glyph: where its middle
    /// goes, and how the plane is stretched and turned across it.
    fn tangent(&self, mesh: &warp::MeshMap<'_>) -> Affine {
        self.polys
            .bounds()
            .map_or(Affine::IDENTITY, |b| mesh.tangent_over(b))
    }
}

/// The outlines of a job's glyphs, and the shapes made from them.
#[derive(Default)]
pub(crate) struct Glyphs {
    items: budget::Buffer<GlyphPolys>,
}

impl Glyphs {
    /// Adds the glyphs of a shaped run. `frame` maps the run's own frame
    /// (origin at its start on the baseline, y down) to job space. `drip`
    /// pulls the lower half of every glyph of the run down by that many job
    /// units: from the middle of the glyph's own height, as it stands in job
    /// space, to its foot. Zero for none.
    pub(crate) fn add_run(
        &mut self,
        engine: &Engine,
        run: &ShapedRun,
        frame: &Affine,
        bold_draw: BoldDraw,
        drip: f64,
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
            budget::check()?;
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
            budget::check()?;
            let drip = match polys.bounds() {
                Some((_, top, _, bottom)) if positive(drip) && bottom > top => Some(warp::Drip {
                    mid: (top + bottom) / 2.0,
                    bottom,
                    pull: drip,
                }),
                _ => None,
            };
            budget::push(
                &mut self.items,
                GlyphPolys {
                    polys,
                    bold,
                    smear,
                    drip,
                },
            )?;
        }
        Ok(())
    }

    pub(crate) fn account(&mut self) -> Result<(), Error> {
        self.items.account()?;
        for g in &mut self.items {
            g.polys.pts.account()?;
            g.polys.ends.account()?;
        }
        Ok(())
    }

    pub(crate) fn truncate(&mut self, len: usize) {
        self.items.truncate(len);
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
    ///
    /// The same holds inwards, and that is a choice: a band round a bold
    /// glyph reaches the bold pen and its own into the outline the font
    /// has, not its own pen into the bolder shape. It is what each
    /// reference does. Skia strokes the font's outline with a pen wider by
    /// the bold's (measured), and WebKit strokes it once at its place and
    /// once a step on, which is the band of the plain glyph smeared. Only a
    /// band seen through a fill that is not opaque shows the difference
    /// (`parity/band-shape.mjs` measures both and draws them).
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
    /// shrunk by the sign of what it sums (`raster.rs`). The sides are the
    /// rasteriser's, in device pixels: a transform that mirrors turns what
    /// was moved to the right in job units into what is on the left there,
    /// and so does a mesh that turns a glyph over.
    ///
    /// `bends` are the box's roughening and its warp. They and a glyph's own
    /// drip bend the outline after it is moved and before the transform
    /// (`GlyphPolys::placed`).
    fn parts(
        &self,
        range: core::ops::Range<usize>,
        extra: f64,
        ring: bool,
        bends: Bends<'_>,
        transform: &Affine,
        tol: f64,
    ) -> Result<budget::Buffer<Part>, Error> {
        let mut parts = budget::Buffer::new();
        for g in &self.items[range] {
            let extra = extra.max(0.0);
            if g.bold + extra <= 0.0 && g.smear.is_none() {
                // Nothing moves the outline: no band, and the fill as
                // the font drew it.
                if !ring {
                    let polys = g.placed(&g.polys, bends, transform, tol)?;
                    budget::push(&mut parts, Part::plain(polys))?;
                }
                budget::check()?;
                continue;
            }
            let (right, left) = if (transform.det() < 0.0) != g.mirrored(bends.mesh) {
                (Side::Left, Side::Right)
            } else {
                (Side::Right, Side::Left)
            };
            let part = Part {
                right: g.placed(&Self::moved(g, extra, right, tol), bends, transform, tol)?,
                left: Some(g.placed(&Self::moved(g, extra, left, tol), bends, transform, tol)?),
                ring,
            };
            budget::check()?;
            budget::push(&mut parts, part)?;
        }
        Ok(parts)
    }
}

/// A layer before its coverage is prepared: its parts in device pixels and
/// what to paint them with.
struct Planned<'a> {
    parts: budget::Buffer<Part>,
    bx: IBox,
    shader: Shader<'a>,
    alpha: f32,
    /// The layer takes away what is under it (`Layer::erase`).
    erase: bool,
}

fn plan<'a>(parts: budget::Buffer<Part>, shader: Shader<'a>, alpha: f64) -> Option<Planned<'a>> {
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
        erase: false,
    })
}

fn finish(
    planned: budget::Buffer<Planned<'_>>,
    surface: IBox,
    rasterizer: &dyn Rasterizer,
) -> Result<Vec<u8>, Error> {
    budget::ensure(
        surface
            .width()
            .checked_mul(surface.height())
            .and_then(|n| n.checked_mul(4))
            .ok_or(Error::BadSpec)?,
    )?;
    let mut layers = budget::Buffer::new();
    for p in planned {
        let bx = p.bx.intersect(&surface);
        if !bx.is_empty() {
            let cov = rasterizer.prepare(&p.parts, bx)?;
            budget::push(
                &mut layers,
                Layer {
                    bx,
                    cov,
                    shader: p.shader,
                    alpha: p.alpha,
                    erase: p.erase,
                },
            )?;
        }
    }
    compose(&mut layers, surface)
}

/// How much finer than the transform asks an outline bent by `mesh` is
/// flattened: by the most the mesh enlarges it, and never coarser. A mesh
/// that only moves, turns or shrinks what it bends is flattened as if it were
/// not there, to the byte.
pub(crate) fn magnified(mesh: Option<&warp::MeshMap<'_>>) -> f64 {
    match mesh.map(warp::MeshMap::stretch) {
        Some(k) if k > 1.0 + 1e-6 => k,
        _ => 1.0,
    }
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
    let _budget = budget::Scope::new();
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
    // Validate both handles even when the job has no runs or draws nothing.
    engine.font(face.font)?;
    engine.check_chain(face.chain)?;
    if !transform.is_finite() || transform.invert().is_none() || !positive(face.size) {
        return Ok(None);
    }
    // The box's mesh, when it moves anything.
    let mesh = match &job.mesh {
        Some(m) => m.map()?,
        None => None,
    };
    let mesh = mesh.as_ref();
    // The flattening tolerance is a distance in device pixels. The outline
    // is flattened before the mesh bends it, and a mesh that enlarges it
    // enlarges each chord's distance from its curve as much as a transform
    // would, so it is flattened finer by that too (`MeshMap::stretch`).
    let tol = FLATTEN_TOLERANCE / (transform.max_scale() * magnified(mesh));
    // The weight is stated in device pixels and applied in job units, where
    // every other pen is: divided by the scale that keeps areas, which is
    // the scale itself for every transform that does not stretch one way
    // more than another.
    let weight = if positive(*weight) {
        *weight / transform.det().abs().sqrt()
    } else {
        0.0
    };

    if job
        .runs
        .iter()
        .any(|r| r.text.len() > budget::MAX_RUN_BYTES)
    {
        return Err(Error::BadSpec);
    }
    // Every run's glyphs, and for each run the frame its fill is stated in.
    let mut glyphs = Glyphs::default();
    let mut runs = budget::Buffer::new();
    budget::reserve(&mut runs, job.runs.len())?;
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
        // The glyph's own frame is the fill's, leaned and scaled; the fill
        // stays in `frame` so a gradient is not stretched per letter. A run
        // that is not scaled or leaned skips the product so its numbers are
        // the ones a plain curved run always had.
        // The outline is flattened after it is placed (`FlattenPen::map`),
        // so a bigger letter gets its finer chords from the frame itself.
        let glyph_frame = if job.curved && (run.sx, run.sy, run.skew) != (1.0, 1.0, 0.0) {
            // skewX(skew) * scale(sx, sy): y points down, so a positive
            // skew moves the top of the letter right.
            let lean = Affine([1.0, 0.0, -run.skew.tan(), 1.0, 0.0, 0.0]);
            frame.after(&lean.after(&Affine::scale(run.sx, run.sy)))
        } else {
            frame
        };
        let start = if job.curved {
            let (dx, dy) = curved_origin(engine, face, shaped.advance)?;
            glyph_frame.after(&Affine::translate(dx, dy))
        } else {
            Affine::translate(run.x + align_offset(job.align, shaped.advance), run.y)
        };
        let from = glyphs.len();
        let drip = if job.curved { run.drip } else { 0.0 };
        glyphs.add_run(engine, &shaped, &start, bold_draw, drip, tol)?;
        budget::push(&mut runs, (from..glyphs.len(), frame))?;
    }
    let all = 0..glyphs.len();
    if all.is_empty() {
        return Ok(None);
    }
    // And its roughening, which is stated in the box before the mesh bends it.
    let rough = match &job.roughen {
        Some(r) => r.map()?,
        None => None,
    };
    let bends = Bends {
        rough: rough.as_ref(),
        mesh,
    };

    let mut planned: budget::Buffer<Planned<'_>> = budget::Buffer::new();
    if let Some(color) = job.silhouette {
        // The glyphs and their widest band as one solid shape: grown by
        // half that band's pen, not a stroke laid over a fill. A band is
        // not moved by the weight, so the shape is as wide as the wider of
        // the heavier fill and the band.
        //
        // With no fill the glyphs are cut out of it below, so it is the band
        // alone that makes it: no band, no shape.
        let extra = job.bands.first().map_or(0.0, |b| (b.line / 2.0).max(0.0));
        if !job.no_fill || positive(extra) {
            let grown = if job.no_fill { extra } else { extra.max(weight) };
            let parts = glyphs.parts(all.clone(), grown, false, bends, transform, tol)?;
            let shader = Shader::new(&Fill::Solid(color), transform, tiles);
            if let Some(p) = shader.and_then(|s| plan(parts, s, 1.0)) {
                budget::push(&mut planned, p)?;
            }
        }
    } else {
        for band in &job.bands {
            if !positive(band.line) {
                continue;
            }
            // The weight is not in it: Safari, whose heavier fills the
            // weight is there to follow, strokes a glyph exactly on its
            // outline (P5B-REPORT.md).
            let reach = band.line / 2.0;
            let parts = glyphs.parts(all.clone(), reach, true, bends, transform, tol)?;
            let shader = Shader::new(&Fill::Solid(band.color), transform, tiles);
            if let Some(p) = shader.and_then(|s| plan(parts, s, band.opacity)) {
                budget::push(&mut planned, p)?;
            }
        }
        // One fill layer per run of glyphs that share a fill. A job-wide
        // fill is one layer; per-line and per-glyph fills are one each,
        // except that neighbours with the same flat colour are merged.
        let mut groups: budget::Buffer<(core::ops::Range<usize>, &Fill, Affine)> =
            budget::Buffer::new();
        for (run, (range, frame)) in job.runs.iter().zip(&runs) {
            // A run's own fill is stated in the run's frame, the job's in
            // the job's.
            let (fill, frame) = match (&run.fill, &job.fill) {
                _ if job.no_fill => continue,
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
                _ => budget::push(&mut groups, (range.clone(), fill, frame))?,
            }
        }
        for (range, fill, frame) in groups {
            if range.is_empty() {
                continue;
            }
            // A gradient or a pattern is bent with the letters it fills, as
            // it was when the mesh was run over the finished picture: each
            // glyph is a layer of its own, and its fill is stated in the
            // frame the mesh carries that glyph's own place to (the map's
            // tangent there, which within one letter is the map). A flat
            // colour is the same wherever it is bent to.
            let bent = mesh.filter(|_| !matches!(fill, Fill::Solid(_)));
            let Some(m) = bent else {
                let parts = glyphs.parts(range, weight, false, bends, transform, tol)?;
                let shader = Shader::new(fill, &transform.after(&frame), tiles);
                if let Some(p) = shader.and_then(|s| plan(parts, s, 1.0)) {
                    budget::push(&mut planned, p)?;
                }
                continue;
            };
            for g in range {
                let parts = glyphs.parts(g..g + 1, weight, false, bends, transform, tol)?;
                let carried = glyphs.items[g].tangent(m).after(&frame);
                let shader = Shader::new(fill, &transform.after(&carried), tiles);
                if let Some(p) = shader.and_then(|s| plan(parts, s, 1.0)) {
                    budget::push(&mut planned, p)?;
                }
            }
        }
    }

    // No fill: the glyphs, as heavy as they would have been filled, are taken
    // out of everything laid down so far. A canvas does it with
    // `destination-out` after the bands (browser-painter.js). The cut is last
    // and reaches no further than the glyphs, which the bands already cover,
    // so it adds nothing to the surface; with nothing under it, it is not made.
    if job.no_fill && !planned.is_empty() {
        const OPAQUE: Fill = Fill::Solid(Rgba([0, 0, 0, 255]));
        let parts = glyphs.parts(all.clone(), weight, false, bends, transform, tol)?;
        let shader = Shader::new(&OPAQUE, transform, tiles);
        if let Some(mut p) = shader.and_then(|s| plan(parts, s, 1.0)) {
            p.erase = true;
            budget::push(&mut planned, p)?;
        }
    }

    budget::check()?;
    let Some(surface) = planned
        .iter()
        .filter(|p| !p.erase)
        .map(|p| p.bx)
        .reduce(|a, b| a.union(&b))
    else {
        return Ok(None);
    };
    let (width, height) = (surface.width(), surface.height());
    if width > MAX_SIDE as usize || height > MAX_SIDE as usize || width * height > MAX_PIXELS {
        return Err(Error::BadSpec);
    }
    let data = finish(planned, surface, rasterizer)?;
    Ok(Some(Raster {
        x: surface.x0,
        y: surface.y0,
        width: width as u32,
        height: height as u32,
        data,
    }))
}

#[cfg(test)]
mod hardening_tests {
    use super::*;
    #[test]
    fn thousands_of_parts_are_bounded_and_the_next_job_paints() {
        let mut engine = Engine::new();
        let path = format!(
            "{}/../src/test/fonts/DejaVuSans.ttf",
            env!("CARGO_MANIFEST_DIR")
        );
        let font = engine
            .add_font_bytes(std::fs::read(path).unwrap(), 0)
            .unwrap();
        let run = shape_run(&mut engine, Face::new(font, 40.0), &"I".repeat(6000), 0.0).unwrap();
        {
            let _scope = budget::Scope::new();
            budget::limit_for_test(64 * 1024);
            let _held = budget::filled(64 * 1024, 0u8).unwrap();
            // Exercise the production consumer. Failed outline callbacks have
            // no contours; bypassing its check would silently accept no ink.
            let mut glyphs = Glyphs::default();
            assert_eq!(
                glyphs.add_run(
                    &engine,
                    &run,
                    &Affine::IDENTITY,
                    BoldDraw::Outset,
                    0.0,
                    FLATTEN_TOLERANCE
                ),
                Err(Error::BadSpec)
            );
        }
        let mut scene = Scene::new(64, 64, [1., 0., 0., 1., 0., 0.]).unwrap();
        scene
            .add_line(&mut engine, Face::new(font, 40.), "I", 10., 50.)
            .unwrap();
        scene.fill(Rgba([0, 0, 0, 255])).unwrap();
        assert!(scene.into_rgba().unwrap().iter().any(|&v| v != 0));
    }
    #[test]
    fn scene_add_line_reports_a_latched_outline_failure() {
        let mut engine = Engine::new();
        let path = format!(
            "{}/../src/test/fonts/DejaVuSans.ttf",
            env!("CARGO_MANIFEST_DIR")
        );
        let font = engine
            .add_font_bytes(std::fs::read(path).unwrap(), 0)
            .unwrap();
        let mut scene = Scene::new(64, 64, [1., 0., 0., 1., 0., 0.]).unwrap();
        let _scope = budget::Scope::new();
        budget::limit_for_test(512);
        assert_eq!(
            scene.add_line(&mut engine, Face::new(font, 40.), "W", 10., 50.),
            Err(Error::BadSpec)
        );
        assert!(scene.into_rgba().is_err());
    }
    fn test_font(e: &mut Engine) -> crate::engine::FontId {
        e.add_font_bytes(
            std::fs::read(format!(
                "{}/../src/test/fonts/DejaVuSans.ttf",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap(),
            0,
        )
        .unwrap()
    }
    #[test]
    fn raster_bytes_are_refused_before_preparing_edges() {
        struct MustNotPrepare;
        impl Rasterizer for MustNotPrepare {
            fn prepare(&self, _: &[Part], _: IBox) -> Result<Box<dyn raster::Coverage>, Error> {
                panic!("raster precheck must precede edges");
            }
        }
        let fill = Fill::Solid(Rgba([0, 0, 0, 255]));
        let p = Planned {
            parts: budget::Buffer::new(),
            bx: IBox {
                x0: 0,
                y0: 0,
                x1: 64,
                y1: 64,
            },
            shader: Shader::new(&fill, &Affine::IDENTITY, &[]).unwrap(),
            alpha: 1.,
            erase: false,
        };
        let planned = [p].into_iter().collect();
        let _scope = budget::Scope::new();
        budget::limit_for_test(64 * 64 * 4 - 1);
        assert_eq!(
            finish(
                planned,
                IBox {
                    x0: 0,
                    y0: 0,
                    x1: 64,
                    y1: 64
                },
                &MustNotPrepare
            )
            .err(),
            Some(Error::BadSpec)
        );
    }

    #[test]
    fn job_run_limit_precedes_work_on_any_earlier_run() {
        let mut e = Engine::new();
        let font = test_font(&mut e);
        let face = Face::new(font, 40.);
        e.measure_line(face, "W", crate::engine::ShapeMode::MEASURE)
            .unwrap();
        let before = e.line.clone();
        let req = Request {
            face,
            bold_draw: None,
            weight: 0.,
            transform: Affine::IDENTITY,
            tiles: vec![],
            job: job::Job {
                curved: false,
                align: job::Align::Left,
                letter_spacing: 0.,
                bands: vec![],
                silhouette: None,
                no_fill: false,
                fill: Some(Fill::Solid(Rgba([0, 0, 0, 255]))),
                mesh: None,
                roughen: None,
                runs: ["III".to_owned(), "I".repeat(262_145)]
                    .into_iter()
                    .map(|text| job::Run {
                        text,
                        x: 10.,
                        y: 50.,
                        rot: 0.,
                        sx: 1.,
                        sy: 1.,
                        skew: 0.,
                        drip: 0.,
                        fill: None,
                    })
                    .collect(),
            },
        };
        assert_eq!(paint_job(&mut e, &req).err(), Some(Error::BadSpec));
        assert_eq!(e.line, before);
    }
}
