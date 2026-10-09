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
import { paintBoxPicture } from './editor/box-picture.js';
import { _setDisplayScale } from './editor/display-scale.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { typeModel } from './type-rows.js';
import { rawOffset } from './edit-lines.js';
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

  it('the second press of a double-click selects the word the caret went to, and ends the drag', async () => {
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
    // And the drag the first press began is over.
    m.q('.type-edit').dispatchEvent(new MouseEvent('pointermove', at(m, rows[0].xs[0], rows[0].top + 5)));
    expect(m.sel()).toEqual([5, 8]);
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
  });

  it('a key with Alt or Control, and a key while an IME composes, is left to the browser', async () => {
    const m = await typing('plain');
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
    // And a target a glyph for the pointer: an arc leaves its frame.
    const pads = m.all('.curve-edit .tpad');
    expect(pads).toHaveLength(glyphs.length);
    expect(parseFloat(pads[0].style.width)).toBeCloseTo(glyphs[0].w * 2, 6);
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
