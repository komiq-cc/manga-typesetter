<script>
  // Editor canvas viewport and page rendering.
  import { onMount, untrack } from 'svelte';
  import TextBox from '../TextBox.svelte';
  import {
    app,
    page,
    placeActiveAt,
    addEmptyBox,
    setPageDims,
    setPageDimsForSrc,
    deselect,
    lineByN,
    applyFit,
    setZoom,
    setZoomLive,
    isTranslateMode,
    isLongstrip,
    gotoPage,
    toast,
  } from '../store.svelte.js';
  import { rememberPagePixels, notePageImage } from '../page-pixels.js';
  import { wasPageImage, RESIDENT_RADIUS } from '../page-images.js';
  import {
    fitWidthZoom,
    maxPageWidth,
    pageIndexAtCenter,
    stripOffsets,
    stripFrameMetrics,
    focusHoldsIndex,
    focusedBoxHoldsIndex,
    residentRadiusFor,
    scrollFraction,
    stripResidentWindow,
    isBoxInStripWindow,
    stripFrameCoords,
    stripScrollTopForBox,
  } from './strip.js';
  import { publishStripScroll, stripReveal } from './strip-sync.svelte.js';

  // Handle for dock Fit button.
  let { onReady } = $props();

  let scrollEl;
  let stageEl;
  // Per-page frame element bindings.
  let stripEl = $state(null);
  let frameEls = $state([]);
  // The same, for a paged chapter's mounted window - see `mountedPages`. Indexed
  // by page index like `frameEls`, and sparse: only the window's own slots are
  // ever filled.
  let pagedFrameEls = $state([]);
  let lastFitKey = '';

  // Canvas pan state in CSS pixels.
  let pan = $state({ x: 0, y: 0 });
  // Tracks active pan gesture for hardware acceleration.
  let panLive = $state(false);
  // Minimum pixels of page retained in viewport.
  const KEEP = 96;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // Drop the hand-pan, if there is one to drop. The `if` is not a micro-tuning:
  // `pan` is read into the style string of every mounted frame, so assigning a
  // fresh `{x:0,y:0}` over an existing one rewrites the whole window's geometry
  // to say what it already said. `untrack`, because the callers are effects that
  // must not take a dependency on the value they are about to write.
  function resetPan() {
    if (untrack(() => pan.x !== 0 || pan.y !== 0)) pan = { x: 0, y: 0 };
  }

  // Work that has to happen but not now. `requestIdleCallback` is not in every
  // engine this ships to (WebKit only shipped it recently, and the test
  // environment has none at all), and the fallback is deliberately a plain
  // `setTimeout(0)` rather than a frame: the point is to get OFF the turn's
  // synchronous path, not to be scheduled precisely.
  const hasIdle = typeof requestIdleCallback === 'function';
  const idle = (fn) => (hasIdle ? requestIdleCallback(fn) : setTimeout(fn, 0));
  const cancelIdle = (id) => {
    if (!id) return;
    if (hasIdle) cancelIdleCallback(id);
    else clearTimeout(id);
  };

  // Every deferred pixel decode that has not run yet - see `onCleanedLoad`.
  //
  // Held so the unmount can cancel them, which is two things rather than
  // tidiness. Each of these closures captures the page's `<img>` ELEMENT, so a
  // callback the browser has not got round to is a detached element and its
  // decoded bitmap pinned for as long as the queue is starved; and a callback
  // that fires after the editor is gone repopulates a cache `closeChapter` has
  // just emptied, with the pixels of a chapter nobody is looking at.
  const pixelIdles = new Set();
  function queuePixels(pageId, src, img) {
    const id = idle(() => {
      pixelIdles.delete(id);
      rememberPagePixels(pageId, src, img);
    });
    pixelIdles.add(id);
  }

  // Base layout dimensions for pan clamping.
  function panBase(applied) {

    const el = strip ? stripEl : pageFrameEl;
    if (!scrollEl || !el) return null;
    const sr = scrollEl.getBoundingClientRect();
    const fr = el.getBoundingClientRect();
    return {
      ux: fr.left - sr.left - applied.x,
      uy: fr.top - sr.top - applied.y,
      fw: fr.width,
      fh: fr.height,
      vw: sr.width,
      vh: sr.height,
    };
  }

  // Bound a candidate offset against a base `panBase` measured earlier. `dl`/`dt`
  // are how far the container has been scrolled since that measurement: scrolling
  // right by n slides the frame left by n, so the frame's un-panned position
  // follows from arithmetic rather than from a second look at the layout.
  //
  // That split is what the drag needs. Every move writes scrollLeft/scrollTop and
  // then clamps, and a getBoundingClientRect between those two forces a
  // synchronous layout on every single pointermove - of the whole longstrip
  // column, in a strip. It also asked the DOM a question about a pan the DOM has
  // not necessarily been given yet, so the base it derived could disagree with
  // the offset it was clamping, and the page jittered at the edges of the range.
  function clampTo(next, base, dl = 0, dt = 0) {
    const ux = base.ux - dl;
    const uy = base.uy - dt;
    const keepX = Math.min(KEEP, base.fw);
    const keepY = Math.min(KEEP, base.fh);
    // Snapped to the device-pixel grid, not left fractional. Pointer clientX/Y
    // and the rect maths above are fractional, and a fractional translate on a
    // page scaled to a non-integer zoom changes the raster phase of every
    // screentone dot; WebKit re-rasterizes the layer at the new phase partway
    // through a drag and the whole page visibly shimmers for a frame.
    const dpr = window.devicePixelRatio || 1;
    const snap = (v) => Math.round(v * dpr) / dpr;
    return {
      x: snap(clamp(next.x, keepX - base.fw - ux, base.vw - keepX - ux)),
      // A strip does not pan vertically. Down the column IS the scroll - the
      // container always has somewhere to go, so a free offset could only ever
      // be built up at the two ends of the chapter, and the clamp that bounds it
      // is measured against the column's own height, which for a webtoon is tens
      // of thousands of pixels: one drag at the bottom would throw the whole
      // chapter off screen with nothing to grab. The horizontal axis keeps the
      // hand it always had, for a page zoomed wider than the viewport.
      y: strip ? 0 : snap(clamp(next.y, keepY - base.fh - uy, base.vh - keepY - uy)),
    };
  }

  // The at-rest form: measure and clamp in one breath. Every caller outside a
  // drag is answering a change that has already been laid out - a zoom, a
  // resize - so there is nothing to be gained by holding the measurement.
  function clampPan(next, applied) {
    const base = panBase(applied);
    return base ? clampTo(next, base) : next;
  }

  const p = $derived(page());
  const translate = $derived(isTranslateMode());
  // Every branch in this file is behind this one flag: a paged chapter draws and
  // behaves exactly as it did before longstrip existed.
  const strip = $derived(isLongstrip());
  // What a page draws, for any page rather than only the current one - both
  // branches below mount more than one page at a time.
  //
  // Typeset on the cleaned page when there is one; otherwise fall back to the
  // raw so an imported raws-only chapter still shows something to place on.
  //
  // A translate chapter is the other way round and not a fallback: the raw is
  // the page being read, and a cleaned raster - which has had the Japanese
  // painted out of it - is the one thing that cannot be translated from. So it
  // is `pg.raw` outright, and a chapter with no raw shows nothing rather than
  // quietly showing the cleaned art instead.
  const srcOf = (pg) => (translate ? pg.raw : (pg.cleaned ?? pg.raw));

  // ---------- the pages a paged chapter keeps in the DOM ----------
  //
  // A page turn used to be a teardown and a mount: the frame, the image and
  // every TextBox on the page destroyed, and the same number created again for
  // the page arrived at - each box re-deriving its paint stack and re-breaking
  // its lines from nothing. That is Svelte doing exactly what it was told, and
  // it is most of what a turn cost once the layout memo and the collapsed
  // double-fit had taken the rest.
  //
  // So the neighbours stay mounted and hidden instead, and the turn is a
  // `display:none` moving from one frame to the next. Two properties make that
  // pay rather than merely move the cost around:
  //
  //   `display:none`, not `visibility:hidden` or `content-visibility`. A hidden
  //   frame has to contribute NOTHING to layout - the fit is measured against
  //   `.editor-scroll`'s content box, and a second page in the stage's flex row
  //   would widen the scroll, raise a scrollbar and shrink the very number the
  //   fit is computed from. It also means no paint: no SVG roughening filter, no
  //   gradient tile, no page raster composited for a page nobody is looking at.
  //   Images inside it still LOAD, which is the half we want - see `onCleanedLoad`.
  //
  //   The window slides on an idle callback, not in the turn. A sliding window
  //   mounts one page and destroys one page per turn, so done synchronously this
  //   would have paid the same mount cost it set out to remove - only on a
  //   different page. Deferred, the turn itself touches nothing but the two
  //   frames whose visibility changed, and the page arrived at was mounted one
  //   turn ago.
  //
  // Radius 1, not the image window's 2. The pictures are held either side of it
  // because a decode cannot be started at the moment it is needed; a mounted
  // frame is only there to be revealed, and one page either side already covers
  // both directions of a turn. Every extra page is fifteen more live components
  // whose autofit effects re-run on every style change the user makes, so the
  // window is the smallest one that answers the question. It may never exceed
  // the image window: a mounted page whose picture has been revoked draws blank.
  const MOUNT_RADIUS = Math.min(1, RESIDENT_RADIUS);

  // Ids only, so the list survives a page object being replaced under it.
  let mountedIds = $state([]);
  // The current page is in the list whether or not the reconcile below has
  // caught up with it. That is what makes the deferral safe: a jump to a page
  // outside the window - the pager, a queue click, an undo - renders it on the
  // spot, and the idle pass only ever decides what to keep AROUND it.
  const mountedPages = $derived.by(() => {
    if (strip) return [];
    const cur = app.pageIndex;
    const out = [];
    for (let i = 0; i < app.pages.length; i++) {
      if (i === cur || mountedIds.includes(app.pages[i].id)) out.push({ pg: app.pages[i], i });
    }
    return out;
  });

  // ---------- the boxes a strip keeps in the DOM ----------
  //
  // A strip mounts a frame per page of the chapter on purpose - they are empty
  // divs of a known size, the column's scroll height has to be right before any
  // art arrives, and the note at the `{#each}` below says so. What that note
  // overlooked is that the frames are not what a page costs: the BOXES inside
  // them are. A 200-slice webtoon at fifteen boxes a slice mounted three
  // thousand `TextBox` components, each with its own line-breaking `$derived`,
  // its own autofit `$effect` and its own paint stack - and every one of them
  // re-derives `boxStyle`, `textStyle` and `layers` on each `app.zoom` tick, so
  // one trackpad pinch (sixty to a hundred events) was three thousand boxes of
  // string building per event. That is the shape of a webview that stops
  // answering.
  //
  // So boxes follow the resident artwork window: a box is mounted if its derived
  // painted strip bounds (rotation and effects included) intersect the resident
  // window, or if it is currently selected or being edited. Offscreen owner pages
  // with no visible boxes render no boxlayer elements.
  const stripLayout = $derived(strip ? stripOffsets(app.pages, app.zoom) : null);
  const unzoomedStripTops = $derived.by(() => {
    if (!strip) return [];
    return stripOffsets(app.pages, 1).tops;
  });

  const stripResident = $derived.by(() => {
    if (!strip) return null;
    const zoom = app.zoom || 1;
    const vh = typeof window === 'undefined' ? 0 : window.innerHeight;
    return stripResidentWindow(app.pages, unzoomedStripTops, app.pageIndex, vh / zoom);
  });

  const isBoxVisible = (box, pageIndex) => {
    if (!strip) return true;
    const isTarget = box?.id === app.selectedId || box?.id === app.editingId;
    if (isTarget) return true;
    if (!stripResident) return true;
    const ownerTop = unzoomedStripTops[pageIndex] ?? 0;
    return isBoxInStripWindow(box, ownerTop, stripResident.top, stripResident.bottom, isTarget);
  };

  const pageHasVisibleBoxes = (pg, pageIndex) => {
    if (!strip) return true;
    if (!pg?.boxes?.length) return false;
    return pg.boxes.some((b) => isBoxVisible(b, pageIndex));
  };

  // The visible frame, for everything that measures the page: pan clamping,
  // `frameCoords`, and TextBox's own rotation gesture. Never a hidden one - a
  // `display:none` element's rect is all zeros, and a drag measured against that
  // puts the box in the corner.
  const pageFrameEl = $derived(strip ? null : (pagedFrameEls[app.pageIndex] ?? null));

  let mountQueued = 0;
  // The page list the ids in `mountedIds` were taken from. Page ids are
  // per-document counters and collide freely across chapters, so a chapter
  // swapped under the editor leaves a window naming ids that belong to somebody
  // else's pages - which the filter above would happily resolve against the new
  // chapter and mount two arbitrary pages of it, hidden, until the next idle
  // pass. Dropped on the spot instead. Not `$state`: it is a record of what was
  // written, never something to re-render from.
  let mountedFrom = null;
  $effect(() => {
    const pages = app.pages;
    const index = app.pageIndex;
    if (pages !== mountedFrom) {
      mountedFrom = pages;
      if (untrack(() => mountedIds.length)) mountedIds = [];
    }
    if (strip) return;
    cancelIdle(mountQueued);
    // Every read of `mountedIds` in this effect is either untracked or inside
    // the idle callback, which runs outside the tracking scope entirely.
    // Tracked, this would take a dependency on the very thing it writes and
    // re-arm itself forever.
    mountQueued = idle(() => {
      mountQueued = 0;
      const lo = Math.max(0, index - MOUNT_RADIUS);
      const hi = Math.min(pages.length - 1, index + MOUNT_RADIUS);
      const next = [];
      for (let i = lo; i <= hi; i++) if (pages[i]) next.push(pages[i].id);
      // Same window as last time, in the same order: assigning would destroy and
      // rebuild nothing but still re-run every reader of this list.
      if (next.length === mountedIds.length && next.every((id, i) => id === mountedIds[i])) return;
      mountedIds = next;
    });
  });
  $effect(() => () => {
    cancelIdle(mountQueued);
    for (const id of pixelIdles) cancelIdle(id);
    pixelIdles.clear();
  });

  // Fit is "the whole page, plus the breathing room the stage draws around it,
  // inside the canvas viewport" - so the number it reports is a zoom at which
  // nothing is cut off. Three things it used to get wrong, all of which made the
  // percentage a small lie and left the page's edges hanging over the viewport:
  //   · the margin was 100 against a stage that pads 60 on each side, so it
  //     handed back a zoom 20px of page too wide to fit;
  //   · getBoundingClientRect() counts the scrollbar gutter, and this app styles
  //     ::-webkit-scrollbar, which in WebKit means classic scrollbars that take
  //     real layout space. Fitting to a width that includes the bar overflows,
  //     which raises the bar, which is how a fit ends up with scrollbars on it;
  //   · the margin was a constant in this file, mirroring --stage-pad, and it
  //     was a lie on the vertical axis the moment the two differed. That is the
  //     one that mattered most, because the stage's vertical padding is no
  //     longer plain --stage-pad: `.editor-scroll` spans the FULL window height
  //     - the chrome pills at the top and the zoom dock at the bottom float over
  //     it and inset nothing - so `.stage` raises its top and bottom padding to
  //     clear them. Fit has to reserve the same band the stylesheet reserves, or
  //     it reports a page as fitting into space that is behind the dock.
  //
  // So the pad is read off the element rather than mirrored: whatever `.stage`
  // is styled to keep clear, the fit keeps clear too, and there is no second
  // copy of the number to drift. clientWidth/clientHeight are the content box
  // without the scrollbars.
  function computeFit(force = false) {
    if (!scrollEl || !stageEl) return;
    const vw = scrollEl.clientWidth;
    const vh = scrollEl.clientHeight;
    const cs = getComputedStyle(stageEl);
    const px = (v) => parseFloat(v) || 0;
    const padX = px(cs.paddingLeft) + px(cs.paddingRight);
    const padY = px(cs.paddingTop) + px(cs.paddingBottom);
    // The pads are in the key too: a stylesheet whose padding responds to
    // anything - a media query, a theme - must re-fit, and the viewport size
    // alone would not have changed.
    // A strip fits its WIDTH and nothing else: the column is the whole chapter,
    // there is no height that could be made to fit, and the vertical axis is the
    // container's own scrolling. It is measured against the widest page rather
    // than the current one - a fit taken off a narrow slice would let a wide one
    // hang over both edges - so the key names that instead of one page's box.
    const key = strip
      ? `${vw}x${vh}+${padX}x${padY}@strip:${maxPageWidth(app.pages)}`
      : `${vw}x${vh}+${padX}x${padY}@${p.w}x${p.h}`;
    if (!force && key === lastFitKey) return;
    lastFitKey = key;
    const raw = strip
      ? fitWidthZoom(app.pages, vw, padX)
      : Math.min((vw - padX) / p.w, (vh - padY) / p.h);
    // Quantised to a thousandth, and it is not cosmetic. Two pages of a chapter
    // that differ by a single pixel in height - a scan trimmed by hand, a slice
    // cut at a different row - give fits that differ in the ninth decimal place,
    // and `app.zoom` is read by every box on the page: each of those turns into
    // a fresh `boxStyle` string, a fresh `textStyle`, a re-run of the whole
    // paint stack, for a change no display can show. At three decimals a 3000px
    // page moves by at most 3px between adjacent quanta, which is below what the
    // fit's own padding reserves, and a turn between two pages of the same size
    // writes no zoom at all.
    const z = Math.round(raw * 1000) / 1000;
    // A fit is "the whole page, centred, nothing cut off", which a leftover
    // hand-pan would immediately contradict. Fit is also the one control that
    // is always reachable, so this doubles as the way out of any pan.
    if (z > 0 && isFinite(z)) {
      resetPan();
      applyFit(z);
    }
  }

  // Every gesture in flight, so an unmount can end them all - see the same set
  // in FloatingPanel. The listeners live on `document` and nothing guarantees a
  // further pointer event once this component is gone.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  // A point in PAGE coordinates, and the page it belongs to. The pair travels
  // together because in a strip they are two answers to one question: the
  // chapter's pages are all on screen at once, so "where on the page" has no
  // meaning until "which page" has been settled, and the page the scroll
  // position happens to have made current is not it - the reader can click the
  // tail of the slice above or the head of the one below without the index
  // moving at all.
  //
  // Resolved from the event's own target rather than from geometry: the frame
  // is the element the press landed in, which is the same answer as a hit test
  // and cannot disagree with what the browser dispatched. Answers null when the
  // press was not inside a frame at all - in a paged chapter that is
  // unreachable (the caller has already demanded a press on `.boxlayer`), and
  // in a strip it is a press on the air beside the column.
  // Whether a page has a coordinate space at all. Until its art has been
  // decoded once a page is `w:0,h:0` (see `onCleanedLoad`), and anything that
  // clamps against those dimensions has nothing to clamp into.
  const measured = (pg) => pg?.w > 0 && pg?.h > 0;

  function frameCoords(e) {
    if (!strip) {
      // Null only between a chapter being swapped and the frame being bound; the
      // press that got here landed on a `.boxlayer` that had to be inside one.
      if (!pageFrameEl) return null;
      const r = pageFrameEl.getBoundingClientRect();
      return { x: (e.clientX - r.left) / app.zoom, y: (e.clientY - r.top) / app.zoom, pg: page() };
    }
    const n = app.pages.length;
    if (!n || !stripEl) return null;

    const el = e.target?.closest?.('[data-page-id]');
    if (el && el.dataset.pageId) {
      const pg = app.pages.find((q) => String(q.id) === el.dataset.pageId);
      if (pg) {
        const r = el.getBoundingClientRect();
        return { x: (e.clientX - r.left) / app.zoom, y: (e.clientY - r.top) / app.zoom, pg };
      }
    }

    const frames = frameEls.map((frame, i) =>
      frame
        ? {
            left: frame.getBoundingClientRect().left,
            right: frame.getBoundingClientRect().right,
            top: frame.getBoundingClientRect().top,
            bottom: frame.getBoundingClientRect().bottom,
            pg: app.pages[i],
          }
        : null,
    );
    const hit = stripFrameCoords(e.clientX, e.clientY, frames, app.zoom);
    return hit ? { x: hit.x, y: hit.y, pg: hit.pg } : null;
  }

  // Bound to `.stage`, not to `.boxlayer`, and that difference is the whole of
  // the hand tool. `.stage` is the element the grab cursor is painted on, and it
  // fills the scroll viewport (`min-width/min-height:100%`) - the pad around the
  // page and the grey surround of one zoomed below fit are all part of it. Bound to
  // `.boxlayer` instead, which is `inset:0` of the page frame, the hand advertised
  // a pan over roughly a third of the visible surface that it then refused to
  // perform. Presses on the page still arrive here: `.boxlayer` is a descendant,
  // so they bubble.
  //
  // Only the hand claims the extra ground. Text and Place stay page-only - they
  // read a point in page coordinates, and a click 200px out in the grey would
  // otherwise land a box off the paper - so their branch below still demands a
  // press that landed on `.boxlayer` or a page frame.
  function onStagePointerDown(e) {
    // The primary button and nothing else. A right-click is on its way to a
    // context menu and a middle one is a paste on some platforms; neither is a
    // request to drag the page around or to leave a box where it landed.
    if (e.button !== 0) return;
    if (app.bulk.active) return; // bulk mode: only box clicks matter
    if (app.tool === 'pan') {
      // The one thing on the stage the hand does not take: a box being typed
      // into. `.boxlayer.pan` already makes every other box deaf, so this is
      // reachable only for the live caret, whose own gesture must survive.
      if (e.target.closest?.('.tbox')) return;
      startPanPointer(e, false);
      return;
    }
    // Below here every branch can add a box to the page, and a translate chapter
    // has none. The tool is forced to the hand when such a chapter opens and
    // `setTool` refuses the other two while it is on, so this is unreachable -
    // which is exactly why it is cheap to keep: the cost of being wrong is a
    // stray box on a page the user is not typesetting.
    if (translate) return;
    if (e.target.closest?.('.tbox')) return;
    if (!strip && !e.target.classList.contains('boxlayer')) return;
    // The Text tool drags the empty page to pan too, and turns a press that
    // never travelled into a new box.
    if (app.tool === 'text') {
      const hit = frameCoords(e);
      if (hit) startPanPointer(e, true);
      return;
    }
    const hit = frameCoords(e);
    if (!hit) return;
    const pg = hit.pg;
    // The page under the pointer decides, not the current one, and it is handed
    // on so the box lands where the click did. `placeActiveAt` moves the index
    // onto it - see `focusPage`.
    if (pg.activeLineN != null && lineByN(pg, pg.activeLineN)) placeActiveAt(hit.x, hit.y, pg);
    else deselect();
  }

  // `addsBox` is read once, here, rather than at the end of the gesture: the
  // press is what decided what this drag is, and a tool switched by a keyboard
  // shortcut mid-drag must not change the answer under it.
  function startPanPointer(e, addsBox) {
    const pid = e.pointerId;
    // The gesture follows the pointer even once it leaves the window: without
    // the capture, a button released outside gets no pointerup here at all and
    // the page comes back stuck to the cursor. Captured on the element the press
    // landed on rather than on `.stage`, because a captured pointer's events are
    // retargeted at the capture element - and the release below resolves which
    // page a new box goes on from `ev.target`. The listeners stay on `document`:
    // a captured pointer's events still bubble to it.
    e.target.setPointerCapture?.(pid);
    const startX = e.clientX,
      startY = e.clientY;
    const sl = scrollEl.scrollLeft,
      st = scrollEl.scrollTop;
    const basePan = { x: pan.x, y: pan.y };
    // Measured once, here, and not again for the rest of the gesture - see
    // `clampTo`. What changes under a pan is the scroll position, and the
    // handler already knows how far it has moved it.
    const geom = panBase(basePan);
    let panning = false;
    const setLive = (v) => {
      if (panLive !== v) panLive = v;
    };
    const move = (ev) => {
      // A second pointer - another touch, or a pen alongside the mouse - would
      // otherwise drive this same closure from a start point it never measured
      // against.
      if (ev.pointerId !== pid) return;
      const dx = ev.clientX - startX,
        dy = ev.clientY - startY;
      if (!panning && Math.hypot(dx, dy) > 4) panning = true;
      if (!panning) return;
      setLive(true);
      // Scroll takes what it can hold; the rest becomes the free offset. Both
      // halves are computed from the gesture's own start values rather than
      // accumulated per frame, so a drag out past the edge and back in lands
      // exactly where it began - an accumulating version drifts.
      const maxL = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
      const maxT = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      const wantL = sl - dx,
        wantT = st - dy;
      const gotL = clamp(wantL, 0, maxL),
        gotT = clamp(wantT, 0, maxT);
      scrollEl.scrollLeft = gotL;
      scrollEl.scrollTop = gotT;
      // Scrolling right by n and translating the page left by n are the same
      // picture, hence the sign.
      const want = { x: basePan.x - (wantL - gotL), y: basePan.y - (wantT - gotT) };
      pan = geom ? clampTo(want, geom, gotL - sl, gotT - st) : want;
    };
    // One controller for both endings, the same net FloatingPanel and TextBox
    // keep: a gesture the browser takes away from us - an OS gesture claiming
    // the pointer, a lost capture - fires pointercancel and never a pointerup,
    // and a pan handler that survived it would follow the cursor with nothing
    // held and nothing left to stop it. A cancelled press adds no box: the
    // gesture was taken away, not finished.
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      setLive(false);
      if (addsBox && !panning && ev.type === 'pointerup') {
        // Resolved from the RELEASE, which is where the box goes. A press that
        // never travelled cannot have left the frame it started in, so this is
        // the same frame either way; reading it here keeps the one rule - the
        // box lands on the page the pointer is over - with no second copy of
        // the press's answer to keep in step.
        const hit = frameCoords(ev);
        // A page whose art has not decoded yet is `w:0,h:0`, and it has no
        // coordinate space to put a box in: `addEmptyBox` clamps the box
        // against `p.w - w`, which on such a page is a clamp to zero, so every
        // box typed onto it collapses into the top-left corner and stays there
        // once the real size arrives. Refused rather than placed wrongly - the
        // press is worth a word, because the page it landed on looks like a
        // page and the box would simply not appear where the user put it.
        if (hit && !measured(hit.pg)) toast('This page is still loading - try again in a moment');
        else if (hit) addEmptyBox(hit.x, hit.y, hit.pg);
      }
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // The one place the page's coordinate space is learned: the image that fills
  // the frame has finished decoding and can finally say how big it is. Until
  // this fires the page is `w:0,h:0` - `createChapter` copies the files without
  // decoding them - so every page in a chapter is unmeasured until it has been
  // looked at once.
  //
  // Addressed by the URL that loaded, not by "the page on screen". There is one
  // `<img>` element and `src` changes under it on every page turn, so a decode
  // that finishes after the turn used to write the size of the page being left
  // onto the page being arrived at - and on a chapter with a double-page spread
  // in it, that leaves a page permanently stretched and saves it that way. The
  // object URL belongs to exactly one page, so the answer has no timing in it.
  // The fallback to the current page is the pre-existing behaviour, kept for
  // the case where the src is not one this app minted (nothing does that today)
  // rather than dropping the measurement on the floor.
  //
  // `owner` is the page this `<img>` was mounted for. It only matters for the
  // fallback below - the addressing above is by URL and needs no help - but in a
  // strip "the current page" is a poor guess at which of the mounted images just
  // decoded, and the element already knows.
  function onCleanedLoad(e, owner) {
    const img = e.currentTarget;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const src = img.currentSrc || img.src;
    const target = setPageDimsForSrc(src, img.naturalWidth, img.naturalHeight);
    // No page owns this URL any more, and there are two ways that happens.
    //
    // The resident window moved off the page while its picture was decoding, so
    // `page-images.js` revoked the URL and nulled the fields that pointed at it.
    // The measurement is then about a page that is no longer showing this art,
    // and the fallback below would write it onto whichever page is current NOW -
    // stretching that page's coordinate space, rescaling every box on it, and
    // saving the result. `wasPageImage` is how this is told apart: the module
    // remembers the URLs it minted, including the ones it has since revoked, so
    // a decode that lands after an eviction is recognised and dropped whole -
    // the pixel cache below is skipped with it, for the same reason.
    //
    // Or it is a `src` this app never minted, which nothing does today. That one
    // keeps the pre-existing fallback rather than dropping the measurement.
    if (!target && wasPageImage(src)) return;
    if (!target) setPageDims(owner ?? page(), img.naturalWidth, img.naturalHeight);
    // The same moment, used twice. This element is the only place in the app
    // where a decoded page raster exists without anything having to fetch one,
    // and balloon fitting needs those pixels SYNCHRONOUSLY - a click places a
    // box and the box's size comes out of the fit. So the page is copied into an
    // `ImageData` here, once, and placement reads it out of the cache; see
    // page-pixels.js for the bound and for why the `src` is stored beside the
    // pixels rather than the pixels being trusted to stay current.
    //
    // Addressed by the page the URL belongs to, exactly like the measurement
    // above and for the identical reason: `src` changes under one `<img>` on
    // every page turn, so a decode that finishes after the turn must not file
    // its pixels against the page being arrived at.
    //
    // NOT done here, though. `getImageData` on a print-scale page is ~20ms of
    // synchronous main thread work, it lands in the middle of a page turn, and
    // most turns never place a box - so it is deferred to whenever the browser
    // is next idle. The page id and the `src` are captured now, in this closure,
    // rather than read again inside the callback: that is what keeps the
    // addressing above true across the wait, so a turn during the idle gap files
    // the pixels against the page they came from or not at all.
    //
    // `notePageImage` is what makes the deferral safe for a click that beats the
    // callback - see page-pixels.js. It is a map write and nothing more.
    const pixelId = (target ?? owner ?? page()).id;
    notePageImage(pixelId, src, img);
    queuePixels(pixelId, src, img);
    // Only when the measurement was about the page being drawn: a fit
    // recomputed off another page's dimensions is the same lie one step later.
    //
    // A strip has no such thing as another page's dimensions - its fit is the
    // widest page in the chapter, so a page that has just been measured for the
    // first time can change it whoever is on screen. Unforced, so the key does
    // the deciding and a page that was not the widest costs nothing.
    if (!app.isFit) return;
    if (strip) computeFit();
    else if ((target ?? owner ?? page()) === page()) computeFit(true);
  }

  // refit when switching pages
  $effect(() => {
    app.pageIndex;
    // Not in a strip. There the index is DERIVED from the scroll position (see
    // `syncStrip`), so this would fire on the way down every chapter: dropping
    // the pan and re-fitting - which in a strip also means re-deciding the zoom
    // - under a reader who is only scrolling. The page turn it exists to answer
    // does not exist there.
    if (untrack(() => strip)) return;
    // A new page arrives centred, whatever the last one was left looking like.
    resetPan();
    if (app.isFit) computeFit(true);
  });

  // ---------- which page a strip's reader is on ----------
  //
  // Nothing else in the app decides this: `gotoPage` stays the one writer of the
  // index, so the history swap and the queue's `activeLineN` still happen
  // exactly once per change, and everything downstream - the queue, the
  // inspector, detect, the save - goes on reading `page()` without knowing the
  // difference.
  //
  // Throttled to a frame because a scroll fires far faster than one.
  let syncQueued = 0;
  function queueStripSync() {
    if (syncQueued || !strip) return;
    syncQueued = requestAnimationFrame(() => {
      syncQueued = 0;
      syncStrip();
    });
  }

  function syncStrip() {
    if (!strip || !scrollEl || !stripEl) return;
    // A frame per page or nothing: a half-mounted column would answer with the
    // pages it happens to have, which is a jump to a page nobody scrolled to.
    // Only the first `pages.length` entries are asked about - a chapter swapped
    // underneath the editor for a shorter one leaves the bindings it emptied
    // behind as nulls, and refusing to answer for the rest of the session
    // because of them would freeze the index at whatever page it was on.
    //
    // Still a per-page check, and it costs nothing: it reads an array, not the
    // DOM. What it is standing in for is the loop that used to be below.
    const n = app.pages.length;
    if (frameEls.length < n) return;
    for (let i = 0; i < n; i++) if (!frameEls[i]) return;
    // Two rects and a computed style, whatever the chapter's length. This used
    // to measure EVERY frame in the column on every animation frame of a scroll
    // - a two hundred slice webtoon meant two hundred forced layouts per tick,
    // which is the scroll's own budget spent on arithmetic the layout already
    // did. The frames have explicit heights (`pg.h * zoom` in the style string
    // below), the column is a flex column with a known gap, and nothing else
    // sits between them, so the offsets are a running total - see
    // `stripFrameMetrics`. The one thing that cannot be derived is where the
    // column itself starts: the stage pads it, centres it and the pan is
    // translated onto it, so that is measured, once.
    const { st, vh, tops, heights } = stripMetrics();
    const i = pageIndexAtCenter(tops, st, vh, heights);
    // The index follows the scroll, EXCEPT while the reader is working on a box:
    // `gotoPage` clears the selection and closes the caret, so a click on a box
    // in the tail of the slice above would be undone by the next scroll frame.
    // The page that box is on holds the index until it has been scrolled off
    // screen - see `focusHoldsIndex` for the rule and why it is a hold rather
    // than a lock.
    const workingId = app.editingId || app.selectedId;
    const focusedBox = workingId && app.pages[app.pageIndex]?.boxes.find((b) => b.id === workingId);
    const keepFocus = !!workingId && (
      focusHoldsIndex(tops, heights, app.pageIndex, st, vh) ||
      focusedBoxHoldsIndex(focusedBox, tops[app.pageIndex] ?? 0, app.zoom, st, vh)
    );
    if (i !== app.pageIndex && !keepFocus)
      gotoPage(i);
    // The reference strip follows this one - see strip-sync.svelte.js.
    publishStripScroll(scrollFraction(scrollEl));
  }

  // Where every frame of the column sits in the scroll container's content, in
  // zoomed pixels, and the viewport it is seen through.
  function stripMetrics() {
    const sr = scrollEl.getBoundingClientRect();
    const st = scrollEl.scrollTop;
    const firstTop = stripEl.getBoundingClientRect().top - sr.top + st;
    // Read rather than mirrored, for the same reason the fit reads the stage's
    // padding off the element: the stylesheet owns this number (`.strip` is
    // `gap:0` today, because a webtoon's slices are cuts through one continuous
    // drawing) and a second copy of it here could only drift.
    const gap = parseFloat(getComputedStyle(stripEl).rowGap) || 0;
    const { tops, heights } = stripFrameMetrics(app.pages, app.zoom, firstTop, gap);
    return { st, vh: scrollEl.clientHeight, tops, heights };
  }

  // A jump to a box from outside the canvas (see `revealInStrip`). By the time
  // this runs the caller has turned to the box's page and selected it, which
  // also mounts it whatever the resident window says. Instant, not smooth: a
  // smooth scroll from far up the chapter passes the reader's centre through
  // every page in between, and `syncStrip` would turn to each of them - and
  // drop the selection on the first.
  $effect(() => {
    if (!stripReveal.seq) return;
    untrack(() => {
      if (!strip || !scrollEl || !stripEl) return;
      const box = page()?.boxes.find((b) => b.id === stripReveal.boxId);
      if (!box) return;
      const { st, vh, tops } = stripMetrics();
      const top = stripScrollTopForBox(box, tops[app.pageIndex] ?? 0, app.zoom, st, vh);
      if (top != null) scrollEl.scrollTop = top;
    });
  });

  // Zooming does not cancel a pan - a user who has pushed the page aside to see
  // a corner expects to be able to zoom into it - but it does change what
  // "almost off screen" means, so the offset is re-bounded against the new
  // frame. `untrack` on the read is what stops this writing its own dependency
  // and re-running forever.
  $effect(() => {
    app.zoom;
    const cur = untrack(() => ({ x: pan.x, y: pan.y }));
    const next = clampPan(cur, cur);
    if (next.x !== cur.x || next.y !== cur.y) pan = next;
    // A zoom changes a strip's height without scrolling it, so the page under
    // the viewport's centre changes with no scroll event to notice. Queued, so
    // it runs after the frames have been laid out at the new zoom.
    untrack(queueStripSync);
  });

  onMount(() => {
    // Handed up before the first fit, so a parent that wants to drive one has it
    // from the first frame.
    onReady?.({ fit: () => computeFit(true) });
    computeFit(true);
    // The observer is why the fit needs no knowledge of the sidebar: dragging the
    // rail, hiding the reference, resizing the window all change this element's
    // box, and each of them re-measures. The floating panels do not - they are
    // deliberately ignored, so a panel dragged over the page covers it rather
    // than reflowing it.
    const ro = new ResizeObserver(() => {
      // A fit re-fits (and drops the pan with it); anything else keeps the pan
      // but re-bounds it, so shrinking the window cannot strand a page that was
      // pushed out to the edge of the old one.
      if (app.isFit) computeFit();
      else {
        // Only when it actually moves. `pan` is read into the style string of
        // every mounted frame, so assigning a fresh object that says what the
        // old one said still rewrites the whole window's geometry - and this
        // observer fires on every frame of a sidebar drag or a window resize,
        // where the clamp usually hands back exactly what it was given. Same
        // guard, same reason, as the zoom effect above and `resetPan`.
        const next = clampPan(pan, pan);
        if (next.x !== pan.x || next.y !== pan.y) pan = next;
      }
      // The viewport's centre moved, so which page is under it may have too.
      queueStripSync();
    });
    ro.observe(scrollEl);
    // Passive: this never cancels a scroll, it only reads where one got to.
    const onScroll = () => queueStripSync();
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    // The first answer, before the user has scrolled anything: a chapter opens
    // at the top, and the reference strip has to be told so.
    queueStripSync();
    // Continuous in the wheel's own delta rather than a fixed step per event,
    // the same shape the reference strip's pinch already had (see `RefSidebar`).
    // A trackpad pinch arrives as sixty to a hundred small events, and a flat
    // ×1.1 on each of them crossed the entire zoom range in one flick - the page
    // leapt to the ceiling and back. `exp` keeps it geometric like the dock's
    // buttons, so the same travel is the same ratio wherever the zoom starts,
    // and the ends are still `setZoom`'s clamp.
    const ZOOM_PER_PX = 0.0035;
    // How long after the last wheel event the gesture counts as over. Long
    // enough to bridge the gap between two notches of a mouse wheel, short
    // enough that the deferred repaints land while the user is still looking at
    // the page they asked for.
    const ZOOM_SETTLE_MS = 140;
    // The events since the last frame, as one delta. A trackpad pinch delivers
    // far more than sixty events a second and each `setZoom` rebuilds every
    // mounted box, re-reads two bounding rects through `clampPan`, and re-runs
    // the strip metrics - so at best the page was re-laid-out several times per
    // displayed frame, and at worst the main thread never caught up and the
    // gesture lagged behind the fingers.
    //
    // Summing is exact rather than approximate: the step is `exp(-dy * k)` and
    // `exp(-a*k) * exp(-b*k) === exp(-(a+b)*k)`, so one frame's worth of events
    // applied together lands on the same zoom as applying them one at a time.
    let wheelDelta = 0;
    let wheelRaf = 0;
    let settleT = null;
    const applyWheel = () => {
      wheelRaf = 0;
      const dy = wheelDelta;
      wheelDelta = 0;
      if (dy) setZoom(app.zoom * Math.exp(-dy * ZOOM_PER_PX));
    };
    const endZoomGesture = () => {
      settleT = null;
      setZoomLive(false);
    };
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        wheelDelta += e.deltaY;
        setZoomLive(true);
        clearTimeout(settleT);
        settleT = setTimeout(endZoomGesture, ZOOM_SETTLE_MS);
        if (!wheelRaf) wheelRaf = requestAnimationFrame(applyWheel);
      }
    };
    scrollEl.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      scrollEl.removeEventListener('wheel', onWheel);
      scrollEl.removeEventListener('scroll', onScroll);
      if (syncQueued) cancelAnimationFrame(syncQueued);
      if (wheelRaf) cancelAnimationFrame(wheelRaf);
      // A canvas torn down mid-pinch must not leave the flag standing: every
      // box that reads it would defer its repaint forever.
      clearTimeout(settleT);
      setZoomLive(false);
    };
  });
</script>

<div class="editor-scroll" bind:this={scrollEl}>
  <!-- One cursor per tool, because the two that both pan are otherwise
       indistinguishable until you press: the hand says it will move the page,
       the crosshair says a click lands a box where it points. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="stage"
    bind:this={stageEl}
    onpointerdown={onStagePointerDown}
    style={app.bulk.active
      ? 'cursor:pointer'
      : app.tool === 'pan'
        ? 'cursor:grab'
        : app.tool === 'text'
          ? 'cursor:crosshair'
          : ''}
  >
    <!-- The pan is a transform rather than a change to the layout box on
         purpose: it moves the picture without touching the stage's scroll size,
         so the scrollbars, the fit measurement and the 60px of air around the
         page all go on meaning what they meant. `frameCoords` and TextBox's own
         drags read this element's `getBoundingClientRect()`, which already
         includes the transform, so nothing downstream has to know about it. -->
    {#if strip}
      <!-- Every page of the chapter, stacked with no gap at all, which is what a
           webtoon is: the slices are cuts through one continuous drawing and any
           space between two of them is a seam through the art. So the shadow and
           the paper edge belong to the column rather than to each frame (see
           `.strip` in styles.css), and the pan is applied here, to the column, in
           place of the single frame's.

           No virtualisation. The frames are empty divs of a known size until
           `page-images.js` mints their picture, so a 200-page chapter mounts 200
           cheap boxes and holds a handful of rasters - and the strip's scroll
           height is the same before and after any of them arrives, which is the
           one property that keeps a scroll position meaning what it meant.

           Layering:
           Artwork layer: independent page frames containing images.
           Shared text overlay: mounted over all artwork so cross-seam text boxes
           paint cleanly above subsequent page images without being obscured. -->
      <div
        class="strip"
        class:panning={panLive}
        bind:this={stripEl}
        style="translate:{pan.x}px {pan.y}px"
      >
        {#each app.pages as pg, i (pg.id)}
          <div
            class="page-frame"
            data-page-id={pg.id}
            bind:this={frameEls[i]}
            style="width:{pg.w * app.zoom}px; height:{pg.h * app.zoom}px"
          >
            {#if srcOf(pg)}
              <!-- `decoding="async"` on every page image, here and in the
                   reference sidebar: without it the browser is entitled to
                   decode the raster synchronously while it is putting the
                   element in the tree, which on a page turn is the turn's own
                   frame. `page-images.js` has usually decoded the bitmap
                   already (see `predecode`), so this is the element agreeing to
                   wait for that rather than starting its own. -->
              <img class="page-img" src={srcOf(pg)} alt="Page" crossorigin="anonymous" decoding="async" onload={(e) => onCleanedLoad(e, pg)} />
            {/if}
          </div>
        {/each}
        <div class="strip-overlay boxlayer" class:pan={app.tool === 'pan'}>
          <!-- Mount individual boxes whose derived painted strip bounds intersect the
               resident artwork window, or that are selected/editing targets. Offscreen
               owner pages with no intersecting boxes render nothing. -->
          {#if !translate && stripLayout}
            {#each app.pages as pg, i (pg.id)}
              {#if pageHasVisibleBoxes(pg, i)}
                <div
                  class="page-boxlayer"
                  data-page-id={pg.id}
                  style="top:{stripLayout.tops[i] ?? 0}px; left:calc(50% - {(pg.w * app.zoom) / 2}px); width:{pg.w * app.zoom}px; height:{pg.h * app.zoom}px;"
                >
                  {#each pg.boxes as box (box.id)}
                    {#if isBoxVisible(box, i)}
                      <TextBox {box} {pg} pageFrameEl={frameEls[i]} lazy />
                    {/if}
                  {/each}
                </div>
              {/if}
            {/each}
          {/if}
        </div>
      </div>
    {:else}
      <!-- The page on screen and its immediate neighbours, all mounted, all but
           one of them `display:none`. See `mountedPages` for why the hidden ones
           are worth their keep and why the window slides off the turn's path.
           Keyed by page id so a window that slides moves the frames it keeps
           rather than rebuilding them at their new offset in the list. -->
      {#each mountedPages as m (m.pg.id)}
        <div
          class="page-frame"
          class:panning={panLive && m.i === app.pageIndex}
          class:page-off={m.i !== app.pageIndex}
          data-page-id={m.pg.id}
          bind:this={pagedFrameEls[m.i]}
          style="width:{m.pg.w * app.zoom}px; height:{m.pg.h * app.zoom}px; translate:{pan.x}px {pan.y}px"
        >
          {#if srcOf(m.pg)}
            <!-- See the strip's own page image above for why `decoding`. A
                 hidden frame's image still loads, so a neighbour is measured and
                 its pixels are cached before it is ever shown - `onCleanedLoad`
                 files both against the page the element was mounted for, and
                 re-fits only when that page is the one on screen. -->
            <img class="page-img" src={srcOf(m.pg)} alt="Page" crossorigin="anonymous" decoding="async" onload={(e) => onCleanedLoad(e, m.pg)} />
          {/if}
          <div class="boxlayer" class:pan={app.tool === 'pan'}>
            <!-- Same as the strip above: a translate chapter draws no boxes. -->
            {#if !translate}
              {#each m.pg.boxes as box (box.id)}
                <TextBox {box} pg={m.pg} pageFrameEl={pagedFrameEls[m.i]} shown={m.i === app.pageIndex} />
              {/each}
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

{#if !app.loaded}
  <div class="empty-state">
    <div class="dropzone">
      <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
      <h2>Nothing open</h2>
      <p>Pages come from your library - open a chapter to typeset it.</p>
    </div>
  </div>
{/if}
