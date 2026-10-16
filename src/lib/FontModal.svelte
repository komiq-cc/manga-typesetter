<script>
  import { app } from './store.svelte.js';
  import {
    addFontFile,
    addFontFiles,
    removeUserFont,
    removeFontFace,
    FACE_SLOTS,
    SLOT_LABEL,
    isBold,
    isItalic,
    scanSystemFonts,
  } from './fonts.js';
  import { isBuiltinHidden, setBuiltinHidden, isSystemShown, setSystemShown } from './font-menu.js';
  import { isTauri } from './importer.js';

  let { open = $bindable() } = $props();
  let fileInput;
  let slotInput;
  let dragOver = $state(false);
  // Chosen file overrides filename heuristics.
  let slotTarget = null;

  function onOverlayClick(e) {
    if (e.target.classList.contains('modal-overlay')) open = false;
  }
  function onPick(e) {
    addFontFiles(e.target.files);
    e.target.value = '';
  }
  function onDrop(e) {
    e.preventDefault();
    dragOver = false;
    if (e.dataTransfer?.files?.length) addFontFiles(e.dataTransfer.files);
  }
  function pickForSlot(family, slot) {
    slotTarget = { family, slot };
    slotInput.click();
  }
  async function onSlotPick(e) {
    const file = e.target.files?.[0];
    const target = slotTarget;
    slotTarget = null;
    e.target.value = '';
    if (file && target) await addFontFile(file, target);
  }

  const faceStyle = (css, slot) =>
    `font-family:${css};font-weight:${isBold(slot) ? 700 : 400};font-style:${isItalic(slot) ? 'italic' : 'normal'}`;
  const realCount = (f) => FACE_SLOTS.filter((s) => f.faces?.[s]).length;

  // ---- built-ins: offered until hidden ----
  // Hiding is per family and reversible, and it is all "remove" can mean for a
  // built-in: the face is bundled, and a box already set in it keeps drawing.
  const offeredBuiltins = $derived(app.fonts.builtin.filter((f) => !isBuiltinHidden(f.name)));
  const hiddenBuiltins = $derived(app.fonts.builtin.filter((f) => isBuiltinHidden(f.name)));
  let showHiddenBuiltins = $state(false);

  // ---- system fonts: hidden until shown ----
  // A machine has hundreds of these and a manga letterer wants three of them, so
  // the list is a search over what is installed, and a family enters the menus
  // one at a time. The ones already shown are listed first, so the choice made
  // is visible without searching for it.
  let sysQuery = $state('');
  let rescanning = $state(false);
  const SYS_PAGE = 80;
  const systemSorted = $derived.by(() => {
    const q = sysQuery.trim().toLowerCase();
    const list = q ? app.fonts.system.filter((f) => f.name.toLowerCase().includes(q)) : app.fonts.system;
    const shown = list.filter((f) => isSystemShown(f.name));
    const rest = list.filter((f) => !isSystemShown(f.name));
    return { shown, rest, total: list.length };
  });
  const shownCount = $derived(app.fonts.system.filter((f) => isSystemShown(f.name)).length);
  async function rescan() {
    rescanning = true;
    try {
      await scanSystemFonts();
    } finally {
      rescanning = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="modal-overlay" class:open onclick={onOverlayClick}>
  <div class="modal">
    <div class="modal-head">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M12 4v16" /><path d="M9 20h6" /></svg>
      <h3>Font Library</h3>
      <button class="x" aria-label="Close" onclick={() => (open = false)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </button>
    </div>
    <div class="modal-body">
      <input bind:this={fileInput} type="file" accept=".ttf,.otf,.woff,.woff2" multiple style="display:none" onchange={onPick} />
      <input bind:this={slotInput} type="file" accept=".ttf,.otf,.woff,.woff2" style="display:none" onchange={onSlotPick} />
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div
        class="font-dropzone"
        class:drag={dragOver}
        onclick={() => fileInput.click()}
        ondragover={(e) => { e.preventDefault(); dragOver = true; }}
        ondragleave={() => (dragOver = false)}
        ondrop={onDrop}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
        <div style="text-align:left">
          <div><b>Add Font</b> - drop or browse</div>
          <div class="sub">Drop a whole family at once - Regular, Bold, Italic and BoldItalic files group themselves</div>
        </div>
      </div>

      <div>
        <div class="font-group-label">User fonts · {app.fonts.user.length}</div>
        <div class="font-list">
          {#if app.fonts.user.length}
            {#each app.fonts.user as f (f.name)}
              <div class="font-family">
                <div class="ff-head">
                  <div class="fname">{f.name}</div>
                  <div class="ff-count">{realCount(f)} of 4 real faces</div>
                  <button class="del" title="Remove the whole family" onclick={() => removeUserFont(f.name)}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
                <div class="ff-faces">
                  {#each FACE_SLOTS as slot (slot)}
                    <div class="ff-face" class:faux={!f.faces?.[slot]}>
                      <div class="ff-slot">{SLOT_LABEL[slot]}</div>
                      <div class="sample" style={faceStyle(f.css, slot)}>Kaboom 123</div>
                      {#if f.faces?.[slot]}
                        <div class="ff-file" title={f.faces[slot].file || ''}>{f.faces[slot].file || 'loaded'}</div>
                        <button class="del sm" title="Remove this face" onclick={() => removeFontFace(f.name, slot)}>
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                        </button>
                      {:else}
                        <div class="ff-file faux-tag">faux - synthesised</div>
                        <button class="add sm" title="Use a real file for this face" onclick={() => pickForSlot(f.name, slot)}>
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
                        </button>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          {:else}
            <div class="qhint">No user fonts yet. Drop a .ttf/.otf/.woff2 above - it persists across reloads.</div>
          {/if}
        </div>

        <div class="font-group-label">Built-in fonts · {offeredBuiltins.length}{hiddenBuiltins.length ? ` · ${hiddenBuiltins.length} hidden` : ''}</div>
        <div class="font-list">
          {#each offeredBuiltins as f (f.name)}
            <div class="font-family">
              <div class="ff-head">
                <div class="fname">{f.name}</div>
                <div class="ff-count">{realCount(f)} of 4 real faces</div>
                <span class="builtin-tag">built-in</span>
                <button class="del" title="Hide from the font menus - boxes already set in it keep it" onclick={() => setBuiltinHidden(f.name, true)}>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              </div>
              <div class="ff-faces">
                {#each FACE_SLOTS as slot (slot)}
                  <div class="ff-face" class:faux={!f.faces?.[slot]}>
                    <div class="ff-slot">{SLOT_LABEL[slot]}</div>
                    <div class="sample" style={faceStyle(f.css, slot)}>Kaboom 123</div>
                    <div class="ff-file" class:faux-tag={!f.faces?.[slot]}>{f.faces?.[slot] ? 'web font' : 'faux - synthesised'}</div>
                  </div>
                {/each}
              </div>
            </div>
          {:else}
            <div class="qhint">Every built-in font is hidden. Show one below to put it back in the menus.</div>
          {/each}
          {#if hiddenBuiltins.length}
            <button class="reveal" onclick={() => (showHiddenBuiltins = !showHiddenBuiltins)}>
              {showHiddenBuiltins ? 'Hide' : 'Show'} the {hiddenBuiltins.length} hidden built-in {hiddenBuiltins.length === 1 ? 'font' : 'fonts'}
            </button>
            {#if showHiddenBuiltins}
              {#each hiddenBuiltins as f (f.name)}
                <div class="font-row">
                  <div class="fname" style="font-family:{f.css}">{f.name}</div>
                  <div class="ff-count">hidden</div>
                  <button class="pill" onclick={() => setBuiltinHidden(f.name, false)}>Show in menus</button>
                </div>
              {/each}
            {/if}
          {/if}
        </div>

        <div class="font-group-label">System fonts · {shownCount} shown of {app.fonts.system.length}</div>
        <div class="font-list">
          {#if !isTauri()}
            <div class="qhint">The fonts installed on this computer are read by the desktop app; a browser cannot see them.</div>
          {:else}
            <div class="sys-bar">
              <input class="sys-search" type="search" placeholder="Search installed fonts…" bind:value={sysQuery} />
              <button class="pill" disabled={rescanning} onclick={rescan}>{rescanning ? 'Scanning…' : 'Rescan'}</button>
            </div>
            <div class="qhint">
              Installed fonts stay out of the menus until you show them here. Showing one offers it to every box; hiding it again takes it out of the menus and leaves the boxes as they are.
            </div>
            {#if !app.fonts.system.length}
              <div class="qhint">{rescanning ? 'Reading the installed fonts…' : 'No installed fonts were found.'}</div>
            {/if}
            {#each systemSorted.shown as f (f.name)}
              <div class="font-row on">
                <div class="fname" style="font-family:{f.css}">{f.name}</div>
                <div class="ff-count">{realCount(f)} of 4 real faces · in menus</div>
                <button class="pill" onclick={() => setSystemShown(f.name, false)}>Hide</button>
              </div>
            {/each}
            {#each systemSorted.rest.slice(0, SYS_PAGE) as f (f.name)}
              <div class="font-row">
                <div class="fname" style="font-family:{f.css}">{f.name}</div>
                <div class="ff-count">{realCount(f)} of 4 real faces</div>
                <button class="pill" onclick={() => setSystemShown(f.name, true)}>Show in menus</button>
              </div>
            {/each}
            {#if systemSorted.rest.length > SYS_PAGE}
              <div class="qhint">{systemSorted.rest.length - SYS_PAGE} more - narrow the search to find them.</div>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .font-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 9px;
  }
  .font-row.on {
    border-color: var(--accent);
  }
  .font-row .fname {
    font-size: 16px;
    flex: 1 1 auto;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .font-row .ff-count {
    margin-right: 0;
    flex: 0 0 auto;
  }
  .pill,
  .reveal {
    flex: 0 0 auto;
    border: 1px solid var(--line2);
    background: transparent;
    color: var(--t2);
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 11.5px;
    cursor: pointer;
  }
  .pill:hover:not(:disabled),
  .reveal:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .pill:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .reveal {
    align-self: flex-start;
  }
  .sys-bar {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .sys-search {
    flex: 1 1 auto;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--line2);
    border-radius: 7px;
    background: var(--panel2);
    color: var(--text);
    font-size: 12.5px;
  }

  .font-family {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 9px;
    overflow: hidden;
  }
  .ff-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
  }
  .ff-head .fname {
    font-size: 13px;
    font-weight: 600;
  }
  .ff-count {
    font-size: 11px;
    color: var(--t3);
    margin-right: auto;
  }
  .ff-faces {
    display: flex;
    flex-direction: column;
  }
  .ff-face {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 7px 14px;
  }
  .ff-face + .ff-face {
    border-top: 1px solid var(--line);
  }
  .ff-face.faux {
    background: var(--panel2);
  }
  .ff-slot {
    flex: 0 0 78px;
    font-size: 11px;
    color: var(--t2);
  }
  .ff-face .sample {
    flex: 1 1 auto;
    font-size: 20px;
    color: var(--text);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .ff-face.faux .sample {
    color: var(--t2);
  }
  .ff-file {
    flex: 0 0 150px;
    font-size: 11px;
    color: var(--t3);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: right;
  }
  .faux-tag {
    color: var(--warn);
  }
  .add {
    flex: 0 0 auto;
    border: 1px solid var(--line2);
    background: transparent;
    color: var(--t2);
    border-radius: 6px;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .add:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .sm {
    width: 24px;
    height: 24px;
  }
  .ff-head .del {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border: 1px solid var(--line2);
    background: transparent;
    color: var(--t2);
    border-radius: 6px;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .ff-head .del:hover {
    border-color: var(--warn);
    color: var(--warn);
  }
  .ff-face .del {
    border: 1px solid var(--line2);
    background: transparent;
    color: var(--t2);
    border-radius: 6px;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .ff-face .del:hover {
    border-color: var(--warn);
    color: var(--warn);
  }
</style>
