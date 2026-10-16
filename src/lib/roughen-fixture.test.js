import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FIXTURE, roughenFixture } from '../../text-engine/parity/roughen.mjs';

// The Rust engine roughens outlines with its own port of the noise field in
// text-paint.js, text-engine/src/paint/roughen.rs, and holds it to a file of
// that field's value at a fixed set of points. This is the other half: the
// file is what text-paint.js gives now.
describe('the noise field the Rust port is held to', () => {
  it('is what text-paint.js gives', () => {
    // A failure here means the JS field moved. Run
    //   node text-engine/parity/roughen.mjs
    // to write the file again, and port the change to
    // text-engine/src/paint/roughen.rs, whose test reads it.
    expect(roughenFixture()).toBe(readFileSync(FIXTURE, 'utf8'));
  });
});
