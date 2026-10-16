<script module>
  // The rail's width in pixels. EditorRoot needs the number to work out where
  // the canvas layer starts; the stylesheet needs the same length as --rail-w.
  // Declared once on each side and named after the other so a change to one is
  // an obvious prompt to change the other.
  export const RAIL_W = 44;
</script>

<script>
  // The strip between the reference sidebar and the canvas. It carries the tool
  // switcher and doubles as the sidebar's resize handle - the wireframe has no
  // separate resizer, the seam itself is the grab.
  import {
    app,
    setTool,
    saveSidebar,
    clampSidebarWidth,
    SIDEBAR_MIN,
    sidebarMaxWidth,
    isTranslateMode,
  } from '../store.svelte.js';
  import { prefs } from '../prefs.svelte.js';
  import { brushArmed } from '../brush-tool.svelte.js';
  import { panels, setHidden, raisePanel } from './panels.svelte.js';

  // A translate chapter has no reference sidebar - the canvas is already showing
  // the raw - so the rail keeps only the hand, and the caret that would offer to
  // bring a sidebar back goes with it. `noSide` rather than `app.sidebarHidden`
  // everywhere the geometry is concerned: there is nothing to the left of the
  // rail in either case, so it sits at 0 and the resize is inert.
  const translate = $derived(isTranslateMode());
  const noSide = $derived(translate || app.sidebarHidden);

  // The ceiling moves with the window - see `sidebarMaxWidth`. Tracked here so
  // the separator's `aria-valuemax` is the width the drag would actually stop
  // at, rather than a number frozen at mount.
  let viewportW = $state(typeof window === 'undefined' ? 0 : window.innerWidth);
  const maxWidth = $derived(sidebarMaxWidth(viewportW));

  // How far one arrow key moves the edge. Coarse enough to cross the range in a
  // reasonable number of presses, fine enough to land where you meant to.
  const KEY_STEP = 16;

  // Every gesture in flight, so an unmount can end them all - see the same set
  // in FloatingPanel. The listeners live on `document`, and nothing guarantees
  // a further pointer event once this component is gone.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  // Distinguish click from resize drag by threshold.
  function onRailPointerDown(e) {
    if (noSide) return; // nothing on screen to resize
    // Primary pointer button only.
    if (e.button !== 0) return;
    e.preventDefault();
    // Pointer capture tracks drag outside window.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const startX = e.clientX;
    const startW = app.leftWidth;
    let dragging = false;
    const move = (ev) => {
      // A second pointer - another touch, or a pen alongside the mouse - would
      // otherwise drive this same closure from a start point it never measured
      // against.
      if (ev.pointerId !== pid) return;
      if (!dragging && Math.abs(ev.clientX - startX) < 4) return;
      dragging = true;
      app.leftWidth = clampSidebarWidth(startW + (ev.clientX - startX));
    };

    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
      if (dragging) saveSidebar(); // only a real resize is worth persisting
    };
    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', end, { signal: ac.signal });
    document.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // Separator keyboard controls.
  function onRailKeyDown(e) {
    if (noSide) return;
    const w = app.leftWidth;
    if (e.key === 'ArrowLeft') app.leftWidth = clampSidebarWidth(w - KEY_STEP);
    else if (e.key === 'ArrowRight') app.leftWidth = clampSidebarWidth(w + KEY_STEP);
    else if (e.key === 'Home') app.leftWidth = SIDEBAR_MIN;
    else if (e.key === 'End') app.leftWidth = maxWidth;
    else return;
    e.preventDefault();
    // The window keydown handler maps these arrows to page turns; a rail
    // resize must not also flip the page.
    e.stopPropagation();
    if (app.leftWidth !== w) saveSidebar();
  }

  function toggleSidebar() {
    app.sidebarHidden = !app.sidebarHidden;
    saveSidebar();
  }


  const keepClick = (e) => e.stopPropagation();

  // A hidden floating panel is a tab here, under the tools, and nowhere else:
  // one tab per panel, apart from the tool strip and from each other, in the
  // inverse of the chrome's colour so it reads against both the dark art and
  // the strip. Shown again, the panel comes back where it was and its tab
  // goes. The names are the panels' own titles (EditorRoot.svelte). A
  // translate chapter has no options panel, so no tab for it either.
  const docked = $derived(
    [
      !translate && panels.options.hidden && { id: 'options', title: brushArmed() ? 'Brush' : 'Text box options' },
      panels.queue.hidden && { id: 'queue', title: translate ? 'Translation' : 'Text queue' },
    ].filter(Boolean),
  );
  function showPanel(id) {
    setHidden(id, false);
    raisePanel(id);
  }
</script>

<svelte:window onresize={() => (viewportW = window.innerWidth)} />

<!-- The whole strip carries the drag, but it is not the widget: a focusable
     separator is the ARIA window splitter, a range control in the same family
     as slider and scrollbar, and assistive technology is free to prune or
     flatten a range control's children. Five tool buttons inside that subtree
     could go unreachable in browse mode, so the role, the value and the
     keyboard live on the edge band below and the tool strip stays outside it. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="ed-rail"
  class:hidden={noSide}
  style="left:{noSide ? 0 : app.leftWidth}px"
  onpointerdown={onRailPointerDown}
>
  <!-- The band that advertises the resize - and, being the widget, the thing
       that takes focus and the arrow keys. The seam is on its left edge, which
       is the edge the drag actually moves; the rest of the strip stays a plain
       pointer so it does not claim to be an edge it is not.
       The a11y lint classifies every `separator` as non-interactive and has no
       case for the focusable one, so the two warnings here are the false ones. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="ed-rail-edge"
    role="separator"
    aria-orientation="vertical"
    aria-label="Raw reference width"
    aria-valuenow={app.leftWidth}
    aria-valuemin={SIDEBAR_MIN}
    aria-valuemax={maxWidth}
    tabindex={noSide ? -1 : 0}
    onkeydown={onRailKeyDown}
  ></div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ed-rail-stack" onpointerdown={keepClick}>
  <div class="ed-rail-tools">
    <!-- All three go together in a translate chapter, and what is left is one
         button: the hand. The caret is not merely redundant there - pressing it
         would advertise a sidebar showing the same raw the canvas already is. -->
    {#if !translate}
      <button
        class="caret"
        onclick={toggleSidebar}
        aria-label={app.sidebarHidden ? 'Show raw reference' : 'Hide raw reference'}
        data-tip={app.sidebarHidden ? 'Show raw reference' : 'Hide raw reference'}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d={app.sidebarHidden ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7'} />
        </svg>
      </button>
      <span class="sep"></span>
      <button
        class:on={app.tool === 'place'}
        onclick={() => setTool('place')}
        aria-label="Place tool"
        data-tip="Place tool - drop queued lines"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l7 18 2.5-7.5L20 11z" /></svg>
      </button>
      <!-- The Text tool keeps its incidental pan: past 4px of travel the press
           becomes a scroll and adds nothing, and a box takes a double click, so
           neither a slipped press nor a lone click leaves a stray empty box. The hand below is the tool
           for moving around deliberately - with it, no press can ever add a box -
           and it is what the double-click-for-bulk shortcut vacated. -->
      <button
        class:on={app.tool === 'text'}
        onclick={() => setTool('text')}
        aria-label="Text tool"
        data-tip="Text tool - double-click to add a box, drag to pan"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5h16v2" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>
      </button>
      {#if prefs.brushTool}
        <!-- The brush is a pointer mode, not an effect: arming it changes what a
             press on the page does, the way the hand tool does. Every other ink
             setting lives under the Inspector's Effects tab; this one does not,
             because it is a way of pointing. -->
        <button
          class:on={app.tool === 'brush'}
          onclick={() => setTool('brush')}
          aria-label="Brush tool"
          data-tip="Brush tool - hand-letter inside the selected box"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20c0-3 1.5-4 3-4s2.5 1 2.5 2.5S8.5 21 7 21c-1.7 0-3-.4-3-1z" /><path d="M9.5 17.5 19.4 6.2a2 2 0 0 0-2.9-2.7L5.6 13.8" /></svg>
        </button>
      {/if}
    {/if}
    <button
      class:on={app.tool === 'pan'}
      onclick={() => setTool('pan')}
      aria-label="Hand tool"
      data-tip="Hand tool - drag to move around the page"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0" /><path d="M14 10V4a2 2 0 0 0-4 0v2" /><path d="M10 10.5V6a2 2 0 0 0-4 0v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" /></svg>
    </button>
  </div>
  {#if docked.length}
    <div class="ed-rail-dock">
      {#each docked as d (d.id)}
        <!-- The button is the hit target and never moves or scales; the span is
             everything you can see, and it is what grows in. -->
        <button class="panel-stub" onclick={() => showPanel(d.id)} aria-label={'Show ' + d.title} data-tip={'Show ' + d.title}>
          <span class="stub-ink">
            {#if d.id === 'queue'}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" />
                <circle cx="4" cy="6" r="1.3" /><circle cx="4" cy="12" r="1.3" /><circle cx="4" cy="18" r="1.3" />
              </svg>
            {:else}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <path d="M4 7h6" /><path d="M14 7h6" /><circle cx="11" cy="7" r="2.2" />
                <path d="M4 17h10" /><path d="M18 17h2" /><circle cx="16" cy="17" r="2.2" />
              </svg>
            {/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
  </div>
</div>
