//! The rasterisers the painter's own was measured against, behind the same
//! interface. For the comparison in P5A-REPORT.md only: `parity/raster.mjs`
//! picks one through `mt_paint_rasterizer` and paints the same jobs with it.
//!
//! Both are handed the very polylines the exact rasteriser gets, so what is
//! compared is the rasteriser and nothing else.

use super::geom::{IBox, Polys};
use super::raster::{Coverage, Exact, Rasterizer};

/// A rasteriser by the number `mt_paint_rasterizer` takes.
pub fn by_id(id: u32) -> Option<&'static dyn Rasterizer> {
    match id {
        0 => Some(&Exact),
        1 => Some(&TinySkia),
        2 => Some(&Zeno),
        _ => None,
    }
}

/// A whole mask made up front, handed out row by row.
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
pub struct TinySkia;

impl Rasterizer for TinySkia {
    fn prepare(&self, polys: &Polys, bx: IBox) -> Box<dyn Coverage> {
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
pub struct Zeno;

impl Rasterizer for Zeno {
    fn prepare(&self, polys: &Polys, bx: IBox) -> Box<dyn Coverage> {
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
