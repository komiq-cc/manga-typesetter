import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../../test/rust-engine.js';
import { PICTURE_MAX_PX, paintBoxPicture, paintPictureTexture } from './box-picture.js';
import { renderBoxTexture, warpTexture } from '../exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from '../text-engine/index.js';
import { createRustGlyphPainter, SCRATCH_KEEP_PX } from '../text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from '../measure.js';
import { defaultStyle, normalizeStyle } from '../data.js';

// ===========================================================================
// The editor's picture of a box, painted by the real engine
// ===========================================================================
// What the editor puts on screen for a box is what `renderBoxTexture` makes,
// and "the same" is meant as bytes: `paintBoxPicture` adds a canvas to copy
// into and nothing else. Pinned here with the Rust engine and its painter on
// Skia's canvas (@napi-rs/canvas), for every route a box takes through the
// exporter - straight, finished, curved, masked, through the mesh - and at
// the scales a display asks for, whole and not. Then the two things the
// editor adds: the budget, and giving back what it borrowed.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
// Every canvas anything asked the document for, and whether its pixels were
// given back (width set to 0). Recorded at the setter: this canvas reports a
// zeroed size as 350 x 150, so it cannot be asked afterwards.
let made = [];
function tracked() {
  const c = createCanvas(300, 150);
  const rec = { c, released: false };
  const width = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c), 'width');
  Object.defineProperty(c, 'width', {
    configurable: true,
    get: () => width.get.call(c),
    set: (v) => {
      rec.released = v === 0;
      width.set.call(c, v);
    },
  });
  made.push(rec);
  return c;
}

beforeAll(async () => {
  globalThis.document = {
    createElement: () => tracked(),
  };
  const rust = await rustEngine();
  setTextEngine(rust);
  setGlyphPainter(createRustGlyphPainter(rust));
  setTypesetEnabled(true);
  clearLayoutMemo();
});
afterAll(() => {
  setTextEngine(before.engine);
  setGlyphPainter(before.painter);
  setTypesetEnabled(before.typeset);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});
beforeEach(() => {
  made = [];
});

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, strokes: [], ...over });
const boxOf = (over = {}, text = 'THE EDITOR SHOWS\nWHAT IS EXPORTED', geom = {}) => ({ id: 'b', lineN: null, text, x: 100, y: 100, w: 300, h: 90, ...geom, style: style(over) });
const pageOf = (box) => ({ id: 1, w: 1600, h: 2300, lines: [], boxes: [box] });
const bytes = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
const unlike = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};
const inked = (data) => {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]) n++;
  return n;
};

const KINDS = {
  plain: {},
  finished: {
    strokes: [{ color: '#e11d48', width: 3 }],
    shadows: [{ x: 4, y: 5, blur: 3, color: '#000000', opacity: 0.6 }],
    blur: 0.6,
  },
  smeared: { motionBlur: { on: true, x: 2, y: 1, amount: 5 } },
  arc: { curve: 40 },
  circle: { curve: 360 },
  masked: { clip: { on: true, mode: 'include', shapes: [{ kind: 'ellipse', cx: 150, cy: 45, rx: 120, ry: 34 }] } },
  warped: { warp: { on: true, cols: 1, rows: 1, pts: [[0, 0], [300, 22], [-8, 96], [290, 84]] } },
};

describe('the picture is renderBoxTexture\'s, byte for byte', () => {
  for (const [kind, over] of Object.entries(KINDS)) {
    for (const scale of [1, 2, 2.74, 6]) {
      it(`${kind} at ${scale}`, () => {
        const box = boxOf(over);
        const p = pageOf(box);
        const want = warpTexture(renderBoxTexture(box, p, null, scale, PICTURE_MAX_PX), box);
        const el = createCanvas(300, 150);
        const g = paintBoxPicture(el, box, p, scale, null);
        expect([el.width, el.height]).toEqual([want.canvas.width, want.canvas.height]);
        const got = bytes(el);
        expect(inked(got)).toBeGreaterThan(500);
        expect(unlike(got, bytes(want.canvas))).toBe(0);
        // And it says where the picture goes, in page px.
        expect(g).toEqual({ ox: want.ox, oy: want.oy, cw: want.cw, ch: want.ch });
      });
    }
  }

  it('a second paint into the same canvas leaves nothing of the first', () => {
    const el = createCanvas(300, 150);
    const first = boxOf({ strokes: [{ color: '#e11d48', width: 6 }] });
    paintBoxPicture(el, first, pageOf(first), 2, null);
    const second = boxOf({}, 'LESS');
    paintBoxPicture(el, second, pageOf(second), 2, null);
    const want = renderBoxTexture(second, pageOf(second), null, 2);
    expect(unlike(bytes(el), bytes(want.canvas))).toBe(0);
  });
});

describe('what it holds', () => {
  it('nothing but the picture: every canvas made on the way is given back', () => {
    for (const over of Object.values(KINDS)) {
      const box = boxOf(over);
      paintBoxPicture(createCanvas(1, 1), box, pageOf(box), 2, null);
    }
    // The painter's one scratch canvas is the painter's, and is bounded
    // (rust-painter.js); nothing of the box's own size is left.
    expect(made.length).toBeGreaterThan(Object.keys(KINDS).length);
    const held = made.filter((r) => !r.released);
    expect(held.length).toBeLessThanOrEqual(1);
    for (const r of held) expect(r.c.width * r.c.height).toBeLessThanOrEqual(SCRATCH_KEEP_PX);
  });

  it('and the bound holds for boxes that could break it: one line across a page, then one column down it', () => {
    // The outside review's pair, at 300% on a 2x display. Each raster is
    // small; a scratch raised to the widest and the tallest seen was 8739 x
    // 6306, 210 MB, kept until the engine was switched off.
    const wide = boxOf({ size: 12 }, 'W'.repeat(140), { w: 1600, h: 30 });
    const tall = boxOf({ size: 12 }, Array(80).fill('WWW').join('\n'), { w: 60, h: 1200 });
    const small = boxOf({ size: 12 }, 'W');
    for (const box of [wide, tall, small]) {
      const el = createCanvas(1, 1);
      paintBoxPicture(el, box, pageOf(box), 6, null);
      expect(inked(bytes(el))).toBeGreaterThan(100);
      const held = made.filter((r) => !r.released);
      expect(held.length).toBeLessThanOrEqual(1);
      for (const r of held) expect(r.c.width * r.c.height).toBeLessThanOrEqual(SCRATCH_KEEP_PX);
    }
  });

  it('a box over the budget is painted to the budget and still spans its footprint', () => {
    const box = boxOf({ size: 120 }, 'A WHOLE\nPAGE OF\nTYPE', { x: 0, y: 0, w: 1600, h: 2300 });
    const p = pageOf(box);
    const el = createCanvas(1, 1);
    const g = paintBoxPicture(el, box, p, 6, null);
    const uncapped = renderBoxTexture(box, p, null, 1);
    expect(el.width * el.height).toBeLessThanOrEqual(PICTURE_MAX_PX * 1.01);
    expect(el.width * el.height).toBeGreaterThan(PICTURE_MAX_PX * 0.97);
    // The same page px as at any scale: CSS stretches the picture over them.
    expect(g.ox).toBe(uncapped.ox);
    expect(g.oy).toBe(uncapped.oy);
    expect(g.cw).toBeCloseTo(uncapped.cw, 0);
    expect(g.ch).toBeCloseTo(uncapped.ch, 0);
    expect(inked(bytes(el))).toBeGreaterThan(10000);
  });

  it('the mesh gizmo\'s texture is the gesture\'s: painted from again and again, and not released', () => {
    const box = boxOf(KINDS.warped);
    const p = pageOf(box);
    const tex = renderBoxTexture(box, p, null, 2, PICTURE_MAX_PX);
    const size = [tex.canvas.width, tex.canvas.height];
    const el = createCanvas(1, 1);
    paintPictureTexture(el, tex, box);
    const first = bytes(el).slice();
    box.style.warp.pts = [[0, 0], [300, 40], [-8, 96], [290, 84]];
    paintPictureTexture(el, tex, box);
    expect(unlike(first, bytes(el))).toBeGreaterThan(0);
    expect([tex.canvas.width, tex.canvas.height]).toEqual(size);
    // What it shows is what a paint from nothing would.
    const whole = createCanvas(1, 1);
    paintBoxPicture(whole, box, p, 2, null);
    expect([el.width, el.height]).toEqual([whole.width, whole.height]);
    expect(unlike(bytes(el), bytes(whole))).toBe(0);
  });
});
