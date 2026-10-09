import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

// The two paints are the real ones, on the lane's stand-in canvas, wrapped so
// a case can count them; and the roughening's phase, which a browser measures
// once per session, is a promise the case holds.
const real = vi.hoisted(() => ({}));
vi.mock('./editor/box-picture.js', async (original) => {
  const mod = await original();
  real.paintBoxPicture = mod.paintBoxPicture;
  return { ...mod, paintBoxPicture: vi.fn(mod.paintBoxPicture), paintPictureTexture: vi.fn(mod.paintPictureTexture) };
});
vi.mock('./exporter.js', async (original) => {
  const real = await original();
  return { ...real, paintWarpedBox: vi.fn(real.paintWarpedBox) };
});
const noise = { gate: null };
vi.mock('./text-paint.js', async (original) => {
  const real = await original();
  return { ...real, ensureNoisePhase: () => noise.gate ?? Promise.resolve() };
});

import TextBox from './TextBox.svelte';
import { app, loadProjectPages, page, selectBox, beginEdit, endEdit, setZoom, setZoomLive, moveBoxTo, moveGeom, noteFontsChanged } from './store.svelte.js';
import { engineSwitch } from './engine-switch.svelte.js';
import { paintBoxPicture, PICTURE_DRAG_PX, PICTURE_MAX_PX, TURNED_OVERSAMPLE } from './editor/box-picture.js';
import { paintWarpedBox, renderBoxTexture } from './exporter.js';
import { _setDisplayScale } from './editor/display-scale.svelte.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { installFakeCanvas } from '../test/fake-canvas.js';

// ===========================================================================
// A box in the editor while the Rust engine draws: one canvas, the exporter's
// ===========================================================================
// The component is mounted for real. What stands in: the canvas (jsdom has
// none; src/test/fake-canvas.js keeps sizes and draws nothing), and the flag
// that says the engine is drawing, which engine-switch-painter.test.js shows
// is true exactly when the engine and its painter are installed - here it is
// simply set. So these cases are about the component: when it is a canvas,
// how large, what repaints it and what does not, and when its pixels go back.

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, ...over });
const box = (id, over = {}, geom = {}) => ({ id, lineN: null, text: 'WAIT FOR ME\nOVER THERE', x: 100, y: 200, w: 240, h: 90, ...geom, style: style(over) });

const KINDS = {
  straight: box('straight'),
  finish: box('finish', {
    strokes: [{ color: '#ffffff', width: 3, opacity: 1 }, { color: '#000000', width: 2, opacity: 0.5 }],
    shadows: [{ x: 3, y: 4, blur: 5, color: '#112233', opacity: 0.6 }],
    gradient: { on: true, kind: 'linear', angle: 90, scope: 'line', stops: [{ color: '#ff0000', pos: 0, opacity: 1 }, { color: '#0000ff', pos: 1, opacity: 1 }] },
    blur: 2,
    motionBlur: { on: true, x: 2, y: 0, amount: 4 },
    rotation: 7,
    opacity: 0.5,
    flipH: true,
  }),
  rough: box('rough', { roughen: { on: true, amount: 4, detail: 0.05, seed: 7 } }),
  masked: box('masked', { clip: { on: true, mode: 'include', brushSize: 20, shapes: [{ kind: 'ellipse', cx: 120, cy: 45, rx: 80, ry: 30 }] } }),
  arc: box('arc', { curve: 40 }),
  path: box('path', { path: { on: true, pts: [{ x: 10, y: 60, ix: -30, iy: 0, ox: 30, oy: -20 }, { x: 230, y: 40, ix: -30, iy: 20, ox: 30, oy: 0 }] } }),
  warped: box('warped', { warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [250, 12], [-6, 96], [240, 90]] } }),
  inked: box('inked', { ink: { on: true, strokes: [{ size: 8, color: '#000000', opacity: 1, pts: [[20, 20, 1], [80, 40, 1], [160, 30, 1]] }] } }),
  huge: box('huge', {}, { x: 0, y: 0, w: 1600, h: 2300 }),
};

// An IntersectionObserver a case drives by hand.
const observed = new Map();
class FakeObserver {
  constructor(cb, options) {
    this.cb = cb;
    FakeObserver.options = options;
  }
  observe(el) {
    observed.set(el, this);
  }
  unobserve(el) {
    observed.delete(el);
  }
}
const say = (el, near) => observed.get(el)?.cb([{ target: el, isIntersecting: near }]);

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
beforeEach(() => {
  engineSwitch.painting = true;
  _setDisplayScale(1);
  noise.gate = null;
  paintBoxPicture.mockClear();
  paintWarpedBox.mockClear();
});
afterEach(() => {
  cleanup();
  engineSwitch.painting = false;
  app.selectedId = null;
  app.editingId = null;
  setZoomLive(false);
  setZoom(1);
  loadProjectPages([]);
  observed.clear();
  vi.unstubAllGlobals();
});

async function mounted(id, { zoom = 1, props = {} } = {}) {
  loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: Object.values(KINDS).map((b) => structuredClone(b)) }]);
  setZoom(zoom);
  const pg = page();
  const b = pg.boxes.find((x) => x.id === id);
  const view = render(TextBox, { box: b, pageFrameEl: document.createElement('div'), pg, ...props });
  await tick();
  const root = view.container.querySelector('.tbox');
  return { view, root, box: b, pg, canvas: () => root.querySelector('canvas'), reach: () => root.querySelector('.reach'), paints: () => paintBoxPicture.mock.calls.length };
}
// A turned box is painted at twice the display's scale (TURNED_OVERSAMPLE).
const turned = (b) => ((b.style.rotation || 0) % 90 ? TURNED_OVERSAMPLE : 1);
// What the exporter says the box's footprint is, in page px.
const footprint = (b, pg) => {
  const r = renderBoxTexture(b, pg, null, 1);
  return { cw: r.canvas.width, ch: r.canvas.height, ox: r.ox, oy: r.oy };
};
const css = (el) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), width: parseFloat(el.style.width), height: parseFloat(el.style.height) });

describe('what a box is, with the engine drawing', () => {
  for (const id of ['straight', 'finish', 'rough', 'masked', 'arc', 'path', 'warped', 'inked']) {
    it(`${id}: one canvas, painted through the exporter, and none of the DOM text`, async () => {
      const m = await mounted(id);
      const canvases = m.root.querySelectorAll('canvas');
      expect(canvases).toHaveLength(1);
      expect(canvases[0].classList.contains('warpl')).toBe(true);
      expect(canvases[0].dataset.painter).toBe('engine');
      expect(canvases[0].width * canvases[0].height).toBeGreaterThan(0);
      // Once - and once more for a roughened box, when the phase of the
      // browser's turbulence has been measured (see "a paint that lands late").
      expect(m.paints()).toBe(id === 'rough' ? 2 : 1);
      // Never the old stretch-from-2 path, a warped box included.
      expect(paintWarpedBox).not.toHaveBeenCalled();
      // No layer stack, no glyph spans, no editable, no ink layer, no filters.
      expect(m.root.querySelector('.txt, .arcstack, .tlayer, .arc-ch, .inkl, svg.rough-def')).toBe(null);
      // The mask is in the pixels, so no mask image is built or applied.
      expect(m.root.querySelector('.clipwrap').getAttribute('style')).not.toContain('mask');
    });
  }

  it('keeps the frame, the turn, the opacity and the flip as CSS: none of them is in the pixels', async () => {
    const m = await mounted('finish');
    expect(m.root.style.transform).toBe('rotate(7deg)');
    expect(m.root.style.opacity).toBe('0.5');
    expect(m.root.style.width).toBe('240px');
    expect(m.root.style.height).toBe('90px');
    expect(m.root.querySelector('.clipwrap').style.transform).toContain('scale(-1');
    // And the canvas is inside the wrapper that carries the flip.
    expect(m.canvas().parentElement.classList.contains('clipwrap')).toBe(true);
  });

  it('keeps the handles, the outline classes and the source pill as DOM', async () => {
    const m = await mounted('straight');
    selectBox('straight');
    await tick();
    expect(m.root.classList.contains('selected')).toBe(true);
    expect(m.root.querySelectorAll('.handle')).toHaveLength(9);
    expect(m.root.querySelector('.rotate-stem')).not.toBe(null);
    // Selecting painted nothing.
    expect(m.paints()).toBe(1);
  });

  it('is the DOM again the moment the flag goes false, and the canvas has handed its pixels back', async () => {
    const m = await mounted('finish');
    const el = m.canvas();
    expect(el.width).toBeGreaterThan(0);
    engineSwitch.painting = false;
    await tick();
    expect(m.root.querySelector('canvas')).toBe(null);
    expect([el.width, el.height]).toEqual([0, 0]);
    expect(m.root.querySelectorAll('.txt.shaped.stack > .tlayer')).toHaveLength(4);
    expect(m.root.querySelectorAll('svg.rough-def')).toHaveLength(1);
  });

  it('a warped box goes back to the old paint when the flag goes false: same canvas, the zoom, no display scale', async () => {
    _setDisplayScale(2);
    const m = await mounted('warped', { zoom: 1.5 });
    const el = m.canvas();
    const at2 = el.width;
    engineSwitch.painting = false;
    await tick();
    expect(m.canvas()).toBe(el);
    expect(el.dataset.painter).toBeUndefined();
    expect(paintWarpedBox).toHaveBeenCalledTimes(1);
    expect(el.width).toBe(Math.round(parseFloat(el.style.width)));
    expect(at2).toBeGreaterThan(el.width * 1.9);
  });
});

describe('the scale the picture is painted at', () => {
  it('a box turned off the axes is painted at twice the scale, and shown at the same size', async () => {
    _setDisplayScale(2);
    const m = await mounted('straight', { zoom: 1.5 });
    const f = footprint(m.box, m.pg);
    const el = m.canvas();
    const upright = css(el);
    expect(el.width).toBe(Math.ceil(f.cw * 3));
    // The first degree repaints, once: the picture has to be made finer.
    m.box.style.rotation = 7;
    await tick();
    expect(m.paints()).toBe(2);
    expect(paintBoxPicture.mock.calls[1][3]).toBeCloseTo(3 * TURNED_OVERSAMPLE, 9);
    expect(el.width).toBe(Math.ceil(f.cw * 3 * TURNED_OVERSAMPLE));
    expect(css(el).width).toBeCloseTo(upright.width, 6);
    expect(css(el).height).toBeCloseTo(upright.height, 6);
    // The rest of the turn is CSS's.
    for (const deg of [8, 21, -40, 179]) {
      m.box.style.rotation = deg;
      await tick();
    }
    expect(m.paints()).toBe(2);
    // A quarter turn lands texel on pixel and needs no more than the screen has.
    m.box.style.rotation = 90;
    await tick();
    expect(m.paints()).toBe(3);
    expect(el.width).toBe(Math.ceil(f.cw * 3));
    m.box.style.rotation = 270;
    await tick();
    expect(m.paints()).toBe(3);
  });

  for (const [zoom, dpr] of [[1, 1], [1, 2], [0.5, 2], [3, 1], [3, 2], [0.37, 2]]) {
    it(`zoom ${zoom} on a ${dpr}x display: one texture pixel per device pixel`, async () => {
      _setDisplayScale(dpr);
      const m = await mounted('straight', { zoom });
      const f = footprint(m.box, m.pg);
      const el = m.canvas();
      expect(el.width).toBe(Math.ceil(f.cw * zoom * dpr));
      expect(el.height).toBe(Math.ceil(f.ch * zoom * dpr));
      // The CSS box is the canvas over the pixel ratio: nothing is stretched.
      const c = css(el);
      expect(c.width * dpr).toBeCloseTo(el.width, 6);
      expect(c.height * dpr).toBeCloseTo(el.height, 6);
      expect(paintBoxPicture.mock.calls[0][3]).toBeCloseTo(zoom * dpr, 9);
    });
  }

  it('sits where the footprint says, on a whole device pixel', async () => {
    _setDisplayScale(2);
    const m = await mounted('straight', { zoom: 1.37 });
    const f = footprint(m.box, m.pg);
    const c = css(m.canvas());
    // Within half a device pixel of the footprint's corner...
    expect(Math.abs(c.left - -f.ox * 1.37)).toBeLessThanOrEqual(0.25 + 1e-9);
    expect(Math.abs(c.top - -f.oy * 1.37)).toBeLessThanOrEqual(0.25 + 1e-9);
    // ...and, with the box's own offset, on the device grid.
    const dev = (m.box.x * 1.37 + c.left) * 2;
    expect(Math.abs(dev - Math.round(dev))).toBeLessThan(1e-6);
  });

  it('is not snapped for a turned or mirrored box, whose corner is the footprint exactly', async () => {
    _setDisplayScale(2);
    const m = await mounted('finish', { zoom: 1.37 });
    const f = footprint(m.box, m.pg);
    const c = css(m.canvas());
    expect(c.left).toBeCloseTo(-f.ox * 1.37, 9);
    expect(c.top).toBeCloseTo(-f.oy * 1.37, 9);
  });

  it('caps one box at the pixel budget by lowering its scale, and still shows it at its size', async () => {
    _setDisplayScale(2);
    const m = await mounted('huge', { zoom: 2 });
    const f = footprint(m.box, m.pg);
    const el = m.canvas();
    // Uncapped this box would be 1600 x 2300 x 16: 59 MP.
    expect(f.cw * f.ch * 16).toBeGreaterThan(PICTURE_MAX_PX * 5);
    expect(el.width * el.height).toBeLessThanOrEqual(PICTURE_MAX_PX + el.width + el.height);
    expect(el.width * el.height).toBeGreaterThan(PICTURE_MAX_PX * 0.95);
    const c = css(el);
    expect(c.width).toBeCloseTo(f.cw * 2, 0);
    expect(c.height).toBeCloseTo(f.ch * 2, 0);
  });

  it('does not lower the scale of a small box beside it', async () => {
    _setDisplayScale(2);
    const m = await mounted('straight', { zoom: 2 });
    const f = footprint(m.box, m.pg);
    expect(m.canvas().width).toBe(f.cw * 4);
  });

  it('repaints when the window moves to a display of another density', async () => {
    const m = await mounted('straight');
    const w1 = m.canvas().width;
    _setDisplayScale(2);
    await tick();
    expect(m.paints()).toBe(2);
    expect(m.canvas().width).toBe(w1 * 2);
  });
});

describe('while a handle is resizing the box', () => {
  // A resize repaints the picture every frame of the drag, and a frame of a
  // page-sized box at the display's scale is many megapixels. So the drag
  // paints it within a smaller budget, and the full picture comes back once,
  // when the handle is let go.
  const ev = (type, x) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 300 });
  const scaleOf = (call) => call[3];
  async function grabbed(id, opts) {
    const m = await mounted(id, opts);
    selectBox(id);
    await tick();
    m.root.querySelector('.handle.side.e').dispatchEvent(ev('pointerdown', 500));
    await tick();
    return m;
  }

  it('a box over the drag\'s budget is painted within it on every move, and shown at its size', async () => {
    // 1600 x 2300 page px at 100%: 3.7 megapixels at rest.
    const m = await grabbed('huge');
    const rest = { paints: m.paints(), px: m.canvas().width * m.canvas().height };
    expect(rest.px).toBeGreaterThan(PICTURE_DRAG_PX * 3);
    for (const [i, x] of [510, 520, 530].entries()) {
      document.dispatchEvent(ev('pointermove', x));
      await tick();
      expect(m.paints(), `move ${i + 1}`).toBe(rest.paints + i + 1);
      const el = m.canvas();
      expect(scaleOf(paintBoxPicture.mock.calls.at(-1))).toBeLessThan(1);
      // The box's own area is what is budgeted; the footprint's few px of
      // padding round it are the slack.
      expect(el.width * el.height).toBeLessThan(PICTURE_DRAG_PX * 1.05);
      expect(el.width * el.height).toBeGreaterThan(PICTURE_DRAG_PX * 0.9);
      // Shown at the footprint's size, to within the one texel a canvas of
      // whole pixels rounds up by - about two page px at this scale.
      const f = footprint(m.box, m.pg);
      const texel = 1 / scaleOf(paintBoxPicture.mock.calls.at(-1));
      expect(css(el).width - f.cw).toBeGreaterThanOrEqual(0);
      expect(css(el).width - f.cw).toBeLessThan(texel);
      expect(css(el).height - f.ch).toBeGreaterThanOrEqual(0);
      expect(css(el).height - f.ch).toBeLessThan(texel);
    }
    expect(m.box.w).toBe(1630);
  });

  it('and is painted once more when the handle is let go, at the scale it has at rest', async () => {
    const m = await grabbed('huge');
    document.dispatchEvent(ev('pointermove', 520));
    await tick();
    const dragging = m.paints();
    document.dispatchEvent(ev('pointerup', 520));
    await tick();
    expect(m.paints()).toBe(dragging + 1);
    expect(scaleOf(paintBoxPicture.mock.calls.at(-1))).toBe(1);
    const f = footprint(m.box, m.pg);
    expect(m.canvas().width).toBe(f.cw);
    expect(m.canvas().height).toBe(f.ch);
    // And nothing after that: the next change is painted in full.
    await tick();
    expect(m.paints()).toBe(dragging + 1);
  });

  it('a press on a handle that never moves repaints nothing', async () => {
    const m = await grabbed('huge');
    const before = m.paints();
    document.dispatchEvent(ev('pointerup', 500));
    await tick();
    expect(m.paints()).toBe(before);
  });

  it('a box within the budget is painted at its full scale all through, and letting go repaints nothing', async () => {
    _setDisplayScale(2);
    const m = await grabbed('straight');
    document.dispatchEvent(ev('pointermove', 520));
    await tick();
    expect(scaleOf(paintBoxPicture.mock.calls.at(-1))).toBe(2);
    expect(m.canvas().width).toBe(footprint(m.box, m.pg).cw * 2);
    const dragging = m.paints();
    document.dispatchEvent(ev('pointerup', 520));
    await tick();
    expect(m.paints()).toBe(dragging);
  });

  it('the rotate handle turns the box and repaints nothing, as a turn does', async () => {
    // 'finish' is turned already: another angle is the same picture.
    const m = await mounted('finish');
    selectBox('finish');
    await tick();
    const before = m.paints();
    m.root.querySelector('.handle.rot').dispatchEvent(ev('pointerdown', 500));
    document.dispatchEvent(ev('pointermove', 560));
    await tick();
    document.dispatchEvent(ev('pointerup', 560));
    await tick();
    expect(m.paints()).toBe(before);
  });
});

describe('what repaints the picture, and what does not', () => {
  const quiet = async (name, change) => {
    const m = await mounted('finish');
    const before = { paints: m.paints(), w: m.canvas().width };
    await change(m);
    await tick();
    expect(m.paints(), name).toBe(before.paints);
    return m;
  };
  const loud = async (name, change, id = 'finish') => {
    const m = await mounted(id);
    const before = m.paints();
    await change(m);
    await tick();
    expect(m.paints(), name).toBe(before + 1);
    return m;
  };

  it('a move does not', async () => {
    const m = await quiet('move', (m) => moveBoxTo(m.box, 333.3, 77.7, m.pg, moveGeom(m.box)));
    expect(m.root.style.left).toBe('333.3px');
  });
  // 'finish' is a turned box already: another angle is the same picture.
  it('a turn does not', () => quiet('rotation', (m) => (m.box.style.rotation = 33)));
  it('the opacity does not', () => quiet('opacity', (m) => (m.box.style.opacity = 0.2)));
  it('a flip does not', () => quiet('flip', (m) => (m.box.style.flipV = true)));
  it('selecting does not', () => quiet('select', (m) => selectBox(m.box.id)));
  it('selecting another box does not', () => quiet('select other', () => selectBox('straight')));

  it('a resize does', async () => {
    const m = await loud('width', (m) => (m.box.w = 300));
    expect(m.canvas().width).toBe(footprint(m.box, m.pg).cw * turned(m.box));
  });
  it('a taller box does', () => loud('height', (m) => (m.box.h = 140)));
  it('the text does', () => loud('text', (m) => (m.box.text = 'SOMETHING ELSE')));
  it('the colour does', () => loud('colour', (m) => (m.box.style.color = '#ff00ff')));
  it('the size does', () => loud('size', (m) => (m.box.style.size = 22)));
  it('a stroke does', () => loud('stroke', (m) => (m.box.style.strokes[0].width = 6)));
  it('a shadow does', () => loud('shadow', (m) => (m.box.style.shadows[0].x = 9)));
  it('the blur does', () => loud('blur', (m) => (m.box.style.blur = 5)));
  it('the mask does', () => loud('mask', (m) => (m.box.style.clip.shapes = [...m.box.style.clip.shapes, { kind: 'ellipse', cx: 10, cy: 10, rx: 5, ry: 5 }]), 'masked'));
  it('the curve does', () => loud('curve', (m) => (m.box.style.curve = -30), 'arc'));
  it('a path anchor does', () => loud('path', (m) => (m.box.style.path.pts[0].y = 20), 'path'));
  it('the mesh does', () => loud('mesh', (m) => (m.box.style.warp.pts = [[0, 0], [260, 30], [-6, 96], [240, 90]]), 'warped'));
  it('the ink does', () => loud('ink', (m) => (m.box.style.ink.strokes[0].color = '#ff0000'), 'inked'));
  it('a font arriving does', () => loud('fonts', () => noteFontsChanged()));
  it('a zoom that is not a gesture does', async () => {
    const m = await loud('zoom', () => setZoom(2));
    expect(m.canvas().width).toBe(Math.ceil(footprint(m.box, m.pg).cw * 2 * turned(m.box)));
  });

  it('a zoom gesture does not, until it settles, and then once', async () => {
    const m = await mounted('finish');
    const f = footprint(m.box, m.pg);
    const el = m.canvas();
    setZoomLive(true);
    for (const z of [1.1, 1.3, 1.7, 2.2]) {
      setZoom(z);
      await tick();
    }
    // The bitmap that is there, stretched by the browser to the new CSS box.
    expect(m.paints()).toBe(1);
    expect(el.width).toBe(f.cw * turned(m.box));
    expect(css(el).width).toBeCloseTo(f.cw * 2.2, 6);
    setZoomLive(false);
    await tick();
    expect(m.paints()).toBe(2);
    expect(el.width).toBe(Math.ceil(f.cw * 2.2 * turned(m.box)));
    // Nothing more is owed.
    await tick();
    expect(m.paints()).toBe(2);
  });

  it('a box that mounts in the middle of a gesture still paints its first frame', async () => {
    setZoomLive(true);
    const m = await mounted('straight', { zoom: 1.4 });
    expect(m.paints()).toBe(1);
    expect(m.canvas().width).toBeGreaterThan(0);
    setZoom(1.6);
    await tick();
    expect(m.paints()).toBe(1);
  });
});

describe('when the pixels are handed back', () => {
  it('on unmount', async () => {
    const m = await mounted('finish');
    const el = m.canvas();
    expect(el.width * el.height).toBeGreaterThan(0);
    m.view.unmount();
    expect([el.width, el.height]).toEqual([0, 0]);
  });

  it('when the box starts being typed into, which shows the editable exactly as with the switch off', async () => {
    const m = await mounted('finish');
    const el = m.canvas();
    beginEdit('finish');
    await tick();
    expect(m.root.querySelector('canvas')).toBe(null);
    expect([el.width, el.height]).toEqual([0, 0]);
    const editable = m.root.querySelector('.txt.editable');
    expect(editable).not.toBe(null);
    expect(editable.getAttribute('contenteditable')).toBe('true');
    expect(editable.classList.contains('ghost')).toBe(false);
    // The flip stands down for the caret, as it always did.
    expect(m.root.querySelector('.clipwrap').style.transform).toBe('');
    // The filters the editable types under are back with it.
    expect(m.root.querySelectorAll('svg.rough-def')).toHaveLength(1);
  });

  it('and the picture is back, painted once, when the edit ends', async () => {
    const m = await mounted('finish');
    beginEdit('finish');
    await tick();
    const before = m.paints();
    endEdit(m.box.text);
    await tick();
    const el = m.canvas();
    expect(el).not.toBe(null);
    expect(el.width * el.height).toBeGreaterThan(0);
    expect(m.paints()).toBe(before + 1);
    expect(m.root.querySelector('.txt')).toBe(null);
  });

  it('curved text being typed into is its glyph spans and the hidden editable, as with the switch off', async () => {
    const m = await mounted('arc');
    beginEdit('arc');
    await tick();
    expect(m.root.querySelector('canvas')).toBe(null);
    expect(m.root.querySelectorAll('.arcstack .arc-ch').length).toBeGreaterThan(0);
    expect(m.root.querySelector('.txt.editable.ghost')).not.toBe(null);
    expect(m.root.querySelector('.curve-edit')).not.toBe(null);
  });

  it('on a page the paged view keeps mounted but hidden: the element stays, with no pixels and no paint', async () => {
    const m = await mounted('finish', { props: { shown: false } });
    const el = m.canvas();
    expect(el).not.toBe(null);
    expect([el.width, el.height]).toEqual([0, 0]);
    expect(m.paints()).toBe(0);
    // Its turn comes: painted in the same breath.
    await m.view.rerender({ shown: true });
    await tick();
    expect(m.paints()).toBe(1);
    expect(el.width * el.height).toBeGreaterThan(0);
    // And hidden again, the pixels go back.
    await m.view.rerender({ shown: false });
    await tick();
    expect([el.width, el.height]).toEqual([0, 0]);
    expect(m.paints()).toBe(1);
  });
});

describe('a box nobody can see', () => {
  beforeEach(() => vi.stubGlobal('IntersectionObserver', FakeObserver));

  it('on the page in front of the user: paints at once, lets go when the observer says it is far, and paints again when near', async () => {
    const m = await mounted('finish');
    const el = m.canvas();
    expect(m.paints()).toBe(1);
    expect(observed.has(m.reach())).toBe(true);
    expect(FakeObserver.options).toEqual({ rootMargin: '50%' });
    say(m.reach(), true);
    await tick();
    expect(m.paints()).toBe(1);
    say(m.reach(), false);
    await tick();
    expect([el.width, el.height]).toEqual([0, 0]);
    expect(m.paints()).toBe(1);
    say(m.reach(), true);
    await tick();
    expect(m.paints()).toBe(2);
    expect(el.width * el.height).toBeGreaterThan(0);
  });

  it('in a longstrip (lazy): waits to be told it is near before it paints at all', async () => {
    const m = await mounted('finish', { props: { lazy: true } });
    const el = m.canvas();
    expect(m.paints()).toBe(0);
    expect([el.width, el.height]).toEqual([0, 0]);
    say(m.reach(), false);
    await tick();
    expect(m.paints()).toBe(0);
    say(m.reach(), true);
    await tick();
    expect(m.paints()).toBe(1);
    expect(el.width * el.height).toBeGreaterThan(0);
    say(m.reach(), false);
    await tick();
    expect([el.width, el.height]).toEqual([0, 0]);
  });

  it('is asked about again when its page comes back on screen', async () => {
    const m = await mounted('finish');
    say(m.reach(), false);
    await tick();
    expect(m.paints()).toBe(1);
    await m.view.rerender({ shown: false });
    await tick();
    expect(observed.has(m.reach())).toBe(false);
    await m.view.rerender({ shown: true });
    await tick();
    // Unknown again, so it paints for the page turn; the observer corrects it a frame later.
    expect(observed.has(m.reach())).toBe(true);
    expect(m.paints()).toBe(2);
  });

  it('comes back into view during a zoom gesture: painted then, not left blank until the gesture settles', async () => {
    const m = await mounted('finish');
    say(m.reach(), false);
    await tick();
    setZoomLive(true);
    setZoom(0.5);
    await tick();
    expect(m.paints()).toBe(1);
    say(m.reach(), true);
    await tick();
    expect(m.paints()).toBe(2);
    expect(m.canvas().width).toBeGreaterThan(0);
  });

  it('is not watched at all with the switch off', async () => {
    engineSwitch.painting = false;
    const m = await mounted('finish');
    expect(observed.size).toBe(0);
    expect(m.root.querySelector('canvas')).toBe(null);
    expect(m.reach()).toBe(null);
  });

  // What is watched is what the picture covers, not the box's rectangle: ink
  // past the rectangle that is still in view must keep the box painted.
  it('is judged by its picture\'s footprint: the watched element is laid over it, and stays there when the pixels go', async () => {
    const m = await mounted('finish', { zoom: 1.5 });
    const f = footprint(m.box, m.pg);
    // The stroke, the shadow and the blur reach past the box on every side.
    expect(f.ox).toBeGreaterThan(8);
    expect(f.cw).toBeGreaterThan(m.box.w + 16);
    const el = m.reach();
    expect(el.parentElement.classList.contains('clipwrap')).toBe(true);
    const over = () => css(el);
    expect(over().left).toBeCloseTo(-f.ox * 1.5, 6);
    expect(over().top).toBeCloseTo(-f.oy * 1.5, 6);
    expect(over().width).toBeCloseTo(f.cw * 1.5, 0);
    expect(over().height).toBeCloseTo(f.ch * 1.5, 0);
    const held = over();
    say(el, false);
    await tick();
    expect([m.canvas().width, m.canvas().height]).toEqual([0, 0]);
    expect(m.reach()).toBe(el);
    expect(over()).toEqual(held);
    // And while the box is typed into, when there is no picture at all.
    say(el, true);
    await tick();
    beginEdit('finish');
    await tick();
    expect(m.reach()).toBe(el);
    expect(observed.has(el)).toBe(true);
    expect(over()).toEqual(held);
  });

  it('before anything has been painted the watched element is the box\'s own rectangle', async () => {
    const m = await mounted('finish', { props: { lazy: true } });
    expect(m.paints()).toBe(0);
    const el = m.reach();
    expect([el.style.left, el.style.top, el.style.width, el.style.height]).toEqual(['0px', '0px', '100%', '100%']);
    say(el, true);
    await tick();
    expect(m.paints()).toBe(1);
    expect(css(el).left).toBeLessThan(-8);
  });

  it('follows the picture when the box changes', async () => {
    const m = await mounted('finish');
    const before = css(m.reach());
    m.box.w = 400;
    await tick();
    expect(css(m.reach()).width).toBeCloseTo(before.width + 160, 0);
  });
});

describe('what a screen reader is told while the box is a picture', () => {
  // The words are pixels then: the canvas is hidden from the accessibility
  // tree and there is no text node. The box itself says them.
  it('the box carries its text as its name, and a role that may have one', async () => {
    const m = await mounted('straight');
    expect(m.root.getAttribute('aria-label')).toBe('WAIT FOR ME\nOVER THERE');
    expect(m.root.getAttribute('role')).toBe('group');
    expect(m.canvas().getAttribute('aria-hidden')).toBe('true');
  });
  it('the name follows the text', async () => {
    const m = await mounted('arc');
    m.box.text = 'SOMETHING ELSE';
    await tick();
    expect(m.root.getAttribute('aria-label')).toBe('SOMETHING ELSE');
  });
  it('typed into, the text is in the document again and the box says nothing of its own', async () => {
    const m = await mounted('straight');
    beginEdit('straight');
    await tick();
    expect(m.root.hasAttribute('aria-label')).toBe(false);
    expect(m.root.hasAttribute('role')).toBe(false);
  });
  it('with the switch off there is neither: the letters are elements', async () => {
    engineSwitch.painting = false;
    const m = await mounted('straight');
    expect(m.root.hasAttribute('aria-label')).toBe(false);
    expect(m.root.hasAttribute('role')).toBe(false);
  });
  it('a box with no text has no name to give', async () => {
    const m = await mounted('straight');
    m.box.text = '';
    await tick();
    expect(m.root.hasAttribute('aria-label')).toBe(false);
    expect(m.root.hasAttribute('role')).toBe(false);
  });
});

describe('what takes the pointer while the box is a picture', () => {
  // The canvas takes none (it is `.warpl`, and its footprint has padding that
  // would take clicks meant for what is under it). With the switch off the
  // letters themselves are elements and take the pointer wherever they are,
  // outside the frame too; with it on, something has to stand where they stood.
  const press = (el) => el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  // Where a glyph's element is centred, zoomed px from the box's centre.
  const centre = (el) => /translate\(calc\(-50% \+ (-?[\d.e-]+)px\), calc\(-50% \+ (-?[\d.e-]+)px\)\)/.exec(el.getAttribute('style')).slice(1).map(Number);
  const outside = (m, el) => {
    const [x, y] = centre(el);
    return Math.abs(x) > (m.box.w * app.zoom) / 2 || Math.abs(y) > (m.box.h * app.zoom) / 2;
  };
  // An arc that leaves its frame at both ends.
  const arcOut = async (on, zoom = 1) => {
    engineSwitch.painting = on;
    const m = await mounted('arc', { zoom });
    m.box.w = 120;
    m.box.style.curve = 70;
    await tick();
    return m;
  };

  it('with the switch off a letter of an arc outside the frame selects the box', async () => {
    const m = await arcOut(false);
    const letters = [...m.root.querySelectorAll('.arcstack .arc:last-child .arc-ch')];
    const out = letters.filter((el) => outside(m, el));
    expect(out.length).toBeGreaterThan(3);
    press(out[0]);
    expect(app.selectedId).toBe('arc');
  });

  it('and with it on: one target per glyph, where the glyph\'s own element was, and a press on one outside the frame selects the box', async () => {
    const off = await arcOut(false, 1.5);
    const was = [...off.root.querySelectorAll('.arcstack .arc:last-child .arc-ch')].map((el) => centre(el));
    cleanup();
    const m = await arcOut(true, 1.5);
    const hits = [...m.root.querySelectorAll('.hit')];
    expect(hits).toHaveLength(was.length);
    hits.forEach((el, i) => {
      const [x, y] = centre(el);
      expect(x).toBeCloseTo(was[i][0], 6);
      expect(y).toBeCloseTo(was[i][1], 6);
      // A glyph's advance wide and a line high, turned as the glyph is.
      expect(parseFloat(el.style.width)).toBeGreaterThan(0);
      expect(parseFloat(el.style.height)).toBeCloseTo(m.box.style.size * 1.5 * m.box.style.lineHeight, 6);
      expect(el.getAttribute('style')).toMatch(/rotate\(-?[\d.e-]+rad\)/);
    });
    const out = hits.filter((el) => outside(m, el));
    expect(out.length).toBeGreaterThan(3);
    expect(app.selectedId).toBe(null);
    press(out.at(-1));
    expect(app.selectedId).toBe('arc');
    // Inside the wrapper that carries the flip, as the picture is; and the
    // canvas is still no target.
    expect(out[0].parentElement.classList.contains('clipwrap')).toBe(true);
    expect(m.canvas().classList.contains('warpl')).toBe(true);
  });

  it('a double click on one opens the edit, as on a letter', async () => {
    const m = await arcOut(true);
    const out = [...m.root.querySelectorAll('.hit')].filter((el) => outside(m, el));
    out[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await tick();
    expect(app.editingId).toBe('arc');
    // Typed into, the glyphs are elements again and the targets are gone.
    expect(m.root.querySelector('.hit')).toBe(null);
  });

  it('follows the hand tool like the rest of the box: it states no pointer-events of its own', async () => {
    const m = await arcOut(true);
    for (const el of m.root.querySelectorAll('.hit')) expect(el.style.pointerEvents).toBe('');
  });

  it('straight text that fits its box needs none: the box is the target', async () => {
    const m = await mounted('straight');
    expect(m.root.querySelector('.hit')).toBe(null);
  });

  it('straight text that overflows its box gets one target, the block\'s rectangle, and a press on it selects the box', async () => {
    const m = await mounted('straight', { zoom: 2 });
    m.box.style.autoHeight = false;
    m.box.h = 20;
    await tick();
    const hits = [...m.root.querySelectorAll('.hit')];
    expect(hits).toHaveLength(1);
    const r = css(hits[0]);
    // Two lines of 30 px type at line height 1.1, centred on a box 20 high:
    // the block starts above the box and ends below it.
    const blockH = 2 * 30 * m.box.style.lineHeight * 2;
    expect(r.height).toBeCloseTo(blockH, 6);
    expect(r.top).toBeLessThan(-20);
    expect(r.top + r.height).toBeGreaterThan(20 * 2 + 20);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.left + r.width).toBeLessThanOrEqual(m.box.w * 2);
    press(hits[0]);
    expect(app.selectedId).toBe('straight');
    // Roomy again, the target goes.
    m.box.h = 200;
    await tick();
    expect(m.root.querySelector('.hit')).toBe(null);
  });

  it('a line wider than its box is covered across', async () => {
    const m = await mounted('straight');
    m.box.text = 'UNBREAKABLEWORDTHATISLONG';
    m.box.w = 60;
    await tick();
    const r = css(m.root.querySelector('.hit'));
    expect(r.left).toBeLessThan(0);
    expect(r.left + r.width).toBeGreaterThan(60);
  });

  it('a warped box has none, as it has none with the switch off', async () => {
    const m = await mounted('warped');
    expect(m.root.querySelector('.hit')).toBe(null);
  });

  it('there is none with the switch off', async () => {
    const m = await arcOut(false);
    expect(m.root.querySelector('.hit')).toBe(null);
  });
});

describe('a paint that throws', () => {
  // The painter can refuse a job (the engine throws for one it will not
  // paint). The box must not keep a stale picture or an empty one: it is its
  // DOM text until what it is painted from changes.
  let said;
  beforeEach(() => {
    said = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    paintBoxPicture.mockImplementation(real.paintBoxPicture);
    said.mockRestore();
  });
  const refuse = () => paintBoxPicture.mockImplementation(() => {
    throw new Error('mt-text: paintJob: malformed paint job, or a surface larger than the engine allows');
  });
  const isDom = (m) => {
    expect(m.root.querySelector('canvas')).toBe(null);
    const lines = [...m.root.querySelectorAll('.txt.shaped.stack .tlayer.base .tline')].map((el) => el.textContent);
    expect(lines.join(' ')).toBe(m.box.text.replace(/\n/g, ' '));
  };

  it('leaves the box as its DOM text, exactly as with the switch off, and says so once', async () => {
    refuse();
    const m = await mounted('straight');
    isDom(m);
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0][0])).toContain('straight');
    // The same elements the box has with the switch off.
    const on = m.root.querySelector('.txt.shaped.stack').outerHTML;
    engineSwitch.painting = false;
    await tick();
    expect(m.root.querySelector('.txt.shaped.stack').outerHTML).toBe(on);
  });

  it('is not tried again for the same picture: a move, a turn and a selection leave it alone', async () => {
    refuse();
    const m = await mounted('straight');
    const tries = m.paints();
    moveBoxTo(m.box, 300, 400, m.pg, moveGeom(m.box));
    await tick();
    m.box.style.rotation = 90;
    await tick();
    selectBox('straight');
    await tick();
    expect(m.paints()).toBe(tries);
    isDom(m);
    expect(said).toHaveBeenCalledTimes(1);
  });

  it('is tried again when what it is painted from changes, and is the picture again when that paints', async () => {
    refuse();
    const m = await mounted('straight');
    isDom(m);
    paintBoxPicture.mockImplementation(real.paintBoxPicture);
    m.box.text = 'SOMETHING ELSE';
    await tick();
    const el = m.canvas();
    expect(el).not.toBe(null);
    expect(el.width * el.height).toBeGreaterThan(0);
    expect(m.root.querySelector('.txt')).toBe(null);
  });

  it('a change that still throws leaves the text, the new text, and is not said again', async () => {
    refuse();
    const m = await mounted('straight');
    const tries = m.paints();
    m.box.text = 'SOMETHING ELSE';
    await tick();
    expect(m.paints()).toBe(tries + 1);
    isDom(m);
    m.box.w = 300;
    await tick();
    isDom(m);
    expect(said).toHaveBeenCalledTimes(1);
  });

  it('a box that painted and then throws lets go of the picture it had', async () => {
    const m = await mounted('straight');
    const el = m.canvas();
    expect(el.width).toBeGreaterThan(0);
    refuse();
    m.box.style.color = '#ff0000';
    await tick();
    expect([el.width, el.height]).toEqual([0, 0]);
    isDom(m);
  });

  it('the other boxes of the same flush are painted, and the box that threw goes on working', async () => {
    loadProjectPages([{ id: 1, w: 1600, h: 2300, lines: [], boxes: Object.values(KINDS).map((b) => structuredClone(b)) }]);
    const pg = page();
    const frame = document.createElement('div');
    const views = ['straight', 'finish', 'masked'].map((id) => render(TextBox, { box: pg.boxes.find((b) => b.id === id), pageFrameEl: frame, pg }));
    await tick();
    const roots = views.map((v) => v.container.querySelector('.tbox'));
    for (const r of roots) expect(r.querySelector('canvas').width).toBeGreaterThan(0);
    // One change repaints all three in one flush; the first of them throws.
    paintBoxPicture.mockClear();
    paintBoxPicture.mockImplementationOnce(() => {
      throw new Error('refused');
    });
    noteFontsChanged();
    await tick();
    expect(paintBoxPicture).toHaveBeenCalledTimes(3);
    const pictured = roots.filter((r) => r.querySelector('canvas')?.width > 0);
    expect(pictured).toHaveLength(2);
    const fell = roots.find((r) => !r.querySelector('canvas'));
    expect(fell.querySelector('.txt.shaped.stack')).not.toBe(null);
    // Its other effects still run: it can be selected and typed into.
    selectBox(fell.dataset.id);
    await tick();
    expect(fell.querySelectorAll('.handle')).toHaveLength(9);
    beginEdit(fell.dataset.id);
    await tick();
    expect(fell.querySelector('.txt.editable')).not.toBe(null);
  });

  it('a late repaint that throws is caught too: the box falls back and nothing is left unhandled', async () => {
    let release;
    noise.gate = new Promise((resolve) => (release = resolve));
    const m = await mounted('rough');
    expect(m.paints()).toBe(1);
    refuse();
    release();
    await vi.waitFor(() => expect(m.paints()).toBe(2));
    await tick();
    expect(m.root.querySelector('canvas')).toBe(null);
    expect(m.root.querySelector('.txt.shaped.stack')).not.toBe(null);
    expect(said).toHaveBeenCalledTimes(1);
  });
});

describe('a paint that lands late', () => {
  // A roughened box is painted at once and again when the phase of the
  // browser's turbulence has been measured, which is a promise.
  const held = () => {
    let release;
    noise.gate = new Promise((resolve) => (release = resolve));
    return () => release();
  };

  it('repaints once when the measurement lands and the box is still there', async () => {
    const release = held();
    const m = await mounted('rough');
    expect(m.paints()).toBe(1);
    release();
    await vi.waitFor(() => expect(m.paints()).toBe(2));
    expect(m.canvas().width).toBeGreaterThan(0);
  });

  it('is dropped when the box went off screen meanwhile: nothing is painted back', async () => {
    const release = held();
    const m = await mounted('rough');
    const el = m.canvas();
    await m.view.rerender({ shown: false });
    await tick();
    expect([el.width, el.height]).toEqual([0, 0]);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(m.paints()).toBe(1);
    expect([el.width, el.height]).toEqual([0, 0]);
  });

  it('is dropped when a newer paint has been made meanwhile', async () => {
    const release = held();
    const m = await mounted('rough');
    m.box.style.color = '#00ff00';
    await tick();
    expect(m.paints()).toBe(2);
    release();
    // The first paint's settle is stale; the second's lands and repaints once.
    await vi.waitFor(() => expect(m.paints()).toBe(3));
    await new Promise((r) => setTimeout(r, 5));
    expect(m.paints()).toBe(3);
  });

  it('is dropped when the box was unmounted meanwhile', async () => {
    const release = held();
    const m = await mounted('rough');
    const el = m.canvas();
    m.view.unmount();
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(m.paints()).toBe(1);
    expect([el.width, el.height]).toEqual([0, 0]);
  });

  it('is dropped when the box started being typed into meanwhile', async () => {
    const release = held();
    const m = await mounted('rough');
    const el = m.canvas();
    beginEdit('rough');
    await tick();
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(m.paints()).toBe(1);
    expect([el.width, el.height]).toEqual([0, 0]);
  });
});

describe('the display, as a browser tells of it', () => {
  // The other cases set the density by hand, which goes round the part that
  // listens. Here nothing is set: the ratio is the window's, and a change is
  // the `resolution` media query's, as when the window is dragged to another
  // display. (The first version wrote state on first read, inside a derived;
  // every case above passed and no box was painted in a browser.)
  let queries;
  const density = (dpr) => Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
  beforeEach(() => {
    _setDisplayScale(0);
    queries = [];
    window.matchMedia = (text) => {
      const q = { text, listeners: new Set(), addEventListener: (_, fn) => q.listeners.add(fn), removeEventListener: (_, fn) => q.listeners.delete(fn) };
      queries.push(q);
      return q;
    };
  });
  afterEach(() => {
    density(1);
    delete window.matchMedia;
  });
  // What a display change is to the page: the ratio is new, and the query
  // that matched the old one says so, once.
  const moveTo = async (dpr) => {
    density(dpr);
    for (const q of queries.slice()) for (const fn of [...q.listeners]) (q.listeners.delete(fn), fn());
    await tick();
  };

  it('paints at the window\'s own ratio with nobody having said what it is', async () => {
    density(2);
    const m = await mounted('straight');
    expect(m.paints()).toBe(1);
    expect(m.canvas().width).toBe(footprint(m.box, m.pg).cw * 2);
    expect(queries.at(-1).text).toBe('(resolution: 2dppx)');
  });

  it('repaints when the display changes, and listens for the next change', async () => {
    density(1);
    const m = await mounted('straight');
    const f = footprint(m.box, m.pg);
    expect(m.canvas().width).toBe(f.cw);
    await moveTo(2);
    expect(m.paints()).toBe(2);
    expect(m.canvas().width).toBe(f.cw * 2);
    expect(queries.at(-1).text).toBe('(resolution: 2dppx)');
    await moveTo(1.5);
    expect(m.paints()).toBe(3);
    expect(m.canvas().width).toBe(Math.ceil(f.cw * 1.5));
    await moveTo(1);
    expect(m.paints()).toBe(4);
    expect(m.canvas().width).toBe(f.cw);
  });

  it('stops listening when the last picture is gone', async () => {
    density(2);
    const m = await mounted('straight');
    const live = () => queries.reduce((n, q) => n + q.listeners.size, 0);
    expect(live()).toBe(1);
    m.view.unmount();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(live()).toBe(0);
  });

  it('with the flag false nothing listens at all', async () => {
    engineSwitch.painting = false;
    await mounted('straight');
    expect(queries).toHaveLength(0);
  });
});
