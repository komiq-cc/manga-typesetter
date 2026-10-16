import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxTexture, boxInJob } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// A box with no fill
// ===========================================================================
// `style.noFill`: the letters are cut out of their own strokes. What is left
// of a stroke is the half of it outside the letter, which is the width the
// style names, and the page shows through the letter. A shadow is the shadow
// of that, and a box with no stroke either shows nothing.
//
// Held here for the engine's two ways of painting a box: whole, in one job
// (text-engine/src/paint/), and as glyphs the canvas lays its passes over
// (`paintShadows` / `paintBox` in exporter.js).

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let whole;
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

const RED = '#ff0000';
const BLUE = '#0000ff';
const STROKE = [{ color: BLUE, width: 4, opacity: 1 }];
const SCALE = 2;
const SHADOW = { x: 6, y: 5, blur: 0, color: '#00ff00', opacity: 1 };
const style = (over = {}) =>
  normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 64, color: RED, strokes: STROKE, shadows: [], autoHeight: false, ...over });
const boxOf = (over = {}) => ({ id: 'b', lineN: null, text: 'HOLLOW', x: 120, y: 110, w: 300, h: 110, style: style(over) });
const pageOf = (box) => ({ id: 1, w: 600, h: 400, lines: [], boxes: [box] });

function texture(box, painter) {
  setGlyphPainter(painter);
  const r = renderBoxTexture(box, pageOf(box), null, SCALE);
  setGlyphPainter(whole);
  const { width, height } = r.canvas;
  return { width, height, data: r.canvas.getContext('2d').getImageData(0, 0, width, height).data };
}
const is = (img, i, r, g, b, a = 255) => img.data[i] === r && img.data[i + 1] === g && img.data[i + 2] === b && img.data[i + 3] === a;

describe.each([
  ['painted whole by the engine', () => whole, true],
  ['painted as glyphs under the canvas passes', () => canvasPasses, false],
])('a box with no fill, %s', (_name, painter, inJob) => {
  it('is its strokes with the letters cut out of them', () => {
    setGlyphPainter(painter());
    expect(boxInJob(boxOf())).toBe(inJob);
    const filled = texture(boxOf(), painter());
    const hollow = texture(boxOf({ noFill: true }), painter());
    expect([hollow.width, hollow.height]).toEqual([filled.width, filled.height]);
    let inside = 0;
    let band = 0;
    for (let i = 0; i < filled.data.length; i += 4) {
      // Nothing of the fill's colour is anywhere in it.
      expect(hollow.data[i]).toBe(0);
      if (is(filled, i, 255, 0, 0)) {
        // Where the fill was whole there is nothing: not the fill, and not
        // the half of the stroke that lay under it.
        inside++;
        expect(hollow.data[i + 3]).toBe(0);
      } else if (is(filled, i, 0, 0, 255)) {
        // And the stroke outside the letter is as it was.
        band++;
        expect(is(hollow, i, 0, 0, 255)).toBe(true);
      }
    }
    expect(inside).toBeGreaterThan(2000);
    expect(band).toBeGreaterThan(2000);
  });

  it('wins over a gradient and a pattern', () => {
    const plain = texture(boxOf({ noFill: true }), painter());
    const grad = structuredClone(style({ noFill: true }));
    grad.gradient.on = true;
    grad.pattern.on = true;
    const both = texture({ ...boxOf(), style: grad }, painter());
    expect(Buffer.compare(Buffer.from(both.data), Buffer.from(plain.data))).toBe(0);
  });

  it('casts the shadow of what is left, and nothing at all with no stroke', () => {
    const filled = texture(boxOf({ shadows: [SHADOW] }), painter());
    const hollow = texture(boxOf({ shadows: [SHADOW], noFill: true }), painter());
    expect([hollow.width, hollow.height]).toEqual([filled.width, filled.height]);
    const w = filled.width;
    const back = (SHADOW.y * SCALE * w + SHADOW.x * SCALE) * 4;
    let through = 0;
    let shadow = 0;
    for (let i = back; i < filled.data.length; i += 4) {
      if (is(hollow, i, 0, 255, 0)) shadow++;
      // Inside a letter, at a place its shadow falls from inside the letter
      // too: the page shows through both. A pixel in from the letter's edge,
      // because the canvas lays a shadow down through a filter a pixel wide.
      const from = i - back;
      const deep = [0, 4, -4, w * 4, -w * 4].every((d) => is(filled, from + d, 255, 0, 0));
      if (is(filled, i, 255, 0, 0) && deep) {
        through++;
        expect(hollow.data[i + 3]).toBe(0);
      }
    }
    expect(shadow).toBeGreaterThan(500);
    expect(through).toBeGreaterThan(500);

    const none = texture(boxOf({ shadows: [SHADOW], noFill: true, strokes: [] }), painter());
    expect(none.data.some((v) => v !== 0)).toBe(false);
  });
});
