// The Rust text engine behind the glyph-painter seam.
//
//   const rust = await createRustTextEngine(wasm)
//   setTextEngine(rust)
//   setGlyphPainter(createRustGlyphPainter(rust))
//
// The engine turns a job into pixels (text-engine/js/paint.mjs); this file's
// whole work is to hand it what only the page has - the canvas's transform and
// the pattern tiles - and to put the pixels it gives back onto the canvas.
import { paintJob } from '../../../text-engine/js/paint.mjs';
import { patternTileCanvas, patternTilePx, TILE_SS } from '../text-paint.js';

// A synthesised bold is drawn the way it is measured (text-engine/RULES.md):
// WebKit's wider advance belongs to WebKit's second glyph a step to the right,
// and an unchanged advance to a glyph grown on every side. Mixing them puts
// ink where the measurement did not leave room for it.
const BOLD_DRAW = { webkit: 'smear', unchanged: 'outset' };

// A scratch canvas this large is not kept: one page-sized box would otherwise
// hold its megabytes for the rest of the session.
const KEEP_PX = 2048 * 2048;

/**
 * @param {object} rust the engine `createRustTextEngine` made; it holds the faces a job names
 * @param {{ boldDraw?: 'outset' | 'smear' }} [options] overrides the rule above
 */
export function createRustGlyphPainter(rust, options = {}) {
  // One tile's pixels per pattern, so a job that fills every line with the
  // same pattern sends it once and the next job does not draw it again.
  const tiles = new Map();
  const tile = (fill) => {
    const key = `${patternTilePx(fill.style)}|${JSON.stringify(fill.style?.pattern ?? null)}`;
    if (tiles.has(key)) return tiles.get(key);
    const cnv = patternTileCanvas(fill.style, TILE_SS);
    const pixels = cnv ? cnv.getContext('2d').getImageData(0, 0, cnv.width, cnv.height) : null;
    if (tiles.size >= 64) tiles.clear();
    tiles.set(key, pixels);
    return pixels;
  };

  let scratch = null;

  function paint(ctx, job) {
    const face = rust.handle(job.face);
    const m = ctx.getTransform();
    const raster = paintJob(rust.low, {
      job,
      font: face.font,
      size: face.size,
      synth: face.flags,
      boldDraw: options.boldDraw ?? BOLD_DRAW[rust.rules().boldAdvance],
      transform: [m.a, m.b, m.c, m.d, m.e, m.f],
      tiles: tile,
      // Copied into the scratch canvas before anything else calls the engine.
      view: true,
    });
    if (!raster) return;
    const { x, y, width, height } = raster;
    const keep = width * height <= KEEP_PX;
    const cnv = (keep && scratch) || document.createElement('canvas');
    if (cnv.width < width) cnv.width = width;
    if (cnv.height < height) cnv.height = height;
    const sctx = cnv.getContext('2d');
    const image = sctx.createImageData(width, height);
    image.data.set(raster.data);
    // `putImageData` replaces what the scratch held, so it needs no clearing.
    sctx.putImageData(image, 0, 0);
    // The raster is already in device pixels: drawn through the identity it
    // lands pixel for pixel, and the canvas's own alpha, blending and clip
    // still apply to it as they would to drawn text.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Pixel for pixel means unfiltered. The exporter's canvases ask for
    // `imageSmoothingQuality = 'high'`, and Skia then resamples even a
    // one-to-one copy with a cubic that reaches one pixel to each side: every
    // edge is softened, and the column beside the copied rectangle, which in
    // a reused scratch holds an earlier job's pixels, leaks into the last
    // column drawn as a faint line.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cnv, 0, 0, width, height, x, y, width, height);
    ctx.restore();
    if (keep) scratch = cnv;
    else {
      cnv.width = 0;
      cnv.height = 0;
    }
  }

  return { id: 'rust', paint };
}
