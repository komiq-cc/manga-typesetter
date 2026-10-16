import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  warpPlan,
  warpBoxCanvas,
  expandTriangle,
  meshFolds,
  subdivisionFor,
  WARP_PAD,
  WARP_SUB,
  WARP_SUB_MAX,
  SEAM_OVERDRAW,
  MAX_DEVICE,
  MAX_DEVICE_AREA,
} from './warp-paint.js';
import {
  identityMesh,
  warpPoint,
  affineWarpPoint,
  solveHomography,
  applyHomography,
  affineFromTriangle,
} from './warp.js';
import { renderPageCanvas, paintWarpedBox } from './exporter.js';
import { loadProjectPages, app } from './store.svelte.js';
import { normalizeStyle } from './data.js';

// ===========================================================================
// A canvas that actually rasterises
// ===========================================================================
// The warp pass is only visible in pixels, and node has no canvas, so this is
// the smallest renderer the pass can be driven through: a transform stack, a
// clip stack, and a drawImage that SUPERSAMPLES its coverage. The
// supersampling is the point - a seam is an antialiasing artefact, two clipped
// triangles each covering half of the pixels along their shared edge and
// compositing to three quarters, and a renderer that snapped coverage to 0 or
// 1 could not show it at all.
//
// Colour is premultiplied float, which is what makes "is there a pinhole here"
// a question about one number.

const IDENT = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const mul = (m, n) => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});
const inv = (m) => {
  const det = m.a * m.d - m.b * m.c;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
};
const apply = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

// #rgb, #rrggbb and rgba() - everything the styles under test can produce.
function parseColor(css) {
  if (typeof css !== 'string') return [0, 0, 0, 1];
  const s = css.trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const n = h.length === 3 ? h.split('').map((c) => c + c) : h.match(/../g) ?? ['00', '00', '00'];
    return [parseInt(n[0], 16) / 255, parseInt(n[1], 16) / 255, parseInt(n[2], 16) / 255, 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return [0, 0, 0, 1];
  const p = m[1].split(',').map((v) => parseFloat(v));
  return [(p[0] ?? 0) / 255, (p[1] ?? 0) / 255, (p[2] ?? 0) / 255, p[3] ?? 1];
}

// How long a describe that actually rasterises is given. Vitest's default is
// 5000ms, and the four blocks below drive this file's software renderer over
// tens of thousands of device pixels: the slowest of them measures ~1.55s on an
// idle machine, down from ~2.6s before `paint` learnt to skip the supersampling
// in a pixel's interior and `drawImage` stopped allocating two arrays per
// sample.
//
// That is threefold headroom, and it was not enough. These tests were failing
// roughly one run in four on nothing but load, and measuring them next to a
// busy CPU shows why: the same 1.55s test takes 4-5.5s with the cores saturated,
// which is exactly the shape of a `vitest run` that has several files in flight
// alongside whatever else the machine is doing. Time on this renderer is
// dominated by arithmetic, so it stretches with contention rather than degrading
// gently.
//
// So the heavy blocks get room and the rest of the suite does not: a global bump
// would hide a genuine hang in the other 45 files, and this number is still
// finite, at about thirteen times the work actually being done.
const HEAVY_MS = 20_000;

// Pixel centres per axis inside one destination pixel. Sixteen samples is
// enough to see a half-covered pixel as a half and not as a quantisation step.
const SUB = 4;

function inPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Whether one whole device pixel lies inside a convex polygon.
//
// The four corners are enough, and only because the polygon is convex: they are
// the corners of the square every sample of that pixel sits strictly inside, so
// a convex polygon containing all four contains the square. Every polygon that
// reaches this - a rect, a fill's parallelogram, a clip triangle - is convex.
//
// It is what lets `paint` skip supersampling in a pixel's interior, which is
// most of the pixels this file paints.
function wholePixelInside(poly, px, py) {
  return (
    inPoly(poly, px, py) &&
    inPoly(poly, px + 1, py) &&
    inPoly(poly, px, py + 1) &&
    inPoly(poly, px + 1, py + 1)
  );
}

function canvasOf(w0, h0) {
  // `width`/`height` reallocate and clear, exactly as a real canvas element's
  // do: every canvas in the exporter is minted empty and sized afterwards, and
  // the memory discipline in there hands pixels back by setting them to zero.
  const cnv = {
    _w: 0,
    _h: 0,
    px: new Float64Array(0),
    get width() {
      return this._w;
    },
    set width(v) {
      this._w = Math.max(0, Math.round(v) || 0);
      this.px = new Float64Array(this._w * this._h * 4);
    },
    get height() {
      return this._h;
    },
    set height(v) {
      this._h = Math.max(0, Math.round(v) || 0);
      this.px = new Float64Array(this._w * this._h * 4);
    },
  };
  cnv.width = w0;
  cnv.height = h0;
  const ctx = {
    m: { ...IDENT },
    clips: [],
    stack: [],
    globalAlpha: 1,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 0,
    lineJoin: '',
    miterLimit: 0,
    font: '10px sans',
    textAlign: 'left',
    textBaseline: 'top',
    letterSpacing: '0px',
    filter: 'none',
    globalCompositeOperation: 'source-over',
    imageSmoothingQuality: '',
    get canvas() {
      return cnv;
    },
    save() {
      this.stack.push({
        m: { ...this.m },
        clips: this.clips.slice(),
        globalAlpha: this.globalAlpha,
        fillStyle: this.fillStyle,
        filter: this.filter,
        globalCompositeOperation: this.globalCompositeOperation,
      });
    },
    restore() {
      const s = this.stack.pop();
      if (s) Object.assign(this, s);
    },
    getTransform() {
      return { ...this.m };
    },
    setTransform(a, b, c, d, e, f) {
      this.m = typeof a === 'object' ? { ...a } : { a, b, c, d, e, f };
    },
    transform(a, b, c, d, e, f) {
      this.m = mul(this.m, { a, b, c, d, e, f });
    },
    scale(x, y) {
      this.m = mul(this.m, { ...IDENT, a: x, d: y });
    },
    translate(x, y) {
      this.m = mul(this.m, { ...IDENT, e: x, f: y });
    },
    rotate(r) {
      this.m = mul(this.m, { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: 0, f: 0 });
    },
    beginPath() {
      this.path = [];
    },
    moveTo(x, y) {
      this.path = [apply(this.m, x, y)];
    },
    lineTo(x, y) {
      (this.path ??= []).push(apply(this.m, x, y));
    },
    rect(x, y, rw, rh) {
      this.path = [[x, y], [x + rw, y], [x + rw, y + rh], [x, y + rh]].map(([qx, qy]) =>
        apply(this.m, qx, qy),
      );
    },
    arc() {},
    closePath() {},
    clip() {
      if (this.path?.length >= 3) this.clips = [...this.clips, this.path];
    },
    fill() {},
    createPattern() {
      return null;
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
    // Every painted pixel goes through here: `cover` answers, for one device
    // pixel, how much of it this draw covers and in what colour.
    //
    // `solid` is an optional convex polygon that the caller guarantees `cover`
    // answers the same colour everywhere inside. When a whole device pixel
    // falls inside it - and inside every clip - the sixteen samples would all
    // return that one colour and average back to it, so one sample at the
    // pixel's centre is not an approximation of the supersampled answer, it IS
    // the supersampled answer, to the last bit. Only the pixels along an EDGE
    // take the full sixteen, which is where the coverage this renderer exists
    // to measure actually varies.
    //
    // It rests on convexity: the four corners of a pixel are the corners of the
    // square every sample sits strictly inside, so a convex polygon containing
    // all four contains the square. Every polygon reaching this - a rect, a
    // fill's parallelogram, a clip triangle - is convex.
    paint(x0, y0, x1, y1, cover, solid = null) {
      // Clipped away before it is sampled: a warped box draws its whole texture
      // through every triangle, and rasterising each of those over the full
      // footprint rather than over the clip is the difference between this file
      // running in a second and running in a minute.
      const clips = this.clips;
      let lo = x0;
      let to = y0;
      let hi = x1;
      let bo = y1;
      for (const poly of clips) {
        lo = Math.max(lo, Math.min(...poly.map((q) => q[0])));
        to = Math.max(to, Math.min(...poly.map((q) => q[1])));
        hi = Math.min(hi, Math.max(...poly.map((q) => q[0])));
        bo = Math.min(bo, Math.max(...poly.map((q) => q[1])));
      }
      const ax = Math.max(0, Math.floor(lo));
      const ay = Math.max(0, Math.floor(to));
      const bx = Math.min(cnv.width - 1, Math.ceil(hi));
      const by = Math.min(cnv.height - 1, Math.ceil(bo));
      const n = SUB * SUB;
      for (let py = ay; py <= by; py++) {
        for (let pxi = ax; pxi <= bx; pxi++) {
          // A pixel every clip wholly contains needs no per-sample clip test at
          // all: sixteen tests that can only answer "inside" become four.
          let unclipped = true;
          for (const poly of clips) {
            if (!wholePixelInside(poly, pxi, py)) {
              unclipped = false;
              break;
            }
          }
          let r = 0;
          let g = 0;
          let b = 0;
          let a = 0;
          if (unclipped && solid && wholePixelInside(solid, pxi, py)) {
            // One sample, and it is not an approximation: `solid` is the
            // caller's promise that `cover` answers the same colour everywhere
            // inside it, so all sixteen samples would return this and average
            // back to it exactly.
            const c = cover(pxi + 0.5, py + 0.5);
            if (!c) continue;
            r = c[0] * c[3] * n;
            g = c[1] * c[3] * n;
            b = c[2] * c[3] * n;
            a = c[3] * n;
          } else {
            for (let sy = 0; sy < SUB; sy++) {
              for (let sx = 0; sx < SUB; sx++) {
                const dx = pxi + (sx + 0.5) / SUB;
                const dy = py + (sy + 0.5) / SUB;
                if (!unclipped) {
                  let clipped = false;
                  for (const poly of clips) {
                    if (!inPoly(poly, dx, dy)) {
                      clipped = true;
                      break;
                    }
                  }
                  if (clipped) continue;
                }
                const c = cover(dx, dy);
                if (!c) continue;
                r += c[0] * c[3];
                g += c[1] * c[3];
                b += c[2] * c[3];
                a += c[3];
              }
            }
          }
          if (a <= 0) continue;
          const sa = (a / n) * this.globalAlpha;
          const i = (py * cnv.width + pxi) * 4;
          if (this.globalCompositeOperation === 'lighter') {
            // Porter-Duff plus: the premultiplied sum, clamped.
            cnv.px[i] = Math.min(1, (r / n) * this.globalAlpha + cnv.px[i]);
            cnv.px[i + 1] = Math.min(1, (g / n) * this.globalAlpha + cnv.px[i + 1]);
            cnv.px[i + 2] = Math.min(1, (b / n) * this.globalAlpha + cnv.px[i + 2]);
            cnv.px[i + 3] = Math.min(1, sa + cnv.px[i + 3]);
            continue;
          }
          const keep = 1 - sa;
          cnv.px[i] = (r / n) * this.globalAlpha + cnv.px[i] * keep;
          cnv.px[i + 1] = (g / n) * this.globalAlpha + cnv.px[i + 1] * keep;
          cnv.px[i + 2] = (b / n) * this.globalAlpha + cnv.px[i + 2] * keep;
          cnv.px[i + 3] = sa + cnv.px[i + 3] * keep;
        }
      }
    },
    box(x, y, bw, bh) {
      const corners = [[x, y], [x + bw, y], [x + bw, y + bh], [x, y + bh]].map(([qx, qy]) =>
        apply(this.m, qx, qy),
      );
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      return { corners, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    },
    fillRect(x, y, bw, bh) {
      const rgba = parseColor(typeof this.fillStyle === 'string' ? this.fillStyle : '#000000');
      const q = this.box(x, y, bw, bh);
      // One flat colour over a convex quad, so every pixel the quad wholly
      // covers can skip the supersampling - see `solid` on `paint`. This is
      // most of the pixels this file paints: the page's white sheet, the
      // texture fixtures, and every glyph block.
      //
      // The one `rgba` is handed back to every sample rather than a fresh array
      // per sample: `paint` reads the four numbers and keeps nothing.
      this.paint(
        q.x0,
        q.y0,
        q.x1,
        q.y1,
        (dx, dy) => (inPoly(q.corners, dx, dy) ? rgba : null),
        q.corners,
      );
    },
    clearRect(x, y, bw, bh) {
      const q = this.box(x, y, bw, bh);
      for (let py = Math.max(0, Math.floor(q.y0)); py <= Math.min(cnv.height - 1, Math.ceil(q.y1) - 1); py++) {
        for (let pxi = Math.max(0, Math.floor(q.x0)); pxi <= Math.min(cnv.width - 1, Math.ceil(q.x1) - 1); pxi++) {
          const i = (py * cnv.width + pxi) * 4;
          cnv.px[i] = cnv.px[i + 1] = cnv.px[i + 2] = cnv.px[i + 3] = 0;
        }
      }
    },
    // Glyphs stand in as one block per line: what is under test is where the
    // picture goes, and a font would only make that harder to read off.
    fillText(text, x, y) {
      const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? '10');
      const wid = String(text).length * size * 0.6;
      const left = this.textAlign === 'center' ? x - wid / 2 : this.textAlign === 'right' ? x - wid : x;
      // 'alphabetic' is what the straight-line painter uses, and under node the
      // baseline sits 0.8 of the size below the em square's top (measure.js's
      // stand-in ascent), so the block starts that far above it.
      const top =
        this.textBaseline === 'middle' ? y - size / 2 : this.textBaseline === 'alphabetic' ? y - size * 0.8 : y;
      this.fillRect(left, top, wid, size);
    },
    strokeText() {},
    drawImage(src, dx = 0, dy = 0, dw = src.width, dh = src.height) {
      if (!src?.width || !src?.height) return;
      const back = inv(this.m);
      const q = this.box(dx, dy, dw, dh);
      // The hottest loop in this file by a wide margin - a warped box samples
      // its whole texture through every triangle of the mesh, sixteen times per
      // device pixel. So the inverse transform is spelled out rather than going
      // through `apply`, and one scratch tuple carries the colour out: two array
      // allocations per sample was a million objects per warp render, and the
      // garbage that made was most of this file's run time and all of its
      // variance. `paint` reads the four numbers and keeps nothing. Neither
      // change moves a single arithmetic result - see the note in the loop.
      const { a: ba, b: bb, c: bc, d: bd, e: be, f: bf } = back;
      const px4 = src.px;
      const out = [0, 0, 0, 0];
      this.paint(q.x0, q.y0, q.x1, q.y1, (px2, py2) => {
        // Spelled out, but arithmetically the same expression `apply` and the
        // two divisions below always were - operand for operand, in the same
        // order. Hoisting `src.width / dw` out of the loop would be faster
        // again and is deliberately not done: it re-associates the multiply,
        // and a rounding difference of one ulp either side of a `floor` is a
        // different texel, which is not a thing a pixel-exact test should risk
        // for a few milliseconds.
        const lx = ba * px2 + bc * py2 + be;
        const ly = bb * px2 + bd * py2 + bf;
        const u = Math.floor(((lx - dx) / dw) * src.width);
        const v = Math.floor(((ly - dy) / dh) * src.height);
        if (u < 0 || v < 0 || u >= src.width || v >= src.height) return null;
        const j = (v * src.width + u) * 4;
        const a = px4[j + 3];
        if (a <= 0) return null;
        // Back to straight colour: `paint` premultiplies again.
        out[0] = px4[j] / a;
        out[1] = px4[j + 1] / a;
        out[2] = px4[j + 2] / a;
        out[3] = a;
        return out;
      });
    },
    getImageData(x, y, gw, gh) {
      const data = new Uint8ClampedArray(gw * gh * 4);
      for (let j = 0; j < gh; j++) {
        for (let i = 0; i < gw; i++) {
          const s = ((y + j) * cnv.width + (x + i)) * 4;
          const t = (j * gw + i) * 4;
          const a = cnv.px[s + 3];
          data[t] = a > 0 ? (cnv.px[s] / a) * 255 : 0;
          data[t + 1] = a > 0 ? (cnv.px[s + 1] / a) * 255 : 0;
          data[t + 2] = a > 0 ? (cnv.px[s + 2] / a) * 255 : 0;
          data[t + 3] = a * 255;
        }
      }
      return { width: gw, height: gh, data };
    },
    createImageData(gw, gh) {
      return { width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) };
    },
    putImageData(img, x = 0, y = 0) {
      for (let j = 0; j < img.height; j++) {
        for (let i = 0; i < img.width; i++) {
          const s = (j * img.width + i) * 4;
          const t = ((y + j) * cnv.width + (x + i)) * 4;
          const a = img.data[s + 3] / 255;
          cnv.px[t] = (img.data[s] / 255) * a;
          cnv.px[t + 1] = (img.data[s + 1] / 255) * a;
          cnv.px[t + 2] = (img.data[s + 2] / 255) * a;
          cnv.px[t + 3] = a;
        }
      }
    },
  };
  cnv.getContext = () => ctx;
  return cnv;
}

const at = (cnv, x, y) => {
  const i = (Math.round(y) * cnv.width + Math.round(x)) * 4;
  const a = cnv.px[i + 3];
  return a > 0 ? [cnv.px[i] / a, cnv.px[i + 1] / a, cnv.px[i + 2] / a, a] : [0, 0, 0, 0];
};
const alphaAt = (cnv, x, y) => cnv.px[(Math.round(y) * cnv.width + Math.round(x)) * 4 + 3];

// The box, and the four quadrant colours a probe reads back. The texture is the
// exporter's own shape: a footprint with the box rect inside it, `ox`/`oy` in
// from its top-left corner.
const W = 100;
const H = 100;
const PAD = 20;
const RED = [1, 0, 0];
const GREEN = [0, 1, 0];
const BLUE = [0, 0, 1];
const YELLOW = [1, 1, 0];

function quadTexture(ss = 1) {
  const cnv = canvasOf((W + PAD * 2) * ss, (H + PAD * 2) * ss);
  const ctx = cnv.getContext('2d');
  ctx.setTransform(ss, 0, 0, ss, 0, 0);
  ctx.translate(PAD, PAD); // box-local (0,0)
  const put = (x, y, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, W / 2, H / 2);
  };
  put(0, 0, '#ff0000');
  put(W / 2, 0, '#00ff00');
  put(0, H / 2, '#0000ff');
  put(W / 2, H / 2, '#ffff00');
  return cnv;
}

function flatTexture(ss = 1, color = '#101010') {
  const cnv = canvasOf((W + PAD * 2) * ss, (H + PAD * 2) * ss);
  const ctx = cnv.getContext('2d');
  ctx.setTransform(ss, 0, 0, ss, 0, 0);
  ctx.translate(PAD, PAD);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
  return cnv;
}

const warpArgs = (warp, extra = {}) => ({
  warp,
  w: W,
  h: H,
  ox: PAD,
  oy: PAD,
  cw: W + PAD * 2,
  ch: H + PAD * 2,
  makeCanvas: canvasOf,
  ...extra,
});

// The bottom-right corner dragged to (120, 140) - the same worked example
// warp.test.js hand-computes its triangles from.
const DRAG = { on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 0], [0, 100], [120, 140]] };

// ===========================================================================

describe('expandTriangle', () => {
  // How far a point is from the line through a and b, signed towards `away`.
  const dist = (a, b, away, p) => {
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    let nx = ey / len;
    let ny = -ex / len;
    if (nx * (away[0] - a[0]) + ny * (away[1] - a[1]) > 0) {
      nx = -nx;
      ny = -ny;
    }
    return nx * (p[0] - a[0]) + ny * (p[1] - a[1]);
  };

  it('pushes every EDGE out by exactly `pad`, which is what closes a seam', () => {
    // Half a cell, cut along its diagonal: the shape the painter actually
    // draws, and the one a centroid-relative expansion moves the diagonal of by
    // less than it moves the legs.
    const tri = [[0, 0], [10, 0], [10, 10]];
    const out = expandTriangle(tri, 0.75);
    for (let i = 0; i < 3; i++) {
      const a = tri[i];
      const b = tri[(i + 1) % 3];
      const away = tri[(i + 2) % 3];
      // Both endpoints of the grown edge sit 0.75 outside the original line.
      expect(dist(a, b, away, out[i])).toBeCloseTo(0.75, 10);
      expect(dist(a, b, away, out[(i + 1) % 3])).toBeCloseTo(0.75, 10);
    }
  });

  it('contains the triangle it grew from', () => {
    const tri = [[0, 0], [10, 0], [10, 10]];
    const out = expandTriangle(tri, 0.75);
    for (const p of tri) expect(inPoly(out, p[0], p[1])).toBe(true);
  });

  it('leaves the triangle alone when there is nothing to grow it by', () => {
    expect(expandTriangle([[0, 0], [10, 0], [0, 10]], 0)).toEqual([[0, 0], [10, 0], [0, 10]]);
  });

  it('hands a triangle with no area back untouched rather than dividing by zero', () => {
    expect(expandTriangle([[0, 0], [0, 0], [0, 0]], 1)).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(expandTriangle([[0, 0], [5, 5], [10, 10]], 1)).toEqual([[0, 0], [5, 5], [10, 10]]);
    expect(expandTriangle([[0, 0], [1, 0], [NaN, 2]], 1)).toEqual([[0, 0], [1, 0], [NaN, 2]]);
  });
});

describe('warpPlan', () => {
  it('is null when the mesh does nothing', () => {
    expect(warpPlan({ on: true, cols: 1, rows: 1, pts: [] }, W, H)).toBeNull();
    expect(warpPlan({ on: true, cols: 2, rows: 2, pts: identityMesh(2, 2, W, H) }, W, H)).toBeNull();
    expect(warpPlan(DRAG, 0, 0)).toBeNull();
  });

  it('carries the control points themselves, exactly, for a grid', () => {
    const pts = identityMesh(2, 2, W, H).map((p, i) => (i === 4 ? [70, 20] : p));
    const plan = warpPlan({ on: true, cols: 2, rows: 2, pts }, W, H);
    expect(plan.projective).toBe(false);
    // And subdivides each mesh cell, because the surface between the dots is
    // curved: `WARP_SUB` per side, spread over two cells.
    expect(plan.tris).toHaveLength(2 * WARP_SUB * WARP_SUB);
    // Every control point is somewhere in the destination, to the bit.
    const flat = plan.tris.flatMap((t) => t.dst).map((p) => `${p[0]},${p[1]}`);
    for (const p of pts) expect(flat).toContain(`${p[0]},${p[1]}`);
  });

  it('splits every cell into two triangles that share the cell diagonal', () => {
    const pts = identityMesh(2, 2, W, H).map((p, i) => (i === 4 ? [70, 20] : p));
    // One virtual cell per mesh cell, so the cells counted are the mesh's own.
    const plan = warpPlan({ on: true, cols: 2, rows: 2, pts }, W, H, null, { sub: 2 });
    // No band: the source rect is the box rect, so 2x2 cells and no more.
    expect(plan.tris).toHaveLength(8);
    for (let i = 0; i < plan.tris.length; i += 2) {
      const a = plan.tris[i];
      const b = plan.tris[i + 1];
      // (tl, tr, br) then (tl, br, bl): the diagonal is tl->br in both, as the
      // same coordinates rather than as two roundings of one point.
      expect(a.dst[0]).toEqual(b.dst[0]);
      expect(a.dst[2]).toEqual(b.dst[1]);
      expect(a.src[0]).toEqual(b.src[0]);
      expect(a.src[2]).toEqual(b.src[1]);
    }
  });

  it('adds a ring of cells for the footprint the box overflows into', () => {
    const rect = { x: -PAD, y: -PAD, w: W + PAD * 2, h: H + PAD * 2 };
    const plan = warpPlan({ on: true, cols: 2, rows: 2, pts: identityMesh(2, 2, W, H).map((p, i) => (i === 4 ? [70, 20] : p)) }, W, H, rect, { sub: 2 });
    // Two lines added on each axis, so 4x4 cells instead of 2x2.
    expect(plan.tris).toHaveLength(32);
    const srcPts = plan.tris.flatMap((t) => t.src).map((p) => `${p[0]},${p[1]}`);
    expect(srcPts).toContain(`${-PAD},${-PAD}`);
    expect(srcPts).toContain(`${W + PAD},${H + PAD}`);
  });

  it('takes the projective route for a four-handle quad that is not a parallelogram', () => {
    const plan = warpPlan(DRAG, W, H);
    expect(plan.projective).toBe(true);
    // 8x8 virtual cells, two triangles each.
    expect(plan.tris).toHaveLength(2 * WARP_SUB * WARP_SUB);
  });

  it('puts the middle of that quad where the homography says, not where the two triangles do', () => {
    // The crease, in numbers. A 1x1 mesh whose right edge is pulled in to 2/3
    // (the trapezoid warp.test.js solves by hand, at 100px): the projective map
    // sends the box centre to (40, 40), while reading the cell as two triangles
    // sends it to (100/3, 100/3) - three and a third pixels of fold.
    const pts = [[0, 0], [200 / 3, 0], [0, 100], [200 / 3, 200 / 3]];
    const warp = { on: true, cols: 1, rows: 1, pts };
    const plan = warpPlan(warp, W, H);
    expect(plan.projective).toBe(true);
    // The virtual grid's centre point is a cell corner, so it is in the list.
    const dst = plan.tris.flatMap((t, i) => t.dst.map((p, k) => ({ p, src: t.src[k] })));
    const mid = dst.find(({ src }) => src[0] === 50 && src[1] === 50);
    expect(mid.p[0]).toBeCloseTo(40, 6);
    expect(mid.p[1]).toBeCloseTo(40, 6);
    // Which is what the read side says too, and not what the two triangles
    // would have given.
    const [ax, ay] = warpPoint(pts, 1, 1, W, H, 50, 50);
    expect(ax).toBeCloseTo(40, 6);
    expect(ay).toBeCloseTo(40, 6);
    const [tx, ty] = affineWarpPoint(pts, 1, 1, W, H, 50, 50);
    expect(tx).toBeCloseTo(100 / 3, 6);
    expect(ty).toBeCloseTo(100 / 3, 6);
  });

  it('stays affine for a parallelogram, where both maps are the same map', () => {
    // A shear: no perspective, so nothing to subdivide for.
    const plan = warpPlan({ on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 0], [30, 100], [130, 100]] }, W, H);
    expect(plan.projective).toBe(false);
    expect(plan.tris).toHaveLength(2);
  });

  it('falls back to the triangles for a quad no projective map fits', () => {
    // Bottom-left dragged past the diagonal: a crossed quad, which has no
    // homography onto it. Better a crease than nothing on the page.
    const plan = warpPlan({ on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 0], [140, 60], [120, 140]] }, W, H);
    expect(plan.projective).toBe(false);
    expect(plan.tris).toHaveLength(2);
  });

  it('bounds the destination by what the mesh actually covers', () => {
    expect(warpPlan(DRAG, W, H).bounds).toEqual({ minX: 0, minY: 0, maxX: 120, maxY: 140 });
  });
});

describe('subdivisionFor', () => {
  // The projective map is approximated by one affine piece per cell, and that
  // error is a fraction of the CELL - so a fixed grid is a promise about a box
  // size rather than about quality. A full-page SFX is forty times the balloon
  // the number was chosen for.
  it('leaves a small box at the floor', () => {
    expect(subdivisionFor(100, 100)).toBe(WARP_SUB);
    expect(subdivisionFor(200, 400)).toBe(WARP_SUB);
    // Nothing to measure is nothing to subdivide for.
    expect(subdivisionFor(0, 0)).toBe(WARP_SUB);
    expect(subdivisionFor(NaN, undefined)).toBe(WARP_SUB);
  });

  it('follows the box up, one cell per 120 page px, and stops at the ceiling', () => {
    expect(subdivisionFor(1200, 400)).toBe(10);
    expect(subdivisionFor(2400, 600)).toBe(20);
    expect(subdivisionFor(4000, 1000)).toBe(WARP_SUB_MAX);
    expect(subdivisionFor(40000, 40000)).toBe(WARP_SUB_MAX);
  });

  it('gives a full-page trapezoid a finer grid than a balloon-sized one', () => {
    const quad = (w2, h2) => ({
      on: true,
      cols: 1,
      rows: 1,
      // The same shape at two sizes: right edge pulled in, so both are
      // projective and only the size differs.
      pts: [[0, 0], [w2, h2 * 0.125], [0, h2], [w2, h2 * 0.75]],
    });
    const small = warpPlan(quad(100, 100), 100, 100);
    const big = warpPlan(quad(4000, 4000), 4000, 4000);
    expect(small.projective).toBe(true);
    expect(big.projective).toBe(true);
    expect(small.tris).toHaveLength(2 * WARP_SUB * WARP_SUB);
    expect(big.tris).toHaveLength(2 * WARP_SUB_MAX * WARP_SUB_MAX);
    // Which is what it is for: the biggest cell of the big box is finer,
    // relative to the box, than a fixed 8x8 would have made it.
    const cell = (plan) => Math.max(...plan.tris.map((t) => Math.abs(t.src[1][0] - t.src[0][0])));
    expect(cell(big) / 4000).toBeLessThan(cell(small) / 100);
  });
});

// A canvas is not allowed to be any size at all, and a mesh close to degenerate
// asks for one that is not: `SPAN_LIMIT` still lets a big box's footprint out to
// tens of thousands of px, and at the export's supersample that is a bitmap
// every browser refuses - by returning null, by throwing, or (worst) by handing
// back a blank one, which is a box that vanished off the page.
describe('the canvas cap', () => {
  // Records what was asked for without allocating it: the whole point here is
  // sizes that must never be allocated.
  const sizes = [];
  const noop = new Proxy({}, { get: () => () => {} });
  const recorder = (w2, h2) => {
    sizes.push([w2, h2]);
    return { width: w2, height: h2, getContext: () => noop };
  };
  const bigBox = (bx, by) => ({
    warp: { on: true, cols: 2, rows: 2, pts: identityMesh(2, 2, 2000, 2000).map((p, i) => (i === 8 ? [bx, by] : p)) },
    w: 2000,
    h: 2000,
    ox: 20,
    oy: 20,
    cw: 2040,
    ch: 2040,
    makeCanvas: recorder,
    ss: 2,
  });

  it('renders a too-large footprint at a lower resolution rather than not at all', () => {
    sizes.length = 0;
    const args = bigBox(8000, 8000);
    const out = warpBoxCanvas(flatTexture(), args);
    expect(out).not.toBeNull();
    const [cwPx, chPx] = sizes.at(-1);
    expect(cwPx).toBeLessThanOrEqual(MAX_DEVICE);
    expect(chPx).toBeLessThanOrEqual(MAX_DEVICE);
    expect(cwPx * chPx).toBeLessThanOrEqual(MAX_DEVICE_AREA * 1.001);
    // The supersample gave way; the geometry did not. `cw`/`ch` are still the
    // page px the bitmap spans, so the page composite places it unchanged.
    const b = warpPlan(args.warp, args.w, args.h, { x: -args.ox, y: -args.oy, w: args.cw, h: args.ch }).bounds;
    expect(out.cw).toBe(Math.ceil(b.maxX + WARP_PAD) - Math.floor(b.minX - WARP_PAD));
    expect(out.ch).toBe(Math.ceil(b.maxY + WARP_PAD) - Math.floor(b.minY - WARP_PAD));
    expect(cwPx).toBeLessThan(out.cw * 2); // i.e. below the SS=2 it asked for
  });

  it('refuses a footprint no resolution would fit, and allocates nothing', () => {
    sizes.length = 0;
    // A near-degenerate mesh: a gigapixel of page, which even a quarter of a
    // device pixel per page pixel cannot hold. Null is the caller's signal to
    // draw the box unwarped, which is always bounded.
    expect(warpBoxCanvas(flatTexture(), bigBox(60000, 60000))).toBeNull();
    expect(sizes).toEqual([]);
  });

  it('leaves an ordinary box at its full supersample', () => {
    sizes.length = 0;
    const out = warpBoxCanvas(flatTexture(4), warpArgs(DRAG, { ss: 4, makeCanvas: recorder }));
    expect(out).not.toBeNull();
    expect(sizes.at(-1)).toEqual([out.cw * 4, out.ch * 4]);
  });
}, HEAVY_MS);

describe('warpBoxCanvas', () => {
  it('hands back null for a mesh that changes nothing, so the caller keeps its texture', () => {
    expect(warpBoxCanvas(flatTexture(), warpArgs({ on: true, cols: 1, rows: 1, pts: [] }))).toBeNull();
    expect(
      warpBoxCanvas(flatTexture(), warpArgs({ on: true, cols: 2, rows: 2, pts: identityMesh(2, 2, W, H) })),
    ).toBeNull();
  });

  it('sizes the destination from the deformed mesh, padded for the AA bleed', () => {
    const rect = { x: -PAD, y: -PAD, w: W + PAD * 2, h: H + PAD * 2 };
    const b = warpPlan(DRAG, W, H, rect).bounds;
    const out = warpBoxCanvas(quadTexture(), warpArgs(DRAG));
    // Two page px past everything the mesh covers - the band around the box
    // rect included, which is where the overflow went - and snapped outwards to
    // whole px so the box's origin inside the bitmap stays an integer.
    expect(out.ox).toBe(-Math.floor(b.minX - WARP_PAD));
    expect(out.oy).toBe(-Math.floor(b.minY - WARP_PAD));
    expect(out.cw).toBe(Math.ceil(b.maxX + WARP_PAD) - Math.floor(b.minX - WARP_PAD));
    expect(out.ch).toBe(Math.ceil(b.maxY + WARP_PAD) - Math.floor(b.minY - WARP_PAD));
    expect(out.canvas.width).toBe(out.cw);
    expect(out.canvas.height).toBe(out.ch);
    // The dragged corner is 20px right and 40px below the box, and the bitmap
    // holds all of it: nothing the mesh moved is cropped off.
    expect(out.cw - out.ox).toBeGreaterThanOrEqual(120 + WARP_PAD);
    expect(out.ch - out.oy).toBeGreaterThanOrEqual(140 + WARP_PAD);
  });

  it('lands the probes where the mesh says - hand-computed, three of them', () => {
    // The 1x1 drag is not a parallelogram, so the painter draws it projectively;
    // these probes are read against that map, which is exact at the corners the
    // gizmo actually dragged.
    const out = warpBoxCanvas(quadTexture(), warpArgs(DRAG));
    const h = solveHomography(
      [[0, 0], [W, 0], [W, H], [0, H]],
      [DRAG.pts[0], DRAG.pts[1], DRAG.pts[3], DRAG.pts[2]],
    );
    const probe = (sx, sy) => {
      const [x, y] = applyHomography(h, sx, sy);
      return at(out.canvas, x + out.ox, y + out.oy);
    };
    // One probe per quadrant of the source, well inside it.
    expect(probe(25, 25).slice(0, 3)).toEqual(RED);
    expect(probe(75, 25).slice(0, 3)).toEqual(GREEN);
    expect(probe(25, 75).slice(0, 3)).toEqual(BLUE);
    expect(probe(75, 75).slice(0, 3)).toEqual(YELLOW);
    // And the corner the user dragged carries the colour that was under it: the
    // box's bottom-right pixel is now at (120, 140).
    expect(at(out.canvas, 118 + out.ox, 137 + out.oy).slice(0, 3)).toEqual(YELLOW);
    // Outside the quad the box has become, nothing is painted at all: (10, 135)
    // is below the edge from (0, 100) to (120, 140), which passes through
    // y = 103.3 there.
    expect(alphaAt(out.canvas, 10 + out.ox, 135 + out.oy)).toBe(0);
  });

  it('carries a grid the way its own surface says', () => {
    // A 2x2 mesh, so the mapping is the bicubic surface, and the probes are
    // read straight off `warpPoint`.
    const pts = identityMesh(2, 2, W, H).map((p, i) => (i === 4 ? [30, 60] : p));
    const out = warpBoxCanvas(quadTexture(), warpArgs({ on: true, cols: 2, rows: 2, pts }));
    for (const [sx, sy, want] of [[20, 20, RED], [80, 20, GREEN], [80, 80, YELLOW]]) {
      const [x, y] = warpPoint(pts, 2, 2, W, H, sx, sy);
      expect(at(out.canvas, x + out.ox, y + out.oy).slice(0, 3)).toEqual(want);
    }
  });

  it('carries the overflow outside the box rect instead of cropping it', () => {
    // Ink drawn over the box edge, or a glyph hanging out of it: the band cells
    // are what keep it. A texture with paint in the margin, and the margin is
    // still there afterwards.
    const src = flatTexture();
    const sctx = src.getContext('2d');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.translate(PAD, PAD);
    sctx.fillStyle = '#00ff00';
    sctx.fillRect(-10, 10, 10, 10); // a strip 10px left of the box
    const out = warpBoxCanvas(src, warpArgs(DRAG));
    const [x, y] = warpPoint(DRAG.pts, 1, 1, W, H, -5, 15);
    expect(at(out.canvas, x + out.ox, y + out.oy).slice(0, 3)).toEqual(GREEN);
  });
}, HEAVY_MS);

// The other way to put the triangles down, kept as the control: each one over
// the ones before it (source-over), its clip grown by `grow` page px. This is
// what the painter did for every mesh before joins were added, and what it
// still does for a folded one.
function layered(src, args, grow) {
  const plan = warpPlan(args.warp, args.w, args.h, { x: -args.ox, y: -args.oy, w: args.cw, h: args.ch });
  const ref = warpBoxCanvas(src, args);
  const canvas = canvasOf(ref.cw, ref.ch);
  const ctx = canvas.getContext('2d');
  ctx.translate(ref.ox, ref.oy);
  for (const tri of plan.tris) {
    const m = affineFromTriangle(tri.src, tri.dst);
    if (!m) continue;
    const e = expandTriangle(tri.dst, grow);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(e[0][0], e[0][1]);
    ctx.lineTo(e[1][0], e[1][1]);
    ctx.lineTo(e[2][0], e[2][1]);
    ctx.closePath();
    ctx.clip();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(src, -args.ox, -args.oy, args.cw, args.ch);
    ctx.restore();
  }
  return { canvas, ox: ref.ox, oy: ref.oy };
}

// Alpha over every interior pixel of a warped bitmap: a pixel whose four
// corners, pushed out by a margin, are all inside the deformed outline `ring`.
// The margin keeps the box's own antialiased edge - which is not a join - out
// of the scan. `bytes` is the same alpha as the 8-bit value a canvas holds.
function interior(out, ring, m = 2.5) {
  const img = out.canvas.getContext('2d').getImageData(0, 0, out.canvas.width, out.canvas.height);
  const r = { min: Infinity, max: -Infinity, minByte: 255, maxByte: 0, holes: 0, n: 0 };
  for (let y = 0; y < out.canvas.height; y++) {
    for (let x = 0; x < out.canvas.width; x++) {
      const cx = x + 0.5 - out.ox;
      const cy = y + 0.5 - out.oy;
      const inside = [[-m, -m], [m, -m], [m, m], [-m, m]].every(([dx, dy]) => inPoly(ring, cx + dx, cy + dy));
      if (!inside) continue;
      const a = alphaAt(out.canvas, x, y);
      const byte = img.data[(y * out.canvas.width + x) * 4 + 3];
      r.n++;
      r.min = Math.min(r.min, a);
      r.max = Math.max(r.max, a);
      r.minByte = Math.min(r.minByte, byte);
      r.maxByte = Math.max(r.maxByte, byte);
      if (a < 0.999) r.holes++;
    }
  }
  return r;
}

const HALF = 'rgba(0,0,0,0.5)';

describe('the seams between cells', () => {
  // A mesh with every interior handle pulled somewhere different, which is the
  // worst case for the joins: nine cells, twelve interior edges, and four
  // T-junctions where four triangles meet at a point.
  const pts = identityMesh(3, 3, W, H).map(([x, y], i) => [
    x + (i % 3) * 4 - 4,
    y + ((i * 7) % 5) * 3 - 6,
  ]);
  const warp = { on: true, cols: 3, rows: 3, pts };

  const outline = () => {
    const n = 4;
    const ring = [];
    for (let i = 0; i < n; i++) ring.push(pts[i]);
    for (let j = 1; j < n; j++) ring.push(pts[j * n + n - 1]);
    for (let i = n - 2; i >= 0; i--) ring.push(pts[(n - 1) * n + i]);
    for (let j = n - 2; j >= 1; j--) ring.push(pts[j * n]);
    return ring;
  };

  it('leaves no pinhole anywhere inside a warped flat-colour box', () => {
    const out = warpBoxCanvas(flatTexture(1, '#000000'), warpArgs(warp));
    const r = interior(out, outline());
    expect(r.n).toBeGreaterThan(5000);
    expect(r.holes).toBe(0);
    expect(r.min).toBe(1);
  });

  it('keeps a half-opaque box half opaque along every join', () => {
    // A shadow, an outline at half alpha, the soft edge of ink: drawn twice
    // over a join, half over half is three quarters. Added, the two sides'
    // coverage sums to one and the pixel is the texture's own.
    const out = warpBoxCanvas(flatTexture(1, HALF), warpArgs(warp));
    const r = interior(out, outline());
    expect(r.min).toBeGreaterThan(0.5 - 1e-9);
    expect(r.max).toBeLessThan(0.5 + 1e-9);
  });

  it('is the adding that does it - laid one over another, the joins show', () => {
    // The control, and the reason for both rules. Exact clips laid over each
    // other let the background through every join...
    const exact = interior(layered(flatTexture(1, '#000000'), warpArgs(warp), 0), outline());
    expect(exact.holes).toBeGreaterThan(20);
    expect(exact.min).toBeLessThan(0.85);
    // ...and grown ones close that, but draw a translucent join twice.
    const grown = interior(layered(flatTexture(1, HALF), warpArgs(warp), SEAM_OVERDRAW), outline());
    expect(grown.max).toBeGreaterThan(0.7);
  });

  it('draws a sheared box\'s diagonal at the alpha the texture has', () => {
    // One cell sheared into a parallelogram: two triangles and one join, the
    // diagonal, right across the middle. In canvas bytes: 127 or 128, not 191.
    const shear = { on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 0], [30, 100], [130, 100]] };
    const ring = [[0, 0], [100, 0], [130, 100], [30, 100]];
    const now = interior(warpBoxCanvas(flatTexture(1, HALF), warpArgs(shear)), ring);
    expect(now.n).toBeGreaterThan(5000);
    expect(now.minByte).toBeGreaterThanOrEqual(127);
    expect(now.maxByte).toBeLessThanOrEqual(128);
    const before = interior(layered(flatTexture(1, HALF), warpArgs(shear), SEAM_OVERDRAW), ring);
    expect(before.maxByte).toBeGreaterThan(185);
  });
}, HEAVY_MS);

describe('a mesh folded over itself', () => {
  // The bottom-left corner dragged past the diagonal: the cell's second half
  // turns over and lies across the first.
  const CROSSED = { on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 0], [140, 60], [120, 140]] };
  const turnedOver = (plan) =>
    plan.tris.some(({ dst: [a, b, c] }) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0);

  it('is told apart from one that lies flat', () => {
    const rect = { x: -PAD, y: -PAD, w: W + PAD * 2, h: H + PAD * 2 };
    const jitter = identityMesh(3, 3, W, H).map(([x, y], i) => [x + (i % 3) * 4 - 4, y + ((i * 7) % 5) * 3 - 6]);
    expect(meshFolds(warpPlan(DRAG, W, H, rect))).toBe(false);
    expect(meshFolds(warpPlan({ on: true, cols: 3, rows: 3, pts: jitter }, W, H, rect))).toBe(false);
    expect(meshFolds(warpPlan({ on: true, cols: 1, rows: 1, pts: [[0, 0], [100, 0], [30, 100], [130, 100]] }, W, H, rect))).toBe(false);
    expect(meshFolds(warpPlan(CROSSED, W, H, rect))).toBe(true);
  });

  it('catches a twist that wraps round past itself with nothing turned over', () => {
    // A strip bent into a ring of 450 degrees: every triangle still winds the
    // right way, and the last quarter lies over the first. Only the outline
    // says so.
    const cols = 12;
    const pts = [];
    for (const rad of [150, 100]) {
      for (let i = 0; i <= cols; i++) {
        const t = ((i / cols) * 450 * Math.PI) / 180;
        pts.push([200 + rad * Math.cos(t), 200 + rad * Math.sin(t)]);
      }
    }
    const plan = warpPlan({ on: true, cols, rows: 1, pts }, W, H);
    expect(turnedOver(plan)).toBe(false);
    expect(meshFolds(plan)).toBe(true);
    // The same strip at 300 degrees does not reach itself.
    const short = pts.map((_, k) => {
      const i = k % (cols + 1);
      const rad = k <= cols ? 150 : 100;
      const t = ((i / cols) * 300 * Math.PI) / 180;
      return [200 + rad * Math.cos(t), 200 + rad * Math.sin(t)];
    });
    expect(meshFolds(warpPlan({ on: true, cols, rows: 1, pts: short }, W, H))).toBe(false);
  });

  it('lays the fold over the sheet instead of adding the two, so nothing brightens', () => {
    const args = warpArgs(CROSSED);
    const out = warpBoxCanvas(quadTexture(), args);
    const plan = warpPlan(CROSSED, W, H, { x: -PAD, y: -PAD, w: W + PAD * 2, h: H + PAD * 2 });
    // How far a point is inside a triangle, the least of its edge distances.
    const depth = (tri, x, y) => {
      let d = Infinity;
      for (let i = 0; i < 3; i++) {
        const [a, b, c] = [tri[i], tri[(i + 1) % 3], tri[(i + 2) % 3]];
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const side = (px, py) => (ex * (py - a[1]) - ey * (px - a[0])) / Math.hypot(ex, ey);
        d = Math.min(d, side(x, y) * Math.sign(side(c[0], c[1])));
      }
      return d;
    };
    // The quadrant colour under a source point, well clear of every boundary;
    // 'clear' for none (outside the box), undefined when too close to call.
    const colourAt = (sx, sy) => {
      const near = (v, edge) => Math.abs(v - edge) < 2;
      if ([0, 50, 100].some((e) => near(sx, e) || near(sy, e))) return undefined;
      if (sx < 0 || sy < 0 || sx > W || sy > H) return 'clear';
      return sx < 50 ? (sy < 50 ? RED : BLUE) : sy < 50 ? GREEN : YELLOW;
    };
    let checked = 0;
    for (let py = 0; py < out.canvas.height; py++) {
      for (let pxi = 0; pxi < out.canvas.width; pxi++) {
        const x = pxi + 0.5 - out.ox;
        const y = py + 0.5 - out.oy;
        const under = [];
        let unsure = false;
        for (const t of plan.tris) {
          const d = depth(t.dst, x, y);
          if (d < -2) continue;
          if (d < 2) {
            unsure = true;
            break;
          }
          const [sx, sy] = apply(
            ((m) => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }))(affineFromTriangle(t.dst, t.src)),
            x,
            y,
          );
          const c = colourAt(sx, sy);
          if (c === undefined) {
            unsure = true;
            break;
          }
          if (c !== 'clear') under.push(c);
        }
        // Only pixels two different colours of the sheet lie over, which is
        // where adding would show: red over blue would come out magenta.
        if (unsure || new Set(under.map(String)).size < 2) continue;
        expect(at(out.canvas, pxi, py)).toEqual([...under.at(-1), 1]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
}, HEAVY_MS);

// ===========================================================================
// The editor and the exporter draw the same box
// ===========================================================================

describe('warped parity: the editor canvas is the exported crop', () => {
  const realDocument = globalThis.document;
  const realImage = globalThis.Image;

  beforeEach(() => {
    globalThis.document = {
      fonts: { ready: Promise.resolve() },
      // The canvases are the renderer above; the div and the range are what
      // `wrapLinesDOM` measures its breaks with, and answering "no rectangles"
      // is what keeps the sample text on one line here.
      createElement: (tag) =>
        tag === 'canvas' ? canvasOf(0, 0) : { style: {}, firstChild: null, remove() {} },
      createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [] }),
      body: { appendChild() {} },
    };
    globalThis.Image = class {
      set src(_v) {
        queueMicrotask(() => this.onerror?.(new Error('no art in this test')));
      }
    };
  });
  afterEach(() => {
    globalThis.document = realDocument;
    globalThis.Image = realImage;
  });

  const boxOf = () => ({
    id: 1,
    x: 120,
    y: 90,
    w: W,
    h: H,
    text: 'AB',
    style: normalizeStyle({ size: 40, color: '#000000', warp: DRAG }),
  });

  it('draws the same pixels in the editor at zoom 1 as the page composite does', async () => {
    const box = boxOf();
    loadProjectPages([{ id: 7, w: 400, h: 300, lines: [], boxes: [box] }]);
    const p = app.pages[0];
    const pageCnv = await renderPageCanvas(p);

    const el = canvasOf(0, 0);
    const geom = paintWarpedBox(el, p.boxes[0], p, 1, null);
    // Where the page composite put that same bitmap.
    const originX = Math.round(box.x - geom.ox);
    const originY = Math.round(box.y - geom.oy);
    expect(el.width).toBe(geom.cw);
    expect(el.height).toBe(geom.ch);

    let inked = 0;
    let worst = 0;
    for (let y = 0; y < el.height; y++) {
      for (let x = 0; x < el.width; x++) {
        const e = at(el, x, y);
        const pg = at(pageCnv, originX + x, originY + y);
        if (e[3] > 0) inked++;
        // The page has a white sheet under the box; the editor canvas is
        // transparent. Composite the editor's pixel over white and the two are
        // the same picture.
        for (let c = 0; c < 3; c++) {
          const over = e[c] * e[3] + 1 * (1 - e[3]);
          worst = Math.max(worst, Math.abs(over - (pg[c] * pg[3] + 1 * (1 - pg[3]))));
        }
      }
    }
    // The box actually painted something, and every pixel of it agrees.
    expect(inked).toBeGreaterThan(500);
    expect(worst).toBeLessThan(1e-9);
  });

  it('places the warped bitmap by the mesh, not by the box rect', async () => {
    const box = boxOf();
    loadProjectPages([{ id: 7, w: 400, h: 300, lines: [], boxes: [box] }]);
    const p = app.pages[0];
    const el = canvasOf(0, 0);
    const warpGeom = paintWarpedBox(el, p.boxes[0], p, 1, null);

    // The same box with the warp switched off, for the footprint it would have
    // had. The mesh drags the bottom-right corner 20px right and 40px down, so
    // the warped footprint has to be that much bigger.
    p.boxes[0].style.warp.on = false;
    const flat = canvasOf(0, 0);
    const flatGeom = paintWarpedBox(flat, p.boxes[0], p, 1, null);
    expect(warpGeom.cw - flatGeom.cw).toBeGreaterThanOrEqual(20);
    expect(warpGeom.ch - flatGeom.ch).toBeGreaterThanOrEqual(40);
  });
}, HEAVY_MS);
