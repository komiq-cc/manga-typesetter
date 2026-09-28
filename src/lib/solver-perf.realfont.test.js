import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { performance } from 'node:perf_hooks';

// ===========================================================================
// The solver, timed per keystroke (FIT-2 / ARC-1), with real fonts
// ===========================================================================
// Typing into an auto box re-solves it on every keystroke (`setBoxText` ->
// `autoFitBox` -> `resolveBox` -> `solveLayout`), so one solve has to fit inside
// a frame: the budget is 8 ms at the 95th percentile, a 120 Hz frame on the
// machine that runs it. Each case types a long text in one character at a time,
// from a reference size the balloon cannot hold, so every solve runs the binary
// search, and times each solve.
//
// The timings only run when asked for - they depend on the machine, and a
// loaded CI runner would fail them for nothing:
//
//   SOLVER_PERF=1 npx vitest run --project realfont src/lib/solver-perf.realfont.test.js
//
// What always runs is the part that is not about the machine: the measuring the
// solver keeps from one layout and one keystroke to the next changes no answer,
// and an edit to one box re-solves that box, and no other box on its page or in
// its chapter.

// Every solve the store asks for, by the text it was asked about - the real
// solver, only watched.
const solves = [];
vi.mock('./auto-layout.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    solveLayout: (args) => {
      solves.push(args?.text ?? null);
      return mod.solveLayout(args);
    },
  };
});

// A font set for measure.js to watch, before it is loaded: while it says a face
// is loading, nothing measured is kept or read back (DET-4), which is the
// measuring without any of the shortcuts - the reference the kept measurements
// are checked against below.
const fontSet = { status: 'loaded', addEventListener() {} };
globalThis.document.fonts = fontSet;

const { app, loadProjectPages, setBoxText, page } = await import('./store.svelte.js');
const { solveLayout } = await import('./auto-layout.js');
const { setTypesetEnabled, clearLayoutMemo } = await import('./measure.js');
const { systemFontEntry } = await import('./fonts.js');
const { defaultStyle, normalizeStyle, normalizeAuto } = await import('./data.js');

const PERF = !!process.env.SOLVER_PERF;
const BUDGET_P95_MS = 8;

const LATIN =
  'If we leave right now, we can still catch the last train before the storm hits the valley. ' +
  'I told you this morning that the bridge would not hold, and nobody listened to me, not even the captain. ' +
  'Now the river is rising, the road is gone, and the only way out of this town is the old mountain line. ' +
  'So pack what you can carry, forget the rest, and meet me at the station before the clock strikes nine.';
const CJK =
  'いますぐ出発すれば、嵐が谷に来る前に最終電車に間に合うはずだ。橋はもたないと今朝言ったのに、誰も聞いてくれなかった。' +
  '川は増水して道はもうない。この町から出る道は古い山の線路だけだ。持てるものだけ持って、九時までに駅に来てくれ。';

const OVAL = { kind: 'ellipse', cx: 400, cy: 400, rx: 170, ry: 140 };
const RECT = { kind: 'rect', x: 220, y: 260, w: 360, h: 280 };
const styleFor = (font, extra = {}) => normalizeStyle({ ...defaultStyle(), font, bold: false, ...extra });

const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const stats = (xs) => ({ n: xs.length, median: pct(xs, 0.5), p95: pct(xs, 0.95), max: Math.max(...xs) });
const fmt = (name, s) =>
  `${name.padEnd(34)} n=${String(s.n).padStart(4)}  median ${s.median.toFixed(2)} ms  p95 ${s.p95.toFixed(2)} ms  max ${s.max.toFixed(2)} ms`;

// Each prefix of the text, one keystroke apart - skipping the blank ones, which
// the solver does not lay out.
const keystrokes = (text) => [...text].map((_, i) => [...text].slice(0, i + 1).join('')).filter((t) => /\S/.test(t));

beforeAll(() => {
  setTypesetEnabled(true);
  clearLayoutMemo();
  app.fonts.system = [systemFontEntry({ name: 'DejaVu Sans', faces: { regular: true, italic: true } })];
});
afterAll(() => {
  setTypesetEnabled(false);
  clearLayoutMemo();
});

const CASES = [
  { name: 'latin, oval, centred', text: LATIN, style: styleFor('Comic Neue'), region: OVAL },
  { name: 'latin, oval, left', text: LATIN, style: styleFor('Comic Neue', { align: 'left' }), region: OVAL },
  { name: 'latin, rect, centred', text: LATIN, style: styleFor('Comic Neue'), region: RECT },
  { name: 'latin caps, oval, Bangers', text: LATIN, style: styleFor('Bangers', { uppercase: true }), region: OVAL },
  { name: 'cjk, oval, centred', text: CJK, style: styleFor('DejaVu Sans'), region: OVAL },
];
const REF = 40;
const MIN = 12;

describe('what the solver keeps between keystrokes', () => {
  it('changes no answer', () => {
    let n = 0;
    for (const c of CASES) {
      clearLayoutMemo();
      // Every 23rd keystroke, so the text grows the way typing grows it, and
      // then a few taken back. Sampled: measuring afresh is slow here.
      const texts = keystrokes(c.text).filter((_, i) => i % 23 === 0);
      texts.push(...texts.slice(-4, -1).reverse());
      for (const text of texts) {
        const args = { text, style: c.style, refSize: REF, region: c.region, opts: { minSize: MIN, minW: 30, minH: 20 } };
        fontSet.status = 'loading';
        const fresh = solveLayout(args);
        fontSet.status = 'loaded';
        expect(solveLayout(args), `${c.name}: ${text.length} chars`).toEqual(fresh);
        n++;
      }
    }
    expect(n).toBeGreaterThan(80);
  }, 60000);
});

describe.skipIf(!PERF)('solveLayout per keystroke (SOLVER_PERF=1)', () => {
  const all = [];
  for (const c of CASES) {
    it(c.name, () => {
      const times = [];
      for (const text of keystrokes(c.text)) {
        const t0 = performance.now();
        solveLayout({ text, style: c.style, refSize: REF, region: c.region, opts: { minSize: MIN, minW: 30, minH: 20 } });
        times.push(performance.now() - t0);
      }
      all.push(...times);
      console.log(fmt(c.name, stats(times)));
    });
  }
  it('all cases', () => {
    const s = stats(all);
    console.log(fmt('ALL solveLayout', s));
    expect(s.p95).toBeLessThan(BUDGET_P95_MS);
  });
});

// A chapter of auto boxes, each solved into its balloon, as placement leaves
// them. The width is not locked: a first edit may still re-place the box, as it
// would in the app.
const PAGES = 40;
const PER_PAGE = 8;
function chapter() {
  const s = styleFor('Comic Neue');
  const pages = [];
  for (let p = 0; p < PAGES; p++) {
    const boxes = [];
    for (let i = 0; i < PER_PAGE; i++) {
      const cx = 200 + (i % 2) * 400;
      const cy = 150 + Math.floor(i / 2) * 300;
      const fit = { kind: 'ellipse', cx, cy, rx: 150, ry: 110 };
      boxes.push({
        id: `b${p * PER_PAGE + i + 1}`,
        lineN: null,
        text: LATIN.slice(0, 60 + i * 10),
        x: cx - 100,
        y: cy - 60,
        w: 200,
        h: 120,
        style: { ...s, size: REF },
        fit,
        auto: normalizeAuto({ refSize: REF }),
      });
    }
    pages.push({ id: p + 1, w: 800, h: 1200, lines: [], boxes });
  }
  return pages;
}

describe('an edit re-solves only the box it edits', () => {
  it('typing into one box of a 40 x 8 chapter solves that box, once a keystroke', () => {
    loadProjectPages(chapter());
    app.pageIndex = 7;
    const p = page();
    const b = p.boxes[3];
    const typed = keystrokes(LATIN).slice(40, PERF ? 400 : 80);
    const times = [];
    solves.length = 0;
    for (const text of typed) {
      const t0 = performance.now();
      setBoxText(b, text, p);
      times.push(performance.now() - t0);
    }
    // One solve a keystroke, each of the text just typed: no other box on the
    // page or in the chapter was solved again.
    expect(solves).toEqual(typed);
    if (PERF) {
      const s = stats(times);
      console.log(fmt('store setBoxText, chapter', s));
      expect(s.p95).toBeLessThan(BUDGET_P95_MS);
    }
  });
});
