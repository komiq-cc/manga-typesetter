import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, selectBox, beginEdit, setZoom } from './store.svelte.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { glyphPainter } from './text-engine/index.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';
import { domOutline } from '../test/dom-outline.js';

// ===========================================================================
// A box in the editor with the textEngine switch OFF, which is the default
// ===========================================================================
// The hard constraint of showing a box as the engine's picture is that a
// session which never turns the switch on sees none of it: the same elements,
// the same inline CSS. So the structure of each kind of box is written down
// here as a snapshot - taken on the commit BEFORE TextBox.svelte knew there
// was a switch (see this file's own history: it and its snapshot were
// committed first, against the component as it was) - and has to stay what it
// was. `domOutline` is every element, class, attribute and inline style.

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, ...over });
const box = (id, over = {}, geom = {}) => ({ id, lineN: null, text: 'WAIT FOR ME\nOVER THERE', x: 100, y: 200, w: 240, h: 90, ...geom, style: style(over) });

const KINDS = {
  straight: box('straight'),
  'straight, every finish': box('finish', {
    strokes: [{ color: '#ffffff', width: 3, opacity: 1 }, { color: '#000000', width: 2, opacity: 0.5 }],
    shadows: [{ x: 3, y: 4, blur: 5, color: '#112233', opacity: 0.6 }],
    gradient: { on: true, kind: 'linear', angle: 90, scope: 'line', stops: [{ color: '#ff0000', pos: 0, opacity: 1 }, { color: '#0000ff', pos: 1, opacity: 1 }] },
    blur: 2,
    motionBlur: { on: true, x: 2, y: 0, amount: 4 },
    roughen: { on: true, amount: 4, detail: 0.05, seed: 7 },
    rotation: 7,
    opacity: 0.5,
    flipH: true,
    align: 'left',
    valign: 'top',
  }),
  pattern: box('pattern', { pattern: { on: true, kind: 'dots', fg: '#000000', bg: '#ffffff', scale: 1 } }),
  masked: box('masked', { clip: { on: true, mode: 'include', brushSize: 20, shapes: [{ kind: 'ellipse', cx: 120, cy: 45, rx: 80, ry: 30 }] } }),
  arc: box('arc', { curve: 40 }),
  circle: box('circle', { circle: { on: true, angle: 0, inside: false, r: 0 } }),
  path: box('path', { path: { on: true, pts: [{ x: 10, y: 60, ix: -30, iy: 0, ox: 30, oy: -20 }, { x: 230, y: 40, ix: -30, iy: 20, ox: 30, oy: 0 }] } }),
  warped: box('warped', { warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [250, 12], [-6, 96], [240, 90]] } }),
  inked: box('inked', {
    ink: { on: true, strokes: [{ size: 8, color: '#000000', opacity: 1, pts: [[20, 20, 1], [80, 40, 1], [160, 30, 1]] }] },
  }),
};

// jsdom lays nothing out, so the plain breaker (which reads the browser's own
// line boxes) has nothing to read: the shaped breaker is the one that runs
// here, on the stand-in metric every lane without a canvas measures with.
const typeset = typesetEnabled();
let restoreCanvas;
beforeAll(() => {
  restoreCanvas = installFakeCanvas();
  setTypesetEnabled(true);
  clearLayoutMemo();
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
});

async function mounted(id, { zoom = 1 } = {}) {
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: Object.values(KINDS).map((b) => structuredClone(b)) }]);
  setZoom(zoom);
  const pg = page();
  const frame = document.createElement('div');
  const view = render(TextBox, { box: pg.boxes.find((b) => b.id === id), pageFrameEl: frame, pg });
  await tick();
  return view;
}

describe('with the switch off, a box is the DOM it always was', () => {
  it('the switch is off, and the browser painter is the one installed', () => {
    expect(engineSwitch).toMatchObject({ mode: 'browser', phase: 'off' });
    expect(glyphPainter().id).toBeUndefined();
  });

  for (const [name, b] of Object.entries(KINDS)) {
    it(`${name}: at rest`, async () => {
      const view = await mounted(b.id);
      expect(domOutline(view.container)).toMatchSnapshot();
    });
  }

  it('straight: at 250%', async () => {
    const view = await mounted('finish', { zoom: 2.5 });
    expect(domOutline(view.container)).toMatchSnapshot();
  });

  it('straight: selected', async () => {
    const view = await mounted('straight');
    selectBox('straight');
    await tick();
    expect(domOutline(view.container)).toMatchSnapshot();
  });

  it('straight: being typed into', async () => {
    const view = await mounted('finish');
    beginEdit('finish');
    await tick();
    expect(domOutline(view.container)).toMatchSnapshot();
  });

  it('arc: being typed into, on its curve', async () => {
    const view = await mounted('arc');
    beginEdit('arc');
    await tick();
    expect(domOutline(view.container)).toMatchSnapshot();
  });

  // What the outline is of, said directly, so a reader of the snapshot does
  // not have to trust it: the layer stack, the glyph spans, the one canvas a
  // warped box always was.
  it('straight text is the layer stack and no canvas', async () => {
    const view = await mounted('finish');
    const root = view.container.querySelector('.tbox');
    expect(root.querySelectorAll('canvas')).toHaveLength(0);
    // One shadow, two bands, the fill.
    expect(root.querySelectorAll('.txt.shaped.stack > .tlayer')).toHaveLength(4);
    expect(root.querySelectorAll('.tlayer.base > .tline')).toHaveLength(2);
    expect(root.querySelectorAll('svg.rough-def filter')).toHaveLength(2);
  });

  it('curved text is glyph spans and no canvas', async () => {
    for (const id of ['arc', 'circle', 'path']) {
      const view = await mounted(id);
      const root = view.container.querySelector('.tbox');
      expect(root.querySelectorAll('canvas'), id).toHaveLength(0);
      expect(root.querySelectorAll('.arcstack > .arc').length, id).toBe(2);
      expect(root.querySelectorAll('.arcstack > .arc:last-child > .arc-ch').length, id).toBe([...'WAIT FOR ME\nOVER THERE'].length);
      cleanup();
    }
  });

  it('a warped box is its one canvas, painted the old way: at the zoom, not the display scale', async () => {
    const view = await mounted('warped', { zoom: 1.5 });
    const root = view.container.querySelector('.tbox');
    const canvases = root.querySelectorAll('canvas');
    expect(canvases).toHaveLength(1);
    expect(canvases[0].className.replace(/\s*svelte-\S+/g, '')).toBe('warpl');
    expect(root.querySelector('.txt')).toBe(null);
    // `blitWarped`: the footprint times the zoom, rounded, which the CSS box
    // (footprint x zoom) then shows one to one.
    const css = canvases[0].style;
    expect(canvases[0].width).toBe(Math.round(parseFloat(css.width)));
    expect(canvases[0].height).toBe(Math.round(parseFloat(css.height)));
  });

  it('an inked box keeps its text as DOM and its ink on the ink canvas', async () => {
    const view = await mounted('inked');
    const root = view.container.querySelector('.tbox');
    expect([...root.querySelectorAll('canvas')].map((c) => c.className.replace(/\s*svelte-\S+/g, ''))).toEqual(['inkl']);
    expect(root.querySelectorAll('.txt.shaped.stack > .tlayer').length).toBeGreaterThan(0);
  });
});
