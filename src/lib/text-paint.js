// The arithmetic behind a text block's paint: strokes, gradient, pattern.
//
// It lives on its own because the editor draws a box with stacked DOM layers and
// the exporter draws the same box with canvas calls, and the two have to agree
// pixel for pixel. Anything both of them have to compute - how wide a stroke is
// actually drawn, where a gradient starts and ends, what one pattern tile looks
// like - is answered here once, so a change lands on both at the same time.

import { strokeStamps, strokeBounds, aaLevel, textureActive } from './brush.js';

// A stroke's `width` is the VISIBLE band the user asked for, but neither a
// canvas stroke nor `-webkit-text-stroke` can draw a band: both draw a line
// CENTRED on the glyph outline, half of it falling inside the glyph. So each
// stroke is drawn at twice the sum of every width up to and including itself,
// outermost first, and whatever is painted after it - the next stroke in, and
// finally the fill - covers its inner half. What is left showing is exactly the
// width that was asked for, per stroke.
//
// Takes the style's list (innermost first) and answers it in PAINT order,
// outermost first, with `line` being the width to hand to the renderer. Strokes
// of zero width are dropped rather than drawn as a hairline.
export function strokeBands(strokes) {
  const out = [];
  let cum = 0;
  for (const k of strokes ?? []) {
    const w = Math.max(0, Number(k?.width) || 0);
    if (w <= 0) continue;
    cum += w;
    out.push({
      color: k?.color ?? '#ffffff',
      opacity: Math.min(1, Math.max(0, Number(k?.opacity ?? 1))),
      width: w,
      line: cum * 2,
    });
  }
  return out.reverse();
}

// How far the ink reaches past the glyph outline, in page px. The sum of the
// visible widths, which is the outermost band's outer edge.
export function strokeExtent(strokes) {
  let cum = 0;
  for (const k of strokes ?? []) cum += Math.max(0, Number(k?.width) || 0);
  return cum;
}

// `#rrggbb` → the three channels as numbers. #rgb / #rgba short forms are
// doubled out; a trailing alpha nibble is dropped, because in this app alpha is
// always a field of its own beside the colour and never part of the hex.
function channels(hex) {
  let h = String(hex ?? '#000000').replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

// `#rrggbb` + alpha → a CSS colour both the DOM and the canvas accept.
export function rgba(hex, a = 1) {
  const [r, g, b] = channels(hex);
  return `rgba(${r},${g},${b},${a})`;
}

// One gradient stop as a colour string, which is the ONE place the editor's CSS
// and the exporter's canvas agree on what a stop's alpha means. A fully opaque
// stop stays the hex it was written as - the common case, and the one the CSS
// reads best - and anything else becomes rgba().
export function stopColor(st) {
  const a = Number.isFinite(+st?.opacity) ? Math.min(1, Math.max(0, +st.opacity)) : 1;
  return a >= 1 ? (st?.color ?? '#000000') : rgba(st?.color, a);
}

// The colour and alpha the ramp is showing at `p` (0..1), by the same linear
// interpolation both renderers do between two stops. Clicking an empty spot on
// the editor's stop bar adds a stop there, and the stop it adds has to be the
// colour that was already at that spot or the ramp visibly jumps on a gesture
// that was only meant to give it a handle.
export function sampleStops(stops, p) {
  const list = (stops ?? []).slice().sort((a, b) => (a?.pos ?? 0) - (b?.pos ?? 0));
  if (!list.length) return { color: '#000000', opacity: 1 };
  const at = (st) => ({
    color: st?.color ?? '#000000',
    opacity: Number.isFinite(+st?.opacity) ? Math.min(1, Math.max(0, +st.opacity)) : 1,
  });
  const t = Math.min(1, Math.max(0, Number(p) || 0));
  if (t <= (list[0].pos ?? 0)) return at(list[0]);
  const last = list[list.length - 1];
  if (t >= (last.pos ?? 0)) return at(last);
  for (let i = 1; i < list.length; i++) {
    const b = list[i];
    if (t > (b.pos ?? 0)) continue;
    const a = list[i - 1];
    const span = (b.pos ?? 0) - (a.pos ?? 0);
    // Two stops stacked on the same position have no span to interpolate
    // across; the later one is what the ramp is showing there.
    const f = span <= 0 ? 1 : (t - (a.pos ?? 0)) / span;
    const ca = channels(a.color);
    const cb = channels(b.color);
    const mix = ca.map((v, k) => Math.round(v + (cb[k] - v) * f));
    const oa = at(a).opacity;
    const ob = at(b).opacity;
    return {
      color: '#' + mix.map((v) => v.toString(16).padStart(2, '0')).join(''),
      opacity: oa + (ob - oa) * f,
    };
  }
  return at(last);
}

// The gradient as CSS. `angle` is already in CSS degrees (0 = bottom→top), which
// is why the style stores it that way: the editor can hand it straight over and
// only the canvas has to do the conversion below.
// A radial gradient is stated the same way in both renderers: centred at
// (cx,cy) as a fraction of the fill rect, ending at `radius` x the distance from
// that centre to the rect's farthest corner - which is exactly the size CSS
// calls `farthest-corner`. That equivalence is what lets the CSS below carry the
// radius in the STOP POSITIONS rather than in a pixel length: a stop at `p` of a
// gradient that ends at `radius` x D sits at `p * radius` of D, and CSS is happy
// with stop percentages past 100% (the last colour simply continues outwards,
// as it does past a canvas gradient's last stop).
// A percentage as CSS writes it. Three decimals rather than the whole number
// this used to round to: the exporter states the same stop as a float, so a
// ramp rounded to 1% here could sit up to half a percent of the gradient's
// length away from the one in the PNG - visible on a long, shallow ramp, and
// invisible in any test that only reads one side of it. Trailing zeros are
// dropped so the common case still reads as `50%`.
function pct(v) {
  return String(Math.round((Number(v) || 0) * 1000) / 1000);
}

export function gradientCss(g) {
  const radial = g?.kind === 'radial';
  const scale = radial ? Math.max(0.01, Number(g?.radius) || 1) : 1;
  const stops = (g?.stops ?? [])
    .map((st) => `${stopColor(st)} ${pct((st.pos ?? 0) * scale * 100)}%`)
    .join(', ');
  if (radial) {
    const cx = pct((Number(g?.cx) ?? 0.5) * 100);
    const cy = pct((Number(g?.cy) ?? 0.5) * 100);
    return `radial-gradient(circle farthest-corner at ${cx}% ${cy}%, ${stops})`;
  }
  return `linear-gradient(${Number(g?.angle) || 0}deg, ${stops})`;
}

// The radial gradient as a canvas circle over the rect (x,y,w,h): the centre in
// page coordinates and the radius the last stop lands on. Stops keep their own
// 0..1 positions, because `radius` is already in the circle.
export function radialEndpoints(g, x, y, w, h) {
  const cx = x + (Number.isFinite(+g?.cx) ? +g.cx : 0.5) * w;
  const cy = y + (Number.isFinite(+g?.cy) ? +g.cy : 0.5) * h;
  // farthest-corner: the corner is whichever is further on each axis, so the
  // distance is to the far side in x and the far side in y.
  const dx = Math.max(Math.abs(cx - x), Math.abs(x + w - cx));
  const dy = Math.max(Math.abs(cy - y), Math.abs(y + h - cy));
  const far = Math.hypot(dx, dy);
  const scale = Math.max(0.01, Number(g?.radius) || 1);
  return { cx, cy, r: Math.max(0.01, far * scale) };
}

// The same gradient as two canvas points, over the rect (x,y,w,h).
//
// CSS measures the gradient line from the centre of the box, long enough that
// the two ends cover the whole rect, and counts degrees clockwise from "up".
// Screen coordinates run y-down, so "up" is (0,-1) and the direction of travel
// is (sin a, -cos a).
export function gradientEndpoints(angleDeg, x, y, w, h) {
  const a = ((Number(angleDeg) || 0) * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    x0: cx - (dx * len) / 2,
    y0: cy - (dy * len) / 2,
    x1: cx + (dx * len) / 2,
    y1: cy + (dy * len) / 2,
  };
}

// How many device pixels per page px a tile is rasterised at, in both renderers:
// the exporter's box canvas is supersampled by exactly this, and the editor asks
// for the same multiple of its zoom.
export const TILE_SS = 2;

// One pattern tile is a square this many page px on a side, so a pattern keeps
// its proportion to the letters when the size changes.
//
// Snapped to a whole number of the raster's own pixels. Unsnapped, the tile was
// drawn at `round(tile * 2)` device px and then repeated at a pitch of `tile * 2`
// device px: the two disagree by up to half a pixel, so every repeat lands on a
// slightly different sub-pixel phase and the resampling leaves a hairline seam
// between some pairs of tiles and not others. At a snapped pitch the tile maps
// 1:1 onto the raster and there is no resampling left to seam. Both renderers
// read the pitch from here, so snapping it moves neither against the other.
export function patternTilePx(style) {
  const tile = (Number(style?.size) || 0) * 0.3 * (Number(style?.pattern?.scale) || 1);
  return Math.max(2, Math.round(tile * TILE_SS) / TILE_SS);
}

// Draw one tile of `pattern` into the square (0,0,tile,tile) of `ctx`. The tile
// has to be seamless in both directions - it is repeated by `createPattern` in
// the exporter and by `background-repeat` in the editor - so every shape either
// sits wholly inside it or runs the full width or height of it.
export function drawPatternTile(ctx, pattern, tile) {
  const fg = pattern?.fg ?? '#000000';
  const bg = pattern?.bg ?? '#ffffff';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, tile, tile);
  ctx.fillStyle = fg;
  const kind = pattern?.kind ?? 'dots';
  const dot = (cx, cy, r) => {
    ctx.beginPath();
    ctx.arc(cx * tile, cy * tile, r * tile, 0, Math.PI * 2);
    ctx.fill();
  };
  if (kind === 'dots') {
    dot(0.5, 0.5, 0.25);
  } else if (kind === 'halftone') {
    // The screentone stagger: two dots on the tile's diagonal read as a 45°
    // grid once the tile repeats, which is what a manga tone actually looks
    // like. Both sit wholly inside the tile, so it stays seamless.
    dot(0.25, 0.25, 0.17);
    dot(0.75, 0.75, 0.17);
  } else if (kind === 'stripes') {
    ctx.fillRect(0, 0, tile / 2, tile);
  } else if (kind === 'hstripes') {
    ctx.fillRect(0, 0, tile, tile / 2);
  } else if (kind === 'diagonal') {
    drawDiagonalBands(ctx, tile, 1, 0.5);
  } else if (kind === 'diagonal-alt') {
    drawDiagonalBands(ctx, tile, -1, 0.5);
  } else if (kind === 'crosshatch') {
    // Thinner than the single-direction bands, or the two sets meet and the
    // tile is simply solid fg.
    drawDiagonalBands(ctx, tile, 1, 0.3);
    drawDiagonalBands(ctx, tile, -1, 0.3);
  } else if (kind === 'checker') {
    ctx.fillRect(0, 0, tile / 2, tile / 2);
    ctx.fillRect(tile / 2, tile / 2, tile / 2, tile / 2);
  } else if (kind === 'grid') {
    const t = Math.max(1, tile * 0.12);
    ctx.fillRect(0, 0, tile, t);
    ctx.fillRect(0, 0, t, tile);
  } else if (kind === 'vlines') {
    ctx.fillRect(0, 0, Math.max(1, tile * 0.12), tile);
  } else if (kind === 'hlines') {
    ctx.fillRect(0, 0, tile, Math.max(1, tile * 0.12));
  }
}

// 45° bands across the tile, `dir` 1 for "/" and -1 for "\", `duty` the share of
// each period the band covers.
//
// Seamlessness is the whole reason for the numbers here: measured along the
// band's own perpendicular, moving one tile across in x (or down in y) shifts
// the phase by tile / sqrt(2), so that - and nothing else - is the period the
// bands have to repeat at for the tile's left edge to line up with its right.
function drawDiagonalBands(ctx, tile, dir, duty) {
  const period = tile / Math.SQRT2;
  const band = period * duty;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, tile, tile);
  ctx.clip();
  ctx.translate(tile / 2, tile / 2);
  ctx.rotate((dir * Math.PI) / 4);
  // The rotated frame is at most tile*sqrt(2) across, so ±2 periods either side
  // of centre covers it whichever way it is turned.
  for (let k = -2; k <= 2; k++) ctx.fillRect(-tile, k * period - band / 2, tile * 2, band);
  ctx.restore();
}

// One tile as its own canvas, at `dpr` device pixels per tile px. The exporter
// feeds it to `createPattern`; the editor turns it into a data URL and lets CSS
// repeat it. Both get their tiles from the same drawing, which is the point.
// Needs a document, so it answers null where there is none (the node tests).
export function patternTileCanvas(style, dpr = 1) {
  if (typeof document === 'undefined') return null;
  const tile = patternTilePx(style);
  const px = Math.max(2, Math.round(tile * dpr));
  const cnv = document.createElement('canvas');
  cnv.width = px;
  cnv.height = px;
  const ctx = cnv.getContext('2d');
  if (!ctx) return null;
  ctx.scale(px / tile, px / tile);
  drawPatternTile(ctx, style?.pattern, tile);
  return cnv;
}

// ---------------------------------------------------------------------------
// Edge roughening.
//
// The editor roughens by hanging an SVG filter on the text stack - feTurbulence
// feeding feDisplacementMap - and the exporter has to reach the same picture by
// moving pixels itself. What used to stand here for the export was a pair of
// sines playing the part of the noise, and it was not the same picture at all:
// its frequency worked out at `detail * 40 + 0.4`, which at the default detail
// of 0.05 is 2.4 cycles per PIXEL. Neighbouring pixels were therefore pulled
// from sources a dozen pixels apart, and text that showed clean rough edges on
// the canvas came out of the export as shredded confetti.
//
// So the noise here is the real one: the reference implementation of
// feTurbulence from the SVG 1.1 spec, which is what every browser's filter runs.
// Same seed, same baseFrequency, same octave count, therefore the same field the
// editor displaces by - which is what makes the export's roughening the
// canvas's roughening rather than a lookalike.

// The spec's PRNG, verbatim: r = (16807 * r) mod (2^31 - 1), by Schrage's method
// so it stays inside a 32-bit signed range.
const RAND_M = 2147483647;
const RAND_A = 16807;
const RAND_Q = 127773; // m / a
const RAND_R = 2836; // m % a

function nextRand(seed) {
  let r = RAND_A * (seed % RAND_Q) - RAND_R * ((seed / RAND_Q) | 0);
  if (r <= 0) r += RAND_M;
  return r;
}

function setupSeed(seed) {
  let s = Math.trunc(Number(seed) || 0);
  if (s <= 0) s = -(s % (RAND_M - 1)) + 1;
  if (s > RAND_M - 1) s = RAND_M - 1;
  return s;
}

const B_SIZE = 0x100;
const B_MASK = 0xff;
// The offset that keeps the lattice lookup on positive coordinates. Roughening
// samples a little outside the block (the padding around it), so the noise is
// asked for negative coordinates and `(int)t` has to stay a floor.
const PERLIN_N = 0x1000;

// The lattice and the four channels' gradients for one seed. All four are built
// even though only R and G are ever read, because the shuffle that follows them
// continues the same random stream - build two and every lattice index moves.
function buildNoise(seed) {
  let s = setupSeed(seed);
  const lattice = new Int32Array(B_SIZE + B_SIZE + 2);
  const grad = [];
  for (let k = 0; k < 4; k++) grad.push(new Float64Array((B_SIZE + B_SIZE + 2) * 2));
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < B_SIZE; i++) {
      lattice[i] = i;
      s = nextRand(s);
      let gx = ((s % (B_SIZE + B_SIZE)) - B_SIZE) / B_SIZE;
      s = nextRand(s);
      let gy = ((s % (B_SIZE + B_SIZE)) - B_SIZE) / B_SIZE;
      const len = Math.sqrt(gx * gx + gy * gy) || 1;
      grad[k][i * 2] = gx / len;
      grad[k][i * 2 + 1] = gy / len;
    }
  }
  // Fisher-Yates over the lattice, downwards from the last index - the spec's
  // `while(--i)`, which leaves slot 0 alone.
  for (let i = B_SIZE - 1; i > 0; i--) {
    const k = lattice[i];
    s = nextRand(s);
    const j = s % B_SIZE;
    lattice[i] = lattice[j];
    lattice[j] = k;
  }
  // Wrap: the second half repeats the first so a lookup at bx0 + by1 never has
  // to be masked twice.
  for (let i = 0; i < B_SIZE + 2; i++) {
    lattice[B_SIZE + i] = lattice[i];
    for (let k = 0; k < 4; k++) {
      grad[k][(B_SIZE + i) * 2] = grad[k][i * 2];
      grad[k][(B_SIZE + i) * 2 + 1] = grad[k][i * 2 + 1];
    }
  }
  return { lattice, grad };
}

// One field per seed. A page's worth of roughened boxes usually shares a seed,
// and building the lattice is ~2k random draws.
const noiseCache = new Map();
export function noiseFor(seed) {
  const key = setupSeed(seed);
  let n = noiseCache.get(key);
  if (!n) {
    n = buildNoise(key);
    if (noiseCache.size > 16) noiseCache.clear();
    noiseCache.set(key, n);
  }
  return n;
}

// Gradient noise at (vx, vy) on one channel's lattice. The spec's `noise2`.
//
// Takes the lattice and the channel's gradients rather than the field and a
// channel number, so the caller can hoist both out of a loop that runs once per
// device pixel of a page-sized block - see `roughenPixels`.
function noise2(lat, g, vx, vy) {
  let t = vx + PERLIN_N;
  const ix = Math.floor(t);
  const bx0 = ix & B_MASK;
  const bx1 = (bx0 + 1) & B_MASK;
  const rx0 = t - ix;
  const rx1 = rx0 - 1;

  t = vy + PERLIN_N;
  const iy = Math.floor(t);
  const by0 = iy & B_MASK;
  const by1 = (by0 + 1) & B_MASK;
  const ry0 = t - iy;
  const ry1 = ry0 - 1;

  const i = lat[bx0];
  const j = lat[bx1];
  const b00 = lat[i + by0];
  const b10 = lat[j + by0];
  const b01 = lat[i + by1];
  const b11 = lat[j + by1];

  const sx = rx0 * rx0 * (3 - 2 * rx0);
  const sy = ry0 * ry0 * (3 - 2 * ry0);

  let u = rx0 * g[b00 * 2] + ry0 * g[b00 * 2 + 1];
  let v = rx1 * g[b10 * 2] + ry0 * g[b10 * 2 + 1];
  const a = u + sx * (v - u);
  u = rx0 * g[b01 * 2] + ry1 * g[b01 * 2 + 1];
  v = rx1 * g[b11 * 2] + ry1 * g[b11 * 2 + 1];
  const b = u + sx * (v - u);
  return a + sy * (b - a);
}

// How many octaves the fractal sum runs to. Stated once here because the editor
// hands the same number to `feTurbulence`'s `numOctaves` and the two fields are
// only the same field if they agree on it.
export const OCTAVES = 2;

// The fractal sum at a point already multiplied by the base frequency, on one
// channel's lattice. Split out from `turbulenceChannel` so the per-pixel loop
// can hoist the lattice lookup; the arithmetic is unchanged.
function turbAt(lat, g, vx0, vy0, octaves) {
  let vx = vx0;
  let vy = vy0;
  let sum = 0;
  let ratio = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(lat, g, vx, vy) / ratio;
    vx *= 2;
    vy *= 2;
    ratio *= 2;
  }
  const c = (sum + 1) / 2;
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

// `type="fractalNoise"` turbulence as a colour channel in 0..1 - the sum of
// `octaves` octaves, then mapped the way the spec maps a fractal sum:
// (turb + 1) / 2, clamped as the 8-bit channel it becomes in the browser.
export function turbulenceChannel(nz, channel, x, y, baseFreq, octaves = OCTAVES) {
  return turbAt(nz.lattice, nz.grad[channel], x * baseFreq, y * baseFreq, octaves);
}

// ---------------------------------------------------------------------------
// The phase between the browser's turbulence and this one.
//
// Rasterising `feTurbulence` and reading the pixels back puts the browser's
// value for the pixel at user-space x at this field's x + 1 - half a pixel of
// that being the pixel's own centre, which the loops below already add, and half
// a pixel being the browser's. It is the difference between two crumples that
// look the same and two that are the same.
//
// That half pixel was measured in Chromium and then written down as a constant,
// which is only right where the app runs on Blink. It ships in WKWebView on
// macOS and runs in Firefox in the browser build, and neither one is obliged to
// place its samples where Chromium does. So it is measured here instead, once,
// against the browser actually running: a tiny probe filter is rasterised, and
// the offset that best explains its pixels is the phase. Anywhere the probe
// cannot run - node, a canvas-less environment, a blocked data URL - the
// Chromium value stands, which is the behaviour this replaced.
const DEFAULT_NOISE_PHASE = 0.5;
let NOISE_PHASE = DEFAULT_NOISE_PHASE;

// What the roughening is currently using. Exported for tests and diagnostics.
export function noisePhase() {
  return NOISE_PHASE;
}

const PROBE_PX = 32; // a 32x32 probe is 1024 samples: plenty, and instant
const PROBE_SEED = 3;
// One cycle every 8px, so half a pixel of phase is an eighth of a cycle - far
// enough to tell the candidates apart, and still smooth enough that neither
// renderer's sampling is fighting its own resolution.
const PROBE_FREQ = 0.125;

function probeSvg(n) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}">` +
    `<filter id="p" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse"` +
    ` x="0" y="0" width="${n}" height="${n}" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${PROBE_FREQ}"` +
    ` numOctaves="${OCTAVES}" seed="${PROBE_SEED}"/>` +
    // Turbulence writes noise into the alpha channel too, and a channel read
    // back through an alpha of its own is a channel read back through a
    // rounding error. Forced opaque, R comes out as it went in.
    `<feComponentTransfer><feFuncA type="table" tableValues="1 1"/></feComponentTransfer>` +
    `</filter>` +
    `<rect x="0" y="0" width="${n}" height="${n}" filter="url(#p)"/>` +
    `</svg>`
  );
}

// The browser's own turbulence, as bytes, or null where it cannot be had.
async function probePixels() {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const n = PROBE_PX;
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(probeSvg(n));
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('probe did not decode'));
    i.src = url;
  });
  const cnv = document.createElement('canvas');
  cnv.width = n;
  cnv.height = n;
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  if (!ctx?.drawImage || !ctx.getImageData) return null;
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, n, n);
  // A filter that did not run leaves a flat rectangle; matching a phase against
  // one would answer whatever the search happened to start at.
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  return max - min > 16 ? data : null;
}

// The offset that best explains the probe, searched at a sixteenth of a pixel
// over the range any browser could plausibly be at. `null` when nothing fits,
// which is a browser whose turbulence is not this turbulence at all - and then
// a measured phase would be worse than the default, not better.
function phaseFrom(data) {
  const n = PROBE_PX;
  const nz = noiseFor(PROBE_SEED);
  const lat = nz.lattice;
  const g = nz.grad[0];
  let best = null;
  let bestErr = Infinity;
  for (let k = -16; k <= 24; k++) {
    const phase = k / 16;
    let err = 0;
    for (let y = 0; y < n; y++) {
      const vy = (y + 0.5 + phase) * PROBE_FREQ;
      for (let x = 0; x < n; x++) {
        const want = turbAt(lat, g, (x + 0.5 + phase) * PROBE_FREQ, vy, OCTAVES);
        err += Math.abs(want - data[(y * n + x) * 4] / 255);
      }
    }
    if (err < bestErr) {
      bestErr = err;
      best = phase;
    }
  }
  // Byte quantisation alone costs about 1/512 per sample; anything past a few
  // percent is not this field seen through a shift.
  return bestErr / (n * n) < 0.04 ? best : null;
}

let phasePromise = null;

// Measure the phase once and remember it. Cheap after the first call - it is the
// same promise - and safe to call where there is nothing to measure with.
// Roughening is only exported, never previewed, so nothing pays for this unless
// a box actually asks to be roughened.
export function ensureNoisePhase() {
  if (!phasePromise) {
    phasePromise = (async () => {
      try {
        const data = await probePixels();
        const p = data && phaseFrom(data);
        if (Number.isFinite(p)) NOISE_PHASE = p;
      } catch {
        /* keep the default */
      }
      return NOISE_PHASE;
    })();
  }
  return phasePromise;
}

// Where the pixel drawn at (x, y) takes its colour from, in the same page px
// (x, y) is given in. This is feDisplacementMap's own statement -
// P'(x,y) = P(x + scale*(R-0.5), y + scale*(G-0.5)) - so `amount` means here
// exactly what the filter's `scale` means in the editor: the full span of the
// displacement, half of it either way.
export function roughenOffset(r, x, y) {
  const nz = noiseFor(r?.seed ?? 0);
  const freq = Number(r?.detail) || 0;
  const amount = Number(r?.amount) || 0;
  const px = x + NOISE_PHASE;
  const py = y + NOISE_PHASE;
  return [
    amount * (turbulenceChannel(nz, 0, px, py, freq) - 0.5),
    amount * (turbulenceChannel(nz, 1, px, py, freq) - 0.5),
  ];
}

// Roughen a rendered block: read `src`, write the displaced picture into `dst`.
// Both are ImageData (or anything with `width`, `height` and a `data` of RGBA
// bytes) of the same size.
//
// `ss` is how many device pixels the raster holds per page px, and (originX,
// originY) is where the noise field's origin sits in it, in page px - the corner
// of the element the editor hangs the filter on, so the pattern lands on the
// letters the same way on both sides. A whole pixel is copied rather than
// sampled, which is what the filter does too, and premultiplication cannot
// matter to a copy.
// Four noise lookups per device pixel is the whole cost of this pass, and a
// page-filling roughened box is several million of them on the main thread. The
// loop below spends them only where they can change something:
//
//   - a whole RGBA pixel is one 32-bit word, so "is anything drawn here" is one
//     comparison per pixel rather than four, and one scan of the source gives
//     the first and last drawn column of every row;
//   - a pixel is displaced by at most half of `amount`, so a pixel further than
//     that from every drawn pixel copies a fully zero one whichever way the
//     noise pushes it. Those get their zero written straight out, and the noise
//     is asked only inside the band that can actually pick up ink. On a block of
//     text that is the difference between the whole footprint and the letters.
//
// Both shortcuts are exact rather than approximate: the skipped pixels are the
// ones whose every possible source is zero in all four channels.

// The pixels as 32-bit words, where the bytes are a real view over a buffer.
function wordsOf(bytes, n) {
  try {
    if (bytes?.buffer && bytes.byteOffset % 4 === 0 && bytes.byteLength >= n * 4) {
      return new Uint32Array(bytes.buffer, bytes.byteOffset, n);
    }
  } catch {
    /* not a view over anything: fall back to the byte loops */
  }
  return null;
}

export function roughenPixels(src, dst, r, { ss = 1, originX = 0, originY = 0 } = {}) {
  const w = src.width;
  const h = src.height;
  const s = src.data;
  const d = dst.data;
  const nz = noiseFor(r?.seed ?? 0);
  const lat = nz.lattice;
  const gx = nz.grad[0];
  const gy = nz.grad[1];
  const freq = Number(r?.detail) || 0;
  const amount = Number(r?.amount) || 0;
  const sw = wordsOf(s, w * h);
  const dw = wordsOf(d, w * h);

  // Nothing to displace by: the pass is a copy, and saying so is faster than
  // evaluating a field that will round to zero at every pixel.
  if (amount === 0) {
    if (sw && dw) dw.set(sw);
    else d.set(s);
    return dst;
  }

  // How far a pixel can be pulled from, in device px. `amount` is the full span
  // of the displacement, so half of it either way, and the rounding is worth a
  // pixel more.
  const reach = Math.ceil(Math.abs(amount) * 0.5 * ss) + 1;
  // The drawn span of every row, or -1 for a row with nothing in it.
  const rowLo = new Int32Array(h).fill(-1);
  const rowHi = new Int32Array(h).fill(-1);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    if (!sw) {
      rowLo[y] = 0;
      rowHi[y] = w - 1;
      continue;
    }
    let lo = -1;
    for (let x = 0; x < w; x++) {
      if (sw[base + x] !== 0) {
        lo = x;
        break;
      }
    }
    if (lo < 0) continue;
    let hi = lo;
    for (let x = w - 1; x > lo; x--) {
      if (sw[base + x] !== 0) {
        hi = x;
        break;
      }
    }
    rowLo[y] = lo;
    rowHi[y] = hi;
  }

  const zero = (from, to) => {
    if (from >= to) return;
    if (dw) dw.fill(0, from, to);
    else for (let i = from * 4; i < to * 4; i++) d[i] = 0;
  };

  const invSS = 1 / ss;
  const xBase = 0.5 * invSS - originX + NOISE_PHASE;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    // The rows this one can reach into, and the columns any of them has ink in.
    let lo = w;
    let hi = -1;
    const k0 = y - reach < 0 ? 0 : y - reach;
    const k1 = y + reach > h - 1 ? h - 1 : y + reach;
    for (let k = k0; k <= k1; k++) {
      if (rowHi[k] < 0) continue;
      if (rowLo[k] < lo) lo = rowLo[k];
      if (rowHi[k] > hi) hi = rowHi[k];
    }
    if (hi < 0) {
      zero(base, base + w);
      continue;
    }
    const xlo = lo - reach < 0 ? 0 : lo - reach;
    const xhi = hi + reach > w - 1 ? w - 1 : hi + reach;
    zero(base, base + xlo);
    zero(base + xhi + 1, base + w);

    // Pixel centres, so the field is sampled where the pixel actually is.
    const pyf = ((y + 0.5) * invSS - originY + NOISE_PHASE) * freq;
    for (let x = xlo; x <= xhi; x++) {
      const pxf = (xBase + x * invSS) * freq;
      const ox = Math.round(amount * (turbAt(lat, gx, pxf, pyf, OCTAVES) - 0.5) * ss);
      const oy = Math.round(amount * (turbAt(lat, gy, pxf, pyf, OCTAVES) - 0.5) * ss);
      let sx = x + ox;
      let sy = y + oy;
      if (sx < 0) sx = 0;
      else if (sx >= w) sx = w - 1;
      if (sy < 0) sy = 0;
      else if (sy >= h) sy = h - 1;
      const di = base + x;
      const si = sy * w + sx;
      if (sw && dw) {
        dw[di] = sw[si];
      } else {
        d[di * 4] = s[si * 4];
        d[di * 4 + 1] = s[si * 4 + 1];
        d[di * 4 + 2] = s[si * 4 + 2];
        d[di * 4 + 3] = s[si * 4 + 3];
      }
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// Motion blur.
//
// An iterated-gaussian smear, restated as a flat tap list. It runs `amount`
// iterations of the Experience-Monks 5-tap gaussian, each iteration at a
// growing spread (`size = amount - i`), and divides the sum by `amount + 1` -
// which dims the picture by amount/(amount+1), and that dimming is part of
// the look, so it is kept. Every sample is a point mass on the line through
// the direction vector, so the whole thing collapses to one weighted tap
// list, computed here once and executed by BOTH renderers: the editor as an
// SVG feOffset + feComposite/arithmetic accumulation chain, the exporter as
// 'lighter' canvas draws at each tap's weight. One list, two executions, the
// same smear.
//
// `x`/`y` are the blur direction in pixels per unit step, `amount` the
// iteration count. Direction (0,0) means no taps at all: an iterated gaussian
// at zero offset would still dim by 1/(amount+1), but a smear control that
// only darkens is a bug, not a look.
const MB_OFF1 = 1.3846153846;
const MB_OFF2 = 3.2307692308;
const MB_W0 = 0.227027027;
const MB_W1 = 0.3162162162;
const MB_W2 = 0.0702702703;

export function motionBlurTaps(x, y, amount) {
  const dx = Number(x) || 0;
  const dy = Number(y) || 0;
  if (dx === 0 && dy === 0) return [];
  const it = Math.min(32, Math.max(1, Math.round(Number(amount) || 0)));
  const norm = 1 / (it + 1);
  // The centre tap is sampled once per iteration, always at the origin.
  const out = [{ dx: 0, dy: 0, w: MB_W0 * it * norm }];
  for (let s = 1; s <= it; s++) {
    for (const [c, w] of [[MB_OFF1, MB_W1], [MB_OFF2, MB_W2]]) {
      out.push({ dx: c * dx * s, dy: c * dy * s, w: w * norm });
      out.push({ dx: -c * dx * s, dy: -c * dy * s, w: w * norm });
    }
  }
  return out;
}

// The editor's live filter pays for taps in a way the exporter does not: every
// named result in an SVG filter chain is its own raster surface in WebKit, so
// 129 taps on one box is hundreds of megabytes of backing store the canvas
// path never allocates. The preview therefore samples the same smear coarser:
// at most `maxIt` iterations stretched over the full extent (offsets scale
// with the step, so scaling the direction keeps the reach), re-dimmed to the
// full list's it/(it+1) brightness so the preview and the export match in
// tone. The exporter keeps calling `motionBlurTaps` - its accumulation is flat
// canvas draws, where taps are nearly free.
export function motionBlurPreviewTaps(x, y, amount, maxIt = 8) {
  const dx = Number(x) || 0;
  const dy = Number(y) || 0;
  if (dx === 0 && dy === 0) return [];
  const it = Math.min(32, Math.max(1, Math.round(Number(amount) || 0)));
  if (it <= maxIt) return motionBlurTaps(dx, dy, it);
  const stretch = it / maxIt;
  const dim = (it / (it + 1)) / (maxIt / (maxIt + 1));
  return motionBlurTaps(dx * stretch, dy * stretch, maxIt).map((t) => ({ ...t, w: t.w * dim }));
}

// How far the smear can carry ink past the glyphs, in page px: the furthest
// tap, plus a pixel for the rounding.
export function motionBlurExtent(mb) {
  if (!mb?.on) return 0;
  const d = Math.hypot(Number(mb.x) || 0, Number(mb.y) || 0);
  if (d === 0) return 0;
  const it = Math.min(32, Math.max(1, Math.round(Number(mb.amount) || 0)));
  return Math.ceil(MB_OFF2 * d * it) + 1;
}

// ---------------------------------------------------------------------------
// The whole-text filters, over a finished raster: the gaussian blur, then the
// directional smear, then the roughening - the order the editor's CSS filter
// list states, and a filter list is applied left to right, so a crumpled edge
// is crumpled after it was softened rather than softened away.
//
// One statement for both renderers. The exporter runs it over a box's whole
// composite; the editor's ink canvas runs it over the ink, because the ink is
// a canvas and cannot hang the text stack's CSS filter - and until it did, the
// editor showed crisp ink on a blurred, smeared or crumpled box that the file
// then blurred, smeared and crumpled.
//
// `ss` is the raster's device px per page px, so every number here is stated
// in page px and applied in device px, and `origin` is where the roughening's
// noise field starts in the raster, in page px (see `roughenPixels`). Returns
// the finished canvas: `cnv` itself where only the roughening ran (it works in
// place), otherwise a new one. Every intermediate this makes and supersedes has
// its pixels handed back here, so the caller only ever owns `cnv` and the one
// canvas returned.
export function applyTextFilters(cnv, s, ss, origin = { x: 0, y: 0 }) {
  let out = cnv;
  const make = () => {
    const c = document.createElement('canvas');
    c.width = cnv.width;
    c.height = cnv.height;
    return c;
  };
  const drop = (c) => {
    if (c === cnv) return;
    c.width = 0;
    c.height = 0;
  };
  // Canvas filters are stated in device pixels, hence the ss.
  if (s.blur > 0) {
    out = make();
    const octx = out.getContext('2d');
    octx.filter = `blur(${s.blur * ss}px)`;
    octx.drawImage(cnv, 0, 0);
    octx.filter = 'none';
  }
  // The tap list is the shader's whole sum flattened (see motionBlurTaps); an
  // empty transparent canvas plus 'lighter' draws is an exact weighted sum,
  // where source-over would composite instead of adding.
  const taps = s.motionBlur?.on ? motionBlurTaps(s.motionBlur.x, s.motionBlur.y, s.motionBlur.amount) : [];
  if (taps.length) {
    const acc = make();
    const actx = acc.getContext('2d');
    actx.globalCompositeOperation = 'lighter';
    for (const t of taps) {
      actx.globalAlpha = t.w;
      actx.drawImage(out, t.dx * ss, t.dy * ss);
    }
    drop(out);
    out = acc;
  }
  if (s.roughen?.on) {
    const ctx = out.getContext('2d');
    const src = ctx.getImageData(0, 0, out.width, out.height);
    const dst = ctx.createImageData(out.width, out.height);
    roughenPixels(src, dst, s.roughen, { ss, originX: origin.x, originY: origin.y });
    ctx.putImageData(dst, 0, 0);
  }
  return out;
}

// Whether `applyTextFilters` has anything to do for this style.
export function textFiltersActive(s) {
  return (
    (Number(s?.blur) || 0) > 0 ||
    motionBlurExtent(s?.motionBlur) > 0 ||
    s?.roughen?.on === true
  );
}

// ---------------------------------------------------------------------------
// The visibility mask.
//
// Paints the style's mask shapes as opaque ink into `ctx`, in the same
// box-local page px the shapes are stored in. What the caller does with the
// ink is the mode: the exporter composites it 'destination-in' (include) or
// 'destination-out' (exclude) over the finished raster, the editor turns the
// same drawing into a CSS mask-image. One painter, so the two masks are the
// one mask.
export function drawClipShapes(ctx, shapes) {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const sh of shapes ?? []) {
    if (sh.kind === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(sh.cx, sh.cy, sh.rx, sh.ry, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (sh.kind === 'poly') {
      ctx.beginPath();
      sh.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.closePath();
      ctx.fill();
    } else if (sh.kind === 'stroke') {
      if (sh.pts.length === 1) {
        // A click with no drag: the brush's dot.
        ctx.beginPath();
        ctx.arc(sh.pts[0][0], sh.pts[0][1], sh.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        sh.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.lineWidth = sh.size;
        ctx.stroke();
      }
    }
  }
}

// The rectangle `drawClipShapes` paints for these shapes, box-local page px, as
// `{ minX, minY, maxX, maxY }`, or null when none of them paints anything: an
// ellipse's own box, a polygon's points, a brush stroke's points grown by half
// its width (its caps and joins are round, so no further). An include mask
// shows nothing outside it, which is what the containment check reads it for.
export function clipShapesBounds(shapes) {
  let out = null;
  const add = (x0, y0, x1, y1) => {
    if (![x0, y0, x1, y1].every(Number.isFinite)) return;
    out = out
      ? { minX: Math.min(out.minX, x0), minY: Math.min(out.minY, y0), maxX: Math.max(out.maxX, x1), maxY: Math.max(out.maxY, y1) }
      : { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  };
  for (const sh of shapes ?? []) {
    if (sh?.kind === 'ellipse') {
      const rx = Math.abs(+sh.rx);
      const ry = Math.abs(+sh.ry);
      add(+sh.cx - rx, +sh.cy - ry, +sh.cx + rx, +sh.cy + ry);
    } else if (sh?.kind === 'poly' || sh?.kind === 'stroke') {
      const r = sh.kind === 'stroke' ? Math.max(0, +sh.size || 0) / 2 : 0;
      for (const p of sh.pts ?? []) add(+p?.[0] - r, +p?.[1] - r, +p?.[0] + r, +p?.[1] + r);
    }
  }
  return out;
}

// The same shapes moved by (dx, dy) box-local px, as new objects: what carries
// a mask with its box when the box grows around it (`growAround`, contain.js).
export function translateClipShapes(shapes, dx, dy) {
  return (Array.isArray(shapes) ? shapes : []).map((sh) => {
    if (sh?.kind === 'ellipse') return { ...sh, cx: sh.cx + dx, cy: sh.cy + dy };
    if (Array.isArray(sh?.pts)) return { ...sh, pts: sh.pts.map((q) => [q[0] + dx, q[1] + dy]) };
    return sh;
  });
}

// Whether the mask changes anything at all: on, with at least one shape.
export function clipActive(clip) {
  return !!(clip?.on && (clip.shapes?.length ?? 0) > 0);
}

// ---------------------------------------------------------------------------
// Hand-drawn ink.
//
// The same arrangement the mask uses: one painter, called by the editor's
// overlay canvas and by the exporter's box canvas, so what is on screen and
// what lands in the file are the one drawing. Coordinates are box-local page
// px; the caller has already translated to the box's top-left.

// Whether the ink draws anything at all: on, with at least one stroke.
export function inkActive(ink) {
  return !!(ink?.on && (ink.strokes?.length ?? 0) > 0);
}

// How far the ink reaches outside the box past its origin, in page px on the
// furthest edge. The export pads its canvas by this so a stroke drawn over the
// box edge is not cut off - the same job `motionBlurExtent` does for the smear.
// Only the outward overhang counts: ink inside the box needs no padding, and
// the origin sides are the only ones a stroke can be measured against without
// the box's size. Measuring the far edges the same way - from the origin - would
// pad every inked box by its own width, since ink normally covers the box.
export function inkExtent(ink) {
  if (!inkActive(ink)) return 0;
  let out = 0;
  for (const k of ink.strokes) {
    const b = strokeBounds(k);
    if (!b) continue;
    out = Math.max(out, -b.minX, -b.minY);
  }
  return Math.ceil(Math.max(0, out));
}

// How far a list of shadows throws ink past the shape that casts them, page
// px: the furthest offset (a diagonal, not the sum of its legs) plus the tail
// of its blur. The shadow is blurred at sigma = blur / 2 and a gaussian is done
// at about three sigma, so twice the named blur clears it with room to spare.
export function shadowExtent(shadows) {
  let out = 0;
  for (const sh of shadows ?? []) {
    out = Math.max(
      out,
      Math.hypot(Number(sh?.x) || 0, Number(sh?.y) || 0) + 2 * Math.max(0, Number(sh?.blur) || 0),
    );
  }
  return out;
}

// The box-local rectangle every stroke's ink reaches, or null for no ink. The
// containment check counts the ink with it (contain.js) and the export grows
// its footprint by it past the box's far edges (`layoutBox`), so it is the one
// statement of where a box's ink goes.
export function inkBounds(ink) {
  let out = null;
  for (const k of ink.strokes) {
    const b = strokeBounds(k);
    if (!b) continue;
    if (!out) out = { ...b };
    else {
      out.minX = Math.min(out.minX, b.minX);
      out.minY = Math.min(out.minY, b.minY);
      out.maxX = Math.max(out.maxX, b.maxX);
      out.maxY = Math.max(out.maxY, b.maxY);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The finish: the box's strokes drawn around the WHOLE of its ink as one shape,
// and its shadows thrown from that shape. The same `strokes` and `shadows` the
// type wears - a sound effect's outline is the same idea as a caption's, and
// the Inspector's Stroke and Shadow tabs edit both - but drawn a different way,
// because ink has no outline to stroke along: it is dilated in pixels instead.
// Around the whole and not around each stroke, since a letter is several
// strokes and an outline threading between them is not an outline.

// The finish as the painter uses it: the bands in paint order and the shadows
// as given, or null when there is nothing to draw. Takes the style itself, or
// anything with `strokes` and `shadows` in the style's shape.
function finishOf(f) {
  const bands = strokeBands(f?.strokes);
  const shadows = Array.isArray(f?.shadows) ? f.shadows : [];
  return bands.length || shadows.length ? { bands, shadows } : null;
}

// How far a box's ink reaches outside the box, page px on the furthest edge,
// finish included: the overhang of the strokes themselves, plus the outermost
// band around them, plus the furthest a shadow throws that. What the editor's
// canvas and the export's footprint pad by.
export function inkReach(style) {
  if (!inkActive(style?.ink)) return 0;
  return inkExtent(style.ink) + Math.ceil(strokeExtent(style.strokes) + shadowExtent(style.shadows));
}

// The Euclidean distance from every pixel to the nearest one with alpha at or
// over `T`, in px; 0 for those pixels themselves. Felzenszwalb and
// Huttenlocher's transform: a lower envelope of parabolas along every row and
// then every column, so the cost is the plane and not the plane times the
// radius - and the result is exact and round, where a separable min/max
// filter (see `erodeAlpha`) is square at the corners. A square structuring
// element is fine for a rim a few px wide; an outline is the shape people look
// at, and a square-cornered outline around a round dab is a wrong picture.
export function distanceOutside(alpha, w, h, T) {
  // Far enough that no squared distance in a canvas comes near it, and small
  // enough that adding a squared index to it stays exact in a double.
  const BIG = 1e10;
  const n = w * h;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = alpha[i] >= T ? 0 : BIG;
  const m = Math.max(w, h);
  const line = new Float64Array(m);
  const d = new Float64Array(m);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) line[x] = f[base + x];
    edt1d(line, w, d, v, z);
    for (let x = 0; x < w; x++) f[base + x] = d[x];
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = f[y * w + x];
    edt1d(line, h, d, v, z);
    for (let y = 0; y < h; y++) f[y * w + x] = Math.sqrt(d[y]);
  }
  return f;
}

// One line of the transform: `d[q]` becomes the least of `f[p] + (q - p)^2`
// over every p, which is the squared distance once f holds squared distances.
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// Paint the finish onto `ctx` from the finished ink in `layer` (device px, the
// same size as the target, drawn through `t`). Shadows first, last one first so
// shadows[0] lands on top; then the bands, outermost first, each a full disc of
// its colour that the next one in covers - the same arrangement the type's
// strokes use, so a translucent band reads the same on ink and on a glyph.
// The caller draws the ink itself over the lot.
//
// Everything happens in one rectangle: the ink's bounds through the transform,
// grown by the outermost band, the furthest shadow and a pixel of slack, and
// clipped to the layer. The distance transform runs once over that rectangle
// and every band and every shadow is a threshold of it.
function paintFinish(ctx, layer, ink, t, fx, alloc) {
  const scale = transformScale(t);
  const outer = fx.bands.length ? fx.bands[0].line / 2 : 0;
  const margin = Math.ceil((outer + shadowExtent(fx.shadows)) * scale) + 2;
  const rect = boundsRect(inkBounds(ink), t, layer.width, layer.height, margin);
  if (!rect) return;
  const lctx = layer.getContext('2d');
  const px = lctx.getImageData(rect.x, rect.y, rect.w, rect.h);
  const n = rect.w * rect.h;
  const alpha = new Uint8ClampedArray(n);
  let top = 0;
  for (let i = 0, j = 3; i < n; i++, j += 4) {
    alpha[i] = px.data[j];
    if (alpha[i] > top) top = alpha[i];
  }
  if (!top) return;
  // Where the ink is: half of the densest it gets, so a translucent stroke
  // and a soft-edged one are outlined at their body rather than nowhere or at
  // the last faint pixel of their fringe.
  const T = Math.max(1, Math.ceil(top / 2));
  const dist = distanceOutside(alpha, rect.w, rect.h, T);
  // The silhouette grown by `r` device px, in one colour, as a canvas the
  // target can composite. The edge is a one-px ramp off the distance; inside
  // the ink's own anti-aliased fringe the ink's coverage wins where it is the
  // larger, so a silhouette grown by nothing is still the ink's own outline.
  const grown = (r, color) => {
    const [cr, cg, cb] = channels(color);
    const d = px.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = alpha[i];
      let cov = 1;
      if (a < T) cov = Math.min(1, Math.max(0, a / T, r + 0.5 - dist[i]));
      d[j] = cr;
      d[j + 1] = cg;
      d[j + 2] = cb;
      d[j + 3] = cov * 255;
    }
    const c = alloc(rect.w, rect.h);
    c.getContext('2d').putImageData(px, 0, 0);
    return c;
  };
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let i = fx.shadows.length - 1; i >= 0; i--) {
    const sh = fx.shadows[i];
    const c = grown(outer * scale, sh.color);
    ctx.globalAlpha = Math.min(1, Math.max(0, Number(sh.opacity) || 0));
    // A canvas filter's radius is in device px, and a canvas shadow's blur is
    // twice its gaussian sigma while a filter's is the sigma itself - so half.
    const blur = Math.max(0, Number(sh.blur) || 0);
    ctx.filter = blur > 0 ? `blur(${(blur / 2) * scale}px)` : 'none';
    // The offset through the transform's linear part: 3 px right on the page
    // is 6 device px at 2x, and turns with a rotated box.
    const ox = Number(sh.x) || 0;
    const oy = Number(sh.y) || 0;
    ctx.drawImage(c, rect.x + t.a * ox + t.c * oy, rect.y + t.b * ox + t.d * oy);
    releaseCanvas(c);
  }
  ctx.filter = 'none';
  for (const band of fx.bands) {
    const c = grown((band.line / 2) * scale, band.color);
    ctx.globalAlpha = band.opacity;
    ctx.drawImage(c, rect.x, rect.y);
    releaseCanvas(c);
  }
  ctx.restore();
}

// One stamp of a round tip. `hardness` 100 is a flat disc; below that the edge
// falls off, which is the only way a synthesised tip can look like anything
// other than a marker pen.
//
// `hardness` belongs to this tip and to no other: an imported tip carries its
// edge in its own pixels, and CSP ignores the setting for a pattern tip in the
// same way. The stroke still stores it, for the moment the letterer switches
// the same settings back to round.
function stampRound(ctx, s, alpha, color, hardness, flatness) {
  const r = s.size / 2;
  ctx.save();
  ctx.translate(s.x, s.y);
  if (s.angle) ctx.rotate((s.angle * Math.PI) / 180);
  if (s.fx === -1 || s.fy === -1) ctx.scale(s.fx ?? 1, s.fy ?? 1);
  if (flatness !== 1) ctx.scale(1, flatness);
  ctx.globalAlpha = alpha;
  if (hardness >= 100) {
    ctx.fillStyle = color;
  } else {
    // A radial ramp from solid to clear. The solid core is the hardness, so
    // hardness 0 is a fully soft dab and 99 is a disc with a one-percent edge.
    const g = ctx.createRadialGradient(0, 0, r * (hardness / 100), 0, 0, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
  }
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Imported tips.
//
// A `.sut` tip arrives as an 8-bit greyscale image with the ink at 255 - a
// coverage mask, not a picture - so stamping it is two problems: it has to be
// tinted to the stroke's colour, and it has to be drawn at a fraction of its
// own size without the shimmer a per-stamp downscale of a 2000 px tip gives.
//
// Both are answered once per (tip, colour) and then reused by every stamp:
//
//   * The tint is a canvas whose RGB is the ink's colour and whose ALPHA is the
//     tip's grey. Per stamp it would be a full-resolution pixel pass each time,
//     which is the difference between a brush that draws and one that hangs.
//   * The mip chain halves that canvas until the short side would drop under
//     `MIP_MIN`, and a stamp draws from the smallest level still at least as
//     big as it needs. Downscaling by less than 2x is what a canvas resamples
//     well; downscaling a 2352 px tip to 24 px in one step is what makes a
//     stroke crawl and sparkle as the size dynamics move.
//
// The chain hangs off the tip wrapper the library handed us, so the library's
// cache owns its lifetime: when a tip is evicted or forgotten, the wrapper goes
// and its canvases go with it. See THE TIP LIFETIME CONTRACT in
// `brush-library.svelte.js` - a painter holds a tip for one frame and re-asks.

// The short side a mip level may not go under. Below this the levels stop
// being useful (a stamp that small is a smudge either way) and the chain is
// mostly bookkeeping.
const MIP_MIN = 32;

// How many colours of one tip are kept. Two was too tight: a page that letters
// in three colours with one brush evicts a chain it is about to need again, and
// the rebuild is a full-canvas tint - up to 2048 x 2048 - run synchronously in
// the middle of a pointer move. Four covers a page's palette, and the memory it
// can cost is bounded on both sides: a chain is at most TINT_MAX squared of
// RGBA plus its halvings, so 16 MB and change, four of them is ~67 MB per tip,
// and how many tips can be alive at once is the library's own 24 MP budget.
const TINT_SLOTS = 4;

// The longest side a tinted chain is built at. The corpus has tips up to
// 2352 x 11394, and a tinted copy of one is 107 MB of canvas held for as long
// as the library keeps the tip - on top of the decoded tip the library's own
// budget already accounts for. Nothing stamps a brush 2048 device px across, so
// the cap costs no picture anyone will see and keeps the tint a fraction of the
// tip rather than a second copy of it. The full-resolution read still happens -
// there is no other way to get at the grey - but it is handed back at once.
export const TINT_MAX = 2048;

// Hand a canvas's pixels back rather than waiting for a collection - the same
// thing `drawInk` does with its layers, and for the same reason.
function releaseCanvas(c) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

// The tip's own pixel size. The decoded image is the authority where it has
// one; the index's dimensions are what a platform without a decoder knows.
function tipSize(tip) {
  const w = Number(tip?.image?.width) || Number(tip?.width) || 0;
  const h = Number(tip?.image?.height) || Number(tip?.height) || 0;
  return w > 0 && h > 0 ? [w, h] : null;
}

// The "colour" key under which a tip's density image is cached beside its
// tints - see `buildTinted`. Not a colour, so it can never collide with one.
const DENSITY = 'density';

// The tinted tip and its mip chain, biggest first. Null when the tip cannot be
// read - no decoded image, or a canvas that will not give its pixels back
// (a tainted one), both of which fall the stroke back to the round dab.
function buildTinted(tip, color, alloc) {
  const size = tipSize(tip);
  if (!size || !tip.image) return null;
  const [w, h] = size;
  const base = alloc(w, h);
  const bctx = base?.getContext?.('2d');
  if (!bctx) return null;
  let px;
  try {
    bctx.drawImage(tip.image, 0, 0, w, h);
    px = bctx.getImageData(0, 0, w, h);
  } catch {
    releaseCanvas(base);
    return null;
  }
  const d = px.data;
  if (color === DENSITY) {
    // Density as darkness on an opaque image: white is no ink, black is full.
    // What the darken blend needs - two of these composited with `darken`
    // keep the denser of the two, where two alpha tips would add up.
    for (let i = 0; i < d.length; i += 4) {
      const cov = (d[i] * d[i + 3]) / 255;
      d[i] = 255 - cov;
      d[i + 1] = 255 - cov;
      d[i + 2] = 255 - cov;
      d[i + 3] = 255;
    }
  } else {
    const [r, g, b] = channels(color);
    // The tip is greyscale, so one channel is the grey; its own alpha is
    // opaque across the whole image, and multiplying by it costs nothing and
    // keeps a hand-made RGBA tip honest.
    for (let i = 0; i < d.length; i += 4) {
      const cov = (d[i] * d[i + 3]) / 255;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = cov;
    }
  }
  bctx.putImageData(px, 0, 0);
  const levels = [capTint(base, alloc)];
  let cur = levels[0];
  // Halve while the halved level still has a usable short side. Halving rather
  // than jumping straight to the size a stamp wants is what keeps the average
  // right: each level is the box filter of the one above it.
  while (Math.min(cur.width, cur.height) >= MIP_MIN * 2) {
    const nw = Math.max(1, Math.round(cur.width / 2));
    const nh = Math.max(1, Math.round(cur.height / 2));
    if (nw === cur.width && nh === cur.height) break;
    const next = alloc(nw, nh);
    const nctx = next?.getContext?.('2d');
    if (!nctx) break;
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(cur, 0, 0, nw, nh);
    levels.push(next);
    cur = next;
  }
  return levels;
}

// The tinted tip at no more than `TINT_MAX` on its longest side, handing the
// full-resolution one back when it had to shrink.
function capTint(full, alloc) {
  const long = Math.max(full.width, full.height);
  if (long <= TINT_MAX) return full;
  const k = TINT_MAX / long;
  const cw = Math.max(1, Math.round(full.width * k));
  const ch = Math.max(1, Math.round(full.height * k));
  const small = alloc(cw, ch);
  const sctx = small?.getContext?.('2d');
  if (!sctx) return full;
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(full, 0, 0, cw, ch);
  releaseCanvas(full);
  return small;
}

// The chain for this tip in this colour, built on first use and then reused.
function tipLevels(tip, color, alloc) {
  if (!tip) return null;
  let byColour = tip.tinted;
  if (!(byColour instanceof Map)) {
    byColour = new Map();
    tip.tinted = byColour;
  }
  const key = String(color ?? '#000000').toLowerCase();
  const had = byColour.get(key);
  if (had) {
    // Touch: insertion order is least recently used first.
    byColour.delete(key);
    byColour.set(key, had);
    return had;
  }
  const levels = buildTinted(tip, color, alloc);
  if (!levels) return null;
  byColour.set(key, levels);
  while (byColour.size > TINT_SLOTS) {
    const oldest = byColour.keys().next().value;
    for (const c of byColour.get(oldest)) releaseCanvas(c);
    byColour.delete(oldest);
  }
  return levels;
}

// The level to stamp from: the smallest one still at least as wide as the
// stamp will be drawn on the device. Anything smaller would be upscaled, which
// is blur; anything bigger is a downscale the chain has already paid for.
export function pickTipLevel(levels, devicePx) {
  let out = levels[0];
  for (let i = 1; i < levels.length; i++) {
    if (Math.max(levels[i].width, levels[i].height) < devicePx) break;
    out = levels[i];
  }
  return out;
}

// One stamp of an imported tip. The tip's LONGEST side is the stamp's size, so
// a tall tip stays tall and a stroke's size means the same thing whichever
// brush is loaded; `flatness` then squashes the tip's own y axis, exactly as it
// squashes the round dab's, so the two tips read the same at the same setting.
function stampTip(ctx, s, alpha, levels, natural, flatness, smooth, scale) {
  const [nw, nh] = natural;
  if (s.len > 0) return sliceTip(ctx, s, alpha, levels, nw, nh, smooth, scale);
  const f = s.size / Math.max(nw, nh);
  const dw = nw * f;
  const dh = nh * f;
  if (!(dw > 0) || !(dh > 0)) return;
  ctx.save();
  ctx.translate(s.x, s.y);
  if (s.angle) ctx.rotate((s.angle * Math.PI) / 180);
  // The flips, in the tip's own frame: after the turn, so a flipped tip is
  // the mirror of the turned one and not a turn the other way.
  if (s.fx === -1 || s.fy === -1) ctx.scale(s.fx ?? 1, s.fy ?? 1);
  if (flatness !== 1) ctx.scale(1, flatness);
  ctx.globalAlpha = alpha;
  // The pixel look CSP gives with anti-aliasing off starts here: a tip drawn
  // through a smoothing resample would arrive with a soft edge for the snap to
  // find, and half of it would land on the wrong side.
  ctx.imageSmoothingEnabled = smooth;
  if (smooth) ctx.imageSmoothingQuality = 'high';
  // The tip's longest side IS the stamp's size, so that - through the
  // transform - is the device size the chain has to answer for.
  ctx.drawImage(pickTipLevel(levels, s.size * scale), -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

// One slice of a ribbon: CSP's Stroke > Ribbon, where the tip is not pressed
// down again and again but unrolled along the path as one continuous band.
// The tip's WIDTH is the band's width - the stroke's size at this point - and
// its height runs along the stroke at the same scale, repeating once it is
// used up. `s.d` says how far along the path this slice sits and `s.len` how
// much of the path it covers; the slice is the rows of the tip that belong to
// that stretch, drawn across the path in the frame `strokeStamps` has already
// turned to face it.
function sliceTip(ctx, s, alpha, levels, nw, nh, smooth, scale) {
  const f = s.size / nw; // page px per tip px
  const period = nh * f; // how much path one pass of the tip covers
  if (!(f > 0) || !(period > 0)) return;
  const level = pickTipLevel(levels, Math.max(s.size, s.len) * scale);
  const k = level.height / nh; // level px per tip px
  ctx.save();
  ctx.translate(s.x, s.y);
  if (s.angle) ctx.rotate((s.angle * Math.PI) / 180);
  if (s.fx === -1 || s.fy === -1) ctx.scale(s.fx ?? 1, s.fy ?? 1);
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = smooth;
  if (smooth) ctx.imageSmoothingQuality = 'high';
  // The stretch of tip this slice shows, in tip px, from the top of the image
  // at the start of the stroke; wrapped where it runs past the bottom, in
  // which case the slice is drawn in two parts so the join is seamless.
  let v0 = ((s.d - s.len / 2) % period + period) % period / f;
  let left = s.len / f;
  let y = -s.len / 2;
  while (left > 1e-6) {
    const take = Math.min(left, nh - v0);
    const dh = take * f;
    ctx.drawImage(level, 0, v0 * k, level.width, take * k, -s.size / 2, y, s.size, dh);
    y += dh;
    left -= take;
    v0 = 0;
  }
  ctx.restore();
}

// The tip a stroke stamps with, or null for the round dab. Null covers every
// way an imported brush can fail to be there - the stroke was drawn with the
// round tip, the caller prefetched nothing, the tip has not finished decoding,
// the brush is missing from this install - and in all of them the stroke draws
// round FOR THIS FRAME while keeping the brush id it was drawn with. See
// `resolveBrush`: the fallback is a reading, never a rewrite.
function tipFor(k, tips) {
  const id = k?.brush;
  if (!tips || !id || id === 'round') return null;
  const tip = typeof tips.get === 'function' ? tips.get(id) : tips[id];
  return tip?.image && tipSize(tip) ? tip : null;
}

// ---------------------------------------------------------------------------
// The watercolour edge: CSP's darkened rim, where the pigment pools as the
// water dries. It is a post-pass over the finished stroke's alpha, never a
// property of the tip - a stamp has no idea where the stroke's outline is, so
// running it per dab would ring every overlap down the middle of the line
// instead of drawing one rim around the whole thing.

// How many device px one page px is worth under `t`. The editor hands drawInk
// its zoom, the exporter its supersample and the brush panel its pixel ratio,
// and a band stated in page px has to come out the same width in all three - so
// the pass takes its radius from the transform it was actually given rather
// than from a scale passed alongside it. The square root of the determinant is
// the area scale, which stays honest under rotation and mirroring.
export function transformScale(t) {
  const det = Math.abs((t?.a ?? 1) * (t?.d ?? 1) - (t?.b ?? 0) * (t?.c ?? 0));
  return det > 0 ? Math.sqrt(det) : 1;
}

// The smallest value in every window of 2r+1 along one line of the plane.
// Anything past the ends counts as clear, so the first and last r entries erode
// to nothing - which is what they are, since the ink stops there. A monotonic
// deque, so the cost is the plane and not the plane times the radius: the
// radius follows the zoom, and a 20 px band at 400% is an 80 px window.
function minLine(src, dst, n, base, stride, r, dq) {
  let head = 0;
  let tail = 0;
  for (let j = 0; j < n; j++) {
    const v = src[base + j * stride];
    while (tail > head && src[base + dq[tail - 1] * stride] >= v) tail--;
    dq[tail++] = j;
    // The window ending at j is centred on j - r, and is only whole once that
    // centre is r past the start.
    const i = j - r;
    if (i >= r) {
      while (dq[head] < j - 2 * r) head++;
      dst[base + i * stride] = src[base + dq[head] * stride];
    }
  }
}

// The alpha plane shrunk by r px on every side: a pixel keeps its value only if
// nothing fainter sits within r of it. Two separable passes, which makes the
// structuring element a square rather than a disc - at these radii that is a
// fraction of a pixel out at the diagonals, and it costs an order of magnitude
// less than the true disc.
export function erodeAlpha(alpha, w, h, r) {
  const dq = new Int32Array(Math.max(w, h));
  const tmp = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) minLine(alpha, tmp, w, y * w, 1, r, dq);
  const out = new Uint8ClampedArray(w * h);
  for (let x = 0; x < w; x++) minLine(tmp, out, h, x, w, r, dq);
  return out;
}

// The largest value in every window of 2r+1 along one line of the plane: the
// mirror of `minLine`, for growing the ink instead of shrinking it.
function maxLine(src, dst, n, base, stride, r, dq) {
  let head = 0;
  let tail = 0;
  for (let j = 0; j < n; j++) {
    const v = src[base + j * stride];
    while (tail > head && src[base + dq[tail - 1] * stride] <= v) tail--;
    dq[tail++] = j;
    const i = j - r;
    if (i >= r) {
      while (dq[head] < j - 2 * r) head++;
      dst[base + i * stride] = src[base + dq[head] * stride];
    }
  }
  // The last r centres never see a whole window; they take the biggest of
  // what is left, since past the end of the plane there is nothing at all.
  for (let i = Math.max(0, n - r); i < n; i++) {
    let m = 0;
    for (let j = Math.max(0, i - r); j < n; j++) {
      const v = src[base + j * stride];
      if (v > m) m = v;
    }
    dst[base + i * stride] = m;
  }
}

// The alpha plane grown by r px on every side: a pixel takes the densest
// value within r of it. The same separable square as `erodeAlpha`, for the
// same reason.
export function dilateAlpha(alpha, w, h, r) {
  const dq = new Int32Array(Math.max(w, h));
  const tmp = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) maxLine(alpha, tmp, w, y * w, 1, r, dq);
  // The first r centres of every line are left at zero by the windowed pass;
  // fill them the same way the tail is filled.
  for (let y = 0; y < h; y++) {
    for (let i = 0; i < Math.min(r, w); i++) {
      let m = 0;
      for (let j = 0; j <= Math.min(w - 1, i + r); j++) if (alpha[y * w + j] > m) m = alpha[y * w + j];
      tmp[y * w + i] = m;
    }
  }
  const out = new Uint8ClampedArray(w * h);
  for (let x = 0; x < w; x++) maxLine(tmp, out, h, x, w, r, dq);
  for (let x = 0; x < w; x++) {
    for (let i = 0; i < Math.min(r, h); i++) {
      let m = 0;
      for (let j = 0; j <= Math.min(h - 1, i + r); j++) if (tmp[j * w + x] > m) m = tmp[j * w + x];
      out[i * w + x] = m;
    }
  }
  return out;
}

// A box blur of radius r over one plane, run twice, which is close enough to
// a gaussian for a rim a few px wide. In place.
function blurPlane(plane, w, h, r) {
  if (!(r > 0)) return plane;
  const tmp = new Float32Array(w * h);
  const pass = (src, dst, n, base, stride) => {
    let sum = 0;
    for (let j = 0; j <= Math.min(n - 1, r); j++) sum += src[base + j * stride];
    for (let i = 0; i < n; i++) {
      const lo = i - r;
      const hi = i + r;
      dst[base + i * stride] = sum / (Math.min(n - 1, hi) - Math.max(0, lo) + 1);
      if (lo >= 0) sum -= src[base + lo * stride];
      if (hi + 1 < n) sum += src[base + (hi + 1) * stride];
    }
  };
  const a = Float32Array.from(plane);
  for (let k = 0; k < 2; k++) {
    for (let y = 0; y < h; y++) pass(a, tmp, w, y * w, 1);
    for (let x = 0; x < w; x++) pass(tmp, a, h, x, w);
  }
  for (let i = 0; i < a.length; i++) plane[i] = a[i];
  return plane;
}

// The pass itself, in place over an ImageData's bytes: CSP's watercolour edge,
// which the manual states plainly - "edges that look like a watercolor bleed
// are added to the OUTSIDE of the stroke". The band is what the dilation added
// - every clear or half-clear pixel within `radius` of the ink - and a rim is
// laid down there UNDER the ink:
//
//   - its alpha is the band scaled by `power`, CSP's Opacity;
//   - its colour is the ink's own pulled towards black by `dark`, CSP's
//     Darkness, so a red stroke gets a deep red rim and not a grey one;
//   - `blur` softens the band before it is laid, CSP's Blurring width.
//
// The ink itself is composited over the rim, so a pixel the stroke already
// covers fully comes out byte-identical and only the outline and what lies
// past it change. Power 0 changes nothing at all, so the slider and the switch
// agree. `hard` is the anti-aliasing-off case, where the rim is either there
// or not: a faint rim would otherwise be thrown away by the alpha snap that
// follows, and CSP draws its edge on a pixel layer solid.
export function waterEdgePixels(data, w, h, radius, power, dark = 0, blur = 0, rgb = null, hard = false) {
  const p = Math.min(1, Math.max(0, Number(power) || 0));
  const r = Math.max(1, Math.round(Number(radius) || 0));
  const dk = Math.min(1, Math.max(0, Number(dark) || 0));
  const b = Math.max(0, Math.round(Number(blur) || 0));
  if (p <= 0) return data;
  const n = w * h;
  const alpha = new Uint8ClampedArray(n);
  for (let i = 0, j = 3; i < n; i++, j += 4) alpha[i] = data[j];
  const grown = dilateAlpha(alpha, w, h, r);
  const band = new Float32Array(n);
  for (let i = 0; i < n; i++) band[i] = Math.max(0, grown[i] - alpha[i]);
  if (b > 0) blurPlane(band, w, h, b);
  const ink = rgb ?? [0, 0, 0];
  const rr = ink[0] * (1 - dk);
  const rg = ink[1] * (1 - dk);
  const rb = ink[2] * (1 - dk);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let ar = band[i] * p;
    if (ar <= 0) continue;
    if (hard) ar = ar >= 32 ? 255 : 0;
    if (ar <= 0) continue;
    // Ink over rim: the rim only shows through where the ink is not solid.
    const a = alpha[i] / 255;
    const under = (ar / 255) * (1 - a);
    const ao = a + under;
    if (ao <= 0) continue;
    data[j] = (data[j] * a + rr * under) / ao;
    data[j + 1] = (data[j + 1] * a + rg * under) / ao;
    data[j + 2] = (data[j + 2] * a + rb * under) / ao;
    data[j + 3] = Math.min(255, Math.round(ao * 255));
  }
  return data;
}

// ---------------------------------------------------------------------------
// The grain: CSP's Texture category. The corpus's textured pens all point at
// CSP's stock noise material by id, so what is laid here is the engine's own
// noise at the density and scale the brush asked for - value noise on a grid
// of cells in PAGE px, so the same grain sits at the same place on the page at
// any zoom and any export scale, and two strokes over the same spot share it
// the way CSP's texture is fixed to the canvas rather than to the stroke.

// A cell's grain, 0 (a hole) to 1 (full ink), from its grid position alone.
function grainAt(ix, iy) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// How big one cell of grain is at CSP's 100%, page px. The stock noise
// material is a fine sand at 100 and visible flecks at 300, which is where the
// corpus sets it.
const GRAIN_PX = 1.5;

// The pass, in place over an ImageData's bytes. `t` is the layer's transform,
// `ox`/`oy` where the rect sits in device px, so a device pixel can be walked
// back to the page and looked up in the grid. Alpha only: a hole in the grain
// is less ink, not paler ink.
export function texturePixels(data, w, h, t, ox, oy, texture) {
  const density = Math.min(1, Math.max(0, +texture?.density || 0));
  if (density <= 0) return data;
  const cell = Math.max(0.25, (GRAIN_PX * (+texture.scale || 100)) / 100);
  const det = t.a * t.d - t.b * t.c;
  if (!(Math.abs(det) > 0)) return data;
  // The inverse, applied to (device x, device y) below.
  const ia = t.d / det;
  const ib = -t.b / det;
  const ic = -t.c / det;
  const id = t.a / det;
  const ie = (t.c * t.f - t.d * t.e) / det;
  const iff = (t.b * t.e - t.a * t.f) / det;
  const stress = texture.stress === true;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4 + 3;
      const a = data[j];
      if (a === 0) continue;
      const dx = ox + x + 0.5;
      const dy = oy + y + 0.5;
      const px = ia * dx + ic * dy + ie;
      const py = ib * dx + id * dy + iff;
      let g = grainAt(Math.floor(px / cell), Math.floor(py / cell));
      // Emphasize density: the dark side of the grain pushed harder, so a
      // hole is a hole rather than a faint spot.
      if (stress) g = g * g;
      data[j] = Math.round(a * (1 - density * (1 - g)));
    }
  }
  return data;
}

// CSP's four grades of anti-aliasing as a ramp over the layer's alpha, in
// place: None snaps every pixel to in or out at the halfway point, Weak and
// Middle keep a narrower and a wider band of the ramp, Strong keeps it all.
// The idea is Krita's sharpness option - a threshold above which a pixel goes
// opaque and below which it goes clear, with what lies between left alone.
const AA_RAMPS = [[128, 128], [96, 160], [48, 208]];
export function sharpenAlpha(data, level) {
  const ramp = AA_RAMPS[level];
  if (!ramp) return data;
  const [lo, hi] = ramp;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a === 0) continue;
    if (a >= hi) data[i] = 255;
    else if (a < lo) data[i] = 0;
    else if (hi > lo) data[i] = Math.round(((a - lo) * 255) / (hi - lo));
  }
  return data;
}

// CSP's Compare density: the stroke `src` lands on `dst` where it is denser
// and leaves `dst` alone where it is not, so nothing adds up. `op` is the
// stroke's own opacity, applied to the layer's alpha on the way in exactly as
// the plain composite applies it.
export function densityOver(dst, src, op) {
  for (let i = 0; i < dst.length; i += 4) {
    const sa = src[i + 3] * op;
    if (sa <= 0 || sa <= dst[i + 3]) continue;
    dst[i] = src[i];
    dst[i + 1] = src[i + 1];
    dst[i + 2] = src[i + 2];
    dst[i + 3] = Math.round(sa);
  }
  return dst;
}

// Whether a stroke asks for the edge at all. Read twice - once to decide the
// stroke needs a layer, once to run the pass - so it is stated once here.
function wantsWaterEdge(k) {
  return k?.waterEdge === true && +k.waterEdgePower > 0 && +k.waterEdgeWidth > 0;
}

// The device-px rectangle the pass has to touch: the stroke's own ink, grown by
// the band and a pixel of slack, clipped to the layer. Bounding the read is
// what keeps a live stroke cheap - the alternative is reading a whole layer
// back per stroke per frame - and the margin of clear pixels the padding buys
// is what lets the erosion see an edge where the edge is.
function inkRect(k, stamps, t, w, h, pad) {
  return boundsRect(strokeBounds(k, stamps), t, w, h, pad);
}

// A box-local bounds through `t` into device px, grown by `pad` and clipped
// to a w x h layer; null for no bounds or nothing left after the clip.
function boundsRect(b, t, w, h, pad) {
  if (!b) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of [[b.minX, b.minY], [b.maxX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY]]) {
    const dx = t.a * x + t.c * y + t.e;
    const dy = t.b * x + t.d * y + t.f;
    if (dx < x0) x0 = dx;
    if (dx > x1) x1 = dx;
    if (dy < y0) y0 = dy;
    if (dy > y1) y1 = dy;
  }
  const rx = Math.max(0, Math.floor(x0 - pad));
  const ry = Math.max(0, Math.floor(y0 - pad));
  const rw = Math.min(w, Math.ceil(x1 + pad)) - rx;
  const rh = Math.min(h, Math.ceil(y1 + pad)) - ry;
  if (rw <= 0 || rh <= 0) return null;
  return { x: rx, y: ry, w: rw, h: rh };
}

// Paint every stroke. Stamps overlap heavily by design, so each stroke is drawn
// into its own layer and composited once: stamping straight onto the target at
// a stroke opacity below 1 would darken every overlap and turn a smooth line
// into a string of beads.
//
// `tips` is the decoded tips this frame has in hand, id -> the library's tip
// wrapper. The painter is synchronous and reading a tip off disk is not, so the
// caller prefetches - `settleInkTips` / `settleBoxTips` in `brush-tips.js` - and
// hands the result down. A stroke whose tip is not in there stamps the round
// dab for this frame and keeps its brush id, which is what makes the first
// frame of a chapter draw immediately instead of waiting on a decode.
//
// `finish` is the box's strokes and shadows (the style itself will do), drawn
// around the whole of the ink - see `paintFinish`. With one, the strokes go
// into a layer of their own first, because the finish is a reading of the
// finished ink and there is no finished ink until the last stroke is down.
export function drawInk(ctx, ink, makeCanvas, tips, finish) {
  if (!inkActive(ink)) return;
  const alloc = makeCanvas ?? ((w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  });
  const fx = finishOf(finish);
  // A Compare density stroke is compared against the ink of this block and
  // nothing else: on the page it would lose to the paper, which is opaque. So
  // one such stroke sends the whole block through a layer of its own, the way
  // a finish does.
  const density = ink.strokes.some((k) => k?.blend === 'density');
  if (!fx && !density) {
    paintStrokes(ctx, ink, alloc, tips);
    return;
  }
  const t = ctx.getTransform();
  const layer = alloc(ctx.canvas.width, ctx.canvas.height);
  const lctx = layer.getContext('2d');
  lctx.setTransform(t);
  paintStrokes(lctx, ink, alloc, tips);
  if (fx) paintFinish(ctx, layer, ink, t, fx, alloc);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
  releaseCanvas(layer);
}

// The strokes themselves, one after another onto `ctx`.
function paintStrokes(ctx, ink, alloc, tips) {
  for (const k of ink.strokes) {
    const stamps = strokeStamps(k);
    if (!stamps.length) continue;
    // The caller's transform, read once. The layer below copies it, and the
    // mip chain is asked for the level a stamp lands at through it - so how
    // many device px a page px is worth is one answer serving both paths.
    const t = ctx.getTransform();
    const scale = transformScale(t);
    const tip = tipFor(k, tips);
    const levels = tip ? tipLevels(tip, k.color, alloc) : null;
    const natural = levels ? tipSize(tip) : null;
    // The cycle's other tips, by the index `strokeStamps` put on each stamp.
    // One that is not in hand this frame falls back to the stroke's own, so a
    // half-decoded cycle draws textured rather than dotted with discs.
    const cycleTips = levels && Array.isArray(k.tips) && k.tips.length > 1
      ? k.tips.map((id) => tipFor({ brush: id }, tips))
      : null;
    // The cycle's tips in one "colour" - the stroke's own, the density image,
    // or white - as `{ levels, natural }`, or null where the tip is not in
    // hand or would not tint.
    const cycleIn = (color) => cycleTips?.map((t) => {
      const lv = t ? tipLevels(t, color, alloc) : null;
      return lv ? { levels: lv, natural: tipSize(t) } : null;
    }) ?? null;
    const aa = aaLevel(k.antialias);
    const smooth = aa > 0;
    // The alpha is an argument rather than a field of the stamp, because the
    // layer below draws every stamp at full strength and the stroke's own
    // opacity is applied once to the finished layer. Cloning each stamp to say
    // so allocated an object per dab per frame while the pointer was down.
    // `stamper` is the dab in one colour: the stroke's own for plain ink, the
    // density image for Darken, white for a faded stroke.
    const stamper = (lv, cyc, color) => (lv
      ? (c, st, alpha) => {
        const pick = cyc && st.tip > 0 ? cyc[st.tip] : null;
        if (pick) {
          stampTip(c, st, alpha, pick.levels, pick.natural, st.flat ?? k.flatness, smooth, scale);
        } else {
          stampTip(c, st, alpha, lv, natural, st.flat ?? k.flatness, smooth, scale);
        }
      }
      : (c, st, alpha) => stampRound(c, st, alpha, color, k.hardness, st.flat ?? k.flatness));
    // A stroke the opacity dynamics faded somewhere: at least one dab is
    // lighter than the stroke. Such a stroke cannot be laid dab over dab -
    // ten half-strength dabs on top of each other are a solid line, and the
    // fade would only show at the very ends - so its dabs are composited as
    // the DENSEST WINS, the way CSP and Photoshop lay a pressure-faded pen:
    // drawn white on black at their own strength and merged with lighten,
    // then read back as a mask. That subsumes Darken, which is the same
    // rule in the other direction.
    const fade = stamps.some((st) => st.alpha < k.opacity - 1e-6);
    // CSP's Blend brush tips with Darken: where dabs overlap, the darker wins
    // instead of the two adding up. Only a textured tip can show it - the
    // round dab has nothing inside its edge to keep - and it is drawn as
    // black ink on white with the darken operator, then read back as a mask:
    // for black on white, "darker" and "denser" are the same number.
    const darken = !fade && k.darkenTips === true && !!levels;
    const stamp = fade
      ? stamper(tipLevels(tip, '#ffffff', alloc), cycleIn('#ffffff'), '#ffffff')
      : darken
        ? stamper(tipLevels(tip, DENSITY, alloc), cycleIn(DENSITY), k.color)
        : stamper(levels, cycleIn(k.color), k.color);
    const solid = k.opacity >= 0.999;
    const water = wantsWaterEdge(k);
    const grain = textureActive(k.texture);
    const density = k.blend === 'density';
    // Six reasons to detour through a layer: a translucent stroke must not
    // let its own stamps darken each other where they overlap, a stroke with
    // anything under Strong anti-aliasing needs its finished shape in hand
    // before the edge can be cut, the watercolour edge and the grain are
    // passes over that finished shape too, the darken blend needs a white
    // ground to be read back from, and Compare density is a comparison of
    // the finished stroke against what is under it.
    const layered = !solid || aa < 3 || water || darken || fade || grain || density;
    if (!layered) {
      for (const s of stamps) stamp(ctx, s, s.alpha);
      continue;
    }
    // The layer is only as big as the target; the caller's transform already
    // places the box, so the layer copies that transform rather than guessing
    // its own bounds.
    const layer = alloc(ctx.canvas.width, ctx.canvas.height);
    const lctx = layer.getContext('2d');
    lctx.setTransform(t);
    // Darken and fade both work on an opaque ground - white with darken for
    // one, black with lighten for the other - that is read back as a mask
    // once the dabs are down.
    const ground = darken || fade;
    if (ground) {
      lctx.save();
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.fillStyle = darken ? '#ffffff' : '#000000';
      lctx.fillRect(0, 0, layer.width, layer.height);
      lctx.restore();
      lctx.globalCompositeOperation = darken ? 'darken' : 'lighten';
    }
    if (fade) fadeStamps(lctx, stamps, stamp, k, t, scale, alloc);
    else for (const s of stamps) stamp(lctx, s, 1);
    if (ground) {
      lctx.globalCompositeOperation = 'source-over';
      // Ground to ink mask: how far from the ground a pixel went is how much
      // ink is there, and the ink is the stroke's own colour.
      const [ir, ig, ib] = channels(k.color);
      const px = lctx.getImageData(0, 0, layer.width, layer.height);
      const d = px.data;
      for (let i = 0; i < d.length; i += 4) {
        const a = darken ? 255 - d[i] : d[i];
        d[i] = ir;
        d[i + 1] = ig;
        d[i + 2] = ib;
        d[i + 3] = a;
      }
      lctx.putImageData(px, 0, 0);
    }
    // The pixel passes, once per stroke over its own layer, bounded to the
    // rectangle the stroke's ink can reach. Bounding the read is what keeps a
    // live stroke cheap - the alternative is a whole layer back per stroke
    // per frame - and the stamps are handed on rather than laid out again.
    // The rim lies outside the ink, so the read reaches past the stamps by
    // the band, its blur, and a pixel of slack.
    const r = water ? Math.max(1, Math.round(k.waterEdgeWidth * scale)) : 0;
    const bl = water ? Math.round((k.waterEdgeBlur || 0) * scale) : 0;
    const rect = water || grain || aa < 3 || density
      ? inkRect(k, stamps, t, layer.width, layer.height, r + bl + 2)
      : null;
    if (rect && (water || grain || aa < 3)) {
      const px = lctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      // In CSP's order: the grain is part of laying the ink, the edge is
      // drawn around what was laid, and the anti-aliasing grade is the last
      // word on what is in the stroke and what is out. The edge is cut on
      // the soft alpha the stamps left, and its radius is the band's page px
      // through the caller's transform, which is what keeps the screen and
      // the file the same picture.
      if (grain) texturePixels(px.data, rect.w, rect.h, t, rect.x, rect.y, k.texture);
      if (water) {
        waterEdgePixels(
          px.data, rect.w, rect.h, r, k.waterEdgePower, k.waterEdgeDark, bl, channels(k.color),
          aa === 0,
        );
      }
      if (aa < 3) sharpenAlpha(px.data, aa);
      lctx.putImageData(px, rect.x, rect.y);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (density && rect) {
      // Compare density against the ink already down: the denser wins, and
      // the stroke's opacity goes in on the layer's alpha as it would have
      // through the plain composite.
      const under = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      const over = lctx.getImageData(rect.x, rect.y, rect.w, rect.h);
      densityOver(under.data, over.data, k.opacity);
      ctx.putImageData(under, rect.x, rect.y);
    } else {
      ctx.globalAlpha = k.opacity;
      ctx.drawImage(layer, 0, 0);
    }
    ctx.restore();
    // Hand the pixels back rather than waiting for a collection: a batch export
    // renders one of these per stroke per page.
    layer.width = 0;
    layer.height = 0;
  }
}

// The dabs of a faded stroke onto the black lighten ground in `lctx`.
//
// A dab's strength has to arrive as a BRIGHTNESS, not as an alpha: drawing it
// translucent would alpha-blend with the ground before lighten compares, and
// two half-strength dabs would then read as three-quarters. So each dab is
// drawn white at its own strength onto a black scratch - which lands it as an
// opaque grey exactly that bright - and the scratch is merged with lighten at
// full alpha, where the brighter of the two wins and nothing adds up. The
// scratch is one stamp's reach in device px, allocated once per stroke.
function fadeStamps(lctx, stamps, stamp, k, t, scale, alloc) {
  let reach = 0;
  for (const s of stamps) if (s.size > reach) reach = s.size;
  // A stamp is a square of its size at any angle: sqrt2 over 2 of the size
  // each way, and two px of slack for the edge.
  const half = Math.ceil(reach * Math.SQRT1_2 * scale) + 2;
  const side = Math.min(2 * half, Math.max(lctx.canvas.width, lctx.canvas.height, 2));
  const scratch = alloc(side, side);
  const sctx = scratch.getContext('2d');
  const op = Number(k.opacity) || 1;
  for (const s of stamps) {
    const o = Math.min(1, Math.max(0, s.alpha / op));
    if (o <= 0) continue;
    // Where the stamp's centre lands in device px, and the scratch's corner.
    const cx = t.a * s.x + t.c * s.y + t.e;
    const cy = t.b * s.x + t.d * s.y + t.f;
    const ox = Math.round(cx - half);
    const oy = Math.round(cy - half);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.fillStyle = '#000000';
    sctx.fillRect(0, 0, side, side);
    sctx.setTransform(t.a, t.b, t.c, t.d, t.e - ox, t.f - oy);
    stamp(sctx, s, o);
    lctx.save();
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.drawImage(scratch, ox, oy);
    lctx.restore();
  }
  releaseCanvas(scratch);
}

// Which fill the style asks for. Pattern beats gradient when both are on, which
// is stated once here rather than in each renderer's if-chain.
export function fillKind(style) {
  if (style?.pattern?.on) return 'pattern';
  if (style?.gradient?.on) return 'gradient';
  return 'solid';
}
