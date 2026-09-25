<script>
  // The queue's "needs review" list (UX-6): every box in the chapter whose text
  // does not fit it, counted, and one click from each to the box. A bad fit was
  // only ever found by looking at every page; the flag is written by the
  // containment check (contain.js) and this only reads it.
  import { app, flaggedBoxes, gotoPage, selectBox, boxText, isLongstrip } from './store.svelte.js';
  import { revealInStrip } from './editor/strip-sync.svelte.js';
  import { reviewReason, reviewWhere, reviewTitle } from './review-label.js';
  import { plural } from './format.js';

  // Reactive through every box's `review`, which the store writes only when a
  // flag actually changes - so this re-reads on a verdict, not on a keystroke.
  const flagged = $derived(flaggedBoxes(app.pages));
  let open = $state(false);

  // Built only while the list is open: a chapter opening can flag dozens of
  // boxes, and the text of each is a line lookup.
  const rows = $derived.by(() => {
    if (!open) return [];
    const out = [];
    for (const f of flagged) {
      const i = app.pages.findIndex((pg) => pg.id === f.pageId);
      const pg = app.pages[i];
      const b = pg?.boxes.find((x) => x.id === f.boxId);
      if (!b) continue;
      out.push({
        key: `${f.pageId}:${f.boxId}`,
        pageIndex: i,
        boxId: f.boxId,
        text: String(boxText(b, pg) ?? '').replace(/\s+/g, ' ').trim(),
        reason: reviewReason(f.review),
        where: reviewWhere(f.review),
        title: reviewTitle(f.review),
      });
    }
    return out;
  });

  // To the box's page, then the box itself - selected, so the Inspector is on it.
  // In a strip the page is somewhere in the column rather than turned to, so the
  // canvas is asked to scroll the box into view as well.
  function jump(r) {
    if (r.pageIndex !== app.pageIndex) gotoPage(r.pageIndex);
    selectBox(r.boxId);
    if (isLongstrip()) revealInStrip(r.boxId);
  }
</script>

{#if flagged.length}
  <div class="rv">
    <button class="rv-head" aria-expanded={open} onclick={() => (open = !open)}>
      <span class="rv-mark" aria-hidden="true">!</span>
      <span class="rv-count">{plural(flagged.length, 'box', 'boxes')} {flagged.length === 1 ? 'needs' : 'need'} review</span>
      <svg class="rv-chev" class:open viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
    </button>
    {#if open}
      <div class="rv-list">
        {#each rows as r (r.key)}
          <button
            class="rv-row"
            class:here={r.pageIndex === app.pageIndex && r.boxId === app.selectedId}
            title={r.title}
            onclick={() => jump(r)}
          >
            <span class="rv-pg">p.{r.pageIndex + 1}</span>
            <span class="rv-col">
              <span class="rv-text">{r.text || 'Empty box'}</span>
              <span class="rv-why">{r.reason}{r.where ? ` · ${r.where}` : ''}</span>
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .rv {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 2px 0 4px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 2px;
  }
  .rv-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 9px;
    border-radius: 7px;
    border: 1px solid var(--line2);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }
  .rv-head:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .rv-mark {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--warn);
    color: var(--panel);
    font-size: 11px;
    font-weight: 800;
  }
  .rv-count {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rv-chev {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    opacity: 0.7;
    transition: transform 0.12s;
  }
  .rv-chev.open {
    transform: rotate(180deg);
  }
  .rv-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .rv-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 9px;
    border-radius: 7px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .rv-row:hover {
    background: var(--panel2);
  }
  .rv-row.here {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .rv-pg {
    flex: 0 0 auto;
    min-width: 30px;
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--panel2);
    font-size: 10.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .rv-col {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .rv-text {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rv-why {
    font-size: 10.5px;
    color: var(--warn);
  }
</style>
