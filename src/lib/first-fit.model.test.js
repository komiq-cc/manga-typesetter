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
// This at-rest invariant covers every completed browser and Rust order.
// Successful ordinary leave/open replies must preserve every required choice
// in both files. A deliberate force escape is explicitly unfinished; all
// residual work retains its raw order, choices, debt and unexecuted tail.
// Independently retained user choices must survive automatic fits/restoration in memory
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
const saverObserver = vi.hoisted(() => ({ begin: null, finish: null, boundary: null, reply: null, toast: null, openBoundary: null, openReply: null, scope: null, invocationScope: null, settleScope: null, settleBegin: null, settleFinish: null }));
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
  const { AsyncLocalStorage } = await import('node:async_hooks');
  saverObserver.settleScope = new AsyncLocalStorage();
  const module = await original();
  const originalFlushSave = module.flushSave;
  return { ...module, flushSave(...args) {
    const receipt = args[0]?.settle === true ? saverObserver.settleBegin?.(args) : null;
    try {
      const done = saverObserver.settleScope.run(receipt, () => originalFlushSave(...args));
      if (receipt) receipt.originalPromise = done;
      if (receipt) Promise.resolve(done).then(() => saverObserver.settleFinish?.(receipt, true, undefined),
        (error) => saverObserver.settleFinish?.(receipt, false, error));
      return done;
    } catch (error) { saverObserver.settleFinish?.(receipt, false, error); throw error; }
  }, toast(...args) {
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

const engineObserver = vi.hoisted(() => ({ scope: null, fontScope: null, begin: null, finish: null,
  syncBegin: null, syncBound: null, faceBegin: null, faceFinish: null, disposed: null }));
vi.mock('./engine-switch.svelte.js', async (original) => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  engineObserver.scope = new AsyncLocalStorage();
  const module = await original();
  return { ...module, useTextEngine(...args) {
    const operation = engineObserver.begin?.(args);
    try {
      const done = engineObserver.scope.run(operation, () => module.useTextEngine(...args));
      if (operation) operation.originalPromise = done;
      Promise.resolve(done).then(() => engineObserver.finish?.(operation, true, undefined),
        (error) => engineObserver.finish?.(operation, false, error));
      return done;
    } catch (error) { engineObserver.finish?.(operation, false, error); throw error; }
  } };
});
vi.mock('./text-engine/font-sync.js', async (original) => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  engineObserver.fontScope = new AsyncLocalStorage();
  const module = await original();
  return { ...module, createFontSync(options) {
    const owner = engineObserver.syncBegin?.(options);
    const callback = options.systemFace;
    const actual = callback ? { ...options, systemFace(...args) {
      const call = engineObserver.faceBegin?.(owner, callback, this, args);
      try {
        const done = engineObserver.fontScope.run(call, () => callback.apply(this, args));
        if (call) call.originalPromise = done;
        Promise.resolve(done).then(() => engineObserver.faceFinish?.(call, true, undefined),
          (error) => engineObserver.faceFinish?.(call, false, error));
        return done;
      } catch (error) { engineObserver.faceFinish?.(call, false, error); throw error; }
    } } : options;
    // A synchronous callback during construction still belongs to this token,
    // but becomes authoritative only after this exact constructor returns.
    const sync = module.createFontSync(actual);
    engineObserver.syncBound?.(owner, sync);
    const dispose = sync.dispose;
    sync.dispose = function (...args) {
      const operation = engineObserver.scope?.getStore();
      try {
        const result = dispose.apply(this, args);
        engineObserver.disposed?.(owner, operation, this, args, result, true, undefined);
        return result;
      } catch (error) { engineObserver.disposed?.(owner, operation, this, args, undefined, false, error); throw error; }
    };
    return sync;
  } };
});

const { fsx } = await import('./fsx.js');
const { library, setRoot, createProject, createChapter, openChapter, closeChapter, flushBeforeLeaving, resetSaveFailures, setChapterMode, saveOpenChapter } = await import('./library.svelte.js');
const store = await import('./store.svelte.js');
const { app, autoFitBox, boxEdited, resizeBox, setLineText, markUnsaved, markSaved, flushSave, firstFitChanges, keepFirstFit, relayoutAll, setChapterTypesetMode, useChapterTypesetting, loadProjectPages, DOC_SAVE_MS } = store;
const { defaultStyle } = await import('./data.js');
const { buildTextJson } = await import('./text-json.js');
const { initHistory } = await import('./editor/history.svelte.js');
const { engineSwitch, useTextEngine, _setEngineSwitchDeps, _resetEngineSwitch } = await import('./engine-switch.svelte.js');
const { textEngine, setTextEngine } = await import('./text-engine/index.js');
const { createFontSync } = await import('./text-engine/font-sync.js');
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
  if (args.family === 'Zapfino' && hand.fontHeld) await new Promise((resolve) => {
    const call = engineObserver.fontScope?.getStore();
    const exact = !!call && call.pending && call.originalArgs[0] === args.family && call.originalArgs[1] === args.slot && call.originalArgs[2] === args.known;
    if (call) { call.nativeGates ??= []; call.nativeGates.push(resolve); }
    hand.fonts.push(Object.assign(resolve, { family: args.family, turn: engineTurn,
      heldOrder: ++state.nextObservation, faceSerial: call?.serial ?? null, syncSerial: call?.syncSerial ?? null,
      engineToken: call?.engineToken ?? null, exactCallbackArgs: exact }));
  });
  const file = (FILES[args.family] ?? []).find((f) => args.slot in f.slots);
  if (!file) throw new Error(`no system font '${args.family}'`);
  return systemFaceAnswer(file.slots, file.bytes, { known: args.known });
};
const createEngine = async () => {
  const factory = observeFactory();
  // An obsolete held factory completing later must not advance the turn
  // away from the currently requested engine's held font requests.
  engineTurn++;
  if (hand.startHeld) await new Promise((resolve) => { factory.originalGate = resolve; hand.starts.push(Object.assign(resolve, { factorySerial: factory.serial, operationSerial: factory.operationSerial, heldOrder: ++state.nextObservation })); });
  const engine = fakeRustEngine();
  engine.wrapPlain = (face, text, opts) => fakePlain((part) => engine.advance(face, part), text, opts.width);
  Object.assign(factory, { engine, engineToken: objectToken(engine), pending: false, bound: true, finishOrder: ++state.nextObservation });
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

let modelSwitchDeps;
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
      observed.firedAt = Date.now(); observed.fireOrder = ++state.nextObservation;
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
  _setEngineSwitchDeps(modelSwitchDeps = { available: () => true, createEngine, invoke: async () => invoke, booted: async () => {}, os: () => 'macos' });
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
    write.startOrder = ++state.nextObservation;
    write.at = Date.now();
    if (chapters.some((ch) => path === `${ch.dir}/translations.json`)) {
      finalSnapshot(path, text, null, write);
      if (!hand.holdTranslations) return undefined;
      return new Promise((ok, fail) => {
        const writer = { path, bytes: text, ref: null, ok, fail };
        finalSnapshot(path, text, writer, write);
        hand.writes.push(writer);
      });
    }
    if (!chapters.some((ch) => path === `${ch.dir}/chapter.json`)) return undefined;
    write.started = { path, bytes: text, ref: null, rawWriteSerial: write.serial, version: JSON.parse(text).typesetting?.version ?? null, at: Date.now(), browser: engineSwitch.phase === 'off' };
    hand.began.push(write.started);
    finalSnapshot(path, text, null, write);
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
      finalSnapshot(path, text, writer, write);
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
    save.physicalReceipts.push({ order: ++state.nextObservation, at: Date.now(), path, bytes: text, rawWriteSerial: write.serial, startOrder: write.startOrder,
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
const seen = { sequences: 0, writes: 0, failed: 0, keeps: 0, asOpened: 0, asDocument: 0, left: 0, inapplicablePublicActions: 0, generatedStages: stageCounts(), completedInvariantOrders: 0, exactBrowserWitnessOrders: 0, staleBrowserFinalWitnessOrders: 0, forcedExitWitnessOrders: 0, settledOpenPrefixOrders: 0, settledLeavePrefixOrders: 0, actualFinalOnlyOpenPrefixOrders: 0, unknownFailedOrders: 0, generatedEvents: 0, executedEvents: 0, unexecutedTailEvents: 0 };
const classifiedWitnesses = [];
const classifiedUnknowns = [];
const state = { open: false, opened: null, openedText: null, openedRef: null, openedWrites: 0, touched: false, keep: null, choices: new Map(), rustChapters: new Set(), rustDebt: new Set(), transition: 0, pending: new Set(), finalWindows: [], event: null, witnesses: [], savers: [], timers: new Map(), nextObservation: 0, retirements: new Map(), browserSettlements: new Map(), baselineReceipts: [], failedWriters: [], publicRequests: [], underlyingSettles: [] };
// Object identity is observed without serializing live refs or cyclic contexts.
const refTokens = new WeakMap();
let nextRefToken = 0;
function refToken(ref) {
  if (!ref) return null;
  if (!refTokens.has(ref)) refTokens.set(ref, ++nextRefToken);
  return refTokens.get(ref);
}
// This ledger observes the actual public flushSave promise, separately from
// an outer leave/open reply and separately from model reaction membership.
saverObserver.settleBegin = (args) => {
  const context = saverObserver.scope?.getStore();
  const receipt = { serial: ++state.nextObservation, ref: app.chapterRef, refToken: refToken(app.chapterRef),
    chapterId: app.chapterRef?.chapterId, at: Date.now(), pending: true, originalArgs: args,
    browserAtCall: engineSwitch.phase === 'off' && textEngine()?.id === 'browser',
    debtAtCall: state.rustDebt.has(app.chapterRef?.chapterId), historicalDebtAtCall: [...state.rustDebt], acquiredRust: false,
    observedPublicContextSerial: context?.serial ?? null, observedPublicContextPending: context?.pending ?? false,
    publicRequestSerial: context?.pending && context.ref === app.chapterRef ? context.serial : null };
  state.underlyingSettles.push(receipt);
  return receipt;
};
saverObserver.settleFinish = (receipt, didFulfill, reason) => {
  if (!receipt) return;
  receipt.pending = false; receipt.finishOrder = ++state.nextObservation; receipt.finishedAt = Date.now();
  receipt.fulfilled = didFulfill; receipt.rejected = !didFulfill; receipt.error = reason; receipt.failureReason = reason;
};
const pendingUnderlyingOwned = () => state.underlyingSettles.filter((receipt) => receipt.pending &&
  (!receipt.browserAtCall || receipt.debtAtCall || receipt.acquiredRust));
function failureReasonFacts(reason) {
  if (reason === undefined) return { kind: 'undefined' };
  if (reason === null) return { kind: 'null', value: null };
  const kind = typeof reason;
  return { kind, value: kind === 'object' || kind === 'function' || kind === 'symbol' || kind === 'bigint' ? String(reason?.message ?? reason) : reason };
}
const underlyingSettleFacts = () => state.underlyingSettles.map(({ ref, originalPromise, originalArgs, error, failureReason, ...receipt }) =>
  ({ ...receipt, failureReason: receipt.rejected ? failureReasonFacts(failureReason) : null,
    currentIdentity: ref === app.chapterRef, originalPromiseObserved: !!originalPromise, settleOption: originalArgs[0]?.settle === true }));
// Separate from chapter ownership, generator state, and public model reactions.
// Raw gates remain physically held; only the separate exact unfinished-prefix certificate can scope an obsolete owner.
const engineObservations = { operations: [], factories: [], syncs: [], faces: [] };
const objectTokens = new WeakMap();
let nextObjectToken = 0;
function objectToken(object) {
  if (!object || !['object', 'function'].includes(typeof object)) return null;
  if (!objectTokens.has(object)) objectTokens.set(object, ++nextObjectToken);
  return objectTokens.get(object);
}
engineObserver.begin = (args) => {
  const mode = args[0] === 'rust' ? 'rust' : 'browser';
  const operation = { serial: ++state.nextObservation, at: Date.now(), args, mode, beforeMode: engineSwitch.mode,
    beforePhase: engineSwitch.phase, beforeEngine: textEngine(), beforeEngineToken: objectToken(textEngine()),
    ref: app.chapterRef, refToken: refToken(app.chapterRef), pending: true, nonNoop: mode !== engineSwitch.mode };
  if (mode === 'rust' && operation.nonNoop)
    for (const receipt of state.underlyingSettles) if (receipt.pending && receipt.ref === app.chapterRef) receipt.acquiredRust = true;
  engineObservations.operations.push(operation);
  return operation;
};
engineObserver.finish = (operation, didFulfill, reason) => {
  if (!operation) return;
  Object.assign(operation, { pending: false, fulfilled: didFulfill, rejected: !didFulfill, failureReason: reason, replyOrder: ++state.nextObservation, replyAt: Date.now(),
    afterMode: engineSwitch.mode, afterPhase: engineSwitch.phase,
    afterEngineToken: objectToken(textEngine()) });
};
function observeFactory() {
  const operation = engineObserver.scope?.getStore();
  const factory = { serial: ++state.nextObservation, at: Date.now(), operation,
    operationSerial: operation?.serial ?? null, activeRustContext: !!operation?.pending && operation.mode === 'rust' && operation.nonNoop,
    pending: true, bound: false };
  engineObservations.factories.push(factory);
  return factory;
}
engineObserver.syncBegin = (options) => {
  const operation = engineObserver.scope?.getStore();
  const candidates = engineObservations.factories.filter((factory) => factory.bound && factory.engine === options.engine && factory.operation === operation);
  const factory = candidates.length === 1 && operation?.pending && operation.mode === 'rust' && operation.nonNoop ? candidates[0] : null;
  const owner = { serial: ++state.nextObservation, at: Date.now(), engine: options.engine, engineToken: objectToken(options.engine),
    operation, operationSerial: operation?.serial ?? null, factorySerial: factory?.serial ?? null,
    factoryBinding: factory ? 'exact-active-operation-engine' : candidates.length > 1 ? 'ambiguous' : 'unbound',
    originalOptions: options, originalCallback: options.systemFace, bound: false, disposed: false, disposals: [] };
  engineObservations.syncs.push(owner);
  return owner;
};
engineObserver.syncBound = (owner, sync) => {
  if (owner) Object.assign(owner, { sync, syncToken: objectToken(sync), bound: true, boundOrder: ++state.nextObservation });
};
engineObserver.faceBegin = (owner, callback, thisArg, args) => {
  const call = { serial: ++state.nextObservation, at: Date.now(), owner, syncSerial: owner?.serial ?? null,
    engineToken: owner?.engineToken ?? null, originalCallback: callback, thisArg, originalArgs: args, pending: true,
    constructorBoundAtCall: owner?.bound ?? false };
  engineObservations.faces.push(call);
  return call;
};
engineObserver.faceFinish = (call, didFulfill, reason) => {
  if (call) Object.assign(call, { pending: false, finishOrder: ++state.nextObservation,
    fulfilled: didFulfill, rejected: !didFulfill, failureReason: reason });
};
engineObserver.disposed = (owner, operation, thisArg, args, result, didReturn, reason) => {
  if (!owner) return;
  const observation = { order: ++state.nextObservation, at: Date.now(), operationSerial: operation?.serial ?? null,
    operationPending: operation?.pending ?? false, operationMode: operation?.mode ?? null, nonNoop: operation?.nonNoop ?? false,
    thisMatches: thisArg === owner.sync, originalArgs: args, originalResult: result,
    returned: didReturn, threw: !didReturn, failureReason: reason, error: didReturn ? null : String(reason?.message ?? reason) };
  owner.disposals.push(observation);
  if (didReturn && thisArg === owner.sync) { owner.disposed = true; owner.disposeOrder = observation.order; }
};
function engineOwnershipFacts() {
  return {
    operations: engineObservations.operations.map(({ originalPromise, args, beforeEngine, ref, failureReason, ...operation }) =>
      ({ ...operation, failureReason: operation.rejected ? failureReasonFacts(failureReason) : null, originalPromiseObserved: !!originalPromise, args: [...args] })),
    factories: engineObservations.factories.map(({ operation, engine, originalGate, ...factory }) => factory),
    syncs: engineObservations.syncs.map(({ operation, engine, sync, originalOptions, originalCallback, disposals, ...owner }) =>
      ({ ...owner, hasOriginalCallback: typeof originalCallback === 'function', disposals: disposals.map(({ originalResult, originalArgs, failureReason, ...disposal }) =>
        ({ ...disposal, failureReason: disposal.threw ? failureReasonFacts(failureReason) : null, args: [...originalArgs], resultKind: typeof originalResult })) })),
    faces: engineObservations.faces.map(({ owner, originalCallback, thisArg, originalArgs, originalPromise, nativeGates, failureReason, ...call }) =>
      ({ ...call, failureReason: call.rejected ? failureReasonFacts(failureReason) : null, syncToken: owner?.syncToken ?? null, ownerBound: owner?.bound ?? false, ownerDisposed: owner?.disposed ?? false,
        nativeGateCount: nativeGates?.length ?? 0, callbackMatches: originalCallback === owner?.originalCallback, args: copy(originalArgs), originalPromiseObserved: !!originalPromise })),
    heldStarts: hand.starts.map((gate) => ({ factorySerial: gate.factorySerial ?? null, operationSerial: gate.operationSerial ?? null, heldOrder: gate.heldOrder ?? null })),
    heldFonts: hand.fonts.map((gate) => ({ faceSerial: gate.faceSerial ?? null, syncSerial: gate.syncSerial ?? null,
      engineToken: gate.engineToken ?? null, heldOrder: gate.heldOrder ?? null, exactCallbackArgs: gate.exactCallbackArgs ?? false })) };
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
  request.rejectedReason = error;
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
    underlyingSettleSerial: saverObserver.settleScope?.getStore()?.serial ?? null,
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
  receipt.failedReason = error;
};
const relevantTimers = (ref = app.chapterRef) => [...state.timers.values()].filter((timer) => timer.pending && timer.relevant && timer.ref === ref);
const pendingSavers = (ref = app.chapterRef) => state.savers.filter((save) => save.pending && save.ref === ref);
const pendingOwnedFinals = (ref = app.chapterRef) => state.finalWindows.filter((window) => window.pending && window.ref === ref && (window.debtAtRequest || !window.browserAtRequest || window.acquiredRust));
function settlementReceipt() {
  if (!live() || pendingUnderlyingOwned().length || state.pending.size || state.publicRequests.some((request) => request.pending) || state.savers.some((save) => save.pending) || pendingOwnedFinals().length ||
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
  return { kind: currentDocument ? 'current-document' : 'untouched-opened', chapterId: c.id, ref: app.chapterRef, refToken: refToken(app.chapterRef), order: ++state.nextObservation,
    chapter: onDisk(), text: textOnDisk(), writes: hand.began.length, at: Date.now(), event: state.event,
    chapterPath, textPath: translationsPath, identityAtSettlement: { projectId: app.chapterRef.projectId, chapterId: app.chapterRef.chapterId, mode: app.chapterMode, typesetting: copy(app.typesetting), pages: documentNow().map(({ id, file, cleaned }) => ({ id, file, cleaned })) }, choiceCut: copy([...state.choices].map(([id, choices]) => [id, [...choices]])),
    physicalCut: chapters.map((chapter) => ({ chapterId: chapter.id, chapter: fsx._tree.files.get(paths(chapter).chapter), text: fsx._tree.files.get(paths(chapter).text) })) };
}
const live = () => state.open && app.loaded && app.chapterRef?.chapterId === c.id;
const copy = (v) => JSON.parse(JSON.stringify(v));
const paths = (ch) => ({ chapter: `${ch.dir}/chapter.json`, text: `${ch.dir}/translations.json` });
function adopt(ch) {
  c = ch;
  ({ chapter: chapterPath, text: translationsPath } = paths(ch));
}
function resetFiles() {
  // Never erase an actually outstanding underlying final at a new fixture.
  state.underlyingSettles = state.underlyingSettles.filter((receipt) => receipt.pending);
  engineObservations.operations = engineObservations.operations.filter((operation) => operation.pending);
  engineObservations.factories = engineObservations.factories.filter((factory) => factory.pending || factory.engine === textEngine());
  engineObservations.syncs = engineObservations.syncs.filter((owner) => !owner.disposed);
  engineObservations.faces = engineObservations.faces.filter((call) => call.pending);
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
    debtAtRequest: state.rustDebt.has(c.id), historicalDebtAtRequest: [...state.rustDebt], acquiredRust: false,
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
function finalSnapshot(path, text, writer = null, write = null) {
  const save = invocationAt(path);
  if (!save) return;
  if (writer) Object.assign(writer, { saverSerial: save.serial, ref: save.ref, refToken: save.refToken, rawWriteSerial: write?.serial, startOrder: write?.startOrder, at: write?.at });
  const p = paths(chapters.find((chapter) => chapter.id === save.chapterId));
  if (path === p.chapter && !save.snapshot) {
    Object.assign(hand.began.at(-1), { ref: save.ref, refToken: save.refToken, saverSerial: save.serial });
    save.snapshot = { chapter: text, text: null, chapterPath: p.chapter, textPath: p.text,
      writeIndex: hand.began.length - 1, saverSerial: save.serial, refToken: save.refToken,
      chapterStartOrder: write?.startOrder, chapterRawWriteSerial: write?.serial,
      earlierChoices: copy([...state.choices.get(save.chapterId) ?? []]),
      startedBrowser: save.browser, debtAtSnapshot: state.rustDebt.has(save.chapterId), at: Date.now() };
  }
  if (!save.snapshot) return;
  if (path === p.text && save.snapshot.text == null) { save.snapshot.text = text; save.snapshot.textStartOrder = write?.startOrder; save.snapshot.textRawWriteSerial = write?.serial; }
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
  // A refusal which arrives after this request started cannot authorize it.
  // Generation is the observed public-operation cycle; no private documentTurn is inferred.
  const prior = state.finalWindows.findLast((old) => old !== window && old.ref === window.ref &&
    old.generation === window.generation && old.publicRequest?.generation === request.generation &&
    old.publicRequest?.ref === request.ref && old.publicRequest?.where === 'editor' && old.publicRequest?.answer === false &&
    old.publicRequest.replyOrder < request.serial && old.publicRequest.emissions.some((emission) => emission.currentIdentity &&
      emission.message.startsWith('Could not save: staying in the editor.')));
  if (!prior) return null;
  const failures = state.savers.filter((save) => save.ref === window.ref && save.failed === 'disk full' &&
    [prior.publicRequest.serial, request.serial].includes(save.publicRequestSerial));
  if (failures.length !== 2 || failures[0].publicRequestSerial !== prior.publicRequest.serial ||
      failures[1].publicRequestSerial !== request.serial || failures[0].finishOrder >= failures[1].finishOrder || !failures.every((save) => state.failedWriters.some((writer) =>
        writer.ref === window.ref && writer.saverSerial === save.serial)) || state.savers.some((save) => save.ref === window.ref &&
        save.bothFileReceipt?.order > failures[0].finishOrder && save.bothFileReceipt.order < force.order) ||
      state.publicRequests.some((reply) => reply.ref === window.ref && (reply.answer === true || reply.fulfilled === true) &&
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


// Model reactions remain distinct from each public operation’s original promise.
function pendingOperationFacts() {
  return [...state.pending].map((promise) => {
    const request = state.publicRequests.find((request) => request.originalPromise === promise);
    return { publicRequestSerial: request?.serial ?? null, kind: request?.kind ?? null, unmatched: !request, modelReactionPending: true, publicRequestPending: request?.pending ?? null, publicRequestFulfilled: request?.fulfilled ?? null };
  });
}




function deferObservedBoundary(window, ch) {
  // Only the actual deliberate force escape is an unfinished prefix.
  // A fulfilled open or TRUE ordinary leave with missing pre-reply choices
  // remains a failure even when its later writer or model reaction is pending.
  let witness = observedForcedExit(window, ch);
  if (!witness) return false;
  const ownedSerials = new Set(pendingUnderlyingOwned().map((receipt) => receipt.serial));
  witness = { ...witness,
    pendingOwnedUnderlyingSettles: underlyingSettleFacts().filter((receipt) => ownedSerials.has(receipt.serial)),
    classificationCutModelReactions: pendingOperationFacts(), currentRustDebt: [...state.rustDebt],
    completedInvariantOrder: false, debtRetired: false, incompletePrefix: true };
  // Deliberate force cannot excuse a loss on another historical chapter.
  try { for (const other of chapters) if (other.id !== ch.id) choicesOnDisk(other, 'unrelated chapter before a classified prefix'); }
  catch (error) { if (error instanceof Broken) return false; throw error; }
  if (!window.counted) { window.counted = true; state.witnesses.push(witness); }
  // Keep all intent, debt, pending work and the unexecuted tail as obligations.
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
// Only the exact controlled failed writer and original rejected open may explain this error.
// Generation-mismatched saver public attribution stays null; the actual underlying binding is required.
function ownInjectedOpenFailure(operation, originalPromise, error) {
  if (!operation || operation.kind !== 'open' || operation.originalPromise !== originalPromise ||
      operation.fulfilled !== false || operation.rejectedReason !== error || operation.rejected == null) return false;
  const injected = state.failedWriters.filter((writer) => writer.error === error);
  if (injected.length !== 1) return false;
  const writer = injected[0];
  const saves = state.savers.filter((save) => save.serial === writer.saverSerial && save.ref === writer.ref &&
    save.pending === false && save.failedReason === error && save.originalPromise);
  if (saves.length !== 1) return false;
  const save = saves[0];
  const settles = state.underlyingSettles.filter((settle) => settle.serial === save.underlyingSettleSerial &&
    settle.ref === save.ref && settle.ref === operation.ref && settle.publicRequestSerial === operation.serial &&
    settle.pending === false && settle.rejected === true && settle.fulfilled === false && settle.error === error && settle.originalPromise);
  if (settles.length !== 1) return false;
  const settle = settles[0];
  const snapshot = save.snapshot;
  const rawWriteSerial = writer.path === snapshot?.chapterPath ? snapshot.chapterRawWriteSerial
    : writer.path === snapshot?.textPath ? snapshot.textRawWriteSerial : null;
  const startOrder = writer.path === snapshot?.chapterPath ? snapshot.chapterStartOrder
    : writer.path === snapshot?.textPath ? snapshot.textStartOrder : null;
  return writer.refToken === save.refToken && writer.rawWriteSerial != null && writer.rawWriteSerial === rawWriteSerial &&
    writer.startOrder != null && writer.startOrder === startOrder &&
    writer.order < save.finishOrder && save.finishOrder < settle.finishOrder && settle.finishOrder < operation.replyOrder;
}

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
    // The catch may also receive an error thrown by the fulfilled-open reaction.
    // The current document's indicator does not establish this older caller's failure.
    else if (!ownInjectedOpenFailure(operation, request, error)) hand.broke ??= `opening: ${error?.message ?? error}`;
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
    if (w) {
      const error = new Error('disk full');
      seen.failed++; state.failedWriters.push({ order: ++state.nextObservation, ref: w.ref, refToken: w.refToken, saverSerial: w.saverSerial,
        rawWriteSerial: w.rawWriteSerial, startOrder: w.startOrder, path: w.path, bytes: w.bytes, at: Date.now(), error });
      w.fail(error);
    }
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
    const priorFit = field === 'fit' ? canon(app.pages[0].boxes[0].fit) : null;
    change();
    if (field !== 'fit' || priorFit !== canon(app.pages[0].boxes[0].fit)) state.touched = true;
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

async function run(events, privatePrepare = null) {
  resetHand();
  state.open = false;
  state.keep = null;
  state.deferred = null;
  state.finalWindows = [];
  state.witnesses = [];
  resetFiles();
  if (privatePrepare) await privatePrepare();
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
    if (state.underlyingSettles.some((receipt) => receipt.pending) || state.pending.size || state.publicRequests.some((request) => request.pending) || hand.writes.length || hand.fonts.length || hand.starts.length ||
        state.savers.some((save) => save.pending) || [...state.timers.values()].some((timer) => timer.pending && timer.relevant) ||
        firstFitChanges()?.keeping || engineSwitch.phase === 'starting' || waiting()) {
      throw new Broken('coming to rest: residual public transition, saver, writer, timer, font, engine start, or Keep');
    }
    retireBrowserDebt();
    if (hand.broke) throw new Broken(hand.broke);
    if (live()) {
      // No rescue flush: every completed browser or Rust order must satisfy
      // the existing BOTH-file, ALL-choice and verified untouched-opened rules.
      checkFile('at rest');
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
    if (e instanceof DeferredBrowser) return { deferred: copy(e.witness) };
    if (!(e instanceof Broken)) throw new Error(`${at}: ${e?.stack ?? e}`);
    return `${e.message}`;
  } finally {
    state.lastRunStages = stages;
    const timerRecord = (timer) => timer && Object.fromEntries(Object.entries(timer).filter(([key]) => key !== 'id' && key !== 'ref'));
    state.lastRunProof = copy({ boundaryOrder: state.nextObservation, fullOrder: [...events], executedPrefix: events.slice(0, executed), unexecutedTail: events.slice(executed),
      stages: copy(stages), windows: state.finalWindows.map((w) => ({ kind: w.kind, chapterId: w.chapter.id, refToken: w.refToken, generation: w.generation, targetId: w.targetId, fulfilled: w.fulfilled, saverSerials: w.saverSerials, attributionAmbiguous: w.attributionAmbiguous, browserAtRequest: w.browserAtRequest,
        currentIdentity: w.ref === app.chapterRef, debtAtRequest: w.debtAtRequest, historicalDebtAtRequest: w.historicalDebtAtRequest, acquiredRust: w.acquiredRust, pending: w.pending, cleanAtRequest: w.cleanAtRequest,
        publicRequest: w.publicRequest && (({ ref, incomingRef, originalPromise, window, ...request }) => request)(w.publicRequest), saverSerial: w.saver?.serial, replyAt: w.replyAt, retirement: w.retirement && (({ ref, ...receipt }) => receipt)(w.retirement), answer: w.answer, toast: w.toast, rejected: w.rejected, snapshot: w.snapshot,
        laterChoices: [...w.laterChoices], timer: timerRecord(w.timer) })), witnesses: copy(state.witnesses),
      underlyingSettles: underlyingSettleFacts(), engineOwnership: engineOwnershipFacts(),
      publicRequests: state.publicRequests.map(({ ref, incomingRef, originalPromise, window, ...request }) => ({ ...request, currentIdentity: ref === app.chapterRef })),
      savers: state.savers.map(({ ref, originalPromise, window, ...save }) => ({ ...save, currentIdentity: ref === app.chapterRef })),
      timers: [...state.timers.values()].map(timerRecord),
      baselineReceipts: state.baselineReceipts.map(({ ref, ...receipt }) => receipt),
      browserSettlements: [...state.browserSettlements].map(([id, { ref, ...receipt }]) => [id, { ...receipt, currentIdentity: ref === app.chapterRef }]),
      facts: { chapterId: app.chapterRef?.chapterId, projectId: app.chapterRef?.projectId, modelChapterId: c?.id,
        liveDocument: copy(documentNow()), liveTranslations: buildTextJson(app.pages), typesetting: copy(app.typesetting),
        mode: app.chapterMode, engine: { mode: engineSwitch.mode, phase: engineSwitch.phase, id: textEngine()?.id },
        openedRefCurrent: state.openedRef === app.chapterRef, firstFit: firstFitChanges(), gates: { fonts: hand.fonts.length, starts: hand.starts.length, writers: hand.writes.length }, touched: state.touched, saved: app.saved, saveFailed: app.saveFailed,
        pendingTransitions: state.pending.size, heldWriters: hand.writes.map(({ path, bytes, saverSerial, refToken, rawWriteSerial, startOrder, at }) => ({ path, bytes, saverSerial, refToken, rawWriteSerial, startOrder, at })),
        modelReactionsAtRunCut: pendingOperationFacts(),
        choices: [...state.choices].map(([id, choices]) => [id, [...choices]]), rustDebt: [...state.rustDebt],
        failedWriters: state.failedWriters.map(({ ref, ...writer }) => writer),
        physical: chapters.map((ch) => ({ chapterId: ch.id, chapter: fsx._tree.files.get(paths(ch).chapter), text: fsx._tree.files.get(paths(ch).text) })) } });
    await cleanupModel();
  }
}

const STARTUP_CLOSE_ORDERS = [[20262691, ["switchOn", "open1", "unmarked_fit", "editLate", "writeFails", "unmarkedMode", "writeLands", "fontLands", "holdTranslations", "leave", "reversePages", "holdWrites", "fontLands", "edit", "unmarked_file", "engineStarts", "holdWrites", "keep", "debounce", "unmarkedHandle", "editLate", "writeLands", "debounce", "writeLands", "edit", "switchOff", "switchOff", "reversePages", "unmarkedHandle", "writeLands", "switchOn", "holdWrites"]], [20263661, ["switchOn", "open2", "holdWrites", "unmarkedHandle", "reversePages", "writeLands", "unmarked_fit", "unmarkedHandle", "unmarkedMode", "editLine", "holdWrites", "writeLands", "holdTranslations", "editLate", "unmarkedMode", "writeLands", "fontLands", "debounce", "debounce", "unmarked_style", "holdWrites", "editLine", "keep", "writeFails", "debounce", "debounce", "leave", "switchOff", "keep", "writeFails", "switchOn", "switchOn", "debounce"]], [20264358, ["switchOn", "open1", "writeLands", "editLate", "debounce", "reversePages", "writeLands", "fontLands", "fontLands", "fontLands", "fontLands", "open2", "open2", "switchOff", "wait", "holdTranslations", "debounce", "editLine", "editLine", "editLine", "fontLands", "debounce", "switchOff", "keep", "leave", "writeLands", "switchOn", "keep", "editLate", "writeLands", "holdWrites", "debounce"]], [20265531, ["switchOn", "engineStarts", "open1", "holdWrites", "reversePages", "unmarkedMode", "writeLands", "edit", "holdWrites", "editLine", "wait", "editLine", "leave", "keep", "engineStarts", "editLine", "writeLands", "editLine", "holdWrites", "switchOff", "editLate", "writeLands", "holdWrites", "switchOff", "editLate", "keep", "holdWrites", "fontLands", "editLate", "switchOn", "unmarkedMode", "reversePages", "reversePages", "writeLands"]]];

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

// A named receipt fixture, separate from original1358's preserved schedule.
// Establish actual other-chapter intent, then reopen literal saved geometry
// under the browser after a prior Rust cycle at this same durable identity.
async function openedBrowserReflow() {
  resetHand(); state.open = false;
  await EVENTS.openEmpty();
  app.pages.reverse(); choose('order', app.pages.map((pg) => pg.id));
  markUnsaved(); await pass(DOC_SAVE_MS);
  choicesOnDisk(chapters[2], 'actual other-chapter order before reflow');
  await EVENTS.open1(); await EVENTS.switchOn(); await EVENTS.engineStarts();
  await open(V2); await EVENTS.switchOff();
  const raw = JSON.parse(V1);
  Object.assign(raw.pages[0].boxes.find((box) => box.id === 'late'), { text: 'AAAA BBBB CC', h: 48 });
  await open(JSON.stringify(raw));
  const late = app.pages[0].boxes.find((box) => box.id === 'late');
  expect(state.touched).toBe(false);
  expect(JSON.parse(onDisk()).pages[0].boxes.find((box) => box.id === 'late').h).toBe(48);
  expect(late.h).toBe(70);
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
        if (category === 'explicit-forced-exit') seen.forcedExitWitnessOrders++;
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
      console.log(`unfinished explicit-force orders: ${classifiedWitnesses.length}; full order/prefix/tail and both-file records require explicit MODEL_WITNESS_OUT`);
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

  it('assigning the already saved canonical fit retains untouched first-fit bytes and every historical choice', async () => {
    resetHand(); state.open = false;
    try {
      const raw = JSON.parse(V1);
      const fit = { kind: 'rect', x: 0, y: 0, w: 120, h: 80 };
      raw.pages[0].boxes[0].fit = fit;
      await open(JSON.stringify(raw)); choose('fit', fit);
      const history = copy([...state.choices].map(([id, choices]) => [id, [...choices]]));
      const chapter = onDisk(), text = textOnDisk(), writes = hand.began.length;
      await EVENTS.switchOn(); await EVENTS.engineStarts();
      const debt = [...state.rustDebt];
      await EVENTS.unmarked_fit(); await pass(DOC_SAVE_MS);
      expect(state.touched, 'same canonical user field is not a new edit').toBe(false);
      expect(onDisk()).toBe(chapter); expect(textOnDisk()).toBe(text); expect(hand.began.length).toBe(writes);
      expect([...state.choices].map(([id, choices]) => [id, [...choices]])).toEqual(history);
      expect([...state.rustDebt]).toEqual(debt);
      expect(state.keep).toBe(null);
      expect(() => choicesOnDisk(c, 'same fit retains all independent intent')).not.toThrow();
      expect(() => checkFile('same-fit first-fit exemption')).not.toThrow();
    } finally { await cleanupModel(); }
  });

  it.each([null, { kind: 'rect', x: 3, y: 4, w: 90, h: 60 }])('a genuinely different fit %j is touched and naturally persists BOTH at version2', async (priorFit) => {
    resetHand(); state.open = false;
    try {
      const raw = JSON.parse(V1); raw.pages[0].boxes[0].fit = priorFit;
      await open(JSON.stringify(raw)); hand.fontHeld = false;
      await EVENTS.switchOn(); await EVENTS.engineStarts();
      await EVENTS.unmarked_fit();
      expect(state.touched).toBe(true);
      await pass(DOC_SAVE_MS);
      expect(JSON.parse(onDisk()).typesetting.version).toBe(2);
      expect(JSON.parse(onDisk()).pages[0].boxes[0].fit).toEqual({ kind: 'rect', x: 0, y: 0, w: 120, h: 80 });
      expect(() => choicesOnDisk(c, 'true fit edit remains required in BOTH')).not.toThrow();
      expect(() => checkFile('true fit edit version')).not.toThrow();
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
      const baselineCount = state.baselineReceipts.length;
      const choices = copy([...state.choices].map(([id, values]) => [id, [...values]]));
      const opened = onDisk(); const openedText = textOnDisk(); const writes = hand.began.length;
      expect(state.openedRef).toBe(app.chapterRef);
      for (const chapter of chapters) choicesOnDisk(chapter, 'all historical choices before reflow retirement');
      retireBrowserDebt();
      expect(state.rustDebt.has(c.id)).toBe(false);
      expect(state.retirements.get(c.id)).toMatchObject({ kind: 'untouched-opened', ref: app.chapterRef, chapter: opened, text: openedText, writes });
      expect(state.browserSettlements.get(c.id)?.retiredRustDebt).toBe(true);
      await EVENTS.switchOn();
      expect(state.baselineReceipts).toHaveLength(baselineCount + 1);
      expect(state.baselineReceipts.at(-1)).toMatchObject({ kind: 'untouched-opened', ref: state.openedRef, chapter: opened, text: openedText, writes });
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
        const priorBaselines = [...state.baselineReceipts];
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
        expect(state.baselineReceipts).toEqual(priorBaselines);
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
      expect(receipt.refToken).toBe(refToken(app.chapterRef));
      expect(receipt.order).toBeGreaterThan(0);
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

  it('an overlapping public open waits for both files containing every later choice', async () => {
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
      hand.writes.shift().ok(); await pass(0);
      expect(state.publicRequests.find((request) => request.originalPromise === state.lastOpen).pending, 'old BOTH cannot approve a later choice').toBe(true);
      expect(() => choicesOnDisk(window.chapter, 'old receipt is still behind')).toThrow(Broken);
      await rest(); await until(state.lastOpen);
      expect(state.deferred).toBe(null);
      choicesOnDisk(window.chapter, 'completed actual open retains every later choice');
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
      hand.writes.shift().ok(); await pass(0);
      expect(state.deferred, 'a late same-key waiver must not conceal the earlier missing AAA').toBe(null);
      const window = state.finalWindows.at(-1);
      expect(earlierChoicesPresent(window, window.snapshot.chapter, window.snapshot.text)).toBe(false);
      expect(window.snapshot.earlierChoices.find(([, choice]) => choice.kind === 'translation')[1].value).toBe('AAA');
      await rest(); await until(state.lastOpen);
      choicesOnDisk(window.chapter, 'later actual follow-up does not erase the earlier snapshot evidence');
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
      saverObserver.invocationScope.run(clearKind === 'expired invocation' ? finished : undefined, () => markSaved());
      hand.writes.shift().ok(); await pass(0);
      expect(state.publicRequests.find((request) => request.originalPromise === state.lastOpen).pending).toBe(true);
      expect(() => choicesOnDisk(window.chapter, 'unrelated markSaved does not approve stale bytes')).toThrow(Broken);
      expect(state.deferred, 'only the still-active exact final saver may prove this cancellation').toBe(null);
      expect(window.timer).toMatchObject({ cancelledByMarkSaved: true, saverContextPending: false, clearerSource: 'markSaved' });
      expect(observedBrowserCancellation(window, window.chapter)).toBe(null);
      await rest(); await until(state.lastOpen);
      choicesOnDisk(window.chapter, 'actual final repairs a misleading clear before returning');
    } finally { await cleanupModel(); }
  });

  it('the original incoming LOAD order preserves every outgoing choice before adoption', async () => {
    const events = sequence(20261094, 30);
    expect(await run(events)).toBe(null);
    expect(state.lastRunProof.fullOrder).toEqual(events);
    expect(state.lastRunProof.unexecutedTail).toEqual([]);
    expect(state.lastRunProof.witnesses).toEqual([]);
    expect(state.lastRunProof.facts.choices.length).toBeGreaterThan(0);
  });

  it.each([[20261094, 'chapter'], [20262168, 'translations']])('original%s completes its formerly held %s boundary with every retained choice', async (seed) => {
    const events = sequence(seed, 30);
    expect(await run(events)).toBe(null);
    expect(state.lastRunProof.fullOrder).toEqual(events);
    expect(state.lastRunProof.unexecutedTail).toEqual([]);
    expect(state.lastRunProof.witnesses).toEqual([]);
    expect(state.lastRunProof.facts.gates).toEqual({ fonts: 0, starts: 0, writers: 0 });
  });

  it.each(['chapter', 'translations'])('a genuinely pending public final proof retains its actual held %s cut before cleanup', async (heldFile) => {
    const originalWriteLands = EVENTS.writeLands;
    const events = ['open1', 'holdWrites', 'holdTranslations', 'leave', 'editLine', 'writeLands'];
    let captured;
    try {
      EVENTS.writeLands = async () => {
        originalWriteLands(); await pass(0);
        originalWriteLands(); await pass(0);
        if (heldFile === 'translations') { originalWriteLands(); await pass(0); }
        const held = hand.writes[0];
        expect(held.path.endsWith(`/${heldFile}.json`)).toBe(true);
        const save = state.savers.find((save) => save.serial === held.saverSerial);
        expect(state.publicRequests.find((request) => request.kind === 'leave').pending, 'required follow-up must precede TRUE').toBe(true);
        if (heldFile === 'chapter') {
          expect(save.snapshot.text).toBe(null);
          choicesIn(save.chapterId, JSON.parse(held.bytes), null, 'pending actual chapter contains independent choices', new Set(), false);
        } else {
          choicesIn(save.chapterId, JSON.parse(onDisk()), JSON.parse(held.bytes), 'actual chapter and held TX contain independent choices');
        }
        captured = { serial: save.serial, clears: [...state.timers.values()].flatMap((timer) => timer.clears ?? []).length };
        hand.broke = 'named genuine pending cut';
      };
      expect(await run(events)).toBe('named genuine pending cut');
      const saved = state.lastRunProof.savers.find((save) => save.serial === captured.serial);
      const completed = state.savers.find((save) => save.serial === captured.serial);
      if (heldFile === 'chapter') {
        expect(saved.snapshot.text, 'cleanup must not supply unstarted TX').toBe(null);
        expect(saved.physicalReceipts ?? []).toEqual([]);
      } else {
        expect(saved.physicalReceipts).toHaveLength(1);
        expect(saved.snapshot.text).not.toBe(null);
      }
      expect(saved.bothFileReceipt).toBeUndefined();
      expect(completed.physicalReceipts).toHaveLength(2);
      expect(completed.snapshot.text).not.toBe(null);
      expect(state.lastRunProof.timers.flatMap((timer) => timer.clears ?? [])).toHaveLength(captured.clears);
      expect(saved.snapshot).not.toBe(completed.snapshot);
    } finally { EVENTS.writeLands = originalWriteLands; }
  });

  it('private underlying direct settle preserves the exact options, returned promise and rejected Error', async () => {
    resetHand(); state.open = false;
    let pending;
    try {
      await EVENTS.switchOn(); await EVENTS.engineStarts(); hand.fontHeld = false;
      await open(V1); await EVENTS.editLine(); hand.hold = true;
      const options = { settle: true };
      pending = flushSave(options); pending.catch(() => {}); await pass(0);
      const receipt = state.underlyingSettles.find((receipt) => receipt.originalPromise === pending);
      expect(receipt, 'direct public final must remain owned while its actual writer is held').toBeDefined();
      expect(pendingUnderlyingOwned()).toContain(receipt);
      expect(settlementReceipt(), 'held underlying final cannot retire through a saved-looking receipt').toBe(null);
      const error = new Error('exact direct underlying failure');
      hand.writes.shift().fail(error);
      await expect(pending).rejects.toBe(error); await pass(0);
      expect(receipt.pending).toBe(false); expect(receipt.error).toBe(error);
      expect(receipt.originalArgs[0]).toBe(options);
      expect(receipt.originalPromise).toBe(pending);
    } finally { await cleanupModel(); if (pending) await until(pending).catch(() => {}); }
  });

  it('private a false timed-out outer leave cannot release its still-pending underlying Rust final on another ref', async () => {
    resetHand(); state.open = false;
    let outer, actual;
    try {
      await EVENTS.switchOn(); await EVENTS.engineStarts(); hand.fontHeld = false;
      await open(V1); await EVENTS.editLine(); hand.hold = true;
      const outgoing = app.chapterRef;
      outer = flushBeforeLeaving('editor'); await pass(0);
      const request = state.publicRequests.find((request) => request.originalPromise === outer);
      const receipt = state.underlyingSettles.find((receipt) => receipt.publicRequestSerial === request.serial);
      actual = receipt.originalPromise; actual.catch(() => {});
      await pass(10000);
      expect(await until(outer)).toBe(false);
      expect(receipt.pending, 'timeout is the outer answer, not an underlying final settlement').toBe(true);
      expect(pendingUnderlyingOwned()).toContain(receipt);
      closeChapter(); state.open = false; await EVENTS.switchOff(); adopt(chapters[1]); await open(V2);
      expect(app.chapterRef).not.toBe(outgoing);
      expect(settlementReceipt(), 'a quiet incoming chapter cannot hide an old-ref owned final').toBe(null);
      retireBrowserDebt(); expect(state.browserSettlements.get(c.id)).toBeUndefined();
      expect(receipt.ref).toBe(outgoing); expect(receipt.publicRequestSerial).toBe(request.serial);
      expect(request.pending).toBe(false); expect(request.answer).toBe(false);
      expect(state.pending.has(actual), 'underlying ownership is separate from model reaction membership').toBe(false);
    } finally { await cleanupModel(); if (actual) await until(actual).catch(() => {}); }
  });

  it.each(['editor', 'quit'])('a stale %s timeout reports the previous chapter without changing incoming Keep or confirming discard', async (where) => {
    resetHand(); state.open = false;
    let outer, kept;
    let keepStatus = 'pending';
    try {
      await EVENTS.switchOn(); await EVENTS.engineStarts();
      await open(V1); await EVENTS.editLine(); hand.hold = true;
      const outgoing = c, outgoingRef = app.chapterRef;
      outer = flushBeforeLeaving(where); await pass(0);
      const request = state.publicRequests.find((request) => request.originalPromise === outer);
      const receipt = state.underlyingSettles.find((receipt) => receipt.publicRequestSerial === request.serial);
      expect(hand.writes).toHaveLength(1);
      const oldBytes = [onDisk(), textOnDisk()];
      closeChapter(); state.open = false; adopt(chapters[1]); hand.fontHeld = true;
      await open(V1);
      const incomingRef = app.chapterRef, incomingBytes = [onDisk(), textOnDisk()];
      expect(incomingRef).not.toBe(outgoingRef);
      expect(waiting()).toBe(true);
      kept = keepFirstFit();
      kept.then(() => { keepStatus = 'fulfilled'; }, () => { keepStatus = 'rejected'; });
      await pass(10000);
      expect(await until(outer)).toBe(false);
      expect(app.toast.msg, 'old timeout must not describe incoming editor work').toContain('previous chapter');
      expect(app.toast.msg).not.toMatch(/staying in the editor|stay in the editor|ask to leave again|discard/);
      expect(app.chapterRef).toBe(incomingRef); expect(app.saveFailed).toBe(false);
      expect(keepStatus, 'old timeout cannot settle or reject incoming Keep').toBe('pending');
      expect(firstFitChanges().keeping).toBe(true);
      expect([onDisk(), textOnDisk()]).toEqual(incomingBytes);
      expect([fsx._tree.files.get(paths(outgoing).chapter), fsx._tree.files.get(paths(outgoing).text)]).toEqual(oldBytes);
      expect(receipt.pending).toBe(true); expect(receipt.ref).toBe(outgoingRef);
      expect(request.answer).toBe(false);
      expect(request.emissions.some((emission) => emission.message.includes('discard'))).toBe(false);
    } finally { await cleanupModel(); await Promise.allSettled([outer, kept].filter(Boolean)); }
  });

  it('private an actual pending browser settle acquires Rust ownership only on its captured ref', async () => {
    resetHand(); state.open = false;
    let pending;
    try {
      await open(V1); await EVENTS.editLine(); hand.hold = true;
      pending = flushSave({ settle: true }); pending.catch(() => {}); await pass(0);
      const receipt = state.underlyingSettles.find((receipt) => receipt.originalPromise === pending);
      expect(pendingUnderlyingOwned()).not.toContain(receipt);
      await EVENTS.switchOn();
      expect(pendingUnderlyingOwned(), 'actual reacquisition retains the final until its own promise settles').toContain(receipt);
      expect(settlementReceipt()).toBe(null);
      expect(receipt.acquiredRust).toBe(true); expect(receipt.ref).toBe(app.chapterRef);
    } finally { await cleanupModel(); if (pending) await until(pending).catch(() => {}); }
  });

  it('private actual switch result identity and cancelled held factory remain observations without gate waiver', async () => {
    resetHand(); state.open = false;
    let starting;
    try {
      await open(V1); hand.startHeld = true;
      starting = useTextEngine('rust'); starting.catch(() => {}); await pass(0);
      const operation = engineObservations.operations.find((operation) => operation.originalPromise === starting);
      expect(hand.starts).toHaveLength(1);
      const gate = hand.starts[0], factory = engineObservations.factories.find((factory) => factory.serial === gate.factorySerial);
      const browser = useTextEngine('browser'); await until(browser); await pass(0);
      expect(hand.starts, 'observing cancellation must not resolve/remove the physical factory gate').toHaveLength(1);
      expect(factory.pending).toBe(true); expect(operation.pending).toBe(true);
      expect(operation.originalPromise).toBe(starting);
      expect(factory.operation).toBe(operation); expect(factory.originalGate).toBe(gate);
      expect(engineObservations.operations.find((operation) => operation.originalPromise === browser)).toMatchObject({ nonNoop: true, fulfilled: true });
      expect(gate.operationSerial).toBe(operation.serial);
    } finally { await cleanupModel(); if (starting) await until(starting).catch(() => {}); }
  });

  it('private actual system callback, sync object and disposal retain identity while an unowned native gate still blocks', async () => {
    resetHand(); state.open = false;
    let sync;
    const returned = [];
    try {
      const engine = fakeRustEngine();
      const callback = (...args) => { const promise = invoke('system_font_face', { family: args[0], slot: args[1], known: args[2] }); returned.push({ args, promise }); return promise; };
      const options = { engine, fonts: { user: [], system: app.fonts.system }, systemFace: callback };
      sync = createFontSync(options);
      sync.ready('Zapfino'); await pass(0);
      const owner = engineObservations.syncs.find((owner) => owner.sync === sync);
      const call = engineObservations.faces.find((call) => call.owner === owner && call.originalArgs[0] === 'Zapfino');
      const actual = returned.find((actual) => actual.promise === call.originalPromise);
      expect(hand.fonts.length, 'callback observation does not drain the actual native gate').toBeGreaterThan(0);
      expect(actual).toBeDefined(); expect(actual.args).toEqual(call.originalArgs);
      expect(owner.sync).toBe(sync); expect(owner.originalOptions).toBe(options);
      expect(call.originalCallback).toBe(callback); expect(owner.factorySerial).toBe(null);
      const result = sync.dispose();
      expect(owner.disposals.at(-1).originalResult).toBe(result);
      expect(owner.disposals.at(-1)).toMatchObject({ thisMatches: true, returned: true, operationSerial: null });
      expect(hand.fonts.length).toBeGreaterThan(0);
    } finally { sync?.dispose(); await cleanupModel(); }
  });

  it('private original dispose Error is rethrown unchanged and supplies no successful disposal observation', async () => {
    resetHand(); state.open = false;
    const error = new Error('actual original dispose error');
    const engine = fakeRustEngine();
    const sync = createFontSync({ engine, fonts: { user: [], system: [] } });
    const owner = engineObservations.syncs.find((owner) => owner.sync === sync);
    const setFallbacks = engine.setFallbacks;
    try {
      engine.setFallbacks = () => { throw error; };
      let caught; try { sync.dispose(); } catch (failure) { caught = failure; }
      expect(caught).toBe(error);
      expect(owner.disposed, 'a throwing original disposal is not a successful owner certificate').toBe(false);
      expect(owner.disposals.at(-1)).toMatchObject({ returned: false, error: error.message });
    } finally { engine.setFallbacks = setFallbacks; sync.dispose(); await cleanupModel(); }
  });

  it.each([null, undefined, false])('private underlying settle preserves actual falsy rejection %s as rejection', async (reason) => {
    resetHand(); state.open = false;
    let pending;
    try {
      await EVENTS.switchOn(); await EVENTS.engineStarts(); hand.fontHeld = false;
      await open(V1); await EVENTS.editLine(); hand.hold = true;
      const options = { settle: true };
      pending = flushSave(options); pending.catch(() => {}); await pass(0);
      const receipt = state.underlyingSettles.find((receipt) => receipt.originalPromise === pending);
      expect(pendingUnderlyingOwned()).toContain(receipt);
      hand.writes.shift().fail(reason);
      const outcome = await pending.then(() => ({ fulfilled: true }), (actual) => ({ fulfilled: false, reason: actual }));
      await pass(0);
      expect(outcome.fulfilled, 'the original public promise actually rejects, even with a falsy value').toBe(false);
      expect(outcome.reason).toBe(reason);
      expect(receipt.fulfilled, 'a falsy original rejection must never become successful ownership evidence').toBe(false);
      expect(receipt.rejected).toBe(true); expect(receipt.pending).toBe(false);
      expect(receipt.failureReason).toBe(reason); expect(receipt.originalArgs[0]).toBe(options);
      expect(underlyingSettleFacts().find((facts) => facts.serial === receipt.serial).failureReason).toEqual(failureReasonFacts(reason));
    } finally { await cleanupModel(); if (pending) await until(pending).catch(() => {}); }
  });

  it.each([null, undefined, false])('private public engine switch preserves actual falsy rejection %s as rejection', async (reason) => {
    resetHand(); state.open = false;
    let pending;
    try {
      _setEngineSwitchDeps({ ...modelSwitchDeps, watch(value) { if (value !== null) throw reason; return watchUserFaces(value); } });
      pending = useTextEngine('rust'); pending.catch(() => {});
      const outcome = await pending.then(() => ({ fulfilled: true }), (actual) => ({ fulfilled: false, reason: actual }));
      await pass(0);
      const operation = engineObservations.operations.find((operation) => operation.originalPromise === pending);
      expect(outcome.fulfilled, 'actual async start rejects its original injected watcher failure').toBe(false);
      expect(outcome.reason).toBe(reason);
      expect(operation.fulfilled, 'falsy failure cannot certify an actually fulfilled transition').toBe(false);
      expect(operation.rejected).toBe(true); expect(operation.pending).toBe(false);
      expect(operation.failureReason).toBe(reason);
      expect(operation.originalPromise).toBe(pending);
      expect(engineOwnershipFacts().operations.find((facts) => facts.serial === operation.serial).failureReason).toEqual(failureReasonFacts(reason));
    } finally { _setEngineSwitchDeps(modelSwitchDeps); await cleanupModel(); if (pending) await until(pending).catch(() => {}); }
  });

  it.each([null, undefined, false])('private original system callback preserves actual falsy rejection %s as rejection', async (reason) => {
    resetHand(); state.open = false;
    let sync;
    const returned = [];
    try {
      const callback = (...args) => { const promise = Promise.reject(reason); promise.catch(() => {}); returned.push({ args, promise }); return promise; };
      sync = createFontSync({ engine: fakeRustEngine(), fonts: { user: [], system: app.fonts.system }, systemFace: callback });
      sync.ready('Zapfino'); await pass(0);
      const owner = engineObservations.syncs.find((owner) => owner.sync === sync);
      const call = engineObservations.faces.find((call) => call.owner === owner && call.originalArgs[0] === 'Zapfino');
      const actual = returned.find((actual) => actual.promise === call.originalPromise);
      expect(actual, 'the actual original callback result must remain the observed result').toBeDefined();
      const outcome = await actual.promise.then(() => ({ fulfilled: true }), (value) => ({ fulfilled: false, reason: value }));
      expect(outcome.fulfilled).toBe(false); expect(outcome.reason).toBe(reason);
      expect(call.fulfilled, 'a rejected face result cannot become successful native-return evidence').toBe(false);
      expect(call.rejected).toBe(true); expect(call.pending).toBe(false);
      expect(call.failureReason).toBe(reason); expect(call.originalCallback).toBe(callback);
      expect(call.originalArgs[2]).toBe(actual.args[2]);
      expect(engineOwnershipFacts().faces.find((facts) => facts.serial === call.serial).failureReason).toEqual(failureReasonFacts(reason));
    } finally { sync?.dispose(); await cleanupModel(); }
  });

  it.each([null, undefined, false])('private original dispose preserves actual falsy throw %s without successful disposal evidence', async (reason) => {
    resetHand(); state.open = false;
    const engine = fakeRustEngine(), setFallbacks = engine.setFallbacks;
    const sync = createFontSync({ engine, fonts: { user: [], system: [] } });
    const owner = engineObservations.syncs.find((owner) => owner.sync === sync);
    try {
      engine.setFallbacks = () => { throw reason; };
      let caught = false, actual;
      try { sync.dispose(); } catch (value) { caught = true; actual = value; }
      expect(caught, 'the original public method actually throws').toBe(true); expect(actual).toBe(reason);
      expect(owner.disposed, 'falsy throw cannot supply a successful disposal certificate').toBe(false);
      const disposal = owner.disposals.at(-1);
      expect(disposal.returned).toBe(false); expect(disposal.threw).toBe(true);
      expect(disposal.failureReason).toBe(reason); expect(disposal.thisMatches).toBe(true);
      expect(engineOwnershipFacts().syncs.find((facts) => facts.serial === owner.serial).disposals.at(-1).failureReason).toEqual(failureReasonFacts(reason));
    } finally { engine.setFallbacks = setFallbacks; sync.dispose(); await cleanupModel(); }
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
      hand.writes.shift().ok(); await pass(0);
      expect(state.publicRequests.find((request) => request.originalPromise === state.lastOpen).pending).toBe(true);
      expect(state.deferred, 'an ambiguous final cannot claim the pending physical loss').toBe(null);
      expect(observedBrowserCancellation(window, window.chapter)).toBe(null);
      expect(() => choicesOnDisk(window.chapter, 'ambiguous actual final retains strict intent')).toThrow(Broken);
      expect(window).toMatchObject({ attributionAmbiguous: true });
      expect(window.saverSerials.slice(0, 2)).toEqual([first.saver.serial, state.savers.find((save) => save.originalPromise === extra).serial]);
      expect(window.saver).toBe(first.saver);
      expect(window.snapshot).toBe(first.snapshot);
      expect(window.timer).toBe(first.timer);
      expect(window.heldWriter).toBe(first.held);
      expect(window.snapshot.earlierChoices).toEqual([]);
      await rest(); await until(state.lastOpen);
      choicesOnDisk(window.chapter, 'ambiguous observations cannot weaken actual final convergence');
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

  it('a same-ID reopen preserves all intent through the entire original cancellation order', async () => {
    const events = ['open1', 'holdWrites', 'open1', 'editLine', 'writeLands', 'switchOn', 'engineStarts'];
    expect(await run(events)).toBe(null);
    expect(state.lastRunProof.fullOrder).toEqual(events);
    expect(state.lastRunProof.unexecutedTail).toEqual([]);
    expect(state.lastRunProof.witnesses).toEqual([]);
    expect(state.lastRunProof.facts.choices[0][1]).not.toHaveLength(0);
  });

  it('the original stale browser final now waits for every choice after Rust retirement', async () => {
    const events = sequence(20261867, 30);
    expect(await run(events)).toBe(null);
    expect(state.lastRunProof.fullOrder).toEqual(events);
    expect(state.lastRunProof.unexecutedTail).toEqual([]);
    expect(state.lastRunProof.witnesses).toEqual([]);
  });

  it('the original overlapping failure order no longer consumes a deliberate second-attempt escape', async () => {
    const events = sequence(20261290, 30);
    expect(await run(events)).toBe(null);
    expect(state.lastRunProof.fullOrder).toEqual(events);
    expect(state.lastRunProof.witnesses).toEqual([]);
  });

  it('two deliberate sequential refusals retain only an explicit unfinished force escape', async () => {
    const events = ['switchOn', 'engineStarts', 'open1', 'editLine', 'holdWrites', 'leave', 'writeFails', 'leave', 'writeFails', 'switchOff'];
    const result = await run(events);
    expect(result?.deferred?.category).toBe('explicit-forced-exit');
    expect(result.deferred.failedSavers).toHaveLength(2);
    expect(result.deferred.priorRefusal.answer).toBe(false);
    expect(result.deferred.answer).toBe(true);
    const prior = state.lastRunProof.publicRequests.find((request) => request.serial === result.deferred.priorRefusal.publicRequestSerial);
    const forced = state.lastRunProof.publicRequests.find((request) => request.serial === result.deferred.publicRequestSerial);
    expect(prior.replyOrder).toBeLessThan(forced.serial);
    expect(result.deferred.completedInvariantOrder).toBe(false);
    expect(result.deferred.debtRetired).toBe(false);
    expect(result.deferred.currentRustDebt.length).toBeGreaterThan(0);
    expect(state.lastRunProof.unexecutedTail).toEqual(['switchOff']);
    expect(state.lastRunProof.facts.choices[0][1]).not.toHaveLength(0);
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
      expect(() => checkFile('after the follow-up debounce, with the slow font still held')).not.toThrow();
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

  // These literal original schedules exercise the public reply, with no
  // production diagnostic overlay. Close synchronously in the FIRST original
  // reply observer, before assertions or cleanup can repair an early success.
  it.each(STARTUP_CLOSE_ORDERS)('public leave at startup seed %s saves version2 before the first TRUE reply closes the chapter', async (_seed, order) => {
    resetHand(); state.open = false; state.keep = null; resetFiles();
    let cut = null;
    const previous = saverObserver.reply;
    saverObserver.reply = (request, answer, error) => {
      if (!cut && answer === true && !error) {
        cut = copy({ chapterId: app.chapterRef?.chapterId, live: documentNow(), mode: app.chapterMode,
          choices: [...state.choices].map(([id, map]) => [id, [...map]]),
          physical: chapters.map((ch) => ({ id: ch.id, chapter: fsx._tree.files.get(paths(ch).chapter), text: fsx._tree.files.get(paths(ch).text) })),
          version: app.typesetting.version, engine: textEngine()?.id, phase: engineSwitch.phase });
        closeChapter();
        state.open = false;
      }
      return previous?.(request, answer, error);
    };
    try {
      for (const name of order) {
        state.event = name;
        await EVENTS[name]();
        await pass(0);
        if (cut) break;
      }
      if (!cut) await rest();
      expect(cut, 'the original public TRUE reply must be observed before cleanup').not.toBeNull();
      const actual = cut.physical.find((file) => file.id === cut.chapterId);
      expect(JSON.parse(actual.chapter).typesetting.version, 'first TRUE reply must already carry ready Rust version2').toBe(2);
      expect(canon(JSON.parse(actual.chapter).pages)).toBe(canon(cut.live));
      for (const file of cut.physical) choicesIn(file.id, JSON.parse(file.chapter), JSON.parse(file.text),
        'first TRUE reply retains every independent choice before synchronous close', new Set(), true,
        new Map(cut.choices.find(([id]) => id === file.id)?.[1] ?? []));
      expect(app.chapterRef).toBeNull();
    } finally { saverObserver.reply = previous; await cleanupModel(); }
  });

  it.each(['engine starts', 'switch cancelled'])('an edited final waits for actual startup until %s without waiting future fonts', async (completion) => {
    resetHand(); state.open = false;
    try {
      await open(V1); await EVENTS.editLine();
      hand.startHeld = true; hand.fontHeld = false;
      const starting = useTextEngine('rust');
      await pass(0);
      expect(hand.starts).toHaveLength(1);
      let reply = null;
      const final = flushBeforeLeaving('editor').then((answer) => { reply = answer; return answer; });
      await pass(0);
      expect(reply, 'a touched startup cannot claim its temporary version1 is settled').toBeNull();
      if (completion === 'engine starts') await EVENTS.engineStarts();
      else await EVENTS.switchOff();
      expect(await until(final)).toBe(true);
      expect(JSON.parse(onDisk()).typesetting.version).toBe(completion === 'engine starts' ? 2 : 1);
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe('AAA');
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AAA');
      if (completion === 'engine starts') await until(starting);
    } finally { await cleanupModel(); }
  });

  it('a held touched startup consumes only the existing public deadline and never a discard refusal', async () => {
    resetHand(); state.open = false;
    try {
      await open(V1); await EVENTS.editLine(); hand.startHeld = true;
      useTextEngine('rust').catch(() => {}); await pass(0);
      let reply = null;
      const final = flushBeforeLeaving('editor').then((answer) => { reply = answer; return answer; });
      await pass(9999); expect(reply).toBeNull();
      await pass(1); expect(await until(final)).toBe(false);
      expect(app.chapterRef).not.toBeNull();
      expect(app.toast.msg).toMatch(/Still writing/);
      await EVENTS.switchOff(); await pass(0);
      expect(await until(flushBeforeLeaving('editor'))).toBe(true);
      choicesOnDisk(c, 'cancelled startup after timeout retains choices');
    } finally { await cleanupModel(); }
  });

  it('an untouched first fit can leave with startup still held and writes neither file', async () => {
    resetHand(); state.open = false;
    try {
      await open(V1); const chapter = onDisk(), text = textOnDisk(), began = hand.began.length;
      hand.startHeld = true; useTextEngine('rust').catch(() => {}); await pass(0);
      expect(await until(flushBeforeLeaving('editor'))).toBe(true);
      expect(onDisk()).toBe(chapter); expect(textOnDisk()).toBe(text); expect(hand.began.length).toBe(began);
      expect(hand.starts).toHaveLength(1);
    } finally { await cleanupModel(); }
  });

  it.each(['saved', 'deliberate discard'])('the exact public %s approval is invalidated by a later live choice', async (outcome) => {
    resetHand(); state.open = false;
    const beforeWrite = fsx._before;
    try {
      await open(V1); await EVENTS.editLine();
      if (outcome === 'deliberate discard') {
        const failure = new Error('disk full');
        fsx._before = (path, bytes, write) => path === chapterPath ? Promise.reject(failure) : beforeWrite(path, bytes, write);
        expect(await until(flushBeforeLeaving('quit'))).toBe(false);
      }
      const request = flushBeforeLeaving('quit');
      expect(await until(request)).toBe(true);
      const { leaveApprovalCurrent } = await import('./library.svelte.js');
      expect(leaveApprovalCurrent(request)).toBe(true);
      UNMARKED.text();
      expect(leaveApprovalCurrent(request), 'even a raw later choice requires a new approval').toBe(false);
    } finally { fsx._before = beforeWrite; await cleanupModel(); }
  });

  it.each(['Fit now', 'Make auto'])('%s persists its review-only browser edit through actual BOTH writes', async (command) => {
    resetHand(); state.open = false;
    try {
      const raw = JSON.parse(V1);
      if (command === 'Fit now') Object.assign(raw.pages[0].boxes[0], { text: 'A'.repeat(100), w: 40,
        style: { ...raw.pages[0].boxes[0].style, size: 12, curve: 40 } });
      await open(JSON.stringify(raw)); await EVENTS.editLine(); await pass(DOC_SAVE_MS);
      const b = app.pages[0].boxes[0];
      if (command === 'Make auto') {
        autoFitBox(b, app.pages[0]);
        expect(b.review).toBeUndefined();
        b.review = { kind: 'overflow', reason: 'stale', overflow: { l: 0, t: 0, r: 1, b: 0 } };
        await until(saveOpenChapter());
      }
      const prior = copy(b), priorReview = (b.review === undefined ? undefined : copy(b.review));
      const invoke = () => command === 'Fit now' ? store.fitBoxNow(b.id, app.pages[0]) : store.makeBoxAuto(b.id, app.pages[0]);
      expect(invoke(), 'only the review changes').toBe(false);
      expect(b.review).not.toEqual(priorReview);
      expect({ ...copy(b), review: prior.review }).toEqual(prior);
      expect(app.saved, 'actual library persistence must be scheduled').toBe(false);
      await pass(DOC_SAVE_MS);
      expect(JSON.parse(onDisk()).pages[0].boxes[0].review).toEqual((b.review === undefined ? undefined : copy(b.review)));
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AAA');
      expect(() => choicesOnDisk(c, 'review-only BOTH receipt retains independent existing intent')).not.toThrow();
      const wrote = hand.began.length;
      expect(invoke(), 'the same review stays a no-op').toBe(false);
      await pass(DOC_SAVE_MS);
      expect(hand.began.length).toBe(wrote);
    } finally { await cleanupModel(); }
  });

  it('a touched held startup does not rewrite identical browser bytes on every natural debounce', async () => {
    resetHand(); state.open = false;
    try {
      await open(V1); await EVENTS.editLine();
      hand.startHeld = true; useTextEngine('rust').catch(() => {}); await pass(0);
      await pass(DOC_SAVE_MS);
      const wrote = hand.began.length;
      expect(wrote).toBe(1);
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe('AAA');
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AAA');
      await pass(DOC_SAVE_MS * 4);
      expect(hand.began.length, 'equal physical bytes do not owe repeated writes while startup waits').toBe(wrote);
      expect(hand.starts).toHaveLength(1);
      await EVENTS.engineStarts(); await EVENTS.fontLands(); await pass(DOC_SAVE_MS);
      checkFile('startup completion naturally persists its actual new debt');
    } finally { await cleanupModel(); }
  });

  it('a public saved approval cannot authorize edited startup begun after its reply', async () => {
    resetHand(); state.open = false;
    try {
      await open(V1); await EVENTS.editLine();
      const request = flushBeforeLeaving('quit');
      expect(await until(request)).toBe(true);
      const { leaveApprovalCurrent } = await import('./library.svelte.js');
      expect(leaveApprovalCurrent(request)).toBe(true);
      const ref = app.chapterRef, version = app.typesetting.version;
      expect(version).toBe(1);
      hand.startHeld = true; useTextEngine('rust').catch(() => {}); await pass(0);
      expect(app.chapterRef).toBe(ref); expect(app.typesetting.version).toBe(version);
      expect(leaveApprovalCurrent(request), 'the last consumer must refuse a new pending startup even before version changes').toBe(false);
      expect(hand.starts).toHaveLength(1);
    } finally { await cleanupModel(); }
  });

  it('an outgoing BOTH receipt cannot lower a new same-ref load cycle failure', async () => {
    resetHand(); state.open = false;
    let unsubscribe = null;
    try {
      await open(V1); await EVENTS.editLine();
      hand.holdTranslations = true;
      const old = saveOpenChapter(); await pass(0);
      expect(hand.writes[0].path).toBe(translationsPath);
      const ref = app.chapterRef;
      const incoming = JSON.parse(V1); incoming.pages[0].lines[0].en = 'INCOMING';
      useChapterTypesetting(incoming.typesetting); loadProjectPages(incoming.pages); markSaved();
      expect(app.chapterRef).toBe(ref);
      const failure = new Error('current-cycle failure');
      unsubscribe = store.setSaver(() => Promise.reject(failure));
      expect(await until(flushBeforeLeaving('editor'))).toBe(false);
      expect(app.saveFailed).toBe(true);
      hand.hold = true; hand.holdTranslations = false;
      hand.writes.shift().ok(); await until(old); await pass(0);
      expect(app.saveFailed, 'old actual BOTH bytes do not clear a newer cycle failure').toBe(true);
      expect(app.pages[0].lines[0].en).toBe('INCOMING');
      expect(await until(flushBeforeLeaving('editor')), 'old BOTH bytes cannot spend the new cycle refusal').toBe(true);
    } finally { unsubscribe?.(); await cleanupModel(); }
  });

  it.each(['editor', 'quit', 'same-ID open'])('browser %s waits for late independent choices in BOTH files', async (where) => {
    resetHand(); state.open = false;
    try {
      await open(V1);
      await EVENTS.editLine();
      hand.hold = true;
      const request = where === 'same-ID open' ? openChapter(p.id, c.id) : flushBeforeLeaving(where);
      let replied = false; request.then(() => { replied = true; }, () => {});
      await pass(0);
      expect(hand.writes).toHaveLength(1);
      await EVENTS.editLine();
      await EVENTS.editLate();
      const pg = app.pages[0], box = pg.boxes[3];
      resizeBox(pg.id, box.id, { x: box.x, y: box.y, w: box.w, h: 91 });
      choose('height', 91, pg, box); markUnsaved();
      expect(box.h, 'public resize establishes the independent late height').toBe(91);
      box.style.color = '#123456'; choose('style', '#123456', pg, box);
      setChapterTypesetMode('plain'); choose('typesetting', 'plain');
      app.chapterMode = 'translate'; choose('mode', 'translate');
      app.pages.reverse(); choose('order', app.pages.map((page) => page.id)); markUnsaved();
      hand.writes.shift().ok();
      await pass(0);
      expect(replied, 'old BOTH bytes cannot authorize the public handoff').toBe(false);
      expect(hand.writes.length).toBeGreaterThan(0);
      hand.hold = false;
      for (const writer of hand.writes.splice(0)) writer.ok();
      await until(request);
      const chapter = JSON.parse(onDisk()), translations = JSON.parse(textOnDisk());
      const chosenPage = chapter.pages.find((page) => page.id === 1);
      const chosenText = translations.pages.find((page) => page.page === 1);
      expect(chosenPage.lines[0].en).toBe('AAAA');
      expect(chosenText.lines[0].en).toBe('AAAA');
      expect(chosenPage.boxes[3]).toMatchObject({ text: 'AAAA BBBB CC', h: 91, style: { color: '#123456' } });
      expect(chosenText.extraBoxes[3]).toMatchObject({ text: 'AAAA BBBB CC', h: 91 });
      expect(chapter.mode).toBe('translate'); expect(chapter.typesetting.mode).toBe('plain');
      expect(chapter.pages.map((page) => page.id)).toEqual([2, 1]);
      choicesOnDisk(c, 'successful browser final retains every choice');
      expect(app.pages.find((page) => page.id === 1).lines[0].en).toBe('AAAA');
    } finally { await cleanupModel(); }
  });

  it('an old browser BOTH receipt cannot cancel a later edit debounce', async () => {
    resetHand(); state.open = false;
    try {
      await open(V1);
      hand.hold = true;
      await EVENTS.editLine(); await pass(DOC_SAVE_MS);
      await EVENTS.editLine();
      hand.hold = false; hand.writes.shift().ok(); await pass(0);
      expect(app.saved, 'old bytes must leave the newer intent unsaved').toBe(false);
      await pass(DOC_SAVE_MS);
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe('AAAA');
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('AAAA');
      choicesOnDisk(c, 'natural browser debounce without rescue');
    } finally { await cleanupModel(); }
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
  ])('the original browser %s order preserves its choice in BOTH files before success', async (_, events) => {
    expect(await run(events)).toBe(null);
    expect(state.lastRunProof.witnesses).toEqual([]);
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

  it.each(['same-ID fresh ref', 'same ref new load turn', 'delayed autosave rejection', 'public editor leave rejection'])('a stale %s cannot cancel the current Keep or flag its save', async (cycle) => {
    const mode = cycle === 'public editor leave rejection' ? 'public editor leave' : 'direct final rejection';
    resetHand(); state.open = false;
    let first; let second; let kept;
    const firstState = { done: false, answer: null };
    const secondState = { status: 'pending', answer: null, error: null };
    const keepState = { status: 'pending', error: null };
    try {
      await EVENTS.switchOn(); await EVENTS.engineStarts();
      await open(V1);
      expect(waiting(), 'A begins with the real model slow face held').toBe(true);
      await EVENTS.editLine();
      const outgoing = c; const outgoingRef = app.chapterRef;
      hand.hold = true;
      first = flushBeforeLeaving('editor').then((answer) => { firstState.done = true; firstState.answer = answer; return answer; });
      if (cycle === 'delayed autosave rejection') {
        markUnsaved();
        await pass(DOC_SAVE_MS);
        second = state.savers.at(-1).originalPromise;
      } else second = mode === 'public editor leave' ? flushBeforeLeaving('editor') : flushSave({ settle: true });
      second.then((answer) => { secondState.status = 'fulfilled'; secondState.answer = answer; },
        (error) => { secondState.status = 'rejected'; secondState.error = error; });
      await pass(0);
      expect(hand.writes, 'first actual A chapter writer alone is held').toHaveLength(1);
      expect(hand.writes[0].path).toBe(paths(outgoing).chapter);
      hand.writes.shift().ok(); await pass(0);
      expect(firstState, 'A first public final genuinely lets its caller close').toEqual({ done: true, answer: true });
      expect(secondState.status, 'second A final is still pending').toBe('pending');
      expect(hand.writes).toHaveLength(1);
      const heldA = hand.writes[0];
      expect(heldA.path).toBe(paths(outgoing).chapter);
      expect(heldA.ref).toBe(outgoingRef);
      const outgoingChapter = fsx._tree.files.get(paths(outgoing).chapter);
      const outgoingText = fsx._tree.files.get(paths(outgoing).text);
      expect(JSON.parse(outgoingChapter).pages[0].lines[0].en).toBe('AAA');
      expect(JSON.parse(outgoingText).pages[0].lines[0].en).toBe('AAA');
      const rawB = JSON.parse(V1);
      if (cycle === 'same ref new load turn') {
        rawB.id = c.id; rawB.number = c.number; rawB.title = 'Same Ref Reload';
        rawB.pages[0].lines[0].en = 'B KEEP CHOICE';
        fsx._tree.files.set(chapterPath, JSON.stringify(rawB));
        fsx._tree.files.set(translationsPath, buildTextJson(rawB.pages));
        // Public loader APIs advance documentTurn without replacing ref.
        useChapterTypesetting(rawB.typesetting);
        loadProjectPages(rawB.pages);
        markSaved();
        state.opened = onDisk(); state.openedText = textOnDisk(); state.openedRef = app.chapterRef;
        state.openedWrites = hand.began.length; state.touched = false;
      } else {
        closeChapter(); state.open = false;
        expect(app.chapterRef).toBe(null);
        adopt(cycle === 'same-ID fresh ref' ? chapters[0] : chapters[1]);
        rawB.id = c.id; rawB.number = c.number; rawB.title = 'Incoming Keep';
        rawB.pages[0].lines[0].en = 'B KEEP CHOICE';
        await open(JSON.stringify(rawB));
      }
      const incoming = c; const incomingRef = app.chapterRef;
      if (cycle === 'same ref new load turn') expect(incomingRef).toBe(outgoingRef);
      else expect(incomingRef).not.toBe(outgoingRef);
      if (cycle === 'same-ID fresh ref') expect(incomingRef.chapterId).toBe(outgoingRef.chapterId);
      expect(incomingRef.chapterId).toBe(incoming.id);
      expect(app.loaded).toBe(true);
      expect(textEngine().id).toBe('rust');
      expect(waiting(), 'B has an actual unresolved face used by its own document').toBe(true);
      expect(hand.writes, 'opening B from a null ref does not drain held A').toEqual([heldA]);
      const bChapterBefore = onDisk(); const bTextBefore = textOnDisk();
      const bWriteCount = () => hand.began.filter((write) => write.path === paths(incoming).chapter).length;
      const beforeB = bWriteCount();
      kept = keepFirstFit(); state.touched = true;
      kept.then(() => { keepState.status = 'fulfilled'; }, (error) => { keepState.status = 'rejected'; keepState.error = error; });
      await pass(0);
      expect(firstFitChanges()).toMatchObject({ keeping: true, kept: false });
      const keepTimer = [...state.timers.values()].findLast((timer) => timer.source === 'keep' && timer.ref === incomingRef && timer.pending);
      expect(keepTimer, 'B Keep owns an actual pending 4000ms deadline').toBeDefined();
      expect(keepTimer.ms).toBe(KEEP_WAIT_MS);
      const keepClearCount = keepTimer.clears?.length ?? 0;
      const failure = new Error('outgoing A held write rejected');
      hand.hold = false;
      expect(hand.writes.shift()).toBe(heldA);
      heldA.fail(failure); await pass(0);
      if (mode === 'direct final rejection') {
        expect(secondState.status, 'A caller must retain its own rejection').toBe('rejected');
        expect(secondState.error, 'A receives the identical original Error').toBe(failure);
      } else {
        expect(secondState.status).toBe('fulfilled');
        expect(secondState.answer, 'A public leave must still refuse its failed final').toBe(false);
        expect(app.toast.msg, 'A public refusal must still report its own failure').toContain(failure.message);
      }
      if (cycle === 'delayed autosave rejection') expect(app.toast.msg, 'the outgoing autosave still reports its original failure').toContain(failure.message);
      if (mode !== 'direct final rejection' || cycle === 'delayed autosave rejection') {
        expect(app.toast.msg).toContain('previous chapter');
        expect(app.toast.msg).not.toMatch(/last edits.*on screen|ask to leave again to discard/);
      }
      const cut = { mode, outgoingChapterId: outgoing.id, incomingChapterId: incoming.id,
        outgoingRefToken: refToken(outgoingRef), incomingRefToken: refToken(incomingRef),
        secondA: { status: secondState.status, answer: secondState.answer, sameOriginalError: secondState.error === failure },
        incomingKeep: { status: keepState.status, error: keepState.error?.message ?? null, waiting: waiting(), changes: firstFitChanges(),
          timerSerial: keepTimer.serial, timerPending: keepTimer.pending, timerMs: keepTimer.ms,
          timerClears: keepTimer.clears?.length ?? 0, timerFiredAt: keepTimer.firedAt ?? null },
        incomingSaveFailed: app.saveFailed, incomingWriterCount: bWriteCount(),
        outgoingBytesUnchanged: fsx._tree.files.get(paths(outgoing).chapter) === outgoingChapter && fsx._tree.files.get(paths(outgoing).text) === outgoingText,
        incomingBytesUnchanged: onDisk() === bChapterBefore && textOnDisk() === bTextBefore };
      state.privateFailureScopeCut = copy({ ...cut, cycle });
      expect(keepState.status, 'stale A rejection must leave B Keep pending for its own font or deadline').toBe('pending');
      expect(keepTimer.pending, 'A failure must not cancel B Keep deadline').toBe(true);
      expect(keepTimer.clears?.length ?? 0).toBe(keepClearCount);
      expect(firstFitChanges()).toMatchObject({ keeping: true, kept: false });
      expect(app.saveFailed, 'A failure must not mark the newly loaded B save as failed').toBe(false);
      expect(app.chapterRef).toBe(incomingRef);
      await pass(KEEP_WAIT_MS - 1);
      expect(keepState.status).toBe('pending');
      expect(keepTimer.pending, 'the original B deadline survives until just before expiration').toBe(true);
      expect(waiting()).toBe(true);
      expect(bWriteCount(), 'B Keep waits for its actual font while deadline has time left').toBe(beforeB);
      expect(onDisk()).toBe(bChapterBefore); expect(textOnDisk()).toBe(bTextBefore);
      await EVENTS.fontLands(); await pass(0);
      await until(kept);
      expect(keepState.status, 'B own font readiness fulfills its original Keep').toBe('fulfilled');
      expect(waiting()).toBe(false);
      expect(bWriteCount()).toBe(beforeB + 1);
      expect(JSON.parse(onDisk()).pages[0].lines[0].en).toBe('B KEEP CHOICE');
      expect(JSON.parse(textOnDisk()).pages[0].lines[0].en).toBe('B KEEP CHOICE');
      expect(JSON.parse(onDisk()).typesetting.version).toBe(2);
      expect(canon(JSON.parse(onDisk()).pages)).toBe(canon(documentNow()));
      expect(textOnDisk()).toBe(buildTextJson(app.pages));
      if (incoming.id !== outgoing.id) {
        expect(fsx._tree.files.get(paths(outgoing).chapter)).toBe(outgoingChapter);
        expect(fsx._tree.files.get(paths(outgoing).text)).toBe(outgoingText);
      }
      expect(app.saved).toBe(true); expect(app.saveFailed).toBe(false);
    } finally {
      await cleanupModel();
      await Promise.allSettled([first, second, kept].filter(Boolean));
    }
  });

  it.each(['explicit final', 'actual autosave'])('a same-current failed %s still rejects Keep and marks its own save failed', async (saveMode) => {
    resetHand(); state.open = false;
    let kept; let failed;
    const keepState = { status: 'pending', error: null };
    let received;
    try {
      await EVENTS.switchOn(); await EVENTS.engineStarts(); await open(V1);
      expect(waiting()).toBe(true);
      const ref = app.chapterRef;
      const chapterBefore = onDisk(); const textBefore = textOnDisk();
      kept = keepFirstFit(); state.touched = true;
      kept.then(() => { keepState.status = 'fulfilled'; }, (error) => { keepState.status = 'rejected'; keepState.error = error; });
      await pass(0);
      const deadline = [...state.timers.values()].findLast((timer) => timer.source === 'keep' && timer.ref === ref && timer.pending);
      expect(deadline).toBeDefined();
      hand.hold = true;
      if (saveMode === 'actual autosave') {
        markUnsaved(); await pass(DOC_SAVE_MS);
        failed = state.savers.at(-1).originalPromise;
      } else failed = flushSave({ settle: true });
      failed.catch((error) => { received = error; });
      await pass(0);
      expect(hand.writes).toHaveLength(1);
      const writer = hand.writes.shift();
      expect(writer.path).toBe(chapterPath); expect(writer.ref).toBe(ref);
      const failure = new Error('same current physical save failure');
      writer.fail(failure); await pass(0);
      await until(failed).catch(() => {});
      expect(received, 'the current caller receives its original physical failure').toBe(failure);
      expect(keepState, 'a current-cycle failure must still reject its own original Keep').toEqual({ status: 'rejected', error: failure });
      expect(app.saveFailed, 'current save failure remains visible').toBe(true);
      if (saveMode === 'actual autosave') expect(app.toast.msg, 'current autosave retains its own failure notice').toContain(failure.message);
      expect(deadline.pending, 'current failure cancels its own Keep deadline').toBe(false);
      expect(firstFitChanges().keeping).toBe(false);
      expect(app.chapterRef).toBe(ref);
      expect(onDisk()).toBe(chapterBefore); expect(textOnDisk()).toBe(textBefore);
      expect(hand.landed).toHaveLength(0);
    } finally {
      await cleanupModel(); await Promise.allSettled([kept, failed].filter(Boolean));
    }
  });

  it('an autosave failure belongs to the public load turn at timer fire rather than timer arm', async () => {
    resetHand(); state.open = false;
    let failed; let received;
    try {
      await open(V1); await EVENTS.editLine();
      const ref = app.chapterRef;
      const armed = [...state.timers.values()].findLast((timer) => timer.source === 'document' && timer.ref === ref && timer.pending);
      expect(armed).toBeDefined();
      const clears = armed.clears?.length ?? 0;
      const chapterBefore = onDisk(); const textBefore = textOnDisk();
      // The same public API used by loading advances the cycle; it neither
      // changes ref nor replaces the already armed document timer.
      useChapterTypesetting(copy(app.typesetting));
      expect(app.chapterRef).toBe(ref);
      expect(armed.pending).toBe(true); expect(armed.clears?.length ?? 0).toBe(clears);
      hand.hold = true;
      await pass(DOC_SAVE_MS);
      expect(hand.writes).toHaveLength(1);
      const writer = hand.writes.shift();
      expect(writer.path).toBe(chapterPath); expect(writer.ref).toBe(ref);
      const saver = state.savers.find((save) => save.serial === writer.saverSerial);
      expect(saver?.originalPromise).toBeDefined(); failed = saver.originalPromise;
      failed.catch((error) => { received = error; });
      const failure = new Error('actual timer-start current-cycle failure');
      writer.fail(failure); await pass(0);
      await until(failed).catch(() => {});
      expect(app.saveFailed, 'a legitimate later-turn autosave must flag its own actual failure').toBe(true);
      expect(received).toBe(failure);
      expect(app.toast.msg, 'the actual autosave failure still reaches its original notice').toContain(failure.message);
      expect(app.chapterRef).toBe(ref);
      expect(onDisk()).toBe(chapterBefore); expect(textOnDisk()).toBe(textBefore);
      expect(hand.landed).toHaveLength(0);
      expect(armed.pending).toBe(false); expect(armed.firedAt).toBeDefined();
    } finally {
      await cleanupModel(); await Promise.allSettled([failed].filter(Boolean));
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

  it('a foreign same-message physical open rejection is a model failure even when the current save flag is true', async () => {
    resetHand(); state.open = false; state.keep = null; state.deferred = null;
    let earlier;
    try {
      await open(V1); await EVENTS.editLine();
      hand.hold = true;
      earlier = flushSave({ settle: true }); earlier.catch(() => {});
      await pass(0); EVENTS.writeFails(); await pass(0);
      await until(earlier).catch(() => {});
      const injected = state.failedWriters.at(-1).error;
      expect(app.saveFailed).toBe(true);
      await EVENTS.open2();
      const operation = state.publicRequests.at(-1);
      const foreign = new Error('disk full');
      expect(foreign).not.toBe(injected);
      const writer = hand.writes.shift();
      expect(writer).toBeDefined();
      writer.fail(foreign); await pass(0);
      await until(state.lastOpen).catch(() => {}); await pass(0);
      // Functional refusal precedes metadata: the indicator must not swallow this foreign error.
      expect(hand.broke, 'an unrelated actual rejection must remain a model failure').toBe('opening: disk full');
      expect(operation.rejectedReason).toBe(foreign);
      expect(operation.fulfilled).toBe(false);
      expect(app.saveFailed).toBe(true);
      expect(state.failedWriters).toHaveLength(1);
      expect(state.failedWriters[0].error).toBe(injected);
    } finally { await cleanupModel(); await Promise.allSettled([earlier].filter(Boolean)); }
  });

  it('an error from the fulfilled-open reaction remains a model failure even when the current save flag is true', async () => {
    resetHand(); state.open = false; state.keep = null; state.deferred = null;
    const originalReply = saverObserver.openReply;
    let choices;
    try {
      await open(V1); await EVENTS.editLine();
      const outgoing = c;
      const foreign = new Error('unrelated fulfilled-open reaction');
      saverObserver.openReply = (request, error) => {
        originalReply(request, error);
        if (request.kind === 'open' && request.chapterId === chapters[1].id && error === null) {
          // Deliberate model-oracle fault after the ACTUAL original public fulfillment.
          // Physical bytes/retained Map entries and original source Promise remain unchanged.
          app.saveFailed = true;
          choices = state.choices.get(outgoing.id);
          choices.entries = () => { throw foreign; };
        }
      };
      await EVENTS.open2(); await until(state.lastOpen); await pass(0);
      // Functional refusal precedes metadata: successful source fulfillment cannot own this error.
      expect(hand.broke, 'a reaction error must not inherit the current indicator').toBe('opening: unrelated fulfilled-open reaction');
      const operation = state.publicRequests.at(-1);
      expect(operation.fulfilled).toBe(true);
      expect(operation.rejectedReason).toBe(null);
      expect(operation.originalPromise).toBe(state.lastOpen);
      expect(app.saveFailed).toBe(true);
    } finally {
      if (choices) delete choices.entries;
      saverObserver.openReply = originalReply;
      await cleanupModel();
    }
  });
});
