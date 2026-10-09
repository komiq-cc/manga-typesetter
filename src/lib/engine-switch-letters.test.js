import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { app, loadProjectPages, page, autoFitBox, refitBox, fitBoxNow, placeActiveAt, noteFontsChanged, fontsSettling } from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import {
  engineSwitch, useTextEngine, lettersOf, lettersMissing, boxesMissingLetters, boxesBorrowingLetters, lettersWereAskedFor, fontsSettled,
  _setEngineSwitchDeps, _resetEngineSwitch, _engineSwitchSync,
} from './engine-switch.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { addFontFile, removeUserFont, systemFontEntry, watchUserFaces } from './fonts.js';
import { layoutLines, applyCase, contentWidth, textInset, setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { neededHeight } from './typeset.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { fakeRustEngine, fakeNative, SFNT } from '../test/fake-rust-engine.js';
import { fakeIndexedDB } from '../test/fake-indexeddb.js';

// ===========================================================================
// A letter the box's font lacks, through the switch and the store
// ===========================================================================
// The real store, fonts.js and measure.js on a stand-in engine and a stand-in
// native side (as engine-switch.test.js): that a box holding such a letter is
// not written from while the family that has it is looked for and read, that
// it is fitted when that lands or turns out not to be coming, that nothing is
// asked twice, that turning the switch off meanwhile leaves nothing behind,
// what the notice is told, and what an export waits for.

function fakeBrowser() {
  const ink = (face, text) => ({ width: text.length * face.size * 0.55, left: 0, right: text.length * face.size * 0.55, ascent: face.size * 0.7, descent: face.size * 0.2 });
  return {
    id: 'browser',
    advance: (face, text) => text.length * face.size * 0.55,
    fontBox: (face) => ({ ascent: Math.round(face.size * 0.8), descent: Math.round(face.size * 0.2) }),
    lineInk: ink,
    glyphInk: ink,
    loading: () => false,
    onFontsChange: () => () => {},
    faceReady: () => true,
  };
}

const fontFile = (name, bytes = SFNT()) => ({ name, arrayBuffer: async () => bytes.buffer });
const styleFor = (font, extra = {}) => normalizeStyle({ ...defaultStyle(), font, size: 20, bold: false, ...extra });
const doc = (boxes) => [{ id: 1, w: 800, h: 1200, lines: [], boxes }];
const box = (font, over = {}) => ({
  id: 'b1', lineN: null, text: 'あいう BBBB', x: 100, y: 500, w: 60, h: 20,
  ...over,
  style: { font, size: 20, lineHeight: 1.1, valign: 'top', outlineWidth: 0, ...over.style },
});
function need(b) {
  const lines = layoutLines(applyCase(b.text, b.style), b.style, b.style.size, contentWidth(b.w, b.style));
  return neededHeight(lines.length, b.style, textInset(b.style));
}
const cp = (ch) => ch.codePointAt(0);
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const original = { engine: textEngine(), typeset: typesetEnabled(), system: app.fonts.system };
const library = fakeIndexedDB();
let browser;
let engine;
let invoke;

// A Mac with a Latin last resort, a Japanese family, and a system family a
// box can be set in. `coverage` is the order the native side looks in.
const FILES = () => ({
  'Helvetica Neue': [{ slots: { regular: 0 }, bytes: SFNT() }],
  'Hiragino Sans': [{ slots: { regular: 0 }, bytes: SFNT() }],
  Zapfino: [{ slots: { regular: 0 }, bytes: SFNT() }],
});
const INSTALLED = () => ['Helvetica Neue', 'Hiragino Sans', 'Zapfino'].map((name) => systemFontEntry({ name, faces: { regular: true } }));

// The switch on, with the user's Latin face in and the last resort read.
// With `hold` the native side answers only when released, from here on.
async function on({ hold = false, coverage = [['Hiragino Sans', 'あいう♥']], files = FILES(), watch } = {}) {
  invoke = fakeNative(files, { hold, coverage });
  engine.cover('Hiragino Sans', 'あいう♥');
  _setEngineSwitchDeps({
    available: () => true,
    createEngine: async () => engine,
    invoke: async () => invoke,
    booted: async () => {},
    os: () => 'macos',
    ...(watch ? { watch } : null),
  });
  app.fonts.system = INSTALLED();
  await addFontFile(fontFile('WildWords.ttf'));
  const starting = useTextEngine('rust');
  while (engineSwitch.phase === 'starting') {
    invoke.release();
    await flush();
  }
  await starting;
  expect(engineSwitch).toMatchObject({ phase: 'on', lastResort: 'Helvetica Neue' });
  invoke.calls.length = 0;
}
const questions = () => invoke.calls.filter(([cmd]) => cmd === 'system_font_coverage').map(([, args]) => args.codePoints);
const fetched = () => invoke.calls.filter(([cmd]) => cmd === 'system_font_face').map(([, args]) => args.family);

beforeEach(() => {
  vi.stubGlobal('FontFace', class {
    constructor(family, buffer, desc) {
      Object.assign(this, { family, buffer, desc });
    }
    async load() {
      return this;
    }
  });
  vi.stubGlobal('document', { fonts: { add() {}, delete() {} } });
  vi.stubGlobal('indexedDB', library);
  initHistory();
  resetHistory();
  app.chapterRef = null;
  browser = fakeBrowser();
  setTextEngine(browser);
  setTypesetEnabled(true);
  engine = fakeRustEngine();
});

afterEach(async () => {
  _resetEngineSwitch();
  _setEngineSwitchDeps(null);
  watchUserFaces(null);
  for (const f of [...app.fonts.user]) await removeUserFont(f.name);
  library.rows.clear();
  library.full = false;
  app.fonts.system = original.system;
  loadProjectPages([]);
  setTextEngine(original.engine);
  setTypesetEnabled(original.typeset);
  clearLayoutMemo();
  vi.unstubAllGlobals();
});

describe('a box holding a letter its font lacks', () => {
  it('is not written from while the family that has the letter is looked for and read, then is fitted', async () => {
    await on({ hold: true });
    // The chapter opens: the box's own face is in, its kana are in no font the engine has.
    loadProjectPages(doc([box('WildWords')]));
    const b = page().boxes[0];
    expect(questions()).toEqual([[cp('あ'), cp('い'), cp('う')]]);
    expect(b.h).toBe(20);
    // Every fit is held, as it is for a face that is on its way.
    expect(autoFitBox(b, page())).toBe(false);
    expect(refitBox(b, page())).toBe(false);
    expect(fitBoxNow(b.id, page())).toBe(false);
    expect(b.h).toBe(20);
    expect(lettersOf(b.style, b.text).pending).toEqual([cp('あ'), cp('い'), cp('う')]);

    // The answer is in and names a family; its file is still being read.
    invoke.release();
    await flush();
    expect(fetched()).toEqual(['Hiragino Sans']);
    expect(autoFitBox(b, page())).toBe(false);
    expect(b.h).toBe(20);
    expect(engine.fallbacks()).toEqual(['Helvetica Neue']);

    // It lands: one relayout, and the box is fitted with the family in the chain.
    const version = app.fontsVersion;
    invoke.release();
    await _engineSwitchSync().settled();
    expect(app.fontsVersion).toBe(version + 1);
    expect(engine.fallbacks()).toEqual(['Helvetica Neue', 'Hiragino Sans']);
    expect(b.h).toBe(need(b));
    expect(b.h).toBeGreaterThan(20);
    expect(lettersOf(b.style, b.text)).toEqual({ borrowed: [{ family: 'Hiragino Sans', letters: [cp('あ'), cp('い'), cp('う')] }], none: [], pending: [] });
    // Asked once and read once, however often it was looked at meanwhile.
    expect(questions()).toHaveLength(1);
    expect(fetched()).toHaveLength(1);
  });

  it('is fitted as soon as it is known that no installed font has the letter', async () => {
    await on({ hold: true });
    loadProjectPages(doc([box('WildWords', { text: '☃☃☃ BBBB' })]));
    const b = page().boxes[0];
    expect(b.h).toBe(20);
    invoke.release();
    await _engineSwitchSync().settled();
    expect(b.h).toBe(need(b));
    expect(lettersOf(b.style, b.text)).toEqual({ borrowed: [], none: [cp('☃')], pending: [] });
    expect(fetched()).toEqual([]);
  });

  it('whose other letters are all there is not held at all', async () => {
    await on({ hold: true });
    loadProjectPages(doc([box('WildWords', { text: 'AAAA BBBB' })]));
    expect(page().boxes[0].h).toBe(need(page().boxes[0]));
    expect(invoke.calls).toEqual([]);
  });

  it('is one question for the chapter, not one a box or a relayout', async () => {
    await on();
    const boxes = Array.from({ length: 12 }, (_, i) => box('WildWords', { id: `b${i}`, y: 20 + i * 90 }));
    loadProjectPages(doc(boxes));
    for (let i = 0; i < 5; i++) noteFontsChanged();
    await _engineSwitchSync().settled();
    for (let i = 0; i < 5; i++) noteFontsChanged();
    for (const b of page().boxes) autoFitBox(b, page());
    boxesBorrowingLetters();
    await _engineSwitchSync().settled();
    expect(questions()).toEqual([[cp('あ'), cp('い'), cp('う')]]);
    expect(fetched()).toEqual(['Hiragino Sans']);
    for (const b of page().boxes) expect(b.h).toBe(need(b));
  });

  it('is not asked about again after the question failed, and is fitted all the same', async () => {
    await on({ coverage: 'fail' });
    loadProjectPages(doc([box('WildWords')]));
    const b = page().boxes[0];
    await _engineSwitchSync().settled();
    expect(b.h).toBe(need(b));
    for (let i = 0; i < 5; i++) {
      noteFontsChanged();
      autoFitBox(b, page());
      await _engineSwitchSync().settled();
    }
    expect(questions()).toHaveLength(1);
    expect(lettersMissing(b.style, b.text)).toEqual([cp('あ'), cp('い'), cp('う')]);
  });

  it('is not asked about again after its family could not be read', async () => {
    const files = FILES();
    delete files['Hiragino Sans'];
    await on({ files });
    loadProjectPages(doc([box('WildWords')]));
    const b = page().boxes[0];
    await _engineSwitchSync().settled();
    expect(b.h).toBe(need(b));
    for (let i = 0; i < 5; i++) {
      noteFontsChanged();
      await _engineSwitchSync().settled();
    }
    expect(questions()).toHaveLength(1);
    expect(fetched()).toEqual(['Hiragino Sans']);
    expect(lettersOf(b.style, b.text)).toEqual({ borrowed: [], none: [cp('あ'), cp('い'), cp('う')], pending: [] });
  });

  it('placed while its letter is looked for is pending, and solved when the family lands', async () => {
    await on({ hold: true });
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, text: 'あいう THERE', tr: 'あいう THERE', tags: [] }], boxes: [], activeLineN: 1 }]);
    app.lastStyle.font = 'WildWords';
    placeActiveAt(400, 600);
    const b = page().boxes[0];
    expect(b.style.font).toBe('WildWords');
    expect(b.auto.status).toBe('pending');
    while (questions().length + fetched().length < 2) {
      invoke.release();
      await flush();
    }
    invoke.release();
    await _engineSwitchSync().settled();
    expect(b.auto.status).not.toBe('pending');
    expect(engine.fallbacks()).toEqual(['Helvetica Neue', 'Hiragino Sans']);
  });

  it('typed into: the fit of the new letters waits for their family', async () => {
    await on({ hold: true });
    loadProjectPages(doc([box('WildWords', { text: 'AAAA BBBB' })]));
    const b = page().boxes[0];
    const before = b.h;
    b.text = 'AAAA BBBB ♥♥♥♥ ♥♥♥♥ ♥♥♥♥';
    expect(autoFitBox(b, page())).toBe(false);
    expect(b.h).toBe(before);
    invoke.release();
    await flush();
    invoke.release();
    await _engineSwitchSync().settled();
    expect(b.h).toBe(need(b));
    expect(b.h).toBeGreaterThan(before);
  });
});

describe('turned off while a letter is being looked for', () => {
  it('leaves nothing of the engine behind, and the browser fits the box that waited', async () => {
    await on({ hold: true });
    loadProjectPages(doc([box('WildWords')]));
    const b = page().boxes[0];
    expect(b.h).toBe(20);
    expect(questions()).toHaveLength(1);
    await useTextEngine('browser');
    expect(engineSwitch.phase).toBe('off');
    expect(textEngine()).toBe(browser);
    expect(b.h).toBe(need(b));
    const fitted = b.h;
    const version = app.fontsVersion;
    // The answer, and nothing after it: no family is sent for, nothing is laid out again.
    invoke.release();
    await flush();
    invoke.release();
    await flush();
    expect(fetched()).toEqual([]);
    expect(engine.fallbacks()).toEqual([]);
    expect(engine.registered()).toEqual({});
    expect(app.fontsVersion).toBe(version);
    expect(b.h).toBe(fitted);
    expect(lettersOf(b.style, b.text)).toEqual({ borrowed: [], none: [], pending: [] });
    expect(fontsSettling()).toBe(null);
  });

  it('and while the family is being read', async () => {
    await on({ hold: true });
    loadProjectPages(doc([box('WildWords')]));
    invoke.release();
    await flush();
    expect(fetched()).toEqual(['Hiragino Sans']);
    await useTextEngine('browser');
    invoke.release();
    await flush();
    expect(engine.registered()).toEqual({});
    expect(engine.fallbacks()).toEqual([]);
    expect(page().boxes[0].h).toBe(need(page().boxes[0]));
  });
});

describe('what the notice is told', () => {
  it('which letters are drawn in which family, and which no installed font has', async () => {
    await on();
    engine.cover('Helvetica Neue', 'Ω');
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [], boxes: [box('WildWords', { id: 'plain', text: 'AAAA' }), box('WildWords', { id: 'kana', text: 'あΩ☃い' })] },
      { id: 2, w: 800, h: 1200, lines: [], boxes: [box('WildWords', { id: 'snow', text: '☃' }), box('WildWords', { id: 'heart', text: 'I ♥ U' })] },
    ]);
    await _engineSwitchSync().settled();
    expect(boxesBorrowingLetters()).toEqual([
      {
        pageIndex: 0, boxId: 'kana', none: [cp('☃')],
        borrowed: [{ family: 'Hiragino Sans', letters: [cp('あ'), cp('い')] }, { family: 'Helvetica Neue', letters: [cp('Ω')] }],
      },
      { pageIndex: 1, boxId: 'snow', borrowed: [], none: [cp('☃')] },
      { pageIndex: 1, boxId: 'heart', borrowed: [{ family: 'Hiragino Sans', letters: [cp('♥')] }], none: [] },
    ]);
    // The older list is the "nothing has" half of the same answer.
    expect(boxesMissingLetters()).toEqual([
      { pageIndex: 0, boxId: 'kana', letters: [cp('☃')] },
      { pageIndex: 1, boxId: 'snow', letters: [cp('☃')] },
    ]);
    expect(lettersWereAskedFor()).toBe(true);
  });

  it('nothing while a letter is still being looked for, and nothing with the browser measuring', async () => {
    expect(boxesBorrowingLetters()).toEqual([]);
    expect(lettersWereAskedFor()).toBe(false);
    await on({ hold: true });
    loadProjectPages(doc([box('WildWords')]));
    expect(boxesBorrowingLetters()).toEqual([]);
    invoke.release();
    await flush();
    invoke.release();
    await _engineSwitchSync().settled();
    expect(boxesBorrowingLetters()).toHaveLength(1);
  });

  it('follows a scan: what was not found is looked for again', async () => {
    let watcher = null;
    await on({
      coverage: [],
      watch: (w) => {
        watcher = w;
        watchUserFaces(w);
      },
    });
    loadProjectPages(doc([box('WildWords')]));
    const b = page().boxes[0];
    await _engineSwitchSync().settled();
    expect(lettersMissing(b.style, b.text)).toEqual([cp('あ'), cp('い'), cp('う')]);
    expect(questions()).toHaveLength(1);
    // What scanSystemFonts does when the native answer arrives.
    app.fonts.system = INSTALLED();
    watcher.scanned();
    noteFontsChanged();
    expect(questions()).toHaveLength(2);
    await _engineSwitchSync().settled();
    expect(lettersMissing(b.style, b.text)).toEqual([cp('あ'), cp('い'), cp('う')]);
    expect(questions()).toHaveLength(2);
  });
});

describe('what an export waits for', () => {
  it('nothing, with the browser measuring', () => {
    loadProjectPages(doc([box('WildWords')]));
    expect(fontsSettling()).toBe(null);
    expect(fontsSettling(app.pages)).toBe(null);
  });

  it('the family a letter is borrowed from, and the fit that waited for it', async () => {
    await on({ hold: true });
    loadProjectPages(doc([box('WildWords')]));
    const b = page().boxes[0];
    let done = false;
    const settling = fontsSettling(app.pages);
    settling.then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    // The answer alone is not enough: the family is still being read.
    invoke.release();
    await flush();
    expect(done).toBe(false);
    expect(b.h).toBe(20);
    invoke.release();
    await settling;
    expect(engine.fallbacks()).toEqual(['Helvetica Neue', 'Hiragino Sans']);
    expect(b.h).toBe(need(b));
  });

  it('a system family on a page nobody has looked at, and the letters it turns out to lack', async () => {
    await on({ hold: true });
    // Put in without a layout pass, as a page that was never on screen and
    // never measured: nothing has asked for its font or its letters.
    app.pages = doc([box('Zapfino', { text: 'あ AAAA BBBB' })]);
    expect(invoke.calls).toEqual([]);
    let done = false;
    const settling = fontsSettled(app.pages);
    settling.then(() => (done = true));
    // One round for the face, one for the letter, one for the letter's family.
    for (const want of [['system_font_face', 'Zapfino'], ['system_font_coverage', undefined], ['system_font_face', 'Hiragino Sans']]) {
      await vi.waitFor(() => expect(invoke.calls.at(-1)?.[0]).toBe(want[0]));
      if (want[1]) expect(invoke.calls.at(-1)[1].family).toBe(want[1]);
      await flush();
      expect(done).toBe(false);
      invoke.release();
    }
    await settling;
    expect(invoke.calls).toHaveLength(3);
    expect(engine.registered().Zapfino).toEqual(['regular']);
    expect(engine.fallbacks()).toEqual(['Helvetica Neue', 'Hiragino Sans']);
  });

  it('a family that could not be read, and a letter nothing has: it ends', async () => {
    const files = FILES();
    delete files['Hiragino Sans'];
    delete files.Zapfino;
    await on({ files });
    loadProjectPages(doc([box('WildWords', { text: 'あ☃' }), box('Zapfino', { id: 'b2', y: 200 })]));
    await fontsSettling(app.pages);
    expect(_engineSwitchSync().missing('Zapfino')).toBe(true);
    expect(lettersOf(styleFor('WildWords'), 'あ☃').none).toEqual([cp('あ'), cp('☃')]);
  });

  it('the engine itself, when the export is asked for while it is starting', async () => {
    invoke = fakeNative(FILES(), { hold: true, coverage: [['Hiragino Sans', 'あいう']] });
    engine.cover('Hiragino Sans', 'あいう');
    _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => invoke, booted: async () => {}, os: () => 'macos' });
    app.fonts.system = INSTALLED();
    await addFontFile(fontFile('WildWords.ttf'));
    loadProjectPages(doc([box('WildWords')]));
    const starting = useTextEngine('rust');
    expect(engineSwitch.phase).toBe('starting');
    let done = false;
    const settling = fontsSettling(app.pages);
    expect(settling).not.toBe(null);
    settling.then(() => (done = true));
    for (let i = 0; i < 6 && !done; i++) {
      await flush();
      invoke.release();
    }
    await starting;
    await settling;
    expect(engineSwitch.phase).toBe('on');
    expect(engine.fallbacks()).toEqual(['Helvetica Neue', 'Hiragino Sans']);
    expect(page().boxes[0].h).toBe(need(page().boxes[0]));
  });
});
