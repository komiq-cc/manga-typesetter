// ===== the box being typed into, broken where the result breaks (UX-4) =====
//
// A box being typed into used to hand its raw text to the browser, which
// wrapped it at the box's width in its own way - greedy, breaking inside a long
// word - while every other picture of the box (the canvas, the export, the PSD)
// is drawn from `layoutLines`: balanced breaks, invented hyphens, the balloon's
// per-line widths. So the text jumped the moment the edit ended, and a word
// that fitted while typing could spill out after.
//
// Now the edit shows `layoutLines`' own lines, and this is the map that makes
// that possible: each line as the slice of the RAW text it came from. The
// editable is one element per line, and the text the user edits is still the
// raw text - every character of it is in exactly one slice, in order, so the
// element's `textContent` is the raw text and a position in it is a raw offset.
//
// What `layoutLines` takes out of the text between two lines is whitespace (the
// space a line wrapped at, the newline between paragraphs, the stray Returns at
// either end of the block), and what it adds is the hyphen at an invented break.
// So a line is:
//
//   head    whitespace before the line that belongs to it: a new paragraph's
//           leading spaces when the breaker dropped them, and before the first
//           line anything the block trimmed. Not shown.
//   body    the characters the line draws, exactly - `line` minus an invented
//           hyphen, before `applyCase` (the editable uppercases with CSS).
//   hyphen  true when the line ends at a hyphen the breaker added; drawn by the
//           editable, and not a character of the text.
//   tail    whitespace after the line up to and including the newline that
//           ends its paragraph, or the space it wrapped at. Not shown.
//
// `start` is where the head begins in the raw text. Null when the lines cannot
// be laid over the text - a case change that changes the length ("ß" upper-
// cases to "SS"), or a breaker that did something this does not know about -
// and the caller falls back to letting the browser wrap.

const WS = /\s/;

// `text` is the raw text, `cased` is `applyCase(text, style)` - what the lines
// were broken from - and `lines` is what `layoutLines` returned for it.
export function editLines(text, cased, lines) {
  const raw = String(text ?? '');
  // The breaker sees a tab as a space (`layoutLines`), and so does this.
  const t = String(cased ?? '').replace(/\t/g, ' ');
  if (t.length !== raw.length || !Array.isArray(lines) || lines.length === 0) return null;
  const at = [];
  let c = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i]);
    let pos;
    let body;
    let hyphen = false;
    if (line === '') {
      // A blank paragraph: it starts after the newline that ends the one
      // before it. The first line is only blank when the whole text is.
      if (i === 0) pos = 0;
      else {
        let k = c;
        while (k < t.length && t[k] !== '\n' && WS.test(t[k])) k++;
        if (t[k] !== '\n') return null;
        pos = k + 1;
      }
      body = '';
    } else {
      pos = findLine(t, c, line);
      body = line;
      if (pos < 0 && line.endsWith('-')) {
        body = line.slice(0, -1);
        pos = findLine(t, c, body);
        hyphen = true;
      }
      if (pos < 0) return null;
    }
    at.push({ pos, len: body.length, hyphen });
    c = pos + body.length;
  }
  if (c > t.length) return null;
  // The whitespace between two lines: up to and including its last newline is
  // the tail of the line before, the rest the head of the line after. With no
  // newline in it, it is the space a line wrapped at: all tail.
  const out = at.map((a) => ({ start: a.pos, head: '', body: raw.slice(a.pos, a.pos + a.len), hyphen: a.hyphen, tail: '' }));
  out[0].start = 0;
  out[0].head = raw.slice(0, at[0].pos);
  for (let i = 0; i < at.length; i++) {
    const end = at[i].pos + at[i].len;
    const next = i + 1 < at.length ? at[i + 1].pos : raw.length;
    const gap = raw.slice(end, next);
    if (i + 1 === at.length) {
      out[i].tail = gap;
      break;
    }
    const nl = gap.includes('\n') ? gap.lastIndexOf('\n') + 1 : gap.length;
    out[i].tail = gap.slice(0, nl);
    out[i + 1].head = gap.slice(nl);
    out[i + 1].start = end + nl;
  }
  return out;
}

// Where `line` starts at or after `c` with nothing but whitespace before it, or
// -1. The nearest such place, so a line that keeps its paragraph's leading
// spaces keeps all of them.
function findLine(t, c, line) {
  for (let k = c; k <= t.length - line.length; k++) {
    if (t.startsWith(line, k)) return k;
    if (!WS.test(t[k])) return -1;
  }
  return -1;
}

// ----- the editable -----
//
// One `div.el` per line, in `white-space: pre` so the browser cannot break a
// line again. A line's head and tail are in the text - the caret has to be able
// to stand in them, and `textContent` has to be the raw text - but they must not
// take room on the line, or a centred line would sit half a space away from
// where the result puts it: each is a span pulled back by its own width
// (`width(str)`, in the px the editable is drawn in). Only the part on the
// line's own row: the Returns in them stay text, so a Return typed at the very
// start or end of the block makes its line while it is being typed, as it does
// in any text field, even though the result trims it. With no `segs` it is the
// raw text in one element the browser wraps, which is what the editable was.
export function drawEditLines(node, text, segs, width) {
  const doc = node.ownerDocument;
  const put = (el, str) => str && el.append(str);
  const hang = (el, str, side) => {
    if (!str) return;
    const sp = doc.createElement('span');
    sp.textContent = str;
    sp.style[side] = `${-width(str)}px`;
    el.append(sp);
  };
  const out = (segs ?? [null]).map((g) => {
    const el = doc.createElement('div');
    el.className = g ? 'el' : 'el wrap';
    if (!g) {
      put(el, text);
      return el;
    }
    const h = g.head.lastIndexOf('\n') + 1;
    put(el, g.head.slice(0, h));
    hang(el, g.head.slice(h), 'marginLeft');
    put(el, g.body);
    if (g.hyphen) el.append(Object.assign(doc.createElement('span'), { className: 'ehy' }));
    const t = g.tail.indexOf('\n');
    hang(el, t < 0 ? g.tail : g.tail.slice(0, t), 'marginRight');
    put(el, t < 0 ? '' : g.tail.slice(t));
    return el;
  });
  // A Return at the very end of the text opens a line nothing is on yet, and
  // an empty box has no line at all: the `<br>` is the line the caret stands on.
  const last = out[out.length - 1];
  if (!last.textContent || last.textContent.endsWith('\n')) last.append(doc.createElement('br'));
  node.replaceChildren(...out);
}

// The raw offset of a DOM position in the editable, or null when it is not in
// it. `<br>`s and the drawn hyphens are not text, so they count for nothing.
export function rawOffset(node, container, offset) {
  if (!container || !node.contains(container)) return null;
  const r = node.ownerDocument.createRange();
  r.setStart(node, 0);
  r.setEnd(container, offset);
  return r.toString().length;
}

// The DOM position of a raw offset, as [container, offset]: in the text node
// that holds it, the later one where two meet - so a caret at a line break
// stands at the start of the next line - and in front of the `<br>` when it is
// right after the Return that opened that `<br>`'s line.
export function domPoint(node, o) {
  const walk = node.ownerDocument.createTreeWalker(node, 4 /* NodeFilter.SHOW_TEXT */);
  let at = 0;
  let hit = null;
  for (let t = walk.nextNode(); t && at <= o; t = walk.nextNode()) {
    const end = at + t.data.length;
    if (o <= end) hit = [t, o - at];
    at = end;
  }
  if (!hit) return [node.firstChild ?? node, 0];
  const [t, i] = hit;
  const br = t.nextSibling;
  if (i === t.data.length && t.data.endsWith('\n') && br?.nodeName === 'BR')
    return [br.parentNode, Array.prototype.indexOf.call(br.parentNode.childNodes, br)];
  return hit;
}

// The offset one user-perceived character before (`dir` -1) or after (+1) `o`
// in `v`, for a Backspace or a Delete the browser could not place: an emoji or
// an accented letter goes whole.
const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export function stepChar(v, o, dir) {
  if (!graphemes) return Math.max(0, Math.min(v.length, o + dir));
  let prev = 0;
  for (const { index } of graphemes.segment(v)) {
    if (dir > 0 && index > o) return index;
    if (dir < 0 && index >= o) return prev;
    prev = index;
  }
  return dir > 0 ? v.length : prev;
}
