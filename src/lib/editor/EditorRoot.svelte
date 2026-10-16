<script>
  // The editor shell. One layer for the page, and everything else floating over
  // it: the reference sidebar and its rail down the left, the chrome pills along
  // the top, the zoom/undo dock and the pager along the bottom, and the two
  // panels the user drags wherever they like.
  //
  // Nothing here is a column. The canvas layer is inset from the left by the
  // sidebar and the rail - the two things whose width the user actually sets -
  // and by nothing else, so fit-to-window measures the canvas viewport. The
  // floating panels are ignored by that measurement on purpose: a panel dragged
  // over the page covers it rather than reflowing it.
  import { onMount, untrack } from 'svelte';
  import Canvas from './Canvas.svelte';
  import RefSidebar from './RefSidebar.svelte';
  import RailTools, { RAIL_W } from './RailTools.svelte';
  import ChromePills from './ChromePills.svelte';
  import ZoomDock from './ZoomDock.svelte';
  import Pager from './Pager.svelte';
  import FloatingPanel from './FloatingPanel.svelte';
  import Inspector from '../Inspector.svelte';
  import Queue from '../Queue.svelte';
  import BulkStylePanel from '../BulkStylePanel.svelte';
  import BoxMenu from './BoxMenu.svelte';
  import { app, page, placedLineNs, isTranslateMode, isLongstrip, translatedCount } from '../store.svelte.js';
  import { brushArmed } from '../brush-tool.svelte.js';
  import { loadPanels, clampAll } from './panels.svelte.js';
  import { setResidentWindow } from '../page-images.js';
  import { residentRadiusFor } from './strip.js';

  let { onFontLib, onSettings } = $props();

  // The canvas's own handle, so the dock's Fit button can ask the thing that can
  // actually measure itself.
  let canvas = $state(null);

  // A translate chapter is the raw page, the queue and the way around them.
  // Mount typeset controls in typeset mode.
  const translate = $derived(isTranslateMode());
  const strip = $derived(isLongstrip());

  // The reference sidebar is redundant when the canvas itself is showing the
  // raw, so it goes with the rest - and the canvas takes back the width it was
  // inset by, rather than leaving a column of nothing down the left.
  const canvasLeft = $derived((translate || app.sidebarHidden ? 0 : app.leftWidth) + RAIL_W);

  // One pass over the boxes, then a lookup per line, rather than a scan of the
  // boxes per line - see `placedLineNs`. Counted over the LINES, not taken as
  // the set's size, because a box can carry a `lineN` no line answers to (a line
  // deleted out from under it) and the panel is reporting progress through the
  // queue, which is a count of lines.
  const placed = $derived.by(() => {
    const set = placedLineNs(page());
    let n = 0;
    for (const l of page().lines) if (set.has(l.n)) n++;
    return n;
  });
  const total = $derived(page().lines.length);
  // Translating counts a different thing finished. Derived from the lines
  // themselves - see `translatedCount` for why nothing stores it.
  const done = $derived(translatedCount(page().lines));

  // The stored layout is read once, when the shell mounts and the window's size
  // is finally known. Every later resize only clamps - a window the user shrank
  // must not be able to lose them a panel, but neither may it overwrite the
  // geometry they chose at the size they chose it.
  onMount(() => {
    loadPanels(
      typeof localStorage === 'undefined' ? null : localStorage,
      window.innerWidth,
      window.innerHeight,
    );
  });

  // Clamp without writing: see `clampAll`. A window the user shrank must not be
  // able to make the layout they chose smaller for good.
  const onResize = () => clampAll(window.innerWidth, window.innerHeight, false);

  // What the last `setResidentWindow` was asked for - see the guard inside the
  // effect. Plain variables rather than state: they are written by the effect
  // and read by nothing else, and as state they would be a dependency of the
  // effect that writes them.
  let lastPages = null;
  let lastIndex = -1;
  let lastRadius;

  // Which pages' pictures are in memory, and it is the editor's job because the
  // editor is what decides which page is on screen. `setResidentWindow` mints
  // the current page and its two neighbours either side and revokes everything
  // else - see page-images.js for why the window is that size and why a page
  // held open by an export is exempt. `openChapter` sets the first window
  // itself, so the chapter is drawable before this ever runs; this is the page
  // turns, and a chapter swapped underneath the editor without a remount.
  // The two dependencies are named and read here; the call itself is untracked.
  // `setResidentWindow` both reads and writes `raw`/`cleaned` on page objects,
  // and tracked it would re-run itself every time a prefetch landed - harmless,
  // because a second pass over an already-minted window does nothing, but it is
  // a loop that only terminates by luck and there is no reason to keep it.
  //
  // A strip needs a different rule, and it is the same rule measured in the unit
  // that matters. Five pages is five screens of lookahead when the slices are
  // 1000px tall and a third of one screen when they are 8000px, and in a strip
  // the reader is not turning pages - they are scrolling, continuously, past
  // whatever is in the window. So the radius is grown until the window holds
  // three viewports of art either side, with the paged radius as its floor and a
  // hard cap on top: see `residentRadiusFor`. The heights are the on-screen ones
  // (page pixels × zoom), because it is screens of scrolling being counted.
  //
  // `window.innerHeight` rather than the canvas viewport's own height: the
  // canvas layer is `inset:0` of a viewport-fixed root, so the two agree to
  // within the chrome that floats over it, and reading it here needs no seam
  // through Canvas for a number that is only ever multiplied by three.
  $effect(() => {
    const pages = app.pages;
    const index = app.pageIndex;
    const strip = isLongstrip();
    // Read inside the branch, so a paged chapter does not take a dependency on
    // the zoom and re-run this on every zoom step, as it never has.
    const zoom = strip ? app.zoom : 1;
    // Read HERE, tracked, and not inside the `untrack` below. Every page in a
    // freshly opened chapter is `h: 0` until its art has been decoded once, so a
    // radius computed from those heights is the cap - twelve pages held in
    // memory - and left untracked it stayed the cap for the rest of the session,
    // because the decodes that fill `p.h` in never re-ran this.
    //
    // Tracking them is safe in the one way that matters: nothing below writes a
    // page's height. `setResidentWindow` writes `raw`/`cleaned`, which is what
    // the untrack is still here for - tracked, a landing prefetch would re-enter
    // this effect - and `p.h` is written only by the canvas measuring a decoded
    // image. So this re-runs when a page is measured and never on its own
    // output. A paged chapter takes no dependency on the heights at all.
    const heights = strip ? pages.map((p) => (p.h ?? 0) * zoom) : null;
    untrack(() => {
      const radius = heights
        ? residentRadiusFor(heights, index, typeof window === 'undefined' ? 0 : window.innerHeight)
        : undefined;
      // A strip takes a dependency on the zoom, so this effect re-ran on every
      // wheel event of a pinch - and `setResidentWindow` rebuilds a Set, walks
      // the pages and mints or revokes object URLs. The window it would compute
      // is the same one it computed last tick for all but the handful of zooms
      // that actually move the radius, so the state that decides the window -
      // the page list's identity, the index, and the radius - is what is
      // compared. Everything the call would do for an unchanged window is a
      // no-op by its own contract; this is only saving the walk.
      if (pages === lastPages && index === lastIndex && radius === lastRadius) return;
      lastPages = pages;
      lastIndex = index;
      lastRadius = radius;
      setResidentWindow(pages, index, radius);
    });
  });
</script>

<svelte:window onresize={onResize} />

<div class="ed-root" style="--canvas-left:{canvasLeft}px">
  <div class="ed-canvas">
    <Canvas onReady={(api) => (canvas = api)} />
    <!-- Inside the canvas layer, not the root: this panel centres itself and
         clamps its drag against `offsetParent`, so the element it sits in is
         the frame it is confined to. Under `.ed-root` - fixed to the viewport -
         it opened over the reference sidebar and, at z-index 40, on top of the
         chrome pills. `.ed-canvas` is positioned, so it takes the role, and it
         carries no z-index of its own, so 40 still orders against the root's
         context exactly as before. -->
    {#if !translate}<BulkStylePanel />{/if}
  </div>

  {#if !translate && !app.sidebarHidden}<RefSidebar />{/if}
  <RailTools />

  <ChromePills {onFontLib} {onSettings} />

  <!-- Nothing to zoom and no pages to step through until a chapter is open:
       ungated, the "Nothing open" empty state sits behind a live zoom pill and
       a `0 / 0` pager. -->
  {#if app.loaded}
    <div class="ed-dockrow">
      <ZoomDock onFit={() => canvas?.fit()} />
      <!-- No pager in a strip. There are no pages to turn - the index follows
           the scroll position rather than leading it (see `syncStrip`), so a
           control that writes it would be fighting the reader's own scrolling,
           and "page 7 of 40" is not how anyone reads a webtoon. Not mounted
           rather than disabled, for the same reason the typesetting controls are
           not mounted in a translate chapter. -->
      {#if !strip}<Pager />{/if}
    </div>
  {/if}

  {#if !translate}
    <!-- The title follows the body: the panel says what it is showing, and while
         the brush is armed it is not showing a text box's options. -->
    <FloatingPanel id="options" title={brushArmed() ? 'Brush' : 'Text box options'}>
      <Inspector {onSettings} />
    </FloatingPanel>
  {/if}
  <FloatingPanel
    id="queue"
    title={translate ? 'Translation' : 'Text queue'}
    count={translate ? `${done} / ${total} translated` : `${placed} / ${total} placed`}
  >
    <Queue />
  </FloatingPanel>

  <!-- A box's right-click menu (FLOW-9), drawn here over the panels rather
       than inside the box, where the page frame would clip it. -->
  {#if !translate}<BoxMenu />{/if}
</div>
