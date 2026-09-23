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

const { BOX_PAD, setTypesetEnabled, clearLayoutMemo, layoutMemoSize, canMeasure } = measure;
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

  // Test 1: the default 3px outline on a full-width line. The outline reaches
  // 3px past the glyphs and the padding is 2, so the check has to see a box
  // that does not fit - which is what nothing checked before.
  it('counts the default 3px outline on every side', () => {
    const c = cand({ text: FULL, w: fullW, h: 40, style: style({ strokes: [{ color: '#fff', width: 3, opacity: 1 }] }) });
    const v = containBox(c);
    expect(v.fits).toBe(false);
    expect(v.overflow.l).toBeCloseTo(3 + 0.2 - (fullW - 9 * ADV) / 2, 6);
    expect(v.overflow.r).toBeCloseTo(3 - (fullW - 9 * ADV) / 2, 6);
    expect(v.overflow.t).toBe(0);
    expect(v.overflow.b).toBe(0);
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
  // Test 1, the fixing half: an edit fits the full-width outlined line by
  // widening the box, symmetrically, just enough.
  it('widens a centred box clear of its outline', () => {
    const w = 9 * ADV + BOX_PAD * 2 + 0.01;
    const p = load([{ id: 'b1', lineN: null, text: 'WAIT WHAT', x: 300, y: 300, w, h: 40, style: style({ strokes: [{ color: '#fff', width: 3, opacity: 1 }] }) }]);
    const b = byId('b1');
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

  // Test 3, the fixing half.
  it('grows the height for an accent above a tight leading, and the width for an italic', () => {
    const p = load([
      // Outlined, as the default style is: the accent clears the line box by
      // itself, and the outline takes it over the top of the box.
      { id: 'acc', lineN: null, text: 'ÉTÉ', x: 100, y: 100, w: 200, h: 10, style: style({ lineHeight: 0.9, strokes: [{ color: '#fff', width: 3, opacity: 1 }] }) },
      { id: 'ita', lineN: null, text: 'fff', x: 100, y: 300, w: 3 * ADV + BOX_PAD * 2, h: 40, style: style({ align: 'left', italic: true }) },
    ]);
    for (const id of ['acc', 'ita']) {
      const b = byId(id);
      expect(b.review, id).toBeDefined();
      autoFitBox(b, p);
      expect(verdict(b).fits, id).toBe(true);
      expect(b.review, id).toBeUndefined();
    }
    // The accent box grew past the line-box height `neededHeight` gives it.
    expect(byId('acc').h).toBeGreaterThan(neededHeight(1, byId('acc').style, BOX_PAD));
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
      expect(b.review).toMatchObject({ kind: 'overflow', reason: REVIEW_REASONS.minSize });
      expect(b.review.overflow.l + b.review.overflow.r).toBeGreaterThan(0);
      // Grown as far as the balloon allows - closer to fitting, and the flag
      // says by how much.
      expect(b.x).toBeCloseTo(300, 6);
      expect(b.w).toBeCloseTo(200, 6);
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
    // Left-aligned J: its tail reaches behind the pen, past the padding.
    const p = load([{ id: 'b1', lineN: null, text: 'JJJ', x: 100, y: 100, w: 200, h: 40, style: style({ align: 'left', strokes: [{ color: '#fff', width: 3, opacity: 1 }] }) }]);
    const b = byId('b1');
    const before = geomOf(b);
    autoFitBox(b, p);
    expect(b.review?.reason).toBe(REVIEW_REASONS.alignedEdge);
    expect(b.review.overflow.l).toBeGreaterThan(0);
    // Nothing shrank for it: a smaller font does not move the anchor.
    expect(b.style.size).toBe(before.size);
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
