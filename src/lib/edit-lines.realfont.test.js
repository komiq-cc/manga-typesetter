import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { editLines } from './edit-lines.js';
import {
  canMeasure,
  layoutLines,
  applyCase,
  contentWidth,
  balloonWidthsFor,
  setTypesetEnabled,
  clearLayoutMemo,
} from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// UX-4 with real fonts: the box being typed into breaks where the result does
// ===========================================================================
// The doc's test (06-editor-ux-and-commands.md): while editing, the rendered
// line breaks equal `layoutLines(...)` for the same text and box. The editable
// renders one line element per `editLines` entry, drawing its body (uppercased
// by CSS when the style says so) and the hyphen it adds - so the lines it draws
// are `shown` below, and they have to be the lines the canvas and the export
// draw, for the same box: its content width, and its balloon when it has one.
// Here with real advances and the real hyphenator, where invented hyphens and
// balloon-shaped line counts actually happen.

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

beforeAll(() => {
  setTypesetEnabled(true);
  clearLayoutMemo();
});
afterAll(() => {
  setTypesetEnabled(false);
  clearLayoutMemo();
});

describe('while editing, the lines are layoutLines (UX-4, real fonts)', () => {
  it('measures with a real canvas', () => {
    expect(canMeasure()).toBe(true);
  });

  for (const font of ['Comic Neue', 'Bangers']) {
    for (const uppercase of [false, true]) {
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
        // The case that motivated it: a break the browser would never make.
        expect(hyphens).toBeGreaterThan(0);
      });
    }
  }
});
