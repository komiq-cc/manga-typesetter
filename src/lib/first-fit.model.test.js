// ===== The order of a save, a font landing and the stamp: a model test =====
//
// first-fit.test.js and first-fit.engine.test.js pin cases somebody thought
// of. The defects of the third round (text-engine/P9-REPORT.md) were all cases
// nobody had: an event falling between two moments the code treated as one.
// So this does not list cases. It drives the real store, the real switch and
// the real saver (`library.svelte.js`, over a filesystem held in memory)
// through sequences of events drawn from a seeded generator, lets everything
// come to rest, and reads the file:
//
//   When nothing is in motion - no save in flight, no debounce armed, no box
//   waiting for a font, the engine not starting - exactly one of these holds:
//   (a) the chapter is untouched and unkept, and the file is the file that
//       was opened, byte for byte;
//   (b) the file is the document in memory, and its version is 2 if and only
//       if the Rust engine has fitted every box in it.
//   And leaving, while things are in motion, ends in one of the two.
// This at-rest invariant covers Rust and its actual outstanding save debt.
// Once both current browser files land, ordinary browser ownership resumes.
// Real leave/open boundaries check both files under either engine. A fully
// observed instance of the known browser autosave race stops its order and
// records the executed prefix and unexecuted tail separately. Independently
// retained user choices must survive automatic fits/restoration in memory
// and in chapter.json AND translations.json, across distinct chapter paths.
//
// And one thing more that the file alone cannot show: Keep is ONE write.
//
// A sequence that breaks it is shrunk to the events that matter and printed
// with its seed:
//
//   MODEL_SEED=1234 ./node_modules/.bin/vitest run src/lib/first-fit.model.test.js
//
// replays one seed; MODEL_SEQUENCES and MODEL_STEPS change how many and how
// long; MODEL_REPORT=1 lists every failing seed instead of stopping at five.
// MODEL_WITNESS_OUT writes full browser witnesses to an explicit fresh private
// reports file. Completed invariant orders and witness prefixes are separate.
//
// The engines are the stand-ins of first-fit.test.js: what is tested is an
// order of events, and a measurement only has to differ between the two.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('./fsx.js', () => {
  const tree = { dirs: new Set(), files: new Map() };
  let nextWriteToken = 0;
  const parent = (p) => p.slice(0, p.lastIndexOf('/'));
  const fsx = {
    _tree: tree,
    // The model's hand on a write: called with the path before anything is
    // written. What it returns is waited for, and a rejection is the write
    // failing with nothing written.
    _before: null,
    async readDir(p) {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      const out = new Map();
      for (const d of tree.dirs) {
        const rest = d.startsWith(prefix) ? d.slice(prefix.length) : '';
        if (rest && !rest.includes('/')) out.set(rest, { name: rest, isDirectory: true, isFile: false });
      }
      for (const f of tree.files.keys()) {
        const rest = f.startsWith(prefix) ? f.slice(prefix.length) : '';
        if (rest && !rest.includes('/') && !out.has(rest)) out.set(rest, { name: rest, isDirectory: false, isFile: true });
      }
      return [...out.values()];
    },
    async readTextFile(p) {
      if (!tree.files.has(p)) throw new Error(`ENOENT ${p}`);
      return tree.files.get(p);
    },
    async writeTextFile(p, c) {
      if (parent(p) && !tree.dirs.has(parent(p))) throw new Error(`ENOENT ${parent(p)}`);
      tree.files.set(p, c);
    },
    async writeTextFileAtomic(p, c) {
      const write = { serial: ++nextWriteToken };
      if (fsx._before) await fsx._before(p, c, write);
      await fsx.writeTextFile(p, c);
      fsx._after?.(p, c, write);
    },
    async writeFileAtomic(p, bytes) {
      await fsx.writeFile(p, bytes);
    },
    liveTemps: () => new Set(),
    async mkdir(p) {
      const parts = p.split('/');
      for (let i = 1; i <= parts.length; i++) if (parts.slice(0, i).join('/')) tree.dirs.add(parts.slice(0, i).join('/'));
    },
    async remove(p) {
      for (const d of [...tree.dirs]) if (d === p || d.startsWith(`${p}/`)) tree.dirs.delete(d);
      for (const f of [...tree.files.keys()]) if (f === p || f.startsWith(`${p}/`)) tree.files.delete(f);
    },
    exists: async (p) => tree.dirs.has(p) || tree.files.has(p),
    join: async (...parts) => parts.join('/'),
    homeDir: async () => '/home/u',
    readFile: async (p) => tree.files.get(p) ?? new Uint8Array(),
    async writeFile(p, bytes) {
      if (parent(p) && !tree.dirs.has(parent(p))) throw new Error(`ENOENT ${parent(p)}`);
      tree.files.set(p, bytes);
    },
  };
  return { fsx };
});

// Observe the public saver registration and the promise it actually returns.
// Return that same promise: no extra save, wait, replacement, or queue policy.
const saverObserver = vi.hoisted(() => ({ begin: null, finish: null, boundary: null, reply: null, toast: null, openBoundary: null, openReply: null, scope: null, invocationScope: null }));
vi.mock('./library.svelte.js', async (original) => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  saverObserver.scope = new AsyncLocalStorage();
  saverObserver.invocationScope = new AsyncLocalStorage();
  const module = await original();
  return { ...module, saveOpenChapter(...args) {
    const receipt = saverObserver.begin?.();
    try {
      const done = saverObserver.invocationScope.run(receipt, () => module.saveOpenChapter(...args));
      if (receipt) receipt.originalPromise = done;
      Promise.resolve(done).then(() => saverObserver.finish?.(receipt, null),
        (error) => saverObserver.finish?.(receipt, error));
      return done;
    } catch (error) { saverObserver.finish?.(receipt, error); throw error; }
  }, openChapter(...args) {
    const request = saverObserver.openBoundary?.(...args);
    const done = saverObserver.scope.run(request, () => module.openChapter(...args));
    if (request) request.originalPromise = done;
    Promise.resolve(done).then(() => saverObserver.openReply?.(request, null),
      (error) => saverObserver.openReply?.(request, error));
    return done;
  }, flushBeforeLeaving(...args) {
    const request = saverObserver.boundary?.(args[0]);
    const done = saverObserver.scope.run(request, () => module.flushBeforeLeaving(...args));
    if (request) request.originalPromise = done;
    Promise.resolve(done).then((answer) => saverObserver.reply?.(request, answer, null),
      (error) => saverObserver.reply?.(request, null, error));
    return done;
  } };
});
vi.mock('./store.svelte.js', async (original) => {
  const module = await original();
  return { ...module, toast(...args) {
    const result = module.toast(...args);
    saverObserver.toast?.(saverObserver.scope?.getStore(), args[0]);
    return result;
  }, setSaver(fn) {
    return module.setSaver((...args) => {
      const receipt = saverObserver.begin?.();
      try {
        const done = saverObserver.invocationScope.run(receipt, () => fn(...args));
        if (receipt) receipt.originalPromise = done;
        Promise.resolve(done).then(() => saverObserver.finish?.(receipt, null),
          (error) => saverObserver.finish?.(receipt, error));
        return done;
      } catch (error) { saverObserver.finish?.(receipt, error); throw error; }
    });
  } };
});

const { fsx } = await import('./fsx.js');
const { library, setRoot, createProject, createChapter, openChapter, closeChapter, flushBeforeLeaving, resetSaveFailures, setChapterMode, saveOpenChapter } = await import('./library.svelte.js');
const store = await import('./store.svelte.js');
const { app, autoFitBox, boxEdited, resizeBox, setLineText, markUnsaved, flushSave, firstFitChanges, keepFirstFit, relayoutAll, setChapterTypesetMode, DOC_SAVE_MS } = store;
const { defaultStyle } = await import('./data.js');
const { buildTextJson } = await import('./text-json.js');
const { initHistory } = await import('./editor/history.svelte.js');
const { engineSwitch, useTextEngine, _setEngineSwitchDeps, _resetEngineSwitch } = await import('./engine-switch.svelte.js');
const { textEngine, setTextEngine } = await import('./text-engine/index.js');
const { addFontFile, removeUserFont, systemFontEntry, watchUserFaces } = await import('./fonts.js');
const { contentWidth, setTypesetEnabled, typesetEnabled, clearLayoutMemo } = await import('./measure.js');
const { fakeRustEngine, SFNT, TTC } = await import('../test/fake-rust-engine.js');
const { systemFaceAnswer } = await import('../test/font-collection.js');
const { fakeIndexedDB } = await import('../test/fake-indexeddb.js');

// How long Keep waits for a font before it writes what there is. Read off the
// store when it says (the third round's code does); the unfixed code has no
// such wait, and any number does for it.
const KEEP_WAIT_MS = store.KEEP_WAIT_MS ?? 4000;

// ---------- the two engines ----------
const BROWSER = 0.55;
function fakeBrowser() {
  const ink = (face, text) => ({ width: text.length * face.size * BROWSER, left: 0, right: text.length * face.size * BROWSER, ascent: face.size * 0.7, descent: face.size * 0.2 });
  return {
    id: 'browser',
    advance: (face, text) => text.length * face.size * BROWSER,
    fontBox: (face) => ({ ascent: Math.round(face.size * 0.8), descent: Math.round(face.size * 0.2) }),
    lineInk: ink,
    glyphInk: ink,
    loading: () => false,
    onFontsChange: () => () => {},
    faceReady: () => true,
    wrapPlain: (face, text, opts) => fakePlain((part) => part.length * face.size * BROWSER, text, opts.width),
  };
}
// The stand-ins do not own a DOM. Plain wrapping is deterministic measured
// greedy wrapping here, not a claim about browser CSS parity.
function fakePlain(width, text, limit) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && width(next) > limit) { lines.push(line); line = word; }
      else line = next;
    }
    lines.push(line);
  }
  return lines;
}

// ---------- the made-up chapter ----------
// Two fonts of the user's, which the engine has from the start, and one of
// the machine's (Zapfino), whose file the model holds back: a box set in it
// waits, and an edit to that box has its fit held.
const SIZE = 20;
const style = (font) => ({ ...defaultStyle(), font, size: SIZE, lineHeight: 1.1, valign: 'top', strokes: [], shadows: [] });
const INSET = 100 - contentWidth(100, style('AnimeAce'));
const box = (id, font, text, content, y) => ({ id, lineN: null, text, x: 100, y, w: content + INSET, h: 20, style: style(font), fit: null });
const BOXES = () => [
  box('same', 'AnimeAce', 'AA', 200, 100),
  box('relaid', 'AnimeAce', 'AAAA BBBB CCCC', 80, 200),
  box('grow', 'Narrow', 'AA BB', 60, 400),
  box('late', 'Zapfino', 'AAAA BBBB', 60, 600),
];
const LINES = () => [{ n: 1, jp: 'AA', en: 'AA', tags: [] }];
const FILES = {
  'Helvetica Neue': [{ slots: { regular: 0, bold: 1, italic: 2, boldItalic: 3 }, bytes: TTC() }],
  Zapfino: [{ slots: { regular: 0 }, bytes: SFNT() }],
};
const fontFile = (name) => ({ name, arrayBuffer: async () => SFNT().buffer });

// ---------- what the model holds in its hand ----------
const hand = {
  // Chapter writes wait here while `hold` is set: { path, ok, fail }.
  hold: false,
  holdTranslations: false,
  writes: [],
  // Every chapter.json write that began, in order: its version and the clock.
  began: [],
  landed: [],
  // Requests for the slow family's file, while `fontHeld`.
  fontHeld: true,
  fonts: [],
  // The engine's start, while `startHeld`.
  startHeld: false,
  starts: [],
};
let engineTurn = 0;
const invoke = async (cmd, args) => {
  if (cmd === 'system_font_coverage') return { families: [], none: args.codePoints };
  if (cmd === 'font_to_sfnt') return SFNT().buffer;
  if (cmd !== 'system_font_face') throw new Error(`unexpected command ${cmd}`);
  if (args.family === 'Zapfino' && hand.fontHeld) await new Promise((resolve) => hand.fonts.push(Object.assign(resolve, { family: args.family, turn: engineTurn })));
  const file = (FILES[args.family] ?? []).find((f) => args.slot in f.slots);
  if (!file) throw new Error(`no system font '${args.family}'`);
  return systemFaceAnswer(file.slots, file.bytes, { known: args.known });
};
const createEngine = async () => {
  // An obsolete held factory completing later must not advance the turn
  // away from the currently requested engine's held font requests.
  engineTurn++;
  if (hand.startHeld) await new Promise((resolve) => hand.starts.push(resolve));
  const engine = fakeRustEngine();
  engine.wrapPlain = (face, text, opts) => fakePlain((part) => engine.advance(face, part), text, opts.width);
  return engine;
};

// ---------- time, which is the model's too ----------
const tick = async (rounds = 60) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};
// Lets everything that can run, run, and moves the clock by `ms`.
async function pass(ms = 0) {
  await tick();
  await vi.advanceTimersByTimeAsync(ms);
  await tick();
}
// Waits for a promise whose way goes through timers and the hand's gates.
async function until(promise) {
  let done = false;
  let out;
  let error = null;
  promise.then(
    (v) => ((done = true), (out = v)),
    (e) => ((done = true), (error = e)),
  );
  for (let i = 0; i < 200 && !done; i++) await pass(0);
  if (!done) throw new Error('the model waited for something that never came');
  if (error) throw error;
  return out;
}

let p;
let c;
let chapters;
let chapterPath;
let translationsPath;
let V1;
let V2;
const original = { engine: textEngine(), typeset: typesetEnabled(), system: app.fonts.system };
const fontLibrary = fakeIndexedDB();
const onDisk = () => fsx._tree.files.get(chapterPath);
const textOnDisk = () => fsx._tree.files.get(translationsPath);
const rustFitting = () => engineSwitch.phase === 'on' && textEngine()?.id === 'rust';
// Whether a box of the open chapter is still without its font: the engine is
// starting, or a request for the slow family has not been answered.
const waiting = () => engineSwitch.phase === 'starting' || (rustFitting() && hand.fonts.some((f) => f.turn === engineTurn && app.pages.some((pg) => pg.boxes.some((b) => b.style?.font === f.family))));

const canon = (v) =>
  JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
// The open document as the saver writes it (`writeOpenChapter`).
const documentNow = () =>
  JSON.parse(JSON.stringify(app.pages)).map((pg) => ({
    id: pg.id, file: pg.file ?? '', cleaned: pg.cleanedFile ?? null, w: pg.w, h: pg.h,
    ...(pg.needsRespace ? { needsRespace: true } : null),
    lines: pg.lines, detect: pg.detect, boxes: pg.boxes,
  }));

function resetHand() {
  for (const w of hand.writes.splice(0)) w.ok();
  for (const f of hand.fonts.splice(0)) f();
  for (const s of hand.starts.splice(0)) s();
  hand.hold = false;
  hand.holdTranslations = false;
  hand.fontHeld = true;
  hand.startHeld = false;
  hand.began = [];
  hand.landed = [];
  hand.broke = null;
}

// Timer duration alone does not establish document ownership. History has
// its own 800ms persistence timer; only its immediate, positively observed
// setter is excluded. Missing, unfamiliar and similarly named origins stay
// conservative, including every unrecognized save/Keep-duration timer.
function timerSource(ms, setterStack) {
  const caller = setterStack?.split('\n')[2]?.trim() ?? '';
  if (ms === DOC_SAVE_MS && /^at schedule \(.*\/src\/lib\/editor\/history-file\.svelte\.js:\d+:\d+\)$/.test(caller)) return 'history';
  if (ms === DOC_SAVE_MS && /^at markUnsaved \(.*\/src\/lib\/store\.svelte\.js:\d+:\d+\)$/.test(caller)) return 'document';
  if (ms === KEEP_WAIT_MS && /^at keepFirstFit \(.*\/src\/lib\/store\.svelte\.js:\d+:\d+\)$/.test(caller)) return 'keep';
  return 'unknown';
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.stubGlobal('FontFace', class {
    async load() {
      return this;
    }
  });
  vi.stubGlobal('document', { fonts: { add() {}, delete() {} } });
  vi.stubGlobal('indexedDB', fontLibrary);
  const schedule = globalThis.setTimeout.bind(globalThis);
  const cancel = globalThis.clearTimeout.bind(globalThis);
  vi.stubGlobal('setTimeout', (callback, ms, ...args) => {
    const setterStack = new Error('observed timer arm').stack;
    const source = timerSource(ms, setterStack);
    const observed = { serial: ++state.nextObservation, ms, at: Date.now(), ref: app.chapterRef, refToken: refToken(app.chapterRef),
      source, setterStack, relevant: (ms === DOC_SAVE_MS || ms === KEEP_WAIT_MS) && source !== 'history',
      pending: true, event: state.event };
    const id = schedule((...values) => {
      observed.pending = false;
      observed.firedAt = Date.now();
      for (const window of state.finalWindows) if (window.timer?.id === id) window.timer.firedAt = Date.now();
      return callback(...values);
    }, ms, ...args);
    state.timers.set(id, observed);
    if (ms !== DOC_SAVE_MS) return id;
    for (const window of state.finalWindows) {
      if (window.ref !== app.chapterRef || !window.laterChoices.size || !hand.writes.includes(window.heldWriter)) continue;
      if (!/\bmarkUnsaved\b/.test(setterStack ?? '')) continue;
      window.timer = { id, serial: observed.serial, ms, at: Date.now(), event: state.event,
        unsavedWhenArmed: !app.saved, setterStack,
        cancelledByMarkSaved: false, bothFilesAtCancellation: false };
    }
    return id;
  });
  vi.stubGlobal('clearTimeout', (id) => {
    const observed = state.timers.get(id);
    // One actual clearer stack, captured before the original clear call.
    const clearerStack = observed ? new Error('observed timer clear').stack : null;
    const clearerCaller = clearerStack?.split('\n')[2]?.trim() ?? '';
    const clearerSource = /^at (markSaved|flushSave|markUnsaved) \(.*\/src\/lib\/store\.svelte\.js:\d+:\d+\)$/.exec(clearerCaller)?.[1] ?? 'unknown';
    const context = saverObserver.scope?.getStore();
    const invocation = saverObserver.invocationScope?.getStore();
    if (observed) {
      const ch = chapters.find((chapter) => chapter.id === observed.ref?.chapterId);
      const physical = ch && paths(ch);
      const clear = { pendingBefore: observed.pending, firedAt: observed.firedAt, cancelledAt: Date.now(), cancelOrder: ++state.nextObservation,
        clearerStack, clearerCaller, clearerSource, currentRefToken: refToken(app.chapterRef),
        publicRequestSerial: context?.serial ?? null, publicContextPending: context?.pending ?? false,
        saverSerial: invocation?.serial ?? null, saverRefToken: invocation?.refToken ?? null, saverContextPending: invocation?.pending ?? false,
        physicalAtCancellation: physical ? { chapterPath: physical.chapter, textPath: physical.text,
          chapter: fsx._tree.files.get(physical.chapter), text: fsx._tree.files.get(physical.text) } : null };
      observed.clears ??= []; observed.clears.push(clear);
      Object.assign(observed, clear, { pending: false });
    }
    for (const window of state.finalWindows) {
      if (!window.timer || window.timer.id !== id || window.ref !== app.chapterRef || !observed?.pendingBefore || !/\bmarkSaved\b/.test(clearerStack ?? '')) continue;
      const path = paths(window.chapter);
      Object.assign(window.timer, { cancelledByMarkSaved: true,
        cancelledAt: Date.now(), cancellationEvent: state.event, clearerStack, clearerCaller, clearerSource,
        cancelOrder: observed?.cancelOrder, publicRequestSerial: context?.serial ?? null,
        saverSerial: invocation?.serial ?? null, saverRefToken: invocation?.refToken ?? null, saverContextPending: invocation?.pending ?? false,
        bothFilesAtCancellation: fsx._tree.files.get(path.chapter) === window.snapshot?.chapter &&
          fsx._tree.files.get(path.text) === window.snapshot?.text });
    }
    return cancel(id);
  });
  fsx._tree.dirs.add('/lib');
  await setRoot('/lib');
  library.projects = [];
  initHistory();
  setTextEngine(fakeBrowser());
  setTypesetEnabled(true);
  _setEngineSwitchDeps({ available: () => true, createEngine, invoke: async () => invoke, booted: async () => {}, os: () => 'macos' });
  app.fonts.system = [
    systemFontEntry({ name: 'Helvetica Neue', faces: { regular: true, bold: true, italic: true, boldItalic: true } }),
    systemFontEntry({ name: 'Zapfino', faces: { regular: true } }),
  ];
  await until(addFontFile(fontFile('AnimeAce.ttf')));
  await until(addFontFile(fontFile('Narrow.ttf')));
  p = await until(createProject('Model'));
  chapters = [];
  for (const [number, title] of [[1, 'Old'], [2, 'Other'], [3, 'Empty']]) {
    chapters.push(await until(createChapter({ projectId: p.id, number, title, files: ['a.png', 'b.png'].map((name) => ({ name, arrayBuffer: async () => new Uint8Array([1]).buffer })), translations: [] })));
  }
  c = chapters[0];
  chapterPath = `${c.dir}/chapter.json`;
  translationsPath = `${c.dir}/translations.json`;
  fsx._before = (path, text, write) => {
    if (chapters.some((ch) => path === `${ch.dir}/translations.json`)) {
      finalSnapshot(path, text);
      if (!hand.holdTranslations) return undefined;
      return new Promise((ok, fail) => {
        const writer = { path, bytes: text, ref: null, ok, fail };
        finalSnapshot(path, text, writer);
        hand.writes.push(writer);
      });
    }
    if (!chapters.some((ch) => path === `${ch.dir}/chapter.json`)) return undefined;
    write.started = { path, bytes: text, ref: null, rawWriteSerial: write.serial, version: JSON.parse(text).typesetting?.version ?? null, at: Date.now(), browser: engineSwitch.phase === 'off' };
    hand.began.push(write.started);
    finalSnapshot(path, text);
    seen.writes++;
    const number = hand.began.at(-1).version;
    if (path === chapterPath && waiting() && number !== app.typesetting.version) hand.broke ??= `a save while the current chapter still waits changed its number from ${app.typesetting.version} to ${number}`;
    // Keep is one write, and it happens when its wait is over: not while a
    // font is still on its way and the wait has time left.
    if (state.keep?.alone && waiting() && Date.now() - state.keep.at < KEEP_WAIT_MS) {
      hand.broke ??= `Keep's write went out ${Date.now() - state.keep.at} ms after the press, at version ${hand.began.at(-1).version}, while a font was still on its way and its wait was not over`;
    }
    if (!hand.hold) return undefined;
    return new Promise((ok, fail) => {
      const writer = { path, bytes: text, ref: null, ok, fail };
      finalSnapshot(path, text, writer);
      hand.writes.push(writer);
    });
  };
  fsx._after = (path, text, write) => {
    const save = invocationAt(path);
    const snapshot = save?.snapshot;
    if (chapters.some((ch) => path === `${ch.dir}/chapter.json`)) {
      // Raw physical facts survive even when causal saver attribution fails.
      hand.landed.push({ ...write.started, version: JSON.parse(text).typesetting?.version ?? null });
    }
    if (!snapshot || text !== (path === snapshot.chapterPath ? snapshot.chapter : snapshot.text)) return;
    save.physicalReceipts ??= [];
    save.physicalReceipts.push({ order: ++state.nextObservation, at: Date.now(), path, bytes: text,
      saverSerial: save.serial, refToken: save.refToken });
    if (path === snapshot.textPath && snapshot.text === text &&
        fsx._tree.files.get(snapshot.chapterPath) === snapshot.chapter &&
        fsx._tree.files.get(snapshot.textPath) === snapshot.text) {
      save.bothFileReceipt = { order: ++state.nextObservation, at: Date.now(), saverSerial: save.serial, refToken: save.refToken,
        chapterPath: snapshot.chapterPath, textPath: snapshot.textPath, chapter: snapshot.chapter, text };
    }
  };

  // Literal fixture geometry, not a fixture produced by this implementation's
  // fit/save path: browser line boxes are 22px plus4px padding (26/48/70).
  // The second file is independently numbered2 with ample 500px boxes.
  const raw = JSON.parse(onDisk());
  raw.mode = 'typeset';
  raw.pages[0] = { ...raw.pages[0], w: 800, h: 1200, lines: LINES(), detect: null, boxes: BOXES().map((b, i) => ({ ...b, h: [26, 70, 26, 48][i] })) };
  raw.pages[1] = { ...raw.pages[0], id: 2, file: 'b.png', lines: [{ n: 2, jp: 'BB', en: 'BB', tags: [] }], boxes: [box('second', 'AnimeAce', 'SECOND', 200, 100)] };
  raw.pages[1].boxes[0].h = 26;
  raw.typesetting = { mode: 'smart', version: 1 };
  raw.pages = raw.pages.slice(0, 2);
  V1 = JSON.stringify(raw);
  const kept = JSON.parse(V1);
  kept.typesetting.version = 2;
  for (const pg of kept.pages) for (const b of pg.boxes) b.h = 500;
  kept.pages[0].boxes[0].text = 'AB';
  V2 = JSON.stringify(kept);
  resetFiles();
});

afterAll(async () => {
  resetHand();
  fsx._before = null;
  fsx._after = null;
  closeChapter();
  _resetEngineSwitch();
  _setEngineSwitchDeps(null);
  watchUserFaces(null);
  for (const f of [...app.fonts.user]) await until(removeUserFont(f.name));
  app.fonts.system = original.system;
  setTextEngine(original.engine);
  setTypesetEnabled(original.typeset);
  clearLayoutMemo();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  state.transition++;
  resetFiles();
});
afterEach(cleanupModel);

// ---------- the events ----------
// Each is something that happens to the app from outside it. One that cannot
// happen in the state it finds (Keep with no chapter open) does nothing.
class Broken extends Error {}
class DeferredBrowser extends Error {
  constructor(witness) { super(witness.reason); this.witness = witness; }
}
// What the sequences did, over a whole run.
const stageCounts = () => ({ eventsByStage: { closed: {}, rustOrStarting: {}, crossSwitchDebt: {}, browserAfterDebt: {} }, inapplicablePublicActions: {} });
const seen = { sequences: 0, writes: 0, failed: 0, keeps: 0, asOpened: 0, asDocument: 0, left: 0, browserDeferred: 0, inapplicablePublicActions: 0, generatedStages: stageCounts(), completedInvariantOrders: 0, exactBrowserWitnessOrders: 0, staleBrowserFinalWitnessOrders: 0, forcedExitWitnessOrders: 0, unknownFailedOrders: 0, generatedEvents: 0, executedEvents: 0, unexecutedTailEvents: 0 };
const classifiedWitnesses = [];
const classifiedUnknowns = [];
const state = { open: false, opened: null, openedText: null, openedRef: null, openedWrites: 0, touched: false, keep: null, choices: new Map(), rustChapters: new Set(), rustDebt: new Set(), transition: 0, pending: new Set(), finalWindows: [], event: null, witnesses: [], savers: [], timers: new Map(), nextObservation: 0, retirements: new Map(), browserSettlements: new Map(), baselineReceipts: [], failedWriters: [], publicRequests: [] };
// Object identity is observed without serializing live refs or cyclic contexts.
const refTokens = new WeakMap();
let nextRefToken = 0;
function refToken(ref) {
  if (!ref) return null;
  if (!refTokens.has(ref)) refTokens.set(ref, ++nextRefToken);
  return refTokens.get(ref);
}
saverObserver.boundary = (where) => {
  const window = state.finalWindows.findLast((window) => window.pending && window.kind === 'leave' && !window.publicRequest && window.ref === app.chapterRef) ?? finalWindow('leave');
  const request = { kind: 'leave', generation: window?.generation ?? state.transition, serial: ++state.nextObservation, where, ref: app.chapterRef, refToken: refToken(app.chapterRef),
    at: Date.now(), pending: true, emissions: [] };
  if (window) { window.publicRequest = request; request.window = window; }
  state.publicRequests.push(request);
  return request;
};
saverObserver.openBoundary = (projectId, chapterId) => {
  const window = state.finalWindows.findLast((window) => window.pending && window.kind === 'open' && !window.publicRequest &&
    window.ref === app.chapterRef && window.generation === state.transition && window.targetId === chapterId);
  const request = { kind: 'open', serial: ++state.nextObservation, ref: app.chapterRef, refToken: refToken(app.chapterRef),
    projectId, chapterId, generation: state.transition, at: Date.now(), pending: true, emissions: [] };
  if (window) { window.publicRequest = request; request.window = window; }
  state.publicRequests.push(request);
  return request;
};
saverObserver.reply = (request, answer, error) => {
  if (!request) return;
  request.pending = false; request.answer = answer; request.replyAt = Date.now(); request.replyOrder = ++state.nextObservation;
  if (request.window) { request.window.pending = false; request.window.answer = answer; }
  request.rejected = error ? String(error.message ?? error) : null;
};
saverObserver.openReply = (request, error) => {
  if (!request) return;
  Object.assign(request, { pending: false, fulfilled: !error, rejected: error ? String(error.message ?? error) : null,
    replyAt: Date.now(), replyOrder: ++state.nextObservation, incomingRef: app.chapterRef, incomingRefToken: refToken(app.chapterRef),
    changedRef: app.chapterRef !== request.ref, loaded: app.loaded,
    targetMatches: app.chapterRef?.projectId === request.projectId && app.chapterRef?.chapterId === request.chapterId,
    generationMatches: request.generation === state.transition });
  if (request.window) { request.window.pending = false; request.window.fulfilled = request.fulfilled; }
};
saverObserver.toast = (request, message) => {
  if (request) request.emissions.push({ message, seq: app.toast.seq, at: Date.now(), order: ++state.nextObservation, currentIdentity: app.chapterRef === request.ref });
};
saverObserver.begin = () => {
  const context = saverObserver.scope?.getStore();
  const active = context?.pending && context.ref === app.chapterRef;
  const receipt = { serial: ++state.nextObservation, ref: app.chapterRef, refToken: refToken(app.chapterRef),
    publicRequestSerial: null, observedPublicContextSerial: context?.serial ?? null,
    observedPublicContextPending: context?.pending ?? false, observedPublicContextRefToken: context?.refToken ?? null, observedPublicContextGeneration: context?.generation ?? null,
    contextDisposition: !context ? 'missing' : !context.pending ? 'expired' : context.ref !== app.chapterRef ? 'ref-mismatch' : 'active',
    chapterId: app.chapterRef?.chapterId, event: state.event, at: Date.now(), pending: true,
    browser: engineSwitch.phase === 'off' && textEngine()?.id === 'browser', snapshot: null };
  const window = context?.window;
  if (active && window?.pending && window.ref === receipt.ref && window.publicRequest === context &&
      window.generation === context.generation && context.generation === state.transition) {
    receipt.publicRequestSerial = context.serial;
    window.saverSerials ??= [];
    window.saverSerials.push(receipt.serial);
    if (window.saverSerials.length === 1) { receipt.window = window; window.saver = receipt; }
    else {
      // Multiple actual invocations are retained but cannot claim one final.
      window.attributionAmbiguous = true;
      receipt.contextDisposition = 'multiple-invocations';
    }
  } else if (active) receipt.contextDisposition = window && context.generation !== state.transition ? 'generation-mismatch' : 'no-active-window';
  state.savers.push(receipt);
  return receipt;
};
function canAdoptOpen(request, target, generation) {
  return request?.kind === 'open' && request.fulfilled === true && request.changedRef && request.loaded && request.targetMatches &&
    request.generationMatches && request.generation === generation && generation === state.transition &&
    app.loaded && app.chapterRef === request.incomingRef && app.chapterRef?.projectId === p.id && app.chapterRef?.chapterId === target.id;
}
saverObserver.finish = (receipt, error) => {
  if (!receipt) return;
  receipt.pending = false;
  receipt.finishedAt = Date.now(); receipt.finishOrder = ++state.nextObservation;
  receipt.failed = error ? String(error.message ?? error) : null;
};
const relevantTimers = (ref = app.chapterRef) => [...state.timers.values()].filter((timer) => timer.pending && timer.relevant && timer.ref === ref);
const pendingSavers = (ref = app.chapterRef) => state.savers.filter((save) => save.pending && save.ref === ref);
const pendingOwnedFinals = (ref = app.chapterRef) => state.finalWindows.filter((window) => window.pending && window.ref === ref && (window.debtAtRequest || !window.browserAtRequest || window.acquiredRust));
function settlementReceipt() {
  if (!live() || state.pending.size || state.publicRequests.some((request) => request.pending) || state.savers.some((save) => save.pending) || pendingOwnedFinals().length ||
      relevantTimers().length || hand.writes.length || firstFitChanges()?.keeping || !app.saved || app.saveFailed) return null;
  const rec = JSON.parse(onDisk());
  const current = documentNow();
  // Browser opening can reflow an untouched document without owning a write.
  // Its literal opened receipt remains valid only for that exact ref/cycle,
  // with no later physical write and no lost identity or historical intent.
  const identity = (pages) => pages.map(({ id, file, cleaned }) => ({ id, file, cleaned }));
  if (rec.id !== c.id || app.chapterRef.projectId !== p.id || canon(identity(rec.pages)) !== canon(identity(current)) ||
      rec.mode !== app.chapterMode || rec.typesetting?.mode !== app.typesetting.mode ||
      rec.typesetting?.version !== app.typesetting.version) return null;
  const currentDocument = canon(rec.pages) === canon(current) && textOnDisk() === buildTextJson(app.pages);
  const untouchedOpened = engineSwitch.phase === 'off' && textEngine()?.id === 'browser' && !state.touched &&
    state.openedRef === app.chapterRef && onDisk() === state.opened && textOnDisk() === state.openedText &&
    hand.began.length === state.openedWrites;
  if (!currentDocument && !untouchedOpened) return null;
  try { for (const chapter of chapters) choicesOnDisk(chapter, 'settlement receipt retains every historical choice'); }
  catch (error) { if (error instanceof Broken) return null; throw error; }
  return { kind: currentDocument ? 'current-document' : 'untouched-opened', chapterId: c.id, ref: app.chapterRef,
    chapter: onDisk(), text: textOnDisk(), writes: hand.began.length, at: Date.now(), event: state.event };
}
const live = () => state.open && app.loaded && app.chapterRef?.chapterId === c.id;
const copy = (v) => JSON.parse(JSON.stringify(v));
const paths = (ch) => ({ chapter: `${ch.dir}/chapter.json`, text: `${ch.dir}/translations.json` });
function adopt(ch) {
  c = ch;
  ({ chapter: chapterPath, text: translationsPath } = paths(ch));
}
function resetFiles() {
  state.choices.clear();
  state.savers = [];
  state.retirements.clear();
  state.browserSettlements.clear();
  state.openedRef = null;
  state.baselineReceipts = [];
  state.failedWriters = [];
  state.publicRequests = [];
  state.rustChapters.clear();
  state.rustDebt.clear();
  for (const [i, ch] of chapters.entries()) {
    const raw = JSON.parse(i === 1 ? V2 : V1);
    raw.id = ch.id;
    raw.number = i + 1;
    if (i === 2) for (const pg of raw.pages) pg.boxes = [];
    const path = paths(ch);
    fsx._tree.files.set(path.chapter, JSON.stringify(raw));
    fsx._tree.files.set(path.text, buildTextJson(raw.pages));
  }
  adopt(chapters[0]);
}
// Retained before any automatic fit/restoration. These are user choices, not
// values copied from whatever memory remains after an operation under test.
function choose(kind, value, pg = app.pages[0], b = pg?.boxes[0], ln = pg?.lines[0]) {
  const id = app.chapterRef?.chapterId;
  if (!id) return;
  const choices = state.choices.get(id) ?? new Map();
  state.choices.set(id, choices);
  const key = ['order', 'mode', 'typesetting'].includes(kind) ? kind : `${kind}/${pg?.id}/${b?.id}/${ln?.n}`;
  const choice = { kind, value: copy(value), page: pg?.id, box: b?.id, line: ln?.n };
  choices.set(key, choice);
  for (const window of state.finalWindows) {
    if (window.ref === app.chapterRef && window.heldWriter && hand.writes.includes(window.heldWriter)) {
      window.laterChoices.set(key, { choice: copy(choice), event: state.event, at: Date.now() });
    }
  }
}
function choicesIn(id, record, text, when, allowed = new Set(), checkDerived = true, expected = state.choices.get(id)) {
  for (const [key, want] of expected?.entries() ?? []) {
    if (allowed.has(key)) continue;
    const pg = record.pages.find((p) => p.id === want.page);
    const b = pg?.boxes.find((b) => b.id === want.box);
    const ln = pg?.lines.find((l) => l.n === want.line);
    const tp = text?.pages.find((p) => p.page === want.page);
    const extraIndex = pg?.boxes.filter((b) => b.lineN == null).findIndex((b) => b.id === want.box);
    const extra = extraIndex >= 0 ? tp?.extraBoxes[extraIndex] : null;
    const got = {
      text: b?.text, height: b?.h, style: b?.style?.color, fit: b?.fit,
      file: pg?.file, cleaned: pg?.cleaned ?? null,
      translation: ln?.en, order: record.pages.map((p) => p.id),
      mode: record.mode, typesetting: record.typesetting?.mode,
    }[want.kind];
    const okay = want.kind === 'height' ? got >= want.value : canon(got) === canon(want.value);
    const second = want.kind === 'translation' ? tp?.lines.find((l) => l.n === want.line)?.en
      : want.kind === 'text' ? extra?.text
      : want.kind === 'height' ? extra?.h
      : want.kind === 'order' ? text?.pages.map((p) => p.page) : undefined;
    const secondOkay = second === undefined && !['translation', 'text', 'height', 'order'].includes(want.kind)
      ? true : want.kind === 'height' ? second >= want.value : canon(second) === canon(want.value);
    if (!okay || (checkDerived && !secondOkay)) throw new Broken(`${when}: user ${want.kind} choice ${canon(want.value)} was lost (chapter ${id}; chapter.json ${canon(got)}; translations.json ${canon(second)})`);
  }
}
function choicesLive(when) {
  if (!live()) return;
  // Live page.cleaned is a minted image URL; documentNow explicitly reads
  // cleanedFile as the durable name. Disk records already store that name
  // in cleaned. Neither representation may borrow the other's fallback.
  choicesIn(c.id, { pages: documentNow(), mode: app.chapterMode, typesetting: app.typesetting }, JSON.parse(buildTextJson(app.pages)), when);
}
function choicesOnDisk(ch, when) {
  const path = paths(ch);
  choicesIn(ch.id, JSON.parse(fsx._tree.files.get(path.chapter)), JSON.parse(fsx._tree.files.get(path.text)), when);
}

function finalWindow(kind) {
  if (!live()) return null;
  const window = {
    kind, chapter: c, ref: app.chapterRef, refToken: refToken(app.chapterRef), generation: state.transition, at: Date.now(), event: state.event, pending: true,
    cleanAtRequest: !state.pending.size && !state.publicRequests.some((request) => request.pending) && !state.finalWindows.some((window) => window.pending) && !pendingSavers().length && !hand.writes.length && !firstFitChanges()?.keeping,
    retirement: state.retirements.get(c.id), saver: null, answer: null,
    browserAtRequest: engineSwitch.phase === 'off' && textEngine()?.id === 'browser',
    debtAtRequest: state.rustDebt.has(c.id), acquiredRust: false,
    snapshot: null, heldWriter: null, laterChoices: new Map(), timer: null, counted: false,
  };
  state.finalWindows.push(window);
  return window;
}

// Physical writes belong to the exact still-pending invocation. A chapter
// snapshot must begin on its captured ref; its translations may finish after
// adoption, with that original snapshot/path rather than the new live ref.
function invocationAt(path) {
  const save = saverObserver.invocationScope?.getStore();
  if (!save?.pending || !state.savers.includes(save)) return null;
  const ch = chapters.find((chapter) => chapter.id === save.chapterId);
  if (!ch) return null;
  const p = paths(ch);
  if (path !== p.chapter && path !== p.text) return null;
  if (!save.snapshot && (path !== p.chapter || save.ref !== app.chapterRef)) return null;
  return save;
}
function finalSnapshot(path, text, writer = null) {
  const save = invocationAt(path);
  if (!save) return;
  if (writer) Object.assign(writer, { saverSerial: save.serial, ref: save.ref, refToken: save.refToken });
  const p = paths(chapters.find((chapter) => chapter.id === save.chapterId));
  if (path === p.chapter && !save.snapshot) {
    Object.assign(hand.began.at(-1), { ref: save.ref, refToken: save.refToken, saverSerial: save.serial });
    save.snapshot = { chapter: text, text: null, chapterPath: p.chapter, textPath: p.text,
      writeIndex: hand.began.length - 1, saverSerial: save.serial, refToken: save.refToken,
      earlierChoices: copy([...state.choices.get(save.chapterId) ?? []]),
      startedBrowser: save.browser, debtAtSnapshot: state.rustDebt.has(save.chapterId), at: Date.now() };
  }
  if (!save.snapshot) return;
  if (path === p.text && save.snapshot.text == null) save.snapshot.text = text;
  if (save.window && !save.window.attributionAmbiguous) {
    save.window.snapshot = save.snapshot;
    if (writer) save.window.heldWriter = writer;
  }
}
function earlierChoicesPresent(window, chapter, text) {
  if (!window.snapshot?.earlierChoices) return false;
  try {
    choicesIn(window.chapter.id, JSON.parse(chapter), JSON.parse(text), 'actual snapshot retains every earlier independent choice',
      new Set(), true, new Map(window.snapshot.earlierChoices));
    return true;
  } catch (error) { if (error instanceof Broken) return false; throw error; }
}

function observedBrowserCancellation(window, ch) {
  if (!window || window.attributionAmbiguous || window.chapter.id !== ch.id || !window.browserAtRequest || window.debtAtRequest || window.acquiredRust ||
      !window.snapshot?.startedBrowser || window.snapshot.debtAtSnapshot || !window.heldWriter || !window.laterChoices.size ||
      !window.timer?.cancelledByMarkSaved || !window.timer.bothFilesAtCancellation || !window.timer.unsavedWhenArmed ||
      window.timer.clearerSource !== 'markSaved' || !window.timer.saverContextPending || window.timer.saverSerial !== window.snapshot.saverSerial || window.timer.saverRefToken !== window.refToken ||
      window.timer.cancelledAt < window.timer.at || window.timer.cancelledAt - window.timer.at >= DOC_SAVE_MS) return null;
  const p = paths(ch);
  const chapter = fsx._tree.files.get(p.chapter);
  const text = fsx._tree.files.get(p.text);
  if (chapter !== window.snapshot.chapter || text !== window.snapshot.text || JSON.parse(chapter).typesetting?.version !== 1 ||
      !earlierChoicesPresent(window, chapter, text)) return null;
  const allowed = new Set();
  for (const [key, late] of window.laterChoices) {
    // An unrelated subsequent user choice cannot inherit this exemption.
    if (canon(state.choices.get(ch.id)?.get(key)) !== canon(late.choice)) return null;
    allowed.add(key);
  }
  const rec = JSON.parse(chapter);
  const tx = JSON.parse(text);
  try { choicesIn(ch.id, rec, tx, 'known browser cancellation must actually lose a retained later choice'); }
  catch (error) {
    if (!(error instanceof Broken)) throw error;
    choicesIn(ch.id, rec, tx, 'all earlier/unrelated choices remain mandatory', allowed);
    return { category: 'exact-browser-cancellation', chapterId: ch.id, kind: window.kind, requestEvent: window.event,
      reason: error.message, startedBrowser: true, acquiredRust: false,
      snapshot: window.snapshot, physical: { chapter, text },
      laterChoices: [...window.laterChoices.entries()], timer: window.timer };
  }
  return null;
}

function observedBrowserStaleFinal(window, ch) {
  if (!window || window.attributionAmbiguous || window.kind !== 'leave' || window.ref !== app.chapterRef || window.publicRequest?.answer !== true || window.chapter.id !== ch.id || !window.browserAtRequest || window.debtAtRequest || window.acquiredRust ||
      !window.retirement || window.retirement.ref !== window.ref || !window.saver || !window.cleanAtRequest ||
      window.answer !== true || window.saver.pending || window.saver.failed || !window.snapshot?.startedBrowser ||
      window.snapshot.debtAtSnapshot || !window.laterChoices.size || window.timer?.cancelledByMarkSaved ||
      window.timer?.firedAt == null || window.timer.firedAt - window.timer.at < DOC_SAVE_MS ||
      app.saved || app.saveFailed || pendingOwnedFinals(window.ref).length || state.rustDebt.has(ch.id) || engineSwitch.mode === 'rust') return null;
  const p = paths(ch);
  const chapter = fsx._tree.files.get(p.chapter), text = fsx._tree.files.get(p.text);
  if (chapter !== window.snapshot.chapter || text !== window.snapshot.text || !earlierChoicesPresent(window, chapter, text)) return null;
  const newer = state.savers.filter((save) => save.pending && save.ref === window.ref && save.serial > window.saver.serial);
  if (newer.length !== 1 || !newer[0].browser || !newer[0].snapshot ||
      !hand.writes.some((writer) => writer.ref === window.ref && writer.path === p.chapter && writer.bytes === newer[0].snapshot.chapter)) return null;
  const allowed = new Set();
  for (const [key, late] of window.laterChoices) {
    if (canon(state.choices.get(ch.id)?.get(key)) !== canon(late.choice)) return null;
    allowed.add(key);
  }
  const next = JSON.parse(newer[0].snapshot.chapter);
  // Actual queued chapter bytes contain the independent choices. Its derived
  // file has not started yet; this witness never claims that it has landed.
  try { choicesIn(ch.id, next, null, 'newer actual queued chapter contains every retained choice', new Set(), false); }
  catch (error) { if (error instanceof Broken) return null; throw error; }
  try { choicesIn(ch.id, JSON.parse(chapter), JSON.parse(text), 'known stale browser final must lose a retained later choice'); }
  catch (error) {
    if (!(error instanceof Broken)) throw error;
    choicesIn(ch.id, JSON.parse(chapter), JSON.parse(text), 'earlier/unrelated choices remain mandatory', allowed);
    const { ref, ...retirement } = window.retirement;
    return { category: 'exact-browser-stale-final', chapterId: ch.id, kind: window.kind,
      reason: error.message, requestEvent: window.event, answer: window.answer, retirement,
      snapshot: window.snapshot, physical: { chapter, text }, laterChoices: [...window.laterChoices],
      timer: window.timer, newerSaverSerial: newer[0].serial, newerActualChapter: newer[0].snapshot.chapter,
      newerDerivedFileNotYetObserved: true, acquiredRust: false };
  }
  return null;
}

function observedForcedExit(window, ch) {
  const request = window?.publicRequest;
  const force = request?.emissions.find((emission) => emission.currentIdentity &&
    emission.message === 'Left the editor. The last edits to this chapter were never written to disk.');
  if (!window || window.attributionAmbiguous || window.kind !== 'leave' || window.chapter.id !== ch.id || window.answer !== true ||
      window.ref !== app.chapterRef || request?.answer !== true || request.where !== 'editor' || !force ||
      force.order < request.serial || force.order > request.replyOrder) return null;
  const prior = state.finalWindows.findLast((old) => old !== window && old.ref === window.ref && old.publicRequest?.answer === false &&
    old.publicRequest.replyOrder < request.replyOrder && old.publicRequest.emissions.some((emission) => emission.currentIdentity &&
      emission.message.startsWith('Could not save: staying in the editor.')));
  if (!prior) return null;
  const failures = state.savers.filter((save) => save.ref === window.ref && save.failed === 'disk full' &&
    [prior.publicRequest.serial, request.serial].includes(save.publicRequestSerial));
  if (failures.length !== 2 || failures[0].publicRequestSerial !== prior.publicRequest.serial ||
      failures[1].publicRequestSerial !== request.serial || failures[0].finishOrder >= failures[1].finishOrder || !failures.every((save) => state.failedWriters.some((writer) =>
        writer.ref === window.ref && writer.saverSerial === save.serial)) || state.savers.some((save) => save.ref === window.ref &&
        save.bothFileReceipt?.order > failures[0].finishOrder && save.bothFileReceipt.order < failures[1].finishOrder) ||
      state.publicRequests.some((reply) => reply.ref === window.ref && reply.answer === true &&
        reply.replyOrder > failures[0].finishOrder && reply.replyOrder < force.order)) return null;
  choicesLive('forced exit preserves all intent in memory');
  try { choicesOnDisk(ch, 'force is not a durable successful exit'); }
  catch (error) {
    if (!(error instanceof Broken)) throw error;
    return { category: 'explicit-forced-exit', chapterId: ch.id, kind: window.kind, reason: error.message,
      requestEvent: window.event, publicRequestSerial: request.serial, answer: true, forceEmission: force,
      priorRefusal: { publicRequestSerial: prior.publicRequest.serial, answer: false, emissions: prior.publicRequest.emissions, at: prior.publicRequest.replyAt },
      failedSavers: failures.map(({ serial, publicRequestSerial, event, at, finishedAt, finishOrder, failed, snapshot }) => ({ serial, publicRequestSerial, event, at, finishedAt, finishOrder, failed, snapshot })),
      injectedWriters: state.failedWriters.filter((writer) => failures.some((save) => save.serial === writer.saverSerial)).map(({ ref, ...writer }) => writer),
      retainedChoices: [...state.choices.get(ch.id)], rustDebtRetained: state.rustDebt.has(ch.id),
      physical: { chapter: fsx._tree.files.get(paths(ch).chapter), text: fsx._tree.files.get(paths(ch).text) } };
  }
  return null;
}

function deferObservedBoundary(window, ch) {
  const witness = observedForcedExit(window, ch) ?? observedBrowserCancellation(window, ch) ?? observedBrowserStaleFinal(window, ch);
  if (!witness) return false;
  // A current boundary cannot hide a loss on another historical chapter.
  try { for (const other of chapters) if (other.id !== ch.id) choicesOnDisk(other, 'unrelated chapter before a classified prefix'); }
  catch (error) { if (error instanceof Broken) return false; throw error; }
  if (!window.counted) { window.counted = true; state.witnesses.push(witness); }
  // A fully proven counterexample ends this order. Historical intent is not
  // quarantined, and no later Rust stage inherits a broad browser exemption.
  throw new DeferredBrowser(witness);
}
// A prior Rust turn is not ownership forever. Retirement requires actual
// current bytes in BOTH files (or the permitted untouched opened bytes), no
// held writer, and no outstanding unsaved choice. A false saved flag alone
// cannot retire debt over stale physical bytes.
function retireBrowserDebt() {
  if (engineSwitch.phase !== 'off' || textEngine()?.id !== 'browser') return;
  const receipt = settlementReceipt();
  if (!receipt) return;
  const retiredRustDebt = state.rustDebt.has(c.id);
  // A quiet browser receipt is not necessarily prior Rust debt retirement.
  state.browserSettlements.set(c.id, { ...receipt, retiredRustDebt });
  if (retiredRustDebt) state.retirements.set(c.id, receipt);
  state.rustDebt.delete(c.id);
}

function checkFile(when, window = null) {
  if (deferObservedBoundary(window, c)) return;
  const bytes = onDisk();
  const rec = JSON.parse(bytes);
  const chapterAsOpened = bytes === state.opened;
  const textAsOpened = textOnDisk() === state.openedText;
  const asOpened = chapterAsOpened && textAsOpened && !state.touched;
  const same = canon(rec.pages) === canon(documentNow()) && rec.mode === app.chapterMode && rec.typesetting?.mode === app.typesetting.mode && textOnDisk() === buildTextJson(app.pages);
  const inMotion = waiting();
  const version = rec.typesetting?.version;
  const say = (what) => new Broken(`${when}: ${what} (file version ${version}; chapter bytes ${chapterAsOpened ? 'as opened' : 'changed'}; translation bytes ${textAsOpened ? 'as opened' : 'changed'}; ${state.touched ? 'touched' : 'untouched'}; app.saved ${app.saved}; ${rustFitting() ? 'Rust measuring' : `switch ${engineSwitch.phase}`}${inMotion ? '; a box still waiting' : ''})\n  serialized chapter.json: ${bytes}\n  serialized translations.json: ${textOnDisk()}\n  retained user choices: ${JSON.stringify([...state.choices.get(c.id)?.values() ?? []])}`);
  seen[asOpened ? 'asOpened' : 'asDocument']++;
  if (!state.touched && (JSON.parse(state.opened).typesetting?.version ?? 1) < 2 && engineSwitch.mode === 'rust' && (!asOpened || hand.began.length !== state.openedWrites)) throw say('an untouched, unkept chapter was written: both document files and the write count must stay as opened');
  choicesOnDisk(c, when);
  if (asOpened) return;
  if (!same) throw say('the file is neither the file that was opened nor the document in memory');
  // (b): what its number may be. At rest under the Rust engine every box is
  // fitted, so it is 2. A snapshot actually written under the browser says1;
  // merely switching off does not rewrite an already saved Rust file.
  if (inMotion) return;
  if (rustFitting() && version !== 2) throw say('the file is the document, every box is fitted by the Rust engine, and the file does not say 2');
  if (engineSwitch.phase === 'off' && hand.landed.findLast((w) => w.path === chapterPath)?.browser && version !== 1) throw say('a landed browser snapshot does not say 1');
}

async function leave() {
  if (!state.open) return;
  const went = await until(flushBeforeLeaving('editor'));
  if (went !== true) throw new Broken('leaving: the flush did not let the user go');
  await pass(0);
  checkFile('after leaving');
  seen.left++;
  closeChapter();
  state.open = false;
  state.keep = null;
  await pass(0);
}

async function open(bytes) {
  await leave();
  resetSaveFailures();
  app.saveFailed = false;
  fsx._tree.files.set(chapterPath, bytes);
  fsx._tree.files.set(translationsPath, buildTextJson(JSON.parse(bytes).pages));
  await until(openChapter(p.id, c.id));
  state.open = true;
  state.opened = bytes;
  state.openedRef = app.chapterRef;
  state.openedText = textOnDisk();
  state.openedWrites = hand.began.length;
  state.touched = false;
  state.keep = null;
  if (engineSwitch.mode === 'rust') { state.rustChapters.add(c.id); state.rustDebt.add(c.id); }
}

// Real library transitions can wait behind a held write. Request them without
// draining it; subsequent writeLands/writeFails/time events decide their order.
async function requestOpen(index) {
  const target = chapters[index];
  const outgoing = live() ? c : null;
  const window = finalWindow('open');
  const generation = ++state.transition;
  if (window) { window.generation = generation; window.targetId = target.id; }
  const held = hand.hold || hand.holdTranslations || hand.writes.length > 0;
  const request = openChapter(p.id, target.id);
  const operation = state.publicRequests.at(-1);
  state.pending.add(request);
  state.lastOpen = request;
  request.then(() => {
    if (window) { window.pending = false; window.fulfilled = operation?.fulfilled; window.replyAt = Date.now(); window.toast = app.toast.msg; }
    if (!canAdoptOpen(operation, target, generation)) return;
    if (outgoing && !deferObservedBoundary(window, outgoing)) choicesOnDisk(outgoing, 'after opening a chapter');
    adopt(target);
    state.open = true;
    state.opened = onDisk();
    state.openedRef = app.chapterRef;
    state.openedText = textOnDisk();
    state.openedWrites = hand.began.length;
    // Historical user choices remain mandatory, but opening their already
    // saved bytes starts a fresh untouched first-fit cycle.
    state.touched = false;
    state.keep = null;
    if (engineSwitch.mode === 'rust') { state.rustChapters.add(c.id); state.rustDebt.add(c.id); }
  }).catch((error) => {
    if (window) { window.pending = false; window.rejected = String(error.message ?? error); }
    if (error instanceof DeferredBrowser) state.deferred = error.witness;
    else if (error instanceof Broken) hand.broke ??= error.message;
    // A failed leave-save makes the actual open refuse; the old document stays.
    else if (!app.saveFailed) hand.broke ??= `opening: ${error.message}`;
  }).finally(() => state.pending.delete(request));
  await pass(0);
  if (!held) await until(request).catch(() => {});
}
async function requestLeave() {
  if (!live()) return;
  const ref = app.chapterRef;
  const window = finalWindow('leave');
  const held = hand.hold || hand.holdTranslations || hand.writes.length > 0;
  const request = flushBeforeLeaving('editor');
  state.pending.add(request);
  request.then((went) => {
    window.pending = false; window.answer = went; window.replyAt = Date.now(); window.toast = app.toast.msg;
    if (!went || app.chapterRef !== ref) return;
    checkFile('after leaving', window);
    seen.left++;
    closeChapter();
    state.open = false;
    state.keep = null;
  }).catch((error) => {
    window.pending = false;
    if (error instanceof DeferredBrowser) state.deferred = error.witness;
    else hand.broke ??= `leaving: ${error.message}`;
  }).finally(() => state.pending.delete(request));
  await pass(0);
  if (!held) await until(request).catch(() => {});
}

const EVENTS = {
  open1: () => requestOpen(0),
  open2: () => requestOpen(1),
  openEmpty: () => requestOpen(2),
  leave: requestLeave,
  // An edit whose fit runs at once (a font the engine has), one whose fit is
  // held while its font is on its way, and one that fits nothing: a line of
  // the queue that is not placed.
  edit() {
    if (!live()) return;
    const b = app.pages[0].boxes[0];
    if (!b) return;
    b.text = `${b.text} AA`;
    choose('text', b.text, app.pages[0], b);
    autoFitBox(b, app.pages[0]);
    markUnsaved();
    state.touched = true;
  },
  editLate() {
    if (!live()) return;
    const pg = app.pages.find((pg) => pg.id === 1);
    const b = pg?.boxes[3];
    if (!b) return;
    b.text = `${b.text} CC`;
    choose('text', b.text, pg, b);
    autoFitBox(b, pg);
    markUnsaved();
    state.touched = true;
  },
  reversePages() {
    if (!live()) return;
    // Public art/order rewrites require a closed chapter. The open-editor raw
    // robustness stage is relevant only while Rust owns actual save debt.
    if (engineSwitch.phase === 'off' && !state.rustDebt.has(c.id)) { seen.inapplicablePublicActions++; return; }
    app.pages.reverse();
    choose('order', app.pages.map((p) => p.id));
    state.touched = true;
    relayoutAll();
  },
  unmarkedHandle() {
    if (!live()) return;
    if (!app.pages[0].boxes[0]) return;
    app.pages[0].boxes[0].h += 7;
    choose('height', app.pages[0].boxes[0].h);
    state.touched = true;
    relayoutAll();
    // TextBox's completed resize marks the chosen geometry (the held raw
    // probes do not call this generated completion stage).
    if (engineSwitch.phase === 'off') markUnsaved();
  },
  async unmarkedMode() {
    if (!live()) return;
    app.chapterMode = app.chapterMode === 'translate' ? 'typeset' : 'translate';
    choose('mode', app.chapterMode);
    state.touched = true;
    if (engineSwitch.phase === 'off') await setChapterMode(p.id, c.id, app.chapterMode);
    else relayoutAll();
  },
  holdTranslations() { hand.holdTranslations = true; },
  editLine() {
    if (!live()) return;
    const pg = app.pages[0];
    const ln = pg.lines[0];
    const intended = `${ln.en}A`;
    choose('translation', intended, pg, pg.boxes[0], ln);
    setLineText(pg, ln.n, intended);
    state.touched = true;
  },
  fontLands() {
    for (const f of hand.fonts.splice(0)) f();
  },
  debounce: () => pass(DOC_SAVE_MS),
  wait: () => pass(KEEP_WAIT_MS),
  holdWrites() {
    hand.hold = true;
  },
  writeLands() {
    const w = hand.writes.shift();
    if (w) w.ok();
    else hand.hold = false;
  },
  writeFails() {
    const w = hand.writes.shift();
    if (w) { seen.failed++; state.failedWriters.push({ order: ++state.nextObservation, ref: w.ref, saverSerial: w.saverSerial, path: w.path, bytes: w.bytes, at: Date.now() }); }
    w?.fail(new Error('disk full'));
  },
  keep() {
    const changes = firstFitChanges();
    if (!live() || !changes || changes.kept) return;
    // Whether this Keep is all that asks for a write: nothing of the user's
    // is unsaved when it is pressed.
    if (!state.keep) state.keep = { alone: !state.touched && app.saved, began: hand.began.length, at: Date.now(), waited: waiting() };
    state.touched = true;
    seen.keeps++;
    const request = keepFirstFit();
    state.pending.add(request);
    request.catch(() => {}).finally(() => state.pending.delete(request));
  },
  async switchOff() {
    await until(useTextEngine('browser'));
    if (state.keep) state.keep.alone = false;
  },
  // The real switch: no write release, forced save or ledger re-baseline.
  // Rust must acquire whatever browser snapshot is still in flight.
  async switchOn() {
    if (engineSwitch.mode === 'rust') return;
    if (live()) {
      const baseline = engineSwitch.phase === 'off' && textEngine()?.id === 'browser' ? settlementReceipt() : null;
      if (baseline) {
        state.baselineReceipts.push(baseline);
        state.opened = baseline.chapter; state.openedText = baseline.text; state.openedRef = baseline.ref;
        state.openedWrites = baseline.writes; state.touched = false; state.keep = null;
      }
      for (const window of state.finalWindows) if (window.ref === app.chapterRef) window.acquiredRust = true;
      state.rustChapters.add(c.id); state.rustDebt.add(c.id);
    }
    hand.startHeld = true;
    useTextEngine('rust').catch(() => {});
  },
  engineStarts() {
    hand.startHeld = false;
    for (const s of hand.starts.splice(0)) s();
  },
};
const UNMARKED = {
  text() { app.pages[0].boxes[0].text += ' UNMARKED'; choose('text', app.pages[0].boxes[0].text); },
  height() { app.pages[0].boxes[0].h += 7; choose('height', app.pages[0].boxes[0].h); },
  style() { app.pages[0].boxes[0].style.color = '#123456'; choose('style', '#123456'); },
  fit() { app.pages[0].boxes[0].fit = { kind: 'rect', x: 0, y: 0, w: 120, h: 80 }; choose('fit', app.pages[0].boxes[0].fit); },
  file() { app.pages[0].file = 'changed.png'; choose('file', 'changed.png'); },
  cleaned() { app.pages[0].cleanedFile = 'changed-cleaned.png'; choose('cleaned', 'changed-cleaned.png'); },
  translation() { app.pages[0].lines[0].en += ' UNMARKED'; choose('translation', app.pages[0].lines[0].en); },
  order() { app.pages.reverse(); choose('order', app.pages.map((p) => p.id)); },
  mode() { app.chapterMode = app.chapterMode === 'typeset' ? 'translate' : 'typeset'; choose('mode', app.chapterMode); },
  typesetting() { app.typesetting.mode = app.typesetting.mode === 'smart' ? 'plain' : 'smart'; choose('typesetting', app.typesetting.mode); },
};

for (const [field, change] of Object.entries(UNMARKED)) {
  EVENTS[`unmarked_${field}`] = async () => {
    if (!live() || !app.pages[0].boxes.length) return;
    if (engineSwitch.phase === 'off' && !state.rustDebt.has(c.id) && ['file', 'cleaned', 'order'].includes(field)) { seen.inapplicablePublicActions++; return; }
    change();
    state.touched = true;
    // Under Rust the old raw robustness action reaches its relayout boundary.
    // Under the browser a completed action uses its actual public API/gesture
    // completion. Raw probes below call change() directly with no completion.
    if (engineSwitch.phase !== 'off') relayoutAll();
    else if (['text', 'style', 'fit'].includes(field)) boxEdited(app.pages[0].boxes[0], app.pages[0]);
    else if (field === 'height') { resizeBox(app.pages[0].id, app.pages[0].boxes[0].id, { h: app.pages[0].boxes[0].h }); markUnsaved(); }
    else if (field === 'translation') setLineText(app.pages[0], app.pages[0].lines[0].n, app.pages[0].lines[0].en);
    else if (field === 'mode') await setChapterMode(p.id, c.id, app.chapterMode);
    else if (field === 'typesetting') {
      const intended = app.typesetting.mode;
      app.typesetting.mode = intended === 'smart' ? 'plain' : 'smart';
      setChapterTypesetMode(intended);
    }
    // A raw art/order mutation during outstanding cross-switch debt stays
    // raw. No completion mark or rescue is added to that wrong order.
  };
}
const TOUCHING = new Set(['edit', 'editLate', 'editLine', 'reversePages', 'unmarkedHandle', 'unmarkedMode', 'leave', 'open1', 'open2', 'openEmpty', 'switchOff', 'switchOn', 'writeFails', 'keep', ...Object.keys(UNMARKED).map((field) => `unmarked_${field}`)]);

// Everything comes to rest: the fonts land, the engine starts, the writes
// land, the clock runs past every debounce and every wait. A save that failed
// is tried again, as leaving tries it. No final flush repairs a lost debounce.
async function rest() {
  for (let i = 0; i < 14; i++) {
    hand.hold = false;
    hand.holdTranslations = false;
    hand.fontHeld = false;
    hand.startHeld = false;
    for (const w of hand.writes.splice(0)) w.ok();
    for (const f of hand.fonts.splice(0)) f();
    for (const s of hand.starts.splice(0)) s();
    await pass(1000);
    if (app.saveFailed && state.open) await until(flushSave()).catch(() => {});
  }
}

async function cleanupModel() {
  // Assertions have already run. Cleanup may drain/flush, but it cannot
  // make a failed sequence pass. Supersede pending opens before the next
  // sequence installs its literal fixture files.
  state.transition++;
  // Clear the outgoing identity before releasing held writers. A failed
  // stale-ledger probe against old source must not enter its microtask loop
  // while cleanup drains two competing final/Keep flushes.
  closeChapter();
  state.open = false;
  resetHand();
  await pass(0);
  for (const pending of [...state.pending]) await until(pending).catch(() => {});
  hand.fontHeld = false;
  await until(useTextEngine('browser'));
  resetHand();
  await pass(3000);
  resetSaveFailures();
  app.saveFailed = false;
  state.choices.clear();
  state.finalWindows = [];
  state.witnesses = [];
  state.timers.clear();
}

async function run(events) {
  resetHand();
  state.open = false;
  state.keep = null;
  state.deferred = null;
  state.finalWindows = [];
  state.witnesses = [];
  resetFiles();
  const stages = stageCounts();
  let at = '';
  let executed = 0;
  try {
    for (const [i, name] of events.entries()) {
      at = `step ${i + 1} (${name})`;
      state.event = name;
      const stage = !live() ? 'closed' : engineSwitch.mode === 'rust' ? 'rustOrStarting' : state.rustDebt.has(c.id) ? 'crossSwitchDebt' : 'browserAfterDebt';
      stages.eventsByStage[stage][name] = (stages.eventsByStage[stage][name] ?? 0) + 1;
      const ignoredBefore = seen.inapplicablePublicActions;
      if (state.keep && TOUCHING.has(name) && name !== 'keep') state.keep.alone = false;
      await EVENTS[name]();
      executed = i + 1;
      const ignored = seen.inapplicablePublicActions - ignoredBefore;
      if (ignored) stages.inapplicablePublicActions[name] = (stages.inapplicablePublicActions[name] ?? 0) + ignored;
      await pass(0);
      if (hand.broke) throw new Broken(hand.broke);
      if (state.deferred) throw new DeferredBrowser(state.deferred);
      retireBrowserDebt();
      choicesLive(`after ${name}`);
      if (hand.broke) throw new Broken(hand.broke);
    }
    at = 'coming to rest';
    await rest();
    if (hand.broke) throw new Broken(hand.broke);
    if (state.deferred) throw new DeferredBrowser(state.deferred);
    if (state.pending.size || state.publicRequests.some((request) => request.pending) || hand.writes.length || hand.fonts.length || hand.starts.length ||
        state.savers.some((save) => save.pending) || [...state.timers.values()].some((timer) => timer.pending && timer.relevant) ||
        firstFitChanges()?.keeping || engineSwitch.phase === 'starting' || waiting()) {
      throw new Broken('coming to rest: residual public transition, saver, writer, timer, font, engine start, or Keep');
    }
    retireBrowserDebt();
    if (hand.broke) throw new Broken(hand.broke);
    if (live()) {
      // No final rescue flush. The invariant belongs to Rust or actual save
      // debt it still owns. The old browser autosave race remains deferred; actual
      // leave/open boundaries still assert both files for every engine.
      if (state.rustDebt.has(c.id) || engineSwitch.mode === 'rust') checkFile('at rest');
      else seen.browserDeferred++;
      choicesLive('at rest');
      // Keep is one write: pressed over a chapter with nothing of the user's
      // unsaved, and with nothing but time, fonts and the disk happening
      // after, the file is written once. Once more only when the wait ran
      // out before the font came: what there was then, and the number when
      // the font did come.
      if (state.keep?.alone) {
        const wrote = hand.began.slice(state.keep.began);
        const late = wrote.length === 2 && wrote[0].at - state.keep.at >= KEEP_WAIT_MS && wrote[0].version === 1 && wrote[1].version === 2;
        if (wrote.length !== 1 && !late) throw new Broken(`Keep wrote the chapter ${wrote.length} times, at version ${wrote.map((w) => w.version).join(' then ')}; it is one write`);
      }
    }
    for (const ch of chapters) if (ch.id !== app.chapterRef?.chapterId) choicesOnDisk(ch, 'inactive chapter at rest');
    return null;
  } catch (e) {
    if (e instanceof DeferredBrowser) return { deferred: e.witness };
    if (!(e instanceof Broken)) throw new Error(`${at}: ${e?.stack ?? e}`);
    return `${e.message}`;
  } finally {
    state.lastRunStages = stages;
    const timerRecord = (timer) => timer && Object.fromEntries(Object.entries(timer).filter(([key]) => key !== 'id' && key !== 'ref'));
    state.lastRunProof = { fullOrder: [...events], executedPrefix: events.slice(0, executed), unexecutedTail: events.slice(executed),
      stages: copy(stages), windows: state.finalWindows.map((w) => ({ kind: w.kind, chapterId: w.chapter.id, refToken: w.refToken, generation: w.generation, targetId: w.targetId, fulfilled: w.fulfilled, saverSerials: w.saverSerials, attributionAmbiguous: w.attributionAmbiguous, browserAtRequest: w.browserAtRequest,
        currentIdentity: w.ref === app.chapterRef, debtAtRequest: w.debtAtRequest, acquiredRust: w.acquiredRust, pending: w.pending, cleanAtRequest: w.cleanAtRequest,
        publicRequest: w.publicRequest && (({ ref, incomingRef, originalPromise, window, ...request }) => request)(w.publicRequest), saverSerial: w.saver?.serial, replyAt: w.replyAt, retirement: w.retirement && (({ ref, ...receipt }) => receipt)(w.retirement), answer: w.answer, toast: w.toast, rejected: w.rejected, snapshot: w.snapshot,
        laterChoices: [...w.laterChoices], timer: timerRecord(w.timer) })), witnesses: copy(state.witnesses),
      publicRequests: state.publicRequests.map(({ ref, incomingRef, originalPromise, window, ...request }) => ({ ...request, currentIdentity: ref === app.chapterRef })),
      savers: state.savers.map(({ ref, originalPromise, window, ...save }) => ({ ...save, currentIdentity: ref === app.chapterRef })),
      timers: [...state.timers.values()].map(timerRecord),
      baselineReceipts: state.baselineReceipts.map(({ ref, ...receipt }) => receipt),
      browserSettlements: [...state.browserSettlements].map(([id, { ref, ...receipt }]) => [id, { ...receipt, currentIdentity: ref === app.chapterRef }]),
      facts: { chapterId: app.chapterRef?.chapterId, projectId: app.chapterRef?.projectId, modelChapterId: c?.id,
        liveDocument: copy(documentNow()), liveTranslations: buildTextJson(app.pages), typesetting: copy(app.typesetting),
        mode: app.chapterMode, engine: { mode: engineSwitch.mode, phase: engineSwitch.phase, id: textEngine()?.id },
        openedRefCurrent: state.openedRef === app.chapterRef, firstFit: firstFitChanges(), gates: { fonts: hand.fonts.length, starts: hand.starts.length, writers: hand.writes.length }, touched: state.touched, saved: app.saved, saveFailed: app.saveFailed,
        pendingTransitions: state.pending.size, heldWriters: hand.writes.map(({ path, bytes, saverSerial, refToken }) => ({ path, bytes, saverSerial, refToken })),
        choices: [...state.choices].map(([id, choices]) => [id, [...choices]]), rustDebt: [...state.rustDebt],
        failedWriters: state.failedWriters.map(({ ref, ...writer }) => writer),
        physical: chapters.map((ch) => ({ chapterId: ch.id, chapter: fsx._tree.files.get(paths(ch).chapter), text: fsx._tree.files.get(paths(ch).text) })) } };
    await cleanupModel();
  }
}

// ---------- the generator ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WEIGHTS = [
  ['unmarked_style', 1], ['unmarked_fit', 1], ['unmarked_file', 1], ['unmarked_cleaned', 1],
  ['reversePages', 3], ['unmarkedHandle', 3], ['unmarkedMode', 2], ['holdTranslations', 1],
  ['edit', 6], ['editLate', 6], ['editLine', 6], ['fontLands', 7], ['debounce', 10], ['wait', 2], ['holdWrites', 5], ['writeLands', 9], ['writeFails', 2],
  ['keep', 6], ['switchOff', 2], ['switchOn', 3], ['engineStarts', 5], ['leave', 1], ['open1', 2], ['open2', 1], ['openEmpty', 1],
];
const TOTAL = WEIGHTS.reduce((n, [, w]) => n + w, 0);
function sequence(seed, steps) {
  const next = rng(seed);
  const pick = () => {
    let r = next() * TOTAL;
    for (const [name, w] of WEIGHTS) if ((r -= w) < 0) return name;
    return 'debounce';
  };
  // How it begins: the switch off, on, or on and still starting; a version 1
  // chapter or a version 2 one; writes held from the start or not.
  const head = [];
  const how = next();
  if (how < 0.55) head.push('switchOn', 'engineStarts');
  else if (how < 0.8) head.push('switchOn');
  head.push(next() < 0.75 ? 'open1' : 'open2');
  if (next() < 0.5) head.push('holdWrites');
  return [...head, ...Array.from({ length: steps }, pick)];
}

// The fewest of its events that still break it, by taking one away at a time.
async function shrink(events, kind = 'unknown') {
  let now = events;
  for (let again = true; again; ) {
    again = false;
    for (let i = now.length - 1; i >= 0; i--) {
      const fewer = [...now.slice(0, i), ...now.slice(i + 1)];
      const result = await run(fewer);
      if (kind !== 'unknown' ? result?.deferred?.category === kind : typeof result === 'string') {
        now = fewer;
        again = true;
      }
    }
  }
  return { events: now, why: await run(now) };
}

const SEQUENCES = Number(process.env.MODEL_SEQUENCES ?? 400);
const STEPS = Number(process.env.MODEL_STEPS ?? 30);
const ONE = process.env.MODEL_SEED ? Number(process.env.MODEL_SEED) : null;
const FIRST = 20261009;

// The measured original1358 prefix reaches a fresh browser ref with saved
// 48px geometry and a 70px live reflow. All prior user choices have landed.
// Leave the final receipt for the named control to accept or refuse.
async function openedBrowserReflow() {
  resetHand(); state.open = false;
  const prefix = sequence(20261358, 30).slice(0, 20);
  for (const [index, name] of prefix.entries()) {
    state.event = name;
    await EVENTS[name](); await pass(0);
    if (index < prefix.length - 1) retireBrowserDebt();
    choicesLive(`browser reflow setup after ${name}`);
  }
  expect(state.touched).toBe(false);
  expect(JSON.parse(onDisk()).pages[0].boxes[3].h).toBe(48);
  expect(app.pages[0].boxes[3].h).toBe(70);
  expect(state.rustDebt.has(c.id)).toBe(true);
}

describe('saves, fonts, the engine starting and Keep, in any order', () => {
  it(`leave the file as opened, or as the document with the right number (${ONE == null ? `${SEQUENCES} sequences of ${STEPS} events` : `seed ${ONE}`})`, async () => {
    const seeds = ONE == null ? Array.from({ length: SEQUENCES }, (_, i) => FIRST + i) : [ONE];
    const broken = [];
    for (const seed of seeds) {
      const events = sequence(seed, STEPS);
      const why = await run(events);
      const proof = copy(state.lastRunProof);
      // Only the original generated orders count here. Named probes and
      // shrink replays may increment the historical totals above, but cannot
      // inflate this per-event breakdown of the 6000 generated sequences.
      for (const [stage, counts] of Object.entries(state.lastRunStages.eventsByStage)) {
        for (const [name, count] of Object.entries(counts)) seen.generatedStages.eventsByStage[stage][name] = (seen.generatedStages.eventsByStage[stage][name] ?? 0) + count;
      }
      for (const [name, count] of Object.entries(state.lastRunStages.inapplicablePublicActions)) seen.generatedStages.inapplicablePublicActions[name] = (seen.generatedStages.inapplicablePublicActions[name] ?? 0) + count;
      seen.sequences++;
      seen.generatedEvents += events.length;
      seen.executedEvents += proof.executedPrefix.length;
      seen.unexecutedTailEvents += proof.unexecutedTail.length;
      if (!why) { seen.completedInvariantOrders++; continue; }
      if (why.deferred) {
        const category = why.deferred.category;
        if (category === 'exact-browser-cancellation') seen.exactBrowserWitnessOrders++;
        else if (category === 'exact-browser-stale-final') seen.staleBrowserFinalWitnessOrders++;
        else if (category === 'explicit-forced-exit') seen.forcedExitWitnessOrders++;
        else throw new Error(`unknown classification ${category}`);
        const least = await shrink(events, category);
        classifiedWitnesses.push({ seed, original: proof, shrunkOrder: least.events,
          shrunkProof: state.lastRunProof, witness: least.why.deferred });
        continue;
      }
      seen.unknownFailedOrders++;
      const least = await shrink(events);
      classifiedUnknowns.push({ seed, originalWhy: why, original: proof, shrunkWhy: least.why, shrunkOrder: least.events, shrunkProof: copy(state.lastRunProof) });
      broken.push(`seed ${seed}: ${least.why}\n    the fewest events that do it: ${least.events.join(', ')}`);
      if (broken.length >= 5 && !process.env.MODEL_REPORT) break;
    }
    if (process.env.MODEL_WITNESS_OUT) {
      const out = resolve(process.env.MODEL_WITNESS_OUT);
      if (!out.startsWith('/Users/caved/dev/manga-typesetter-wt/tp-data/reports/')) throw new Error('MODEL_WITNESS_OUT must be a fresh private reports file');
      writeFileSync(out, JSON.stringify({ summary: seen, witnesses: classifiedWitnesses, unknowns: classifiedUnknowns }, null, 2), { flag: 'wx' });
    } else if (classifiedWitnesses.length) {
      console.log(`exact browser witness orders: ${classifiedWitnesses.length}; full order/prefix/tail and both-file records require explicit MODEL_WITNESS_OUT`);
    }
    if (process.env.MODEL_REPORT) console.log(`the model: ${JSON.stringify(seen)}`);
    expect(broken.join('\n'), `replay one with MODEL_SEED=<seed>`).toBe('');
    // That it did something: a generator whose events all fall on a closed
    // chapter proves nothing.
    if (ONE == null && SEQUENCES >= 100) {
      expect(seen.writes).toBeGreaterThan(SEQUENCES);
      expect(seen.keeps).toBeGreaterThan(SEQUENCES / 20);
      expect(seen.asOpened).toBeGreaterThan(0);
      expect(seen.asDocument).toBeGreaterThan(SEQUENCES / 2);
    }
  }, 600_000);

  it('the original queued outgoing Rust order never writes the newly adopted untouched chapter', async () => {
    expect(await run(sequence(20262371, 30))).toBe(null);
    expect(state.lastRunProof.facts.choices.find(([id]) => id === chapters[0].id)?.[1] ?? []).toEqual([]);
  });

  it.each([['browser', 0], ['browser', 1], ['rust', 0], ['rust', 1]])(
    'a queued %s save cannot acquire the fresh incoming ref (chapter index %s)', async (engine, index) => {
      resetHand(); state.open = false;
      const saves = [];
      try {
        if (engine === 'rust') { await EVENTS.switchOn(); await EVENTS.engineStarts(); }
        await open(V1);
        await EVENTS.editLine();
        hand.hold = true; hand.holdTranslations = true;
        saves.push(saveOpenChapter());
        await pass(0);
        expect(hand.writes).toHaveLength(1);
        const outgoing = hand.writes[0].bytes;
        saves.push(saveOpenChapter());
        const oldRef = app.chapterRef;
        closeChapter(); state.open = false;
        await until(openChapter(p.id, chapters[index].id));
        adopt(chapters[index]); state.open = true;
        expect(app.chapterRef).not.toBe(oldRef);
        const beforeAttempts = hand.began.length;
        const incomingPath = paths(chapters[index]);
        const incomingBefore = fsx._tree.files.get(incomingPath.chapter);
        const incomingTextBefore = fsx._tree.files.get(incomingPath.text);
        const outgoingChapterPath = paths(chapters[0]).chapter;
        hand.writes.shift().ok(); await pass(0);
        expect(hand.writes[0].path).toBe(paths(chapters[0]).text);
        hand.writes.shift().ok(); await pass(0);
        expect(hand.began.length, 'old queued request must stop before reading or stamping the new ref').toBe(beforeAttempts);
        expect(hand.writes).toHaveLength(0);
        const receipt = state.savers.find((save) => save.originalPromise === saves[0]);
        expect(receipt.bothFileReceipt).toMatchObject({ saverSerial: receipt.serial, refToken: refToken(oldRef),
          chapterPath: outgoingChapterPath, textPath: paths(chapters[0]).text, chapter: outgoing });
        expect(receipt.physicalReceipts.map((write) => write.path)).toEqual([outgoingChapterPath, paths(chapters[0]).text]);
        for (const save of saves) await until(save);
        if (index === 1) {
          expect(fsx._tree.files.get(incomingPath.chapter)).toBe(incomingBefore);
          expect(fsx._tree.files.get(incomingPath.text)).toBe(incomingTextBefore);
        } else {
          // The first already-started old write may finish at this same path;
          // the second queued request still must not snapshot the fresh ref.
          expect(fsx._tree.files.get(outgoingChapterPath)).toBe(outgoing);
          expect(fsx._tree.files.get(incomingPath.text)).toBe(buildTextJson(JSON.parse(outgoing).pages));
        }
        expect(firstFitChanges()?.kept ?? false).toBe(false);
      } finally { await cleanupModel(); }
    });

  it.each([false, true])('a valid same-ref browser queued save survives Rust acquisition %s', async (acquire) => {
    resetHand(); state.open = false;
    try {
      await open(V1);
      const ref = app.chapterRef;
      await EVENTS.editLine();
      hand.hold = true;
      const first = saveOpenChapter(); await pass(0);
      await EVENTS.editLine();
      const second = saveOpenChapter(); await pass(0);
      if (acquire) { await EVENTS.switchOn(); await EVENTS.engineStarts(); await pass(0); }
      expect(app.chapterRef).toBe(ref);
      hand.writes.shift().ok(); await pass(0);
      expect(hand.writes).toHaveLength(1);
      hand.writes.shift().ok(); await pass(0);
      await until(first); await until(second);
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe('AAAA');
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AAAA');
      expect(app.chapterRef).toBe(ref);
    } finally { await cleanupModel(); }
  });

  it('a saved browser choice starts a new independent untouched Rust baseline without erasing intent', async () => {
    const events = ['open1', 'unmarkedHandle', 'debounce', 'switchOn'];
    expect(await run(events)).toBe(null);
    expect(state.lastRunProof.baselineReceipts).toHaveLength(1);
    expect(state.lastRunProof.facts.choices[0][1]).not.toHaveLength(0);
    expect(state.lastRunProof.facts.touched).toBe(false);
  });

  it('an untouched browser reflow retires old debt from its exact opened receipt and starts a Rust baseline without losing history', async () => {
    try {
      await openedBrowserReflow();
      const choices = copy([...state.choices].map(([id, values]) => [id, [...values]]));
      const opened = onDisk(); const openedText = textOnDisk(); const writes = hand.began.length;
      expect(state.openedRef).toBe(app.chapterRef);
      for (const chapter of chapters) choicesOnDisk(chapter, 'all historical choices before reflow retirement');
      retireBrowserDebt();
      expect(state.rustDebt.has(c.id)).toBe(false);
      expect(state.retirements.get(c.id)).toMatchObject({ kind: 'untouched-opened', ref: app.chapterRef, chapter: opened, text: openedText, writes });
      expect(state.browserSettlements.get(c.id)?.retiredRustDebt).toBe(true);
      await EVENTS.switchOn();
      expect(state.baselineReceipts).toHaveLength(1);
      expect(state.baselineReceipts[0]).toMatchObject({ kind: 'untouched-opened', ref: state.openedRef, chapter: opened, text: openedText, writes });
      expect(state.touched).toBe(false);
      expect(copy([...state.choices].map(([id, values]) => [id, [...values]]))).toEqual(choices);
      expect(onDisk()).toBe(opened); expect(textOnDisk()).toBe(openedText); expect(hand.began).toHaveLength(writes);
    } finally { await cleanupModel(); }
  });

  it.each(['chapter bytes', 'translation bytes', 'opened ref', 'extra actual write', 'touched', 'current choice loss', 'inactive choice loss', 'document timer', 'unknown timer', 'live filename', 'physical identity', 'mode', 'version'])(
    'an untouched opened browser receipt refuses %s', async (risk) => {
      let timer;
      try {
        await openedBrowserReflow();
        if (risk === 'chapter bytes') fsx._tree.files.set(chapterPath, onDisk() + ' ');
        else if (risk === 'translation bytes') fsx._tree.files.set(translationsPath, textOnDisk() + ' ');
        else if (risk === 'opened ref') state.openedRef = { ...app.chapterRef };
        else if (risk === 'extra actual write') {
          const opened = onDisk(); const openedText = textOnDisk(); const before = hand.began.length;
          await until(saveOpenChapter());
          expect(hand.began.length).toBeGreaterThan(before);
          // An external replacement with the older bytes cannot erase the
          // observation that another actual BOTH-file write occurred.
          fsx._tree.files.set(chapterPath, opened); fsx._tree.files.set(translationsPath, openedText);
        } else if (risk === 'touched') state.touched = true;
        else if (risk === 'current choice loss') UNMARKED.text();
        else if (risk === 'inactive choice loss') {
          const other = chapters[2]; const path = paths(other); const rec = JSON.parse(fsx._tree.files.get(path.chapter));
          rec.pages.reverse(); fsx._tree.files.set(path.chapter, JSON.stringify(rec));
        } else if (risk === 'document timer') { markUnsaved(); app.saved = true; }
        else if (risk === 'unknown timer') timer = setTimeout(() => {}, DOC_SAVE_MS);
        else if (risk === 'live filename') app.pages[0].file = 'wrong-live.png';
        else if (risk === 'physical identity') {
          const rec = JSON.parse(onDisk()); rec.id = chapters[1].id; fsx._tree.files.set(chapterPath, JSON.stringify(rec));
        } else if (risk === 'mode') app.chapterMode = 'translate';
        else app.typesetting.version = 2;
        expect(settlementReceipt()).toBe(null);
        retireBrowserDebt();
        expect(state.rustDebt.has(c.id)).toBe(true);
        expect(state.browserSettlements.get(c.id)).toBeUndefined();
        await EVENTS.switchOn();
        expect(state.baselineReceipts).toEqual([]);
      } finally { if (timer) clearTimeout(timer); await cleanupModel(); }
    });

  it('a held old-ref Rust-owned public final cannot qualify a fresh browser opened receipt', async () => {
    resetHand(); state.open = false;
    let pending;
    try {
      await EVENTS.switchOn(); await EVENTS.engineStarts(); await open(V1); await EVENTS.editLine();
      const outgoingRef = app.chapterRef;
      hand.hold = true;
      pending = flushBeforeLeaving('editor'); pending.catch(() => {}); await pass(0);
      expect(pendingOwnedFinals(outgoingRef)).toHaveLength(1);
      expect(hand.writes).toHaveLength(1);
      closeChapter(); state.open = false;
      await EVENTS.switchOff(); adopt(chapters[1]); await open(V2);
      expect(app.chapterRef).not.toBe(outgoingRef);
      expect(state.openedRef).toBe(app.chapterRef);
      expect(onDisk()).toBe(state.opened); expect(textOnDisk()).toBe(state.openedText);
      expect(pendingOwnedFinals(outgoingRef)).toHaveLength(1);
      expect(settlementReceipt()).toBe(null);
      retireBrowserDebt();
      expect(state.browserSettlements.get(c.id)).toBeUndefined();
    } finally { await cleanupModel(); if (pending) await until(pending).catch(() => {}); }
  });

  it('a positive pure-browser receipt records settlement without claiming prior Rust debt retirement', async () => {
    resetHand(); state.open = false;
    try {
      await open(V1);
      retireBrowserDebt();
      const receipt = state.browserSettlements.get(c.id);
      expect(receipt).toMatchObject({ kind: 'current-document', ref: app.chapterRef, chapter: onDisk(), text: textOnDisk(), retiredRustDebt: false });
      expect(state.retirements.has(c.id)).toBe(false);
      expect(state.rustDebt.has(c.id)).toBe(false);
      expect(state.choices.size).toBe(0);
    } finally { await cleanupModel(); }
  });

  it('a real pending history timer permits a saved browser baseline while retaining the line choice', async () => {
    resetHand(); state.open = false;
    try {
      await open(V1);
      await EVENTS.editLine();
      await pass(DOC_SAVE_MS);
      const history = [...state.timers.values()].filter((timer) => timer.pending && timer.source === 'history');
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ ms: DOC_SAVE_MS, source: 'history', ref: app.chapterRef });
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe('AAA');
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AAA');
      expect(app.saved).toBe(true);
      const choices = copy([...state.choices.get(c.id)]);
      await EVENTS.switchOn();
      expect(state.baselineReceipts).toHaveLength(1);
      expect(state.touched).toBe(false);
      expect([...state.choices.get(c.id)]).toEqual(choices);
      expect(history[0]).toMatchObject({ pending: true, relevant: false });
      expect(relevantTimers()).toEqual([]);
    } finally { await cleanupModel(); }
  });

  it.each([DOC_SAVE_MS, KEEP_WAIT_MS])('an unknown actual %sms timer blocks equal-file baseline and debt retirement', async (ms) => {
    resetHand(); state.open = false;
    let id;
    try {
      await open(V1);
      expect(settlementReceipt()).not.toBe(null);
      id = setTimeout(() => {}, ms);
      expect(state.timers.get(id)).toMatchObject({ source: 'unknown', relevant: true, pending: true, ref: app.chapterRef });
      state.rustDebt.add(c.id);
      expect(settlementReceipt()).toBe(null);
      retireBrowserDebt();
      expect(state.rustDebt.has(c.id)).toBe(true);
      await EVENTS.switchOn();
      expect(state.baselineReceipts).toEqual([]);
    } finally { clearTimeout(id); await cleanupModel(); }
  });

  it('a document autosave timer remains blocking even when a false saved flag and equal files look settled', async () => {
    resetHand(); state.open = false;
    try {
      await open(V1);
      markUnsaved();
      // No document bytes change; the apparent saved flag cannot retire a
      // real pending document request or establish a Rust baseline.
      app.saved = true;
      const timers = relevantTimers();
      expect(timers).toHaveLength(1);
      expect(timers[0]).toMatchObject({ source: 'document', ms: DOC_SAVE_MS, pending: true });
      state.rustDebt.add(c.id);
      expect(settlementReceipt()).toBe(null);
      retireBrowserDebt();
      expect(state.rustDebt.has(c.id)).toBe(true);
      await EVENTS.switchOn();
      expect(state.baselineReceipts).toEqual([]);
    } finally { await cleanupModel(); }
  });

  it('a real waiting Keep timer retains ownership rather than qualifying as history', async () => {
    resetHand(); state.open = false;
    try {
      await EVENTS.switchOn(); await EVENTS.engineStarts(); await open(V1);
      expect(waiting()).toBe(true);
      await EVENTS.keep();
      const timers = relevantTimers().filter((timer) => timer.ms === KEEP_WAIT_MS);
      expect(timers).toHaveLength(1);
      expect(timers[0]).toMatchObject({ source: 'keep', relevant: true, pending: true });
      expect(firstFitChanges()).toMatchObject({ keeping: true, kept: false });
      expect(settlementReceipt()).toBe(null);
      expect(state.rustDebt.has(c.id)).toBe(true);
      expect(state.baselineReceipts).toEqual([]);
    } finally { await cleanupModel(); }
  });

  it('missing or lookalike history setter evidence never identifies a history timer', () => {
    for (const ms of [DOC_SAVE_MS, KEEP_WAIT_MS]) {
      expect(timerSource(ms, null)).toBe('unknown');
      expect(timerSource(ms, 'Error\n    at observer (/src/lib/first-fit.model.test.js:1:1)\n    at schedule (/src/lib/other/history-file.svelte.js:570:11)')).toBe('unknown');
      expect(timerSource(ms, 'Error\n    at observer (/src/lib/first-fit.model.test.js:1:1)\n    at anotherSetter (/src/lib/editor/history-file.svelte.js:570:11)')).toBe('unknown');
    }
  });

  it.each(['chapter only', 'unsaved', 'queued saver', 'pending final', 'wrong live filename', 'wrong physical filename'])(
    'a browser baseline refuses %s evidence', async (risk) => {
      resetHand(); state.open = false;
      try {
        await open(V1);
        if (risk === 'chapter only') {
          hand.holdTranslations = true; await EVENTS.editLine(); await pass(DOC_SAVE_MS);
        } else if (risk === 'unsaved') await EVENTS.editLine();
        else if (risk === 'queued saver') {
          hand.hold = true; const first = saveOpenChapter(); first.catch(() => {}); await pass(0);
          saveOpenChapter().catch(() => {});
        } else if (risk === 'pending final') {
          hand.hold = true; await EVENTS.leave();
        } else if (risk === 'wrong live filename') app.pages[0].file = 'wrong-live.png';
        else {
          const rec = JSON.parse(onDisk()); rec.pages[0].file = 'wrong-physical.png';
          fsx._tree.files.set(chapterPath, JSON.stringify(rec));
        }
        expect(settlementReceipt()).toBe(null);
        await EVENTS.switchOn();
        expect(state.baselineReceipts).toEqual([]);
      } finally { await cleanupModel(); }
    });

  it('an overlapping public open binds its own later snapshot and preserves the exact cancellation verdict', async () => {
    resetHand(); state.open = false; state.deferred = null;
    try {
      await open(V1); await EVENTS.editLine();
      hand.hold = true; hand.holdTranslations = true;
      const earlier = saveOpenChapter(); await pass(0);
      await EVENTS.editLine(); await EVENTS.open2();
      const window = state.finalWindows.at(-1);
      hand.writes.shift().ok(); await pass(0);
      hand.writes.shift().ok(); await until(earlier); await pass(0);
      expect(JSON.parse(hand.writes[0].bytes).pages[0].lines[0].en).toBe('AAAA');
      await EVENTS.editLine();
      hand.writes.shift().ok(); await pass(0);
      hand.writes.shift().ok(); await until(state.lastOpen); await pass(0);
      expect(state.deferred?.category, 'only this public open actually cancels its later choice').toBe('exact-browser-cancellation');
      expect(JSON.parse(state.deferred.physical.chapter).pages[0].lines[0].en).toBe('AAAA');
      expect(JSON.parse(state.deferred.physical.text).pages[0].lines[0].en).toBe('AAAA');
      expect(window.saver.publicRequestSerial).toBe(window.publicRequest.serial);
      expect(window.saver.originalPromise).not.toBe(earlier);
      expect(window.cleanAtRequest).toBe(false);
    } finally { await cleanupModel(); }
  });

  it('a later same-key choice cannot excuse an earlier independent choice already missing at the actual snapshot', async () => {
    resetHand(); state.open = false; state.deferred = null;
    try {
      await open(V1); await EVENTS.editLine();
      // A deliberate IUT-memory fault, without changing the retained intent.
      app.pages[0].lines[0].en = 'BROKEN EARLIER';
      hand.hold = true; hand.holdTranslations = true;
      await EVENTS.open2();
      await EVENTS.editLine();
      hand.writes.shift().ok(); await pass(0);
      hand.writes.shift().ok(); await until(state.lastOpen); await pass(0);
      expect(state.deferred, 'a late same-key waiver must not conceal the earlier missing AAA').toBe(null);
      expect(hand.broke).toContain('user translation choice');
      const window = state.finalWindows.at(-1);
      expect(earlierChoicesPresent(window, window.snapshot.chapter, window.snapshot.text)).toBe(false);
      expect(window.snapshot.earlierChoices.find(([, choice]) => choice.kind === 'translation')[1].value).toBe('AAA');
    } finally { await cleanupModel(); }
  });

  it.each(['missing', 'expired'])('a %s public context cannot turn an unrelated save loss into a final cancellation witness', async (contextKind) => {
    resetHand(); state.open = false; state.deferred = null;
    try {
      await open(V1);
      expect(await until(flushBeforeLeaving('editor'))).toBe(true);
      const finished = state.publicRequests.at(-1);
      const window = finalWindow('open');
      hand.hold = true; hand.holdTranslations = true;
      const save = saverObserver.scope.run(contextKind === 'expired' ? finished : undefined, () => saveOpenChapter());
      await pass(0); await EVENTS.editLine();
      hand.writes.shift().ok(); await pass(0);
      hand.writes.shift().ok(); await until(save); await pass(0);
      expect(observedBrowserCancellation(window, c), 'physical late-choice loss stays strict without this final caller').toBe(null);
      expect(() => choicesOnDisk(c, 'unattributed actual loss')).toThrow(Broken);
      const receipt = state.savers.find((receipt) => receipt.originalPromise === save);
      expect(receipt.publicRequestSerial).toBe(null);
      expect(receipt.contextDisposition).toBe(contextKind);
      expect(receipt.bothFileReceipt.chapter).toBe(onDisk());
    } finally { await cleanupModel(); }
  });

  it.each(['unrelated', 'expired invocation'])('an %s markSaved clear cannot inherit a held final’s cancellation witness', async (clearKind) => {
    resetHand(); state.open = false; state.deferred = null;
    try {
      await open(V1);
      const priming = saveOpenChapter(); await until(priming);
      const finished = state.savers.find((save) => save.originalPromise === priming);
      hand.holdTranslations = true;
      await EVENTS.open1();
      const window = state.finalWindows.at(-1);
      expect(onDisk()).toBe(window.snapshot.chapter);
      expect(textOnDisk()).toBe(window.snapshot.text);
      await EVENTS.editLine();
      saverObserver.invocationScope.run(clearKind === 'expired invocation' ? finished : undefined, () => store.markSaved());
      hand.writes.shift().ok(); await until(state.lastOpen); await pass(0);
      expect(state.deferred, 'only the still-active exact final saver may prove this cancellation').toBe(null);
      expect(hand.broke).toContain('user translation choice');
      expect(window.timer).toMatchObject({ cancelledByMarkSaved: true, saverContextPending: false, clearerSource: 'markSaved' });
      expect(observedBrowserCancellation(window, window.chapter)).toBe(null);
    } finally { await cleanupModel(); }
  });

  it('an incoming LOAD timer clear preserves the original strict open loss and cannot claim the outgoing saver', async () => {
    const result = await run(sequence(20261094, 30));
    expect(typeof result, 'pending newer outgoing work is not an old-final cancellation proof').toBe('string');
    expect(state.lastRunProof.witnesses).toEqual([]);
    const loadClears = state.lastRunProof.timers.filter((timer) => timer.source === 'document')
      .flatMap((timer) => timer.clears ?? []).filter((clear) => clear.pendingBefore && clear.clearerSource === 'markSaved' && /at loadChapter \(/.test(clear.clearerStack));
    expect(loadClears.length).toBeGreaterThan(0);
    expect(loadClears.some((clear) => clear.saverContextPending)).toBe(false);
    expect(state.lastRunProof.facts.choices.length).toBeGreaterThan(0);
  });

  it('a still-pending old public context cannot bind a fresh ref’s actual saver or waive its later loss', async () => {
    resetHand(); state.open = false; state.deferred = null;
    let oldFinal;
    try {
      await open(V1); hand.hold = true; hand.holdTranslations = true;
      oldFinal = flushBeforeLeaving('editor'); await pass(0);
      const context = state.publicRequests.at(-1);
      closeChapter(); state.open = false;
      await until(openChapter(p.id, chapters[1].id)); adopt(chapters[1]); state.open = true;
      const window = finalWindow('open');
      const save = saverObserver.scope.run(context, () => saveOpenChapter());
      hand.writes.shift().ok(); await pass(0);
      hand.writes.shift().ok(); await until(oldFinal); await pass(0);
      await EVENTS.editLine();
      hand.writes.shift().ok(); await pass(0);
      hand.writes.shift().ok(); await until(save); await pass(0);
      expect(observedBrowserCancellation(window, c), 'an old caller cannot exempt the fresh ref’s actual lost choice').toBe(null);
      expect(() => choicesOnDisk(c, 'fresh ref strict intent')).toThrow(Broken);
      const receipt = state.savers.find((receipt) => receipt.originalPromise === save);
      expect(receipt).toMatchObject({ contextDisposition: 'ref-mismatch', publicRequestSerial: null });
      expect(receipt.bothFileReceipt.refToken).toBe(refToken(app.chapterRef));
    } finally { await cleanupModel(); if (oldFinal) await until(oldFinal).catch(() => {}); }
  });

  it('a fulfilled superseded same-ID open preserves the touched cycle until an actual new ref loads', async () => {
    resetHand(); state.open = false; state.deferred = null;
    let newer;
    try {
      await EVENTS.switchOn(); await EVENTS.engineStarts(); await EVENTS.open2();
      await EVENTS.editLine(); await pass(DOC_SAVE_MS);
      choicesOnDisk(chapters[1], 'unrelated real Rust choice before the no-op');
      await EVENTS.switchOff(); await EVENTS.open1(); await EVENTS.editLine();
      const oldRef = app.chapterRef, oldOpened = state.opened;
      const historical = copy([...state.choices].map(([id, choices]) => [id, [...choices]]));
      const debts = [...state.rustDebt];
      const otherPath = paths(chapters[1]);
      const otherPhysical = [fsx._tree.files.get(otherPath.chapter), fsx._tree.files.get(otherPath.text)];
      expect(debts).toContain(chapters[1].id);
      hand.hold = true; hand.holdTranslations = true;
      await EVENTS.open1();
      const superseded = state.lastOpen;
      // A real external public open supersedes the first without changing the
      // model generation. Fulfilled void on the first is not actual adoption.
      newer = openChapter(p.id, c.id); await pass(0);
      hand.writes.shift().ok(); await pass(0);
      hand.writes.shift().ok(); await until(superseded); await pass(0);
      expect(state.touched, 'fulfilled no-op must not replace the independently touched baseline').toBe(true);
      expect(state.opened).toBe(oldOpened);
      expect(state.openedRef).toBe(oldRef);
      expect(app.chapterRef).toBe(oldRef);
      expect([...state.choices].map(([id, choices]) => [id, [...choices]])).toEqual(historical);
      expect([...state.rustDebt]).toEqual(debts);
      expect([fsx._tree.files.get(otherPath.chapter), fsx._tree.files.get(otherPath.text)]).toEqual(otherPhysical);
      choicesOnDisk(chapters[1], 'unrelated historical obligations after the no-op');
      const first = state.publicRequests.find((request) => request.originalPromise === superseded);
      expect(first).toMatchObject({ fulfilled: true, changedRef: false, generationMatches: true });
      hand.writes.shift().ok(); await pass(0);
      hand.writes.shift().ok(); await until(newer); await pass(0);
      expect(app.chapterRef).not.toBe(oldRef);
      choicesOnDisk(c, 'actual newer public open preserves the saved historical choice');
    } finally { await cleanupModel(); if (newer) await until(newer).catch(() => {}); }
  });

  it('multiple actual invocations refuse a final witness without deleting its first physical and timer observations', async () => {
    resetHand(); state.open = false; state.deferred = null;
    let extra;
    try {
      await open(V1); hand.hold = true; hand.holdTranslations = true;
      await EVENTS.open1(); await EVENTS.editLine();
      const window = state.finalWindows.at(-1);
      const first = { saver: window.saver, snapshot: window.snapshot, timer: window.timer, held: window.heldWriter };
      extra = saverObserver.scope.run(window.publicRequest, () => saveOpenChapter());
      await pass(0);
      hand.writes.shift().ok(); await pass(0);
      hand.writes.shift().ok(); await until(state.lastOpen); await pass(0);
      expect(state.deferred, 'an ambiguous final cannot claim the pending physical loss').toBe(null);
      expect(observedBrowserCancellation(window, window.chapter)).toBe(null);
      expect(() => choicesOnDisk(window.chapter, 'ambiguous actual final retains strict intent')).toThrow(Broken);
      expect(window).toMatchObject({ attributionAmbiguous: true });
      expect(window.saverSerials).toHaveLength(2);
      expect(window.saver).toBe(first.saver);
      expect(window.snapshot).toBe(first.snapshot);
      expect(window.timer).toBe(first.timer);
      expect(window.heldWriter).toBe(first.held);
      expect(window.snapshot.earlierChoices).toEqual([]);
    } finally { await cleanupModel(); if (extra) await until(extra).catch(() => {}); }
  });

  it('an unattributed physical browser write still fails the version invariant when it writes current bytes as version2', async () => {
    resetHand(); state.open = false;
    try {
      await open(V1); await EVENTS.editLine(); await pass(DOC_SAVE_MS);
      choicesOnDisk(c, 'actual both-file choice before the raw version fault');
      // Inject a real unbound physical writer fault. The expected browser
      // version1 rule is independent of this current-byte input fixture.
      const rec = JSON.parse(onDisk()); rec.typesetting.version = 2;
      app.typesetting.version = 2;
      await until(fsx.writeTextFileAtomic(chapterPath, JSON.stringify(rec)));
      expect(() => checkFile('unattributed browser version fault')).toThrow('a landed browser snapshot does not say 1');
      expect(hand.landed.at(-1).browser).toBe(true);
      expect(hand.landed.at(-1).saverSerial).toBeUndefined();
      expect(hand.landed.at(-1).rawWriteSerial).toBe(hand.began.at(-1).rawWriteSerial);
    } finally { await cleanupModel(); }
  });

  it('public open, direct save and registered saver observers preserve the original promises', async () => {
    resetHand(); state.open = false; state.keep = null;
    let off, release;
    try {
      const opened = openChapter(p.id, c.id);
      expect(state.publicRequests.at(-1).originalPromise).toBe(opened);
      await until(opened); state.open = true;
      const direct = saveOpenChapter();
      expect(state.savers.at(-1).originalPromise).toBe(direct);
      await until(direct);
      const original = new Promise((done) => { release = done; });
      off = store.setSaver(() => original);
      const flushed = flushSave(); await pass(0);
      expect(state.savers.some((save) => save.originalPromise === original)).toBe(true);
      release(); await until(flushed);
      expect(state.savers.find((save) => save.originalPromise === original).pending).toBe(false);
    } finally { release?.(); off?.(); await cleanupModel(); }
  });

  it('a same-ID reopen retains the exact observed cancellation prefix and its unexecuted tail', async () => {
    const events = ['open1', 'holdWrites', 'open1', 'editLine', 'writeLands', 'switchOn', 'engineStarts'];
    const result = await run(events);
    expect(result?.deferred?.category).toBe('exact-browser-cancellation');
    expect(state.lastRunProof.unexecutedTail).toEqual(['switchOn', 'engineStarts']);
    expect(state.lastRunProof.facts.choices[0][1]).not.toHaveLength(0);
  });

  it('the original stale browser final has a separate fired-timer witness after proven Rust retirement', async () => {
    const result = await run(sequence(20261867, 30));
    expect(result?.deferred?.category).toBe('exact-browser-stale-final');
    expect(result.deferred.timer.cancelledByMarkSaved).toBe(false);
    expect(result.deferred.newerDerivedFileNotYetObserved).toBe(true);
    expect(state.lastRunProof.unexecutedTail.length).toBeGreaterThan(0);
    expect(state.lastRunProof.facts.rustDebt).toEqual([]);
  });

  it('two actual rejected saver promises and public refusal/force replies retain a separate forced-exit prefix', async () => {
    const result = await run(sequence(20261290, 30));
    expect(result?.deferred?.category).toBe('explicit-forced-exit');
    expect(result.deferred.failedSavers).toHaveLength(2);
    expect(result.deferred.priorRefusal.answer).toBe(false);
    expect(result.deferred.answer).toBe(true);
    expect(result.deferred.rustDebtRetained).toBe(true);
    expect(state.lastRunProof.facts.choices[0][1]).not.toHaveLength(0);
    expect(state.lastRunProof.unexecutedTail.length).toBeGreaterThan(0);
  });

  it.each(['Rust acquisition', 'outstanding owned final', 'wrong retirement identity', 'only one retirement file', 'earlier ambiguous saver'])(
    'a stale browser final refuses %s as a known witness', async (risk) => {
      resetHand(); state.open = false;
      try {
        await EVENTS.switchOn(); await EVENTS.engineStarts(); await EVENTS.open2();
        if (risk === 'only one retirement file') {
          await EVENTS.editLine(); hand.holdTranslations = true; await pass(DOC_SAVE_MS);
        }
        await EVENTS.switchOff(); retireBrowserDebt();
        expect(state.rustDebt.has(c.id)).toBe(risk === 'only one retirement file');
        if (risk === 'wrong retirement identity') {
          // Public close/open creates a fresh object ref at the same path.
          closeChapter(); state.open = false;
          await until(openChapter(p.id, c.id)); state.open = true;
        }
        if (risk === 'only one retirement file') expect(state.retirements.size).toBe(0);
        hand.holdTranslations = true;
        let earlier;
        if (risk === 'earlier ambiguous saver') { earlier = flushSave(); earlier.catch(() => {}); await pass(0); }
        const window = finalWindow('leave');
        const request = flushBeforeLeaving('editor');
        state.pending.add(request);
        request.then((answer) => { window.pending = false; window.answer = answer; }).catch(() => {}).finally(() => state.pending.delete(request));
        await pass(0);
        await EVENTS.edit(); await pass(DOC_SAVE_MS);
        hand.hold = true;
        if (risk === 'Rust acquisition' || risk === 'outstanding owned final') {
          await EVENTS.switchOn(); await EVENTS.engineStarts();
          if (risk === 'outstanding owned final') {
            const owned = finalWindow('leave');
            const other = flushBeforeLeaving('editor'); state.pending.add(other);
            other.then((answer) => { owned.pending = false; owned.answer = answer; }).catch(() => {}).finally(() => state.pending.delete(other));
          }
        }
        hand.writes.shift()?.ok(); await pass(0);
        expect(observedBrowserStaleFinal(window, c)).toBe(null);
        expect(observedBrowserCancellation(window, c)).toBe(null);
      } finally { await cleanupModel(); }
    });

  it('an intervening actual successful saver resets the public two-failure escape', async () => {
    resetHand(); state.open = false;
    try {
      await EVENTS.switchOn(); await EVENTS.engineStarts(); await open(V1); await EVENTS.editLine();
      hand.hold = true;
      const firstWindow = finalWindow('leave');
      const first = flushBeforeLeaving('editor'); await pass(0);
      await EVENTS.writeFails();
      firstWindow.answer = await until(first); firstWindow.pending = false;
      firstWindow.replyAt = Date.now(); firstWindow.toast = app.toast.msg;
      expect(firstWindow.answer).toBe(false);
      hand.hold = false; expect(await until(flushBeforeLeaving('editor'))).toBe(true);
      await EVENTS.editLine(); hand.hold = true;
      const secondWindow = finalWindow('leave');
      const second = flushBeforeLeaving('editor'); await pass(0);
      await EVENTS.writeFails();
      secondWindow.answer = await until(second); secondWindow.pending = false;
      secondWindow.replyAt = Date.now(); secondWindow.toast = app.toast.msg;
      expect(secondWindow.answer).toBe(false);
      expect(observedForcedExit(secondWindow, c)).toBe(null);
      expect(state.savers.filter((save) => save.failed === 'disk full')).toHaveLength(2);
    } finally { await cleanupModel(); }
  });

  it.each(Object.entries(UNMARKED))('an unmarked %s change after a save snapshot reaches both files without a rescue flush', async (_, change) => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      hand.hold = true;
      await EVENTS.editLine();
      await pass(DOC_SAVE_MS);
      expect(hand.writes).toHaveLength(1);
      change();
      hand.hold = false;
      hand.writes.shift().ok();
      await pass(0);
      expect(app.saved, 'an older snapshot cannot clear this change').toBe(false);
      await pass(DOC_SAVE_MS);
      state.touched = true;
      checkFile('after the follow-up debounce, with the slow font still held');
      expect(hand.fonts.length).toBeGreaterThan(0);
    } finally {
      await cleanupModel();
    }
  });

  it.each([false, true])('an older Rust write lands after switch-off (restart %s) and the fitted edit reaches both files before leaving', async (restart) => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      hand.hold = true;
      await EVENTS.editLate();
      await EVENTS.editLine();
      await pass(DOC_SAVE_MS);
      expect(hand.writes).toHaveLength(1);
      expect(JSON.parse(onDisk()).pages[0].boxes[3].h).toBe(48);
      await EVENTS.fontLands();
      await pass(0);
      // Literal fake-engine measurement, recorded before switch restoration;
      // never use the potentially restored post-switch document as the oracle.
      const fittedHeight = 70;
      expect(app.pages[0].boxes[3].h).toBe(fittedHeight);
      const wantedTranslation = 'AAA';
      const wantedText = 'AAAA BBBB CC';
      await EVENTS.switchOff();
      expect(app.pages[0].boxes[3].h).toBe(fittedHeight);
      if (restart) {
        await EVENTS.switchOn();
        await EVENTS.engineStarts();
        await pass(0);
      }
      hand.hold = false;
      hand.writes.shift().ok();
      await pass(0);
      expect(app.saved, 'the older snapshot did not contain the fitted edit').toBe(false);
      await pass(DOC_SAVE_MS);
      const chapter = JSON.parse(onDisk());
      const translations = JSON.parse(textOnDisk());
      expect(chapter.pages[0].boxes[3]).toMatchObject({ h: fittedHeight, text: wantedText });
      expect(translations.pages[0].extraBoxes[3]).toMatchObject({ h: fittedHeight, text: wantedText });
      expect(chapter.pages[0].lines[0].en).toBe(wantedTranslation);
      expect(translations.pages[0].lines[0].en).toBe(wantedTranslation);
      checkFile('switch debt settled by its natural debounce, before leaving');
    } finally {
      await cleanupModel();
    }
  });

  it('an older browser translations snapshot cannot become Rust’s opened baseline, with no rescue flush', async () => {
    resetHand();
    state.open = false;
    try {
      await open(V1);
      hand.holdTranslations = true;
      await EVENTS.editLine();
      await pass(DOC_SAVE_MS);
      expect(hand.writes[0].path).toBe(translationsPath);
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe('AAA');
      await EVENTS.editLine();
      const intended = 'AAAA';
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await pass(0);
      hand.holdTranslations = false;
      hand.writes.shift().ok();
      await pass(0);
      expect(app.saved).toBe(false);
      await pass(DOC_SAVE_MS);
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe(intended);
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe(intended);
      checkFile('browser snapshot acquired by Rust, before leaving');
    } finally {
      await cleanupModel();
    }
  });

  it('opening the actual second chapter waits behind both old files and preserves each chapter’s choices', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      const first = paths(chapters[0]);
      const second = paths(chapters[1]);
      const secondBefore = fsx._tree.files.get(second.chapter);
      const secondTextBefore = fsx._tree.files.get(second.text);
      hand.hold = true;
      hand.holdTranslations = true;
      await EVENTS.editLine();
      await pass(DOC_SAVE_MS);
      await EVENTS.editLine();
      await EVENTS.open2();
      expect(app.chapterRef.chapterId).toBe(chapters[0].id);
      expect(fsx._tree.files.get(second.chapter)).toBe(secondBefore);
      expect(fsx._tree.files.get(second.text)).toBe(secondTextBefore);
      // Release only the old chapter snapshot, then its derived file. The
      // leave flush queued by the real open still waits for its newer snapshot.
      hand.writes.shift().ok();
      await pass(0);
      expect(hand.writes[0].path).toBe(first.text);
      expect(app.chapterRef.chapterId).toBe(chapters[0].id);
      hand.hold = false;
      hand.holdTranslations = false;
      hand.writes.shift().ok();
      await until(state.lastOpen);
      await pass(0);
      expect(app.chapterRef.chapterId).toBe(chapters[1].id);
      expect(JSON.parse(fsx._tree.files.get(first.chapter)).pages[0].lines[0].en).toBe('AAAA');
      expect(JSON.parse(fsx._tree.files.get(first.text)).pages[0].lines[0].en).toBe('AAAA');
      choicesOnDisk(chapters[0], 'old files after the real second open');
      await EVENTS.editLine();
      await pass(DOC_SAVE_MS);
      expect(JSON.parse(fsx._tree.files.get(second.chapter)).pages[0].lines[0].en).toBe('AAA');
      expect(JSON.parse(fsx._tree.files.get(second.text)).pages[0].lines[0].en).toBe('AAA');
      choicesOnDisk(chapters[1], 'second files after their own debounce');
      checkFile('second chapter independently saved');
    } finally {
      await cleanupModel();
    }
  });

  it('a Settings breaker change during a held write keeps this chapter’s ledger and both durable files current', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      const id = app.chapterRef.chapterId;
      hand.holdTranslations = true;
      await EVENTS.editLine();
      await pass(DOC_SAVE_MS);
      expect(hand.writes[0].path).toBe(translationsPath);
      await EVENTS.editLine();
      choose('typesetting', 'plain');
      setChapterTypesetMode('plain');
      expect(app.chapterRef.chapterId).toBe(id);
      hand.holdTranslations = false;
      hand.writes.shift().ok();
      await pass(0);
      expect(app.saved).toBe(false);
      await pass(DOC_SAVE_MS);
      expect(JSON.parse(onDisk()).typesetting.mode).toBe('plain');
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe('AAAA');
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AAAA');
      checkFile('same-chapter Settings change settled before leaving');
    } finally {
      await cleanupModel();
    }
  });

  it.each(['editor', 'quit'])('the final %s snapshot waits for Rust debt discovered before it lands, without a debounce rescue', async (where) => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      hand.hold = true;
      await EVENTS.editLate();
      let done = false;
      const leaving = flushBeforeLeaving(where).then((answer) => { done = true; return answer; });
      await pass(0);
      expect(hand.writes).toHaveLength(1);
      expect(hand.began).toHaveLength(1);
      await EVENTS.fontLands();
      await pass(0);
      expect(app.pages[0].boxes[3].h).toBe(70);
      hand.writes.shift().ok();
      await pass(0);
      expect(done, 'exit cannot destroy the newer fitted edit').toBe(false);
      expect(hand.writes).toHaveLength(1);
      expect(JSON.parse(onDisk()).pages[0].boxes[3].h).toBe(48);
      hand.hold = false;
      hand.writes.shift().ok();
      expect(await until(leaving)).toBe(true);
      expect(JSON.parse(onDisk()).pages[0].boxes[3]).toMatchObject({ h: 70, text: 'AAAA BBBB CC' });
      expect(JSON.parse(textOnDisk()).pages[0].extraBoxes[3]).toMatchObject({ h: 70, text: 'AAAA BBBB CC' });
      expect(JSON.parse(onDisk()).typesetting.version).toBe(2);
      checkFile('after final outgoing settlement, before closing');
      expect(hand.began).toHaveLength(2);
      closeChapter();
      state.open = false;
    } finally { await cleanupModel(); }
  });

  it('final exit saves what exists and does not wait for a font that is still absent', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      await EVENTS.editLine();
      expect(await until(flushBeforeLeaving('editor'))).toBe(true);
      expect(hand.fonts.length).toBeGreaterThan(0);
      expect(JSON.parse(onDisk()).typesetting.version).toBe(1);
      checkFile('final current snapshot, future font still held');
    } finally { await cleanupModel(); }
  });

  it('two simultaneous final flushes see each actual Rust snapshot land while the newer call remains held', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      await EVENTS.editLine();
      await EVENTS.fontLands();
      await pass(0);
      hand.hold = true;
      let firstDone = false;
      const first = flushBeforeLeaving('editor').then((answer) => { firstDone = true; return answer; });
      const second = flushBeforeLeaving('quit');
      await pass(0);
      expect(hand.writes).toHaveLength(1);
      expect(app.typesetting.version).toBe(1);
      hand.writes.shift().ok();
      await pass(0);
      // The second call is held, so old source cannot enter an infinite loop
      // before this assertion sees its suppressed first landed snapshot.
      expect(hand.writes).toHaveLength(1);
      expect(JSON.parse(onDisk()).typesetting.version).toBe(2);
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe('AAA');
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AAA');
      expect(app.typesetting.version, 'a newer queued call cannot hide actual landed Rust bytes').toBe(2);
      expect(app.saved, 'the latest queued call still owns the indicator').toBe(false);
      expect(firstDone, 'both files already contain this final caller’s document').toBe(true);
      hand.hold = false;
      hand.writes.shift().ok();
      expect(await until(first)).toBe(true);
      expect(await until(second)).toBe(true);
      expect(hand.began).toHaveLength(2);
      checkFile('both simultaneous final calls, before cleanup');
    } finally { await cleanupModel(); }
  });

  it('Keep and a final flush see the Keep snapshot land while the newer final call remains held', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      await EVENTS.fontLands();
      await pass(0);
      hand.hold = true;
      let keptDone = false;
      const kept = keepFirstFit().then(() => { keptDone = true; });
      state.touched = true;
      const final = flushBeforeLeaving('editor');
      await pass(0);
      expect(hand.writes).toHaveLength(1);
      expect(app.typesetting.version).toBe(1);
      hand.writes.shift().ok();
      await pass(0);
      expect(hand.writes).toHaveLength(1);
      expect(JSON.parse(onDisk()).typesetting.version).toBe(2);
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AA');
      expect(app.typesetting.version, 'the completed Keep receipt survives the queued final call').toBe(2);
      expect(keptDone, 'the chosen snapshot is in both files').toBe(true);
      expect(app.saved, 'the queued final call has not landed').toBe(false);
      hand.hold = false;
      hand.writes.shift().ok();
      await until(kept);
      expect(await until(final)).toBe(true);
      expect(hand.began).toHaveLength(2);
      checkFile('Keep and final call, before cleanup');
    } finally { await cleanupModel(); }
  });

  it('a failed translations file cannot advance a ready Rust receipt before both files land', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      await EVENTS.fontLands();
      await pass(0);
      hand.holdTranslations = true;
      await EVENTS.editLine();
      await pass(DOC_SAVE_MS);
      expect(hand.writes[0].path).toBe(translationsPath);
      expect(JSON.parse(onDisk()).typesetting.version).toBe(2);
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AA');
      expect(app.typesetting.version, 'only one file has landed').toBe(1);
      hand.writes.shift().fail(new Error('translations disk full'));
      await pass(0);
      expect(app.saveFailed).toBe(true);
      expect(app.saved).toBe(false);
      expect(app.typesetting.version, 'a failed receipt is not the actual both-file ledger').toBe(1);
      hand.holdTranslations = false;
      expect(await until(flushBeforeLeaving('editor'))).toBe(true);
      expect(app.typesetting.version).toBe(2);
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AAA');
      checkFile('the successful retry has its own ready Rust receipt');
    } finally { await cleanupModel(); }
  });

  it('a real chapter switch waits for debt discovered during its final outgoing snapshot, without a debounce rescue', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      const outgoing = paths(chapters[0]);
      const incoming = paths(chapters[1]);
      const incomingBefore = fsx._tree.files.get(incoming.chapter);
      const incomingTextBefore = fsx._tree.files.get(incoming.text);
      hand.hold = true;
      await EVENTS.editLate();
      await EVENTS.open2();
      expect(hand.writes).toHaveLength(1);
      expect(app.chapterRef.chapterId).toBe(chapters[0].id);
      await EVENTS.fontLands();
      await pass(0);
      expect(app.pages[0].boxes[3].h).toBe(70);
      hand.writes.shift().ok();
      await pass(0);
      expect(app.chapterRef.chapterId).toBe(chapters[0].id);
      expect(hand.writes).toHaveLength(1);
      expect(fsx._tree.files.get(incoming.chapter)).toBe(incomingBefore);
      expect(fsx._tree.files.get(incoming.text)).toBe(incomingTextBefore);
      expect(JSON.parse(fsx._tree.files.get(outgoing.chapter)).pages[0].boxes[3].h).toBe(48);
      hand.hold = false;
      hand.writes.shift().ok();
      await until(state.lastOpen);
      expect(app.chapterRef.chapterId).toBe(chapters[1].id);
      expect(JSON.parse(fsx._tree.files.get(outgoing.chapter)).pages[0].boxes[3]).toMatchObject({ h: 70, text: 'AAAA BBBB CC' });
      expect(JSON.parse(fsx._tree.files.get(outgoing.text)).pages[0].extraBoxes[3]).toMatchObject({ h: 70, text: 'AAAA BBBB CC' });
      choicesOnDisk(chapters[0], 'both outgoing files before the incoming document is edited');
      expect(hand.began.filter((w) => w.path === outgoing.chapter)).toHaveLength(2);
    } finally { await cleanupModel(); }
  });

  it.each([['typeset', 'translate'], ['translate', 'typeset']])('an untouched %s to %s real open notes the incoming workflow mode and writes neither file', async (from, to) => {
    resetHand();
    state.open = false;
    try {
      for (const [index, mode] of [[0, from], [1, to]]) {
        const rec = JSON.parse(V1);
        rec.id = chapters[index].id;
        rec.number = index + 1;
        rec.mode = mode;
        const path = paths(chapters[index]);
        fsx._tree.files.set(path.chapter, JSON.stringify(rec));
        fsx._tree.files.set(path.text, buildTextJson(rec.pages));
      }
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await EVENTS.open1();
      expect(app.chapterMode).toBe(from);
      await EVENTS.open2();
      expect(app.chapterMode).toBe(to);
      expect(app.saved).toBe(true);
      const opened = onDisk();
      const openedText = textOnDisk();
      await EVENTS.fontLands();
      await pass(DOC_SAVE_MS);
      expect(hand.began).toHaveLength(0);
      expect(await until(flushBeforeLeaving('quit'))).toBe(true);
      expect(onDisk()).toBe(opened);
      expect(textOnDisk()).toBe(openedText);
      await EVENTS.switchOff();
      expect(app.chapterMode).toBe(to);
      expect(app.pages.flatMap((pg) => pg.boxes.map((b) => b.h))).toEqual([26, 70, 26, 48, 26]);
      expect(hand.began).toHaveLength(0);
    } finally { await cleanupModel(); }
  });

  it('a settled Rust version2 remains version2 after switch-off until a browser snapshot is taken', async () => {
    expect(await run(['switchOn', 'engineStarts', 'open2', 'editLine', 'debounce', 'switchOff'])).toBe(null);
  });

  it('a public browser Inspector color edit saves after both Rust-owned files are already current', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await EVENTS.open2();
      await EVENTS.editLine();
      await pass(DOC_SAVE_MS);
      await EVENTS.switchOff();
      const history = [...state.timers.values()].filter((timer) => timer.pending && timer.source === 'history');
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ ms: DOC_SAVE_MS, source: 'history', ref: app.chapterRef });
      retireBrowserDebt();
      expect(state.rustDebt.has(c.id)).toBe(false);
      expect(state.retirements.get(c.id)?.ref).toBe(app.chapterRef);
      expect(history[0]).toMatchObject({ pending: true, relevant: false });
      expect(relevantTimers()).toEqual([]);
      expect(settlementReceipt()).not.toBe(null);
      expect(JSON.parse(onDisk()).typesetting.version).toBe(2);
      await EVENTS.unmarked_style();
      await pass(DOC_SAVE_MS);
      expect(JSON.parse(onDisk()).pages[0].boxes[0].style.color).toBe('#123456');
      expect(JSON.parse(onDisk()).typesetting.version).toBe(1);
      checkFile('completed public Inspector color edit under the browser');
    } finally { await cleanupModel(); }
  });

  it.each([
    ['leave mode', ['open2', 'holdWrites', 'leave', 'unmarkedMode'], 'mode'],
    ['open text', ['open1', 'holdTranslations', 'openEmpty', 'edit'], 'text'],
  ])('the exact known browser cancellation witness is retained for %s, with both physical files and its timer', async (_, events, choice) => {
    const result = await run(events);
    expect(result?.deferred).toMatchObject({ startedBrowser: true, acquiredRust: false,
      timer: { ms: DOC_SAVE_MS, unsavedWhenArmed: true, cancelledByMarkSaved: true, bothFilesAtCancellation: true } });
    const witness = result.deferred;
    expect(witness.reason).toContain(`user ${choice} choice`);
    expect(witness.physical).toEqual({ chapter: witness.snapshot.chapter, text: witness.snapshot.text });
    expect(witness.timer.cancelledAt - witness.timer.at).toBeLessThan(DOC_SAVE_MS);
    expect(state.lastRunProof.fullOrder).toEqual(events);
    expect(state.lastRunProof.unexecutedTail).toEqual([]);
  });

  it('acquiring Rust during the same held final browser window never qualifies as a deferred browser witness', async () => {
    const events = ['open1', 'holdWrites', 'leave', 'unmarkedMode', 'switchOn', 'engineStarts', 'writeLands'];
    expect(await run(events)).toBe(null);
    expect(state.lastRunProof.witnesses).toEqual([]);
    expect(state.lastRunProof.windows.some((w) => w.browserAtRequest && w.acquiredRust)).toBe(true);
  });

  it('reopening a saved user choice starts an untouched first-fit cycle without forgetting the historical choice', async () => {
    expect(await run(['switchOn', 'open1', 'editLate', 'open1'])).toBe(null);
  });

  it('a runtime cleaned image URL cannot hide either a wrong live durable filename or a wrong serialized filename', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      const pg = app.pages[0];
      const intended = 'chosen-cleaned.png';
      choose('cleaned', intended, pg);
      pg.cleanedFile = intended;
      pg.cleaned = 'blob:runtime-image-url';
      state.touched = true;
      relayoutAll();
      expect(await until(flushBeforeLeaving('editor'))).toBe(true);
      expect(JSON.parse(onDisk()).pages[0].cleaned).toBe(intended);
      expect(() => choicesLive('live durable cleaned name, despite runtime URL')).not.toThrow();
      expect(() => choicesOnDisk(c, 'serialized durable cleaned name')).not.toThrow();

      pg.cleanedFile = 'wrong-live-cleaned.png';
      expect(() => choicesLive('wrong live durable cleaned name')).toThrow('user cleaned choice');
      pg.cleanedFile = intended;
      const record = JSON.parse(onDisk());
      record.pages[0].cleaned = 'wrong-disk-cleaned.png';
      fsx._tree.files.set(chapterPath, JSON.stringify(record));
      expect(() => choicesOnDisk(c, 'wrong serialized cleaned name')).toThrow('user cleaned choice');
    } finally { await cleanupModel(); }
  });

  it('overlapping public final callers retain actual receipt ownership while two callers still await a later choice', async () => {
    resetHand();
    state.open = false;
    const finals = [];
    const settled = new Set();
    const answers = [];
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      await EVENTS.editLine();
      hand.hold = true;
      for (let i = 0; i < 3; i++) {
        const final = flushBeforeLeaving(i === 1 ? 'quit' : 'editor');
        final.then((answer) => { answers[i] = answer; settled.add(i); }, () => {});
        finals.push(final);
      }
      await pass(0);
      expect(hand.writes).toHaveLength(1);
      await EVENTS.switchOff();
      // Only A lands before the later public edit. B is held and C remains
      // queued, so neither competing outgoing caller has finished its debt.
      hand.writes.shift().ok();
      await pass(0);
      expect(hand.writes).toHaveLength(1);
      expect(settled.has(0)).toBe(true);
      expect(settled.has(1)).toBe(false);
      expect(settled.has(2)).toBe(false);
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe('AAA');
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AAA');
      await EVENTS.editLine();
      expect(app.pages[0].lines[0].en).toBe('AAAA');
      // B's old snapshot lands, and then C's actual current pair. Hold B's
      // follow-up throughout the early assertion. An old stale ledger cannot
      // let C finish even though both physical files contain C's later choice.
      hand.writes.shift().ok();
      await pass(0);
      expect(hand.writes).toHaveLength(1);
      hand.writes.shift().ok();
      await pass(0);
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe('AAAA');
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AAAA');
      expect(hand.writes.length).toBeGreaterThan(0);
      expect(settled.has(2), 'C must finish from its actual both-file receipt while B still waits').toBe(true);
      expect(settled.has(1), 'B still waits for its already queued follow-up').toBe(false);
      // Keep every subsequent writer held. Old source must fail on an extra
      // held writer/pending final before unheld cleanup could enter its loop.
      // Queue coalescing is not the contract. Bound release attempts, keep
      // every writer held, then require all actual receipts/finals to converge.
      for (let i = 0; i < 8 && hand.writes.length; i++) {
        expect(hand.writes).toHaveLength(1);
        hand.writes.shift().ok();
        await pass(0);
      }
      expect(hand.writes, 'current both-file receipts must stop the final queues').toHaveLength(0);
      expect(settled.size, 'all three outgoing finals must settle').toBe(3);
      expect(answers).toEqual([true, true, true]);
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe('AAAA');
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AAAA');
      choicesOnDisk(c, 'independent later choice after all outgoing finals');
      await Promise.all(finals);
    } finally {
      await cleanupModel();
      await Promise.allSettled(finals);
    }
  });

  it('a stale outgoing Rust final ticket cannot settle or stamp the next browser chapter', async () => {
    resetHand();
    state.open = false;
    let final;
    let settled = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      await EVENTS.editLine();
      const outgoing = c;
      hand.hold = true;
      final = flushSave({ settle: true }).then(() => { settled = true; });
      await pass(0);
      expect(hand.writes).toHaveLength(1);
      expect(hand.writes[0].path).toBe(paths(outgoing).chapter);
      // Explicit close invalidates the outgoing identity while its actual
      // both-file saver remains held. No flush/drain precedes the new open.
      closeChapter();
      state.open = false;
      await EVENTS.switchOff();
      adopt(chapters[1]);
      await open(V2);
      const incomingChapter = onDisk();
      const incomingText = textOnDisk();
      await EVENTS.editLine();
      expect(app.typesetting.version).toBe(2);
      hand.writes.shift().ok();
      await pass(0);
      expect(settled, 'a stale outgoing ticket must finish without saving the new identity').toBe(true);
      expect(hand.writes).toHaveLength(0);
      expect(onDisk()).toBe(incomingChapter);
      expect(textOnDisk()).toBe(incomingText);
      expect(JSON.parse(fsx._tree.files.get(paths(outgoing).chapter)).pages[0].lines[0].en).toBe('AAA');
      expect(JSON.parse(fsx._tree.files.get(paths(outgoing).text)).pages[0].lines[0].en).toBe('AAA');
      expect(app.typesetting.version).toBe(2);
      await final;
    } finally {
      await cleanupModel();
      await Promise.allSettled(final ? [final] : []);
    }
  });

  it('an empty chapter Keep does not wait for the previous chapter’s held font', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      expect(hand.fonts.length).toBeGreaterThan(0);
      await EVENTS.openEmpty();
      expect(hand.fonts.length).toBeGreaterThan(0);
      expect(waiting()).toBe(false);
      expect(firstFitChanges()).toMatchObject({ grew: 0, flagged: 0, relaid: 0 });
      const before = hand.began.length;
      const kept = keepFirstFit();
      state.touched = true;
      await until(kept);
      expect(hand.began).toHaveLength(before + 1);
      expect(JSON.parse(onDisk()).typesetting.version).toBe(2);
      checkFile('empty chapter Keep, unrelated font still held');
    } finally {
      await cleanupModel();
    }
  });

  it('a translations write failing after chapter.json cannot claim the whole save landed', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      hand.holdTranslations = true;
      await EVENTS.editLine();
      await pass(DOC_SAVE_MS);
      expect(hand.writes).toHaveLength(1);
      expect(hand.writes[0].path).toBe(translationsPath);
      const oldText = textOnDisk();
      hand.writes.shift().fail(new Error('translations disk full'));
      await pass(0);
      expect(app.saved).toBe(false);
      expect(app.saveFailed).toBe(true);
      expect(textOnDisk()).toBe(oldText);
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe(app.pages[0].lines[0].en);
      hand.holdTranslations = false;
      await until(flushSave());
      expect(app.saved).toBe(true);
      checkFile('after retry, with the slow font still held');
    } finally {
      await cleanupModel();
    }
  });

  it('Keep writes once at its timeout while the font is still absent, then saves its eventual fit', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      await open(V1);
      const before = hand.began.length;
      const kept = keepFirstFit();
      state.touched = true;
      await pass(KEEP_WAIT_MS - 1);
      expect(hand.began).toHaveLength(before);
      expect(firstFitChanges()).toMatchObject({ keeping: true, kept: false });
      await pass(1);
      expect(hand.began).toHaveLength(before + 1);
      expect(firstFitChanges()).toBe(null);
      await until(kept);
      expect(hand.fonts.length).toBeGreaterThan(0);
      expect(hand.began).toHaveLength(before + 1);
      expect(JSON.parse(onDisk()).typesetting.version).toBe(1);
      checkFile('Keep timeout, font never arrived');
      await EVENTS.fontLands();
      await pass(DOC_SAVE_MS);
      expect(hand.began).toHaveLength(before + 2);
      expect(JSON.parse(onDisk()).typesetting.version).toBe(2);
      checkFile('late font after timeout');
    } finally {
      await cleanupModel();
    }
  });

  it('Keep writes at its timeout even when the known geometry and saved number are unchanged', async () => {
    resetHand();
    state.open = false;
    try {
      await EVENTS.switchOn();
      await EVENTS.engineStarts();
      const raw = JSON.parse(V1);
      for (const pg of raw.pages) for (const b of pg.boxes) b.h = 500;
      await open(JSON.stringify(raw));
      expect(waiting()).toBe(true);
      expect(canon(JSON.parse(onDisk()).pages)).toBe(canon(documentNow()));
      const before = hand.began.length;
      const kept = keepFirstFit();
      state.touched = true;
      await pass(KEEP_WAIT_MS - 1);
      expect(hand.began).toHaveLength(before);
      await pass(1);
      expect(hand.began).toHaveLength(before + 1);
      expect(JSON.parse(onDisk()).typesetting.version).toBe(1);
      await until(kept);
      expect(waiting()).toBe(true);
      checkFile('unchanged geometry Keep deadline, font never arrived');
    } finally {
      await cleanupModel();
    }
  });

  // Review findings and mutation-sensitive boundaries, kept by name so they
  // run even when the generator's seed count is zero.
  const FOUND = {
    'original seed20262477 settles concurrent final opens after browser handoff': ['switchOn', 'engineStarts', 'open1', 'switchOn', 'engineStarts', 'edit', 'wait', 'reversePages', 'writeLands', 'holdWrites', 'editLate', 'unmarkedMode', 'engineStarts', 'debounce', 'writeLands', 'open1', 'switchOff', 'writeLands', 'openEmpty', 'fontLands', 'openEmpty', 'debounce', 'unmarkedHandle', 'open2', 'unmarked_cleaned', 'reversePages', 'keep', 'fontLands', 'writeLands', 'fontLands', 'open1', 'writeLands', 'editLate'],
    'the final leave snapshot awaits a fit that lands while it is held': ['switchOn', 'engineStarts', 'open1', 'holdWrites', 'editLate', 'leave', 'fontLands', 'writeLands'],
    'switching off cannot restore over an independently retained handle choice': ['switchOn', 'engineStarts', 'open1', 'unmarkedHandle', 'switchOff'],
    'a held Rust save remains owed after switching off': ['switchOn', 'engineStarts', 'open1', 'holdWrites', 'editLate', 'debounce', 'fontLands', 'switchOff', 'writeLands'],
    'a held Rust save remains owed across off and on': ['switchOn', 'engineStarts', 'open1', 'holdWrites', 'editLate', 'debounce', 'fontLands', 'switchOff', 'switchOn', 'engineStarts', 'writeLands'],
    'Rust acquires an older browser translations snapshot without a pre-switch flush': ['open1', 'holdTranslations', 'editLine', 'debounce', 'editLine', 'switchOn', 'engineStarts', 'writeLands'],
    'a held old chapter save cannot erase the second chapter’s independent choices': ['switchOn', 'engineStarts', 'open1', 'holdWrites', 'editLine', 'debounce', 'editLine', 'open2', 'writeLands', 'writeLands', 'editLine', 'debounce'],
    'an unmarked style reaches disk on leaving': ['switchOn', 'engineStarts', 'open1', 'unmarked_style', 'leave'],
    'an unmarked fit reaches disk on leaving': ['switchOn', 'engineStarts', 'open1', 'unmarked_fit', 'leave'],
    'an unmarked raw filename reaches disk on leaving': ['switchOn', 'engineStarts', 'open1', 'unmarked_file', 'leave'],
    'an unmarked cleaned filename reaches disk on leaving': ['switchOn', 'engineStarts', 'open1', 'unmarked_cleaned', 'leave'],
    'an unmarked page order reaches disk on leaving': ['switchOn', 'engineStarts', 'open1', 'unmarked_order', 'leave'],
    'an offscreen font cannot be stamped ready': ['switchOn', 'engineStarts', 'open1', 'reversePages', 'debounce'],
    'a stale Keep cannot write the next open': ['switchOn', 'engineStarts', 'open1', 'keep', 'openEmpty', 'wait', 'fontLands'],
    'a font lands while a save is in flight': ['switchOn', 'engineStarts', 'open1', 'holdWrites', 'editLate', 'debounce', 'fontLands', 'writeLands'],
    'a save while the engine is still starting, which then grows boxes': ['switchOn', 'open1', 'editLine', 'debounce', 'engineStarts'],
    'Keep while a font is on its way, and the debounce': ['switchOn', 'engineStarts', 'open1', 'keep', 'debounce', 'fontLands'],
  };
  for (const [name, events] of Object.entries(FOUND)) {
    it(`${name}: ${events.join(', ')}`, async () => {
      expect(await run(events)).toBe(null);
    });
  }
});
