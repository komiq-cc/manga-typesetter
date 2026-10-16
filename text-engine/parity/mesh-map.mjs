// Where `meshMap` in src/lib/warp.js sends a fixed set of points through a
// fixed set of meshes, as text the Rust port is held to
// (`the_map_is_the_one_in_warp_js`, text-engine/src/paint/warp.rs).
//
//   node text-engine/parity/mesh-map.mjs           # writes tests/data/mesh_map.txt
//   node text-engine/parity/mesh-map.mjs --check   # exits 1 when the file is stale
//
// src/lib/warp-fixture.test.js runs the check with the app's tests, so a
// change to warp.js that moves a point fails there until the file is written
// again and the Rust port follows.
//
//   mesh <kind> <cols> <rows> <w> <h> <x y of every control point, row-major>
//   pt <x> <y> <where it goes: x y>
//
// Every number is written as JS prints it: the shortest text that reads back
// to the same double.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { identityMesh, meshMap } from '../../src/lib/warp.js'

const self = fileURLToPath(import.meta.url)
export const FIXTURE = resolve(dirname(self), '../tests/data/mesh_map.txt')

// mulberry32: the same numbers in every engine.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// A grid with every point moved by up to `by` of a cell, seeded.
function shaken(cols, rows, w, h, by, seed) {
  const r = rng(seed)
  return identityMesh(cols, rows, w, h).map(([x, y]) => [x + (r() - 0.5) * 2 * by * (w / cols), y + (r() - 0.5) * 2 * by * (h / rows)])
}

const MESHES = [
  // One cell: a corner pulled (the homography), two parallelograms and a
  // translation (affine, exact), a crossed quad and a dented one (no
  // homography fits: the two triangles).
  { cols: 1, rows: 1, w: 300, h: 96, pts: [[0, 0], [300, 22], [-8, 96], [290, 84]] },
  { cols: 1, rows: 1, w: 120, h: 80, pts: [[10, -6], [100, 12], [-20, 70], [140, 110]] },
  { cols: 1, rows: 1, w: 200, h: 50, pts: [[20, 0], [220, 0], [0, 50], [200, 50]] },
  { cols: 1, rows: 1, w: 200, h: 50, pts: [[0, 10], [180, -20], [30, 70], [210, 40]] },
  { cols: 1, rows: 1, w: 64, h: 64, pts: [[5, 7], [69, 7], [5, 71], [69, 71]] },
  { cols: 1, rows: 1, w: 100, h: 100, pts: [[0, 0], [100, 0], [100, 100], [0, 100]] },
  { cols: 1, rows: 1, w: 100, h: 100, pts: [[0, 0], [100, 0], [0, 100], [30, 30]] },
  // Grids: the surface.
  { cols: 2, rows: 2, w: 180, h: 120, pts: shaken(2, 2, 180, 120, 0.3, 1) },
  { cols: 3, rows: 3, w: 240, h: 90, pts: shaken(3, 3, 240, 90, 0.35, 2) },
  { cols: 4, rows: 1, w: 320, h: 60, pts: identityMesh(4, 1, 320, 60).map(([x, y]) => [x, y + 36 * (0.5 - 4 * (x / 320) * (1 - x / 320))]) },
  { cols: 1, rows: 3, w: 40, h: 300, pts: shaken(1, 3, 40, 300, 0.25, 3) },
  { cols: 8, rows: 5, w: 400, h: 250, pts: shaken(8, 5, 400, 250, 0.4, 4) },
  { cols: 24, rows: 24, w: 600, h: 480, pts: shaken(24, 24, 600, 480, 0.45, 5) },
]

/** The file's text. */
export function meshMapFixture() {
  const out = []
  MESHES.forEach((m, k) => {
    const map = meshMap(m.pts, m.cols, m.rows, m.w, m.h)
    if (!map) throw new Error(`mesh ${k} moves nothing`)
    out.push(`mesh ${map.kind} ${m.cols} ${m.rows} ${m.w} ${m.h} ${m.pts.flat().join(' ')}`)
    const points = []
    // Every node, a lattice that reaches half a box past every edge (off the
    // nodes), and points at random.
    for (const [x, y] of identityMesh(m.cols, m.rows, m.w, m.h)) points.push([x, y])
    for (let j = 0; j <= 6; j++) for (let i = 0; i <= 6; i++) points.push([m.w * (-0.5 + i / 3) + 0.37, m.h * (-0.5 + j / 3) - 0.21])
    const r = rng(100 + k)
    for (let i = 0; i < 40; i++) points.push([m.w * (r() * 1.4 - 0.2), m.h * (r() * 1.4 - 0.2)])
    for (const [x, y] of points) {
      const [X, Y] = map.at(x, y)
      // A point on a homography's horizon has no image; the port refuses it
      // in its own test.
      if (Number.isFinite(X) && Number.isFinite(Y)) out.push(`pt ${x} ${y} ${X} ${Y}`)
    }
  })
  return out.join('\n') + '\n'
}

if (process.argv[1] === self) {
  const text = meshMapFixture()
  if (process.argv.includes('--check')) {
    const same = readFileSync(FIXTURE, 'utf8') === text
    console.log(same ? 'mesh_map.txt is what warp.js gives' : 'mesh_map.txt is STALE: run node text-engine/parity/mesh-map.mjs')
    process.exit(same ? 0 : 1)
  }
  writeFileSync(FIXTURE, text)
  console.log(`wrote ${FIXTURE}: ${text.split('\n').length - 1} lines`)
}
