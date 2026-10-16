import { describe, it, expect } from 'vitest';
import { glyphIndex, rawIndex, glyphsMatch, caretAt, caretNearest, glyphNearest, selectionBoxes, caretKey, wordAt, glyphReach } from './curve-caret.js';
import { arcLayout, circleLayout, pathLayout } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';

// The stand-in metric (no canvas): every glyph is 0.55 x size wide, so at size
// 20 a glyph is 11 px and its caret edges are 5.5 px either side of its centre.
const style = (over = {}) => normalizeStyle({ ...defaultStyle(), size: 20, ...over });
const near = (p, q) => {
  expect(p.x).toBeCloseTo(q.x, 6);
  expect(p.y).toBeCloseTo(q.y, 6);
};

describe('raw offsets and glyphs', () => {
  it('counts an emoji as one glyph and two code units', () => {
    const t = 'a\u{1F44D}b';
    expect([0, 1, 3, 4].map((o) => glyphIndex(t, o))).toEqual([0, 1, 2, 3]);
    expect([0, 1, 2, 3].map((i) => rawIndex(t, i))).toEqual([0, 1, 3, 4]);
    // A raw offset inside the pair goes to the glyph after it.
    expect(glyphIndex(t, 2)).toBe(2);
  });

  it('matches glyphs to characters unless uppercasing changed the count', () => {
    expect(glyphsMatch('Hey', 'HEY')).toBe(true);
    expect(glyphsMatch('groß', 'GROSS')).toBe(false);
  });
});

describe('caretAt: the caret on the glyphs', () => {
  it('stands on the flat line at the glyph edges, the gap halved', () => {
    // curve 0 is a straight line through the centre; 3 glyphs, 11 px each,
    // 4 px letter spacing: centres at -15, 0, 15.
    const g = arcLayout('abc', style({ curve: 0, letterSpacing: 4 }), 20);
    expect(g.map((q) => Math.round(q.x * 1e6) / 1e6)).toEqual([-15, 0, 15]);
    expect([0, 1, 2, 3].map((i) => Math.round(caretAt(g, i).x * 1e6) / 1e6)).toEqual([-20.5, -7.5, 7.5, 20.5]);
  });

  it('leans with the text on an arc, and meets the glyph edges', () => {
    const g = arcLayout('hello', style({ curve: 60 }), 20);
    const c0 = caretAt(g, 0);
    const c5 = caretAt(g, 5);
    expect(c0.rot).toBeCloseTo(g[0].rot, 9);
    expect(c5.rot).toBeCloseTo(g[4].rot, 9);
    near(c0, { x: g[0].x - 5.5 * Math.cos(g[0].rot), y: g[0].y - 5.5 * Math.sin(g[0].rot) });
    // Between two glyphs it is turned halfway between them.
    expect(caretAt(g, 2).rot).toBeCloseTo((g[1].rot + g[2].rot) / 2, 9);
  });

  it('stands at the box centre when there is no text', () => {
    expect(caretAt([], 0)).toEqual({ x: 0, y: 0, rot: 0 });
  });
});

describe('caretNearest: the offset a click lands at', () => {
  const layouts = {
    arc: arcLayout('hello world', style({ curve: 70 }), 20),
    circle: circleLayout('around we go', style({ circle: { on: true } }), 20),
    'circle, inner face': circleLayout('around we go', style({ circle: { on: true, inside: true } }), 20),
    path: pathLayout(
      'on a path',
      style({ path: { on: true, pts: [{ x: 0, y: 80, ix: 0, iy: 0, ox: 60, oy: -90 }, { x: 200, y: 80, ix: -60, iy: -90, ox: 0, oy: 0 }] } }),
      20,
      200,
      100,
    ),
  };

  for (const [name, g] of Object.entries(layouts)) {
    it(`lands on every caret it is pointed at (${name})`, () => {
      expect(g.length).toBeGreaterThan(5);
      for (let i = 0; i <= g.length; i++) {
        const c = caretAt(g, i);
        expect(caretNearest(g, c.x, c.y), `caret ${i}`).toBe(i);
      }
    });

    it(`takes the nearer side of a glyph, above or below the line too (${name})`, () => {
      for (let i = 0; i < g.length; i++) {
        const q = g[i];
        const c = Math.cos(q.rot);
        const sn = Math.sin(q.rot);
        // A quarter of the way in from either edge, and a little off the line.
        const at = (along, across) => [q.x + along * c - across * sn, q.y + along * sn + across * c];
        expect(caretNearest(g, ...at(-q.w / 4, 3))).toBe(i);
        expect(caretNearest(g, ...at(q.w / 4, -3))).toBe(i + 1);
        // The glyph itself is the same one on both halves (a double-click).
        expect(glyphNearest(g, ...at(-q.w / 4, 3))).toEqual({ i, after: false });
        expect(glyphNearest(g, ...at(q.w / 4, -3))).toEqual({ i, after: true });
      }
    });
  }

  it('puts a click past either end at that end', () => {
    const g = layouts.arc;
    const a = caretAt(g, 0);
    const b = caretAt(g, g.length);
    expect(caretNearest(g, a.x - 40 * Math.cos(a.rot), a.y - 40 * Math.sin(a.rot))).toBe(0);
    expect(caretNearest(g, b.x + 40 * Math.cos(b.rot), b.y + 40 * Math.sin(b.rot))).toBe(g.length);
    expect(caretNearest([], 10, 10)).toBe(0);
  });
});

describe('selectionBoxes: the highlight follows the curve', () => {
  it('covers each selected glyph from caret to caret, either way round', () => {
    const g = arcLayout('abcdef', style({ curve: 50, letterSpacing: 2 }), 20);
    const boxes = selectionBoxes(g, 4, 1);
    expect(boxes).toHaveLength(3);
    boxes.forEach((b, k) => {
      const a = caretAt(g, k + 1);
      const z = caretAt(g, k + 2);
      near(b, { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 });
      expect(b.w).toBeCloseTo(Math.hypot(z.x - a.x, z.y - a.y), 9);
      expect(b.rot).toBe(g[k + 1].rot);
    });
    expect(selectionBoxes(g, 2, 2)).toEqual([]);
    expect(selectionBoxes(g, 0, 99)).toHaveLength(6);
  });
});

describe('an SFX glyph scaled about its centre', () => {
  // As `sfxLayout` gives them: the advance as the font has it, and the scale
  // the painter lays on it about the glyph's centre (Grow on "WWW").
  const W = 30;
  const grown = [
    { ch: 'W', x: -35, y: 0, rot: 0, sx: 1, sy: 1, skew: 0, w: W },
    { ch: 'W', x: 0, y: 0, rot: 0, sx: 1.25, sy: 1.25, skew: 0, w: W },
    { ch: 'W', x: 40, y: 0, rot: 0.2, sx: 1.5, sy: 1.5, skew: 0, w: W },
  ];

  it('reaches as far as it is painted, and a glyph with no scale is its advance', () => {
    expect(grown.map(glyphReach)).toEqual([30, 37.5, 45]);
    expect(glyphReach({ x: 0, y: 0, rot: 0, w: 11 })).toBe(11);
    // Mirrored is as wide.
    expect(glyphReach({ x: 0, y: 0, rot: 0, sx: -2, w: 11 })).toBe(22);
  });

  it('has its end caret on its painted edge, along its turn', () => {
    const last = grown[2];
    near(caretAt(grown, 3), { x: last.x + 22.5 * Math.cos(last.rot), y: last.y + 22.5 * Math.sin(last.rot) });
    near(caretAt(grown, 0), { x: -50, y: 0 });
    // Between two, halfway across what each one's painted edge leaves.
    expect(caretAt(grown, 1).x).toBeCloseTo((-20 + -18.75) / 2, 9);
  });

  it('is found by a click on the part the scale added, and highlighted out to it', () => {
    // 18 px left of the middle glyph's centre: its ink (it reaches 18.75), and
    // nearer the first glyph's advance than its own unscaled one.
    expect(glyphNearest(grown, -18, 0)).toEqual({ i: 1, after: false });
    // The last glyph's highlight runs from caret to caret over all 45 px of it.
    const [box] = selectionBoxes(grown, 2, 3);
    expect(box.w).toBeGreaterThan(43);
  });
});

describe('caret keys on the curve act on the raw text', () => {
  const t = 'first line\nsecond';
  it('Home and End go to the paragraph ends', () => {
    expect(caretKey(t, 4, 'Home')).toBe(0);
    expect(caretKey(t, 4, 'End')).toBe(10);
    expect(caretKey(t, 13, 'Home')).toBe(11);
    expect(caretKey(t, 11, 'Home')).toBe(11);
    // A Return first: Home at the very start stays there.
    expect(caretKey('\nabc', 0, 'Home')).toBe(0);
    expect(caretKey(t, 13, 'End')).toBe(t.length);
    expect(caretKey(t, 13, 'ArrowLeft', true)).toBe(11);
    expect(caretKey(t, 4, 'ArrowRight', true)).toBe(10);
  });
  it('Up and Down go to the ends of the text, and the rest is the browser\'s', () => {
    expect(caretKey(t, 13, 'ArrowUp')).toBe(0);
    expect(caretKey(t, 2, 'ArrowDown')).toBe(t.length);
    expect(caretKey(t, 2, 'ArrowLeft')).toBeNull();
    expect(caretKey(t, 2, 'a')).toBeNull();
  });
});

describe('wordAt', () => {
  it('selects the word, or the run of spaces, under the offset', () => {
    expect(wordAt("it's a  test!", 1)).toEqual([0, 4]);
    expect(wordAt("it's a  test!", 7)).toEqual([6, 8]);
    expect(wordAt("it's a  test!", 13)).toEqual([12, 13]);
    expect(wordAt('', 0)).toEqual([0, 0]);
  });
});
