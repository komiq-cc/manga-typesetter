<script>
  // The chapter's pages as a list of numbers, each with its status dot (FLOW-2),
  // opened from the pager's dot. Numbers only, no thumbnails: the editor keeps
  // a window of pages in memory (see EditorRoot.svelte), and a strip of
  // thumbnails would decode every page in the chapter to draw itself.
  //
  // The statuses are `checks.pages`, the store's one pass over the shared check
  // list, so opening this costs a list of buttons and nothing more.
  import { app, checks, gotoPage, nextPageWithWork } from '../store.svelte.js';

  // `filter` is kept by the pager rather than here, so a filter picked once is
  // still picked the next time the menu opens.
  let { anchor = null, onClose, filter = $bindable('all') } = $props();

  let menuEl = $state(null);

  const FILTERS = [
    ['all', 'All'],
    ['todo', 'To do'],
    ['check', 'Check'],
    ['done', 'Done'],
  ];
  const LABEL = { todo: 'To do', check: 'Check', done: 'Done' };

  const counts = $derived.by(() => {
    const c = { all: checks.pages.length, todo: 0, check: 0, done: 0 };
    for (const s of checks.pages) c[s]++;
    return c;
  });
  const shown = $derived(
    checks.pages.map((status, i) => ({ i, status })).filter((p) => filter === 'all' || p.status === filter),
  );

  // Escape and choosing a page hand the keyboard back to the dot that opened
  // the menu, as the detect menu does; a pointer dismissal does not.
  function close({ restoreFocus = false } = {}) {
    if (restoreFocus) anchor?.focus();
    onClose?.();
  }

  // Capture and stopImmediatePropagation for the reason DetectMenu gives: the
  // editor's own Escape would otherwise deselect a box on the way past.
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.stopImmediatePropagation();
    close({ restoreFocus: true });
  }

  // The dot is spared, or its own pointerdown would close the menu a beat
  // before its click opened it again.
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

  // The keyboard arrives on the page the user is on, the one place in the list
  // they are sure to know.
  function focusCurrent(node) {
    (node.querySelector('.pm-page.cur') ?? node.querySelector('button'))?.focus();
  }

  function go(i) {
    close({ restoreFocus: true });
    gotoPage(i);
  }

  // Stays open: walking the chapter page by page is pressing this again, and
  // the list shows each page's dot change as the work on it is finished.
  const nextWork = () => nextPageWithWork();
</script>

<div class="pages-menu" role="dialog" aria-label="Pages" bind:this={menuEl} use:focusCurrent>
  <div class="pm-filters" role="group" aria-label="Show pages">
    {#each FILTERS as [id, label] (id)}
      <button class:on={filter === id} aria-pressed={filter === id} onclick={() => (filter = id)}>
        {label}<span class="pm-n">{counts[id]}</span>
      </button>
    {/each}
  </div>
  {#if shown.length}
    <div class="pm-grid">
      {#each shown as p (p.i)}
        <button
          class="pm-page"
          class:cur={p.i === app.pageIndex}
          aria-label={`Page ${p.i + 1}: ${LABEL[p.status]}`}
          aria-current={p.i === app.pageIndex ? 'page' : undefined}
          onclick={() => go(p.i)}
        >
          <i class="pstat {p.status}"></i>{p.i + 1}
        </button>
      {/each}
    </div>
  {:else}
    <div class="pm-empty">No pages</div>
  {/if}
  <div class="pm-foot">
    <button onclick={nextWork}>Next page with work</button>
  </div>
</div>
