import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rustEngine, fixtureFont } from '../test/rust-engine.js';
import { systemFaceAnswer } from '../test/font-collection.js';
import { coverage, covers } from '../../scripts/text-port/lib/cmap.mjs';
import { app, loadProjectPages, page, autoFitBox, fontsSettling } from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { engineSwitch, useTextEngine, lettersOf, boxLetters, boxesBorrowingLetters, _setEngineSwitchDeps, _resetEngineSwitch } from './engine-switch.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { addFontFile, removeUserFont, systemFontEntry, watchUserFaces } from './fonts.js';
import { lineWidth, layoutLines, applyCase, contentWidth, textInset, setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { neededHeight } from './typeset.js';
import { fakeIndexedDB } from '../test/fake-indexeddb.js';
import { boxCandidate, placeBlock } from './contain.js';

// ===========================================================================
// A borrowed letter through the whole app path, on the real engine
// ===========================================================================
// The switch, the store, fonts.js and measure.js as the app runs them, the
// wasm and the fixture fonts: a box set in a Latin font whose text holds a
// heart and a note. What is faked is `invoke` alone, and its coverage answer
// is read out of the fixture's `cmap` by the harness's own reader.
// (The same on a stand-in engine, case by case: engine-switch-letters.test.js.)

const comic = fixtureFont('ComicNeue-Regular.ttf');
const bangers = fixtureFont('Bangers-Regular.ttf');
const dejavu = fixtureFont('DejaVuSans.ttf');
const oblique = fixtureFont('DejaVuSans-Oblique.ttf');
const copy = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const fontFile = (name, bytes) => ({ name, arrayBuffer: async () => copy(bytes) });
const cp = (ch) => ch.codePointAt(0);

const SIZE = 26;
const TEXT = 'I ♥ YOU ♪ ♥♥♥♥ ♪♪♪♪ ♥♥♥♥';
const box = (font, over = {}) => ({
  id: 'b1', lineN: null, text: TEXT, x: 100, y: 500, w: 150, h: 20,
  ...over,
  style: { font, size: SIZE, lineHeight: 1.1, valign: 'top', outlineWidth: 0, ...over.style },
});
const doc = (boxes) => [{ id: 1, w: 800, h: 1200, lines: [], boxes }];
function need(b) {
  const lines = layoutLines(applyCase(b.text, b.style), b.style, b.style.size, contentWidth(b.w, b.style));
  return neededHeight(lines.length, b.style, textInset(b.style));
}

// The machine: a Latin family under the name of the Mac's last resort (Comic
// Neue's file - the stand-in native side does not read names), and DejaVu
// Sans, which has the heart and the note.
const FILES = {
  'Helvetica Neue': [{ slots: { regular: 0 }, bytes: comic }],
  'DejaVu Sans': [{ slots: { regular: 0 }, bytes: dejavu }, { slots: { italic: 0 }, bytes: oblique }],
};
const RANGES = coverage(dejavu).ranges;
function fakeInvoke({ hold = false } = {}) {
  const calls = [];
  const waiting = [];
  const invoke = async (cmd, args) => {
    calls.push(cmd === 'system_font_face' ? `${args.family}/${args.slot}` : `${cmd} ${args.codePoints.map((c) => c.toString(16)).join(' ')}`);
    if (hold) await new Promise((resolve) => waiting.push(resolve));
    if (cmd === 'system_font_coverage') {
      const mine = args.codePoints.filter((c) => covers(RANGES, c));
      return { families: mine.length ? [{ name: 'DejaVu Sans', order: '1dejavu sans\u0001DejaVu Sans', codePoints: mine }] : [], none: args.codePoints.filter((c) => !covers(RANGES, c)) };
    }
    const file = (FILES[args.family] ?? []).find((f) => args.slot in f.slots);
    if (!file) throw new Error(`no font called '${args.family}' is installed on this computer`);
    return systemFaceAnswer(file.slots, file.bytes, { known: args.known });
  };
  invoke.calls = calls;
  invoke.release = () => {
    for (const resolve of waiting.splice(0)) resolve();
  };
  return invoke;
}

const original = { engine: textEngine(), typeset: typesetEnabled(), system: app.fonts.system };
const library = fakeIndexedDB();
let engine;
let invoke;
let alone;

async function on(options) {
  invoke = fakeInvoke(options);
  _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => invoke, booted: async () => {}, os: () => 'macos' });
  // ("Bangers" is a built-in family's name; the user's copy has its own.)
  expect(await addFontFile(fontFile('MyBangers.ttf', bangers))).toBeTruthy();
  const starting = useTextEngine('rust');
  while (engineSwitch.phase === 'starting') {
    invoke.release();
    await new Promise((r) => setTimeout(r, 0));
  }
  await starting;
  expect(engineSwitch).toMatchObject({ phase: 'on', lastResort: 'Helvetica Neue' });
  expect(textEngine()).toBe(engine);
  invoke.calls.length = 0;
}

beforeEach(async () => {
  vi.stubGlobal('FontFace', class {
    async load() {
      return this;
    }
  });
  vi.stubGlobal('document', { fonts: { add() {}, delete() {} } });
  vi.stubGlobal('indexedDB', library);
  initHistory();
  resetHistory();
  app.chapterRef = null;
  setTypesetEnabled(true);
  const reference = await rustEngine();
  const f = (name) => ({ key: name, name, bold: false, italic: false, size: SIZE, css: name });
  alone = { advance: (name, text) => reference.advance(f(name), text) };
  engine = await rustEngine({ fixtures: false });
  app.fonts.system = [systemFontEntry({ name: 'Helvetica Neue', faces: { regular: true } }), systemFontEntry({ name: 'DejaVu Sans', faces: { regular: true, italic: true } })];
});

afterEach(async () => {
  _resetEngineSwitch();
  _setEngineSwitchDeps(null);
  watchUserFaces(null);
  for (const f of [...app.fonts.user]) await removeUserFont(f.name);
  library.rows.clear();
  app.fonts.system = original.system;
  loadProjectPages([]);
  setTextEngine(original.engine);
  setTypesetEnabled(original.typeset);
  clearLayoutMemo();
  vi.unstubAllGlobals();
});

describe('borrowed fonts follow the box’s painted runs', () => {
  it('finds curve borrowing hidden by shaping a composed character in the primary face', async () => {
    await on({ hold: true });
    const text = '=\u0338';
    const b = box('MyBangers', { text, style: { curve: 30 } });
    const p = doc([b])[0];
    expect(lettersOf(b.style, text)).toEqual({ borrowed: [], none: [], pending: [], unread: [] });
    // Bangers composes the pair to its own ≠, but paints the curve's mark
    // independently; that missing glyph must initiate coverage discovery.
    let done = false;
    const settling = fontsSettling([p]).then(() => { done = true; });
    expect(boxLetters(b, p).pending).toContain(cp('\u0338'));
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toBe(false);
    for (let i = 0; i < 4 && !done; i++) {
      invoke.release();
      await new Promise((r) => setTimeout(r, 0));
    }
    await settling;
    expect(boxLetters(b, p)).toEqual({ borrowed: [{ family: 'DejaVu Sans', letters: [cp('\u0338')] }], none: [], pending: [], unread: [] });
  });

  it.each([
    ['plain wrap', { shape: 'off' }, 20],
    ['arc', { curve: 30 }, 150],
    ['circle', { circle: { on: true } }, 150],
    ['path', { path: { on: true, pts: [{ x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 }, { x: 150, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 }] } }, 150],
  ])('%s starts a fresh fallback choice at each painted run', async (_name, style, width) => {
    const files = new Map([['Helvetica Neue', comic], ['Early', oblique], ['Later', dejavu]]);
    app.fonts.system = [...files.keys()].map((name) => systemFontEntry({ name, faces: { regular: true } }));
    const invoke = async (cmd, args) => {
      if (cmd === 'system_font_face') return systemFaceAnswer({ regular: 0 }, files.get(args.family), { known: args.known });
      const remaining = new Set(args.codePoints);
      const families = ['Early', 'Later'].map((name) => {
        const ranges = coverage(files.get(name)).ranges;
        const mine = [...remaining].filter((c) => covers(ranges, c));
        for (const c of mine) remaining.delete(c);
        return { name, order: name, codePoints: mine };
      }).filter((f) => f.codePoints.length);
      return { families, none: [...remaining] };
    };
    _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => invoke, booted: async () => {}, os: () => 'macos' });
    await addFontFile(fontFile('MyBangers.ttf', bangers));
    await useTextEngine('rust');
    const first = '\u0606';
    const text = first + '♪'.repeat(4);
    const b = box('MyBangers', { text, w: 2000, h: 500 });
    const p = doc([b])[0];
    lettersOf(b.style, text);
    await fontsSettling([p]);
    expect(lettersOf(b.style, text).borrowed).toEqual([{ family: 'Later', letters: expect.arrayContaining([cp(first), cp('♪')]) }]);
    expect(boxLetters(b, p)).toEqual(lettersOf(b.style, text));
    b.w = width;
    Object.assign(b.style, style);
    const placed = placeBlock(boxCandidate(b, text));
    const runs = placed.isCurve ? placed.layout.map((g) => g.ch) : placed.lines;
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.some((run) => run.startsWith('♪'))).toBe(true);
    const actual = boxLetters(b, p);
    expect(actual).toEqual({ borrowed: expect.arrayContaining([
      { family: 'Later', letters: [cp(first)] },
      { family: 'Early', letters: [cp('♪')] },
    ]), none: [], pending: [], unread: [] });
    expect(actual.borrowed).toHaveLength(2);
    expect(boxesBorrowingLetters([p])[0].borrowed).toEqual(actual.borrowed);
  });
});

describe('a box whose font lacks a heart and a note', () => {
  it('waits for the family that has them, then is laid out in that family’s widths', async () => {
    await on({ hold: true });
    loadProjectPages(doc([box('MyBangers')]));
    const b = page().boxes[0];
    // One question, both letters; the box is as it was on file.
    expect(invoke.calls).toEqual(['system_font_coverage 2665 266a']);
    expect(b.h).toBe(20);
    expect(autoFitBox(b, page())).toBe(false);
    // Meanwhile the heart is Bangers' empty box, and nothing is written from it.
    const empty = lineWidth('♥', b.style, SIZE);
    expect(empty).toBe(alone.advance('Bangers', '♥'));
    expect(lettersOf(b.style, b.text).pending).toEqual([cp('♥'), cp('♪')]);

    const settling = fontsSettling(app.pages);
    let done = false;
    settling.then(() => (done = true));
    invoke.release();
    await vi.waitFor(() => expect(invoke.calls).toContain('DejaVu Sans/regular'));
    expect(done).toBe(false);
    expect(b.h).toBe(20);
    for (let i = 0; i < 4 && !done; i++) {
      invoke.release();
      await new Promise((r) => setTimeout(r, 0));
    }
    await settling;

    // In: read once a file, asked once, and the chain is the last resort and then the family.
    expect(invoke.calls).toEqual(['system_font_coverage 2665 266a', 'DejaVu Sans/regular', 'DejaVu Sans/italic']);
    expect(engine.fallbacks()).toEqual(['Helvetica Neue', 'DejaVu Sans']);
    // The app's own measuring function now gives DejaVu's heart, in a Bangers style.
    expect(lineWidth('♥', b.style, SIZE)).toBe(alone.advance('DejaVu Sans', '♥'));
    expect(lineWidth('♥', b.style, SIZE)).not.toBe(empty);
    expect(lineWidth('I ♥ YOU ♪', b.style, SIZE)).toBeCloseTo(
      alone.advance('Bangers', 'I ') + alone.advance('DejaVu Sans', '♥') + alone.advance('Bangers', ' YOU ') + alone.advance('DejaVu Sans', '♪'),
      9,
    );
    expect(lineWidth('WAVE', b.style, SIZE)).toBe(alone.advance('Bangers', 'WAVE'));
    // The box that waited was fitted, once, against those widths.
    expect(b.h).toBe(need(b));
    expect(b.h).toBeGreaterThan(20);
    expect(boxesBorrowingLetters()).toEqual([{ pageIndex: 0, boxId: 'b1', borrowed: [{ family: 'DejaVu Sans', letters: [cp('♥'), cp('♪')] }], none: [], unread: [] }]);
  });

  it('keeps kana, which nothing here has, as the empty box and says so', async () => {
    await on();
    loadProjectPages(doc([box('MyBangers', { text: 'あ ♥' })]));
    const b = page().boxes[0];
    await fontsSettling(app.pages);
    expect(invoke.calls[0]).toBe('system_font_coverage 2665 3042');
    expect(boxesBorrowingLetters()).toEqual([{ pageIndex: 0, boxId: 'b1', borrowed: [{ family: 'DejaVu Sans', letters: [cp('♥')] }], none: [cp('あ')], unread: [] }]);
    expect(lineWidth('あ', b.style, SIZE)).toBe(alone.advance('Bangers', 'あ'));
    expect(b.h).toBe(need(b));
  });
});
