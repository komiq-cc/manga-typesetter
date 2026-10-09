import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../../test/rust-engine.js';
import { createRustGlyphPainter, SCRATCH_KEEP_PX } from './rust-painter.js';

// ===========================================================================
// What the Rust painter holds between two paints
// ===========================================================================
// The painter copies each raster the engine hands back through one scratch
// canvas, kept from paint to paint. What it keeps is what this file is about:
// every canvas the painter asks the document for is a double that records the
// size it was given, so "still holding" is read off the record and not off a
// canvas that reports a released size as something else.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
let made = [];
function recorded() {
  const c = createCanvas(300, 150);
  const rec = { c, w: 300, h: 150 };
  for (const side of ['width', 'height']) {
    const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c), side);
    Object.defineProperty(c, side, {
      configurable: true,
      get: () => own.get.call(c),
      set: (v) => {
        rec[side === 'width' ? 'w' : 'h'] = v;
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
// A destination nobody counts: only the painter's own canvases are recorded.
function target(scale) {
  const ctx = createCanvas(64, 64).getContext('2d');
  ctx.scale(scale, scale);
  return ctx;
}
// The outside review's two jobs, at zoom 300% on a 2x display (6 device px to
// the page px), size 12: 140 W on one line, then 80 lines of WWW.
const WIDE = job([{ text: 'W'.repeat(140), x: 2, y: 14 }]);
const TALL = job(Array.from({ length: 80 }, (_, i) => ({ text: 'WWW', x: 2, y: 14 + i * 13 })));
const SMALL = job([{ text: 'W', x: 2, y: 14 }]);

describe('the scratch canvas the Rust painter keeps', () => {
  it('each of the two rasters is small enough to keep, and wide or tall enough to matter', () => {
    const seen = [];
    for (const j of [WIDE, TALL]) {
      made = [];
      createRustGlyphPainter(rust).paint(target(6), j);
      seen.push([made[0].w, made[0].h]);
    }
    const [[ww, wh], [tw, th]] = seen;
    expect(ww * wh).toBeLessThanOrEqual(SCRATCH_KEEP_PX);
    expect(tw * th).toBeLessThanOrEqual(SCRATCH_KEEP_PX);
    // Raised side by side they are the review's 200 MB and more.
    expect(ww * th).toBeGreaterThan(SCRATCH_KEEP_PX * 10);
  });

  it('a very wide raster and then a very tall one leave a scratch within the bound', () => {
    const painter = createRustGlyphPainter(rust);
    const ctx = target(6);
    painter.paint(ctx, WIDE);
    expect(heldPx()).toBeLessThanOrEqual(SCRATCH_KEEP_PX);
    painter.paint(ctx, TALL);
    expect(held().length).toBeLessThanOrEqual(1);
    expect(heldPx()).toBeLessThanOrEqual(SCRATCH_KEEP_PX);
    // And a small one afterwards does not bring anything back.
    painter.paint(ctx, SMALL);
    expect(held().length).toBeLessThanOrEqual(1);
    expect(heldPx()).toBeLessThanOrEqual(SCRATCH_KEEP_PX);
  });

  it('in the other order too', () => {
    const painter = createRustGlyphPainter(rust);
    const ctx = target(6);
    painter.paint(ctx, TALL);
    painter.paint(ctx, WIDE);
    expect(held().length).toBeLessThanOrEqual(1);
    expect(heldPx()).toBeLessThanOrEqual(SCRATCH_KEEP_PX);
  });

  it('is one canvas for a run of ordinary rasters: nothing is made per paint', () => {
    const painter = createRustGlyphPainter(rust);
    const ctx = target(6);
    for (let i = 0; i < 20; i++) painter.paint(ctx, job([{ text: 'WAIT FOR ME', x: 2, y: 30 }], 20 + i));
    expect(made).toHaveLength(1);
  });

  it('stays useful after one very wide raster: ordinary rasters are not each given a canvas of their own', () => {
    const painter = createRustGlyphPainter(rust);
    const ctx = target(6);
    painter.paint(ctx, WIDE);
    // A balloon's worth of lines, taller than the wide line's scratch can
    // grow to inside the bound.
    const balloon = job(Array.from({ length: 6 }, (_, i) => ({ text: 'WAIT FOR ME', x: 2, y: 30 + i * 32 })), 30);
    for (let i = 0; i < 20; i++) painter.paint(ctx, balloon);
    expect(made.length).toBeLessThanOrEqual(2);
    expect(heldPx()).toBeLessThanOrEqual(SCRATCH_KEEP_PX);
  });

  it('a raster over the bound by itself is copied through a canvas that is given back', () => {
    const painter = createRustGlyphPainter(rust);
    // 60 W at size 40, 6 device px to the page px: about 14,000 x 300.
    painter.paint(target(6), job([{ text: 'W'.repeat(60), x: 2, y: 60 }, { text: 'W', x: 2, y: 260 }], 40));
    expect(made).toHaveLength(1);
    expect(made[0].w * made[0].h).toBe(0);
  });

  it('what lands on the destination is the same whichever canvas carried it', () => {
    // The scratch is cut to a raster, grown, or passed over; the pixels copied
    // out of it are the raster's either way.
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
