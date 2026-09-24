import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ===========================================================================
// The auto-height, wired up
// ===========================================================================
// `autoFitBox` is the one function that makes a box's rectangle describe its
// text, and until this file existed nothing in the suite ever ran it: it asks
// `canMeasure()` first, and under node there is no canvas, so it declined in all
// 558 tests. Everything downstream of it - the fit at placement, the refit on
// load, the geometry an undo puts back - was comment-backed only.
//
// The seam is one function, and the mock is one line of it. `measure.js` already
// falls back to a stand-in metric with no canvas (`lineWidth` answers
// `chars * size * 0.55`), and that fallback is deterministic - so the ONLY thing
// this environment is missing is the permission to use it. Nothing else is
// stubbed: the real `layoutLines`, the real `balanceLines`, the real
// `neededHeight` and `growToFit` all run. That is deliberate. A hand-written
// fake measurer would let this file agree with itself while the app measured
// something else, and the numbers below are only worth writing down because they
// come out of the code the app runs.
//
// It also keeps the production side honest: no test-only injection point, no
// `setMeasurer` for a caller to get wrong, and the guard the app relies on
// (`canMeasure`, pinned in store.test.js) stays exactly as it is.
//
// The metric, then, for every expectation in this file:
//   width(line) = line.length * style.size * 0.55
vi.mock('./measure.js', async (importOriginal) => ({
  ...(await importOriginal()),
  canMeasure: () => true,
}));

const { app, loadProjectPages, autoFitBox, refitPage, page, byId, placeActiveAt, beginEdit, endEdit, applyBulk, toggleBulkTarget, setBulkProp, openBulk, closeBulk, selectBox } =
  await import('./store.svelte.js');
const { record, undo, redo, resetHistory, initHistory } = await import('./editor/history.svelte.js');
const { neededHeight } = await import('./typeset.js');
const { setTypesetEnabled, layoutLines, applyCase, textInset, contentWidth } = await import('./measure.js');
const { defaultStyle } = await import('./data.js');
// The heights below are the ones the shaped line breaker produces, and shaping
// is a beta the user opts into - so it is switched on for this file.
setTypesetEnabled(true);

const CHAR = (size) => size * 0.55;

// The text inset (`textInset` in measure.js): the box's 2px padding plus its
// outline's reach, on every side. The lines are laid out in the box less that
// much, and the auto height adds it above and below the block, so the outline
// sits inside the box as well as the glyphs. `twoLiner()` turns its outline off
// (`outlineWidth: 0`), so its inset is the bare padding; a fixture that names a
// `style` of its own without that keeps the default 3px outline, and an inset of
// 5 - which is 6px more height than the same box had before the inset counted
// the outline.
const BARE = 2;
const OUTLINED = textInset(defaultStyle());

// A box wide enough for one four-letter word and not two, at size 20: the
// content width is `w - 4` and a word is `4 * 11 = 44` wide.
const twoLiner = (over = {}) => ({
  id: 'b1',
  lineN: null,
  text: 'AAAA BBBB',
  x: 100,
  y: 500,
  w: 60,
  h: 20,
  style: { size: 20, lineHeight: 1.1, valign: 'middle', outlineWidth: 0, ...over.style },
  ...over,
});

const doc = (boxes, over = {}) => [
  { id: 1, w: 800, h: 1200, lines: [], boxes, ...over },
];

const geom = (b) => ({ y: b.y, h: b.h });

beforeEach(() => {
  initHistory();
  resetHistory();
  app.chapterRef = null;
  closeBulk();
});

describe('the metric this file measures with', () => {
  it('is the stand-in, and it is what makes every number below readable', () => {
    // Two lines, because `AAAA BBBB` is 99 wide and the content width is 56.
    loadProjectPages(doc([twoLiner({ h: 400 })]));
    const b = page().boxes[0];
    expect(CHAR(20) * 9).toBeGreaterThan(b.w - 4);
    expect(CHAR(20) * 4).toBeLessThan(b.w - 4);
  });
});

describe('the box grows to its text, anchored where the text is', () => {
  // 2 lines * 20 * 1.1 = 44, plus the inset on each edge: 48 for `twoLiner()`
  // with its outline off, 54 for a box that keeps the default outline.
  const NEED = neededHeight(2, { size: 20, lineHeight: 1.1 }, BARE);
  const NEED_OUTLINED = neededHeight(2, { size: 20, lineHeight: 1.1 }, OUTLINED);

  it('grows downward from a top-aligned box', () => {
    loadProjectPages(doc([twoLiner({ style: { size: 20, lineHeight: 1.1, valign: 'top' } })]));
    expect(geom(page().boxes[0])).toEqual({ y: 500, h: NEED_OUTLINED });
  });

  it('grows upward from a bottom-aligned box', () => {
    loadProjectPages(doc([twoLiner({ style: { size: 20, lineHeight: 1.1, valign: 'bottom' } })]));
    // The bottom edge stays where the user put it: 500 + 20 === 466 + 54.
    expect(geom(page().boxes[0])).toEqual({ y: 500 + 20 - NEED_OUTLINED, h: NEED_OUTLINED });
  });

  it('opens equally in both directions when the text is centred', () => {
    loadProjectPages(doc([twoLiner()]));
    const b = page().boxes[0];
    expect(geom(b)).toEqual({ y: 500 - (NEED - 20) / 2, h: NEED });
    expect(b.y + b.h / 2).toBe(500 + 20 / 2);
  });

  it('never shrinks a box the user left roomier than its text', () => {
    loadProjectPages(doc([twoLiner({ h: 400 })]));
    const b = page().boxes[0];
    expect(geom(b)).toEqual({ y: 500, h: 400 });
    expect(autoFitBox(b, page())).toBe(false);
  });

  // The width is what the user aimed at the bubble, and nothing that is not an
  // edit moves it: opening a chapter is grow-only, in height. An edit runs the
  // containment ladder (contain.js), which may widen an auto box - but it tries
  // the height first, so a box the height alone can make room in keeps its width.
  it('leaves the width alone on opening, and on an edit the height can satisfy', () => {
    loadProjectPages(doc([twoLiner()]));
    const b = page().boxes[0];
    expect(b.w).toBe(60);
    expect(autoFitBox(b, page())).toBe(false);
    expect(b.w).toBe(60);
  });

  // ...and widens, symmetrically and no further than the text needs, when the
  // height cannot: a page 30 tall holds one line of this text and not two.
  it('widens on an edit only once the height is capped, and only as far as it must', () => {
    loadProjectPages(doc([twoLiner({ y: 0, style: { size: 20, lineHeight: 1.1, valign: 'top', outlineWidth: 0 } })], { h: 30 }));
    const b = page().boxes[0];
    // Opening capped the height at the page and moved nothing sideways.
    expect({ x: b.x, w: b.w, h: b.h }).toEqual({ x: 100, w: 60, h: 30 });
    expect(autoFitBox(b, page())).toBe(true);
    // One line: `AAAA BBBB` is 9 * 11 = 99 wide, plus the padding.
    expect(b.w).toBe(99 + 4);
    expect(b.x + b.w / 2).toBe(100 + 60 / 2);
    expect(b.style.size).toBe(20);
  });

  it('declines for curved text, which is not laid out in lines at all', () => {
    loadProjectPages(doc([twoLiner({ style: { size: 20, lineHeight: 1.1, valign: 'middle', curve: 40 } })]));
    expect(geom(page().boxes[0])).toEqual({ y: 500, h: 20 });
  });

  it('declines when the box has opted out', () => {
    loadProjectPages(doc([twoLiner({ style: { size: 20, lineHeight: 1.1, valign: 'middle', autoHeight: false } })]));
    expect(geom(page().boxes[0])).toEqual({ y: 500, h: 20 });
  });

  it('is capped at the page and clamped inside it', () => {
    // A page shorter than the text needs. The box fills it rather than hanging
    // off the bottom edge where no drag can reach it.
    loadProjectPages(doc([twoLiner({ y: 10, style: { size: 20, lineHeight: 1.1, valign: 'top' } })], { h: 40 }));
    expect(geom(page().boxes[0])).toEqual({ y: 0, h: 40 });
  });

  it('does not clamp against a page nobody has measured yet', () => {
    // `p.h` is 0 until something decodes the art, and clamping against that
    // would drag every box on an unvisited page to the top of it.
    loadProjectPages(doc([twoLiner({ style: { size: 20, lineHeight: 1.1, valign: 'top' } })], { w: 0, h: 0 }));
    expect(geom(page().boxes[0])).toEqual({ y: 500, h: NEED_OUTLINED });
  });

  it('is idempotent, so a second pass can never ratchet', () => {
    loadProjectPages(doc([twoLiner()]));
    const b = page().boxes[0];
    const once = geom(b);
    expect(autoFitBox(b, page())).toBe(false);
    expect(geom(b)).toEqual(once);
  });
});

describe('auto-height across longstrip source seams', () => {
  // Every box below keeps the default outline.
  const NEED = neededHeight(2, { size: 20, lineHeight: 1.1 }, OUTLINED);

  beforeEach(() => {
    app.projectLayout = 'longstrip';
  });

  afterEach(() => {
    app.projectLayout = 'pages';
  });

  it('lets a top-aligned box grow from its owner into the next image', () => {
    loadProjectPages([
      { id: 1, w: 800, h: 100, lines: [], boxes: [twoLiner({ y: 90, style: { size: 20, lineHeight: 1.1, valign: 'top' } })] },
      { id: 2, w: 800, h: 100, lines: [], boxes: [] },
    ]);
    expect(geom(app.pages[0].boxes[0])).toEqual({ y: 90, h: NEED });
  });

  it('lets a bottom-aligned box on the later image grow upward', () => {
    loadProjectPages([
      { id: 1, w: 800, h: 100, lines: [], boxes: [] },
      { id: 2, w: 800, h: 100, lines: [], boxes: [twoLiner({ y: 5, style: { size: 20, lineHeight: 1.1, valign: 'bottom' } })] },
    ]);
    expect(geom(app.pages[1].boxes[0])).toEqual({ y: 5 + 20 - NEED, h: NEED });
  });

  it('waits for every page dimension before using document-wide bounds', () => {
    loadProjectPages([
      { id: 1, w: 800, h: 100, lines: [], boxes: [twoLiner({ y: 90, style: { size: 20, lineHeight: 1.1, valign: 'top' } })] },
      { id: 2, w: 0, h: 0, lines: [], boxes: [] },
    ]);
    expect(geom(app.pages[0].boxes[0])).toEqual({ y: 100 - NEED, h: NEED });
  });
});

// A chapter opening is the moment a whole document's worth of boxes arrives at
// once, sized by an older build, a hand-edited file, or a font that has since
// been replaced. Nothing renders during a load, so a component effect could not
// cover it.
describe('a chapter load refits every page, not just the one on screen', () => {
  it('grows the boxes on a page the user has not turned to', () => {
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [], boxes: [twoLiner()] },
      { id: 2, w: 800, h: 1200, lines: [], boxes: [twoLiner({ id: 'b2' })] },
    ]);
    expect(app.pageIndex).toBe(0);
    expect(app.pages[1].boxes[0].h).toBe(neededHeight(2, { size: 20, lineHeight: 1.1 }, BARE));
  });

  it('answers how many boxes it moved, so a caller can tell', () => {
    loadProjectPages(doc([twoLiner({ h: 400 }), twoLiner({ id: 'b2' })]));
    // Both are already fitted by the load itself, so a second pass moves none.
    expect(refitPage(page())).toBe(0);
  });
});

// A click on a detected block with no balloon found under it places the box
// where the Japanese sat. The block is a location, not a size (GEO-3): the width
// and the height belong to the English that replaces it.
describe('placement fits the box it just created', () => {
  const detected = () => [
    {
      id: 1,
      w: 1000,
      h: 2000,
      lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'AAAAAAAA BBBBBBBB CCCCCCCC DDDDDDDD' }],
      boxes: [],
      detect: { panels: [], boxes: [{ n: 1, box: [100, 100, 300, 200], vertical: false, font_size: 20 }] },
    },
  ];

  // Changed by GEO-3: this pinned the box at the rectangle's width (200 inset
  // by 8 on every edge, 184) with the text broken to fit it.
  it('sizes the box from the text and centres it on the block', () => {
    loadProjectPages(detected());
    page().activeLineN = 1;
    placeActiveAt(200, 150);
    const b = page().boxes[0];
    // At the default size of 26 a word of eight letters is 114.4 wide. Two to a
    // line is a strip (243 by 57), so the block that reads best is four lines of
    // one word each, in a box one word wide plus the default outline's inset of
    // 5 on each side.
    expect(b.w).toBe(125);
    expect(b.h).toBe(neededHeight(4, { size: 26, lineHeight: 1.1 }, OUTLINED));
    // Centred on the block, which is all the block now says.
    expect(b.x + b.w / 2).toBeCloseTo(200, 6);
    expect(b.y + b.h / 2).toBeCloseTo(150, 6);
    expect(b.auto.status).toBe('no-region');
  });

  // GEO-3: a detected block narrower than a word of the English, read as
  // horizontal, used to be the English box - 40 px wide, the minimum, and a
  // stack of one-word lines.
  describe('a narrow block is a location, not the width', () => {
    const TEXT = 'I TOLD YOU WE SHOULD HAVE LEFT BEFORE THE RAIN STARTED TODAY';
    const narrow = () => [
      {
        id: 1,
        w: 1000,
        h: 2000,
        lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: TEXT }],
        boxes: [],
        detect: { panels: [], boxes: [{ n: 1, box: [300, 300, 340, 500], vertical: false, font_size: 20 }] },
      },
    ];
    const placed = () => {
      loadProjectPages(narrow());
      page().activeLineN = 1;
      placeActiveAt(320, 400);
      return page().boxes[0];
    };

    it('takes the width the solver gives the English', () => {
      const b = placed();
      const s = b.style;
      const lines = layoutLines(applyCase(TEXT, s), s, s.size, contentWidth(b.w, s), null);
      expect(b.auto.status).toBe('no-region');
      expect(b.w).toBeGreaterThan(80);
      // A block, not a column: wider than tall, and two words or more to a line
      // where the 40 px box gave every word a line of its own.
      expect(b.w).toBeGreaterThan(b.h);
      expect(lines.length).toBeLessThanOrEqual(TEXT.split(' ').length / 2);
      expect(b.h).toBe(neededHeight(lines.length, s, textInset(s)));
      expect(b.x + b.w / 2).toBeCloseTo(320, 6);
      expect(b.y + b.h / 2).toBeCloseTo(400, 6);
    });

    it('takes the balanced width while the face is loading and the solver cannot run', () => {
      vi.stubGlobal('document', { fonts: { check: () => false, load: () => Promise.resolve([]) } });
      try {
        const b = placed();
        expect(b.auto.status).toBe(null);
        expect(b.w).toBe(balancedBoxSize(TEXT, b.style).w);
        expect(b.x + b.w / 2).toBeCloseTo(320, 6);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it('records the placement at the height the user is looking at', () => {
    loadProjectPages(detected());
    page().activeLineN = 1;
    placeActiveAt(200, 150);
    const b = page().boxes[0];
    undo();
    expect(page().boxes).toHaveLength(0);
    redo();
    // The `place` entry carries the box, and the box it carries is the fitted
    // one - the fit runs before the record, not after it.
    expect(geom(page().boxes[0])).toEqual(geom(b));
  });
});

// ===========================================================================
// Undo puts back the geometry the box actually had
// ===========================================================================
// The grow is not an edit of its own and gets no history step of its own. What
// it gets is a ride on the entry for the edit that caused it: `geomBefore` and
// `geomAfter`. It used to be re-derived instead, which cannot work - the fit is
// grow-only, so nothing it could do would give back the height the grow took.
describe('undo restores the height an edit grew', () => {
  const short = () => [
    {
      id: 1,
      w: 800,
      h: 1200,
      lines: [],
      // Three lines at size 20 need 70, so the load's own refit leaves both of
      // these exactly as the file had them - the growth below belongs to the
      // edit under test and to nothing else.
      boxes: [
        { id: 'b1', lineN: null, text: 'AAAA BBBB CCCC', x: 100, y: 500, w: 60, h: 80, style: { size: 20, valign: 'middle' } },
        { id: 'b2', lineN: null, text: 'AAAA BBBB CCCC', x: 300, y: 500, w: 60, h: 80, style: { size: 20, valign: 'middle' } },
      ],
    },
  ];

  it('walks a style change and the growth it caused back together', () => {
    loadProjectPages(short());
    const b = byId('b1');
    const before = geom(b);
    // What the Inspector writes when the size field is dragged from 20 to 48:
    // the style, the fit, and one entry carrying both.
    const styleBefore = { ...b.style };
    b.style.size = 48;
    expect(autoFitBox(b, page())).toBe(true);
    const grown = geom(b);
    expect(grown.h).toBeGreaterThan(before.h);
    expect(grown.y).toBeLessThan(before.y);
    record({
      t: 'style',
      pageId: 1,
      boxId: 'b1',
      before: styleBefore,
      after: { ...b.style },
      geomBefore: before,
      geomAfter: grown,
    });
    undo();
    expect(byId('b1').style.size).toBe(20);
    expect(geom(byId('b1'))).toEqual(before);
    redo();
    expect(byId('b1').style.size).toBe(48);
    expect(geom(byId('b1'))).toEqual(grown);
  });

  // The worse half of the same bug: undo restores `autoHeight:false`, so a
  // re-derivation on the way back does not merely fail to shrink the box - it
  // declines to run at all, and the height is stuck for good.
  it('walks back a box that grew because auto-height was switched on', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [],
        boxes: [{ id: 'b1', lineN: null, text: 'AAAA BBBB', x: 100, y: 500, w: 60, h: 20, style: { size: 20, valign: 'middle', autoHeight: false } }],
      },
    ]);
    const b = byId('b1');
    const before = geom(b);
    expect(before.h).toBe(20); // the load's refit declined, as it must
    openBulk();
    toggleBulkTarget('b1');
    app.bulk.style.autoHeight = true;
    setBulkProp('autoHeight', true);
    applyBulk();
    const grown = geom(byId('b1'));
    expect(grown.h).toBeGreaterThan(20);
    undo();
    expect(byId('b1').style.autoHeight).toBe(false);
    expect(geom(byId('b1'))).toEqual(before);
  });

  it('walks back a bulk apply across every box it touched', () => {
    loadProjectPages(short());
    const before = { b1: geom(byId('b1')), b2: geom(byId('b2')) };
    openBulk();
    toggleBulkTarget('b1');
    toggleBulkTarget('b2');
    app.bulk.style.size = 60;
    setBulkProp('size', true);
    applyBulk();
    const grown = { b1: geom(byId('b1')), b2: geom(byId('b2')) };
    expect(grown.b1.h).toBeGreaterThan(before.b1.h);
    expect(grown.b2.h).toBeGreaterThan(before.b2.h);
    // One entry, every box in it, and one press.
    undo();
    expect(geom(byId('b1'))).toEqual(before.b1);
    expect(geom(byId('b2'))).toEqual(before.b2);
    expect(byId('b1').style.size).toBe(20);
    redo();
    expect(geom(byId('b1'))).toEqual(grown.b1);
    expect(geom(byId('b2'))).toEqual(grown.b2);
  });

  it('walks back the growth a text edit caused', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [],
        boxes: [{ id: 'b1', lineN: null, text: 'AAAA', x: 100, y: 500, w: 60, h: 30, style: { size: 20, valign: 'middle' } }],
      },
    ]);
    const before = geom(byId('b1'));
    beginEdit('b1');
    endEdit('AAAA BBBB CCCC DDDD');
    const grown = geom(byId('b1'));
    expect(grown.h).toBeGreaterThan(before.h);
    undo();
    expect(byId('b1').text).toBe('AAAA');
    expect(geom(byId('b1'))).toEqual(before);
    redo();
    expect(byId('b1').text).toBe('AAAA BBBB CCCC DDDD');
    expect(geom(byId('b1'))).toEqual(grown);
  });

  // Entries outlive the build that wrote them: the history is on disk, keyed by
  // page, and reloaded next session. One with no geometry in it is what every
  // entry looked like until now, and it still has to walk.
  it('falls back to a fit for an entry that carries no geometry', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [],
        boxes: [{ id: 'b1', lineN: null, text: 'AAAA BBBB', x: 100, y: 500, w: 60, h: 400, style: { size: 20, valign: 'top' } }],
      },
    ]);
    const b = byId('b1');
    b.style.size = 60;
    b.h = 20;
    record({ t: 'style', pageId: 1, boxId: 'b1', before: { size: 20, valign: 'top' }, after: { size: 60, valign: 'top' } });
    undo();
    // No pair to restore, so the height is re-derived - grow-only, so the box
    // is at least big enough for the text the undo just put back in it.
    expect(byId('b1').style.size).toBe(20);
    expect(byId('b1').h).toBe(neededHeight(2, { size: 20, lineHeight: 1.1 }, OUTLINED));
  });
});

// A font arriving changes every width in the app, and until it does every
// measurement is made against the fallback family. The editor never noticed.
describe('a font arriving invalidates the fitted heights', () => {
  it('refits the whole open chapter and bumps the counter the layouts read', async () => {
    const { noteFontsChanged } = await import('./store.svelte.js');
    loadProjectPages([
      { id: 1, w: 800, h: 1200, lines: [], boxes: [twoLiner()] },
      { id: 2, w: 800, h: 1200, lines: [], boxes: [twoLiner({ id: 'b2' })] },
    ]);
    // Both are fitted by the load. Shrink them behind the fit's back, the way a
    // measurement against the wrong font would have.
    for (const p of app.pages) p.boxes[0].h = 20;
    const seen = app.fontsVersion;
    expect(noteFontsChanged()).toBe(2);
    expect(app.fontsVersion).toBe(seen + 1);
    for (const p of app.pages) expect(p.boxes[0].h).toBe(neededHeight(2, { size: 20, lineHeight: 1.1 }, BARE));
  });

  it('bumps the counter even when no box needed moving', async () => {
    const { noteFontsChanged } = await import('./store.svelte.js');
    loadProjectPages(doc([twoLiner({ h: 400 })]));
    const seen = app.fontsVersion;
    expect(noteFontsChanged()).toBe(0);
    // The counter is what a component's derived layout depends on, and a box
    // whose height did not change can still break its lines somewhere else.
    expect(app.fontsVersion).toBe(seen + 1);
  });
});

// The queue's translation field writes `line.en`, and a box placed from that
// line renders it - so it is an edit to the box's text arrived at from the other
// end, and the box has to follow. It used to rely on the canvas component's
// effect, which only ever covers what is rendered.
describe('the queue’s own text field is a path like any other', () => {
  it('fits the line’s box when the translation is edited', () => {
    loadProjectPages([
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [{ n: 1, type: 'dialogue', jp: 'あ', en: 'AAAA' }],
        boxes: [{ id: 'b1', lineN: 1, text: null, x: 100, y: 500, w: 60, h: 30, style: { size: 20, valign: 'top' } }],
      },
    ]);
    const p = page();
    p.lines[0].en = 'AAAA BBBB CCCC';
    // What `Queue.svelte`'s oninput does with the box behind the row.
    for (const b of p.boxes) if (b.lineN === 1) autoFitBox(b, p);
    expect(byId('b1').h).toBe(neededHeight(3, { size: 20, lineHeight: 1.1 }, OUTLINED));
  });
});

describe('selection is untouched by any of this', () => {
  it('does not select a box just because it was fitted', () => {
    loadProjectPages(doc([twoLiner()]));
    selectBox(null);
    refitPage(page());
    expect(app.selectedId).toBe(null);
  });
});

// ===========================================================================
// auto-WIDTH: the half that was missing
// ===========================================================================
// Everything above is grow-only on ONE axis, and that is exactly what produced
// the bug. A box placed with nothing known about what is under it got a fixed
// 220px width; the height then chased the text down the page and the width never
// moved, so a paragraph came out as a column - the same wrong shape
// `transposeRect` exists to prevent, arrived at from the other direction.
//
// The width is now chosen at placement, from the same measurement the height
// comes from. Auto-height is unchanged: it still never touches the width. What
// changed is that by the time it runs there is a width worth keeping.
describe('a placed box is sized to a shape, not just to a width', () => {
  const LONG =
    'I NEVER THOUGHT IT WOULD COME TO THIS, BUT HERE WE ARE, STANDING AT THE EDGE ' +
    'OF EVERYTHING WE EVER BUILT TOGETHER, AND I STILL CANNOT FIND THE WORDS.';

  // No `detect` and no pixels - `page-pixels.js` is not mocked in this file, so
  // it answers null under node exactly as it does for a page nobody has opened.
  // This is the bare paste-mode placement: a queue row, a click, nothing else.
  const placed = (en) => {
    loadProjectPages([
      { id: 1, w: 900, h: 900, lines: [{ n: 1, type: 'dialogue', jp: 'あ', en }], boxes: [] },
    ]);
    placeActiveAt(450, 450);
    return page().boxes[0];
  };

  it('comes out wider than tall instead of as a column', () => {
    const b = placed(LONG);
    expect(b.w).toBeGreaterThan(b.h);
  });

  it('is not the fixed width any more', () => {
    expect(placed(LONG).w).not.toBe(220);
  });

  it('widens with the text, which is the axis that never used to move', () => {
    expect(placed(LONG).w).toBeGreaterThan(placed('WHAT?').w);
  });

  it('leaves auto-height nothing to do, because the width already allowed for it', () => {
    const b = placed(LONG);
    const before = { y: b.y, h: b.h };
    // The width was chosen by laying the text out at it, so the box already
    // describes its own text and a grow would mean the two disagreed.
    expect(autoFitBox(b, page())).toBe(false);
    expect({ y: b.y, h: b.h }).toEqual(before);
  });

  it('still describes its own text exactly', () => {
    const b = placed(LONG);
    const style = b.style;
    const lines = layoutLines(applyCase(LONG, style), style, style.size, contentWidth(b.w, style), null);
    expect(b.h).toBe(neededHeight(lines.length, style, textInset(style)));
  });

  it('keeps the old constants for a row with nothing typed in it yet', () => {
    const b = placed('');
    expect([b.w, b.h]).toEqual([220, 92]);
  });

  it('lands the box under the pointer, whatever size it came out', () => {
    const b = placed(LONG);
    expect(b.x + b.w / 2).toBeCloseTo(450, 0);
    expect(b.y + b.h / 2).toBeCloseTo(450, 0);
  });
});

// ===========================================================================
// `balancedBoxSize`, on its own
// ===========================================================================
// The half of placement that runs when nothing is known about the bubble: no
// detection, no pixels, just a queue row and a click. Exercised through
// `placeActiveAt` above, which is the wiring; this is the arithmetic, at the
// edges the wiring never reaches.
//
// Every number below comes out of the stand-in metric this file documents -
// `width(line) = line.length * size * 0.55` - so they are the app's own answers
// rather than a hand-computed model of them.
const { balancedBoxSize } = await import('./measure.js');

describe('balancedBoxSize', () => {
  const style = { size: 20, lineHeight: 1.1, valign: 'middle', outlineWidth: 0 };
  const LONG_TEXT =
    'THE WHOLE CITY WENT QUIET THAT NIGHT AND NOBODY EVER TOLD ME WHY IT HAPPENED ' +
    'OR WHO DECIDED IT WOULD HAPPEN THAT WAY AT ALL AND I HAVE BEEN WONDERING EVER ' +
    'SINCE THEN ABOUT EVERY SINGLE ONE OF THOSE PEOPLE WHO SAID NOTHING AT ALL.';

  // A box, not a block: the content width plus the padding a box lays out
  // inside, and the height through `neededHeight`, so the caller can use the
  // answer as a rectangle without knowing what BOX_PAD is.
  it.each([
    // one word - a block of one line, floored at `minWidth` because a single
    // short word is narrower than any box placement is willing to make.
    ['one word', 'HI', {}, { w: 44, h: 26, lines: 1 }],
    // typed Returns are lines the breaker cannot undo, so four paragraphs are
    // four lines however wide the box is - the floor on the search, not just
    // the pieces the total is summed from.
    ['four paragraphs', 'A\nB\nC\nD', {}, { w: 44, h: 92, lines: 4 }],
    // ...and a paragraph that is one long word still breaks, because the
    // breaker hyphenates rather than overflowing.
    ['one unbreakable-looking word', 'SUPERCALIFRAGILISTIC', {}, { w: 82, h: 70, lines: 3 }],
    // a whole speech: the closed form seeds a line count and the real breaker
    // settles it, which is the check the seed exists to be corrected by.
    ['a long speech', LONG_TEXT, {}, { w: 301, h: 202, lines: 9 }],
    // past `maxLines` the text is a caption rather than a balloon line, and the
    // clamp is what stops the search asking for a forty-line column.
    ['the same speech, clamped to three lines', LONG_TEXT, { maxLines: 3 }, { w: 895, h: 70, lines: 3 }],
  ])('sizes %s', (_name, text, opts, want) => {
    expect(balancedBoxSize(text, style, opts)).toEqual(want);
  });

  // Null is the "nothing to measure" answer, and placement reads it as "keep the
  // old constants". Whitespace is the one worth being explicit about: a box
  // holding two Returns has text in the string sense and nothing to lay out.
  it.each([
    ['whitespace only', '   \n\t \n ', style],
    ['empty', '', style],
    ['nothing at all', null, style],
    ['no size', 'HI', { ...style, size: 0 }],
    ['no style', 'HI', null],
  ])('answers null for %s', (_name, text, s) => {
    expect(balancedBoxSize(text, s)).toBe(null);
  });

  // The block gets wider as the text gets longer, which is the axis that never
  // used to move: the fixed 220 made a long line a tall narrow column.
  it('widens with the text rather than only growing taller', () => {
    const short = balancedBoxSize('WHAT?', style);
    const long = balancedBoxSize(LONG_TEXT, style);
    expect(long.w).toBeGreaterThan(short.w);
    expect(long.w).toBeGreaterThan(long.h);
  });

  // A style with no line height is not an error - it is a style with a default,
  // and it used to come back as a NaN box because `neededHeight` multiplied by
  // `undefined`. `?? 92` in placement is a null check, not a number check, so
  // the NaN went straight onto the box.
  it('survives a style with no line height on it', () => {
    const got = balancedBoxSize('HELLO THERE FRIEND', { size: 20, valign: 'middle' });
    expect(Number.isFinite(got.w) && Number.isFinite(got.h)).toBe(true);
    // ...and the default is 1, so the height is the plain line count times the
    // size, plus the box's own padding.
    expect(got.h).toBe(got.lines * 20 + 4);
  });
});
