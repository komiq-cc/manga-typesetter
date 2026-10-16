<script>
  // The command palette (FLOW-4): type a few words, press Enter, and the action
  // runs - every shortcut in the registry plus the ones with no key. What it
  // lists and how an entry runs lives in palette-actions.js; this is the field,
  // the list and the keys that walk it.
  //
  // It renders a `.modal-overlay.open` root while showing, like every other
  // modal, because App.svelte's keydown handler stands down while one is up:
  // Mod+D typed into this field must not duplicate the box underneath.
  import { tick } from 'svelte';
  import { paletteResults, entryKey } from './palette-actions.js';
  import { comboFor, matchesCombo } from './shortcuts.svelte.js';
  import { captureFocus } from './focus.js';
  import { toast } from './store.svelte.js';

  let { open = $bindable(false), openFonts, openSettings } = $props();

  let query = $state('');
  let active = $state(0);
  let input = $state(null);
  let listEl = $state(null);
  // Where focus was before the palette took it, given back on close.
  let restore = null;

  // Recomputed per keystroke, which is a filter over forty-odd entries. Only
  // while open: the guards read the chapter, and nothing needs them otherwise.
  const results = $derived(open ? paletteResults(query) : []);

  // Opening starts from an empty field and the top of the list, every time:
  // the last search is rarely the next one. The cleanup gives focus back when
  // something else closed the palette (App's Escape, with focus elsewhere).
  $effect(() => {
    if (!open) return;
    restore = captureFocus();
    query = '';
    active = 0;
    tick().then(() => input?.focus());
    return giveFocusBack;
  });

  // A new query puts the highlight back on its best match.
  $effect(() => {
    query;
    active = 0;
  });

  function giveFocusBack() {
    const back = restore;
    restore = null;
    back?.();
  }

  // Focus first, while the element that had it is still on screen, then close.
  function close() {
    giveFocusBack();
    open = false;
  }

  // Closed before it runs: an action that opens a dialog of its own, or moves
  // the selection, should find the palette already gone and focus back where
  // the user left it. A handler that declines says so rather than nothing.
  function run(entry) {
    if (!entry) return;
    close();
    const ok = entry.run({ openFonts, openSettings });
    if (ok === false) toast('Nothing to do here');
  }

  function move(step) {
    const n = results.length;
    if (!n) return;
    active = (active + step + n) % n;
    tick().then(() => listEl?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }));
  }

  // Every key the palette answers is stopped here, so the editor's own handler
  // never sees an arrow or an Escape meant for this list. Tab is held too: the
  // field is the one place focus may be while the palette is up.
  function onKeydown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    let handled = true;
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Enter') run(results[active]);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') input?.focus();
    // The palette's own key closes it again, wherever it is bound.
    else if (matchesCombo(e, comboFor('palette.open'))) close();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onOverlayClick(e) {
    if (e.target === e.currentTarget) close();
  }

  // A press anywhere in the panel keeps focus in the field: the list is driven
  // from it, and a click that took focus would leave Escape and the arrows with
  // nowhere to go.
  function keepFocus(e) {
    if (e.target !== input) e.preventDefault();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="modal-overlay open palette-overlay" onclick={onOverlayClick}>
    <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" tabindex="-1" onkeydown={onKeydown} onmousedown={keepFocus}>
      <div class="palette-field">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
        <input
          bind:this={input}
          bind:value={query}
          type="text"
          placeholder="Type an action or a page number"
          spellcheck="false"
          autocomplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[active] ? `palette-opt-${active}` : undefined}
        />
      </div>
      {#if results.length}
        <div class="palette-list" id="palette-list" role="listbox" bind:this={listEl}>
          {#each results as entry, i (entry.id)}
            {@const key = entryKey(entry)}
            <!-- The keys are the field's (see `onKeydown`); an option is
                 never focused, only highlighted. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              id="palette-opt-{i}"
              class="palette-item"
              class:on={i === active}
              role="option"
              aria-selected={i === active}
              tabindex="-1"
              onmousemove={() => (active = i)}
              onclick={() => run(entry)}
            >
              <span class="palette-label">{entry.label}</span>
              <span class="palette-group">{entry.group}</span>
              {#if key}<kbd class="palette-key">{key}</kbd>{/if}
            </div>
          {/each}
        </div>
      {:else}
        <div class="palette-empty">Nothing matches</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Upper third rather than dead centre: the list grows downward as it fills,
     and a field that jumped as results came and went would be hard to type in. */
  .palette-overlay {
    align-items: flex-start;
    padding-top: 14vh;
  }
  .palette {
    width: min(560px, calc(100vw - 32px));
    max-height: 62vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--panel);
    border: 1px solid var(--line2);
    border-radius: 12px;
    box-shadow: var(--edge);
    outline: none;
  }
  .palette-field {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 46px;
    padding: 0 14px;
    border-bottom: 1px solid var(--line);
  }
  .palette-field svg {
    width: 16px;
    height: 16px;
    flex: none;
    color: var(--t3);
  }
  .palette-field input {
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
    border: none;
    outline: none;
    background: transparent;
    font-size: 14px;
    user-select: text;
    -webkit-user-select: text;
  }
  .palette-field input::placeholder {
    color: var(--t3);
  }
  .palette-list {
    flex: 1 1 auto;
    overflow: auto;
    padding: 4px;
  }
  .palette-item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12.5px;
  }
  .palette-item.on {
    background: var(--accent-soft);
  }
  .palette-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .palette-group {
    flex: none;
    font-size: 11px;
    color: var(--t3);
  }
  .palette-key {
    flex: none;
    min-width: 22px;
    padding: 1px 6px;
    font: inherit;
    font-size: 11px;
    text-align: center;
    color: var(--t2);
    background: var(--surface);
    border: 1px solid var(--line2);
    border-radius: 5px;
  }
  .palette-empty {
    padding: 16px 14px;
    color: var(--t3);
    font-size: 12.5px;
  }
</style>
