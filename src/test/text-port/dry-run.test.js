import { describe, it, expect } from 'vitest';
import { at, storedIds, assertPartners, unrepairedPages, changeOf, caseIdOf, INK_TOL_PX } from '../../../scripts/text-port/lib/dry-compare.mjs';
import { explain, inkMoved } from '../../../scripts/text-port/lib/dry-report.mjs';

// The dry run of P9 (scripts/text-port/dry-run.mjs) says "0 boxes changed
// their width" and "0 changes unexplained" of the user's chapters. These are
// the ways it could say 0 when it is not, as an outside review found them:
// each is the pure part of the tool that decides it, on made-up numbers.

const geom = { x: 10, y: 20, w: 100, h: 200, size: 30, review: null };
const font = { missing: false, kind: 'user', drawnIn: 'A', borrowed: [], none: [], unread: [], fauxBold: false };
const LINES = ['ONE', 'TWO'];
// A block of two lines in the middle of its box, as each engine placed it.
const wkOf = (over = {}) => ({ lines: LINES, lineX: [50, 50], blockY: 60, blockH: 66, ink: { l: 12, t: 64, r: 88, b: 122 }, verdict: { fits: true, overflow: { l: 0, t: 0, r: 0, b: 0 } }, ...over });
const layOf = (over = {}) => ({ lines: LINES, lineX: [50, 50], blockY: 60, blockH: 66, ink: { l: 12, t: 64, r: 88, b: 122 }, curve: false, fits: true, overflow: { l: 0, t: 0, r: 0, b: 0 }, ...over });
const rowOf = (lay, over = {}) => ({ ...geom, font: 'A', mode: 'smart', valign: 'middle', fontFacts: font, rust: { state: { ...geom }, lay }, browser: null, ...over });

describe('a stored box and the box the open made of it', () => {
  const pages = [
    { id: 1, boxes: [{ id: 'b1' }, { text: 'no id' }, { id: 'b1' }] },
    { id: 2, boxes: [{ id: 'b9' }] },
  ];

  it('are matched by where the box stands, and a box whose id the load repairs is named by its place', () => {
    const { ids, repaired } = storedIds('ch', pages);
    expect(ids.get(at(0, 0))).toBe(caseIdOf('ch', pages[0], 0, pages[0].boxes[0], 0));
    expect(ids.get(at(0, 1))).toBe('c.ch.p1.at1');
    expect(ids.get(at(0, 2))).toBe('c.ch.p1.at2');
    expect(ids.get(at(1, 0))).toBe('c.ch.p2.bb9');
    expect(new Set(ids.values()).size).toBe(4);
    expect(repaired).toEqual(['c.ch.p1.at1', 'c.ch.p1.at2']);
  });

  it('a stored box with no partner after the open is an error of the run, by name', () => {
    const open = [{ boxes: [{}, {}, {}] }, { boxes: [{}] }];
    expect(() => assertPartners('ch', pages, open, 'the open')).not.toThrow();
    expect(() => assertPartners('ch', pages, [{ boxes: [{}, {}] }, { boxes: [{}] }], 'the open')).toThrow('ch: the open has 2 boxes on page 1 where the file has 3');
    expect(() => assertPartners('ch', pages, [open[0]], 'the open')).toThrow('ch: the open has 1 pages where the file has 2');
  });
});

describe('a page the loader repairs from its picture', () => {
  it('is found: art replaced at another size, or no size at all', () => {
    expect(unrepairedPages({ pages: [{ w: 800, h: 1200 }, { w: 800, h: 1200, needsRespace: true }, { w: 0, h: 0 }, { w: 800, h: 1200, needsRespace: false }] })).toEqual([
      { page: 2, why: expect.stringContaining('needsRespace') },
      { page: 3, why: expect.stringContaining('no size') },
    ]);
    expect(unrepairedPages({ pages: [{ w: 800, h: 1200 }] })).toEqual([]);
  });
});

describe('a box whose layout threw', () => {
  it('is not an unchanged box: it stops the run, by name', () => {
    const rust = { state: { ...geom }, lay: { error: 'the measure threw' } };
    expect(() => changeOf({ id: 'c.ch.p1.bb1', stored: geom, rust, wk: wkOf(), font })).toThrow('c.ch.p1.bb1: no layout under the Rust engine (the measure threw)');
  });
});

describe('a block that moved and nothing else did', () => {
  // The engine's ink sits 1.5 px higher against the line boxes, top and
  // bottom: a block centred on its ink is then 1.5 px lower.
  const moved = (dy, ink = dy) => layOf({ blockY: 60 + dy, ink: { l: 12, t: 64 + dy - ink, r: 88, b: 122 + dy - ink } });
  const cause = (row, wk = wkOf()) => {
    const c = changeOf({ stored: row, rust: row.rust, wk, font: row.fontFacts });
    return { c, moved: explain(row, c, wk).find((x) => x.what === 'moved') };
  };

  it('is the ink boxes when they predict the shift that is seen', () => {
    const { c, moved: m } = cause(rowOf(moved(1.5)));
    expect(c.moved).toBe(true);
    expect(c.ink.predictedDy).toBeCloseTo(1.5, 10);
    expect(m.rule).toBe('rule 4');
    expect(m.cause).toContain('1.5 px down');
  });

  it('is unexplained when they do not: a block 100 px from where the ink boxes put it', () => {
    const { c, moved: m } = cause(rowOf(moved(100, 1.5)));
    expect(c.ink.predictedDy).toBeCloseTo(1.5, 10);
    expect(m).toEqual({ what: 'moved', cause: null, rule: '' });
    // Just past the tolerance is unexplained too; just inside is not.
    expect(cause(rowOf(moved(1.5 + INK_TOL_PX * 2, 1.5))).moved.cause).toBe(null);
    expect(cause(rowOf(moved(1.5 + INK_TOL_PX / 2, 1.5))).moved.rule).toBe('rule 4');
  });

  it('is unexplained in a block that is not set in the middle: only that alignment is centred on ink', () => {
    expect(cause(rowOf(moved(1.5), { valign: 'top' })).moved.cause).toBe(null);
    expect(cause(rowOf(moved(1.5), { valign: 'bottom' })).moved.cause).toBe(null);
  });

  it('is unexplained when it moved sideways, or when either ink box was not recorded', () => {
    expect(cause(rowOf({ ...moved(1.5), lineX: [53, 50] })).moved.cause).toBe(null);
    expect(cause(rowOf({ ...moved(1.5), ink: null })).moved.cause).toBe(null);
    expect(cause(rowOf(moved(1.5)), wkOf({ ink: null })).moved.cause).toBe(null);
    expect(inkMoved({ valign: 'middle' }, { ink: null, blockDy: 1.5, blockDx: 0 })).toBe(false);
  });

  it('a missing font is still said first, since that is a recorded fact', () => {
    const row = rowOf(moved(100, 1.5), { fontFacts: { ...font, missing: true, kind: 'builtin', drawnIn: 'Helvetica Neue' } });
    expect(cause(row).moved.rule).toBe('D2b');
  });
});

describe('a flag the open raises or clears', () => {
  const over = { l: 0, t: 0, r: 3, b: 0 };
  const flagged = () => rowOf(layOf({ fits: false, overflow: over }), { rust: { state: { ...geom, review: { reason: 'no longer fits', overflow: over, stored: true } }, lay: layOf({ fits: false, overflow: over }) } });
  const cause = (row, wk, what) => explain(row, changeOf({ stored: row, rust: row.rust, wk, font: row.fontFacts }), wk).find((x) => x.what === what);

  it('is the ink boxes only when Safari\'s own check of the same lines says the opposite', () => {
    expect(cause(flagged(), wkOf(), 'newlyFlagged').rule).toBe('rule 4');
    // Safari has no record of the box: nothing to set the engine's verdict against.
    expect(cause(flagged(), null, 'newlyFlagged').cause).toBe(null);
    // Safari overflows too: the file was behind, not the engine.
    expect(cause(flagged(), wkOf({ verdict: { fits: false, overflow: over } }), 'newlyFlagged').rule).toBe('stale file');
  });

  it('and a flag cleared likewise', () => {
    const cleared = rowOf(layOf(), { review: { reason: 'no longer fits', overflow: over, stored: true } });
    expect(cause(cleared, wkOf({ verdict: { fits: false, overflow: over } }), 'unflagged').rule).toBe('rule 4');
    expect(cause(cleared, null, 'unflagged').cause).toBe(null);
  });
});
