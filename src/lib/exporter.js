// Native-resolution raster export via canvas 2D. PNG is lossless.
import { app, page, toast, boxText, saveExportPrefs, isLongstrip, PAGE_W, PAGE_H } from './store.svelte.js';
import { familyFor, fontShorthand, maxLineWidth, BOX_PAD } from './measure.js';
import { boxCandidate, placeBlock } from './contain.js';
import {
  strokeBands,
  strokeExtent,
  gradientEndpoints,
  radialEndpoints,
  patternTilePx,
  patternTileCanvas,
  fillKind,
  roughenPixels,
  stopColor,
  ensureNoisePhase,
  motionBlurTaps,
  motionBlurExtent,
  drawClipShapes,
  clipActive,
  inkActive,
  inkReach,
  shadowExtent,
  drawInk,
  TILE_SS,
} from './text-paint.js';
import { warpActive } from './warp.js';
import { warpBoxCanvas } from './warp-paint.js';
import { settleBoxTips } from './brush-tips.js';
import { withPageImages } from './page-images.js';
import { stripOffsets, maxPageWidth, boxPaintedStripSpan } from './editor/strip.js';
import { planStripCuts, SLICE_H_DEFAULT } from './editor/strip-cuts.js';
// The detected-text JSON serialiser lives in a leaf module so the library can
// write that document on every autosave without importing this file - see the
// note at the top of text-json.js. Re-exported here because this is where every
// existing caller (and the export dialog's JSON format) asks for it.
import { buildTextJson } from './text-json.js';
import { fsx } from './fsx.js';
export { buildTextJson };

// Reduce a free-text export name to something every platform will accept as a
// filename, keeping unicode and spaces.
//
// Windows is the strict one and the reason this is more than a separator strip:
// it rejects `: * ? " < > |` and the C0 control characters outright, treats a
// trailing dot or space as a name it will silently rewrite, and still reserves
// the DOS device names. A name that only fails on Windows is the worst kind,
// because it exports cleanly on the machine this is developed on - see the same
// guard on library folder names in `slugify` (paths.js).
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeExportName(name) {
  const s = String(name ?? '')
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\.\.+/g, '')
    .replace(/^\.+$/, '')
    .trim()
    // A trailing dot or space survives the trim above only as `a. ` -> `a.`;
    // Windows drops it when creating the file, so a later read by that name
    // misses. Strip it here instead of letting the two names diverge.
    .replace(/[. ]+$/, '');
  if (!s) return 'page';
  // A device name is reserved whatever follows the dot, so `nul.png` is refused
  // as flatly as `nul` - and the export appends an extension of its own on top.
  return WINDOWS_RESERVED.test(s.split('.')[0]) ? `${s}-x` : s;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// The page's coordinate space, for an exporter that has to put a number on a
// canvas or in a file header.
//
// `p.w`/`p.h` are it whenever the page has been measured. A page is `w:0,h:0`
// until something decodes its image, and while `createChapter` now measures at
// import, every chapter created before it did is still on disk unmeasured - 23
// of the 28 pages in the author's own chapter. Export All reaches every page,
// including those, and a 0 is not a small error: it is a zero-sized canvas that
// `toBlob` returns an empty (or null) image for, saved under the page's name
// with a success toast over it. The PSD path failed louder - ag-psd throws
// `Invalid document size` - and nothing at all here.
//
// Asking the art is what the canvas would have done one page turn later, so it
// is the same answer either way, and it is the answer the box coordinates on
// that page were authored against.
//
// PAGE_W/PAGE_H remain only for the page that has neither a size nor an image
// to measure. That page exports as a blank sheet at whatever number is chosen,
// and 0 is the one number that makes the file unopenable.
//
// Exported because `psd.js` asks the same question of the same page and has to
// get the same answer: it imports this one rather than keeping a copy, or a
// page could render at one size and write its layers at another.
export async function pageSpace(p) {
  if (p?.w > 0 && p?.h > 0) return { w: p.w, h: p.h };
  const probe = p?.cleaned ?? p?.raw;
  if (probe) {
    try {
      const img = await loadImage(probe);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        return { w: img.naturalWidth, h: img.naturalHeight };
      }
    } catch {
      /* fall through to the defaults */
    }
  }
  return { w: PAGE_W, h: PAGE_H };
}

// Where the editor's roughening filter has its origin, in the box's own
// coordinates - i.e. the top-left of the element the `filter` is hung on, since
// that corner is where feTurbulence's user space starts.
//
// For straight text that element is the text stack: full content width, so its
// left edge is the box's padding, and its top is wherever the block sits after
// the vertical alignment. For curved text it is `.arcstack`, which is `inset:0`
// against the box itself. Getting this right is what keeps the same crumple on
// the same letter in the export as on the canvas - the noise is a field in
// space, and anchoring it anywhere else slides the whole pattern across the
// glyphs.
function noiseOrigin(L) {
  if (L.isCurve) return { x: L.ox, y: L.oy };
  return { x: L.ox + BOX_PAD, y: L.oy + L.blockY };
}

// The roughening, over the finished raster: exactly the filter the editor hangs
// on the same text (feTurbulence -> feDisplacementMap), evaluated here instead
// of by the browser. The noise itself lives in text-paint.js, next to every
// other number the two renderers have to agree on; see the long note there for
// what this used to be and why the export came out shredded.
//
// `SS` is the raster's supersampling, so the displacement is stated in page px
// and applied in device px, and the pattern does not change with it.
// The phase between the browser's turbulence and our port of it is measured
// against the browser actually running rather than assumed (see text-paint.js),
// and the measurement is a rasterisation, so it is async. Every entry point that
// can end up displacing pixels waits on it here - once per session, and only for
// a page that has something roughened on it, so a chapter with no roughening
// never rasterises the probe at all.
export async function settleNoise(boxes) {
  if ((boxes ?? []).some((b) => b?.style?.roughen?.on)) await ensureNoisePhase();
}

function roughen(ctx, L, SS) {
  const w = Math.round(L.cw * SS);
  const h = Math.round(L.ch * SS);
  const src = ctx.getImageData(0, 0, w, h);
  const dst = ctx.createImageData(w, h);
  const o = noiseOrigin(L);
  roughenPixels(src, dst, L.s.roughen, { ss: SS, originX: o.x, originY: o.y });
  ctx.putImageData(dst, 0, 0);
}

// Lay out a box's text and compute its canvas geometry WITHOUT drawing. The
// footprint (cw×ch) grows to contain the full block incl. overflow beyond the
// box rect on all sides - mirroring the editor's `overflow:visible` centered
// layout so nothing clips on export. (ox,oy) is where the box's top-left sits
// inside that footprint. Split out from painting so rotated text can be drawn
// directly onto the page canvas (sharp glyphs) instead of rotating a raster.
function layoutBox(box, p) {
  const s = box.style;
  // Where the block sits - its lines, its top, the x each line is drawn at, or
  // the glyphs of a curve - comes from `placeBlock` (contain.js), which is the
  // statement the containment check reads too. This function used to BE that
  // statement; it was lifted out whole so that "the text fits its box" is
  // decided about exactly the block this file paints, rather than about a second
  // implementation that agrees with it today.
  const place = placeBlock(boxCandidate(box, boxText(box, p)));
  const lineH = s.size * (s.lineHeight > 0 ? s.lineHeight : 1);
  // How far past the glyphs the ink can reach, on every edge. Each term is one
  // thing that draws outside the letters: the outermost stroke (drawn at twice
  // its own outer edge, half of it inside the glyph), the furthest a shadow is
  // thrown - offset plus its own spread, on top of the strokes it is cast from -
  // and the displacement roughening applies. The whole-text blur is added to
  // whichever of those wins because it blurs their composite, and a gaussian is
  // effectively over about three sigma out.
  // `strokeExtent` is already the outermost band's OUTER edge - the line is
  // drawn at twice it precisely so that half of it falls inside the glyph - so
  // the ink reaches `strokeOut`, not twice it. A shadow's own reach is the
  // distance it is thrown (which is a diagonal, not the sum of its legs) plus
  // the tail of its gaussian: `paintShadows` blurs at sigma = blur/2, and a
  // gaussian is done at about three sigma, so 2x the named blur clears it with
  // room to spare where the old `+ blur` cut into it.
  const strokeOut = strokeExtent(s.strokes);
  const shadowOut = shadowExtent(s.shadows);
  const pad = Math.ceil(
    Math.max(
      strokeOut,
      shadowOut > 0 ? strokeOut + shadowOut : 0,
      s.roughen.on ? s.roughen.amount + 2 : 0,
      // Ink is drawn in box-local px and may be drawn right over the box edge,
      // so its overhang has to be padded for like any other thing that paints
      // outside the letters - and the strokes and shadows wrap the ink too,
      // so its reach is the overhang plus theirs.
      inkReach(s),
    ) +
      (s.blur > 0 ? s.blur * 3 : 0) +
      motionBlurExtent(s.motionBlur) +
      4,
  );

  // Every glyph-by-glyph layout - the bezier path, the closed circle and the
  // arc - goes down the same "curve" path here: everything below it only
  // reads `layout`, and the precedence (path > circle > arc) is exactly what
  // the editor states (and `placeBlock` applies).
  const isCurve = place.isCurve;

  let lines = null;
  let layout = null;
  let anchorX = 0;
  let leftExtra = 0,
    rightExtra = 0,
    topExtra = 0,
    bottomExtra = 0;
  // The text block's top-left inside the box, for the straight-line path. Unused
  // by the curved one, which places every glyph from the box centre.
  let blockX = 0,
    blockY = 0;

  if (isCurve) {
    layout = place.layout;
    let minX = 0,
      maxX = 0,
      minY = 0,
      maxY = 0;
    const half = s.size * 0.75; // generous half-glyph margin around each anchor
    for (const g of layout) {
      minX = Math.min(minX, g.x - half);
      maxX = Math.max(maxX, g.x + half);
      minY = Math.min(minY, g.y - half);
      maxY = Math.max(maxY, g.y + half);
    }
    leftExtra = Math.max(0, -minX - box.w / 2);
    rightExtra = Math.max(0, maxX - box.w / 2);
    topExtra = Math.max(0, -minY - box.h / 2);
    bottomExtra = Math.max(0, maxY - box.h / 2);
  } else {
    // The lines are `placeBlock`'s, which breaks them through `layoutLines` at
    // the content width (the box less 2px of padding each side, clamped to a
    // pixel) with the box's balloon as one width per line - the same helper and
    // the same arguments as the editor and the PSD's type layers, so "the export
    // breaks where the canvas breaks" is a construction rather than a
    // coincidence. Shaping off, that function is still `wrapLinesDOM`.
    lines = place.lines;
    anchorX = place.anchorX;
    const blockH = place.blockH;
    const blockW = maxLineWidth(lines, s, s.size);

    // Where the block sits inside the box, as an offset from the box's top-left,
    // and the one statement of it: `paintBox` draws from these and the overflow
    // below is measured from them, so the footprint cannot disagree with the
    // painting.
    //
    // The padding is what was missing. The editor's `.tbox` is `padding:2px` on
    // every edge, and wrapping has always been done at `box.w - BOX_PAD * 2` to
    // match - but the block was then anchored at the box's own edge, so a
    // left-aligned box exported 2px further left and a top-aligned one 2px
    // higher than the canvas showed. The auto-height maths made that worse
    // rather than merely visible: `neededHeight` sizes a box as the block plus
    // BOX_PAD on both sides, so every auto-fitted box exported with 4px of slack
    // under its text. Centred alignments were always right and still are - the
    // padding is symmetric, so it cancels.
    // `placeBlock` centres a middle-aligned block on its ink rather than on its
    // line boxes - see `inkShiftY`. The editor applies the same shift to the
    // same lines, so a centred block exports where the canvas shows it.
    blockY = place.blockY;
    blockX =
      s.align === 'center'
        ? (box.w - blockW) / 2
        : s.align === 'right'
          ? box.w - BOX_PAD - blockW
          : BOX_PAD;

    topExtra = Math.max(0, -blockY);
    bottomExtra = Math.max(0, blockY + blockH - box.h);
    leftExtra = Math.max(0, -blockX);
    rightExtra = Math.max(0, blockX + blockW - box.w);
  }

  leftExtra = Math.ceil(leftExtra);
  rightExtra = Math.ceil(rightExtra);
  topExtra = Math.ceil(topExtra);
  bottomExtra = Math.ceil(bottomExtra);
  const ox = leftExtra + pad; // box's top-left X inside the footprint
  const oy = topExtra + pad; // box's top-left Y inside the footprint
  const cw = Math.ceil(box.w + leftExtra + rightExtra + pad * 2);
  const ch = Math.ceil(box.h + topExtra + bottomExtra + pad * 2);
  // Where each line's baseline sits inside its line box - the browser's own
  // placement, so the raster draws the glyphs where the editor does.
  const baseY = isCurve ? 0 : place.baseY;
  return { s, lineH, baseY, pad, isCurve, lines, layout, leftExtra, topExtra, ox, oy, blockX, blockY, anchorX, cw, ch };
}

// The rectangle a gradient or a pattern is measured against, in the same
// coordinates `paintBox` draws in. It is the editor's own text element - the
// box's content width, and as tall as the block - and not the block's ink,
// because in the editor the background is painted on that element and clipped to
// the glyphs. Anything else and a centred block would export with its gradient
// shifted relative to the canvas. `line` >= 0 asks for one wrapped line's own
// rect instead, which is what gradient scope 'line' spans.
function fillRect(box, L, line = -1) {
  const n = L.lines ? L.lines.length : 1;
  const top = L.oy + L.blockY + (line >= 0 ? line * L.lineH : 0);
  return {
    x: L.ox + BOX_PAD,
    y: top,
    w: Math.max(1, box.w - BOX_PAD * 2),
    h: (line >= 0 ? 1 : n) * L.lineH,
  };
}

// The fill for one run of glyphs: solid colour, a gradient over `rect`, or a
// tiled pattern anchored at its top-left corner. `local` is the transform the
// run is drawn under (the curved path rotates and translates per glyph); the
// rect is stated in the box's own coordinates, so the endpoints are mapped back
// into the run's space rather than the rect being re-measured per glyph - which
// is what keeps one gradient running across curved text instead of restarting on
// every letter.
function setFill(ctx, s, rect, local) {
  const kind = fillKind(s);
  if (kind === 'gradient') {
    let grad;
    if (s.gradient.kind === 'radial') {
      // `local` is a rigid transform (the curved path rotates and translates a
      // glyph, it does not scale), so the centre moves with it and the radius
      // is carried over unchanged.
      const c = radialEndpoints(s.gradient, rect.x, rect.y, rect.w, rect.h);
      const [cx, cy] = local ? local(c.cx, c.cy) : [c.cx, c.cy];
      grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, c.r);
    } else {
      const g = gradientEndpoints(s.gradient.angle, rect.x, rect.y, rect.w, rect.h);
      const p = local ? [local(g.x0, g.y0), local(g.x1, g.y1)] : [[g.x0, g.y0], [g.x1, g.y1]];
      grad = ctx.createLinearGradient(p[0][0], p[0][1], p[1][0], p[1][1]);
    }
    // `stopColor` is the same answer the editor's CSS gets for the same stop,
    // per-stop alpha included, so the two ramps are the one ramp.
    for (const st of s.gradient.stops) grad.addColorStop(Math.min(1, Math.max(0, st.pos)), stopColor(st));
    ctx.fillStyle = grad;
    return;
  }
  if (kind === 'pattern') {
    const tile = patternTileCanvas(s, TILE_SS);
    const pat = tile && ctx.createPattern(tile, 'repeat');
    if (pat) {
      // The tile is drawn at TILE_SS so it survives the supersampled canvas, and
      // its origin is the fill rect's corner - the same corner CSS anchors
      // `background-repeat` to in the editor.
      //
      // Curved text is drawn one glyph at a time under its own transform, and
      // this used to anchor the tile at each glyph's own origin - so the grid
      // restarted on every letter and the tone jumped phase across a word. The
      // editor does no such thing: it hands each glyph's span the SAME
      // background origin, the box's corner, expressed in that span's own
      // coordinates. So the corner is mapped through `local` exactly as a
      // gradient's endpoints are, and the grid runs on across the letters.
      const px = patternTilePx(s);
      if (pat.setTransform && typeof DOMMatrix !== 'undefined') {
        const [ax, ay] = local ? local(rect.x, rect.y) : [rect.x, rect.y];
        pat.setTransform(new DOMMatrix([px / tile.width, 0, 0, px / tile.height, ax, ay]));
      }
      ctx.fillStyle = pat;
      return;
    }
  }
  ctx.fillStyle = s.color;
}

// Paint a laid-out box's strokes and fill (L from layoutBox) onto `ctx`, with
// the box's top-left at (L.ox, L.oy) in the current transform. Works on either
// an offscreen canvas or directly on a rotated page context.
//
// Shadows and the whole-text blur are NOT drawn here: both are operations on the
// finished composite rather than on a glyph run, so they are done in `renderBox`
// against an axis-aligned raster, and `paintBoxOnPage` sends any box that has
// one down that path.
function paintBox(ctx, box, L) {
  const s = L.s;
  ctx.font = fontShorthand(s, s.size, familyFor(s));
  // Alphabetic, at the offset `baselineInLine` measured, rather than 'top' at
  // half the leading: 'top' is the em square, and the browser does not centre
  // the em square in a line box, it centres the font's ascent-plus-descent.
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  // Outermost stroke first, each one twice its own outer edge wide, so the next
  // one in covers the half of it that fell inside the glyph - see text-paint.js.
  const strokeFill = (drawFns) => {
    for (const band of strokeBands(s.strokes)) {
      ctx.save();
      ctx.globalAlpha = band.opacity;
      ctx.strokeStyle = band.color;
      ctx.lineWidth = band.line;
      drawFns.stroke();
      ctx.restore();
    }
    drawFns.fill();
  };

  // The silhouette a shadow is cast from: the glyphs plus every stroke, as one
  // solid shape in one colour. Drawn as the outermost stroke and then the fill,
  // both opaque, so no two passes overlap and darken each other.
  const silhouette = (color, drawFns) => {
    const bands = strokeBands(s.strokes);
    if (bands.length) {
      ctx.strokeStyle = color;
      ctx.lineWidth = bands[0].line;
      drawFns.stroke();
    }
    ctx.fillStyle = color;
    drawFns.fill();
  };

  const paint = L.silhouette ? (fns) => silhouette(L.silhouette, fns) : strokeFill;

  if (L.isCurve) {
    const cx = L.ox + box.w / 2;
    const cy = L.oy + box.h / 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    // A curved box has no wrapped lines, so its gradient spans the box - which
    // is what 'box' scope means and the only scope the curved path has.
    const rect = { x: L.ox, y: L.oy, w: box.w, h: box.h };
    const place = (cb, setPer) => {
      for (const g of L.layout) {
        ctx.save();
        ctx.translate(cx + g.x, cy + g.y);
        ctx.rotate(g.rot);
        // Move the fill's frame onto this glyph - and only move it. The editor
        // paints the fill as the glyph span's own background, and a background
        // is laid out in the element's own box and then carried through its
        // transform: it slides to the glyph AND turns with it. So the mapping is
        // the translation alone. Inverse-rotating the endpoints as well (which
        // is what stood here) cancelled the glyph's rotation and held the ramp
        // fixed in box space - a different picture from the one the canvas
        // shows, and most visible on the letters furthest around the arc.
        if (setPer) {
          const gx = cx + g.x;
          const gy = cy + g.y;
          setPer((x, y) => [x - gx, y - gy]);
        }
        cb(g.ch, 0, 0);
        ctx.restore();
      }
    };
    paint({
      stroke: () => place((c, x, y) => ctx.strokeText(c, x, y)),
      fill: () =>
        place(
          (c, x, y) => ctx.fillText(c, x, y),
          // The silhouette pass wants one flat colour, not the real fill.
          L.silhouette ? null : (local) => setFill(ctx, s, rect, local),
        ),
    });
  } else {
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${s.letterSpacing}px`;
    // Both from `layoutBox`, which is where the padding is applied and the only
    // place it should be. `textAlign` decides which edge of the line `anchorX`
    // names, so the padded content box's own edge is the anchor - its left for
    // left-aligned text, its right for right-aligned, and the box's centre for
    // centred text, which the symmetric padding leaves where it was. The anchor
    // is `placeBlock`'s, the one the containment check measured the ink from.
    const startY = L.oy + L.blockY;
    ctx.textAlign = s.align;
    const anchorX = L.ox + L.anchorX;
    const drawAll = (fn) => {
      L.lines.forEach((ln, i) => fn(ln, anchorX, startY + i * L.lineH + L.baseY));
    };
    // Gradient scope 'line' restarts the gradient on every wrapped line, so the
    // fill style is chosen per line rather than once for the block.
    const perLine = !L.silhouette && s.gradient?.on && s.gradient.scope === 'line';
    paint({
      stroke: () => drawAll((ln, x, y) => ctx.strokeText(ln, x, y)),
      fill: () => {
        if (!L.silhouette && !perLine) setFill(ctx, s, fillRect(box, L));
        L.lines.forEach((ln, i) => {
          if (perLine) setFill(ctx, s, fillRect(box, L, i));
          ctx.fillText(ln, anchorX, startY + i * L.lineH + L.baseY);
        });
      },
    });
  }
}

// The shadows a box casts, painted under it. Each one is the box's own
// silhouette in that shadow's colour, blurred and offset and composited in
// device pixels with the transform reset - a canvas shadow's offset and a canvas
// filter's radius are both specified in device space rather than in the current
// transform's, so doing this arithmetic anywhere else means a shadow that moves
// when the box is supersampled.
//
// One scratch canvas for all of them, cleared between: a box's footprint can be
// several megapixels, and a fresh one per shadow per box meant a whole-chapter
// export allocating and dropping hundreds of them.
//
// Last shadow first, so shadows[0] ends up on top of the rest.
function paintShadows(ctx, box, L, SS) {
  const s = L.s;
  if (!(s.shadows ?? []).length) return;
  const sil = document.createElement('canvas');
  sil.width = L.cw * SS;
  sil.height = L.ch * SS;
  const sctx = sil.getContext('2d');
  for (let i = s.shadows.length - 1; i >= 0; i--) {
    const sh = s.shadows[i];
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, sil.width, sil.height);
    sctx.scale(SS, SS);
    sctx.imageSmoothingQuality = 'high';
    paintBox(sctx, box, { ...L, silhouette: sh.color });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = sh.opacity;
    // A canvas shadow's `blur` is twice its gaussian sigma, and a filter's is
    // the sigma itself - so half, or every shadow doubles in softness.
    if (sh.blur > 0) ctx.filter = `blur(${(sh.blur / 2) * SS}px)`;
    ctx.drawImage(sil, sh.x * SS, sh.y * SS);
    ctx.restore();
  }
}

// Render a box to its own supersampled offscreen canvas. Used for un-rotated
// boxes and for rotated+roughened boxes (whose pixel-space displacement needs
// an axis-aligned raster). Text is supersampled 2x so the downscale-on-composite
// yields crisp edges.
//
// Roughened text is supersampled too, which it did not used to be: the old
// displacement was per-pixel scatter and 2x only bought it finer confetti, but a
// real noise field is a smooth function of position, so it can be evaluated at
// device pixels and gives the same crisp downscaled edge every other box gets -
// and the same edge the editor shows, which applies its filter at device
// resolution as well.
// Returns `{ canvas, ox, oy, cw, ch }`: the bitmap, where the box's top-left
// sits inside it, and how many page px it spans. Exported because the editor
// draws a warped box from exactly this - see `paintWarpedBox` - rather than
// from a second painter that would have to be kept in step with it.
export function renderBox(box, p, tips) {
  return warpTexture(renderBoxTexture(box, p, tips), box);
}

// Everything `renderBox` does EXCEPT the mesh - the finished, unwarped picture
// of the box, plus where it sits and what it was supersampled at.
//
// Split out for the gizmo's drag, and only for it. A handle drag changes the
// mesh forty times a second and changes nothing else: the type, the ink, the
// blur, the smear and the mask are all the same picture they were when the
// pointer went down, and re-rendering them per frame is the whole cost of the
// gesture (see WarpGizmo.svelte, which renders this once on pointerdown and
// runs only `warpTexture` after). The pass order and the pixels are exactly
// what they were when this was one function - `renderBox` is the same two
// steps in the same order, and every other caller sees no change at all.
export function renderBoxTexture(box, p, tips) {
  const L = layoutBox(box, p);
  const s = L.s;
  const SS = 2;
  const cnv = document.createElement('canvas');
  cnv.width = L.cw * SS;
  cnv.height = L.ch * SS;
  const ctx = cnv.getContext('2d');
  ctx.scale(SS, SS); // all drawing stays in native units; SS handled here
  ctx.imageSmoothingQuality = 'high';
  paintShadows(ctx, box, L, SS);
  paintBox(ctx, box, L);
  // Ink sits over the type, under the blur and the smear: it is part of the
  // picture those operate on, not something applied afterwards. Shapes are
  // box-local page px and (L.ox, L.oy) is the box's top-left in the footprint,
  // the same translation the mask uses below.
  // The box's strokes and shadows wrap the ink as one shape, drawn with it:
  // the ink's outline sits over the type, as the ink does, and its shadow
  // falls where the ink's own pass puts it (see `paintFinish`).
  if (inkActive(s.ink)) {
    ctx.save();
    ctx.translate(L.ox, L.oy);
    drawInk(ctx, s.ink, undefined, tips, s);
    ctx.restore();
  }
  // Blur first, then roughen - the order the editor's filter list states, and a
  // CSS filter list is applied left to right: `filter: blur() url(#rough)` blurs
  // the clean picture and then crumples the blurred one. Doing it the other way
  // round (which is what happened here) softens the crumple away instead of
  // crumpling a soft edge, and the two are visibly different pictures wherever
  // both effects are on at once.
  //
  // The blur is of the finished picture - shadows, strokes and fill together -
  // so it happens here, on the composite, rather than per drawing call. Canvas
  // filters are stated in device pixels, hence the SS.
  let out = cnv;
  if (s.blur > 0) {
    out = document.createElement('canvas');
    out.width = cnv.width;
    out.height = cnv.height;
    const octx = out.getContext('2d');
    octx.filter = `blur(${s.blur * SS}px)`;
    octx.drawImage(cnv, 0, 0);
    octx.filter = 'none';
  }
  // The directional smear, after the gaussian and before the roughening - the
  // order the editor's filter list states. The tap list is the shader's whole
  // sum flattened (see motionBlurTaps); an empty transparent canvas plus
  // 'lighter' draws is an exact weighted sum, where source-over would
  // composite instead of adding. Offsets are page px, applied in device px,
  // same as every other filter here.
  {
    const taps = s.motionBlur?.on
      ? motionBlurTaps(s.motionBlur.x, s.motionBlur.y, s.motionBlur.amount)
      : [];
    if (taps.length) {
      const acc = document.createElement('canvas');
      acc.width = cnv.width;
      acc.height = cnv.height;
      const actx = acc.getContext('2d');
      actx.globalCompositeOperation = 'lighter';
      for (const t of taps) {
        actx.globalAlpha = t.w;
        actx.drawImage(out, t.dx * SS, t.dy * SS);
      }
      out = acc;
    }
  }
  if (s.roughen.on) roughen(out.getContext('2d'), L, SS);
  // The visibility mask, last of all: it decides what of the finished picture
  // - blur, smear and crumple included - is shown at all, exactly as the
  // editor's CSS mask sits outside its filter list. Shapes are box-local page
  // px; (L.ox, L.oy) is the box's top-left inside the footprint.
  if (clipActive(s.clip)) {
    const m = document.createElement('canvas');
    m.width = out.width;
    m.height = out.height;
    const mctx = m.getContext('2d');
    mctx.scale(SS, SS);
    mctx.translate(L.ox, L.oy);
    drawClipShapes(mctx, s.clip.shapes);
    const octx = out.getContext('2d');
    octx.save();
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalCompositeOperation = s.clip.mode === 'include' ? 'destination-in' : 'destination-out';
    octx.drawImage(m, 0, 0);
    octx.restore();
  }
  return { canvas: out, ox: L.ox, oy: L.oy, cw: L.cw, ch: L.ch, ss: SS };
}

// The mesh warp, over everything: the box is a finished picture by now - type
// and ink and every filter - and the warp carries that one texture, which is
// the whole point of doing it here. Ink cannot be warped separately because
// there is no separate ink: it went into that canvas above, under the same blur
// and behind the same mask.
//
// The deformed mesh reaches outside the box rect, so the footprint the caller is
// told about is the warp's, not the layout's - `ox`/`oy` grow or shrink with it
// and the page composite places the bitmap from those, the same mechanism the
// ink overhang already grew `layoutBox`'s padding for.
//
// `release` hands the texture's pixels back once they have been copied into the
// warped canvas, which is what every one-shot render wants and is what this did
// when it was part of `renderBox`. The gizmo's drag passes false, because the
// texture it just paid for is the one the NEXT frame draws from too.
export function warpTexture(tex, box, release = true) {
  const s = box.style;
  const keep = { canvas: tex.canvas, ox: tex.ox, oy: tex.oy, cw: tex.cw, ch: tex.ch };
  if (!warpActive(s, box.w, box.h)) return keep;
  const warped = warpBoxCanvas(tex.canvas, {
    warp: s.warp,
    w: box.w,
    h: box.h,
    ox: tex.ox,
    oy: tex.oy,
    cw: tex.cw,
    ch: tex.ch,
    ss: tex.ss,
  });
  // Null means the mesh does nothing (or cannot be drawn), and the texture
  // already in hand is the answer - unwarped output stays byte for byte what it
  // was before this pass existed.
  if (!warped) return keep;
  if (release) {
    // The texture has been copied into the warped canvas and nothing else holds
    // it. A box's footprint is megapixels; handing them back here is the same
    // discipline the strip and page exporters keep.
    tex.canvas.width = 0;
    tex.canvas.height = 0;
  }
  return { canvas: warped.canvas, ox: warped.ox, oy: warped.oy, cw: warped.cw, ch: warped.ch };
}

// The box drawn into an editor canvas, at the editor's zoom. This is the
// substitution a warped box makes: the DOM cannot state a mesh, so the box
// stops being a stack of text elements and becomes the exporter's own picture
// of itself, scaled to the zoom.
//
// It is the SAME call the page composite makes, and that is the whole design:
// parity is not two painters agreeing, it is one painter and two destinations.
// At zoom 1 the drawImage below is the composite's drawImage, argument for
// argument. Returns the footprint geometry so the caller can place the canvas -
// `ox`/`oy` page px left of and above the box's own top-left.
export function paintWarpedBox(el, box, p, z, tips) {
  return blitWarped(el, renderBox(box, p, tips), z);
}

// The same picture from a texture the caller is holding on to: the gizmo's live
// drag, which renders the box once when the pointer goes down and then only
// re-runs the mesh. The texture is NOT released - it belongs to the gesture -
// but the warped bitmap this call made is, exactly as above.
export function paintWarpedTexture(el, tex, box, z) {
  const r = warpTexture(tex, box, false);
  // A mesh that does nothing hands the texture straight back, and THAT canvas
  // must survive the blit - it is the gesture's, not this frame's.
  return blitWarped(el, r, z, r.canvas !== tex.canvas);
}

// The bitmap onto the editor's canvas at the zoom, and the footprint back.
// `release` hands the source's pixels back once they are on screen: a chapter of
// warped boxes each holding a supersampled texture is the shape that put
// gigabytes in the webview before.
function blitWarped(el, r, z, release = true) {
  const w = Math.max(1, Math.round(r.cw * z));
  const h = Math.max(1, Math.round(r.ch * z));
  if (el.width !== w) el.width = w;
  if (el.height !== h) el.height = h;
  const ctx = el.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(r.canvas, 0, 0, w, h);
  if (release) {
    r.canvas.width = 0;
    r.canvas.height = 0;
  }
  return { ox: r.ox, oy: r.oy, cw: r.cw, ch: r.ch };
}

const MIME = {
  PNG: 'image/png',
  JPG: 'image/jpeg',
  WebP: 'image/webp',
  PSD: 'image/vnd.adobe.photoshop',
  JSON: 'application/json',
};
const EXT = { PNG: 'png', JPG: 'jpg', WebP: 'webp', PSD: 'psd', JSON: 'json' };
const QUALITY = { PNG: undefined, JPG: 0.95, WebP: 0.92, PSD: undefined };

// Render one page to a canvas: white base + cleaned image (if any) + all text
// boxes composited exactly as the editor shows them. Split out from
// renderPageBlob so a caller could take the composite ImageData without a Blob
// round-trip; the PSD exporter used to be that caller, first for its merged
// image and flattened-preview layer and then for a thumbnail resource, and has
// no use for it now that a PSD's picture lives entirely in its layers. The
// raster (PNG/JPG/WebP) export path is what's left.
// `scale` supersamples the whole page (2 = 2x pixel dims); because text is
// already rendered 2x internally, an outer scale maps that bitmap 1:1 to device
// pixels - so 2x output stays genuinely sharp, not a soft upscale.
export async function renderPageCanvas(p, scale = 1) {
  // Never `p.w` directly: an unmeasured page is 0, and a 0x0 canvas exports as
  // a broken file with a success toast over it. See `pageSpace`.
  const { w: W, h: H } = await pageSpace(p);
  await settleNoise(p?.boxes);
  // The tips this page's ink stamps with, decoded before a single box is
  // painted: the painter cannot await, so the awaiting happens here. See
  // brush-tips.js. Null when no box draws with an imported brush.
  const tips = await settleBoxTips(p?.boxes);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d');
  if (scale !== 1) ctx.scale(scale, scale);
  // white base (JPG has no alpha; manga pages are white anyway)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // Background: the cleaned page when there is one, else the raw - mirroring
  // what the editor shows, so a raws-only chapter doesn't export as a blank
  // white sheet.
  const base = p.cleaned ?? p.raw;
  if (base) {
    try {
      const img = await loadImage(base);
      ctx.drawImage(img, 0, 0, W, H);
    } catch {
      /* draw text on white if image fails */
    }
  }
  ctx.imageSmoothingQuality = 'high'; // crisp downscale of the supersampled text
  for (const box of p.boxes ?? []) {
    ctx.save();
    ctx.globalAlpha = box.style.opacity ?? 1;
    paintBoxOnPage(ctx, box, p, tips);
    ctx.restore();
  }
  return canvas;
}

// Draw one box's glyphs onto `ctx` at page coordinates, exactly as the page
// composite does - sharp direct-angle draw for rotated opaque text, raster
// fallback for roughened/translucent. Opacity is applied by the caller (via
// ctx.globalAlpha or a layer opacity), NOT here, so the same pixels can back a
// translucent PSD layer.
function paintBoxOnPage(ctx, box, p, tips) {
  const s = box.style;
  const rot = s.rotation || 0;
  const opaque = (s.opacity ?? 1) >= 0.999;
  // Mirror flip around the box center, applied INSIDE rotation to match the
  // editor (rotation on .tbox, flip on the inner text → rotate ∘ flip).
  const fx = s.flipH ? -1 : 1;
  const fy = s.flipV ? -1 : 1;
  const flipped = fx !== 1 || fy !== 1;
  // A shadow, a whole-text blur, the directional smear or the visibility mask
  // is an operation on the composite in device pixels (see paintShadows /
  // renderBox), so a box with any of them takes the raster path too - the
  // direct draw has no composite to work on. Ink is here for the other reason:
  // the direct draw paints glyphs only, so an inked box would lose its strokes.
  const composited =
    // A warped box IS its composite - the mesh carries a finished texture, and
    // the direct-angle draw has no texture to carry - so it takes the raster
    // path however plain its type is.
    warpActive(s, box.w, box.h) ||
    (s.shadows ?? []).length > 0 ||
    (s.blur ?? 0) > 0 ||
    (s.motionBlur?.on && ((s.motionBlur.x ?? 0) !== 0 || (s.motionBlur.y ?? 0) !== 0)) ||
    clipActive(s.clip) ||
    inkActive(s.ink);
  if (rot !== 0 && !s.roughen.on && opaque && !composited) {
    // Rotated text: paint glyphs DIRECTLY at the angle so they rasterize sharp
    // (rotating a pre-rendered bitmap would resample and soften it). Pivot
    // around the box center like the editor rotates .tbox. Roughened or
    // translucent boxes fall through to the raster path so their pixel filter
    // / alpha compositing stays correct.
    const L = layoutBox(box, p);
    ctx.save();
    ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
    ctx.rotate((rot * Math.PI) / 180);
    if (flipped) ctx.scale(fx, fy);
    ctx.translate(-box.w / 2 - L.ox, -box.h / 2 - L.oy);
    paintBox(ctx, box, L);
    ctx.restore();
  } else {
    // `ox`/`oy` is where the box's own top-left sits inside the bitmap: the
    // layout's padding and overflow for an ordinary box, and whatever the mesh
    // made of them for a warped one.
    const { canvas: bc, ox, oy, cw, ch } = renderBox(box, p, tips);
    if (rot === 0) {
      // Integer-snap the bitmap origin so a sub-pixel box position doesn't
      // force a bilinear resample of the whole text block (the primary blur).
      const originX = Math.round(box.x - ox);
      const originY = Math.round(box.y - oy);
      if (flipped) {
        // Mirror the bitmap around the box center.
        ctx.save();
        ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
        ctx.scale(fx, fy);
        ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
        ctx.drawImage(bc, originX, originY, cw, ch);
        ctx.restore();
      } else {
        ctx.drawImage(bc, originX, originY, cw, ch);
      }
    } else {
      // Rotated raster fallback (roughened/translucent/masked): downsample the
      // SSx bitmap into its native footprint, pivoting at the box center.
      ctx.save();
      ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
      ctx.rotate((rot * Math.PI) / 180);
      if (flipped) ctx.scale(fx, fy);
      ctx.drawImage(bc, -(box.w / 2 + ox), -(box.h / 2 + oy), cw, ch);
      ctx.restore();
    }
    // The box's own bitmap has been composited and nothing else holds it. A
    // footprint is megapixels and a page turn or a batch export makes one per
    // box; handing them back here is the discipline `paintWarpedBox` and the
    // slice exporter already keep.
    bc.width = 0;
    bc.height = 0;
  }
}

// Render a single box to its own compact, transparent canvas with the exact
// sharp pixels the page composite would show for it (opacity NOT baked in -
// returned as `opacity`). Used as the cached rasterization of an editable PSD
// text layer so it displays pixel-identical to the app even when the manga
// font is missing in Photoshop. Returns null for a box that paints nothing.
// `scratch` is an optional reusable (W*scale)×(H*scale) canvas to avoid per-box
// allocations. `p` is the box's page (so line-backed text resolves correctly).
// `scale` supersamples to match a scaled document; returned bounds are in the
// scaled (device) pixel space.
export function renderBoxLayer(box, W, H, scratch, p, scale = 1, tips) {
  const SW = Math.round(W * scale);
  const SH = Math.round(H * scale);
  const cnv = scratch || document.createElement('canvas');
  if (cnv.width !== SW) cnv.width = SW;
  if (cnv.height !== SH) cnv.height = SH;
  const ctx = cnv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, SW, SH);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.imageSmoothingQuality = 'high';
  paintBoxOnPage(ctx, box, p, tips); // full opacity; layer opacity applied by consumer
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const full = ctx.getImageData(0, 0, SW, SH);
  const d = full.data;
  let minX = SW,
    minY = SH,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      if (d[(y * SW + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // nothing drawn (empty text)
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').putImageData(full, -minX, -minY);
  return {
    imageData: out.getContext('2d').getImageData(0, 0, w, h),
    left: minX,
    top: minY,
    right: minX + w,
    bottom: minY + h,
    opacity: box.style.opacity ?? 1,
  };
}

// Render one page to a Blob in the requested raster format (native resolution).
async function renderPageBlob(p, fmt) {
  const canvas = await renderPageCanvas(p);
  const blob = await new Promise((res) => canvas.toBlob(res, MIME[fmt], QUALITY[fmt]));
  // Hand the page's pixels back before the caller allocates the next page's.
  // Same reasoning as the strip exporter: a local canvas is collectable, but
  // "eventually" is not a budget when a batch export renders one per loop turn.
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) {
    throw new Error(`Could not render page ${p?.id ?? ''} (page too large)`.trim());
  }
  return blob;
}

// ---------- longstrip: the chapter as one column, re-cut ----------
//
// A webtoon's source pages are an artefact of how the raw was cut; the files it
// ships as are cut wherever the target site wants them. So a whole-chapter
// raster export of a longstrip project does not write one file per source page:
// it stitches the column and re-slices it at the user's height, with every cut
// moved clear of lettering by `planStripCuts`.
//
// Everything below works in strip pixels - page pixels stacked with no gap,
// which is exactly what `stripOffsets(pages)` answers at zoom 1.

// The strip's arithmetic needs every page's real size, and a page that has never
// been on screen is `w:0,h:0` (see `pageSpace`). Left unmeasured it would
// contribute a zero-height frame: the export would silently drop most of the
// chapter and every offset below it would be wrong. So the sizes are resolved
// once, up front, and written back onto the pages - the same field the editor
// fills in when an image loads, so nothing downstream has to be told twice.
async function measureStrip(pages) {
  for (const p of pages) {
    if (p.w > 0 && p.h > 0) continue;
    // One page's picture at a time: the point of the slice loop below is that
    // the whole chapter is never resident, and measuring must not undo that.
    const { w, h } = await withPageImages(p, () => pageSpace(p));
    p.w = w;
    p.h = h;
  }
  const { tops, total } = stripOffsets(pages);
  return { tops, total, width: maxPageWidth(pages) || PAGE_W };
}


// Pin several pages' images for the duration of one call. Nesting rather than
// looping because `withPageImages` releases in its own `finally` - the pins have
// to overlap, not follow one another. Per-page nesting is explicitly fine (the
// pin is a count), and the depth here is however many pages one slice spans.
async function withPagesImages(list, fn) {
  if (!list.length) return fn();
  const [head, ...rest] = list;
  return withPageImages(head, () => withPagesImages(rest, fn));
}

// One output image: the strip from y0 to y1, at the width of the widest page.
//
// `tops` must be the offsets `stripOffsets(pages)` gives for these same pages -
// the caller measures once and slices many times, and the two must agree or the
// seams move.
//
// Narrower pages are centred, which is what the editor's `.strip` does with
// `align-items:center`. A slice is never the whole column: the canvas allocated
// here is one slice tall and is released before the next one is drawn, so a
// 200-page chapter costs one slice of memory rather than a 400,000px raster no
// browser would hand out anyway.
export async function renderStripSliceCanvas(pages, tops, y0, y1, scale = 1) {
  await settleNoise((pages ?? []).flatMap((p) => p?.boxes ?? []));
  // One prefetch for the whole slice: the same brush usually runs through every
  // page of a chapter, and the library's cache would answer the rest anyway.
  const tips = await settleBoxTips((pages ?? []).flatMap((p) => p?.boxes ?? []));
  const W = maxPageWidth(pages) || PAGE_W;
  const H = Math.max(1, Math.round(y1 - y0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d');
  if (scale !== 1) ctx.scale(scale, scale);
  // White base, for the same reasons a page has one: JPG has no alpha, and a
  // slice wider than the page it holds shows paper either side of it.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high'; // crisp downscale of the supersampled text

  const artHits = [];
  const textHits = [];

  (pages ?? []).forEach((p, i) => {
    const top = tops[i] ?? 0;
    const h = Math.max(0, p?.h ?? 0);
    // Runtime URLs are null outside the resident image window. Select by
    // geometry first; withPagesImages mints and pins the artwork below.
    if (top + h > y0 && top < y1) {
      artHits.push({ p, top });
    }
    for (const box of p?.boxes ?? []) {
      const s = boxPaintedStripSpan(box, top);
      if (s.bottom > y0 && s.top < y1) {
        textHits.push({ box, p, top });
      }
    }
  });

  // Pass 1: paint all artwork intersecting the requested output rectangle.
  await withPagesImages(
    artHits.map((h) => h.p),
    async () => {
      for (const { p, top } of artHits) {
        const { w, h } = await pageSpace(p);
        const x = Math.round((W - w) / 2);
        const y = top - y0;
        const base = p.cleaned ?? p.raw;
        if (base) {
          try {
            const img = await loadImage(base);
            ctx.drawImage(img, x, y, w, h);
          } catch {
            /* draw this page's text on white if its image fails */
          }
        }
      }
    },
  );

  // Pass 2: paint all lettering whose painted bounds intersect that rectangle,
  // in stable document layer order.
  for (const { box, p, top } of textHits) {
    const w = p?.w || W;
    const x = Math.round((W - w) / 2);
    const y = top - y0;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = box.style.opacity ?? 1;
    paintBoxOnPage(ctx, box, p, tips);
    ctx.restore();
  }
  return canvas;
}

// Render one source page of a longstrip column to a Blob via the strip compositor,
// slicing at [top, top + h] in document space so cross-seam lettering and neighbor
// boxes are preserved.
async function renderStripPageBlob(p, fmt) {
  const pages = app.pages?.length ? app.pages : [p];
  const idx = pages.findIndex((pg) => pg?.id === p?.id);
  // The current source boundary and the column width use the same measured
  // layout as whole-chapter export. Measurement pins one image at a time, so
  // it does not retain the whole chapter's decoded artwork.
  const { tops } = await measureStrip(pages);
  const top = idx >= 0 ? tops[idx] ?? 0 : 0;
  const canvas = await renderStripSliceCanvas(pages, tops, top, top + (p.h || PAGE_H));
  const blob = await new Promise((res) => canvas.toBlob(res, MIME[fmt], QUALITY[fmt]));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) {
    throw new Error(`Could not render page ${p?.id ?? ''} (page too large)`.trim());
  }
  return blob;
}

// Raster formats - the ones a strip can be re-cut into. PSD stays one layered
// document per source page (its whole value is the editable layers, which a
// stitched slice would fuse across page boundaries) and JSON is one document for
// the chapter either way.
const RASTER = new Set(['PNG', 'JPG', 'WebP']);

// The whole-chapter strip export. Called only from `exportImages`, which already
// holds `app.exporting` across it.
async function exportStripImages(fmt) {
  const pages = app.pages;
  const { tops, total } = await measureStrip(pages);
  const target = app.stripSliceH > 0 ? app.stripSliceH : SLICE_H_DEFAULT;
  const { cuts, warnings } = planStripCuts(pages, target);
  if (!(total > 0) || cuts.length < 2) {
    toast('Nothing to export: this chapter has no page art to slice.');
    return false;
  }
  const ext = EXT[fmt];
  const n = cuts.length - 1;
  const digits = Math.max(2, String(n).length);
  const baseName = sanitizeExportName(app.exportName);
  // Destination first, then render: each slice is written and dropped as it is
  // produced. Slices are the biggest blobs the app makes, and accumulating
  // them across the whole column meant holding the entire chapter's encoded
  // output at once behind the directory dialog.
  const dir = isTauri() ? await pickExportDir() : null;
  if (isTauri() && !dir) return true; // user cancelled
  let written = 0;
  for (let i = 0; i < n; i++) {
    const canvas = await renderStripSliceCanvas(pages, tops, cuts[i], cuts[i + 1]);
    const blob = await new Promise((res) => canvas.toBlob(res, MIME[fmt], QUALITY[fmt]));
    // Hand the slice's pixels back before the next one is allocated. A canvas
    // held only by a local is collectable anyway, but "eventually" is not a
    // memory budget when the next line asks for another few hundred megapixels.
    canvas.width = 0;
    canvas.height = 0;
    const name = `${baseName}-strip-${String(i + 1).padStart(digits, '0')}.${ext}`;
    if (dir) await writeItemTo(dir, name, blob);
    else downloadBlob(blob, name);
    written++;
  }
  if (dir) {
    saveExportPrefs(dir, app.exportName);
    toast(`Saved ${written} file(s) to ${dir}`);
  } else {
    toast(`Exported ${written} strip slice(s) as ${fmt} (browser download)`);
  }
  if (warnings.length) {
    // Said out loud rather than swallowed: these are the files with a seam
    // through lettering, and the fix (a taller slice, or moving that box) is the
    // user's to make.
    toast(`Saved ${written} slice(s) - ${warnings.length} cut(s) had no gap to land in.`);
  }
  return true;
}

function isTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function blobBytes(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

// Strip the page id suffix appended by single-page export (e.g. 'Chapter-10-1' → 'Chapter-10')
// only when it matches the actual page ID; otherwise leave the stem untouched so numbered
// chapter names (e.g. 'Chapter-10.png') are not corrupted.
export function stripPageSuffix(stem, pageId) {
  if (pageId == null) return stem;
  const suffix = `-${pageId}`;
  return stem.endsWith(suffix) ? stem.slice(0, -suffix.length) : stem;
}

// The directory half of `saveNative`'s 'all' path, split out so batch exports
// can ask for the destination before rendering and stream each file to it as
// it is produced. Returns the directory, or null on cancel.
async function pickExportDir() {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const dir = await open({ directory: true, defaultPath: app.exportDir || undefined });
  return dir || null;
}

// Write one export item into a directory picked by `pickExportDir`.
async function writeItemTo(dir, name, blob) {
  const { join } = await import('@tauri-apps/api/path');
  await fsx.writeFileAtomic(await join(dir, name), await blobBytes(blob));
}

// Native single-file save via the OS dialog + filesystem (Tauri). Returns the
// directory used. Batch scopes do not come through here any more: they pick a
// directory up front (`pickExportDir`) and stream each file as it is rendered,
// so nothing ever accumulates a chapter's worth of blobs behind a dialog.
async function saveNative(items, fmt) {
  const [{ save }, { join, dirname, basename }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/api/path'),
  ]);
  const ext = EXT[fmt];
  const first = items[0];
  const defaultPath = app.exportDir ? await join(app.exportDir, first.name) : first.name;
  const path = await save({
    defaultPath,
    filters: [{ name: fmt, extensions: [ext] }],
  });
  if (!path) return null; // user cancelled
  await fsx.writeFileAtomic(path, await blobBytes(first.blob));
  const dir = await dirname(path);
  // Learn the base name from a page file only - the JSON export's name carries
  // a "-text" suffix that must not become the project's export base.
  // Only strip the suffix if it matches the current page id appended by export.
  const stem = (await basename(path)).replace(/\.[^.]+$/, '');
  const base =
    fmt === 'JSON'
      ? app.exportName
      : stripPageSuffix(stem, first?.page?.id);
  saveExportPrefs(dir, base || app.exportName);
  toast(`Saved to ${path}`);
  return dir;
}

// The detected/typeset text for a scope: one document, not one file per page,
// and the same document the export dialog's JSON format produces. Lifted out of
// exportImages so the detect menu and the dialog run identical code - two
// serialisers for one file format would drift the moment either was touched.
// Does NOT set app.exporting: exportImages already holds it across this call,
// and every other caller wraps it the same way.
export async function exportTextJson(scope) {
  const pages = scope === 'all' ? app.pages : [page()];
  const suffix = scope === 'all' ? 'text' : `${pages[0].id}-text`;
  const baseName = sanitizeExportName(app.exportName);
  const items = [
    {
      name: `${baseName}-${suffix}.json`,
      blob: new Blob([buildTextJson(pages)], { type: MIME.JSON }),
      page: pages[0],
    },
  ];
  if (isTauri()) {
    // Always the single-file save dialog - 'all' is still one document.
    await saveNative(items, 'JSON');
  } else {
    downloadBlob(items[0].blob, items[0].name);
    toast(`Exported text for ${pages.length} page(s) as JSON (browser download)`);
  }
  return true;
}

// Public entry: scope = 'current' | 'all', fmt = PNG|JPG|WebP|PSD|JSON.
export async function exportImages(fmt, scope) {
  app.exporting = true;
  try {
    await document.fonts.ready;
    const pages = scope === 'all' ? app.pages : [page()];
    const ext = EXT[fmt];

    // JSON is one document for the whole scope (not one file per page), so it
    // round-trips through the JSON importer in a single pick.
    if (fmt === 'JSON') return await exportTextJson(scope);

    // A whole longstrip chapter is one column, and the files it ships as are
    // slices of that column rather than its source pages. Only 'all' - a single
    // page is still a single page, and the user asking for "this page" in a
    // strip is asking for the slice they are looking at, not a re-cut of it.
    if (isLongstrip() && scope === 'all' && RASTER.has(fmt)) {
      return await exportStripImages(fmt);
    }

    const baseName = sanitizeExportName(app.exportName);
    // The destination is asked for BEFORE the render loop, so every page's
    // file is written - and its blob dropped - the moment it is rendered.
    // Rendering the whole chapter first and asking afterwards held every
    // encoded page in memory at once, across a dialog the user may sit on:
    // a 100-page PSD export is gigabytes of blobs for no better dialog.
    const streamDir = isTauri() && scope === 'all' ? await pickExportDir() : null;
    if (isTauri() && scope === 'all' && !streamDir) return true; // cancelled
    const items = [];
    let written = 0;
    for (const p of pages) {
      // Only five pages' pictures are in memory at a time (see page-images.js),
      // and a whole-chapter export needs all of them - one at a time. This is
      // that: the page is minted if the window does not already hold it, pinned
      // so a page turn mid-export cannot revoke the image being drawn, and
      // handed back when its file is written.
      const blob = await withPageImages(p, async () => {
        if (fmt === 'PSD') {
          // Layered, editable PSD carrying the full project as embedded JSON so
          // it round-trips losslessly (one .psd per page). Lazily imported so
          // ag-psd isn't pulled into the raster-export path.
          const { buildPagePsd } = await import('./psd.js');
          const bytes = await buildPagePsd(p);
          return new Blob([bytes], { type: MIME.PSD });
        }
        if (isLongstrip() && RASTER.has(fmt)) {
          return await renderStripPageBlob(p, fmt);
        }
        return await renderPageBlob(p, fmt);
      });
      const name = `${baseName}-${p.id}.${ext}`;
      if (streamDir) {
        await writeItemTo(streamDir, name, blob);
        written++;
      } else if (!isTauri() && scope === 'all') {
        downloadBlob(blob, name);
        written++;
      } else {
        items.push({ name, blob, page: p });
      }
    }
    if (streamDir) {
      saveExportPrefs(streamDir, app.exportName);
      toast(`Saved ${written} file(s) to ${streamDir}`);
    } else if (isTauri()) {
      await saveNative(items, fmt);
    } else if (scope === 'all') {
      toast(`Exported ${written} image(s) as ${fmt} (browser download)`);
    } else {
      for (const it of items) downloadBlob(it.blob, it.name);
      toast(`Exported ${items.length} image(s) as ${fmt} (browser download)`);
    }
    return true;
  } catch (e) {
    toast('Export failed: ' + (e?.message || e));
    return false;
  } finally {
    app.exporting = false;
  }
}

// Back-compat wrapper.
export async function exportCurrentPage(fmt) {
  return exportImages(fmt, 'current');
}
