import { describe, it, expect } from 'vitest';
import { findOutline } from './bubble-outline.js';
import { shapeContainsPoint } from './balloon.js';

// Pages drawn by hand, the way balloon.test.js draws them: paper near white,
// ink near black, nothing else unless a test puts it there.
const PAPER = 248;
const INK = 18;

function page(w, h, fill = PAPER) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = fill;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}
const put = (img, x, y, v) => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
};
const fillRect = (img, x, y, w, h, v) => {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(img, xx, yy, v);
};
const gray = (img, x, y) => img.data[(y * img.width + x) * 4];

// An oval interior `fill` inside an outline `ring` px thick of colour `ink`,
// with an optional tail hanging from the bottom. Drawn as one closed shape.
function drawOval(img, cx, cy, rx, ry, { ring = 3, ink = INK, fill = PAPER, tail = null } = {}) {
  const r = (x, y, g) => Math.hypot((x + 0.5 - cx) / (rx + g), (y + 0.5 - cy) / (ry + g));
  const inTail = (x, y, g) => {
    if (!tail) return false;
    if (y + 0.5 < cy || y + 0.5 > tail.tipY + g) return false;
    const t = Math.min(1, (y + 0.5 - cy) / (tail.tipY - cy));
    return Math.abs(x + 0.5 - (cx + (tail.tipX - cx) * t)) <= tail.halfw * (1 - t) + g;
  };
  for (let y = Math.floor(cy - ry - ring - 2); y <= Math.ceil(Math.max(cy + ry, tail?.tipY ?? 0) + ring + 2); y++) {
    for (let x = Math.floor(cx - rx - ring - 2); x <= Math.ceil(cx + rx + ring + 2); x++) {
      if (r(x, y, 0) <= 1 || inTail(x, y, 0)) put(img, x, y, fill);
      else if (r(x, y, ring) <= 1 || inTail(x, y, ring)) put(img, x, y, ink);
    }
  }
}

// A column of glyph blocks with counters, so the block's centre is on ink.
function drawGlyphs(img, x, y, w, h, v = INK, bg = PAPER) {
  for (let gy = y; gy + 20 <= y + h; gy += 26) {
    fillRect(img, x, gy, w, 20, v);
    fillRect(img, x + 4, gy + 4, w - 8, 12, bg);
  }
}

const inside = (res, x, y) => shapeContainsPoint({ kind: 'poly', pts: res.pts }, x, y);
const bboxOf = (pts) => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

describe('findOutline - the bubble ladder', () => {
  it('traces a plain inked oval as a ring, close to the oval', () => {
    const img = page(600, 600);
    drawOval(img, 300, 300, 120, 80);
    drawGlyphs(img, 285, 250, 30, 100);
    const t0 = performance.now();
    const res = findOutline(img, [282, 248, 318, 352]);
    const ms = performance.now() - t0;
    console.log(`plain oval: ${ms.toFixed(1)} ms`);
    expect(res.open).toBeUndefined();
    expect(res.source).toBe('ring');
    expect(res.confidence).toBeGreaterThan(0.9);
    expect(res.pts.length).toBeGreaterThanOrEqual(3);
    expect(res.pts.length).toBeLessThanOrEqual(256);
    const b = bboxOf(res.pts);
    expect(b.x0).toBeGreaterThan(178);
    expect(b.x1).toBeLessThan(422);
    expect(b.x1 - b.x0).toBeGreaterThan(220);
    expect(b.y1 - b.y0).toBeGreaterThan(140);
    for (const [x, y] of [[300, 300], [285, 255], [315, 345]]) expect(inside(res, x, y)).toBe(true);
  });

  it('cuts a short tail off', () => {
    const img = page(600, 700);
    drawOval(img, 300, 300, 120, 80, { tail: { tipX: 330, tipY: 405, halfw: 16 } });
    drawGlyphs(img, 285, 250, 30, 100);
    const res = findOutline(img, [282, 248, 318, 352]);
    expect(res.open).toBeUndefined();
    expect(bboxOf(res.pts).y1).toBeLessThan(388);
  });

  it('cuts a long tail off, or refuses the bubble', () => {
    const img = page(600, 700);
    drawOval(img, 300, 300, 120, 80, { tail: { tipX: 360, tipY: 470, halfw: 14 } });
    drawGlyphs(img, 285, 250, 30, 100);
    const res = findOutline(img, [282, 248, 318, 352]);
    if (!res.open) expect(bboxOf(res.pts).y1).toBeLessThan(388);
  });

  it('refuses a spiky burst at the solidity test', () => {
    const img = page(600, 600);
    fillRect(img, 120, 120, 360, 360, INK);
    for (let y = 130; y < 470; y++) for (let x = 130; x < 470; x++) {
      const dx = x + 0.5 - 300;
      const dy = y + 0.5 - 300;
      if (Math.hypot(dx, dy) <= 160 * (0.45 + 0.55 * Math.abs(Math.cos(7 * Math.atan2(dy, dx))))) put(img, x, y, PAPER);
    }
    drawGlyphs(img, 285, 260, 30, 80);
    expect(findOutline(img, [282, 258, 318, 342]).open).toBe(true);
  });

  it('finds a grey anti-aliased outline', () => {
    const img = page(600, 600);
    drawOval(img, 300, 300, 120, 80, { ink: 200, ring: 2 });
    drawGlyphs(img, 285, 250, 30, 100);
    const res = findOutline(img, [282, 248, 318, 352]);
    expect(res.open).toBeUndefined();
    expect(bboxOf(res.pts).x1 - bboxOf(res.pts).x0).toBeGreaterThan(200);
  });

  it('finds a black bubble with white lettering', () => {
    const img = page(600, 600);
    drawOval(img, 300, 300, 120, 80, { fill: INK, ink: INK });
    drawGlyphs(img, 285, 250, 30, 100, PAPER, INK);
    const res = findOutline(img, [282, 248, 318, 352]);
    expect(res.open).toBeUndefined();
    expect(res.source).toBe('dark');
    expect(inside(res, 300, 300)).toBe(true);
  });

  it('reads a thin black frame as a caption rectangle', () => {
    const img = page(600, 600);
    fillRect(img, 150, 200, 300, 120, INK);
    fillRect(img, 152, 202, 296, 116, PAPER);
    fillRect(img, 200, 240, 200, 14, INK);
    fillRect(img, 200, 270, 160, 14, INK);
    const res = findOutline(img, [195, 235, 405, 290]);
    expect(res.source).toBe('caption');
    expect(res.pts).toHaveLength(4);
  });

  it('keeps out of a screentone background', () => {
    const img = page(600, 600);
    for (let y = 0; y < 600; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < 600; x += 4) put(img, x, y, 40);
    drawOval(img, 300, 300, 120, 80);
    drawGlyphs(img, 285, 250, 30, 100);
    const res = findOutline(img, [282, 248, 318, 352]);
    expect(res.open).toBeUndefined();
    const b = bboxOf(res.pts);
    expect(b.x0).toBeGreaterThan(170);
    expect(b.x1).toBeLessThan(430);
  });

  it('does not run out through a small gap in the outline', () => {
    const img = page(600, 600);
    drawOval(img, 300, 300, 120, 80);
    fillRect(img, 296, 216, 3, 8, PAPER);
    drawGlyphs(img, 285, 250, 30, 100);
    const res = findOutline(img, [282, 248, 318, 352]);
    if (!res.open) {
      const b = bboxOf(res.pts);
      expect(b.y0).toBeGreaterThan(200);
      expect(b.x1 - b.x0).toBeLessThan(260);
    }
  });

  it('answers open for free text on bare paper', () => {
    const img = page(600, 600);
    drawGlyphs(img, 285, 250, 30, 100);
    expect(findOutline(img, [282, 248, 318, 352]).open).toBe(true);
  });

  it('splits two joined bubbles between their texts', () => {
    const img = page(800, 600);
    drawOval(img, 300, 300, 120, 90);
    drawOval(img, 470, 300, 110, 85);
    // Clear the shared wall so the two interiors are one piece.
    for (let y = 230; y < 370; y++) for (let x = 370; x < 410; x++) {
      const a = Math.hypot((x + 0.5 - 300) / 120, (y + 0.5 - 300) / 90) <= 1;
      const b = Math.hypot((x + 0.5 - 470) / 110, (y + 0.5 - 300) / 85) <= 1;
      if (a || b) put(img, x, y, PAPER);
    }
    drawGlyphs(img, 285, 250, 30, 100);
    drawGlyphs(img, 455, 250, 30, 100);
    const left = [282, 248, 318, 352];
    const right = [452, 248, 488, 352];
    const a = findOutline(img, left, { neighbors: [right] });
    const b = findOutline(img, right, { neighbors: [left] });
    expect(a.open).toBeUndefined();
    expect(b.open).toBeUndefined();
    expect(a.split).toBe(true);
    expect(a.confidence).toBeLessThanOrEqual(0.85);
    expect(inside(a, 300, 300)).toBe(true);
    expect(inside(a, 470, 300)).toBe(false);
    expect(inside(b, 470, 300)).toBe(true);
    expect(inside(b, 300, 300)).toBe(false);
    expect(bboxOf(a.pts).x1).toBeLessThanOrEqual(bboxOf(b.pts).x0 + 2);
  });

  it('answers open on bad input instead of throwing', () => {
    expect(findOutline(null, [0, 0, 10, 10]).open).toBe(true);
    expect(findOutline(page(50, 50), null).open).toBe(true);
    expect(findOutline(page(50, 50), [10, 10, 10, 10]).open).toBe(true);
    expect(gray(page(4, 4), 0, 0)).toBe(PAPER);
  });
});
