<script>
  import {
    app,
    page,
    selectBox,
    markUnsaved,
    fontCssFor,
    boxText,
    beginEdit,
    endEdit,
    lineByN,
    toggleBulkTarget,
    isBulkTarget,
    cloneStyle,
    rememberStyle,
    settleEdits,
    setBoxText,
    refitBox,
    autoFitBoxTo,
    fitGeom,
    moveGeom,
    moveBoxTo,
    focusPage,
    resizeBox,
    isLongstrip,
    reviewBox,
    reviewOf,
  } from './store.svelte.js';
  import { stripDragYBounds } from './editor/strip.js';

  import { untrack } from 'svelte';
  import { neededHeight } from './typeset.js';
  import { resizeBoxMath } from './resize-math.js';
  import { record } from './editor/history.svelte.js';
  import {
    createFieldUndo,
    recordFieldEdit,
    resyncField,
    undoField,
    redoField,
    caretAfter,
    isAtomicInput,
  } from './editor/field-undo.svelte.js';
  import { arcLayout, circleLayout, pathLayout, pathPolyline, removePathAnchor, applyCase, layoutLines, lineIndents, textInset, contentWidth, balloonWidthsFor, inkShiftY, charWidths } from './measure.js';
  import {
    strokeBands,
    rgba,
    gradientCss,
    patternTilePx,
    patternTileCanvas,
    motionBlurPreviewTaps,
    drawClipShapes,
    clipActive,
    inkActive,
    drawInk,
    ensureNoisePhase,
    applyTextFilters,
    textFiltersActive,
    OCTAVES,
    TILE_SS,
  } from './text-paint.js';
  import { warpActive, meshMap, unwarpPoint } from './warp.js';
  import { paintWarpedBox, renderBoxTexture, paintWarpedTexture, boxNoiseOrigin } from './exporter.js';
  import { engineSwitch } from './engine-switch.svelte.js';
  import { PICTURE_MAX_PX, PICTURE_OFF, pictureScale, pictureKey, pictureCss, paintBoxPicture, paintPictureTexture } from './editor/box-picture.js';
  import { displayScale } from './editor/display-scale.svelte.js';
  import { watchNear } from './editor/near-view.js';
  import { maskTool } from './mask-tool.svelte.js';
  import { inspectorTab, effectsSubTab } from './inspector-tabs.svelte.js';
  import WarpGizmo from './editor/WarpGizmo.svelte';
  import LockChip from './LockChip.svelte';
  import { brushArmed } from './brush-tool.svelte.js';
  import { inkTipIds, settleTips } from './brush-tips.js';
  import { liquifySettings } from './liquify-tool.svelte.js';
  import { liquifyMeshGesture, frameScaleFor } from './liquify-mesh.js';
  import { reviewReach, reviewTitle } from './review-label.js';
  import { inkOverhang } from './paint-reach.js';
  import { screenPoint, flipPoint, flipDelta, mirrorTransform, mirrorCss } from './box-frame.js';
  import { editLines, drawEditLines, rawOffset, domPoint, rawEdit } from './edit-lines.js';
  import { glyphIndex, rawIndex, glyphsMatch, caretAt, caretNearest, glyphNearest, selectionBoxes, caretKey, wordAt } from './curve-caret.js';

  // pg defaults to current page; longstrip passes explicit page.
  // `shown` and `lazy` are read only while the Rust engine draws (see "the
  // engine's picture" below): `shown` is false for a box on a page the paged
  // view keeps mounted but hidden, and `lazy` is set where most mounted boxes
  // are off screen (the longstrip), so a box waits to be told it is near the
  // viewport before it paints rather than painting and then letting go.
  let { box, pageFrameEl, pg = page(), shown = true, lazy = false } = $props();

  const z = $derived(app.zoom);
  const selected = $derived(app.selectedId === box.id);
  const editing = $derived(app.editingId === box.id);

  // ---- the engine's picture ----
  //
  // With the Rust engine drawing (`engineSwitch.painting`: it is installed for
  // measuring AND its painter is the glyph painter - the one flag, written
  // where the painter is installed), a box at rest is shown as one canvas
  // painted by the exporter, the way a warped box always was: see "the mesh
  // warp" below, which is that path, now the general one. While the engine is
  // starting, has failed, or has no font to measure in, the flag is false and
  // the box is the DOM it always was.
  //
  // THE SEAM FOR TYPING: a box being typed into is still the browser's - the
  // contenteditable below, exactly as it is with the switch off - so the
  // picture stands down for it here, in `!editing`, and nowhere else. The task
  // that draws the caret and the selection on the engine's glyphs removes
  // those two words; everything downstream reads `engineShown`.
  const enginePaints = $derived(engineSwitch.painting);
  const engineShown = $derived(enginePaints && !editing);
  // Device px per page px the picture is painted at: one texture pixel per
  // device pixel at this zoom on this display (less for a box over the pixel
  // budget - `PICTURE_MAX_PX`).
  const pictureRes = $derived(enginePaints ? pictureScale(z, displayScale()) : 0);
  // Whether the box is near the viewport: null until the observer has said.
  let rootEl = $state(null);
  let near = $state(null);
  $effect(() => {
    if (!enginePaints || !shown || !rootEl) {
      near = null;
      return;
    }
    // Asked again each time the page comes back on screen: an observer tells
    // of changes, and "still off screen" after a page turn is not one.
    near = null;
    return watchNear(rootEl, (v) => {
      near = v;
    });
  });
  // Whether the picture may hold pixels at all. Not on a hidden page, and not
  // far off screen; until the observer has spoken a box on the page in front
  // of the user paints (a page turn must not show a frame without its text)
  // and a lazy one waits.
  const pictureOn = $derived(shown && (lazy ? near === true : near !== false));
  const bulkOn = $derived(app.bulk.active);
  const bulkTarget = $derived(isBulkTarget(box.id));
  const s = $derived(box.style);
  const text = $derived(boxText(box, pg));

  const line = $derived(box.lineN != null ? lineByN(pg, box.lineN) : null);
  const jp = $derived(line?.jp ?? '');
  const isSfx = $derived(line?.type === 'sfx');

  const effSize = $derived(s.size * z);
  const effLs = $derived(s.letterSpacing * z);

  const justify = $derived(
    s.align === 'left' ? 'flex-start' : s.align === 'right' ? 'flex-end' : 'center',
  );
  const alignItems = $derived(
    s.valign === 'top' ? 'flex-start' : s.valign === 'bottom' ? 'flex-end' : 'center',
  );

  const roughId = `rough-${box.id}`;
  const mbId = `mb-${box.id}`;

  // The directional smear's tap list: here each tap becomes an feOffset plus
  // an arithmetic accumulate. Offsets are page px, the filter runs in zoomed
  // px, so they scale by the zoom exactly as the blur radius does. The PREVIEW
  // list, not the exporter's full one - every named result in the SVG chain is
  // its own raster surface in WebKit, so the live filter samples the same
  // smear coarser (see motionBlurPreviewTaps).
  const mbTaps = $derived(
    s.motionBlur?.on
      ? motionBlurPreviewTaps(s.motionBlur.x, s.motionBlur.y, s.motionBlur.amount)
      : [],
  );

  // The filter region, sized to what the smear can actually reach instead of a
  // flat 400%. The region is what WebKit allocates every intermediate surface
  // over, so on a large box the fixed margin was paying for megapixels of
  // guaranteed-empty raster per tap. Ink is allowed the same overreach the
  // clip mask grants (MASK_EXPAND page px) plus the furthest tap offset; each
  // side is that in percent of the box, floored at 50% and capped at the old
  // 150% so the region only ever shrinks.
  const mbRegion = $derived.by(() => {
    if (!mbTaps.length) return null;
    let mx = 0;
    let my = 0;
    for (const t of mbTaps) {
      if (Math.abs(t.dx) > mx) mx = Math.abs(t.dx);
      if (Math.abs(t.dy) > my) my = Math.abs(t.dy);
    }
    const side = (reach, size) => Math.min(150, Math.max(50, Math.ceil(((MASK_EXPAND + reach) / Math.max(1, size)) * 100)));
    const px = side(mx, box.w);
    const py = side(my, box.h);
    return { x: `-${px}%`, y: `-${py}%`, w: `${100 + 2 * px}%`, h: `${100 + 2 * py}%` };
  });

  // How far past the box the editor's mask image reaches, page px each side.
  // The mask has to cover overflowing text (a path outside the box, a huge
  // glyph) or CSS masks it to nothing; past this margin, ink is cut off -
  // the price of a finite image, stated once.
  const MASK_EXPAND = 300;

  // The mask as a CSS mask-image, drawn by the same painter the exporter
  // composites with (drawClipShapes). Exclude paints the world white and
  // erases the shapes; include paints only the shapes.
  //
  // A blob URL, not a data URL, and that is the point of the shape below: a
  // data URL cannot be revoked, so every rebuild left its decoded bitmap in
  // WebKit's image cache with nothing entitled to evict it, and rebuilds
  // happen - auto-fit moves `box.h` while the user types. Two defences here:
  // the canvas extent is bucketed to MASK_STEP so a keystroke-sized resize
  // reuses the standing image (mask-size covers the slack), and when a rebuild
  // does happen the old URL is revoked the moment the new one lands, which is
  // what lets the renderer give the old bitmap back.
  const MASK_STEP = 32;
  let maskUrl = $state('');
  let maskW = $state(0); // page px the mask image spans, MASK_EXPAND included
  let maskH = $state(0);
  let maskKey = '';
  let maskLive = ''; // non-reactive twin of maskUrl: what revocation acts on
  let maskSeq = 0; // drops a toBlob that lands after a newer build or destroy
  const setMask = (url, w, h) => {
    if (maskLive && maskLive !== url) URL.revokeObjectURL(maskLive);
    maskLive = url;
    maskUrl = url;
    maskW = w;
    maskH = h;
  };
  $effect(() => {
    // Not while the box is the engine's picture: the mask is in those pixels
    // (as it is in a warped box's), and an image nobody applies is megabytes
    // held for nothing. It is built again when the box is typed into.
    if (!clipActive(s.clip) || engineShown) {
      maskKey = '';
      maskSeq++;
      setMask('', 0, 0);
      return;
    }
    const qz = Math.min(1, Math.max(0.125, Math.round(z * 8) / 8));
    const w = Math.ceil((box.w + MASK_EXPAND * 2) / MASK_STEP) * MASK_STEP;
    const h = Math.ceil((box.h + MASK_EXPAND * 2) / MASK_STEP) * MASK_STEP;
    const key = JSON.stringify([s.clip.shapes, s.clip.mode, qz, w, h]);
    if (key === maskKey) return;
    maskKey = key;
    const cnv = document.createElement('canvas');
    cnv.width = Math.max(2, Math.round(w * qz));
    cnv.height = Math.max(2, Math.round(h * qz));
    const ctx = cnv.getContext('2d');
    if (!ctx) return;
    ctx.scale(cnv.width / w, cnv.height / h);
    ctx.translate(MASK_EXPAND, MASK_EXPAND);
    if (s.clip.mode === 'include') {
      drawClipShapes(ctx, s.clip.shapes);
    } else {
      ctx.fillStyle = '#fff';
      ctx.fillRect(-MASK_EXPAND, -MASK_EXPAND, w, h);
      ctx.globalCompositeOperation = 'destination-out';
      drawClipShapes(ctx, s.clip.shapes);
    }
    const seq = ++maskSeq;
    if (typeof cnv.toBlob === 'function') {
      // Async, so the standing mask holds the frame until the new one is
      // ready - the swap is invisible. A build superseded before its encode
      // lands is dropped unminted.
      cnv.toBlob((b) => {
        if (seq !== maskSeq || !b) return;
        setMask(URL.createObjectURL(b), w, h);
      });
    } else {
      // jsdom and friends: no toBlob, no image cache to leak into either.
      setMask(cnv.toDataURL(), w, h);
    }
  });
  // Reads nothing reactive, so it runs once and its cleanup is the destroy
  // path: the last URL goes back, and the seq bump orphans any encode still in
  // flight.
  $effect(() => {
    return () => {
      maskSeq++;
      if (maskLive) URL.revokeObjectURL(maskLive);
    };
  });
  const maskCss = $derived.by(() => {
    if (!clipActive(s.clip) || !maskUrl) return '';
    const sz = `${maskW * z}px ${maskH * z}px`;
    const pos = `${-MASK_EXPAND * z}px ${-MASK_EXPAND * z}px`;
    return (
      `-webkit-mask-image:url(${maskUrl});mask-image:url(${maskUrl});` +
      `-webkit-mask-size:${sz};mask-size:${sz};` +
      `-webkit-mask-position:${pos};mask-position:${pos};` +
      `-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;`
    );
  });

  // ---- ink ----
  // The strokes, drawn on a canvas over the box. The exporter paints the same
  // strokes with the same painter, so this is a preview of the file rather than
  // an approximation of it. It is sized to the box plus however far the ink
  // reaches outside it - a stroke drawn over the edge must not be cut off here
  // any more than it is on export.
  let inkEl = $state(null);
  // Padded on each side by however far the ink reaches past that edge, with its
  // finish and the filters (`inkOverhang`): a stroke carried past the right or
  // the bottom edge is drawn whole, as the export draws it.
  const inkPad = $derived(inkOverhang(s, box.w, box.h));
  // Where the roughening's grain starts, in box-local page px - the exporter's
  // own answer, so the ink crumples in the field the text does. Only for a box
  // that is both inked and roughened, because it costs a layout.
  const inkNoise = $derived.by(() => {
    if (!inkActive(s.ink) || !s.roughen.on) return null;
    // A font that loads late moves the block, and the grain with it.
    app.fontsVersion;
    return boxNoiseOrigin(box, pg);
  });
  // The strokes and shadows are in the key because they are in the picture:
  // they wrap the ink (see `drawInk`), so a change to either repaints it. The
  // blur, the smear and the roughening are run over it (see `paintInk`).
  const inkKey = $derived(
    inkActive(s.ink)
      ? JSON.stringify([s.ink, s.strokes, s.shadows, s.blur, s.motionBlur, s.roughen, inkNoise]) +
          `|${box.w}|${box.h}|${z}`
      : '',
  );
  let inkDrawn = '';
  let inkLive = null; // non-reactive twin of inkEl: what the pixel release acts on
  // The decoded tips the last paint had in hand, and the sequence number that
  // says which paint is the current one. Neither is reactive: they are read by
  // the paint, not by the effect that schedules it, and making them state would
  // turn "the tips arrived" into a dependency of the effect that asked for them.
  let inkTips = null;
  let inkTipSeq = 0;
  // The roughening filter's phase is measured against the running browser once
  // per session (see text-paint.js), and the measurement is a rasterisation. The
  // first paint of a roughened ink layer or warped box happens before it lands;
  // this is what says the second one is worth its cost and the third is not.
  let noiseSettled = false;

  // Whether two settles answered with the same tips. A repaint is only worth
  // its cost when they did not - the usual case on a live stroke is that the
  // library handed back the identical wrapper it did last frame.
  function sameTips(a, b) {
    if (a === b) return true;
    if (!a || !b || a.size !== b.size) return false;
    for (const [id, tip] of a) if (b.get(id) !== tip) return false;
    return true;
  }

  // The ink canvas, drawn from scratch. `tips` is what the imported brushes
  // stamp with; without it - the first frame, or a brush this install does not
  // have - those strokes draw with the round tip and keep their brush id. The
  // strokes themselves are drawn on the brush board and placed here whole; a
  // box never takes a stroke from the pointer directly.
  function paintInk(el, tips) {
    const w = Math.max(1, Math.round((box.w + inkPad.l + inkPad.r) * z));
    const h = Math.max(1, Math.round((box.h + inkPad.t + inkPad.b) * z));
    if (el.width !== w) el.width = w;
    if (el.height !== h) el.height = h;
    const ctx = el.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.scale(z, z);
    ctx.translate(inkPad.l, inkPad.t);
    drawInk(ctx, s.ink, undefined, tips, s);
    // The whole-text filters, over the ink as the exporter runs them over its
    // composite - the same chain, at the zoom instead of the supersample. The
    // text beside it gets the same three from its CSS filter list; the ink is a
    // canvas and cannot hang that list, so it is filtered in its pixels here.
    // The chain's result is copied back and let go at once: a second
    // zoom-sized canvas per box is not something to keep between paints.
    if (!textFiltersActive(s)) return;
    const o = inkNoise ?? { x: 0, y: 0 };
    const out = applyTextFilters(el, s, z, { x: o.x + inkPad.l, y: o.y + inkPad.t });
    if (out === el) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(out, 0, 0);
    out.width = 0;
    out.height = 0;
  }

  $effect(() => {
    const key = inkKey;
    const el = inkEl;
    if (!el) {
      // The canvas is gone (ink switched off, or the box is being torn down).
      // Hand its pixels back now, and forget what was drawn: switching the same
      // ink back on mints a *new* blank canvas, and a remembered key would let
      // it stay blank.
      if (inkLive) {
        inkLive.width = 0;
        inkLive.height = 0;
        inkLive = null;
      }
      inkDrawn = '';
      // Let go of the tips with the canvas. Holding a decoded bitmap for a box
      // that is not drawing is exactly what the library's lifetime contract is
      // written against.
      inkTips = null;
      inkTipSeq++;
      return;
    }
    inkLive = el;
    if (key === inkDrawn) return;
    // A zoom still moving: the canvas the browser is already scaling to its CSS
    // box is soft, not wrong, and it is repainted the moment the gesture stops -
    // `app.zoomLive` is read here, so clearing it re-runs this effect with the
    // key still unbanked. Repainting per wheel tick meant every sampled point of
    // every stroke, per box, per event. Only once something HAS been drawn: a
    // box that mounts mid-gesture has to paint its first frame here or it stays
    // blank until the user lets go.
    if (app.zoomLive && inkDrawn) return;
    inkDrawn = key;
    // Paint NOW with whatever is already decoded - the tips the last frame
    // settled, usually the same ones - and then re-ask the library, because a
    // tip it dropped between frames has to be read again (see the tip lifetime
    // contract). The second paint happens only when the answer changed, which
    // on a live stroke is the first frame after the brush is picked and no
    // frame after that.
    paintInk(el, inkTips);
    // The roughening's phase lands once per session (see `noiseSettled`); a
    // roughened ink painted before it is repainted once it has.
    const ids = inkTipIds(s.ink);
    const wantNoise = s.roughen.on && !noiseSettled;
    if (!ids.size && !wantNoise) {
      inkTips = null;
      inkTipSeq++;
      return;
    }
    const seq = ++inkTipSeq;
    Promise.all([ids.size ? settleTips(ids) : null, wantNoise ? ensureNoisePhase() : null]).then(
      ([map]) => {
        // A newer paint, a torn-down canvas, or a canvas the effect has since
        // handed its pixels back: in all three this paint is stale.
        if (seq !== inkTipSeq || inkLive !== el || !el.width) return;
        if (wantNoise) noiseSettled = true;
        const before = inkTips;
        inkTips = map ?? null;
        if (wantNoise || !sameTips(before, inkTips)) paintInk(el, inkTips);
      },
      () => {},
    );
  });
  // A box scrolled off the page keeps its canvas alive otherwise, and a chapter
  // of inked boxes is exactly the shape that put 2 GB in the webview before.
  // Reads nothing reactive, so it runs once and its cleanup is the destroy path;
  // it zeroes the twin rather than the binding, which teardown may already have
  // nulled.
  $effect(() => () => {
    if (inkLive) {
      inkLive.width = 0;
      inkLive.height = 0;
      inkLive = null;
    }
    // The tips go with it: a destroyed box must not be the last thing holding a
    // decoded bitmap alive, and a settle still in flight must not paint into a
    // canvas that is gone.
    inkTips = null;
    inkTipSeq++;
  });

  // ---- the mesh warp ----
  //
  // A warped box stops being DOM text. There is no CSS that states a mesh, so
  // the box renders as the exporter's own picture of itself - `paintWarpedBox`
  // is the same `renderBox` call the page composite makes, drawn at the zoom
  // instead of at the export's supersample - and what is on screen is the file
  // by construction rather than by two painters agreeing.
  //
  // This is the substitution the PSD export already makes for a box Photoshop
  // cannot re-render, and it costs the same things: no caret and no selection.
  // See `onDblClick` below. The mask tools still work: `maskShapePoint` carries
  // the pointer back through the mesh.
  //
  // With the Rust engine drawing, this is how EVERY box at rest is shown
  // (`engineShown`): the same canvas, the same effect, the same release. Two
  // things differ, both in `paintWarp` and the key: the picture is painted at
  // the display's scale rather than at 2 and stretched, and it is not painted
  // at all for a box nobody can see (`pictureOn`).
  const warped = $derived(warpActive(s, box.w, box.h));
  const pictured = $derived(warped || engineShown);
  let warpEl = $state(null);
  let warpGeom = $state(null);
  // Everything the picture is drawn from - the whole style, because a warped
  // box is drawn by the exporter and the exporter reads all of it.
  //
  // The ink block is the one thing NOT stringified here. It is far the heaviest
  // part of a style (a stroke is hundreds of sampled points, and a box can carry
  // many), the key is recomputed on every reactive cycle that touches the box,
  // and `inkKey` above already states exactly that block for the layer this one
  // replaces - it is computed either way, so folding it in costs nothing and
  // says the same thing. Anything the ink can change, it changes there.
  //
  // The engine's picture has a key of its own (`pictureKey`): it leaves out
  // what CSS applies to the finished picture - the turn, the flip, the opacity
  // - so turning a box repaints nothing, and it states the LINES, so a change
  // to how the text breaks repaints whatever caused it and a move, which
  // re-derives the same lines, does not.
  const warpKey = $derived(
    engineShown
      ? pictureOn
        ? pictureKey({
            style: s,
            inkKey,
            text,
            w: box.w,
            h: box.h,
            lines: shaped,
            indents,
            scale: pictureRes,
            fonts: app.fontsVersion,
          })
        : PICTURE_OFF
      : warped
        ? JSON.stringify({ ...s, ink: 0 }) +
          `|${inkKey}|${text}|${box.w}|${box.h}|${z}|${app.fontsVersion}`
        : '',
  );
  let warpDrawn = '';
  let warpLive = null; // non-reactive twin of warpEl: what the pixel release acts on
  let warpTips = null;
  let warpSeq = 0;

  function paintWarp(el, tips) {
    warpGeom = engineShown
      ? paintBoxPicture(el, box, pg, pictureRes, tips)
      : paintWarpedBox(el, box, pg, z, tips);
  }

  // ---- the gizmo's live drag ----
  //
  // A handle drag changes the MESH forty times a second and changes nothing
  // else: the same type, the same ink, the same blur, smear and mask. Rendering
  // the box per frame would pay for all of that per frame, so the texture is
  // rendered once when the pointer goes down and every move after it re-runs
  // only `warpBoxCanvas` over the cache (see the exporter's `renderBoxTexture` /
  // `paintWarpedTexture`, split out for exactly this).
  //
  // `warpDragging` is what keeps the reactive path out of the way meanwhile:
  // every move writes `warp.pts`, which changes `warpKey`, which would
  // otherwise re-render the whole box a second time per frame.
  let warpDragging = $state(false);
  let warpTex = null;
  const releaseWarpTex = () => {
    if (!warpTex) return;
    warpTex.canvas.width = 0;
    warpTex.canvas.height = 0;
    warpTex = null;
  };
  const warpPainter = {
    begin() {
      releaseWarpTex();
      warpTex = engineShown
        ? renderBoxTexture(box, pg, warpTips, pictureRes, PICTURE_MAX_PX)
        : renderBoxTexture(box, pg, warpTips);
      warpDragging = true;
    },
    frame() {
      // No canvas yet on the first move of a mesh that was still identity when
      // the pointer went down: the box only becomes a picture once the mesh
      // deforms, and the effect below paints that first frame as it mounts.
      if (!warpTex || !warpLive) return;
      warpGeom = engineShown
        ? paintPictureTexture(warpLive, warpTex, box)
        : paintWarpedTexture(warpLive, warpTex, box, z);
    },
    end() {
      releaseWarpTex();
      // Forget what was drawn, so the effect repaints from the committed (or
      // cancelled) style rather than trusting the last frame of the drag.
      warpDrawn = '';
      warpDragging = false;
    },
  };

  $effect(() => {
    const key = warpKey;
    const el = warpEl;
    const dragging = warpDragging;
    if (!el) {
      // Warp switched off, or the box is going away: hand the pixels back and
      // forget what was drawn, so switching it on again paints the new canvas.
      if (warpLive) {
        warpLive.width = 0;
        warpLive.height = 0;
        warpLive = null;
      }
      warpDrawn = '';
      warpGeom = null;
      warpTips = null;
      warpSeq++;
      return;
    }
    warpLive = el;
    // The gizmo owns this canvas while a handle is down - it is painting the
    // cached texture through the new mesh already. The key is banked so the
    // release at pointer-up is what triggers the one authoritative repaint.
    // Only once something HAS been drawn: the first frame of a drag that
    // started from an identity mesh mounts this canvas mid-gesture, and that
    // frame has to be painted here.
    if (dragging && warpDrawn) {
      warpDrawn = key;
      return;
    }
    // A zoom still moving, deferred for the reason the ink layer is - and this
    // one costs more, because the paint is the exporter's whole composite run
    // through the mesh. The key is NOT banked here, unlike the gizmo drag above:
    // nothing else is painting this canvas, so the settle has to find the key
    // still stale and repaint.
    // Only a canvas that HOLDS a picture is left to be stretched: one that was
    // let go for being off screen has nothing to stretch, and zooming out is
    // exactly what brings it back into view.
    if (app.zoomLive && warpDrawn && warpDrawn !== PICTURE_OFF) return;
    if (key === warpDrawn) return;
    warpDrawn = key;
    if (key === PICTURE_OFF) {
      // The box is on a hidden page or far off screen: the element stays, its
      // pixels do not, and a settle still in flight must not paint them back.
      el.width = 0;
      el.height = 0;
      warpGeom = null;
      warpTips = null;
      warpSeq++;
      return;
    }
    paintWarp(el, warpTips);
    const ids = inkTipIds(s.ink);
    const wantNoise = s.roughen.on && !noiseSettled;
    if (!ids.size && !wantNoise) {
      warpTips = null;
      return;
    }
    const seq = ++warpSeq;
    Promise.all([ids.size ? settleTips(ids) : null, wantNoise ? ensureNoisePhase() : null]).then(
      ([map]) => {
        if (seq !== warpSeq || warpLive !== el || !el.width) return;
        if (wantNoise) noiseSettled = true;
        const before = warpTips;
        warpTips = map ?? null;
        if (wantNoise || !sameTips(before, warpTips)) paintWarp(el, warpTips);
      },
      () => {},
    );
  });
  $effect(() => () => {
    if (warpLive) {
      warpLive.width = 0;
      warpLive.height = 0;
      warpLive = null;
    }
    // A gesture's cached texture is a supersampled footprint; a box destroyed
    // mid-drag must not be the last thing holding one. The two flags go with
    // it: the gizmo's own teardown ends the gesture and calls `end()`, but this
    // box may be the thing being destroyed and the order of the two teardowns is
    // not ours to assume. `warpDragging` left true is the expensive one - it is
    // what holds the reactive repaint off - so it is reset here as well.
    releaseWarpTex();
    warpDragging = false;
    warpDrawn = '';
    warpTips = null;
    warpSeq++;
  });

  // ---- the transform gizmo ----
  //
  // Shown while the Effects panel's `transform` sub-tab is the one on screen and
  // this box's warp is switched on - the same shape the mask tools' gate has
  // (selected, not being edited, not under the bulk panel), plus the sub-tab,
  // because handles at every grid point are not something to leave on a box
  // whose controls are not in front of the user.
  //
  // Deliberately NOT gated on `warped`: an untouched mesh IS identity, so the
  // box is not warped yet and the gizmo is the only thing that can make it so.
  // And gated on the brush being down, because an armed brush replaces the
  // whole panel - the sub-tab is not on screen then, whatever it remembers.
  const warpGizmoOn = $derived(
    selected &&
      !editing &&
      !bulkOn &&
      !brushArmed() &&
      !!pageFrameEl &&
      s.warp?.on === true &&
      inspectorTab.id === 'effects' &&
      effectsSubTab.id === 'transform',
  );

  // Padded by the content box's inset - the padding plus the outline's reach
  // (`textInset`, measure.js) - so the flex layout and `text-align` put the block
  // exactly where the exporter and the PSD writer anchor it, with room for its
  // outline inside the box.
  const pad = $derived(textInset(s) * z);
  const boxStyle = $derived(
    `left:${box.x * z}px;top:${box.y * z}px;width:${box.w * z}px;height:${box.h * z}px;` +
      `padding:${pad}px;` +
      `transform:rotate(${s.rotation}deg);justify-content:${justify};align-items:${alignItems};` +
      `opacity:${s.opacity}`,
  );


  // The font and the block's own metrics: everything that decides WHERE a glyph
  // lands. Every layer of the stack below carries it, because they are copies of
  // the same block and have to lay out identically; what differs between them is
  // only how the glyphs are painted.
  const textStyle = $derived(
    `font-family:${fontCssFor(s.font)};font-weight:${s.bold ? 700 : 400};` +
      `font-style:${s.italic ? 'italic' : 'normal'};text-align:${s.align};` +
      `line-height:${s.lineHeight};font-size:${effSize}px;letter-spacing:${effLs}px;` +
      `text-transform:${s.uppercase ? 'uppercase' : 'none'};`,
  );

  // The whole-text filters, applied to the composite of every layer: the blur,
  // then the directional smear, then roughening's SVG displacement. One
  // `filter` list, in that order, because a roughened edge should be blurred
  // and smeared rather than the other way round - and the exporter runs its
  // three passes in the same order.
  const filterCss = $derived.by(() => {
    const f = [];
    if (s.blur > 0) f.push(`blur(${s.blur * z}px)`);
    if (mbTaps.length) f.push(`url(#${mbId})`);
    if (s.roughen.on) f.push(`url(#${roughId})`);
    return f.length ? `filter:${f.join(' ')};` : '';
  });

  // The paint, as a stack of copies of the same text block: shadows underneath,
  // then one layer per stroke from the outermost in, then the fill on top. It is
  // the exporter's paint order stated in DOM terms, and the reason it is a stack
  // rather than one element is that CSS gives an element ONE text colour and ONE
  // stroke - so a second stroke, or a shadow cast from the strokes rather than
  // from the glyphs, has nowhere else to live.
  //
  // Each layer holds the same lines, so they lay out on top of one another
  // exactly; the first is in normal flow and gives the block its size, and the
  // rest are absolutely positioned over it (see the styles at the foot of this
  // file). A shadow layer's translate and blur do not move its layout box, which
  // is why offsetting it cannot shift the layers stacked on it.
  const layers = $derived.by(() => {
    const out = [];
    const bands = strokeBands(s.strokes);
    // shadows[0] paints on top of shadows[1], so the list is walked backwards.
    for (let i = (s.shadows?.length ?? 0) - 1; i >= 0; i--) {
      const sh = s.shadows[i];
      // The shadow's shape is the glyphs plus every stroke, which is exactly
      // what this layer draws: the outermost stroke and the fill, both in the
      // shadow's colour. A CSS blur radius is the gaussian sigma while the
      // canvas takes twice it, hence the halving - see paintShadows.
      let css = `color:${sh.color};`;
      if (bands.length) css += `-webkit-text-stroke:${bands[0].line * z}px ${sh.color};`;
      css += `opacity:${sh.opacity};transform:translate(${sh.x * z}px, ${sh.y * z}px);`;
      if (sh.blur > 0) css += `filter:blur(${(sh.blur / 2) * z}px);`;
      out.push({ css, arc: css, line: '', bg: '' });
    }
    for (const band of bands) {
      // Transparent fill, so what shows of this layer is its stroke alone - and
      // the layers stacked after it (the next stroke in, then the fill) cover
      // the half of it that falls inside the glyph.
      const css = `color:transparent;-webkit-text-stroke:${band.line * z}px ${rgba(band.color, band.opacity)};`;
      out.push({ css, arc: css, line: '', bg: '' });
    }
    out.push(fillLayer());
    return out;
  });

  // The topmost layer: the fill. A gradient or a pattern is painted as the
  // layer's background and clipped to the glyphs, which needs the text itself to
  // be transparent; scope 'line' moves that background onto each line instead,
  // so it restarts on every wrapped line.
  //
  // `arc` and `bg` are the curved path's halves of the same thing. Curved text
  // is a set of absolutely positioned spans, and a background clipped to text on
  // their container does not reach them - so the background goes on each span,
  // and the markup gives it the box's size and an offset for that glyph, which
  // is what makes one gradient run across the whole word instead of restarting
  // on every letter.
  const CLIP = '-webkit-background-clip:text;background-clip:text;';

  // One tile's data URL, remembered. Rebuilding it means drawing a canvas and
  // then base64ing it, and `fillLayer` is re-run for every style change and
  // every zoom tick - so a pinch gesture used to encode a fresh PNG per frame
  // per patterned box. Keyed on everything the tile is drawn from, with the zoom
  // quantised to an eighth: the tile is a raster CSS resamples anyway, so a
  // hair's difference in the resolution it was drawn at cannot be seen.
  let tileMemo = { key: '', url: '' };
  function patternTileUrl() {
    const qz = Math.max(0.125, Math.round(z * 8) / 8);
    const key = JSON.stringify([s.pattern, s.size, qz]);
    if (tileMemo.key === key) return tileMemo.url;
    const cnv = patternTileCanvas(s, TILE_SS * qz);
    const url = cnv ? cnv.toDataURL() : '';
    tileMemo = { key, url };
    return url;
  }

  function fillLayer() {
    if (s.pattern.on) {
      const tile = patternTileUrl();
      if (tile) {
        const px = patternTilePx(s) * z;
        const bg = `background-image:url(${tile});background-repeat:repeat;${CLIP}`;
        return {
          css: `color:transparent;${bg}background-size:${px}px ${px}px;`,
          arc: 'color:transparent;',
          line: '',
          bg,
          tile: px,
        };
      }
    }
    if (s.gradient.on) {
      const bg = `background-image:${gradientCss(s.gradient)};${CLIP}`;
      return {
        css: s.gradient.scope === 'line' ? 'color:transparent;' : `color:transparent;${bg}`,
        arc: 'color:transparent;',
        line: s.gradient.scope === 'line' ? bg : '',
        bg,
        tile: 0,
      };
    }
    return { css: `color:${s.color};`, arc: `color:${s.color};`, line: '', bg: '' };
  }

  // What the box looks like while it is being typed into: one editable element,
  // so the caret and the selection behave. A stack of copies has no caret, so the
  // editor shows the outermost stroke and the shadows as CSS can state them on a
  // single element and the full paint comes back the moment the edit ends.
  const editStyle = $derived.by(() => {
    let css = `${textStyle}color:${s.color};`;
    const bands = strokeBands(s.strokes);
    if (bands.length)
      css += `-webkit-text-stroke:${bands[0].line * z}px ${bands[0].color};paint-order:stroke fill;`;
    // `text-shadow`'s blur radius is TWICE the gaussian's sigma (CSS states it
    // that way, as does a canvas `shadowBlur`), while `filter: blur()` is the
    // sigma itself - so the style's `blur` goes in whole here and halved on the
    // display layer above, and both come out at the same softness. The two
    // spellings look like a mismatch and are not one.
    if (s.shadows.length)
      css += `text-shadow:${s.shadows
        .map((sh) => `${sh.x * z}px ${sh.y * z}px ${sh.blur * z}px ${rgba(sh.color, sh.opacity)}`)
        .join(',')};`;
    return css + filterCss;
  });

  // Glyph-by-glyph layout, when one applies: the bezier path when it is on and
  // has a curve to follow, else the closed circle, else the arc. All three
  // return the same shape, so the markup below draws any of them without
  // knowing which.
  //
  // While it is typed into too (`curveEdit`), from the text being typed: the
  // box draws the glyphs the result draws, with the caret and the selection
  // drawn on them, and the text itself in an editable nobody sees. Not when
  // uppercasing changes the number of characters, so that a glyph is no longer
  // a character of the text: that box is typed into flat, as it always was.
  const curved = $derived(!!((s.path?.on && (s.path.pts?.length ?? 0) >= 2) || s.circle?.on || s.curve));
  const curveEdit = $derived(editing && curved && glyphsMatch(text, applyCase(text, s)));
  // An IME's text is not the box's until the composition ends, but it is on
  // the curve while it is being composed: the editable holds it by then.
  let composeText = $state(null);
  const layout = $derived.by(() => {
    if ((editing && !curveEdit) || !curved) return null;
    const t = applyCase(editing ? (composeText ?? text) : text, s);
    if (t === '') return null;
    if (s.path?.on && (s.path.pts?.length ?? 0) >= 2) return pathLayout(t, s, effSize, box.w, box.h);
    if (s.circle?.on) return circleLayout(t, s, effSize);
    return arcLayout(t, s, effSize);
  });

  // The lines this box draws, and the ONLY thing that draws them: the editor
  // renders what `layoutLines` returns rather than handing the raw text to the
  // browser, so what is on the canvas is what the exporter puts in the file -
  // including the leading and trailing blank lines that function drops. While
  // it is being typed into too (`editSegs`), so the text does not jump when
  // the edit ends - except curved text, which is not broken into lines at all
  // and is typed on its curve (or flat).
  const shaped = $derived.by(() => {
    if (layout || (editing && curved)) return null;
    // Invalidate breaks when fonts load.
    app.fontsVersion;
    // Line breaking layout using box style dimensions and balloon fit.
    return layoutLines(
      applyCase(text, s),
      s,
      s.size,
      contentWidth(box.w, s),
      balloonWidthsFor(box, s, s.size),
    );
  });

  // How far each flush line is set in from the edge it is aligned to, to its
  // balloon row's own edge (`lineIndents`): the number the exporter draws each
  // line's x from and the PSD indents each paragraph by. Unzoomed, and null for
  // every box that sets none in - centred text, no balloon, plain wrapping -
  // which then draws exactly as it always did. A line's padding on its aligned
  // side, so its row is still the content box and a line-scoped gradient spans
  // what the exporter's does.
  const indents = $derived.by(() => {
    if (!shaped) return null;
    app.fontsVersion;
    return lineIndents(shaped, s, s.size, contentWidth(box.w, s), balloonWidthsFor(box, s, s.size));
  });
  const indentCss = (i) => (indents ? `padding-${s.align}:${indents[i] * z}px;` : '');

  // How far the centred block moves so its INK, not its line boxes, is centred
  // in the box - the exporter's `inkShiftY`, in zoomed px because it is applied
  // to the zoomed text. Zero for any other `valign` and for curved text, which
  // is placed glyph by glyph from the box centre, typed into or not. While
  // curved text is typed into flat there are no shaped lines, so the typed
  // paragraphs stand in: their first ascender and last descender are the ones
  // that decide the shift, and measuring them keeps the text from jumping when
  // the edit starts and ends.
  const inkShift = $derived.by(() => {
    if (s.valign !== 'middle' || layout || curveEdit) return 0;
    const lines = shaped ?? (editing ? applyCase(text, s).split('\n') : null);
    return lines ? inkShiftY(lines, s, effSize) : 0;
  });
  // In the unflipped frame, inside the mirror (which is the clip wrapper's -
  // see `wrapMirror`): the export centres the block on its ink and then flips
  // the finished picture, so a vertically mirrored block is shifted the other
  // way on the page, and here it is too.
  const stackTransform = $derived(inkShift ? `transform:translateY(${inkShift}px);` : '');

  // Reactive auto-fit effect for text metrics.
  //
  // The box's height follows its line count, and this component has just worked
  // that line count out in order to draw with it. So the count is handed over
  // rather than derived a second time: `shaped` and `autoFitBox` used to call
  // `layoutLines` with byte-identical arguments, one after the other, on every
  // box on the page on every page turn - a full duplicate shaping pass, measured
  // at ~59ms of a turn's 100 with the typesetting beta on.
  //
  // `shaped` is read TRACKED, which is what makes this correct rather than
  // merely fast: it is derived from exactly the inputs listed below, so the
  // effect can no longer run against a line count from before the change that
  // woke it. It cannot loop either - `shaped` reads the text, the style and
  // `box.w`, and `autoFitBoxTo` / `growToFit` is grow-only and writes `box.h`
  // only when it actually changes.
  //
  // `shaped` is null only for a curved box (glyphs along an arc, never
  // wrapped), drawn or being typed into. It falls back to `refitBox`, the same
  // grow-only net, which for a curve is the verdict alone. Never the solver or
  // the ladder: sizing a box is the store's, on the edits that call for it
  // (ARC-1), and a component that re-sized boxes as it rendered them would
  // resize every box it drew.
  $effect(() => {
    text;
    box.w;
    box.h;
    s.font;
    s.size;
    s.lineHeight;
    s.letterSpacing;
    s.uppercase;
    s.bold;
    s.italic;
    s.valign;
    s.shape;
    s.minOrphan;
    s.hyphenate;
    s.autoHeight;
    // Both halves of the balloon fit: the shape itself, and the switch that says
    // whether to lay out to it. Either changing changes the line count, which is
    // the box's height.
    s.balloon;
    box.fit;
    app.fontsVersion;
    const lines = shaped;
    untrack(() => (lines ? autoFitBoxTo(box, lines.length, pg) : refitBox(box, pg)));
  });

  // The "needs review" flag as every reader sees it: the containment check's,
  // or the solver's while the solve it came from still stands (`reviewOf`).
  const review = $derived(reviewOf(box, pg));

  // Mirror flip transform for text.
  const mirror = $derived(mirrorTransform(s));
  // The same flip on an overlay of stored points - the path and mask gizmos -
  // about the box's centre, so a handle sits on the part of the flipped
  // picture it moves (see box-frame.js).
  const overlayMirror = $derived(mirrorCss(s, box.w * z, box.h * z));
  // The flip, as the export makes it: of the box's FINISHED picture - type,
  // ink, and the mask already cut out of them - about the box's centre
  // (`paintBoxOnPage` mirrors the bitmap `renderBox` composited, the mask
  // included). So it goes on the clip wrapper, whose border box is the box and
  // which carries the mask: a CSS mask is applied in the element's own frame,
  // before its transform, which is the export's order. It used to sit on the
  // text alone, under the mask, so a mask cut the flipped text where the
  // unflipped text is cut on export, and the ink was not flipped at all.
  // Not while typing: the caret gets the text the right way round.
  const wrapMirror = $derived(mirror && !editing ? `transform:${mirror};` : '');

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // Track active pointer gesture AbortControllers.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  function onBoxPointerDown(e) {
    if (editing) return;

    if (e.button !== 0) return;

    focusPage(pg);
    if (bulkOn) {
      e.stopPropagation();
      toggleBulkTarget(box.id);
      return;
    }
    if (e.target.classList.contains('handle')) return;
    e.stopPropagation();
    if (!selected) selectBox(box.id);
    startMove(e);
  }

  function onDblClick(e) {
    e.stopPropagation();
    focusPage(pg);
    // A warped box has no text element to put a caret in - it is one canvas -
    // so the edit is refused rather than opened onto something invisible. The
    // Effects panel's Reset (or switching the warp off) gives the box back.
    if (warped) return;
    beginEdit(box.id);
  }

  function startMove(e) {
    e.preventDefault();

    e.currentTarget.setPointerCapture?.(e.pointerId);

    settleEdits();
    const zz = app.zoom;
    const dims = pg;
    const stripBounds = isLongstrip() ? stripDragYBounds(app.pages, dims.id, box.h) : null;
    const pid = e.pointerId;
    const sx = e.clientX, sy = e.clientY, ox = box.x, oy = box.y;

    const pageId = dims.id;
    // The box's balloon fit moves with it, from where it started, so its lines
    // stay the lines it had (`moveBoxTo`); the entry carries the fit both ways.
    const before = moveGeom(box);
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const x = clamp(ox + (ev.clientX - sx) / zz, -box.w + 20, dims.w - 20);
      const y = stripBounds
        ? clamp(oy + (ev.clientY - sy) / zz, stripBounds.min, stripBounds.max)
        : clamp(oy + (ev.clientY - sy) / zz, -box.h + 20, dims.h - 20);
      moveBoxTo(box, x, y, pg, before);
      markUnsaved();
    };

    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();

      if (box.x !== before.x || box.y !== before.y) {
        record({ t: 'move', pageId, boxId: box.id, before, after: moveGeom(box) });
      }
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  function startTransform(e, dir) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    focusPage(pg);
    if (!selected) selectBox(box.id);
    settleEdits();
    const zz = app.zoom;
    const pid = e.pointerId;
    const sx = e.clientX, sy = e.clientY;

    // The rectangle and the size, and the solver's record: a width drag locks the
    // width and re-sets the text in it, and the undo has to take both back.
    const o = fitGeom(box);
    const isRot = dir === 'rot';
    const hasInk = !!(box.style?.ink?.on && box.style?.ink?.strokes?.length);
    const inkBefore = hasInk ? cloneStyle(box.style).ink : null;

    const dims = pg;
    const pageId = dims.id;
    // Rotation gesture records style edit.
    const styleBefore = isRot ? cloneStyle(box.style) : null;

    const fitBefore = isRot ? { y: box.y, h: box.h } : null;
    const cx = () => box.x + box.w / 2;
    const cy = () => box.y + box.h / 2;

    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      if (isRot) {
        if (!pageFrameEl) return;
        const r = pageFrameEl.getBoundingClientRect();
        const mx = (ev.clientX - r.left) / zz, my = (ev.clientY - r.top) / zz;
        let ang = (Math.atan2(my - cy(), mx - cx()) * 180) / Math.PI + 90;
        if (ang > 180) ang -= 360;
        else if (ang < -180) ang += 360;
        if (ev.shiftKey) {
          ang = Math.round(ang / 15) * 15;
          if (ang > 180) ang -= 360;
          else if (ang < -180) ang += 360;
        }
        box.style.rotation = clamp(Math.round(ang), -180, 180);
      } else {
        // Transform pointer delta into box coordinate space.
        const rad = (-(s.rotation || 0) * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const sdx = (ev.clientX - sx) / zz, sdy = (ev.clientY - sy) / zz;
        const dx = sdx * cos - sdy * sin, dy = sdx * sin + sdy * cos;
        // Auto-height keeps its promise through the drag: an edge can make the
        // box roomier but never shorter than its text. `shaped` is null for
        // curved and path text, which auto-height does not fit either. Capped at
        // the page, as the fit itself is.
        const floor = s.autoHeight !== false && shaped
          ? Math.min(neededHeight(shaped.length, s, textInset(s)), pg?.h || Infinity)
          : 30;
        const geom = resizeBoxMath(dx, dy, dir, o, s.rotation, floor);
        resizeBox(
          pageId,
          box.id,
          geom,
          inkBefore ? { w: o.w, h: o.h, ink: inkBefore } : { w: o.w, h: o.h }
        );
      }
    };

    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      // Both gestures on this handle CHANGE THE STYLE - the rotation handle
      // writes `rotation`, a corner writes `size` - and the next box placed is
      // meant to follow the box the user just shaped. Nothing else on this path
      // touches `lastStyle` (the Inspector's `touch` covers only edits made in
      // the panel), so without this a rotate-then-place produced the style of
      // some earlier box. At the END of the gesture, not during: the style is
      // settled here, and remembering per pointermove would clone it per frame.
      rememberStyle(box);
      if (isRot) {
        const after = cloneStyle(box.style);
        if (after.rotation !== styleBefore.rotation) {
          markUnsaved();
          record({
            t: 'style',
            pageId,
            boxId: box.id,
            before: styleBefore,
            after,
            geomBefore: fitBefore,
            geomAfter: { y: box.y, h: box.h },
          });
        }
        return;
      }
      const before = { ...o };
      if (inkBefore) before.ink = inkBefore;
      const after = fitGeom(box);
      if (box.style?.ink?.on) after.ink = cloneStyle(box.style).ink;
      const geomKeys = ['x', 'y', 'w', 'h', 'size'];
      if (geomKeys.some((k) => after[k] !== before[k])) {
        markUnsaved();
        record({ t: 'resize', pageId, boxId: box.id, before, after });
      }
    };

    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // Drag one bezier-path anchor or handle. `which` is 'a' (the anchor itself),
  // 'in' or 'out'. Dragging a handle mirrors its partner, keeping the curve
  // smooth through the anchor in a single drag.
  // The pointer delta is inverse-rotated into box space like a resize is, and
  // the gesture records one style edit at the end like the rotation handle.
  // Deltas rather than `maskLocal` points, so the drag needs no page frame.
  function startPathDrag(e, i, which) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    focusPage(pg);
    settleEdits();
    const zz = app.zoom;
    const pid = e.pointerId;
    const sx = e.clientX,
      sy = e.clientY;
    const pt = s.path.pts[i];
    if (!pt) return;
    const o = { x: pt.x, y: pt.y, ix: pt.ix, iy: pt.iy, ox: pt.ox, oy: pt.oy };
    const styleBefore = cloneStyle(box.style);
    const pageId = pg.id;
    const rad = (-(s.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rad),
      sin = Math.sin(rad);
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const sdx = (ev.clientX - sx) / zz,
        sdy = (ev.clientY - sy) / zz;
      // And mirrored into the path's own frame, which is the unflipped one: the
      // curve is drawn flipped (`overlayMirror`), so a step right on screen is
      // a step left in the path on a box flipped left-right.
      const [dx, dy] = flipDelta([sdx * cos - sdy * sin, sdx * sin + sdy * cos], s);
      if (which === 'a') {
        pt.x = o.x + dx;
        pt.y = o.y + dy;
      } else if (which === 'in') {
        pt.ix = o.ix + dx;
        pt.iy = o.iy + dy;
        pt.ox = -pt.ix;
        pt.oy = -pt.iy;
      } else {
        pt.ox = o.ox + dx;
        pt.oy = o.oy + dy;
        pt.ix = -pt.ox;
        pt.iy = -pt.oy;
      }
      markUnsaved();
    };
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      const after = cloneStyle(box.style);
      if (JSON.stringify(after.path) !== JSON.stringify(styleBefore.path)) {
        // The glyphs follow the curve, so where they land decides the flag -
        // and nothing else asks: the fit effect does not read the path. Once,
        // at the end, as the mesh gestures do.
        reviewBox(box, pg);
        record({ t: 'style', pageId, boxId: box.id, before: styleBefore, after });
      }
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // ---- mask drawing ----
  //
  // The armed tool comes from the Inspector (mask-tool.svelte.js). While one
  // is armed and this box is selected, a transparent overlay takes the
  // pointer and turns gestures into mask shapes, committed one per gesture
  // with one undo record each, like the path gizmo's drags.
  // A warped box takes them too: a mask shape is stated in box-local px and is
  // applied to the texture BEFORE the mesh carries it, so the pointer is taken
  // back through the mesh on the way in (`maskShapePoint`) and the outlines
  // forward through it on the way out (`maskOutline`).
  const maskArmed = $derived(selected && !editing && !bulkOn && s.clip?.on && maskTool.id);

  // The gesture in progress: a shape being drawn, not yet in the style.
  const maskDraft = $state({ shape: null, poly: null });

  // A pointer event in box-local page px: page coords from the page frame,
  // then inverse-rotated around the box centre - the SCREEN frame, where the
  // liquify ring is drawn. Every gizmo that stores points takes one step more
  // (`maskLocal`).
  function maskPoint(ev) {
    return screenPoint(ev.clientX, ev.clientY, pageFrameEl.getBoundingClientRect(), app.zoom, box);
  }

  // The same point in the frame the mask shapes, the warp mesh and the path
  // are stored in: unflipped, because all three are applied before the flip
  // (`wrapMirror`), so what they move lands - once mirrored with the box -
  // under the pointer that moved it.
  function maskLocal(ev) {
    return flipPoint(maskPoint(ev), box);
  }

  // The mesh the mask is carried through on screen, or null for a box that is
  // not warped. The shapes are cut from the texture before the mesh moves it,
  // so a pointer on the deformed picture is taken back through the mesh to
  // the texture point under it (`maskShapePoint`), and a stored shape is drawn
  // forward through it (`maskOutline`) to sit on the cut it makes.
  const maskMesh = $derived(warped ? meshMap(s.warp.pts, s.warp.cols, s.warp.rows, box.w, box.h) : null);

  function maskShapePoint(ev) {
    const p = maskLocal(ev);
    return maskMesh ? unwarpPoint(s.warp.pts, s.warp.cols, s.warp.rows, box.w, box.h, p[0], p[1]) : p;
  }

  // Stored points as an SVG points list at the zoom. Through a mesh, a
  // straight edge in the texture is a curve on screen, so each edge is cut
  // into steps of a few page px before it is carried.
  function maskOutline(pts, closed = false) {
    let out = pts;
    if (maskMesh) {
      out = [];
      const n = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 4));
        for (let t = 0; t < k; t++) out.push(maskMesh.at(ax + ((bx - ax) * t) / k, ay + ((by - ay) * t) / k));
      }
      if (!closed && pts.length) out.push(maskMesh.at(...pts[pts.length - 1]));
    }
    return out.map(([px, py]) => `${px * z},${py * z}`).join(' ');
  }

  // An ellipse as the polygon `maskOutline` can carry through a mesh.
  function ellipsePts(sh) {
    const n = 48;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return [sh.cx + sh.rx * Math.cos(a), sh.cy + sh.ry * Math.sin(a)];
    });
  }

  // A shape changes the verdict as well as the picture: an include mask cuts
  // the ink the check counts (contain.js), and the fit effect does not read the
  // mask, so the flag is brought up to date here.
  function commitMaskShape(shape) {
    const styleBefore = cloneStyle(box.style);
    s.clip.shapes = [...s.clip.shapes, shape];
    markUnsaved();
    reviewBox(box, pg);
    record({ t: 'style', pageId: pg.id, boxId: box.id, before: styleBefore, after: cloneStyle(box.style) });
  }

  function onMaskPointerDown(e) {
    if (e.button !== 0 || !maskArmed || !pageFrameEl) return;
    e.preventDefault();
    e.stopPropagation();
    const p = maskShapePoint(e);
    // The polygon is click-built rather than dragged; the other two are drags.
    if (maskTool.id === 'poly') {
      maskDraft.poly = [...(maskDraft.poly ?? []), p];
      return;
    }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const start = p;
    if (maskTool.id === 'brush') maskDraft.shape = { kind: 'stroke', size: s.clip.brushSize, pts: [p] };
    else maskDraft.shape = { kind: 'ellipse', cx: p[0], cy: p[1], rx: 0, ry: 0 };
    const move = (ev) => {
      if (ev.pointerId !== pid || !maskDraft.shape) return;
      const q = maskShapePoint(ev);
      if (maskDraft.shape.kind === 'stroke') {
        const last = maskDraft.shape.pts[maskDraft.shape.pts.length - 1];
        if (Math.hypot(q[0] - last[0], q[1] - last[1]) > 1.5) maskDraft.shape.pts.push(q);
      } else {
        maskDraft.shape.cx = (start[0] + q[0]) / 2;
        maskDraft.shape.cy = (start[1] + q[1]) / 2;
        maskDraft.shape.rx = Math.abs(q[0] - start[0]) / 2;
        maskDraft.shape.ry = Math.abs(q[1] - start[1]) / 2;
      }
    };
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      const sh = maskDraft.shape;
      maskDraft.shape = null;
      if (!sh) return;
      // An ellipse too small to see was a slip, not a shape.
      if (sh.kind === 'ellipse' && (sh.rx < 1 || sh.ry < 1)) return;
      commitMaskShape(sh);
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // ---- liquify ----
  //
  // The Effects panel's liquify sub-tab: a round tool that pushes the box's
  // MESH around under the pointer, so the type and the ink bend together
  // through the same texture the transform gizmo deforms by hand. The maths is
  // `liquify.js`, the gesture - the snapshot, the one commit, the cancel - is
  // `liquify-mesh.js`; what lives here is the pointer, the clock, the circle
  // the cursor draws, and the cached-texture repaint the gizmo also uses.
  //
  // `liquifyEnd` is how a gesture in flight is ended from anywhere: the pointer
  // coming up, Escape, a cancelled pointer, and the two endings that arrive
  // with no pointer event at all - the capture surface being unmounted, and
  // this box being destroyed. Null when no gesture is running.
  let liquifyEnd = null;
  let liquifyAt = $state(null);
  const liquifyOn = $derived(
    selected &&
      !editing &&
      !bulkOn &&
      !brushArmed() &&
      !!pageFrameEl &&
      inspectorTab.id === 'effects' &&
      effectsSubTab.id === 'liquify',
  );
  const liquifyRing = $derived(
    liquifyOn && liquifyAt
      ? { x: liquifyAt[0], y: liquifyAt[1], d: liquifySettings().radius * 2 * z }
      : null,
  );

  function onLiquifyPointerDown(e) {
    if (e.button !== 0 || !liquifyOn) return;
    e.preventDefault();
    e.stopPropagation();
    // A second pointer mid-gesture ends the first as a cancel: a pointer that
    // never came up did not finish.
    liquifyEnd?.(false);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const g = liquifyMeshGesture(box, pg.id, liquifySettings());
    // The texture is rendered once, here, and every move re-warps it - the
    // same trade the transform gizmo makes, for the same reason.
    warpPainter.begin();
    const ac = new AbortController();
    // The ring is drawn where the pointer is, in the screen frame; the mesh is
    // pushed in its own, unflipped one (`maskLocal`), so on a flipped box the
    // push is mirrored into the mesh and lands, flipped back, under the ring
    // and the way the pointer went.
    liquifyAt = maskPoint(e);
    let [lx, ly] = flipPoint(liquifyAt, box);
    let lastT = e.timeStamp;
    liquifyEnd = (commit) => {
      liquifyEnd = null;
      live.delete(ac);
      ac.abort();
      if (commit) g.commit();
      else g.cancel();
      warpPainter.end();
    };
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      liquifyAt = maskPoint(ev);
      const [x, y] = flipPoint(liquifyAt, box);
      const scale = frameScaleFor(ev.timeStamp - lastT);
      lastT = ev.timeStamp;
      if (g.step({ cx: x, cy: y, dx: x - lx, dy: y - ly, scale })) warpPainter.frame();
      lx = x;
      ly = y;
    };
    const up = (ev) => {
      if (ev.pointerId === pid) liquifyEnd?.(true);
    };
    const cancel = (ev) => {
      if (ev.pointerId === pid) liquifyEnd?.(false);
    };
    // Escape puts the mesh back exactly as the pointer found it, and ONLY that:
    // capture phase so App's window handler cannot also read it as "deselect".
    const key = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      liquifyEnd?.(false);
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', up, { signal: ac.signal });
    document.addEventListener('pointercancel', cancel, { signal: ac.signal });
    document.addEventListener('keydown', key, { signal: ac.signal, capture: true });
  }

  function onLiquifyPointerMove(e) {
    if (!liquifyOn || liquifyEnd) return;
    liquifyAt = maskPoint(e);
  }
  function onLiquifyPointerLeave() {
    if (!liquifyEnd) liquifyAt = null;
  }

  // The capture surface can go away mid-drag with no pointer event: the
  // sub-tab changes, another box is selected, the brush is armed. Ended as a
  // cancel, like the mesh gizmo's teardown.
  $effect(() => {
    if (liquifyOn) return;
    untrack(() => {
      liquifyEnd?.(false);
      liquifyAt = null;
    });
  });
  $effect(() => () => {
    liquifyEnd?.(false);
    liquifyAt = null;
  });

  // Double-click closes the polygon; Escape drops it.
  function onMaskDblClick(e) {
    if (maskTool.id !== 'poly' || !maskDraft.poly) return;
    e.preventDefault();
    e.stopPropagation();
    const pts = maskDraft.poly;
    maskDraft.poly = null;
    if (pts.length >= 3) commitMaskShape({ kind: 'poly', pts });
  }
  $effect(() => {
    if (!maskArmed) {
      maskDraft.poly = null;
      maskDraft.shape = null;
      return;
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && maskDraft.poly) {
        e.preventDefault();
        maskDraft.poly = null;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Everything the mask overlay draws: committed shapes plus the draft.
  const maskShapesShown = $derived.by(() => {
    if (!(selected && !editing && !bulkOn && s.clip?.on)) return null;
    const out = [...s.clip.shapes];
    if (maskDraft.shape) out.push(maskDraft.shape);
    return out;
  });

  // Right-click on a path anchor removes it (the path keeps at least two).
  function onAnchorContextMenu(e, i) {
    e.preventDefault();
    e.stopPropagation();
    const next = removePathAnchor(s.path.pts, i);
    if (next === s.path.pts) return;
    const styleBefore = cloneStyle(box.style);
    s.path.pts = next;
    markUnsaved();
    reviewBox(box, pg);
    record({ t: 'style', pageId: pg.id, boxId: box.id, before: styleBefore, after: cloneStyle(box.style) });
  }

  // The gizmo's polyline, in zoomed box-local px.
  const gizmoLine = $derived.by(() => {
    if (!(selected && !editing && !bulkOn && s.path?.on && (s.path.pts?.length ?? 0) >= 2)) return null;
    return pathPolyline(s.path.pts, z)
      .map((p) => `${p[0]},${p[1]}`)
      .join(' ');
  });

  // Inline contenteditable undo stack.
  const fieldUndo = createFieldUndo();

  // ===== typing into the box (UX-4) =====
  // The box being typed into shows the lines the result draws - `shaped`, laid
  // over the raw text by `editLines` and drawn by `drawEditLines`, one element
  // per line - instead of letting the browser wrap the raw text its own way. So
  // the browser cannot be allowed to change that DOM: every edit is made to the
  // raw text here, from where the browser says it goes, and the lines are drawn
  // again from the result. Composition (an IME) is the one exception, because
  // its text is not final until it ends; it is left to the browser and read
  // back then. Curved text is edited the same way, in an editable nobody sees
  // (see "typing on the curve" below).
  const editSegs = $derived(editing && shaped ? editLines(text, applyCase(text, s), shaped) : null);
  // What a line's hidden head or tail would take up on it, in zoomed px.
  const hangWidth = (str) => charWidths(str, s, effSize).reduce((a, w) => a + w + effLs, 0);
  // Where the caret goes when the lines are next drawn, as a raw offset.
  let caretNext = null;
  let composing = false;
  // The editable, for the curve's pointer handlers, and its selection as raw
  // offsets (anchor, focus), which is what the caret on the curve is drawn from.
  let editEl = null;
  let edSel = $state(null);

  function editField(node) {
    let first = true;
    editEl = node;
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel.rangeCount || !node.contains(sel.focusNode)) return;
      const a = rawOffset(node, sel.anchorNode, sel.anchorOffset);
      const f = rawOffset(node, sel.focusNode, sel.focusOffset);
      if (a != null && f != null) edSel = { a, f };
    };
    $effect(() => {
      document.addEventListener('selectionchange', onSel);
      return () => {
        document.removeEventListener('selectionchange', onSel);
        if (editEl === node) editEl = null;
        edSel = null;
      };
    });
    $effect(() => {
      editSegs;
      indents;
      text;
      effSize;
      effLs;
      if (composing) return;
      untrack(() => {
        if (first) {
          first = false;
          resyncField(fieldUndo, text);
          node.focus();
          drawEdit(node, null);
        } else drawEdit(node, caretNext ?? caretNow(node) ?? text.length);
        caretNext = null;
      });
    });
  }

  // Draws the lines and puts the caret at raw offset `caret`, or selects all.
  function drawEdit(node, caret) {
    drawEditLines(node, text, editSegs, hangWidth, indents && { side: s.align, px: indents.map((v) => v * z) });
    const r = document.createRange();
    if (caret == null) r.selectNodeContents(node);
    else {
      const [c, i] = domPoint(node, Math.min(caret, text.length));
      r.setStart(c, i);
      r.collapse(true);
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    // Now, not at the selectionchange that follows, so the caret on the curve
    // is never drawn for one frame at the old offset on the new glyphs.
    const o = caret == null ? null : Math.min(caret, text.length);
    edSel = o == null ? { a: 0, f: text.length } : { a: o, f: o };
  }

  function caretNow(node) {
    const sel = window.getSelection();
    return sel.rangeCount ? rawOffset(node, sel.focusNode, sel.focusOffset) : null;
  }

  // The raw span an edit replaces: where the browser says it goes, else the
  // selection.
  function editSpan(node, e) {
    const sel = window.getSelection();
    const r = e?.getTargetRanges?.()[0] ?? (sel.rangeCount ? sel.getRangeAt(0) : null);
    if (!r) return null;
    const a = rawOffset(node, r.startContainer, r.startOffset);
    const b = rawOffset(node, r.endContainer, r.endOffset);
    return a == null || b == null ? null : [Math.min(a, b), Math.max(a, b)];
  }

  // setBoxText routes text to line for free-typed boxes.
  function commitEdit(v, caret, inputType) {
    if (v === text) return;
    caretNext = caret;
    setBoxText(box, v);
    recordFieldEdit(fieldUndo, v, { atomic: isAtomicInput(inputType) });
    markUnsaved();
  }

  function applyEdit(node, span, inputType, data) {
    const r = rawEdit(node.textContent, span, inputType, data);
    if (r) commitEdit(r.v, r.caret, inputType);
  }

  function onEditBeforeInput(e) {
    const t = e.inputType;
    if (e.isComposing || t.includes('Composition')) return;
    e.preventDefault();
    const node = e.currentTarget;
    if (t === 'historyUndo' || t === 'historyRedo') return stepField(node, t === 'historyRedo');
    const span = editSpan(node, e);
    if (span) applyEdit(node, span, t, e.data ?? e.dataTransfer?.getData('text/plain'));
  }

  function onEditPaste(e) {
    e.preventDefault();
    const node = e.currentTarget;
    const span = editSpan(node);
    if (span) applyEdit(node, span, 'insertFromPaste', e.clipboardData?.getData('text/plain') ?? '');
  }

  // The browser's copy of the lines has a Return at every wrap and the hidden
  // spaces; what was selected is a slice of the raw text.
  function onEditCopy(e) {
    const node = e.currentTarget;
    const span = editSpan(node);
    if (!span || span[0] === span[1]) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', node.textContent.slice(...span));
    if (e.type === 'cut') applyEdit(node, span, 'deleteByCut');
  }

  // Whatever the browser did change - a composition, an input it would not let
  // be cancelled - is read back as raw text, and the lines drawn again.
  function readBack(node) {
    if (!node.isConnected) return;
    const caret = caretNow(node);
    const v = node.textContent;
    if (v !== text) commitEdit(v, caret ?? v.length, 'insertText');
    else drawEdit(node, caret ?? v.length);
  }
  function onEditInput(e) {
    if (!composing) readBack(e.currentTarget);
    else if (curveEdit) composeText = e.currentTarget.textContent;
  }
  function onCompositionStart() {
    composing = true;
  }
  function onCompositionEnd(e) {
    composing = false;
    const node = e.currentTarget;
    // WebKit ends the composition before its last input lands.
    setTimeout(() => {
      composeText = null;
      readBack(node);
    });
  }

  function onEditBlur(e) {
    composeText = null;
    endEdit(e.currentTarget.textContent);
  }
  function onEditKey(e) {
    if (curveEdit && !e.isComposing && !e.altKey && !e.ctrlKey && curveKey(e)) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      stepField(e.currentTarget, e.shiftKey);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }

  // One step of the field's own undo; the caret goes where the text changed.
  function stepField(node, redo) {
    const next = redo ? redoField(fieldUndo) : undoField(fieldUndo);
    if (next == null) return;
    caretNext = caretAfter(node.textContent, next);
    setBoxText(box, next);
    markUnsaved();
  }

  // ----- typing on the curve -----
  // The editable nobody sees wraps the raw text at the box's width, so where
  // the browser would put a caret for a click, or for Home and End, is its
  // flat layout's idea and not the curve's. So those are placed here, on the
  // glyphs, and the browser keeps the rest: Left and Right step through the
  // raw text, which is the order the glyphs run in, and every edit goes
  // through `beforeinput` as flat text's does.

  // The caret and the selection, on the glyphs being drawn.
  const curveMarks = $derived.by(() => {
    if (!curveEdit || !edSel) return null;
    const t = composeText ?? text;
    const glyphs = layout ?? [];
    const a = glyphIndex(t, edSel.a);
    const f = glyphIndex(t, edSel.f);
    return { caret: a === f ? caretAt(glyphs, f) : null, sel: selectionBoxes(glyphs, a, f) };
  });

  // Selects raw [a, f] in the editable (a caret when they are equal).
  function setRawSel(a, f) {
    const node = editEl;
    if (!node) return;
    const [ac, ai] = domPoint(node, a);
    const [fc, fi] = domPoint(node, f);
    window.getSelection().setBaseAndExtent(ac, ai, fc, fi);
    edSel = { a, f };
  }

  // The raw offset nearest a pointer, on the glyphs. The overlay is the box,
  // so the centre of its screen rect is the box centre whatever the turn; the
  // turn is undone around it, and the box is never mirrored while typed into
  // (`wrapMirror`), so the point is then in the glyphs' own frame.
  function curvePoint(el, e) {
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const rad = (-(s.rotation || 0) * Math.PI) / 180;
    return [dx * Math.cos(rad) - dy * Math.sin(rad), dx * Math.sin(rad) + dy * Math.cos(rad)];
  }
  function curveOffset(el, e) {
    const t = editEl?.textContent ?? text;
    return rawIndex(t, caretNearest(layout ?? [], ...curvePoint(el, e)));
  }

  // A click puts the caret at the glyph under it, a drag selects, and Shift
  // extends. Default prevented, so the editable keeps the focus.
  function onCurvePointerDown(e) {
    if (e.button !== 0 || !editEl || composing) return;
    e.preventDefault();
    const el = e.currentTarget;
    const o = curveOffset(el, e);
    const anchor = e.shiftKey && edSel ? edSel.a : o;
    setRawSel(anchor, o);
    el.setPointerCapture?.(e.pointerId);
    const move = (ev) => setRawSel(anchor, curveOffset(el, ev));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // A double-click selects the word, and is the box's no further: the box's
  // own double-click is the one that opens the edit.
  function onCurveDblClick(e) {
    e.stopPropagation();
    if (!editEl || composing) return;
    // The glyph under the pointer, not the caret beside it: the right half of
    // a word's last letter puts the caret after the word, on the space.
    const g = glyphNearest(layout ?? [], ...curvePoint(e.currentTarget, e));
    if (!g) return;
    const [a, b] = wordAt(editEl.textContent, rawIndex(editEl.textContent, g.i));
    setRawSel(a, b);
  }

  // Home, End, Up and Down on the curve (`caretKey`); true when it took the key.
  function curveKey(e) {
    const node = e.currentTarget;
    const sel = window.getSelection();
    if (!sel.rangeCount) return false;
    const a = rawOffset(node, sel.anchorNode, sel.anchorOffset);
    const f = rawOffset(node, sel.focusNode, sel.focusOffset);
    if (a == null || f == null) return false;
    const to = caretKey(node.textContent, f, e.key, e.metaKey);
    if (to == null) return false;
    e.preventDefault();
    setRawSel(e.shiftKey ? a : to, to);
    return true;
  }

  const corners = [['corner', 'nw'], ['corner', 'ne'], ['corner', 'sw'], ['corner', 'se']];
  const sides = [['side', 'n'], ['side', 's'], ['side', 'w'], ['side', 'e']];
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="tbox"
  class:selected
  class:editing
  class:bulk-on={bulkOn}
  class:bulk-target={bulkTarget}
  class:flagged={!!review}
  data-id={box.id}
  style={boxStyle}
  bind:this={rootEl}
  onpointerdown={onBoxPointerDown}
  ondblclick={onDblClick}
>
  {#if s.roughen.on && !engineShown}
    <svg class="rough-def" width="0" height="0" aria-hidden="true">
      <!-- The filter runs in CSS px, which are ZOOMED px, so both of its numbers
           have to be turned back into the page's own units or the roughening is
           a different roughening at every zoom - and only ever matched the
           export at 100%. `amount` is a displacement, so it grows with the zoom;
           `detail` is a frequency, so it shrinks. The exporter states the same
           two numbers in page px against the same noise (see `roughen` and
           text-paint.js), which is what makes the export the picture on the
           canvas rather than one like it. -->
      <!-- The region has to hold the displacement as well as the text, and it is
           a share of the element's own size: a small box with a large `amount`
           had its crumple cut off square at the old -30%/160%, which the export
           (padded in absolute px) then did not do. Half the block again on every
           edge covers any amount the panel offers on any box worth reading. -->
      <filter id={roughId} x="-50%" y="-50%" width="200%" height="200%">
        <feTurbulence type="fractalNoise" baseFrequency={s.roughen.detail / z} numOctaves={OCTAVES} seed={s.roughen.seed} result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale={s.roughen.amount * z} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  {/if}

  {#if !engineShown && mbTaps.length}
    <svg class="rough-def" width="0" height="0" aria-hidden="true">
      <!-- The directional smear, as the exporter's tap list stated in SVG:
           every tap is shifted off the source and added into a running sum
           (feComposite/arithmetic, k2 = the tap's weight, k3 = 1), which is
           exactly the exporter's 'lighter' accumulation. sRGB interpolation,
           because canvas compositing is sRGB and the two smears must be one
           smear. Offsets are page px scaled by the zoom, like the blur
           radius. The first tap is the centre one (dx = dy = 0), so it seeds
           the sum straight off SourceGraphic. -->
      <filter id={mbId} x={mbRegion.x} y={mbRegion.y} width={mbRegion.w} height={mbRegion.h} color-interpolation-filters="sRGB">
        {#each mbTaps as t, i (i)}
          {#if i === 0}
            <feComposite in="SourceGraphic" in2="SourceGraphic" operator="arithmetic" k1="0" k2={t.w} k3="0" k4="0" result="p0" />
          {:else}
            <feOffset in="SourceGraphic" dx={t.dx * z} dy={t.dy * z} result={`t${i}`} />
            <feComposite in={`t${i}`} in2={`p${i - 1}`} operator="arithmetic" k1="0" k2={t.w} k3="1" k4="0" result={`p${i}`} />
          {/if}
        {/each}
      </filter>
    </svg>
  {/if}

  {#if selected && jp}
    <div class="jp-pill" class:sfx={isSfx} contenteditable="false">{jp}</div>
  {/if}

  {#if review}
    <!-- The "needs review" flag (UX-6): the text does not fit this box, and by
         how far - the containment check's verdict, never a clip. Outside the
         clip wrapper so a mask cannot hide it; it turns with the box, as the
         handles do. The reason is in the tooltip and in the queue's list.
         A solver overflow crosses no edge of the box - it is the balloon the
         text leaves - so it has no distance to show, only the mark. -->
    {@const reach = reviewReach(review)}
    <div class="review-badge" contenteditable="false" role="img" title={reviewTitle(review)} aria-label={reviewTitle(review)}>
      !{#if reach}<span>{reach}px</span>{/if}
    </div>
  {/if}

  <!-- What the solver may not change on this box, and the way to let it go (FIT-5). -->
  <LockChip {box} />

  <!-- The wrapper exists for the mask: `mask-image` needs an element whose
       (0,0) is the box's own top-left, and the text stack is a centred flex
       child with no fixed origin. It replicates the box's flex layout and
       padding, so with the mask off it changes nothing. The selection
       handles and the jp pill stay outside it, unmasked. It also carries the
       flip, over the mask, as the export does (`wrapMirror`). -->
  <div
    class="clipwrap"
    style="justify-content:{justify};align-items:{alignItems};padding:{pad}px;{pictured ? '' : maskCss}{wrapMirror}"
  >
  {#if pictured}
    <!-- The whole box as one picture: type, ink and every filter, carried
         through the mesh by the exporter's painter. Placed off the box's own
         top-left by however far the deformed mesh reached past it, which is
         what `paintWarpedBox` hands back.
         The mask is NOT applied to it by the wrapper above: it is already
         inside these pixels, because `renderBox` composites it before the mesh
         carries the texture, and applying it a second time in box coordinates
         would crop the warped picture against the unwarped shape.
         The mirror IS applied, by the wrapper, for the opposite reason: the
         export flips the finished bitmap around the box's centre rather than
         baking the flip into it (see paintBoxOnPage).
         The engine's picture of an unwarped box is the same canvas for the
         same reasons - `renderBoxTexture` has the mask in it and neither the
         flip, the turn nor the opacity, which stay CSS on the wrapper and on
         the box - set on whole device pixels where that keeps it sharp
         (`pictureCss`). -->
    <canvas
      class="warpl"
      bind:this={warpEl}
      data-painter={engineShown ? 'engine' : undefined}
      style={warpGeom
        ? engineShown
          ? pictureCss(warpGeom, z, displayScale(), s.rotation || mirror ? null : box)
          : `left:${-warpGeom.ox * z}px;top:${-warpGeom.oy * z}px;width:${warpGeom.cw * z}px;height:${warpGeom.ch * z}px;`
        : 'left:0;top:0;width:0;height:0'}
      aria-hidden="true"
    ></canvas>
  {:else}
    {#if layout}
      <!-- Curved text is placed glyph by glyph, so each layer of the stack is a
           full set of glyph spans; they are all absolutely positioned already, so
           no layer has to hold the others up. -->
      <div class="arcstack" style={filterCss}>
        {#each layers as ly, li (li)}
          <div class="arc" style={ly.arc}>
            {#each layout as g, i (i)}
              <span
                class="arc-ch"
                style="{textStyle}{ly.bg
                  ? `${ly.bg}background-size:${ly.tile ? `${ly.tile}px ${ly.tile}px` : `${box.w * z}px ${box.h * z}px`};background-position:${-((box.w * z) / 2 + g.x - g.w / 2)}px ${-((box.h * z) / 2 + g.y - effSize / 2)}px;`
                  : ''}transform:translate(calc(-50% + {g.x}px), calc(-50% + {g.y}px)) rotate({g.rot}rad)"
              >{g.ch}</span>
            {/each}
          </div>
        {/each}
      </div>
    {/if}
    {#if editing}
      {#if curveEdit}
        <!-- Curved text being typed into: the glyphs above are the result's,
             and this draws the caret and the selection on them and takes the
             pointer, so a click lands on the glyph under it rather than in the
             editable below, which holds the text and is not seen. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="curve-edit" onpointerdown={onCurvePointerDown} onmousedown={(e) => e.preventDefault()} ondblclick={onCurveDblClick}>
          {#if curveMarks}
            {#each curveMarks.sel as r, i (i)}
              <span class="csel" style="width:{r.w}px;height:{effSize}px;transform:translate(calc(-50% + {r.x}px), calc(-50% + {r.y}px)) rotate({r.rot}rad)"></span>
            {/each}
            {#if curveMarks.caret}
              {@const c = curveMarks.caret}
              <span class="ccaret" style="height:{effSize}px;transform:translate(calc(-50% + {c.x}px), calc(-50% + {c.y}px)) rotate({c.rot}rad)"></span>
            {/if}
          {/if}
        </div>
      {/if}
      <div
        class="txt editable"
        class:ghost={curveEdit}
        contenteditable="true"
        style="{editStyle}{inkShift ? `transform:translateY(${inkShift}px);` : ''}"
        use:editField
        onbeforeinput={onEditBeforeInput}
        oninput={onEditInput}
        oncompositionstart={onCompositionStart}
        oncompositionend={onCompositionEnd}
        onpaste={onEditPaste}
        oncopy={onEditCopy}
        oncut={onEditCopy}
        ondragstart={(e) => e.preventDefault()}
        onblur={onEditBlur}
        onkeydown={onEditKey}
      ></div>
    {:else if !layout}
      <div class="txt shaped stack" style="{textStyle}{stackTransform}{filterCss}">
        {#each layers as ly, li (li)}
          <div class="tlayer" class:base={li === 0} style={ly.css}>
            {#each shaped as ln, i (i)}<div class="tline" style="{ly.line}{indentCss(i)}">{ln === '' ? '\u200b' : ln}</div>{/each}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
    {#if !pictured && inkActive(s.ink)}
      <!-- Inside the clip wrapper so the visibility mask hides ink the same way
           it hides letters; positioned off the box's own top-left, offset by the
           overhang the canvas was grown by. -->
      <canvas
        class="inkl"
        bind:this={inkEl}
        style="left:{-inkPad.l * z}px;top:{-inkPad.t * z}px;width:{(box.w + inkPad.l + inkPad.r) * z}px;height:{(box.h + inkPad.t + inkPad.b) * z}px"
        aria-hidden="true"
      ></canvas>
    {/if}
  </div>

  {#if gizmoLine}
    <!-- The path gizmo: the baked curve, an anchor dot per point and its two
         handle dots, all draggable. Outside the clip wrapper on purpose - the
         curve must stay visible where the clip has cropped the letters - and
         so it carries the box's flip itself, as the curve the letters follow does. -->
    <svg class="path-gizmo" width={box.w * z} height={box.h * z} style={overlayMirror} aria-hidden="true">
      <polyline points={gizmoLine} />
      {#each s.path.pts as p, i (i)}
        <line x1={p.x * z} y1={p.y * z} x2={(p.x + p.ix) * z} y2={(p.y + p.iy) * z} />
        <line x1={p.x * z} y1={p.y * z} x2={(p.x + p.ox) * z} y2={(p.y + p.oy) * z} />
        <rect class="ph" x={(p.x + p.ix) * z - 4} y={(p.y + p.iy) * z - 4} width="8" height="8" onpointerdown={(e) => startPathDrag(e, i, 'in')} />
        <rect class="ph" x={(p.x + p.ox) * z - 4} y={(p.y + p.oy) * z - 4} width="8" height="8" onpointerdown={(e) => startPathDrag(e, i, 'out')} />
        <circle class="pa" cx={p.x * z} cy={p.y * z} r="5" onpointerdown={(e) => startPathDrag(e, i, 'a')} oncontextmenu={(e) => onAnchorContextMenu(e, i)} />
      {/each}
    </svg>
  {/if}

  {#if maskShapesShown}
    <!-- The mask overlay: committed shapes (and the drag in progress) drawn
         as outlines so the user can see what they have painted, plus - while
         a tool is armed - a full-coverage capture surface that turns the
         pointer into shapes. Outside the clip wrapper on purpose: the
         outlines must stay visible where the mask has hidden the letters. -->
    <!-- Mirrored with the box, as the mask it outlines is. -->
    <svg
      class="mask-gizmo"
      class:excl={s.clip.mode === 'exclude'}
      width={box.w * z}
      height={box.h * z}
      style={overlayMirror}
      aria-hidden="true"
    >
      {#if maskArmed}
        <rect
          class="capture"
          x={-MASK_EXPAND * z}
          y={-MASK_EXPAND * z}
          width={(box.w + MASK_EXPAND * 2) * z}
          height={(box.h + MASK_EXPAND * 2) * z}
          onpointerdown={onMaskPointerDown}
          ondblclick={onMaskDblClick}
        />
      {/if}
      {#each maskShapesShown as sh, i (i)}
        {#if sh.kind === 'ellipse' && !maskMesh}
          <ellipse cx={sh.cx * z} cy={sh.cy * z} rx={sh.rx * z} ry={sh.ry * z} />
        {:else if sh.kind === 'ellipse' || sh.kind === 'poly'}
          <polygon points={maskOutline(sh.kind === 'ellipse' ? ellipsePts(sh) : sh.pts, true)} />
        {:else}
          <polyline class="stroke" points={maskOutline(sh.pts)} style="stroke-width:{sh.size * z}px" />
        {/if}
      {/each}
      {#if maskDraft.poly}
        <polyline class="draft" points={maskOutline(maskDraft.poly)} />
        {#each maskDraft.poly as p, i (i)}
          {@const [px, py] = maskMesh ? maskMesh.at(p[0], p[1]) : p}
          <circle class="vert" cx={px * z} cy={py * z} r="3.5" />
        {/each}
      {/if}
    </svg>
  {/if}

  {#if liquifyOn}
    <!-- The surface that turns a drag into a liquify. Full-box and on top, the
         same shape the mask tool's capture rect has; without it the drag lands
         on the box and moves it instead. Outside the clip wrapper so a mask
         cannot hide it. -->
    <div
      class="liq-capture"
      style="width:{box.w * z}px;height:{box.h * z}px"
      onpointerdown={onLiquifyPointerDown}
      onpointermove={onLiquifyPointerMove}
      onpointerenter={onLiquifyPointerMove}
      onpointerleave={onLiquifyPointerLeave}
      aria-hidden="true"
    ></div>
  {/if}

  {#if liquifyRing}
    <!-- The tool's own circle, at its radius in PAGE px times the zoom: what
         the next application would reach. Drawn rather than made a CSS cursor
         because the radius goes to 300 page px and a cursor image cannot. -->
    <div
      class="liq-ring"
      style="left:{liquifyRing.x * z}px;top:{liquifyRing.y * z}px;width:{liquifyRing.d}px;height:{liquifyRing.d}px"
      aria-hidden="true"
    ></div>
  {/if}

  {#if warpGizmoOn}
    <!-- The mesh's handles. `maskLocal` is the box's own client -> box-local
         conversion, rotation undone and the flip mirrored out - the frame the
         mesh is stored in - and the gizmo takes it rather than working the same
         thing out a second time. -->
    <WarpGizmo {box} pageId={pg.id} {z} toLocal={maskLocal} painter={warpPainter} />
  {/if}

  <!-- The box's own resize and rotate handles stand down while the gizmo is up.
       They have to: a 1x1 mesh puts a control point on each corner of the box,
       exactly where the corner resize handles sit, and two controls in one place
       is a coin toss over which one a drag gets. The gizmo's handles are the
       ones the sub-tab was opened for, so they win by being the only ones there
       - and the box still MOVES by its body, because a warp handle stops its own
       pointerdown from reaching it. -->
  {#if selected && !editing && !bulkOn && !warpGizmoOn}
    <div class="rotate-stem"></div>
    {#each corners as [kind, dir] (dir)}
      <div class="handle {kind} {dir}" onpointerdown={(e) => startTransform(e, dir)}></div>
    {/each}
    {#each sides as [kind, dir] (dir)}
      <div class="handle {kind} {dir}" onpointerdown={(e) => startTransform(e, dir)}></div>
    {/each}
    <div class="handle rot" onpointerdown={(e) => startTransform(e, 'rot')}></div>
  {/if}
</div>

<style>
  /* The layer stack. Every layer holds the same lines and lays out identically;
     the first one is in flow and gives the block its height, the rest sit over
     it. A layer's own transform (a shadow's offset) moves what is painted and
     not what is measured, so the stack cannot come apart. */
  .stack { position: relative; }
  .tlayer { position: absolute; left: 0; top: 0; width: 100%; }
  .tlayer.base { position: relative; }
  /* Curved layers are already absolute (.arc is inset:0), so this only has to
     give them something to be absolute inside. */
  .arcstack { position: absolute; inset: 0; }
  /* The clip wrapper mirrors the box's own flex layout (justify/align/padding
     are inlined per box) so the text lands exactly where it did as a direct
     child. Its border box IS the box rect, which is the frame the clip-path
     is stated in. */
  .clipwrap { position: absolute; inset: 0; display: flex; box-sizing: border-box; }
  /* The ink layer. Absolute so it does not disturb the text's flex centring,
     and never a pointer target: the strokes are drawn on the brush board and
     placed here whole. */
  .inkl {
    position: absolute;
    pointer-events: none;
  }
  /* The warped box. Same shape as the ink layer - absolute, never a pointer
     target - and `user-select:none` because there is no text under the cursor
     here to select, only pixels. */
  .warpl {
    position: absolute;
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
  }
  /* The path gizmo. The svg itself lets clicks through to the box; only the
     anchors and handles take the pointer. High-contrast colours so the curve
     and handles read well on both white pages and dark art. */
  .path-gizmo { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .path-gizmo polyline { fill: none; stroke: #00d5e0; stroke-width: 1.5; }
  .path-gizmo line { stroke: #663399; stroke-width: 1; }
  .path-gizmo .pa, .path-gizmo .ph { pointer-events: all; cursor: grab; }
  .path-gizmo .pa { fill: #e33; stroke: #fff; stroke-width: 1; }
  .path-gizmo .ph { fill: #fff; stroke: #663399; stroke-width: 1; }
  /* The mask overlay. Shape outlines are hints, not paint: red for exclusion
     (this ink goes away), teal for inclusion (this ink stays). The capture
     rect is the drawing surface while a tool is armed; it reaches past the
     box exactly as far as the mask image does. */
  .mask-gizmo { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
  .mask-gizmo .capture { fill: transparent; pointer-events: all; cursor: crosshair; }
  .mask-gizmo ellipse, .mask-gizmo polygon { fill: rgba(0, 180, 190, 0.14); stroke: #00b4be; stroke-width: 1; }
  .mask-gizmo .stroke { fill: none; stroke: rgba(0, 180, 190, 0.3); stroke-linecap: round; stroke-linejoin: round; }
  .mask-gizmo.excl ellipse, .mask-gizmo.excl polygon { fill: rgba(230, 60, 60, 0.14); stroke: #e33; }
  .mask-gizmo.excl .stroke { stroke: rgba(230, 60, 60, 0.3); }
  .mask-gizmo .draft { fill: none; stroke: #f90; stroke-width: 1.5; stroke-dasharray: 4 3; }
  .mask-gizmo .vert { fill: #f90; stroke: #fff; stroke-width: 1; }
  /* The liquify tool's capture surface. `touch-action: none` so a pen or a
     finger drags instead of scrolling the page out from under the tool. */
  .liq-capture {
    position: absolute;
    left: 0;
    top: 0;
    cursor: crosshair;
    touch-action: none;
    z-index: 3;
  }
  /* Liquify draws its own circle, and the crosshair inside it says where the
     centre is - so both are shown. A darker ring under the first, so the circle
     reads on white paper and on black art alike. */
  .liq-ring {
    position: absolute;
    border: 1px solid rgba(255, 153, 0, 0.9);
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35) inset;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 4;
  }
  .jp-pill {
    font-family: 'Noto Sans JP', 'Hiragino Kaku Gothic Pro', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', sans-serif;
  }
</style>
