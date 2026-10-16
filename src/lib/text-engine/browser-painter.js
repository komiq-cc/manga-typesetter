import { patternTileCanvas, TILE_SS } from '../text-paint.js';

// Paint objects are made at fill time, after the strokes, in the current run's
// frame. A job can be inspected or handed to another painter without a canvas.
function setFill(ctx, fill) {
  if (fill.kind === 'linear' || fill.kind === 'radial') {
    const grad = fill.kind === 'radial'
      ? ctx.createRadialGradient(fill.cx, fill.cy, 0, fill.cx, fill.cy, fill.r)
      : ctx.createLinearGradient(fill.x0, fill.y0, fill.x1, fill.y1);
    for (const st of fill.stops) grad.addColorStop(st.pos, st.color);
    ctx.fillStyle = grad;
    return;
  }
  if (fill.kind === 'pattern') {
    const tile = patternTileCanvas(fill.style, TILE_SS);
    const pat = tile && ctx.createPattern(tile, 'repeat');
    if (pat) {
      if (pat.setTransform && typeof DOMMatrix !== 'undefined') {
        pat.setTransform(new DOMMatrix([fill.px / tile.width, 0, 0, fill.px / tile.height, fill.ax, fill.ay]));
      }
      ctx.fillStyle = pat;
      return;
    }
    ctx.fillStyle = fill.style.color;
    return;
  }
  ctx.fillStyle = fill.color;
}

export function createBrowserGlyphPainter() {
  return { paint };
}

// A job with no fill is its bands with the letters cut out of them. The cut is
// `destination-out`, which would take whatever is already under the box with
// it - its shadows, the page - so the job is painted on a canvas of its own
// and laid down whole. With no band there is nothing to cut from, and nothing
// is painted.
function paint(ctx, job) {
  if (!job.noFill) return draw(ctx, job);
  if (!job.bands.length) return;
  const cnv = document.createElement('canvas');
  cnv.width = ctx.canvas.width;
  cnv.height = ctx.canvas.height;
  const sctx = cnv.getContext('2d');
  sctx.setTransform(ctx.getTransform());
  draw(sctx, job);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // One to one, so unfiltered: see `blit` in rust-painter.js.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cnv, 0, 0);
  ctx.restore();
  cnv.width = 0;
  cnv.height = 0;
}

function draw(ctx, job) {
  ctx.font = job.face.key;
  // Alphabetic, at the offset `baselineInLine` measured, rather than 'top' at
  // half the leading: 'top' is the em square, and the browser does not centre
  // the em square in a line box, it centres the font's ascent-plus-descent.
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  // Outermost stroke first, each one twice its own outer edge wide, so the next
  // one in covers the half of it that fell inside the glyph - see text-paint.js.
  // With no fill the last pass is the same glyphs, taken out of what the
  // bands laid down instead of painted over it.
  const fillOrCut = (drawFns) => {
    if (!job.noFill) return drawFns.fill();
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    drawFns.fill();
    ctx.restore();
  };
  const strokeFill = (drawFns) => {
    for (const band of job.bands) {
      ctx.save();
      ctx.globalAlpha = band.opacity;
      ctx.strokeStyle = band.color;
      ctx.lineWidth = band.line;
      drawFns.stroke();
      ctx.restore();
    }
    fillOrCut(drawFns);
  };

  // The silhouette a shadow is cast from: the glyphs plus every stroke, as one
  // solid shape in one colour. Drawn as the outermost stroke and then the fill,
  // both opaque, so no two passes overlap and darken each other.
  const silhouette = (color, drawFns) => {
    const bands = job.bands;
    if (bands.length) {
      ctx.strokeStyle = color;
      ctx.lineWidth = bands[0].line;
      drawFns.stroke();
    }
    ctx.fillStyle = color;
    fillOrCut(drawFns);
  };

  const paint = job.silhouette ? (fns) => silhouette(job.silhouette, fns) : strokeFill;

  if (job.curved) {
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const place = (cb, setPer) => {
      for (const g of job.runs) {
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.rotate(g.rot);
        if (setPer) setFill(ctx, g.fill);
        cb(g.text, 0, 0);
        ctx.restore();
      }
    };
    paint({
      stroke: () => place((c, x, y) => ctx.strokeText(c, x, y)),
      fill: () =>
        place(
          (c, x, y) => ctx.fillText(c, x, y),
          // The silhouette pass wants one flat colour, not the real fill,
          // and a cut has no fill to choose.
          !job.silhouette && !job.noFill,
        ),
    });
  } else {
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${job.letterSpacing}px`;
    ctx.textAlign = job.align;
    const drawAll = (fn) => {
      job.runs.forEach((run) => fn(run.text, run.x, run.y));
    };
    // Gradient scope 'line' restarts the gradient on every wrapped line, so the
    // fill style is chosen per line rather than once for the block.
    const flat = !!job.silhouette || !!job.noFill;
    const perLine = !flat && job.fill === null;
    paint({
      stroke: () => drawAll((ln, x, y) => ctx.strokeText(ln, x, y)),
      fill: () => {
        if (!flat && !perLine) setFill(ctx, job.fill);
        job.runs.forEach((run) => {
          if (perLine) setFill(ctx, run.fill);
          ctx.fillText(run.text, run.x, run.y);
        });
      },
    });
  }
}

