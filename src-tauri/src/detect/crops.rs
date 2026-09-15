//! Generates manga-ocr input crops from detected text blocks.
//!
//! Prefers whole-block crops, falling back to per-line perspective warps for rotated
//! or extreme-aspect blocks. Reproduces OpenCV's fixed-point perspective warp bit-for-bit
//! (5-bit subpixel steps, 15-bit taps) to prevent beam search drift.

use image::{DynamicImage, GrayImage, RgbImage};

use super::textblock::{round_half_even, Language};
use super::textdetector::TextBlockOut;

/// ViT processor square input size (224x224).
const PROCESSOR_INPUT: f64 = 224.0;
/// Rejection threshold for extreme aspect ratio whole-block crops.
const BLOCK_MAX_RATIO: f64 = 16.0;
/// Minimum effective glyph size in processor pixels for whole-block crops.
const BLOCK_MIN_GLYPH: f64 = 20.0;
/// The height every per-line crop is warped to.
pub const TEXT_HEIGHT: usize = 64;
/// Half-width, in text heights, of the window a chunk boundary may move within.
const ANCHOR_WINDOW: usize = 2;

/// Interleaved 8-bit raster (`h` rows of `w * cn` bytes), matching `cv::Mat` layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Raster {
    pub w: usize,
    pub h: usize,
    pub cn: usize,
    pub data: Vec<u8>,
}

impl Raster {
    fn zeroed(w: usize, h: usize, cn: usize) -> Raster {
        Raster { w, h, cn, data: vec![0u8; w * h * cn] }
    }

    pub fn from_rgb(img: &RgbImage) -> Raster {
        Raster {
            w: img.width() as usize,
            h: img.height() as usize,
            cn: 3,
            data: img.as_raw().clone(),
        }
    }

    pub fn from_gray(img: &GrayImage) -> Raster {
        Raster {
            w: img.width() as usize,
            h: img.height() as usize,
            cn: 1,
            data: img.as_raw().clone(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.w == 0 || self.h == 0
    }

    /// Returns the crop with red and blue swapped, matching the BGR-as-RGB order Python fed to PIL.
    pub fn as_python_saw_it(&self) -> DynamicImage {
        assert_eq!(self.cn, 3, "only colour crops go to the OCR");
        let mut out = self.data.clone();
        for px in out.chunks_exact_mut(3) {
            px.swap(0, 2);
        }
        DynamicImage::ImageRgb8(
            RgbImage::from_raw(self.w as u32, self.h as u32, out).expect("sized above"),
        )
    }

    /// `cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)`.
    fn rotate90_ccw(&self) -> Raster {
        let mut out = Raster::zeroed(self.h, self.w, self.cn);
        for r in 0..self.w {
            for c in 0..self.h {
                let src = (c * self.w + (self.w - 1 - r)) * self.cn;
                let dst = (r * self.h + c) * self.cn;
                out.data[dst..dst + self.cn].copy_from_slice(&self.data[src..src + self.cn]);
            }
        }
        out
    }

    /// `cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)`.
    fn rotate90_cw(&self) -> Raster {
        let mut out = Raster::zeroed(self.h, self.w, self.cn);
        for r in 0..self.w {
            for c in 0..self.h {
                let src = ((self.h - 1 - c) * self.w + r) * self.cn;
                let dst = (r * self.h + c) * self.cn;
                out.data[dst..dst + self.cn].copy_from_slice(&self.data[src..src + self.cn]);
            }
        }
        out
    }

    /// A column range, matching `np.split(..., axis=1)`.
    fn columns(&self, x0: usize, x1: usize) -> Raster {
        let x0 = x0.min(self.w);
        let x1 = x1.clamp(x0, self.w);
        let mut out = Raster::zeroed(x1 - x0, self.h, self.cn);
        for y in 0..self.h {
            let s = (y * self.w + x0) * self.cn;
            let d = y * (x1 - x0) * self.cn;
            out.data[d..d + (x1 - x0) * self.cn]
                .copy_from_slice(&self.data[s..s + (x1 - x0) * self.cn]);
        }
        out
    }
}

// ---------------------------------------------------------------------------
// The homography
// ---------------------------------------------------------------------------

/// Direct 4-point homography DLT solve matching `cv2.findHomography(src, dst, 0)`.
///
/// Converts points to `f32` first and solves in Hartley-normalized coordinates
/// to reproduce OpenCV's numerical precision. Returns `None` for degenerate quads.
pub fn find_homography_4(src: [[f64; 2]; 4], dst: [[f64; 2]; 4]) -> Option<[f64; 9]> {
    // Initial round-trip to f32 matching OpenCV's CV_32F conversion.
    let big = |p: [[f64; 2]; 4]| p.map(|q| [q[0] as f32 as f64, q[1] as f32 as f64]);
    let (m_src, m_dst) = (big(src), big(dst));

    let n = 4.0;
    let mut c_src = [0.0f64; 2];
    let mut c_dst = [0.0f64; 2];
    for i in 0..4 {
        c_src[0] += m_src[i][0];
        c_src[1] += m_src[i][1];
        c_dst[0] += m_dst[i][0];
        c_dst[1] += m_dst[i][1];
    }
    for k in 0..2 {
        c_src[k] /= n;
        c_dst[k] /= n;
    }
    let mut s_src = [0.0f64; 2];
    let mut s_dst = [0.0f64; 2];
    for i in 0..4 {
        for k in 0..2 {
            s_src[k] += (m_src[i][k] - c_src[k]).abs();
            s_dst[k] += (m_dst[i][k] - c_dst[k]).abs();
        }
    }
    // Degeneracy check matching OpenCV.
    if s_src.iter().chain(s_dst.iter()).any(|v| v.abs() < f64::EPSILON) {
        return None;
    }
    for k in 0..2 {
        s_src[k] = n / s_src[k];
        s_dst[k] = n / s_dst[k];
    }

    // 8x8 system with h8 = 1.
    let mut a = [[0.0f64; 8]; 8];
    let mut b = [0.0f64; 8];
    for i in 0..4 {
        let bx = (m_src[i][0] - c_src[0]) * s_src[0];
        let by = (m_src[i][1] - c_src[1]) * s_src[1];
        let sx = (m_dst[i][0] - c_dst[0]) * s_dst[0];
        let sy = (m_dst[i][1] - c_dst[1]) * s_dst[1];
        a[i * 2] = [bx, by, 1.0, 0.0, 0.0, 0.0, -sx * bx, -sx * by];
        b[i * 2] = sx;
        a[i * 2 + 1] = [0.0, 0.0, 0.0, bx, by, 1.0, -sy * bx, -sy * by];
        b[i * 2 + 1] = sy;
    }
    let h = solve8(&mut a, &mut b)?;
    let h0 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1.0];

    // H = invHnorm(dst) * H0 * Hnorm(src).
    let inv_hnorm = [1.0 / s_dst[0], 0.0, c_dst[0], 0.0, 1.0 / s_dst[1], c_dst[1], 0.0, 0.0, 1.0];
    let hnorm2 = [s_src[0], 0.0, -c_src[0] * s_src[0], 0.0, s_src[1], -c_src[1] * s_src[1], 0.0, 0.0, 1.0];
    let mut h = mat3_mul(&mat3_mul(&inv_hnorm, &h0), &hnorm2);
    if h[8] == 0.0 {
        return None;
    }
    let s = 1.0 / h[8];
    for v in h.iter_mut() {
        *v *= s;
    }
    Some(h)
}

fn mat3_mul(a: &[f64; 9], b: &[f64; 9]) -> [f64; 9] {
    let mut o = [0.0f64; 9];
    for r in 0..3 {
        for c in 0..3 {
            o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
        }
    }
    o
}

/// Gaussian elimination with partial pivoting on an 8x8 system.
fn solve8(a: &mut [[f64; 8]; 8], b: &mut [f64; 8]) -> Option<[f64; 8]> {
    for col in 0..8 {
        let piv = (col..8).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))?;
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        b.swap(col, piv);
        for row in col + 1..8 {
            let f = a[row][col] / a[col][col];
            if f == 0.0 {
                continue;
            }
            let (upper, lower) = a.split_at_mut(row);
            for (dst, src) in lower[0][col..].iter_mut().zip(upper[col][col..].iter()) {
                *dst -= f * src;
            }
            b[row] -= f * b[col];
        }
    }
    let mut x = [0.0f64; 8];
    for row in (0..8).rev() {
        let mut acc = b[row];
        for k in row + 1..8 {
            acc -= a[row][k] * x[k];
        }
        x[row] = acc / a[row][row];
    }
    Some(x)
}

/// Analytic 3x3 matrix inverse matching OpenCV's adjugate path.
fn invert3(m: &[f64; 9]) -> Option<[f64; 9]> {
    let d = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6])
        + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if d == 0.0 {
        return None;
    }
    let d = 1.0 / d;
    Some([
        (m[4] * m[8] - m[5] * m[7]) * d,
        (m[2] * m[7] - m[1] * m[8]) * d,
        (m[1] * m[5] - m[2] * m[4]) * d,
        (m[5] * m[6] - m[3] * m[8]) * d,
        (m[0] * m[8] - m[2] * m[6]) * d,
        (m[2] * m[3] - m[0] * m[5]) * d,
        (m[3] * m[7] - m[4] * m[6]) * d,
        (m[1] * m[6] - m[0] * m[7]) * d,
        (m[0] * m[4] - m[1] * m[3]) * d,
    ])
}

// ---------------------------------------------------------------------------
// The warp
// ---------------------------------------------------------------------------

/// Sub-pixel resolution of the interpolation table: `INTER_BITS = 5`.
const INTER_BITS: i32 = 5;
const INTER_TAB_SIZE: i32 = 1 << INTER_BITS;
/// Tap weights are 15-bit fixed point, summing to `1 << 15` per pixel.
const INTER_REMAP_COEF_BITS: i32 = 15;

/// Fixed-point perspective warp matching OpenCV's `warpPerspective` (`INTER_LINEAR`, constant 0 border).
///
/// Inverts `m` analytically, evaluates in 32x32 blocks to preserve non-associative float addition order,
/// samples via 5-bit subpixel steps with 15-bit tap weights, and rounds via `(v + 16384) >> 15`.
pub fn warp_perspective(src: &Raster, m: &[f64; 9], dw: usize, dh: usize) -> Raster {
    let mut dst = Raster::zeroed(dw, dh, src.cn);
    if dw == 0 || dh == 0 || src.is_empty() {
        return dst;
    }
    let Some(m) = invert3(m) else { return dst };

    const BLOCK_SZ: usize = 32;
    let mut bh0 = (BLOCK_SZ / 2).min(dh);
    let bw0 = (BLOCK_SZ * BLOCK_SZ / bh0.max(1)).min(dw);
    bh0 = (BLOCK_SZ * BLOCK_SZ / bw0.max(1)).min(dh);
    let (bw0, bh0) = (bw0.max(1), bh0.max(1));

    let cn = src.cn;
    let sstep = src.w * cn;
    let width1 = src.w as i64 - 1;
    let height1 = src.h as i64 - 1;

    let mut y = 0usize;
    while y < dh {
        let bh = bh0.min(dh - y);
        let mut x = 0usize;
        while x < dw {
            let bw = bw0.min(dw - x);
            for y1 in 0..bh {
                let yy = (y + y1) as f64;
                let x0 = m[0] * x as f64 + m[1] * yy + m[2];
                let y0 = m[3] * x as f64 + m[4] * yy + m[5];
                let w0 = m[6] * x as f64 + m[7] * yy + m[8];
                let drow = (y + y1) * dw * cn;
                for x1 in 0..bw {
                    let wv = w0 + m[6] * x1 as f64;
                    let wv = if wv != 0.0 { INTER_TAB_SIZE as f64 / wv } else { 0.0 };
                    let fx = ((x0 + m[0] * x1 as f64) * wv)
                        .clamp(i32::MIN as f64, i32::MAX as f64);
                    let fy = ((y0 + m[3] * x1 as f64) * wv)
                        .clamp(i32::MIN as f64, i32::MAX as f64);
                    let xi = cv_round(fx);
                    let yi = cv_round(fy);
                    let sx = (xi >> INTER_BITS) as i64;
                    let sy = (yi >> INTER_BITS) as i64;
                    let alpha = (((yi & (INTER_TAB_SIZE - 1)) * INTER_TAB_SIZE)
                        + (xi & (INTER_TAB_SIZE - 1))) as usize;
                    let w = bilinear_taps(alpha);

                    let d = drow + (x + x1) * cn;
                    if sx >= 0 && sx < width1 && sy >= 0 && sy < height1 {
                        let s = sy as usize * sstep + sx as usize * cn;
                        for k in 0..cn {
                            let v = src.data[s + k] as i32 * w[0]
                                + src.data[s + cn + k] as i32 * w[1]
                                + src.data[s + sstep + k] as i32 * w[2]
                                + src.data[s + sstep + cn + k] as i32 * w[3];
                            dst.data[d + k] = fixed_pt_cast(v);
                        }
                    } else if sx >= src.w as i64 || sx + 1 < 0 || sy >= src.h as i64 || sy + 1 < 0 {
                        // Constant border value (0).
                        for k in 0..cn {
                            dst.data[d + k] = 0;
                        }
                    } else {
                        // Straddling edge: out-of-bounds taps use border value 0.
                        let tap = |sx: i64, sy: i64, k: usize| -> i32 {
                            if sx < 0 || sy < 0 || sx >= src.w as i64 || sy >= src.h as i64 {
                                0
                            } else {
                                src.data[sy as usize * sstep + sx as usize * cn + k] as i32
                            }
                        };
                        for k in 0..cn {
                            let v = tap(sx, sy, k) * w[0]
                                + tap(sx + 1, sy, k) * w[1]
                                + tap(sx, sy + 1, k) * w[2]
                                + tap(sx + 1, sy + 1, k) * w[3];
                            dst.data[d + k] = fixed_pt_cast(v);
                        }
                    }
                }
            }
            x += bw0;
        }
        y += bh0;
    }
    dst
}

/// 4-tap bilinear interpolation weights for one sub-pixel cell (15-bit fixed point).
fn bilinear_taps(alpha: usize) -> [i32; 4] {
    let i = (alpha >> 5) as i32; // y fraction, 0..31
    let j = (alpha & 31) as i32; // x fraction, 0..31
    [
        (32 - i) * (32 - j) * 32,
        (32 - i) * j * 32,
        i * (32 - j) * 32,
        i * j * 32,
    ]
}

/// `FixedPtCast<int, uchar, 15>`: round to nearest, then saturate.
fn fixed_pt_cast(v: i32) -> u8 {
    let r = (v + (1 << (INTER_REMAP_COEF_BITS - 1))) >> INTER_REMAP_COEF_BITS;
    r.clamp(0, 255) as u8
}

/// Nearest integer with ties to even, matching OpenCV's `cvRound` / FPU rounding.
fn cv_round(v: f64) -> i32 {
    let r = v.round();
    let r = if (v - v.trunc()).abs() == 0.5 && r % 2.0 != 0.0 { r - v.signum() } else { r };
    r as i32
}

// ---------------------------------------------------------------------------
// Whole-block crops
// ---------------------------------------------------------------------------

/// Extracts a single whole-block crop, or `None` if rotated or too extreme for 224x224 resize.
pub fn block_crop(img: &Raster, blk: &TextBlockOut) -> Option<Raster> {
    if blk.angle != 0 {
        return None;
    }
    let (im_w, im_h) = (img.w as i32, img.h as i32);
    let [rx1, ry1, rx2, ry2] = blk.xyxy;

    // English and horizontal-unknown blocks use font_size/3 padding; others use box-derived padding.
    let pad = if blk.language == Language::Eng
        || (blk.language == Language::Unknown && !blk.vertical)
    {
        round_half_even(blk.font_size / 3.0) as i32
    } else {
        // Padded box margin clamped to 2..8 px.
        (((rx2 - rx1).min(ry2 - ry1)) / 16).clamp(2, 8)
    };
    let x1 = (rx1 - pad).max(0);
    let y1 = (ry1 - pad).max(0);
    let x2 = (rx2 + pad).min(im_w);
    let y2 = (ry2 + pad).min(im_h);
    let (w, h) = (x2 - x1, y2 - y1);
    if w <= 1 || h <= 1 {
        return None;
    }
    let (long, short) = (w.max(h) as f64, w.min(h) as f64);
    if long / short > BLOCK_MAX_RATIO {
        return None;
    }
    if blk.font_size * PROCESSOR_INPUT / long < BLOCK_MIN_GLYPH {
        return None;
    }

    let cn = img.cn;
    let mut out = Raster::zeroed(w as usize, h as usize, cn);
    for row in 0..h as usize {
        let s = ((y1 as usize + row) * img.w + x1 as usize) * cn;
        let d = row * w as usize * cn;
        out.data[d..d + w as usize * cn].copy_from_slice(&img.data[s..s + w as usize * cn]);
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Per-line crops
// ---------------------------------------------------------------------------

/// Rectifies one line quad to fixed `textheight` (64 px), rotating vertical text 90 deg CCW.
pub fn transformed_region(
    img: &Raster,
    blk: &TextBlockOut,
    idx: usize,
    textheight: usize,
) -> Option<Raster> {
    let (im_w, im_h) = (img.w as f64, img.h as f64);
    let quad = blk.lines.get(idx)?;
    let mut src: [[f64; 2]; 4] = [[0.0; 2]; 4];
    for (s, p) in src.iter_mut().zip(quad.iter()) {
        s[0] = p[0] as f64;
        s[1] = p[1] as f64;
    }

    if blk.language == Language::Eng
        || (blk.language == Language::Unknown && !blk.vertical)
    {
        let e = blk.font_size / 3.0;
        let dx = [-e, e, e, -e];
        let dy = [-e, -e, e, e];
        for k in 0..4 {
            src[k][0] = (src[k][0] + dx[k]).clamp(0.0, im_w);
            src[k][1] = (src[k][1] + dy[k]).clamp(0.0, im_h);
        }
    }

    let mid = |k: usize| {
        [
            (src[(k + 1) % 4][0] + src[k][0]) / 2.0,
            (src[(k + 1) % 4][1] + src[k][1]) / 2.0,
        ]
    };
    let (m0, m1, m2, m3) = (mid(0), mid(1), mid(2), mid(3));
    let vec_v = (m2[0] - m0[0], m2[1] - m0[1]);
    let vec_h = (m1[0] - m3[0], m1[1] - m3[1]);
    let ratio = vec_v.0.hypot(vec_v.1) / vec_h.0.hypot(vec_h.1);
    if !ratio.is_finite() || ratio <= 0.0 {
        return None;
    }

    let (w, h) = if blk.vertical {
        (textheight as f64, round_half_even(textheight as f64 * ratio))
    } else {
        (round_half_even(textheight as f64 / ratio), textheight as f64)
    };
    // Reject degenerate/zero-area quads.
    if w < 1.0 || h < 1.0 || w.is_nan() || h.is_nan() {
        return None;
    }
    let (w, h) = (w as usize, h as usize);

    let dst = [
        [0.0, 0.0],
        [(w - 1) as f64, 0.0],
        [(w - 1) as f64, (h - 1) as f64],
        [0.0, (h - 1) as f64],
    ];
    let m = find_homography_4(src, dst)?;
    let region = warp_perspective(img, &m, w, h);
    Some(if blk.vertical { region.rotate90_ccw() } else { region })
}

/// `scipy.signal.windows.gaussian(m, std)`, symmetric.
fn gaussian_window(m: usize, std: f64) -> Vec<f64> {
    let centre = (m as f64 - 1.0) / 2.0;
    let sig2 = 2.0 * std * std;
    (0..m)
        .map(|i| {
            let n = i as f64 - centre;
            (-(n * n) / sig2).exp()
        })
        .collect()
}

/// `np.convolve(a, k, "same")`, preserving numpy's half-tap left offset for even kernels.
fn convolve_same(a: &[f64], k: &[f64]) -> Vec<f64> {
    if a.len() < k.len() {
        return convolve_same(k, a);
    }
    let n2 = k.len() as i64;
    let n_left = n2 / 2;
    (0..a.len() as i64)
        .map(|i| {
            let mut acc = 0.0f64;
            for j in 0..n2 {
                let idx = i - n_left + j;
                if idx >= 0 && (idx as usize) < a.len() {
                    acc += a[idx as usize] * k[(n2 - 1 - j) as usize];
                }
            }
            acc
        })
        .collect()
}

/// Cuts an over-long line where the text mask ink density is thinnest within a 2-textheight window.
fn split_into_chunks(
    img: &Raster,
    mask: &Raster,
    blk: &TextBlockOut,
    line_idx: usize,
    textheight: usize,
    max_ratio: f64,
    anchor_window: usize,
) -> Vec<Raster> {
    let Some(line_crop) = transformed_region(img, blk, line_idx, textheight) else {
        return Vec::new();
    };
    let (h, w) = (line_crop.h, line_crop.w);
    if h == 0 || w == 0 {
        return Vec::new();
    }
    let ratio = w as f64 / h as f64;
    if ratio <= max_ratio {
        return vec![line_crop];
    }

    let k = gaussian_window(textheight * 2, textheight as f64 / 8.0);
    let Some(line_mask) = transformed_region(mask, blk, line_idx, textheight) else {
        return vec![line_crop];
    };
    let num_chunks = (ratio / max_ratio).ceil() as usize;
    if num_chunks < 2 {
        return vec![line_crop];
    }

    let col_sum: Vec<f64> = (0..line_mask.w)
        .map(|x| {
            (0..line_mask.h)
                .map(|y| line_mask.data[y * line_mask.w + x] as f64)
                .sum()
        })
        .collect();
    let mut density = convolve_same(&col_sum, &k);
    let peak = density.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if peak <= 0.0 {
        // Empty line mask fallback.
        return vec![line_crop];
    }
    for v in density.iter_mut() {
        *v /= peak;
    }

    let win = (anchor_window * textheight) as i64;
    let mut cuts: Vec<usize> = Vec::with_capacity(num_chunks - 1);
    for i in 1..num_chunks {
        // Target cut anchors.
        let anchor = (w as f64 * i as f64 / num_chunks as f64) as i64;
        let n0 = (anchor - win / 2).clamp(0, w as i64) as usize;
        let n1 = (anchor + win / 2).clamp(0, w as i64) as usize;
        if n1 <= n0 {
            cuts.push(n0);
            continue;
        }
        let mut best = n0;
        for x in n0..n1.min(density.len()) {
            if density[x] < density[best] {
                best = x;
            }
        }
        cuts.push(best);
    }

    let mut out = Vec::with_capacity(num_chunks);
    let mut prev = 0usize;
    for &c in &cuts {
        out.push(line_crop.columns(prev, c));
        prev = c.min(w);
    }
    out.push(line_crop.columns(prev, w));
    out
}

/// Returns all OCR crops for a text block (whole-block crop or per-line fallback chunks).
pub fn gather_crops(
    img: &Raster,
    mask: &Raster,
    blk: &TextBlockOut,
    lines_mode: bool,
) -> Vec<Raster> {
    if !lines_mode {
        if let Some(c) = block_crop(img, blk) {
            return vec![c];
        }
    }
    let max_ratio = if blk.vertical { 16.0 } else { 8.0 };
    let mut out = Vec::new();
    for idx in 0..blk.lines.len() {
        for chunk in split_into_chunks(img, mask, blk, idx, TEXT_HEIGHT, max_ratio, ANCHOR_WINDOW) {
            let chunk = if blk.vertical { chunk.rotate90_cw() } else { chunk };
            // Skip degenerate empty chunks.
            if !chunk.is_empty() {
                out.push(chunk);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::textblock::Quad;

    fn blk(xyxy: [i32; 4], lines: Vec<Quad>, vertical: bool, font_size: f64) -> TextBlockOut {
        TextBlockOut {
            xyxy,
            lines,
            vertical,
            font_size,
            angle: 0,
            language: Language::Ja,
        }
    }

    fn gradient(w: usize, h: usize) -> Raster {
        let mut r = Raster::zeroed(w, h, 3);
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                r.data[i] = (x % 256) as u8;
                r.data[i + 1] = (y % 256) as u8;
                r.data[i + 2] = ((x + y) % 256) as u8;
            }
        }
        r
    }

    #[test]
    fn a_rotated_block_has_no_whole_block_crop() {
        let mut b = blk([10, 10, 100, 200], vec![], true, 30.0);
        b.angle = 12;
        assert!(block_crop(&gradient(300, 300), &b).is_none());
    }

    #[test]
    fn a_japanese_block_is_padded_from_its_box_not_its_font() {
        // min(90, 190) // 16 = 5, inside the 2..8 clamp.
        let b = blk([10, 10, 100, 200], vec![], true, 300.0);
        let c = block_crop(&gradient(300, 300), &b).expect("crop");
        assert_eq!((c.w, c.h), (90 + 10, 190 + 10));
    }

    #[test]
    fn the_box_pad_is_clamped_at_both_ends() {
        let img = gradient(600, 600);
        // 20 // 16 = 1, below the floor of 2.
        let small = blk([100, 100, 120, 400], vec![], true, 300.0);
        let c = block_crop(&img, &small).expect("crop");
        assert_eq!((c.w, c.h), (24, 304));
        // 400 // 16 = 25, above the ceiling of 8.
        let big = blk([50, 50, 450, 450], vec![], true, 300.0);
        let c = block_crop(&img, &big).expect("crop");
        assert_eq!((c.w, c.h), (416, 416));
    }

    #[test]
    fn an_english_block_is_padded_from_its_font_size() {
        let mut b = blk([100, 100, 400, 140], vec![], false, 30.0);
        b.language = Language::Eng;
        // round(30 / 3) = 10 on every side.
        let c = block_crop(&gradient(600, 600), &b).expect("crop");
        assert_eq!((c.w, c.h), (320, 60));
    }

    #[test]
    fn a_crop_flatter_than_sixteen_to_one_is_rejected() {
        // 400 x 20, padded by 2 -> 404 x 24, ratio 16.8.
        let b = blk([100, 100, 500, 120], vec![], false, 300.0);
        assert!(block_crop(&gradient(700, 700), &b).is_none());
    }

    #[test]
    fn a_crop_whose_glyphs_would_not_survive_the_resize_is_rejected() {
        // 224 * 10 / 404 = 5.5 effective pixels, well under 20.
        let b = blk([100, 100, 500, 300], vec![], true, 10.0);
        assert!(block_crop(&gradient(700, 700), &b).is_none());
    }

    #[test]
    fn a_crop_is_clipped_to_the_page() {
        let b = blk([-40, -40, 60, 160], vec![], true, 300.0);
        let c = block_crop(&gradient(200, 200), &b).expect("crop");
        assert_eq!((c.w, c.h), (66, 166));
        // Top-left of the crop is the page's own top-left, not a padded void.
        assert_eq!(&c.data[0..3], &[0, 0, 0]);
    }

    #[test]
    fn a_box_entirely_off_the_page_produces_nothing() {
        let b = blk([500, 500, 600, 700], vec![], true, 300.0);
        assert!(block_crop(&gradient(200, 200), &b).is_none());
    }

    #[test]
    fn the_homography_of_a_rectangle_is_the_affine_map_between_them() {
        let src = [[10.0, 20.0], [110.0, 20.0], [110.0, 70.0], [10.0, 70.0]];
        let dst = [[0.0, 0.0], [49.0, 0.0], [49.0, 24.0], [0.0, 24.0]];
        let m = find_homography_4(src, dst).expect("homography");
        for (s, d) in src.iter().zip(dst.iter()) {
            let w = m[6] * s[0] + m[7] * s[1] + m[8];
            let x = (m[0] * s[0] + m[1] * s[1] + m[2]) / w;
            let y = (m[3] * s[0] + m[4] * s[1] + m[5]) / w;
            assert!((x - d[0]).abs() < 1e-9, "{x} vs {}", d[0]);
            assert!((y - d[1]).abs() < 1e-9, "{y} vs {}", d[1]);
        }
        assert!((m[8] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn the_homography_of_a_genuine_perspective_quad_maps_all_four_corners() {
        let src = [[12.0, 30.0], [200.0, 10.0], [220.0, 130.0], [5.0, 90.0]];
        let dst = [[0.0, 0.0], [63.0, 0.0], [63.0, 31.0], [0.0, 31.0]];
        let m = find_homography_4(src, dst).expect("homography");
        for (s, d) in src.iter().zip(dst.iter()) {
            let w = m[6] * s[0] + m[7] * s[1] + m[8];
            let x = (m[0] * s[0] + m[1] * s[1] + m[2]) / w;
            let y = (m[3] * s[0] + m[4] * s[1] + m[5]) / w;
            assert!((x - d[0]).abs() < 1e-8, "{x} vs {}", d[0]);
            assert!((y - d[1]).abs() < 1e-8, "{y} vs {}", d[1]);
        }
    }

    #[test]
    fn a_collapsed_quad_has_no_homography() {
        let src = [[10.0, 20.0], [110.0, 20.0], [110.0, 20.0], [10.0, 20.0]];
        let dst = [[0.0, 0.0], [49.0, 0.0], [49.0, 24.0], [0.0, 24.0]];
        assert!(find_homography_4(src, dst).is_none());
    }

    #[test]
    fn inverting_a_matrix_twice_returns_it() {
        let m = [1.5, 0.2, -30.0, -0.1, 2.0, 12.0, 0.0003, -0.0001, 1.0];
        let back = invert3(&invert3(&m).unwrap()).unwrap();
        for (a, b) in m.iter().zip(back.iter()) {
            assert!((a - b).abs() < 1e-9, "{a} vs {b}");
        }
        assert!(invert3(&[1.0, 2.0, 3.0, 2.0, 4.0, 6.0, 1.0, 1.0, 1.0]).is_none());
    }

    #[test]
    fn an_identity_warp_copies_the_image() {
        let src = gradient(40, 30);
        let id = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        assert_eq!(warp_perspective(&src, &id, 40, 30), src);
    }

    #[test]
    fn an_integer_translation_warp_shifts_by_whole_pixels() {
        let src = gradient(40, 30);
        // Maps source (x, y) to destination (x - 5, y - 3).
        let m = [1.0, 0.0, -5.0, 0.0, 1.0, -3.0, 0.0, 0.0, 1.0];
        let out = warp_perspective(&src, &m, 20, 20);
        for y in 0..20 {
            for x in 0..20 {
                let d = (y * 20 + x) * 3;
                let s = ((y + 3) * 40 + (x + 5)) * 3;
                assert_eq!(&out.data[d..d + 3], &src.data[s..s + 3], "({x},{y})");
            }
        }
    }

    #[test]
    fn a_half_pixel_warp_is_the_fixed_point_average_of_two_neighbours() {
        // A one-dimensional ramp, sampled exactly between two columns. The
        // fixed-point path lands on the true midpoint here; the value of the
        // test is that it lands there and not one count off.
        let mut src = Raster::zeroed(4, 1, 1);
        src.data = vec![0, 100, 200, 255];
        // Destination x maps back to source x + 0.5, i.e. halfway between two
        // columns every time. 227.5 rounding up to 228 is the `+ 16384 >> 15`.
        let m = [1.0, 0.0, -0.5, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let out = warp_perspective(&src, &m, 3, 1);
        assert_eq!(out.data, vec![50, 150, 228]);
    }

    #[test]
    fn a_warp_off_the_edge_reads_the_constant_border_not_the_nearest_pixel() {
        let mut src = Raster::zeroed(2, 1, 1);
        src.data = vec![200, 200];
        // Destination x maps to source x - 1, so column 0 sits at source -1.
        let m = [1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let out = warp_perspective(&src, &m, 4, 1);
        assert_eq!(out.data, vec![0, 200, 200, 0]);
    }

    #[test]
    fn the_bilinear_taps_always_sum_to_one() {
        for alpha in 0..(32 * 32) {
            let w = bilinear_taps(alpha);
            assert_eq!(w.iter().sum::<i32>(), 1 << 15, "alpha {alpha}");
        }
        // Corner cell: all the weight on the top-left tap.
        assert_eq!(bilinear_taps(0), [1 << 15, 0, 0, 0]);
    }

    #[test]
    fn cv_round_breaks_ties_toward_even() {
        assert_eq!(cv_round(0.5), 0);
        assert_eq!(cv_round(1.5), 2);
        assert_eq!(cv_round(2.5), 2);
        assert_eq!(cv_round(-0.5), 0);
        assert_eq!(cv_round(-1.5), -2);
        assert_eq!(cv_round(2.4), 2);
    }

    #[test]
    fn rotating_a_raster_four_quarter_turns_returns_it() {
        let r = gradient(7, 5);
        assert_eq!(r.rotate90_ccw().rotate90_cw(), r);
        assert_eq!(r.rotate90_cw().rotate90_ccw(), r);
        assert_eq!(r.rotate90_ccw().dimensions_for_test(), (5, 7));
    }

    #[test]
    fn rotating_counter_clockwise_moves_the_top_right_to_the_top_left() {
        let mut r = Raster::zeroed(3, 2, 1);
        r.data = vec![1, 2, 3, 4, 5, 6];
        // Rows become columns: the last column (3, 6) becomes the first row.
        assert_eq!(r.rotate90_ccw().data, vec![3, 6, 2, 5, 1, 4]);
        assert_eq!(r.rotate90_cw().data, vec![4, 1, 5, 2, 6, 3]);
    }

    #[test]
    fn a_vertical_line_rectifies_to_a_sixty_four_wide_strip() {
        // A tall quad: the warp makes a 64-wide, tall strip, and the CCW
        // rotation lays it on its side, which is what the splitter expects.
        let b = blk(
            [100, 100, 140, 500],
            vec![[[100, 100], [140, 100], [140, 500], [100, 500]]],
            true,
            40.0,
        );
        let r = transformed_region(&gradient(600, 600), &b, 0, 64).expect("region");
        assert_eq!(r.h, 64);
        assert_eq!(r.w, 640, "64 * (400 / 40)");
    }

    #[test]
    fn a_horizontal_line_rectifies_to_a_sixty_four_tall_strip() {
        let b = blk(
            [100, 100, 500, 140],
            vec![[[100, 100], [500, 100], [500, 140], [100, 140]]],
            false,
            40.0,
        );
        let r = transformed_region(&gradient(600, 600), &b, 0, 64).expect("region");
        assert_eq!(r.h, 64);
        assert_eq!(r.w, 640, "64 / (40 / 400)");
    }

    #[test]
    fn the_gaussian_window_matches_scipys_formula() {
        let w = gaussian_window(128, 8.0);
        assert_eq!(w.len(), 128);
        // Symmetric about the half-integer centre, peaking at the two middle
        // samples rather than at one.
        assert!((w[63] - w[64]).abs() < 1e-15);
        assert!(w[63] > w[62] && w[64] > w[65]);
        assert!((w[63] - (-0.25f64 / 128.0).exp()).abs() < 1e-12);
        assert!(w[0] < 1e-8);
    }

    #[test]
    fn convolve_same_keeps_numpys_off_centre_window() {
        // A single impulse convolved with a ramp kernel: the output shows where
        // numpy's "same" window sits. With an even kernel the peak lands one
        // sample left of the naive centre.
        let mut a = vec![0.0; 12];
        a[6] = 1.0;
        let k = vec![1.0, 2.0, 3.0, 4.0];
        let out = convolve_same(&a, &k);
        assert_eq!(out.len(), 12);
        assert_eq!(out[5], 1.0);
        assert_eq!(out[6], 2.0);
        assert_eq!(out[7], 3.0);
        assert_eq!(out[8], 4.0);
    }

    #[test]
    fn a_line_within_the_ratio_is_not_split() {
        let img = gradient(600, 600);
        let mask = Raster::zeroed(600, 600, 1);
        let b = blk(
            [100, 100, 140, 400],
            vec![[[100, 100], [140, 100], [140, 400], [100, 400]]],
            true,
            40.0,
        );
        let chunks = split_into_chunks(&img, &mask, &b, 0, 64, 16.0, 2);
        assert_eq!(chunks.len(), 1);
    }

    #[test]
    fn a_line_over_the_ratio_is_cut_at_the_thinnest_column() {
        // A 40 x 1400 vertical line rectifies to 64 x ~2240 (35 text heights, over 16 limit -> 3 chunks).
        let img = gradient(600, 1600);
        let mut mask = Raster::zeroed(600, 1600, 1);
        for y in 100..1500 {
            for x in 100..140 {
                mask.data[y * 600 + x] = 255;
            }
        }
        // Two gaps in page coordinates, offset from the thirds of the line.
        for y in [560usize, 1080] {
            for yy in y..y + 24 {
                for x in 100..140 {
                    mask.data[yy * 600 + x] = 0;
                }
            }
        }
        let b = blk(
            [100, 100, 140, 1500],
            vec![[[100, 100], [140, 100], [140, 1500], [100, 1500]]],
            true,
            40.0,
        );
        let chunks = split_into_chunks(&img, &mask, &b, 0, 64, 16.0, 2);
        assert_eq!(chunks.len(), 3, "35 / 16 rounds up to 3");
        assert!(chunks.iter().all(|c| c.h == 64 && c.w > 0));
        assert_eq!(chunks.iter().map(|c| c.w).sum::<usize>(), 2240);
        // The first cut sits inside the first gap, which the warp puts around
        // column (560 - 100) / 1400 * 2240 = 736, not at the anchor of 746.
        let first = chunks[0].w;
        assert!((730..=760).contains(&first), "first cut at {first}");
        assert_ne!(first, 746, "the cut should have moved off the anchor");
    }

    #[test]
    fn an_empty_mask_leaves_a_long_line_whole() {
        let img = gradient(600, 1600);
        let mask = Raster::zeroed(600, 1600, 1);
        let b = blk(
            [100, 100, 140, 1500],
            vec![[[100, 100], [140, 100], [140, 1500], [100, 1500]]],
            true,
            40.0,
        );
        assert_eq!(split_into_chunks(&img, &mask, &b, 0, 64, 16.0, 2).len(), 1);
    }

    #[test]
    fn gather_prefers_one_whole_block_crop_and_falls_back_per_line() {
        let img = gradient(600, 600);
        let mask = Raster::zeroed(600, 600, 1);
        let b = blk(
            [100, 100, 200, 400],
            vec![
                [[160, 110], [195, 110], [195, 390], [160, 390]],
                [[110, 110], [145, 110], [145, 390], [110, 390]],
            ],
            true,
            35.0,
        );
        assert_eq!(gather_crops(&img, &mask, &b, false).len(), 1);
        let lines = gather_crops(&img, &mask, &b, true);
        assert_eq!(lines.len(), 2);
        // Rotated back upright: vertical crops are 64 wide.
        assert!(lines.iter().all(|c| c.w == 64));
    }

    #[test]
    fn the_ocr_view_of_a_crop_swaps_red_and_blue() {
        let mut r = Raster::zeroed(1, 1, 3);
        r.data = vec![10, 20, 30];
        let img = r.as_python_saw_it().to_rgb8();
        assert_eq!(img.get_pixel(0, 0).0, [30, 20, 10]);
    }

    impl Raster {
        fn dimensions_for_test(&self) -> (usize, usize) {
            (self.w, self.h)
        }
    }

    // ---- golden comparison against the Python sidecar ----

    /// One crop of `line-ocr-golden.json`.
    #[derive(serde::Deserialize)]
    struct GoldenCrop {
        block: usize,
        line: usize,
        chunk: usize,
        crop: String,
        jp: String,
    }

    #[derive(serde::Deserialize)]
    struct GoldenPage {
        file: String,
        crops: Vec<GoldenCrop>,
    }

    /// Verifies line crops match Python sidecar pixel-for-pixel and OCR output matches.
    #[test]
    fn line_crops_match_the_python_sidecar_pixel_for_pixel_and_word_for_word() {
        use super::super::ocr::OcrEngine;
        use super::super::textdetector::TextDetector;

        let Some(home) = std::env::var_os("HOME") else {
            eprintln!("skipping line golden: HOME not set");
            return;
        };
        let models = std::path::PathBuf::from(home).join(".mangatypesetter").join("models");
        for f in [
            models.join("comictextdetector.onnx"),
            models.join("manga-ocr").join("encoder_model.onnx"),
        ] {
            if !f.exists() {
                eprintln!("skipping line golden: model not found at {}", f.display());
                return;
            }
        }
        let fixture_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/analyze-golden");
        let Ok(json) = std::fs::read_to_string(fixture_dir.join("line-ocr-golden.json")) else {
            eprintln!("skipping line golden: fixture not found");
            return;
        };
        let golden: GoldenPage =
            serde_json::from_str(&json).expect("line-ocr-golden.json is not the expected shape");
        if !std::path::Path::new(&golden.file).exists() {
            eprintln!("skipping line golden: page not found at {}", golden.file);
            return;
        }

        let img = image::open(&golden.file).expect("open page");
        let mut detector =
            TextDetector::load(&models.join("comictextdetector.onnx")).expect("load detector");
        let (blocks, mask) = detector.detect(&img, "ja").expect("detect failed");
        let page = Raster::from_rgb(&img.to_rgb8());
        let mask_raster = Raster::from_gray(&mask);

        // Rebuild the fixture's own (block, line, chunk) enumeration.
        let mut produced: Vec<(usize, usize, usize, Raster)> = Vec::new();
        for (bi, blk) in blocks.iter().enumerate() {
            let max_ratio = if blk.vertical { 16.0 } else { 8.0 };
            for li in 0..blk.lines.len() {
                let chunks =
                    split_into_chunks(&page, &mask_raster, blk, li, TEXT_HEIGHT, max_ratio, ANCHOR_WINDOW);
                for (ci, chunk) in chunks.into_iter().enumerate() {
                    let chunk = if blk.vertical { chunk.rotate90_cw() } else { chunk };
                    produced.push((bi, li, ci, chunk));
                }
            }
        }

        let mut failures: Vec<String> = Vec::new();
        assert_eq!(
            produced.len(),
            golden.crops.len(),
            "produced {} crops, fixture has {}",
            produced.len(),
            golden.crops.len()
        );

        // Pass one: geometry.
        let mut worst_pixel = 0i32;
        let mut differing = 0usize;
        for ((bi, li, ci, got), want) in produced.iter().zip(golden.crops.iter()) {
            let tag = format!("crop {}/{}/{} ({})", bi, li, ci, want.crop);
            if (*bi, *li, *ci) != (want.block, want.line, want.chunk) {
                failures.push(format!(
                    "{tag}: fixture expected block/line/chunk {}/{}/{}",
                    want.block, want.line, want.chunk
                ));
                continue;
            }
            let expected = image::open(fixture_dir.join(&want.crop))
                .unwrap_or_else(|e| panic!("{}: {e}", want.crop))
                .to_rgb8();
            if (expected.width() as usize, expected.height() as usize) != (got.w, got.h) {
                failures.push(format!(
                    "{tag}: {}x{}, fixture is {}x{}",
                    got.w,
                    got.h,
                    expected.width(),
                    expected.height()
                ));
                continue;
            }
            let mut local = 0i32;
            for (a, b) in got.data.iter().zip(expected.as_raw().iter()) {
                local = local.max((*a as i32 - *b as i32).abs());
            }
            if local > 0 {
                differing += 1;
                worst_pixel = worst_pixel.max(local);
                failures.push(format!("{tag}: pixels differ by up to {local} counts"));
            }
        }
        eprintln!(
            "line golden geometry: {}/{} crops byte-identical (worst channel delta {worst_pixel})",
            produced.len() - differing,
            produced.len()
        );

        // Pass two: text. Run even if pass one found drift, so the report shows
        // whether the drift was enough to change a read.
        let mut engine = OcrEngine::load(&models.join("manga-ocr")).expect("load OCR");
        let started = std::time::Instant::now();
        let mut text_failures = 0usize;
        for ((bi, li, ci, got), want) in produced.iter().zip(golden.crops.iter()) {
            let read = engine.ocr(&got.as_python_saw_it()).expect("ocr failed");
            if read == want.jp {
                eprintln!("  ok   {bi}/{li}/{ci}: {read}");
            } else {
                eprintln!("  FAIL {bi}/{li}/{ci}\n    python: {}\n    rust:   {read}", want.jp);
                text_failures += 1;
                failures.push(format!("crop {bi}/{li}/{ci}: read {read:?}, expected {:?}", want.jp));
            }
        }
        eprintln!(
            "line golden ocr: {}/{} matched in {:.1}s",
            produced.len() - text_failures,
            produced.len(),
            started.elapsed().as_secs_f64()
        );

        assert!(failures.is_empty(), "line golden mismatches:\n  {}", failures.join("\n  "));
    }
}
