// ===== Pictures of SFX lettering for the Inspector's SFX panel =====
//
// Two pictures, both painted by the same painter that draws the box on the
// page and in the export (`pictureTexture`, then `warpTexture`), so a preview
// is the engine's own picture and not a second drawing of it:
//
//   the stage   the selected box's own text and style, as it paints now
//   a card      the box's font, colour and strokes with one preset applied,
//               on the first eight code points of its text
//
// Both are cut to the ink they hold (the box's frame is often far larger than
// its letters, and a sound effect spreads past it) and scaled to fit. The
// cards are small PNG data URLs kept in a bounded cache, so painting one is a
// thing that happens once per (text, look, preset, seed) and never again.
import { defaultStyle, normalizeStyle } from './data.js';
import { applySfxPreset } from './sfx.js';
import { pictureTexture } from './editor/box-picture.js';
import { warpTexture } from './exporter.js';
import { boxCandidate, placeBlock, blockRect } from './contain.js';

// A card's tile, in CSS px. The panel shows it with `background-size: contain`,
// so a card a little wider or narrower than this only gets more or less margin.
export const CARD_W = 96;
export const CARD_H = 44;
const CARD_PAD = 4;
// The size the card's text is set at. The preset's gaps are in ems and the
// strokes are scaled with the size, so any size gives the same picture; this
// one keeps eight letters inside a texture a few hundred pixels across.
const CARD_SIZE = 30;
// Texture px per page px for a card: sharper than the tile, then scaled down.
const CARD_SCALE = 1.5;
const CARD_MAX_PX = 480 * 240;
// A card with one wide letter is enlarged to fill its tile, but by no more than
// this, so a small texture is not blown up into mush.
const CARD_ENLARGE = 2;
const CARD_WORD = 'SFX';
const CARD_LETTERS = 8;

// The stage paints at the density the screen has (capped) and no more than
// this many pixels, which a box the size of a page would otherwise exceed.
const STAGE_MAX_PX = 2.5 * 1024 * 1024;
const STAGE_PAD = 10;
const STAGE_ENLARGE = 3;
// A pixel counts as ink above this alpha (of 255).
const ALPHA = 8;

const CACHE_MAX = 600;
const CACHE_DROP = 200;
const cache = new Map();

export const cachedCard = (key) => cache.get(key);
export function keepCard(key, url) {
  cache.set(key, url);
  if (cache.size > CACHE_MAX) {
    let n = CACHE_DROP;
    for (const k of cache.keys()) {
      if (n-- <= 0) break;
      cache.delete(k);
    }
  }
}
export const cardCacheSize = () => cache.size;
export const clearCardCache = () => cache.clear();

/** Device pixels per CSS px, as a painter should take it: 1 to 2. */
export function previewDpr() {
  const d = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
  return d > 0 ? Math.min(2, d) : 1;
}

/**
 * The text a card shows: the box's first eight code points, line breaks kept,
 * and the word "SFX" when there is nothing to show.
 */
export function cardText(text) {
  const cut = [...String(text ?? '')].slice(0, CARD_LETTERS).join('').replace(/\s+$/, '');
  return cut.trim() === '' ? CARD_WORD : cut;
}

/**
 * Everything a card's picture depends on, as plain data: it is the cache key,
 * and the painter reads nothing else of the box. Strokes are kept in the
 * box's own units here (`size` is in the key) and made proportional to the
 * card's size when painted.
 */
export function cardSpec(style, text) {
  return {
    text: cardText(text),
    font: style.font,
    bold: !!style.bold,
    italic: !!style.italic,
    uppercase: !!style.uppercase,
    color: style.color,
    noFill: !!style.noFill,
    size: style.size > 0 ? style.size : CARD_SIZE,
    lineHeight: style.lineHeight,
    strokes: (style.strokes ?? []).map((s) => ({ color: s.color, width: s.width, opacity: s.opacity })),
    seed: style.sfx?.seed ?? 1,
  };
}

/** The cache key of one preset's card for a spec at one density. */
export const cardKey = (spec, presetId, fonts, dpr) => `${presetId}|${fonts}|${dpr}|${JSON.stringify(spec)}`;

// The page-less box a preview is painted from. Nothing here is the user's
// box: its id is its own, its ink and mask are off, and its text is stated.
function previewBox(style, text, w, h, id) {
  return { id, lineN: null, text, x: 0, y: 0, w, h, fit: null, style };
}

// Where the ink is, in canvas px, or null when nothing in it can be read (an
// empty picture, or a canvas that will not give its pixels back).
function inkRect(canvas) {
  try {
    const { width, height } = canvas;
    if (!(width > 0 && height > 0)) return null;
    const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width * 4 + 3;
      for (let x = 0; x < width; x++) {
        if (data[row + x * 4] > ALPHA) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  } catch {
    return null;
  }
}

// The picture, cut to its ink and drawn contained and centred in a W x H
// canvas with `pad` px of margin. `cap` is the most it will be enlarged.
function drawFit(ctx, tex, W, H, pad, cap) {
  const r = inkRect(tex) ?? { x: 0, y: 0, w: tex.width, h: tex.height };
  if (!(r.w > 0 && r.h > 0)) return;
  const k = Math.min((W - 2 * pad) / r.w, (H - 2 * pad) / r.h, cap);
  const dw = r.w * k;
  const dh = r.h * k;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tex, r.x, r.y, r.w, r.h, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

/**
 * One card: the preset on the spec's text and look, as a PNG data URL, or null
 * when the engine could not paint it.
 */
export function paintCard(spec, preset, dpr = 1) {
  let raw = null;
  let tex = null;
  try {
    const k = CARD_SIZE / spec.size;
    const style = normalizeStyle({
      ...defaultStyle(),
      font: spec.font,
      bold: spec.bold,
      italic: spec.italic,
      uppercase: spec.uppercase,
      color: spec.color,
      noFill: spec.noFill,
      size: CARD_SIZE,
      lineHeight: spec.lineHeight,
      strokes: spec.strokes.map((s) => ({ ...s, width: s.width * k })),
      align: 'center',
      valign: 'middle',
      autoHeight: false,
    });
    style.sfx.seed = spec.seed;
    // SFX is placed from the box's centre, so the frame is only a place for
    // the centre to be. An envelope is laid over the frame itself, so for one
    // the frame is cut to the word first: the card then shows the whole bend.
    const box = previewBox(style, spec.text, 4 * CARD_SIZE, 2 * CARD_SIZE, 'sfx-card');
    if (preset.envelope) {
      const place = placeBlock(boxCandidate(box, spec.text));
      if (!place.isCurve) {
        const { x0, x1 } = blockRect(place);
        if (x1 - x0 > 1 && place.blockH > 1) {
          box.w = Math.ceil(x1 - x0) + CARD_SIZE / 2;
          box.h = Math.ceil(place.blockH);
        }
      }
    }
    applySfxPreset(style, preset, box);
    raw = pictureTexture(box, undefined, undefined, CARD_SCALE, CARD_MAX_PX);
    // Bent already when the painter bends (`meshInJob`); through the texture
    // otherwise.
    tex = warpTexture(raw, box);
    const out = document.createElement('canvas');
    out.width = Math.round(CARD_W * dpr);
    out.height = Math.round(CARD_H * dpr);
    drawFit(out.getContext('2d'), tex.canvas, out.width, out.height, CARD_PAD * dpr, CARD_ENLARGE);
    return out.toDataURL('image/png');
  } catch {
    return null;
  } finally {
    for (const t of [raw, tex]) {
      if (t) {
        t.canvas.width = 0;
        t.canvas.height = 0;
      }
    }
  }
}

/**
 * The stage: the box's own text and style, painted into `canvas` (whose pixel
 * size the caller has set), cut to its ink and centred. `snap` is plain data:
 * `{ style, text, w, h }`, the style a snapshot of the box's. Returns whether
 * a picture was painted.
 */
export function paintStage(canvas, snap, dpr = 1) {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  let raw = null;
  let tex = null;
  try {
    const style = normalizeStyle(snap.style);
    // What belongs to the page and not to the lettering: hand-drawn ink and
    // the visibility mask, which are the box's own geometry.
    style.ink = { on: false, strokes: [] };
    style.clip = { ...style.clip, on: false };
    const text = String(snap.text ?? '').trim() === '' ? CARD_WORD : snap.text;
    const box = previewBox(style, text, snap.w, snap.h, 'sfx-stage');
    // Two texture px per page px at the screen's density (less for a box so
    // large that the budget says so), then the mesh warp if the box has one.
    raw = pictureTexture(box, undefined, undefined, 2 * dpr, STAGE_MAX_PX);
    const ss = raw.ss > 0 ? raw.ss : 1;
    tex = warpTexture(raw, box);
    // Enlarged to fill the stage, but to no more than three screen px per
    // page px: one short word in a large frame is not a billboard.
    drawFit(ctx, tex.canvas, W, H, STAGE_PAD * dpr, (STAGE_ENLARGE * dpr) / ss);
    return true;
  } catch {
    return false;
  } finally {
    for (const t of [raw, tex]) {
      if (t) {
        t.canvas.width = 0;
        t.canvas.height = 0;
      }
    }
  }
}
