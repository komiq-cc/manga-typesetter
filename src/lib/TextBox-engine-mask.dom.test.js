import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, beginEdit, endEdit, setZoom } from './store.svelte.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { _setDisplayScale } from './editor/display-scale.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

// ===========================================================================
// A masked box handed over from the engine's picture to the editable
// ===========================================================================
// At rest the mask is in the picture's pixels. Typed into, the box is DOM text
// under a CSS mask image, and that image is encoded by `toBlob`, which answers
// a task later. So the image has to be standing BEFORE the edit starts: built
// when the edit starts, the editable is on screen unmasked until the encode
// lands. The canvas here has a `toBlob` that behaves like a browser's
// (src/test/fake-canvas.js, `asyncBlob`); without one the component encodes
// on the spot and the gap cannot be seen.

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, ...over });
const MASKED = {
  id: 'masked', lineN: null, text: 'WAIT FOR ME\nOVER THERE', x: 100, y: 200, w: 240, h: 90,
  style: style({ clip: { on: true, mode: 'exclude', brushSize: 20, shapes: [{ kind: 'ellipse', cx: 120, cy: 45, rx: 80, ry: 30 }] } }),
};
const task = () => new Promise((resolve) => setTimeout(resolve, 0));
// The wrapper's style, as jsdom writes it back.
const MASKED_BY = /mask-image: url\("(blob:fake\/\d+)"\)/;

const typeset = typesetEnabled();
let restoreCanvas;
let revoked;
beforeAll(() => {
  restoreCanvas = installFakeCanvas({ asyncBlob: true });
  setTypesetEnabled(true);
  clearLayoutMemo();
});
afterAll(() => {
  restoreCanvas();
  setTypesetEnabled(typeset);
  clearLayoutMemo();
});
beforeEach(() => {
  engineSwitch.painting = true;
  _setDisplayScale(1);
  revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  revoked.mockRestore();
  engineSwitch.painting = false;
  app.selectedId = null;
  app.editingId = null;
  setZoom(1);
  loadProjectPages([]);
});

async function mounted() {
  loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [structuredClone(MASKED)] }]);
  const pg = page();
  const view = render(TextBox, { box: pg.boxes[0], pageFrameEl: document.createElement('div'), pg });
  await tick();
  const root = view.container.querySelector('.tbox');
  return { view, root, box: pg.boxes[0], wrap: () => root.querySelector('.clipwrap').getAttribute('style') };
}

describe('a masked box, from the picture to the editable', () => {
  it('this canvas encodes a task later: with the switch off the mask is not there on the first frame, and is after one', async () => {
    engineSwitch.painting = false;
    const m = await mounted();
    expect(m.wrap()).not.toContain('mask-image');
    await task();
    await tick();
    expect(m.wrap()).toMatch(MASKED_BY);
  });

  it('at rest the mask is in the pixels and is not applied to the picture a second time', async () => {
    const m = await mounted();
    await task();
    await tick();
    expect(m.root.querySelector('canvas').dataset.painter).toBe('engine');
    expect(m.wrap()).not.toContain('mask');
  });

  it('the editable is masked on the frame the edit starts: the image was standing, nothing waits for an encode', async () => {
    const m = await mounted();
    await task();
    await tick();
    beginEdit('masked');
    await tick();
    // No task has run since the edit began.
    expect(m.root.querySelector('.txt.editable')).not.toBe(null);
    expect(m.root.querySelector('canvas')).toBe(null);
    expect(m.wrap()).toMatch(MASKED_BY);
    expect(m.wrap()).toContain('mask-size:');
  });

  it('and the same image serves the edit and the next one: nothing is built or handed back at the hand-over', async () => {
    const m = await mounted();
    await task();
    await tick();
    const urlOf = () => MASKED_BY.exec(m.wrap())?.[1];
    beginEdit('masked');
    await tick();
    const first = urlOf();
    expect(first).toMatch(/^blob:fake\//);
    endEdit(m.box.text);
    await tick();
    await task();
    beginEdit('masked');
    await tick();
    expect(urlOf()).toBe(first);
    expect(revoked).not.toHaveBeenCalled();
  });

  it('a mask changed while the box is at rest is the one the editable gets', async () => {
    const m = await mounted();
    await task();
    await tick();
    beginEdit('masked');
    await tick();
    const before = MASKED_BY.exec(m.wrap())[1];
    endEdit(m.box.text);
    await tick();
    m.box.style.clip.shapes = [...m.box.style.clip.shapes, { kind: 'ellipse', cx: 10, cy: 10, rx: 5, ry: 5 }];
    await tick();
    await task();
    await tick();
    beginEdit('masked');
    await tick();
    const after = MASKED_BY.exec(m.wrap())[1];
    expect(after).not.toBe(before);
    expect(revoked).toHaveBeenCalledWith(before);
  });

  it('the image goes back when the box does', async () => {
    const m = await mounted();
    await task();
    await tick();
    beginEdit('masked');
    await tick();
    const url = MASKED_BY.exec(m.wrap())[1];
    m.view.unmount();
    expect(revoked).toHaveBeenCalledWith(url);
  });
});
