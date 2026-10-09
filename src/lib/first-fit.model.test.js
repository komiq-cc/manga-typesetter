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
// The known browser autosave race remains deferred; real leave/open
// boundaries still check both files under either engine. Independently
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
//
// The engines are the stand-ins of first-fit.test.js: what is tested is an
// order of events, and a measurement only has to differ between the two.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

vi.mock('./fsx.js', () => {
  const tree = { dirs: new Set(), files: new Map() };
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
      if (fsx._before) await fsx._before(p, c);
      await fsx.writeTextFile(p, c);
      fsx._after?.(p, c);
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

const { fsx } = await import('./fsx.js');
const { library, setRoot, createProject, createChapter, openChapter, closeChapter, flushBeforeLeaving, resetSaveFailures, setChapterMode } = await import('./library.svelte.js');
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

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.stubGlobal('FontFace', class {
    async load() {
      return this;
    }
  });
  vi.stubGlobal('document', { fonts: { add() {}, delete() {} } });
  vi.stubGlobal('indexedDB', fontLibrary);
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
  fsx._before = (path, text) => {
    if (chapters.some((ch) => path === `${ch.dir}/translations.json`)) {
      if (!hand.holdTranslations) return undefined;
      return new Promise((ok, fail) => hand.writes.push({ path, ok, fail }));
    }
    if (!chapters.some((ch) => path === `${ch.dir}/chapter.json`)) return undefined;
    hand.began.push({ path, version: JSON.parse(text).typesetting?.version ?? null, at: Date.now(), browser: engineSwitch.phase === 'off' });
    seen.writes++;
    const number = hand.began.at(-1).version;
    if (path === chapterPath && waiting() && number !== app.typesetting.version) hand.broke ??= `a save while the current chapter still waits changed its number from ${app.typesetting.version} to ${number}`;
    // Keep is one write, and it happens when its wait is over: not while a
    // font is still on its way and the wait has time left.
    if (state.keep?.alone && waiting() && Date.now() - state.keep.at < KEEP_WAIT_MS) {
      hand.broke ??= `Keep's write went out ${Date.now() - state.keep.at} ms after the press, at version ${hand.began.at(-1).version}, while a font was still on its way and its wait was not over`;
    }
    if (!hand.hold) return undefined;
    return new Promise((ok, fail) => hand.writes.push({ path, ok, fail }));
  };
  fsx._after = (path, text) => {
    if (chapters.some((ch) => path === `${ch.dir}/chapter.json`)) hand.landed.push({ ...hand.began.findLast((w) => w.path === path), version: JSON.parse(text).typesetting?.version ?? null });
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
// What the sequences did, over a whole run.
const stageCounts = () => ({ eventsByStage: { closed: {}, rustOrStarting: {}, crossSwitchDebt: {}, browserAfterDebt: {} }, inapplicablePublicActions: {} });
const seen = { sequences: 0, writes: 0, failed: 0, keeps: 0, asOpened: 0, asDocument: 0, left: 0, browserDeferred: 0, inapplicablePublicActions: 0, generatedStages: stageCounts() };
const state = { open: false, opened: null, openedText: null, openedWrites: 0, touched: false, keep: null, choices: new Map(), rustChapters: new Set(), rustDebt: new Set(), transition: 0, pending: new Set() };
const live = () => state.open && app.loaded && app.chapterRef?.chapterId === c.id;
const copy = (v) => JSON.parse(JSON.stringify(v));
const paths = (ch) => ({ chapter: `${ch.dir}/chapter.json`, text: `${ch.dir}/translations.json` });
function adopt(ch) {
  c = ch;
  ({ chapter: chapterPath, text: translationsPath } = paths(ch));
}
function resetFiles() {
  state.choices.clear();
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
  choices.set(key, { kind, value: copy(value), page: pg?.id, box: b?.id, line: ln?.n });
}
function choicesIn(id, record, text, when) {
  for (const want of state.choices.get(id)?.values() ?? []) {
    const pg = record.pages.find((p) => p.id === want.page);
    const b = pg?.boxes.find((b) => b.id === want.box);
    const ln = pg?.lines.find((l) => l.n === want.line);
    const tp = text.pages.find((p) => p.page === want.page);
    const extraIndex = pg?.boxes.filter((b) => b.lineN == null).findIndex((b) => b.id === want.box);
    const extra = extraIndex >= 0 ? tp?.extraBoxes[extraIndex] : null;
    const got = {
      text: b?.text, height: b?.h, style: b?.style?.color, fit: b?.fit,
      file: pg?.file, cleaned: pg?.cleaned ?? pg?.cleanedFile ?? null,
      translation: ln?.en, order: record.pages.map((p) => p.id),
      mode: record.mode, typesetting: record.typesetting?.mode,
    }[want.kind];
    const okay = want.kind === 'height' ? got >= want.value : canon(got) === canon(want.value);
    const second = want.kind === 'translation' ? tp?.lines.find((l) => l.n === want.line)?.en
      : want.kind === 'text' ? extra?.text
      : want.kind === 'height' ? extra?.h
      : want.kind === 'order' ? text.pages.map((p) => p.page) : undefined;
    const secondOkay = second === undefined && !['translation', 'text', 'height', 'order'].includes(want.kind)
      ? true : want.kind === 'height' ? second >= want.value : canon(second) === canon(want.value);
    if (!okay || !secondOkay) throw new Broken(`${when}: user ${want.kind} choice ${canon(want.value)} was lost (chapter ${id}; chapter.json ${canon(got)}; translations.json ${canon(second)})`);
  }
}
function choicesLive(when) {
  if (!live()) return;
  choicesIn(c.id, { pages: app.pages, mode: app.chapterMode, typesetting: app.typesetting }, JSON.parse(buildTextJson(app.pages)), when);
}
function choicesOnDisk(ch, when) {
  const path = paths(ch);
  choicesIn(ch.id, JSON.parse(fsx._tree.files.get(path.chapter)), JSON.parse(fsx._tree.files.get(path.text)), when);
}
// A prior Rust turn is not ownership forever. Retirement requires actual
// current bytes in BOTH files (or the permitted untouched opened bytes), no
// held writer, and no outstanding unsaved choice. A false saved flag alone
// cannot retire debt over stale physical bytes.
function retireBrowserDebt() {
  if (!live() || engineSwitch.phase !== 'off' || !app.saved || hand.writes.some((w) => w.path.startsWith(`${c.dir}/`))) return;
  const rec = JSON.parse(onDisk());
  const current = canon(rec.pages) === canon(documentNow()) && rec.mode === app.chapterMode && rec.typesetting?.mode === app.typesetting.mode && textOnDisk() === buildTextJson(app.pages);
  const untouched = !state.touched && onDisk() === state.opened && textOnDisk() === state.openedText;
  if (current || untouched) state.rustDebt.delete(c.id);
}

function checkFile(when) {
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
  const generation = ++state.transition;
  const held = hand.hold || hand.holdTranslations || hand.writes.length > 0;
  const request = openChapter(p.id, target.id);
  state.pending.add(request);
  state.lastOpen = request;
  request.then(() => {
    if (generation !== state.transition || app.chapterRef?.chapterId !== target.id) return;
    if (outgoing && outgoing.id !== target.id) choicesOnDisk(outgoing, 'after opening another chapter');
    adopt(target);
    state.open = true;
    state.opened = onDisk();
    state.openedText = textOnDisk();
    state.openedWrites = hand.began.length;
    state.touched = (state.choices.get(target.id)?.size ?? 0) > 0;
    state.keep = null;
    if (engineSwitch.mode === 'rust') { state.rustChapters.add(c.id); state.rustDebt.add(c.id); }
  }).catch((error) => {
    if (error instanceof Broken) hand.broke ??= error.message;
    // A failed leave-save makes the actual open refuse; the old document stays.
    else if (!app.saveFailed) hand.broke ??= `opening: ${error.message}`;
  }).finally(() => state.pending.delete(request));
  await pass(0);
  if (!held) await until(request).catch(() => {});
}
async function requestLeave() {
  if (!live()) return;
  const ref = app.chapterRef;
  const held = hand.hold || hand.holdTranslations || hand.writes.length > 0;
  const request = flushBeforeLeaving('editor');
  state.pending.add(request);
  request.then((went) => {
    if (!went || app.chapterRef !== ref) return;
    checkFile('after leaving');
    seen.left++;
    closeChapter();
    state.open = false;
    state.keep = null;
  }).catch((error) => { hand.broke ??= `leaving: ${error.message}`; }).finally(() => state.pending.delete(request));
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
    if (w) seen.failed++;
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
    keepFirstFit().catch(() => {});
  },
  async switchOff() {
    await until(useTextEngine('browser'));
    if (state.keep) state.keep.alone = false;
  },
  // The real switch: no write release, forced save or ledger re-baseline.
  // Rust must acquire whatever browser snapshot is still in flight.
  async switchOn() {
    if (engineSwitch.mode === 'rust') return;
    if (live()) { state.rustChapters.add(c.id); state.rustDebt.add(c.id); }
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
  resetHand();
  await pass(0);
  if (app.chapterRef && app.loaded) {
    await until(flushBeforeLeaving('editor')).catch(() => {});
  }
  closeChapter();
  state.open = false;
  for (const pending of [...state.pending]) await until(pending).catch(() => {});
  hand.fontHeld = false;
  await until(useTextEngine('browser'));
  resetHand();
  await pass(3000);
  resetSaveFailures();
  app.saveFailed = false;
  state.choices.clear();
}

async function run(events) {
  resetHand();
  state.open = false;
  state.keep = null;
  resetFiles();
  const stages = stageCounts();
  let at = '';
  try {
    for (const [i, name] of events.entries()) {
      at = `step ${i + 1} (${name})`;
      const stage = !live() ? 'closed' : engineSwitch.mode === 'rust' ? 'rustOrStarting' : state.rustDebt.has(c.id) ? 'crossSwitchDebt' : 'browserAfterDebt';
      stages.eventsByStage[stage][name] = (stages.eventsByStage[stage][name] ?? 0) + 1;
      const ignoredBefore = seen.inapplicablePublicActions;
      if (state.keep && TOUCHING.has(name) && name !== 'keep') state.keep.alone = false;
      await EVENTS[name]();
      const ignored = seen.inapplicablePublicActions - ignoredBefore;
      if (ignored) stages.inapplicablePublicActions[name] = (stages.inapplicablePublicActions[name] ?? 0) + ignored;
      await pass(0);
      retireBrowserDebt();
      choicesLive(`after ${name}`);
      if (hand.broke) throw new Broken(hand.broke);
    }
    at = 'coming to rest';
    await rest();
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
    if (!(e instanceof Broken)) throw new Error(`${at}: ${e?.stack ?? e}`);
    return `${e.message}`;
  } finally {
    state.lastRunStages = stages;
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
async function shrink(events) {
  let now = events;
  for (let again = true; again; ) {
    again = false;
    for (let i = now.length - 1; i >= 0; i--) {
      const fewer = [...now.slice(0, i), ...now.slice(i + 1)];
      if (await run(fewer)) {
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

describe('saves, fonts, the engine starting and Keep, in any order', () => {
  it(`leave the file as opened, or as the document with the right number (${ONE == null ? `${SEQUENCES} sequences of ${STEPS} events` : `seed ${ONE}`})`, async () => {
    const seeds = ONE == null ? Array.from({ length: SEQUENCES }, (_, i) => FIRST + i) : [ONE];
    const broken = [];
    for (const seed of seeds) {
      const events = sequence(seed, STEPS);
      const why = await run(events);
      // Only the original generated orders count here. Named probes and
      // shrink replays may increment the historical totals above, but cannot
      // inflate this per-event breakdown of the 6000 generated sequences.
      for (const [stage, counts] of Object.entries(state.lastRunStages.eventsByStage)) {
        for (const [name, count] of Object.entries(counts)) seen.generatedStages.eventsByStage[stage][name] = (seen.generatedStages.eventsByStage[stage][name] ?? 0) + count;
      }
      for (const [name, count] of Object.entries(state.lastRunStages.inapplicablePublicActions)) seen.generatedStages.inapplicablePublicActions[name] = (seen.generatedStages.inapplicablePublicActions[name] ?? 0) + count;
      seen.sequences++;
      if (!why) continue;
      const least = await shrink(events);
      broken.push(`seed ${seed}: ${least.why}\n    the fewest events that do it: ${least.events.join(', ')}`);
      if (broken.length >= 5 && !process.env.MODEL_REPORT) break;
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
      retireBrowserDebt();
      expect(state.rustDebt.has(c.id)).toBe(false);
      expect(JSON.parse(onDisk()).typesetting.version).toBe(2);
      await EVENTS.unmarked_style();
      await pass(DOC_SAVE_MS);
      expect(JSON.parse(onDisk()).pages[0].boxes[0].style.color).toBe('#123456');
      expect(JSON.parse(onDisk()).typesetting.version).toBe(1);
      checkFile('completed public Inspector color edit under the browser');
    } finally { await cleanupModel(); }
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
