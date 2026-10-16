//! Detection and OCR engine state, model downloads, and Tauri commands.
//!
//! Lazily loads ONNX models behind a mutex while keeping downloads async and unblocked.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use ort::session::Session;
use sha2::{Digest, Sha256};
use tauri::async_runtime::Mutex as AsyncMutex;

use super::accel;
use super::analyze::{analyze, decode_image, AnalyzeResponse};
use super::ocr::{OcrEngine, TextRecognizer};
use super::paddle_ocr::PaddleOcrEngine;
use super::panels;
use super::sorting::ReadingDirection;
use super::textdetector::TextDetector;

/// Model file relative path, pinned download URL and SHA-256.
struct ModelFile {
    rel: &'static str,
    url: &'static str,
    sha256: &'static str,
}

const PANEL_MODEL: ModelFile = ModelFile {
    rel: "manga109_yolo_l_yv11.onnx",
    url: "https://huggingface.co/deepghs/manga109_yolo/resolve/6b5730a9f1f34581b87468f2c609e3269a9faccf/v2023.12.07_l_yv11/model.onnx",
    sha256: "66f6fbf6435d26a6b93880ba52fdc0cecbf8634ab8e52a20f70c1625c6ae0723",
};
const TEXT_DETECTOR: ModelFile = ModelFile {
    rel: "comictextdetector.onnx",
    url: "https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx",
    sha256: "1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f",
};
const JAPANESE_OCR_FILES: [ModelFile; 3] = [
    ModelFile {
        rel: "manga-ocr/encoder_model.onnx",
        url: "https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/f9023406bb2f6b17df67bc4a327c56ecd20611f0/onnx/encoder_model.onnx",
        sha256: "df35f64c2400ea860c70a2d06f2a1f99892374a78c89fcf35308076557a3863f",
    },
    ModelFile {
        rel: "manga-ocr/decoder_model.onnx",
        url: "https://huggingface.co/onnx-community/manga-ocr-base-ONNX/resolve/f9023406bb2f6b17df67bc4a327c56ecd20611f0/onnx/decoder_model.onnx",
        sha256: "31ca14d6dee6b3966144e128d0481d5a91f5083cbced81fe7a9571713fa50cd4",
    },
    ModelFile {
        rel: "manga-ocr/vocab.txt",
        url: "https://huggingface.co/kha-white/manga-ocr-base/resolve/aa6573bd10b0d446cbf622e29c3e084914df9741/vocab.txt",
        sha256: "344fbb6b8bf18c57839e924e2c9365434697e0227fac00b88bb4899b78aa594d",
    },
];
const CHINESE_OCR_V5_MOBILE: ModelFile = ModelFile {
    rel: "paddleocr/ch_PP-OCRv5_rec_mobile.onnx",
    url: "https://huggingface.co/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx",
    sha256: "5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5",
};
const CHINESE_OCR_V5_SERVER: ModelFile = ModelFile {
    rel: "paddleocr/ch_PP-OCRv5_rec_server.onnx",
    url: "https://huggingface.co/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_server.onnx",
    sha256: "e09385400eaaaef34ceff54aeb7c4f0f1fe014c27fa8b9905d4709b65746562a",
};
const KOREAN_OCR_V5_MOBILE: ModelFile = ModelFile {
    rel: "paddleocr/korean_PP-OCRv5_rec_mobile.onnx",
    url: "https://huggingface.co/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/onnx/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx",
    sha256: "cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b",
};
const KOREAN_OCR_V4_MOBILE: ModelFile = ModelFile {
    rel: "paddleocr/korean_PP-OCRv4_rec_mobile.onnx",
    url: "https://huggingface.co/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/onnx/PP-OCRv4/rec/korean_PP-OCRv4_rec_mobile.onnx",
    sha256: "ab151ba9065eccd98f884cf4d927db091be86137276392072edd4f9d43ad7426",
};
const PADDLE_OCR_V6_SMALL: ModelFile = ModelFile {
    rel: "paddleocr/PP-OCRv6_rec_small.onnx",
    url: "https://huggingface.co/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx",
    sha256: "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
};
const PADDLE_OCR_V6_MEDIUM: ModelFile = ModelFile {
    rel: "paddleocr/PP-OCRv6_rec_medium.onnx",
    url: "https://huggingface.co/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/onnx/PP-OCRv6/rec/PP-OCRv6_rec_medium.onnx",
    sha256: "eef444829dbbe18d7fea59a3f6eb75647518d2b3a9568d27c92e42940204894b",
};

/// The source language selected on the project. Unknown/missing values retain
/// the Japanese behaviour every project had before this setting existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum OcrLanguage {
    Japanese,
    Chinese,
    Korean,
}

impl OcrLanguage {
    fn from_code(code: Option<&str>) -> Self {
        match code {
            Some("zh") => Self::Chinese,
            Some("ko") => Self::Korean,
            _ => Self::Japanese,
        }
    }

    fn direction(self) -> ReadingDirection {
        match self {
            Self::Japanese => ReadingDirection::Rtl,
            Self::Chinese | Self::Korean => ReadingDirection::Ltr,
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::Japanese => "ja",
            Self::Chinese => "zh",
            Self::Korean => "ko",
        }
    }
}

/// A concrete recognizer selected in Settings. The language remains a project
/// property (and controls reading order); this is a machine preference for the
/// quality/size trade-off used whenever that language is detected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum OcrModel {
    MangaOcr,
    ChineseV5Mobile,
    ChineseV5Server,
    KoreanV5Mobile,
    KoreanV4Mobile,
    PaddleV6Small,
    PaddleV6Medium,
}

impl OcrModel {
    fn default_for(language: OcrLanguage) -> Self {
        match language {
            OcrLanguage::Japanese => Self::MangaOcr,
            // Quality-first defaults. The smaller and language-specific models
            // stay available in Settings for slower machines and comparisons.
            OcrLanguage::Chinese => Self::PaddleV6Medium,
            // PP-OCRv6 supports Chinese, English, Japanese and Latin-script
            // languages, but not Korean. PP-OCRv5 Korean is PaddleOCR's
            // current language-specific model and its documented quality pick.
            OcrLanguage::Korean => Self::KoreanV5Mobile,
        }
    }

    fn from_code(language: OcrLanguage, code: Option<&str>) -> Self {
        match (language, code) {
            (OcrLanguage::Japanese, _) => Self::MangaOcr,
            (OcrLanguage::Chinese, Some("ch-ppocrv5-mobile")) => Self::ChineseV5Mobile,
            (OcrLanguage::Chinese, Some("ch-ppocrv5-server")) => Self::ChineseV5Server,
            (OcrLanguage::Chinese, Some("ppocrv6-small")) => Self::PaddleV6Small,
            (OcrLanguage::Chinese, Some("ppocrv6-medium")) => Self::PaddleV6Medium,
            (OcrLanguage::Korean, Some("ko-ppocrv5-mobile")) => Self::KoreanV5Mobile,
            (OcrLanguage::Korean, Some("ko-ppocrv4-mobile")) => Self::KoreanV4Mobile,
            _ => Self::default_for(language),
        }
    }

    fn paddle_file(self) -> Option<&'static ModelFile> {
        match self {
            Self::MangaOcr => None,
            Self::ChineseV5Mobile => Some(&CHINESE_OCR_V5_MOBILE),
            Self::ChineseV5Server => Some(&CHINESE_OCR_V5_SERVER),
            Self::KoreanV5Mobile => Some(&KOREAN_OCR_V5_MOBILE),
            Self::KoreanV4Mobile => Some(&KOREAN_OCR_V4_MOBILE),
            Self::PaddleV6Small => Some(&PADDLE_OCR_V6_SMALL),
            Self::PaddleV6Medium => Some(&PADDLE_OCR_V6_MEDIUM),
        }
    }
}

enum Recognizer {
    Japanese(OcrEngine),
    Paddle(PaddleOcrEngine),
}

impl TextRecognizer for Recognizer {
    fn ocr(&mut self, img: &image::DynamicImage) -> ort::Result<String> {
        match self {
            Self::Japanese(engine) => engine.ocr(img),
            Self::Paddle(engine) => engine.ocr(img),
        }
    }

    fn prefers_line_crops(&self) -> bool {
        match self {
            Self::Japanese(engine) => engine.prefers_line_crops(),
            Self::Paddle(engine) => engine.prefers_line_crops(),
        }
    }
}

/// Directory where downloaded model weights reside, relative to `$HOME`.
const MODELS_SUFFIX: [&str; 2] = [".mangatypesetter", "models"];

/// How long a model download may wait on the network without a byte arriving -
/// to connect, for the headers, or between body reads (default 300s,
/// overridable via `MT_DOWNLOAD_DEADLINE`).
fn download_deadline() -> Duration {
    let secs = std::env::var("MT_DOWNLOAD_DEADLINE")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| *v > 0.0)
        .unwrap_or(300.0);
    Duration::from_secs_f64(secs)
}

#[derive(Default)]
struct Sessions {
    detector: Option<TextDetector>,
    panels: Option<Session>,
    ocr: HashMap<OcrModel, Recognizer>,
    /// Execution provider the text detector landed on, once it has loaded.
    device: Option<&'static str>,
    /// What the isolated probe answered, before any model has loaded.
    probed: Option<&'static str>,
}

struct Inner {
    models_dir: PathBuf,
    sessions: Mutex<Sessions>,
    /// Per-file download lock to prevent duplicate concurrent fetches.
    downloads: Mutex<HashMap<&'static str, Arc<AsyncMutex<()>>>>,
}

/// Lazily-loaded detection models shared across commands.
#[derive(Clone)]
pub struct DetectEngine(Arc<Inner>);

impl DetectEngine {
    pub fn new(models_dir: PathBuf) -> DetectEngine {
        DetectEngine(Arc::new(Inner {
            models_dir,
            sessions: Mutex::new(Sessions::default()),
            downloads: Mutex::new(HashMap::new()),
        }))
    }

    pub fn models_dir(&self) -> &Path {
        &self.0.models_dir
    }

    /// Execution provider detection runs on: the one the loaded weights use,
    /// or, before any model has loaded, the one a load would pick right now.
    pub fn device(&self) -> &'static str {
        let (mut s, _) = self.lock_sessions();
        if let Some(device) = s.device {
            return device;
        }
        // Probed once per run, in a child process: see accel::probe_isolated.
        s.probed.get_or_insert_with(accel::probe_isolated)
    }

    /// Acquires the session lock, resetting poisoned state if a previous caller panicked.
    fn lock_sessions(&self) -> (MutexGuard<'_, Sessions>, bool) {
        match self.0.sessions.lock() {
            Ok(guard) => (guard, false),
            Err(poisoned) => {
                self.0.sessions.clear_poison();
                let mut guard = poisoned.into_inner();
                *guard = Sessions::default();
                (guard, true)
            }
        }
    }

    /// Downloads missing model files, holding a per-file gate to avoid duplicate transfers.
    async fn ensure(&self, files: &[&ModelFile]) -> Result<(), String> {
        for f in files {
            let path = self.0.models_dir.join(f.rel);
            if path.is_file() {
                continue;
            }
            let gate = {
                let mut map = self.0.downloads.lock().unwrap_or_else(|e| e.into_inner());
                Arc::clone(map.entry(f.rel).or_default())
            };
            let _held = gate.lock().await;
            if path.is_file() {
                continue;
            }
            download(f.url, &path, f.sha256).await?;
        }
        Ok(())
    }

    /// Runs page analysis on a blocking thread, loading models as needed.
    fn analyze_blocking(
        &self,
        bytes: &[u8],
        want_ocr: bool,
        language: OcrLanguage,
        model: OcrModel,
    ) -> Result<AnalyzeResponse, String> {
        let img = decode_image(bytes)?;
        let dir = &self.0.models_dir;
        let (mut s, recovered) = self.lock_sessions();
        if recovered {
            // Poison cleared: prompt user to retry after resetting dropped sessions.
            return Err("the detection engine panicked on an earlier page and has been \
                        reset; retry this page"
                .to_string());
        }

        if s.detector.is_none() {
            let detector = TextDetector::load(&dir.join(TEXT_DETECTOR.rel))
                .map_err(|e| format!("failed to load the text detector: {e}"))?;
            s.device = Some(detector.device());
            s.detector = Some(detector);
        }
        if s.panels.is_none() {
            // Panel detection failure degrades to spatial sort rather than aborting.
            match panels::load_session(&dir.join(PANEL_MODEL.rel)) {
                Ok(session) => s.panels = Some(session),
                Err(e) => log::warn!("panel model unavailable, reading order degrades: {e}"),
            }
        }
        if want_ocr && !s.ocr.contains_key(&model) {
            let recognizer = match model {
                OcrModel::MangaOcr => Recognizer::Japanese(
                    OcrEngine::load(&dir.join("manga-ocr"))
                        .map_err(|e| format!("failed to load the Japanese OCR models: {e}"))?,
                ),
                _ => {
                    let file = model
                        .paddle_file()
                        .expect("non-Japanese models have one file");
                    Recognizer::Paddle(
                        PaddleOcrEngine::load(&dir.join(file.rel))
                            .map_err(|e| format!("failed to load the selected OCR model: {e}"))?,
                    )
                }
            };
            s.ocr.insert(model, recognizer);
        }

        let Sessions {
            detector,
            panels,
            ocr,
            ..
        } = &mut *s;
        let detector = detector.as_mut().expect("loaded above");
        let recognizer = if want_ocr {
            ocr.get_mut(&model)
                .map(|engine| engine as &mut dyn TextRecognizer)
        } else {
            None
        };
        analyze(
            &img,
            detector,
            panels.as_mut(),
            recognizer,
            language.direction(),
            language.code(),
        )
    }
}

/// Unique per-download scratch path to prevent collisions between concurrent processes.
fn part_path(path: &Path) -> PathBuf {
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let n = SERIAL.fetch_add(1, Ordering::Relaxed);
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".{}.{n}.part", std::process::id()));
    PathBuf::from(tmp)
}

/// Checks a streamed download's hash before renaming it and cleans up scratch files.
fn commit_download(tmp: &Path, path: &Path, expected: &str, got: &str) -> Result<(), String> {
    if got != expected {
        let _ = std::fs::remove_file(tmp);
        return Err(format!(
            "{}: SHA-256 hash did not match (expected {expected:.12}, got {got:.12})",
            path.display()
        ));
    }
    if path.is_file() {
        let _ = std::fs::remove_file(tmp);
        return Ok(());
    }
    match std::fs::rename(tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(tmp);
            Err(format!("{}: {e}", path.display()))
        }
    }
}

/// Streams a model file to disk via a scratch file with backpressured async-to-disk channel.
async fn download(url: &str, path: &Path, sha256: &str) -> Result<(), String> {
    download_within(url, path, sha256, download_deadline()).await
}

/// `download`, with the stall bound passed in - the seam the tests use, since
/// no suite may wait the real five minutes out.
async fn download_within(url: &str, path: &Path, sha256: &str, stall: Duration) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let tmp = part_path(path);

    // `Vec<u8>` rather than reqwest's `Bytes`, which would move without a copy
    // but is a type this crate cannot name without taking a dependency on
    // `bytes` for one channel. A memcpy per chunk is nothing beside the write
    // it is queueing for.
    let (tx, mut rx) = tauri::async_runtime::channel::<Vec<u8>>(8);
    let writer = {
        let tmp = tmp.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
            use std::io::Write;
            let mut file =
                std::fs::File::create(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
            let mut hash = Sha256::new();
            while let Some(chunk) = rx.blocking_recv() {
                file.write_all(&chunk).map_err(|e| format!("{}: {e}", tmp.display()))?;
                hash.update(&chunk);
            }
            file.sync_all().map_err(|e| format!("{}: {e}", tmp.display()))?;
            Ok(format!("{:x}", hash.finalize()))
        })
    };

    // A timeout says which wait gave out; anything else is reqwest's own words.
    let failed = |e: reqwest::Error| {
        if e.is_timeout() {
            format!(
                "download stalled for {:.0}s (stalled mirror?): {url}",
                stall.as_secs_f64()
            )
        } else {
            format!("{url}: {e}")
        }
    };

    let streamed = async {
        // The stall bound is a timeout the transfer is actually waiting on.
        // It used to be a deadline compared AFTER `chunk().await` came back,
        // and a server that sends its headers and a few bytes and then holds
        // the connection open never lets that call come back - so the check
        // never ran, the download waited for good, and every analyze needing
        // the same weight queued behind its gate in `ensure`. reqwest's read
        // timeout covers both waits that can stall: the one for the response
        // headers, and each read of the body, reset by every read that lands.
        // Time spent blocked on the disk writer below is not a read, so a slow
        // disk is never mistaken for a stalled mirror.
        let mut resp = reqwest::Client::builder()
            .connect_timeout(stall)
            .read_timeout(stall)
            .build()
            .map_err(|e| format!("{url}: {e}"))?
            .get(url)
            .send()
            .await
            .map_err(failed)?
            .error_for_status()
            .map_err(|e| format!("{url}: {e}"))?;

        // `chunk()` rather than `bytes_stream()`: the same streaming, without
        // pulling the `stream` feature and `futures-util` in for one loop.
        while let Some(chunk) = resp.chunk().await.map_err(failed)? {
            if tx.send(chunk.to_vec()).await.is_err() {
                // The only way the receiver hangs up is a write error, and it
                // is holding the message that says which. Stop feeding it and
                // let the join below report the real cause.
                break;
            }
        }
        Ok(())
    }
    .await;

    // Closing the channel is what ends the writer's loop, so it has to happen
    // before the join whatever the transfer did.
    drop(tx);
    let written = writer
        .await
        .map_err(|e| format!("download writer failed: {e}"))
        .and_then(|r| r);

    match streamed.and(written) {
        Ok(got) => commit_download(&tmp, path, sha256, &got),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// `~/.mangatypesetter/models`, the one directory this module owns.
pub fn default_models_dir() -> PathBuf {
    // Windows sets USERPROFILE, not HOME; falling through to "." would drop
    // model downloads into the install directory, which is not writable.
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(MODELS_SUFFIX[0]).join(MODELS_SUFFIX[1])
}

// ---------------------------------------------------------------------------
// Cache inspection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CacheEntry {
    pub path: String,
    pub exists: bool,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CacheInfo {
    pub entries: Vec<CacheEntry>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CacheClear {
    pub ok: bool,
    pub cleared: Vec<String>,
    pub freed_bytes: u64,
    pub errors: Vec<String>,
}

/// Total bytes of a directory tree, skipping unreadable entries.
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = entry.path().symlink_metadata() else { continue };
        if meta.is_dir() {
            total += dir_size(&entry.path());
        } else {
            total += meta.len();
        }
    }
    total
}

pub fn cache_info(models_dir: &Path) -> CacheInfo {
    let resolved = models_dir.canonicalize().unwrap_or_else(|_| models_dir.to_path_buf());
    let exists = resolved.is_dir();
    let bytes = if exists { dir_size(&resolved) } else { 0 };
    CacheInfo {
        entries: vec![CacheEntry { path: resolved.display().to_string(), exists, bytes }],
        total_bytes: bytes,
    }
}

/// Validates that a directory path ends in `.mangatypesetter/models` before allowing deletion.
fn guard_models_dir(dir: &Path) -> Result<PathBuf, String> {
    let resolved = dir
        .canonicalize()
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut tail = resolved.components().rev().take(2).collect::<Vec<_>>();
    tail.reverse();
    let names: Vec<String> = tail.iter().map(|c| c.as_os_str().to_string_lossy().into()).collect();
    if names != MODELS_SUFFIX {
        return Err(format!(
            "refusing to clear {}: not a {}/{} directory",
            resolved.display(),
            MODELS_SUFFIX[0],
            MODELS_SUFFIX[1]
        ));
    }
    Ok(resolved)
}

pub fn cache_clear(models_dir: &Path) -> CacheClear {
    let mut out = CacheClear { ok: true, cleared: Vec::new(), freed_bytes: 0, errors: Vec::new() };
    if !models_dir.is_dir() {
        // Idempotent clear: recreate empty directory.
        let _ = std::fs::create_dir_all(models_dir);
        return out;
    }
    let resolved = match guard_models_dir(models_dir) {
        Ok(p) => p,
        Err(e) => {
            out.ok = false;
            out.errors.push(e);
            return out;
        }
    };
    let size = dir_size(&resolved);
    match std::fs::remove_dir_all(&resolved) {
        Ok(()) => {
            out.freed_bytes = size;
            out.cleared.push(resolved.display().to_string());
        }
        Err(e) => {
            out.ok = false;
            out.errors.push(format!("{}: {e}", resolved.display()));
        }
    }
    let _ = std::fs::create_dir_all(&resolved);
    out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Detect text blocks (+ optional OCR) and panels on one page.
#[tauri::command]
pub async fn detect_analyze(
    state: tauri::State<'_, DetectEngine>,
    image: Vec<u8>,
    ocr: bool,
    language: Option<String>,
    ocr_model: Option<String>,
) -> Result<AnalyzeResponse, String> {
    let engine = state.inner().clone();
    let language = OcrLanguage::from_code(language.as_deref());
    let model = OcrModel::from_code(language, ocr_model.as_deref());
    let mut needed: Vec<&ModelFile> = vec![&TEXT_DETECTOR];
    if ocr {
        match model.paddle_file() {
            Some(file) => needed.push(file),
            None => needed.extend(JAPANESE_OCR_FILES.iter()),
        }
    }
    engine.ensure(&needed).await?;

    if let Err(e) = engine.ensure(&[&PANEL_MODEL]).await {
        log::warn!("failed to download panel model, reading order degrades: {e}");
    }

    tauri::async_runtime::spawn_blocking(move || {
        engine.analyze_blocking(&image, ocr, language, model)
    })
    .await
    .map_err(|e| format!("analyze task failed: {e}"))?
}

/// On-disk size + location of the downloaded model weights (Settings panel).
#[tauri::command]
pub async fn detect_models_cache(
    state: tauri::State<'_, DetectEngine>,
) -> Result<CacheInfo, String> {
    let engine = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache_info(engine.models_dir()))
        .await
        .map_err(|e| format!("cache task failed: {e}"))
}

/// Delete the downloaded weights to free disk. They re-download lazily.
#[tauri::command]
pub async fn detect_models_cache_clear(
    state: tauri::State<'_, DetectEngine>,
) -> Result<CacheClear, String> {
    let engine = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Reset sessions and hold lock across directory removal to prevent race with analyze.
        let (mut s, _) = engine.lock_sessions();
        *s = Sessions::default();
        let out = cache_clear(engine.models_dir());
        drop(s);
        out
    })
    .await
    .map_err(|e| format!("cache-clear task failed: {e}"))
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Health {
    pub status: String,
    pub device: String,
    pub engine: String,
    /// False on a Linux build compiled without a GPU provider (the CPU-only
    /// release lane). The settings dialog uses it to say that acceleration
    /// needs the WebGPU download, not a driver.
    pub gpu_build: bool,
}

/// Whether this binary was compiled with any GPU execution provider.
const fn gpu_build() -> bool {
    !cfg!(target_os = "linux") || cfg!(any(feature = "gpu-webgpu", feature = "gpu-cuda"))
}

/// Reports engine status and the execution provider detection runs on.
#[tauri::command]
pub async fn detect_health(state: tauri::State<'_, DetectEngine>) -> Result<Health, String> {
    let engine = state.inner().clone();
    // Probing registers a provider, which on CUDA/WebGPU means bringing a
    // device up; keep that off the async runtime.
    let device = tauri::async_runtime::spawn_blocking(move || engine.device())
        .await
        .map_err(|e| format!("health probe failed: {e}"))?;
    Ok(Health {
        status: "ok".into(),
        device: device.into(),
        engine: "onnx-rust".into(),
        gpu_build: gpu_build(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_language_selects_its_recognizer_and_reading_direction() {
        assert_eq!(OcrLanguage::from_code(None), OcrLanguage::Japanese);
        assert_eq!(
            OcrLanguage::from_code(Some("unknown")),
            OcrLanguage::Japanese
        );
        assert_eq!(OcrLanguage::from_code(Some("zh")), OcrLanguage::Chinese);
        assert_eq!(OcrLanguage::from_code(Some("ko")), OcrLanguage::Korean);
        assert_eq!(OcrLanguage::Japanese.direction(), ReadingDirection::Rtl);
        assert_eq!(OcrLanguage::Chinese.direction(), ReadingDirection::Ltr);
        assert_eq!(OcrLanguage::Korean.direction(), ReadingDirection::Ltr);

        assert_eq!(
            OcrModel::from_code(OcrLanguage::Chinese, None),
            OcrModel::PaddleV6Medium
        );
        assert_eq!(
            OcrModel::from_code(OcrLanguage::Korean, None),
            OcrModel::KoreanV5Mobile
        );
        assert_eq!(
            OcrModel::from_code(OcrLanguage::Chinese, Some("ch-ppocrv5-server")),
            OcrModel::ChineseV5Server
        );
        assert_eq!(
            OcrModel::from_code(OcrLanguage::Korean, Some("ko-ppocrv5-mobile")),
            OcrModel::KoreanV5Mobile
        );
        assert_eq!(
            OcrModel::from_code(OcrLanguage::Korean, Some("ppocrv6-medium")),
            OcrModel::KoreanV5Mobile,
            "stored selections from the pre-fix build must migrate away from the unsupported model"
        );
        assert_eq!(
            OcrModel::from_code(OcrLanguage::Korean, Some("ch-ppocrv5-server")),
            OcrModel::KoreanV5Mobile,
            "a model for another language must fall back rather than load"
        );
        assert_eq!(
            OcrModel::from_code(OcrLanguage::Japanese, Some("ppocrv6-medium")),
            OcrModel::MangaOcr
        );
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mt-engine-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn the_default_model_dir_is_under_the_users_home() {
        let d = default_models_dir();
        assert!(d.ends_with(".mangatypesetter/models"), "{}", d.display());
    }

    #[test]
    fn cache_info_reports_a_missing_directory_as_empty() {
        let root = scratch("missing");
        let info = cache_info(&root.join("models"));
        assert_eq!(info.entries.len(), 1);
        assert!(!info.entries[0].exists);
        assert_eq!(info.total_bytes, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_model_files_still_count_as_present_without_hashing() {
        let root = scratch("existing-model");
        let engine = DetectEngine::new(root.clone());
        let path = root.join(TEXT_DETECTOR.rel);
        std::fs::write(&path, b"old cached weights").unwrap();

        tauri::async_runtime::block_on(engine.ensure(&[&TEXT_DETECTOR])).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"old cached weights");
        let info = cache_info(&root);
        assert!(info.entries[0].exists);
        assert_eq!(info.total_bytes, 18);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_info_sums_a_tree_including_subdirectories() {
        let root = scratch("sizes");
        std::fs::write(root.join("a.onnx"), vec![0u8; 1000]).unwrap();
        std::fs::create_dir_all(root.join("manga-ocr")).unwrap();
        std::fs::write(root.join("manga-ocr/b.onnx"), vec![0u8; 234]).unwrap();
        let info = cache_info(&root);
        assert!(info.entries[0].exists);
        assert_eq!(info.total_bytes, 1234);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_clear_guard_rejects_a_directory_that_is_not_the_model_cache() {
        // The whole point of the guard: this function is one `remove_dir_all`
        // away from a user's home directory, driven by a button in Settings.
        let root = scratch("guard");
        let wrong = root.join("Documents");
        std::fs::create_dir_all(&wrong).unwrap();
        assert!(guard_models_dir(&wrong).is_err());

        let nearly = root.join(".mangatypesetter").join("model");
        std::fs::create_dir_all(&nearly).unwrap();
        assert!(guard_models_dir(&nearly).is_err(), "one letter off must not pass");

        let shallow = root.join("models");
        std::fs::create_dir_all(&shallow).unwrap();
        assert!(guard_models_dir(&shallow).is_err(), "the parent must match too");

        let right = root.join(".mangatypesetter").join("models");
        std::fs::create_dir_all(&right).unwrap();
        assert!(guard_models_dir(&right).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_a_guarded_directory_empties_it_and_recreates_it() {
        let root = scratch("clear");
        let models = root.join(".mangatypesetter").join("models");
        std::fs::create_dir_all(models.join("manga-ocr")).unwrap();
        std::fs::write(models.join("a.onnx"), vec![7u8; 500]).unwrap();
        std::fs::write(models.join("manga-ocr/b.onnx"), vec![7u8; 100]).unwrap();

        let out = cache_clear(&models);
        assert!(out.ok, "{out:?}");
        assert_eq!(out.freed_bytes, 600);
        assert_eq!(out.cleared.len(), 1);
        assert!(models.is_dir(), "the directory must survive for the next download");
        assert_eq!(cache_info(&models).total_bytes, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_a_directory_that_fails_the_guard_deletes_nothing() {
        let root = scratch("clear-guard");
        let wrong = root.join("Pictures");
        std::fs::create_dir_all(&wrong).unwrap();
        std::fs::write(wrong.join("holiday.png"), vec![1u8; 10]).unwrap();

        let out = cache_clear(&wrong);
        assert!(!out.ok);
        assert_eq!(out.cleared, Vec::<String>::new());
        assert_eq!(out.freed_bytes, 0);
        assert!(wrong.join("holiday.png").exists(), "the file must still be there");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_a_missing_cache_succeeds_and_creates_it() {
        let root = scratch("clear-missing");
        let models = root.join(".mangatypesetter").join("models");
        let out = cache_clear(&models);
        assert!(out.ok);
        assert_eq!(out.freed_bytes, 0);
        assert!(models.is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_download_deadline_honours_its_override() {
        // Not parallel-safe against other env readers, so it sets, reads and
        // restores in one place rather than relying on test isolation.
        let prev = std::env::var("MT_DOWNLOAD_DEADLINE").ok();
        std::env::set_var("MT_DOWNLOAD_DEADLINE", "12.5");
        assert_eq!(download_deadline(), Duration::from_secs_f64(12.5));
        std::env::set_var("MT_DOWNLOAD_DEADLINE", "not a number");
        assert_eq!(download_deadline(), Duration::from_secs(300));
        match prev {
            Some(v) => std::env::set_var("MT_DOWNLOAD_DEADLINE", v),
            None => std::env::remove_var("MT_DOWNLOAD_DEADLINE"),
        }
    }

    #[test]
    fn two_downloads_of_one_file_never_share_a_scratch_path() {
        // The bug this pins: a fixed `<file>.part` meant two cold-start
        // detects wrote into the same file and renamed the interleaving into
        // place as a "valid" weight.
        let path = PathBuf::from("/models/manga-ocr/encoder_model.onnx");
        let a = part_path(&path);
        let b = part_path(&path);
        assert_ne!(a, b);
        for p in [&a, &b] {
            let s = p.to_string_lossy();
            assert!(s.starts_with("/models/manga-ocr/encoder_model.onnx."), "{s}");
            assert!(s.ends_with(".part"), "{s}");
        }
        // And the suffix is appended rather than substituted, so two weights
        // that differ only by extension still cannot collide.
        let txt = part_path(Path::new("/models/vocab.txt"));
        let onnx = part_path(Path::new("/models/vocab.onnx"));
        assert!(txt.to_string_lossy().contains("vocab.txt."), "{}", txt.display());
        assert!(onnx.to_string_lossy().contains("vocab.onnx."), "{}", onnx.display());
    }

    #[test]
    fn committing_a_download_checks_its_hash_and_removes_mismatches() {
        let root = scratch("commit");
        let tmp = root.join("model.onnx.1.part");
        let dest = root.join("model.onnx");
        let expected = "9a129038d9a00aed0cf6a7ea059ca50a813449061ab87848cf1a13eafdf33b2c";
        std::fs::write(&tmp, b"corrupt").unwrap();
        let got = format!("{:x}", Sha256::digest(std::fs::read(&tmp).unwrap()));

        let err = commit_download(&tmp, &dest, expected, &got).unwrap_err();
        assert!(err.contains("model.onnx"), "{err}");
        assert!(err.contains("hash did not match"), "{err}");
        assert!(err.contains("expected 9a129038d9a0"), "{err}");
        assert!(err.contains("got 11d510e067d2"), "{err}");
        assert!(!tmp.exists(), "a hash mismatch must remove the scratch file");
        assert!(!dest.exists(), "a hash mismatch must never be committed");

        std::fs::write(&tmp, b"weights").unwrap();
        let got = format!("{:x}", Sha256::digest(std::fs::read(&tmp).unwrap()));

        assert!(commit_download(&tmp, &dest, expected, &got).is_ok());
        assert!(!tmp.exists(), "the scratch file must not survive");
        assert_eq!(std::fs::read(&dest).unwrap(), b"weights");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_loser_of_a_download_race_drops_its_copy_rather_than_replacing_the_winners() {
        // Same bytes either way, but the winner's file may already be open in
        // a loaded session, so renaming over it buys nothing and risks a lot.
        let root = scratch("commit-race");
        let tmp = root.join("model.onnx.2.part");
        let dest = root.join("model.onnx");
        std::fs::write(&tmp, b"mine").unwrap();
        std::fs::write(&dest, b"theirs").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"mine"));

        assert!(commit_download(&tmp, &dest, &hash, &hash).is_ok());
        assert!(!tmp.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"theirs");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failed_commit_still_cleans_up_the_scratch_file() {
        // The leak: cleanup used to live only on the transfer-error path, so a
        // rename that failed left the whole download on disk forever. A
        // directory at the destination is the cheapest way to make rename fail.
        let root = scratch("commit-fail");
        let tmp = root.join("model.onnx.3.part");
        let dest = root.join("model.onnx");
        std::fs::write(&tmp, vec![0u8; 64]).unwrap();
        std::fs::create_dir_all(dest.join("occupied")).unwrap();
        let hash = format!("{:x}", Sha256::digest([0u8; 64]));

        assert!(commit_download(&tmp, &dest, &hash, &hash).is_err());
        assert!(!tmp.exists(), "a failed rename must not leak the scratch file");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A server that takes one request and then goes quiet with the connection
    /// held open: after its headers and a few bytes of a much longer body, or
    /// (`headers: false`) before saying anything at all. It hangs up when the
    /// client does, or after a minute whatever happens.
    fn stalling_server(headers: bool) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let Ok((mut conn, _)) = listener.accept() else { return };
            let _ = conn.set_read_timeout(Some(Duration::from_secs(60)));
            let mut seen = Vec::new();
            let mut buf = [0u8; 1024];
            while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                match conn.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => seen.extend_from_slice(&buf[..n]),
                }
            }
            if headers {
                let _ = conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n");
                let _ = conn.write_all(&[7u8; 16]);
                let _ = conn.flush();
            }
            // Held open, sending nothing, until the client gives up on it.
            while matches!(conn.read(&mut buf), Ok(n) if n > 0) {}
        });
        format!("http://{addr}/model.onnx")
    }

    /// Runs `download_within` on its own thread and gives it a hard ceiling, so
    /// a download that never ends fails this test instead of hanging the suite.
    fn download_or_hang(url: String, dest: PathBuf, stall: Duration) -> Result<(), String> {
        let (done, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(tauri::async_runtime::block_on(download_within(
                &url, &dest, TEXT_DETECTOR.sha256, stall,
            )));
        });
        rx.recv_timeout(Duration::from_secs(20))
            .expect("the download never ended: the stall bound did not interrupt the wait")
    }

    #[test]
    fn a_download_that_stalls_mid_body_fails_instead_of_waiting_for_good() {
        // The bug this pins: the deadline was compared only after a chunk had
        // arrived, so a mirror that went quiet mid-body held the download - and
        // the per-file gate every later analyze waits on - forever.
        let root = scratch("stall-body");
        let dest = root.join("model.onnx");
        let err = download_or_hang(stalling_server(true), dest.clone(), Duration::from_millis(300))
            .expect_err("a stalled transfer must fail");
        assert!(err.contains("stalled"), "{err}");
        assert!(!dest.exists(), "a partial download must never be committed");
        let left: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().collect();
        assert!(left.is_empty(), "the scratch file must not survive: {left:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_download_whose_headers_never_come_fails_instead_of_waiting_for_good() {
        let root = scratch("stall-headers");
        let dest = root.join("model.onnx");
        let err = download_or_hang(stalling_server(false), dest.clone(), Duration::from_millis(300))
            .expect_err("a server that never answers must fail the download");
        assert!(err.contains("stalled"), "{err}");
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_panic_under_the_session_lock_is_reported_once_and_then_recovered() {
        // Before: one panic in `analyze_blocking` poisoned the mutex and every
        // later command's `if let Ok` silently did nothing, so detection was
        // dead until the app restarted.
        let engine = DetectEngine::new(scratch("poison"));
        let other = engine.clone();
        let panicked = std::thread::spawn(move || {
            let _guard = other.0.sessions.lock().unwrap();
            panic!("pretend a graph blew up mid-load");
        })
        .join();
        assert!(panicked.is_err(), "the helper thread was supposed to panic");
        assert!(engine.0.sessions.is_poisoned());

        let (guard, recovered) = engine.lock_sessions();
        assert!(recovered, "the first caller after a panic must be told about it");
        drop(guard);

        let (guard, recovered) = engine.lock_sessions();
        assert!(!recovered, "later callers must get a working engine, not a stale error");
        drop(guard);
        assert!(!engine.0.sessions.is_poisoned());
        assert!(engine.0.sessions.lock().is_ok());
        let _ = std::fs::remove_dir_all(engine.models_dir());
    }

    #[test]
    fn every_model_url_is_https() {
        // These are the only outbound requests the app makes, and the reqwest
        // dependency grew a TLS backend for them; if one ever regressed to
        // plain http that backend would be silently unused.
        let all: Vec<&ModelFile> = [
            &PANEL_MODEL,
            &TEXT_DETECTOR,
            &CHINESE_OCR_V5_MOBILE,
            &CHINESE_OCR_V5_SERVER,
            &KOREAN_OCR_V5_MOBILE,
            &KOREAN_OCR_V4_MOBILE,
            &PADDLE_OCR_V6_SMALL,
            &PADDLE_OCR_V6_MEDIUM,
        ]
        .into_iter()
        .chain(JAPANESE_OCR_FILES.iter())
        .collect();
        for f in all {
            assert!(f.url.starts_with("https://"), "{}", f.url);
            assert!(!f.rel.starts_with('/') && !f.rel.contains(".."), "{}", f.rel);
            assert_eq!(f.sha256.len(), 64, "{}", f.rel);
            assert!(f.sha256.bytes().all(|b| b.is_ascii_hexdigit()), "{}", f.rel);
            if let Some((_, rest)) = f.url.split_once("/resolve/") {
                let revision = rest.split('/').next().unwrap();
                assert_eq!(revision.len(), 40, "{}", f.url);
                assert!(revision.bytes().all(|b| b.is_ascii_hexdigit()), "{}", f.url);
            }
        }
    }

    #[test]
    fn paddle_models_use_the_desktop_client_compatible_mirror() {
        for model in [
            &CHINESE_OCR_V5_MOBILE,
            &CHINESE_OCR_V5_SERVER,
            &KOREAN_OCR_V4_MOBILE,
            &KOREAN_OCR_V5_MOBILE,
            &PADDLE_OCR_V6_SMALL,
            &PADDLE_OCR_V6_MEDIUM,
        ] {
            assert!(
                model.url.starts_with("https://huggingface.co/DjB314/RapidOCR/resolve/"),
                "Paddle model regressed to a host the desktop downloader cannot use: {}",
                model.url
            );
        }
    }

    /// Opt-in end-to-end diagnostic using the same download and session path as
    /// the Tauri command, but against a caller-supplied page on disk.
    #[test]
    fn supplied_korean_page_runs_the_production_pipeline() {
        let Ok(page_path) = std::env::var("MT_TEST_KOREAN_PAGE") else {
            eprintln!("skipping Korean page test: MT_TEST_KOREAN_PAGE is not set");
            return;
        };
        let model = OcrModel::from_code(
            OcrLanguage::Korean,
            std::env::var("MT_TEST_KOREAN_MODEL").ok().as_deref(),
        );
        let engine = DetectEngine::new(default_models_dir());
        let ocr_file = model.paddle_file().expect("Korean model must be PaddleOCR");
        tauri::async_runtime::block_on(engine.ensure(&[&TEXT_DETECTOR, ocr_file]))
            .expect("production model download failed");

        let bytes = std::fs::read(&page_path)
            .unwrap_or_else(|error| panic!("failed to read {page_path}: {error}"));
        let result = engine
            .analyze_blocking(&bytes, true, OcrLanguage::Korean, model)
            .unwrap_or_else(|error| panic!("production analysis failed for {page_path}: {error}"));

        eprintln!("production pipeline detected {} regions", result.lines.len());
        for line in &result.lines {
            eprintln!("  {:?}: {:?}", line.r#box, line.jp);
        }
        assert!(!result.lines.is_empty(), "production pipeline returned no regions");
        assert!(
            result.lines.iter().any(|line| !line.jp.trim().is_empty()),
            "Korean recognizer returned empty text for every detected region"
        );
    }
}
