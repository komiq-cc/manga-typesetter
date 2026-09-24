import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { editLines, stepChar } from './edit-lines.js';
import { layoutLines, applyCase, contentWidth, setTypesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';

// What the editable draws for a line: the body as CSS shows it (uppercased when
// the style says so), and the hyphen it adds.
const shown = (seg, s) => applyCase(seg.body, s).replace(/\t/g, ' ') + (seg.hyphen ? '-' : '');
const joined = (segs) => segs.map((g) => g.head + g.body + g.tail).join('');
const map = (text, lines) => editLines(text, text, lines);

describe('editLines: the lines as slices of the raw text', () => {
  it('puts the space a line wrapped at in its tail', () => {
    const segs = map('hello big world', ['hello big', 'world']);
    expect(segs.map((g) => [g.head, g.body, g.tail, g.start])).toEqual([
      ['', 'hello big', ' ', 0],
      ['', 'world', '', 10],
    ]);
  });

  it('ends a paragraph with its newline, and gives a blank paragraph a line of its own', () => {
    const text = 'one\n\n  \ntwo';
    const segs = map(text, ['one', '', '', 'two']);
    expect(segs.map((g) => [g.body, g.tail])).toEqual([
      ['one', '\n'],
      ['', '\n'],
      ['', '  \n'],
      ['two', ''],
    ]);
    expect(joined(segs)).toBe(text);
  });

  it("keeps a paragraph's leading spaces as its head when the breaker dropped them", () => {
    const segs = map('hi\n   there', ['hi', 'there']);
    expect(segs[1]).toEqual({ start: 3, head: '   ', body: 'there', hyphen: false, tail: '' });
  });

  it('keeps them as body when the line kept them', () => {
    expect(map('hi\n   there', ['hi', '   there'])[1].body).toBe('   there');
  });

  it('holds the Returns the block trimmed at either end', () => {
    const segs = map('\n\nhello\n\n', ['hello']);
    expect(segs).toEqual([{ start: 0, head: '\n\n', body: 'hello', hyphen: false, tail: '\n\n' }]);
  });

  it('draws an invented hyphen and keeps a typed one as text', () => {
    expect(map('extraordinary', ['extraor-', 'dinary']).map((g) => [g.body, g.hyphen])).toEqual([
      ['extraor', true],
      ['dinary', false],
    ]);
    expect(map('co-op', ['co-', 'op']).map((g) => [g.body, g.hyphen])).toEqual([
      ['co-', false],
      ['op', false],
    ]);
  });

  it('slices the raw text when the lines were broken from its uppercase', () => {
    const segs = editLines('Hey you', 'HEY YOU', ['HEY', 'YOU']);
    expect(segs.map((g) => g.body)).toEqual(['Hey', 'you']);
  });

  it('gives an empty or blank box one empty line', () => {
    expect(map('', [''])).toEqual([{ start: 0, head: '', body: '', hyphen: false, tail: '' }]);
    expect(map(' \n ', [''])).toEqual([{ start: 0, head: '', body: '', hyphen: false, tail: ' \n ' }]);
  });

  it('gives up rather than guess', () => {
    // An uppercase that changes the length: "ß" is "SS".
    expect(editLines('groß', 'GROSS', ['GROSS'])).toBeNull();
    // Lines that are not the text's.
    expect(map('hello', ['world'])).toBeNull();
    expect(map('a b', ['a', 'c'])).toBeNull();
  });
});

describe('stepChar: a Backspace or Delete the browser could not place', () => {
  it('steps one user-perceived character, and not past either end', () => {
    const v = 'a\u00e9\u{1F44D}\u{1F3FD}\nb';
    // a, é, a thumbs-up with its skin tone (four code units), the Return, b.
    expect(stepChar(v, 7, -1)).toBe(6);
    expect(stepChar(v, 6, -1)).toBe(2);
    expect(stepChar(v, 2, 1)).toBe(6);
    expect(stepChar(v, 0, -1)).toBe(0);
    expect(stepChar(v, v.length, 1)).toBe(v.length);
  });
});

// The doc's test (06-editor-ux-and-commands.md, UX-4): while editing, the
// rendered line breaks equal `layoutLines(...)` for the same text and box. The
// editable renders one element per `editLines` entry, drawing `shown(seg)`; so
// for every text, the drawn lines are exactly the lines `layoutLines` gives the
// display and the export, and the raw text is all there, in order, to edit.
describe('while editing, the lines are layoutLines (UX-4)', () => {
  beforeAll(() => {
    setTypesetEnabled(true);
    clearLayoutMemo();
  });
  afterAll(() => {
    setTypesetEnabled(false);
    clearLayoutMemo();
  });

  const texts = [
    'I never thought I would see the day when the whole village turned out for this',
    'Wait.\n\nYou mean   the one with   the   red door?',
    '  Leading spaces, then a paragraph\n  that also starts with some.',
    'Extraordinarily incomprehensible circumstances notwithstanding',
    'Tabs\tbetween\twords\tbehave like spaces',
    'A trailing Return\n',
    '\nand a leading one',
    'KRRSSHHHHHHHHHHHHHHHHH!!',
    'mother-in-law and the co-op',
    '',
  ];
  const widths = [60, 110, 180];

  for (const uppercase of [false, true]) {
    for (const w of widths) {
      it(`at ${w}px${uppercase ? ', uppercase' : ''}`, () => {
        const s = normalizeStyle({ ...defaultStyle(), size: 16, uppercase });
        for (const text of texts) {
          const cased = applyCase(text, s);
          const lines = layoutLines(cased, s, s.size, contentWidth(w, s));
          const segs = editLines(text, cased, lines);
          expect(segs, text).not.toBeNull();
          expect(segs.map((g) => shown(g, s))).toEqual(lines);
          expect(joined(segs)).toBe(text);
        }
      });
    }
  }
});
