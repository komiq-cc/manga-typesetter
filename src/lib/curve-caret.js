// ===== the caret on curved text (UX-4) =====
//
// Curved text - an arc, a circle, a bezier path, SFX lettering - is placed
// glyph by glyph (`arcLayout`, `circleLayout`, `pathLayout`, `sfxLayout`), one
// glyph per code point of the cased text, each with its centre, its advance
// width and the angle it is turned to, and an SFX glyph its own scale. While it is typed into, the box draws those same glyphs, so what
// is typed is the result; the text itself sits in an editable nobody sees, and
// the caret and the selection are drawn here, on the glyphs.
//
// A caret stands on a glyph's edge: its centre moved half its advance along
// the way it is turned. Between two glyphs it stands halfway across the gap
// the letter spacing leaves, turned halfway between them, so on a tight bend
// it still leans the way the text runs.
//
// Positions are what the layouts give: px from the box centre, in the px the
// layout was made in (the zoomed size), angles in radians.

// A raw offset (UTF-16) as a glyph index (a code point), and back. The layouts
// place `[...text]`, so an emoji is one glyph and two code units.
export function glyphIndex(text, o) {
  let i = 0;
  let k = 0;
  for (const ch of String(text ?? '')) {
    if (k >= o) break;
    k += ch.length;
    i++;
  }
  return i;
}
export function rawIndex(text, i) {
  let k = 0;
  let n = 0;
  for (const ch of String(text ?? '')) {
    if (n >= i) break;
    k += ch.length;
    n++;
  }
  return k;
}

// Whether the glyphs of `cased` are the characters of `text` one for one, so
// a glyph index is a raw position. Not when uppercasing changed the count
// ("ß" is "SS"); such a box is typed into flat, as it always was.
export function glyphsMatch(text, cased) {
  return [...String(text ?? '')].length === [...String(cased ?? '')].length;
}

// How far along its turn a glyph reaches: its advance, times its own scale
// where it has one. An SFX glyph (sfx.js) is painted scaled about its centre,
// `sx` along the way it is turned, so a letter grown to half as wide again
// stands that much past its advance on both sides, and its caret, its
// highlight and what a click on it finds go out to where it is painted. The
// other curves have no `sx`, and are their advance.
export function glyphReach(g) {
  const sx = Math.abs(g.sx);
  return Number.isFinite(sx) ? g.w * sx : g.w;
}

function edge(g, side) {
  const h = (side * glyphReach(g)) / 2;
  return { x: g.x + h * Math.cos(g.rot), y: g.y + h * Math.sin(g.rot), rot: g.rot };
}

// Where the caret stands before glyph `i` (after the last one at `i` = n), as
// `{ x, y, rot }`. With no glyphs, at the box centre.
export function caretAt(glyphs, i) {
  const n = glyphs?.length ?? 0;
  if (!n) return { x: 0, y: 0, rot: 0 };
  if (i <= 0) return edge(glyphs[0], -1);
  if (i >= n) return edge(glyphs[n - 1], 1);
  const a = edge(glyphs[i - 1], 1);
  const b = edge(glyphs[i], -1);
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    rot: Math.atan2(Math.sin(a.rot) + Math.sin(b.rot), Math.cos(a.rot) + Math.cos(b.rot)),
  };
}

// The glyph nearest a point: the one whose advance - the stretch of curve it
// covers - passes closest, as `{ i, after }`, `after` when the point is past
// its middle. Measured along each glyph's own turn, so it holds on a circle,
// upside down on its inner face, as well as on a gentle arc. Null for no glyphs.
export function glyphNearest(glyphs, x, y) {
  const n = glyphs?.length ?? 0;
  if (!n) return null;
  let best = 0;
  let bestD = Infinity;
  let bestAlong = 0;
  for (let i = 0; i < n; i++) {
    const g = glyphs[i];
    const c = Math.cos(g.rot);
    const sn = Math.sin(g.rot);
    const dx = x - g.x;
    const dy = y - g.y;
    const along = dx * c + dy * sn;
    const across = -dx * sn + dy * c;
    const off = Math.max(0, Math.abs(along) - glyphReach(g) / 2);
    const d = Math.hypot(off, across);
    if (d < bestD) {
      bestD = d;
      best = i;
      bestAlong = along;
    }
  }
  return { i: best, after: bestAlong >= 0 };
}

// The caret position nearest a point: the nearest glyph's, on the side of its
// middle the point is on.
export function caretNearest(glyphs, x, y) {
  const g = glyphNearest(glyphs, x, y);
  return g ? g.i + (g.after ? 1 : 0) : 0;
}

// The selection from glyph `i` up to glyph `j`, as one box per glyph running
// from the caret before it to the caret after it, so the gaps between letters
// are covered and the highlight follows the curve: `{ x, y, w, rot }`, centred.
export function selectionBoxes(glyphs, i, j) {
  const out = [];
  const n = glyphs?.length ?? 0;
  for (let k = Math.max(0, Math.min(i, j)); k < Math.min(n, Math.max(i, j)); k++) {
    const a = caretAt(glyphs, k);
    const b = caretAt(glyphs, k + 1);
    out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: Math.hypot(b.x - a.x, b.y - a.y), rot: glyphs[k].rot });
  }
  return out;
}

// Where a caret key takes the caret on curved text, as a raw offset, or null
// for a key the browser handles as it would anyway. The editable nobody sees
// wraps its own way, so its idea of a line is not the curve's: Home and End
// (and Cmd+Left, Cmd+Right, `mod`) go to the start and end of the paragraph in
// the raw text, and Up and Down to the start and end of the text, as in a
// one-line field - the curve is one line, whatever Returns are in it.
export function caretKey(text, o, key, mod = false) {
  const v = String(text ?? '');
  if (key === 'ArrowUp') return 0;
  if (key === 'ArrowDown') return v.length;
  if (key === 'Home' || (mod && key === 'ArrowLeft')) return o <= 0 ? 0 : v.lastIndexOf('\n', o - 1) + 1;
  if (key === 'End' || (mod && key === 'ArrowRight')) {
    const e = v.indexOf('\n', o);
    return e < 0 ? v.length : e;
  }
  return null;
}

// The word at raw offset `o`, as [start, end]: the run of letters around it,
// or of spaces when it is between words. A double-click selects it.
export function wordAt(text, o) {
  const v = String(text ?? '');
  if (!v) return [0, 0];
  const at = Math.min(Math.max(0, o), v.length - 1);
  const kind = (ch) => (/\s/.test(ch) ? 0 : /[\p{L}\p{N}_'’-]/u.test(ch) ? 1 : 2);
  const k = kind(v[at]);
  let a = at;
  let b = at + 1;
  while (a > 0 && kind(v[a - 1]) === k) a--;
  while (b < v.length && kind(v[b]) === k) b++;
  return [a, b];
}
