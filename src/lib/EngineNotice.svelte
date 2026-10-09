<script>
  // The queue's notice for a chapter the Rust text engine fits for the first
  // time (`firstFit` in the store): a chapter lettered under the browser,
  // opened with the new engine switched on. That engine measures a little
  // differently, so an open can grow a height, raise or clear a "needs
  // review" flag, or break a box's lines somewhere else. It never changes a
  // box's width, size or place - with one exception that is not the engine's:
  // a box stored as never laid out (placed while its font was still loading)
  // is laid out by the open that finds its font, under either engine, and is
  // counted here as that. This says how many of each, once per chapter.
  //
  // Nothing is saved by opening. The file takes the changes with the first
  // save an edit of the user's causes, or when they press Keep here. Until
  // then leaving the chapter writes nothing, and turning the engine off puts
  // every box back. A Keep whose write fails has kept nothing: the store
  // brings this back, and the reason is said in a toast.
  //
  // It lists no boxes of its own. A flagged box is in the review list, where
  // flagged boxes always are, and a box whose lines moved is listed there too
  // for as long as this stands (`flaggedBoxes`), without being flagged: the
  // list under this notice is the way through them, and "Show first" is the
  // first of them.
  //
  // It is the review list's sibling and sits above it, so it wears the same
  // clothes: the rules below are that component's, copied because a
  // component's styles are its own.
  import { app, firstFitChanges, keepFirstFit, gotoPage, selectBox, isLongstrip, toast } from './store.svelte.js';
  import { revealInStrip } from './editor/strip-sync.svelte.js';
  import { plural } from './format.js';

  // Null with the browser measuring, at version 2, and once answered: then
  // nothing below reads a box.
  const changes = $derived(firstFitChanges(app.pages));
  const any = $derived(!!changes && (changes.keeping || app.saveFailed || changes.grew + changes.flagged + changes.cleared + changes.relaid + changes.laid > 0));
  const what = $derived(
    changes
      ? [
          changes.relaid ? `${plural(changes.relaid, 'box', 'boxes')} with new line breaks` : '',
          changes.flagged ? `${plural(changes.flagged, 'box', 'boxes')} newly flagged` : '',
          changes.cleared ? `${plural(changes.cleared, 'box', 'boxes')} no longer flagged` : '',
          changes.grew ? `${plural(changes.grew, 'box', 'boxes')} grew taller` : '',
          changes.laid ? `${plural(changes.laid, 'box', 'boxes')} laid out for the first time` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : '',
  );
  let busy = $state(false);

  function show() {
    const first = changes?.first;
    if (!first) return;
    const i = app.pages.findIndex((pg) => pg.id === first.pageId);
    if (i < 0) return;
    if (i !== app.pageIndex) gotoPage(i);
    selectBox(first.boxId);
    if (isLongstrip()) revealInStrip(first.boxId);
  }

  async function keep() {
    busy = true;
    try {
      await keepFirstFit();
    } catch (e) {
      toast(`Could not save: ${e?.message ?? e}`);
    } finally {
      busy = false;
    }
  }
</script>

{#if any}
  <div class="en" role="status">
    <div class="en-head">
      <span class="en-mark" aria-hidden="true">i</span>
      <span class="en-title">Fitted by the new text engine for the first time</span>
    </div>
    {#if what}<div class="en-what">{what}</div>{/if}
    <div class="en-note">
      {changes.laid ? 'No other box' : 'No box'} changed its width, size or place.
      {#if changes.keeping}
        Keep is waiting for fonts. After four seconds it saves what is ready; a font that arrives later is saved too.
      {:else if changes.kept}
        These are saved with the chapter.
      {:else}
        Nothing is saved until you edit the chapter or keep these.
      {/if}
      {#if changes.first}The boxes to look at are in the review list below.{/if}
    </div>
    <div class="en-row">
      <button class="en-btn" disabled={!changes.first} title="Go to the first box that is newly flagged or has new line breaks" onclick={show}>Show first</button>
      <button
        class="en-btn primary"
        disabled={busy || changes.keeping}
        title={changes.kept ? 'Close this notice' : 'Save the chapter with these changes and close this notice'}
        onclick={keep}
      >
        {changes.keeping ? 'Waiting for fonts…' : changes.kept ? 'Got it' : 'Keep'}
      </button>
    </div>
  </div>
{/if}

<style>
  .en {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 7px 9px 8px;
    border-radius: 7px;
    border: 1px solid var(--line2);
    background: var(--surface);
    margin-bottom: 4px;
  }
  .en-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
  }
  .en-mark {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--panel);
    font-size: 11px;
    font-weight: 800;
  }
  .en-title {
    flex: 1 1 auto;
    min-width: 0;
  }
  .en-what {
    font-size: 12px;
    color: var(--text);
  }
  .en-note {
    font-size: 10.5px;
    color: var(--muted, var(--text));
    opacity: 0.8;
  }
  .en-row {
    display: flex;
    gap: 6px;
    margin-top: 3px;
  }
  .en-btn {
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--line2);
    background: var(--panel2);
    color: var(--text);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .en-btn:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .en-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .en-btn.primary {
    border-color: var(--accent);
  }
</style>
