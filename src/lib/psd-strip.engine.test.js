import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { readPsd, initializeCanvas } from 'ag-psd';
import { rustEngine } from '../test/rust-engine.js';
import { app, loadProjectPages, setFontSource } from './store.svelte.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { renderBoxLayer } from './exporter.js';
import { buildPagePsd, RASTER_MARK } from './psd.js';

// ===========================================================================
// A longstrip page's PSD holds the lettering that reaches it over a seam
// ===========================================================================
// A strip box belongs to one page and paints wherever its lettering goes; the
// strip export draws it across the seam. A PSD is written per source page,
// and each held only its own boxes on a page-sized canvas: a balloon over the
// seam kept its top in its owner's file, cut at the edge, and was not in the
// next page's file at all. Painted for real here (the Rust engine on a Skia
// canvas), and read back out of the file.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), layout: app.projectLayout };

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150), fonts: { ready: Promise.resolve() } };
  initializeCanvas((w, h) => createCanvas(w, h));
  const rust = await rustEngine();
  setTextEngine(rust);
  setGlyphPainter(createRustGlyphPainter(rust));
  clearLayoutMemo();
});
afterEach(() => {
  setFontSource(null);
  app.projectLayout = before.layout;
  loadProjectPages([]);
});
afterAll(() => {
  setTextEngine(before.engine);
  setGlyphPainter(before.painter);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Comic Neue', size: 30, autoHeight: false, ...over });
// Two lines in a box that starts 50 px above the seam and ends 50 below it.
const across = (over = {}) => ({ id: 'b1', lineN: null, text: 'TOP LINE\nLOW LINE', x: 20, y: 150, w: 260, h: 100, style: style(over) });
const HOLLOW = { noFill: true, strokes: [{ color: '#000000', width: 3, opacity: 1 }] };
const strip = (box) => {
  app.projectLayout = 'longstrip';
  loadProjectPages([
    { id: 1, w: 300, h: 200, lines: [], boxes: [box] },
    { id: 2, w: 300, h: 200, lines: [], boxes: [] },
  ]);
};
const READ = { useImageData: true, skipThumbnail: true };
const textLayers = (bytes) => (readPsd(bytes, READ).children ?? []).find((c) => c.name === 'Text')?.children ?? [];
const embedded = (bytes) => {
  const xmp = readPsd(bytes, READ).imageResources.xmpMetadata;
  return JSON.parse(Buffer.from(xmp.match(/<mt:project>([\s\S]*?)<\/mt:project>/)[1].trim(), 'base64').toString('utf8')).page;
};
const alpha = (img) => {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) n += img.data[i];
  return n;
};

describe('a box across the seam of two strip pages', () => {
  it('uses the copied column when the font gate refits a box across a seam', async () => {
    strip(across({ autoHeight: true }));
    const p = app.pages[0];
    p.boxes[0].text = 'ONE\nTWO\nTHREE\nFOUR\nFIVE';
    p.boxes[0].h = 20;
    let resume, asked;
    const ready = new Promise((resolve) => { resume = resolve; });
    const entered = new Promise((resolve) => { asked = resolve; });
    setFontSource({ ready: () => true, settle: () => { asked(); return ready; } });
    const building = buildPagePsd(p);
    await entered;
    app.pages.pop();
    resume();

    const project = embedded(await building);
    // The live strip now ends at 200, which would cap this at 50px. The copy
    // still has its neighbour and lets the original five lines grow past it.
    expect(project.boxes[0].h).toBeGreaterThan(50);
    expect(p.boxes[0].h).toBe(20);
  });

  it('holds neighbour text from before its first measurement await', async () => {
    strip(across({ strokes: [] }));
    const building = buildPagePsd(app.pages[1]);
    app.pages[0].boxes[0].text = 'EDITED';
    const layers = textLayers(await building);
    expect(layers).toHaveLength(1);
    expect(layers[0].text.text).toContain('LOW LINE');
    expect(layers[0].text.text).not.toContain('EDITED');
  });

  it('keeps type layers and embedded project in agreement across an image decode', async () => {
    strip(across({ strokes: [] }));
    const p = app.pages[0];
    p.boxes[0].text = null;
    p.boxes[0].lineN = 1;
    p.lines = [{ n: 1, en: 'BEFORE', tags: ['shout'] }];
    p.detect = { panels: [[0, 0, 300, 200]], boxes: [{ n: 1, box: [1, 2, 3, 4] }] };
    p.raw = 'blob:delayed';
    const oldImage = globalThis.Image;
    globalThis.Image = class {
      set src(_) {
        queueMicrotask(() => {
          p.lines[0].en = 'AFTER';
          p.lines[0].tags.push('edited');
          p.boxes[0].style.size = 60;
          p.detect.boxes[0].box[0] = 100;
          this.onerror(new Error('no art in this test'));
        });
      }
    };
    try {
      const bytes = await buildPagePsd(p);
      expect(p.lines[0].en).toBe('AFTER');
      expect(textLayers(bytes)[0].text.text.trim()).toBe('BEFORE');
      const project = embedded(bytes);
      expect(project.lines[0]).toMatchObject({ en: 'BEFORE', tags: ['shout'] });
      expect(project.boxes[0].style.size).toBe(30);
      expect(project.detect.boxes[0].box).toEqual([1, 2, 3, 4]);
    } finally {
      if (oldImage === undefined) delete globalThis.Image;
      else globalThis.Image = oldImage;
    }
  });

  it('is in the page below\'s file, the part of it that lands there', async () => {
    strip(across(HOLLOW));
    // The whole of it, as the strip shows it: one canvas the height of both.
    const whole = renderBoxLayer(app.pages[0].boxes[0], 300, 400, null, app.pages[0]);
    expect(whole.top).toBeLessThan(200);
    expect(whole.bottom).toBeGreaterThan(200);

    const upper = textLayers(await buildPagePsd(app.pages[0]));
    const lower = textLayers(await buildPagePsd(app.pages[1]));
    expect(upper).toHaveLength(1);
    expect(lower).toHaveLength(1);
    // Each file holds its side of the seam, and the two are the whole of it.
    expect(upper[0].top).toBe(whole.top);
    expect(upper[0].bottom).toBeLessThanOrEqual(200);
    expect(lower[0].top).toBeGreaterThanOrEqual(0);
    expect(lower[0].bottom).toBe(whole.bottom - 200);
    expect(alpha(upper[0].imageData) + alpha(lower[0].imageData)).toBe(alpha(whole.imageData));
    expect(lower[0].name.endsWith(RASTER_MARK)).toBe(true);
  });

  it('is a type layer set where its pixels are, in the page below\'s space', async () => {
    strip(across({ strokes: [] }));
    const upper = textLayers(await buildPagePsd(app.pages[0]));
    const lower = textLayers(await buildPagePsd(app.pages[1]));
    expect(lower).toHaveLength(1);
    expect(lower[0].text.text).toBe(upper[0].text.text);
    const [ua, ub, uc, ud, ux, uy] = upper[0].text.transform;
    expect(lower[0].text.transform).toEqual([ua, ub, uc, ud, ux, uy - 200]);
  });

  it('belongs to its own page still: the page below\'s project has no box of it', async () => {
    strip(across(HOLLOW));
    expect(embedded(await buildPagePsd(app.pages[1])).boxes).toEqual([]);
    expect(embedded(await buildPagePsd(app.pages[0])).boxes).toHaveLength(1);
  });

  it('a paged chapter\'s page is its own boxes and nothing else, as it was', async () => {
    strip(across(HOLLOW));
    app.projectLayout = 'pages';
    expect(textLayers(await buildPagePsd(app.pages[1]))).toHaveLength(0);
  });
});
