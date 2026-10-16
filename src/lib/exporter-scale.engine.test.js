import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture, renderBox, textureScale } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// renderBoxTexture at a scale other than the export's 2
// ===========================================================================
// The editor paints a box at the scale it is shown at (zoom x the display's
// pixel ratio) through the function the export calls with no scale at all. So
// two things are pinned here, with the real engine painting:
//
//   - the default is the export's picture, byte for byte, and saying 2 out
//     loud is the same call;
//   - at any other scale the picture is the SAME picture at another
//     resolution: the footprint is the same page px, the ink lands on the same
//     page px, and every pass that is stated in page px (shadows, blur, smear,
//     roughening, mask) follows the scale rather than staying put in device
//     px. Checked by painting at 1 and at 3 and averaging the 3 down.
//
// The canvas is Skia's (@napi-rs/canvas), as in rust-painter.engine.test.js;
// the glyphs are the engine's, so nothing here depends on Skia's text.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
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

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, strokes: [], ...over });
const boxOf = (over = {}, text = 'SAME PICTURE\nAT ANY ZOOM') => ({ id: 'b', lineN: null, text, x: 100, y: 100, w: 260, h: 90, style: style(over) });
const pageOf = (box) => ({ id: 1, w: 800, h: 1200, lines: [], boxes: [box] });
const paint = (box, ...rest) => renderBoxTexture(box, pageOf(box), null, ...rest);
const pixels = (r) => r.canvas.getContext('2d').getImageData(0, 0, r.canvas.width, r.canvas.height);

// The box of pixels with any ink, in the picture's own px.
function inkBox(img) {
  const { width, height, data } = img;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 24) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

// A picture `k` times as large, averaged down to the small one's grid, in
// premultiplied terms (what a compositor would show), against the small one.
// Of 255, over the pixels either picture inked:
//
//   mean, worst   the alpha difference
//   colour        the premultiplied colour difference, the largest of the
//                 three channels per pixel: `{ mean, worst }`. Alpha alone
//                 cannot tell a gradient from a flat fill of the same shape.
//   solid         the same, over the pixels both pictures ink fully (alpha
//                 250 and up in the small one and in every pixel averaged
//                 into it), where there is no edge and the difference is the
//                 fill's alone: `{ mean, worst, n }`.
//   ink           the ratio of total ink.
function against(small, large, k) {
  const { width, height } = small;
  let sum = 0;
  let n = 0;
  let worst = 0;
  let inkSmall = 0;
  let inkLarge = 0;
  const colour = { sum: 0, worst: 0 };
  const solid = { sum: 0, worst: 0, n: 0 };
  const c = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let a = 0;
      let least = 255;
      c[0] = c[1] = c[2] = 0;
      for (let j = 0; j < k; j++) {
        for (let i = 0; i < k; i++) {
          const lx = x * k + i;
          const ly = y * k + j;
          if (lx < large.width && ly < large.height) {
            const p = (ly * large.width + lx) * 4;
            const al = large.data[p + 3];
            a += al;
            if (al < least) least = al;
            for (let q = 0; q < 3; q++) c[q] += (large.data[p + q] * al) / 255;
          } else least = 0;
        }
      }
      a /= k * k;
      const o = (y * width + x) * 4;
      const b = small.data[o + 3];
      inkSmall += b;
      inkLarge += a;
      if (a < 1 && b < 1) continue;
      const d = Math.abs(a - b);
      sum += d;
      n++;
      if (d > worst) worst = d;
      let dc = 0;
      for (let q = 0; q < 3; q++) dc = Math.max(dc, Math.abs(c[q] / (k * k) - (small.data[o + q] * b) / 255));
      colour.sum += dc;
      if (dc > colour.worst) colour.worst = dc;
      if (b >= 250 && least >= 250) {
        solid.sum += dc;
        solid.n++;
        if (dc > solid.worst) solid.worst = dc;
      }
    }
  }
  return {
    mean: n ? sum / n : 0,
    worst,
    ink: inkLarge / Math.max(1, inkSmall),
    colour: { mean: n ? colour.sum / n : 0, worst: colour.worst },
    solid: { mean: solid.n ? solid.sum / solid.n : 0, worst: solid.worst, n: solid.n },
  };
}

describe('the scale a texture is painted at', () => {
  it('is 2 unless said, and saying 2 is the same picture byte for byte', () => {
    const box = boxOf({ strokes: [{ color: '#ffffff', width: 3, opacity: 1 }], shadows: [{ x: 3, y: 3, blur: 4, color: '#000000', opacity: 0.6 }] });
    const a = paint(box);
    const b = paint(box, 2);
    const c = paint(box, 2, Infinity);
    expect(a.ss).toBe(2);
    expect([b.ss, c.ss]).toEqual([2, 2]);
    for (const r of [b, c]) {
      expect([r.ox, r.oy, r.cw, r.ch, r.canvas.width, r.canvas.height]).toEqual([a.ox, a.oy, a.cw, a.ch, a.canvas.width, a.canvas.height]);
      expect(Buffer.compare(Buffer.from(pixels(r).data.buffer), Buffer.from(pixels(a).data.buffer))).toBe(0);
    }
    // At 2 the footprint is whole page px and the canvas is twice it.
    expect(Number.isInteger(a.cw) && Number.isInteger(a.ch)).toBe(true);
    expect([a.canvas.width, a.canvas.height]).toEqual([a.cw * 2, a.ch * 2]);
  });

  it('sizes the canvas to the footprint at that scale, in whole pixels, and says what it spans', () => {
    const box = boxOf();
    const base = paint(box);
    for (const scale of [0.25, 0.5, 1, 1.37, 2.6, 3, 6]) {
      const r = paint(box, scale);
      expect(r.ss, `ss at ${scale}`).toBe(scale);
      expect(r.canvas.width, `width at ${scale}`).toBe(Math.ceil(base.cw * scale));
      expect(r.canvas.height, `height at ${scale}`).toBe(Math.ceil(base.ch * scale));
      // The box's own corner does not move with the scale, and the span the
      // caller places the bitmap by is the canvas, pixel for pixel.
      expect([r.ox, r.oy]).toEqual([base.ox, base.oy]);
      expect(r.cw).toBe(r.canvas.width / scale);
      expect(r.ch).toBe(r.canvas.height / scale);
      expect(r.cw - base.cw).toBeGreaterThanOrEqual(0);
      expect(r.cw - base.cw).toBeLessThan(1 / scale);
    }
  });

  it('puts the ink on the same page px at every scale', () => {
    const box = boxOf();
    const at1 = inkBox(pixels(paint(box, 1)));
    for (const scale of [0.5, 2, 3, 4.5]) {
      const b = inkBox(pixels(paint(box, scale)));
      // One device px of the coarser picture either way: the edge of the ink
      // is where antialiasing starts, not a whole-pixel fact.
      const slack = 1 / Math.min(1, scale) + 1 / scale;
      expect(Math.abs(b.x0 / scale - at1.x0), `left at ${scale}`).toBeLessThanOrEqual(slack);
      expect(Math.abs(b.y0 / scale - at1.y0), `top at ${scale}`).toBeLessThanOrEqual(slack);
      expect(Math.abs(b.x1 / scale - at1.x1), `right at ${scale}`).toBeLessThanOrEqual(slack);
      expect(Math.abs(b.y1 / scale - at1.y1), `bottom at ${scale}`).toBeLessThanOrEqual(slack);
    }
  });
});

describe('the longest side of one texture', () => {
  it('with no limit given the scale is what it was: every caller that names none computes what it computed', () => {
    for (const [cw, ch, scale, maxPx] of [[100, 50, 2], [7024, 108, 2], [30000, 40, 2], [1000, 500, 8, 2e6], [400, 300, 16, 8 * 1024 * 1024]]) {
      const before = (() => {
        const area = cw * ch * scale * scale;
        return maxPx !== undefined && area > maxPx ? scale * Math.sqrt(maxPx / area) : scale;
      })();
      expect(textureScale(cw, ch, scale, maxPx)).toBe(before);
      expect(textureScale(cw, ch, scale, maxPx, Infinity)).toBe(before);
    }
  });

  it('leaves a footprint whose sides are inside the limit alone', () => {
    expect(textureScale(1000, 500, 4, Infinity, 16384)).toBe(4);
    expect(textureScale(4096, 100, 4, Infinity, 16384)).toBe(4);
  });

  it('lowers the scale until the longer side fits, whichever side that is, and never a pixel over', () => {
    for (const [cw, ch, scale] of [[7024, 108, 3], [108, 7024, 3], [5461.4, 30, 3.0001], [16385, 10, 1], [9999.99, 7, 6.6], [8208, 68, 2]]) {
      const ss = textureScale(cw, ch, scale, Infinity, 16384);
      expect(ss).toBeLessThan(scale);
      // The canvas is cut to whole pixels outwards (`renderBoxTexture`).
      expect(Math.ceil(Math.max(cw, ch) * ss)).toBeLessThanOrEqual(16384);
      // And so is the painter's surface, from the transform the canvas gives
      // back - in single precision, under Skia.
      expect(Math.ceil(Math.max(cw, ch) * Math.fround(ss))).toBeLessThanOrEqual(16384);
      // To the limit and not far under it.
      expect(Math.max(cw, ch) * ss).toBeGreaterThan(16383);
    }
  });

  it('holds together with the area budget: both are met, by the lower of the two scales', () => {
    // Long and thin: the area budget alone leaves it 24,000 px wide.
    const byArea = textureScale(8000, 100, 6, 8 * 1024 * 1024);
    expect(8000 * byArea).toBeGreaterThan(16384);
    const both = textureScale(8000, 100, 6, 8 * 1024 * 1024, 16384);
    expect(Math.ceil(8000 * both)).toBeLessThanOrEqual(16384);
    // Squarer: the area budget is the one that binds, and the side limit adds nothing.
    expect(textureScale(1600, 2300, 6, 8 * 1024 * 1024, 16384)).toBe(textureScale(1600, 2300, 6, 8 * 1024 * 1024));
  });

  it('is applied by the painter: the same footprint in the same place, on a canvas inside the limit', () => {
    const box = boxOf();
    const full = paint(box, 6);
    const limit = Math.floor(full.canvas.width / 2);
    const r = renderBoxTexture(box, pageOf(box), null, 6, Infinity, limit);
    expect(r.canvas.width).toBeLessThanOrEqual(limit);
    expect(r.canvas.width).toBeGreaterThan(limit - 2);
    expect(r.ss).toBeLessThan(6);
    expect([r.ox, r.oy]).toEqual([full.ox, full.oy]);
    expect(r.cw).toBeCloseTo(full.cw, 0);
    expect(r.ch).toBeCloseTo(full.ch, 0);
  });
});

describe('the export paints within the painter\'s limits', () => {
  // The editor's picture is made inside the painter's longest side, so a box
  // it shows has to be one the file can have too: at the export's 2 this line
  // is 16,400 px long and the engine refuses it with a throw that stopped the
  // whole page.
  it('lowers the resolution of a box too long for the painter, and only of that box', () => {
    const long = { ...boxOf({}, 'SMALL TEXT'), w: 8200, h: 60 };
    const r = renderBox(long, pageOf(long), null);
    expect(r.canvas.width).toBeLessThanOrEqual(glyphPainter().maxSide);
    expect(r.cw).toBeGreaterThan(8200);
    const box = boxOf();
    const a = renderBox(box, pageOf(box), null);
    const b = paint(box);
    expect([a.canvas.width, a.canvas.height, a.ox, a.oy]).toEqual([b.canvas.width, b.canvas.height, b.ox, b.oy]);
    expect(Buffer.from(pixels(a).data).equals(Buffer.from(pixels(b).data))).toBe(true);
  });
});

describe('the pixel budget of one texture', () => {
  it('leaves the scale alone under the budget, and with none', () => {
    expect(textureScale(100, 50, 2)).toBe(2);
    expect(textureScale(100, 50, 2, Infinity)).toBe(2);
    expect(textureScale(100, 50, 2, 100 * 50 * 4)).toBe(2);
    expect(textureScale(100, 50, 3.3, 1e9)).toBe(3.3);
  });

  it('lowers the scale so the footprint holds the budget, keeping its shape', () => {
    const s = textureScale(1000, 500, 8, 2e6);
    expect(s).toBeCloseTo(2, 10);
    expect(1000 * s * 500 * s).toBeCloseTo(2e6, 3);
  });

  it('is applied by the painter: fewer pixels, the same footprint in the same place', () => {
    const box = boxOf();
    const full = paint(box, 6);
    const budget = 40000;
    const r = paint(box, 6, budget);
    expect(r.ss).toBeLessThan(6);
    expect(r.ss).toBeCloseTo(textureScale(full.cw === r.cw ? r.cw : Math.floor(r.cw), Math.floor(r.ch), 6, budget), 1);
    // Rounded up to whole pixels, so the budget is met to within one row and one column.
    expect(r.canvas.width * r.canvas.height).toBeLessThanOrEqual(budget + r.canvas.width + r.canvas.height);
    expect(r.canvas.width * r.canvas.height).toBeGreaterThan(budget * 0.9);
    expect([r.ox, r.oy]).toEqual([full.ox, full.oy]);
    expect(Math.abs(r.cw - full.cw)).toBeLessThan(1 / r.ss + 1 / 6);
    // And the picture is still the picture: ink where the full one has it.
    const a = inkBox(pixels(full));
    const b = inkBox(pixels(r));
    expect(Math.abs(b.x0 / r.ss - a.x0 / 6)).toBeLessThanOrEqual(2 / r.ss);
    expect(Math.abs(b.x1 / r.ss - a.x1 / 6)).toBeLessThanOrEqual(2 / r.ss);
  });

  it('is not applied to a box that is under it', () => {
    const box = boxOf();
    const r = paint(box, 3, 64e6);
    expect(r.ss).toBe(3);
  });
});

// One box per pass that is stated in page px. Each is painted at 1 and at 3,
// the 3 averaged down, and the two compared: `mean` and `worst` are alpha
// differences of 255 over inked pixels, `ink` is the ratio of total ink. A
// pass that stayed in device px would show here as a blur a third as wide, a
// shadow a third as far, or a crumple a third as deep.
const KINDS = {
  plain: {},
  bands: { strokes: [{ color: '#ffffff', width: 2, opacity: 1 }, { color: '#000000', width: 2, opacity: 1 }, { color: '#ff0000', width: 3, opacity: 0.5 }] },
  colour: { color: '#c02040' },
  gradient: { gradient: { on: true, kind: 'linear', angle: 90, scope: 'line', stops: [{ color: '#ff0000', pos: 0, opacity: 1 }, { color: '#0000ff', pos: 1, opacity: 1 }] } },
  'gradient, box': { gradient: { on: true, kind: 'linear', angle: 0, scope: 'box', stops: [{ color: '#ff0000', pos: 0, opacity: 1 }, { color: '#0000ff', pos: 1, opacity: 1 }] } },
  'gradient, radial': { gradient: { on: true, kind: 'radial', cx: 0.5, cy: 0.5, radius: 1, scope: 'box', stops: [{ color: '#ffd000', pos: 0, opacity: 1 }, { color: '#c00030', pos: 1, opacity: 1 }] } },
  pattern: { pattern: { on: true, kind: 'dots', fg: '#000000', bg: '#ffcc00', scale: 1 } },
  shadow: { shadows: [{ x: 6, y: 5, blur: 0, color: '#000000', opacity: 1 }] },
  'shadow, blurred': { shadows: [{ x: 6, y: 5, blur: 6, color: '#000000', opacity: 0.8 }] },
  blur: { blur: 3 },
  smear: { motionBlur: { on: true, x: 2, y: 0, amount: 6 } },
  roughen: { roughen: { on: true, amount: 6, detail: 0.05, seed: 7 } },
  'mask, include': { clip: { on: true, mode: 'include', brushSize: 20, shapes: [{ kind: 'ellipse', cx: 130, cy: 45, rx: 70, ry: 30 }] } },
  'mask, exclude': { clip: { on: true, mode: 'exclude', brushSize: 20, shapes: [{ kind: 'ellipse', cx: 130, cy: 45, rx: 40, ry: 20 }] } },
  arc: { curve: 40 },
  circle: { circle: { on: true, angle: 0, inside: false, r: 0 } },
};

// What `mean` may be. Sharp edges read under 1 now that the painter copies the
// engine's pixels unfiltered (they sat near 8 while that copy was smoothed).
// The passes that soften have limits set where leaving the scale out of the
// pass fails: unscaled, the blur read 27, the smear 13 and a blurred shadow 20
// against the 3, 2 and 2 they read scaled (measured by breaking each in turn,
// the unscaled figures on the smoothed copy). The roughening is high either
// way because its displacement is rounded to whole device px, which at 1 is a
// whole page px and at 3 a third of one: it reads 37 scaled and 79 unscaled
// on unfiltered pixels (27 and 39 on the smoothed copy, whose soft edges hid
// both the difference and the defect).
const LIMIT = { blur: 6, smear: 6, 'shadow, blurred': 8, roughen: 48 };

// What the COLOUR may differ by: `mean` over inked pixels in premultiplied
// terms, and `solid` / `solidWorst` over the pixels with no edge in them. The
// alpha comparison above cannot see a fill: an opaque gradient and an opaque
// flat colour are the same alpha. Set from what was measured (the figures in
// brackets, of 255):
//
//   a flat colour   [0.42 mean, 0.01 solid, solid worst 0]: one colour at
//                   any scale, and the mean is its edges' antialiasing.
//   gradients       [0.44-0.57 mean, 0.19-0.33 solid, solid worst 1]: a ramp
//                   sampled at a pixel's centre against the same ramp
//                   averaged over nine.
//   pattern         [2.03 mean, 1.06 solid, solid worst 7]: a dot's edge is
//                   antialiased on two different grids.
//   bands           [0.45 mean, 0.36 solid]: three outlines, and where two
//                   meet inside a fully inked pixel the colour steps (worst
//                   65), so only the means are held.
//
// A fill that did not follow the scale - a gradient left in device px, a
// pattern tile not scaled - reads tens, as the last two cases show with a
// flat fill standing in for it.
const COLOUR_LIMIT = {
  gradient: { mean: 1.5, solid: 1, solidWorst: 3 },
  'gradient, box': { mean: 1.5, solid: 1, solidWorst: 3 },
  'gradient, radial': { mean: 1.5, solid: 1, solidWorst: 3 },
  pattern: { mean: 4, solid: 2.5, solidWorst: 16 },
  bands: { mean: 1.5, solid: 1.2, solidWorst: Infinity },
};
const COLOUR_PLAIN = { mean: 1, solid: 0.5, solidWorst: 2 };

describe('the same picture at another resolution', () => {
  const rows = {};
  for (const [name, over] of Object.entries(KINDS)) {
    it(`${name}: the picture at 3, averaged down, is the picture at 1`, () => {
      const box = boxOf(over, name === 'circle' ? 'ROUND AND ROUND IT GOES ' : undefined);
      const one = paint(box, 1);
      const three = paint(box, 3);
      const m = against(pixels(one), pixels(three), 3);
      rows[name] = m;
      // The ink is the same ink: its total within a few percent.
      expect(m.ink, `${name} ink ratio`).toBeGreaterThan(0.93);
      expect(m.ink, `${name} ink ratio`).toBeLessThan(1.07);
      // And it is in the same place: an edge that moved by a page px would put
      // a full 255 on every edge pixel, and the mean over inked pixels well
      // past this.
      expect(m.mean, `${name} mean alpha difference`).toBeLessThan(LIMIT[name] ?? 14);
      // And it is the same colour, not only the same shape.
      const lim = COLOUR_LIMIT[name] ?? COLOUR_PLAIN;
      expect(m.colour.mean, `${name} mean colour difference`).toBeLessThan(lim.mean);
      expect(m.solid.mean, `${name} mean colour difference where fully inked`).toBeLessThan(lim.solid);
      expect(m.solid.worst, `${name} worst colour difference where fully inked`).toBeLessThanOrEqual(lim.solidWorst);
    });
  }

  // The comparison has to be able to fail. Alpha alone could not tell these
  // apart: the outside review's case, an opaque fill swapped for a flat one.
  for (const name of ['gradient', 'gradient, box', 'gradient, radial', 'pattern']) {
    it(`${name}: a flat fill of the same shape is told apart by its colour, and not by its alpha`, () => {
      const flat = boxOf({ color: name === 'pattern' ? '#ffcc00' : '#ff0000' });
      const m = against(pixels(paint(boxOf(KINDS[name]), 1)), pixels(paint(flat, 3)), 3);
      expect(m.mean).toBeLessThan(LIMIT[name] ?? 14);
      expect(m.ink).toBeGreaterThan(0.93);
      expect(m.ink).toBeLessThan(1.07);
      const lim = COLOUR_LIMIT[name];
      expect(m.colour.mean).toBeGreaterThan(lim.mean * 5);
      expect(m.solid.mean).toBeGreaterThan(lim.solid * 5);
    });
  }
  it('prints what was measured', () => {
    console.log(
      'renderBoxTexture at 3, averaged down, against 1 (of 255; alpha and premultiplied colour over inked px, colour again over solid px):\n' +
        Object.entries(rows).map(([k, m]) => `  ${k.padEnd(16)} alpha mean ${m.mean.toFixed(2).padStart(6)} worst ${m.worst.toFixed(0).padStart(4)}  ink x${m.ink.toFixed(3)}  colour mean ${m.colour.mean.toFixed(2).padStart(6)} worst ${m.colour.worst.toFixed(0).padStart(4)}  solid mean ${m.solid.mean.toFixed(2).padStart(5)} worst ${m.solid.worst.toFixed(0).padStart(3)} (${m.solid.n} px)`).join('\n'),
    );
  });

  // The direct statement of "follows the scale" for the two passes that have a
  // length: how far the picture reaches past the unfiltered one, in page px,
  // has to be the same reach at 1 and at 4.
  it('a shadow is thrown the same page px, and a blur spreads the same page px, at 1 and at 4', () => {
    const reach = (over, scale) => {
      const plain = inkBox(pixels(paint(boxOf(), scale)));
      const with_ = inkBox(pixels(paint(boxOf(over), scale)));
      return { right: (with_.x1 - plain.x1) / scale, bottom: (with_.y1 - plain.y1) / scale, left: (plain.x0 - with_.x0) / scale };
    };
    // Not the smear: its tail is a staircase of faint taps a few px apart, so
    // where it crosses any one alpha is a step's width of luck. The averaged
    // comparison above is its check.
    for (const over of [{ shadows: [{ x: 9, y: 7, blur: 0, color: '#000000', opacity: 1 }] }, { blur: 4 }]) {
      const a = reach(over, 1);
      const b = reach(over, 4);
      expect(Math.abs(a.right - b.right), JSON.stringify(over)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(a.bottom - b.bottom), JSON.stringify(over)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(a.left - b.left), JSON.stringify(over)).toBeLessThanOrEqual(1.5);
    }
    // And it is a real reach, not zero both times.
    expect(reach({ shadows: [{ x: 9, y: 7, blur: 0, color: '#000000', opacity: 1 }] }, 4).right).toBeGreaterThan(7);
    expect(reach({ blur: 4 }, 4).right).toBeGreaterThan(3);
  });
});
