// Frontend bridge to the detection engine.
//
// Under Tauri this is the in-process ONNX engine in `src-tauri/src/detect/`,
// reached through the `detect_*` commands - there is no separate process any
// more, so nothing here has a lifecycle to manage. In a plain browser (vite dev
// / preview) there's no Tauri runtime, so these become no-ops and the app
// degrades to manual workflows.

import { app, page, applyDetection, toast } from './store.svelte.js';
import { withPageImages, hasRawImage } from './page-images.js';

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
// engine payload { img_width, img_height, panels, lines:[{n,type,jp,en,box,vertical,font_size,lang}] }
// or throws. Requires Tauri.
export async function analyzeImage(imageUrl, options = {}, maybeLang) {
  const invoke = await getInvoke();
  if (!invoke) throw new Error('detection unavailable (no Tauri runtime)');
  let ocr = true;
  let lang = 'ja';
  if (typeof options === 'string') {
    lang = options;
  } else if (typeof options === 'object' && options !== null) {
    if (options.ocr !== undefined) ocr = options.ocr;
    if (options.lang !== undefined) lang = options.lang;
  }
  if (typeof maybeLang === 'string') {
    lang = maybeLang;
  }
  const buf = await (await fetch(imageUrl)).arrayBuffer();
  const bytes = Array.from(new Uint8Array(buf));
  return invoke('detect_analyze', { image: bytes, ocr, lang });
}

// Detect + OCR one page object and apply results to it. Returns { lines } on
// success or { error } on failure. Shared by the single-page and whole-chapter
// paths. Pins the write to `p` - detection may resolve after the user navigates.
async function detectOnePage(p, { ocr = true, lang } = {}) {
  if (!hasRawImage(p)) return { skipped: true };
  // A batch runs over every page in the chapter, but only five pages' images
  // are in memory at a time (see page-images.js) - so each page is minted for
  // the length of its own detection and given back after it. The pin is what
  // keeps a page turn from revoking the image the engine is reading.
  return await withPageImages(p, async () => {
    if (!p.raw) return { skipped: true };
    try {
      const pageLang = lang ?? app.projectLanguage ?? 'ja';
      const result = await analyzeImage(p.raw, { ocr, lang: pageLang });
      applyDetection(result, p);
      return { lines: result.lines.length };
    } catch (e) {
      return { error: String(e) };
    }
  });
}

// Orchestrates detection for the current page's raw image and applies results.
export async function detectCurrentPage({ ocr = true, lang } = {}) {
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
  try {
    const r = await detectOnePage(p, { ocr, lang });
    if (r.error) toast(`Detection failed: ${r.error}`);
    else toast(`Detected ${r.lines} text region(s)`);
  } finally {
    app.detecting = false;
  }
}

// Detect + OCR every loaded raw page, in order. Runs one page at a time so the
// engine isn't hammered with concurrent requests; the ONNX sessions stay warm
// across pages. Pages without a raw image are skipped.
export async function detectAllPages({ ocr = true, lang } = {}) {
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
  app.detecting = true;
  app.detectBatch = { done: 0, total: targets.length };
  let linesTotal = 0;
  let failed = 0;
  try {
    for (const p of targets) {
      const r = await detectOnePage(p, { ocr, lang });
      if (r.error) failed++;
      else linesTotal += r.lines ?? 0;
      app.detectBatch = { done: app.detectBatch.done + 1, total: targets.length };
    }
    toast(
      `Detected ${targets.length} page(s) · ${linesTotal} text region(s)` +
        (failed ? ` · ${failed} page(s) failed` : ''),
    );
  } finally {
    app.detecting = false;
    app.detectBatch = null;
  }
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
