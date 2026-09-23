import { describe, it, expect, beforeAll, vi } from 'vitest';
import { resolve } from 'node:path';

// ===========================================================================
// The lettering benchmark (TST-2)
// ===========================================================================
// Twenty-odd synthetic balloons (src/test/typeset-bench/cases.js), each run
// through the app's own placement and layout with real fonts, and measured: ink
// inside the box and the balloon, size against a letterer's, line count, shape
// of the block against an oval and a rectangle, notches, orphans, hyphens. See
// runner.js for what each number means and src/test/typeset-bench/README.md for
// how to run it and read it.
//
// What this file asserts is only what has to hold for the numbers to mean
// anything: every case runs, every case gets a box with lines in it, every
// metric is a number. How GOOD the layout is is not asserted - that is what the
// table and the report are for, and what `approved.json` tracks.
//
// Environment (set by scripts/typeset-bench.mjs, or by hand):
//   TYPESET_BENCH_OUT      a directory: write report.json and one contact sheet
//                          per category there.
//   TYPESET_BENCH_APPROVE  'all' or case ids, comma-separated: record those
//                          cases' current layout in approved.json.
//   TYPESET_BENCH_LAYOUT   a module whose default (or `layout`) export replaces
//                          the store's placement as the layout under test.
//
// The page pixels reach the store the way balloon-wiring.test.js hands them
// over: `pagePixelsFor` is the one function replaced, and it answers with the
// page the runner drew for the case being run. Balloon detection itself is the
// real `detectBalloon`.
let pixels = null;
vi.mock('./page-pixels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  pagePixelsFor: () => pixels,
}));

const bench = await import('../test/typeset-bench/runner.js');
const { CASES } = await import('../test/typeset-bench/cases.js');

const OUT = process.env.TYPESET_BENCH_OUT || null;
const APPROVE = process.env.TYPESET_BENCH_APPROVE || null;
const LAYOUT = process.env.TYPESET_BENCH_LAYOUT || null;

async function layoutUnderTest() {
  if (!LAYOUT) return { name: 'store placement', fn: bench.storeLayout };
  const mod = await import(/* @vite-ignore */ resolve(LAYOUT));
  const fn = typeof mod.default === 'function' ? mod.default : mod.layout;
  if (typeof fn !== 'function') throw new Error(`${LAYOUT}: exports no layout function (default or \`layout\`)`);
  return { name: LAYOUT, fn };
}

function summary(results, layoutName) {
  const count = (pred) => results.filter(pred).map((r) => r.id);
  const status = (s) => count((r) => r.approval.status === s).length;
  const list = (ids) => ids.join(' ') || 'none';
  const lines = [
    `typeset bench: ${results.length} cases, layout: ${layoutName}`,
    `  approval: ${status('same')} same, ${status('changed')} changed, ${status('new')} not approved`,
    `  ink past the box (> 0.5 px): ${list(count((r) => r.metrics.boxOverflow > 0.5))}`,
    `  ink outside the balloon: ${list(count((r) => r.metrics.inkInBalloon != null && r.metrics.inkInBalloon < 0.999))}`,
    `  orphans: ${list(count((r) => r.metrics.orphan))}; hyphen breaks: ${list(count((r) => r.metrics.hyphens > 0))}`,
  ];
  // Only a plugged-in layout can disagree with the exporter, and when it does
  // the ink numbers describe the exporter's lines, not the layout's.
  const differs = count((r) => !r.metrics.renderMatches);
  if (differs.length) lines.push(`  drawn differently by the exporter: ${list(differs)}`);
  return lines.join('\n');
}

describe('the lettering benchmark', () => {
  let results;
  beforeAll(async () => {
    const layout = await layoutUnderTest();
    results = await bench.runBench(CASES, {
      layout: layout.fn,
      setPixels: (img) => {
        pixels = img;
      },
      approved: bench.readApproved(),
      keepArt: !!OUT,
    });
    pixels = null;
    console.log(`${bench.benchTable(results)}\n\n${summary(results, layout.name)}`);
    if (OUT) {
      const dir = resolve(OUT);
      const files = [bench.writeReport(results, dir, { layout: layout.name }), ...bench.writeContactSheets(results, dir)];
      console.log(`wrote:\n  ${files.join('\n  ')}`);
    }
    if (APPROVE) {
      const ids = APPROVE === 'all' ? 'all' : APPROVE.split(',').map((s) => s.trim());
      const unknown = ids === 'all' ? [] : ids.filter((id) => !CASES.some((c) => c.id === id));
      console.log(`approved: ${bench.approve(results, ids).join(' ') || 'nothing'}`);
      if (unknown.length) console.log(`no such case: ${unknown.join(' ')}`);
    }
  });

  it('runs every case, and places a box with lines in it', () => {
    expect(results.map((r) => r.id)).toEqual(CASES.map((c) => c.id));
    for (const r of results) {
      const { x, y, w, h, size, lines } = r.layout;
      for (const v of [x, y, w, h, size]) expect(Number.isFinite(v), `${r.id}: ${v}`).toBe(true);
      expect(w, r.id).toBeGreaterThan(0);
      expect(h, r.id).toBeGreaterThan(0);
      expect(lines.length, r.id).toBeGreaterThan(0);
      expect(lines.join(''), r.id).not.toBe('');
    }
  });

  it('gives every metric a number, or null where it does not apply', () => {
    for (const r of results) {
      const m = r.metrics;
      const numbers = [m.boxOverflow, m.glyphOverflow, m.sizeRatio, m.lineCount, m.aspect, m.ovalScore, m.rectScore, m.ragged, m.hyphens];
      for (const v of numbers) expect(Number.isFinite(v), `${r.id}: ${JSON.stringify(m)}`).toBe(true);
      // Over the art there is no balloon to be inside of or to fill.
      const inBalloon = CASES.find((c) => c.id === r.id).balloon != null;
      for (const v of [m.inkInBalloon, m.fill]) {
        if (inBalloon) expect(Number.isFinite(v), `${r.id}: ${JSON.stringify(m)}`).toBe(true);
        else expect(v, r.id).toBeNull();
      }
      expect(typeof m.orphan, r.id).toBe('boolean');
      expect(typeof m.renderMatches, r.id).toBe('boolean');
    }
  });
});
