//! The spike's painter interface, kept for the `mt_paint_*` exports: lines
//! added one at a time, then strokes and fills over all of them, onto a
//! surface of a size the caller chose.
//!
//! It draws through the same outlines, stroker, rasteriser and compositor as
//! [`paint_job`](super::paint_job). New code should build a job instead: a
//! job gets a surface cut to its ink, gradients, patterns and curved text.

use super::geom::{positive, Affine, IBox};
use super::job::{Fill, Rgba};
use super::outline::FLATTEN_TOLERANCE;
use super::raster::Exact;
use super::shade::Shader;
use super::shape::shape_run;
use super::{finish, plan, plan_ring, Glyphs, Planned, MAX_SIDE};
use crate::engine::{Engine, Face};
use crate::Error;

enum Op {
    /// Canvas `lineWidth` and colour, over the glyphs added so far.
    Stroke(usize, f64, Rgba),
    Fill(usize, Rgba),
}

/// A scene under construction: a surface size, a transform, the outlines of
/// every line added so far and what has been asked to be done with them.
pub struct Scene {
    width: u32,
    height: u32,
    transform: Affine,
    glyphs: Glyphs,
    ops: Vec<Op>,
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
        Ok(Self {
            width,
            height,
            transform: Affine(matrix.map(f64::from)),
            glyphs: Glyphs::default(),
            ops: Vec::new(),
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
        let run = shape_run(engine, face, text, 0.0)?;
        let scale = self.transform.max_scale();
        if !positive(scale) {
            return Ok(());
        }
        let tol = FLATTEN_TOLERANCE / scale;
        self.glyphs
            .add_run(engine, &run, &Affine::translate(x, y), tol)
    }

    /// Strokes every line added so far as one shape, round join.
    /// `line_width` is the full pen width in user units, the canvas
    /// `lineWidth`: half of it lands outside the outline.
    pub fn stroke(&mut self, line_width: f32, color: Rgba) {
        self.ops
            .push(Op::Stroke(self.glyphs.len(), f64::from(line_width), color));
    }

    /// Fills every line added so far with a solid colour.
    pub fn fill(&mut self, color: Rgba) {
        self.ops.push(Op::Fill(self.glyphs.len(), color));
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// The surface as straight-alpha RGBA8, row by row from the top.
    pub fn into_rgba(self) -> Vec<u8> {
        let surface = IBox {
            x0: 0,
            y0: 0,
            x1: self.width as i32,
            y1: self.height as i32,
        };
        let scale = self.transform.max_scale();
        let mut planned: Vec<Planned<'_>> = Vec::new();
        if scale > 0.0 && self.transform.invert().is_some() {
            let tol = FLATTEN_TOLERANCE / scale;
            for op in &self.ops {
                let shader = |color| Shader::new(&Fill::Solid(color), &self.transform, &[]);
                planned.extend(match *op {
                    Op::Stroke(n, line, color) if line > 0.0 => {
                        let (outer, inner) = self.glyphs.band(0..n, line, tol);
                        shader(color)
                            .and_then(|s| plan_ring(&outer, &inner, &self.transform, s, 1.0))
                    }
                    Op::Stroke(..) => None,
                    Op::Fill(n, color) => {
                        let shape = self.glyphs.solid(0..n, 0.0, tol);
                        shader(color).and_then(|s| plan(&shape, &self.transform, s, 1.0))
                    }
                });
            }
        }
        finish(planned, surface, &Exact)
    }
}
