import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { readPsd, initializeCanvas } from 'ag-psd';
import { rustEngine } from '../test/rust-engine.js';
import { app, loadProjectPages } from './store.svelte.js';
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
