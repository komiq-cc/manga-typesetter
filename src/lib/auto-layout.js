// ===== the auto-layout solver (FIT-5) =====
//
// API CONTRACT
//
//   solveLayout({ text, style, refSize, region, locks, opts })
//     -> null | { size, x, y, w, h, lines, status, reasons, review }
//
//   text     the box's RAW text (case is applied inside, as `placeBlock` does).
//   style    the box's normalised style. Its `size` is ignored: the search
//            starts at `refSize`.
//   refSize  the size the user chose for this kind of text - `box.auto.refSize`,
//            the tag's remembered size. Never exceeded.
//   region   where the text goes:
//              a balloon fit ({ kind: 'ellipse', cx, cy, rx, ry } or
//              { kind: 'rect', x, y, w, h }, as `normalizeFit` gives it) - the
//              text is laid out inside it, less its safety inset;
//              { kind: 'hint', x, y, w, h } - a location only, the detector's
//              rectangle or a click (w = h = 0). Its centre is where the box
//              goes; its size says nothing about the English;
//              null - no location at all. The box comes back at (0, 0).
//   locks    { size, width, height, pos, breaks } - what the solver may not
//            change. The locked values are read off `opts.box`. Locked breaks
//            lock the size and the width, which are what decide them.
//   opts     { minSize, minW, minH, box, page, strip }
//            `minSize` the smallest size the search may reach; `minW`/`minH`
//            the smallest box; `box` the box as it stands, for the locks;
//            `page`/`strip` bound the best effort when nothing fits (`fitBox`).
//
//   status   'ok'        fits at `refSize`
//            'shrunk'    fits at a smaller size, no lower than `minSize`
//            'no-region' placed by a hint or nothing, and fits its own box
//            'overflow'  nothing fits: the best effort, never below `minSize`,
//                        with `reasons` saying why (REVIEW_REASONS values)
//   review   the `box.review` to write: null unless the best effort's ink is
//            still past the box.
//
// Null when there is nothing to lay out: no style, no size, blank text, or
// text on a curve (which is manual and never solved).
//
// ---------------------------------------------------------------------------
//
// The placement ladder (contain.js `fitBox`) fits a BOX around a size someone
// else chose. This chooses the size, the width and the lines together, for the
// balloon: the largest size up to the user's reference size at which the text
// fits the region, at the width a fitted box is placed at when that fits (see
// `widthsAt`), and with only a location, at the width whose block reads best.
// Pure - no store, no Svelte state - over its arguments and the metrics
// measure.js reads, so it can be tested and benchmarked alone.
//
// Hard constraints, never traded for score:
//
//   every line fits its own row. The row is the balloon's usable width at the
//   band the box draws that line on (`interiorLineWidths`, hung where
//   `balloonWidthsFor` hangs the rows the layout itself is broken to), less the
//   box's text inset on each side; a centred line is centred on the balloon,
//   and a left- or right-aligned one starts at the box's edge, so for those the
//   box itself has to be inside the balloon on every row. A single word wider
//   than its row fails here - the breaker keeps it whole and lets it overhang.
//   the block fits the balloon's height, anchored by `valign` exactly as the
//   row widths assume it is.
//   the ink fits the box: `containBox`, the one check every renderer answers
//   to. The box is grown for ink past the line boxes (`inkHeight`) first.
//   size >= minSize, and the locks.
//
// The search: `refSize` first, and most boxes stop there. Otherwise a binary
// search on the half-px grid between `minSize` and `refSize` for the largest
// size that fits - sizes the solver picks are always on that grid, so the
// editor, the raster exporter and the PSD writer, which all lay the box out
// from `style.size`, are handed the same number. The size a user typed stays
// as typed when it fits.
//
// Every candidate is laid out with `cache: false`: a search throws most of its
// layouts away, and remembered they would push the editor's own entries out of
// the memo. The one kept is laid out again by the editor through the ordinary
// path.
//
// Fonts: the caller must not commit an answer measured with a fallback face
// (DET-4). The solver cannot tell; the store checks before it asks.

import { placeBlock, placeAtHeight, containBox, inkHeight, fitBox, CONTAIN_TOL, REVIEW_REASONS } from './contain.js';
import { applyCase, lineWidth, textInset, blockYFor } from './measure.js';
import { interiorLineWidths, inscribedRect, balloonFrame, safetyInset } from './balloon.js';
import { neededHeight, balancedBlockSize, BALANCED_DEFAULTS } from './typeset.js';
import { normalizeFit } from './data.js';

export const SIZE_STEP = 0.5;
const WIDTH_STEPS = 4;
const NO_CACHE = { cache: false };

const upToGrid = (v) => Math.ceil(v / SIZE_STEP - 1e-9) * SIZE_STEP;
const downToGrid = (v) => Math.floor(v / SIZE_STEP + 1e-9) * SIZE_STEP;
const valignOf = (s) => s.valign ?? 'middle';

// The region as the search reads it. For a balloon, all off the shape less its
// safety inset: the band the block must stay inside (`top`, `height`), the
// inscribed rectangle's width (`frameW`, where flush text is placed) and the
// inset shape's own (`fullW`, `balloonFrame`'s, where centred text is).
function regionOf(region) {
  if (!region) return null;
  if (region.kind === 'hint') {
    const x = Number(region.x);
    const y = Number(region.y);
    const w = Number(region.w) || 0;
    const h = Number(region.h) || 0;
    if (!Number.isFinite(x + y + w + h)) return null;
    return { kind: 'hint', cx: x + w / 2, cy: y + h / 2 };
  }
  const shape = normalizeFit(region);
  if (!shape) return null;
  const r = inscribedRect(shape);
  const f = balloonFrame(shape);
  if (shape.kind === 'ellipse') {
    const ry = Math.max(0, shape.ry - safetyInset(shape));
    return { kind: 'ellipse', shape, cx: shape.cx, top: shape.cy - ry, height: 2 * ry, frameW: r.w, fullW: f.w };
  }
  return { kind: 'rect', shape, cx: r.x + r.w / 2, top: r.y, height: r.h, frameW: r.w, fullW: r.w };
}

function locksOf(locks, box) {
  const l = locks ?? {};
  const has = box && [box.x, box.y, box.w, box.h].every(Number.isFinite);
  return {
    size: !!(l.size || l.breaks),
    width: !!((l.width || l.breaks) && has),
    height: !!(l.height && has),
    pos: !!(l.pos && has),
  };
}

// The box of height `h` for a block laid out at width `base.w`: on the balloon,
// with the block where the row widths assumed it (anchored by `valign` in the
// band, the box `textInset` around it - see `blockYFor`); centred on a hint;
// or on the locked centre.
function frame(ctx, base, h) {
  const { R, lk, box } = ctx;
  const w = base.w;
  if (lk.pos) return { ...base, x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, h };
  if (!R) return { ...base, h };
  if (R.kind === 'hint') return { ...base, x: R.cx - w / 2, y: R.cy - h / 2, h };
  const va = valignOf(base.style);
  const y =
    va === 'top'
      ? R.top - ctx.ti
      : va === 'bottom'
        ? R.top + R.height + ctx.ti - h
        : R.top + R.height / 2 - h / 2;
  return { ...base, x: R.cx - w / 2, y, h };
}

// How wide the room at each row has to be for the line on it. The rows are the
// balloon's at the band each line is drawn on - hung from where the box draws
// the block, as `balloonWidthsFor` hangs the rows the breaker is handed (GEO-2).
function rowsFit(ctx, c, place) {
  const { R, ti } = ctx;
  const s = place.s;
  const n = place.lines.length;
  const rows = R?.shape
    ? interiorLineWidths(R.shape, place.lineH, n, valignOf(s), { top: c.y + blockYFor(s, c.h, place.blockH) })
    : null;
  const centred = s.align !== 'left' && s.align !== 'right';
  return place.lines.every((line, i) => {
    const need = lineWidth(line, s, s.size) + 2 * ti;
    const room = rows ? rows[i] : c.w;
    return (centred ? need : Math.max(c.w, need)) <= room + CONTAIN_TOL;
  });
}

// One candidate: the text at `size` in a box `w` wide, placed, checked.
//
// Laid out on the box where it will stand: the balloon's rows hang from the
// block's anchor (`balloonWidthsFor`), so a block laid out anywhere else would
// be broken for rows it is not drawn on. The anchor is where `frame` puts it
// whatever the height - the band's top, middle or bottom - so the lines do not
// depend on the height they then decide; `placeAtHeight` lays them out again in
// the one case they do (a locked position).
function trial(ctx, size, w) {
  const style = size === ctx.style.size ? ctx.style : { ...ctx.style, size };
  const base = { x: 0, y: 0, w, h: 0, style, text: ctx.text, fit: ctx.R?.shape ?? null };
  const place = placeBlock(frame(ctx, base, ctx.minH), NO_CACHE);
  if (place.isCurve) {
    ctx.curve = true;
    return null;
  }
  const need = neededHeight(place.lines.length, style, ctx.ti);
  let h = ctx.lk.height ? ctx.box.h : Math.max(need, ctx.minH);
  let c = frame(ctx, base, h);
  let p = placeAtHeight(place, c);
  let v = containBox(c, p);
  if (!v.fits && !ctx.lk.height) {
    const grown = inkHeight(c, p);
    if (grown > h) {
      h = grown;
      c = frame(ctx, base, h);
      p = placeAtHeight(place, c);
      v = containBox(c, p);
    }
  }
  const tall = ctx.lk.height
    ? need > ctx.box.h + CONTAIN_TOL
    : ctx.R?.shape
      ? place.blockH > ctx.R.height + CONTAIN_TOL
      : false;
  return { c, place: p, v, ok: v.fits && !tall && rowsFit(ctx, c, p) };
}

// The widths worth trying at a size.
//
// In a balloon, in order of preference, and the first that fits is the answer:
// the width a fitted box is placed at (`balloonFrame`, GEO-1) first, then
// WIDTH_STEPS towards the other end of the balloon. Centred text is broken to
// the ellipse's own rows, capped at the box, so its box is as wide as the inset
// ellipse - where the cap never binds and the block keeps the balloon's taper -
// and narrower only when that fails: with balloon layout off, the lines are set
// flat and have to fit the rows they sit on. Flush text is set flat, so its box
// starts at the inscribed rectangle, the one box whose rows all sit inside the
// curve, and widens only for a word that rectangle cannot hold. A rectangle has
// one width. With nothing but a location, scored (`score`), narrowest first so
// a tie goes to the box that hugs its text: the widths that break the text into
// a balanced block - the closed form's line count (`balancedBlockSize`) and two
// either side of it, each as the width that gives that many lines with the
// breaker's slack - `balancedBoxSize`'s search, which reads the layout memo and
// so cannot be called from here - with every width no narrower than the longest
// word, so a word the breaker cannot split is never the reason a width fails.
function widthsAt(ctx, size) {
  const minW = ctx.minW;
  if (ctx.lk.width) return [ctx.box.w];
  const R = ctx.R;
  if (R?.shape) {
    const s = ctx.style;
    const [from, to] = s.align === 'left' || s.align === 'right' ? [R.frameW, R.fullW] : [R.fullW, R.frameW];
    const out = new Set();
    for (let i = 0; i < WIDTH_STEPS; i++) out.add(Math.max(minW, from + ((to - from) * i) / (WIDTH_STEPS - 1)));
    return [...out];
  }
  const o = BALANCED_DEFAULTS;
  const s = { ...ctx.style, size };
  const lh = size * (s.lineHeight > 0 ? s.lineHeight : 1);
  const paras = applyCase(ctx.text, s)
    .split('\n')
    .filter((t) => /\S/.test(t));
  let total = 0;
  let word = 0;
  for (const para of paras) {
    total += lineWidth(para, s, size);
    for (const tok of para.split(/\s+/)) if (tok) word = Math.max(word, lineWidth(tok, s, size));
  }
  const seed = balancedBlockSize(total, lh, o);
  if (!seed) return [Math.max(minW, Math.ceil(word) + 2 * ctx.ti)];
  const lo = Math.max(1, paras.length, seed.lines - 2);
  const hi = Math.max(lo, Math.min(Math.round(o.maxLines), seed.lines + 2));
  const out = new Set();
  for (let n = hi; n >= lo; n--) {
    const cw = Math.max(o.minWidth, (total / n) * o.slack, word);
    out.add(Math.max(minW, Math.ceil(cw) + 2 * ctx.ti));
  }
  return [...out];
}

// Lower is better. The block's aspect - its widest line over its height -
// against the aspect a balloon line is set to (`BALANCED_DEFAULTS`). On the
// log, so too wide and too tall by the same factor cost the same. Every word
// the breaker had to hyphenate costs as much as being off that aspect by a
// factor of e: a width that keeps a long word whole beats a squarer block that
// splits it. Ties go to the narrower box, which is tried first.
const HYPHEN_COST = 1;
function score(ctx, t) {
  const s = t.place.s;
  let blockW = 0;
  for (const line of t.place.lines) blockW = Math.max(blockW, lineWidth(line, s, s.size));
  const target = BALANCED_DEFAULTS.targetAspect;
  return Math.abs(Math.log(blockW / t.place.blockH / target)) + HYPHEN_COST * addedHyphens(ctx, t.place.lines);
}

// Lines the breaker ended inside a word: the last token carries a '-' that no
// word of the text has there. A break after a hyphen the text already has
// (`WELL-` of `WELL-KNOWN`) is not one.
function addedHyphens(ctx, lines) {
  ctx.words ??= applyCase(ctx.text, ctx.style).split(/\s+/);
  let n = 0;
  for (const line of lines) {
    const tok = line.trimEnd().split(/\s+/).pop() ?? '';
    if (tok.length > 1 && tok.endsWith('-') && !ctx.words.some((w) => w.startsWith(tok))) n++;
  }
  return n;
}

// The best candidate that fits at this size, or null: in a balloon the first
// that fits, with only a location the best scored.
function bestAt(ctx, size) {
  let best = null;
  for (const w of widthsAt(ctx, size)) {
    const t = trial(ctx, size, w);
    if (!t?.ok) continue;
    if (ctx.R?.shape) return t;
    t.score = score(ctx, t);
    if (!best || t.score < best.score) best = t;
  }
  return best;
}

// A single word wider than the room its row has - what the flag should say
// rather than "cannot fit above minimum size", which reads as too many words.
function wideWord(ctx, t) {
  const s = t.place.s;
  return t.place.lines.some((line) => {
    const word = line.trim();
    return word !== '' && !/\s/.test(word) && lineWidth(word, s, s.size) + 2 * ctx.ti > t.c.w + CONTAIN_TOL;
  });
}

// Nothing fits: the smallest allowed size at the widest width, in a box no
// taller than the balloon's band, handed to the placement ladder - which grows
// it within the balloon's bounds and the page (`fitLimit`) and flags whatever
// ink is still outside, as it does for any box an edit overfills. Never below
// `minSize`, never a column.
function bestEffort(ctx, size) {
  const widths = widthsAt(ctx, size);
  const t = trial(ctx, size, Math.max(...widths));
  const { R, lk } = ctx;
  const c0 = R?.shape && !lk.height && t.c.h > R.height ? frame(ctx, t.c, R.height) : t.c;
  const r = fitBox(c0, {
    page: ctx.opts.page,
    strip: ctx.opts.strip,
    minSize: size,
    geometry: !(lk.width || lk.height || lk.pos),
  });
  const c = { ...c0, x: r.x, y: r.y, w: r.w, h: r.h };
  const place = placeBlock(c, NO_CACHE);
  const reason = r.review?.reason ?? (wideWord(ctx, { c, place }) ? REVIEW_REASONS.wideWord : REVIEW_REASONS.minSize);
  return result(c, place, 'overflow', [reason], r.review);
}

function result(c, place, status, reasons = [], review = null) {
  return { size: c.style.size, x: c.x, y: c.y, w: c.w, h: c.h, lines: place.lines, status, reasons, review };
}

export function solveLayout({ text, style, refSize, region, locks, opts } = {}) {
  const o = opts ?? {};
  const ref = Number(refSize) > 0 ? Number(refSize) : Number(style?.size);
  if (!style || !(ref > 0)) return null;
  const str = String(text ?? '');
  if (!/\S/.test(str)) return null;
  const box = o.box ?? null;
  const R = regionOf(region);
  const balloon = !!R?.shape;
  const minH = Number(o.minH) > 0 ? Number(o.minH) : 0;
  const ctx = {
    text: str,
    style: { ...style, size: ref },
    R,
    lk: locksOf(locks, box),
    box,
    opts: o,
    ti: textInset(style),
    minW: Number(o.minW) > 0 ? Number(o.minW) : 0,
    // A box never shorter than the caller's floor - except than its balloon.
    minH: balloon ? Math.min(minH, R.height) : minH,
    curve: false,
  };

  const own = bestAt(ctx, ref);
  if (ctx.curve) return null;
  if (own) return result(own.c, own.place, balloon ? 'ok' : 'no-region');

  const floor = Math.min(ref, Math.max(SIZE_STEP, upToGrid(Number(o.minSize) || 0)));
  if (ctx.lk.size || !(floor < ref)) return bestEffort(ctx, ref);
  let best = bestAt(ctx, floor);
  if (!best) return bestEffort(ctx, floor);
  // The largest size on the grid that fits, between the floor (fits) and the
  // reference (does not).
  let lo = floor;
  let hi = upToGrid(ref);
  while (hi - lo > SIZE_STEP) {
    const mid = downToGrid((lo + hi) / 2);
    if (!(mid > lo && mid < hi)) break;
    const t = bestAt(ctx, mid);
    if (t) {
      lo = mid;
      best = t;
    } else hi = mid;
  }
  return result(best.c, best.place, balloon ? 'shrunk' : 'no-region');
}
