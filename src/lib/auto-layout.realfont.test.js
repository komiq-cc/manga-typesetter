import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { app } from './store.svelte.js';
import { solveLayout } from './auto-layout.js';
import { boxCandidate, containBox } from './contain.js';
import {
  setTypesetEnabled,
  clearLayoutMemo,
  layoutLines,
  applyCase,
  balloonWidthsFor,
  contentWidth,
  textInset,
  lineWidth,
} from './measure.js';
import { interiorLineWidths } from './balloon.js';
import { systemFontEntry } from './fonts.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// The auto-layout solver, with real faces
// ===========================================================================
// The unit file proves the search on the stand-in metric. This one proves the
// answer holds with real advances, kerning, vertical metrics and outlines: the
// ink fits the box by the check every renderer answers to, every line fits its
// row of the balloon, and the lines are the ones the editor and the exporters
// lay the box out in.

const styleFor = (font, extra = {}) => normalizeStyle({ ...defaultStyle(), font, bold: false, ...extra });

beforeAll(() => {
  setTypesetEnabled(true);
  app.fonts.system = [systemFontEntry({ name: 'DejaVu Sans', faces: { regular: true, italic: true } })];
});
beforeEach(() => clearLayoutMemo());

const OVAL = { kind: 'ellipse', cx: 350, cy: 320, rx: 165, ry: 115 };
const TEXT = 'If we leave right now, we can still catch the last train before the storm hits.';

function holds(r, style, text, fit) {
  const box = { x: r.x, y: r.y, w: r.w, h: r.h, style: { ...style, size: r.size }, fit };
  const s = box.style;
  expect(containBox(boxCandidate(box, text)).fits).toBe(true);
  expect(r.lines).toEqual(layoutLines(applyCase(text, s), s, r.size, contentWidth(r.w, s), balloonWidthsFor(box, s, r.size)));
  if (fit?.kind === 'ellipse') {
    const rows = interiorLineWidths(fit, r.size * s.lineHeight, r.lines.length, s.valign);
    const ti = textInset(s);
    r.lines.forEach((line, i) => expect(lineWidth(line, s, r.size) + 2 * ti).toBeLessThanOrEqual(rows[i] + 0.5));
  }
}

describe('solveLayout with real fonts', () => {
  it('keeps the reference size when the balloon holds it', () => {
    const s = styleFor('Comic Neue');
    const r = solveLayout({ text: TEXT, style: s, refSize: 22, region: OVAL, opts: { minSize: 12 } });
    expect(r.status).toBe('ok');
    expect(r.size).toBe(22);
    holds(r, s, TEXT, OVAL);
  });

  it('shrinks an oversized reference to fit the oval, ink and rows included', () => {
    const s = styleFor('Comic Neue');
    const r = solveLayout({ text: TEXT, style: s, refSize: 48, region: OVAL, opts: { minSize: 12 } });
    expect(r.status).toBe('shrunk');
    expect(r.size).toBeLessThan(48);
    holds(r, s, TEXT, OVAL);
  });

  it('brings 20 and 40 to about the same size in a balloon that holds about 20 (FIT-1)', () => {
    const s = styleFor('Comic Neue');
    const tight = { kind: 'ellipse', cx: 350, cy: 320, rx: 120, ry: 85 };
    const a = solveLayout({ text: TEXT, style: s, refSize: 20, region: tight, opts: { minSize: 12 } });
    const b = solveLayout({ text: TEXT, style: s, refSize: 40, region: tight, opts: { minSize: 12 } });
    expect(b.size).toBeLessThan(40);
    expect(Math.abs(b.size - a.size)).toBeLessThanOrEqual(3);
    holds(b, s, TEXT, tight);
  });

  it('keeps a heavy outline inside the box', () => {
    const s = styleFor('Bangers', { strokes: [{ color: '#ffffff', width: 6, opacity: 1 }] });
    const rect = { kind: 'rect', x: 80, y: 60, w: 420, h: 120 };
    const text = 'Meanwhile, far beneath the city, something stirred.';
    const r = solveLayout({ text, style: s, refSize: 34, region: rect, opts: { minSize: 12 } });
    expect(['ok', 'shrunk']).toContain(r.status);
    holds(r, s, text, rect);
  });

  // FIT-3: a box sized from the text alone hugs its lines, and has to hug their
  // ink. Hugged to the advances, the outline was past the sides at every width,
  // and the search shrank the font instead: 34 came back 29.
  it('hugs the ink of a heavy outline without shrinking the text for it', () => {
    const s = styleFor('Bangers', { strokes: [{ color: '#ffffff', width: 6, opacity: 1 }] });
    const text = 'STAY BEHIND ME!';
    const r = solveLayout({ text, style: s, refSize: 34, region: { kind: 'hint', x: 350, y: 540, w: 0, h: 0 } });
    expect(r.status).toBe('no-region');
    expect(r.size).toBe(34);
    holds(r, s, text, null);
  });

  it('sizes a box from a location alone, in an italic whose lean reaches past its advance', () => {
    const s = styleFor('DejaVu Sans', { italic: true });
    const r = solveLayout({ text: TEXT, style: s, refSize: 20, region: { kind: 'hint', x: 300, y: 300, w: 40, h: 120 } });
    expect(r.status).toBe('no-region');
    expect(r.w).toBeGreaterThan(r.h);
    holds(r, s, TEXT, null);
  });

  // A round balloon used to get a flat band: the box as wide as the balloon and
  // the text on as few lines as that holds. It is now the roundest block the
  // balloon holds - narrower, more lines, short at the top and the bottom.
  it('sets centred text in a round balloon as a round block, tapered at both ends', () => {
    const s = styleFor('Comic Neue', { align: 'center' });
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

  it('leaves a rectangle silhouette at the balloon s width', () => {
    const s = styleFor('Comic Neue', { align: 'center', shape: 'rect' });
    const round = { kind: 'ellipse', cx: 350, cy: 320, rx: 150, ry: 130 };
    const r = solveLayout({ text: TEXT, style: s, refSize: 22, region: round, opts: { minSize: 12 } });
    expect(r.lines.length).toBeLessThanOrEqual(3);
    holds(r, s, TEXT, round);
  });
});
