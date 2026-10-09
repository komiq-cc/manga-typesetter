//! The rasterisers the painter's own was measured against, behind the same
//! interface. For the comparison in P5A-REPORT.md only: `parity/raster.mjs`
//! picks one through `mt_paint_rasterizer` and paints the same jobs with it.
//!
//! Each is handed the very polylines the exact rasteriser gets, as one path
//! (`Part::one_shape`): a rasteriser that fills a path cannot be told to
//! unite glyphs one by one, so where two glyphs of one layer overlap, what
//! it does with a path that overlaps itself is part of what is compared.

use super::geom::{IBox, Polys};
use super::raster::{Coverage, Exact, Part, Rasterizer};

/// The parts as one path for a rasteriser that fills one path by the
/// non-zero rule, which is what all three of these are.
#[allow(dead_code)]
fn one_path(parts: &[Part]) -> Polys {
    let mut polys = Polys::default();
    for part in parts {
        part.one_shape(&mut polys);
    }
    polys
}

/// A rasteriser by the number `mt_paint_rasterizer` takes.
pub fn by_id(id: u32) -> Option<&'static dyn Rasterizer> {
    match id {
        0 => Some(&Exact),
        #[cfg(feature = "raster-tiny-skia")]
        1 => Some(&TinySkia),
        #[cfg(feature = "raster-zeno")]
        2 => Some(&Zeno),
        #[cfg(feature = "raster-vello")]
        3 => Some(&Vello),
        _ => None,
    }
}

/// A whole mask made up front, handed out row by row.
#[allow(dead_code)]
struct Mask8 {
    data: Vec<u8>,
    bx: IBox,
}

impl Coverage for Mask8 {
    fn render(
        &mut self,
        y0: i32,
        y1: i32,
        out: &mut [f32],
        stride: usize,
        spans: &mut [(u32, u32)],
    ) {
        let width = self.bx.width();
        for (r, y) in (y0..y1).enumerate() {
            let row = (y - self.bx.y0) as usize;
            let src = &self.data[row * width..(row + 1) * width];
            for (o, &v) in out[r * stride..r * stride + width].iter_mut().zip(src) {
                *o = f32::from(v) / 255.0;
            }
            spans[r] = (0, width as u32);
        }
    }
}

/// tiny-skia 0.12: scanline conversion at 4 x 4 samples a pixel, a port of
/// Skia's supersampling rasteriser. What the spike painted with.
#[cfg(feature = "raster-tiny-skia")]
pub struct TinySkia;

#[cfg(feature = "raster-tiny-skia")]
impl Rasterizer for TinySkia {
    fn prepare(&self, parts: &[Part], bx: IBox) -> Box<dyn Coverage> {
        let polys = &one_path(parts);
        let (w, h) = (bx.width(), bx.height());
        let mut data = vec![0u8; w * h];
        let mut pb = tiny_skia::PathBuilder::new();
        for c in polys.contours() {
            for (i, p) in c.iter().enumerate() {
                let (x, y) = (
                    (p.x - f64::from(bx.x0)) as f32,
                    (p.y - f64::from(bx.y0)) as f32,
                );
                if i == 0 {
                    pb.move_to(x, y);
                } else {
                    pb.line_to(x, y);
                }
            }
            pb.close();
        }
        if let (Some(path), Some(mut mask)) =
            (pb.finish(), tiny_skia::Mask::new(w as u32, h as u32))
        {
            mask.fill_path(
                &path,
                tiny_skia::FillRule::Winding,
                true,
                tiny_skia::Transform::identity(),
            );
            data.copy_from_slice(mask.data());
        }
        Box::new(Mask8 { data, bx })
    }
}

/// zeno 0.3: a port of FreeType's smooth rasteriser. Exact area like the
/// painter's own, with coordinates rounded to 1/256 px.
#[cfg(feature = "raster-zeno")]
pub struct Zeno;

#[cfg(feature = "raster-zeno")]
impl Rasterizer for Zeno {
    fn prepare(&self, parts: &[Part], bx: IBox) -> Box<dyn Coverage> {
        let polys = &one_path(parts);
        use zeno::{Command, Fill, Format, Vector};
        let (w, h) = (bx.width(), bx.height());
        let mut data = vec![0u8; w * h];
        let mut commands = Vec::with_capacity(polys.pts.len() + polys.ends.len());
        for c in polys.contours() {
            for (i, p) in c.iter().enumerate() {
                let v = Vector::new(
                    (p.x - f64::from(bx.x0)) as f32,
                    (p.y - f64::from(bx.y0)) as f32,
                );
                commands.push(if i == 0 {
                    Command::MoveTo(v)
                } else {
                    Command::LineTo(v)
                });
            }
            commands.push(Command::Close);
        }
        zeno::Mask::new(&commands[..])
            .style(Fill::NonZero)
            .format(Format::Alpha)
            .size(w as u32, h as u32)
            .render_into(&mut data, None);
        Box::new(Mask8 { data, bx })
    }
}

/// vello_cpu 0.2: sparse strips with analytic area coverage, the CPU
/// renderer of the Vello project. It paints whole scenes; here it fills the
/// shape in white and its alpha channel is read back.
#[cfg(feature = "raster-vello")]
pub struct Vello;

#[cfg(feature = "raster-vello")]
impl Rasterizer for Vello {
    fn prepare(&self, parts: &[Part], bx: IBox) -> Box<dyn Coverage> {
        let polys = &one_path(parts);
        use vello_cpu::color::palette::css::WHITE;
        use vello_cpu::kurbo::BezPath;
        let (w, h) = (bx.width(), bx.height());
        let mut data = vec![0u8; w * h];
        if let (Ok(w16), Ok(h16)) = (u16::try_from(w), u16::try_from(h)) {
            let mut path = BezPath::new();
            for c in polys.contours() {
                for (i, p) in c.iter().enumerate() {
                    let q = (p.x - f64::from(bx.x0), p.y - f64::from(bx.y0));
                    if i == 0 {
                        path.move_to(q);
                    } else {
                        path.line_to(q);
                    }
                }
                path.close_path();
            }
            let mut ctx = vello_cpu::RenderContext::new(w16, h16);
            ctx.set_paint(WHITE);
            ctx.fill_path(&path);
            ctx.flush();
            let mut pixmap = vello_cpu::Pixmap::new(w16, h16);
            ctx.render(&mut pixmap, &mut vello_cpu::Resources::default());
            for (o, px) in data
                .iter_mut()
                .zip(pixmap.data_as_u8_slice().chunks_exact(4))
            {
                *o = px[3];
            }
        }
        Box::new(Mask8 { data, bx })
    }
}
