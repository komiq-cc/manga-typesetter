// ===== the caret on straight text that is a picture =====
//
// With the Rust engine drawing, a box being typed into stays the picture it
// is at rest (TextBox.svelte), and the text sits in an editable nobody sees.
// So everything the browser used to do with the glyphs it laid out - a caret
// at an offset, a selection's rectangles, the offset under a pointer, Up and
// Down, Home and End, a line's extent for a delete - is done here, on ROWS:
// the lines the painter draws, each with the raw offsets a caret can stand at
// on it and the x of each. curve-caret.js is the same thing for text on a
// curve, which is one row of turned glyphs.
//
// This file is arithmetic on rows and reads no DOM and no engine. Where the
// rows come from - the painter's own lines and pen positions - is
// type-rows.js.
//
// A row is
//
//   { top, height,   the line box, in the px the caller draws in
//     offs[], xs[],  raw offsets (UTF-16, ascending) and the x of a caret at
//                    each: the row's STOPS. Never empty.
//     soft,          the row ends where the line wrapped: its last offset is
//                    also the next row's first (see `rowOf`)
//     hard,          the row ends at a Return that is in the text
//     line }         the drawn line it is, or -1 for a row the layout trims
//
// and the rules a row is built by are `buildRows`' comment.
import { stepChar } from './edit-lines.js';

const first = (r) => r.offs[0];
const last = (r) => r.offs[r.offs.length - 1];

// ----- the rows of a block -----
//
// `segs` is `editLines`' answer for the text the offsets are in: each drawn
// line as `{ start, head, body, hyphen, tail }`. `geom[i]` is where line `i`
// is drawn: `{ top, height, anchor, at[], x[], end }` - `at` the offset of
// each cluster in the LINE'S OWN STRING (ascending, from 0), `x` the pen at
// each, `end` the pen after the last (all absolute, in the caller's px), and
// `anchor` where a caret stands on a line with nothing on it. `space` is what
// one hidden space takes. `bounds`, when given, is a predicate: whether a
// caret may stand at an offset at all (a grapheme boundary).
//
// THE RULES.
//
// 1. A stop inside a cluster - the second letter of a ligature - is at an
//    even division of the way to the next cluster's pen, one division per
//    grapheme of the cluster. An offset inside a grapheme is not a stop.
// 2. Whitespace the layout does not draw HANGS: the space a line wrapped at
//    and the spaces a paragraph ends with stand `space` apart to the right of
//    the line's last pen, and the leading spaces a paragraph lost to the left
//    of its first. They take no room on the line, and the caret moves over
//    them.
// 3. A line that wrapped ends at the offset the next one starts at (`soft`).
//    `rowOf` decides which of the two rows a caret there shows on.
// 4. A Return ends its row before it and starts the next after it.
// 5. The Returns before the first line and after the last, which the layout
//    trims, each have a row of their own a line height above or below the
//    block, with every stop at the anchor.
// 6. A line with nothing on it has its one stop at the anchor.
export function buildRows(text, segs, geom, { space = 0, bounds = null } = {}) {
  const raw = String(text ?? '');
  const rows = [];
  const ok = (o) => !bounds || bounds(o);
  const n = segs.length;
  for (let i = 0; i < n; i++) {
    const g = segs[i];
    const m = geom[i];
    const bs = g.start + g.head.length;
    const be = bs + g.body.length;
    const hN = g.head.lastIndexOf('\n') + 1;
    // Rule 5, above the block: the head's Returns, on the first line only.
    if (i === 0 && hN) {
      const breaks = [];
      for (let k = 0; k < hN; k++) if (g.head[k] === '\n') breaks.push(g.start + k);
      let from = g.start;
      breaks.forEach((p, k) => {
        rows.push(edgeRow(from, p, m.top - (breaks.length - k) * m.height, m, true));
        from = p + 1;
      });
    }
    const offs = [];
    const xs = [];
    const put = (o, x) => {
      if (offs.length && offs[offs.length - 1] === o) return;
      offs.push(o);
      xs.push(x);
    };
    const x0 = g.body.length ? penAt(m, 0, g.body, ok, bs) : m.anchor;
    const x1 = g.body.length ? penAt(m, g.body.length, g.body, ok, bs) : m.anchor;
    // Rule 2, to the left: the head's spaces after its last Return.
    const lead = g.start + hN;
    for (let o = lead; o < bs; o++) if (o === lead || ok(o)) put(o, x0 - (bs - o) * space);
    // The body. Its two ends are stops whatever `bounds` says.
    for (let k = 0; k <= g.body.length; k++) {
      if (k && k < g.body.length && !ok(bs + k)) continue;
      put(bs + k, k === 0 ? x0 : k === g.body.length ? x1 : penAt(m, k, g.body, ok, bs));
    }
    // Rule 2, to the right: the tail's spaces before its first Return.
    const t = g.tail.indexOf('\n');
    const ns = t < 0 ? g.tail.length : t;
    for (let k = 1; k <= ns; k++) if (k === ns || ok(be + k)) put(be + k, x1 + k * space);
    const isLast = i + 1 === n;
    const hard = t >= 0;
    if (hard && !isLast) {
      // A tail with more than one Return (a line the breaker dropped whole):
      // the offsets between them have nowhere of their own and stand at the
      // row's end.
      for (let o = be + ns + 1; o < be + g.tail.length; o++) put(o, x1 + ns * space);
    }
    rows.push({ top: m.top, height: m.height, offs, xs, soft: !hard && !isLast, hard, line: i });
    // Rule 5, below the block: what follows the last line's first Return.
    if (hard && isLast) {
      let from = be + ns + 1;
      let k = 1;
      for (let o = from; o < raw.length; o++) {
        if (raw[o] !== '\n') continue;
        rows.push(edgeRow(from, o, m.top + k * m.height, m, true));
        from = o + 1;
        k++;
      }
      rows.push(edgeRow(from, raw.length, m.top + k * m.height, m, false));
    }
  }
  return rows;
}

// A row the layout trims: every offset of it at the anchor.
function edgeRow(from, to, top, m, hard) {
  const offs = [];
  const xs = [];
  for (let o = from; o <= to; o++) {
    offs.push(o);
    xs.push(m.anchor);
  }
  return { top, height: m.height, offs, xs, soft: false, hard, line: -1 };
}

// The pen at offset `k` of a line's body (rule 1). `ok` and `base` are for
// counting the graphemes of the cluster `k` falls in.
function penAt(m, k, body, ok, base) {
  const at = m.at;
  let c = at.length - 1;
  while (c > 0 && at[c] > k) c--;
  if (!at.length) return m.anchor;
  if (at[c] === k) return m.x[c];
  if (k < at[0]) return m.x[0];
  const next = c + 1 < at.length ? at[c + 1] : null;
  const to = next ?? body.length;
  const toX = next == null ? m.end : m.x[c + 1];
  // Past the body's end is the invented hyphen's cluster, or nothing.
  if (k >= to) return toX;
  let parts = 1;
  let before = 0;
  for (let o = at[c] + 1; o < to; o++) {
    if (!ok(base + o)) continue;
    parts++;
    if (o <= k) before++;
  }
  return m.x[c] + ((toX - m.x[c]) * before) / parts;
}

// ----- an offset on the rows -----

// The row a caret at raw offset `o` shows on. Where a line wrapped, its end
// and the next line's start are one offset: the caret shows on the LOWER row,
// at its start, unless `up` (upstream affinity: it came there by End, by a
// click past the upper row's end, or by Up or Down landing on it).
export function rowOf(rows, o, up = false) {
  const n = rows.length;
  if (!n) return -1;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (o > last(r)) continue;
    if (o === last(r) && r.soft && !up && i + 1 < n) return i + 1;
    return i;
  }
  return n - 1;
}

// The x of raw offset `o` on a row: its stop's, or the stop before it when it
// is not one (inside a grapheme), clamped to the row.
function xOn(r, o) {
  let k = r.offs.length - 1;
  while (k > 0 && r.offs[k] > o) k--;
  return r.xs[k];
}

// Where the caret stands: `{ x, top, height, row }`. Null with no rows.
export function caretAt(rows, o, up = false) {
  const i = rowOf(rows, o, up);
  if (i < 0) return null;
  const r = rows[i];
  return { x: xOn(r, o), top: r.top, height: r.height, row: i };
}

// The selection between raw offsets `a` and `b`, one rectangle a row:
// `{ x, y, w, h }`. A row whose Return is inside the selection is `nl` wider,
// so a selected empty line shows.
export function selectionRects(rows, a, b, nl = 0) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out = [];
  if (lo === hi) return out;
  for (const r of rows) {
    const from = Math.max(lo, first(r));
    const to = Math.min(hi, last(r));
    if (from > to) continue;
    const brk = r.hard && hi > last(r) ? nl : 0;
    if (from === to && !brk) continue;
    const x0 = xOn(r, from);
    const x1 = xOn(r, to);
    const left = Math.min(x0, x1);
    out.push({ x: left, y: r.top, w: Math.abs(x1 - x0) + brk, h: r.height });
  }
  return out;
}

// ----- a point on the rows -----

// The row at height `y`: the one whose line box holds it, the first above
// them all and the last below.
function rowAt(rows, y) {
  let best = 0;
  for (let i = 0; i < rows.length; i++) {
    if (y >= rows[i].top) best = i;
  }
  // Rows are in reading order, top to bottom, except that nothing says the
  // rows above the block come first in `y` - they do, by construction.
  return best;
}

// The caret position nearest a point: `{ o, up, row }`. The nearest stop of
// the row the point is level with; the later of two that are as near, so a
// press exactly between two letters goes after the first.
export function offsetAt(rows, x, y) {
  if (!rows.length) return { o: 0, up: false, row: -1 };
  const i = rowAt(rows, y);
  const r = rows[i];
  let k = 0;
  let d = Infinity;
  for (let j = 0; j < r.xs.length; j++) {
    const dj = Math.abs(r.xs[j] - x);
    if (dj <= d) {
      d = dj;
      k = j;
    }
  }
  return { o: r.offs[k], up: r.soft && k === r.offs.length - 1, row: i };
}

// The offset of the character under a point - the stop at or before it, not
// the nearest: the right half of a word's last letter is still that letter.
// A double-click selects the word around it.
export function glyphAt(rows, x, y) {
  if (!rows.length) return 0;
  const r = rows[rowAt(rows, y)];
  const n = r.offs.length;
  if (n < 2) return r.offs[0];
  for (let j = n - 2; j >= 0; j--) if (x >= r.xs[j]) return r.offs[j];
  return r.offs[0];
}

// The raw span of the row a caret is on, `[from, to]`: what a triple-click
// selects and what the soft-line deletes are cut from.
export function rowSpan(rows, o, up = false) {
  const i = rowOf(rows, o, up);
  return i < 0 ? [0, 0] : [first(rows[i]), last(rows[i])];
}

// ----- keys -----

// Where a caret key takes the selection `{ a, f, up }` (anchor, focus, the
// focus's affinity), as `{ a, f, up, goal }`, or null for a key that is not
// one of these. `mods` is `{ shift, mod }`, `mod` being Cmd; `goal` is the x
// Up and Down are aiming for, kept between them and null after anything else.
//
//   Left, Right       one grapheme of the raw text; with a selection and no
//                     Shift, to its start or its end
//   Up, Down          the stop nearest `goal` on the row above or below;
//                     off the first row to the text's start, off the last to
//                     its end
//   Home, End,        the row's first and last stop (End takes upstream
//   Cmd+Left/Right    affinity where the row wrapped)
//   Cmd+Up/Down,      the text's start and end
//   PageUp/PageDown
export function moveCaret(rows, text, sel, key, mods = {}, goal = null) {
  const v = String(text ?? '');
  const { a, f } = sel;
  const up = !!sel.up;
  const shift = !!mods.shift;
  const done = (to, upTo = false, g = null) => ({ a: shift ? a : to, f: to, up: upTo, goal: g });
  let k = key;
  if (mods.mod) {
    k = { ArrowLeft: 'Home', ArrowRight: 'End', ArrowUp: 'PageUp', ArrowDown: 'PageDown' }[key] ?? null;
    if (!k) return null;
  }
  if (k === 'PageUp') return done(0);
  if (k === 'PageDown') return done(v.length);
  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    const dir = k === 'ArrowLeft' ? -1 : 1;
    if (!shift && a !== f) return done(dir < 0 ? Math.min(a, f) : Math.max(a, f));
    return done(stepChar(v, f, dir));
  }
  const i = rowOf(rows, f, up);
  if (i < 0) return null;
  const r = rows[i];
  if (k === 'Home') return done(first(r));
  if (k === 'End') return done(last(r), r.soft);
  if (k === 'ArrowUp' || k === 'ArrowDown') {
    const gx = goal ?? xOn(r, f);
    const j = i + (k === 'ArrowUp' ? -1 : 1);
    if (j < 0) return done(0, false, gx);
    if (j >= rows.length) return done(v.length, false, gx);
    const hit = offsetAt([rows[j]], gx, rows[j].top);
    return done(hit.o, hit.up, gx);
  }
  return null;
}

// The raw span `[a, b]` a line delete takes, for a caret at `f`, or null for
// an input that is not one. A span of nothing is given as `[f, f]`: the edit
// then takes one character, as it does for any delete over nothing
// (`rawEdit`).
//
//   deleteSoftLineBackward / Forward   to the row's start / end: OUR row,
//                                      which the hidden editable's own
//                                      wrapping knows nothing of
//   deleteHardLineBackward / Forward   to the paragraph's start / end in the
//                                      raw text
export function lineDeleteSpan(rows, text, f, up, inputType) {
  const v = String(text ?? '');
  if (inputType === 'deleteSoftLineBackward') return [Math.min(rowSpan(rows, f, up)[0], f), f];
  if (inputType === 'deleteSoftLineForward') return [f, Math.max(rowSpan(rows, f, up)[1], f)];
  if (inputType === 'deleteHardLineBackward') return [f <= 0 ? 0 : v.lastIndexOf('\n', f - 1) + 1, f];
  if (inputType === 'deleteHardLineForward') {
    const e = v.indexOf('\n', f);
    return [f, e < 0 ? v.length : e];
  }
  return null;
}

// ----- text whose casing changes its length -----
//
// The picture shows `applyCase(text)`; offsets are raw. Uppercasing can make a
// letter longer ("ß" is "SS"), and then a raw offset is not the cased one.
// `caseMap` is the raw offset of every boundary in cased terms:
//
//   null         the two are one for one (nothing to map)
//   { toDrawn }  `toDrawn[o]` is the cased offset of raw offset `o`
//   false        the cased text is not the raw text's letters cased one by
//                one, so there is no map (the caller types into DOM text)
//
// `upper` is the casing of ONE code point; uppercasing has no rule that looks
// at a letter's neighbours, so a string's is its letters' end to end - and
// that is checked here against `cased`, not assumed.
export function caseMap(raw, cased, upper = (ch) => ch.toUpperCase()) {
  const t = String(raw ?? '');
  const c = String(cased ?? '');
  if (t.length === c.length) return null;
  const toDrawn = new Array(t.length + 1);
  let d = 0;
  let o = 0;
  for (const ch of t) {
    const u = upper(ch);
    if (c.substr(d, u.length) !== u) return false;
    for (let k = 0; k < ch.length; k++) toDrawn[o + k] = d;
    o += ch.length;
    d += u.length;
  }
  if (d !== c.length) return false;
  toDrawn[t.length] = d;
  return { toDrawn };
}

// The smallest raw offset whose cased offset is at or after `d`.
export function rawAtDrawn(map, d) {
  const t = map.toDrawn;
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] >= d) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// Rows made in cased offsets, in raw ones: a stop stays where a raw offset
// lands on it and goes where none does (between the two S of one "ß"), and a
// row keeps its ends, so what two rows shared they still share.
export function mapRows(rows, map) {
  if (!map) return rows;
  const t = map.toDrawn;
  return rows.map((r) => {
    const offs = [];
    const xs = [];
    const lo = rawAtDrawn(map, first(r));
    const hi = rawAtDrawn(map, last(r));
    for (let o = lo; o <= hi; o++) {
      // A raw offset inside a surrogate pair has its pair's cased offset.
      if (o > lo && t[o] === t[o - 1]) continue;
      offs.push(o);
      xs.push(xOn(r, Math.min(Math.max(t[o], first(r)), last(r))));
    }
    if (!offs.length) {
      offs.push(lo);
      xs.push(r.xs[0]);
    }
    return { ...r, offs, xs };
  });
}
