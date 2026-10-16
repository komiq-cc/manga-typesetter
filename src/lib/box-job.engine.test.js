import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture, renderBoxLayer, boxInJob, roughenInJob, meshInJob } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { pictureTexture } from './editor/box-picture.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// A box painted whole by the engine
// ===========================================================================
// With the Rust painter a box that has no brush ink is one job: its glyphs,
// and the shadows, the blur, the smear, the mask, the roughening and the mesh
// that the canvas used to lay over them a pass at a time (`boxInJob`,
// `roughenInJob`, `meshInJob` in exporter.js; text-engine/src/paint/boxjob.rs).
//
// The engine's passes are not the canvas's bytes and are not meant to be: a
// browser's blur is its own, and a moved pixel is not a moved outline. What is
// held here is that each is the SAME PICTURE - the same ink in the same place
// to within what two blurs differ by - and the things the engine's way is for:
// a roughened edge is an edge, and a turned box is painted turned.
//
// The canvas is Skia's (@napi-rs/canvas); the glyphs are the engine's.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let whole;
// The same painter handing back glyphs for the canvas to finish.
let canvasPasses;

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  const rust = await rustEngine();
  setTextEngine(rust);
  whole = createRustGlyphPainter(rust);
  canvasPasses = { ...whole, box: false, paintBox: undefined, roughen: false };
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
beforeEach(() => setGlyphPainter(whole));

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 48, strokes: [], autoHeight: false, ...over });
const boxOf = (over = {}, text = 'WHOLE\nBOX') => ({ id: 'b', lineN: null, text, x: 120, y: 110, w: 260, h: 130, style: style(over) });
const pageOf = (box) => ({ id: 1, w: 600, h: 400, lines: [], boxes: [box] });
const SHADOW = { x: 6, y: 5, blur: 4, color: '#1d4ed8', opacity: 0.8 };
const INK = { on: true, strokes: [{ id: 's', pts: [[10, 10, 1], [60, 40, 1]], size: 6, color: '#000000' }] };

function texture(box, painter = whole, scale = 2) {
  setGlyphPainter(painter);
  const r = renderBoxTexture(box, pageOf(box), null, scale);
  setGlyphPainter(whole);
  return { ...r, img: r.canvas.getContext('2d').getImageData(0, 0, r.canvas.width, r.canvas.height) };
}

// Two pictures of one size, premultiplied (what a compositor shows): the mean
// and the worst difference of any channel, of 255, over the pixels either
// inked, and the ratio of their total ink.
function against(a, b) {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let sum = 0;
  let n = 0;
  let worst = 0;
  let inkA = 0;
  let inkB = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const aa = a.data[i + 3];
    const ba = b.data[i + 3];
    if (!aa && !ba) continue;
    let d = Math.abs(aa - ba);
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs((a.data[i + c] * aa - b.data[i + c] * ba) / 255));
    sum += d;
    n++;
    if (d > worst) worst = d;
    inkA += aa;
    inkB += ba;
  }
  return { mean: n ? sum / n : 0, worst, ink: inkB ? inkA / inkB : 0, n };
}

// Pixels that are neither clear nor full: the width of every edge.
const grey = (img) => {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 8 && img.data[i] < 247) n++;
  return n;
};

describe('the gate', () => {
  it('is the painter that paints whole boxes, and a box with no brush ink', () => {
    expect(whole.box).toBe(true);
    expect(boxInJob(boxOf())).toBe(true);
    expect(boxInJob(boxOf({ ink: INK }))).toBe(false);
    setGlyphPainter(canvasPasses);
    expect(boxInJob(boxOf())).toBe(false);
    setGlyphPainter(before.painter);
    expect(boxInJob(boxOf())).toBe(false);
  });

  it('a plain box is the bytes it was: nothing is laid on it, so the job is its glyph job', () => {
    for (const over of [{}, { strokes: [{ color: '#e11d48', width: 4, opacity: 1 }] }, { curve: 30 }]) {
      const a = texture(boxOf(over));
      const b = texture(boxOf(over), canvasPasses);
      expect(against(a.img, b.img)).toMatchObject({ worst: 0 });
      expect([a.ox, a.oy, a.cw, a.ch]).toEqual([b.ox, b.oy, b.cw, b.ch]);
    }
  });
});

describe('each pass is the picture the canvas made', () => {
  // Each case: the style, then the most the two pictures may differ by - the
  // mean and the worst, of 255 - and how much more ink the engine's may hold.
  //
  // What the numbers are made of. A flat pass differs by a level a pixel:
  // the canvas rounds a translucent colour to eight bits one way and the
  // engine another. A blur is where two renderers differ most, a few levels
  // along the soft edge: the canvas's gaussian is its own approximation. A
  // mask differs only where its edge is antialiased, by much there and over
  // few pixels. And a smear on a slant holds a little more ink here: the
  // canvas adds its copies in eight bits, each rounded, and a copy at a
  // hundredth of full strength that is also shared between four pixels
  // rounds to nothing along every edge; the engine sums them first.
  const CASES = {
    'a hard shadow': [{ shadows: [{ ...SHADOW, blur: 0 }] }, 2, 32],
    'a soft shadow': [{ shadows: [SHADOW] }, 2, 16],
    'two shadows over an outline': [{ strokes: [{ color: '#ffffff', width: 3, opacity: 1 }], shadows: [{ ...SHADOW, blur: 0 }, { x: 10, y: 10, blur: 8, color: '#000000', opacity: 0.5 }] }, 1.5, 28],
    'a blur': [{ blur: 2 }, 4, 20],
    'a smear': [{ motionBlur: { on: true, x: 2, y: 0, amount: 8 } }, 1, 8],
    'a smear on a slant': [{ motionBlur: { on: true, x: 1.5, y: -1, amount: 12 } }, 3.5, 16, 1.09],
    'a mask that keeps': [{ clip: { on: true, mode: 'include', shapes: [{ kind: 'ellipse', cx: 130, cy: 65, rx: 90, ry: 40 }] } }, 1.2, 72],
    'a mask that cuts, drawn with the brush': [{ clip: { on: true, mode: 'exclude', shapes: [{ kind: 'stroke', size: 16, pts: [[20, 20], [120, 70], [240, 40]] }, { kind: 'stroke', size: 20, pts: [[60, 100]] }, { kind: 'poly', pts: [[180, 80], [250, 85], [220, 125]] }] } }, 1, 72],
    // Not the smear with them: @napi-rs/canvas loses a blurred canvas that
    // is given back while the draws from it are still queued, so the canvas
    // passes paint a blurred AND smeared box nearly clear in this lane. (A
    // browser does not.) The engine's own picture of one is held below.
    'an outline, a shadow, a blur and a mask at once': [{ strokes: [{ color: '#ffffff', width: 3, opacity: 1 }], shadows: [SHADOW], blur: 0.8, clip: { on: true, mode: 'include', shapes: [{ kind: 'ellipse', cx: 130, cy: 65, rx: 120, ry: 60 }] } }, 3, 72],
  };
  for (const [name, [over, mean, worst, inkMost = 1.03]] of Object.entries(CASES)) {
    it(name, () => {
      for (const scale of [1, 2, 2.74]) {
        const a = texture(boxOf(over), whole, scale);
        const b = texture(boxOf(over), canvasPasses, scale);
        expect([a.ox, a.oy, a.cw, a.ch]).toEqual([b.ox, b.oy, b.cw, b.ch]);
        const d = against(a.img, b.img);
        expect(d.n, `scale ${scale}`).toBeGreaterThan(500);
        expect(d.mean, `scale ${scale}: mean`).toBeLessThan(mean);
        expect(d.worst, `scale ${scale}: worst`).toBeLessThan(worst);
        expect(d.ink, `scale ${scale}: ink`).toBeGreaterThan(0.97);
        expect(d.ink, `scale ${scale}: ink`).toBeLessThan(inkMost);
      }
    });
  }

  const ALL = { ...CASES['an outline, a shadow, a blur and a mask at once'][0], motionBlur: { on: true, x: 1, y: 0, amount: 4 } };

  it('the same box twice is the same bytes', () => {
    expect(against(texture(boxOf(ALL)).img, texture(boxOf(ALL)).img).worst).toBe(0);
  });

  it('a blurred and smeared box keeps its ink, dimmed as a smear dims it', () => {
    const { motionBlur, clip, ...rest } = ALL;
    const ink = (img) => {
      let n = 0;
      for (let i = 3; i < img.data.length; i += 4) n += img.data[i];
      return n;
    };
    const kept = ink(texture(boxOf({ ...rest, motionBlur })).img) / ink(texture(boxOf(rest)).img);
    // `amount` copies of the picture over `amount + 1` (motionBlurTaps).
    expect(kept).toBeGreaterThan(0.8 * 0.97);
    expect(kept).toBeLessThan(0.8 * 1.03);
  });
});

describe('a roughened box', () => {
  const ROUGH = { roughen: { on: true, amount: 6, detail: 0.07, seed: 7 } };

  it('is roughened in its outlines, except where the canvas draws ink on it', () => {
    expect(roughenInJob(boxOf(ROUGH))).toBe(true);
    expect(roughenInJob(boxOf())).toBe(false);
    expect(roughenInJob(boxOf({ ...ROUGH, ink: INK }))).toBe(false);
    setGlyphPainter(canvasPasses);
    expect(roughenInJob(boxOf(ROUGH))).toBe(false);
  });

  it('has the same crumple on the same letters as the pixel pass gave it', () => {
    const a = texture(boxOf(ROUGH));
    const b = texture(boxOf(ROUGH), canvasPasses);
    const other = texture(boxOf({ roughen: { ...ROUGH.roughen, seed: 8 } }));
    // Nearer the old roughening than another seed's crumple is to it.
    const same = against(a.img, b.img).mean;
    const another = against(other.img, b.img).mean;
    expect(same).toBeLessThan(another * 0.6);
    expect(against(a.img, b.img).ink).toBeGreaterThan(0.95);
    expect(against(a.img, b.img).ink).toBeLessThan(1.05);
  });

  it('has an edge no wider than a plain letter has, where moved pixels made every edge a ragged one', () => {
    const plain = grey(texture(boxOf()).img);
    const outline = grey(texture(boxOf(ROUGH)).img);
    expect(outline).toBeLessThan(plain * 1.4);
  });

  it('throws a roughened shadow, and is blurred after it is roughened', () => {
    const over = { ...ROUGH, shadows: [{ ...SHADOW, blur: 0, x: 0, y: 40 }] };
    const a = texture(boxOf(over));
    const b = texture(boxOf({ shadows: over.shadows }));
    // The shadow alone (below the letters) is not the plain box's shadow.
    expect(against(a.img, b.img).mean).toBeGreaterThan(3);
    const soft = texture(boxOf({ ...ROUGH, blur: 2 }));
    expect(grey(soft.img)).toBeGreaterThan(grey(texture(boxOf(ROUGH)).img) * 2);
  });
});

describe('grit on a roughened box', () => {
  const ROUGH = { on: true, amount: 6, detail: 0.07, seed: 7 };
  const ink = (img) => {
    let n = 0;
    for (let i = 3; i < img.data.length; i += 4) n += img.data[i];
    return n;
  };

  // Pixels plainly inked in one picture and plainly not in the other. The
  // larger canvas is the smaller one with the grit's reach round it, so the
  // two are laid centre on centre.
  const moved = (a, b) => {
    const [dx, dy] = [(a.width - b.width) / 2, (a.height - b.height) / 2];
    expect(Number.isInteger(dx) && Number.isInteger(dy) && dx >= 0 && dy >= 0).toBe(true);
    let n = 0;
    for (let y = 0; y < b.height; y++) {
      for (let x = 0; x < b.width; x++) {
        if (Math.abs(a.data[((y + dy) * a.width + x + dx) * 4 + 3] - b.data[(y * b.width + x) * 4 + 3]) > 128) n++;
      }
    }
    return n;
  };

  it('tears the edge and keeps the letter: more edge, the same ink, still an edge', () => {
    const smooth = texture(boxOf({ roughen: ROUGH }));
    const torn = texture(boxOf({ roughen: { ...ROUGH, grit: 2 } }));
    expect([torn.canvas.width, torn.canvas.height].every((v, i) => v >= [smooth.canvas.width, smooth.canvas.height][i])).toBe(true);
    // A torn edge is a longer edge, and no wider a one than antialiasing makes.
    expect(moved(torn.img, smooth.img)).toBeGreaterThan(200);
    expect(grey(torn.img)).toBeLessThan(grey(smooth.img) * 2);
    expect(ink(torn.img) / ink(smooth.img)).toBeGreaterThan(0.95);
    expect(ink(torn.img) / ink(smooth.img)).toBeLessThan(1.05);
  });

  it('is nothing at 0, and nothing where the roughening is off', () => {
    const none = texture(boxOf({ roughen: ROUGH }));
    expect(against(texture(boxOf({ roughen: { ...ROUGH, grit: 0 } })).img, none.img).worst).toBe(0);
    const off = texture(boxOf({ roughen: { ...ROUGH, on: false, grit: 3 } }));
    expect(against(off.img, texture(boxOf()).img).worst).toBe(0);
  });

  it('tears a letter that is not crumpled at all', () => {
    const alone = texture(boxOf({ roughen: { ...ROUGH, amount: 0, grit: 2 } }));
    const plain = texture(boxOf({ roughen: { ...ROUGH, amount: 0, grit: 0 } }));
    expect(moved(alone.img, plain.img)).toBeGreaterThan(200);
    expect(ink(alone.img) / ink(plain.img)).toBeGreaterThan(0.95);
    expect(ink(alone.img) / ink(plain.img)).toBeLessThan(1.05);
  });

  it('is not drawn by moved pixels, which tear on their own', () => {
    const a = texture(boxOf({ roughen: { ...ROUGH, grit: 3 } }), canvasPasses);
    const b = texture(boxOf({ roughen: ROUGH }), canvasPasses);
    // The canvas is a little larger for the grit's reach; the picture in it
    // is the same.
    expect(ink(a.img)).toBe(ink(b.img));
  });
});

describe('the smear of a picture the editor repaints', () => {
  const smear = (amount) => ({ motionBlur: { on: true, x: 2, y: 0.5, amount } });
  const coarse = (box) => {
    const r = renderBoxTexture(box, pageOf(box), null, 2, Infinity, Infinity, false, true);
    return r.canvas.getContext('2d').getImageData(0, 0, r.canvas.width, r.canvas.height);
  };
  const ink = (img) => {
    let n = 0;
    for (let i = 3; i < img.data.length; i += 4) n += img.data[i];
    return n;
  };

  it('is the whole smear up to eight steps', () => {
    const box = boxOf(smear(8));
    expect(against(coarse(box), texture(box).img).worst).toBe(0);
  });

  it('is a coarser one past that: other pixels, the same reach and the same tone', () => {
    const box = boxOf(smear(24));
    const full = texture(box).img;
    const rough = coarse(box);
    const d = against(rough, full);
    expect(d.worst).toBeGreaterThan(0);
    expect(ink(rough) / ink(full)).toBeGreaterThan(0.97);
    expect(ink(rough) / ink(full)).toBeLessThan(1.03);
    // The same picture to look at: a few levels apart on average.
    expect(d.mean).toBeLessThan(6);
  });

  it('is what the editor asks for; a texture asked for plainly is the whole smear', () => {
    const box = boxOf(smear(24));
    const r = pictureTexture(box, pageOf(box), null, 2);
    const shown = r.canvas.getContext('2d').getImageData(0, 0, r.canvas.width, r.canvas.height);
    expect(against(shown, coarse(box)).worst).toBe(0);
    expect(against(shown, texture(box).img).worst).toBeGreaterThan(0);
  });
});

describe('a masked box with a mesh', () => {
  it('is bent in the job, mask and all', () => {
    const warp = { on: true, cols: 2, rows: 1, pts: [[0, 10], [130, -14], [260, 12], [6, 130], [130, 112], [254, 140]] };
    const box = boxOf({ warp, clip: { on: true, mode: 'include', shapes: [{ kind: 'ellipse', cx: 130, cy: 65, rx: 100, ry: 45 }] } });
    expect(meshInJob(box)).toBe(true);
    const a = texture(box);
    expect(a.warped).toBe(true);
    expect(grey(a.img)).toBeGreaterThan(50);
  });
});

describe('a turned box on the page', () => {
  const layer = (box, painter = whole, scale = 1) => {
    setGlyphPainter(painter);
    const p = pageOf(box);
    const r = renderBoxLayer(box, p.w, p.h, null, p, scale, null);
    setGlyphPainter(whole);
    return r;
  };
  // Both layers on one page-sized picture, so they can be laid against each other.
  const onPage = (l, w, h) => {
    const c = createCanvas(w, h);
    c.getContext('2d').putImageData(l.imageData, l.left, l.top);
    return c.getContext('2d').getImageData(0, 0, w, h);
  };

  for (const [name, over] of Object.entries({
    'turned, with a shadow': { rotation: 17, shadows: [SHADOW] },
    'mirrored, with a shadow': { flipH: true, shadows: [SHADOW] },
    'turned and mirrored and smeared': { rotation: -30, flipV: true, motionBlur: { on: true, x: 2, y: 0, amount: 6 } },
    'turned, masked': { rotation: 40, clip: { on: true, mode: 'include', shapes: [{ kind: 'ellipse', cx: 130, cy: 65, rx: 90, ry: 40 }] } },
    'turned and see-through': { rotation: 12, opacity: 0.5, shadows: [SHADOW] },
  })) {
    it(`${name}: lands where the turned bitmap landed`, () => {
      for (const scale of [1, 2]) {
        const box = boxOf(over);
        const a = layer(box, whole, scale);
        const b = layer(box, canvasPasses, scale);
        // Within two pixels on every side: the old one was a resample.
        for (const k of ['left', 'top', 'right', 'bottom']) expect(Math.abs(a[k] - b[k]), `${k} at ${scale}`).toBeLessThanOrEqual(3 * scale);
        const d = against(onPage(a, 600 * scale, 400 * scale), onPage(b, 600 * scale, 400 * scale));
        expect(d.ink, `ink at ${scale}`).toBeGreaterThan(0.95);
        expect(d.ink, `ink at ${scale}`).toBeLessThan(1.05);
        expect(d.mean, `mean at ${scale}`).toBeLessThan(12);
      }
    });
  }

  it('is painted at its angle: its edges are edges, where a turned bitmap\'s are resampled', () => {
    const box = boxOf({ rotation: 17, font: 'Comic Neue', size: 20, shadows: [{ ...SHADOW, blur: 0, x: 0, y: 60, opacity: 0 }] }, 'small type turned\nstays sharp');
    const now = grey(layer(box, whole, 2).imageData);
    const was = grey(layer(box, canvasPasses, 2).imageData);
    expect(now).toBeLessThan(was * 0.9);
  });
});
