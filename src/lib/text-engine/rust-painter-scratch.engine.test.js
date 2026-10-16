import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../../test/rust-engine.js';
import { createRustGlyphPainter } from './rust-painter.js';

// ===========================================================================
// What the Rust painter holds between two paints: nothing
// ===========================================================================
// The painter copies each raster the engine hands back through a canvas of
// the raster's own and gives it back once drawn. A canvas kept from paint to
// paint is what broke exports in the system WebKit: there a `drawImage` from
// a canvas can be played after the next `putImageData` into it, and the box
// drawn first showed the next box's letters (rust-painter.js, `blit`). Every
// canvas the painter asks the document for is a double that records the size
// it was given and what was done to it, so "still holding" and "written after
// it was drawn from" are read off the record.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
let made = [];
function recorded() {
  const c = createCanvas(300, 150);
  const rec = { c, w: 300, h: 150, took: [[300, 150]], ops: [] };
  const ctx = c.getContext('2d');
  const put = ctx.putImageData.bind(ctx);
  ctx.putImageData = (...a) => {
    rec.ops.push(rec.w * rec.h > 0 ? 'put' : 'put into a released canvas');
    return put(...a);
  };
  for (const side of ['width', 'height']) {
    const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c), side);
    Object.defineProperty(c, side, {
      configurable: true,
      get: () => own.get.call(c),
      set: (v) => {
        rec[side === 'width' ? 'w' : 'h'] = v;
        rec.took.push([rec.w, rec.h]);
        if (rec.w * rec.h === 0 && rec.ops.at(-1) !== 'released') rec.ops.push('released');
        own.set.call(c, v);
      },
    });
  }
  made.push(rec);
  return c;
}
const held = () => made.filter((r) => r.w * r.h > 0);
const heldPx = () => held().reduce((n, r) => n + r.w * r.h, 0);

let rust;
beforeAll(async () => {
  globalThis.document = { createElement: () => recorded() };
  rust = await rustEngine();
});
afterAll(() => {
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});
beforeEach(() => {
  made = [];
});

const face = (size) => ({ key: `${size}px "Comic Neue"`, name: 'Comic Neue', bold: false, italic: false, size, css: '"Comic Neue"' });
const job = (runs, size = 12) => ({
  face: face(size),
  curved: false,
  align: 'left',
  letterSpacing: 0,
  bands: [],
  silhouette: null,
  fill: { kind: 'solid', color: '#000000' },
  runs,
});
// A destination nobody counts: only the painter's own canvases are recorded,
// and each draw from one of them onto it.
function target(scale) {
  const ctx = createCanvas(64, 64).getContext('2d');
  const draw = ctx.drawImage.bind(ctx);
  ctx.drawImage = (src, ...a) => {
    made.find((r) => r.c === src)?.ops.push('drawn');
    return draw(src, ...a);
  };
  ctx.scale(scale, scale);
  return ctx;
}
// The outside review's two jobs, at zoom 300% on a 2x display (6 device px to
// the page px), size 12: 140 W on one line, then 80 lines of WWW.
const WIDE = job([{ text: 'W'.repeat(140), x: 2, y: 14 }]);
const TALL = job(Array.from({ length: 80 }, (_, i) => ({ text: 'WWW', x: 2, y: 14 + i * 13 })));
const SMALL = job([{ text: 'W', x: 2, y: 14 }]);

describe('the canvases the Rust painter makes', () => {
  for (const [name, jobs] of [
    ['one raster', [SMALL]],
    ['tall then wide', [TALL, WIDE]],
    ['wide then tall', [WIDE, TALL]],
    ['back and forth, with small ones between', [TALL, SMALL, WIDE, SMALL, TALL, WIDE, TALL]],
  ]) {
    it(`each is written once, drawn from once, then given back: ${name}`, () => {
      const painter = createRustGlyphPainter(rust);
      const ctx = target(6);
      for (const j of jobs) painter.paint(ctx, j);
      // One canvas per raster, none kept.
      expect(made).toHaveLength(jobs.length);
      expect(heldPx()).toBe(0);
      // Nothing written into a canvas a draw was already made from.
      for (const r of made) expect(r.ops).toEqual(['put', 'drawn', 'released']);
    });
  }

  it('the whole box in one job goes the same way', () => {
    const painter = createRustGlyphPainter(rust);
    expect(painter.paintBox).toBeTypeOf('function');
    const ctx = target(2);
    for (const j of [SMALL, WIDE, SMALL]) {
      painter.paintBox(ctx, { job: j, rect: { x: 0, y: 0, w: 2000, h: 40 }, shadows: [], blur: 0, taps: [], clip: null });
    }
    expect(made).toHaveLength(3);
    expect(heldPx()).toBe(0);
    for (const r of made) expect(r.ops).toEqual(['put', 'drawn', 'released']);
  });

  it('no canvas is ever much more than its raster', () => {
    const painter = createRustGlyphPainter(rust);
    const ctx = target(6);
    for (const j of [TALL, WIDE, TALL]) painter.paint(ctx, j);
    for (const r of made) {
      const [w, h] = r.took.at(-3);
      // The size it was given, by way of the default 300 x 150 it was made at.
      const most = r.took.reduce((m, t) => Math.max(m, t[0] * t[1]), 0);
      expect(most).toBeLessThanOrEqual(Math.max(w * h, w * 150, 300 * h, 300 * 150));
    }
  });

  it('what lands on the destination is the same whatever was painted before', () => {
    const paintTo = (painter, j) => {
      const c = createCanvas(700, 260);
      const ctx = c.getContext('2d');
      ctx.scale(2, 2);
      painter.paint(ctx, j);
      return c.getContext('2d').getImageData(0, 0, 700, 260).data;
    };
    const j = job([{ text: 'WAIT', x: 10, y: 60 }, { text: 'FOR ME', x: 10, y: 110 }], 40);
    const fresh = paintTo(createRustGlyphPainter(rust), j);
    const used = createRustGlyphPainter(rust);
    used.paint(target(6), WIDE);
    used.paint(target(6), TALL);
    const after = paintTo(used, j);
    let unlike = 0;
    let ink = 0;
    for (let i = 0; i < fresh.length; i++) {
      if (fresh[i] !== after[i]) unlike++;
      if (i % 4 === 3 && fresh[i]) ink++;
    }
    expect(ink).toBeGreaterThan(1000);
    expect(unlike).toBe(0);
  });
});
