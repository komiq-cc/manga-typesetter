import { afterAll, beforeAll, describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { renderBoxLayer } from './exporter.js';
import { textEngine, setTextEngine, glyphPainter, setGlyphPainter } from './text-engine/index.js';
import { createRustGlyphPainter } from './text-engine/rust-painter.js';
import { setTypesetEnabled, typesetEnabled, clearLayoutMemo } from './measure.js';
import { defaultStyle, normalizeStyle } from './data.js';
import { FX_CASES } from '../test/fx-compare/cases.js';

// ===========================================================================
// Before and after pictures of a box, for a person to look at
// ===========================================================================
// Not a test: nothing here can fail on a picture. It paints every case in
// src/test/fx-compare/cases.js twice with the Rust engine - once with the
// painter's newer abilities switched off, which is the picture the app made
// before them (the pass done by the canvas over finished pixels, and a
// pattern's tile drawn by the canvas), and once with them on - and writes the two side by side as a PNG.
//
//   MT_FX_COMPARE=docs/text-port/compare npx vitest run --project engine fx-compare
//
// Without the variable it does nothing. The canvas is Skia's
// (@napi-rs/canvas); the glyphs are the engine's.

const OUT = process.env.MT_FX_COMPARE;
// What the painter says it can do itself. "Before" is the painter without
// them, so each falls back to the canvas pass it replaced.
const ABILITIES = ['roughen', 'box'];

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
const before = { engine: textEngine(), painter: glyphPainter(), typeset: typesetEnabled() };
let rust;

beforeAll(async () => {
  if (!OUT) return;
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  rust = await rustEngine();
  setTextEngine(rust);
  setTypesetEnabled(true);
  clearLayoutMemo();
});
afterAll(() => {
  if (!OUT) return;
  setTextEngine(before.engine);
  setGlyphPainter(before.painter);
  setTypesetEnabled(before.typeset);
  clearLayoutMemo();
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

const boxOf = (c) => ({
  id: 'b',
  lineN: null,
  text: c.text ?? 'ROUGH\nEDGES',
  x: 140,
  y: 140,
  w: c.w ?? 320,
  h: c.h ?? 150,
  style: normalizeStyle({ ...defaultStyle(), font: 'Bangers', size: 56, ...c.style }),
});

// The engine as a wasm built before it drew pattern tiles looks to the
// painter, so the tile is the canvas's again.
function withoutTiles(engine) {
  const exports = { ...engine.low.exports, mt_paint_pattern_tile: undefined };
  return Object.create(engine, { low: { value: Object.create(engine.low, { exports: { value: exports } }) } });
}

function painted(box, old) {
  const full = createRustGlyphPainter(old ? withoutTiles(rust) : rust);
  const painter = old ? Object.fromEntries(Object.entries(full).filter(([k]) => !ABILITIES.includes(k))) : full;
  setGlyphPainter(painter);
  clearLayoutMemo();
  // The box as the page composite lays it down - turned and mirrored where
  // it is - at twice the page's resolution, cut to its ink.
  const layer = renderBoxLayer(box, 600, 440, null, { id: 1, w: 600, h: 440, lines: [], boxes: [box] }, 2, null);
  const canvas = createCanvas(layer?.imageData.width ?? 1, layer?.imageData.height ?? 1);
  if (layer) canvas.getContext('2d').putImageData(layer.imageData, 0, 0);
  return { canvas };
}

// The two pictures on one sheet, each on the paper colour, pixel for pixel.
function sheet(c, a, b) {
  const pad = 24;
  const head = 40;
  const w = Math.max(a.canvas.width, b.canvas.width);
  const h = Math.max(a.canvas.height, b.canvas.height);
  const cnv = createCanvas(pad * 3 + w * 2, head + h + pad);
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = c.paper ?? '#ffffff';
  ctx.fillRect(0, 0, cnv.width, cnv.height);
  ctx.fillStyle = '#666666';
  ctx.font = '20px sans-serif';
  ctx.fillText(`${c.name}: before`, pad, 28);
  ctx.fillText('after', pad * 2 + w, 28);
  ctx.drawImage(a.canvas, pad, head);
  ctx.drawImage(b.canvas, pad * 2 + w, head);
  return cnv;
}

describe.skipIf(!OUT)('before and after pictures', () => {
  it('are written', () => {
    const dir = resolve(OUT);
    mkdirSync(dir, { recursive: true });
    for (const c of FX_CASES) {
      const box = boxOf(c);
      const cnv = sheet(c, painted(box, true), painted(box, false));
      writeFileSync(resolve(dir, `${c.name}.png`), cnv.toBuffer('image/png'));
    }
  });
});
