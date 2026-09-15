//! PP-OCRv4 Korean mobile recognition model (`xberg-io/paddleocr-onnx-models`) in Rust.
//!
//! Convolutional text recognition network (SVTR / LCNet backbone + CTC head).
//! Faithful port of PaddleOCR image preprocessing (aspect-preserved resize to h=48, w capped at 320,
//! normalization `(x / 255.0 - 0.5) / 0.5`, zero padding on right) and greedy CTC decode
//! with repeat collapsing and blank token (index 0) suppression.

use std::path::Path;

use image::DynamicImage;
use ort::session::Session;
use ort::value::Tensor;

use super::cvops::resize_linear_u8;

/// Target recognition height for PP-OCRv4 rec models (48 pixels).
pub const REC_HEIGHT: usize = 48;
/// Maximum input width for single-crop recognition (320 pixels).
pub const MAX_REC_WIDTH: usize = 320;

// ---------------------------------------------------------------------------
// Preprocessing
// ---------------------------------------------------------------------------

/// Preprocesses a dynamic image crop for the PP-OCRv4 Korean recognition model.
///
/// Resizes height to 48 preserving aspect ratio, caps width to 320, normalizes
/// with `(x / 255.0 - 0.5) / 0.5`, and pads the right with 0.0 in NCHW planar format `[1, 3, 48, 320]`.
pub fn preprocess(img: &DynamicImage) -> Vec<f32> {
    let rgb = img.to_rgb8();
    let (sw, sh) = (rgb.width() as usize, rgb.height() as usize);
    if sw == 0 || sh == 0 {
        return vec![0.0f32; 3 * REC_HEIGHT * MAX_REC_WIDTH];
    }
    let ratio = sw as f64 / sh as f64;
    let resized_w = (REC_HEIGHT as f64 * ratio).ceil() as usize;
    let resized_w = resized_w.clamp(1, MAX_REC_WIDTH);

    let resized_rgb = resize_linear_u8(rgb.as_raw(), sw, sh, 3, resized_w, REC_HEIGHT);

    let mut out = vec![0.0f32; 3 * REC_HEIGHT * MAX_REC_WIDTH];
    for c in 0..3 {
        for y in 0..REC_HEIGHT {
            for x in 0..resized_w {
                // PaddleOCR rec models consume BGR (`DecodeImage: img_mode: BGR`).
                let val = resized_rgb[(y * resized_w + x) * 3 + (2 - c)];
                let norm = (val as f32 / 255.0 - 0.5) / 0.5;
                out[c * REC_HEIGHT * MAX_REC_WIDTH + y * MAX_REC_WIDTH + x] = norm;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// CTC Decode and Dictionary
// ---------------------------------------------------------------------------

/// Loads vocabulary tokens from dictionary string lines.
pub fn load_vocab_from_str(text: &str) -> Vec<String> {
    text.lines().map(|l| l.to_string()).collect()
}

/// Decodes CTC logits matrix `[seq_len, num_classes]` using greedy argmax.
///
/// Collapses consecutive duplicate tokens and drops index 0 (the CTC blank token).
/// Indices 1..=vocab.len() map to `vocab[index - 1]`.
pub fn ctc_greedy_decode(
    logits: &[f32],
    seq_len: usize,
    num_classes: usize,
    vocab: &[String],
) -> String {
    if seq_len == 0 || num_classes == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut prev_idx = 0usize;

    for t in 0..seq_len {
        let row = &logits[t * num_classes..(t + 1) * num_classes];
        let mut best_idx = 0usize;
        let mut best_val = row[0];
        for (idx, &val) in row.iter().enumerate().skip(1) {
            if val > best_val {
                best_val = val;
                best_idx = idx;
            }
        }

        if best_idx != 0 && best_idx != prev_idx {
            if let Some(token) = vocab.get(best_idx - 1) {
                out.push_str(token);
            }
        }
        prev_idx = best_idx;
    }

    out
}

// ---------------------------------------------------------------------------
// The Engine
// ---------------------------------------------------------------------------

/// Loaded PP-OCRv4 Korean recognition engine (model session + dictionary).
pub struct KoreanOcrEngine {
    session: Session,
    vocab: Vec<String>,
}

impl KoreanOcrEngine {
    /// Loads the recognition ONNX model and character dictionary file.
    pub fn load(model_path: &Path, dict_path: &Path) -> ort::Result<Self> {
        let (session, _) = super::accel::open(model_path, false)?;
        let dict_text = std::fs::read_to_string(dict_path)
            .map_err(|e| ort::Error::new(format!("{}: {e}", dict_path.display())))?;
        let vocab = load_vocab_from_str(&dict_text);
        Ok(KoreanOcrEngine { session, vocab })
    }

    /// Runs OCR on an image crop.
    pub fn ocr(&mut self, img: &DynamicImage) -> ort::Result<String> {
        let pixel_values = preprocess(img);
        let input = Tensor::from_array((
            [1usize, 3, REC_HEIGHT, MAX_REC_WIDTH],
            pixel_values,
        ))?;
        let outputs = self.session.run(ort::inputs![input])?;
        let (shape, logits) = outputs[0].try_extract_tensor::<f32>()?;
        let seq_len = shape[1] as usize;
        let num_classes = shape[2] as usize;
        Ok(ctc_greedy_decode(logits, seq_len, num_classes, &self.vocab))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    #[test]
    fn ctc_greedy_decode_collapses_repeats_and_drops_blanks() {
        // Vocab: 1="안", 2="녕", 3="하", 4="세", 5="요"
        let vocab = vec![
            "안".to_string(),
            "녕".to_string(),
            "하".to_string(),
            "세".to_string(),
            "요".to_string(),
        ];
        let num_classes = 6; // 0=blank, 1..5=tokens

        // Timestep tokens to simulate:
        // [1, 1, 0, 1, 2, 2, 0, 3, 4, 5, 5]
        // -> Expected decoded: "안" (collapsed 1,1), blank (0), "안" (1), "녕" (collapsed 2,2),
        //                      blank (0), "하" (3), "세" (4), "요" (collapsed 5,5)
        // -> Result: "안안녕하세요"
        let token_sequence = [1, 1, 0, 1, 2, 2, 0, 3, 4, 5, 5];
        let seq_len = token_sequence.len();
        let mut logits = vec![-10.0f32; seq_len * num_classes];
        for (t, &token) in token_sequence.iter().enumerate() {
            logits[t * num_classes + token] = 10.0;
        }

        let result = ctc_greedy_decode(&logits, seq_len, num_classes, &vocab);
        assert_eq!(result, "안안녕하세요");
    }

    #[test]
    fn ctc_greedy_decode_handles_empty_or_all_blank_logits() {
        let vocab = vec!["가".to_string(), "나".to_string()];
        let num_classes = 3;
        // All blanks (class 0 highest)
        let seq_len = 4;
        let mut logits = vec![-5.0f32; seq_len * num_classes];
        for t in 0..seq_len {
            logits[t * num_classes + 0] = 5.0;
        }
        assert_eq!(ctc_greedy_decode(&logits, seq_len, num_classes, &vocab), "");
        assert_eq!(ctc_greedy_decode(&[], 0, num_classes, &vocab), "");
    }

    #[test]
    fn charset_load_from_str_parses_tokens() {
        let sample_dict = "#\nᄀ\nᄁ\nᄂ\nᄃ\n \n";
        let vocab = load_vocab_from_str(sample_dict);
        assert_eq!(vocab, vec!["#", "ᄀ", "ᄁ", "ᄂ", "ᄃ", " "]);
        assert_eq!(vocab.len(), 6);
    }

    #[test]
    fn preprocess_produces_normalized_and_right_padded_tensor() {
        // Pure white 100x48 image
        let img_white = DynamicImage::ImageRgb8(RgbImage::from_pixel(100, 48, Rgb([255, 255, 255])));
        let tensor_white = preprocess(&img_white);
        assert_eq!(tensor_white.len(), 3 * REC_HEIGHT * MAX_REC_WIDTH);

        // First 100 columns in each channel should be normalized 1.0 ((255/255 - 0.5) / 0.5)
        for c in 0..3 {
            for y in 0..REC_HEIGHT {
                for x in 0..100 {
                    let v = tensor_white[c * REC_HEIGHT * MAX_REC_WIDTH + y * MAX_REC_WIDTH + x];
                    assert!((v - 1.0).abs() < 1e-5, "expected 1.0 at ({c},{y},{x}), got {v}");
                }
                // Remaining columns should be 0.0 (padding)
                for x in 100..MAX_REC_WIDTH {
                    let v = tensor_white[c * REC_HEIGHT * MAX_REC_WIDTH + y * MAX_REC_WIDTH + x];
                    assert_eq!(v, 0.0, "expected 0.0 pad at ({c},{y},{x}), got {v}");
                }
            }
        }

        // Pure black 50x48 image
        let img_black = DynamicImage::ImageRgb8(RgbImage::from_pixel(50, 48, Rgb([0, 0, 0])));
        let tensor_black = preprocess(&img_black);
        // First 50 columns in each channel should be normalized -1.0 ((0/255 - 0.5) / 0.5)
        for c in 0..3 {
            for y in 0..REC_HEIGHT {
                for x in 0..50 {
                    let v = tensor_black[c * REC_HEIGHT * MAX_REC_WIDTH + y * MAX_REC_WIDTH + x];
                    assert!((v + 1.0).abs() < 1e-5, "expected -1.0 at ({c},{y},{x}), got {v}");
                }
                for x in 50..MAX_REC_WIDTH {
                    let v = tensor_black[c * REC_HEIGHT * MAX_REC_WIDTH + y * MAX_REC_WIDTH + x];
                    assert_eq!(v, 0.0);
                }
            }
        }
    }
}
