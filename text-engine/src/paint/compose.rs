//! Layers to pixels.
//!
//! A paint is a short list of layers, bottom first: each a shape's coverage
//! and what to paint it with. They are composited source-over in
//! premultiplied `f32`, a strip of rows at a time, and each strip is written
//! out as straight RGBA8 when its last layer is down. Colour is rounded to
//! eight bits exactly once, at the end, so a pixel under three translucent
//! layers is as accurate as one under a single layer.

use super::geom::IBox;
use super::raster::{strip_of, Coverage, STRIP_ROWS};
use super::shade::Shader;

pub struct Layer<'a> {
    /// The device pixels the coverage was prepared for.
    pub bx: IBox,
    pub cov: Box<dyn Coverage>,
    pub shader: Shader<'a>,
    /// Canvas `globalAlpha` for this layer.
    pub alpha: f32,
}

/// Paints `layers`, bottom first, over a transparent surface covering
/// `surface`, and returns it as straight-alpha RGBA8, row by row from the top.
pub fn compose(layers: &mut [Layer<'_>], surface: IBox) -> Vec<u8> {
    let (width, height) = (surface.width(), surface.height());
    let mut out = vec![0u8; width * height * 4];
    if width == 0 || height == 0 {
        return out;
    }
    let strip_rows = STRIP_ROWS as usize;
    let mut colour = vec![0.0f32; width * strip_rows * 4];
    // The columns of each row of the strip that any layer has painted.
    let mut dirty = vec![(u32::MAX, 0u32); strip_rows];
    let mut cov: Vec<f32> = Vec::new();
    let mut spans = vec![(0u32, 0u32); strip_rows];

    let mut y = surface.y0;
    while y < surface.y1 {
        let y_end = ((strip_of(y) + 1) * STRIP_ROWS).min(surface.y1);
        for layer in layers.iter_mut() {
            let bx = layer.bx.intersect(&surface);
            let (ly0, ly1) = (y.max(bx.y0), y_end.min(bx.y1));
            if ly0 >= ly1 || bx.x0 >= bx.x1 || layer.alpha <= 0.0 {
                continue;
            }
            let stride = layer.bx.width() + 2;
            let rows = (ly1 - ly0) as usize;
            cov.clear();
            cov.resize(stride * rows, 0.0);
            layer.cov.render(ly0, ly1, &mut cov, stride, &mut spans);
            let solid = layer.shader.solid().map(|c| c.map(|v| v * layer.alpha));
            for (r, &(a, b)) in spans[..rows].iter().enumerate() {
                // The span in device columns, cut to the surface.
                let xa = (layer.bx.x0 + a as i32).max(surface.x0);
                let xb = (layer.bx.x0 + b as i32).min(surface.x1);
                if xa >= xb {
                    continue;
                }
                let dev_y = ly0 + r as i32;
                let row = (dev_y - y) as usize;
                let from = (xa - surface.x0) as usize;
                let to = (xb - surface.x0) as usize;
                let d = &mut dirty[row];
                *d = (d.0.min(from as u32), d.1.max(to as u32));
                let line = &mut colour[row * width * 4..(row + 1) * width * 4];
                let cov_row = &cov[r * stride..(r + 1) * stride];
                let cov_from = (xa - layer.bx.x0) as usize;
                let pixels = line[from * 4..to * 4].chunks_exact_mut(4);
                let covers = &cov_row[cov_from..cov_from + (to - from)];
                match solid {
                    Some(src) => {
                        for (px, &c) in pixels.zip(covers) {
                            if c > 0.0 {
                                over(px, src, c);
                            }
                        }
                    }
                    None => {
                        for (i, (px, &c)) in pixels.zip(covers).enumerate() {
                            if c > 0.0 {
                                over(px, layer.shader.at(xa + i as i32, dev_y), c * layer.alpha);
                            }
                        }
                    }
                }
            }
        }
        // The strip is finished: write it out and clear what was used.
        for row in 0..(y_end - y) as usize {
            let (from, to) = (dirty[row].0 as usize, dirty[row].1 as usize);
            dirty[row] = (u32::MAX, 0);
            if from >= to {
                continue;
            }
            let line = &mut colour[row * width * 4..(row + 1) * width * 4];
            let at = ((y - surface.y0) as usize + row) * width * 4;
            let dst = &mut out[at + from * 4..at + to * 4];
            for (px, o) in line[from * 4..to * 4]
                .chunks_exact_mut(4)
                .zip(dst.chunks_exact_mut(4))
            {
                store(px, o);
                px.fill(0.0);
            }
        }
        y = y_end;
    }
    out
}

/// Source-over of the premultiplied colour `src` at coverage `c`.
#[inline]
fn over(px: &mut [f32], src: [f32; 4], c: f32) {
    let keep = 1.0 - src[3] * c;
    px[0] = src[0] * c + px[0] * keep;
    px[1] = src[1] * c + px[1] * keep;
    px[2] = src[2] * c + px[2] * keep;
    px[3] = src[3] * c + px[3] * keep;
}

/// One premultiplied `f32` pixel to straight RGBA8, rounding to nearest.
///
/// A pixel whose alpha rounds to zero is written as all zeros: it has no
/// colour to state. Every value converted is a finite number between 0 and
/// 255.5, so the result does not depend on how a conversion treats anything
/// else.
#[inline]
fn store(px: &[f32], out: &mut [u8]) {
    let a = px[3].min(1.0);
    let a8 = (a * 255.0 + 0.5) as u8;
    if a8 == 0 {
        out.fill(0);
        return;
    }
    for k in 0..3 {
        out[k] = ((px[k] / a).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    }
    out[3] = a8;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paint::geom::{Polys, Pt};
    use crate::paint::raster::{Exact, Rasterizer};

    fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Polys {
        let mut p = Polys::default();
        for (x, y) in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)] {
            p.push(Pt::new(x, y));
        }
        p.close();
        p
    }

    fn layer(polys: &Polys, bx: IBox, rgba: [f32; 4], alpha: f32) -> Layer<'static> {
        Layer {
            bx,
            cov: Exact.prepare(polys, bx),
            shader: Shader::Solid(rgba),
            alpha,
        }
    }

    #[test]
    fn layers_are_laid_over_each_other_and_rounded_once() {
        let surface = IBox {
            x0: 10,
            y0: 20,
            x1: 16,
            y1: 60,
        };
        // Opaque red everywhere, then blue at 50% over the right half, then
        // green at 40% covering half of each pixel of one row.
        let mut layers = vec![
            layer(
                &rect(10.0, 20.0, 16.0, 60.0),
                surface,
                [1.0, 0.0, 0.0, 1.0],
                1.0,
            ),
            layer(
                &rect(13.0, 20.0, 16.0, 60.0),
                surface,
                [0.0, 0.0, 1.0, 1.0],
                0.5,
            ),
            layer(
                &rect(10.0, 40.0, 16.0, 40.5),
                surface,
                [0.0, 1.0, 0.0, 1.0],
                0.4,
            ),
        ];
        let px = compose(&mut layers, surface);
        let at = |x: usize, y: usize| &px[(y * 6 + x) * 4..(y * 6 + x) * 4 + 4];
        assert_eq!(at(0, 0), [255, 0, 0, 255]);
        assert_eq!(at(5, 39), [128, 0, 128, 255]);
        // Row 20 of the surface is device row 40: green at 0.4 * 0.5 = 0.2.
        assert_eq!(at(0, 20), [204, 51, 0, 255]);
        // 0.8 of (0.5, 0, 0.5) under 0.2 green: (0.4, 0.2, 0.4).
        assert_eq!(at(5, 20), [102, 51, 102, 255]);
    }

    #[test]
    fn a_translucent_edge_keeps_its_colour() {
        let surface = IBox {
            x0: 0,
            y0: 0,
            x1: 3,
            y1: 1,
        };
        // A quarter of the last pixel, at 30% opacity: alpha 0.075.
        let mut layers = vec![layer(
            &rect(0.0, 0.0, 2.25, 1.0),
            surface,
            [0.2, 0.4, 0.6, 1.0],
            0.3,
        )];
        let px = compose(&mut layers, surface);
        assert_eq!(&px[0..4], &[51, 102, 153, 77]);
        // Straight colour is unchanged where a premultiplied 8-bit surface
        // would have had only 19 levels left to state it in.
        assert_eq!(&px[8..12], &[51, 102, 153, 19]);
    }

    #[test]
    fn a_layer_outside_the_surface_paints_nothing() {
        let surface = IBox {
            x0: 0,
            y0: 0,
            x1: 4,
            y1: 4,
        };
        let far = IBox {
            x0: 100,
            y0: 100,
            x1: 104,
            y1: 104,
        };
        let mut layers = vec![layer(&rect(100.0, 100.0, 104.0, 104.0), far, [1.0; 4], 1.0)];
        assert!(compose(&mut layers, surface).iter().all(|&b| b == 0));
    }
}
