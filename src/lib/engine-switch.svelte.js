// ===== Which engine measures text =====
// The `textEngine` preference, applied: 'browser' is the canvas and the DOM,
// as the app has always measured; 'rust' is the Rust text engine
// (text-engine/, WebAssembly) measuring from the bytes of the user's own
// fonts and the machine's. Only measurement moves. The exporter and the
// editor still draw with the browser, so every font stays registered with it
// exactly as before, and with the switch off nothing in here runs at all.
//
// Turning it on, in order - each step waits for the one before:
//
//   1. the gate. The browser engine stays installed, and the store is told no
//      face is ready (`setFontSource`), so from this moment nothing writes a
//      size or a height into the document: a box placed now is 'pending', a
//      fit asked for now is done when the engine is in. What is on screen
//      meanwhile is the browser's layout, written nowhere.
//   2. the wasm: compiled once per session however often the switch is
//      flipped, and an instance made of it for this turn of the switch.
//   3. the app's own font lists: at launch the user's library is still being
//      read out of IndexedDB and the system scan is still running, and half a
//      library is not the library (`fontsBooted`).
//   4. every user face the session has loaded, handed to the engine, and from
//      here every add, replace and removal as fonts.js reports it.
//   5. the last-resort family (text-engine/last-resort.js), sent for and in.
//   6. the engine is installed, the store is told how names resolve, and
//      everything is laid out again, once (`noteFontsChanged`).
//
// A system family is not part of that: its bytes are sent for the first time
// a box uses it (text-engine/font-sync.js), and its boxes wait as in step 1.
//
// With no last resort there is no family the engine can answer for - a plain
// browser with no user fonts - and then no engine is installed at all:
// measurement is the stand-in it is wherever there is no engine, and nothing
// is written from it.
//
// Not imported by anything on the measuring path (store, measure.js,
// fonts.js): prefs.svelte.js applies the preference through here, and the UI
// reads `engineSwitch`.
import { app, setFontSource, noteFontsChanged, toast, boxText } from './store.svelte.js';
import { watchUserFaces, fontsBooted, loadedFaceRecords } from './fonts.js';
import { faceFor, applyCase } from './measure.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { createRustTextEngine } from './text-engine/rust.js';
import { createFontSync } from './text-engine/font-sync.js';
import { osOf } from './text-engine/last-resort.js';
import { engineWasmUrl, fetchEngineWasm } from './text-engine/wasm.js';

async function tauriInvoke() {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return null;
  return (await import('@tauri-apps/api/core')).invoke;
}

// Everything that reaches outside this module, so a test can stand in for the
// wasm, the native side and the font library without a browser.
const REAL = {
  available: () => !!engineWasmUrl,
  compile: async () => WebAssembly.compile(await fetchEngineWasm()),
  createEngine: (module) => createRustTextEngine(module),
  invoke: tauriInvoke,
  booted: fontsBooted,
  records: loadedFaceRecords,
  watch: watchUserFaces,
  os: () => osOf(typeof navigator === 'undefined' ? '' : navigator.userAgent),
};
let deps = REAL;

export const engineSwitch = $state({
  // Whether this build carries the wasm at all. Without it the switch cannot
  // be turned on, and Settings says why.
  available: REAL.available(),
  // What was asked for, which is the preference.
  mode: 'browser',
  // 'off' the browser measures | 'starting' steps 1-5 | 'on' | 'failed'
  phase: 'off',
  error: '',
  // The family a missing font is measured in, for Settings to name.
  lastResort: null,
});

let generation = 0;
// The compiled wasm, kept for the session: code, no memory of its own. The
// instance (`rust`) is what holds the engine's heap, and that lives only while
// the switch is on.
let modulePromise = null;
let rust = null;
let sync = null;
// What was measuring before, to put back.
let before = null;

function apply() {
  const resort = sync.lastResort();
  engineSwitch.lastResort = resort;
  const want = resort ? rust : null;
  if (textEngine() !== want) setTextEngine(want);
}

// Bytes that were on their way have landed, or will not.
function arrived() {
  if (engineSwitch.phase !== 'on') return;
  apply();
  noteFontsChanged();
}

function leave(phase, error = '') {
  generation++;
  deps.watch(null);
  setFontSource(null);
  sync?.dispose();
  sync = null;
  dispose();
  const was = engineSwitch.phase;
  engineSwitch.phase = phase;
  engineSwitch.error = error;
  engineSwitch.lastResort = null;
  if (was === 'on') setTextEngine(before);
  // Also from 'starting': the fits the gate held back are owed.
  if (was === 'on' || was === 'starting') noteFontsChanged();
}

// Lets go of the wasm instance and of everything that would keep it reachable.
// A wasm memory never shrinks, so emptying the engine of its fonts gives
// nothing back: the heap it grew to stays for as long as the instance does.
// Off therefore drops the instance, and the next on makes a new one out of the
// compiled module.
function dispose() {
  rust = null;
  lettersMemoFor = null;
  lettersMemo.clear();
}

async function start() {
  if (!deps.available()) {
    engineSwitch.phase = 'off';
    return;
  }
  const gen = ++generation;
  const stale = () => gen !== generation;
  engineSwitch.phase = 'starting';
  engineSwitch.error = '';
  before = textEngine();
  setFontSource({ ready: () => false });
  // fonts.js reports from now; what it says before the engine has the library
  // is kept and said again after, in order, so nothing falls between the two.
  const early = [];
  // The faces that arrived that way: the library read below would only hand
  // the same bytes over a second time.
  const told = new Set();
  let live = false;
  const tell = (change) => {
    if (!live) {
      early.push(change);
      return;
    }
    change(sync);
    if (engineSwitch.phase === 'on') apply();
  };
  deps.watch({
    added: (family, slot, bytes) => {
      if (!live) told.add(`${family}::${slot}`);
      tell((s) => s.setUserFace(family, slot, bytes));
    },
    removed: (family, slot) => tell((s) => s.removeUserFace(family, slot)),
    removedFamily: (family) => tell((s) => s.removeUserFamily(family)),
    scanned: () => tell((s) => s.refresh()),
  });
  try {
    let made;
    try {
      made = await deps.createEngine(await (modulePromise ??= deps.compile()));
    } catch (error) {
      // Not remembered: turning the switch off and on is how the user retries.
      modulePromise = null;
      throw error;
    }
    // Turned off meanwhile: the instance just made is nobody's, and is left
    // to the collector rather than kept for a turn that may never come.
    if (stale()) return;
    rust = made;
    await deps.booted();
    if (stale()) return;
    const invoke = await deps.invoke();
    const records = await deps.records();
    if (stale()) return;
    sync = createFontSync({
      engine: rust,
      fonts: app.fonts,
      os: deps.os(),
      systemFace: invoke ? (family, slot, known) => invoke('system_font_face', { family, slot, known }) : null,
      // The bytes go as the raw body of the call and come back the same way: a
      // font as a JSON array of numbers is several times its own size.
      toSfnt: invoke ? (bytes) => invoke('font_to_sfnt', bytes) : null,
      onArrival: arrived,
    });
    for (const rec of records) if (!told.has(`${rec.name}::${rec.slot}`)) sync.setUserFace(rec.name, rec.slot, rec.data);
    live = true;
    for (const change of early.splice(0)) change(sync);
    sync.refresh();
    await sync.settled();
    if (stale()) return;
    engineSwitch.phase = 'on';
    const s = sync;
    setFontSource({ nameFor: (name) => s.nameFor(name), ready: (name) => s.ready(name), missing: (name) => s.missing(name) });
    apply();
    noteFontsChanged();
  } catch (error) {
    if (stale()) return;
    const message = String(error?.message ?? error);
    leave('failed', message);
    toast(`The Rust text engine could not start - ${message}`);
  }
}

/**
 * Applies the preference. Resolves when the engine asked for is the one
 * measuring (or has failed to start, which `engineSwitch` then says).
 */
export function useTextEngine(mode) {
  const next = mode === 'rust' ? 'rust' : 'browser';
  if (next === engineSwitch.mode) return Promise.resolve();
  engineSwitch.mode = next;
  if (next === 'rust') return start();
  leave('off');
  return Promise.resolve();
}

/**
 * Why the Rust engine counts `name` as missing, for the notice that lists it:
 * 'compressed', 'unsaved', 'unreadable' or 'absent'; null when it is not the one
 * measuring or the name is not missing.
 */
export function whyFontMissing(name) {
  if (engineSwitch.phase !== 'on' || !sync) return null;
  app.fontsVersion;
  return sync.whyMissing(name);
}

// ---- letters no face has ----
// With the Rust engine measuring, a letter the box's face lacks is looked for
// in the fallback chain, and one nothing in the chain has is measured as the
// face's empty box. The engine can say which (`missing`); a browser cannot,
// it asks the system for a font and tells nobody.
//
// Kept per face and string: the notice that reads this re-reads it for every
// box of the chapter whenever one of them changes.
const lettersMemo = new Map();
let lettersMemoFor = null;

/** Code points of the box's text no face in the chain has; empty unless the Rust engine is measuring. */
export function lettersMissing(style, text) {
  if (engineSwitch.phase !== 'on' || !rust || textEngine() !== rust) return [];
  // A face arriving changes the answer, and that is this signal.
  app.fontsVersion;
  if (!text || !/\S/.test(text)) return [];
  if (lettersMemoFor !== rust) {
    lettersMemoFor = rust;
    lettersMemo.clear();
    rust.onFontsChange(() => lettersMemo.clear());
  }
  const face = faceFor(style, style.size > 0 ? style.size : 16);
  const key = `${face.name}\n${face.bold ? 1 : 0}${face.italic ? 1 : 0}\n${text}`;
  let out = lettersMemo.get(key);
  if (!out) {
    out = rust.hasFamily(face.name) ? rust.missing(face, applyCase(text, style)) : [];
    if (lettersMemo.size > 20000) lettersMemo.clear();
    lettersMemo.set(key, out);
  }
  return out;
}

/** The open chapter's boxes that have such letters, as [{ pageIndex, boxId, letters }]. */
export function boxesMissingLetters(pages = app.pages) {
  const out = [];
  if (engineSwitch.phase !== 'on') return out;
  (pages ?? []).forEach((p, pageIndex) => {
    for (const b of p.boxes ?? []) {
      if (!b.style) continue;
      const letters = lettersMissing(b.style, String(boxText(b, p) ?? ''));
      if (letters.length) out.push({ pageIndex, boxId: b.id, letters });
    }
  });
  return out;
}

// For the tests: stand-ins for the wasm, the native side and the library, and
// a clean slate between cases.
export function _setEngineSwitchDeps(next) {
  // A stand-in for the engine is not made out of a module, so needs none compiled.
  deps = next ? { ...REAL, compile: async () => null, ...next } : REAL;
  engineSwitch.available = deps.available();
}
export function _resetEngineSwitch() {
  if (engineSwitch.phase !== 'off') leave('off');
  generation++;
  engineSwitch.mode = 'browser';
  engineSwitch.phase = 'off';
  engineSwitch.error = '';
  modulePromise = null;
  rust = null;
}
export const _engineSwitchSync = () => sync;
