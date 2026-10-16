<script>
  // ===== The Regions view (Bubble C, FLOW-7, FLOW-12) =====
  //
  // One page's bubble outlines, drawn over the art while `app.showRegions` is
  // on: every box's outline in the colour of its approval state, the selected
  // box's outline with its points, the detected text blocks that have no box
  // yet, and a line-number chip on every box and every unplaced block.
  //
  // The svg is in page pixels (its viewBox is the page), so nothing here
  // multiplies by the zoom, and `vector-effect` keeps every line one screen
  // pixel at any zoom. It takes no pointer events except on the selected
  // outline's points and edges, so boxes underneath keep every gesture of
  // their own.
  //
  // Editing the points: drag a point; double-click an edge to add one; click a
  // point to pick it and press Delete or Backspace to remove it. A drag moves
  // the outline live (`previewOutlinePoints`) and is recorded once, on release
  // (`commitOutlinePoints`), as one undo step that typesets the text again
  // inside the new outline. Escape during a drag puts the outline back.
  import {
    app,
    outlineState,
    outlinePoints,
    outlineGeom,
    previewOutlinePoints,
    commitOutlinePoints,
    isFreeLine,
  } from '../store.svelte.js';
  import { MAX_POLY_POINTS } from '../data.js';

  let { pg } = $props();

  let svgEl = $state(null);
  // The point picked for Delete, as { boxId, i }.
  let picked = $state(null);
  let drag = null;

  const selected = $derived(pg.boxes.find((b) => b.id === app.selectedId) ?? null);
  const handles = $derived(selected && selected.fit && !app.peekRaw ? outlinePoints(selected.fit) : []);
  const placed = $derived(new Set(pg.boxes.map((b) => b.lineN).filter((n) => n != null)));
  // Detected blocks with no box yet: what the detector found and nobody placed.
  const unplaced = $derived(
    (pg.detect?.boxes ?? []).filter((d) => Array.isArray(d.box) && d.box.length === 4 && !placed.has(d.n)),
  );
  const lineOf = (n) => (pg.lines ?? []).find((l) => l.n === n);

  const ptsAttr = (pts) => pts.map(([x, y]) => `${x},${y}`).join(' ');
  // One page pixel on screen, for sizes that must not scale with the page.
  const px = $derived(1 / (app.zoom || 1));

  // Pointer position in page pixels: the svg's box is the page, whatever the
  // zoom, pan or strip offset.
  function toPage(e) {
    const r = svgEl.getBoundingClientRect();
    return [
      Math.round((((e.clientX - r.left) / r.width) * pg.w) * 100) / 100,
      Math.round((((e.clientY - r.top) / r.height) * pg.h) * 100) / 100,
    ];
  }

  function endDrag(cancel) {
    const d = drag;
    if (!d) return;
    drag = null;
    d.ac.abort();
    const b = pg.boxes.find((x) => x.id === d.boxId);
    if (!b) return;
    if (cancel || !d.moved) {
      b.fit = d.geom.fit;
      return;
    }
    commitOutlinePoints(d.boxId, d.pts, pg, d.geom);
  }

  function onPointDown(e, i) {
    if (e.button !== 0 || !selected) return;
    e.preventDefault();
    e.stopPropagation();
    picked = { boxId: selected.id, i };
    const ac = new AbortController();
    drag = { boxId: selected.id, i, pts: handles.map((p) => [...p]), geom: outlineGeom(selected), moved: false, ac };
    const move = (ev) => {
      if (!drag) return;
      const [x, y] = toPage(ev);
      drag.pts[drag.i] = [x, y];
      drag.moved = true;
      const b = pg.boxes.find((bb) => bb.id === drag.boxId);
      if (b) previewOutlinePoints(b, drag.pts);
    };
    const key = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      endDrag(true);
    };
    document.addEventListener('pointermove', move, { signal: ac.signal });
    document.addEventListener('pointerup', () => endDrag(false), { signal: ac.signal });
    document.addEventListener('pointercancel', () => endDrag(true), { signal: ac.signal });
    document.addEventListener('keydown', key, { signal: ac.signal, capture: true });
  }

  // Double-click on an edge: a new point there, on the edge between its two
  // neighbours.
  function onEdgeDouble(e) {
    if (!selected || handles.length >= MAX_POLY_POINTS) return;
    e.preventDefault();
    e.stopPropagation();
    const [x, y] = toPage(e);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < handles.length; i++) {
      const [ax, ay] = handles[i];
      const [bx, by] = handles[(i + 1) % handles.length];
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const pts = handles.map((p) => [...p]);
    pts.splice(best + 1, 0, [x, y]);
    commitOutlinePoints(selected.id, pts, pg);
    picked = { boxId: selected.id, i: best + 1 };
  }

  // Delete / Backspace on a picked point. Capture phase, so the window's
  // "delete box" shortcut never sees a press that meant the point.
  $effect(() => {
    if (!picked) return;
    const key = (ev) => {
      if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
      const t = ev.target;
      if (t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '')) return;
      if (!selected || picked.boxId !== selected.id) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (handles.length <= 3) return;
      const pts = handles.filter((_, j) => j !== picked.i).map((p) => [...p]);
      commitOutlinePoints(selected.id, pts, pg);
      picked = null;
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  });
  // A point picked on another box, or on a box no longer selected, is let go.
  $effect(() => {
    if (picked && picked.boxId !== app.selectedId) picked = null;
  });
  // Unmounted mid-drag (the view switched off, the page turned): the outline
  // goes back to where the drag found it.
  $effect(() => () => endDrag(true));
</script>

<svg
  bind:this={svgEl}
  class="regions"
  viewBox="0 0 {pg.w} {pg.h}"
  preserveAspectRatio="none"
  aria-label="Bubble outlines"
  role="group"
>
  {#each unplaced as d (d.n)}
    <rect
      class="det"
      x={Math.min(d.box[0], d.box[2])}
      y={Math.min(d.box[1], d.box[3])}
      width={Math.abs(d.box[2] - d.box[0])}
      height={Math.abs(d.box[3] - d.box[1])}
    />
    {#if lineOf(d.n) && !isFreeLine(lineOf(d.n))}
      <g class="chip unplaced" transform="translate({Math.min(d.box[0], d.box[2])} {Math.min(d.box[1], d.box[3])}) scale({px})">
        <circle r="9" />
        <text text-anchor="middle" dy="3.5">{d.n}</text>
      </g>
    {/if}
  {/each}

  {#each pg.boxes as b (b.id)}
    {@const state = outlineState(b)}
    {#if b.fit}
      <polygon class="outline {state}" class:sel={b.id === app.selectedId} points={ptsAttr(outlinePoints(b.fit))} />
    {:else if state === 'open'}
      <rect class="outline open" x={b.x} y={b.y} width={b.w} height={b.h} />
    {/if}
    {#if b.lineN != null && b.lineN > 0}
      <g class="chip {state ?? 'none'}" transform="translate({b.x} {b.y}) scale({px})">
        <circle r="9" />
        <text text-anchor="middle" dy="3.5">{b.lineN}</text>
      </g>
    {/if}
  {/each}

  {#if selected && handles.length}
    <!-- The edges take a double-click (add a point); a wide transparent stroke
         so they can be hit. -->
    <polygon class="edges" points={ptsAttr(handles)} ondblclick={onEdgeDouble} role="presentation" />
    {#each handles as [x, y], i (i)}
      <circle
        class="pt"
        class:picked={picked?.boxId === selected.id && picked.i === i}
        cx={x}
        cy={y}
        r={5 * px}
        role="button"
        tabindex="-1"
        aria-label="Outline point {i + 1}"
        onpointerdown={(e) => onPointDown(e, i)}
        onclick={(e) => e.stopPropagation()}
      />
    {/each}
  {/if}
</svg>

<style>
  /* Drawn over the page, which is paper in both themes, so the colours are
     fixed page-facing ones (see WarpGizmo.svelte), not theme tokens. */
  .regions {
    --rg-user: #1f9d55;
    --rg-ai: #2f6fde;
    --rg-waiting: #e08a00;
    --rg-open: #d33a2c;
    --rg-det: #7a7772;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    z-index: 5;
  }
  .outline {
    fill: none;
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .outline.user {
    stroke: var(--rg-user);
  }
  .outline.ai {
    stroke: var(--rg-ai);
  }
  .outline.waiting {
    stroke: var(--rg-waiting);
  }
  .outline.open {
    stroke: var(--rg-open);
    stroke-dasharray: 6 4;
  }
  .outline.sel {
    stroke-width: 3;
  }
  .det {
    fill: rgba(122, 119, 114, 0.08);
    stroke: var(--rg-det);
    stroke-width: 1;
    stroke-dasharray: 4 3;
    vector-effect: non-scaling-stroke;
  }
  .edges {
    fill: none;
    stroke: transparent;
    stroke-width: 10;
    vector-effect: non-scaling-stroke;
    pointer-events: stroke;
    cursor: copy;
  }
  .pt {
    fill: #fff;
    stroke: #00818a;
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
    pointer-events: all;
    cursor: grab;
  }
  .pt.picked {
    fill: #00d5e0;
  }
  .chip circle {
    fill: #2c2b28;
    stroke: #fff;
    stroke-width: 1.5;
  }
  .chip.user circle {
    fill: var(--rg-user);
  }
  .chip.ai circle {
    fill: var(--rg-ai);
  }
  .chip.waiting circle {
    fill: var(--rg-waiting);
  }
  .chip.open circle {
    fill: var(--rg-open);
  }
  .chip.unplaced circle {
    fill: var(--rg-det);
  }
  .chip text {
    fill: #fff;
    font: 600 10px/1 system-ui, sans-serif;
  }
</style>
