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
//                    each: the row's STOPS. Empty only for a row that holds
//                    nothing but the inside of one grapheme (`stopRows`).
//     soft,          the row ends where the line wrapped: its last offset is
//                    also the next row's first (see `rowOf`)
//     hard,          the row ends at a Return that is in the text
//     line,          the drawn line it is, or -1 for a row the layout trims
//     lead, trail }  only where the line broke INSIDE a grapheme
//                    (`stopRows`): the part of it this row draws
//
// WHICH raw offsets are stops is decided in one place: `caretStops` says where
// a caret may stand in a text, and `stopRows` holds every row to it. Nothing
// else makes a stop: `buildRows` only says where each offset of a line would
// be, and the pointer and the keys (`offsetAt`, `moveCaret`) go by the stops
// the rows have.
//
// The rules a row is built by are `buildRows`' comment.
import { wordAt } from './curve-caret.js';

const first = (r) => r.offs[0];
const last = (r) => r.offs[r.offs.length - 1];

// ----- where a caret may stand -----
//
// A caret stands at a grapheme boundary of the RAW text - the text typed,
// not the cased text that is drawn - and nowhere else: not between a letter
// and the mark it carries, not inside a flag, a family or a syllable written
// in jamo, not inside a surrogate pair, whatever a line breaks in and
// whatever the engine's clusters are. As a predicate on raw offsets, or null
// for a text where every offset is one (plain text, the usual case, and a
// runtime with no segmenter).
let graphemes;
let stopsOf = { text: null, at: null };
export function caretStops(text) {
  const v = String(text ?? '');
  if (stopsOf.text === v) return stopsOf.at;
  if (graphemes === undefined) graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  let at = null;
  // eslint-disable-next-line no-control-regex
  if (graphemes && !(/^[\x00-\x7f]*$/.test(v) && !v.includes('\r'))) {
    const set = new Set([v.length]);
    for (const { index } of graphemes.segment(v)) set.add(index);
    at = (o) => set.has(o);
  }
  stopsOf = { text: v, at };
  return at;
}
// The stop one step before (`dir` -1) or after (+1) raw offset `o`.
function stepStop(v, o, dir) {
  const ok = caretStops(v);
  let to = Math.max(0, Math.min(v.length, o + dir));
  while (ok && to > 0 && to < v.length && !ok(to)) to += dir;
  return to;
}

// ----- the rows of a block -----
//
// `segs` is `editLines`' answer for the text the offsets are in: each drawn
// line as `{ start, head, body, hyphen, tail }`. `geom[i]` is where line `i`
// is drawn: `{ top, height, anchor, at[], x[], end }` - `at` the offset of
// each cluster in the LINE'S OWN STRING (ascending, from 0), `x` the pen at
// each, `end` the pen after the last (all absolute, in the caller's px), and
// `anchor` where a caret stands on a line with nothing on it. `space` is what
// one hidden space takes. `bounds`, when given, is a predicate on the offsets
// of `text`: its grapheme boundaries, which a cluster's width is divided by.
//
// What comes back has a place for EVERY offset of every line: where a caret
// there would be. Which of them a caret may stand at is not decided here
// (`stopRows`).
//
// THE RULES.
//
// 1. An offset inside a cluster - the second letter of a ligature - is at an
//    even division of the way to the next cluster's pen, one division per
//    grapheme of the cluster. An offset inside a grapheme is where the
//    grapheme starts.
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
    const pens = g.body.length ? bodyPens(m, g.body.length, ok, bs) : null;
    const x0 = pens ? pens[0] : m.anchor;
    const x1 = pens ? pens[g.body.length] : m.anchor;
    // Rule 2, to the left: the head's spaces after its last Return.
    const lead = g.start + hN;
    for (let o = lead; o < bs; o++) put(o, x0 - (bs - o) * space);
    // The body.
    for (let k = 0; k <= g.body.length; k++) put(bs + k, pens ? pens[k] : x0);
    // Rule 2, to the right: the tail's spaces before its first Return.
    const t = g.tail.indexOf('\n');
    const ns = t < 0 ? g.tail.length : t;
    for (let k = 1; k <= ns; k++) put(be + k, x1 + k * space);
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

// The pen at every offset 0..n of a line's body (rule 1), in one pass over
// its clusters - a line can be as long as a paste makes it. `ok` and `base`
// are for counting the graphemes of a cluster. An offset the first cluster
// does not reach stands at its pen; one past the last cluster's letters, at
// the line's end; and a cluster that starts where the body ends (the
// invented hyphen) leaves the end at its own pen.
function bodyPens(m, n, ok, base) {
  const at = m.at;
  const xs = new Array(n + 1);
  if (!at.length) return xs.fill(m.anchor);
  for (let k = 0; k <= n && k < at[0]; k++) xs[k] = m.x[0];
  for (let c = 0; c < at.length && at[c] <= n; c++) {
    const from = at[c];
    const next = c + 1 < at.length ? at[c + 1] : null;
    const to = Math.min(next ?? n, n);
    const toX = next == null ? m.end : m.x[c + 1];
    xs[from] = m.x[c];
    let parts = 1;
    for (let o = from + 1; o < to; o++) if (ok(base + o)) parts++;
    let before = 0;
    for (let o = from + 1; o < to; o++) {
      if (ok(base + o)) before++;
      xs[o] = m.x[c] + ((toX - m.x[c]) * before) / parts;
    }
    if (next == null) for (let k = Math.max(to, from + 1); k <= n; k++) xs[k] = toX;
  }
  return xs;
}

// ----- an offset on the rows -----

// The row a caret at raw offset `o` shows on. Where a line wrapped, its end
// and the next line's start are one offset: the caret shows on the LOWER row,
// at its start, unless `up` (upstream affinity: it came there by End, by a
// click past the upper row's end, or by Up or Down landing on it).
export function rowOf(rows, o, up = false) {
  const n = rows.length;
  if (!n) return -1;
  let held = -1;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    // A row with no stop of its own never holds the caret.
    if (!r.offs.length) continue;
    held = i;
    if (o > last(r)) continue;
    if (o === last(r) && r.soft && !up && i + 1 < n) return i + 1;
    return i;
  }
  return held;
}

// The x of raw offset `o` on a row: its stop's, or the stop before it when it
// is not one (inside a grapheme), clamped to the row.
function xOn(r, o) {
  let lo = 0;
  let hi = r.offs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (r.offs[mid] <= o) lo = mid;
    else hi = mid - 1;
  }
  return r.xs[lo];
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
    // The part of a grapheme this row draws at its start or its end is
    // selected with the grapheme: before the row's first stop, past its last.
    const head = r.lead && lo <= r.lead.o && hi > r.lead.o ? r.lead.x : null;
    const tail = r.trail && hi >= r.trail.o && lo < r.trail.o ? r.trail.x : null;
    let x0 = head;
    let x1 = tail;
    let brk = 0;
    if (r.offs.length) {
      const from = Math.max(lo, first(r));
      const to = Math.min(hi, last(r));
      if (from > to) continue;
      brk = r.hard && hi > last(r) ? nl : 0;
      if (from === to && !brk && head == null && tail == null) continue;
      x0 ??= xOn(r, from);
      x1 ??= xOn(r, to);
    } else if (head == null || tail == null) continue;
    const left = Math.min(x0, x1);
    out.push({ x: left, y: r.top, w: Math.abs(x1 - x0) + brk, h: r.height });
  }
  return out;
}

// The x a row reaches from and to: its stops, and the parts of a grapheme it
// draws beyond them.
export function rowExtent(r) {
  let from = Infinity;
  let to = -Infinity;
  for (const values of [r.xs, r.extent ?? [], [r.lead?.x, r.trail?.x]]) {
    for (const x of values) {
      if (x == null) continue;
      from = Math.min(from, x);
      to = Math.max(to, x);
    }
  }
  return [from, to];
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
  const k = stopNear(r, x);
  // Nearer the far side of the part of a grapheme this row draws than any
  // stop of the row: the offset on that side of the grapheme, which is a stop
  // of another row. A row with no stop of its own has only those two.
  const d = k < 0 ? Infinity : Math.abs(r.xs[k] - x);
  const dl = r.lead ? Math.abs(r.lead.x - x) : Infinity;
  const dt = r.trail ? Math.abs(r.trail.x - x) : Infinity;
  if (r.trail && dt <= d && dt <= dl) return { o: r.trail.o, up: false, row: i };
  if (r.lead && dl < d) return { o: r.lead.o, up: false, row: i };
  return { o: r.offs[k], up: r.soft && k === r.offs.length - 1, row: i };
}
// The stop of a row nearest an x, as its index: the later of two as near.
// -1 for a row with none.
function stopNear(r, x) {
  let k = -1;
  let d = Infinity;
  for (let j = 0; j < r.xs.length; j++) {
    const dj = Math.abs(r.xs[j] - x);
    if (dj <= d) {
      d = dj;
      k = j;
    }
  }
  return k;
}

// ----- two presses, and three -----
//
// What a double-click and a triple-click select is what the browser selects
// in the editable these rows stand in for (measured in Chromium, at both
// halves of every letter of the check's boxes; scripts/editor-check.mjs,
// `type`):
//
//   two     the caret goes where one press puts it, and the selection is the
//           word, the run of spaces, the mark or the Return that STARTS at or
//           holds that offset - so the right half of a word's last letter
//           selects the space after it. At the end of the text, the last such
//           run. Where a row wrapped and the press is past its end, nothing:
//           the caret alone, on that row.
//   three   the row the press is level with, whole: with the space it wrapped
//           at, and with its Return when it ends at one.
//
// Both as `{ a, f, up }`.

// The run of `text` that holds the character at offset `o`, as [start, end]:
// the browser's own idea of a word (Intl.Segmenter, which is the rule its
// double-click goes by).
let words;
export function wordAround(text, o) {
  const v = String(text ?? '');
  if (!v) return [0, 0];
  const at = Math.min(Math.max(0, o), v.length - 1);
  if (words === undefined) words = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
  if (!words) return wordAt(v, at);
  const seg = words.segment(v).containing(at);
  return [seg.index, seg.index + seg.segment.length];
}

export function wordPress(rows, text, x, y) {
  const hit = offsetAt(rows, x, y);
  if (hit.up) return { a: hit.o, f: hit.o, up: true };
  const [a, b] = wordAround(text, hit.o);
  return { a, f: b, up: false };
}

export function linePress(rows, text, x, y) {
  const r = rows[offsetAt(rows, x, y).row];
  if (!r) return { a: 0, f: 0, up: false };
  // With the whole of a letter it draws half of.
  const a = r.lead ? r.lead.o : first(r);
  const f = r.trail ? r.trail.o : r.hard ? Math.min(last(r) + 1, String(text ?? '').length) : last(r);
  return { a, f, up: r.soft };
}

// The raw span of the row a caret is on, `[from, to]`: what the soft-line
// deletes are cut from.
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
//   LineUp, LineDown  one step back and then that row's start; one step on
//                     and then that row's end (what the system does for
//                     Option+Up and Option+Down: `boundKey`)
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
    return done(stepStop(v, f, dir));
  }
  if (k === 'LineUp' || k === 'LineDown') {
    const back = k === 'LineUp';
    // The step is the system's `moveBackward` / `moveForward`: a selection
    // closes on its start or its end instead. The offset it arrives at is
    // looked for on the side the step came from.
    const o = a !== f ? (back ? Math.min(a, f) : Math.max(a, f)) : stepStop(v, f, back ? -1 : 1);
    const to = rows[rowOf(rows, o, !back)];
    if (!to) return null;
    return back ? done(first(to)) : done(last(to), to.soft);
  }
  const i = rowOf(rows, f, up);
  if (i < 0) return null;
  const r = rows[i];
  if (k === 'Home') return done(first(r));
  if (k === 'End') return done(last(r), r.soft);
  if (k === 'ArrowUp' || k === 'ArrowDown') {
    const gx = goal ?? xOn(r, f);
    const dir = k === 'ArrowUp' ? -1 : 1;
    // The next row a caret can stand on: one that holds only the inside of a
    // grapheme is passed over.
    let j = i + dir;
    while (j >= 0 && j < rows.length && !rows[j].offs.length) j += dir;
    if (j < 0) return done(0, false, gx);
    if (j >= rows.length) return done(v.length, false, gx);
    // A stop of that row itself, so the caret is on it.
    const to = rows[j];
    const at = stopNear(to, gx);
    return done(to.offs[at], to.soft && at === to.offs.length - 1, gx);
  }
  return null;
}

// The raw span `[a, b]` a line delete takes, for a caret at `f`, or null for
// an input that is not one. A span of nothing is given as `[f, f]`: the edit
// then takes one character, as it does for any delete over nothing
// (`rawEdit`).
//
// All four go to the start or the end of OUR row, which the hidden
// editable's own blocks know nothing of. The "hard" ones name a paragraph,
// and in the editable the app draws a paragraph IS a drawn line: each line
// is a block of its own (`drawEditLines`), so with the switch off the
// browser's target for them is the line the caret is on. The system's WebKit
// sends Cmd+Backspace as `deleteHardLineBackward` (run: P7-REPORT, "Second
// round"); Chromium sends it as `deleteSoftLineBackward`.
export function lineDeleteSpan(rows, text, f, up, inputType) {
  if (inputType === 'deleteSoftLineBackward' || inputType === 'deleteHardLineBackward') return [Math.min(rowSpan(rows, f, up)[0], f), f];
  if (inputType === 'deleteSoftLineForward' || inputType === 'deleteHardLineForward') return [f, Math.max(rowSpan(rows, f, up)[1], f)];
  return null;
}

// ----- the keys the system binds -----
//
// macOS binds Control and Option keys to moves and a cut that go by lines
// and paragraphs (AppKit's StandardKeyBinding.dict), and a browser answers
// each on the blocks of the editable. In the editable the app draws, every
// line of the picture is a block, so the system's "paragraph" is a drawn
// line there; and with the editable unseen under a picture its blocks are not
// where the caret is drawn (a caret on the upper side of a wrap is, to the
// browser, at the start of the row below). So each is answered on our rows,
// as the key of `moveCaret` that does there what the browser did on its
// blocks with the switch off (every one run in the system's WebKit:
// P7-REPORT, "Second round"):
//
//   Ctrl+A, Ctrl+Left      Home         Ctrl+E, Ctrl+Right    End
//   Ctrl+P                 ArrowUp      Ctrl+N                ArrowDown
//   Ctrl+B                 ArrowLeft    Ctrl+F                ArrowRight
//   Ctrl+V, Opt+PageDown   PageDown     Opt+PageUp            PageUp
//   Opt+Up                 LineUp       Opt+Down              LineDown
//   Opt+Shift+Up, Down     Shift+ArrowUp, Shift+ArrowDown (the same column
//                          of the paragraph before and after: the row's)
//   Ctrl+K                 Kill: the cut from the caret to the row's end
//
// Shift extends, as the system's "AndModifySelection" forms do. As `{ key,
// shift }`, or null for a key that is the browser's as it was: Ctrl+D, H, T,
// O and Y arrive as a `beforeinput` at a raw offset, Option+Left and Right
// step by the words of the raw text, and Ctrl+Up and Down scroll.
const CTRL_KEYS = { a: 'Home', e: 'End', p: 'ArrowUp', n: 'ArrowDown', b: 'ArrowLeft', f: 'ArrowRight', v: 'PageDown', k: 'Kill', ArrowLeft: 'Home', ArrowRight: 'End' };
export function boundKey({ key, ctrlKey, altKey, metaKey, shiftKey }) {
  if (metaKey || ctrlKey === altKey) return null;
  const shift = !!shiftKey;
  if (ctrlKey) {
    const to = CTRL_KEYS[key.length === 1 ? key.toLowerCase() : key];
    if (!to || (to === 'Kill' && shift)) return null;
    return { key: to, shift };
  }
  if (key === 'ArrowUp' || key === 'ArrowDown') return shift ? { key, shift } : { key: key === 'ArrowUp' ? 'LineUp' : 'LineDown', shift };
  if (key === 'PageUp' || key === 'PageDown') return { key, shift };
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

// ----- the one place a stop is made -----
//
// `rows` are `buildRows`': a place for every offset of every line, in the
// offsets of the text that is DRAWN. `map` is `caseMap`'s for it (null when
// the drawn offsets are the raw ones), and `stops` is `caretStops` of the RAW
// text (null when a caret may stand at every offset of it; with a map and no
// `stops`, a raw offset inside a surrogate pair - which has its pair's cased
// offset - is the one place known to be inside a letter).
//
// A raw offset is a stop of a row when a caret may stand there in the raw
// text AND the row has a place for it. So none is between the two S of one
// "ß", none between a base and the mark it carries, none inside a flag or a
// family, and a row keeps the ends it shares with its neighbours.
//
// A line can break INSIDE a grapheme: a letter drawn as two ("ß" as "SS",
// wrapped or hyphenated between the S), or a box narrower than a flag, which
// the breaker sees as two letters. The lines are the painter's and stay as
// they are, but neither row then ends at a stop on that side. Each says which
// part of the grapheme it draws there:
//
//   trail: { x, o }   the row ENDS inside one: where its part ends, and the
//                     raw offset after the whole grapheme (a stop of a later
//                     row)
//   lead:  { x, o }   the row STARTS inside one: where its part starts, and
//                     the raw offset before the whole grapheme
//
// so a selection of the grapheme covers every part of it (`selectionRects`),
// a press on a part goes to the nearer side of the WHOLE (`offsetAt`), and no
// caret is ever drawn between the parts. A row that ends so is not `soft`:
// nothing is shared. A row that holds nothing but the inside of one grapheme
// (the middle of a family in a box one letter wide) has both and no stop.
export function stopRows(rows, map, stops = null) {
  if (!map && !stops) return rows;
  const t = map ? map.toDrawn : null;
  const drawn = t ? (o) => t[o] : (o) => o;
  const ok = stops ?? ((o) => o === 0 || t[o] !== t[o - 1]);
  // The raw text's length: the last place of the last row, as a raw offset.
  const end = t ? t.length - 1 : rows.reduce((n, r) => Math.max(n, last(r)), 0);
  // A single grapheme may span every row of a narrow box. Find its neighbours
  // once, rather than walking the same grapheme back and forth on every row.
  const legal = new Uint8Array(end + 1);
  const before = new Uint32Array(end + 1);
  const after = new Uint32Array(end + 1);
  let near = 0;
  for (let o = 0; o <= end; o++) {
    legal[o] = ok(o) ? 1 : 0;
    if (legal[o]) near = o;
    before[o] = near;
  }
  near = end;
  for (let o = end; o >= 0; o--) {
    if (legal[o]) near = o;
    after[o] = near;
  }
  const out = [];
  for (const r of rows) {
    const offs = [];
    const xs = [];
    const lo = t ? rawAtDrawn(map, first(r)) : first(r);
    const to = last(r);
    let k = 0;
    let o = lo;
    for (; o <= end && drawn(o) <= to; o++) {
      if (!legal[o]) continue;
      while (k < r.offs.length && r.offs[k] < drawn(o)) k++;
      if (r.offs[k] !== drawn(o)) continue;
      offs.push(o);
      xs.push(r.xs[k]);
    }
    // The row starts, or ends, inside a grapheme: at a place that is not a
    // stop. The stop before it, and the stop after.
    let lead = null;
    if (!offs.length || drawn(offs[0]) !== first(r)) {
      let p = Math.min(lo, end);
      if (drawn(p) >= first(r)) p--;
      lead = { x: r.xs[0], o: before[Math.max(p, 0)] };
    }
    let trail = null;
    if (!offs.length || drawn(offs[offs.length - 1]) !== to) {
      trail = { x: r.xs[r.xs.length - 1], o: after[Math.min(o, end)] };
    }
    // Keep the full geometry before illegal stops are removed: with negative
    // spacing, an interior pen may reach beyond either legal endpoint.
    out.push({ ...r, offs, xs, extent: rowExtent(r), soft: r.soft && !trail, ...(lead ? { lead } : null), ...(trail ? { trail } : null) });
  }
  return out;
}
