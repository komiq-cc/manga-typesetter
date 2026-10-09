import { describe, expect, it, vi } from 'vitest';
import { PICTURE_DRAG_PX, PICTURE_MAX_PX, PICTURE_OFF, TURNED_OVERSAMPLE, pageCorner, pictureCss, pictureKey, pictureScale } from './box-picture.js';
import { textureScale } from '../exporter.js';
import { defaultStyle, normalizeStyle } from '../data.js';

// ===========================================================================
// The editor's picture of a box: its scale, its key, its place
// ===========================================================================
// The parts of box-picture.js that are arithmetic. The painting is checked
// with the real engine in box-picture.engine.test.js and in a real browser by
// scripts/editor-check.mjs; what the component does with these is in
// TextBox-engine-picture.dom.test.js.

const css = (text) => Object.fromEntries(text.split(';').filter(Boolean).map((d) => d.split(':')).map(([k, v]) => [k, parseFloat(v)]));

describe('the scale a box is painted at', () => {
  it('is the zoom times the device pixel ratio', () => {
    expect(pictureScale(1, 1)).toBe(1);
    expect(pictureScale(1, 2)).toBe(2);
    expect(pictureScale(3, 2)).toBe(6);
    expect(pictureScale(0.37, 2)).toBeCloseTo(0.74, 12);
  });
  it('takes a display that reports no ratio as 1', () => {
    expect(pictureScale(2, 0)).toBe(2);
    expect(pictureScale(2, undefined)).toBe(2);
    expect(pictureScale(2, NaN)).toBe(2);
  });
  it('is finer for a box turned off the axes, and not for a quarter turn', () => {
    for (const deg of [7, -7, 0.5, 45, 179, 359]) expect(pictureScale(1.5, 2, deg), `${deg}`).toBe(3 * TURNED_OVERSAMPLE);
    for (const deg of [0, 90, 180, 270, -90, 360]) expect(pictureScale(1.5, 2, deg), `${deg}`).toBe(3);
  });
});

describe('the pixel budget of one box', () => {
  it('is 8 megapixels, 32 MB of RGBA', () => {
    expect(PICTURE_MAX_PX).toBe(8 * 1024 * 1024);
  });
  it('leaves an ordinary balloon at the scale asked for, at any zoom the editor has', () => {
    // 400 x 300 page px at 800% on a 2x display is 30.7 megapixels, over;
    // at 400% on a 2x display it is 7.7, under.
    expect(textureScale(400, 300, 8, PICTURE_MAX_PX)).toBe(8);
    expect(textureScale(400, 300, 16, PICTURE_MAX_PX)).toBeLessThan(16);
  });
  it('brings a box over it down to the budget, keeping its shape', () => {
    for (const [cw, ch, scale] of [[1600, 2300, 6], [4000, 200, 8], [900, 900, 4]]) {
      const ss = textureScale(cw, ch, scale, PICTURE_MAX_PX);
      expect(ss).toBeLessThan(scale);
      // To the budget, not past it: nothing is thrown away that could be shown.
      expect(cw * ss * ch * ss).toBeCloseTo(PICTURE_MAX_PX, -1);
    }
  });
  it('with no budget given, the export never loses resolution', () => {
    expect(textureScale(4000, 6000, 2)).toBe(2);
  });
});

describe('the budget while a handle is resizing the box', () => {
  // It is handed to the paint in the place of the picture's own budget, so it
  // is applied by the same arithmetic, to the same thing: the footprint.
  it('is a megapixel for a frame of the drag', () => {
    expect(PICTURE_DRAG_PX).toBe(1024 * 1024);
    expect(PICTURE_DRAG_PX).toBeLessThan(PICTURE_MAX_PX);
  });
  it('leaves a footprint within it at the scale asked for: an ordinary balloon is as sharp as at rest', () => {
    // 220 x 110 page px at 100% on a 2x display is a tenth of a megapixel.
    expect(textureScale(220, 110, 2, PICTURE_DRAG_PX)).toBe(2);
    expect(textureScale(1000, 1000, 1, PICTURE_DRAG_PX)).toBe(1);
    expect(textureScale(256, 256, 4, PICTURE_DRAG_PX)).toBe(4);
  });
  it('lowers a footprint over it to the budget and not past it', () => {
    for (const [cw, ch, scale] of [[1100, 800, 6], [600, 400, 6], [1600, 2300, 1], [4000, 200, 3], [130, 2100, 6]]) {
      const ss = textureScale(cw, ch, scale, PICTURE_DRAG_PX);
      expect(ss).toBeLessThan(scale);
      expect(cw * ss * ch * ss).toBeCloseTo(PICTURE_DRAG_PX, -1);
    }
  });
});

describe('what the picture is made from, as a key', () => {
  const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, ...over });
  const of = (over = {}) => ({ style: style(), inkKey: '', text: 'HELLO THERE', w: 220, h: 110, lines: ['HELLO', 'THERE'], indents: [0, 0], scale: 2, fonts: 4, ...over });
  const base = pictureKey(of());

  it('is not the off key', () => {
    expect(base).not.toBe(PICTURE_OFF);
    expect(base.startsWith('e|')).toBe(true);
  });
  it('leaves out what CSS applies to the finished picture', () => {
    expect(pictureKey(of({ style: style({ rotation: 33 }) }))).toBe(base);
    expect(pictureKey(of({ style: style({ opacity: 0.4 }) }))).toBe(base);
    expect(pictureKey(of({ style: style({ flipH: true }) }))).toBe(base);
    expect(pictureKey(of({ style: style({ flipV: true }) }))).toBe(base);
  });
  it('has no place for where the box is: there is nothing to pass', () => {
    expect(Object.keys(of())).not.toContain('x');
    expect(pictureKey({ ...of(), x: 10, y: 20 })).toBe(base);
  });
  it.each([
    ['the text', { text: 'HELLO THERE!' }],
    ['the width', { w: 221 }],
    ['the height', { h: 111 }],
    ['where the lines broke', { lines: ['HELLO THERE'] }],
    ['how far a line is set in', { indents: [0, 6] }],
    ['the scale', { scale: 3 }],
    ['the fonts', { fonts: 5 }],
    ['the ink', { inkKey: '3:9' }],
    ['the colour', { style: style({ color: '#ff0000' }) }],
    ['the size', { style: style({ size: 31 }) }],
    ['the font', { style: style({ font: 'Bangers' }) }],
    ['the curve', { style: style({ curve: 20 }) }],
    ['the blur', { style: style({ blur: 2 }) }],
    ['the alignment', { style: style({ align: 'left' }) }],
  ])('changes with %s', (_, over) => {
    expect(pictureKey(of(over))).not.toBe(base);
  });
  it('does not carry the ink block itself, only its key', () => {
    const heavy = style({ ink: { strokes: [{ color: '#000', width: 4, pts: Array.from({ length: 500 }, (_, i) => [i, i]) }] } });
    expect(pictureKey(of({ style: heavy })).length).toBeLessThan(base.length + 40);
  });
  it('takes a box with no shaped lines yet', () => {
    expect(() => pictureKey(of({ lines: null, indents: null }))).not.toThrow();
  });
});

describe('where the canvas is put', () => {
  const g = { ox: 4, oy: 6, cw: 228, ch: 122 };

  it('is the footprint, in zoomed CSS px from the box corner', () => {
    expect(css(pictureCss(g, 1.5))).toEqual({ left: -6, top: -9, width: 342, height: 183 });
  });
  it('a turned box is given the footprint exactly, whatever the display', () => {
    expect(css(pictureCss(g, 1.37, 2, null))).toEqual(css(pictureCss(g, 1.37)));
  });
  it('an upright box starts on a device pixel of the page', () => {
    for (const [z, dpr, at] of [[1.37, 2, { x: 975.37, y: 1210.61 }], [0.5, 2, { x: 45, y: 61 }], [3, 1, { x: 10.2, y: 0.9 }], [1, 1.5, { x: 33.3, y: 7 }]]) {
      const c = css(pictureCss(g, z, dpr, at));
      const left = (at.x * z + c.left) * dpr;
      const top = (at.y * z + c.top) * dpr;
      expect(left).toBeCloseTo(Math.round(left), 6);
      expect(top).toBeCloseTo(Math.round(top), 6);
      // Moved by half a device pixel at most.
      expect(Math.abs(c.left + g.ox * z) * dpr).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(Math.abs(c.top + g.oy * z) * dpr).toBeLessThanOrEqual(0.5 + 1e-9);
      // The size is the texture's and is not touched.
      expect(c.width).toBeCloseTo(g.cw * z, 9);
    }
  });
  it('and of the screen, when the page itself is not on one', () => {
    const page = { x: 120.25, y: 88.75 };
    for (const [z, dpr, at] of [[1.37, 2, { x: 975.37, y: 1210.61 }], [1, 1, { x: 45, y: 60 }], [2.2, 2, { x: 0, y: 0 }]]) {
      const c = css(pictureCss({ ...g, page }, z, dpr, at));
      const left = (page.x + at.x * z + c.left) * dpr;
      const top = (page.y + at.y * z + c.top) * dpr;
      expect(left).toBeCloseTo(Math.round(left), 6);
      expect(top).toBeCloseTo(Math.round(top), 6);
      expect(Math.abs(c.left + g.ox * z) * dpr).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });
});

describe('where the page is on the screen', () => {
  const frame = (left, top, border = 0) => ({ getBoundingClientRect: vi.fn(() => ({ left, top })), clientLeft: border, clientTop: border });

  it('is the corner of the frame inside its border', () => {
    expect(pageCorner(frame(120.25, 88.5, 1))).toEqual({ x: 121.25, y: 89.5 });
  });
  it('is asked of the layout once for all the boxes painted together', async () => {
    const el = frame(10.5, 20);
    for (let i = 0; i < 30; i++) pageCorner(el);
    expect(el.getBoundingClientRect).toHaveBeenCalledTimes(1);
    // And again the next time something is painted: the page may have moved.
    await Promise.resolve();
    pageCorner(el);
    expect(el.getBoundingClientRect).toHaveBeenCalledTimes(2);
  });
  it('each page is its own', () => {
    expect(pageCorner(frame(1, 2))).toEqual({ x: 1, y: 2 });
    expect(pageCorner(frame(3, 4))).toEqual({ x: 3, y: 4 });
  });
  it('is nothing for a frame that is not there yet', () => {
    expect(pageCorner(null)).toBe(null);
    expect(pageCorner(undefined)).toBe(null);
    expect(pageCorner({})).toBe(null);
  });
});
