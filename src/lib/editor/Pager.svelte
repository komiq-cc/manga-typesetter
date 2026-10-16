<script>
  // The page indicator doubles as a jump-to-page field: click the number, it
  // becomes a text box; type a page and press Enter. Anything that isn't a
  // whole page number in range is rejected rather than clamped, so a mistyped
  // value never silently jumps somewhere the user didn't ask for - it just
  // reverts to the plain number, same as abandoning with Escape.
  import { app, checks, gotoPage, nextPage, prevPage, isTranslateMode } from '../store.svelte.js';
  import PagesMenu from './PagesMenu.svelte';

  let editing = $state(false);
  let draft = $state('');

  // The page's status dot (FLOW-2) and the page list it opens. Not in a
  // translate chapter: it has no boxes, so every page would read "done".
  const showStatus = $derived(!isTranslateMode() && app.pages.length > 0);
  const status = $derived(checks.pages[app.pageIndex] ?? 'done');
  const STATUS_TIP = { todo: 'To do: lines not placed', check: 'Check: boxes need a look', done: 'Done' };
  let menuOpen = $state(false);
  let menuFilter = $state('all');
  let dotBtn = $state(null);

  function begin() {
    if (!app.pages.length) return; // nothing to jump to on a blank document
    draft = String(app.pageIndex + 1);
    editing = true;
  }

  // Guarded on `editing` because leaving the DOM (already resolved by Enter or
  // Escape) blurs the input too - without the guard that would parse the
  // stale draft a second time.
  function commit() {
    if (!editing) return;
    editing = false;
    const n = Number(draft);
    if (Number.isInteger(n) && n >= 1 && n <= app.pages.length) gotoPage(n - 1);
  }

  function onKey(e) {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') editing = false; // abandon: draft is dropped, no jump
  }

  // Seeds the caret with everything selected, so typing a new page replaces
  // the old one instead of appending to it.
  function focusInput(node) {
    node.focus();
    node.select();
  }
</script>

<!-- `data-tip` on every control, matching the zoom dock beside it: these are two
     halves of one bottom dock and a tip on one but not the other reads as one of
     them being broken. The glyphs are ‹ › and a bare number - nothing on them
     says which page they move to, or that the number is a field at all. The
     stylesheet already flips these tips upwards for `.pager`, because the dock
     floats 16px off the window's floor and a tip below it falls off screen. -->
<div class="pager">
  <button onclick={prevPage} disabled={app.pageIndex === 0} aria-label="Previous page" data-tip="Previous page">‹</button>
  {#if showStatus}
    <!-- The tip is dropped while the menu is open: it would sit on top of it. -->
    <div class="pill-anchor">
      <button
        class="pdot"
        class:on={menuOpen}
        bind:this={dotBtn}
        onclick={() => (menuOpen = !menuOpen)}
        aria-label={`Pages - this page: ${STATUS_TIP[status]}`}
        aria-expanded={menuOpen}
        data-tip={menuOpen ? undefined : STATUS_TIP[status]}
      ><i class="pstat {status}"></i></button>
      {#if menuOpen}
        <PagesMenu anchor={dotBtn} bind:filter={menuFilter} onClose={() => (menuOpen = false)} />
      {/if}
    </div>
  {/if}
  {#if editing}
    <input class="pnum" type="text" bind:value={draft} onblur={commit} onkeydown={onKey} use:focusInput />
  {:else}
    <button class="pnum" onclick={begin} data-tip="Jump to page">{app.pages.length ? app.pageIndex + 1 : 0}</button>
  {/if}
  <span class="pof">/ {app.pages.length}</span>
  <button onclick={nextPage} disabled={app.pageIndex >= app.pages.length - 1} aria-label="Next page" data-tip="Next page">›</button>
</div>
