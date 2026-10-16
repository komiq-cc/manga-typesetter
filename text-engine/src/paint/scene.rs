//! The spike's painter interface, kept for the `mt_paint_*` exports: lines
//! added one at a time, then strokes and fills over all of them, onto a
//! surface of a size the caller chose.
//!
//! It draws through the same outlines, stroker, rasteriser and compositor as
//! [`paint_job`](super::paint_job). New code should build a job instead: a
//! job gets a surface cut to its ink, gradients, patterns and curved text.

use super::budget;
use super::geom::{positive, Affine, IBox};
use super::job::{Fill, Rgba};
use super::outline::FLATTEN_TOLERANCE;
use super::raster::Exact;
use super::shade::Shader;
use super::shape::shape_run;
use super::{finish, plan, BoldDraw, Glyphs, Planned, MAX_PIXELS, MAX_SIDE};
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
    ops: budget::Buffer<Op>,
}

impl Scene {
    /// A transparent surface of `width` x `height` device pixels. `matrix` is
    /// the canvas `setTransform(a, b, c, d, e, f)` that maps user space to it.
    pub fn new(width: u32, height: u32, matrix: [f32; 6]) -> Result<Self, Error> {
        // The same guard a job's surface passes: a side, and the pixels.
        if width == 0
            || height == 0
            || width > MAX_SIDE
            || height > MAX_SIDE
            || width as usize * height as usize > MAX_PIXELS
        {
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
            ops: budget::Buffer::new(),
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
        let _scope = budget::Scope::new();
        self.glyphs.account()?;
        self.ops.account()?;
        let run = shape_run(engine, face, text, 0.0)?;
        let scale = self.transform.max_scale();
        if !positive(scale) {
            return Ok(());
        }
        let tol = FLATTEN_TOLERANCE / scale;
        let before = self.glyphs.len();
        let result = self.glyphs.add_run(
            engine,
            &run,
            &Affine::translate(x, y),
            BoldDraw::Outset,
            0.0,
            tol,
        );
        if result.is_err() {
            self.glyphs.truncate(before);
        }
        result
    }

    /// Strokes every line added so far as one shape, round join.
    /// `line_width` is the full pen width in user units, the canvas
    /// `lineWidth`: half of it lands outside the outline.
    pub fn stroke(&mut self, line_width: f32, color: Rgba) -> Result<(), Error> {
        let _scope = budget::Scope::new();
        self.glyphs.account()?;
        self.ops.account()?;
        budget::push(
            &mut self.ops,
            Op::Stroke(self.glyphs.len(), f64::from(line_width), color),
        )
    }

    /// Fills every line added so far with a solid colour.
    pub fn fill(&mut self, color: Rgba) -> Result<(), Error> {
        let _scope = budget::Scope::new();
        self.glyphs.account()?;
        self.ops.account()?;
        budget::push(&mut self.ops, Op::Fill(self.glyphs.len(), color))
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// The surface as straight-alpha RGBA8, row by row from the top.
    pub fn into_rgba(self) -> Result<Vec<u8>, Error> {
        self.try_into_rgba()
    }

    /// As `into_rgba`, with an explicit refusal for the allocation budget
    /// or allocator failure. The ABI uses this form.
    pub fn try_into_rgba(mut self) -> Result<Vec<u8>, Error> {
        let _budget = super::budget::Scope::new();
        self.glyphs.account()?;
        self.ops.account()?;
        budget::ensure(self.width as usize * self.height as usize * 4)?;
        let surface = IBox {
            x0: 0,
            y0: 0,
            x1: self.width as i32,
            y1: self.height as i32,
        };
        let scale = self.transform.max_scale();
        let mut planned: budget::Buffer<Planned<'_>> = budget::Buffer::new();
        if scale > 0.0 && self.transform.invert().is_some() {
            let tol = FLATTEN_TOLERANCE / scale;
            for op in &self.ops {
                let shader = |color| Shader::new(&Fill::Solid(color), &self.transform, &[]);
                let p = match *op {
                    Op::Stroke(n, line, color) if line > 0.0 => {
                        let parts = self.glyphs.parts(
                            0..n,
                            line / 2.0,
                            true,
                            super::Bends::default(),
                            &self.transform,
                            tol,
                        )?;
                        shader(color).and_then(|s| plan(parts, s, 1.0))
                    }
                    Op::Stroke(..) => None,
                    Op::Fill(n, color) => {
                        let parts =
                            self.glyphs
                                .parts(0..n, 0.0, false, super::Bends::default(), &self.transform, tol)?;
                        shader(color).and_then(|s| plan(parts, s, 1.0))
                    }
                };
                if let Some(p) = p {
                    super::budget::push(&mut planned, p)?;
                }
            }
        }
        super::budget::check()?;
        finish(planned, surface, &Exact)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn font(e: &mut Engine) -> Face {
        let f = e
            .add_font_bytes(
                std::fs::read(format!(
                    "{}/../src/test/fonts/DejaVuSans.ttf",
                    env!("CARGO_MANIFEST_DIR")
                ))
                .unwrap(),
                0,
            )
            .unwrap();
        Face::new(f, 40.)
    }
    #[test]
    fn add_line_opens_its_own_budget_scope() {
        let mut e = Engine::new();
        let face = font(&mut e);
        let mut s = Scene::new(64, 64, [1., 0., 0., 1., 0., 0.]).unwrap();
        budget::limit_next_scope_for_test(512);
        let result = s.add_line(&mut e, face, "W", 10., 50.);
        // Clear the injection even when the scope is removed by a mutation.
        budget::limit_next_scope_for_test(budget::MAX_PAINT_BYTES);
        assert_eq!(result, Err(Error::BadSpec));
        s.add_line(&mut e, face, "I", 10., 50.).unwrap();
        s.fill(Rgba([0, 0, 0, 255])).unwrap();
        assert!(s.into_rgba().unwrap().iter().any(|&v| v != 0));
    }
    #[test]
    fn a_refused_line_rolls_back_the_glyphs_already_appended() {
        let mut e = Engine::new();
        let face = font(&mut e);
        let mut s = Scene::new(64, 64, [1., 0., 0., 1., 0., 0.]).unwrap();
        s.add_line(&mut e, face, "I", 10., 50.).unwrap();
        let before = s.glyphs.len();
        {
            let _scope = budget::Scope::new();
            budget::limit_for_test(20 * 1024);
            assert_eq!(
                s.add_line(&mut e, face, &"IW".repeat(100), 10., 50.),
                Err(Error::BadSpec)
            );
            assert_eq!(s.glyphs.len(), before);
        }
        s.add_line(&mut e, face, "I", 20., 50.).unwrap();
        s.fill(Rgba([0, 0, 0, 255])).unwrap();
        assert!(s.into_rgba().unwrap().iter().any(|&v| v != 0));
    }
    #[test]
    fn scene_raster_bytes_are_refused_before_generating_bands() {
        let mut e = Engine::new();
        let face = font(&mut e);
        let mut s = Scene::new(1024, 1024, [1., 0., 0., 1., 0., 0.]).unwrap();
        s.add_line(&mut e, face, "W", 10., 50.).unwrap();
        s.stroke(10., Rgba([0, 0, 0, 255])).unwrap();
        let _scope = budget::Scope::new();
        s.glyphs.account().unwrap();
        s.ops.account().unwrap();
        let before = budget::peak_for_test();
        budget::limit_for_test(before + 1024 * 1024 * 4 - 1);
        assert_eq!(s.into_rgba().err(), Some(Error::BadSpec));
        assert_eq!(budget::peak_for_test(), before);
    }
}
