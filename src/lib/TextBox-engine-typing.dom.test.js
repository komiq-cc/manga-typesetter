import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The paint is the real one, on the lane's stand-in canvas, wrapped so a case
// can count it, read what it was asked to paint, and make it throw.
const real = vi.hoisted(() => ({}));
vi.mock('./editor/box-picture.js', async (original) => {
  const mod = await original();
  real.paintBoxPicture = mod.paintBoxPicture;
  return { ...mod, paintBoxPicture: vi.fn(mod.paintBoxPicture) };
});

import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, beginEdit, endEdit, setZoom, boxText } from './store.svelte.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { paintBoxPicture, PICTURE_MAX_PX, PICTURE_DRAG_PX } from './editor/box-picture.js';
import { _setDisplayScale } from './editor/display-scale.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { typeModel } from './type-rows.js';
import { rawOffset, domPoint } from './edit-lines.js';
import { isMacKeyboard, setMacKeyboard } from './shortcuts.svelte.js';
import { caretAt as curveCaretAt } from './curve-caret.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

// ===========================================================================
// A box typed into while the Rust engine draws: still its picture
// ===========================================================================
// The component is mounted for real. What stands in: the canvas (jsdom has
// none), the flag that says the engine is drawing, and the engine - a metric
// of half the size a letter, WITH the one thing typing as a picture asks of
// it, `lineCarets` (the wasm's `mt_line_carets`; type-rows.engine.test.js has
// the real one against the painted pixels). So these cases are about the
// component: what the box is while typed into, where its marks are drawn,
// what the pointer and the keys do, and that it falls back to its text.

const half = {
  id: 'rust',
  advance: (face, text) => text.length * face.size * 0.5,
  fontBox: (face) => ({ ascent: Math.round(face.size * 0.8), descent: Math.round(face.size * 0.2) }),
  lineInk: (face, text) => ({ width: text.length * face.size * 0.5, left: 0, right: text.length * face.size * 0.5, ascent: face.size * 0.7, descent: face.size * 0.2 }),
  glyphInk: (face, text) => ({ width: text.length * face.size * 0.5, left: 0, right: text.length * face.size * 0.5, ascent: face.size * 0.7, descent: face.size * 0.2 }),
  loading: () => false,
  onFontsChange: () => () => {},
  faceReady: () => true,
  lineCarets: (face, text, spacing = 0) => {
    const step = face.size * 0.5 + spacing;
    const at = [...text].map((_, i) => i);
    return { at, x: at.map((i) => i * step), length: text.length, advance: text.length * step };
  },
};

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 20, lineHeight: 1.2, align: 'left', valign: 'top', autoHeight: false, ...over });
const box = (id, over = {}, more = {}) => ({ id, lineN: null, text: 'WAIT FOR ME\nOVER THERE', x: 100, y: 200, w: 300, h: 120, ...more, style: style(over) });
const KINDS = {
  plain: box('plain'),
  wrapped: box('wrapped', {}, { text: 'AAAA BBBB CCCC', w: 70 }),
  flipped: box('flipped', { flipH: true }),
  arc: box('arc', { curve: 40, align: 'center' }),
  warped: box('warped', { warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [310, 12], [-6, 126], [300, 120]] } }),
  upper: box('upper', { uppercase: true }, { text: 'straße' }),
  upperArc: box('upperArc', { uppercase: true, curve: 40, align: 'center' }, { text: 'straße' }),
  flippedV: box('flippedV', { flipV: true }),
  // Over a megapixel at 100% on a 1x display: more than a key's paint is given.
  big: box('big', {}, { w: 1300, h: 900 }),
};

const typeset = typesetEnabled();
let restoreCanvas;
let engineWas;
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  setTypesetEnabled(true);
});
afterAll(() => {
  restoreCanvas();
  setTypesetEnabled(typeset);
  clearLayoutMemo();
});
beforeEach(() => {
  engineWas = textEngine();
  setTextEngine(half);
  clearLayoutMemo();
  engineSwitch.painting = true;
  _setDisplayScale(1);
  paintBoxPicture.mockReset();
  paintBoxPicture.mockImplementation(real.paintBoxPicture);
});
afterEach(() => {
  cleanup();
  setTextEngine(engineWas);
  clearLayoutMemo();
  engineSwitch.painting = false;
  app.selectedId = null;
  app.editingId = null;
  setZoom(1);
  loadProjectPages([]);
});

async function mounted(id, { zoom = 1 } = {}) {
  loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: Object.values(KINDS).map((b) => structuredClone(b)) }]);
  setZoom(zoom);
  const pg = page();
  const b = pg.boxes.find((x) => x.id === id);
  const view = render(TextBox, { box: b, pageFrameEl: document.createElement('div'), pg });
  await tick();
  const root = view.container.querySelector('.tbox');
  const q = (sel) => root.querySelector(sel);
  return {
    view,
    root,
    box: b,
    pg,
    q,
    all: (sel) => [...root.querySelectorAll(sel)],
    canvas: () => q('canvas'),
    editable: () => q('.txt.editable'),
    paints: () => paintBoxPicture.mock.calls.length,
    // The selection the editable holds, as raw offsets [anchor, focus].
    sel: () => {
      const s = window.getSelection();
      const n = q('.txt.editable');
      return [rawOffset(n, s.anchorNode, s.anchorOffset), rawOffset(n, s.focusNode, s.focusOffset)];
    },
  };
}
async function typing(id, opts) {
  const m = await mounted(id, opts);
  beginEdit(id);
  await tick();
  return m;
}
const px = (el) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), width: parseFloat(el.style.width), height: parseFloat(el.style.height) });
// A pointer at a point of the box's own frame (page px from its corner). The
// page frame stands at the viewport's origin in jsdom.
const at = (m, x, y, more = {}) => ({ bubbles: true, cancelable: true, button: 0, clientX: (m.box.x + x) * app.zoom, clientY: (m.box.y + y) * app.zoom, ...more });
const press = (m, x, y, more) => {
  const ev = new MouseEvent('pointerdown', at(m, x, y, more));
  m.q('.type-edit').dispatchEvent(ev);
  return ev;
};
const release = (m) => m.q('.type-edit').dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
const key = (m, k, more = {}) => {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...more });
  m.editable().dispatchEvent(ev);
  return ev;
};
const input = (m, inputType, data) => {
  const ev = new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true });
  m.editable().dispatchEvent(ev);
  return ev;
};

// In this metric a letter is 10 page px at size 20 and a line 24 high; a
// left, top block starts at the box's inset.
const rowsOf = (b, text = boxText(b)) => typeModel(b, text).rows;

describe('a box typed into with the engine drawing', () => {
  it('stays the canvas it was: the same element, not painted again, with the editable under it unseen', async () => {
    const m = await mounted('plain');
    const el = m.canvas();
    expect(m.paints()).toBe(1);
    beginEdit('plain');
    await tick();
    expect(m.canvas()).toBe(el);
    expect(el.width * el.height).toBeGreaterThan(0);
    expect(el.dataset.painter).toBe('engine');
    expect(m.paints()).toBe(1);
    const ed = m.editable();
    expect(ed.getAttribute('contenteditable')).toBe('true');
    expect(ed.classList.contains('unseen')).toBe(true);
    expect(ed.classList.contains('ghost')).toBe(false);
    // The text is in it, raw, as it is with the switch off.
    expect(ed.textContent).toBe('WAIT FOR ME\nOVER THERE');
    expect(m.all('.txt.editable')).toHaveLength(1);
    // Nothing of the DOM's own picture of the box: no stack, no filter defs.
    expect(m.q('.txt.shaped, .tlayer, .arcstack, svg.rough-def, .inkl')).toBe(null);
    // And the overlay that takes the pointer is over it, in the wrapper.
    expect(m.q('.type-edit').parentElement.classList.contains('clipwrap')).toBe(true);
    // The targets a picture at rest has for text past its frame are gone.
    expect(m.q('.hit')).toBe(null);
  });

  it('and is the same canvas, not painted again, when the edit ends with nothing typed', async () => {
    const m = await typing('plain');
    const el = m.canvas();
    endEdit(m.box.text);
    await tick();
    expect(m.canvas()).toBe(el);
    expect(m.paints()).toBe(1);
    expect(m.q('.txt, .type-edit')).toBe(null);
  });

  it('says nothing of its own to a screen reader: the text is in the document', async () => {
    const m = await mounted('plain');
    expect(m.root.getAttribute('aria-label')).toBe('WAIT FOR ME\nOVER THERE');
    beginEdit('plain');
    await tick();
    expect(m.root.hasAttribute('aria-label')).toBe(false);
    expect(m.root.hasAttribute('role')).toBe(false);
  });

  it('keeps its flip, which with the switch off it drops for the caret', async () => {
    const m = await typing('flipped');
    expect(m.q('.clipwrap').style.transform).toContain('scale(-1');
    expect(m.q('.type-edit').parentElement).toBe(m.q('.clipwrap'));
    expect(m.editable().parentElement).toBe(m.q('.clipwrap'));
  });

  it('a warped box is not typed into as a picture: it is what it was before, the old paint and no editable', async () => {
    const m = await typing('warped');
    expect(m.q('.type-edit')).toBe(null);
    expect(m.q('.txt.editable')).toBe(null);
    expect(m.canvas().dataset.painter).toBeUndefined();
  });

  it('an engine that cannot say where a caret stands leaves the box the editable it is with the switch off', async () => {
    const { lineCarets, ...mute } = half;
    setTextEngine(mute);
    const m = await typing('plain');
    expect(m.canvas()).toBe(null);
    expect(m.q('.type-edit')).toBe(null);
    expect(m.editable().classList.contains('unseen')).toBe(false);
    expect(m.editable().getAttribute('style')).toContain('color:');
  });
});

describe('the marks, drawn from the rows the picture is painted from', () => {
  it('the first focus selects everything, and shows it: a rectangle a row, and no caret', async () => {
    const m = await typing('plain');
    expect(m.sel()).toEqual([0, 22]);
    const rows = rowsOf(m.box);
    const sel = m.all('.tsel').map(px);
    expect(sel).toHaveLength(2);
    // Row 1: its eleven letters and the sliver for its Return. Row 2: its ten.
    expect(sel[0]).toEqual({ left: rows[0].xs[0], top: rows[0].top, width: 110 + 20 * 0.3, height: 24 });
    expect(sel[1]).toEqual({ left: rows[1].xs[0], top: rows[1].top, width: 100, height: 24 });
    expect(rows[1].top - rows[0].top).toBe(24);
    // The caret is there to be measured and is not shown.
    expect(m.q('.tcaret').classList.contains('off')).toBe(true);
  });

  it('the caret stands at its offset\'s pen, as tall as its line, in zoomed px', async () => {
    const m = await typing('plain', { zoom: 2 });
    const rows = rowsOf(m.box);
    press(m, rows[0].xs[4] + 1, rows[0].top + 5);
    release(m);
    await tick();
    expect(m.sel()).toEqual([4, 4]);
    const c = m.q('.tcaret');
    expect(c.classList.contains('off')).toBe(false);
    expect(px(c)).toMatchObject({ left: rows[0].xs[4] * 2, top: rows[0].top * 2, height: 48 });
    expect(rows[0].xs[4] - rows[0].xs[0]).toBe(40);
    expect(m.all('.tsel')).toHaveLength(0);
  });

  it('a row past the frame has a target of its own for the pointer', async () => {
    const m = await typing('plain');
    expect(m.q('.tpad')).toBe(null);
    cleanup();
    const w = await typing('wrapped');
    // Three rows of 24 in a box 120 high fit; make the box too short for them.
    w.box.h = 40;
    await tick();
    const rows = rowsOf(w.box);
    expect(rows).toHaveLength(3);
    const pad = px(w.q('.tpad'));
    expect(pad.top + pad.height).toBe(rows[2].top + 24);
    expect(pad.top + pad.height).toBeGreaterThan(40);
  });
});

describe('the pointer on the picture', () => {
  it('a press goes to the nearest stop of its row: the left half of a letter before it, the right half after', async () => {
    const m = await typing('plain');
    const rows = rowsOf(m.box);
    const x0 = rows[1].xs[0];
    const y = rows[1].top + 12;
    // Row 2 is "OVER THERE", from offset 12.
    for (let k = 0; k < 10; k++) {
      press(m, x0 + k * 10 + 2.5, y);
      release(m);
      expect(m.sel(), `left half of letter ${k}`).toEqual([12 + k, 12 + k]);
      press(m, x0 + k * 10 + 7.5, y);
      release(m);
      expect(m.sel(), `right half of letter ${k}`).toEqual([13 + k, 13 + k]);
    }
  });

  it('the press keeps the focus in the editable: its default is prevented', async () => {
    const m = await typing('plain');
    const ev = new MouseEvent('mousedown', at(m, 20, 10, { detail: 1 }));
    m.q('.type-edit').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('a drag selects from where it began, and Shift extends from the anchor', async () => {
    const m = await typing('plain');
    const rows = rowsOf(m.box);
    press(m, rows[0].xs[2] + 1, rows[0].top + 5);
    m.q('.type-edit').dispatchEvent(new MouseEvent('pointermove', at(m, rows[1].xs[3] + 1, rows[1].top + 5)));
    expect(m.sel()).toEqual([2, 15]);
    release(m);
    // After the release a move selects nothing more.
    m.q('.type-edit').dispatchEvent(new MouseEvent('pointermove', at(m, rows[1].xs[8] + 1, rows[1].top + 5)));
    expect(m.sel()).toEqual([2, 15]);
    press(m, rows[0].xs[6] + 1, rows[0].top + 5, { shiftKey: true });
    release(m);
    expect(m.sel()).toEqual([2, 6]);
    await tick();
    expect(m.all('.tsel').map(px)).toEqual([{ left: rows[0].xs[2], top: rows[0].top, width: 40, height: 24 }]);
  });

  it('the second press of a double-click selects the word the caret went to', async () => {
    const m = await typing('plain');
    const rows = rowsOf(m.box);
    // The right half of the R of FOR: the caret is after the word, and what
    // starts there is the space (flat-caret.js `wordPress`: the browser's rule).
    press(m, rows[0].xs[7] + 8, rows[0].top + 5);
    m.q('.type-edit').dispatchEvent(new MouseEvent('mousedown', at(m, rows[0].xs[7] + 8, rows[0].top + 5, { detail: 2 })));
    expect(m.sel()).toEqual([8, 9]);
    release(m);
    // Its left half: the word.
    const x = rows[0].xs[7] + 2;
    press(m, x, rows[0].top + 5);
    m.q('.type-edit').dispatchEvent(new MouseEvent('mousedown', at(m, x, rows[0].top + 5, { detail: 2 })));
    expect(m.sel()).toEqual([5, 8]);
  });

  it('and a drag from there goes by words, the word the press took staying selected', async () => {
    const m = await typing('plain');
    const rows = rowsOf(m.box);
    const y = rows[0].top + 5;
    const move = (x, yy = y) => m.q('.type-edit').dispatchEvent(new MouseEvent('pointermove', at(m, x, yy)));
    // Two presses on the O of "WAIT FOR ME".
    press(m, rows[0].xs[6] + 2, y);
    release(m);
    press(m, rows[0].xs[6] + 2, y);
    m.q('.type-edit').dispatchEvent(new MouseEvent('mousedown', at(m, rows[0].xs[6] + 2, y, { detail: 2 })));
    expect(m.sel()).toEqual([5, 8]);
    // Forward into ME: to that word's end.
    move(rows[0].xs[9] + 2);
    expect(m.sel()).toEqual([5, 11]);
    // Back into WAIT: the anchor is now the far end of FOR, the focus the start of WAIT.
    move(rows[0].xs[1] + 2);
    expect(m.sel()).toEqual([8, 0]);
    // Onto the row below: to the end of the word there.
    move(rows[1].xs[2] + 2, rows[1].top + 5);
    expect(m.sel()).toEqual([5, 16]);
    // Back inside the word itself: the word.
    move(rows[0].xs[6] + 2);
    expect(m.sel()).toEqual([5, 8]);
    release(m);
    move(rows[0].xs[1] + 2);
    expect(m.sel()).toEqual([5, 8]);
  });

  it('a drag from the third press goes by rows of the picture', async () => {
    const m = await typing('wrapped');
    const rows = rowsOf(m.box);
    const el = m.q('.type-edit');
    const y = (i) => rows[i].top + 5;
    press(m, rows[1].xs[1], y(1));
    el.dispatchEvent(new MouseEvent('mousedown', at(m, rows[1].xs[1], y(1), { detail: 3 })));
    expect(m.sel()).toEqual([5, 10]);
    el.dispatchEvent(new MouseEvent('pointermove', at(m, rows[2].xs[1], y(2))));
    expect(m.sel()).toEqual([5, 14]);
    el.dispatchEvent(new MouseEvent('pointermove', at(m, rows[0].xs[3], y(0))));
    expect(m.sel()).toEqual([10, 0]);
    el.dispatchEvent(new MouseEvent('pointermove', at(m, rows[1].xs[3], y(1))));
    expect(m.sel()).toEqual([5, 10]);
    await tick();
    // The row's own end, at the wrap, shows on the row.
    expect(px(m.q('.tcaret')).top).toBe(rows[1].top);
    release(m);
    el.dispatchEvent(new MouseEvent('pointermove', at(m, rows[2].xs[1], y(2))));
    expect(m.sel()).toEqual([5, 10]);
  });

  it('the third selects the line of the picture it is on: the row, not the paragraph', async () => {
    const m = await typing('wrapped');
    const rows = rowsOf(m.box);
    // "AAAA BBBB CCCC" in three rows; the middle one is BBBB and the space it
    // wrapped at, which hangs.
    expect(rows.map((r) => [r.offs[0], r.offs[r.offs.length - 1]])).toEqual([[0, 5], [5, 10], [10, 14]]);
    m.q('.type-edit').dispatchEvent(new MouseEvent('mousedown', at(m, rows[1].xs[1], rows[1].top + 5, { detail: 3 })));
    expect(m.sel()).toEqual([5, 10]);
    await tick();
    // Shown on that row alone: the focus, at the wrap, is on the upper side.
    const sel = m.all('.tsel').map(px);
    expect(sel).toHaveLength(1);
    expect(sel[0].top).toBe(rows[1].top);
    expect(px(m.q('.tcaret')).top).toBe(rows[1].top);
    cleanup();
    // A row that ends at a Return is selected with it.
    const p = await typing('plain');
    const r = rowsOf(p.box);
    p.q('.type-edit').dispatchEvent(new MouseEvent('mousedown', at(p, r[0].xs[3], r[0].top + 5, { detail: 3 })));
    expect(p.sel()).toEqual([0, 12]);
  });

  it('the right button selects the word under it and steps aside for the system\'s menu, then comes back', async () => {
    vi.useFakeTimers();
    try {
      const m = await typing('plain');
      const rows = rowsOf(m.box);
      press(m, rows[0].xs[1], rows[0].top + 5);
      release(m);
      const ev = press(m, rows[1].xs[6] + 3, rows[1].top + 5, { button: 2 });
      expect(ev.defaultPrevented).toBe(false);
      expect(m.sel()).toEqual([17, 22]);
      expect(m.q('.type-edit').classList.contains('ctx')).toBe(true);
      window.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      vi.runAllTimers();
      expect(m.q('.type-edit').classList.contains('ctx')).toBe(false);
      // On the selection, it leaves the selection alone.
      press(m, rows[1].xs[7], rows[1].top + 5, { button: 2 });
      expect(m.sel()).toEqual([17, 22]);
      // And with no menu event at all it still comes back.
      vi.runAllTimers();
      expect(m.q('.type-edit').classList.contains('ctx')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the keys that go by lines go by the picture\'s lines', () => {
  it('Down and Up keep their column across a shorter row, End and Home go to the row\'s ends', async () => {
    const m = await typing('plain');
    const rows = rowsOf(m.box);
    // Offset 11 is the end of "WAIT FOR ME"; the row under it ends a letter short of it.
    press(m, rows[0].xs[11] + 1, rows[0].top + 5);
    release(m);
    expect(m.sel()).toEqual([11, 11]);
    expect(key(m, 'ArrowDown').defaultPrevented).toBe(true);
    expect(m.sel()).toEqual([22, 22]);
    key(m, 'ArrowUp');
    expect(m.sel()).toEqual([11, 11]);
    key(m, 'Home');
    expect(m.sel()).toEqual([0, 0]);
    key(m, 'ArrowDown');
    expect(m.sel()).toEqual([12, 12]);
    key(m, 'End', { shiftKey: true });
    expect(m.sel()).toEqual([12, 22]);
    key(m, 'ArrowUp', { metaKey: true });
    expect(m.sel()).toEqual([0, 0]);
    key(m, 'ArrowRight', { metaKey: true, shiftKey: true });
    expect(m.sel()).toEqual([0, 11]);
  });

  it('End on a wrapped row stays on that row, and Right from there is one press to the next letter', async () => {
    const m = await typing('wrapped');
    const rows = rowsOf(m.box);
    press(m, rows[0].xs[1] + 1, rows[0].top + 5);
    release(m);
    key(m, 'End');
    await tick();
    // Offset 5 is the end of row 1 and the start of row 2; End shows it on row 1.
    expect(m.sel()).toEqual([5, 5]);
    expect(px(m.q('.tcaret'))).toMatchObject({ top: rows[0].top, left: rows[0].xs[5] });
    key(m, 'ArrowRight');
    await tick();
    expect(m.sel()).toEqual([6, 6]);
    expect(px(m.q('.tcaret'))).toMatchObject({ top: rows[1].top, left: rows[1].xs[1] });
    key(m, 'ArrowLeft');
    await tick();
    // Back at 5 by Left: the lower side, at the row's start.
    expect(m.sel()).toEqual([5, 5]);
    expect(px(m.q('.tcaret'))).toMatchObject({ top: rows[1].top, left: rows[1].xs[0] });
    // The keys know which side the caret is on: Home from the upper row's end
    // is that row's start, not the lower row's (which is where it stands).
    press(m, rows[0].xs[1] + 1, rows[0].top + 5);
    release(m);
    key(m, 'End');
    await tick();
    expect(m.sel()).toEqual([5, 5]);
    key(m, 'Home');
    await tick();
    expect(m.sel()).toEqual([0, 0]);
  });

  it('on a keyboard that is not a Mac\'s a key with Alt or Control, and anywhere a key while an IME composes, is left to the browser', async () => {
    expect(isMacKeyboard()).toBe(false);
    const m = await typing('plain');
    expect(key(m, 'a', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(m, 'v', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(m, 'k', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key(m, 'ArrowDown', { altKey: true }).defaultPrevented).toBe(false);
    expect(key(m, 'ArrowLeft', { ctrlKey: true }).defaultPrevented).toBe(false);
    m.editable().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(key(m, 'ArrowDown').defaultPrevented).toBe(false);
  });
});

describe('an edit goes the way it goes with the switch off, and the picture follows it', () => {
  it('a letter typed is the box\'s text, and the same canvas is painted once more', async () => {
    const m = await typing('plain');
    const el = m.canvas();
    const rows = rowsOf(m.box);
    press(m, rows[0].xs[4] + 1, rows[0].top + 5);
    release(m);
    const ev = input(m, 'insertText', 'S');
    expect(ev.defaultPrevented).toBe(true);
    await tick();
    expect(m.box.text).toBe('WAITS FOR ME\nOVER THERE');
    expect(m.editable().textContent).toBe('WAITS FOR ME\nOVER THERE');
    expect(m.canvas()).toBe(el);
    expect(m.paints()).toBe(2);
    expect(m.sel()).toEqual([5, 5]);
    expect(px(m.q('.tcaret')).left).toBe(rows[0].xs[5]);
  });

  it('a delete to the line\'s start is cut from the picture\'s row, on the side of a wrap the caret is on', async () => {
    const m = await typing('wrapped');
    const rows = rowsOf(m.box);
    // The caret after the second B of row 2.
    press(m, rows[1].xs[2] + 1, rows[1].top + 5);
    release(m);
    expect(m.sel()).toEqual([7, 7]);
    input(m, 'deleteSoftLineBackward');
    await tick();
    expect(m.box.text).toBe('AAAA BB CCCC');
    cleanup();
    // At the wrap, on the upper side (End): row 1 goes, not nothing.
    const w = await typing('wrapped');
    const r = rowsOf(w.box);
    press(w, r[0].xs[1] + 1, r[0].top + 5);
    release(w);
    key(w, 'End');
    input(w, 'deleteSoftLineBackward');
    await tick();
    expect(w.box.text).toBe('BBBB CCCC');
  });

  it('with something selected a line delete takes the selection, as the browser says', async () => {
    const m = await typing('plain');
    const rows = rowsOf(m.box);
    press(m, rows[0].xs[5] + 1, rows[0].top + 5);
    m.q('.type-edit').dispatchEvent(new MouseEvent('pointermove', at(m, rows[0].xs[8] + 1, rows[0].top + 5)));
    release(m);
    input(m, 'deleteSoftLineBackward');
    await tick();
    expect(m.box.text).toBe('WAIT  ME\nOVER THERE');
  });

  it('what an IME composes is in the picture and underlined, and is the box\'s text only when it ends', async () => {
    const m = await typing('plain');
    const rows = rowsOf(m.box);
    press(m, rows[0].xs[4] + 1, rows[0].top + 5);
    release(m);
    const ed = m.editable();
    ed.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    // The browser puts the composed text in the editable itself.
    const node = ed.querySelector('.el').firstChild;
    node.data = 'WAITに FOR ME';
    window.getSelection().setBaseAndExtent(node, 5, node, 5);
    ed.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    await tick();
    expect(m.box.text).toBe('WAIT FOR ME\nOVER THERE');
    expect(m.paints()).toBe(2);
    // Painted from a stand-in that reads the composed text, not from the box.
    const painted = paintBoxPicture.mock.calls.at(-1)[1];
    expect(painted).not.toBe(m.box);
    expect(painted.text).toBe('WAITに FOR ME\nOVER THERE');
    expect(painted.id).toBe('plain');
    const mark = m.all('.tcomp').map(px);
    expect(mark).toHaveLength(1);
    expect(mark[0]).toMatchObject({ left: rows[0].xs[4], width: 10, top: rows[0].top + 24 - 2 });
    ed.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await tick();
    expect(m.box.text).toBe('WAITに FOR ME\nOVER THERE');
    expect(m.all('.tcomp')).toHaveLength(0);
    // Painted once more, from the box itself now that the text is its own.
    expect(m.paints()).toBe(3);
    expect(paintBoxPicture.mock.calls.at(-1)[1].id).toBe('plain');
    expect(paintBoxPicture.mock.calls.at(-1)[1].lineN).toBe(null);
    expect(boxText(paintBoxPicture.mock.calls.at(-1)[1])).toBe('WAITに FOR ME\nOVER THERE');
    expect(m.sel()).toEqual([5, 5]);
  });
});

describe('a picture that cannot be painted never takes the text with it', () => {
  it('the box becomes its text in the SAME editable, with its caret, and goes on being typed into', async () => {
    const m = await typing('plain');
    const ed = m.editable();
    const rows = rowsOf(m.box);
    press(m, rows[0].xs[4] + 1, rows[0].top + 5);
    release(m);
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      paintBoxPicture.mockImplementation(() => {
        throw new Error('refused');
      });
      input(m, 'insertText', 'S');
      await tick();
      expect(m.box.text).toBe('WAITS FOR ME\nOVER THERE');
      // No picture, no overlay; the editable is the one it was, now seen.
      expect(m.canvas()).toBe(null);
      expect(m.q('.type-edit')).toBe(null);
      expect(m.editable()).toBe(ed);
      expect(ed.classList.contains('unseen')).toBe(false);
      expect(ed.getAttribute('style')).toContain('color:');
      expect(ed.textContent).toBe('WAITS FOR ME\nOVER THERE');
      expect(m.sel()).toEqual([5, 5]);
      // The flip stands down again, as it does for DOM text.
      // And the next edit goes the same way.
      input(m, 'insertText', '!');
      await tick();
      expect(m.box.text).toBe('WAITS! FOR ME\nOVER THERE');
      expect(m.editable()).toBe(ed);
      // When the painter paints again the picture is back, over the same editable.
      paintBoxPicture.mockImplementation(real.paintBoxPicture);
      input(m, 'insertText', '?');
      await tick();
      expect(m.box.text).toBe('WAITS!? FOR ME\nOVER THERE');
      expect(m.canvas()).not.toBe(null);
      expect(m.editable()).toBe(ed);
      expect(ed.classList.contains('unseen')).toBe(true);
      expect(m.sel()).toEqual([7, 7]);
    } finally {
      said.mockRestore();
    }
  });

  it('a model that throws is the same: DOM text, nothing lost', async () => {
    const m = await typing('plain');
    const ed = m.editable();
    setTextEngine({
      ...half,
      lineCarets: () => {
        throw new Error('no carets');
      },
    });
    input(m, 'insertText', 'S');
    await tick();
    // Everything was selected, so the letter takes the place of it all.
    expect(m.box.text).toBe('S');
    expect(m.q('.type-edit')).toBe(null);
    expect(m.editable()).toBe(ed);
    expect(ed.classList.contains('unseen')).toBe(false);
  });
});

describe('text on a curve, and text whose casing changes its length', () => {
  it('a curve is typed into on its picture: the marks on the painter\'s glyphs, the editable a ghost', async () => {
    const m = await typing('arc', { zoom: 2 });
    expect(m.canvas().dataset.painter).toBe('engine');
    expect(m.q('.arcstack, .arc-ch')).toBe(null);
    expect(m.q('.curve-edit')).not.toBe(null);
    expect(m.q('.type-edit')).toBe(null);
    expect(m.editable().classList.contains('ghost')).toBe(true);
    expect(m.editable().classList.contains('unseen')).toBe(true);
    // Everything selected: a mark a glyph, each the glyph's advance wide in
    // zoomed px (the model's glyphs are in page px).
    const glyphs = typeModel(m.box, boxText(m.box)).glyphs;
    const marks = m.all('.csel');
    expect(marks).toHaveLength(glyphs.length);
    // (A mark runs from the caret before its glyph to the caret after it.)
    expect(parseFloat(marks[0].style.width)).toBeGreaterThan(glyphs[0].w * 2 * 0.9);
    expect(parseFloat(marks[0].style.width)).toBeLessThan(glyphs[0].w * 2 * 1.2);
    expect(m.q('.ccaret').classList.contains('off')).toBe(true);
    // The caret - not shown over a selection, and what the editable's own
    // caret is brought under - is at the selection's focus, the end here.
    const zoomed = glyphs.map((g) => ({ ...g, x: g.x * 2, y: g.y * 2, w: g.w * 2 }));
    const atEnd = curveCaretAt(zoomed, glyphs.length);
    expect(atEnd.x).not.toBe(curveCaretAt(zoomed, 0).x);
    expect(m.q('.ccaret').style.transform).toContain(`+ ${atEnd.x}px`);
    // And a target a glyph for the pointer: an arc leaves its frame.
    const pads = m.all('.curve-edit .tpad');
    expect(pads).toHaveLength(glyphs.length);
    expect(parseFloat(pads[0].style.width)).toBeCloseTo(glyphs[0].w * 2, 6);
  });

  it('a curve whose casing makes a letter two is typed into on its picture all the same, a mark a drawn glyph', async () => {
    const m = await typing('upperArc');
    expect(m.canvas().dataset.painter).toBe('engine');
    expect(m.q('.curve-edit')).not.toBe(null);
    expect(m.editable().classList.contains('ghost')).toBe(true);
    expect(m.editable().classList.contains('unseen')).toBe(true);
    const model = typeModel(m.box, boxText(m.box));
    // "straße" is six letters and seven glyphs.
    expect(model.glyphs).toHaveLength(7);
    expect(m.all('.csel')).toHaveLength(7);
    expect(m.all('.curve-edit .tpad')).toHaveLength(7);
  });

  it('uppercase that makes a letter two: the caret after it stands after both', async () => {
    const m = await typing('upper');
    expect(m.q('.type-edit')).not.toBe(null);
    const rows = rowsOf(m.box);
    // "straße" is drawn STRASSE: seven letters, six offsets and the end.
    expect(rows[0].offs).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const x0 = rows[0].xs[0];
    expect(rows[0].xs.map((x) => x - x0)).toEqual([0, 10, 20, 30, 40, 60, 70]);
    // A press on the second S of the pair goes after the letter it is half of.
    press(m, x0 + 56, rows[0].top + 5);
    release(m);
    await tick();
    expect(m.sel()).toEqual([5, 5]);
    expect(px(m.q('.tcaret')).left).toBe(x0 + 60);
  });
});

// ===========================================================================
// Second round
// ===========================================================================

// A pointer event that says which pointer it is.
const ptr = (type, m, x, y, id, more = {}) => {
  const ev = new MouseEvent(type, at(m, x, y, more));
  Object.defineProperty(ev, 'pointerId', { value: id });
  return ev;
};
// Where glyph `g` of a curve is, as a point of the box's own frame.
const onGlyph = (m, g) => [m.box.w / 2 + g.x, m.box.h / 2 + g.y];

// jsdom lays nothing out. The rectangles the component measures are given:
// the editable's own caret (a collapsed range), its selection (a range that
// is not), and the drawn caret.
function geometry({ native, mark, selection = native }) {
  const rect = (r) => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top });
  const had = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  const whole = Element.prototype.getBoundingClientRect;
  Range.prototype.getClientRects = function () {
    return [rect(this.collapsed ? native : selection)];
  };
  Element.prototype.getBoundingClientRect = function () {
    return this.matches('.tcaret, .ccaret') ? rect(mark) : whole.call(this);
  };
  return () => {
    Element.prototype.getBoundingClientRect = whole;
    if (had) Object.defineProperty(Range.prototype, 'getClientRects', had);
    else delete Range.prototype.getClientRects;
  };
}
const shift = (el) => /translate\((-?[\d.e-]+)px, ?(-?[\d.e-]+)px\)/.exec(el.style.transform)?.slice(1).map(Number) ?? null;
// The browser moving the selection itself, and saying so.
function nativeSel(m, a, f = a) {
  const ed = m.editable();
  const [ac, ai] = domPoint(ed, a);
  const [fc, fi] = domPoint(ed, f);
  window.getSelection().setBaseAndExtent(ac, ai, fc, fi);
  document.dispatchEvent(new Event('selectionchange'));
}

describe('the keys a Mac binds to a move or a cut by lines go by the picture\'s lines', () => {
  let was;
  beforeEach(() => {
    was = isMacKeyboard();
    setMacKeyboard(true);
  });
  afterEach(() => setMacKeyboard(was));
  const ctrl = (m, k, more = {}) => key(m, k, { ctrlKey: true, ...more });
  const opt = (m, k, more = {}) => key(m, k, { altKey: true, ...more });
  // The caret after the first A of "AAAA BBBB CCCC", which is three rows.
  async function wrapped() {
    const m = await typing('wrapped');
    const rows = rowsOf(m.box);
    press(m, rows[0].xs[1] + 1, rows[0].top + 5);
    release(m);
    return { m, rows };
  }

  it('Control+E and Control+A are the row\'s ends, on the side of a wrap the caret is drawn on', async () => {
    const { m, rows } = await wrapped();
    const ev = ctrl(m, 'e');
    expect(ev.defaultPrevented).toBe(true);
    await tick();
    // Offset 5 is the end of row 1 and the start of row 2; it shows on row 1.
    expect(m.sel()).toEqual([5, 5]);
    expect(px(m.q('.tcaret'))).toMatchObject({ top: rows[0].top, left: rows[0].xs[5] });
    // The editable's own caret is at the start of the row below: left to
    // itself, Control+A would stay where it is.
    expect(ctrl(m, 'a').defaultPrevented).toBe(true);
    expect(m.sel()).toEqual([0, 0]);
    ctrl(m, 'ArrowRight');
    expect(m.sel()).toEqual([5, 5]);
    ctrl(m, 'ArrowLeft');
    expect(m.sel()).toEqual([0, 0]);
    // With Shift they extend.
    ctrl(m, 'E', { shiftKey: true });
    expect(m.sel()).toEqual([0, 5]);
    ctrl(m, 'ArrowLeft', { shiftKey: true });
    expect(m.sel()).toEqual([0, 0]);
  });

  it('Control+N, P, F and B are Down, Up, Right and Left', async () => {
    const { m, rows } = await wrapped();
    expect(ctrl(m, 'n').defaultPrevented).toBe(true);
    expect(m.sel()).toEqual([6, 6]);
    ctrl(m, 'n');
    expect(m.sel()).toEqual([11, 11]);
    ctrl(m, 'p');
    expect(m.sel()).toEqual([6, 6]);
    ctrl(m, 'f');
    expect(m.sel()).toEqual([7, 7]);
    ctrl(m, 'b');
    ctrl(m, 'b');
    await tick();
    // Back at the wrap by a step: the lower side, in one press.
    expect(m.sel()).toEqual([5, 5]);
    expect(px(m.q('.tcaret')).top).toBe(rows[1].top);
    ctrl(m, 'N', { shiftKey: true });
    expect(m.sel()).toEqual([5, 10]);
    ctrl(m, 'P', { shiftKey: true });
    ctrl(m, 'F', { shiftKey: true });
    expect(m.sel()).toEqual([5, 6]);
  });

  it('Option+Up and Option+Down step once and go to that row\'s end; with Shift they are Up and Down', async () => {
    const { m, rows } = await wrapped();
    // From 1: on to 2, then the end of row 1, on its upper side.
    expect(opt(m, 'ArrowDown').defaultPrevented).toBe(true);
    await tick();
    expect(m.sel()).toEqual([5, 5]);
    expect(px(m.q('.tcaret')).top).toBe(rows[0].top);
    // From there: on to 6, which is row 2, and its end.
    opt(m, 'ArrowDown');
    expect(m.sel()).toEqual([10, 10]);
    // Back: to 9, row 2, and its start.
    opt(m, 'ArrowUp');
    await tick();
    expect(m.sel()).toEqual([5, 5]);
    expect(px(m.q('.tcaret')).top).toBe(rows[1].top);
    // And from a row's start: to the start of the row before.
    opt(m, 'ArrowUp');
    expect(m.sel()).toEqual([0, 0]);
    press(m, rows[0].xs[2] + 1, rows[0].top + 5);
    release(m);
    opt(m, 'ArrowDown', { shiftKey: true });
    expect(m.sel()).toEqual([2, 7]);
    opt(m, 'ArrowUp', { shiftKey: true });
    expect(m.sel()).toEqual([2, 2]);
  });

  it('Control+V and Option+PageDown are the text\'s end, Option+PageUp its start', async () => {
    const { m } = await wrapped();
    expect(ctrl(m, 'v').defaultPrevented).toBe(true);
    expect(m.sel()).toEqual([14, 14]);
    opt(m, 'PageUp');
    expect(m.sel()).toEqual([0, 0]);
    opt(m, 'PageDown', { shiftKey: true });
    expect(m.sel()).toEqual([0, 14]);
  });

  it('Control+K cuts to the row\'s end, the row the caret is drawn on', async () => {
    const { m, rows } = await wrapped();
    press(m, rows[1].xs[2] + 1, rows[1].top + 5);
    release(m);
    expect(m.sel()).toEqual([7, 7]);
    expect(ctrl(m, 'k').defaultPrevented).toBe(true);
    await tick();
    // With the space the row wrapped at, which is the row's.
    expect(m.box.text).toBe('AAAA BBCCCC');
    expect(m.sel()).toEqual([7, 7]);
    cleanup();
    // On the upper side of a wrap there is nothing of the row left: one
    // character goes, as a delete over nothing takes - not the row below.
    const w = await wrapped();
    ctrl(w.m, 'e');
    ctrl(w.m, 'k');
    await tick();
    expect(w.m.box.text).toBe('AAAA BBB CCCC');
    cleanup();
    // With something selected, the selection.
    const t = await wrapped();
    ctrl(t.m, 'F', { shiftKey: true });
    ctrl(t.m, 'F', { shiftKey: true });
    ctrl(t.m, 'k');
    await tick();
    expect(t.m.box.text).toBe('AA BBBB CCCC');
  });

  it('what the system binds to an edit at an offset, and a key it binds nothing to, stay the browser\'s', async () => {
    const { m } = await wrapped();
    for (const k of ['d', 'h', 't', 'o', 'y', 'l', 'ArrowUp', 'ArrowDown', 'x']) expect(ctrl(m, k).defaultPrevented, `Control+${k}`).toBe(false);
    for (const k of ['ArrowLeft', 'ArrowRight', 'Backspace', 'f']) expect(opt(m, k).defaultPrevented, `Option+${k}`).toBe(false);
    expect(key(m, 'f', { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(key(m, 'a', { ctrlKey: true, metaKey: true }).defaultPrevented).toBe(false);
    expect(ctrl(m, 'K', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(m.sel()).toEqual([1, 1]);
    expect(m.box.text).toBe('AAAA BBBB CCCC');
  });

  it('a delete to the line\'s END is cut from the picture\'s row too, and so is one that names the paragraph', async () => {
    const { m, rows } = await wrapped();
    press(m, rows[1].xs[2] + 1, rows[1].top + 5);
    release(m);
    input(m, 'deleteSoftLineForward');
    await tick();
    expect(m.box.text).toBe('AAAA BBCCCC');
    cleanup();
    // The system's WebKit sends Cmd+Backspace as a delete to the PARAGRAPH's
    // start. In the editable a paragraph is a drawn line: the row goes, on
    // the side of the wrap the caret is drawn on, and not the text before it.
    const w = await wrapped();
    press(w.m, w.rows[1].xs[2] + 1, w.rows[1].top + 5);
    release(w.m);
    input(w.m, 'deleteHardLineBackward');
    await tick();
    expect(w.m.box.text).toBe('AAAA BB CCCC');
    cleanup();
    const u = await wrapped();
    ctrl(u.m, 'e');
    input(u.m, 'deleteHardLineBackward');
    await tick();
    expect(u.m.box.text).toBe('BBBB CCCC');
    cleanup();
    const f = await wrapped();
    input(f.m, 'deleteHardLineForward');
    await tick();
    expect(f.m.box.text).toBe('ABBBB CCCC');
  });

  it('on a curve that is a picture they are the curve\'s keys: the paragraph\'s ends, the text\'s, and a cut to the paragraph\'s end', async () => {
    const m = await typing('arc');
    // "WAIT FOR ME\nOVER THERE": the caret after WAIT.
    const g = typeModel(m.box, boxText(m.box)).glyphs;
    m.q('.curve-edit').dispatchEvent(ptr('pointerdown', m, ...onGlyph(m, g[4]), 1));
    m.q('.curve-edit').dispatchEvent(ptr('pointerup', m, ...onGlyph(m, g[4]), 1));
    const at0 = m.sel()[1];
    expect(at0).toBeGreaterThan(0);
    expect(at0).toBeLessThan(11);
    expect(ctrl(m, 'e').defaultPrevented).toBe(true);
    expect(m.sel()).toEqual([11, 11]);
    ctrl(m, 'a');
    expect(m.sel()).toEqual([0, 0]);
    ctrl(m, 'n');
    expect(m.sel()).toEqual([22, 22]);
    ctrl(m, 'P', { shiftKey: true });
    expect(m.sel()).toEqual([22, 0]);
    ctrl(m, 'ArrowRight');
    expect(m.sel()).toEqual([11, 11]);
    // One step on (the Return), then that paragraph's end.
    opt(m, 'ArrowDown');
    expect(m.sel()).toEqual([22, 22]);
    opt(m, 'ArrowUp');
    expect(m.sel()).toEqual([12, 12]);
    // Left and Right step through the raw text in the browser, as they did.
    expect(ctrl(m, 'f').defaultPrevented).toBe(false);
    expect(ctrl(m, 'b').defaultPrevented).toBe(false);
    nativeSel(m, 4);
    expect(ctrl(m, 'k').defaultPrevented).toBe(true);
    await tick();
    expect(m.box.text).toBe('WAIT\nOVER THERE');
    // And a delete to the line's start, however the hidden editable wraps.
    nativeSel(m, 9);
    input(m, 'deleteSoftLineBackward');
    await tick();
    expect(m.box.text).toBe('WAIT\n THERE');
  });

  it('with the switch off none of it is taken, on straight text or on a curve', async () => {
    engineSwitch.painting = false;
    for (const id of ['wrapped', 'arc']) {
      const m = await typing(id);
      for (const k of ['a', 'e', 'n', 'p', 'f', 'b', 'k', 'v', 'ArrowLeft']) expect(ctrl(m, k).defaultPrevented, `${id}: Control+${k}`).toBe(false);
      for (const k of ['ArrowUp', 'ArrowDown', 'PageDown']) expect(opt(m, k).defaultPrevented, `${id}: Option+${k}`).toBe(false);
      cleanup();
    }
  });
});

describe('a drag is the pointer\'s that began it', () => {
  it('another pointer moving over the picture, or let go, neither moves the selection nor ends the drag', async () => {
    const m = await typing('plain');
    const rows = rowsOf(m.box);
    const el = m.q('.type-edit');
    const y = rows[0].top + 5;
    el.dispatchEvent(ptr('pointerdown', m, rows[0].xs[1] + 1, y, 1));
    expect(m.sel()).toEqual([1, 1]);
    el.dispatchEvent(ptr('pointermove', m, rows[1].xs[1] + 1, rows[1].top + 5, 2));
    expect(m.sel()).toEqual([1, 1]);
    el.dispatchEvent(ptr('pointercancel', m, 0, 0, 2));
    el.dispatchEvent(ptr('pointerup', m, 0, 0, 2));
    // The first pointer's drag is still its own.
    el.dispatchEvent(ptr('pointermove', m, rows[0].xs[6] + 1, y, 1));
    expect(m.sel()).toEqual([1, 6]);
    // And a press by another pointer meanwhile is not a press of the text.
    el.dispatchEvent(ptr('pointerdown', m, rows[1].xs[4] + 1, rows[1].top + 5, 2));
    expect(m.sel()).toEqual([1, 6]);
    el.dispatchEvent(ptr('pointerup', m, rows[0].xs[6] + 1, y, 1));
    el.dispatchEvent(ptr('pointermove', m, rows[0].xs[9] + 1, y, 1));
    expect(m.sel()).toEqual([1, 6]);
    // With the first let go, the other pointer can press.
    el.dispatchEvent(ptr('pointerdown', m, rows[1].xs[4] + 1, rows[1].top + 5, 2));
    expect(m.sel()).toEqual([16, 16]);
  });

  it('the press takes the pointer for itself, so the drag follows it off the picture; a pointer that cannot be taken still places the caret', async () => {
    const m = await typing('plain');
    const rows = rowsOf(m.box);
    const el = m.q('.type-edit');
    el.setPointerCapture = vi.fn();
    el.dispatchEvent(ptr('pointerdown', m, rows[0].xs[2] + 1, rows[0].top + 5, 7));
    expect(el.setPointerCapture).toHaveBeenCalledTimes(1);
    expect(el.setPointerCapture).toHaveBeenCalledWith(7);
    // Losing it ends the drag.
    el.dispatchEvent(ptr('lostpointercapture', m, 0, 0, 7));
    el.dispatchEvent(ptr('pointermove', m, rows[0].xs[6] + 1, rows[0].top + 5, 7));
    expect(m.sel()).toEqual([2, 2]);
    el.setPointerCapture = vi.fn(() => {
      throw new DOMException('no such pointer', 'NotFoundError');
    });
    el.dispatchEvent(ptr('pointerdown', m, rows[0].xs[4] + 1, rows[0].top + 5, 8));
    expect(m.sel()).toEqual([4, 4]);
  });

  it('on a curve that is a picture too', async () => {
    const m = await typing('arc');
    const g = typeModel(m.box, boxText(m.box)).glyphs;
    const el = m.q('.curve-edit');
    el.dispatchEvent(ptr('pointerdown', m, ...onGlyph(m, g[2]), 1));
    const from = m.sel();
    expect(from[0]).toBe(from[1]);
    el.dispatchEvent(ptr('pointermove', m, ...onGlyph(m, g[8]), 2));
    expect(m.sel()).toEqual(from);
    el.dispatchEvent(ptr('pointerup', m, 0, 0, 2));
    el.dispatchEvent(ptr('pointermove', m, ...onGlyph(m, g[8]), 1));
    expect(m.sel()[0]).toBe(from[0]);
    expect(m.sel()[1]).toBeGreaterThan(from[1] + 3);
    const held = m.sel();
    el.dispatchEvent(ptr('pointerup', m, 0, 0, 1));
    el.dispatchEvent(ptr('pointermove', m, ...onGlyph(m, g[1]), 1));
    expect(m.sel()).toEqual(held);
  });
});

describe('the right button on a curve that is a picture', () => {
  it('selects the word under it and steps aside for the system\'s menu, as on straight text - a curve with a letter cased to two as well', async () => {
    vi.useFakeTimers();
    try {
      for (const id of ['upperArc', 'arc']) {
        const m = await typing(id);
        const model = typeModel(m.box, boxText(m.box));
        const el = m.q('.curve-edit');
        // A caret first: the edit opens with everything selected.
        el.dispatchEvent(ptr('pointerdown', m, ...onGlyph(m, model.glyphs[0]), 1));
        el.dispatchEvent(ptr('pointerup', m, ...onGlyph(m, model.glyphs[0]), 1));
        const ev = ptr('pointerdown', m, ...onGlyph(m, model.glyphs[2]), 1, { button: 2 });
        el.dispatchEvent(ev);
        expect(ev.defaultPrevented, id).toBe(false);
        // "straße" is one word; of "WAIT FOR ME\nOVER THERE" the first.
        expect(m.sel(), id).toEqual(id === 'upperArc' ? [0, 6] : [0, 4]);
        expect(el.classList.contains('ctx'), id).toBe(true);
        window.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        vi.runAllTimers();
        expect(el.classList.contains('ctx'), id).toBe(false);
        // On the selection, it leaves the selection alone.
        el.dispatchEvent(ptr('pointerdown', m, ...onGlyph(m, model.glyphs[1]), 1, { button: 2 }));
        expect(m.sel(), id).toEqual(id === 'upperArc' ? [0, 6] : [0, 4]);
        vi.runAllTimers();
        expect(el.classList.contains('ctx'), id).toBe(false);
        cleanup();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('for as long as it stands aside the editable has its own selection under the pointer, and is put back after', async () => {
    vi.useFakeTimers();
    // The drawn caret and the editable's own agree, so nothing else moves it.
    const restore = geometry({ native: { left: 100.75, top: 50, width: 0, height: 24 }, mark: { left: 100, top: 50, width: 1.5, height: 24 }, selection: { left: 300, top: 400, width: 40, height: 20 } });
    try {
      for (const id of ['arc', 'plain', 'flipped']) {
        const m = await typing(id);
        const el = m.q('.curve-edit, .type-edit');
        el.dispatchEvent(ptr('pointerdown', m, 20, 10, 1));
        el.dispatchEvent(ptr('pointerup', m, 20, 10, 1));
        await tick();
        expect(m.editable().style.transform, id).toBe('');
        const ev = ptr('pointerdown', m, 60, 30, 1, { button: 2 });
        el.dispatchEvent(ev);
        expect(m.sel()[0], id).not.toBe(m.sel()[1]);
        // The selection's middle is at (320, 410) and the pointer at the
        // event's own point: the editable is moved by the difference, in its
        // own frame (a flipped box's is mirrored).
        const [dx, dy] = [ev.clientX - 320, ev.clientY - 410];
        expect(shift(m.editable()), id).toEqual([id === 'flipped' ? -dx : dx, dy]);
        window.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        vi.runAllTimers();
        await tick();
        expect(m.editable().style.transform, id).toBe('');
        cleanup();
      }
    } finally {
      restore();
      vi.useRealTimers();
    }
  });
});

describe('while the editable is moved for the menu its caret is not brought back', () => {
  it('a selection changing under the menu leaves the editable where the menu has it', async () => {
    vi.useFakeTimers();
    // The drawn caret is (17.75, -2) from the editable's own; the selection's
    // middle is at (320, 410).
    const restore = geometry({ native: { left: 40, top: 50, width: 0, height: 20 }, mark: { left: 57, top: 46, width: 1.5, height: 24 }, selection: { left: 300, top: 400, width: 40, height: 20 } });
    try {
      const m = await typing('plain');
      const rows = rowsOf(m.box);
      const el = m.q('.type-edit');
      press(m, rows[0].xs[1] + 1, rows[0].top + 5);
      release(m);
      await tick();
      const before = shift(m.editable());
      const ev = ptr('pointerdown', m, rows[1].xs[6] + 3, rows[1].top + 5, 1, { button: 2 });
      el.dispatchEvent(ev);
      const moved = shift(m.editable());
      expect(m.sel()).toEqual([17, 22]);
      // The caret went to the word's end, and was brought under the drawn
      // one once more; then the editable was moved for the menu.
      expect(moved[0] - before[0]).toBeCloseTo(17.75 + ev.clientX - 320, 6);
      expect(moved[1] - before[1]).toBeCloseTo(-2 + ev.clientY - 410, 6);
      // The system selecting something of its own under the menu.
      nativeSel(m, 12, 16);
      await tick();
      expect(shift(m.editable())).toEqual(moved);
      window.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      vi.runAllTimers();
      await tick();
      // Back, and its caret under the drawn one for what is selected now.
      expect(shift(m.editable())).not.toEqual(moved);
      expect(Math.abs(shift(m.editable())[0] - moved[0])).toBeGreaterThan(100);
    } finally {
      restore();
      vi.useRealTimers();
    }
  });
});

describe('the editable\'s own caret is kept under the drawn one', () => {
  // The drawn caret's middle is (57.75, 58) and the editable's own (40, 60).
  const apart = { native: { left: 40, top: 50, width: 0, height: 20 }, mark: { left: 57, top: 46, width: 1.5, height: 24 } };
  let restore;
  beforeEach(() => {
    restore = geometry(apart);
  });
  afterEach(() => restore());

  it('by the distance between them, taken through the box\'s flip', async () => {
    const m = await typing('plain');
    expect(shift(m.editable())).toEqual([17.75, -2]);
    cleanup();
    const h = await typing('flipped');
    expect(shift(h.editable())).toEqual([-17.75, -2]);
    cleanup();
    const v = await typing('flippedV');
    expect(shift(v.editable())).toEqual([17.75, 2]);
  });

  it('and is when the engine comes on in the middle of an edit, as in one begun with it', async () => {
    engineSwitch.painting = false;
    const m = await typing('plain');
    const ed = m.editable();
    expect(m.q('.type-edit')).toBe(null);
    expect(ed.style.transform).toBe('');
    engineSwitch.painting = true;
    await tick();
    expect(m.editable()).toBe(ed);
    expect(m.q('.type-edit')).not.toBe(null);
    expect(ed.classList.contains('unseen')).toBe(true);
    expect(shift(ed)).toEqual([17.75, -2]);
  });

  it('nothing of it is left when the switch goes off in the middle of an edit, or the paint fails', async () => {
    const m = await typing('plain');
    const ed = m.editable();
    expect(shift(ed)).toEqual([17.75, -2]);
    engineSwitch.painting = false;
    await tick();
    expect(m.editable()).toBe(ed);
    expect(ed.classList.contains('unseen')).toBe(false);
    expect(ed.style.transform).toBe('');
    // And on again: measured again, from nothing.
    engineSwitch.painting = true;
    await tick();
    expect(shift(ed)).toEqual([17.75, -2]);
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      paintBoxPicture.mockImplementation(() => {
        throw new Error('refused');
      });
      input(m, 'insertText', 'S');
      await tick();
      expect(m.q('.type-edit')).toBe(null);
      expect(m.editable()).toBe(ed);
      expect(ed.style.transform).toBe('');
      paintBoxPicture.mockImplementation(real.paintBoxPicture);
      input(m, 'insertText', '?');
      await tick();
      expect(m.q('.type-edit')).not.toBe(null);
      expect(shift(ed)).toEqual([17.75, -2]);
    } finally {
      said.mockRestore();
    }
  });

  it('with the switch off the editable is never moved', async () => {
    engineSwitch.painting = false;
    const m = await typing('plain');
    input(m, 'insertText', 'S');
    await tick();
    expect(m.editable().style.transform).toBe('');
  });
});

describe('a selection the browser moved itself starts again', () => {
  it('no side of a wrap is kept: the caret shows where the browser has it', async () => {
    const m = await typing('wrapped');
    const rows = rowsOf(m.box);
    press(m, rows[0].xs[1] + 1, rows[0].top + 5);
    release(m);
    key(m, 'End');
    await tick();
    expect(m.sel()).toEqual([5, 5]);
    expect(px(m.q('.tcaret')).top).toBe(rows[0].top);
    // A word step on, by the browser, and one back: at 5 again, and to the
    // browser that is the start of the row below.
    nativeSel(m, 10);
    nativeSel(m, 5);
    await tick();
    expect(px(m.q('.tcaret'))).toMatchObject({ top: rows[1].top, left: rows[1].xs[0] });
    // Home from there is that row's start, which is where it is.
    key(m, 'Home');
    expect(m.sel()).toEqual([5, 5]);
  });

  it('no column is kept: Up goes by where the caret now is', async () => {
    const m = await typing('plain');
    const rows = rowsOf(m.box);
    // The end of "WAIT FOR ME"; Down is the end of the shorter row below,
    // aiming for the column it left.
    press(m, rows[0].xs[11] + 1, rows[0].top + 5);
    release(m);
    key(m, 'ArrowDown');
    expect(m.sel()).toEqual([22, 22]);
    nativeSel(m, 14);
    key(m, 'ArrowUp');
    expect(m.sel()).toEqual([2, 2]);
  });
});

describe('while keys are coming a large box is painted within a smaller budget', () => {
  const last = () => ({ budget: paintBoxPicture.mock.calls.at(-1)[5], ss: paintBoxPicture.mock.results.at(-1).value.ss, box: paintBoxPicture.mock.calls.at(-1)[1] });
  // The timers set for the pause that have been neither cleared nor let run
  // (the one that runs clears itself: `settleKeys`). The app sets others of
  // its own for a key - the save, the undo - which are not these.
  let set;
  let cleared;
  const waiting = () => {
    const gone = new Set(cleared.mock.calls.map((c) => c[0]));
    return set.mock.calls.flatMap((c, i) => (c[1] === 150 && !gone.has(set.mock.results[i].value) ? [set.mock.results[i].value] : []));
  };
  beforeEach(() => {
    vi.useFakeTimers();
    set = vi.spyOn(globalThis, 'setTimeout');
    cleared = vi.spyOn(globalThis, 'clearTimeout');
  });
  afterEach(() => {
    set.mockRestore();
    cleared.mockRestore();
    vi.useRealTimers();
  });
  async function caretIn(id) {
    const m = await typing(id);
    const rows = rowsOf(m.box);
    press(m, rows[0].xs[4] + 1, rows[0].top + 5);
    release(m);
    await tick();
    return m;
  }

  it('and once in full, 150 ms after the last key; the marks do not move with it', async () => {
    const m = await caretIn('big');
    // At rest it is painted in full: one texture pixel a device pixel.
    expect(m.paints()).toBe(1);
    expect(last()).toMatchObject({ budget: PICTURE_MAX_PX, ss: 1 });
    const full = m.canvas().width * m.canvas().height;
    expect(full).toBeGreaterThan(PICTURE_DRAG_PX);
    input(m, 'insertText', 'S');
    await tick();
    expect(m.paints()).toBe(2);
    expect(last().budget).toBe(PICTURE_DRAG_PX);
    expect(last().ss).toBeLessThan(1);
    expect(m.canvas().width * m.canvas().height).toBeLessThanOrEqual(PICTURE_DRAG_PX * 1.03);
    const caret = px(m.q('.tcaret'));
    const shown = px(m.canvas());
    expect(waiting()).toHaveLength(1);
    // Another key inside the pause starts the pause again.
    vi.advanceTimersByTime(100);
    input(m, 'insertText', 'S');
    await tick();
    expect(m.paints()).toBe(3);
    expect(last().budget).toBe(PICTURE_DRAG_PX);
    vi.advanceTimersByTime(149);
    await tick();
    expect(m.paints()).toBe(3);
    vi.advanceTimersByTime(1);
    await tick();
    expect(m.paints()).toBe(4);
    expect(last()).toMatchObject({ budget: PICTURE_MAX_PX, ss: 1 });
    expect(boxText(last().box)).toBe('WAITSS FOR ME\nOVER THERE');
    expect(m.canvas().width * m.canvas().height).toBe(full);
    // The same place on the page, and the caret a letter on from where the
    // first key left it: neither is the picture's to move.
    const sharp = px(m.canvas());
    expect([sharp.left, sharp.top]).toEqual([shown.left, shown.top]);
    // (The soft picture covers the same page px to within a texel of its own
    // on each edge, which is its rounding.)
    expect(Math.abs(sharp.width - shown.width)).toBeLessThan(2.2);
    expect(Math.abs(sharp.height - shown.height)).toBeLessThan(2.2);
    expect(px(m.q('.tcaret'))).toEqual({ ...caret, left: caret.left + 10 });
    expect(waiting()).toHaveLength(0);
    // And nothing more after it.
    vi.advanceTimersByTime(1000);
    await tick();
    expect(m.paints()).toBe(4);
  });

  it('a box under that budget is painted as it always was, once a key and never again', async () => {
    const m = await caretIn('plain');
    const size = [m.canvas().width, m.canvas().height];
    input(m, 'insertText', 'S');
    await tick();
    expect(m.paints()).toBe(2);
    expect(last().ss).toBe(1);
    expect([m.canvas().width, m.canvas().height]).toEqual(size);
    vi.advanceTimersByTime(1000);
    await tick();
    expect(m.paints()).toBe(2);
    expect(waiting()).toHaveLength(0);
  });

  it('the edit ending inside the pause paints it in full at once, and leaves no timer', async () => {
    const m = await caretIn('big');
    input(m, 'insertText', 'S');
    await tick();
    expect(last().ss).toBeLessThan(1);
    expect(waiting()).toHaveLength(1);
    // As the blur ends it: with the text the editable holds.
    endEdit(m.editable().textContent);
    await tick();
    expect(waiting()).toHaveLength(0);
    expect(m.paints()).toBe(3);
    expect(last()).toMatchObject({ budget: PICTURE_MAX_PX, ss: 1 });
    vi.advanceTimersByTime(1000);
    await tick();
    expect(m.paints()).toBe(3);
  });

  it('a box deleted inside the pause leaves no timer either', async () => {
    const m = await caretIn('big');
    input(m, 'insertText', 'S');
    await tick();
    expect(waiting()).toHaveLength(1);
    const n = m.paints();
    m.view.unmount();
    expect(waiting()).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(m.paints()).toBe(n);
  });

  it('an undo is a key, and so is what an IME has in hand: the composition is painted the same way and ends as it did', async () => {
    const m = await caretIn('big');
    const ed = m.editable();
    ed.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const node = ed.querySelector('.el').firstChild;
    node.data = 'WAITに FOR ME';
    window.getSelection().setBaseAndExtent(node, 5, node, 5);
    ed.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    await tick();
    expect(m.paints()).toBe(2);
    expect(last().budget).toBe(PICTURE_DRAG_PX);
    expect(last().box.text).toBe('WAITに FOR ME\nOVER THERE');
    expect(m.all('.tcomp')).toHaveLength(1);
    // The pause passes with the composition still open: in full, and still
    // the composed text.
    vi.advanceTimersByTime(150);
    await tick();
    expect(m.paints()).toBe(3);
    expect(last()).toMatchObject({ budget: PICTURE_MAX_PX, ss: 1 });
    expect(last().box.text).toBe('WAITに FOR ME\nOVER THERE');
    expect(m.box.text).toBe('WAIT FOR ME\nOVER THERE');
    expect(m.all('.tcomp')).toHaveLength(1);
    ed.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.advanceTimersByTime(0);
    await tick();
    expect(m.box.text).toBe('WAITに FOR ME\nOVER THERE');
    expect(m.all('.tcomp')).toHaveLength(0);
    expect(last().budget).toBe(PICTURE_DRAG_PX);
    vi.advanceTimersByTime(150);
    await tick();
    expect(last()).toMatchObject({ budget: PICTURE_MAX_PX, ss: 1 });
    const n = m.paints();
    key(m, 'z', { metaKey: true });
    await tick();
    expect(m.box.text).toBe('WAIT FOR ME\nOVER THERE');
    expect(m.paints()).toBe(n + 1);
    expect(last().budget).toBe(PICTURE_DRAG_PX);
    vi.advanceTimersByTime(150);
    await tick();
    expect(last().budget).toBe(PICTURE_MAX_PX);
    expect(waiting()).toHaveLength(0);
  });

  it('with the switch off a key sets no timer', async () => {
    engineSwitch.painting = false;
    const m = await typing('big');
    input(m, 'insertText', 'S');
    await tick();
    expect(m.box.text).toBe('S');
    expect(set.mock.calls.filter((c) => c[1] === 150)).toHaveLength(0);
  });
});

// ===========================================================================
// Third round
// ===========================================================================

describe('while an IME composes, nothing the picture answers moves the caret or changes the text', () => {
  let was;
  beforeEach(() => {
    was = isMacKeyboard();
    setMacKeyboard(true);
  });
  afterEach(() => setMacKeyboard(was));
  const composition = (m, type) => m.editable().dispatchEvent(new CompositionEvent(type, { bubbles: true }));
  // Every key the picture's rows, or a curve's glyphs, answer. Each arrives
  // WITHOUT `isComposing`, as a key can in the middle of a composition: the
  // one thing that says so is that a composition was started and has not ended.
  const KEYS = [
    ['k', { ctrlKey: true }], ['e', { ctrlKey: true }], ['a', { ctrlKey: true }], ['n', { ctrlKey: true }], ['p', { ctrlKey: true }],
    ['f', { ctrlKey: true }], ['b', { ctrlKey: true }], ['v', { ctrlKey: true }], ['ArrowLeft', { ctrlKey: true }],
    ['ArrowDown', { altKey: true }], ['ArrowUp', { altKey: true }], ['PageDown', { altKey: true }], ['ArrowDown', { altKey: true, shiftKey: true }],
    ['ArrowUp', {}], ['ArrowDown', {}], ['ArrowLeft', {}], ['ArrowRight', {}], ['Home', {}], ['End', {}], ['End', { shiftKey: true }],
    ['ArrowLeft', { metaKey: true }], ['ArrowDown', { metaKey: true }], ['PageUp', {}],
  ];

  it.each(['arc', 'upperArc', 'wrapped', 'plain'])('%s: no key, no line delete, no press', async (id) => {
    const m = await typing(id);
    const text = m.box.text;
    nativeSel(m, 4);
    await tick();
    composition(m, 'compositionstart');
    for (const [k, more] of KEYS) {
      const ev = key(m, k, more);
      const say = `${Object.keys(more).join('+')} ${k}`;
      expect(ev.defaultPrevented, say).toBe(false);
      expect(m.sel(), say).toEqual([4, 4]);
      await tick();
      expect(m.box.text, say).toBe(text);
    }
    // A delete to the line's start or end is not cut from the picture's rows
    // either: it is the browser's, in the text it is composing in.
    for (const t of ['deleteSoftLineBackward', 'deleteHardLineBackward', 'deleteSoftLineForward', 'deleteHardLineForward']) {
      expect(input(m, t).defaultPrevented, t).toBe(false);
      await tick();
      expect(m.box.text, t).toBe(text);
      expect(m.sel(), t).toEqual([4, 4]);
    }
    // Nor does a press, a double press or the right button.
    const el = m.q('.curve-edit, .type-edit');
    for (const [type, more] of [['pointerdown', {}], ['pointerdown', { button: 2 }], ['mousedown', { detail: 2 }], ['dblclick', {}]]) {
      el.dispatchEvent(ptr(type, m, 150, 30, 1, more));
      expect(m.sel(), type).toEqual([4, 4]);
      expect(el.classList.contains('ctx'), type).toBe(false);
    }
    el.dispatchEvent(ptr('pointerup', m, 150, 30, 1));
    // The composition over, the keys are the picture's again.
    vi.useFakeTimers();
    try {
      composition(m, 'compositionend');
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
    await tick();
    nativeSel(m, 4);
    const ev = key(m, 'e', { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(m.sel()[0]).toBeGreaterThan(4);
    expect(m.box.text).toBe(text);
  });

  it('with the switch off a curve takes its keys as it did, composing or not', async () => {
    engineSwitch.painting = false;
    const m = await typing('arc');
    nativeSel(m, 4);
    composition(m, 'compositionstart');
    expect(key(m, 'End').defaultPrevented).toBe(true);
    expect(m.sel()).toEqual([11, 11]);
  });

  it.each(['blur', 'endEdit'])('composition ends with its editable on %s; reentry keeps all the original text', async (way) => {
    const m = await typing('plain');
    const original = m.box.text;
    nativeSel(m, 4);
    composition(m, 'compositionstart');
    if (way === 'blur') m.editable().dispatchEvent(new Event('blur'));
    else endEdit(original);
    await tick();
    beginEdit(m.box.id);
    await tick();
    expect(m.editable().textContent).toBe(original);
    nativeSel(m, 4);
    expect(input(m, 'insertText', 'X').defaultPrevented).toBe(true);
    await tick();
    expect(m.box.text).toBe('WAITX FOR ME\nOVER THERE');
  });

  it('an old composition completion cannot end a composition in a later edit', async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      const m = await typing('plain');
      nativeSel(m, 4);
      composition(m, 'compositionstart');
      composition(m, 'compositionend');
      const oldFinish = timers.mock.calls.find((c) => c[0].name === 'finish')[0];
      endEdit(m.box.text);
      await tick();
      beginEdit(m.box.id);
      await tick();
      nativeSel(m, 4);
      composition(m, 'compositionstart');
      const node = m.editable().querySelector('.el').firstChild;
      node.data = 'WAITに FOR ME';
      m.editable().dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
      await tick();
      // A browser task already queued before cancellation must also check
      // its editable owner; it cannot clear the new composing range.
      oldFinish();
      vi.advanceTimersByTime(0);
      await tick();
      expect(m.box.text).toBe('WAIT FOR ME\nOVER THERE');
      expect(m.all('.tcomp')).toHaveLength(1);
      expect(input(m, 'deleteHardLineForward').defaultPrevented).toBe(false);
      expect(m.box.text).toBe('WAIT FOR ME\nOVER THERE');
      composition(m, 'compositionend');
      vi.advanceTimersByTime(0);
      await tick();
      expect(m.box.text).toBe('WAITに FOR ME\nOVER THERE');
    } finally {
      timers.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['arc', 'plain'])('%s: losing the model during composition keeps the open composition protected', async (id) => {
    const m = await typing(id);
    const original = m.box.text;
    nativeSel(m, 4);
    composition(m, 'compositionstart');
    const { lineCarets, ...withoutCarets } = half;
    setTextEngine(withoutCarets);
    clearLayoutMemo();
    app.fontsVersion++;
    await tick();
    expect(engineSwitch.painting).toBe(true);
    expect(m.q('.type-edit')).toBeNull();
    expect(key(m, 'End').defaultPrevented).toBe(false);
    expect(m.sel()).toEqual([4, 4]);
    expect(input(m, 'deleteHardLineForward').defaultPrevented).toBe(false);
    expect(m.box.text).toBe(original);
  });

  it('paste and cut leave an open picture composition to the browser too', async () => {
    const m = await typing('plain');
    nativeSel(m, 0, 4);
    composition(m, 'compositionstart');
    for (const type of ['paste', 'cut']) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: { getData: () => 'X', setData: vi.fn() } });
      m.editable().dispatchEvent(ev);
      await tick();
      expect(ev.defaultPrevented).toBe(false);
      expect(m.box.text).toBe('WAIT FOR ME\nOVER THERE');
      expect(m.sel()).toEqual([0, 4]);
    }
  });
});

describe('a curve drag whose pointer the browser took back is over', () => {
  it.each(['pointerup', 'pointercancel'])('%s ends only the pointer that began the pictured curve drag', async (type) => {
    const m = await typing('arc');
    const el = m.q('.curve-edit');
    const glyphs = typeModel(m.box, m.box.text).glyphs;
    el.dispatchEvent(ptr('pointerdown', m, ...onGlyph(m, glyphs[2]), 1));
    const start = m.sel();
    el.dispatchEvent(ptr(type, m, 0, 0, 2));
    el.dispatchEvent(ptr('pointermove', m, ...onGlyph(m, glyphs[6]), 1));
    const moved = m.sel();
    expect(moved[0]).toBe(start[0]);
    expect(moved[1]).toBeGreaterThan(start[1]);
    el.dispatchEvent(ptr(type, m, 0, 0, 1));
    el.dispatchEvent(ptr('pointermove', m, ...onGlyph(m, glyphs[9]), 1));
    expect(m.sel()).toEqual(moved);
  });

  it.each(['switch', 'model', 'composition', 'endEdit'])('a pictured curve drag ends on %s and never reaches the next edit/mode', async (way) => {
    const m = await typing('arc');
    const el = m.q('.curve-edit');
    const glyphs = typeModel(m.box, m.box.text).glyphs;
    el.dispatchEvent(ptr('pointerdown', m, ...onGlyph(m, glyphs[2]), 1));
    const start = m.sel();
    if (way === 'switch') engineSwitch.painting = false;
    if (way === 'model') {
      const { lineCarets, ...withoutCarets } = half;
      setTextEngine(withoutCarets);
      clearLayoutMemo();
      app.fontsVersion++;
    }
    if (way === 'composition') m.editable().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    if (way === 'endEdit') endEdit(m.box.text);
    await tick();
    if (way !== 'endEdit') {
      el.dispatchEvent(ptr('pointermove', m, ...onGlyph(m, glyphs[9]), 2));
      expect(m.sel()).toEqual(start);
    }
    if (way === 'switch') engineSwitch.painting = true;
    if (way === 'model') {
      setTextEngine(half);
      clearLayoutMemo();
      app.fontsVersion++;
    }
    if (way === 'endEdit') beginEdit(m.box.id);
    await tick();
    if (way === 'composition') {
      // Ignoring moves only while composing is not enough: the old gesture
      // must remain ended when the composition has finished.
      m.editable().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    }
    const held = m.sel();
    el.dispatchEvent(ptr('pointermove', m, ...onGlyph(m, glyphs[9]), 1));
    expect(m.sel()).toEqual(held);
  });
  it('nothing goes on selecting after the capture is lost, and another pointer losing its own ends nothing', async () => {
    const m = await typing('arc');
    const g = typeModel(m.box, boxText(m.box)).glyphs;
    const el = m.q('.curve-edit');
    el.dispatchEvent(ptr('pointerdown', m, ...onGlyph(m, g[2]), 1));
    const from = m.sel();
    // Another pointer's capture going is not this drag's.
    el.dispatchEvent(ptr('lostpointercapture', m, 0, 0, 2));
    el.dispatchEvent(ptr('pointermove', m, ...onGlyph(m, g[6]), 1));
    const held = m.sel();
    expect(held[0]).toBe(from[0]);
    expect(held[1]).toBeGreaterThan(from[1] + 2);
    // Its own: the button is let go somewhere the curve never hears of.
    el.dispatchEvent(ptr('lostpointercapture', m, 0, 0, 1));
    el.dispatchEvent(ptr('pointermove', m, ...onGlyph(m, g[9]), 1));
    expect(m.sel()).toEqual(held);
    el.dispatchEvent(ptr('pointermove', m, ...onGlyph(m, g[1]), 1));
    expect(m.sel()).toEqual(held);
  });

  it('and so is one on straight text', async () => {
    const m = await typing('plain');
    const rows = rowsOf(m.box);
    const el = m.q('.type-edit');
    el.dispatchEvent(ptr('pointerdown', m, rows[0].xs[1] + 1, rows[0].top + 5, 1));
    el.dispatchEvent(ptr('lostpointercapture', m, 0, 0, 2));
    el.dispatchEvent(ptr('pointermove', m, rows[0].xs[6] + 1, rows[0].top + 5, 1));
    expect(m.sel()).toEqual([1, 6]);
    el.dispatchEvent(ptr('lostpointercapture', m, 0, 0, 1));
    el.dispatchEvent(ptr('pointermove', m, rows[1].xs[3] + 1, rows[1].top + 5, 1));
    expect(m.sel()).toEqual([1, 6]);
  });

  it('with the switch off a curve has the listeners it had, and no other', async () => {
    engineSwitch.painting = false;
    const m = await typing('arc');
    const el = m.q('.curve-edit');
    const add = vi.spyOn(el, 'addEventListener');
    try {
      el.dispatchEvent(ptr('pointerdown', m, 150, 30, 1));
      expect(add.mock.calls.map((c) => c[0]).sort()).toEqual(['pointercancel', 'pointermove', 'pointerup']);
    } finally {
      add.mockRestore();
    }
  });
});

describe('the system\'s menu leaves nothing listening', () => {
  // Every listener for the menu event put on the window and not taken off again.
  function listening() {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const same = (a, b) => a[0] === b[0] && a[1] === b[1] && !!(a[2]?.capture ?? a[2]) === !!(b[2]?.capture ?? b[2]);
    return {
      added: () => add.mock.calls.filter((c) => c[0] === 'contextmenu').length,
      left: () => add.mock.calls.filter((c) => c[0] === 'contextmenu' && !remove.mock.calls.some((r) => same(c, r))).length,
      restore: () => (add.mockRestore(), remove.mockRestore()),
    };
  }

  it.each(['plain', 'arc'])('%s: an old edit/menu owns neither the later shift nor any surviving listener', async (id) => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const on = listening();
    const restore = geometry({ native: { left: 100.75, top: 50, width: 0, height: 24 }, mark: { left: 100, top: 50, width: 1.5, height: 24 }, selection: { left: 300, top: 400, width: 40, height: 20 } });
    try {
      const m = await typing(id);
      const old = m.q('.curve-edit, .type-edit');
      old.dispatchEvent(ptr('pointerdown', m, 60, 30, 1, { button: 2 }));
      const oldBack = timers.mock.calls.find((c) => c[1] === 1000)[0];
      expect(on.left()).toBe(1);
      endEdit(m.box.text);
      await tick();
      expect(on.left()).toBe(0);
      expect(old.classList.contains('ctx')).toBe(false);
      beginEdit(m.box.id);
      await tick();
      const later = m.q('.curve-edit, .type-edit');
      later.dispatchEvent(ptr('pointerdown', m, 90, 30, 1, { button: 2 }));
      const moved = m.editable().style.transform;
      expect(moved).not.toBe('');
      expect(on.left()).toBe(1);
      // Even a callback already queued by the browser owns only its old menu.
      oldBack();
      await tick();
      expect(later.classList.contains('ctx')).toBe(true);
      expect(m.editable().style.transform).toBe(moved);
      expect(on.left()).toBe(1);
      window.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      m.view.unmount();
      expect(on.left()).toBe(0);
      expect(later.classList.contains('ctx')).toBe(false);
      vi.runAllTimers();
      expect(on.left()).toBe(0);
    } finally {
      restore();
      on.restore();
      timers.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['plain', 'arc'])('%s: none after the menu event, and none after the second it waits when no menu comes', async (id) => {
    vi.useFakeTimers();
    const on = listening();
    try {
      const m = await typing(id);
      const el = m.q('.curve-edit, .type-edit');
      el.dispatchEvent(ptr('pointerdown', m, 150, 30, 1));
      el.dispatchEvent(ptr('pointerup', m, 150, 30, 1));
      const menu = () => el.dispatchEvent(ptr('pointerdown', m, 60, 30, 1, { button: 2 }));
      // The menu comes.
      menu();
      expect(on.added()).toBe(1);
      expect(on.left()).toBe(1);
      window.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      vi.runAllTimers();
      expect(on.left()).toBe(0);
      // No menu comes: the second passes.
      menu();
      expect(on.added()).toBe(2);
      expect(on.left()).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(on.left()).toBe(0);
      // Two right presses, one after the other, before either is over.
      menu();
      menu();
      expect(on.added()).toBe(4);
      vi.advanceTimersByTime(1000);
      expect(on.left()).toBe(0);
      // And the edit ending while it stands aside.
      menu();
      endEdit(m.editable().textContent);
      await tick();
      vi.advanceTimersByTime(1000);
      expect(on.left()).toBe(0);
      expect(on.added()).toBe(5);
    } finally {
      on.restore();
      vi.useRealTimers();
    }
  });
});

describe('a flat picture drag ends with its mode or composition', () => {
  it.each(['switch', 'composition'])('%s cannot leave a flat drag to resume later', async (way) => {
    const m = await typing('plain');
    const el = m.q('.type-edit');
    const rows = rowsOf(m.box);
    el.dispatchEvent(ptr('pointerdown', m, rows[0].xs[1] + 1, rows[0].top + 5, 1));
    const start = m.sel();
    if (way === 'switch') engineSwitch.painting = false;
    else m.editable().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    await tick();
    if (way === 'switch') engineSwitch.painting = true;
    await tick();
    if (way === 'composition') m.editable().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    el.dispatchEvent(ptr('pointermove', m, rows[0].xs[6] + 1, rows[0].top + 5, 1));
    expect(m.sel()).toEqual(start);
  });
});

describe('a box narrower than one grapheme, typed into as its picture', () => {
  // A syllable written in three jamo, in a box narrower than one of them:
  // three rows, and one grapheme. The plain wrapper is the engine's own here
  // (jsdom lays nothing out): it breaks wherever the width is used up, in the
  // middle of anything, as the real one does (type-rows.engine.test.js).
  const SYLLABLE = '\u1100\u1161\u11A8';
  async function jamo() {
    setTextEngine({
      ...half,
      wrapPlain: (face, text, { width }) => {
        const n = Math.max(1, Math.floor(width / (face.size * 0.5)));
        const out = [];
        for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
        return out.length ? out : [''];
      },
    });
    clearLayoutMemo();
    KINDS.jamo = box('jamo', { shape: 'off' }, { text: SYLLABLE, w: 12, h: 120 });
    try {
      return await typing('jamo');
    } finally {
      delete KINDS.jamo;
    }
  }

  it('its rows break inside the grapheme, and the caret, the selection and the pointer do not', async () => {
    const m = await jamo();
    const rows = rowsOf(m.box);
    expect(rows.map((r) => r.offs)).toEqual([[0], [], [3]]);
    // All of it is selected on the first focus: a rectangle on each row.
    expect(m.sel()).toEqual([0, 3]);
    const sel = m.all('.tsel').map(px);
    expect(sel).toHaveLength(3);
    expect(sel.map((r) => r.top)).toEqual(rows.map((r) => r.top));
    expect(sel.every((r) => r.width === 10)).toBe(true);
    // A press on any row is before it or after it; the caret is drawn on the
    // row that has that stop, never on the row between.
    const el = m.q('.type-edit');
    for (const [i, x, want, row] of [[0, 1, 0, 0], [0, 9, 3, 2], [1, 2, 0, 0], [1, 8, 3, 2], [2, 2, 0, 0], [2, 9, 3, 2]]) {
      el.dispatchEvent(ptr('pointerdown', m, rows[i].lead?.x ?? rows[i].xs[0], rows[i].top + 5, 1));
      el.dispatchEvent(ptr('pointerup', m, 0, 0, 1));
      el.dispatchEvent(ptr('pointerdown', m, (rows[i].lead?.x ?? rows[i].xs[0]) + x, rows[i].top + 5, 1));
      el.dispatchEvent(ptr('pointerup', m, 0, 0, 1));
      await tick();
      expect(m.sel(), `row ${i}, ${x} px in`).toEqual([want, want]);
      expect(px(m.q('.tcaret')).top, `row ${i}, ${x} px in`).toBe(rows[row].top);
    }
    // Down from its start is its end; a letter typed there leaves it whole.
    nativeSel(m, 0);
    await tick();
    key(m, 'ArrowDown');
    expect(m.sel()).toEqual([3, 3]);
    key(m, 'ArrowLeft');
    expect(m.sel()).toEqual([0, 0]);
    key(m, 'ArrowRight');
    expect(m.sel()).toEqual([3, 3]);
    input(m, 'insertText', 'X');
    await tick();
    expect(m.box.text).toBe('각X');
  });

  it('what takes the pointer past the frame reaches as far as the parts of it the rows draw', async () => {
    const m = await jamo();
    const rows = rowsOf(m.box);
    // Each row draws a letter 10 wide from the inset, in a box 12 wide; the
    // middle row has no stop at all, and the last has its one at its far end.
    const far = Math.max(...rows.map((r) => r.trail?.x ?? r.xs[r.xs.length - 1]));
    const near = Math.min(...rows.map((r) => r.lead?.x ?? r.xs[0]));
    expect(far - near).toBe(10);
    expect(far).toBeGreaterThan(m.box.w);
    const pad = px(m.q('.tpad'));
    expect(pad.left).toBe(Math.min(0, near));
    expect(pad.left + pad.width).toBe(far);
    expect(Number.isFinite(pad.width) && Number.isFinite(pad.height)).toBe(true);
  });
});
