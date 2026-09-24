import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { solveLayout, SIZE_STEP } from './auto-layout.js';
import { boxCandidate, containBox, placeBlock } from './contain.js';
import {
  setTypesetEnabled,
  clearLayoutMemo,
  layoutMemoSize,
  layoutLines,
  applyCase,
  balloonWidthsFor,
  contentWidth,
  textInset,
  lineWidth,
} from './measure.js';
import { interiorLineWidths, inscribedRect, balloonFrame, safetyInset } from './balloon.js';
import { defaultStyle, normalizeStyle, normalizeAuto, REVIEW_REASONS } from './data.js';
import { neededHeight } from './typeset.js';
import { app, loadProjectPages } from './store.svelte.js';
import { serializePage } from './psd.js';

// ===========================================================================
// The auto-layout solver, on the stand-in metric
// ===========================================================================
// Under node every width is `chars x size x 0.55` (measure.js), which is enough
// to prove what the solver promises: the size it picks, the constraints it
// holds, and that its answer is the layout every renderer draws. Real faces are
// in auto-layout.realfont.test.js.
//
// The shaped breaker is on: with it off, node has no line layout to wrap with.

beforeAll(() => setTypesetEnabled(true));
beforeEach(() => clearLayoutMemo());

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), bold: false, ...over });
const OVAL = { kind: 'ellipse', cx: 400, cy: 300, rx: 150, ry: 100 };
const LONG = 'IF WE LEAVE RIGHT NOW WE CAN STILL CATCH THE LAST TRAIN BEFORE THE STORM HITS THE TOWN';
const solve = (over = {}) =>
  solveLayout({ text: LONG, style: style(), refSize: 26, region: OVAL, ...over, opts: { minSize: 12, ...over.opts } });

// The box the solver describes, as every renderer lays it out.
const boxOf = (r, s, fit) => ({ x: r.x, y: r.y, w: r.w, h: r.h, style: { ...s, size: r.size }, fit });
const rendered = (r, s, text, fit) => {
  const b = boxOf(r, s, fit);
  return layoutLines(applyCase(text, b.style), b.style, r.size, contentWidth(r.w, b.style), balloonWidthsFor(b, b.style, r.size));
};

describe('what there is to solve', () => {
  it('answers null for blank text, no size, or text on a curve', () => {
    expect(solveLayout({ text: '  \n', style: style(), refSize: 26, region: OVAL })).toBeNull();
    expect(solveLayout({ text: 'HI', style: null, refSize: 26, region: OVAL })).toBeNull();
    expect(solveLayout({ text: 'HI', style: style({ size: 0 }), refSize: 0, region: OVAL })).toBeNull();
    expect(solveLayout({ text: 'HI', style: style({ curve: 40 }), refSize: 26, region: OVAL })).toBeNull();
  });

  it('reads refSize over the style size', () => {
    const r = solveLayout({ text: 'HI', style: style({ size: 60 }), refSize: 20, region: OVAL });
    expect(r.size).toBe(20);
  });
});

describe('the size', () => {
  it('stops at refSize when it fits', () => {
    const r = solveLayout({ text: 'WHERE DID YOU PUT THE KEYS?', style: style(), refSize: 26, region: OVAL });
    expect(r.status).toBe('ok');
    expect(r.size).toBe(26);
    expect(r.reasons).toEqual([]);
  });

  it('never grows past refSize, however roomy the balloon', () => {
    const r = solveLayout({ text: 'NO.', style: style(), refSize: 20, region: OVAL });
    expect(r.size).toBe(20);
  });

  it('shrinks to the largest half-px size that fits, instead of growing the box', () => {
    const r = solve({ refSize: 40 });
    expect(r.status).toBe('shrunk');
    expect(r.size).toBeLessThan(40);
    expect(r.size % SIZE_STEP).toBe(0);
    // One step larger does not fit: the same solve capped there comes back shrunk too.
    const up = solve({ refSize: r.size + SIZE_STEP });
    expect(up.size).toBe(r.size);
    // And the box stays inside the balloon's bounding box.
    expect(r.y).toBeGreaterThanOrEqual(OVAL.cy - OVAL.ry);
    expect(r.y + r.h).toBeLessThanOrEqual(OVAL.cy + OVAL.ry);
  });

  it('lands 20 and 40 near the same size when 20 is about what the balloon holds (FIT-1)', () => {
    const tight = { kind: 'ellipse', cx: 400, cy: 300, rx: 140, ry: 95 };
    const a = solve({ refSize: 20, region: tight });
    const b = solve({ refSize: 40, region: tight });
    expect(a.status).toBe('ok');
    expect(b.status).toBe('shrunk');
    expect(Math.abs(b.size - a.size)).toBeLessThanOrEqual(3);
  });

  it('keeps a typed size that is off the grid when it fits', () => {
    expect(solveLayout({ text: 'HI', style: style(), refSize: 25.3, region: OVAL }).size).toBe(25.3);
  });
});

describe('the answer holds its constraints', () => {
  it('passes containBox, as every renderer lays it out', () => {
    const s = style();
    const r = solve({ refSize: 40 });
    const b = boxOf(r, s, OVAL);
    expect(containBox(boxCandidate(b, LONG)).fits).toBe(true);
    expect(r.lines).toEqual(rendered(r, s, LONG, OVAL));
  });

  it('fits every line to its own row of the balloon', () => {
    const s = style();
    const r = solve({ refSize: 40 });
    const lineH = r.size * s.lineHeight;
    const rows = interiorLineWidths(OVAL, lineH, r.lines.length, 'middle');
    const ti = textInset(s);
    r.lines.forEach((line, i) => expect(lineWidth(line, s, r.size) + 2 * ti).toBeLessThanOrEqual(rows[i] + 0.5));
    expect(r.lines.length * lineH).toBeLessThanOrEqual(2 * (OVAL.ry - safetyInset(OVAL)) + 0.5);
  });

  it('holds a left-aligned block to the rows where the whole box is inside the balloon', () => {
    const s = style({ align: 'left' });
    const r = solveLayout({ text: LONG, style: s, refSize: 40, region: OVAL, opts: { minSize: 12 } });
    const rows = interiorLineWidths(OVAL, r.size * s.lineHeight, r.lines.length, 'middle');
    for (const room of rows) expect(r.w).toBeLessThanOrEqual(room + 0.5);
  });

  it('is centred on the balloon, the block where the row widths assume it', () => {
    const r = solve();
    expect(r.x + r.w / 2).toBeCloseTo(OVAL.cx, 6);
    expect(r.y + r.h / 2).toBeCloseTo(OVAL.cy, 6);
    const top = solveLayout({ text: 'HI', style: style({ valign: 'top' }), refSize: 26, region: OVAL });
    const band = OVAL.cy - (OVAL.ry - safetyInset(OVAL));
    expect(top.y + textInset(style())).toBeCloseTo(band, 6);
  });

  // Where a fitted box is placed (GEO-1): centred text as wide as the inset
  // ellipse, so its rows keep the taper; flush text, set flat, in the inscribed
  // rectangle; a rectangle at its inset.
  it('places centred text at the balloon frame, flush text at the inscribed rectangle', () => {
    expect(solve().w).toBeCloseTo(balloonFrame(OVAL).w, 6);
    const keys = 'WHERE DID YOU PUT THE KEYS?';
    expect(solve({ text: keys, style: style({ align: 'left' }) }).w).toBeCloseTo(inscribedRect(OVAL).w, 6);
    const rect = { kind: 'rect', x: 100, y: 100, w: 300, h: 200 };
    expect(solve({ region: rect }).w).toBeCloseTo(inscribedRect(rect).w, 6);
  });

  // GEO-2: the rows hang from where the block is drawn, so the answer has to be
  // laid out there too, or the editor breaks it on other rows.
  it('is the layout every renderer draws, at every vertical alignment', () => {
    for (const valign of ['top', 'middle', 'bottom']) {
      const s = style({ valign });
      const r = solve({ style: s, refSize: 40 });
      expect(r.lines).toEqual(rendered(r, s, LONG, OVAL));
      expect(containBox(boxCandidate(boxOf(r, s, OVAL), LONG)).fits).toBe(true);
    }
  });

  it('narrows a centred box whose lines are set flat until they fit the rows they sit on', () => {
    const s = style({ balloon: false });
    const r = solve({ style: s });
    const lineH = r.size * s.lineHeight;
    const rows = interiorLineWidths(OVAL, lineH, r.lines.length, 'middle');
    r.lines.forEach((line, i) => expect(lineWidth(line, s, r.size) + 2 * textInset(s)).toBeLessThanOrEqual(rows[i] + 0.5));
    expect(r.lines).toEqual(rendered(r, s, LONG, OVAL));
  });

  it('widens past the inscribed rectangle rather than hyphenate a word the chord holds', () => {
    const small = { kind: 'ellipse', cx: 400, cy: 300, rx: 70, ry: 50 };
    const r = solveLayout({ text: 'REALLY?!!', style: style(), refSize: 20, region: small });
    expect(r.status).toBe('ok');
    expect(r.lines).toEqual(['REALLY?!!']);
    expect(r.w).toBeGreaterThan(inscribedRect(small).w);
  });

  it('gives the same answer twice', () => {
    expect(solve({ refSize: 40 })).toEqual(solve({ refSize: 40 }));
  });

  it('keeps its candidates out of the layout memo', () => {
    solve({ refSize: 40 });
    expect(layoutMemoSize()).toBe(0);
  });

  it('honours the smallest box it is given, within the balloon', () => {
    // Flush, so placed at the 192 px inscribed width, which the floor overrides.
    const r = solveLayout({ text: 'HI', style: style({ size: 12, align: 'left' }), refSize: 12, region: OVAL, opts: { minW: 250, minH: 60 } });
    expect(r.w).toBe(250);
    expect(r.h).toBe(60);
  });
});

describe('when nothing fits', () => {
  const tiny = { kind: 'ellipse', cx: 400, cy: 300, rx: 60, ry: 40 };

  it('stops at minSize, flags it, and keeps the box to the balloon and the page', () => {
    const r = solve({ region: tiny, opts: { minSize: 18, page: { w: 800, h: 600 } } });
    expect(r.status).toBe('overflow');
    expect(r.size).toBe(18);
    expect(r.reasons).toEqual([REVIEW_REASONS.minSize]);
    expect(r.review).toMatchObject({ kind: 'overflow', reason: REVIEW_REASONS.minSize });
    // Within the balloon's bounding box, as the placement ladder grows any box.
    expect(r.x).toBeGreaterThanOrEqual(tiny.cx - tiny.rx);
    expect(r.x + r.w).toBeLessThanOrEqual(tiny.cx + tiny.rx);
    expect(r.y).toBeGreaterThanOrEqual(tiny.cy - tiny.ry);
    expect(r.y + r.h).toBeLessThanOrEqual(tiny.cy + tiny.ry);
  });

  it('rounds minSize up onto the grid', () => {
    expect(solve({ region: tiny, opts: { minSize: 17.2 } }).size).toBe(17.5);
  });

  it('names a single word too wide for the balloon', () => {
    const r = solveLayout({
      text: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      style: style(),
      refSize: 26,
      region: tiny,
      opts: { minSize: 20, page: { w: 800, h: 600 } },
    });
    expect(r.status).toBe('overflow');
    expect(r.reasons).toEqual([REVIEW_REASONS.wideWord]);
  });
});

describe('a location without a balloon (GEO-3)', () => {
  const words = 'I NEVER THOUGHT IT WOULD COME TO THIS BUT HERE WE ARE AT LAST';

  it('takes its width from the English, centred on the hint, not from the hint', () => {
    const hint = { kind: 'hint', x: 300, y: 100, w: 30, h: 200 };
    const r = solveLayout({ text: words, style: style(), refSize: 26, region: hint });
    expect(r.status).toBe('no-region');
    expect(r.size).toBe(26);
    expect(r.w).toBeGreaterThan(r.h);
    expect(r.x + r.w / 2).toBeCloseTo(315, 6);
    expect(r.y + r.h / 2).toBeCloseTo(200, 6);
    expect(r.h).toBe(neededHeight(r.lines.length, style(), textInset(style())));
  });

  it('is never narrower than its longest word', () => {
    const s = style();
    const r = solveLayout({ text: 'A B EXTRAORDINARILY C', style: s, refSize: 26, region: null });
    expect(r.w).toBeGreaterThanOrEqual(lineWidth('EXTRAORDINARILY', s, 26) + 2 * textInset(s));
    expect(r.lines).toEqual(rendered(r, s, 'A B EXTRAORDINARILY C', null));
  });
});

describe('locks', () => {
  const box = { x: 10, y: 20, w: 180, h: 300 };

  it('a locked size is never shrunk: the solve overflows instead', () => {
    const r = solve({ refSize: 40, locks: { size: true } });
    expect(r.size).toBe(40);
    expect(r.status).toBe('overflow');
  });

  it('a locked width, height and position come off the box', () => {
    const r = solve({ locks: { width: true, height: true, pos: true }, opts: { box, minSize: 12 } });
    expect([r.w, r.h]).toEqual([180, 300]);
    expect(r.x + r.w / 2).toBe(100);
    expect(r.y + r.h / 2).toBe(170);
  });

  it('locked breaks lock the size and the width', () => {
    const r = solve({ refSize: 40, locks: { breaks: true }, opts: { box, minSize: 12 } });
    expect(r.size).toBe(40);
    expect(r.w).toBe(180);
  });
});

describe('placeBlock agrees', () => {
  it('lays the answer out in the lines it returns', () => {
    const s = style();
    const r = solve({ refSize: 34 });
    expect(placeBlock(boxCandidate(boxOf(r, s, OVAL), LONG)).lines).toEqual(r.lines);
  });
});

// ===========================================================================
// `box.auto` on disk
// ===========================================================================
describe('box.auto', () => {
  const auto = { on: true, refSize: 26, locks: { size: true }, status: 'shrunk', reason: null };
  const whole = { on: true, refSize: 26, locks: { size: true, width: false, height: false, pos: false, breaks: false }, status: 'shrunk', reason: null };

  it('normalises to the whole record, and to nothing when it is unreadable', () => {
    expect(normalizeAuto(auto)).toEqual(whole);
    expect(normalizeAuto({ refSize: 20, minSize: 15, status: 'mystery', reason: 'x', locks: { pos: 'yes' } })).toEqual({
      on: true,
      refSize: 20,
      minSize: 15,
      locks: { size: false, width: false, height: false, pos: false, breaks: false },
      status: null,
      reason: 'x',
    });
    expect(normalizeAuto({ on: false, refSize: 20 }).on).toBe(false);
    expect(normalizeAuto({ refSize: 0 })).toBeNull();
    expect(normalizeAuto({ refSize: 'big' })).toBeNull();
    expect(normalizeAuto(null)).toBeNull();
  });

  const pageWith = (over) => ({
    id: 1,
    w: 800,
    h: 600,
    lines: [],
    boxes: [{ id: 'b1', lineN: null, text: 'HI', x: 1, y: 2, w: 100, h: 40, style: style(), ...over }],
  });

  it('is carried through a load, and absent on a box saved without it', () => {
    loadProjectPages([pageWith({ auto: { ...auto, extra: 1 } })]);
    expect(app.pages[0].boxes[0].auto).toEqual(whole);
    loadProjectPages([pageWith({})]);
    expect('auto' in app.pages[0].boxes[0]).toBe(false);
  });

  it('rides the PSD embedded project', () => {
    expect(serializePage(pageWith({ auto })).boxes[0].auto).toEqual(whole);
    expect(serializePage(pageWith({})).boxes[0].auto).toBeNull();
  });
});
