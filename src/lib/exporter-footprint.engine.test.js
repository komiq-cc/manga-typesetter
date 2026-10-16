import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture, renderBoxLayer } from './exporter.js';
import { paintBoxPicture, pictureCss } from './editor/box-picture.js';
import { boxCandidate, placeBlock, linesInkRect, blockRect, blockReach } from './contain.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter, engineDraws } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { applySfxPreset, sfxPresets } from './sfx.js';

// ===========================================================================
// The footprint of a box holds the ink of its glyphs, not only their advances
// ===========================================================================
// `layoutBox` sized a box's canvas from its lines' advances and line boxes.
// Glyphs ink past both - an italic's first letter starts left of its line -
// and what was past the canvas was cut: the outside review's italic J at 300
// px lost 12% of itself at rest, and came back while it was typed into. With
// the Rust engine measuring and painting, the footprint grows to hold the ink.
//
// Two painters over one engine make "before" and "after" here: the Rust
// painter as it is installed, and the same painter not saying which engine it
// paints with, which is what switches the growth off (`engineDraws`) and is
// the footprint every box had. Every raster the painter puts on a canvas is
// recorded, so "cut" is read off the copy itself: pixels with ink whose place
// is outside the canvas they were copied to.

// These tests paint large type for real and read every pixel back, some of
// them twice over. The slowest is two seconds alone and was over the default
// five with two other suites and a capture running beside it, so the file has
// the limit the suite's other heavy tests state (solver-answers.test.js).
vi.setConfig({ testTimeout: 30_000 });

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };

let blits = [];
function tapped() {
  const c = createCanvas(300, 150);
  const get = c.getContext.bind(c);
  let ctx = null;
  c.getContext = (kind) => {
    if (ctx) return ctx;
    ctx = get(kind);
    const draw = ctx.drawImage.bind(ctx);
    ctx.drawImage = (...a) => {
      // The painter's copy is the nine-argument form, through the identity.
      if (a.length === 9) {
        const [src, , , w, h, x, y] = a;
        const d = src.getContext('2d').getImageData(0, 0, w, h).data;
        let total = 0;
        let lost = 0;
        for (let py = 0; py < h; py++) {
          for (let px = 0; px < w; px++) {
            const al = d[(py * w + px) * 4 + 3];
            if (!al) continue;
            total += al;
            if (x + px < 0 || x + px >= c.width || y + py < 0 || y + py >= c.height) lost += al;
          }
        }
        blits.push({ x, y, w, h, total, lost });
      }
      return draw(...a);
    };
    return ctx;
  };
  return c;
}

let rust;
let whole;
let asBefore;
beforeAll(async () => {
  globalThis.document = { createElement: () => tapped() };
  rust = await rustEngine();
  setTextEngine(rust);
  whole = createRustGlyphPainter(rust);
  asBefore = { ...whole, engine: undefined };
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
  setGlyphPainter(whole);
  blits = [];
});

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, strokes: [], autoHeight: false, ...over });
const boxOf = (over = {}, text = 'TEXT', geom = {}) => ({ id: 'b', lineN: null, text, x: 100, y: 100, w: 260, h: 90, ...geom, style: style(over) });
const pageOf = (box) => ({ id: 1, w: 800, h: 1200, lines: [], boxes: [box] });
const pixels = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height);

// One paint, and how much of the ink the painter made never reached the canvas.
function painted(box, scale = 2, painter = whole) {
  setGlyphPainter(painter);
  blits = [];
  const r = renderBoxTexture(box, pageOf(box), null, scale);
  const total = blits.reduce((n, b) => n + b.total, 0);
  const lost = blits.reduce((n, b) => n + b.lost, 0);
  setGlyphPainter(whole);
  return { ...r, lost: total ? lost / total : 0, rasters: blits.length };
}

// The outside review's box: DejaVu Sans italic J, 300 px, left-aligned, in a
// 300 x 400 box whose size is the user's.
const J = (over = {}) => boxOf({ font: 'DejaVu Sans', italic: true, size: 300, align: 'left', ...over }, 'J', { w: 300, h: 400 });
const OVERHANGS = {
  'italic J at 300, left-aligned (the review\'s box)': J(),
  'upright J at 300, left-aligned': boxOf({ font: 'DejaVu Sans', size: 300, align: 'left' }, 'J', { w: 300, h: 400 }),
  // The editor check's box: its ink starts on the first column of its canvas.
  'italic jf at 70, left-aligned': boxOf({ font: 'DejaVu Sans', italic: true, size: 70, align: 'left' }, 'jf', { w: 150, h: 120 }),
  'faux italic filling its box, leaning out on the right': boxOf({ font: 'Bangers', italic: true, size: 120 }, 'WHAM', { w: 250, h: 140 }),
  'italic J with an outline and a shadow': J({ strokes: [{ color: '#e11d48', width: 8, opacity: 1 }], shadows: [{ x: -6, y: 4, blur: 4, color: '#000000', opacity: 0.6 }] }),
  'italic J, right-aligned in a narrow box': boxOf({ font: 'DejaVu Sans', italic: true, size: 300, align: 'right' }, 'J', { w: 60, h: 400 }),
  'tall type on a tight line at the top of its box': boxOf({ font: 'DejaVu Sans', size: 200, lineHeight: 0.5, valign: 'top' }, 'Åj', { w: 400, h: 120 }),
  'a descender under a tight line at the bottom of its box': boxOf({ font: 'DejaVu Sans', size: 200, lineHeight: 0.5, valign: 'bottom' }, 'gjy', { w: 500, h: 120 }),
};
const INSIDE = {
  plain: boxOf({}, 'WAIT FOR ME\nOVER THERE'),
  stroked: boxOf({ strokes: [{ color: '#e11d48', width: 3, opacity: 1 }] }, 'WAIT FOR ME\nOVER THERE'),
  finished: boxOf({ strokes: [{ color: '#ffffff', width: 3, opacity: 1 }], shadows: [{ x: 4, y: 5, blur: 3, color: '#000000', opacity: 0.6 }], blur: 0.6 }, 'WAIT FOR ME\nOVER THERE'),
  'left-aligned': boxOf({ align: 'left', valign: 'top' }, 'WAIT FOR ME\nOVER THERE'),
  'right-aligned italic': boxOf({ font: 'DejaVu Sans', italic: true, align: 'right', valign: 'bottom', size: 24 }, 'offer of\njoy'),
  masked: boxOf({ clip: { on: true, mode: 'include', shapes: [{ kind: 'ellipse', cx: 130, cy: 45, rx: 100, ry: 34 }] } }, 'WAIT FOR ME\nOVER THERE'),
  smeared: boxOf({ motionBlur: { on: true, x: 2, y: 1, amount: 5 } }, 'WAIT FOR ME\nOVER THERE'),
  'overflowing by its advances': boxOf({ size: 60 }, 'WAIT FOR ME\nOVER THERE', { w: 120, h: 40 }),
  arc: boxOf({ curve: 40 }, 'ALONG AN ARC'),
};

describe('the gate', () => {
  it('is on when the engine that measures is the one the painter paints with, and off otherwise', () => {
    expect(engineDraws()).toBe(true);
    setGlyphPainter(asBefore);
    expect(engineDraws()).toBe(false);
    setGlyphPainter(before.painter);
    expect(engineDraws()).toBe(false);
    setGlyphPainter(whole);
    setTextEngine(null);
    expect(engineDraws()).toBe(false);
    setTextEngine(rust);
    expect(engineDraws()).toBe(true);
  });
});

describe('before: ink past the advances was cut', () => {
  it('the review\'s italic J lost about 12% of its ink, at the export\'s scale and at the editor\'s', () => {
    for (const scale of [2, 6]) {
      const r = painted(J(), scale, asBefore);
      expect(r.lost).toBeGreaterThan(0.11);
      expect(r.lost).toBeLessThan(0.13);
    }
  });
  it('and so did every box of this file\'s overhangs', () => {
    for (const [name, box] of Object.entries(OVERHANGS)) expect(painted(box, 2, asBefore).lost, name).toBeGreaterThan(0.001);
  });
});

describe('with the engine measuring and painting, nothing is cut', () => {
  for (const [name, box] of Object.entries(OVERHANGS)) {
    it(name, () => {
      for (const scale of [1, 2, 2.74, 6]) {
        const r = painted(box, scale);
        expect(r.rasters).toBeGreaterThan(0);
        expect(r.lost, `scale ${scale}`).toBe(0);
      }
    });
  }

  it('the footprint grew by what the ink reaches past it, to the whole page pixel, and by no more', () => {
    const box = J();
    const old = painted(box, 1, asBefore);
    const now = painted(box, 1);
    const g = linesInkRect(placeBlock(boxCandidate(box, box.text)));
    // The J's ink starts about 43 px left of the box; nothing else is past it.
    expect(g.x0).toBeLessThan(-40);
    expect(g.x1).toBeLessThan(box.w);
    expect(g.y0).toBeGreaterThan(0);
    expect(g.y1).toBeLessThan(box.h);
    const grew = now.ox - old.ox;
    expect(grew).toBe(Math.ceil(-g.x0 - 4));
    expect(now.oy).toBe(old.oy);
    expect(now.canvas.width).toBe(old.canvas.width + grew);
    expect(now.canvas.height).toBe(old.canvas.height);
  });
});

// SFX letters are placed one by one, each scaled, leaned and turned about its
// anchor, and their footprint was an em margin around the anchors: a lean was
// reach across even when the letter had been turned on its side, and an
// accent shaken up off its anchor stood past the margin. Both were cut, in the
// file and in the editor's picture alike.
const sfx = (moves) => ({ on: true, amount: 1, seed: 5, flow: 'row', rowShift: 0, moves });
// Made when asked for: the presets are the engine's, and it is not in yet
// while this file is read.
const SFX = {
  'a leaned letter tilted onto its side (lean 75, tilt 90)': () =>
    boxOf({ font: 'Bangers', size: 100, sfx: sfx([{ kind: 'lean', a: 75, b: 0 }, { kind: 'tilt', a: 90, b: 0 }]) }, 'I', { w: 100, h: 100 }),
  // The seed is one whose shake lifts the É's accent 7 px past the margin.
  'accented capitals shaken in a small box (Shaky)': () => {
    const box = boxOf({ font: 'Bangers', size: 200 }, 'jÉÅW', { w: 50, h: 50 });
    applySfxPreset(box.style, sfxPresets().find((p) => p.id === 'shaky'));
    box.style.sfx.seed = 1;
    return box;
  },
};

describe('SFX letters: the footprint holds every placed letter\'s ink', () => {
  // The glyphs painted on their own, so that what falls outside the canvas is
  // there to be counted: the whole-box job paints only inside its rectangle,
  // and cuts the same ink without a trace of it.
  const glyphsAlone = () => ({ ...whole, box: false, paintBox: undefined });
  for (const [name, make] of Object.entries(SFX)) {
    it(name, () => {
      const box = make();
      expect(placeBlock(boxCandidate(box, box.text)).isCurve).toBe(true);
      for (const scale of [1, 2, 6]) {
        const r = painted(box, scale, glyphsAlone());
        expect(r.rasters).toBeGreaterThan(0);
        expect(r.lost, `scale ${scale}`).toBe(0);
      }
    });
  }
});

describe('a box whose ink is inside its footprint is untouched', () => {
  // The footprint is what is under test, so both paints lay the shadows, the
  // blur, the smear and the mask the same way: by the canvas. The painter
  // that paints the whole box itself (`box`) makes other bytes of those
  // passes, and box-job.engine.test.js holds it to these.
  const canvasPasses = (p) => ({ ...p, box: false, paintBox: undefined });
  for (const [name, box] of Object.entries(INSIDE)) {
    it(`${name}: the same canvas, origin and bytes`, () => {
      for (const scale of [2, 2.74]) {
        const old = painted(box, scale, canvasPasses(asBefore));
        const now = painted(box, scale, canvasPasses(whole));
        expect([now.canvas.width, now.canvas.height, now.ox, now.oy, now.cw, now.ch]).toEqual([old.canvas.width, old.canvas.height, old.ox, old.oy, old.cw, old.ch]);
        const a = pixels(old.canvas).data;
        const b = pixels(now.canvas).data;
        let unlike = 0;
        let ink = 0;
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) unlike++;
          if (i % 4 === 3 && a[i]) ink++;
        }
        expect(ink).toBeGreaterThan(300);
        expect(unlike).toBe(0);
      }
    });
  }
});

describe('the old picture is the new one, cropped', () => {
  // Same pixels where the two overlap; what is new is outside the old canvas.
  const overlap = (box, scale) => {
    const old = painted(box, scale, asBefore);
    const now = painted(box, scale);
    const dx = Math.round((now.ox - old.ox) * scale);
    const dy = Math.round((now.oy - old.oy) * scale);
    const a = pixels(old.canvas);
    const b = pixels(now.canvas);
    let unlike = 0;
    let outside = 0;
    for (let y = 0; y < b.height; y++) {
      for (let x = 0; x < b.width; x++) {
        const ox = x - dx;
        const oy = y - dy;
        const j = (y * b.width + x) * 4;
        if (ox < 0 || oy < 0 || ox >= a.width || oy >= a.height) {
          if (b.data[j + 3]) outside++;
          continue;
        }
        const i = (oy * a.width + ox) * 4;
        for (let k = 0; k < 4; k++) if (a.data[i + k] !== b.data[j + k]) unlike++;
      }
    }
    return { old, now, dx, dy, unlike, outside };
  };

  // One box a test: each is two paints of 300 px type at the editor's scale
  // and a walk over every pixel of both, most of a second on a quiet machine.
  for (const name of ['italic J at 300, left-aligned (the review\'s box)', 'upright J at 300, left-aligned', 'faux italic filling its box, leaning out on the right', 'tall type on a tight line at the top of its box']) {
    it(`plain ink: identical inside the old canvas, the cut ink outside it: ${name}`, () => {
      const r = overlap(OVERHANGS[name], 2);
      expect(r.unlike).toBe(0);
      expect(r.outside).toBeGreaterThan(50);
    });
  }
});

describe('everything that places the picture still places it where it was', () => {
  it('the box\'s corner inside the texture moved by exactly what the canvas grew: the ink is on the same page px', () => {
    const box = J();
    const old = painted(box, 2, asBefore);
    const now = painted(box, 2);
    const inkBox = (r) => {
      const d = pixels(r.canvas);
      let x0 = d.width, x1 = -1, y0 = d.height, y1 = -1;
      for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) if (d.data[(y * d.width + x) * 4 + 3] > 127) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      // Box-local page px.
      return { left: x0 / r.ss - r.ox, right: (x1 + 1) / r.ss - r.ox, top: y0 / r.ss - r.oy, bottom: (y1 + 1) / r.ss - r.oy };
    };
    const a = inkBox(old);
    const b = inkBox(now);
    // Cut at the old canvas's edge before; where the engine says the ink is now.
    expect(a.left).toBe(-old.ox);
    const g = linesInkRect(placeBlock(boxCandidate(box, box.text)));
    expect(Math.abs(b.left - g.x0)).toBeLessThanOrEqual(1);
    expect(b.right).toBe(a.right);
    expect(b.top).toBe(a.top);
    // The J's hook is its lowest ink and was in the part that was cut.
    expect(b.bottom).toBeGreaterThanOrEqual(a.bottom);
    expect(Math.abs(b.bottom - g.y1)).toBeLessThanOrEqual(1);
  });

  it('the page paint and the PSD\'s raster (renderBoxLayer): the same pixels where the old layer had any, more to the left', () => {
    const box = J();
    const p = pageOf(box);
    setGlyphPainter(asBefore);
    const old = renderBoxLayer(box, p.w, p.h, null, p, 1, null);
    setGlyphPainter(whole);
    const now = renderBoxLayer(box, p.w, p.h, null, p, 1, null);
    expect(now.left).toBeLessThan(old.left - 30);
    expect([now.top, now.right]).toEqual([old.top, old.right]);
    // The hook, the J's lowest ink, was in the part that was cut.
    expect(now.bottom).toBeGreaterThanOrEqual(old.bottom);
    // Page px by page px over the old layer's rectangle, but for its first two
    // columns: the old picture ended there, and the downscale to the page reads
    // a neighbour that used to be off the canvas.
    let unlike = 0;
    let checked = 0;
    const ow = old.right - old.left;
    const nw = now.right - now.left;
    for (let y = old.top; y < old.bottom; y++) {
      for (let x = old.left + 2; x < old.right; x++) {
        const i = ((y - old.top) * ow + (x - old.left)) * 4;
        const j = ((y - now.top) * nw + (x - now.left)) * 4;
        checked++;
        for (let k = 0; k < 4; k++) if (old.imageData.data[i + k] !== now.imageData.data[j + k]) unlike++;
      }
    }
    expect(checked).toBeGreaterThan(10000);
    expect(unlike).toBe(0);
  });

  it('the editor\'s picture: placed by the new corner, so the box\'s own corner is where it was on screen', () => {
    const box = J();
    const el = createCanvas(1, 1);
    const g = paintBoxPicture(el, box, pageOf(box), 3, null);
    const now = painted(box, 3);
    expect([g.ox, g.oy]).toEqual([now.ox, now.oy]);
    const css = Object.fromEntries(pictureCss(g, 1.5).split(';').filter(Boolean).map((d) => d.split(':')).map(([k, v]) => [k, parseFloat(v)]));
    // The canvas starts `ox` page px left of the box's corner, at the zoom.
    expect(css.left).toBeCloseTo(-g.ox * 1.5, 9);
    expect(css.width).toBeCloseTo(g.cw * 1.5, 9);
    expect(g.ox).toBeGreaterThan(40);
  });

  it('the block\'s own rectangle, which the hit target and the old footprint read, did not move', () => {
    const box = J();
    const place = placeBlock(boxCandidate(box, box.text));
    const r = blockRect(place);
    expect(r.x0).toBeGreaterThanOrEqual(0);
    expect(linesInkRect(place).x0).toBeLessThan(r.x0 - 40);
  });

  // What takes the pointer over a picture (`blockReach`, laid over the box by
  // TextBox.svelte) is the line boxes and the ink together. The outside
  // review's box, in the real face: the advances are inside the frame and say
  // "no target needed", and the hook is 47 px outside it.
  it('the rectangle that takes the pointer holds the ink the footprint was grown for', () => {
    const box = J();
    const place = placeBlock(boxCandidate(box, box.text));
    const lines = blockRect(place);
    const ink = linesInkRect(place);
    expect(lines.x0).toBeGreaterThanOrEqual(0);
    expect(lines.x1).toBeLessThanOrEqual(box.w);
    expect(lines.y0).toBeGreaterThanOrEqual(0);
    expect(lines.y1).toBeLessThanOrEqual(box.h);
    expect(ink.x0).toBeLessThan(-40);
    const r = blockReach(place);
    expect(r).toEqual({ x0: Math.min(lines.x0, ink.x0), y0: Math.min(lines.y0, ink.y0), x1: Math.max(lines.x1, ink.x1), y1: Math.max(lines.y1, ink.y1) });
    expect(r.x0).toBe(ink.x0);
    // And it is inside what is painted: the footprint reaches at least as far.
    const t = painted(box, 1);
    expect(-t.ox).toBeLessThanOrEqual(r.x0);
    expect(-t.oy).toBeLessThanOrEqual(r.y0);
    expect(-t.ox + t.cw).toBeGreaterThanOrEqual(r.x1);
    expect(-t.oy + t.ch).toBeGreaterThanOrEqual(r.y1);
    // A curve has no block.
    const arc = boxOf({ curve: 40 }, 'ROUND');
    expect(blockReach(placeBlock(boxCandidate(arc, arc.text)))).toBe(null);
  });
});
