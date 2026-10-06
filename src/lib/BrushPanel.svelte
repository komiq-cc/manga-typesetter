<script>
  // The brush tool's panel. It replaces the Inspector's body while the brush is
  // armed: what is on screen is the options for what you are doing, not for
  // what is selected.
  //
  // Six icon tabs. The board first, because drawing is what the tool is for;
  // then the brush itself, the three groups of settings that are mostly set
  // once, and the finish a placed layer starts with. Icons rather than words so
  // six fit the panel's width without a label ever truncating.
  import { app, page, byId, toast, addInkBox, setBoxInk, visibleCenterInView } from './store.svelte.js';
  import {
    brushTool,
    BRUSH_TABS,
    BRUSH_MODES,
    ERASE_MODES,
    WIDTH_DIRS,
    setBrushTab,
    setBrushMode,
    setEraseMode,
    openBrushManager,
  } from './brush-tool.svelte.js';
  import { liquifyTool, setLiquifyMode, LIQUIFY_RADIUS_MIN, LIQUIFY_RADIUS_MAX } from './liquify-tool.svelte.js';
  import { LIQUIFY_MODES } from './liquify.js';
  import {
    board,
    boardPlacement,
    boardEditStrokes,
    loadBoardFromBox,
    cancelBoardEdit,
    resetBoard,
    undoBoard,
    redoBoard,
    clearBoard,
  } from './brush-board.svelte.js';
  import { DYN_SOURCES, TIP_ORDERS, FLIP_MODES, BLEND_MODES, AA_LEVELS, buildStroke, strokeBounds } from './brush.js';
  import { drawInk, inkActive } from './text-paint.js';
  import { normalizeStroke, normalizeShadow } from './data.js';
  import {
    BUILTIN_BRUSH,
    brushLibrary,
    installedBrushes,
    loadBrushLibrary,
    resolveBrush,
  } from './brush-library.svelte.js';
  import { settleTips } from './brush-tips.js';
  import { filterBrushes, pickedSettings, tipDims } from './brush-picker.js';
  import ColorPicker from './ColorPicker.svelte';
  import { tipCell } from './brush-tip-cell.js';
  import { brushTabIcons } from './tab-icons.js';
  import BrushBoard from './BrushBoard.svelte';

  const s = $derived(brushTool.settings);
  const fin = $derived(brushTool.finish);
  const tab = $derived(brushTool.tab);
  const mode = $derived(brushTool.mode ?? 'draw');

  loadBrushLibrary();

  const TAB_LABEL = {
    board: 'Board',
    brush: 'Brush',
    shape: 'Shape',
    dynamics: 'Dynamics',
    correction: 'Correction',
    finish: 'Finish',
  };

  // ---- the finish ------------------------------------------------------
  // One outline and one shadow here, on or off: the panel is the starting
  // point for a placed layer, and the Inspector's Stroke and Shadow tabs take
  // over from there with as many of each as the letterer wants.
  function flipOutline() {
    fin.strokes = fin.strokes.length ? [] : [normalizeStroke({ color: '#ffffff', width: 4 })];
  }
  function flipShadow() {
    fin.shadows = fin.shadows.length
      ? []
      : [normalizeShadow({ x: 3, y: 3, blur: 4, color: '#000000', opacity: 0.5 })];
  }

  function onTabKey(e, id) {
    const i = BRUSH_TABS.indexOf(id);
    let n = null;
    if (e.key === 'ArrowLeft') n = (i + BRUSH_TABS.length - 1) % BRUSH_TABS.length;
    else if (e.key === 'ArrowRight') n = (i + 1) % BRUSH_TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = BRUSH_TABS.length - 1;
    if (n == null) return;
    e.preventDefault();
    setBrushTab(BRUSH_TABS[n]);
    document.getElementById(`brush-tab-${BRUSH_TABS[n]}`)?.focus();
  }

  // ---- the board --------------------------------------------------------

  let zoom = $state(1);
  const ZOOMS = [1, 2, 3];
  const MODE_LABEL = { draw: 'Draw', erase: 'Erase', width: 'Width', liquify: 'Liquify' };
  const ERASE_LABEL = { whole: 'Whole stroke', part: 'Touched part', cross: 'To crossing' };
  const ERASE_HINT = {
    whole: 'Any stroke the circle touches goes.',
    part: 'Only the part of the line under the circle goes; the rest stays as two strokes.',
    cross: 'The part under the circle goes, out to where the line crosses another - or itself.',
  };
  const WIDTH_LABEL = { thicken: 'Thicken', narrow: 'Narrow' };
  const LIQ_LABEL = { push: 'Push', expand: 'Expand', pinch: 'Pinch', twirl: 'Twirl' };

  const selectedBox = $derived(app.selectedId ? byId(app.selectedId) : null);
  const selectedHasInk = $derived(!!selectedBox && inkActive(selectedBox.style?.ink));
  const editingThis = $derived(
    !!board.editing && !!selectedBox && board.editing.boxId === selectedBox.id,
  );

  function place() {
    const pl = boardPlacement();
    if (!pl) return;
    const { x, y } = visibleCenterInView();
    const id = addInkBox({ ...pl, finish: $state.snapshot(fin) }, x, y);
    if (!id) {
      toast('Nothing to place on - open a chapter first');
      return;
    }
    resetBoard();
    toast('Placed on the page as a new layer');
  }

  function editSelected() {
    const b = selectedBox;
    if (!b || !selectedHasInk) return;
    loadBoardFromBox(page().id, b.id, $state.snapshot(b.style.ink.strokes), {
      strokes: $state.snapshot(b.style.strokes),
      shadows: $state.snapshot(b.style.shadows),
    });
    setBrushMode('draw');
  }

  function applyEdit() {
    const e = board.editing;
    const strokes = boardEditStrokes();
    if (!e || !strokes) return;
    if (!setBoxInk(e.pageId, e.boxId, strokes)) {
      toast('That box is gone - place the strokes as a new layer instead');
      cancelBoardEdit();
      return;
    }
    resetBoard();
    toast('Applied to the box');
  }

  function cancelEdit() {
    cancelBoardEdit();
    resetBoard();
  }

  // ---- the picker -------------------------------------------------------

  const ROUND = { id: BUILTIN_BRUSH, name: 'Round', builtin: true };
  let query = $state('');
  const shown = $derived(filterBrushes([ROUND, ...installedBrushes], query));
  const current = $derived(resolveBrush(s.brush));
  const currentName = $derived(
    current.name ?? (current.missing ? `Missing brush ${current.id.slice(0, 6)}` : ROUND.name),
  );

  // Snapshots rather than the live proxies: an entry's `settings` belong to the
  // library, and spreading the proxy would hand the tool the same nested
  // `taperIn` the library row holds.
  function pick(entry) {
    brushTool.settings = pickedSettings($state.snapshot(brushTool.settings), $state.snapshot(entry));
  }

  // ---- the live preview -------------------------------------------------

  let prevEl = $state(null);
  let prevTips = null;
  let prevSeq = 0;
  const PREV_W = 288;
  const PREV_H = 46;
  const sample = [
    [10, 31, 1], [52, 14, 1], [96, 34, 1], [140, 20, 1], [196, 12, 1], [278, 27, 1],
  ];

  // The margin the preview keeps around a real stroke, CSS px.
  const PREV_PAD = 3;

  function paintPreview(el, tips) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = PREV_W * dpr;
    el.height = PREV_H * dpr;
    const ctx = el.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, PREV_W, PREV_H);
    const snap = $state.snapshot(s);
    const gesture = brushTool.lastGesture;
    if (gesture?.length > 1) {
      // The letterer's own last stroke, captured again through the settings
      // as they stand now - dynamics and corrections included - and fitted
      // into the strip. The seed is pinned so the jitter does not reshuffle
      // on every slider tick. Never scaled up: a small stroke stays small.
      const k = buildStroke(gesture, snap);
      if (!k) return;
      k.seed = 1;
      const b = strokeBounds(k);
      const bw = Math.max(1, b.maxX - b.minX);
      const bh = Math.max(1, b.maxY - b.minY);
      const sc = Math.min(1, (PREV_W - PREV_PAD * 2) / bw, (PREV_H - PREV_PAD * 2) / bh);
      ctx.translate(PREV_W / 2, PREV_H / 2);
      ctx.scale(sc, sc);
      ctx.translate(-(b.minX + b.maxX) / 2, -(b.minY + b.maxY) / 2);
      drawInk(ctx, { on: true, strokes: [k] }, undefined, tips);
      return;
    }
    // Before any stroke is drawn: the canned wave. The tool's settings as a
    // stroke: every render-time field rides along, and the capture-time ones
    // (dynamics, correction) are ignored by the painter. The corners are the
    // one capture-time fact the painter reads, so they are stated from the
    // sharp-angle switch as `buildStroke` does.
    drawInk(ctx, {
      on: true,
      strokes: [{
        ...snap, size: Math.min(s.size, 26), seed: 1, pts: sample,
        corners: snap.sharpAngles?.on ? snap.sharpAngles.deg : 0,
      }],
    }, undefined, tips);
  }

  $effect(() => {
    const el = prevEl;
    if (!el) {
      prevTips = null;
      prevSeq++;
      return;
    }
    const live = JSON.stringify($state.snapshot(s));
    void brushTool.lastGesture;
    paintPreview(el, prevTips);
    const id = s.brush;
    if (!id || id === BUILTIN_BRUSH) {
      prevTips = null;
      prevSeq++;
      void live;
      return;
    }
    const seq = ++prevSeq;
    settleTips([id]).then(
      (map) => {
        if (seq !== prevSeq || prevEl !== el || !el.width) return;
        const before = prevTips;
        prevTips = map;
        if ((before?.get(id) ?? null) !== (map?.get(id) ?? null)) paintPreview(el, map);
      },
      () => {},
    );
    void live;
  });
  function prevCanvas(node) {
    return {
      destroy() {
        node.width = 0;
        node.height = 0;
      },
    };
  }
  $effect(() => () => {
    prevTips = null;
    prevSeq++;
  });

  const num = (obj, key, v, lo, hi) => {
    obj[key] = Math.min(hi, Math.max(lo, Number(v) || 0));
  };
  const DYN_LABEL = { off: 'Off', pressure: 'Pressure', velocity: 'Velocity', random: 'Random' };
  const TIP_ORDER_LABEL = { repeat: 'Repeat', reverse: 'Reverse', once: 'Once', random: 'Random' };
  const FLIP_LABEL = { off: 'Off', on: 'On', random: 'Random' };
  const BLEND_LABEL = { over: 'Normal', density: 'Compare density' };
  const AA_LABEL = ['None', 'Weak', 'Middle', 'Strong'];
</script>

{#snippet seg(label, obj, key, options, labels, hint)}
  <div class="grp">
    <span class="lbl">{label}</span>
    <div class="seg" title={hint}>
      {#each options as o, i (o)}
        <button type="button" class:on={obj[key] === o} aria-pressed={obj[key] === o} onclick={() => (obj[key] = o)}>{Array.isArray(labels) ? labels[i] : labels[o]}</button>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet slider(label, obj, key, lo, hi, max, unit, hint)}
  <div class="grp">
    <span class="lbl">{label}</span>
    <div class="slider-row">
      <input type="range" min={lo} max={max ?? hi} step="1" value={obj[key]} title={hint} aria-label={label} oninput={(e) => num(obj, key, e.target.value, lo, hi)} />
      <input class="num-s" type="number" min={lo} max={hi} step="1" value={obj[key]} aria-label="{label}, {unit}" onchange={(e) => num(obj, key, e.target.value, lo, hi)} />
    </div>
  </div>
{/snippet}

{#snippet pctSlider(label, obj, key, lo, hint)}
  <div class="grp">
    <span class="lbl">{label}</span>
    <div class="slider-row">
      <input type="range" min={lo} max="100" step="1" value={Math.round(obj[key] * 100)} title={hint} aria-label={label} oninput={(e) => (obj[key] = Math.min(1, Math.max(lo / 100, Number(e.target.value) / 100)))} />
      <input class="num-s" type="number" min={lo} max="100" step="1" value={Math.round(obj[key] * 100)} aria-label="{label}, percent" onchange={(e) => (obj[key] = Math.min(1, Math.max(lo / 100, Number(e.target.value) / 100)))} />
    </div>
  </div>
{/snippet}

{#snippet dynGroup(label, key)}
  <div class="grp">
    <span class="lbl">{label}</span>
    <div class="seg">
      {#each DYN_SOURCES as src (src)}
        <button type="button" class:on={s[key].src === src} aria-pressed={s[key].src === src} onclick={() => (s[key].src = src)}>{DYN_LABEL[src]}</button>
      {/each}
    </div>
  </div>
  <div class="nest" class:disabled={s[key].src === 'off'}>
    {@render slider('Amount', s[key], 'amount', 0, 100, null, 'percent')}
  </div>
  {#if s[key].curve}
    <div class="grp">
      <span class="lbl">Response</span>
      <svg class="curve" viewBox="0 0 100 44" preserveAspectRatio="none" role="img" aria-label="Imported response curve, {s[key].curve.length} points">
        <line class="ident" x1="0" y1="44" x2="100" y2="0" vector-effect="non-scaling-stroke" />
        <polyline points={s[key].curve.map(([x, y]) => `${x * 100},${(1 - y) * 44}`).join(' ')} vector-effect="non-scaling-stroke" />
      </svg>
    </div>
    <p class="hint">This brush brought its own response curve from its .sut file. Amount still scales it.</p>
  {/if}
{/snippet}

{#snippet toggle(label, obj, key)}
  {@render flip(label, !!obj[key], () => (obj[key] = !obj[key]))}
{/snippet}

{#snippet flip(label, on, fn)}
  <div class="switch-row">
    <button type="button" class="switch" class:on role="switch" aria-checked={on} aria-label={label} onclick={fn}><span class="knob"></span></button>
    <span class="lbl2">{label}</span>
  </div>
{/snippet}

{#snippet colour(label, obj, key)}
  <div class="grp">
    <span class="lbl">{label}</span>
    <div class="colour-row">
      <ColorPicker value={obj[key]} {label} size={24} unclipped onchange={(hex) => (obj[key] = hex)} />
      <span class="hex">{obj[key]}</span>
    </div>
  </div>
{/snippet}

<div class="brush-tabs" role="tablist" aria-label="Brush options">
  {#each BRUSH_TABS as id (id)}
    <button
      type="button"
      role="tab"
      id="brush-tab-{id}"
      class="brush-tab"
      class:on={tab === id}
      aria-selected={tab === id}
      aria-label={TAB_LABEL[id]}
      aria-controls="brush-tabpanel"
      tabindex={tab === id ? 0 : -1}
      title={TAB_LABEL[id]}
      onclick={() => setBrushTab(id)}
      onkeydown={(e) => onTabKey(e, id)}
    >
      {@html brushTabIcons[id]}
    </button>
  {/each}
</div>

<div class="insp-pane" role="tabpanel" id="brush-tabpanel" aria-labelledby="brush-tab-{tab}">
  {#if tab !== 'board'}
    <canvas class="bpv" bind:this={prevEl} use:prevCanvas style="width:{PREV_W}px;height:{PREV_H}px" aria-label="Brush preview"></canvas>
  {/if}

  {#if tab === 'board'}
    <div class="grp">
      <span class="lbl">Mode</span>
      <div class="seg">
        {#each BRUSH_MODES as m (m)}
          <button type="button" class:on={mode === m} aria-pressed={mode === m} onclick={() => setBrushMode(m)}>{MODE_LABEL[m]}</button>
        {/each}
      </div>
    </div>

    {#if mode === 'liquify'}
      {@render seg('Tool', liquifyTool, 'mode', LIQUIFY_MODES, LIQ_LABEL)}
      {@render slider('Radius', liquifyTool, 'radius', LIQUIFY_RADIUS_MIN, LIQUIFY_RADIUS_MAX, null, 'page px')}
      {@render slider('Strength', liquifyTool, 'strength', 0, 100, null, 'percent')}
      <p class="hint">Bends the strokes' own points, so a pushed stroke is still a stroke. Esc during a drag puts it back.</p>
    {:else}
      {@render slider('Size', s, 'size', 1, 2000, 400, 'page px', mode === 'draw' ? undefined : 'The circle the tool reaches with')}
    {/if}
    {#if mode === 'erase'}
      {@render seg('Takes', brushTool, 'eraseMode', ERASE_MODES, ERASE_LABEL)}
      <p class="hint">{ERASE_HINT[brushTool.eraseMode]}</p>
    {:else if mode === 'width'}
      {@render seg('Direction', brushTool.width, 'dir', WIDTH_DIRS, WIDTH_LABEL)}
      {@render slider('Amount', brushTool.width, 'amount', 1, 100, null, 'percent per pass')}
      <p class="hint">Each pass over a line changes its width by this much at the circle's centre, less towards the rim. CSP's Adjust line width.</p>
    {/if}

    <div class="boardbar">
      <div class="seg zoom" aria-label="Board zoom">
        {#each ZOOMS as z (z)}
          <button type="button" class:on={zoom === z} aria-pressed={zoom === z} onclick={() => (zoom = z)}>{z}×</button>
        {/each}
      </div>
      <button type="button" class="icobtn" title="Undo (⌘Z on the board)" aria-label="Undo board" disabled={!board.canUndo} onclick={undoBoard}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
      </button>
      <button type="button" class="icobtn" title="Redo (⇧⌘Z on the board)" aria-label="Redo board" disabled={!board.canRedo} onclick={redoBoard}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg>
      </button>
      <button type="button" class="icobtn" title="Clear the board" aria-label="Clear board" disabled={!board.strokes.length} onclick={clearBoard}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></svg>
      </button>
    </div>

    <BrushBoard {zoom} />

    {#if board.editing}
      <p class="hint">{editingThis ? 'Editing the selected layer\'s ink.' : 'Editing a placed layer\'s ink (not the selected box).'} Apply writes it back to that layer; Cancel leaves it as it was.</p>
      <div class="actions">
        <button type="button" class="act primary" onclick={applyEdit}>Apply to layer</button>
        <button type="button" class="act" onclick={cancelEdit}>Cancel</button>
        {#if selectedHasInk && !editingThis}
          <button type="button" class="act" title="Drop this edit and bring the selected layer's strokes to the board" onclick={editSelected}>Edit selected</button>
        {/if}
      </div>
    {:else}
      <div class="actions">
        <button type="button" class="act primary" disabled={!board.strokes.length || !app.pages.length} title="Add the board's strokes to the page as a new layer" onclick={place}>Place on page</button>
        {#if selectedHasInk && !editingThis}
          <button type="button" class="act" title="Bring the selected layer's strokes back to the board" onclick={editSelected}>Edit selected</button>
        {/if}
      </div>
      {#if !board.strokes.length}
        <p class="hint">Draw on the board, then place it on the page as its own layer. Right-click a brush to edit it.</p>
      {/if}
    {/if}
  {/if}

  {#if tab === 'brush'}
    <div class="picker-head">
      <input class="find" type="text" placeholder="Find a brush" aria-label="Find a brush" bind:value={query} disabled={!installedBrushes.length} />
      <button type="button" class="icobtn" aria-label="Manage brushes" title="Brush library - import, edit, remove" onclick={() => openBrushManager()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h10" /></svg>
      </button>
    </div>

    {#if !installedBrushes.length}
      <div class="tip-grid empty">
        <div class="emptymsg">
          <strong>No brushes yet</strong>
          <span>Import <code>.sut</code> or <code>.abr</code> files from the library. The round tip works meanwhile.</span>
        </div>
      </div>
      <button type="button" class="addbtn" onclick={() => openBrushManager()}>Open the brush library…</button>
    {:else if !shown.length}
      <div class="tip-grid empty">
        <div class="emptymsg"><span>No brush is called “{query}”.</span></div>
      </div>
    {:else}
      <div class="tip-grid">
        {#each shown as b (b.id)}
          <button
            type="button"
            class="tip"
            class:on={s.brush === b.id}
            aria-pressed={s.brush === b.id}
            title={b.builtin ? b.name : `${b.name}${b.source === 'thumbnail' ? ' - preview quality' : ''} (right-click to edit)`}
            aria-label={b.name}
            onclick={() => pick(b)}
            oncontextmenu={(e) => {
              if (b.builtin) return;
              e.preventDefault();
              openBrushManager(b.id);
            }}
          >
            <canvas class="tipc" use:tipCell={b.id} aria-hidden="true"></canvas>
          </button>
        {/each}
      </div>
    {/if}

    <div class="tip-name">
      <span class="nm" title={currentName}>{currentName}</span>
      {#if current.missing}
        <span class="chip" title="This brush is not installed here. Strokes drawn with it use the round tip.">missing</span>
      {:else if current.source === 'thumbnail'}
        <span class="chip" title="The pixels could not be read, so this is CSP's own preview of the tip.">preview quality</span>
      {/if}
      <span class="dim">{tipDims(current)}</span>
    </div>
    {#if brushLibrary.error}
      <p class="hint warn">{brushLibrary.error}</p>
    {/if}

    <div class="insp-rule"></div>
    {@render slider('Size', s, 'size', 1, 2000, 400, 'page px')}
    {@render pctSlider('Opacity', s, 'opacity', 0)}
    {@render colour('Ink colour', s, 'color')}
    {@render seg('Anti-alias', s, 'antialias', [0, 1, 2, 3], AA_LABEL, "CSP's four grades. None is the pixel look; Weak and Middle keep a narrower band of the edge's ramp")}
    {@render seg('Blend', s, 'blend', BLEND_MODES, BLEND_LABEL, 'How the finished stroke lands on the ink under it')}
    {#if s.blend === 'density'}
      <p class="hint">Where this stroke crosses earlier ink the denser wins and nothing adds up. CSP's "Compare density".</p>
    {/if}
  {/if}

  {#if tab === 'finish'}
    {@render flip('Outline', fin.strokes.length > 0, flipOutline)}
    {#if fin.strokes[0]}
      <div class="nest">
        {@render colour('Outline colour', fin.strokes[0], 'color')}
        {@render slider('Width', fin.strokes[0], 'width', 1, 40, null, 'page px', 'The visible band around the ink')}
        {@render pctSlider('Opacity', fin.strokes[0], 'opacity', 0)}
      </div>
    {/if}
    <div class="insp-rule"></div>
    {@render flip('Shadow', fin.shadows.length > 0, flipShadow)}
    {#if fin.shadows[0]}
      <div class="nest">
        {@render colour('Shadow colour', fin.shadows[0], 'color')}
        {@render slider('Offset X', fin.shadows[0], 'x', -50, 50, null, 'page px')}
        {@render slider('Offset Y', fin.shadows[0], 'y', -50, 50, null, 'page px')}
        {@render slider('Blur', fin.shadows[0], 'blur', 0, 50, null, 'page px')}
        {@render pctSlider('Opacity', fin.shadows[0], 'opacity', 0)}
      </div>
    {/if}
    <p class="hint">
      {#if board.editing}
        The board is showing the edited layer's own outline and shadow; change those in the Inspector's Effects tab. These are for the next layer placed.
      {:else}
        Drawn around the whole of the ink once each stroke is down, and given to the layer when it is placed. From then on the Inspector's Effects tab edits them.
      {/if}
    </p>
  {/if}

  {#if tab === 'shape'}
    {@render slider('Spacing', s, 'spacing', 1, 200, 100, 'percent', 'How far the tip moves between stamps, as a percentage of its size')}
    {@render slider('Angle', s, 'angle', 0, 359, null, 'degrees')}
    {@render slider('Hardness', s, 'hardness', 0, 100, null, 'percent', '100 is a flat disc; lower softens the edge')}
    {@render pctSlider('Flatness', s, 'flatness', 1, 'Squashes the tip across its angle')}
    {@render seg('Flip across', s, 'flipX', FLIP_MODES, FLIP_LABEL, 'Mirror the tip across the stroke, always or per stamp')}
    {@render seg('Flip along', s, 'flipY', FLIP_MODES, FLIP_LABEL, 'Mirror the tip along the stroke, always or per stamp')}
    <div class="insp-rule"></div>
    {@render toggle('Follow stroke', s, 'followDir')}
    <p class="hint">The tip turns to face the way the stroke is going, with the angle above added. CSP's "Direction of line".</p>
    {@render toggle('Ribbon', s, 'ribbon')}
    <p class="hint">The tip is laid along the stroke as one continuous band instead of stamped. What a dry-brush or edged pen needs to streak.</p>
    {@render toggle('Darken overlaps', s, 'darkenTips')}
    <p class="hint">Where stamps overlap the darker wins, so a textured tip keeps its grain instead of clotting solid.</p>
    {#if s.tips?.length > 1}
      <div class="grp">
        <span class="lbl">{s.tips.length} tips, order</span>
        <div class="seg">
          {#each TIP_ORDERS as o (o)}
            <button type="button" class:on={s.tipOrder === o} aria-pressed={s.tipOrder === o} onclick={() => (s.tipOrder = o)}>{TIP_ORDER_LABEL[o]}</button>
          {/each}
        </div>
      </div>
      <p class="hint">This brush came with several tip images and cycles through them along the stroke. CSP's "Repeat method".</p>
    {/if}
    <div class="insp-rule"></div>
    {@render toggle('Watercolour edge', s, 'waterEdge')}
    {#if s.waterEdge}
      <div class="nest">
        {@render slider('Width', s, 'waterEdgeWidth', 1, 20, null, 'page px', "How far past the stroke's edge the rim reaches")}
        {@render pctSlider('Opacity', s, 'waterEdgePower', 0, 'How solid the rim is')}
        {@render pctSlider('Darkness', s, 'waterEdgeDark', 0, 'How far the rim goes from the ink colour towards black')}
        {@render slider('Blur', s, 'waterEdgeBlur', 0, 20, null, 'page px', 'Softens the rim')}
      </div>
      <p class="hint">Drawn outside the stroke, as CSP draws it. With anti-alias off it is solid.</p>
    {/if}
    <div class="insp-rule"></div>
    {@render toggle('Texture', s.texture, 'on')}
    {#if s.texture.on}
      <div class="nest">
        {@render pctSlider('Density', s.texture, 'density', 0, 'How much of the grain shows through the ink')}
        {@render slider('Scale', s.texture, 'scale', 10, 1000, 400, 'percent', 'How coarse the grain is')}
        {@render toggle('Emphasise density', s.texture, 'stress')}
      </div>
      <p class="hint">A noise grain fixed to the page, so strokes over the same spot share it. An imported brush names CSP's stock noise texture; the pixels are not in the file, so this is the engine's own.</p>
    {/if}
  {/if}

  {#if tab === 'dynamics'}
    {#if brushTool.pen}
      <p class="hint">
        Last input: {brushTool.pen.type}, pressure {brushTool.pen.pressure.toFixed(2)}.
        {#if brushTool.pen.type !== 'pen'}A pen that shows as "{brushTool.pen.type}" is not sending pressure; velocity and random still work.{/if}
      </p>
    {/if}
    {@render dynGroup('Size follows', 'dyn')}
    {#if !s.dyn.curve && s.dyn.src === 'velocity'}
      <p class="hint">Velocity thins the middle of a fast stroke and leaves the ends thick.</p>
    {/if}
    {@render dynGroup('Opacity follows', 'dynOpacity')}
    {@render dynGroup('Thickness follows', 'dynThick')}
    <p class="hint">Opacity fades the ink where the source is low; thickness squashes the tip across the stroke. CSP's Opacity and Thickness dynamics.</p>
    <div class="insp-rule"></div>
    {#each [['taperIn', 'Taper in'], ['taperOut', 'Taper out']] as [key, label] (key)}
      {@render toggle(label, s[key], 'on')}
      <div class="nest" class:disabled={!s[key].on}>
        <div class="grp">
          <span class="lbl">Length is</span>
          <div class="seg">
            <button type="button" class:on={s[key].mode !== 'pct'} aria-pressed={s[key].mode !== 'pct'} onclick={() => (s[key].mode = 'px')}>Page px</button>
            <button type="button" class:on={s[key].mode === 'pct'} aria-pressed={s[key].mode === 'pct'} onclick={() => (s[key].mode = 'pct')}>% of size</button>
          </div>
        </div>
        {@render slider('Length', s[key], 'len', 0, 500, 200, s[key].mode === 'pct' ? 'percent of size' : 'page px')}
        {@render slider('Sharpness', s[key], 'ratio', 0, 100, null, 'percent')}
      </div>
    {/each}
    {@render toggle('Taper by speed', s, 'taperBySpeed')}
    <p class="hint">A stroke that starts or ends slowly tapers less. CSP's "Starting and ending by speed".</p>
  {/if}

  {#if tab === 'correction'}
    {@render slider('Stabilisation', s, 'stabilise', 0, 100, null, 'percent')}
    {#if s.stabilise > 40}
      <p class="hint">Above 40 the stroke visibly trails the cursor. That is the trade for a steady curve.</p>
    {/if}
    {@render toggle('Adjust by speed', s, 'stabiliseBySpeed')}
    <p class="hint">A slow, careful stretch is steadied harder; a fast sweep is trusted.</p>
    <div class="insp-rule"></div>
    {@render slider('Post-correction', s, 'postCorrect', 0, 100, null, 'percent', 'Smooths the finished stroke once the pointer lifts')}
    {#if s.postCorrect > 50}
      <p class="hint">Above 50 a wavy pass is pulled towards a straight line, as CSP does.</p>
    {/if}
    {@render toggle('Adjust by speed', s, 'postBySpeed')}
    <p class="hint">The faster the hand moved through a stretch, the harder that stretch is smoothed.</p>
    {@render toggle('Bezier', s, 'postBezier')}
    <p class="hint">The corrected line is fitted as a curve instead of kept as the polyline of its samples.</p>
    <div class="insp-rule"></div>
    {@render toggle('Sharp angles', s.sharpAngles, 'on')}
    <div class="nest" class:disabled={!s.sharpAngles.on}>
      {@render slider('Threshold', s.sharpAngles, 'deg', 5, 170, null, 'degrees', 'A turn sharper than this is kept as a corner')}
    </div>
    <p class="hint">A turn past the threshold is left alone by both corrections and drawn as a point, not two round ends meeting.</p>
  {/if}
</div>

<style>
  /* The tab strip: the Inspector's own, icons only. Sticky for the same reason
     - a panel gripped down to a few rows must still reach its tabs. */
  .brush-tabs {
    position: sticky;
    top: -12px;
    z-index: 2;
    display: grid;
    grid-template-columns: repeat(6, minmax(32px, 1fr));
    gap: 4px;
    margin: -12px -12px 2px;
    padding: 12px 12px 8px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }
  .brush-tab {
    display: grid;
    place-items: center;
    height: 36px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
    min-width: 0;
  }
  .brush-tab :global(svg) {
    width: 19px;
    height: 19px;
  }
  .brush-tab:hover {
    color: var(--text);
    background: var(--surface);
  }
  .brush-tab.on {
    color: var(--accent-fg);
    background: var(--accent);
    border-color: var(--accent);
  }
  .brush-tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .bpv {
    display: block;
    max-width: 100%;
    height: 46px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--paper);
  }

  /* Zoom on the left, the three board verbs on the right. */
  .boardbar {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .boardbar .zoom {
    margin-right: auto;
  }
  .boardbar .zoom button {
    padding: 0 9px;
    flex: 0 0 auto;
    font-size: 12px;
  }
  .icobtn {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--t2);
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .icobtn svg {
    width: 15px;
    height: 15px;
  }
  .icobtn:hover:not(:disabled) {
    color: var(--text);
  }
  .icobtn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .actions {
    display: flex;
    gap: 6px;
  }
  .act {
    flex: 1 1 auto;
    height: 30px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .act.primary {
    background: var(--accent);
    color: var(--accent-fg);
    border-color: var(--accent);
  }
  .act:hover:not(:disabled) {
    filter: brightness(1.06);
  }
  .act:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .picker-head {
    display: flex;
    gap: 6px;
  }
  .find {
    flex: 1 1 auto;
    min-width: 0;
    height: 28px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    padding: 0 9px;
  }
  .find::placeholder {
    color: var(--t3);
  }
  .find:disabled {
    opacity: 0.45;
  }
  .tip-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 5px;
    max-height: 168px;
    overflow: auto;
    padding: 5px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--surface);
  }
  .tip-grid.empty {
    grid-template-columns: 1fr;
    place-items: center;
    min-height: 120px;
    max-height: none;
    overflow: visible;
  }
  /* A tip is ink on paper in BOTH themes. */
  .tip {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    min-width: 0;
    padding: 3px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: var(--paper);
    cursor: pointer;
  }
  .tipc {
    max-width: 100%;
    max-height: 100%;
    display: block;
  }
  .tip:hover {
    border-color: var(--line2);
  }
  .tip.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .tip-name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text);
    min-width: 0;
  }
  .tip-name .nm {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tip-name .dim {
    margin-left: auto;
    flex: 0 0 auto;
    color: var(--t3);
    font-variant-numeric: tabular-nums;
  }
  .chip {
    flex: 0 0 auto;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid var(--warn);
    color: var(--warn);
    font-size: 9.5px;
    letter-spacing: 0.08em;
  }
  .addbtn {
    height: 28px;
    border: 1px dashed var(--line2);
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .addbtn:hover {
    color: var(--text);
  }
  .emptymsg {
    display: flex;
    flex-direction: column;
    gap: 5px;
    text-align: center;
    padding: 14px;
    max-width: 236px;
  }
  .emptymsg strong {
    font-size: 12px;
    color: var(--text);
    font-weight: 600;
  }
  .emptymsg span {
    font-size: 11px;
    line-height: 1.5;
    color: var(--t3);
  }
  .emptymsg code {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 10.5px;
    color: var(--t2);
  }
  .colour-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .colour-row .hex {
    font-size: 12px;
    color: var(--t2);
    font-variant-numeric: tabular-nums;
  }
  .nest {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding-left: 11px;
    border-left: 1px solid var(--line);
  }
  .nest.disabled {
    opacity: 0.45;
    pointer-events: none;
  }
  .curve {
    width: 100%;
    height: 44px;
    border: 1px solid var(--line2);
    border-radius: 4px;
    background: none;
  }
  .curve polyline {
    fill: none;
    stroke: var(--text);
    stroke-width: 1.5;
    stroke-linejoin: round;
  }
  .curve .ident {
    stroke: var(--line2);
    stroke-width: 1;
    stroke-dasharray: 2 3;
  }
  .hint {
    font-size: 11px;
    line-height: 1.45;
    color: var(--t3);
    margin: 0;
  }
  .hint.warn {
    color: var(--warn);
  }
</style>
