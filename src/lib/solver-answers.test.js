import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { solveLayout } from './auto-layout.js';
import { setTypesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';

// ===========================================================================
// The solver's answers, pinned
// ===========================================================================
// The solver is fast enough to run on every keystroke because of shortcuts it
// takes on the way to its answer: the breaker stops laying out a size once the
// text is certain to be too tall for the balloon, skips the line counts that
// have no breaking at all, and measures each line once (see
// solver-perf.realfont.test.js for the timings). None of them may change an
// answer - the size, the box and the lines are the document, and a chapter laid
// out yesterday has to come out the same today.
//
// So every answer here was recorded from the solver as it stood before any of
// them (src/test/solver-answers.json), and has to come back unchanged: long
// texts typed a few characters at a time into ovals, a rectangle and a click,
// in every alignment, with the locks, the silhouettes, an outline, paragraphs
// and hyphenation, from a reference size that fits and one that does not. On the
// stand-in metric (`chars x size x 0.55`), so the numbers are the same on every
// machine; the real-font lane checks the measuring shortcuts the same way.
//
// An answer that is meant to change is recorded again with
//
//   SOLVER_ANSWERS_WRITE=1 npx vitest run src/lib/solver-answers.test.js

const FIXTURE = fileURLToPath(new URL('../test/solver-answers.json', import.meta.url));
const WRITE = !!process.env.SOLVER_ANSWERS_WRITE;

beforeAll(() => {
  setTypesetEnabled(true);
  clearLayoutMemo();
});
afterAll(() => setTypesetEnabled(false));

const LATIN =
  'If we leave right now, we can still catch the last train before the storm hits the valley. ' +
  'I told you this morning that the bridge would not hold, and nobody listened to me, not even the captain. ' +
  'Now the river is rising, the road is gone, and the only way out of this town is the old mountain line.';
const PARAS = 'WAIT!\n\nYou mean the one with the red door? The one nobody has opened since the war ended?\nNo way.';
const LONG_WORDS = 'Unquestionably, extraordinarily, incomprehensibly complicated negotiations between the mother-in-law and the co-op.';
const CJK = 'いますぐ出発すれば、嵐が谷に来る前に最終電車に間に合うはずだ。橋はもたないと今朝言ったのに、誰も聞いてくれなかった。';

const OVAL = { kind: 'ellipse', cx: 400, cy: 400, rx: 170, ry: 140 };
const SMALL = { kind: 'ellipse', cx: 300, cy: 300, rx: 90, ry: 70 };
const RECT = { kind: 'rect', x: 220, y: 260, w: 360, h: 280 };
const HINT = { kind: 'hint', x: 380, y: 380, w: 40, h: 40 };
const BOX = { x: 250, y: 300, w: 300, h: 200 };

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), bold: false, ...over });

// Every `step`th prefix of the text, and the whole of it: typing, sampled.
const typed = (text, step) => {
  const cs = [...text];
  const out = [];
  for (let i = step - 1; i < cs.length; i += step) out.push(cs.slice(0, i + 1).join(''));
  out.push(text);
  return [...new Set(out)].filter((t) => /\S/.test(t));
};

const GROUPS = [
  ['oval centred', typed(LATIN, 9), style(), OVAL],
  ['oval left', typed(LATIN, 23), style({ align: 'left' }), OVAL],
  ['oval right top', typed(LATIN, 29), style({ align: 'right', valign: 'top' }), OVAL],
  ['oval bottom caps', typed(LATIN, 29), style({ valign: 'bottom', uppercase: true }), OVAL],
  ['small oval outline', typed(LATIN, 31), style({ strokes: [{ color: '#fff', width: 6, opacity: 1 }] }), SMALL],
  ['rect', typed(LATIN, 23), style(), RECT],
  ['oval silhouette', typed(LATIN, 37), style({ shape: 'oval' }), OVAL],
  ['rect silhouette, tight leading', typed(LATIN, 37), style({ shape: 'rect', lineHeight: 0.9 }), OVAL],
  ['flat, no hyphens', typed(LATIN, 37), style({ balloon: false, hyphenate: false, lineHeight: 1.4 }), SMALL],
  ['paragraphs', typed(PARAS, 7), style(), OVAL],
  ['long words', typed(LONG_WORDS, 11), style(), SMALL],
  ['cjk', typed(CJK, 5), style(), OVAL],
  ['hint', typed(LATIN, 41), style(), HINT],
  ['no region', typed(LATIN.slice(0, 120), 29), style(), null],
  ['locked position', typed(LATIN, 41), style(), OVAL, { pos: true }],
  ['locked width', typed(LATIN, 41), style({ align: 'left' }), OVAL, { width: true }],
  ['locked height', typed(LATIN, 41), style(), OVAL, { height: true }],
  ['locked size', typed(LATIN, 53), style(), OVAL, { size: true }],
];

function answers() {
  const out = {};
  for (const [name, texts, s, region, locks] of GROUPS) {
    texts.forEach((text, i) => {
      for (const refSize of [22, 40]) {
        const r = solveLayout({
          text,
          style: s,
          refSize,
          region,
          locks,
          opts: { minSize: 12, minW: 30, minH: 20, box: BOX, page: { w: 800, h: 1200 } },
        });
        out[`${name} #${i} @${refSize}`] = fingerprint(r);
      }
    });
  }
  return out;
}

// The whole answer - size, box, lines, status, reasons, flag - as a short hash,
// its numbers to a millionth of a pixel.
function fingerprint(r) {
  const s = JSON.stringify(r, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

describe('the solver answers as it always has', () => {
  it('matches every recorded answer', () => {
    const got = answers();
    if (WRITE) {
      writeFileSync(FIXTURE, JSON.stringify(got, null, 1) + '\n');
      return;
    }
    const want = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(Object.keys(got)).toEqual(Object.keys(want));
    const changed = Object.keys(want).filter((k) => got[k] !== want[k]);
    expect(changed).toEqual([]);
    // Four hundred solves in one test: a second alone, and several times that
    // beside the rest of the suite on a busy machine, where the default five
    // seconds failed it for nothing.
  }, 30000);
});
