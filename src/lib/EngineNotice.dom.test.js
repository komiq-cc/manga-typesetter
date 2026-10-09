import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import EngineNotice from './EngineNotice.svelte';
import ReviewList from './ReviewList.svelte';
import { app, loadProjectPages, useChapterTypesetting, setSaver, markSaved, markUnsaved, flushSave, stampTypesetting, placeActiveAt, KEEP_WAIT_MS, firstFit, keepFirstFit } from './store.svelte.js';
import { engineSwitch, useTextEngine, _setEngineSwitchDeps, _resetEngineSwitch } from './engine-switch.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { contentWidth, setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { fakeRustEngine, fakeNative, SFNT, TTC } from '../test/fake-rust-engine.js';
import { systemFontEntry } from './fonts.js';
import { emptyFaces } from './data.js';

// The queue's notice for a chapter the Rust engine fits for the first time,
// mounted for real over the real store and switch. The engines are the unit
// lane's stand-ins (first-fit.test.js, which pins the counting): a "browser"
// with every letter 0.55 of the size, and an engine with letters as wide as
// the family's name says.

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

const style = (font) => ({ font, size: 20, lineHeight: 1.1, valign: 'top', outlineWidth: 0 });
const INSET = 100 - contentWidth(100, style('AnimeAce'));
const box = (id, font, text, content, y) => ({ id, lineN: null, text, x: 100, y, w: content + INSET, h: 20, style: style(font) });
const userFont = (name) => ({ name, css: `'${name}'`, real: true, faces: { ...emptyFaces(), regular: { file: `${name}.ttf` } } });
// As first-fit.test.js: lines that move, a box that grows, a flag raised, a flag cleared.
const made = () => [
  { id: 1, w: 800, h: 1200, lines: [], boxes: [box('same', 'AnimeAce', 'AA', 200, 100)] },
  {
    id: 2, w: 800, h: 1200, lines: [],
    boxes: [box('relaid', 'AnimeAce', 'AAAA BBBB CCCC', 80, 100), box('grow', 'Narrow', 'AA BB', 60, 300), box('flag', 'Narrow', 'AAAA', 50, 500), box('clear', 'AnimeAce', 'AAAA', 30, 700)],
  },
];

const original = { engine: textEngine(), typeset: typesetEnabled(), system: app.fonts.system };
let saves;
let unhook;
const copy = (v) => JSON.parse(JSON.stringify(v));

function open(file) {
  useChapterTypesetting(file.typesetting);
  loadProjectPages(copy(file.pages));
  app.chapterRef = { projectId: 'p', chapterId: 'c' };
  markSaved();
}
function close() {
  app.chapterRef = null;
  useChapterTypesetting(null);
  loadProjectPages([]);
}
// The chapter as the browser fitted and wrote it.
function lettered() {
  open({ pages: made(), typesetting: { mode: 'smart', version: 1 } });
  const file = { pages: copy(app.pages), typesetting: { mode: 'smart', version: 1 } };
  close();
  return file;
}
async function rustOn() {
  await useTextEngine('rust');
  await tick();
}

beforeEach(() => {
  setTextEngine(fakeBrowser());
  setTypesetEnabled(true);
  app.fonts.user = [userFont('AnimeAce'), userFont('Narrow')];
  _setEngineSwitchDeps({
    available: () => true,
    createEngine: async () => fakeRustEngine(),
    invoke: async () => null,
    booted: async () => {},
    records: async () => [
      { name: 'AnimeAce', slot: 'regular', file: 'AnimeAce.ttf', data: SFNT() },
      { name: 'Narrow', slot: 'regular', file: 'Narrow.ttf', data: SFNT() },
    ],
    watch: () => {},
    os: () => 'macos',
  });
  saves = [];
  unhook = setSaver(async () => {
    saves.push(stampTypesetting());
    markSaved();
  });
});

afterEach(() => {
  cleanup();
  unhook();
  close();
  _resetEngineSwitch();
  _setEngineSwitchDeps(null);
  app.fonts.user = [];
  app.fonts.system = original.system;
  vi.useRealTimers();
  setTextEngine(original.engine);
  setTypesetEnabled(original.typeset);
  clearLayoutMemo();
});

const notice = (view) => view.container.querySelector('.en');
// Keep waits for the fonts and then for the write: more than one turn.
const settled = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await tick();
};
const button = (view, name) => [...view.container.querySelectorAll('.en-btn')].find((b) => b.textContent.trim() === name);

describe('the first-fit notice', () => {
  it('is not there with the browser measuring', () => {
    open(lettered());
    const view = render(EngineNotice);
    expect(notice(view)).toBe(null);
  });

  it('says how many boxes have new line breaks, were flagged, were cleared and grew, and that nothing is saved', async () => {
    const file = lettered();
    await rustOn();
    open(file);
    const view = render(EngineNotice);
    expect(notice(view).querySelector('.en-what').textContent).toBe('2 boxes with new line breaks · 1 box newly flagged · 1 box no longer flagged · 1 box grew taller');
    expect(notice(view).querySelector('.en-note').textContent).toContain('Nothing is saved until you edit the chapter or keep these.');
    expect(notice(view).querySelector('.en-note').textContent).toContain('No box changed its width, size or place.');
    expect(button(view, 'Keep')).toBeTruthy();
    expect(app.saved).toBe(true);
    expect(saves).toHaveLength(0);
  });

  it('appears when the switch is turned on over an open chapter, and goes when it is turned off', async () => {
    open(lettered());
    const view = render(EngineNotice);
    expect(notice(view)).toBe(null);
    await rustOn();
    expect(notice(view).querySelector('.en-what').textContent).toContain('2 boxes with new line breaks');
    await useTextEngine('browser');
    await tick();
    expect(notice(view)).toBe(null);
  });

  it('is not there for a chapter the engine changes nothing in', async () => {
    await rustOn();
    open({ pages: [{ id: 1, w: 800, h: 1200, lines: [], boxes: [box('same', 'AnimeAce', 'AA', 200, 100)] }], typesetting: { mode: 'smart', version: 1 } });
    // Fitted once already: the height the engine wants is the height it has.
    const fitted = { pages: copy(app.pages), typesetting: { mode: 'smart', version: 1 } };
    close();
    open(fitted);
    const view = render(EngineNotice);
    expect(notice(view)).toBe(null);
  });

  it('Show first goes to the first box to look at, on the page it is on', async () => {
    const file = lettered();
    await rustOn();
    open(file);
    const view = render(EngineNotice);
    expect(app.pageIndex).toBe(0);
    await fireEvent.click(button(view, 'Show first'));
    expect(app.pageIndex).toBe(1);
    expect(app.selectedId).toBe('relaid');
  });

  it('the boxes it counts are the rows of the review list, the ones whose lines moved included', async () => {
    const file = lettered();
    await rustOn();
    open(file);
    const view = render(EngineNotice);
    const list = render(ReviewList);
    await fireEvent.click(list.getByRole('button', { name: /3 boxes need review/ }));
    const rows = [...list.container.querySelectorAll('.rv-row')];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.querySelector('.rv-why').textContent)).toContain('Line breaks changed with the new text engine');
    // Answered, the notice goes and the list is the flagged boxes alone.
    await fireEvent.click(button(view, 'Keep'));
    await tick();
    expect(notice(view)).toBe(null);
    expect(list.getByRole('button', { name: /1 box needs review/ })).toBeTruthy();
  });

  it('Keep saves the chapter once, at version 2', async () => {
    const file = lettered();
    await rustOn();
    open(file);
    const view = render(EngineNotice);
    await fireEvent.click(button(view, 'Keep'));
    await tick();
    expect(saves).toEqual([{ mode: 'smart', version: 2 }]);
    expect(notice(view)).toBe(null);
  });

  it('after a save the user’s own edit caused, it says the changes are saved and offers only to close', async () => {
    const file = lettered();
    await rustOn();
    open(file);
    const view = render(EngineNotice);
    markUnsaved();
    await flushSave();
    await tick();
    expect(notice(view).querySelector('.en-note').textContent).toContain('These are saved with the chapter.');
    expect(button(view, 'Keep')).toBeUndefined();
    await fireEvent.click(button(view, 'Got it'));
    await tick();
    expect(notice(view)).toBe(null);
    expect(saves).toHaveLength(1);
  });

  it('a Keep whose write fails leaves the notice standing, with Keep to press again, and says why', async () => {
    const file = lettered();
    await rustOn();
    open(file);
    const view = render(EngineNotice);
    unhook();
    unhook = setSaver(async () => {
      stampTypesetting();
      throw new Error('disk full');
    });
    await fireEvent.click(button(view, 'Keep'));
    await settled();
    expect(app.toast.msg).toBe('Could not save: disk full');
    expect(notice(view).querySelector('.en-note').textContent).toContain('Nothing is saved until you edit the chapter or keep these.');
    expect(button(view, 'Keep').disabled).toBe(false);
    expect(app.saved).toBe(false);
    unhook();
    unhook = setSaver(async () => {
      saves.push(stampTypesetting());
      markSaved();
    });
    await fireEvent.click(button(view, 'Keep'));
    await settled();
    expect(saves).toEqual([{ mode: 'smart', version: 2 }]);
    expect(notice(view)).toBe(null);
    app.saveFailed = false;
  });

  it('shows Keep waiting during a held font, then reports a timed-out save failure and allows retry', async () => {
    const file = lettered();
    const native = fakeNative({
      'Helvetica Neue': [{ slots: { regular: 0, bold: 1, italic: 2, boldItalic: 3 }, bytes: TTC() }],
      Zapfino: [{ slots: { regular: 0 }, bytes: SFNT() }],
    }, { hold: true });
    app.fonts.system = [
      systemFontEntry({ name: 'Helvetica Neue', faces: { regular: true, bold: true, italic: true, boldItalic: true } }),
      systemFontEntry({ name: 'Zapfino', faces: { regular: true } }),
    ];
    _setEngineSwitchDeps({
      available: () => true, createEngine: async () => fakeRustEngine(), invoke: async () => native, booted: async () => {},
      records: async () => [{ name: 'AnimeAce', slot: 'regular', file: 'AnimeAce.ttf', data: SFNT() }, { name: 'Narrow', slot: 'regular', file: 'Narrow.ttf', data: SFNT() }],
      watch: () => {}, os: () => 'macos',
    });
    const on = useTextEngine('rust');
    while (engineSwitch.phase !== 'on') { native.release(); await new Promise((resolve) => setTimeout(resolve, 0)); }
    await on;
    file.pages[0].boxes.push(box('late', 'Zapfino', 'AAAA BBBB', 60, 400));
    open(file);
    const view = render(EngineNotice);
    unhook();
    unhook = setSaver(async () => { stampTypesetting(); throw new Error('disk full'); });
    vi.useFakeTimers();
    await fireEvent.click(button(view, 'Keep'));
    await tick();
    expect(firstFit.keeping).toBe(true);
    expect(notice(view).textContent).toContain('Keep is waiting for fonts.');
    expect(notice(view).textContent).toContain('After four seconds it saves what is ready');
    expect(button(view, 'Waiting for fonts…').disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS - 1);
    expect(saves).toHaveLength(0);
    expect(app.saved).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    expect(firstFit.keeping).toBe(false);
    expect(app.toast.msg).toBe('Could not save: disk full');
    expect(button(view, 'Keep').disabled).toBe(false);
    expect(notice(view).textContent).not.toContain('These are saved with the chapter.');
    unhook();
    unhook = setSaver(async () => { saves.push(stampTypesetting()); markSaved(); });
    await fireEvent.click(button(view, 'Keep'));
    await vi.advanceTimersByTimeAsync(KEEP_WAIT_MS);
    await tick();
    expect(saves).toEqual([{ mode: 'smart', version: 1 }]);
    expect(firstFit.keeping).toBe(false);
    expect(notice(view)).toBe(null);
    vi.useRealTimers();
    native.release();
  });

  it('does not claim a newer fit is kept when an older snapshot lands', async () => {
    const file = lettered();
    await rustOn();
    open(file);
    const view = render(EngineNotice);
    let land;
    unhook();
    unhook = setSaver(async () => { stampTypesetting(); await new Promise((resolve) => { land = resolve; }); markSaved(); });
    markUnsaved();
    const writing = flushSave();
    await tick();
    await Promise.resolve();
    app.pages[1].boxes[0].h += 20;
    land();
    await writing;
    await tick();
    expect(app.saved).toBe(false);
    expect(firstFit.kept).toBe(false);
    expect(notice(view).textContent).not.toContain('These are saved with the chapter.');
    // Cancel the pending test debounce with the real saver before cleanup.
    unhook();
    unhook = setSaver(async () => { saves.push(stampTypesetting()); markSaved(); });
    await flushSave();
  });

  it('a box stored as never laid out is said to have been laid out, and only the others to have kept their width, size and place', async () => {
    // Placed while the engine was starting, when every face is on its way.
    const records = [
      { name: 'AnimeAce', slot: 'regular', file: 'AnimeAce.ttf', data: SFNT() },
      { name: 'Narrow', slot: 'regular', file: 'Narrow.ttf', data: SFNT() },
    ];
    let made;
    const started = new Promise((resolve) => (made = () => resolve(fakeRustEngine())));
    const deps = (createEngine) => ({ available: () => true, createEngine, invoke: async () => null, booted: async () => {}, records: async () => records, watch: () => {}, os: () => 'macos' });
    _setEngineSwitchDeps(deps(() => started));
    const on = useTextEngine('rust');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engineSwitch.phase).toBe('starting');
    open({
      pages: [{ id: 1, w: 800, h: 1200, lines: [{ n: 1, text: 'AAAA BBBB CCCC DDDD', tr: 'AAAA BBBB CCCC DDDD', tags: [] }], boxes: [], activeLineN: 1 }],
      typesetting: { mode: 'smart', version: 1 },
    });
    app.lastStyle.font = 'Narrow';
    placeActiveAt(400, 400);
    const file = { pages: copy(app.pages), typesetting: { mode: 'smart', version: 1 } };
    expect(file.pages[0].boxes[0].auto.status).toBe('pending');
    close();
    await useTextEngine('browser');
    made();
    await on;
    _setEngineSwitchDeps(deps(async () => fakeRustEngine()));
    await rustOn();
    open(file);
    const view = render(EngineNotice);
    expect(notice(view).querySelector('.en-what').textContent).toBe('1 box laid out for the first time');
    expect(notice(view).querySelector('.en-note').textContent).toContain('No other box changed its width, size or place.');
  });
});
