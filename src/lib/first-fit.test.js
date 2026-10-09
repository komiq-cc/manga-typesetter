import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  app, loadProjectPages, page, autoFitBox, reviewOf, flaggedBoxes, useChapterTypesetting, setSaver, markSaved, markUnsaved, flushSave,
  firstFit, firstFitChanges, keepFirstFit, stampTypesetting,
} from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { engineSwitch, useTextEngine, _setEngineSwitchDeps, _resetEngineSwitch, _engineSwitchSync } from './engine-switch.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { addFontFile, removeUserFont, systemFontEntry, watchUserFaces } from './fonts.js';
import { layoutLines, applyCase, contentWidth, setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { LAYOUT_VERSION, LAYOUT_VERSION_RUST, REVIEW_REASONS, legacyTypesetting } from './data.js';
import { fakeRustEngine, fakeNative, widthOf, SFNT, TTC } from '../test/fake-rust-engine.js';
import { fakeIndexedDB } from '../test/fake-indexeddb.js';

// ===========================================================================
// A chapter lettered under the browser, met by the Rust engine for the first time
// ===========================================================================
// The real store and the real switch, on the stand-ins engine-switch.test.js
// uses: a "browser" that gives every letter 0.55 of the size, and an engine
// whose letters are as wide as the family's name says (`widthOf`). Two engines
// that disagree by a known amount, which is all this needs: a made-up chapter
// whose boxes the browser fitted, and what the other engine then does to them.
//
// The same on the real engine, the real library and a real file:
// first-fit.engine.test.js.

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
  };
}

const SIZE = 20;
const fontFile = (name) => ({ name, arrayBuffer: async () => SFNT().buffer });
const style = (font) => ({ font, size: SIZE, lineHeight: 1.1, valign: 'top', outlineWidth: 0 });
// A box whose text has `content` px to break in, whatever the style's inset is.
const INSET = 100 - contentWidth(100, style('AnimeAce'));
const box = (id, font, text, content, y) => ({ id, lineN: null, text, x: 100, y, w: content + INSET, h: 20, style: style(font) });
const linesOf = (b) => layoutLines(applyCase(b.text, b.style), b.style, b.style.size, contentWidth(b.w, b.style));

// AnimeAce is narrower than the browser's letters, Narrow is wider.
//   relaid   three lines under the browser, two under the engine: no taller
//   grow     one line under the browser, two under the engine
//   flag     one word that fits the browser's box and not the engine's
//   clear    one word the browser found too wide, and the engine does not
//   same     nothing to say
const made = () => [
  {
    id: 1, w: 800, h: 1200, lines: [],
    boxes: [box('same', 'AnimeAce', 'AA', 200, 100), box('relaid', 'AnimeAce', 'AAAA BBBB CCCC', 80, 200)],
  },
  {
    id: 2, w: 800, h: 1200, lines: [],
    boxes: [box('grow', 'Narrow', 'AA BB', 60, 100), box('flag', 'Narrow', 'AAAA', 50, 300), box('clear', 'AnimeAce', 'AAAA', 30, 500)],
  },
];

const original = { engine: textEngine(), typeset: typesetEnabled(), system: app.fonts.system };
const library = fakeIndexedDB();
let browser;
let engine;
let saves;
let unhook;
const all = () => app.pages.flatMap((p) => p.boxes);
const by = (id) => all().find((b) => b.id === id);
const copy = (v) => JSON.parse(JSON.stringify(v));
const rects = () => all().map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size, review: b.review ?? null }));

// The chapter as the browser left it on disk: fitted by it, and written.
function lettered(version = LAYOUT_VERSION) {
  open({ pages: made(), typesetting: { mode: 'smart', version } });
  const file = { pages: copy(app.pages), typesetting: { mode: 'smart', version } };
  close();
  return file;
}
// As library.svelte.js opens a chapter, and as it writes one.
function open(file) {
  useChapterTypesetting(file.typesetting ?? legacyTypesetting());
  loadProjectPages(copy(file.pages));
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  markSaved();
}
function close() {
  app.chapterRef = null;
  useChapterTypesetting(null);
  loadProjectPages([]);
}
const saver = async () => {
  saves.push({ typesetting: stampTypesetting(), pages: copy(app.pages) });
  markSaved();
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  browser = fakeBrowser();
  setTextEngine(browser);
  setTypesetEnabled(true);
  engine = fakeRustEngine();
  _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => null, booted: async () => {}, os: () => 'macos' });
  saves = [];
  unhook = setSaver(saver);
  await addFontFile(fontFile('AnimeAce.ttf'));
  await addFontFile(fontFile('Narrow.ttf'));
});

afterEach(async () => {
  unhook();
  close();
  _resetEngineSwitch();
  _setEngineSwitchDeps(null);
  watchUserFaces(null);
  for (const f of [...app.fonts.user]) await removeUserFont(f.name);
  library.rows.clear();
  app.fonts.system = original.system;
  setTextEngine(original.engine);
  setTypesetEnabled(original.typeset);
  clearLayoutMemo();
  vi.unstubAllGlobals();
});

describe('the made-up chapter', () => {
  it('is what it is said to be: the two engines break and fit it differently', async () => {
    expect(widthOf('AnimeAce')).toBeLessThan(BROWSER);
    expect(widthOf('Narrow')).toBeGreaterThan(BROWSER);
    const file = lettered();
    setTypesetEnabled(true);
    const of = (id) => file.pages.flatMap((p) => p.boxes).find((b) => b.id === id);
    expect(linesOf(of('relaid'))).toEqual(['AAAA', 'BBBB', 'CCCC']);
    expect(linesOf(of('grow'))).toEqual(['AA BB']);
    expect(of('flag').review ?? null).toBe(null);
    expect(of('clear').review).toMatchObject({ kind: 'overflow' });
    await useTextEngine('rust');
    expect(linesOf(of('relaid'))).toHaveLength(2);
    expect(linesOf(of('grow'))).toEqual(['AA', 'BB']);
  });
});

describe('opened with the Rust engine on', () => {
  let file;
  beforeEach(async () => {
    file = lettered();
    await useTextEngine('rust');
    expect(engineSwitch.phase).toBe('on');
    open(file);
  });

  it('heights grow, flags are raised and cleared, and no box changes its width, size or place across', () => {
    const before = file.pages.flatMap((p) => p.boxes);
    for (const was of before) {
      const b = by(was.id);
      expect({ x: b.x, w: b.w, size: b.style.size }).toEqual({ x: was.x, w: was.w, size: was.style.size });
      expect(b.h).toBeGreaterThanOrEqual(was.h);
    }
    expect(by('grow').h).toBeGreaterThan(before.find((b) => b.id === 'grow').h);
    expect(by('relaid').h).toBe(before.find((b) => b.id === 'relaid').h);
    expect(by('flag').review).toMatchObject({ kind: 'overflow' });
    expect(by('clear').review ?? null).toBe(null);
  });

  it('says what changed, counted against the file, and which box to look at first', () => {
    expect(firstFit).toMatchObject({ open: true, kept: false, dismissed: false });
    expect(firstFitChanges()).toEqual({ grew: 1, flagged: 1, cleared: 1, relaid: 2, first: { pageId: 1, boxId: 'relaid' }, kept: false });
  });

  it('lists a box whose lines moved in the review list, beside the flagged ones, without flagging it', () => {
    const listed = flaggedBoxes();
    expect(listed.map((f) => f.boxId)).toEqual(['relaid', 'grow', 'flag']);
    expect(listed[0].review).toMatchObject({ kind: 'overflow', overflow: { l: 0, t: 0, r: 0, b: 0 }, reason: REVIEW_REASONS.relaid });
    // Listed, not flagged: the badge, the export and the PSD ask `reviewOf`.
    expect(reviewOf(by('relaid'), app.pages[0]) ?? null).toBe(null);
    expect(by('relaid').review ?? null).toBe(null);
    expect(by('grow').review ?? null).toBe(null);
    expect(JSON.stringify(app.pages)).not.toContain(REVIEW_REASONS.relaid);
    // A real flag is said as itself, not as lines that moved.
    expect(listed[2].review.reason).not.toBe(REVIEW_REASONS.relaid);
  });

  it('stops listing a box once the user edits it', () => {
    app.pageIndex = 0;
    by('relaid').text = 'AAAA BBBB CCCC DDDD';
    autoFitBox(by('relaid'), page());
    expect(flaggedBoxes().map((f) => f.boxId)).toEqual(['grow', 'flag']);
    expect(firstFitChanges().relaid).toBe(1);
  });

  it('is not marked unsaved, and nothing is written: not after the debounce, not on leaving', async () => {
    expect(app.saved).toBe(true);
    await wait(900);
    expect(saves).toHaveLength(0);
    await flushSave();
    expect(saves).toHaveLength(0);
    expect(app.typesetting.version).toBe(LAYOUT_VERSION);
  });

  it('the save an edit causes carries what the engine changed, and stamps the file 2', async () => {
    by('same').text = 'AB';
    markUnsaved();
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].typesetting).toEqual({ mode: 'smart', version: LAYOUT_VERSION_RUST });
    const written = saves[0].pages.flatMap((p) => p.boxes);
    expect(written.find((b) => b.id === 'grow').h).toBe(by('grow').h);
    expect(written.find((b) => b.id === 'flag').review).toMatchObject({ kind: 'overflow' });
    // The notice stands until answered, and now says the changes are on disk.
    expect(firstFitChanges()).toMatchObject({ grew: 1, kept: true });
    // From here leaving writes as it always has.
    await flushSave();
    expect(saves).toHaveLength(2);
  });

  it('Keep writes once, stamps the file 2, and the notice and its list entries go', async () => {
    await keepFirstFit();
    expect(saves).toHaveLength(1);
    expect(saves[0].typesetting.version).toBe(LAYOUT_VERSION_RUST);
    expect(app.typesetting.version).toBe(LAYOUT_VERSION_RUST);
    expect(firstFitChanges()).toBe(null);
    expect(flaggedBoxes().map((f) => f.boxId)).toEqual(['flag']);
    // Answered twice is answered once.
    await keepFirstFit();
    expect(saves).toHaveLength(1);
  });

  it('answered after an edit already saved it, the notice goes and nothing more is written', async () => {
    markUnsaved();
    await flushSave();
    await keepFirstFit();
    expect(saves).toHaveLength(1);
    expect(firstFitChanges()).toBe(null);
  });

  it('once at version 2 it opens with nothing noted and nothing to say', async () => {
    await keepFirstFit();
    const kept = { pages: saves[0].pages, typesetting: saves[0].typesetting };
    close();
    open(kept);
    expect(firstFit.open).toBe(false);
    expect(firstFitChanges()).toBe(null);
    expect(flaggedBoxes().map((f) => f.boxId)).toEqual(['flag']);
    // And is written on leaving as any chapter is.
    await flushSave();
    expect(saves).toHaveLength(2);
    expect(saves[1].typesetting.version).toBe(LAYOUT_VERSION_RUST);
  });

  it('the switch turned off again puts every box back as the file has it', async () => {
    await useTextEngine('browser');
    expect(firstFit.open).toBe(false);
    expect(rects()).toEqual(file.pages.flatMap((p) => p.boxes).map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size, review: b.review ?? null })));
    expect(app.saved).toBe(true);
    expect(saves).toHaveLength(0);
  });

  it('but not a chapter the user has edited: that one is theirs, as it stands', async () => {
    const grown = by('grow').h;
    markUnsaved();
    await useTextEngine('browser');
    expect(by('grow').h).toBe(grown);
  });
});

describe('the switch turned on over an open chapter', () => {
  it('notes the boxes as the browser left them, counts the same, and schedules no write', async () => {
    const file = lettered();
    open(file);
    expect(firstFit.open).toBe(false);
    await useTextEngine('rust');
    expect(firstFitChanges()).toEqual({ grew: 1, flagged: 1, cleared: 1, relaid: 2, first: { pageId: 1, boxId: 'relaid' }, kept: false });
    expect(app.saved).toBe(true);
    await wait(900);
    expect(saves).toHaveLength(0);
    // Off again: the chapter the browser had.
    await useTextEngine('browser');
    expect(copy(app.pages)).toEqual(file.pages);
    expect(app.saved).toBe(true);
  });
});

describe('a font whose bytes arrive after the chapter opened', () => {
  it('grows its box and is counted, and still schedules no write', async () => {
    const invoke = fakeNative({
      'Helvetica Neue': [{ slots: { regular: 0, bold: 1, italic: 2, boldItalic: 3 }, bytes: TTC() }],
      Zapfino: [{ slots: { regular: 0 }, bytes: SFNT() }],
    });
    _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => invoke, booted: async () => {}, os: () => 'macos' });
    app.fonts.system = [
      systemFontEntry({ name: 'Helvetica Neue', faces: { regular: true, bold: true, italic: true, boldItalic: true } }),
      systemFontEntry({ name: 'Zapfino', faces: { regular: true } }),
    ];
    await useTextEngine('rust');
    open({ pages: [{ id: 1, w: 800, h: 1200, lines: [], boxes: [{ ...box('late', 'Zapfino', 'AAAA BBBB', 60, 100) }] }], typesetting: { mode: 'smart', version: LAYOUT_VERSION } });
    expect(by('late').h).toBe(20);
    await _engineSwitchSync().settled();
    expect(by('late').h).toBeGreaterThan(20);
    expect(firstFitChanges()).toMatchObject({ grew: 1 });
    expect(app.saved).toBe(true);
    await wait(900);
    expect(saves).toHaveLength(0);
  });
});

describe('with the browser measuring, none of this is', () => {
  it('nothing is noted, nothing is said, and leaving writes as it always has', async () => {
    const file = lettered();
    open(file);
    expect(firstFit).toMatchObject({ open: false, kept: false, dismissed: false });
    expect(firstFitChanges()).toBe(null);
    expect(flaggedBoxes().map((f) => f.boxId)).toEqual(['clear']);
    await keepFirstFit();
    expect(saves).toHaveLength(0);
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].typesetting).toEqual({ mode: 'smart', version: LAYOUT_VERSION });
    expect(saves[0].pages).toEqual(file.pages);
  });

  it('a version 2 chapter saved under the browser is a version 1 chapter again; any other number is left alone', async () => {
    open(lettered(LAYOUT_VERSION_RUST));
    expect(app.typesetting.version).toBe(LAYOUT_VERSION_RUST);
    await flushSave();
    expect(saves[0].typesetting.version).toBe(LAYOUT_VERSION);
    close();
    open(lettered(7));
    await flushSave();
    expect(saves[1].typesetting.version).toBe(7);
  });

  it('and that chapter is then told again when the Rust engine next meets it', async () => {
    open(lettered(LAYOUT_VERSION_RUST));
    await flushSave();
    const back = { pages: saves[0].pages, typesetting: saves[0].typesetting };
    close();
    await useTextEngine('rust');
    open(back);
    expect(firstFitChanges()).toMatchObject({ grew: 1, flagged: 1, cleared: 1, relaid: 2 });
  });
});
