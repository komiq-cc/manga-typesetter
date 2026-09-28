import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  balanceLines,
  balanceScored,
  balanceCandidates,
  balancedBlockSize,
  neededHeight,
  growToFit,
  BALANCED_DEFAULTS,
  TYPESET_DEFAULTS,
} from './typeset.js';
import {
  layoutLines,
  shapedLines,
  wrapLinesDOM,
  arcLayout,
  wrapLines,
  lineWidth,
  setTypesetEnabled,
  balloonWidthsFor,
  clearLayoutMemo,
  layoutMemoSize,
  BOX_PAD,
} from './measure.js';
import { inscribedRect, safetyInset, interiorLineWidths } from './balloon.js';

// The measurer is injected precisely so this file can use one: a character is
// one unit wide, so every expectation below can be read off the strings without
// a canvas, a font, or a browser anywhere in it. The real one lives in
// `measure.js` and is wired in at the call sites.
const chars = (s) => s.length;
// A metric where a capital letter is wider than a lowercase one, for the cases
// that would otherwise pass by accident under a uniform width.
const weighted = (s) => [...s].reduce((a, c) => a + (c === ' ' ? 0.5 : /[A-Z]/.test(c) ? 1.4 : 1), 0);

const widths = (lines) => lines.map((l) => l.length);
// The shape test, stated once, the way the module states it: the deepest notch,
// an interior line short of something above it AND something below it. A square
// and an oval have none, and neither does the ordinary block whose last line
// runs short.
const dip = (lines, w) => {
  const r = lines.map((l) => l.length / w);
  let deepest = 0;
  for (let i = 1; i < r.length - 1; i++) {
    deepest = Math.max(deepest, Math.min(Math.max(...r.slice(0, i)), Math.max(...r.slice(i + 1))) - r[i]);
  }
  return deepest;
};

describe('balanceLines - the block reads as a square or an oval', () => {
  it('balances instead of filling greedily', () => {
    // Greedy would give "THE WORLD IS ENDING" (18, brim-full) and then trail
    // off. Every line here is within a few units of every other, which is the
    // square [] the rule asks for.
    const lines = balanceLines('THE WORLD IS ENDING AND NOBODY CARES AT ALL', 18, chars);
    expect(lines).toEqual(['THE WORLD IS', 'ENDING AND NOBODY', 'CARES AT ALL']);
    const w = widths(lines);
    expect(Math.max(...w) - Math.min(...w)).toBeLessThanOrEqual(5);
  });

  it('never leaves a line wider than the box it was measured against', () => {
    const lines = balanceLines('YOU ARE GOING TO REGRET THIS FOR THE REST OF YOUR LIFE', 24, chars);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(24);
  });

  it('accepts an oval - narrow, wide, narrow - as a shape', () => {
    // The widest line in the middle is the beehive (), which is explicitly a
    // shape the rule wants, so nothing here may penalise it into oblivion.
    const lines = ['AB', 'ABCDEFGH', 'ABCD'];
    expect(dip(lines, 10)).toBeLessThanOrEqual(0);
  });

  it('rejects the hourglass when a non-pinched breaking of the same text exists', () => {
    // Chosen so that the lowest-variance breaking IS the pinched one: a profile
    // of (12, 7, 7, 10) has a smaller spread than the alternatives, and only the
    // interior-shortfall term moves the short line out of the middle.
    const text = 'DDDDD EEEEEE JJJJJJJ FFF BBB FFF FFF CC';
    const blind = balanceLines(text, 13, chars, { pinch: 0, hourglass: 0 });
    expect(dip(blind, 13)).toBeGreaterThan(0.12);
    const shaped = balanceLines(text, 13, chars);
    expect(dip(shaped, 13)).toBeLessThanOrEqual(0.12);
  });

  it('puts the short line at the end rather than in the middle', () => {
    const lines = balanceLines('AAAA BBBB CC DDDD EEEE FFFF GGGG', 12, chars);
    const w = widths(lines);
    const shortest = Math.min(...w);
    // Whatever the breaking, the narrowest line is an edge, never a pinch.
    expect(w.indexOf(shortest) === 0 || w.lastIndexOf(shortest) === w.length - 1).toBe(true);
  });

  // The two halves of the rule are tested one at a time here, which the case
  // above deliberately does not do: zeroing `pinch` and `hourglass` together
  // cannot tell which of them is doing the work, and the answer used to be that
  // `hourglass` did none. It was a modest weight competing with `lineCost` for
  // the choice of line count, where it could only ever be small; it is now a
  // heavy weight choosing between two breakings of the SAME line count, and a
  // price capped at one line's when line counts are compared.
  it('rejects a pinch with the interior-shortfall term switched off', () => {
    // `pinch: 0`, so nothing inside the dynamic program prefers a short line at
    // the end - and the profile term alone still moves it there.
    const text = 'DDDDD EEEEEE JJJJJJJ FFF BBB FFF FFF CC';
    const blind = balanceLines(text, 13, chars, { pinch: 0, pinchHard: 0, hourglass: 0 });
    expect(dip(blind, 13)).toBeGreaterThan(0.12);
    const shaped = balanceLines(text, 13, chars, { pinch: 0 });
    expect(dip(shaped, 13)).toBeLessThanOrEqual(0.12);
  });

  it('rejects a pinch the interior-shortfall term leaves standing', () => {
    // Measured, not invented: with `hourglass: 0` this is what the block breaks
    // to, and the dip is small enough that the old weight of 6 could never have
    // paid for the repair.
    const text = 'STOP ALWAYS WHY NEVER HELP NEVER A NEVER I NEVER';
    const blind = balanceLines(text, 15, chars, { hourglass: 0 });
    expect(blind).toEqual(['STOP ALWAYS', 'WHY NEVER', 'HELP NEVER A', 'NEVER I NEVER']);
    expect(dip(blind, 15)).toBeGreaterThan(0.12);
    const shaped = balanceLines(text, 15, chars);
    expect(dip(shaped, 15)).toBeLessThanOrEqual(0.12);
    // And the repair is a different breaking at the same count: a better one
    // existed without spending a line.
    expect(shaped).toHaveLength(blind.length);
  });

  it('takes another line when every breaking at the cheapest count is pinched', () => {
    // Twelve units wide, the six words fit on three lines exactly one way, and
    // that way has CCC DDDD sitting short between two fuller lines. Nothing at
    // three lines can repair it, so the repair has to be a line count - and four
    // lines balance to within a line's price of three.
    const text = 'AAAAA BBBB CCC DDDD EEEE FFFFFF';
    const words = text.split(' ');
    const threes = [];
    for (let i = 1; i < words.length; i++) {
      for (let j = i + 1; j < words.length; j++) {
        const lines = [words.slice(0, i), words.slice(i, j), words.slice(j)].map((x) => x.join(' '));
        if (lines.every((l) => l.length <= 12)) threes.push(lines);
      }
    }
    expect(threes).toEqual([['AAAAA BBBB', 'CCC DDDD', 'EEEE FFFFFF']]);
    expect(dip(threes[0], 12)).toBeGreaterThan(TYPESET_DEFAULTS.hourglassTol);

    const [three, four] = balanceCandidates(text, 12, chars);
    expect(three.lines).toEqual(threes[0]);
    expect(three.merit).toBeLessThan(four.merit); // three is the tidier block...
    expect(three.cost).toBeGreaterThan(three.merit); // ...and pays for its profile
    expect(four.cost).toBe(four.merit); // which four does not have
    expect(balanceLines(text, 12, chars)).toEqual(['AAAAA', 'BBBB CCC', 'DDDD EEEE', 'FFFFFF']);
    expect(dip(balanceLines(text, 12, chars), 12)).toBeLessThanOrEqual(TYPESET_DEFAULTS.hourglassTol);
    // With the profile unpriced the count goes back to three.
    expect(balanceLines(text, 12, chars, { hourglass: 0 })).toEqual(threes[0]);
  });

  it('never spends more than one line’s price on the profile', () => {
    // The failure that kept the term out of the choice of line count for so
    // long: priced at its full weight it outbid any number of lines, and a block
    // grew a column of one-word lines to dodge a dip. Capped, the block chosen
    // is never more than `lineCost` worse on everything else than the tidiest
    // count on offer - at the default weight, and at an absurd one.
    const texts = [
      'STOP ALWAYS WHY NEVER HELP NEVER A NEVER I NEVER',
      'THE WORLD IS ENDING AND NOBODY CARES AT ALL',
      'WE HAVE TO GET OUT OF HERE BEFORE IT FINDS US AGAIN',
      'DDDDD EEEEEE JJJJJJJ FFF BBB FFF FFF CC',
      'AAAAA BBBB CCC DDDD EEEE FFFFFF',
    ];
    for (const text of texts) {
      for (const w of [11, 12, 13, 15, 18, 22]) {
        for (const hourglass of [TYPESET_DEFAULTS.hourglass, 5000]) {
          const tidiest = Math.min(...balanceCandidates(text, w, chars, { hourglass }).map((c) => c.merit));
          const chosen = balanceScored(text, w, chars, { hourglass });
          expect(chosen.merit).toBeLessThanOrEqual(tidiest + TYPESET_DEFAULTS.lineCost + 1e-12);
        }
      }
    }
  });

  it('lets an hourglass stand when the text admits nothing else', () => {
    // Two unbreakable words that cannot share a line with anything, and a scrap
    // between them. There is no non-pinched breaking, and the rule degrades to a
    // penalty rather than refusing to answer - which is the whole reason it is a
    // penalty and not a rejection.
    const lines = balanceLines('WWWWWWWWWWWW ab cd WWWWWWWWWWWW', 13, chars);
    expect(lines).toEqual(['WWWWWWWWWWWW', 'ab cd', 'WWWWWWWWWWWW']);
  });
});

describe('balanceLines - a short word is never left alone', () => {
  it('keeps a two-letter word company', () => {
    const lines = balanceLines('WHAT DID YOU DO', 10, chars);
    expect(lines).toEqual(['WHAT DID', 'YOU DO']);
    for (const l of lines) expect(l.split(/\s+/).length === 1 && l.length < 3).toBe(false);
  });

  it('holds over the whole block, not just the last line', () => {
    const lines = balanceLines('IT IS A VERY LONG DAY', 10, chars);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      if (l.split(/\s+/).length === 1) expect(l.replace(/[^\p{L}\p{N}]/gu, '').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('counts letters, not characters - punctuation does not rescue a short word', () => {
    // "IT!" is three characters and two letters, so it is still an orphan.
    const lines = balanceLines('SOMETHING HAPPENED IT!', 12, chars, { minOrphan: 3 });
    expect(lines.at(-1)).not.toBe('IT!');
  });

  it('excludes Hangul from the orphan penalty', () => {
    // 1-2 syllable Korean eojeol ending a line (e.g. 네, 했다) is not penalized as an orphan
    const lines = balanceLines('안녕하세요 네', 6, chars, { minOrphan: 3 });
    expect(lines).toEqual(['안녕하세요', '네']);
  });

  it('takes the threshold from the caller', () => {
    const text = 'THE RAIN CAME DOWN AND IT WAS COLD';
    const strict = balanceLines(text, 12, chars, { minOrphan: 6 });
    for (const l of strict) {
      if (l.split(/\s+/).length === 1) expect(l.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('gives way when the constraint cannot be satisfied at all', () => {
    // "ok" has nowhere else to go: the word before it cannot share a line with
    // anything and cannot be split either, since a run of W has no syllable in
    // it for the pattern set to find. An unsatisfiable hard constraint is
    // relaxed rather than left to return nothing.
    expect(balanceLines('WWWWWWWWWWWWWWWWWWWW ok', 8, chars)).toEqual([
      'WWWWWWWWWWWWWWWWWWWW',
      'ok',
    ]);
  });

  it('gives way for the one word that cannot be placed, and no others', () => {
    // "A", between two words too long to share a line with it, is a genuine
    // orphan no breaking of this text can avoid. It used to take the rule down
    // with it for the whole paragraph - the relaxed pass dropped the constraint
    // rather than pricing it, so "I" was stranded on a line of its own although
    // "I DIE" fits and obeys the rule. Priced, only the impossible one survives.
    //
    // Hyphenation is off here because it is a second escape route from the same
    // corner and would answer the question this case is asking: with a hyphen
    // available `UNDERSTAND` splits, `A` finds company, and the orphan rule is
    // no longer under any strain at all. What is under test is `orphanCost`.
    const lines = balanceLines('I DIE UNDERSTAND A MONSTER A NO', 6, chars, { hyphenate: false });
    expect(lines).toEqual(['I DIE', 'UNDERSTAND', 'A', 'MONSTER', 'A NO']);
    const alone = lines.filter((l) => l.split(/\s+/).length === 1 && l.length < 3);
    expect(alone).toEqual(['A']);
  });
});

describe('balanceLines - a word is only broken when nothing else will do', () => {
  it('puts a word with no syllable points on its own line, whole', () => {
    // Nothing in the pattern set can pronounce a run of W, so there is no break
    // point to offer and the old behaviour is the only behaviour.
    const lines = balanceLines('SAY WWWWWWWWWWWWWWWWWWWWWWWWWWWW NOW PLEASE', 12, chars);
    expect(lines).toContain('WWWWWWWWWWWWWWWWWWWWWWWWWWWW');
    expect(lines.join(' ').replace(/\s+/g, ' ')).toBe('SAY WWWWWWWWWWWWWWWWWWWWWWWWWWWW NOW PLEASE');
  });

  it('lets that one line overflow rather than splitting it', () => {
    const lines = balanceLines('AAAAAAAAAAAAAAAAAAAA', 5, chars);
    expect(lines).toEqual(['AAAAAAAAAAAAAAAAAAAA']);
  });

  it('skips ASCII hyphenation on Hangul words and lets them overflow', () => {
    // Hangul is excluded from ASCII hyphenation; long words overflow rather than being split
    const lines = balanceLines('안녕하세요 반갑습니다대한민국만세', 10, chars, { hyphenate: true });
    expect(lines).toEqual(['안녕하세요', '반갑습니다대한민국만세']);
  });

  it('carries a word to the next line whole when it fits there', () => {
    // `WONDERFUL` is nine units in a ten-unit box, so it fits on a line of its
    // own and is therefore never offered a break point at all - the gate is
    // about fitting, not about length.
    expect(balanceLines('THE WONDERFUL THING', 10, chars)).toEqual([
      'THE',
      'WONDERFUL',
      'THING',
    ]);
  });

  it('splits the word rather than hang it out of the box, when it fits nowhere', () => {
    expect(balanceLines('TINY ENORMOUSWORDHERE', 12, chars)).toEqual([
      'TINY ENOR-',
      'MOUSWORDHERE',
    ]);
    // And with the feature off, the old answer, unchanged.
    expect(balanceLines('TINY ENORMOUSWORDHERE', 12, chars, { hyphenate: false })).toEqual([
      'TINY',
      'ENORMOUSWORDHERE',
    ]);
  });
});

describe('balanceLines - the user’s text is never touched', () => {
  it('treats a newline as a hard paragraph break and balances each side alone', () => {
    const lines = balanceLines('ONE TWO\nTHREE FOUR FIVE SIX', 12, chars);
    expect(lines[0]).toBe('ONE TWO');
    expect(lines.slice(1).join(' ')).toBe('THREE FOUR FIVE SIX');
  });

  it('keeps a blank paragraph as a blank line', () => {
    expect(balanceLines('A\n\nB', 10, chars)).toEqual(['A', '', 'B']);
  });

  it('preserves interior spacing exactly, because a line is a slice', () => {
    // Nothing is re-joined from a word list - every line is `text.slice(a, b)`
    // between two word boundaries - so a double space the user typed survives.
    expect(balanceLines('HELLO   THERE FRIEND OF MINE', 14, chars)).toEqual([
      'HELLO   THERE',
      'FRIEND OF MINE',
    ]);
  });

  it('drops nothing and adds nothing', () => {
    const text = 'WE HAVE TO GET OUT OF HERE BEFORE IT FINDS US AGAIN';
    const lines = balanceLines(text, 16, chars);
    expect(lines.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it('answers for the empty and the single-word cases without ceremony', () => {
    expect(balanceLines('', 10, chars)).toEqual(['']);
    expect(balanceLines('   ', 10, chars)).toEqual(['']);
    expect(balanceLines('ALONE', 10, chars)).toEqual(['ALONE']);
    expect(balanceLines(null, 10, chars)).toEqual(['']);
  });
});

describe('balanceLines - determinism', () => {
  it('gives the same answer every time, for the same input', () => {
    const text = 'THIS IS THE PART WHERE YOU TELL ME IT WAS ALL A MISUNDERSTANDING';
    const first = balanceLines(text, 22, chars);
    for (let i = 0; i < 20; i++) expect(balanceLines(text, 22, chars)).toEqual(first);
  });

  it('breaks a tie toward fewer lines', () => {
    // Two lines is never beaten by three when the cost is otherwise equal -
    // `lineCost` is what makes that true, and it is what stops a perfectly
    // balanced tower of one-word lines from winning on raggedness alone.
    const lines = balanceLines('ALPHA BRAVO', 12, chars);
    expect(lines).toEqual(['ALPHA BRAVO']);
  });

  it('does not depend on the metric being uniform', () => {
    const text = 'THE quick BROWN fox JUMPED over IT';
    const a = balanceLines(text, 14, weighted);
    const b = balanceLines(text, 14, weighted);
    expect(a).toEqual(b);
    expect(a.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it('falls back to greedy wrapping rather than enumerating an essay', () => {
    const text = Array.from({ length: TYPESET_DEFAULTS.maxWords + 20 }, (_, i) => `W${i}`).join(' ');
    const lines = balanceLines(text, 20, chars);
    expect(lines.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(20);
    // And says so, with a price on the same scale as everything else.
    const scored = balanceScored(text, 20, chars);
    expect(scored.greedy).toBe(true);
    expect(Number.isFinite(scored.cost)).toBe(true);
    expect(balanceCandidates(text, 20, chars)).toEqual([scored]);
  });

  it('sets a 70-word paragraph by the search, and says which path it took', () => {
    // Past the old limit of 60 words, and at 21 lines past the old 16 as well.
    // Greedy wrapping, which is what a paragraph this long used to get, fills
    // KEEPER WAS to the brim and strands SO in front of a word it cannot share
    // a line with.
    const text =
      'THE OLD KEEPER WAS SO UNCHARACTERISTICALLY QUIET WHEN HE FINALLY CAME DOWN FROM THE ' +
      'TOWER THAT WE KNEW SOMETHING WAS WRONG BEFORE HE SAID A WORD AND WHEN HE DID SPEAK IT ' +
      'WAS ONLY TO TELL US THAT THE SHIPS HAD STOPPED COMING YEARS AGO AND THAT HE HAD GONE ON ' +
      'LIGHTING THE LAMP EVERY NIGHT ANYWAY BECAUSE SOMEBODY HAD TO DO IT AND BECAUSE THE DARK ' +
      'MUST NEVER WIN';
    expect(text.split(' ')).toHaveLength(70);
    const alone = (l) => !/\s/.test(l) && l.replace(/[^\p{L}\p{N}]/gu, '').length < TYPESET_DEFAULTS.minOrphan;

    const scored = balanceScored(text, 20, chars);
    expect(scored.greedy).toBe(false);
    expect(scored.orphansRelaxed).toBe(false);
    expect(scored.lines).toHaveLength(21);
    expect(scored.lines.filter(alone)).toEqual([]);
    expect(scored.lines.join(' ').split(' ')).toEqual(text.split(' '));

    const before = balanceScored(text, 20, chars, { maxWords: 60, maxLines: 16 });
    expect(before.greedy).toBe(true);
    expect(before.lines.filter(alone)).toEqual(['SO']);
  });
});

// ===== paragraphs on the rows they are drawn on (GEO-2) =====
//
// A balloon's rows belong to the whole block, so a paragraph is broken against
// the rows it lands on, not against a block of its own lines. The oval is 26
// wide and 8 tall, a line is 1 tall, and a line of `chars` is its length.
describe('balanceLines - paragraphs on the rows of the whole block', () => {
  const oval = (L) => interiorLineWidths({ kind: 'ellipse', cx: 0, cy: 0, rx: 13, ry: 4 }, 1, L, 'middle', { inset: 0 });
  const onItsRow = (lines) => {
    const rows = oval(lines.length);
    return lines.every((ln, i) => ln.length <= rows[i] + 1e-9);
  };
  const text = 'WE HAVE TO GET OUT OF HERE\nBEFORE IT FINDS US AGAIN';

  it('puts every line inside the row it is drawn on', () => {
    // Alone, the first paragraph is one centred line with the oval's full 25.8
    // of room, and so is the second - but together they are two rows of 25.2,
    // and 26 characters do not go in one.
    const alone = text.split('\n').flatMap((para) => balanceLines(para, oval, chars));
    expect(alone).toEqual(['WE HAVE TO GET OUT OF HERE', 'BEFORE IT FINDS US AGAIN']);
    expect(onItsRow(alone)).toBe(false);
    const lines = balanceLines(text, oval, chars);
    expect(lines).toEqual(['WE HAVE TO', 'GET OUT OF HERE', 'BEFORE IT FINDS US AGAIN']);
    expect(onItsRow(lines)).toBe(true);
  });

  // `layoutLines` drops the blank lines at either end, so the block is drawn
  // without them and they take no rows. One between two paragraphs is drawn,
  // and does.
  it('gives the blank paragraphs at the ends no rows, and one between paragraphs its own', () => {
    expect(balanceLines(`\n${text}\n`, oval, chars)).toEqual(['', ...balanceLines(text, oval, chars), '']);
    const gap = balanceLines(text.replace('\n', '\n\n'), oval, chars);
    expect(gap[gap.indexOf('') - 1]).toBeDefined();
    expect(onItsRow(gap)).toBe(true);
  });

  it('breaks a count across paragraphs on the same rows', () => {
    for (const c of balanceCandidates(text, oval, chars)) expect(onItsRow(c.lines)).toBe(true);
  });
});

// ===== what the choice knew =====
//
// `balanceScored` is `balanceLines` with its reasons attached, and
// `balanceCandidates` is every line count it weighed, for a caller - the fitting
// pass - that has a reason of its own to take a count other than the cheapest.

describe('balanceScored and balanceCandidates', () => {
  const texts = [
    'THE WORLD IS ENDING AND NOBODY CARES AT ALL',
    'STOP ALWAYS WHY NEVER HELP NEVER A NEVER I NEVER',
    'AAAAA BBBB CCC DDDD EEEE FFFFFF',
    'ONE TWO\nTHREE FOUR FIVE SIX',
    'WE HAVE TO GET OUT OF HERE\n\nBEFORE IT FINDS US AGAIN',
  ];

  it('is balanceLines with its prices attached', () => {
    for (const text of texts) {
      for (const w of [9, 12, 15, 22]) {
        for (const metric of [chars, weighted]) {
          const scored = balanceScored(text, w, metric);
          expect(scored.lines).toEqual(balanceLines(text, w, metric));
          // The profile adds at most a line's price per paragraph.
          const paragraphs = text.split('\n').length;
          expect(scored.cost).toBeGreaterThanOrEqual(scored.merit);
          expect(scored.cost).toBeLessThanOrEqual(scored.merit + paragraphs * TYPESET_DEFAULTS.lineCost + 1e-12);
          expect(scored.greedy).toBe(false);
        }
      }
    }
  });

  it('offers the chosen breaking among every count, and nothing cheaper', () => {
    for (const text of texts) {
      for (const w of [9, 12, 15, 22]) {
        const scored = balanceScored(text, w, chars);
        const all = balanceCandidates(text, w, chars);
        const counts = all.map((c) => c.lines.length);
        expect(counts).toEqual([...counts].sort((a, b) => a - b));
        expect(new Set(counts).size).toBe(counts.length);
        expect(all.find((c) => c.lines.length === scored.lines.length)).toEqual(scored);
        for (const c of all) expect(c.cost).toBeGreaterThanOrEqual(scored.cost);
      }
    }
  });

  it('sets a count across paragraphs by the cheapest split of it', () => {
    // Checked against every way of adding the paragraphs' own tables together.
    const text = 'WE HAVE TO GET OUT OF HERE\nBEFORE IT FINDS US AGAIN';
    const [a, b] = text.split('\n').map((para) => balanceCandidates(para, 11, chars));
    const cheapest = new Map();
    for (const x of a) {
      for (const y of b) {
        const L = x.lines.length + y.lines.length;
        const cost = x.cost + y.cost;
        if (!cheapest.has(L) || cost < cheapest.get(L).cost) cheapest.set(L, { cost, lines: [...x.lines, ...y.lines] });
      }
    }
    const all = balanceCandidates(text, 11, chars);
    expect(all.map((c) => c.lines.length)).toEqual([...cheapest.keys()].sort((p, q) => p - q));
    for (const c of all) {
      const want = cheapest.get(c.lines.length);
      expect(c.lines).toEqual(want.lines);
      expect(c.cost).toBeCloseTo(want.cost, 12);
    }
  });

  it('names the lines that hang over their row, and says when an orphan had to stay', () => {
    // Twenty W is one token with no syllable in it, wider than the box, so no
    // breaking puts it inside; and it cannot share a line, so "ok" is alone.
    const scored = balanceScored('WWWWWWWWWWWWWWWWWWWW ok', 8, chars);
    expect(scored.lines).toEqual(['WWWWWWWWWWWWWWWWWWWW', 'ok']);
    expect(scored.overflowLines).toEqual([0]);
    expect(scored.orphansRelaxed).toBe(true);
    // Numbered within the whole block, after the paragraphs before it.
    const two = balanceScored('OH NO\nWWWWWWWWWWWWWWWWWWWW', 8, chars);
    expect(two.lines).toEqual(['OH NO', 'WWWWWWWWWWWWWWWWWWWW']);
    expect(two.overflowLines).toEqual([1]);
    expect(two.orphansRelaxed).toBe(false);
    // Against each row's own width: nine units fit a nine-wide first row and
    // not a six-wide second one.
    const rows = balanceScored('WWWWWWWWW WWWWWWWWW', (L) => (L === 2 ? [9, 6] : new Array(L).fill(6)), chars);
    expect(rows.lines).toEqual(['WWWWWWWWW', 'WWWWWWWWW']);
    expect(rows.overflowLines).toEqual([1]);
    // And ordinary text has none of it.
    const plain = balanceScored('THE WORLD IS ENDING AND NOBODY CARES AT ALL', 18, chars);
    expect(plain.overflowLines).toEqual([]);
    expect(plain.orphansRelaxed).toBe(false);
  });
});

// ===== the width may be a shape =====
//
// A speech balloon is an oval, and the room inside an oval is narrow at the top
// and the bottom and wide across the middle. `balanceLines` takes that as a
// callback from a line count to one width per line; a bare number still means
// the same width for every line, which is what every caller in the app passes.

// The shape the app will actually hand in, near enough for a test: an ellipse of
// half-width `half`, cut into `L` horizontal bands, each reported at the width
// of its narrowest edge.
const ellipse = (half) => (L) =>
  Array.from({ length: L }, (_, k) => {
    const t = ((k + 0.5) / L) * 2 - 1;
    return 2 * half * Math.sqrt(Math.max(0.02, 1 - t * t));
  });
// How full each line is relative to the room it was given. Every shape rule in
// the module is really a statement about these numbers and not about lengths.
const fills = (lines, w) => lines.map((l, i) => l.length / w[i]);
const spread = (xs) => Math.max(...xs) - Math.min(...xs);

describe('balanceLines - one width per line', () => {
  const texts = [
    'THE WORLD IS ENDING AND NOBODY CARES AT ALL',
    'YOU ARE GOING TO REGRET THIS FOR THE REST OF YOUR LIFE',
    'WE HAVE TO GET OUT OF HERE BEFORE IT FINDS US AGAIN',
    'THIS IS THE PART WHERE YOU TELL ME IT WAS ALL A MISUNDERSTANDING',
    'HELLO   THERE FRIEND OF MINE',
    'ONE TWO\nTHREE FOUR FIVE SIX',
    'STOP ALWAYS WHY NEVER HELP NEVER A NEVER I NEVER',
  ];

  it('is the same function whether the width arrives as a number or an array', () => {
    // The claim the whole change rests on: a callback that happens to be
    // constant is not a second code path, it is the same one. Measured here on
    // a handful of strings and, off-line, on 54,000 breakings of a 3000-string
    // corpus across nine widths and two metrics, where the two hash identically.
    for (const text of texts) {
      for (const w of [8, 11, 14, 18, 24, 33]) {
        for (const metric of [chars, weighted]) {
          expect(balanceLines(text, (L) => new Array(L).fill(w), metric)).toEqual(
            balanceLines(text, w, metric),
          );
        }
      }
    }
  });

  it('fits each line to its own allowance rather than to the widest one', () => {
    const w = ellipse(14);
    const text = 'YOU ARE GOING TO REGRET THIS FOR THE REST OF YOUR LIFE';
    const shaped = balanceLines(text, w, chars);
    const allow = w(shaped.length);
    for (let i = 0; i < shaped.length; i++) expect(shaped[i].length).toBeLessThanOrEqual(allow[i]);

    // And the thing it is fixing: one flat number set to the balloon's widest
    // point puts every line over the curve, which is what the reader sees as
    // text running into the outline.
    const flat = balanceLines(text, Math.max(...allow), chars);
    const flatAllow = w(flat.length);
    expect(flat.some((l, i) => l.length > flatAllow[i])).toBe(true);
  });

  it('does not read an oval’s narrow ends as a defect', () => {
    // The first and last lines of a block in an ellipse are the shortest strings
    // in it, and that is the shape working rather than the shape failing. What
    // the rules look at is fill, and the fills come out flat.
    const w = ellipse(12);
    const lines = balanceLines('THE WORLD IS ENDING AND NOBODY CARES AT ALL', w, chars);
    const allow = w(lines.length);
    expect(lines).toEqual(['THE WORLD IS', 'ENDING AND NOBODY', 'CARES AT ALL']);
    expect(spread(fills(lines, allow))).toBeLessThan(0.1);
    // Narrow, wide, narrow in absolute terms - the beehive the rules ask for.
    expect(lines[1].length).toBeGreaterThan(lines[0].length);
    expect(lines[1].length).toBeGreaterThan(lines[2].length);
  });

  it('balances against the room the block has, not against a number', () => {
    // A wedge, so the widths differ by a lot and cannot be mistaken for each
    // other. The line lengths track the widths; the fills do not move much.
    const wedge = (L) => Array.from({ length: L }, (_, k) => 26 - 5 * k);
    const lines = balanceLines('YOU ARE GOING TO REGRET THIS FOR THE REST OF YOUR LIFE', wedge, chars);
    const allow = wedge(lines.length);
    expect(lines).toEqual(['YOU ARE GOING TO REGRET', 'THIS FOR THE REST', 'OF YOUR LIFE']);
    expect(spread(lines.map((l) => l.length))).toBeGreaterThan(8);
    expect(spread(fills(lines, allow))).toBeLessThan(0.15);
  });

  it('calls a pinch a pinch by fill, and not by length', () => {
    // The same physical profile, judged twice. Under a flat fifteen the module
    // repairs (11, 9, 12, 13) because the 9 in the middle is a hole; told that
    // the second line only ever had twelve units of room, it leaves the very
    // same breaking alone, because a line filled to three quarters between two
    // filled to three quarters is not a hole. This is the whole of what the
    // shape rules mean under a width that varies.
    const text = 'STOP ALWAYS WHY NEVER HELP NEVER A NEVER I NEVER';
    const blind = balanceLines(text, 15, chars, { hourglass: 0 });
    expect(blind.map((l) => l.length)).toEqual([11, 9, 12, 13]);
    expect(balanceLines(text, 15, chars)).not.toEqual(blind);

    const narrowSecond = (L) => (L === 4 ? [15, 12, 15, 15] : new Array(L).fill(15));
    const shaped = balanceLines(text, narrowSecond, chars);
    expect(shaped).toEqual(blind);
    expect(dip(shaped.map((l, i) => 'x'.repeat(Math.round(l.length / narrowSecond(4)[i] * 100))), 100))
      .toBeLessThanOrEqual(TYPESET_DEFAULTS.hourglassTol);
  });

  it('asks for a line count once, and only for counts it might use', () => {
    const seen = [];
    const spy = (L) => {
      seen.push(L);
      return new Array(L).fill(16);
    };
    const text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL';
    const lines = balanceLines(text, spy, chars);
    // Once each, so the search and the scorer can never be looking at two
    // different balloons; and not past the count where the lines alone would
    // cost more than the block already found.
    // Four lines at 0.55 is the winner, and five lines cost 0.6 before a single
    // line of them is priced.
    expect(new Set(seen).size).toBe(seen.length);
    expect(lines).toHaveLength(4);
    expect(Math.max(...seen)).toBe(4);
    // Every count is on offer to a caller that asks for them all - but never one
    // above the number of words, because a block of nine words has nowhere to
    // put a tenth line. (Eight and nine are asked about and have no breaking:
    // IS and AT would each need a line of their own.)
    seen.length = 0;
    expect(balanceCandidates(text, spy, chars).map((c) => c.lines.length)).toEqual([4, 5, 6, 7]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(Math.max(...seen)).toBe(9);
  });

  it('survives a callback that hands back nonsense', () => {
    const text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL';
    // A hole at the top of the array is filled from the same balloon rather
    // than from a number that would put every line over the edge.
    expect(balanceLines(text, () => [NaN, 20], chars)).toEqual(balanceLines(text, 20, chars));
    // And nothing anywhere throws, divides by zero, or returns a NaN line. The
    // widths these produce are degenerate, so the breaking is too - but every
    // character the user typed still comes back, in order.
    const strip = (s) => s.replace(/[-\s]/g, '');
    for (const bad of [() => [], () => [0, -4], () => null, () => [Infinity], () => 12]) {
      const lines = balanceLines(text, bad, chars);
      for (const l of lines) expect(typeof l).toBe('string');
      expect(strip(lines.join(''))).toBe(strip(text));
    }
  });

  it('still treats a bare number, or none at all, as one width for every line', () => {
    expect(balanceLines('ALPHA BRAVO', 12, chars)).toEqual(['ALPHA BRAVO']);
    expect(balanceLines('ALPHA BRAVO', 12, chars)).toEqual(
      balanceLines('ALPHA BRAVO', () => [12, 12], chars),
    );
  });
});

// ===== which silhouette =====
//
// 'auto' fills each line to its own row, so the block takes the balloon's
// silhouette. 'oval' and 'rect' ask for one silhouette whatever the balloon
// does, as a preference priced at no more than a line.

describe('balanceScored - the silhouette a block aims for', () => {
  const texts = [
    'THE WORLD IS ENDING AND NOBODY CARES AT ALL',
    'YOU ARE GOING TO REGRET THIS FOR THE REST OF YOUR LIFE',
    'WE HAVE TO GET OUT OF HERE BEFORE IT FINDS US AGAIN',
    'THIS IS THE PART WHERE YOU TELL ME IT WAS ALL A MISUNDERSTANDING',
    'STOP ALWAYS WHY NEVER HELP NEVER A NEVER I NEVER',
    'AAAAA BBBB CCC DDDD EEEE FFFFFF',
    "Is there something you'd like our cooperation with?",
    "Now then, I shall go submit everyone's lottery results.",
    '...are the twin pillars holding up Kuzunoha-sensei and the company.',
    'He told me not to imbue my arrows.',
  ];
  const lineCost = TYPESET_DEFAULTS.lineCost;

  it('is the ordinary block unless it is asked for, and a rectangle is already even', () => {
    // A value the module does not know is 'auto' - 'off' is measure.js's switch
    // to plain wrapping and never reaches the breaker as a preference. And a
    // rectangle asked for an even block is handed the one it already had, to
    // the last bit rather than to a rounding error.
    for (const text of texts) {
      for (const w of [9, 12, 16, 20, 26, 34]) {
        for (const metric of [chars, weighted]) {
          const plain = balanceScored(text, w, metric);
          for (const shape of ['auto', 'off', 'bogus', 'rect']) {
            expect(balanceScored(text, w, metric, { shape })).toEqual(plain);
          }
          expect(balanceCandidates(text, w, metric, { shape: 'rect' })).toEqual(balanceCandidates(text, w, metric));
        }
      }
    }
  });

  it('sets an oval as short, long, short at the count the text wants', () => {
    // Even in a rectangle, which is what 'auto' makes of it: the same three
    // lines, re-cut so the middle one carries the width.
    const told = 'He told me not to imbue my arrows.';
    expect(balanceLines(told, 16, chars)).toEqual(['He told me', 'not to imbue', 'my arrows.']);
    expect(balanceLines(told, 16, chars, { shape: 'oval' })).toEqual(['He told', 'me not to imbue', 'my arrows.']);

    const flashy = 'That flashy one you used against the sub-dragon?';
    expect(balanceLines(flashy, 20, chars)).toEqual(['That flashy one', 'you used against', 'the sub-dragon?']);
    expect(balanceLines(flashy, 20, chars, { shape: 'oval' })).toEqual([
      'That flashy',
      'one you used against',
      'the sub-dragon?',
    ]);
  });

  it('sets an even block in an oval balloon when asked for a rectangle', () => {
    // The mirror case: 'auto' follows the balloon's curve, 'rect' evens the
    // lines out - and still keeps every one of them inside its own row.
    const text = 'That flashy one you used against the sub-dragon?';
    const w = ellipse(12);
    expect(balanceLines(text, w, chars)).toEqual(['That flashy', 'one you used against', 'the sub-dragon?']);
    const even = balanceLines(text, w, chars, { shape: 'rect' });
    expect(even).toEqual(['That flashy one', 'you used against', 'the sub-dragon?']);
    const rows = w(even.length);
    even.forEach((line, k) => expect(line.length).toBeLessThanOrEqual(rows[k]));
  });

  it('aims a dense block at the oval it can have, not at one it cannot', () => {
    // Three full lines in a narrow box. The oval the text would need is wider
    // in the middle than the box is, so the middle line is on target at the
    // box's full width - not a pinch to be cured by a fourth line.
    const text = "Does that mean we're being abandoned... or something?";
    const lines = ["Does that mean we're", 'being abandoned...', 'or something?'];
    expect(balanceLines(text, 20, chars)).toEqual(lines);
    expect(balanceLines(text, 20, chars, { shape: 'oval' })).toEqual(lines);
  });

  it('never spends more than a line on the silhouette', () => {
    // Priced in full, an oval bought as many lines as it took to be one: this
    // went from three lines to five. Capped, it keeps its three and pays the
    // line instead.
    const coop = "Is there something you'd like our cooperation with?";
    const plain = balanceScored(coop, 20, chars);
    const oval = balanceScored(coop, 20, chars, { shape: 'oval' });
    expect(plain.lines).toHaveLength(3);
    expect(oval.lines).toEqual(plain.lines);
    expect(oval.cost).toBeCloseTo(plain.cost + lineCost, 12);

    // And in general: at every count, in rectangles and ellipses, by the search
    // and by the greedy fallback, a silhouette costs at most a line more than
    // the ordinary block, keeps it inside its rows, and offers the same counts.
    for (const text of texts) {
      for (const w of [9, 12, 16, 20, 26, 34, ellipse(8), ellipse(12), ellipse(16)]) {
        for (const metric of [chars, weighted]) {
          for (const extra of [{}, { maxWords: 5 }]) {
            const ordinary = balanceScored(text, w, metric, extra);
            const counts = balanceCandidates(text, w, metric, extra);
            for (const shape of ['oval', 'rect']) {
              const chosen = balanceScored(text, w, metric, { ...extra, shape });
              expect(chosen.cost).toBeLessThanOrEqual(ordinary.cost + lineCost + 1e-9);
              expect(chosen.greedy).toBe(ordinary.greedy);
              for (const k of chosen.overflowLines) expect(chosen.lines[k].trim()).not.toMatch(/\s/);

              const offered = balanceCandidates(text, w, metric, { ...extra, shape });
              expect(offered.map((c) => c.lines.length)).toEqual(counts.map((c) => c.lines.length));
              offered.forEach((c, i) => expect(c.cost).toBeLessThanOrEqual(counts[i].cost + lineCost + 1e-9));
              expect(offered).toContainEqual(chosen);
            }
          }
        }
      }
    }
  });
});

// ===== hyphenation =====
//
// The reference is a tall narrow balloon reading MURA- / MATA- / SAN!, which is
// what a letterer does with a name that will not fit and what this module used
// to refuse to do at all.

// Every line is a slice of the input, and the hyphen is the one character the
// module may add - so dropping a single trailing hyphen from any line has to
// leave a substring of what the user typed. That is the statement `box.text` and
// the queue line depend on.
const isSlice = (line, text) => text.includes(line) || text.includes(line.slice(0, -1));
const letters = (s) => (s.match(/[\p{L}\p{N}]/gu) || []).length;

describe('balanceLines - hyphenation, priced as a last resort', () => {
  it('sets the reference block', () => {
    expect(balanceLines('MURAMATA-SAN!', 5, chars)).toEqual(['MURA-', 'MATA-', 'SAN!']);
  });

  it('never invents a break the pattern set did not offer', () => {
    // The failure this is guarding against by name. `MURAMA-TASAN` is a
    // typesetting error a reader notices; the en-US patterns put the points
    // after MU and after MURA, and nowhere else inside that chunk.
    for (let w = 4; w <= 12; w++) {
      const lines = balanceLines('MURAMATASAN', w, chars);
      expect(lines.join('')).toBe(lines.join('')); // no reordering, checked below
      for (const l of lines) expect(isSlice(l, 'MURAMATASAN')).toBe(true);
      const hyphenated = lines.filter((l) => l.endsWith('-'));
      for (const h of hyphenated) expect(['MU-', 'MURA-']).toContain(h);
    }
  });

  it('leaves a word that fits alone', () => {
    // The gate, and the reason ordinary dialogue never sees a hyphen: the word
    // has to fit on no line the block could give it before it is even offered a
    // break point.
    expect(balanceLines('WONDERFUL', 9, chars)).toEqual(['WONDERFUL']);
    expect(balanceLines('THE WONDERFUL THING', 10, chars)).toEqual(['THE', 'WONDERFUL', 'THING']);
    const real = [
      'THE WORLD IS ENDING AND NOBODY CARES AT ALL',
      'WE HAVE TO GET OUT OF HERE BEFORE IT FINDS US AGAIN',
      'THIS IS THE PART WHERE YOU TELL ME IT WAS ALL A MISUNDERSTANDING',
      'SOMETHING TERRIBLE HAPPENED AT THE SCHOOL YESTERDAY',
      'EVERYTHING I EVER TOLD YOU ABOUT MY FAMILY WAS A LIE',
    ];
    for (const text of real) {
      for (const w of [16, 18, 20, 22, 26, 30]) {
        for (const l of balanceLines(text, w, chars)) expect(l.endsWith('-')).toBe(false);
      }
    }
  });

  it('keeps at least two letters before the hyphen and three after it', () => {
    const words = [
      'ANTIDISESTABLISHMENTARIANISM', 'MISUNDERSTANDING', 'MURAMATA-SAN!', 'CO-OPERATE',
      'WONDERFULLY', 'IMPOSSIBILITY', 'EXTRAORDINARY', 'UNBELIEVABLE', 'CONGRATULATIONS',
      'TRANSFORMATION', 'RESPONSIBILITY', 'ELECTRICITY', 'INTERNATIONAL', 'ONOMATOPOEIA',
    ];
    let split = 0;
    for (const word of words) {
      for (let w = 3; w <= 14; w++) {
        const lines = balanceLines(word, w, chars);
        if (lines.length > 1) split++;
        for (let i = 0; i < lines.length; i++) {
          const frag = lines[i].endsWith('-') && i < lines.length - 1 ? lines[i].slice(0, -1) : lines[i];
          // Two letters on every fragment the block carries, three on the one
          // that ends the word - the tail rule is also the anti-stub rule for
          // the end of a paragraph, since the last word's tail IS the last line.
          expect(letters(frag)).toBeGreaterThanOrEqual(
            i === lines.length - 1 ? TYPESET_DEFAULTS.minHyphenTail : TYPESET_DEFAULTS.minHyphenHead,
          );
        }
      }
    }
    expect(split).toBeGreaterThan(100); // the sweep really did split things
  });

  it('counts the minimums in letters, so punctuation cannot dress up a stub', () => {
    // `hypher` enforces 2 and 3 itself and counts characters, which would let a
    // trailing exclamation mark pass as a third letter. `SAN!` is three letters
    // and survives; a tail of `N!!` would be one and does not.
    expect(balanceLines('MURAMATA-SAN!', 5, chars).at(-1)).toBe('SAN!');
    for (let w = 3; w <= 10; w++) {
      for (const l of balanceLines('WONDERFUL!!!', w, chars)) {
        expect(letters(l.replace(/-$/, ''))).toBeGreaterThanOrEqual(2);
      }
      expect(letters(balanceLines('WONDERFUL!!!', w, chars).at(-1))).toBeGreaterThanOrEqual(3);
    }
  });

  it('breaks at a hyphen the user typed, and does not add a second', () => {
    const lines = balanceLines('MURAMATA-SAN!', 9, chars);
    expect(lines).toEqual(['MURAMATA-', 'SAN!']);
    expect(lines[0].endsWith('--')).toBe(false);
    expect(balanceLines('CO-OPERATE', 6, chars)).toEqual(['CO-', 'OPERATE']);
    // Where both kinds are available and both fit, the typed one is cheaper and
    // wins: `MURA-` is a legal invented break at this width and is not taken.
    expect(balanceLines('LISTEN MURAMATA-SAN!', 9, chars)).toEqual([
      'LISTEN',
      'MURAMATA-',
      'SAN!',
    ]);
  });

  it('avoids two hyphenated lines in a row when there is an alternative', () => {
    const text = 'SAY ANTIDISESTABLISHMENTARIANISM NOW PLEASE';
    const twoInARow = (lines) =>
      lines.some((l, i) => i > 0 && l.endsWith('-') && lines[i - 1].endsWith('-'));
    // With the term switched off the search happily strings them together; at
    // the default it takes an overflowing line instead, which is the trade the
    // rule asks for.
    expect(twoInARow(balanceLines(text, 12, chars, { hyphenPair: 0 }))).toBe(true);
    expect(twoInARow(balanceLines(text, 12, chars))).toBe(false);
  });

  it('takes two in a row anyway when the text admits nothing else', () => {
    // The reference block is exactly this case: every line of `MURAMATA-SAN!` in
    // a five-unit balloon has to end in a hyphen, so the rule is a price and not
    // a prohibition - the same shape the orphan rule has.
    expect(balanceLines('MURAMATA-SAN!', 5, chars)).toEqual(['MURA-', 'MATA-', 'SAN!']);
  });

  it('loses to an equally good block without one', () => {
    // `TERRIBLE` is one unit over a seven-unit box, and splitting it would give
    // a tidier block: (3, 6, 7) against (3, 8, 3). The tidier block is not
    // chosen, because the hyphen costs more than the tidying is worth - and
    // zeroing that one price is all it takes to flip the answer, which is how
    // the claim is shown to be about the price and not about anything else.
    const text = 'SAY TERRIBLE NOW';
    expect(balanceLines(text, 7, chars)).toEqual(['SAY', 'TERRIBLE', 'NOW']);
    expect(balanceLines(text, 7, chars, { hyphen: 0, lastWordHyphen: 0 })).toEqual([
      'SAY',
      'TERRI-',
      'BLE NOW',
    ]);
  });

  it('prefers a small overflow to a hyphen, and a hyphen to a large one', () => {
    // The overflow term is quadratic, which is what makes that sentence true
    // rather than merely hopeful. `SENPAI` is one unit over a five-unit box and
    // keeps its overflow; `ENORMOUSWORDHERE` is eleven over and does not.
    expect(balanceLines('SENPAI', 5, chars)).toEqual(['SENPAI']);
    expect(balanceLines('ENORMOUSWORDHERE', 5, chars).length).toBeGreaterThan(1);
  });

  it('leaves a sound effect alone', () => {
    // Every one of these is plain A-Z, so the pattern set will cheerfully offer
    // points inside it - `KRRSH-` / `HHHH-` / `HHHHH` is what came out before
    // the vowel rule. A syllable has a vowel in it; these pieces do not.
    for (const sfx of [
      'KRRSHHHHHHHHHH', 'SHHHHHHHHHHHH', 'GRRRRRRRRRRRR', 'THHHHHHHHHHHH', 'MMMMMMMMMMMM',
    ]) {
      for (const w of [3, 5, 8]) expect(balanceLines(sfx, w, chars)).toEqual([sfx]);
    }
  });

  it('leaves anything the en-US patterns have no business judging', () => {
    // An apostrophe in the middle, an accent, a digit, and two scripts the
    // pattern set has never seen. A word left whole is only a word left whole;
    // a word broken in the wrong place is an error on the page.
    for (const word of ['DOESN’T', "DOESN'T", 'CAFÉTERIARIA', 'MP3PLAYERTHING', 'ЗДРАВСТВУЙТЕ', 'ありがとうございます']) {
      for (const w of [3, 4, 6]) expect(balanceLines(word, w, chars)).toEqual([word]);
    }
  });

  it('works on text that has already been uppercased', () => {
    // Which is how it always arrives: the style carries an `uppercase` flag and
    // `applyCase` runs before any of this. The patterns are matched
    // case-insensitively and the user's own characters come back out.
    for (const [lower, upper] of [
      ['wonderful', 'WONDERFUL'],
      ['misunderstanding', 'MISUNDERSTANDING'],
      ['muramata-san', 'MURAMATA-SAN'],
    ]) {
      const a = balanceLines(lower, 6, chars);
      const b = balanceLines(upper, 6, chars);
      expect(b).toEqual(a.map((l) => l.toUpperCase()));
      for (const l of b) expect(isSlice(l, upper)).toBe(true);
    }
  });

  it('adds a hyphen to the rendered line and to nothing else', () => {
    // The contract the queue and `box.text` rely on. Every line is still a slice
    // of the input once the one hyphen this module is allowed to add is taken
    // back off, and the letters come out in the order they went in.
    const texts = [
      'MURAMATA-SAN!', 'SAY ANTIDISESTABLISHMENTARIANISM NOW PLEASE',
      'TINY ENORMOUSWORDHERE', 'HELLO   MISUNDERSTANDING FRIEND', 'IS CONGRATULATIONS RIGHT',
    ];
    for (const text of texts) {
      for (let w = 4; w <= 20; w += 2) {
        const lines = balanceLines(text, w, chars);
        for (const l of lines) expect(isSlice(l, text)).toBe(true);
        // Nothing dropped, nothing added, nothing reordered - hyphens and
        // whitespace aside, the characters are the characters.
        const strip = (s) => s.replace(/[-\s]/g, '');
        expect(strip(lines.join(''))).toBe(strip(text));
      }
    }
  });

  it('measures the hyphen it is about to draw', () => {
    // A hyphen that was not measured is a hyphen hanging out of the balloon, so
    // a hyphenated line has to fit its width WITH the hyphen on it. The only
    // lines allowed past that are single unbreakable pieces, which have nowhere
    // else to go.
    for (const text of ['MISUNDERSTANDING FOREVER', 'IS CONGRATULATIONS RIGHT NOW']) {
      for (let w = 8; w <= 20; w++) {
        for (const l of balanceLines(text, w, chars)) {
          if (l.endsWith('-') && /\s/.test(l)) expect(l.length).toBeLessThanOrEqual(w + 0.5);
        }
      }
    }
  });

  it('is one flag away from the module it used to be', () => {
    // `hyphenate: false` restores every previous answer exactly, which is what
    // makes the feature reviewable: the diff against the old behaviour is
    // entirely inside blocks that had a word hanging out of them.
    const text = 'SAY ANTIDISESTABLISHMENTARIANISM NOW PLEASE';
    expect(balanceLines(text, 12, chars, { hyphenate: false })).toEqual([
      'SAY',
      'ANTIDISESTABLISHMENTARIANISM',
      'NOW PLEASE',
    ]);
  });

  it('hyphenates against a per-line width like everything else', () => {
    // The two halves of this change meeting: the word is split against the room
    // its own line has, not against the widest line in the balloon.
    const w = (L) => (L === 3 ? [6, 14, 6] : new Array(L).fill(6));
    const lines = balanceLines('MISUNDERSTANDING NOW', w, chars);
    expect(lines).toHaveLength(3);
    const allow = w(3);
    for (let i = 0; i < 3; i++) {
      if (/\s/.test(lines[i])) expect(lines[i].length).toBeLessThanOrEqual(allow[i] + 0.5);
    }
    for (const l of lines) expect(isSlice(l, 'MISUNDERSTANDING NOW')).toBe(true);
  });
});

// The parity seam. Both the canvas (`TextBox.svelte`) and the exporter
// (`layoutBox` in exporter.js) ask this one function, with the box's own style
// size and content width, which is what makes them break in the same places.
// Under node there is no canvas, so `lineWidth` falls back to a stand-in metric
// - enough to prove which branch is taken, which is what is under test here.
describe('layoutLines - one answer for the editor and the export', () => {
  const style = { font: 'Comic Neue', size: 20, bold: false, italic: false, lineHeight: 1.1, letterSpacing: 0, align: 'center', uppercase: false };

  // Shaping is a beta the user opts into, and a cold test run has it off - so
  // everything below, which is about the shaped path, has to turn it on. See
  // 'the typesetting switch' further down for the gate itself.
  beforeEach(() => setTypesetEnabled(true));
  afterEach(() => setTypesetEnabled(false));

  it('shapes by default', () => {
    const lines = layoutLines('ONE TWO THREE FOUR', { ...style }, 20, 200);
    expect(lines.join(' ').split(/\s+/)).toEqual(['ONE', 'TWO', 'THREE', 'FOUR']);
  });

  it('hands the job back to plain wrapping when shaping is off', () => {
    // Asserted against the two functions themselves rather than against a
    // particular breaking, so the claim holds in an environment with real text
    // metrics and in this one, which has none.
    const text = 'AAAA BBBB CCCC DDDD EEEE';
    const narrow = 12 * 20 * 0.55; // the node fallback metric, ~12 characters wide
    expect(layoutLines(text, { ...style, shape: 'off' }, 20, narrow)).toEqual(
      wrapLinesDOM(text, { ...style, shape: 'off' }, 20, narrow),
    );
    expect(layoutLines(text, { ...style, shape: 'auto' }, 20, narrow)).toEqual(
      shapedLines(text, { ...style, shape: 'auto' }, 20, narrow),
    );
  });

  it('reads the orphan threshold off the style', () => {
    const narrow = 10 * 20 * 0.55;
    const lines = layoutLines('WHAT DID YOU DO', { ...style, minOrphan: 3 }, 20, narrow);
    for (const l of lines) expect(l.split(/\s+/).length === 1 && l.length < 3).toBe(false);
  });

  // The seam the balloon fitter will plug into. `layoutLines` grew a fifth
  // argument rather than a new function, because the whole value of this being
  // one function is that the editor and the exporter cannot drift apart - and a
  // second entry point is exactly how they would.
  it('passes a per-line width through to the breaker', () => {
    // The node fallback metric is 0.55 * size per character, so these are
    // widths in characters, converted.
    const unit = 20 * 0.55;
    const text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL';
    const box = 24 * unit; // the content width the box would report
    const wide = (L) => new Array(L).fill(box);
    const oval = ellipse(12 * unit); // twenty-four characters across the middle, less at the ends
    const width = (l) => l.length * unit;

    const shaped = layoutLines(text, { ...style }, 20, box, oval);
    const allow = oval(shaped.length);
    for (let i = 0; i < shaped.length; i++) expect(width(shaped[i])).toBeLessThanOrEqual(allow[i]);

    // The same box laid out against its widest point alone runs past the curve,
    // which is the whole reason the fifth argument exists.
    const flat = layoutLines(text, { ...style }, 20, box);
    const flatAllow = oval(flat.length);
    expect(flat.some((l, i) => width(l) > flatAllow[i])).toBe(true);

    // A callback that happens to be constant is not a different answer.
    expect(layoutLines(text, { ...style }, 20, box, wide)).toEqual(flat);
  });

  it('leaves the fifth argument out of the plain-wrapping path', () => {
    // `shape: 'off'` means "wrap the way the browser would", and the browser has
    // no way to wrap to a width that changes line by line. Honouring the
    // callback there would quietly break the one promise that path makes.
    const unit = 20 * 0.55;
    const text = 'AAAA BBBB CCCC DDDD EEEE';
    const off = { ...style, shape: 'off' };
    expect(layoutLines(text, off, 20, 12 * unit, () => [unit, unit])).toEqual(
      layoutLines(text, off, 20, 12 * unit),
    );
  });

  it('still answers the four-argument call every caller in the app makes', () => {
    const narrow = 12 * 20 * 0.55;
    const text = 'THE WORLD IS ENDING AND NOBODY CARES';
    expect(layoutLines(text, { ...style }, 20, narrow)).toEqual(
      shapedLines(text, { ...style }, 20, narrow),
    );
  });
});

// The beta switch, and the whole of what it means: with it off there is one
// answer for every box, and it is the browser's own wrapping. The gate lives in
// `layoutLines` rather than in each caller so the editor, the exporter, the PSD
// writer and auto-height cannot disagree about whether the beta is on.
describe('the typesetting switch', () => {
  const style = { font: 'Comic Neue', size: 20, bold: false, italic: false, lineHeight: 1.1, letterSpacing: 0, align: 'center', uppercase: false, shape: 'auto' };
  const text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL';
  const narrow = 12 * 20 * 0.55;

  afterEach(() => setTypesetEnabled(false));

  it('wraps plainly while it is off, whatever the style asks for', () => {
    setTypesetEnabled(false);
    expect(layoutLines(text, { ...style }, 20, narrow)).toEqual(
      wrapLinesDOM(text, { ...style }, 20, narrow),
    );
  });

  it('shapes once it is on', () => {
    setTypesetEnabled(true);
    expect(layoutLines(text, { ...style }, 20, narrow)).toEqual(
      shapedLines(text, { ...style }, 20, narrow),
    );
  });

  it('ignores the balloon while it is off', () => {
    const box = { x: 0, y: 0, w: 200, h: 120, fit: { kind: 'ellipse', cx: 100, cy: 60, rx: 100, ry: 60 } };
    setTypesetEnabled(false);
    expect(balloonWidthsFor(box, { ...style, valign: 'middle' }, 20)).toBe(null);
    setTypesetEnabled(true);
    expect(balloonWidthsFor(box, { ...style, valign: 'middle' }, 20)).toBeTypeOf('function');
  });
});

// A text too big for its balloon, laid out through the real wiring: the box
// placed at the balloon's inscribed rectangle and the widths from
// `balloonWidthsFor`, exactly as the editor and the exporter get them. The
// block cannot fit whatever the breaker does, so the question is only whether
// the balloon makes it worse than no balloon at all - and it used to, by a lot.
describe('a text too big for its balloon', () => {
  const fit = { kind: 'ellipse', cx: 300, cy: 300, rx: 130, ry: 80 };
  const room = inscribedRect(fit);
  const box = { x: room.x, y: room.y, w: room.w, h: room.h, fit };
  const contentW = box.w - BOX_PAD * 2;
  const style = { font: 'Comic Neue', size: 26, bold: false, italic: false, lineHeight: 1.1, letterSpacing: 0, align: 'center', uppercase: false, shape: 'auto', balloon: true };
  const probe = 'I CANNOT BELIEVE YOU WOULD SAY SOMETHING LIKE THAT TO ME AFTER EVERYTHING WE HAVE BEEN THROUGH';

  beforeEach(() => setTypesetEnabled(true));
  afterEach(() => setTypesetEnabled(false));

  it('breaks into no more lines than the flat box would', () => {
    // The probe that found it. At 26px this oval holds four lines and the text
    // needs ten even laid out flat; the rows past the curve used to come back
    // one pixel wide, each took a single word, and the block ran to fifteen
    // lines (sixteen bottom-aligned), twelve of them outside the balloon.
    for (const valign of ['top', 'middle', 'bottom']) {
      const s = { ...style, valign };
      const flat = layoutLines(probe, s, 26, contentW);
      const shaped = layoutLines(probe, s, 26, contentW, balloonWidthsFor(box, s, 26));
      expect(flat.length).toBe(10);
      expect(shaped.length).toBeLessThanOrEqual(flat.length);
    }
  });

  it('holds at every size the balloon runs out of rows at', () => {
    const texts = [
      probe,
      'YOU ARE GOING TO REGRET THIS FOR THE REST OF YOUR LIFE',
      'THIS IS THE PART WHERE YOU TELL ME IT WAS ALL A MISUNDERSTANDING',
      'WAIT. WHAT DID YOU JUST SAY TO ME?',
    ];
    const inset = safetyInset(fit);
    let checked = 0;
    for (const text of texts) {
      for (let size = 14; size <= 44; size += 3) {
        const s = { ...style, size, valign: 'middle' };
        const holds = Math.floor((2 * (fit.ry - inset)) / (size * s.lineHeight));
        const flat = layoutLines(text, s, size, contentW);
        if (flat.length <= holds) continue;
        checked++;
        const shaped = layoutLines(text, s, size, contentW, balloonWidthsFor(box, s, size));
        expect(shaped.length).toBeLessThanOrEqual(flat.length);
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

// ===========================================================================
// The solver's shortcuts through the breaker
// ===========================================================================
// The solver asks about sizes it throws away when the block is too tall, and
// asks about one paragraph again and again as it is typed. Neither shortcut it
// takes may change a line: a block it does lay out is the block the breaker
// always gave, and a block it gives up on is one that really was too tall.
describe('the breaker, asked only whether a block fits', () => {
  const oval = (L) => Array.from({ length: L }, (_, k) => 8 + 22 * Math.sin((Math.PI * (k + 0.5)) / L));
  const texts = [
    'THE WORLD IS ENDING AND NOBODY CARES AT ALL',
    'If we leave right now, we can still catch the last train before the storm hits the valley.',
    'Unquestionably, extraordinarily, incomprehensibly complicated negotiations.',
    'I DIE UNDERSTAND A MONSTER A NO',
    'Hi you',
    'WAIT!\n\nYou mean the one with the red door?\nNo way.',
    '\nOne paragraph between two blank ones.\n',
  ];

  it('gives up only on a block with more lines than asked, and otherwise changes nothing', () => {
    let gaveUp = 0;
    let kept = 0;
    for (const text of texts) {
      for (const width of [6, 11, 18, 30, oval]) {
        for (const metric of [chars, weighted]) {
          for (const shape of ['auto', 'oval', 'rect']) {
            const full = balanceScored(text, width, metric, { shape });
            for (let stopAbove = 0; stopAbove <= 9; stopAbove++) {
              const got = balanceScored(text, width, metric, { shape, stopAbove });
              if (got === null) {
                gaveUp++;
                expect(full.lines.length).toBeGreaterThan(stopAbove);
              } else {
                kept++;
                expect(got).toEqual(full);
              }
            }
          }
        }
      }
    }
    // Both halves of the promise were exercised.
    expect(gaveUp).toBeGreaterThan(100);
    expect(kept).toBeGreaterThan(100);
  });

  it('never gives up on a block of several paragraphs', () => {
    const text = 'WAIT!\n\nYou mean the one with the red door? The one nobody has opened since the war?\nNo way.';
    expect(balanceScored(text, 8, chars, { stopAbove: 1 })).toEqual(balanceScored(text, 8, chars));
  });
});

describe('the breaker, measuring one paragraph as it is typed', () => {
  // A measure that says a string always measures the same may have its widths
  // kept from one call to the next; the lines must be the ones a fresh measure
  // gives, whatever the edit between the calls.
  const kept = Object.assign((s) => weighted(s), { stable: true });
  const text = 'If we leave right now, we can still catch the last train before the storm hits the valley.';

  it('breaks as a fresh measure does, typed forwards, backwards and in the middle', () => {
    const edits = [];
    for (let i = 1; i <= text.length; i += 3) edits.push(text.slice(0, i));
    for (let i = text.length; i > 0; i -= 7) edits.push(text.slice(0, i));
    edits.push(text.replace('storm', 'STORM'), text.replace('train', 'bus'), text, text + ' Now.');
    for (const t of edits) {
      for (const width of [9, 16, 25, (L) => Array.from({ length: L }, (_, k) => 10 + 12 * Math.sin((Math.PI * (k + 0.5)) / L))]) {
        expect(balanceScored(t, width, kept)).toEqual(balanceScored(t, width, (s) => weighted(s)));
      }
    }
  });
});

// ===========================================================================
// The same block, broken once
// ===========================================================================
// `layoutLines` is asked the same question repeatedly with the same answer: the
// editor lays a box out to draw it and auto-height counts the same lines, the
// exporter asks a third time for a page already on screen, and a page turn does
// all of that for every box on the page. So the answer is remembered.
//
// The array identity is the observable: a hit hands back the very array the miss
// built, and there is no other way from outside this module to tell a re-break
// from a lookup.
describe('the line-breaking memo', () => {
  const style = {
    font: 'Comic Neue',
    size: 20,
    bold: false,
    italic: false,
    lineHeight: 1.1,
    letterSpacing: 0,
    align: 'center',
    uppercase: false,
    shape: 'auto',
    minOrphan: 3,
    hyphenate: true,
    valign: 'middle',
  };
  const text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL';

  beforeEach(() => {
    setTypesetEnabled(true);
    clearLayoutMemo();
  });
  afterEach(() => setTypesetEnabled(false));

  it('answers a repeated question with the answer it already has', () => {
    const first = layoutLines(text, { ...style }, 20, 200);
    const again = layoutLines(text, { ...style }, 20, 200);
    expect(again).toBe(first);
    expect(layoutMemoSize()).toBe(1);
  });

  // Every input that can move a break is in the key. Each of these is a
  // different question, so each of them has to be broken afresh - and the
  // content, not just the identity, has to be that question's own answer.
  it('re-breaks when anything that decides a break changes', () => {
    const base = layoutLines(text, { ...style }, 20, 200);
    const variants = [
      ['a different width', () => layoutLines(text, { ...style }, 20, 120)],
      ['a different text', () => layoutLines(`${text}!`, { ...style }, 20, 200)],
      ['a different size', () => layoutLines(text, { ...style, size: 28 }, 28, 200)],
      ['a different font', () => layoutLines(text, { ...style, font: 'Bangers' }, 20, 200)],
      ['bold', () => layoutLines(text, { ...style, bold: true }, 20, 200)],
      ['italic', () => layoutLines(text, { ...style, italic: true }, 20, 200)],
      ['a line height', () => layoutLines(text, { ...style, lineHeight: 1.4 }, 20, 200)],
      ['letter spacing', () => layoutLines(text, { ...style, letterSpacing: 3 }, 20, 200)],
      ['a case flag', () => layoutLines(text, { ...style, uppercase: true }, 20, 200)],
      ['an alignment', () => layoutLines(text, { ...style, align: 'left' }, 20, 200)],
      ['the shape switch', () => layoutLines(text, { ...style, shape: 'off' }, 20, 200)],
      ['an orphan rule', () => layoutLines(text, { ...style, minOrphan: 6 }, 20, 200)],
      ['hyphenation', () => layoutLines(text, { ...style, hyphenate: false }, 20, 200)],
    ];
    for (const [what, run] of variants) expect(run(), what).not.toBe(base);
    expect(layoutMemoSize()).toBe(variants.length + 1);
  });

  // A balloon's per-line widths are handed in as a CLOSURE, which cannot be a
  // key - two closures built from the same shape are different objects. So
  // `balloonWidthsFor` writes down what it captured, and that is what goes in.
  it('keys on what the balloon callback IS, not on the closure', () => {
    const box = { x: 0, y: 0, w: 200, h: 120, fit: { kind: 'ellipse', cx: 100, cy: 60, rx: 100, ry: 60 } };
    const wider = { ...box, fit: { kind: 'ellipse', cx: 100, cy: 60, rx: 140, ry: 60 } };
    const s = { ...style };
    const first = layoutLines(text, s, 20, 196, balloonWidthsFor(box, s, 20));
    const again = layoutLines(text, s, 20, 196, balloonWidthsFor({ ...box }, s, 20));
    expect(again).toBe(first);
    expect(layoutLines(text, s, 20, 196, balloonWidthsFor(wider, s, 20))).not.toBe(first);
  });

  // A `widthsFor` this module did not build says nothing about what it will
  // return, so it is not cached at all rather than cached wrongly.
  it('refuses to cache a widths callback it did not write', () => {
    const flat = () => [100];
    const first = layoutLines(text, { ...style }, 20, 200, flat);
    expect(layoutLines(text, { ...style }, 20, 200, flat)).not.toBe(first);
    expect(layoutMemoSize()).toBe(0);
  });

  // A cache with no bound is a leak with a lookup table in front of it. The
  // oldest key goes; the newest is still there.
  it('is bounded, and drops the least recently used', () => {
    for (let i = 0; i < 520; i++) layoutLines(`${text} ${i}`, { ...style }, 20, 200);
    expect(layoutMemoSize()).toBe(500);
    const oldest = layoutLines(`${text} 0`, { ...style }, 20, 200);
    expect(layoutLines(`${text} 519`, { ...style }, 20, 200)).toBe(
      layoutLines(`${text} 519`, { ...style }, 20, 200),
    );
    // Broken afresh, which is what "evicted" means from out here.
    expect(layoutLines(`${text} 0`, { ...style }, 20, 200)).toBe(oldest);
  });

  // The two events that make every entry an answer about a different font or a
  // different engine. Neither is visible in any argument, which is why the map
  // goes wholesale rather than key by key.
  it('is emptied by the typesetting switch and by a font arriving', () => {
    layoutLines(text, { ...style }, 20, 200);
    expect(layoutMemoSize()).toBe(1);
    setTypesetEnabled(false);
    expect(layoutMemoSize()).toBe(0);
    setTypesetEnabled(true);
    const before = layoutLines(text, { ...style }, 20, 200);
    clearLayoutMemo();
    expect(layoutMemoSize()).toBe(0);
    expect(layoutLines(text, { ...style }, 20, 200)).not.toBe(before);
  });

  // The point of all of it: the memo must not change a single break. Every
  // answer it hands back is the answer the breaker would have given.
  it('changes no break it remembers', () => {
    const cases = [
      ['', 200],
      ['ONE', 200],
      ['\n\nHELLO\n\n', 400],
      ['ONE\n\nTWO', 400],
      [text, 120],
      [text, 1000],
    ];
    for (const [t, w] of cases) {
      const memoised = layoutLines(t, { ...style }, 20, w);
      clearLayoutMemo();
      expect(layoutLines(t, { ...style }, 20, w)).toEqual(memoised);
    }
  });
});

// A Return pressed above or below the words is not a line: it moved the block,
// grew the box under auto-height and shifted the export, and no editor showed
// the user what they had done. Trimmed in the one function every layout path
// asks, so the fix reaches all of them at once.
describe('blank lines at the edges of a block', () => {
  const style = { font: 'Comic Neue', size: 20, bold: false, italic: false, lineHeight: 1.1, letterSpacing: 0, align: 'center', uppercase: false, shape: 'off' };
  const lines = (t) => layoutLines(t, { ...style }, 20, 400);

  it('drops the ones above and below the text', () => {
    expect(lines('\n\nHELLO\n\n')).toEqual(['HELLO']);
    expect(lines('   \nHELLO')).toEqual(['HELLO']);
    expect(lines('HELLO\n \t ')).toEqual(['HELLO']);
  });

  it('keeps the ones between paragraphs - that is what they are for', () => {
    expect(lines('ONE\n\nTWO')).toEqual(['ONE', '', 'TWO']);
  });

  it('still answers one empty line for an empty box', () => {
    expect(lines('')).toEqual(['']);
    expect(lines('\n\n')).toEqual(['']);
  });
});

describe('measure.js robustness and trailing whitespace', () => {
  it('guards arcLayout against size 0, missing letterSpacing, and missing/NaN curve without emitting NaN', () => {
    expect(arcLayout('hello', { size: 0, letterSpacing: 0, curve: 50 }, 20)).toEqual([]);
    expect(arcLayout('hello', { size: 20, letterSpacing: 0, curve: 50 }, 0)).toEqual([]);
    const layout = arcLayout('hello', { size: 20, letterSpacing: undefined, curve: 50 }, 20);
    expect(layout.length).toBe(5);
    for (const ch of layout) {
      expect(Number.isFinite(ch.x)).toBe(true);
      expect(Number.isFinite(ch.y)).toBe(true);
      expect(Number.isFinite(ch.rot)).toBe(true);
      expect(Number.isFinite(ch.w)).toBe(true);
    }
    for (const badCurve of [undefined, NaN, null]) {
      const flat = arcLayout('hello', { size: 20, letterSpacing: 0, curve: badCurve }, 20);
      expect(flat.length).toBe(5);
      for (const ch of flat) {
        expect(Number.isFinite(ch.x)).toBe(true);
        expect(Number.isFinite(ch.y)).toBe(true);
        expect(Number.isFinite(ch.rot)).toBe(true);
        expect(Number.isFinite(ch.w)).toBe(true);
      }
    }
  });

  it('guards lineWidth against zero size and missing letterSpacing', () => {
    expect(lineWidth('hello', { size: 0, letterSpacing: undefined }, 20)).toBeGreaterThan(0);
    expect(lineWidth('hello', { size: 20, letterSpacing: undefined }, 20)).toBeGreaterThan(0);
    expect(lineWidth('hello', { size: 20, letterSpacing: 0 }, 0)).toBe(0);
  });

  it('strips trailing whitespace on wrapLines terminal lines to match wrapLinesDOM', () => {
    const wrapped = wrapLines('hello world   ', { font: 'Comic Neue', size: 20, letterSpacing: 0 }, 20, 200);
    expect(wrapped).toEqual(['hello world']);
    const multiline = wrapLines('line 1   \nline 2   ', { font: 'Comic Neue', size: 20, letterSpacing: 0 }, 20, 200);
    expect(multiline).toEqual(['line 1', 'line 2']);
  });

  it('wrapLinesDOM handles leading whitespace on wrapped lines and surrogate pairs', () => {
    const originalDoc = globalThis.document;
    try {
      const createdDiv = {
        style: {},
        textContent: '',
        firstChild: { length: 0 },
        remove: () => {},
      };
      globalThis.document = {
        createElement: () => createdDiv,
        body: { appendChild: () => {} },
        createRange: () => {
          let startOffset = 0;
          return {
            setStart: (_, s) => { startOffset = s; },
            setEnd: () => {},
            getClientRects: () => {
              const top = startOffset >= 6 ? 20 : 0;
              return [{ top }];
            },
          };
        },
      };
      const res = wrapLinesDOM('hello world', { font: 'Comic Neue', size: 20, letterSpacing: 0 }, 20, 100);
      expect(res).toEqual(['hello', 'world']);

      const emojiStarts = [];
      globalThis.document.createRange = () => ({
        setStart: (_, s) => { emojiStarts.push(s); },
        setEnd: () => {},
        getClientRects: () => [{ top: 0 }],
      });
      wrapLinesDOM('A😀B', { font: 'Comic Neue', size: 20, letterSpacing: 0 }, 20, 100);
      expect(emojiStarts).toEqual([0, 1, 3]);
    } finally {
      globalThis.document = originalDoc;
    }
  });
});

// ===== auto-height =====

describe('neededHeight', () => {
  it('is the block plus the padding the box lays out inside', () => {
    expect(neededHeight(3, { size: 20, lineHeight: 1.1 }, 2)).toBe(Math.ceil(3 * 22) + 4);
  });

  it('ceils, so a box never lands a sub-pixel short of its own text', () => {
    expect(neededHeight(3, { size: 10, lineHeight: 1.13 }, 0)).toBe(34);
  });

  // A style with no line height is a style with a default, not an error - the
  // same `?? 1` `layoutLines` and `balancedBoxSize` already apply, because three
  // places asking one style the same question have to answer it the same way.
  // Left unguarded this multiplied by `undefined` and returned NaN, and NaN is
  // the one bad answer that gets past a caller: `bal?.h ?? 92` in placement is a
  // null check, not a number check, so the box was placed with a NaN height.
  it('defaults a missing line height to 1 rather than returning NaN', () => {
    expect(neededHeight(3, { size: 20 }, 2)).toBe(64);
    for (const bad of [null, undefined, 0, -1, 'tall', NaN]) {
      expect(neededHeight(3, { size: 20, lineHeight: bad }, 2)).toBe(64);
    }
  });

  it('is always a finite number, whatever it is handed', () => {
    for (const [n, style] of [
      [3, null],
      [3, {}],
      [3, { size: 'big', lineHeight: 1.1 }],
      [NaN, { size: 20, lineHeight: 1.1 }],
      [undefined, { size: 20, lineHeight: 1.1 }],
      [-2, { size: 20, lineHeight: 1.1 }],
    ]) {
      // The padding alone: a box a user can see and drag, rather than a
      // rectangle nothing can lay out in and nothing downstream can catch.
      expect(neededHeight(n, style, 2)).toBe(4);
    }
  });
});

describe('growToFit', () => {
  it('grows downward from a top-aligned box', () => {
    expect(growToFit({ y: 100, h: 50, valign: 'top' }, 90, 1000)).toEqual({ y: 100, h: 90 });
  });

  it('grows upward from a bottom-aligned box', () => {
    expect(growToFit({ y: 100, h: 50, valign: 'bottom' }, 90, 1000)).toEqual({ y: 60, h: 90 });
  });

  it('opens equally in both directions when the text is centred', () => {
    // The block stays centred on the bubble the user aimed at, which is the
    // whole reason the anchor follows `valign` rather than being fixed.
    const before = { y: 100, h: 50, valign: 'middle' };
    const after = growToFit(before, 90, 1000);
    expect(after).toEqual({ y: 80, h: 90 });
    expect(after.y + after.h / 2).toBe(before.y + before.h / 2);
  });

  it('never shrinks a box the user sized by hand', () => {
    for (const valign of ['top', 'middle', 'bottom']) {
      expect(growToFit({ y: 100, h: 200, valign }, 40, 1000)).toEqual({ y: 100, h: 200 });
    }
    expect(growToFit({ y: 100, h: 200, valign: 'middle' }, 200, 1000)).toEqual({ y: 100, h: 200 });
  });

  it('is capped at the page and clamped inside it', () => {
    expect(growToFit({ y: 10, h: 50, valign: 'top' }, 5000, 1200)).toEqual({ y: 0, h: 1200 });
    // Growing upward off the top edge is pulled back onto the page.
    expect(growToFit({ y: 20, h: 40, valign: 'bottom' }, 200, 1200)).toEqual({ y: 0, h: 200 });
    // And downward off the bottom edge.
    expect(growToFit({ y: 1100, h: 40, valign: 'top' }, 200, 1200)).toEqual({ y: 1000, h: 200 });
  });

  it('does not clamp against a page nobody has measured', () => {
    // `p.w`/`p.h` are 0 until something decodes the image. Clamping against a
    // zero would drag every box on an unvisited page to the origin.
    expect(growToFit({ y: 300, h: 40, valign: 'top' }, 200, 0)).toEqual({ y: 300, h: 200 });
  });

  it('is idempotent, so re-running it can never ratchet', () => {
    const once = growToFit({ y: 100, h: 50, valign: 'middle' }, 90, 1000);
    expect(growToFit({ ...once, valign: 'middle' }, 90, 1000)).toEqual(once);
  });
});

// ===========================================================================
// auto-WIDTH: the shape a placed box aims for
// ===========================================================================
// The bug this answers: a box placed with nothing known about what is under it
// got a fixed width, the height then followed the text, and only the height - so
// a long line came out as a tall narrow column. The width has to be chosen from
// the same measurement as the height or the two do not describe a shape.
describe('balancedBlockSize', () => {
  const A = (r) => r.w / r.h;

  it('lands the block near the target aspect', () => {
    // 1200 units of text at a 30-unit line height: five lines of ~254 is the
    // closest a whole number of lines gets to 1.6.
    const r = balancedBlockSize(1200, 30);
    expect(r.lines).toBe(5);
    expect(A(r)).toBeGreaterThan(1.2);
    expect(A(r)).toBeLessThan(2);
  });

  it('stays near the target across three orders of magnitude of text', () => {
    for (const total of [200, 600, 1800, 5400, 16200]) {
      const r = balancedBlockSize(total, 30);
      // Never a column. That is the whole point: the failure being fixed is a
      // block many times taller than it is wide.
      expect(A(r)).toBeGreaterThan(1);
    }
  });

  it('is wider than tall - a balloon is an oval on its side', () => {
    expect(A(balancedBlockSize(1200, 30))).toBeGreaterThan(1);
  });

  it('honours a target aspect the caller asks for', () => {
    const wide = balancedBlockSize(1200, 30, { targetAspect: 4 });
    const square = balancedBlockSize(1200, 30, { targetAspect: 1 });
    expect(wide.w).toBeGreaterThan(square.w);
    expect(wide.lines).toBeLessThan(square.lines);
  });

  it('grows the width with the text rather than the line count alone', () => {
    const small = balancedBlockSize(400, 30);
    const big = balancedBlockSize(4000, 30);
    expect(big.w).toBeGreaterThan(small.w);
    expect(big.lines).toBeGreaterThan(small.lines);
  });

  it('gives a short phrase one line', () => {
    const r = balancedBlockSize(60, 30);
    expect(r.lines).toBe(1);
    expect(r.h).toBe(30);
  });

  it('caps the line count, so a caption is not a hundred-line ribbon', () => {
    const r = balancedBlockSize(1e6, 30, { maxLines: 8 });
    expect(r.lines).toBe(8);
  });

  it('never returns a width below the floor placement enforces', () => {
    expect(balancedBlockSize(1, 30).w).toBe(BALANCED_DEFAULTS.minWidth);
  });

  it('leaves the breaker headroom, so the width really does give that many lines', () => {
    const r = balancedBlockSize(1200, 30);
    expect(r.w).toBeGreaterThan(1200 / r.lines);
  });

  it('answers null rather than a fabricated rectangle on nothing', () => {
    expect(balancedBlockSize(0, 30)).toBeNull();
    expect(balancedBlockSize(1200, 0)).toBeNull();
    expect(balancedBlockSize(NaN, 30)).toBeNull();
    expect(balancedBlockSize(undefined, undefined)).toBeNull();
  });

  it('is deterministic, so the same text places at the same size twice', () => {
    expect(balancedBlockSize(1234, 33)).toEqual(balancedBlockSize(1234, 33));
  });
});
