//! Minimal painter: shaped lines, one round-join stroke under a solid fill,
//! under an affine transform, to RGBA8.
//!
//! This is the spike's proof that outlines from the shaper's font can be
//! rasterised in the same wasm module. Gradients, patterns, per-band opacity
//! and single-glyph (curved) placement are the full port's work.

use skrifa::outline::OutlinePen;
use tiny_skia::{
    Color, FillRule, LineCap, LineJoin, Paint, Path, PathBuilder, Pixmap, Stroke, Transform,
};

use crate::engine::{Engine, Face};
use crate::font::OBLIQUE_SKEW;
use crate::metrics::bold_outset;
use crate::Error;

/// Largest surface side accepted. A guard against a bad spec asking for
/// gigabytes, not a design limit.
pub const MAX_SIDE: u32 = 16384;

/// Straight (not premultiplied) RGBA, the layout of canvas `ImageData`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgba(pub [u8; 4]);

impl Rgba {
    pub fn from_u32(rgba: u32) -> Self {
        Self(rgba.to_be_bytes())
    }

    fn color(self) -> Color {
        let [r, g, b, a] = self.0;
        Color::from_rgba8(r, g, b, a)
    }
}

/// A scene under construction: a surface, a transform and the outlines of
/// every line added so far, kept in user space so one stroke call covers
/// them all.
pub struct Scene {
    pixmap: Pixmap,
    transform: Transform,
    builder: PathBuilder,
    /// Extra pen width a synthesised bold adds to every glyph, in user units.
    /// One value per scene: mixing bold and regular lines needs one path per
    /// weight, which the spike does not do.
    embolden: f32,
}

/// Feeds a glyph's font-unit outline into a path in user space.
struct GlyphPen<'a> {
    builder: &'a mut PathBuilder,
    scale: f32,
    skew: f32,
    x: f32,
    y: f32,
}

impl GlyphPen<'_> {
    /// Font units are y up; the surface is y down.
    fn map(&self, gx: f32, gy: f32) -> (f32, f32) {
        (
            self.x + (gx + self.skew * gy) * self.scale,
            self.y - gy * self.scale,
        )
    }
}

impl OutlinePen for GlyphPen<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.map(x, y);
        self.builder.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.map(x, y);
        self.builder.line_to(x, y);
    }
    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        let (cx0, cy0) = self.map(cx0, cy0);
        let (x, y) = self.map(x, y);
        self.builder.quad_to(cx0, cy0, x, y);
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        let (cx0, cy0) = self.map(cx0, cy0);
        let (cx1, cy1) = self.map(cx1, cy1);
        let (x, y) = self.map(x, y);
        self.builder.cubic_to(cx0, cy0, cx1, cy1, x, y);
    }
    fn close(&mut self) {
        self.builder.close();
    }
}

impl Scene {
    /// A transparent surface of `width` x `height` device pixels. `matrix` is
    /// the canvas `setTransform(a, b, c, d, e, f)` that maps user space to it.
    pub fn new(width: u32, height: u32, matrix: [f32; 6]) -> Result<Self, Error> {
        if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
            return Err(Error::BadSpec);
        }
        if matrix.iter().any(|v| !v.is_finite()) {
            return Err(Error::BadSpec);
        }
        let [a, b, c, d, e, f] = matrix;
        Ok(Self {
            pixmap: Pixmap::new(width, height).ok_or(Error::BadSpec)?,
            transform: Transform::from_row(a, b, c, d, e, f),
            builder: PathBuilder::new(),
            embolden: 0.0,
        })
    }

    /// Adds `text` shaped as one run with its origin at (`x`, `y`) on the
    /// alphabetic baseline, in user space.
    pub fn add_line(
        &mut self,
        engine: &mut Engine,
        face: Face,
        text: &str,
        x: f64,
        y: f64,
    ) -> Result<(), Error> {
        engine.shape(face.font, text)?;
        let entry = engine.font(face.font)?;
        let scale = face.size / f64::from(entry.info.units_per_em);
        let mut pen_units = 0i64;
        for g in engine.last_run() {
            let mut pen = GlyphPen {
                builder: &mut self.builder,
                scale: scale as f32,
                skew: if face.synth.oblique {
                    OBLIQUE_SKEW
                } else {
                    0.0
                },
                x: (x + (pen_units + i64::from(g.x_offset)) as f64 * scale) as f32,
                y: (y - f64::from(g.y_offset) * scale) as f32,
            };
            entry.draw_glyph(g.id, &mut pen);
            pen_units += i64::from(g.x_advance);
        }
        if face.synth.bold {
            self.embolden = self.embolden.max(2.0 * bold_outset(face.size) as f32);
        }
        Ok(())
    }

    fn path(&self) -> Option<Path> {
        self.builder.clone().finish()
    }

    fn stroke_with(&mut self, path: &Path, width: f32, color: Rgba) {
        let mut paint = Paint::default();
        paint.set_color(color.color());
        paint.anti_alias = true;
        let stroke = Stroke {
            width,
            line_cap: LineCap::Butt,
            line_join: LineJoin::Round,
            ..Stroke::default()
        };
        self.pixmap
            .stroke_path(path, &paint, &stroke, self.transform, None);
    }

    /// Strokes every line added so far in one pass with a round join.
    /// `line_width` is the full pen width in user units, the canvas
    /// `lineWidth`: half of it lands outside the outline.
    ///
    /// One pass over one path is what makes the stroke a union: where the
    /// strokes of neighbouring glyphs overlap, a translucent colour is laid
    /// down once, not twice.
    pub fn stroke(&mut self, line_width: f32, color: Rgba) {
        if let Some(path) = self.path() {
            // A faked bold is itself a stroke of the outline, so the two pens
            // add up to one wider pen.
            self.stroke_with(&path, line_width + self.embolden, color);
        }
    }

    /// Fills every line added so far with a solid colour.
    pub fn fill(&mut self, color: Rgba) {
        let Some(path) = self.path() else {
            return;
        };
        if self.embolden > 0.0 {
            self.stroke_with(&path, self.embolden, color);
        }
        let mut paint = Paint::default();
        paint.set_color(color.color());
        paint.anti_alias = true;
        self.pixmap
            .fill_path(&path, &paint, FillRule::Winding, self.transform, None);
    }

    pub fn width(&self) -> u32 {
        self.pixmap.width()
    }

    pub fn height(&self) -> u32 {
        self.pixmap.height()
    }

    /// The surface as straight-alpha RGBA8, row by row from the top.
    ///
    /// Text is almost all fully transparent or fully opaque pixels, so those
    /// are passed through and only edge pixels pay for a division. Doing the
    /// general un-premultiply on every pixel cost more than the fill itself.
    pub fn into_rgba(self) -> Vec<u8> {
        let mut data = self.pixmap.take();
        for px in data.chunks_exact_mut(4) {
            let a = u32::from(px[3]);
            if a == 0 || a == 255 {
                continue;
            }
            for c in &mut px[..3] {
                *c = ((u32::from(*c) * 255 + a / 2) / a).min(255) as u8;
            }
        }
        data
    }
}
