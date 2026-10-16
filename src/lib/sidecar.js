// Frontend bridge to the detection engine.
//
// Under Tauri this is the in-process ONNX engine in `src-tauri/src/detect/`,
// reached through the `detect_*` commands - there is no separate process any
// more, so nothing here has a lifecycle to manage. In a plain browser (vite dev
// / preview) there's no Tauri runtime, so these become no-ops and the app
// degrades to manual workflows.

import { app, page, applyDetection, toast, toastError } from './store.svelte.js';
import { withPageImages, hasRawImage } from './page-images.js';
import { prefs } from './prefs.svelte.js';
import { ocrModelForLanguage } from './ocr-models.js';
import { chapterOpenSeq } from './library.svelte.js';
import { startJob, finishJob } from './jobs.svelte.js';

// app.sidecar is initialized lazily so older saved state stays compatible.
function ensureState() {
  if (!app.sidecar) app.sidecar = { status: 'unknown', device: null, info: null };
  return app.sidecar;
}

let invokeFn = null;
async function getInvoke() {
  if (invokeFn) return invokeFn;
  // Tauri injects __TAURI_INTERNALS__; absent in the browser.
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return null;
  const mod = await import('@tauri-apps/api/core');
  invokeFn = mod.invoke;
  return invokeFn;
}

export function sidecarReady() {
  return app.sidecar?.status === 'ok';
}

// Run detection + OCR on an image URL (object URL or asset URL). Returns the
// engine payload { img_width, img_height, panels, lines:[{n,type,lang,jp,en,box,vertical,font_size}] }
// or throws. Requires Tauri.
export async function analyzeImage(imageUrl, options = {}, maybeLanguage) {
  const invoke = await getInvoke();
  if (!invoke) throw new Error('detection unavailable (no Tauri runtime)');
  let ocr = true;
  let language = app.projectOcrLanguage;
  if (typeof options === 'string') language = options;
  else if (options && typeof options === 'object') {
    ocr = options.ocr ?? true;
    language = options.language ?? options.lang ?? language;
  }
  if (typeof maybeLanguage === 'string') language = maybeLanguage;
  const buf = await (await fetch(imageUrl)).arrayBuffer();
  const bytes = Array.from(new Uint8Array(buf));
  const ocrModel = ocrModelForLanguage(language, prefs.ocrModels);
  return invoke('detect_analyze', { image: bytes, ocr, language, ocrModel });
}

// Detect + OCR one page object and apply results to it. Returns { lines } on
// success or { error } on failure. Shared by the single-page and whole-chapter
// paths. Pins the write to `p` - detection may resolve after the user navigates.
async function detectOnePage(p, { ocr = true, language, lang } = {}, current = () => true) {
  if (!current()) return { stopped: true };
  if (!hasRawImage(p)) return { skipped: true };
  // A batch runs over every page in the chapter, but only five pages' images
  // are in memory at a time (see page-images.js) - so each page is minted for
  // the length of its own detection and given back after it. The pin is what
  // keeps a page turn from revoking the image the engine is reading.
  try {
    return await withPageImages(p, async () => {
      if (!current()) return { stopped: true };
      if (!p.raw) return { error: 'Raw page could not be read' };
      const result = await analyzeImage(p.raw, { ocr, language: language ?? lang });
      // applyDetection also marks the open chapter unsaved. Even writing to
      // the old page object would let a late result affect the new document.
      if (!current()) return { stopped: true };
      applyDetection(result, p);
      return { lines: result.lines.length };
    });
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

function detectionChapter() {
  const seq = chapterOpenSeq();
  const pages = app.pages;
  const ref = app.chapterRef;
  return () => seq === chapterOpenSeq() && app.pages === pages && app.chapterRef === ref;
}

// Orchestrates detection for the current page's raw image and applies results.
export async function detectCurrentPage({ ocr = true, language, lang } = {}) {
  if (app.detecting) return;
  const p = page();
  if (!hasRawImage(p)) {
    toast('No raw page to detect - import a raw image first');
    return;
  }
  if (!sidecarReady()) {
    toast('Detection engine not ready');
    return;
  }
  app.detecting = true;
  const current = detectionChapter();
  try {
    const r = await detectOnePage(p, { ocr, language, lang }, current);
    if (!current() || r.stopped) return;
    if (r.error) toastError(`Detection failed: ${r.error}`);
    else toast(`Detected ${r.lines} text region(s)`);
  } finally {
    app.detecting = false;
  }
}

// Detect + OCR every loaded raw page, in order. Runs one page at a time so the
// engine isn't hammered with concurrent requests; the ONNX sessions stay warm
// across pages. Pages without a raw image are skipped.
export async function detectAllPages({ ocr = true, language, lang } = {}) {
  if (app.detecting) return;
  if (!sidecarReady()) {
    toast('Detection engine not ready');
    return;
  }
  // By what the page *has*, not by what is currently minted: `p.raw` now only
  // answers for the five pages nearest the one on screen, so filtering on it
  // would silently detect five pages and report a whole-chapter success.
  const targets = app.pages.filter(hasRawImage);
  if (!targets.length) {
    toast('No raw pages to detect - import raw images first');
    return;
  }
  const current = detectionChapter();
  const options = { ocr, language: language ?? lang ?? app.projectOcrLanguage };
  const job = startJob('detect', 'Detect chapter', targets.length, current);
  job.retry = () => {
    if (app.detecting || !current()) return;
    if (!sidecarReady()) { toast('Detection engine not ready'); return; }
    const failed = new Set(job.failed.map((f) => f.pageId));
    return runDetection(targets.filter((p) => failed.has(p.id)), options, job);
  };
  return await runDetection(targets, options, job);
}

// A cancelled page finishes; the next page never starts. Yield between pages
// so progress can paint and Cancel can run even when the engine answers fast.
async function runDetection(targets, options, job) {
  job.running = true;
  job.cancelled = false;
  job.done = 0;
  job.total = targets.length;
  app.detecting = true;
  app.detectBatch = { done: 0, total: job.total };
  let linesTotal = 0;
  let completed = 0;
  try {
    for (const p of targets) {
      if (job.cancelled || !job.current()) break;
      const r = await detectOnePage(p, options, job.current);
      if (!job.current() || r.stopped) break;
      job.failed = job.failed.filter((f) => f.pageId !== p.id);
      if (r.error) {
        job.failed.push({ pageId: p.id, error: r.error });
      } else {
        completed++;
        linesTotal += r.lines ?? 0;
      }
      job.done++;
      app.detectBatch = { done: job.done, total: job.total };
      if (job.done < job.total) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (job.current()) {
      toast(
        (job.cancelled ? `Detection cancelled · ${job.done}/${job.total} pages` : `Detected ${completed} page(s) · ${linesTotal} text region(s)`) +
          (job.failed.length ? ` · ${job.failed.length} page(s) failed` : ''),
      );
    }
  } finally {
    app.detecting = false;
    app.detectBatch = null;
    finishJob(job);
  }
  return job;
}

// ---- model cache (Settings) -----------------------------------------------

// Report the on-disk size/location of the downloaded model caches. Returns
// { entries:[{path,exists,bytes}], total_bytes } or null when Tauri isn't
// available (browser preview).
export async function modelsCacheInfo() {
  const invoke = await getInvoke();
  if (!invoke) return null;
  try {
    return await invoke('detect_models_cache');
  } catch {
    return null;
  }
}

// Delete the downloaded model weights to free disk. Returns the engine's
// { ok, cleared, freed_bytes, errors } result, or throws.
export async function clearModelsCache() {
  const invoke = await getInvoke();
  if (!invoke) throw new Error('detection unavailable (no Tauri runtime)');
  return invoke('detect_models_cache_clear');
}

// ---- engine health --------------------------------------------------------

// Returns the engine's { status, device, engine } report, or null when Tauri
// isn't available. There is no process to wait on any more: the engine lives in
// the app, so the call either answers immediately or the command itself failed.
export async function checkSidecar() {
  const s = ensureState();
  const invoke = await getInvoke();
  if (!invoke) {
    s.status = 'unavailable';
    return null;
  }
  try {
    const health = await invoke('detect_health');
    s.status = 'ok';
    s.device = health.device ?? null;
    s.info = health;
    return health;
  } catch (e) {
    s.status = 'error';
    s.info = String(e);
    return null;
  }
}
