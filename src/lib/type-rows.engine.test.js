import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { typeModel, canType, linePens } from './type-rows.js';
import { caretAt, rowOf, rowExtent, offsetAt, selectionRects, moveCaret } from './flat-caret.js';
import { rawEdit } from './edit-lines.js';
import { renderBoxTexture } from './exporter.js';
import { boxCandidate, placeBlock } from './contain.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo, faceFor, textInset } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// Caret positions from the real engine, against what the painter paints
// ===========================================================================
// The rows a box is typed into by (`typeModel`) and the picture of the box
// (`renderBoxTexture`) are made from the same lines and the same shaping.
// That is the design; this file is the check that it holds in PIXELS, not
// only in numbers that came out of the same function: a line is painted, and
// each glyph's ink is found in the painting and compared with where the
// caret before it stands.
//
// How one glyph's ink is found in a line: the line is painted up to and
// including the glyph, and up to but not including it, and the columns that
// differ are the glyph's. The pens of a prefix are the full line's (kerning
// reaches one glyph back, never forward), which is asserted on its own.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let rust;
// With P7_DUMP=<file> every figure of the pixel proof is written there, for
// the report: the caret, the bearing, the column the caret says and the
// column the ink was found in.
const dump = [];

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  rust = await rustEngine();
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
  if (process.env.P7_DUMP) {
    mkdirSync(new URL('.', `file://${process.env.P7_DUMP}`), { recursive: true });
    writeFileSync(process.env.P7_DUMP, JSON.stringify(dump, null, 1));
  }
});

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 60, strokes: [], autoHeight: false, shape: 'off', ...over });
const boxOf = (text, over = {}, geom = {}) => ({ id: 'b', lineN: null, text, x: 40, y: 40, w: 900, h: 120, ...geom, style: style({ align: 'left', valign: 'top', ...over }) });
const pageOf = (box) => ({ id: 1, w: 1600, h: 1200, lines: [], boxes: [box] });

it('the full row extent includes real interior extrema under negative spacing', () => {
  const text = 'iMMMMi';
  const box = boxOf(text, { size: 40, letterSpacing: -20 });
  const model = typeModel(box, text);
  expect(model.kind).toBe('flat');
  expect(model.rows).toHaveLength(1);
  const row = model.rows[0];
  const near = Math.min(...row.xs);
  const far = Math.max(...row.xs);
  expect(near).toBeLessThan(0);
  expect(far).toBeGreaterThan(Math.max(row.xs[0], row.xs.at(-1)));
  expect(rowExtent(row)).toEqual([near, far]);
  // A pointer on the overflowing part still answers a legal raw stop.
  expect(row.offs).toContain(offsetAt(model.rows, near, row.top + 1).o);
});

const SS = 2;
// The box painted at `SS`, as alpha by box-local device column: `col(x)` is
// the strongest alpha in the device column `x` px right of the box's left.
function painted(box) {
  const tex = renderBoxTexture(box, pageOf(box), null, SS);
  const w = tex.canvas.width;
  const h = tex.canvas.height;
  const data = tex.canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const cols = new Uint8Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > cols[x]) cols[x] = data[(y * w + x) * 4 + 3];
  const off = Math.round(tex.ox * tex.ss);
  expect(tex.ss).toBe(SS);
  expect(off).toBe(tex.ox * tex.ss);
  return { col: (x) => cols[x + off] ?? 0, from: -off, to: w - off, data, w, h, off, oy: Math.round(tex.oy * tex.ss) };
}
// Full per-pixel alpha, by box-local device coordinates, for the difference
// of two paintings of different footprints.
const alphaAt = (p, x, y) => {
  const cx = x + p.off;
  const cy = y + p.oy;
  return cx < 0 || cy < 0 || cx >= p.w || cy >= p.h ? 0 : p.data[(cy * p.w + cx) * 4 + 3];
};
// The first device column (box-local) where two paintings differ, or null.
function firstUnlikeColumn(a, b) {
  const from = Math.min(a.from, b.from);
  const to = Math.max(a.to, b.to);
  const top = -Math.max(a.oy, b.oy);
  const bottom = Math.max(a.h - a.oy, b.h - b.oy);
  for (let x = from; x < to; x++) {
    for (let y = top; y < bottom; y++) if (Math.abs(alphaAt(a, x, y) - alphaAt(b, x, y)) > 24) return x;
  }
  return null;
}

// The clusters of a line as [start, end) offsets.
function clustersOf(box, text) {
  const s = box.style;
  const pens = linePens(rust, faceFor(s, s.size), text, s.letterSpacing);
  return pens.at.map((a, i) => [a, pens.at[i + 1] ?? text.length]);
}

// For one line of text in a box: every cluster's ink starts where the caret
// before it stands plus the cluster's own left bearing, within a device px.
function expectInkAtCarets(text, over = {}, { fallbacks = [] } = {}) {
  rust.setFallbacks(fallbacks);
  clearLayoutMemo();
  try {
    const box = boxOf(text, over);
    const s = box.style;
    const face = faceFor(s, s.size);
    const full = typeModel(box, text);
    expect(full?.kind).toBe('flat');
    expect(full.rows).toHaveLength(1);
    const rows = [];
    for (const [a, b] of clustersOf(box, text)) {
      const glyph = text.slice(a, b);
      const ink = rust.lineInk(face, glyph);
      if (!(ink.right + ink.left > 0)) continue;
      // The caret before the cluster, in the full line and in the prefix that
      // ends with it: one number.
      const stop = caretAt(full.rows, a).x;
      const prefix = typeModel(boxOf(text.slice(0, b), over), text.slice(0, b));
      expect(caretAt(prefix.rows, a).x, `pen before '${glyph}' in the prefix`).toBeCloseTo(stop, 9);
      const withIt = painted(boxOf(text.slice(0, b), over));
      const without = a === 0 ? { from: 0, to: 0, w: 0, h: 0, off: 0, oy: 0, data: [] } : painted(boxOf(text.slice(0, a), over));
      const seen = firstUnlikeColumn(without, withIt);
      const want = (stop - ink.left) * SS;
      rows.push({ glyph, stop, bearing: -ink.left, want, seen });
      expect(seen, `ink of '${glyph}' at offset ${a} of '${text}'`).not.toBeNull();
      expect(Math.abs(seen - Math.floor(want)), `'${glyph}' at offset ${a}: ink starts at device column ${seen}, the caret says ${want.toFixed(2)}`).toBeLessThanOrEqual(1);
    }
    expect(rows.length).toBeGreaterThan(1);
    dump.push({ text, over, fallbacks, rows: rows.map((r) => ({ ...r, off: +(r.seen - r.want).toFixed(3) })) });
    return rows;
  } finally {
    rust.setFallbacks([]);
    clearLayoutMemo();
  }
}

describe('the engine can say where a caret stands', () => {
  it('the built wasm has the export', () => {
    expect(canType()).toBe(true);
  });

  it('without an engine that has it, there is no model and the box is typed into as DOM text', () => {
    const { lineCarets, ...old } = rust;
    setTextEngine(old);
    try {
      expect(canType()).toBe(false);
      expect(typeModel(boxOf('HELLO'), 'HELLO')).toBeNull();
    } finally {
      setTextEngine(rust);
    }
    expect(typeof lineCarets).toBe('function');
  });

  it('a size or a spacing that is no number is refused by the engine, not answered with positions that are none', () => {
    const face = faceFor(style(), 60);
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => rust.lineCarets({ ...face, size: bad }, 'a'), `size ${bad}`).toThrow(/lineCarets/);
    }
    // The adapter reads a spacing that is no number as none; an endless one reaches the engine.
    expect(rust.lineCarets(face, 'a', NaN).x).toEqual([expect.any(Number)]);
    expect(() => rust.lineCarets(face, 'a', Infinity)).toThrow(/lineCarets/);
    expect(() => linePens(rust, { ...face, size: NaN }, 'a', 0)).toThrow();
  });

  it('an engine that answers with a position that is no number is not believed', () => {
    const answer = (over) => ({ lineCarets: () => ({ at: [0, 1], x: [0, 10], length: 2, advance: 20, ...over }) });
    expect(linePens(answer({}), null, 'ab', 0)).toEqual({ at: [0, 1], x: [0, 10], end: 20 });
    expect(() => linePens(answer({ x: [0, NaN] }), null, 'ab', 0)).toThrow(/not a number/);
    expect(() => linePens(answer({ advance: Infinity }), null, 'ab', 0)).toThrow(/not a number/);
    expect(() => linePens(answer({ at: [NaN, 1] }), null, 'ab', 0)).toThrow(/not a number/);
  });
});

describe('a letter drawn as two, with the line broken between the two', () => {
  it('the real breaker makes it, and neither row has a caret between the halves', () => {
    // A box too narrow for "ASSB" at this size, with no shape to hold a word whole.
    const box = boxOf('aßb', { uppercase: true, size: 40, shape: 'off' }, { w: 60, h: 300 });
    const m = typeModel(box, 'aßb');
    expect(m.kind).toBe('flat');
    expect(m.lines).toEqual(['AS', 'SB']);
    const [a, b] = m.rows;
    expect(a.offs).toEqual([0, 1]);
    expect(b.offs).toEqual([2, 3]);
    expect(a.soft).toBe(false);
    // The halves` far edges: the end of the first S, the start of the second.
    const pens = linePens(rust, faceFor(box.style, 40), 'AS', 0);
    expect(a.trail).toEqual({ x: a.xs[0] + pens.end, o: 2 });
    expect(b.lead).toEqual({ x: b.xs[0] - (linePens(rust, faceFor(box.style, 40), 'SB', 0).x[1]), o: 1 });
    // The letter selected is on both rows; a caret at either side of it is
    // at a stop, never at an edge between.
    const marks = selectionRects(m.rows, 1, 2);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({ x: a.xs[1], y: a.top, w: a.trail.x - a.xs[1] });
    expect(marks[1]).toMatchObject({ x: b.lead.x, y: b.top, w: b.xs[0] - b.lead.x });
    expect(marks[0].w).toBeGreaterThan(10);
    expect(marks[1].w).toBeCloseTo(marks[0].w, 6);
    for (const up of [false, true]) {
      expect(caretAt(m.rows, 1, up)).toMatchObject({ row: 0, x: a.xs[1] });
      expect(caretAt(m.rows, 2, up)).toMatchObject({ row: 1, x: b.xs[0] });
    }
  });
});

describe('in pixels: a glyph`s ink starts at the caret before it plus its own left bearing', () => {
  it('a kerned pair: V stands closer to A than A`s advance', () => {
    const rows = expectInkAtCarets('AVAVA');
    // The proof that this line IS kerned, or the case shows nothing.
    const a = rust.advance(faceFor(style(), 60), 'A');
    expect(rows[1].stop - rows[0].stop).toBeLessThan(a - 1);
  });

  it('a ligature: "fi" is one cluster, and the letter after it stands after it', () => {
    const over = { font: 'DejaVu Sans' };
    const rows = expectInkAtCarets('afib', over);
    expect(rows.map((r) => r.glyph)).toEqual(['a', 'fi', 'b']);
    // Inside the ligature the caret is half way across it.
    const m = typeModel(boxOf('afib', over), 'afib');
    expect(caretAt(m.rows, 2).x).toBeCloseTo((caretAt(m.rows, 1).x + caretAt(m.rows, 3).x) / 2, 9);
  });

  it('letter spacing: every later glyph is that much further on', () => {
    const tight = expectInkAtCarets('WAVE');
    const wide = expectInkAtCarets('WAVE', { letterSpacing: 7 });
    wide.forEach((r, i) => expect(r.stop - tight[i].stop).toBeCloseTo(7 * i, 9));
  });

  it('letter spacing breaks the ligature, and each letter has its own stop on its own ink', () => {
    const rows = expectInkAtCarets('afib', { font: 'DejaVu Sans', letterSpacing: 5 });
    expect(rows.map((r) => r.glyph)).toEqual(['a', 'f', 'i', 'b']);
  });

  it('a synthesised bold: the stops are the wider advances the painter steps by', () => {
    const plain = expectInkAtCarets('BOLDER');
    const bold = expectInkAtCarets('BOLDER', { bold: true });
    expect(rust.resolveFace(faceFor(style({ bold: true }), 60)).fauxBold).toBe(true);
    // The rule the app runs under: each advance is size / 36 wider.
    bold.forEach((r, i) => expect(r.stop - plain[i].stop).toBeCloseTo((60 / 36) * i, 9));
  });

  it('a real italic', () => {
    expectInkAtCarets('jiffy', { font: 'DejaVu Sans', italic: true });
    expect(rust.resolveFace(faceFor(style({ font: 'DejaVu Sans', italic: true }), 60)).fauxItalic).toBe(false);
  });

  it('a letter borrowed from another family stands where its own advance puts it and the next after it', () => {
    // Comic Neue has no Cyrillic; DejaVu Sans lends it.
    const rows = expectInkAtCarets('AЖBЖA', {}, { fallbacks: ['DejaVu Sans'] });
    const lent = rust.advance(faceFor(style({ font: 'DejaVu Sans' }), 60), 'Ж');
    expect(rows[2].stop - rows[1].stop).toBeCloseTo(lent, 9);
  });

  it('uppercase: the caret is on the cased glyph', () => {
    rust.setFallbacks([]);
    const box = boxOf('wave', { uppercase: true });
    const m = typeModel(box, 'wave');
    const upper = typeModel(boxOf('WAVE'), 'WAVE');
    expect(m.rows[0].xs).toEqual(upper.rows[0].xs);
    expect(m.map).toBeNull();
  });
});

describe('a line starts where the painter starts it', () => {
  // The whole line`s leftmost ink is the first caret plus the first glyph`s
  // bearing, for each alignment - with letter spacing, whose trailing gap is
  // in the advance a centred line is centred by.
  for (const align of ['left', 'center', 'right']) {
    for (const letterSpacing of [0, 9]) {
      it(`${align}, letter spacing ${letterSpacing}`, () => {
        const text = 'WAVE';
        const box = boxOf(text, { align, letterSpacing });
        const m = typeModel(box, text);
        const face = faceFor(box.style, 60);
        const p = painted(box);
        let seen = null;
        for (let x = p.from; x < p.to && seen == null; x++) if (p.col(x) > 24) seen = x;
        const want = (caretAt(m.rows, 0).x - rust.lineInk(face, 'W').left) * SS;
        expect(Math.abs(seen - Math.floor(want)), `${align}: ink from ${seen}, the first caret says ${want.toFixed(2)}`).toBeLessThanOrEqual(1);
        // And the last stop is the first plus the advance the painter aligns by.
        const pens = linePens(rust, face, text, letterSpacing);
        expect(caretAt(m.rows, 4).x - caretAt(m.rows, 0).x).toBeCloseTo(pens.end, 9);
        const inset = textInset(box.style);
        const edge = { left: inset, center: box.w / 2 - pens.end / 2, right: box.w - inset - pens.end }[align];
        expect(caretAt(m.rows, 0).x).toBeCloseTo(edge, 9);
      });
    }
  }
});

describe('the rows of a wrapped box are the painter`s lines', () => {
  it('each row is one of placeBlock`s lines, at its top, a line high', () => {
    const text = 'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG';
    const box = boxOf(text, { size: 30, align: 'center', valign: 'middle', shape: 'on' }, { w: 220, h: 200 });
    const m = typeModel(box, text);
    const place = placeBlock(boxCandidate(box, text));
    expect(place.lines.length).toBeGreaterThan(2);
    expect(m.lines).toEqual(place.lines);
    expect(m.rows.map((r) => r.line)).toEqual(place.lines.map((_, i) => i));
    m.rows.forEach((r, i) => {
      expect(r.top).toBe(place.blockY + i * place.lineH);
      expect(r.height).toBe(place.lineH);
      // The row`s letters are the line`s: from its first body stop, as many
      // offsets as the line has characters.
      const from = text.indexOf(place.lines[i], i ? m.rows[i - 1].offs.at(-1) - 1 : 0);
      expect(text.slice(from, from + place.lines[i].length)).toBe(place.lines[i]);
      expect(r.offs).toContain(from);
      expect(r.offs).toContain(from + place.lines[i].length);
      // Centred: the line`s two ends are as far from the box`s middle.
      const pens = linePens(rust, faceFor(box.style, 30), place.lines[i], 0);
      expect(caretAt([r], from).x).toBeCloseTo(box.w / 2 - pens.end / 2, 9);
    });
    // Every wrap but the last line`s is shared with the row below.
    expect(m.rows.slice(0, -1).every((r) => r.soft)).toBe(true);
    expect(m.rows.at(-1).soft).toBe(false);
    for (let i = 0; i + 1 < m.rows.length; i++) {
      const shared = m.rows[i].offs.at(-1);
      expect(m.rows[i + 1].offs[0]).toBe(shared);
      expect(rowOf(m.rows, shared)).toBe(i + 1);
      expect(rowOf(m.rows, shared, true)).toBe(i);
    }
  });

  it('a click on the middle of a letter`s left half is the offset before it, its right half the offset after', () => {
    const text = 'WAIT FOR ME\nOVER THERE';
    const box = boxOf(text, { size: 30, align: 'center', valign: 'middle' }, { w: 400, h: 120 });
    const m = typeModel(box, text);
    expect(m.rows).toHaveLength(2);
    for (const r of m.rows) {
      for (let k = 0; k + 1 < r.offs.length; k++) {
        const a = r.xs[k];
        const b = r.xs[k + 1];
        const y = r.top + r.height / 2;
        expect(offsetAt(m.rows, a + (b - a) * 0.25, y).o).toBe(r.offs[k]);
        expect(offsetAt(m.rows, a + (b - a) * 0.75, y).o).toBe(r.offs[k + 1]);
      }
    }
  });

  it('an empty box has its caret where a letter would start', () => {
    for (const [align, x] of [['left', (b) => textInset(b.style)], ['center', (b) => b.w / 2], ['right', (b) => b.w - textInset(b.style)]]) {
      const box = boxOf('', { align });
      const m = typeModel(box, '');
      expect(m.rows).toHaveLength(1);
      expect(caretAt(m.rows, 0).x).toBeCloseTo(x(box), 9);
    }
  });

  it('hidden spaces hang by the engine`s own space, letter spacing included', () => {
    const box = boxOf('AB  ', { letterSpacing: 3 });
    const m = typeModel(box, 'AB  ');
    const sp = rust.advance(faceFor(box.style, 60), ' ') + 3;
    expect(m.rows[0].offs).toEqual([0, 1, 2, 3, 4]);
    expect(m.rows[0].xs[3] - m.rows[0].xs[2]).toBeCloseTo(sp, 9);
    expect(m.rows[0].xs[4] - m.rows[0].xs[2]).toBeCloseTo(2 * sp, 9);
  });
});

describe('casing that changes the length', () => {
  it('"ß" drawn as "SS": the stops either side of it are two glyphs apart, and none is between', () => {
    const text = 'Maße';
    const box = boxOf(text, { uppercase: true });
    const m = typeModel(box, text);
    expect(m.kind).toBe('flat');
    expect(m.map.toDrawn).toEqual([0, 1, 2, 4, 5]);
    const cased = typeModel(boxOf('MASSE'), 'MASSE');
    expect(m.rows[0].offs).toEqual([0, 1, 2, 3, 4]);
    expect(m.rows[0].xs).toEqual([0, 1, 2, 4, 5].map((d) => cased.rows[0].xs[d]));
  });
});

describe('text on a curve', () => {
  it('the glyphs are the ones the painter is given', () => {
    const text = 'ALONG AN ARC';
    const box = boxOf(text, { size: 30, curve: 45, align: 'center', valign: 'middle' }, { w: 300, h: 120 });
    const m = typeModel(box, text);
    expect(m.kind).toBe('curve');
    expect(m.glyphs).toEqual(placeBlock(boxCandidate(box, text)).layout);
    expect(m.glyphs).toHaveLength(text.length);
    expect(m.map).toBeNull();
  });

  it('a curved box with nothing in it is straight, as the painter has it: one row', () => {
    const box = boxOf('', { size: 30, curve: 45, align: 'center' }, { w: 300, h: 120 });
    const m = typeModel(box, '');
    expect(m.kind).toBe('flat');
    expect(m.rows).toHaveLength(1);
  });
});

// ===========================================================================
// No caret inside a grapheme, whatever the lines break in
// ===========================================================================
// A box can be narrower than one user-perceived character: a flag is two
// letters to the breaker, a family is seven, a syllable written in jamo is
// three, and a letter cased to two can have a mark of its own. The lines then
// break INSIDE it - they are the painter's lines and stay as they are - but a
// caret may not stand there: a letter typed there would take the thing apart.
// The rule is one (`caretStops`, flat-caret.js). This is its check on the real
// engine's rows, for texts chosen to be hard, at widths down to narrower than
// one letter, in both cases.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const boundaries = (text) => {
  const at = new Set([text.length]);
  for (const { index } of graphemes.segment(text)) at.add(index);
  return at;
};
const HARD = {
  'two flags': '\u{1F1FA}\u{1F1F8}\u{1F1EF}\u{1F1F5}',
  'a family between letters': 'a\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}b',
  'syllables written in jamo': '각한',
  'a mark with no letter, first': '́abc',
  'a letter cased to two, with a mark of its own': 'aß́b',
  'the fi letter, twice': 'ﬁn ﬁ',
  'variation selectors': '☺️a︎✌️',
  'a lone surrogate': 'a\uD83Db',
  'two marks on one letter': 'xé̂x',
  'among words': 'ab \u{1F1FA}\u{1F1F8} é cd',
  'on two paragraphs': '\u{1F1FA}\u{1F1F8}\n각',
};
const WIDTHS = [900, 120, 55, 40, 25, 8];
const sorted = (set) => [...set].sort((a, b) => a - b);

describe('a caret never stands inside a grapheme of the text typed', () => {
  it.each(Object.entries(HARD))('%s', (name, text) => {
    const B = boundaries(text);
    let models = 0;
    for (const w of WIDTHS) {
      for (const uppercase of [false, true]) {
        const say = `${name}, ${w} px wide${uppercase ? ', uppercase' : ''}`;
        const box = boxOf(text, { size: 40, uppercase }, { w, h: 600 });
        const m = typeModel(box, text);
        expect(m?.kind, say).toBe('flat');
        models++;
        // Every stop the model gives is a boundary of the raw text, and every
        // boundary is a stop somewhere: nothing is left out of reach.
        const stops = new Set();
        for (const r of m.rows) {
          for (const [k, o] of r.offs.entries()) {
            expect(B.has(o), `${say}: a stop at ${o}, inside a grapheme`).toBe(true);
            expect(Number.isFinite(r.xs[k]), `${say}: the stop at ${o} has a place`).toBe(true);
            stops.add(o);
          }
          for (const half of [r.lead, r.trail]) {
            if (half) expect(B.has(half.o), `${say}: a half names ${half.o}, inside a grapheme`).toBe(true);
          }
          // A row that holds nothing but the inside of one says so on both sides.
          if (!r.offs.length) expect(r.lead && r.trail, `${say}: a row with no stop and no half`).toBeTruthy();
        }
        expect(sorted(stops), say).toEqual(sorted(B));
        // Left and Right from every stop move, by stops, and end.
        for (const from of stops) {
          for (const [key, end] of [['ArrowRight', text.length], ['ArrowLeft', 0]]) {
            let f = from;
            let steps = 0;
            while (f !== end) {
              const to = moveCaret(m.rows, text, { a: f, f }, key);
              expect(key === 'ArrowRight' ? to.f > f : to.f < f, `${say}: ${key} from ${f} went to ${to.f}`).toBe(true);
              expect(stops.has(to.f), `${say}: ${key} from ${f} landed on ${to.f}`).toBe(true);
              expect(caretAt(m.rows, to.f, to.up), `${say}: a caret at ${to.f}`).not.toBeNull();
              f = to.f;
              expect(++steps, `${say}: ${key} from ${from} does not end`).toBeLessThanOrEqual(text.length);
            }
          }
        }
        // A press on either half of every drawn cluster lands on a stop.
        const place = placeBlock(boxCandidate(box, text));
        const face = faceFor(box.style, 40);
        place.lines.forEach((line, i) => {
          if (line === '') return;
          const pens = linePens(rust, face, line, 0);
          const y = place.blockY + (i + 0.5) * place.lineH;
          pens.at.forEach((_, c) => {
            const from = place.lineX[i] + pens.x[c];
            const to = place.lineX[i] + (pens.x[c + 1] ?? pens.end);
            for (const part of [0.25, 0.75]) {
              const hit = offsetAt(m.rows, from + (to - from) * part, y);
              expect(stops.has(hit.o), `${say}: a press on cluster ${c} of line ${i} went to ${hit.o}`).toBe(true);
              expect(caretAt(m.rows, hit.o, hit.up), `${say}: a caret where the press went`).not.toBeNull();
            }
          });
        });
        // And a letter typed where any press can go leaves every grapheme
        // whole. (A mark with no letter before it takes the letter typed in
        // front of it for its own: that is what the mark is, not a caret
        // inside anything.)
        for (const o of stops) {
          if (/^\p{M}/u.test(text.slice(o))) continue;
          const typed = rawEdit(text, [o, o], 'insertText', 'X').v;
          expect([...graphemes.segment(typed)].map((g) => g.segment).filter((g) => g !== 'X').join(''), `${say}: an X typed at ${o}`).toBe(text);
        }
      }
    }
    expect(models).toBe(WIDTHS.length * 2);
  });

  it('a flag in a box narrower than it: the lines break inside it and no caret does', () => {
    const text = '\u{1F1FA}\u{1F1F8}';
    const box = boxOf(text, { size: 40 }, { w: 25, h: 300 });
    const m = typeModel(box, text);
    expect(m.lines).toEqual(['\u{1F1FA}', '\u{1F1F8}']);
    const [a, b] = m.rows;
    expect([a.offs, b.offs]).toEqual([[0], [4]]);
    expect(a.trail.o).toBe(4);
    expect(b.lead.o).toBe(0);
    expect(a.soft).toBe(false);
    // The end of the first row is the flag's end, on the row that has it.
    const hit = offsetAt(m.rows, a.trail.x + 1, a.top + 5);
    expect(hit.o).toBe(4);
    expect(rawEdit(text, [hit.o, hit.o], 'insertText', 'X').v).toBe(`${text}X`);
    expect(caretAt(m.rows, 4, hit.up)).toMatchObject({ row: 1, x: b.xs[0] });
    // The flag selected is both its halves.
    const marks = selectionRects(m.rows, 0, 4);
    expect(marks.map((r) => r.y)).toEqual([a.top, b.top]);
    expect(marks.every((r) => r.w > 5)).toBe(true);
  });

  it('a family and a syllable in jamo, as narrow: rows that hold only the inside of one have no stop', () => {
    for (const text of ['\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}', '각']) {
      const box = boxOf(text, { size: 40 }, { w: 25, h: 900 });
      const m = typeModel(box, text);
      expect(m.rows.length, text).toBeGreaterThan(2);
      expect(m.rows.flatMap((r) => r.offs), text).toEqual([0, text.length]);
      const inner = m.rows.slice(1, -1);
      expect(inner.every((r) => !r.offs.length && r.lead.o === 0 && r.trail.o === text.length), text).toBe(true);
      // A press anywhere on it is one of its two sides, and all of it is selected at once.
      for (const r of m.rows) {
        for (const x of [r.lead?.x ?? r.xs[0], r.trail?.x ?? r.xs[0]]) expect([0, text.length], text).toContain(offsetAt(m.rows, x, r.top + 5).o);
      }
      expect(selectionRects(m.rows, 0, text.length), text).toHaveLength(m.rows.length);
      // Down from its start is its end, and Up from there its start: no row in between holds the caret.
      expect(moveCaret(m.rows, text, { a: 0, f: 0 }, 'ArrowDown').f, text).toBe(text.length);
      expect(moveCaret(m.rows, text, { a: text.length, f: text.length }, 'ArrowUp').f, text).toBe(0);
    }
  });

  it('a letter cased to two with a mark of its own, the line broken between the two: the far half names the offset after the mark', () => {
    // The review's text, size and width: "aß" + U+0301 + "b" drawn "AS" / "S" + U+0301 + "B".
    const text = 'aß́b';
    const box = boxOf(text, { size: 40, uppercase: true }, { w: 55, h: 300 });
    const m = typeModel(box, text);
    expect(m.lines).toEqual(['AS', 'ŚB']);
    const [a, b] = m.rows;
    expect(a.offs).toEqual([0, 1]);
    expect(b.offs).toEqual([3, 4]);
    expect(a.trail.o).toBe(3);
    expect(b.lead.o).toBe(1);
    // A press on the upper S's far edge is the offset after the letter AND its mark.
    const hit = offsetAt(m.rows, a.trail.x, a.top + 5);
    expect(hit.o).toBe(3);
    expect(rawEdit(text, [hit.o, hit.o], 'insertText', 'X').v).toBe('aß́Xb');
    // The letter selected, with its mark, is both halves.
    expect(selectionRects(m.rows, 1, 3)).toHaveLength(2);
  });

  it('a size the pens overflow at is refused by the engine, as a size that is no number is', () => {
    const face = faceFor(style(), 60);
    expect(() => rust.lineCarets({ ...face, size: Number.MAX_VALUE }, 'MMMM')).toThrow(/lineCarets/);
    expect(() => rust.lineCarets(face, 'MMMM', Number.MAX_VALUE)).toThrow(/lineCarets/);
    expect(rust.lineCarets({ ...face, size: 1e9 }, 'MMMM').x.every(Number.isFinite)).toBe(true);
  });
});
