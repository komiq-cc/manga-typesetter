import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import { rustEngine, fixtureFont, engineWasm } from '../test/rust-engine.js';
import { buildCollection, systemFaceAnswer } from '../test/font-collection.js';
import {
  app, loadProjectPages, page, autoFitBox, fontNameFor, fontCssFor, fontMissing, missingFonts, placeActiveAt, boxEdited, recordEdit, fitGeom, cloneStyle,
} from './store.svelte.js';
import { initHistory, resetHistory, undo, redo, peekStack } from './editor/history.svelte.js';
import { engineSwitch, useTextEngine, boxesMissingLetters, _setEngineSwitchDeps, _resetEngineSwitch, _engineSwitchSync } from './engine-switch.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { createRustTextEngine } from './text-engine/rust.js';
import { addFontFile, removeUserFont, systemFontEntry, watchUserFaces } from './fonts.js';
import {
  canMeasure, lineWidth, fontMetrics, faceFor, layoutLines, applyCase, contentWidth, textInset, setTypesetEnabled, typesetEnabled, clearLayoutMemo,
} from './measure.js';
import { neededHeight } from './typeset.js';
import { boxCandidate, placeBlock, containBox } from './contain.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { fakeIndexedDB } from '../test/fake-indexeddb.js';

// ===========================================================================
// The switch on the real engine: the wasm, the fixture fonts, the real store
// ===========================================================================
// engine-switch.test.js runs these paths on a stand-in engine. Here the engine
// is the one the app loads, handed the fixture fonts the way the app hands it
// fonts: user faces through fonts.js, system faces through the answer the
// native command gives. What is still faked is only what a browser and the
// Tauri process would supply - `FontFace`, and `invoke`.

const comic = fixtureFont('ComicNeue-Regular.ttf');
const bangers = fixtureFont('Bangers-Regular.ttf');
const dejavu = fixtureFont('DejaVuSans.ttf');
const oblique = fixtureFont('DejaVuSans-Oblique.ttf');
const copy = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const fontFile = (name, bytes) => ({ name, arrayBuffer: async () => copy(bytes) });

const SIZE = 26;
const styleFor = (font, extra = {}) => normalizeStyle({ ...defaultStyle(), font, size: SIZE, bold: false, ...extra });
const box = (font, over = {}) => ({
  id: 'b1', lineN: null, text: 'THE QUICK BROWN FOX JUMPS', x: 100, y: 500, w: 150, h: 20,
  ...over,
  style: { font, size: SIZE, lineHeight: 1.1, valign: 'top', outlineWidth: 0, ...over.style },
});
const doc = (boxes) => [{ id: 1, w: 800, h: 1200, lines: [], boxes }];

// The machine's fonts: DejaVu Sans in two files, and a two-face collection.
const FILES = {
  'DejaVu Sans': [{ slots: { regular: 0 }, bytes: dejavu }, { slots: { italic: 0 }, bytes: oblique }],
  'Comic Bangers': [{ slots: { regular: 0, bold: 1 }, bytes: buildCollection([comic, bangers]) }],
};
function fakeInvoke() {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push(cmd === 'system_font_face' ? `${args.family}/${args.slot}` : cmd);
    // Asked which installed family has a letter: on this machine, none does.
    // (Refused, the question would be one nobody answered, and the letters
    // would not be said to be in no font.)
    if (cmd === 'system_font_coverage') return { families: [], none: args.codePoints };
    if (cmd !== 'system_font_face') throw new Error(`unexpected command ${cmd}`);
    const file = (FILES[args.family] ?? []).find((f) => args.slot in f.slots);
    if (!file) throw new Error(`no font called '${args.family}' is installed on this computer`);
    return systemFaceAnswer(file.slots, file.bytes, { known: args.known });
  };
  invoke.calls = calls;
  return invoke;
}

const original = { engine: textEngine(), typeset: typesetEnabled(), system: app.fonts.system };
// The user's font library: where a watcher that starts late reads the bytes
// back from. One for the file, emptied between cases - fonts.js keeps its
// connection.
const library = fakeIndexedDB();
let engine;
let invoke;
// What each fixture measures by itself, from an engine nobody else touches.
let alone;

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
  const f = (name, extra) => ({ key: name + JSON.stringify(extra ?? {}), name, bold: false, italic: false, size: SIZE, css: name, ...extra });
  alone = {
    comic: reference.advance(f('Comic Neue'), 'WAVE'),
    bangers: reference.advance(f('Bangers'), 'WAVE'),
    dejavu: reference.advance(f('DejaVu Sans'), 'WAVE'),
    oblique: reference.advance(f('DejaVu Sans', { italic: true }), 'WAVE'),
    dejavuBox: reference.fontBox(f('DejaVu Sans')),
  };
  engine = await rustEngine({ fixtures: false });
  invoke = fakeInvoke();
  app.fonts.system = [
    systemFontEntry({ name: 'Comic Bangers', faces: { regular: true, bold: true } }),
    systemFontEntry({ name: 'DejaVu Sans', faces: { regular: true, italic: true } }),
  ];
  _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => invoke, booted: async () => {}, os: () => 'linux' });
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

describe('switched on, the app measures with the engine and the fonts it was handed', () => {
  it('a user face loaded before the switch, and ones loaded after', async () => {
    await addFontFile(fontFile('Bangers.ttf', bangers));
    await addFontFile(fontFile('Early.ttf', comic));
    expect(canMeasure()).toBe(false);
    await useTextEngine('rust');
    expect(engineSwitch).toMatchObject({ phase: 'on', lastResort: 'DejaVu Sans' });
    expect(canMeasure()).toBe(true);
    expect(textEngine()).toBe(engine);
    // The library refuses a user font under a built-in's name ("Bangers" is
    // one), so that file never loaded and the name is a font the engine has
    // no bytes for. Under its own name the same file is measured as itself.
    expect(app.fonts.user.map((f) => f.name)).toEqual(['Early']);
    expect(lineWidth('WAVE', styleFor('Bangers'), SIZE)).toBe(alone.dejavu);
    expect(lineWidth('WAVE', styleFor('Early'), SIZE)).toBe(alone.comic);
    await addFontFile(fontFile('MyBangers.ttf', bangers));
    await addFontFile(fontFile('MyComic.ttf', comic));
    expect(lineWidth('WAVE', styleFor('MyBangers'), SIZE)).toBe(alone.bangers);
    expect(lineWidth('WAVE', styleFor('MyComic'), SIZE)).toBe(alone.comic);
    await removeUserFont('MyComic');
    expect(lineWidth('WAVE', styleFor('MyComic'), SIZE)).toBe(alone.dejavu);
  });

  it('a name the machine has no font for is the last resort’s numbers, face and line box', async () => {
    await useTextEngine('rust');
    expect(invoke.calls).toEqual(['DejaVu Sans/regular', 'DejaVu Sans/italic']);
    for (const name of ['No Such Font', 'Bangers', 'Comic Neue']) {
      const s = styleFor(name);
      expect(fontMissing(name)).toBe(true);
      expect(fontNameFor(name)).toBe('DejaVu Sans');
      expect(fontCssFor(name)).toBe('"DejaVu Sans", sans-serif');
      expect(faceFor(s, SIZE).name).toBe('DejaVu Sans');
      expect(lineWidth('WAVE', s, SIZE)).toBe(alone.dejavu);
      expect(lineWidth('WAVE', { ...s, italic: true }, SIZE)).toBe(alone.oblique);
      expect(fontMetrics(s, SIZE)).toEqual(alone.dejavuBox);
    }
    expect(fontMissing('DejaVu Sans')).toBe(false);
  });

  it('an unknown name is not answered from a memo another family filled', async () => {
    await addFontFile(fontFile('MyComic.ttf', comic));
    await useTextEngine('rust');
    const text = 'KEPT IN THE MEMO';
    const mine = lineWidth(text, styleFor('MyComic'), SIZE);
    const resort = lineWidth(text, styleFor('DejaVu Sans'), SIZE);
    expect(mine).not.toBe(resort);
    expect(lineWidth(text, styleFor('No Such Font'), SIZE)).toBe(resort);
    expect(lineWidth(text, styleFor('Comic Neue'), SIZE)).toBe(resort);
    // And nothing here throws: the engine is never asked for a family it does not hold.
    expect(() => layoutLines(text, styleFor('No Such Font'), SIZE, 120)).not.toThrow();
  });

  it('a system family is read on first use: the box waits, then is fitted in its own faces', async () => {
    await useTextEngine('rust');
    invoke.calls.length = 0;
    loadProjectPages(doc([box('Comic Bangers'), box('Comic Bangers', { id: 'b2', y: 700, style: { bold: true } })]));
    const [regular, bold] = page().boxes;
    expect(invoke.calls).toEqual(['Comic Bangers/regular']);
    expect(regular.h).toBe(20);
    expect(autoFitBox(regular, page())).toBe(false);
    const version = app.fontsVersion;
    await _engineSwitchSync().settled();
    expect(app.fontsVersion).toBe(version + 1);
    expect(fontNameFor('Comic Bangers')).toBe('Comic Bangers');
    expect(lineWidth('WAVE', regular.style, SIZE)).toBe(alone.comic);
    expect(lineWidth('WAVE', bold.style, SIZE)).toBe(alone.bangers);
    // Each grown to its own lines, and each passes the check every renderer answers to.
    for (const b of [regular, bold]) {
      const lines = layoutLines(applyCase(b.text, b.style), b.style, SIZE, contentWidth(b.w, b.style));
      expect(lines.length).toBeGreaterThan(1);
      expect(b.h).toBeGreaterThanOrEqual(neededHeight(lines.length, b.style, textInset(b.style)));
      const cand = boxCandidate(b, b.text);
      expect(containBox(cand, placeBlock(cand)).fits).toBe(true);
    }
    // One request: the collection's two faces came in one answer.
    expect(invoke.calls).toEqual(['Comic Bangers/regular']);
  });

  it('lists the chapter’s missing fonts and the boxes with letters no face has', async () => {
    await addFontFile(fontFile('MyBangers.ttf', bangers));
    loadProjectPages(doc([
      box('MyBangers', { id: 'ok' }),
      box('Bangers', { id: 'builtin' }),
      box('Gone Font', { id: 'gone' }),
      box('MyBangers', { id: 'greek', text: 'Ω!' }),
      box('MyBangers', { id: 'kana', text: 'こんにちは' }),
    ]));
    expect(missingFonts()).toEqual([{ name: 'Gone Font', boxes: 1 }]);
    expect(boxesMissingLetters()).toEqual([]);
    await useTextEngine('rust');
    expect(missingFonts()).toEqual([{ name: 'Bangers', boxes: 1 }, { name: 'Gone Font', boxes: 1 }]);
    // Greek is found in the last resort; kana is in no font this machine was given.
    expect(boxesMissingLetters()).toEqual([{ pageIndex: 0, boxId: 'kana', letters: [...'こんにちは'].map((c) => c.codePointAt(0)) }]);
  });

  it('switched off, nothing of it is left: no engine, no fonts in it, the old answers', async () => {
    await addFontFile(fontFile('MyBangers.ttf', bangers));
    await useTextEngine('rust');
    const held = engine.low.heapLive();
    await useTextEngine('browser');
    expect(textEngine()).toBe(original.engine);
    expect(canMeasure()).toBe(false);
    for (const name of ['MyBangers', 'DejaVu Sans']) expect(engine.hasFamily(name)).toBe(false);
    expect(held - engine.low.heapLive()).toBeGreaterThan(bangers.byteLength + dejavu.byteLength);
    expect(fontNameFor('No Such Font')).toBe('Comic Neue');
    expect(fontMissing('Bangers')).toBe(false);
  });

  // The instance is the engine's heap, and a wasm memory never shrinks: only
  // letting go of the instance gives it back. Asked of the collector, through
  // the memory each instance exports, held weakly.
  it('switched off, the instance itself goes; on again is a new one made of the same compiled module', async () => {
    v8.setFlagsFromString('--expose-gc');
    const collect = vm.runInNewContext('gc');
    const alive = async (ref) => {
      // A WeakRef keeps its target for the rest of the turn it was read in.
      await new Promise((resolve) => setTimeout(resolve, 0));
      collect();
      return ref.deref() !== undefined;
    };
    const compile = vi.fn(() => WebAssembly.compile(engineWasm()));
    const modules = [];
    const memories = [];
    _setEngineSwitchDeps({
      available: () => true,
      compile,
      createEngine: async (module) => {
        modules.push(module);
        const made = await createRustTextEngine(module);
        memories.push(new WeakRef(made.low.exports.memory));
        return made;
      },
      invoke: async () => invoke,
      booted: async () => {},
      os: () => 'linux',
    });
    await addFontFile(fontFile('MyBangers.ttf', bangers));
    await useTextEngine('rust');
    expect(lineWidth('WAVE', styleFor('MyBangers'), SIZE)).toBe(alone.bangers);
    expect(await alive(memories[0])).toBe(true);

    await useTextEngine('browser');
    expect(await alive(memories[0])).toBe(false);

    await useTextEngine('rust');
    expect(compile).toHaveBeenCalledTimes(1);
    expect(modules).toHaveLength(2);
    expect(modules[0]).toBeInstanceOf(WebAssembly.Module);
    expect(modules[1]).toBe(modules[0]);
    expect(memories).toHaveLength(2);
    expect(await alive(memories[1])).toBe(true);
    // The new instance has the fonts and measures as the first did.
    expect(lineWidth('WAVE', styleFor('MyBangers'), SIZE)).toBe(alone.bangers);
    expect(fontNameFor('No Such Font')).toBe('DejaVu Sans');
  });
});

// ===========================================================================
// Nothing is written early, and what is written late can be undone
// ===========================================================================
// A face can be on its way for a while: a WOFF2 being decoded, a system file
// being read. These are the three ways a number measured meanwhile used to get
// into the document, on the real engine, where the numbers are real.

// A file that says it is WOFF2; what is "decoded" from it is handed back by
// the stand-in for the native side, when the test lets it.
const woff2 = () => Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0, 0, 0, 0, 0]);

// The native side with a decode that waits: `land(bytes)` answers it.
function slowDecode() {
  let land;
  const decoded = new Promise((resolve) => (land = resolve));
  const native = async (cmd, args) => (cmd === 'font_to_sfnt' ? copy(await decoded) : invoke(cmd, args));
  _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => native, booted: async () => {}, os: () => 'linux' });
  return (bytes) => land(bytes);
}

describe('a family with one face in and another still being decoded', () => {
  it('writes nothing into a bold box until the bold is in, and then what the real bold needs', async () => {
    const land = slowDecode();
    await addFontFile(fontFile('Mixed.ttf', comic));
    await useTextEngine('rust');
    await addFontFile({ name: 'Mixed-Bold.woff2', arrayBuffer: async () => woff2().buffer });
    expect(_engineSwitchSync().snapshot().user).toEqual({ Mixed: { regular: 'ready', bold: 'decoding' } });

    // A chapter opened now: the regular is in the engine and would be smeared
    // into a bold, wider than the real one, and the box grown for that.
    const bold = () => box('Mixed', { style: { bold: true } });
    loadProjectPages(doc([bold()]));
    const b = page().boxes[0];
    expect(b.h).toBe(20);
    expect(autoFitBox(b, page())).toBe(false);
    expect(b).toMatchObject({ w: 150, h: 20 });
    expect(b.style.size).toBe(SIZE);

    land(bangers);
    await _engineSwitchSync().settled();
    expect(_engineSwitchSync().snapshot().user).toEqual({ Mixed: { regular: 'ready', bold: 'ready' } });
    expect(lineWidth('WAVE', b.style, SIZE)).toBe(alone.bangers);
    const lines = layoutLines(applyCase(b.text, b.style), b.style, b.style.size, contentWidth(b.w, b.style));
    expect(b.h).toBeGreaterThan(20);
    // The same box opened with both faces already in is the same box: nothing
    // of the stand-in's height was kept.
    const settled = { w: b.w, h: b.h, size: b.style.size };
    loadProjectPages(doc([bold()]));
    autoFitBox(page().boxes[0], page());
    const fresh = page().boxes[0];
    expect(settled).toEqual({ w: fresh.w, h: fresh.h, size: fresh.style.size });
    expect(lines.length).toBeGreaterThan(0);
  });
});

// The native side with a system file that takes its time: every family but
// the last resort waits for `land()`.
function slowSystem() {
  let land;
  const read = new Promise((resolve) => (land = resolve));
  const native = async (cmd, args) => {
    if (cmd === 'system_font_face' && args.family !== 'DejaVu Sans') await read;
    return invoke(cmd, args);
  };
  _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => native, booted: async () => {}, os: () => 'linux' });
  return () => land();
}
const rect = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size });

describe('a box in a system family whose file is still being read', () => {
  it('is placed at the constants and solved in its own face when the file lands, one undo for all of it', async () => {
    const land = slowSystem();
    await useTextEngine('rust');
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, en: 'THE QUICK BROWN FOX JUMPS OVER' }], boxes: [], activeLineN: 1 }]);
    app.lastStyle.font = 'Comic Bangers';
    placeActiveAt(400, 600);
    const b = page().boxes[0];
    expect(b.style.font).toBe('Comic Bangers');
    // Not the balanced size of the text in the last resort: no number that was
    // measured meanwhile is in the box or in its history entry.
    expect(b).toMatchObject({ w: 220, h: 92 });
    expect(b.auto.status).toBe('pending');
    expect(peekStack().undo[0].box).toMatchObject({ w: 220, h: 92 });

    land();
    await _engineSwitchSync().settled();
    expect(b.auto.status).not.toBe('pending');
    const solved = rect(b);
    expect(solved).not.toMatchObject({ w: 220, h: 92 });
    const cand = boxCandidate(b, 'THE QUICK BROWN FOX JUMPS OVER');
    expect(containBox(cand, placeBlock(cand)).fits).toBe(true);
    expect(peekStack().undo).toHaveLength(1);
    expect(undo()).toBe(true);
    expect(page().boxes).toHaveLength(0);
    expect(redo()).toBe(true);
    expect(rect(page().boxes[0])).toEqual(solved);
  });

  it('edited before the file lands: undo then redo gives back the fitted edit, not the box the edit left', async () => {
    const land = slowSystem();
    await useTextEngine('rust');
    loadProjectPages(doc([box('Comic Bangers', { w: 60, h: 60 })]));
    const b = page().boxes[0];
    const opened = rect(b);
    expect(opened).toMatchObject({ w: 60, h: 60 });

    // The Inspector's size field, typed while the family is on its way.
    const before = cloneStyle(b.style);
    const geomBefore = fitGeom(b);
    b.style.size = 34;
    boxEdited(b, page());
    recordEdit({ t: 'style', pageId: 1, boxId: b.id, before, after: cloneStyle(b.style), geomBefore, geomAfter: fitGeom(b) });
    expect(rect(b)).toEqual({ ...opened, size: 34 });

    land();
    await _engineSwitchSync().settled();
    const fitted = rect(b);
    expect(fitted.h).toBeGreaterThan(60);
    // Still the one entry, and it ends where the edit ended.
    expect(peekStack().undo).toHaveLength(1);
    expect(peekStack().undo[0].geomAfter).toMatchObject(fitted);
    expect(peekStack().undo[0].fitOwed).toBeUndefined();
    expect(undo()).toBe(true);
    expect(rect(b)).toEqual(opened);
    expect(redo()).toBe(true);
    expect(rect(b)).toEqual(fitted);
  });
});

