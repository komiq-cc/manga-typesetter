import { describe, it, expect, beforeEach, vi } from 'vitest';

// ===========================================================================
// Locks, set and let go on purpose (FIT-5)
// ===========================================================================
// The lock chip and the Bulk panel only call the store, so this is where what
// they do is proved: which locks each command sets or clears, that each press
// is one undo step that puts the locks back exactly, that the Bulk panel's
// buttons reach every picked box (one step per page), and that a manual box -
// one the solver never lays out - is left alone.
//
// `canMeasure` is granted for the one test that runs Refit, as autofit.test.js
// grants it: the stand-in metric is deterministic, and the solver is the thing
// whose respect for the locks is being checked.
vi.mock('./measure.js', async (importOriginal) => ({
  ...(await importOriginal()),
  canMeasure: () => true,
}));

const {
  app,
  page,
  loadProjectPages,
  selectBox,
  openBulk,
  closeBulk,
  toggleBulkTarget,
  boxLocks,
  layoutLocked,
  lockableBox,
  setBoxLocks,
  unlockBoxes,
  lockBoxLayout,
  toggleLayoutLock,
  lockBulkTargets,
  refitBalloon,
} = await import('./store.svelte.js');
const hist = await import('./editor/history.svelte.js');

const NONE = { size: false, width: false, height: false, pos: false, breaks: false };
const auto = (locks = {}, refSize = 30) => ({ on: true, refSize, locks: { ...NONE, ...locks }, status: 'ok' });
const box = (id, extra = {}) => ({
  id,
  lineN: null,
  text: 'SOME WORDS TO SET',
  x: 100,
  y: 100,
  w: 120,
  h: 80,
  style: { size: 24 },
  fit: null,
  ...extra,
});

const doc = () => [
  {
    id: 1,
    w: 800,
    h: 1200,
    lines: [],
    boxes: [
      box('b1', { auto: auto({ size: true, width: true }) }),
      box('b2', { auto: auto({ width: true }) }),
      box('b3', { auto: auto() }),
      // Hand-drawn ink makes a box manual, whatever its record says.
      box('ink', {
        auto: auto({ size: true }),
        style: { size: 24, ink: { on: true, strokes: [{ pts: [[0, 0, 1], [10, 10, 1]], size: 4 }] } },
      }),
      // Sizing switched off: manual too.
      box('off', { auto: { ...auto({ width: true }), on: false } }),
    ],
  },
  {
    id: 2,
    w: 800,
    h: 1200,
    lines: [],
    boxes: [box('c1', { auto: auto({ size: true }) }), box('c2', { auto: auto({ width: true, pos: true }) })],
  },
];

const byId = (id) => app.pages.flatMap((p) => p.boxes).find((b) => b.id === id);
const locksOf = (id) => ({ ...byId(id).auto.locks });
const undoDepth = () => hist.peekStack().undo.length;

beforeEach(() => {
  app.chapterRef = null;
  closeBulk();
  hist.initHistory();
  loadProjectPages(doc());
  hist.resetHistory();
});

describe('what the chip reads', () => {
  it('shows only the locks a box has on, and nothing for a box with none', () => {
    expect(boxLocks(byId('b1'))).toEqual({ size: true, width: true });
    expect(boxLocks(byId('b2'))).toEqual({ width: true });
    expect(boxLocks(byId('b3'))).toBeNull();
    expect(layoutLocked(byId('b1'))).toBe(false);
  });

  it('shows nothing on a manual box, whatever its record says', () => {
    expect(lockableBox(byId('ink'))).toBe(false);
    expect(boxLocks(byId('ink'))).toBeNull();
    expect(lockableBox(byId('off'))).toBe(false);
    expect(boxLocks(byId('off'))).toBeNull();
  });
});

describe('setting and clearing locks', () => {
  it('sets a lock, and leaves the rest as they are', () => {
    expect(setBoxLocks('b3', { width: true })).toBe(1);
    expect(locksOf('b3')).toEqual({ ...NONE, width: true });
  });

  it('unlocks the size alone', () => {
    expect(unlockBoxes('b1', 'size')).toBe(1);
    expect(locksOf('b1')).toEqual({ ...NONE, width: true });
  });

  it('unlocks the width alone', () => {
    expect(unlockBoxes('b1', 'width')).toBe(1);
    expect(locksOf('b1')).toEqual({ ...NONE, size: true });
  });

  it('unlocks everything', () => {
    expect(unlockBoxes('c2', 'all')).toBe(1);
    expect(locksOf('c2')).toEqual(NONE);
    expect(boxLocks(byId('c2'))).toBeNull();
  });

  it('locks the layout as it stands: size, width, place and breaks, at the size on the box', () => {
    // A box the solver shrank: 24 on the page against a reference of 30. Held
    // at 30 it would jump back up at its next edit, so 24 becomes its reference.
    const b = byId('b3');
    const geom = { x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size };
    expect(lockBoxLayout('b3')).toBe(1);
    expect(locksOf('b3')).toEqual({ ...NONE, size: true, width: true, pos: true, breaks: true });
    expect(b.auto.refSize).toBe(24);
    expect(layoutLocked(b)).toBe(true);
    // Nothing is laid out again.
    expect({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size }).toEqual(geom);
  });

  it('lets the breaks go with the size or the width, which they hold', () => {
    lockBoxLayout('b3');
    unlockBoxes('b3', 'size');
    expect(locksOf('b3')).toEqual({ ...NONE, width: true, pos: true });
  });

  it('records nothing and moves nothing when the change changes nothing', () => {
    const b = byId('b1');
    const geom = { x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size };
    expect(unlockBoxes('b3', 'all')).toBe(0);
    expect(setBoxLocks('b1', { size: true })).toBe(0);
    expect(undoDepth()).toBe(0);
    unlockBoxes('b1', 'all');
    expect({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size }).toEqual(geom);
  });

  it('leaves a manual box alone', () => {
    expect(unlockBoxes(['ink', 'off'], 'all')).toBe(0);
    expect(lockBoxLayout(['ink', 'off'])).toBe(0);
    expect(locksOf('ink')).toEqual({ ...NONE, size: true });
    expect(locksOf('off')).toEqual({ ...NONE, width: true });
    expect(undoDepth()).toBe(0);
  });
});

describe('undo and redo', () => {
  it('makes every change one step that puts the locks back exactly', () => {
    unlockBoxes('b1', 'size');
    expect(undoDepth()).toBe(1);
    hist.undo();
    expect(locksOf('b1')).toEqual({ ...NONE, size: true, width: true });
    hist.redo();
    expect(locksOf('b1')).toEqual({ ...NONE, width: true });
  });

  it('puts the reference size back with the locks after a layout lock', () => {
    lockBoxLayout('b3');
    hist.undo();
    expect(locksOf('b3')).toEqual(NONE);
    expect(byId('b3').auto.refSize).toBe(30);
    hist.redo();
    expect(layoutLocked(byId('b3'))).toBe(true);
    expect(byId('b3').auto.refSize).toBe(24);
  });

  it('selects the box it changed', () => {
    selectBox('b2');
    unlockBoxes('b1', 'all');
    selectBox('b2');
    hist.undo();
    expect(app.selectedId).toBe('b1');
  });
});

describe('the keyboard switch', () => {
  it('locks the layout, and the second press lets every lock go', () => {
    selectBox('b1');
    expect(toggleLayoutLock()).toBe(true);
    expect(layoutLocked(byId('b1'))).toBe(true);
    expect(toggleLayoutLock()).toBe(true);
    expect(locksOf('b1')).toEqual(NONE);
    expect(undoDepth()).toBe(2);
  });

  it('refuses a manual box', () => {
    selectBox('ink');
    expect(toggleLayoutLock()).toBe(false);
    expect(undoDepth()).toBe(0);
  });
});

describe('the Bulk panel', () => {
  it('unlocks every picked box, skips the manual ones, one step per page', () => {
    openBulk();
    for (const id of ['b1', 'b2', 'ink', 'c1', 'c2']) toggleBulkTarget(id);
    expect(lockBulkTargets(false)).toBe(4);
    for (const id of ['b1', 'b2', 'c1', 'c2']) expect(locksOf(id)).toEqual(NONE);
    expect(locksOf('ink')).toEqual({ ...NONE, size: true });
    const entries = hist.peekStack().undo;
    expect(entries.map((e) => [e.t, e.pageId, e.items.length])).toEqual([
      ['locks', 1, 2],
      ['locks', 2, 2],
    ]);
    // Walked back one page at a time.
    hist.undo();
    expect(locksOf('c2')).toEqual({ ...NONE, width: true, pos: true });
    expect(locksOf('b1')).toEqual(NONE);
    hist.undo();
    expect(locksOf('b1')).toEqual({ ...NONE, size: true, width: true });
    expect(locksOf('b2')).toEqual({ ...NONE, width: true });
  });

  it('locks the layout of every picked box', () => {
    openBulk();
    for (const id of ['b2', 'b3', 'off']) toggleBulkTarget(id);
    expect(lockBulkTargets(true)).toBe(2);
    expect(layoutLocked(byId('b2'))).toBe(true);
    expect(layoutLocked(byId('b3'))).toBe(true);
    expect(locksOf('off')).toEqual({ ...NONE, width: true });
    // The panel stays open: a lock is not the style it is there to apply.
    expect(app.bulk.active).toBe(true);
  });

  it('does nothing with nothing picked', () => {
    openBulk();
    expect(lockBulkTargets(false)).toBe(0);
    expect(undoDepth()).toBe(0);
  });
});

describe('what Refit then does', () => {
  it('keeps a held layout, and lays the box out again once it is let go', () => {
    const b = byId('b3');
    // Somewhere the solver would never have put it, at a size it would not pick.
    Object.assign(b, { x: 37, y: 411, w: 260 });
    b.style.size = 19;
    lockBoxLayout('b3');
    refitBalloon('b3', page());
    expect([b.x, b.w, b.style.size]).toEqual([37, 260, 19]);
    unlockBoxes('b3', 'all');
    // Unlocking alone moved nothing.
    expect([b.x, b.w, b.style.size]).toEqual([37, 260, 19]);
    refitBalloon('b3', page());
    expect([b.x, b.w, b.style.size]).not.toEqual([37, 260, 19]);
  });
});
