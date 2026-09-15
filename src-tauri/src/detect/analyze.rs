//! Page analysis pipeline combining text detection, panel detection, OCR, and reading order sorting.
//!
//! Flattens OCR crops into a single pass, stitches text back to blocks, and sorts
//! into reading order (right-to-left for Japanese, left-to-right for Korean).

use image::{DynamicImage, GenericImageView};
use ort::session::Session;

use super::crops::{gather_crops, Raster};
use super::ocr::OcrEngine;
use super::ocr_ko::KoreanOcrEngine;
use super::panels;
use super::sorting::{
    assign_types, sort_bubbles_by_reading_order, Block, LineType, ReadingDirection,
};
use super::textblock::{round_half_even, split_by_regions};
use super::textdetector::TextDetector;

fn default_lang() -> String {
    "ja".to_string()
}

/// One text line of the response, numbered in reading order.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AnalyzeLine {
    /// 1-based position in reading order.
    pub n: usize,
    #[serde(rename = "type")]
    pub line_type: LineType,
    /// The page language ('ja' or 'ko').
    #[serde(default = "default_lang")]
    pub lang: String,
    /// The recognised Japanese/Korean text, or empty when OCR was off.
    pub jp: String,
    /// Always empty here. Translation is a separate step the app owns.
    pub en: String,
    #[serde(rename = "box")]
    pub r#box: [i32; 4],
    pub vertical: bool,
    pub font_size: f32,
}

/// Dispatcher for language-specific OCR engines (manga-ocr for Japanese, PP-OCRv4 for Korean).
pub enum AnyOcrEngine<'a> {
    Ja(&'a mut OcrEngine),
    Ko(&'a mut KoreanOcrEngine),
}

impl<'a> AnyOcrEngine<'a> {
    pub fn ocr(&mut self, img: &DynamicImage) -> ort::Result<String> {
        match self {
            AnyOcrEngine::Ja(engine) => engine.ocr(img),
            AnyOcrEngine::Ko(engine) => engine.ocr(img),
        }
    }
}

/// The `/analyze` response.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AnalyzeResponse {
    pub img_width: u32,
    pub img_height: u32,
    pub lines: Vec<AnalyzeLine>,
    pub panels: Vec<[i32; 4]>,
}

/// Decode an uploaded page, dropping any alpha channel to RGB.
pub fn decode_image(bytes: &[u8]) -> Result<DynamicImage, String> {
    image::load_from_memory(bytes).map_err(|e| format!("could not decode image: {e}"))
}

/// Frame panels and text regions for the page, or empty on failure (falling back to spatial sort).
fn detect_panels_and_regions(
    session: &mut Session,
    img: &DynamicImage,
) -> (Vec<[i32; 4]>, Vec<[i32; 4]>) {
    let round_box = |b: &super::geometry::BBox| {
        let r = |v: f32| round_half_even(v as f64) as i32;
        [r(b.x1), r(b.y1), r(b.x2), r(b.y2)]
    };
    match panels::detect_classes(session, img) {
        Ok(found) => {
            let mut panels = Vec::new();
            let mut text_regions = Vec::new();
            for b in &found {
                if b.class == panels::FRAME_CLASS {
                    panels.push(round_box(b));
                } else if b.class == panels::TEXT_CLASS {
                    text_regions.push(round_box(b));
                }
            }
            (panels, text_regions)
        }
        Err(e) => {
            log::warn!("panel detection failed, falling back to a spatial sort: {e}");
            (Vec::new(), Vec::new())
        }
    }
}

/// Detect, read, and order text and panels on one page.
pub fn analyze(
    img: &DynamicImage,
    detector: &mut TextDetector,
    panel_session: Option<&mut Session>,
    ocr: Option<&mut AnyOcrEngine<'_>>,
    lang: &str,
) -> Result<AnalyzeResponse, String> {
    let (im_w, im_h) = img.dimensions();

    let (panels, text_regions) = match panel_session {
        Some(s) => detect_panels_and_regions(s, img),
        None => (Vec::new(), Vec::new()),
    };

    let (blk_list, mask) = detector.detect(img, lang).map_err(|e| format!("detect failed: {e}"))?;
    let in_count = blk_list.len();
    let blk_list = split_by_regions(blk_list, &text_regions, im_w as i32, lang);
    if blk_list.len() != in_count {
        log::debug!(
            "split_by_regions: {} blocks in, {} blocks out",
            in_count,
            blk_list.len()
        );
    }

    let page = Raster::from_rgb(&img.to_rgb8());
    let mask_raster = Raster::from_gray(&mask);

    // Pass 1: gather all crops flat with per-block counts.
    let mut texts: Vec<String> = Vec::new();
    let mut counts: Vec<usize> = Vec::with_capacity(blk_list.len());
    if let Some(engine) = ocr {
        let lines_mode = std::env::var("MT_OCR_MODE")
            .map(|v| v.trim().eq_ignore_ascii_case("lines"))
            .unwrap_or(false);
        let mut queue: Vec<Raster> = Vec::new();
        for blk in &blk_list {
            let c = gather_crops(&page, &mask_raster, blk, lines_mode);
            counts.push(c.len());
            queue.extend(c);
        }
        // Pass 2: OCR each crop individually to match golden fixtures.
        for crop in &queue {
            match engine.ocr(&crop.as_python_saw_it()) {
                Ok(text) => texts.push(text),
                Err(e) => {
                    log::warn!("ocr failed for crop, degrading to empty text: {e}");
                    texts.push(String::new());
                }
            }
        }
    }

    // Pass 3: stitch recognized text back onto blocks.
    let mut blocks: Vec<Block> = Vec::with_capacity(blk_list.len());
    let mut cursor = 0usize;
    for (i, blk) in blk_list.iter().enumerate() {
        let jp = match counts.get(i) {
            Some(&count) => {
                let joined = texts[cursor..cursor + count].concat();
                cursor += count;
                joined
            }
            None => String::new(),
        };
        blocks.push(Block::new(blk.xyxy, blk.vertical, blk.font_size as f32, jp));
    }

    let lines = order_and_type(&blocks, &panels, lang);
    Ok(AnalyzeResponse { img_width: im_w, img_height: im_h, lines, panels })
}

/// Put detected blocks in reading order, label them, and number them.
pub fn order_and_type(blocks: &[Block], panels: &[[i32; 4]], lang: &str) -> Vec<AnalyzeLine> {
    // Empty panels fall back to page-wide spatial band sort.
    let panel_ref = if panels.is_empty() { None } else { Some(panels) };
    let direction = match lang {
        "ko" => ReadingDirection::Ltr,
        _ => ReadingDirection::Rtl,
    };
    let mut ordered = sort_bubbles_by_reading_order(blocks, direction, panel_ref);
    assign_types(&mut ordered);
    let lang_str = if lang == "ko" { "ko" } else { "ja" };
    ordered
        .into_iter()
        .enumerate()
        .map(|(i, b)| AnalyzeLine {
            n: i + 1,
            line_type: b.line_type,
            lang: lang_str.to_string(),
            jp: b.jp,
            en: String::new(),
            r#box: b.r#box,
            vertical: b.vertical,
            font_size: b.font_size,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The picker offers every one of these, and the webview draws them all, so
    // a format missing from the `image` crate's feature list fails only here -
    // at detection, after the chapter has imported and measured cleanly.
    #[test]
    fn decodes_every_format_the_picker_offers() {
        use image::{ImageFormat, RgbImage};
        use std::io::Cursor;
        let src = RgbImage::from_fn(16, 8, |x, y| image::Rgb([x as u8 * 16, y as u8 * 32, 128]));
        for fmt in [
            ImageFormat::Png,
            ImageFormat::Jpeg,
            ImageFormat::WebP,
            ImageFormat::Bmp,
            ImageFormat::Gif,
            ImageFormat::Tiff,
        ] {
            let mut bytes = Cursor::new(Vec::new());
            src.write_to(&mut bytes, fmt).unwrap_or_else(|e| panic!("encode {fmt:?}: {e}"));
            let img = decode_image(bytes.get_ref()).unwrap_or_else(|e| panic!("{fmt:?}: {e}"));
            assert_eq!(img.dimensions(), (16, 8), "{fmt:?}");
        }
    }

    #[test]
    fn a_response_serialises_to_the_shape_the_webview_expects() {
        let r = AnalyzeResponse {
            img_width: 1080,
            img_height: 1535,
            lines: vec![AnalyzeLine {
                n: 1,
                line_type: LineType::Sfx,
                lang: "ja".into(),
                jp: "ドン".into(),
                en: String::new(),
                r#box: [1, 2, 3, 4],
                vertical: true,
                font_size: 27.0,
            }],
            panels: vec![[0, 0, 100, 100]],
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["lines"][0]["type"], "sfx");
        assert_eq!(v["lines"][0]["lang"], "ja");
        assert_eq!(v["lines"][0]["box"], serde_json::json!([1, 2, 3, 4]));
        assert_eq!(v["lines"][0]["n"], 1);
        assert_eq!(v["lines"][0]["en"], "");
        assert_eq!(v["panels"][0], serde_json::json!([0, 0, 100, 100]));
        // Round-trips, which is what the e2e golden fixture relies on.
        let back: AnalyzeResponse = serde_json::from_value(v).unwrap();
        assert_eq!(back, r);

        // Deserializing without "lang" should default to "ja"
        let old_json = serde_json::json!({
            "img_width": 100,
            "img_height": 100,
            "lines": [{
                "n": 1,
                "type": "dialogue",
                "jp": "テスト",
                "en": "",
                "box": [0, 0, 10, 10],
                "vertical": false,
                "font_size": 12.0
            }],
            "panels": []
        });
        let old_parsed: AnalyzeResponse = serde_json::from_value(old_json).unwrap();
        assert_eq!(old_parsed.lines[0].lang, "ja");
    }

    #[test]
    fn korean_page_sets_lang_and_orders_ltr() {
        let blocks = vec![
            Block::new([500, 100, 600, 200], false, 20.0, "오른쪽".into()),
            Block::new([100, 100, 200, 200], false, 20.0, "왼쪽".into()),
        ];
        let lines = order_and_type(&blocks, &[], "ko");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].lang, "ko");
        assert_eq!(lines[1].lang, "ko");
        assert_eq!(lines[0].jp, "왼쪽");
        assert_eq!(lines[1].jp, "오른쪽");
        assert_eq!(lines[0].n, 1);
        assert_eq!(lines[1].n, 2);
    }

    #[test]
    fn decode_rejects_bytes_that_are_not_an_image() {
        assert!(decode_image(b"not a png").is_err());
    }

    // ---- golden comparison against the Python sidecar ----

    /// One page of `e2e-golden.json`, captured from the real Python
    /// `_analyze_image`.
    #[derive(serde::Deserialize)]
    struct GoldenPage {
        file: String,
        img_width: u32,
        img_height: u32,
        lines: Vec<AnalyzeLine>,
        panels: Vec<[i32; 4]>,
    }

    fn models_dir() -> Option<std::path::PathBuf> {
        let home = std::env::var_os("HOME")?;
        Some(std::path::PathBuf::from(home).join(".mangatypesetter").join("models"))
    }

    fn fixture_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/analyze-golden")
    }

    /// Runs the pipeline over fixture pages and asserts exact match with sidecar output.
    fn run_e2e_golden(pages: &[usize]) -> Option<usize> {
        let Some(models) = models_dir() else {
            eprintln!("skipping e2e golden: HOME not set");
            return None;
        };
        for f in [
            models.join("comictextdetector.onnx"),
            models.join("manga109_yolo_l_yv11.onnx"),
            models.join("manga-ocr").join("encoder_model.onnx"),
        ] {
            if !f.exists() {
                eprintln!("skipping e2e golden: model not found at {}", f.display());
                return None;
            }
        }
        let Ok(json) = std::fs::read_to_string(fixture_dir().join("e2e-golden.json")) else {
            eprintln!("skipping e2e golden: fixture not found");
            return None;
        };
        let golden: Vec<GoldenPage> =
            serde_json::from_str(&json).expect("e2e-golden.json is not the expected shape");
        for i in pages {
            let Some(p) = golden.get(*i) else { continue };
            if !std::path::Path::new(&p.file).exists() {
                eprintln!("skipping e2e golden: page not found at {}", p.file);
                return None;
            }
        }

        let mut detector = TextDetector::load(&models.join("comictextdetector.onnx"))
            .expect("failed to load the text detector");
        let mut panel_session = panels::load_session(&models.join("manga109_yolo_l_yv11.onnx"))
            .expect("failed to load the panel model");
        let mut engine =
            OcrEngine::load(&models.join("manga-ocr")).expect("failed to load the OCR models");
        let mut any_ocr = AnyOcrEngine::Ja(&mut engine);

        let mut failures: Vec<String> = Vec::new();
        let mut compared = 0usize;
        for &i in pages {
            let Some(page) = golden.get(i) else { continue };
            let name = std::path::Path::new(&page.file)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let started = std::time::Instant::now();
            let bytes = std::fs::read(&page.file).expect("read page");
            let img = decode_image(&bytes).expect("decode page");
            let got = analyze(&img, &mut detector, Some(&mut panel_session), Some(&mut any_ocr), "ja")
                .expect("analyze failed");
            compared += 1;

            let mut say = |m: String| failures.push(format!("{name}: {m}"));
            if (got.img_width, got.img_height) != (page.img_width, page.img_height) {
                say(format!(
                    "page is {}x{}, fixture recorded {}x{}",
                    got.img_width, got.img_height, page.img_width, page.img_height
                ));
            }
            // Assert exact panel match with golden fixture.
            if got.panels != page.panels {
                say(format!("panels {:?}, expected {:?}", got.panels, page.panels));
            }

            // Verify line content and reading order separately for clearer failure reporting.
            if got.lines.len() != page.lines.len() {
                say(format!("{} lines, expected {}", got.lines.len(), page.lines.len()));
            }
            for e in &page.lines {
                let Some(g) = got.lines.iter().find(|g| g.r#box == e.r#box) else {
                    say(format!("no line at {:?} (fixture line {})", e.r#box, e.n));
                    continue;
                };
                if g.vertical != e.vertical {
                    say(format!("line at {:?}: vertical {}, expected {}", e.r#box, g.vertical, e.vertical));
                }
                if g.line_type != e.line_type {
                    say(format!("line at {:?}: type {:?}, expected {:?}", e.r#box, g.line_type, e.line_type));
                }
                // Compare font size at f32 print precision.
                if (g.font_size - e.font_size).abs() > 1e-4 {
                    say(format!(
                        "line at {:?}: font_size {}, expected {}",
                        e.r#box, g.font_size, e.font_size
                    ));
                }
                if g.jp != e.jp {
                    say(format!("line at {:?}\n    python: {}\n    rust:   {}", e.r#box, e.jp, g.jp));
                }
            }

            for (g, e) in got.lines.iter().zip(page.lines.iter()) {
                if g.n != e.n || g.r#box != e.r#box {
                    say(format!(
                        "reading order: line {} is the block at {:?}, expected the one at {:?}",
                        e.n, g.r#box, e.r#box
                    ));
                }
            }

            eprintln!(
                "e2e golden {name}: {} lines, {} panels, {:.1}s",
                got.lines.len(),
                got.panels.len(),
                started.elapsed().as_secs_f64()
            );
        }

        assert!(failures.is_empty(), "e2e mismatches:\n  {}", failures.join("\n  "));
        Some(compared)
    }

    #[test]
    fn analyze_matches_the_python_sidecar_on_every_golden_page() {
        // Runs all fixture pages (takes ~30s in debug build).
        run_e2e_golden(&[0, 1, 2]);
    }
}
