import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rustEngine, fixtureFont } from '../test/rust-engine.js';
import { buildCollection, systemFaceAnswer } from '../test/font-collection.js';
import { app, loadProjectPages, page, autoFitBox, fontNameFor, fontCssFor, fontMissing, missingFonts } from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { engineSwitch, useTextEngine, boxesMissingLetters, _setEngineSwitchDeps, _resetEngineSwitch, _engineSwitchSync } from './engine-switch.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { addFontFile, removeUserFont, systemFontEntry, watchUserFaces } from './fonts.js';
import {
  canMeasure, lineWidth, fontMetrics, faceFor, layoutLines, applyCase, contentWidth, textInset, setTypesetEnabled, typesetEnabled, clearLayoutMemo,
} from './measure.js';
import { neededHeight } from './typeset.js';
import { boxCandidate, placeBlock, containBox } from './contain.js';
import { defaultStyle, normalizeStyle } from './data.js';

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
    if (cmd !== 'system_font_face') throw new Error(`unexpected command ${cmd}`);
    const file = (FILES[args.family] ?? []).find((f) => args.slot in f.slots);
    if (!file) throw new Error(`no font called '${args.family}' is installed on this computer`);
    return systemFaceAnswer(file.slots, file.bytes);
  };
  invoke.calls = calls;
  return invoke;
}

const original = { engine: textEngine(), typeset: typesetEnabled(), system: app.fonts.system };
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
});
