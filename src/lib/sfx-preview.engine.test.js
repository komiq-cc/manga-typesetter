import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { rustEngine, FIXTURE_FACES } from '../test/rust-engine.js';
import { textEngine, setTextEngine, setGlyphPainter, glyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { sfxPresets, applySfxPreset } from './sfx.js';
import { cardSpec, cardText, paintCard, paintStage, CARD_W, CARD_H } from './sfx-preview.js';

// ===========================================================================
// The SFX panel's pictures, painted by the real engine
// ===========================================================================
// The panel's own cases (SfxPanel.dom.test.js) stand the painters in. This is
// the painter: a card for every built-in preset and the stage, through the
// exporter's texture, on a real canvas, read back as pixels.

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const defaultEngine = textEngine();
const defaultPainter = glyphPainter();
let rust;
beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  for (const [family, , file] of FIXTURE_FACES) {
    GlobalFonts.registerFromPath(fileURLToPath(new URL(`../test/fonts/${file}`, import.meta.url)), family);
  }
  rust = await rustEngine();
  setTextEngine(rust);
  setGlyphPainter(createRustGlyphPainter(rust));
  clearLayoutMemo();
});
afterEach(() => clearLayoutMemo());
afterAll(() => {
  setTextEngine(defaultEngine);
  setGlyphPainter(defaultPainter);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

const style = (over = {}) => normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 40, ...over });

// How many pixels of a PNG data URL are inked, and where the ink spans.
async function ink(url) {
  const img = await loadImage(url);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let n = 0;
  let x0 = width;
  let x1 = -1;
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        n++;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  return { n, width, height, x0, x1, y0, y1 };
}

describe('a card', () => {
  it('is painted for every built-in preset, inside its tile, with ink in it', async () => {
    const presets = sfxPresets();
    expect(presets.length).toBeGreaterThan(0);
    const spec = cardSpec(style(), 'BOOM\nBAM');
    for (const p of presets) {
      const url = paintCard(spec, p, 1);
      expect(url, p.id).toMatch(/^data:image\/png;base64,/);
      const r = await ink(url);
      expect([r.width, r.height]).toEqual([CARD_W, CARD_H]);
      expect(r.n, p.id).toBeGreaterThan(20);
      // Cut to its ink and contained: nothing touches the tile's edge.
      expect(r.x0, p.id).toBeGreaterThan(0);
      expect(r.y0, p.id).toBeGreaterThan(0);
      expect(r.x1, p.id).toBeLessThan(CARD_W - 1);
      expect(r.y1, p.id).toBeLessThan(CARD_H - 1);
    }
  });

  it('differs from one preset to the next, and follows the box colour', async () => {
    const [a, b] = sfxPresets();
    const spec = cardSpec(style(), 'BOOM');
    expect(paintCard(spec, a, 1)).not.toBe(paintCard(spec, b, 1));
    const red = paintCard(cardSpec(style({ color: '#ff0000', strokes: [] }), 'BOOM'), a, 1);
    const black = paintCard(cardSpec(style({ color: '#000000', strokes: [] }), 'BOOM'), a, 1);
    expect(red).not.toBe(black);
  });

  // A Shape preset bends the whole box with a mesh, and the drip pulls
  // letters down: a card is the same picture of each, cut to the word first.
  it('is painted for the Shape preset and the drip, and they differ', async () => {
    const spec = cardSpec(style(), 'BOOM\nBAM');
    const byId = Object.fromEntries(sfxPresets().map((p) => [p.id, p]));
    const urls = {};
    for (const id of ['valley', 'drip']) {
      expect(byId[id], id).toBeTruthy();
      urls[id] = paintCard(spec, byId[id], 1);
      expect(urls[id], id).toMatch(/^data:image\/png;base64,/);
      const r = await ink(urls[id]);
      expect([r.width, r.height], id).toEqual([CARD_W, CARD_H]);
      expect(r.n, id).toBeGreaterThan(20);
      expect(r.x0, id).toBeGreaterThan(0);
      expect(r.y0, id).toBeGreaterThan(0);
      expect(r.x1, id).toBeLessThan(CARD_W - 1);
      expect(r.y1, id).toBeLessThan(CARD_H - 1);
    }
    expect(urls.valley).not.toBe(urls.drip);
  });

  it('paints at twice the pixels on a dense screen', async () => {
    const r = await ink(paintCard(cardSpec(style(), 'BAM'), sfxPresets()[0], 2));
    expect([r.width, r.height]).toEqual([CARD_W * 2, CARD_H * 2]);
  });

  it('cuts the text to eight code points and falls back to SFX', () => {
    expect(cardText('ABCDEFGHIJ')).toBe('ABCDEFGH');
    // Line breaks count as code points, and a cut that ends on one drops it.
    expect(cardText('GR\nIP!!\nXX')).toBe('GR\nIP!!');
    expect(cardText('ABCDEFG\nHIJ')).toBe('ABCDEFG');
    expect(cardText('')).toBe('SFX');
    expect(cardText('   \n ')).toBe('SFX');
    expect(cardText('😀😀😀😀😀😀😀😀😀')).toBe('😀'.repeat(8));
  });
});

describe('the stage', () => {
  it('paints the box as it is, plain or with a preset, cut to its ink', () => {
    const plain = style();
    const sfx = style();
    applySfxPreset(sfx, sfxPresets()[0]);
    const grab = (st) => {
      const canvas = createCanvas(300, 132);
      expect(paintStage(canvas, { style: st, text: 'BOOM', w: 240, h: 90 }, 1)).toBe(true);
      const { data } = canvas.getContext('2d').getImageData(0, 0, 300, 132);
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) n++;
      return { n, png: canvas.toBuffer('image/png').toString('base64') };
    };
    const a = grab(plain);
    const b = grab(sfx);
    expect(a.n).toBeGreaterThan(100);
    expect(b.n).toBeGreaterThan(100);
    expect(a.png).not.toBe(b.png);
  });

  it('shows the word SFX for a box with no text', () => {
    const canvas = createCanvas(300, 132);
    expect(paintStage(canvas, { style: style(), text: '', w: 240, h: 90 }, 1)).toBe(true);
    const { data } = canvas.getContext('2d').getImageData(0, 0, 300, 132);
    expect(data.some((v, i) => i % 4 === 3 && v > 8)).toBe(true);
  });
});
