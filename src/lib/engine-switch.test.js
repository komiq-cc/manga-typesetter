import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  app, loadProjectPages, page, autoFitBox, refitBox, fitBoxNow, placeActiveAt, fontNameFor, fontCssFor, measuredFontFor, fontMissing, missingFonts,
} from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { engineSwitch, useTextEngine, lettersMissing, boxesMissingLetters, _setEngineSwitchDeps, _resetEngineSwitch, _engineSwitchSync } from './engine-switch.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { _restoreFontRecords, addFontFile, installFontFace, removeFontFace, removeUserFont, systemFontEntry, watchUserFaces } from './fonts.js';
import { lineWidth, faceFor, layoutLines, applyCase, contentWidth, textInset, setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { neededHeight } from './typeset.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { fakeRustEngine, fakeNative, widthOf, SFNT, TTC, WOFF2 } from '../test/fake-rust-engine.js';

// ===========================================================================
// The textEngine switch, with stand-ins for the wasm and the native side
// ===========================================================================
// The real store, the real fonts.js and the real measure.js; what is faked is
// the engine itself (src/test/fake-rust-engine.js, arithmetic instead of
// wasm), `invoke`, and the two things fonts.js needs of a browser to register
// a face. The same paths against the real engine: engine-switch.engine.test.js.

// What measured before the switch, as the canvas does: any family, no registry.
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
  id: 'b1', lineN: null, text: 'AAAA BBBB', x: 100, y: 500, w: 60, h: 20,
  ...over,
  style: { font, size: 20, lineHeight: 1.1, valign: 'top', outlineWidth: 0, ...over.style },
});
// What the box has to be tall for its text, measured by whoever is installed now.
function need(b) {
  const lines = layoutLines(applyCase(b.text, b.style), b.style, b.style.size, contentWidth(b.w, b.style));
  return neededHeight(lines.length, b.style, textInset(b.style));
}

const original = { engine: textEngine(), typeset: typesetEnabled(), system: app.fonts.system };
let browser;
let engine;
let createEngine;

function deps(over = {}) {
  _setEngineSwitchDeps({
    available: () => true,
    createEngine,
    invoke: async () => null,
    booted: async () => {},
    os: () => 'macos',
    ...over,
  });
}

beforeEach(() => {
  // fonts.js registers a face with the browser before it tells anyone.
  vi.stubGlobal('FontFace', class {
    constructor(family, buffer, desc) {
      Object.assign(this, { family, buffer, desc });
    }
    async load() {
      return this;
    }
  });
  vi.stubGlobal('document', { fonts: { add() {}, delete() {} } });
  initHistory();
  resetHistory();
  app.chapterRef = null;
  browser = fakeBrowser();
  setTextEngine(browser);
  setTypesetEnabled(true);
  engine = fakeRustEngine();
  createEngine = vi.fn(async () => engine);
  deps();
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

describe('a build without the wasm', () => {
  it('cannot be switched on: the browser keeps measuring and nothing is loaded', async () => {
    deps({ available: () => false });
    expect(engineSwitch.available).toBe(false);
    await useTextEngine('rust');
    expect(engineSwitch).toMatchObject({ mode: 'rust', phase: 'off', error: '' });
    expect(createEngine).not.toHaveBeenCalled();
    expect(textEngine()).toBe(browser);
    expect(fontNameFor('No Such Font')).toBe('Comic Neue');
    // And off again is just as quiet.
    await useTextEngine('browser');
    expect(engineSwitch).toMatchObject({ mode: 'browser', phase: 'off' });
    expect(textEngine()).toBe(browser);
  });
});

describe('the switch', () => {
  it('is off until asked, and leaves every name resolving as it always did', () => {
    expect(engineSwitch).toMatchObject({ mode: 'browser', phase: 'off', lastResort: null });
    expect(fontNameFor('No Such Font')).toBe('Comic Neue');
    expect(fontCssFor('No Such Font')).toBe("'Comic Neue', cursive");
    expect(measuredFontFor('No Such Font')).toBe('No Such Font');
    expect(faceFor(styleFor('No Such Font'), 20).name).toBe('No Such Font');
    expect(fontMissing('No Such Font')).toBe(true);
    expect(fontMissing('Bangers')).toBe(false);
  });

  it('on: loads the engine, hands it the fonts, installs it and lays everything out again', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    const version = app.fontsVersion;
    await useTextEngine('rust');
    expect(engineSwitch).toMatchObject({ mode: 'rust', phase: 'on', error: '', lastResort: 'WildWords' });
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(textEngine()).toBe(engine);
    expect(engine.registered()).toEqual({ WildWords: ['regular'] });
    expect(engine.fallbacks()).toEqual(['WildWords']);
    expect(app.fontsVersion).toBe(version + 1);
  });

  it('off: puts the browser back, empties the engine and lays everything out again', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    await useTextEngine('rust');
    const version = app.fontsVersion;
    await useTextEngine('browser');
    expect(engineSwitch).toMatchObject({ mode: 'browser', phase: 'off', lastResort: null });
    expect(textEngine()).toBe(browser);
    expect(engine.registered()).toEqual({});
    expect(app.fontsVersion).toBe(version + 1);
    expect(fontNameFor('No Such Font')).toBe('Comic Neue');
    expect(measuredFontFor('No Such Font')).toBe('No Such Font');
    // Nobody is told about a face any more.
    await addFontFile(fontFile('AnimeAce.ttf'));
    expect(engine.registered()).toEqual({});
  });

  it('loads the wasm once however often it is flipped', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    await useTextEngine('rust');
    await useTextEngine('browser');
    await useTextEngine('rust');
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(textEngine()).toBe(engine);
    expect(engine.registered()).toEqual({ WildWords: ['regular'] });
  });

  it('says so when the engine cannot start, keeps the browser, and tries again when asked again', async () => {
    createEngine.mockRejectedValueOnce(new Error('wasm ABI 1, loader expects 2'));
    await useTextEngine('rust');
    expect(engineSwitch).toMatchObject({ mode: 'rust', phase: 'failed', error: 'wasm ABI 1, loader expects 2' });
    expect(app.toast.msg).toContain('could not start');
    expect(textEngine()).toBe(browser);
    expect(fontNameFor('No Such Font')).toBe('Comic Neue');
    await addFontFile(fontFile('WildWords.ttf'));
    await useTextEngine('browser');
    await useTextEngine('rust');
    expect(createEngine).toHaveBeenCalledTimes(2);
    expect(engineSwitch.phase).toBe('on');
  });

  it('is turned off while starting without anything of the engine left behind', async () => {
    let boot;
    deps({ booted: () => new Promise((resolve) => (boot = resolve)) });
    await addFontFile(fontFile('WildWords.ttf'));
    const starting = useTextEngine('rust');
    await vi.waitFor(() => expect(boot).toBeTypeOf('function'));
    expect(engineSwitch.phase).toBe('starting');
    await useTextEngine('browser');
    boot();
    await starting;
    expect(engineSwitch).toMatchObject({ mode: 'browser', phase: 'off' });
    expect(textEngine()).toBe(browser);
    expect(engine.registered()).toEqual({});
    expect(_engineSwitchSync()).toBe(null);
  });

  it('with no font to measure in installs no engine at all, until there is one', async () => {
    await useTextEngine('rust');
    expect(engineSwitch).toMatchObject({ phase: 'on', lastResort: null });
    // The stand-ins, exactly as where no engine exists.
    expect(textEngine()).toBe(null);
    expect(lineWidth('WAVE', styleFor('Bangers'), 20)).toBe(4 * 20 * 0.55);
    await addFontFile(fontFile('WildWords.ttf'));
    expect(engineSwitch.lastResort).toBe('WildWords');
    expect(textEngine()).toBe(engine);
    expect(lineWidth('WAVE', styleFor('Bangers'), 20)).toBe(4 * 20 * widthOf('WildWords'));
    await removeUserFont('WildWords');
    expect(textEngine()).toBe(null);
  });
});

describe('starting', () => {
  it('writes nothing into the document until the engine is in, then fits once', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    loadProjectPages(doc([box('WildWords')]));
    const b = page().boxes[0];
    // Opened under the browser: grown to the browser's two lines.
    const browserNeed = need(b);
    expect(b.h).toBe(browserNeed);

    let boot;
    deps({ booted: () => new Promise((resolve) => (boot = resolve)) });
    const starting = useTextEngine('rust');
    await vi.waitFor(() => expect(boot).toBeTypeOf('function'));
    expect(engineSwitch.phase).toBe('starting');
    // The browser is still what measures, and what is on screen.
    expect(textEngine()).toBe(browser);

    // An edit that needs more room, made in the gap.
    b.text = 'AAAA BBBB CCCC DDDD';
    expect(need(b)).toBeGreaterThan(browserNeed);
    expect(autoFitBox(b, page())).toBe(false);
    expect(refitBox(b, page())).toBe(false);
    expect(fitBoxNow(b.id, page())).toBe(false);
    expect(b.h).toBe(browserNeed);
    expect(b.review ?? null).toBe(null);

    boot();
    await starting;
    expect(textEngine()).toBe(engine);
    // Fitted by the engine that is now in, to its own lines.
    expect(b.h).toBe(need(b));
    expect(b.h).not.toBe(browserNeed);
  });

  it('places a box as pending while it starts, and solves it when the engine is in', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, text: 'HELLO THERE', tr: 'HELLO THERE', tags: [] }], boxes: [], activeLineN: 1 }]);
    app.lastStyle.font = 'WildWords';
    let boot;
    deps({ booted: () => new Promise((resolve) => (boot = resolve)) });
    const starting = useTextEngine('rust');
    await vi.waitFor(() => expect(boot).toBeTypeOf('function'));
    placeActiveAt(400, 600);
    const b = page().boxes[0];
    expect(b.auto.status).toBe('pending');
    boot();
    await starting;
    expect(b.auto.status).not.toBe('pending');
  });

  it('hears of a face added while it starts, and of one removed', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    await addFontFile(fontFile('Leaving.ttf'));
    let boot;
    deps({ booted: () => new Promise((resolve) => (boot = resolve)) });
    const starting = useTextEngine('rust');
    await vi.waitFor(() => expect(boot).toBeTypeOf('function'));
    await addFontFile(fontFile('AnimeAce-Bold.ttf'));
    await removeUserFont('Leaving');
    boot();
    await starting;
    expect(engine.registered()).toEqual({ WildWords: ['regular'], AnimeAce: ['bold'] });
  });

  it('hands the engine each face once, the one that arrived while it starts included', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    const added = vi.spyOn(engine, 'addFace');
    let boot;
    deps({ booted: () => new Promise((resolve) => (boot = resolve)) });
    const starting = useTextEngine('rust');
    await vi.waitFor(() => expect(boot).toBeTypeOf('function'));
    // Told by the watcher now, and in the library read that follows the boot.
    await addFontFile(fontFile('AnimeAce-Bold.ttf'));
    boot();
    await starting;
    expect(added.mock.calls.map(([family, slot]) => `${family}/${slot}`).sort()).toEqual(['AnimeAce/bold', 'WildWords/regular']);
  });
});

describe('the user’s faces, through every way one arrives or leaves', () => {
  beforeEach(async () => {
    await addFontFile(fontFile('Anchor.ttf'));
    await useTextEngine('rust');
  });

  it('restore at boot', async () => {
    const version = app.fontsVersion;
    await _restoreFontRecords([
      { name: 'Manga Temple', slot: 'regular', file: 'MangaTemple.ttf', data: SFNT().buffer },
      { name: 'Manga Temple', slot: 'boldItalic', file: 'MangaTemple-BI.otf', data: SFNT().buffer },
      // A record a built-in has since taken the name of is not restored, so not registered.
      { name: 'Bangers', slot: 'regular', file: 'Bangers.ttf', data: SFNT().buffer },
    ]);
    expect(engine.registered()).toEqual({ Anchor: ['regular'], 'Manga Temple': ['regular', 'boldItalic'] });
    expect(app.fontsVersion).toBe(version + 1);
    expect(fontNameFor('Manga Temple')).toBe('Manga Temple');
  });

  it('a file added, into the slot its name says or the one the user picked', async () => {
    await addFontFile(fontFile('WildWords-Italic.ttf'));
    await addFontFile(fontFile('whatever.otf'), { family: 'WildWords', slot: 'bold' });
    expect(engine.registered()).toEqual({ Anchor: ['regular'], WildWords: ['bold', 'italic'] });
  });

  it('a face replaced by another file', async () => {
    const first = SFNT();
    const second = SFNT();
    await addFontFile(fontFile('WildWords.ttf', first));
    expect(new Uint8Array(engine.families.get('WildWords').regular.file.buffer)).toEqual(first);
    const version = app.fontsVersion;
    await addFontFile(fontFile('WildWords-v2.ttf', second), { family: 'WildWords', slot: 'regular' });
    expect(engine.families.get('WildWords').regular.file.buffer).toBe(second.buffer);
    expect(app.fontsVersion).toBe(version + 1);
  });

  it('a face installed from a chapter package, and one it would not replace', async () => {
    expect(await installFontFace({ family: 'Packed', slot: 'regular', file: 'Packed.ttf', data: SFNT() })).toBe('installed');
    const kept = engine.families.get('Packed').regular.file;
    expect(await installFontFace({ family: 'Packed', slot: 'regular', file: 'Other.ttf', data: SFNT() })).toBe('present');
    expect(engine.families.get('Packed').regular.file).toBe(kept);
    expect(await installFontFace({ family: 'Bangers', slot: 'regular', file: 'Bangers.ttf', data: SFNT() })).toBe('builtin');
    expect(engine.registered()).toEqual({ Anchor: ['regular'], Packed: ['regular'] });
  });

  it('one face removed, then the last one, which takes the family', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    await addFontFile(fontFile('WildWords-Bold.ttf'));
    await removeFontFace('WildWords', 'regular');
    expect(engine.registered()).toEqual({ Anchor: ['regular'], WildWords: ['bold'] });
    await removeFontFace('WildWords', 'bold');
    expect(engine.registered()).toEqual({ Anchor: ['regular'] });
    expect(fontMissing('WildWords')).toBe(true);
  });

  it('a whole family removed', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    await addFontFile(fontFile('WildWords-Bold.ttf'));
    await removeUserFont('WildWords');
    expect(engine.registered()).toEqual({ Anchor: ['regular'] });
  });

  it('a file the browser refused reaches nobody', async () => {
    vi.stubGlobal('FontFace', class {
      async load() {
        throw new Error('bad font');
      }
    });
    expect(await addFontFile(fontFile('Broken.ttf'))).toBe(null);
    expect(engine.registered()).toEqual({ Anchor: ['regular'] });
  });

  it('a collection the user dropped: its first face', async () => {
    await addFontFile(fontFile('Gothic.ttc', TTC()));
    expect(engine.families.get('Gothic').regular.index).toBe(0);
  });
});

describe('a compressed face', () => {
  it('in a plain browser is a missing font, not a face measured as something else', async () => {
    await addFontFile(fontFile('Anchor.ttf'));
    await addFontFile(fontFile('Webby.woff2', WOFF2()));
    await useTextEngine('rust');
    expect(engine.registered()).toEqual({ Anchor: ['regular'] });
    expect(fontMissing('Webby')).toBe(true);
    expect(fontNameFor('Webby')).toBe('Anchor');
    expect(_engineSwitchSync().whyMissing('Webby')).toBe('compressed');
  });

  it('in the desktop app is decoded natively, the bytes going as the raw body of the call', async () => {
    const invoke = fakeNative({});
    deps({ invoke: async () => invoke });
    await addFontFile(fontFile('Anchor.ttf'));
    await addFontFile(fontFile('Webby.woff2', WOFF2()));
    await useTextEngine('rust');
    expect(invoke.calls).toEqual([['font_to_sfnt', 'bytes']]);
    expect(engine.registered()).toEqual({ Anchor: ['regular'], Webby: ['regular'] });
    expect(fontMissing('Webby')).toBe(false);
  });
});

describe('system faces', () => {
  const zapfino = () => ({
    'Helvetica Neue': [{ slots: { regular: 0, bold: 1, italic: 2, boldItalic: 3 }, bytes: TTC() }],
    Zapfino: [{ slots: { regular: 0 }, bytes: SFNT() }],
  });
  const installed = () => [
    systemFontEntry({ name: 'Helvetica Neue', faces: { regular: true, bold: true, italic: true, boldItalic: true } }),
    systemFontEntry({ name: 'Zapfino', faces: { regular: true } }),
  ];

  it('the last resort is sent for before the engine is installed, and no other family is', async () => {
    const invoke = fakeNative(zapfino());
    deps({ invoke: async () => invoke });
    app.fonts.system = installed();
    await useTextEngine('rust');
    expect(engineSwitch).toMatchObject({ phase: 'on', lastResort: 'Helvetica Neue' });
    expect(invoke.calls).toEqual([['system_font_face', { family: 'Helvetica Neue', slot: 'regular' }]]);
    expect(engine.registered()).toEqual({ 'Helvetica Neue': ['regular', 'bold', 'italic', 'boldItalic'] });
    expect(new Set(Object.values(engine.families.get('Helvetica Neue')).map((f) => f.file)).size).toBe(1);
  });

  it('a family is sent for when a box first uses it; the box waits, then is fitted in its own face', async () => {
    const invoke = fakeNative(zapfino());
    deps({ invoke: async () => invoke });
    app.fonts.system = installed();
    await useTextEngine('rust');
    invoke.calls.length = 0;

    // A chapter set in a system font opens: nothing of it is in the engine yet.
    loadProjectPages(doc([box('Zapfino')]));
    const b = page().boxes[0];
    expect(invoke.calls).toEqual([['system_font_face', { family: 'Zapfino', slot: 'regular' }]]);
    // Not measured into the document as the last resort: the height on file stands.
    expect(b.h).toBe(20);
    expect(fontNameFor('Zapfino')).toBe('Helvetica Neue');
    expect(fontMissing('Zapfino')).toBe(false);
    expect(autoFitBox(b, page())).toBe(false);

    const version = app.fontsVersion;
    await _engineSwitchSync().settled();
    expect(app.fontsVersion).toBe(version + 1);
    expect(engine.registered().Zapfino).toEqual(['regular']);
    expect(fontNameFor('Zapfino')).toBe('Zapfino');
    expect(fontCssFor('Zapfino')).toBe('"Zapfino", sans-serif');
    expect(b.h).toBe(need(b));
    expect(lineWidth('WAVE', b.style, 20)).toBe(4 * 20 * widthOf('Zapfino'));
    // Asked once, however many boxes and measurements followed.
    expect(invoke.calls).toHaveLength(1);
  });

  it('a box placed in a family that is on its way is pending, and solved when it lands', async () => {
    const invoke = fakeNative(zapfino(), { hold: true });
    deps({ invoke: async () => invoke });
    app.fonts.system = installed();
    const starting = useTextEngine('rust');
    await vi.waitFor(() => expect(invoke.calls).toHaveLength(1));
    invoke.release();
    await starting;

    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, text: 'HELLO THERE', tr: 'HELLO THERE', tags: [] }], boxes: [], activeLineN: 1 }]);
    app.lastStyle.font = 'Zapfino';
    placeActiveAt(400, 600);
    const b = page().boxes[0];
    expect(b.style.font).toBe('Zapfino');
    expect(b.auto.status).toBe('pending');
    invoke.release();
    await _engineSwitchSync().settled();
    expect(b.auto.status).not.toBe('pending');
    expect(engine.registered().Zapfino).toEqual(['regular']);
  });

  it('a scan that lands later is followed', async () => {
    const invoke = fakeNative(zapfino());
    deps({ invoke: async () => invoke });
    await addFontFile(fontFile('Anchor.ttf'));
    await useTextEngine('rust');
    expect(engineSwitch.lastResort).toBe('Anchor');
    // What scanSystemFonts does when the native answer arrives.
    app.fonts.system = installed();
    _engineSwitchSync().refresh();
    await _engineSwitchSync().settled();
    expect(engineSwitch.lastResort).toBe('Helvetica Neue');
    expect(fontNameFor('No Such Font')).toBe('Helvetica Neue');
  });
});

describe('a name the machine has no font for', () => {
  beforeEach(async () => {
    const invoke = fakeNative({ Helvetica: [{ slots: { regular: 0 }, bytes: SFNT() }] });
    deps({ invoke: async () => invoke });
    app.fonts.system = [systemFontEntry({ name: 'Helvetica', faces: { regular: true } })];
    await addFontFile(fontFile('WildWords.ttf'));
    await useTextEngine('rust');
  });

  it('is asked of the engine as the last resort, never as itself and never as the old fallback', () => {
    engine.asked.length = 0;
    for (const name of ['No Such Font', 'Bangers', 'Comic Neue']) {
      const s = styleFor(name);
      expect(faceFor(s, 20).name).toBe('Helvetica');
      expect(faceFor(s, 20).css).toBe('"Helvetica", sans-serif');
      expect(lineWidth('WAVE', s, 20)).toBe(4 * 20 * widthOf('Helvetica'));
    }
    expect(new Set(engine.asked)).toEqual(new Set(['Helvetica']));
  });

  it('is never answered from what another family measured', () => {
    // The hole: the memo is keyed by the CSS a name resolves to, and an
    // unknown name used to resolve to the fallback family's CSS whoever
    // measured. Fill every memo first, then ask the unknown name.
    const text = 'KEPT IN THE MEMO';
    const wild = lineWidth(text, styleFor('WildWords'), 20);
    const helvetica = lineWidth(text, styleFor('Helvetica'), 20);
    expect(wild).not.toBe(helvetica);
    engine.asked.length = 0;
    expect(lineWidth(text, styleFor('No Such Font'), 20)).toBe(helvetica);
    // Answered from the memo, and rightly: the key it was found under is the
    // last resort's own, the family the name is measured as.
    expect(engine.asked).toEqual([]);
    expect(faceFor(styleFor('No Such Font'), 20).key).toBe(faceFor(styleFor('Helvetica'), 20).key);
    expect(faceFor(styleFor('No Such Font'), 20).key).not.toBe(faceFor(styleFor('WildWords'), 20).key);
  });

  it('is measured as itself from the moment its font is loaded, with nothing kept from before', async () => {
    const s = styleFor('Late Font');
    expect(lineWidth('WAVE', s, 20)).toBe(4 * 20 * widthOf('Helvetica'));
    await addFontFile(fontFile('Late Font.ttf'));
    expect(faceFor(s, 20).name).toBe('Late Font');
    expect(lineWidth('WAVE', s, 20)).toBe(4 * 20 * widthOf('Late Font'));
    await removeUserFont('Late Font');
    expect(lineWidth('WAVE', s, 20)).toBe(4 * 20 * widthOf('Helvetica'));
  });

  it('keeps its name in the document', () => {
    loadProjectPages(doc([box('No Such Font')]));
    expect(page().boxes[0].style.font).toBe('No Such Font');
  });
});

describe('the chapter’s missing fonts', () => {
  const pages = () => [
    { id: 1, w: 800, h: 1200, lines: [], boxes: [box('Bangers', { id: 'a' }), box('Gone Font', { id: 'b' }), box('WildWords', { id: 'c' })] },
    { id: 2, w: 800, h: 1200, lines: [], boxes: [box('Gone Font', { id: 'd' }), box('Gone Font', { id: 'e' }), box('Other Gone', { id: 'f' })] },
  ];

  it('with the browser measuring: the names no list has, most boxes first', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    loadProjectPages(pages());
    expect(missingFonts()).toEqual([{ name: 'Gone Font', boxes: 3 }, { name: 'Other Gone', boxes: 1 }]);
  });

  it('with the Rust engine measuring: the built-ins too, which it has no bytes for', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    loadProjectPages(pages());
    await useTextEngine('rust');
    expect(missingFonts()).toEqual([{ name: 'Gone Font', boxes: 3 }, { name: 'Bangers', boxes: 1 }, { name: 'Other Gone', boxes: 1 }]);
  });

  it('clears a family when its font is loaded, and lists it again when the font goes', async () => {
    loadProjectPages(pages());
    await addFontFile(fontFile('Gone Font.ttf'));
    expect(missingFonts().map((m) => m.name)).toEqual(['Other Gone', 'WildWords']);
    await useTextEngine('rust');
    expect(missingFonts().map((m) => m.name)).toEqual(['Bangers', 'Other Gone', 'WildWords']);
    await addFontFile(fontFile('WildWords.ttf'));
    expect(missingFonts().map((m) => m.name)).toEqual(['Bangers', 'Other Gone']);
    await removeUserFont('Gone Font');
    expect(missingFonts()[0]).toEqual({ name: 'Gone Font', boxes: 3 });
  });

  it('is empty for a chapter whose fonts are all here', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    loadProjectPages(doc([box('WildWords'), box('Bangers', { id: 'b2' })]));
    expect(missingFonts()).toEqual([]);
  });
});

describe('letters no face has', () => {
  it('are not known while the browser measures', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    loadProjectPages(doc([box('WildWords', { text: 'こんにちは' })]));
    expect(lettersMissing(styleFor('WildWords'), 'こんにちは')).toEqual([]);
    expect(boxesMissingLetters()).toEqual([]);
  });

  it('are listed per box once the Rust engine measures', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    loadProjectPages(doc([box('WildWords', { id: 'latin' }), box('WildWords', { id: 'kana', text: 'OH こ!' }), box('No Such Font', { id: 'gone', text: 'ね' })]));
    await useTextEngine('rust');
    expect(boxesMissingLetters()).toEqual([
      { pageIndex: 0, boxId: 'kana', letters: [0x3053] },
      { pageIndex: 0, boxId: 'gone', letters: [0x306d] },
    ]);
  });
});
