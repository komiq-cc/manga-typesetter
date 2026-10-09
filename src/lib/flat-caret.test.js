import { describe, expect, it } from 'vitest';
import { editLines } from './edit-lines.js';
import { buildRows, rowOf, caretAt, selectionRects, offsetAt, wordAround, wordPress, linePress, rowSpan, moveCaret, lineDeleteSpan, caseMap, mapRows, rawAtDrawn } from './flat-caret.js';

// ===========================================================================
// The caret on straight text that is a picture: arithmetic on rows
// ===========================================================================
// No engine and no DOM. The lines are laid over the raw text by the real
// `editLines`; the geometry is a stand-in every number of which can be read
// off the test: each character 10 wide, each line 20 high, a line starting at
// the x given for it (0 unless said). So a caret before character `k` of a
// line is at `x0 + 10 k`.

const W = 10;
const H = 20;
const SPACE = 4;
// `lines` as `layoutLines` gives them; `x0[i]` where line i starts.
function rowsFor(text, lines, { x0 = [], clusters = null, bounds = null, cased = text } = {}) {
  const segs = editLines(cased, cased, lines);
  expect(segs, 'the lines lay over the text').not.toBeNull();
  const geom = lines.map((ln, i) => {
    const s = x0[i] ?? 0;
    const at = clusters?.[i] ?? [...ln].map((_, k) => k);
    return { top: 100 + i * H, height: H, anchor: s, at, x: at.map((k) => s + k * W), end: s + ln.length * W };
  });
  return buildRows(cased, segs, geom, { space: SPACE, bounds });
}
const stops = (r) => r.offs.map((o, k) => [o, r.xs[k]]);

describe('a caret at every raw offset', () => {
  it('one line: the stop before character k is at the line start plus its pen', () => {
    const rows = rowsFor('HELLO', ['HELLO'], { x0: [7] });
    expect(rows).toHaveLength(1);
    expect(stops(rows[0])).toEqual([[0, 7], [1, 17], [2, 27], [3, 37], [4, 47], [5, 57]]);
    for (let o = 0; o <= 5; o++) expect(caretAt(rows, o)).toEqual({ x: 7 + o * W, top: 100, height: H, row: 0 });
  });

  it('an empty box: one row, one stop, at the anchor', () => {
    const rows = rowsFor('', [''], { x0: [55] });
    expect(rows).toHaveLength(1);
    expect(stops(rows[0])).toEqual([[0, 55]]);
    expect(caretAt(rows, 0)).toEqual({ x: 55, top: 100, height: H, row: 0 });
    // An offset past the text still has somewhere to stand.
    expect(caretAt(rows, 9).x).toBe(55);
  });

  it('an empty line between two paragraphs has its own row, at its anchor', () => {
    const rows = rowsFor('AB\n\nCD', ['AB', '', 'CD'], { x0: [0, 33, 0] });
    expect(rows.map((r) => [r.offs[0], r.offs.at(-1), r.hard])).toEqual([[0, 2, true], [3, 3, true], [4, 6, false]]);
    expect(caretAt(rows, 3)).toEqual({ x: 33, top: 120, height: H, row: 1 });
  });

  it('a Return is a hard break: before it the upper row, after it the lower, whatever the affinity', () => {
    const rows = rowsFor('AB\nCD', ['AB', 'CD']);
    expect(rowOf(rows, 2)).toBe(0);
    expect(rowOf(rows, 2, true)).toBe(0);
    expect(rowOf(rows, 3)).toBe(1);
    expect(rowOf(rows, 3, true)).toBe(1);
    expect(caretAt(rows, 2).x).toBe(20);
    expect(caretAt(rows, 3).x).toBe(0);
  });
});

describe('whitespace the layout does not draw hangs off the line', () => {
  it('the space a line wrapped at: after it is the lower row, or with upstream affinity the upper, one space out', () => {
    // "HELLO WORLD" broken at the space: offsets 0..5 on row 0, the space is
    // hidden, 6 is both "after the space" and "before W".
    const rows = rowsFor('HELLO WORLD', ['HELLO', 'WORLD']);
    expect(rows[0].soft).toBe(true);
    expect(stops(rows[0])).toEqual([[0, 0], [1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 50 + SPACE]]);
    expect(stops(rows[1])).toEqual([[6, 0], [7, 10], [8, 20], [9, 30], [10, 40], [11, 50]]);
    expect(caretAt(rows, 5)).toMatchObject({ x: 50, row: 0 });
    expect(caretAt(rows, 6)).toMatchObject({ x: 0, row: 1 });
    expect(caretAt(rows, 6, true)).toMatchObject({ x: 50 + SPACE, row: 0 });
  });

  it('two spaces at a wrap: the first is on the upper row only', () => {
    const rows = rowsFor('AB  CD', ['AB', 'CD']);
    expect(stops(rows[0])).toEqual([[0, 0], [1, 10], [2, 20], [3, 20 + SPACE], [4, 20 + 2 * SPACE]]);
    expect(caretAt(rows, 3)).toMatchObject({ x: 20 + SPACE, row: 0 });
    expect(caretAt(rows, 4)).toMatchObject({ x: 0, row: 1 });
  });

  it('spaces typed at the end of the last line move the caret', () => {
    const rows = rowsFor('AB  ', ['AB']);
    expect(stops(rows[0])).toEqual([[0, 0], [1, 10], [2, 20], [3, 20 + SPACE], [4, 20 + 2 * SPACE]]);
  });

  it('a line of only spaces: they hang from the anchor', () => {
    const rows = rowsFor('A\n  \nB', ['A', '', 'B'], { x0: [0, 40, 0] });
    expect(stops(rows[1])).toEqual([[2, 40], [3, 40 + SPACE], [4, 40 + 2 * SPACE]]);
    expect(rows[1].hard).toBe(true);
    expect(rowOf(rows, 5)).toBe(2);
  });

  it('leading spaces a paragraph lost hang to the left of its first pen', () => {
    // The breaker dropped the two spaces that open the second paragraph.
    const rows = rowsFor('A\n  B', ['A', 'B'], { x0: [0, 30] });
    expect(stops(rows[1])).toEqual([[2, 30 - 2 * SPACE], [3, 30 - SPACE], [4, 30], [5, 40]]);
  });

  it('a break with nothing between the lines (after a hyphen that is in the text): one offset, two rows', () => {
    const rows = rowsFor('WELL-KNOWN', ['WELL-', 'KNOWN']);
    expect(rows[0].soft).toBe(true);
    expect(rows[0].offs.at(-1)).toBe(5);
    expect(rows[1].offs[0]).toBe(5);
    expect(caretAt(rows, 5)).toMatchObject({ x: 0, row: 1 });
    expect(caretAt(rows, 5, true)).toMatchObject({ x: 50, row: 0 });
  });

  it('an invented hyphen is not a character: the row ends at the pen before it', () => {
    // "HYPHENATION" broken as "HYPHEN-" / "ATION": the hyphen is the line's
    // seventh cluster and no offset of the text.
    const rows = rowsFor('HYPHENATION', ['HYPHEN-', 'ATION']);
    expect(stops(rows[0])).toEqual([[0, 0], [1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60]]);
    expect(stops(rows[1])[0]).toEqual([6, 0]);
  });
});

describe('the Returns the layout trims have rows of their own, outside the block', () => {
  it('trailing Returns: one row a line height below for each, at the anchor', () => {
    const rows = rowsFor('AB\n\n', ['AB'], { x0: [12] });
    expect(rows.map((r) => [r.line, r.top, r.offs, r.xs])).toEqual([
      [0, 100, [0, 1, 2], [12, 22, 32]],
      [-1, 120, [3], [12]],
      [-1, 140, [4], [12]],
    ]);
    expect(caretAt(rows, 3)).toEqual({ x: 12, top: 120, height: H, row: 1 });
    expect(caretAt(rows, 4)).toEqual({ x: 12, top: 140, height: H, row: 2 });
  });

  it('leading Returns: one row a line height above for each', () => {
    const rows = rowsFor('\n\nAB', ['AB'], { x0: [12] });
    expect(rows.map((r) => [r.line, r.top, r.offs])).toEqual([
      [-1, 60, [0]],
      [-1, 80, [1]],
      [0, 100, [2, 3, 4]],
    ]);
    expect(rowOf(rows, 1)).toBe(1);
    expect(rowOf(rows, 2)).toBe(2);
  });

  it('a text of Returns only: the one drawn line, then a row for each', () => {
    const rows = rowsFor('\n\n', ['']);
    expect(rows.map((r) => [r.line, r.top, r.offs])).toEqual([[0, 100, [0]], [-1, 120, [1]], [-1, 140, [2]]]);
  });
});

describe('clusters and graphemes', () => {
  it('a ligature is one cluster: the stops inside it divide its advance evenly', () => {
    // "office" with "ffi" one glyph 30 wide at pen 10: clusters at 0, 1, 4, 5.
    const rows = rowsFor('office', ['office'], { clusters: [[0, 1, 4, 5]] });
    expect(stops(rows[0])).toEqual([[0, 0], [1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60]]);
    // And with a cluster that is not as wide as its letters would be alone:
    const segs = editLines('fi!', 'fi!', ['fi!']);
    const tight = buildRows('fi!', segs, [{ top: 0, height: H, anchor: 0, at: [0, 2], x: [0, 13], end: 20 }]);
    expect(stops(tight[0])).toEqual([[0, 0], [1, 6.5], [2, 13], [3, 20]]);
  });

  it('a base and its combining mark are one stop apart from the next: none stands between them', () => {
    // "e" + U+0301, then "x". The engine gives one cluster for the pair.
    const text = 'éx';
    const bounds = (o) => o !== 1;
    const rows = rowsFor(text, [text], { clusters: [[0, 2]], bounds });
    expect(stops(rows[0])).toEqual([[0, 0], [2, 20], [3, 30]]);
    // An offset inside the pair shows at the stop before it.
    expect(caretAt(rows, 1).x).toBe(0);
  });

  it('an emoji is two code units and one stop', () => {
    const text = 'a\u{1F600}b';
    const bounds = (o) => o !== 2;
    const rows = rowsFor(text, [text], { clusters: [[0, 1, 3]], bounds });
    expect(rows[0].offs).toEqual([0, 1, 3, 4]);
  });
});

describe('a point on the rows', () => {
  const rows = rowsFor('HELLO WORLD\nAB', ['HELLO', 'WORLD', 'AB'], { x0: [0, 0, 20] });

  it('the left half of a glyph is the offset before it, the right half the offset after', () => {
    for (let k = 0; k < 5; k++) {
      expect(offsetAt(rows, k * W + 2.5, 110).o).toBe(k);
      expect(offsetAt(rows, k * W + 7.5, 110).o).toBe(k + 1);
      expect(offsetAt(rows, k * W + 2.5, 130).o).toBe(6 + k);
      expect(offsetAt(rows, k * W + 7.5, 130).o).toBe(7 + k);
    }
  });

  it('past the end of a wrapped row is its last stop, with upstream affinity', () => {
    expect(offsetAt(rows, 500, 110)).toEqual({ o: 6, up: true, row: 0 });
    // And before its start, the first, which needs none.
    expect(offsetAt(rows, -500, 130)).toEqual({ o: 6, up: false, row: 1 });
  });

  it('above the block is the first row and below it the last', () => {
    expect(offsetAt(rows, 12, -1000)).toMatchObject({ o: 1, row: 0 });
    expect(offsetAt(rows, 500, 1000)).toMatchObject({ o: 14, row: 2 });
  });


  it('the span of the row a caret is on', () => {
    expect(rowSpan(rows, 3)).toEqual([0, 6]);
    expect(rowSpan(rows, 6)).toEqual([6, 11]);
    expect(rowSpan(rows, 6, true)).toEqual([0, 6]);
    expect(rowSpan(rows, 13)).toEqual([12, 14]);
  });
});

describe('a selection is one rectangle a row', () => {
  const rows = rowsFor('HELLO WORLD\n\nAB', ['HELLO', 'WORLD', '', 'AB'], { x0: [0, 0, 25, 20] });

  it('inside one row', () => {
    expect(selectionRects(rows, 1, 4)).toEqual([{ x: 10, y: 100, w: 30, h: H }]);
    expect(selectionRects(rows, 4, 1)).toEqual([{ x: 10, y: 100, w: 30, h: H }]);
    expect(selectionRects(rows, 3, 3)).toEqual([]);
  });

  it('across a wrap: the upper row to its hanging space, the lower from its start', () => {
    expect(selectionRects(rows, 3, 8)).toEqual([
      { x: 30, y: 100, w: 20 + SPACE, h: H },
      { x: 0, y: 120, w: 20, h: H },
    ]);
    // Starting exactly at the wrap, nothing of the upper row is in it.
    expect(selectionRects(rows, 6, 8)).toEqual([{ x: 0, y: 120, w: 20, h: H }]);
  });

  it('a row whose Return is selected is wider by the break mark, and an empty selected line shows', () => {
    expect(selectionRects(rows, 9, 14, 6)).toEqual([
      { x: 30, y: 120, w: 20 + 6, h: H },
      { x: 25, y: 140, w: 6, h: H },
      { x: 20, y: 160, w: 10, h: H },
    ]);
    // Without the mark the empty line has no rectangle at all.
    expect(selectionRects(rows, 9, 14)).toHaveLength(2);
  });

  it('everything', () => {
    expect(selectionRects(rows, 0, 15).map((r) => [r.x, r.w])).toEqual([[0, 50 + SPACE], [0, 50], [20, 20]]);
  });
});

describe('caret keys follow the rows', () => {
  // Rows of unequal length: "HELLO THERE" / "MY" / "DEAR FRIENDS", the last
  // after a Return.
  const text = 'HELLO THERE MY\nDEAR FRIENDS';
  const rows = rowsFor(text, ['HELLO THERE', 'MY', 'DEAR FRIENDS']);
  const at = (f, up = false, a = f) => ({ a, f, up });
  const key = (sel, k, mods, goal) => moveCaret(rows, text, sel, k, mods, goal);

  it('Down and Up keep the column they set out from across a short row', () => {
    // From after "HELLO THE" (x 90): the short row has nothing there, so its
    // end; then on to x 90 of the long one, not to x 20.
    const d1 = key(at(9), 'ArrowDown');
    expect(d1).toEqual({ a: 14, f: 14, up: false, goal: 90 });
    const d2 = key(d1, 'ArrowDown', {}, d1.goal);
    expect(d2).toEqual({ a: 24, f: 24, up: false, goal: 90 });
    const u1 = key(d2, 'ArrowUp', {}, d2.goal);
    expect(u1).toMatchObject({ f: 14, goal: 90 });
    const u2 = key(u1, 'ArrowUp', {}, u1.goal);
    expect(u2).toMatchObject({ f: 9, goal: 90 });
  });

  it('with no column remembered, the caret`s own x is the column', () => {
    expect(key(at(13), 'ArrowDown')).toMatchObject({ f: 16, goal: 10 });
  });

  it('Up on the first row goes to the start of the text, Down on the last to its end', () => {
    expect(key(at(4), 'ArrowUp')).toMatchObject({ a: 0, f: 0 });
    expect(key(at(20), 'ArrowDown')).toMatchObject({ a: text.length, f: text.length });
  });

  it('Up landing on the end of a wrapped row stays on that row', () => {
    // From the end of "MY" (x 20, row 1) there is no wrap above at x 20; from
    // far right of the last row, up twice lands on the end of row 0.
    const u1 = key(at(27), 'ArrowUp');
    expect(u1).toMatchObject({ f: 14, up: false, goal: 120 });
    const u2 = key(u1, 'ArrowUp', {}, u1.goal);
    expect(u2).toMatchObject({ f: 12, up: true });
    expect(caretAt(rows, u2.f, u2.up)).toMatchObject({ row: 0, x: 110 + SPACE });
  });

  it('Home and End are the row`s ends; End on a wrapped row is upstream', () => {
    expect(key(at(3), 'Home')).toEqual({ a: 0, f: 0, up: false, goal: null });
    expect(key(at(3), 'End')).toEqual({ a: 12, f: 12, up: true, goal: null });
    // At the shared offset: downstream it is the lower row's, upstream the upper's.
    expect(key(at(12), 'End')).toMatchObject({ f: 14, up: false });
    expect(key(at(12, true), 'Home')).toMatchObject({ f: 0 });
    expect(key(at(12), 'Home')).toMatchObject({ f: 12 });
    expect(key(at(20), 'End')).toMatchObject({ f: text.length, up: false });
  });

  it('Cmd+Left and Cmd+Right are Home and End; Cmd+Up and Cmd+Down the ends of the text', () => {
    expect(key(at(3), 'ArrowLeft', { mod: true })).toMatchObject({ f: 0 });
    expect(key(at(3), 'ArrowRight', { mod: true })).toMatchObject({ f: 12, up: true });
    expect(key(at(20), 'ArrowUp', { mod: true })).toMatchObject({ f: 0 });
    expect(key(at(3), 'ArrowDown', { mod: true })).toMatchObject({ f: text.length });
    expect(key(at(3), 'PageDown')).toMatchObject({ f: text.length });
    expect(key(at(3), 'PageUp')).toMatchObject({ f: 0 });
  });

  it('Shift keeps the anchor in every one of them', () => {
    expect(key(at(9), 'ArrowDown', { shift: true })).toMatchObject({ a: 9, f: 14 });
    expect(key(at(3), 'End', { shift: true })).toMatchObject({ a: 3, f: 12, up: true });
    expect(key(at(3), 'Home', { shift: true })).toMatchObject({ a: 3, f: 0 });
    expect(key(at(20), 'ArrowUp', { shift: true, mod: true })).toMatchObject({ a: 20, f: 0 });
    expect(key(at(3), 'ArrowRight', { shift: true })).toMatchObject({ a: 3, f: 4 });
    expect(key(at(4, false, 3), 'ArrowLeft', { shift: true })).toMatchObject({ a: 3, f: 3 });
  });

  it('Left and Right step a grapheme, and collapse a selection to its near end', () => {
    expect(key(at(3), 'ArrowRight')).toEqual({ a: 4, f: 4, up: false, goal: null });
    expect(key(at(3), 'ArrowLeft')).toEqual({ a: 2, f: 2, up: false, goal: null });
    expect(key(at(0), 'ArrowLeft')).toMatchObject({ f: 0 });
    expect(key(at(text.length), 'ArrowRight')).toMatchObject({ f: text.length });
    expect(key(at(8, false, 3), 'ArrowLeft')).toMatchObject({ a: 3, f: 3 });
    expect(key(at(3, false, 8), 'ArrowRight')).toMatchObject({ a: 8, f: 8 });
    // Over the hidden space of the wrap and on to the lower row.
    expect(key(at(11), 'ArrowRight')).toMatchObject({ f: 12, up: false });
    expect(moveCaret([], 'a\u{1F600}b', at(1), 'ArrowRight')).toMatchObject({ f: 3 });
  });

  it('any other key is not ours', () => {
    expect(key(at(3), 'a')).toBeNull();
    expect(key(at(3), 'Enter')).toBeNull();
    expect(key(at(3), 'a', { mod: true })).toBeNull();
  });
});

describe('line deletes are cut from our rows', () => {
  const text = 'HELLO THERE MY\nDEAR FRIENDS';
  const rows = rowsFor(text, ['HELLO THERE', 'MY', 'DEAR FRIENDS']);

  it('the soft-line deletes take the row, not the paragraph', () => {
    expect(lineDeleteSpan(rows, text, 13, false, 'deleteSoftLineBackward')).toEqual([12, 13]);
    expect(lineDeleteSpan(rows, text, 13, false, 'deleteSoftLineForward')).toEqual([13, 14]);
    expect(lineDeleteSpan(rows, text, 4, false, 'deleteSoftLineForward')).toEqual([4, 12]);
    // At the shared offset the affinity says which row.
    expect(lineDeleteSpan(rows, text, 12, true, 'deleteSoftLineBackward')).toEqual([0, 12]);
    expect(lineDeleteSpan(rows, text, 12, false, 'deleteSoftLineBackward')).toEqual([12, 12]);
  });

  it('the hard-line deletes take the paragraph', () => {
    expect(lineDeleteSpan(rows, text, 13, false, 'deleteHardLineBackward')).toEqual([0, 13]);
    expect(lineDeleteSpan(rows, text, 4, false, 'deleteHardLineForward')).toEqual([4, 14]);
    expect(lineDeleteSpan(rows, text, 20, false, 'deleteHardLineBackward')).toEqual([15, 20]);
    expect(lineDeleteSpan(rows, text, 20, false, 'deleteHardLineForward')).toEqual([20, text.length]);
  });

  it('any other input is left to the browser`s own range', () => {
    expect(lineDeleteSpan(rows, text, 4, false, 'deleteWordBackward')).toBeNull();
    expect(lineDeleteSpan(rows, text, 4, false, 'insertText')).toBeNull();
  });
});

describe('casing that changes the length', () => {
  it('one for one needs no map', () => {
    expect(caseMap('Hello', 'HELLO')).toBeNull();
    expect(caseMap('', '')).toBeNull();
  });

  it('the cased offset of every raw offset', () => {
    const m = caseMap('Straße 1', 'STRASSE 1');
    expect(m.toDrawn).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9]);
    expect(rawAtDrawn(m, 4)).toBe(4);
    // Between the two S there is no raw offset: the one after.
    expect(rawAtDrawn(m, 5)).toBe(5);
    expect(rawAtDrawn(m, 6)).toBe(5);
    expect(rawAtDrawn(m, 9)).toBe(8);
  });

  it('a cased text that is not the letters cased one by one has no map', () => {
    expect(caseMap('ß', 'XYZ')).toBe(false);
    expect(caseMap('aß', 'ASSS')).toBe(false);
  });

  it('rows made in cased offsets, in raw ones: no stop between the two S', () => {
    const raw = 'Straße';
    const cased = raw.toUpperCase();
    const m = caseMap(raw, cased);
    const rows = mapRows(rowsFor(raw, [cased], { cased }), m);
    expect(stops(rows[0])).toEqual([[0, 0], [1, 10], [2, 20], [3, 30], [4, 40], [5, 60], [6, 70]]);
    expect(offsetAt(rows, 52, 110).o).toBe(5);
    expect(offsetAt(rows, 48, 110).o).toBe(4);
  });

  it('a wrap is still shared after the mapping', () => {
    const raw = 'Maße groß';
    const cased = raw.toUpperCase();
    const rows = mapRows(rowsFor(raw, ['MASSE', 'GROSS'], { cased }), caseMap(raw, cased));
    expect(rows[0].offs).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows[1].offs).toEqual([5, 6, 7, 8, 9]);
    expect(rows[1].xs).toEqual([0, 10, 20, 30, 50]);
    expect(rowOf(rows, 5)).toBe(1);
    expect(rowOf(rows, 5, true)).toBe(0);
  });

  it('with no map the rows are themselves', () => {
    const rows = rowsFor('AB', ['AB']);
    expect(mapRows(rows, null)).toBe(rows);
  });
});

describe('two presses select a word and three a row, as the browser does in the editable', () => {
  // "HELLO WORLD!" wrapped after HELLO, a Return, then "AB".
  const text = 'HELLO WORLD!\nAB';
  const rows = rowsFor(text, ['HELLO', 'WORLD!', 'AB']);

  it('the run of the text that holds an offset: a word, the spaces, a mark, a Return', () => {
    expect(wordAround(text, 0)).toEqual([0, 5]);
    expect(wordAround(text, 4)).toEqual([0, 5]);
    expect(wordAround(text, 5)).toEqual([5, 6]);
    expect(wordAround(text, 6)).toEqual([6, 11]);
    expect(wordAround(text, 11)).toEqual([11, 12]);
    expect(wordAround(text, 12)).toEqual([12, 13]);
    // At the end of the text, the last run.
    expect(wordAround(text, 15)).toEqual([13, 15]);
    expect(wordAround('', 0)).toEqual([0, 0]);
    // An apostrophe is in its word and a hyphen is not, as the browser has it.
    expect(wordAround("don't over-do", 2)).toEqual([0, 5]);
    expect(wordAround("don't over-do", 7)).toEqual([6, 10]);
    expect(wordAround('two  spaces', 3)).toEqual([3, 5]);
  });

  it('two presses: the run that starts at or holds the offset one press goes to', () => {
    // The left half of the second L: the caret before it, in HELLO.
    expect(wordPress(rows, text, 32, 110)).toEqual({ a: 0, f: 5, up: false });
    // The right half of the O: the caret after the word, which is where the space starts.
    expect(wordPress(rows, text, 48, 110)).toEqual({ a: 5, f: 6, up: false });
    // The left half of the W on the row below: the same offset, the word it starts.
    expect(wordPress(rows, text, 2, 130)).toEqual({ a: 6, f: 11, up: false });
    // The mark, and past the end of that row, the Return.
    expect(wordPress(rows, text, 52, 130)).toEqual({ a: 11, f: 12, up: false });
    expect(wordPress(rows, text, 300, 130)).toEqual({ a: 12, f: 13, up: false });
    // At the end of the text: the last word.
    expect(wordPress(rows, text, 300, 150)).toEqual({ a: 13, f: 15, up: false });
  });

  it('two presses past the end of a row that wrapped select nothing: the caret, on that row', () => {
    expect(wordPress(rows, text, 300, 110)).toEqual({ a: 6, f: 6, up: true });
  });

  it('three presses: the row, with the space it wrapped at, or with its Return', () => {
    expect(linePress(rows, text, 20, 110)).toEqual({ a: 0, f: 6, up: true });
    expect(linePress(rows, text, 20, 130)).toEqual({ a: 6, f: 13, up: false });
    // The last row ends at the text's end and has no Return to take.
    expect(linePress(rows, text, 0, 150)).toEqual({ a: 13, f: 15, up: false });
    expect(linePress([], text, 0, 0)).toEqual({ a: 0, f: 0, up: false });
  });

  it('three presses on an empty line select its Return', () => {
    const t = 'A\n\nB';
    const r = rowsFor(t, ['A', '', 'B']);
    expect(linePress(r, t, 0, 130)).toEqual({ a: 2, f: 3, up: false });
  });
});
