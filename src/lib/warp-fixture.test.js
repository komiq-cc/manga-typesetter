import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FIXTURE, meshMapFixture } from '../../text-engine/parity/mesh-map.mjs';

// The Rust engine bends outlines with its own port of `meshMap` (warp.js),
// text-engine/src/paint/warp.rs, and holds it to a file of where warp.js sends
// a fixed set of points through a fixed set of meshes. This is the other half:
// the file is what warp.js gives now.
describe('the mesh map the Rust port is held to', () => {
  it('is what warp.js gives', () => {
    // A failure here means warp.js moved a point. Run
    //   node text-engine/parity/mesh-map.mjs
    // to write the file again, and port the change to
    // text-engine/src/paint/warp.rs, whose test reads it.
    expect(meshMapFixture()).toBe(readFileSync(FIXTURE, 'utf8'));
  });
});
