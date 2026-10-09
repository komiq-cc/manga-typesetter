import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, selectBox, setFontSource, setZoom, fitHeld } from './store.svelte.js';
import { initHistory, resetHistory } from './editor/history.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo, textInset } from './measure.js';
import { neededHeight } from './typeset.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

// ===========================================================================
// A drag of a box's bottom edge, through the component
// ===========================================================================
// The floor of the drag is the store's (`edgeDragFloor`, edge-drag-floor
// .test.js); this is the handle asking it. With a face arriving, the lines on
// screen are a stand-in's and the drag must not be floored at their count.

const BOX = () => ({
  id: 'b', lineN: null, text: 'WAIT FOR ME\nOVER THERE\nBY THE DOOR', x: 100, y: 200, w: 240, h: 300,
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
  setFontSource(null);
  app.selectedId = null;
  setZoom(1);
  loadProjectPages([]);
  resetHistory();
});

async function dragBottomEdgeUp(by) {
  loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: [BOX()] }]);
  const pg = page();
  const b = pg.boxes[0];
  const view = render(TextBox, { box: b, pageFrameEl: document.createElement('div'), pg });
  selectBox('b');
  await tick();
  const handle = view.container.querySelector('.handle.side.s');
  const lines = view.container.querySelectorAll('.tlayer.base .tline').length;
  const ev = (type, y) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: y });
  handle.dispatchEvent(ev('pointerdown', 500));
  document.dispatchEvent(ev('pointermove', 500 - by));
  await tick();
  document.dispatchEvent(ev('pointerup', 500 - by));
  await tick();
  return { b, lines };
}

describe('the bottom edge, dragged far up', () => {
  it('stops at what the text needs: auto height keeps its promise', async () => {
    const { b, lines } = await dragBottomEdgeUp(1000);
    expect(lines).toBe(3);
    expect(b.h).toBe(neededHeight(3, b.style, textInset(b.style)));
    expect(fitHeld(b)).toBe(false);
  });

  it('with the box\'s face still arriving it stops at the plain minimum, not at the stand-in\'s line count, and the fit is held', async () => {
    setFontSource({ ready: () => false });
    const { b } = await dragBottomEdgeUp(1000);
    expect(b.h).toBe(30);
    expect(fitHeld(b)).toBe(true);
  });

  it('with the face in, the engine on changes nothing', async () => {
    setFontSource({ ready: () => true });
    const { b } = await dragBottomEdgeUp(1000);
    expect(b.h).toBe(neededHeight(3, b.style, textInset(b.style)));
    expect(fitHeld(b)).toBe(false);
  });
});
