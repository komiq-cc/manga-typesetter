import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { rustEngine, FIXTURE_FACES } from '../../test/rust-engine.js';
import { createRustGlyphPainter } from './rust-painter.js';
import { createBrowserGlyphPainter } from './browser-painter.js';

// The painter makes its scratch canvas, and text-paint.js its pattern tiles,
// from `document`; the engine lane has none, so it gets Skia's for this file.
const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
let made = 0;
let rust;
beforeAll(async () => {
  globalThis.document = {
    createElement() {
      made++;
      return createCanvas(300, 150);
    },
  };
  for (const [family, , file] of FIXTURE_FACES) {
    GlobalFonts.registerFromPath(fileURLToPath(new URL(`../../test/fonts/${file}`, import.meta.url)), family);
  }
  rust = await rustEngine();
});
afterAll(() => {
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

const face = (name, size, bold = false) => ({
  key: `${bold ? 'bold ' : ''}${size}px "${name}"`, name, bold, italic: false, size, css: `"${name}"`,
});
const job = (over = {}) => ({
  face: face('Comic Neue', 40),
  curved: false,
  align: 'left',
  letterSpacing: 0,
  bands: [],
  silhouette: null,
  fill: { kind: 'solid', color: '#102030' },
  runs: [{ text: 'WAIT', x: 20, y: 60 }],
  ...over,
});

// Where a canvas has ink: the box of pixels with any alpha, and one pixel's colour.
function ink(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1, solid = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (a === 255 && !solid) solid = [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, solid };
}

function drawn(painter, j, { scale = 2, width = 400, height = 200, prepare } = {}) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  prepare?.(ctx);
  painter.paint(ctx, j);
  return { canvas, ctx };
}

describe('the Rust engine behind the glyph-painter seam', () => {
  it('puts the ink where the canvas painter puts it, through the canvas transform', () => {
    const a = ink(drawn(createBrowserGlyphPainter(), job()).canvas);
    const b = ink(drawn(createRustGlyphPainter(rust), job()).canvas);
    for (const k of ['x0', 'y0', 'x1', 'y1']) expect(Math.abs(a[k] - b[k]), k).toBeLessThanOrEqual(1);
    expect(b.solid).toEqual([0x10, 0x20, 0x30]);
    // Twice the scale, twice the box: the engine drew at the device scale, it was not stretched.
    const big = ink(drawn(createRustGlyphPainter(rust), job(), { scale: 4, width: 800, height: 400 }).canvas);
    expect(Math.abs(big.x1 - big.x0 - 2 * (b.x1 - b.x0))).toBeLessThanOrEqual(2);
  });

  it('leaves the canvas as it found it and draws nothing for a job without ink', () => {
    const painter = createRustGlyphPainter(rust);
    const { canvas, ctx } = drawn(painter, job({ runs: [{ text: '   ', x: 20, y: 60 }] }));
    expect(ink(canvas)).toBe(null);
    const { ctx: after } = drawn(painter, job(), { prepare: (c) => c.translate(7, 3) });
    const m = after.getTransform();
    expect([m.a, m.d, m.e, m.f]).toEqual([2, 2, 14, 6]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("honours the canvas's own alpha and clip, as drawn text would", () => {
    const painter = createRustGlyphPainter(rust);
    const { canvas } = drawn(painter, job(), {
      prepare: (c) => {
        c.beginPath();
        c.rect(0, 0, 60, 100);
        c.clip();
        c.globalAlpha = 0.5;
      },
    });
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let most = 0, right = -1;
    for (let i = 3; i < data.length; i += 4) {
      if (!data[i]) continue;
      most = Math.max(most, data[i]);
      right = Math.max(right, ((i - 3) / 4) % canvas.width);
    }
    expect(most).toBeGreaterThan(120);
    expect(most).toBeLessThanOrEqual(128);
    expect(right).toBeLessThan(120);
    expect(right).toBeGreaterThan(100);
  });

  it('reuses one scratch canvas, and one drawing of a pattern tile for every line and job', () => {
    const painter = createRustGlyphPainter(rust);
    const style = { size: 40, color: '#000000', pattern: { kind: 'checker', fg: '#ff0000', bg: '#0000ff', scale: 1 } };
    const fill = { kind: 'pattern', style, px: 12, ax: 0, ay: 0 };
    const lines = job({ fill: null, runs: [{ text: 'WAIT', x: 20, y: 40, fill }, { text: 'WHAT', x: 20, y: 85, fill }] });
    made = 0;
    const first = drawn(painter, lines).canvas;
    drawn(painter, lines);
    // The scratch and the tile, once each.
    expect(made).toBe(2);
    const data = first.getContext('2d').getImageData(0, 0, first.width, first.height).data;
    let red = 0, blue = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 255) continue;
      if (data[i] > 200 && data[i + 2] < 50) red++;
      if (data[i + 2] > 200 && data[i] < 50) blue++;
    }
    expect(red).toBeGreaterThan(200);
    expect(blue).toBeGreaterThan(200);
  });

  it('lands pixel for pixel on a canvas that smooths, with nothing of an earlier job beside it', () => {
    // The exporter's canvases set the smoothing quality to high. A wide job
    // with a band first, so the kept scratch holds ink to the right of where
    // the narrow job's raster ends.
    const wide = job({ bands: [{ color: '#ffffff', opacity: 1, line: 6 }], runs: [{ text: 'WAIT WHAT', x: 20, y: 60 }] });
    const narrow = job({ runs: [{ text: 'WAIT', x: 20, y: 60 }] });
    const pixels = (painter, prepare) => {
      const { canvas } = drawn(painter, narrow, { prepare });
      return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const used = createRustGlyphPainter(rust);
    drawn(used, wide);
    const smoothed = pixels(used, (c) => {
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'high';
    });
    const plain = pixels(createRustGlyphPainter(rust), (c) => {
      c.imageSmoothingEnabled = false;
    });
    let differing = 0;
    for (let i = 0; i < plain.length; i++) if (plain[i] !== smoothed[i]) differing++;
    expect(differing).toBe(0);
  });

  it('draws a synthesised bold the way the engine measured it', () => {
    const bold = job({ face: face('Bangers', 40, true), runs: [{ text: 'IIII', x: 20, y: 60 }] });
    const width = (c) => {
      const b = ink(c);
      return b.x1 - b.x0;
    };
    const outset = width(drawn(createRustGlyphPainter(rust), bold).canvas);
    rust.setRules({ boldAdvance: 'webkit' });
    try {
      const smear = width(drawn(createRustGlyphPainter(rust), bold).canvas);
      const forced = width(drawn(createRustGlyphPainter(rust, { boldDraw: 'outset' }), bold).canvas);
      // Three more advances of 40/36 px, at 2x, whichever way the bold is drawn.
      expect(smear - outset).toBeGreaterThanOrEqual(5);
      expect(smear - outset).toBeLessThanOrEqual(8);
      expect(forced).not.toBe(smear);
    } finally {
      rust.setRules({ boldAdvance: 'unchanged' });
    }
  });

  it('measures the ink of a synthesised bold for the drawing the rule gives it', () => {
    const bold = job({ face: face('Bangers', 40, true), align: 'left', runs: [{ text: 'IIII', x: 20, y: 60 }] });
    for (const boldAdvance of ['unchanged', 'webkit']) {
      rust.setRules({ boldAdvance });
      try {
        const m = rust.lineInk(bold.face, 'IIII');
        const b = ink(drawn(createRustGlyphPainter(rust), bold).canvas);
        // At 2x: the painted box is the measured one, to a device pixel.
        expect(Math.abs(b.x0 - 2 * (20 - m.left)), `${boldAdvance} left`).toBeLessThanOrEqual(1);
        expect(Math.abs(b.x1 + 1 - 2 * (20 + m.right)), `${boldAdvance} right`).toBeLessThanOrEqual(1);
        expect(Math.abs(b.y0 - 2 * (60 - m.ascent)), `${boldAdvance} top`).toBeLessThanOrEqual(1);
        expect(Math.abs(b.y1 + 1 - 2 * (60 + m.descent)), `${boldAdvance} bottom`).toBeLessThanOrEqual(1);
      } finally {
        rust.setRules({ boldAdvance: 'unchanged' });
      }
    }
  });

  it('paints heavier by the weight it is made with, and not at all heavier without one', () => {
    const plain = ink(drawn(createRustGlyphPainter(rust), job()).canvas);
    const zero = ink(drawn(createRustGlyphPainter(rust, { weight: 0 }), job()).canvas);
    const heavy = ink(drawn(createRustGlyphPainter(rust, { weight: 2 }), job()).canvas);
    expect(zero).toEqual(plain);
    // Two device pixels on every side.
    expect([plain.x0 - heavy.x0, plain.y0 - heavy.y0, heavy.x1 - plain.x1, heavy.y1 - plain.y1]).toEqual([2, 2, 2, 2]);
  });

  it('is refused a job buffer no job could need, and paints the next job', () => {
    expect(rust.low.exports.mt_paint_job_reserve(0xffffffff)).toBe(0);
    expect(ink(drawn(createRustGlyphPainter(rust), job()).canvas)).not.toBe(null);
  });

  it('refuses a job whose font the engine does not have', () => {
    expect(() => drawn(createRustGlyphPainter(rust), job({ face: face('Nobody Sans', 40) }))).toThrow(/not registered/);
  });
});
