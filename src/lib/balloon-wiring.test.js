import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';

// ===========================================================================
// The balloon, wired into the app
// ===========================================================================
// `balloon.js` and its own test file prove that a shape can be recovered from a
// page's pixels. Nothing in either of them says the app ever asks. This file is
// about the wiring: that a click places a box on the balloon's frame, that the
// shape is kept on the box, that every layout path lays text out inside it,
// that a save and a PSD round trip carry it, and - the half that
// matters most - that all four of the ways a fit can fail land the user on
// exactly the behaviour they had before any of this existed.
//
// Two mocks, both of them a permission rather than a fake.
//
//   `page-pixels.js` is the app's decoder, and it needs a canvas. Under node
//   there is none, so it correctly answers null forever and placement would
//   never take the fitted branch at all. What is replaced is the single lookup
//   function, so the test decides which page the pixels belong to; the pixels
//   themselves are built by hand below, exactly as balloon.test.js builds them,
//   and the real `detectBalloon` runs over them.
//
//   `measure.js`'s `canMeasure` is the same one-line permission autofit.test.js
//   grants, and for the same reason: the stand-in metric
//   (`chars * size * 0.55`) is deterministic and perfectly good for deciding
//   where a line breaks, and the only thing this environment lacks is the
//   licence to use it. Everything else - the real `layoutLines`, the real
//   `balanceLines`, the real `interiorLineWidths` - runs.
//
//   `lookup` is the seam for the one test that is ABOUT the cache rather than
//   about the fit: set it and the stub steps aside, so `pagePixelsFor` is the
//   real module's own, reading the real map. Everything else leaves it null and
//   gets the flat answer above.
let pixels = null;
let lookup = null;
vi.mock('./page-pixels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  pagePixelsFor: (p) => (lookup ? lookup(p) : pixels),
}));
vi.mock('./measure.js', async (importOriginal) => ({
  ...(await importOriginal()),
  canMeasure: () => true,
}));

const {
  app,
  page,
  loadProjectPages,
  placeActiveAt,
  placementRect,
  transposeRect,
  fittedRect,
  refitBalloon,
  setPageDims,
  BULK_PROPS,
  selectBox,
  autoFitBox,
  autoFitBoxTo,
  setLineText,
  settleEdits,
  flaggedBoxes,
  reviewBox,
  setBoxText,
  resizeBox,
  nudgeBox,
  fitBoxNow,
  toggleBalloonFit,
  reviewOf,
  noteFontsChanged,
  fitGeom,
  boxEdited,
  boxSnap,
  boxEditRecords,
  boxText,
  moveGeom,
  moveBoxTo,
  duplicateBox,
  translateFit,
} = await import('./store.svelte.js');
const { copyStyle, pasteStyle } = await import('./presets.svelte.js');
const { tags } = await import('./tags.svelte.js');
const { containBox, boxCandidate, placeBlock, REVIEW_REASONS } = await import('./contain.js');
const { balloonWidthsFor, lineIndents, textInset, contentWidth, layoutLines, lineWidth, setTypesetEnabled } =
  await import('./measure.js');
// Balloon layout is part of the typesetting beta, which is off until the user
// turns it on - so this file, which is about that beta being wired up, turns it
// on for the whole run.
setTypesetEnabled(true);
const { inscribedRect, balloonFrame, interiorLineWidths, layoutShape, shapeBounds } = await import('./balloon.js');
// What layout reads for a stored fit: a found outline is a `poly`, laid out
// as the formula that explains it (`layoutShape`).
const L = (fit) => layoutShape(fit);
// The outline's own extent, which is what containment holds a box inside.
const top = (fit) => shapeBounds(fit).y;
const bottom = (fit) => shapeBounds(fit).y + shapeBounds(fit).h;
const { defaultStyle, normalizeStyle, normalizeFit } = await import('./data.js');
const { serializePage } = await import('./psd.js');
const hist = await import('./editor/history.svelte.js');

// ---------------------------------------------------------------------------
// The fixtures, lifted from balloon.test.js: an `ImageData`-shaped object built
// by hand, paper near white and ink near black, with a balloon drawn as one
// closed shape so a tail or an outline is part of the same figure rather than
// something laid over it.
// ---------------------------------------------------------------------------
const PAPER = 248;
const INK = 18;

function pageImage(w, h, fill = PAPER) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill;
    data[i * 4 + 1] = fill;
    data[i * 4 + 2] = fill;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

const put = (img, x, y, v) => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = v;
  img.data[i + 1] = v;
  img.data[i + 2] = v;
  img.data[i + 3] = 255;
};

const fillRect = (img, x, y, w, h, v) => {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(img, xx, yy, v);
};

function drawEllipse(img, cx, cy, rx, ry, ring = 3) {
  const r = (x, y, g) => Math.hypot((x + 0.5 - cx) / (rx + g), (y + 0.5 - cy) / (ry + g));
  for (let y = Math.floor(cy - ry - ring - 2); y <= Math.ceil(cy + ry + ring + 2); y++) {
    for (let x = Math.floor(cx - rx - ring - 2); x <= Math.ceil(cx + rx + ring + 2); x++) {
      if (r(x, y, 0) <= 1) put(img, x, y, PAPER);
      else if (r(x, y, ring) <= 1) put(img, x, y, INK);
    }
  }
}

// The same balloon leaning `deg` - which no upright ellipse describes (GEO-5).
function drawTiltedEllipse(img, cx, cy, rx, ry, deg, ring = 3) {
  const t = (deg * Math.PI) / 180;
  const r = (x, y, g) => {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    return Math.hypot((dx * Math.cos(t) + dy * Math.sin(t)) / (rx + g), (dy * Math.cos(t) - dx * Math.sin(t)) / (ry + g));
  };
  const e = rx + ring + 2;
  for (let y = Math.floor(cy - e); y <= Math.ceil(cy + e); y++) {
    for (let x = Math.floor(cx - e); x <= Math.ceil(cx + e); x++) {
      if (r(x, y, 0) <= 1) put(img, x, y, PAPER);
      else if (r(x, y, ring) <= 1) put(img, x, y, INK);
    }
  }
}

function drawBox(img, x, y, w, h, ring = 3) {
  fillRect(img, x - ring, y - ring, w + 2 * ring, h + 2 * ring, INK);
  fillRect(img, x, y, w, h, PAPER);
}

// A column of vertical Japanese, so the detected block's centre lands on ink -
// which is the whole reason the seed search in `fillInterior` exists.
function drawGlyphColumn(img, x, y, w, h, glyph = 22, gapY = 6) {
  for (let gy = y; gy + glyph <= y + h; gy += glyph + gapY) {
    fillRect(img, x, gy, w, glyph, INK);
    fillRect(img, x + 4, gy + 4, Math.max(1, w - 8), Math.max(1, glyph - 8), PAPER);
  }
}

// A jagged SFX burst: the shape `fitBalloonShape` refuses as irregular, and so
// the fixture for "the fallback fires on a fit nobody should believe".
function drawBurst(img, cx, cy, r, spikes = 9) {
  for (let y = cy - r - 4; y <= cy + r + 4; y++) {
    for (let x = cx - r - 4; x <= cx + r + 4; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const rr = r * (0.45 + 0.55 * Math.abs(Math.cos(spikes * Math.atan2(dy, dx))));
      put(img, x, y, Math.hypot(dx, dy) <= rr ? PAPER : INK);
    }
  }
}

// One detected line, one page. `box` is the detector's block in page
// coordinates; `vertical` is its claim about how the Japanese in it was set.
const withDetect = (block, vertical, w = 500, h = 500, lang = undefined) => [
  {
    id: 1,
    w,
    h,
    lines: [{ n: 1, type: 'dialogue', jp: lang === 'ko' ? '가' : 'あ', en: '', ...(lang ? { lang } : {}) }],
    boxes: [],
    detect: { panels: [], boxes: [{ n: 1, box: block, vertical, font_size: 20, ...(lang ? { lang } : {}) }] },
  },
];

const round2 = (v) => Math.round(v * 100) / 100;

beforeEach(() => {
  app.chapterRef = null;
  pixels = null;
  lookup = null;
});

// ---------------------------------------------------------------------------
describe('placement, when the page can be looked at', () => {
  // The motivating case, end to end and through the app rather than through the
  // module: a 20x140 column of vertical Japanese inside a 260x160 oval. The box
  // the click produces has to come out wide and short, because that is the shape
  // of the room the balloon actually has.
  const ovalPage = () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 130, 80);
    drawGlyphColumn(img, 240, 180, 20, 140);
    return img;
  };

  it('sizes and centres the box on the balloon’s frame', () => {
    loadProjectPages(withDetect([240, 180, 260, 320], true));
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const b = page().boxes[0];

    // The fit is stored, and it is the plain JSON the schema promises - two
    // decimals, five keys, no mask anywhere near it.
    expect(L(b.fit).kind).toBe('ellipse');
    expect(Object.keys(L(b.fit)).sort()).toEqual(['cx', 'cy', 'kind', 'rx', 'ry']);
    expect(JSON.parse(JSON.stringify(b.fit))).toEqual(b.fit);
    expect(L(b.fit).cx).toBeCloseTo(250, -1);
    expect(L(b.fit).cy).toBeCloseTo(250, -1);

    // And the box is that shape's frame - not the detector's rect inset by 8%,
    // which is what it would have been. GEO-1 changed it from the inscribed
    // rectangle: as wide as the inset balloon, so its rows are not all capped
    // to one width, and as tall as the inscribed rectangle, as before.
    const r = balloonFrame(b.fit);
    expect([b.x, b.y, b.w, b.h].map(round2)).toEqual([r.x, r.y, r.w, r.h].map(round2));
    const ins = inscribedRect(b.fit);
    expect(round2(b.w)).toBe(round2(ins.w * Math.SQRT2));
    expect(round2(b.h)).toBe(round2(ins.h));
    // Read in absolute terms so the claim survives a change of helper: the
    // detected block was 20 wide and 140 tall, and the box is the other way up.
    expect(b.w).toBeGreaterThan(150);
    expect(b.h).toBeLessThan(110);
    expect(b.w).toBeGreaterThan(b.h);
  });

  // GEO-5: a leaning balloon is stored as its rows, the box goes on their frame,
  // and the centred block is broken to the room each row has about the axis.
  it('places a box on a tilted balloon by its rows', () => {
    loadProjectPages(withDetect([240, 180, 260, 320], true));
    const img = pageImage(500, 500);
    drawTiltedEllipse(img, 250, 250, 130, 75, 25);
    drawGlyphColumn(img, 240, 180, 20, 140);
    pixels = img;
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    expect(L(b.fit).kind).toBe('rows');
    expect(JSON.parse(JSON.stringify(b.fit))).toEqual(b.fit);
    const r = balloonFrame(b.fit);
    expect([b.x, b.y, b.w, b.h].map(round2)).toEqual([r.x, r.y, r.w, r.h].map(round2));
    expect(b.x + b.w / 2).toBeCloseTo(250, -1);
    b.style = normalizeStyle({ ...b.style, size: 20, lineHeight: 1, valign: 'middle' });
    const rows = balloonWidthsFor(b, b.style, 20)(3);
    expect(rows[1]).toBeGreaterThan(rows[0]);
    expect(rows[1]).toBeGreaterThan(rows[2]);
    for (const w of rows) expect(w).toBeLessThanOrEqual(contentWidth(b.w, b.style));
  });

  // The transpose is for the case where nothing better is known. When a balloon
  // was fitted, its inscribed rect already says how wide the room is, and
  // swapping the sides of that would be a heuristic overruling a measurement.
  it('does not also transpose a vertical block it managed to fit', () => {
    loadProjectPages(withDetect([240, 180, 260, 320], true));
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const fitted = page().boxes[0];

    loadProjectPages(withDetect([240, 180, 260, 320], true));
    pixels = null;
    placeActiveAt(250, 250);
    const transposed = page().boxes[0];

    // Both are wide, and they are wide for different reasons and by different
    // amounts: one is the balloon, the other is the block stood on its side.
    expect(transposed.w).toBeGreaterThan(transposed.h);
    expect(round2(fitted.w)).not.toBe(round2(transposed.w));
  });

  it('recovers a narration panel as a rectangle', () => {
    const img = pageImage(400, 300);
    drawBox(img, 60, 60, 260, 120);
    drawGlyphColumn(img, 180, 80, 20, 80);
    loadProjectPages(withDetect([180, 80, 200, 160], true, 400, 300));
    pixels = img;
    placeActiveAt(190, 120);
    const b = page().boxes[0];
    expect(L(b.fit).kind).toBe('rect');
    expect(Object.keys(L(b.fit)).sort()).toEqual(['h', 'kind', 'w', 'x', 'y']);
    expect(L(b.fit).w).toBeCloseTo(260, -1);
  });

  // Off the page is recoverable by dragging; a box that hangs off it because the
  // arithmetic never looked is not.
  it('clamps a fitted box onto the page like every other placement', () => {
    const g = fittedRect({ w: 300, h: 300 }, { kind: 'rect', x: 200, y: 200, w: 200, h: 200 });
    expect(g.x + g.w).toBeLessThanOrEqual(300);
    expect(g.y + g.h).toBeLessThanOrEqual(300);
    // And a page nobody has measured is not clamped against at all - the same
    // rule `placementRect` follows, for the same reason.
    const un = fittedRect({ w: 0, h: 0 }, { kind: 'rect', x: 200, y: 200, w: 200, h: 200 });
    expect(un.x).toBeGreaterThan(190);
  });
});

// ---------------------------------------------------------------------------
describe('placement, when there is no fit to be had', () => {
  // Every one of these has to produce EXACTLY what the app produced before
  // fitting existed. `balloon.js` refuses bad fits on purpose, so this is not a
  // rare path - it is the path a thought cloud, an SFX burst and every
  // un-decoded page take.
  const expectFallback = (block, vertical) => {
    const b = page().boxes[0];
    expect(b.fit).toBe(null);
    const want = placementRect(
      page(),
      vertical ? transposeRect(block) : block,
      0,
      0,
    );
    expect([b.x, b.y, b.w, b.h]).toEqual([want.x, want.y, want.w, want.h]);
  };

  it('falls back on an irregular fit', () => {
    const img = pageImage(400, 400);
    drawBurst(img, 200, 200, 120);
    loadProjectPages(withDetect([170, 170, 230, 230], false, 400, 400));
    pixels = img;
    placeActiveAt(200, 200);
    expectFallback([170, 170, 230, 230], false);
  });

  // The fill runs out through the gap in an open outline and measures the paper
  // around the bubble instead. It very often fits a beautiful rectangle, which
  // is exactly why it is refused before anything is fitted.
  it('falls back when the fill escapes its window', () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 90, 60);
    fillRect(img, 330, 240, 24, 24, PAPER); // punch the outline open
    loadProjectPages(withDetect([220, 220, 280, 280], false));
    pixels = img;
    placeActiveAt(250, 250);
    expectFallback([220, 220, 280, 280], false);
  });

  it('falls back when the page has not been decoded', () => {
    loadProjectPages(withDetect([170, 170, 230, 230], false, 400, 400));
    pixels = null;
    placeActiveAt(200, 200);
    expectFallback([170, 170, 230, 230], false);
  });

  // A tall narrow column of Japanese wants the opposite rectangle in English,
  // and with no balloon to measure, the block's own aspect stood on its head is
  // the best guess available.
  it('transposes a vertical block about its centre', () => {
    loadProjectPages(withDetect([220, 100, 280, 400], true));
    pixels = null;
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    expect(b.fit).toBe(null);
    // 60x300 about (250,250) becomes 300x60: inset 5 a side, so 290x50 at
    // (105,225). Written out rather than derived, because the whole point is
    // that the box is now wider than it is tall.
    expect([b.x, b.y, b.w, b.h]).toEqual([105, 225, 290, 50]);
    expect(b.w).toBeGreaterThan(b.h);
  });

  it('does not auto-transpose a tall Korean block when vertical is null/unset, while ja still is', () => {
    // JA block with vertical: null auto-transposes on aspect ratio
    loadProjectPages(withDetect([220, 100, 280, 400], null, 500, 500, 'ja'));
    pixels = null;
    placeActiveAt(250, 250);
    const bJa = page().boxes[0];
    expect(bJa.w).toBeGreaterThan(bJa.h);
    expect([bJa.x, bJa.y, bJa.w, bJa.h]).toEqual([105, 225, 290, 50]);

    // Korean block with vertical: null/unset is NOT transposed on aspect ratio alone
    loadProjectPages(withDetect([220, 100, 280, 400], null, 500, 500, 'ko'));
    pixels = null;
    placeActiveAt(250, 250);
    const bKo = page().boxes[0];
    expect(bKo.w).toBeLessThan(bKo.h);
    expect([bKo.x, bKo.y, bKo.w, bKo.h]).toEqual([225, 105, 50, 290]);

    // Explicit vertical: true on Korean DOES transpose
    loadProjectPages(withDetect([220, 100, 280, 400], true, 500, 500, 'ko'));
    pixels = null;
    placeActiveAt(250, 250);
    const bKoVert = page().boxes[0];
    expect(bKoVert.w).toBeGreaterThan(bKoVert.h);
    expect([bKoVert.x, bKoVert.y, bKoVert.w, bKoVert.h]).toEqual([105, 225, 290, 50]);
  });

  it('leaves a horizontal block exactly as it was placed before', () => {
    loadProjectPages(withDetect([220, 100, 280, 400], false));
    pixels = null;
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    expect([b.x, b.y, b.w, b.h]).toEqual([225, 105, 50, 290]);
  });

  it('transposes about the centre and nothing else', () => {
    expect(transposeRect([100, 200, 300, 800])).toEqual([-100, 400, 500, 600]);
    // A rect that is already square is its own transpose, and a non-rect is
    // handed back untouched rather than turned into NaNs.
    expect(transposeRect([0, 0, 10, 10])).toEqual([0, 0, 10, 10]);
    expect(transposeRect(null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
describe('balloonWidthsFor - the one helper the three layout sites share', () => {
  // On the balloon `ell` below, centred: the rows are read where the box draws
  // its block (GEO-2), so a box off the balloon would be measured somewhere else.
  const boxWith = (fit, style = {}) => ({
    id: 'b1',
    lineN: null,
    text: 'X',
    x: 150,
    y: 200,
    w: 200,
    h: 100,
    style: normalizeStyle({ size: 20, lineHeight: 1, valign: 'middle', ...style }),
    fit,
  });
  const ell = { kind: 'ellipse', cx: 250, cy: 250, rx: 130, ry: 80 };

  it('answers null for a box with no fit, so that path cannot change', () => {
    const b = boxWith(null);
    expect(balloonWidthsFor(b, b.style, b.style.size)).toBe(null);
  });

  it('answers null for a fit the schema does not recognise', () => {
    for (const bad of [
      { kind: 'blob', x: 1, y: 2, w: 3, h: 4 },
      { kind: 'ellipse', cx: 1, cy: 2, rx: Number.NaN, ry: 4 },
      { kind: 'ellipse', cx: 1, cy: 2, rx: 0, ry: 4 },
      { kind: 'rect', x: 1, y: 2, w: 3 },
      'ellipse',
      42,
    ]) {
      const b = boxWith(bad);
      expect(balloonWidthsFor(b, b.style, b.style.size)).toBe(null);
    }
  });

  it('answers null when the style has balloon layout switched off', () => {
    const b = boxWith(ell, { balloon: false });
    expect(balloonWidthsFor(b, b.style, b.style.size)).toBe(null);
  });

  // A rectangle has the same room on every line, which is precisely the flat
  // number the breaker has always been given - so a narration box goes through
  // the fitted path and comes out where it started.
  it('is a constant width inside a rectangle', () => {
    const b = boxWith({ kind: 'rect', x: 0, y: 0, w: 120, h: 400 });
    const w = balloonWidthsFor(b, b.style, b.style.size)(4);
    expect(w.length).toBe(4);
    expect(new Set(w).size).toBe(1);
    // 120 wide, inset 10 a side by `safetyInset` (8% of the shorter side, which
    // is the 120), then the box's own text inset off each edge because the text
    // is broken inside a box that pads itself and leaves its outline room: the
    // 2px padding plus the default 3px outline (OVF-3; it was the padding alone).
    expect(textInset(b.style)).toBe(5);
    expect(w[0]).toBe(120 - 2 * 10 - 2 * textInset(b.style));
  });

  it('narrows the first and last lines inside an ellipse', () => {
    const b = boxWith(ell);
    const w = balloonWidthsFor(b, b.style, b.style.size)(5);
    expect(w.length).toBe(5);
    expect(w[0]).toBeLessThan(w[2]);
    expect(w[4]).toBeLessThan(w[2]);
    // Symmetric about the middle for a middle-aligned block, because the
    // ellipse is.
    expect(round2(w[0])).toBe(round2(w[4]));
    for (const v of w) expect(v).toBeGreaterThan(0);
  });

  // This box is narrower than the balloon - 200 across a 234 interior, as a box
  // narrowed by hand is, or one placed at the inscribed rectangle before GEO-1 -
  // so the interior across the middle of the ellipse is wider than the box.
  // Uncapped, the middle lines would be laid out past the rectangle the user
  // drags.
  it('never hands back more room than the box itself has', () => {
    const b = boxWith(ell);
    const contentW = contentWidth(b.w, b.style);
    for (const v of balloonWidthsFor(b, b.style, b.style.size)(6)) {
      expect(v).toBeLessThanOrEqual(contentW);
    }
  });

  // GEO-1, the review's own case: a balloon whose inset interior is 120x160
  // (134x174 less the 14px cap on `safetyInset`), six lines of 30. At the
  // inscribed rectangle the box was 169.7 wide and every row was capped to its
  // 165.7 content width - a rectangle. At the frame the rows keep the balloon's
  // taper, less the box's inset, and every one of them is inside the box.
  it('keeps the taper of every row on a box placed at the frame', () => {
    const fit = { kind: 'ellipse', cx: 400, cy: 400, rx: 134, ry: 174 };
    const g = fittedRect({ w: 1000, h: 1000 }, fit);
    expect(round2(g.w)).toBe(240);
    expect(round2(g.h)).toBe(round2(160 * Math.SQRT2));
    const b = { ...boxWith(fit, { lineHeight: 1.5, strokes: [] }), ...g };
    const inset = textInset(b.style);
    expect(inset).toBe(2);
    const w = balloonWidthsFor(b, b.style, b.style.size)(6);
    expect(w.map((v) => Math.round((v + 2 * inset) * 10) / 10)).toEqual([198.4, 222.5, 235.7, 235.7, 222.5, 198.4]);
    const contentW = contentWidth(b.w, b.style);
    expect(contentW).toBe(236);
    for (const v of w) expect(v).toBeLessThanOrEqual(contentW);
  });

  // Every alignment follows the balloon: a flush line is set in to its row's
  // edge (`lineIndents`), so it is broken to the same rows a centred one is.
  it('hands left- and right-aligned text the rows centred text gets', () => {
    const c = boxWith(ell, { align: 'center' });
    const want = balloonWidthsFor(c, c.style, c.style.size)(5);
    for (const align of ['left', 'right']) {
      const b = boxWith(ell, { align });
      expect(balloonWidthsFor(b, b.style, b.style.size)(5)).toEqual(want);
    }
    // Flush text is still placed at the inscribed rectangle, where its block
    // reads centred in the balloon, and centred text at the frame.
    const page = { w: 1000, h: 1000 };
    for (const align of ['left', 'right']) {
      const r = inscribedRect(ell);
      const g = fittedRect(page, ell, align);
      expect([g.x, g.y, g.w, g.h].map(round2)).toEqual([r.x, r.y, r.w, r.h].map(round2));
    }
    const f = balloonFrame(ell);
    expect(fittedRect(page, ell, 'center').w).toBe(f.w);
    expect(fittedRect(page, ell).w).toBe(f.w);
  });

  it('follows the block up and down with valign', () => {
    const top = boxWith(ell, { valign: 'top' });
    const bottom = boxWith(ell, { valign: 'bottom' });
    const t = balloonWidthsFor(top, top.style, top.style.size)(3);
    const bo = balloonWidthsFor(bottom, bottom.style, bottom.style.size)(3);
    // Top-anchored, the block hangs from the top of the box, above the
    // balloon's middle, so the first line is the pinched one; bottom-anchored it
    // stands on the bottom and it is the last. The box is centred on the
    // balloon, so reversing one gives the other.
    expect(t.map(round2)).toEqual([...bo].reverse().map(round2));
  });

  // GEO-2. The rows are the ones the block is drawn on, for the whole block.
  const tall = { kind: 'ellipse', cx: 250, cy: 250, rx: 134, ry: 174 };
  const onFrame = (style) => {
    const s = normalizeStyle({ size: 20, lineHeight: 1.5, strokes: [], ...style });
    return { ...balloonFrame(tall), style: s, fit: tall };
  };
  const linesOf = (text, b) =>
    layoutLines(text, b.style, b.style.size, contentWidth(b.w, b.style), balloonWidthsFor(b, b.style, b.style.size));

  it('breaks each paragraph to the rows it lands on, not to a block of its own', () => {
    const b = onFrame();
    const rowsFor = balloonWidthsFor(b, b.style, b.style.size);
    const text = 'HEY, WHAT ARE YOU DOING\nOVER THERE, YOU IDIOT';
    const fitsRows = (lines) => {
      const rows = rowsFor(lines.length);
      return lines.every((ln, i) => lineWidth(ln, b.style, b.style.size) <= rows[i] + 1e-6);
    };
    // Each paragraph alone is two lines and one, each sure of the room it had:
    // but its last line is drawn on the third row of three, which is narrower.
    const alone = text.split('\n').flatMap((para) => linesOf(para, b));
    expect(alone.length).toBe(3);
    expect(fitsRows(alone)).toBe(false);
    const lines = linesOf(text, b);
    expect(lines.length).toBe(4);
    expect(fitsRows(lines)).toBe(true);
  });

  // The block of a box whose height is its block is on the same rows whichever
  // way it is anchored, so it breaks the same way. It used to be measured at the
  // balloon's crown when top-aligned, a first row with a fraction of the room.
  it('breaks a top-aligned block on the rows below the box top, not at the crown', () => {
    const text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL';
    const mid = onFrame({ valign: 'middle' });
    const n = linesOf(text, mid).length;
    const lh = mid.style.size * mid.style.lineHeight;
    const h = n * lh + 2 * textInset(mid.style);
    const at = (valign) => {
      const b = onFrame({ valign });
      return { ...b, y: tall.cy - h / 2, h };
    };
    for (const valign of ['top', 'bottom']) {
      expect(linesOf(text, at(valign))).toEqual(linesOf(text, at('middle')));
    }
    // Keyed on the anchor: a drag is a new layout, a height grown about the
    // anchor is not.
    const key = (b) => balloonWidthsFor(b, b.style, 20).key;
    const m = at('middle');
    expect(key({ ...m, y: m.y + 10 })).not.toBe(key(m));
    expect(key({ ...m, y: m.y - 7.3, h: m.h + 14.6 })).toBe(key(m));
    const t = at('top');
    expect(key({ ...t, h: t.h + 30 })).toBe(key(t));
    const crown = interiorLineWidths(tall, lh, n, 'top');
    const rows = balloonWidthsFor(at('top'), at('top').style, 20)(n);
    expect(crown[0]).toBeLessThan(rows[0] / 2);
  });

  // The point of the whole exercise: the widths reach the breaker and change
  // where the lines land.
  it('changes the breaking of a real block', () => {
    const b = boxWith(ell);
    const text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL ABOUT IT OR ABOUT ANY OF US';
    const flat = layoutLines(text, b.style, b.style.size, contentWidth(b.w, b.style));
    const shaped = layoutLines(
      text,
      b.style,
      b.style.size,
      contentWidth(b.w, b.style),
      balloonWidthsFor(b, b.style, b.style.size),
    );
    expect(shaped).not.toEqual(flat);
    expect(shaped.join(' ').replace(/\s+/g, ' ')).toBe(text);
  });
});

// ---------------------------------------------------------------------------
describe('lineIndents - where a flush line starts inside a balloon', () => {
  // The box `boxWith` places above is 200 wide over a 234 interior, so the
  // middle rows are capped at its content width and the outer ones are not.
  const boxWith = (fit, style = {}) => ({
    x: 150,
    y: 200,
    w: 200,
    h: 100,
    style: normalizeStyle({ size: 20, lineHeight: 1, valign: 'middle', ...style }),
    fit,
  });
  const ell = { kind: 'ellipse', cx: 250, cy: 250, rx: 130, ry: 80 };
  const SHORT = ['A', 'A', 'A', 'A', 'A'];
  const indentsOf = (b, lines = SHORT) =>
    lineIndents(lines, b.style, b.style.size, contentWidth(b.w, b.style), balloonWidthsFor(b, b.style, b.style.size));

  it('sets a left-aligned line in by half the room its row lacks', () => {
    const b = boxWith(ell, { align: 'left' });
    const cw = contentWidth(b.w, b.style);
    const rows = balloonWidthsFor(b, b.style, 20)(5);
    const got = indentsOf(b);
    expect(got).toEqual(rows.map((r) => (cw - r) / 2));
    // In at the top and the bottom, where the curve is inside the box; flush
    // across the middle, where the box is inside the curve.
    expect(got[0]).toBeGreaterThan(5);
    expect(got[4]).toBeCloseTo(got[0], 6);
    expect(got[2]).toBe(0);
  });

  it('sets a right-aligned line in by the same amount, from the right', () => {
    const l = boxWith(ell, { align: 'left' });
    const r = boxWith(ell, { align: 'right' });
    expect(indentsOf(r)).toEqual(indentsOf(l));
  });

  it('answers null for centred text, which its row already holds', () => {
    expect(indentsOf(boxWith(ell, { align: 'center' }))).toBe(null);
  });

  it('answers null with no balloon, or a balloon whose rows all clear the box', () => {
    expect(indentsOf(boxWith(null, { align: 'left' }))).toBe(null);
    expect(indentsOf(boxWith({ kind: 'rect', x: 0, y: 0, w: 1000, h: 1000 }, { align: 'left' }))).toBe(null);
    expect(indentsOf(boxWith(ell, { align: 'left', balloon: false }))).toBe(null);
  });

  // Plain wrapping ignores the rows (`layoutLines`), so it must not be set in
  // to them either: plain mode draws as it always did.
  it('answers null in plain mode', () => {
    const b = boxWith(ell, { align: 'left', shape: 'off' });
    const rows = balloonWidthsFor(b, b.style, 20);
    expect(rows).not.toBe(null);
    expect(lineIndents(SHORT, b.style, 20, contentWidth(b.w, b.style), rows)).toBe(null);
    setTypesetEnabled(false);
    try {
      const f = boxWith(ell, { align: 'left' });
      expect(lineIndents(SHORT, f.style, 20, contentWidth(f.w, f.style), () => [1, 1, 1, 1, 1])).toBe(null);
    } finally {
      setTypesetEnabled(true);
    }
  });

  // A word wider than its row is kept whole by the breaker. Set in all the way,
  // it would run past the box; it goes in only as far as the box has room.
  it('never sets a line in past the room the box has beside it', () => {
    const b = boxWith(ell, { align: 'left' });
    const cw = contentWidth(b.w, b.style);
    const rows = balloonWidthsFor(b, b.style, 20)(5);
    // Wider than its row by more than the indent the row would give it.
    let wide = 'W';
    while (lineWidth(wide, b.style, 20) <= (cw + rows[0]) / 2) wide += 'W';
    const w = lineWidth(wide, b.style, 20);
    expect(w).toBeLessThan(cw);
    const got = indentsOf(b, [wide, 'A', 'A', 'A', 'A']);
    expect(got[0]).toBeCloseTo(cw - w, 6);
    expect(got[0] + w).toBeLessThanOrEqual(cw + 1e-9);
  });

  // `placeBlock` is what the exporter draws from and the containment check
  // measures, and the editor asks `lineIndents` with the same arguments: the
  // x each line is drawn at is the aligned edge, moved in by its indent.
  it('is the x placeBlock draws each line at, and the editor pads it by', () => {
    const text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL ABOUT IT OR ABOUT ANY OF US';
    for (const align of ['left', 'right']) {
      const b = { ...boxWith(ell, { align }), ...balloonFrame(ell), text };
      const place = placeBlock(boxCandidate(b, text));
      const editor = layoutLines(text, b.style, 20, contentWidth(b.w, b.style), balloonWidthsFor(b, b.style, 20));
      expect(place.lines).toEqual(editor);
      expect(place.indents).toEqual(indentsOf(b, editor));
      expect(place.indents.some((v) => v > 0)).toBe(true);
      const inset = textInset(b.style);
      place.lineX.forEach((x, i) =>
        expect(x).toBeCloseTo(align === 'left' ? inset + place.indents[i] : b.w - inset - place.indents[i], 9),
      );
      // Across, the ink is inside the box (the frame's height is the auto
      // height's to grow, which is not this test's business).
      const { overflow } = containBox(boxCandidate(b, text), place);
      expect(Math.max(overflow.l, overflow.r)).toBeLessThanOrEqual(0.5);
    }
    const c = { ...boxWith(ell), ...balloonFrame(ell), text };
    const mid = placeBlock(boxCandidate(c, text));
    expect(mid.indents).toBe(null);
    for (const x of mid.lineX) expect(x).toBe(c.w / 2);
  });
});

// ---------------------------------------------------------------------------
describe('the PSD’s type layer breaks where the canvas does', () => {
  // `textLayerFor` writes the app's own line breaks into the type layer as hard
  // returns, so that a re-render in Photoshop cannot re-wrap the block greedily
  // and undo the shaping. If it asked `layoutLines` without the balloon, those
  // returns would be a different set of breaks from the pixels beneath them.
  it('writes the balloon’s breaking into the editable layer', async () => {
    const { textLayerFor } = await import('./psd.js');
    const box = {
      lineN: null,
      text: 'THE WORLD IS ENDING AND NOBODY CARES AT ALL ABOUT IT OR ABOUT ANY OF US',
      x: 100,
      y: 100,
      w: 200,
      h: 160,
      style: normalizeStyle({ size: 20, lineHeight: 1, valign: 'middle', outlineWidth: 0 }),
      fit: { kind: 'ellipse', cx: 250, cy: 250, rx: 130, ry: 80 },
    };
    const p = { id: 1, w: 500, h: 500, lines: [], boxes: [box] };
    const layer = textLayerFor(p, box, null);
    const want = layoutLines(
      box.text,
      box.style,
      box.style.size,
      contentWidth(box.w, box.style),
      balloonWidthsFor(box, box.style, box.style.size),
    );
    const flat = layoutLines(box.text, box.style, box.style.size, contentWidth(box.w, box.style));
    expect(layer.text.text).toBe(want.join('\n'));
    expect(layer.text.text).not.toBe(flat.join('\n'));
    // Centred: no line is set in, so no paragraph carries an indent.
    expect(layer.text.paragraphStyleRuns).toBeUndefined();
  });

  // A flush line starts at its row's edge. Each line is a paragraph of its own
  // in the layer, so each carries its indent from the edge it is aligned to,
  // and a re-render in Photoshop sets it where the pixels beneath show it.
  it('indents each flush paragraph as the canvas sets its line in', async () => {
    const { textLayerFor } = await import('./psd.js');
    const fit = { kind: 'ellipse', cx: 250, cy: 250, rx: 130, ry: 80 };
    for (const [align, key, other] of [
      ['left', 'startIndent', 'endIndent'],
      ['right', 'endIndent', 'startIndent'],
    ]) {
      const box = {
        lineN: null,
        text: 'THE WORLD IS ENDING AND NOBODY CARES AT ALL ABOUT IT OR ABOUT ANY OF US',
        ...balloonFrame(fit),
        style: normalizeStyle({ size: 20, lineHeight: 1, valign: 'middle', align }),
        fit,
      };
      const p = { id: 1, w: 500, h: 500, lines: [], boxes: [box] };
      const layer = textLayerFor(p, box, null);
      const place = placeBlock(boxCandidate(box, box.text));
      expect(place.indents.some((v) => v > 0)).toBe(true);
      const runs = layer.text.paragraphStyleRuns;
      expect(runs.map((r) => r.style[key])).toEqual(place.indents);
      expect(runs.every((r) => !(other in r.style))).toBe(true);
      // One run a line, each the line and the return that ends it.
      expect(runs.map((r) => r.length)).toEqual(place.lines.map((ln) => ln.length + 1));
      expect(runs.reduce((a, r) => a + r.length, 0)).toBe(layer.text.text.length + 1);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the fit survives a save and a round trip', () => {
  const docWith = (fit) => [
    {
      id: 1,
      w: 500,
      h: 500,
      lines: [],
      boxes: [{ id: 'b1', lineN: null, text: 'X', x: 1, y: 2, w: 30, h: 10, style: {}, fit }],
    },
  ];
  const good = { kind: 'ellipse', cx: 250, cy: 250, rx: 130, ry: 80 };

  it('comes back off disk as it went on', () => {
    loadProjectPages(docWith(good));
    expect(page().boxes[0].fit).toEqual(good);
  });

  // A field that arrives from a future schema, a hand edit or a corrupted file
  // has to degrade to "this box has no fit" - which is a state every layout path
  // already handles, because it is what every box had before fitting existed.
  it('degrades a malformed or unknown fit to none, rather than throwing', () => {
    for (const bad of [{ kind: 'hexagon', a: 1 }, { kind: 'rect', x: 0, y: 0, w: 0, h: 5 }, 'oval', 7, undefined]) {
      loadProjectPages(docWith(bad));
      expect(page().boxes[0].fit).toBe(null);
    }
  });

  it('is written into the PSD’s embedded project and rebuilt from it', () => {
    const p = {
      id: 3,
      w: 500,
      h: 500,
      lines: [],
      boxes: [{ lineN: null, text: 'X', x: 1, y: 2, w: 3, h: 4, style: {}, fit: good }],
    };
    const out = serializePage(p);
    expect(out.boxes[0].fit).toEqual(good);
    // The round trip `psdSelfTest` pins: reconstruct (a spread of the stored
    // box) and re-serialize, and the two JSONs must be the same string.
    const rebuilt = { ...p, boxes: out.boxes.map((b) => ({ ...b, style: { ...b.style } })) };
    expect(JSON.stringify(serializePage(rebuilt))).toBe(JSON.stringify(out));
  });

  it('writes a null rather than a shape this build cannot lay out to', () => {
    const out = serializePage({
      id: 3,
      w: 8,
      h: 8,
      lines: [],
      boxes: [{ lineN: null, text: '', x: 0, y: 0, w: 1, h: 1, style: {}, fit: { kind: 'hexagon' } }],
    });
    expect(out.boxes[0].fit).toBe(null);
  });

  // A cleaned raster arriving at another resolution rescales every box on the
  // page. The balloon is page geometry too, and a fit left in the old
  // coordinate space would lay text out to a curve that has moved.
  it('is rescaled with the page when the art underneath it changes size', () => {
    loadProjectPages(docWith(good));
    setPageDims(page(), 1000, 500);
    expect(page().boxes[0].fit).toEqual({ kind: 'ellipse', cx: 500, cy: 250, rx: 260, ry: 80 });
  });

  it('normalizes a fit to plain finite numbers or nothing', () => {
    expect(normalizeFit(good)).toEqual(good);
    expect(normalizeFit({ ...good, rx: '130' })).toBe(null);
    expect(normalizeFit(null)).toBe(null);
    // A fresh object, so a caller cannot write through it into the document.
    expect(normalizeFit(good)).not.toBe(good);
  });

  // GEO-5: the third kind rides every path the other two do - disk, PSD,
  // rescale - through the same gate.
  const rows = { kind: 'rows', y0: 180, step: 2, spans: [null, [220, 280], [200, 300], [210, 290]] };

  it('takes a rows fit off disk and into the PSD as it went on', () => {
    loadProjectPages(docWith(rows));
    expect(page().boxes[0].fit).toEqual(rows);
    const out = serializePage({ id: 3, w: 500, h: 500, lines: [], boxes: [{ ...page().boxes[0] }] });
    expect(out.boxes[0].fit).toEqual(rows);
    const n = normalizeFit(rows);
    expect(n.spans).not.toBe(rows.spans);
    expect(n.spans[1]).not.toBe(rows.spans[1]);
  });

  it('rescales a rows fit with the page', () => {
    loadProjectPages(docWith(rows));
    setPageDims(page(), 1000, 250);
    expect(page().boxes[0].fit).toEqual({
      kind: 'rows',
      y0: 90,
      step: 1,
      spans: [null, [440, 560], [400, 600], [420, 580]],
    });
  });

  it('refuses a rows fit with nothing sound in it', () => {
    for (const bad of [
      { ...rows, step: 0 },
      { ...rows, y0: '180' },
      { ...rows, spans: [] },
      { ...rows, spans: [null, null] },
      { ...rows, spans: [[10, 10]] },
      { ...rows, spans: [[10, 20, 30]] },
      { ...rows, spans: [[10, NaN]] },
      { ...rows, spans: 'wide' },
      { ...rows, spans: Array.from({ length: 2000 }, () => [0, 1]) },
    ]) {
      expect(normalizeFit(bad)).toBe(null);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the two new style knobs', () => {
  it('are on by default and reachable by a bulk edit', () => {
    expect(defaultStyle().hyphenate).toBe(true);
    expect(defaultStyle().balloon).toBe(true);
    expect(BULK_PROPS).toContain('hyphenate');
    expect(BULK_PROPS).toContain('balloon');
  });

  // A style saved before either knob existed has no such key, and the default
  // has to stand - `hyphenate: undefined` handed to `balanceLines` would turn
  // the feature off rather than leave it alone.
  it('survive a style that predates them', () => {
    const s = normalizeStyle({ size: 20 });
    expect(s.hyphenate).toBe(true);
    expect(s.balloon).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('re-fitting by hand', () => {
  it('measures the balloon under where the box is NOW', () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 130, 80);
    loadProjectPages([
      {
        id: 1,
        w: 500,
        h: 500,
        lines: [],
        boxes: [{ id: 'b1', lineN: null, text: 'X', x: 220, y: 230, w: 60, h: 40, style: {}, fit: null }],
      },
    ]);
    pixels = img;
    expect(refitBalloon('b1')).toBe(true);
    const b = page().boxes[0];
    expect(L(b.fit).kind).toBe('ellipse');
    expect(L(b.fit).rx).toBeGreaterThan(120);
  });

  // A stale fit is worse than none: the text would be laid out to a curve that
  // is no longer under the box.
  it('clears a fit when the box has been dragged off its balloon', () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 130, 80);
    loadProjectPages([
      {
        id: 1,
        w: 500,
        h: 500,
        lines: [],
        boxes: [
          {
            id: 'b1',
            lineN: null,
            text: 'X',
            x: 5,
            y: 5,
            w: 60,
            h: 40,
            style: {},
            fit: { kind: 'ellipse', cx: 250, cy: 250, rx: 130, ry: 80 },
          },
        ],
      },
    ]);
    pixels = img;
    expect(refitBalloon('b1')).toBe(false);
    expect(page().boxes[0].fit).toBe(null);
  });

  it('is a no-op on a box that is not there', () => {
    loadProjectPages([{ id: 1, w: 500, h: 500, lines: [], boxes: [] }]);
    expect(refitBalloon('nope')).toBe(false);
  });

  // DET-2. The same oval and column as the placement tests above, with a line
  // long enough that its box grows past the balloon's outline. The fill used to
  // be seeded from that grown rectangle, started on the paper outside the
  // balloon, escaped - and the first refit of a box nobody had touched cleared
  // its fit and grew it again (h 319 -> 405 in the review's measurement).
  const ovalPage = () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 130, 80);
    drawGlyphColumn(img, 240, 180, 20, 140);
    return img;
  };
  const LONG = 'We have to get out of here before the whole building comes down on top of us';
  const geom = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size, fit: b.fit });

  it('leaves an untouched box exactly as placement left it, however often it is pressed', () => {
    const pages = withDetect([240, 180, 260, 320], true);
    pages[0].lines[0].en = LONG;
    loadProjectPages(pages);
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    const placed = geom(b);
    expect(L(placed.fit)?.kind).toBe('ellipse');
    expect(refitBalloon(b.id)).toBe(true);
    expect(geom(b)).toEqual(placed);
    expect(refitBalloon(b.id)).toBe(true);
    expect(geom(b)).toEqual(placed);
  });

  // The case the review measured: a box taller than its balloon crosses the
  // outline, and a fill seeded from the box's own edges starts on the paper
  // outside and escapes.
  it('keeps the balloon of a box that reaches past its outline', () => {
    loadProjectPages(withDetect([240, 180, 260, 320], true));
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    const fit = b.fit;
    b.y = 60;
    b.h = 380;
    expect(refitBalloon(b.id)).toBe(true);
    expect(b.fit).toEqual(fit);
  });

  // The other half: a box placed while its page was not decoded took the
  // detector's rectangle. Refitting it once the pixels are there has to give
  // the box a fresh fitted placement would have given, not the fallback's
  // x and w with a fit bolted on.
  it('turns a fallback box into the box a fitted placement makes', () => {
    loadProjectPages(withDetect([240, 180, 260, 320], true));
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const want = geom(page().boxes[0]);

    loadProjectPages(withDetect([240, 180, 260, 320], true));
    pixels = null;
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    expect(b.fit).toBe(null);

    pixels = ovalPage();
    expect(refitBalloon(b.id)).toBe(true);
    expect(geom(b)).toEqual(want);
  });

  // UX-2: the button is an edit like any other, and the ladder can move the
  // rectangle and the size as well as the fit, none of which an undo can
  // re-derive. The line is long so that the ladder really does change the
  // size: with no text it never moves `style.size`, and the size half of the
  // claim would pass without being tested.
  it('is one undo step: fit, rectangle and size', () => {
    hist.initHistory();
    hist.resetHistory();
    const pages = withDetect([240, 180, 260, 320], true);
    pages[0].lines[0].en = LONG;
    loadProjectPages(pages);
    pixels = null;
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    const fallback = geom(b);
    pixels = ovalPage();
    const placed = hist.peekStack().undo.length;
    refitBalloon(b.id);
    const fitted = geom(b);
    expect(L(fitted.fit)?.kind).toBe('ellipse');
    expect(fitted.size).not.toBe(fallback.size);
    expect(hist.peekStack().undo.length).toBe(placed + 1);
    hist.undo();
    expect(geom(b)).toEqual(fallback);
    expect(b.style.size).toBe(fallback.size);
    hist.redo();
    expect(geom(b)).toEqual(fitted);
    expect(b.style.size).toBe(fitted.size);
  });

  // FIT-4: a re-typeset, not a height fit. Whatever edits left the box at, the
  // press lays it out as placement would in the balloon it finds - and a second
  // press finds the same balloon and changes nothing (DET-2).
  it('typesets the box again: size, width and place in the balloon, as placement would, once', () => {
    hist.initHistory();
    hist.resetHistory();
    const pages = withDetect([240, 180, 260, 320], true);
    pages[0].lines[0].en = LONG;
    loadProjectPages(pages);
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    const placed = { ...geom(b), auto: { ...b.auto } };
    b.x += 25;
    b.w -= 30;
    b.style.size = 14;
    const n = hist.peekStack().undo.length;
    expect(refitBalloon(b.id)).toBe(true);
    expect({ ...geom(b), auto: { ...b.auto } }).toEqual(placed);
    expect(hist.peekStack().undo.length).toBe(n + 1);
    expect(refitBalloon(b.id)).toBe(true);
    expect({ ...geom(b), auto: { ...b.auto } }).toEqual(placed);
    expect(hist.peekStack().undo.length).toBe(n + 1);
    hist.undo();
    expect([b.x, b.w, b.style.size]).toEqual([placed.x + 25, placed.w - 30, 14]);
  });

  it('keeps what the box has locked', () => {
    const pages = withDetect([240, 180, 260, 320], true);
    pages[0].lines[0].en = LONG;
    loadProjectPages(pages);
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    resizeBox(page().id, b.id, { x: b.x + 20, w: b.w - 40 });
    const w = b.w;
    refitBalloon(b.id);
    expect(b.w).toBe(w);
    expect(b.auto.locks.width).toBe(true);
  });

  // A box typed onto the page, or saved before the solver, has no record. The
  // press is the user asking for the solver, so it gets one - and the undo
  // takes it away with the rest.
  it('gives an auto box with no solver record one, and the undo takes it back', () => {
    hist.initHistory();
    hist.resetHistory();
    loadProjectPages([
      {
        id: 1,
        w: 500,
        h: 500,
        lines: [],
        boxes: [{ id: 'b1', lineN: null, text: LONG, x: 130, y: 220, w: 100, h: 60, style: { size: 30 }, fit: null }],
      },
    ]);
    pixels = ovalPage();
    const b = page().boxes[0];
    const before = geom(b);
    expect(b.auto).toBeUndefined();
    refitBalloon('b1');
    expect(b.auto).toMatchObject({ on: true, refSize: 30 });
    expect(['ok', 'shrunk', 'overflow']).toContain(b.auto.status);
    expect(b.y).toBeGreaterThanOrEqual(L(b.fit).cy - L(b.fit).ry);
    hist.undo();
    expect(b.auto).toBeUndefined();
    expect(geom(b)).toEqual(before);
  });

  it('records nothing when the press changed nothing', () => {
    hist.initHistory();
    hist.resetHistory();
    loadProjectPages(withDetect([240, 180, 260, 320], true));
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const placed = hist.peekStack().undo.length;
    refitBalloon(page().boxes[0].id);
    expect(hist.peekStack().undo.length).toBe(placed);
  });
});

// ===========================================================================
// Placement from a click alone
// ===========================================================================
// Everything above needs the detector to have run. This is the path that does
// not: a translation typed into the queue, a page nobody analysed, and a click
// on the bubble the user wants it in. It is the common gesture, and until the
// click-seeded fill existed it was the one gesture that got no help at all - a
// fixed 220px width, a height grown to the text, and therefore a column.
const noDetect = (en = '', w = 500, h = 500) => [
  { id: 1, w, h, lines: [{ n: 1, type: 'dialogue', jp: 'あ', en }], boxes: [] },
];

// Screentone: the flat-looking art the probe has to refuse.
function drawTone(img, x, y, w, h, pitch = 4) {
  fillRect(img, x, y, w, h, PAPER);
  for (let yy = y; yy < y + h; yy += pitch)
    for (let xx = x; xx < x + w; xx += pitch) {
      put(img, xx, yy, INK);
      put(img, xx + 1, yy, INK);
      put(img, xx, yy + 1, INK);
      put(img, xx + 1, yy + 1, INK);
    }
}

describe('a click on a balloon is enough, with no detection at all', () => {
  const ovalPage = () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 130, 80);
    return img;
  };

  it('fits the balloon under the pointer and stores the shape', () => {
    loadProjectPages(noDetect('HELLO THERE'));
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const b = page().boxes[0];

    expect(b.fit).not.toBe(null);
    expect(L(b.fit).kind).toBe('ellipse');
    expect(Object.keys(L(b.fit)).sort()).toEqual(['cx', 'cy', 'kind', 'rx', 'ry']);
    expect(L(b.fit).cx).toBeCloseTo(250, -1);
    expect(L(b.fit).cy).toBeCloseTo(250, -1);
    expect(L(b.fit).rx).toBeCloseTo(130, -1);
    expect(L(b.fit).ry).toBeCloseTo(80, -1);
  });

  // The box is centred on the shape's frame and no wider than it: the text is
  // set as the roundest block the balloon holds, not stretched across it.
  it('sizes the box inside that shape s frame, centred on it', () => {
    loadProjectPages(noDetect('HELLO THERE'));
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    const r = balloonFrame(b.fit);
    expect(b.w).toBeLessThanOrEqual(r.w);
    expect(b.x + b.w / 2).toBeCloseTo(r.x + r.w / 2, 6);
  });

  it('finds the same balloon from anywhere inside it', () => {
    loadProjectPages(noDetect());
    pixels = ovalPage();
    placeActiveAt(250, 250);
    const centre = page().boxes[0].fit;

    loadProjectPages(noDetect());
    pixels = ovalPage();
    placeActiveAt(180, 270); // off-centre, still inside
    expect(round2(L(page().boxes[0].fit).rx)).toBe(round2(L(centre).rx));
  });

  it('fits a narration panel as a rect, which the Inspector shows as one', () => {
    const img = pageImage(400, 300);
    drawBox(img, 60, 60, 260, 120);
    loadProjectPages(noDetect('', 400, 300));
    pixels = img;
    placeActiveAt(190, 120);
    const b = page().boxes[0];
    expect(L(b.fit).kind).toBe('rect');
    expect(L(b.fit).w).toBeCloseTo(260, -1);
  });

  // The detector measured where THIS line's Japanese sat. A click is where the
  // pointer happened to be. When the two disagree the measurement wins, which is
  // why the click is only consulted after the block has been tried.
  it('lets a detected block win over the click when both are available', () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 120, 120, 70, 45); // the detected bubble
    drawGlyphColumn(img, 110, 90, 20, 60);
    drawEllipse(img, 360, 360, 120, 70); // a second, larger one
    loadProjectPages(withDetect([110, 90, 130, 150], true));
    pixels = img;
    placeActiveAt(360, 360); // pointing at the OTHER balloon
    const b = page().boxes[0];
    expect(L(b.fit).cx).toBeCloseTo(120, -1);
    expect(L(b.fit).cy).toBeCloseTo(120, -1);
  });

  it('refuses a click on art, and never spends a fill on it', () => {
    const img = pageImage(500, 500);
    drawTone(img, 0, 0, 500, 500);
    loadProjectPages(noDetect('HELLO'));
    pixels = img;
    placeActiveAt(250, 250);
    expect(page().boxes[0].fit).toBe(null);
  });

  it('refuses a click on bare paper, where the fill would get out', () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 60, 40);
    loadProjectPages(noDetect('HELLO'));
    pixels = img;
    placeActiveAt(40, 40);
    expect(page().boxes[0].fit).toBe(null);
  });

  it('refuses a burst: solid inside, and not a shape', () => {
    const img = pageImage(400, 400);
    drawBurst(img, 200, 200, 120);
    loadProjectPages(noDetect('HELLO', 400, 400));
    pixels = img;
    placeActiveAt(200, 200);
    expect(page().boxes[0].fit).toBe(null);
  });

  it('places on the old constants when there are no pixels to look at', () => {
    loadProjectPages(noDetect());
    pixels = null;
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    expect(b.fit).toBe(null);
    expect([b.w, b.h]).toEqual([220, 92]);
  });
});

// ---------------------------------------------------------------------------
// The other half of the same bug. A click that finds no balloon still has to
// produce a rectangle, and the rectangle it used to produce was 220 wide
// whatever went in it - so auto-height, which is grow-only and touches the width
// never, turned a paragraph into a ribbon.
describe('with no balloon to fit, the box is sized from its own text', () => {
  const LONG =
    'I NEVER THOUGHT IT WOULD COME TO THIS, BUT HERE WE ARE, STANDING AT THE EDGE ' +
    'OF EVERYTHING WE EVER BUILT TOGETHER, AND I STILL CANNOT FIND THE WORDS.';

  const placeOnArt = (en) => {
    const img = pageImage(900, 900);
    drawTone(img, 0, 0, 900, 900);
    loadProjectPages(noDetect(en, 900, 900));
    pixels = img;
    placeActiveAt(450, 450);
    return page().boxes[0];
  };

  it('comes out wider than tall instead of as a column', () => {
    const b = placeOnArt(LONG);
    expect(b.fit).toBe(null);
    expect(b.w).toBeGreaterThan(b.h);
  });

  it('is nothing like the fixed width it used to get', () => {
    const b = placeOnArt(LONG);
    expect(b.w).toBeGreaterThan(220);
  });

  it('widens with the text rather than only growing taller', () => {
    const short = placeOnArt('WHAT?');
    const long = placeOnArt(LONG);
    expect(long.w).toBeGreaterThan(short.w);
  });

  it('keeps the old constants for a row with nothing in it yet', () => {
    const b = placeOnArt('');
    expect([b.w, b.h]).toEqual([220, 92]);
  });

  it('still lands the box under the pointer', () => {
    const b = placeOnArt(LONG);
    expect(b.x + b.w / 2).toBeCloseTo(450, 0);
    expect(b.y + b.h / 2).toBeCloseTo(450, 0);
  });
});

// ---------------------------------------------------------------------------
// `vertical` is the detector's own claim and is believed in both directions.
// The fallback is for the detections that do not carry one - an older chapter,
// a hand-written chapter.json, a sidecar that never reported the field - and it
// is a pure aspect test, so the only thing worth pinning is where it changes
// its mind and that it changes it the right way round.
describe('a detection with no `vertical` on it falls back to the block’s aspect', () => {
  const placeBlock = (block) => {
    loadProjectPages(withDetect(block, undefined));
    pixels = null;
    placeActiveAt(250, 250);
    return page().boxes[0];
  };

  it('reads a column markedly taller than it is wide as vertical', () => {
    // 60x300, the same block the `vertical: true` case uses, and it comes out
    // the same way: transposed to 300x60, inset 5 a side, centred on the click.
    expect(placeBlock([220, 100, 280, 400])).toMatchObject({ x: 105, y: 225, w: 290, h: 50 });
  });

  it('leaves a block that is merely taller than wide alone', () => {
    // 60x90 is 1.5, under the threshold: horizontal Latin and horizontal
    // Japanese both come out in blocks like this and neither wants transposing.
    expect(placeBlock([220, 205, 280, 295])).toMatchObject({ x: 225, y: 210, w: 50, h: 80 });
  });

  it('changes its mind at 1.6 and not before', () => {
    // 60x96 is exactly 1.6 - not `> 1.6`, so not vertical - and 60x97 is the
    // first block on the other side of the line.
    const flat = placeBlock([220, 202, 280, 298]);
    expect(flat.w).toBeLessThan(flat.h);
    const tall = placeBlock([220, 201, 280, 298]);
    expect(tall.w).toBeGreaterThan(tall.h);
  });

  it('is not consulted at all when the detector did say', () => {
    // The same 60x90 block the aspect test leaves alone, with the detector
    // claiming it is a column. The claim wins: a detector that measured the
    // glyphs knows something an aspect ratio cannot.
    loadProjectPages(withDetect([220, 205, 280, 295], true));
    pixels = null;
    placeActiveAt(250, 250);
    expect(page().boxes[0]).toMatchObject({ w: 80, h: 50 });
  });
});

// ---------------------------------------------------------------------------
// The pixel cache, through placement, with the real module doing the
// bookkeeping. Everywhere else in this file `pagePixelsFor` is stubbed, which
// is right for testing the fit and says nothing about the one moment the cache
// has to get right on its own: a clean lands, the page's raster becomes a new
// object URL, and the entry filed under the old one is pixels of art nobody is
// looking at any more.
const realPixels = await vi.importActual('./page-pixels.js');

describe('a page whose cleaned raster is replaced is re-decoded, not re-used', () => {
  const realDocument = globalThis.document;

  // The smallest decoder `rememberPagePixels` will accept: an element with a 2D
  // context that hands back the `ImageData` this test built by hand. What is
  // under test is which pixels placement ends up with, not the decode.
  const decoderFor = (image) => {
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {}, getImageData: () => image }),
      }),
    };
    return { naturalWidth: image.width, naturalHeight: image.height };
  };

  const oval = () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 130, 80);
    drawGlyphColumn(img, 240, 180, 20, 140);
    return img;
  };

  // The same page as `withDetect` builds, with three queue rows so three clicks
  // can land on one page object - and with a raster URL on it, because that is
  // the half of the cache key the clean changes.
  const withRaster = (raw) => [
    {
      id: 1,
      w: 500,
      h: 500,
      raw,
      cleaned: null,
      lines: [1, 2, 3].map((n) => ({ n, type: 'dialogue', jp: 'あ', en: '' })),
      boxes: [],
      detect: {
        panels: [],
        boxes: [1, 2, 3].map((n) => ({ n, box: [240, 180, 260, 320], vertical: true })),
      },
    },
  ];

  afterEach(() => {
    globalThis.document = realDocument;
    realPixels.forgetPagePixels();
  });

  it('misses on the stale entry and fits again once the new raster is decoded', () => {
    lookup = realPixels.pagePixelsFor;
    realPixels.forgetPagePixels();
    const image = oval();
    loadProjectPages(withRaster('blob:raw-1'));
    const p = page();

    // The canvas decodes the page it is drawing and files the pixels under that
    // URL. The click that follows finds them and the box is the balloon's.
    realPixels.rememberPagePixels(p.id, realPixels.pageRasterSrc(p), decoderFor(image));
    placeActiveAt(250, 250);
    const fitted = page().boxes[0];
    expect(fitted.fit).not.toBe(null);

    // The clean lands. `p.cleaned` is a URL nothing has decoded, so the entry
    // filed under the raw one no longer describes the picture on screen - and
    // the lookup has to miss rather than hand back the art it replaced.
    p.cleaned = 'blob:clean-1';
    expect(realPixels.pagePixelsFor(p)).toBe(null);
    placeActiveAt(250, 250);
    const stale = page().boxes[1];
    expect(stale.fit).toBe(null);
    expect([stale.w, stale.h]).not.toEqual([fitted.w, fitted.h]);

    // ...and the canvas decodes the cleaned raster, which is the whole of the
    // invalidation story: no event to subscribe to, nothing to remember to call.
    realPixels.rememberPagePixels(p.id, realPixels.pageRasterSrc(p), decoderFor(image));
    placeActiveAt(250, 250);
    const refitted = page().boxes[2];
    expect(refitted.fit).toEqual(fitted.fit);
    expect([refitted.w, refitted.h]).toEqual([fitted.w, fitted.h]);
  });
});

// ---------------------------------------------------------------------------
// FIT-1: a placed box's font size is chosen for the balloon it lands in, from
// the size the user chose for this kind of text down to the largest that fits -
// and what is remembered for the next box is the size the user chose, never
// the size a balloon made it shrink to.
describe('placement chooses the size (FIT-1)', () => {
  const TEXT = 'WE CAN STILL CATCH THE LAST TRAIN.';
  const ovalPage = () => {
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 130, 80);
    return img;
  };
  const placeAt = (size, en = TEXT) => {
    loadProjectPages(noDetect(en));
    tags.sizes[''] = size;
    pixels = ovalPage();
    placeActiveAt(250, 250);
    // The placement's size came from the memory; what the cases below check is
    // what writes it next.
    tags.sizes = {};
    return page().boxes[0];
  };
  const inside = (b) => {
    expect(containBox(boxCandidate(b, TEXT)).fits).toBe(true);
    expect(b.y).toBeGreaterThanOrEqual(L(b.fit).cy - L(b.fit).ry);
    expect(b.y + b.h).toBeLessThanOrEqual(L(b.fit).cy + L(b.fit).ry);
  };

  beforeEach(() => {
    tags.sizes = {};
  });

  it('keeps the size the user chose when the balloon holds it', () => {
    const b = placeAt(26);
    expect(b.style.size).toBe(26);
    expect(b.auto).toMatchObject({ on: true, refSize: 26, status: 'ok', reason: null });
    inside(b);
  });

  it('shrinks a size the balloon cannot hold instead of growing the box out of it', () => {
    const a = placeAt(26);
    const b = placeAt(32);
    expect(b.style.size).toBeLessThan(32);
    expect(Math.abs(b.style.size - a.style.size)).toBeLessThanOrEqual(3);
    // On the half-pixel grid, so the editor and both exporters get one number.
    expect(b.style.size * 2).toBe(Math.round(b.style.size * 2));
    expect(b.auto).toMatchObject({ refSize: 32, status: 'shrunk' });
    expect(b.review).toBeUndefined();
    inside(b);
  });

  // A quarter below the reference is the floor every fit shares (`minSizeFor`):
  // past it the text reads as another voice, and needs a decision, not a guess.
  it('flags a size it cannot fit within a quarter of, rather than shrinking past it', () => {
    const b = placeAt(40);
    expect(b.style.size).toBe(30);
    expect(b.auto).toMatchObject({ refSize: 40, status: 'overflow', reason: REVIEW_REASONS.minSize });
  });

  // The solver's overflow with every glyph inside the box: the lines run past
  // the balloon's curve, which the containment check - measured against the box -
  // cannot see. It used to be recorded in `box.auto` and nowhere the user looks.
  describe('a solver overflow inside its own box', () => {
    const LONGER = 'I TOLD YOU WE SHOULD HAVE LEFT BEFORE THE RAIN';
    // The repro: 240 by 180, and a reference size of 40 the text cannot keep.
    const overflowed = () => {
      loadProjectPages(noDetect(LONGER));
      tags.sizes[''] = 40;
      const img = pageImage(500, 500);
      drawEllipse(img, 250, 250, 120, 90);
      pixels = img;
      placeActiveAt(250, 250);
      const b = page().boxes[0];
      expect(b.style.size).toBe(30);
      expect(b.auto).toMatchObject({ status: 'overflow', reason: REVIEW_REASONS.minSize });
      expect(containBox(boxCandidate(b, LONGER)).fits).toBe(true);
      return b;
    };

    const flag = (b) => reviewOf(b, page());

    it('is flagged with the solver’s reason, and listed', () => {
      const b = overflowed();
      expect(flag(b)).toEqual({ kind: 'overflow', overflow: { l: 0, t: 0, r: 0, b: 0 }, reason: REVIEW_REASONS.minSize });
      expect(flaggedBoxes()).toEqual([{ pageId: page().id, boxId: b.id, review: flag(b) }]);
      // Worked out from the solver's record, not written: nothing a check does
      // to `box.review` can drop it.
      expect(b.review).toBeUndefined();
    });

    it('keeps the flag through a re-check, an undo and redo, and a save and load', () => {
      hist.initHistory();
      hist.resetHistory();
      const b = overflowed();
      reviewBox(b, page());
      expect(flag(b)?.reason).toBe(REVIEW_REASONS.minSize);
      hist.undo();
      expect(page().boxes).toHaveLength(0);
      hist.redo();
      expect(flag(page().boxes[0])?.reason).toBe(REVIEW_REASONS.minSize);
      loadProjectPages(JSON.parse(JSON.stringify(app.pages)));
      expect(flag(page().boxes[0])?.reason).toBe(REVIEW_REASONS.minSize);
      expect(flaggedBoxes()).toHaveLength(1);
    });

    // The status is only ever written by a solve; every other edit changes the
    // box it was solved for, and the flag goes with it.
    it('clears when the text is shortened', () => {
      const b = overflowed();
      setBoxText(b, 'NO.', page());
      expect(flag(b)).toBeNull();
      loadProjectPages(JSON.parse(JSON.stringify(app.pages)));
      expect(flaggedBoxes()).toEqual([]);
    });

    // A width drag re-solves the box in its new width (FIT-2), and the text
    // still does not fit its balloon; a move carries the balloon with the box,
    // so the solve and its flag go with it.
    it('is re-solved by a width drag, and kept through a move', () => {
      const a = overflowed();
      resizeBox(page().id, a.id, { w: a.w - 10 });
      expect(a.auto.locks.width).toBe(true);
      expect(flag(a)?.reason).toBe(REVIEW_REASONS.minSize);
      const b = overflowed();
      selectBox(b.id);
      nudgeBox(b.id, 5, 12);
      expect(flag(b)?.reason).toBe(REVIEW_REASONS.minSize);
      nudgeBox(b.id, -5, -12);
      expect(flag(b)?.reason).toBe(REVIEW_REASONS.minSize);
    });

    // A standing solver flag means the ink is inside the box, which leaves the
    // ladder nothing to do: Fit now cannot help, and the overflow is still true.
    it('stays through a Fit now that cannot help', () => {
      hist.initHistory();
      hist.resetHistory();
      const b = overflowed();
      expect(fitBoxNow(b.id, page())).toBe(false);
      expect(hist.peekStack().undo).toHaveLength(1);
      expect(flag(b)?.reason).toBe(REVIEW_REASONS.minSize);
    });

    // A Fit now that does refit: the ladder grows the box back to the lines it
    // holds, which is the rectangle the solve laid out - so the ink flag goes and
    // the solver's, true again, is what is left. One undo puts back the box and
    // its flag as they were.
    it('refits a box dragged shorter, back to the solve and its flag, in one undo step', () => {
      hist.initHistory();
      hist.resetHistory();
      const b = overflowed();
      const solved = { flag: flag(b), g: [b.x, b.y, b.w, b.h, b.style.size] };
      resizeBox(page().id, b.id, { y: b.y + 20, h: b.h - 40 });
      const shrunk = flag(b);
      expect(shrunk.overflow.t + shrunk.overflow.b).toBeGreaterThan(0);
      const entries = hist.peekStack().undo.length;
      expect(fitBoxNow(b.id, page())).toBe(true);
      expect(hist.peekStack().undo).toHaveLength(entries + 1);
      expect(b.review).toBeUndefined();
      expect([b.x, b.y, b.w, b.h, b.style.size]).toEqual(solved.g);
      expect(flag(b)).toEqual(solved.flag);
      hist.undo();
      expect(flag(b)).toEqual(shrunk);
    });

    // The switch re-solves the box (ARC-1): its lines are set flat, and still
    // have to fit the rows of the balloon they sit in, which they do not. So the
    // flag stands, from the new solve, and the undo puts the old one back.
    it('stays when balloon layout is turned off, and the undo puts back the solve it came from', () => {
      hist.initHistory();
      hist.resetHistory();
      const b = overflowed();
      const solved = { auto: { ...b.auto }, g: [b.x, b.y, b.w, b.h, b.style.size] };
      toggleBalloonFit(b.id, page());
      expect(b.style.balloon).toBe(false);
      expect(flag(b)?.reason).toBe(REVIEW_REASONS.minSize);
      hist.undo();
      expect(b.style.balloon).toBe(true);
      expect([b.x, b.y, b.w, b.h, b.style.size]).toEqual(solved.g);
      expect(b.auto).toEqual(solved.auto);
      expect(flag(b)?.reason).toBe(REVIEW_REASONS.minSize);
    });

    it('clears when the box turns manual', () => {
      const b = overflowed();
      b.style.autoHeight = false;
      expect(flag(b)).toBeNull();
    });
  });

  // FIT-2: after placement an auto box is re-solved by every edit, inside its
  // balloon. It used to be grown and never given anything back, capped only by
  // the page - or by the whole strip in a longstrip chapter.
  describe('an edit re-solves the box', () => {
    const geomOf = (b) => [b.x, b.y, b.w, b.h, b.style.size];

    it('gives the size and the height back when the text gets shorter, and lands where placement did', () => {
      const b = placeAt(32);
      const placed = geomOf(b);
      expect(b.auto.status).toBe('shrunk');
      setBoxText(b, 'NO.', page());
      expect(b.style.size).toBe(32);
      expect(b.h).toBeLessThan(placed[3]);
      expect(b.auto.status).toBe('ok');
      setBoxText(b, TEXT, page());
      expect(geomOf(b)).toEqual(placed);
      expect(b.auto.status).toBe('shrunk');
    });

    it('is idempotent: a second fit of the same box changes nothing', () => {
      const b = placeAt(32);
      setBoxText(b, TEXT + ' TONIGHT', page());
      const once = geomOf(b);
      expect(autoFitBox(b, page())).toBe(false);
      expect(geomOf(b)).toEqual(once);
    });

    it('stays inside its balloon when the text outgrows it, and is flagged', () => {
      const b = placeAt(26);
      setBoxText(b, `${TEXT} ${TEXT} ${TEXT} ${TEXT}`, page());
      expect(b.y).toBeGreaterThanOrEqual(top(b.fit));
      expect(b.y + b.h).toBeLessThanOrEqual(bottom(b.fit));
      expect(b.auto.status).toBe('overflow');
      expect(reviewOf(b, page())).not.toBeNull();
    });

    it('keeps its place on the page: an edit re-sets the text where the box was moved to', () => {
      const b = placeAt(26);
      selectBox(b.id);
      nudgeBox(b.id, 30, 12);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      setBoxText(b, 'WE CAN STILL CATCH IT.', page());
      expect(b.x + b.w / 2).toBeCloseTo(cx, 6);
      expect(b.y + b.h / 2).toBeCloseTo(cy, 6);
    });

    it('is never grown past its balloon by the grow-only net, even in a longstrip', () => {
      app.projectLayout = 'longstrip';
      try {
        const b = placeAt(26);
        const floor = bottom(b.fit);
        autoFitBoxTo(b, 20, page());
        expect(b.y + b.h).toBeLessThanOrEqual(floor);
        // The same box saved before the solver existed is grown as it always
        // was, past the balloon and bounded by the page.
        const legacy = placeAt(26);
        delete legacy.auto;
        autoFitBoxTo(legacy, 20, page());
        expect(legacy.y + legacy.h).toBeGreaterThan(floor);
      } finally {
        app.projectLayout = 'pages';
      }
    });

    // What the queue's translation field does (Queue.svelte): every keystroke
    // through `setLineText`, one `line` entry for the burst.
    it('a queue line edit is one undo step that puts back the text and the box', () => {
      hist.initHistory();
      hist.resetHistory();
      const b = placeAt(32);
      const placed = [...geomOf(b), { ...b.auto }];
      const ln = page().lines[0];
      const n = hist.peekStack().undo.length;
      for (const v of ['N', 'NO', 'NO.']) setLineText(page(), ln.n, v);
      const edited = [...geomOf(b), { ...b.auto }];
      expect(b.style.size).toBe(32);
      expect(edited).not.toEqual(placed);
      settleEdits();
      expect(hist.peekStack().undo.length).toBe(n + 1);
      hist.undo();
      expect(ln.en).toBe(TEXT);
      expect([...geomOf(b), { ...b.auto }]).toEqual(placed);
      hist.redo();
      expect(ln.en).toBe('NO.');
      expect([...geomOf(b), { ...b.auto }]).toEqual(edited);
    });

    // With no balloon, a width set by hand is the box's, and a wider box gives
    // its height back.
    it('gives the height back when an edge drag makes the box wider, and keeps the width through later edits', () => {
      loadProjectPages(noDetect(`${TEXT} ${TEXT}`));
      tags.sizes[''] = 26;
      placeActiveAt(250, 250);
      const b = page().boxes[0];
      expect(b.fit).toBe(null);
      const h0 = b.h;
      resizeBox(page().id, b.id, { x: b.x + 40, w: b.w - 80 });
      expect(b.auto.locks.width).toBe(true);
      const narrow = { w: b.w, h: b.h };
      expect(narrow.h).toBeGreaterThan(h0);
      resizeBox(page().id, b.id, { x: b.x - 40, w: b.w + 80 });
      expect(b.h).toBe(h0);
      setBoxText(b, `${TEXT} ${TEXT} AGAIN`, page());
      expect(b.w).toBe(narrow.w + 80);
    });
  });

  // GEO-2: the rows a fitted block is broken to hang from where the box draws
  // it, so a move measured against the balloon where it stands put every line on
  // another row - 4px up or down re-broke this text. A user's move carries the
  // fit with the box instead (`moveBoxTo`): the same lines, the same solve,
  // somewhere else.
  describe('a move carries the balloon with the box', () => {
    const editorLines = (b) =>
      layoutLines(boxText(b, page()), b.style, b.style.size, contentWidth(b.w, b.style), balloonWidthsFor(b, b.style, b.style.size));
    const exportLines = (b) => placeBlock(boxCandidate(b, boxText(b, page()))).lines;

    it('keeps its lines when nudged up or down inside its balloon, in the editor, the export and the PSD', async () => {
      const { textLayerFor } = await import('./psd.js');
      const b = placeAt(26);
      const lines = editorLines(b);
      const fit = { ...b.fit };
      // Measured against the balloon where it stands, the moved box would break
      // elsewhere: this is the case the move has to hold.
      expect(editorLines({ ...b, y: b.y + 8 })).not.toEqual(lines);
      selectBox(b.id);
      for (const [dy, total] of [[8, 8], [-20, -12]]) {
        nudgeBox(b.id, 0, dy);
        expect(b.fit).toEqual(translateFit(fit, 0, total));
        expect(editorLines(b)).toEqual(lines);
        expect(exportLines(b)).toEqual(lines);
        expect(textLayerFor(page(), b, null).text.text).toBe(lines.join('\n'));
      }
      settleEdits();
    });

    it('moves the fit from where a drag started, by the whole distance', () => {
      const b = placeAt(26);
      const lines = editorLines(b);
      const from = moveGeom(b);
      for (const dy of [3.25, 17.5, 40]) moveBoxTo(b, from.x + 5, from.y + dy, page(), from);
      expect(b.fit).toEqual(translateFit(from.fit, 5, 40));
      expect(editorLines(b)).toEqual(lines);
    });

    // The next edit re-solves the box where it stands (FIT-2), against the
    // balloon it carried: nothing is shrunk for rows it was only moved across.
    it('is re-solved by the next edit to what it was, where it now stands', () => {
      const b = placeAt(26);
      const lines = editorLines(b);
      const g = [b.w, b.h, b.style.size];
      selectBox(b.id);
      nudgeBox(b.id, 0, -12);
      settleEdits();
      const at = [b.x, b.y];
      autoFitBox(b, page());
      expect([b.w, b.h, b.style.size]).toEqual(g);
      expect([b.x, b.y]).toEqual(at);
      expect(editorLines(b)).toEqual(lines);
      expect(b.auto.status).toBe('ok');
    });

    it('is one undo step that puts back the box and its fit', () => {
      hist.initHistory();
      hist.resetHistory();
      const b = placeAt(26);
      const before = { x: b.x, y: b.y, fit: { ...b.fit } };
      const n = hist.peekStack().undo.length;
      selectBox(b.id);
      nudgeBox(b.id, 0, 10);
      nudgeBox(b.id, 3, 0);
      settleEdits();
      const after = { x: b.x, y: b.y, fit: { ...b.fit } };
      expect(hist.peekStack().undo.length).toBe(n + 1);
      hist.undo();
      expect({ x: b.x, y: b.y, fit: { ...b.fit } }).toEqual(before);
      hist.redo();
      expect({ x: b.x, y: b.y, fit: { ...b.fit } }).toEqual(after);
    });

    // The Inspector's X and Y fields (`commitGeom`): a resize to a new place and
    // nothing else is a move, recorded with the fit and the record both ways.
    it('keeps its lines and its solve when a new X or Y is typed, and one undo puts both back', () => {
      hist.initHistory();
      hist.resetHistory();
      const b = placeAt(26);
      const lines = editorLines(b);
      selectBox(b.id);
      const before = boxSnap(b);
      resizeBox(page().id, b.id, { y: b.y - 10 });
      resizeBox(page().id, b.id, { x: b.x + 7 });
      boxEdited(b, page());
      expect(b.fit).toEqual(translateFit(before.fit, 7, -10));
      expect(editorLines(b)).toEqual(lines);
      expect(exportLines(b)).toEqual(lines);
      expect([b.w, b.h, b.style.size]).toEqual([before.w, before.h, before.style.size]);
      expect(b.auto.stamp).not.toBe(before.auto.stamp);
      const recs = boxEditRecords({ pageId: page().id, boxId: b.id }, before, boxSnap(b), true);
      expect(recs.map((e) => e.t)).toEqual(['resize']);
      for (const e of recs) hist.record(e);
      hist.undo();
      expect({ x: b.x, y: b.y, fit: { ...b.fit } }).toEqual({ x: before.x, y: before.y, fit: before.fit });
      expect(b.auto).toEqual(before.auto);
    });

    // A copy sits at an offset, and breaks where the original does.
    it('gives a duplicate the original’s lines at its offset', () => {
      const b = placeAt(26);
      const id = duplicateBox(b.id);
      const copy = page().boxes.find((x) => x.id === id);
      expect(copy.y).not.toBe(b.y);
      expect(L(copy.fit).cy - L(b.fit).cy).toBeCloseTo(copy.y - b.y, 6);
      expect(editorLines(copy)).toEqual(editorLines(b));
    });
  });

  it('remembers the size the user chose, not the size the balloon allowed', () => {
    const b = placeAt(32);
    selectBox(b.id);
    expect(tags.sizes['']).toBeUndefined();
    page().lines.push({ n: 2, type: 'dialogue', jp: 'い', en: TEXT });
    page().activeLineN = 2;
    placeActiveAt(250, 250);
    expect(page().boxes[1].auto.refSize).toBe(32);
  });

  it('takes a size typed on the placed box as its new reference, whatever the fit then does', () => {
    const b = placeAt(26);
    selectBox(b.id);
    // What the Inspector's size field does: write the size, then fit.
    b.style.size = 38;
    autoFitBox(b, page());
    expect(b.auto.refSize).toBe(38);
    expect(tags.sizes['']).toBe(38);
    expect(b.style.size).toBeLessThanOrEqual(38);
  });

  // ARC-1: an explicit size edit is the box's reference AND is locked, so the
  // solver never shrinks it out from under the edit; what does not fit at that
  // size is flagged. The Inspector records its edit with the whole geometry and
  // the solver record (its `fitOf`), so one undo gives the box its freedom back.
  it('keeps a size typed on the box, flags what it cannot hold, and the undo unlocks it', () => {
    hist.initHistory();
    hist.resetHistory();
    const b = placeAt(26);
    selectBox(b.id);
    const before = boxSnap(b);
    // The Inspector's size field: write the size, then tell the store.
    b.style.size = 44;
    boxEdited(b, page());
    expect(b.style.size).toBe(44);
    expect(b.auto).toMatchObject({ refSize: 44, status: 'overflow', locks: { size: true } });
    expect(reviewOf(b, page())).not.toBeNull();
    // Later edits keep it too.
    setBoxText(b, `${TEXT} NOW`, page());
    expect(b.style.size).toBe(44);
    // One burst, one entry: the text entry carries the size and the record.
    const recs = boxEditRecords({ pageId: page().id, boxId: b.id }, before, boxSnap(b), false);
    expect(recs.map((e) => e.t)).toEqual(['text']);
    for (const e of recs) hist.record(e);
    hist.undo();
    expect(b.style.size).toBe(26);
    expect(b.auto).toMatchObject({ refSize: 26, status: 'ok', locks: { size: false } });
  });

  // The Inspector's width field (`commitGeom`): resize, then the fit. The
  // re-solve changes the size as well as the rectangle, and the burst is one
  // entry that puts both back.
  it('records an Inspector width edit that re-sized the text as one undo step', () => {
    hist.initHistory();
    hist.resetHistory();
    const b = placeAt(32);
    selectBox(b.id);
    const before = boxSnap(b);
    resizeBox(page().id, b.id, { w: b.w - 80 });
    boxEdited(b, page());
    expect(b.style.size).not.toBe(before.style.size);
    const recs = boxEditRecords({ pageId: page().id, boxId: b.id }, before, boxSnap(b), true);
    expect(recs.map((e) => e.t)).toEqual(['resize']);
    for (const e of recs) hist.record(e);
    hist.undo();
    expect([b.x, b.y, b.w, b.h, b.style.size]).toEqual([before.x, before.y, before.w, before.h, before.style.size]);
    expect(b.auto).toEqual(before.auto);
  });

  // The Inspector's text field (`setText`): the re-solve changes the size, and
  // the edit is still one entry.
  it('records an Inspector text edit that re-sized the text as one undo step', () => {
    hist.initHistory();
    hist.resetHistory();
    const b = placeAt(32);
    selectBox(b.id);
    const before = boxSnap(b);
    setBoxText(b, 'NO.', page());
    boxEdited(b, page());
    expect(b.style.size).not.toBe(before.style.size);
    const recs = boxEditRecords({ pageId: page().id, boxId: b.id }, before, boxSnap(b), false);
    expect(recs.map((e) => e.t)).toEqual(['text']);
    for (const e of recs) hist.record(e);
    hist.undo();
    expect([b.x, b.y, b.w, b.h, b.style.size]).toEqual([before.x, before.y, before.w, before.h, before.style.size]);
    expect(b.auto).toEqual(before.auto);
    expect(boxText(b, page())).toBe(TEXT);
  });

  // A paste is a look. It never carries one box's hand-drawn geometry onto
  // another, never turns a manual box auto, and never sizes a manual box.
  it('pastes no strokes, masks or manual switches onto a manual box, and leaves it where it is', () => {
    const a = placeAt(26);
    copyStyle(a);
    const strokes = [{ pts: [[10, 10, 1], [50, 10, 1]], size: 6, color: '#000000' }];
    for (const over of [{ ink: { on: true, strokes } }, { autoHeight: false }]) {
      const b = placeAt(26);
      Object.assign(b.style, normalizeStyle({ ...b.style, ...over, font: 'Bangers' }));
      b.h -= 30;
      const g = [b.x, b.y, b.w, b.h, b.style.size];
      pasteStyle(b);
      expect(b.style.font).toBe(a.style.font);
      if (over.ink) expect(b.style.ink).toMatchObject({ on: true, strokes });
      else expect(b.style.autoHeight).toBe(false);
      expect([b.x, b.y, b.w, b.h, b.style.size]).toEqual(g);
    }
  });

  it('pastes the size the copied box was chosen at, not the size its balloon allowed', () => {
    const a = placeAt(32);
    expect(a.style.size).toBeLessThan(32);
    copyStyle(a);
    page().lines.push({ n: 2, type: 'dialogue', jp: 'い', en: 'NO.' });
    page().activeLineN = 2;
    placeActiveAt(250, 250);
    const b = page().boxes[1];
    b.style.size = 20;
    // Not selected: the paste says it is a size edit itself.
    selectBox(null);
    pasteStyle(b);
    expect(b.auto.refSize).toBe(32);
    expect(b.auto.locks.size).toBe(true);
    expect(b.style.size).toBe(32);
  });

  // A size an undo puts back on the selected box is nobody's edit. A bulk
  // entry selects nothing, so without the history re-marking the selection the
  // next fit took the restored size for one the user had typed, and locked it.
  it('never takes a size an undo put back for the user’s size edit', () => {
    hist.initHistory();
    hist.resetHistory();
    const b = placeAt(26);
    const style26 = normalizeStyle({ ...b.style });
    const geom26 = fitGeom(b);
    b.style.size = 20;
    b.auto.refSize = 20;
    selectBox(b.id);
    hist.record({
      t: 'bulk',
      pageId: page().id,
      items: [{ pageId: page().id, boxId: b.id, before: style26, after: normalizeStyle({ ...b.style }), geomBefore: geom26, geomAfter: fitGeom(b) }],
    });
    hist.undo();
    expect(b.style.size).toBe(26);
    // What the Inspector does for any edit of the box - a colour, say.
    autoFitBox(b, page());
    expect(b.auto.locks.size).toBe(false);
    expect(tags.sizes['']).toBeUndefined();
  });

  // The reference size is a size like the style's: a page whose raster comes
  // back at twice the resolution doubles it, and a solve that stood still
  // stands - its flag with it.
  it('rescales the reference size with the page, and keeps a standing solve', () => {
    loadProjectPages(noDetect('I TOLD YOU WE SHOULD HAVE LEFT BEFORE THE RAIN'));
    tags.sizes[''] = 40;
    const img = pageImage(500, 500);
    drawEllipse(img, 250, 250, 120, 90);
    pixels = img;
    placeActiveAt(250, 250);
    const b = page().boxes[0];
    expect(b.auto.status).toBe('overflow');
    const flag = reviewOf(b, page());
    expect(flag).not.toBeNull();
    setPageDims(page(), 1000, 1000);
    expect(b.auto.refSize).toBe(80);
    expect(reviewOf(b, page())).toEqual(flag);
  });

  // TextBox's edge drag: the record carries the solver's record (`fitGeom`), so
  // the width lock the drag set goes with the undo.
  it('an undone width drag takes its width lock back', () => {
    hist.initHistory();
    hist.resetHistory();
    const b = placeAt(26);
    const before = fitGeom(b);
    resizeBox(page().id, b.id, { x: b.x + 10, w: b.w - 20 }, { w: b.w, h: b.h });
    expect(b.auto.locks.width).toBe(true);
    hist.record({ t: 'resize', pageId: page().id, boxId: b.id, before, after: fitGeom(b) });
    hist.undo();
    expect(b.auto.locks.width).toBe(false);
    expect([b.x, b.w]).toEqual([before.x, before.w]);
  });

  // DET-4: a face the page has asked for and not got measures as the fallback.
  it('places as before, unsolved, while the face the text is set in is still loading', () => {
    const load = vi.fn(() => Promise.resolve([]));
    vi.stubGlobal('document', { fonts: { check: () => false, load } });
    try {
      const b = placeAt(32);
      expect(b.auto).toMatchObject({ refSize: 32, status: 'pending' });
      expect(load).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // DET-4, the other half: the face arrives, and the box placed without it is
  // solved - the box a placement with the face in hand would have made. Left to
  // the grow-only refit, its height followed the real face's lines out of its
  // balloon.
  describe('a box placed before its face loaded', () => {
    let ready = false;
    beforeEach(() => {
      ready = false;
      vi.stubGlobal('document', { fonts: { check: () => ready, load: () => Promise.resolve([]) } });
    });
    afterEach(() => vi.unstubAllGlobals());
    const geomOf = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size });
    // What a font arriving may not touch on a box it does not solve: the grow-only
    // refit may still make it taller, about its anchor.
    const kept = (b, before) => {
      expect([b.x, b.w, b.style.size]).toEqual([before.x, before.w, before.size]);
      expect(b.h).toBeGreaterThanOrEqual(before.h);
    };

    it('is solved when the face arrives, as if it had been there all along', () => {
      ready = true;
      const want = placeAt(32);
      const solved = { ...geomOf(want), auto: { ...want.auto } };
      ready = false;
      const b = placeAt(32);
      expect(b.auto.status).toBe('pending');
      ready = true;
      expect(noteFontsChanged()).toBeGreaterThan(0);
      expect(b.auto).toEqual(solved.auto);
      expect(geomOf(b)).toEqual({ x: solved.x, y: solved.y, w: solved.w, h: solved.h, size: solved.size });
    });

    // A chapter laid out under the old plain switch opens with the plain wrap as
    // each box's own. The solve a waiting box was placed for is that same
    // layout, so the box is still waiting - not one somebody has edited since.
    it('is still solved when it opens in a plain chapter and the face arrives', () => {
      // The plain wrap reads the browser's own breaks off a DOM node; this
      // environment has none to lay out, so every paragraph is one line.
      vi.stubGlobal('document', {
        fonts: { check: () => ready, load: () => Promise.resolve([]) },
        body: { appendChild: () => {} },
        createElement: () => ({ style: {}, remove: () => {} }),
        createRange: () => ({ setStart: () => {}, setEnd: () => {}, getClientRects: () => [] }),
      });
      const placed = placeAt(32);
      expect(placed.auto.status).toBe('pending');
      expect(placed.style.shape).not.toBe('off');
      loadProjectPages(JSON.parse(JSON.stringify(app.pages)), { plain: true });
      const b = page().boxes[0];
      expect(b.style.shape).toBe('off');
      expect(b.auto.status).toBe('pending');
      ready = true;
      expect(noteFontsChanged()).toBeGreaterThan(0);
      expect(b.auto.status).toBeTruthy();
      expect(b.auto.status).not.toBe('pending');
    });

    it('stays pending while its face is still loading', () => {
      const b = placeAt(32);
      const before = geomOf(b);
      noteFontsChanged();
      expect(b.auto.status).toBe('pending');
      expect(geomOf(b)).toEqual(before);
    });

    it('never re-solves a box that has a status', () => {
      ready = true;
      const b = placeAt(32);
      expect(b.auto.status).toBe('shrunk');
      // Laid out by hand since, or by an older engine: a font arriving leaves it.
      b.x -= 20;
      b.w += 30;
      b.style.size = 31;
      const before = geomOf(b);
      noteFontsChanged();
      expect(b.auto.status).toBe('shrunk');
      kept(b, before);
    });

    // Any edit, by whichever path, makes the box the user's: the face arriving
    // later settles it for the ladder instead of snapping it back.
    it('is the user’s once it is edited, and is not solved later', () => {
      const edits = [
        (b) => setBoxText(b, 'WE CAN STILL CATCH IT.', page()),
        (b) => resizeBox(page().id, b.id, { w: b.w - 12 }),
        (b) => {
          selectBox(b.id);
          nudgeBox(b.id, 0, 6);
        },
      ];
      for (const edit of edits) {
        ready = false;
        const b = placeAt(32);
        edit(b);
        const before = geomOf(b);
        ready = true;
        noteFontsChanged();
        expect(b.auto.status).toBe(null);
        kept(b, before);
      }
    });

    it('is never solved once it carries hand-drawn ink or a mask', () => {
      for (const over of [
        { ink: { on: true, strokes: [{ pts: [[10, 10, 1], [50, 10, 1]], size: 6, color: '#000000' }] } },
        { clip: { on: true, mode: 'exclude', shapes: [{ kind: 'ellipse', cx: 20, cy: 20, rx: 5, ry: 5 }] } },
      ]) {
        ready = false;
        const b = placeAt(32);
        Object.assign(b.style, normalizeStyle({ ...b.style, ...over }));
        const before = geomOf(b);
        ready = true;
        noteFontsChanged();
        expect(b.auto.status).toBe(null);
        kept(b, before);
      }
    });

    it('is solved when its chapter opens with the face already in', () => {
      ready = true;
      const want = geomOf(placeAt(32));
      ready = false;
      placeAt(32);
      const saved = JSON.parse(JSON.stringify(app.pages));
      ready = true;
      loadProjectPages(saved);
      const b = page().boxes[0];
      expect(b.auto.status).toBe('shrunk');
      expect(geomOf(b)).toEqual(want);
    });

    it('is solved when a redo brings it back after its face arrived', () => {
      hist.initHistory();
      hist.resetHistory();
      ready = false;
      placeAt(32);
      hist.undo();
      ready = true;
      noteFontsChanged();
      hist.redo();
      expect(page().boxes[0].auto.status).toBe('shrunk');
    });
  });
});
