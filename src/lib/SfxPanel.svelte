<script>
  // The Inspector's SFX pane: pick a lettering preset, or take it off.
  //
  // It is the Effects tab's first sub-tab. A preset is a fixed recipe: a card
  // writes it to the selected box's `style.sfx` (data.js), and Remove SFX puts
  // the box back as it was (`applySfxPreset`, `clearSfx`). There is nothing to
  // tune here. Every write is followed by the Inspector's `touch`, handed in as
  // a prop, so a pick is one more `style` entry in the same undo flow. The
  // Inspector's capture-phase pointerdown/keydown (`armSnap`) takes the
  // before-snapshot, and this component is rendered inside the element it is
  // set on, so nothing here arms it.
  //
  // Under the browser engine there is no SFX layout (`sfxAvailable`), so the
  // pane is one sentence and, when the host can open Settings, a button.
  //
  // The pictures are the engine's own (sfx-preview.js). The stage repaints on
  // any change to the box's style or text, one paint per frame. The cards are
  // painted while this pane is mounted - that is, open - three a frame, only
  // for the group on show, and only when something their picture depends on has
  // changed; a card already painted is read back from a cache.
  import { onDestroy, untrack } from 'svelte';
  import { app, boxText } from './store.svelte.js';
  import { engineSwitch } from './engine-switch.svelte.js';
  import { settleNoise } from './exporter.js';
  import { sfxAvailable, sfxPresets, applySfxPreset, clearSfx, isEnvelope } from './sfx.js';
  import { cardSpec, cardKey, cachedCard, keepCard, paintCard, paintStage, previewDpr } from './sfx-preview.js';

  /** `box` is the selected box; `pg` its page; `touch` the Inspector's; `onSettings` opens Settings, when it can. */
  let { box, pg, touch, onSettings = null } = $props();

  const GROUPS = ['All', 'Move', 'Size', 'Shape', 'Hand'];
  const BATCH = 3;
  // CSS px; the stage's height in the style block says the same.
  const STAGE_H = 110;

  // The engine can change under an open pane (Settings), and its tables are not
  // reactive, so what stands for "the engine changed" is read here.
  const available = $derived.by(() => {
    engineSwitch.phase;
    engineSwitch.painting;
    app.fontsVersion;
    return sfxAvailable();
  });
  const presets = $derived(available ? sfxPresets() : []);
  const sfx = $derived(box.style.sfx);
  const on = $derived(!!sfx?.on);

  const close = (a, b) => Math.abs(a - b) < 1e-6;
  // Whether the box's recipe is exactly the preset's: the moves, the flow and
  // the row shift, and for a Shape preset the box's mesh being that envelope.
  // A mesh edited by hand is no longer the preset's.
  function isPreset(p) {
    const r = sfx;
    return (
      !!r?.on &&
      (!p.envelope || isEnvelope(box.style, p.envelope, box.w, box.h)) &&
      r.flow === p.flow &&
      close(r.rowShift, p.rowShift ?? 0) &&
      r.moves.length === p.moves.length &&
      p.moves.every((m, i) => r.moves[i].kind === m.kind && close(r.moves[i].a, m.a) && close(r.moves[i].b ?? 0, m.b ?? 0))
    );
  }
  const current = $derived(on ? presets.find(isPreset) : null);
  const label = $derived(!on ? 'No SFX' : (current?.name ?? 'Custom'));

  function pick(preset) {
    applySfxPreset(box.style, preset, box);
    touch();
  }
  function remove() {
    clearSfx(box.style, box);
    touch();
  }
  // A recipe with no moves places no letter: what shows is the box's mesh
  // (a Shape preset).
  const hasMoves = $derived(on && sfx.moves.length > 0);

  // ---- the stage ----
  let stageEl = $state(null);
  let stageW = $state(0);
  let stageRaf = 0;
  let stageSeq = 0;
  const frame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
  const unframe = (h) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(h) : clearTimeout(h));

  $effect(() => {
    if (!available || !stageEl) return;
    // Read here, tracked: the whole style (a snapshot reads all of it), the
    // text, the frame, the fonts and the stage's own width.
    const snap = { style: $state.snapshot(box.style), text: boxText(box, pg), w: box.w, h: box.h };
    app.fontsVersion;
    const width = stageW;
    untrack(() => {
      unframe(stageRaf);
      stageRaf = frame(async () => {
        const mine = ++stageSeq;
        // A roughened box's grain needs the browser's turbulence measured once.
        if (snap.style.roughen?.on) await settleNoise([snap]);
        if (mine !== stageSeq || !stageEl) return;
        const dpr = previewDpr();
        const cssW = width > 0 ? width : 296;
        stageEl.width = Math.max(1, Math.round(cssW * dpr));
        stageEl.height = Math.max(1, Math.round(STAGE_H * dpr));
        paintStage(stageEl, snap, dpr);
      });
    });
  });

  // ---- the cards ----
  const dpr = previewDpr();
  let landed = $state(0);
  let group = $state('All');
  const shown = $derived(group === 'All' ? presets : presets.filter((p) => p.group === group));
  // Plain data, so that what the cards depend on is one string.
  const spec = $derived(cardSpec(box.style, boxText(box, pg)));
  const base = $derived(JSON.stringify(spec) + '|' + app.fontsVersion);
  const keyOf = (p) => cardKey(spec, p.id, app.fontsVersion, dpr);
  function urlOf(p) {
    landed;
    const u = cachedCard(keyOf(p));
    return u ? `background-image:url(${u})` : '';
  }

  let cardRaf = 0;
  let cardSeq = 0;
  $effect(() => {
    if (!available) return;
    base;
    const list = shown;
    untrack(() => {
      unframe(cardRaf);
      const mine = ++cardSeq;
      const now = spec;
      const fonts = app.fontsVersion;
      const todo = list.filter((p) => cachedCard(cardKey(now, p.id, fonts, dpr)) === undefined);
      if (!todo.length) return;
      const step = () => {
        if (mine !== cardSeq) return;
        for (let n = 0; n < BATCH && todo.length; n++) {
          const p = todo.shift();
          // A card that could not be painted is kept as empty, not retried on
          // every change: the next change of font or text is a new key.
          keepCard(cardKey(now, p.id, fonts, dpr), paintCard(now, p, dpr) ?? '');
        }
        landed++;
        if (todo.length) cardRaf = frame(step);
      };
      cardRaf = frame(step);
    });
  });

  onDestroy(() => {
    cardSeq++;
    stageSeq++;
    unframe(cardRaf);
    unframe(stageRaf);
  });
</script>

{#if !available}
  <div class="grp">
    <div class="insp-none">SFX lettering needs the Rust text engine.</div>
    {#if onSettings}
      <button type="button" class="rbtn sfx-settings" onclick={onSettings}>Open settings</button>
    {/if}
  </div>
{:else}
  <div class="grp sfx-preview">
    <div class="sfx-head">
      <span class="lbl">Preview · {label}</span>
      {#if on}
        <button type="button" class="sfx-remove" onclick={remove}>Remove SFX</button>
      {/if}
    </div>
    <div class="sfx-stage" role="img" aria-label="Preview of the box's text with its SFX" bind:clientWidth={stageW}>
      <canvas bind:this={stageEl}></canvas>
    </div>
  </div>

  <div class="seg" role="group" aria-label="Preset group">
    {#each GROUPS as g (g)}
      <button type="button" class:on={group === g} aria-pressed={group === g} onclick={() => (group = g)}>{g}</button>
    {/each}
  </div>

  {#if shown.length}
    <div class="sfx-grid" role="radiogroup" aria-label="SFX preset">
      {#each shown as p (p.id)}
        <button
          type="button"
          role="radio"
          aria-checked={isPreset(p)}
          class="sfx-card"
          class:on={isPreset(p)}
          title={p.name}
          onclick={() => pick(p)}
        >
          <span class="sfx-tile" style={urlOf(p)}></span>
          <span class="sfx-name">{p.name}</span>
        </button>
      {/each}
    </div>
  {:else}
    <div class="insp-none">No presets in this group.</div>
  {/if}

  {#if on && !hasMoves}
    <div class="insp-none">This shape is the box's mesh. Bend it further in Transform.</div>
  {/if}
{/if}

<style>
  /* The preview stays under the Inspector's tab strip (54px of it shows while
     the panel is scrolled) so a card can be picked while watching it. Opaque
     ground, as the strip has, so cards do not show through. */
  .sfx-preview {
    position: sticky;
    top: 54px;
    z-index: 1;
    margin: 0 -12px;
    padding: 4px 12px 8px;
    background: var(--panel);
  }
  .sfx-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 22px;
    min-width: 0;
  }
  .sfx-head .lbl {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sfx-remove {
    flex: 0 0 auto;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--line2);
    border-radius: 5px;
    background: var(--surface);
    color: var(--t2);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .sfx-remove:hover {
    color: var(--warn);
    border-color: var(--warn);
  }
  .sfx-remove:focus-visible,
  .sfx-card:focus-visible,
  .sfx-settings:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .sfx-settings {
    align-self: flex-start;
    height: 28px;
    padding: 0 12px;
  }

  /* The stage is always paper, in both themes: the lettering is drawn to be
     read on a page. */
  .sfx-stage {
    height: 110px;
    background: var(--paper);
    border: 1px solid var(--line2);
    border-radius: 7px;
    overflow: hidden;
  }
  .sfx-stage canvas {
    display: block;
    width: 100%;
    height: 100%;
  }

  /* The preset cards are the pattern cards (Inspector.svelte `.pat-card`),
     mirrored because a component's styles are its own. */
  .sfx-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }
  .sfx-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 4px 5px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--surface);
    color: var(--t2);
    font-family: inherit;
    cursor: pointer;
    min-width: 0;
  }
  .sfx-card:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .sfx-card.on {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
    color: var(--text);
  }
  .sfx-tile {
    height: 44px;
    border-radius: 4px;
    background-color: var(--paper);
    background-repeat: no-repeat;
    background-position: center;
    background-size: contain;
    border: 1px solid var(--line);
  }
  .sfx-name {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
