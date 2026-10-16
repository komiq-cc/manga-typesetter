<script>
  // ===== The free-transform gizmo =====
  //
  // The handles of the mesh warp, over the selected box: a dot at every control
  // point, the hairline mesh between them, and the box's original outline as a
  // dashed ghost so the deformation can be read against where it started.
  //
  // It is a child of the box element, like the path gizmo and the mask overlay,
  // and for the same three reasons: the box's `left`/`top` places it, the box's
  // `transform: rotate()` rotates it (so a handle on a tilted box sits on the
  // corner it belongs to, with no rotation maths here at all), and being outside
  // the clip wrapper means the mask cannot hide the controls.
  //
  // What a drag costs is the one thing this file does differently from the
  // others. A warped box is not DOM text - it is a picture the exporter paints -
  // and repainting that picture per pointermove means re-rendering the type, the
  // ink, the blur, the smear and the mask forty times a second for a gesture
  // that changes none of them. So the texture is rendered ONCE, when the gesture
  // starts, and every frame after that re-runs only the mesh over it. That is
  // the `painter` prop: `begin` caches, `frame` warps the cache, `end` releases
  // it and hands the box back to its own reactive repaint.
  //
  // ONE SESSION AT A TIME, and every ending goes through `endSession`. A gesture
  // can end without a pointer event: the gizmo is unmounted mid-drag whenever
  // the user arms the brush, switches sub-tab or selects another box, and a
  // teardown that only removed the listeners would leave the mesh wherever the
  // pointer had dragged it, with nothing on the undo stack to take it back, the
  // cached texture unreleased, and `warpDragging` stuck true - which freezes the
  // box's own repaints for the rest of the session.
  import {
    HANDLE_R,
    HANDLE_GRID_MAX,
    NUDGE_SETTLE_MS,
    nudgeDelta,
    handlePoints,
    meshLines,
    ghostOutline,
    warpDragGesture,
    resetWarp,
  } from '../warp-gizmo.js';
  import { flipDelta, mirrorCss } from '../box-frame.js';

  // `toLocal` turns a pointer event into box-local page px - the box's own
  // frame, rotation undone and the flip mirrored out, which is the frame the
  // mesh is stored in. The box owns that conversion (its mask tool needs the
  // identical one), so it is passed in rather than worked out twice.
  let { box, pageId, z, toLocal, painter = null } = $props();

  const s = $derived(box.style);
  // No handles on a mesh too fine to grab - see HANDLE_GRID_MAX. The hairlines
  // and Reset still show, so the letterer can see what liquify made and undo it.
  const showHandles = $derived(s.warp.cols <= HANDLE_GRID_MAX && s.warp.rows <= HANDLE_GRID_MAX);
  const pts = $derived(showHandles ? handlePoints(s.warp, box.w, box.h) : []);
  const lines = $derived(meshLines(s.warp, box.w, box.h));
  const ghost = $derived(ghostOutline(box.w, box.h));
  // The mesh is stored unflipped and the export flips the warped picture last,
  // so the overlay is drawn through the same flip: a handle sits on the part of
  // the flipped picture it moves (see box-frame.js).
  const mirror = $derived(mirrorCss(s, box.w * z, box.h * z));
  // Nothing to reset until something has been dragged. The empty array is the
  // stored form of "never touched" (see data.js), so this is exactly that test.
  const dirty = $derived(Array.isArray(s.warp.pts) && s.warp.pts.length > 0);

  // Which handle is being dragged, for the highlight. -1 is none; a handle being
  // NUDGED is highlighted by `:focus` instead, because that is what it is.
  let held = $state(-1);

  // The gesture in flight: `{ gesture, kind, ac, timer }`, or null. `kind` is
  // what the teardown reads to decide between committing and cancelling.
  let session = null;

  // Every ending, in one place. `cancelled` restores the style the gesture
  // found; otherwise it commits, which records at most one history entry (a
  // gesture that moved nothing records none - see `commitWarpDrag`).
  function endSession(cancelled) {
    const sn = session;
    if (!sn) return false;
    session = null;
    clearTimeout(sn.timer);
    if (sn.ac) {
      live.delete(sn.ac);
      sn.ac.abort();
    }
    held = -1;
    if (cancelled) sn.gesture.cancel();
    else sn.gesture.commit();
    // After the document is final, never before: the authoritative repaint this
    // releases the cache into has to draw the mesh that was committed.
    painter?.end();
    return true;
  }

  const live = new Set();
  $effect(() => () => {
    // A drag is CANCELLED on teardown and a keyboard burst is COMMITTED, and the
    // difference is whether the gesture had finished. A pointer that never came
    // up did not finish, so the mesh goes back to where the drag found it. Every
    // arrow key in a burst is a finished edit already - only the history entry
    // was waiting on the settle - so it is written, which is exactly what the
    // Inspector's own `onDestroy` does with a pending slider burst.
    endSession(session?.kind === 'drag');
    for (const ac of live) ac.abort();
    live.clear();
  });

  function onHandleDown(e, i) {
    if (e.button !== 0) return;
    // Both, and both matter: `preventDefault` keeps the pointer from starting a
    // text selection across the page, and `stopPropagation` is what stops the
    // box's own pointerdown from reading this as "move the box". The box's
    // resize handles are not mounted at all while the gizmo is up (see
    // TextBox.svelte), so a corner handle of a 1x1 mesh - which sits exactly
    // where the resize corner would - has nothing to contend with.
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // `preventDefault` above costs the focus the click would have given, and the
    // handle has to have it: the arrow keys are scoped to the focused handle and
    // nothing else, which is what keeps them out of a text field's way.
    e.currentTarget.focus?.({ preventScroll: true });
    // A burst still open on another handle is finished by its own blur; this is
    // for the case where there is no blur because the same handle is grabbed.
    endSession(false);

    const pid = e.pointerId;
    const gesture = warpDragGesture(box, pageId, i);
    // The grab offset: the pointer rarely lands on the handle's exact centre,
    // and without this the point jumps to the cursor on the first move.
    const start = toLocal(e);
    const p0 = box.style.warp.pts[i] ?? [start[0], start[1]];
    const gx = p0[0] - start[0];
    const gy = p0[1] - start[1];

    held = i;
    painter?.begin();

    const ac = new AbortController();
    session = { gesture, kind: 'drag', ac, timer: 0 };

    const move = (ev) => {
      if (ev.pointerId !== pid || session?.gesture !== gesture) return;
      const [x, y] = toLocal(ev);
      gesture.to(x + gx, y + gy);
      painter?.frame();
    };
    const up = (ev) => {
      if (ev.pointerId !== pid) return;
      endSession(false);
    };
    const cancel = (ev) => {
      if (ev.pointerId !== pid) return;
      endSession(true);
    };
    // Escape puts the mesh back exactly as the pointer found it. Capture phase
    // on the document, so it is answered before the window's own shortcut
    // handler can read the same press as "deselect", and stopped there.
    const key = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      endSession(true);
    };

    live.add(ac);
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', up, { signal: ac.signal });
    document.addEventListener('pointercancel', cancel, { signal: ac.signal });
    document.addEventListener('keydown', key, { signal: ac.signal, capture: true });
  }

  // The keyboard nudge, CSP's own: a focused handle moves a page pixel per arrow
  // press, ten with Shift. The listener is on the handle itself, so the arrows
  // are only ever taken while a handle has focus - a letterer typing in the
  // Inspector or in a text box keeps every arrow key they press.
  function onHandleKey(e, i) {
    if (e.key === 'Escape') {
      // A burst is thrown away by Escape, like a drag; then focus goes, so the
      // arrows are the page's again.
      if (session?.kind === 'nudge') {
        e.preventDefault();
        e.stopPropagation();
        endSession(true);
      }
      e.currentTarget.blur?.();
      return;
    }
    const d = nudgeDelta(e.key, e.shiftKey);
    if (!d) return;
    // Never while the pointer owns the mesh, and never past the gizmo's edge:
    // the arrows would otherwise scroll the page or step the selection.
    if (session?.kind === 'drag') return;
    e.preventDefault();
    e.stopPropagation();

    // A burst is one gesture: the first press opens it, every press after moves
    // the same one, and the settle below closes it. So a held arrow key is one
    // history step however many repeats it fires.
    if (!session || session.index !== i) {
      endSession(false);
      const ac = new AbortController();
      session = { gesture: warpDragGesture(box, pageId, i), kind: 'nudge', ac, timer: 0, index: i };
      live.add(ac);
      // A pointer going down anywhere else ends the burst NOW rather than on the
      // timer: the user has moved on, and an entry that landed 400ms into
      // whatever they did next would be an edit they could not place. Capture
      // phase, so a pointerdown on another handle closes this burst before that
      // handle's own gesture opens.
      //
      // Not `blur`, which is the obvious answer and does not work: a focusABLE
      // svg element in this engine takes focus (`document.activeElement` is the
      // circle) and then dispatches neither `blur` nor `focusout` when focus
      // leaves it - verified with a bare listener on the element, on the svg and
      // on the document in capture. A handler there would be dead code.
      document.addEventListener('pointerdown', () => endSession(false), {
        signal: ac.signal,
        capture: true,
      });
      painter?.begin();
    }
    // An arrow is a direction on screen; the mesh is stored unflipped.
    const [dx, dy] = flipDelta(d, s);
    session.gesture.by(dx, dy);
    painter?.frame();
    clearTimeout(session.timer);
    session.timer = setTimeout(() => endSession(false), NUDGE_SETTLE_MS);
  }
</script>

<!-- Hairlines and ghost first, handles last: the dots are the pointer targets
     and must be the topmost thing in the overlay. `overflow: visible` because a
     dragged handle is routinely outside the box rect - that is the feature.
     Only the drawing is hidden from assistive technology: the handles are
     focusable controls, and `aria-hidden` on an ancestor hides them however
     they are marked themselves. -->
<svg
  class="warp-gizmo"
  width={box.w * z}
  height={box.h * z}
  style={mirror}
  role="group"
  aria-label="Transform mesh"
  data-warp-gizmo={box.id}
>
  <polygon class="ghost" aria-hidden="true" points={ghost.map(([x, y]) => `${x * z},${y * z}`).join(' ')} />
  {#each lines as line, i (i)}
    <polyline class="mesh" aria-hidden="true" points={line.map(([x, y]) => `${x * z},${y * z}`).join(' ')} />
  {/each}
  {#each pts as p (p.i)}
    <circle
      class="wh"
      class:held={held === p.i}
      data-warp-handle={p.i}
      cx={p.x * z}
      cy={p.y * z}
      r={HANDLE_R}
      role="button"
      tabindex="0"
      aria-label="Mesh handle column {p.col + 1}, row {p.row + 1}. Arrow keys nudge, Shift for ten."
      onpointerdown={(e) => onHandleDown(e, p.i)}
      onkeydown={(e) => onHandleKey(e, p.i)}
    />
  {/each}
</svg>

{#if dirty}
  <!-- Reset is on the gizmo as well as in the panel, because the panel may be
       anywhere on screen and the thing being reset is here. Above the box's
       top-left, outside the mesh, so it never sits under a handle. -->
  <button
    type="button"
    class="warp-reset"
    title="Reset the mesh to the box's own outline"
    onpointerdown={(e) => e.stopPropagation()}
    onclick={(e) => {
      e.stopPropagation();
      resetWarp(box, pageId);
    }}>Reset</button
  >
{/if}

<style>
  /* Same shape as the path gizmo: the svg lets clicks through to the box and
     only the handles take the pointer. z-index 4 puts it over the brush's
     capture surface (3), so an armed brush cannot swallow a handle.

     THE PALETTE, and why it is not the theme's. Every colour here is drawn over
     the PAGE, and the page is `--paper` in both themes - light in dark mode too,
     because a manga page is ink on paper and inverting it would misrepresent the
     art (the same rule the brush panel's tip cells follow). So a token that
     flips with the theme - `--accent` is near-black on light and near-white on
     dark - would put a white hairline on white paper the moment the user
     switched. The gizmo therefore keeps the fixed page-facing palette the path
     and mask gizmos already use, declared here as custom properties so a theme
     that wants to override them can, with the current values as the fallback.
     The Reset chip is the exception and takes the real tokens: it is CHROME, a
     button floating above the box, and it reads as panel furniture in both
     themes. */
  .warp-gizmo {
    --wg-mesh: var(--gizmo-accent, #00d5e0);
    --wg-handle-line: var(--gizmo-accent-deep, #00818a);
    --wg-ghost: var(--gizmo-ghost, #7a7772);
    position: absolute;
    left: 0;
    top: 0;
    overflow: visible;
    pointer-events: none;
    z-index: 4;
  }
  /* The original outline. Dashed and thin - it is a reference, not a control -
     and `vector-effect` keeps it one device pixel at every zoom. */
  .ghost {
    fill: none;
    stroke: var(--wg-ghost);
    stroke-width: 1;
    stroke-dasharray: 5 4;
    vector-effect: non-scaling-stroke;
  }
  .mesh {
    fill: none;
    stroke: var(--wg-mesh);
    stroke-width: 1;
    opacity: 0.75;
    vector-effect: non-scaling-stroke;
  }
  .wh {
    fill: #fff;
    stroke: var(--wg-handle-line);
    stroke-width: 1.5;
    pointer-events: all;
    cursor: grab;
  }
  .wh.held {
    fill: var(--wg-mesh);
    cursor: grabbing;
  }
  /* The focused handle is the one the arrow keys move, so it has to be the one
     that looks different. A ring rather than the browser's outline, which an
     svg circle draws as a box around it. */
  .wh:focus {
    outline: none;
    fill: var(--wg-mesh);
    stroke-width: 3;
  }
  .warp-reset {
    position: absolute;
    left: 0;
    top: -24px;
    z-index: 4;
    padding: 2px 8px;
    font: 500 11px/1.4 inherit;
    letter-spacing: 0.02em;
    color: var(--accent-fg, #f8f7f4);
    background: var(--accent, #2c2b28);
    border: none;
    border-radius: var(--radius, 6px);
    box-shadow: var(--edge-soft, 0 1px 2px rgba(42, 38, 32, 0.05));
    cursor: pointer;
  }
  .warp-reset:hover {
    opacity: 0.85;
  }
</style>
