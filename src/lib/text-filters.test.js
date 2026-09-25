import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyTextFilters, textFiltersActive, motionBlurTaps } from './text-paint.js';
import { defaultStyle, normalizeStyle } from './data.js';

// `applyTextFilters` is the one chain both renderers run: the exporter over a
// box's composite at its supersample, the editor over the ink canvas at the
// zoom. What is pinned here is what makes those one picture - the order, the
// units, where the grain starts - and that the chain hands back every canvas
// it made on the way, since the editor runs it per box.
//
// The canvas is a stub that records its draws and keeps real RGBA bytes for
// the roughening's ImageData round trip, which is the pass that has pixels.

let made;
const realDocument = globalThis.document;

function canvasOf(w = 0, h = 0) {
  const c = { width: w, height: h, draws: [], puts: 0, px: null };
  c.getContext = () => ({
    filter: 'none',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    drawImage(src, x, y) {
      c.draws.push({ src, x, y, filter: this.filter, alpha: this.globalAlpha, op: this.globalCompositeOperation });
    },
    getImageData(_x, _y, iw, ih) {
      return { width: iw, height: ih, data: (c.px ?? new Uint8ClampedArray(iw * ih * 4)).slice() };
    },
    createImageData(iw, ih) {
      return { width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) };
    },
    putImageData(img) {
      c.px = img.data;
      c.puts++;
    },
  });
  return c;
}

beforeEach(() => {
  made = [];
  globalThis.document = {
    createElement: () => {
      const c = canvasOf();
      made.push(c);
      return c;
    },
  };
});
afterEach(() => {
  globalThis.document = realDocument;
});

const rough = { on: true, amount: 6, detail: 0.05, seed: 3 };

describe('applyTextFilters: one chain for the export and the editor', () => {
  it('blurs, then smears, then roughens, in page px applied at the raster scale', () => {
    const ss = 1.5;
    const mb = { on: true, x: 2, y: -1, amount: 2 };
    const cnv = canvasOf(90, 60);
    const out = applyTextFilters(cnv, { blur: 3, motionBlur: mb, roughen: rough }, ss);

    expect(made).toHaveLength(2);
    const [blurred, acc] = made;
    expect(out).toBe(acc);
    // The blur is the first pass, over the input, with the sigma in device px.
    expect(blurred.draws).toEqual([{ src: cnv, x: 0, y: 0, filter: 'blur(4.5px)', alpha: 1, op: 'source-over' }]);
    // The smear is the exporter's full tap list, over the blurred picture,
    // summed at each tap's weight with its offset in device px.
    const taps = motionBlurTaps(mb.x, mb.y, mb.amount);
    expect(acc.draws.map((d) => d.src)).toEqual(taps.map(() => blurred));
    expect(acc.draws.map((d) => [d.x, d.y, d.alpha, d.op])).toEqual(
      taps.map((t) => [t.dx * ss, t.dy * ss, t.w, 'lighter']),
    );
    // The crumple last, over the smeared picture.
    expect(acc.puts).toBe(1);
    expect(blurred.puts).toBe(0);
  });

  it('hands back every canvas it superseded, and never the one it was given', () => {
    const cnv = canvasOf(40, 30);
    const out = applyTextFilters(cnv, { blur: 2, motionBlur: { on: true, x: 1, y: 0, amount: 1 }, roughen: { on: false } }, 1);
    expect(made[0].width).toBe(0);
    expect(made[0].height).toBe(0);
    expect(out.width).toBe(40);
    expect(cnv.width).toBe(40);
  });

  it('roughens in place when that is the only filter, and does nothing when none is on', () => {
    const cnv = canvasOf(20, 20);
    expect(applyTextFilters(cnv, { blur: 0, motionBlur: { on: false }, roughen: rough }, 2)).toBe(cnv);
    expect(cnv.puts).toBe(1);
    expect(made).toHaveLength(0);

    const plain = normalizeStyle(defaultStyle());
    expect(textFiltersActive(plain)).toBe(false);
    const bare = canvasOf(20, 20);
    expect(applyTextFilters(bare, plain, 2)).toBe(bare);
    expect(bare.puts + bare.draws.length + made.length).toBe(0);
    expect(textFiltersActive({ ...plain, blur: 1 })).toBe(true);
    expect(textFiltersActive({ ...plain, motionBlur: { on: true, x: 1, y: 0, amount: 1 } })).toBe(true);
    expect(textFiltersActive({ ...plain, motionBlur: { on: true, x: 0, y: 0, amount: 4 } })).toBe(false);
    expect(textFiltersActive({ ...plain, roughen: rough })).toBe(true);
  });

  // The export roughens the ink inside the box's footprint; the editor
  // roughens it on its own canvas, which starts somewhere else. With the noise
  // origin moved by exactly the same offset, the same ink comes out with the
  // same grain - the parity the ink canvas's origin is computed for.
  it('gives the same ink the same grain on a canvas that starts somewhere else', () => {
    const ss = 2;
    const blockOf = (w, h, x0, y0) => {
      const c = canvasOf(w, h);
      c.px = new Uint8ClampedArray(w * h * 4);
      for (let y = y0; y < y0 + 12; y++) {
        for (let x = x0; x < x0 + 16; x++) {
          const i = (y * w + x) * 4;
          c.px[i] = 20;
          c.px[i + 1] = 40;
          c.px[i + 2] = 60;
          c.px[i + 3] = 255;
        }
      }
      return c;
    };
    const s = { blur: 0, motionBlur: { on: false }, roughen: { on: true, amount: 8, detail: 0.07, seed: 5 } };
    // The export's raster, with the noise origin at page (3, 4).
    const a = blockOf(48, 44, 14, 12);
    applyTextFilters(a, s, ss, { x: 3, y: 4 });
    // The editor's, with the same ink 8 x 6 device px further in - 4 x 3 page px.
    const b = blockOf(64, 56, 22, 18);
    applyTextFilters(b, s, ss, { x: 3 + 4, y: 4 + 3 });

    let inked = 0;
    let differ = 0;
    for (let y = 0; y < 44; y++) {
      for (let x = 0; x < 48; x++) {
        const ia = (y * 48 + x) * 4;
        const ib = ((y + 6) * 64 + (x + 8)) * 4;
        if (a.px[ia + 3]) inked++;
        for (let k = 0; k < 4; k++) if (a.px[ia + k] !== b.px[ib + k]) differ++;
      }
    }
    // The crumple actually moved something, and moved it the same on both.
    expect(inked).toBeGreaterThan(0);
    let moved = 0;
    for (let i = 0; i < a.px.length; i += 4) {
      const x = (i / 4) % 48;
      const y = Math.floor(i / 4 / 48);
      const inBlock = x >= 14 && x < 30 && y >= 12 && y < 24;
      if (!!a.px[i + 3] !== inBlock) moved++;
    }
    expect(moved).toBeGreaterThan(0);
    expect(differ).toBe(0);
  });
});
