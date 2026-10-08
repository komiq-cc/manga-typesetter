import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  app, loadProjectPages, page, pageById, setFontSource, noteFontsChanged, boxEdited, recordEdit, fitGeom, cloneStyle, moveBoxTo, moveGeom, resizeBox,
  placeActiveAt, fitHeld,
} from '../store.svelte.js';
import { initHistory, resetHistory, undo, redo, peekStack, record } from './history.svelte.js';
import { __setDir, switchHistoryPage, flushHistory } from './history-file.svelte.js';
import { textEngine, setTextEngine } from '../text-engine/index.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from '../measure.js';

// ===========================================================================
// A fit that lands after its edit was recorded is part of that edit's undo
// ===========================================================================
// With the Rust text engine measuring, a box whose face is still on its way is
// not fitted: the fit is held and runs when the face lands. The edit's history
// entry was recorded in between. These walk the history across that gap.
//
// The store's own hook stands in for the engine switch: a font source that
// says "not ready" until the test lets the face arrive, and an engine that
// measures by arithmetic. Nothing here needs the wasm.

vi.mock('../fsx.js', () => {
  const files = new Map();
  return {
    files,
    fsx: {
      join: async (...p) => p.join('/'),
      mkdir: async () => {},
      exists: async (p) => files.has(p),
      readTextFile: async (p) => {
        if (!files.has(p)) throw new Error('ENOENT');
        return files.get(p);
      },
      writeTextFileAtomic: async (p, c) => void files.set(p, c),
    },
  };
});

function fakeEngine() {
  const ink = (face, text) => ({ width: text.length * face.size * 0.55, left: 0, right: text.length * face.size * 0.55, ascent: face.size * 0.7, descent: face.size * 0.2 });
  return {
    id: 'rust',
    advance: (face, text) => text.length * face.size * 0.55,
    fontBox: (face) => ({ ascent: Math.round(face.size * 0.8), descent: Math.round(face.size * 0.2) }),
    lineInk: ink,
    glyphInk: ink,
    loading: () => false,
    onFontsChange: () => () => {},
    faceReady: () => true,
  };
}

const box = (over = {}) => ({
  id: 'b1', lineN: null, text: 'AAAA BBBB CCCC', x: 100, y: 500, w: 60, h: 20,
  ...over,
  style: { font: 'Wild Words', size: 20, lineHeight: 1.1, valign: 'top', outlineWidth: 0, ...over.style },
});
const doc = (boxes, id = 1) => ({ id, w: 800, h: 1200, lines: [], boxes });
const rect = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size });

const original = { engine: textEngine(), typeset: typesetEnabled() };
// Whether the face every box here is set in has reached the engine.
let arrived;
const land = () => {
  arrived = true;
  noteFontsChanged();
};

beforeEach(() => {
  __setDir(null);
  initHistory();
  resetHistory();
  app.chapterRef = null;
  setTextEngine(fakeEngine());
  setTypesetEnabled(true);
  arrived = true;
  setFontSource({ ready: () => arrived });
});

afterEach(() => {
  setFontSource(null);
  loadProjectPages([]);
  setTextEngine(original.engine);
  setTypesetEnabled(original.typeset);
  clearLayoutMemo();
  __setDir(null);
  resetHistory();
});

// The Inspector's size field, as the panel does it: write the style, tell the
// store, record the burst with the box on both sides of it.
function typeSize(b, size, p = page()) {
  const before = cloneStyle(b.style);
  const geomBefore = fitGeom(b);
  b.style.size = size;
  boxEdited(b, p);
  recordEdit({ t: 'style', pageId: p.id, boxId: b.id, before, after: cloneStyle(b.style), geomBefore, geomAfter: fitGeom(b) });
}

describe('an edit made while the box’s face is on its way', () => {
  it('is undone and redone with its fit, though the fit ran after it was recorded', () => {
    loadProjectPages([doc([box()])]);
    const b = page().boxes[0];
    const settled = rect(b);
    expect(settled.h).toBeGreaterThan(20);

    arrived = false;
    typeSize(b, 40);
    // Held: the box is as the edit left it, and the entry says a fit is owed.
    expect(rect(b)).toEqual({ ...settled, size: 40 });
    expect(fitHeld(b)).toBe(true);
    expect(peekStack().undo.at(-1).fitOwed).toEqual(['b1']);

    land();
    const fitted = rect(b);
    expect(fitted).not.toEqual({ ...settled, size: 40 });
    expect(fitHeld(b)).toBe(false);
    // One entry still, and it now ends where the edit ended.
    expect(peekStack().undo).toHaveLength(1);
    expect(peekStack().undo[0].fitOwed).toBeUndefined();

    expect(undo()).toBe(true);
    expect(rect(b)).toEqual(settled);
    expect(redo()).toBe(true);
    expect(rect(b)).toEqual(fitted);
    expect(undo()).toBe(true);
    expect(rect(b)).toEqual(settled);
  });

  it('undone before the face came is simply undone: the fit that was held is not run on the box it left', () => {
    loadProjectPages([doc([box()])]);
    const b = page().boxes[0];
    const settled = rect(b);
    arrived = false;
    typeSize(b, 40);
    expect(undo()).toBe(true);
    expect(fitHeld(b)).toBe(false);
    land();
    expect(rect(b)).toEqual(settled);

    // Redone with the face in: fitted there and then, and the entry corrected.
    expect(redo()).toBe(true);
    const fitted = rect(b);
    expect(fitted.size).toBe(40);
    expect(fitted).not.toEqual({ ...settled, size: 40 });
    expect(peekStack().undo[0].fitOwed).toBeUndefined();
    expect(undo()).toBe(true);
    expect(rect(b)).toEqual(settled);
    expect(redo()).toBe(true);
    expect(rect(b)).toEqual(fitted);
  });

  it('redone while the face is still coming is held again, and fitted when it lands', () => {
    loadProjectPages([doc([box()])]);
    const b = page().boxes[0];
    const settled = rect(b);
    arrived = false;
    typeSize(b, 40);
    undo();
    redo();
    expect(rect(b)).toEqual({ ...settled, size: 40 });
    expect(fitHeld(b)).toBe(true);
    land();
    const fitted = rect(b);
    expect(fitted).not.toEqual({ ...settled, size: 40 });
    undo();
    redo();
    expect(rect(b)).toEqual(fitted);
  });

  it('two edits before the face came: each state comes back fitted', () => {
    loadProjectPages([doc([box()])]);
    const b = page().boxes[0];
    const settled = rect(b);
    arrived = false;
    typeSize(b, 30);
    typeSize(b, 40);
    land();
    const second = rect(b);
    // Back to the first edit: it was never fitted, and is now, without a step.
    expect(undo()).toBe(true);
    const first = rect(b);
    expect(first.size).toBe(30);
    expect(first).not.toEqual({ ...settled, size: 30 });
    expect(peekStack().undo).toHaveLength(1);
    expect(redo()).toBe(true);
    expect(rect(b)).toEqual(second);
    undo();
    expect(rect(b)).toEqual(first);
    undo();
    expect(rect(b)).toEqual(settled);
  });

  it('a move made meanwhile takes the landing, and walks back to the fitted edit', () => {
    loadProjectPages([doc([box()])]);
    const b = page().boxes[0];
    const settled = rect(b);
    arrived = false;
    typeSize(b, 40);
    const before = moveGeom(b);
    moveBoxTo(b, 300, 200, page(), before);
    record({ t: 'move', pageId: 1, boxId: 'b1', before, after: moveGeom(b) });
    land();
    const moved = rect(b);
    expect(moved.size).toBe(40);
    undo();
    // Where it was before the move, as the size edit would have fitted it.
    const edited = rect(b);
    expect(edited.size).toBe(40);
    expect(edited).not.toEqual({ ...settled, size: 40 });
    redo();
    expect(rect(b)).toEqual(moved);
    undo();
    undo();
    expect(rect(b)).toEqual(settled);
  });

  it('a width drag is re-set when the face lands, in the drag’s own entry', () => {
    loadProjectPages([{ ...doc([]), lines: [{ n: 1, en: 'HELLO THERE GENERAL' }], activeLineN: 1 }]);
    placeActiveAt(400, 600);
    const b = page().boxes[0];
    resetHistory();
    const placed = rect(b);
    arrived = false;
    const before = { x: b.x, y: b.y, w: b.w, h: b.h };
    resizeBox(1, b.id, { w: b.w + 120 });
    record({ t: 'resize', pageId: 1, boxId: b.id, before, after: { x: b.x, y: b.y, w: b.w, h: b.h } });
    expect(fitHeld(b)).toBe(true);
    land();
    const reset = rect(b);
    expect(reset.w).toBe(placed.w + 120);
    undo();
    expect(rect(b)).toEqual(placed);
    redo();
    expect(rect(b)).toEqual(reset);
  });
});

describe('a box placed while its face is on its way', () => {
  const queued = () => [{ ...doc([]), lines: [{ n: 1, en: 'HELLO THERE GENERAL' }], activeLineN: 1 }];

  it('is placed at the constants, not at a size measured meanwhile, and solved when the face lands', () => {
    loadProjectPages(queued());
    arrived = false;
    placeActiveAt(400, 600);
    const b = page().boxes[0];
    expect(b).toMatchObject({ w: 220, h: 92 });
    expect(b.auto.status).toBe('pending');
    // What the history holds of it is the same placeholder.
    expect(peekStack().undo[0].box).toMatchObject({ w: 220, h: 92 });
    land();
    expect(b.auto.status).not.toBe('pending');
    const solved = rect(b);
    expect(solved).not.toMatchObject({ w: 220, h: 92 });

    expect(undo()).toBe(true);
    expect(page().boxes).toHaveLength(0);
    expect(redo()).toBe(true);
    expect(rect(page().boxes[0])).toEqual(solved);
  });

  it('typed into before the face lands, it is fitted to the new text when it does, in the edit’s entry', () => {
    loadProjectPages(queued());
    arrived = false;
    placeActiveAt(400, 600);
    const b = page().boxes[0];
    const placed = rect(b);
    const geomBefore = fitGeom(b);
    b.text = 'HELLO THERE GENERAL KENOBI, YOU ARE A BOLD ONE';
    boxEdited(b);
    recordEdit({ t: 'text', pageId: 1, boxId: b.id, before: null, after: b.text, geomBefore, geomAfter: fitGeom(b) });
    expect(rect(b)).toEqual(placed);
    land();
    const fitted = rect(b);
    expect(fitted).not.toEqual(placed);
    undo();
    redo();
    expect(rect(b)).toEqual(fitted);
  });
});

describe('a held fit on a page that is not the one on screen', () => {
  const CH = '/lib/proj/ch1';

  it('corrects the entry in that page’s stored stack', async () => {
    __setDir(CH);
    loadProjectPages([doc([box()], 1), doc([box({ id: 'b2' })], 2)]);
    const p1 = pageById(1);
    const b = p1.boxes[0];
    const settled = rect(b);
    // The live page is claimed by its first record.
    arrived = false;
    typeSize(b, 40, p1);
    await switchHistoryPage(1, 2);
    expect(peekStack().undo).toHaveLength(0);
    land();
    const fitted = rect(b);
    expect(fitted).not.toEqual({ ...settled, size: 40 });
    await switchHistoryPage(2, 1);
    expect(peekStack().undo).toHaveLength(1);
    expect(peekStack().undo[0].fitOwed).toBeUndefined();
    undo();
    expect(rect(b)).toEqual(settled);
    redo();
    expect(rect(b)).toEqual(fitted);
    await flushHistory();
  });
});

describe('with nothing on its way', () => {
  it('no entry is marked, and a step fits nothing', () => {
    setFontSource(null);
    loadProjectPages([doc([box()])]);
    const b = page().boxes[0];
    typeSize(b, 40);
    expect(peekStack().undo[0].fitOwed).toBeUndefined();
    const fitted = rect(b);
    undo();
    redo();
    expect(rect(b)).toEqual(fitted);
  });
});
