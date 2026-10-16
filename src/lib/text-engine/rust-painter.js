// The Rust text engine behind the glyph-painter seam.
//
//   const rust = await createRustTextEngine(wasm)
//   setTextEngine(rust)
//   setGlyphPainter(createRustGlyphPainter(rust))
//
// The engine turns a job into pixels (text-engine/js/paint.mjs); this file's
// whole work is to hand it what only the page has - the canvas's transform and
// the pattern tiles - and to put the pixels it gives back onto the canvas.
import { drawsPatternTiles, paintBox as paintBoxJob, paintJob, paintsBoxes, patternTile } from '../../../text-engine/js/paint.mjs';
import { patternTileCanvas, patternTilePx, TILE_SS } from '../text-paint.js';

// A synthesised bold is drawn the way it is measured (text-engine/RULES.md):
// WebKit's wider advance belongs to WebKit's second glyph a step to the right,
// and an unchanged advance to a glyph grown on every side. The engine's
// `boldAdvance` rule decides both, in the engine: its ink box is measured for
// the drawing its painter makes, so nothing is chosen here.

// The longest side of a raster the engine will paint: `MAX_SIDE` in
// text-engine/src/paint/mod.rs. A job whose ink is wider or taller than this
// in device pixels is refused (`paintJob` throws), and the engine does not say
// the number over the wire, so it is stated here, once, for the page - the
// painter carries it as `maxSide` and whoever sizes a canvas for it asks the
// painter. rust-painter-limit.test.js reads the Rust source and holds the two
// together.
export const MAX_RASTER_SIDE = 16384;

/**
 * @param {object} rust the engine `createRustTextEngine` made; it holds the faces a job names
 * @param {{ boldDraw?: 'outset' | 'smear', weight?: number }} [options]
 *   `boldDraw` names a drawing outright, against the rule above, for looking at the other one.
 *   `weight` grows every filled glyph shape by that many device pixels on every side before it
 *   is painted (bands stay strokes of the font's own outline); 0, the default, paints the
 *   font's outline.
 */
export function createRustGlyphPainter(rust, options = {}) {
  // A tile is the engine's own drawing, at the size `patternTileCanvas` gives
  // one: `TILE_SS` pixels to a page px, and a hairline a page px wide or more.
  // A wasm built before the engine drew them has the canvas draw it.
  const ownTiles = drawsPatternTiles(rust.low);
  const tilePixels = (style) => {
    if (ownTiles) {
      const tile = patternTilePx(style);
      return patternTile(rust.low, style?.pattern, Math.max(2, Math.round(tile * TILE_SS)), Math.max(1, tile * 0.12) / tile);
    }
    const cnv = patternTileCanvas(style, TILE_SS);
    return cnv ? cnv.getContext('2d').getImageData(0, 0, cnv.width, cnv.height) : null;
  };

  // One tile's pixels per pattern, so a job that fills every line with the
  // same pattern sends it once and the next job does not draw it again.
  const tiles = new Map();
  const tile = (fill) => {
    const key = `${patternTilePx(fill.style)}|${JSON.stringify(fill.style?.pattern ?? null)}`;
    if (tiles.has(key)) return tiles.get(key);
    const pixels = tilePixels(fill.style);
    if (tiles.size >= 64) tiles.clear();
    tiles.set(key, pixels);
    return pixels;
  };

  // A job as the engine is asked for it: the face it names, resolved, and
  // what only this painter knows.
  function request(job, transform) {
    const face = rust.handle(job.face);
    return {
      job,
      font: face.font,
      size: face.size,
      synth: face.flags,
      boldDraw: options.boldDraw ?? 'rule',
      weight: options.weight ?? 0,
      transform,
      tiles: tile,
      // Copied out (`blit`) before anything else calls the engine.
      view: true,
    };
  }

  function paint(ctx, job) {
    const m = ctx.getTransform();
    const raster = paintJob(rust.low, request(job, [m.a, m.b, m.c, m.d, m.e, m.f]));
    if (raster) blit(ctx, raster, raster.x, raster.y);
  }

  // A finished box in one job: its glyphs, and the shadows, the blur, the
  // smear and the mask the canvas used to lay over and under them
  // (`boxInJob`, exporter.js). `spec.rect` is the box's footprint in the
  // job's own coordinates; every pixel the box can ink is inside it, and it
  // is the surface the engine paints, wherever the canvas's transform puts
  // it - scaled, turned or mirrored. Nothing is resampled on the way: the
  // letters, the shadow's throw and the mask are all stated in the job's
  // units and carried by the transform, and the pixels land one to one.
  function paintBox(ctx, spec) {
    const m = ctx.getTransform();
    const r = spec.rect;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
      const dx = m.a * px + m.c * py + m.e;
      const dy = m.b * px + m.d * py + m.f;
      x0 = Math.min(x0, dx);
      y0 = Math.min(y0, dy);
      x1 = Math.max(x1, dx);
      y1 = Math.max(y1, dy);
    }
    // Whole pixels, outwards, less the dust a product of two scales leaves.
    const EPS = 1e-6;
    x0 = Math.floor(x0 + EPS);
    y0 = Math.floor(y0 + EPS);
    const width = Math.ceil(x1 - EPS) - x0;
    const height = Math.ceil(y1 - EPS) - y0;
    if (!(width > 0 && height > 0)) return;
    const raster = paintBoxJob(rust.low, {
      ...request(spec.job, [m.a, m.b, m.c, m.d, m.e - x0, m.f - y0]),
      width,
      height,
      shadows: spec.shadows,
      blur: spec.blur,
      taps: spec.taps,
      clip: spec.clip,
    });
    if (raster) blit(ctx, raster, x0 + raster.x, y0 + raster.y);
  }

  // The engine's pixels onto the canvas at device pixel (x, y).
  //
  // Through a canvas of the raster's own, made here and given back once it
  // has been drawn: never one kept from paint to paint. The system WebKit
  // (the app's window on macOS) carries a canvas's drawing over to its GPU
  // process later than it carries a `putImageData`, so a `drawImage` from a
  // kept canvas can be played after the next raster has been put into it:
  // the box drawn first then shows the next one's letters inside its own
  // outline. That is what an export did to every box painted straight onto
  // the page (a turned one), and a canvas the box next on the page was laid
  // through afterwards. A canvas given a new size is a new backing store, and
  // a draw already made from the old one keeps the old one's pixels: giving
  // this canvas back after the draw is safe, writing into it again is not.
  function blit(ctx, raster, x, y) {
    const { width, height } = raster;
    const cnv = document.createElement('canvas');
    cnv.width = width;
    cnv.height = height;
    const cctx = cnv.getContext('2d');
    const image = cctx.createImageData(width, height);
    image.data.set(raster.data);
    cctx.putImageData(image, 0, 0);
    // The raster is already in device pixels: drawn through the identity it
    // lands pixel for pixel, and the canvas's own alpha, blending and clip
    // still apply to it as they would to drawn text.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Pixel for pixel means unfiltered. The exporter's canvases ask for
    // `imageSmoothingQuality = 'high'`, and Skia then resamples even a
    // one-to-one copy with a cubic that reaches one pixel to each side, and
    // every edge is softened.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cnv, 0, 0, width, height, x, y, width, height);
    ctx.restore();
    cnv.width = 0;
    cnv.height = 0;
  }

  // `engine` says whose ink this painter paints (`engineDraws`, index.js).
  // `mesh` says a job's mesh is bent by this painter, in the outlines
  // (`meshInJob`, exporter.js): the canvas painter has no such thing.
  // `roughen` says the same of a job's roughening (`roughenInJob`).
  // `box` says this painter paints a whole box in one job (`boxInJob`), which
  // it does when the wasm it was handed has that call.
  const box = paintsBoxes(rust.low);
  return { id: 'rust', paint, paintBox: box ? paintBox : undefined, maxSide: MAX_RASTER_SIDE, engine: rust, mesh: true, roughen: true, box };
}
