<script>
import {
  app,
  applyBulk,
  bulkScopePages,
  closeBulk,
  GROUPS,
  page,
  setBulkProp,
  setBulkScope,
  setBulkTag,
  syncBulkTagTargets,
  tickBulkProp,
  bulkTicked,
  lockBulkTargets,
} from './store.svelte.js';
  import { tagsInUse, boxesWithTag } from './tags.svelte.js';
  import { modKey } from './format.js';
  import { fontGroups, fontCaveat } from './font-menu.js';
  import { PATTERN_KINDS, GRADIENT_MAX_STOPS } from './data.js';
  import ColorPicker from './ColorPicker.svelte';

  // app.bulk.style is the editable template; null when closed.
  const s = $derived(app.bulk.style);
  const count = $derived(app.bulk.targets.length);
  // Count of properties enabled in the mask.
  const ticked = $derived(app.bulk.active ? bulkTicked().length : 0);

  // Draggable panel position relative to .ed-canvas.
  let pos = $state({ x: 0, y: 16 });
  // Reactive, because the re-centring effect below reads it. `bind:this` writing
  // a plain `let` wakes nothing, so that effect would depend on `app.bulk.active`
  // alone: an ordering in which it runs before the element lands is one where it
  // never runs again, and the panel opens wherever it was last dragged. Declared
  // rather than relied upon - it is also the `non_reactive_update` warning the
  // compiler raises on this file.
  let panelEl = $state(null);

  // Panel size clamped to content and viewport bounds.
  const MIN_W = 280;
  const MAX_W = 560;
  const MIN_H = 220;
  let size = $state({ w: 320, h: null });

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  // Max dimensions relative to canvas bounds.
  const panelStyle = $derived(
    `left:${pos.x}px; top:${pos.y}px; width:${size.w}px;` +
      (size.h ? `height:${size.h}px;` : '') +
      `max-width:calc(100% - ${pos.x}px - 16px);` +
      `max-height:calc(100% - ${pos.y}px - 16px)`,
  );

  // Parent content box for drag/resize clamping.
  function parentBox() {
    const parent = panelEl?.offsetParent || panelEl?.parentElement;
    return {
      w: parent ? parent.clientWidth : window.innerWidth,
      h: parent ? parent.clientHeight : window.innerHeight,
    };
  }

  // Re-center near top of editor on open - once per closed→open transition,
  // guarded by where the last run left `wasActive`. Unguarded, the effect's
  // reads of `size.w` (and `panelEl`'s parent) made it re-fire on every grip
  // resize, snapping the panel back to centre in the middle of the gesture.
  // The guard keeps those re-runs; it just makes them no-ops. `wasActive` is a
  // plain `let`, so reading it tracks nothing - exactly what we want: the only
  // dependencies are active/panelEl/size.w.
  let wasActive = false;
  $effect(() => {
    const opening = app.bulk.active && !wasActive;
    wasActive = app.bulk.active;
    if (opening && panelEl) {
      const { w: pw } = parentBox();
      pos = { x: Math.max(16, (pw - size.w) / 2), y: 16 };
    }
  });

  // Track active gesture AbortControllers.
  const live = new Set();
  $effect(() => () => {
    for (const ac of live) ac.abort();
    live.clear();
  });

  function onHeadPointerDown(e) {
    // Do not drag from close button.
    if (e.target.closest('.x')) return;
    // Primary pointer button only.
    if (e.button !== 0) return;
    e.preventDefault();
    // Pointer capture tracks drag outside window.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseX = pos.x;
    const baseY = pos.y;
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const { w: pw, h: ph } = parentBox();
      const w = panelEl?.offsetWidth || 0;
      let nx = baseX + (ev.clientX - startX);
      let ny = baseY + (ev.clientY - startY);
      // Keep at least 40px on screen.
      nx = clamp(nx, 40 - w, pw - 40);
      ny = clamp(ny, 0, Math.max(0, ph - 40));
      pos = { x: nx, y: ny };
    };

    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
    };
    live.add(ac);
    window.addEventListener('pointermove', move, { signal: ac.signal });
    window.addEventListener('pointerup', end, { signal: ac.signal });
    window.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // Corner resize grip handler.
  function onGripPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const pid = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseW = size.w;
    const baseH = size.h ?? panelEl?.offsetHeight ?? MIN_H;
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const { w: pw, h: ph } = parentBox();
      size = {
        w: clamp(baseW + (ev.clientX - startX), MIN_W, Math.min(MAX_W, Math.max(MIN_W, pw - pos.x - 16))),
        h: clamp(baseH + (ev.clientY - startY), MIN_H, Math.max(MIN_H, ph - pos.y - 16)),
      };
    };
    const ac = new AbortController();
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      live.delete(ac);
      ac.abort();
    };
    live.add(ac);
    window.addEventListener('pointermove', move, { signal: ac.signal });
    window.addEventListener('pointerup', end, { signal: ac.signal });
    window.addEventListener('pointercancel', end, { signal: ac.signal });
  }

  // Read/write masked properties by path.
  const get = (key) => {
    const dot = key.indexOf('.');
    return dot === -1 ? s[key] : s[key.slice(0, dot)][key.slice(dot + 1)];
  };
  // Modifying a property enables it in the mask.
  function set(key, v) {
    const dot = key.indexOf('.');
    if (dot === -1) s[key] = v;
    else s[key.slice(0, dot)][key.slice(dot + 1)] = v;
    tickBulkProp(key);
  }
  // Validate CSS hex color strings.
  const HEX = /^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  // Restore previous value on invalid hex input.
  function setHex(key, v, el) {
    if (HEX.test(v)) set(key, v.startsWith('#') ? v : '#' + v);
    else if (el) el.value = get(key);
  }
  // Numeric text fields commit through `num` on `change`, never `input`: a
  // number input's value mid-typing is text - "" before the first digit, "-"
  // between the sign and the digits - and coercing that per keystroke both made
  // "-" impossible to enter and snapped partial values while they were being
  // typed. Sliders keep `oninput`; they never produce partial text.
  const num = (key, v, lo, hi) => set(key, clamp(+v || 0, lo, hi));

  // Stroke helpers
  function addStroke() {
    if (!Array.isArray(s.strokes)) s.strokes = [];
    s.strokes.push({ color: '#ffffff', width: 3, opacity: 1 });
    tickBulkProp('strokes');
  }
  function removeStroke(i) {
    if (!Array.isArray(s.strokes)) return;
    s.strokes.splice(i, 1);
    tickBulkProp('strokes');
  }
  function setStrokeHex(i, v, el) {
    if (!s.strokes?.[i]) return;
    if (HEX.test(v)) {
      s.strokes[i].color = v.startsWith('#') ? v : '#' + v;
      tickBulkProp('strokes');
    } else if (el) {
      el.value = s.strokes[i].color;
    }
  }

  // Shadow helpers
  function addShadow() {
    if (!Array.isArray(s.shadows)) s.shadows = [];
    s.shadows.push({ x: 2, y: 2, blur: 2, color: '#000000', opacity: 0.6 });
    tickBulkProp('shadows');
  }
  function removeShadow(i) {
    if (!Array.isArray(s.shadows)) return;
    s.shadows.splice(i, 1);
    tickBulkProp('shadows');
  }
  function setShadowHex(i, v, el) {
    if (!s.shadows?.[i]) return;
    if (HEX.test(v)) {
      s.shadows[i].color = v.startsWith('#') ? v : '#' + v;
      tickBulkProp('shadows');
    } else if (el) {
      el.value = s.shadows[i].color;
    }
  }

  // Gradient helpers
  function addGradientStop() {
    if (!s.gradient) return;
    if (!Array.isArray(s.gradient.stops)) s.gradient.stops = [];
    const stops = s.gradient.stops;
    if (stops.length >= GRADIENT_MAX_STOPS) return;
    const lastPos = stops.length ? stops[stops.length - 1].pos : 0.5;
    const newPos = Math.min(1, Math.max(0, lastPos < 1 ? Number(((lastPos + 1) / 2).toFixed(2)) : 0.5));
    stops.push({ color: '#ffffff', pos: newPos, opacity: 1 });
    stops.sort((a, b) => a.pos - b.pos);
    tickBulkProp('gradient');
  }
  function removeGradientStop(i) {
    if (!s.gradient?.stops || s.gradient.stops.length <= 2) return;
    s.gradient.stops.splice(i, 1);
    tickBulkProp('gradient');
  }
  function setStopHex(i, v, el) {
    if (!s.gradient?.stops?.[i]) return;
    if (HEX.test(v)) {
      s.gradient.stops[i].color = v.startsWith('#') ? v : '#' + v;
      tickBulkProp('gradient');
    } else if (el) {
      el.value = s.gradient.stops[i].color;
    }
  }
  // Stop order follows `pos`, but only once the number is committed: sorting
  // per keystroke re-ordered the rows under the cursor while the value was
  // still being typed. The write happens on input; the sort on change.
  function sortStops() {
    s.gradient.stops?.sort((a, b) => a.pos - b.pos);
    tickBulkProp('gradient');
  }

  // Radial gradients: same kind toggle and centre/radius controls as the
  // Inspector's, because a bulk edit that cannot say "radial" would silently
  // copy the seed's shape over every target's own. The five centres are the
  // Inspector's; radius multiplies the distance to the farthest corner.
  const GRAD_CENTRES = [
    { cx: 0.5, cy: 0, n: 'Top' },
    { cx: 0, cy: 0.5, n: 'Left' },
    { cx: 0.5, cy: 0.5, n: 'Centre' },
    { cx: 1, cy: 0.5, n: 'Right' },
    { cx: 0.5, cy: 1, n: 'Bottom' },
  ];
  const nearCentre = (cx, cy, c) => Math.abs((cx ?? 0.5) - c.cx) < 0.02 && Math.abs((cy ?? 0.5) - c.cy) < 0.02;
  function setGradKind(k) {
    s.gradient.kind = k;
    tickBulkProp('gradient');
  }
  function setGradientCentre(c) {
    s.gradient.cx = c.cx;
    s.gradient.cy = c.cy;
    tickBulkProp('gradient');
  }

  // Pattern helpers
  function setPatternHex(field, v, el) {
    if (!s.pattern) return;
    if (HEX.test(v)) {
      s.pattern[field] = v.startsWith('#') ? v : '#' + v;
      tickBulkProp('pattern');
    } else if (el) {
      el.value = s.pattern[field];
    }
  }

  // The group headers read the mask vocabulary's own grouping: GROUPS lives in
  // store.svelte.js beside BULK_PROPS, so a key the panel headers tick but the
  // mask does not know is a failed test rather than a silent no-op.
  let open = $state({ font: true, fill: true, shadow: false, warp: false, typeset: false, transform: true });
  const nOn = (g) => GROUPS[g].filter((k) => app.bulk.mask[k]).length;
  const setGroup = (g, on) => GROUPS[g].forEach((k) => setBulkProp(k, on));

  // Tag and scope live on `app.bulk`, not here: picking a tag has to fill the
  // real selection so the canvas highlights it and the one Apply in the footer
  // lights up. A copy in the panel is how the two used to disagree.
  const scope = $derived(app.bulk.scope);
  const tag = $derived(app.bulk.tag);
  const scopePages = $derived(app.bulk.active ? bulkScopePages() : []);
  const scopeWord = $derived(scope === 'page' ? 'this page' : 'the chapter');
  const tagList = $derived(app.bulk.active ? tagsInUse(scopePages) : []);
  const tagHits = $derived(tag ? boxesWithTag(tag, scopePages).length : 0);
  // Number of matching boxes off current page.
  const tagHitsHere = $derived(tag ? boxesWithTag(tag, [page()]).length : 0);
  const tagHitsAway = $derived(Math.max(0, tagHits - tagHitsHere));
  const tagPages = $derived(
    tag ? new Set(boxesWithTag(tag, scopePages).map((h) => h.page.id)).size : 0,
  );
  // Legacy free-typed boxes lacking queue lines.
  const freeCount = $derived(
    scopePages.reduce((n, p) => n + (p?.boxes ?? []).filter((b) => b.lineN == null).length, 0),
  );

  // Drop a tag that the current scope no longer offers - narrowing to a page
  // that carries none of it would otherwise leave a live selection of zero
  // boxes with a tag name still showing.
  $effect(() => {
    if (app.bulk.active && tag && !tagList.includes(tag)) setBulkTag('');
  });
  // A page-scoped tag selection follows the page. `page()` moves under the panel
  // in a longstrip chapter as the user scrolls, and the highlighted boxes have
  // to be the ones the Apply will land on.
  $effect(() => {
    const here = page()?.id;
    if (app.bulk.active && app.bulk.tag && app.bulk.scope === 'page' && here) syncBulkTagTargets();
  });

  const alignIcons = {
    left: ['M3 6h18', 'M3 12h12', 'M3 18h15'],
    center: ['M3 6h18', 'M6 12h12', 'M5 18h14'],
    right: ['M3 6h18', 'M9 12h12', 'M6 18h15'],
  };
  const valignIcons = {
    top: ['M4 6h16', 'M9 10h6v8h-6z'],
    middle: ['M4 12h16', 'M9 8h6v8h-6z'],
    bottom: ['M4 18h16', 'M9 6h6v8h-6z'],
  };
</script>

{#snippet tick(key)}
  <input
    class="btick"
    type="checkbox"
    checked={!!app.bulk.mask[key]}
    onchange={(e) => setBulkProp(key, e.target.checked)}
    title="Include this property in the bulk edit"
  />
{/snippet}

{#snippet head(g, label)}
  <div
    class="insp-sub-head"
    role="button"
    tabindex="0"
    onclick={() => (open[g] = !open[g])}
    onkeydown={(e) => e.key === 'Enter' && (open[g] = !open[g])}
  >
    <input
      class="btick"
      type="checkbox"
      checked={nOn(g) === GROUPS[g].length}
      indeterminate={nOn(g) > 0 && nOn(g) < GROUPS[g].length}
      onclick={(e) => e.stopPropagation()}
      onchange={(e) => setGroup(g, e.target.checked)}
      title="Include every property in this group"
    />
    {label}
    <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
  </div>
{/snippet}

{#if app.bulk.active && s}
  <div class="bulk-panel" bind:this={panelEl} style={panelStyle}>
    <div class="bulk-head" onpointerdown={onHeadPointerDown}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5h16v2" /><path d="M12 5v14" /><path d="M9 19h6" /></svg>
      <b>Bulk style</b>
      <button class="x" title="Cancel" onclick={closeBulk}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>

    <div class="bulk-scroll">
      <div class="bulk-tag">
        <div class="trow">
          <span class="lbl">Scope</span>
          <div class="seg">
            <button class:on={scope === 'chapter'} onclick={() => setBulkScope('chapter')}>Chapter</button>
            <button class:on={scope === 'page'} onclick={() => setBulkScope('page')}>This page</button>
          </div>
        </div>

        <div class="trow">
          <span class="lbl">By tag</span>
          <select
            value={tag}
            onchange={(e) => setBulkTag(e.target.value)}
            disabled={!tagList.length}
          >
            <option value="">{tagList.length ? 'Choose a tag…' : 'No tags in use'}</option>
            {#each tagList as t (t)}<option value={t}>{t}</option>{/each}
          </select>
        </div>
        <div class="bulk-note">
          {#if !tagList.length}
            No line in {scopeWord} carries a tag yet - tag them in the Text Queue first.
          {:else if !tag}
            Choose a tag to select every box carrying it in {scopeWord}, or click boxes on the page.
          {:else}
            Selected {tagHits} box{tagHits === 1 ? '' : 'es'} tagged “{tag}” in {scopeWord} - press Apply below.
            {#if !ticked}
              <br />Tick a property below first - nothing is set to change.
            {/if}
            {#if tagHitsAway}
              <br />{tagHitsAway} of them {tagHitsAway === 1 ? 'is' : 'are'} on other pages. Undo is per page:
              {tagPages} pages, one {modKey()}Z each, on the page itself.
            {/if}
          {/if}
          {#if freeCount}
            <br />{freeCount} older box{freeCount === 1 ? '' : 'es'} in {scopeWord} {freeCount === 1 ? 'has' : 'have'} no queue line, so {freeCount === 1 ? 'it carries' : 'they carry'} no tag and {freeCount === 1 ? 'is' : 'are'} never included. Retype {freeCount === 1 ? 'it' : 'them'} to make {freeCount === 1 ? 'it' : 'them'} taggable.
          {/if}
        </div>
      </div>

      <div class="bulk-hint">Tick the properties to change, then press Apply. Clicking boxes on the page picks them by hand instead of by tag.</div>

      <div class="bulk-body">
        <div class="insp-sub" class:closed={!open.font}>
          {@render head('font', 'Font & Layout')}
          <div class="insp-sub-body">
            <div class="brow" class:off={!app.bulk.mask.font}>
              {@render tick('font')}
              <span class="lbl">Font</span>
              <select value={s.font} onchange={(e) => set('font', e.target.value)}>
                {#if fontCaveat(s.font)}
                  <option value={s.font}>{s.font} ({fontCaveat(s.font)})</option>
                {/if}
                {#each fontGroups() as g (g.key)}
                  <optgroup label={g.label}>
                    {#each g.fonts as f (f.name)}<option>{f.name}</option>{/each}
                  </optgroup>
                {/each}
              </select>
            </div>
            <div class="brow" class:off={!app.bulk.mask.size}>
              {@render tick('size')}
              <span class="lbl">Size</span>
              <input type="number" min="6" max="200" value={s.size} onchange={(e) => num('size', e.target.value || 6, 6, 200)} />
            </div>
            {#each [['bold', 'Bold', 'B'], ['italic', 'Italic', 'I'], ['uppercase', 'Caps', 'AA']] as [key, label, glyph] (key)}
              <div class="brow" class:off={!app.bulk.mask[key]}>
                {@render tick(key)}
                <span class="lbl">{label}</span>
                <div class="seg">
                  <button class:on={get(key)} onclick={() => set(key, !get(key))}>{glyph}</button>
                </div>
              </div>
            {/each}
            <div class="brow" class:off={!app.bulk.mask.align}>
              {@render tick('align')}
              <span class="lbl">Align</span>
              <div class="seg">
                {#each ['left', 'center', 'right'] as al (al)}
                  <button class:on={s.align === al} title={al} onclick={() => set('align', al)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">{#each alignIcons[al] as d}<path {d} />{/each}</svg>
                  </button>
                {/each}
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask.valign}>
              {@render tick('valign')}
              <span class="lbl">Vertical</span>
              <div class="seg">
                {#each ['top', 'middle', 'bottom'] as va (va)}
                  <button class:on={s.valign === va} title={va} onclick={() => set('valign', va)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">{#each valignIcons[va] as d}<path {d} />{/each}</svg>
                  </button>
                {/each}
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask.lineHeight}>
              {@render tick('lineHeight')}
              <span class="lbl">Line</span>
              <input type="number" min="0.6" max="3" step="0.05" value={s.lineHeight} onchange={(e) => num('lineHeight', e.target.value || 1, 0.6, 3)} />
            </div>
            <div class="brow" class:off={!app.bulk.mask.letterSpacing}>
              {@render tick('letterSpacing')}
              <span class="lbl">Letter</span>
              <input type="number" min="-5" max="40" step="0.5" value={s.letterSpacing} onchange={(e) => num('letterSpacing', e.target.value, -5, 40)} />
            </div>
          </div>
        </div>

        <div class="insp-sub" class:closed={!open.fill}>
          {@render head('fill', 'Fill & Stroke')}
          <div class="insp-sub-body">
            <div class="brow" class:off={!app.bulk.mask.color}>
              {@render tick('color')}
              <span class="lbl">Color</span>
              <div class="color-field">
                <ColorPicker value={s.color} label="Text colour" size={30} unclipped onchange={(hex) => set('color', hex)} />
                <input type="text" class="hex" value={s.color} onchange={(e) => setHex('color', e.currentTarget.value, e.currentTarget)} />
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask.opacity}>
              {@render tick('opacity')}
              <span class="lbl">Opacity</span>
              <div class="slider-row">
                <input type="range" min="0" max="1" step="0.01" value={s.opacity} oninput={(e) => set('opacity', +e.target.value)} />
                <span class="val">{Math.round(s.opacity * 100)}%</span>
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask.blur}>
              {@render tick('blur')}
              <span class="lbl">Blur</span>
              <div class="slider-row">
                <input type="range" min="0" max="20" step="0.5" value={s.blur} oninput={(e) => num('blur', e.target.value, 0, 20)} />
                <span class="val">{s.blur}px</span>
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask.motionBlur}>
              {@render tick('motionBlur')}
              <span class="lbl">Motion blur</span>
              <div class="sub-list-block">
                <div class="sub-list-head">
                  <div class="switch" class:on={s.motionBlur.on} role="switch" aria-checked={s.motionBlur.on} tabindex="0" onclick={() => { s.motionBlur.on = !s.motionBlur.on; tickBulkProp('motionBlur'); }} onkeydown={(e) => e.key === 'Enter' && ((s.motionBlur.on = !s.motionBlur.on), tickBulkProp('motionBlur'))}><span class="knob"></span></div>
                  <span class="sub-count">{s.motionBlur.on ? 'On' : 'Off'}</span>
                </div>
                <div class="sub-row3">
                  <div class="field">
                    <span class="sub-lbl">X</span>
                    <input type="number" min="-10" max="10" step="0.1" value={s.motionBlur.x} onchange={(e) => { s.motionBlur.x = clamp(+e.target.value || 0, -10, 10); tickBulkProp('motionBlur'); }} />
                  </div>
                  <div class="field">
                    <span class="sub-lbl">Y</span>
                    <input type="number" min="-10" max="10" step="0.1" value={s.motionBlur.y} onchange={(e) => { s.motionBlur.y = clamp(+e.target.value || 0, -10, 10); tickBulkProp('motionBlur'); }} />
                  </div>
                  <div class="field">
                    <span class="sub-lbl">Amount</span>
                    <input type="number" min="1" max="32" step="1" value={s.motionBlur.amount} onchange={(e) => { s.motionBlur.amount = Math.round(clamp(+e.target.value || 1, 1, 32)); tickBulkProp('motionBlur'); }} />
                  </div>
                </div>
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask.strokes}>
              {@render tick('strokes')}
              <span class="lbl">Strokes</span>
              <div class="sub-list-block">
                <div class="sub-list-head">
                  <span class="sub-count">{s.strokes?.length ?? 0} stroke{s.strokes?.length === 1 ? '' : 's'}</span>
                  <button class="btn btn-sm" onclick={addStroke}>+ Add</button>
                </div>
                {#if s.strokes?.length}
                  <div class="sub-list">
                    {#each s.strokes as st, i (i)}
                      <div class="sub-row">
                        <div class="color-field">
                          <ColorPicker value={st.color} label="Stroke colour" size={30} unclipped onchange={(hex) => { st.color = hex; tickBulkProp('strokes'); }} />
                          <input type="text" class="hex" value={st.color} onchange={(e) => setStrokeHex(i, e.currentTarget.value, e.currentTarget)} />
                        </div>
                        <!-- Width floors at 0.5, not 0: the schema drops a
                             zero-width stroke on normalise, so a 0 typed here
                             would silently vanish from the template at apply. -->
                        <input type="number" min="0.5" max="50" step="0.5" value={st.width} title="Width (px)" placeholder="W" onchange={(e) => { st.width = clamp(+e.target.value || 3, 0.5, 50); tickBulkProp('strokes'); }} />
                        <div class="slider-row" style="flex:1 1 70px; min-width:0">
                          <input type="range" min="0" max="1" step="0.01" value={st.opacity} title="Opacity" oninput={(e) => { st.opacity = clamp(+e.target.value || 0, 0, 1); tickBulkProp('strokes'); }} />
                        </div>
                        <button class="sub-del" title="Remove stroke" onclick={() => removeStroke(i)}>×</button>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask.gradient}>
              {@render tick('gradient')}
              <span class="lbl">Gradient</span>
              <div class="sub-list-block">
                <div class="sub-list-head">
                  <div class="switch" class:on={s.gradient.on} role="switch" aria-checked={s.gradient.on} tabindex="0" onclick={() => { s.gradient.on = !s.gradient.on; tickBulkProp('gradient'); }} onkeydown={(e) => e.key === 'Enter' && ((s.gradient.on = !s.gradient.on), tickBulkProp('gradient'))}><span class="knob"></span></div>
                  <span class="sub-count">{s.gradient.on ? 'On' : 'Off'}</span>
                  <button class="btn btn-sm" disabled={(s.gradient.stops?.length ?? 0) >= GRADIENT_MAX_STOPS} onclick={addGradientStop}>+ Stop</button>
                </div>
                <div class="sub-row2">
                  <div class="field">
                    <span class="sub-lbl">Shape</span>
                    <div class="seg">
                      <button type="button" class:on={s.gradient.kind !== 'radial'} title="Linear gradient" onclick={() => setGradKind('linear')}>Linear</button>
                      <button type="button" class:on={s.gradient.kind === 'radial'} title="Radial gradient" onclick={() => setGradKind('radial')}>Radial</button>
                    </div>
                  </div>
                  <div class="field">
                    <span class="sub-lbl">Scope</span>
                    <div class="seg">
                      <button class:on={s.gradient.scope === 'box'} onclick={() => { s.gradient.scope = 'box'; tickBulkProp('gradient'); }}>Box</button>
                      <button class:on={s.gradient.scope === 'line'} onclick={() => { s.gradient.scope = 'line'; tickBulkProp('gradient'); }}>Line</button>
                    </div>
                  </div>
                </div>
                {#if s.gradient.kind === 'radial'}
                  <!-- A radial ignores `angle` and reads centre + radius instead,
                       exactly as the Inspector's radial controls do. -->
                  {@const rad = Number.isFinite(+s.gradient.radius) ? +s.gradient.radius : 1}
                  <div class="sub-row2">
                    <div class="field">
                      <span class="sub-lbl">Centre</span>
                      <select value={`${s.gradient.cx},${s.gradient.cy}`} onchange={(e) => { const [cx, cy] = e.target.value.split(',').map(Number); setGradientCentre({ cx, cy }); }}>
                        {#each GRAD_CENTRES as c (c.n)}<option value={`${c.cx},${c.cy}`}>{c.n}</option>{/each}
                      </select>
                    </div>
                    <div class="field">
                      <span class="sub-lbl">Radius · {Math.round(rad * 100)}%</span>
                      <input type="number" min="0.1" max="4" step="0.05" value={rad} title="How far the last stop is from the centre, as a multiple of the distance to the far corner" onchange={(e) => { s.gradient.radius = clamp(+e.target.value || 1, 0.1, 4); tickBulkProp('gradient'); }} />
                    </div>
                  </div>
                {:else}
                  <div class="sub-row2">
                    <div class="field">
                      <span class="sub-lbl">Angle</span>
                      <input type="number" min="0" max="360" step="1" value={s.gradient.angle} onchange={(e) => { s.gradient.angle = ((+e.target.value || 0) % 360 + 360) % 360; tickBulkProp('gradient'); }} />
                    </div>
                  </div>
                {/if}
                {#if s.gradient.stops?.length}
                  <div class="sub-list">
                    <!-- Keyed by the stop itself, not its index: a re-sort moves
                         each row's DOM with it instead of swapping contents under
                         a cursor that is still typing into one. -->
                    {#each s.gradient.stops as st (st)}
                      <div class="sub-row">
                        <div class="color-field">
                          <ColorPicker value={st.color} label="Stop colour" size={30} unclipped onchange={(hex) => { st.color = hex; tickBulkProp('gradient'); }} />
                          <input type="text" class="hex" value={st.color} onchange={(e) => setStopHex(s.gradient.stops.indexOf(st), e.currentTarget.value, e.currentTarget)} />
                        </div>
                        <input type="number" min="0" max="1" step="0.05" value={st.pos} title="Position 0..1" placeholder="Pos" oninput={(e) => { st.pos = clamp(+e.target.value || 0, 0, 1); tickBulkProp('gradient'); }} onchange={() => sortStops()} />
                        <button class="sub-del" title="Remove stop" disabled={s.gradient.stops.length <= 2} onclick={() => removeGradientStop(s.gradient.stops.indexOf(st))}>×</button>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask.pattern}>
              {@render tick('pattern')}
              <span class="lbl">Pattern</span>
              <div class="sub-list-block">
                <div class="sub-list-head">
                  <div class="switch" class:on={s.pattern.on} role="switch" aria-checked={s.pattern.on} tabindex="0" onclick={() => { s.pattern.on = !s.pattern.on; tickBulkProp('pattern'); }} onkeydown={(e) => e.key === 'Enter' && ((s.pattern.on = !s.pattern.on), tickBulkProp('pattern'))}><span class="knob"></span></div>
                  <span class="sub-count">{s.pattern.on ? 'On' : 'Off'}</span>
                  <select value={s.pattern.kind} onchange={(e) => { s.pattern.kind = e.target.value; tickBulkProp('pattern'); }} style="flex:1 1 auto; height:26px">
                    {#each PATTERN_KINDS as k}<option value={k}>{k}</option>{/each}
                  </select>
                </div>
                <div class="sub-row2">
                  <div class="field">
                    <span class="sub-lbl">FG</span>
                    <div class="color-field">
                      <ColorPicker value={s.pattern.fg} label="Pattern foreground colour" size={30} unclipped onchange={(hex) => { s.pattern.fg = hex; tickBulkProp('pattern'); }} />
                      <input type="text" class="hex" value={s.pattern.fg} onchange={(e) => setPatternHex('fg', e.currentTarget.value, e.currentTarget)} />
                    </div>
                  </div>
                  <div class="field">
                    <span class="sub-lbl">BG</span>
                    <div class="color-field">
                      <ColorPicker value={s.pattern.bg} label="Pattern background colour" size={30} unclipped onchange={(hex) => { s.pattern.bg = hex; tickBulkProp('pattern'); }} />
                      <input type="text" class="hex" value={s.pattern.bg} onchange={(e) => setPatternHex('bg', e.currentTarget.value, e.currentTarget)} />
                    </div>
                  </div>
                </div>
                <div class="sub-row">
                  <span class="sub-lbl" style="width:36px">Scale</span>
                  <input type="number" min="0.25" max="4" step="0.25" value={s.pattern.scale} onchange={(e) => { s.pattern.scale = clamp(+e.target.value || 1, 0.25, 4); tickBulkProp('pattern'); }} />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="insp-sub" class:closed={!open.shadow}>
          {@render head('shadow', 'Drop Shadow')}
          <div class="insp-sub-body">
            <div class="brow" class:off={!app.bulk.mask.shadows}>
              {@render tick('shadows')}
              <span class="lbl">Shadows</span>
              <div class="sub-list-block">
                <div class="sub-list-head">
                  <span class="sub-count">{s.shadows?.length ?? 0} shadow{s.shadows?.length === 1 ? '' : 's'}</span>
                  <button class="btn btn-sm" onclick={addShadow}>+ Add</button>
                </div>
                {#if s.shadows?.length}
                  <div class="sub-list">
                    {#each s.shadows as sh, i (i)}
                      <div class="sub-card">
                        <div class="sub-row">
                          <div class="color-field">
                            <ColorPicker value={sh.color} label="Shadow colour" size={30} unclipped onchange={(hex) => { sh.color = hex; tickBulkProp('shadows'); }} />
                            <input type="text" class="hex" value={sh.color} onchange={(e) => setShadowHex(i, e.currentTarget.value, e.currentTarget)} />
                          </div>
                          <button class="sub-del" title="Remove shadow" onclick={() => removeShadow(i)}>×</button>
                        </div>
                        <div class="sub-row3">
                          <div class="field">
                            <span class="sub-lbl">X</span>
                            <input type="number" value={sh.x} onchange={(e) => { sh.x = +e.target.value || 0; tickBulkProp('shadows'); }} />
                          </div>
                          <div class="field">
                            <span class="sub-lbl">Y</span>
                            <input type="number" value={sh.y} onchange={(e) => { sh.y = +e.target.value || 0; tickBulkProp('shadows'); }} />
                          </div>
                          <div class="field">
                            <span class="sub-lbl">Blur</span>
                            <input type="number" min="0" max="50" value={sh.blur} onchange={(e) => { sh.blur = Math.max(0, +e.target.value || 0); tickBulkProp('shadows'); }} />
                          </div>
                        </div>
                        <div class="slider-row">
                          <input type="range" min="0" max="1" step="0.01" value={sh.opacity} oninput={(e) => { sh.opacity = clamp(+e.target.value || 0, 0, 1); tickBulkProp('shadows'); }} />
                          <span class="val">{Math.round(sh.opacity * 100)}%</span>
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          </div>
        </div>

        <div class="insp-sub" class:closed={!open.warp}>
          {@render head('warp', 'Warp & Edges')}
          <div class="insp-sub-body">
            <div class="brow" class:off={!app.bulk.mask.curve}>
              {@render tick('curve')}
              <span class="lbl">Curve</span>
              <div class="slider-row">
                <input type="range" min="-100" max="100" step="1" value={s.curve} oninput={(e) => set('curve', +e.target.value)} />
                <span class="val">{s.curve}</span>
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask.circle}>
              {@render tick('circle')}
              <span class="lbl">Circle</span>
              <div class="sub-list-block">
                <div class="sub-list-head">
                  <div class="switch" class:on={s.circle.on} role="switch" aria-checked={s.circle.on} tabindex="0" onclick={() => { s.circle.on = !s.circle.on; tickBulkProp('circle'); }} onkeydown={(e) => e.key === 'Enter' && ((s.circle.on = !s.circle.on), tickBulkProp('circle'))}><span class="knob"></span></div>
                  <span class="sub-count">{s.circle.on ? 'On' : 'Off'}</span>
                </div>
                <div class="sub-row2">
                  <div class="field">
                    <span class="sub-lbl">Angle</span>
                    <input type="number" min="0" max="359" step="1" value={s.circle.angle} onchange={(e) => { s.circle.angle = ((+e.target.value || 0) % 360 + 360) % 360; tickBulkProp('circle'); }} />
                  </div>
                  <div class="field">
                    <span class="sub-lbl">Radius</span>
                    <input type="number" min="0" max="4000" step="1" value={s.circle.r} title="0 = auto (fit the ring to the text)" onchange={(e) => { s.circle.r = clamp(+e.target.value || 0, 0, 4000); tickBulkProp('circle'); }} />
                  </div>
                  <div class="field">
                    <span class="sub-lbl">Inside</span>
                    <div class="switch" class:on={s.circle.inside} role="switch" aria-checked={s.circle.inside} tabindex="0" onclick={() => { s.circle.inside = !s.circle.inside; tickBulkProp('circle'); }} onkeydown={(e) => e.key === 'Enter' && ((s.circle.inside = !s.circle.inside), tickBulkProp('circle'))}><span class="knob"></span></div>
                  </div>
                </div>
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask['roughen.on']}>
              {@render tick('roughen.on')}
              <span class="lbl">Roughen</span>
              <div class="switch" class:on={s.roughen.on} role="switch" aria-checked={s.roughen.on} tabindex="0" onclick={() => set('roughen.on', !s.roughen.on)} onkeydown={(e) => e.key === 'Enter' && set('roughen.on', !s.roughen.on)}><span class="knob"></span></div>
            </div>
            <div class="brow" class:off={!app.bulk.mask['roughen.amount']}>
              {@render tick('roughen.amount')}
              <span class="lbl">Amount</span>
              <div class="slider-row">
                <input type="range" min="0" max="20" step="0.5" value={s.roughen.amount} oninput={(e) => set('roughen.amount', +e.target.value)} />
                <span class="val">{s.roughen.amount}</span>
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask['roughen.detail']}>
              {@render tick('roughen.detail')}
              <span class="lbl">Grain</span>
              <div class="slider-row">
                <input type="range" min="0.01" max="0.2" step="0.005" value={s.roughen.detail} oninput={(e) => set('roughen.detail', +e.target.value)} />
                <span class="val">{s.roughen.detail.toFixed(3)}</span>
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask['roughen.seed']}>
              {@render tick('roughen.seed')}
              <span class="lbl">Seed</span>
              <input type="number" min="0" max="999" value={s.roughen.seed} onchange={(e) => set('roughen.seed', Math.round(clamp(+e.target.value || 0, 0, 999)))} />
            </div>
            <!-- Shapes and brushSize are box-local geometry, not surfaced in the bulk panel. -->
            <div class="brow" class:off={!app.bulk.mask.clip}>
              {@render tick('clip')}
              <span class="lbl">Mask</span>
              <div class="sub-row">
                <div class="switch" class:on={s.clip.on} role="switch" aria-checked={s.clip.on} tabindex="0" onclick={() => { s.clip.on = !s.clip.on; tickBulkProp('clip'); }} onkeydown={(e) => e.key === 'Enter' && ((s.clip.on = !s.clip.on), tickBulkProp('clip'))}><span class="knob"></span></div>
                <select value={s.clip.mode} onchange={(e) => { s.clip.mode = e.target.value; tickBulkProp('clip'); }} style="flex:1 1 auto; height:24px; min-width:0">
                  <option value="exclude">Exclude</option>
                  <option value="include">Include</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {#if app.typesetting.mode === 'smart'}
          <div class="insp-sub" class:closed={!open.typeset}>
            {@render head('typeset', 'Typeset')}
            <div class="insp-sub-body">
              <div class="brow" class:off={!app.bulk.mask.shape}>
                {@render tick('shape')}
                <span class="lbl">Line breaks</span>
                <!-- Plain wraps like the browser; the other three are the
                     shaped breaker and the silhouette it aims for (BRK-3). -->
                <div class="seg">
                  {#each [['off', 'Plain'], ['auto', 'Auto'], ['oval', 'Oval'], ['rect', 'Rect']] as [v, label] (v)}
                    <button class:on={(s.shape ?? 'auto') === v} onclick={() => set('shape', v)}>{label}</button>
                  {/each}
                </div>
              </div>
              <div class="brow" class:off={!app.bulk.mask.minOrphan}>
                {@render tick('minOrphan')}
                <span class="lbl">Min alone</span>
                <input type="number" min="1" max="8" value={s.minOrphan} onchange={(e) => set('minOrphan', Math.round(clamp(+e.target.value || 1, 1, 8)))} />
              </div>
              <div class="brow" class:off={!app.bulk.mask.hyphenate}>
                {@render tick('hyphenate')}
                <span class="lbl">Hyphenate</span>
                <div class="switch" class:on={s.hyphenate} role="switch" aria-checked={s.hyphenate} tabindex="0" onclick={() => set('hyphenate', !s.hyphenate)} onkeydown={(e) => e.key === 'Enter' && set('hyphenate', !s.hyphenate)}><span class="knob"></span></div>
              </div>

              <div class="brow" class:off={!app.bulk.mask.balloon}>
                {@render tick('balloon')}
                <span class="lbl">Balloon fit</span>
                <div class="switch" class:on={s.balloon} role="switch" aria-checked={s.balloon} tabindex="0" onclick={() => set('balloon', !s.balloon)} onkeydown={(e) => e.key === 'Enter' && set('balloon', !s.balloon)}><span class="knob"></span></div>
              </div>
            </div>
          </div>
        {/if}

        <div class="insp-sub" class:closed={!open.transform}>
          {@render head('transform', 'Transform')}
          <div class="insp-sub-body">
            <div class="brow" class:off={!app.bulk.mask.rotation}>
              {@render tick('rotation')}
              <span class="lbl">Rotation</span>
              <input type="number" min="-180" max="180" value={Math.round(s.rotation)} onchange={(e) => num('rotation', e.target.value, -180, 180)} />
            </div>
            <div class="brow" class:off={!app.bulk.mask.flipH}>
              {@render tick('flipH')}
              <span class="lbl">Flip H</span>
              <div class="seg">
                <button class:on={s.flipH} title="Mirror left↔right" onclick={() => set('flipH', !s.flipH)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v18" stroke-dasharray="2 2" /><path d="M9 8l-5 4 5 4z" /><path d="M15 8l5 4-5 4z" /></svg>
                </button>
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask.flipV}>
              {@render tick('flipV')}
              <span class="lbl">Flip V</span>
              <div class="seg">
                <button class:on={s.flipV} title="Mirror top↔bottom" onclick={() => set('flipV', !s.flipV)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12h18" stroke-dasharray="2 2" /><path d="M8 9l4-5 4 5z" /><path d="M8 15l4 5 4-5z" /></svg>
                </button>
              </div>
            </div>
            <div class="brow" class:off={!app.bulk.mask.autoHeight}>
              {@render tick('autoHeight')}
              <span class="lbl">Auto height</span>
              <div class="switch" class:on={s.autoHeight} role="switch" aria-checked={s.autoHeight} tabindex="0" onclick={() => set('autoHeight', !s.autoHeight)} onkeydown={(e) => e.key === 'Enter' && set('autoHeight', !s.autoHeight)}><span class="knob"></span></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Locks act on the picked boxes at once, not through Apply: a lock is not
         a style, so the ticks have nothing to say about it (`lockBulkTargets`). -->
    <div class="bulk-locks">
      <span class="lbl">Locks</span>
      <button class="btn btn-sm" disabled={count === 0} title="Let every lock go on the selected boxes. Nothing moves until Refit lays them out again." onclick={() => lockBulkTargets(false)}>Unlock selected</button>
      <button class="btn btn-sm" disabled={count === 0} title="Hold each selected box's size, width, place and line breaks as they stand, through edits and Refit" onclick={() => lockBulkTargets(true)}>Lock layout of selected</button>
    </div>
    <div class="bulk-foot">
      <span class="cnt">{ticked} ticked · {count} selected{tag ? ` · “${tag}”` : ''}</span>
      <button class="btn" onclick={closeBulk}>Cancel</button>
      <button class="btn btn-accent" disabled={count === 0 || ticked === 0} onclick={applyBulk}>Apply</button>
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="bulk-grip" onpointerdown={onGripPointerDown}></div>
  </div>
{/if}

<style>
  .sub-list-block { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .sub-list-head { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
  .sub-count { font-size: 11.5px; color: var(--t2); }
  .btn-sm { height: 24px; padding: 0 8px; font-size: 11px; }
  .bulk-locks { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; flex: 0 0 auto; padding: 8px 12px; border-top: 1px solid var(--line); }
  .bulk-locks .lbl { font-size: 11px; color: var(--t2); text-transform: uppercase; letter-spacing: 0.4px; margin-right: auto; }
  .sub-list { display: flex; flex-direction: column; gap: 6px; }
  .sub-card { display: flex; flex-direction: column; gap: 6px; padding: 6px; background: var(--panel2); border-radius: 6px; border: 1px solid var(--line); }
  .sub-row { display: flex; align-items: center; gap: 6px; }
  .sub-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .sub-row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
  .sub-lbl { font-size: 10px; color: var(--t3); text-transform: uppercase; }
  .sub-del { width: 22px; height: 22px; border: 1px solid var(--line2); background: transparent; color: var(--t2); border-radius: 4px; cursor: pointer; display: grid; place-items: center; font-size: 14px; line-height: 1; flex: 0 0 auto; }
  .sub-del:hover:not(:disabled) { border-color: var(--warn); color: var(--warn); }
  .sub-del:disabled { opacity: 0.3; cursor: not-allowed; }
</style>

