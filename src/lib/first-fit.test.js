import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  app, loadProjectPages, page, autoFitBox, reviewOf, flaggedBoxes, useChapterTypesetting, setSaver, markSaved, markUnsaved, flushSave,
  firstFit, firstFitChanges, keepFirstFit, KEEP_WAIT_MS, stampTypesetting, fitBoxNow, placeActiveAt, relayoutAll,
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
    expect(firstFitChanges()).toEqual({ grew: 1, flagged: 1, cleared: 1, relaid: 2, laid: 0, first: { pageId: 1, boxId: 'relaid' }, kept: false, keeping: false });
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

describe('a version 1 chapter with no boxes, opened with the Rust engine on', () => {
  it('is not written by leaving either, has nothing to say, and is stamped 2 by the first edit', async () => {
    await useTextEngine('rust');
    open({ pages: [{ id: 1, w: 800, h: 1200, lines: [], boxes: [] }], typesetting: { mode: 'smart', version: LAYOUT_VERSION } });
    expect(firstFitChanges()).toEqual({ grew: 0, flagged: 0, cleared: 0, relaid: 0, laid: 0, first: null, kept: false, keeping: false });
    await flushSave();
    expect(saves).toHaveLength(0);
    // A box the user adds is theirs: it is not counted, and its save is the stamp.
    app.pages[0].boxes.push(box('new', 'Narrow', 'AA BB', 60, 100));
    markUnsaved();
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].typesetting.version).toBe(LAYOUT_VERSION_RUST);
    expect(firstFitChanges()).toMatchObject({ grew: 0, flagged: 0, cleared: 0, relaid: 0 });
  });
});

describe('the switch turned on over an open chapter', () => {
  it('notes the boxes as the browser left them, counts the same, and schedules no write', async () => {
    const file = lettered();
    open(file);
    expect(firstFit.open).toBe(false);
    await useTextEngine('rust');
    expect(firstFitChanges()).toEqual({ grew: 1, flagged: 1, cleared: 1, relaid: 2, laid: 0, first: { pageId: 1, boxId: 'relaid' }, kept: false, keeping: false });
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

// ===========================================================================
// The second round: what an outside review found (text-engine/P9-REPORT.md)
// ===========================================================================

describe('a change to the document that nobody marked', () => {
  let file;
  beforeEach(async () => {
    file = lettered();
    await useTextEngine('rust');
    open(file);
  });

  // TextBox writes the box as the pointer moves and marks the chapter unsaved
  // when the handle is let go. In between the document has changed and the
  // chapter still reads "saved".
  it('a handle held down: leaving writes the box as the hand has it', async () => {
    const b = by('same');
    b.x -= 20;
    b.w += 40;
    expect(app.saved).toBe(true);
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].pages[0].boxes[0]).toMatchObject({ id: 'same', x: b.x, w: b.w });
  });

  it('a rotation in progress is written the same way', async () => {
    by('same').style.rotation = 12;
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].pages[0].boxes[0].style.rotation).toBe(12);
  });

  it('and the switch going off in that moment puts nothing back: no height of the file over a width of the hand', async () => {
    const b = by('grow');
    const grown = b.h;
    b.w += 4;
    await useTextEngine('browser');
    expect(b.h).toBe(grown);
    expect(b.w).toBe(file.pages[1].boxes[0].w + 4);
  });

  it('a box the user added, or took away, is written by leaving', async () => {
    app.pages[0].boxes.push(box('new', 'AnimeAce', 'AA', 200, 400));
    await flushSave();
    expect(saves).toHaveLength(1);
    app.pages[0].boxes.pop();
    markSaved();
    // Back to what was noted, but a save has carried it: leaving writes.
    await flushSave();
    expect(saves).toHaveLength(2);
  });

  it('a page taken away without a mark is written by leaving, though every page left is as it was noted', async () => {
    app.pages.pop();
    expect(app.saved).toBe(true);
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].pages).toHaveLength(1);
  });

  // A fit of the engine's that comes by while the hand still has the box - a
  // font landing - does not make the hand's height the engine's.
  it('a handle held down while a font lands: the box is still the hand\'s, written by leaving and not counted', async () => {
    const before = firstFitChanges();
    const b = by('same');
    b.h += 50;
    relayoutAll();
    expect(app.saved).toBe(false);
    expect(firstFitChanges()).toMatchObject({ grew: before.grew, flagged: before.flagged });
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].pages[0].boxes[0].h).toBe(b.h);
  });

  it('a line of the queue changed without a mark is written by leaving', async () => {
    close();
    const pages = made();
    pages[0].lines = [{ n: 1, text: 'AA', tr: 'AA', tags: [] }];
    open({ pages, typesetting: { mode: 'smart', version: LAYOUT_VERSION } });
    await flushSave();
    expect(saves).toHaveLength(0);
    app.pages[0].lines[0].tr = 'AB';
    await flushSave();
    expect(saves).toHaveLength(1);
  });

  it.each([
    ['a style field besides rotation', (b) => { b.style.color = '#ff0000'; }, (b) => b.style.color, '#ff0000'],
    ['the fitted balloon shape', (b) => { b.fit = { kind: 'rect', x: 1, y: 2, w: 100, h: 80 }; }, (b) => b.fit, { kind: 'rect', x: 1, y: 2, w: 100, h: 80 }],
  ])('%s changed without a mark is written and never restored over', async (_, change, value, expected) => {
    const b = by('same');
    change(b);
    expect(app.saved).toBe(true);
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(value(saves[0].pages[0].boxes[0])).toEqual(expected);
    await useTextEngine('browser');
    expect(value(b)).toEqual(expected);
  });

  it.each(['file', 'cleanedFile'])('a durable %s changed without a mark reaches disk', async (field) => {
    app.pages[0][field] = 'replacement.png';
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].pages[0][field]).toBe('replacement.png');
  });

  it('the same page objects in a new order reach disk on the Rust flush without a dirty mark', async () => {
    const order = app.pages.map((p) => p.id).reverse();
    app.pages.reverse();
    expect(app.saved).toBe(true);
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].pages.map((p) => p.id)).toEqual(order);
  });

  it('the same page objects in a new order are written and not restored over', async () => {
    const order = app.pages.map((p) => p.id).reverse();
    app.pages.reverse();
    expect(app.saved).toBe(true);
    await useTextEngine('browser');
    expect(app.pages.map((p) => p.id)).toEqual(order);
    expect(app.saved).toBe(false);
    await flushSave();
    expect(saves[0].pages.map((p) => p.id)).toEqual(order);
  });

  it('undone by hand, there is nothing to write again, and the switch going off puts the boxes back', async () => {
    const b = by('same');
    b.w += 40;
    b.w -= 40;
    await flushSave();
    expect(saves).toHaveLength(0);
    await useTextEngine('browser');
    expect(rects()).toEqual(file.pages.flatMap((p) => p.boxes).map((x) => ({ id: x.id, x: x.x, y: x.y, w: x.w, h: x.h, size: x.style.size, review: x.review ?? null })));
  });
});

// "Fit now" on a box it cannot improve writes why, and returns before it
// marks the chapter unsaved, since no geometry moved: under the browser
// leaving writes it, as leaving writes everything there.
describe('"Fit now" on a box it cannot improve', () => {
  const curved = () => ({ ...box('curve', 'Narrow', 'AAAAAAAAAAAA BBBBBBBBBBBB', 40, 100), style: { ...style('Narrow'), size: 12, curve: 40 } });
  let file;
  beforeEach(async () => {
    open({ pages: [{ id: 1, w: 800, h: 1200, lines: [], boxes: [curved()] }], typesetting: { mode: 'smart', version: LAYOUT_VERSION } });
    file = { pages: copy(app.pages), typesetting: { mode: 'smart', version: LAYOUT_VERSION } };
    close();
    expect(file.pages[0].boxes[0].review.reason).toBe(REVIEW_REASONS.curve);
    await useTextEngine('rust');
    open(file);
  });

  it('changes the reason and marks nothing', () => {
    expect(fitBoxNow('curve', app.pages[0])).toBe(false);
    expect(by('curve').review.reason).toBe(REVIEW_REASONS.minSize);
    expect(app.saved).toBe(true);
  });

  it('is written by leaving', async () => {
    await flushSave();
    expect(saves).toHaveLength(0);
    fitBoxNow('curve', app.pages[0]);
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].pages[0].boxes[0].review.reason).toBe(REVIEW_REASONS.minSize);
  });

  it('and is not undone by the switch going off', async () => {
    fitBoxNow('curve', app.pages[0]);
    await useTextEngine('browser');
    expect(by('curve').review.reason).toBe(REVIEW_REASONS.minSize);
  });
});

// A box placed while its face was on its way is stored as never laid out
// ('pending'), and is the one kind of box an open lays out, under either
// engine: width, size and place included.
describe('a box stored as never laid out', () => {
  // Placed while the engine was still starting, when every face is on its way.
  async function placedPending() {
    let made;
    const started = new Promise((resolve) => (made = () => resolve(engine)));
    _setEngineSwitchDeps({ available: () => true, createEngine: () => started, invoke: async () => null, booted: async () => {}, os: () => 'macos' });
    const on = useTextEngine('rust');
    await wait(0);
    expect(engineSwitch.phase).toBe('starting');
    open({
      pages: [
        { id: 1, w: 800, h: 1200, lines: [{ n: 1, text: 'AAAA BBBB CCCC DDDD', tr: 'AAAA BBBB CCCC DDDD', tags: [] }], boxes: [box('grow', 'Narrow', 'AA BB', 60, 900)], activeLineN: 1 },
      ],
      typesetting: { mode: 'smart', version: LAYOUT_VERSION },
    });
    app.lastStyle.font = 'Narrow';
    placeActiveAt(400, 400);
    const file = { pages: copy(app.pages), typesetting: { mode: 'smart', version: LAYOUT_VERSION } };
    expect(file.pages[0].boxes[1].auto.status).toBe('pending');
    close();
    await useTextEngine('browser');
    made();
    await on;
    _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => null, booted: async () => {}, os: () => 'macos' });
    return file;
  }
  const whole = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size, auto: copy(b.auto), review: b.review ?? null });

  it('is laid out by the open, counted as that, and nothing is written', async () => {
    const file = await placedPending();
    await useTextEngine('rust');
    open(file);
    const stored = file.pages[0].boxes[1];
    const b = app.pages[0].boxes[1];
    expect(b.auto.status).not.toBe('pending');
    expect([b.x, b.w]).not.toEqual([stored.x, stored.w]);
    expect(firstFitChanges()).toMatchObject({ laid: 1, grew: 1 });
    expect(app.saved).toBe(true);
    await wait(900);
    await flushSave();
    expect(saves).toHaveLength(0);
  });

  it('the switch going off puts all of it back: the chapter is then what the browser alone makes of the file', async () => {
    const file = await placedPending();
    open(file);
    const alone = copy(app.pages);
    close();
    await useTextEngine('rust');
    open(file);
    const b = app.pages[0].boxes[1];
    const solved = whole(b);
    expect(solved).not.toEqual(whole(alone[0].boxes[1]));
    await useTextEngine('browser');
    expect(copy(app.pages)).toEqual(alone);
  });

  it('laid out when its font lands after the open, it is still not written for that', async () => {
    // Placed in a system family whose bytes were still on their way.
    const native = (hold) =>
      fakeNative(
        { Zapfino: [{ slots: { regular: 0 }, bytes: SFNT() }], 'Helvetica Neue': [{ slots: { regular: 0, bold: 1, italic: 2, boldItalic: 3 }, bytes: TTC() }] },
        { hold },
      );
    app.fonts.system = [
      systemFontEntry({ name: 'Helvetica Neue', faces: { regular: true, bold: true, italic: true, boldItalic: true } }),
      systemFontEntry({ name: 'Zapfino', faces: { regular: true } }),
    ];
    const held = native(true);
    _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => held, booted: async () => {}, os: () => 'macos' });
    const on = useTextEngine('rust');
    while (engineSwitch.phase !== 'on') {
      held.release();
      await wait(0);
    }
    await on;
    open({
      pages: [{ id: 1, w: 800, h: 1200, lines: [{ n: 1, text: 'AAAA BBBB CCCC DDDD', tr: 'AAAA BBBB CCCC DDDD', tags: [] }], boxes: [], activeLineN: 1 }],
      typesetting: { mode: 'smart', version: LAYOUT_VERSION },
    });
    app.lastStyle.font = 'Zapfino';
    placeActiveAt(400, 400);
    const file = { pages: copy(app.pages), typesetting: { mode: 'smart', version: LAYOUT_VERSION } };
    const stored = file.pages[0].boxes[0];
    expect(stored.auto.status).toBe('pending');
    close();
    await useTextEngine('browser');
    held.release();
    open(file);
    const alone = copy(app.pages);
    close();

    engine = fakeRustEngine();
    const free = native(false);
    _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => free, booted: async () => {}, os: () => 'macos' });
    await useTextEngine('rust');
    open(file);
    const b = app.pages[0].boxes[0];
    expect(b.auto.status).toBe('pending');
    await _engineSwitchSync().settled();
    expect(b.auto.status).not.toBe('pending');
    expect([b.x, b.w]).not.toEqual([stored.x, stored.w]);
    expect(firstFitChanges()).toMatchObject({ laid: 1 });
    expect(app.saved).toBe(true);
    await wait(900);
    expect(saves).toHaveLength(0);
    // And all of it goes back with the switch: the browser then lays the box
    // out itself, as it does when it opens the file.
    await useTextEngine('browser');
    expect(copy(app.pages)).toEqual(alone);
  });
});

describe('the switch going off while the chapter is still loading', () => {
  it('puts the boxes back: the loader holding the chapter unsaved is not an edit', async () => {
    const file = lettered();
    await useTextEngine('rust');
    // As library.svelte.js: the pages go in, and the pictures are waited for
    // before the chapter is declared saved.
    useChapterTypesetting(file.typesetting);
    loadProjectPages(copy(file.pages));
    expect(app.saved).toBe(false);
    expect(by('grow').h).toBeGreaterThan(file.pages[1].boxes[0].h);
    await useTextEngine('browser');
    expect(copy(app.pages)).toEqual(file.pages);
    // And the loader then finishes as it always does.
    app.chapterRef = { projectId: 'p', chapterId: 'c' };
    markSaved();
    await flushSave();
    expect(saves[0].pages).toEqual(file.pages);
  });

  it('but an edit made in that window is one', async () => {
    const file = lettered();
    await useTextEngine('rust');
    useChapterTypesetting(file.typesetting);
    loadProjectPages(copy(file.pages));
    const grown = by('grow').h;
    by('same').text = 'AB';
    markUnsaved();
    await useTextEngine('browser');
    expect(by('grow').h).toBe(grown);
  });
});

describe('a save taken while a box still waits for its font', () => {
  let invoke;
  const late = (version) => ({
    pages: [{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('same', 'AnimeAce', 'AA', 200, 100), box('late', 'Zapfino', 'AAAA BBBB', 60, 300)] }],
    typesetting: { mode: 'smart', version },
  });
  beforeEach(async () => {
    invoke = fakeNative(
      {
        'Helvetica Neue': [{ slots: { regular: 0, bold: 1, italic: 2, boldItalic: 3 }, bytes: TTC() }],
        Zapfino: [{ slots: { regular: 0 }, bytes: SFNT() }],
      },
      { hold: true },
    );
    _setEngineSwitchDeps({ available: () => true, createEngine: async () => engine, invoke: async () => invoke, booted: async () => {}, os: () => 'macos' });
    app.fonts.system = [
      systemFontEntry({ name: 'Helvetica Neue', faces: { regular: true, bold: true, italic: true, boldItalic: true } }),
      systemFontEntry({ name: 'Zapfino', faces: { regular: true } }),
    ];
    const on = useTextEngine('rust');
    while (engineSwitch.phase !== 'on') {
      invoke.release();
      await wait(0);
    }
    await on;
  });
  const land = async () => {
    for (let i = 0; i < 20 && by('late').h === 20; i++) {
      invoke.release();
      await wait(0);
    }
    await _engineSwitchSync().settled();
  };

  it('does not say the file is the Rust engine\'s: the edit is written at once, at the number the file had', async () => {
    open(late(LAYOUT_VERSION));
    expect(by('late').h).toBe(20);
    by('same').text = 'AB';
    markUnsaved();
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].pages[0].boxes[0].text).toBe('AB');
    expect(saves[0].typesetting.version).toBe(LAYOUT_VERSION);
    expect(app.typesetting.version).toBe(LAYOUT_VERSION);
  });

  it('and when the font lands the box it grew is saved, with the number', async () => {
    open(late(LAYOUT_VERSION));
    by('same').text = 'AB';
    markUnsaved();
    await flushSave();
    await land();
    expect(by('late').h).toBeGreaterThan(20);
    expect(app.saved).toBe(false);
    await wait(900);
    expect(saves).toHaveLength(2);
    expect(saves[1].typesetting.version).toBe(LAYOUT_VERSION_RUST);
    expect(saves[1].pages[0].boxes[1].h).toBe(by('late').h);
    expect(app.typesetting.version).toBe(LAYOUT_VERSION_RUST);
  });

  it('left before the font lands, the chapter is still a version 1 chapter, and is told again', async () => {
    open(late(LAYOUT_VERSION));
    by('same').text = 'AB';
    markUnsaved();
    await flushSave();
    const back = { pages: saves[0].pages, typesetting: saves[0].typesetting };
    close();
    await land().catch(() => {});
    open(back);
    expect(firstFit.open).toBe(true);
  });

  it('Keep waits for it: one write, with the grown box and the number; leaving meanwhile would write too', async () => {
    open(late(LAYOUT_VERSION));
    const kept = keepFirstFit();
    await wait(0);
    expect(saves).toHaveLength(0);
    expect(app.saved).toBe(true);
    expect(firstFit).toMatchObject({ keeping: true, kept: false, dismissed: false });
    await wait(900);
    expect(saves).toHaveLength(0);
    await land();
    await kept;
    expect(saves).toHaveLength(1);
    expect(saves[0].typesetting.version).toBe(LAYOUT_VERSION_RUST);
    expect(saves[0].pages[0].boxes[1].h).toBeGreaterThan(20);
  });

  it('Keep waits for an offscreen font too, and stamps only after it lands', async () => {
    const file = late(LAYOUT_VERSION);
    const slow = file.pages[0].boxes.pop();
    file.pages.push({ id: 2, w: 800, h: 1200, lines: [], boxes: [slow] });
    open(file);
    expect(app.pageIndex).toBe(0);
    const kept = keepFirstFit();
    await wait(900);
    expect(saves).toHaveLength(0);
    expect(firstFit.keeping).toBe(true);
    await land();
    await kept;
    expect(saves).toHaveLength(1);
    expect(saves[0].typesetting.version).toBe(LAYOUT_VERSION_RUST);
    expect(saves[0].pages[1].boxes[0].h).toBeGreaterThan(20);
  });

  it('Keep has an end when a font never answers, and a later answer saves the fitted result', async () => {
    open(late(LAYOUT_VERSION));
    vi.useFakeTimers();
    try {
      const kept = keepFirstFit();
      let done = false;
      kept.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS - 1);
      expect(saves).toHaveLength(0);
      expect(app.saved).toBe(true);
      expect(firstFit).toMatchObject({ keeping: true, kept: false, dismissed: false });
      await vi.advanceTimersByTimeAsync(1);
      expect(saves).toHaveLength(1);
      expect(firstFit.keeping).toBe(false);
      await kept;
      expect(done).toBe(true);
      expect(saves).toHaveLength(1);
      expect(saves[0].typesetting.version).toBe(LAYOUT_VERSION);
      expect(saves[0].pages[0].boxes[1].h).toBe(20);
      expect(firstFit).toMatchObject({ keeping: false, kept: true, dismissed: true });
    } finally {
      vi.useRealTimers();
    }
    await land();
    await wait(900);
    expect(saves).toHaveLength(2);
    expect(saves[1].typesetting.version).toBe(LAYOUT_VERSION_RUST);
    expect(saves[1].pages[0].boxes[1].h).toBeGreaterThan(20);
  });

  it('Keep still writes at its deadline when all known heights and flags are unchanged', async () => {
    const file = late(LAYOUT_VERSION);
    for (const b of file.pages[0].boxes) b.h = 500;
    open(file);
    vi.useFakeTimers();
    try {
      const kept = keepFirstFit();
      await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS - 1);
      expect(saves).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(saves).toHaveLength(1);
      expect(saves[0].typesetting.version).toBe(LAYOUT_VERSION);
      expect(firstFit.keeping).toBe(false);
      await kept;
    } finally { vi.useRealTimers(); }
  });

  it('a Keep from a closed chapter cannot write, stamp or answer the next chapter', async () => {
    open(late(LAYOUT_VERSION));
    const kept = keepFirstFit();
    await wait(0);
    await flushSave();
    close();
    const next = late(LAYOUT_VERSION);
    next.pages[0].boxes[0].text = 'NEXT';
    open(next);
    const before = copy(firstFit);
    const writes = saves.length;
    await land();
    await kept;
    await wait(900);
    expect(saves).toHaveLength(writes);
    expect(app.typesetting.version).toBe(LAYOUT_VERSION);
    expect(firstFit).toMatchObject({ kept: before.kept, dismissed: before.dismissed, keeping: false });
    expect(app.saved).toBe(true);
  });

  it('a version 2 chapter stays one, and a fit an edit was owed is saved when it lands', async () => {
    open(late(LAYOUT_VERSION_RUST));
    const b = by('late');
    b.text = 'AAAA BBBB CCCC';
    autoFitBox(b, page());
    markUnsaved();
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].typesetting.version).toBe(LAYOUT_VERSION_RUST);
    expect(saves[0].pages[0].boxes[1].h).toBe(20);
    await land();
    expect(b.h).toBeGreaterThan(20);
    await wait(900);
    expect(saves).toHaveLength(2);
    expect(saves[1].pages[0].boxes[1].h).toBe(b.h);
  });
});

describe('a save taken while the engine is still starting', () => {
  let made;
  beforeEach(() => {
    const started = new Promise((resolve) => (made = () => resolve(engine)));
    _setEngineSwitchDeps({ available: () => true, createEngine: () => started, invoke: async () => null, booted: async () => {}, os: () => 'macos' });
  });

  it('writes the number the file had: nobody has fitted this document', async () => {
    const two = lettered(LAYOUT_VERSION_RUST);
    const one = lettered();
    const on = useTextEngine('rust');
    await wait(0);
    expect(engineSwitch.phase).toBe('starting');
    open(two);
    await flushSave();
    expect(saves).toHaveLength(1);
    expect(saves[0].typesetting.version).toBe(LAYOUT_VERSION_RUST);
    expect(saves[0].pages).toEqual(two.pages);
    close();
    open(one);
    by('same').text = 'AB';
    markUnsaved();
    await flushSave();
    expect(saves).toHaveLength(2);
    expect(saves[1].typesetting.version).toBe(LAYOUT_VERSION);
    // Nor is anything said, or kept, before the engine has measured.
    expect(firstFitChanges()).toBe(null);
    close();
    open(one);
    await keepFirstFit();
    expect(saves).toHaveLength(2);
    close();
    made();
    await on;
  });
});

describe('what the notice counts is what the engine did', () => {
  it('a box the user makes taller in a chapter the engine changed nothing in is not counted, and no notice appears', async () => {
    await useTextEngine('rust');
    open({ pages: [{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('same', 'AnimeAce', 'AA', 200, 100)] }], typesetting: { mode: 'smart', version: LAYOUT_VERSION } });
    const fitted = { pages: copy(app.pages), typesetting: { mode: 'smart', version: LAYOUT_VERSION } };
    close();
    open(fitted);
    expect(firstFitChanges()).toMatchObject({ grew: 0, flagged: 0, cleared: 0, relaid: 0 });
    by('same').h += 30;
    markUnsaved();
    expect(firstFitChanges()).toMatchObject({ grew: 0, flagged: 0, cleared: 0, relaid: 0 });
  });

  describe('in the made-up chapter', () => {
    beforeEach(async () => {
      const file = lettered();
      await useTextEngine('rust');
      open(file);
    });

    it('a box the engine grew and the user then drags taller is theirs', () => {
      expect(firstFitChanges().grew).toBe(1);
      by('grow').h += 30;
      markUnsaved();
      expect(firstFitChanges().grew).toBe(0);
      // A grow-only fit of it afterwards does not make it the engine's again.
      app.pageIndex = 1;
      autoFitBox(by('same'), app.pages[0]);
      expect(firstFitChanges().grew).toBe(0);
    });

    it('a flag an edit raises is not the engine\'s, and one an edit clears is no longer counted', () => {
      expect(firstFitChanges()).toMatchObject({ flagged: 1, cleared: 1 });
      // A box sized by hand is flagged, not fitted, when its text outgrows it.
      const same = by('same');
      same.style.autoHeight = false;
      same.w = 30 + INSET;
      same.text = 'AAAAAAAAAAAAAAAA';
      autoFitBox(same, app.pages[0]);
      expect(same.review).toMatchObject({ kind: 'overflow' });
      expect(firstFitChanges().flagged).toBe(1);
      const flag = by('flag');
      flag.w += 200;
      autoFitBox(flag, app.pages[1]);
      expect(flag.review ?? null).toBe(null);
      expect(firstFitChanges()).toMatchObject({ flagged: 0, first: { boxId: 'relaid' } });
    });

    it('a box moved by hand is not counted either', () => {
      by('grow').x += 5;
      expect(firstFitChanges().grew).toBe(0);
    });
  });
});

describe('what the switch going off puts back, beyond a height', () => {
  it('the top of a box that grew about its middle', async () => {
    const mid = { ...box('mid', 'Narrow', 'AA BB', 60, 300), style: { ...style('Narrow'), valign: 'middle' } };
    open({ pages: [{ id: 1, w: 800, h: 1200, lines: [], boxes: [mid] }], typesetting: { mode: 'smart', version: LAYOUT_VERSION } });
    const file = { pages: copy(app.pages), typesetting: { mode: 'smart', version: LAYOUT_VERSION } };
    close();
    await useTextEngine('rust');
    open(file);
    expect(by('mid').h).toBeGreaterThan(file.pages[0].boxes[0].h);
    expect(by('mid').y).toBeLessThan(file.pages[0].boxes[0].y);
    await useTextEngine('browser');
    expect(copy(app.pages)).toEqual(file.pages);
  });

  it('the stamp of a solve, which a grown height moves', async () => {
    // Placed under the browser, so the solver has a record of it.
    open({
      pages: [{ id: 1, w: 800, h: 1200, lines: [{ n: 1, text: 'AAAA BBBB CCCC DDDD EEEE FFFF', tr: 'AAAA BBBB CCCC DDDD EEEE FFFF', tags: [] }], boxes: [], activeLineN: 1 }],
      typesetting: { mode: 'smart', version: LAYOUT_VERSION },
    });
    app.lastStyle.font = 'Narrow';
    placeActiveAt(400, 400);
    const file = { pages: copy(app.pages), typesetting: { mode: 'smart', version: LAYOUT_VERSION } };
    const stored = file.pages[0].boxes[0];
    expect(stored.auto.stamp).toBeTruthy();
    expect(stored.auto.status).not.toBe('pending');
    close();
    await useTextEngine('rust');
    open(file);
    const b = app.pages[0].boxes[0];
    expect(b.h).toBeGreaterThan(stored.h);
    expect(b.auto.stamp).not.toBe(stored.auto.stamp);
    await useTextEngine('browser');
    expect(copy(app.pages)).toEqual(file.pages);
  });
});

describe('how the lines broke before, asked of an engine that cannot say', () => {
  it('a box whose face the browser has not loaded is not said to have new line breaks', async () => {
    const file = lettered();
    browser.faceReady = (face) => face.name !== 'AnimeAce';
    await useTextEngine('rust');
    open(file);
    expect(firstFitChanges()).toMatchObject({ grew: 1, flagged: 1, cleared: 1, relaid: 1 });
    expect(flaggedBoxes().map((f) => f.boxId)).toEqual(['grow', 'flag']);
  });

  it('nor any box while the browser is still loading its fonts', async () => {
    const file = lettered();
    browser.loading = () => true;
    await useTextEngine('rust');
    open(file);
    expect(firstFitChanges()).toMatchObject({ grew: 1, relaid: 0 });
  });
});

describe('Keep, when the write fails', () => {
  it('brings the notice back: nothing was kept, the chapter is unsaved, and the file\'s number is not taken', async () => {
    const file = lettered();
    await useTextEngine('rust');
    open(file);
    unhook();
    unhook = setSaver(async () => {
      stampTypesetting();
      throw new Error('disk full');
    });
    await expect(keepFirstFit()).rejects.toThrow('disk full');
    expect(firstFit).toMatchObject({ open: true, kept: false, dismissed: false });
    expect(firstFitChanges()).toMatchObject({ grew: 1, kept: false });
    expect(app.saved).toBe(false);
    expect(app.saveFailed).toBe(true);
    expect(app.typesetting.version).toBe(LAYOUT_VERSION);
    // Leaving tries again; and so does a second press, with a disk that takes it.
    unhook();
    unhook = setSaver(saver);
    await keepFirstFit();
    expect(saves).toHaveLength(1);
    expect(saves[0].typesetting.version).toBe(LAYOUT_VERSION_RUST);
    expect(firstFit).toMatchObject({ kept: true, dismissed: true });
    app.saveFailed = false;
  });

  it('an edit\'s save that fails has kept nothing either', async () => {
    const file = lettered();
    await useTextEngine('rust');
    open(file);
    unhook();
    unhook = setSaver(async () => {
      stampTypesetting();
      throw new Error('disk full');
    });
    by('same').text = 'AB';
    markUnsaved();
    await expect(flushSave()).rejects.toThrow('disk full');
    expect(firstFitChanges()).toMatchObject({ kept: false });
    expect(app.typesetting.version).toBe(LAYOUT_VERSION);
    // Nor does its number wait for whoever next says the disk is current.
    markSaved();
    expect(app.typesetting.version).toBe(LAYOUT_VERSION);
    expect(firstFit.kept).toBe(false);
    app.saveFailed = false;
  });
});

// In a long strip a box may grow over the seam into the next page, so the
// grow-only pass works in the strip's coordinates: `(y + top) - top`, which is
// not always `y` again in the last bit. Found by the dry run, which opens the
// user's chapters under both layouts.
describe('in a long strip, a box the open does not grow', () => {
  const Y = 214.97986469072166;
  const strip = () => ({
    pages: [
      { id: 1, w: 800, h: 1200, lines: [], boxes: [] },
      { id: 2, w: 800, h: 1200, lines: [], boxes: [{ ...box('roomy', 'AnimeAce', 'AA', 200, Y), h: 400 }] },
    ],
    typesetting: { mode: 'smart', version: LAYOUT_VERSION },
  });
  beforeEach(() => {
    app.projectLayout = 'longstrip';
  });
  afterEach(() => {
    app.projectLayout = 'pages';
  });

  it('keeps its top edge to the last bit under the Rust engine, and the open says nothing', async () => {
    expect(Y + 1200 - 1200).not.toBe(Y);
    await useTextEngine('rust');
    open(strip());
    expect(by('roomy').y).toBe(Y);
    expect(firstFitChanges()).toMatchObject({ grew: 0, flagged: 0, cleared: 0, relaid: 0, laid: 0 });
    await flushSave();
    expect(saves).toHaveLength(0);
  });

  it('under the browser the pass is as it has always been: this phase changes nothing there', () => {
    open(strip());
    expect(by('roomy').y).toBe(Y + 1200 - 1200);
  });
});
