import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { app, page, loadProjectPages, placeDetectedOnPage, fontCssFor } from './store.svelte.js';
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
} from './measure.js';
import { renderBoxTexture } from './exporter.js';
import { systemFontEntry } from './fonts.js';
import { defaultStyle, normalizeStyle } from './data.js';

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
      Math.max(1, box.w - BOX_PAD * 2),
      balloonWidthsFor(box, s, s.size),
    );
    expect(lines.length).toBeGreaterThan(2);
    expect(inkPastBox(box, p).worst).toBeLessThanOrEqual(TOLERANCE);
  });

  // One line that fills the content width exactly - the tightest box today's
  // layout keeps it on one line in - loaded as a saved document would be, so the
  // store's own open-time refit sizes its height. "WAIT WHAT" starts and ends on
  // letters with almost no side bearing, so nothing but the padding stands
  // between the ink and the box edge.
  const FULL = 'WAIT WHAT';
  function fullWidthBox(font, extra = {}) {
    const s = styleFor(font, extra);
    const w = lineWidth(FULL, s, SIZE) + BOX_PAD * 2 + 0.01;
    loadProjectPages([
      {
        id: 1,
        w: 600,
        h: 400,
        lines: [{ n: 1, jp: 'あ', en: FULL, type: 'dialogue' }],
        boxes: [{ id: 'b1', lineN: 1, text: null, x: 200, y: 150, w, h: 20, style: s }],
        detect: null,
      },
    ]);
    const p = page();
    const box = p.boxes[0];
    const lines = layoutLines(applyCase(FULL, box.style), box.style, SIZE, box.w - BOX_PAD * 2);
    return { box, p, lines };
  }

  // Holds today, and pins down the fixtures the two `it.fails` below use, so
  // those are known to fail on their containment assertion and nothing else.
  it('a full-width Comic Neue line, glyphs only', () => {
    const { box, p, lines } = fullWidthBox('Comic Neue', { strokes: [] });
    expect(lines).toEqual([FULL]);
    expect(inkPastBox(box, p).worst).toBeLessThanOrEqual(TOLERANCE);
    expect(fullWidthBox('Bangers', { strokes: [] }).lines).toEqual([FULL]);
    expect(styleFor('Comic Neue').strokes).toEqual([{ color: '#ffffff', width: 3, opacity: 1 }]);
  });

  // KNOWN BUG OVF-3 (docs/typeset-review/01-overflow-containment.md): the
  // default outline is 3px and the box pads its text by BOX_PAD = 2px, so the
  // outline of a full-width line is drawn about a pixel outside the box. Fails
  // today; when the containment fix lands (layout inset = BOX_PAD + stroke
  // extent) it passes, `it.fails` turns red, and this becomes a plain `it`.
  it.fails('a full-width Comic Neue line in the default 3px outline (OVF-3)', () => {
    const { box, p } = fullWidthBox('Comic Neue');
    expect(inkPastBox(box, p).worst).toBeLessThanOrEqual(TOLERANCE);
  });

  // KNOWN BUG, found by this lane: Bangers' glyphs reach up to about 3.7px past
  // their advance on the right at 26px (negative right side bearings), and the
  // layout fits advances, not ink - OVF-10's "width uses advance, not ink", on an
  // upright face. So a full-width Bangers line's GLYPHS sit outside the box with
  // no outline at all. Fails today; passes once containment checks the real ink
  // rectangle (OVF-2), and then becomes a plain `it`.
  it.fails('a full-width Bangers line, glyphs only (ink past the advance, OVF-2/OVF-10)', () => {
    const { box, p } = fullWidthBox('Bangers', { strokes: [] });
    expect(inkPastBox(box, p).worst).toBeLessThanOrEqual(TOLERANCE);
  });
});
