//! PaddleOCR PP-OCRv4/v5/v6 recognition in ONNX Runtime.
//!
//! The downloaded RapidOCR conversions carry their character dictionary in
//! ONNX metadata. Keeping the dictionary with the graph prevents a model update
//! from silently decoding logits with a mismatched alphabet.

use std::path::Path;

use image::DynamicImage;
use ort::session::Session;
use ort::value::Tensor;

use super::cvops::resize_linear_u8;
use super::ocr::TextRecognizer;

const INPUT_HEIGHT: usize = 48;
const MIN_INPUT_WIDTH: usize = 320;
const BLANK_TOKEN: usize = 0;

/// A PP-OCR CTC recognizer whose alphabet travels in the ONNX metadata.
pub struct PaddleOcrEngine {
    session: Session,
    characters: Vec<String>,
}

impl PaddleOcrEngine {
    pub fn load(path: &Path) -> ort::Result<Self> {
        // Width follows the crop's aspect ratio, so only providers that accept
        // changing input shapes without recompiling are eligible.
        let (session, _) = super::accel::open(path, true)?;
        let raw = {
            let metadata = session.metadata()?;
            metadata.custom("character").ok_or_else(|| {
                ort::Error::new(format!(
                    "{} has no embedded OCR character dictionary",
                    path.display()
                ))
            })?
        };
        let characters = raw
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        if characters.is_empty() {
            return Err(ort::Error::new(format!(
                "{} has an empty OCR character dictionary",
                path.display()
            )));
        }
        Ok(Self {
            session,
            characters,
        })
    }

    fn preprocess(img: &DynamicImage) -> ort::Result<(usize, Vec<f32>)> {
        let rgb = img.to_rgb8();
        let (w, h) = (rgb.width() as usize, rgb.height() as usize);
        if w == 0 || h == 0 {
            return Err(ort::Error::new("cannot OCR an empty image"));
        }

        let resized_width = ((INPUT_HEIGHT as f64 * w as f64 / h as f64).ceil() as usize).max(1);
        let input_width = resized_width.max(MIN_INPUT_WIDTH);
        let resized = resize_linear_u8(rgb.as_raw(), w, h, 3, resized_width, INPUT_HEIGHT);

        // PaddleOCR: HWC uint8 -> CHW float, x / 255, then (x - .5) / .5.
        // The right-hand padding is zero in normalized space, matching its
        // reference implementation.
        let plane = INPUT_HEIGHT * input_width;
        let mut out = vec![0f32; 3 * plane];
        for y in 0..INPUT_HEIGHT {
            for x in 0..resized_width {
                let offset = (y * resized_width + x) * 3;
                for c in 0..3 {
                    out[c * plane + y * input_width + x] = resized[offset + c] as f32 / 127.5 - 1.0;
                }
            }
        }
        Ok((input_width, out))
    }

    fn decode_ctc(characters: &[String], shape: &[i64], logits: &[f32]) -> ort::Result<String> {
        if shape.len() != 3 || shape[0] != 1 {
            return Err(ort::Error::new(format!(
                "unexpected PaddleOCR output shape {shape:?}"
            )));
        }
        let steps = shape[1] as usize;
        let classes = shape[2] as usize;
        let expected = characters.len() + 2; // blank + dictionary + space
        if classes != expected || logits.len() != steps * classes {
            return Err(ort::Error::new(format!(
                "OCR output has {classes} classes; embedded dictionary requires {expected}"
            )));
        }

        let mut text = String::new();
        let mut previous = usize::MAX;
        for row in logits.chunks_exact(classes).take(steps) {
            let token = row
                .iter()
                .enumerate()
                // NumPy argmax keeps the first class on an exact tie.
                .max_by(|a, b| a.1.total_cmp(b.1).then_with(|| b.0.cmp(&a.0)))
                .map(|(i, _)| i)
                .unwrap_or(BLANK_TOKEN);
            if token != previous && token != BLANK_TOKEN {
                if token == characters.len() + 1 {
                    text.push(' ');
                } else if let Some(character) = characters.get(token - 1) {
                    text.push_str(character);
                }
            }
            previous = token;
        }
        Ok(text)
    }
}

impl TextRecognizer for PaddleOcrEngine {
    fn ocr(&mut self, img: &DynamicImage) -> ort::Result<String> {
        let (width, pixels) = Self::preprocess(img)?;
        let input = Tensor::from_array(([1usize, 3, INPUT_HEIGHT, width], pixels))?;
        let characters = &self.characters;
        // RapidOCR exports use different graph tensor names across releases;
        // each recognition graph has exactly one input and one output, so bind
        // them positionally instead of baking one version's names into the app.
        let outputs = self.session.run(ort::inputs![input])?;
        let (shape, logits) = outputs[0].try_extract_tensor::<f32>()?;
        Self::decode_ctc(characters, shape, logits)
    }

    fn prefers_line_crops(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preprocess_preserves_aspect_ratio_and_pads_to_the_minimum_width() {
        let img = DynamicImage::new_rgb8(96, 48);
        let (width, pixels) = PaddleOcrEngine::preprocess(&img).unwrap();
        assert_eq!(width, 320);
        assert_eq!(pixels.len(), 3 * 48 * 320);
    }

    #[test]
    fn ctc_collapse_removes_blanks_and_adjacent_duplicates() {
        // Dictionary a,b; model classes are blank,a,b,space.
        let characters = vec!["a".into(), "b".into()];
        let logits_for = |tokens: &[usize]| {
            let mut out = vec![-10.0f32; tokens.len() * 4];
            for (step, token) in tokens.iter().enumerate() {
                out[step * 4 + token] = 10.0;
            }
            out
        };
        let tokens = [0, 1, 1, 0, 1, 2, 2, 3];
        let logits = logits_for(&tokens);
        assert_eq!(
            PaddleOcrEngine::decode_ctc(&characters, &[1, tokens.len() as i64, 4], &logits)
                .unwrap(),
            "aab "
        );
    }

    #[test]
    fn downloaded_language_models_load_and_run_when_supplied() {
        let Ok(dir) = std::env::var("MT_TEST_PADDLE_OCR_MODELS") else {
            eprintln!("skipping PaddleOCR model test: MT_TEST_PADDLE_OCR_MODELS is not set");
            return;
        };
        let image = DynamicImage::new_rgb8(320, 48);
        let mut tested = 0;
        for name in [
            "ch_PP-OCRv5_rec_mobile.onnx",
            "ch_PP-OCRv5_rec_server.onnx",
            "korean_PP-OCRv4_rec_mobile.onnx",
            "korean_PP-OCRv5_rec_mobile.onnx",
            "PP-OCRv6_rec_small.onnx",
            "PP-OCRv6_rec_medium.onnx",
        ] {
            let path = Path::new(&dir).join(name);
            if !path.is_file() {
                continue;
            }
            tested += 1;
            let mut engine = PaddleOcrEngine::load(&path)
                .unwrap_or_else(|e| panic!("{} did not load: {e}", path.display()));
            engine
                .ocr(&image)
                .unwrap_or_else(|e| panic!("{} did not run: {e}", path.display()));
        }
        assert!(tested > 0, "no supplied PaddleOCR models were found in {dir}");
    }
}
