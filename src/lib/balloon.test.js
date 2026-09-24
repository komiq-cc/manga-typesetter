import { describe, it, expect } from 'vitest';
import {
  BALLOON_DEFAULTS,
  balloonFrame,
  detectBalloon,
  detectBalloonAt,
  fillFromPoint,
  fillInterior,
  localUniformity,
  shapeContainsPoint,
  fitBalloonShape,
  inscribedRect,
  interiorLineWidths,
  interiorProfile,
  interiorThreshold,
  safetyInset,
  shapeBounds,
} from './balloon.js';
import { normalizeFit } from './data.js';

// Every page in this file is built by hand as an `ImageData`-shaped object -
// `{ width, height, data }` with a plain `Uint8ClampedArray` - because a canvas
// is exactly what this module is meant not to need. The pixel values are the
// ones a scan actually has: paper near white, ink near black, with nothing in
// between except where a helper deliberately puts it.
const PAPER = 248;
const INK = 18;

function page(w, h, fill = PAPER) {
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

// A balloon: a light interior inside a dark outline. Drawn the way one is
// inked - as a single closed shape - so that a tail is part of the same outline
// rather than a second object laid over the first. Getting that right matters:
// a tail pasted on top leaves the seam between the two open, and the fill pours
// out through it, which says nothing about the module and everything about the
// fixture.
//
//   `bumps` scallops the outline, which is what makes a thought cloud a cloud.
//   `gap`   punches a hole in the outline afterwards - a bubble whose tail was
//           drawn open, or one an inked sound effect runs into.
function drawEllipse(img, cx, cy, rx, ry, { ring = 3, tail = null, gap = null, bumps = 0 } = {}) {
  // The scallop factor is taken at the same angle for the interior and for the
  // outline, so the outline strictly contains the interior at every angle and
  // the shape is closed by construction. Recomputing the angle on the grown
  // ellipse instead leaves pinholes in the valleys of the bumps.
  const radius = (x, y, g) => {
    const k = bumps
      ? 1 + 0.16 * Math.cos(bumps * Math.atan2((y + 0.5 - cy) / ry, (x + 0.5 - cx) / rx))
      : 1;
    return Math.hypot((x + 0.5 - cx) / (rx + g), (y + 0.5 - cy) / (ry + g)) / k;
  };
  const inTail = (x, y, g) => {
    if (!tail) return false;
    if (y + 0.5 < tail.y0 || y + 0.5 > tail.tipY + g) return false;
    const t = Math.min(1, (y + 0.5 - tail.y0) / (tail.tipY - tail.y0));
    return Math.abs(x + 0.5 - (tail.bx + (tail.tipX - tail.bx) * t)) <= tail.halfw * (1 - t) + g;
  };
  // The scallops push the outline past the plain ellipse, so the area walked has
  // to grow with them or the shape is drawn clipped - and a clipped outline is
  // an open one.
  const ex = rx * (bumps ? 1.2 : 1) + ring + 2;
  const ey = ry * (bumps ? 1.2 : 1) + ring + 2;
  const yLo = Math.floor(cy - ey);
  const yHi = Math.ceil(Math.max(cy + ey, tail ? tail.tipY + ring + 2 : 0));
  for (let y = yLo; y <= yHi; y++) {
    for (let x = Math.floor(cx - ex); x <= Math.ceil(cx + ex); x++) {
      if (radius(x, y, 0) <= 1 || inTail(x, y, 0)) put(img, x, y, PAPER);
      else if (radius(x, y, ring) <= 1 || inTail(x, y, ring)) put(img, x, y, INK);
    }
  }
  if (gap) fillRect(img, gap.x, gap.y, gap.w, gap.h, PAPER);
}

function drawBox(img, x, y, w, h, { ring = 3 } = {}) {
  fillRect(img, x - ring, y - ring, w + 2 * ring, h + 2 * ring, INK);
  fillRect(img, x, y, w, h, PAPER);
}

// A column of vertical Japanese: solid-ish glyph blocks with the small gaps
// between characters a real column has. The point of it is that the detected
// text block's centre lands on ink, which is what makes the naive seed useless.
function drawGlyphColumn(img, x, y, w, h, { glyph = 22, gapY = 6 } = {}) {
  for (let gy = y; gy + glyph <= y + h; gy += glyph + gapY) {
    fillRect(img, x, gy, w, glyph, INK);
    // A counter - the enclosed white of a 口 - so a seed that wanders into one
    // has somewhere to be trapped.
    fillRect(img, x + 4, gy + 4, Math.max(1, w - 8), Math.max(1, glyph - 8), PAPER);
  }
}

// A jagged SFX burst: a star whose radius swings wildly with the angle, drawn
// scanline by scanline so it is a genuine filled region rather than an outline.
function drawBurst(img, cx, cy, r, spikes = 9) {
  for (let y = cy - r - 4; y <= cy + r + 4; y++) {
    for (let x = cx - r - 4; x <= cx + r + 4; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const rr = r * (0.45 + 0.55 * Math.abs(Math.cos(spikes * Math.atan2(dy, dx))));
      put(img, x, y, d <= rr ? PAPER : INK);
    }
  }
}

// A hand-built profile, straight from the geometry, for the pure half of the
// module. No pixels involved at all.
const ellipseProfile = (y, cx, cy, rx, ry, extra = []) => {
  const rows = [];
  for (let yy = y; yy < cy + ry; yy++) {
    const dy = (yy + 0.5 - cy) / ry;
    if (Math.abs(dy) > 1) {
      rows.push(null);
      continue;
    }
    const hw = rx * Math.sqrt(1 - dy * dy);
    rows.push([Math.round(cx - hw), Math.round(cx + hw) - 1]);
  }
  return { y, rows: [...rows, ...extra], holes: 0, escaped: false };
};

// The same sealed balloon the leak test punctures, for the control half of it.
const page500Ellipse = () => {
  const img = page(500, 500);
  drawEllipse(img, 250, 250, 90, 60);
  return img;
};

const rectProfile = (y, x, w, h) => ({
  y,
  rows: Array.from({ length: h }, () => [x, x + w - 1]),
  holes: 0,
  escaped: false,
});

describe('interiorThreshold - the cut comes from the pixels, not from a constant', () => {
  it('lands between the ink and the paper of a bimodal window', () => {
    const hist = new Uint32Array(256);
    hist[INK] = 3000;
    hist[PAPER] = 12000;
    const t = interiorThreshold(hist, 15000);
    expect(t).toBeGreaterThan(INK);
    expect(t).toBeLessThan(PAPER);
  });

  it('follows the page it is given rather than a fixed midpoint', () => {
    // A muddy newsprint scan: "ink" is 90 and "paper" is 190. A hard-coded 128
    // would be wrong for one of these two windows; Otsu is right for both.
    const muddy = new Uint32Array(256);
    muddy[90] = 4000;
    muddy[190] = 9000;
    const crisp = new Uint32Array(256);
    crisp[5] = 4000;
    crisp[250] = 9000;
    expect(interiorThreshold(muddy, 13000)).toBeGreaterThan(90);
    expect(interiorThreshold(muddy, 13000)).toBeLessThan(190);
    expect(interiorThreshold(crisp, 13000)).not.toBe(interiorThreshold(muddy, 13000));
  });

  it('refuses to split paper noise on a window with no ink in it', () => {
    // The failure mode the bounds exist for: with only paper in the histogram
    // the method happily splits it, and an unclamped threshold up at 250 would
    // make most of the balloon read as ink.
    const flat = new Uint32Array(256);
    flat[246] = 5000;
    flat[250] = 5000;
    expect(interiorThreshold(flat, 10000)).toBe(BALLOON_DEFAULTS.maxThreshold);
  });
});

describe('fillInterior - recovering the balloon from the pixels', () => {
  it('fills an oval balloon from a text block sitting on the glyphs', () => {
    const img = page(400, 400);
    drawEllipse(img, 200, 200, 110, 70);
    // Vertical Japanese: a tall narrow column dead centre, which is where the
    // naive seed would be and is entirely made of ink.
    drawGlyphColumn(img, 192, 150, 18, 100);
    const region = fillInterior(img, [192, 150, 210, 250]);
    expect(region).not.toBeNull();
    expect(region.escaped).toBe(false);
    // The interior of a 110x70 ellipse is about 24000px. Anything much smaller
    // means the fill was trapped in a glyph counter or a gap between strokes.
    expect(region.count).toBeGreaterThan(20000);
    expect(region.bounds.w).toBeGreaterThan(210);
    expect(region.bounds.h).toBeGreaterThan(130);
  });

  it('folds the glyphs back into the interior instead of profiling around them', () => {
    const img = page(400, 400);
    drawEllipse(img, 200, 200, 110, 70);
    drawGlyphColumn(img, 192, 150, 18, 100);
    const rows = interiorProfile(fillInterior(img, [192, 150, 210, 250])).rows;
    // The row through the middle of the column crosses the glyphs. Without the
    // enclosed-hole pass its widest run would be one side of the column - about
    // 100px - rather than the balloon's 220.
    const mid = rows[Math.floor(rows.length / 2)];
    expect(mid[1] - mid[0]).toBeGreaterThan(200);
  });

  it('keeps the search inside a window and reports a fill that got out', () => {
    const img = page(500, 500);
    const block = [220, 220, 280, 280];
    const sealed = fillInterior(page500Ellipse(), block);
    expect(sealed.escaped).toBe(false);
    // The same balloon with a hole punched in its outline - an open tail, or an
    // inked sound effect running into the wall. The fill pours out onto the page.
    drawEllipse(img, 250, 250, 90, 60, { gap: { x: 330, y: 240, w: 24, h: 24 } });
    const leaked = fillInterior(img, block);
    expect(leaked.escaped).toBe(true);
    // Bounded even so: it never looked at more than its window, which for a
    // 60x60 block is a fraction of the 250000-pixel page.
    expect(leaked.w).toBeLessThanOrEqual(320);
    expect(leaked.h).toBeLessThanOrEqual(320);
  });

  it('will not take a pocket inside a glyph for a balloon', () => {
    // The whole page is ink except one 4x4 white pocket at the block's centre -
    // a counter, the enclosed white of a 口. It is bounded, so it would win on
    // "did not escape" alone; it is far smaller than the text it is supposed to
    // contain, so it is not a candidate at all.
    const img = page(200, 200, INK);
    fillRect(img, 98, 98, 4, 4, PAPER);
    expect(fillInterior(img, [80, 80, 120, 120])).toBeNull();
  });

  it('returns null rather than guessing when there is nothing to work with', () => {
    expect(fillInterior(null, [0, 0, 10, 10])).toBeNull();
    expect(fillInterior(page(20, 20), null)).toBeNull();
    expect(fillInterior(page(20, 20), [5, 5])).toBeNull();
    expect(fillInterior(page(20, 20), [30, 30, 40, 40])).toBeNull();
  });

  it('accepts a block whose corners arrive the other way round', () => {
    const img = page(300, 300);
    drawEllipse(img, 150, 150, 80, 50);
    const a = fillInterior(img, [140, 130, 160, 170]);
    const b = fillInterior(img, [160, 170, 140, 130]);
    expect(b.count).toBe(a.count);
  });

  it('treats a transparent pixel as somewhere the fill may not go', () => {
    const img = page(300, 300);
    drawEllipse(img, 150, 150, 80, 50);
    // A transparent band across the balloon: outside the art entirely, so the
    // fill must stop at it rather than spreading through.
    for (let y = 140; y < 160; y++)
      for (let x = 70; x < 230; x++) img.data[(y * 300 + x) * 4 + 3] = 0;
    const region = fillInterior(img, [140, 100, 160, 135]);
    expect(region.bounds.y + region.bounds.h).toBeLessThanOrEqual(141);
  });
});

describe('interiorProfile - one row, one pair of numbers', () => {
  it('reports the widest contiguous run per row in page coordinates', () => {
    const mask = new Uint8Array(10 * 3);
    for (let x = 2; x < 8; x++) mask[x] = 1; // row 0: one run, 2..7
    for (let x = 1; x < 3; x++) mask[10 + x] = 1; // row 1: a short run...
    for (let x = 5; x < 9; x++) mask[10 + x] = 1; // ...and a longer one
    const p = interiorProfile({ x: 100, y: 50, w: 10, h: 3, mask, escaped: false });
    expect(p.y).toBe(50);
    expect(p.rows).toEqual([
      [102, 107],
      [105, 108],
    ]);
  });

  it('does not bridge a gap - a tail is a second run, not extra width', () => {
    const mask = new Uint8Array(20);
    for (let x = 1; x < 6; x++) mask[x] = 1;
    for (let x = 14; x < 18; x++) mask[x] = 1;
    const p = interiorProfile({ x: 0, y: 0, w: 20, h: 1, mask, escaped: false });
    expect(p.rows).toEqual([[1, 5]]);
  });

  it('counts a row with no run as a hole rather than dropping it', () => {
    const mask = new Uint8Array(4 * 3);
    mask[0] = 1;
    mask[8] = 1; // row 2; row 1 is empty and sits between two filled rows
    const p = interiorProfile({ x: 0, y: 10, w: 4, h: 3, mask, escaped: false });
    expect(p.rows.length).toBe(3);
    expect(p.rows[1]).toBeNull();
    expect(p.holes).toBe(1);
  });

  it('trims the empty rows at the ends and reports where the first one starts', () => {
    const mask = new Uint8Array(4 * 4);
    mask[4] = 1;
    mask[8] = 1;
    const p = interiorProfile({ x: 7, y: 30, w: 4, h: 4, mask, escaped: false });
    expect(p.y).toBe(31);
    expect(p.rows.length).toBe(2);
  });

  it('carries the escape flag through untouched', () => {
    const mask = new Uint8Array(4);
    mask[1] = 1;
    expect(interiorProfile({ x: 0, y: 0, w: 4, h: 1, mask, escaped: true }).escaped).toBe(true);
    expect(interiorProfile(null).escaped).toBe(true);
  });
});

describe('fitBalloonShape - what shape is this, and how much of it to believe', () => {
  it('recovers an ellipse from a clean profile', () => {
    const fit = fitBalloonShape(ellipseProfile(100, 250, 160, 90, 60));
    expect(fit.kind).toBe('ellipse');
    expect(fit.shape.cx).toBeCloseTo(250, 0);
    expect(fit.shape.cy).toBeCloseTo(160, 0);
    expect(fit.shape.rx).toBeCloseTo(90, 0);
    expect(fit.shape.ry).toBeCloseTo(60, 0);
    expect(fit.confidence).toBeGreaterThan(0.9);
  });

  it('recovers a rectangle from a profile of constant width', () => {
    const fit = fitBalloonShape(rectProfile(40, 30, 120, 60));
    expect(fit.kind).toBe('rect');
    expect(fit.shape).toEqual({ kind: 'rect', x: 30, y: 40, w: 120, h: 60 });
    expect(fit.confidence).toBeGreaterThan(0.95);
  });

  it('hands back plain JSON - a handful of numbers, no mask', () => {
    const fit = fitBalloonShape(ellipseProfile(100, 250, 160, 90, 60));
    const round = JSON.parse(JSON.stringify(fit.shape));
    expect(round).toEqual(fit.shape);
    expect(Object.keys(round).sort()).toEqual(['cx', 'cy', 'kind', 'rx', 'ry']);
    for (const k of ['cx', 'cy', 'rx', 'ry']) expect(Number.isFinite(round[k])).toBe(true);
    expect(JSON.stringify(fit.shape).length).toBeLessThan(80);
  });

  it('fits the body of a balloon that has a tail', () => {
    // Twenty rows of a narrow spike hanging off the bottom, which is what a tail
    // is. The extent fit would take the spike for part of the oval and stretch
    // it; the least-squares candidate and the refit on the inliers do not.
    const tail = Array.from({ length: 20 }, (_, i) => [250 + i, 262 + i]);
    const fit = fitBalloonShape(ellipseProfile(100, 250, 160, 90, 60, tail));
    const bare = fitBalloonShape(ellipseProfile(100, 250, 160, 90, 60));
    expect(fit.kind).toBe('ellipse');
    // The body, not the body plus the spike: within a pixel of the fit the same
    // balloon gets when the tail is not there at all.
    expect(fit.shape.cy).toBeCloseTo(bare.shape.cy, 0);
    expect(fit.shape.ry).toBeCloseTo(bare.shape.ry, 0);
    expect(fit.shape.rx).toBeCloseTo(bare.shape.rx, 0);
  });

  it('refuses a wide slab hanging off the body, which is not a tail', () => {
    // The other side of the same rule: a narrow spike is a tail and is
    // tolerated, a slab as wide as the balloon means the fitted body was the
    // wrong body - two bubbles joined, or a fill that got into the panel.
    const slab = Array.from({ length: 20 }, () => [180, 320]);
    const fit = fitBalloonShape(ellipseProfile(100, 250, 160, 90, 60, slab));
    expect(fit.kind).toBe('irregular');
  });

  it('refuses a fill that escaped, however well it would have fitted', () => {
    // A perfect rectangle - the shape an escaped fill very often has, because
    // what it found was the panel. Fitting it would be the one failure that
    // stops the caller's fallback from ever firing.
    const p = { ...rectProfile(40, 30, 120, 60), escaped: true };
    expect(fitBalloonShape({ ...p, escaped: false }).kind).toBe('rect');
    const fit = fitBalloonShape(p);
    expect(fit.kind).toBe('irregular');
    expect(fit.shape).toBeNull();
    expect(fit.confidence).toBe(0);
    expect(fit.reason).toBe('escaped');
  });

  it('refuses a region that is not vertically connected', () => {
    const p = rectProfile(0, 0, 50, 40);
    for (const i of [5, 12, 19, 26, 33]) p.rows[i] = null;
    p.holes = 5;
    const fit = fitBalloonShape(p);
    expect(fit.kind).toBe('irregular');
    expect(fit.reason).toBe('holes');
  });

  it('refuses a profile too short to mean anything', () => {
    const fit = fitBalloonShape(rectProfile(0, 0, 50, 4));
    expect(fit.kind).toBe('irregular');
    expect(fit.reason).toBe('tiny');
    expect(fitBalloonShape({ y: 0, rows: [], holes: 0, escaped: false }).reason).toBe('empty');
    expect(fitBalloonShape(null).reason).toBe('empty');
  });

  it('calls a jagged profile irregular rather than fitting it anyway', () => {
    const rows = [];
    for (let i = 0; i < 80; i++) {
      const hw = 20 + 55 * Math.abs(Math.cos(i * 1.1));
      rows.push([Math.round(200 - hw), Math.round(200 + hw)]);
    }
    const fit = fitBalloonShape({ y: 0, rows, holes: 0, escaped: false });
    expect(fit.kind).toBe('irregular');
    expect(fit.shape).toBeNull();
  });

  it('tolerates a few pixels of raggedness on the edge of a real scan', () => {
    const p = ellipseProfile(100, 250, 160, 90, 60);
    for (let i = 0; i < p.rows.length; i += 3) p.rows[i] = [p.rows[i][0] - 1, p.rows[i][1] + 1];
    expect(fitBalloonShape(p).kind).toBe('ellipse');
  });

  it('does not let the degenerate ellipse claim a rectangle', () => {
    // An ellipse fitted to constant widths has no curvature to recover: the
    // rectangle is tried first precisely so this profile never reaches it.
    const fit = fitBalloonShape(rectProfile(0, 0, 200, 100));
    expect(fit.kind).toBe('rect');
    expect(fit.shape.h).toBe(100);
  });

  it('refits a rectangle on inliers, trimming outlier edge rows from vertical bounds', () => {
    // 15 clean rows of width 100 [50, 149], plus 2 narrow outlier edge rows [76, 123] (width 48, hw 24)
    // Initial fit has 15/17 = 0.882 coverage (< minCoverage 0.90); refit on inliers trims h from 17 to 15,
    // achieving 15/15 = 1.0 coverage and successfully classifying as rect.
    const rows = [
      ...Array.from({ length: 15 }, () => [50, 149]),
      [76, 123],
      [76, 123],
    ];
    const p = { y: 10, rows, holes: 0, escaped: false };
    const fit = fitBalloonShape(p);
    expect(fit.kind).toBe('rect');
    expect(fit.shape.y).toBe(10);
    expect(fit.shape.h).toBe(15);
    expect(fit.shape.w).toBe(100);
    expect(fit.shape.x).toBe(50);
  });
});

describe('safetyInset - derived from the shape, bounded at both ends', () => {
  it('is a fraction of the shorter side', () => {
    expect(safetyInset({ kind: 'rect', x: 0, y: 0, w: 400, h: 100 })).toBe(8);
    expect(safetyInset({ kind: 'ellipse', cx: 0, cy: 0, rx: 200, ry: 50 })).toBe(8);
  });

  it('is never invisible and never dominant', () => {
    expect(safetyInset({ kind: 'rect', x: 0, y: 0, w: 20, h: 12 })).toBe(BALLOON_DEFAULTS.insetMin);
    expect(safetyInset({ kind: 'rect', x: 0, y: 0, w: 900, h: 800 })).toBe(BALLOON_DEFAULTS.insetMax);
  });
});

describe('inscribedRect - the largest rectangle the shape can hold', () => {
  it('is a√2 by b√2 for an ellipse', () => {
    const shape = { kind: 'ellipse', cx: 300, cy: 200, rx: 100, ry: 60 };
    const r = inscribedRect(shape, { inset: 0 });
    expect(r.w).toBeCloseTo(100 * Math.SQRT2, 6);
    expect(r.h).toBeCloseTo(60 * Math.SQRT2, 6);
    expect(r.x + r.w / 2).toBeCloseTo(300, 6);
    expect(r.y + r.h / 2).toBeCloseTo(200, 6);
    // 70.7% of the bounding box on each axis, against the ~95% the current
    // 8%-capped-at-14px inset leaves.
    const bb = shapeBounds(shape);
    expect(r.w / bb.w).toBeCloseTo(1 / Math.SQRT2, 6);
  });

  it('puts the corners of that rectangle exactly on the curve', () => {
    const shape = { kind: 'ellipse', cx: 0, cy: 0, rx: 90, ry: 40 };
    const r = inscribedRect(shape, { inset: 0 });
    const cornerX = r.x + r.w;
    const cornerY = r.y + r.h;
    expect((cornerX / 90) ** 2 + (cornerY / 40) ** 2).toBeCloseTo(1, 6);
  });

  it('is the rectangle itself, inset, for a rect', () => {
    const r = inscribedRect({ kind: 'rect', x: 10, y: 20, w: 200, h: 100 });
    const inset = safetyInset({ kind: 'rect', x: 10, y: 20, w: 200, h: 100 });
    expect(r).toEqual({ x: 10 + inset, y: 20 + inset, w: 200 - 2 * inset, h: 100 - 2 * inset });
  });

  it('never returns a negative extent for a shape smaller than its own inset', () => {
    const r = inscribedRect({ kind: 'rect', x: 0, y: 0, w: 4, h: 4 });
    expect(r.w).toBe(0);
    expect(r.h).toBe(0);
  });
});

describe('interiorLineWidths - the width each line actually has', () => {
  const ell = { kind: 'ellipse', cx: 200, cy: 150, rx: 120, ry: 80 };

  it('degenerates to today for a rectangle: one width, repeated', () => {
    const rect = { kind: 'rect', x: 40, y: 60, w: 300, h: 120 };
    const inset = safetyInset(rect);
    for (const valign of ['top', 'middle', 'bottom']) {
      expect(interiorLineWidths(rect, 30, 4, valign)).toEqual(new Array(4).fill(300 - 2 * inset));
    }
    // ...and it is the same number for any line count, which is what makes the
    // breaker's search identical to the one it runs today.
    expect(interiorLineWidths(rect, 12, 1)[0]).toBe(300 - 2 * inset);
    expect(interiorLineWidths(rect, 12, 9)[8]).toBe(300 - 2 * inset);
  });

  it('gives the middle lines of an oval more room than the outer ones', () => {
    // Five lines of 26 are 130, inside the 134 the inset leaves of this oval's
    // height. (Five of 30 used to be asked here, which is a block taller than
    // the balloon - see the next test for what that gets now.)
    const w = interiorLineWidths(ell, 26, 5, 'middle');
    expect(w.length).toBe(5);
    expect(w[2]).toBeGreaterThan(w[0]);
    expect(w[2]).toBeGreaterThan(w[4]);
    expect(w[0]).toBeCloseTo(w[4], 6); // a centred block is symmetric
  });

  it('gives a block taller than the balloon its full width on every row', () => {
    // Inset, this oval is 214 wide and 134 tall. Four lines of 30 fit and are
    // shaped; a fifth makes a block of 150, which no row-by-row width can put
    // inside the balloon, and it comes back as the plain rectangle the balloon's
    // widest row allows - never the one-pixel rows past the curve that a breaker
    // fills one word at a time.
    const inset = safetyInset(ell);
    const widest = 2 * (ell.rx - inset);
    const fits = interiorLineWidths(ell, 30, 4, 'middle');
    expect(fits[0]).toBeLessThan(fits[1]);
    expect(fits.every((v) => v < widest)).toBe(true);
    for (const valign of ['top', 'middle', 'bottom']) {
      expect(interiorLineWidths(ell, 30, 5, valign)).toEqual(new Array(5).fill(widest));
      expect(interiorLineWidths(ell, 60, 12, valign)).toEqual(new Array(12).fill(widest));
    }
    // Exactly as tall as the balloon still fits: the edge belongs to the shaped side.
    const exact = interiorLineWidths(ell, (2 * (ell.ry - inset)) / 4, 4, 'middle');
    expect(exact[1]).toBeLessThan(widest);
  });

  it('takes the narrowest width across each line band, not the width at its centre', () => {
    // This is the whole point of the band: the top line's capitals live at the
    // top of its band, where the balloon is narrower than it is at the baseline.
    const lh = 40;
    const w = interiorLineWidths(ell, lh, 3, 'middle', { inset: 0 });
    const centreWidth = (y) => 2 * ell.rx * Math.sqrt(Math.max(0, 1 - ((y - ell.cy) / ell.ry) ** 2));
    const topBandCentre = ell.cy - lh; // centre line of the first of three bands
    expect(w[0]).toBeLessThan(centreWidth(topBandCentre));
    // ...and it is exactly the width at the far edge of that band.
    expect(w[0]).toBeCloseTo(centreWidth(ell.cy - 1.5 * lh), 6);
  });

  it('anchors the block by valign', () => {
    const top = interiorLineWidths(ell, 30, 3, 'top');
    const bottom = interiorLineWidths(ell, 30, 3, 'bottom');
    const middle = interiorLineWidths(ell, 30, 3, 'middle');
    // Top-aligned, the first line sits at the very top of the oval and is the
    // narrowest of the three; bottom-aligned it is the mirror image.
    expect(top[0]).toBeLessThan(top[2]);
    expect(bottom[2]).toBeLessThan(bottom[0]);
    expect([...top].reverse()).toEqual(bottom);
    expect(middle[0]).toBeGreaterThan(top[0]);
  });

  it('agrees with the inscribed rectangle at its corners', () => {
    // A block filling the inscribed rectangle exactly: its outermost line's
    // width must be the rectangle's width, or the two halves of this module
    // would be sizing the box and breaking the text to different shapes.
    const r = inscribedRect(ell);
    const widths = interiorLineWidths(ell, r.h / 4, 4, 'middle');
    expect(widths[0]).toBeCloseTo(r.w, 6);
    expect(widths[3]).toBeCloseTo(r.w, 6);
    expect(widths[1]).toBeGreaterThan(r.w);
  });

  it('insets by the safety margin so text never touches the outline', () => {
    // Measured on the centre line (a band of no height), where the inset is the
    // whole of the difference. Off the centre line the curve takes back a little
    // more, which is the safe direction.
    const bare = interiorLineWidths(ell, 0, 1, 'middle', { inset: 0 });
    const safe = interiorLineWidths(ell, 0, 1, 'middle');
    expect(bare[0]).toBeCloseTo(2 * ell.rx, 6);
    expect(bare[0] - safe[0]).toBeCloseTo(2 * safetyInset(ell), 6);
    expect(interiorLineWidths(ell, 30, 3, 'middle')[1]).toBeLessThan(
      interiorLineWidths(ell, 30, 3, 'middle', { inset: 0 })[1]
    );
  });

  it('is pure, cheap and returns a fresh array every time', () => {
    const before = JSON.stringify(ell);
    const a = interiorLineWidths(ell, 22, 6, 'middle');
    const b = interiorLineWidths(ell, 22, 6, 'middle');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(JSON.stringify(ell)).toBe(before);
    // The line-breaker calls this once per candidate line count inside its own
    // search, so it has to stay this cheap.
    const t0 = Date.now();
    for (let i = 0; i < 20000; i++) interiorLineWidths(ell, 22, 8, 'middle');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('never hands back a width a breaker cannot divide by', () => {
    // A block far taller than the balloon, and a balloon the inset eats whole:
    // whatever the geometry says, every width is positive and finite.
    expect(interiorLineWidths({ kind: 'ellipse', cx: 0, cy: 0, rx: 3, ry: 3 }, 10, 4)).toEqual(
      new Array(4).fill(BALLOON_DEFAULTS.minLineWidth),
    );
    const w = interiorLineWidths(ell, 60, 12, 'middle');
    expect(w.length).toBe(12);
    for (const v of w) expect(v).toBeGreaterThan(0);
    expect(w.every((v) => Number.isFinite(v))).toBe(true);
    const rect = { kind: 'rect', x: 40, y: 60, w: 300, h: 120 };
    expect(interiorLineWidths(ell, 30, 0)).toEqual([]);
    expect(interiorLineWidths(ell, 30, undefined)).toEqual([]);
    expect(interiorLineWidths(ell, 30, NaN)).toEqual([]);
    expect(interiorLineWidths(ell, 30, -5)).toEqual([]);
    expect(interiorLineWidths(rect, 30, undefined)).toEqual([]);
    expect(interiorLineWidths(null, 30, 3)).toEqual([]);
  });
});

describe('detectBalloon - the whole pipeline on a synthetic page', () => {
  it('turns a vertical Japanese column into the wide oval around it', () => {
    // The motivating case, end to end. The detected block is 20x150 - tall and
    // narrow, the shape the English emphatically does not want - and the balloon
    // around it is 260x160.
    const img = page(500, 500);
    drawEllipse(img, 250, 250, 130, 80);
    drawGlyphColumn(img, 240, 180, 20, 140);
    const fit = detectBalloon(img, [240, 180, 260, 320]);
    expect(fit.kind).toBe('ellipse');
    expect(fit.escaped).toBe(false);
    expect(fit.shape.cx).toBeCloseTo(250, -1);
    expect(fit.shape.cy).toBeCloseTo(250, -1);
    expect(fit.shape.rx).toBeGreaterThan(120);
    expect(fit.shape.rx).toBeLessThan(140);
    expect(fit.shape.ry).toBeGreaterThan(70);
    expect(fit.shape.ry).toBeLessThan(90);
    // And the box that comes out of it is wide and short where the detected
    // block was narrow and tall.
    const r = inscribedRect(fit.shape);
    expect(r.w).toBeGreaterThan(150);
    expect(r.w).toBeGreaterThan(r.h);
  });

  it('fits the body of a real balloon with a tail, and does not leak down it', () => {
    const withTail = page(600, 600);
    drawEllipse(withTail, 300, 300, 150, 95, {
      tail: { y0: 380, bx: 330, tipX: 390, tipY: 450, halfw: 20 },
    });
    drawGlyphColumn(withTail, 290, 220, 20, 160);
    const plain = page(600, 600);
    drawEllipse(plain, 300, 300, 150, 95);
    drawGlyphColumn(plain, 290, 220, 20, 160);

    const block = [290, 220, 310, 380];
    const region = fillInterior(withTail, block);
    // The tail is part of the balloon, so the fill runs down it - and stops.
    expect(region.escaped).toBe(false);
    expect(region.bounds.h).toBeGreaterThan(200);

    const fit = detectBalloon(withTail, block);
    const bare = detectBalloon(plain, block);
    expect(fit.kind).toBe('ellipse');
    expect(fit.shape.rx).toBeCloseTo(bare.shape.rx, 0);
    expect(fit.shape.ry).toBeCloseTo(bare.shape.ry, 0);
    expect(fit.shape.cy).toBeCloseTo(bare.shape.cy, 0);
    expect(fit.confidence).toBeGreaterThan(0.8);
  });

  it('refuses a thought cloud', () => {
    const img = page(600, 600);
    drawEllipse(img, 300, 300, 160, 110, { bumps: 11 });
    const fit = detectBalloon(img, [280, 250, 320, 350]);
    expect(fit.escaped).toBe(false);
    expect(fit.kind).toBe('irregular');
    expect(fit.shape).toBeNull();
  });

  it('recovers a narration box as a rectangle', () => {
    const img = page(400, 300);
    drawBox(img, 60, 60, 260, 120);
    drawGlyphColumn(img, 180, 80, 20, 80);
    const fit = detectBalloon(img, [180, 80, 200, 160]);
    expect(fit.kind).toBe('rect');
    expect(fit.shape.w).toBeCloseTo(260, -1);
    expect(fit.shape.h).toBeCloseTo(120, -1);
    expect(fit.confidence).toBeGreaterThan(0.8);
  });

  it('refuses a jagged SFX burst', () => {
    const img = page(400, 400);
    drawBurst(img, 200, 200, 120);
    const fit = detectBalloon(img, [170, 170, 230, 230]);
    expect(fit.kind).toBe('irregular');
    expect(fit.shape).toBeNull();
  });

  it('refuses a balloon whose outline leaks, and says why', () => {
    const img = page(500, 500);
    drawEllipse(img, 250, 250, 90, 60, { gap: { x: 330, y: 240, w: 24, h: 24 } });
    const fit = detectBalloon(img, [220, 220, 280, 280]);
    expect(fit.escaped).toBe(true);
    expect(fit.kind).toBe('irregular');
    expect(fit.reason).toBe('escaped');
  });

  it('reports rather than throws when there is nothing to fill', () => {
    const fit = detectBalloon(page(10, 10), [50, 50, 60, 60]);
    expect(fit.kind).toBe('irregular');
    expect(fit.reason).toBe('no-fill');
    expect(fit.shape).toBeNull();
  });
});

// ===========================================================================
// The click-point pipeline
// ===========================================================================
// Everything above starts from a detected block. This is the other door into
// the same machinery, and it is the one paste-mode placement uses: the user has
// a translation in the queue, the page was never analysed, and the whole gesture
// is a point. What has to be true of it is the same thing that has to be true of
// the block-seeded path - a shape when there is a balloon, nothing at all when
// there is not - plus the cheap test that decides which of the two it is looking
// at before it spends a flood fill finding out.

// Screentone: a regular dot lattice, which is the thing that most looks like a
// flat grey from a distance and is most emphatically not one up close. The probe
// has to see through it, because a click on toned art is a click on art.
function drawTone(img, x, y, w, h, pitch = 4) {
  fillRect(img, x, y, w, h, PAPER);
  for (let yy = y; yy < y + h; yy += pitch) {
    for (let xx = x; xx < x + w; xx += pitch) {
      put(img, xx, yy, INK);
      put(img, xx + 1, yy, INK);
      put(img, xx, yy + 1, INK);
      put(img, xx + 1, yy + 1, INK);
    }
  }
}

describe('localUniformity: is the click on a solid colour', () => {
  it('says yes inside a balloon', () => {
    const img = page(400, 400);
    drawEllipse(img, 200, 200, 120, 80);
    const u = localUniformity(img, 200, 200);
    expect(u.uniform).toBe(true);
    expect(u.median).toBe(PAPER);
    expect(u.spread).toBe(0);
    expect(u.frac).toBe(1);
  });

  it('says no on screentone, however flat it averages out to', () => {
    const img = page(400, 400);
    drawTone(img, 100, 100, 200, 200);
    expect(localUniformity(img, 200, 200).uniform).toBe(false);
  });

  it('says no on a solid BLACK region, which is uniform and is not a balloon', () => {
    const img = page(400, 400);
    fillRect(img, 100, 100, 200, 200, INK);
    const u = localUniformity(img, 200, 200);
    expect(u.spread).toBe(0); // perfectly uniform...
    expect(u.uniform).toBe(false); // ...and refused anyway, because it is ink
  });

  it('says no on the edge between two flats', () => {
    const img = page(400, 400);
    fillRect(img, 200, 0, 200, 400, INK);
    expect(localUniformity(img, 200, 200).uniform).toBe(false);
  });

  it('tolerates the noise of a real scan', () => {
    const img = page(400, 400);
    drawEllipse(img, 200, 200, 120, 80);
    // +/- 6 levels of paper grain, which is more than a clean scan carries.
    for (let y = 180; y < 220; y++) {
      for (let x = 180; x < 220; x++) put(img, x, y, PAPER - ((x * 7 + y * 3) % 7));
    }
    expect(localUniformity(img, 200, 200).uniform).toBe(true);
  });

  it('answers null rather than throwing off the page or with no pixels', () => {
    const img = page(40, 40);
    expect(localUniformity(img, -1, 20)).toBeNull();
    expect(localUniformity(img, 20, 40)).toBeNull();
    expect(localUniformity(null, 20, 20)).toBeNull();
    expect(localUniformity(img, NaN, 20)).toBeNull();
  });
});

describe('fillFromPoint: the flood fill, seeded by a click', () => {
  it('recovers the whole interior of a balloon from one point inside it', () => {
    const img = page(500, 400);
    drawEllipse(img, 250, 200, 140, 90);
    const r = fillFromPoint(img, 250, 200);
    expect(r).not.toBeNull();
    expect(r.escaped).toBe(false);
    // The area of the ellipse, to within the outline's own thickness.
    expect(r.count).toBeGreaterThan(0.9 * Math.PI * 140 * 90);
    expect(r.bounds.w).toBeCloseTo(280, -1);
    expect(r.bounds.h).toBeCloseTo(180, -1);
  });

  it('finds the same region from anywhere inside the same balloon', () => {
    const img = page(500, 400);
    drawEllipse(img, 250, 200, 140, 90);
    const a = fillFromPoint(img, 150, 200);
    const b = fillFromPoint(img, 250, 260);
    expect(a.count).toBe(b.count);
    expect(a.bounds).toEqual(b.bounds);
  });

  it('reaches the balloon from a click that landed on a glyph inside it', () => {
    const img = page(500, 400);
    drawEllipse(img, 250, 200, 140, 90);
    fillRect(img, 244, 194, 12, 12, INK); // a speck the clean missed
    const r = fillFromPoint(img, 250, 200);
    expect(r).not.toBeNull();
    expect(r.escaped).toBe(false);
    expect(r.bounds.w).toBeCloseTo(280, -1);
  });

  it('reports the escape when the click is on bare paper', () => {
    const img = page(500, 400);
    drawEllipse(img, 250, 200, 60, 40);
    const r = fillFromPoint(img, 40, 40);
    expect(r.escaped).toBe(true);
  });

  it('answers null on ink with no way out, and off the page', () => {
    const img = page(200, 200);
    fillRect(img, 0, 0, 200, 200, INK);
    expect(fillFromPoint(img, 100, 100)).toBeNull();
    expect(fillFromPoint(page(200, 200), 500, 500)).toBeNull();
    expect(fillFromPoint(null, 10, 10)).toBeNull();
  });

  it('refuses a pocket too small to be a balloon', () => {
    const img = page(200, 200, INK);
    fillRect(img, 96, 96, 8, 8, PAPER); // 64px, under `minPointArea`
    expect(fillFromPoint(img, 100, 100)).toBeNull();
  });
});

describe('detectBalloonAt: the whole thing, from a click', () => {
  it('fits the oval a click landed in', () => {
    const img = page(500, 400);
    drawEllipse(img, 250, 200, 140, 90);
    const fit = detectBalloonAt(img, 250, 200);
    expect(fit.kind).toBe('ellipse');
    expect(fit.uniform).toBe(true);
    expect(fit.shape.cx).toBeCloseTo(250, -1);
    expect(fit.shape.cy).toBeCloseTo(200, -1);
    expect(fit.shape.rx).toBeCloseTo(140, -1);
    expect(fit.shape.ry).toBeCloseTo(90, -1);
    expect(fit.confidence).toBeGreaterThan(0.8);
  });

  it('answers the same shape a detected block would have produced', () => {
    const img = page(500, 400);
    drawEllipse(img, 250, 200, 140, 90);
    drawGlyphColumn(img, 240, 150, 20, 100);
    const byBlock = detectBalloon(img, [240, 150, 260, 250]);
    const byClick = detectBalloonAt(img, 200, 200); // clear of the column
    expect(byClick.kind).toBe(byBlock.kind);
    expect(byClick.shape.rx).toBeCloseTo(byBlock.shape.rx, 0);
    expect(byClick.shape.ry).toBeCloseTo(byBlock.shape.ry, 0);
  });

  it('fits a narration box as a rectangle', () => {
    const img = page(400, 300);
    drawBox(img, 60, 60, 260, 120);
    const fit = detectBalloonAt(img, 190, 120);
    expect(fit.kind).toBe('rect');
    expect(fit.shape.w).toBeCloseTo(260, -1);
    expect(fit.shape.h).toBeCloseTo(120, -1);
  });

  it('refuses a click on art before it spends a flood fill on it', () => {
    const img = page(400, 400);
    drawTone(img, 0, 0, 400, 400);
    const fit = detectBalloonAt(img, 200, 200);
    expect(fit.reason).toBe('not-solid');
    expect(fit.uniform).toBe(false);
    expect(fit.shape).toBeNull();
  });

  it('refuses a click on bare paper, because the fill gets out', () => {
    const img = page(500, 400);
    drawEllipse(img, 250, 200, 60, 40);
    const fit = detectBalloonAt(img, 40, 40);
    expect(fit.escaped).toBe(true);
    expect(fit.shape).toBeNull();
  });

  it('refuses a burst, which is solid inside and not a shape', () => {
    const img = page(400, 400);
    drawBurst(img, 200, 200, 120);
    const fit = detectBalloonAt(img, 200, 200);
    expect(fit.kind).toBe('irregular');
    expect(fit.shape).toBeNull();
  });

  it('reports rather than throws with no pixels at all', () => {
    const fit = detectBalloonAt(null, 10, 10);
    expect(fit.reason).toBe('no-pixels');
    expect(fit.shape).toBeNull();
  });
});

describe('shapeContainsPoint', () => {
  const ell = { kind: 'ellipse', cx: 100, cy: 100, rx: 50, ry: 20 };
  const rect = { kind: 'rect', x: 10, y: 20, w: 100, h: 40 };

  it('holds the centre and the four extremes of an ellipse', () => {
    for (const [x, y] of [[100, 100], [50, 100], [150, 100], [100, 80], [100, 120]])
      expect(shapeContainsPoint(ell, x, y)).toBe(true);
  });

  it('excludes the corners of an ellipse s bounding box', () => {
    expect(shapeContainsPoint(ell, 50, 80)).toBe(false);
    expect(shapeContainsPoint(ell, 150, 120)).toBe(false);
  });

  it('holds a rect s own area and nothing outside it', () => {
    expect(shapeContainsPoint(rect, 10, 20)).toBe(true);
    expect(shapeContainsPoint(rect, 110, 60)).toBe(true);
    expect(shapeContainsPoint(rect, 9, 40)).toBe(false);
    expect(shapeContainsPoint(rect, 60, 61)).toBe(false);
  });

  it('is false rather than throwing on nothing', () => {
    expect(shapeContainsPoint(null, 1, 1)).toBe(false);
    expect(shapeContainsPoint(ell, NaN, 1)).toBe(false);
    expect(shapeContainsPoint({ kind: 'ellipse', cx: 0, cy: 0, rx: 0, ry: 0 }, 0, 0)).toBe(false);
  });
});

// ===========================================================================
// Colour, transparency, and the scale of the page
// ===========================================================================
// Everything above is drawn in greyscale on a page of a few hundred pixels,
// which is the manga this module was written for and is not all of it. Three
// assumptions were baked into the numbers and none of them holds generally: that
// a balloon's interior is LIGHT in the Rec. 601 sense, that a pixel is either
// opaque or gone, and that a page is small enough for a 400-pixel window to
// cross any bubble on it. A colour release, a PSD with a semi-transparent
// overlay and a splash page break them one each.

// Ink of any colour. `put` above writes greys, which is all a scan needs.
const putRGB = (img, x, y, [r, g, b], a = 255) => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = a;
};

// A balloon whose interior is a flat colour rather than paper - the shout
// bubble of a colour release, or any webtoon panel at all. Drawn as one closed
// figure, exactly as `drawEllipse` is, so the outline contains the interior at
// every angle.
function drawColourEllipse(img, cx, cy, rx, ry, rgb, ring = 3) {
  const r = (x, y, g) => Math.hypot((x + 0.5 - cx) / (rx + g), (y + 0.5 - cy) / (ry + g));
  for (let y = Math.floor(cy - ry - ring - 2); y <= Math.ceil(cy + ry + ring + 2); y++) {
    for (let x = Math.floor(cx - rx - ring - 2); x <= Math.ceil(cx + rx + ring + 2); x++) {
      if (r(x, y, 0) <= 1) putRGB(img, x, y, rgb);
      else if (r(x, y, ring) <= 1) put(img, x, y, INK);
    }
  }
}

describe('a coloured balloon is a balloon', () => {
  // Rec. 601 weights green at 150/256 and blue at 29/256, so a saturated red
  // reads 76 and a saturated blue 29 - both under the 64 floor beneath the fill's
  // own threshold, which is to say: ink. Neither is ink, and a reader looking at
  // either one sees a bubble with room in it for a line of English.
  const SHOUT_RED = [230, 40, 40];
  const NIGHT_BLUE = [40, 60, 220];

  const colourPage = (rgb) => {
    const img = page(400, 400, 200); // a mid-grey page, the way coloured art is
    drawColourEllipse(img, 200, 200, 120, 80, rgb);
    return img;
  };

  it('reads a saturated interior as solid colour rather than as ink', () => {
    for (const rgb of [SHOUT_RED, NIGHT_BLUE]) {
      const u = localUniformity(colourPage(rgb), 200, 200);
      expect(u.spread).toBe(0);
      expect(u.uniform).toBe(true);
    }
  });

  it('fits the oval a click landed in, whatever colour it is painted', () => {
    for (const rgb of [SHOUT_RED, NIGHT_BLUE]) {
      const fit = detectBalloonAt(colourPage(rgb), 200, 200);
      expect(fit.kind).toBe('ellipse');
      expect(fit.escaped).toBe(false);
      expect(fit.shape.rx).toBeCloseTo(120, -1);
      expect(fit.shape.ry).toBeCloseTo(80, -1);
    }
  });

  // The interesting half, and the one the probe gate used to lose: a coloured
  // balloon on WHITE paper is three modes in the histogram, not two, and the
  // most separable split of three modes puts the interior in with the outline.
  // The click is what settles it - the user pointed inside the bubble, so the
  // luminance there is interior whatever the histogram would rather believe.
  it('fits a coloured balloon sitting on white paper, where the histogram has three modes', () => {
    const img = page(500, 500);
    drawColourEllipse(img, 250, 250, 110, 70, SHOUT_RED);
    const fit = detectBalloonAt(img, 250, 250);
    expect(fit.kind).toBe('ellipse');
    expect(fit.escaped).toBe(false);
    expect(fit.shape.rx).toBeCloseTo(110, -1);
    // ...and the fill stopped at the outline rather than pouring out onto the
    // page, which is what the threshold correction has to leave true.
    expect(fit.shape.cx).toBeCloseTo(250, 0);
  });

  // The other half of the gate, unchanged: a flat dark region is uniform, is not
  // a balloon, and is still refused before a fill is spent on it. Lowering the
  // light gate to meet the fill's own floor must not have cost this.
  it('still refuses a flat dark region, which is uniform and is not a balloon', () => {
    for (const rgb of [[0, 0, 0], [16, 20, 48], [40, 10, 10]]) {
      const img = page(400, 400);
      for (let y = 100; y < 300; y++) for (let x = 100; x < 300; x++) putRGB(img, x, y, rgb);
      const u = localUniformity(img, 200, 200);
      expect(u.spread).toBe(0);
      expect(u.uniform).toBe(false);
      expect(detectBalloonAt(img, 200, 200).reason).toBe('not-solid');
    }
  });
});

describe('alpha is a fraction, not a switch', () => {
  // A page with alpha is a PSD-derived raster, and the parts of it that are not
  // fully opaque are not fully art either. Treated as a switch at 128 - which is
  // what this did - a half-transparent overlay counted as solid paper at its
  // full colour, biased the threshold that every other decision here is taken
  // against, and let the fill spread through a band the art does not cover.
  it('darkens a half-transparent pixel instead of taking it at face value', () => {
    const img = page(300, 300);
    drawEllipse(img, 150, 150, 80, 50);
    for (let y = 140; y < 160; y++)
      for (let x = 70; x < 230; x++) img.data[(y * 300 + x) * 4 + 3] = 128;
    // Paper at half alpha is 124, which is under the cut this window's own
    // pixels choose - so the fill stops at the band exactly as it stops at one
    // that is fully transparent.
    const region = fillInterior(img, [140, 100, 160, 135]);
    expect(region.bounds.y + region.bounds.h).toBeLessThanOrEqual(141);
  });

  it('scales smoothly rather than stepping at 128', () => {
    // Two bands either side of the old cliff. Under the old rule 129 was fully
    // opaque paper and 127 was ink; under this one they are a level apart and
    // both dark, which is the answer that does not depend on where the step was.
    const bandAt = (alpha) => {
      const img = page(300, 300);
      drawEllipse(img, 150, 150, 80, 50);
      for (let y = 140; y < 160; y++)
        for (let x = 70; x < 230; x++) img.data[(y * 300 + x) * 4 + 3] = alpha;
      return fillInterior(img, [140, 100, 160, 135]);
    };
    expect(bandAt(127).bounds.h).toBe(bandAt(129).bounds.h);
  });
});

describe('the window is sized in pages, not in pixels', () => {
  // `pointWindow` is 360, which is a statement about a paperback-scale page. On
  // a splash page or a webtoon column the same balloon is simply bigger, the
  // window ends inside it, the fill reaches the border and every large bubble on
  // the page reads as a leak. The floor is a fraction of the page's shorter side
  // for exactly that reason.
  it('crosses a balloon too big for the absolute window', () => {
    const img = page(1600, 1600);
    drawEllipse(img, 800, 800, 380, 260);
    const fit = detectBalloonAt(img, 800, 800);
    expect(fit.escaped).toBe(false);
    expect(fit.kind).toBe('ellipse');
    expect(fit.shape.rx).toBeCloseTo(380, -1);
    // And the same balloon with the scaling switched off is the failure this
    // fixes: 360 either side of the click cannot reach a wall 380 away.
    const cramped = detectBalloonAt(img, 800, 800, { pointWindowFrac: 0 });
    expect(cramped.escaped).toBe(true);
    expect(cramped.shape).toBeNull();
  });

  // The block-seeded window has the same cap on it, and it binds the same way:
  // a block sitting loosely inside a large balloon pads out to 400 and stops.
  it('scales the block-seeded window with the page as well', () => {
    // A splash-scale page: a 240px column of Japanese wants 480px of margin
    // either side of it, and the balloon's wall is 440 away - inside what the
    // margin asks for and outside the flat 400 it used to be given.
    const img = page(2400, 2400);
    drawEllipse(img, 1200, 1200, 450, 380);
    drawGlyphColumn(img, 1190, 1080, 20, 240);
    const block = [1190, 1080, 1210, 1320];
    const fit = detectBalloon(img, block);
    expect(fit.escaped).toBe(false);
    expect(fit.kind).toBe('ellipse');
    expect(fit.shape.rx).toBeCloseTo(450, -1);
    // Capped at 400 the window ends INSIDE the bubble, and a fill that fills its
    // whole window is indistinguishable from one that got out.
    expect(detectBalloon(img, block, { windowMaxFrac: 0 }).escaped).toBe(true);
  });
});

describe('a balloon the page is cut off at has not escaped', () => {
  // The window is clipped to the image, so on anything near the edge of the page
  // the window's border and the page's border are the same pixels - and a fill
  // that reaches them was being read as a leak although there is nothing beyond
  // them to leak into. A panel that bleeds off the page, the top bubble of a
  // webtoon slice and anything on a tightly cropped page all landed there.
  it('fits a narration box the page crops', () => {
    const img = page(400, 300);
    drawBox(img, 60, -20, 200, 120); // the top of the box is off the page
    const region = fillFromPoint(img, 160, 40);
    expect(region.escaped).toBe(false);
    expect(region.bounds.y).toBe(0);
    const fit = detectBalloonAt(img, 160, 40);
    expect(fit.kind).toBe('rect');
    expect(fit.shape.w).toBeCloseTo(200, -1);
  });

  // ...and the exemption stops precisely where it would swallow the case the
  // flag exists for. A region touching the page on two OPPOSITE sides spans the
  // paper end to end, which is not a cropped balloon, it is the paper - and on a
  // page smaller than the search window that is the only thing left to tell the
  // two apart.
  it('still reports the escape when the fill spans the page edge to edge', () => {
    const img = page(400, 300);
    drawEllipse(img, 200, 150, 50, 35);
    const region = fillFromPoint(img, 20, 20); // bare paper, outside the balloon
    expect(region.escaped).toBe(true);
    expect(detectBalloonAt(img, 20, 20).shape).toBeNull();
  });
});

describe('fitBalloonShape counts the holes itself when the profile does not', () => {
  // `holes` is carried on the profile because `interiorProfile` has already
  // walked the rows and knows. A profile from anywhere else - a hand-built
  // fixture, a union of fills, a future caller - may not carry it, and a missing
  // count must not read as "no holes": a region that is not vertically connected
  // is not one balloon whoever built it.
  it('refuses a disconnected region with no count on it', () => {
    const p = rectProfile(0, 0, 50, 40);
    for (const i of [5, 12, 19, 26, 33]) p.rows[i] = null;
    for (const holes of [undefined, NaN, null, 'lots']) {
      expect(fitBalloonShape({ ...p, holes }).reason).toBe('holes');
    }
  });

  it('fits a sound one just the same', () => {
    expect(fitBalloonShape({ ...rectProfile(0, 0, 50, 40), holes: undefined }).kind).toBe('rect');
  });
});

// ---------------------------------------------------------------------------
// GEO-5: a body no formula matches is kept as its rows
// ---------------------------------------------------------------------------
// An oval leaning 30 degrees, as pixel runs straight from the geometry.
function tiltedProfile(cx, cy, a, b, deg) {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const A = (c * c) / (a * a) + (s * s) / (b * b);
  const rows = [];
  let y0 = null;
  for (let y = Math.floor(cy - a - b); y <= cy + a + b; y++) {
    const v = y + 0.5 - cy;
    const B = 2 * v * c * s * (1 / (a * a) - 1 / (b * b));
    const C = (v * s) ** 2 / (a * a) + (v * c) ** 2 / (b * b) - 1;
    const D = B * B - 4 * A * C;
    const l = D < 0 ? 0 : Math.round(cx + (-B - Math.sqrt(D)) / (2 * A));
    const r = D < 0 ? -1 : Math.round(cx + (-B + Math.sqrt(D)) / (2 * A)) - 1;
    if (r < l) {
      if (y0 !== null) break;
      continue;
    }
    if (y0 === null) y0 = y;
    rows.push([l, r]);
  }
  return { y: y0, rows, holes: 0, escaped: false };
}

// An upright oval whose outline wobbles by `amp` of its half-width.
function wobblyProfile(y, cx, cy, rx, ry, amp) {
  const rows = [];
  for (let yy = y; yy < cy + ry; yy++) {
    const dy = (yy + 0.5 - cy) / ry;
    if (Math.abs(dy) > 1) continue;
    const hw = rx * Math.sqrt(1 - dy * dy) * (1 + amp * Math.sin(yy * 0.25));
    rows.push([Math.round(cx - hw), Math.round(cx + hw) - 1]);
  }
  return { y: Math.ceil(cy - ry), rows, holes: 0, escaped: false };
}

// Every stored band against the rows it stands for: never wider than any of
// them, and at most `tol` narrower than the narrowest.
function bandMisses(fit, profile) {
  let worst = 0;
  fit.spans.forEach((sp, i) => {
    if (!sp) return;
    let l = -Infinity;
    let r = Infinity;
    for (let y = fit.y0 + i * fit.step; y < fit.y0 + (i + 1) * fit.step; y++) {
      const run = profile.rows[y - profile.y];
      l = Math.max(l, run[0]);
      r = Math.min(r, run[1] + 1);
    }
    expect(sp[0]).toBeGreaterThanOrEqual(l);
    expect(sp[1]).toBeLessThanOrEqual(r);
    worst = Math.max(worst, sp[0] - l, r - sp[1]);
  });
  return worst;
}

// An oval leaning `deg`, drawn the way `drawEllipse` draws an upright one.
function drawTiltedEllipse(img, cx, cy, rx, ry, deg, ring = 3) {
  const t = (deg * Math.PI) / 180;
  const radius = (x, y, g) => {
    const dx = x + 0.5 - cx;
    const dy = y + 0.5 - cy;
    const u = dx * Math.cos(t) + dy * Math.sin(t);
    const v = -dx * Math.sin(t) + dy * Math.cos(t);
    return Math.hypot(u / (rx + g), v / (ry + g));
  };
  const e = rx + ring + 2;
  for (let y = Math.floor(cy - e); y <= Math.ceil(cy + e); y++) {
    for (let x = Math.floor(cx - e); x <= Math.ceil(cx + e); x++) {
      if (radius(x, y, 0) <= 1) put(img, x, y, PAPER);
      else if (radius(x, y, ring) <= 1) put(img, x, y, INK);
    }
  }
}

describe('fitBalloonShape - a body no formula matches is kept as its rows (GEO-5)', () => {
  it('keeps a tilted oval as the rows it has, which no upright oval matches', () => {
    const profile = tiltedProfile(300, 300, 90, 60, 30);
    const fit = fitBalloonShape(profile);
    expect(fit.kind).toBe('rows');
    expect(fit.shape.kind).toBe('rows');
    expect(fit.confidence).toBeGreaterThan(0.9);
    expect(bandMisses(fit.shape, profile)).toBeLessThanOrEqual(1);
    // All of the body, in a few hundred bytes.
    const b = shapeBounds(fit.shape);
    expect(b.h).toBeGreaterThan(profile.rows.length - 2 * fit.shape.step);
    expect(fit.shape.spans.length).toBeLessThanOrEqual(BALLOON_DEFAULTS.rowsMaxBands);
    expect(JSON.stringify(fit.shape).length).toBeLessThan(1500);
    // ...and it is the plain JSON the schema stores: through a save and back it
    // is the same fit.
    expect(normalizeFit(JSON.parse(JSON.stringify(fit.shape)))).toEqual(fit.shape);
    // The same bubble standing upright keeps its five numbers.
    expect(fitBalloonShape(tiltedProfile(300, 300, 90, 60, 0)).kind).toBe('ellipse');
  });

  it('keeps a wobbly oval the gate accepts as its rows, and a clean one as an oval', () => {
    const profile = wobblyProfile(100, 250, 160, 90, 60, 0.08);
    const fit = fitBalloonShape(profile);
    expect(fit.kind).toBe('rows');
    // The bulges past the fitted body are cut back to it; the rest is the row.
    expect(bandMisses(fit.shape, profile)).toBeLessThanOrEqual(0.1 * 90);
    expect(fitBalloonShape(wobblyProfile(100, 250, 160, 90, 60, 0.02)).kind).toBe('ellipse');
  });

  it('recovers a tilted balloon from the pixels, inside its outline', () => {
    const img = page(600, 600);
    drawTiltedEllipse(img, 300, 300, 110, 65, 25);
    drawGlyphColumn(img, 290, 250, 20, 100);
    const fit = detectBalloon(img, [290, 250, 310, 350]);
    expect(fit.escaped).toBe(false);
    expect(fit.kind).toBe('rows');
    expect(fit.confidence).toBeGreaterThan(0.8);
    const t = (25 * Math.PI) / 180;
    const inside = (x, y) => {
      const u = (x - 300) * Math.cos(t) + (y - 300) * Math.sin(t);
      const v = -(x - 300) * Math.sin(t) + (y - 300) * Math.cos(t);
      return (u / 110) ** 2 + (v / 65) ** 2 <= 1.001;
    };
    const { y0, step, spans } = fit.shape;
    spans.forEach((sp, i) => {
      if (!sp) return;
      for (const y of [y0 + i * step, y0 + (i + 1) * step]) {
        expect(inside(sp[0], y) || inside(sp[0], y0 + (i + 0.5) * step)).toBe(true);
        expect(inside(sp[1], y) || inside(sp[1], y0 + (i + 0.5) * step)).toBe(true);
      }
    });
    expect(shapeContainsPoint(fit.shape, 300, 300)).toBe(true);
    expect(shapeContainsPoint(fit.shape, 300, 240)).toBe(true);
    expect(shapeContainsPoint(fit.shape, 200, 240)).toBe(false);
  });

  it('still refuses what it refused: a cloud, a burst, a jagged profile', () => {
    const cloud = page(600, 600);
    drawEllipse(cloud, 300, 300, 160, 110, { bumps: 11 });
    expect(detectBalloon(cloud, [280, 250, 320, 350]).kind).toBe('irregular');
    const burst = page(400, 400);
    drawBurst(burst, 200, 200, 120);
    expect(detectBalloon(burst, [170, 170, 230, 230]).kind).toBe('irregular');
  });
});

describe('layout inside a rows fit', () => {
  // An upright oval written out as rows, one band per row, and the oval itself:
  // the two have to lay text out the same way, to within the rounding of a band
  // and the square margin rows get.
  const oval = { kind: 'ellipse', cx: 250, cy: 200, rx: 120, ry: 80 };
  const asRows = (step) => {
    const spans = [];
    for (let y = 120; y < 280; y += step) {
      let l = -Infinity;
      let r = Infinity;
      for (let yy = y; yy < y + step; yy++) {
        const dy = Math.min(1, Math.abs(yy + 0.5 - 200) / 80);
        const hw = 120 * Math.sqrt(1 - dy * dy);
        l = Math.max(l, Math.ceil(250 - hw));
        r = Math.min(r, Math.floor(250 + hw));
      }
      spans.push(r > l ? [l, r] : null);
    }
    return { kind: 'rows', y0: 120, step, spans };
  };

  // One-row bands are the oval to a few pixels. Coarser bands give up some room
  // on the outer lines and never gain any.
  it('answers what the oval answers, band by band', () => {
    for (const [step, slack] of [[1, 5], [3, 20]]) {
      const rows = asRows(step);
      expect(safetyInset(rows)).toBe(safetyInset(oval));
      for (const n of [2, 4, 6]) {
        const want = interiorLineWidths(oval, 24, n, 'middle');
        const got = interiorLineWidths(rows, 24, n, 'middle');
        got.forEach((w, i) => {
          expect(w).toBeLessThanOrEqual(want[i]);
          expect(w).toBeGreaterThan(want[i] - slack);
        });
      }
      const f = balloonFrame(rows);
      const fo = balloonFrame(oval);
      expect(f.x + f.w / 2).toBeCloseTo(250, 0);
      expect(f.w).toBeLessThanOrEqual(fo.w);
      expect(f.w).toBeGreaterThan(fo.w - 5);
      expect(Math.abs(f.h - fo.h)).toBeLessThanOrEqual(3 * step + 6);
      const ins = inscribedRect(rows);
      const io = inscribedRect(oval);
      expect(ins.w * ins.h).toBeGreaterThan(0.9 * io.w * io.h);
      if (step === 1) expect(shapeBounds(rows)).toEqual({ x: 131, y: 120, w: 238, h: 160 });
    }
  });

  it('gives a rectangle of rows one width, and a block too tall for it the widest', () => {
    const rows = { kind: 'rows', y0: 50, step: 2, spans: Array.from({ length: 40 }, () => [100, 300]) };
    const inset = safetyInset(rows);
    expect(interiorLineWidths(rows, 20, 3, 'top')).toEqual([200 - 2 * inset, 200 - 2 * inset, 200 - 2 * inset]);
    expect(interiorLineWidths(rows, 20, 9, 'middle')).toEqual(new Array(9).fill(200 - 2 * inset));
  });

  // The rows of a leaning oval are centred on one axis, and a centred line has
  // only the room that straddles it: every line, at the width it is given, lies
  // inside every band it crosses, less the margin.
  it('keeps a centred line inside every band it crosses, on a tilted oval', () => {
    const profile = tiltedProfile(300, 300, 90, 60, 30);
    const fit = fitBalloonShape(profile).shape;
    const inset = safetyInset(fit);
    const frame = balloonFrame(fit);
    const axis = frame.x + frame.w / 2;
    expect(axis).toBeCloseTo(300, -1);
    // Three lines of 22 about the middle, and a little either way - all tops the
    // rows have room for, so none of them is clamped.
    for (const top of [267, 259, 275]) {
      const widths = interiorLineWidths(fit, 22, 3, 'top', { top });
      widths.forEach((w, i) => {
        for (let y = top + i * 22; y < top + (i + 1) * 22; y++) {
          const run = profile.rows[y - profile.y];
          expect(axis - w / 2).toBeGreaterThanOrEqual(run[0] + inset - 1e-6);
          expect(axis + w / 2).toBeLessThanOrEqual(run[1] + 1 - inset + 1e-6);
        }
      });
      if (top === 267) {
        expect(widths[1]).toBeGreaterThan(widths[0]);
        expect(widths[1]).toBeGreaterThan(widths[2]);
      }
    }
  });
});
