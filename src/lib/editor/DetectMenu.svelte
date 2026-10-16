<script>
  // Detection has two scopes and one artefact - more than a pill can hold, so
  // the pill opens this instead. Per-page detection has never had a UI before;
  // it was whole-chapter or nothing, which is a long wait to fix one page.
  import { app, toast, toastError } from '../store.svelte.js';
  import { sidecarReady, detectCurrentPage, detectAllPages } from '../sidecar.js';
  import { exportTextJson } from '../exporter.js';

  let { anchor = null, onClose } = $props();

  let menuEl = $state(null);

  // Both detection items ask the engine for work, so both need it up and idle.
  // The functions themselves still refuse and toast when there is no raw image
  // to look at; this only keeps the menu from offering work that cannot start.
  const canDetect = $derived(sidecarReady() && !app.detecting);
  // The JSON *is* detection's output, so there is nothing to save until some
  // page in the chapter carries it.
  const canSaveJson = $derived(app.pages.some((p) => p?.detect));

  // Escape and choosing an item both hand the keyboard back to the pill that
  // opened the menu - otherwise focus falls to the document and the next Tab
  // starts over from the top of the page, which is a long way from here.
  // Dismissal by pointer does not: the pointer has already said where it wants
  // to be.
  function close({ restoreFocus = false } = {}) {
    if (restoreFocus) anchor?.focus();
    onClose?.();
  }

  // Capture, so the menu swallows the key before the editor's own Escape
  // handling deselects a box the user was not trying to let go of.
  // stopImmediatePropagation, not stopPropagation: other window-level capture
  // listeners registered before this one are on the same node and the same
  // phase, and only the immediate form stops those.
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.stopImmediatePropagation();
    close({ restoreFocus: true });
  }

  // The menu is opened from a pill, so the keyboard has to arrive with it -
  // landing on the first item the user can actually use. Roving arrow-key
  // movement between three items is not worth its own state machine: Tab
  // already walks them in order and Escape gets out.
  function focusFirst(node) {
    node.querySelector('button:not(:disabled)')?.focus();
  }

  // The trigger is spared as well as the menu itself: a pointerdown on the pill
  // would otherwise close the menu a beat before the same gesture's click
  // reopened it, and the pill would look dead on the second press.
  function onDown(e) {
    if (menuEl?.contains(e.target) || anchor?.contains(e.target)) return;
    close();
  }

  $effect(() => {
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  });

  // Closed first, then run: detection takes minutes, and a menu hanging open
  // over the canvas for all of it is not a menu any more. Focus goes back to
  // the pill for the same reason Escape sends it there - the item that had it
  // is about to leave the DOM.
  function run(fn) {
    close({ restoreFocus: true });
    fn();
  }

  // The chapter's detected text as one document, through the exporter's single
  // serialiser - the same file the export dialog's JSON format writes, so the
  // two can never drift. Scope is the whole chapter: choosing between scopes is
  // what that dialog is for, and the detection JSON is a chapter-level artefact.
  //
  // app.exporting is held here rather than inside exportTextJson, exactly as
  // exportImages holds it, so the export pill greys out while the save dialog
  // is up. The catch mirrors exportImages' too - nothing else is left to
  // report a rejected native write.
  async function saveDetectionJson() {
    close({ restoreFocus: true });
    app.exporting = true;
    try {
      await exportTextJson('all');
    } catch (e) {
      toastError('Export failed: ' + (e?.message || e));
    } finally {
      app.exporting = false;
    }
  }
</script>

<div class="chrome-menu" role="menu" bind:this={menuEl} use:focusFirst>
  <button role="menuitem" disabled={!canDetect} onclick={() => run(detectCurrentPage)}>This page</button>
  <button role="menuitem" disabled={!canDetect} onclick={() => run(detectAllPages)}>Whole chapter</button>
  <div class="chrome-menu-sep"></div>
  <button role="menuitem" disabled={!canSaveJson} onclick={saveDetectionJson}>Save detection JSON…</button>
</div>
