//! Text detector running YOLOv5 (blocks), DBNet (lines), and U-Net (segmentation mask).
//!
//! Reconciles block proposals and line quads into reading-ordered text blocks.

use image::{DynamicImage, GenericImageView, GrayImage};
use ort::session::Session;
use ort::value::Tensor;

use super::cvops::resize_linear_u8;
use super::dbnet::boxes_from_bitmap;
use super::geometry::{nms, BBox};
use super::textblock::{group_output, Language, Quad};

/// Square input size for comic text detector model (1024x1024).
pub const INPUT_SIZE: usize = 1024;
/// Objectness and class-confidence floor for block head.
pub const CONF_THRESHOLD: f32 = 0.4;
/// IoU threshold for NMS on block proposals.
pub const NMS_THRESHOLD: f32 = 0.35;
/// Maximum detections kept after NMS.
pub const MAX_DETECTIONS: usize = 300;
/// Mean shrink-map probability threshold for keeping line quads.
pub const BOX_THRESHOLD: f32 = 0.6;

/// Detected text block in page coordinates.
#[derive(Debug, Clone)]
pub struct TextBlockOut {
    /// Bounding box, `[x1, y1, x2, y2]`.
    pub xyxy: [i32; 4],
    /// Line quads, each four points ordered around the line.
    pub lines: Vec<Quad>,
    /// True when text runs top-to-bottom.
    pub vertical: bool,
    /// Glyph size in pixels (mean line width for vertical, mean line height for horizontal).
    pub font_size: f64,
    /// Rotation in degrees, snapped to 0 below 3.
    pub angle: i32,
    pub language: Language,
}

/// Loaded comic_text_detector ONNX session.
pub struct TextDetector {
    session: Session,
    device: &'static str,
}

impl TextDetector {
    /// Loads the ONNX model on the best provider this machine offers (see `accel`).
    pub fn load(model_path: &std::path::Path) -> ort::Result<TextDetector> {
        let (session, device) = super::accel::open(model_path, false)?;
        Ok(TextDetector { session, device })
    }

    /// Name of the execution provider the model loaded on.
    pub fn device(&self) -> &'static str {
        self.device
    }

    /// Detects text blocks and page-sized mask on an image.
    pub fn detect(&mut self, img: &DynamicImage, lang: &str) -> ort::Result<(Vec<TextBlockOut>, GrayImage)> {
        let (im_w, im_h) = img.dimensions();
        let lb = Letterbox::fit(im_w as usize, im_h as usize);
        let input = Tensor::from_array((
            [1usize, 3, INPUT_SIZE, INPUT_SIZE],
            preprocess(img, &lb),
        ))?;

        let outputs = self.session.run(ort::inputs![input])?;
        let (blk_shape, blk) = outputs["blk"].try_extract_tensor::<f32>()?;
        let (_, seg) = outputs["seg"].try_extract_tensor::<f32>()?;
        let (_, det) = outputs["det"].try_extract_tensor::<f32>()?;

        let anchors = if blk_shape.len() == 3 { blk_shape[1] as usize } else { 0 };
        let channels = if blk_shape.len() == 3 { blk_shape[2] as usize } else { 0 };
        let proposals = decode_blocks(blk, anchors, channels, &lb);

        let mask = page_mask(seg, &lb, im_w, im_h)?;
        let lines = decode_lines(det, &lb);

        let blocks = group_output(&proposals, &lines, im_w as i32, im_h as i32, &mask, lang);
        let out = blocks
            .into_iter()
            .map(|b| TextBlockOut {
                xyxy: b.xyxy,
                lines: b.lines,
                vertical: b.vertical,
                font_size: b.font_size,
                angle: b.angle,
                language: b.language,
            })
            .collect();
        Ok((out, mask))
    }
}

/// Asymmetric letterbox mapping (right and bottom padding only).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Letterbox {
    /// Scaled size of page inside square input.
    pub inner_w: usize,
    pub inner_h: usize,
    /// Right and bottom padding in model pixels.
    pub pad_w: usize,
    pub pad_h: usize,
    /// Page pixels per model pixel per axis.
    pub ratio_x: f64,
    pub ratio_y: f64,
}

impl Letterbox {
    pub fn fit(src_w: usize, src_h: usize) -> Letterbox {
        let r = (INPUT_SIZE as f64 / src_h as f64).min(INPUT_SIZE as f64 / src_w as f64);
        let inner_w = (round_half_even(src_w as f64 * r) as usize).max(1);
        let inner_h = (round_half_even(src_h as f64 * r) as usize).max(1);
        let pad_w = INPUT_SIZE - inner_w;
        let pad_h = INPUT_SIZE - inner_h;
        Letterbox {
            inner_w,
            inner_h,
            pad_w,
            pad_h,
            ratio_x: src_w as f64 / (INPUT_SIZE - pad_w) as f64,
            ratio_y: src_h as f64 / (INPUT_SIZE - pad_h) as f64,
        }
    }
}

/// Half-to-even rounding matching Python/NumPy.
fn round_half_even(v: f64) -> f64 {
    let r = v.round();
    if (v - v.trunc()).abs() == 0.5 && r % 2.0 != 0.0 {
        r - v.signum()
    } else {
        r
    }
}

/// Preprocesses image into BGR planar float tensor (BGR matches training data).
pub fn preprocess(img: &DynamicImage, lb: &Letterbox) -> Vec<f32> {
    let (w, h) = img.dimensions();
    let rgb = img.to_rgb8();
    let scaled = resize_linear_u8(rgb.as_raw(), w as usize, h as usize, 3, lb.inner_w, lb.inner_h);

    let plane = INPUT_SIZE * INPUT_SIZE;
    let mut out = vec![0f32; 3 * plane];
    for y in 0..lb.inner_h {
        for x in 0..lb.inner_w {
            let src = (y * lb.inner_w + x) * 3;
            let dst = y * INPUT_SIZE + x;
            // BGR planar order.
            out[dst] = scaled[src + 2] as f32 / 255.0;
            out[plane + dst] = scaled[src + 1] as f32 / 255.0;
            out[2 * plane + dst] = scaled[src] as f32 / 255.0;
        }
    }
    out
}

/// Decodes YOLO block proposals in page coordinates.
fn decode_blocks(data: &[f32], anchors: usize, channels: usize, lb: &Letterbox) -> Vec<([i32; 4], usize)> {
    if channels < 6 || anchors == 0 || data.len() < anchors * channels {
        return Vec::new();
    }
    let num_classes = channels - 5;
    let mut boxes = Vec::new();
    for a in 0..anchors {
        let row = &data[a * channels..(a + 1) * channels];
        let obj = row[4];
        if obj <= CONF_THRESHOLD {
            continue;
        }
        let mut best = 0usize;
        let mut best_conf = f32::MIN;
        for c in 0..num_classes {
            let conf = row[5 + c] * obj;
            if conf > best_conf {
                best_conf = conf;
                best = c;
            }
        }
        if best_conf <= CONF_THRESHOLD {
            continue;
        }
        let (cx, cy, w, h) = (row[0], row[1], row[2], row[3]);
        boxes.push(BBox {
            x1: cx - w / 2.0,
            y1: cy - h / 2.0,
            x2: cx + w / 2.0,
            y2: cy + h / 2.0,
            score: best_conf,
            class: best,
        });
    }

    nms(boxes, NMS_THRESHOLD)
        .into_iter()
        .take(MAX_DETECTIONS)
        .map(|b| {
            let (rx, ry) = (lb.ratio_x as f32, lb.ratio_y as f32);
            (
                [
                    (b.x1 * rx) as i32,
                    (b.y1 * ry) as i32,
                    (b.x2 * rx) as i32,
                    (b.y2 * ry) as i32,
                ],
                b.class,
            )
        })
        .collect()
}

/// Turn the U-Net head into a page-sized 8-bit text mask.
fn page_mask(seg: &[f32], lb: &Letterbox, im_w: u32, im_h: u32) -> ort::Result<GrayImage> {
    let plane = INPUT_SIZE * INPUT_SIZE;
    if seg.len() < plane {
        return Err(ort::Error::new(format!(
            "segmentation head returned {} values, expected at least {}",
            seg.len(), plane
        )));
    }

    // Sigmoid is already applied in the graph; scaling truncates, as
    // `astype(np.uint8)` does.
    let mut cropped = vec![0u8; lb.inner_w * lb.inner_h];
    for y in 0..lb.inner_h {
        for x in 0..lb.inner_w {
            cropped[y * lb.inner_w + x] = (seg[y * INPUT_SIZE + x] * 255.0) as u8;
        }
    }
    let resized = resize_linear_u8(&cropped, lb.inner_w, lb.inner_h, 1, im_w as usize, im_h as usize);
    Ok(GrayImage::from_raw(im_w, im_h, resized).expect("mask buffer sized to the page"))
}

/// Recover line quads from the DBNet head, in page coordinates.
fn decode_lines(det: &[f32], lb: &Letterbox) -> Vec<Quad> {
    let plane = INPUT_SIZE * INPUT_SIZE;
    if det.len() < plane {
        return Vec::new();
    }
    boxes_from_bitmap(&det[..plane], INPUT_SIZE, INPUT_SIZE)
        .into_iter()
        .filter(|q| q.score > BOX_THRESHOLD)
        .map(|q| {
            let mut out = [[0i32; 2]; 4];
            for (o, p) in out.iter_mut().zip(q.pts.iter()) {
                o[0] = (p[0] as f64 * lb.ratio_x) as i32;
                o[1] = (p[1] as f64 * lb.ratio_y) as i32;
            }
            out
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn page(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_pixel(w, h, Rgb([255, 255, 255])))
    }

    #[test]
    fn letterbox_pads_only_the_right_and_bottom() {
        // Pads on right and bottom only, unlike centered YOLO letterboxing.
        let lb = Letterbox::fit(1080, 1535);
        assert_eq!(lb.inner_h, 1024);
        assert_eq!(lb.inner_w, 720);
        assert_eq!(lb.pad_h, 0);
        assert_eq!(lb.pad_w, 304);
        assert!((lb.ratio_x - 1080.0 / 720.0).abs() < 1e-12);
        assert!((lb.ratio_y - 1535.0 / 1024.0).abs() < 1e-12);

        // A webtoon strip so thin its scaled width is less than half a pixel
        // floors to 1 instead of 0, avoiding a division by zero in `ratio_x`.
        let lb_thin = Letterbox::fit(1, 100000);
        assert_eq!(lb_thin.inner_w, 1);
        assert_eq!(lb_thin.inner_h, 1024);
        assert!((lb_thin.ratio_x - 1.0).abs() < 1e-12);
    }

    #[test]
    fn letterbox_ratios_map_the_far_corner_back_to_the_page() {
        for (w, h) in [(1080usize, 1535usize), (1600, 1200), (1024, 1024), (700, 2400)] {
            let lb = Letterbox::fit(w, h);
            assert_eq!(lb.inner_w + lb.pad_w, INPUT_SIZE);
            assert_eq!(lb.inner_h + lb.pad_h, INPUT_SIZE);
            let bx = lb.inner_w as f64 * lb.ratio_x;
            let by = lb.inner_h as f64 * lb.ratio_y;
            assert!((bx - w as f64).abs() < 1e-6, "{w}x{h}: {bx}");
            assert!((by - h as f64).abs() < 1e-6, "{w}x{h}: {by}");
        }
    }

    #[test]
    fn preprocess_produces_the_declared_tensor_size() {
        let lb = Letterbox::fit(1080, 1535);
        assert_eq!(preprocess(&page(1080, 1535), &lb).len(), 3 * INPUT_SIZE * INPUT_SIZE);
    }

    #[test]
    fn preprocess_pads_with_black_and_orders_channels_bgr() {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(600, 900, Rgb([200, 10, 0])));
        let lb = Letterbox::fit(600, 900);
        let t = preprocess(&img, &lb);
        let plane = INPUT_SIZE * INPUT_SIZE;
        let centre = (lb.inner_h / 2) * INPUT_SIZE + lb.inner_w / 2;
        assert!(t[centre] < 0.01, "blue plane {}", t[centre]);
        assert!((t[plane + centre] - 10.0 / 255.0).abs() < 0.01);
        assert!((t[2 * plane + centre] - 200.0 / 255.0).abs() < 0.01);
        // Padding is on the right, and it is black.
        assert_eq!(t[INPUT_SIZE / 2 * INPUT_SIZE + INPUT_SIZE - 1], 0.0);
        assert_eq!(t[2 * plane + INPUT_SIZE / 2 * INPUT_SIZE + INPUT_SIZE - 1], 0.0);
    }

    #[test]
    fn decode_blocks_reads_row_major_rows_and_scales_to_the_page() {
        // Two anchors of seven values each, laid out anchor-major.
        let lb = Letterbox::fit(2048, 2048);
        let data: Vec<f32> = vec![
            // cx, cy, w, h, obj, eng, ja
            100.0, 200.0, 40.0, 60.0, 0.9, 0.1, 0.95, //
            500.0, 500.0, 10.0, 10.0, 0.2, 0.9, 0.9, // below the objectness floor
        ];
        let out = decode_blocks(&data, 2, 7, &lb);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, 1, "should pick the Japanese class");
        assert_eq!(out[0].0, [160, 340, 240, 460]);
    }

    #[test]
    fn decode_blocks_drops_a_confident_object_with_no_confident_class() {
        let lb = Letterbox::fit(1024, 1024);
        let data: Vec<f32> = vec![100.0, 100.0, 20.0, 20.0, 0.5, 0.3, 0.3];
        assert!(decode_blocks(&data, 1, 7, &lb).is_empty());
    }

    #[test]
    fn decode_blocks_refuses_a_malformed_tensor() {
        let lb = Letterbox::fit(1024, 1024);
        assert!(decode_blocks(&[1.0, 2.0], 100, 7, &lb).is_empty());
        assert!(decode_blocks(&[1.0; 700], 100, 3, &lb).is_empty());
    }

    #[test]
    fn page_mask_is_page_sized_and_carries_the_unpadded_region() {
        let lb = Letterbox::fit(512, 1024);
        let mut seg = vec![0f32; INPUT_SIZE * INPUT_SIZE];
        for y in 0..lb.inner_h {
            for x in 0..lb.inner_w {
                seg[y * INPUT_SIZE + x] = 1.0;
            }
        }
        let m = page_mask(&seg, &lb, 512, 1024).unwrap();
        assert_eq!((m.width(), m.height()), (512, 1024));
        assert_eq!(m.get_pixel(256, 512).0[0], 255);
    }

    #[test]
    fn page_mask_does_not_smear_the_padding_across_the_page() {
        // The mask must be cropped to the unpadded region *before* it is scaled up.
        let lb = Letterbox::fit(512, 1024);
        let seg = vec![1f32; INPUT_SIZE * INPUT_SIZE];
        let m = page_mask(&seg, &lb, 512, 1024).unwrap();
        assert_eq!(m.get_pixel(511, 1023).0[0], 255);
    }

    #[test]
    fn decode_lines_maps_a_quad_out_of_model_space() {
        let lb = Letterbox::fit(2048, 2048);
        let mut det = vec![0f32; 2 * INPUT_SIZE * INPUT_SIZE];
        for y in 100..300 {
            for x in 100..140 {
                det[y * INPUT_SIZE + x] = 0.95;
            }
        }
        let lines = decode_lines(&det, &lb);
        assert_eq!(lines.len(), 1);
        let xs: Vec<i32> = lines[0].iter().map(|p| p[0]).collect();
        // Model x 100..139 maps to page x 200..278 with 2x ratio, adjusted for unclip expansion.
        let (lo, hi) = (*xs.iter().min().unwrap(), *xs.iter().max().unwrap());
        assert!((150..200).contains(&lo), "left edge {lo}, quad {xs:?}");
        assert!((300..340).contains(&hi), "right edge {hi}, quad {xs:?}");
    }

    // ---- golden comparison against the Python sidecar ----

    /// One page of the fixture, as captured from the Python pipeline.
    ///
    /// `crop_count` and `jp` belong to the OCR slice and are ignored here.
    #[derive(serde::Deserialize)]
    struct GoldenBlock {
        #[serde(rename = "box")]
        bbox: [i32; 4],
        vertical: bool,
        font_size: f64,
        lines: Vec<Vec<[f64; 2]>>,
    }

    #[derive(serde::Deserialize)]
    struct GoldenPage {
        file: String,
        img_width: u32,
        img_height: u32,
        blocks: Vec<GoldenBlock>,
    }

    /// How closely a Rust block must match its Python counterpart.
    ///
    /// Strict on purpose. Both paths run the same weights through the same
    /// deterministic post-processing, so the only legitimate sources of drift
    /// are float rounding inside the ONNX runtime and the handful of places
    /// where OpenCV's own behaviour is implementation-defined. A block that is
    /// off by more than this is a porting bug, not noise.
    const MIN_IOU: f64 = 0.9;
    const FONT_SIZE_TOL: f64 = 2.0;

    fn iou(a: [i32; 4], b: [i32; 4]) -> f64 {
        let ix = (a[2].min(b[2]) - a[0].max(b[0])).max(0) as f64;
        let iy = (a[3].min(b[3]) - a[1].max(b[1])).max(0) as f64;
        let inter = ix * iy;
        let area = |r: [i32; 4]| ((r[2] - r[0]).max(0) as f64) * ((r[3] - r[1]).max(0) as f64);
        let union = area(a) + area(b) - inter;
        if union <= 0.0 { 0.0 } else { inter / union }
    }

    #[test]
    fn detect_matches_the_python_sidecar_on_the_golden_pages() {
        // Every other test here pins one stage against synthetic input. This is
        // the only one that checks the whole pipeline is the *same* pipeline, on
        // real scans, against what the Python sidecar actually produced.
        //
        // It skips rather than fails when its inputs are absent: the model is a
        // 90 MB download that is not in the repo, and the fixture references
        // pages under the developer's own Documents folder.
        let Some(home) = std::env::var_os("HOME") else {
            eprintln!("skipping golden test: HOME not set");
            return;
        };
        let model_path = std::path::PathBuf::from(home)
            .join(".mangatypesetter")
            .join("models")
            .join("comictextdetector.onnx");
        if !model_path.exists() {
            eprintln!("skipping golden test: model not found at {}", model_path.display());
            return;
        }
        let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata/analyze-golden/detector-golden.json");
        let Ok(json) = std::fs::read_to_string(&fixture_path) else {
            eprintln!("skipping golden test: fixture not found at {}", fixture_path.display());
            return;
        };
        let golden: Vec<GoldenPage> =
            serde_json::from_str(&json).expect("detector-golden.json is not the expected shape");
        for page in &golden {
            if !std::path::Path::new(&page.file).exists() {
                eprintln!("skipping golden test: fixture page not found at {}", page.file);
                return;
            }
        }

        let mut det = TextDetector::load(&model_path).expect("failed to load the detector");
        let mut failures: Vec<String> = Vec::new();

        for page in &golden {
            let name = std::path::Path::new(&page.file)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let img = image::open(&page.file).unwrap_or_else(|e| panic!("{}: {e}", page.file));
            let (w, h) = img.dimensions();
            assert_eq!(
                (w, h),
                (page.img_width, page.img_height),
                "{name}: page on disk is {w}x{h}, fixture recorded {}x{}",
                page.img_width,
                page.img_height
            );

            let (found, mask) = det.detect(&img, "ja").expect("detect failed");
            assert_eq!((mask.width(), mask.height()), (w, h), "{name}: mask is not page sized");

            if found.len() != page.blocks.len() {
                failures.push(format!(
                    "{name}: {} blocks, expected {}",
                    found.len(),
                    page.blocks.len()
                ));
            }

            // Greedy one-to-one by IoU, best available first. At a 0.9 floor two
            // Rust blocks cannot both match one golden block, so greedy loses
            // nothing an optimal assignment would find.
            let mut unmatched: Vec<usize> = (0..found.len()).collect();
            let mut ious: Vec<f64> = Vec::new();
            for g in &page.blocks {
                let best = unmatched
                    .iter()
                    .enumerate()
                    .map(|(i, &fi)| (i, iou(g.bbox, found[fi].xyxy)))
                    .max_by(|a, b| a.1.total_cmp(&b.1));
                let Some((slot, v)) = best else {
                    failures.push(format!("{name}: golden block {:?} has no candidate left", g.bbox));
                    continue;
                };
                let fi = unmatched[slot];
                let f = &found[fi];
                if v < MIN_IOU {
                    failures.push(format!(
                        "{name}: golden {:?} best-matches {:?} at IoU {v:.4}",
                        g.bbox, f.xyxy
                    ));
                }
                if f.vertical != g.vertical {
                    failures.push(format!(
                        "{name}: {:?} vertical={} expected {}",
                        f.xyxy, f.vertical, g.vertical
                    ));
                }
                if (f.font_size - g.font_size).abs() > FONT_SIZE_TOL {
                    failures.push(format!(
                        "{name}: {:?} font_size={} expected {}",
                        f.xyxy, f.font_size, g.font_size
                    ));
                }
                if f.lines.len() != g.lines.len() {
                    failures.push(format!(
                        "{name}: {:?} has {} lines, expected {}",
                        f.xyxy,
                        f.lines.len(),
                        g.lines.len()
                    ));
                }
                ious.push(v);
                unmatched.swap_remove(slot);
            }
            for &fi in &unmatched {
                failures.push(format!("{name}: extra Rust block {:?}", found[fi].xyxy));
            }

            // Printed rather than only asserted, so a `--nocapture` run shows how
            // much margin there is above the floor.
            let worst = ious.iter().copied().fold(f64::INFINITY, f64::min);
            eprintln!(
                "golden {name}: {} blocks (expected {}), worst IoU {worst:.4}",
                found.len(),
                page.blocks.len()
            );
        }

        assert!(failures.is_empty(), "golden mismatches:\n  {}", failures.join("\n  "));
    }
}
