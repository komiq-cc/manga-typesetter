import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  app,
  loadProjectPages,
  addEmptyBox,
  addQueueLine,
  beginEdit,
  byId,
  clampSidebarWidth,
  flushSave,
  markUnsaved,
  markSaved,
  sidebarFromJSON,
  saveSidebar,
  flushSidebar,
  endEdit,
  deselect,
  selectBox,
  settleEdits,
  recordEdit,
  placeActiveAt,
  activateLine,
  toggleTagOnLine,
  setSaver,
  setRecorder,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  PREF_SAVE_MS,
  DOC_SAVE_MS,
  setPageSwitchHook,
  setEditSettleHook,
  gotoPage,
  page,
  setTool,
  TOOLS,
  setZoom,
  applyFit,
  zoomIn,
  zoomOut,
  zoomReset,
  ZOOM_STOPS,
  ZOOM_MIN,
  ZOOM_MAX,
  BULK_PROPS,
  BULK_WHOLE_LEAVES,
  GROUPS,
  bulkTicked,
  setBulkProp,
  tickBulkProp,
  mergeMasked,
  mergeMaskedInto,
  openBulk,
  closeBulk,
  applyBulk,
  applyBulkToTag,
  setBulkTag,
  setBulkScope,
  bulkScopePages,
  toggleBulkTarget,
  isBulkTarget,
  hasPageSpace,
  pageForSrc,
  setPageDims,
  setPageDimsForSrc,
  applyDetection,
  boxText,
  setBoxText,
  deleteBox,
  duplicateBox,
  addInkBox,
  setBoxInk,
  resizeBox,
  nudgeBox,
  lineByN,
  isPlaced,
  firstUnplaced,
  visiblePageCenter,
  PAGE_W,
  PAGE_H,
  detectedRectFor,
  placementRect,
  CHAPTER_MODES,
  normalizeChapterMode,
  isTranslateMode,
  isTranslated,
  translatedCount,
  rawZoomBy,
  rawZoomIn,
  rawZoomOut,
  RAW_ZOOM_MAX,
  LAYOUTS,
  normalizeLayout,
  isLongstrip,
  OCR_LANGUAGES,
  normalizeOcrLanguage,
  focusPage,
  cloneStyle,
  rememberStyle,
  resetBoxRotation,
  rememberSizeFor,
  inheritedStyleFor,
  placeableDetectedLines,
  placeDetectedOnPage,
  placeDetectedInChapter,
  sidebarMaxWidth,
  SIDEBAR_MAX_SHARE,
  toggleBalloonFit,
} from './store.svelte.js';
import { defaultStyle, normalizeStyle, GRADIENT_MAX_STOPS } from './data.js';
import { setPref } from './prefs.svelte.js';
import { bindTags, tags, lineTags, setLineTags } from './tags.svelte.js';
import { initHistory, resetHistory, undo, redo } from './editor/history.svelte.js';

beforeEach(() => {
  tags.sizes = {};
});

const pageWith = (boxes) => ({
  id: 1,
  w: 800,
  h: 1200,
  lines: [],
  boxes,
});
const box = (id, extra = {}) => ({ id, lineN: null, text: 'x', x: 0, y: 0, w: 10, h: 10, ...extra });

// Both id counters are module globals that only ever climb and are never reset,
// so a case that needs to know what the next minted id will be has to ask at
// call time. Hard-coding a base passes only while the file happens to run in
// written order, and vitest is free to shuffle it.
const nextBoxSeq = () => {
  loadProjectPages([pageWith([])]);
  return Number(addEmptyBox(0, 0).slice(1)) + 1;
};
const nextPageSeq = () => {
  loadProjectPages([{ ...pageWith([]), id: null }]);
  return app.pages[0].id + 1;
};

describe('loadProjectPages box identity', () => {
  beforeEach(() => {
    app.chapterRef = null;
  });

  it('keeps ids that came off disk', () => {
    loadProjectPages([pageWith([box('b7'), box('b9')])]);
    expect(app.pages[0].boxes.map((b) => b.id)).toEqual(['b7', 'b9']);
  });

  it('mints a fresh id for a box that has none', () => {
    loadProjectPages([pageWith([box('b3'), box(undefined)])]);
    const ids = app.pages[0].boxes.map((b) => b.id);
    expect(ids[0]).toBe('b3');
    expect(ids[1]).toMatch(/^b\d+$/);
    expect(ids[1]).not.toBe('b3');
  });

  it('remints a duplicate id rather than loading two boxes that answer to it', () => {
    loadProjectPages([pageWith([box('b4'), box('b4')])]);
    const ids = app.pages[0].boxes.map((b) => b.id);
    expect(ids[0]).toBe('b4');
    expect(ids[1]).not.toBe('b4');
    expect(new Set(ids).size).toBe(2);
  });

  it('never mints an id a kept box already owns, across pages', () => {
    const base = nextBoxSeq() + 40;
    loadProjectPages([
      { ...pageWith([box(undefined)]), id: 1 },
      { ...pageWith([box(`b${base}`)]), id: 2 },
    ]);
    expect(app.pages[0].boxes[0].id).toBe(`b${base + 1}`);
    expect(app.pages[1].boxes[0].id).toBe(`b${base}`);
  });

  it('seeds the counter so a box added after the load cannot collide', () => {
    const base = nextBoxSeq() + 100;
    loadProjectPages([pageWith([box(`b${base}`)])]);
    expect(addEmptyBox(100, 100)).toBe(`b${base + 1}`);
  });
});

describe('loadProjectPages page identity', () => {
  beforeEach(() => {
    app.chapterRef = null;
  });

  it('keeps page ids that came off disk', () => {
    loadProjectPages([
      { ...pageWith([]), id: 3 },
      { ...pageWith([]), id: 8 },
    ]);
    expect(app.pages.map((p) => p.id)).toEqual([3, 8]);
  });

  it('remints a duplicate page id rather than loading two pages that answer to it', () => {
    loadProjectPages([
      { ...pageWith([]), id: 3 },
      { ...pageWith([]), id: 3 },
    ]);
    const ids = app.pages.map((p) => p.id);
    expect(ids[0]).toBe(3);
    expect(ids[1]).not.toBe(3);
    expect(new Set(ids).size).toBe(2);
  });

  it('never mints a page id a kept page already owns', () => {
    const base = nextPageSeq() + 40;
    loadProjectPages([
      { ...pageWith([]), id: null },
      { ...pageWith([]), id: base },
    ]);
    expect(app.pages.map((p) => p.id)).toEqual([base + 1, base]);
  });
});

// chapter.json is a file on the user's disk, and `line.tags` used to be copied
// out of it verbatim. Two hand-edited shapes did not merely read oddly: a
// duplicate throws Svelte's `each_key_duplicate` in the queue's keyed `{#each}`
// and the panel stops rendering, and a name in a spelling the app would never
// have written renders a chip whose click adds a second tag rather than removing
// the first.
describe('loadProjectPages tag sanitising', () => {
  beforeEach(() => {
    app.chapterRef = null;
  });

  const withTags = (tags) =>
    loadProjectPages([{ ...pageWith([]), lines: [{ n: 1, type: 'dialogue', en: 'a', tags }] }]);
  const tagsOf = () => app.pages[0].lines[0].tags;

  it('drops a duplicate rather than letting the queue throw on it', () => {
    withTags(['sfx', 'sfx']);
    expect(tagsOf()).toEqual(['sfx']);
  });

  it('folds a name to the one spelling every other write uses', () => {
    withTags(['SFX', '  Narration  ']);
    expect(tagsOf()).toEqual(['sfx', 'narration']);
  });

  it('counts two spellings of one name as one tag', () => {
    withTags(['sfx', 'SFX']);
    expect(tagsOf()).toEqual(['sfx']);
  });

  it('drops what is not a name at all, and keeps what is', () => {
    withTags([null, 42, '', '   ', { name: 'sfx' }, 'narration']);
    expect(tagsOf()).toEqual(['narration']);
  });

  // The array's *presence* is what tells `lineTags` the user has taken over from
  // the legacy `line.type`. A `tags` that is not an array never said that, so it
  // goes rather than becoming an empty array that silently means "no tags".
  it('drops a tags field that is not an array, leaving the legacy type in charge', () => {
    loadProjectPages([{ ...pageWith([]), lines: [{ n: 1, type: 'sfx', en: 'a', tags: 'sfx' }] }]);
    expect('tags' in app.pages[0].lines[0]).toBe(false);
  });

  it('leaves a line that was never tagged untouched', () => {
    loadProjectPages([{ ...pageWith([]), lines: [{ n: 1, type: 'sfx', en: 'a' }] }]);
    expect('tags' in app.pages[0].lines[0]).toBe(false);
  });
});

describe('loadProjectPages repair count', () => {
  beforeEach(() => {
    app.chapterRef = null;
  });

  it('reports nothing to repair when every id on disk is usable', () => {
    expect(loadProjectPages([pageWith([box('b7'), box('b9')])])).toBe(0);
  });

  it('counts every id it had to mint, boxes and pages alike', () => {
    const repaired = loadProjectPages([
      { ...pageWith([box('b7'), box('b7')]), id: 3 },
      { ...pageWith([box(undefined)]), id: 3 },
    ]);
    expect(repaired).toBe(3);
  });

  // `detect` arrives from files this build did not write - a hand edit, a
  // foreign tool, a save that died mid-write. One that carries `panels` and no
  // `boxes` used to throw straight out of the load, which costs the user the
  // whole chapter over one absent field. An absent list is an empty list, which
  // is what every reader of it already handles.
  it('loads a detect block that is missing either of its two lists', () => {
    expect(() =>
      loadProjectPages([
        { ...pageWith([]), id: 1, detect: { panels: [[0, 0, 10, 10]] } },
        { ...pageWith([]), id: 2, detect: { boxes: [{ n: 1, box: [1, 2, 3, 4] }] } },
        { ...pageWith([]), id: 3, detect: {} },
      ]),
    ).not.toThrow();
    expect(app.pages[0].detect.boxes).toEqual([]);
    expect(app.pages[0].detect.panels).toEqual([[0, 0, 10, 10]]);
    expect(app.pages[1].detect.panels).toEqual([]);
    expect(app.pages[2].detect).toEqual({ panels: [], boxes: [] });
  });
});

// The seam the history file hangs off: only the page on screen keeps its undo
// stack in memory, so a page turn has to say which page it left and which it
// arrived at. The store itself knows nothing about either.
describe('the page switch hook', () => {
  it('names both pages, and says nothing when the page did not change', () => {
    loadProjectPages([{ ...pageWith([]), id: 1 }, { ...pageWith([]), id: 2 }]);
    const seen = [];
    setPageSwitchHook((from, to) => seen.push([from, to]));
    try {
      gotoPage(1);
      gotoPage(1); // already there - nothing to hand over
      gotoPage(9); // out of range - refused before anything moves
      gotoPage(0);
      expect(seen).toEqual([
        [1, 2],
        [2, 1],
      ]);
    } finally {
      setPageSwitchHook(null);
    }
  });

  // An entry still inside a settle window belongs to the page being left, and
  // the live stack is the only place it can be pushed - `recordEdit` has no
  // page awareness of its own. A settle that ran a step later would land on the
  // page being arrived at, and the next write would file that page's entries
  // under this one's key.
  it('settles a pending edit while the page being left is still the live one', () => {
    loadProjectPages([{ ...pageWith([]), id: 1 }, { ...pageWith([]), id: 2 }]);
    const seen = [];
    setEditSettleHook(() => seen.push(page().id));
    try {
      gotoPage(1);
      expect(seen).toEqual([1]);
    } finally {
      setEditSettleHook(null);
    }
  });
});

// One slot each is fine right up until a second listener wants the same seam:
// the second registration displaced the first silently, so a panel that
// coalesces its edits would have taken the Inspector's settle away and neither
// of them would have said a word - the Inspector's edits would simply have
// stopped being recorded. The page-switch seam stands in for all four; they are
// one implementation.
describe('the hook seams take more than one subscriber', () => {
  const twoPages = () => [
    { ...pageWith([]), id: 1 },
    { ...pageWith([]), id: 2 },
  ];

  it('fires every subscriber, in the order they registered', () => {
    loadProjectPages(twoPages());
    const seen = [];
    const offA = setPageSwitchHook((from, to) => seen.push(['a', from, to]));
    const offB = setPageSwitchHook((from, to) => seen.push(['b', from, to]));
    try {
      gotoPage(1);
      expect(seen).toEqual([
        ['a', 1, 2],
        ['b', 1, 2],
      ]);
    } finally {
      offA();
      offB();
    }
  });

  it('unsubscribes exactly one, leaving the rest standing', () => {
    loadProjectPages(twoPages());
    const seen = [];
    const offA = setPageSwitchHook(() => seen.push('a'));
    const offB = setPageSwitchHook(() => seen.push('b'));
    try {
      offA();
      gotoPage(1);
      expect(seen).toEqual(['b']);
    } finally {
      offB();
    }
  });

  // Identity is the registration, not the function. Two panels that happened to
  // register the same callback are two subscribers, and releasing one must not
  // take the other with it.
  it('counts the same function registered twice as two subscribers', () => {
    loadProjectPages(twoPages());
    let n = 0;
    const bump = () => n++;
    const offA = setPageSwitchHook(bump);
    const offB = setPageSwitchHook(bump);
    try {
      offA();
      gotoPage(1);
      expect(n).toBe(1);
    } finally {
      offB();
    }
  });

  // A component's teardown can run twice - a release that removed "one entry"
  // each time would eat a subscriber that had nothing to do with it.
  it('does nothing on a second release', () => {
    loadProjectPages(twoPages());
    const seen = [];
    const offA = setPageSwitchHook(() => seen.push('a'));
    const offB = setPageSwitchHook(() => seen.push('b'));
    try {
      offA();
      offA();
      gotoPage(1);
      expect(seen).toEqual(['b']);
    } finally {
      offB();
    }
  });

  // A blunt teardown, and the only caller left is a test suite: every
  // registration in src/ holds its unsubscribe and calls that instead. Kept
  // because the suites lean on it to stop a hook registered for one case leaking
  // into the next, and pinned here because the behaviour is a hazard worth
  // knowing about - `setSaver(null)` unhooks every autosave in the app.
  it('clears the seam outright when handed something that is not a function', () => {
    loadProjectPages(twoPages());
    const seen = [];
    setPageSwitchHook(() => seen.push('a'));
    setPageSwitchHook(() => seen.push('b'));
    setPageSwitchHook(null);
    gotoPage(1);
    expect(seen).toEqual([]);
  });

  it('runs every settle subscriber before the page turns', () => {
    loadProjectPages(twoPages());
    const seen = [];
    const offA = setEditSettleHook(() => seen.push(['a', page().id]));
    const offB = setEditSettleHook(() => seen.push(['b', page().id]));
    try {
      gotoPage(1);
      expect(seen).toEqual([
        ['a', 1],
        ['b', 1],
      ]);
    } finally {
      offA();
      offB();
    }
  });
});

// Pre-existing: the page turn ran `clearPending`, which threw the in-flight
// gesture away rather than settling it - so the record standing for what the
// user had just typed was never written, and turning the page mid-edit cost them
// an undo step. The ordering is the load-bearing half: the record has to be
// pushed while the page being left still owns the live stack, a step ahead of
// the switch hook handing that stack to the history file.
describe('a page turn ends the inline edit it interrupts', () => {
  const twoPages = (boxes = []) => [
    { ...pageWith(boxes), id: 1 },
    { ...pageWith([]), id: 2 },
  ];

  it('records the free-typed box before the switch hook fires', () => {
    loadProjectPages(twoPages());
    const log = [];
    const offRec = setRecorder((e) => log.push(['record', e.t, e.pageId]));
    const offSwitch = setPageSwitchHook((from, to) => log.push(['switch', from, to]));
    try {
      const id = addEmptyBox(100, 100);
      byId(id).text = 'typed';
      gotoPage(1);
      expect(log).toEqual([
        ['record', 'place', 1],
        ['switch', 1, 2],
      ]);
    } finally {
      offRec();
      offSwitch();
    }
  });

  it('records an edit to a box that was already there the same way', () => {
    loadProjectPages(twoPages([box('b1')]));
    const log = [];
    const offRec = setRecorder((e) => log.push(['record', e.t, e.before, e.after]));
    const offSwitch = setPageSwitchHook(() => log.push(['switch']));
    try {
      beginEdit('b1');
      byId('b1').text = 'changed';
      gotoPage(1);
      expect(log).toEqual([['record', 'text', 'x', 'changed'], ['switch']]);
    } finally {
      offRec();
      offSwitch();
    }
  });

  // Nothing is left pending on the page behind: a second turn must not write the
  // same entry again, and the box must not still look like a gesture in progress
  // - that is what used to suppress the record of its own deletion.
  it('leaves nothing behind to settle a second time', () => {
    loadProjectPages(twoPages());
    const log = [];
    const off = setRecorder((e) => log.push(e.t));
    try {
      const id = addEmptyBox(100, 100);
      byId(id).text = 'typed';
      gotoPage(1);
      gotoPage(0);
      gotoPage(1);
      expect(log).toEqual(['place']);
      expect(app.editingId).toBe(null);
    } finally {
      off();
    }
  });
});

// `settleText` used to clear the before-text on the way in, which made a second
// settle record nothing - by forgetting rather than by having nothing left to
// say. Any caller that settled while the session continued then disabled
// recording for the rest of it, because `endEdit`'s guard is
// `before !== undefined`. The live path was a failed save on the way out of the
// editor: it throws instead of closing the chapter, so the user is bounced back
// in with the caret still open and the before-text gone, and nothing they type
// afterwards is ever recorded.
describe('a settle in the middle of a live edit session', () => {
  const onePage = () => [{ ...pageWith([box('b1')]), id: 1 }];

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(onePage());
  });

  it('records what came before it and what comes after it', () => {
    const log = [];
    const off = setRecorder((e) => log.push([e.before, e.after]));
    try {
      beginEdit('b1');
      byId('b1').text = 'xa';
      settleEdits();
      byId('b1').text = 'xab';
      endEdit('xab');
      expect(log).toEqual([
        ['x', 'xa'],
        ['xa', 'xab'],
      ]);
    } finally {
      off();
    }
  });

  // Re-arming must not cost the idempotence the clearing bought: settling twice
  // with nothing typed in between is still one entry, not two, and not an entry
  // whose two sides are the same string.
  it('is still idempotent when nothing was typed in between', () => {
    const log = [];
    const off = setRecorder((e) => log.push([e.before, e.after]));
    try {
      beginEdit('b1');
      byId('b1').text = 'xa';
      settleEdits();
      settleEdits();
      settleEdits();
      endEdit('xa');
      expect(log).toEqual([['x', 'xa']]);
    } finally {
      off();
    }
  });

  // Three settles, three runs of typing, three entries - each one starting where
  // the last left off, with no gap and no overlap.
  it('leaves no gap between one settled run and the next', () => {
    const log = [];
    const off = setRecorder((e) => log.push([e.before, e.after]));
    try {
      beginEdit('b1');
      byId('b1').text = 'xa';
      settleEdits();
      byId('b1').text = 'xab';
      settleEdits();
      byId('b1').text = 'xabc';
      settleEdits();
      expect(log).toEqual([
        ['x', 'xa'],
        ['xa', 'xab'],
        ['xab', 'xabc'],
      ]);
    } finally {
      off();
    }
  });

  // Only the absence of a session clears it. A settle with no edit open must not
  // leave something armed that a later `endEdit` would record against.
  it('arms nothing when there is no edit open', () => {
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      settleEdits();
      byId('b1').text = 'zz';
      endEdit('zz');
      expect(log).toEqual([]);
    } finally {
      off();
    }
  });

  // The order the two halves of a settle run in, which nothing pinned before: a
  // panel's pending entry has been sitting in its settle window while the box on
  // the canvas was still being typed into, so it is the older of the two and has
  // to be recorded first. Flip the two lines in `settleEdits` and this fails.
  it('records a subscriber’s pending entry before its own inline edit', () => {
    const log = [];
    const offRec = setRecorder((e) => log.push(e.t));
    const offHook = setEditSettleHook(() =>
      recordEdit({ t: 'style', pageId: page().id, boxId: 'b1', before: {}, after: {} }),
    );
    try {
      beginEdit('b1');
      byId('b1').text = 'changed';
      settleEdits();
      expect(log).toEqual(['style', 'text']);
    } finally {
      offRec();
      offHook();
    }
  });
});

// Four writers used to carry four intervals, each picked on its own. Two tiers
// now, and the cases below pin each writer to the *duration* its tier names:
// spell `PREF_SAVE_MS` differently and every case here moves with it.
//
// What they cannot see, and it is worth being straight about since the comment
// here used to claim otherwise: `PREF_SAVE_MS - 1` is 199 by the time the test
// runs, so a writer that quietly went back to a hard-coded 200 passes. Nothing
// short of reading the source can tell those apart. What is actually pinned is
// that the two tiers stay ordered, and that each writer fires on the number its
// tier holds today - so changing that number cannot silently leave one writer
// behind on the old one.
describe('the persistence intervals', () => {
  it('keeps a preference well ahead of a document write', () => {
    expect(PREF_SAVE_MS).toBeLessThan(DOC_SAVE_MS);
  });

  // Async because the savers are started off a resolved promise, so that one
  // that throws synchronously still comes back as a rejection: the call lands a
  // microtask after the timer, not inside it.
  it('debounces the chapter autosave on the document interval', async () => {
    vi.useFakeTimers();
    app.chapterRef = { projectId: 'p1', chapterId: 'c1' };
    let saves = 0;
    const off = setSaver(() => {
      saves++;
      return Promise.resolve();
    });
    try {
      markUnsaved();
      await vi.advanceTimersByTimeAsync(DOC_SAVE_MS - 1);
      expect(saves).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(saves).toBe(1);
    } finally {
      off();
      app.chapterRef = null;
      vi.useRealTimers();
    }
  });

  // Every path that writes the document ends by saying so, and the debounce
  // armed before it is still counting down towards a write of a document that
  // is already on disk. Harmless-looking, and not: on the way out of a chapter
  // the late write is aimed at whatever `app.chapterRef` has become by the time
  // it fires.
  it('cancels the pending autosave once the document has reached the disk', async () => {
    vi.useFakeTimers();
    app.chapterRef = { projectId: 'p1', chapterId: 'c1' };
    let saves = 0;
    const off = setSaver(() => {
      saves++;
      return Promise.resolve();
    });
    try {
      markUnsaved();
      await vi.advanceTimersByTimeAsync(DOC_SAVE_MS - 1);
      markSaved();
      await vi.advanceTimersByTimeAsync(DOC_SAVE_MS * 2);
      expect(saves).toBe(0);
    } finally {
      off();
      app.chapterRef = null;
      vi.useRealTimers();
    }
  });

  // The rail's arrow-key contract persists on every key that moved the edge, and
  // a held arrow auto-repeats. Unbuffered that was dozens of serialisations a
  // second for a string nobody reads until the next launch.
  it('coalesces a burst of sidebar writes into one, on the preference interval', () => {
    vi.useFakeTimers();
    let writes = 0;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => writes++ });
    try {
      saveSidebar();
      saveSidebar();
      saveSidebar();
      vi.advanceTimersByTime(PREF_SAVE_MS - 1);
      expect(writes).toBe(0);
      vi.advanceTimersByTime(1);
      expect(writes).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

// The read itself runs once at module load, in an environment with no
// `localStorage` at all - so the tests take the vetting the read delegates to,
// which is where anything can actually be wrong.
describe('sidebar geometry persistence', () => {
  it('clamps a width to the range the rail can drag to', () => {
    expect(clampSidebarWidth(SIDEBAR_MIN - 500)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(SIDEBAR_MAX + 500)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(320)).toBe(320);
  });

  it('lets the rail reach two fifths of a wide window, and never less than the old ceiling', () => {
    // A 3000px window: 40% of it, which is well past the flat 460 the rail used
    // to stop at.
    expect(sidebarMaxWidth(3000)).toBe(1200);
    expect(clampSidebarWidth(1000, 3000)).toBe(1000);
    expect(clampSidebarWidth(9999, 3000)).toBe(1200);
    // A narrow window keeps the old ceiling rather than shrinking below it: 40%
    // of 800 is 320, and a sidebar that could no longer reach 460 would be a
    // regression for anyone on a laptop.
    expect(sidebarMaxWidth(800)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(460, 800)).toBe(460);
    // The share is what the ceiling is made of, so the two agree by arithmetic
    // rather than by a number written twice.
    expect(sidebarMaxWidth(3000)).toBe(Math.round(3000 * SIDEBAR_MAX_SHARE));
    // No window to measure - the node tests, a module load before layout - and
    // the old ceiling stands.
    expect(sidebarMaxWidth(undefined)).toBe(SIDEBAR_MAX);
    expect(clampSidebarWidth(SIDEBAR_MIN - 500, 3000)).toBe(SIDEBAR_MIN);
  });

  it('clamps a stored width the same way a dragged one is clamped', () => {
    expect(sidebarFromJSON('{"width":9999}')).toEqual({ width: SIDEBAR_MAX });
    expect(sidebarFromJSON('{"width":10}')).toEqual({ width: SIDEBAR_MIN });
    expect(sidebarFromJSON('{"width":300}')).toEqual({ width: 300 });
  });

  it('drops a width that is not a number rather than coercing it', () => {
    expect(sidebarFromJSON('{"width":"300"}')).toEqual({});
    expect(sidebarFromJSON('{"width":null}')).toEqual({});
  });

  it('drops a hidden flag that is not a boolean', () => {
    expect(sidebarFromJSON('{"hidden":"yes"}')).toEqual({});
    expect(sidebarFromJSON('{"hidden":true}')).toEqual({ hidden: true });
    expect(sidebarFromJSON('{"hidden":false}')).toEqual({ hidden: false });
  });

  it('reads nothing out of a blob that is not an object', () => {
    expect(sidebarFromJSON('not json')).toEqual({});
    expect(sidebarFromJSON('null')).toEqual({});
    expect(sidebarFromJSON('[1,2]')).toEqual({});
    expect(sidebarFromJSON('')).toEqual({});
    expect(sidebarFromJSON(null)).toEqual({});
  });

  // Debounced now, so the write happens on the timer rather than in the call -
  // the environment with no storage at all has to survive both halves.
  it('saves without a storage to save to', () => {
    vi.useFakeTimers();
    try {
      expect(() => saveSidebar()).not.toThrow();
      expect(() => vi.advanceTimersByTime(PREF_SAVE_MS)).not.toThrow();
      expect(() => flushSidebar()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  // The debounce opened a window the synchronous write never had: ⌘Q destroys
  // the window, and the last drag of the rail was still on a 200ms timer. The
  // document and its history are drained on every route out; this is the same
  // obligation one tier down.
  describe('the flush on the way out', () => {
    const withStorage = (fn) => {
      const writes = [];
      const had = 'localStorage' in globalThis;
      const prev = globalThis.localStorage;
      globalThis.localStorage = { getItem: () => null, setItem: (k, v) => writes.push([k, v]) };
      const width = app.leftWidth;
      vi.useFakeTimers();
      try {
        fn(writes);
      } finally {
        vi.useRealTimers();
        app.leftWidth = width;
        if (had) globalThis.localStorage = prev;
        else delete globalThis.localStorage;
      }
    };

    it('writes what the timer was still holding', () => {
      withStorage((writes) => {
        app.leftWidth = 321;
        saveSidebar();
        expect(writes).toEqual([]); // still inside the window
        flushSidebar();
        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0][1]).width).toBe(321);
        // And the timer went with it, rather than firing again behind the flush.
        vi.advanceTimersByTime(PREF_SAVE_MS * 2);
        expect(writes).toHaveLength(1);
      });
    });

    it('writes nothing when nothing was pending', () => {
      withStorage((writes) => {
        flushSidebar();
        expect(writes).toEqual([]);
      });
    });
  });
});

// There is no manual save in this app, so the indicator is the user's only
// standing signal that their work is not reaching the disk. The debounce is not
// the risky path: `flushSave` is, because it runs on the way out - leaving the
// editor, quitting, opening another chapter - and it cancels the debounce as it
// goes, so a rejection here leaves nothing scheduled to raise the flag later.
describe('the save indicator on the flush path', () => {
  beforeEach(() => {
    app.chapterRef = { projectId: 'p1', chapterId: 'c1' };
    app.saveFailed = false;
  });
  afterEach(() => {
    setSaver(null);
    app.chapterRef = null;
    app.saveFailed = false;
  });

  it('raises the failed state when the flush is rejected', async () => {
    setSaver(() => Promise.reject(new Error('disk full')));
    await expect(flushSave()).rejects.toThrow('disk full');
    expect(app.saveFailed).toBe(true);
  });

  // Load-bearing: flushBeforeLeaving reads the rejection to decide whether the
  // user may leave and what to tell them. Swallowing it here to set a flag
  // would let them walk out of a chapter that was never written.
  it('still hands the rejection to its caller', async () => {
    const err = new Error('read-only volume');
    setSaver(() => Promise.reject(err));
    await expect(flushSave()).rejects.toBe(err);
  });

  it('leaves the failed state alone when the flush lands', async () => {
    setSaver(() => Promise.resolve());
    await flushSave();
    expect(app.saveFailed).toBe(false);
  });

  // No chapter open is not a failed save - there was nothing to write.
  it('does not raise the failed state when there is nothing to flush', async () => {
    setSaver(() => Promise.reject(new Error('never called')));
    app.chapterRef = null;
    await flushSave();
    expect(app.saveFailed).toBe(false);
  });
});

// The rail hands `setTool` a string and the canvas branches on it. A tool the
// canvas has no branch for is not a harmless no-op: every press on the page
// falls through to `deselect`, and nothing on screen says why.
describe('the tool enum', () => {
  afterEach(() => {
    setPref('brushTool', false);
    setTool('place');
  });

  it('takes each tool the canvas answers to', () => {
    setPref('brushTool', true);
    for (const t of TOOLS) {
      setTool(t);
      expect(app.tool).toBe(t);
    }
  });

  it('carries the hand', () => {
    expect(TOOLS).toContain('pan');
  });

  it('refuses a tool nothing implements, leaving the last one in place', () => {
    setTool('text');
    setTool('bulk'); // the mode that used to live on the rail
    setTool(undefined);
    expect(app.tool).toBe('text');
  });

  it('refuses the brush tool when the brushTool preference is off', () => {
    setPref('brushTool', false);
    setTool('text');
    setTool('brush');
    expect(app.tool).toBe('text');
  });

  it('falls back to pan when the brushTool preference is switched off while armed', () => {
    setPref('brushTool', true);
    setTool('brush');
    expect(app.tool).toBe('brush');
    setPref('brushTool', false);
    expect(app.tool).toBe('pan');
  });
});

// The percentage in the dock is `zoom * 100`, so every one of these is a number
// the user reads off the screen.
describe('zoom', () => {
  afterEach(() => setZoom(1));

  it('clamps to the range the dock can display', () => {
    setZoom(99);
    expect(app.zoom).toBe(ZOOM_MAX);
    setZoom(0.0001);
    expect(app.zoom).toBe(ZOOM_MIN);
  });

  // `isFit` is what tells the canvas to re-fit on a resize and lights the Fit
  // button. Only a fit sets it; a step off one has left it.
  it('holds the fit flag only until the zoom is stepped', () => {
    applyFit(0.43);
    expect(app.zoom).toBeCloseTo(0.43);
    expect(app.isFit).toBe(true);
    zoomIn();
    expect(app.isFit).toBe(false);
  });

  it('steps up from an arbitrary fit onto the next named stop', () => {
    applyFit(0.43);
    zoomIn();
    expect(app.zoom).toBe(0.5); // the half size the user asked for, exactly
    zoomIn();
    expect(app.zoom).toBe(0.67);
  });

  it('steps down onto the stop below, not back onto the one it is on', () => {
    setZoom(0.5);
    zoomOut();
    expect(app.zoom).toBe(0.33);
  });

  // Walking the ladder from either end must not stall or skip: these are the
  // only two buttons that move the zoom by hand.
  // Walking from either end must visit every stop once and then hold: a step
  // that skipped one, or that stalled short of the end, is a button the user
  // presses again with nothing happening.
  it('walks the whole ladder and holds at the ends', () => {
    setZoom(ZOOM_MIN);
    const up = [];
    for (let i = 1; i < ZOOM_STOPS.length; i++) {
      zoomIn();
      up.push(app.zoom);
    }
    expect(up).toEqual(ZOOM_STOPS.slice(1));
    zoomIn();
    expect(app.zoom).toBe(ZOOM_MAX);

    const down = [];
    for (let i = ZOOM_STOPS.length - 2; i >= 0; i--) {
      zoomOut();
      down.push(app.zoom);
    }
    expect(down).toEqual(ZOOM_STOPS.slice(0, -1).reverse());
    zoomOut();
    expect(app.zoom).toBe(ZOOM_MIN);
  });

  // The wheel multiplies the zoom by a continuous exponential, so before this
  // every event of a hundred-event trackpad pinch wrote a distinct float - and
  // `app.zoom` is read by every mounted box, each of which rebuilds its whole
  // paint stack on the change. The fit had been quantised for exactly this
  // reason; the wheel had not.
  it('quantises to a thousandth however the zoom arrived', () => {
    setZoom(0.4285714285714286);
    expect(app.zoom).toBe(0.429);
    applyFit(1 / 3);
    expect(app.zoom).toBe(0.333);
  });

  it('writes nothing at all for a change below the quantum', () => {
    setZoom(0.5);
    // One wheel event's worth of a slow pinch: a change no display can show.
    setZoom(0.5 * Math.exp(-0.0001));
    expect(app.zoom).toBe(0.5);
  });

  it('leaves the named stops exactly where they are', () => {
    for (const z of ZOOM_STOPS) {
      setZoom(z);
      expect(app.zoom).toBe(z);
    }
  });

  it('resets to exactly one page pixel per screen pixel', () => {
    setZoom(0.37);
    zoomReset();
    expect(app.zoom).toBe(1);
    expect(app.isFit).toBe(false);
  });
});

// A bulk edit used to land the whole template on every target, so a user who
// wanted the colour changed got the font, the size and the shadow with it. The
// mask is what they choose instead; everything below is what "unticked leaves
// the box alone" has to mean for that to be true.
// Every style in every chapter on disk was written against the old model - one
// outline colour, one width, one shadow with an on switch - and there is exactly
// one place that still knows those fields existed. What it has to guarantee is
// that a document saved by the old build opens looking the same.
describe('the style schema migration', () => {
  it('turns an outline and its width into the first stroke', () => {
    const s = normalizeStyle({ outline: '#ff0000', outlineWidth: 5 });
    expect(s.strokes).toEqual([{ color: '#ff0000', width: 5, opacity: 1 }]);
    expect('outline' in s).toBe(false);
    expect('outlineWidth' in s).toBe(false);
  });

  it('reads a width of zero as no stroke at all', () => {
    expect(normalizeStyle({ outline: '#ff0000', outlineWidth: 0 }).strokes).toEqual([]);
  });

  it('turns a shadow that was on into the shadow list, and one that was off into none', () => {
    const on = normalizeStyle({ shadow: { on: true, x: 3, y: 4, blur: 5, color: '#010203', opacity: 0.4 } });
    expect(on.shadows).toEqual([{ x: 3, y: 4, blur: 5, color: '#010203', opacity: 0.4 }]);
    expect(normalizeStyle({ shadow: { on: false, x: 3, y: 4 } }).shadows).toEqual([]);
    expect('shadow' in on).toBe(false);
  });

  it('leaves a style already written in the new model as it stands', () => {
    const strokes = [
      { color: '#ffffff', width: 3, opacity: 1 },
      { color: '#000000', width: 2, opacity: 0.5 },
    ];
    expect(normalizeStyle({ strokes, shadows: [] }).strokes).toEqual(strokes);
  });

  // Per-stop alpha and a variable stop count arrived after chapters were
  // already saved with two opaque stops, so what an old gradient normalises to
  // has to be the gradient it was painting - same colours, same ends, alpha 1.
  it('gives an old two-stop gradient its positions and an opacity of 1', () => {
    const g = normalizeStyle({
      gradient: { on: true, angle: 90, stops: [{ color: '#ffffff', pos: 0 }, { color: '#000000', pos: 1 }] },
    }).gradient;
    expect(g.stops).toEqual([
      { color: '#ffffff', pos: 0, opacity: 1 },
      { color: '#000000', pos: 1, opacity: 1 },
    ]);
  });

  it('sorts stops by position and clamps both position and opacity', () => {
    const g = normalizeStyle({
      gradient: {
        stops: [
          { color: '#111111', pos: 2, opacity: 5 },
          { color: '#222222', pos: -1, opacity: -1 },
          { color: '#333333', pos: 0.5, opacity: 0.25 },
        ],
      },
    }).gradient;
    expect(g.stops).toEqual([
      { color: '#222222', pos: 0, opacity: 0 },
      { color: '#333333', pos: 0.5, opacity: 0.25 },
      { color: '#111111', pos: 1, opacity: 1 },
    ]);
  });

  it('keeps a gradient inside the two-to-eight stops the panel can draw', () => {
    // One stop is a fill, not a gradient, so the defaults stand.
    expect(normalizeStyle({ gradient: { stops: [{ color: '#ffffff', pos: 0 }] } }).gradient.stops).toEqual(
      defaultStyle().gradient.stops,
    );
    const many = Array.from({ length: 12 }, (_, i) => ({ color: '#000000', pos: i / 11 }));
    expect(normalizeStyle({ gradient: { stops: many } }).gradient.stops).toHaveLength(GRADIENT_MAX_STOPS);
  });

  it('gives a style that names neither the defaults', () => {
    const s = normalizeStyle({ size: 30 });
    expect(s.strokes).toEqual(defaultStyle().strokes);
    expect(s.shadows).toEqual([]);
    expect('fillOpacity' in s).toBe(false);
    expect(s.blur).toBe(0);
    expect(s.gradient.on).toBe(false);
    expect(s.pattern.on).toBe(false);
  });

  // Unknown flat keys used to ride the spread forever - every clone and save
  // round-tripping junk a future or hand-edited schema left behind.
  it('drops keys the schema never had', () => {
    const s = normalizeStyle({ size: 30, colour: '#ff0000', legacyJunk: { x: 1 } });
    expect(s.size).toBe(30);
    expect('colour' in s).toBe(false);
    expect('legacyJunk' in s).toBe(false);
    expect([...Object.keys(s)].sort()).toEqual([...Object.keys(defaultStyle())].sort());
  });

  // Exactly the lengths CSS reads as hex. A 5- or 7-digit string is a typo mid
  // edit, not a colour, and storing it would hand both renderers a value neither
  // can paint.
  it('refuses a colour that is not 3, 4, 6 or 8 hex digits', () => {
    for (const bad of ['#12345', '#1234567', '#123456789', '123456']) {
      expect(normalizeStyle({ strokes: [{ color: bad, width: 3 }] }).strokes[0].color, bad).toBe(
        '#ffffff',
      );
      expect(normalizeStyle({ shadows: [{ color: bad }] }).shadows[0].color, bad).toBe('#000000');
    }
    for (const good of ['#abc', '#abcd', '#abcdef', '#abcdef01', '#ABCDEF']) {
      // Case rides through untouched; only the digit count is vetted.
      expect(normalizeStyle({ strokes: [{ color: good, width: 3 }] }).strokes[0].color, good).toBe(
        good,
      );
    }
  });
});

// One value per bulk property, every one of them different from what
// `defaultStyle` hands out, so "it arrived" and "it was already there" can never
// be the same answer. The panel writes into `app.bulk.style` by exactly these
// paths, so this doubles as the list of things its rows are allowed to say.
const BULK_VALUES = () => ({
  font: 'Bangers',
  size: 44,
  bold: false,
  italic: true,
  uppercase: true,
  align: 'left',
  valign: 'top',
  lineHeight: 1.8,
  letterSpacing: 3,
  color: '#123456',
  opacity: 0.33,
  // Three stops rather than the default two, and one of them part-transparent:
  // a bulk edit moves the WHOLE gradient, so a stop list of a different length
  // than the target box already has is the case that has to survive the merge.
  // The variant is radial and off-centre with a radius the defaults do not use,
  // because kind/cx/cy/radius ride the same whole-leaf copy as angle and scope
  // - a sweep of only the linear fields would let a template silently overwrite
  // every target's radial shape with the seed's.
  gradient: {
    ...defaultStyle().gradient,
    on: true,
    kind: 'radial',
    angle: 90,
    cx: 0.25,
    cy: 0.75,
    radius: 1.5,
    scope: 'line',
    stops: [
      { color: '#ff0000', pos: 0, opacity: 1 },
      { color: '#00ff00', pos: 0.35, opacity: 0.5 },
      { color: '#0000ff', pos: 1, opacity: 1 },
    ],
  },
  pattern: { ...defaultStyle().pattern, on: true, kind: 'stripes', fg: '#010101', bg: '#020202', scale: 2 },
  strokes: [{ color: '#abcdef', width: 9, opacity: 0.5 }],
  shadows: [{ x: 5, y: 6, blur: 7, color: '#0f0f0f', opacity: 0.8 }],
  blur: 7,
  motionBlur: { on: true, x: 3, y: -1, amount: 8 },
  clip: { on: true, mode: 'include', brushSize: 30, shapes: [{ kind: 'ellipse', cx: 10, cy: 10, rx: 5, ry: 5 }] },
  circle: { on: true, angle: 90, inside: true },
  curve: 33,
  'roughen.on': true,
  'roughen.amount': 11,
  'roughen.detail': 0.11,
  'roughen.seed': 42,
  shape: 'off',
  minOrphan: 6,
  hyphenate: false,
  balloon: false,
  autoHeight: false,
  rotation: 25,
  flipH: true,
  flipV: true,
});
// The panel's own two accessors, by the same paths it uses.
const readPath = (o, key) => {
  const dot = key.indexOf('.');
  return dot === -1 ? o[key] : o[key.slice(0, dot)][key.slice(dot + 1)];
};
const writePath = (o, key, v) => {
  const dot = key.indexOf('.');
  if (dot === -1) o[key] = v;
  else o[key.slice(0, dot)][key.slice(dot + 1)] = v;
};

describe('the bulk edit mask', () => {
  const styled = (id, lineN) => ({ id, lineN, text: null, x: 0, y: 0, w: 10, h: 10 });
  // `sfx` rather than a registry entry: `lineTags` reads a legacy `line.type` as
  // a tag, so these lines are tagged without this file needing localStorage.
  const chapter = () => [
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [
        { n: 1, type: 'sfx', en: 'a' },
        { n: 2, type: 'dialogue', en: 'b' },
      ],
      boxes: [styled('b1', 1), styled('b2', 2), styled('b3', null)],
    },
    { id: 2, w: 800, h: 1200, lines: [{ n: 1, type: 'sfx', en: 'c' }], boxes: [styled('b4', 1)] },
  ];
  const boxOf = (id) => app.pages.flatMap((p) => p.boxes).find((b) => b.id === id);

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(chapter());
    // The style a new box inherits is a module global that a previous apply may
    // have moved; every case here reads it back, so it starts from the default.
    app.lastStyle = defaultStyle();
    openBulk();
  });
  afterEach(() => closeBulk());

  // The panel's rows are laid out against this list, so a property missing from
  // it is a property with no tick box and no way into a bulk edit. Pinning it to
  // the style's own leaves is what makes "every Inspector text option" a fact
  // rather than a claim: a field added to `defaultStyle` and forgotten here
  // fails this. Geometry cannot appear because x/y/w/h live on the box, not the
  // style - which is also why they stay the Inspector's.
  it('covers every leaf of the style, and nothing that is not one', () => {
    // `gradient`, `pattern`, `strokes`, `shadows`, `motionBlur`, `clip` and
    // `circle` are leaves in their own right - a bulk edit moves a whole
    // gradient, smear or stroke list, never one field of one stroke. `path`,
    // `ink` and `warp` are box-local geometry - drawn against this box, by
    // hand, in this box's own px - so they stay the Inspector's along with
    // x/y/w/h. Every other group is still one row per field.
    const WHOLE = new Set(BULK_WHOLE_LEAVES);
    const leaves = Object.entries(defaultStyle())
      .filter(([k]) => k !== 'path' && k !== 'ink' && k !== 'warp')
      .flatMap(([k, v]) =>
        v && typeof v === 'object' && !WHOLE.has(k) ? Object.keys(v).map((f) => `${k}.${f}`) : [k],
      );
    expect([...BULK_PROPS].sort()).toEqual(leaves.sort());
    for (const geom of ['x', 'y', 'w', 'h', 'path', 'ink', 'warp']) {
      expect(BULK_PROPS).not.toContain(geom);
    }
  });

  // The panel's tick-all headers are laid out against GROUPS, which lives in
  // the store beside BULK_PROPS precisely so this can hold: a key in a group
  // that is not a bulk property would be a header ticking nothing, and a bulk
  // property missing from every group would be one no header could tick. Both
  // fail here rather than silently.
  it('has panel groups that cover every bulk property exactly once', () => {
    const seen = [];
    for (const keys of Object.values(GROUPS)) seen.push(...keys);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(BULK_PROPS));
  });

  it('opens with nothing ticked', () => {
    expect(app.bulk.mask).toEqual({});
    expect(bulkTicked()).toEqual([]);
  });

  it('ticks and unticks by path, in the panel’s own order', () => {
    tickBulkProp('roughen.amount');
    tickBulkProp('color');
    expect(bulkTicked()).toEqual(['color', 'roughen.amount']);
    setBulkProp('color', false);
    expect(bulkTicked()).toEqual(['roughen.amount']);
  });

  // A path that is not a property would sit in the mask forever, counted as a
  // tick by the footer and moved by nothing.
  it('refuses a key that is not a bulk property', () => {
    setBulkProp('x', true);
    setBulkProp('roughen', true);
    setBulkProp('nonsense', true);
    expect(bulkTicked()).toEqual([]);
  });

  it('moves only the ticked properties, nested ones included', () => {
    const base = { ...defaultStyle(), color: '#111111', size: 40 };
    base.roughen = { ...base.roughen, amount: 1, seed: 3 };
    const tpl = { ...defaultStyle(), color: '#ff0000', size: 99 };
    tpl.roughen = { ...tpl.roughen, amount: 12, seed: 40 };
    const out = mergeMasked(base, tpl, { color: true, 'roughen.amount': true });
    expect(out.color).toBe('#ff0000');
    expect(out.roughen.amount).toBe(12);
    expect(out.size).toBe(40);
    expect(out.roughen.seed).toBe(3);
  });

  // A stroke list is moved whole or not at all, and the copy the target box gets
  // is its own: two boxes sharing one array would edit each other's outlines.
  it('moves a whole stroke list, and hands over a copy of it', () => {
    const base = defaultStyle();
    const tpl = {
      ...defaultStyle(),
      strokes: [
        { color: '#ff0000', width: 2, opacity: 1 },
        { color: '#00ff00', width: 4, opacity: 1 },
      ],
    };
    const out = mergeMasked(base, tpl, { strokes: true });
    expect(out.strokes).toEqual(tpl.strokes);
    expect(out.strokes).not.toBe(tpl.strokes);
    expect(out.strokes[0]).not.toBe(tpl.strokes[0]);
  });

  it('changes nothing at all with an empty mask', () => {
    const base = { ...defaultStyle(), color: '#111111' };
    expect(mergeMasked(base, { ...defaultStyle(), color: '#ff0000' }, {})).toEqual(base);
  });

  // The result is assigned onto a box. Sharing the nested groups with the style
  // it was merged from would tie two boxes' shadows together.
  it('never hands back the base style’s own nested objects', () => {
    const base = defaultStyle();
    const out = mergeMasked(base, defaultStyle(), { 'roughen.amount': true });
    expect(out.gradient).not.toBe(base.gradient);
    expect(out.roughen).not.toBe(base.roughen);
    expect(out.strokes).not.toBe(base.strokes);
  });

  // A template that has no opinion about a ticked field - a group missing the
  // field, or holding it as undefined - must not erase the base's value with
  // one. Writing undefined was reachable through `normalizeStyle`'s group
  // spreads, which let an explicit `undefined` through where absence would have
  // kept the default.
  it('skips a ticked field the template holds as undefined', () => {
    const base = defaultStyle();
    // An explicit `undefined` survives normalisation - the group spread writes
    // it over the default - so it reaches the merge as a value that is not one.
    const out = mergeMasked(
      base,
      { font: 'Bangers', roughen: { amount: undefined } },
      { font: true, color: true, 'roughen.amount': true },
    );
    expect(out.font).toBe('Bangers');
    expect(out.color).toBe(base.color);
    expect(out.roughen.amount).toBe(base.roughen.amount);
  });

  // The in-place half the bulk apply drives - one template clone for the whole
  // batch, many bases - and the same rule for a field the template's group
  // lacks entirely (only reachable with a raw template, since `mergeMasked`
  // normalises its own).
  it('merges into a base the caller owns, without aliasing or erasing', () => {
    const tpl = { font: 'Bangers', roughen: { amount: 12 } };
    const base = defaultStyle();
    base.roughen = { ...base.roughen, seed: 99 };
    const out = mergeMaskedInto(cloneStyle(base), tpl, {
      font: true,
      'roughen.amount': true,
      'roughen.seed': true,
    });
    expect(out.font).toBe('Bangers');
    expect(out.roughen.amount).toBe(12);
    expect(out.roughen.seed).toBe(99);
    out.strokes[0].color = '#000000';
    expect(base.strokes[0].color).not.toBe('#000000');
  });

  it('leaves the unticked properties of a clicked target alone', () => {
    boxOf('b1').style.size = 40;
    toggleBulkTarget('b1');
    app.bulk.style.color = '#00ff00';
    app.bulk.style.size = 12;
    setBulkProp('color', true);
    applyBulk();
    expect(boxOf('b1').style.color).toBe('#00ff00');
    expect(boxOf('b1').style.size).toBe(40);
  });

  // Every case above moves the colour, which is one flat string out of thirty
  // properties. A key that survives that and nothing else - a whole-value leaf
  // the merge copies by reference and `normalizeStyle` then drops, a nested path
  // the merge writes to the wrong group, a property the panel ticks under a name
  // the mask does not know - is a row in the panel that silently does nothing,
  // and "the bulk panel is broken, my changes never arrive" is what that looks
  // like from the outside. So every property is driven the whole way: written
  // into the template the way the panel writes it, ticked the way the panel
  // ticks it, applied, and read back off the box.
  //
  // `BULK_VALUES` has to name all of them, which is what keeps a leaf added to
  // `defaultStyle` (and to `BULK_PROPS`) from arriving here untested.
  it('names a value for every bulk property', () => {
    expect(Object.keys(BULK_VALUES()).sort()).toEqual([...BULK_PROPS].sort());
  });

  it('carries every one of its properties onto a clicked target', () => {
    const values = BULK_VALUES();
    for (const key of BULK_PROPS) {
      loadProjectPages(chapter());
      app.lastStyle = defaultStyle();
      openBulk();
      writePath(app.bulk.style, key, values[key]);
      tickBulkProp(key);
      toggleBulkTarget('b1');
      toggleBulkTarget('b2');
      // Read off the normalised template rather than off `values`: the merge
      // hands over `cloneStyle(template)`, so a group that gained a field since
      // this list was written is still compared against what was actually sent.
      const want = readPath(cloneStyle(app.bulk.style), key);
      applyBulk();
      for (const id of ['b1', 'b2']) {
        expect(readPath(boxOf(id).style, key), `${key} on ${id}`).toEqual(want);
      }
      // The point of the case: the value moved, rather than having been the
      // default all along.
      expect(readPath(boxOf('b1').style, key), `${key} is still the default`).not.toEqual(
        readPath(defaultStyle(), key),
      );
    }
  });

  // The sweep's template is radial (see BULK_VALUES), so the linear-only
  // fields - kind, angle - need a case of their own: a bulk gradient edit has
  // to be able to say "linear" just as roundly as it says "radial", or every
  // apply would push radial onto targets that were linear by intent.
  it('carries a whole linear gradient - kind, angle and stop list together', () => {
    loadProjectPages(chapter());
    app.lastStyle = defaultStyle();
    openBulk();
    Object.assign(app.bulk.style.gradient, { on: true, kind: 'linear', angle: 90, scope: 'line' });
    app.bulk.style.gradient.stops = [
      { color: '#ff0000', pos: 0, opacity: 1 },
      { color: '#00ff00', pos: 0.5, opacity: 0.5 },
      { color: '#0000ff', pos: 1, opacity: 1 },
    ];
    tickBulkProp('gradient');
    toggleBulkTarget('b1');
    toggleBulkTarget('b2');
    applyBulk();
    for (const id of ['b1', 'b2']) {
      const g = boxOf(id).style.gradient;
      expect(g.kind).toBe('linear');
      expect(g.angle).toBe(90);
      expect(g.scope).toBe('line');
      expect(g.stops.map((st) => st.color)).toEqual(['#ff0000', '#00ff00', '#0000ff']);
    }
  });

  // The template is what lands on targets; the seed it was cloned from keeps
  // its own shape. A bulk editor seeded from a radial box must not turn the
  // seed linear just because the user typed an angle.
  it('leaves the seed style the template was cloned from alone', () => {
    boxOf('b1').style.gradient.kind = 'radial';
    selectBox('b1');
    openBulk();
    expect(app.bulk.style.gradient.kind).toBe('radial');
    app.bulk.style.gradient.cx = 0.25;
    app.bulk.style.gradient.radius = 2;
    tickBulkProp('gradient');
    toggleBulkTarget('b2');
    applyBulk();
    expect(boxOf('b1').style.gradient.cx).toBe(0.5);
    expect(boxOf('b1').style.gradient.radius).toBe(1);
    expect(boxOf('b2').style.gradient.cx).toBe(0.25);
    expect(boxOf('b2').style.gradient.radius).toBe(2);
  });

  // The document is on disk, so a restyle that never raises the flag is a
  // restyle the user loses on quit.
  it('marks the document unsaved', () => {
    markSaved();
    toggleBulkTarget('b1');
    tickBulkProp('color');
    app.bulk.style.color = '#00ff00';
    applyBulk();
    expect(app.saved).toBe(false);
  });

  // An Apply that changed no pixel is indistinguishable from a broken one, and
  // the record it would leave rewinds nothing while costing a step of a
  // five-step history.
  it('refuses an apply with nothing ticked, and stays open', () => {
    toggleBulkTarget('b1');
    app.bulk.style.color = '#00ff00';
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      applyBulk();
    } finally {
      off();
    }
    expect(log).toEqual([]);
    expect(boxOf('b1').style.color).not.toBe('#00ff00');
    expect(app.bulk.active).toBe(true);
  });

  it('records one entry for the whole apply, carrying whole styles', () => {
    toggleBulkTarget('b1');
    toggleBulkTarget('b2');
    setBulkProp('color', true);
    app.bulk.style.color = '#00ff00';
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      applyBulk();
    } finally {
      off();
    }
    expect(log).toHaveLength(1);
    expect(log[0].t).toBe('bulk');
    expect(log[0].items.map((i) => i.boxId)).toEqual(['b1', 'b2']);
    // Whole styles on both sides: the history's `bulk` kind assigns them
    // outright, so an entry carrying only the changed fields would replace each
    // box's style with a fragment on undo.
    expect(log[0].items[0].before.size).toBe(defaultStyle().size);
    expect(log[0].items[0].after.size).toBe(defaultStyle().size);
    expect(log[0].items[0].after.color).toBe('#00ff00');
  });

  // In a longstrip chapter every page of the chapter is drawn as one column, so
  // a target can be ticked on any slice while the index sits on whichever one
  // the scroll last focused. Scoped to `page()`, every target on another slice
  // resolved to undefined and `filter(Boolean)` dropped it without a word: tick
  // six boxes, press Apply, two of them change and the toast says two.
  it('reaches targets on pages the index is not on', () => {
    toggleBulkTarget('b1');
    toggleBulkTarget('b4');
    setBulkProp('color', true);
    app.bulk.style.color = '#00ff00';
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      applyBulk();
    } finally {
      off();
    }
    expect(boxOf('b1').style.color).toBe('#00ff00');
    expect(boxOf('b4').style.color).toBe('#00ff00');
    // One entry per page, on that page's own stack. A single entry can only
    // live on one stack and undo is per page, so the alternative is an entry
    // filed against the page on screen that rewinds boxes on another.
    expect(log.map((e) => [e.pageId, e.items.map((i) => i.boxId)])).toEqual([
      [1, ['b1']],
      [2, ['b4']],
    ]);
  });

  it('carries only the ticked half into the style the next box inherits', () => {
    toggleBulkTarget('b1');
    setBulkProp('color', true);
    app.bulk.style.color = '#00ff00';
    app.bulk.style.size = 99;
    applyBulk();
    expect(app.lastStyle.color).toBe('#00ff00');
    expect(app.lastStyle.size).toBe(defaultStyle().size);
  });

  it('drops the mask when the panel closes, so the next edit starts from nothing', () => {
    tickBulkProp('color');
    closeBulk();
    expect(app.bulk.mask).toEqual({});
    openBulk();
    expect(bulkTicked()).toEqual([]);
  });

  // The canvas asks this once per box per frame while the panel is open; it
  // answers through a Set over `targets` so the read stays constant-time. The
  // Set has to track every toggle and die with the panel.
  it('answers target lookups through a membership Set', () => {
    expect(app.bulk.targetSet).toBeInstanceOf(Set);
    expect(isBulkTarget('b1')).toBe(false);
    toggleBulkTarget('b1');
    toggleBulkTarget('b2');
    expect(app.bulk.targetSet.has('b1')).toBe(true);
    expect(app.bulk.targetSet.has('b2')).toBe(true);
    expect(app.bulk.targets).toEqual(['b1', 'b2']);
    toggleBulkTarget('b1');
    expect(app.bulk.targetSet.has('b1')).toBe(false);
    expect(app.bulk.targetSet.has('b2')).toBe(true);
    closeBulk();
    expect(app.bulk.targetSet.has('b2')).toBe(false);
    expect(isBulkTarget('b2')).toBe(false);
  });
});

// The tag-driven half: one press of Enter restyles every box carrying a tag,
// without the user clicking one of them. Scope is the array of pages handed
// over and nothing else - there is no scope enum anywhere in this path.
describe('a tag-scoped bulk edit', () => {
  const styled = (id, lineN) => ({ id, lineN, text: null, x: 0, y: 0, w: 10, h: 10 });
  const chapter = () => [
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [
        { n: 1, type: 'sfx', en: 'a' },
        { n: 2, type: 'dialogue', en: 'b' },
      ],
      boxes: [styled('b1', 1), styled('b2', 2), styled('b3', null)],
    },
    { id: 2, w: 800, h: 1200, lines: [{ n: 1, type: 'sfx', en: 'c' }], boxes: [styled('b4', 1)] },
  ];
  const boxOf = (id) => app.pages.flatMap((p) => p.boxes).find((b) => b.id === id);
  const green = () => {
    setBulkProp('color', true);
    app.bulk.style.color = '#00ff00';
  };

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(chapter());
    app.lastStyle = defaultStyle();
    openBulk();
  });
  afterEach(() => closeBulk());

  it('restyles every box carrying the tag in the pages it is handed', () => {
    green();
    expect(applyBulkToTag('sfx', app.pages)).toBe(2);
    expect(boxOf('b1').style.color).toBe('#00ff00');
    expect(boxOf('b4').style.color).toBe('#00ff00');
    // An untagged line, and a free-typed box that has no line to tag at all.
    expect(boxOf('b2').style.color).not.toBe('#00ff00');
    expect(boxOf('b3').style.color).not.toBe('#00ff00');
  });

  // The same sweep the clicked-target apply gets, because these are two ways of
  // naming boxes and only one line of `applyBulkToTag` is shared with the other
  // - a property that arrives one way and not the other is exactly the drift
  // `mergeMasked` exists to prevent, and it would show up as the tag button
  // doing nothing.
  it('carries every one of its properties onto every box the tag names', () => {
    const values = BULK_VALUES();
    for (const key of BULK_PROPS) {
      loadProjectPages(chapter());
      app.lastStyle = defaultStyle();
      openBulk();
      writePath(app.bulk.style, key, values[key]);
      tickBulkProp(key);
      const want = readPath(cloneStyle(app.bulk.style), key);
      expect(applyBulkToTag('sfx', app.pages)).toBe(2);
      for (const id of ['b1', 'b4']) {
        expect(readPath(boxOf(id).style, key), `${key} on ${id}`).toEqual(want);
      }
      expect(readPath(boxOf('b1').style, key), `${key} is still the default`).not.toEqual(
        readPath(defaultStyle(), key),
      );
      // And the boxes the tag does not name keep what they had.
      expect(readPath(boxOf('b2').style, key), `${key} leaked onto b2`).toEqual(
        readPath(defaultStyle(), key),
      );
    }
  });

  // A tag IS a selection. Picking one has to fill `targets`, or the panel's one
  // Apply button stays disabled at "0 selected" while a tag sits chosen right
  // above it - which is what made a tagged apply look broken.
  it('selects the boxes it names the moment the tag is picked', () => {
    setBulkTag('sfx');
    expect(app.bulk.targets).toEqual(['b1', 'b4']);
    expect(isBulkTarget('b1')).toBe(true);
    expect(isBulkTarget('b2')).toBe(false);
  });

  it('narrows and widens that selection with the scope', () => {
    setBulkTag('sfx');
    setBulkScope('page');
    expect(bulkScopePages()).toEqual([page()]);
    expect(app.bulk.targets).toEqual(['b1']);
    setBulkScope('chapter');
    expect(app.bulk.targets).toEqual(['b1', 'b4']);
  });

  it('clears the selection when the tag is cleared', () => {
    setBulkTag('sfx');
    setBulkTag('');
    expect(app.bulk.targets).toEqual([]);
  });

  // The scope must not silently eat a hand-picked list.
  it('leaves a hand-picked selection alone when the scope changes', () => {
    toggleBulkTarget('b4');
    setBulkScope('page');
    expect(app.bulk.targets).toEqual(['b4']);
  });

  // A click takes over: the tag's boxes stay as a starting point, but the tag
  // is dropped so a later scope change cannot re-derive the set and throw the
  // refinement away.
  it('hands the selection to the user the moment they click a box', () => {
    setBulkTag('sfx');
    toggleBulkTarget('b1');
    expect(app.bulk.tag).toBe('');
    expect(app.bulk.targets).toEqual(['b4']);
  });

  // One Apply for both ways of naming boxes.
  it('applies to the tag through the same Apply the clicked targets use', () => {
    setBulkTag('sfx');
    green();
    applyBulk();
    expect(boxOf('b1').style.color).toBe('#00ff00');
    expect(boxOf('b4').style.color).toBe('#00ff00');
    expect(boxOf('b2').style.color).not.toBe('#00ff00');
  });

  // Re-resolved at apply time: the tag means what it means now.
  it('applies to boxes tagged after the tag was picked', () => {
    setBulkTag('sfx');
    green();
    setLineTags(page().lines.find((l) => l.n === 2), ['sfx']);
    applyBulk();
    expect(boxOf('b2').style.color).toBe('#00ff00');
  });

  it('takes its scope from that array and nothing else', () => {
    green();
    expect(applyBulkToTag('sfx', [page()])).toBe(1);
    expect(boxOf('b1').style.color).toBe('#00ff00');
    expect(boxOf('b4').style.color).not.toBe('#00ff00');
  });

  it('leaves the unticked properties of a tagged box alone', () => {
    boxOf('b1').style.size = 40;
    green();
    app.bulk.style.size = 12;
    applyBulkToTag('sfx', app.pages);
    expect(boxOf('b1').style.color).toBe('#00ff00');
    expect(boxOf('b1').style.size).toBe(40);
  });

  // One entry per page, and no entry naming boxes on a page other than its own.
  // Undo is per page: a single entry filed against the page on screen would
  // rewind boxes on pages keeping stacks of their own, whose before/after still
  // described the world before this apply - their next undo would then restore a
  // style they had not been in since. So a chapter-wide apply is one press of
  // undo per page, taken on that page.
  it('records one entry per page, not one per box and not one for the chapter', () => {
    green();
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      applyBulkToTag('sfx', app.pages);
    } finally {
      off();
    }
    expect(log).toHaveLength(2);
    expect(log.map((e) => e.t)).toEqual(['bulk', 'bulk']);
    expect(log.map((e) => e.pageId)).toEqual([1, 2]);
    // Every item on the page its entry names, which is the invariant the
    // history's `bulk` kind reads for.
    for (const e of log) {
      expect(e.items.map((i) => i.pageId)).toEqual(e.items.map(() => e.pageId));
    }
    expect(log[0].items.map((i) => i.boxId)).toEqual(['b1']);
    expect(log[1].items.map((i) => i.boxId)).toEqual(['b4']);
  });

  // The other half of the same rule: an apply that stayed on one page is still
  // one entry and one press.
  it('records a single entry when the apply never left the page', () => {
    green();
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      applyBulkToTag('sfx', [page()]);
    } finally {
      off();
    }
    expect(log).toHaveLength(1);
    expect(log[0].pageId).toBe(page().id);
  });

  // Reviewer-verified drift: the merge into `lastStyle` sat outside the guard,
  // so an apply that matched nothing still moved the style every later placed
  // box inherits - to a value the user could not account for, because it had
  // never been applied to anything they could see.
  it('leaves the inherited style alone when the tag reached no box', () => {
    setBulkProp('roughen.amount', true);
    app.bulk.style.roughen.amount = 13;
    const was = app.lastStyle.roughen.amount;
    expect(applyBulkToTag('nosuchtag', app.pages)).toBe(0);
    expect(app.lastStyle.roughen.amount).toBe(was);
  });

  // An apply that matched nothing used to close the panel on its way out,
  // throwing away a template the user had composed property by property. It
  // stays open now - the toast says what happened; the template survives.
  it('stays open when the tag reached no box', () => {
    setBulkProp('color', true);
    app.bulk.style.color = '#00ff00';
    expect(applyBulkToTag('nosuchtag', app.pages)).toBe(0);
    expect(app.bulk.active).toBe(true);
    expect(app.bulk.style.color).toBe('#00ff00');
  });

  // Two ways of naming boxes, never one: the scope selector governs the tag
  // edit, and a box the user clicked is not part of it.
  it('ignores the click-to-select targets', () => {
    toggleBulkTarget('b3');
    green();
    applyBulkToTag('sfx', app.pages);
    expect(boxOf('b3').style.color).not.toBe('#00ff00');
  });

  it('refuses a tag apply with nothing ticked, and stays open', () => {
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      expect(applyBulkToTag('sfx', app.pages)).toBe(0);
    } finally {
      off();
    }
    expect(log).toEqual([]);
    expect(app.bulk.active).toBe(true);
  });

  it('records nothing when the tag reaches no box', () => {
    green();
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      expect(applyBulkToTag('narration', app.pages)).toBe(0);
    } finally {
      off();
    }
    expect(log).toEqual([]);
  });

  it('does nothing at all when bulk mode is not open', () => {
    green();
    closeBulk();
    expect(applyBulkToTag('sfx', app.pages)).toBe(0);
    expect(boxOf('b1').style.color).not.toBe('#00ff00');
  });
});

// A bulk apply moves the style every later box inherits (`lastStyle`) along
// with the boxes, so the history entry has to carry it both ways: an undo that
// restored the boxes but left `lastStyle` bulk-advanced would keep handing the
// applied style to every box placed afterwards - a style no step on the stack
// accounts for.
describe('a bulk apply and the style the next box inherits', () => {
  const styled = (id, lineN) => ({ id, lineN, text: null, x: 0, y: 0, w: 10, h: 10 });
  const chapter = () => [
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [{ n: 1, type: 'sfx', en: 'a' }],
      boxes: [styled('b1', 1), styled('b2', 2)],
    },
  ];
  const boxOf = (id) => app.pages.flatMap((p) => p.boxes).find((b) => b.id === id);

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(chapter());
    app.lastStyle = defaultStyle();
    initHistory();
    resetHistory();
    openBulk();
  });
  afterEach(() => closeBulk());

  it('walks lastStyle back on undo and forward again on redo', () => {
    toggleBulkTarget('b1');
    setBulkProp('color', true);
    app.bulk.style.color = '#00ff00';
    applyBulk();
    expect(app.lastStyle.color).toBe('#00ff00');
    undo();
    expect(boxOf('b1').style.color).not.toBe('#00ff00');
    expect(app.lastStyle.color).toBe(defaultStyle().color);
    redo();
    expect(app.lastStyle.color).toBe('#00ff00');
  });

  it('carries the pair on every entry a multi-page apply writes', () => {
    loadProjectPages([
      ...chapter(),
      { id: 2, w: 800, h: 1200, lines: [{ n: 1, type: 'sfx', en: 'c' }], boxes: [styled('b4', 1)] },
    ]);
    app.lastStyle = defaultStyle();
    openBulk();
    toggleBulkTarget('b1');
    toggleBulkTarget('b4');
    setBulkProp('color', true);
    app.bulk.style.color = '#00ff00';
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      applyBulk();
    } finally {
      off();
    }
    expect(log).toHaveLength(2);
    for (const e of log) {
      expect(e.lastStyleBefore.color).toBe(defaultStyle().color);
      expect(e.lastStyleAfter.color).toBe('#00ff00');
    }
    // Either page's undo walks the inherited style back with its own boxes.
    expect(app.lastStyle.color).toBe('#00ff00');
    undo();
    expect(app.lastStyle.color).toBe(defaultStyle().color);
  });

  // A restyle of nothing is not an edit and records nothing, so there is no
  // entry to carry any style anywhere.
  it('records no lastStyle pair when the apply matched no box', () => {
    setBulkProp('color', true);
    app.bulk.style.color = '#00ff00';
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      expect(applyBulkToTag('nosuchtag', app.pages)).toBe(0);
    } finally {
      off();
    }
    expect(log).toEqual([]);
    expect(app.lastStyle.color).toBe(defaultStyle().color);
  });
});

// Applying a tag used to be an action with no effect anyone could see: a tag's
// defaults reach a box only at placement, so tagging a line whose box was
// already on the page changed a badge and nothing else, and the user was left to
// conclude the defaults did not work. An apply restyles the box now, as one undo
// step.
describe('applying a tag to a line whose box is already placed', () => {
  const chapter = () => [
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [
        { n: 1, type: 'dialogue', en: 'a' },
        { n: 2, type: 'dialogue', en: 'b' },
      ],
      boxes: [],
    },
  ];
  // The documented seam: a registry handed over rather than read out of a
  // project.json the node environment does not have.
  const seedTags = (list) => bindTags({ list });
  const sfx = (extra = {}) => [
    { name: 'sfx', font: 'Bangers', outline: '#ff0000', outlineWidth: 6, ...extra },
  ];
  // The box this call placed, not the line's first - a line can end up with two.
  const placeLine = (n) => {
    activateLine(n);
    placeActiveAt(100, 100);
    return page().boxes[page().boxes.length - 1];
  };

  beforeEach(() => {
    app.chapterRef = null;
    seedTags([]);
    loadProjectPages(chapter());
    app.lastStyle = defaultStyle();
  });

  it('restyles the box to the style it would have been placed with', () => {
    seedTags(sfx());
    const b = placeLine(1);
    expect(b.style.font).not.toBe('Bangers');
    const out = toggleTagOnLine(1, 'sfx');
    expect(out).toMatchObject({ added: true, restyled: 1, tags: ['sfx'] });
    expect(b.style.font).toBe('Bangers');
    // A tag defines THE outline, so it replaces whatever stroke list the box had.
    expect(b.style.strokes).toEqual([{ color: '#ff0000', width: 6, opacity: 1 }]);
  });

  // The rule, stated as the equality it is: tag-then-place and place-then-tag
  // are the same function, so they cannot drift into two answers.
  it('lands on the same style as placing the box under the tag would have', () => {
    seedTags(sfx());
    const placedThenTagged = placeLine(1);
    toggleTagOnLine(1, 'sfx');
    toggleTagOnLine(2, 'sfx');
    const taggedThenPlaced = placeLine(2);
    expect(taggedThenPlaced.style.font).toBe(placedThenTagged.style.font);
    expect(taggedThenPlaced.style.strokes).toEqual(placedThenTagged.style.strokes);
  });

  // The rule for a box the user has styled by hand: the tag wins over the three
  // fields a tag can define, and touches nothing else. Manual styling winning
  // would make an apply do nothing on precisely the boxes the user has been
  // working on, which is the complaint this answers - and it is one undo press
  // away either way.
  it('overrides a font the user set by hand, and leaves everything else alone', () => {
    seedTags(sfx());
    const b = placeLine(1);
    b.style.font = 'Comic Neue';
    b.style.size = 44;
    b.style.color = '#123456';
    b.style.shadows = [{ x: 1, y: 1, blur: 0, color: '#000000', opacity: 1 }];
    b.style.rotation = 12;
    toggleTagOnLine(1, 'sfx');
    expect(b.style.font).toBe('Bangers');
    expect(b.style.size).toBe(44);
    expect(b.style.color).toBe('#123456');
    expect(b.style.shadows).toHaveLength(1);
    expect(b.style.rotation).toBe(12);
  });

  it('is one undo step, carrying whole styles on both sides', () => {
    seedTags(sfx());
    const b = placeLine(1);
    const was = b.style.font;
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      toggleTagOnLine(1, 'sfx');
    } finally {
      off();
    }
    expect(log).toHaveLength(1);
    expect(log[0].t).toBe('style');
    expect(log[0].pageId).toBe(page().id);
    expect(log[0].boxId).toBe(b.id);
    expect(log[0].before.font).toBe(was);
    expect(log[0].after.font).toBe('Bangers');
    // Whole styles: the history's `style` kind assigns them outright, so a
    // fragment would replace the box's style with three fields.
    expect(log[0].before.size).toBe(defaultStyle().size);
  });

  // A line can carry two boxes - a chapter saved by an older build, where a
  // re-armed placed line was placed again. Both are the line's, and one click
  // must still be one press of undo. (The Place tool no longer does this
  // itself: an armed line already on the page places the next unplaced one.)
  it('covers every box on the line with a single entry', () => {
    seedTags(sfx());
    const first = placeLine(1);
    const second = { ...JSON.parse(JSON.stringify(first)), id: first.id + '_twin', x: first.x + 50 };
    page().boxes.push(second);
    expect(first.id).not.toBe(second.id);
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      expect(toggleTagOnLine(1, 'sfx').restyled).toBe(2);
    } finally {
      off();
    }
    expect(log).toHaveLength(1);
    expect(log[0].t).toBe('bulk');
    expect(log[0].items.map((i) => i.boxId)).toEqual([first.id, second.id]);
  });

  // Un-applying restyles nothing: a box's style is a value it owns, not a
  // reference to the tag, so there is no "what it would have been" to go back to
  // and guessing would be a second rule for the same button.
  it('changes nothing when the click takes the tag off again', () => {
    seedTags(sfx());
    const b = placeLine(1);
    toggleTagOnLine(1, 'sfx');
    const log = [];
    const off = setRecorder((e) => log.push(e));
    let out;
    try {
      out = toggleTagOnLine(1, 'sfx');
    } finally {
      off();
    }
    expect(out).toMatchObject({ added: false, restyled: 0, tags: [] });
    expect(b.style.font).toBe('Bangers'); // kept, not reverted
    expect(log).toEqual([]);
  });

  it('records nothing when the tag defines no defaults', () => {
    seedTags([{ name: 'sfx', font: null, outline: null, outlineWidth: null }]);
    placeLine(1);
    const log = [];
    const off = setRecorder((e) => log.push(e));
    let out;
    try {
      out = toggleTagOnLine(1, 'sfx');
    } finally {
      off();
    }
    expect(out).toMatchObject({ added: true, restyled: 0 });
    expect(log).toEqual([]);
  });

  it('records nothing when the line has no box yet', () => {
    seedTags(sfx());
    const log = [];
    const off = setRecorder((e) => log.push(e));
    let out;
    try {
      out = toggleTagOnLine(1, 'sfx');
    } finally {
      off();
    }
    expect(out).toMatchObject({ added: true, restyled: 0, tags: ['sfx'] });
    expect(log).toEqual([]);
    // …and the tag still reaches the box the ordinary way, at placement.
    expect(placeLine(1).style.font).toBe('Bangers');
  });

  it('normalises the name it is handed, like every other tag write', () => {
    seedTags(sfx());
    const b = placeLine(1);
    toggleTagOnLine(1, '  SFX  ');
    expect(lineTags(page().lines[0])).toEqual(['sfx']);
    expect(b.style.font).toBe('Bangers');
  });

  it('does nothing at all for a line or a name that is not there', () => {
    seedTags(sfx());
    expect(toggleTagOnLine(99, 'sfx')).toEqual({ tags: [], added: false, restyled: 0 });
    expect(toggleTagOnLine(1, '   ')).toEqual({ tags: [], added: false, restyled: 0 });
  });
});

// ---------------------------------------------------------------------------
// the page's coordinate space
// ---------------------------------------------------------------------------
//
// `.page-frame` is `p.w * zoom` by `p.h * zoom` and `.page-img` inside it is
// `width:100%; height:100%`, so these two numbers are not a note about the file
// - they are the space the art is drawn into and the space every box is
// positioned in. Nothing letterboxes: when they disagree with the image, the
// art is stretched and the zoom readout is a percentage of pixels that do not
// exist. Everything below is that one invariant.
describe('the page coordinate space', () => {
  const unmeasured = (id, extra = {}) => ({
    id,
    w: 0,
    h: 0,
    lines: [],
    boxes: [],
    raw: `blob:raw-${id}`,
    cleaned: null,
    ...extra,
  });

  beforeEach(() => {
    app.chapterRef = null;
  });

  it('calls a page with no positive pair unmeasured, not a page of size zero', () => {
    expect(hasPageSpace({ w: 1080, h: 1535 })).toBe(true);
    expect(hasPageSpace({ w: 0, h: 0 })).toBe(false);
    expect(hasPageSpace({ w: 1080, h: 0 })).toBe(false);
    expect(hasPageSpace({})).toBe(false);
    expect(hasPageSpace({ w: NaN, h: NaN })).toBe(false);
    expect(hasPageSpace(null)).toBe(false);
  });

  // `createChapter` writes `w:0,h:0` for every page it copies - it never
  // decodes the images - so this is the state 23 of the 28 pages in the
  // author's own library are saved in. Loading must not turn it into a size:
  // PAGE_W/PAGE_H there is an invented coordinate space, and the first real
  // measurement would then look like a space *changing* and drag every box
  // across by 1080/850.
  it('keeps an unmeasured page unmeasured across a load', () => {
    loadProjectPages([unmeasured(1), { ...unmeasured(2), w: undefined, h: undefined }]);
    expect([app.pages[0].w, app.pages[0].h]).toEqual([0, 0]);
    expect([app.pages[1].w, app.pages[1].h]).toEqual([0, 0]);
  });

  it('refuses a measurement of zero, which is a failed decode and not a size', () => {
    loadProjectPages([{ ...unmeasured(1), w: 1080, h: 1535 }]);
    expect(setPageDims(page(), 0, 0)).toBe(false);
    expect([page().w, page().h]).toEqual([1080, 1535]);
  });

  it('adopts the first measurement without moving anything', () => {
    loadProjectPages([unmeasured(1)]);
    const p = page();
    p.boxes.push({ id: 'b1', lineN: null, text: 'x', x: 40, y: 60, w: 220, h: 92 });
    expect(setPageDims(p, 1080, 1535)).toBe(true);
    expect([p.w, p.h]).toEqual([1080, 1535]);
    // Nothing was authored in a space that did not exist, so nothing can have
    // been authored in the wrong one.
    expect([p.boxes[0].x, p.boxes[0].y]).toEqual([40, 60]);
  });

  // The other half of the same rule, and the one that keeps the art and the
  // boxes together: a page that HAS a space and is handed a different one has
  // had its art replaced (a cleaned raster at another resolution landing on a
  // page that is already typeset). The boxes were placed over that art.
  it('carries the boxes and the detected geometry across a space that changes', () => {
    loadProjectPages([
      {
        ...unmeasured(1),
        w: 500,
        h: 1000,
        boxes: [{ id: 'b1', lineN: null, text: 'x', x: 100, y: 200, w: 50, h: 40 }],
        detect: { panels: [[0, 0, 500, 500]], boxes: [{ n: 1, box: [10, 20, 30, 40], font_size: 24 }] },
      },
    ]);
    const p = page();
    expect(setPageDims(p, 1000, 3000)).toBe(true);
    expect([p.boxes[0].x, p.boxes[0].y, p.boxes[0].w, p.boxes[0].h]).toEqual([200, 600, 100, 120]);
    expect(p.detect.panels[0]).toEqual([0, 0, 1000, 1500]);
    expect(p.detect.boxes[0].box).toEqual([20, 60, 60, 120]);
    expect(p.detect.boxes[0].font_size).toBe(72);
  });

  // The other half of the same move, and the one that was missing: a box's
  // rectangle is page geometry and so is the TYPE inside it. `size`, the stroke
  // widths, the shadow offsets and blurs, the whole-text blur and the letter
  // spacing are all quoted in page pixels, and a chapter re-cleaned at 2x used
  // to come back with every line half the size it was drawn at, hairline
  // strokes, and shadows that had come loose from their glyphs - invisible until
  // the export, because the record looked perfectly self-consistent.
  const styled = (over = {}) => ({
    ...unmeasured(1),
    w: 500,
    h: 1000,
    boxes: [
      {
        id: 'b1',
        lineN: null,
        text: 'x',
        x: 100,
        y: 200,
        w: 50,
        h: 40,
        style: {
          size: 26,
          blur: 4,
          letterSpacing: 5,
          strokes: [{ color: '#ffffff', width: 3, opacity: 1 }],
          shadows: [{ x: 2, y: 4, blur: 6, color: '#000000', opacity: 0.6 }],
          ...over,
        },
      },
    ],
  });

  it('scales the type with the page when the space doubles', () => {
    loadProjectPages([styled()]);
    const p = page();
    expect(setPageDims(p, 1000, 2000)).toBe(true);
    const s = p.boxes[0].style;
    expect(s.size).toBe(52);
    expect(s.blur).toBe(8);
    expect(s.letterSpacing).toBe(10);
    expect(s.strokes[0].width).toBe(6);
    expect(s.shadows[0]).toMatchObject({ x: 4, y: 8, blur: 12 });
    // Everything that is not a length is left exactly as it was.
    expect(s.strokes[0].color).toBe('#ffffff');
    expect(s.shadows[0].opacity).toBeCloseTo(0.6);
  });

  // A change of ASPECT, where no single factor is right for a length that has no
  // axis. The geometric mean preserves area and degrades to the uniform factor
  // when there is one; a shadow's OFFSET does have an axis, so it takes the axis
  // factor exactly.
  it('gives a length with no axis the geometric mean when the aspect changes', () => {
    loadProjectPages([styled()]);
    const p = page();
    expect(setPageDims(p, 1000, 3000)).toBe(true); // sx 2, sy 3
    const s = p.boxes[0].style;
    expect(s.size).toBeCloseTo(26 * Math.sqrt(6), 10);
    expect(s.strokes[0].width).toBeCloseTo(3 * Math.sqrt(6), 10);
    expect(s.shadows[0].x).toBe(4);
    expect(s.shadows[0].y).toBe(12);
    expect(s.shadows[0].blur).toBeCloseTo(6 * Math.sqrt(6), 10);
  });

  it('turns the roughening grain with the page rather than against it', () => {
    loadProjectPages([styled({ roughen: { on: true, amount: 4, detail: 0.05, seed: 7 } })]);
    const p = page();
    setPageDims(p, 1000, 2000);
    const r = p.boxes[0].style.roughen;
    // The displacement is a length in page px; the noise frequency is cycles
    // PER page px, so it moves the other way or the same roughening comes back
    // as a different grain.
    expect(r.amount).toBe(8);
    expect(r.detail).toBeCloseTo(0.025, 10);
    expect(r.seed).toBe(7);
  });

  it('leaves the type alone when the space is only confirmed', () => {
    loadProjectPages([styled()]);
    const p = page();
    setPageDims(p, 500, 1000);
    expect(p.boxes[0].style.size).toBe(26);
  });

  // The first measurement of a page that never had a space moves nothing, and
  // that has to include the type: nothing was authored in a space that did not
  // exist, so there is no factor and nothing to apply it to.
  it('leaves the type alone on a first measurement', () => {
    loadProjectPages([{ ...styled(), w: 0, h: 0 }]);
    const p = page();
    setPageDims(p, 1000, 2000);
    expect(p.boxes[0].style.size).toBe(26);
    expect(p.boxes[0].x).toBe(100);
  });

  it('leaves a page that already knows its size alone', () => {
    loadProjectPages([{ ...unmeasured(1), w: 1080, h: 1535 }]);
    expect(setPageDims(page(), 1080, 1535)).toBe(false);
  });

  // There is one `<img>` in the canvas and `src` changes under it on every page
  // turn, so a decode can finish after the user has moved on. Addressed by the
  // page on screen, that measurement lands on the wrong page - and on a chapter
  // with a double-page spread in it, that page is then drawn stretched for
  // good, and saved that way. The object URL belongs to exactly one page.
  it('lands a late decode on the page whose image it was', () => {
    loadProjectPages([unmeasured(1), unmeasured(2)]);
    gotoPage(1); // the user has already turned the page
    const landed = setPageDimsForSrc('blob:raw-1', 1080, 1535);
    expect(landed).toBe(app.pages[0]);
    expect([app.pages[0].w, app.pages[0].h]).toEqual([1080, 1535]);
    expect([app.pages[1].w, app.pages[1].h]).toEqual([0, 0]);
  });

  it('finds a page by either of its two rasters, and says so when nobody owns the url', () => {
    loadProjectPages([unmeasured(1, { cleaned: 'blob:cleaned-1' }), unmeasured(2)]);
    expect(pageForSrc('blob:cleaned-1')).toBe(app.pages[0]);
    expect(pageForSrc('blob:raw-2')).toBe(app.pages[1]);
    expect(pageForSrc('blob:nothing')).toBe(null);
    expect(setPageDimsForSrc('blob:nothing', 800, 900)).toBe(null);
  });

  // The measurement is the document changing, and there is no manual save in
  // this app: unsaved, a chapter re-learns its page sizes one visit at a time
  // every session, and every page nobody opened stays at 0x0 for the exporter.
  it('marks the document unsaved when a page learns its size', () => {
    loadProjectPages([unmeasured(1)]);
    app.saved = true;
    setPageDims(page(), 1080, 1535);
    expect(app.saved).toBe(false);
  });
});

// The engine's `img_width`/`img_height` are the decoded size of the image it
// was handed (src-tauri/src/detect/engine.rs decodes once, detect::analyze
// reports that size, nothing resizes between), and every `box` it returns is
// quoted in that space. So they are the detector's frame of reference, not a
// second opinion about how big the page is.
describe('applying a detection result', () => {
  const result = (over = {}) => ({
    img_width: 1000,
    img_height: 2000,
    panels: [[0, 0, 500, 1000]],
    lines: [{ n: 1, type: 'dialogue', jp: 'あ', box: [100, 200, 300, 400], vertical: true, font_size: 20 }],
    ...over,
  });

  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
  });

  it('adopts the detector size only on a page that has never been measured', () => {
    loadProjectPages([{ id: 1, w: 0, h: 0, lines: [], boxes: [] }]);
    applyDetection(result());
    expect([page().w, page().h]).toEqual([1000, 2000]);
    // Adopted, so the boxes are already in the page's space and untouched.
    expect(page().detect.boxes[0].box).toEqual([100, 200, 300, 400]);
  });

  // The canvas draws `p.cleaned ?? p.raw`; detection runs on `p.raw`. Writing
  // the detector's size over a measured page is what stretched the cleaned art
  // into the raw's box - and the zoom percentage with it.
  it('never overwrites a page that has been measured', () => {
    loadProjectPages([{ id: 1, w: 2000, h: 2000, lines: [], boxes: [] }]);
    applyDetection(result());
    expect([page().w, page().h]).toEqual([2000, 2000]);
  });

  it('maps its geometry into the page space instead', () => {
    loadProjectPages([{ id: 1, w: 2000, h: 1000, lines: [], boxes: [] }]);
    applyDetection(result());
    // x doubles (2000/1000), y halves (1000/2000).
    expect(page().detect.boxes[0].box).toEqual([200, 100, 600, 200]);
    expect(page().detect.panels[0]).toEqual([0, 0, 1000, 500]);
    expect(page().detect.boxes[0].font_size).toBe(10);
    expect(page().detect.boxes[0].vertical).toBe(true);
  });

  it('leaves the geometry alone when the detector agrees with the page', () => {
    loadProjectPages([{ id: 1, w: 1000, h: 2000, lines: [], boxes: [] }]);
    applyDetection(result());
    expect(page().detect.boxes[0].box).toEqual([100, 200, 300, 400]);
    expect(page().detect.panels[0]).toEqual([0, 0, 500, 1000]);
  });

  // A result that reports no size at all leaves the page as it found it rather
  // than dividing by it.
  it('survives a result with no dimensions in it', () => {
    loadProjectPages([{ id: 1, w: 1000, h: 2000, lines: [], boxes: [] }]);
    applyDetection(result({ img_width: 0, img_height: 0 }));
    expect([page().w, page().h]).toEqual([1000, 2000]);
    expect(page().detect.boxes[0].box).toEqual([100, 200, 300, 400]);
  });

  it('applies to the page it is given, not to the page on screen', () => {
    loadProjectPages([
      { id: 1, w: 0, h: 0, lines: [], boxes: [] },
      { id: 2, w: 0, h: 0, lines: [], boxes: [] },
    ]);
    applyDetection(result(), app.pages[1]);
    expect([app.pages[0].w, app.pages[0].h]).toEqual([0, 0]);
    expect([app.pages[1].w, app.pages[1].h]).toEqual([1000, 2000]);
  });

  // Re-detecting a page is an ordinary thing to do - a better model, a cleaned
  // raster, a page that came out wrong the first time - and it used to throw
  // away every translation on that page, with no undo entry and no warning.
  it('keeps the English on a line the detector found again unchanged', () => {
    loadProjectPages([
      { id: 1, w: 1000, h: 2000, lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }], boxes: [] },
    ]);
    applyDetection(result());
    expect(page().lines.map((l) => [l.n, l.jp, l.en])).toEqual([[1, 'あ', 'Ah']]);
  });

  it('keeps the English on a Korean line the detector found again unchanged', () => {
    loadProjectPages([
      { id: 1, w: 1000, h: 2000, lines: [{ n: 1, type: 'dialogue', jp: '안녕하세요', en: 'Hello', lang: 'ko' }], boxes: [] },
    ]);
    applyDetection(result({
      lines: [{ n: 1, type: 'dialogue', jp: '안녕하세요', lang: 'ko', box: [100, 200, 300, 400], vertical: null, font_size: 20 }],
    }));
    expect(page().lines.map((l) => [l.n, l.jp, l.en])).toEqual([[1, '안녕하세요', 'Hello']]);
    expect(page().lines[0].lang).toBe('ko');
  });

  it('keeps translation matched when imported from Korean source keys', () => {
    loadProjectPages([
      { id: 1, w: 1000, h: 2000, lines: [{ n: 1, type: 'dialogue', jp: '네, 알겠습니다', en: 'Yes, understood' }], boxes: [] },
    ]);
    applyDetection(result({
      lines: [{ n: 1, type: 'dialogue', jp: '네, 알겠습니다', lang: 'ko', box: [100, 200, 300, 400], vertical: null, font_size: 20 }],
    }));
    expect(page().lines.map((l) => [l.n, l.jp, l.en])).toEqual([[1, '네, 알겠습니다', 'Yes, understood']]);
  });

  // Same number, different sentence. The detector renumbers from 1 in reading
  // order on every run, so the number alone does not say it is the same line -
  // one bubble found that was missed before shifts every number after it.
  // Carrying the old English across would put a confident, wrong translation in
  // the queue, which is strictly worse than an empty row the user can see is
  // empty.
  it('drops the English when that number now names different Japanese', () => {
    loadProjectPages([
      { id: 1, w: 1000, h: 2000, lines: [{ n: 1, type: 'dialogue', jp: 'い', en: 'Ah' }], boxes: [] },
    ]);
    applyDetection(result());
    expect(page().lines[0].jp).toBe('あ');
    expect(page().lines[0].en).toBe('');
  });

  // Queue-side markup takes the looser rule - by number alone, which is what the
  // JSON re-import path already does to the same wholesale replacement. One
  // click to re-apply and one to take off, so the cost of guessing wrong is not
  // the cost of guessing wrong about a translation.
  it('carries the tags on a line across, like a re-import does', () => {
    loadProjectPages([
      {
        id: 1,
        w: 1000,
        h: 2000,
        lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: '', tags: ['sfx'] }],
        boxes: [],
      },
    ]);
    applyDetection(result());
    expect(lineTags(page().lines[0])).toEqual(['sfx']);
  });

  // The detector never saw these rows and cannot renumber them - its numbers
  // start at 1 - so it has no opinion about them at all.
  it('carries the rows the user typed, and the boxes that made them', () => {
    loadProjectPages([{ id: 1, w: 1000, h: 2000, lines: [], boxes: [] }]);
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    const freeN = byId(id).lineN;
    applyDetection(result());
    expect(page().lines.map((l) => l.n)).toEqual([1, freeN]);
    expect(page().lines.find((l) => l.n === freeN).en).toBe('typed');
    // The box survives with its line. A surviving line whose box was wiped is
    // exactly the orphan row `deleteBox` goes out of its way never to leave:
    // unplaceable, undeletable, holding the text of a box that is gone.
    expect(page().boxes.map((b) => b.id)).toEqual([id]);
  });

  // The typeset boxes do go - every one is bound to a number the detector has
  // just reassigned - and the two ids pointing into them have to go with them.
  it('wipes the typeset boxes and takes the selection and the caret with them', () => {
    loadProjectPages([
      { id: 1, w: 1000, h: 2000, lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }], boxes: [] },
    ]);
    activateLine(1);
    placeActiveAt(100, 100);
    const b = page().boxes[0];
    beginEdit(b.id);
    expect([app.selectedId, app.editingId]).toEqual([b.id, b.id]);
    applyDetection(result());
    expect(page().boxes).toHaveLength(0);
    // Dangling, `selectedId` names a box nothing can find, and `editingId` is
    // read by App.svelte as "the user is typing" - every global shortcut in the
    // app stays dead behind it.
    expect(app.selectedId).toBe(null);
    expect(app.editingId).toBe(null);
  });
});

// The auto-fit itself needs real text metrics, and the arithmetic it is made of
// is pinned in typeset.test.js (`neededHeight`, `growToFit`). What belongs here
// is the guard: under node there is no canvas, so `autoFitBox` must decline
// rather than size a box from the stand-in metric every measurement falls back
// to. `loadProjectPages` refits every page it loads, so without that guard every
// test run - and every headless consumer - would silently rewrite the geometry
// in the document it just opened.
describe('auto-height declines when there is nothing to measure with', () => {
  it('leaves a loaded box exactly as the file had it', () => {
    app.chapterRef = null;
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [],
        boxes: [{ id: 'b1', lineN: null, text: 'A LONG LINE OF DIALOGUE', x: 10, y: 20, w: 60, h: 12 }],
      },
    ]);
    const b = page().boxes[0];
    expect([b.x, b.y, b.w, b.h]).toEqual([10, 20, 60, 12]);
  });
});

// ===========================================================================
// Placement follows the bubble
// ===========================================================================
// A placed box used to be 220x92 whatever it landed on - a size chosen for a
// page nobody had seen. `p.detect.boxes` already holds, per line, the rect the
// Japanese occupied, in page coordinates; that is the size and the position the
// English wants, less a margin so the text is not pressed against the outline.
describe('bubble-aware placement', () => {
  const withDetect = (boxes) => [
    {
      id: 1,
      w: 1000,
      h: 2000,
      lines: [{ n: 1, jp: 'あ', en: '', type: 'dialogue' }, { n: 2, jp: 'い', en: '', type: 'dialogue' }],
      boxes: [],
      detect: { panels: [], boxes },
    },
  ];

  beforeEach(() => {
    app.chapterRef = null;
  });

  it('finds the line’s own rect first', () => {
    loadProjectPages(withDetect([
      { n: 1, box: [100, 100, 300, 300], vertical: true, font_size: 20 },
      { n: 2, box: [500, 500, 700, 700], vertical: true, font_size: 20 },
    ]));
    expect(detectedRectFor(page(), 2, 0, 0)).toEqual([500, 500, 700, 700]);
  });

  it('falls back to whichever rect the click landed in', () => {
    loadProjectPages(withDetect([{ n: 2, box: [500, 500, 700, 700], vertical: false, font_size: 20 }]));
    // Line 1 has no geometry of its own, but the user is pointing at a bubble.
    expect(detectedRectFor(page(), 1, 600, 600)).toEqual([500, 500, 700, 700]);
    // A click on bare paper is not pointing at anything.
    expect(detectedRectFor(page(), 1, 50, 50)).toBe(null);
  });

  it('sizes and centres the box on the rect, inset off the outline', () => {
    const p = { w: 1000, h: 2000 };
    const g = placementRect(p, [100, 100, 300, 400], 0, 0);
    // A 200x300 rect: 8% of its shorter side is 16, held to the 14 ceiling, and
    // taken off every edge.
    expect(g).toEqual({ x: 114, y: 114, w: 172, h: 272 });
    // Centred on the rect, not on the click.
    expect([g.x + g.w / 2, g.y + g.h / 2]).toEqual([200, 250]);
  });

  it('keeps the inset from eating a small rect or dominating a large one', () => {
    const p = { w: 4000, h: 4000 };
    // A long thin SFX strip: 8% of 30 rounds to 2, held up by the floor of 3,
    // so the margin is visible rather than notional.
    expect(placementRect(p, [0, 0, 400, 30], 0, 0).w).toBe(394);
    // A full-page rect: the ceiling stops the margin swallowing the bubble.
    expect(placementRect(p, [0, 0, 1000, 1000], 0, 0).w).toBe(972);
  });

  it('never places a box smaller than a drag is allowed to make one', () => {
    const g = placementRect({ w: 1000, h: 2000 }, [0, 0, 10, 10], 0, 0);
    expect([g.w, g.h]).toEqual([40, 30]);
  });

  // `p.w`/`p.h` are 0 until something decodes the art, and clamping against a
  // number nobody has measured is what `growToFit` already refuses to do. Here
  // it was worse than a no-op: `clamp(cx - w/2, 0, Math.max(0, 0 - w))` is a
  // range of exactly zero, so every placement on a page the canvas had not
  // measured yet landed on the origin and the bubble the detector found was
  // thrown away. A whole chapter can be in that state - a page is only measured
  // when it is looked at.
  it('does not clamp a placement against a page nobody has measured', () => {
    expect(placementRect({ w: 0, h: 0 }, [100, 100, 300, 400], 0, 0)).toEqual({
      x: 114,
      y: 114,
      w: 172,
      h: 272,
    });
    // The lower edge still holds: a box is never placed off the top-left, which
    // needs no measurement to know.
    expect(placementRect({ w: 0, h: 0 }, null, 10, 10)).toEqual({ x: 0, y: 0, w: 220, h: 92 });
  });

  it('keeps the old constants when there is nothing detected behind the line', () => {
    expect(placementRect({ w: 1000, h: 2000 }, null, 500, 500)).toEqual({
      x: 390,
      y: 454,
      w: 220,
      h: 92,
    });
  });

  it('places from the bubble rather than from the constants', () => {
    loadProjectPages(withDetect([{ n: 1, box: [100, 100, 500, 300], vertical: false, font_size: 20 }]));
    placeActiveAt(50, 50); // deliberately off the bubble: the line's own rect wins
    const b = page().boxes[0];
    expect([b.w, b.h]).toEqual([372, 172]);
    expect([b.x + b.w / 2, b.y + b.h / 2]).toEqual([300, 200]);
  });
});

// ===========================================================================
// Free-typed boxes join the text queue
// ===========================================================================
// A box made with the Text tool used to be canvas-only: `lineN: null`, no queue
// row, and - since tags live on lines - no way to tag it, no way for a
// tag-scoped bulk edit to reach it, and no showing in the "N / M placed" count.
// It now brings a line of its own with it. What pins that, below, is the four
// things that can go wrong with such a line: its number colliding with the
// translator's, its text living in two places, the placed count lying, and the
// line outliving the box that made it.
describe('a free-typed box brings a queue line with it', () => {
  const withLines = (lines) => [{ id: 1, w: 800, h: 1200, lines, boxes: [] }];

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(withLines([]));
  });

  it('creates one line, numbered below zero, and points the box at it', () => {
    const id = addEmptyBox(100, 100);
    expect(page().lines.length).toBe(1);
    const ln = page().lines[0];
    expect(ln.n).toBeLessThan(0);
    expect(byId(id).lineN).toBe(ln.n);
    // Null, not '': the text lives on the line. A string here would shadow it
    // in `boxText` and the queue's textarea would stop reaching the box.
    expect(byId(id).text).toBe(null);
  });

  // The whole reason the number is negative. Imported lines are the
  // translator's numbering, they are what `psd.js` and `exporter.js` write out,
  // and they must not be renumbered to make room for anything.
  it('never takes a number an imported line already has, and renumbers none of them', () => {
    loadProjectPages(withLines([{ n: 1, type: 'dialogue', jp: 'あ', en: 'ah' }, { n: 7, type: 'sfx', jp: 'ドン', en: 'DON' }]));
    addEmptyBox(100, 100);
    addEmptyBox(200, 200);
    expect(page().lines.map((l) => l.n)).toEqual([1, 7, -1, -2]);
  });

  // Descending from whatever is lowest, so a chapter whose lines a hand edit
  // numbered from -5 still cannot be collided with.
  it('goes below the lowest number on the page, not below zero', () => {
    loadProjectPages(withLines([{ n: -5, type: 'dialogue', jp: '', en: 'hand-edited' }]));
    addEmptyBox(100, 100);
    expect(page().lines.at(-1).n).toBe(-6);
  });

  // Per page: `box.lineN` only ever joins within a page, so page two starting
  // its own free numbering at -1 is correct and not a collision.
  it('numbers each page on its own', () => {
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [], boxes: [] },
      { id: 2, w: 800, h: 1200, lines: [], boxes: [] },
    ]);
    addEmptyBox(100, 100);
    gotoPage(1);
    addEmptyBox(100, 100);
    expect(app.pages[0].lines[0].n).toBe(-1);
    expect(app.pages[1].lines[0].n).toBe(-1);
  });

  // `normLine` in importer.js validates `type` against three names and silently
  // downgrades anything else. A free line written with a fourth would come back
  // from the app's own exported JSON as something it was not.
  it("gives the line a type the importer's own validation accepts", () => {
    addEmptyBox(100, 100);
    expect(page().lines[0].type).toBe('dialogue');
  });

  // No Japanese source: the user typed English straight onto the page. The
  // queue and the box both render their JP on `{#if line.jp}`, so '' is no
  // label at all rather than a blank one.
  it('leaves jp empty and puts the typed text in en', () => {
    const id = addEmptyBox(100, 100);
    expect(page().lines[0].jp).toBe('');
    expect(page().lines[0].en).toBe('');
    endEdit('BOOM');
    expect(page().lines[0].en).toBe('BOOM');
    // One copy: the box owns nothing and resolves through its line.
    expect(byId(id).text).toBe(null);
    expect(boxText(byId(id))).toBe('BOOM');
  });

  it('is placed by definition, so the queue count stays honest', () => {
    loadProjectPages(withLines([{ n: 1, type: 'dialogue', jp: 'あ', en: 'ah' }]));
    const before = page().lines.filter((l) => isPlaced(page(), l.n)).length;
    expect(before).toBe(0);
    addEmptyBox(100, 100);
    // Both halves of "N / M placed" move together - the line is counted, and it
    // is counted as placed, because the box is what created it.
    expect(page().lines.length).toBe(2);
    expect(page().lines.filter((l) => isPlaced(page(), l.n)).length).toBe(1);
  });

  // When all imported lines are placed, firstUnplaced returns null.
  it('returns null when all lines are placed', () => {
    loadProjectPages(withLines([{ n: 4, type: 'dialogue', jp: '', en: 'x' }]));
    placeActiveAt(100, 100);
    addEmptyBox(300, 300);
    endEdit('typed');
    expect(firstUnplaced(page())).toBe(null);
  });

  it('refuses a second box on the same free line', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    activateLine(byId(id).lineN);
    placeActiveAt(400, 400);
    expect(page().boxes.length).toBe(1);
  });

  it('automatically switches tool from place to text when the last queued line is placed', () => {
    loadProjectPages(withLines([
      { n: 1, type: 'dialogue', jp: 'あ', en: 'one' },
      { n: 2, type: 'dialogue', jp: 'い', en: 'two' },
    ]));
    setTool('place');
    expect(app.tool).toBe('place');
    placeActiveAt(100, 100); // places line 1
    expect(page().activeLineN).toBe(2);
    expect(app.tool).toBe('place'); // still place mode
    placeActiveAt(200, 200); // places line 2 (last line)
    expect(page().activeLineN).toBe(null);
    expect(app.tool).toBe('text'); // automatically switched to text tool
  });
});

describe('deleting a free-typed box takes its line with it', () => {
  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'ah' }], boxes: [] }]);
  });

  // Left behind, the row is unplaceable, un-deletable (the queue has no such
  // control) and holds the text of a box that is gone.
  it('leaves no orphan row in the queue', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    expect(page().lines.length).toBe(2);
    deleteBox(id);
    expect(page().lines.map((l) => l.n)).toEqual([1]);
  });

  // Deleting a queue-placed box does NOT return its line to the queue.
  it('does not hand an imported line back to the queue on delete', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [
          { n: 1, type: 'dialogue', jp: 'あ', en: 'ah' },
          { n: 2, type: 'dialogue', jp: 'い', en: 'ee' },
        ],
        boxes: [],
      },
    ]);
    placeActiveAt(100, 100);
    const id = page().boxes[0].id;
    deleteBox(id);
    expect(page().lines.map((l) => l.n)).toEqual([1, 2]);
    expect(page().activeLineN).toBe(2);
    expect(firstUnplaced(page())).toBe(2);
    expect(isPlaced(page(), 1)).toBe(true);
  });

  // The queue must not be left armed on a number that no longer exists.
  it('does not arm the queue on the line it just removed', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    deleteBox(id);
    expect(page().activeLineN).not.toBe(-1);
  });

  // The empty-placeholder gesture: created and abandoned without typing. Both
  // halves have to go, or the user is left with a blank row for a box they
  // never made.
  it('takes the line too when the box is abandoned empty', () => {
    addEmptyBox(100, 100);
    endEdit('  ');
    expect(page().boxes.length).toBe(0);
    expect(page().lines.map((l) => l.n)).toEqual([1]);
  });

  it('takes the line too when an empty free box is abandoned via deselect', () => {
    addEmptyBox(100, 100);
    deselect();
    expect(page().boxes.length).toBe(0);
    expect(page().lines.map((l) => l.n)).toEqual([1]);
  });

  // Stronger than the case above, which only ever saw the queue armed by
  // `addEmptyBox`'s own path: here the user has clicked the free row, so
  // `activeLineN` really is the number that is about to leave the document.
  // `placeActiveAt` looks the active line up by number, so a stale one there
  // makes every later click on the canvas a silent no-op with no way out but
  // clicking another queue row - which is not a thing anybody knows to try.
  it('re-arms the queue when the line it was pointing at goes', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    const n = byId(id).lineN;
    activateLine(n);
    expect(page().activeLineN).toBe(n);
    deleteBox(id);
    expect(page().activeLineN).toBe(1);
    expect(page().lines.some((l) => l.n === page().activeLineN)).toBe(true);
  });

  // A delete can arrive from outside the box being typed into - the Inspector's
  // button, the keyboard while the pointer is elsewhere. App.svelte reads
  // `editingId` as "the user is typing" and returns before any shortcut is
  // reached, so a caret left on a box that no longer exists kills every global
  // shortcut in the app until something else happens to clear it.
  it('closes the caret on the box it deletes', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    beginEdit(id);
    expect(app.editingId).toBe(id);
    deleteBox(id);
    expect(app.editingId).toBe(null);
    expect(app.selectedId).toBe(null);
  });
});

describe('duplicating a box', () => {
  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [{ n: 1, type: 'sfx', jp: 'ドン', en: 'DON' }], boxes: [] },
    ]);
  });

  it('copies the text and the style, and offsets the copy so it is visible', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    byId(id).style.size = 42;
    const copy = byId(duplicateBox(id));
    expect(boxText(copy)).toBe('typed');
    expect(copy.style.size).toBe(42);
    expect([copy.x, copy.y]).toEqual([byId(id).x + 16, byId(id).y + 16]);
    expect([copy.w, copy.h]).toEqual([byId(id).w, byId(id).h]);
    // A copy, not a shared reference: restyling one must not restyle the other.
    expect(copy.style).not.toBe(byId(id).style);
  });

  // Two boxes on one imported line is the state `firstUnplaced` and
  // `placeActiveAt` are written to prevent, so the copy is always free-typed -
  // carrying the line's text and type across so it reads the same.
  it('gives the copy a free line of its own rather than a second box on an imported one', () => {
    placeActiveAt(100, 100);
    const id = page().boxes[0].id;
    const copy = byId(duplicateBox(id));
    expect(copy.lineN).toBeLessThan(0);
    expect(boxText(copy)).toBe('DON');
    const ln = lineByN(page(), copy.lineN);
    expect([ln.type, ln.jp, ln.en]).toEqual(['sfx', 'ドン', 'DON']);
    // The imported line still has exactly one box on it.
    expect(page().boxes.filter((b) => b.lineN === 1).length).toBe(1);
  });

  // The copy used to carry `src.text` across. For a queue-placed box that had
  // overridden its line that left the copy - a free box, whose writes go to its
  // line - showing a non-null `text` that no edit could reach: type into the
  // copy and it snapped back to the original's words on the next render.
  it('lets the copy be edited on its own when the original overrides its line', () => {
    placeActiveAt(100, 100);
    const src = page().boxes[0];
    setBoxText(src, 'OVERRIDE');
    expect(src.text).toBe('OVERRIDE');
    const copy = byId(duplicateBox(src.id));
    expect(copy.text).toBe(null);
    expect(boxText(copy)).toBe('OVERRIDE');
    setBoxText(copy, 'NEW WORDS');
    expect(boxText(copy)).toBe('NEW WORDS');
    expect(boxText(src)).toBe('OVERRIDE');
  });

  it('keeps the copy on the page when the original is already against the edge', () => {
    const id = addEmptyBox(10000, 10000);
    endEdit('edge');
    const src = { x: byId(id).x, y: byId(id).y };
    const copy = byId(duplicateBox(id));
    expect([copy.x, copy.y]).toEqual([src.x, src.y]);
    expect(copy.x + copy.w).toBeLessThanOrEqual(800);
    expect(copy.y + copy.h).toBeLessThanOrEqual(1200);
  });

  it('selects the copy, and defaults to whatever is selected', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    app.selectedId = id;
    const copyId = duplicateBox();
    expect(copyId).not.toBe(id);
    expect(app.selectedId).toBe(copyId);
  });

  it('refuses in a translate chapter, and with nothing to copy', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    expect(duplicateBox('nosuchbox')).toBe(null);
    app.chapterMode = 'translate';
    expect(duplicateBox(id)).toBe(null);
    expect(page().boxes.length).toBe(1);
  });

  // One press of undo has to take both halves back, which is what the `place`
  // kind's line fields are for - see history.svelte.js.
  it('records one entry, carrying the line it created', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    const log = [];
    const off = setRecorder((e) => log.push(e));
    const copyId = duplicateBox(id);
    off();
    expect(log.length).toBe(1);
    expect(log[0].t).toBe('place');
    expect(log[0].box.id).toBe(copyId);
    expect(log[0].line.n).toBe(byId(copyId).lineN);
  });
});

describe('nudging a box with the arrow keys', () => {
  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [] }]);
  });

  const aBox = () => {
    const id = addEmptyBox(400, 600);
    endEdit('typed');
    return id;
  };

  it('moves by the step it is given', () => {
    const id = aBox();
    const { x, y } = byId(id);
    nudgeBox(id, 1, 0);
    nudgeBox(id, 0, -10);
    expect([byId(id).x, byId(id).y]).toEqual([x + 1, y - 10]);
  });

  // A run of presses is one gesture. The history is five steps deep, so an entry
  // per keypress would empty it before the user finished moving one box.
  it('coalesces a run into a single move entry', () => {
    const id = aBox();
    const { x } = byId(id);
    const log = [];
    const off = setRecorder((e) => log.push(e));
    nudgeBox(id, 1, 0);
    nudgeBox(id, 1, 0);
    nudgeBox(id, 1, 0);
    expect(log.length).toBe(0);
    settleEdits();
    off();
    expect(log.length).toBe(1);
    expect(log[0].t).toBe('move');
    expect(log[0].before.x).toBe(x);
    expect(log[0].after.x).toBe(x + 3);
  });

  // The drag's bounds, not the page's: a box hung off the edge on purpose must
  // not jump back on at the first arrow press.
  it('stops where a drag would stop', () => {
    const id = aBox();
    byId(id).x = 780;
    nudgeBox(id, 10, 0);
    expect(byId(id).x).toBe(780);
    expect(nudgeBox(id, 10, 0)).toBe(false);
  });

  it('does nothing in a translate chapter', () => {
    const id = aBox();
    const { x } = byId(id);
    app.chapterMode = 'translate';
    expect(nudgeBox(id, 5, 0)).toBe(false);
    expect(byId(id).x).toBe(x);
  });
});

describe('nudging a box across longstrip source seams', () => {
  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
    app.projectLayout = 'longstrip';
    loadProjectPages([
      { id: 1, w: 800, h: 100, lines: [], boxes: [] },
      { id: 2, w: 800, h: 200, lines: [], boxes: [] },
    ]);
  });

  afterEach(() => {
    settleEdits();
    app.projectLayout = 'pages';
  });

  it('moves an owner-page box into the next source image', () => {
    const id = addEmptyBox(400, 80);
    endEdit('typed');
    const b = byId(id);
    b.y = 80;
    expect(nudgeBox(id, 0, 60)).toBe(true);
    expect(b.y).toBe(140);
  });

  it('moves a box on the second image upward across its owner seam', () => {
    gotoPage(1);
    const id = addEmptyBox(400, 20);
    endEdit('typed');
    const b = byId(id);
    b.y = 20;
    expect(nudgeBox(id, 0, -120)).toBe(true);
    expect(b.y).toBe(-100);
  });
});

// The blur or the Escape with no typing in it, which used to be an edit.
describe('ending an inline edit that changed nothing', () => {
  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Hello' }], boxes: [] },
    ]);
  });

  const placed = () => {
    activateLine(1);
    placeActiveAt(100, 100);
    return page().boxes[0];
  };

  // A queue-placed box owns no text: `b.text` is null on purpose, so `boxText`
  // resolves through the line and the queue's textarea keeps reaching the
  // canvas. `editBefore` is that same null, while the editable hands back the
  // string it was *displaying* - the line's. Compared as they stand, an
  // untouched blur reads as "null became 'Hello'", writes that string onto the
  // box as an override and detaches it from its line for good.
  it('leaves a queue-placed box reading its line, and records nothing', () => {
    const b = placed();
    beginEdit(b.id);
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      endEdit(boxText(b));
    } finally {
      off();
    }
    expect(b.text).toBe(null);
    expect(log).toEqual([]);
    // The whole of the claim: it is still following the queue.
    page().lines[0].en = 'Goodbye';
    expect(boxText(b)).toBe('Goodbye');
  });

  it('still writes the override when the user actually typed', () => {
    const b = placed();
    beginEdit(b.id);
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      endEdit('Hello there');
    } finally {
      off();
    }
    expect(b.text).toBe('Hello there');
    expect(log.map((e) => e.t)).toEqual(['text']);
  });

  // A free-typed box keeps its text on its line, so `boxOwnText` already reads
  // the same field on both sides of an edit. The guard must not reach it.
  it('does not swallow an edit to a free-typed box', () => {
    const id = addEmptyBox(100, 100);
    endEdit('typed');
    expect(boxText(byId(id))).toBe('typed');
  });
});

// The button at the foot of the queue has no page coordinates to hand over -
// it lives in a panel floating over a canvas that may be zoomed into any
// corner. The page's own centre is off-screen at that zoom, and a box the user
// cannot see is a box they cannot type into.
describe('visiblePageCenter', () => {
  const p = { w: 1000, h: 2000 };
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

  it('centres on the visible part of the page, not on the page', () => {
    // The frame is drawn at 2x from (-500,-1000), so the page's own centre sits
    // at client (500, 1000) - outside a viewport that only shows the top-left.
    const got = visiblePageCenter(p, rect(0, 0, 400, 400), rect(-500, -1000, 1500, 3000), 2);
    expect(got).toEqual({ x: 350, y: 600 });
  });

  it('is the page centre when the whole page is in view', () => {
    expect(visiblePageCenter(p, rect(0, 0, 2000, 3000), rect(0, 0, 1000, 2000), 1)).toEqual({ x: 500, y: 1000 });
  });

  it('falls back to the page centre with nothing to measure', () => {
    expect(visiblePageCenter(p, null, null, 1)).toEqual({ x: 500, y: 1000 });
    expect(visiblePageCenter(p, rect(0, 0, 100, 100), rect(0, 0, 100, 100), 0)).toEqual({ x: 500, y: 1000 });
  });

  // Not a viewport at all. Measured against an empty intersection the box lands
  // at whichever edge the page was dragged past.
  it('falls back when the page is scrolled entirely out of view', () => {
    expect(visiblePageCenter(p, rect(0, 0, 400, 400), rect(900, 900, 1900, 2900), 1)).toEqual({ x: 500, y: 1000 });
  });

  // A page that has never been measured has w/h of 0 - see `hasPageSpace`.
  it('uses the default page size for a page with no space yet', () => {
    expect(visiblePageCenter({ w: 0, h: 0 }, null, null, 1)).toEqual({ x: PAGE_W / 2, y: PAGE_H / 2 });
  });
});

// ===== the chapter's workflow mode =====
// `app.chapterMode` mirrors the open chapter's `mode` field. Everything the
// editor hides in translate mode is a `{#if}` over one derived boolean, which is
// not worth a DOM test; what IS worth testing is the two things that are not
// presentational - the tool the mode allows, and the fact that no code path can
// still add a box.
describe('translate mode', () => {
  const withLines = (lines) => [{ id: 1, w: 800, h: 1200, lines, boxes: [] }];

  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
    setTool('place');
    loadProjectPages(withLines([]));
  });
  afterEach(() => {
    app.chapterMode = 'typeset';
    setTool('place');
  });

  it('normalises anything that is not one of the two names to typeset', () => {
    expect(CHAPTER_MODES).toEqual(['typeset', 'translate']);
    expect(normalizeChapterMode('translate')).toBe('translate');
    expect(normalizeChapterMode('typeset')).toBe('typeset');
    // What a chapter.json written before this field existed, or hand-edited,
    // can hand over. None of these may leave a chapter in a mode the editor
    // does not implement.
    for (const bad of [undefined, null, '', 'Translate', 'clean', 0, {}]) {
      expect(normalizeChapterMode(bad)).toBe('typeset');
    }
  });

  it('leaves the hand as the only tool the rail and the keyboard can reach', () => {
    setTool('pan');
    app.chapterMode = 'translate';
    expect(isTranslateMode()).toBe(true);
    // v and t both come through here, so refusing here is what makes them
    // no-ops without a second guard in the keydown handler.
    setTool('place');
    setTool('text');
    expect(app.tool).toBe('pan');
    // And the way back is not blocked: a chapter switched to typeset while it
    // is open gets its tools back with no further ceremony.
    app.chapterMode = 'typeset';
    setTool('place');
    expect(app.tool).toBe('place');
  });

  it('adds no box, whichever entry point is called', () => {
    app.chapterMode = 'translate';
    expect(addEmptyBox(100, 100)).toBe(null);
    expect(page().boxes).toHaveLength(0);
    // And no line either: `addEmptyBox` creates the pair, so a guard that let
    // the line through would leave an unbacked row in the queue for ever.
    expect(page().lines).toHaveLength(0);

    loadProjectPages(withLines([{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }]));
    app.chapterMode = 'translate';
    activateLine(1);
    placeActiveAt(100, 100);
    expect(page().boxes).toHaveLength(0);
  });

  it('disallows deleting boxes in translate mode', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }],
        boxes: [{ id: 'b1', lineN: 1, text: 'Ah', x: 0, y: 0, w: 10, h: 10, style: defaultStyle() }],
      },
    ]);
    app.chapterMode = 'translate';
    deleteBox('b1');
    expect(page().boxes).toHaveLength(1);
  });

  it('arms the active line without selecting canvas boxes on row click', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }],
        boxes: [{ id: 'b1', lineN: 1, text: null, x: 10, y: 10, w: 100, h: 50, style: {} }],
      },
    ]);
    app.chapterMode = 'translate';
    expect(app.selectedId).toBe(null);

    activateLine(1);
    expect(page().activeLineN).toBe(1);
    expect(app.selectedId).toBe(null);

    // In typeset mode, activating the line selects its box
    app.chapterMode = 'typeset';
    activateLine(1);
    expect(page().activeLineN).toBe(1);
    expect(app.selectedId).toBe('b1');
  });

  it('appends a free line with negative n, sets activeLineN, and creates no box when addQueueLine is called', () => {
    loadProjectPages(withLines([{ n: 1, type: 'dialogue', jp: 'あ', en: 'Ah' }]));
    app.chapterMode = 'translate';
    markSaved();
    const n = addQueueLine();
    expect(n).toBe(-1);
    expect(page().lines).toHaveLength(2);
    expect(page().lines[1]).toEqual({ n: -1, type: 'dialogue', jp: '', en: '' });
    expect(page().activeLineN).toBe(-1);
    expect(page().boxes).toHaveLength(0);
    expect(app.saved).toBe(false);

    const n2 = addQueueLine();
    expect(n2).toBe(-2);
    expect(page().lines).toHaveLength(3);
    expect(page().lines[2]).toEqual({ n: -2, type: 'dialogue', jp: '', en: '' });
    expect(page().activeLineN).toBe(-2);
  });

  it('returns null from addQueueLine when no pages are loaded', () => {
    app.pages = [];
    expect(addQueueLine()).toBe(null);
  });
});

// The translate workspace's progress badge. Derived from the lines, never
// stored - see `translatedCount`.
describe('the translated count', () => {
  it('counts a line as done once it has English on it', () => {
    expect(isTranslated({ n: 1, en: 'Ah' })).toBe(true);
    expect(isTranslated({ n: 1, en: '' })).toBe(false);
    expect(isTranslated({ n: 1 })).toBe(false);
    expect(isTranslated(null)).toBe(false);
  });

  it('does not count whitespace as a translation', () => {
    expect(isTranslated({ n: 1, en: '   ' })).toBe(false);
    expect(isTranslated({ n: 1, en: '\n\t' })).toBe(false);
  });

  // The legacy fields `lineText` already resolves through. A chapter saved under
  // the old schema has its translation in `natural`, and it is translated.
  it('reads the legacy text fields the rest of the app reads', () => {
    expect(isTranslated({ n: 1, natural: 'Ah' })).toBe(true);
  });

  it('counts a page', () => {
    expect(translatedCount([{ n: 1, en: 'Ah' }, { n: 2, en: '' }, { n: 3, en: 'Oh' }])).toBe(2);
    expect(translatedCount([])).toBe(0);
    expect(translatedCount(null)).toBe(0);
  });
});

// The reference sidebar's zoom. Both the buttons and the wheel multiply through
// `rawZoomBy`, so the Fit floor and the ceiling are written once.
describe('the raw reference zoom', () => {
  beforeEach(() => {
    app.rawZoom = 0;
  });
  afterEach(() => {
    app.rawZoom = 0;
  });

  it('treats 0 as Fit on the way up, so the first step in is a real zoom', () => {
    rawZoomIn();
    expect(app.rawZoom).toBeCloseTo(1.25);
  });

  // Fit is the floor, so the press that means "smaller than this" has nowhere
  // to go. It used to read Fit as 1x and step down to 0.8 - the sidebar visibly
  // shrinking below the fit it was already at, and jumping back to Fit on the
  // press after.
  it('stays at Fit when zoomed out from Fit', () => {
    rawZoomOut();
    expect(app.rawZoom).toBe(0);
    rawZoomBy(0.5);
    expect(app.rawZoom).toBe(0);
    // And the way up out of Fit is untouched: that is what reading 0 as 1x is
    // for.
    rawZoomIn();
    expect(app.rawZoom).toBeCloseTo(1.25);
  });

  it('lands back on Fit rather than shrinking below it', () => {
    app.rawZoom = 0.35;
    rawZoomOut();
    expect(app.rawZoom).toBe(0);
  });

  it('takes a continuous factor from the wheel and keeps the same floor', () => {
    app.rawZoom = 2;
    rawZoomBy(1.1);
    expect(app.rawZoom).toBeCloseTo(2.2);
    rawZoomBy(0.05);
    expect(app.rawZoom).toBe(0);
  });

  // A trackpad pinch arrives as a stream of deltas and would otherwise run the
  // zoom off into the thousands in one flick.
  it('will not zoom past the ceiling', () => {
    app.rawZoom = 7;
    rawZoomBy(100);
    expect(app.rawZoom).toBe(RAW_ZOOM_MAX);
  });
});

// ===========================================================================
// The project's page layout
// ===========================================================================
// A longstrip project draws every page of the chapter as one scrolling column,
// so the page under the pointer is no longer the page the index is on. These
// cover the flag itself and the two entry points that had to stop assuming
// otherwise - the store half of it; the canvas resolves the frame.
describe('the project layout flag', () => {
  afterEach(() => {
    app.projectLayout = 'pages';
  });

  it('knows exactly two layouts', () => {
    expect(LAYOUTS).toEqual(['pages', 'longstrip']);
  });

  // Every project.json written before the flag existed has no `layout` key at
  // all, and every one of them is a paged project.
  it('reads anything unrecognised, absent included, as pages', () => {
    expect(normalizeLayout(undefined)).toBe('pages');
    expect(normalizeLayout(null)).toBe('pages');
    expect(normalizeLayout('webtoon')).toBe('pages');
    expect(normalizeLayout('longstrip')).toBe('longstrip');
    expect(normalizeLayout('pages')).toBe('pages');
  });

  it('answers isLongstrip from the open project, and defaults to no', () => {
    expect(isLongstrip()).toBe(false);
    app.projectLayout = 'longstrip';
    expect(isLongstrip()).toBe(true);
  });
});

describe('the project OCR language', () => {
  it('accepts exactly the supported language codes', () => {
    expect(OCR_LANGUAGES).toEqual(['ja', 'zh', 'ko']);
    expect(normalizeOcrLanguage('ja')).toBe('ja');
    expect(normalizeOcrLanguage('zh')).toBe('zh');
    expect(normalizeOcrLanguage('ko')).toBe('ko');
  });

  it('treats missing and unknown values as Japanese for old projects', () => {
    expect(normalizeOcrLanguage(undefined)).toBe('ja');
    expect(normalizeOcrLanguage(null)).toBe('ja');
    expect(normalizeOcrLanguage('chinese')).toBe('ja');
  });
});

describe('editing a page other than the one the index is on', () => {
  const twoPages = () => [
    { id: 1, w: 800, h: 1200, lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'one' }], boxes: [] },
    { id: 2, w: 800, h: 1200, lines: [{ n: 1, type: 'dialogue', jp: 'い', en: 'two' }], boxes: [] },
  ];

  beforeEach(() => {
    app.chapterRef = null;
    app.projectLayout = 'longstrip';
    loadProjectPages(twoPages());
    gotoPage(0);
  });

  afterEach(() => {
    app.projectLayout = 'pages';
  });

  it('places the box on the page it was handed', () => {
    placeActiveAt(100, 100, app.pages[1]);
    expect(app.pages[0].boxes).toHaveLength(0);
    expect(app.pages[1].boxes).toHaveLength(1);
  });

  // The live undo stack, the selection the inspector reads and the queue on
  // screen are all scoped to the current page, so an edit on another one has to
  // take the index with it or the record is filed against a page nobody is on.
  it('takes the index with it, so the record and the selection agree', () => {
    placeActiveAt(100, 100, app.pages[1]);
    expect(app.pageIndex).toBe(1);
    expect(byId(app.selectedId)).toBeTruthy();
  });

  it('gives the box the line it found on THAT page, and advances that page\'s queue', () => {
    placeActiveAt(100, 100, app.pages[1]);
    expect(app.pages[1].boxes[0].lineN).toBe(1);
    // Its only line is placed now, so its queue parks on the last one rather
    // than on nothing - and its box is what proves the placement landed there.
    expect(isPlaced(app.pages[1], 1)).toBe(true);
    // Page one is untouched: its line is still waiting to be placed.
    expect(isPlaced(app.pages[0], 1)).toBe(false);
    expect(app.pages[0].activeLineN).toBe(1);
  });

  it('writes a free-typed box and its line onto the target page too', () => {
    const id = addEmptyBox(120, 120, app.pages[1]);
    expect(app.pages[0].lines).toHaveLength(1);
    expect(app.pages[1].lines).toHaveLength(2);
    expect(app.pages[1].boxes.map((b) => b.id)).toEqual([id]);
    expect(app.pageIndex).toBe(1);
  });

  // The paged call site passes no target at all, and must go on meaning "the
  // page on screen" down to the character.
  it('still means the current page when no target is given', () => {
    gotoPage(1);
    placeActiveAt(100, 100);
    expect(app.pages[1].boxes).toHaveLength(1);
    expect(app.pages[0].boxes).toHaveLength(0);
    addEmptyBox(200, 200);
    expect(app.pages[1].boxes).toHaveLength(2);
  });

  describe('focusPage', () => {
    it('moves the index onto the page it is handed', () => {
      focusPage(app.pages[1]);
      expect(app.pageIndex).toBe(1);
    });

    it('does nothing for the page already current, or for one not in the document', () => {
      focusPage(app.pages[0]);
      expect(app.pageIndex).toBe(0);
      focusPage({ id: 99, boxes: [], lines: [] });
      expect(app.pageIndex).toBe(0);
      focusPage(null);
      expect(app.pageIndex).toBe(0);
    });
  });
});

// The keyboard's straighten-this-box. The Inspector's 0° button writes through
// its own settle timer; this is the same edit arriving from outside the panel,
// which means it has to record its history entry itself.
describe('resetBoxRotation', () => {
  const rotated = (deg) =>
    loadProjectPages([
      pageWith([
        box('b1', { style: { ...normalizeStyle({}), rotation: deg } }),
        box('b2', { style: { ...normalizeStyle({}), rotation: 0 } }),
      ]),
    ]);

  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
    rotated(37);
    app.selectedId = 'b1';
  });
  afterEach(() => {
    app.chapterMode = 'typeset';
  });

  it('zeroes the rotation and records one style entry', () => {
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      expect(resetBoxRotation('b1')).toBe(true);
      expect(byId('b1').style.rotation).toBe(0);
      expect(log).toHaveLength(1);
      expect(log[0].t).toBe('style');
      expect(log[0].boxId).toBe('b1');
      // The undo has to know where it is going back to, and the fit fields have
      // to be there or the style kind cannot restore the box. All five of them:
      // the containment ladder (contain.js) may widen a box, move it sideways
      // and shrink its font as well as grow it, so `fitGeom` is x/y/w/h and the
      // size, where it used to be the height and its anchor alone.
      expect(log[0].before.rotation).toBe(37);
      expect(log[0].after.rotation).toBe(0);
      const size = normalizeStyle({}).size;
      expect(log[0].geomBefore).toEqual({ x: 0, y: 0, w: 10, h: 10, size });
      expect(log[0].geomAfter).toEqual({ x: 0, y: 0, w: 10, h: 10, size });
    } finally {
      off();
    }
  });

  it('defaults to the selected box', () => {
    expect(resetBoxRotation()).toBe(true);
    expect(byId('b1').style.rotation).toBe(0);
  });

  it('records nothing for a box that is already straight, or is not there', () => {
    const log = [];
    const off = setRecorder((e) => log.push(e));
    try {
      expect(resetBoxRotation('b2')).toBe(false);
      expect(resetBoxRotation('nope')).toBe(false);
      expect(log).toHaveLength(0);
    } finally {
      off();
    }
  });

  it('does nothing in a translate chapter, which has no boxes to straighten', () => {
    app.chapterMode = 'translate';
    expect(resetBoxRotation('b1')).toBe(false);
    expect(byId('b1').style.rotation).toBe(37);
  });
});

// ---------------------------------------------------------------------------
// The five typesetting flags used to be a switch each in the Inspector, on the
// box you had selected. They are one set of defaults now, set in Settings, and
// what this describes is the precedence that replaced the switches: the
// preference decides what a NEW box is born with, `lastStyle` keeps carrying
// everything else, and no box already on the page is touched by either.
describe('the typesetting defaults a new box is born with', () => {
  const withLines = (lines) => [{ id: 1, w: 800, h: 1200, lines, boxes: [] }];
  const DEFAULTS = {
    defaultAutoHeight: true,
    defaultShape: true,
    defaultHyphenate: true,
    defaultBalloon: true,
    defaultMinOrphan: 3,
  };

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(withLines([{ n: 1, type: 'dialogue', jp: 'あ', en: 'ah' }]));
    app.lastStyle = defaultStyle();
  });
  // Preferences are app-wide and this file does not run alone, so every case
  // puts all five back rather than the one it changed.
  afterEach(() => {
    for (const [k, v] of Object.entries(DEFAULTS)) setPref(k, v);
  });

  it('seeds a typed box from the preferences', () => {
    setPref('defaultAutoHeight', false);
    setPref('defaultShape', false);
    setPref('defaultMinOrphan', 6);
    const s = byId(addEmptyBox(100, 100)).style;
    expect(s.autoHeight).toBe(false);
    expect(s.shape).toBe('off');
    expect(s.minOrphan).toBe(6);
  });

  it('seeds a queue-placed box from them too', () => {
    setPref('defaultBalloon', false);
    setPref('defaultHyphenate', false);
    activateLine(1);
    placeActiveAt(100, 100);
    const s = page().boxes.at(-1).style;
    expect(s.balloon).toBe(false);
    expect(s.hyphenate).toBe(false);
  });

  // The precedence itself. `lastStyle` still carries the styling the user chose
  // by hand; it does not carry these five, because nothing in the Inspector
  // sets them any more and a stale one would be invisible.
  it('beats what lastStyle is carrying, and leaves the rest of lastStyle alone', () => {
    app.lastStyle = { ...defaultStyle(), autoHeight: false, size: 44, color: '#ff0000' };
    setPref('defaultAutoHeight', true);
    const s = byId(addEmptyBox(100, 100)).style;
    expect(s.autoHeight).toBe(true);
    expect(s.size).toBe(44);
    expect(s.color).toBe('#ff0000');
  });

  it('does not reach boxes that are already on the page', () => {
    const id = addEmptyBox(100, 100);
    expect(byId(id).style.autoHeight).toBe(true);
    setPref('defaultAutoHeight', false);
    expect(byId(id).style.autoHeight).toBe(true);
  });

  // The same guarantee, spelled out for the balloon switch specifically, because
  // it is the one whose Settings row reads like it changes the whole document:
  // a page typeset WITH balloon fit must not un-fit itself the moment the
  // preference is turned off for the next chapter. The measured `fit` has to
  // survive with it - the flag decides whether the fit is used, and a box that
  // kept the flag but lost the shape would lay out flat anyway.
  it('leaves balloon-fitted work alone when the preference is turned off', () => {
    const id = addEmptyBox(100, 100);
    byId(id).fit = { kind: 'ellipse', cx: 150, cy: 130, rx: 60, ry: 40 };
    expect(byId(id).style.balloon).toBe(true);

    setPref('defaultBalloon', false);

    expect(byId(id).style.balloon).toBe(true);
    expect(byId(id).fit).toEqual({ kind: 'ellipse', cx: 150, cy: 130, rx: 60, ry: 40 });
    // And the switch does reach the NEXT box, which is the whole of what it is for.
    expect(byId(addEmptyBox(400, 400)).style.balloon).toBe(false);
  });

  // A copy is a copy: `duplicateBox` takes its source's style whole, so a box
  // given a per-box override through the Bulk panel duplicates with it.
  it('is ignored by a duplicate, which copies its source', () => {
    const id = addEmptyBox(100, 100);
    byId(id).style.autoHeight = false;
    setPref('defaultAutoHeight', true);
    expect(byId(duplicateBox(id)).style.autoHeight).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `lastStyle` is what the next placed box inherits, and it used to be written
// by the Inspector's own edits and nothing else. Clicking a box did not adopt
// its style and neither did a rotate or a corner-resize on the canvas, so a
// letterer who clicked a box, shaped it, and placed the next one got the style
// of the box BEFORE it - the "one behind" this describes the fix for.
describe('the style the next placed box follows', () => {
  const chapter = () => [
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [
        { n: 1, type: 'dialogue', jp: 'あ', en: 'one' },
        { n: 2, type: 'dialogue', jp: 'い', en: 'two' },
        { n: 3, type: 'dialogue', jp: 'う', en: 'three' },
      ],
      boxes: [],
    },
  ];

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(chapter());
    app.lastStyle = defaultStyle();
  });

  const place = (n, x, y) => {
    activateLine(n);
    placeActiveAt(x, y);
    return page().boxes.at(-1);
  };

  // The gesture the user reported. `size` and `rotation` are the two the canvas
  // handles write - a corner drag scales the type, the rotation handle tilts it
  // - and both have to be on the box that is placed NEXT, not the one after.
  it('is the box just shaped by hand, not the one before it', () => {
    const a = place(1, 100, 100);
    // What the canvas gesture does, minus the pointer events: it writes the
    // style and then remembers it (see `startTransform` in TextBox.svelte).
    a.style.size = 48;
    a.style.rotation = 30;
    rememberStyle(a);

    const b = place(2, 300, 300);
    expect(b.style.size).toBe(48);
    expect(b.style.rotation).toBe(30);
  });

  // The second half: no edit at all, just a click. Selecting a box adopts it.
  it('is the box last clicked, even when nothing about it was changed', () => {
    const c = place(1, 100, 100);
    c.style.size = 40;
    c.style.rotation = -20;
    rememberStyle(c);
    // A second box, styled differently, is what `lastStyle` is carrying now.
    const other = place(2, 200, 200);
    other.style.size = 12;
    rememberStyle(other);

    // Back to C, by clicking it. Nothing else happens.
    selectBox(c.id);
    const d = place(3, 400, 400);
    expect(d.style.size).toBe(40);
    expect(d.style.rotation).toBe(-20);
  });

  // The other side of that rule: a selection the USER did not make must not
  // move `lastStyle`, or a tag's font would leak off the box it was placed on
  // and onto every box placed after it.
  it('is not moved by the selection that placing a box makes', () => {
    const a = place(1, 100, 100);
    a.style.size = 44;
    rememberStyle(a);
    const b = place(2, 200, 200);
    // B is selected now, and B's style IS A's - so the only way to tell the two
    // rules apart is to change B without telling anyone, and place a third.
    b.style.size = 7;
    const c = place(3, 300, 300);
    expect(c.style.size).toBe(44);
  });

  it('follows a typed box the same way', () => {
    const id = addEmptyBox(100, 100);
    byId(id).style.size = 36;
    rememberStyle(byId(id));
    expect(place(1, 300, 300).style.size).toBe(36);
  });

  it('does not propagate autoHeight: false from a remembered box to a newly placed or typed box', () => {
    const a = place(1, 100, 100);
    a.style.autoHeight = false;
    a.style.size = 32;
    rememberStyle(a);

    const b = place(2, 300, 300);
    expect(b.style.size).toBe(32);
    expect(b.style.autoHeight).toBe(true);

    const id = addEmptyBox(500, 500);
    expect(byId(id).style.size).toBe(32);
    expect(byId(id).style.autoHeight).toBe(true);
  });
});

describe('a box born from the brush board', () => {
  const ink = (x0 = 0, x1 = 50) => ({
    w: 60,
    h: 20,
    strokes: [{ brush: 'round', size: 10, pts: [[x0 + 5, 10, 1], [x1 + 5, 10, 1]] }],
  });
  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [] }]);
    initHistory();
    resetHistory();
  });

  it('makes a selected free box sized to the ink, centred where asked, ink on', () => {
    const id = addInkBox(ink(), 400, 600);
    const b = byId(id);
    expect(app.selectedId).toBe(id);
    expect([b.w, b.h]).toEqual([60, 20]);
    expect([b.x, b.y]).toEqual([370, 590]);
    expect(b.lineN).toBeLessThan(0);
    expect(b.text).toBeNull();
    expect(boxText(b)).toBe('');
    expect(b.style.ink.on).toBe(true);
    expect(b.style.ink.strokes).toHaveLength(1);
    expect(b.style.ink.strokes[0].pts[0]).toEqual([5, 10, 1]);
    expect(lineByN(page(), b.lineN).type).toBe('sfx');
  });

  it('clamps onto the page', () => {
    const b = byId(addInkBox(ink(), -500, 5000));
    expect([b.x, b.y]).toEqual([0, 1180]);
  });

  it('is one undo step that takes the box and its line together', () => {
    const id = addInkBox(ink(), 400, 600);
    const n = byId(id).lineN;
    undo();
    expect(byId(id)).toBeUndefined();
    expect(lineByN(page(), n)).toBeUndefined();
    redo();
    expect(byId(id)).toBeDefined();
    expect(lineByN(page(), n)).toBeDefined();
  });

  it('wears the finish it was placed with, and none otherwise', () => {
    // Not the text default's white outline: the strokes and shadows wrap the
    // ink, so an ink box gets exactly what the board was showing.
    const plain = byId(addInkBox(ink(), 400, 600));
    expect(plain.style.strokes).toEqual([]);
    expect(plain.style.shadows).toEqual([]);
    const finish = { strokes: [{ color: '#ff0000', width: 5 }, { width: 0 }], shadows: [{ x: 2, y: 3 }] };
    const b = byId(addInkBox({ ...ink(), finish }, 400, 600));
    expect(b.style.strokes).toEqual([{ color: '#ff0000', width: 5, opacity: 1 }]);
    expect(b.style.shadows).toHaveLength(1);
    expect(b.style.shadows[0]).toMatchObject({ x: 2, y: 3 });
  });

  it('refuses an empty placement and a translate chapter', () => {
    expect(addInkBox({ w: 10, h: 10, strokes: [] }, 1, 1)).toBeNull();
    app.chapterMode = 'translate';
    expect(addInkBox(ink(), 1, 1)).toBeNull();
    expect(page().boxes).toHaveLength(0);
  });
});

describe('setBoxInk', () => {
  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [] }]);
    initHistory();
    resetHistory();
  });

  it('replaces the ink as one style step, leaving the geometry alone', () => {
    const id = addInkBox({ w: 60, h: 20, strokes: [{ brush: 'round', size: 10, pts: [[5, 10, 1], [55, 10, 1]] }] }, 400, 600);
    const geom = { x: byId(id).x, y: byId(id).y, w: byId(id).w, h: byId(id).h };
    expect(setBoxInk(1, id, [{ brush: 'round', size: 4, pts: [[1, 1, 1], [2, 2, 1]] }, { pts: [] }])).toBe(true);
    const b = byId(id);
    expect(b.style.ink.strokes).toHaveLength(1);
    expect(b.style.ink.strokes[0].size).toBe(4);
    expect({ x: b.x, y: b.y, w: b.w, h: b.h }).toEqual(geom);
    undo();
    expect(byId(id).style.ink.strokes[0].size).toBe(10);
  });

  it('applying the same ink again records nothing', () => {
    const k = { brush: 'round', size: 10, pts: [[5, 10, 1], [55, 10, 1]] };
    const id = addInkBox({ w: 60, h: 20, strokes: [k] }, 400, 600);
    const dirty = app.unsaved;
    expect(setBoxInk(1, id, [k])).toBe(true);
    // One undo takes the placement away, not a no-op style entry first.
    undo();
    expect(byId(id)).toBeUndefined();
    void dirty;
  });

  it('a list of empty strokes places nothing and leaves no line behind', () => {
    const lines = page().lines.length;
    expect(addInkBox({ w: 10, h: 10, strokes: [{ pts: [] }, null] }, 1, 1)).toBeNull();
    expect(page().boxes).toHaveLength(0);
    expect(page().lines).toHaveLength(lines);
    expect(addInkBox({ w: undefined, h: 'x', strokes: [{ brush: 'round', size: 4, pts: [[1, 1, 1]] }] }, 1, 1)).not.toBeNull();
    const b = page().boxes[0];
    expect([b.w, b.h]).toEqual([1, 1]);
  });

  it('no strokes switches the ink off, and an unknown box is refused', () => {
    const id = addInkBox({ w: 60, h: 20, strokes: [{ brush: 'round', size: 10, pts: [[5, 10, 1], [55, 10, 1]] }] }, 400, 600);
    expect(setBoxInk(1, id, [])).toBe(true);
    expect(byId(id).style.ink.on).toBe(false);
    expect(setBoxInk(1, 'nope', [])).toBe(false);
    expect(setBoxInk(99, id, [])).toBe(false);
  });
});

describe('resizeBox', () => {
  beforeEach(() => {
    app.chapterRef = null;
    app.chapterMode = 'typeset';
    loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [] }]);
    initHistory();
    resetHistory();
  });

  it('scales ink strokes proportionally when resized', () => {
    const id = addInkBox(
      { w: 60, h: 20, strokes: [{ brush: 'round', size: 10, pts: [[5, 10, 1], [55, 10, 1]] }] },
      400,
      600
    );
    const b = byId(id);
    expect(resizeBox(1, id, { w: 120, h: 40 })).toBe(b);
    expect([b.w, b.h]).toEqual([120, 40]);
    expect(b.style.ink.strokes[0].size).toBe(20);
    expect(b.style.ink.strokes[0].pts).toEqual([[10, 20, 1], [110, 20, 1]]);
  });

  it('scales only the modified axis when an edge is resized', () => {
    const id = addInkBox(
      { w: 60, h: 20, strokes: [{ brush: 'round', size: 10, pts: [[5, 10, 1], [55, 10, 1]] }] },
      400,
      600
    );
    const b = byId(id);
    resizeBox(1, id, { w: 120 });
    expect([b.w, b.h]).toEqual([120, 20]);
    expect(b.style.ink.strokes[0].pts).toEqual([[10, 10, 1], [110, 10, 1]]);
    expect(b.style.ink.strokes[0].size).toBeCloseTo(10 * Math.SQRT2);
  });

  it('keeps ink identical when the box is only moved', () => {
    const id = addInkBox(
      { w: 60, h: 20, strokes: [{ brush: 'round', size: 10, pts: [[5, 10, 1], [55, 10, 1]] }] },
      400,
      600
    );
    const b = byId(id);
    const ptsBefore = structuredClone(b.style.ink.strokes[0].pts);
    resizeBox(1, id, { x: 500, y: 700 });
    expect([b.x, b.y]).toEqual([500, 700]);
    expect([b.w, b.h]).toEqual([60, 20]);
    expect(b.style.ink.strokes[0].size).toBe(10);
    expect(b.style.ink.strokes[0].pts).toEqual(ptsBefore);
  });

  it('supports base snapshot for continuous handle dragging', () => {
    const id = addInkBox(
      { w: 60, h: 20, strokes: [{ brush: 'round', size: 10, pts: [[5, 10, 1], [55, 10, 1]] }] },
      400,
      600
    );
    const b = byId(id);
    const base = { w: 60, h: 20, ink: cloneStyle(b.style).ink };
    resizeBox(1, id, { w: 120, h: 40 }, base);
    expect([b.w, b.h]).toEqual([120, 40]);
    expect(b.style.ink.strokes[0].pts[0]).toEqual([10, 20, 1]);
    resizeBox(1, id, { w: 60, h: 20 }, base);
    expect([b.w, b.h]).toEqual([60, 20]);
    expect(b.style.ink.strokes[0].pts[0]).toEqual([5, 10, 1]);
    expect(b.style.ink.strokes[0].size).toBe(10);
  });

  it('returns null when box is not found', () => {
    expect(resizeBox(1, 'nonexistent', { w: 100 })).toBeNull();
  });
});


// ===========================================================================
// Font size remembered per primary tag
// ===========================================================================
describe('font size remembered per tag', () => {
  const chapter = () => [
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [
        { n: 1, type: 'dialogue', jp: 'one', en: '' },
        { n: 2, type: 'sfx', jp: 'two', en: '', tags: ['sfx'] },
        { n: 3, type: 'dialogue', jp: 'three', en: '' },
        { n: 4, type: 'sfx', jp: 'four', en: '', tags: ['sfx'] },
      ],
      boxes: [],
    },
  ];

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(chapter());
    app.lastStyle = defaultStyle();
    tags.sizes = {};
  });

  it('remembers size per tag: untagged takes untagged size, sfx takes sfx size', () => {
    activateLine(1);
    placeActiveAt(100, 100);
    const b1 = page().boxes.find((b) => b.lineN === 1);
    b1.style.size = 30;
    rememberStyle(b1);

    activateLine(2);
    placeActiveAt(200, 200);
    const b2 = page().boxes.find((b) => b.lineN === 2);
    b2.style.size = 60;
    rememberStyle(b2);

    activateLine(3);
    placeActiveAt(300, 300);
    const b3 = page().boxes.find((b) => b.lineN === 3);
    expect(b3.style.size).toBe(30);

    activateLine(4);
    placeActiveAt(400, 400);
    const b4 = page().boxes.find((b) => b.lineN === 4);
    expect(b4.style.size).toBe(60);
  });

  it('a tag with no memory yet falls back to app.lastStyle.size', () => {
    app.lastStyle.size = 42;
    activateLine(2);
    placeActiveAt(100, 100);
    const b = page().boxes.find((b) => b.lineN === 2);
    expect(b.style.size).toBe(42);
  });

  it('addEmptyBox uses the untagged size', () => {
    tags.sizes[''] = 55;
    const id = addEmptyBox(100, 100);
    expect(byId(id).style.size).toBe(55);
  });

  it('restyleForBulk calls rememberSizeFor only when bulk mask includes size', () => {
    activateLine(1);
    placeActiveAt(100, 100);
    const b1 = page().boxes[0];

    initHistory();
    resetHistory();
    openBulk();
    toggleBulkTarget(b1.id);

    setBulkProp('color', true);
    app.bulk.style.color = '#123456';
    app.bulk.style.size = 77;
    applyBulk();
    expect(tags.sizes['']).toBeUndefined();

    openBulk();
    toggleBulkTarget(b1.id);
    setBulkProp('size', true);
    app.bulk.style.size = 77;
    applyBulk();
    expect(tags.sizes['']).toBe(77);
    closeBulk();
  });
});

// ===========================================================================
// Place every detected bubble on a page in one go
// ===========================================================================
describe('placeDetectedOnPage', () => {
  const withDetect = (lines, boxes) => [
    {
      id: 1,
      w: 1000,
      h: 2000,
      lines,
      boxes: [],
      detect: { panels: [], boxes },
    },
  ];

  beforeEach(() => {
    app.chapterRef = null;
    initHistory();
    resetHistory();
  });

  it('places two detected lines, centres boxes on their rects, sets activeLineN to null, and undoes/redoes', () => {
    loadProjectPages(
      withDetect(
        [
          { n: 1, jp: 'あ', en: '', type: 'dialogue' },
          { n: 2, jp: 'い', en: '', type: 'dialogue' },
        ],
        [
          { n: 1, box: [100, 100, 500, 300], vertical: false, font_size: 20 },
          { n: 2, box: [200, 400, 600, 800], vertical: false, font_size: 20 },
        ],
      ),
    );

    const placedCount = placeDetectedOnPage();
    expect(placedCount).toBe(2);
    expect(page().boxes.length).toBe(2);

    const b1 = page().boxes.find((b) => b.lineN === 1);
    const b2 = page().boxes.find((b) => b.lineN === 2);
    expect([b1.x + b1.w / 2, b1.y + b1.h / 2]).toEqual([300, 200]);
    expect([b2.x + b2.w / 2, b2.y + b2.h / 2]).toEqual([400, 600]);

    expect(page().activeLineN).toBeNull();

    undo();
    expect(page().boxes.length).toBe(0);
    expect(page().lines[0].placed).toBe(false);
    expect(page().lines[1].placed).toBe(false);
    expect(page().activeLineN).toBe(1);

    redo();
    expect(page().boxes.length).toBe(2);
    expect(page().lines[0].placed).toBe(true);
    expect(page().lines[1].placed).toBe(true);
    expect(page().activeLineN).toBeNull();
  });

  it('skips a line already placed, leaves a line without geometry unplaced, and counts it in toast', () => {
    loadProjectPages(
      withDetect(
        [
          { n: 1, jp: 'あ', en: '', type: 'dialogue', placed: true },
          { n: 2, jp: 'い', en: '', type: 'dialogue' },
          { n: 3, jp: 'う', en: '', type: 'dialogue' },
        ],
        [
          { n: 1, box: [100, 100, 500, 300], vertical: false, font_size: 20 },
          { n: 2, box: [200, 400, 600, 800], vertical: false, font_size: 20 },
        ],
      ),
    );
    page().boxes.push({ id: 'b_prev', lineN: 1, text: null, x: 100, y: 100, w: 100, h: 50 });
    page().activeLineN = 2;

    expect(placeableDetectedLines(page()).map((l) => l.n)).toEqual([2]);

    const count = placeDetectedOnPage();
    expect(count).toBe(1);
    expect(page().boxes.length).toBe(2);

    expect(page().activeLineN).toBe(3);
    expect(page().lines.find((l) => l.n === 3).placed).toBeFalsy();
    expect(app.toast?.msg).toContain('1 left with no detected bubble');
  });
});

describe('placeDetectedInChapter', () => {
  const pageWith = (id, lines, boxes) => ({
    id,
    w: 1000,
    h: 2000,
    lines,
    boxes: [],
    detect: { panels: [], boxes },
  });

  beforeEach(() => {
    app.chapterRef = null;
    initHistory();
    resetHistory();
  });

  it('places every detected bubble on every page and leaves the reader where it started', () => {
    loadProjectPages([
      pageWith(
        1,
        [{ n: 1, jp: 'あ', en: '', type: 'dialogue' }],
        [{ n: 1, box: [100, 100, 500, 300], vertical: false, font_size: 20 }],
      ),
      pageWith(
        2,
        [
          { n: 1, jp: 'い', en: '', type: 'dialogue' },
          { n: 2, jp: 'う', en: '', type: 'dialogue' },
        ],
        [
          { n: 1, box: [0, 0, 200, 100], vertical: false, font_size: 20 },
          { n: 2, box: [300, 300, 700, 500], vertical: false, font_size: 20 },
        ],
      ),
    ]);
    const startIndex = app.pageIndex;

    expect(placeDetectedInChapter()).toBe(3);
    expect(app.pages[0].boxes.length).toBe(1);
    expect(app.pages[1].boxes.length).toBe(2);
    // No page turn: the batch reaches the other pages without moving the reader.
    expect(app.pageIndex).toBe(startIndex);
    expect(app.toast?.msg).toContain('3 boxes across 2 pages');
  });

  it('says so rather than doing nothing when every bubble already has a box', () => {
    loadProjectPages([
      pageWith(
        1,
        [{ n: 1, jp: 'あ', en: '', type: 'dialogue' }],
        [{ n: 1, box: [100, 100, 500, 300], vertical: false, font_size: 20 }],
      ),
    ]);
    expect(placeDetectedInChapter()).toBe(1);
    expect(placeDetectedInChapter()).toBe(0);
    expect(app.toast?.msg).toContain('No detected bubbles left to place in this chapter');
  });
});

describe('toggleBalloonFit', () => {
  beforeEach(() => {
    app.chapterRef = null;
    initHistory();
    resetHistory();
    loadProjectPages([{ id: 1, w: 1000, h: 2000, lines: [], boxes: [] }]);
  });

  it('flips the box\u2019s own switch both ways and never touches another box', () => {
    const id = addEmptyBox(100, 100);
    const other = addEmptyBox(400, 400);
    settleEdits();
    expect(byId(id).style.balloon).toBe(true);

    expect(toggleBalloonFit(id)).toBe(false);
    expect(byId(id).style.balloon).toBe(false);
    expect(byId(other).style.balloon).toBe(true);
    expect(app.toast?.msg).toContain('Balloon fit off');

    expect(toggleBalloonFit(id)).toBe(true);
    expect(byId(id).style.balloon).toBe(true);
    expect(app.toast?.msg).toContain('Balloon fit on');
  });

  it('records one style edit that undo takes back', () => {
    const id = addEmptyBox(100, 100);
    settleEdits();
    resetHistory();

    toggleBalloonFit(id);
    expect(byId(id).style.balloon).toBe(false);
    undo();
    expect(byId(id).style.balloon).toBe(true);
    redo();
    expect(byId(id).style.balloon).toBe(false);
  });

  it('answers false for a box that is not there', () => {
    expect(toggleBalloonFit('no_such_box')).toBe(false);
  });
});

// ===========================================================================
// Selecting a box on the canvas activates its line in the queue
// ===========================================================================
describe('canvas selection follows into the queue', () => {
  const chapter = () => [
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [
        { n: 1, type: 'dialogue', jp: 'one', en: 'one' },
        { n: 2, type: 'dialogue', jp: 'two', en: 'two' },
        { n: 3, type: 'dialogue', jp: 'three', en: 'three' },
      ],
      boxes: [],
    },
  ];
  const boxForLine = (n) => page().boxes.find((b) => b.lineN === n);

  beforeEach(() => {
    app.chapterRef = null;
    loadProjectPages(chapter());
    app.lastStyle = defaultStyle();
  });

  it('selectBox makes the box’s line the active one, as clicking its row does', () => {
    activateLine(1);
    placeActiveAt(100, 100);
    activateLine(2);
    placeActiveAt(200, 200);
    expect(page().activeLineN).toBe(3);
    selectBox(boxForLine(1).id);
    expect(page().activeLineN).toBe(1);
    selectBox(boxForLine(2).id);
    expect(page().activeLineN).toBe(2);
  });

  it('a selection made by undo/redo leaves the active line where the entry put it', () => {
    activateLine(1);
    placeActiveAt(100, 100);
    expect(page().activeLineN).toBe(2);
    selectBox(boxForLine(1).id, { activate: false });
    expect(page().activeLineN).toBe(2);
  });

  it('the Place tool never re-places the selected box’s line - it places the next unplaced one', () => {
    activateLine(1);
    placeActiveAt(100, 100);
    selectBox(boxForLine(1).id);
    expect(page().activeLineN).toBe(1);
    placeActiveAt(300, 300);
    expect(page().boxes.filter((b) => b.lineN === 1)).toHaveLength(1);
    expect(boxForLine(2)).toBeTruthy();
    expect(page().activeLineN).toBe(3);
  });

  it('with every line on the page, a click on the canvas only deselects', () => {
    activateLine(1);
    placeActiveAt(100, 100);
    placeActiveAt(200, 200);
    placeActiveAt(300, 300);
    // Every line placed: the tool has moved on and the active line is null, so
    // arm a placed row by hand the way a canvas click on its box does.
    selectBox(boxForLine(2).id);
    expect(page().activeLineN).toBe(2);
    placeActiveAt(400, 400);
    expect(page().boxes).toHaveLength(3);
    expect(app.selectedId).toBeNull();
  });
});
