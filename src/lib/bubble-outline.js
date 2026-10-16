// The outline-finding ladder is ported from Komatose (MIT), ocr/workflow.py
// at commit d9be51e. Copyright (c) 2026 innominata.
// Masks stay in cropped windows; only the returned polygon uses page pixels.
import { lumaOf, interiorThreshold } from './balloon.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r2 = (v) => Math.round(v * 100) / 100;
const open = (reason) => ({ open: true, reason });
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

function bounds(block, W, H) {
  if (!Array.isArray(block) || block.length !== 4 || !block.every(Number.isFinite)) return null;
  const [a, b, c, d] = block;
  const x1 = clamp(Math.floor(Math.min(a, c)), 0, W);
  const y1 = clamp(Math.floor(Math.min(b, d)), 0, H);
  const x2 = clamp(Math.ceil(Math.max(a, c)), 0, W);
  const y2 = clamp(Math.ceil(Math.max(b, d)), 0, H);
  return x2 > x1 && y2 > y1 ? [x1, y1, x2, y2] : null;
}

function crop(image, box, neighbors, pad) {
  let [x0, y0, x1, y1] = box;
  for (const other of neighbors) {
    x0 = Math.min(x0, other[0]);
    y0 = Math.min(y0, other[1]);
    x1 = Math.max(x1, other[2]);
    y1 = Math.max(y1, other[3]);
  }
  x0 = Math.max(0, Math.floor(x0 - pad));
  y0 = Math.max(0, Math.floor(y0 - pad));
  x1 = Math.min(image.width, Math.ceil(x1 + pad));
  y1 = Math.min(image.height, Math.ceil(y1 + pad));
  const w = x1 - x0;
  const h = y1 - y0;
  const n = w * h;
  const gray = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let y = 0, p = 0; y < h; y++) {
    let i = ((y + y0) * image.width + x0) * 4;
    for (let x = 0; x < w; x++, p++, i += 4) hist[gray[p] = lumaOf(image.data, i)]++;
  }
  const local = [box[0] - x0, box[1] - y0, box[2] - x0, box[3] - y0];
  return {
    x: x0, y: y0, w, h, n, gray, hist, box: local,
    ink: new Uint8Array(n), a: new Uint8Array(n), b: new Uint8Array(n),
    labels: new Int32Array(n), stack: new Int32Array(n),
  };
}

// One stack entry per adjacent run avoids both recursion and a per-pixel queue.
// The extra pixel at either end of a run supplies 8-connectivity for ink only.
function spanFill(c, mask, value, labels, tag, seed, eight = false) {
  const { w, h, stack, box } = c;
  let top = 0;
  stack[top++] = seed;
  let count = 0, hit = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  while (top) {
    const p = stack[--top];
    if (labels[p] || mask[p] !== value) continue;
    const y = (p / w) | 0;
    const base = y * w;
    let l = p - base, r = l;
    while (l > 0 && !labels[base + l - 1] && mask[base + l - 1] === value) l--;
    while (r + 1 < w && !labels[base + r + 1] && mask[base + r + 1] === value) r++;
    labels.fill(tag, base + l, base + r + 1);
    count += r - l + 1;
    x0 = Math.min(x0, l); x1 = Math.max(x1, r);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    if (y >= box[1] && y < box[3]) hit += Math.max(0, Math.min(r + 1, box[2]) - Math.max(l, box[0]));
    for (let dy = -1; dy <= 1; dy += 2) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      const nb = yy * w;
      const end = Math.min(w - 1, r + (eight ? 1 : 0));
      let x = Math.max(0, l - (eight ? 1 : 0));
      while (x <= end) {
        while (x <= end && (labels[nb + x] || mask[nb + x] !== value)) x++;
        if (x > end) break;
        stack[top++] = nb + x;
        while (x <= end && !labels[nb + x] && mask[nb + x] === value) x++;
      }
    }
  }
  return { count, hit, x0, y0, x1, y1, border: x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1, tag };
}

function components(c, mask, value = 1, eight = false) {
  c.labels.fill(0);
  const parts = [];
  for (let i = 0; i < c.n; i++) {
    if (mask[i] === value && !c.labels[i]) parts.push(spanFill(c, mask, value, c.labels, parts.length + 1, i, eight));
  }
  return parts;
}

// Expanding whole runs makes even a radius-nine disc cheap on solid interiors.
// Erosion is the dual operation, with pixels beyond the crop treated as zero.
function dilate(c, src, dst, radius, square = false) {
  const { w, h } = c;
  dst.fill(0);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let x = 0;
    while (x < w) {
      while (x < w && !src[base + x]) x++;
      if (x === w) break;
      const l = x++;
      while (x < w && src[base + x]) x++;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const dx = square ? radius : Math.floor(Math.sqrt(radius * radius - dy * dy));
        dst.fill(1, yy * w + Math.max(0, l - dx), yy * w + Math.min(w, x + dx));
      }
    }
  }
}

function erode(c, src, dst, radius, temp, square = false) {
  for (let i = 0; i < c.n; i++) temp[i] = 1 - src[i];
  dilate(c, temp, dst, radius, square);
  for (let i = 0; i < c.n; i++) dst[i] = 1 - dst[i];
  const { w, h } = c;
  dst.fill(0, 0, Math.min(dst.length, radius * w));
  dst.fill(0, Math.max(0, (h - radius) * w));
  for (let y = radius; y < h - radius; y++) {
    dst.fill(0, y * w, y * w + Math.min(radius, w));
    dst.fill(0, y * w + Math.max(0, w - radius), (y + 1) * w);
  }
}

function closeInk(c, radius, square = false) {
  dilate(c, c.ink, c.a, radius, square);
  erode(c, c.a, c.ink, radius, c.b, square);
}

function maskOf(c, tag) {
  const mask = new Uint8Array(c.n);
  for (let i = 0; i < c.n; i++) mask[i] = +(c.labels[i] === tag);
  return mask;
}

// Flood the complement from its border: enclosed lettering becomes interior,
// including glyphs on any of the five probes, without contour hierarchy.
function fillHoles(c, mask) {
  const outside = c.a;
  outside.fill(0);
  const { w, h } = c;
  for (let x = 0; x < w; x++) {
    if (!mask[x] && !outside[x]) spanFill(c, mask, 0, outside, 1, x);
    const p = (h - 1) * w + x;
    if (!mask[p] && !outside[p]) spanFill(c, mask, 0, outside, 1, p);
  }
  for (let y = 1; y + 1 < h; y++) {
    for (const p of [y * w, (y + 1) * w - 1]) {
      if (!mask[p] && !outside[p]) spanFill(c, mask, 0, outside, 1, p);
    }
  }
  let count = 0;
  for (let i = 0; i < c.n; i++) count += mask[i] = 1 - outside[i];
  return count;
}

function boxArea(box) { return (box[2] - box[0]) * (box[3] - box[1]); }
function centre(box) { return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]; }
function at(c, mask, x, y) {
  x = Math.floor(x); y = Math.floor(y);
  return x >= 0 && y >= 0 && x < c.w && y < c.h ? mask[y * c.w + x] : 0;
}
function coverage(c, mask) {
  let hit = 0;
  const [x0, y0, x1, y1] = c.box;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hit += mask[y * c.w + x];
  return hit / boxArea(c.box);
}
function countMask(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  return count;
}
function touchesBorder(c, mask) {
  const { w, h } = c;
  for (let x = 0; x < w; x++) if (mask[x] || mask[(h - 1) * w + x]) return true;
  for (let y = 0; y < h; y++) if (mask[y * w] || mask[(y + 1) * w - 1]) return true;
  return false;
}
function patchHist(c) {
  const hist = new Uint32Array(256);
  const [x0, y0, x1, y1] = c.box;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[c.gray[y * c.w + x]]++;
  return hist;
}
function percentile(hist, total, fraction) {
  let sum = 0;
  for (let i = 0; i < 256; i++) if ((sum += hist[i]) >= total * fraction) return i;
  return 255;
}

function ringInterior(c) {
  const area = boxArea(c.box);
  const [cx, cy] = centre(c.box);
  const probes = [[cx, cy], ...[[0, 1], [2, 1], [2, 3], [0, 3]].map(([x, y]) => [cx + (c.box[x] - cx) * 0.7, cy + (c.box[y] - cy) * 0.7])];
  const levels = [64, 96, 128, 160, 192];
  const relative = percentile(patchHist(c), area, 0.8) - 36;
  if (relative >= 130) levels.push(Math.min(220, relative));
  levels.sort((a, b) => a - b);
  let best = null, fallback = null, bestArea = Infinity, fallbackArea = Infinity, lastInk = -1;
  for (const t of levels) {
    let inkCount = 0;
    for (let g = 0; g < t; g++) inkCount += c.hist[g];
    // Absolute cutoffs often describe exactly the same binary scan. There is
    // no reason to repeat morphology and component labelling on those pixels.
    if (inkCount === lastInk) continue;
    lastInk = inkCount;
    if (!inkCount || inkCount === c.n) continue;
    for (let i = 0; i < c.n; i++) c.ink[i] = +(c.gray[i] < t);
    closeInk(c, 1, true);
    // The sealed variant only when the plain ink found nothing at this level.
    // Komatose keeps the smaller of the two, and a sealed hole is always the
    // smaller - by the 2 px the seal grew the ink - so every ring outline came
    // out 2 px inside its own ink.
    const had = best || fallback;
    for (let sealed = 0; sealed < 2; sealed++) {
      if (sealed && (best || fallback) !== had) break;
      // fillHoles uses a as scratch, so the sealed variant lives in b.
      if (sealed) dilate(c, c.ink, c.b, 2);
      const parts = components(c, sealed ? c.b : c.ink, 0);
      for (const part of parts) {
        if (part.border || part.count > c.n * 0.85 || cx < part.x0 || cx > part.x1 || cy < part.y0 || cy > part.y1) continue;
        if ((part.x1 - part.x0 + 1) * (part.y1 - part.y0 + 1) < Math.max(64, area * 0.45)) continue;
        const mask = maskOf(c, part.tag);
        const filled = fillHoles(c, mask);
        if (filled > c.n * 0.85 || filled < Math.max(64, area * 0.45) || !at(c, mask, cx, cy) || coverage(c, mask) < 0.45) continue;
        if (filled < fallbackArea) { fallback = mask; fallbackArea = filled; }
        if (filled >= Math.max(400, area * 0.8) && filled < bestArea && probes.every(([x, y]) => at(c, mask, x, y))) {
          best = mask; bestArea = filled;
        }
      }
    }
  }
  return best || fallback;
}

function floodInterior(c) {
  const [cx, cy] = centre(c.box);
  let seed = Math.floor(cy) * c.w + Math.floor(cx);
  for (let y = Math.max(0, Math.floor(cy) - 12); y <= Math.min(c.h - 1, Math.floor(cy) + 12); y++) {
    for (let x = Math.max(0, Math.floor(cx) - 12); x <= Math.min(c.w - 1, Math.floor(cx) + 12); x++) {
      const p = y * c.w + x;
      if (c.gray[p] > c.gray[seed]) seed = p;
    }
  }
  const gray = c.gray[seed];
  for (let i = 0; i < c.n; i++) c.ink[i] = +(c.gray[i] < gray - 18);
  const parts = components(c, c.ink, 1, true);
  const large = new Uint8Array(parts.length + 1);
  for (const part of parts) if (part.count >= 60) large[part.tag] = 1;
  for (let i = 0; i < c.n; i++) c.a[i] = large[c.labels[i]];
  dilate(c, c.a, c.b, 2);
  c.b[seed] = 0;
  for (let i = 0; i < c.n; i++) c.ink[i] = +(!c.b[i] && Math.abs(c.gray[i] - gray) <= 14);
  c.labels.fill(0);
  const part = spanFill(c, c.ink, 1, c.labels, 1, seed);
  if (part.border || part.count < 400 || part.count > c.n * 0.4) return null;
  const mask = maskOf(c, 1);
  fillHoles(c, mask);
  return mask;
}

function darkInterior(c) {
  const hist = patchHist(c);
  const area = boxArea(c.box);
  let dark = 0;
  for (let i = 0; i < 80; i++) dark += hist[i];
  if (percentile(hist, area, 0.5) > 140 || dark < area * 0.3) return null;
  let best = null, bestArea = Infinity, lastInk = -1;
  for (const t of [60, 80, 100]) {
    let inkCount = 0;
    for (let i = 0; i < t; i++) inkCount += c.hist[i];
    if (inkCount === lastInk) continue;
    lastInk = inkCount;
    for (let i = 0; i < c.n; i++) c.ink[i] = +(c.gray[i] < t);
    const chosen = components(c, c.ink, 1, true).reduce((a, b) => !a || b.hit > a.hit ? b : a, null);
    if (!chosen || chosen.hit < area * 0.25) continue;
    for (let i = 0; i < c.n; i++) c.ink[i] = +(c.labels[i] === chosen.tag);
    closeInk(c, 2);
    const mask = c.ink.slice();
    const filled = fillHoles(c, mask);
    if (chosen.count < filled * 0.72 || touchesBorder(c, mask) || !plausible(c, opened(c, mask.slice()), false)) continue;
    if (filled < bestArea) { best = mask; bestArea = filled; }
  }
  return best;
}

// Moore's walk records the outer boundary at pixel centres. Starting at the
// top-left foreground pixel keeps holes in lettering out of the contour.
function trace(c, mask) {
  const { w, h } = c;
  let seed = -1;
  for (let i = 0; i < c.n; i++) if (mask[i]) { seed = i; break; }
  if (seed < 0) return [];
  const sx = seed % w, sy = (seed / w) | 0;
  let x = sx, y = sy, bx = x - 1, by = y, first = null;
  const pts = [];
  for (let guard = 0; guard < c.n * 8; guard++) {
    let from = 0;
    for (let d = 0; d < 8; d++) if (x + DX[d] === bx && y + DY[d] === by) { from = d; break; }
    let found = -1;
    for (let k = 1; k <= 8; k++) {
      const d = (from + k) % 8;
      const xx = x + DX[d], yy = y + DY[d];
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[yy * w + xx]) { found = d; break; }
    }
    if (found < 0) return [[x, y]];
    const nx = x + DX[found], ny = y + DY[found];
    if (first && x === sx && y === sy && nx === first[0] && ny === first[1]) return pts;
    pts.push([x, y]);
    if (!first) first = [nx, ny];
    const prev = (found + 7) % 8;
    bx = x + DX[prev]; by = y + DY[prev];
    x = nx; y = ny;
  }
  return [];
}

function signedArea(pts) {
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) sum += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return sum / 2;
}
function perimeter(pts) {
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) sum += Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
  return sum;
}
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function convexHull(pts) {
  const sorted = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower = [], upper = [];
  for (const p of sorted) {
    while (lower.length > 1 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length > 1 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// `strokes: false` skips the long-art-stroke test, for a dark bubble: its
// interior is ink by definition, and the test would read it as art.
function plausible(c, mask, strokes = true) {
  const contour = trace(c, mask);
  const area = Math.abs(signedArea(contour));
  if (area < 64 || area < Math.abs(signedArea(convexHull(contour))) * 0.92 || coverage(c, mask) < 0.45) return false;
  if (!strokes || area <= boxArea(c.box) * 3) return true;
  erode(c, mask, c.b, 3, c.a, true);
  const [x0, y0, x1, y1] = c.box;
  let inner = 0;
  for (let y = 0, p = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++, p++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) c.b[p] = 0;
      inner += c.b[p];
      c.ink[p] = +(c.b[p] && c.gray[p] < 160);
    }
  }
  let large = 0;
  let minX = c.w, maxX = 0, minY = c.h, maxY = 0;
  for (const [x, y] of contour) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (const part of components(c, c.ink)) {
    if (part.count > 60 && (part.x1 - part.x0 + 1 > (maxX - minX + 1) * 0.6 || part.y1 - part.y0 + 1 > (maxY - minY + 1) * 0.6)) large += part.count;
  }
  return large <= Math.max(1, inner) * 0.12;
}

function keepBoxComponent(c, mask) {
  const parts = components(c, mask, 1, true);
  const [cx, cy] = centre(c.box);
  const tag = c.labels[Math.floor(cy) * c.w + Math.floor(cx)];
  const chosen = tag || parts.reduce((best, part) => !best || part.hit > best.hit || (part.hit === best.hit && part.count > best.count) ? part : best, null)?.tag;
  for (let i = 0; i < c.n; i++) mask[i] = +(chosen > 0 && c.labels[i] === chosen);
  return mask;
}

// A two-pass chamfer transform approximates L2 clearance without a heap at
// every pixel. Dijkstra is only needed when the direct centre path leaves ink.
function distanceTransform(c, mask) {
  const { w, h, n } = c;
  const d = new Float32Array(n);
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      if (!mask[p]) continue;
      let v = Math.min(x + 1, y + 1, w - x, h - y);
      if (x) v = Math.min(v, d[p - 1] + 1);
      if (y) {
        v = Math.min(v, d[p - w] + 1);
        if (x) v = Math.min(v, d[p - w - 1] + Math.SQRT2);
        if (x + 1 < w) v = Math.min(v, d[p - w + 1] + Math.SQRT2);
      }
      d[p] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const p = y * w + x;
    if (!mask[p]) continue;
    let v = d[p];
    if (x + 1 < w) v = Math.min(v, d[p + 1] + 1);
    if (y + 1 < h) {
      v = Math.min(v, d[p + w] + 1);
      if (x) v = Math.min(v, d[p + w - 1] + Math.SQRT2);
      if (x + 1 < w) v = Math.min(v, d[p + w + 1] + Math.SQRT2);
    }
    d[p] = v;
  }
  return d;
}

function ridgePath(c, mask, dist, start, goal) {
  const best = new Float64Array(c.n).fill(Infinity);
  const prev = new Int32Array(c.n).fill(-1);
  const s = start[1] * c.w + start[0], g = goal[1] * c.w + goal[0];
  const heap = [];
  const push = (p, cost) => {
    let i = heap.length;
    heap.push([p, cost]);
    while (i) {
      const parent = (i - 1) >> 1;
      if (heap[parent][1] <= cost) break;
      heap[i] = heap[parent]; i = parent;
    }
    heap[i] = [p, cost];
  };
  const pop = () => {
    const first = heap[0], last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1][1] < heap[child][1]) child++;
        if (heap[child][1] >= last[1]) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  best[s] = 0; push(s, 0);
  while (heap.length) {
    const [p, cost] = pop();
    if (cost !== best[p]) continue;
    if (p === g) break;
    const x = p % c.w, y = (p / c.w) | 0;
    for (let k = 0; k < 8; k++) {
      const xx = x + DX[k], yy = y + DY[k];
      if (xx < 0 || yy < 0 || xx >= c.w || yy >= c.h) continue;
      const q = yy * c.w + xx;
      if (!mask[q]) continue;
      const next = cost + (k % 2 ? Math.SQRT2 : 1) / (dist[q] + 0.25);
      if (next < best[q]) { best[q] = next; prev[q] = p; push(q, next); }
    }
  }
  if (!Number.isFinite(best[g])) return null;
  const path = [];
  for (let p = g; p !== -1; p = prev[p]) path.push([p % c.w, (p / c.w) | 0]);
  return path.reverse();
}

function connectingPath(c, mask, dist, start, goal) {
  const length = Math.max(8, Math.ceil(Math.hypot(goal[0] - start[0], goal[1] - start[1])));
  const path = [];
  for (let i = 0; i <= length; i++) {
    const x = Math.round(start[0] + (goal[0] - start[0]) * i / length);
    const y = Math.round(start[1] + (goal[1] - start[1]) * i / length);
    if (!at(c, mask, x, y)) return ridgePath(c, mask, dist, start, goal);
    if (!path.length || x !== path.at(-1)[0] || y !== path.at(-1)[1]) path.push([x, y]);
  }
  return path;
}

function neckIndex(profile) {
  const n = profile.length;
  if (n < 8) return -1;
  const a = Math.min(n >> 2, Math.max(2, Math.floor(profile[0] * 0.5)));
  const b = n - Math.min(n >> 2, Math.max(2, Math.floor(profile[n - 1] * 0.5)));
  if (b - a < 3) return -1;
  let valley = a, left = 0, right = 0;
  for (let i = a + 1; i < b; i++) if (profile[i] < profile[valley]) valley = i;
  for (let i = 0; i < valley; i++) left = Math.max(left, profile[i]);
  for (let i = valley + 1; i < n; i++) right = Math.max(right, profile[i]);
  return profile[valley] < 0.85 * Math.min(left, right) - 0.5 ? valley : -1;
}
function segDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function segmentsCross(a, b, c, d) {
  // Include an intersection at a path vertex: pixel paths often hit the
  // bisector exactly, where a strict segment test would miss both neighbours.
  return Math.max(a[0], b[0]) >= Math.min(c[0], d[0]) && Math.max(c[0], d[0]) >= Math.min(a[0], b[0]) &&
    Math.max(a[1], b[1]) >= Math.min(c[1], d[1]) && Math.max(c[1], d[1]) >= Math.min(a[1], b[1]) &&
    cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
}
function joinChord(contour, start, goal, path, neck) {
  const n = contour.length;
  if (n < 16) return null;
  const sign = signedArea(contour) > 0 ? 1 : -1;
  const step = Math.max(8, Math.floor(perimeter(contour) * 0.015));
  const turns = new Float32Array(n), local = [];
  for (let i = 0; i < n; i++) {
    const a = contour[(i - step % n + n) % n], b = contour[i], d = contour[(i + step) % n];
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = d[0] - b[0], vy = d[1] - b[1];
    turns[i] = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * sign;
  }
  for (let i = 0; i < n; i++) {
    if (turns[i] >= -Math.PI / 9) continue;
    let lowest = true;
    for (let k = -step; k <= step; k++) if (turns[(i + k % n + n) % n] < turns[i] - 1e-9) { lowest = false; break; }
    if (lowest) local.push(i);
  }
  let best = null, score = -Infinity;
  for (let a = 0; a < local.length; a++) for (let b = a + 1; b < local.length; b++) {
    const i = local[a], j = local[b];
    if (Math.min(Math.abs(i - j), n - Math.abs(i - j)) < 2 * step) continue;
    const p = contour[i], q = contour[j], length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length < 4) continue;
    if (!segmentsCross(start, goal, p, q) && !path?.some((v, k) => k && segmentsCross(path[k - 1], v, p, q))) continue;
    const value = neck ? -segDistance(neck, p, q) + 0.01 * (-turns[i] - turns[j]) : (-turns[i] - turns[j]) / (length + 1);
    if (value > score) { score = value; best = [p, q]; }
  }
  return best;
}

function cutChord(c, mask, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy) || 1;
  const ux = dx / length, uy = dy / length;
  for (let t = -3; t <= length + 3; t += 0.5) {
    const x = Math.round(a[0] + ux * t), y = Math.round(a[1] + uy * t);
    for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) {
      if (xx >= 0 && yy >= 0 && xx < c.w && yy < c.h) mask[yy * c.w + xx] = 0;
    }
  }
}
function cutAcross(c, mask, origin, tangent) {
  const length = Math.hypot(...tangent) || 1;
  const sx = -tangent[1] / length, sy = tangent[0] / length;
  const walk = (sign) => {
    let x = origin[0], y = origin[1];
    for (let i = 0; i < Math.max(c.w, c.h); i++) {
      x += sx * sign; y += sy * sign;
      if (!at(c, mask, Math.round(x), Math.round(y))) return [x + sx * sign * 2, y + sy * sign * 2];
    }
    return [x, y];
  };
  cutChord(c, mask, walk(1), walk(-1));
}

function splitInterior(c, mask, neighbors) {
  const own = centre(c.box);
  const others = neighbors.map(centre).map(([x, y]) => [x - c.x, y - c.y]).filter(([x, y]) => Math.hypot(x - own[0], y - own[1]) >= 1 && at(c, mask, x, y));
  if (!others.length) return { mask, split: false };
  const dist = distanceTransform(c, mask), contour = trace(c, mask), cut = mask.slice();
  const start = own.map(Math.floor);
  for (const other of others) {
    const goal = other.map(Math.floor);
    const path = connectingPath(c, mask, dist, start, goal);
    const valley = path ? neckIndex(path.map(([x, y]) => dist[y * c.w + x])) : -1;
    const chord = joinChord(contour, start, goal, path, valley >= 0 ? path[valley] : null);
    if (chord) cutChord(c, cut, ...chord);
    else if (valley >= 0) {
      const a = path[Math.max(0, valley - 3)], b = path[Math.min(path.length - 1, valley + 3)];
      cutAcross(c, cut, path[valley], [b[0] - a[0], b[1] - a[1]]);
    }
  }
  keepBoxComponent(c, cut);
  // Applying the same strict distance rule in both calls leaves a shared gap,
  // even when a shallow join has no measurable cusp or neck.
  for (let y = 0, p = 0; y < c.h; y++) for (let x = 0; x < c.w; x++, p++) {
    if (!cut[p]) continue;
    const d = (x - own[0]) ** 2 + (y - own[1]) ** 2;
    for (const [nx, ny] of others) if (d >= (x - nx) ** 2 + (y - ny) ** 2) { cut[p] = 0; break; }
  }
  return { mask: keepBoxComponent(c, cut), split: true };
}

function simplifyArc(pts, epsilon) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [0, pts.length - 1];
  while (stack.length) {
    const end = stack.pop(), start = stack.pop();
    let far = epsilon, index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = segDistance(pts[i], pts[start], pts[end]);
      if (d > far) { far = d; index = i; }
    }
    if (index >= 0) { keep[index] = 1; stack.push(start, index, index, end); }
  }
  return pts.filter((_, i) => keep[i]);
}
function simplifyClosed(pts) {
  if (pts.length < 3) return [];
  let far = 1, distance = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > distance) { distance = d; far = i; }
  }
  let epsilon = Math.max(0.7, 0.002 * perimeter(pts));
  for (;;) {
    const a = simplifyArc(pts.slice(0, far + 1), epsilon);
    const b = simplifyArc(pts.slice(far).concat([pts[0]]), epsilon);
    const poly = a.slice(0, -1).concat(b.slice(0, -1));
    if (poly.length <= 256) return poly;
    epsilon *= 1.5;
  }
}

// Confidence samples the opened mask BEFORE the two-pixel safety erosion.
// Within a three-pixel disc, compare the light/dark extrema on opposite sides
// of the mask. Missing ink at an artificial cut therefore lowers the score.
function confidence(c, mask) {
  const contour = trace(c, mask);
  if (!contour.length) return 0;
  let edges = 0, samples = 0;
  const stride = Math.max(1, Math.ceil(contour.length / 200));
  for (let i = 0; i < contour.length; i += stride) {
    const [x, y] = contour[i];
    let inLo = 255, inHi = 0, outLo = 255, outHi = 0, inside = false, outside = false;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (dx * dx + dy * dy > 9) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= c.w || yy >= c.h) continue;
      const p = yy * c.w + xx, g = c.gray[p];
      if (mask[p]) { inside = true; inLo = Math.min(inLo, g); inHi = Math.max(inHi, g); }
      else { outside = true; outLo = Math.min(outLo, g); outHi = Math.max(outHi, g); }
    }
    if (inside && outside && Math.max(inHi - outLo, outHi - inLo) >= 40) edges++;
    samples++;
  }
  return r2(edges / samples);
}

// The tail cut: keep the piece holding the text, open it with a disc, keep that
// piece again. Twice, with two discs:
//
//   'box'       Komatose's: 8% of the text box's short side, 3 to 9 px. Cuts
//               leaks and thin tails, and is what the solidity test sees, so a
//               burst or a bubble with a long tail is still refused there (the
//               old fill-and-fit answers those, as before).
//   'interior'  8% of the interior's own short side, 3 to 12 px, on what
//               passed. A column of vertical Japanese is 30-40 px wide, which
//               gives the box disc 3 px and cuts no real tail; this one does.
function opened(c, mask, by = 'box') {
  keepBoxComponent(c, mask);
  if (by === 'box') {
    const radius = clamp(Math.round(0.08 * Math.min(c.box[2] - c.box[0], c.box[3] - c.box[1])), 3, 9);
    erode(c, mask, c.b, radius, c.a);
    dilate(c, c.b, mask, radius);
    return keepBoxComponent(c, mask);
  }
  let x0 = c.w, y0 = c.h, x1 = -1, y1 = -1;
  for (let y = 0, p = 0; y < c.h; y++) for (let x = 0; x < c.w; x++, p++) {
    if (!mask[p]) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) return mask;
  const radius = clamp(Math.round(0.08 * Math.min(x1 - x0 + 1, y1 - y0 + 1)), 3, 12);
  erode(c, mask, c.b, radius, c.a);
  dilate(c, c.b, mask, radius);
  return keepBoxComponent(c, mask);
}

// `mask` is already opened (`opened`). No 2 px erosion, unlike Komatose's: the
// outline here is the interior layout reads, and layout keeps its own margin
// from it (`safetyInset` in balloon.js). Eroded as well, every bubble lost 2 px
// a side of room it had with the old fill-and-fit.
function polygon(c, mask) {
  const score = confidence(c, mask);
  const pts = simplifyClosed(trace(c, mask)).map(([x, y]) => [r2(x + c.x + 0.5), r2(y + c.y + 0.5)]);
  return pts.length >= 3 && Math.abs(signedArea(pts)) > 0 ? { pts, confidence: score } : null;
}

function caption(image, box) {
  const pad = Math.max(16, Math.min(box[2] - box[0], box[3] - box[1]) * 0.85);
  const c = crop(image, box, [], pad);
  if (c.w < 16 || c.h < 16) return null;
  // Otsu is only a cheap no-ink gate here; caption acceptance still uses the
  // reference's absolute 96/170 side and inner-edge tests.
  const threshold = interiorThreshold(c.hist, c.n);
  let dark = 0;
  for (let g = 0; g < Math.min(96, threshold); g++) dark += c.hist[g];
  if (!dark) return null;
  for (let i = 0; i < c.n; i++) c.ink[i] = +(c.gray[i] < 96);
  closeInk(c, 1, true);
  let best = null, bestArea = Infinity;
  for (const part of components(c, c.ink, 1, true)) {
    const { x0, y0, x1, y1 } = part;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, area = w * h;
    if (w < 24 || h < 18 || area >= image.width * image.height * 0.45 || area >= bestArea) continue;
    if ((x0 <= 1 && c.x > 0) || (y0 <= 1 && c.y > 0) || (x1 >= c.w - 2 && c.x + c.w < image.width) || (y1 >= c.h - 2 && c.y + c.h < image.height)) continue;
    const fraction = (x, y, dx, dy, n, light = false) => {
      let hit = 0;
      for (let i = 0; i < n; i++, x += dx, y += dy) hit += light ? c.gray[y * c.w + x] > 170 : c.gray[y * c.w + x] < 96;
      return hit / n;
    };
    if (Math.min(fraction(x0, y0, 1, 0, w), fraction(x0, y1, 1, 0, w), fraction(x0, y0, 0, 1, h), fraction(x1, y0, 0, 1, h)) < 0.9) continue;
    const cx = (x0 + x1) >> 1, cy = (y0 + y1) >> 1;
    const run = (x, y, dx, dy, n) => {
      let i = 0;
      while (i < n && c.gray[y * c.w + x] < 96) { i++; x += dx; y += dy; }
      return i;
    };
    const runs = [run(cx, y0, 0, 1, h), run(cx, y1, 0, -1, h), run(x0, cy, 1, 0, w), run(x1, cy, -1, 0, w)];
    const inset = Math.max(...runs) + 2;
    if (Math.min(...runs) < 1 || Math.max(...runs) > Math.max(10, Math.floor(Math.min(w, h) * 0.08)) || w <= inset * 2 + 8 || h <= inset * 2 + 8) continue;
    if (Math.min(fraction(x0 + inset, y0 + inset, 1, 0, w - 2 * inset, true), fraction(x0 + inset, y1 - inset, 1, 0, w - 2 * inset, true), fraction(x0 + inset, y0 + inset, 0, 1, h - 2 * inset, true), fraction(x1 - inset, y0 + inset, 0, 1, h - 2 * inset, true)) < 0.85) continue;
    const [tcx, tcy] = centre(c.box);
    const overlap = Math.max(0, Math.min(c.box[2], x1 + 1) - Math.max(c.box[0], x0)) * Math.max(0, Math.min(c.box[3], y1 + 1) - Math.max(c.box[1], y0));
    const ratio = area / boxArea(c.box);
    if (tcx < x0 - 4 || tcx > x1 + 5 || tcy < y0 - 4 || tcy > y1 + 5 || (overlap < boxArea(c.box) * 0.5 && overlap < area * 0.5) || ratio < 0.25 || ratio > 8) continue;
    runs.sort((a, b) => a - b);
    const stroke = Math.max(1, Math.round((runs[1] + runs[2]) / 2));
    best = [x0 + stroke, y0 + stroke, x1 + 1 - stroke, y1 + 1 - stroke];
    bestArea = area;
  }
  if (!best) return null;
  const [l, t, r, b] = best;
  const mask = new Uint8Array(c.n);
  for (let y = t; y < b; y++) mask.fill(1, y * c.w + l, y * c.w + r);
  return { pts: [[l, t], [r, t], [r, b], [l, b]].map(([x, y]) => [r2(x + c.x), r2(y + c.y)]), source: 'caption', confidence: confidence(c, mask), split: false };
}

// ImageData-shaped RGBA input; no canvas, DOM, or page-sized working masks.
export function findOutline(image, block, opts = {}) {
  if (!image || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || !image.data || !Number.isSafeInteger(image.width * image.height * 4) || image.data.length < image.width * image.height * 4) return open('no-pixels');
  const { width: W, height: H } = image;
  const box = bounds(block, W, H);
  if (!box) return open('no-block');
  opts = opts && typeof opts === 'object' ? opts : {};
  const neighbors = Array.isArray(opts.neighbors) ? opts.neighbors.map((b) => bounds(b, W, H)).filter(Boolean) : [];
  const framed = caption(image, box);
  if (framed) return framed;
  const minPad = Number.isFinite(opts.minPad) ? Math.max(0, opts.minPad) : 48;
  const base = Math.max(box[2] - box[0], box[3] - box[1], minPad);
  const cap = Math.max(400, 0.25 * Math.min(W, H));
  let previous = '';
  for (const scale of [1.15, 1.8, 2.6]) {
    const pad = Math.min(cap, base * scale);
    // Identical clipped windows cannot produce a different answer.
    const c = crop(image, box, neighbors, pad);
    const key = `${c.x},${c.y},${c.w},${c.h}`;
    if (key === previous) continue;
    previous = key;
    let source = 'ring', mask = ringInterior(c);
    if (!mask) { source = 'flood'; mask = floodInterior(c); }
    if (!mask) { source = 'dark'; mask = darkInterior(c); }
    if (!mask || touchesBorder(c, mask)) continue;
    const divided = splitInterior(c, mask, neighbors);
    // The box disc decides whether this is a bubble; the outline itself is cut
    // by the interior disc alone, so it does not depend on which block asked
    // (a refit seeds from other blocks than placement did).
    const cut = opened(c, divided.mask.slice());
    if (!countMask(cut) || !plausible(c, cut, source !== 'dark') || (source !== 'ring' && countMask(cut) > W * H * 0.4)) continue;
    const result = polygon(c, opened(c, divided.mask, 'interior'));
    if (result) return { ...result, source, confidence: Math.min(result.confidence, divided.split ? 0.85 : 1), split: divided.split };
  }
  return open('no-closed-outline');
}
