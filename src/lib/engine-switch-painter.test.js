import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { app, loadProjectPages } from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { engineSwitch, useTextEngine, _setEngineSwitchDeps, _resetEngineSwitch } from './engine-switch.svelte.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { addFontFile, removeUserFont, watchUserFaces } from './fonts.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { fakeRustEngine, SFNT } from '../test/fake-rust-engine.js';

// ===========================================================================
// Who draws glyphs, as the textEngine switch decides it
// ===========================================================================
// The Rust painter goes in with the Rust engine and comes out with it, and
// `engineSwitch.painting` says which of the two is drawing. The editor shows a
// box as the engine's picture exactly while that flag is true, so the flag is
// checked against the painter at every step here: on, off, starting, failed,
// and the session that has no font to measure in at all. The engine is the
// stand-in of engine-switch.test.js; the painter is the real factory unless a
// case counts how often it is made.

const fontFile = (name, bytes = SFNT()) => ({ name, arrayBuffer: async () => bytes.buffer });
const original = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled(), system: app.fonts.system };
const browser = { id: 'browser', advance: () => 0, fontBox: () => ({ ascent: 0, descent: 0 }), lineInk: () => ({}), glyphInk: () => ({}), loading: () => false, onFontsChange: () => () => {}, faceReady: () => true };
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

// The flag and the painter, said together: they are one fact.
function drawing() {
  return { flag: engineSwitch.painting, painter: glyphPainter().id ?? 'browser', measuring: textEngine()?.id ?? null };
}

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
  initHistory();
  resetHistory();
  app.chapterRef = null;
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
  setGlyphPainter(original.painter);
  setTypesetEnabled(original.typeset);
  clearLayoutMemo();
  vi.unstubAllGlobals();
});

describe('the glyph painter follows the switch', () => {
  it('is the browser painter until the switch is on', () => {
    expect(glyphPainter()).toBe(original.painter);
    expect(drawing()).toEqual({ flag: false, painter: 'browser', measuring: 'browser' });
  });

  it('on: the Rust painter is installed with the engine, made from that engine', async () => {
    const createPainter = vi.fn((e) => ({ id: 'rust', engine: e, paint() {} }));
    deps({ createPainter });
    await addFontFile(fontFile('WildWords.ttf'));
    await useTextEngine('rust');
    expect(drawing()).toEqual({ flag: true, painter: 'rust', measuring: 'rust' });
    expect(createPainter).toHaveBeenCalledTimes(1);
    expect(glyphPainter().engine).toBe(engine);
  });

  it('on, with the real factory: what is installed is the painter rust-painter.js makes', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    await useTextEngine('rust');
    expect(glyphPainter()).not.toBe(original.painter);
    expect(glyphPainter().id).toBe('rust');
    expect(typeof glyphPainter().paint).toBe('function');
    expect(engineSwitch.painting).toBe(true);
  });

  it('off: the painter that was drawing before is back, the same object', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    await useTextEngine('rust');
    await useTextEngine('browser');
    expect(glyphPainter()).toBe(original.painter);
    expect(drawing()).toEqual({ flag: false, painter: 'browser', measuring: 'browser' });
  });

  it('is made anew each time the switch goes on, and not kept while it is off', async () => {
    const made = [];
    deps({ createPainter: (e) => (made.push({ id: 'rust', engine: e, paint() {} }), made.at(-1)) });
    await addFontFile(fontFile('WildWords.ttf'));
    await useTextEngine('rust');
    expect(glyphPainter()).toBe(made[0]);
    await useTextEngine('browser');
    expect(glyphPainter()).toBe(original.painter);
    await useTextEngine('rust');
    expect(made).toHaveLength(2);
    expect(glyphPainter()).toBe(made[1]);
    // One engine all along: the wasm is loaded once, the painter is not.
    expect(createEngine).toHaveBeenCalledTimes(1);
  });

  it('is not installed a second time by the fonts that arrive while it is on', async () => {
    const createPainter = vi.fn((e) => ({ id: 'rust', engine: e, paint() {} }));
    deps({ createPainter });
    await addFontFile(fontFile('WildWords.ttf'));
    await useTextEngine('rust');
    const first = glyphPainter();
    await addFontFile(fontFile('AnimeAce.ttf'));
    await addFontFile(fontFile('Zed.ttf'));
    expect(createPainter).toHaveBeenCalledTimes(1);
    expect(glyphPainter()).toBe(first);
    expect(engineSwitch.painting).toBe(true);
  });

  it('stays the browser painter while the engine is starting', async () => {
    let boot;
    deps({ booted: () => new Promise((resolve) => (boot = resolve)) });
    await addFontFile(fontFile('WildWords.ttf'));
    const starting = useTextEngine('rust');
    await vi.waitFor(() => expect(boot).toBeTypeOf('function'));
    expect(engineSwitch.phase).toBe('starting');
    expect(glyphPainter()).toBe(original.painter);
    expect(engineSwitch.painting).toBe(false);
    boot();
    await starting;
    expect(drawing()).toEqual({ flag: true, painter: 'rust', measuring: 'rust' });
  });

  it('stays the browser painter when the switch is turned off while starting', async () => {
    let boot;
    const createPainter = vi.fn((e) => ({ id: 'rust', engine: e, paint() {} }));
    deps({ createPainter, booted: () => new Promise((resolve) => (boot = resolve)) });
    await addFontFile(fontFile('WildWords.ttf'));
    const starting = useTextEngine('rust');
    await vi.waitFor(() => expect(boot).toBeTypeOf('function'));
    await useTextEngine('browser');
    boot();
    await starting;
    expect(createPainter).not.toHaveBeenCalled();
    expect(glyphPainter()).toBe(original.painter);
    expect(engineSwitch.painting).toBe(false);
  });

  it('stays the browser painter when the engine cannot start', async () => {
    createEngine.mockRejectedValueOnce(new Error('no wasm today'));
    await useTextEngine('rust');
    expect(engineSwitch.phase).toBe('failed');
    expect(glyphPainter()).toBe(original.painter);
    expect(engineSwitch.painting).toBe(false);
  });

  it('with no font to measure in: no engine, so no painter, until there is a font', async () => {
    await useTextEngine('rust');
    expect(engineSwitch).toMatchObject({ phase: 'on', lastResort: null });
    expect(textEngine()).toBe(null);
    expect(glyphPainter()).toBe(original.painter);
    expect(engineSwitch.painting).toBe(false);
    // The first font is the last resort, and the engine and its painter go in together.
    await addFontFile(fontFile('WildWords.ttf'));
    expect(drawing()).toEqual({ flag: true, painter: 'rust', measuring: 'rust' });
    // And out together when it leaves again.
    await removeUserFont('WildWords');
    expect(textEngine()).toBe(null);
    expect(glyphPainter()).toBe(original.painter);
    expect(engineSwitch.painting).toBe(false);
  });

  it('does not take out a painter somebody else installed meanwhile', async () => {
    await addFontFile(fontFile('WildWords.ttf'));
    await useTextEngine('rust');
    const theirs = { id: 'theirs', paint() {} };
    setGlyphPainter(theirs);
    await useTextEngine('browser');
    expect(glyphPainter()).toBe(theirs);
    expect(engineSwitch.painting).toBe(false);
  });
});
