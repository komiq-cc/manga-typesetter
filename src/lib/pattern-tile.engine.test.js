import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { rustEngine } from '../test/rust-engine.js';
import { drawsPatternTiles, patternTile } from '../../text-engine/js/paint.mjs';
import { patternTileCanvas, patternTilePx, TILE_SS } from './text-paint.js';

// ===========================================================================
// A pattern tile drawn by the engine
// ===========================================================================
// With the Rust painter a pattern's tile is the engine's own drawing
// (text-engine/src/paint/pattern.rs), where it used to be a canvas's
// (`drawPatternTile`) handed over as pixels. The shapes are the same to the
// number; only the antialiasing of an edge is each rasteriser's own. Held
// here: for every kind, the engine's tile and the canvas's are the same
// picture - the same ink, and no pixel that is plainly one colour in one and
// the other colour in the other.
//
// The canvas is Skia's (@napi-rs/canvas).

const KINDS = ['dots', 'halftone', 'stripes', 'hstripes', 'diagonal', 'diagonal-alt', 'crosshatch', 'checker', 'grid', 'vlines', 'hlines'];

const hadDocument = 'document' in globalThis;
const oldDocument = globalThis.document;
let rust;

beforeAll(async () => {
  globalThis.document = { createElement: () => createCanvas(300, 150) };
  rust = await rustEngine({ fixtures: false });
});
afterAll(() => {
  if (hadDocument) globalThis.document = oldDocument;
  else delete globalThis.document;
});

function pair(kind, size, colours = {}) {
  const style = { size, pattern: { kind, scale: 1, fg: '#000000', bg: '#ffffff', ...colours } };
  const tile = patternTilePx(style);
  const cnv = patternTileCanvas(style, TILE_SS);
  const old = cnv.getContext('2d').getImageData(0, 0, cnv.width, cnv.height);
  const now = patternTile(rust.low, style.pattern, cnv.width, Math.max(1, tile * 0.12) / tile);
  return { old, now };
}

describe('a pattern tile drawn by the engine', () => {
  it('is what this wasm does', () => {
    expect(drawsPatternTiles(rust.low)).toBe(true);
  });

  it.each(KINDS)('%s is the canvas\'s tile but for the edge of a shape', (kind) => {
    for (const size of [24, 56, 110]) {
      const { old, now } = pair(kind, size);
      expect([now.width, now.height]).toEqual([old.width, old.height]);
      let sum = 0;
      let flipped = 0;
      for (let i = 0; i < old.data.length; i += 4) {
        expect(now.data[i + 3]).toBe(255);
        const d = Math.abs(now.data[i] - old.data[i]);
        sum += d;
        // Black in one and white in the other: a shape in another place.
        if (d > 200) flipped++;
      }
      const mean = sum / (old.data.length / 4);
      expect(flipped, `${kind} at ${size}`).toBe(0);
      expect(mean, `${kind} at ${size}`).toBeLessThan(4);
    }
  });

  it('paints the colours the style names', () => {
    const { old, now } = pair('stripes', 56, { fg: '#ff2d55', bg: '#1d4ed8' });
    const at = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
    expect(at(now, 3, 3)).toEqual([255, 45, 85, 255]);
    expect(at(now, now.width - 3, 3)).toEqual([29, 78, 216, 255]);
    expect(at(now, 3, 3)).toEqual(at(old, 3, 3));
  });

  it('answers null for a kind it does not know', () => {
    expect(patternTile(rust.low, { kind: 'plaid' }, 16, 0.12)).toBe(null);
  });
});
