// ===== A box in the editor, as the engine's own picture of it =====
//
// With the Rust engine drawing (engine-switch.svelte.js) a box that is not
// being typed into is shown as ONE canvas, painted by `renderBoxTexture` - the
// function the export, the PSD's rasters and the warped box have always
// called. What is on screen is then the file's picture by construction: one
// painter and two destinations, which is the design `paintWarpedBox` set out
// for a warped box and this makes the rule for every box.
//
// What differs from the export is only the resolution. The export paints at 2
// and lets the composite scale it down; the editor paints at the scale the
// picture is SHOWN at - the zoom times the display's pixel ratio, one texture
// pixel per device pixel - because DOM text was sharp at every zoom and a
// picture painted at 2 is soft above 200% and wasted below.
//
// The canvas itself, its repaint key, its sequence counter and its release
// are TextBox.svelte's, the same ones the warped box had; this file is the
// arithmetic and the two paints, kept out of the component so they can be
// tested without one.
import { renderBoxTexture, warpTexture } from '../exporter.js';

// The most pixels one box's canvas holds: 8 megapixels, 32 MB of RGBA.
//
// It is about one 4K screen (3840 x 2160 is 8.3 MP). A box whose footprint is
// larger than that in device pixels cannot be on screen whole at full
// resolution on nearly any display, so lowering ITS scale costs sharpness only
// on a box that is already bigger than the screen - a full-page sound effect
// at 400% - and costs every ordinary box nothing: a 300 x 200 balloon is under
// 4 MP at 400% on a 2x display. It is also far inside what a canvas may be
// (16384 a side, 64 MP: warp-paint.js) and what the engine will paint (67 MP).
export const PICTURE_MAX_PX = 8 * 1024 * 1024;

/** Device px per page px a box is painted at when nothing caps it. */
export function pictureScale(zoom, dpr) {
  return zoom * (dpr > 0 ? dpr : 1);
}

// The finished bitmap onto the editor's canvas, pixel for pixel, and the
// footprint back. 'copy' rather than a clear and a draw: the canvas then holds
// exactly the bytes the painter made, which is what lets a test say the editor
// and the export are the same picture and mean the same bytes.
//
// A mesh can carry a texture well past the footprint it was budgeted for
// (warp-paint.js allows 64 MP), and this canvas is kept where the texture is
// not - so a warped result over the budget is scaled down into it. Nothing
// else comes in over: `renderBoxTexture` was handed the same budget, and the
// row or column its rounding adds is the slack allowed here.
function show(el, r, maxPx, release) {
  let w = r.canvas.width;
  let h = r.canvas.height;
  const over = (w * h) / maxPx;
  if (over > 1.02) {
    const k = 1 / Math.sqrt(over);
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
  }
  if (el.width !== w) el.width = w;
  if (el.height !== h) el.height = h;
  const ctx = el.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'copy';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(r.canvas, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  if (release) {
    // The texture is on screen and nothing else holds it. A footprint at the
    // display's scale is megapixels, and there is one of these per box.
    r.canvas.width = 0;
    r.canvas.height = 0;
  }
  return { ox: r.ox, oy: r.oy, cw: r.cw, ch: r.ch };
}

/**
 * Paints `box` into the editor canvas `el` at `scale` device px per page px
 * (less for a box over the budget), mesh included. Returns where the picture
 * sits: `ox`/`oy` page px left of and above the box's own top-left, and the
 * `cw` x `ch` page px it spans - what `pictureCss` places the canvas by.
 */
export function paintBoxPicture(el, box, p, scale, tips, maxPx = PICTURE_MAX_PX) {
  return show(el, warpTexture(renderBoxTexture(box, p, tips, scale, maxPx), box), maxPx, true);
}

/**
 * The same from a texture the caller is holding on to: the mesh gizmo's drag,
 * which paints the box once when the pointer goes down and then only re-runs
 * the mesh. The texture is the gesture's and is not released; the warped
 * bitmap this call made is.
 */
export function paintPictureTexture(el, tex, box, maxPx = PICTURE_MAX_PX) {
  const r = warpTexture(tex, box, false);
  return show(el, r, maxPx, r.canvas !== tex.canvas);
}

/**
 * The canvas's inline placement, in zoomed CSS px relative to the box's own
 * top-left (the clip wrapper's origin).
 *
 * `at` is the box's page position when the picture should be set on whole
 * device pixels, and null when it should not. A canvas painted one texture
 * pixel per device pixel is only shown that way if it also STARTS on a device
 * pixel; half a pixel off and the compositor resamples the whole of it, which
 * is the softness painting at the display's scale was for. So the corner is
 * moved to the nearest device pixel - at most half of one, a quarter of a CSS
 * px on a 2x display. Only for a box that is upright and unmirrored: a turned
 * picture is resampled whatever its corner does.
 */
export function pictureCss(g, z, dpr = 1, at = null) {
  let left = -g.ox * z;
  let top = -g.oy * z;
  if (at && dpr > 0) {
    const snap = (v) => Math.round(v * dpr) / dpr;
    left = snap((at.x - g.ox) * z) - at.x * z;
    top = snap((at.y - g.oy) * z) - at.y * z;
  }
  return `left:${left}px;top:${top}px;width:${g.cw * z}px;height:${g.ch * z}px;`;
}

// What a repaint key says for a box that is to hold no pixels: on a hidden
// page, or too far from the viewport to be seen.
export const PICTURE_OFF = 'e|off';

/**
 * Everything the engine's picture of a box is drawn from, as one string.
 *
 *   in:  the style, less what CSS applies to the finished picture (the turn,
 *        the flip, the opacity); the text; the box's size; the lines it broke
 *        into and how far each is set in, which is where a balloon fit, the
 *        typesetting mode and a late font show up; the scale; the font
 *        version.
 *   out: where the box is. A move repaints nothing.
 *
 * The ink block is not stringified here - it is the heaviest part of a style
 * and the caller already has a key for it (`inkKey` in TextBox.svelte).
 */
export function pictureKey({ style, inkKey, text, w, h, lines, indents, scale, fonts }) {
  const drawn = { ...style, ink: 0, rotation: 0, opacity: 1, flipH: false, flipV: false };
  return (
    `e|${JSON.stringify(drawn)}|${inkKey}|${text}|${w}|${h}|` +
    `${lines ? lines.join('\n') : ''}|${indents ? indents.join(',') : ''}|${scale}|${fonts}`
  );
}
