import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fsx } from './fsx.js';
import { setChapterImageDirs, setResidentWindow, releasePageImages, releaseAllPageImages } from './page-images.js';
import { app, loadProjectPages } from './store.svelte.js';
import {
  exportTextJson,
  buildTextJson,
  pageSpace,
  renderPageCanvas,
  renderStripSliceCanvas,
  exportImages,
  stripPageSuffix,
  sanitizeExportName,
} from './exporter.js';
import { PAGE_W, PAGE_H, normalizeStyle } from './data.js';
import { arcLayout, layoutLines, BOX_PAD, textInset, balloonWidthsFor, setTypesetEnabled, baselineInLine } from './measure.js';
import { patternTilePx, TILE_SS } from './text-paint.js';
import { neededHeight } from './typeset.js';

// Which boxes each render asked the brush tips of (`settleBoxTips`), by id.
// The real settle still runs: nothing here names an imported brush.
const tipAsks = vi.hoisted(() => []);
vi.mock('./brush-tips.js', async (original) => {
  const real = await original();
  return {
    ...real,
    settleBoxTips: (boxes) => {
      tipAsks.push((boxes ?? []).map((b) => b?.id));
      return real.settleBoxTips(boxes);
    },
  };
});

// exportTextJson is the single writer of the detection JSON - the detect menu
// and the export dialog both go through it - so what its two scopes select is
// worth pinning down. Everything under test here is scope arithmetic: which
// pages go in, and what the file is called.
//
// The browser-download branch is the one reachable outside Tauri, and it wants
// exactly two things this environment lacks: an anchor to click and an object
// URL to point it at. Three stubs, not a DOM: a real one would only make the
// same two facts harder to read off.
//
// The canvas half of the exporter wants two more: an element that answers to
// `width`/`height`/`getContext`, and an `Image` that decodes. Both are stubs of
// exactly the surface `renderPageCanvas` touches for a page with no boxes on it
// - the geometry is what is under test, not the painting - and `naturalSizes`
// below is what the fake decoder knows about each src.
let downloaded;
let naturalSizes;
const realDocument = globalThis.document;
const realImage = globalThis.Image;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

// Draws nothing, and records the two things worth reading back: the strings
// `paintBox` hands to `fillText`, which are the lines the export actually puts
// on the page, and where they landed. Everything else exists so the render can
// run to the end and the canvas's own dimensions can be read off it.
//
// A box with no rotation is painted onto its own offscreen canvas and then
// composited onto the page, so the page coordinate of a glyph run is the origin
// of that bitmap plus the position inside it - `composited` is the first half.
let painted;
let placed;
let composited;
//
// The strokes and shadows a box paints are read back the same way: `stroked` is
// every line width `paintBox` set before a stroke pass, and `shadowed` is one
// entry per shadow layer composited under the text (a shadow is drawn by
// compositing its own silhouette canvas - see paintShadows - so it shows up as a
// blurred, offset drawImage rather than as a glyph run).
let stroked;
let shadowed;
// Roughening is the one thing the exporter does to finished pixels rather than
// to a glyph run, so it shows up here as an ImageData round trip: `displaced` is
// one entry per pass, holding the size of the raster that went through it.
let displaced;
// Every stop handed to a gradient this render built, in the order it was added.
// A gradient's alpha lives in the stop strings rather than anywhere else, so
// this list is the whole of what the exporter says about a gradient's colours.
let gradStops;
// The patterns a render built: the tile's raster size, and the transform the
// pattern was anchored with. `createPattern` used to answer null here, which
// meant every patterned box fell through to the solid-colour branch and the
// whole tiling half of the exporter was untested - including the two things
// most easily wrong about it, the tile's pitch and where its grid starts.
let patterns;
// Every fillStyle a glyph run was actually painted with, alongside the run, so a
// test can say WHICH fill reached the letters and not merely that one was built.
let fills;
// The passes a render performed, in order: 'composite' for a plain draw,
// 'shadow' for one composited with the transform reset, 'blur' for the draw
// through a canvas filter, and 'displace' for a roughening pass. The editor
// applies its blur and its displacement in one filter list, left to right, so
// which of the two happens first is a parity fact and not an implementation
// detail.
let order;
// Every composite draw's destination rectangle, for the tests that are about
// the footprint rather than about where its corner landed.
let rects;
let draws;
const stubContext = () => ({
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 0,
  lineJoin: '',
  miterLimit: 0,
  font: '',
  textBaseline: '',
  textAlign: '',
  globalAlpha: 1,
  filter: 'none',
  imageSmoothingQuality: '',
  fillRect() {},
  clearRect() {},
  // Enough of a path API for `drawPatternTile` to draw a tile into this stub.
  beginPath() {},
  arc() {},
  fill() {},
  rect() {},
  clip() {},
  // The warp pass's triangles: a path per triangle, clipped, then the texture
  // drawn through the affine that carries it. Nothing here has to rasterise -
  // warp-paint.test.js brings a renderer that does - so what these record is
  // that the pass ran, in `order`.
  moveTo() {},
  lineTo() {},
  closePath() {},
  transform() {},
  drawImage(_img, x, y, dw, dh) {
    // A shadow layer is the one thing composited with the transform reset (see
    // paintShadows), which is what tells the two kinds of draw apart here.
    if (this.identity) {
      order.push('shadow');
      shadowed.push({ x, y, filter: this.filter, alpha: this.globalAlpha });
    } else {
      order.push(this.filter && this.filter !== 'none' ? 'blur' : 'composite');
      composited.push([x, y]);
      // The same draws again, with the destination rect this time: how big the
      // bitmap is on the page is the whole of what a warp does to the footprint.
      if (dw != null) rects.push({ x, y, w: dw, h: dh });
    }
    draws.push({
      kind: _img?.src ? 'art' : 'box',
      src: _img?.src,
      x,
      y,
      dw,
      dh,
    });
  },
  scale() {},
  save() {},
  restore() {
    this.identity = false;
  },
  setTransform() {
    this.identity = true;
  },
  translate() {},
  rotate() {},
  createLinearGradient(...args) {
    gradStops.push({ kind: 'linear', args, stops: [] });
    const rec = gradStops[gradStops.length - 1];
    return { addColorStop: (pos, color) => rec.stops.push([pos, color]) };
  },
  createRadialGradient(...args) {
    gradStops.push({ kind: 'radial', args, stops: [] });
    const rec = gradStops[gradStops.length - 1];
    return { addColorStop: (pos, color) => rec.stops.push([pos, color]) };
  },
  createPattern(tile, repeat) {
    const rec = { repeat, tile: [tile?.width, tile?.height], transform: null };
    patterns.push(rec);
    return {
      setTransform(m) {
        rec.transform = [m.a, m.b, m.c, m.d, m.e, m.f];
      },
      pattern: rec,
    };
  },
  fillText(s, x, y) {
    painted.push(s);
    placed.push([x, y]);
    fills.push(this.fillStyle);
    draws.push({ kind: 'text', text: s, x, y });
  },
  strokeText(s) {
    stroked.push({ text: s, width: this.lineWidth, color: this.strokeStyle, alpha: this.globalAlpha });
  },
  getImageData(_x, _y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  },
  createImageData(w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  },
  putImageData(img) {
    order.push('displace');
    displaced.push([img.width, img.height]);
  },
});

beforeEach(() => {
  // Every expectation here is about the shaped breaking, which is a beta the
  // user opts into - so the whole file runs with it on.
  setTypesetEnabled(true);
  downloaded = [];
  painted = [];
  placed = [];
  composited = [];
  draws = [];
  stroked = [];
  shadowed = [];
  displaced = [];
  gradStops = [];
  patterns = [];
  fills = [];
  order = [];
  rects = [];
  naturalSizes = {};
  // `setFill` only anchors a pattern where the platform has a DOMMatrix to
  // anchor it with, so node needs the six numbers of one for that branch to be
  // reachable at all.
  globalThis.DOMMatrix = class {
    constructor([a, b, c, d, e, f]) {
      Object.assign(this, { a, b, c, d, e, f });
    }
  };
  globalThis.document = {
    // `exportImages` waits for the fonts before it measures anything. Under node
    // there are none and there is nothing to wait for.
    fonts: { ready: Promise.resolve() },
    createElement: (tag) =>
      tag === 'canvas'
        ? {
            width: 0,
            height: 0,
            getContext: stubContext,
            // The strip export asks each slice canvas for its file. Nothing
            // reads the bytes - what is under test there is how many files come
            // out and what they are called.
            toBlob(cb) {
              cb(new Blob([`${this.width}x${this.height}`]));
            },
          }
        : {
            click() {
              downloaded.push(this.download);
            },
          },
  };
  // `loadImage` sets crossOrigin, then the handlers, then src - so firing off
  // the src setter is safe, and asynchronously, because a synchronous onload
  // would run before the promise it resolves exists.
  globalThis.Image = class {
    set src(url) {
      this._src = url;
      const size = naturalSizes[url];
      queueMicrotask(() => {
        if (!size) return this.onerror?.(new Error('decode failed'));
        this.naturalWidth = size[0];
        this.naturalHeight = size[1];
        this.onload?.();
      });
    }
    get src() {
      return this._src;
    }
  };
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => {};

  app.exportName = 'ch01';
  loadProjectPages([
    { id: 11, w: 800, h: 1200, lines: [{ n: 1, jp: 'あ', en: 'ah' }], boxes: [] },
    { id: 22, w: 800, h: 1200, lines: [{ n: 1, jp: 'い', en: 'ee' }], boxes: [] },
    { id: 33, w: 800, h: 1200, lines: [], boxes: [] },
  ]);
});

afterEach(() => {
  releaseAllPageImages();
  vi.restoreAllMocks();
  setTypesetEnabled(false);
  // A layout is a property of the open project, and one test opening a
  // longstrip one must not leave every later test in a strip.
  app.projectLayout = 'pages';
  globalThis.document = realDocument;
  globalThis.Image = realImage;
  delete globalThis.DOMMatrix;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

describe('exportTextJson', () => {
  it("names the whole-chapter document once, without any page's id in it", async () => {
    await exportTextJson('all');
    expect(downloaded).toEqual(['ch01-text.json']);
    // One document for three pages, not three files - the reason the export
    // dialog's 'all' still goes through the single-file save path.
    expect(app.toast.msg).toBe('Exported text for 3 page(s) as JSON (browser download)');
  });

  it('names the current-page document after the page, not after its index', async () => {
    app.pageIndex = 1;
    await exportTextJson('current');
    expect(downloaded).toEqual(['ch01-22-text.json']);
    expect(app.toast.msg).toBe('Exported text for 1 page(s) as JSON (browser download)');
  });
});

describe('an export holds one moment of the document', () => {
  const editablePages = () => [1, 2].map((id) => ({
    id, w: 800, h: 1000,
    lines: [{ n: 1, en: id === 1 ? 'BEFORE' : 'SECOND', tags: ['shout'] }],
    boxes: [{ id: `b${id}`, lineN: 1, text: null, x: 20, y: id === 1 ? 900 : 100,
      w: 300, h: 200, style: normalizeStyle({ size: 20 }) }],
    detect: { panels: [[0, 0, 800, 1000]], boxes: [{ n: 1, box: [1, 2, 3, 4] }] },
  }));
  const pauseFonts = () => {
    let resume;
    document.fonts.ready = new Promise((resolve) => { resume = resolve; });
    return resume;
  };
  const edit = () => {
    for (const p of app.pages) {
      p.lines[0].en = 'AFTER';
      p.lines[0].tags.push('edited');
      p.boxes[0].x = 250;
      p.boxes[0].style.size = 40;
      p.detect.panels[0][0] = 100;
      p.detect.boxes[0].box[0] = 200;
    }
    app.pageIndex = 0;
    app.pages.push({ ...editablePages()[0], id: 3 });
  };

  it.each([
    ['all', 'pages'], ['page', 'pages'], ['all', 'longstrip'], ['page', 'longstrip'],
  ])('PNG %s, %s: edits during the font wait do not reach any page or neighbour', async (scope, layout) => {
    loadProjectPages(editablePages());
    app.projectLayout = layout;
    app.pageIndex = 1;
    app.stripSliceH = 1000;
    const resume = pauseFonts();
    const exporting = exportImages('PNG', scope);
    edit();
    resume();

    expect(await exporting).toBe(true);
    expect(painted).toContain('SECOND');
    expect(painted).not.toContain('AFTER');
    if (scope === 'all' || layout === 'longstrip') expect(painted).toContain('BEFORE');
    else expect(painted).not.toContain('BEFORE');
    // The strip's cut moves clear of BEFORE's lettering, leaving a short tail.
    expect(downloaded).toHaveLength(scope === 'all' ? (layout === 'longstrip' ? 3 : 2) : 1);
    if (scope === 'page') expect(downloaded).toEqual(['ch01-2.png']);
  });

  it.each(['all', 'page'])('JSON %s: lines, nested detection and box geometry use the original copy', async (scope) => {
    loadProjectPages(editablePages());
    app.pageIndex = 1;
    const expected = buildTextJson(scope === 'all' ? app.pages : [app.pages[1]]);
    let output;
    URL.createObjectURL = (blob) => { output = blob; return 'blob:json'; };
    const resume = pauseFonts();
    const exporting = exportImages('JSON', scope);
    edit();
    resume();

    expect(await exporting).toBe(true);
    expect(await output.text()).toBe(expected);
  });

  it('resolves a copied page through live image residency without moving ownership to the copy', async () => {
    loadProjectPages([{ id: 1, file: '001.png', w: 800, h: 1000, raw: null, cleaned: null, lines: [], boxes: [] }]);
    naturalSizes = { 'blob:test': [800, 1000] };
    vi.spyOn(fsx, 'join').mockImplementation(async (...parts) => parts.join('/'));
    vi.spyOn(fsx, 'assetUrl').mockResolvedValue(null);
    vi.spyOn(fsx, 'readFile').mockResolvedValue(new Uint8Array([1, 2, 3]));
    setChapterImageDirs('/raw', null);
    const resume = pauseFonts();
    const exporting = exportImages('PNG', 'page');
    await setResidentWindow(app.pages, 0, 0);
    resume();

    expect(await exporting).toBe(true);
    expect(draws.some((d) => d.src === 'blob:test')).toBe(true);
    expect(app.pages[0].raw).toBe('blob:test');
    releasePageImages(1);
    expect(app.pages[0].raw).toBeNull();
  });
});

// The text JSON is otherwise a full round trip, and `type` can only hold one of
// the three names the importer validates - so without `tags` a line the user
// tagged `shout` came back as `dialogue` and their own vocabulary was lost.
describe('text JSON carries tags', () => {
  it('writes the tags a line carries alongside its legacy type', () => {
    const pages = [
      {
        id: 1,
        w: 800,
        h: 1200,
        lines: [
          { n: 1, type: 'sfx', jp: 'ドン', en: 'DOOM', tags: ['sfx', 'shout'] },
          { n: 2, type: 'dialogue', jp: 'あ', en: 'ah' },
        ],
        boxes: [],
      },
    ];
    const out = JSON.parse(buildTextJson(pages));
    expect(out.pages[0].lines[0].tags).toEqual(['sfx', 'shout']);
    expect(out.pages[0].lines[0].type).toBe('sfx');
    // A line the user never tagged reads through its legacy type, so the round
    // trip neither invents a tag nor drops the one the file already implied.
    expect(out.pages[0].lines[1].tags).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// what size a page exports at when nobody has ever measured it
// ---------------------------------------------------------------------------
//
// A page is `w:0,h:0` until something decodes its image, and until `createChapter`
// started measuring at import the only thing that ever did was the canvas - one
// page at a time, as the user opened it. Every chapter imported before that is
// still on disk that way: 23 of the 28 pages in the author's own chapter.
//
// Export All reaches every page, looked at or not. `const W = p.w` handed the
// unmeasured ones straight to `canvas.width`, and a 0x0 canvas is not a small
// page - it is an empty file written under the page's name with a success toast
// over it. (The PSD path had the same hole and failed louder: ag-psd throws
// `Invalid document size`.)
describe('pageSpace', () => {
  it('is the page itself once the page has been measured', async () => {
    // No decode: a measured page already knows, and the raster is not asked -
    // which is what keeps the box coordinates and the document in one space
    // even for a page whose art was replaced at a different resolution.
    naturalSizes = { 'blob:art': [4000, 4000] };
    expect(await pageSpace({ w: 1080, h: 1535, cleaned: 'blob:art' })).toEqual({ w: 1080, h: 1535 });
  });

  it('asks the art when the page has no size of its own', async () => {
    naturalSizes = { 'blob:raw': [1080, 1535] };
    expect(await pageSpace({ w: 0, h: 0, raw: 'blob:raw' })).toEqual({ w: 1080, h: 1535 });
  });

  it('measures the image the app would actually draw', async () => {
    // `cleaned ?? raw` is what the canvas and this exporter both put on screen,
    // so a page with both is the size of its cleaned raster and not its raw.
    naturalSizes = { 'blob:raw': [1080, 1535], 'blob:clean': [2160, 3070] };
    expect(await pageSpace({ w: 0, h: 0, raw: 'blob:raw', cleaned: 'blob:clean' })).toEqual({
      w: 2160,
      h: 3070,
    });
  });

  it('falls back to the default page rather than to nothing', async () => {
    // No size, and art that will not decode. Whatever number is chosen the file
    // exports as a blank sheet - but 0 is the one that makes it unopenable.
    expect(await pageSpace({ w: 0, h: 0, raw: 'blob:gone' })).toEqual({ w: PAGE_W, h: PAGE_H });
    expect(await pageSpace({ w: 0, h: 0 })).toEqual({ w: PAGE_W, h: PAGE_H });
  });
});

describe('renderPageCanvas', () => {
  it('sizes the canvas to a never-visited page instead of exporting nothing', async () => {
    naturalSizes = { 'blob:raw-7': [1080, 1535] };
    const canvas = await renderPageCanvas({ id: 7, w: 0, h: 0, raw: 'blob:raw-7', boxes: [] });
    expect([canvas.width, canvas.height]).toEqual([1080, 1535]);
  });

  it('still supersamples from the measured space', async () => {
    const canvas = await renderPageCanvas({ id: 7, w: 800, h: 1200, boxes: [] }, 2);
    expect([canvas.width, canvas.height]).toEqual([1600, 2400]);
  });
});

// The editor and the export must break a box's text in the same places, and the
// mechanism is that both ask `layoutLines` - the same function, with the same
// two arguments: the style's own size, and `box.w` less the padding on each
// side. So what is pinned here is that the exporter draws exactly what that
// function returns for exactly those arguments, which is the half of the parity
// a node test can see. (Under node there is no canvas, so `lineWidth` falls back
// to a stand-in metric; the claim is about which strings are drawn, not about
// what a real font measures.)
describe('shaped lines reach the page', () => {
  const boxWith = (style) => ({
    id: 'b1',
    lineN: null,
    text: 'THE WORLD IS ENDING AND NOBODY CARES AT ALL',
    x: 40,
    y: 40,
    w: 360,
    h: 200,
    style: normalizeStyle(style),
  });

  it('draws the shaped breaking, not the greedy one', async () => {
    const box = boxWith({ size: 20, outlineWidth: 0, shadow: { on: false } });
    await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
    expect(painted).toEqual(
      layoutLines(box.text, box.style, box.style.size, box.w - BOX_PAD * 2),
    );
    // And that is genuinely a balanced block rather than the whole string.
    expect(painted.length).toBeGreaterThan(1);
  });

  // The `shape: 'off'` half is pinned in typeset.test.js instead, against
  // `layoutLines` directly: taking it through the exporter would mean standing
  // up the hidden-element measurement `wrapLinesDOM` performs - a div with real
  // layout and a Range over it - which is a browser, not a stub.

  // The box lays text out inside 2px of padding on every edge - `.tbox` carries
  // it in the editor, and the wrapping width has always been `box.w - 4` on both
  // sides to match. The export honoured it when it broke the lines and then
  // ignored it when it placed them, anchoring the block at the box's own corner:
  // so a left-aligned box drew 2px further left in the PNG than on the canvas,
  // and a top-aligned block 2px higher. The auto-height made that worse than
  // cosmetic - `neededHeight` sizes a box as its block plus the pad on BOTH
  // edges, so every auto-fitted box exported with 4px of empty space under its
  // text that the editor did not show.
  //
  // The page coordinate of a glyph run is the offscreen bitmap's origin plus the
  // position inside it, which is what the two stubs above record.
  describe('the block sits inside the padding, exactly as the canvas shows it', () => {
    const drawnAt = () => [composited[0][0] + placed[0][0], composited[0][1] + placed[0][1]];

    it('anchors a left/top-aligned block 2px in from the box corner', async () => {
      const box = boxWith({ size: 20, align: 'left', valign: 'top', outlineWidth: 0, shadow: { on: false } });
      box.text = 'ONE';
      await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
      const [x, y] = drawnAt();
      expect(x).toBe(box.x + BOX_PAD);
      // The baseline sits where the browser puts it inside the line box - half
      // the leading, then the ascent - which is the same offset the un-padded
      // version had: the padding is the only thing that moved.
      expect(y).toBe(box.y + BOX_PAD + baselineInLine(box.style, box.style.size));
    });

    it('anchors a right/bottom-aligned block 2px in from the far corner', async () => {
      const box = boxWith({ size: 20, align: 'right', valign: 'bottom', outlineWidth: 0, shadow: { on: false } });
      box.text = 'ONE';
      await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
      const [x, y] = drawnAt();
      expect(x).toBe(box.x + box.w - BOX_PAD);
      const lineH = box.style.size * box.style.lineHeight;
      expect(y).toBe(box.y + box.h - BOX_PAD - lineH + baselineInLine(box.style, box.style.size));
    });

    it('leaves a centred block where it was - the padding is symmetric', async () => {
      const box = boxWith({ size: 20, align: 'center', valign: 'middle', outlineWidth: 0, shadow: { on: false } });
      box.text = 'ONE';
      await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
      const [x, y] = drawnAt();
      const lineH = box.style.size * box.style.lineHeight;
      expect(x).toBe(box.x + box.w / 2);
      // No ink shift under node - there is no canvas to measure ink with, so
      // `inkShiftY` answers zero and the block is centred by its line box.
      expect(y).toBe(box.y + (box.h - lineH) / 2 + baselineInLine(box.style, box.style.size));
    });

    // An outline is ink the box has to hold as well, so the content box is the
    // box less the padding AND the outline's reach (`textInset`), on every side:
    // a left- or right-aligned block is anchored that far in, and so is a top-
    // or bottom-aligned one - which puts the outline's outer edge, not the
    // glyph's, 2px inside the box. Anchored at the bare padding, a line that
    // filled its width drew its outline 3px past the edge it was aligned to.
    it('anchors an outlined left/top block its text inset in from the box corner', async () => {
      const box = boxWith({ size: 20, align: 'left', valign: 'top', shadow: { on: false } });
      box.text = 'ONE';
      await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
      const [x, y] = [composited.at(-1)[0] + placed.at(-1)[0], composited.at(-1)[1] + placed.at(-1)[1]];
      // The default outline: 3px, so an inset of 5.
      expect(textInset(box.style)).toBe(BOX_PAD + 3);
      expect(x).toBe(box.x + textInset(box.style));
      expect(y).toBe(box.y + textInset(box.style) + baselineInLine(box.style, box.style.size));
    });

    it('anchors an outlined right/bottom block its text inset in from the far corner', async () => {
      const box = boxWith({ size: 20, align: 'right', valign: 'bottom', shadow: { on: false } });
      box.text = 'ONE';
      await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
      const [x, y] = [composited.at(-1)[0] + placed.at(-1)[0], composited.at(-1)[1] + placed.at(-1)[1]];
      const lineH = box.style.size * box.style.lineHeight;
      expect(x).toBe(box.x + box.w - textInset(box.style));
      expect(y).toBe(box.y + box.h - textInset(box.style) - lineH + baselineInLine(box.style, box.style.size));
    });

    it('gives an auto-fitted box no slack under its last line', async () => {
      // A box sized by `neededHeight` for the block it holds: the text ends
      // exactly one padding above the box's bottom edge, with nothing left over.
      const style = { size: 20, align: 'left', valign: 'top', outlineWidth: 0, shadow: { on: false } };
      const box = boxWith(style);
      box.text = 'ONE';
      const lineH = box.style.size * box.style.lineHeight;
      box.h = neededHeight(1, box.style, BOX_PAD);
      await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
      const blockBottom = drawnAt()[1] - baselineInLine(box.style, box.style.size) + lineH;
      expect(box.y + box.h - blockBottom).toBe(BOX_PAD);
    });
  });

  // The balloon a box was fitted to is the fifth argument to that same
  // function, and the export has to pass it or the PNG breaks its lines
  // somewhere the canvas does not - which is the identical failure the padding
  // above describes, one step further along. `balloonWidthsFor` is the single
  // helper all three layout sites call, so what is pinned here is that the
  // exporter calls it: with the fit in place the drawn strings are the ones that
  // helper produces, and they are NOT the ones the flat content width produces.
  it('draws the balloon’s breaking for a box that was fitted to one', async () => {
    const box = boxWith({ size: 20, lineHeight: 1, outlineWidth: 0, shadow: { on: false } });
    box.text = 'THE WORLD IS ENDING AND NOBODY CARES AT ALL ABOUT IT OR ABOUT ANY OF US';
    box.w = 200;
    box.fit = { kind: 'ellipse', cx: 250, cy: 250, rx: 130, ry: 80 };
    await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
    const flat = layoutLines(box.text, box.style, box.style.size, box.w - BOX_PAD * 2);
    expect(painted).toEqual(
      layoutLines(
        box.text,
        box.style,
        box.style.size,
        box.w - BOX_PAD * 2,
        balloonWidthsFor(box, box.style, box.style.size),
      ),
    );
    expect(painted).not.toEqual(flat);
  });

  it('draws exactly what it drew before for a box with no fit', async () => {
    // The other half of the same claim, and the one that has to stay true for
    // every box in every chapter that predates fitting: no fit, no fifth
    // argument, no change.
    const box = boxWith({ size: 20, outlineWidth: 0, shadow: { on: false } });
    box.fit = null;
    await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
    expect(painted).toEqual(layoutLines(box.text, box.style, box.style.size, box.w - BOX_PAD * 2));
  });

  // A blank line above or below the words is not a line - `layoutLines` drops it
  // - and the export has to draw what the editor shows, which is the point of
  // both of them asking that one function.
  it('draws neither the blank line above the text nor the one below it', async () => {
    const box = boxWith({ size: 20, strokes: [] });
    box.text = '\n\nONE\n\n';
    await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
    expect(painted).toEqual(['ONE']);
  });

  it('uppercases before it measures, so the breaks match the glyphs drawn', async () => {
    const box = boxWith({ size: 20, outlineWidth: 0, uppercase: true, shadow: { on: false } });
    box.text = 'the world is ending and nobody cares at all';
    await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
    expect(painted.join(' ')).toBe(box.text.toUpperCase());
  });
});

// A longstrip chapter exports as slices of one column rather than as its source
// pages, so what has to be pinned down is the geometry of a slice - which pages
// land in it and where - and the shape of the file set that comes out. The
// cut-planning arithmetic itself lives in editor/strip-cuts.js and is tested
// there against nothing but numbers.
// The paint model: any number of strokes, any number of shadows, and an order
// they are drawn in that the editor's stacked layers reproduce. What a node
// stub can see of it is which passes happened, in which order, and with what
// numbers - which is exactly where the arithmetic lives (see text-paint.js).
describe('strokes and shadows', () => {
  const boxWith = (style, text = 'ONE') => ({
    id: 'b1',
    lineN: null,
    text,
    x: 40,
    y: 40,
    w: 360,
    h: 200,
    style: normalizeStyle(style),
  });
  const render = (box) => renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });

  it('draws one pass per stroke, outermost first, at twice its outer edge', async () => {
    await render(
      boxWith({
        size: 20,
        strokes: [
          { color: '#ff0000', width: 2, opacity: 1 },
          { color: '#00ff00', width: 3, opacity: 0.5 },
        ],
      }),
    );
    // strokes[0] is the innermost, so the green one - 2 + 3 wide - is painted
    // first and the red one over it, leaving 2px of red showing and 3 of green.
    expect(stroked.map((k) => [k.color, k.width, k.alpha])).toEqual([
      ['#00ff00', 10, 0.5],
      ['#ff0000', 4, 1],
    ]);
    // And the fill lands on top of both.
    expect(painted).toEqual(['ONE']);
  });

  it('draws nothing at all for an empty stroke list', async () => {
    await render(boxWith({ size: 20, strokes: [] }));
    expect(stroked).toEqual([]);
    expect(painted).toEqual(['ONE']);
  });

  it('composites one blurred, offset layer per shadow, last one first', async () => {
    await render(
      boxWith({
        size: 20,
        strokes: [],
        shadows: [
          { x: 2, y: 3, blur: 4, color: '#000000', opacity: 0.6 },
          { x: -5, y: 0, blur: 0, color: '#ff0000', opacity: 1 },
        ],
      }),
    );
    // Supersampled 2x, so every device-pixel number is doubled - and a canvas
    // filter's radius is half the blur the style names.
    expect(shadowed).toEqual([
      { x: -10, y: 0, filter: 'none', alpha: 1 },
      { x: 4, y: 6, filter: 'blur(4px)', alpha: 0.6 },
    ]);
  });

  it('casts its shadow from the strokes as well as the glyphs', async () => {
    await render(
      boxWith({
        size: 20,
        strokes: [{ color: '#ffffff', width: 3, opacity: 1 }],
        shadows: [{ x: 2, y: 2, blur: 0, color: '#000000', opacity: 1 }],
      }),
    );
    // The silhouette pass strokes once, in the shadow's own colour and at the
    // outermost band's full width, so the shadow is cast from the outline of the
    // stroked text rather than from the letters inside it.
    expect(stroked.some((k) => k.color === '#000000' && k.width === 6)).toBe(true);
  });

  it('grows the footprint for the strokes, the shadows and the blur', async () => {
    // The bitmap's origin is the box corner less the overflow the paint needs,
    // so a box that paints further out composites further up and to the left.
    await render(boxWith({ size: 20, strokes: [{ color: '#fff', width: 1, opacity: 1 }] }));
    // The last composite is the one onto the page; a blurred box composites
    // once more before it, into the canvas the blur is applied through.
    const tight = composited.at(-1);
    composited.length = 0;
    await render(
      boxWith({
        size: 20,
        strokes: [{ color: '#fff', width: 8, opacity: 1 }],
        shadows: [{ x: 20, y: 20, blur: 10, color: '#000', opacity: 1 }],
        blur: 4,
      }),
    );
    expect(composited.at(-1)[0]).toBeLessThan(tight[0]);
    expect(composited.at(-1)[1]).toBeLessThan(tight[1]);
  });
});

// The mesh warp's half of the exporter: when it happens, when it deliberately
// does not, and what it does to where the bitmap lands on the page. The pixels
// themselves are pinned down in warp-paint.test.js, which brings a rasteriser;
// what this stub can see is the pass and the placement, which is what the rest
// of the exporter reads.
describe('the mesh warp', () => {
  const boxWith = (warp) => ({
    id: 'b1',
    lineN: null,
    text: 'ONE',
    x: 40,
    y: 40,
    w: 360,
    h: 200,
    style: normalizeStyle({ size: 20, ...(warp ? { warp } : {}) }),
  });
  const render = (box) => renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
  // The four corners of that box, with the bottom-right one dragged out.
  const DRAGGED = { on: true, cols: 1, rows: 1, pts: [[0, 0], [360, 0], [0, 200], [400, 260]] };

  it('draws a box with no warp block at all exactly as it always did', async () => {
    // Back-compat: a project saved before the feature existed has no `warp` key,
    // and `normalizeStyle` gives it the default. Same passes, same places.
    await render(boxWith(null));
    const was = { order: [...order], composited: JSON.stringify(composited) };
    order.length = 0;
    composited.length = 0;
    await render(boxWith({ on: false, cols: 1, rows: 1, pts: [] }));
    expect(order).toEqual(was.order);
    expect(JSON.stringify(composited)).toBe(was.composited);
  });

  it('skips the whole pass for a mesh that changes nothing', async () => {
    // A gizmo hands the user the identity mesh the moment the switch goes on;
    // until a handle moves, the box has to draw the bytes it drew before.
    await render(boxWith(null));
    const was = { order: [...order], composited: JSON.stringify(composited) };
    order.length = 0;
    composited.length = 0;
    const identity = [[0, 0], [360, 0], [0, 200], [360, 200]];
    await render(boxWith({ on: true, cols: 1, rows: 1, pts: identity }));
    expect(order).toEqual(was.order);
    expect(JSON.stringify(composited)).toBe(was.composited);
    // And the same again for a switched-off mesh that HAS been dragged.
    order.length = 0;
    composited.length = 0;
    await render(boxWith({ ...DRAGGED, on: false }));
    expect(order).toEqual(was.order);
    expect(JSON.stringify(composited)).toBe(was.composited);
  });

  it('draws the texture once per triangle, and the finished bitmap onto the page', async () => {
    await render(boxWith(null));
    const plain = order.length;
    order.length = 0;
    composited.length = 0;
    await render(boxWith(DRAGGED));
    // Two triangles per cell over the 8x8 the four-handle case subdivides into,
    // plus the band of cells that carries the overflow: one draw each, and then
    // the page composite.
    expect(order.length).toBeGreaterThan(plain + 2 * 8 * 8);
    expect(order.at(-1)).toBe('composite');
  });

  it('grows the footprint the mesh reaches past the box, so nothing is cropped', async () => {
    await render(boxWith(null));
    const tight = rects.at(-1);
    rects.length = 0;
    await render(boxWith(DRAGGED));
    const warped = rects.at(-1);
    // The drag takes the bottom-right corner 40px right and 60px down, and the
    // bitmap has to hold all of it - the exporter's own padding mechanism, the
    // one the ink overhang already grew, now reading from the mesh.
    expect(warped.w - tight.w).toBeGreaterThanOrEqual(40);
    expect(warped.h - tight.h).toBeGreaterThanOrEqual(60);
    // The drag is down and to the right, and the origin does not follow it: a
    // bitmap that started later than the unwarped one would be a bitmap with
    // the top-left of the box cut off it.
    expect(warped.x).toBeLessThanOrEqual(tight.x);
    expect(warped.y).toBeLessThanOrEqual(tight.y);
  });

  it('sends a rotated warped box down the raster path rather than the direct draw', async () => {
    // The direct-angle draw paints glyphs; a warped box is a texture, and there
    // is no texture to carry in that path.
    const box = boxWith(DRAGGED);
    box.style.rotation = 30;
    await render(box);
    // A direct draw would have put glyph runs on the page and composited
    // nothing; the raster path composites the box's own bitmap.
    expect(composited.length).toBeGreaterThan(0);
  });
});

// The editor roughens by hanging feTurbulence + feDisplacementMap on the text;
// the export has to arrive at the same picture by moving the pixels itself. What
// it used to move them by was a pair of sines at about two cycles per pixel, so
// a roughened SFX that looked hand-drawn on the canvas exported as a cloud of
// soot - the failure that started all this. The noise and its parity with the
// browser's are pinned down in text-paint.test.js; what belongs here is the
// exporter's side of it: that the pass happens, over the whole raster, at the
// resolution the raster is drawn at, and that it leaves the text where it was.
describe('roughened text', () => {
  const roughBox = (on) => ({
    id: 'r1',
    lineN: null,
    text: 'DOOM',
    x: 100,
    y: 60,
    w: 400,
    h: 120,
    style: normalizeStyle({ size: 24, strokes: [], roughen: { on, amount: 4, detail: 0.05, seed: 7 } }),
  });
  const render = (box) => renderPageCanvas({ id: 9, w: 800, h: 1200, lines: [], boxes: [box] });

  it('displaces the whole supersampled raster, once', async () => {
    await render(roughBox(true));
    // The footprint is the box plus the padding roughening asks for on every
    // edge (`amount` + 2, and 4 besides), and the raster is drawn at 2x like
    // every other box - so the pass covers (400 + 20) x (120 + 20) page px,
    // twice over in each direction. A displacement stated in the raster's own
    // pixels instead of the page's would be right here and wrong at 2x.
    expect(displaced).toEqual([[840, 280]]);
  });

  it('does not touch a box that has not asked for it', async () => {
    await render(roughBox(false));
    expect(displaced).toEqual([]);
  });

  it('leaves the text exactly where it would have been', async () => {
    // Roughening moves ink around the glyphs; it must not move the glyphs. The
    // page position of a line is where its bitmap was composited plus where it
    // was painted inside it, and the padding the roughening adds has to cancel
    // between the two.
    await render(roughBox(false));
    const plain = [composited.at(-1)[0] + placed[0][0], composited.at(-1)[1] + placed[0][1]];
    composited.length = 0;
    placed.length = 0;
    await render(roughBox(true));
    expect([composited.at(-1)[0] + placed[0][0], composited.at(-1)[1] + placed[0][1]]).toEqual(plain);
  });
});

describe('renderStripSliceCanvas', () => {
  it('loads artwork for an intersecting page outside the resident image window', async () => {
    naturalSizes = { 'blob:test': [800, 1000] };
    vi.spyOn(fsx, 'join').mockImplementation(async (...parts) => parts.join('/'));
    vi.spyOn(fsx, 'assetUrl').mockResolvedValue(null);
    vi.spyOn(fsx, 'readFile').mockResolvedValue(new Uint8Array([1, 2, 3]));
    setChapterImageDirs('/raw', null);
    const pages = [{ id: 1, file: '001.png', raw: null, cleaned: null, w: 800, h: 1000, lines: [], boxes: [] }];

    await renderStripSliceCanvas(pages, [0], 0, 500);

    expect(fsx.readFile).toHaveBeenCalledWith('/raw/001.png');
    expect(draws.some((d) => d.src === 'blob:test')).toBe(true);
  });

  // A strip export renders slice after slice, and each one decoded the brush
  // tips of every box in the chapter before it painted a thing: a distinct
  // imported tip per page is gigabytes held for the first slice alone. A slice
  // asks for the tips of the lettering it paints.
  it('settles the brush tips of the boxes it paints, and of no others', async () => {
    const at = (id, y) => ({ id, lineN: null, text: id.toUpperCase(), x: 100, y, w: 200, h: 50, style: normalizeStyle({ size: 20 }) });
    const pages = [
      { id: 1, w: 800, h: 1000, raw: null, lines: [], boxes: [at('above', 100)] },
      { id: 2, w: 800, h: 1000, raw: null, lines: [], boxes: [at('here', 300)] },
      { id: 3, w: 800, h: 1000, raw: null, lines: [], boxes: [at('below', 500)] },
    ];
    tipAsks.length = 0;

    await renderStripSliceCanvas(pages, [0, 1000, 2000], 1000, 2000);

    expect(tipAsks).toEqual([['here']]);
    expect(painted).toEqual(['HERE']);
  });

  it('includes a box whose shadow reaches the slice across a source seam', async () => {
    naturalSizes = { 'blob:b': [800, 1000] };
    const pages = [
      {
        id: 1, w: 800, h: 1000, raw: null, lines: [],
        boxes: [{
          id: 'shadow-tail', lineN: null, text: 'SHADOW_TAIL',
          x: 100, y: 850, w: 300, h: 100,
          style: normalizeStyle({ size: 20, shadows: [{ x: 0, y: 100, blur: 0, color: '#000000', opacity: 1 }] }),
        }],
      },
      { id: 2, w: 800, h: 1000, raw: 'blob:b', lines: [], boxes: [] },
    ];

    await renderStripSliceCanvas(pages, [0, 1000], 1000, 1200);

    expect(painted).toContain('SHADOW_TAIL');
  });
  const strip = () => [
    { id: 1, w: 800, h: 1000, raw: 'blob:a', lines: [], boxes: [] },
    { id: 2, w: 600, h: 1000, raw: 'blob:b', lines: [], boxes: [] },
  ];

  it('is the widest page wide and exactly one slice tall', async () => {
    naturalSizes = { 'blob:a': [800, 1000], 'blob:b': [600, 1000] };
    const canvas = await renderStripSliceCanvas(strip(), [0, 1000], 900, 1600);
    expect([canvas.width, canvas.height]).toEqual([800, 700]);
  });

  it('draws every page the slice crosses at its offset, narrow ones centred', async () => {
    naturalSizes = { 'blob:a': [800, 1000], 'blob:b': [600, 1000] };
    await renderStripSliceCanvas(strip(), [0, 1000], 900, 1600);
    // Page one hangs off the top of the slice; page two starts 100px into it
    // and is 200px narrower, so it sits 100px in from the left.
    expect(composited).toEqual([
      [0, -900],
      [100, 100],
    ]);
  });

  it('leaves out the pages the slice does not reach', async () => {
    naturalSizes = { 'blob:a': [800, 1000], 'blob:b': [600, 1000] };
    await renderStripSliceCanvas(strip(), [0, 1000], 0, 500);
    expect(composited).toEqual([[0, 0]]);
  });

  it('paints downward cross-seam text on top of later page background', async () => {
    naturalSizes = { 'blob:a': [800, 1000], 'blob:b': [800, 1000] };
    const pages = [
      {
        id: 1,
        w: 800,
        h: 1000,
        raw: 'blob:a',
        lines: [],
        boxes: [
          {
            id: 'b-down',
            lineN: null,
            text: 'SEAM_DOWN',
            x: 100,
            y: 900,
            w: 300,
            h: 200,
            style: normalizeStyle({ size: 20 }),
          },
        ],
      },
      { id: 2, w: 800, h: 1000, raw: 'blob:b', lines: [], boxes: [] },
    ];
    // Slice covers seam: [800, 1200]
    await renderStripSliceCanvas(pages, [0, 1000], 800, 1200);

    const artBIdx = draws.findIndex((d) => d.src === 'blob:b');
    const textIdx = draws.findIndex((d) => d.kind === 'box' || d.kind === 'text');
    expect(artBIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThanOrEqual(0);
    // Invariant 1: All contributing backgrounds must paint before any lettering.
    // Later page background (blob:b) must not paint over earlier page's cross-seam text.
    expect(artBIdx).toBeLessThan(textIdx);
  });

  it('paints upward cross-seam text on top of all contributing backgrounds', async () => {
    naturalSizes = { 'blob:a': [800, 1000], 'blob:b': [800, 1000] };
    const pages = [
      {
        id: 1,
        w: 800,
        h: 1000,
        raw: 'blob:a',
        lines: [],
        boxes: [
          {
            id: 'b-p1',
            lineN: null,
            text: 'PAGE_1_BOX',
            x: 100,
            y: 800,
            w: 300,
            h: 100,
            style: normalizeStyle({ size: 20 }),
          },
        ],
      },
      {
        id: 2,
        w: 800,
        h: 1000,
        raw: 'blob:b',
        lines: [],
        boxes: [
          {
            id: 'b-up',
            lineN: null,
            text: 'SEAM_UP',
            x: 100,
            y: -100,
            w: 300,
            h: 200,
            style: normalizeStyle({ size: 20 }),
          },
        ],
      },
    ];
    // Slice covers seam: [700, 1200]
    await renderStripSliceCanvas(pages, [0, 1000], 700, 1200);

    const artAIdx = draws.findIndex((d) => d.src === 'blob:a');
    const artBIdx = draws.findIndex((d) => d.src === 'blob:b');
    const p1TextIdx = draws.findIndex((d) => d.kind === 'box' || d.kind === 'text');
    expect(artAIdx).toBeGreaterThanOrEqual(0);
    expect(artBIdx).toBeGreaterThanOrEqual(0);
    expect(p1TextIdx).toBeGreaterThanOrEqual(0);
    // Artwork must precede all lettering: Page 2 background must not paint after Page 1 text.
    expect(artBIdx).toBeLessThan(p1TextIdx);
  });

  it('renders cross-seam text in a slice where the owner background is absent', async () => {
    // Slice [1050, 1500] is inside Page 2. Page 1 background (0..1000) is absent.
    // Natural sizes only provides blob:b to verify blob:a is never decoded or requested.
    naturalSizes = { 'blob:b': [800, 1000] };
    const pages = [
      {
        id: 1,
        w: 800,
        h: 1000,
        raw: 'blob:a',
        lines: [],
        boxes: [
          {
            id: 'b-down',
            lineN: null,
            text: 'SEAM_DOWN_IN_P2_SLICE',
            x: 100,
            y: 900,
            w: 300,
            h: 200,
            style: normalizeStyle({ size: 20 }),
          },
        ],
      },
      { id: 2, w: 800, h: 1000, raw: 'blob:b', lines: [], boxes: [] },
    ];
    await renderStripSliceCanvas(pages, [0, 1000], 1050, 1500);

    // Page 1's artwork must NOT be drawn (it is outside the slice).
    expect(draws.some((d) => d.src === 'blob:a')).toBe(false);
    // Page 2's artwork MUST be drawn (it intersects the slice).
    const artBIdx = draws.findIndex((d) => d.src === 'blob:b');
    expect(artBIdx).toBeGreaterThanOrEqual(0);
    // Page 1's cross-seam text MUST be drawn.
    const textIdx = draws.findIndex((d) => d.kind === 'box' || d.kind === 'text');
    expect(textIdx).toBeGreaterThanOrEqual(0);
    // Page 2's artwork must be painted BEFORE the text so lettering is not obscured.
    expect(artBIdx).toBeLessThan(textIdx);
  });
});

describe('exportImages in a longstrip project', () => {
  it('measures an unvisited current source slice before exporting it', async () => {
    naturalSizes = { 'blob:test': [600, 900] };
    vi.spyOn(fsx, 'join').mockImplementation(async (...parts) => parts.join('/'));
    vi.spyOn(fsx, 'assetUrl').mockResolvedValue(null);
    vi.spyOn(fsx, 'readFile').mockResolvedValue(new Uint8Array([1, 2, 3]));
    setChapterImageDirs('/raw', null);
    app.projectLayout = 'longstrip';
    loadProjectPages([{ id: 88, file: '088.png', raw: null, cleaned: null, w: 0, h: 0, lines: [], boxes: [] }]);

    expect(await exportImages('PNG', 'current')).toBe(true);

    expect(app.pages[0]).toMatchObject({ w: 600, h: 900 });
    expect(draws.some((d) => d.src === 'blob:test')).toBe(true);
  });
  beforeEach(() => {
    app.projectLayout = 'longstrip';
    app.stripSliceH = 1000;
  });

  it('writes numbered slices of the whole column instead of one file per page', async () => {
    // Three 1200px pages is 3600px of strip; at 1000px a slice with nothing in
    // the way that is four files, the last one short.
    await exportImages('PNG', 'all');
    expect(downloaded).toEqual([
      'ch01-strip-01.png',
      'ch01-strip-02.png',
      'ch01-strip-03.png',
      'ch01-strip-04.png',
    ]);
  });

  it('still exports one page as that page', async () => {
    await exportImages('PNG', 'current');
    expect(downloaded).toEqual(['ch01-11.png']);
  });

  it('exports the current source page slice via the strip compositor, including neighbor and upward cross-seam boxes', async () => {
    naturalSizes = { 'blob:p1': [800, 1000], 'blob:p2': [800, 1000] };
    const p1 = {
      id: 101,
      w: 800,
      h: 1000,
      raw: 'blob:p1',
      lines: [],
      boxes: [
        {
          id: 'b-prev',
          lineN: null,
          text: 'PREV_OWNED_BOX',
          x: 40,
          y: 900,
          w: 300,
          h: 200,
          style: normalizeStyle({ size: 20 }),
        },
      ],
    };
    const p2 = {
      id: 102,
      w: 800,
      h: 1000,
      raw: 'blob:p2',
      lines: [],
      boxes: [
        {
          id: 'b-cur-up',
          lineN: null,
          text: 'CUR_CROSSING_UP_BOX',
          x: 40,
          y: -100,
          w: 300,
          h: 200,
          style: normalizeStyle({ size: 20 }),
        },
      ],
    };

    loadProjectPages([p1, p2]);
    app.pageIndex = 1; // current page is p2 (document range [1000, 2000])

    await exportImages('PNG', 'current');

    expect(downloaded).toEqual(['ch01-102.png']);
    expect(painted).toContain('PREV_OWNED_BOX');
    expect(painted).toContain('CUR_CROSSING_UP_BOX');
  });

  it('leaves the text document alone - it is one file for the chapter either way', async () => {
    await exportImages('JSON', 'all');
    expect(downloaded).toEqual(['ch01-text.json']);
  });
});

// A gradient has to mean the same thing in the editor's CSS and on the
// exporter's canvas, and per-stop alpha is the part of that agreement with two
// spellings: a hex where the stop is opaque, an rgba() where it is not. What is
// pinned here is the canvas half - that every stop reaches `addColorStop`, in
// order, at its own position, carrying its own alpha.
describe('gradient stops reach the canvas', () => {
  const gradBox = (gradient) => ({
    id: 'g1',
    lineN: null,
    text: 'HELLO',
    x: 40,
    y: 40,
    w: 360,
    h: 200,
    style: normalizeStyle({ size: 20, strokes: [], shadows: [], gradient: { on: true, ...gradient } }),
  });
  const render = (box) => renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });

  it('adds one stop per stop, in order, with per-stop alpha', async () => {
    await render(
      gradBox({
        stops: [
          { color: '#ff0000', pos: 0, opacity: 1 },
          { color: '#00ff00', pos: 0.4, opacity: 0.5 },
          { color: '#0000ff', pos: 1, opacity: 0 },
        ],
      }),
    );
    expect(gradStops).toHaveLength(1);
    expect(gradStops[0].kind).toBe('linear');
    expect(gradStops[0].stops).toEqual([
      [0, '#ff0000'],
      [0.4, 'rgba(0,255,0,0.5)'],
      [1, 'rgba(0,0,255,0)'],
    ]);
  });

  it('says the same thing on a radial gradient', async () => {
    await render(
      gradBox({
        kind: 'radial',
        stops: [
          { color: '#ffffff', pos: 0, opacity: 0.25 },
          { color: '#000000', pos: 1, opacity: 1 },
        ],
      }),
    );
    expect(gradStops[0].kind).toBe('radial');
    expect(gradStops[0].stops).toEqual([
      [0, 'rgba(255,255,255,0.25)'],
      [1, '#000000'],
    ]);
  });

  // Eight is the panel's ceiling, so eight is what a canvas gradient has to
  // carry - and the positions have to arrive sorted, which is `normalizeStyle`'s
  // job rather than the exporter's.
  it('carries eight stops, sorted, however they were written', async () => {
    const stops = [0.9, 0.1, 0.5, 0.3, 0.7, 0, 1, 0.2].map((pos, i) => ({
      color: '#112233',
      pos,
      opacity: 1,
      i,
    }));
    await render(gradBox({ stops }));
    expect(gradStops[0].stops.map(([p]) => p)).toEqual([0, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1]);
  });
});

// A pattern fill was the one half of the exporter's painting no test could see:
// the stub answered null to `createPattern`, every patterned box quietly fell
// through to `s.color`, and the tile's pitch and its anchor - the two numbers a
// tiled fill is - went unread. Both are now recorded.
describe('pattern fills reach the canvas', () => {
  const patBox = (pattern, over = {}) => ({
    id: 'p1',
    lineN: null,
    text: 'ONE',
    x: 40,
    y: 40,
    w: 360,
    h: 200,
    style: normalizeStyle({
      size: 20,
      strokes: [],
      shadows: [],
      pattern: { on: true, kind: 'halftone', fg: '#000000', bg: '#ffffff', scale: 1, ...pattern },
      ...over,
    }),
  });
  const render = (box) => renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });

  it('tiles the glyphs with the pattern rather than filling them flat', async () => {
    const box = patBox();
    await render(box);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].repeat).toBe('repeat');
    // The fill the letters were actually painted with is the pattern handle,
    // not the style's colour - which is what the null stub used to leave it as.
    expect(fills.at(-1)?.pattern).toBe(patterns[0]);
  });

  // The seam: the tile is rasterised at a whole number of device px and then
  // repeated at a pitch stated in page px. Unsnapped those two disagree by up to
  // half a pixel, so each repeat resamples at a different sub-pixel phase and
  // some pairs of tiles meet in a hairline. Snapped, the tile maps 1:1 onto the
  // 2x raster - the scale below is exactly 1/2 - and there is no resampling to
  // seam. `scale: 1.05` is deliberately a size that did not divide before.
  it('snaps the tile so every repeat lands on the raster’s own grid', async () => {
    const box = patBox({ scale: 1.05 });
    await render(box);
    const pitch = patternTilePx(box.style);
    expect(pitch * TILE_SS).toBe(Math.round(pitch * TILE_SS)); // a whole raster tile
    expect(patterns[0].tile).toEqual([pitch * TILE_SS, pitch * TILE_SS]);
    const [a, , , d] = patterns[0].transform;
    expect(a).toBe(1 / TILE_SS);
    expect(d).toBe(1 / TILE_SS);
  });

  it('anchors the grid at the fill rect’s corner, where CSS anchors it', async () => {
    const box = patBox();
    await render(box);
    // Straight text: no per-glyph transform, so the anchor is the content box's
    // top-left in the bitmap - `pad` in from its edge, plus the box padding, and
    // down by the vertical centring.
    const pad = 4; // nothing paints outside the glyphs on this box
    const lineH = box.style.size * box.style.lineHeight;
    const [, , , , e, f] = patterns[0].transform;
    expect(e).toBe(pad + BOX_PAD);
    expect(f).toBe(pad + (box.h - lineH) / 2);
  });
});

// Curved text is drawn one glyph at a time, under that glyph's own rotation, and
// the fill has to be stated in that frame. The editor states it by hanging the
// gradient or the tile on each glyph's span as a background: a background is
// laid out in the element's box and then carried through its transform, so it
// slides to the glyph AND turns with it, while every span is given the same
// origin - the box's corner - so one ramp runs across the whole word.
//
// The export used to do neither: it inverse-rotated the endpoints (holding the
// ramp fixed in box space, so the letters at the ends of the arc were painted
// with a differently-angled ramp than the canvas shows) and anchored the tile at
// each glyph's own origin (so the tone's grid restarted on every letter).
describe('curved text carries one fill across the letters', () => {
  const curved = (fill) => ({
    id: 'c1',
    lineN: null,
    text: 'ARC',
    x: 40,
    y: 40,
    w: 360,
    h: 200,
    style: normalizeStyle({ size: 20, curve: 60, strokes: [], shadows: [], ...fill }),
  });
  const render = (box) => renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });

  it('turns the gradient with each letter, as the letter’s own background does', async () => {
    const box = curved({ gradient: { on: true, angle: 90, stops: [{ color: '#fff', pos: 0 }, { color: '#000', pos: 1 }] } });
    await render(box);
    const glyphs = arcLayout(box.text, box.style, box.style.size);
    expect(gradStops).toHaveLength(glyphs.length);
    // The gradient is built in the glyph's rotated frame, so its direction is
    // the SAME vector for every glyph: the rotation is the glyph's to apply.
    const dirs = gradStops.map(({ args: [x0, y0, x1, y1] }) => [x1 - x0, y1 - y0]);
    for (const [dx, dy] of dirs) {
      expect(dx).toBeCloseTo(dirs[0][0], 6);
      expect(dy).toBeCloseTo(dirs[0][1], 6);
    }
    // ...and it is the direction the box's own angle asks for: 90deg runs left
    // to right, with no rotation left in it.
    expect(dirs[0][0]).toBeGreaterThan(0);
    expect(dirs[0][1]).toBeCloseTo(0, 6);
    // The glyphs are genuinely turned, or the claim above is vacuous.
    expect(Math.max(...glyphs.map((g) => Math.abs(g.rot)))).toBeGreaterThan(0.1);
  });

  it('slides the gradient onto each letter, so one ramp spans the word', async () => {
    const box = curved({ gradient: { on: true, angle: 90, stops: [{ color: '#fff', pos: 0 }, { color: '#000', pos: 1 }] } });
    await render(box);
    const glyphs = arcLayout(box.text, box.style, box.style.size);
    // Each glyph's endpoints are the box's, moved by that glyph's offset - so
    // adding the offset back gives one set of endpoints for the whole box.
    const back = gradStops.map(({ args: [x0] }, i) => x0 + glyphs[i].x);
    for (const v of back) expect(v).toBeCloseTo(back[0], 6);
  });

  it('runs the pattern’s grid on across the letters instead of restarting it', async () => {
    const box = curved({ pattern: { on: true, kind: 'halftone', fg: '#000', bg: '#fff', scale: 1 } });
    await render(box);
    const glyphs = arcLayout(box.text, box.style, box.style.size);
    expect(patterns).toHaveLength(glyphs.length);
    // Same claim as the gradient's: the anchor moves with the glyph, so the tile
    // grid is continuous. Anchored at the glyph (which is what this did) every
    // one of these would be 0 instead.
    const back = patterns.map((p, i) => p.transform[4] + glyphs[i].x);
    for (const v of back) expect(v).toBeCloseTo(back[0], 6);
    expect(patterns.some((p) => p.transform[4] !== 0)).toBe(true);
  });
});

// One box wearing everything at once, read off pass by pass. Each effect has a
// test of its own above; what this pins is how they COMBINE - which passes
// happen, in what order, over what raster - because that is where the editor and
// the export drifted apart (the blur and the roughening were applied in opposite
// orders on the two sides for as long as both existed).
describe('a box with every effect on at once', () => {
  it('paints shadow, strokes, gradient fill and displacement in that order', async () => {
    const box = {
      id: 'x1',
      lineN: null,
      text: 'ONE',
      x: 40,
      y: 40,
      w: 360,
      h: 200,
      style: normalizeStyle({
        size: 20,
        strokes: [{ color: '#ffffff', width: 3, opacity: 1 }],
        shadows: [{ x: 2, y: 3, blur: 4, color: '#000000', opacity: 0.6 }],
        gradient: {
          on: true,
          scope: 'box',
          angle: 90,
          stops: [
            { color: '#ff0000', pos: 0, opacity: 1 },
            { color: '#0000ff', pos: 1, opacity: 0.5 },
          ],
        },
        roughen: { on: true, amount: 4, detail: 0.05, seed: 7 },
      }),
    };
    await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });

    // The footprint: the strokes reach 3px out, the shadow hypot(2,3) + twice
    // its blur past that, roughening 4 + 2, and 4 besides - so 19 on every edge.
    const pad = 19;
    expect(displaced).toEqual([[(360 + pad * 2) * 2, (200 + pad * 2) * 2]]);

    // One silhouette pass in the shadow's colour at the outermost band's width,
    // then the real stroke over the text itself.
    expect(stroked.map((k) => [k.color, k.width])).toEqual([
      ['#000000', 6],
      ['#ffffff', 6],
    ]);
    expect(shadowed).toEqual([{ x: 4, y: 6, filter: 'blur(4px)', alpha: 0.6 }]);

    // Two fills: the shadow's flat silhouette, then the gradient over the glyphs.
    expect(painted).toEqual(['ONE', 'ONE']);
    expect(fills[0]).toBe('#000000');
    expect(typeof fills[1]).toBe('object');
    expect(gradStops).toHaveLength(1);
    expect(gradStops[0].stops).toEqual([
      [0, '#ff0000'],
      [1, 'rgba(0,0,255,0.5)'],
    ]);

    // The gradient spans the content box - the box less its text inset (the
    // padding plus the 3px outline's reach) on each side, as tall as the block -
    // and 90deg runs it left to right across exactly that width.
    const lineH = box.style.size * box.style.lineHeight;
    const [x0, y0, x1, y1] = gradStops[0].args;
    expect(textInset(box.style)).toBe(BOX_PAD + 3);
    expect(x0).toBeCloseTo(pad + textInset(box.style), 6);
    expect(x1).toBeCloseTo(pad + box.w - textInset(box.style), 6);
    expect(y0).toBeCloseTo(pad + (box.h - lineH) / 2 + lineH / 2, 6);
    expect(y1).toBeCloseTo(y0, 6);

    // And the glyphs still land where an effect-less box would put them.
    expect([composited.at(-1)[0] + placed.at(-1)[0], composited.at(-1)[1] + placed.at(-1)[1]]).toEqual([
      box.x + box.w / 2,
      box.y + (box.h - lineH) / 2 + baselineInLine(box.style, box.style.size),
    ]);
  });

  it('blurs before it roughens, the order the editor’s filter list states', async () => {
    // A CSS `filter: blur() url(#rough)` blurs first and displaces the blurred
    // picture. On the canvas that is one more composite before the displacement
    // pass, and the pass runs over the blurred canvas - so the displaced raster
    // is the LAST thing the render touches.
    const box = {
      id: 'x2',
      lineN: null,
      text: 'ONE',
      x: 40,
      y: 40,
      w: 360,
      h: 200,
      style: normalizeStyle({
        size: 20,
        strokes: [],
        shadows: [],
        blur: 3,
        roughen: { on: true, amount: 4, detail: 0.05, seed: 7 },
      }),
    };
    await renderPageCanvas({ id: 7, w: 800, h: 1200, lines: [], boxes: [box] });
    // Two composites: the box into the blur canvas, then the blurred box onto
    // the page. The displacement happened on the blur canvas, between them.
    expect(composited).toHaveLength(2);
    expect(displaced).toHaveLength(1);
    expect(order.indexOf('blur')).toBeLessThan(order.indexOf('displace'));
  });
});

// The export dialog closes as Export All starts, and the way back to the
// project - and into another chapter - stays live under it. The export walks
// the page objects it started with, but their pictures are minted by file
// name from whichever chapter `page-images.js` is pointed at, so two chapters
// whose raws are both `001.png` put the old chapter's lettering over the new
// chapter's art. What "another chapter is opened" does to the modules
// here is what `closeChapter` and `loadChapter` do to them.
describe('an export is of the chapter it began on', () => {
  const chapterPages = () => [1, 2, 3].map((n) => ({ id: n, file: `00${n}.png`, raw: null, cleaned: null, w: 800, h: 1200, lines: [], boxes: [] }));
  let reads;
  beforeEach(() => {
    naturalSizes = { 'blob:test': [800, 1200] };
    reads = [];
    vi.spyOn(fsx, 'join').mockImplementation(async (...parts) => parts.join('/'));
    vi.spyOn(fsx, 'assetUrl').mockResolvedValue(null);
    vi.spyOn(fsx, 'readFile').mockImplementation(async (path) => {
      reads.push(path);
      return new Uint8Array([1, 2, 3]);
    });
    setChapterImageDirs('/a/raws', null);
    loadProjectPages(chapterPages());
  });
  const openAnother = () => {
    releaseAllPageImages();
    loadProjectPages(chapterPages());
    setChapterImageDirs('/b/raws', null);
  };

  it('stops before a page of it is drawn from the next chapter\'s art', async () => {
    // The first file out is the moment the user goes back and opens another.
    const make = globalThis.document.createElement;
    globalThis.document.createElement = (tag) => {
      const el = make(tag);
      if (tag !== 'canvas') {
        const click = el.click;
        el.click = function () {
          click.call(this);
          if (downloaded.length === 1) openAnother();
        };
      }
      return el;
    };

    expect(await exportImages('PNG', 'all')).toBe(false);

    expect(downloaded).toEqual(['ch01-1.png']);
    expect(reads.filter((r) => r.startsWith('/b/'))).toEqual([]);
  });

  it('does not write the page that was being drawn when the chapter went', async () => {
    const make = globalThis.document.createElement;
    let blobs = 0;
    globalThis.document.createElement = (tag) => {
      const el = make(tag);
      if (tag === 'canvas') {
        const toBlob = el.toBlob;
        el.toBlob = function (cb, ...rest) {
          // Page two's pixels are finished; its chapter is closed under it.
          if (++blobs === 2) openAnother();
          return toBlob.call(this, cb, ...rest);
        };
      }
      return el;
    };

    expect(await exportImages('PNG', 'all')).toBe(false);

    expect(downloaded).toEqual(['ch01-1.png']);
  });

  it('is all of it when nothing is opened under it', async () => {
    expect(await exportImages('PNG', 'all')).toBe(true);
    expect(downloaded).toEqual(['ch01-1.png', 'ch01-2.png', 'ch01-3.png']);
    expect(reads).toEqual(['/a/raws/001.png', '/a/raws/002.png', '/a/raws/003.png']);
  });
});

describe('renderPageCanvas robustness', () => {
  it('handles a page object missing the boxes property without throwing', async () => {
    const canvas = await renderPageCanvas({ id: 1, w: 800, h: 1200 });
    expect(canvas).toBeDefined();
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(1200);
  });
});

describe('stripPageSuffix - single-page save stem logic', () => {
  it('strips the page suffix when it matches the exported page id', () => {
    expect(stripPageSuffix('Chapter-10-1', 1)).toBe('Chapter-10');
    expect(stripPageSuffix('MyManga-5', 5)).toBe('MyManga');
    expect(stripPageSuffix('special-edition-1', '1')).toBe('special-edition');
  });

  it('preserves numbered chapter names when not matching page id', () => {
    expect(stripPageSuffix('Chapter-10', 1)).toBe('Chapter-10');
    expect(stripPageSuffix('Chapter-10', null)).toBe('Chapter-10');
    expect(stripPageSuffix('Vol-1-Ch-05', 1)).toBe('Vol-1-Ch-05');
  });

  it('strips actual matching page id on numbered chapters', () => {
    expect(stripPageSuffix('Chapter-10', 10)).toBe('Chapter');
  });
});

// The export name is free text the user types and the app persists, and it
// becomes a filename on three platforms. Windows is the strict one, so these
// are the cases that pass silently on the Mac this is developed on and fail
// only once someone runs the build we ship.
describe('an export name is reduced to a filename every platform accepts', () => {
  it('drops path separators and traversal', () => {
    expect(sanitizeExportName('a/b')).toBe('ab');
    expect(sanitizeExportName('a\\b')).toBe('ab');
    expect(sanitizeExportName('../../etc/passwd')).toBe('etcpasswd');
  });

  it('drops the characters Windows refuses in a filename', () => {
    expect(sanitizeExportName('Ch1: Prologue')).toBe('Ch1 Prologue');
    expect(sanitizeExportName('what?')).toBe('what');
    expect(sanitizeExportName('a*b"c<d>e|f')).toBe('abcdef');
    expect(sanitizeExportName('tab\there')).toBe('tabhere');
  });

  it('drops a trailing dot or space, which Windows would drop for us', () => {
    // The danger is not the rejection but the rewrite: Windows creates `a` and
    // a later read of `a.` misses, so the two names have to agree here.
    expect(sanitizeExportName('chapter.')).toBe('chapter');
    expect(sanitizeExportName('chapter ')).toBe('chapter');
    expect(sanitizeExportName('chapter . . ')).toBe('chapter');
  });

  it('keeps unicode, spaces and inner dots', () => {
    expect(sanitizeExportName('第1話 ページ')).toBe('第1話 ページ');
    expect(sanitizeExportName('ch 1 v2.1')).toBe('ch 1 v2.1');
  });

  it('suffixes DOS reserved device names, with or without an extension', () => {
    expect(sanitizeExportName('nul')).toBe('nul-x');
    expect(sanitizeExportName('COM1')).toBe('COM1-x');
    expect(sanitizeExportName('nul.png')).toBe('nul.png-x');
    expect(sanitizeExportName('nullable')).toBe('nullable');
  });

  it('falls back to `page` when nothing survives', () => {
    expect(sanitizeExportName('')).toBe('page');
    expect(sanitizeExportName(null)).toBe('page');
    expect(sanitizeExportName('///')).toBe('page');
    expect(sanitizeExportName('...')).toBe('page');
    expect(sanitizeExportName('   ')).toBe('page');
  });
});
