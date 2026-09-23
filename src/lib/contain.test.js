import { describe, it, expect, beforeEach, afterAll } from 'vitest';

// ===========================================================================
// Containment: text never goes outside its box (OVF-2)
// ===========================================================================
// contain.js decides whether a box's ink - glyphs, strokes, shadows - stays
// inside the box, and runs the ladder that makes an auto box fit. Every number
// it works from is a glyph's own bounding box off `measureText`, so a test of it
// needs a canvas that answers `actualBoundingBox*`, and node has none.
//
// So this file brings one: a stub 2D context with a small, fully known font.
// Every glyph advances 0.55 em - the stand-in metric the rest of the suite uses,
// so line breaks read the same as everywhere else - and its INK is where a real
// face would put it, which is not the advance:
//
//   most glyphs   ink from 0.04 em to 0.51 em (a side bearing either side)
//   W             -0.01 .. 0.56   (a hair past the advance at both ends)
//   T             0 .. 0.55       (no side bearing at all)
//   J             -0.08 .. 0.45   (reaches back behind the pen)
//   f             0.02 .. 0.62    (leans past its advance)
//   italic        every glyph's right edge 0.12 em further out
//   heights       capitals 0.7 em, ascenders 0.72, x-height 0.5, accented
//                 capitals 0.92 - above the font's own 0.8 ascent - and
//                 descenders 0.21 below the baseline
//
// It honours `textAlign` and `textBaseline` the way a canvas does, because the
// measurer asks for the curved renderers' glyphs centred on a middle baseline.
// The real-font lane (measure.realfont.test.js) checks the same rules against
// the exporter's own pixels; this file is where the rules are pinned down
// exactly, with numbers a reader can follow.
//
// The stub is installed BEFORE anything that imports measure.js is loaded,
// because measure.js makes its canvas once, at evaluation time.

const EM = { ascent: 0.8, descent: 0.2 };
const INK = { W: [-0.01, 0.56], T: [0, 0.55], J: [-0.08, 0.45], f: [0.02, 0.62] };
const ACCENTED = /[ÀÁÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÑ]/;
let measureCalls = 0;

function stubContext() {
  const ctx = {
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    letterSpacing: '0px',
    measureText(str) {
      measureCalls++;
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1]) || 10;
      const italic = /\bitalic\b/.test(ctx.font);
      const adv = 0.55 * size;
      const chars = [...String(str)];
      const width = chars.length * adv;
      let x0 = Infinity;
      let x1 = -Infinity;
      let up = -Infinity;
      let down = -Infinity;
      chars.forEach((ch, i) => {
        if (/\s/.test(ch)) return;
        const [l, r] = INK[ch] ?? [0.04, 0.51];
        x0 = Math.min(x0, i * adv + l * size);
        x1 = Math.max(x1, i * adv + (r + (italic ? 0.12 : 0)) * size);
        const a = ACCENTED.test(ch) ? 0.92 : /[A-Z0-9!?]/.test(ch) ? 0.7 : /[bdfhklt]/.test(ch) ? 0.72 : /[.,_]/.test(ch) ? 0.1 : 0.5;
        up = Math.max(up, a * size);
        down = Math.max(down, /[gjpqy]/.test(ch) ? 0.21 * size : 0);
      });
      if (x0 === Infinity) x0 = x1 = up = down = 0;
      const ax = ctx.textAlign === 'center' ? width / 2 : ctx.textAlign === 'right' || ctx.textAlign === 'end' ? width : 0;
      // 'middle' is the middle of the em square: 0.3 em above the alphabetic
      // baseline in a font whose ascent and descent are 0.8 and 0.2.
      const by = ctx.textBaseline === 'middle' ? ((EM.ascent - EM.descent) / 2) * size : 0;
      return {
        width,
        actualBoundingBoxLeft: ax - x0,
        actualBoundingBoxRight: x1 - ax,
        actualBoundingBoxAscent: up - by,
        actualBoundingBoxDescent: down + by,
        fontBoundingBoxAscent: EM.ascent * size - by,
        fontBoundingBoxDescent: EM.descent * size + by,
      };
    },
  };
  return ctx;
}

const hadDocument = 'document' in globalThis;
const priorDocument = globalThis.document;
globalThis.document = {
  createElement(tag) {
    if (String(tag).toLowerCase() === 'canvas') {
      const ctx = stubContext();
      return { width: 300, height: 150, getContext: () => ctx };
    }
    throw new Error(`contain.test.js: document.createElement('${tag}') - only <canvas> is stubbed; the shaped breaker is on`);
  },
};
afterAll(() => {
  if (hadDocument) globalThis.document = priorDocument;
  else delete globalThis.document;
});

const measure = await import('./measure.js');
const contain = await import('./contain.js');
const store = await import('./store.svelte.js');
const hist = await import('./editor/history.svelte.js');
const psd = await import('./psd.js');
const { defaultStyle, normalizeStyle, normalizeReview, REVIEW_REASONS } = await import('./data.js');
const { neededHeight } = await import('./typeset.js');

const { BOX_PAD, textInset, contentWidth, setTypesetEnabled, clearLayoutMemo, layoutMemoSize, canMeasure } = measure;
const { boxCandidate, placeBlock, boxInkRect, containBox, fitBox, fitLimit, reviewFor, isAutoBox, CONTAIN_TOL } = contain;
const {
  app,
  page,
  byId,
  loadProjectPages,
  autoFitBox,
  autoFitBoxTo,
  refitPage,
  reviewBox,
  fitBoxNow,
  makeBoxAuto,
  flaggedBoxes,
  resizeBox,
  setBoxText,
  beginEdit,
  endEdit,
  setMinFontSize,
  fitGeom,
} = store;

setTypesetEnabled(true);

const S = 20;
const ADV = 0.55 * S;
const style = (extra = {}) => normalizeStyle({ ...defaultStyle(), size: S, bold: false, strokes: [], ...extra });
const cand = (over = {}) => ({ x: 100, y: 100, w: 200, h: 100, text: 'HELLO', fit: null, ...over, style: over.style ?? style() });

// A page with the boxes given, loaded the way a saved chapter is.
const load = (boxes, over = {}) => {
  loadProjectPages([{ id: 1, w: 800, h: 1200, lines: [], boxes, ...over }]);
  return page();
};
const verdict = (b, p = page()) => containBox(boxCandidate(b, store.boxText(b, p)));
const geomOf = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size });

beforeEach(() => {
  hist.initHistory();
  hist.resetHistory();
  app.chapterRef = null;
  setMinFontSize(12);
  clearLayoutMemo();
});

describe('the stub this file measures with', () => {
  it('is a canvas as far as measure.js can tell', () => {
    expect(canMeasure()).toBe(true);
    const k = measure.lineInk('WAIT', style({ align: 'left' }), S);
    // W's ink starts 0.01 em behind the pen; T's ends exactly on its advance.
    expect(k.left).toBeCloseTo(-0.2, 6);
    expect(k.right).toBeCloseTo(4 * ADV, 6);
    expect(k.ascent).toBeCloseTo(0.7 * S, 6);
  });
});

// ===== the ink rectangle =====

describe('boxInkRect', () => {
  // Test 1's fixture: "WAIT WHAT" in a box exactly as wide as its advance plus
  // the padding, which is the tightest box the layout keeps it on one line in.
  const FULL = 'WAIT WHAT';
  const fullW = 9 * ADV + BOX_PAD * 2 + 0.01;

  it('places the glyph ink where the exporter draws it', () => {
    const c = cand({ text: FULL, w: fullW, h: 40, style: style() });
    const place = placeBlock(c);
    expect(place.lines).toEqual([FULL]);
    const r = boxInkRect(c, place);
    // Centred: the advance is centred on the box, the ink is the advance less
    // W's 0.2px overhang at the front.
    const start = (fullW - 9 * ADV) / 2;
    expect(r.x).toBeCloseTo(start - 0.2, 6);
    expect(r.x + r.w).toBeCloseTo(start + 9 * ADV, 6);
    expect(containBox(c, place).fits).toBe(true);
  });

  // The outline, counted: the stroked ink is the glyph ink grown by the
  // outline's width on every side. Both boxes are wide enough to keep the line
  // whole with its outline (see the text inset below), so the two rectangles
  // are the same block, stroked and not.
  it('counts the default 3px outline on every side', () => {
    const stroked = style({ strokes: [{ color: '#fff', width: 3, opacity: 1 }] });
    const w = 9 * ADV + textInset(stroked) * 2 + 0.01;
    const bare = boxInkRect(cand({ text: FULL, w, h: 40, style: style() }));
    const c = cand({ text: FULL, w, h: 40, style: stroked });
    expect(placeBlock(c).lines).toEqual([FULL]);
    const r = boxInkRect(c);
    expect(r.x).toBeCloseTo(bare.x - 3, 6);
    expect(r.y).toBeCloseTo(bare.y - 3, 6);
    expect(r.w).toBeCloseTo(bare.w + 6, 6);
    expect(r.h).toBeCloseTo(bare.h + 6, 6);
  });

  // Test 2: a shadow grows the rectangle in the direction it is thrown, by its
  // offset plus twice its blur, and nowhere else.
  it('counts each shadow per direction, and not one with no opacity', () => {
    const base = cand({ text: 'HELLO', style: style() });
    const plain = boxInkRect(base);
    const thrown = boxInkRect({ ...base, style: style({ shadows: [{ color: '#000', x: 4, y: 6, blur: 2, opacity: 1 }] }) });
    expect(thrown.x).toBeCloseTo(plain.x, 6);
    expect(thrown.y).toBeCloseTo(plain.y, 6);
    expect(thrown.x + thrown.w).toBeCloseTo(plain.x + plain.w + 4 + 4, 6);
    expect(thrown.y + thrown.h).toBeCloseTo(plain.y + plain.h + 6 + 4, 6);
    const up = boxInkRect({ ...base, style: style({ shadows: [{ color: '#000', x: -5, y: -3, blur: 0, opacity: 1 }] }) });
    expect(up.x).toBeCloseTo(plain.x - 5, 6);
    expect(up.y).toBeCloseTo(plain.y - 3, 6);
    expect(up.x + up.w).toBeCloseTo(plain.x + plain.w, 6);
    const ghost = boxInkRect({ ...base, style: style({ shadows: [{ color: '#000', x: 40, y: 40, blur: 9, opacity: 0 }] }) });
    expect(ghost).toEqual(plain);
    // Cast from the stroked silhouette, not from the bare glyphs.
    const both = boxInkRect({
      ...base,
      style: style({ strokes: [{ color: '#fff', width: 3, opacity: 1 }], shadows: [{ color: '#000', x: 4, y: 0, blur: 0, opacity: 1 }] }),
    });
    expect(both.x + both.w).toBeCloseTo(plain.x + plain.w + 3 + 4, 6);
    expect(both.x).toBeCloseTo(plain.x - 3, 6);
  });

  // Test 3, the measuring half: an accent above the font's ascent, at a leading
  // tighter than the glyphs, and an italic's lean past its last advance.
  it('sees accented capitals above the line box and an italic past its advance', () => {
    const tight = style({ lineHeight: 0.9, valign: 'top' });
    const c = cand({ text: 'ÉTÉ', h: 200, style: tight });
    const place = placeBlock(c);
    const r = boxInkRect(c, place);
    // The accent rises 0.92 em above the baseline; the line box holds 0.8 em
    // of ascent plus half the (negative) leading above it.
    expect(place.baseY - 0.92 * S).toBeLessThan(0);
    expect(r.y).toBeCloseTo(place.blockY + place.baseY - 0.92 * S, 6);

    const upright = boxInkRect(cand({ text: 'ff', style: style({ align: 'left' }) }));
    const leaning = boxInkRect(cand({ text: 'ff', style: style({ align: 'left', italic: true }) }));
    expect(upright.x + upright.w).toBeCloseTo(BOX_PAD + ADV + 0.62 * S, 6);
    expect(leaning.x + leaning.w).toBeCloseTo(BOX_PAD + ADV + 0.74 * S, 6);
  });

  it('adds letter spacing between glyphs and not after the last one', () => {
    const k0 = boxInkRect(cand({ text: 'HELLO', style: style({ align: 'left' }) }));
    const k4 = boxInkRect(cand({ text: 'HELLO', style: style({ align: 'left', letterSpacing: 4 }) }));
    expect(k4.x).toBeCloseTo(k0.x, 6);
    expect(k4.w - k0.w).toBeCloseTo(4 * 4, 6);
  });

  it('mirrors with a flip, since the finished picture is mirrored', () => {
    const c = cand({ text: 'fff', style: style({ align: 'left', italic: true }) });
    const r = boxInkRect(c);
    const m = boxInkRect({ ...c, style: style({ align: 'left', italic: true, flipH: true }) });
    expect(m.x).toBeCloseTo(c.w - (r.x + r.w), 6);
    expect(m.w).toBeCloseTo(r.w, 6);
  });

  it('has no ink for a blank box, which always fits', () => {
    expect(boxInkRect(cand({ text: '   ' }))).toBeNull();
    expect(containBox(cand({ text: '' })).fits).toBe(true);
  });

  it('never mutates the candidate it is given', () => {
    const c = cand({ text: 'AAAA BBBB CCCC DDDD', w: 40, h: 20 });
    const frozen = JSON.stringify(c);
    boxInkRect(c);
    containBox(c);
    fitBox(c, { page: { w: 800, h: 1200 }, minSize: 12 });
    expect(JSON.stringify(c)).toBe(frozen);
  });
});

// ===== the text inset (OVF-3) =====
//
// The box's content box is the box less the padding AND the outline's reach
// (`textInset`) on every side, in every renderer: the lines are broken to its
// width, a left- or right-aligned block is anchored to its side and a top- or
// bottom-aligned one to its top or bottom, and the auto height is the block
// plus the inset above and below. So a line that fills its width, or sits on
// the edge it is aligned to, keeps its outline inside the box. The default
// outline is 3px against 2px of padding, and before this every full-width line
// had a pixel of outline outside the box - on an aligned edge, where no growth
// can reach it.
describe('the text inset', () => {
  const FULL = 'WAIT WHAT';
  const outline = (width, extra = {}) => style({ strokes: [{ color: '#fff', width, opacity: 1 }], ...extra });

  it('is the padding plus the outline, rounded up to a whole pixel', () => {
    expect(textInset(style())).toBe(BOX_PAD);
    expect(textInset(outline(3))).toBe(BOX_PAD + 3);
    // Every band counts - the reach is the outermost band's outer edge - and a
    // fraction rounds up rather than leaving a sliver of outline on the edge.
    expect(textInset(style({ strokes: [{ color: '#fff', width: 2.5, opacity: 1 }, { color: '#000', width: 1.2, opacity: 1 }] }))).toBe(
      BOX_PAD + 4,
    );
    expect(textInset(normalizeStyle({}))).toBe(BOX_PAD + 3);
    expect(contentWidth(100, outline(3))).toBe(90);
    // Never narrower than a pixel, as `layoutLines` would clamp it anyway.
    expect(contentWidth(8, outline(3))).toBe(1);
  });

  // OVF-2's test 1: the default outline on a full-width line stays inside. The
  // tightest box that keeps the line whole is now its advance plus the inset on
  // both sides, and in it the outline clears both edges with nothing to fit.
  it('keeps the default outline of a full-width line inside the box, unflagged', () => {
    for (const width of [3, 6, 2.5]) {
      const s = outline(width);
      const w = 9 * ADV + textInset(s) * 2 + 0.01;
      const c = cand({ text: FULL, w, h: 40, style: s });
      expect(placeBlock(c).lines, `${width}px`).toEqual([FULL]);
      expect(containBox(c).fits, `${width}px`).toBe(true);
      // A pixel narrower and the line no longer fits whole, so it breaks - it
      // does not run into the outline's room.
      expect(placeBlock({ ...c, w: w - 1 }).lines, `${width}px`).toEqual(['WAIT', 'WHAT']);
    }
    // Loaded as a saved chapter: the grow-only refit finds nothing to flag.
    const s = outline(3);
    load([{ id: 'b1', lineN: null, text: FULL, x: 300, y: 300, w: 9 * ADV + textInset(s) * 2 + 0.01, h: 40, style: s }]);
    expect(byId('b1').review).toBeUndefined();
  });

  // Aligned to a side, the block is anchored the inset in from it, so the
  // outline of a line that starts - or, aligned right, ends - on a letter with
  // no side bearing, or on one that reaches behind its pen, is inside on the one
  // edge no growth can move away from it: the text moves with that edge. At the
  // padding alone, T's outline was a pixel past a left edge and J's 2.6px, and
  // every such box carried an 'ink past the aligned edge' flag nothing could
  // clear. J, T and W: the stub's three glyphs with the least side bearing.
  it('anchors a left- or right-aligned full-width line inside, outline and all', () => {
    for (const align of ['left', 'right']) {
      const s = outline(3, { align });
      for (const text of ['JUMP WAIT', 'TWIN JAW', 'WAIT WHAT']) {
        const at = `${align} ${text}`;
        const w = text.length * ADV + textInset(s) * 2 + 0.01;
        const c = cand({ text, w, h: 40, style: s });
        const place = placeBlock(c);
        expect(place.lines, at).toEqual([text]);
        expect(place.anchorX, at).toBe(align === 'left' ? textInset(s) : w - textInset(s));
        expect(containBox(c, place).fits, at).toBe(true);
      }
    }
    // J's tail is the worst of them: 0.08 em behind the pen, the outline 3px
    // behind that, and still 0.4px inside the left edge.
    const s = outline(3, { align: 'left' });
    const r = boxInkRect(cand({ text: 'JUMP WAIT', w: 9 * ADV + textInset(s) * 2 + 0.01, h: 40, style: s }));
    expect(r.x).toBeCloseTo(textInset(s) - 0.08 * S - 3, 6);
    expect(r.x).toBeGreaterThan(0);
    // Right-aligned, a line ending in W is 0.2px of glyph and 3px of outline
    // past its advance, 1.8px inside the right edge.
    const sr = outline(3, { align: 'right' });
    const wr = 8 * ADV + textInset(sr) * 2 + 0.01;
    const rr = boxInkRect(cand({ text: 'TWIN JAW', w: wr, h: 40, style: sr }));
    expect(wr - (rr.x + rr.w)).toBeCloseTo(textInset(sr) - 0.01 * S - 3, 6);
    // Loaded as a saved chapter, left and right: nothing to flag.
    load([
      { id: 'l', lineN: null, text: 'JUMP WAIT', x: 100, y: 100, w: 9 * ADV + textInset(s) * 2 + 0.01, h: 40, style: s },
      { id: 'r', lineN: null, text: 'TWIN JAW', x: 100, y: 300, w: wr, h: 40, style: sr },
    ]);
    expect(byId('l').review).toBeUndefined();
    expect(byId('r').review).toBeUndefined();
  });

  // The same inset above and below: a top- or bottom-aligned block is anchored
  // that far in from its edge, and the auto height makes room for the outline
  // over the first line and under the last. A centred block is anchored at the
  // box's centre, which is the one anchor the outline does not move.
  it('anchors a top- or bottom-aligned block the inset in, and the auto height holds it', () => {
    const top = outline(3, { valign: 'top' });
    expect(placeBlock(cand({ text: 'HELLO', h: 100, style: top })).blockY).toBe(textInset(top));
    const bottom = outline(3, { valign: 'bottom' });
    const pb = placeBlock(cand({ text: 'HELLO', h: 100, style: bottom }));
    expect(pb.blockY).toBeCloseTo(100 - textInset(bottom) - pb.lineH, 6);
    const mid = placeBlock(cand({ text: 'HELLO', h: 100, style: outline(3, { valign: 'middle' }) }));
    const midBare = placeBlock(cand({ text: 'HELLO', h: 100, style: style({ valign: 'middle' }) }));
    expect([mid.blockY, mid.anchorX]).toEqual([midBare.blockY, midBare.anchorX]);
    // A top-aligned auto box opened at a height too small for its text grows to
    // the block plus the inset above and below, and its outline is inside.
    load([{ id: 'b1', lineN: null, text: 'HELLO', x: 100, y: 100, w: 200, h: 10, style: top }]);
    const b = byId('b1');
    expect(b.h).toBeCloseTo(neededHeight(1, b.style, textInset(b.style)), 6);
    expect(verdict(b).fits).toBe(true);
    expect(b.review).toBeUndefined();
  });

  // One helper, so every layout breaks at the same width: the placement the
  // exporter, the PSD writer and the check read; the balloon's per-line widths;
  // and the balanced size a new box is placed at.
  it('is the width every layout breaks at', () => {
    const s = outline(3);
    const text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL';
    const c = cand({ text, w: 150, h: 200, style: s });
    expect(placeBlock(c).lines).toEqual(measure.layoutLines(text, s, S, 140, null));
    // ...and not at the padding alone, where the old full-width line stayed whole.
    const old = cand({ text: FULL, w: 9 * ADV + BOX_PAD * 2 + 0.01, h: 40, style: s });
    expect(measure.layoutLines(FULL, s, S, old.w - BOX_PAD * 2, null)).toEqual([FULL]);
    expect(placeBlock(old).lines).toEqual(['WAIT', 'WHAT']);
    // Balloon widths come off the same inset: a rectangle's every line is the
    // balloon's width less the balloon's safety margin and the box's inset.
    const fitted = { ...c, fit: { kind: 'rect', x: 0, y: 0, w: 150, h: 400 } };
    const widths = measure.balloonWidthsFor(fitted, s, S)(3);
    const bare = measure.balloonWidthsFor({ ...fitted, style: style() }, style(), S)(3);
    expect(widths[0]).toBeCloseTo(bare[0] - 2 * 3, 6);
    // A new box is sized so its lines keep the inset: the balanced width is
    // the content width plus the inset on both sides.
    const bal = measure.balancedBoxSize(text, s);
    const balBare = measure.balancedBoxSize(text, style());
    expect(bal.w - balBare.w).toBe(2 * 3);
    const placed = cand({ text, w: bal.w, h: bal.h, style: s });
    expect(placeBlock(placed).lines).toHaveLength(bal.lines);
  });
});

describe('the flag', () => {
  it('is whole pixels rounded up, and an edge inside the tolerance reads 0', () => {
    const r = reviewFor({ fits: false, overflow: { l: 0.3, t: 1.01, r: 0.5, b: 7 } }, REVIEW_REASONS.minSize);
    expect(r).toEqual({ kind: 'overflow', overflow: { l: 0, t: 2, r: 0, b: 7 }, reason: REVIEW_REASONS.minSize });
    expect(reviewFor({ fits: true, overflow: { l: 0, t: 0, r: 0, b: 0 } })).toBeNull();
    expect(CONTAIN_TOL).toBe(0.5);
  });

  it('loads only in the shape this build writes', () => {
    expect(normalizeReview({ kind: 'overflow', overflow: { l: 1.2, t: 0, r: '3', b: -4 }, reason: 'x' })).toEqual({
      kind: 'overflow',
      overflow: { l: 2, t: 0, r: 3, b: 0 },
      reason: 'x',
    });
    expect(normalizeReview({ kind: 'overflow', overflow: { l: 0, t: 0, r: 0, b: 0 } })).toBeNull();
    expect(normalizeReview({ kind: 'mystery', overflow: { l: 4 } })).toBeNull();
    expect(normalizeReview('overflow')).toBeNull();
    expect(normalizeReview({ kind: 'overflow', overflow: { b: 2 } }).reason).toBe(REVIEW_REASONS.stale);
  });
});

// ===== the ladder =====

describe('the ladder, on an auto box', () => {
  // An unbreakable word a little wider than its box: an edit widens the box,
  // symmetrically about its centre, by as little as the ink needs. "KRRSSHH"
  // has no vowels, so the breaker has nowhere to hyphenate it and keeps it
  // whole, 1.2px of ink past each side of a 73px box.
  it('widens a centred box around a word too wide for it', () => {
    const w = 7 * ADV - 4;
    const p = load([{ id: 'b1', lineN: null, text: 'KRRSSHH', x: 300, y: 300, w, h: 40, style: style() }]);
    const b = byId('b1');
    expect(placeBlock(boxCandidate(b, 'KRRSSHH')).lines).toEqual(['KRRSSHH']);
    // Opening flags it and moves nothing sideways.
    expect(b.w).toBe(w);
    expect(b.x).toBe(300);
    expect(b.review).toMatchObject({ kind: 'overflow', reason: REVIEW_REASONS.stale });
    expect(b.review.overflow.l).toBeGreaterThan(0);
    expect(b.review.overflow.r).toBeGreaterThan(0);
    // An edit runs the ladder.
    expect(autoFitBox(b, p)).toBe(true);
    expect(verdict(b).fits).toBe(true);
    expect(b.review).toBeUndefined();
    expect(b.w).toBeGreaterThan(w);
    expect(b.w - w).toBeLessThanOrEqual(3);
    expect(b.x + b.w / 2).toBeCloseTo(300 + w / 2, 6);
    expect(b.style.size).toBe(S);
  });

  // Test 3, the fixing half. Growing the height is something opening a chapter
  // may do (OVF-8), so an accent over a tight leading is inside from the start;
  // growing the width is not, so an italic's lean waits for an edit to run the
  // ladder.
  it('grows the height for an accent above a tight leading on opening, and the width for an italic on an edit', () => {
    const outlined = { strokes: [{ color: '#fff', width: 3, opacity: 1 }] };
    const p = load([
      // Accented capitals at lineHeight 0.9, outlined as the default style is:
      // the accent clears the line box, the ink-centring takes it back down
      // into the room a line of capitals leaves under its baseline, and the
      // auto height's inset holds the outline. Inside, with nothing to fit.
      { id: 'caps', lineN: null, text: 'ÉTÉ', x: 100, y: 100, w: 200, h: 10, style: style({ lineHeight: 0.9, ...outlined }) },
      // An accent over a descender at 0.8: 1.13 em of glyph in a 0.8 em line
      // box, more than the inset's room above and below. Sized from its line
      // boxes alone, this one was flagged on every opening; the height the
      // grow-only paths give it now is its ink's.
      { id: 'acc', lineN: null, text: 'Égy', x: 100, y: 300, w: 200, h: 10, style: style({ lineHeight: 0.8, ...outlined }) },
      { id: 'ita', lineN: null, text: 'fff', x: 100, y: 500, w: 3 * ADV + BOX_PAD * 2, h: 40, style: style({ align: 'left', italic: true }) },
    ]);
    expect(byId('caps').review).toBeUndefined();
    expect(verdict(byId('caps')).fits).toBe(true);
    const acc = byId('acc');
    expect(acc.review).toBeUndefined();
    expect(verdict(acc).fits).toBe(true);
    // Past the line-box height `neededHeight` gives it.
    expect(acc.h).toBeGreaterThan(neededHeight(1, acc.style, textInset(acc.style)));
    // Nothing for an edit to do to it; the italic is the edit's.
    expect(autoFitBox(acc, p)).toBe(false);
    const ita = byId('ita');
    expect(ita.review).toBeDefined();
    autoFitBox(ita, p);
    expect(verdict(ita).fits).toBe(true);
    expect(ita.review).toBeUndefined();
  });

  // Test 4: a token too long for its line. The width grows inside the balloon;
  // when the balloon is too narrow even for that, the font shrinks; when no
  // size above the floor fits, the box is flagged at the size it had.
  describe('an unbreakable token', () => {
    const balloon = { kind: 'ellipse', cx: 400, cy: 300, rx: 100, ry: 60 };
    const tokenBox = (text) => ({ id: 'b1', lineN: null, text, x: 350, y: 280, w: 100, h: 40, fit: balloon, style: style() });

    it('widens within the balloon when that is enough', () => {
      const p = load([tokenBox('KRRSSHHH!!')]);
      const b = byId('b1');
      autoFitBox(b, p);
      expect(verdict(b).fits).toBe(true);
      expect(b.style.size).toBe(S);
      expect(b.w).toBeGreaterThan(100);
      expect(b.x).toBeGreaterThanOrEqual(300);
      expect(b.x + b.w).toBeLessThanOrEqual(500);
    });

    it('shrinks the font once the balloon is full width', () => {
      // 20 characters: 220px at 20, in a balloon 200 across.
      const p = load([tokenBox('AAAAAARRRRRGGGGGHHHH')]);
      const b = byId('b1');
      autoFitBox(b, p);
      expect(verdict(b).fits).toBe(true);
      expect(b.review).toBeUndefined();
      expect(b.style.size).toBeLessThan(S);
      expect(b.style.size).toBeGreaterThanOrEqual(0.75 * S);
      // Half-pixel steps, and the largest size that fits: half a pixel more
      // does not.
      expect((b.style.size * 2) % 1).toBe(0);
      const bigger = { ...boxCandidate(b, b.text), x: 300, w: 200, style: { ...b.style, size: b.style.size + 0.5 } };
      expect(containBox(bigger).fits).toBe(false);
      expect(b.x).toBeGreaterThanOrEqual(300);
      expect(b.x + b.w).toBeLessThanOrEqual(500);
    });

    it('flags it, at its own size, when nothing above the floor fits', () => {
      const p = load([tokenBox('AAAAAAAARRRRRRRRGGGGGGGHHHHHHH')]);
      const b = byId('b1');
      autoFitBox(b, p);
      expect(b.style.size).toBe(S);
      // ...and says it is the word that does not fit (OVF-4).
      expect(b.review).toMatchObject({ kind: 'overflow', reason: REVIEW_REASONS.wideWord });
      expect(b.review.overflow.l + b.review.overflow.r).toBeGreaterThan(0);
      // Grown as far as the balloon allows - closer to fitting, and the flag
      // says by how much.
      expect(b.x).toBeCloseTo(300, 6);
      expect(b.w).toBeCloseTo(200, 6);
    });
  });

  // OVF-4. The breaker keeps a word it cannot hyphenate whole, on a line of
  // its own and wider than the box, and the flag it ends up with names the
  // word: what fixes it is a break or a shorter word, not fewer of them.
  describe('a word wider than the balloon', () => {
    const balloon = { kind: 'ellipse', cx: 400, cy: 300, rx: 100, ry: 60 };

    // The review's own example: 478px of SFX in 86px of content at 30px.
    it('widens to the balloon, cannot shrink far enough, and says it is the word', () => {
      const sfx = 'AAAAAARRRRRGGGGGHHHHHHHHH!!!!';
      const s30 = style({ size: 30 });
      const p = load([{ id: 'b1', lineN: null, text: sfx, x: 357, y: 280, w: 86 + 2 * textInset(s30), h: 40, fit: balloon, style: s30 }]);
      const b = byId('b1');
      expect(sfx.length * 0.55 * 30).toBeCloseTo(478.5, 6);
      expect(placeBlock(boxCandidate(b, sfx)).lines).toEqual([sfx]);
      autoFitBox(b, p);
      expect(b.review).toMatchObject({ kind: 'overflow', reason: REVIEW_REASONS.wideWord });
      // As wide as the balloon, at the size the user set: the smallest size the
      // ladder may use (22.5) is still 359px of word.
      expect(b.x).toBeCloseTo(300, 6);
      expect(b.w).toBeCloseTo(200, 6);
      expect(b.style.size).toBe(30);
      expect(b.review.overflow.l).toBeGreaterThan(0);
      expect(b.review.overflow.r).toBeGreaterThan(0);
    });

    // Words the breaker has no hyphen for: no vowels, an accent, an
    // apostrophe. Thirty characters each: 247.5px at the smallest size the
    // ladder may use, in 196px of content.
    it.each([
      ['no vowels', 'KRRSS' + 'H'.repeat(22) + '!!!'],
      ['an accent', 'É'.repeat(30)],
      ['an apostrophe', "Y'KNOW" + 'N'.repeat(24)],
    ])('names the word for one with %s', (_what, word) => {
      expect(word).toHaveLength(30);
      const p = load([{ id: 'b1', lineN: null, text: `NO ${word} NO`, x: 350, y: 280, w: 100, h: 40, fit: balloon, style: style() }]);
      const b = byId('b1');
      autoFitBox(b, p);
      expect(placeBlock(boxCandidate(b, b.text)).lines).toContain(word);
      expect(b.review?.reason).toBe(REVIEW_REASONS.wideWord);
    });

    // A box sized by hand is only flagged, and its flag says why it was left
    // alone; "Fit now" runs the ladder on it, and when that gives up on a word,
    // the flag says so.
    it('says so on a box sized by hand once "Fit now" has tried', () => {
      const p = load([{ id: 'b1', lineN: null, text: 'KRRSS' + 'H'.repeat(22) + '!!!', x: 350, y: 280, w: 100, h: 40, fit: balloon, style: style({ autoHeight: false }) }]);
      const b = byId('b1');
      expect(b.review?.reason).toBe(REVIEW_REASONS.manual);
      fitBoxNow('b1', p);
      expect(b.review?.reason).toBe(REVIEW_REASONS.wideWord);
    });
  });

  // Test 5: text taller than the page. "Taller" is the INK: three lines of
  // capitals at 20 are 66px of line boxes but 58px of glyphs, and it is the
  // glyphs that have to be inside - so the page here is 50 tall.
  describe('text taller than the page', () => {
    const TEXT = 'AAAA BBBB CCCC DDDD EEEE FFFF GGGG';
    it('shrinks the font once the page is full', () => {
      const p = load([{ id: 'b1', lineN: null, text: TEXT, x: 50, y: 5, w: 100, h: 40, style: style() }], { w: 200, h: 50 });
      const b = byId('b1');
      autoFitBox(b, p);
      expect(verdict(b).fits).toBe(true);
      expect(b.style.size).toBeLessThan(S);
      expect(b.style.size).toBeGreaterThanOrEqual(15);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h).toBeLessThanOrEqual(50);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(200);
    });

    it('flags it when even the floor size does not fit', () => {
      const p = load([{ id: 'b1', lineN: null, text: TEXT, x: 50, y: 2, w: 100, h: 16, style: style() }], { w: 200, h: 20 });
      const b = byId('b1');
      autoFitBox(b, p);
      expect(b.style.size).toBe(S);
      expect(b.review?.reason).toBe(REVIEW_REASONS.minSize);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h).toBeLessThanOrEqual(20);
    });

    it('never shrinks below the preference', () => {
      setMinFontSize(19);
      const p = load([{ id: 'b1', lineN: null, text: TEXT, x: 50, y: 5, w: 100, h: 40, style: style() }], { w: 200, h: 50 });
      const b = byId('b1');
      autoFitBox(b, p);
      expect(b.style.size).toBe(S);
      expect(b.review?.reason).toBe(REVIEW_REASONS.minSize);
    });
  });

  it('flags ink on the edge the text is anchored to, which no growth reaches', () => {
    // Left-aligned, its shadow thrown 8px to the left. The inset holds the
    // outline, not a shadow's offset: the shadow falls 6.2px past the left edge
    // (8px, less the 1.8px the outline's outer edge is inside it - the padding
    // less W's overhang behind the pen).
    const s = style({
      align: 'left',
      strokes: [{ color: '#fff', width: 3, opacity: 1 }],
      shadows: [{ color: '#000', x: -8, y: 0, blur: 0, opacity: 1 }],
    });
    const p = load([{ id: 'b1', lineN: null, text: 'WAIT', x: 100, y: 100, w: 200, h: 40, style: s }]);
    const b = byId('b1');
    const before = geomOf(b);
    expect(verdict(b).overflow.l).toBeCloseTo(8 - (BOX_PAD - 0.01 * S), 6);
    autoFitBox(b, p);
    expect(b.review?.reason).toBe(REVIEW_REASONS.alignedEdge);
    expect(b.review.overflow.l).toBe(7);
    // Nothing moved or shrank for it: the text moves with the edge it is
    // anchored to, and a smaller font does not shorten the shadow's throw.
    expect(geomOf(b)).toEqual(before);
  });

  it('is idempotent: run again on its own answer it changes nothing', () => {
    const p = load([{ id: 'b1', lineN: null, text: 'AAAAAARRRRRGGGGGHHHH', x: 350, y: 280, w: 100, h: 40, fit: { kind: 'ellipse', cx: 400, cy: 300, rx: 100, ry: 60 }, style: style() }]);
    const b = byId('b1');
    expect(autoFitBox(b, p)).toBe(true);
    const once = geomOf(b);
    expect(autoFitBox(b, p)).toBe(false);
    expect(geomOf(b)).toEqual(once);
  });

  it('keeps its probes out of the layout memo, and its search bounded', () => {
    const p = load([{ id: 'b1', lineN: null, text: 'AAAA BBBB CCCC DDDD EEEE FFFF GGGG', x: 50, y: 5, w: 100, h: 40, style: style() }], { w: 200, h: 50 });
    clearLayoutMemo();
    measureCalls = 0;
    autoFitBox(byId('b1'), p);
    expect(layoutMemoSize()).toBeLessThanOrEqual(1);
    expect(measureCalls).toBeLessThan(5000);
  });

  it('limits growth to the balloon and the page, never smaller than the box', () => {
    const c = cand({ x: 350, y: 280, w: 100, h: 40, fit: { kind: 'ellipse', cx: 400, cy: 300, rx: 100, ry: 60 } });
    expect(fitLimit(c, { w: 800, h: 1200 }, null)).toEqual({ x0: 300, y0: 240, x1: 500, y1: 360 });
    expect(fitLimit({ ...c, style: style({ balloon: false }) }, { w: 800, h: 1200 }, null)).toEqual({ x0: 0, y0: 0, x1: 800, y1: 1200 });
    // A box already bigger than its balloon keeps its own extent.
    expect(fitLimit({ ...c, x: 250, w: 400 }, { w: 800, h: 1200 }, null)).toMatchObject({ x0: 250, x1: 650 });
    // A longstrip limit is the strip, in this page's coordinates.
    expect(fitLimit(cand({ fit: null }), { w: 800, h: 1200 }, { top: 1200, total: 3600 })).toMatchObject({ y0: -1200, y1: 2400 });
  });
});

// Test 6: a manual box is never moved, resized or shrunk automatically.
describe('a manual box', () => {
  const tooMuch = (extra = {}) => ({ id: 'b1', lineN: null, text: 'AAAA BBBB CCCC DDDD', x: 100, y: 100, w: 60, h: 20, style: style({ autoHeight: false, ...extra }) });

  it('is flagged, and its geometry and size are left alone', () => {
    const p = load([tooMuch()]);
    const b = byId('b1');
    const before = geomOf(b);
    expect(b.review).toMatchObject({ kind: 'overflow', reason: REVIEW_REASONS.manual });
    expect(autoFitBox(b, p)).toBe(false);
    expect(refitPage(p)).toBe(0);
    expect(geomOf(b)).toEqual(before);
    expect(isAutoBox(boxCandidate(b, b.text))).toBe(false);
  });

  it('is fitted by "Fit now", once, as one undo step - and stays manual', () => {
    const p = load([tooMuch()]);
    const b = byId('b1');
    const before = geomOf(b);
    expect(fitBoxNow('b1', p)).toBe(true);
    expect(verdict(b).fits).toBe(true);
    expect(b.review).toBeUndefined();
    expect(b.style.autoHeight).toBe(false);
    const after = geomOf(b);
    // Undo puts back the box AND the flag that described it.
    hist.undo();
    expect(geomOf(byId('b1'))).toEqual(before);
    expect(byId('b1').review).toMatchObject({ kind: 'overflow' });
    hist.redo();
    expect(geomOf(byId('b1'))).toEqual(after);
    expect(byId('b1').review).toBeUndefined();
    // Nothing left to do: no entry.
    expect(fitBoxNow('b1', p)).toBe(false);
  });

  it('becomes auto with "Make auto", fitted in the same undo step', () => {
    const p = load([tooMuch()]);
    const before = geomOf(byId('b1'));
    expect(makeBoxAuto('b1', p)).toBe(true);
    const b = byId('b1');
    expect(b.style.autoHeight).toBe(true);
    expect(verdict(b).fits).toBe(true);
    hist.undo();
    expect(byId('b1').style.autoHeight).toBe(false);
    expect(geomOf(byId('b1'))).toEqual(before);
    expect(byId('b1').review).toBeDefined();
  });

  // Test 7, the part that is not OVF-6: text on a curve is manual, flagged
  // rather than moved, and "Fit now" may shrink its font but not its box.
  it('on a curve keeps its box through "Fit now", which may only shrink the font', () => {
    const p = load([{ id: 'b1', lineN: null, text: 'AROUND AND AROUND WE GO', x: 100, y: 100, w: 80, h: 40, style: style({ curve: 60 }) }]);
    const b = byId('b1');
    const before = geomOf(b);
    expect(b.review?.reason).toBe(REVIEW_REASONS.curve);
    expect(autoFitBox(b, p)).toBe(false);
    expect(geomOf(b)).toEqual(before);
    fitBoxNow('b1', p);
    expect({ x: b.x, y: b.y, w: b.w, h: b.h }).toEqual({ x: before.x, y: before.y, w: before.w, h: before.h });
    expect(b.style.size).toBeLessThanOrEqual(before.size);
    expect(!!b.review).toBe(!verdict(b).fits);
  });
});

describe('the grow-only paths', () => {
  it('never change a width, a position across, or a size on opening', () => {
    const p = load([{ id: 'b1', lineN: null, text: 'AAAAAARRRRRGGGGGHHHH', x: 350, y: 280, w: 100, h: 10, style: style() }]);
    const b = byId('b1');
    expect(b.w).toBe(100);
    expect(b.x).toBe(350);
    expect(b.style.size).toBe(S);
    expect(b.h).toBeGreaterThan(10);
    expect(b.review?.reason).toBe(REVIEW_REASONS.stale);
    expect(refitPage(p)).toBe(0);
  });

  // The component's effect calls this on every relevant change, so it has to
  // settle: a second call changes nothing and reports nothing.
  it('the editor safety net grows the height, flags, and settles', () => {
    const p = load([{ id: 'b1', lineN: null, text: 'AAAAAARRRRRGGGGGHHHH', x: 350, y: 280, w: 100, h: 60, style: style() }]);
    const b = byId('b1');
    const before = geomOf(b);
    autoFitBoxTo(b, 4, p);
    expect(b.h).toBe(neededHeight(4, b.style, BOX_PAD));
    expect({ x: b.x, w: b.w, size: b.style.size }).toEqual({ x: before.x, w: before.w, size: before.size });
    expect(b.review).toBeDefined();
    const once = geomOf(b);
    expect(autoFitBoxTo(b, 4, p)).toBe(false);
    expect(geomOf(b)).toEqual(once);
  });

  // OVF-8. The height these paths give a box is the taller of what its line
  // boxes need and what its ink needs: here a shadow thrown 10px past the
  // block, which no line count knows about. Grown on opening from the edge the
  // block is anchored to, inside and unflagged, and settled - and the editor's
  // safety net, which counts lines it has already broken, gives the same
  // height.
  it.each([
    ['top', 10],
    ['bottom', -10],
    ['middle', 10],
  ])('grow a %s-aligned box for a shadow its line boxes do not hold', (valign, dy) => {
    const s = style({ valign, shadows: [{ color: '#000', x: 0, y: dy, blur: 0, opacity: 1 }] });
    const lineOnly = neededHeight(1, s, textInset(s));
    const p = load([{ id: 'b1', lineN: null, text: 'HELLO', x: 100, y: 300, w: 200, h: lineOnly, style: s }]);
    const b = byId('b1');
    expect(b.h).toBeGreaterThan(lineOnly);
    // By no more than the throw: twice it for a centred block, which grows
    // half on each side.
    expect(b.h - lineOnly).toBeLessThanOrEqual((valign === 'middle' ? 2 : 1) * Math.abs(dy) + 1);
    expect(verdict(b).fits).toBe(true);
    expect(b.review).toBeUndefined();
    if (valign === 'top') expect(b.y).toBe(300);
    else if (valign === 'bottom') expect(b.y + b.h).toBe(300 + lineOnly);
    else expect(b.y + b.h / 2).toBeCloseTo(300 + lineOnly / 2, 6);
    expect({ x: b.x, w: b.w, size: b.style.size }).toEqual({ x: 100, w: 200, size: S });
    expect(refitPage(p)).toBe(0);
    const grown = geomOf(b);
    b.y = 300;
    b.h = lineOnly;
    expect(autoFitBoxTo(b, 1, p)).toBe(true);
    expect(geomOf(b)).toEqual(grown);
    expect(autoFitBoxTo(b, 1, p)).toBe(false);
  });

  // ...but never for ink past the edge the block is anchored to: the block
  // moves with that edge, so no height clears it. Flagged, as it was.
  it('do not grow a box for ink past the edge its block is anchored to', () => {
    const s = style({ valign: 'top', shadows: [{ color: '#000', x: 0, y: -10, blur: 0, opacity: 1 }] });
    const lineOnly = neededHeight(1, s, textInset(s));
    load([{ id: 'b1', lineN: null, text: 'HELLO', x: 100, y: 300, w: 200, h: lineOnly, style: s }]);
    const b = byId('b1');
    expect(geomOf(b)).toEqual({ x: 100, y: 300, w: 200, h: lineOnly, size: S });
    expect(b.review).toMatchObject({ kind: 'overflow', reason: REVIEW_REASONS.stale });
    expect(b.review.overflow.t).toBeGreaterThan(CONTAIN_TOL);
  });

  it('a drag that makes the text overflow flags it and resizes nothing else', () => {
    const p = load([{ id: 'b1', lineN: null, text: 'HELLO THERE', x: 100, y: 100, w: 200, h: 60, style: style() }]);
    expect(byId('b1').review).toBeUndefined();
    resizeBox(1, 'b1', { x: 100, y: 100, w: 30, h: 60 });
    const b = byId('b1');
    expect(b.w).toBe(30);
    expect(b.review).toMatchObject({ kind: 'overflow' });
    resizeBox(1, 'b1', { x: 100, y: 100, w: 200, h: 60 });
    expect(byId('b1').review).toBeUndefined();
    expect(p.boxes).toHaveLength(1);
  });
});

describe('the flag in the document', () => {
  it('survives a save and a load', () => {
    load([{ id: 'b1', lineN: null, text: 'AAAA BBBB CCCC DDDD', x: 100, y: 100, w: 60, h: 20, style: style({ autoHeight: false }) }]);
    const flagged = JSON.parse(JSON.stringify(byId('b1').review));
    expect(flagged).toBeTruthy();
    const saved = JSON.parse(JSON.stringify(app.pages));
    expect(saved[0].boxes[0].review).toEqual(flagged);
    loadProjectPages(saved);
    expect(JSON.parse(JSON.stringify(byId('b1').review))).toEqual(flagged);
  });

  it('is listed for the queue and the export', () => {
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [], boxes: [{ id: 'a', lineN: null, text: 'AAAA BBBB CCCC', x: 0, y: 0, w: 30, h: 20, style: style({ autoHeight: false }) }] },
      { id: 2, w: 800, h: 1200, lines: [], boxes: [{ id: 'b', lineN: null, text: 'OK', x: 0, y: 0, w: 200, h: 60, style: style() }] },
    ]);
    const list = flaggedBoxes();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ pageId: 1, boxId: 'a', review: { kind: 'overflow', reason: REVIEW_REASONS.manual } });
  });

  it('follows an undone text edit back to the geometry it restores', () => {
    const p = load([{ id: 'b1', lineN: null, text: 'OK', x: 100, y: 100, w: 60, h: 30, style: style({ autoHeight: false }) }]);
    expect(byId('b1').review).toBeUndefined();
    beginEdit('b1');
    endEdit('AAAA BBBB CCCC DDDD EEEE');
    expect(byId('b1').review).toBeDefined();
    hist.undo();
    expect(byId('b1').text).toBe('OK');
    expect(byId('b1').review).toBeUndefined();
    hist.redo();
    expect(byId('b1').review).toBeDefined();
    expect(p.boxes).toHaveLength(1);
  });

  it('records the whole fit - x, y, w, h and size - on a text edit', () => {
    load([{ id: 'b1', lineN: null, text: 'OK', x: 350, y: 280, w: 100, h: 40, fit: { kind: 'ellipse', cx: 400, cy: 300, rx: 100, ry: 60 }, style: style() }]);
    const before = geomOf(byId('b1'));
    beginEdit('b1');
    endEdit('AAAAAARRRRRGGGGGHHHH');
    const after = geomOf(byId('b1'));
    expect(after.w).toBeGreaterThan(before.w);
    expect(after.size).toBeLessThan(before.size);
    hist.undo();
    expect(geomOf(byId('b1'))).toEqual(before);
    hist.redo();
    expect(geomOf(byId('b1'))).toEqual(after);
    expect(fitGeom(byId('b1'))).toEqual(after);
  });
});

// Test 9: one statement of where the block sits, read by the PSD writer as by
// the check. (The raster exporter's half is in measure.realfont.test.js, which
// has a canvas that can paint.)
describe('parity', () => {
  it('the PSD type layer carries placeBlock’s lines and anchor', () => {
    const p = load([
      { id: 'b1', lineN: null, text: 'NOBODY TOLD ME ABOUT THE CAT', x: 120, y: 200, w: 140, h: 200, fit: { kind: 'ellipse', cx: 190, cy: 300, rx: 90, ry: 110 }, style: style({ valign: 'middle' }) },
    ]);
    const b = byId('b1');
    const place = placeBlock(boxCandidate(b, b.text));
    const layer = psd.textLayerFor(p, b, null);
    expect(layer.text.text).toBe(place.lines.join('\n'));
    const [, , , , tx, ty] = layer.text.transform;
    expect(tx).toBeCloseTo(b.x + BOX_PAD, 6);
    expect(ty).toBeCloseTo(b.y + place.blockY, 6);
  });

  it('a flagged box says so in its PSD layer name, and the importer takes it off again', () => {
    const p = load([{ id: 'b1', lineN: null, text: 'AAAA BBBB CCCC DDDD', x: 100, y: 100, w: 60, h: 20, style: style({ autoHeight: false }) }]);
    const b = byId('b1');
    expect(psd.textLayerFor(p, b, null).name.endsWith(psd.REVIEW_MARK)).toBe(true);
    const raster = psd.textLayerFor(p, { ...b, style: { ...b.style, roughen: { on: true, amount: 2 } } }, { left: 0, top: 0, right: 1, bottom: 1, imageData: {} });
    expect(raster.name.endsWith(`${psd.REVIEW_MARK}${psd.RASTER_MARK}`)).toBe(true);
  });
});

// Test 8: the invariant, over random boxes. After every path that can change
// what a box has to fit - opening, an edit's ladder, a drag, a text edit and
// its undo - a box that overflows is flagged and a box that is flagged
// overflows. Never one without the other.
describe('the invariant, over random boxes', () => {
  // A seeded generator, so a failure names a case that can be run again.
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const WORDS = ['HELLO', 'what', 'WAIT', 'ÉTÉ', 'Jumpy', 'fluffy', 'AAAAAARRRRRGGGGGHHHH', 'KRRSSHH!!', 'no', 'I', 'the', 'CAT', 'jay', '...', 'Ñandú'];

  const randomBox = (r, i) => {
    const pick = (list) => list[Math.floor(r() * list.length)];
    const n = 1 + Math.floor(r() * 7);
    const text = Array.from({ length: n }, () => pick(WORDS)).join(' ');
    const w = 20 + r() * 260;
    const h = 10 + r() * 160;
    const x = r() * 500;
    const y = r() * 900;
    const strokes = Array.from({ length: Math.floor(r() * 3) }, () => ({ color: '#fff', width: Math.round(r() * 6), opacity: 1 }));
    const shadows = Array.from({ length: Math.floor(r() * 2.5) }, () => ({
      color: '#000',
      x: Math.round(r() * 16 - 8),
      y: Math.round(r() * 16 - 8),
      blur: Math.round(r() * 4),
      opacity: r() < 0.2 ? 0 : 1,
    }));
    const s = style({
      size: 10 + Math.round(r() * 30),
      lineHeight: 0.8 + r() * 0.6,
      align: pick(['left', 'center', 'right']),
      valign: pick(['top', 'middle', 'bottom']),
      italic: r() < 0.3,
      uppercase: r() < 0.3,
      letterSpacing: Math.round(r() * 8 - 2),
      strokes,
      shadows,
      flipH: r() < 0.15,
      flipV: r() < 0.15,
      autoHeight: r() < 0.8,
      curve: r() < 0.1 ? 40 : 0,
    });
    const fit = r() < 0.4 ? { kind: 'ellipse', cx: x + w / 2, cy: y + h / 2, rx: w / 2 + r() * 80, ry: h / 2 + r() * 60 } : null;
    return { id: `b${i}`, lineN: null, text, x, y, w, h, fit, style: s };
  };

  const holds = (p, when) => {
    for (const b of p.boxes) {
      const v = verdict(b, p);
      const label = `${when}: ${b.id} ${JSON.stringify({ text: b.text, x: b.x, y: b.y, w: b.w, h: b.h, review: b.review ?? null })}`;
      expect(!!b.review, label).toBe(!v.fits);
      if (b.review) expect(b.review, label).toEqual(reviewFor(v, b.review.reason));
    }
  };

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i', (seed) => {
    const r = rng(seed * 7919);
    const boxes = Array.from({ length: 12 }, (_, i) => randomBox(r, i));
    const p = load(boxes, { w: 600 + Math.round(r() * 600), h: 900 + Math.round(r() * 600) });
    holds(p, 'opened');
    for (const b of p.boxes) autoFitBox(b, p);
    holds(p, 'fitted');
    for (const b of p.boxes.slice(0, 4)) resizeBox(1, b.id, { x: b.x, y: b.y, w: Math.max(10, b.w * (0.5 + r())), h: Math.max(10, b.h * (0.5 + r())) });
    holds(p, 'dragged');
    const edited = p.boxes[Math.floor(r() * p.boxes.length)];
    beginEdit(edited.id);
    endEdit(`${edited.text} ${WORDS[Math.floor(r() * WORDS.length)]}`);
    holds(p, 'edited');
    hist.undo();
    holds(p, 'undone');
    hist.redo();
    holds(p, 'redone');
    for (const b of p.boxes) setBoxText(b, `${b.text}`, p);
    holds(p, 'refitted');
  });
});
