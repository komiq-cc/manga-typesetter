// Arithmetic and layout functions for longstrip webtoon columns.
import { strokeExtent, shadowExtent, motionBlurExtent, inkReach } from '../text-paint.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Calculate page top offsets and total column height.
export function stripOffsets(pages, zoom = 1) {
  const tops = [];
  let y = 0;
  for (const p of pages ?? []) {
    tops.push(y);
    y += Math.max(0, p?.h ?? 0) * zoom;
  }
  return { tops, total: y };
}

// Owner-local coordinates remain the saved representation, but a longstrip
// box may cross either edge of that owner's image. These document extents let
// fitting and movement use the chapter's bounds without rewriting box data.
export function stripPageExtent(pages, ownerId) {
  const index = pages?.findIndex((p) => p?.id === ownerId) ?? -1;
  if (index < 0) return null;
  // An undecoded frame has no trustworthy placement yet. Using a partial total
  // here would clamp authored geometry against a document that is still growing.
  if (pages.some((p) => !(p?.h > 0))) return null;
  const { tops, total } = stripOffsets(pages, 1);
  return { top: tops[index], total };
}

export function stripDragYBounds(pages, ownerId, boxHeight, retained = 20) {
  const extent = stripPageExtent(pages, ownerId);
  if (!extent) return null;
  return {
    min: -extent.top - boxHeight + retained,
    max: extent.total - extent.top - retained,
  };
}

// Use the same effect extents as the exporter so virtualization cannot cull a
// box whose stroke, shadow or smear still paints into the resident window.
export function boxEffectPad(style) {
  if (!style) return 0;
  const stroke = strokeExtent(style.strokes);
  const shadow = shadowExtent(style.shadows);
  const roughen = style.roughen?.on ? Math.max(0, style.roughen.amount ?? 0) + 2 : 0;
  const blur = Math.max(0, style.blur ?? 0) * 3;
  const motion = motionBlurExtent(style.motionBlur);
  const reach = Math.max(stroke, shadow > 0 ? stroke + shadow : 0, roughen, inkReach(style));
  // The text rasterizer reserves the same four pixels for antialiasing around
  // its footprint even when no named effect is active.
  return Math.ceil(reach + blur + motion + 4);
}

// Vertical span of a box in unzoomed strip coordinates, accounting for
// rotation and conservative effect reach.
export function boxPaintedStripSpan(box, ownerTop = 0) {
  const y = box?.y ?? 0;
  const w = Math.max(0, box?.w ?? 0);
  const h = Math.max(0, box?.h ?? 0);
  const rot = box?.style?.rotation || 0;
  const pad = boxEffectPad(box?.style);
  let top = y;
  let bottom = y + h;
  if (rot) {
    const a = (rot * Math.PI) / 180;
    const half = (Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * h) / 2;
    const cy = y + h / 2;
    top = cy - half;
    bottom = cy + half;
  }
  return {
    top: ownerTop + top - pad,
    bottom: ownerTop + bottom + pad,
  };
}

// The vertical span of the resident artwork window in strip coordinates.
export function stripResidentWindow(pages, tops, centerIndex, viewportH, opts = {}) {
  const n = pages?.length ?? 0;
  if (!n) return { top: 0, bottom: 0, lo: 0, hi: 0, radius: 0 };
  const heights = pages.map((p) => p?.h ?? 0);
  const radius = residentRadiusFor(heights, centerIndex, viewportH, opts);
  const lo = Math.max(0, centerIndex - radius);
  const hi = Math.min(n - 1, centerIndex + radius);
  const top = tops?.[lo] ?? 0;
  const lastH = Math.max(0, pages[hi]?.h ?? 0);
  const bottom = (tops?.[hi] ?? 0) + lastH;
  return { top, bottom, lo, hi, radius };
}

// Test if a box's painted bounds intersect the resident artwork window, or is pinned.
export function isBoxInStripWindow(box, ownerTop, windowTop, windowBottom, isTarget = false) {
  if (isTarget) return true;
  const span = boxPaintedStripSpan(box, ownerTop);
  return span.bottom >= windowTop && span.top <= windowBottom;
}

// Resolve a client point (clientX, clientY) against an array of page frame rects/elements.
export function stripFrameCoords(clientX, clientY, frames, zoom = 1) {
  const n = frames?.length ?? 0;
  if (!n || !(zoom > 0)) return null;
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    if (!f) continue;
    const r = typeof f.getBoundingClientRect === 'function' ? f.getBoundingClientRect() : f;
    const isLast = i === n - 1;
    if (
      clientX >= r.left &&
      clientX <= r.right &&
      clientY >= r.top &&
      (isLast ? clientY <= r.bottom : clientY < r.bottom)
    ) {
      return {
        x: (clientX - r.left) / zoom,
        y: (clientY - r.top) / zoom,
        pg: f.pg ?? null,
        index: i,
      };
    }
  }
  return null;
}

// Where every frame of a mounted strip sits, computed rather than measured.
//
// The column is a flex column of frames whose height is written into the style
// string as `pg.h * zoom`, with a gap between them and nothing else - no
// borders, no margins, no padding on the column itself. So the layout the
// browser produces is a running total, and asking it for one is asking a
// question whose answer is already here. That matters because the caller
// (`syncStrip` in Canvas.svelte) runs on every animation frame of a scroll and
// used to call `getBoundingClientRect()` on EVERY page in the chapter to build
// this: two hundred forced layouts a frame on a webtoon, which is most of what
// a strip's scroll cost.
//
// `firstTop` is where the column starts in the scroll container's own space -
// one measurement, made once per tick, which carries the stage's padding, the
// vertical centring and the pan with it.
//
// The heights come back too, and they are not decoration: a page whose art has
// not decoded is `h: 0`, an empty frame, and `pageIndexAtCenter` must never name
// one of those as the page the reader is on.
export function stripFrameMetrics(pages, zoom = 1, firstTop = 0, gap = 0) {
  const tops = [];
  const heights = [];
  const g = gap > 0 ? gap : 0;
  let y = firstTop;
  for (const p of pages ?? []) {
    const h = Math.max(0, p?.h ?? 0) * zoom;
    tops.push(y);
    heights.push(h);
    // The gap is flex's, so it sits between every pair of frames whether or not
    // either of them has any height yet.
    y += h + g;
  }
  return { tops, heights };
}

// Determine page index at center of scroll viewport.
export function pageIndexAtCenter(tops, scrollTop, viewportH, heights = null) {
  const n = tops?.length ?? 0;
  if (!n) return 0;
  if (!heights && n > 1 && !(tops[n - 1] > tops[0])) return 0;
  const spans = (i) =>
    heights ? (heights[i] ?? 0) > 0 : i + 1 < n ? tops[i + 1] > tops[i] : true;
  const center = scrollTop + viewportH / 2;
  let idx = -1;
  for (let i = 0; i < n; i++) {
    if (tops[i] > center) break;
    if (spans(i)) idx = i;
  }
  return idx < 0 ? 0 : idx;
}

// Measure visible height of a frame in viewport.
export function visibleHeightOf(top, height, scrollTop, viewportH) {
  const h = Math.max(0, height ?? 0);
  if (!(h > 0)) return 0;
  const t = top ?? 0;
  return Math.max(0, Math.min(t + h, scrollTop + viewportH) - Math.max(t, scrollTop));
}

// Hold page index on selected box while page remains visible.
export const FOCUS_HOLD_PX = 8;

export function focusHoldsIndex(tops, heights, index, scrollTop, viewportH, minPx = FOCUS_HOLD_PX) {
  if (!(index >= 0) || index >= (tops?.length ?? 0)) return false;
  const h = Math.max(0, heights?.[index] ?? 0);
  const shown = visibleHeightOf(tops[index], h, scrollTop, viewportH);
  return shown > 0 && shown >= Math.min(minPx, h);
}

// A selected box can be visible across a seam after its owner frame has left
// the viewport. Keep the editing page focused while a useful part of its
// painted span is still on screen.
export function focusedBoxHoldsIndex(box, ownerTop, zoom, scrollTop, viewportH, minPx = FOCUS_HOLD_PX) {
  if (!box || !(zoom > 0)) return false;
  const span = boxPaintedStripSpan(box);
  const top = ownerTop + span.top * zoom;
  const height = Math.max(0, (span.bottom - span.top) * zoom);
  return height > 0 && visibleHeightOf(top, height, scrollTop, viewportH) >= Math.min(minPx, height);
}

// Find maximum page width across chapter.
export function maxPageWidth(pages) {
  let max = 0;
  for (const p of pages ?? []) if (p?.w > 0 && p.w > max) max = p.w;
  return max;
}

// Calculate zoom level to fit widest page width in viewport.
export function fitWidthZoom(pages, vw, padX = 0) {
  const w = maxPageWidth(pages);
  if (!(w > 0)) return 0;
  const z = (vw - padX) / w;
  return z > 0 && isFinite(z) ? z : 0;
}

// Calculate lookahead page window for longstrip prefetch.
export const RESIDENT_MIN = 2;
export const RESIDENT_MAX = 12;
export const RESIDENT_SCREENS = 3;

export function residentRadiusFor(heights, index, viewportH, opts = {}) {
  const { min = RESIDENT_MIN, max = RESIDENT_MAX, screens = RESIDENT_SCREENS } = opts;
  const n = heights?.length ?? 0;
  if (!n) return min;
  const want = (viewportH > 0 ? viewportH : 0) * screens;
  if (!(want > 0)) return min;
  // A page whose height is not measured yet counts as one viewport, not as
  // zero. Zero never fills the quota, so a freshly opened chapter - every
  // height 0 until its image decodes - walked straight to `max` and put
  // 2*max+1 full-resolution pages in memory at once, which is the opposite of
  // what this window is for. One screen is the conservative guess: a shorter
  // real page only widens the radius on the next measure.
  const guess = viewportH;
  let up = 0;
  let down = 0;
  for (let r = 1; r <= max; r++) {
    const a = index - r;
    const b = index + r;
    up = a >= 0 ? up + (heights[a] > 0 ? heights[a] : guess) : Infinity;
    down = b < n ? down + (heights[b] > 0 ? heights[b] : guess) : Infinity;
    if (up >= want && down >= want) return Math.max(min, r);
  }
  return max;
}

// Convert scroll fraction between scroll containers.
const scrollRange = (m) => Math.max(0, (m?.scrollHeight ?? 0) - (m?.clientHeight ?? 0));

export function scrollFraction(m) {
  const max = scrollRange(m);
  return max > 0 ? clamp((m.scrollTop ?? 0) / max, 0, 1) : 0;
}

export function scrollTopForFraction(fraction, m) {
  const max = scrollRange(m);
  if (!(max > 0)) return 0;
  return clamp(fraction ?? 0, 0, 1) * max;
}
