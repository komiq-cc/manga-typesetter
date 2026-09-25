import { describe, it, expect } from 'vitest';
import {
  stripOffsets,
  stripPageExtent,
  stripDragYBounds,
  boxPaintReach,
  boxPaintedStripSpan,
  stripResidentWindow,
  isBoxInStripWindow,
  stripFrameCoords,
  stripFrameMetrics,
  pageIndexAtCenter,
  maxPageWidth,
  fitWidthZoom,
  residentRadiusFor,
  scrollFraction,
  scrollTopForFraction,
  visibleHeightOf,
  focusHoldsIndex,
  focusedBoxHoldsIndex,
  stripScrollTopForBox,
  RESIDENT_MIN,
  RESIDENT_MAX,
} from './strip.js';
import { normalizeInkStroke } from '../data.js';

const pages = (...hs) => hs.map((h, i) => ({ id: i + 1, w: 800, h }));

describe('stripOffsets', () => {
  it('stacks the pages with no gap between them', () => {
    expect(stripOffsets(pages(100, 200, 50))).toEqual({ tops: [0, 100, 300], total: 350 });
  });

  it('scales every offset and the total by the zoom', () => {
    expect(stripOffsets(pages(100, 200), 0.5)).toEqual({ tops: [0, 50], total: 150 });
  });

  it('gives an unmeasured page no height rather than a guessed one', () => {
    expect(stripOffsets([{ h: 0 }, { h: 100 }]).tops).toEqual([0, 0]);
  });

  it('answers for a chapter with no pages', () => {
    expect(stripOffsets([])).toEqual({ tops: [], total: 0 });
    expect(stripOffsets(null)).toEqual({ tops: [], total: 0 });
  });
});

describe('owner-local geometry across strip seams', () => {
  const ps = pages(100, 200, 50);

  it('locates an owner within the unzoomed document', () => {
    expect(stripPageExtent(ps, 2)).toEqual({ top: 100, total: 350 });
    expect(stripPageExtent(ps, 9)).toBe(null);
    expect(stripPageExtent([{ id: 1, h: 100 }, { id: 2, h: 0 }], 1)).toBe(null);
  });

  it('allows a box to cross its owner seam but retains a reachable part in the document', () => {
    expect(stripDragYBounds(ps, 1, 80)).toEqual({ min: -60, max: 330 });
    expect(stripDragYBounds(ps, 2, 80)).toEqual({ min: -160, max: 230 });
    expect(stripDragYBounds(ps, 3, 80)).toEqual({ min: -360, max: 30 });
  });

  it('maps cross-seam local coordinates to continuous strip coordinates in both directions', () => {
    // Downward overflow from page 1 (h: 100) into page 2
    const p1Extent = stripPageExtent(ps, 1);
    const boxOnP1 = { y: 80, h: 60 }; // ends at y=140, 40px into page 2
    const stripY1 = p1Extent.top + boxOnP1.y;
    expect(stripY1).toBe(80);
    expect(stripY1 + boxOnP1.h).toBe(140); // 40px past page 1's bottom (100)

    // Upward overflow from page 2 (top: 100, h: 200) into page 1
    const p2Extent = stripPageExtent(ps, 2);
    const boxOnP2 = { y: -30, h: 50 }; // starts 30px up into page 1
    const stripY2 = p2Extent.top + boxOnP2.y;
    expect(stripY2).toBe(70); // 30px above page 2's top (100)
    expect(stripY2 + boxOnP2.h).toBe(120);
  });
});

describe('boxPaintedStripSpan and effect reach', () => {
  const inkLine = (pts, size = 10) => normalizeInkStroke({ pts: pts.map(([x, y]) => [x, y, 1]), size, color: '#000000' });
  const sides = (l, t, r, b) => ({ l, t, r, b });

  it('reaches nothing for a box with no style, and the antialiasing for a plain one', () => {
    expect(boxPaintReach({ y: 0, w: 100, h: 50 })).toEqual(sides(0, 0, 0, 0));
    expect(boxPaintReach({ y: 0, w: 100, h: 50, style: {} })).toEqual(sides(4, 4, 4, 4));
  });

  it('reaches each way by what paints that way, not one pad all round', () => {
    const box = (style) => ({ y: 0, w: 200, h: 80, style });
    // A shadow thrown 30px down reaches down, and only its blur's spread up.
    expect(boxPaintReach(box({ shadows: [{ x: 0, y: 30, blur: 2 }] }))).toEqual(sides(8, 4, 8, 38));
    // A vertical smear reaches up and down and not across.
    const smear = boxPaintReach(box({ motionBlur: { on: true, x: 0, y: 4, amount: 2 } }));
    expect(smear.l).toBe(4);
    expect(smear.t).toBe(smear.b);
    expect(smear.b).toBeGreaterThan(4);
    // Mirrored with the flip, which mirrors the finished picture.
    expect(boxPaintReach(box({ shadows: [{ x: 0, y: 30, blur: 2 }], flipV: true }))).toEqual(sides(8, 38, 8, 4));
  });

  it("counts hand-drawn ink past the far edges, with its outline and shadow", () => {
    // Drawn from inside the box to 50px past its bottom: the old pad measured
    // the ink from the box's corner and saw none of that.
    const style = {
      ink: { on: true, strokes: [inkLine([[100, 40], [100, 125]])] },
      strokes: [{ width: 3 }],
      shadows: [{ x: 0, y: 6, blur: 0 }],
    };
    const e = boxPaintReach({ y: 0, w: 200, h: 80, style });
    expect(e.b).toBe(50 + 3 + 6 + 4);
    expect(e.t).toBe(3 + 4);
  });

  it("takes the containment check's overflow where the text runs past the box", () => {
    const b = { y: 100, w: 200, h: 80, style: {}, review: { kind: 'overflow', overflow: { l: 0, t: 0, r: 0, b: 120 }, reason: 'x' } };
    expect(boxPaintReach(b).b).toBe(124);
    expect(boxPaintedStripSpan(b, 500)).toEqual({ top: 596, bottom: 804 });
  });

  it('keeps a box on one page whose ink hangs over the seam into the next window', () => {
    // Page 1 ends at 1000; the resident window starts there. The box ends 20px
    // short of the seam and its shadow is thrown 60px down, over it.
    const b = { y: 900, w: 200, h: 80, style: { shadows: [{ x: 0, y: 60, blur: 0 }] } };
    expect(isBoxInStripWindow(b, 0, 1000, 2000)).toBe(true);
    const inked = { y: 900, w: 200, h: 80, style: { ink: { on: true, strokes: [inkLine([[100, 50], [100, 130]])] } } };
    expect(isBoxInStripWindow(inked, 0, 1000, 2000)).toBe(true);
    expect(isBoxInStripWindow({ ...inked, style: {} }, 0, 1000, 2000)).toBe(false);
  });

  it('computes painted strip span taking rotation and effects into account', () => {
    // Unrotated box on page at top=500
    const b1 = { y: 100, w: 200, h: 80 };
    expect(boxPaintedStripSpan(b1, 500)).toEqual({ top: 600, bottom: 680 });

    // 90-degree rotated box (becomes 200px tall centered at y=140 -> local top 40, bottom 240)
    const b2 = { y: 100, w: 200, h: 80, style: { rotation: 90 } };
    expect(boxPaintedStripSpan(b2, 500)).toEqual({ top: 536, bottom: 744 });

    // Box with effects padding
    const b3 = { y: 100, w: 200, h: 80, style: { strokes: [{ width: 10 }] } };
    expect(boxPaintedStripSpan(b3, 500)).toEqual({ top: 586, bottom: 694 });
  });
});

describe('stripResidentWindow and isBoxInStripWindow', () => {
  const chapter = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, w: 800, h: 1000 }));
  const { tops } = stripOffsets(chapter, 1);

  it('determines resident artwork strip bounds from center page and viewport', () => {
    // At center index 10 (page 11, top: 10000), with 800px viewport, radius is 3 (pages 7..13)
    const win = stripResidentWindow(chapter, tops, 10, 800);
    expect(win.radius).toBe(3);
    expect(win.lo).toBe(7);
    expect(win.hi).toBe(13);
    expect(win.top).toBe(7000);
    expect(win.bottom).toBe(14000);
  });

  it('mounts boxes on offscreen owners that extend into the resident window', () => {
    const winTop = 7000;
    const winBottom = 14000;

    // Box owned by page 1 (ownerTop: 0) extending down into page 8 (y: 7500, h: 100)
    const crossBox = { y: 7500, w: 200, h: 100 };
    expect(isBoxInStripWindow(crossBox, 0, winTop, winBottom)).toBe(true);

    // Box owned by page 1 staying on page 1 (y: 100, h: 50) -> does not intersect window
    const offscreenBox = { y: 100, w: 200, h: 50 };
    expect(isBoxInStripWindow(offscreenBox, 0, winTop, winBottom)).toBe(false);

    // Box owned by page 25 (ownerTop: 24000) extending upward into page 13 (y: -10500, h: 100) -> top in strip space: 13500
    const upwardBox = { y: -10500, w: 200, h: 100 };
    expect(isBoxInStripWindow(upwardBox, 24000, winTop, winBottom)).toBe(true);

    // Pinned selection or editing box is always mounted even if far offscreen
    expect(isBoxInStripWindow(offscreenBox, 0, winTop, winBottom, true)).toBe(true);
  });
});

describe('shared longstrip text overlay layout and hit resolution', () => {
  const mixedPages = [
    { id: 1, w: 800, h: 1200 },
    { id: 2, w: 1000, h: 1500 },
    { id: 3, w: 600, h: 800 },
  ];

  it('aligns page boxlayers with centered page frames across zoom levels', () => {
    for (const zoom of [1, 0.5, 1.25]) {
      const { tops } = stripOffsets(mixedPages, zoom);
      const maxW = maxPageWidth(mixedPages) * zoom; // 1000 * zoom

      // Page 1 (w: 800)
      const left1 = (maxW - mixedPages[0].w * zoom) / 2;
      expect(tops[0]).toBe(0);
      expect(left1).toBe((1000 - 800) * zoom / 2);

      // Page 2 (w: 1000)
      const left2 = (maxW - mixedPages[1].w * zoom) / 2;
      expect(tops[1]).toBe(1200 * zoom);
      expect(left2).toBe(0);

      // Page 3 (w: 600)
      const left3 = (maxW - mixedPages[2].w * zoom) / 2;
      expect(tops[2]).toBe((1200 + 1500) * zoom);
      expect(left3).toBe((1000 - 600) * zoom / 2);
    }
  });

  it('resolves geometric click positions across seam boundaries via stripFrameCoords', () => {
    const zoom = 1;
    const { tops } = stripOffsets(mixedPages, zoom);
    const stageTop = 50;
    const stageLeft = 100;
    const maxW = maxPageWidth(mixedPages) * zoom; // 1000

    const frames = mixedPages.map((pg, i) => {
      const w = pg.w * zoom;
      const h = pg.h * zoom;
      const top = stageTop + tops[i];
      const left = stageLeft + (maxW - w) / 2;
      return {
        left,
        right: left + w,
        top,
        bottom: top + h,
        pg,
      };
    });

    // Click inside page 1
    expect(stripFrameCoords(stageLeft + 200, stageTop + 500, frames, zoom)).toEqual({
      x: 100, // (200 - 100 left pad)
      y: 500,
      pg: mixedPages[0],
      index: 0,
    });

    // Click 1px above seam between page 1 and page 2 (page 1 bottom is stageTop + 1200)
    expect(stripFrameCoords(stageLeft + 200, stageTop + 1199, frames, zoom)).toEqual({
      x: 100,
      y: 1199,
      pg: mixedPages[0],
      index: 0,
    });

    // Click exactly on the seam (stageTop + 1200) resolves to page 2
    expect(stripFrameCoords(stageLeft + 200, stageTop + 1200, frames, zoom)).toEqual({
      x: 200, // page 2 left pad is 0
      y: 0,
      pg: mixedPages[1],
      index: 1,
    });

    // Click 1px below seam resolves to page 2
    expect(stripFrameCoords(stageLeft + 200, stageTop + 1201, frames, zoom)).toEqual({
      x: 200,
      y: 1,
      pg: mixedPages[1],
      index: 1,
    });

    // Click outside strip width returns null
    expect(stripFrameCoords(stageLeft - 20, stageTop + 500, frames, zoom)).toBe(null);
    expect(stripFrameCoords(stageLeft + 1050, stageTop + 500, frames, zoom)).toBe(null);
  });
});

// This replaced a `getBoundingClientRect()` per page per animation frame, so
// the bar is not "sensible numbers" - it is the SAME numbers the rects gave, or
// the scroll names a different page than it used to.
describe('stripFrameMetrics', () => {
  // What the browser does with the frames: each one is styled `height: h*zoom`,
  // laid out in a flex column with `gap`, starting wherever the column starts.
  const laidOut = (ps, zoom, firstTop, gap) => {
    const tops = [];
    const heights = [];
    let y = firstTop;
    for (const p of ps) {
      const h = p.h * zoom;
      tops.push(y);
      heights.push(h);
      y += h + gap;
    }
    return { tops, heights };
  };

  it('stacks the frames from where the column starts', () => {
    expect(stripFrameMetrics(pages(100, 200, 50), 1, 60)).toEqual({
      tops: [60, 160, 360],
      heights: [100, 200, 50],
    });
  });

  it('scales both the offsets and the heights by the zoom', () => {
    expect(stripFrameMetrics(pages(100, 200), 0.5, 0)).toEqual({
      tops: [0, 50],
      heights: [50, 100],
    });
  });

  it('spends the gap between every pair of frames, empty ones included', () => {
    expect(stripFrameMetrics(pages(100, 0, 100), 1, 0, 10).tops).toEqual([0, 110, 120]);
  });

  it('leaves an undecoded page at no height, so nothing names it as the page on screen', () => {
    const { heights, tops } = stripFrameMetrics([{ h: 0 }, { h: 100 }], 1, 0);
    expect(heights).toEqual([0, 100]);
    expect(tops).toEqual([0, 0]);
    // The rule the heights exist for - see `pageIndexAtCenter`.
    expect(pageIndexAtCenter(tops, 0, 800, heights)).toBe(1);
  });

  it('agrees with the layout it replaced, at an awkward zoom and a padded stage', () => {
    const ps = pages(1400, 1399, 2000, 0, 851);
    for (const zoom of [1, 0.437, 2.5]) {
      for (const firstTop of [0, 52, 137.5]) {
        expect(stripFrameMetrics(ps, zoom, firstTop, 0)).toEqual(laidOut(ps, zoom, firstTop, 0));
      }
    }
  });

  it('answers for a chapter with no pages', () => {
    expect(stripFrameMetrics([], 1, 0)).toEqual({ tops: [], heights: [] });
    expect(stripFrameMetrics(null, 1, 0)).toEqual({ tops: [], heights: [] });
  });
});

describe('pageIndexAtCenter', () => {
  const tops = stripOffsets(pages(1000, 1000, 1000)).tops; // 0, 1000, 2000

  it('names the page the viewport is looking at, not the one at its top edge', () => {
    // The top edge is still on page one; the middle of the screen is on page two.
    expect(pageIndexAtCenter(tops, 600, 800)).toBe(1);
  });

  it('follows the centre down the strip', () => {
    expect(pageIndexAtCenter(tops, 0, 800)).toBe(0);
    expect(pageIndexAtCenter(tops, 1000, 800)).toBe(1);
    expect(pageIndexAtCenter(tops, 2000, 800)).toBe(2);
  });

  it('holds at the last page when the centre falls past the end of the strip', () => {
    expect(pageIndexAtCenter(tops, 9000, 800)).toBe(2);
  });

  it('holds at the first page when the centre is above the first frame', () => {
    // A stage that pads the column down leaves the top of the scroll range above
    // page one.
    expect(pageIndexAtCenter([60, 1060], 0, 100)).toBe(0);
  });

  it('answers zero for a chapter with no frames', () => {
    expect(pageIndexAtCenter([], 500, 800)).toBe(0);
  });

  it('opens an unmeasured chapter at its first page, not its last', () => {
    // Every page `h: 0` until a decode lands: the frames all start at the same
    // offset, and naming the last of them would put the queue and the prefetch
    // window at the end of a chapter the reader has not opened yet.
    const flat = stripOffsets(pages(0, 0, 0, 0)).tops; // 0, 0, 0, 0
    expect(pageIndexAtCenter(flat, 0, 800, [0, 0, 0, 0])).toBe(0);
    // …and with no heights to hand, from the offsets alone.
    expect(pageIndexAtCenter(flat, 0, 800)).toBe(0);
  });

  it('skips a page that has not decoded and names the one the centre is really in', () => {
    // Page three is still `h: 0`, so it starts where page four does.
    const tops = stripOffsets(pages(1000, 1000, 0, 1000)).tops; // 0, 1000, 2000, 2000
    const heights = [1000, 1000, 0, 1000];
    expect(pageIndexAtCenter(tops, 1800, 800, heights)).toBe(3);
    expect(pageIndexAtCenter(tops, 1800, 800)).toBe(3);
    // The measured pages either side are unaffected.
    expect(pageIndexAtCenter(tops, 0, 800, heights)).toBe(0);
    expect(pageIndexAtCenter(tops, 800, 800, heights)).toBe(1);
  });

  it('holds at the first page when only the pages below the centre have decoded', () => {
    expect(pageIndexAtCenter([0, 0, 0], 0, 800, [0, 0, 0])).toBe(0);
  });
});

describe('the focused page holds the index while the reader is working', () => {
  const tops = [0, 1000, 2000];
  const heights = [1000, 1000, 1000];

  it('measures how much of a frame is on screen', () => {
    expect(visibleHeightOf(1000, 1000, 800, 800)).toBe(600);
    expect(visibleHeightOf(1000, 1000, 3000, 800)).toBe(0);
    expect(visibleHeightOf(1000, 0, 900, 800)).toBe(0);
  });

  it('holds while any worthwhile part of the focused page is still visible', () => {
    // Editing a box on page one while the viewport's centre has crossed onto
    // page two: page one is still on screen, so it keeps the index.
    expect(focusHoldsIndex(tops, heights, 0, 600, 800)).toBe(true);
  });

  it('lets go once the focused page has been scrolled off screen', () => {
    expect(focusHoldsIndex(tops, heights, 0, 1200, 800)).toBe(false);
  });

  it('lets go for a sliver too thin to be what the reader is looking at', () => {
    // Four pixels of page one left at the top of the viewport.
    expect(focusHoldsIndex(tops, heights, 0, 996, 800)).toBe(false);
  });

  it('holds for a slice shorter than the threshold, while any of it shows', () => {
    expect(focusHoldsIndex([0, 4], [4, 1000], 0, 0, 800)).toBe(true);
  });

  it('never holds for a page with no height, or an index off the end', () => {
    expect(focusHoldsIndex(tops, [0, 1000, 1000], 0, 0, 800)).toBe(false);
    expect(focusHoldsIndex(tops, heights, 9, 0, 800)).toBe(false);
    expect(focusHoldsIndex(tops, heights, -1, 0, 800)).toBe(false);
  });

  it('keeps focus when cross-seam text remains visible after its owner frame leaves', () => {
    const box = { y: 900, w: 200, h: 300 };
    // Owner frame ends at 1000; the viewport starts at 1050, on the next image.
    expect(focusHoldsIndex([0, 1000], [1000, 1000], 0, 1050, 100)).toBe(false);
    expect(focusedBoxHoldsIndex(box, 0, 1, 1050, 100)).toBe(true);
    expect(focusedBoxHoldsIndex(box, 0, 1, 1250, 100)).toBe(false);
  });
});

describe('a jump to a box scrolls the strip to it', () => {
  // A box on the third page of a 1000px-tall-slice column, 600px down it.
  const box = { y: 600, w: 200, h: 100 };

  it('centres a box that is off screen on the box, in zoomed pixels', () => {
    // The box's top is at 2000 + 600 = 2600, its centre at 2650.
    expect(stripScrollTopForBox(box, 2000, 1, 0, 800)).toBe(2650 - 400);
    // At 50% the owner top is already zoomed (it is a frame metric); the box
    // is not, so its 600 is 300 and its 100 is 50.
    expect(stripScrollTopForBox(box, 1000, 0.5, 0, 800)).toBe(1000 + 325 - 400);
  });

  it('moves nothing when the whole box is already on screen', () => {
    expect(stripScrollTopForBox(box, 2000, 1, 2200, 800)).toBeNull();
  });

  it('scrolls a box that is only partly on screen', () => {
    // Its bottom 50px hang below a viewport that ends at 2650.
    expect(stripScrollTopForBox(box, 2000, 1, 1850, 800)).toBe(2250);
  });

  it('brings a box taller than the viewport in top first', () => {
    expect(stripScrollTopForBox({ y: 100, w: 200, h: 1200 }, 1000, 1, 0, 800)).toBe(1100);
  });

  it('never asks for a scroll above the top of the column', () => {
    expect(stripScrollTopForBox({ y: 0, w: 200, h: 100 }, 0, 1, 900, 800)).toBe(0);
  });

  it('counts what the box paints past its own edges', () => {
    // Text that overflows the box by 60px below: that is what the list is
    // flagging, so the scroll has to show it, not only the frame.
    // The viewport ends at 2720, 20px under the box's frame.
    const styled = { ...box, style: { rotation: 0 } };
    const over = { ...styled, review: { overflow: { b: 60 } } };
    expect(stripScrollTopForBox(styled, 2000, 1, 1920, 800)).toBeNull();
    expect(stripScrollTopForBox(over, 2000, 1, 1920, 800)).not.toBeNull();
  });

  it('answers nothing without a box or a zoom', () => {
    expect(stripScrollTopForBox(null, 0, 1, 0, 800)).toBeNull();
    expect(stripScrollTopForBox(box, 0, 0, 0, 800)).toBeNull();
  });
});

describe('fit is fit-width in a strip', () => {
  it('measures against the widest page, not the first', () => {
    expect(maxPageWidth([{ w: 600, h: 1 }, { w: 900, h: 1 }])).toBe(900);
    expect(fitWidthZoom([{ w: 600 }, { w: 900 }], 1000, 100)).toBeCloseTo(900 / 900);
  });

  it('spends the stage padding before it divides', () => {
    expect(fitWidthZoom([{ w: 800 }], 1000, 120)).toBeCloseTo(1.1);
  });

  it('ignores the height entirely - the column scrolls', () => {
    const tall = [{ w: 800, h: 40000 }];
    expect(fitWidthZoom(tall, 800, 0)).toBe(1);
  });

  it('answers 0 when there is nothing measured to fit to', () => {
    expect(fitWidthZoom([{ w: 0, h: 0 }], 1000, 100)).toBe(0);
    expect(fitWidthZoom([], 1000, 100)).toBe(0);
    // A viewport narrower than its own padding is not a fit.
    expect(fitWidthZoom([{ w: 800 }], 100, 120)).toBe(0);
  });
});

describe('residentRadiusFor', () => {
  const uniform = (n, h) => Array.from({ length: n }, () => h);

  it('stays at the paged radius when one slice is already several screens tall', () => {
    expect(residentRadiusFor(uniform(40, 8000), 20, 800)).toBe(RESIDENT_MIN);
  });

  it('grows until three screens of art sit either side', () => {
    // 800px viewport wants 2400px each way; 1000px slices need three of them.
    expect(residentRadiusFor(uniform(40, 1000), 20, 800)).toBe(3);
    // Half the slice height, twice the pages.
    expect(residentRadiusFor(uniform(40, 500), 20, 800)).toBe(5);
  });

  it('never grows past the cap, however short the slices are', () => {
    expect(residentRadiusFor(uniform(200, 20), 100, 900)).toBe(RESIDENT_MAX);
  });

  it('counts the two sides separately, so the end of the chapter cannot inflate the window', () => {
    // One page from the end: the tail is satisfied by having run out of
    // chapter, and the radius is decided by what is still above.
    const heights = uniform(10, 1000);
    expect(residentRadiusFor(heights, 9, 800)).toBe(3);
  });

  it('falls back to the paged radius when there is nothing to measure', () => {
    expect(residentRadiusFor([], 0, 800)).toBe(RESIDENT_MIN);
    expect(residentRadiusFor(uniform(10, 1000), 0, 0)).toBe(RESIDENT_MIN);
  });

  it('takes its floor, target and cap from the caller when asked', () => {
    expect(residentRadiusFor(uniform(40, 1000), 20, 800, { screens: 1 })).toBe(RESIDENT_MIN);
    expect(residentRadiusFor(uniform(40, 1000), 20, 800, { max: 2 })).toBe(2);
  });

  it('counts an unmeasured page as one viewport instead of walking to the cap', () => {
    // A freshly opened chapter: every height 0 until its image decodes. Each
    // page guessed at one screen means three screens are filled at radius 3 -
    // not RESIDENT_MAX, which put 2*max+1 full pages in memory at once.
    expect(residentRadiusFor(uniform(40, 0), 20, 800)).toBe(3);
    // Mixed: a measured tall page still satisfies its side early.
    const heights = uniform(40, 0);
    heights[19] = 8000;
    heights[21] = 8000;
    expect(residentRadiusFor(heights, 20, 800)).toBe(RESIDENT_MIN);
  });
});

describe('slaving one scroll container to another', () => {
  const canvas = { scrollTop: 500, scrollHeight: 3000, clientHeight: 1000 };
  const side = { scrollHeight: 9000, clientHeight: 900 };

  it('carries the fraction across, not the pixels', () => {
    // A quarter of the way down the canvas is a quarter of the way down the
    // reference, whatever the two columns' heights are.
    expect(scrollFraction(canvas)).toBeCloseTo(0.25);
    expect(scrollTopForFraction(scrollFraction(canvas), side)).toBeCloseTo(0.25 * 8100);
  });

  it('reads a container with nothing to scroll as the top of it', () => {
    expect(scrollFraction({ scrollTop: 0, scrollHeight: 800, clientHeight: 900 })).toBe(0);
    expect(scrollTopForFraction(0.5, { scrollHeight: 800, clientHeight: 900 })).toBe(0);
  });

  it('clamps a fraction that came from a container mid-rubber-band', () => {
    expect(scrollFraction({ scrollTop: -40, scrollHeight: 3000, clientHeight: 1000 })).toBe(0);
    expect(scrollTopForFraction(1.4, side)).toBe(8100);
  });
});
