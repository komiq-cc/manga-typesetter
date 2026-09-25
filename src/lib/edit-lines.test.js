import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { editLines, drawEditLines, domPoint, stepChar } from './edit-lines.js';
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

// Just enough of a DOM to draw the editable into: elements, text nodes, and a
// text walker, which is all `drawEditLines` and `domPoint` touch.
function fakeDoc() {
  const link = (parent, kids) => {
    kids.forEach((k, i) => {
      k.parentNode = parent;
      k.nextSibling = kids[i + 1] ?? null;
    });
  };
  const text = (data) => ({ nodeType: 3, nodeName: '#text', data, parentNode: null, nextSibling: null });
  const doc = {
    createElement(tag) {
      const el = {
        nodeType: 1,
        nodeName: tag.toUpperCase(),
        className: '',
        style: {},
        childNodes: [],
        ownerDocument: doc,
        get firstChild() {
          return this.childNodes[0] ?? null;
        },
        append(...xs) {
          this.childNodes.push(...xs.map((x) => (typeof x === 'string' ? text(x) : x)));
          link(this, this.childNodes);
        },
        replaceChildren(...xs) {
          this.childNodes = [];
          this.append(...xs);
        },
        get textContent() {
          return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join('');
        },
        set textContent(v) {
          this.replaceChildren(v);
        },
      };
      return el;
    },
    createTreeWalker(root) {
      const out = [];
      const visit = (n) => n.childNodes.forEach((c) => (c.nodeType === 3 ? out.push(c) : visit(c)));
      visit(root);
      let i = -1;
      return { nextNode: () => out[++i] ?? null };
    },
  };
  return doc;
}

// A Return typed at the very start or end of the block is one the result trims
// (`layoutLines` drops blank lines at either end). While it is being typed it
// must not take room either, or the block moves and jumps back when the edit
// ends: the rows the block lays out are the result's lines, and the trimmed
// Returns hang in `.edge` rows outside it, where the caret can still stand.
describe('the Returns the result trims take no room while typing (UX-4)', () => {
  const draw = (text, lines) => {
    const node = fakeDoc().createElement('div');
    drawEditLines(node, text, map(text, lines), () => 0);
    return node;
  };
  const rows = (node) => node.childNodes.filter((c) => !c.className.includes('edge'));
  const edge = (node, side) => node.childNodes.find((c) => c.className === `el edge ${side}`);

  it('lays out only the result\'s lines, and keeps every character of the text', () => {
    const text = '\n\nhello\nworld\n\n';
    const node = draw(text, ['hello', 'world']);
    expect(node.textContent).toBe(text);
    expect(rows(node).map((r) => r.textContent.replace(/\n/g, ''))).toEqual(['hello', 'world']);
    expect(edge(node, 'start').textContent).toBe('\n\n');
    // The last line keeps the newline that ends it; the rest hangs below.
    expect(edge(node, 'end').textContent).toBe('\n');
  });

  // A flush block in a balloon sets each line in from its aligned edge
  // (`lineIndents`); the editable pads its lines the same, so the text does not
  // move when the edit starts or ends. A line not set in gets no padding.
  it('pads each line on its aligned side by its indent', () => {
    const text = '\nhello big\nworld';
    const node = fakeDoc().createElement('div');
    drawEditLines(node, text, map(text, ['hello big', 'world']), () => 0, { side: 'right', px: [12.5, 0] });
    const [a, b] = rows(node);
    expect(a.style).toEqual({ paddingRight: '12.5px' });
    expect(b.style).toEqual({});
    const left = fakeDoc().createElement('div');
    drawEditLines(left, text, map(text, ['hello big', 'world']), () => 0, { side: 'left', px: [3, 4] });
    expect(rows(left).map((r) => r.style.paddingLeft)).toEqual(['3px', '4px']);
    // The Return trimmed at the start hangs above, unpadded.
    expect(edge(left, 'start').style).toEqual({});
  });

  it('gives a single trailing Return a caret row below the block, and nothing in it', () => {
    const node = draw('hello\n', ['hello']);
    expect(rows(node).map((r) => r.textContent)).toEqual(['hello\n']);
    const end = edge(node, 'end');
    expect(end.childNodes.map((c) => c.nodeName)).toEqual(['BR']);
    // The caret after the Return stands on that row, in front of its <br>.
    expect(domPoint(node, 6)).toEqual([end, 0]);
  });

  it('puts the caret after two trailing Returns on the second row below', () => {
    const node = draw('hello\n\n', ['hello']);
    const end = edge(node, 'end');
    expect(domPoint(node, 7)).toEqual([end, 1]);
    // Between them, at the start of the first row below.
    expect(domPoint(node, 6)).toEqual([end.childNodes[0], 0]);
  });

  it('puts the caret after a leading Return in front of the first line', () => {
    const node = draw('\nhello', ['hello']);
    expect(edge(node, 'start').textContent).toBe('\n');
    const [c, i] = domPoint(node, 1);
    expect([c.data, i]).toEqual(['hello', 0]);
  });

  it('draws no edge when nothing is trimmed, or when the text is all blank', () => {
    expect(draw('one\n\ntwo', ['one', '', 'two']).childNodes).toHaveLength(3);
    // A blank box is one empty line in the result; the Returns in it hang below.
    const node = draw('\n\n', ['']);
    expect(rows(node)).toHaveLength(1);
    expect(edge(node, 'end').textContent).toBe('\n');
    expect(edge(node, 'start')).toBeUndefined();
  });
});
