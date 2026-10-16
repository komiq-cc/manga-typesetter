import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, selectBox, beginEdit, deselect, setZoom } from './store.svelte.js';
import { initHistory, resetHistory, history, undo } from './editor/history.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

// ===========================================================================
// The ends of a box's own gestures that are not a pointer coming up
// ===========================================================================
// A rotate or resize handle can lose its pointer without a pointerup ever
// arriving: the handle is taken away under the drag (Escape deselects), its
// capture is lost, the window loses the focus. Each of those ends the gesture
// and commits it; nothing after it moves the box on hover.
//
// And an IME's composition owns its keys, Escape included.

const BOX = () => ({
  id: 'b', lineN: null, text: 'WAIT FOR ME', x: 100, y: 200, w: 240, h: 90,
  style: normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30 }),
});
const typeset = typesetEnabled();
let restoreCanvas;
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  setTypesetEnabled(true);
  clearLayoutMemo();
  initHistory();
});
afterAll(() => {
  restoreCanvas();
  setTypesetEnabled(typeset);
  clearLayoutMemo();
});
afterEach(() => {
  cleanup();
  app.selectedId = null;
  app.editingId = null;
  setZoom(1);
  loadProjectPages([]);
  resetHistory();
});

async function mounted() {
  loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [BOX()] }]);
  const pg = page();
  const b = pg.boxes[0];
  const view = render(TextBox, { box: b, pageFrameEl: document.createElement('div'), pg });
  selectBox('b');
  await tick();
  return { b, view };
}
// The box's centre is (220, 245) on a page frame at the origin: straight
// right of it is 90 degrees, straight below it is 180.
const ev = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
async function startRotating(view) {
  const handle = view.container.querySelector('.handle.rot');
  handle.dispatchEvent(ev('pointerdown', 220, 100));
  document.dispatchEvent(ev('pointermove', 400, 245));
  await tick();
  return handle;
}

describe('a rotation whose pointer is lost', () => {
  it('ends, committed, when Escape takes the handles away, and a later hover turns nothing', async () => {
    const { b, view } = await mounted();
    await startRotating(view);
    expect(b.style.rotation).toBe(90);
    deselect();
    await tick();
    expect(view.container.querySelector('.handle.rot')).toBe(null);
    expect(history.canUndo, 'the turn is one undo step').toBe(true);
    // The pointer comes back over the page with no button down.
    document.dispatchEvent(ev('pointermove', 220, 500));
    await tick();
    expect(b.style.rotation).toBe(90);
    undo();
    expect(b.style.rotation).toBe(0);
  });

  it('ends when the handle loses the capture', async () => {
    const { b, view } = await mounted();
    const handle = await startRotating(view);
    handle.dispatchEvent(ev('lostpointercapture', 400, 245));
    document.dispatchEvent(ev('pointermove', 220, 500));
    await tick();
    expect(b.style.rotation).toBe(90);
    expect(history.canUndo).toBe(true);
  });

  it('ends when the window loses the focus', async () => {
    const { b, view } = await mounted();
    await startRotating(view);
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(ev('pointermove', 220, 500));
    await tick();
    expect(b.style.rotation).toBe(90);
    expect(history.canUndo).toBe(true);
  });

  it('a capture lost by some other element leaves the drag going', async () => {
    const { b, view } = await mounted();
    await startRotating(view);
    view.container.querySelector('.tbox').dispatchEvent(ev('lostpointercapture', 0, 0));
    document.dispatchEvent(ev('pointermove', 220, 500));
    await tick();
    expect(b.style.rotation).toBe(180);
    document.dispatchEvent(ev('pointerup', 220, 500));
    expect(history.canUndo).toBe(true);
  });
});

describe('Escape while an IME composes', () => {
  const key = (el, init) => {
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
  };
  async function editing() {
    const { view } = await mounted();
    beginEdit('b');
    await tick();
    const ed = view.container.querySelector('[contenteditable="true"]');
    expect(ed).not.toBe(null);
    return { ed, blur: vi.spyOn(ed, 'blur') };
  }

  it('is the composition\'s, and the edit stays open', async () => {
    const { ed, blur } = await editing();
    ed.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(key(ed, { isComposing: true }).defaultPrevented).toBe(false);
    expect(key(ed, {}).defaultPrevented, 'between the composition\'s start and end').toBe(false);
    expect(blur).not.toHaveBeenCalled();
    expect(app.editingId).toBe('b');
  });

  it('marked by WebKit as keyCode 229 is the IME\'s too', async () => {
    const { ed, blur } = await editing();
    expect(key(ed, { keyCode: 229 }).defaultPrevented).toBe(false);
    expect(blur).not.toHaveBeenCalled();
  });

  it('with nothing composing still ends the edit', async () => {
    const { ed, blur } = await editing();
    expect(key(ed, {}).defaultPrevented).toBe(true);
    expect(blur).toHaveBeenCalled();
  });
});
