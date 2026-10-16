import { describe, it, expect } from 'vitest';
import { planStripCuts, forbiddenBands, boxSpanY, boxCutSpan, CUT_PAD } from './strip-cuts.js';
import { identityMesh } from '../warp.js';

// One page tall enough to hold several slices, so strip coordinates and page
// coordinates are the same numbers here and the arithmetic can be read off by
// eye. Pages are only a source of offsets for this module - what it reasons
// about is boxes and the height of the column.
const page = (h, boxes = []) => ({ id: 1, w: 800, h, boxes });
const box = (y, h, extra = {}) => ({ id: 1, x: 100, y, w: 200, h, style: { rotation: 0 }, ...extra });

// No cut may land strictly inside a forbidden band. Asserted against the plan
// rather than eyeballed per case, because it is the one property the whole
// module exists for.
const clearsEveryBand = (cuts, bands) =>
  cuts.slice(1, -1).every((c) => bands.every((b) => !(c > b.top && c < b.bottom)));

describe('boxSpanY', () => {
  it('is the box rect when the box is not rotated', () => {
    expect(boxSpanY(box(100, 50))).toEqual({ top: 100, bottom: 150 });
  });

  it('bounds a rotated box by its axis-aligned extent, not by its height', () => {
    // 200 wide, 50 tall, turned a quarter turn: on the strip it is 200 tall.
    const s = boxSpanY(box(100, 50, { style: { rotation: 90 } }));
    expect(s.top).toBeCloseTo(25); // centre 125, half-extent 100
    expect(s.bottom).toBeCloseTo(225);
  });

  it('leaves a flipped box where it was - mirroring a rect moves no bound', () => {
    const s = boxSpanY(box(100, 50, { style: { rotation: 0, flipH: true, flipV: true } }));
    expect(s).toEqual({ top: 100, bottom: 150 });
  });
});

describe('forbiddenBands', () => {
  it('pads every box and maps it into strip coordinates', () => {
    const pages = [page(1000, [box(200, 100)]), page(1000, [box(200, 100)])];
    expect(forbiddenBands(pages, 10)).toEqual([
      { top: 190, bottom: 310 },
      { top: 1190, bottom: 1310 },
    ]);
  });

  it('fuses boxes whose padded bands touch or overlap into one band', () => {
    const pages = [page(1000, [box(200, 100), box(320, 100), box(700, 50)])];
    // 190..310 and 310..430 touch, so they are one stretch of forbidden strip.
    expect(forbiddenBands(pages, 10)).toEqual([
      { top: 190, bottom: 430 },
      { top: 690, bottom: 760 },
    ]);
  });
});

// What a box paints is not always inside its frame and the pad. A mesh can
// carry the whole picture off the frame, and so can a long shadow; the cut
// has to clear what is painted, as the slices pick their boxes by it.
describe('the band a box keeps a cut out of', () => {
  // The box's mesh moved bodily down by `dy`: the letters are painted that far
  // below the frame.
  const bent = (y, h, dy, style = {}) => {
    const pts = identityMesh(1, 1, 200, h).map(([x, y]) => [x, y + dy]);
    return box(y, h, { style: { rotation: 0, warp: { on: true, cols: 1, rows: 1, pts }, ...style } });
  };

  it('is the frame and the pad for a box that paints inside them', () => {
    expect(boxCutSpan(box(200, 100), 48)).toEqual({ top: 152, bottom: 348 });
  });

  it('holds a mesh that carries the letters off the frame, with the pad around them', () => {
    const s = boxCutSpan(bent(7800, 100, 100), CUT_PAD);
    expect(s.top).toBe(7800 - CUT_PAD);
    expect(s.bottom).toBeGreaterThanOrEqual(8000 + CUT_PAD);
  });

  it('turns over with the box: a mesh bent down on a box flipped upside down paints above it', () => {
    const s = boxCutSpan(bent(7800, 100, 100, { flipV: true }), CUT_PAD);
    expect(s.top).toBeLessThanOrEqual(7700 - CUT_PAD);
    expect(s.bottom).toBe(7900 + CUT_PAD);
  });

  it('holds a shadow thrown further than the pad', () => {
    const s = boxCutSpan(box(200, 100, { style: { rotation: 0, shadows: [{ x: 0, y: 120, blur: 0, opacity: 1 }] } }), 48);
    expect(s.top).toBe(152);
    expect(s.bottom).toBeGreaterThanOrEqual(300 + 120);
  });

  it('keeps the cut out of letters the mesh moved over the ideal cut', () => {
    // At 7800, 100 tall, the frame and its pad end at 7948: the ideal cut at
    // 8000 looked clear, and ran through the letters the mesh had moved to
    // 7900..8000.
    const pages = [page(20000, [bent(7800, 100, 100)])];
    const { cuts, warnings } = planStripCuts(pages, 8000);
    expect(warnings).toEqual([]);
    expect(cuts[1]).toBeLessThanOrEqual(7800 - CUT_PAD);
    expect(clearsEveryBand(cuts, forbiddenBands(pages))).toBe(true);
  });
});

describe('planStripCuts', () => {
  it('cuts at plain target spacing when nothing is in the way', () => {
    const pages = [page(3000, [box(100, 50)])];
    expect(planStripCuts(pages, 1000).cuts).toEqual([0, 1000, 2000, 3000]);
  });

  it('ends the last slice at the end of the strip, however short it runs', () => {
    expect(planStripCuts([page(2500)], 1000).cuts).toEqual([0, 1000, 2000, 2500]);
  });

  it('moves a cut UP to the top of the band it landed in', () => {
    // A box at 950..1050 makes the ideal cut at 1000 a cut through lettering.
    const pages = [page(3000, [box(950, 100)])];
    const { cuts, warnings } = planStripCuts(pages, 1000, 50);
    expect(cuts).toEqual([0, 900, 1900, 2900, 3000]); // 950 - 50 of pad
    expect(warnings).toEqual([]);
  });

  it('moves a cut DOWN when moving up would leave a runt slice', () => {
    // The band starts 100px below the previous cut - a tenth of the target - so
    // cutting there would ship a sliver of a file. Below the box instead.
    const pages = [page(3000, [box(150, 800)])];
    const { cuts, warnings } = planStripCuts(pages, 1000, 50);
    expect(cuts[1]).toBe(1000); // 150 + 800 + 50 of pad
    expect(warnings).toEqual([]);
  });

  it('takes the nearest band edge when neither side gives a legal slice', () => {
    // Band 200..2500 against a 1000 target: up (200) is under the 250 minimum
    // and down (2500) is past the 2000 maximum, so neither is legal and the cut
    // goes to the nearer of the two rather than through the lettering.
    const pages = [page(6000, [box(250, 2200)])];
    expect(forbiddenBands(pages, 50)).toEqual([{ top: 200, bottom: 2500 }]);
    const { cuts } = planStripCuts(pages, 1000, 50);
    expect(cuts[1]).toBe(200);
  });

  it('threads dense bands without ever cutting through one', () => {
    // A wall of boxes every 300px down a long strip: every cut has to dodge, and
    // the gaps between them are the only places left.
    const boxes = [];
    for (let y = 500; y < 9000; y += 300) boxes.push({ ...box(y, 120), id: y });
    const pages = [page(10000, boxes)];
    const pad = 20;
    const { cuts, warnings } = planStripCuts(pages, 2000, pad);
    expect(clearsEveryBand(cuts, forbiddenBands(pages, pad))).toBe(true);
    expect(warnings).toEqual([]);
    expect(cuts[0]).toBe(0);
    expect(cuts[cuts.length - 1]).toBe(10000);
    // Still recognisably a 2000px plan rather than a scramble.
    for (let i = 1; i < cuts.length; i++) expect(cuts[i] - cuts[i - 1]).toBeLessThanOrEqual(4000);
  });

  it('cuts through lettering taller than any slice may be, and says so', () => {
    // One 3000px box against a 1000px target: below its top edge there is no cut
    // that clears it and no cut that clears it is a legal slice.
    const pages = [page(6000, [box(1200, 3000)])];
    const { cuts, warnings } = planStripCuts(pages, 1000, 50);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].reason).toBe('lettering-taller-than-slice');
    expect(cuts).toContain(1150); // it still retreats to the box's top first
    // And having warned, the plan advances rather than looping.
    expect(cuts[cuts.length - 1]).toBe(6000);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]).toBeGreaterThan(cuts[i - 1]);
  });

  it('answers for a chapter with nothing in it', () => {
    expect(planStripCuts([], 1000)).toEqual({ cuts: [], warnings: [] });
    expect(planStripCuts(null, 1000)).toEqual({ cuts: [], warnings: [] });
    expect(planStripCuts([page(0)], 1000)).toEqual({ cuts: [], warnings: [] });
  });

  it('leaves a cut alone when a box sits exactly one pad away from it', () => {
    // Box top at ideal + pad: the band begins exactly at the ideal cut, which is
    // therefore already clear by exactly the allowance. Same one pad below.
    const below = [page(3000, [box(1000 + CUT_PAD, 100)])];
    expect(planStripCuts(below, 1000).cuts[1]).toBe(1000);
    const above = [page(3000, [box(1000 - CUT_PAD - 100, 100)])];
    expect(planStripCuts(above, 1000).cuts[1]).toBe(1000);
  });

  it('spans pages: a box near a page seam moves the cut in strip space', () => {
    // Two 1000px pages; the box is on the second one, 50px down, so the band is
    // at 1050 on the strip and the ideal cut at 1200 has to retreat onto page
    // one's territory.
    const pages = [page(1000), page(1000, [box(50, 400)])];
    const { cuts } = planStripCuts(pages, 1200, 50);
    expect(cuts[1]).toBe(1000); // 1000 + 50 - 50 of pad
  });

  it('makes one file of the whole strip when the target is nonsense', () => {
    expect(planStripCuts([page(3000)], 0).cuts).toEqual([0, 3000]);
    expect(planStripCuts([page(3000)], NaN).cuts).toEqual([0, 3000]);
  });

  it('cuts at whole pixels so two slices meet without a resampled seam', () => {
    const pages = [page(2000, [box(940.4, 100)])];
    const { cuts } = planStripCuts(pages, 1000, 10.3);
    for (const c of cuts) expect(Number.isInteger(c)).toBe(true);
  });
});
