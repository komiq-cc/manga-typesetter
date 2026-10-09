import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectPages, page, setFontSource, noteFontsChanged, edgeDragFloor, EDGE_DRAG_MIN, fitHeld, resizeBox } from './store.svelte.js';
import { textEngine, setTextEngine } from './text-engine/index.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo, textInset, layoutLines, contentWidth } from './measure.js';
import { neededHeight } from './typeset.js';
import { resizeBoxMath, takesHeightFloor } from './resize-math.js';

// ===========================================================================
// How short an edge drag may leave a box
// ===========================================================================
// A drag of the top or bottom edge keeps auto height's promise: never shorter
// than the text. The floor was worked out in the component from the lines on
// screen. While a box's face is arriving (the Rust engine on, a family used
// for the first time) those lines are broken in a stand-in, every fit in the
// store stands down for that reason, and this one did not: a stand-in wider
// than the face gave more lines, a higher floor, and a one-pixel drag wrote
// that height into the document. The floor is the store's now.
//
// The store's own hook stands in for the engine switch, as in
// editor/history-owed-fit.test.js: a font source that says "not ready" until
// the face arrives, and an engine that measures by arithmetic - wider while
// the face is away, which is what a stand-in is.

let arrived;
function fakeEngine() {
  const k = () => (arrived ? 0.4 : 0.7);
  const ink = (face, text) => ({ width: text.length * face.size * k(), left: 0, right: text.length * face.size * k(), ascent: face.size * 0.7, descent: face.size * 0.2 });
  return {
    id: 'rust',
    advance: (face, text) => text.length * face.size * k(),
    fontBox: (face) => ({ ascent: Math.round(face.size * 0.8), descent: Math.round(face.size * 0.2) }),
    lineInk: ink,
    glyphInk: ink,
    loading: () => false,
    onFontsChange: () => () => {},
    faceReady: () => true,
  };
}
const TEXT = 'THE WORDS THAT WERE SET IN THE REAL FACE AND FIT';
const box = (over = {}) => ({
  id: 'b1', lineN: null, text: TEXT, x: 100, y: 300, w: 200, h: 400,
  ...over,
  style: { font: 'Wild Words', size: 30, lineHeight: 1.1, valign: 'top', outlineWidth: 0, ...over.style },
});
const open = (b) => {
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes: [b] }]);
  return page().boxes[0];
};
const linesOf = (b) => {
  clearLayoutMemo();
  return layoutLines(b.text, b.style, b.style.size, contentWidth(b.w, b.style), null).length;
};
const original = { engine: textEngine(), typeset: typesetEnabled() };

beforeEach(() => {
  arrived = true;
  setTextEngine(fakeEngine());
  setTypesetEnabled(true);
});
afterEach(() => {
  setFontSource(null);
  loadProjectPages([]);
  setTextEngine(original.engine);
  setTypesetEnabled(original.typeset);
  clearLayoutMemo();
});

describe('with no font source, which is every session with the switch off', () => {
  it('is what the lines need, the number the drag always used', () => {
    const b = open(box());
    for (const n of [1, 2, 5, 9]) expect(edgeDragFloor(b, 's', n, page())).toBe(Math.min(neededHeight(n, b.style, textInset(b.style)), 1200));
    expect(edgeDragFloor(b, 's', 3, page())).toBeGreaterThan(EDGE_DRAG_MIN);
    expect(fitHeld(b)).toBe(false);
  });
  it('is capped at the page, as the fit is', () => {
    const b = open(box());
    expect(edgeDragFloor(b, 's', 500, page())).toBe(1200);
    expect(edgeDragFloor(b, 's', 500, { h: 0 })).toBe(neededHeight(500, b.style, textInset(b.style)));
  });
  it('is the plain minimum for a box that is not auto-sized, and for text with no lines to count', () => {
    const fixed = open(box({ style: { autoHeight: false } }));
    expect(edgeDragFloor(fixed, 's', 6, page())).toBe(EDGE_DRAG_MIN);
    const curved = open(box());
    expect(edgeDragFloor(curved, 's', null, page())).toBe(EDGE_DRAG_MIN);
    expect(EDGE_DRAG_MIN).toBe(30);
  });
});

describe('with the Rust engine on', () => {
  it('a face that is in: the same number, and nothing is held', () => {
    setFontSource({ ready: () => arrived });
    const b = open(box());
    expect(edgeDragFloor(b, 's', 4, page())).toBe(neededHeight(4, b.style, textInset(b.style)));
    expect(fitHeld(b)).toBe(false);
  });

  it('a face still arriving: the stand-in breaks the text into more lines, and the floor does not read them', () => {
    setFontSource({ ready: () => arrived });
    const b = open(box());
    const real = linesOf(b);
    arrived = false;
    const standIn = linesOf(b);
    expect(standIn).toBeGreaterThan(real);
    // What the drag did: floor at the stand-in's count, above the box's own height.
    const need = neededHeight(real, b.style, textInset(b.style));
    const wrong = neededHeight(standIn, b.style, textInset(b.style));
    expect(wrong).toBeGreaterThan(need);
    const o = { x: b.x, y: b.y, w: b.w, h: need, size: b.style.size };
    expect(resizeBoxMath(0, -1, 's', o, 0, wrong).h).toBe(wrong);
    // What it does now.
    expect(edgeDragFloor(b, 's', standIn, page())).toBe(EDGE_DRAG_MIN);
    expect(resizeBoxMath(0, -1, 's', o, 0, edgeDragFloor(b, 's', standIn, page())).h).toBe(need - 1);
  });

  it('and the fit is held for when the face lands: a box dragged shorter than its text meanwhile is fitted then', () => {
    setFontSource({ ready: () => arrived });
    const b = open(box());
    const need = neededHeight(linesOf(b), b.style, textInset(b.style));
    arrived = false;
    clearLayoutMemo();
    const floor = edgeDragFloor(b, 's', 9, page());
    expect(fitHeld(b)).toBe(true);
    // The user drags the bottom edge far up: allowed, the floor is the plain one.
    const geom = resizeBoxMath(0, -1000, 's', { x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size }, 0, floor);
    resizeBox(1, 'b1', geom, { w: b.w, h: b.h });
    expect(b.h).toBe(EDGE_DRAG_MIN);
    arrived = true;
    clearLayoutMemo();
    noteFontsChanged();
    expect(fitHeld(b)).toBe(false);
    expect(b.h).toBeGreaterThanOrEqual(need);
  });
});

// The floor is for the top and bottom edges. A corner scales the type with the
// box and takes none, and a left or right edge leaves the height alone
// (`takesHeightFloor`, resize-math.js). A drag with no floor has none to stand
// down, and nothing is owed for it when the face lands.
describe('a drag that takes no floor', () => {
  it('is told which handles those are by the arithmetic of the drag itself', () => {
    expect(['n', 's'].every(takesHeightFloor)).toBe(true);
    expect(['e', 'w', 'ne', 'nw', 'se', 'sw'].some(takesHeightFloor)).toBe(false);
    const o = { x: 0, y: 0, w: 200, h: 400, size: 30 };
    // And they are: a floor of 350 stops the edges and nothing else.
    expect(resizeBoxMath(0, -300, 's', o, 0, 350).h).toBe(350);
    expect(resizeBoxMath(0, 300, 'n', o, 0, 350).h).toBe(350);
    expect(resizeBoxMath(0, -300, 'se', o, 0, 350).h).toBe(100);
    expect(resizeBoxMath(0, 300, 'nw', o, 0, 350).h).toBe(100);
    expect(resizeBoxMath(-50, 0, 'e', o, 0, 350).h).toBe(400);
  });

  for (const dir of ['e', 'w', 'ne', 'nw', 'se', 'sw']) {
    it(`${dir}: the plain minimum, and with the face arriving no fit is held`, () => {
      setFontSource({ ready: () => arrived });
      const b = open(box());
      expect(edgeDragFloor(b, dir, 4, page())).toBe(EDGE_DRAG_MIN);
      arrived = false;
      expect(edgeDragFloor(b, dir, 9, page())).toBe(EDGE_DRAG_MIN);
      expect(fitHeld(b)).toBe(false);
    });
  }

  // The outside review's drag, in this file's arithmetic: a corner pulled out
  // while the face is away. The stand-in is wide, the text is "too wide" for
  // the box by its measure, and a fit owed from the drag re-set the box when
  // the face landed - a width and an x the user never chose.
  it('a corner dragged while the face is arriving is where the drag left it when the face lands', () => {
    setFontSource({ ready: () => arrived });
    const b = open(box({ text: 'JJJJ', w: 40, h: 150, style: { size: 100, align: 'center' } }));
    arrived = false;
    clearLayoutMemo();
    const o = { x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size };
    const floor = edgeDragFloor(b, 'se', linesOf(b), page());
    const geom = resizeBoxMath(8, 30, 'se', o, 0, floor);
    expect(geom).toMatchObject({ w: 48, h: 180, size: 120 });
    resizeBox(1, 'b1', geom, { w: o.w, h: o.h });
    const left = { x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size };
    expect(left).toMatchObject({ x: 100, w: 48, h: 180, size: 120 });
    arrived = true;
    clearLayoutMemo();
    noteFontsChanged();
    expect({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size }).toEqual(left);
  });
});
