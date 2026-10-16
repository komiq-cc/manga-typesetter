//! manga-ocr (`kha-white/manga-ocr-base`) in Rust.
//!
//! VisionEncoderDecoder: ViT-base encoder over 224x224 crop + 2-layer BERT decoder.
//! Faithful port of PIL preprocessing, HuggingFace beam search, and jaconv post-processing.

use std::path::Path;

use image::DynamicImage;
use ort::session::Session;
use ort::value::Tensor;

/// Recognised crop text and its probability in the range 0..=1.
pub struct OcrReading {
    pub text: String,
    pub confidence: f32,
}

/// Common interface for the Japanese manga-ocr and language-specific PaddleOCR
/// recognizers used by the page analysis pipeline.
pub trait TextRecognizer {
    fn ocr_with_confidence(&mut self, img: &DynamicImage) -> ort::Result<OcrReading>;

    fn ocr(&mut self, img: &DynamicImage) -> ort::Result<String> {
        self.ocr_with_confidence(img).map(|reading| reading.text)
    }

    /// Paddle recognition graphs are trained on a single text line. Manga OCR
    /// is instead a manga-crop recognizer and performs better on whole blocks.
    fn prefers_line_crops(&self) -> bool {
        false
    }
}

/// Square input size for the ViT encoder (224x224).
pub const INPUT_SIZE: usize = 224;

/// Special token ids: `[PAD]=0 [UNK]=1 [CLS]=2 [SEP]=3 [MASK]=4`.
const CLS_TOKEN: i64 = 2;
const EOS_TOKEN: i64 = 3;
/// Special tokens 0..=4 are dropped by tokenizer decode with `skip_special_tokens=true`.
const FIRST_ORDINARY_TOKEN: i64 = 5;

/// Generation configuration parameters matching `generation_config.json`.
const NUM_BEAMS: usize = 4;
const MAX_LENGTH: usize = 300;
const LENGTH_PENALTY: f64 = 2.0;
const NO_REPEAT_NGRAM_SIZE: usize = 3;

// ---------------------------------------------------------------------------
// Preprocessing
// ---------------------------------------------------------------------------

/// ITU-R 601-2 fixed-point luma calculation matching Pillow's `convert("L")`.
pub fn pil_luma(r: u8, g: u8, b: u8) -> u8 {
    ((r as u32 * 19595 + g as u32 * 38470 + b as u32 * 7471 + 0x8000) >> 16) as u8
}

/// Pillow fixed-point precision for 8-bit resampling (22-bit).
const PRECISION_BITS: i32 = 32 - 8 - 2;

/// Shifts fixed-point value down and clamps to [0, 255].
fn clip8(v: i32) -> u8 {
    (v >> PRECISION_BITS).clamp(0, 255) as u8
}

/// Filter taps for one resampling axis in Pillow's layout.
struct Coeffs {
    ksize: usize,
    bounds: Vec<(usize, usize)>,
    kk: Vec<i32>,
}

/// Computes bilinear filter coefficients with filter widening for downscaling matching Pillow.
fn precompute_coeffs(in_size: usize, out_size: usize) -> Coeffs {
    let scale = in_size as f64 / out_size as f64;
    let filterscale = if scale < 1.0 { 1.0 } else { scale };
    let support = 1.0 * filterscale; // bilinear_filter's support is 1.0
    let ksize = (support.ceil() as usize) * 2 + 1;

    let mut bounds = Vec::with_capacity(out_size);
    let mut kk = vec![0i32; out_size * ksize];
    let mut k = vec![0f64; ksize];

    for xx in 0..out_size {
        let center = (xx as f64 + 0.5) * scale;
        let ss = 1.0 / filterscale;

        let xmin = ((center - support + 0.5).max(0.0)) as usize;
        let xmax = {
            let raw = (center + support + 0.5) as usize;
            raw.min(in_size) - xmin
        };

        let mut ww = 0f64;
        for (x, slot) in k.iter_mut().enumerate().take(xmax) {
            let t = ((x + xmin) as f64 - center + 0.5) * ss;
            let w = if t.abs() < 1.0 { 1.0 - t.abs() } else { 0.0 };
            *slot = w;
            ww += w;
        }
        if ww != 0.0 {
            for slot in k.iter_mut().take(xmax) {
                *slot /= ww;
            }
        }
        for slot in k.iter_mut().skip(xmax) {
            *slot = 0.0;
        }

        for x in 0..ksize {
            let scaled = k[x] * (1i64 << PRECISION_BITS) as f64;
            kk[xx * ksize + x] = if scaled < 0.0 { (scaled - 0.5) as i32 } else { (scaled + 0.5) as i32 };
        }
        bounds.push((xmin, xmax));
    }

    Coeffs { ksize, bounds, kk }
}

/// Two-pass 8-bit bilinear resize matching `PIL.Image.resize(..., resample=BILINEAR)`.
pub fn pil_bilinear_resize(src: &[u8], w: usize, h: usize, ow: usize, oh: usize) -> Vec<u8> {
    let horiz = precompute_coeffs(w, ow);
    let vert = precompute_coeffs(h, oh);

    // Horizontal: w x h -> ow x h.
    let mut tmp = vec![0u8; ow * h];
    for y in 0..h {
        for xx in 0..ow {
            let (xmin, xmax) = horiz.bounds[xx];
            let k = &horiz.kk[xx * horiz.ksize..];
            let mut ss = 1i32 << (PRECISION_BITS - 1);
            for x in 0..xmax {
                ss += src[y * w + xmin + x] as i32 * k[x];
            }
            tmp[y * ow + xx] = clip8(ss);
        }
    }

    // Vertical: ow x h -> ow x oh.
    let mut out = vec![0u8; ow * oh];
    for yy in 0..oh {
        let (ymin, ymax) = vert.bounds[yy];
        let k = &vert.kk[yy * vert.ksize..];
        for xx in 0..ow {
            let mut ss = 1i32 << (PRECISION_BITS - 1);
            for y in 0..ymax {
                ss += tmp[(ymin + y) * ow + xx] as i32 * k[y];
            }
            out[yy * ow + xx] = clip8(ss);
        }
    }

    out
}

/// Converts crop to normalized ViT `pixel_values` tensor `[1, 3, 224, 224]`.
pub fn preprocess(img: &DynamicImage) -> Vec<f32> {
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let mut plane = vec![0u8; w * h];
    for (i, px) in rgb.pixels().enumerate() {
        plane[i] = pil_luma(px.0[0], px.0[1], px.0[2]);
    }

    let small = pil_bilinear_resize(&plane, w, h, INPUT_SIZE, INPUT_SIZE);

    let n = INPUT_SIZE * INPUT_SIZE;
    let mut out = vec![0f32; 3 * n];
    for i in 0..n {
        // Rescale by 1/255, then standardize: (x - 0.5) / 0.5.
        let v = (small[i] as f32 / 255.0 - 0.5) / 0.5;
        out[i] = v;
        out[n + i] = v;
        out[2 * n + i] = v;
    }
    out
}

// ---------------------------------------------------------------------------
// Detokenising and post-processing
// ---------------------------------------------------------------------------

/// Half-width katakana with dakuten replacement pairs matching `jaconv`.
const DAKUTEN_PAIRS: &[(&str, &str)] = &[
    ("ｶﾞ", "ガ"), ("ｷﾞ", "ギ"), ("ｸﾞ", "グ"), ("ｹﾞ", "ゲ"),
    ("ｺﾞ", "ゴ"), ("ｻﾞ", "ザ"), ("ｼﾞ", "ジ"), ("ｽﾞ", "ズ"),
    ("ｾﾞ", "ゼ"), ("ｿﾞ", "ゾ"), ("ﾀﾞ", "ダ"), ("ﾁﾞ", "ヂ"),
    ("ﾂﾞ", "ヅ"), ("ﾃﾞ", "デ"), ("ﾄﾞ", "ド"), ("ﾊﾞ", "バ"),
    ("ﾋﾞ", "ビ"), ("ﾌﾞ", "ブ"), ("ﾍﾞ", "ベ"), ("ﾎﾞ", "ボ"),
    ("ﾊﾟ", "パ"), ("ﾋﾟ", "ピ"), ("ﾌﾟ", "プ"), ("ﾍﾟ", "ペ"),
    ("ﾎﾟ", "ポ"), ("ｳﾞ", "ヴ"),
];

/// Half-width to full-width kana mapping pairs matching `jaconv.HALF_KANA_SEION`.
const HALF_TO_FULL_KANA: &[(char, char)] = &[
    ('\u{FF67}', '\u{30A1}'), ('\u{FF71}', '\u{30A2}'), ('\u{FF68}', '\u{30A3}'),
    ('\u{FF72}', '\u{30A4}'), ('\u{FF69}', '\u{30A5}'), ('\u{FF73}', '\u{30A6}'),
    ('\u{FF6A}', '\u{30A7}'), ('\u{FF74}', '\u{30A8}'), ('\u{FF6B}', '\u{30A9}'),
    ('\u{FF75}', '\u{30AA}'), ('\u{FF76}', '\u{30AB}'), ('\u{FF77}', '\u{30AD}'),
    ('\u{FF78}', '\u{30AF}'), ('\u{FF79}', '\u{30B1}'), ('\u{FF7A}', '\u{30B3}'),
    ('\u{FF7B}', '\u{30B5}'), ('\u{FF7C}', '\u{30B7}'), ('\u{FF7D}', '\u{30B9}'),
    ('\u{FF7E}', '\u{30BB}'), ('\u{FF7F}', '\u{30BD}'), ('\u{FF80}', '\u{30BF}'),
    ('\u{FF81}', '\u{30C1}'), ('\u{FF6F}', '\u{30C3}'), ('\u{FF82}', '\u{30C4}'),
    ('\u{FF83}', '\u{30C6}'), ('\u{FF84}', '\u{30C8}'), ('\u{FF85}', '\u{30CA}'),
    ('\u{FF86}', '\u{30CB}'), ('\u{FF87}', '\u{30CC}'), ('\u{FF88}', '\u{30CD}'),
    ('\u{FF89}', '\u{30CE}'), ('\u{FF8A}', '\u{30CF}'), ('\u{FF8B}', '\u{30D2}'),
    ('\u{FF8C}', '\u{30D5}'), ('\u{FF8D}', '\u{30D8}'), ('\u{FF8E}', '\u{30DB}'),
    ('\u{FF8F}', '\u{30DE}'), ('\u{FF90}', '\u{30DF}'), ('\u{FF91}', '\u{30E0}'),
    ('\u{FF92}', '\u{30E1}'), ('\u{FF93}', '\u{30E2}'), ('\u{FF6C}', '\u{30E3}'),
    ('\u{FF94}', '\u{30E4}'), ('\u{FF6D}', '\u{30E5}'), ('\u{FF95}', '\u{30E6}'),
    ('\u{FF6E}', '\u{30E7}'), ('\u{FF96}', '\u{30E8}'), ('\u{FF97}', '\u{30E9}'),
    ('\u{FF98}', '\u{30EA}'), ('\u{FF99}', '\u{30EB}'), ('\u{FF9A}', '\u{30EC}'),
    ('\u{FF9B}', '\u{30ED}'), ('\u{FF9C}', '\u{30EF}'), ('\u{FF66}', '\u{30F2}'),
    ('\u{FF9D}', '\u{30F3}'), ('\u{FF70}', '\u{30FC}'), ('\u{FF65}', '\u{30FB}'),
    ('\u{FF62}', '\u{300C}'), ('\u{FF63}', '\u{300D}'), ('\u{FF61}', '\u{3002}'),
    ('\u{FF64}', '\u{3001}'),
];

/// Converts half-width characters to full-width matching `jaconv.h2z(text, ascii=True, digit=True)`.
pub fn h2z(text: &str) -> String {
    let mut s = text.to_string();
    for (from, to) in DAKUTEN_PAIRS {
        if s.contains(from) {
            s = s.replace(from, to);
        }
    }
    s.chars()
        .map(|c| match c {
            ' ' => '\u{3000}',
            '\u{21}'..='\u{7E}' => char::from_u32(c as u32 + 0xFEE0).unwrap_or(c),
            _ => HALF_TO_FULL_KANA
                .iter()
                .find(|(h, _)| *h == c)
                .map(|(_, f)| *f)
                .unwrap_or(c),
        })
        .collect()
}

/// Post-processes OCR text matching `manga_ocr.ocr.post_process`.
pub fn post_process(text: &str) -> String {
    let stripped: String = text.split_whitespace().collect();
    let stripped = stripped.replace('…', "...");

    // Collapse runs of 2+ dots or middle dots to ASCII dots.
    let chars: Vec<char> = stripped.chars().collect();
    let mut collapsed = String::with_capacity(stripped.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '.' || chars[i] == '・' {
            let mut j = i;
            while j < chars.len() && (chars[j] == '.' || chars[j] == '・') {
                j += 1;
            }
            if j - i >= 2 {
                for _ in i..j {
                    collapsed.push('.');
                }
                i = j;
                continue;
            }
        }
        collapsed.push(chars[i]);
        i += 1;
    }

    h2z(&collapsed)
}

// ---------------------------------------------------------------------------
// Beam search
// ---------------------------------------------------------------------------

/// Finished hypothesis candidate.
struct Hypothesis {
    /// `sum_logprobs / generated_len.powf(length_penalty)`.
    score: f64,
    sum_logprobs: f64,
    generated_len: usize,
    tokens: Vec<i64>,
}

impl Hypothesis {
    fn confidence(&self) -> f32 {
        if self.generated_len == 0 {
            return 0.0;
        }
        (self.sum_logprobs / self.generated_len as f64).exp().clamp(0.0, 1.0) as f32
    }
}

/// Pool of completed beams matching `transformers.generation.BeamHypotheses`.
struct BeamHypotheses {
    beams: Vec<Hypothesis>,
    worst_score: f64,
}

impl BeamHypotheses {
    fn new() -> Self {
        BeamHypotheses { beams: Vec::new(), worst_score: 1e9 }
    }

    /// Adds hypothesis and maintains top-K candidates.
    fn add(&mut self, tokens: Vec<i64>, sum_logprobs: f64, generated_len: usize) {
        let score = sum_logprobs / (generated_len as f64).powf(LENGTH_PENALTY);
        if self.beams.len() < NUM_BEAMS || score > self.worst_score {
            self.beams.push(Hypothesis { score, sum_logprobs, generated_len, tokens });
            if self.beams.len() > NUM_BEAMS {
                let mut order: Vec<usize> = (0..self.beams.len()).collect();
                order.sort_by(|&a, &b| {
                    self.beams[a].score.total_cmp(&self.beams[b].score).then(a.cmp(&b))
                });
                self.beams.remove(order[0]);
                let second = if order[1] > order[0] { order[1] - 1 } else { order[1] };
                self.worst_score = self.beams[second].score;
            } else {
                self.worst_score = self.worst_score.min(score);
            }
        }
    }

    /// `is_done` under `early_stopping=True`: the moment the pool is full there
    /// is nothing a longer beam could add, so the search stops.
    fn is_done(&self) -> bool {
        self.beams.len() >= NUM_BEAMS
    }
}

/// Identifies tokens that would form a duplicate trigram within the beam sequence.
fn banned_tokens(seq: &[i64], banned: &mut Vec<i64>) {
    banned.clear();
    let cur_len = seq.len();
    if cur_len + 1 < NO_REPEAT_NGRAM_SIZE {
        return;
    }
    let prefix = &seq[cur_len - (NO_REPEAT_NGRAM_SIZE - 1)..cur_len];
    for w in seq.windows(NO_REPEAT_NGRAM_SIZE) {
        if &w[..NO_REPEAT_NGRAM_SIZE - 1] == prefix {
            banned.push(w[NO_REPEAT_NGRAM_SIZE - 1]);
        }
    }
}

/// Numerically stable `log_softmax` over a slice.
fn log_softmax(row: &mut [f32]) {
    let max = row.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut sum = 0f32;
    for v in row.iter() {
        sum += (*v - max).exp();
    }
    let log_sum = sum.ln() + max;
    for v in row.iter_mut() {
        *v -= log_sum;
    }
}

/// Normalises logits, zeroes banned trigram continuations, and adds beam score.
///
/// Matches HuggingFace `_beam_search` order: log_softmax first, logits_processor second.
fn next_token_scores(row: &mut [f32], banned: &[i64], beam_score: f32) {
    log_softmax(row);
    for t in banned {
        row[*t as usize] = f32::NEG_INFINITY;
    }
    for v in row.iter_mut() {
        *v += beam_score;
    }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/// Loaded manga-ocr models (encoder, decoder, vocabulary).
pub struct OcrEngine {
    encoder: Session,
    decoder: Session,
    vocab: Vec<String>,
}

impl OcrEngine {
    /// Loads `encoder_model.onnx`, `decoder_model.onnx` and `vocab.txt` from model directory.
    ///
    /// The encoder sees one fixed input shape; the decoder's token sequence
    /// grows every step, so it only goes to providers that handle dynamic
    /// shapes without recompiling (see `accel`).
    pub fn load(dir: &Path) -> ort::Result<Self> {
        let (encoder, _) = super::accel::open(&dir.join("encoder_model.onnx"), false)?;
        let (decoder, _) = super::accel::open(&dir.join("decoder_model.onnx"), true)?;
        let vocab_path = dir.join("vocab.txt");
        let vocab_text = std::fs::read_to_string(&vocab_path)
            .map_err(|e| ort::Error::new(format!("{}: {e}", vocab_path.display())))?;
        let vocab: Vec<String> = vocab_text.lines().map(|l| l.to_string()).collect();
        Ok(OcrEngine { encoder, decoder, vocab })
    }

    /// Runs OCR on an image crop.
    pub fn ocr(&mut self, img: &DynamicImage) -> ort::Result<String> {
        self.ocr_with_confidence(img).map(|reading| reading.text)
    }

    /// Runs OCR, retaining the winning beam's mean per-token probability.
    pub fn ocr_with_confidence(&mut self, img: &DynamicImage) -> ort::Result<OcrReading> {
        let pixel_values = preprocess(img);
        let input = Tensor::from_array(([1usize, 3, INPUT_SIZE, INPUT_SIZE], pixel_values))?;
        let outputs = self.encoder.run(ort::inputs!["pixel_values" => input])?;
        let (shape, hidden) = outputs["last_hidden_state"].try_extract_tensor::<f32>()?;
        let seq = shape[1] as usize;
        let width = shape[2] as usize;

        // Tile encoder outputs for the 4 beams once.
        let mut tiled = Vec::with_capacity(NUM_BEAMS * seq * width);
        for _ in 0..NUM_BEAMS {
            tiled.extend_from_slice(hidden);
        }
        drop(outputs);

        let (tokens, confidence) = self.search(&tiled, seq, width)?;
        Ok(OcrReading { text: post_process(&self.decode(&tokens)), confidence })
    }

    /// Detokenizes token ids to text matching `tokenizer.decode(ids, skip_special_tokens=True)`.
    fn decode(&self, ids: &[i64]) -> String {
        let pieces: Vec<&str> = ids
            .iter()
            .filter(|id| **id >= FIRST_ORDINARY_TOKEN)
            .filter_map(|id| self.vocab.get(*id as usize).map(|s| s.as_str()))
            .collect();
        pieces.join(" ").replace(" ##", "").trim().to_string()
    }

    /// Four-beam search matching HuggingFace `_beam_search` with trigram blocking and early stopping.
    fn search(&mut self, encoder_hidden: &[f32], enc_seq: usize, width: usize) -> ort::Result<(Vec<i64>, f32)> {
        let vocab_size = self.vocab.len();
        let mut beams: Vec<Vec<i64>> = vec![vec![CLS_TOKEN]; NUM_BEAMS];
        let mut beam_scores: Vec<f32> = vec![-1e9; NUM_BEAMS];
        beam_scores[0] = 0.0;
        let mut pool = BeamHypotheses::new();
        let mut banned = Vec::new();

        loop {
            let seq_len = beams[0].len();

            let mut ids = Vec::with_capacity(NUM_BEAMS * seq_len);
            for b in &beams {
                ids.extend_from_slice(b);
            }
            let ids = Tensor::from_array(([NUM_BEAMS, seq_len], ids))?;
            let enc = Tensor::from_array((
                [NUM_BEAMS, enc_seq, width],
                encoder_hidden.to_vec(),
            ))?;
            let outputs = self.decoder.run(ort::inputs![
                "input_ids" => ids,
                "encoder_hidden_states" => enc,
            ])?;
            let (shape, logits) = outputs["logits"].try_extract_tensor::<f32>()?;
            let out_seq = shape[1] as usize;
            
            if seq_len == 1 && shape[2] as usize != vocab_size {
                return Err(ort::Error::new(format!(
                    "decoder model's vocabulary size ({}) does not match vocab.txt line count ({})",
                    shape[2], vocab_size
                )));
            }

            // Compute next token scores per beam.
            let mut grid = vec![0f32; NUM_BEAMS * vocab_size];
            for b in 0..NUM_BEAMS {
                let start = (b * out_seq + out_seq - 1) * vocab_size;
                let row = &mut grid[b * vocab_size..(b + 1) * vocab_size];
                row.copy_from_slice(&logits[start..start + vocab_size]);
                banned_tokens(&beams[b], &mut banned);
                next_token_scores(row, &banned, beam_scores[b]);
            }
            drop(outputs);

            // Select top 2 * NUM_BEAMS candidates.
            let mut order: Vec<u32> = (0..grid.len() as u32).collect();
            order.sort_by(|&a, &b| {
                grid[b as usize].total_cmp(&grid[a as usize]).then(a.cmp(&b))
            });

            let mut next_beams: Vec<Vec<i64>> = Vec::with_capacity(NUM_BEAMS);
            let mut next_scores: Vec<f32> = Vec::with_capacity(NUM_BEAMS);
            for (rank, &flat) in order.iter().take(2 * NUM_BEAMS).enumerate() {
                let src_beam = flat as usize / vocab_size;
                let token = (flat as usize % vocab_size) as i64;
                let score = grid[flat as usize];

                if token == EOS_TOKEN {
                    if rank >= NUM_BEAMS {
                        continue;
                    }
                    pool.add(beams[src_beam].clone(), score as f64, seq_len);
                } else {
                    let mut next = beams[src_beam].clone();
                    next.push(token);
                    next_beams.push(next);
                    next_scores.push(score);
                }
                if next_beams.len() == NUM_BEAMS {
                    break;
                }
            }

            debug_assert_eq!(next_beams.len(), NUM_BEAMS, "beam search ran out of continuations");
            beams = next_beams;
            beam_scores = next_scores;
            let done = pool.is_done();
            if done || seq_len + 1 >= MAX_LENGTH {
                if !done {
                    for (b, tokens) in beams.iter().enumerate() {
                        pool.add(tokens.clone(), beam_scores[b] as f64, tokens.len() - 1);
                    }
                }
                break;
            }
        }

        // Return highest scoring hypothesis.
        let best = pool
            .beams
            .iter()
            .enumerate()
            .max_by(|(ai, a), (bi, b)| a.score.total_cmp(&b.score).then(ai.cmp(bi)))
            .map(|(_, h)| (h.tokens.clone(), h.confidence()))
            .unwrap_or_default();
        Ok(best)
    }
}

impl TextRecognizer for OcrEngine {
    fn ocr_with_confidence(&mut self, img: &DynamicImage) -> ort::Result<OcrReading> {
        OcrEngine::ocr_with_confidence(self, img)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    #[test]
    fn pil_luma_matches_pillows_fixed_point_rounding() {
        assert_eq!(pil_luma(0, 0, 0), 0);
        assert_eq!(pil_luma(255, 255, 255), 255);
        assert_eq!(pil_luma(128, 128, 128), 128);
        // Pure channels matching Pillow fixed-point rounding (0.587*255 rounds to 150, not truncating to 149).
        assert_eq!(pil_luma(255, 0, 0), 76);
        assert_eq!(pil_luma(0, 255, 0), 150);
        assert_eq!(pil_luma(0, 0, 255), 29);
    }

    #[test]
    fn resize_of_a_flat_plane_is_that_flat_value() {
        for v in [0u8, 1, 127, 200, 255] {
            let src = vec![v; 40 * 90];
            let out = pil_bilinear_resize(&src, 40, 90, INPUT_SIZE, INPUT_SIZE);
            assert!(out.iter().all(|p| *p == v), "value {v} did not survive the resize");
        }
    }

    #[test]
    fn resize_matches_pillow_byte_for_byte() {
        // Verified against PIL.Image.resize(..., BILINEAR) on Pillow 12.2.0.
        let up_src: [u8; 15] = [11, 48, 85, 122, 159, 196, 233, 14, 51, 88, 125, 162, 199, 236, 17];
        let up_want: [u8; 16] =
            [20, 63, 107, 150, 136, 112, 63, 106, 178, 155, 105, 76, 134, 177, 221, 72];
        assert_eq!(pil_bilinear_resize(&up_src, 5, 3, 4, 4), up_want);

        let down_src: Vec<u8> = (0..(11 * 7)).map(|i| ((i * 13 + 5) % 256) as u8).collect();
        assert_eq!(pil_bilinear_resize(&down_src, 11, 7, 3, 2), [110, 138, 117, 146, 116, 120]);
    }

    #[test]
    fn resize_to_the_same_size_is_the_identity() {
        let src: Vec<u8> = (0..(16 * 16)).map(|i| (i * 7 % 256) as u8).collect();
        let out = pil_bilinear_resize(&src, 16, 16, 16, 16);
        assert_eq!(out, src);
    }

    #[test]
    fn preprocess_produces_the_encoders_tensor_shape_and_range() {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(37, 140, Rgb([255, 255, 255])));
        let t = preprocess(&img);
        assert_eq!(t.len(), 3 * INPUT_SIZE * INPUT_SIZE);
        assert!(t.iter().all(|v| (*v - 1.0).abs() < 1e-6));

        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(37, 140, Rgb([0, 0, 0])));
        let t = preprocess(&img);
        assert!(t.iter().all(|v| (*v + 1.0).abs() < 1e-6));
    }

    #[test]
    fn post_process_reproduces_the_python_functions_steps() {
        assert_eq!(post_process("こ ん に ち は"), "こんにちは");
        assert_eq!(post_process("あ…"), "あ．．．");
        assert_eq!(post_process("あ・・い"), "あ．．い");
        assert_eq!(post_process("あ・い"), "あ・い");
        assert_eq!(post_process("あ..い"), "あ．．い");
        assert_eq!(post_process("AB12!?"), "ＡＢ１２！？");
        assert_eq!(post_process("ｶﾞｷ"), "ガキ");
        assert_eq!(post_process("面識がない"), "面識がない");
    }

    #[test]
    fn h2z_leaves_a_voiced_mark_that_follows_nothing_it_can_join_alone() {
        assert_eq!(h2z("\u{FF9E}"), "\u{FF9E}");
        assert_eq!(h2z("\u{FF9F}"), "\u{FF9F}");
        assert_eq!(h2z("あ\u{FF9E}"), "あ\u{FF9E}");
        // Full-width katakana is not joined; only half-width pairs in DAKUTEN_PAIRS.
        assert_eq!(h2z("ア\u{FF9E}"), "ア\u{FF9E}");
        assert_eq!(h2z("ｳ\u{FF9E}"), "ヴ");
        assert_eq!(h2z("ﾊ\u{FF9F}"), "パ");
    }

    #[test]
    fn banned_tokens_bans_only_repeated_trigrams() {
        let mut out = Vec::new();
        banned_tokens(&[2], &mut out);
        assert!(out.is_empty());
        banned_tokens(&[2, 10], &mut out);
        assert!(out.is_empty());
        banned_tokens(&[2, 10, 11, 2, 10], &mut out);
        assert_eq!(out, vec![11]);
        banned_tokens(&[2, 10, 11, 2, 10, 12, 2, 10], &mut out);
        assert_eq!(out, vec![11, 12]);
        banned_tokens(&[2, 10, 11, 2, 13], &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn the_trigram_ban_lands_after_the_log_softmax_not_before_it() {
        let mut row = [0.0f32, 0.0];
        next_token_scores(&mut row, &[0], 0.0);
        assert_eq!(row[0], f32::NEG_INFINITY);
        assert!(
            (row[1] - 0.5f32.ln()).abs() < 1e-6,
            "survivors must not be renormalised after a ban: {}",
            row[1]
        );

        let mut row = [0.0f32, 0.0];
        next_token_scores(&mut row, &[], -2.0);
        assert!((row[0] - (0.5f32.ln() - 2.0)).abs() < 1e-6, "{}", row[0]);
        assert!((row[1] - (0.5f32.ln() - 2.0)).abs() < 1e-6, "{}", row[1]);

        let mut row = [0.0f32, 0.0];
        next_token_scores(&mut row, &[1], 1e9);
        assert_eq!(row[1], f32::NEG_INFINITY);
    }

    #[test]
    fn log_softmax_sums_to_one_and_preserves_order() {
        let mut row = [1.0f32, 2.0, 3.0, -5.0];
        log_softmax(&mut row);
        let total: f32 = row.iter().map(|v| v.exp()).sum();
        assert!((total - 1.0).abs() < 1e-5, "probabilities summed to {total}");
        assert!(row[2] > row[1] && row[1] > row[0] && row[0] > row[3]);
    }

    #[test]
    fn beam_pool_keeps_the_best_four_and_applies_the_length_penalty() {
        let mut pool = BeamHypotheses::new();
        // Dividing negative logprob sum by len^2.0 rewards longer sequences.
        pool.add(vec![2, 10], -4.0, 2);
        pool.add(vec![2, 10, 11, 12], -4.0, 4);
        assert!((pool.beams[0].score - (-1.0)).abs() < 1e-12);
        assert!((pool.beams[1].score - (-0.25)).abs() < 1e-12);
        // Confidence uses the unpenalised sum and generated length, including
        // EOS when present and excluding the initial CLS token.
        assert!((pool.beams[0].confidence() - (-2.0f32).exp()).abs() < 1e-6);
        assert!((pool.beams[1].confidence() - (-1.0f32).exp()).abs() < 1e-6);
        assert!(pool.beams[1].score > pool.beams[0].score);
        assert!(!pool.is_done());

        pool.add(vec![2, 13], -100.0, 2);
        pool.add(vec![2, 14], -200.0, 2);
        assert!(pool.is_done());
        pool.add(vec![2, 15], -1000.0, 2);
        assert_eq!(pool.beams.len(), NUM_BEAMS);
        assert!(pool.beams.iter().all(|h| h.tokens != vec![2, 15]));
    }

    /// Fixture crop entry from `ocr-golden.json`.
    #[derive(serde::Deserialize)]
    struct GoldenCrop {
        crop: String,
        jp: String,
    }

    /// Loads crop fixture swapping BGR channels back to match Python's PIL input.
    fn load_crop_as_python_saw_it(path: &Path) -> DynamicImage {
        let rgb = image::open(path).unwrap_or_else(|e| panic!("{}: {e}", path.display())).to_rgb8();
        let mut swapped = rgb.clone();
        for px in swapped.pixels_mut() {
            px.0.swap(0, 2);
        }
        DynamicImage::ImageRgb8(swapped)
    }

    #[test]
    fn ocr_matches_the_python_sidecar_on_the_golden_crops() {
        // The point of the port is that it reads the same text as the
        // `transformers` path it replaces. Every other test here checks one
        // stage in isolation; this is the only one that checks the stages
        // compose into the same pipeline, on real crops.
        //
        // It skips rather than fails when its inputs are absent: the two ONNX
        // graphs are a 440 MB download that is not in the repo.
        let Some(home) = std::env::var_os("HOME") else {
            eprintln!("skipping golden test: HOME not set");
            return;
        };
        let model_dir = std::path::PathBuf::from(home)
            .join(".mangatypesetter")
            .join("models")
            .join("manga-ocr");
        if !model_dir.join("encoder_model.onnx").exists() {
            eprintln!("skipping golden test: models not found in {}", model_dir.display());
            return;
        }

        let fixture_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/analyze-golden");
        let Ok(fixture_json) = std::fs::read_to_string(fixture_dir.join("ocr-golden.json")) else {
            eprintln!("skipping golden test: fixture not found in {}", fixture_dir.display());
            return;
        };
        let golden: Vec<GoldenCrop> =
            serde_json::from_str(&fixture_json).expect("ocr-golden.json is not the expected shape");

        let started = std::time::Instant::now();
        let mut engine = OcrEngine::load(&model_dir).expect("failed to load the OCR models");

        // Every crop is run and reported before anything is asserted, so a
        // partial failure shows the whole picture rather than only the first
        // disagreement.
        let mut failures = Vec::new();
        for g in &golden {
            let path = fixture_dir.join(&g.crop);
            let img = load_crop_as_python_saw_it(&path);
            let got = engine.ocr(&img).expect("ocr failed");
            if got == g.jp {
                eprintln!("  ok   {}: {got}", g.crop);
            } else {
                eprintln!("  FAIL {}\n    python: {}\n    rust:   {got}", g.crop, g.jp);
                failures.push(g.crop.clone());
            }
        }
        eprintln!(
            "golden ocr: {}/{} crops matched in {:.1}s",
            golden.len() - failures.len(),
            golden.len(),
            started.elapsed().as_secs_f64()
        );

        assert!(
            failures.is_empty(),
            "{} of {} crops disagreed with the Python sidecar: {:?}",
            failures.len(),
            golden.len(),
            failures
        );
    }
}
