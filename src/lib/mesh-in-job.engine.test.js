import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture, warpTexture, boxFootprint, meshInJob, glyphJob } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { createBrowserGlyphPainter } from './text-engine/browser-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { boxCandidate, placeBlock } from './contain.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { identityMesh } from './warp.js';
import { sfxPresets, applySfxPreset } from './sfx.js';

// ===========================================================================
// The mesh in the glyph job, against the real engine
// ===========================================================================
// Where the Rust engine measures and paints, a box's mesh is stated in the
// glyph job and the painter bends the outlines (`meshInJob`, exporter.js); the
// texture then comes back bent (`warped`) and `warpTexture` leaves it alone.
// Anywhere else - the browser painter, a box with brush ink or a mask, a drag
// of the mesh gizmo (`flat`) - the mesh is the raster warp of the finished
// texture it always was. Pinned here: which way a box goes, that the footprint
// worked out without a paint is the one a paint returns, and that the two
// routes put the ink in the same place.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let rust;
let rustPainter;

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  rust = await rustEngine();
  rustPainter = createRustGlyphPainter(rust);
  setTextEngine(rust);
  setGlyphPainter(rustPainter);
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

const W = 300;
const H = 90;
const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, strokes: [], ...over });
const boxOf = (over = {}, text = 'THE MESH IS\nIN THE JOB', geom = {}) => ({ id: 'b', lineN: null, text, x: 100, y: 100, w: W, h: H, ...geom, style: style(over) });
const pageOf = (box) => ({ id: 1, w: 1600, h: 2300, lines: [], boxes: [box] });
const bytes = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
const unlike = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

// A 3 x 3 mesh with its four inner points moved by 10 to 20 px, none across
// its neighbour: a mesh that folds over itself has no one picture, and the
// two routes show it in their own ways.
function bumpy() {
  const pts = identityMesh(3, 3, W, H);
  const at = (i, j) => j * 4 + i;
  const move = (i, j, dx, dy) => (pts[at(i, j)] = [pts[at(i, j)][0] + dx, pts[at(i, j)][1] + dy]);
  move(1, 1, -12, -18);
  move(2, 1, 15, 10);
  move(1, 2, 10, 14);
  move(2, 2, -20, -12);
  return { on: true, cols: 3, rows: 3, pts };
}
// One cell, a corner pulled: the homography.
const perspective = () => ({ on: true, cols: 1, rows: 1, pts: [[0, 0], [W, 22], [-8, H], [W - 10, H - 12]] });
// A brush stroke across the box, and a mask over most of it.
const INK = { on: true, strokes: [{ brush: 'round', size: 8, color: '#e11d48', opacity: 1, seed: 3, pts: [[20, 40, 1], [120, 55, 1], [260, 40, 1]] }] };
const CLIP = { on: true, mode: 'include', shapes: [{ kind: 'ellipse', cx: 150, cy: 45, rx: 120, ry: 34 }] };

// Where the ink is in a texture, in page px from the box's own corner, and how
// much of it there is.
function inkOf(tex) {
  const { width, height } = tex.canvas;
  const { data } = tex.canvas.getContext('2d').getImageData(0, 0, width, height);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3];
      if (a > 127) n++;
      if (a > 32) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  // (A warped texture does not carry its scale: a pixel is this many page px.)
  const ss = tex.canvas.width / tex.cw;
  // `ox, oy` is where the box's own corner sits in the texture.
  return { left: x0 / ss - tex.ox, top: y0 / ss - tex.oy, right: (x1 + 1) / ss - tex.ox, bottom: (y1 + 1) / ss - tex.oy, n };
}

describe('a box whose painter bends the mesh', () => {
  it('is bent in the job, and its texture says so and is left as it is by warpTexture', () => {
    const box = boxOf({ warp: bumpy() });
    const p = pageOf(box);
    expect(meshInJob(box)).toBe(true);
    const tex = renderBoxTexture(box, p, null, 2);
    expect(tex.warped).toBe(true);
    expect(tex.canvas.width).toBeGreaterThan(0);
    const done = warpTexture(tex, box);
    expect(done.canvas).toBe(tex.canvas);
    expect([done.ox, done.oy, done.cw, done.ch]).toEqual([tex.ox, tex.oy, tex.cw, tex.ch]);
    // The footprint worked out without a paint: the corner exactly, the size
    // to within the whole pixel the paint rounds up to.
    const f = boxFootprint(box, p);
    expect([f.ox, f.oy]).toEqual([tex.ox, tex.oy]);
    expect(Math.abs(f.cw - tex.cw)).toBeLessThanOrEqual(1 / 2);
    expect(Math.abs(f.ch - tex.ch)).toBeLessThanOrEqual(1 / 2);
  });

  it('is the same for a mesh of one cell', () => {
    const box = boxOf({ warp: perspective() });
    const p = pageOf(box);
    expect(meshInJob(box)).toBe(true);
    const tex = renderBoxTexture(box, p, null, 2);
    expect(tex.warped).toBe(true);
    const f = boxFootprint(box, p);
    expect([f.ox, f.oy]).toEqual([tex.ox, tex.oy]);
    expect(Math.abs(f.cw - tex.cw)).toBeLessThanOrEqual(1 / 2);
    expect(Math.abs(f.ch - tex.ch)).toBeLessThanOrEqual(1 / 2);
  });

  it('is painted unbent when it is asked for flat, and the texture warp then bends a canvas of its own', () => {
    const box = boxOf({ warp: bumpy() });
    const p = pageOf(box);
    const flat = renderBoxTexture(box, p, null, 2, Infinity, Infinity, true);
    expect(flat.warped).toBe(false);
    // `warpTexture` gives back a new picture, larger than the unbent one: the
    // mesh throws the letters past the frame.
    const flatCanvas = flat.canvas;
    const bent = warpTexture(flat, box, false);
    expect(bent.canvas).not.toBe(flatCanvas);
    expect(bent.cw * bent.ch).toBeGreaterThan(flat.cw * flat.ch);
    // And the bent texture is not the unbent one.
    const bentInJob = renderBoxTexture(box, p, null, 2);
    expect(bentInJob.warped).toBe(true);
    expect([bentInJob.canvas.width, bentInJob.canvas.height]).not.toEqual([flatCanvas.width, flatCanvas.height]);
  });

  it('is bent in the job with its visibility mask, where the painter paints the whole box: the mask bends with the letters', () => {
    const box = boxOf({ warp: bumpy(), clip: CLIP });
    const p = pageOf(box);
    expect(glyphPainter().box).toBe(true);
    expect(meshInJob(box)).toBe(true);
    const tex = renderBoxTexture(box, p, null, 2);
    expect(tex.warped).toBe(true);
    // The mask cuts the bent picture: it has ink, and less of it than the
    // same box with no mask.
    const count = (c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
      return n;
    };
    const open = boxOf({ warp: bumpy() });
    const masked = count(tex.canvas);
    expect(masked).toBeGreaterThan(100);
    expect(masked).toBeLessThan(count(renderBoxTexture(open, pageOf(open), null, 2).canvas));
  });

  // A painter that hands back glyphs for the canvas to mask (`box` unset)
  // keeps a masked box on the texture warp, as an inked one always is.
  for (const [name, over, painter] of [['brush ink', { ink: INK }, (w) => w], ['a visibility mask and a painter that does not paint whole boxes', { clip: CLIP }, (w) => ({ ...w, box: false, paintBox: undefined })]]) {
    it(`is not bent in the job when the box has ${name}: the texture warp takes it whole`, () => {
      const whole = glyphPainter();
      setGlyphPainter(painter(whole));
      onTestFinished(() => setGlyphPainter(whole));
      const box = boxOf({ warp: bumpy(), ...over });
      const p = pageOf(box);
      expect(meshInJob(box)).toBe(false);
      const tex = renderBoxTexture(box, p, null, 2);
      expect(tex.warped).toBe(false);
      // The footprint is the texture warp's own: the unbent box's, carried through the mesh.
      const done = warpTexture(tex, box);
      const f = boxFootprint(box, p);
      expect([f.ox, f.oy]).toEqual([done.ox, done.oy]);
      expect(Math.abs(f.cw - done.cw)).toBeLessThanOrEqual(1);
      expect(Math.abs(f.ch - done.ch)).toBeLessThanOrEqual(1);
    });
  }

  it('is not a mesh at all while the mesh does nothing: an identity mesh is the box without one, byte for byte', () => {
    const off = boxOf({ warp: { on: false, cols: 1, rows: 1, pts: [] } });
    const same = boxOf({ warp: { on: true, cols: 1, rows: 1, pts: identityMesh(1, 1, W, H) } });
    expect(meshInJob(same)).toBe(false);
    const a = renderBoxTexture(off, pageOf(off), null, 2);
    const b = renderBoxTexture(same, pageOf(same), null, 2);
    expect(b.warped).toBe(false);
    expect([b.canvas.width, b.canvas.height]).toEqual([a.canvas.width, a.canvas.height]);
    expect([b.ox, b.oy, b.cw, b.ch]).toEqual([a.ox, a.oy, a.cw, a.ch]);
    expect(unlike(bytes(b.canvas), bytes(a.canvas))).toBe(0);
  });
});

// The two routes are two renderings of one map, and the ink is where the other
// puts it: not to the bit (one bends outlines, the other resamples pixels) but
// to the pixel.
describe('the painter\'s bend and the texture warp agree on where the ink is', () => {
  for (const [name, mesh] of [['a 3 x 3 mesh', bumpy], ['a perspective mesh of one cell', perspective]]) {
    it(name, () => {
      const box = boxOf({ warp: mesh() });
      const p = pageOf(box);
      const vector = renderBoxTexture(box, p, null, 2);
      const raster = warpTexture(renderBoxTexture(box, p, null, 2, Infinity, Infinity, true), box);
      expect(vector.warped).toBe(true);
      expect(vector.ss).toBe(2);
      expect(raster.canvas.width / raster.cw).toBeCloseTo(2, 1);
      const a = inkOf(vector);
      const b = inkOf(raster);
      expect(a.n).toBeGreaterThan(1000);
      for (const side of ['left', 'top', 'right', 'bottom']) expect(Math.abs(a[side] - b[side]), `${side}: ${a[side]} against ${b[side]}`).toBeLessThanOrEqual(2);
      // Both lay what the map asks for. (The texture warp used to paint 5 to 7%
      // fat, its triangles overlapping at their seams; a flat mesh's triangles
      // now meet edge to edge and are added, warp-paint.js.) What is left is
      // resampling against outline bending: 1.3% on the 3 x 3, 0.1% on the
      // perspective cell.
      expect(Math.abs(a.n - b.n) / b.n, `${a.n} inked pixels against ${b.n}`).toBeLessThan(0.03);
    });
  }
});

describe('under the browser painter', () => {
  it('nothing changes: no mesh goes in the job', () => {
    const box = boxOf({ warp: bumpy() });
    expect(meshInJob(box)).toBe(true);
    try {
      setGlyphPainter(createBrowserGlyphPainter());
      expect(meshInJob(box)).toBe(false);
      expect(meshInJob(boxOf({ warp: perspective() }))).toBe(false);
      // A painter that is the engine's but does not say it bends is no more
      // asked to.
      setGlyphPainter({ ...rustPainter, mesh: false });
      expect(meshInJob(box)).toBe(false);
    } finally {
      setGlyphPainter(rustPainter);
    }
    expect(meshInJob(box)).toBe(true);
  });
});

describe('a drip', () => {
  const drip = () => sfxPresets().find((q) => q.id === 'drip');
  // A box set up as the panel does it, with the seed stated.
  function dripBox(amount) {
    const box = boxOf({ font: 'Bangers', size: 40 }, 'BOOM!!', { w: 400, h: 120 });
    applySfxPreset(box.style, drip(), box);
    box.style.sfx.seed = 7;
    box.style.sfx.moves = box.style.sfx.moves.map((m) => ({ ...m, a: amount }));
    return box;
  }
  const place = (box) => placeBlock(boxCandidate(box, box.text));

  it('lengthens some letters of the layout, and only some', () => {
    const box = dripBox(0.45);
    const layout = place(box).layout;
    expect(layout).toHaveLength(6);
    for (const g of layout) expect(g.drip ?? 0, g.ch).toBeGreaterThanOrEqual(0);
    expect(layout.some((g) => g.drip > 0)).toBe(true);
    expect(layout.some((g) => !(g.drip > 0))).toBe(true);
  });

  it('is in the glyph job as the run\'s own drip, on the same letters', () => {
    const box = dripBox(0.45);
    const pl = place(box);
    const L = { s: box.style, ox: 0, oy: 0, isCurve: true, layout: pl.layout };
    const job = glyphJob(box, L);
    expect(job.runs).toHaveLength(pl.layout.length);
    for (const run of job.runs) expect(run.drip ?? 0).toBeGreaterThanOrEqual(0);
    expect(job.runs.some((r) => r.drip > 0)).toBe(true);
    expect(job.runs.some((r) => r.drip == null)).toBe(true);
    expect(job.runs.map((r) => r.drip > 0)).toEqual(pl.layout.map((g) => g.drip > 0));
  });

  it('reaches lower than the same letters with no drip', () => {
    const wet = dripBox(0.45);
    const dry = dripBox(0);
    expect(place(dry).layout.every((g) => !(g.drip > 0))).toBe(true);
    const a = renderBoxTexture(wet, pageOf(wet), null, 2);
    const b = renderBoxTexture(dry, pageOf(dry), null, 2);
    const low = (tex) => inkOf(tex).bottom;
    expect(low(a)).toBeGreaterThan(low(b) + 2);
  });
});
