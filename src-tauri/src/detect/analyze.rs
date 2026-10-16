//! Page analysis pipeline combining text detection, panel detection, OCR, and reading order sorting.
//!
//! Flattens OCR crops into a single pass, stitches text back to blocks, and sorts in project reading order.

use image::{DynamicImage, GenericImageView};
use ort::session::Session;

use super::crops::{gather_crops, Raster};
use super::ocr::{OcrReading, TextRecognizer};
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
    /// The page's source language; older saved results default to Japanese.
    #[serde(default = "default_lang")]
    pub lang: String,
    /// The recognised source text, or empty when OCR was off. `jp` is retained
    /// as the on-disk/wire key for compatibility with existing chapters.
    pub jp: String,
    /// Always empty here. Translation is a separate step the app owns.
    pub en: String,
    #[serde(rename = "box")]
    pub r#box: [i32; 4],
    pub vertical: bool,
    pub font_size: f32,
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

/// Reject artwork reads using Komatose's CJK/Hangul and Latin SFX thresholds
/// (`isMeaningfulSource` in its `src/lib/server/ocr.ts`), plus one rule of
/// ours: a bubble that holds only an ellipsis or marks ("……", "！？") is real
/// dialogue in manga, and its line has to survive even though it holds no
/// letter of any script.
fn is_meaningful_source(text: &str, score: f32) -> bool {
    let text = text.trim();
    if text.is_empty() {
        return false;
    }
    if text.chars().any(|c| matches!(c,
        '\u{1100}'..='\u{11ff}' | '\u{3040}'..='\u{30ff}' | '\u{3130}'..='\u{318f}'
        | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{ac00}'..='\u{d7af}'
        | '\u{f900}'..='\u{faff}' | '\u{ff66}'..='\u{ff9f}'
    )) {
        return text.chars().count() > 1 || score >= 0.5;
    }
    if text.chars().filter(|c| !c.is_whitespace()).all(|c| {
        matches!(c, '…' | '‥' | '・' | '.' | '。' | '！' | '!' | '？' | '?' | '〜' | '～')
    }) {
        // A lone dot is what plain art reads as most often; two marks or more,
        // or one confident one, is a bubble.
        return text.chars().filter(|c| !c.is_whitespace()).count() > 1 || score >= 0.5;
    }
    if text.contains(['\\', '$']) {
        return false;
    }
    let compact = text.chars().filter(|c| !c.is_whitespace()).count();
    let letters = text.chars().filter(|c| c.is_ascii_alphabetic()).count();
    letters >= 3 && letters as f32 / compact as f32 >= 0.7 && score >= 0.55
}

/// Join a block's crops, filtering only when every crop was successfully read.
fn stitch_readings(readings: &[Option<OcrReading>]) -> Option<String> {
    let mut text = String::new();
    let mut score = 1.0f32;
    let mut complete = !readings.is_empty();
    for reading in readings {
        match reading {
            Some(reading) => {
                text.push_str(&reading.text);
                // A confident crop must not hide a weak crop in the same block.
                score = score.min(reading.confidence);
            }
            None => complete = false,
        }
    }
    if complete && !is_meaningful_source(&text, score) {
        None
    } else {
        Some(text)
    }
}

/// Detect, read, and order text and panels on one page.
pub fn analyze(
    img: &DynamicImage,
    detector: &mut TextDetector,
    panel_session: Option<&mut Session>,
    ocr: Option<&mut dyn TextRecognizer>,
    direction: ReadingDirection,
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
    let mut readings: Vec<Option<OcrReading>> = Vec::new();
    let mut counts: Vec<usize> = Vec::with_capacity(blk_list.len());
    if let Some(engine) = ocr {
        let lines_mode = engine.prefers_line_crops()
            || std::env::var("MT_OCR_MODE")
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
            match engine.ocr_with_confidence(&crop.as_python_saw_it()) {
                Ok(reading) => readings.push(Some(reading)),
                Err(e) => {
                    log::warn!("ocr failed for crop, degrading to empty text: {e}");
                    readings.push(None);
                }
            }
        }
    }

    // Pass 3: stitch recognized text back onto blocks and drop junk reads.
    let mut blocks: Vec<Block> = Vec::with_capacity(blk_list.len());
    let mut cursor = 0usize;
    for (i, blk) in blk_list.iter().enumerate() {
        let crops = match counts.get(i) {
            Some(&count) => {
                let crops = &readings[cursor..cursor + count];
                cursor += count;
                crops
            }
            None => &[][..],
        };
        let Some(jp) = stitch_readings(crops) else { continue };
        blocks.push(Block::new(blk.xyxy, blk.vertical, blk.font_size as f32, jp));
    }

    let lines = order_and_type(&blocks, &panels, direction, lang);
    Ok(AnalyzeResponse { img_width: im_w, img_height: im_h, lines, panels })
}

/// Put detected blocks in reading order, label them, and number them.
pub fn order_and_type(
    blocks: &[Block],
    panels: &[[i32; 4]],
    direction: ReadingDirection,
    lang: &str,
) -> Vec<AnalyzeLine> {
    // Empty panels fall back to page-wide spatial band sort.
    let panel_ref = if panels.is_empty() { None } else { Some(panels) };
    let mut ordered = sort_bubbles_by_reading_order(blocks, direction, panel_ref);
    assign_types(&mut ordered);
    ordered
        .into_iter()
        .enumerate()
        .map(|(i, b)| AnalyzeLine {
            n: i + 1,
            line_type: b.line_type,
            lang: lang.to_string(),
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
    use crate::detect::ocr::OcrEngine;

    #[test]
    fn meaningful_source_keeps_script_and_confident_latin_sfx() {
        for (text, score, meaningful) in [
            ("こんにちは", 0.0, true),
            ("你好", 0.0, true),
            ("한글", 0.0, true),
            (" あ ", 0.49, false),
            ("あ", 0.5, true),
            ("한", 0.49, false),
            ("한", 0.5, true),
            ("\\frac", 0.9, false),
            ("$BAM$", 0.9, false),
            ("BAM", 0.9, true),
            ("BAM", 0.3, false),
            ("BAM", 0.55, true),
            ("B A\tM!", 0.9, true),
            ("BAM!!", 0.9, false),
            ("1.", 0.9, false),
            ("……", 0.2, true),
            ("！？", 0.3, true),
            ("…", 0.9, true),
            (".", 0.3, false),
            ("㐀", 0.9, true),
            ("ｱｲ", 0.2, true),
            ("", 0.9, false),
            (" \n\t", 0.9, false),
        ] {
            assert_eq!(is_meaningful_source(text, score), meaningful, "{text:?} at {score}");
        }
    }

    fn reading(text: &str, confidence: f32) -> Option<OcrReading> {
        Some(OcrReading { text: text.into(), confidence })
    }

    #[test]
    fn stitching_filters_only_complete_reads_using_the_weakest_crop() {
        // No OCR or no crops, and failed crops, keep today's empty-text fallback.
        assert_eq!(stitch_readings(&[]), Some(String::new()));
        assert_eq!(stitch_readings(&[None]), Some(String::new()));
        assert_eq!(stitch_readings(&[reading("1.", 0.9), None]), Some("1.".into()));
        assert_eq!(stitch_readings(&[None, reading("BAM", 0.3)]), Some("BAM".into()));
        assert_eq!(stitch_readings(&[reading("", 0.9)]), None);
        assert_eq!(stitch_readings(&[reading("BA", 0.9), reading("M", 0.3)]), None);
        assert_eq!(
            stitch_readings(&[reading("BA", 0.9), reading("M", 0.8)]),
            Some("BAM".into())
        );
    }

    #[test]
    fn junk_is_removed_before_reading_order_and_contiguous_numbering() {
        let crops = [
            vec![reading("BOOM", 0.9)],
            vec![reading("1.", 0.9)],
            vec![reading("BAM", 0.9)],
        ];
        let blocks: Vec<Block> = crops.iter().enumerate().filter_map(|(i, readings)| {
            let text = stitch_readings(readings)?;
            let x = (2 - i as i32) * 100;
            Some(Block::new([x, 0, x + 50, 50], false, 20.0, text))
        }).collect();
        let lines = order_and_type(&blocks, &[], ReadingDirection::Ltr, "en");
        assert_eq!(lines.iter().map(|line| (line.n, line.jp.as_str())).collect::<Vec<_>>(),
            [(1, "BAM"), (2, "BOOM")]);
    }

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

        let mut old = serde_json::to_value(&r).unwrap();
        old["lines"][0].as_object_mut().unwrap().remove("lang");
        let parsed: AnalyzeResponse = serde_json::from_value(old).unwrap();
        assert_eq!(parsed.lines[0].lang, "ja");
    }

    #[test]
    fn korean_lines_keep_language_and_left_to_right_order() {
        let blocks = vec![
            Block::new([500, 100, 600, 200], false, 20.0, "오른쪽".into()),
            Block::new([100, 100, 200, 200], false, 20.0, "왼쪽".into()),
        ];
        let lines = order_and_type(&blocks, &[], ReadingDirection::Ltr, "ko");
        assert_eq!(lines.iter().map(|line| line.jp.as_str()).collect::<Vec<_>>(), ["왼쪽", "오른쪽"]);
        assert!(lines.iter().all(|line| line.lang == "ko"));
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
            let got = analyze(
                &img,
                &mut detector,
                Some(&mut panel_session),
                Some(&mut engine),
                ReadingDirection::Rtl,
                "ja",
            )
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
