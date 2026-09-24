import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ===========================================================================
// "Place chapter": every balloon measured, then everything placed (DET-1)
// ===========================================================================
// chapter-fit.test.js pins the measuring loop on its own. This file is the
// store's half: that the answers reach the boxes, that a page is placed the
// same whether or not it happened to be in the click cache, that a cancel or a
// change under the run commits nothing it should not, and that the answers
// are kept on the detected blocks so a second press reads no pixels.
//
// The mocks are the ones balloon-wiring.test.js grants, plus the decode:
//
//   `pagePixelsFor` is the click cache, and the test decides which pages are
//   in it. `peekPagePixels` answers nothing, so every page the run wants is
//   read through the real `readRaster` - a stand-in `Image` - and the real
//   `decodeImagePixels` is replaced by a lookup from the picture's URL to the
//   pixels drawn for it, which is also the decoder spy.
//   `canMeasure` is the permission to use the stand-in metric.
const cache = new Map();
const rasters = new Map();
let decodes = [];
let onDecode = null;
vi.mock('./page-pixels.js', async (importOriginal) => ({
  ...(await importOriginal()),
  pagePixelsFor: (p) => cache.get(p?.id) ?? null,
  peekPagePixels: () => null,
  decodeImagePixels: (img) => {
    decodes.push(img.src);
    onDecode?.(img.src);
    return rasters.get(img.src) ?? null;
  },
}));
vi.mock('./measure.js', async (importOriginal) => ({
  ...(await importOriginal()),
  canMeasure: () => true,
}));

class FakeImage {
  constructor() {
    this.src = '';
  }
  decode() {
    return Promise.resolve();
  }
  removeAttribute(k) {
    if (k === 'src') this.src = '';
  }
}
const realImage = globalThis.Image;
globalThis.Image = FakeImage;
afterAll(() => {
  globalThis.Image = realImage;
});

const {
  app,
  loadProjectPages,
  placeDetectedInChapter,
  placeDetectedOnPage,
  cancelChapterPlace,
  rescalePageGeometry,
} = await import('./store.svelte.js');
const hist = await import('./editor/history.svelte.js');

// ---------------------------------------------------------------------------
// The page: one oval balloon with a column of Japanese in it, as in
// balloon-wiring.test.js.
// ---------------------------------------------------------------------------
const PAPER = 248;
const INK = 18;

function pageImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4).fill(PAPER);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width: w, height: h, data };
}
const put = (img, x, y, v) => {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
};
const fillRect = (img, x, y, w, h, v) => {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(img, xx, yy, v);
};
function drawEllipse(img, cx, cy, rx, ry, ring = 3) {
  const r = (x, y, g) => Math.hypot((x + 0.5 - cx) / (rx + g), (y + 0.5 - cy) / (ry + g));
  for (let y = Math.floor(cy - ry - ring - 2); y <= Math.ceil(cy + ry + ring + 2); y++) {
    for (let x = Math.floor(cx - rx - ring - 2); x <= Math.ceil(cx + rx + ring + 2); x++) {
      if (r(x, y, 0) <= 1) put(img, x, y, PAPER);
      else if (r(x, y, ring) <= 1) put(img, x, y, INK);
    }
  }
}
function drawGlyphColumn(img, x, y, w, h, glyph = 22, gapY = 6) {
  for (let gy = y; gy + glyph <= y + h; gy += glyph + gapY) {
    fillRect(img, x, gy, w, glyph, INK);
    fillRect(img, x + 4, gy + 4, Math.max(1, w - 8), Math.max(1, glyph - 8), PAPER);
  }
}
const ovalPage = () => {
  const img = pageImage(500, 500);
  drawEllipse(img, 250, 250, 130, 80);
  drawGlyphColumn(img, 240, 180, 20, 140);
  return img;
};

const TEXT = 'We have to get out of here before it all comes down';
const page = (id, { detect = true } = {}) => ({
  id,
  w: 500,
  h: 500,
  raw: `raw:${id}`,
  file: `${id}.png`,
  lines: [{ n: 1, jp: 'あ', en: TEXT, type: 'dialogue' }],
  boxes: [],
  detect: detect ? { panels: [], boxes: [{ n: 1, box: [240, 180, 260, 320], vertical: true, font_size: 20 }] } : null,
});
const chapter = (n = 3) => Array.from({ length: n }, (_, i) => page(i + 1));
const geom = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, size: b.style.size, fit: b.fit });
const placed = () => app.pages.map((p) => p.boxes.map(geom));

beforeEach(() => {
  cache.clear();
  rasters.clear();
  for (let id = 1; id <= 4; id++) rasters.set(`raw:${id}`, ovalPage());
  decodes = [];
  onDecode = null;
  app.chapterRef = null;
  app.chapterMode = 'typeset';
  hist.initHistory();
  hist.resetHistory();
});

describe('placing a whole chapter', () => {
  it('places every page as a fitted placement, whichever pages were loaded', async () => {
    const runs = [];
    for (const loaded of [[], [1], [1, 2, 3]]) {
      loadProjectPages(chapter());
      for (const id of loaded) cache.set(id, ovalPage());
      expect(await placeDetectedInChapter()).toBe(3);
      runs.push(placed());
    }
    expect(runs[0][0][0].fit?.kind).toBe('ellipse');
    // Every page the same as every other, and every run the same as every other.
    for (const run of runs) for (const boxes of run) expect(boxes).toEqual(runs[0][0]);
    // And the same box a click on a decoded page gives.
    loadProjectPages([page(1)]);
    cache.set(1, ovalPage());
    placeDetectedOnPage();
    expect(app.pages[0].boxes.map(geom)).toEqual(runs[0][0]);
  });

  it('reads each page with something to place once, and no other page', async () => {
    const pages = [...chapter(2), page(3, { detect: false }), page(4)];
    pages[3].boxes = [{ id: 'kept', lineN: 1, x: 0, y: 0, w: 10, h: 10, style: {} }];
    loadProjectPages(pages);
    await placeDetectedInChapter();
    expect(decodes).toEqual(['raw:1', 'raw:2']);
  });

  it('places nothing, records nothing and keeps nothing when cancelled part-way', async () => {
    loadProjectPages(chapter());
    onDecode = (src) => {
      if (src === 'raw:1') cancelChapterPlace();
    };
    expect(await placeDetectedInChapter()).toBe(0);
    expect(app.pages.every((p) => p.boxes.length === 0)).toBe(true);
    expect(app.pages.every((p) => p.detect.boxes[0].fit === undefined)).toBe(true);
    expect(hist.peekStack().undo).toEqual([]);
    expect(app.chapterPlace).toBe(null);
    expect(app.toast.msg).toContain('nothing was placed');
  });

  it('shows how far it has got while it measures', async () => {
    loadProjectPages(chapter());
    const seen = [];
    onDecode = () => seen.push({ ...app.chapterPlace });
    const run = placeDetectedInChapter();
    expect(app.chapterPlace).toEqual({ done: 0, total: 3 });
    // A second press while the first is running does nothing.
    expect(await placeDetectedInChapter()).toBe(0);
    await run;
    expect(seen).toEqual([
      { done: 0, total: 3 },
      { done: 1, total: 3 },
      { done: 2, total: 3 },
    ]);
    expect(app.chapterPlace).toBe(null);
  });

  it('leaves a page alone whose art changed under the run', async () => {
    loadProjectPages(chapter());
    onDecode = (src) => {
      if (src === 'raw:3') app.pages[0].cleanedFile = '1-clean.png';
    };
    expect(await placeDetectedInChapter()).toBe(2);
    expect(app.pages.map((p) => p.boxes.length)).toEqual([0, 1, 1]);
    expect(app.pages[0].detect.boxes[0].fit).toBe(undefined);
    expect(app.toast.msg).toContain('1 page changed while fitting');
  });

  it('commits nothing into a chapter that replaced the one it measured', async () => {
    loadProjectPages(chapter());
    onDecode = (src) => {
      if (src === 'raw:2') loadProjectPages(chapter(2));
    };
    expect(await placeDetectedInChapter()).toBe(0);
    expect(app.pages.every((p) => p.boxes.length === 0)).toBe(true);
  });

  it('keeps what it measured through a save, a load and a rescale, and reads no pixels again', async () => {
    loadProjectPages(chapter());
    await placeDetectedInChapter();
    const fits = app.pages.map((p) => p.detect.boxes[0].fit);
    expect(fits.every((f) => f?.kind === 'ellipse')).toBe(true);
    // Saved, and reopened with every box deleted.
    const saved = JSON.parse(JSON.stringify(app.pages)).map((p) => ({
      ...p,
      boxes: [],
      lines: p.lines.map(({ placed, ...l }) => l),
    }));
    loadProjectPages(saved);
    expect(app.pages.map((p) => p.detect.boxes[0].fit)).toEqual(fits);
    rescalePageGeometry(app.pages[0], 2, 2);
    app.pages[0].w = 1000;
    app.pages[0].h = 1000;
    const f = fits[0];
    expect(app.pages[0].detect.boxes[0].fit).toEqual({ kind: 'ellipse', cx: f.cx * 2, cy: f.cy * 2, rx: f.rx * 2, ry: f.ry * 2 });
    decodes = [];
    expect(await placeDetectedInChapter()).toBe(3);
    expect(decodes).toEqual([]);
    expect(app.pages[0].boxes[0].fit).toEqual(app.pages[0].detect.boxes[0].fit);
    expect(app.pages[1].boxes[0].fit).toEqual(fits[1]);
  });

  it('keeps a balloon measured as irregular as measured, and places the rectangle', async () => {
    rasters.set('raw:1', pageImage(500, 500));
    loadProjectPages(chapter(1));
    expect(await placeDetectedInChapter()).toBe(1);
    expect(app.pages[0].detect.boxes[0].fit).toBe(null);
    expect(app.pages[0].boxes[0].fit).toBe(null);
  });
});
