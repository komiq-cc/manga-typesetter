// ===== Scanlation line breaking =====
//
// Plain CSS wrapping is greedy: it fills each line to the brim and drops
// whatever is left onto the last one. That is the right answer for a paragraph
// of prose in a column and the wrong one for a speech bubble, where the block of
// text is a shape the reader sees before they read a word of it. Letterers have
// rules about that shape, and they are the rules this module implements:
//
//   · the block reads as a square [] or a beehive/oval () - line widths roughly
//     equal, or narrow→wide→narrow. An hourglass )( - wide→narrow→wide - is the
//     one profile that is always wrong, because the pinched middle reads as a
//     gap in the text.
//   · a word of fewer than three letters never sits alone on a line.
//   · a long word that does not fit is carried whole to the next line, and is
//     split with a hyphen only when nothing else will do. See the hyphenation
//     section below for exactly when that is.
//
// Nothing here measures anything itself. `measureFn(str) -> number` is injected,
// which is what keeps the module pure, testable under node with a stand-in
// metric, and - more importantly - keeps `measure.js` the single owner of real
// text metrics. Two modules that both knew how to measure a string would be two
// modules that could disagree about where a line breaks, and the editor and the
// exporter would then draw different pictures of the same box.
//
// The user's text is never mutated. Every line handed back is a *slice* of the
// input, so interior spacing survives exactly as typed and `box.text` is
// untouched - the breaks are display and layout only. The single character this
// module is ever allowed to add is the hyphen at the end of a split line, and it
// exists only in the string that gets drawn.
//
// ===== the width is a shape, not a number =====
//
// The second argument used to be one scalar, which meant every line got the same
// allowance. That is right for a rectangular narration box and wrong for the
// oval balloons most dialogue sits in: inside an ellipse the usable width is
// narrow at the top and the bottom and widest across the middle, so a block that
// satisfies a scalar width still runs into the curve on its first and last
// lines. It may now instead be a callback, `widthsFor(lineCount) -> number[]`,
// which hands back the usable width of each line of a block of that many lines.
// A scalar still means "the same width for every line", so every existing caller
// is unchanged.
//
// The reason this is more than a parameter swap is that the widths depend on the
// line count, so each candidate line count in the search below has its own array
// of them, and every term in the cost function that used to divide by one W now
// divides by that line's own allowance. That single change is what keeps the
// shape rules meaning what they say: a line's *fill ratio* - how full it is
// relative to the room it was given - is the quantity all three shape terms were
// always really about. An ellipse's first line is physically narrow, but filled
// to the brim of its own narrow allowance its ratio is 1.0 like everyone else's,
// so raggedness sees no deviation, the pinch term sees no shortfall, and the
// hourglass term sees no dip. The naturally-narrow ends of an oval are not a
// defect and are not scored as one. What the hourglass term now catches is the
// genuine article: a middle line that is *emptier than its own room* while the
// ends are full, which is exactly the gap a reader notices, and it catches it
// even when that middle line is physically the widest one on the page.
//
// ===== which silhouette =====
//
// Filled to its own rows, a block takes the silhouette of whatever it is set
// in: even in a rectangle, oval in an oval balloon. That is `shape: 'auto'`,
// and it is everything the section above describes. `shape: 'oval'` and
// `'rect'` ask for one silhouette whatever the balloon does. That is a
// preference and never a constraint: the shape terms measure each line against
// the width it is MEANT to have (`preferredOf`), while whether a line fits and
// what hanging out costs still measure against the width it HAS, so no
// preference can put ink past an edge. And it is priced like the hourglass, at
// no more than a line (`bestAt`): keeping to a silhouette may make a block cost
// at most one line more than the ordinary block, so a preference reshapes a
// block and does not stack it into a column to be an oval.
//
// ===== hyphenation =====
//
// Real scanlation splits a word rather than let a name hang out of a tall narrow
// balloon, and this module used to refuse to, so the word simply overflowed. It
// will now split one, under a rule deliberately narrow enough that ordinary text
// never meets it:
//
//   · a word is offered break points at all only if it does not fit on the
//     WIDEST line any candidate breaking could give it. That is the literal
//     reading of "it genuinely does not fit": if there is a line in this balloon
//     the word fits on, the search can put it there, and no hyphen is needed.
//     A word that fits somewhere is never carved up to tidy the block.
//   · having been offered them, a hyphen still has to win on price. `hyphen` is
//     large next to the raggedness scale, so the split has to be paid for by a
//     real defect elsewhere - and the defect it is there to pay for is
//     `overflow`, the new cost of a line hanging over the edge of its balloon.
//     Because that cost is quadratic, a word a hair too wide keeps its overflow
//     and a word half again too wide gets the hyphen.
//   · at least `minHyphenHead` letters before the hyphen and `minHyphenTail`
//     after it, counted in letters rather than characters, so a trailing "!"
//     cannot pass a stub off as a syllable. The tail rule is also the anti-stub
//     rule for the end of a paragraph: the last word's tail IS the last line.
//   · a word that already contains a hyphen breaks at that hyphen by preference
//     (`existingHyphen` is a fraction of `hyphen`), and when it does, nothing is
//     inserted - the line already ends in one, and a second would be an error.
//   · two hyphenated lines in a row cost `hyphenPair` on top of everything else,
//     so it happens only where there is no alternative. That rule is decomposable
//     and lives inside the dynamic program, because "the previous line ended in a
//     hyphen" is the same statement as "this line starts in the middle of a
//     word", which is a property of the break point this line starts at.
//
// The syllable points come from Liang's algorithm over the real TeX en-US
// pattern set (`hypher` + `hyphenation.en-us`). Its own leftmin/rightmin are 2
// and 3, the usual scanlation minimums, and this module re-checks both in
// letters afterwards rather than trusting them. Patterns are only consulted for
// a run of plain A-Z; anything else - a word with an apostrophe in the middle,
// an accented spelling, Cyrillic, kana, an SFX like "KRRSHH!!" - is left whole,
// because a wrong hyphenation is worse than none and en-US patterns have nothing
// true to say about any of those.

import Hypher from 'hypher';
import enUsPatterns from 'hyphenation.en-us';

// The knobs, and what each one is actually trading off.
//
// `ragged` and `lineCost` are the pair that decides how many lines the block
// gets: raggedness is measured against the candidate's own target fill ratio, so
// it is near zero for any line count that can be balanced, and `lineCost` is
// what then picks the fewest of those. Raising `lineCost` makes the algorithm
// accept a ragged two-line block rather than a tidy three-line one; lowering it
// does the reverse. The profile gets a say as well, but a bounded one - see
// `hourglass`.
//
// The hourglass rule is enforced twice, and the split is the interesting part.
//
// `pinch` is the cheap half: a per-line cost on an INTERIOR line that falls
// short of the target. It is decomposable, so it lives inside the dynamic
// program and steers the break points while the DP still returns the true
// optimum for the line count. A short line has to go somewhere, and this is what
// puts it at the end rather than in the middle.
//
// `hourglass` is the half that judges the finished profile, which no per-line
// cost can see. It cannot go inside the DP, so it is applied where a profile
// exists, and it is priced differently in the two places that is.
//
// Within one line count it is a repair. Two *complete* breakings of that count
// are compared - one from the ordinary search and one from a search that leans
// on interior shortfalls hard enough to break the pinch (`pinchHard`) - under
// the ordinary weights plus the profile at this full weight. Both have the same
// number of lines, so no weight can make the comparison buy one, and the weight
// is free to be as big as it takes for a visible dip to outweigh the raggedness
// a repair brings with it. The heavier search is only ever a generator of
// candidates, never a scorer.
//
// Across line counts it is a price, and a capped one: the profile adds at most
// `lineCost`, the price of one line, to what a count's best breaking costs. So a
// block whose every breaking at its cheapest count is pinched moves to the next
// count when that count is balanced to within a line's price, and no pinch can
// buy more than that. Both ends of the cap were measured, on 7228 breakings (the
// text of 1127 real boxes at 0.7, 1 and 1.4 times the box width and in the 233
// fitted ellipses, under the stand-in metric and Comic Neue), counting a block
// as pinched when its deepest notch passes the deadband:
//
//   the term off entirely                        1677 pinched
//   the repair only, the count chosen without it 1585 pinched
//   the repair, and the count at a line's price  1537 pinched, lines +0.23%
//   the repair, and the count at the full weight 1405 pinched, lines +1.66%
//
// The full weight is the failure the old design was written to avoid: priced
// like that, the profile outbids any number of lines, and blocks grew by as many
// as five to dodge a dip, 660 more one-word lines among them. At a line's price
// the count moves for 77 blocks: 50 lose their pinch and 2 gain one. Against
// the code before it - the previous measure, repair only, 1644 pinched - 108
// blocks are repaired, 1 is newly pinched (0.009 past the deadband), and
// overflowing lines fall from 1533 to 1520. The cap is `lineCost` rather than a
// knob of its own because "a pinch is worth at most a line" is the whole of the
// rule, and a second number would be a second way to say it.
//
// `orphanCost` is the other constraint-as-cost. See the two passes at the bottom
// of `breakParagraph` for why the rule has to be relaxable at all.
export const TYPESET_DEFAULTS = {
  minOrphan: 3, // a word with fewer letters than this may not sit alone on a line
  maxLines: 32, // candidate line counts above this are not enumerated
  maxWords: 150, // beyond this the DP is skipped and greedy wrapping is used
  ragged: 1, // weight on each line's squared deviation from the target fill ratio
  lastShort: 0.6, // extra weight when the FINAL line is the short one
  pinch: 3, // weight on an INTERIOR line falling short of the target
  pinchHard: 40, // the same weight, for the second search that tries to un-pinch
  orphanCost: 50, // flat cost of a line the orphan rule refuses, in the relaxed pass
  hourglass: 300, // penalty on a notched block; capped at `lineCost` across counts
  hourglassTol: 0.12, // dip below which a profile is not called an hourglass
  lineCost: 0.12, // mild preference for fewer lines
  shape: 'auto', // the silhouette the block aims for: 'auto', 'oval' or 'rect' - see `preferredOf`

  // Overflow. A line wider than its own allowance hangs over the edge of the
  // balloon, which before this pass was something the module could notice and do
  // nothing about - an over-long word had to go somewhere and every breaking put
  // it in the same place, so pricing it would have been pricing a constant. It
  // is only now, with a hyphen on the table, that there are two different
  // answers to compare, and the term exists to make the comparison. Quadratic in
  // the fraction of the allowance exceeded, so a hair over is nearly free and
  // a lot over is not.
  //
  // Under a constant width this term is a constant: a line may only exceed its
  // width if it is a single unbreakable token (see `fits`), every breaking must
  // therefore give each over-long word a line of its own, and every breaking
  // consequently pays exactly the same total. A constant cannot move an argmin.
  // Under per-line widths it stops being constant, which is the point: it is
  // what steers an over-long word onto the widest line of an oval.
  //
  // "A constant cannot move an argmin" is true in arithmetic and one bit short
  // of true in float64, and the corpus says exactly how short. Over 54,000
  // breakings (3000 strings x 9 widths x 2 metrics), turning this term on with
  // hyphenation off changes 30 of them - 0.056% - and every one of the 30 is a
  // pair of breakings that cost the SAME. Twenty-nine have the identical
  // multiset of line widths; the thirtieth, `ANTIDISESTABLISHMENTARIANISM ...`
  // at width 22, is 0.45836776859504130 against 0.45836776859504136, a gap of
  // one unit in the last place. Carrying a constant of ~4 through four
  // additions costs about three ULPs of the running total, which is more than
  // that gap, so the tie lands on the other side. Which of two identically
  // priced breakings won was never a decision this module made - it was the
  // order the same numbers happened to be added in - and it is not one worth
  // buying back with a tolerance on the DP's comparison: a relative epsilon of
  // 1e-9 there does pin the ties down, and moves 96 other outputs while doing
  // it, which is a worse trade than the 30.
  overflow: 60,

  // Hyphenation. `hyphen` is set well above the raggedness scale - a per-line
  // deviation cost is (r - T)^2 with both around 1, so a whole point is already
  // an enormous defect - which is what makes a split a last resort rather than a
  // habit. `existingHyphen` is the price of breaking at a hyphen the user
  // already typed: not free, because it is still a word coming apart across two
  // lines, but a small fraction of the cost of inventing one.
  hyphen: 2,
  existingHyphen: 0.25,
  hyphenPair: 8, // two hyphenated lines in a row, on top of both their own costs
  lastWordHyphen: 1.5, // extra, for a split in the paragraph's final word
  minHyphenHead: 2, // letters that must remain before the hyphen
  minHyphenTail: 3, // letters that must remain after it
  maxHyphenPoints: 48, // a paragraph offering more than this is not hyphenated at all
  hyphenate: true, // the whole feature, off in one place
};

// A hair of slack on the fit test. Widths come back from a canvas as floats and
// a line that measures 0.0001px over the box is not an overflow the user could
// ever see - refusing it would push a word onto the next line for nothing.
const FIT_EPS = 0.5;

// "Letters" rather than characters, so `it.` counts as two and is still an
// orphan, while `...` counts as none and is never left alone either. Unicode
// classes because the app is used on translations, not on ASCII.
function letterCount(word) {
  const m = word.match(/[\p{L}\p{N}]/gu);
  return m ? m.length : 0;
}

// Hangul syllables and jamo.
const HANGUL_CHARS = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]|\p{Script=Hangul}/u;
export function hasHangul(word) {
  return typeof word === 'string' && HANGUL_CHARS.test(word);
}

// ===== break points inside a word =====

// What kind of break a position is. A line that ends at a HY_NONE position ends
// at a space, which is the only kind this module used to have; the other two end
// in the middle of a word and differ only in whether the hyphen has to be drawn
// or was already typed.
const HY_NONE = 0;
const HY_ADDED = 1;
const HY_EXISTING = 2;

// U+002D and U+2010 only. An en or em dash is a punctuation mark rather than a
// word-joining hyphen, and breaking a line after one is a different typographic
// decision than the one this module is making.
const HYPHEN_CHARS = /[-‐]/;

// Y is in there because English syllables like RHYTHM and MYTH have nothing
// else, and the only question this is ever asked is "could that piece be
// pronounced". See the vowel rule in `hyphenPointsFor`.
const VOWEL = /[AEIOUYaeiouy]/;

// Built once, lazily: assembling the pattern trie is real work and a document
// with no over-long word in it never needs one.
let _hypher = null;
function hyphenator() {
  if (_hypher === null) _hypher = new Hypher(enUsPatterns);
  return _hypher;
}

// Liang's points inside one hyphen-free chunk of a word, as offsets into it.
//
// The regexp is the conservatism, and it is deliberately blunt: the chunk has to
// be leading punctuation, then a run of plain A-Z, then trailing punctuation,
// and nothing else. That admits `MURAMATA`, `SAN!` and `"WONDERFUL`, and refuses
// `DON'T`, `CAFÉ`, `MP3`, `КОНЕЦ`, `ドン` and `KRRSHH!!` - every one of which is a
// string the en-US pattern set has nothing true to say about. Refusing is the
// right failure here: `MURAMA-TASAN` is a typesetting error a reader notices,
// and a word left whole is only a word left whole.
// Keyed on the chunk, not on the word, so `MURAMATA` is looked up once however
// many balloons the name appears in. Dropped wholesale rather than evicted one
// at a time if a document ever manages to fill it: this is a cache of a pure
// function, so the only thing losing it costs is the trie walk.
const _splitCache = new Map();
function segmentSplits(seg) {
  let cached = _splitCache.get(seg);
  if (cached !== undefined) return cached;
  if (_splitCache.size > 4000) _splitCache.clear();
  cached = [];
  if (hasHangul(seg)) {
    _splitCache.set(seg, cached);
    return cached;
  }
  const m = /^([^A-Za-z]*)([A-Za-z]+)([^A-Za-z]*)$/.exec(seg);
  // Four characters is the shortest word Liang's minimums (2 + 3) could ever
  // split, so anything shorter is not worth waking the trie for.
  if (m && m[2].length >= 4) {
    const lead = m[1].length;
    const frags = hyphenator().hyphenate(m[2]);
    let cum = 0;
    for (let i = 0; i < frags.length - 1; i++) {
      cum += frags[i].length;
      cached.push(lead + cum);
    }
  }
  _splitCache.set(seg, cached);
  return cached;
}

// Every place one word may be broken, as `{ rel, hy }` with `rel` an offset into
// the word, ascending.
//
// A hyphen the user typed is a break point in its own right, and it also cuts
// the word into chunks that are hyphenated independently - running the pattern
// trie across a hyphen would be asking en-US about a string that is not an
// English word. That is what turns `MURAMATA-SAN!` into the three-line block the
// reference image wants: the typed hyphen offers `MURAMATA-|SAN!`, and the
// chunks offer `MU|RAMATA` and `MURA|MATA` from the patterns, so `MURA-` /
// `MATA-` / `SAN!` is reachable and `MURAMA-TASAN` is not.
function hyphenPointsFor(word, o) {
  const raw = [];
  const chunkStarts = [0];
  for (let i = 0; i < word.length; i++) {
    // A trailing hyphen is not a break point: there is nothing after it.
    if (HYPHEN_CHARS.test(word[i]) && i + 1 < word.length) {
      raw.push({ rel: i + 1, hy: HY_EXISTING });
      chunkStarts.push(i + 1);
    }
  }
  for (let c = 0; c < chunkStarts.length; c++) {
    const from = chunkStarts[c];
    // The chunk stops one short of the next chunk's start, which is the hyphen.
    const to = c + 1 < chunkStarts.length ? chunkStarts[c + 1] - 1 : word.length;
    for (const off of segmentSplits(word.slice(from, to))) {
      raw.push({ rel: from + off, hy: HY_ADDED });
    }
  }
  raw.sort((a, b) => a.rel - b.rel || b.hy - a.hy);

  // The minimums, re-checked here in letters rather than characters. `hypher`
  // enforces 2 and 3 itself but counts characters, so it would happily leave
  // `S!!` as a three-character tail; counting the way the orphan rule counts
  // means punctuation cannot dress a stub up as a syllable. Measured over the
  // whole word rather than the chunk, so a break inside `MURAMATA-SAN!` is
  // judged on what actually lands on each of the two lines.
  //
  // And then the vowel rule, which is the one that keeps sound effects out of
  // this. `KRRSHHHHHHHHHH` is all A-Z, so the regexp above lets it through, and
  // the en-US patterns - which have never met it - cheerfully offer `KRRSH|HHHH`
  // and `KRRSHHHHH|HHHHH`, giving `KRRSH-` / `HHHH-` / `HHHHH`. Neither piece is
  // a syllable, and the tell is that neither piece can be pronounced: a syllable
  // has a vowel in it. So an INVENTED hyphen has to leave a vowel on both sides.
  // A hyphen the user typed is exempt, because a break the author chose is not
  // this module's to second-guess.
  const out = [];
  for (const p of raw) {
    if (out.length && out[out.length - 1].rel === p.rel) continue;
    const head = word.slice(0, p.rel);
    const tail = word.slice(p.rel);
    if (letterCount(head) < o.minHyphenHead) continue;
    if (letterCount(tail) < o.minHyphenTail) continue;
    if (p.hy === HY_ADDED && !(VOWEL.test(head) && VOWEL.test(tail))) continue;
    // And the same minimum between two adjacent points, so a word broken twice
    // cannot strand a single letter between the two hyphens. Keeping the first
    // of a pair that is too close together is arbitrary but deterministic, and
    // it is what makes the guarantee statable without qualification: every
    // fragment this module can put on a line has at least `minHyphenHead`
    // letters in it, and the one that ends the word has `minHyphenTail`.
    if (out.length && letterCount(word.slice(out[out.length - 1].rel, p.rel)) < o.minHyphenHead) {
      continue;
    }
    out.push(p);
  }
  return out;
}

// The one shape rule that cannot be expressed as a per-line cost: it is about
// the profile as a whole. An hourglass is a line narrower than something above
// it AND something below it, so the measure is the deepest notch: for each
// interior line, the fuller of the lines above it and the fuller of the lines
// below it, the lesser of those two, minus the line itself. It is only ever
// positive for a genuine pinch. A block whose last line is short - the ordinary,
// desirable case - has nothing full below its short line and scores zero here,
// which is the point: this must not become a tax on normal text. Nor does an
// oval, whose every line is at least as full as everything on one side of it.
//
// It used to be `min(first, last) - min(interior)`, which says the same thing
// about a three-line block and can be talked out of it by any longer one: make
// the FIRST line short and `min(first, last)` is short too, and a notch two
// lines further down stops counting. Inside one line count that loophole cost
// the search a ragged block to use, so it was rarely taken. Once the line count
// is chosen on this term as well (see `hourglass`), another count is a cheap
// way to shorten the first line - `Does / that / mean our / lectures / are /
// ending?!` was the answer to a pinch at `are`, with the pinch still in it.
//
// The inputs are fill ratios, each line's ink over that line's own allowance,
// which is what makes the rule survive a width that varies down the block. In an
// oval the first and last lines are physically the shortest strings in the
// block and are not a dip, because they are as full as the room they were given;
// what is a dip is a middle line loafing in the widest part of the balloon.
function hourglassPenalty(ratios, weight, tol) {
  const L = ratios.length;
  if (L < 3) return 0;
  const above = new Array(L);
  let full = -Infinity;
  for (let i = 0; i < L; i++) {
    above[i] = full;
    full = Math.max(full, ratios[i]);
  }
  let below = -Infinity;
  let notch = -Infinity;
  for (let i = L - 1; i > 0; i--) {
    if (i < L - 1) notch = Math.max(notch, Math.min(above[i], below) - ratios[i]);
    below = Math.max(below, ratios[i]);
  }
  const dip = notch - tol;
  return dip > 0 ? weight * dip * dip : 0;
}

// The oval a block of `n` lines aims for when it is asked to be one: each line's
// share of the widest, read off a curve through the line centres, with the first
// and last line at `u = -1` and `1`. The curve is the one that gives
// 62/86/100/86/62 at five lines, the review's starting point, and it is the
// curve the lettering benchmark scores `ovalScore` against, so the preference
// and the measurement cannot drift apart. A starting point to tune on real
// pages, not a rule.
function ovalProfile(n) {
  if (n === 1) return [1];
  return Array.from({ length: n }, (_, i) => {
    const u = (2 * i) / (n - 1) - 1;
    return 1 - 0.62 * u * u + 0.24 * u ** 4;
  });
}

// The width argument, normalised to one shape: a function from a line count to
// an array of that many positive widths. A scalar becomes a constant array,
// which is what makes every pre-existing call site mean exactly what it meant
// before. A callback that hands back a short array, a hole, or a nonsense number
// has that line fall back to the previous line's width - defensive rather than
// meaningful, but a NaN loose in the cost function would poison a whole block
// silently and this at least keeps the failure local.
function widthsResolver(spec) {
  if (typeof spec === 'function') {
    return (L) => {
      const raw = spec(L);
      const ok = (v) => Number.isFinite(v) && v > 0;
      // Seeded from the first usable entry rather than from 1, so a hole at the
      // top of the array is filled with a width from the same balloon instead of
      // with a number that would make every line overflow.
      let last = 1;
      if (Array.isArray(raw)) for (const v of raw) if (ok(Number(v))) { last = Number(v); break; }
      const out = new Array(L);
      for (let k = 0; k < L; k++) {
        const v = Array.isArray(raw) ? Number(raw[k]) : NaN;
        out[k] = ok(v) ? v : last;
        last = out[k];
      }
      return out;
    };
  }
  const w = Number(spec) > 0 ? Number(spec) : 1;
  return (L) => new Array(L).fill(w);
}

// The widths of a paragraph's lines, by where each starts and ends in it (see
// `spanWidth` in `breakParagraph`), kept from one call to the next. The solver
// breaks one text at several widths and sizes in a row, and again on the next
// keystroke, and every layout asks about the same lines; building each line's
// string and looking it up again every time was a third of a solve.
//
// Only for a measure that says a string always measures the same
// (`measureFn.stable` - measure.js's, which is dropped whenever a face changes).
// Kept for the paragraph it was last asked about, and carried to the next one
// when that one only adds to its end - which is what typing does: a line that
// ends inside the old paragraph is the same string in the new one. Any other
// change starts afresh, as does a paragraph too long for the key (SPAN_STRIDE)
// or a store grown past SPANS_MAX.
const SPAN_STRIDE = 16384;
const SPANS_MAX = 20000;
const keptSpans = new WeakMap(); // measureFn -> { para, widths }
function spansFor(measureFn, para) {
  if (!measureFn?.stable || para.length >= SPAN_STRIDE) return new Map();
  let k = keptSpans.get(measureFn);
  if (!k || !para.startsWith(k.para) || k.widths.size > SPANS_MAX) {
    k = { para, widths: new Map() };
    keptSpans.set(measureFn, k);
  }
  k.para = para;
  return k.widths;
}

// How many positions apart two ends of a line may be and still have their width
// kept in `breakParagraph`'s flat array rather than its map.
const WIDTH_BAND = 48;

// One paragraph - no newlines - broken every way the search keeps: the best
// breaking at each line count it could use (`byCount`, ascending), and the one
// of those that wins (`best`). Both in the published shape; see `balanceScored`.
// `every` asks for every count; without it the search stops at the first count
// that can no longer win, and `byCount` ends there. `only` asks for that one
// count alone (see `balanceCandidates`); a paragraph that has no breaking at it
// answers with whatever it falls back to, and the caller checks the count.
function breakParagraph(para, widthSpec, measureFn, o, every, only) {
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(para)) !== null) words.push({ s: m.index, e: m.index + m[0].length, t: m[0] });
  const n = words.length;
  // A blank paragraph is still a line, as in wrapLinesDOM, and it costs what any
  // line costs, so a block's merit goes on counting its lines.
  if (n === 0) {
    const blank = { lines: [''], merit: o.lineCost, cost: o.lineCost, overflowLines: [], greedy: false, orphansRelaxed: false };
    return { best: blank, byCount: [blank] };
  }

  // Every string is handed to `measureFn` once, however many ways it is reached:
  // the same word at two places in the paragraph, or the same word asked about
  // by the hyphenation gate and then by the search. In the app `measureFn` is a
  // canvas `measureText`, and it is the dearest thing this module does.
  const measured = new Map();
  const measure = (s) => {
    let v = measured.get(s);
    if (v === undefined) {
      v = measureFn(s);
      measured.set(s, v);
    }
    return v;
  };
  // A line of this paragraph by where it starts and ends, and whether it ends in
  // an added hyphen: `para.slice(start, end)`, plus the hyphen. Kept by those
  // three numbers - across calls, when the measure allows it (`spansFor`) - so
  // the string is built and looked up once rather than once a layout.
  const spans = spansFor(measureFn, para);
  const stride = para.length < SPAN_STRIDE ? SPAN_STRIDE : para.length + 1;
  const spanWidth = (start, end, hyphen) => {
    const key = (start * stride + end) * 2 + (hyphen ? 1 : 0);
    let v = spans.get(key);
    if (v === undefined) {
      v = measure(para.slice(start, end) + (hyphen ? '-' : ''));
      spans.set(key, v);
    }
    return v;
  };

  // Asked for once per line count and remembered, for two reasons. The cheap one
  // is that `solve` and `score` both want it. The load-bearing one is that the
  // search and the scorer must be looking at the same widths: a callback that
  // answered differently on two calls would have the DP optimising a block the
  // comparison did not believe in, and that is a class of bug that shows up as
  // an occasional wrong break rather than as an error.
  const widthsFn = widthsResolver(widthSpec);
  const widthsCache = new Map();
  const widthsOf = (L) => {
    let v = widthsCache.get(L);
    if (v === undefined) {
      v = widthsFn(L);
      widthsCache.set(L, v);
    }
    return v;
  };
  // The same, for the scorer, which unlike the search can be handed a block
  // longer than `maxLines`: the greedy fallback's. The callback is never asked
  // about a count that high, so the rows past the last count it may be asked
  // about take that count's last width - which is the allowance the fallback
  // wrapped them against.
  const rowsOf = (L) => {
    if (L <= o.maxLines) return widthsOf(L);
    const w = widthsOf(o.maxLines);
    return Array.from({ length: L }, (_, k) => w[Math.min(k, w.length - 1)]);
  };

  // Greedy is the floor, not the goal: it is what a text too long to enumerate
  // falls back to, and what answers when every candidate has been rejected. It
  // can never fail, which is the only property required of a fallback.
  //
  // It fills lines in order, so it uses each line's own allowance as it goes -
  // but it cannot know the line count before it has finished, and the widths
  // depend on it. So it guesses, wraps, and asks again with the count it got,
  // which settles immediately for a constant width and within a couple of passes
  // for anything shaped. Capped rather than looped to convergence, because a
  // fallback that could oscillate is not a fallback.
  //
  // It works in words, `[first, end)` per line, because it never breaks inside
  // one; `fallback` below turns those into the positions everything else uses.
  const wordsWidth = (i, j) => spanWidth(words[i].s, words[j - 1].e, false);
  const greedyAt = (w) => {
    const out = [];
    const allow = (k) => w[Math.min(k, w.length - 1)];
    let start = 0;
    for (let j = 2; j <= n; j++) {
      if (wordsWidth(start, j) > allow(out.length) + FIT_EPS) {
        out.push([start, j - 1]);
        start = j - 1;
      }
    }
    out.push([start, n]);
    return out;
  };
  const greedy = () => {
    let lines = greedyAt(widthsOf(1));
    for (let pass = 0; pass < 3; pass++) {
      const next = greedyAt(widthsOf(Math.min(lines.length, o.maxLines)));
      if (next.length === lines.length) return next;
      lines = next;
    }
    return lines;
  };
  // Too long to enumerate: no break points inside words, because only the
  // search below could ever use them.
  const enumerate = n <= o.maxWords;

  // ===== the positions a line may begin and end at =====
  //
  // Word boundaries, plus - for a word that has earned them - the points inside
  // it. A position carries two offsets because the two sides of a space are not
  // the same character index: a line ENDING at a word boundary stops at the end
  // of the previous word, and one STARTING there begins at the next word. A
  // point inside a word has the same offset for both, which is what makes a line
  // that begins mid-word begin exactly where the previous one left off.
  //
  // The consequence worth stating: a line is still `para.slice(a, b)`, exactly
  // as before, and the only thing that ever gets appended to it is the hyphen.
  // Interior spacing, double spaces and the user's own characters survive the
  // round trip untouched for the same reason they always did.
  const hyphenPoints = [];
  if (o.hyphenate && enumerate) {
    // The gate. A word is offered break points only when it fits on no line this
    // block could ever hand it - measured against the widest allowance across
    // every candidate line count, because if some line is wide enough, the
    // search below is free to put the word there and nothing needs splitting.
    //
    // The scan stops the moment the widest line found so far can hold the
    // longest word, which for ordinary text is after the very first call: a
    // balloon that fits its own text does not need to be interrogated about
    // fifteen hypothetical line counts, and `widthsFor` is a stranger's function
    // that this module should call as few times as it can get away with.
    let longest = 0;
    for (let j = 0; j < n; j++) longest = Math.max(longest, wordsWidth(j, j + 1));
    let widest = 0;
    for (let L = 1; L <= o.maxLines && widest <= longest + FIT_EPS; L++) {
      for (const w of widthsOf(L)) if (w > widest) widest = w;
    }
    let total = 0;
    for (let j = 0; j < n && total <= o.maxHyphenPoints; j++) {
      if (wordsWidth(j, j + 1) <= widest + FIT_EPS) continue;
      const pts = hyphenPointsFor(words[j].t, o);
      total += pts.length;
      for (const p of pts) hyphenPoints.push({ w: j, rel: p.rel, hy: p.hy });
    }
    // A paragraph that wants this many splits is not a paragraph this rule was
    // written for, and enumerating it would cost more than it could possibly
    // buy. Dropping the lot keeps the answer deterministic and merely returns
    // the module to its previous behaviour for that block.
    if (total > o.maxHyphenPoints) hyphenPoints.length = 0;
  }

  // `wStart` is the word a line beginning here starts in; `wEnd` the word a line
  // ending here ends in. Their difference plus one is the number of tokens on
  // the line, which is what both the fit rule and the orphan rule ask about.
  // `endPos[j]` is the position at the space after word `j`, which is where the
  // greedy fallback's lines end.
  const pos = [{ start: words[0].s, end: -1, hy: HY_NONE, wStart: 0, wEnd: -1 }];
  const endPos = new Array(n);
  let hp = 0;
  for (let j = 0; j < n; j++) {
    while (hp < hyphenPoints.length && hyphenPoints[hp].w === j) {
      const off = words[j].s + hyphenPoints[hp].rel;
      pos.push({ start: off, end: off, hy: hyphenPoints[hp].hy, wStart: j, wEnd: j });
      hp++;
    }
    pos.push({
      start: j + 1 < n ? words[j + 1].s : -1,
      end: words[j].e,
      hy: HY_NONE,
      wStart: j + 1,
      wEnd: j,
    });
    endPos[j] = pos.length - 1;
  }
  const M = pos.length - 1; // the last position: the end of the paragraph

  const lineText = (a, b) =>
    para.slice(pos[a].start, pos[b].end) + (pos[b].hy === HY_ADDED ? '-' : '');
  // The word numbers each position starts and ends a line in, flat, for the
  // search's inner loop - which asks for them hundreds of thousands of times a
  // solve.
  const wStartAt = pos.map((p) => p.wStart);
  const wEndAt = pos.map((p) => p.wEnd);
  const tokens = (a, b) => wEndAt[b] - wStartAt[a] + 1;

  // The measured width of the line as it will be DRAWN, hyphen included. A
  // hyphen that was not measured is a hyphen hanging out of the balloon. Kept
  // by position as well as by string, because the search asks about the same
  // pair many times and building the string to look it up would cost more than
  // the lookup saves.
  //
  // In a flat array for the pairs less than WIDTH_BAND positions apart - every
  // line the search tries is at most a row's worth of words, so that is nearly
  // every pair it asks about, and a map lookup per ask was a sixth of a solve -
  // and in a map for the few longer ones (the whole paragraph, a line of forty
  // one-letter words). NaN is "not measured yet".
  const band = new Array((M + 1) * WIDTH_BAND).fill(NaN);
  const far = new Map();
  const width = (a, b) => {
    const d = b - a;
    if (d >= 0 && d < WIDTH_BAND) {
      const i = b * WIDTH_BAND + d;
      let v = band[i];
      if (v !== v) {
        v = spanWidth(pos[a].start, pos[b].end, pos[b].hy === HY_ADDED);
        band[i] = v;
      }
      return v;
    }
    const k = a * (M + 1) + b;
    let v = far.get(k);
    if (v === undefined) {
      v = spanWidth(pos[a].start, pos[b].end, pos[b].hy === HY_ADDED);
      far.set(k, v);
    }
    return v;
  };

  // A line is admissible if it fits its own allowance, or if it is a single
  // unbreakable token - an over-long word with no usable syllable points goes
  // onto its own line whole and hangs over the edge rather than vanishing. What
  // that costs is `overflow`'s business, below; whether it is allowed at all is
  // this.
  const fits = (a, b, k, w) => tokens(a, b) === 1 || width(a, b) <= w[k - 1] + FIT_EPS;

  // Rule 2. Only meaningful when the block has more than one line: a two-letter
  // paragraph has nowhere else to be.
  //
  // Scoped to a lone WHOLE word - a line that begins or ends mid-word is a
  // fragment, and a fragment is not a word that has been left on its own, it is
  // part of one that is being carried across. What stops a fragment being a stub
  // is `minHyphenHead`/`minHyphenTail`, which is the rule written for that job.
  //
  // Whether a word may stand alone is the word's own business, so it is worked
  // out once a word (`standsAlone`) rather than by two regexes every time the
  // search tries that word on a line of its own - which is every line count and
  // every row, and was a fifth of a solve.
  const alone = new Array(n).fill(0); // 0 not asked yet, 1 may stand alone, 2 may not
  const standsAlone = (j) => {
    if (alone[j] === 0) alone[j] = hasHangul(words[j].t) || letterCount(words[j].t) >= o.minOrphan ? 1 : 2;
    return alone[j] === 1;
  };
  const orphanOk = (a, b, L) =>
    L === 1 ||
    tokens(a, b) > 1 ||
    pos[a].hy !== HY_NONE ||
    pos[b].hy !== HY_NONE ||
    standsAlone(pos[a].wStart);

  const totalW = width(0, M);

  // `T` is the fill ratio every line would have if the block were perfectly
  // balanced at this line count, and it is what every per-line cost is measured
  // against. Total ink over total allowance - which is the generalisation that
  // makes the ratios comparable at all when the allowance varies down the block,
  // and which collapses back to `totalW / (L * W)` the moment it does not. Fixed
  // for the whole candidate, which is what keeps the cost separable and the DP
  // exact.
  const targetFor = (w) => {
    let sum = 0;
    for (const v of w) sum += v;
    return totalW / sum;
  };

  // The room each line is MEANT to have, as against the room it HAS. Every term
  // that is about the block's shape - raggedness, the pinch, the short last line,
  // the hourglass - measures a line's fill against this. Everything that is
  // about the balloon - whether a line fits, what overflowing costs, which lines
  // hang out - still measures against the room the line has, so a preference
  // can never put ink past an edge.
  //
  //   auto  the rows themselves. A line is meant to fill its own row, which is
  //         every rule above as it always was: an even block in a rectangle, a
  //         block that follows the curve in an oval balloon.
  //   oval  short lines at the top and bottom and the long one in the middle,
  //         along `ovalProfile`, whatever the balloon does.
  //   rect  even lines, so an oval balloon gets a block that does not follow
  //         its curve, as far as its rows allow.
  //
  // What each line is meant to hold is the most oval (or most even) block of
  // THIS text that the rows can take: the text's width shared out along the
  // profile, and where that would give a row more than it has, the row gets
  // all it has and the rest is shared out again among the others. A dense
  // block in a narrow box therefore aims for an oval with a flat top rather
  // than for one it cannot have, and a full-width middle line is on target
  // instead of being taken for a pinch - taken for one, it made a word hanging
  // out of the middle of the block look like the cure.
  //
  // Then scaled back to what the rows would be meant to hold, so that `T` comes
  // out the same for every shape and every weight keeps the scale it was tuned
  // at. `auto` is this with the rows themselves as the profile, which is why it
  // can simply be handed back.
  const prefers = o.shape === 'oval' || o.shape === 'rect';
  const rowsThemselves = (w) => w;
  const preferredOf = (w) => {
    if (!prefers) return w;
    const L = w.length;
    const want = o.shape === 'oval' ? ovalProfile(L) : new Array(L).fill(1);
    // Even rows asked to be even already are: handed back as they are, so a
    // rectangle set as 'rect' - or as a one- or two-line 'oval' - is the
    // 'auto' block to the last bit rather than to a rounding error.
    if (want.every((v) => v === want[0]) && w.every((v) => v === w[0])) return w;
    let room = 0;
    for (const v of w) room += v;
    // Rows that cannot hold the text at all have nothing to prefer between.
    if (totalW >= room) return w;
    let rest = totalW;
    let parts = 0;
    for (const v of want) parts += v;
    let c = rest / parts;
    // The rows that run out first are the ones with the least room for their
    // share; each one taken out raises everyone else's share, so the first row
    // that keeps its share is the last one that could have run out.
    const order = Array.from({ length: L }, (_, k) => k).sort((i, j) => w[i] / want[i] - w[j] / want[j]);
    for (const k of order) {
      if (c * want[k] <= w[k]) break;
      rest -= w[k];
      parts -= want[k];
      c = rest / parts;
    }
    const back = room / totalW;
    return want.map((v, k) => Math.min(w[k], c * v) * back);
  };

  // One line's cost, and the single place it is defined: the DP minimises the
  // sum of this and the scorer adds the same numbers up again over a finished
  // breaking. Two expressions of one cost function would be two answers to "is
  // this breaking better", and the search would be optimising something the
  // comparison did not believe.
  //
  // `w` is the room each line has and `p` the room it is meant to have (see
  // `preferredOf`); `T` is measured against `p`. `pinchW` is a parameter for one
  // reason only - the second, harder search in `shaped` below. Every scoring
  // call passes `o.pinch`.
  const lineCostOf = (a, b, k, L, T, w, p, pinchW) => {
    const W = w[k - 1];
    const lw = width(a, b);
    const r = lw / p[k - 1];
    let c = o.ragged * (r - T) ** 2;
    // Both of these weight a line that falls SHORT of the target, and only that
    // direction: a line that runs long is a full line, which is what was
    // wanted. Where the shortfall sits is what separates them.
    //   last     the classic widow, already penalised by the deviation term and
    //            weighted a little further here.
    //   interior the pinch that makes an hourglass. Weighted far harder, because
    //            a short line in the middle of a block is the one profile that
    //            is always wrong - and because this is what pushes the shortfall
    //            to the end of the block instead.
    if (r < T) c += (k === L ? o.lastShort : k > 1 ? pinchW : 0) * (T - r) ** 2;
    // And the other direction, once. `FIT_EPS` is subtracted for the same reason
    // `fits` adds it: a line that measures a rounding error over its box is not
    // hanging out of anything.
    const over = (lw - W - FIT_EPS) / W;
    if (over > 0) c += o.overflow * over * over;
    // Only reachable in the relaxed pass; the strict one never admits such a
    // line at all. Flat rather than proportional to anything, because an orphan
    // is not a matter of degree: the line either breaks the rule or it does not.
    if (!orphanOk(a, b, L)) c += o.orphanCost;
    // The hyphen, priced where it is drawn. A break at a hyphen the user typed
    // is the cheap one; an invented hyphen in the paragraph's last word is the
    // dear one, because that is the split a reader is most likely to read as an
    // accident. `hyphenPair` needs no state to detect: this line begins mid-word
    // exactly when the line before it ended in a hyphen.
    if (pos[b].hy === HY_ADDED) {
      c += o.hyphen + (pos[b].wEnd === n - 1 ? o.lastWordHyphen : 0);
    } else if (pos[b].hy === HY_EXISTING) {
      c += o.existingHyphen + (pos[b].wEnd === n - 1 ? o.lastWordHyphen : 0);
    }
    if (pos[a].hy !== HY_NONE && pos[b].hy !== HY_NONE) c += o.hyphenPair;
    return c;
  };

  // Optimal break points for exactly `L` lines, by dynamic programming over
  // (line index, positions consumed) - Knuth-style, rather than greedy, because
  // a break that looks best locally routinely forces a terrible one two lines
  // later.
  //
  // A line is only ever as long as its row, and that is what keeps this cheap.
  // The line ending at `b` is tried from the latest start back, and the first
  // start that does not fit ends the search, because every earlier one is the
  // same line with more text in front of it: wider, and more tokens, so it
  // cannot fit either. The pruning is exact - it skips nothing the full search
  // could have chosen - and it turns the work from every pair of positions into
  // every position times a line's worth of them. That matters twice over,
  // because a pair is a string handed to `measureFn`, which in the app is a
  // canvas `measureText` and the dearest thing this module does.
  //
  // `reach` is the furthest position the previous line could end at. No line
  // starts beyond it, so the search for a line ending at `b` begins there, and
  // once even that start is too far back for `b` to fit, no later `b` can be
  // reached at all - with one exception, which is why the test is skipped for
  // it: a line ending at an invented hyphen carries a '-' that the longer line
  // after it does not, so the longer line is not simply the same text and more.
  //
  // Returns the cuts, not the cost: what a breaking costs is `score`'s business,
  // and this may have searched under a weight the score does not use.
  const solve = (L, allowOrphan, pinchW, prefer) => {
    const w = widthsOf(L);
    const p = prefer(w);
    const T = targetFor(p);
    let prev = new Array(M + 1).fill(Infinity);
    prev[0] = 0;
    let reach = 0;
    const back = [];
    for (let k = 1; k <= L; k++) {
      const cur = new Array(M + 1).fill(Infinity);
      const bk = new Array(M + 1).fill(-1);
      let next = -1;
      // Not past `M - (L - k)`: every later line needs a position of its own.
      for (let b = k; b <= M - (L - k); b++) {
        const from = Math.min(b - 1, reach);
        if (from < b - 1 && pos[b].hy !== HY_ADDED && !fits(from, b, k, w)) break;
        for (let a = from; a >= k - 1; a--) {
          if (!fits(a, b, k, w)) break;
          if (prev[a] === Infinity) continue;
          if (!allowOrphan && !orphanOk(a, b, L)) continue;
          const tot = prev[a] + lineCostOf(a, b, k, L, T, w, p, pinchW);
          // `<=` while `a` falls, so a tie keeps the smallest `a` - the one
          // that put more words on the earlier line. That is the whole of the
          // tie-breaking rule inside a candidate, and it is why two runs on the
          // same input can never differ.
          if (tot <= cur[b]) {
            cur[b] = tot;
            bk[b] = a;
          }
        }
        if (cur[b] !== Infinity) next = b;
      }
      if (next < 0) return null;
      reach = next;
      back.push(bk);
      prev = cur;
    }
    if (prev[M] === Infinity) return null;
    const cuts = [];
    let b = M;
    for (let k = L; k >= 1; k--) {
      const a = back[k - 1][b];
      cuts.unshift([a, b]);
      b = a;
    }
    return cuts;
  };

  // Whether `L` lines have any breaking at all: whether `solve(L, allowOrphan,
  // ...)` would answer, without pricing anything. The same walk over the same
  // positions - the same `reach`, the same two breaks, the same orphan rule -
  // keeping only which positions a block of k lines can end at, and done with a
  // position at the first start that reaches it. Priced, a position is reached
  // exactly when it is reached here, as long as every price is a number; when
  // one might not be - a weight, a width, a preferred width or a target that is
  // not a finite number - the search itself is asked.
  //
  // Most counts a search walks past have no breaking at all - a long text has
  // none at three lines - and pricing every line of every one of them to find
  // that out was a third of a solve.
  const finiteWeights = [
    o.ragged, o.lastShort, o.pinch, o.pinchHard, o.overflow, o.orphanCost,
    o.hyphen, o.lastWordHyphen, o.existingHyphen, o.hyphenPair,
  ].every(Number.isFinite);
  const hasBreaking = (L, allowOrphan) => {
    const w = widthsOf(L);
    const p = preferredOf(w);
    const T = targetFor(p);
    if (!finiteWeights || !Number.isFinite(T) || !p.every((v) => v > 0 && Number.isFinite(v))) {
      return solve(L, allowOrphan, o.pinch, preferredOf) !== null;
    }
    let prev = new Array(M + 1).fill(0);
    prev[0] = 1;
    let reach = 0;
    for (let k = 1; k <= L; k++) {
      const cur = new Array(M + 1).fill(0);
      let next = -1;
      for (let b = k; b <= M - (L - k); b++) {
        const from = Math.min(b - 1, reach);
        if (from < b - 1 && pos[b].hy !== HY_ADDED && !fits(from, b, k, w)) break;
        for (let a = from; a >= k - 1; a--) {
          if (!fits(a, b, k, w)) break;
          if (!prev[a]) continue;
          if (!allowOrphan && !orphanOk(a, b, L)) continue;
          if (Number.isFinite(width(a, b))) {
            cur[b] = 1;
            break;
          }
        }
        if (cur[b]) next = b;
      }
      if (next < 0) return false;
      reach = next;
      prev = cur;
    }
    return prev[M] === 1;
  };

  // What a finished breaking is worth, always under the standard weights, so two
  // breakings found by two different searches can be compared at all. `prefer`
  // gives the widths the shape terms measure against: `preferredOf`, or the
  // rows themselves for the price a silhouette is capped at (see `bestAt`).
  //
  //   merit    the separable costs plus the price of another line: everything
  //            but the profile.
  //   penalty  the profile, which no per-line cost can see, at `hourglass`'s
  //            full weight. What two breakings of the SAME line count are
  //            compared on, with merit - see `shaped`.
  //   cost     merit plus the profile at no more than one line's price. What
  //            line counts are compared on, and what a caller is handed. See
  //            `hourglass` for why the two prices differ.
  const score = (cuts, L, prefer) => {
    const w = rowsOf(L);
    const p = prefer(w);
    const T = targetFor(p);
    let base = 0;
    for (let k = 1; k <= cuts.length; k++) {
      const [a, b] = cuts[k - 1];
      base += lineCostOf(a, b, k, L, T, w, p, o.pinch);
    }
    const ratios = cuts.map(([a, b], k) => width(a, b) / p[k]);
    const penalty = hourglassPenalty(ratios, o.hourglass, o.hourglassTol);
    const merit = base + o.lineCost * L;
    return { cuts, L, merit, penalty, cost: merit + Math.min(penalty, o.lineCost) };
  };

  // The hourglass rule, applied where a profile exists and a line count is
  // already settled. The ordinary search minimises a sum of per-line costs and
  // cannot see the profile it is building; when what it built is a pinched one,
  // this asks the same question again with interior shortfalls weighted hard
  // enough to force the short line somewhere else, and keeps that answer only if
  // it is cheaper *under the ordinary weights plus the profile penalty* - at its
  // full weight, because the two breakings have the same number of lines and
  // the only question left is which of them reads as a shape.
  //
  // So the heavy `pinchHard` weight never prices anything - it only proposes. A
  // proposal that dodges the dip by making a mess of the raggedness loses on its
  // own merit, which is the property that makes the big `hourglass` weight safe.
  const shaped = (cand, allowOrphan, prefer) => {
    if (!cand || cand.penalty === 0) return cand;
    const alt = solve(cand.L, allowOrphan, o.pinchHard, prefer);
    if (!alt) return cand;
    const scored = score(alt, cand.L, prefer);
    return scored.merit + scored.penalty < cand.merit + cand.penalty ? scored : cand;
  };

  // A scored breaking in the shape the callers get: the lines as they will be
  // drawn, its prices, and which of them hang over their own row - the only
  // lines that can are single tokens, and they are what a caller has to flag or
  // shrink for, because no breaking of this text at this size puts them inside.
  const publish = (cand, greedyPath, orphansRelaxed) => {
    const w = rowsOf(cand.L);
    const overflowLines = [];
    cand.cuts.forEach(([a, b], k) => {
      if (width(a, b) > w[k] + FIT_EPS) overflowLines.push(k);
    });
    return {
      lines: cand.cuts.map(([a, b]) => lineText(a, b)),
      merit: cand.merit,
      cost: cand.cost,
      overflowLines,
      greedy: greedyPath,
      orphansRelaxed,
    };
  };

  // What a block costs when a silhouette was asked for: its cost against the
  // widths its lines are meant to have, or its cost against the rows and one
  // line more, whichever is less - a shape is worth at most a line (see
  // `bestAt`). `plain` is a breaking priced against the rows: the same one, or
  // the one the search against the rows found.
  const capped = (cand, plain) =>
    plain && plain.cost + o.lineCost < cand.cost ? { ...plain, cost: plain.cost + o.lineCost } : cand;

  // The fallback, scored like everything else so a caller comparing blocks
  // compares them on one scale, and flagged, because no orphan, hyphen or shape
  // rule has been applied to it and a caller may want to say so.
  const fallback = () => {
    const cuts = greedy().map(([i, j]) => [i === 0 ? 0 : endPos[i - 1], endPos[j - 1]]);
    const L = cuts.length;
    const scored = score(cuts, L, preferredOf);
    const only = publish(prefers ? capped(scored, score(cuts, L, rowsThemselves)) : scored, true, false);
    return { best: only, byCount: [only] };
  };
  if (!enumerate) return fallback();

  // The best breaking at exactly `L` lines against one reference profile: the
  // ordinary search, then the profile repair.
  const searchAt = (L, allowOrphan, prefer) => {
    const cuts = solve(L, allowOrphan, o.pinch, prefer);
    return cuts && shaped(score(cuts, L, prefer), allowOrphan, prefer);
  };

  // The best breaking at exactly `L` lines. Without a silhouette preference that
  // is the search above. With one, it is the breaking that best keeps to the
  // preferred widths - unless it costs more than a line over the breaking that
  // keeps to the rows, in which case that one is used and pays the line.
  //
  // The cap is `hourglass`'s, for the same reason: a shape is worth at most a
  // line. An oval holds less than a rectangle of the same width, so a dense
  // block kept to one needs more lines, and priced at its full cost the
  // preference would buy them - `Is there something you'd like our cooperation
  // with?` went from three lines to five to be an oval. Capped, it can move the
  // count by about a line, and past that the block is the ordinary one.
  //
  // Two searches and no loss of exactness: each finds the cheapest breaking
  // under one of the two prices, and the cheaper of those is the cheapest
  // breaking under the lesser price, which is what `capped` charges. When the
  // preferred widths are the rows themselves - no preference, a rectangle asked
  // to be even, a text wider than all its rows - `preferredOf` hands back the
  // rows as they are, and the second search would be the first one again.
  const bestAt = (L, allowOrphan) => {
    const cand = searchAt(L, allowOrphan, preferredOf);
    const w = widthsOf(L);
    if (!cand || preferredOf(w) === w) return cand;
    return capped(cand, searchAt(L, allowOrphan, rowsThemselves));
  };

  // Every line count from one up. The ceiling is the number of break positions
  // rather than the number of words, because a single hyphenatable word is a
  // paragraph that can legally occupy three lines - which is the whole of the
  // reference case.
  //
  // A block costs at least `lineCost` a line, so once the lines alone would cost
  // what the cheapest block so far costs in all, no count from there up can win,
  // and a caller that only wants the winner is spared them. That is most of the
  // work in a wide box, where every count past the right one is still a legal
  // breaking and each takes a full search to price.
  //
  // A count with no breaking at all is passed over without being searched
  // (`hasBreaking`). And with `o.stopAbove` (see below), a count past it that is
  // cheaper than every count up to it is the end: the winner is at least that
  // cheap, and a tie goes to the fewer lines, so the winner has more lines than
  // the caller can use (`TOO_TALL`).
  const maxL = Math.min(M, o.maxLines);
  const stop = !every && only == null ? o.stopAbove ?? null : null;
  const everyCount = (allowOrphan) => {
    const out = [];
    let cheapest = Infinity;
    let within = Infinity;
    for (let L = only ?? 1; L <= (only ?? maxL); L++) {
      if (!every && o.lineCost * L >= cheapest) break;
      if (!hasBreaking(L, allowOrphan)) continue;
      const cand = bestAt(L, allowOrphan);
      if (!cand) continue;
      out.push(cand);
      cheapest = Math.min(cheapest, cand.cost);
      if (stop !== null) {
        if (L <= stop) within = Math.min(within, cand.cost);
        else if (cand.cost < within) return TOO_TALL;
      }
    }
    return out;
  };

  // A caller that only needs to know whether the block fits in `o.stopAbove`
  // lines - the solver, trying a size it throws away when the text is too tall
  // for its balloon - is told so (`TOO_TALL`) as soon as it is certain, rather
  // than handed the best breaking at thirty lines of a balloon that holds six.
  // Every count up to the one that wins has to be searched to find the winner,
  // and those counts were most of a solve's work.
  //
  // Certain means that whatever this would otherwise return has more lines than
  // that, whichever way it got there. No count up to it has any breaking at all
  // (`hasBreaking`), with orphans refused or allowed, so neither pass below can
  // find one there. And the fallback's greedy wrap, the one other answer, is
  // longer too.
  if (o.stopAbove != null && !every && only == null) {
    let within = false;
    for (let L = 1; L <= Math.min(o.stopAbove, maxL) && !within; L++) within = hasBreaking(L, true) || hasBreaking(L, false);
    if (!within && greedy().length > o.stopAbove) return TOO_TALL;
  }

  // The orphan rule is a hard constraint, and then it is not. Held hard, a text
  // like "Hi you" in a box only wide enough for one word at a time has no legal
  // breaking at all, and the honest thing to do with an unsatisfiable constraint
  // is to relax it rather than to hand back nothing.
  //
  // Relaxed is not the same as dropped, and that distinction is the whole of the
  // second pass. Dropped, one genuinely unplaceable short word - a scrap between
  // two words too long to share a line with it - turned the rule off for every
  // other line in the paragraph: `I DIE UNDERSTAND A MONSTER A NO` in a
  // six-unit box stranded `I` on a line of its own although `I DIE` fits and
  // obeys the rule, because once `A` had proved the constraint unsatisfiable
  // nothing was left to prefer the legal breaking. As a per-line cost heavy
  // enough to dominate any shape difference (`orphanCost`), the only orphans
  // that survive are the ones no breaking could have avoided.
  //
  // And it is relaxed for the paragraph, not per line count: a count with no
  // legal breaking is simply not on offer while another count has one, which is
  // what keeps `byCount` and `best` telling the same story.
  let orphansRelaxed = false;
  let found = everyCount(false);
  if (found === TOO_TALL) return TOO_TALL;
  if (!found.length) {
    orphansRelaxed = true;
    found = everyCount(true);
    if (found === TOO_TALL) return TOO_TALL;
  }
  if (!found.length) return fallback();
  const byCount = found.map((cand) => publish(cand, false, orphansRelaxed));

  // The cheapest wins. Ascending with a strict `<` is the second half of the
  // tie-breaking rule: equal cost goes to the block with fewer lines.
  let best = byCount[0];
  for (const cand of byCount) if (cand.cost < best.cost) best = cand;
  return { best, byCount };
}

// A text's paragraphs. Each newline is a hard break the user typed, and each
// paragraph is balanced on its own - a shape is a property of a paragraph, and
// balancing across a deliberate break would move words over a line the user put
// there.
function paragraphsOf(text) {
  return (text == null ? '' : String(text)).split('\n');
}

// A text's paragraphs are broken one at a time, but a balloon's rows belong to
// the whole block: what a `widthsFor` callback hands back for `L` lines is the
// rows of a block of `L` lines, placed as a block. A paragraph asking for its
// own count was measured as if it were the whole block, and it is drawn on
// other rows - the second of two paragraphs in an oval sits on the lower,
// narrower half, and was broken to the middle's width (GEO-2).
//
// So each paragraph is broken against its slice of the whole block's rows: the
// rows under the paragraphs before it, in a block of every paragraph's lines.
// That needs every other paragraph's count, which depends on its own rows in
// turn - so the counts start from each paragraph alone, each paragraph is broken
// again on its slice, and that repeats until no count moves, the way `greedy`
// settles its own. Capped, like `greedy`, because an answer that could
// oscillate is not one; two passes settle every block measured.
//
// The blank paragraphs at either end take no rows: `layoutLines` drops the
// blank lines they become, so the block is drawn without them. A blank
// paragraph between two others is a blank line in the block, and has its row.
//
// `solve(para, widths)` is one paragraph broken against a width spec, in the
// published shape; the answer is one per paragraph. A constant width is the
// same on every row, and a lone paragraph's rows are its own, so both are the
// paragraphs alone, as they always were.
function onTheirRows(paras, width, o, solve) {
  const out = paras.map((para) => solve(para, width));
  const span = spanOf(paras, width);
  if (!span) return out;
  const tried = new Map();
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let k = span.first; k <= span.last; k++) {
      const { before, after } = around(out, span, k);
      const key = `${k} ${before} ${after}`;
      let got = tried.get(key);
      if (!got) {
        got = solve(paras[k], slice(width, before, after, o));
        tried.set(key, got);
      }
      if (got.lines.length !== out[k].lines.length) moved = true;
      out[k] = got;
    }
    if (!moved) break;
  }
  return out;
}

// The paragraphs that take rows, first to last, or null when the rows need no
// sharing out: a constant width, or a single paragraph with text in it.
function spanOf(paras, width) {
  if (typeof width !== 'function') return null;
  const blank = paras.map((para) => para.trim() === '');
  const first = blank.indexOf(false);
  const last = blank.lastIndexOf(false);
  return first < 0 || first === last ? null : { first, last };
}

// How many rows the paragraphs before and after paragraph `k` take.
function around(parts, span, k) {
  let before = 0;
  let after = 0;
  for (let j = span.first; j <= span.last; j++) {
    if (j < k) before += parts[j].lines.length;
    if (j > k) after += parts[j].lines.length;
  }
  return { before, after };
}

// A paragraph's rows: lines `before .. before + L` of a block with `after` more
// lines below them. A block past `maxLines` is one the callback is never asked
// about (see `balanceScored`), and gets the paragraph's own rows instead.
function slice(width, before, after, o) {
  return (L) => {
    const total = before + L + after;
    if (total > o.maxLines) return width(L);
    const rows = width(total);
    return Array.isArray(rows) ? rows.slice(before, before + L) : rows;
  };
}

// A block is its paragraphs one after another: lines concatenated, prices
// summed, overflowing lines renumbered to where their paragraph starts, and a
// flag raised when any paragraph raised it.
function joinParagraphs(parts) {
  const out = { lines: [], merit: 0, cost: 0, overflowLines: [], greedy: false, orphansRelaxed: false };
  for (const p of parts) {
    for (const k of p.overflowLines) out.overflowLines.push(out.lines.length + k);
    out.lines.push(...p.lines);
    out.merit += p.merit;
    out.cost += p.cost;
    out.greedy = out.greedy || p.greedy;
    out.orphansRelaxed = out.orphansRelaxed || p.orphansRelaxed;
  }
  return out;
}

// The public entries. `text` may contain newlines (see `paragraphsOf`).
//
// `width` is either a number, meaning the same allowance for every line, or a
// callback `widthsFor(lineCount) -> number[]` handing back one allowance per
// line of a block of that many lines. The callback is asked once per candidate
// line count per paragraph and its answer is remembered, so it must be pure; it
// is not asked for a line count above `maxLines`.
//
// `balanceScored` is the breaking the module chooses, with what it knows about
// it:
//
//   lines           the lines, as they will be drawn
//   merit, cost     its prices under the standard weights (see `score`), summed
//                   over the paragraphs. Comparable between breakings of the
//                   same text; not between two texts. Under a `shape` other than
//                   'auto', `cost` also prices the distance from that silhouette,
//                   at no more than a line a paragraph (see `bestAt`).
//   overflowLines   indices into `lines` of the lines wider than their own row.
//                   Only a single unbreakable token can be, so a non-empty list
//                   means this text does not fit this width at this size.
//   greedy          some paragraph fell back to greedy wrapping - too long to
//                   enumerate, or no breaking within `maxLines` - and has had no
//                   orphan, hyphen or shape rule applied.
//   orphansRelaxed  some paragraph had no breaking that keeps every short word
//                   company, and carries the cheapest orphans instead.
//
// `opts.stopAbove`, for a caller that only needs to know whether the block fits
// in that many lines: null instead of the breaking when it certainly does not
// (see `breakParagraph`). Only for a block of one paragraph - less the blank
// ones at either end, which `layoutLines` drops - whose lines are the block's.
// Several paragraphs are broken again on each other's rows until their counts
// settle (`onTheirRows`), so no one paragraph's count along the way is certain
// to be the block's; for them it is ignored and the breaking is returned.
export function balanceScored(text, width, measureFn, opts = {}) {
  const o = { ...TYPESET_DEFAULTS, ...opts };
  const paras = paragraphsOf(text);
  if (o.stopAbove != null && paras.filter((para) => para.trim() !== '').length !== 1) o.stopAbove = null;
  let tall = false;
  const solve = (para, w) => {
    const r = breakParagraph(para, w, measureFn, o, false);
    if (r === TOO_TALL) {
      tall = true;
      return EMPTY_BLOCK;
    }
    return r.best;
  };
  const out = onTheirRows(paras, width, o, solve);
  return tall ? null : joinParagraphs(out);
}

// What `breakParagraph` answers when asked to stop above a count it is certain
// to exceed, and what stands in for it until `balanceScored` sees it.
const TOO_TALL = Object.freeze({ tooTall: true });
const EMPTY_BLOCK = Object.freeze({ lines: [], merit: 0, cost: 0, overflowLines: [], greedy: false, orphansRelaxed: false });

// The best breaking at every line count the text can be set in, ascending, each
// in `balanceScored`'s shape - for a caller that has a reason of its own to want
// a count other than the cheapest: a block that must fit a height, or a size
// being traded against a count. The entry at the count `balanceScored` chooses
// is the breaking it chooses.
//
// A text of several paragraphs is set at a given count by the cheapest split of
// that count between them, which is a small min-plus product of each
// paragraph's own table rather than a search over the whole block. A paragraph
// that fell back to greedy offers its one count only.
//
// Against a balloon's rows, each paragraph is then broken at its share of the
// count again, on the rows it is drawn on (`onTheirRows`), and a count whose
// split some paragraph has no breaking for on those rows is not on offer -
// unless no count is, when the paragraphs' own tables are the answer. The split
// is still chosen on those tables, so for a text of several paragraphs in a
// balloon the count `balanceScored` chooses may be set differently here.
export function balanceCandidates(text, width, measureFn, opts = {}) {
  const o = { ...TYPESET_DEFAULTS, ...opts };
  const paras = paragraphsOf(text);
  let runs = new Map([[0, { cost: 0, parts: [] }]]);
  for (const para of paras) {
    const { byCount } = breakParagraph(para, width, measureFn, o, true);
    const next = new Map();
    for (const [L0, run] of runs) {
      for (const cand of byCount) {
        const L = L0 + cand.lines.length;
        const cost = run.cost + cand.cost;
        const held = next.get(L);
        if (!held || cost < held.cost) next.set(L, { cost, parts: [...run.parts, cand] });
      }
    }
    runs = next;
  }
  const alone = [...runs.keys()].sort((a, b) => a - b).map((L) => runs.get(L).parts);
  const span = spanOf(paras, width);
  if (!span) return alone.map(joinParagraphs);
  const onRows = [];
  for (const parts of alone) {
    const got = parts.map((part, k) => {
      if (k < span.first || k > span.last) return part;
      const { before, after } = around(parts, span, k);
      const L = part.lines.length;
      const best = breakParagraph(paras[k], slice(width, before, after, o), measureFn, o, true, L).best;
      return best.lines.length === L ? best : null;
    });
    if (!got.includes(null)) onRows.push(joinParagraphs(got));
  }
  return onRows.length ? onRows : alone.map(joinParagraphs);
}

// The lines alone, which is all the renderer has ever needed.
export function balanceLines(text, width, measureFn, opts = {}) {
  return balanceScored(text, width, measureFn, opts)?.lines ?? null;
}

// ===== auto-height =====
// Two pure halves of "the box grows so the text fits", kept here rather than in
// the store because they are arithmetic and the store is not the place to test
// arithmetic.

// The height a box needs for `lineCount` lines of this style, including the
// padding the editor and the exporter both lay out inside. Ceiled, so a box's
// height never lands a sub-pixel short of its own text and wobbles between two
// values as the metric floats.
//
// Every input is guarded, and the guard on `lineHeight` is the same `?? 1` that
// `layoutLines` and `balancedBoxSize` already apply - three places asking one
// style the same question have to answer it the same way. Left unguarded this
// returned NaN for a style missing the field (a hand-written chapter.json, a box
// from a build that predates it, a tag with a partial override), and NaN is the
// one bad answer that gets past a caller: `bal?.h ?? 92` in placement is a null
// check, not a number check, so the box was placed with a NaN height, laid out
// to nothing, and saved that way. A missing line height is not an error worth
// throwing over - it is a style with a default - and an unmeasurable size gives
// back the padding alone, which is a box a user can see and drag.
export function neededHeight(lineCount, style, pad = 2) {
  const size = Number(style?.size);
  const mult = Number(style?.lineHeight);
  const lh = (size > 0 ? size : 0) * (mult > 0 ? mult : 1);
  const n = Number(lineCount);
  const p = Number.isFinite(+pad) ? +pad : 0;
  const block = Number.isFinite(n) && n > 0 ? Math.ceil(n * lh) : 0;
  return block + p * 2;
}

// Grow-only, and anchored by `valign` so the text stays where the user aimed it:
// a top-aligned box grows downward, a bottom-aligned one upward, and a centred
// one opens equally in both directions so the block stays centred on the bubble
// that was clicked.
//
// Never shrinks. A box the user sized by hand and left roomier than its text is
// theirs, and an "auto" that quietly took that room back would be a second
// editor fighting the first. Growth is the half that fixes a bug - text spilling
// out of its own rectangle - and shrinking is the half that would create one.
//
// `pageH` is the page's coordinate height. The result is capped at it and then
// clamped inside it, for the same reason every drag handler clamps: geometry
// that leaves the page is geometry the user cannot reach to correct. A page with
// no measured space yet (`pageH` 0) is not clamped against, because clamping
// against a number nobody has measured moves boxes for no reason.
export function growToFit(geom, needH, pageH = 0) {
  const y = geom.y;
  const h = geom.h;
  if (!(needH > h)) return { y, h };
  const newH = pageH > 0 ? Math.min(needH, pageH) : needH;
  if (!(newH > h)) return { y, h };
  const grow = newH - h;
  const va = geom.valign;
  let ny = va === 'top' ? y : va === 'bottom' ? y - grow : y - grow / 2;
  if (pageH > 0) ny = Math.max(0, Math.min(ny, pageH - newH));
  return { y: ny, h: newH };
}

// ===== auto-WIDTH, and the shape a placed box aims for =====
//
// Auto-height on its own is half a rule, and the missing half is what produced
// the bug this exists to fix. A box placed with no idea what is under it got a
// fixed 220px width; the height then followed the text, and only the height, so
// a long line came out as a tall narrow column - the exact shape English does
// not want, arrived at from the opposite direction to the vertical-Japanese
// block that motivated `transposeRect`.
//
// The width has to be chosen at the same time as the height, and from the same
// measurement, or the two cannot describe a shape. What decides it:
//
//   the text's own area. A block of text is an area before it is a rectangle -
//   set it on one line and it is `totalAdvance` long and `lineHeight` tall, and
//   breaking it into `n` lines conserves that area (roughly: breaking wastes a
//   little at the end of each line, which is what `slack` is for). So the
//   question "what width gives a balanced block" has a closed form, and it is the
//   classic one: for area A and target aspect ratio R, `w = sqrt(A * R)`.
//
//   an aspect a balloon can hold. Slightly wider than tall - a speech balloon is
//   an oval whose major axis is horizontal, and text set squarer than that hits
//   the curve at the top and the bottom while leaving the middle empty. 1.6 is
//   inside the range letterers actually set to and comfortably clear of both
//   degenerate ends.
export const BALANCED_DEFAULTS = {
  targetAspect: 1.6, // w:h of the text block, not of the box
  maxLines: 14, // past this the text is a caption, not a balloon line
  // Line breaking never packs a line perfectly full: the last word that fits
  // leaves a ragged remainder, so a width of exactly `total / n` reliably breaks
  // into n+1 lines rather than n. A few percent of headroom is what makes the
  // closed form's answer come true when the real breaker runs.
  slack: 1.06,
  minWidth: 40, // the floor placement and the resize handles both already enforce
};

// The number of lines that makes a block of this much text closest to
// `targetAspect`, and the width that produces it.
//
// Derivation, so the two square roots are not magic: with `n` lines the block is
// `total / n` wide and `n * lineHeight` tall, so its aspect is
// `total / (n^2 * lineHeight)`. Setting that equal to R and solving for n gives
// `n = sqrt(total / (lineHeight * R))`, which is the same statement as
// `w = sqrt(total * lineHeight * R)` - the area form - with the line count made
// explicit. The line count is what has to be an integer, so it is the one that
// gets rounded, and the width is then recovered from the rounded count rather
// than the other way round. Rounding the width instead would ask for a shape
// that no whole number of lines can produce.
export function balancedBlockSize(totalAdvance, lineHeight, opts = {}) {
  const o = { ...BALANCED_DEFAULTS, ...opts };
  const total = Number(totalAdvance);
  const lh = Number(lineHeight);
  if (!(total > 0) || !(lh > 0)) return null;
  const R = o.targetAspect > 0 ? o.targetAspect : 1;
  const ideal = Math.sqrt(total / (lh * R));
  const lines = Math.max(1, Math.min(Math.round(o.maxLines), Math.round(ideal)));
  const w = Math.max(o.minWidth, (total / lines) * o.slack);
  return { w, h: lines * lh, lines };
}
