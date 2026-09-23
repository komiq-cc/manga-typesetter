import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { app, page, loadProjectPages, placeDetectedOnPage, fontCssFor, autoFitBox, boxText } from './store.svelte.js';
import { boxCandidate, placeBlock, boxInkRect } from './contain.js';
import {
  canMeasure,
  lineWidth,
  fontMetrics,
  inkShiftY,
  layoutLines,
  applyCase,
  balloonWidthsFor,
  setTypesetEnabled,
  clearLayoutMemo,
  BOX_PAD,
  textInset,
  contentWidth,
} from './measure.js';
import { renderBoxTexture } from './exporter.js';
import { systemFontEntry } from './fonts.js';
import { defaultStyle, normalizeStyle, REVIEW_REASONS } from './data.js';
import { neededHeight } from './typeset.js';

// ===========================================================================
// Text measured with real fonts
// ===========================================================================
// Every other layout test runs on a stand-in metric: a character count, or
// `chars x size x 0.55` where a test grants `canMeasure`. That proves the
// algorithms; it cannot prove that real lettering fits, because a real face has
// kerning, wide and narrow glyphs, side bearings, and vertical metrics that are
// not 0.8/0.2 of the size.
//
// This file runs in the `realfont` project (vite.config.js), whose setup file
// (src/test/real-fonts.js) registers the fixture fonts with @napi-rs/canvas and
// gives measure.js a real canvas. Nothing here is mocked: the store resolves the
// font name to CSS exactly as the app does, measure.js measures with it, and the
// exporter paints the box.
//
// The shaped breaker is switched on for the whole file. With it off,
// `layoutLines` asks the browser's own line layout (`wrapLinesDOM`), which needs
// a DOM this lane does not have - and the setup's `document` says so loudly
// rather than quietly wrapping some other way.

const SIZE = 26;
// Regular faces only: the fixtures ship no bold, and a synthesised bold keeps
// the regular advances, which would measure a narrower block than the app draws.
const styleFor = (font, extra = {}) => normalizeStyle({ ...defaultStyle(), font, size: SIZE, bold: false, ...extra });

// The width Skia itself reports, bypassing the app entirely.
const probe = createCanvas(10, 10).getContext('2d');
function skiaWidth(css, text) {
  probe.font = css;
  return probe.measureText(text).width;
}

beforeAll(() => {
  setTypesetEnabled(true);
  // DejaVu Sans is not one of the app's built-in fonts, so it goes in the way an
  // installed font does: through the scan's own entry builder.
  app.fonts.system = [systemFontEntry({ name: 'DejaVu Sans', faces: { regular: true, italic: true } })];
  clearLayoutMemo();
});

describe('measure.js with a real canvas', () => {
  it('measures the face, not the stand-in', () => {
    expect(canMeasure()).toBe(true);
    const w = lineWidth('WAVE', styleFor('Comic Neue'), SIZE);
    // The stand-in says 4 x 26 x 0.55 = 57.2. Comic Neue says otherwise.
    expect(Math.abs(w - 4 * SIZE * 0.55)).toBeGreaterThan(1);
    expect(w).toBeCloseTo(skiaWidth(`400 ${SIZE}px 'Comic Neue'`, 'WAVE'), 3);
  });

  it('resolves every family through the store, unknown names to the fallback font', () => {
    expect(fontCssFor('DejaVu Sans')).toBe('"DejaVu Sans", sans-serif');
    const w = (font) => lineWidth('WAVE', styleFor(font), SIZE);
    // A narrow comic caps face, the default comic face, a wide text face.
    expect(w('Bangers')).toBeLessThan(w('Comic Neue') - 10);
    expect(w('DejaVu Sans')).toBeGreaterThan(w('Comic Neue') + 5);
    // A name the app does not know is drawn in FALLBACK_FONT, and measured so.
    expect(w('No Such Font')).toBe(w('Comic Neue'));
  });

  it('measures italic in the real oblique face, not a slanted regular', () => {
    // A slant synthesised from the regular face keeps its advances; DejaVu's own
    // oblique has different ones.
    const upright = lineWidth('WAVE', styleFor('DejaVu Sans'), SIZE);
    expect(lineWidth('WAVE', styleFor('DejaVu Sans', { italic: true }), SIZE)).not.toBeCloseTo(upright, 1);
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
    // Comic Neue's content area is taller than its em - the case the baseline
    // maths in measure.js exists for.
    expect(comic.ascent + comic.descent).toBeGreaterThan(SIZE);
  });

  it('centres a block on its glyph ink (actualBoundingBox)', () => {
    // Under node this is 0 by design. With ink metrics, an all-caps line has
    // nothing below the baseline and sits high, so it moves down; a line of
    // descenders hangs low and moves up.
    const s = styleFor('Comic Neue');
    expect(inkShiftY(['WAVE'], s, SIZE)).toBeGreaterThan(0);
    expect(inkShiftY(['jumpy gypsy'], s, SIZE)).toBeLessThan(0);
  });

  it('breaks lines at the real advances', () => {
    const s = styleFor('Comic Neue');
    // 130px: the stand-in puts "WAVE WAVE" at 9 x 26 x 0.55 = 128.7 and would
    // keep it on one line. The face is wider than that.
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
});

// ---------------------------------------------------------------------------
// Ink against the box
// ---------------------------------------------------------------------------
// The box is placed and fitted by the store; the pixels are the exporter's own
// raster of it (`renderBoxTexture`, the picture `renderBox` and the page
// composite are made from, before the page's integer snap). How far the ink
// reaches past each edge of the box is read off that raster's alpha, in page
// px. Positive is outside. The raster is supersampled 2x, so a reading is good
// to half a pixel, which is also the tolerance the containment rule (OVF-2)
// allows.
function inkPastBox(box, p) {
  const { canvas, ox, oy, ss } = renderBoxTexture(box, p);
  const W = canvas.width;
  const H = canvas.height;
  const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const past = {
    left: ox - minX / ss,
    top: oy - minY / ss,
    right: (maxX + 1) / ss - ox - box.w,
    bottom: (maxY + 1) / ss - oy - box.h,
  };
  return { ...past, worst: Math.max(past.left, past.top, past.right, past.bottom) };
}

const TOLERANCE = 0.5;

describe('real glyph ink stays inside the box', () => {
  beforeEach(() => {
    app.chapterRef = null;
  });

  // Faces whose glyphs stay within their advances (or overhang by less than
  // BOX_PAD), so any line the breaker keeps inside the content width keeps its
  // ink inside the box. Bangers is not one of them - see the last test.
  it.each(['Comic Neue', 'DejaVu Sans'])('%s, placed from detection and fitted by the store', (font) => {
    const text =
      'Nobody told me the lighthouse keeper had a cat. Or that the cat had opinions about visitors, boats and me.';
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 600,
        lines: [{ n: 1, jp: 'あ', en: text, type: 'dialogue' }],
        boxes: [],
        detect: { panels: [], boxes: [{ n: 1, box: [290, 180, 520, 330], vertical: false, font_size: 20 }] },
      },
    ]);
    // Glyphs only: outlines have their own test below.
    app.lastStyle = styleFor(font, { strokes: [] });
    expect(placeDetectedOnPage()).toBe(1);
    const p = page();
    const box = p.boxes[0];
    const s = box.style;
    const lines = layoutLines(
      applyCase(text, s),
      s,
      s.size,
      contentWidth(box.w, s),
      balloonWidthsFor(box, s, s.size),
    );
    expect(lines.length).toBeGreaterThan(2);
    expect(inkPastBox(box, p).worst).toBeLessThanOrEqual(TOLERANCE);
  });

  // One line that fills the content width exactly - the tightest box the
  // layout keeps it on one line in - loaded as a saved document would be, so the
  // store's own open-time refit sizes its height. "WAIT WHAT" starts and ends on
  // letters with almost no side bearing, so nothing but the inset (the padding,
  // and the outline's room - `textInset`) stands between the ink and the box
  // edge. `pad` overrides the inset, for the width the layout used to keep it
  // whole in; `text` swaps the line.
  const FULL = 'WAIT WHAT';
  function fullWidthBox(font, extra = {}, { pad = null, text = FULL } = {}) {
    const s = styleFor(font, extra);
    const w = lineWidth(text, s, SIZE) + (pad ?? textInset(s)) * 2 + 0.01;
    loadProjectPages([
      {
        id: 1,
        w: 600,
        h: 400,
        lines: [{ n: 1, jp: 'あ', en: text, type: 'dialogue' }],
        boxes: [{ id: 'b1', lineN: 1, text: null, x: 200, y: 150, w, h: 20, style: s }],
        detect: null,
      },
    ]);
    const p = page();
    const box = p.boxes[0];
    const lines = layoutLines(applyCase(text, box.style), box.style, SIZE, contentWidth(box.w, box.style));
    return { box, p, lines };
  }

  // Pins down the fixtures the two containment tests below use, so those are
  // known to be about containment and nothing else.
  it('a full-width Comic Neue line, glyphs only', () => {
    const { box, p, lines } = fullWidthBox('Comic Neue', { strokes: [] });
    expect(lines).toEqual([FULL]);
    expect(inkPastBox(box, p).worst).toBeLessThanOrEqual(TOLERANCE);
    expect(fullWidthBox('Bangers', { strokes: [] }).lines).toEqual([FULL]);
    expect(styleFor('Comic Neue').strokes).toEqual([{ color: '#ffffff', width: 3, opacity: 1 }]);
  });

  // The containment contract (OVF-2, contain.js): a box's painted ink is inside
  // the box, or the box carries `box.review` saying it is not. Never overflowing
  // and unflagged. Opening a saved chapter may only grow heights, so a box laid
  // out too tight is FLAGGED on opening; an edit runs the ladder, which widens an
  // auto box until the ink clears it.
  function containedOrFlagged(box, p) {
    const past = inkPastBox(box, p).worst;
    expect(past <= TOLERANCE || !!box.review, `${past}px past the box, flag ${JSON.stringify(box.review)}`).toBe(true);
    return past;
  }

  // The default outline is 3px and the box pads its text by BOX_PAD = 2px, so
  // the outline of a full-width line was drawn about a pixel outside the box
  // with nothing saying so (OVF-3). The breaker now leaves the outline its room:
  // the tightest box that keeps the line whole keeps its outline inside, on
  // opening, with nothing to fit or flag.
  it('a full-width Comic Neue line in the default 3px outline: inside, and unflagged', () => {
    const { box, p, lines } = fullWidthBox('Comic Neue');
    expect(textInset(box.style)).toBe(BOX_PAD + 3);
    expect(lines).toEqual([FULL]);
    expect(inkPastBox(box, p).worst).toBeLessThanOrEqual(TOLERANCE);
    expect(box.review).toBeUndefined();
    // The box the old layout kept it whole in - the padding alone - now breaks
    // it, rather than running its outline past the edge.
    const old = fullWidthBox('Comic Neue', {}, { pad: BOX_PAD });
    expect(old.lines).toEqual(['WAIT', 'WHAT']);
    expect(inkPastBox(old.box, old.p).worst).toBeLessThanOrEqual(TOLERANCE);
    expect(old.box.review).toBeUndefined();
  });

  // Aligned to a side, a full-width line is anchored the inset in from it, so
  // its outline is inside on the edge it is aligned to as well as the far one -
  // the edge no growth can clear, because the text moves with it. Anchored at
  // the padding alone, every one of these drew its outline a pixel or more past
  // that edge and was flagged for it. Lines that start (left) or end (right) on
  // T, J, W or Y: the capitals with the least side bearing, and J's hook behind
  // the pen.
  it.each([
    ['Comic Neue', 'left', 'JUST WAIT'],
    ['Comic Neue', 'left', 'TRY JAW'],
    ['Comic Neue', 'right', 'TWO WAY'],
    ['Comic Neue', 'right', 'JAW TWIT'],
    ['DejaVu Sans', 'left', 'JUST WAIT'],
    ['DejaVu Sans', 'left', 'TRY JAW'],
    ['DejaVu Sans', 'right', 'TWO WAY'],
    ['DejaVu Sans', 'right', 'JAW TWIT'],
  ])('a full-width %s line aligned %s, "%s", in the default 3px outline: inside, and unflagged', (font, align, text) => {
    const { box, p, lines } = fullWidthBox(font, { align }, { text });
    expect(textInset(box.style)).toBe(BOX_PAD + 3);
    expect(lines).toEqual([text]);
    expect(inkPastBox(box, p).worst).toBeLessThanOrEqual(TOLERANCE);
    expect(box.review).toBeUndefined();
  });

  // Not every face. Bangers' glyphs reach up to about 4px past their advance on
  // the right at 26px - more than the 2px of padding the inset has before it
  // counts the outline - and aligned right, that is the anchored edge: widening
  // moves the text with it, and the floor size (three quarters of 26) still
  // overhangs. So the box is flagged, and says why. Clearing it would take an
  // anchor that reads the ink rather than the advance, in every renderer.
  it('a full-width Bangers line aligned right, in the default outline: flagged on its aligned edge', () => {
    const { box, p } = fullWidthBox('Bangers', { align: 'right' });
    expect(containedOrFlagged(box, p)).toBeGreaterThan(TOLERANCE);
    autoFitBox(box, p);
    expect(box.review?.reason).toBe(REVIEW_REASONS.alignedEdge);
    expect(box.review.overflow.r).toBeGreaterThan(0);
    containedOrFlagged(box, p);
  });

  // Found by this lane: Bangers' glyphs reach up to about 3.7px past their
  // advance on the right at 26px (negative right side bearings), and the layout
  // fits advances, not ink - OVF-10's "width uses advance, not ink", on an upright
  // face. So a full-width Bangers line's GLYPHS sit outside the box with no
  // outline at all - and the containment check, which reads the ink, sees it.
  it('a full-width Bangers line, glyphs only: inside, or flagged', () => {
    const { box, p } = fullWidthBox('Bangers', { strokes: [] });
    const past = containedOrFlagged(box, p);
    expect(past).toBeGreaterThan(TOLERANCE);
    expect(box.review.overflow.r).toBeGreaterThanOrEqual(Math.floor(past));
    autoFitBox(box, p);
    expect(inkPastBox(box, p).worst).toBeLessThanOrEqual(TOLERANCE);
    expect(box.review).toBeUndefined();
  });

  // OVF-8: the height a chapter opens at is the ink's as well as the lines'.
  // Accented capitals over a line of descenders, at a line height of 0.8 and in
  // the default outline, stand taller than their line boxes; sized from the
  // line boxes alone, the box was flagged "no longer fits" on every opening and
  // nothing grew. The grow-only height reads the ink.
  it.each(['Comic Neue', 'DejaVu Sans'])('%s: accents over descenders at a tight line height open inside their box', (font) => {
    const text = 'ÉCLAT\ngypsy';
    const s = styleFor(font, { lineHeight: 0.8 });
    loadProjectPages([
      {
        id: 1,
        w: 600,
        h: 400,
        lines: [{ n: 1, jp: 'あ', en: text, type: 'dialogue' }],
        boxes: [{ id: 'b1', lineN: 1, text: null, x: 200, y: 150, w: 240, h: 20, style: s }],
        detect: null,
      },
    ]);
    const p = page();
    const box = p.boxes[0];
    expect(placeBlock(boxCandidate(box, boxText(box, p))).lines).toEqual(['ÉCLAT', 'gypsy']);
    expect(box.h).toBeGreaterThan(neededHeight(2, box.style, textInset(box.style)));
    expect(box.review).toBeUndefined();
    expect(inkPastBox(box, p).worst).toBeLessThanOrEqual(TOLERANCE);
  });

  // OVF-4: a word no line can hold, with real advances. The breaker has no
  // hyphen for an SFX like this one (no vowel after the A's), so it keeps it
  // whole on a line far wider than the box; the ladder widens the box to its
  // balloon and tries every size down to the floor, and the word is still
  // wider. So the box is flagged, and the flag names the word.
  it.each(['Comic Neue', 'DejaVu Sans'])('%s: an SFX wider than its balloon is flagged as a word too wide', (font) => {
    const sfx = 'AAAAAARRRRRGGGGGHHHHHHHHH!!!!';
    const s = styleFor(font, { size: 30 });
    const balloon = { kind: 'ellipse', cx: 400, cy: 300, rx: 100, ry: 60 };
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 600,
        lines: [{ n: 1, jp: 'あ', en: sfx, type: 'dialogue' }],
        boxes: [{ id: 'b1', lineN: 1, text: null, x: 357, y: 280, w: 86 + textInset(s) * 2, h: 40, fit: balloon, style: s }],
        detect: null,
      },
    ]);
    const p = page();
    const box = p.boxes[0];
    expect(placeBlock(boxCandidate(box, sfx)).lines).toEqual([sfx]);
    autoFitBox(box, p);
    expect(box.review?.reason).toBe(REVIEW_REASONS.wideWord);
    expect(box.x).toBeCloseTo(300, 6);
    expect(box.w).toBeCloseTo(200, 6);
    expect(box.style.size).toBe(30);
    containedOrFlagged(box, p);
  });
});

// ---------------------------------------------------------------------------
// The check and the painter describe the same ink (OVF-2 test 9)
// ---------------------------------------------------------------------------
// `boxInkRect` is geometry off `measureText`; the exporter's raster is pixels.
// They are the same block only because both place it through `placeBlock` - so
// for every face, alignment and outline here the two rectangles agree to the
// raster's own resolution: half a pixel of supersample, plus the fraction of a
// pixel antialiasing lights beyond a glyph's outline.
//
// The agreement is one-sided on purpose. Painted ink may reach past the check by
// SLACK and no more - past that, a box the check calls clean would show ink over
// its edge, which is the bug. The check may sit OUTSIDE the painted ink by up to
// a further pixel: @napi-rs/canvas reports actualBoundingBoxAscent / Descent /
// Left as whole pixels rounded outward (DejaVu Sans' "É" at 26px measures 25 up,
// paints 24 at 2x), so in this lane the check is a pixel conservative at the top
// of an accent. That direction only ever flags or grows a box a pixel early.
// WebKit's bounds are fractional; the app does not pay that pixel.
describe('boxInkRect is the ink the exporter paints', () => {
  const SLACK = 0.5 + 0.15;
  const ROUNDED_OUT = 1;
  function rasterInk(box, p) {
    const { canvas, ox, oy, ss } = renderBoxTexture(box, p);
    const W = canvas.width;
    const H = canvas.height;
    const d = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    let minX = W;
    let minY = H;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return { x0: minX / ss - ox, y0: minY / ss - oy, x1: (maxX + 1) / ss - ox, y1: (maxY + 1) / ss - oy };
  }

  const CASES = [
    ['Comic Neue', { align: 'center' }],
    ['Comic Neue', { align: 'left', valign: 'top' }],
    ['Bangers', { align: 'right', valign: 'bottom', strokes: [] }],
    ['Bangers', { align: 'center', letterSpacing: 3 }],
    ['DejaVu Sans', { align: 'left', italic: true, strokes: [] }],
    ['DejaVu Sans', { align: 'center', lineHeight: 0.9, strokes: [{ color: '#ffffff', width: 5, opacity: 1 }] }],
    ['Comic Neue', { align: 'center', shadows: [{ color: '#000000', x: 6, y: 4, blur: 0, opacity: 1 }] }],
  ];

  it.each(CASES)('%s %j', (font, extra) => {
    const s = styleFor(font, extra);
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 600,
        lines: [],
        boxes: [{ id: 'b1', lineN: null, text: 'Jumpy fjord, ÉTÉ! Wavy quilts', x: 200, y: 150, w: 170, h: 160, style: s }],
        detect: null,
      },
    ]);
    const p = page();
    const box = p.boxes[0];
    const cand = boxCandidate(box, boxText(box, p));
    expect(placeBlock(cand).lines.length).toBeGreaterThan(1);
    const geo = boxInkRect(cand);
    const got = rasterInk(box, p);
    const want = { x0: geo.x, y0: geo.y, x1: geo.x + geo.w, y1: geo.y + geo.h };
    for (const k of ['x0', 'y0', 'x1', 'y1']) {
      // How far the painted ink reaches past the check on this side: positive is
      // ink the check missed, negative is check the ink never used.
      const missed = k.endsWith('0') ? want[k] - got[k] : got[k] - want[k];
      const msg = `${k}: raster ${got[k]} vs check ${want[k]}`;
      expect(missed, msg).toBeLessThanOrEqual(SLACK);
      expect(-missed, msg).toBeLessThanOrEqual(SLACK + ROUNDED_OUT);
    }
  });
});
