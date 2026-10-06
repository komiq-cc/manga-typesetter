//! Headless Detect: the app's panel detection, text detection and Japanese OCR
//! on page images, for scripts (the Comic-translate pipeline uses it to detect a
//! chapter without opening the app). Same models and code path as `detect_analyze`.
//!
//! cargo run --release --example detect_pages -- page1.png page2.png
//!
//! Prints one JSON object per page, one per line:
//! {"file": "...", "result": <detect_analyze response>} or {"file": "...", "error": "..."}.

use app_lib::detect::analyze::{analyze, decode_image};
use app_lib::detect::ocr::{OcrEngine, TextRecognizer};
use app_lib::detect::panels;
use app_lib::detect::sorting::ReadingDirection;
use app_lib::detect::textdetector::TextDetector;
use std::path::PathBuf;

fn die(msg: String) -> ! {
    eprintln!("detect_pages: {msg}");
    std::process::exit(1);
}

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        die("usage: detect_pages <page image>...".to_string());
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| die("HOME is not set".to_string()));
    let models = PathBuf::from(home).join(".mangatypesetter/models");

    let mut detector = TextDetector::load(&models.join("comictextdetector.onnx"))
        .unwrap_or_else(|e| die(format!("failed to load the text detector: {e}")));
    // Like the app: without the panel model, reading order degrades instead of failing.
    let mut panel_session = panels::load_session(&models.join("manga109_yolo_l_yv11.onnx"))
        .map_err(|e| eprintln!("detect_pages: panel model unavailable, reading order degrades: {e}"))
        .ok();
    let mut ocr = OcrEngine::load(&models.join("manga-ocr"))
        .unwrap_or_else(|e| die(format!("failed to load the Japanese OCR models: {e}")));

    for file in files {
        let result = std::fs::read(&file)
            .map_err(|e| e.to_string())
            .and_then(|bytes| decode_image(&bytes))
            .and_then(|img| {
                analyze(
                    &img,
                    &mut detector,
                    panel_session.as_mut(),
                    Some(&mut ocr as &mut dyn TextRecognizer),
                    ReadingDirection::Rtl,
                    "ja",
                )
            });
        let line = match result {
            Ok(r) => serde_json::json!({ "file": file, "result": r }),
            Err(e) => serde_json::json!({ "file": file, "error": e }),
        };
        println!("{line}");
    }
}
