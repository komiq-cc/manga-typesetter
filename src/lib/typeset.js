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
// does the reverse. Those two, and nothing else, choose the line count - see
// `pick`.
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
// exists: between two *complete* breakings of the SAME line count, one from the
// ordinary search and one from a search that leans on interior shortfalls hard
// enough to break the pinch (`pinchHard`). Both are then priced under the
// ordinary weights, so the comparison is honest and the heavier search is only
// ever a generator of candidates, never a scorer.
//
// That is a change of role, and it is why the weight can be this large. The term
// used to be added to each line count's total, where it competed with `lineCost`
// - so cranking it up stopped rejecting pinches and started rejecting line
// counts, and the block grew two extra lines to dodge a dip nobody would have
// noticed. At the weight that could not do that (6) it also could not do
// anything else. Measured over a 3000-string corpus: zeroing it changed 20
// outputs, and 151 blocks shipped with a pinched profile. Confined to a fixed
// line count it cannot buy a line at ANY weight - the two breakings it chooses
// between have the same number of them - so the deadband is what keeps it off
// ordinary text and the weight is free to be big enough to matter. At 300 the
// same corpus ships 133 pinched blocks against 167 with the term switched off,
// and 133 is very nearly the floor: an exhaustive search of every breaking at
// each block's own line count says 130 of them have no unpinched breaking at
// all. The mean line count is identical either way (3.198), and the mean spread
// between a block's widest and narrowest line moves from 0.235 to 0.238 - the
// repairs are not being bought with raggedness.
//
// `orphanCost` is the other constraint-as-cost. See the two passes at the bottom
// of `balanceParagraph` for why the rule has to be relaxable at all.
export const TYPESET_DEFAULTS = {
  minOrphan: 3, // a word with fewer letters than this may not sit alone on a line
  maxLines: 16, // candidate line counts above this are not enumerated
  maxWords: 60, // beyond this the DP is skipped and greedy wrapping is used
  ragged: 1, // weight on each line's squared deviation from the target fill ratio
  lastShort: 0.6, // extra weight when the FINAL line is the short one
  pinch: 3, // weight on an INTERIOR line falling short of the target
  pinchHard: 40, // the same weight, for the second search that tries to un-pinch
  orphanCost: 50, // flat cost of a line the orphan rule refuses, in the relaxed pass
  hourglass: 300, // penalty on a wide→narrow→wide block, at a FIXED line count
  hourglassTol: 0.12, // dip below which a profile is not called an hourglass
  lineCost: 0.12, // mild preference for fewer lines

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
// the profile as a whole. An hourglass is both ends fuller than the middle, so
// the measure is `min(first, last) - min(interior)`, and it is only ever
// positive for a genuine pinch. A block whose last line is short - the ordinary,
// desirable case - has a small `edge` and scores zero here, which is the point:
// this must not become a tax on normal text.
//
// The inputs are fill ratios, each line's ink over that line's own allowance,
// which is what makes the rule survive a width that varies down the block. In an
// oval the first and last lines are physically the shortest strings in the
// block and are not a dip, because they are as full as the room they were given;
// what is a dip is a middle line loafing in the widest part of the balloon.
function hourglassPenalty(ratios, weight, tol) {
  if (ratios.length < 3) return 0;
  let mid = Infinity;
  for (let i = 1; i < ratios.length - 1; i++) mid = Math.min(mid, ratios[i]);
  const edge = Math.min(ratios[0], ratios[ratios.length - 1]);
  const dip = edge - mid - tol;
  return dip > 0 ? weight * dip * dip : 0;
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

// One paragraph - no newlines - as an array of lines.
function balanceParagraph(para, widthSpec, measureFn, o) {
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(para)) !== null) words.push({ s: m.index, e: m.index + m[0].length, t: m[0] });
  const n = words.length;
  if (n === 0) return ['']; // a blank paragraph is still a line, as in wrapLinesDOM

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
  const wcache = new Map();
  const wordsWidth = (i, j) => {
    const k = i * (n + 1) + j;
    let v = wcache.get(k);
    if (v === undefined) {
      v = measureFn(para.slice(words[i].s, words[j - 1].e));
      wcache.set(k, v);
    }
    return v;
  };
  const greedyAt = (w) => {
    const out = [];
    const allow = (k) => w[Math.min(k, w.length - 1)];
    let start = 0;
    for (let j = 2; j <= n; j++) {
      if (wordsWidth(start, j) > allow(out.length) + FIT_EPS) {
        out.push(para.slice(words[start].s, words[j - 2].e));
        start = j - 1;
      }
    }
    out.push(para.slice(words[start].s, words[n - 1].e));
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
  if (n > o.maxWords) return greedy();

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
  if (o.hyphenate) {
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
    // Through the same cache the greedy fallback uses, so a word is measured
    // once per paragraph however many of these passes want to know about it.
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
  const pos = [{ start: words[0].s, end: -1, hy: HY_NONE, wStart: 0, wEnd: -1 }];
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
  }
  const M = pos.length - 1; // the last position: the end of the paragraph
  if (M === 1) return [words[0].t]; // one word, nowhere to break it

  const lineText = (a, b) =>
    para.slice(pos[a].start, pos[b].end) + (pos[b].hy === HY_ADDED ? '-' : '');
  const tokens = (a, b) => pos[b].wEnd - pos[a].wStart + 1;

  const cache = new Map();
  // The measured width of the line as it will be DRAWN, hyphen included. A
  // hyphen that was not measured is a hyphen hanging out of the balloon.
  const width = (a, b) => {
    const k = a * (M + 1) + b;
    let v = cache.get(k);
    if (v === undefined) {
      v = measureFn(lineText(a, b));
      cache.set(k, v);
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
  const orphanOk = (a, b, L) =>
    L === 1 ||
    tokens(a, b) > 1 ||
    pos[a].hy !== HY_NONE ||
    pos[b].hy !== HY_NONE ||
    hasHangul(words[pos[a].wStart].t) ||
    letterCount(words[pos[a].wStart].t) >= o.minOrphan;

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

  // One line's cost, and the single place it is defined: the DP minimises the
  // sum of this and the scorer adds the same numbers up again over a finished
  // breaking. Two expressions of one cost function would be two answers to "is
  // this breaking better", and the search would be optimising something the
  // comparison did not believe.
  //
  // `pinchW` is a parameter for one reason only - the second, harder search in
  // `shaped` below. Every scoring call passes `o.pinch`.
  const lineCostOf = (a, b, k, L, T, w, pinchW) => {
    const W = w[k - 1];
    const r = width(a, b) / W;
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
    const over = (width(a, b) - W - FIT_EPS) / W;
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
  // later. The strings here are one speech bubble long, so the cubic worst case
  // is not a cost worth trading correctness for.
  //
  // Returns the cuts, not the cost: what a breaking costs is `score`'s business,
  // and this may have searched under a weight the score does not use.
  const solve = (L, allowOrphan, pinchW) => {
    const w = widthsOf(L);
    const T = targetFor(w);
    let prev = new Array(M + 1).fill(Infinity);
    prev[0] = 0;
    const back = [];
    for (let k = 1; k <= L; k++) {
      const cur = new Array(M + 1).fill(Infinity);
      const bk = new Array(M + 1).fill(-1);
      for (let b = k; b <= M; b++) {
        if (M - b < L - k) continue; // not enough text left to fill the remaining lines
        for (let a = k - 1; a < b; a++) {
          if (prev[a] === Infinity) continue;
          if (!fits(a, b, k, w)) continue;
          if (!allowOrphan && !orphanOk(a, b, L)) continue;
          const tot = prev[a] + lineCostOf(a, b, k, L, T, w, pinchW);
          // Strict `<` while `a` climbs, so a tie keeps the smallest `a` - the
          // one that put more words on the earlier line. That is the whole of
          // the tie-breaking rule inside a candidate, and it is why two runs on
          // the same input can never differ.
          if (tot < cur[b]) {
            cur[b] = tot;
            bk[b] = a;
          }
        }
      }
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

  // What a finished breaking is worth, always under the standard weights, so two
  // breakings found by two different searches can be compared at all.
  //
  //   merit  what the line-count race is run on: the separable costs plus the
  //          price of another line, and NOT the profile. A shape penalty in here
  //          is a shape penalty bidding against `lineCost`, which is how the
  //          block ends up growing a line to dodge a dip.
  //   cost   merit plus the profile penalty. Only ever compared between two
  //          breakings of the same `L`, where the extra line is not on the table.
  const score = (cuts, L) => {
    const w = widthsOf(L);
    const T = targetFor(w);
    let base = 0;
    for (let k = 1; k <= cuts.length; k++) {
      const [a, b] = cuts[k - 1];
      base += lineCostOf(a, b, k, L, T, w, o.pinch);
    }
    const ratios = cuts.map(([a, b], k) => width(a, b) / w[k]);
    const penalty = hourglassPenalty(ratios, o.hourglass, o.hourglassTol);
    const merit = base + o.lineCost * L;
    return { cuts, L, merit, cost: merit + penalty, penalty };
  };

  // The hourglass rule, applied where a profile exists and a line count is
  // already settled. The ordinary search minimises a sum of per-line costs and
  // cannot see the profile it is building; when what it built is a pinched one,
  // this asks the same question again with interior shortfalls weighted hard
  // enough to force the short line somewhere else, and keeps that answer only if
  // it is cheaper *under the ordinary weights plus the profile penalty*.
  //
  // So the heavy weight never prices anything - it only proposes. A proposal
  // that dodges the dip by making a mess of the raggedness loses on its own
  // merit, which is the property that makes the big `hourglass` weight safe.
  const shaped = (cand, allowOrphan) => {
    if (!cand || cand.penalty === 0) return cand;
    const alt = solve(cand.L, allowOrphan, o.pinchHard);
    if (!alt) return cand;
    const scored = score(alt, cand.L);
    return scored.cost < cand.cost ? scored : cand;
  };

  // Every line count from one up, and the cheapest wins. Ascending with a strict
  // `<` is the second half of the tie-breaking rule: equal cost goes to the
  // block with fewer lines.
  //
  // The ceiling is the number of break positions rather than the number of
  // words, because a single hyphenatable word is a paragraph that can legally
  // occupy three lines - which is the whole of the reference case.
  const maxL = Math.min(M, o.maxLines);
  const pick = (allowOrphan) => {
    let winner = null;
    for (let L = 1; L <= maxL; L++) {
      const cuts = solve(L, allowOrphan, o.pinch);
      if (!cuts) continue;
      const cand = score(cuts, L);
      if (!winner || cand.merit < winner.merit) winner = cand;
    }
    return shaped(winner, allowOrphan);
  };

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
  const winner = pick(false) ?? pick(true);
  return (winner?.cuts.map(([a, b]) => lineText(a, b))) ?? greedy();
}

// The public entry. `text` may contain newlines; each is a hard paragraph break
// the user typed, and each paragraph is balanced on its own - a shape is a
// property of a paragraph, and balancing across a deliberate break would move
// words over a line the user put there.
//
// `width` is either a number, meaning the same allowance for every line, or a
// callback `widthsFor(lineCount) -> number[]` handing back one allowance per
// line of a block of that many lines. The callback is asked once per candidate
// line count per paragraph and its answer is remembered, so it must be pure; it
// is not asked for a line count above `maxLines`.
export function balanceLines(text, width, measureFn, opts = {}) {
  const o = { ...TYPESET_DEFAULTS, ...opts };
  const src = text == null ? '' : String(text);
  const out = [];
  for (const para of src.split('\n')) out.push(...balanceParagraph(para, width, measureFn, o));
  return out.length ? out : [''];
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
