import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { rustEngine } from '../test/rust-engine.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { app } from './store.svelte.js';
import { solveLayout } from './auto-layout.js';
import { boxCandidate, placeBlock, containBox } from './contain.js';
import { editLines } from './edit-lines.js';
import {
  canMeasure, lineWidth, fontMetrics, inkShiftY, layoutLines, applyCase, balloonWidthsFor, contentWidth, textInset,
  setTypesetEnabled, typesetEnabled, clearLayoutMemo, faceFor,
} from './measure.js';
import { interiorLineWidths } from './balloon.js';
import { systemFontEntry } from './fonts.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// measure.js, the solver and the editor's lines on the Rust engine
// ===========================================================================
// A sample of what the `realfont` lane expects of the layout code on Skia
// (measure.realfont.test.js, auto-layout.realfont.test.js,
// edit-lines.realfont.test.js), asked again with the Rust engine installed.
// Only expectations that do not depend on who measures are repeated: that real
// advances are used, that lines fit, that the solver's answer holds by the
// check every renderer answers to. What pins a number of Skia's stays in the
// realfont lane, and what needs the painter (ink read off a raster) waits for
// the Rust painter. The few places the engines are meant to differ say so.

const before = { engine: textEngine(), typeset: typesetEnabled(), system: app.fonts.system };
let engine;
beforeAll(async () => {
  engine = await rustEngine();
  setTextEngine(engine);
  setTypesetEnabled(true);
  app.fonts.system = [systemFontEntry({ name: 'DejaVu Sans', faces: { regular: true, italic: true } })];
});
afterAll(() => {
  setTextEngine(before.engine);
  setTypesetEnabled(before.typeset);
  app.fonts.system = before.system;
});
beforeEach(() => clearLayoutMemo());

const SIZE = 26;
const styleFor = (font, extra = {}) => normalizeStyle({ ...defaultStyle(), font, size: SIZE, bold: false, ...extra });

describe('measure.js on the Rust engine (after measure.realfont.test.js)', () => {
  it('measures the face, not the stand-in', () => {
    expect(canMeasure()).toBe(true);
    const s = styleFor('Comic Neue');
    const w = lineWidth('WAVE', s, SIZE);
    expect(Math.abs(w - 4 * SIZE * 0.55)).toBeGreaterThan(1);
    expect(w).toBe(engine.advance(faceFor(s, SIZE), 'WAVE'));
  });

  it('tells the families apart, and refuses a name nobody registered', () => {
    const w = (font) => lineWidth('WAVE', styleFor(font), SIZE);
    expect(w('Bangers')).toBeLessThan(w('Comic Neue') - 10);
    expect(w('DejaVu Sans')).toBeGreaterThan(w('Comic Neue') + 5);
    // Meant to differ: a browser draws an unknown name in the fallback font
    // and the realfont lane expects that width. This engine has no font it
    // was not given, and says so.
    const unknown = styleFor('No Such Font');
    expect(() => lineWidth('NOT MEASURED YET', unknown, SIZE)).toThrow("font 'No Such Font' is not registered");
    expect(() => fontMetrics(styleFor('No Such Font', { size: 31 }), 31)).toThrow("font 'No Such Font' is not registered");
    // Open, for the task that gives the app its "font missing" state: the
    // store resolves an unknown name to the fallback family's CSS, the memo in
    // measure.js is keyed by that CSS, and so a string the fallback family
    // has already measured is answered from the memo without asking anyone.
    expect(faceFor(unknown, SIZE).key).toBe(faceFor(styleFor('Comic Neue'), SIZE).key);
    expect(w('No Such Font')).toBe(w('Comic Neue'));
  });

  it('measures italic in the real oblique face, not a slanted regular', () => {
    const upright = lineWidth('WAVE', styleFor('DejaVu Sans'), SIZE);
    expect(lineWidth('WAVE', styleFor('DejaVu Sans', { italic: true }), SIZE)).not.toBeCloseTo(upright, 1);
  });

  it('lays a tab out as one space, and measures it as one', () => {
    const s = styleFor('Comic Neue');
    expect(layoutLines('WAIT\tWHAT', s, SIZE, 400)).toEqual(['WAIT WHAT']);
    // Meant to differ: Skia measures a tab as a glyph of its own.
    expect(engine.advance(faceFor(s, SIZE), 'A\tB')).toBe(engine.advance(faceFor(s, SIZE), 'A B'));
  });

  it('applies kerning, which no per-character metric can', () => {
    const s = styleFor('Comic Neue');
    expect(lineWidth('WA', s, 100)).toBeLessThan(lineWidth('W', s, 100) + lineWidth('A', s, 100) - 2);
  });

  it("reads the face's own vertical metrics", () => {
    const standIn = { ascent: SIZE * 0.8, descent: SIZE * 0.2 };
    const comic = fontMetrics(styleFor('Comic Neue'), SIZE);
    const bangers = fontMetrics(styleFor('Bangers'), SIZE);
    expect(comic).not.toEqual(standIn);
    expect(bangers).not.toEqual(standIn);
    expect(bangers).not.toEqual(comic);
    expect(comic.ascent + comic.descent).toBeGreaterThan(SIZE);
  });

  it('centres a block on its glyph ink', () => {
    const s = styleFor('Comic Neue');
    expect(inkShiftY(['WAVE'], s, SIZE)).toBeGreaterThan(0);
    expect(inkShiftY(['jumpy gypsy'], s, SIZE)).toBeLessThan(0);
  });

  it('breaks lines at the real advances', () => {
    const s = styleFor('Comic Neue');
    expect(9 * SIZE * 0.55).toBeLessThan(130);
    expect(lineWidth('WAVE WAVE', s, SIZE)).toBeGreaterThan(130);
    const lines = layoutLines('WAVE WAVE', s, SIZE, 130);
    expect(lines.length).toBe(2);
    for (const ln of lines) expect(lineWidth(ln, s, SIZE)).toBeLessThanOrEqual(130);

    const text = 'Nobody told me the lighthouse keeper had a cat, or that the cat had opinions about visitors.';
    for (const font of ['Comic Neue', 'Bangers', 'DejaVu Sans']) {
      const st = styleFor(font);
      const out = layoutLines(applyCase(text, st), st, SIZE, 180);
      expect(out.length).toBeGreaterThan(2);
      for (const ln of out) expect(lineWidth(ln, st, SIZE)).toBeLessThanOrEqual(180);
    }
  });

  it('breaks to the block shape the box asks for, on every path', () => {
    const text = 'WHAT ARE YOU EVEN DOING HERE AT THIS HOUR OF THE NIGHT?';
    const out = {};
    for (const shape of ['auto', 'oval', 'rect']) {
      const st = styleFor('Comic Neue', { shape });
      out[shape] = layoutLines(text, st, SIZE, 200);
      const box = { x: 0, y: 0, w: 200 + 2 * textInset(st), h: 400, style: st };
      expect(placeBlock(boxCandidate(box, text)).lines).toEqual(out[shape]);
      for (const ln of out[shape]) expect(lineWidth(ln, st, SIZE)).toBeLessThanOrEqual(200);
    }
    expect(out.oval).not.toEqual(out.auto);
    expect(lineWidth(out.oval[0], styleFor('Comic Neue'), SIZE)).toBeLessThan(lineWidth(out.oval[2], styleFor('Comic Neue'), SIZE));
    expect(out.rect).toEqual(out.auto);
  });

  it('breaks plain text with the engine where the realfont lane has no breaker at all', () => {
    // With the typesetting beta off `layoutLines` asks the plain breaker, which
    // in the realfont lane is a DOM that is not there.
    setTypesetEnabled(false);
    try {
      const s = styleFor('Comic Neue');
      const lines = layoutLines('WHAT ARE YOU EVEN DOING HERE?', s, SIZE, 130);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.join(' ')).toBe('WHAT ARE YOU EVEN DOING HERE?');
      for (const ln of lines) expect(lineWidth(ln, s, SIZE)).toBeLessThanOrEqual(130);
    } finally {
      setTypesetEnabled(true);
    }
  });
});

describe('solveLayout on the Rust engine (after auto-layout.realfont.test.js)', () => {
  const style = (font, extra = {}) => normalizeStyle({ ...defaultStyle(), font, bold: false, ...extra });
  const OVAL = { kind: 'ellipse', cx: 350, cy: 320, rx: 165, ry: 115 };
  const TEXT = 'If we leave right now, we can still catch the last train before the storm hits.';

  function holds(r, s0, text, fit) {
    const box = { x: r.x, y: r.y, w: r.w, h: r.h, style: { ...s0, size: r.size }, fit };
    const s = box.style;
    expect(containBox(boxCandidate(box, text)).fits).toBe(true);
    expect(r.lines).toEqual(layoutLines(applyCase(text, s), s, r.size, contentWidth(r.w, s), balloonWidthsFor(box, s, r.size)));
    if (fit?.kind === 'ellipse') {
      const rows = interiorLineWidths(fit, r.size * s.lineHeight, r.lines.length, s.valign);
      const ti = textInset(s);
      r.lines.forEach((line, i) => expect(lineWidth(line, s, r.size) + 2 * ti).toBeLessThanOrEqual(rows[i] + 0.5));
    }
  }

  it('keeps the reference size when the balloon holds it', () => {
    const s = style('Comic Neue');
    const r = solveLayout({ text: TEXT, style: s, refSize: 22, region: OVAL, opts: { minSize: 12 } });
    expect(r.status).toBe('ok');
    expect(r.size).toBe(22);
    holds(r, s, TEXT, OVAL);
  });

  it('shrinks an oversized reference to fit the oval, ink and rows included', () => {
    const s = style('Comic Neue');
    const r = solveLayout({ text: TEXT, style: s, refSize: 48, region: OVAL, opts: { minSize: 12 } });
    expect(r.status).toBe('shrunk');
    expect(r.size).toBeLessThan(48);
    holds(r, s, TEXT, OVAL);
  });

  it('brings 20 and 40 to about the same size in a balloon that holds about 20 (FIT-1)', () => {
    const s = style('Comic Neue');
    const tight = { kind: 'ellipse', cx: 350, cy: 320, rx: 120, ry: 85 };
    const a = solveLayout({ text: TEXT, style: s, refSize: 20, region: tight, opts: { minSize: 12 } });
    const b = solveLayout({ text: TEXT, style: s, refSize: 40, region: tight, opts: { minSize: 12 } });
    expect(b.size).toBeLessThan(40);
    expect(Math.abs(b.size - a.size)).toBeLessThanOrEqual(3);
    holds(b, s, TEXT, tight);
  });

  it('keeps a heavy outline inside the box', () => {
    const s = style('Bangers', { strokes: [{ color: '#ffffff', width: 6, opacity: 1 }] });
    const rect = { kind: 'rect', x: 80, y: 60, w: 420, h: 120 };
    const text = 'Meanwhile, far beneath the city, something stirred.';
    const r = solveLayout({ text, style: s, refSize: 34, region: rect, opts: { minSize: 12 } });
    expect(['ok', 'shrunk']).toContain(r.status);
    holds(r, s, text, rect);
  });

  it('hugs the ink of a heavy outline without shrinking the text for it', () => {
    const s = style('Bangers', { strokes: [{ color: '#ffffff', width: 6, opacity: 1 }] });
    const text = 'STAY BEHIND ME!';
    const r = solveLayout({ text, style: s, refSize: 34, region: { kind: 'hint', x: 350, y: 540, w: 0, h: 0 } });
    expect(r.status).toBe('no-region');
    expect(r.size).toBe(34);
    holds(r, s, text, null);
  });

  it('sizes a box from a location alone, in an italic whose lean reaches past its advance', () => {
    const s = style('DejaVu Sans', { italic: true });
    const r = solveLayout({ text: TEXT, style: s, refSize: 20, region: { kind: 'hint', x: 300, y: 300, w: 40, h: 120 } });
    expect(r.status).toBe('no-region');
    expect(r.w).toBeGreaterThan(r.h);
    holds(r, s, TEXT, null);
  });

  it('sets centred text in a round balloon as a round block, tapered at both ends', () => {
    const s = style('Comic Neue', { align: 'center' });
    const round = { kind: 'ellipse', cx: 350, cy: 320, rx: 150, ry: 130 };
    const r = solveLayout({ text: TEXT, style: s, refSize: 22, region: round, opts: { minSize: 12 } });
    expect(r.status).toBe('ok');
    expect(r.lines.length).toBeGreaterThanOrEqual(5);
    const ws = r.lines.map((l) => lineWidth(l, { ...s, size: r.size }, r.size));
    const widest = Math.max(...ws);
    expect(ws[0]).toBeLessThan(0.8 * widest);
    expect(ws[ws.length - 1]).toBeLessThan(0.8 * widest);
    expect(r.x + r.w / 2).toBeCloseTo(round.cx, 6);
    holds(r, s, TEXT, round);
  });
});

describe('solveLayout on the Rust engine, the rectangle silhouette', () => {
  it('leaves a rectangle silhouette at the balloon s width', () => {
    const s = normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', bold: false, align: 'center', shape: 'rect' });
    const text = 'If we leave right now, we can still catch the last train before the storm hits.';
    const round = { kind: 'ellipse', cx: 350, cy: 320, rx: 150, ry: 130 };
    const r = solveLayout({ text, style: s, refSize: 22, region: round, opts: { minSize: 12 } });
    expect(r.lines.length).toBeLessThanOrEqual(3);
    const box = { x: r.x, y: r.y, w: r.w, h: r.h, style: { ...s, size: r.size }, fit: round };
    expect(containBox(boxCandidate(box, text)).fits).toBe(true);
  });
});

describe('while editing, the lines are layoutLines on the Rust engine (after edit-lines.realfont.test.js)', () => {
  const shown = (seg, s) => applyCase(seg.body, s).replace(/\t/g, ' ') + (seg.hyphen ? '-' : '');
  const joined = (segs) => segs.map((g) => g.head + g.body + g.tail).join('');
  const TEXTS = [
    'I never thought I would see the day when the whole village turned out for a festival like this one.',
    'Wait.\n\nYou mean the one with the red door? The one nobody has opened since the war?',
    'Unquestionably, extraordinarily, incomprehensibly complicated negotiations.',
    '  She said:\n  "Not today."',
    'mother-in-law\tand the co-op',
    'Whatever happens next\n',
  ];

  for (const [font, uppercase] of [['Comic Neue', false], ['Comic Neue', true], ['Bangers', false], ['Bangers', true]]) {
    it(`${font}${uppercase ? ', uppercase' : ''}: flat width and balloon`, () => {
      const s = normalizeStyle({ ...defaultStyle(), font, size: 24, bold: false, uppercase });
      let hyphens = 0;
      for (const w of [90, 150, 240]) {
        const box = { x: 0, y: 0, w, h: 200, fit: { kind: 'ellipse', cx: w / 2, cy: 100, rx: w / 2 + 20, ry: 110 } };
        for (const withBalloon of [false, true]) {
          for (const text of TEXTS) {
            const cased = applyCase(text, s);
            const lines = layoutLines(cased, s, s.size, contentWidth(w, s), withBalloon ? balloonWidthsFor(box, s, s.size) : undefined);
            const segs = editLines(text, cased, lines);
            expect(segs, text).not.toBeNull();
            expect(segs.map((g) => shown(g, s))).toEqual(lines);
            expect(joined(segs)).toBe(text);
            hyphens += segs.filter((g) => g.hyphen).length;
          }
        }
      }
      expect(hyphens).toBeGreaterThan(0);
    });
  }
});
