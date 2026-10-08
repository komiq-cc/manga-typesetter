// The fixed jobs whose rasters are hashed, and the hashing of them. Nothing
// here is node's: it imports the loader and takes an engine, so the same file
// runs in a browser page.
//
//   import { createEngine } from '../js/engine.mjs'
//   import { hashFixedJobs } from './paint-hash-jobs.mjs'
//   const engine = await createEngine(wasmBytes)
//   const ids = [comicNeue, bangers, dejaVuSans, dejaVuSansOblique].map((bytes) => engine.addFont(bytes))
//   hashFixedJobs(engine, ids).hash        // 16 hex digits
//
// The fonts are the four fixtures of src/test/fonts, in that order.
//
// The jobs are built by hand from numbers that are exact in binary or are
// written out as decimals here: no job goes through a host `Math` function
// on its way to the engine, so the hash tests the engine and not the host.
// Every feature of a job is in at least one of them, and all of them are
// painted twice: under `boldAdvance = unchanged` and under `webkit`.
import { combineHashes, encodeJob, paintJob, rasterHash } from '../js/paint.mjs'

// A tile made with integer arithmetic only.
const TILE = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) }
for (let y = 0; y < 8; y++) {
  for (let x = 0; x < 8; x++) {
    const on = ((x >> 1) + (y >> 2)) & 1
    TILE.data.set(on ? [29, 53, 87, 255] : [255, 209, 102, (x * 37 + y * 11) & 255], (y * 8 + x) * 4)
  }
}
const STOPS = [
  { pos: 0, color: '#ffd166' },
  { pos: 0.35, color: 'rgba(239,71,111,0.6)' },
  { pos: 1, color: '#073b4c' },
]
const face = (size) => ({ size })
const straight = (over) => ({
  curved: false, align: 'center', letterSpacing: 0, bands: [], silhouette: null,
  fill: { kind: 'solid', color: '#111111' },
  runs: [
    { text: 'WHAT THE HELL', x: 160.3, y: 50.7 },
    { text: 'ARE YOU DOING?!', x: 160.3, y: 81.5 },
    { text: 'office waffle Ty.', x: 160.3, y: 112.3 },
  ],
  ...over,
})
// Angles as written-out radians; the engine takes the sine and cosine.
const curved = (over) => ({
  curved: true, align: 'center', letterSpacing: 0, bands: [{ color: '#ffffff', opacity: 1, line: 4 }], silhouette: null, fill: null,
  runs: [...'CURVE'].map((text, i) => ({
    text, x: 60.25 + i * 31.5, y: 90.125 - [0, 14.5, 19.75, 14.5, 0][i], rot: [-0.6, -0.3, 0, 0.3, 0.6][i],
    fill: { kind: 'linear', x0: -12.5, y0: 30, x1: 14.25, y1: -34, stops: STOPS },
  })),
  ...over,
})
const BANDS = [{ color: '#1d3557', opacity: 0.8, line: 10 }, { color: '#ffffff', opacity: 1, line: 4 }]
const FONT = { comic: 0, bangers: 1, dejavu: 2, oblique: 3 }
// Comic Neue has no Greek and no Cyrillic; DejaVu Sans has both.
const GREEK = [
  { text: 'WHAT \u03a9\u03bc\u03ad\u03b3\u03b1?!', x: 160.3, y: 50.7 },
  { text: '\u0416\u0434\u0438 here, e\u0301 too', x: 160.3, y: 81.5 },
]
// [name, job, font, size, synth, transform]
const JOBS = [
  ['solid', straight({}), FONT.comic, 28, 0, [2, 0, 0, 2, 0, 0]],
  ['solid, 11.5 px, 1x', straight({ align: 'left' }), FONT.dejavu, 11.5, 0, [1, 0, 0, 1, 0.37, 0.61]],
  ['two bands', straight({ bands: BANDS }), FONT.comic, 28, 0, [2, 0, 0, 2, 0, 0]],
  ['hairline', straight({ bands: [{ color: '#e63946', opacity: 0.5, line: 0.3 }], fill: null }), FONT.bangers, 30, 0, [1.5, 0, 0, 1.5, 3.25, 7.75]],
  ['linear', straight({ bands: BANDS, fill: { kind: 'linear', x0: 40, y0: 20.5, x1: 290.25, y1: 130, stops: STOPS } }), FONT.bangers, 30, 0, [2, 0, 0, 2, 0, 0]],
  ['radial', straight({ fill: { kind: 'radial', cx: 150.5, cy: 80.25, r: 121.75, stops: STOPS } }), FONT.dejavu, 22, 0, [2, 0, 0, 2, 0, 0]],
  ['per line', straight({ fill: null, runs: straight({}).runs.map((r, i) => ({ ...r, fill: { kind: 'linear', x0: 0, y0: r.y - 24.5, x1: 0, y1: r.y + 6.25, stops: i === 1 ? STOPS.slice(0, 2) : STOPS } })) }), FONT.comic, 28, 0, [2, 0, 0, 2, 0, 0]],
  ['pattern', straight({ fill: { kind: 'pattern', style: { color: '#e63946' }, px: 10.2, ax: 12.75, ay: 9.5 } }), FONT.bangers, 34, 0, [2, 0, 0, 2, 0, 0]],
  ['pattern, shrunk', straight({ fill: { kind: 'pattern', style: { color: '#e63946' }, px: 2.55, ax: 12.75, ay: 9.5 } }), FONT.bangers, 34, 0, [1, 0, 0, 1, 0, 0]],
  ['curved', curved({}), FONT.comic, 30, 0, [2, 0, 0, 2, 0, 0]],
  ['curved, pattern, bold', curved({ runs: curved({}).runs.map((r) => ({ ...r, fill: { kind: 'pattern', style: { color: '#e63946' }, px: 6.4, ax: -r.x, ay: -r.y } })) }), FONT.dejavu, 26, 1, [2, 0, 0, 2, 0, 0]],
  ['silhouette', straight({ bands: BANDS, silhouette: 'rgba(40,40,40,0.5)', fill: null }), FONT.comic, 28, 0, [2, 0, 0, 2, 6, 6]],
  ['silhouette, curved', curved({ silhouette: '#444444' }), FONT.comic, 30, 0, [2, 0, 0, 2, 0, 0]],
  ['letter spacing', straight({ letterSpacing: 3.5, align: 'right', bands: BANDS.slice(1) }), FONT.comic, 24, 0, [2, 0, 0, 2, 300, 0]],
  ['bold italic', straight({ bands: BANDS }), FONT.comic, 28, 3, [2, 0, 0, 2, 0, 0]],
  ['its own oblique', straight({}), FONT.oblique, 22, 0, [2, 0, 0, 2, 0, 0]],
  // cos and sin of 17 degrees, written out, at 2x.
  ['rotated', straight({ bands: BANDS, fill: { kind: 'linear', x0: 40, y0: 20.5, x1: 290.25, y1: 130, stops: STOPS } }), FONT.comic, 28, 0, [1.9126095119260709, 0.5847434094454735, -0.5847434094454735, 1.9126095119260709, 120.5, 10.25]],
  ['mirrored', straight({ bands: BANDS }), FONT.bangers, 28, 2, [-2, 0, 0, 2, 700, 0]],
  ['sheared, 3.3x', straight({ bands: BANDS.slice(1) }), FONT.dejavu, 20, 1, [3.3, 0.4, -0.7, 3.1, 150.37, 0.61]],
  ['nothing', straight({ runs: [{ text: '   ', x: 0, y: 0 }] }), FONT.comic, 28, 0, [2, 0, 0, 2, 0, 0]],
  ['tab and newline', straight({ runs: [{ text: 'A\tB\nC', x: 60, y: 50 }] }), FONT.dejavu, 28, 0, [2, 0, 0, 2, 0, 0]],
  // The last element: fallback to DejaVu Sans, and how a bold is drawn.
  ['fallback', straight({ bands: BANDS, runs: GREEK }), FONT.comic, 28, 0, [2, 0, 0, 2, 0, 0], { chain: true }],
  ['fallback, bold, spaced', straight({ letterSpacing: 2.5, runs: GREEK }), FONT.comic, 28, 1, [2, 0, 0, 2, 0, 0], { chain: true }],
  ['bold, smeared', straight({ bands: BANDS }), FONT.comic, 28, 1, [2, 0, 0, 2, 0, 0], { boldDraw: 'smear' }],
  ['bold italic, smeared, rotated', straight({}), FONT.bangers, 30, 3, [1.9126095119260709, 0.5847434094454735, -0.5847434094454735, 1.9126095119260709, 120.5, 10.25], { boldDraw: 'smear' }],
  ['curved, bold, smeared', curved({}), FONT.dejavu, 26, 1, [2, 0, 0, 2, 0, 0], { boldDraw: 'smear' }],
]


export const RULES = ['unchanged', 'webkit']

/** The requests for the fixed jobs. `chain` is a fallback chain to DejaVu Sans. */
export function fixedRequests(fontIds, chain) {
  return JOBS.map(([name, job, font, size, synth, transform, extra = {}]) => ({
    name,
    request: {
      job: { ...job, face: face(size) },
      font: fontIds[font],
      synth,
      chain: extra.chain ? chain : 0,
      boldDraw: extra.boldDraw ?? 'outset',
      transform,
      tiles: () => TILE,
    },
  }))
}

/**
 * Paints the fixed jobs under each `boldAdvance` rule and hashes the rasters.
 * Leaves the engine's rule at `unchanged` and frees the chain it made.
 *
 * @param {object} engine from `createEngine`
 * @param {number[]} fontIds ids of Comic Neue, Bangers, DejaVu Sans, DejaVu Sans Oblique
 * @param {{bytes?: boolean}} [options] `bytes`: also return each request's wire form
 * @returns {{hash: string, each: {name: string, rule: string, hash: string, size: string, bytes?: Uint8Array}[]}}
 */
export function hashFixedJobs(engine, fontIds, { bytes = false } = {}) {
  const chain = engine.chainNew()
  engine.chainPush(chain, fontIds[FONT.dejavu])
  const jobs = fixedRequests(fontIds, chain)
  const each = []
  try {
    for (const rule of RULES) {
      engine.setRule('boldAdvance', rule)
      for (const { name, request } of jobs) {
        const r = paintJob(engine, { ...request, view: true })
        each.push({
          name,
          rule,
          hash: rasterHash(r),
          size: r ? `${r.width} x ${r.height}` : 'nothing',
          ...(bytes ? { bytes: encodeJob(request).slice() } : {}),
        })
      }
    }
  } finally {
    engine.setRule('boldAdvance', 'unchanged')
    engine.chainFree(chain)
  }
  return { hash: combineHashes(each.map((e) => e.hash)), each }
}
