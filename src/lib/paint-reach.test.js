import { describe, it, expect } from 'vitest';
import { inkOverhang, styleReach } from './paint-reach.js';
import { inkReach } from './text-paint.js';
import { boxInkRect } from './contain.js';
import { defaultStyle, normalizeStyle } from './data.js';

const inkLine = (pts, size = 10) => ({ pts: pts.map(([x, y]) => [x, y, 1]), size, color: '#000000' });
const inkOf = (...strokes) => ({ on: true, strokes });
const style = (extra = {}) => normalizeStyle({ ...defaultStyle(), strokes: [], ...extra });
const W = 200;
const H = 100;
// A box with no text: all it paints is its ink, so the containment check's
// rectangle for it is the ink the export draws.
const inkOnly = (s) => ({ x: 0, y: 0, w: W, h: H, text: '', fit: null, style: s });

// Whether the editor's ink canvas - the box grown by the overhang on each side -
// holds a box-local rectangle.
const holds = (pad, r) => r.x >= -pad.l && r.y >= -pad.t && r.x + r.w <= W + pad.r && r.y + r.h <= H + pad.b;

describe("the editor's ink canvas (OVF-7 follow-up)", () => {
  it('reaches past the right and the bottom as far as the ink does', () => {
    // A stroke carried 50px past the right edge and 30px past the bottom.
    const s = style({ ink: inkOf(inkLine([[150, 60], [245, 125]])) });
    const pad = inkOverhang(s, W, H);
    expect(pad).toEqual({ l: 0, t: 0, r: 50, b: 30 });
    // What it used to be padded by on every side: the overhang above and left
    // only, which is none here - so the far ends were cut off.
    expect(inkReach(s)).toBe(0);
    expect(holds(pad, boxInkRect(inkOnly(s)))).toBe(true);
  });

  it('holds the outline and the shadows wrapped around the ink, on every side', () => {
    const s = style({
      ink: inkOf(inkLine([[-12, 20], [230, 20]]), inkLine([[100, -8], [100, 140]])),
      strokes: [{ width: 3, color: '#ffffff' }, { width: 2, color: '#000000' }],
      shadows: [{ x: 6, y: 9, blur: 2, color: '#000000', opacity: 1 }],
    });
    const pad = inkOverhang(s, W, H);
    const r = boxInkRect(inkOnly(s));
    expect(holds(pad, r)).toBe(true);
    // Every side of the canvas is past the ink's own edge on that side.
    expect(pad.l).toBeGreaterThan(17);
    expect(pad.r).toBeGreaterThan(35);
    expect(pad.b).toBeGreaterThan(45);
  });

  it('pads nothing for a box with no ink', () => {
    expect(inkOverhang(style(), W, H)).toEqual({ l: 0, t: 0, r: 0, b: 0 });
    expect(inkOverhang(style({ ink: { on: false, strokes: [inkLine([[0, 0], [300, 0]])] } }), W, H)).toEqual({
      l: 0,
      t: 0,
      r: 0,
      b: 0,
    });
  });
});

describe('what a style paints past the box, without a layout (strip seams)', () => {
  it("holds everything the check counts for a box of ink, however it is dressed", () => {
    const ink = inkOf(inkLine([[150, 60], [245, 125]]), inkLine([[-20, 10], [40, 10]]));
    const dressed = [
      {},
      { strokes: [{ width: 4, color: '#ffffff' }] },
      { shadows: [{ x: -9, y: 14, blur: 3, color: '#000000', opacity: 1 }] },
      { blur: 2 },
      { motionBlur: { on: true, x: 6, y: -3, amount: 4 } },
      { roughen: { on: true, amount: 8, detail: 0.05, seed: 1 } },
      { flipH: true, shadows: [{ x: 12, y: 0, blur: 0, color: '#000000', opacity: 1 }] },
      { flipV: true, strokes: [{ width: 2, color: '#ffffff' }], blur: 1 },
    ];
    for (const extra of dressed) {
      const s = style({ ink, ...extra, roughen: { ...defaultStyle().roughen, ...extra.roughen } });
      expect(holds(styleReach(s, W, H), boxInkRect(inkOnly(s)))).toBe(true);
    }
  });

  it('reaches only the way a shadow is thrown', () => {
    const s = style({ shadows: [{ x: 0, y: 30, blur: 2, color: '#000000', opacity: 1 }] });
    expect(styleReach(s, W, H)).toEqual({ l: 4, t: 0, r: 4, b: 34 });
    expect(styleReach({ ...s, shadows: [{ ...s.shadows[0], opacity: 0 }] }, W, H)).toEqual({ l: 0, t: 0, r: 0, b: 0 });
  });
});
