import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readPsd } from 'ag-psd';
import { rustEngine, fixtureFont } from '../test/rust-engine.js';
import { buildCollection, systemFaceAnswer } from '../test/font-collection.js';
import { coverage, covers } from '../../scripts/text-port/lib/cmap.mjs';
import { app, loadProjectPages, page, fontsSettling, setFontSource } from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { engineSwitch, useTextEngine, _setEngineSwitchDeps, _resetEngineSwitch } from './engine-switch.svelte.js';
import { textEngine, setTextEngine, engineDraws } from './text-engine/index.js';
import { addFontFile, removeUserFont, systemFontEntry, watchUserFaces, resolveFace } from './fonts.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo, layoutLines, applyCase, contentWidth } from './measure.js';
import { boxCandidate, placeBlock } from './contain.js';
import {
  fontRequestFor, textLayerFor, buildPagePsd, pagePsdDocument, writePagePsd, reconstructForeign, fontMissingMark, BORROWED_MARK, RASTER_MARK, REVIEW_MARK,
} from './psd.js';
import { fakeIndexedDB } from '../test/fake-indexeddb.js';

// ===========================================================================
// The PSD writer with the Rust engine drawing
// ===========================================================================
// The real switch, the real engine and the fixture fonts, handed over the way
// the app hands fonts over: user faces through fonts.js, system faces through
// the answer the native command gives. Only `invoke`, `FontFace` and the
// document are stood in for. What is checked is what a type layer SAYS about
// the face its pixels were drawn in - the name, the two faux flags, the
// fonts of borrowed letters - against what the engine did.
//
// No canvas here: `textLayerFor` takes the box's raster as an argument and
// draws nothing. The pixels and the self-test are the browser's to show
// (scripts/text-port/p8-audit.mjs).

const comic = fixtureFont('ComicNeue-Regular.ttf');
const bangers = fixtureFont('Bangers-Regular.ttf');
const dejavu = fixtureFont('DejaVuSans.ttf');
const oblique = fixtureFont('DejaVuSans-Oblique.ttf');
const copy = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const fontFile = (name, bytes) => ({ name, arrayBuffer: async () => copy(bytes) });
// A file that says it is WOFF2 and is not one: the browser's stand-in takes
// it, the native decoder refuses it.
const notWoff = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4, 5, 6, 7, 8]);

const SIZE = 26;
const style = (font, extra = {}) => ({ font, size: SIZE, lineHeight: 1.1, align: 'center', valign: 'top', color: '#000000', strokes: [], ...extra });
const box = (font, extra = {}, over = {}) => ({ id: 'b1', lineN: null, text: 'THE QUICK BROWN FOX JUMPS', x: 100, y: 500, w: 150, h: 120, ...over, style: style(font, extra) });
const doc = (boxes) => [{ id: 1, w: 800, h: 1200, lines: [], boxes }];

// The machine. The stand-in native side does not read names, so what a
// family's file IS shows in the PostScript name that comes out:
//
//   Helvetica Neue   the Mac's last resort; its regular is Comic Neue's file
//   DejaVu Sans      a regular and an italic (the oblique), two files
//   Sys Two          one collection: regular = Comic Neue, bold = Bangers
const FILES = {
  'Helvetica Neue': [{ slots: { regular: 0 }, bytes: comic }],
  'DejaVu Sans': [{ slots: { regular: 0 }, bytes: dejavu }, { slots: { italic: 0 }, bytes: oblique }],
  'Sys Two': [{ slots: { regular: 0, bold: 1 }, bytes: buildCollection([comic, bangers]) }],
};
const RANGES = coverage(dejavu).ranges;
function fakeInvoke() {
  return async (cmd, args) => {
    if (cmd === 'system_font_coverage') {
      const mine = args.codePoints.filter((c) => covers(RANGES, c));
      return { families: mine.length ? [{ name: 'DejaVu Sans', order: '1dejavu sans\u0001DejaVu Sans', codePoints: mine }] : [], none: args.codePoints.filter((c) => !covers(RANGES, c)) };
    }
    if (cmd === 'font_to_sfnt') throw new Error('not a WOFF file');
    if (cmd !== 'system_font_face') throw new Error(`unexpected command ${cmd}`);
    const file = (FILES[args.family] ?? []).find((f) => args.slot in f.slots);
    if (!file) throw new Error(`no font called '${args.family}' is installed on this computer`);
    return systemFaceAnswer(file.slots, file.bytes, { known: args.known });
  };
}

const original = { engine: textEngine(), typeset: typesetEnabled(), system: app.fonts.system };
const library = fakeIndexedDB();
let engine;

async function on() {
  const invoke = fakeInvoke();
  _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => invoke, booted: async () => {}, os: () => 'macos' });
  await useTextEngine('rust');
  expect(engineSwitch).toMatchObject({ phase: 'on', lastResort: 'Helvetica Neue', painting: true });
  expect(engineDraws()).toBe(true);
}
// The page loaded and everything its boxes need in the engine, as an export finds it.
async function open(boxes) {
  loadProjectPages(doc(boxes));
  await fontsSettling(app.pages);
  return page();
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
  engine = await rustEngine({ fixtures: false });
  app.fonts.system = [
    systemFontEntry({ name: 'Helvetica Neue', faces: { regular: true } }),
    systemFontEntry({ name: 'DejaVu Sans', faces: { regular: true, italic: true } }),
    systemFontEntry({ name: 'Sys Two', faces: { regular: true, bold: true } }),
  ];
});

afterEach(async () => {
  _resetEngineSwitch();
  _setEngineSwitchDeps(null);
  setFontSource(null);
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

describe('the font a type layer names is the face the engine drew', () => {
  it('a user font: the name its file states, and a flag only for what the engine synthesised', async () => {
    await addFontFile(fontFile('MyBangers.ttf', bangers));
    await on();
    await open([box('MyBangers')]);
    expect(fontRequestFor(style('MyBangers'))).toEqual({ name: 'Bangers-Regular', fauxBold: false, fauxItalic: false });
    // No bold file: the regular, emboldened by the engine, and said so.
    expect(fontRequestFor(style('MyBangers', { bold: true, italic: true }))).toEqual({ name: 'Bangers-Regular', fauxBold: true, fauxItalic: true });
  });

  it('a system font: the name in the installed file, not the family with a suffix', async () => {
    await on();
    await open([box('Sys Two', { bold: true }), box('DejaVu Sans', { italic: true }, { id: 'b2' })]);
    // What the browser path constructs for the same box: `SysTwo-Bold`, a name no font has.
    expect(fontRequestFor(style('Sys Two', { bold: true }))).toEqual({ name: 'Bangers-Regular', fauxBold: false, fauxItalic: false });
    expect(fontRequestFor(style('Sys Two'))).toEqual({ name: 'ComicNeue-Regular', fauxBold: false, fauxItalic: false });
    expect(fontRequestFor(style('DejaVu Sans'))).toEqual({ name: 'DejaVuSans', fauxBold: false, fauxItalic: false });
    expect(fontRequestFor(style('DejaVu Sans', { italic: true }))).toEqual({ name: 'DejaVuSans-Oblique', fauxBold: false, fauxItalic: false });
    // Per axis: the real italic, emboldened.
    expect(fontRequestFor(style('DejaVu Sans', { bold: true, italic: true }))).toEqual({ name: 'DejaVuSans-Oblique', fauxBold: true, fauxItalic: false });
    // And it is what goes into the layer.
    const layer = textLayerFor(page(), page().boxes[0], null);
    expect(layer.text.style).toMatchObject({ font: { name: 'Bangers-Regular' }, fauxBold: false, fauxItalic: false });
    expect(layer.name).toBe('THE QUICK BROWN FOX JUMPS');
  });

  it('the flags are the engine’s, where the app’s list and the engine disagree about a face', async () => {
    // The library lists an italic; the engine could not read that file, so it
    // slants the regular. The list would say "a real italic was used".
    await addFontFile(fontFile('MyComic.ttf', comic));
    await addFontFile(fontFile('MyComic-Italic.woff2', notWoff));
    await on();
    await open([box('MyComic', { italic: true })]);
    expect(resolveFace('MyComic', { italic: true })).toMatchObject({ slot: 'italic', fauxItalic: false, known: true });
    expect(engine.facesOf('MyComic')).toEqual(['regular']);
    expect(fontRequestFor(style('MyComic', { italic: true }))).toEqual({ name: 'ComicNeue-Regular', fauxBold: false, fauxItalic: true });
  });

  it('with the switch off the browser path answers, as it did', async () => {
    await addFontFile(fontFile('MyBangers.ttf', bangers));
    expect(engineDraws()).toBe(false);
    // The name parsed in JS for a user face, the constructed one for a system face.
    expect(fontRequestFor(style('MyBangers', { bold: true }))).toEqual({ name: 'Bangers-Regular', fauxBold: true, fauxItalic: false });
    expect(fontRequestFor(style('Sys Two', { bold: true }))).toEqual({ name: 'SysTwo-Bold', fauxBold: false, fauxItalic: false });
    const b = box('No Such Font');
    expect(textLayerFor({ lines: [] }, b, null).name).toBe('THE QUICK BROWN FOX JUMPS');
  });
});

describe('a box whose font this machine does not have', () => {
  it('names the last-resort face it was drawn in, and says in the layer name which font is missing', async () => {
    await on();
    const p = await open([box('No Such Font', { bold: true })]);
    const layer = textLayerFor(p, p.boxes[0], null);
    // Helvetica Neue stands in, and its file here is Comic Neue's.
    expect(layer.text.style).toMatchObject({ font: { name: 'ComicNeue-Regular' }, fauxBold: true, fauxItalic: false });
    expect(layer.name).toBe(`THE QUICK BROWN FOX JUMPS${fontMissingMark('No Such Font')}`);
    expect(layer.name).toBe('THE QUICK BROWN FOX JUMPS [font missing: No Such Font]');
    // The lines are the stand-in's: the face that was measured is the face named.
    expect(layer.text.text).toBe(placeBlock(boxCandidate(p.boxes[0], p.boxes[0].text)).lines.join('\n'));
  });

  it('a raster-only layer says so too, after the review flag and before the raster marker, and the importer takes it back off', async () => {
    await on();
    const b = box('No Such Font', { curve: 30 }, { review: true });
    const p = await open([b]);
    const rendered = { imageData: { width: 4, height: 4, data: new Uint8ClampedArray(64) }, left: 100, top: 500, right: 250, bottom: 620 };
    const layer = textLayerFor(p, p.boxes[0], rendered);
    expect(layer.text).toBeUndefined();
    expect(layer.name).toBe(`THE QUICK BROWN FOX JUMPS${REVIEW_MARK} [font missing: No Such Font]${RASTER_MARK}`);
    const back = await reconstructForeign({ width: 800, height: 1200, children: [{ name: 'Text', children: [{ ...layer, imageData: undefined }] }] });
    expect(back.boxes.map((x) => x.text)).toEqual(['THE QUICK BROWN FOX JUMPS']);
  });

  it('a font the machine has is not marked', async () => {
    await on();
    const p = await open([box('DejaVu Sans')]);
    expect(textLayerFor(p, p.boxes[0], null).name).toBe('THE QUICK BROWN FOX JUMPS');
  });
});

describe('a box that borrows letters from another family', () => {
  const READ = { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true };

  it('stays a live layer, each borrowed stretch in the font that drew it, and the name says so', async () => {
    await addFontFile(fontFile('MyBangers.ttf', bangers));
    await on();
    const p = await open([box('MyBangers', {}, { text: 'I ♥ YOU ♪♪', w: 300 })]);
    expect(engine.fallbacks()).toEqual(['Helvetica Neue', 'DejaVu Sans']);
    const layer = textLayerFor(p, p.boxes[0], null);
    expect(layer.text.text).toBe('I ♥ YOU ♪♪');
    expect(layer.name).toBe(`I ♥ YOU ♪♪${BORROWED_MARK}`);
    expect(layer.text.style).toMatchObject({ font: { name: 'Bangers-Regular' }, fauxBold: false, fauxItalic: false });
    const lent = { font: { name: 'DejaVuSans' }, fauxBold: false, fauxItalic: false };
    expect(layer.text.styleRuns).toEqual([
      { length: 2, style: {} },
      { length: 1, style: lent },
      { length: 5, style: {} },
      { length: 2, style: lent },
    ]);
    expect(layer.text.styleRuns.reduce((n, r) => n + r.length, 0)).toBe(layer.text.text.length);

    // Through a real file: the fonts of the runs are what a reader finds.
    const psd = readPsd(writePagePsd(pagePsdDocument({ w: 800, h: 1200, textLayers: [layer], project: {} })), READ);
    const read = psd.children.find((c) => c.name === 'Text').children[0];
    expect(read.name).toBe(`I ♥ YOU ♪♪${BORROWED_MARK}`);
    expect(read.text.styleRuns.map((r) => [r.length, r.style.font?.name])).toEqual([[2, 'Bangers-Regular'], [1, 'DejaVuSans'], [5, 'Bangers-Regular'], [2, 'DejaVuSans']]);
  });

  it('a lender that is emboldened or slanted for the box says so on its own stretch', async () => {
    await addFontFile(fontFile('MyBangers.ttf', bangers));
    await on();
    const p = await open([box('MyBangers', { bold: true, italic: true }, { text: 'A♥', w: 300 })]);
    const layer = textLayerFor(p, p.boxes[0], null);
    // DejaVu Sans was named for the heart by its first face, the regular: that
    // face lends in every weight and slant (rule 11), synthesised to the box's.
    expect(layer.text.styleRuns).toEqual([
      { length: 1, style: {} },
      { length: 1, style: { font: { name: 'DejaVuSans' }, fauxBold: true, fauxItalic: true } },
    ]);
  });

  it('a letter nothing has stays in the box’s own font, and a box with no borrowed letter has no runs', async () => {
    await addFontFile(fontFile('MyBangers.ttf', bangers));
    await on();
    const p = await open([box('MyBangers', {}, { text: 'あ!' }), box('MyBangers', {}, { id: 'b2' })]);
    for (const b of p.boxes) {
      const layer = textLayerFor(p, b, null);
      expect(layer.text.styleRuns).toBeUndefined();
      expect(layer.name.endsWith(BORROWED_MARK)).toBe(false);
    }
  });
});

describe('the lines of a type layer are the engine’s', () => {
  it('writes the breaks the engine made, with the engine’s own measurer behind placeBlock', async () => {
    await addFontFile(fontFile('MyBangers.ttf', bangers));
    await on();
    const p = await open([box('MyBangers', {}, { text: 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG AGAIN', w: 170 })]);
    const b = p.boxes[0];
    const layer = textLayerFor(p, b, null);
    const lines = layoutLines(applyCase(b.text, b.style), b.style, b.style.size, contentWidth(b.w, b.style));
    expect(lines.length).toBeGreaterThan(2);
    expect(layer.text.text).toBe(lines.join('\n'));
    // Every line fits the content box by the engine's own advance: they are its breaks.
    const face = { key: 'k', name: 'MyBangers', bold: false, italic: false, size: SIZE, css: 'MyBangers' };
    for (const line of lines) expect(engine.advance(face, line)).toBeLessThanOrEqual(contentWidth(b.w, b.style));
  });
});

describe('what a PSD waits for', () => {
  // A page with no boxes and no art: the one shape `buildPagePsd` gets
  // through without a canvas (see psd.test.js).
  const bare = { id: 7, w: 300, h: 420, lines: [], boxes: [] };
  function stubDocument() {
    const asked = { ready: 0 };
    vi.stubGlobal('document', {
      fonts: {
        add() {},
        delete() {},
        get ready() {
          asked.ready++;
          return Promise.resolve();
        },
      },
      createElement: () => ({ getContext: () => { throw new Error('drew on a canvas'); } }),
    });
    return asked;
  }

  it('the engine’s gate, and not the browser’s font set, when the engine draws', async () => {
    await on();
    const asked = stubDocument();
    const settled = [];
    const real = fontsSettling;
    expect(real([bare])).not.toBe(null);
    setFontSource({ ready: () => true, nameFor: () => 'Helvetica Neue', missing: () => false, settle: async (pages) => void settled.push(pages) });
    const bytes = await buildPagePsd(bare);
    expect(settled).toEqual([[bare]]);
    expect(asked.ready).toBe(0);
    expect(readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true }).width).toBe(300);
  });

  it('a gate that gives up is a PSD that is not built', async () => {
    await on();
    stubDocument();
    setFontSource({ ready: () => true, settle: () => Promise.reject(new Error('the fonts kept changing while it waited for them; nothing was written. Try again.')) });
    await expect(buildPagePsd(bare)).rejects.toThrow('the fonts kept changing');
  });

  it('the engine taken away while it is built: no file, and it says why', async () => {
    await on();
    stubDocument();
    // Canvas creation is after the font wait. Page fields are now copied
    // before that wait, so a page getter would switch during capture instead.
    const create = document.createElement;
    document.createElement = (...args) => {
      useTextEngine('browser');
      return create(...args);
    };
    setFontSource({ ready: () => true, nameFor: () => 'Helvetica Neue', missing: () => false, settle: async () => {} });
    await expect(buildPagePsd(bare)).rejects.toThrow('the text engine was switched');
    expect(engineDraws()).toBe(false);
  });

  it('the engine taken away while its fonts are waited for: the browser’s are waited for instead, and it is built', async () => {
    await on();
    const asked = stubDocument();
    setFontSource({ ready: () => true, settle: async () => void useTextEngine('browser') });
    const bytes = await buildPagePsd(bare);
    // Once where it always was (the browser draws after all), once more as
    // the wait of the engine now installed.
    expect(asked.ready).toBe(2);
    expect(readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true }).width).toBe(300);
  });

  it('with the switch off it waits for the browser’s fonts, as it did', async () => {
    const asked = stubDocument();
    expect(fontsSettling([bare])).toBe(null);
    await buildPagePsd(bare);
    expect(asked.ready).toBe(1);
  });
});
