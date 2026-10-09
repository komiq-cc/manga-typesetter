import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_RASTER_SIDE } from './rust-painter.js';

// The engine refuses a raster with a side over `MAX_SIDE` (text-engine/src/
// paint/mod.rs) and does not say what the number is over the wire. The
// painter states it for the page - once, in rust-painter.js - and this is what
// keeps that statement the engine's: it is read here out of the Rust source.
describe('the largest raster side the Rust painter says it paints', () => {
  it('is the engine\'s MAX_SIDE', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../text-engine/src/paint/mod.rs', import.meta.url)), 'utf8');
    const m = /pub const MAX_SIDE: u32 = (\d[\d_]*);/.exec(src);
    expect(m).not.toBe(null);
    expect(MAX_RASTER_SIDE).toBe(Number(m[1].replaceAll('_', '')));
  });
});
