<script>
  // The brush library, as a window: the counterpart of FontModal. Every
  // installed brush with its tip, its name, what it is worth, and the two
  // things a letterer does to one - edit its settings, or remove it - plus the
  // import that adds more. Opened from the panel's Manage button and from a
  // right-click on any tip, which lands straight in that brush's editor.
  import { untrack } from 'svelte';
  import { toast, toastError } from './store.svelte.js';
  import { brushTool, closeBrushManager } from './brush-tool.svelte.js';
  import {
    brushLibrary,
    installedBrushes,
    importBrushes,
    loadBrushLibrary,
    removeBrush,
    updateBrush,
    sanitiseBrushSettings,
  } from './brush-library.svelte.js';
  import { importSentence, tipDims } from './brush-picker.js';
  import { tipCell } from './brush-tip-cell.js';
  import { DYN_SOURCES } from './brush.js';
  import { isTauri } from './importer.js';

  const open = $derived(brushTool.manager);

  // Which brush's editor is open, and the draft it is editing. The draft is a
  // plain copy: nothing reaches the library until Save.
  let editId = $state(null);
  let draft = $state(null);
  let saving = $state(false);
  let importing = $state(false);
  let rmArm = $state('');
  let rmArmT;

  // Opens the editor the caller asked for - once the library is there to be
  // asked. `loaded` is read so the effect comes back when a boot-time load
  // lands after the right-click that opened this; the id is cleared once it
  // has been honoured, so a Cancel is not undone by the next reactive tick.
  $effect(() => {
    if (!open) {
      editId = null;
      draft = null;
      rmArm = '';
      clearTimeout(rmArmT);
      return;
    }
    loadBrushLibrary();
    const want = brushTool.editBrushId;
    if (!want || !brushLibrary.loaded) return;
    untrack(() => {
      beginEdit(want);
      brushTool.editBrushId = null;
    });
  });

  function beginEdit(id) {
    const b = installedBrushes.find((x) => x.id === id);
    if (!b) return;
    editId = id;
    draft = { name: b.name, settings: sanitiseBrushSettings($state.snapshot(b.settings)) };
    if (!draft.settings.dyn) draft.settings.dyn = { src: 'off', amount: 70 };
  }
  function cancelEdit() {
    editId = null;
    draft = null;
  }
  async function saveEdit() {
    if (!editId || !draft || saving) return;
    saving = true;
    try {
      const ok = await updateBrush(editId, $state.snapshot(draft));
      ok ? toast('Brush saved') : toastError('That brush could not be saved');
      if (ok) cancelEdit();
    } finally {
      saving = false;
    }
  }

  async function onRemove(b) {
    if (rmArm !== b.id) {
      rmArm = b.id;
      clearTimeout(rmArmT);
      rmArmT = setTimeout(() => (rmArm = ''), 2500);
      return;
    }
    rmArm = '';
    clearTimeout(rmArmT);
    const ok = await removeBrush(b.id);
    if (ok && editId === b.id) cancelEdit();
    ok ? toast('Brush removed') : toastError('That brush could not be removed');
  }

  // Escape backs out of the editor first and only then, on a second press,
  // out of the manager - the App's own Escape chain closes the modal, and it
  // is stopped here while a draft is open so an edit is not thrown away.
  function onKey(e) {
    if (e.key !== 'Escape' || !editId) return;
    e.preventDefault();
    e.stopPropagation();
    cancelEdit();
  }

  async function onImport() {
    if (importing) return;
    if (brushLibrary.readOnly) return toastError(brushLibrary.error);
    if (!isTauri()) return toast('Importing brushes needs the desktop app');
    importing = true;
    try {
      const { open: pickFiles } = await import('@tauri-apps/plugin-dialog');
      const picked = await pickFiles({ multiple: true, filters: [{ name: 'Brushes', extensions: ['sut', 'abr'] }] });
      const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
      if (!paths.length) return;
      toast(importSentence(await importBrushes(paths)));
    } catch (e) {
      toastError(`Couldn't import brushes: ${e?.message ?? e}`);
    } finally {
      importing = false;
    }
  }

  function onOverlayClick(e) {
    if (e.target.classList.contains('modal-overlay')) closeBrushManager();
  }

  const DYN_LABEL = { off: 'Off', pressure: 'Pressure', velocity: 'Velocity', random: 'Random' };
  const summary = (b) => {
    const s = b.settings ?? {};
    const parts = [`${Math.round(s.size ?? 0)} px`, `spacing ${Math.round(s.spacing ?? 0)}%`];
    if (s.dyn?.src && s.dyn.src !== 'off') parts.push(`${DYN_LABEL[s.dyn.src].toLowerCase()} ${Math.round(s.dyn.amount ?? 0)}%`);
    if (s.taperIn?.on || s.taperOut?.on) parts.push('taper');
    if (s.waterEdge) parts.push('water edge');
    return parts.join(' · ');
  };
  const num = (obj, key, v, lo, hi) => {
    obj[key] = Math.min(hi, Math.max(lo, Number(v) || 0));
  };
</script>

{#snippet slider(label, obj, key, lo, hi, max)}
  <div class="grp">
    <span class="lbl">{label}</span>
    <div class="slider-row">
      <input type="range" min={lo} max={max ?? hi} step="1" value={obj[key]} aria-label={label} oninput={(e) => num(obj, key, e.target.value, lo, hi)} />
      <input class="num-s" type="number" min={lo} max={hi} step="1" value={obj[key]} aria-label={label} onchange={(e) => num(obj, key, e.target.value, lo, hi)} />
    </div>
  </div>
{/snippet}

{#snippet pctSlider(label, obj, key, lo)}
  <div class="grp">
    <span class="lbl">{label}</span>
    <div class="slider-row">
      <input type="range" min={lo} max="100" step="1" value={Math.round(obj[key] * 100)} aria-label={label} oninput={(e) => (obj[key] = Math.min(1, Math.max(lo / 100, Number(e.target.value) / 100)))} />
      <input class="num-s" type="number" min={lo} max="100" step="1" value={Math.round(obj[key] * 100)} aria-label={label} onchange={(e) => (obj[key] = Math.min(1, Math.max(lo / 100, Number(e.target.value) / 100)))} />
    </div>
  </div>
{/snippet}

{#snippet toggle(label, obj, key)}
  <div class="switch-row">
    <button type="button" class="switch" class:on={obj[key]} role="switch" aria-checked={obj[key]} aria-label={label} onclick={() => (obj[key] = !obj[key])}><span class="knob"></span></button>
    <span class="lbl2">{label}</span>
  </div>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" class:open onclick={onOverlayClick} onkeydown={onKey}>
  <div class="modal">
    <div class="modal-head">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M19 4 11 12" /><path d="M13 10l-2 3.5a2.6 2.6 0 1 1-3.5-3.5L11 8" /><path d="M4 19c1.6 0 2.8-.7 3.3-2" /></svg>
      <h3>Brush Library</h3>
      <button class="x" onclick={closeBrushManager} aria-label="Close">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>
    <div class="modal-body">
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div class="font-dropzone" class:busy={importing} onclick={onImport}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
        <div style="text-align:left">
          <div><b>Import brushes</b> - Clip Studio <code>.sut</code> or Photoshop <code>.abr</code></div>
          <div class="sub">{brushLibrary.readOnly ? brushLibrary.error : 'A file can hold several brushes; each one is installed app-wide.'}</div>
        </div>
      </div>

      <div class="font-group-label">Installed brushes · {installedBrushes.length}</div>
      <div class="list">
        {#if !installedBrushes.length}
          <div class="qhint">{brushLibrary.loaded ? 'No brushes yet. Import a .sut or .abr above - the round tip is always there.' : 'Loading…'}</div>
        {/if}
        {#each installedBrushes as b (b.id)}
          <div class="row" class:editing={editId === b.id}>
            <div class="row-main">
              <button type="button" class="tip" title="Edit {b.name}" aria-label="Edit {b.name}" onclick={() => (editId === b.id ? cancelEdit() : beginEdit(b.id))} oncontextmenu={(e) => { e.preventDefault(); beginEdit(b.id); }}>
                <canvas use:tipCell={b.id} aria-hidden="true"></canvas>
              </button>
              <div class="meta">
                <div class="name">
                  <span title={b.name}>{b.name}</span>
                  {#if b.source === 'thumbnail'}<span class="chip" title="The pixels could not be read, so this is CSP's own preview of the tip.">preview</span>{/if}
                  {#if b.source === 'round'}<span class="chip" title="This brush had no tip image; a round tip stands in.">round</span>{/if}
                </div>
                <div class="sub">{tipDims(b)}{tipDims(b) ? ' · ' : ''}{summary(b)}</div>
              </div>
              <button type="button" class="btn" onclick={() => (editId === b.id ? cancelEdit() : beginEdit(b.id))}>{editId === b.id ? 'Close' : 'Edit'}</button>
              <button type="button" class="btn del" class:arm={rmArm === b.id} disabled={brushLibrary.readOnly} title={rmArm === b.id ? 'Click again to remove' : 'Remove'} onclick={() => onRemove(b)}>{rmArm === b.id ? 'Sure?' : 'Remove'}</button>
            </div>
            {#if editId === b.id && draft}
              <div class="editor insp">
                <div class="grp">
                  <label class="lbl" for="brush-name-{b.id}">Name</label>
                  <input id="brush-name-{b.id}" type="text" bind:value={draft.name} />
                </div>
                <div class="cols">
                  {@render slider('Size', draft.settings, 'size', 1, 2000, 400)}
                  {@render pctSlider('Opacity', draft.settings, 'opacity', 0)}
                  {@render slider('Spacing', draft.settings, 'spacing', 1, 200, 100)}
                  {@render slider('Hardness', draft.settings, 'hardness', 0, 100)}
                  {@render slider('Angle', draft.settings, 'angle', 0, 359)}
                  {@render pctSlider('Flatness', draft.settings, 'flatness', 1)}
                </div>
                <div class="insp-rule"></div>
                <div class="grp">
                  <span class="lbl">Size follows</span>
                  <div class="seg">
                    {#each DYN_SOURCES as src (src)}
                      <button type="button" class:on={draft.settings.dyn.src === src} aria-pressed={draft.settings.dyn.src === src} onclick={() => (draft.settings.dyn.src = src)}>{DYN_LABEL[src]}</button>
                    {/each}
                  </div>
                </div>
                <div class="cols">
                  {@render slider('Amount', draft.settings.dyn, 'amount', 0, 100)}
                  {@render slider('Stabilisation', draft.settings, 'stabilise', 0, 100)}
                </div>
                <div class="cols">
                  {#each [['taperIn', 'Taper in'], ['taperOut', 'Taper out']] as [key, label] (key)}
                    <div class="taper">
                      {@render toggle(label, draft.settings[key], 'on')}
                      {@render slider('Length', draft.settings[key], 'len', 0, 500, 200)}
                      {@render slider('Sharpness', draft.settings[key], 'ratio', 0, 100)}
                    </div>
                  {/each}
                </div>
                {@render toggle('Watercolour edge', draft.settings, 'waterEdge')}
                <div class="edit-actions">
                  <button type="button" class="btn primary" disabled={saving} onclick={saveEdit}>Save</button>
                  <button type="button" class="btn" onclick={cancelEdit}>Cancel</button>
                  <span class="note">Strokes already drawn keep the settings they were drawn with.</span>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .font-dropzone.busy {
    opacity: 0.6;
    pointer-events: none;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 9px;
    overflow: hidden;
  }
  .row.editing {
    border-color: var(--line2);
  }
  .row-main {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
  }
  /* Ink on paper in both themes, like every tip cell. */
  .tip {
    flex: 0 0 auto;
    width: 56px;
    height: 56px;
    padding: 3px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: var(--paper);
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .tip canvas {
    max-width: 100%;
    max-height: 100%;
    display: block;
  }
  .meta {
    flex: 1 1 auto;
    min-width: 0;
  }
  .name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    min-width: 0;
  }
  .name span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta .sub {
    font-size: 11px;
    color: var(--t3);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip {
    flex: 0 0 auto;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid var(--warn);
    color: var(--warn);
    font-size: 9.5px;
    font-weight: 500;
    letter-spacing: 0.08em;
  }
  .btn {
    flex: 0 0 auto;
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--line2);
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--text);
  }
  .btn.primary {
    background: var(--accent);
    color: var(--accent-fg);
    border-color: var(--accent);
  }
  .btn.del:hover:not(:disabled),
  .btn.del.arm {
    border-color: var(--warn);
    color: var(--warn);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  /* The editor borrows the Inspector's control vocabulary through `.insp`. */
  .editor {
    border-top: 1px solid var(--line);
    background: var(--panel2);
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 10px 18px;
  }
  .taper {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .edit-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  .note {
    font-size: 11px;
    color: var(--t3);
    margin-left: auto;
  }
</style>
