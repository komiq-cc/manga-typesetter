// Layered PSD import/export with lossless round-trip.
//
// Dual representation: the PSD's visible layers are real, editable Photoshop
// objects (editable text layers, base rasters), AND the complete project is
// embedded as JSON in an image resource (XMP) so this app can reconstruct the
// page with zero loss of editable state. On import we prefer the embedded JSON
// (lossless path) and fall back to a best-effort layer mapping for foreign PSDs.
//
// ag-psd auto-initializes its canvas backend when `document` is present (the
// Tauri webview / vite browser), so no explicit initializeCanvas call is needed.
import { writePsd, readPsd } from 'ag-psd';
import { app, PAGE_W, PAGE_H } from './store.svelte.js';
import { isTauri, pickFilesTauri } from './importer.js';
import { renderBoxLayer, pageSpace, settleNoise } from './exporter.js';
import { settleBoxTips } from './brush-tips.js';
import { fontCssFor, fontNameFor, reviewOf } from './store.svelte.js';
import { resolveFace, postScriptNameFor } from './fonts.js';
import { applyCase, canMeasure, textInset, contentWidth, blockYFor } from './measure.js';
import { boxCandidate, placeBlock } from './contain.js';
import { normalizeFit, normalizeAuto } from './data.js';
import { strokeBands, clipActive, inkActive } from './text-paint.js';
import { warpActive } from './warp.js';
import { withPageImages } from './page-images.js';

// Bumped when the embedded schema changes in a non-back-compatible way. Import
// refuses newer majors it can't understand and falls back to layer mapping.
const SCHEMA = 1;
const PROJECT_KEY = 'mt:project';
const XMP_NS = 'https://manga-typesetter.app/ns/mt/1.0/';
// PSD/PSB hard limits: PSD tops out at 30000px per side, PSB at 300000.
const PSD_MAX = 30000;

// ---------------------------------------------------------------------------
// pixel helpers
// ---------------------------------------------------------------------------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Decode any image source (object URL / data URL) to raw RGBA ImageData at its
// natural size, unless (w,h) force a target size. Raw pixels - no lossy
// re-encode - are what we hand to ag-psd.
async function imageDataFromSrc(src, w, h) {
  const img = await loadImage(src);
  const cw = w || img.naturalWidth || img.width;
  const ch = h || img.naturalHeight || img.height;
  const cnv = document.createElement('canvas');
  cnv.width = cw;
  cnv.height = ch;
  const ctx = cnv.getContext('2d');
  ctx.drawImage(img, 0, 0, cw, ch);
  return ctx.getImageData(0, 0, cw, ch);
}

// The document's pixel space, and the space every layer's bounds are written
// in. `pageSpace` lives in `exporter.js` - one rule, one copy: a page is
// `w:0,h:0` until something decodes its image, Export All reaches pages nobody
// has opened, and a 0x0 document is an unreadable PSD. Both exporters have to
// answer that the same way or a page renders at one size and writes its layers
// at another.

// Re-encode a canvas/ImageData source into a PNG object URL (used to rebuild
// page.raw / page.cleaned from PSD base layers on import).
// toBlob hands back null when the encode fails - a PSB-sized canvas under
// memory pressure is exactly that case. Resolving on null would throw inside
// the callback, leaving this promise neither settled nor rejected and every
// awaiting import hung behind a busy state that has no way out.
function canvasToObjectUrl(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error('Could not encode that layer'))),
      'image/png',
    ),
  );
}

function imageDataToCanvas(imageData) {
  const cnv = document.createElement('canvas');
  cnv.width = imageData.width;
  cnv.height = imageData.height;
  cnv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height), 0, 0);
  return cnv;
}

function hexToRgb(hex) {
  let h = String(hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return { r: parseInt(h.slice(0, 2), 16) || 0, g: parseInt(h.slice(2, 4), 16) || 0, b: parseInt(h.slice(4, 6), 16) || 0 };
}
// ...and back, for what the importer reads off a layer.
const rgbHex = (c) => '#' + [c?.r, c?.g, c?.b].map((v) => ((v | 0) & 255).toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------
// embedded JSON (XMP image resource) - the lossless source of truth
// ---------------------------------------------------------------------------

function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64DecodeUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Wrap the project JSON in a minimal XMP packet under our own namespace. The
// payload is base64 so it's XML-safe and Photoshop preserves the custom
// property across its own XMP rewrites.
function wrapXmp(jsonStr) {
  const payload = b64EncodeUtf8(jsonStr);
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    `  <rdf:Description rdf:about="" xmlns:mt="${XMP_NS}">\n` +
    `   <mt:project>${payload}</mt:project>\n` +
    '  </rdf:Description>\n' +
    ' </rdf:RDF>\n' +
    '</x:xmpmeta>\n' +
    '<?xpacket end="w"?>'
  );
}

function extractProject(xmp) {
  if (!xmp) return null;
  const m = xmp.match(/<mt:project>([\s\S]*?)<\/mt:project>/);
  if (!m) return null;
  try {
    return JSON.parse(b64DecodeUtf8(m[1].trim()));
  } catch {
    return null;
  }
}

// Page → plain JSON with every field needed to rebuild it, minus volatile ids
// (box.id - reassigned on import) and object URLs (page.raw/cleaned - rebuilt
// from the base rasters).
// Exported for psd.test.js, which is the only place the free-line and tag
// fields below can be pinned from node: everything downstream of here wants a
// canvas.
export function serializePage(p) {
  return {
    id: p.id,
    w: p.w || PAGE_W,
    h: p.h || PAGE_H,
    // `n` carries free-typed lines through unremarked, and that is the point of
    // making a negative number the marker for one rather than adding a field:
    // every serializer in the app already carries `n` because nothing works
    // without it, so there is no way to forget it here. See `isFreeLine` in
    // store.svelte.js.
    //
    // `tags` alongside `type`, and for the reason the JSON exporter already
    // states: `type` can only hold one of the three names the importer
    // validates, so a line tagged `shout` came back from its own PSD as
    // `dialogue` and the user's vocabulary was lost on the round trip. Written
    // only where the line really has an array, because the array's *presence* is
    // what tells `lineTags` the user has taken over from the legacy `type` -
    // materialising `[]` for every line would read as the user having
    // deliberately cleared every tag in the chapter.
    lines: (p.lines ?? []).map((l) => ({
      n: l.n,
      type: l.type,
      jp: l.jp ?? '',
      en: l.en ?? '',
      ...(Array.isArray(l.tags) ? { tags: l.tags.slice() } : null),
    })),
    boxes: (p.boxes ?? []).map((b) => ({
      lineN: b.lineN,
      text: b.text ?? null,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      style: JSON.parse(JSON.stringify(b.style)),
      // The balloon this box was fitted to. It has to be here or a PSD round
      // trip loses the box's shape and the text re-flows to a plain rectangle on
      // re-import - the pixels would still show the shaped block while the
      // editable layers disagreed with them. Through `normalizeFit` on the way
      // out as well as on the way in, so a shape a future build wrote is
      // recorded as "no fit" rather than carried through as something this one
      // cannot lay out to; and always present, so `serializePage` of a page and
      // of the page rebuilt from it are the same JSON, which is what
      // `psdSelfTest` compares.
      fit: normalizeFit(b.fit),
      // The solver's record (FIT-5): the size the user chose and what is
      // locked. Lost here, a re-imported box would be solved from the size it
      // was shrunk to and ratchet smaller. Null for a box the solver never
      // managed, and always present, for the same reason `fit` is.
      auto: normalizeAuto(b.auto),
    })),
    detect: p.detect
      ? {
          panels: (p.detect.panels ?? []).slice(),
          boxes: (p.detect.boxes ?? []).map((d) => ({ n: d.n, box: d.box, vertical: d.vertical, font_size: d.font_size })),
        }
      : null,
    hasRaw: !!p.raw,
    hasCleaned: !!p.cleaned,
  };
}

// ---------------------------------------------------------------------------
// style → PSD text/effects mapping (best-effort; JSON carries the exact truth)
// ---------------------------------------------------------------------------

const JUSTIFY = { left: 'left', center: 'center', right: 'right' };

// Float noise in a type layer's frame, which rounding the frame up must not
// turn into a whole pixel: five lines of 1.1 x 14 are 77.00000000000001, and
// a content width of 116 can arrive as 116.00000000000003.
const FRAME_EPS = 1e-6;

// Page-scoped text resolver (store.boxText() reads the *current* page, wrong
// during an export-all of another page).
function boxTextFor(p, box) {
  if (box.text != null) return box.text;
  const ln = (p.lines ?? []).find((l) => l.n === box.lineN);
  if (!ln) return '';
  return ln.en ?? ln.natural ?? ln.stylised ?? ln.text ?? '';
}

// A CSS family list like "'Bangers', cursive" → a plausible PostScript name.
// Fonts substitute in Photoshop anyway; the embedded JSON keeps the exact
// family for lossless re-import.
function postScriptName(family) {
  const css = fontCssFor(family) || family || '';
  const first = String(css).split(',')[0].replace(/['"]/g, '').trim();
  return first.replace(/\s+/g, '') || 'MyriadPro-Regular';
}

// The face a text layer asks Photoshop for, and whether Photoshop is being told
// to synthesise it.
//
// Faux styling is what a scanlator is trying to avoid: a font's real bold is a
// drawn weight, and Photoshop's fauxBold is the regular outline smeared wider.
// The app now knows which faces a family really has (fonts.js registers each
// file under the same family with its own weight/style descriptors), so a box
// set to bold on a family that owns a bold file must reach Photoshop as the
// bold FACE - PostScript names are per-face, "MangaTemple-Bold" and not
// "MangaTemple" - with the faux flag off. Only a face nobody has a file for
// keeps the flag on, because there the renderer here is synthesising it too and
// the flag is the honest description of what the pixels already show.
//
// We prefer the real PostScript name parsed from the font bytes (nameID 6 in
// the sfnt name table) so Photoshop can match installed font files whose
// internal PostScript names differ from simple family concatenations (e.g.
// "Arial-BoldMT", "CCWildWords-Regular", "AnimeAce2BB-Italic"). For a known
// real face, we use that slot's parsed PostScript name. When the face is unknown
// (faux synthesis), we use the regular face's parsed PostScript name alongside
// the faux flags. We fall back to the constructed family name plus slot suffix
// only when no parsed name exists (such as built-in CSS fallbacks or fonts never
// registered from a file).
//
// Both halves are asked about the SAME family - `fontNameFor` - and not about
// `s.font`: a document can name a font this machine has not got, in which case
// the canvas already drew the fallback family, and asking one half about the
// name in the document and the other about the family on screen produced a
// layer describing a font nobody rendered.
//
// `resolveFace` answers per axis (see fonts.js), so the two flags below can
// disagree with each other - a bold-italic box on a family with a real bold and
// no italics is exactly that case, and it is the case this app makes most.
export function fontRequestFor(s) {
  const family = fontNameFor(s.font);
  const face = resolveFace(family, s);
  const parsed = face.known
    ? postScriptNameFor(family, face.slot)
    : postScriptNameFor(family, 'regular');
  if (parsed) {
    return { name: parsed, fauxBold: face.fauxBold, fauxItalic: face.fauxItalic };
  }
  const base = postScriptName(family);
  const suffix = face.known
    ? { regular: '', bold: '-Bold', italic: '-Italic', boldItalic: '-BoldItalic' }[face.slot]
    : '';
  return { name: base + suffix, fauxBold: face.fauxBold, fauxItalic: face.fauxItalic };
}

function warpForCurve(curve) {
  if (!curve) return { style: 'none' };
  // our curve is -100..100 (negative = frown); PS arc value is -100..100 too.
  return { style: 'arc', value: Math.max(-100, Math.min(100, curve)), perspective: 0, perspectiveOther: 0, rotate: 'horizontal' };
}

// A gradient Photoshop can restate as a real `gradientOverlay` layer effect,
// which is the linear ramp across the whole block and nothing else.
//
//   scope 'line' restarts the ramp on every wrapped line (see paintBox's
//   `perLine`). One overlay covers one layer, so there is no list of effects
//   that says "and again, per line".
//   kind 'radial' reads cx/cy/radius against the fill rect's farthest corner
//   (see text-paint.js). Photoshop's radial overlay is parameterised by an
//   offset and a scale percentage against its own reference, which is not the
//   same construction, so a mapping would be a guess dressed as a value.
//
// Used twice, deliberately: by `isRasterOnly` to decide the layer even gets a
// live `text` object, and by the effects builder to decide it emits the
// overlay. One rule, so the two can never disagree about the same style.
function gradientOverlayable(g) {
  return !!g && g.scope !== 'line' && (g.kind ?? 'linear') === 'linear';
}

// True when a box's style is something Photoshop's own text engine cannot
// reproduce, so the layer it gets has to carry pixels instead of a live
// `text` object.
//
// The reason this predicate has to exist at all: Photoshop ALWAYS re-renders a
// live type layer from its own engine data and throws the cached `imageData`
// away. So "we baked it into the pixels" is not a fallback for a live type
// layer - it is only a fallback for readers that are not Photoshop. Anything
// the type layer cannot state is either painted wrong (a different shape over
// our pixels) or silently dropped (our effect gone), and both are the export
// lying about what the app shows. Dropping `text` makes Photoshop treat the
// layer as a plain image and show exactly the bytes we hand it.
//
// Geometry - Photoshop would lay the glyphs out somewhere else:
//   curve   - our per-character circular-arc layout (arcLayout in measure.js)
//             is not the same shape as Photoshop's `arc` warp. Attaching the
//             warp anyway made Photoshop re-render the glyphs along ITS arc,
//             on open, over the cached pixels that were laid out along ours.
//   path    - text on the user's bezier (pathLayout), placed by arc length
//             with a per-glyph tangent. A type layer has no path to follow, so
//             Photoshop re-renders it as a straight paragraph in the box rect.
//   circle  - the closed ring (circleLayout). Same failure as `path`.
//   flip    - the mirror is baked into the pixels (paintBoxOnPage's ctx.scale
//             in exporter.js), but a type layer's transform below is
//             [cos, sin, -sin, cos, tx, ty], which has determinant +1 and so
//             cannot express a reflection at all. Left as a type layer, a
//             mirrored box re-rendered the right way round over the mirrored
//             pixels - the same failure as the curve, for the same reason.
//
// Ink - Photoshop would lay the glyphs out right and then paint them wrong:
//   roughen  - a seeded pixel-displacement filter (roughen() in exporter.js)
//              with nothing in Photoshop's type engine that produces it at
//              all; there is no warp/style value that could stand in for it.
//   clip     - the visibility mask hides part of the box's ink. A re-render
//              has no mask, so Photoshop shows the letters the user erased.
//              Only counted when the mask actually has shapes - `clipActive`
//              is the one statement of that, shared with both renderers.
//   blur     - a gaussian over the finished composite (fill + strokes +
//              shadows together). Photoshop's type effects blur each effect on
//              its own track; there is no whole-layer blur to ask for.
//   motion   - the directional smear, likewise, and only when it has a
//              direction to smear along (0,0 draws nothing - see
//              motionBlurExtent).
//   pattern  - a tiled fill. Photoshop's patternOverlay takes a pattern from
//              the document's pattern table, not a tile we can hand it here,
//              and a type layer's own fill is one flat colour.
//   gradient - only the shapes `gradientOverlayable` accepts survive; the rest
//              would come out as a flat `fillColor`.
//
// A raster-only box still round-trips losslessly through this app - the
// embedded project JSON (see buildPagePsd) is what re-import actually reads -
// so this predicate only ever affects what a foreign copy of Photoshop shows.
// The cost of saying yes here is editability in Photoshop, and it is only paid
// by a box that switched one of these on; the ordinary box (strokes, shadows,
// a block gradient) is untouched and stays live type.
//
// Single place this decision is made; exported so it can be unit-tested from
// node without a canvas.
export function isRasterOnly(style) {
  if (!style) return false;
  const s = style;
  const mb = s.motionBlur;
  return !!(
    // geometry
    s.curve ||
    (s.path?.on && (s.path.pts?.length ?? 0) >= 2) ||
    s.circle?.on ||
    s.flipH ||
    s.flipV ||
    // The mesh warp. A type layer's transform is a rotation and a translation;
    // it has no room for a quad, let alone a grid of them, so Photoshop would
    // re-render the glyphs straight over the deformed pixels - the same failure
    // the curve and the mirror have, for the same reason. Asked without the box,
    // so a mesh switched on and fully stated counts (see warpActive).
    warpActive(s) ||
    // ink
    s.roughen?.on ||
    clipActive(s.clip) ||
    // Hand-drawn strokes are not something Photoshop's type engine can
    // re-render, so a box carrying them ships as pixels or loses them.
    inkActive(s.ink) ||
    (s.blur ?? 0) > 0 ||
    (mb?.on && ((mb.x ?? 0) !== 0 || (mb.y ?? 0) !== 0)) ||
    s.pattern?.on ||
    (s.gradient?.on && !gradientOverlayable(s.gradient))
  );
}

// Written onto a raster-only layer's name and read back off it by the foreign
// importer. A layer with no `text` object carries no text anywhere else, so
// without this the box and its words vanish on the one import path that has no
// embedded project to read (see reconstructForeign).
export const RASTER_MARK = ' [raster, not editable in Photoshop]';

// Written onto the layer name of a box whose text the app could not fit inside
// it (`reviewOf` in the store: `box.review`, see contain.js, or the solver's), so the person opening the PSD sees which
// boxes were left for them to decide about - the same flag the editor shows,
// carried to the one place a Photoshop user looks. On a raster layer it goes
// BEFORE the raster marker, which has to stay last for the importer to find it,
// and the importer takes it back off before the name becomes the box's text.
export const REVIEW_MARK = ' [needs review]';

// Build one layer for a box. The common case is a live, editable Photoshop
// type layer backed by the box's exact pixels (`rendered`, from
// renderBoxLayer) as its cached rasterization, so it displays pixel-identical
// to the app even when the manga font is missing in Photoshop, while
// remaining editable (the `text` object below). For a raster-only box (see
// isRasterOnly) there is no `text` object at all: Photoshop always re-renders
// a type layer from its own engine data and ignores the cached pixels, so a
// curved or roughened box came back as a corrupted blob - Photoshop's
// re-render of a shape our engine never produced, painted over the correct
// pixels underneath it. Dropping `text` makes Photoshop treat the layer as a
// plain image instead, and it just shows the bytes we hand it.
//
// Exported for psd.test.js alongside isRasterOnly: this function is where the
// predicate actually turns into "no `text` key", and unlike buildPagePsd's
// other DOM-bound helpers it touches no canvas - `rendered` is handed in
// pre-computed - so the decision is reachable from node without one.
export function textLayerFor(p, box, rendered) {
  const s = box.style;
  const raw = boxTextFor(p, box);
  const flag = reviewOf(box, p) ? REVIEW_MARK : '';

  if (isRasterOnly(s)) {
    // If the box paints no pixels (e.g. empty or whitespace-only text),
    // renderBoxLayer returns null. A layer with no imageData and no text object
    // causes ag-psd to crash during channel serialization. Safest guard:
    // skip emitting an image layer when there is no raster data.
    if (!rendered || !rendered.imageData) return null;

    // Marked in the layer name - rather than left silent - so a user opening
    // this PSD in Photoshop understands why this one layer doesn't behave
    // like the others (no type tool, no re-render on font change) instead of
    // reading it as a bug in the export. The marker is also what the foreign
    // importer recognises these layers by, so it is a shared constant and not
    // a string spelled out twice.
    //
    // Raster-only layers get no layer effects: because there is no `text`
    // object, Photoshop treats this as a plain image layer and renders the
    // cached pixels directly. Those pixels already have the outline and shadow
    // baked in by paintBox, so adding layer effects here would cause Photoshop
    // to double them over the rendered bitmap.
    const bounds = { left: rendered.left, top: rendered.top, right: rendered.right, bottom: rendered.bottom };
    const name = (raw || `line ${box.lineN ?? '·'}`).slice(0, 40);

    return {
      name: `${name}${flag}${RASTER_MARK}`,
      ...bounds,
      imageData: rendered.imageData,
      opacity: s.opacity ?? 1,
      blendMode: 'normal',
    };
  }

  // Layer bounds follow the cached raster (already trimmed to the glyphs, so a
  // text layer costs its own ink and not a page) when present, else the box rect.
  const bounds = rendered
    ? { left: rendered.left, top: rendered.top, right: rendered.right, bottom: rendered.bottom }
    : {
        left: Math.round(box.x),
        top: Math.round(box.y),
        right: Math.round(box.x + box.w),
        bottom: Math.round(box.y + box.h),
      };
  const name = (raw || `line ${box.lineN ?? '·'}`).slice(0, 40);

  // The line breaks the app decided, written into the type layer as hard
  // returns rather than left for Photoshop to find.
  //
  // A `shapeType:'box'` type layer re-flows its paragraph greedily inside
  // `boxBounds`, which was harmless while this app wrapped greedily too and
  // stopped being harmless the moment it started shaping blocks (see
  // typeset.js: square or beehive, never an hourglass, no short word alone on a
  // line). Left as one paragraph, a box the canvas shows as three shaped lines
  // re-wraps to Photoshop's own three the first time the layer re-renders - a
  // font substitution, or the user so much as touching it with the type tool -
  // and the typesetting the letterer did is gone. The cached pixels carry the
  // shaped breaks, but they are exactly what a re-render discards.
  //
  // Placed by `placeBlock` (contain.js) - the lines, the block's height and its
  // top - which is the statement the raster exporter paints from and the
  // containment check measures, and which breaks through `layoutLines` with the
  // editor's own arguments (the content width, the balloon the box was fitted
  // to), so all of them agree by construction. It needs a canvas to measure
  // with; without one (the node test environment) the paragraph goes in
  // unbroken, as it always did.
  const place = canMeasure() ? placeBlock(boxCandidate(box, raw)) : null;
  const content = place ? place.lines.join('\n') : applyCase(raw, s);
  const rot = ((s.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  // Rotate the box's CONTENT origin about the box center (pivot matches
  // exporter.js). The document is the page's own pixel grid, so box geometry
  // goes in as-is and live (font-present) re-rendering lands exactly on the
  // cached pixels.
  //
  // The content origin, not the box origin: the editor's `.tbox` is padded by
  // `textInset` - the padding plus the outline's reach (measure.js) - and lays
  // its lines out inside that content box, and the raster exporter anchors the
  // block the same inset in from every edge. A type layer flush with the box
  // rect would put Photoshop's own re-render that far left of and above the
  // pixels underneath it for a left- or top-aligned box - invisible until the
  // layer re-renders, and then a jump. `boxBounds` loses the inset on both
  // sides for the same reason: it is the frame the lines are broken and aligned
  // in, so it has to be the content box, not the box. The importer below undoes
  // exactly this inset, reading the outline back off the layer's effects.
  //
  // Vertically the origin is the BLOCK's top, not the box's. Photoshop flows
  // paragraph text from the top of `boxBounds` and has no notion of our
  // `valign`, so a middle- or bottom-aligned box anchored at the content top
  // described text at the top of the frame while the cached pixels underneath
  // showed it centred or sitting on the floor. The file looked right until the
  // layer re-rendered - a font substitution, or the type tool - and then the
  // words jumped up by half the slack. `valign` defaults to 'middle', so that
  // was nearly every box.
  //
  // The block's top is `placeBlock`'s - the exporter's own rule, with the same
  // ink-centring the exporter and the editor apply, so the anchor describes the
  // block the cached pixels actually show. Without a measurer the block is
  // sized off the line count, which is all an unbroken paragraph has.
  //
  // The frame is whole pixels, rounded UP (OVF-10). Photoshop reflows a line
  // wider than the frame and hides a line that falls below it, so a frame
  // rounded down - `Math.round` - by a fraction of a pixel could re-break the
  // widest line of a block that fills its content box, or push the last line
  // out of sight, the first time the layer re-rendered. Rounded up, the frame
  // holds the block the app broke. The fraction it gains goes on the side the
  // text is not aligned to - the anchor moves left by all of it for
  // right-aligned text and by half for centred - so the edge Photoshop aligns
  // each line to is the one the canvas aligned it to, and the anchor stays
  // inside the box (the inset is at least BOX_PAD, and the fraction is under a
  // pixel). Vertically nothing moves: Photoshop flows from the frame's top, and
  // the extra fraction is below the last line. The top itself stays the
  // block's even when that is above the box - line boxes taller than the box -
  // because that is where the cached pixels show the text; moving it inside
  // would make the first re-render jump.
  const lineH = (s.lineHeight || 1.1) * s.size;
  const blockH = place ? place.blockH : content.split('\n').length * lineH;
  const blockY = place ? place.blockY : blockYFor(s, box.h, blockH, 0);
  const frameW = Math.ceil(contentWidth(box.w, s) - FRAME_EPS);
  const frameH = Math.ceil(blockH - FRAME_EPS);
  const gain = Math.max(0, frameW - contentWidth(box.w, s));
  const ox = box.x + textInset(s) - (s.align === 'right' ? gain : s.align === 'left' ? 0 : gain / 2);
  const oy = box.y + blockY;
  const tx = cx + (ox - cx) * cos - (oy - cy) * sin;
  const ty = cy + (ox - cx) * sin + (oy - cy) * cos;
  const fontSize = s.size;
  const tracking = s.size > 0 ? Math.round(((s.letterSpacing || 0) / s.size) * 1000) : 0;
  const face = fontRequestFor(s);

  // Photoshop type layers require real layer effects for stroke and drop shadow.
  // Photoshop always re-renders a live type layer from its internal engine data
  // and completely ignores the cached pixels in `imageData`. Without layer
  // effects, opening the PSD in Photoshop with the font installed shows bare
  // text lacking both outline and shadow.
  //
  // Stroke position: the canvas draws each stroke centred on the glyph outline
  // at twice the sum of every visible width up to and including it, and lets the
  // strokes inside it (and the fill) cover the half that fell within the glyph -
  // see text-paint.js. So the SIZE Photoshop needs for an 'outside' stroke is
  // that cumulative sum, which is what `strokeBands` already carries: the outer
  // edge of band i. Photoshop paints its effects list in order, so the list goes
  // in outermost first, exactly as the canvas paints it.
  //
  // Drop shadow: canvas uses Cartesian pixel offsets (x, y) where positive y is
  // downward. Photoshop represents a shadow by a light source angle in degrees
  // (measured counter-clockwise from the +x axis) and a distance in pixels, with
  // the shadow cast AWAY from the light source. A light source at angle θ in
  // Photoshop casts a shadow at vector (-distance * cos(θ), distance * sin(θ)).
  // Converting canvas (x, y) gives distance = hypot(x, y) and angle = atan2(y, -x).
  //
  // Everything Photoshop's type engine cannot state - the pattern fill, the
  // whole-text blur, the smear, the mask, a per-line or radial gradient - is
  // not here: `isRasterOnly` sent that box down the raster branch above, so by
  // this line the only fill left to describe is a linear block gradient.
  const effects = {};
  const bands = strokeBands(s.strokes);
  if (bands.length) {
    effects.stroke = bands.map((band) => ({
      enabled: true,
      size: { units: 'Pixels', value: band.line / 2 },
      position: 'outside',
      fillType: 'color',
      color: hexToRgb(band.color),
      opacity: band.opacity,
    }));
  }
  if ((s.shadows ?? []).length) {
    effects.dropShadow = s.shadows.map((sh) => {
      const dist = Math.hypot(sh.x || 0, sh.y || 0);
      return {
        enabled: true,
        size: { units: 'Pixels', value: sh.blur || 0 },
        distance: { units: 'Pixels', value: dist },
        angle: (Math.atan2(sh.y || 0, -(sh.x || 0)) * 180) / Math.PI,
        color: hexToRgb(sh.color),
        opacity: sh.opacity ?? 1,
        useGlobalLight: false,
      };
    });
  }
  // A whole-block gradient is the one fill Photoshop can state itself. Its angle
  // is the direction the gradient travels, counter-clockwise from the +x axis
  // with y pointing UP, while the style stores CSS degrees clockwise from "up" -
  // so 90 minus it. Stop positions are 0..1 either way.
  if (s.gradient?.on && gradientOverlayable(s.gradient)) {
    effects.gradientOverlay = [
      {
        enabled: true,
        opacity: 1,
        angle: 90 - (Number(s.gradient.angle) || 0),
        type: 'linear',
        gradient: {
          name: 'Custom',
          type: 'solid',
          colorStops: s.gradient.stops.map((st) => ({
            color: hexToRgb(st.color),
            location: Math.min(1, Math.max(0, st.pos)),
            midpoint: 50,
          })),
          // Photoshop keeps a gradient's alpha on its own track, so a stop's
          // colour and its opacity are written twice at the same location
          // rather than once as an rgba.
          opacityStops: s.gradient.stops.map((st) => ({
            opacity: Math.min(1, Math.max(0, Number.isFinite(+st?.opacity) ? +st.opacity : 1)),
            location: Math.min(1, Math.max(0, st.pos)),
            midpoint: 50,
          })),
        },
      },
    ];
  }
  const hasEffects = Boolean(effects.stroke || effects.dropShadow || effects.gradientOverlay);

  return {
    name: `${name}${flag}`,
    ...bounds,
    imageData: rendered ? rendered.imageData : undefined,
    opacity: s.opacity ?? 1,
    blendMode: 'normal',
    ...(hasEffects ? { effects } : null),
    // The cached pixels keep the outline and shadow baked in for non-Photoshop
    // readers and fallback viewing when the font is not installed. curve is 0
    // here (a non-zero curve routes through the raster-only branch above), so
    // warpForCurve always returns the 'none' style - it stays as a real call
    // rather than an inlined constant so nothing has to change if a future
    // curve shape turns out to be representable after all.
    text: {
      text: content,
      orientation: 'horizontal',
      transform: [cos, sin, -sin, cos, tx, ty],
      antiAlias: 'smooth',
      warp: warpForCurve(s.curve),
      shapeType: 'box',
      // The block's own rect, measured from the origin above. Width is the
      // content box, because that is what the app breaks its lines to and
      // Photoshop reflows at; height is the block rather than the rest of the
      // frame, so the box Photoshop draws in is the box the app drew.
      boxBounds: [0, 0, frameW, frameH],
      style: {
        font: { name: face.name },
        fontSize,
        fauxBold: face.fauxBold,
        fauxItalic: face.fauxItalic,
        autoLeading: false,
        leading: (s.lineHeight || 1.1) * fontSize,
        tracking,
        fillColor: hexToRgb(s.color),
        fontCaps: s.uppercase ? 2 : 0,
        // Photoshop's type style carries ONE stroke colour; the innermost stroke
        // is the one that sits against the glyph, so it is the one to name.
        // (`bands` is outermost-first - see strokeBands.)
        strokeColor: hexToRgb(s.strokes?.[0]?.color ?? s.color),
      },
      paragraphStyle: { justification: JUSTIFY[s.align] || 'center' },
      // A flush line in a balloon starts at its row's edge, not the frame's
      // (`lineIndents`). Every line is its own paragraph here - the breaks go in
      // as hard returns - so each one carries its indent from the edge it is
      // aligned to, and Photoshop sets it where the cached pixels show it. The
      // frame is the content box rounded up on the side the text is not aligned
      // to, so the aligned edge the indent is measured from is the canvas's.
      // Omitted when no line is set in, which is every box that is not flush
      // text in a balloon.
      ...(place?.indents
        ? {
            paragraphStyleRuns: place.lines.map((ln, i) => ({
              length: ln.length + 1,
              style: { [s.align === 'right' ? 'endIndent' : 'startIndent']: place.indents[i] },
            })),
          }
        : null),
    },
  };
}

// ---------------------------------------------------------------------------
// export: page → PSD bytes
// ---------------------------------------------------------------------------

// The merged composite, flat white, full page. It is not a preview of anything
// and it is not optional.
//
// Photoshop rebuilds the composite from the layers on open and never reads
// this. macOS does the exact opposite: ImageIO - Finder icons, Preview, Quick
// Look, `sips` - reads ONLY the merged image, and it ignores image resource
// 1036 (the thumbnail) entirely, so with no composite every export renders as a
// solid black page outside Photoshop. Measured here: `qlmanage -t -s 400` on a
// file with a white composite gave a white thumbnail, and on the identical file
// without one gave solid black.
//
// White rather than the real page render because the real one costs a whole
// extra full-page raster of pixels the layers already carry - measured at
// +2,643,180 bytes on an 800x1150 page, the same delta under RLE and under ZIP
// - and the user's decision was that the merged composite stays out. A
// constant-value raster, by contrast, is free: ag-psd emits the composite
// section whether or not it is handed one, and a run-length code spends the
// same bytes on a run of 255s as on the run of 0s it would otherwise write.
// Measured on that same page: 5,490,174 bytes with a white composite, with an
// all-black one, and with none at all - byte-identical, all three.
//
// White and not black because a manga page is white paper: the file reads in
// Finder as a blank sheet, which is what a file whose picture lives in its
// layers should look like, rather than as an error.
function flatWhiteComposite(w, h) {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
}

// Assemble the ag-psd document from rasters the DOM half below has already
// produced. Split out because everything that decides how big the file gets is
// decided here - which layers exist, how big each one is, what the merged
// composite costs - and buildPagePsd needs a canvas per raster, so with the
// decisions in there a test could only reach them on a page with no art at all.
//
// No thumbnail image resource. There used to be a hand-built 160px one, ~15 KB
// plus a full extra renderPageCanvas pass per page, justified by a comment
// claiming it was what made the file "look like the page" in Finder. That was
// false - macOS never reads it, see above - and no reader we can name and test
// on this machine reads it either (Adobe Bridge is the usual claim; unverified
// here). Removed rather than kept on a story.
// LAYER ORDER: `children[0]` is the BOTTOM layer, and the last entry is the top
// one. This is ag-psd's order and the file's own - a PSD stores its layer
// records bottom-first, ag-psd's writer emits `children` in array order and its
// reader `unshift`es them back while walking the file from the top, so both
// halves agree. It is the opposite of how a layers palette reads, which is what
// made it easy to get backwards: this file used to build `[Text, Base]` and
// describe it as "top of list = top in Photoshop", which put the page art on
// top of every text layer. The export opened as bare, untypeset artwork - and
// nothing noticed, because this app re-imports from the embedded JSON and never
// composites the layers it wrote. Verified by compositing a written file with
// an independent reader (psd-tools) and diffing it against renderPageCanvas;
// `psdSelfTest` now pins the order so it cannot flip back silently.
export function pagePsdDocument({ w, h, textLayers = [], baseLayers = [], project }) {
  const children = [];
  if (baseLayers.length) children.push({ name: 'Base', opened: true, children: baseLayers });
  children.push({ name: 'Text', opened: true, children: (textLayers ?? []).filter(Boolean) });
  return {
    width: w,
    height: h,
    colorMode: 3, // RGB
    bitsPerChannel: 8,
    children,
    imageData: flatWhiteComposite(w, h),
    imageResources: {
      // 72 PPI, i.e. no scaling claim at all: the document is the page's own
      // pixel grid, and a pixel is a pixel. It was 144 when the document was
      // supersampled 2x, to keep the printed size constant across that.
      resolutionInfo: {
        horizontalResolution: 72,
        horizontalResolutionUnit: 'PPI',
        widthUnit: 'Inches',
        verticalResolution: 72,
        verticalResolutionUnit: 'PPI',
        heightUnit: 'Inches',
      },
      xmpMetadata: wrapXmp(JSON.stringify(project)),
    },
  };
}

// Serialize a document built above, with ag-psd's default RLE channel data.
//
// `compress: true` (ZIP/deflate) was tried and reverted. It is a real 52% size
// win - 2.52 MB vs 5.24 MB on an 800x1150 two-raster page - but it costs 638-642
// ms per page against RLE's 21-24 ms, near thirty times slower, and exportImages
// awaits this per page in a plain loop on the webview's main thread: a 20-page
// chapter froze the UI for about twelve seconds with no way to tell it apart
// from a hang. RLE keeps most of the win that mattered anyway - the size fight
// was against a 39.94 MB per-page baseline, and dropping the supersampled
// document and the duplicated full-page rasters is what won it. Do not turn ZIP
// back on without moving the export loop off the main thread first.
export function writePagePsd(doc) {
  const psb = doc.width > PSD_MAX || doc.height > PSD_MAX;
  return writePsd(doc, { noBackground: true, psb });
}

// Build a layered, editable PSD (ArrayBuffer) for one page, with the complete
// project embedded as JSON for lossless re-import. Group/layer schema, written
// bottom-first because that is the order the file stores (see
// pagePsdDocument) - so this list reads upwards, the reverse of a layers
// palette:
//   Base  - Raw, with Cleaned (if any) over it
//   Text  - one editable text layer per box, on top of the art
//
// The document is the page's OWN pixel size. It used to be supersampled 2x so
// the text layers' cached pixels stayed sharp when zoomed; the cost was that
// Raw and Cleaned were upscaled 2x as well - 4x the pixels, invented ones, for
// art that has no detail up there to find - which put each of them in the file
// at ~4.4x what it costs stored natively. A PSD layer cannot carry its own
// scale, so a native-resolution base raster and a supersampled document are
// mutually exclusive, and base art is what the size is being spent on, so the
// document follows the base art.
//
// The text pays for that, and the amount is exactly half its linear resolution.
// renderBox builds a box at SS=2 and paintBoxOnPage's drawImage lands it at the
// box's native footprint, so at the old scale 2 that bitmap mapped 1:1 onto
// document pixels and now it is downsampled 2:1 - cleanly antialiased, but one
// device pixel per page pixel where there were two. It only shows in the case
// the cached raster exists for at all: Photoshop missing the manga font and
// falling back to these pixels instead of re-rendering the (still editable)
// type layer, and then only above 100% zoom. With the font installed nothing is
// lost, because Photoshop redraws the type vector-sharp at any zoom.
export async function buildPagePsd(p) {
  await document.fonts.ready;
  const { w: W, h: H } = await pageSpace(p);
  // A roughened box's pixels are displaced against a phase measured from the
  // running browser, and measuring it is a rasterisation - so it is settled
  // before any box is rendered, exactly as the raster export settles it.
  await settleNoise(p?.boxes);
  // An inked box ships as a flat raster layer rendered by `renderBoxLayer`, so
  // the PSD needs the same decoded tips the raster export does, prefetched the
  // same way and for the same reason: the painter is synchronous.
  const tips = await settleBoxTips(p?.boxes);

  // Text layers - one editable type layer per box, each backed by the box's
  // exact pixels, trimmed by renderBoxLayer to the glyphs it actually painted
  // (a shared scratch canvas avoids per-box allocations).
  // Boxes with raster-only styling that paint nothing return null from textLayerFor
  // and are filtered out so ag-psd does not receive an image layer missing image data.
  const scratch = document.createElement('canvas');
  const textLayers = (p.boxes ?? [])
    .map((b) => textLayerFor(p, b, renderBoxLayer(b, W, H, scratch, p, 1, tips)))
    .filter(Boolean);

  // Base layers - Cleaned over Raw (bottom), both forced to the document's (=
  // the page's) size, which is a resample rather than a copy whenever the two
  // disagree. Forcing it is the right trade - the box coordinates are in the
  // page's space and the art has to line up with them - but it is worth knowing
  // when it can happen, and there is now exactly one case left.
  //
  // It used to be routine: applyDetection wrote the detector's
  // img_width/img_height straight over p.w/p.h, so any page whose cleaned
  // raster was not the same size as its raw exported through a resample, on
  // every export, silently. The store now maps the detector's geometry into the
  // page's space instead of adopting its size (see applyDetection), and the
  // page's space is measured from the image the canvas actually draws (see
  // setPageDims), so `p.cleaned` - the one this export prefers - matches the
  // document by construction.
  //
  // What remains: a chapter that has BOTH rasters at different resolutions. The
  // page is measured from `cleaned`, so `Raw` is the layer that gets resampled
  // here. Nothing in the app produces that pair, and a page that carries it has
  // no single honest size to export at anyway.
  // Raw first, Cleaned second: `children[0]` is the BOTTOM layer (see
  // pagePsdDocument), so pushing Cleaned first put the untouched art back on
  // top of the cleaned plate and hid the cleaning.
  const baseLayers = [];
  if (p.raw) {
    try {
      const data = await imageDataFromSrc(p.raw, W, H);
      baseLayers.push({ name: 'Raw', left: 0, top: 0, right: data.width, bottom: data.height, imageData: data });
    } catch {
      /* skip */
    }
  }
  if (p.cleaned) {
    try {
      const data = await imageDataFromSrc(p.cleaned, W, H);
      baseLayers.push({ name: 'Cleaned', left: 0, top: 0, right: data.width, bottom: data.height, imageData: data });
    } catch {
      /* skip */
    }
  }

  // Embedded lossless project state - ORIGINAL page coordinates.
  const project = { key: PROJECT_KEY, schema: SCHEMA, page: serializePage(p) };

  return writePagePsd(pagePsdDocument({ w: W, h: H, textLayers, baseLayers, project }));
}

// ---------------------------------------------------------------------------
// import: PSD bytes → page
// ---------------------------------------------------------------------------

// Find a layer by name within a named group (case-insensitive).
function findInGroup(psd, groupName, layerName) {
  const grp = (psd.children ?? []).find((c) => c.children && c.name === groupName);
  if (!grp) return null;
  return grp.children.find((l) => l.name === layerName) || null;
}

function revokeAll(...urls) {
  for (const u of new Set(urls.filter(Boolean))) URL.revokeObjectURL(u);
}

async function layerToUrl(layer) {
  if (!layer) return null;
  if (layer.canvas) return canvasToObjectUrl(layer.canvas);
  if (layer.imageData) return canvasToObjectUrl(imageDataToCanvas(layer.imageData));
  return null;
}

// Rebuild a full page object from the embedded project JSON (lossless path).
// Object URLs for raw/cleaned are regenerated from the PSD base rasters.
async function reconstructFromProject(project, psd) {
  const sp = project.page;
  const page = {
    id: sp.id,
    raw: null,
    cleaned: null,
    w: sp.w,
    h: sp.h,
    lines: (sp.lines ?? []).map((l) => ({ ...l })),
    boxes: (sp.boxes ?? []).map((b) => ({ ...b, style: { ...b.style } })),
    detect: sp.detect
      ? { panels: (sp.detect.panels ?? []).slice(), boxes: (sp.detect.boxes ?? []).map((d) => ({ ...d })) }
      : null,
  };
  try {
    if (sp.hasRaw) page.raw = await layerToUrl(findInGroup(psd, 'Base', 'Raw'));
    if (sp.hasCleaned) page.cleaned = await layerToUrl(findInGroup(psd, 'Base', 'Cleaned'));
  } catch (e) {
    // A URL minted before the failure has no owner to revoke it, and it holds a
    // whole page raster alive for as long as the app runs.
    revokeAll(page.raw, page.cleaned);
    throw e;
  }
  return page;
}

// The outline, back off a type layer's stroke effects: the inverse of the
// writer's `effects.stroke` in `textLayerFor`. The writer states each band as an
// OUTSIDE stroke whose size is the band's outer edge - the cumulative width -
// so the visible widths are the steps between consecutive sizes, innermost
// first as the style keeps them. Another tool's centred stroke reaches half its
// size past the glyph and an inside one none, which is all of either the app
// can draw. A layer with no stroke effect has no outline, and the box gets none
// rather than the app's default: the layer's frame was not laid out with the
// default's inset, so the box recovered from it could not be either.
function strokesFromEffects(list) {
  const bands = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || e.enabled === false) continue;
    const size = Number(e.size?.value) || 0;
    const reach = e.position === 'inside' ? 0 : e.position === 'center' ? size / 2 : size;
    if (!(reach > 0)) continue;
    const opacity = Number.isFinite(+e.opacity) ? Math.min(1, Math.max(0, +e.opacity)) : 1;
    bands.push({ reach, color: rgbHex(e.color), opacity });
  }
  bands.sort((a, b) => a.reach - b.reach);
  const out = [];
  let prev = 0;
  for (const k of bands) {
    if (k.reach > prev) out.push({ color: k.color, width: k.reach - prev, opacity: k.opacity });
    prev = Math.max(prev, k.reach);
  }
  return out;
}

// Best-effort reconstruction for a foreign PSD (no embedded project). Maps the
// document size, bottom raster → raw/cleaned, and any editable text layers →
// text boxes with an approximate style.
export async function reconstructForeign(psd) {
  const W = psd.width || PAGE_W;
  const H = psd.height || PAGE_H;

  // Bottom-most raster becomes the base image. Prefer a named Base/Cleaned/Raw
  // if present, else the FIRST flat pixel layer, else the composite. First,
  // not last: `children[0]` is the bottom layer (see pagePsdDocument), and
  // `walk` visits children in that same order, so a foreign PSD used to hand
  // back its topmost raster - the lettering plate, in a typeset file - as the
  // page's art.
  const flat = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.children) walk(n.children);
      else if (n.canvas || n.imageData) flat.push(n);
    }
  };
  walk(psd.children);
  const baseLayer =
    findInGroup(psd, 'Base', 'Cleaned') || findInGroup(psd, 'Base', 'Raw') || flat[0] || null;
  let cleaned = baseLayer ? await layerToUrl(baseLayer) : null;
  if (!cleaned && psd.canvas) cleaned = await canvasToObjectUrl(psd.canvas);

  // Editable text layers → boxes. Anything that throws from here on has to give
  // the raster URL back first; nothing else holds it yet.
  //
  // A layer we wrote as raster-only comes through here too, recognised by the
  // marker in its name (see RASTER_MARK): it has no `text` object to read, so
  // the name is the only place its words survive. That is lossy above 40
  // characters, which is where textLayerFor truncates a layer name, and it is
  // still better than dropping a curved or mirrored box and its text on the
  // floor. This path only runs for a PSD whose embedded project is gone -
  // Photoshop rewriting the XMP packet - since the lossless path reads the JSON
  // and never looks at layers for text at all.
  const boxes = [];
  const collectText = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.children) collectText(n.children);
      else if (!n.text && typeof n.name === 'string' && n.name.endsWith(RASTER_MARK)) {
        const left = n.left ?? 0;
        const top = n.top ?? 0;
        const named = n.name.slice(0, -RASTER_MARK.length);
        boxes.push({
          lineN: null,
          // The review marker is the app's note about the box, not its words.
          text: named.endsWith(REVIEW_MARK) ? named.slice(0, -REVIEW_MARK.length) : named,
          x: left,
          y: top,
          w: Math.max(40, (n.right ?? left + 200) - left),
          h: Math.max(24, (n.bottom ?? top + 80) - top),
          style: {},
        });
      } else if (n.text) {
        const st = n.text.style || {};
        // The outline first: the box comes back from the layer's frame by
        // undoing the content box's inset, and the inset counts the outline.
        const strokes = strokesFromEffects(n.effects?.stroke);
        const inset = textInset({ strokes });
        let x = n.left ?? 0;
        let y = n.top ?? 0;
        let w = Math.max(40, (n.right ?? x + 200) - x);
        let h = Math.max(24, (n.bottom ?? y + 80) - y);

        // When a Photoshop or foreign PSD type layer carries transform and boxBounds,
        // prefer those to recover the intended text box geometry rather than shrinking
        // the box to tight glyph ink bounds (n.left..n.right, n.top..n.bottom).
        const bb = n.text.boxBounds;
        const tf = n.text.transform;
        if (
          Array.isArray(bb) &&
          bb.length >= 4 &&
          typeof bb[0] === 'number' &&
          typeof bb[1] === 'number' &&
          typeof bb[2] === 'number' &&
          typeof bb[3] === 'number' &&
          Array.isArray(tf) &&
          tf.length >= 6 &&
          typeof tf[4] === 'number' &&
          typeof tf[5] === 'number'
        ) {
          const contentW = bb[2] - bb[0];
          const contentH = bb[3] - bb[1];
          // The inverse of the writer's frame: `boxBounds` is the content box,
          // `textInset` in from every edge of the box (see `textLayerFor`), so
          // a box this app wrote comes back the size it went out and breaks
          // where it broke.
          if (contentW > 0 && contentH > 0) {
            x = Math.round(tf[4] + bb[0] - inset);
            y = Math.round(tf[5] + bb[1] - inset);
            w = Math.max(40, Math.round(contentW + inset * 2));
            h = Math.max(24, Math.round(contentH + inset * 2));
          }
        }

        // Bold and italic used to be read straight off the faux flags, which
        // was only ever right while this app set those flags from `style.bold`
        // unconditionally. They now describe what Photoshop has to SYNTHESISE
        // (see fontRequestFor), so a box in a real bold face carries
        // `fauxBold:false` - and reading the flags alone brought every one of
        // them back unbolded. The face named in the layer is the other half of
        // the answer, and between them they cover a foreign PSD too: some
        // authoring tools set the flags, all of them name the face.
        const psName = String(st.font?.name || '');
        const faceSuffix = psName.includes('-') ? psName.slice(psName.lastIndexOf('-') + 1) : '';
        boxes.push({
          lineN: null,
          text: n.text.text ?? '',
          x,
          y,
          w,
          h,
          style: {
            size: st.fontSize || 26,
            bold: !!st.fauxBold || /bold/i.test(faceSuffix),
            italic: !!st.fauxItalic || /(italic|oblique)/i.test(faceSuffix),
            align: n.text.paragraphStyle?.justification === 'left' ? 'left' : n.text.paragraphStyle?.justification === 'right' ? 'right' : 'center',
            // Top, because `boxBounds` is where the text starts: Photoshop
            // flows a paragraph from the top of that rect, and so does the
            // writer above, which anchors the layer at the BLOCK's top rather
            // than the frame's. The box recovered here is that block plus
            // the inset, so the only vertical alignment that puts the words back
            // where the file showed them is the one that means "at the top of
            // the box". The app's own default is 'middle', and taking it here
            // would re-centre every imported box inside a box that is already
            // the size of its text - a slow drift upward on every round trip
            // through a PSD whose embedded project Photoshop has rewritten.
            valign: 'top',
            color: st.fillColor ? rgbHex(st.fillColor) : '#1a1a1a',
            strokes,
          },
        });
      }
    }
  };
  try {
    collectText(psd.children);
  } catch (e) {
    revokeAll(cleaned);
    throw e;
  }

  return {
    id: undefined,
    raw: cleaned,
    cleaned,
    w: W,
    h: H,
    lines: [],
    boxes,
    detect: null,
  };
}

// Parse PSD bytes → { project, psd, foreign }. Exposed for verification.
export function parsePagePsd(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  const psd = readPsd(buf, { skipThumbnail: false });
  const project = extractProject(psd.imageResources?.xmpMetadata);
  const supported = project && project.key === PROJECT_KEY && Math.floor(project.schema) <= SCHEMA;
  return { project: supported ? project : null, psd };
}

// ---------------------------------------------------------------------------
// import: PSD files → a whole chapter's worth of pages, ready for the library
// ---------------------------------------------------------------------------

// A PSD describes a whole typeset chapter, so it creates one rather than being
// merged into an existing one - importing into an open chapter substituted the
// document and orphaned every raw in raws/, which is why the editor no longer
// has this button at all.
//
// THIS IS THE ONE PLACE A RAW IS NOT THE USER'S ORIGINAL FILE. A PSD carries
// rasters, not the files they were made from, so pages come out of here as
// freshly encoded PNG bytes. Callers say so before importing.

const psdBytes = (url) => fetch(url).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b));

function psdPageName(index, suffix) {
  return `page-${String(index + 1).padStart(3, '0')}${suffix}.png`;
}

// A reconstructed page (blob URLs) → the byte-carrying shape the library writes.
// Returns null when the PSD yielded no raster at all: a page with no image
// would persist with an empty `file`, unrenderable and impossible to remove.
async function toChapterPage(page, index) {
  try {
    // Every page needs a raw, because `file` is what resolves a page back to an
    // image on disk. Three cases:
    //   both rasters      → raw and cleaned, as they were
    //   one flattened one → written once as the raw (a foreign PSD hands the
    //                       same URL back as both; so does a PSD whose Base
    //                       group only has a Cleaned layer)
    //   none              → not a page this app can store
    const rawUrl = page.raw ?? page.cleaned;
    if (!rawUrl) return null;
    const cleanedUrl = page.cleaned && page.cleaned !== rawUrl ? page.cleaned : null;

    return {
      // The page's only image came from a Cleaned layer, so what lands in raws/
      // is text-erased art. Counted and stated by the caller: detection would
      // find nothing on it, and that should not look like a broken detector.
      cleanedOnly: !page.raw && !!page.cleaned,
      rawName: psdPageName(index, ''),
      rawBytes: await psdBytes(rawUrl),
      cleanedName: cleanedUrl ? psdPageName(index, '-cleaned') : null,
      cleanedBytes: cleanedUrl ? await psdBytes(cleanedUrl) : null,
      w: page.w ?? PAGE_W,
      h: page.h ?? PAGE_H,
      lines: (page.lines ?? []).map((l) => ({ ...l })),
      // Ids are numbered by numberBoxIds once the whole document is in hand.
      boxes: (page.boxes ?? []).map((b) => ({ ...b, style: { ...b.style } })),
      detect: page.detect ?? null,
    };
  } finally {
    revokeAll(page.raw, page.cleaned);
  }
}

// Box ids are what the undo history addresses across sessions, and a chapter
// load keeps whatever ids the record carries, so they have to be unique across
// the whole document and not merely within a page. Numbering per page would
// hand page two ids page one already owns; the loader would remint the repeats,
// and which ones it minted would depend on what else had been opened that
// session - an id that moves between sessions is exactly what the history
// cannot survive. Assigned in one sweep, after every page has been built, so a
// PSD that failed to yield an image does not leave a gap.
export function numberBoxIds(pages) {
  let seq = 1;
  for (const pg of pages) {
    for (const b of pg.boxes ?? []) b.id = `b${seq++}`;
  }
  return pages;
}

export async function chapterPagesFromPsdFiles(files) {
  const list = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const pages = [];
  const problems = [];
  let lossless = 0;
  for (const file of list) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { project, psd } = parsePagePsd(bytes);
      const page = project ? await reconstructFromProject(project, psd) : await reconstructForeign(psd);
      const built = await toChapterPage(page, pages.length);
      if (!built) {
        problems.push(`${file.name} - no page image in it`);
        continue;
      }
      pages.push(built);
      if (project) lossless++;
    } catch (e) {
      problems.push(`${file.name} - ${e?.message || e}`);
    }
  }
  numberBoxIds(pages);
  return {
    pages,
    lossless,
    foreign: pages.length - lossless,
    cleanedOnly: pages.filter((pg) => pg.cleanedOnly).length,
    problems,
  };
}

export async function pickPsdFiles() {
  // Native dialog under Tauri - a detached <input type=file> never opens in the
  // packaged app (WKWebView runOpenPanel silently fails). Browser keeps the
  // input fallback.
  if (isTauri()) {
    return pickFilesTauri({ name: 'Photoshop', extensions: ['psd', 'psb'], multiple: true });
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.psd,.psb,image/vnd.adobe.photoshop';
  input.multiple = true;
  await new Promise((resolve) => {
    input.onchange = resolve;
    input.click();
  });
  return input.files && input.files.length ? [...input.files] : null;
}

// ---------------------------------------------------------------------------
// self-test (verification) - build → parse → deep-compare the serialized page.
// Ignores volatile ids/URLs by construction (serializePage omits them). Also
// checks the stored pixels layer by layer, and PSD editability/structure.
//
// This used to be dead code, and the note here said so: nothing called it, so
// every claim it makes had gone unverified since it was written - including the
// per-layer parity rework below. It has a caller now, in the Settings modal's
// Developer group (SettingsModal.svelte), and the shape of that caller is the
// argument for keeping the function rather than deleting it:
//
//   it needs a real canvas. Base and text layers are compared against decoded
//   art and against the app's own render of each box, so this cannot run in the
//   node test environment - and psd.test.js says as much: from node it can only
//   reach an art-less, box-less page. Deleting this would leave `buildPagePsd`'s
//   base-layer and text-layer correctness covered by nothing at all.
//   it is expensive. It builds a whole PSD and parses it back. So it is a button
//   somebody presses, not something an export pays for every time.
//   it is for developers. Hence DEV-only, in the one modal a developer running
//   `npm run tauri dev` is already in.
// ---------------------------------------------------------------------------

// Pixels as they came back out of the file. `imageData` when the reader kept
// bytes, else the decoded canvas.
function layerPixels(layer) {
  if (!layer) return null;
  if (layer.imageData) return layer.imageData;
  if (layer.canvas) return layer.canvas.getContext('2d').getImageData(0, 0, layer.canvas.width, layer.canvas.height);
  return null;
}

// 255 (i.e. "no parity at all") when either side is missing or the two disagree
// about their size - a size mismatch is the loudest failure there is, and
// comparing the overlap would quietly hide it.
function maxChannelDiff(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return 255;
  let m = 0;
  for (let i = 0; i < a.data.length; i++) m = Math.max(m, Math.abs(a.data[i] - b.data[i]));
  return m;
}

export async function psdSelfTest(p) {
  const src = p ?? app.pages[app.pageIndex];
  return await withPageImages(src, async () => {
    let rebuilt = null;
    try {
      const before = serializePage(src);
      const bytes = await buildPagePsd(src);
      const { project, psd } = parsePagePsd(bytes);
      const report = { ok: true, checks: {}, diffs: [] };

      report.checks.embeddedProject = !!project;
      if (!project) {
        report.ok = false;
        return report;
      }

      // 1) Lossless round-trip: reconstruct → re-serialize → deep-equal.
      rebuilt = await reconstructFromProject(project, psd);
      const after = serializePage(rebuilt);
      const a = JSON.stringify(before);
      const b = JSON.stringify(after);
      report.checks.losslessRoundTrip = a === b;
      if (a !== b) {
        report.ok = false;
        // surface the first divergence for debugging
        for (const k of Object.keys(before)) {
          if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) report.diffs.push(k);
        }
      }

      // 2) Raster parity, layer by layer. This used to compare the PSD's merged
      // composite against the app render, which was true by construction - that
      // render WAS the merged image we wrote. The composite is now flat white and
      // carries no page pixels at all, so there is nothing there to check parity
      // against; per-layer is the stronger claim anyway, since the layers are what
      // Photoshop actually draws. Base against the decoded source art, each text
      // layer against the app's own render of its box.
      // The same space `buildPagePsd` wrote the file in - `?? PAGE_W` let a 0
      // through, and this check would then have decoded the art to 0x0 and reported
      // a parity failure against a reference with no pixels in it. A self-test that
      // fails on a page nobody has opened is worse than none.
      const { w: W, h: H } = await pageSpace(src);
      const textGroup = (psd.children ?? []).find((c) => c.name === 'Text' && c.children);
      let maxDiff = 0;
      if (src.raw) maxDiff = Math.max(maxDiff, maxChannelDiff(layerPixels(findInGroup(psd, 'Base', 'Raw')), await imageDataFromSrc(src.raw, W, H)));
      if (src.cleaned) maxDiff = Math.max(maxDiff, maxChannelDiff(layerPixels(findInGroup(psd, 'Base', 'Cleaned')), await imageDataFromSrc(src.cleaned, W, H)));
      // The boxes that actually became layers, in layer order. `buildPagePsd`
      // drops a raster-only box that painted nothing (textLayerFor returns null
      // for it and the list is filtered), so the nth box is not the nth layer -
      // and every check below that walked `src.boxes` by index was comparing a
      // layer against some other box's render the moment a page held one. The
      // filter is repeated here rather than guessed at, so the two lists are the
      // one list by construction.
      const scratch = document.createElement('canvas');
      const selfTips = await settleBoxTips(src.boxes);
      const layerBoxes = (src.boxes ?? [])
        .map((box) => ({ box, rendered: renderBoxLayer(box, W, H, scratch, src, 1, selfTips) }))
        .filter(({ box, rendered }) => !(isRasterOnly(box.style) && !rendered?.imageData));
      layerBoxes.forEach(({ rendered }, i) => {
        // A box that paints nothing (empty text) gets a layer with no pixels at
        // all, so there is nothing to compare and no failure to report.
        if (rendered) maxDiff = Math.max(maxDiff, maxChannelDiff(layerPixels(textGroup?.children?.[i]), rendered.imageData));
      });
      report.checks.rasterMaxChannelDiff = maxDiff;
      report.checks.rasterParity = maxDiff <= 2; // AA tolerance
      if (!report.checks.rasterParity) report.ok = false;

      // 2b) The composite is present and flat white. Absent, it is written as zeros
      // and macOS renders the whole file solid black; real, it doubles the page's
      // pixel cost. Both failures look fine in Photoshop, so nothing else here
      // would notice either one.
      const comp = layerPixels(psd);
      report.checks.compositeFlatWhite =
        !!comp && comp.width === W && comp.height === H && comp.data.every((v, i) => (i % 4 === 3 ? true : v === 255));
      if (!report.checks.compositeFlatWhite) report.ok = false;

      // 3) Editability / structure. `Base` + `Text` and nothing else: a flat
      // preview layer was the other full-page raster this file used to carry, and
      // it is the kind of thing that gets added back by accident.
      const groupNames = (psd.children ?? []).filter((c) => c.children).map((c) => c.name);
      report.checks.groups = groupNames;
      report.checks.noFlatLayers = (psd.children ?? []).every((c) => !!c.children);
      report.checks.hasTextGroup = !!textGroup;
      // The art must sit UNDER the lettering, and the cleaned plate over the
      // raw. `children[0]` is the bottom layer (see pagePsdDocument), so this
      // reads bottom-first: Base, then Text. Built backwards it opened as bare
      // artwork with every text layer hidden beneath it, and nothing else here
      // would notice - the pixel checks above pass layer by layer whichever way
      // round the groups are stacked.
      report.checks.textAboveBase = groupNames.indexOf('Text') === groupNames.length - 1;
      const baseNames = ((psd.children ?? []).find((c) => c.children && c.name === 'Base')?.children ?? []).map((l) => l.name);
      report.checks.baseOrder = baseNames;
      report.checks.cleanedAboveRaw =
        !baseNames.includes('Cleaned') || !baseNames.includes('Raw') || baseNames.indexOf('Cleaned') > baseNames.indexOf('Raw');
      if (!report.checks.textAboveBase || !report.checks.cleanedAboveRaw) report.ok = false;
      // This used to assert "every layer in the Text group is editable text",
      // which the raster-only fix below makes false on purpose: a curved or
      // roughened box now deliberately gets a layer with no `text` at all (see
      // isRasterOnly). The true invariant is narrower - one layer per box (skipping
      // empty raster-only boxes), and each layer's `text` presence matches its box's style exactly.
      report.checks.textLayersMatchStyle =
        !!textGroup &&
        textGroup.children.length === layerBoxes.length &&
        textGroup.children.every((l) => (typeof l.name === 'string' && l.name.endsWith(RASTER_MARK) ? !l.text : !!l.text));
      if (!report.checks.hasTextGroup || !report.checks.textLayersMatchStyle || !report.checks.noFlatLayers) report.ok = false;

      // 4) The shaped line breaks survived into the editable layer. Checked here
      // and not in psd.test.js because it is the one claim in this file that needs
      // a real measurer: node has no canvas, `canMeasure()` is false there, and
      // textLayerFor writes the paragraph unbroken - so from node this check can
      // only ever pass vacuously. What it guards against is a re-render in
      // Photoshop silently re-wrapping the block greedily and undoing the
      // letterer's shaping (see the comment in textLayerFor).
      report.checks.shapedBreaksInText =
        !!textGroup &&
        textGroup.children.every((l, i) => {
          const box = layerBoxes[i]?.box;
          if (!l.text || !box) return true; // raster-only layers carry no text
          const want = placeBlock(boxCandidate(box, boxTextFor(src, box))).lines;
          return l.text.text === want.join('\n');
        });
      if (!report.checks.shapedBreaksInText) report.ok = false;

      return report;
    } finally {
      if (rebuilt) revokeAll(rebuilt.raw, rebuilt.cleaned);
    }
  });
}
