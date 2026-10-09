import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { at, storedIds, assertPartners, unrepairedPages, changeOf, caseIdOf, INK_TOL_PX } from '../../../scripts/text-port/lib/dry-compare.mjs';
import { explain, inkMoved, stripAgainst, assertLanePassed, assertReportRecords } from '../../../scripts/text-port/lib/dry-report.mjs';
import { predictMiddle } from '../../../scripts/text-port/lib/dry-metrics.mjs';

// The dry run of P9 (scripts/text-port/dry-run.mjs) says "0 boxes changed
// their width" and "0 changes unexplained" of the user's chapters. These are
// the ways it could say 0 when it is not, as an outside review found them:
// each is the pure part of the tool that decides it, on made-up numbers.

const geom = { x: 10, y: 20, w: 100, h: 200, size: 30, review: null };
const font = { missing: false, kind: 'user', drawnIn: 'A', borrowed: [], none: [], unread: [], fauxBold: false };
const LINES = ['ONE', 'TWO'];
const directOf = (inkShift = 0, ascent = 24) => ({ font: { ascent, descent: 6 }, inks: [{ ascent: 22 + inkShift, descent: 3 - inkShift }, { ascent: 22 + inkShift, descent: 3 - inkShift }], lineH: 33 });
// A block of two lines in the middle of its box, as each engine placed it.
const wkOf = (over = {}) => ({ directMetrics: directOf(), lines: LINES, lineX: [50, 50], blockY: 60, blockH: 66, ink: { l: 12, t: 64, r: 88, b: 122 }, verdict: { fits: true, overflow: { l: 0, t: 0, r: 0, b: 0 } }, ...over });
const layOf = (over = {}) => ({ directMetrics: directOf(), lines: LINES, lineX: [50, 50], blockY: 60, blockH: 66, ink: { l: 12, t: 64, r: 88, b: 122 }, curve: false, fits: true, overflow: { l: 0, t: 0, r: 0, b: 0 }, ...over });
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
  const moved = (dy, ink = dy) => layOf({ directMetrics: directOf(ink), blockY: 60 + dy, ink: { l: 12, t: 64 + dy - ink, r: 88, b: 122 + dy - ink } });
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

  it('is unexplained when it moved sideways, or when either direct metric record was not recorded', () => {
    expect(cause(rowOf({ ...moved(1.5), lineX: [53, 50] })).moved.cause).toBe(null);
    expect(cause(rowOf({ ...moved(1.5), directMetrics: null })).moved.cause).toBe(null);
    expect(cause(rowOf(moved(1.5)), wkOf({ directMetrics: null })).moved.cause).toBe(null);
    expect(inkMoved({ valign: 'middle' }, { ink: null, blockDy: 1.5, blockDx: 0 })).toBe(false);
  });

  it('names a changed line-box baseline as rule 3, even with unchanged ink', () => {
    const changed = moved(-100, 0);
    changed.directMetrics = directOf(0, 224);
    const { c, moved: m } = cause(rowOf(changed));
    expect(c.ink).toMatchObject({ lineDy: -100, inkDy: 0, predictedDy: -100 });
    expect(m.rule).toBe('rule 3');
    expect(inkMoved(rowOf(changed), c)).toBe(false);
  });

  it('names both rules when both direct metric contributions predict the shift', () => {
    const changed = moved(-98.5, 1.5);
    changed.directMetrics = directOf(1.5, 224);
    expect(cause(rowOf(changed)).moved.rule).toBe('rules 3, 4');
  });

  it('predicts independently of positioned ink and blockY', () => {
    const corrupted = moved(100, 1.5);
    // If this positioned rectangle feeds prediction, the fault explains itself.
    corrupted.ink = { l: 0, t: -900, r: 50, b: 1200 };
    const { c, moved: m } = cause(rowOf(corrupted));
    expect(c.ink.predictedDy).toBeCloseTo(1.5, 10);
    expect(m.cause).toBe(null);
  });

  it('a missing font explains only the placement independently predicted by its direct metrics', () => {
    const row = rowOf(moved(1.5, 1.5), { fontFacts: { ...font, missing: true, kind: 'builtin', drawnIn: 'Helvetica Neue' } });
    expect(cause(row).moved.rule).toBe('D2b');
  });

  it('a missing font cannot hide an unrelated 100 px placement error', () => {
    const row = rowOf(moved(100, 1.5), { fontFacts: { ...font, missing: true, kind: 'builtin', drawnIn: 'Helvetica Neue' } });
    expect(cause(row).moved.cause).toBe(null);
    expect(cause(rowOf(moved(100, 0), { fontFacts: { ...font, missing: true, borrowed: [{ family: 'Elsewhere' }] } })).moved.cause).toBe(null);
  });

  it('different line counts predict vertical placement but unknown horizontal placement cannot hide a 100 px shift or claim rule 4', () => {
    const shorter = { ...directOf(), inks: directOf().inks.slice(0, 1) };
    expect(predictMiddle(directOf(), shorter).predictedDy).toBe(16.5);
    const changed = moved(16.5, 0);
    changed.lines = ['ONE'];
    changed.lineX = [50];
    changed.directMetrics = shorter;
    // Line correspondence is unknown after wrapping changes; the independent
    // vertical prediction alone cannot establish horizontal placement.
    expect(cause(rowOf(changed)).moved.cause).toBe(null);
    changed.lineX = changed.lineX.map((x) => x + 100);
    expect(cause(rowOf(changed)).moved.cause).toBe(null);
    expect(cause(rowOf(changed, { fontFacts: { ...font, missing: true } })).moved.cause).toBe(null);
    changed.blockY += 100;
    expect(cause(rowOf(changed)).moved.cause).toBe(null);
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

  // Past the top, so not the sideways overhang: the second way a new flag is
  // the ink boxes, when the stand-in browser, which measures real ink too,
  // flags it as well. That is not enough without Safari's own check.
  it('past the top or bottom, the stand-in flagging it too is not enough without Safari\'s check', () => {
    const top = { l: 0, t: 2, r: 0, b: 0 };
    const row = () => rowOf(layOf({ fits: false, overflow: top }), {
      rust: { state: { ...geom, review: { reason: 'no longer fits', overflow: top, stored: true } }, lay: layOf({ fits: false, overflow: top }) },
      browser: { state: { ...geom, review: { reason: 'no longer fits', overflow: top, stored: true } } },
    });
    expect(cause(row(), wkOf(), 'newlyFlagged').rule).toBe('rule 4');
    expect(cause(row(), null, 'newlyFlagged').cause).toBe(null);
    // Without the stand-in's agreement either: unexplained.
    expect(cause({ ...row(), browser: null }, wkOf(), 'newlyFlagged').cause).toBe(null);
  });

  it('and a flag cleared likewise', () => {
    const cleared = rowOf(layOf(), { review: { reason: 'no longer fits', overflow: over, stored: true } });
    expect(cause(cleared, wkOf({ verdict: { fits: false, overflow: over } }), 'unflagged').rule).toBe('rule 4');
    expect(cause(cleared, null, 'unflagged').cause).toBe(null);
  });
});

describe('the same box opened as a long strip', () => {
  const pages = { x: 10, y: 214.97986469072166, w: 200, h: 48, size: 20, review: null };
  it('is the same box when nothing differs', () => {
    expect(stripAgainst(pages, { ...pages })).toBe('same');
  });
  it('differs only by the strip\'s arithmetic when its top came back in other last bits', () => {
    expect(stripAgainst(pages, { ...pages, y: 214.97986469072157 })).toBe('noise');
  });
  it('differs when a number does: a top the page held at its edge and the strip did not', () => {
    expect(stripAgainst({ ...pages, y: 0 }, { ...pages, y: -15.85 })).toBe('differs');
    expect(stripAgainst(pages, { ...pages, h: 48.01 })).toBe('differs');
  });
  it('differs when the flag does, whatever the numbers', () => {
    expect(stripAgainst(pages, { ...pages, review: { reason: 'overflow' } })).toBe('differs');
  });
});


describe('a report needs the lane’s own passing verdict', () => {
  const pass = () => ({ verdict: { complete: true, passed: true, layoutFailures: [], paintFailures: [] }, chapters: [{ paintFailures: [] }] });
  it.each([
    ['missing', {}],
    ['incomplete', { verdict: { complete: false, passed: false } }],
    ['failed', { verdict: { complete: true, passed: false, layoutFailures: [], paintFailures: [] } }],
    ['layout failed', { ...pass(), verdict: { ...pass().verdict, layoutFailures: ['box failed'] } }],
    ['paint failed', { ...pass(), verdict: { ...pass().verdict, paintFailures: ['box failed'] } }],
    ['paint metadata contradicts the verdict', { ...pass(), chapters: [{ paintFailures: ['box failed'] }] }],
  ])('refuses a %s lane', (_, run) => {
    expect(() => assertLanePassed(run)).toThrow('no report can be written');
  });
  it('accepts only a completed passing lane', () => {
    expect(() => assertLanePassed(pass())).not.toThrow();
  });
  it.each(['layout', 'paint', 'record completeness'])('--report-only exits 1 and creates no signable report for failed %s', (kind) => {
    const scratch = mkdtempSync(join(tmpdir(), 'p9-report-refusal-'));
    try {
      mkdirSync(join(scratch, 'raw'));
      const run = { ...pass(), chapters: [], wasm: 'synthetic', legacyMode: 'smart', userFamilies: 0, installedFamilies: 0, lastResort: null, wkCases: 0, lettersAsked: {}, systemFacesServed: {} };
      const sources = {};
      for (const file of ['fonts/fonts.json', 'corpus/layout.json', 'runs/ref-wk/base/layout.jsonl']) {
        const path = join(scratch, file);
        mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
        const content = file.endsWith('.jsonl') ? '' : '{}';
        writeFileSync(path, content);
        sources[file] = createHash('sha256').update(content).digest('hex');
      }
      writeFileSync(join(scratch, 'raw/direct-webkit.json'), JSON.stringify({ schema: 1, engine: 'system-webkit', complete: true, errors: [], sources, records: [] }));
      writeFileSync(join(scratch, 'raw/boxes.jsonl'), '');
      if (kind === 'record completeness') run.chapters = [{ chapter: 'one', boxes: 1, boxIds: ['a'], pages: 1, mode: 'smart', modeFrom: 'file', version: 1, idsRepaired: [], paintFailures: [] }];
      else run.verdict[`${kind}Failures`].push('synthetic failure');
      writeFileSync(join(scratch, 'raw/run.json'), JSON.stringify(run));
      const child = spawnSync(process.execPath, ['scripts/text-port/dry-run.mjs', '--data', scratch, '--out', scratch, '--report-only', 'yes'], { encoding: 'utf8' });
      expect(child.status, child.stdout + child.stderr).toBe(1);
      expect(child.stderr).toContain('no report can be written');
      expect(existsSync(join(scratch, 'report.html'))).toBe(false);
      expect(existsSync(join(scratch, 'report.md'))).toBe(false);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});

describe('a report accounts for every declared stored box exactly once', () => {
  const run = () => ({ chapters: [{ chapter: 'one', boxes: 2, boxIds: ['a', 'b'] }, { chapter: 'two', boxes: 1, boxIds: ['c'] }] });
  const row = (id, chapter = 'one') => ({ id, chapter, rust: { state: geom, lay: null }, strip: geom });
  const complete = () => [row('a'), row('b'), row('c', 'two')];
  it('accepts exact records from two distinct chapters', () => {
    expect(() => assertReportRecords(run(), complete())).not.toThrow();
  });
  it.each([
    ['empty', () => []],
    ['truncated', () => complete().slice(0, 2)],
    ['duplicate with matching total', () => [row('a'), row('a'), row('c', 'two')]],
    ['foreign chapter', () => [row('a'), row('b'), row('c', 'other')]],
    ['extra ID with matching total', () => [row('a'), row('d'), row('c', 'two')]],
    ['missing Rust partner', () => [{ ...row('a'), rust: null }, row('b'), row('c', 'two')]],
    ['missing strip partner', () => [{ ...row('a'), strip: null }, row('b'), row('c', 'two')]],
    ['empty Rust geometry', () => [{ ...row('a'), rust: { state: {} } }, row('b'), row('c', 'two')]],
    ['missing strip size', () => [{ ...row('a'), strip: { ...geom, size: undefined } }, row('b'), row('c', 'two')]],
    ['nonfinite partner geometry', () => [{ ...row('a'), strip: { ...geom, h: NaN } }, row('b'), row('c', 'two')]],
  ])('refuses %s box records', (_, rows) => {
    expect(() => assertReportRecords(run(), rows())).toThrow('no report can be written');
  });
  it('refuses a missing or contradictory ID denominator', () => {
    expect(() => assertReportRecords({ chapters: [{ chapter: 'one', boxes: 1 }] }, [])).toThrow('no report can be written');
    expect(() => assertReportRecords({ chapters: [{ chapter: 'one', boxes: 1, boxIds: [] }] }, [])).toThrow('no report can be written');
    expect(() => assertReportRecords({ chapters: [{ chapter: 'one', boxes: 2, boxIds: ['a', 'a'] }] }, complete())).toThrow('no report can be written');
  });
});
